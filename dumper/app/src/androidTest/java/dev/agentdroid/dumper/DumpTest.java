package dev.agentdroid.dumper;

import android.app.Instrumentation;
import android.os.Bundle;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.Configurator;
import androidx.test.uiautomator.UiDevice;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;

// Animation-proof view-hierarchy dump. Unlike `adb shell uiautomator dump`
// (which calls UiAutomation.waitForIdle and fails with "could not get idle
// state" on continuously-animating screens — e.g. React Native / Reanimated
// loops), this forces the idle timeout to 0 so the dump proceeds immediately.
// Output XML schema is identical to the legacy dumper, so the CLI's parser/ref
// model is unchanged.
//
// UiDevice dumps the WHOLE screen system-wide, so this works for ANY foreground
// app — the dumper self-targets its own empty host app and never references the
// app under test.
//
// The XML is returned via an instrumentation status Bundle, which `am
// instrument` always echoes back (as INSTRUMENTATION_STATUS: droiddump=...) on
// every device. Test stdout is NOT forwarded, and writing to /sdcard or the
// app's external dir is blocked by scoped storage (Android 11+) and some
// vendors' Android/data lockdown — so a Bundle is the only universal path.
@RunWith(AndroidJUnit4.class)
public class DumpTest {
  static final String BEGIN = "<<<DROID_DUMP_BEGIN>>>";
  static final String END = "<<<DROID_DUMP_END>>>";

  @Test
  public void dump() throws Exception {
    Configurator.getInstance().setWaitForIdleTimeout(0L);
    Instrumentation inst = InstrumentationRegistry.getInstrumentation();
    UiDevice device = UiDevice.getInstance(inst);
    ByteArrayOutputStream buf = new ByteArrayOutputStream();
    device.dumpWindowHierarchy(buf);
    String xml = new String(buf.toByteArray(), StandardCharsets.UTF_8);
    Bundle b = new Bundle();
    b.putString("droiddump", BEGIN + "\n" + xml + "\n" + END);
    inst.sendStatus(2, b);
  }
}
