package dev.agentdroid.link;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInfo;
import android.graphics.Bitmap;
import android.graphics.ColorSpace;
import android.graphics.Path;
import android.hardware.HardwareBuffer;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.Display;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * One JSON-RPC style message in → one reply out:
 *   in:  {"id": 7, "method": "tap", "params": {"x": 540, "y": 1200}}
 *   out: {"id": 7, "ok": true, "result": …}   or   {"id": 7, "ok": false, "error": "…"}
 */
final class Commands {
  private final LinkService svc;

  Commands(LinkService svc) {
    this.svc = svc;
  }

  String handle(String text) {
    Object id = null;
    try {
      JSONObject msg = new JSONObject(text);
      if (!msg.has("id")) return null; // not a request
      id = msg.get("id");
      String method = msg.optString("method");
      JSONObject p = msg.optJSONObject("params");
      if (p == null) p = new JSONObject();
      Object result = run(method, p);
      JSONObject out = new JSONObject();
      out.put("id", id);
      out.put("ok", true);
      out.put("result", result == null ? JSONObject.NULL : result);
      return out.toString();
    } catch (Throwable t) {
      try {
        JSONObject out = new JSONObject();
        out.put("id", id == null ? JSONObject.NULL : id);
        out.put("ok", false);
        out.put("error", t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage());
        return out.toString();
      } catch (Throwable ignored) {
        return null;
      }
    }
  }

  private Object run(String method, JSONObject p) throws Exception {
    switch (method) {
      case "ping": return "pong";
      case "info": return info();
      case "dump": return TreeDumper.dump(svc, rotation());
      case "tap": return gesture(p.getInt("x"), p.getInt("y"), p.getInt("x"), p.getInt("y"), 60);
      case "press": return gesture(p.getInt("x"), p.getInt("y"), p.getInt("x"), p.getInt("y"), p.optInt("ms", 700));
      case "swipe": return swipe(p);
      case "clear": return setFocusedText("", false);
      case "type": return setFocusedText(p.optString("text"), true);
      case "key": return key(p.optString("name"));
      case "current": return current();
      case "screenshot": return screenshot(p);
      case "open": return open(p.getString("target"));
      case "wake": return wake();
      default: throw new IllegalArgumentException("unknown command \"" + method + "\" (update agent-droid Link?)");
    }
  }

  // ── screen facts ───────────────────────────────────────────────────────────

  JSONObject info() throws Exception {
    JSONObject o = new JSONObject();
    DisplayMetrics m = metrics();
    o.put("model", Build.MANUFACTURER + " " + Build.MODEL);
    o.put("android", Build.VERSION.RELEASE);
    o.put("sdk", Build.VERSION.SDK_INT);
    o.put("width", m.widthPixels);
    o.put("height", m.heightPixels);
    o.put("locked", locked());
    o.put("screenOn", ((PowerManager) svc.getSystemService(Context.POWER_SERVICE)).isInteractive());
    o.put("battery", battery());
    o.put("screenshot", Build.VERSION.SDK_INT >= 30);
    try {
      PackageInfo pi = svc.getPackageManager().getPackageInfo(svc.getPackageName(), 0);
      o.put("app", pi.versionName);
    } catch (Throwable ignored) {
      o.put("app", "?");
    }
    return o;
  }

  private DisplayMetrics metrics() {
    DisplayMetrics m = new DisplayMetrics();
    WindowManager wm = (WindowManager) svc.getSystemService(Context.WINDOW_SERVICE);
    wm.getDefaultDisplay().getRealMetrics(m);
    return m;
  }

  private int rotation() {
    try {
      WindowManager wm = (WindowManager) svc.getSystemService(Context.WINDOW_SERVICE);
      return wm.getDefaultDisplay().getRotation();
    } catch (Throwable t) {
      return 0;
    }
  }

  private boolean locked() {
    KeyguardManager km = (KeyguardManager) svc.getSystemService(Context.KEYGUARD_SERVICE);
    return km != null && km.isKeyguardLocked();
  }

  private int battery() {
    Intent b = svc.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
    if (b == null) return -1;
    int level = b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
    int scale = b.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
    return level < 0 ? -1 : Math.round(level * 100f / scale);
  }

  private String current() {
    if (!svc.lastPackage.isEmpty()) return svc.lastPackage + "/" + svc.lastActivity;
    AccessibilityNodeInfo r = svc.getRootInActiveWindow();
    return r != null && r.getPackageName() != null ? r.getPackageName().toString() : "unknown";
  }

  // ── input ──────────────────────────────────────────────────────────────────

