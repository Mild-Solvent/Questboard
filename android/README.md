# Questboard for Android

The same Tavern / Abyss questboard as the Windows app, as a phone app. It is a
full-screen WebView running the shared renderer (`styles.css`, `fx.js`,
`sound.js`, `merge.js` are copied from `../src/renderer` by
`tools/sync-renderer.sh`) plus a phone layout (`mobile.css`), a native bridge
(`Bridge.java`: files, prefs, HTTP, haptics) and the sync engine (`sync.js`).

## Install on the phone

1. On the phone, open the latest release:
   <https://github.com/Mild-Solvent/Questboard/releases/latest>
   and download `Questboard-<version>-android.apk`.
2. Open the downloaded file. Android asks to allow installs from your browser /
   Files app the first time; allow it, then **Install**. Play Protect may show
   "unknown developer": choose *Install anyway*. (The APK is signed with the
   project's own key, not a Play Store key.)
3. The board works on its own, offline. To share quests with your PC, run your
   own sync server (`sync-server/` in this repo), then tap the gear (⚙), paste
   its address and token, and tap **Save & sync**. Nothing is prefilled: every
   install starts with sync off, so a shared APK never points at anyone else's
   board.

Updates (from 0.6.0): the app checks the latest GitHub release on start and every
6 hours, downloads the new `-android.apk` in the background into its own private
storage (not Downloads), and shows **Update vX ready · Install** at the bottom.
Tap it, confirm, and Android asks once ("Update this app?"). Android does not let
an app reopen itself, so a "Questboard updated · tap to open" notification appears
(on Android 13+ the app asks once for notification permission before the first
update); your board stays as it was. The downloaded file is deleted when the new
version starts, so nothing is left to clean up. The first time, Android asks to
allow Questboard to install apps; allow it and come back, it continues by itself.
Settings → "Check for updates" checks right away. Updating from 0.5.1 or older
still needs the APK installed by hand once. Data and settings always stay.

## Use

- Tap a quest's rune (the box on the left) to complete it: burst, chime, haptic,
  XP. Tap the rune of a completed quest under *Completed* to undo. Tapping the
  text does nothing, so scrolling never ticks anything.
- Hold a quest or a board title to edit it. Removing (×), editing, the daily
  switch (↻) and Reset XP all ask before they act.
- `+ new quest` adds one to that board.
- Settings (⚙) → Sync has "How to set up your own sync" (docs/SYNC.md) and
  "Copy setup prompt" (the text in docs/sync-agent-prompt.txt, for your own AI
  agent to set up a server).
- Title bar: theme toggle (Tavern / Abyss), sound, sync now, settings.
- The board syncs on open, when you come back to the app, every 90 s while it
  is open, and about 2 s after every change. Edits made on the server (for
  example by an agent) or on the PC appear with a toast "Board updated from
  your sync server".
  Conflicts are merged quest by quest (shared `merge.js`), so completing a
  quest on the phone while the file is edited elsewhere keeps both changes.
- XP = the sum of each `progress.json` log entry's `xp` (25 for a quest; secrets carry their own and don't count as cleared quests), level n needs
  100 + 50·(n−1). The log is shared, so the level is the same on every device.

## Build

Needs JDK 17+, the Android SDK (platform 35, build-tools 35) and Gradle via the
wrapper. `tools/release.sh` does everything on a fresh Linux box (downloads the
SDK into `~/android-sdk` if missing, creates the signing key if missing, builds
the signed release APK and optionally uploads it to a GitHub release with `gh`).

```
cd android
./tools/sync-renderer.sh                 # refresh shared look from ../src/renderer
./gradlew assembleDebug                  # debug APK (debug key)
./gradlew assembleRelease                # signed if ~/questboard-signing/keystore.properties exists
node tools/ui-test.js /tmp/qb-ui         # phone-size Chromium test against sync-server/server.py
```

Signing: a `keystore.properties` outside the repo (`storeFile`, `storePassword`,
`keyAlias`, `keyPassword`), found via `QUESTBOARD_KEYSTORE_PROPS`, then the
project's private files folder `questboard/signing/`, then
`~/questboard-signing/`. The same key must sign every release, or the phone
refuses to update over the old install. Never commit it.

Versioning: bump `versionCode` (integer, always up) and `versionName` in
`app/build.gradle`; the APK is named `Questboard-<versionName>-android.apk`.
