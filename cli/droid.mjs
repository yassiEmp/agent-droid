#!/usr/bin/env node
// agent-droid — agent-friendly Android driver (an `agent-browser` for adb).
//
// Loop: `snapshot` to see ref-tagged interactive elements, then act on refs.
// Every act re-resolves the ref's live bounds, so taps survive layout shifts.
//
//   agent-droid snapshot
//   agent-droid tap @e3
//   agent-droid type @e3 "you@example.com"
//   agent-droid key ENTER
//   agent-droid wait "Sign In"
//
// Optional: --serial <id> to target a specific device (default: first online).
// Remote: --remote http://<relay>:8790 (Link app, Wi-Fi + 4G) or
//         --remote adb://<phone-ip>:5555 (adb over the network, e.g. Tailscale).

import {
  pickDevice,
  snapshot,
  targetFor,
  tap,
  clearFocused,
  typeText,
  key,
  swipe,
  currentFocus,
  screenshot,
  waitFor,
  devicesList,
  readLogs,
  hasDumper,
  installDumper,
  useLink,
  isLink,
  openTarget,
  wake,
  deviceInfo,
} from "./lib.mjs";
import { parseRemote, makeLink, connectAdb, pairAdb, enableTcpip } from "./remote.mjs";
import { startRelay, resolveToken, localAddresses, linkUri, DEFAULT_PORT } from "./relay.mjs";

function parseArgs(argv) {
  const args = [];
  let serial;
  let tag; // --tag: logcat tag for `logs` (default ReactNativeJS)
  let json = false; // --json: machine-readable output for agents
  let then = false; // --then: re-snapshot after an action and print the result
  let remote = process.env.AGENT_DROID_REMOTE; // --remote: relay URL or adb://host:port
  let token; // --token: relay token (else AGENT_DROID_TOKEN)
  let port; // --port: relay listen port
  let host; // --host: relay bind address
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--serial") serial = argv[++i];
    else if (argv[i] === "--remote") remote = argv[++i];
    else if (argv[i] === "--local") remote = undefined;
    else if (argv[i] === "--token") token = argv[++i];
    else if (argv[i] === "--port") port = Number(argv[++i]);
    else if (argv[i] === "--host") host = argv[++i];
    else if (argv[i] === "--tag") tag = argv[++i];
    else if (argv[i] === "--json") json = true;
    else if (argv[i] === "--then") then = true;
    else args.push(argv[i]);
  }
  return { serial, tag, json, then, remote, token, port, host, cmd: args[0], rest: args.slice(1) };
}

const MAX_NAME = 60; // keep snapshot lines token-cheap on busy screens
const trim = (s) => (s && s.length > MAX_NAME ? s.slice(0, MAX_NAME - 1) + "…" : s || "");

// One JSON object/array per command, so agents never regex-parse human text.
function emit(json, human, data) {
  if (json) console.log(JSON.stringify(data));
  else if (human !== undefined) console.log(human);
}

function refToJson(r) {
  return { ref: r.ref, type: r.type, name: r.name || "", cx: r.cx, cy: r.cy, password: !!r.sig.password };
}

function printRefs(refs, json) {
  if (json) return console.log(JSON.stringify(refs.map(refToJson)));
  if (refs.length === 0) return console.log("(no interactive elements found)");
  for (const r of refs) {
    const name = r.name ? ` "${trim(r.name)}"` : "";
    const pw = r.sig.password ? " [password]" : "";
    console.log(`@${r.ref} [${r.type}]${name}${pw} (${r.cx},${r.cy})`);
  }
}