  private Object gesture(int x1, int y1, int x2, int y2, int ms) throws Exception {
    // Gestures still run on the lock screen (a swipe can dismiss a lock with no
    // PIN); a PIN/pattern itself stays the human's job.
    Path path = new Path();
    path.moveTo(Math.max(0, x1), Math.max(0, y1));
    if (x1 != x2 || y1 != y2) path.lineTo(Math.max(0, x2), Math.max(0, y2));
    GestureDescription g = new GestureDescription.Builder()
        .addStroke(new GestureDescription.StrokeDescription(path, 0, Math.max(1, ms)))
        .build();
    CountDownLatch done = new CountDownLatch(1);
    AtomicReference<Boolean> ok = new AtomicReference<>(false);
    boolean sent = svc.dispatchGesture(g, new AccessibilityService.GestureResultCallback() {
      @Override public void onCompleted(GestureDescription d) { ok.set(true); done.countDown(); }
      @Override public void onCancelled(GestureDescription d) { done.countDown(); }
    }, null);
    if (!sent) throw new IllegalStateException("gesture rejected by Android");
    done.await(ms + 3000L, TimeUnit.MILLISECONDS);
    if (!ok.get()) throw new IllegalStateException("gesture was cancelled (screen changed or another touch)");
    return true;
  }

  private Object swipe(JSONObject p) throws Exception {
    if (p.has("x1")) {
      return gesture(p.getInt("x1"), p.getInt("y1"), p.getInt("x2"), p.getInt("y2"), p.optInt("ms", 300));
    }
    DisplayMetrics m = metrics();
    int w = m.widthPixels, h = m.heightPixels;
    int cx = w / 2, cy = h / 2;
    switch (p.optString("dir")) {
      case "up": return gesture(cx, (int) (h * 0.75), cx, (int) (h * 0.25), 300);
      case "down": return gesture(cx, (int) (h * 0.25), cx, (int) (h * 0.75), 300);
      case "left": return gesture((int) (w * 0.85), cy, (int) (w * 0.15), cy, 300);
      case "right": return gesture((int) (w * 0.15), cy, (int) (w * 0.85), cy, 300);
      default: throw new IllegalArgumentException("swipe dir must be up|down|left|right");
    }
  }

  private AccessibilityNodeInfo focusedInput() {
    AccessibilityNodeInfo f = svc.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
    if (f == null) {
      AccessibilityNodeInfo root = svc.getRootInActiveWindow();
      if (root != null) f = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
    }
    return f;
  }

  // The field that should receive text. Right after a tap, focus can take a
  // moment to land (keyboards and search screens animate in), so wait briefly;
  // if nothing reports input focus, fall back to the only editable field on
  // screen and focus it ourselves.
  private AccessibilityNodeInfo inputTarget() throws InterruptedException {
    for (int i = 0; i < 8; i++) {
      AccessibilityNodeInfo f = focusedInput();
      if (f != null && f.isEditable()) return f;
      Thread.sleep(150);
    }
    AccessibilityNodeInfo only = null;
    int count = 0;
    AccessibilityNodeInfo root = svc.getRootInActiveWindow();
    java.util.ArrayDeque<AccessibilityNodeInfo> q = new java.util.ArrayDeque<>();
    if (root != null) q.add(root);
    while (!q.isEmpty() && count < 2) {
      AccessibilityNodeInfo n = q.poll();
      if (n.isEditable() && n.isVisibleToUser()) {
        only = n;
        count++;
      }
      for (int i = 0; i < n.getChildCount(); i++) {
        AccessibilityNodeInfo c = n.getChild(i);
        if (c != null) q.add(c);
      }
    }
    if (count == 1) {
      only.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
      return only;
    }
    return focusedInput();
  }

