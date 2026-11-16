package dev.agentdroid.link;

import android.accessibilityservice.AccessibilityService;
import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.accessibility.AccessibilityEvent;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * The accessibility service IS the remote agent: Android keeps an enabled
 * accessibility service running (and restarts it after a reboot), so it is the
 * natural owner of the outbound WebSocket to the relay. Dialing out (instead of
 * listening) is what makes 4G work: carrier NAT blocks inbound connections.
 */
public class LinkService extends AccessibilityService {
  private static final String TAG = "agent-droid-link";

  static volatile LinkService instance;
  static volatile String status = "Accessibility service is off";

  volatile String lastPackage = "";
  volatile String lastActivity = "";

  private final Handler main = new Handler(Looper.getMainLooper());
  private final ExecutorService worker = Executors.newSingleThreadExecutor();
  private OkHttpClient http;
  private WebSocket socket;
  private Commands commands;
  private int attempt = 0;
  private long generation = 0;
  private ConnectivityManager.NetworkCallback netCallback;

  @Override
  protected void onServiceConnected() {
    super.onServiceConnected();
    instance = this;
    commands = new Commands(this);
    http = new OkHttpClient.Builder()
        .pingInterval(15, TimeUnit.SECONDS) // keeps 4G NAT mappings alive
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .retryOnConnectionFailure(true)
        .build();
    watchNetwork();
    connect();
  }

  @Override
  public void onAccessibilityEvent(AccessibilityEvent e) {
    if (e == null || e.getEventType() != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return;
    CharSequence pkg = e.getPackageName();
    CharSequence cls = e.getClassName();
    if (pkg == null || cls == null) return;
    String c = cls.toString();
    // Only remember real screens, not toasts/layout classes from the same event.
    if (c.contains("Activity") || c.endsWith("Launcher") || !c.startsWith("android.")) {
      lastPackage = pkg.toString();
      lastActivity = c;
    }
  }

  @Override
  public void onInterrupt() {}

  @Override
  public void onDestroy() {
    disconnect("Accessibility service is off");
    if (netCallback != null) {
      try {
        ((ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE)).unregisterNetworkCallback(netCallback);
      } catch (Throwable ignored) {
      }
    }
    worker.shutdownNow();
    instance = null;
    super.onDestroy();
  }

  /** (Re)connect with the saved settings. Safe to call any time. */
  void connect() {
    main.post(() -> {
      Prefs p = Prefs.load(this);
      long gen = ++generation;
      if (socket != null) {
        socket.close(1000, "reconnect");
        socket = null;
      }
      if (!p.enabled) {
        status = "Paused";
        return;
      }
      if (!p.configured()) {
        status = "Not set up: open the setup link from your relay";
        return;
      }
      String url = p.url;
      if (url.startsWith("http")) url = "ws" + url.substring(4);
      if (!url.contains("/link")) url = url.replaceAll("/+$", "") + "/link";
      String sep = url.contains("?") ? "&" : "?";
      String full = url + sep + "name=" + android.net.Uri.encode(p.name);
      status = "Connecting to " + p.url + "…";
      Request req;
      try {
        req = new Request.Builder().url(full).header("Authorization", "Bearer " + p.token).build();
      } catch (IllegalArgumentException bad) {
        status = "Bad relay URL: " + p.url;
        return;
      }
      socket = http.newWebSocket(req, new Listener(gen, p));
    });
  }

  void disconnect(String why) {
    main.post(() -> {
      generation++;
      if (socket != null) socket.close(1000, why);
      socket = null;
      status = why;
    });
  }

  private void scheduleReconnect(long gen) {
    if (gen != generation) return; // superseded by a newer connect()
    long delay = Math.min(30000, 1000L << Math.min(attempt, 5));
    attempt++;
    main.postDelayed(() -> {
      if (gen == generation) connect();
    }, delay);
  }

  // Reconnect at once when the network changes (Wi-Fi ↔ 4G) instead of waiting
  // for the backoff timer.
  private void watchNetwork() {
    try {
      ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
      netCallback = new ConnectivityManager.NetworkCallback() {
        @Override
        public void onAvailable(Network network) {
          main.postDelayed(() -> {
            if (socket == null || !status.startsWith("Connected")) {
              attempt = 0;
              connect();
            }
          }, 800);
        }
      };
      if (Build.VERSION.SDK_INT >= 24) cm.registerDefaultNetworkCallback(netCallback);
    } catch (Throwable t) {
      Log.w(TAG, "network callback unavailable", t);
    }
  }

  private final class Listener extends WebSocketListener {
    private final long gen;
    private final Prefs prefs;

    Listener(long gen, Prefs prefs) {
      this.gen = gen;
      this.prefs = prefs;
    }

    @Override
    public void onOpen(WebSocket ws, Response response) {
      if (gen != generation) return;
      attempt = 0;
      status = "Connected to " + prefs.url + " as \"" + prefs.name + "\"";
      try {
        JSONObject hello = commands.info();
        hello.put("type", "hello");
        hello.put("name", prefs.name);
        ws.send(hello.toString());
      } catch (Throwable t) {
        Log.w(TAG, "hello failed", t);
      }
    }

    @Override
    public void onMessage(WebSocket ws, String text) {
      worker.execute(() -> {
        String reply = commands.handle(text);
        if (reply != null) ws.send(reply);
      });
    }

    @Override
    public void onClosing(WebSocket ws, int code, String reason) {
      ws.close(1000, null);
    }

    @Override
    public void onClosed(WebSocket ws, int code, String reason) {
      if (gen != generation) return;
      status = code == 4000 ? "Replaced by a newer connection" : "Disconnected, retrying…";
      if (code != 4000) scheduleReconnect(gen);
    }

    @Override
    public void onFailure(WebSocket ws, Throwable t, Response response) {
      if (gen != generation) return;
      int http = response != null ? response.code() : 0;
      status = http == 401
          ? "Wrong token: open the setup link from your relay again"
          : "Can't reach the relay (" + (t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage()) + "), retrying…";
      main.post(() -> {
        if (gen == generation) socket = null;
      });
      scheduleReconnect(gen);
    }
  }
}
