#!/usr/bin/env bash
# Install the Questboard sync server as a user service on the devbox and expose it with tailscale funnel.
# Usage: bash sync-server/install.sh   (run from the Questboard repo clone; needs tailscale with funnel enabled)
# A second, separate board on the same machine (someone else's quests):
#   QB_NAME=questboard-sam QB_PORT=8788 bash sync-server/install.sh
# gives its own service, data folder, token, port and URL path, so the two boards never mix.
set -euo pipefail
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NAME="${QB_NAME:-questboard}"
DATA_DIR="${QB_DATA_DIR:-$HOME/$NAME-data}"
PORT="${QB_PORT:-8787}"
mkdir -p "$DATA_DIR" "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/$NAME-sync.service" <<UNIT
[Unit]
Description=Questboard sync server ($NAME)
After=network.target

[Service]
Environment=QB_DATA_DIR=$DATA_DIR
Environment=QB_PORT=$PORT
Environment=QB_PREFIX=$NAME
ExecStart=/usr/bin/env python3 $REPO_DIR/sync-server/server.py
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now "$NAME-sync.service"
loginctl enable-linger "$USER" >/dev/null 2>&1 || true
sleep 1
curl -fsS "http://127.0.0.1:$PORT/$NAME/health" && echo
tailscale funnel --bg --https=443 --set-path "/$NAME" "http://127.0.0.1:$PORT/$NAME"
echo "Sync address: https://$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')/$NAME"
echo "Token is in $DATA_DIR/token (keep it private)."
tailscale funnel status
