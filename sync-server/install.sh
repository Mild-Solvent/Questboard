#!/usr/bin/env bash
# Install the Questboard sync server as a user service on the devbox and expose it with tailscale funnel.
# Usage: bash sync-server/install.sh   (run from the Questboard repo clone; needs tailscale with funnel enabled)
set -euo pipefail
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${QB_DATA_DIR:-$HOME/questboard-data}"
PORT="${QB_PORT:-8787}"
mkdir -p "$DATA_DIR" "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/questboard-sync.service" <<UNIT
[Unit]
Description=Questboard sync server
After=network.target

[Service]
Environment=QB_DATA_DIR=$DATA_DIR
Environment=QB_PORT=$PORT
ExecStart=/usr/bin/env python3 $REPO_DIR/sync-server/server.py
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now questboard-sync.service
loginctl enable-linger "$USER" >/dev/null 2>&1 || true
sleep 1
curl -fsS "http://127.0.0.1:$PORT/questboard/health" && echo
tailscale funnel --bg --https=443 --set-path /questboard "http://127.0.0.1:$PORT/questboard"
echo "Token is in $DATA_DIR/token (keep it private)."
tailscale funnel status
