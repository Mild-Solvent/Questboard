package com.mildsolvent.questboard;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Runs in the new version right after an in-app update replaced the app. Android 10+ does not let an
 * app reopen itself from the background, so it posts a "Questboard updated · tap to open"
 * notification instead (and still tries the direct launch, which works on older Android). Only when
 * the update was started from inside the app in the last 10 minutes.
 */
public class UpdatedReceiver extends BroadcastReceiver {
    static final String PREFS = "questboard_updater";
    static final int NOTIFY_ID = 7;

    static void markStarted(Context ctx) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putLong("startedAt", System.currentTimeMillis()).apply();
    }

    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (!Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) return;
        Updater.cleanup(ctx);
        long at = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong("startedAt", 0);
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove("startedAt").apply();
        if (System.currentTimeMillis() - at > 10 * 60 * 1000) return;
        Intent open = new Intent(ctx, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        try { ctx.startActivity(open); } catch (Exception ignored) { }
        try {
            NotificationManager nm = ctx.getSystemService(NotificationManager.class);
            nm.createNotificationChannel(new NotificationChannel("updates", "App updates", NotificationManager.IMPORTANCE_HIGH));
            PendingIntent tap = PendingIntent.getActivity(ctx, 1, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            Notification n = new Notification.Builder(ctx, "updates")
                    .setSmallIcon(R.drawable.ic_stat_quest)
                    .setContentTitle("Questboard updated to v" + BuildConfig.VERSION_NAME)
                    .setContentText("Tap to open your board")
                    .setContentIntent(tap)
                    .setAutoCancel(true)
                    .build();
            nm.notify(NOTIFY_ID, n);
        } catch (Exception ignored) { }                      // no notification permission: user taps the icon
    }
}
