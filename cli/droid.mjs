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
} from "./lib.mjs";

function parseArgs(argv) {
  const args = [];
  let serial;
  let tag; // --tag: logcat tag for `logs` (default ReactNativeJS)
  let json = false; // --json: machine-readable output for agents
  let then = false; // --then: re-snapshot after an action and print the result
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--serial") serial = argv[++i];
    else if (argv[i] === "--tag") tag = argv[++i];
    else if (argv[i] === "--json") json = true;
    else if (argv[i] === "--then") then = true;
    else args.push(argv[i]);
  }
  return { serial, tag, json, then, cmd: args[0], rest: args.slice(1) };
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
  help, --help, -h       Show this help.

TARGETING
  @eN are the primary, exact handles (survive layout shifts via identity).
  "text" is a convenience addon: resolves against a fresh snapshot by visible
  name — one call, no snapshot→read→pick→tap round-trip. Use a ref when text is
  ambiguous or duplicated.

FLAGS
  --serial <id>          Target a specific device (default: first online device).
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
  const { serial: explicit, tag, json, then, cmd, rest } = parseArgs(process.argv.slice(2));

  if (cmd === "help" || cmd === "--help" || cmd === "-h" || !cmd) {
    console.log(HELP);
    return;
  }

  if (cmd === "doctor") {
    try {
      const s = pickDevice(explicit);
      const dumper = hasDumper(s);
      if (json) {
        console.log(JSON.stringify({ ready: true, serial: s, foreground: currentFocus(s), dumper }));
      } else {
        console.log(devicesList());
        const d = dumper ? "installed" : "missing (run `agent-droid setup`)";
        console.log(`agent-droid: ready on ${s} — foreground ${currentFocus(s)} — dumper ${d}`);
      }
    } catch (e) {
      emit(json, `agent-droid: no device — ${e.message}`, { ready: false, error: e.message });
    }
    return;
  }

  if (cmd === "setup") {
    const serial = pickDevice(explicit);
    const ok = installDumper(serial);
    emit(
      json,
      ok
        ? "agent-droid: animation-proof dumper installed — snapshot works on animating screens."
        : "agent-droid: dumper install reported failure (check `adb install` output).",
      { action: "setup", dumperInstalled: ok },
    );
    return;
  }

  const serial = pickDevice(explicit);

  // --then: re-snapshot after an action so the agent sees the result without a
  // second call. Skipped silently if the new screen is mid-animation.
  const afterAct = () => {
    if (!then) return;
    try {
      const refs = snapshot(serial);
      if (json) console.log(JSON.stringify({ then: refs.map(refToJson) }));
      else printRefs(refs, false);
    } catch {
      /* animating screen — nothing to echo */
    }
  };

  switch (cmd) {
    case "snapshot": {
      try {
        let refs = snapshot(serial);
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
      const out = readLogs(serial, { tag, filter: rest[0], tail: rest[1] ? Number(rest[1]) : undefined });
      if (json) console.log(JSON.stringify({ action: "logs", lines: out ? out.split("\n") : [] }));
      else console.log(out);
      break;
    }
    case "tap": {
      const t = targetFor(serial, rest);
      tap(serial, t);
      const label = t.ref ? `@${t.ref}${t.name ? ` "${trim(t.name)}"` : ""} ` : "";
      emit(json, `tapped ${label}(${t.cx},${t.cy})${t.stale ? " [stale: used cached coords]" : ""}`, {
        action: "tap",
        ref: t.ref || null,
        name: t.name || null,
        cx: t.cx,
        cy: t.cy,
        stale: !!t.stale,
      });
      afterAct();
      break;
    }
    case "type": {
      const target = rest[0];
      const text = rest.slice(1).join(" ");
      const t = targetFor(serial, [target]);
      tap(serial, t); // focus
      await new Promise((r) => setTimeout(r, 400));
      clearFocused(serial);
      typeText(serial, text);
      const into = t.ref ? `@${t.ref}` : `"${trim(t.name || target)}"`;
      emit(json, `typed into ${into}: ${text}`, {
        action: "type",
        ref: t.ref || null,
        name: t.name || null,
        text,
      });
      afterAct();
      break;
    }
    case "key": {
      key(serial, rest[0]);
      emit(json, `key ${rest[0]}`, { action: "key", key: rest[0] });
      afterAct();
      break;
    }
    case "swipe": {
      swipe(serial, rest[0]);
      emit(json, `swipe ${rest[0]}`, { action: "swipe", dir: rest[0] });
      afterAct();
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
      const focus = currentFocus(serial);
      emit(json, focus, { action: "current", foreground: focus });
      break;
    }
    case "screenshot": {
      const file = screenshot(serial, rest[0] || "droid-shot.png");
      emit(json, file, { action: "screenshot", file });
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
