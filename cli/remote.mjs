// remote.mjs — the two remote transports behind `--remote`.
//
//   --remote http(s)://relay:8790   link mode: talk to `agent-droid relay`, which
//                                   forwards to the Link app on the phone. Works
//                                   on Wi-Fi and 4G, survives reboots.
//   --remote adb://100.x.y.z:5555   remote adb: plain adb over the network (e.g.
//                                   Tailscale). Full adb power (logs, setup), but
//                                   adb's network mode resets when the phone reboots.
//
// Both keep the exact same command surface as local mode.

import { execFileSync } from "node:child_process";

export function parseRemote(value) {
  if (!value) return null;
  const v = String(value).trim();
  const m = v.match(/^adb:\/\/([^/:]+|\[[^\]]+\])(?::(\d+))?\/?$/i);
  if (m) return { kind: "adb", host: m[1], port: Number(m[2] || 5555) };
  if (/^(https?|wss?):\/\//i.test(v)) {
    // Accept the ws:// URL the phone uses too; the CLI talks HTTP to the same host.
    const u = new URL(v.replace(/^ws/i, "http"));
    u.pathname = u.pathname.replace(/\/link\/?$/, "").replace(/\/+$/, "");
    u.search = "";
    return { kind: "link", url: u.toString().replace(/\/$/, "") };
  }
  // Bare host:port → remote adb (what `adb connect` takes).
  const hp = v.match(/^([\w.-]+):(\d+)$/);
  if (hp) return { kind: "adb", host: hp[1], port: Number(hp[2]) };
  throw new Error(
    `Can't read --remote "${v}". Use http://<relay-host>:8790 (Link app) or adb://<phone-ip>:5555 (remote adb).`,
  );
}

// ── link mode ────────────────────────────────────────────────────────────────

export function makeLink(baseUrl, token, { fetchImpl = globalThis.fetch } = {}) {
  if (!token) {
    throw new Error("Remote link mode needs the relay token: --token <T> or AGENT_DROID_TOKEN.");
  }
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  async function request(path, init = {}) {
    let res;
    try {
      res = await fetchImpl(baseUrl + path, { ...init, headers });
    } catch (e) {
      throw new Error(`can't reach the relay at ${baseUrl} (${e.cause?.code || e.message}). Is \`agent-droid relay\` running?`);
    }
    let body;
    try {
      body = await res.json();
    } catch {
      body = {};
    }
    if (!res.ok) throw new Error(body.error || `relay answered HTTP ${res.status}`);
    return body;
  }

  const deviceName = (serial) => (serial ? String(serial).replace(/^link:/, "") : undefined);

  const link = {
    baseUrl,
    async devices() {
      return (await request("/devices")).devices || [];
    },
    async pickDevice(explicit) {
      const list = await link.devices();
      const names = list.map((d) => d.name);
      if (explicit) {
        const want = deviceName(explicit);
        if (!names.includes(want)) {
          throw new Error(`Phone "${want}" is not connected to the relay (connected: ${names.join(", ") || "none"}).`);
        }
        return `link:${want}`;
      }
      if (names.length === 0) {
        throw new Error(
          "No phone connected to the relay. Open agent-droid Link on the phone and check it says Connected.",
        );
      }
      return `link:${names[0]}`;
    },
    async devicesList() {
      const list = await link.devices();
      if (list.length === 0) return `relay ${baseUrl}: no phone connected`;
      return [`relay ${baseUrl}:`, ...list.map((d) => `link:${d.name}\t${d.model || "?"} · Android ${d.android || "?"}`)].join("\n");
    },
    async call(serial, method, params = {}, timeoutMs) {
      const body = await request("/rpc", {
        method: "POST",
        body: JSON.stringify({ device: deviceName(serial), method, params, timeoutMs }),
      });
      if (body.ok === false) {
        const err = new Error(body.error || `phone failed "${method}"`);
        if (/locked/i.test(err.message)) err.code = "SCREEN_LOCKED";
        throw err;
      }
      return body.result;
    },
    async dumpXml(serial) {
      // An empty tree usually means a transition; retry briefly like the adb path.
      for (let i = 0; i < 4; i++) {
        const r = await link.call(serial, "dump");
        const xml = typeof r === "string" ? r : r?.xml || "";
        if (xml.includes("<node")) return xml;
        await new Promise((ok) => setTimeout(ok, 400));
      }
      const err = new Error("The phone returned an empty screen (locked, off, or mid-transition). Try `wake`, or unlock it.");
      err.code = "UI_ANIMATED";
      throw err;
    },
  };
  return link;
}

// ── remote adb ───────────────────────────────────────────────────────────────

function adb(args, opts = {}) {
  return execFileSync("adb", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20000, ...opts });
}

// `adb connect host:port`, then confirm it is listed as a usable device.
export function connectAdb(host, port) {
  const serial = `${host}:${port}`;
  let out = "";
  try {
    out = adb(["connect", serial]);
  } catch (e) {
    out = String(e.stdout || "") + String(e.stderr || e.message);
  }
  const listed = adb(["devices"])
    .split("\n")
    .some((l) => l.trim() === `${serial}\tdevice`);
  if (!listed) {
    const unauthorized = /unauthorized/i.test(out) || adb(["devices"]).includes(`${serial}\tunauthorized`);
    throw new Error(
      unauthorized
        ? `${serial} is reachable but not authorized: accept the "Allow USB/wireless debugging" prompt on the phone.`
        : `Can't adb-connect to ${serial} (${out.trim() || "no answer"}). The phone's adb network mode is off ` +
            "(it resets on reboot): re-run `agent-droid pair` + `agent-droid tcpip`, or use the Link app.",
    );
  }
  return serial;
}

// Android 11+ wireless debugging pairing ("Pair device with pairing code").
export function pairAdb(hostPort, code) {
  const out = adb(["pair", hostPort, String(code)], { timeout: 30000 });
  if (!/success/i.test(out)) throw new Error(`pairing failed: ${out.trim()}`);
  return out.trim();
}

// Switch adbd to a fixed TCP port that listens on every interface, so it is
// reachable over Tailscale on Wi-Fi AND 4G (until the phone reboots).
export function enableTcpip(serial, port = 5555) {
  return adb(["-s", serial, "tcpip", String(port)]).trim();
}
