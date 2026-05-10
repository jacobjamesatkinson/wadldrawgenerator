# CORS and running this tool

Browsers block cross-origin `fetch` unless the Tabbycat server sends `Access-Control-Allow-Origin` for your static site’s origin (or `*`). Many Tabbycat deployments **do not** allow arbitrary browser origins, so you may see network errors even with a valid token.

## Run locally over HTTP

ES modules require a server (opening `index.html` as `file://` often fails):

```bash
cd /path/to/staffdrawgeneration
python3 -m http.server 8080
```

Open `http://127.0.0.1:8080`.

## If API calls are blocked by CORS

Pick one:

1. **Same-origin reverse proxy** — Serve this static folder from a host that also proxies `/api/` to your Tabbycat base URL (nginx `proxy_pass`, Caddy, etc.). Point the app’s custom base URL at that same origin (or adjust `fetch` paths in `js/tabbycat.js`).

2. **Small serverless proxy** — A Cloudflare Worker / similar that forwards `Authorization` and the request path to `https://draw.wadl.org` or your staging Heroku URL. The static page then calls only your worker’s origin.

3. **Tabbycat CORS settings** — If you control the Tabbycat install, configure it to allow your static site’s origin (only do this if you understand the security implications of browser-exposed tokens).

## “Clear entire draw” and network errors

A bare **NetworkError** / **Failed to fetch** means the browser never got a normal HTTP response (CORS, DNS, TLS, offline, wrong URL, etc.) — same fixes as above.

If Tabbycat returns **500** on bulk `DELETE …/rounds/{n}/pairings`, the app automatically **lists debates for that round** and sends **per-debate DELETE** requests. If those also fail, the problem is usually permissions, ballots/conflicts on the server, or still CORS/connectivity.

## Token safety

The token is entered in the page and sent from the browser. Anyone with access to the machine or malicious extensions could read it. Use a **tab-room-only** account and rotate tokens if exposed.
