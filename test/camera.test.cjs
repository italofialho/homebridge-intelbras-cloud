const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Camera } = require("../dist/camera");
const media = require("../dist/media");
function fixture() {
  const camera = Object.create(Camera.prototype);
  const socket = new EventEmitter();
  socket.close = () => {};
  const session = {
    socket,
    address: "127.0.0.1",
    port: 12345,
    key: Buffer.alloc(30),
    ssrc: 1,
    cancelled: false,
    abort: new AbortController(),
  };
  camera.sessions = new Map([["fixture", session]]);
  camera.channel = { id: 4 };
  camera.dvr = {
    channels: [{ id: 4, secondary: { codec: "H.264" } }],
    rtsp: async () => "rtsp://127.0.0.1/fixture",
  };
  camera.controller = { forceStopStreamingSession: () => {} };
  return {
    camera,
    session,
    request: {
      type: "start",
      sessionID: "fixture",
      video: { pt: 99, mtu: 1316, rtcp_interval: 1 },
    },
  };
}
test("live startup acknowledges FFmpeg spawn without waiting for progress or probing again", async (t) => {
  const { camera, request } = fixture();
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.resume = () => {};
  t.mock.method(media, "probe", async () => {
    throw Error("Unexpected duplicate probe");
  });
  t.mock.method(media, "runMedia", () => child);
  t.mock.method(media, "stopMedia", () => {});
  const replies = [];
  await camera.start(request, (e) => replies.push(e));
  assert.equal(replies.length, 0);
  child.emit("spawn");
  assert.deepEqual(replies, [undefined]);
  child.emit("error", Error("late failure"));
  camera.stop("fixture");
  assert.equal(replies.length, 1);
});
test("blocked RTSP startup times out before Homebridge write deadline and never spawns after cancellation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { camera, session, request } = fixture();
  let resolve;
  camera.dvr.rtsp = () => new Promise((r) => (resolve = r));
  const run = t.mock.method(media, "runMedia", () => {
    throw Error("must not spawn");
  });
  const replies = [];
  const pending = camera.start(request, (e) => replies.push(e));
  t.mock.timers.tick(7000);
  assert.equal(replies.length, 1);
  assert.match(replies[0].message, /startup timed out/);
  assert(session.abort.signal.aborted);
  resolve("rtsp://127.0.0.1/fixture");
  await pending;
  assert.equal(replies.length, 1);
  assert.equal(run.mock.callCount(), 0);
  assert.equal(camera.sessions.size, 0);
});
test("stop completes a pending startup callback exactly once", async () => {
  const { camera, request } = fixture();
  let resolve;
  camera.dvr.rtsp = () => new Promise((r) => (resolve = r));
  const replies = [];
  const pending = camera.start(request, (e) => replies.push(e));
  camera.stop("fixture");
  assert.equal(replies.length, 1);
  assert.match(replies[0].message, /cancelled/);
  resolve("rtsp://127.0.0.1/fixture");
  await pending;
  assert.equal(replies.length, 1);
});
test("HKSV without conversion advertises only the native source resolution and FPS", () => {
  const hap = require("@homebridge/hap-nodejs");
  let options;
  const api = { hap: Object.create(hap) };
  Object.defineProperty(api.hap, "CameraController", {
    value: class {
      constructor(o) {
        options = o;
      }
    },
  });
  const dvr = new EventEmitter();
  dvr.channels = [
    { id: 4, secondary: { codec: "H.264", width: 704, height: 480, fps: 7 } },
  ];
  const accessory = {
    addService: () => ({ updateCharacteristic: () => {} }),
    configureController: () => {},
  };
  const camera = new Camera(
    api,
    dvr,
    { id: 4, hksv: true },
    accessory,
    () => {},
  );
  assert.deepEqual(options.recording.options.video.resolutions, [
    [704, 480, 7],
  ]);
  camera.close();
});
