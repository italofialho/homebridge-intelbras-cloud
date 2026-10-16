import { HomebridgePluginUiServer } from "@homebridge/plugin-ui-utils";
import { ChildProcess } from "node:child_process";
import { Dvr } from "./dvr";
import { DeviceConfig } from "./config";
import { conversions, probe, runMedia, stopMedia } from "./media";
class Ui extends HomebridgePluginUiServer {
  private jobs = new Map<string, ChildProcess>();
  private devices = new Set<Dvr>();
  private probes = new Map<string, AbortController>();
  constructor() {
    super();
    process.once("SIGTERM", () => {
      for (const a of this.probes.values()) a.abort();
      for (const p of this.jobs.values()) stopMedia(p);
      for (const d of this.devices) d.close();
      setTimeout(() => process.exit(0), 2200).unref();
    });
    this.onRequest("/diagnose", async (body: { device: DeviceConfig }) =>
      this.withDevice(body.device, async (d) => ({
        model: d.model,
        firmware: d.firmware,
        channels: d.channels,
        timeBasis: "DVR local time; no UTC conversion",
        timezone: d.config.timezone ?? "not configured",
      })),
    );
    this.onRequest(
      "/snapshot",
      async (body: { device: DeviceConfig; channel: number }) =>
        this.withDevice(body.device, async (d) => ({
          jpeg: (await d.snapshot(this.channel(d, body.channel))).toString(
            "base64",
          ),
        })),
    );
    this.onRequest(
      "/search",
      async (body: {
        device: DeviceConfig;
        channel: number;
        start: string;
        end: string;
        offset?: number;
      }) =>
        this.withDevice(body.device, (d) =>
          d.search(
            this.channel(d, body.channel),
            body.start,
            body.end,
            body.offset ?? 0,
            100,
          ),
        ),
    );
    this.onRequest("/cancel", async (body: { job: string }) => {
      this.probes.get(body.job)?.abort();
      stopMedia(this.jobs.get(body.job));
      return { cancelled: true };
    });
    this.onRequest(
      "/media",
      async (body: {
        device: DeviceConfig;
        channel: number;
        start: string;
        end: string;
        convert?: boolean;
        job: string;
      }) =>
        this.withDevice(body.device, async (d) => {
          if (
            !/^[\w-]{1,64}$/.test(body.job) ||
            this.jobs.has(body.job) ||
            this.probes.has(body.job)
          )
            throw new Error("Invalid or active media job");
          const pattern = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/;
          if (!pattern.test(body.start) || !pattern.test(body.end))
            throw new Error("Invalid DVR-local time");
          const duration =
            (Date.parse(body.end.replace(" ", "T") + "Z") -
              Date.parse(body.start.replace(" ", "T") + "Z")) /
            1000;
          if (!Number.isFinite(duration) || duration <= 0 || duration > 300)
            throw new Error("Select a clip between 1 second and 5 minutes");
          const url = await d.rtsp(this.channel(d, body.channel), false, {
            start: body.start,
            end: body.end,
          });
          const abort = new AbortController();
          this.probes.set(body.job, abort);
          let info;
          try {
            info = await probe(url, abort.signal);
          } finally {
            this.probes.delete(body.job);
          }
          abort.signal.throwIfAborted();
          if (info.codec !== "h264" && !body.convert)
            throw new Error(
              "Browser playback needs H.264; explicitly enable conversion",
            );
          const release = body.convert ? conversions.acquire() : undefined;
          return new Promise<{ mp4: string; mime: string }>(
            (resolve, reject) => {
              let chunks: Buffer[] = [];
              let size = 0;
              let settled = false;
              let timedOut = false;
              const p = runMedia([
                "-rtsp_transport",
                "tcp",
                ...(body.convert ? ["-threads", "2"] : []),
                "-i",
                url,
                "-t",
                String(duration),
                "-map",
                "0:v:0",
                "-an",
                "-c:v",
                body.convert ? "libx264" : "copy",
                ...(body.convert
                  ? [
                      "-preset",
                      "ultrafast",
                      "-pix_fmt",
                      "yuv420p",
                      "-threads",
                      "2",
                      "-g",
                      "30",
                      "-keyint_min",
                      "30",
                      "-sc_threshold",
                      "0",
                    ]
                  : []),
                "-movflags",
                "frag_keyframe+empty_moov+default_base_moof",
                "-f",
                "mp4",
                "pipe:1",
              ]);
              this.jobs.set(body.job, p);
              const timer = setTimeout(
                () => {
                  timedOut = true;
                  stopMedia(p);
                },
                Math.min(360000, duration * 1000 + 30000),
              );
              const fail = (message: string) => {
                if (!settled) {
                  settled = true;
                  reject(new Error(message));
                }
                stopMedia(p);
              };
              p.stdout!.on("data", (b) => {
                size += b.length;
                if (size > 32 * 1024 * 1024)
                  fail("Clip exceeds 32 MiB; select a shorter interval");
                else chunks.push(b);
              });
              p.once("error", () => fail("Unable to start media process"));
              p.once("close", (code) => {
                clearTimeout(timer);
                release?.();
                this.jobs.delete(body.job);
                if (settled) return;
                settled = true;
                if (code !== 0 || !size || timedOut)
                  reject(new Error("Playback failed, timed out or cancelled"));
                else
                  resolve({
                    mp4: Buffer.concat(chunks).toString("base64"),
                    mime: "video/mp4",
                  });
                chunks = [];
              });
            },
          );
        }),
    );
    this.ready();
  }
  private channel(d: Dvr, id: number) {
    if (!d.channels.some((c) => c.id === id))
      throw new Error("Unknown channel");
    return id;
  }
  private async withDevice<T>(
    config: DeviceConfig,
    fn: (d: Dvr) => Promise<T>,
  ): Promise<T> {
    let d: Dvr | undefined;
    try {
      d = new Dvr(config);
      this.devices.add(d);
      await d.discover();
      return await fn(d);
    } catch (e) {
      throw new Error(
        e instanceof Error
          ? e.message.replace(/(?:rtsp|https?):\/\/\S+/g, "[redacted]")
          : "Device request failed",
      );
    } finally {
      if (d) this.devices.delete(d);
      d?.close();
    }
  }
}
new Ui();
