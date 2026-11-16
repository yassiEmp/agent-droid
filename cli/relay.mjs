// relay.mjs — `agent-droid relay`: the meeting point for remote (link) mode.
//
// The phone can't be dialed directly on 4G (carrier NAT), so the agent-droid
// Link app on the phone dials OUT to this relay over a WebSocket and keeps the
// connection open. The CLI (on the same machine or anywhere that can reach the
// relay) sends commands as plain HTTP POSTs; the relay forwards each one to the
// phone and returns the phone's answer. Run it on any always-on box the phone
// can reach: a Tailscale IP, a LAN IP, or a public HTTPS URL behind a proxy.
//
//   phone (Link app) ──ws──▶ relay ◀──http── agent-droid --remote http://relay:8790
//
// Endpoints (all but /health and /setup need `Authorization: Bearer <token>`):
//   GET  /health                 liveness, no auth
//   GET  /setup?token=T          phone-friendly page with a one-tap "connect" link
//   GET  /devices                connected phones
//   POST /rpc {device?, method, params?, timeoutMs?}   run one command on a phone
//   WS   /link?token=T&name=N    the phone's outbound connection

import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces, homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { upgrade } from "./ws.mjs";

export const DEFAULT_PORT = 8790;
const PING_MS = 20000;
const DEAD_MS = 65000;

const CONFIG_DIR = join(homedir(), ".agent-droid");
const CONFIG_FILE = join(CONFIG_DIR, "relay.json");

// Token precedence: --token flag, AGENT_DROID_TOKEN, saved config, else a new
// random one that is saved so the phone keeps working across relay restarts.
export function resolveToken(explicit) {
  if (explicit) return explicit;
  if (process.env.AGENT_DROID_TOKEN) return process.env.AGENT_DROID_TOKEN;
  try {
    const saved = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    if (saved.token) return saved.token;
  } catch {
    /* no saved token yet */
  }
  const token = randomBytes(24).toString("base64url");
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify({ token }, null, 2), { mode: 0o600 });
  return token;
}

function sameToken(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && timingSafeEqual(x, y);
}

function bearer(req, url) {
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) return h.slice(7).trim();
  return url.searchParams.get("token") || "";
}

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// The deep link the Link app understands. Opening it fills in and saves the
// relay URL + token and connects; no typing on the phone.
export function linkUri(wsUrl, token, name) {
  const q = new URLSearchParams({ url: wsUrl, token });
  if (name) q.set("name", name);
  return `agentdroid://link?${q}`;
}

