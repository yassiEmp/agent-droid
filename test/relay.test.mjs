// End-to-end link mode without a phone: start a real relay, connect a fake
// "phone" over a real WebSocket (exactly what the Link app does), then drive it
// with the real CLI in --remote mode and check every command reaches the phone.
// Run: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { startRelay } from "../cli/relay.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "cli", "droid.mjs");
const XML = readFileSync(join(here, "fixtures/login.xml"), "utf8");
const TOKEN = "test-token-123";
// 1x1 transparent PNG
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function cli(port, ...args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, "--remote", `http://127.0.0.1:${port}`, "--token", TOKEN, ...args],
      { env: { ...process.env, AGENT_DROID_REMOTE: "" }, timeout: 20000 },
      (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, stdout, stderr }),
    );
  });
}

function fakePhone(port, calls, { name = "s10", token = TOKEN } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/link?token=${token}&name=${name}`);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "hello", name, model: "samsung SM-G975U", android: "12", sdk: 31, app: "0.1.0" }));
      setTimeout(() => resolve(ws), 100);
    };
    ws.onerror = (e) => reject(e.error || new Error("ws error"));
    ws.onmessage = (ev) => {
      const { id, method, params } = JSON.parse(ev.data);
      calls.push({ method, params });
      const ok = (result) => ws.send(JSON.stringify({ id, ok: true, result }));
      switch (method) {
        case "dump": return ok(XML);
        case "current": return ok("com.example/.LoginActivity");
        case "info": return ok({ model: "samsung SM-G975U", android: "12", sdk: 31, locked: false });
        case "screenshot": return ok({ format: "png", width: 1, height: 1, data: PNG_B64 });
        case "key":
          if (params.name === "TAB") return ws.send(JSON.stringify({ id, ok: false, error: "key TAB isn't available in link mode" }));
          return ok(true);
        default: return ok(true);
      }
    };
  });
}

test("link mode: relay + fake phone + real CLI", async (t) => {
  const relay = await startRelay({ port: 0, host: "127.0.0.1", token: TOKEN, log: () => {} });
  t.after(() => relay.close());
  const calls = [];

  // No phone yet → a clear error.
  let r = await cli(relay.port, "snapshot");
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /No phone connected/);

  const phone = await fakePhone(relay.port, calls);
  t.after(() => phone.close());

  // Bad token is refused.
  const bad = await fetch(`http://127.0.0.1:${relay.port}/devices`, { headers: { authorization: "Bearer nope" } });
  assert.equal(bad.status, 401);

  r = await cli(relay.port, "doctor", "--json");
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.ready, true);
  assert.equal(doc.transport, "link");
  assert.equal(doc.serial, "link:s10");
  assert.equal(doc.foreground, "com.example/.LoginActivity");

  r = await cli(relay.port, "snapshot", "--json");
  const refs = JSON.parse(r.stdout);
  assert.deepEqual(refs.map((x) => x.name), ["Email", "Password", "Sign In", "Sign In with Google"]);

  calls.length = 0;
  r = await cli(relay.port, "tap", "Sign In", "--json");
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { action: "tap", ref: "e3", name: "Sign In", cx: 720, cy: 2612, stale: false });
  assert.deepEqual(calls.at(-1), { method: "tap", params: { x: 720, y: 2612 } });

  calls.length = 0;
  r = await cli(relay.port, "type", "@e1", "café ✓ émoji 🙂");
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(
    calls.map((c) => c.method),
    ["dump", "tap", "clear", "type"],
  );
  assert.equal(calls.at(-1).params.text, "café ✓ émoji 🙂");

  r = await cli(relay.port, "swipe", "up");
  assert.equal(calls.at(-1).method, "swipe");
  assert.equal(calls.at(-1).params.dir, "up");

  r = await cli(relay.port, "key", "back");
  assert.deepEqual(calls.at(-1), { method: "key", params: { name: "BACK" } });

  r = await cli(relay.port, "key", "TAB");
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /isn't available in link mode/);

  r = await cli(relay.port, "open", "com.whatsapp");
  assert.deepEqual(calls.at(-1), { method: "open", params: { target: "com.whatsapp" } });

  const shot = join(tmpdir(), `droid-link-test-${process.pid}.png`);
  r = await cli(relay.port, "screenshot", shot);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(shot));
  assert.equal(readFileSync(shot).subarray(1, 4).toString(), "PNG");
  rmSync(shot);

  r = await cli(relay.port, "wait", "Sign In", "2000");
  assert.equal(r.code, 0);

  r = await cli(relay.port, "logs");
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /needs adb/);

  r = await cli(relay.port, "--serial", "pixel", "current");
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /"pixel" is not connected/);

  // Setup page needs the token and hands back a working deep link.
  const page = await fetch(`http://127.0.0.1:${relay.port}/setup?token=${TOKEN}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /agentdroid:\/\/link\?url=ws%3A%2F%2F127\.0\.0\.1/);
  assert.equal((await fetch(`http://127.0.0.1:${relay.port}/setup?token=nope`)).status, 401);
});

test("link mode: a phone that reconnects replaces the old connection", async (t) => {
  const relay = await startRelay({ port: 0, host: "127.0.0.1", token: TOKEN, log: () => {} });
  t.after(() => relay.close());
  const a = await fakePhone(relay.port, []);
  const b = await fakePhone(relay.port, []);
  t.after(() => {
    a.close();
    b.close();
  });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(relay.devices.size, 1);
  const r = await cli(relay.port, "current");
  assert.equal(r.stdout.trim(), "com.example/.LoginActivity");
});

test("link mode: wrong token can't connect a phone", async (t) => {
  const relay = await startRelay({ port: 0, host: "127.0.0.1", token: TOKEN, log: () => {} });
  t.after(() => relay.close());
  await assert.rejects(fakePhone(relay.port, [], { token: "wrong" }));
  assert.equal(relay.devices.size, 0);
});
