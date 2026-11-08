package com.mildsolvent.questboard;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.MediaStore;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * A copy of the board outside the app (Father, 2026-11-08: "make the backups survive no matter what so
 * they can install and their board will pop up"). The app's own files are wiped when it is uninstalled,
 * so every change to the board is also written to Documents/Questboard/ on the phone:
 * QUESTS.md, progress.json and prefs.json (theme, sound, sync address and token).
 *
 * Where it writes:
 *  - a folder the user picked with "Restore from saved copy" (kept as a persisted SAF grant), else
 *  - Documents/Questboard/ through MediaStore (Android 10+, no permission needed).
 * After a reinstall the app first tries to read that copy by itself; Android often hides files made
 * by the earlier install, so the board then offers "Restore": the user picks Documents/Questboard once,
 * the board comes back and the copy keeps going to that folder. No sync server is involved.
 */
final class SafeCopy {
    static final String DIR = "Questboard";
    static final String[] FILES = { "QUESTS.md", "progress.json", "prefs.json" };
    private static final String RELATIVE = Environment.DIRECTORY_DOCUMENTS + "/" + DIR + "/";
    private static final String PREF_TREE = "safeCopyTree";
    private static final String PREF_SAVED_AT = "safeCopySavedAt";
    private static final String MIME = "application/octet-stream";   // keeps the exact file names

    private static final ExecutorService IO = Executors.newSingleThreadExecutor();
    private static final Map<String, String> PENDING = new LinkedHashMap<>();

    private SafeCopy() { }

    static boolean isMirrored(String name) {
        for (String f : FILES) if (f.equals(name)) return true;
        return false;
    }

    private static SharedPreferences meta(Context ctx) { return ctx.getSharedPreferences("safecopy", Context.MODE_PRIVATE); }

    static Uri tree(Context ctx) {
        String s = meta(ctx).getString(PREF_TREE, null);
        return s == null ? null : Uri.parse(s);
    }

    static long savedAt(Context ctx) { return meta(ctx).getLong(PREF_SAVED_AT, 0); }

    static boolean available(Context ctx) { return tree(ctx) != null || Build.VERSION.SDK_INT >= 29; }

    static String where(Context ctx) {
        Uri t = tree(ctx);
        if (t != null) {
            String id = DocumentsContract.getTreeDocumentId(t);
            int colon = id.indexOf(':');
            return colon >= 0 ? id.substring(colon + 1) : id;
        }
        return Build.VERSION.SDK_INT >= 29 ? "Documents/" + DIR : null;
    }

    /** Queues a write of name to the saved copy; the newest text wins if writes pile up. */
    static void save(Context ctx, String name, String text) {
        if (!isMirrored(name)) return;
        final Context app = ctx.getApplicationContext();
        synchronized (PENDING) {
            boolean queued = !PENDING.isEmpty();
            PENDING.put(name, text == null ? "" : text);
            if (queued) return;
        }
        IO.execute(() -> flush(app));
    }

    private static void flush(Context ctx) {
        while (true) {
            String name, text;
            synchronized (PENDING) {
                if (PENDING.isEmpty()) return;
                Map.Entry<String, String> e = PENDING.entrySet().iterator().next();
                name = e.getKey(); text = e.getValue();
                PENDING.remove(name);
            }
            try {
                if (write(ctx, name, text)) meta(ctx).edit().putLong(PREF_SAVED_AT, System.currentTimeMillis()).apply();
            } catch (Exception ignored) { /* the app's own copy is still there */ }
        }
    }

    private static boolean write(Context ctx, String name, String text) throws Exception {
        byte[] data = text.getBytes(StandardCharsets.UTF_8);
        Uri t = tree(ctx);
        if (t != null) {
            Uri doc = findInTree(ctx, t, name);
            ContentResolver cr = ctx.getContentResolver();
            if (doc == null) doc = DocumentsContract.createDocument(cr, DocumentsContract.buildDocumentUriUsingTree(t, DocumentsContract.getTreeDocumentId(t)), MIME, name);
            if (doc == null) return false;
            try (OutputStream os = cr.openOutputStream(doc, "wt")) { if (os == null) return false; os.write(data); }
            return true;
        }
        if (Build.VERSION.SDK_INT < 29) return false;
        ContentResolver cr = ctx.getContentResolver();
        Uri uri = findInMediaStore(ctx, name);
        if (uri == null) {
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, MIME);
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, RELATIVE);
            uri = cr.insert(MediaStore.Files.getContentUri("external"), v);
            if (uri == null) return false;
        }
        try (OutputStream os = cr.openOutputStream(uri, "wt")) { if (os == null) return false; os.write(data); }
        return true;
    }

    /** One of our files in Documents/Questboard that this install can see (its own, or re-attributed ones). */
    private static Uri findInMediaStore(Context ctx, String name) {
        if (Build.VERSION.SDK_INT < 29) return null;
        Uri base = MediaStore.Files.getContentUri("external");
        String[] cols = { MediaStore.MediaColumns._ID };
        String sel = MediaStore.MediaColumns.RELATIVE_PATH + "=? AND " + MediaStore.MediaColumns.DISPLAY_NAME + "=?";
        try (Cursor c = ctx.getContentResolver().query(base, cols, sel, new String[] { RELATIVE, name }, MediaStore.MediaColumns.DATE_MODIFIED + " DESC")) {
            if (c != null && c.moveToFirst()) return ContentUris.withAppendedId(base, c.getLong(0));
        } catch (Exception ignored) { }
        return null;
    }

    private static Uri findInTree(Context ctx, Uri tree, String name) {
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
        String[] cols = { DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME };
        try (Cursor c = ctx.getContentResolver().query(children, cols, null, null, null)) {
            while (c != null && c.moveToNext()) {
                if (name.equals(c.getString(1))) return DocumentsContract.buildDocumentUriUsingTree(tree, c.getString(0));
            }
        } catch (Exception ignored) { }
        return null;
    }

    private static String read(Context ctx, Uri uri) {
        try (InputStream in = ctx.getContentResolver().openInputStream(uri)) {
            if (in == null) return null;
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } catch (Exception e) { return null; }
    }

    /** Puts a saved copy back into the app's own storage. Returns false when there is no QUESTS.md. */
    private static boolean restore(Context ctx, Map<String, String> found, File appDir, SharedPreferences prefs) {
        String quests = found.get("QUESTS.md");
        if (quests == null || quests.trim().isEmpty()) return false;
        if (!appDir.exists()) appDir.mkdirs();
        for (Map.Entry<String, String> e : found.entrySet()) {
            if (e.getKey().equals("prefs.json")) { prefs.edit().putString("json", e.getValue()).commit(); continue; }
            File f = new File(appDir, e.getKey());
            File tmp = new File(f.getPath() + ".tmp");
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                out.write(e.getValue().getBytes(StandardCharsets.UTF_8));
                out.getFD().sync();
            } catch (Exception ex) { continue; }
            //noinspection ResultOfMethodCallIgnored
            tmp.renameTo(f);
        }
        // sync metadata from the old install does not apply any more: next sync merges from scratch
        for (String stale : new String[] { "sync.json", "base.QUESTS.md", "base.progress.json" }) //noinspection ResultOfMethodCallIgnored
            new File(appDir, stale).delete();
        return true;
    }

    /**
     * On a fresh start (no board in the app's storage): reads Documents/Questboard if this install can
     * see it and restores it without asking. Returns true when the board came back.
     */
    static boolean autoRestore(Context ctx, File appDir, SharedPreferences prefs) {
        if (new File(appDir, "QUESTS.md").exists()) return false;
        Map<String, String> found = new LinkedHashMap<>();
        Uri t = tree(ctx);
        for (String name : FILES) {
            Uri u = t != null ? findInTree(ctx, t, name) : findInMediaStore(ctx, name);
            String text = u == null ? null : read(ctx, u);
            if (text != null) found.put(name, text);
        }
        return restore(ctx, found, appDir, prefs);
    }

    /** The system folder picker, opening at Documents/Questboard where possible. */
    static Intent pickIntent() {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        if (Build.VERSION.SDK_INT >= 26) {
            Uri initial = DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", "primary:" + RELATIVE.substring(0, RELATIVE.length() - 1));
            i.putExtra(DocumentsContract.EXTRA_INITIAL_URI, initial);
        }
        return i;
    }

    /**
     * The user picked a folder. Keeps it as the place for the saved copy from now on. If it holds a
     * board, that board replaces the one in the app ("restored"); else the current board is written
     * there ("empty").
     */
    static String usePicked(Context ctx, Uri tree, File appDir, SharedPreferences prefs) {
        try {
            ctx.getContentResolver().takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (Exception ignored) { }
        meta(ctx).edit().putString(PREF_TREE, tree.toString()).commit();
        Map<String, String> found = new LinkedHashMap<>();
        for (String name : FILES) {
            Uri u = findInTree(ctx, tree, name);
            String text = u == null ? null : read(ctx, u);
            if (text != null) found.put(name, text);
        }
        if (restore(ctx, found, appDir, prefs)) return "restored";
        // nothing there yet: start the copy in this folder with what the app has now
        for (String name : FILES) {
            String text;
            if (name.equals("prefs.json")) text = prefs.getString("json", "{}");
            else {
                File f = new File(appDir, name);
                if (!f.exists()) continue;
                try { text = new String(java.nio.file.Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8); } catch (Exception e) { continue; }
            }
            save(ctx, name, text);
        }
        return "empty";
    }
}
