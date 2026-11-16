#!/usr/bin/env bash
# Real-device-style end-to-end for both remote transports, run in CI against an
# Android emulator. The phone side is the real agent-droid Link APK; the agent
# side is the real CLI talking to a real relay. Nothing is mocked.
#
#   bash test/e2e-emulator.sh path/to/agent-droid-link.apk
set -euo pipefail
APK="${1:?apk path}"
cd "$(dirname "$0")/.."
DROID="node cli/droid.mjs"
TOKEN="e2e-$(date +%s)-$RANDOM"
PORT=8790
OUT="$(mktemp -d)"
fail() { echo "E2E FAIL: $*"; echo "--- relay log"; cat "$OUT/relay.log" || true; adb logcat -d -s agent-droid-link:* AndroidRuntime:E | tail -60 || true; exit 1; }
step() { echo; echo "== $*"; }

step "relay"
AGENT_DROID_TOKEN="$TOKEN" node cli/droid.mjs relay --port $PORT > "$OUT/relay.log" 2>&1 &
RELAY_PID=$!
trap 'kill $RELAY_PID 2>/dev/null || true' EXIT
for i in $(seq 1 20); do curl -fs "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.5; done
curl -fs "http://127.0.0.1:$PORT/health" || fail "relay did not start"

step "install Link + enable its accessibility service (what the human does by hand once)"
adb install -r -g "$APK"
adb shell settings put secure enabled_accessibility_services dev.agentdroid.link/dev.agentdroid.link.LinkService
adb shell settings put secure accessibility_enabled 1
adb shell dumpsys deviceidle whitelist +dev.agentdroid.link >/dev/null || true

step "open the setup deep link (10.0.2.2 = the CI host from inside the emulator)"
adb shell "am start -a android.intent.action.VIEW -d 'agentdroid://link?url=ws%3A%2F%2F10.0.2.2%3A$PORT%2Flink&token=$TOKEN&name=emu'"

export AGENT_DROID_REMOTE="http://127.0.0.1:$PORT" AGENT_DROID_TOKEN="$TOKEN"
for i in $(seq 1 40); do
  $DROID devices | grep -q "link:emu" && break
  sleep 1
done
$DROID devices | tee "$OUT/devices.txt"
grep -q "link:emu" "$OUT/devices.txt" || fail "phone never connected to the relay"

step "doctor"
$DROID doctor --json | tee "$OUT/doctor.json"
node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]));if(!d.ready||d.transport!=="link"||!d.info||!d.info.width)process.exit(1)' "$OUT/doctor.json" || fail "doctor"

step "wake + home"
$DROID wake
$DROID key HOME
sleep 1

step "open Settings by package, then snapshot"
$DROID open com.android.settings
$DROID wait "Network" 15000 || fail "Settings never showed 'Network'"
$DROID snapshot | tee "$OUT/snap.txt"
grep -q '@e1' "$OUT/snap.txt" || fail "snapshot had no refs"
$DROID current | tee "$OUT/current.txt"
grep -q "com.android.settings" "$OUT/current.txt" || fail "current is not Settings"

step "tap by visible text → sub-screen"
$DROID tap "Network" --json | tee "$OUT/tap.json"
$DROID wait "Internet" 10000 || $DROID wait "Airplane" 5000 || fail "tap 'Network' did not open the network screen"

step "BACK + swipe"
$DROID key BACK
$DROID wait "Network" 10000 || fail "BACK did not return"
$DROID swipe up
$DROID swipe down

step "type Unicode into Settings search"
$DROID tap "Search settings" || $DROID tap "Search" || fail "no search field"
sleep 1.5
SNAP=$($DROID snapshot)
echo "$SNAP"
FIELD=$(echo "$SNAP" | grep '\[input\]' | head -1 | cut -d' ' -f1)
[ -n "$FIELD" ] || fail "no input field after opening search"
$DROID type "$FIELD" "wifi café"
$DROID wait "café" 8000 || fail "typed text not on screen"
$DROID key ENTER || true
$DROID key BACK; $DROID key BACK || true

step "screenshot"
$DROID screenshot "$OUT/shot.png"
node -e 'const b=require("fs").readFileSync(process.argv[1]);if(b.length<5000||b.subarray(1,4).toString()!=="PNG")process.exit(1);console.log("png bytes",b.length)' "$OUT/shot.png" || fail "screenshot"
mkdir -p e2e-artifacts && cp "$OUT/shot.png" e2e-artifacts/link-screenshot.png

step "open a URL / deep link"
$DROID open "https://example.com" || fail "open url"

step "relay restart: the phone reconnects by itself"
kill $RELAY_PID; sleep 2
AGENT_DROID_TOKEN="$TOKEN" node cli/droid.mjs relay --port $PORT >> "$OUT/relay.log" 2>&1 &
RELAY_PID=$!
for i in $(seq 1 45); do $DROID devices 2>/dev/null | grep -q "link:emu" && break; sleep 1; done
$DROID devices | grep -q "link:emu" || fail "phone did not reconnect after relay restart"
$DROID current

step "remote adb transport (adb over the network)"
unset AGENT_DROID_REMOTE
adb tcpip 5555 || true
sleep 3
adb connect 127.0.0.1:5555 || true
$DROID --remote adb://127.0.0.1:5555 doctor | tee "$OUT/adb-doctor.txt"
grep -q "remote-adb" "$OUT/adb-doctor.txt" || fail "remote adb doctor"
$DROID --remote adb://127.0.0.1:5555 current || fail "remote adb current"

echo; echo "E2E PASS"
