# Questboard in the browser

`node web/build.js` writes a static copy of the board to `web/out/` that runs in any
modern browser. It is the same renderer as the desktop app; only the Electron bridge is
replaced by `web/shim.js` (data in localStorage, sync over HTTP).

Serve `web/out/` from anything that can also forward `web/out/api/*` to the sync server
(`sync-server/server.py` on `127.0.0.1:8787/questboard/*`) and add the
`Authorization: Bearer <token>` header on the way. The page then needs no token at all:
it sends `Bearer proxy`, and the proxy swaps in the real one. Keep that proxy on a private
network (tailnet or localhost); whoever can open the page can edit the board.

To point the page straight at the public sync endpoint instead, build with
`node web/build.js --base-url https://<host>/questboard --token <token>` and keep the
output private, because the token is then inside `config.js`.
