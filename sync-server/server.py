#!/usr/bin/env python3
"""Questboard sync server: a tiny authenticated file store for QUESTS.md and progress.json.

Runs on the devbox; exposed through `tailscale funnel`. Stdlib only.

  GET  /questboard/health              -> {"ok": true}            (no auth)
  GET  /questboard/<file>              -> body, ETag: "<sha256>"  (Bearer token)
  PUT  /questboard/<file>              -> full body; If-Match: "<etag>" required once the file exists.
                                          412 + current body + ETag on mismatch. 200/201 + new ETag on success.

  GET  /questboard/history/<file>      -> JSON list of saved versions, newest first   (Bearer token)
  GET  /questboard/history/<file>/<id> -> that version's body                          (Bearer token)

Every accepted write that changes a file is also kept in <data>/history/<file>/<UTC time>.<ext>,
so any earlier board can be restored (fetch a version, then PUT it back like a normal edit).
Files allowed: QUESTS.md, progress.json. Data dir and token file come from env or defaults.

More boards on the same server (one per person, e.g. one per devbox panel admin):
  /questboard/u/<name>/<file>, /questboard/u/<name>/health, /questboard/u/<name>/history/...
Each one lives in <data>/boards/<name>/ with its own token file, so a token only opens its own board.
The main board (the URLs without /u/<name>) stays exactly where it was. Boards are made from the
command line, never over HTTP:
  python3 server.py create-board <name>     (prints the board folder; the token is in <folder>/token)
"""
import hashlib
import json
import os
import secrets
import sys
import re
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DATA_DIR = os.environ.get("QB_DATA_DIR", os.path.expanduser("~/questboard-data"))
TOKEN_FILE = os.environ.get("QB_TOKEN_FILE", os.path.join(DATA_DIR, "token"))
PORT = int(os.environ.get("QB_PORT", "8787"))
PREFIX = "/" + os.environ.get("QB_PREFIX", "questboard").strip("/") + "/"   # URL path, e.g. QB_PREFIX=questboard-sam
FILES = {"QUESTS.md": "text/markdown; charset=utf-8", "progress.json": "application/json; charset=utf-8"}
LOCK = threading.Lock()
BOARDS_DIR = os.path.join(DATA_DIR, "boards")
BOARD_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
HISTORY_KEEP = int(os.environ.get("QB_HISTORY_KEEP", "5000"))   # versions kept per file (they are a few KB each)
VERSION_ID = re.compile(r"^\d{8}T\d{6}\d{6}Z\.(md|json)$")


def load_token(token_file=TOKEN_FILE):
    os.makedirs(os.path.dirname(token_file), exist_ok=True)
    if not os.path.exists(token_file):
        fd = os.open(token_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(secrets.token_urlsafe(32) + "\n")
    with open(token_file, encoding="utf-8") as f:
        return f.read().strip()


class Board:
    """One person's quest files: the main board (DATA_DIR) or <data>/boards/<name>/."""

    def __init__(self, data_dir, token_file):
        self.data_dir = data_dir
        self.token_file = token_file

    def token(self):
        try:
            with open(self.token_file, encoding="utf-8") as f:
                return f.read().strip()
        except OSError:
            return ""


MAIN = Board(DATA_DIR, TOKEN_FILE)


def board_for(name):
    """The named extra board, or None when there is no such board (boards are never made over HTTP)."""
    if not BOARD_NAME.match(name or ""):
        return None
    d = os.path.join(BOARDS_DIR, name)
    tf = os.path.join(d, "token")
    if not os.path.isfile(tf):
        return None
    return Board(d, tf)


def create_board(name):
    if not BOARD_NAME.match(name or ""):
        raise SystemExit(f"bad board name {name!r}: use a-z, 0-9, - and _ (max 32)")
    d = os.path.join(BOARDS_DIR, name)
    os.makedirs(d, exist_ok=True)
    load_token(os.path.join(d, "token"))
    return d


def etag_of(data: bytes) -> str:
    return '"' + hashlib.sha256(data).hexdigest() + '"'


def read_file(board, name):
    p = os.path.join(board.data_dir, name)
    if not os.path.exists(p):
        return None
    with open(p, "rb") as f:
        return f.read()


def write_file(board, name, data: bytes):
    p = os.path.join(board.data_dir, name)
    tmp = p + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, p)


def history_dir(board, name):
    return os.path.join(board.data_dir, "history", name)


def snapshot(board, name, data: bytes):
    """Keep a copy of this version of `name`; skip if identical to the newest kept copy."""
    d = history_dir(board, name)
    os.makedirs(d, exist_ok=True)
    versions = sorted(os.listdir(d))
    if versions:
        with open(os.path.join(d, versions[-1]), "rb") as f:
            if f.read() == data:
                return
    ext = name.rsplit(".", 1)[1]
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    with open(os.path.join(d, f"{stamp}.{ext}"), "wb") as f:
        f.write(data)
    for old in versions[: max(0, len(versions) + 1 - HISTORY_KEEP)]:
        os.remove(os.path.join(d, old))


