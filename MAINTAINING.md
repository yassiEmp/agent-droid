# Maintaining agent-droid

How to iterate on, rebuild, debug, and test the CLI and its animation-proof
instrumentation dumper. README.md is the *usage* doc; this is the *maintainer*
doc.

## Layout

```
agent-droid/
├── package.json             # npm package; `bin` exposes `agent-droid` + `droid`
├── cli/
│   ├── droid.mjs            # CLI entry: arg parsing + command dispatch (has the shebang)
│   ├── lib.mjs              # engine: dump transports, ref model, act primitives
│   └── vendor/
│       ├── droid-dumper-app.apk    # empty host app (instrumentation target)
│       └── droid-dumper-test.apk   # the instrumentation test (the actual dumper)
└── dumper/                  # standalone Gradle SOURCE for the two APKs above
    ├── settings.gradle, build.gradle, gradle.properties
    ├── gradlew(.bat), gradle/wrapper/
    └── app/
        ├── build.gradle
        └── src/
            ├── main/AndroidManifest.xml          # minimal, no activity
            └── androidTest/java/dev/agentdroid/dumper/DumpTest.java
```

The vendored APKs in `cli/vendor/` are the shipped artifacts; `dumper/` is only
needed to rebuild them.

## How the pieces fit

The CLI is **snapshot → `@eN` refs → act**, where each act re-resolves a ref's
live bounds (`resolveLive` in `lib.mjs`) by re-dumping and matching the node by
identity. Everything rests on one function: `dumpXml(serial)`, which produces the
hierarchy XML. It tries three transports in order, retrying the set 4× with a
0.5s sleep:

1. **`dumpViaInstrumentation`** (primary, animation-proof) — runs the vendored
   instrumentation via `am instrument`. Works mid-animation.
2. **`dumpOnce`** (`uiautomator dump /dev/tty`) — legacy, fails on non-idle UI.
3. **`dumpViaFile`** (`uiautomator dump /sdcard/...` then `cat`) — legacy fallback.

If all fail it throws an `Error` with `err.code = "UI_ANIMATED"`. All transports
emit the **same XML schema** (`<hierarchy><node .../></hierarchy>`), so the parser
(`allNodes`) and ref model never change when transports change.

## The instrumentation dumper (the non-obvious part)

`dumper/.../DumpTest.java` is a one-method UiAutomator test:

```java
Configurator.getInstance().setWaitForIdleTimeout(0L);   // defeats "could not get idle state"
UiDevice device = UiDevice.getInstance(inst);
ByteArrayOutputStream buf = new ByteArrayOutputStream();
device.dumpWindowHierarchy(buf);
Bundle b = new Bundle();
b.putString("droiddump", BEGIN + "\n" + xml + "\n" + END);
inst.sendStatus(2, b);                                   // how the XML gets back to the host
```

Hard-won constraints — **do not "simplify" these away**:

