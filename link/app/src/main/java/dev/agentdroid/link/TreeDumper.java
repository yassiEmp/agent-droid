package dev.agentdroid.link;

import android.accessibilityservice.AccessibilityService;
import android.graphics.Rect;
import android.os.Build;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Serializes the on-screen accessibility tree into the SAME XML schema that
 * `uiautomator dump` / UiDevice.dumpWindowHierarchy produce:
 *
 *   <hierarchy rotation="0"><node index text resource-id class package
 *     content-desc checkable checked clickable enabled focusable focused
 *     scrollable long-clickable password selected bounds="[l,t][r,b]">…
 *
 * The agent-droid CLI parses only that schema, so its ref model, text targeting
 * and identity re-resolution work unchanged in remote (link) mode.
 */
final class TreeDumper {
  private TreeDumper() {}

  static String dump(AccessibilityService svc, int rotation) {
    StringBuilder sb = new StringBuilder(64 * 1024);
    sb.append("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\"")
        .append(rotation)
        .append("\">");
    List<AccessibilityNodeInfo> roots = roots(svc);
    for (int i = 0; i < roots.size(); i++) {
      AccessibilityNodeInfo root = roots.get(i);
      if (root == null) continue;
      node(sb, root, i, 0);
    }
    sb.append("</hierarchy>");
    return sb.toString();
  }

  // Every interactive window (app, keyboard, dialogs, system bars), bottom to top,
  // like uiautomator's multi-window dump. Falls back to the active window.
  private static List<AccessibilityNodeInfo> roots(AccessibilityService svc) {
    List<AccessibilityNodeInfo> out = new ArrayList<>();
    try {
      List<AccessibilityWindowInfo> windows = new ArrayList<>(svc.getWindows());
      Collections.sort(windows, (a, b) -> Integer.compare(a.getLayer(), b.getLayer()));
      for (AccessibilityWindowInfo w : windows) {
        AccessibilityNodeInfo r = w.getRoot();
        if (r != null) out.add(r);
      }
    } catch (Throwable ignored) {
      // some OEM builds throw while windows change; fall through
    }
    if (out.isEmpty()) {
      AccessibilityNodeInfo r = svc.getRootInActiveWindow();
      if (r != null) out.add(r);
    }
    return out;
  }

  private static void node(StringBuilder sb, AccessibilityNodeInfo n, int index, int depth) {
    if (depth > 120) return; // pathological trees
    if (!n.isVisibleToUser()) return; // uiautomator skips invisible nodes too
    Rect r = new Rect();
    n.getBoundsInScreen(r);
    CharSequence text = n.getText();
    if (Build.VERSION.SDK_INT >= 26 && n.isShowingHintText()) {
      // keep parity with uiautomator, which reports the hint as text
      text = n.getHintText() != null ? n.getHintText() : text;
    }
    sb.append("<node index=\"").append(index).append('"');
    attr(sb, "text", text);
    attr(sb, "resource-id", n.getViewIdResourceName());
    attr(sb, "class", n.getClassName());
    attr(sb, "package", n.getPackageName());
    attr(sb, "content-desc", n.getContentDescription());
    bool(sb, "checkable", n.isCheckable());
    bool(sb, "checked", n.isChecked());
    bool(sb, "clickable", n.isClickable());
    bool(sb, "enabled", n.isEnabled());
    bool(sb, "focusable", n.isFocusable());
    bool(sb, "focused", n.isFocused());
    bool(sb, "scrollable", n.isScrollable());
    bool(sb, "long-clickable", n.isLongClickable());
    bool(sb, "password", n.isPassword());
    bool(sb, "selected", n.isSelected());
    sb.append(" bounds=\"[")
        .append(r.left).append(',').append(r.top).append("][")
        .append(r.right).append(',').append(r.bottom).append("]\"");
    int count = n.getChildCount();
    if (count == 0) {
      sb.append(" />");
      return;
    }
    sb.append('>');
    for (int i = 0; i < count; i++) {
      AccessibilityNodeInfo c;
      try {
        c = n.getChild(i);
      } catch (Throwable t) {
        c = null;
      }
      if (c != null) node(sb, c, i, depth + 1);
    }
    sb.append("</node>");
  }

  private static void bool(StringBuilder sb, String k, boolean v) {
    sb.append(' ').append(k).append("=\"").append(v ? "true" : "false").append('"');
  }

  private static void attr(StringBuilder sb, String k, CharSequence v) {
    sb.append(' ').append(k).append("=\"");
    if (v != null) escape(sb, v);
    sb.append('"');
  }

  static void escape(StringBuilder sb, CharSequence v) {
    for (int i = 0; i < v.length(); i++) {
      char c = v.charAt(i);
      switch (c) {
        case '&': sb.append("&amp;"); break;
        case '<': sb.append("&lt;"); break;
        case '>': sb.append("&gt;"); break;
        case '"': sb.append("&quot;"); break;
        case '\'': sb.append("&apos;"); break;
        case '\n': sb.append("&#10;"); break;
        case '\r': sb.append("&#13;"); break;
        case '\t': sb.append("&#9;"); break;
        default:
          // drop control chars that are illegal in XML 1.0
          if (c >= 0x20 || c == 0x9) sb.append(c);
      }
    }
  }
}
