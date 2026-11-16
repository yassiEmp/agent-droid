# agent-droid

**An `agent-browser` for Android.** Drive a real device or emulator over `adb`
with a tight **snapshot → ref → act** loop: snapshot the on-screen accessibility
tree into ref-tagged interactive elements, then tap/type/swipe by ref — or by
visible text. Built to be driven by AI agents (machine-readable `--json`, single
self-contained commands) and pleasant for humans too.

```bash
agent-droid snapshot
# @e5 [input]  "you@example.com" (720,2180)
# @e6 [input]  "********" [password] (720,2426)
# @e7 [button] "Sign In" (720,2612)

agent-droid type @e5 "you@example.com"
agent-droid type @e6 "hunter2"
agent-droid tap  "Sign In"          # target by visible text — no ref lookup needed
```

## Why

Raw `adb shell input tap X Y` is brittle: you eyeball pixels off a scaled
screenshot, and the tap misses the moment the soft keyboard or a re-layout moves
things. `agent-droid` instead resolves every action against the live view
hierarchy and **re-finds the target by node identity** (class / content-desc /
text) right before acting — so taps survive layout shifts. Two more things make
it agent-friendly:

- **Animation-proof snapshots.** Plain `uiautomator dump` waits for the UI to go
  *idle* and fails with `could not get idle state` on any screen with a
  continuous animation (common in React Native / Reanimated / game loops).
  `agent-droid setup` installs a tiny on-device UiAutomator instrumentation that
  dumps with the idle-wait disabled, so snapshots work mid-animation. It emits
  the identical XML schema, so nothing else changes.
- **One call, not four.** `tap "Sign In"` resolves visible text against a fresh
  snapshot and taps it — no snapshot → read → pick-ref → tap round-trip. `--json`
  gives exact, parseable output. `--then` (opt-in) echoes the next screen.

## Requirements

- **Node.js ≥ 18**
- **`adb`** on your `PATH` (Android Platform Tools), with a device/emulator
  connected (`adb devices` shows it as `device`).
- For the animation-proof dumper: nothing to build — prebuilt APKs are bundled
  and installed by `agent-droid setup`. (To rebuild them yourself you need a JDK
  17 + Android SDK; see [MAINTAINING.md](./MAINTAINING.md).)

Works on macOS, Linux, and Windows. The driver is **app-agnostic** — it dumps
whatever app is in the foreground.

## Install

```bash
npm install -g agent-droid      # provides `agent-droid` and the short alias `droid`
agent-droid setup               # one-time per device: installs the dumper
agent-droid doctor              # sanity check: device, foreground app, dumper status
```

Or run without installing:

```bash
npx agent-droid doctor
```

## Remote mode: Wi-Fi or 4G, no cable

Same commands, phone anywhere. Install the small **agent-droid Link** app on the
phone (it dials out to your relay, so it works on 4G and survives reboots), run
`agent-droid relay` on any always-on box, then:

```bash
agent-droid --remote https://<relay> --token "$T" snapshot
agent-droid --remote https://<relay> --token "$T" tap "Sign In"
agent-droid --remote adb://100.x.y.z:5555 logs      # fallback: adb over Tailscale
```

Setup takes about 2 minutes on the phone with no computer. See **[REMOTE.md](./REMOTE.md)**.

## The loop

1. `agent-droid snapshot` — print the interactive elements as `@eN` refs.
2. Act on one: `tap @e7`, `type @e5 "…"`, `key ENTER`, `swipe up`.
3. `agent-droid snapshot` **again** after every screen change — refs are
   per-snapshot.
4. Verify with `wait "text"` (blocks until it appears) or `logs`.

## Commands

| Command | Purpose |
|---|---|
| `doctor` | Devices + foreground app + dumper status. Never throws. |
| `setup` | One-time per device: install the animation-proof dumper. |
| `snapshot [query]` | Dump the tree as `@eN` refs; `query` filters by name substring. |
| `tap <@eN \| "text" \| X Y>` | Tap a ref, a visible-text match, or raw coordinates. |
| `type <@eN \| "text"> "value"` | Focus the target, **clear it**, then type. |
| `key <NAME\|code>` | Keyevent: `BACK ENTER TAB HOME DEL SEARCH ESCAPE` or a raw keycode. |
| `swipe <up\|down\|left\|right>` | Scroll/swipe gesture. |
| `wait "text" [ms]` | Poll until text appears (default 8000ms). |
| `current` | Foreground `package/activity`. |
| `logs [filter] [tail]` | Tail app logcat. `--tag <T>` (default `ReactNativeJS`; `'*'` = all). |
| `screenshot [file]` | Save a PNG (default `droid-shot.png`). |
| `open <package\|url>` | Launch an app, or open a URL / deep link. |
| `wake` | Turn the screen on. |
| `devices` | List devices (in remote link mode: connected phones). |
| `relay` | Run the remote-mode relay ([REMOTE.md](./REMOTE.md)). |
| `pair` / `tcpip` | adb wireless pairing / network mode for remote adb. |
| `--help` | Full reference. |

### Targeting: refs vs. text

`@eN` refs are the **primary, exact** handles — they carry node identity and
survive layout shifts. Visible-`"text"` targeting is a **convenience addon**: it
resolves against a fresh snapshot in one call (picking the most specific match
when several share the text). Reach for a ref when the text is ambiguous or
duplicated.

### Flags

- `--serial <id>` — target a specific device (default: first online).
- `--remote <url>` — remote mode: `https://relay` (Link app) or `adb://ip:5555`.
  Or set `AGENT_DROID_REMOTE` (and `AGENT_DROID_TOKEN`) once.
- `--token <T>` — the relay token for link mode.
- `--tag <T>` — logcat tag for `logs` (default `ReactNativeJS`; `'*'` for all).
- `--json` — machine-readable output (no human text); ideal for agents.
- `--then` — **off by default.** After an action, re-snapshot and print the new
  screen. Opt in only when you want the result echoed — it adds a full snapshot
  to the output.

## Example: machine-readable, one call per step

```bash
agent-droid tap "Sign In" --json
# {"action":"tap","ref":"e7","name":"Sign In","cx":720,"cy":2612,"stale":false}

agent-droid snapshot --json | node -e 'JSON.parse(require("fs").readFileSync(0)).forEach(r=>console.log(r.ref,r.name))'
```

## Limitations

- **iOS is not supported** — `adb` is Android-only.
- **Remote link mode:** no `logs` or raw keycodes (use remote adb for those);
  screenshots need Android 11+; a PIN/pattern lock stays the human's job.
- **Soft-keyboard occlusion:** when the IME covers a field, the dump may return
  only the keyboard window; `type` then falls back to cached coordinates. Dismiss
  the keyboard or scroll the field into view if a `type` doesn't land.
- `logs` defaults to the `ReactNativeJS` tag (handy for RN apps). For other apps
  pass `--tag <YourTag>` or `--tag '*'`.

## How the animation-proof dumper works (short version)

`agent-droid setup` installs two tiny APKs: an empty host app and a UiAutomator
instrumentation test. The test sets `Configurator.setWaitForIdleTimeout(0)` and
calls `dumpWindowHierarchy(...)`, returning the XML through an `am instrument`
status Bundle (the one transport that works on every device — file writes are
blocked by scoped storage, and test stdout isn't forwarded). `UiAutomation` reads
the whole screen system-wide, so it dumps **any** foreground app. Full rationale,
build steps, and the debugging guide are in [MAINTAINING.md](./MAINTAINING.md).

## License

[MIT](./LICENSE)
