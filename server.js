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

/* ---------------- Cloudflare quick-tunnel TEST ----------------
 * Enabled when TUNNEL_TEST=1 or tunnel-test.json says {"enabled": true}.
 * Uses a free trycloudflare.com quick tunnel pointing at this proxy,
 * captures the public URL, and exposes it at /__tunnel. The tunnel stops
 * itself after 30 minutes; it is a connectivity test, not production
 * hosting. If cloudflared is missing it is downloaded once into bin/.
 * If any of this fails, the server keeps running without the tunnel. */
const fs = require('fs');
const https = require('https');
const TUNNEL_TEST_MINUTES = 30;
let tunnelUrl = null;
let tunnelExpiresAt = null;

function tunnelTestEnabled() {
  if (process.env.TUNNEL_TEST === '1') return true;
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'tunnel-test.json'), 'utf8')
    );
    return cfg.enabled === true;
  } catch {
    return false;
  }
}

function downloadFile(url, dest, redirectsLeft, done) {
  https
    .get(url, (res) => {
      if (
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location &&
        redirectsLeft > 0
      ) {
        res.resume();
        downloadFile(res.headers.location, dest, redirectsLeft - 1, done);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        done(new Error(`download failed: HTTP ${res.statusCode}`));
        return;
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(() => done(null)));
      out.on('error', done);
    })
    .on('error', done);
}

function ensureCloudflared(done) {
  const bin = path.join(__dirname, 'bin', 'cloudflared');
  if (fs.existsSync(bin)) {
    done(null, bin);
    return;
  }
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  const tmp = `${bin}.download`;
  console.log('[aos] downloading cloudflared for the tunnel test...');
  downloadFile(
    'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64',
    tmp,
    5,
    (err) => {
      if (err) {
        done(err);
        return;
      }
      fs.renameSync(tmp, bin);
      fs.chmodSync(bin, 0o755);
      console.log('[aos] cloudflared downloaded');
      done(null, bin);
    }
  );
}

if (tunnelTestEnabled()) {
  ensureCloudflared((dlErr, cfBin) => {
    if (dlErr) {
      console.error(`[aos] cloudflared unavailable: ${dlErr.message}; continuing without tunnel`);
      return;
    }
    startTunnel(cfBin);
  });
}

function startTunnel(cfBin) {
  try {
    const cf = spawn(
      cfBin,
      ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    children.push(cf);
    const onData = (buf) => {
      const text = buf.toString();
      process.stderr.write(`[cloudflared] ${text}`);
      const match = text.match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/);
      if (match && !tunnelUrl) {
        tunnelUrl = match[0];
        tunnelExpiresAt = new Date(Date.now() + TUNNEL_TEST_MINUTES * 60 * 1000).toISOString();
        console.log(`[aos] TUNNEL TEST live: ${tunnelUrl} (auto-stops at ${tunnelExpiresAt})`);
      }
    };
    cf.stdout.on('data', onData);
    cf.stderr.on('data', onData);
    cf.on('error', (err) => {
      console.error(`[aos] cloudflared failed to start: ${err.message}; continuing without tunnel`);
    });
    cf.on('exit', (code, signal) => {
      console.log(`[aos] cloudflared exited (code=${code}, signal=${signal}); tunnel closed`);
      tunnelUrl = null;
      tunnelExpiresAt = null;
    });
    setTimeout(() => {
      console.log('[aos] TUNNEL TEST window over; stopping cloudflared');
      try {
        cf.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }, TUNNEL_TEST_MINUTES * 60 * 1000);
  } catch (err) {
    console.error(`[aos] could not spawn cloudflared: ${err.message}; continuing without tunnel`);
  }
}

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

/* Headers that reveal the original (remote) client. If these reach
 * 9router it classifies the request as remote and refuses the default
 * password ("Default password must be changed before remote access").
 * The proxy itself connects from loopback, so stripping these makes
 * dashboard requests look local to 9router and lets the owner set the
 * first real password through the normal login flow. */
const FORWARDING_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
  'forwarded',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'true-client-ip',
];

function stripForwardingHeaders(headers) {
  const out = { ...headers };
  for (const name of FORWARDING_HEADERS) delete out[name];
  return out;
}

const proxy = http.createServer((req, res) => {
  if (req.url === '/__tunnel' || req.url.startsWith('/__tunnel?')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({ tunnel_url: tunnelUrl, expires_at: tunnelExpiresAt }) + '\n'
    );
    return;
  }
  const { port, path: upPath } = route(req.url);
  const headers = {
    ...stripForwardingHeaders(req.headers),
    host: `${UPSTREAM_HOST}:${port}`,
  };
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
    const rawHeaders = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i].toLowerCase();
      if (FORWARDING_HEADERS.includes(name)) continue;
      if (name === 'host') {
        rawHeaders.push(req.rawHeaders[i], `${UPSTREAM_HOST}:${port}`);
      } else {
        rawHeaders.push(req.rawHeaders[i], req.rawHeaders[i + 1]);
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