  private Object setFocusedText(String text, boolean append) throws InterruptedException {
    AccessibilityNodeInfo f = inputTarget();
    if (f == null) throw new IllegalStateException("no text field is focused: tap the field first");
    String current = "";
    if (append && f.getText() != null) {
      boolean hint = Build.VERSION.SDK_INT >= 26 && f.isShowingHintText();
      if (!hint) current = f.getText().toString();
    }
    Bundle args = new Bundle();
    args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, current + text);
    if (!f.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) {
      throw new IllegalStateException("this field refused text input");
    }
    return true;
  }

  private Object key(String name) {
    switch (name) {
      case "BACK": case "4": case "ESCAPE": case "111": return global(AccessibilityService.GLOBAL_ACTION_BACK);
      case "HOME": case "3": return global(AccessibilityService.GLOBAL_ACTION_HOME);
      case "RECENTS": case "APP_SWITCH": case "187": return global(AccessibilityService.GLOBAL_ACTION_RECENTS);
      case "NOTIFICATIONS": return global(AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS);
      case "QUICK_SETTINGS": return global(AccessibilityService.GLOBAL_ACTION_QUICK_SETTINGS);
      case "POWER": return global(AccessibilityService.GLOBAL_ACTION_POWER_DIALOG);
      case "LOCK":
        if (Build.VERSION.SDK_INT >= 28) return global(AccessibilityService.GLOBAL_ACTION_LOCK_SCREEN);
        break;
      case "ENTER": case "66": case "SEARCH": case "84": {
        if (Build.VERSION.SDK_INT < 30) throw new IllegalStateException("ENTER needs Android 11+ in link mode");
        AccessibilityNodeInfo f = focusedInput();
        if (f == null) throw new IllegalStateException("no text field is focused");
        if (!f.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId())) {
          throw new IllegalStateException("the field ignored ENTER");
        }
        return true;
      }
      case "DEL": case "67": {
        AccessibilityNodeInfo f = focusedInput();
        if (f == null) throw new IllegalStateException("no text field is focused");
        CharSequence t = f.getText();
        boolean hint = Build.VERSION.SDK_INT >= 26 && f.isShowingHintText();
        String s = t == null || hint ? "" : t.toString();
        if (s.isEmpty()) return true;
        Bundle args = new Bundle();
        int cut = Character.isLowSurrogate(s.charAt(s.length() - 1)) && s.length() > 1 ? 2 : 1;
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, s.substring(0, s.length() - cut));
        return f.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
      }
      default:
        break;
    }
    throw new IllegalArgumentException("key " + name + " isn't available in link mode (use BACK HOME ENTER DEL RECENTS NOTIFICATIONS, or remote adb)");
  }

  private boolean global(int action) {
    if (!svc.performGlobalAction(action)) throw new IllegalStateException("Android refused the action");
    return true;
  }

  // ── apps & screen ──────────────────────────────────────────────────────────

  private Object open(String target) {
    Intent i;
    if (target.matches("^[a-zA-Z][\\w+.-]*:.*")) {
      i = new Intent(Intent.ACTION_VIEW, Uri.parse(target));
    } else {
      i = svc.getPackageManager().getLaunchIntentForPackage(target);
      if (i == null) throw new IllegalArgumentException("no launchable app with package " + target);
    }
    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    svc.startActivity(i);
    return true;
  }

  @SuppressWarnings("deprecation")
  private Object wake() throws Exception {
    PowerManager pm = (PowerManager) svc.getSystemService(Context.POWER_SERVICE);
    if (!pm.isInteractive()) {
      PowerManager.WakeLock wl = pm.newWakeLock(
          PowerManager.SCREEN_BRIGHT_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP, "agent-droid:wake");
      wl.acquire(3000);
    }
    JSONObject o = new JSONObject();
    o.put("screenOn", true);
    o.put("locked", locked());
    return o;
  }

  private Object screenshot(JSONObject p) throws Exception {
    if (Build.VERSION.SDK_INT < 30) {
      throw new IllegalStateException("screenshots need Android 11+ in link mode (use remote adb on older phones)");
    }
    Bitmap bmp = null;
    for (int attempt = 0; attempt < 3 && bmp == null; attempt++) {
      AtomicReference<Object> box = new AtomicReference<>();
      CountDownLatch done = new CountDownLatch(1);
      svc.takeScreenshot(Display.DEFAULT_DISPLAY, svc.getMainExecutor(), new AccessibilityService.TakeScreenshotCallback() {
        @Override public void onSuccess(AccessibilityService.ScreenshotResult r) { box.set(r); done.countDown(); }
        @Override public void onFailure(int code) { box.set(code); done.countDown(); }
      });
      done.await(5, TimeUnit.SECONDS);
      Object r = box.get();
      if (r instanceof AccessibilityService.ScreenshotResult) {
        AccessibilityService.ScreenshotResult s = (AccessibilityService.ScreenshotResult) r;
        HardwareBuffer hb = s.getHardwareBuffer();
        ColorSpace cs = s.getColorSpace();
        Bitmap hw = Bitmap.wrapHardwareBuffer(hb, cs);
        if (hw != null) bmp = hw.copy(Bitmap.Config.ARGB_8888, false);
        hb.close();
      } else if (Integer.valueOf(AccessibilityService.ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT).equals(r)) {
        Thread.sleep(1100); // Android allows about one screenshot per second
      } else if (r != null) {
        throw new IllegalStateException("Android refused the screenshot (code " + r + ")");
      }
    }
    if (bmp == null) throw new IllegalStateException("screenshot timed out");
    int maxW = p.optInt("maxWidth", 0);
    if (maxW > 0 && bmp.getWidth() > maxW) {
      int h = Math.round(bmp.getHeight() * (maxW / (float) bmp.getWidth()));
      bmp = Bitmap.createScaledBitmap(bmp, maxW, h, true);
    }
    boolean jpeg = "jpeg".equalsIgnoreCase(p.optString("format")) || "jpg".equalsIgnoreCase(p.optString("format"));
    ByteArrayOutputStream out = new ByteArrayOutputStream(1 << 20);
    bmp.compress(jpeg ? Bitmap.CompressFormat.JPEG : Bitmap.CompressFormat.PNG, p.optInt("quality", 80), out);
    JSONObject o = new JSONObject();
    o.put("format", jpeg ? "jpeg" : "png");
    o.put("width", bmp.getWidth());
    o.put("height", bmp.getHeight());
    o.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
    return o;
  }
}
