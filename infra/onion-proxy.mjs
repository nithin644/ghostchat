#!/usr/bin/env node
/**
 * Single-origin reverse proxy for Tor.
 *
 * Why this exists
 * ---------------
 * A hidden service can forward exactly one local port. The app, however, is two
 * processes (Next.js on :3000, Nest API on :4000) plus Socket.IO upgrades. This
 * proxy collapses them onto one origin so that:
 *
 *   http://<address>.onion/          -> Next.js
 *   http://<address>.onion/api/*     -> Nest API
 *   ws://<address>.onion/socket.io   -> Nest API (upgraded)
 *
 * Collapsing to one origin is also what makes relative URLs possible in the
 * browser: no `localhost` is ever baked into the bundle, so cookies stay
 * first-party and there is no CORS surface to misconfigure.
 *
 * It binds to loopback only. Tor is the only intended client; exposing this port
 * to the network would bypass the onion entirely.
 */
import http from 'node:http';
import httpProxy from 'http-proxy';

const LISTEN_HOST = process.env.PROXY_HOST ?? '0.0.0.0';
const LISTEN_PORT = Number(process.env.PROXY_PORT ?? 8080);
const WEB_TARGET = process.env.WEB_TARGET ?? 'http://127.0.0.1:3000';
const API_TARGET = process.env.API_TARGET ?? 'http://127.0.0.1:4000';

const proxy = httpProxy.createProxyServer({
  changeOrigin: false,
  ws: true,
  xfwd: true,
  proxyTimeout: 60_000,
});

proxy.on('error', (error, _req, res) => {
  // res can be a Socket on upgrade failures.
  if (res && typeof res.writeHead === 'function' && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'upstream unavailable' }));
  } else if (res && typeof res.destroy === 'function') {
    res.destroy();
  }
  process.stderr.write(`[proxy] ${error.message}\n`);
});

/** Route table. Order matters: the first match wins. */
function targetFor(url = '/') {
  if (url.startsWith('/api/') || url === '/api') return API_TARGET;
  // Socket.IO's path is fixed by the server and is NOT under /api.
  if (url.startsWith('/socket.io')) return API_TARGET;
  return WEB_TARGET;
}

const server = http.createServer((req, res) => {
  const target = targetFor(req.url);
  proxy.web(req, res, { target });
});

// WebSocket upgrade (Socket.IO long-polling fallback upgrades through here too).
server.on('upgrade', (req, socket, head) => {
  const target = targetFor(req.url);
  proxy.ws(req, socket, head, { target });
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  process.stdout.write(
    `[proxy] http://${LISTEN_HOST}:${LISTEN_PORT} -> web ${WEB_TARGET} | api ${API_TARGET}\n`,
  );
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    proxy.close();
    // Do not wait forever on half-open tunnels.
    setTimeout(() => process.exit(0), 2_000).unref();
  });
}
