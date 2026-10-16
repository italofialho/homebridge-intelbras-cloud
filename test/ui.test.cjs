const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync, fork } = require("node:child_process");
const root = path.join(__dirname, "..");
test("npm package exposes the Homebridge custom UI entry point", () => {
  const r = spawnSync(
    "npm",
    ["pack", "--ignore-scripts", "--dry-run", "--json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  const files = JSON.parse(r.stdout)[0].files.map((x) => x.path);
  for (const file of [
    "homebridge-ui/public/index.html",
    "homebridge-ui/server.js",
    "dist/ui.js",
    "config.schema.json",
  ])
    assert(files.includes(file), `Missing ${file}`);
  const html = fs.readFileSync(
    path.join(root, "homebridge-ui/public/index.html"),
    "utf8",
  );
  new Function(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
});
test("custom UI server starts and responds over Homebridge IPC", async () => {
  const child = fork(path.join(root, "homebridge-ui/server.js"), [], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("UI server readiness timed out")),
        5000,
      );
      child.once("error", reject);
      child.on("message", (message) => {
        if (message.action === "ready") {
          child.send({
            action: "request",
            requestId: "fixture-ui",
            path: "/synthetic-not-found",
            body: {},
          });
        }
        if (message.action === "response") {
          try {
            assert.equal(message.payload.requestId, "fixture-ui");
            assert.equal(message.payload.success, false);
            assert.equal(message.payload.data.message, "Not Found");
            clearTimeout(timer);
            resolve();
          } catch (e) {
            clearTimeout(timer);
            reject(e);
          }
        }
      });
    });
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      child.once("exit", resolve);
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3000);
      t.unref();
    });
  }
});
