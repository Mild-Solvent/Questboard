package com.mildsolvent.questboard;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.os.Build;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * In-app updates (Father, 2026-11-07: "update within the app, I just click, no APK left taking up
 * space"). The new APK is downloaded into the app's private cache (never Downloads), handed to
 * Android's PackageInstaller, and deleted once it is installed: the next start of the new version
 * removes it, so nothing is left to clean up by hand. Android shows its own one-tap "Update"
 * confirmation, and it only accepts an APK signed with the same key, so a wrong file can't replace
 * the app.
 */
final class Updater {
    interface Progress { void on(String state, long done, long total, String message); }

    private Updater() { }

    static File dir(Context ctx) {
        File d = new File(ctx.getCacheDir(), "update");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    static File apk(Context ctx) { return new File(dir(ctx), "next.apk"); }

    /** Removes any download. */
    static void cleanup(Context ctx) {
        File[] fs = dir(ctx).listFiles();
        if (fs != null) for (File f : fs) //noinspection ResultOfMethodCallIgnored
            f.delete();
    }

    /** On start: keeps a finished download only if it is still newer than this app; everything else goes. */
    static void cleanupStale(Context ctx) {
        File[] fs = dir(ctx).listFiles();
        if (fs == null) return;
        for (File f : fs) if (!f.getName().equals("next.apk")) //noinspection ResultOfMethodCallIgnored
            f.delete();
        if (readyVersion(ctx) == null) cleanup(ctx);
    }

    /** versionName of the downloaded update when it is a newer Questboard, else null. */
    static String readyVersion(Context ctx) {
        File f = apk(ctx);
        if (!f.exists()) return null;
        try {
            PackageInfo pi = ctx.getPackageManager().getPackageArchiveInfo(f.getAbsolutePath(), 0);
            if (pi == null || !ctx.getPackageName().equals(pi.packageName)) return null;
            long vc = Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
            return vc > currentVersionCode(ctx) ? pi.versionName : null;
        } catch (Exception e) { return null; }
    }

    static long currentVersionCode(Context ctx) {
        try {
            PackageInfo pi = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            return Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
        } catch (Exception e) { return 0; }
    }

    /** Downloads url into the private cache and checks it is a newer Questboard. Runs on a worker thread. */
    static void download(Context ctx, String url, Progress p) {
        File out = apk(ctx);
        File part = new File(dir(ctx), "next.apk.part");
        HttpURLConnection c = null;
        try {
            cleanup(ctx);
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setInstanceFollowRedirects(true);
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            c.setRequestProperty("User-Agent", "Questboard-Android/" + BuildConfig.VERSION_NAME);
            int code = c.getResponseCode();
            if (code / 100 != 2) throw new Exception("download failed (HTTP " + code + ")");
            long total = c.getContentLengthLong(), done = 0, lastTick = 0;
            try (InputStream in = c.getInputStream(); OutputStream os = new FileOutputStream(part)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) {
                    os.write(buf, 0, n);
                    done += n;
                    long now = System.currentTimeMillis();
                    if (now - lastTick > 250) { lastTick = now; p.on("downloading", done, total, null); }
                }
            }
            if (!part.renameTo(out)) throw new Exception("could not save the update");
            PackageInfo pi = ctx.getPackageManager().getPackageArchiveInfo(out.getAbsolutePath(), 0);
            if (pi == null) throw new Exception("the download is not an Android app");
            if (!ctx.getPackageName().equals(pi.packageName)) throw new Exception("the download is not Questboard");
            long vc = Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
            if (vc <= currentVersionCode(ctx)) throw new Exception("the download is not newer than this version");
            p.on("ready", out.length(), out.length(), pi.versionName);
        } catch (Exception e) {
            cleanup(ctx);
            p.on("failed", 0, 0, e.getMessage() == null ? e.toString() : e.getMessage());
        } finally {
            if (c != null) c.disconnect();
        }
    }

    static boolean canInstall(Context ctx) {
        return ctx.getPackageManager().canRequestPackageInstalls();
    }

    /**
     * Hands the downloaded APK to PackageInstaller; Android then asks the user once. Our copy stays
     * until the new version starts (cleanupStale) so a cancelled confirm can be retried without a
     * second download.
     */
    static void install(Context ctx) throws Exception {
        File f = apk(ctx);
        if (!f.exists()) throw new Exception("no update downloaded");
        PackageInstaller pi = ctx.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(ctx.getPackageName());
        params.setSize(f.length());
        if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
        int id = pi.createSession(params);
        try (PackageInstaller.Session s = pi.openSession(id)) {
            try (InputStream in = new FileInputStream(f); OutputStream os = s.openWrite("questboard.apk", 0, f.length())) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                s.fsync(os);
            }
            Intent i = new Intent(ctx, InstallReceiver.class);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            PendingIntent pending = PendingIntent.getBroadcast(ctx, id, i, flags);
            UpdatedReceiver.markStarted(ctx);
            s.commit(pending.getIntentSender());
        }
    }

    static void openInstallPermission(Context ctx) {
        Intent i = new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, android.net.Uri.parse("package:" + ctx.getPackageName()));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx.startActivity(i);
    }
}