const HELP = `agent-droid — agent-friendly Android driver (an \`agent-browser\` for adb).

Loop: snapshot to see ref-tagged elements, then act on @eN refs. Every act
re-resolves the ref's live bounds, so taps survive layout shifts. Prefer this
over raw adb taps — refs carry node identity, so they don't miss when the soft
keyboard or a reflow moves things.

USAGE
  agent-droid <command> [args] [--serial <id>] [--json] [--then]
  (installed globally via \`npm i -g agent-droid\`; \`droid\` is a short alias.)

WORKFLOW
  1. agent-droid setup          # ONCE per device: installs the animation-proof dumper.
  2. agent-droid snapshot       # prints the interactive elements as @eN refs, e.g.:
                                #   @e5 [input]  "you@example.com" (720,2180)
                                #   @e6 [input]  "********" [password] (720,2426)
                                #   @e7 [button] "Sign In" (720,2612)
  3. act on a ref               # tap @e7  /  type @e5 "..."  /  key ENTER
  4. snapshot AGAIN             # re-snapshot after every screen change — refs are per-snapshot
  Verify with: \`wait "text"\` (blocks until it appears) or \`logs\` (app log output).
  Jump screens without tapping via deep link:
    adb shell am start -a android.intent.action.VIEW -d "<scheme>://<route>" <package>
  If snapshot fails on an animating screen, run \`agent-droid setup\`; else fall back
  to \`screenshot\` + coordinate taps (\`tap X Y\`) and \`logs\`.

COMMANDS
  doctor                 List devices, foreground app, and dumper status. Never throws.
  setup                  One-time per device: install the animation-proof dumper.
  snapshot [query]       Dump the accessibility tree as @eN refs; [query] filters by name substring.
  tap <@eN | "text" | X Y>   Tap a ref, a visible-text match, or raw coordinates.
  type <@eN | "text"> "value"  Focus the target (ref or text), clear it, then type.
  key <NAME|code>        Keyevent: BACK ENTER TAB HOME DEL SEARCH ESCAPE (or a raw keycode).
  swipe <up|down|left|right>   Scroll/swipe gesture.
  wait "text" [ms]       Poll the tree until text appears (default 8000ms).
  current                Print foreground package/activity.
  logs [filter] [tail]   Tail app logcat (default tag ReactNativeJS; --tag <T> or --tag '*').
  screenshot [file]      Save a PNG (default droid-shot.png).
  open <package|url>     Launch an app by package name, or open a URL / deep link.
  wake                   Turn the screen on (can't unlock a PIN — that needs the human).
  help, --help, -h       Show this help.

REMOTE MODE (same commands, phone anywhere: Wi-Fi or 4G, no cable)
  relay [--port 8790] [--host 0.0.0.0] [--token T]
                         Run the relay on an always-on box the phone can reach
                         (Tailscale IP, LAN, or HTTPS proxy). Prints the token and
                         a setup link to open on the phone.
  link-url <relay-url>   Print the phone setup link for a relay (needs --token).
  pair <ip:port> <code>  adb wireless-debugging pairing (Android 11+).
  tcpip [port]           Put adb in network mode on port 5555 (reachable over Tailscale
                         on 4G too; resets on reboot).

  Link app (recommended):  --remote http://<relay-host>:8790 --token <T>
  Remote adb (fallback):   --remote adb://<phone-tailscale-ip>:5555
  Or set AGENT_DROID_REMOTE / AGENT_DROID_TOKEN once. In link mode \`logs\` and
  raw keycodes need adb; everything else works, and \`type\` accepts any Unicode.

TARGETING
  @eN are the primary, exact handles (survive layout shifts via identity).
  "text" is a convenience addon: resolves against a fresh snapshot by visible
  name — one call, no snapshot→read→pick→tap round-trip. Use a ref when text is
  ambiguous or duplicated.

FLAGS
  --serial <id>          Target a specific device (default: first online device). In link
                         mode this is the phone's name (\`devices\` lists them).
  --remote <url>         Remote mode: http(s)://relay:8790 (Link app) or adb://ip:5555.
  --token <T>            Relay token for link mode (or AGENT_DROID_TOKEN).
  --local                Ignore AGENT_DROID_REMOTE for this call.
  --tag <T>              logcat tag for \`logs\` (default ReactNativeJS; '*' = all).
  --json                 Machine-readable output (no human text) — for agents.
  --then                 OFF by default. After an action, re-snapshot and print the
                         new screen's refs. Opt in only when you want the result
                         echoed — it adds a full snapshot to the output.

EXAMPLES
  agent-droid setup
  agent-droid snapshot
  agent-droid type @e5 "you@example.com"
  agent-droid tap "Sign In"
  agent-droid wait "Sign In"

Maintainer/debug guide: see MAINTAINING.md in the repo.`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { tag, json, then, cmd, rest } = opts;
  let explicit = opts.serial;

  if (cmd === "help" || cmd === "--help" || cmd === "-h" || !cmd) {
    console.log(HELP);
    return;
  }

  // ── commands that don't drive a phone ──────────────────────────────────────
  if (cmd === "relay") {
    const token = resolveToken(opts.token);
    const relay = await startRelay({ port: opts.port || DEFAULT_PORT, host: opts.host || "0.0.0.0", token });
    const addrs = localAddresses();
    const base = (a) => `http://${a}:${relay.port}`;
    if (json) {
      console.log(JSON.stringify({ action: "relay", port: relay.port, token, addresses: addrs }));
    } else {
      console.log(`agent-droid relay listening on :${relay.port}`);
      console.log(`token: ${token}`);
      for (const a of addrs) {
        console.log(`\n${a.tailscale ? "Tailscale" : a.ifname} ${a.address}`);
        console.log(`  agents:  agent-droid --remote ${base(a.address)} --token <token> snapshot`);
        console.log(`  phone:   open ${base(a.address)}/setup?token=${encodeURIComponent(token)}`);
      }
      console.log("\nBehind an HTTPS proxy? Open https://<your-domain>/setup?token=<token> on the phone instead.");
      console.log("Ctrl-C to stop.");
    }
    const stop = async () => {
      await relay.close();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return new Promise(() => {}); // run until killed
  }

  if (cmd === "link-url") {
    const r = parseRemote(rest[0] || opts.remote);
    if (!r || r.kind !== "link") throw new Error("usage: agent-droid link-url http://<relay-host>:8790 --token <T>");
    const token = opts.token || process.env.AGENT_DROID_TOKEN;
    if (!token) throw new Error("link-url needs --token <T> (printed by `agent-droid relay`).");
    const ws = r.url.replace(/^http/i, "ws") + "/link";
    const uri = linkUri(ws, token, rest[1]);
    const page = `${r.url}/setup?token=${encodeURIComponent(token)}`;
    emit(json, `open on the phone: ${page}\nor the raw link: ${uri}`, { action: "link-url", page, uri });
    return;
  }

  if (cmd === "pair") {
    if (!rest[0] || !rest[1]) throw new Error("usage: agent-droid pair <phone-ip>:<pairing-port> <6-digit-code>");
    const out = pairAdb(rest[0], rest[1]);
    emit(json, out, { action: "pair", ok: true, output: out });
    return;
  }

  // ── pick the transport ─────────────────────────────────────────────────────
  const remote = parseRemote(opts.remote);
  if (remote?.kind === "link") {
    useLink(makeLink(remote.url, opts.token || process.env.AGENT_DROID_TOKEN));
  } else if (remote?.kind === "adb") {
    explicit = connectAdb(remote.host, remote.port);
  }

  if (cmd === "devices") {
    const out = await devicesList();
    emit(json, out, { action: "devices", output: out });
    return;
  }

  if (cmd === "doctor") {
    try {
      const s = await pickDevice(explicit);
      const dumper = await hasDumper(s);
      const foreground = await currentFocus(s);
      let info = null;
      try {
        info = await deviceInfo(s);
      } catch {
        /* info is a bonus */
      }
      const transport = isLink() ? "link" : remote?.kind === "adb" ? "remote-adb" : "adb";
      if (json) {
        console.log(JSON.stringify({ ready: true, serial: s, transport, foreground, dumper, info }));
      } else {
        console.log(await devicesList());
        const d = isLink() ? "not needed (Link app)" : dumper ? "installed" : "missing (run `agent-droid setup`)";
        const about = info ? ` — ${info.model || "?"}, Android ${info.android || "?"}` : "";
        console.log(`agent-droid: ready on ${s} [${transport}]${about} — foreground ${foreground} — dumper ${d}`);
        if (info && info.locked) console.log("note: the screen is locked — unlock it on the phone before acting.");
      }
    } catch (e) {
      emit(json, `agent-droid: no device — ${e.message}`, { ready: false, error: e.message });
    }
    return;
  }

  if (cmd === "tcpip") {
    if (isLink()) throw new Error("`tcpip` is an adb command; run it with a local or adb:// device.");
    const s = await pickDevice(explicit);
    const out = enableTcpip(s, rest[0] ? Number(rest[0]) : 5555);
    emit(json, `${out}\nNow reachable as adb://<phone-tailscale-ip>:${rest[0] || 5555} until the phone reboots.`, {
      action: "tcpip",
      port: Number(rest[0] || 5555),
      output: out,
    });
    return;
  }

  if (cmd === "setup") {
    const serial = await pickDevice(explicit);
    if (isLink()) {
      emit(json, "agent-droid: nothing to install in link mode — the Link app reads the screen itself.", {
        action: "setup",
        dumperInstalled: true,
      });
      return;
    }
    const ok = await installDumper(serial);
    emit(
      json,
      ok
        ? "agent-droid: animation-proof dumper installed — snapshot works on animating screens."
        : "agent-droid: dumper install reported failure (check `adb install` output).",
      { action: "setup", dumperInstalled: ok },
    );
    return;
  }

  const serial = await pickDevice(explicit);

  // --then: re-snapshot after an action so the agent sees the result without a
  // second call. Skipped silently if the new screen is mid-animation.
  const afterAct = async () => {
    if (!then) return;
    try {
      const refs = await snapshot(serial);
      if (json) console.log(JSON.stringify({ then: refs.map(refToJson) }));
      else printRefs(refs, false);
    } catch {
      /* animating screen — nothing to echo */
    }
  };

  switch (cmd) {
    case "snapshot": {
      try {
        let refs = await snapshot(serial);
        if (rest[0]) {
          const q = rest[0].toLowerCase();
          refs = refs.filter((r) => (r.name || "").toLowerCase().includes(q));
        }
        printRefs(refs, json);
      } catch (e) {
        // Even the animation-proof dumper failed (or couldn't be installed).
        emit(json, undefined, { error: e.message, code: e.code || null, hint: "screenshot + tap X Y, or logs" });
        if (!json) {
          console.log(`snapshot unavailable: ${e.message}`);
          console.log("→ try `agent-droid setup`; else use `screenshot` + coordinate taps");
          console.log("  (`tap X Y`), and `logs` to confirm effects.");
        }
        process.exitCode = 1;
      }
      break;
    }
    case "logs": {
      const out = await readLogs(serial, { tag, filter: rest[0], tail: rest[1] ? Number(rest[1]) : undefined });
      if (json) console.log(JSON.stringify({ action: "logs", lines: out ? out.split("\n") : [] }));
      else console.log(out);
      break;
    }
    case "tap": {
      const t = await targetFor(serial, rest);
      await tap(serial, t);
      const label = t.ref ? `@${t.ref}${t.name ? ` "${trim(t.name)}"` : ""} ` : "";
      emit(json, `tapped ${label}(${t.cx},${t.cy})${t.stale ? " [stale: used cached coords]" : ""}`, {
        action: "tap",
        ref: t.ref || null,
        name: t.name || null,
        cx: t.cx,
        cy: t.cy,
        stale: !!t.stale,
      });
      await afterAct();
      break;
    }
    case "type": {
      const target = rest[0];
      const text = rest.slice(1).join(" ");
      const t = await targetFor(serial, [target]);
      await tap(serial, t); // focus
      await new Promise((r) => setTimeout(r, 400));
      await clearFocused(serial);
      await typeText(serial, text);
      const into = t.ref ? `@${t.ref}` : `"${trim(t.name || target)}"`;
      emit(json, `typed into ${into}: ${text}`, {
        action: "type",
        ref: t.ref || null,
        name: t.name || null,
        text,
      });
      await afterAct();
      break;
    }
    case "key": {
      await key(serial, rest[0]);
      emit(json, `key ${rest[0]}`, { action: "key", key: rest[0] });
      await afterAct();
      break;
    }
    case "swipe": {
      await swipe(serial, rest[0]);
      emit(json, `swipe ${rest[0]}`, { action: "swipe", dir: rest[0] });
      await afterAct();
      break;
    }
    case "wait": {
      const ok = await waitFor(serial, rest[0], rest[1] ? Number(rest[1]) : undefined);
      emit(json, ok ? `found "${rest[0]}"` : `TIMEOUT waiting for "${rest[0]}"`, {
        action: "wait",
        text: rest[0],
        found: ok,
      });
      if (!ok) process.exitCode = 1;
      break;
    }
    case "current": {
      const focus = await currentFocus(serial);
      emit(json, focus, { action: "current", foreground: focus });
      break;
    }
    case "screenshot": {
      const file = await screenshot(serial, rest[0] || "droid-shot.png");
      emit(json, file, { action: "screenshot", file });
      break;
    }
    case "open": {
      if (!rest[0]) throw new Error("usage: agent-droid open <package|url>");
      await openTarget(serial, rest.join(" "));
      emit(json, `opened ${rest.join(" ")}`, { action: "open", target: rest.join(" ") });
      await afterAct();
      break;
    }
    case "wake": {
      await wake(serial);
      emit(json, "screen on", { action: "wake" });
      break;
    }
    default:
      console.log(`unknown command "${cmd}". Run \`agent-droid --help\` for the command list.`);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`agent-droid error: ${e.message}`);
  process.exitCode = 1;
});
