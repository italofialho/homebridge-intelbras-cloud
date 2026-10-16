import { EventEmitter } from "node:events";
import { ChildProcess } from "node:child_process";
import type {
  CameraRecordingDelegate,
  CameraRecordingConfiguration,
  RecordingPacket,
} from "homebridge";
import { Dvr } from "./dvr";
import { ChannelConfig } from "./config";
import { conversions, probe, runMedia, stopMedia } from "./media";
import { fragmentInfo } from "./mp4";
export class Mp4Parser {
  private pending = Buffer.alloc(0);
  private initialization: Buffer[] = [];
  private fragment: Buffer[] = [];
  constructor(private emit: (data: Buffer, init: boolean) => void) {}
  push(data: Buffer) {
    this.pending = Buffer.concat([this.pending, data]);
    if (this.pending.length > 32 * 1024 * 1024)
      throw new Error("MP4 buffer limit exceeded");
    while (this.pending.length >= 8) {
      const size = this.pending.readUInt32BE();
      if (size < 8 || size > 32 * 1024 * 1024)
        throw new Error("Invalid MP4 box");
      if (this.pending.length < size) return;
      const box = this.pending.subarray(0, size);
      this.pending = this.pending.subarray(size);
      const type = box.toString("ascii", 4, 8);
      if (type === "ftyp" || type === "moov") {
        this.initialization.push(box);
        if (type === "moov") {
          this.emit(Buffer.concat(this.initialization), true);
          this.initialization = [];
        }
      } else if (type === "moof") {
        this.fragment = [box];
      } else if (type === "mdat" && this.fragment.length) {
        this.fragment.push(box);
        this.emit(Buffer.concat(this.fragment), false);
        this.fragment = [];
      }
    }
  }
}
export class RecordingDelegate implements CameraRecordingDelegate {
  private active = false;
  private config?: CameraRecordingConfiguration;
  private process?: ChildProcess;
  private generation = 0;
  private abort?: AbortController;
  private init?: Buffer;
  private ring: { data: Buffer; at: number }[] = [];
  private events = new EventEmitter();
  private stream?: number;
  private stopped = false;
  private release?: () => void;
  private retry?: NodeJS.Timeout;
  private alive = true;
  private pendingConfig = false;
  constructor(
    private dvr: Dvr,
    private channel: ChannelConfig,
    private audioActive: () => boolean,
    private diagnostic: (s: string) => void,
  ) {}
  updateRecordingActive(active: boolean) {
    this.active = active;
    if (!active) {
      this.stop();
      this.closeRecordingStream(this.stream ?? -1);
    } else void this.restart();
  }
  updateRecordingConfiguration(c: CameraRecordingConfiguration | undefined) {
    this.config = c;
    if (this.stream !== undefined) {
      this.pendingConfig = true;
      return;
    }
    void this.restart();
  }
  audioChanged() {
    if (this.stream !== undefined) {
      this.closeRecordingStream(this.stream);
    }
    void this.restart();
  }
  private stop() {
    this.generation++;
    this.abort?.abort();
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    stopMedia(this.process);
    this.process = undefined;
    this.release = undefined;
    this.ring = [];
    this.init = undefined;
    this.events.emit("change");
  }
  private async restart() {
    this.stop();
    if (!this.alive || !this.active || !this.config) return;
    this.abort = new AbortController();
    const gen = this.generation,
      c = this.config;
    try {
      const url = await this.dvr.rtsp(
        this.channel.id,
        this.channel.stream === "primary",
      );
      const source = await probe(url, this.abort.signal);
      if (gen !== this.generation) return;
      const [w, h, fps] = c.videoCodec.resolution;
      const transcode = !!this.channel.transcode;
      const capability = this.dvr.channels.find(
        (x) => x.id === this.channel.id,
      )?.[this.channel.stream === "primary" ? "primary" : "secondary"];
      if (
        !transcode &&
        (!capability?.bitrate ||
          capability.bitrate > c.videoCodec.parameters.bitRate)
      )
        throw new Error("HKSV negotiated bitrate requires explicit conversion");
      if (
        !transcode &&
        (source.codec !== "h264" ||
          source.width !== w ||
          source.height !== h ||
          source.fps > fps)
      )
        throw new Error(
          `HKSV source ${source.width}x${source.height}@${source.fps} ${source.codec} cannot supply negotiated ${w}x${h}@${fps} without conversion; enable conversion for this channel or disable recording in Apple Home`,
        );
      const release = transcode ? conversions.acquire() : undefined;
      if (gen !== this.generation) {
        release?.();
        return;
      }
      this.release = release;
      const audio = this.audioActive();
      const duration = c.mediaContainerConfiguration.fragmentLength;
      const args = [
        "-rtsp_transport",
        "tcp",
        "-i",
        url,
        "-map",
        "0:v:0",
        ...(audio
          ? [
              "-map",
              "0:a:0?",
              "-c:a",
              "aac",
              "-ar",
              String(
                [8000, 16000, 24000, 32000, 44100, 48000][
                  c.audioCodec.samplerate
                ],
              ),
              "-ac",
              String(c.audioCodec.audioChannels ?? 1),
              "-b:a",
              `${c.audioCodec.bitrate}k`,
            ]
          : ["-an"]),
        "-c:v",
        transcode ? "libx264" : "copy",
      ];
      if (transcode)
        args.push(
          "-preset",
          "ultrafast",
          "-tune",
          "zerolatency",
          "-pix_fmt",
          "yuv420p",
          "-profile:v",
          ["baseline", "main", "high"][c.videoCodec.parameters.profile],
          "-level:v",
          ["3.1", "3.2", "4.0"][c.videoCodec.parameters.level],
          "-vf",
          `scale=${w}:${h}`,
          "-r",
          String(fps),
          "-b:v",
          `${c.videoCodec.parameters.bitRate}k`,
          "-maxrate",
          `${c.videoCodec.parameters.bitRate}k`,
          "-bufsize",
          `${c.videoCodec.parameters.bitRate * 2}k`,
          "-g",
          String(
            Math.max(
              1,
              Math.floor(
                (fps *
                  Math.min(duration, c.videoCodec.parameters.iFrameInterval)) /
                  1000,
              ),
            ),
          ),
          "-keyint_min",
          "1",
          "-sc_threshold",
          "0",
        );
      args.push(
        "-movflags",
        "frag_keyframe+empty_moov+default_base_moof",
        "-f",
        "mp4",
        "pipe:1",
      );

      const parser = new Mp4Parser((data, init) => {
        if (gen !== this.generation) return;
        if (init) {
          if (!transcode) {
            const avcc = data.indexOf(Buffer.from("avcC"));
            if (avcc < 0 || avcc + 8 > data.length)
              throw new Error("Missing H.264 configuration");
            const profile = [66, 77, 100][c.videoCodec.parameters.profile],
              level = [31, 32, 40][c.videoCodec.parameters.level];
            if (data[avcc + 5] !== profile || data[avcc + 7] > level)
              throw new Error(
                "HKSV negotiated profile/level requires explicit conversion",
              );
          }
          this.init = data;
        } else {
          const now = Date.now();
          const info = fragmentInfo(this.init!, data);
          if (!info.sync || info.duration > duration + 1) {
            this.diagnostic(
              "HKSV source GOP exceeds negotiated fragment duration; enable conversion",
            );
            this.stop();
            return;
          }

          this.ring.push({ data, at: now });
          while (
            this.ring.length > 1 &&
            (now - this.ring[0].at >
              Math.max(c.prebufferLength, 4000) + duration ||
              this.ring.reduce((n, x) => n + x.data.length, 0) >
                32 * 1024 * 1024)
          )
            this.ring.shift();
        }
        this.events.emit("change");
      });
      const p = runMedia(args, () => {
        release?.();
        if (gen === this.generation && this.alive && this.active) {
          this.process = undefined;
          if (this.stream !== undefined) this.closeRecordingStream(this.stream);
          this.events.emit("change");
          this.retry = setTimeout(() => void this.restart(), 5000);
        }
      });
      this.process = p;
      p.stdout!.on("data", (b) => {
        try {
          parser.push(b);
        } catch (e) {
          this.diagnostic(
            e instanceof Error ? e.message : "Invalid HKSV MP4 stream",
          );
          this.stop();
        }
      });
      p.once("error", () => this.diagnostic("Unable to start HKSV FFmpeg"));
    } catch (e) {
      if (gen === this.generation) {
        const message = e instanceof Error ? e.message : "HKSV unavailable";
        this.diagnostic(message);
        if (
          this.alive &&
          this.active &&
          /limit|probe|unavailable/i.test(message)
        )
          this.retry = setTimeout(() => void this.restart(), 5000);
      }
    }
  }
  async *handleRecordingStreamRequest(
    id: number,
    signal?: AbortSignal,
  ): AsyncGenerator<RecordingPacket> {
    if (!this.active || !this.config) throw new Error("Recording is disabled");
    if (this.stream !== undefined)
      throw new Error("Recording stream already open");
    this.stream = id;
    this.stopped = false;
    let queue: Buffer[] = [];
    const receive = () => {
      const last = this.ring.at(-1);
      if (last) queue.push(last.data);
      if (
        queue.length > 64 ||
        queue.reduce((n, b) => n + b.length, 0) > 32 * 1024 * 1024
      ) {
        this.stopped = true;
        this.events.emit("wake");
      } else this.events.emit("wake");
    };
    const abort = () => {
      this.stopped = true;
      this.events.emit("wake");
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const until = Date.now() + 20000;
      while (!this.init && !this.stopped && !signal?.aborted) {
        if (Date.now() > until) throw new Error("HKSV prebuffer unavailable");
        await this.wait();
      }
      if (this.stopped || signal?.aborted) return;
      const initial = this.init!;
      queue = this.ring.map((x) => x.data);
      this.events.on("change", receive);
      yield { data: initial, isLast: false };
      const deadline = Date.now() + 180000;
      while (!this.stopped && !signal?.aborted) {
        if (!queue.length) {
          await this.wait();
          if (!this.process) throw new Error("HKSV source ended");
          continue;
        }
        const data = queue.shift()!;
        const isLast = Date.now() > deadline;
        yield { data, isLast };
        if (isLast) return;
      }
    } finally {
      this.events.off("change", receive);
      signal?.removeEventListener("abort", abort);
      this.stream = undefined;
      if (this.pendingConfig) {
        this.pendingConfig = false;
        void this.restart();
      }
    }
  }
  private wait() {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.events.off("wake", done);
        this.events.off("change", done);
        resolve();
      };
      const t = setTimeout(done, 1000);
      this.events.once("wake", done);
      this.events.once("change", done);
    });
  }
  closeRecordingStream(id: number) {
    if (this.stream === id) {
      this.stopped = true;
      this.events.emit("wake");
    }
  }
  acknowledgeStream(id: number) {
    this.closeRecordingStream(id);
  }
  close() {
    this.alive = false;
    this.active = false;
    this.stopped = true;
    this.stop();
    this.events.emit("wake");
  }
}
