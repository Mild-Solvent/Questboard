# Questboard

A game-themed questboard for Windows that opens by itself when Windows starts,
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

With sync on (title bar → Sync, enter the devbox address and token), the board is
shared with every other device: the devbox keeps the master copy in
`~/questboard-data/`, served by `sync-server/server.py` behind `tailscale funnel`.
Each app merges its local copy with the devbox copy (quest by quest, so two devices
can edit at once) and pushes completions to a shared progress log, which is what
XP and levels are computed from. See `sync-server/install.sh` for deployment.

```
## Active: Experiment Echo      <- "Active:" boards are featured
- [ ] Make the trailer           <- a quest
- [x] Bugfix the demo            <- a done quest
- a plain note                   <- shown as a note, not a quest
```

XP and level live next to it in `state.json`.

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

Pushing to `main` with a new `version` in `package.json` builds the installer on
GitHub Actions and publishes release `v<version>`, which installed apps pick up.
