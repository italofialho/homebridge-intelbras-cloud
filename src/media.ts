import { spawn, ChildProcess } from "node:child_process";
import { lockSync } from "proper-lockfile";
import { tmpdir } from "node:os";
import { join } from "node:path";
export const ffmpegPath: string =
  process.env.INTELBRAS_FFMPEG_PATH ||
  require("ffmpeg-for-homebridge") ||
  "ffmpeg";
export class ConversionLimiter {
  private active = 0;
  constructor(
    readonly max = 1,
    private crossProcess = false,
  ) {}
  acquire() {
    if (this.active >= this.max)
      throw new Error(
        "Conversion limit reached; try again after the active session ends",
      );
    let unlock: (() => void) | undefined;
    if (this.crossProcess)
      try {
        unlock = lockSync(
          join(
            tmpdir(),
            `homebridge-intelbras-conversion-${process.getuid?.() ?? "default"}`,
          ),
          { realpath: false, stale: 10000, update: 2000 },
        );
      } catch {
        throw new Error(
          "Conversion limit reached; another plugin or UI session is converting",
        );
      }
    this.active++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.active--;
        unlock?.();
      }
    };
  }
}
export const conversions = new ConversionLimiter(1, true);
export function runMedia(args: string[], onClose?: () => void): ChildProcess {
  const p = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.stderr?.resume();
  p.once("error", () => {});
  p.once("close", () => onClose?.());
  return p;
}
export function stopMedia(p?: ChildProcess) {
  if (!p || p.exitCode !== null || p.signalCode !== null) return;
  p.kill("SIGTERM");
  const t = setTimeout(() => p.kill("SIGKILL"), 2000);
  t.unref();
  p.once("close", () => clearTimeout(t));
}
export async function probe(
  url: string,
  signal?: AbortSignal,
): Promise<{ codec: string; width: number; height: number; fps: number }> {
  signal?.throwIfAborted();
  // FFmpeg's input diagnostics are available even when ffprobe is not bundled.
  return new Promise((resolve, reject) => {
    const p = spawn(
      ffmpegPath,
      [
        "-hide_banner",
        "-rtsp_transport",
        "tcp",
        "-i",
        url,
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-f",
        "null",
        "-",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const abort = () => {
      stopMedia(p);
      reject(new Error("Media probe cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let info = "";
    const timer = setTimeout(() => {
      stopMedia(p);
      reject(new Error("Media probe timed out"));
    }, 15000);
    p.stderr.on("data", (b) => {
      if (info.length < 64000) info += b.toString();
    });
    p.once("error", () => {
      clearTimeout(timer);
      reject(new Error("FFmpeg is unavailable"));
    });
    p.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const m = info.match(
        /Video: ([\w]+)[^\n]*? (\d{2,5})x(\d{2,5})[^\n]*?(?:, ([\d.]+) fps)?/,
      );
      if (code !== 0 || !m) reject(new Error("Unable to detect video codec"));
      else
        resolve({
          codec: m[1],
          width: Number(m[2]),
          height: Number(m[3]),
          fps: Number(info.match(/([\d.]+) fps/)?.[1] ?? 0),
        });
    });
  });
}
