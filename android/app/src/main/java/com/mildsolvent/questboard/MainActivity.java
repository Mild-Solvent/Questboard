package com.mildsolvent.questboard;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

/**
 * Questboard for Android: a full-screen WebView running the same Tavern/Abyss board as the
 * desktop app. The page talks to {@link Bridge} for files, prefs and HTTP (quest sync).
 */
public class MainActivity extends Activity {
    // The board ships inside the APK and is loaded straight from its assets: no network, no
    // URL interception, works offline like the desktop app. Sync goes through Bridge.http.
    private static final String START_URL = "file:///android_asset/www/index.html";

    private WebView web;
    private Bridge bridge;
    private boolean pageReady = false;
    private int insetTop, insetBottom, insetLeft, insetRight;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window w = getWindow();
        WindowCompat.setDecorFitsSystemWindows(w, false);
        w.setStatusBarColor(Color.TRANSPARENT);
        w.setNavigationBarColor(Color.TRANSPARENT);
        WindowInsetsControllerCompat ic = WindowCompat.getInsetsController(w, w.getDecorView());
        ic.setAppearanceLightStatusBars(false);
        ic.setAppearanceLightNavigationBars(false);

        web = new WebView(this);
        web.setBackgroundColor(0xFF2A160A);
        web.setLayoutParams(new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);             // needed for file:///android_asset on API 30+
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setTextZoom(100);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);

        bridge = new Bridge(this, web);
        web.addJavascriptInterface(bridge, "AndroidBridge");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if ("file".equals(u.getScheme())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
                pushInsets();
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                android.util.Log.d("Questboard", m.message() + " @" + m.lineNumber());
                return true;
            }
        });

        ViewCompat.setOnApplyWindowInsetsListener(web, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            float d = getResources().getDisplayMetrics().density;
            insetTop = Math.round(bars.top / d);
            insetBottom = Math.round(Math.max(bars.bottom, ime.bottom) / d);
            insetLeft = Math.round(bars.left / d);
            insetRight = Math.round(bars.right / d);
            pushInsets();
            return WindowInsetsCompat.CONSUMED;
        });

        web.loadUrl(START_URL);
        try { getSystemService(android.app.NotificationManager.class).cancel(UpdatedReceiver.NOTIFY_ID); } catch (Exception ignored) { }
    }

    private void pushInsets() {
        if (!pageReady) return;
        web.evaluateJavascript("window.__qbInsets && window.__qbInsets(" + insetTop + "," + insetBottom + "," + insetLeft + "," + insetRight + ")", null);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == Bridge.NOTIFY_PERMISSION_REQUEST && bridge != null) bridge.continueInstall();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        if (pageReady) web.evaluateJavascript("window.__qbResume && window.__qbResume()", null);
    }

    @Override
    protected void onPause() {
        web.onPause();
        super.onPause();
    }

    @Override
    public void onBackPressed() {
        if (!pageReady) { super.onBackPressed(); return; }
        web.evaluateJavascript("window.__qbBack ? window.__qbBack() : false", value -> {
            if (!"true".equals(value)) moveTaskToBack(true);
        });
    }

    @Override
    protected void onDestroy() {
        if (web != null) { web.destroy(); web = null; }
        super.onDestroy();
    }
}
