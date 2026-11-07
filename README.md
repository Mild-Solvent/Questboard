# Questboard

A game-themed questboard for Windows and Android that opens by itself when Windows starts,
and updates itself from this repo's releases. Quests are plain Markdown on your
own PC; nothing personal lives in this repo.

## Install (Windows)

1. Download `Questboard-Setup-<version>.exe` from the latest
   [release](https://github.com/Mild-Solvent/Questboard/releases/latest).
2. Run it. It installs per-user (no admin), starts the app, and registers itself
   as a startup app ("Questboard" in Task Manager → Startup apps).
3. Closing the window hides it to the tray. Quit from the tray icon.

Windows SmartScreen may warn because the installer is not code-signed. Click
"More info" → "Run anyway". Later versions download in the background; a
"restart to update" link appears in the footer when one is ready.

## Your quests

The app reads `Documents\Questboard\QUESTS.md` and watches it, so edits from any
text editor show up on the board instantly.

Out of the box the board stays on this device. To share one board between your
PC, phone and other devices, run your own small sync server and paste its address
and token into **Sync** in the title bar. The guide, including a prompt you can
hand to your AI agent, is in [docs/SYNC.md](docs/SYNC.md).

```
## Active: Experiment Echo      <- "Active:" boards are featured
- [ ] Make the trailer           <- a quest
- [x] Bugfix the demo            <- a done quest
- a plain note                   <- shown as a note, not a quest
```

XP and level come from `progress.json` next to it.

## Use

- Click a rune (checkbox) to complete a quest: burst, chime, XP, level-ups.
- `+ new quest` on any board adds one. Right-click (or the × on hover) removes one.
- `T` switches theme (Tavern / Abyss), `M` toggles sound.
- The startup button in the title bar (or the tray menu) toggles launch-at-login.

## Develop

```
npm install
npm start            # run from source
npm run dist         # build the Windows installer into dist/ (Windows or CI)
```

Releases are built on a Linux box with Wine (`npm run dist` makes the x64 and
32-bit installers) and published as `v<version>` with the installers,
`latest.yml` and the matching Android APK. Installed Windows apps update
themselves from the latest release.

## Android

Each release also carries `Questboard-<version>-android.apk`. Install it on your
phone (allow installing from your browser when asked). It installs over earlier
versions. The Android app lives in `android/`.
