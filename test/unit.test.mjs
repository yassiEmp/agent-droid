// Pure-function tests: hierarchy parsing, the ref model, identity matching,
// remote URL parsing, and the WebSocket framing used by the relay.
// Run: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBounds, allNodes, refsFromXml, matchLive, nameFor } from "../cli/lib.mjs";
import { parseRemote } from "../cli/remote.mjs";
import { encodeFrame, FrameParser, acceptKey } from "../cli/ws.mjs";
import { linkUri } from "../cli/relay.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const XML = readFileSync(join(here, "fixtures/login.xml"), "utf8");

test("parseBounds", () => {
  assert.deepEqual(parseBounds("[0,10][100,210]"), { x1: 0, y1: 10, x2: 100, y2: 210, cx: 50, cy: 110 });
  assert.equal(parseBounds("nope"), null);
});

test("allNodes + nameFor: a nameless clickable takes its child's text", () => {
  const all = allNodes(XML);
  assert.equal(all.length, 6);
  const group = all.find((n) => n.class === "android.view.ViewGroup");
  assert.equal(nameFor(group, all), "Sign In");
});

test("refsFromXml: interactive elements become @eN refs", () => {
  const refs = refsFromXml("unit-test", XML);
  assert.deepEqual(
    refs.map((r) => [r.ref, r.type, r.name]),
    [
      ["e1", "input", "Email"],
      ["e2", "input", "Password"],
      ["e3", "button", "Sign In"],
      ["e4", "button", "Sign In with Google & more"],
    ],
  );
  assert.equal(refs[1].sig.password, true);
  assert.equal(refs[2].cx, 720);
});

test("matchLive: re-finds a ref by identity after a layout shift", () => {
  const refs = refsFromXml("unit-test", XML);
  const shifted = XML.replace("[100,2740][1340,2884]", "[100,1740][1340,1884]");
  const hit = matchLive(allNodes(shifted), refs[3]);
  assert.deepEqual(hit, { cx: 720, cy: 1812, stale: false });
  const gone = matchLive(allNodes(XML.replace(/Sign In with Google &amp; more/g, "Other")), refs[3]);
  assert.equal(gone.stale, true);
});

test("parseRemote", () => {
  assert.deepEqual(parseRemote("adb://100.64.1.2:5555"), { kind: "adb", host: "100.64.1.2", port: 5555 });
  assert.deepEqual(parseRemote("adb://phone"), { kind: "adb", host: "phone", port: 5555 });
  assert.deepEqual(parseRemote("100.64.1.2:40123"), { kind: "adb", host: "100.64.1.2", port: 40123 });
  assert.deepEqual(parseRemote("http://100.64.1.2:8790"), { kind: "link", url: "http://100.64.1.2:8790" });
  assert.deepEqual(parseRemote("ws://box:8790/link?token=x"), { kind: "link", url: "http://box:8790" });
  assert.deepEqual(parseRemote("https://relay.example.com/"), { kind: "link", url: "https://relay.example.com" });
  assert.equal(parseRemote(undefined), null);
  assert.throws(() => parseRemote("ftp://x"));
});

test("linkUri carries url, token and name", () => {
  const u = new URL(linkUri("ws://100.64.1.2:8790/link", "t0k&n", "s10"));
  assert.equal(u.protocol, "agentdroid:");
  assert.equal(u.searchParams.get("url"), "ws://100.64.1.2:8790/link");
  assert.equal(u.searchParams.get("token"), "t0k&n");
  assert.equal(u.searchParams.get("name"), "s10");
});

function maskedFrame(opcode, payload, fin = true) {
  const data = Buffer.from(payload);
  const mask = Buffer.from([1, 2, 3, 4]);
  const len = data.length;
  let head;
  if (len < 126) head = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | len]);
  else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = (fin ? 0x80 : 0) | opcode;
    head[1] = 0x80 | 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = (fin ? 0x80 : 0) | opcode;
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i++) body[i] = data[i] ^ mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

test("ws: RFC 6455 accept key", () => {
  assert.equal(acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

test("ws: parses masked frames of every length class, split across chunks", () => {
  const got = [];
  const p = new FrameParser((f) => got.push(f));
  const small = "hi";
  const mid = "x".repeat(300);
  const big = "y".repeat(70000);
  const all = Buffer.concat([maskedFrame(1, small), maskedFrame(1, mid), maskedFrame(1, big)]);
  for (let i = 0; i < all.length; i += 999) p.push(all.subarray(i, i + 999));
  assert.deepEqual(got.map((f) => f.payload.toString()), [small, mid, big]);
});

test("ws: server frames round-trip through the parser (unmasked)", () => {
  const got = [];
  const p = new FrameParser((f) => got.push(f));
  p.push(encodeFrame(1, "z".repeat(70000)));
  assert.equal(got[0].payload.length, 70000);
  assert.equal(got[0].fin, true);
});
