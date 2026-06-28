// lib.mjs — functions powering the `agent-droid` CLI (agent-friendly Android driver).
//
// Design mirrors agent-browser: snapshot the accessibility tree into ref-tagged
// interactive elements, then act on refs. The reliability win over raw adb is
// IDENTITY-BASED re-resolution: a ref remembers a node's text/desc/class, and
// every act() re-dumps the tree and re-finds that node's CURRENT bounds — so a
// soft-keyboard layout shift or a hot-reload reflow can't make a tap miss.

import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const VENDOR = join(dirname(fileURLToPath(import.meta.url)), "vendor");
const DUMPER_APP = join(VENDOR, "droid-dumper-app.apk");
const DUMPER_TEST = join(VENDOR, "droid-dumper-test.apk");
// Instrumentation that calls UiDevice.dumpWindowHierarchy with waitForIdle=0,
// returning the hierarchy XML in a status Bundle. Animation-proof, unlike the
// legacy `uiautomator dump` (which fails "could not get idle state" on screens
// that never idle). Built from the `dumper/` project, vendored here.
const DUMPER_PACKAGE = "dev.agentdroid.dumper";
const DUMPER_INSTRUMENTATION = `${DUMPER_PACKAGE}.test/androidx.test.runner.AndroidJUnitRunner`;
const DUMPER_CLASS = `${DUMPER_PACKAGE}.DumpTest#dump`;
const DUMP_BEGIN = "<<<DROID_DUMP_BEGIN>>>";
const DUMP_END = "<<<DROID_DUMP_END>>>";

// Default logcat tag for the `logs` command. React Native apps log under
// `ReactNativeJS`; override per-call with `logs --tag <TAG>` (or `*` for all).
const DEFAULT_LOG_TAG = "ReactNativeJS";

const KEYS = {
  BACK: 4,
  HOME: 3,
  ENTER: 66,
  TAB: 61,
  DEL: 67,
  MOVE_END: 123,
  ESCAPE: 111,
  SEARCH: 84,
};

function adbRaw(serial, args) {
  const base = serial ? ["-s", serial] : [];
  return execFileSync("adb", [...base, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    // Ignore child stderr: uiautomator prints "could not get idle state" there on
    // animated screens; we handle that via empty-hierarchy detection, not noise.
    stdio: ["ignore", "pipe", "ignore"],
  });
}

export function pickDevice(explicit) {
  const out = execFileSync("adb", ["devices"], { encoding: "utf8" });
  const devices = out
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l.endsWith("\tdevice"))
    .map((l) => l.split("\t")[0]);
  if (explicit) {
    // Validate the explicit serial so a typo gives a clean message instead of a
    // raw `adb -s NOPE …` failure later.
    if (!devices.includes(explicit)) {
      throw new Error(`Unknown serial "${explicit}" (not in \`adb devices\`: ${devices.join(", ") || "none"}).`);
    }
    return explicit;
  }
  if (devices.length === 0) throw new Error("No adb device connected (`adb devices` is empty).");
  return devices[0];
}

const cachePath = (serial) => join(tmpdir(), `droid-refs-${serial || "default"}.json`);

function parseBounds(b) {
  const m = b.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!m) return null;
  const [, x1, y1, x2, y2] = m.map(Number);
  return { x1, y1, x2, y2, cx: Math.round((x1 + x2) / 2), cy: Math.round((y1 + y2) / 2) };
}

function dumpOnce(serial) {
  // `/dev/tty` streams XML to stdout; strip the trailing status line.
  const raw = adbRaw(serial, ["exec-out", "uiautomator", "dump", "/dev/tty"]);
  return raw.replace(/UI hierch?ary dumped to:.*$/m, "");
}

function dumpViaFile(serial) {
  // More robust than /dev/tty when the window isn't idle: write to a file, cat it.
  adbRaw(serial, ["shell", "uiautomator", "dump", "/sdcard/droid-dump.xml"]);
  return adbRaw(serial, ["shell", "cat", "/sdcard/droid-dump.xml"]);
}

export function hasDumper(serial) {
  try {
    const out = adbRaw(serial, ["shell", "pm", "list", "instrumentation"]);
    return out.includes(`${DUMPER_PACKAGE}.test/`);
  } catch {
    return false;
  }
}

export function installDumper(serial) {
  if (!existsSync(DUMPER_TEST) || !existsSync(DUMPER_APP)) {
    throw new Error(
      `Dumper APKs not vendored at ${VENDOR}. Rebuild from skills/droid/dumper ` +
        `(./gradlew :app:assembleDebug :app:assembleDebugAndroidTest) and copy the APKs.`,
    );
  }
  // App must exist before its instrumentation can target it.
  execFileSync("adb", ["-s", serial, "install", "-r", DUMPER_APP], { stdio: "ignore" });
  execFileSync("adb", ["-s", serial, "install", "-r", DUMPER_TEST], { stdio: "ignore" });
  return hasDumper(serial);
}

