# Sync your Questboard

Out of the box Questboard keeps your board on the device you use. Nothing is
uploaded and nothing is shared. Turn on sync when you want your PC, your phone
and any other device to share one board.

Sync needs a tiny server that you run yourself. It holds two files: your quests
(`QUESTS.md`) and your progress log (`progress.json`). Every device with your
**address and token** shares that board, so keep the token private, and never
use someone else's address and token, because you would be editing their board.

## What you need

- A Linux machine that stays on: a home server, a Raspberry Pi, a small VPS or a
  cloud dev box. It needs `python3` (no extra packages), `systemd` and `git`.
- [Tailscale](https://tailscale.com) on that machine, with
  [Funnel](https://tailscale.com/kb/1223/funnel) allowed in your tailnet's
  settings. Funnel gives the server a public HTTPS address, so your phone works
  on mobile data too.

## Set it up (about 5 minutes)

```bash
git clone https://github.com/Mild-Solvent/Questboard.git
cd Questboard
bash sync-server/install.sh
```

The script installs a user service (`questboard-sync`), creates
`~/questboard-data/` with a random token, publishes it with Funnel, and prints
your **sync address**, for example `https://box.your-tailnet.ts.net/questboard`.

Show your token (only to yourself):

```bash
cat ~/questboard-data/token
```

Check it works: open `<sync address>/health` in a browser. It should say
`{"ok": true}`.

## Connect the apps

- **Windows:** title bar → **Sync**. Paste the address and the token, press
  **Test**, then **Save & sync**.
- **Android:** the gear → **Sync**. Paste the address and the token, then save.

Do the same on every device you own. The first device to connect uploads its
board, and the others adopt it. After that, every change is merged quest by
quest, so two devices can edit at the same time.

## Two people on one machine

If a friend wants their own board on the same machine, they must **not** use
your address and token. Give them a separate server with its own name, port,
data folder and token:

```bash
QB_NAME=questboard-sam QB_PORT=8788 bash sync-server/install.sh
cat ~/questboard-sam-data/token
```

Their address ends in `/questboard-sam`. The two boards never mix.

## Backups

The server keeps a copy of both files on every change, in
`~/<name>-data/history/` (the last 5000 versions). The apps keep their own
copies too. **Backups** in the app footer lists them and restores any one.

## Let your AI agent do it

Paste this to an agent (Claude Code, for example) that can work on your machine:

```text
Set up a Questboard sync server for me, so my Questboard apps (Windows and Android) share one quest board.

Questboard is open source: https://github.com/Mild-Solvent/Questboard
The server is sync-server/server.py (Python 3 standard library only, no packages) and sync-server/install.sh installs it as a systemd user service and publishes it with Tailscale Funnel. The full guide is docs/SYNC.md in that repo; read it first.

What I need from you:
1. Pick a Linux machine I control that stays on (a home server, a Raspberry Pi, a small VPS or a cloud dev box). Check it has python3, systemd and Tailscale with Funnel allowed for this tailnet. If Tailscale or Funnel is missing, tell me exactly what to enable and wait for me.
2. Clone https://github.com/Mild-Solvent/Questboard there and run: bash sync-server/install.sh
   If a Questboard sync server for someone else already runs on that machine, do NOT reuse it. Install a separate one instead: QB_NAME=questboard-<my-name> QB_PORT=<a free port such as 8788> bash sync-server/install.sh
   Each one has its own data folder, token and URL path, so two people's boards never mix.
3. Check that https://<machine>.<tailnet>.ts.net/<path>/health answers {"ok": true}.
4. Give me the sync address (the https URL ending in the path, for example /questboard). Do not print the token in the chat. Tell me the command to show it myself (cat ~/<name>-data/token) so I can paste it into the app.
5. In the app: title bar (Windows) or the gear (Android), then Sync. Paste the address and the token, press Test, then Save.

Rules: never send my token anywhere else, never point my apps at another person's server, and do not open any port other than through Tailscale Funnel.
```

The same text is in [`docs/sync-agent-prompt.txt`](sync-agent-prompt.txt).

## The API (for other clients)

All paths are under the server's path (default `/questboard`).

| Request | What it does |
| --- | --- |
| `GET /health` | `{"ok": true}`, no token needed |
| `GET /QUESTS.md`, `GET /progress.json` | body plus `ETag: "<sha256>"` |
| `PUT /QUESTS.md`, `PUT /progress.json` | full body; `If-Match: "<etag>"` once the file exists. A mismatch returns 412 with the current body and ETag, so you can merge and retry |
| `GET /history/<file>` | saved versions, newest first |
| `GET /history/<file>/<id>` | one saved version |

Every request except `/health` needs `Authorization: Bearer <token>`.
