package dev.agentdroid.link;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;

/** Relay URL, token, phone name, and the on/off switch. Survives reboots. */
final class Prefs {
  private static final String FILE = "link";
  final String url;
  final String token;
  final String name;
  final boolean enabled;

  private Prefs(String url, String token, String name, boolean enabled) {
    this.url = url;
    this.token = token;
    this.name = name;
    this.enabled = enabled;
  }

  static Prefs load(Context c) {
    SharedPreferences p = c.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    return new Prefs(
        p.getString("url", ""),
        p.getString("token", ""),
        p.getString("name", defaultName()),
        p.getBoolean("enabled", true));
  }

  static void save(Context c, String url, String token, String name, boolean enabled) {
    c.getSharedPreferences(FILE, Context.MODE_PRIVATE)
        .edit()
        .putString("url", url == null ? "" : url.trim())
        .putString("token", token == null ? "" : token.trim())
        .putString("name", name == null || name.trim().isEmpty() ? defaultName() : name.trim())
        .putBoolean("enabled", enabled)
        .apply();
  }

  static void setEnabled(Context c, boolean enabled) {
    c.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putBoolean("enabled", enabled).apply();
  }

  boolean configured() {
    return !url.isEmpty() && !token.isEmpty();
  }

  static String defaultName() {
    String m = (Build.MODEL == null ? "android" : Build.MODEL).toLowerCase();
    return m.replaceAll("[^a-z0-9]+", "-").replaceAll("(^-|-$)", "");
  }
}