function dumpViaInstrumentation(serial) {
  // Primary transport: animation-proof. Returns "" if the dumper isn't
  // installed so dumpXml can fall through to the legacy transports.
  if (!hasDumper(serial)) return "";
  const out = adbRaw(serial, [
    "shell",
    "am",
    "instrument",
    "-w",
    "-r",
    "-e",
    "class",
    DUMPER_CLASS,
    DUMPER_INSTRUMENTATION,
  ]);
  const start = out.indexOf(DUMP_BEGIN);
  const end = out.indexOf(DUMP_END);
  if (start === -1 || end === -1) return "";
  return out.slice(start + DUMP_BEGIN.length, end);
}

function dumpXml(serial) {
  // Instrumentation dumper first (works mid-animation); then the legacy
  // uiautomator transports, which silently return empty when the UI isn't idle
  // (Fast Refresh, transitions). Retry across all three before giving up.
  for (let i = 0; i < 4; i++) {
    for (const fn of [dumpViaInstrumentation, dumpOnce, dumpViaFile]) {
      try {
        const xml = fn(serial);
        if (xml.includes("<node")) return xml;
      } catch {
        /* try next transport */
      }
    }
    execFileSync("adb", ["-s", serial, "shell", "sleep", "0.5"]);
  }
  const err = new Error(
    "No hierarchy after retries (UI may be mid-animation). Install the dumper " +
      "with `droid setup` for animation-proof snapshots, or use screenshot + coordinate taps.",
  );
  err.code = "UI_ANIMATED";
  throw err;
}