def summarize(name, data: bytes):
    text = data.decode("utf-8", "replace")
    if name == "QUESTS.md":
        open_q = len(re.findall(r"^\s*[-*] \[ \]", text, re.M))
        done_q = len(re.findall(r"^\s*[-*] \[[xX]\]", text, re.M))
        boards = len(re.findall(r"^## ", text, re.M))
        return {"open": open_q, "done": done_q, "boards": boards}
    try:
        return {"log": len(json.loads(text).get("log", []))}
    except Exception:
        return {}


def list_history(board, name, limit=400):
    d = history_dir(board, name)
    if not os.path.isdir(d):
        return []
    out = []
    for v in sorted(os.listdir(d), reverse=True)[:limit]:
        if not VERSION_ID.match(v):
            continue
        with open(os.path.join(d, v), "rb") as f:
            data = f.read()
        at = datetime.strptime(v.split(".")[0], "%Y%m%dT%H%M%S%fZ").replace(tzinfo=timezone.utc)
        out.append({"id": v, "at": at.isoformat().replace("+00:00", "Z"), "size": len(data), **summarize(name, data)})
    return out


class Handler(BaseHTTPRequestHandler):
    server_version = "QuestboardSync/1"

    def log_message(self, fmt, *args):  # quieter logs, no bodies
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, code, body: bytes, ctype="application/json; charset=utf-8", etag=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, If-Match")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, OPTIONS")
        self.send_header("Access-Control-Expose-Headers", "ETag")
        if etag:
            self.send_header("ETag", etag)
        self.end_headers()
        self.wfile.write(body)

    def _authed(self, board):
        auth = self.headers.get("Authorization", "")
        token = board.token()
        return bool(token) and auth.startswith("Bearer ") and secrets.compare_digest(auth[7:].strip().encode(), token.encode())

    def _route(self):
        """(board, rest of the path) or (None, None). /u/<name>/... picks an extra board."""
        if not self.path.startswith(PREFIX):
            return None, None
        name = self.path[len(PREFIX):].split("?")[0]
        if name.startswith("u/"):
            parts = name.split("/", 2)
            board = board_for(parts[1]) if len(parts) == 3 else None
            return (board, parts[2]) if board else (None, None)
        return MAIN, name

    def do_OPTIONS(self):
        self._send(204, b"")

    def do_GET(self):
        board, name = self._route()
        if board is None:
            return self._send(404, b'{"error":"not found"}')
        if name == "health":
            return self._send(200, b'{"ok":true}')
        if name and name.startswith("history/"):
            if not self._authed(board):
                return self._send(401, b'{"error":"unauthorized"}')
            parts = name.split("/")
            if len(parts) == 2 and parts[1] in FILES:
                with LOCK:
                    items = list_history(board, parts[1])
                return self._send(200, json.dumps(items).encode())
            if len(parts) == 3 and parts[1] in FILES and VERSION_ID.match(parts[2]):
                p = os.path.join(history_dir(board, parts[1]), parts[2])
                if os.path.exists(p):
                    with open(p, "rb") as f:
                        return self._send(200, f.read(), FILES[parts[1]])
            return self._send(404, b'{"error":"not found"}')
        if name not in FILES:
            return self._send(404, b'{"error":"not found"}')
        if not self._authed(board):
            return self._send(401, b'{"error":"unauthorized"}')
        with LOCK:
            data = read_file(board, name)
        if data is None:
            return self._send(404, b'{"error":"no such file yet"}')
        self._send(200, data, FILES[name], etag_of(data))

    def do_PUT(self):
        board, name = self._route()
        if board is None or name not in FILES:
            return self._send(404, b'{"error":"not found"}')
        if not self._authed(board):
            return self._send(401, b'{"error":"unauthorized"}')
        length = int(self.headers.get("Content-Length", "0"))
        if length > 2_000_000:
            return self._send(413, b'{"error":"too large"}')
        body = self.rfile.read(length)
        if name == "progress.json":
            try:
                json.loads(body.decode("utf-8"))
            except Exception:
                return self._send(400, b'{"error":"progress.json must be valid JSON"}')
        if_match = self.headers.get("If-Match")
        with LOCK:
            current = read_file(board, name)
            if current is not None:
                if if_match is None or if_match.strip() != etag_of(current):
                    return self._send(412, current, FILES[name], etag_of(current))
            write_file(board, name, body)
            try:
                snapshot(board, name, body)
            except OSError as e:  # a failed backup must never fail the write itself
                sys.stderr.write(f"history snapshot failed for {name}: {e}\n")
        self._send(200 if current is not None else 201, b'{"ok":true}', etag=etag_of(body))


def main():
    if sys.argv[1:2] == ["create-board"] and len(sys.argv) == 3:
        print(create_board(sys.argv[2]))
        return
    os.makedirs(DATA_DIR, exist_ok=True)
    load_token()
    boards = [MAIN]
    if os.path.isdir(BOARDS_DIR):
        boards += [b for b in (board_for(n) for n in sorted(os.listdir(BOARDS_DIR))) if b]
    for board in boards:  # make sure every current board is in its history from the first start on
        for name in FILES:
            data = read_file(board, name)
            if data is not None:
                snapshot(board, name, data)
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"questboard sync on http://127.0.0.1:{PORT}{PREFIX}  data={DATA_DIR}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
