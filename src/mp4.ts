interface Box {
  type: string;
  data: Buffer;
}
function boxes(data: Buffer): Box[] {
  const out: Box[] = [];
  for (let at = 0; at + 8 <= data.length;) {
    const size = data.readUInt32BE(at);
    if (size < 8 || at + size > data.length)
      throw new Error("Malformed MP4 box tree");
    out.push({
      type: data.toString("ascii", at + 4, at + 8),
      data: data.subarray(at, at + size),
    });
    at += size;
  }
  return out;
}
function child(box: Box, type: string) {
  return boxes(box.data.subarray(8)).find((x) => x.type === type);
}
export function fragmentInfo(
  initialization: Buffer,
  fragment: Buffer,
): { duration: number; sync: boolean } {
  const moov = boxes(initialization).find((x) => x.type === "moov");
  if (!moov) throw new Error("Missing MP4 initialization");
  const track = boxes(moov.data.subarray(8))
    .filter((x) => x.type === "trak")
    .find((t) => {
      const mdia = child(t, "mdia");
      const handler = mdia && child(mdia, "hdlr");
      return handler?.data.toString("ascii", 16, 20) === "vide";
    });
  const mdia = track && child(track, "mdia"),
    tkhd = track && child(track, "tkhd"),
    mdhd = mdia && child(mdia, "mdhd");
  if (!tkhd || !mdhd) throw new Error("Missing MP4 video track");
  const id = tkhd.data.readUInt32BE(tkhd.data[8] === 1 ? 28 : 20),
    timescale = mdhd.data.readUInt32BE(mdhd.data[8] === 1 ? 28 : 20);
  if (!timescale) throw new Error("Invalid MP4 timescale");
  const mvex = child(moov, "mvex");
  const trex =
    mvex &&
    boxes(mvex.data.subarray(8)).find(
      (x) => x.type === "trex" && x.data.readUInt32BE(12) === id,
    );
  let defaultDuration = trex?.data.readUInt32BE(20) ?? 0,
    defaultFlags = trex?.data.readUInt32BE(28) ?? 0;
  const moof = boxes(fragment).find((x) => x.type === "moof");
  if (!moof) throw new Error("Missing MP4 fragment");
  const traf = boxes(moof.data.subarray(8))
    .filter((x) => x.type === "traf")
    .find((x) => child(x, "tfhd")?.data.readUInt32BE(12) === id);
  if (!traf) throw new Error("Missing MP4 video fragment");
  const tfhd = child(traf, "tfhd")!.data,
    flags = tfhd.readUIntBE(9, 3);
  let at = 16;
  if (flags & 1) at += 8;
  if (flags & 2) at += 4;
  if (flags & 8) {
    defaultDuration = tfhd.readUInt32BE(at);
    at += 4;
  }
  if (flags & 16) at += 4;
  if (flags & 32) defaultFlags = tfhd.readUInt32BE(at);
  let duration = 0,
    sync = true,
    first = true;
  for (const b of boxes(traf.data.subarray(8)).filter(
    (x) => x.type === "trun",
  )) {
    const d = b.data,
      f = d.readUIntBE(9, 3),
      count = d.readUInt32BE(12);
    let pos = 16;
    if (count > 100000) throw new Error("MP4 sample count too large");
    if (f & 1) pos += 4;
    let firstFlags: number | undefined;
    if (f & 4) {
      firstFlags = d.readUInt32BE(pos);
      pos += 4;
    }
    for (let i = 0; i < count; i++) {
      let sampleDuration = defaultDuration,
        sampleFlags =
          i === 0 && firstFlags !== undefined ? firstFlags : defaultFlags;
      if (f & 0x100) {
        sampleDuration = d.readUInt32BE(pos);
        pos += 4;
      }
      if (f & 0x200) pos += 4;
      if (f & 0x400) {
        sampleFlags = d.readUInt32BE(pos);
        pos += 4;
      }
      if (f & 0x800) pos += 4;
      if (pos > d.length || !sampleDuration)
        throw new Error("Invalid MP4 sample timing");
      duration += sampleDuration;
      if (first) {
        sync = !(sampleFlags & 0x10000);
        first = false;
      }
    }
  }
  if (!duration) throw new Error("Empty MP4 video fragment");
  return { duration: (duration / timescale) * 1000, sync };
}
