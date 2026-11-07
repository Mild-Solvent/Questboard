package com.mildsolvent.questboard;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;

/** Gets PackageInstaller's answers for an in-app update and shows Android's confirm screen when asked. */
public class InstallReceiver extends BroadcastReceiver {
    interface Listener { void on(String state, String message); }
    static Listener listener;

    @Override
    public void onReceive(Context ctx, Intent intent) {
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        String msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm != null) {
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try { ctx.startActivity(confirm); } catch (Exception e) { report("failed", "could not open the installer: " + e.getMessage()); return; }
            }
            report("confirming", null);
        } else if (status == PackageInstaller.STATUS_SUCCESS) {
            Updater.cleanup(ctx);
            report("installed", null);                       // normally the app is already being replaced
        } else if (status == PackageInstaller.STATUS_FAILURE_ABORTED) {
            report("cancelled", null);
        } else {
            Updater.cleanup(ctx);                            // e.g. signed with another key: never retry this file
            report("failed", msg == null ? "install failed (" + status + ")" : msg);
        }
    }

    private static void report(String state, String message) {
        Listener l = listener;
        if (l != null) l.on(state, message);
    }
}
