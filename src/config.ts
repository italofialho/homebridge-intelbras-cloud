export interface ChannelConfig {
  id: number;
  name?: string;
  stream?: "primary" | "secondary";
  hksv?: boolean;
  transcode?: boolean;
}
export interface DeviceConfig {
  id: string;
  name: string;
  mode: "cloud" | "direct";
  serial?: string;
  host?: string;
  httpPort?: number;
  rtspPort?: number;
  username: string;
  password: string;
  timezone?: string;
  channels?: ChannelConfig[];
}
export interface StreamInfo {
  codec: string;
  width: number;
  height: number;
  fps: number;
  bitrate?: number;
}
export interface Channel {
  id: number;
  name: string;
  primary: StreamInfo;
  secondary: StreamInfo;
}
export function validateDevice(d: DeviceConfig) {
  if (!d.id || !d.name || !d.username || !d.password)
    throw new Error("Device id, name and credentials are required");
  if (d.mode === "cloud") {
    if (!/^[A-Za-z0-9]{1,64}$/.test(d.serial ?? ""))
      throw new Error("Invalid Cloud serial");
  } else if (d.mode !== "direct" || !d.host || /[\s/@?#]/.test(d.host))
    throw new Error("Invalid direct host");
  for (const p of [d.httpPort ?? 80, d.rtspPort ?? 554])
    if (!Number.isInteger(p) || p < 1 || p > 65535)
      throw new Error("Invalid port");
  const ids = new Set<number>();
  for (const c of d.channels ?? []) {
    if (!Number.isInteger(c.id) || c.id < 1 || c.id > 256 || ids.has(c.id))
      throw new Error("Invalid or duplicate channel");
    ids.add(c.id);
  }
  if (d.timezone) new Intl.DateTimeFormat("en", { timeZone: d.timezone });
}
