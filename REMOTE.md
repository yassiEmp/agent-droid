# Remote mode: drive a phone from anywhere, no cable

`agent-droid` normally talks to a phone plugged into the same computer. Remote
mode lets an agent on a server, in the cloud, or on another machine drive a
phone that is **anywhere**, on Wi-Fi or on 4G/5G, with the **same commands**.

```bash
agent-droid --remote https://relay.example.com --token "$T" snapshot
agent-droid --remote https://relay.example.com --token "$T" tap "Sign In"
# or once:  export AGENT_DROID_REMOTE=https://relay.example.com AGENT_DROID_TOKEN=$T
```

There are two transports. Use the Link app; keep remote adb as the fallback.

| | **Link app** (recommended) | **Remote adb** (fallback) |
|---|---|---|
| Works on 4G | ✅ phone dials out, so carrier NAT doesn't matter | ✅ only via a VPN like Tailscale |
| Survives a reboot | ✅ Android restarts the service by itself | ❌ adb's network mode turns off on reboot |
| Needs a computer once | ❌ no: install the APK from the phone | ✅ yes, or another adb host, to pair |
| `snapshot`, `tap`, `type`, `swipe`, `key`, `wait`, `current`, `screenshot`, `open`, `wake` | ✅ (`screenshot` needs Android 11+) | ✅ |
| Typing accents and emoji | ✅ any Unicode | ❌ ASCII only (`adb input text`) |
| `logs`, raw keycodes | ❌ (Android only lets adb read logcat) | ✅ |

## How the Link transport works

```
 phone: agent-droid Link app ──(outbound WebSocket, wss/ws)──▶  agent-droid relay  ◀──(HTTP)── agent-droid --remote …
        AccessibilityService                                     (any always-on box)          (your agent)
```

- The **Link app** is a small accessibility service. Accessibility is the
  Android API that screen readers use: it can read the screen's element tree,
  perform taps and swipes (`dispatchGesture`), set text in fields, press
  Back/Home, and on Android 11+ take screenshots, all **without root, adb or a
  computer**. Android keeps an enabled accessibility service running and
  restarts it after a reboot.
- The app **dials out** to the relay and keeps a WebSocket open (15 s pings), so
  it works behind 4G carrier NAT and switches between Wi-Fi and 4G on its own.
- The **relay** (`agent-droid relay`, zero dependencies) forwards each CLI command
  to the phone and returns the answer. The phone emits the **same XML schema as
  `uiautomator dump`**, so refs, text targeting and the identity-based re-resolution
  behave exactly as they do locally.
- Everything is gated by one random token. Only your relay can drive the phone,
  and turning off the accessibility service or tapping **Pause** stops it at once.

## Setup (once)

### 1. Run the relay on an always-on machine

```bash
npx agent-droid relay            # prints a token and a setup link per network address
# --port 8790 (default)  --host 0.0.0.0  --token <T> (else AGENT_DROID_TOKEN, else saved in ~/.agent-droid/relay.json)
```

The phone must be able to reach it. Pick one:

- **Public HTTPS** (simplest, no VPN on the phone): put the relay behind any
  HTTPS reverse proxy or tunnel (Caddy, Cloudflare Tunnel, a PaaS port). The
  phone uses `wss://`. The relay sees `X-Forwarded-Proto` and builds the right link.
- **Tailscale**: install Tailscale on the relay box and the phone, then use
  `http://<box-tailscale-ip>:8790`. Tailscale already encrypts the traffic.
- **Same Wi-Fi only**: the box's LAN IP.

A systemd unit:

```ini
[Service]
Environment=AGENT_DROID_TOKEN=<long random token>
ExecStart=/usr/bin/env npx -y agent-droid relay --port 8790
Restart=always
```

### 2. Set up the phone (about 2 minutes, all on the phone)

1. **Install agent-droid Link**: open
   `https://github.com/yassiEmp/agent-droid/releases/download/link-latest/agent-droid-link.apk`
   in Chrome, tap **Download**, then **Open**. Allow "Install unknown apps" for
   Chrome when Android asks.
2. Open **agent-droid Link** and tap **1. Turn on agent-droid Link in Accessibility**.
   - Samsung: *Installed apps* (or *Installed services*) › **agent-droid Link** › On › **Allow**.
   - Android 13+: if the switch is greyed out, go back to the app, tap the yellow
     note to open App info, then **⋮ › Allow restricted settings**, and try again.
3. Tap **2. Let it run in the background** › **Allow** (battery: unrestricted).
   Samsung: also *Settings › Battery › Background usage limits* and make sure
   agent-droid Link is **not** in "Sleeping apps".
4. On the phone, open the relay's setup page,
   `https://<relay>/setup?token=<token>` (the relay prints it), and tap
   **Open in agent-droid Link**. The URL and token fill in by themselves and the
   status turns green: **Connected**.

Check from the agent side:

```bash
agent-droid --remote https://<relay> --token "$T" doctor
# agent-droid: ready on link:sm-g975u [link] — samsung SM-G975U, Android 12 — foreground …
```

### Several phones

Each phone connects with its own name (shown in the app, editable). Pick one
with `--serial <name>`; `agent-droid devices` lists them.

## Remote adb (fallback, Android 11+)

Full adb (logs, `setup`, raw keycodes) over the network. It needs an adb host
that can reach the phone. With Tailscale on both, Wi-Fi and 4G both work:

```bash
# On the phone: Settings › Developer options › Wireless debugging › On
#   › "Pair device with pairing code" shows IP:PORT and a 6-digit code.
agent-droid pair 100.x.y.z:41234 123456            # the phone's Tailscale IP + pairing port
adb connect 100.x.y.z:<port shown on the Wireless debugging screen>
agent-droid --serial 100.x.y.z:<port> tcpip 5555   # fixed port, listens on every network
agent-droid --remote adb://100.x.y.z:5555 doctor   # from now on, on Wi-Fi or 4G
```

`tcpip` mode lasts until the phone reboots; then pair again.

## What stays with the human

- **PIN, pattern, fingerprint, Face Unlock**: the agent can `wake` the screen
  and swipe, but never unlocks a secure lock screen. Keep the phone unlocked
  while it works, or use *Settings › Lock screen › Smart Lock*.
- Payment and password prompts that block accessibility (`FLAG_SECURE` screens
  show up black in screenshots).
- Turning remote control off: **Pause** in the app, or switch off the service.

## Troubleshooting

| Symptom | Fix |
|---|---|
| App says "Can't reach the relay" | Wrong URL, relay down, or (Tailscale) VPN off on the phone. `curl https://<relay>/health`. |
| App says "Wrong token" | Open the relay's setup link again. |
| `No phone connected to the relay` | Open the app: is it **Connected**? If it says Off, the accessibility service was switched off (Samsung does this after some updates). |
| Disconnects when the screen is off | Battery is not unrestricted / app is a "Sleeping app" on Samsung. |
| `snapshot` returns an empty screen | Locked or the screen is off: `agent-droid wake`, then unlock. |
| `type` says no field is focused | `tap` the field first (`type @eN "…"` does this for you). |
| `screenshot` fails on Android 10 or older | Link screenshots need Android 11+; use remote adb there. |
