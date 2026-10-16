const { test } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const {
  tea,
  discoveryPacket,
  parseDiscovery,
  tunnel,
  Transport,
} = require("../dist/cloud");
const { digest, parseTable, parseRecordings, Dvr } = require("../dist/dvr");
const { Mp4Parser } = require("../dist/recording");
const { ConversionLimiter } = require("../dist/media");
const { validateDevice } = require("../dist/config");
const synthetic = {
  id: "test-dvr",
  name: "Synthetic DVR",
  mode: "direct",
  host: "127.0.0.1",
  username: "fixture-user",
  password: "fixture-password",
};
function reply(serial, status = "1", host = "192.0.2.1", port = "12345") {
  const plain = Buffer.from(`${serial}|${status}|${host}|${port}\0`),
    body = Buffer.alloc(Math.ceil(plain.length / 8) * 8);
  plain.copy(body);
  const h = discoveryPacket(serial, 1700000000123).subarray(0, 20);
  h.writeUInt16LE(0x44e, 2);
  h.writeUInt16LE(plain.length, 16);
  h.writeUInt16LE(body.length, 18);
  return Buffer.concat([
    h,
    ...Array.from({ length: body.length / 8 }, (_, i) =>
      tea(body.subarray(i * 8, i * 8 + 8), h.subarray(0, 16)),
    ),
  ]);
}
test("TEA known zero vector little-endian and decrypt", () => {
  const encrypted = tea(Buffer.alloc(8), Buffer.alloc(16));
  assert.equal(encrypted.toString("hex"), "0a3aea4140a9ba94");
  assert.deepEqual(tea(encrypted, Buffer.alloc(16), true), Buffer.alloc(8));
});
test("discovery header and bounded response parsing", () => {
  const p = discoveryPacket("TEST0001", 1700000000123);
  assert.equal(p.readUInt16LE(), 0x2012);
  assert.equal(p.readUInt32LE(4), 1700000000);
  assert.equal(p.readUInt32LE(8), 123000);
  assert.deepEqual(parseDiscovery(reply("TEST0001"), "TEST0001"), {
    host: "192.0.2.1",
    port: 12345,
  });
  assert.equal(parseDiscovery(reply("TEST0001"), "OTHER"), undefined);
  for (let n = 0; n < 28; n++)
    assert.equal(
      parseDiscovery(reply("TEST0001").subarray(0, n), "TEST0001"),
      undefined,
    );
  assert.equal(
    parseDiscovery(reply("TEST0001", "1", "192.0.2.1", "70000"), "TEST0001"),
    undefined,
  );
  assert.throws(
    () => parseDiscovery(reply("TEST0001", "0"), "TEST0001"),
    /unsupported/,
  );
  assert.throws(() => discoveryPacket("bad\r\n"), /Invalid/);
});
async function mock(handler, fn) {
  const server = net.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(server.address().port);
  } finally {
    await new Promise((r) => server.close(r));
  }
}
test("CONNECT handles split header, leftover bytes and bidirectional transfer", async () => {
  await mock(
    (s) => {
      s.once("data", (data) => {
        assert.match(data.toString(), /^CONNECT 127.0.0.1:554 HTTP\/1.1/);
        s.write("HTTP/1.1 200 OK\r\n");
        setTimeout(() => s.write("\r\nfirst"), 5);
        s.on("data", (b) => s.write(b));
      });
    },
    async (port) => {
      const socket = await tunnel({ host: "127.0.0.1", port }, 554);
      let data = "";
      socket.on("data", (b) => {
        data += b.toString();
        if (data.includes("echo")) socket.destroy();
      });
      socket.resume();
      socket.write("echo");
      await new Promise((r) => socket.once("close", r));
      assert.equal(data, "firstecho");
    },
  );
});
test("CONNECT rejects refused endpoint and cancellation", async () => {
  await mock(
    (s) => s.once("data", () => s.end("HTTP/1.1 403 Forbidden\r\n\r\n")),
    (port) =>
      assert.rejects(tunnel({ host: "127.0.0.1", port }, 554), /handshake/),
  );
  await mock(
    (s) => s.on("data", () => {}),
    async (port) => {
      const abort = new AbortController();
      const p = tunnel({ host: "127.0.0.1", port }, 554, abort.signal);
      setTimeout(() => abort.abort(), 10);
      await assert.rejects(p);
    },
  );
});
test("direct proxy uses dynamic loopback listener and closes sockets", async () => {
  await mock(
    (s) => s.pipe(s),
    async (port) => {
      const t = new Transport(synthetic);
      const [a, b] = await Promise.all([t.localPort(port), t.localPort(port)]);
      assert.equal(a, b);
      const client = net.createConnection({ host: "127.0.0.1", port: a });
      await new Promise((r) => client.once("connect", r));
      client.write("fixture");
      const data = await new Promise((r) => client.once("data", r));
      assert.equal(data.toString(), "fixture");
      t.close();
      await new Promise((r) => client.once("close", r));
      await assert.rejects(t.open(port));
    },
  );
});
test("Digest matches RFC 2617 response formula; rejects unsupported algorithms", () => {
  const v = digest(
    'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="nonce", opaque="opaque"',
    "GET",
    "/cgi-bin/test",
    "u",
    "p",
  );
  assert.match(v, /qop=auth/);
  const fields = Object.fromEntries(
    [...v.matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]),
  );
  const md5 = (s) =>
    require("node:crypto").createHash("md5").update(s).digest("hex");
  const expected = md5(
    `${md5("u:testrealm@host.com:p")}:nonce:00000001:${fields.cnonce}:auth:${md5("GET:/cgi-bin/test")}`,
  );
  assert.equal(fields.response, expected);
  assert.match(v, /uri="\/cgi-bin\/test"/);
  assert.throws(
    () =>
      digest(
        'Digest realm="r", nonce="n", algorithm=SHA-256',
        "GET",
        "/",
        "u",
        "p",
      ),
    /Unsupported/,
  );
});
test("recording tables preserve DVR local time, channel fixtures and empty results", () => {
  assert.deepEqual(parseRecordings("found=0\r\n"), []);
  assert.deepEqual(
    parseRecordings(
      "items[0].StartTime=2026-01-01 01:00:00\r\nitems[0].EndTime=2026-01-01 01:01:00\r\nitems[0].FilePath=/synthetic/file.dav\r\nitems[0].Type=dav",
    ),
    [
      {
        start: "2026-01-01 01:00:00",
        end: "2026-01-01 01:01:00",
        path: "/synthetic/file.dav",
        type: "dav",
      },
    ],
  );
  assert.equal(
    parseTable("table.ChannelTitle[0].Name=Front=Door")[
      "table.ChannelTitle[0].Name"
    ],
    "Front=Door",
  );
});
test("snapshot coalesces concurrent requests and rejects invalid media", async () => {
  const d = new Dvr(synthetic);
  let requests = 0;
  d.bytes = async () => {
    requests++;
    await new Promise((r) => setTimeout(r, 5));
    return Buffer.from([255, 216, 255, 217]);
  };
  await Promise.all([d.snapshot(1), d.snapshot(1)]);
  assert.equal(requests, 1);
  d.close();
});
test("search uses one-based search channel, pagination and closes/destroys search on failure", async () => {
  const d = new Dvr(synthetic);
  d.channels = [{ id: 8 }];
  const calls = [];
  d.text = async (path) => {
    calls.push(path);
    if (path.includes("factory.create")) return "result=123";
    if (path.includes("findFile")) return "OK";
    if (path.includes("findNextFile")) throw new Error("synthetic failure");
    return "OK";
  };
  await assert.rejects(
    d.search(8, "2026-01-01 00:00:00", "2026-01-02 00:00:00"),
  );
  assert(calls.some((s) => s.includes("condition.Channel=8")));
  assert(calls.some((s) => s.includes("action=close")));
  assert(calls.some((s) => s.includes("action=destroy")));
  d.close();
});
test("MP4 initialization and complete fragments across arbitrary chunk boundaries", () => {
  const box = (type, data = "") => {
    const b = Buffer.alloc(8 + data.length);
    b.writeUInt32BE(b.length);
    b.write(type, 4);
    b.write(data, 8);
    return b;
  };
  const packets = [];
  const parser = new Mp4Parser((data, init) => packets.push({ data, init }));
  const input = Buffer.concat(
    ["ftyp", "moov", "moof", "mdat"].map((x) => box(x, "fixture")),
  );
  for (const byte of input) parser.push(Buffer.from([byte]));
  assert.equal(packets.length, 2);
  assert.equal(packets[0].init, true);
  assert.equal(packets[1].init, false);
  assert.throws(() => new Mp4Parser(() => {}).push(Buffer.alloc(8)), /Invalid/);
});
test("conversion permit has a strict default limit and idempotent release", () => {
  const limiter = new ConversionLimiter();
  const release = limiter.acquire();
  assert.throws(() => limiter.acquire(), /limit/);
  release();
  release();
  limiter.acquire()();
});
test("config validates duplicate channels and synthetic identities", () => {
  validateDevice(synthetic);
  assert.throws(
    () => validateDevice({ ...synthetic, channels: [{ id: 1 }, { id: 1 }] }),
    /duplicate/,
  );
  assert.throws(
    () =>
      validateDevice({ ...synthetic, mode: "cloud", serial: "with spaces" }),
    /serial/,
  );
});
