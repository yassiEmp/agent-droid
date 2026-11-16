package dev.agentdroid.link;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.text.InputType;
import android.text.TextUtils;
import android.view.Gravity;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * One screen: status, the three setup steps, and the relay settings. Opening an
 * `agentdroid://link?url=…&token=…` link (from the relay's /setup page) fills
 * in and saves everything, so setup needs no typing.
 */
public class MainActivity extends Activity {
  private final Handler ui = new Handler(Looper.getMainLooper());
  private TextView status, stepA11y, stepBattery, stepRelay;
  private EditText url, token, name;
  private Button toggle;

  private final Runnable tick = new Runnable() {
    @Override public void run() {
      refresh();
      ui.postDelayed(this, 1000);
    }
  };

  @Override
  protected void onCreate(Bundle b) {
    super.onCreate(b);
    build();
    handleLink(getIntent());
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    handleLink(intent);
  }

  @Override
  protected void onResume() {
    super.onResume();
    Prefs p = Prefs.load(this);
    url.setText(p.url);
    token.setText(p.token);
    name.setText(p.name);
    ui.post(tick);
  }

  @Override
  protected void onPause() {
    ui.removeCallbacks(tick);
    super.onPause();
  }

  private void handleLink(Intent intent) {
    Uri data = intent == null ? null : intent.getData();
    if (data == null || !"agentdroid".equals(data.getScheme())) return;
    String u = data.getQueryParameter("url");
    String t = data.getQueryParameter("token");
    String n = data.getQueryParameter("name");
    if (TextUtils.isEmpty(u) || TextUtils.isEmpty(t)) return;
    Prefs.save(this, u, t, TextUtils.isEmpty(n) ? Prefs.load(this).name : n, true);
    reconnect();
  }

  private void reconnect() {
    LinkService s = LinkService.instance;
    if (s != null) s.connect();
    refresh();
  }

  private boolean serviceOn() {
    String enabled = Settings.Secure.getString(getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
    String me = new ComponentName(this, LinkService.class).flattenToString();
    String shortMe = new ComponentName(this, LinkService.class).flattenToShortString();
    return enabled != null && (enabled.contains(me) || enabled.contains(shortMe)) && LinkService.instance != null;
  }

  private boolean batteryOk() {
    PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
    return pm.isIgnoringBatteryOptimizations(getPackageName());
  }

  private void refresh() {
    Prefs p = Prefs.load(this);
    boolean on = serviceOn();
    boolean connected = on && LinkService.status.startsWith("Connected");
    status.setText(on ? LinkService.status : "Off: turn on the accessibility service (step 1)");
    ((GradientDrawable) status.getBackground()).setColor(connected ? 0xFFE7F8EE : on ? 0xFFFFF4DE : 0xFFF2F2F2);
    mark(stepA11y, on, "1. Turn on agent-droid Link in Accessibility");
    mark(stepBattery, batteryOk(), "2. Let it run in the background (battery: unrestricted)");
    mark(stepRelay, p.configured(), "3. Open the setup link from your relay");
    toggle.setText(p.enabled ? "Pause remote control" : "Resume remote control");
  }

  private void mark(TextView v, boolean done, String text) {
    v.setText((done ? "✓  " : "○  ") + text);
    v.setTextColor(done ? 0xFF1A7F45 : 0xFF222222);
  }

  // ── layout (code-only: no XML, nothing to theme) ───────────────────────────

  @SuppressLint("BatteryLife")
  private void build() {
    int pad = dp(20);
    LinearLayout col = new LinearLayout(this);
    col.setOrientation(LinearLayout.VERTICAL);
    col.setPadding(pad, dp(28), pad, pad);
    col.setBackgroundColor(Color.WHITE);

    TextView title = text("agent-droid Link", 24, true);
    col.addView(title);
    TextView sub = text("Lets your own AI agent use this phone from anywhere, over Wi-Fi or 4G. Only your relay can connect.", 15, false);
    sub.setTextColor(0xFF666666);
    sub.setPadding(0, dp(6), 0, dp(18));
    col.addView(sub);

    status = text("", 15, true);
    GradientDrawable bg = new GradientDrawable();
    bg.setCornerRadius(dp(14));
    bg.setColor(0xFFF2F2F2);
    status.setBackground(bg);
    status.setPadding(dp(16), dp(14), dp(16), dp(14));
    col.addView(status);

    stepA11y = step(col);
    stepA11y.setOnClickListener(v -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
    stepBattery = step(col);
    stepBattery.setOnClickListener(v -> {
      try {
        Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
        i.setData(Uri.parse("package:" + getPackageName()));
        startActivity(i);
      } catch (Throwable t) {
        startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())));
      }
    });
    stepRelay = step(col);

    if (Build.VERSION.SDK_INT >= 33) {
      TextView note = text("Android 13+: if the switch in Accessibility is greyed out, open App info › ⋮ › \"Allow restricted settings\" first.", 13, false);
      note.setTextColor(0xFF8A6D00);
      note.setPadding(0, dp(8), 0, 0);
      note.setOnClickListener(v -> startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()))));
      col.addView(note);
    }

    TextView adv = text("Relay", 17, true);
    adv.setPadding(0, dp(26), 0, dp(4));
    col.addView(adv);
    url = field(col, "Relay URL, e.g. http://100.101.102.103:8790", InputType.TYPE_TEXT_VARIATION_URI);
    token = field(col, "Token", InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);
    name = field(col, "Phone name", InputType.TYPE_CLASS_TEXT);

    Button save = button("Save and connect", true);
    save.setOnClickListener(v -> {
      Prefs.save(this, url.getText().toString(), token.getText().toString(), name.getText().toString(), true);
      reconnect();
    });
    col.addView(save);

    toggle = button("Pause remote control", false);
    toggle.setOnClickListener(v -> {
      boolean nowEnabled = !Prefs.load(this).enabled;
      Prefs.setEnabled(this, nowEnabled);
      LinkService s = LinkService.instance;
      if (s != null) {
        if (nowEnabled) s.connect();
        else s.disconnect("Paused");
      }
      refresh();
    });
    col.addView(toggle);

    ScrollView scroll = new ScrollView(this);
    scroll.setFillViewport(true);
    scroll.setFitsSystemWindows(true); // Android 15 draws edge-to-edge by default
    scroll.addView(col);
    setContentView(scroll);
  }

  private TextView step(LinearLayout col) {
    TextView v = text("", 16, false);
    v.setPadding(dp(4), dp(14), dp(4), dp(4));
    col.addView(v);
    return v;
  }

  private TextView text(String s, int sp, boolean bold) {
    TextView v = new TextView(this);
    v.setText(s);
    v.setTextSize(sp);
    v.setTextColor(0xFF111111);
    if (bold) v.setTypeface(Typeface.DEFAULT_BOLD);
    return v;
  }

  private EditText field(LinearLayout col, String hint, int type) {
    EditText e = new EditText(this);
    e.setHint(hint);
    e.setSingleLine(true);
    e.setInputType(InputType.TYPE_CLASS_TEXT | type);
    e.setTextSize(15);
    col.addView(e, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
    return e;
  }

  private Button button(String s, boolean primary) {
    Button b = new Button(this);
    b.setText(s);
    b.setAllCaps(false);
    b.setTextSize(16);
    b.setGravity(Gravity.CENTER);
    GradientDrawable bg = new GradientDrawable();
    bg.setCornerRadius(dp(14));
    bg.setColor(primary ? 0xFF111111 : 0xFFF2F2F2);
    b.setBackground(bg);
    b.setTextColor(primary ? Color.WHITE : 0xFF111111);
    LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(52));
    lp.topMargin = dp(12);
    b.setLayoutParams(lp);
    return b;
  }

  private int dp(int v) {
    return Math.round(v * getResources().getDisplayMetrics().density);
  }
}