function wsUrlFor(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const secure = proto === "https" || req.socket.encrypted;
  return `${secure ? "wss" : "ws"}://${req.headers.host}/link`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function setupPage(uri) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>agent-droid Link</title><style>
body{font:17px/1.45 system-ui,sans-serif;margin:0;padding:28px 22px;color:#111;background:#fafafa}
h1{font-size:22px;margin:0 0 6px}p{color:#555;margin:0 0 22px}
a.btn{display:block;text-align:center;background:#111;color:#fff;text-decoration:none;padding:16px;border-radius:14px;font-weight:600}
code{display:block;word-break:break-all;font-size:12px;color:#777;margin-top:22px}
</style></head><body><h1>Connect this phone</h1>
<p>Install agent-droid Link and turn on its accessibility service first. Then tap the button.</p>
<a class="btn" href="${esc(uri)}">Open in agent-droid Link</a><code>${esc(uri)}</code></body></html>`;
}

export function localAddresses() {
  const out = [];
  for (const [ifname, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const tailscale = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address);
      out.push({ ifname, address: a.address, tailscale });
    }
  }
  return out.sort((a, b) => Number(b.tailscale) - Number(a.tailscale));
}

export function startRelay({ port = DEFAULT_PORT, host = "0.0.0.0", token, log = console.log } = {}) {
  const devices = new Map(); // name → { conn, info, pending, connectedAt }
  let seq = 0;

  function pick(name) {
    if (name) return devices.get(name) || null;
    return devices.values().next().value || null;
  }

  function call(dev, method, params, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        dev.pending.delete(id);
        reject(Object.assign(new Error(`phone did not answer "${method}" within ${timeoutMs}ms`), { status: 504 }));
      }, timeoutMs);
      dev.pending.set(id, { resolve, reject, timer });
      if (!dev.conn.send(JSON.stringify({ id, method, params: params || {} }))) {
        clearTimeout(timer);
        dev.pending.delete(id);
        reject(Object.assign(new Error("phone disconnected"), { status: 503 }));
      }
    });
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://relay");
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, { ok: true, devices: devices.size });
      }
      const authed = sameToken(bearer(req, url), token);
      if (req.method === "GET" && url.pathname === "/setup") {
        if (!authed) return json(res, 401, { error: "bad token" });
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(setupPage(linkUri(wsUrlFor(req), token, url.searchParams.get("name") || undefined)));
      }
      if (!authed) return json(res, 401, { error: "missing or bad token" });
      if (req.method === "GET" && url.pathname === "/devices") {
        return json(res, 200, {
          devices: [...devices.entries()].map(([name, d]) => ({ name, ...d.info, connectedAt: d.connectedAt })),
        });
      }
      if (req.method === "POST" && url.pathname === "/rpc") {
        const body = JSON.parse((await readBody(req)) || "{}");
        if (!body.method) return json(res, 400, { error: "method required" });
        const dev = pick(body.device);
        if (!dev) {
          const known = [...devices.keys()];
          return json(res, 404, {
            error: body.device
              ? `phone "${body.device}" is not connected (connected: ${known.join(", ") || "none"})`
              : "no phone connected to the relay",
          });
        }
        const reply = await call(dev, body.method, body.params, Math.min(Number(body.timeoutMs) || 30000, 120000));
        return json(res, 200, reply);
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, e.status || 500, { error: e.message });
    }
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://relay");
    if (url.pathname !== "/link" || !sameToken(bearer(req, url), token)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    let dev = null;
    const conn = upgrade(req, socket, {
      onMessage(text) {
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if (msg.type === "hello") {
          const name = String(msg.name || url.searchParams.get("name") || "phone").slice(0, 64);
          const old = devices.get(name);
          if (old && old.conn !== conn) old.conn.close(4000); // same phone reconnected: keep the newest
          dev = { conn, info: { model: msg.model, android: msg.android, sdk: msg.sdk, app: msg.app }, pending: new Map(), connectedAt: new Date().toISOString(), name };
          devices.set(name, dev);
          log(`relay: phone "${name}" connected (${msg.model || "?"}, Android ${msg.android || "?"})`);
          return;
        }
        if (dev && msg.id && dev.pending.has(msg.id)) {
          const p = dev.pending.get(msg.id);
          dev.pending.delete(msg.id);
          clearTimeout(p.timer);
          p.resolve(msg.ok === false ? { ok: false, error: msg.error || "phone error" } : { ok: true, result: msg.result ?? null });
        }
      },
      onClose() {
        if (!dev) return;
        for (const p of dev.pending.values()) {
          clearTimeout(p.timer);
          p.reject(Object.assign(new Error("phone disconnected mid-command"), { status: 503 }));
        }
        dev.pending.clear();
        if (devices.get(dev.name) === dev) devices.delete(dev.name);
        log(`relay: phone "${dev.name}" disconnected`);
      },
    }, head);
    if (!conn) return;
  });

  // Keep NAT mappings warm on 4G and reap phones that silently vanished.
  const heartbeat = setInterval(() => {
    for (const d of devices.values()) {
      if (Date.now() - d.conn.lastSeen > DEAD_MS) d.conn.close(1001);
      else d.conn.ping();
    }
  }, PING_MS);
  heartbeat.unref?.();

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve({
        server,
        devices,
        port: server.address().port,
        close: () =>
          new Promise((r) => {
            clearInterval(heartbeat);
            for (const d of devices.values()) d.conn.close(1001);
            server.close(() => r());
          }),
      });
    });
  });
}
