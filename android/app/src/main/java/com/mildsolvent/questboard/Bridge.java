package com.mildsolvent.questboard;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The `AndroidBridge` object the web page sees. Small text files in the app's private storage,
 * prefs, device info, and an async HTTP call (done natively so the quest sync is not subject to
 * WebView CORS rules). Everything here is private to the app; nothing is exported.
 */
public class Bridge {
    private final Context ctx;
    private final WebView web;
    private final ExecutorService io = Executors.newFixedThreadPool(2);

    Bridge(Context ctx, WebView web) {
        this.ctx = ctx.getApplicationContext();
        this.web = web;
    }

    private File fileFor(String name) {
        String safe = name.replaceAll("[^A-Za-z0-9._-]", "_");
        File dir = new File(ctx.getFilesDir(), "questboard");
        if (!dir.exists()) dir.mkdirs();
        return new File(dir, safe);
    }

    @JavascriptInterface
    public String readFile(String name) {
        File f = fileFor(name);
        if (!f.exists()) return null;
        try {
            return new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }

    @JavascriptInterface
    public boolean writeFile(String name, String text) {
        File f = fileFor(name);
        File tmp = new File(f.getPath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write((text == null ? "" : text).getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
        } catch (Exception e) {
            return false;
        }
        return tmp.renameTo(f);
    }

    private SharedPreferences prefs() { return ctx.getSharedPreferences("questboard", Context.MODE_PRIVATE); }

    @JavascriptInterface
    public String getPrefs() { return prefs().getString("json", "{}"); }

    @JavascriptInterface
    public void setPrefs(String json) { prefs().edit().putString("json", json == null ? "{}" : json).apply(); }

    @JavascriptInterface
    public String info() {
        JSONObject o = new JSONObject();
        try {
            o.put("version", BuildConfig.VERSION_NAME);
            o.put("versionCode", BuildConfig.VERSION_CODE);
            o.put("platform", "android");
            o.put("sdk", Build.VERSION.SDK_INT);
            o.put("model", Build.MODEL);
            o.put("device", (Build.MANUFACTURER + " " + Build.MODEL).trim());
        } catch (Exception ignored) { }
        return o.toString();
    }

    @JavascriptInterface
    public void openExternal(String url) {
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) return;
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
        } catch (Exception ignored) { }
    }

    @JavascriptInterface
    public void vibrate(int ms) {
        try {
            Vibrator v = (Vibrator) ctx.getSystemService(Context.VIBRATOR_SERVICE);
            if (v == null || !v.hasVibrator()) return;
            v.vibrate(VibrationEffect.createOneShot(Math.max(5, Math.min(ms, 400)), VibrationEffect.DEFAULT_AMPLITUDE));
        } catch (Exception ignored) { }
    }

    /** Async HTTP. Result is delivered to window.__qbHttp(id, json) with {status, etag, body, error}. */
    @JavascriptInterface
    public void http(final String id, final String method, final String url, final String headersJson, final String body) {
        io.execute(() -> {
            JSONObject res = new JSONObject();
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(url).openConnection();
                c.setRequestMethod(method);
                c.setConnectTimeout(12000);
                c.setReadTimeout(20000);
                c.setUseCaches(false);
                c.setInstanceFollowRedirects(true);
                c.setRequestProperty("User-Agent", "Questboard-Android/" + BuildConfig.VERSION_NAME);
                if (headersJson != null) {
                    JSONObject h = new JSONObject(headersJson);
                    Iterator<String> it = h.keys();
                    while (it.hasNext()) {
                        String k = it.next();
                        if (!h.isNull(k)) c.setRequestProperty(k, h.getString(k));
                    }
                }
                if (body != null) {
                    c.setDoOutput(true);
                    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                    c.setFixedLengthStreamingMode(bytes.length);
                    try (OutputStream out = c.getOutputStream()) { out.write(bytes); }
                }
                int status = c.getResponseCode();
                InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                String text = in == null ? "" : readAll(in);
                String etag = c.getHeaderField("ETag");
                res.put("status", status);
                res.put("etag", etag == null ? "" : etag);
                res.put("body", text);
            } catch (Exception e) {
                try {
                    res.put("status", 0);
                    res.put("etag", "");
                    res.put("body", "");
                    res.put("error", e.getClass().getSimpleName() + (e.getMessage() == null ? "" : ": " + e.getMessage()));
                } catch (Exception ignored) { }
            } finally {
                if (c != null) c.disconnect();
            }
            final String json = JSONObject.quote(res.toString());
            web.post(() -> web.evaluateJavascript("window.__qbHttp && window.__qbHttp(" + JSONObject.quote(id) + "," + json + ")", null));
        });
    }

    private static String readAll(InputStream in) throws Exception {
        StringBuilder sb = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            char[] buf = new char[8192];
            int n;
            while ((n = r.read(buf)) > 0) sb.append(buf, 0, n);
        }
        return sb.toString();
    }
}
