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
HISTORY_DIR = os.path.join(DATA_DIR, "history")
HISTORY_KEEP = int(os.environ.get("QB_HISTORY_KEEP", "5000"))   # versions kept per file (they are a few KB each)
VERSION_ID = re.compile(r"^\d{8}T\d{6}\d{6}Z\.(md|json)$")


def load_token():
    os.makedirs(DATA_DIR, exist_ok=True)
    if not os.path.exists(TOKEN_FILE):
        with open(TOKEN_FILE, "w", encoding="utf-8") as f:
            f.write(secrets.token_urlsafe(32) + "\n")
        os.chmod(TOKEN_FILE, 0o600)
    with open(TOKEN_FILE, encoding="utf-8") as f:
        return f.read().strip()


TOKEN = load_token()


def etag_of(data: bytes) -> str:
    return '"' + hashlib.sha256(data).hexdigest() + '"'


def read_file(name):
    p = os.path.join(DATA_DIR, name)
    if not os.path.exists(p):
        return None
    with open(p, "rb") as f:
        return f.read()


def write_file(name, data: bytes):
    p = os.path.join(DATA_DIR, name)
    tmp = p + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, p)


def history_dir(name):
    return os.path.join(HISTORY_DIR, name)


def snapshot(name, data: bytes):
    """Keep a copy of this version of `name`; skip if identical to the newest kept copy."""
    d = history_dir(name)
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


def list_history(name, limit=400):
    d = history_dir(name)
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

    def _authed(self):
        auth = self.headers.get("Authorization", "")
        return auth.startswith("Bearer ") and secrets.compare_digest(auth[7:].strip(), TOKEN)

    def _route(self):
        if not self.path.startswith(PREFIX):
            return None
        name = self.path[len(PREFIX):].split("?")[0]
        return name

    def do_OPTIONS(self):
        self._send(204, b"")

    def do_GET(self):
        name = self._route()
        if name == "health":
            return self._send(200, b'{"ok":true}')
        if name and name.startswith("history/"):
            if not self._authed():
                return self._send(401, b'{"error":"unauthorized"}')
            parts = name.split("/")
            if len(parts) == 2 and parts[1] in FILES:
                with LOCK:
                    items = list_history(parts[1])
                return self._send(200, json.dumps(items).encode())
            if len(parts) == 3 and parts[1] in FILES and VERSION_ID.match(parts[2]):
                p = os.path.join(history_dir(parts[1]), parts[2])
                if os.path.exists(p):
                    with open(p, "rb") as f:
                        return self._send(200, f.read(), FILES[parts[1]])
            return self._send(404, b'{"error":"not found"}')
        if name not in FILES:
            return self._send(404, b'{"error":"not found"}')
        if not self._authed():
            return self._send(401, b'{"error":"unauthorized"}')
        with LOCK:
            data = read_file(name)
        if data is None:
            return self._send(404, b'{"error":"no such file yet"}')
        self._send(200, data, FILES[name], etag_of(data))

    def do_PUT(self):
        name = self._route()
        if name not in FILES:
            return self._send(404, b'{"error":"not found"}')
        if not self._authed():
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
            current = read_file(name)
            if current is not None:
                if if_match is None or if_match.strip() != etag_of(current):
                    return self._send(412, current, FILES[name], etag_of(current))
            write_file(name, body)
            try:
                snapshot(name, body)
            except OSError as e:  # a failed backup must never fail the write itself
                sys.stderr.write(f"history snapshot failed for {name}: {e}\n")
        self._send(200 if current is not None else 201, b'{"ok":true}', etag=etag_of(body))


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    for name in FILES:  # make sure the current board is in the history from the first start on
        data = read_file(name)
        if data is not None:
            snapshot(name, data)
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"questboard sync on http://127.0.0.1:{PORT}{PREFIX}  data={DATA_DIR}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
