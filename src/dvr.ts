import http, { IncomingMessage } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { Transport } from "./cloud";
import { Channel, DeviceConfig, StreamInfo, validateDevice } from "./config";
const md5 = (s: string) => createHash("md5").update(s).digest("hex");
export function digest(
  challenge: string,
  method: string,
  path: string,
  user: string,
  pass: string,
): string {
  const fields: Record<string, string> = {};
  for (const m of challenge.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g))
    fields[m[1]] = m[2] ?? m[3];
  const { realm, nonce } = fields;
  if (
    !/^Digest /i.test(challenge) ||
    !realm ||
    !nonce ||
    (fields.algorithm && fields.algorithm.toUpperCase() !== "MD5")
  )
    throw new Error("Unsupported DVR HTTP authentication");
  if (
    fields.qop &&
    !fields.qop
      .split(",")
      .map((x) => x.trim())
      .includes("auth")
  )
    throw new Error("Unsupported DVR authentication qop");
  const cnonce = randomBytes(16).toString("hex"),
    nc = "00000001",
    a1 = md5(`${user}:${realm}:${pass}`),
    a2 = md5(`${method}:${path}`);
  const response = md5(
    fields.qop
      ? `${a1}:${nonce}:${nc}:${cnonce}:auth:${a2}`
      : `${a1}:${nonce}:${a2}`,
  );
  const quote = (s: string) =>
    '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  return (
    "Digest " +
    Object.entries({
      username: user,
      realm,
      nonce,
      uri: path,
      response,
      ...(fields.opaque ? { opaque: fields.opaque } : {}),
    })
      .map(([k, v]) => `${k}=${quote(v)}`)
      .join(", ") +
    (fields.qop ? `, qop=auth, nc=${nc}, cnonce="${cnonce}"` : "")
  );
}
export function parseTable(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}
export interface Recording {
  start: string;
  end: string;
  path: string;
  type: string;
}
export function parseRecordings(text: string): Recording[] {
  const items = new Map<number, Partial<Recording>>();
  for (const [k, v] of Object.entries(parseTable(text))) {
    const m = k.match(/items\[(\d+)\]\.(StartTime|EndTime|FilePath|Type)$/);
    if (!m) continue;
    const id = Number(m[1]),
      r = items.get(id) ?? {};
    const key = (
      {
        StartTime: "start",
        EndTime: "end",
        FilePath: "path",
        Type: "type",
      } as const
    )[m[2] as "StartTime"];
    r[key] = v;
    items.set(id, r);
  }
  return [...items.values()]
    .filter((r): r is Recording => !!r.start && !!r.end && !!r.path)
    .map((r) => ({ ...r, type: r.type ?? "unknown" }));
}
export class Dvr extends EventEmitter {
  readonly transport: Transport;
  channels: Channel[] = [];
  model = "Intelbras DVR";
  firmware = "unknown";
  private cache = new Map<
    number,
    { expires: number; promise: Promise<Buffer> }
  >();
  private eventAbort?: AbortController;
  private eventResponse?: IncomingMessage;
  private closed = false;
  constructor(readonly config: DeviceConfig) {
    super();
    validateDevice(config);
    this.transport = new Transport(config);
  }
  async response(path: string, signal?: AbortSignal): Promise<IncomingMessage> {
    if (this.closed) throw new Error("Device closed");
    const port = await this.transport.localPort(this.config.httpPort ?? 80);
    const request = (auth?: string) =>
      new Promise<IncomingMessage>((resolve, reject) => {
        const req = http.get(
          {
            hostname: "127.0.0.1",
            port,
            path,
            agent: false,
            signal,
            headers: auth ? { Authorization: auth } : {},
          },
          resolve,
        );
        req.setTimeout(15000, () => req.destroy(new Error("DVR HTTP timeout")));
        req.on("error", () => reject(new Error("DVR HTTP request failed")));
      });
    let res = await request();
    if (res.statusCode === 401) {
      const challenge = res.headers["www-authenticate"] ?? "";
      res.resume();
      res = await request(
        digest(
          challenge,
          "GET",
          path,
          this.config.username,
          this.config.password,
        ),
      );
    }
    if (res.statusCode !== 200) {
      res.resume();
      throw new Error(`DVR HTTP status ${res.statusCode ?? 0}`);
    }
    return res;
  }
  async bytes(
    path: string,
    max = 2_000_000,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const res = await this.response(path, signal);
    let size = 0;
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of res) {
        size += chunk.length;
        if (size > max) throw new Error("DVR response too large");
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } finally {
      res.destroy();
    }
  }
  async text(path: string, signal?: AbortSignal) {
    return (await this.bytes(path, 1_000_000, signal)).toString("utf8");
  }
  async discover(): Promise<Channel[]> {
    const names = parseTable(
      await this.text(
        "/cgi-bin/configManager.cgi?action=getConfig&name=ChannelTitle",
      ),
    );
    const encode = parseTable(
      await this.text(
        "/cgi-bin/configManager.cgi?action=getConfig&name=Encode",
      ),
    );
    const ids = [
      ...new Set(
        Object.keys(names).flatMap((k) => {
          const m = k.match(/^table\.ChannelTitle\[(\d+)\]\.Name$/);
          return m ? [Number(m[1]) + 1] : [];
        }),
      ),
    ].sort((a, b) => a - b);
    if (!ids.length) throw new Error("DVR did not expose channel capabilities");
    const info = (id: number, primary: boolean): StreamInfo => {
      const p = `table.Encode[${id - 1}].${primary ? "MainFormat" : "ExtraFormat"}[0].Video.`;
      return {
        codec: encode[p + "Compression"] ?? "unknown",
        width: Number(encode[p + "Width"] ?? 0),
        height: Number(encode[p + "Height"] ?? 0),
        fps: Number(encode[p + "FPS"] ?? 0),
        bitrate: Number(encode[p + "BitRate"] ?? 0),
      };
    };
    this.channels = ids.map((id) => ({
      id,
      name: names[`table.ChannelTitle[${id - 1}].Name`] ?? `Camera ${id}`,
      primary: info(id, true),
      secondary: info(id, false),
    }));
    try {
      this.model =
        (await this.text("/cgi-bin/magicBox.cgi?action=getDeviceType"))
          .trim()
          .split("=")[1] ?? this.model;
      this.firmware =
        (await this.text("/cgi-bin/magicBox.cgi?action=getSoftwareVersion"))
          .trim()
          .split("=")[1] ?? this.firmware;
    } catch {
      /* optional identity */
    }
    return this.channels;
  }
  snapshot(channel: number): Promise<Buffer> {
    const cached = this.cache.get(channel);
    if (cached && cached.expires > Date.now()) return cached.promise;
    const promise = this.bytes(`/cgi-bin/snapshot.cgi?channel=${channel}`)
      .then((b) => {
        if (b[0] !== 255 || b[1] !== 216)
          throw new Error("DVR snapshot is not JPEG");
        return b;
      })
      .catch((e) => {
        this.cache.delete(channel);
        throw e;
      });
    this.cache.set(channel, { expires: Date.now() + 3000, promise });
    return promise;
  }
  async rtsp(
    channel: number,
    primary = false,
    range?: { start: string; end: string },
  ): Promise<string> {
    const port = await this.transport.localPort(this.config.rtspPort ?? 554);
    const url = new URL(
      `rtsp://127.0.0.1:${port}/${range ? "cam/playback" : "cam/realmonitor"}`,
    );
    url.username = this.config.username;
    url.password = this.config.password;
    url.searchParams.set("channel", String(channel));
    if (range) {
      url.searchParams.set("starttime", range.start.replace(/[- :]/g, "_"));
      url.searchParams.set("endtime", range.end.replace(/[- :]/g, "_"));
    } else url.searchParams.set("subtype", primary ? "0" : "1");
    return url.toString();
  }
  startEvents() {
    if (this.eventAbort) return;
    this.eventAbort = new AbortController();
    void this.eventLoop(this.eventAbort.signal);
  }
  private async eventLoop(signal: AbortSignal) {
    while (!signal.aborted) {
      let res: IncomingMessage | undefined;
      try {
        res = await this.response(
          "/cgi-bin/eventManager.cgi?action=attach&codes=[VideoMotion]&heartbeat=5",
          signal,
        );
        this.eventResponse = res;
        let pending = "";
        for await (const chunk of res) {
          pending += chunk.toString();
          if (pending.length > 65536) throw new Error("Event frame too large");
          let end;
          while ((end = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, end);
            pending = pending.slice(end + 1);
            const m = line.match(
              /Code=VideoMotion;action=(Start|Stop);index=(\d+)/,
            );
            if (m)
              this.emit("motion", {
                channel: Number(m[2]) + 1,
                active: m[1] === "Start",
              });
          }
        }
      } catch {
        if (!signal.aborted)
          this.emit(
            "diagnostic",
            "Motion connection interrupted; reconnecting",
          );
      } finally {
        res?.destroy();
        this.eventResponse = undefined;
      }
      if (!signal.aborted)
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", finish);
            resolve();
          };
          const timer = setTimeout(finish, 3000);
          signal.addEventListener("abort", finish, { once: true });
        });
    }
  }
  async search(
    channel: number,
    start: string,
    end: string,
    offset = 0,
    count = 100,
  ): Promise<{ items: Recording[]; hasMore: boolean }> {
    if (
      !this.channels.some((c) => c.id === channel) ||
      !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(start) ||
      !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(end) ||
      start >= end
    )
      throw new Error("Invalid recording channel or DVR-local time range");
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > 10000 ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > 100
    )
      throw new Error("Invalid recording pagination");
    const created = await this.text(
      "/cgi-bin/mediaFileFind.cgi?action=factory.create",
    );
    const id = created.match(/result=(\d+)/)?.[1];
    if (!id) throw new Error("DVR recording search unsupported");
    const q = (action: string, extra: Record<string, string> = {}) =>
      "/cgi-bin/mediaFileFind.cgi?" +
      Object.entries({ action, object: id, ...extra })
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join("&");
    try {
      const found = await this.text(
        q("findFile", {
          "condition.Channel": String(channel),
          "condition.StartTime": start,
          "condition.EndTime": end,
          "condition.Types[0]": "dav",
        }),
      );
      if (!/OK|true/.test(found))
        throw new Error("DVR rejected recording search");
      let skipped = 0;
      while (skipped < offset) {
        const n = Math.min(100, offset - skipped);
        const items = parseRecordings(
          await this.text(q("findNextFile", { count: String(n) })),
        );
        skipped += items.length;
        if (items.length < n) return { items: [], hasMore: false };
      }
      const items = parseRecordings(
        await this.text(q("findNextFile", { count: String(count) })),
      );
      return { items, hasMore: items.length === count };
    } finally {
      await this.text(q("close")).catch(() =>
        this.emit("diagnostic", "DVR search close failed"),
      );
      await this.text(q("destroy")).catch(() =>
        this.emit("diagnostic", "DVR search destroy failed"),
      );
    }
  }
  close() {
    this.closed = true;
    this.eventAbort?.abort();
    this.eventResponse?.destroy();
    this.transport.close();
    this.cache.clear();
    this.removeAllListeners();
  }
}
