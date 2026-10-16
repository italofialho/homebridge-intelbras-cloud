// Session negotiation and SRTP argument structure adapted from Homebridge Camera FFmpeg.
// Apache-2.0; see NOTICE and vendor source provenance in docs/UPSTREAM.md.
import type {
  API,
  CameraStreamingDelegate,
  PrepareStreamRequest,
  PrepareStreamCallback,
  SnapshotRequest,
  SnapshotRequestCallback,
  StreamingRequest,
  StreamRequestCallback,
  CameraController,
  PlatformAccessory,
} from "homebridge";
import { createSocket, Socket } from "node:dgram";
import { ChildProcess } from "node:child_process";
import { Dvr } from "./dvr";
import { ChannelConfig } from "./config";
import { conversions, probe, runMedia, stopMedia } from "./media";
import { RecordingDelegate } from "./recording";
interface Session {
  socket: Socket;
  address: string;
  port: number;
  key: Buffer;
  ssrc: number;
  process?: ChildProcess;
  timer?: NodeJS.Timeout;
  release?: () => void;
  cancelled: boolean;
  abort: AbortController;
}
export class Camera implements CameraStreamingDelegate {
  readonly controller: CameraController;
  readonly recording?: RecordingDelegate;
  private sessions = new Map<string, Session>();
  constructor(
    private api: API,
    private dvr: Dvr,
    private channel: ChannelConfig,
    accessory: PlatformAccessory,
    diagnostic: (s: string) => void,
  ) {
    const h = api.hap;
    const resolutions: [number, number, number][] = [
      [320, 240, 15],
      [640, 360, 30],
      [640, 480, 30],
      [1280, 720, 30],
      [1920, 1080, 30],
    ];
    const detected = dvr.channels.find((c) => c.id === channel.id)?.[
      channel.stream === "primary" ? "primary" : "secondary"
    ];
    if (detected?.width && detected.height)
      resolutions.push([detected.width, detected.height, detected.fps || 25]);
    const codec = {
      profiles: [
        h.H264Profile.BASELINE,
        h.H264Profile.MAIN,
        h.H264Profile.HIGH,
      ],
      levels: [
        h.H264Level.LEVEL3_1,
        h.H264Level.LEVEL3_2,
        h.H264Level.LEVEL4_0,
      ],
    };
    const motion = accessory.addService(
      h.Service.MotionSensor,
      channel.name ?? `Camera ${channel.id}`,
    );
    let audio = () => false;
    if (channel.hksv)
      this.recording = new RecordingDelegate(
        dvr,
        channel,
        () => audio(),
        diagnostic,
      );
    this.controller = new h.CameraController({
      cameraStreamCount: 2,
      delegate: this,
      streamingOptions: {
        supportedCryptoSuites: [h.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: { resolutions, codec },
      },
      ...(this.recording
        ? {
            recording: {
              delegate: this.recording,
              options: {
                prebufferLength: 4000,
                overrideEventTriggerOptions: [h.EventTriggerOption.MOTION],
                mediaContainerConfiguration: [
                  {
                    type: h.MediaContainerType.FRAGMENTED_MP4,
                    fragmentLength: 4000,
                  },
                ],
                video: {
                  type: h.VideoCodecType.H264,
                  parameters: codec,
                  resolutions,
                },
                audio: {
                  codecs: [
                    {
                      type: h.AudioRecordingCodecType.AAC_LC,
                      samplerate: [
                        h.AudioRecordingSamplerate.KHZ_16,
                        h.AudioRecordingSamplerate.KHZ_32,
                      ],
                      audioChannels: 1,
                      bitrateMode: 0,
                    },
                  ],
                },
              },
            },
            sensors: { motion },
          }
        : {}),
    });
    audio = () =>
      !!this.controller.recordingManagement?.recordingManagementService.getCharacteristic(
        h.Characteristic.RecordingAudioActive,
      ).value;
    this.controller.recordingManagement?.recordingManagementService
      .getCharacteristic(h.Characteristic.RecordingAudioActive)
      .on("change", () => this.recording?.audioChanged());
    dvr.on("motion", ({ channel: channelId, active }) => {
      if (channelId === channel.id)
        motion.updateCharacteristic(h.Characteristic.MotionDetected, active);
    });
    accessory.configureController(this.controller);
  }
  handleSnapshotRequest(
    _request: SnapshotRequest,
    callback: SnapshotRequestCallback,
  ) {
    void this.dvr.snapshot(this.channel.id).then(
      (b) => callback(undefined, b),
      () => callback(new Error("DVR snapshot unavailable")),
    );
  }
  prepareStream(
    request: PrepareStreamRequest,
    callback: PrepareStreamCallback,
  ) {
    const socket = createSocket(
      request.addressVersion === "ipv6" ? "udp6" : "udp4",
    );
    let answered = false;
    socket.on("error", () => {
      this.stop(request.sessionID);
      if (!answered) {
        answered = true;
        callback(new Error("SRTP socket unavailable"));
      }
    });
    socket.bind(0, () => {
      if (answered) return;
      answered = true;
      const ssrc =
        this.api.hap.CameraController.generateSynchronisationSource();
      const session: Session = {
        socket,
        address: request.targetAddress,
        port: request.video.port,
        key: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
        ssrc,
        cancelled: false,
        abort: new AbortController(),
      };
      this.sessions.set(request.sessionID, session);
      session.timer = setTimeout(() => this.stop(request.sessionID), 30000);
      callback(undefined, {
        video: {
          port: socket.address().port,
          ssrc,
          srtp_key: request.video.srtp_key,
          srtp_salt: request.video.srtp_salt,
        },
      });
    });
  }
  handleStreamRequest(
    request: StreamingRequest,
    callback: StreamRequestCallback,
  ) {
    if (request.type === "stop") {
      this.stop(request.sessionID);
      callback();
      return;
    }
    if (request.type === "reconfigure") {
      callback();
      return;
    }
    void this.start(request, callback);
  }
  private async start(
    request: Extract<StreamingRequest, { type: "start" }>,
    callback: StreamRequestCallback,
  ) {
    const s = this.sessions.get(request.sessionID);
    if (!s) {
      callback(new Error("Unknown camera session"));
      return;
    }
    let answered = false;
    const answer = (err?: Error) => {
      if (!answered) {
        answered = true;
        callback(err);
      }
    };
    try {
      const url = await this.dvr.rtsp(
          this.channel.id,
          this.channel.stream === "primary",
        ),
        info = await probe(url, s.abort.signal);
      if (s.cancelled) {
        answer(new Error("Session cancelled"));
        return;
      }
      if (info.codec !== "h264" && !this.channel.transcode)
        throw new Error(
          "Source codec is incompatible with HomeKit; explicitly enable conversion",
        );
      if (this.channel.transcode) s.release = conversions.acquire();
      const address = s.address.includes(":") ? `[${s.address}]` : s.address;
      const args = [
        "-rtsp_transport",
        "tcp",
        "-i",
        url,
        "-map",
        "0:v:0",
        "-an",
        "-sn",
        "-dn",
        "-c:v",
        this.channel.transcode ? "libx264" : "copy",
      ];
      if (this.channel.transcode)
        args.push(
          "-preset",
          "ultrafast",
          "-tune",
          "zerolatency",
          "-pix_fmt",
          "yuv420p",
          "-vf",
          `scale=${request.video.width}:${request.video.height}`,
          "-r",
          String(request.video.fps),
          "-b:v",
          `${request.video.max_bit_rate}k`,
        );
      args.push(
        "-payload_type",
        String(request.video.pt),
        "-ssrc",
        String(s.ssrc),
        "-f",
        "rtp",
        "-srtp_out_suite",
        "AES_CM_128_HMAC_SHA1_80",
        "-srtp_out_params",
        s.key.toString("base64"),
        `srtp://${address}:${s.port}?rtcpport=${s.port}&pkt_size=${request.video.mtu}`,
        "-progress",
        "pipe:1",
      );
      const release = s.release;
      const p = runMedia(args, () => {
        release?.();
        answer(new Error("Video process ended"));
        this.stop(request.sessionID);
        this.controller.forceStopStreamingSession(request.sessionID);
      });
      s.process = p;
      p.once("error", () => answer(new Error("Unable to start FFmpeg")));
      p.stdout!.once("data", () => answer());
      const arm = () => {
        clearTimeout(s.timer);
        s.timer = setTimeout(
          () => {
            answer(new Error("Video session timed out"));
            this.stop(request.sessionID);
            this.controller.forceStopStreamingSession(request.sessionID);
          },
          Math.max(30000, request.video.rtcp_interval * 5000),
        );
      };
      s.socket.on("message", arm);
      arm();
    } catch (e) {
      this.stop(request.sessionID);
      answer(new Error(e instanceof Error ? e.message : "Video unavailable"));
    }
  }
  stop(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.cancelled = true;
    s.abort.abort();
    clearTimeout(s.timer);
    try {
      s.socket.close();
    } catch {
      /* already closed */
    }
    stopMedia(s.process);
    if (!s.process) s.release?.();
    this.sessions.delete(id);
  }
  close() {
    for (const id of this.sessions.keys()) this.stop(id);
    this.recording?.close();
  }
}
