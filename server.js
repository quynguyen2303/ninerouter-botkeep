'use strict';
/**
 * Attack on Software — combined one-server launcher + reverse proxy.
 *
 * Botkeep gives us ONE public port ($SERVER_PORT). This process owns it and
 * runs both services behind it on loopback:
 *
 *   9router    127.0.0.1:12012   (node_modules/.bin/9router)
 *   dashboard  127.0.0.1:12013   (node dashboard.js)
 *   proxy      0.0.0.0:$SERVER_PORT (default 20128)
 *
 * Routing:
 *   /factory, /factory/*  -> dashboard, with the /factory prefix stripped
 *                            (/factory alone becomes /)
 *   everything else       -> 9router (including WebSocket upgrades)
 *
 * Child stdout/stderr are inherited (visible in this process's logs).
 * If either child exits, the launcher kills the other and exits too, so
 * Botkeep's supervisor sees the failure and can restart the whole server.
 */
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.SERVER_PORT || '20128', 10);
const ROUTER_PORT = 12012;
const DASH_PORT = 12013;
const UPSTREAM_HOST = '127.0.0.1';

/* ---------------- child processes ---------------- */

const children = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(code), 300);
}

function startChild(name, cmd, args, extraEnv) {
  const child = spawn(cmd, args, {
    env: { ...process.env, ...extraEnv },
    stdio: 'inherit',
  });
  child.on('error', (err) => {
    console.error(`[aos] failed to start ${name}: ${err.message}`);
    shutdown(1);
  });
  child.on('exit', (code, signal) => {
    if (!shuttingDown) {
      console.error(`[aos] ${name} exited (code=${code}, signal=${signal}); shutting down`);
      shutdown(code === null || code === 0 ? 1 : code);
    }
  });
  children.push(child);
  console.log(`[aos] started ${name} (pid ${child.pid})`);
  return child;
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

startChild(
  '9router',
  path.join(__dirname, 'node_modules', '.bin', '9router'),
  ['--no-browser', '--skip-update', '-H', UPSTREAM_HOST, '-p', String(ROUTER_PORT)],
  {}
);
startChild('dashboard', process.execPath, [path.join(__dirname, 'dashboard.js')], {
  DASH_PORT: String(DASH_PORT),
});

/* ---------------- routing ---------------- */

// Returns { port, path } for a raw request target (path + optional query).
function route(rawUrl) {
  const q = rawUrl.indexOf('?');
  const pathname = q === -1 ? rawUrl : rawUrl.slice(0, q);
  const query = q === -1 ? '' : rawUrl.slice(q);
  if (pathname === '/factory' || pathname.startsWith('/factory/')) {
    const stripped = pathname.slice('/factory'.length) || '/';
    return { port: DASH_PORT, path: stripped + query };
  }
  return { port: ROUTER_PORT, path: rawUrl };
}

/* ---------------- HTTP proxy ---------------- */

const proxy = http.createServer((req, res) => {
  const { port, path: upPath } = route(req.url);
  const headers = { ...req.headers, host: `${UPSTREAM_HOST}:${port}` };
  const upReq = http.request(
    { host: UPSTREAM_HOST, port, method: req.method, path: upPath, headers },
    (upRes) => {
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
    }
  );
  upReq.on('error', (err) => {
    // Upstream not up yet (children boot asynchronously) or crashed.
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    res.end(`Bad Gateway: upstream on port ${port} unavailable (${err.code || err.message})\n`);
  });
  req.on('error', () => upReq.destroy());
  req.pipe(upReq);
});

/* ---------------- WebSocket / upgrade proxy (9router dashboard) ---------------- */

proxy.on('upgrade', (req, socket, head) => {
  const { port, path: upPath } = route(req.url);
  const upstream = net.connect(port, UPSTREAM_HOST, () => {
    const rawHeaders = req.rawHeaders.slice();
    for (let i = 0; i < rawHeaders.length; i += 2) {
      if (rawHeaders[i].toLowerCase() === 'host') {
        rawHeaders[i + 1] = `${UPSTREAM_HOST}:${port}`;
      }
    }
    let raw = `${req.method} ${upPath} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < rawHeaders.length; i += 2) {
      raw += `${rawHeaders[i]}: ${rawHeaders[i + 1]}\r\n`;
    }
    raw += '\r\n';
    upstream.write(raw);
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

proxy.listen(PORT, '0.0.0.0', () => {
  console.log(`[aos] proxy listening on 0.0.0.0:${PORT} -> 9router :${ROUTER_PORT}, dashboard :${DASH_PORT} under /factory`);
});