function allNodes(xml) {
  const nodes = [];
  for (const tag of xml.match(/<node\b[^>]*>/g) || []) {
    const attrs = {};
    for (const [, k, v] of tag.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[k] = v;
    const bounds = parseBounds(attrs.bounds || "");
    if (!bounds) continue;
    nodes.push({ ...attrs, bounds });
  }
  return nodes;
}

function isInteractive(n) {
  return (
    n.clickable === "true" ||
    n["long-clickable"] === "true" ||
    n.scrollable === "true" ||
    (n.class || "").includes("EditText")
  );
}

function label(n) {
  if ((n.class || "").includes("EditText")) return "input";
  if (n.scrollable === "true") return "scroll";
  if (n.checkable === "true") return "toggle";
  return "button";
}

// Best human-readable name: own text/desc, else nearest descendant text.
function nameFor(n, all) {
  const own = (n.content_desc || n["content-desc"] || n.text || "").trim();
  if (own) return own;
  const inside = all.find(
    (c) =>
      c !== n &&
      (c.text || "").trim() &&
      c.bounds.x1 >= n.bounds.x1 &&
      c.bounds.x2 <= n.bounds.x2 &&
      c.bounds.y1 >= n.bounds.y1 &&
      c.bounds.y2 <= n.bounds.y2,
  );
  return inside ? inside.text.trim() : "";
}

export function snapshot(serial) {
  // Self-heal: if the only reason the dump failed is a never-idle animation and
  // the animation-proof dumper isn't installed yet, install it and retry once.
  let xml;
  try {
    xml = dumpXml(serial);
  } catch (e) {
    if (e.code === "UI_ANIMATED" && !hasDumper(serial)) {
      installDumper(serial);
      xml = dumpXml(serial);
    } else throw e;
  }
  const all = allNodes(xml);
  const refs = [];
  for (const n of all) {
    if (!isInteractive(n)) continue;
    const name = nameFor(n, all);
    refs.push({
      ref: `e${refs.length + 1}`,
      type: label(n),
      name,
      sig: {
        desc: (n["content-desc"] || "").trim(),
        text: (n.text || "").trim(),
        class: n.class || "",
        password: n.password === "true",
      },
      cx: n.bounds.cx,
      cy: n.bounds.cy,
      bounds: n.bounds,
    });
  }
  writeFileSync(cachePath(serial), JSON.stringify({ refs }, null, 0));
  return refs;
}

function loadRef(serial, ref) {
  // Self-heal: auto-snapshot if there's no cache yet, so `tap @e3` works even
  // when the agent skipped an explicit `snapshot`.
  if (!existsSync(cachePath(serial))) snapshot(serial);
  const { refs } = JSON.parse(readFileSync(cachePath(serial), "utf8"));
  const found = refs.find((r) => r.ref === ref || r.ref === ref.replace(/^@/, ""));
  if (!found) throw new Error(`Unknown ref ${ref} — re-run \`droid snapshot\`.`);
  return found;
}

// Resolve a target by its visible text instead of a @ref: take a fresh
// snapshot and pick the interactive element whose name contains the query
// (case-insensitive). Lets an agent act in one call without the
// snapshot→read→pick-ref→act round-trip. Prefers the most specific (shortest)
// matching name when several match.
export function resolveByText(serial, query) {
  const refs = snapshot(serial);
  const q = query.toLowerCase();
  const matches = refs.filter((r) => (r.name || "").toLowerCase().includes(q));
  if (matches.length === 0) {
    throw new Error(`No element matching "${query}". Run \`droid snapshot\` to see what's on screen.`);
  }
  matches.sort((a, b) => (a.name || "").length - (b.name || "").length);
  const m = matches[0];
  return { cx: m.cx, cy: m.cy, stale: false, ref: m.ref, name: m.name };
}

// Re-dump and re-find the ref's node by identity; return its CURRENT center.
function resolveLive(serial, refObj) {
  const all = allNodes(dumpXml(serial));
  const sig = refObj.sig;
  const candidates = all.filter(
    (n) =>
      (n.class || "") === sig.class &&
      (n["content-desc"] || "").trim() === sig.desc &&
      // EditText text mutates as you type — match those on desc+class only.
      (sig.class.includes("EditText") || (n.text || "").trim() === sig.text),
  );
  if (candidates.length === 0) return { cx: refObj.cx, cy: refObj.cy, stale: true };
  // If several match, pick the one closest to where it was.
  candidates.sort(
    (a, b) =>
      Math.hypot(a.bounds.cx - refObj.cx, a.bounds.cy - refObj.cy) -
      Math.hypot(b.bounds.cx - refObj.cx, b.bounds.cy - refObj.cy),
  );
  const c = candidates[0].bounds;
  return { cx: c.cx, cy: c.cy, stale: false };
}

export function targetFor(serial, refOrXY) {
  // `tap X Y` — two integer args → raw coordinates.
  if (refOrXY.length === 2 && refOrXY.every((v) => /^\d+$/.test(v))) {
    return { cx: Number(refOrXY[0]), cy: Number(refOrXY[1]), stale: false };
  }
  const a = refOrXY[0];
  // `tap @e3` / `tap e3` — a ref → re-resolve its live bounds by identity.
  if (/^@?e\d+$/.test(a)) {
    const refObj = loadRef(serial, a);
    return { ...resolveLive(serial, refObj), ref: refObj.ref, name: refObj.name };
  }
  // `tap "Sign In"` — anything else is a visible-text query.
  return resolveByText(serial, refOrXY.join(" "));
}

export function tap(serial, target) {
  adbRaw(serial, ["shell", "input", "tap", String(target.cx), String(target.cy)]);
}

export function clearFocused(serial, approxLen = 60) {
  // Move to end, then a single batched keyevent of N deletes (one adb round-trip).
  const dels = Array(approxLen).fill(KEYS.DEL);
  adbRaw(serial, ["shell", "input", "keyevent", String(KEYS.MOVE_END), ...dels.map(String)]);
}

export function typeText(serial, text) {
  // adb `input text` treats spaces specially → encode as %s. Args are passed
  // argv-style (no shell), so no further quoting needed for ASCII payloads.
  adbRaw(serial, ["shell", "input", "text", text.replace(/ /g, "%s")]);
}

export function key(serial, name) {
  const code = KEYS[name.toUpperCase()] ?? Number(name);
  if (!Number.isFinite(code)) throw new Error(`Unknown key: ${name}`);
  adbRaw(serial, ["shell", "input", "keyevent", String(code)]);
}

export function swipe(serial, dir) {
  const moves = {
    up: [700, 1800, 700, 600],
    down: [700, 600, 700, 1800],
    left: [1100, 1200, 200, 1200],
    right: [200, 1200, 1100, 1200],
  };
  const m = moves[dir];
  if (!m) throw new Error(`swipe dir must be up|down|left|right`);
  adbRaw(serial, ["shell", "input", "swipe", ...m.map(String), "300"]);
}

export function currentFocus(serial) {
  const out = adbRaw(serial, ["shell", "dumpsys", "window"]);
  const m = out.match(/mCurrentFocus=Window\{[^}]*\s+([^\s}]+)\}/);
  return m ? m[1] : "unknown";
}

export function screenshot(serial, file) {
  const png = execFileSync("adb", ["-s", serial, "exec-out", "screencap", "-p"], {
    maxBuffer: 64 * 1024 * 1024,
  });
  writeFileSync(file, png);
  return file;
}

export async function waitFor(serial, needle, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  const want = needle.toLowerCase();
  while (Date.now() < deadline) {
    const xml = dumpXml(serial);
    if (xml.toLowerCase().includes(want)) return true;
    await new Promise((r) => setTimeout(r, 600));
  }
  return false;
}

export function devicesList() {
  return execFileSync("adb", ["devices"], { encoding: "utf8" }).trim();
}

// App logcat — animation-proof, unlike uiautomator. `tag` selects the logcat
// tag (default ReactNativeJS for RN apps; pass "*" for all tags). Optional
// regex `filter` and `tail` count.
export function readLogs(serial, { tag = DEFAULT_LOG_TAG, filter, tail = 40 } = {}) {
  const out = adbRaw(serial, ["logcat", "-d", "-s", `${tag}:*`]);
  let lines = out.split("\n").filter(Boolean);
  if (filter) {
    const re = new RegExp(filter, "i");
    lines = lines.filter((l) => re.test(l));
  }
  return lines.slice(-tail).join("\n");
}