- **Why a status Bundle, not a file?** The test runs as the dumper app's uid, so
  Android 11+ scoped storage blocks writing to `/sdcard`, and some vendors (e.g.
  Samsung) additionally block adb-side reads of `/sdcard/Android/data/<pkg>/`. A
  status Bundle always round-trips through `am instrument` output on every device.
  (`System.out` does **not** — instrumentation doesn't forward test stdout.)
- **Why sentinels (`<<<DROID_DUMP_BEGIN>>>` / `<<<DROID_DUMP_END>>>`)?** `am
  instrument` prints a multi-line Bundle value as raw continuation lines. The CLI
  slices the XML between the two sentinels — robust against surrounding status
  lines. The sentinels are defined in BOTH `DumpTest.java` and `lib.mjs`; keep
  them in sync.
- **Why two APKs?** Instrumentation needs a target app installed. The host app
  (`droid-dumper-app.apk`) is an empty shell that only exists as the target; the
  test apk carries `DumpTest` + the AndroidX test/uiautomator deps. `installDumper`
  installs both.
- **App-agnostic:** `UiAutomation` reads the whole screen, so the dumper snapshots
  whatever app is in the foreground. The `dev.agentdroid.dumper` package id is the
  dumper's own; it never references the app under test.

## Rebuilding the APKs

After editing `DumpTest.java` or `app/build.gradle`:

```bash
cd dumper
./gradlew :app:assembleDebug :app:assembleDebugAndroidTest --no-daemon
cp app/build/outputs/apk/debug/app-debug.apk                     ../cli/vendor/droid-dumper-app.apk
cp app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk ../cli/vendor/droid-dumper-test.apk
# reinstall on the device:
node ../cli/droid.mjs setup
```

Only the test apk changes when you edit `DumpTest.java`; rebuild just
`:app:assembleDebugAndroidTest`. Rebuild the host app only if you change the
`applicationId`/manifest.

### Build environment (pinned)

- **JDK 17** (AGP 8.13 needs JDK 17+).
- **AGP 8.13.0**, pinned in `dumper/build.gradle`; Gradle **9.3.1** wrapper.
- **compileSdk/targetSdk 35**, minSdk 24. Android SDK at `$ANDROID_HOME`.
- Test deps: `androidx.test.ext:junit:1.2.1`, `androidx.test:runner:1.6.2`,
  `androidx.test.uiautomator:uiautomator:2.3.0`.
- `dumper/` is intentionally **standalone** — keep it independent of any app
  project so it builds anywhere.

## Testing

**Fast manual smoke test** (verifies the live wiring end to end):

```bash
DR="node cli/droid.mjs"
$DR doctor                  # expect: "... dumper installed"
$DR snapshot                # expect @eN refs even on an animating screen
$DR tap @e1 && sleep 1 && $DR current
```

**Test the dumper in isolation** (raw `am instrument` output):

```bash
adb shell am instrument -w -r -e class dev.agentdroid.dumper.DumpTest#dump \
  dev.agentdroid.dumper.test/androidx.test.runner.AndroidJUnitRunner
# expect: INSTRUMENTATION_STATUS: droiddump=<<<DROID_DUMP_BEGIN>>> ... <hierarchy ...> ... <<<DROID_DUMP_END>>>
# and a trailing "OK (1 test)"
```

A passing test with **no `droiddump` block** means `sendStatus`/sentinels broke.
A `FAILURES!!!` with a file/IO stack trace means a file-write path was
reintroduced (see scoped-storage note above).

There is no automated unit suite yet; the device smoke test is the gate. A good
first suite would target `lib.mjs`'s pure functions (`parseBounds`, `allNodes`,
`nameFor`, `resolveLive`) against a captured XML fixture.

## Debugging guide

| Symptom | Likely cause / fix |
|---|---|
| `snapshot` → `UI_ANIMATED` after `setup` | Dumper not installed: `adb shell pm list instrumentation \| grep agentdroid`. Re-run `setup`. |
| `doctor` says `dumper missing` | `installDumper` couldn't find/inst the APKs. Check `cli/vendor/*.apk` exist; rebuild if not. |
| Dump returns empty XML | Run the isolation command. Missing Bundle block ⇒ sentinels in `DumpTest.java` and `lib.mjs` drifted apart. |
| Taps land wrong | `resolveLive` couldn't match by identity — check the ref's `sig` (class/desc/text) vs a fresh `snapshot`. EditText matches on desc+class only (text mutates as you type). |
| Build fails on AGP/Gradle | Confirm JDK 17 + the pinned AGP 8.13.0 vs the wrapper's Gradle version. |
| `am instrument` "Unable to find instrumentation" | Host app uninstalled — `setup` reinstalls both APKs. |

## Invariants — don't break these

- All dump transports must emit the **same XML schema**; never tailor `allNodes`
  to one transport.
- Keep the legacy `uiautomator` transports as fallback — don't delete them.
- Keep the `BEGIN`/`END` sentinels identical in `DumpTest.java` and `lib.mjs`.
- `doctor` must never throw.
- The dumper writes **nothing to disk on the device** — Bundle round-trip only.
