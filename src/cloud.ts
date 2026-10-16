import dgram from "node:dgram";
import { resolve4 } from "node:dns/promises";
import net, { Socket, Server } from "node:net";
import { DeviceConfig } from "./config";
export function tea(block: Buffer, key: Buffer, decrypt = false): Buffer {
  let a = block.readUInt32LE(0),
    b = block.readUInt32LE(4),
    sum = decrypt ? 0xc6ef3720 : 0;
  const k = [0, 4, 8, 12].map((i) => key.readUInt32LE(i));
  for (let i = 0; i < 32; i++) {
    if (decrypt) {
      b = (b - (((a << 4) + k[2]) ^ (a + sum) ^ ((a >>> 5) + k[3]))) >>> 0;
      a = (a - (((b << 4) + k[0]) ^ (b + sum) ^ ((b >>> 5) + k[1]))) >>> 0;
      sum = (sum - 0x9e3779b9) >>> 0;
    } else {
      sum = (sum + 0x9e3779b9) >>> 0;
      a = (a + (((b << 4) + k[0]) ^ (b + sum) ^ ((b >>> 5) + k[1]))) >>> 0;
      b = (b + (((a << 4) + k[2]) ^ (a + sum) ^ ((a >>> 5) + k[3]))) >>> 0;
    }
  }
  const out = Buffer.alloc(8);
  out.writeUInt32LE(a);
  out.writeUInt32LE(b, 4);
  return out;
}
export function discoveryPacket(serial: string, now = Date.now()): Buffer {
  if (!/^[A-Za-z0-9]{1,64}$/.test(serial)) throw new Error("Invalid serial");
  const plain = Buffer.from(serial + "\0"),
    padded = Buffer.alloc(Math.ceil(plain.length / 8) * 8);
  plain.copy(padded);
  const h = Buffer.alloc(20);
  h.writeUInt16LE(0x2012);
  h.writeUInt16LE(0x44d, 2);
  h.writeUInt32LE(Math.floor(now / 1000), 4);
  h.writeUInt32LE((now % 1000) * 1000, 8);
  h.writeUInt16LE(plain.length, 16);
  h.writeUInt16LE(padded.length, 18);
  return Buffer.concat([
    h,
    ...Array.from({ length: padded.length / 8 }, (_, i) =>
      tea(padded.subarray(i * 8, i * 8 + 8), h.subarray(0, 16)),
    ),
  ]);
}
export interface Endpoint {
  host: string;
  port: number;
}
export function parseDiscovery(
  data: Buffer,
  serial: string,
): Endpoint | undefined {
  if (
    data.length < 20 ||
    data.readUInt16LE() !== 0x2012 ||
    data.readUInt16LE(2) !== 0x44e
  )
    return;
  const length = data.readUInt16LE(16),
    size = data.readUInt16LE(18);
  if (
    !size ||
    size % 8 ||
    size > 2048 ||
    data.length !== 20 + size ||
    length > size
  )
    return;
  const body = Buffer.concat(
    Array.from({ length: size / 8 }, (_, i) =>
      tea(data.subarray(20 + i * 8, 28 + i * 8), data.subarray(0, 16), true),
    ),
  );
  const f = body
    .subarray(0, length)
    .toString("ascii")
    .replace(/\0+$/, "")
    .split("|");
  if (f.length !== 4 || f[0] !== serial) return;
  if (f[1] !== "1")
    throw new Error(
      "Cloud transport unsupported: device has no CONNECT endpoint; relay/UDP is not implemented",
    );
  const port = Number(f[3]);
  if (
    net.isIP(f[2]) !== 4 ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    return;
  return { host: f[2], port };
}
export async function discover(
  serial: string,
  signal?: AbortSignal,
): Promise<Endpoint> {
  signal?.throwIfAborted();
  const ips = await resolve4("intelbrasp2p.com.br");
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket("udp4");
    let done = false;
    const finish = (err?: Error, value?: Endpoint) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      sock.close();
      err ? reject(err) : resolve(value!);
    };
    const abort = () => finish(new Error("Discovery cancelled"));
    const timer = setTimeout(
      () => finish(new Error("Cloud discovery timed out")),
      6000,
    );
    sock.on("error", () => finish(new Error("Cloud discovery socket failed")));
    sock.on("message", (data, from) => {
      if (!ips.includes(from.address) || from.port !== 1250) return;
      try {
        const e = parseDiscovery(data, serial);
        if (e) finish(undefined, e);
      } catch (e) {
        finish(e as Error);
      }
    });
    sock.bind(0, () => {
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) return abort();
      const p = discoveryPacket(serial);
      for (const ip of ips)
        sock.send(p, 1250, ip, (err) => {
          if (err) finish(new Error("Cloud discovery send failed"));
        });
    });
  });
}
export function connect(
  endpoint: Endpoint,
  signal?: AbortSignal,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ ...endpoint, signal });
    const timer = setTimeout(
      () => s.destroy(new Error("Connection timed out")),
      8000,
    );
    s.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Device connection failed"));
    });
    s.once("connect", () => {
      clearTimeout(timer);
      s.setKeepAlive(true, 15000);
      resolve(s);
    });
  });
}
export async function tunnel(
  endpoint: Endpoint,
  port: number,
  signal?: AbortSignal,
): Promise<Socket> {
  const s = await connect(endpoint, signal);
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => fail(), 8000);
    const fail = () => {
      clearTimeout(timer);
      s.destroy();
      reject(new Error("Cloud CONNECT handshake failed"));
    };
    const data = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end > 8192) {
        fail();
        return;
      }
      if (end < 0) {
        if (buf.length > 8192) fail();
        return;
      }
      clearTimeout(timer);
      s.off("data", data);
      s.off("error", fail);
      s.off("end", fail);
      if (
        !/^HTTP\/1\.[01] 200(?: |\r)/.test(buf.toString("ascii", 0, end + 2))
      ) {
        fail();
        return;
      }
      s.pause();
      if (buf.length > end + 4) s.unshift(buf.subarray(end + 4));
      resolve(s);
    };
    s.on("error", fail);
    s.once("end", fail);
    s.on("data", data);
    s.write(
      `CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nT2uClient: 121\r\nContent-Length: 0\r\n\r\n`,
    );
  });
}
export class Transport {
  private endpoint?: Endpoint;
  private expires = 0;
  private pending?: Promise<Endpoint>;
  private abort = new AbortController();
  private sockets = new Set<Socket>();
  private servers = new Map<number, Server>();
  private ports = new Map<number, Promise<number>>();
  constructor(readonly config: DeviceConfig) {}
  private async getEndpoint(refresh = false) {
    if (this.config.mode === "direct")
      return { host: this.config.host!, port: 0 };
    if (refresh) this.expires = 0;
    if (!this.endpoint || Date.now() > this.expires) {
      this.pending ??= discover(this.config.serial!, this.abort.signal)
        .then((e) => {
          this.endpoint = e;
          this.expires = Date.now() + 60000;
          return e;
        })
        .finally(() => (this.pending = undefined));
      await this.pending;
    }
    return this.endpoint!;
  }
  async open(port: number): Promise<Socket> {
    for (let attempt = 0; attempt < 2; attempt++)
      try {
        this.abort.signal.throwIfAborted();
        const ep = await this.getEndpoint(!!attempt);
        const s =
          this.config.mode === "cloud"
            ? await tunnel(ep, port, this.abort.signal)
            : await connect({ ...ep, port }, this.abort.signal);
        this.track(s);
        return s;
      } catch {
        if (attempt || this.abort.signal.aborted)
          throw new Error(
            "Device unavailable or Cloud CONNECT transport unsupported",
          );
      }
    throw new Error("Device unavailable");
  }
  private track(s: Socket) {
    this.sockets.add(s);
    s.once("close", () => this.sockets.delete(s));
  }
  localPort(remotePort: number): Promise<number> {
    if (this.abort.signal.aborted)
      return Promise.reject(new Error("Transport closed"));
    const existing = this.ports.get(remotePort);
    if (existing) return existing;
    const pending = new Promise<number>((resolve, reject) => {
      const server = net.createServer((client) => {
        this.track(client);
        client.pause();
        void this.open(remotePort)
          .then((peer) => {
            if (client.destroyed) {
              peer.destroy();
              return;
            }
            client.pipe(peer).pipe(client);
            peer.resume();
            client.resume();
            client.once("close", () => peer.destroy());
            peer.once("close", () => client.destroy());
            peer.on("error", () => client.destroy());
          })
          .catch(() => client.destroy());
        client.on("error", () => client.destroy());
      });
      this.servers.set(remotePort, server);
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        if (this.abort.signal.aborted) {
          server.close();
          reject(new Error("Transport closed"));
          return;
        }
        resolve((server.address() as net.AddressInfo).port);
      });
    }).catch((e) => {
      this.ports.delete(remotePort);
      throw e;
    });
    this.ports.set(remotePort, pending);
    return pending;
  }
  close() {
    this.abort.abort();
    for (const s of this.sockets) s.destroy();
    for (const s of this.servers.values()) s.close();
    this.servers.clear();
    this.ports.clear();
  }
}
