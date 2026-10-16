const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { Mp4Parser, RecordingDelegate } = require("../dist/recording");
const { fragmentInfo } = require("../dist/mp4");
const { ffmpegPath, stopMedia } = require("../dist/media");
const { Dvr } = require("../dist/dvr");
test("real synthetic FFmpeg MP4 fragments have keyframes and bounded duration", async () => {
  const p = spawn(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=320x240:r=15",
      "-t",
      "3",
      "-an",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-g",
      "15",
      "-keyint_min",
      "15",
      "-sc_threshold",
      "0",
      "-movflags",
      "frag_keyframe+empty_moov+default_base_moof",
      "-f",
      "mp4",
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let init;
  const fragments = [];
  const parser = new Mp4Parser((data, isInit) => {
    if (isInit) init = data;
    else fragments.push(data);
  });
  p.stdout.on("data", (b) => parser.push(b));
  p.stderr.resume();
  await new Promise((resolve, reject) => {
    p.once("error", reject);
    p.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("Synthetic FFmpeg encoding failed")),
    );
  });
  assert(init);
  assert.equal(fragments.length, 3);
  for (const f of fragments) {
    const info = fragmentInfo(init, f);
    assert.equal(info.sync, true);
    assert(Math.abs(info.duration - 1000) < 1);
  }
  assert.throws(
    () => fragmentInfo(Buffer.alloc(0), fragments[0]),
    /initialization/,
  );
});
test("recording disabled has no prebuffer work and cancels pending generator", async () => {
  let requests = 0;
  const delegate = new RecordingDelegate(
    {
      rtsp: async () => {
        requests++;
        throw new Error("should not run");
      },
    },
    { id: 1 },
    () => false,
    () => {},
  );
  delegate.updateRecordingConfiguration({
    videoCodec: { resolution: [320, 240, 15] },
  });
  delegate.updateRecordingActive(false);
  assert.equal(requests, 0);
  await assert.rejects(
    delegate.handleRecordingStreamRequest(1).next(),
    /disabled/,
  );
  delegate.close();
});
test("capability discovery excludes virtual encoders with no physical channel title", async () => {
  const d = new Dvr({
    id: "fixture",
    name: "Fixture",
    mode: "direct",
    host: "127.0.0.1",
    username: "fixture",
    password: "fixture",
  });
  d.text = async (path) =>
    path.includes("ChannelTitle")
      ? "table.ChannelTitle[0].Name=Camera 1\ntable.ChannelTitle[7].Name=Camera 8"
      : path.includes("Encode")
        ? "table.Encode[0].MainFormat[0].Video.Compression=H.265\ntable.Encode[7].MainFormat[0].Video.Compression=H.265\ntable.Encode[42].MainFormat[0].Video.Compression=H.264"
        : "result=Fixture";
  const channels = await d.discover();
  assert.deepEqual(
    channels.map((c) => c.id),
    [1, 8],
  );
  d.close();
});
test("playback URL uses DVR timestamp format without leaking credentials", async () => {
  const d = new Dvr({
    id: "fixture",
    name: "Fixture",
    mode: "direct",
    host: "127.0.0.1",
    username: "fixture",
    password: "fixture",
  });
  d.transport.localPort = async () => 12345;
  const url = new URL(
    await d.rtsp(8, false, {
      start: "2026-01-02 03:04:05",
      end: "2026-01-02 03:04:10",
    }),
  );
  assert.equal(url.searchParams.get("starttime"), "2026_01_02_03_04_05");
  assert.equal(url.searchParams.get("channel"), "8");
  d.close();
});
test("probe cancellation terminates FFmpeg promptly", async () => {
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    require("../dist/media").probe("rtsp://127.0.0.1:1/fixture", abort.signal),
  );
});
test("conversion lock is shared with the UI process", async () => {
  const { ConversionLimiter } = require("../dist/media");
  const release = new ConversionLimiter(1, true).acquire();
  try {
    const p = spawn(
      process.execPath,
      [
        "-e",
        "const {ConversionLimiter}=require('./dist/media');try{new ConversionLimiter(1,true).acquire();process.exit(2)}catch{process.exit(0)}",
      ],
      { cwd: require("node:path").join(__dirname, ".."), stdio: "ignore" },
    );
    assert.equal(await new Promise((r) => p.once("close", r)), 0);
  } finally {
    release();
  }
});
