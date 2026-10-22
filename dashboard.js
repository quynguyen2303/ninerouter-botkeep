'use strict';
/**
 * Attack on Software — factory dashboard (Node port of factory-dash/app.py).
 *
 * Zero-dependency (node: builtins only) reimplementation of the Flask app:
 *   GET /                              job list (HTML)
 *   GET /job/<job_id>                  job event stream (HTML, auto-refresh)
 *   GET /api/jobs                      job list (JSON)
 *   GET /api/jobs/<job_id>/events      events with ts > ?since= (JSON)
 *
 * Data layer mirrors factory/events.py: one JSONL file per job at
 * $JOBS_DIR/<job_id>/events.jsonl (JOBS_DIR defaults to ./jobs).
 *
 * Listens on 127.0.0.1 : $DASH_PORT (default 12013). In the combined
 * package it sits behind server.js under the /factory prefix.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const JOBS_DIR = process.env.JOBS_DIR || path.join(__dirname, 'jobs');
const PORT = parseInt(process.env.DASH_PORT || '12013', 10);
const HOST = '127.0.0.1';

/* ---------------- events.py port ---------------- */

function jobPath(jobId) {
  return path.join(JOBS_DIR, jobId, 'events.jsonl');
}

function readEvents(jobId, types) {
  const p = jobPath(jobId);
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const rawLine of fs.readFileSync(p, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // events.py silently skips malformed lines
    }
    if (types && !types.some((t) => e.type.startsWith(t))) continue;
    out.push(e);
  }
  return out;
}

function latest(jobId, type) {
  const evs = readEvents(jobId, [type]);
  return evs.length ? evs[evs.length - 1] : null;
}

function summary(jobId) {
  const evs = readEvents(jobId);
  if (!evs.length) return { status: 'unknown', events: 0 };
  const types = evs.map((e) => e.type);
  let status;
  if (types.includes('job.delivered')) status = 'delivered';
  else if (types.includes('job.failed')) status = 'failed';
  else if (types.some((t) => t.startsWith('review.'))) status = 'in_review';
  else if (types.some((t) => t.startsWith('task.'))) status = 'building';
  else if (types.some((t) => t.startsWith('plan.'))) status = 'planning';
  else status = 'created';
  return {
    status,
    events: evs.length,
    tasks_done: types.filter((t) => t === 'task.completed').length,
    tasks_total: types.filter((t) => t === 'task.created').length,
    started: evs[0].ts,
    updated: evs[evs.length - 1].ts,
  };
}

function jobIds() {
  if (!fs.existsSync(JOBS_DIR)) return [];
  return fs
    .readdirSync(JOBS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ name: d.name, mtime: fs.statSync(path.join(JOBS_DIR, d.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((d) => d.name);
}

function jobName(jid) {
  const nameEv = latest(jid, 'job.created');
  if (!nameEv) return jid;
  // Python: name_ev["data"].get("name") -> the value, or None if key missing
  if (nameEv.data === null || typeof nameEv.data !== 'object') {
    throw new Error('AttributeError: data has no .get'); // Flask would 500
  }
  return 'name' in nameEv.data ? nameEv.data.name : null;
}

/* ---------------- Python-compatible formatting helpers ---------------- */

// Python str() as used by the f-strings in app.py
function pyStr(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  return String(v);
}

// Python json.dumps() defaults: separators (', ', ': '), ensure_ascii=True.
// Used for the <code> snippet on the job detail page. JSON.stringify already
// escapes quotes, backslashes and control chars; this pass escapes every
// remaining char outside printable ASCII (0x20-0x7E) as \uXXXX, per code
// unit (astral chars become surrogate-pair escapes, exactly like Python).
function pyEscapeStr(s) {
  return JSON.stringify(s).replace(/[\u007f-\uffff]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}

function pyDumps(v) {
  if (v === null) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return pyEscapeStr(v);
  if (Array.isArray(v)) return '[' + v.map(pyDumps).join(', ') + ']';
  if (typeof v === 'object') {
    return (
      '{' +
      Object.entries(v)
        .map(([k, val]) => pyEscapeStr(k) + ': ' + pyDumps(val))
        .join(', ') +
      '}'
    );
  }
  throw new Error('Object of type is not JSON serializable'); // Flask would 500
}

/* ---------------- Pages (templates transcribed from app.py) ---------------- */

function renderIndex() {
  const jobs = [];
  for (const jid of jobIds()) {
    const s = summary(jid);
    jobs.push({ id: jid, name: jobName(jid), ...s });
  }
  // Flask raises KeyError (-> 500) if a job has no events: summary() then
  // lacks tasks_done/tasks_total and the row f-string dereferences them.
  const rows = jobs
    .map((j) => {
      if (!('tasks_done' in j) || !('tasks_total' in j)) {
        throw new Error("KeyError: 'tasks_done'");
      }
      return (
        `<tr><td><a href='/job/${j.id}'>${pyStr(j.name)}</a></td>` +
        `<td>${j.status}</td><td>${j.tasks_done}/${j.tasks_total}</td>` +
        `<td>${j.events}</td></tr>`
      );
    })
    .join('');
  return `<!doctype html><html><head><title>Attack on Software</title>
<style>body{font-family:system-ui;max-width:900px;margin:40px auto;padding:0 20px;background:#0f1115;color:#e8e8e8}
h1{color:#e8b33d}table{width:100%;border-collapse:collapse}
td,th{padding:10px;border-bottom:1px solid #333;text-align:left}
a{color:#7cc4ff}</style></head><body>
<h1>⚔️ Attack on Software</h1><p>Live factory floor — event-sourced.</p>
<table><tr><th>Job</th><th>Status</th><th>Tasks</th><th>Events</th></tr>${rows}</table>
</body></html>`;
}

function renderJob(jobId) {
  const evs = readEvents(jobId);
  const lines = evs
    .slice(-200)
    .map(
      (e) =>
        `<div>[${e.actor}] <b>${e.type}</b> ` +
        `<code>${pyDumps(e.data).slice(0, 160)}</code></div>`
    )
    .join('');
  return `<!doctype html><html><head><title>${jobId}</title>
<meta http-equiv='refresh' content='5'>
<style>body{font-family:monospace;max-width:1000px;margin:20px auto;padding:0 20px;
background:#0f1115;color:#d8d8d8;font-size:13px}
div{padding:3px 0;border-bottom:1px solid #222}a{color:#7cc4ff}</style>
</head><body><a href='/'>← all jobs</a><h2>${jobId}</h2>${lines}</body></html>`;
}

/* ---------------- HTTP plumbing ---------------- */

const PAGE_404 =
  '<!doctype html>\n<html lang=en>\n<title>404 Not Found</title>\n<h1>Not Found</h1>\n' +
  '<p>The requested URL was not found on the server. If you entered the URL manually please check your spelling and try again.</p>\n';
const PAGE_405 =
  '<!doctype html>\n<html lang=en>\n<title>405 Method Not Allowed</title>\n<h1>Method Not Allowed</h1>\n' +
  '<p>The method is not allowed for the requested URL.</p>\n';
const PAGE_500 =
  '<!doctype html>\n<html lang=en>\n<title>500 Internal Server Error</title>\n<h1>Internal Server Error</h1>\n' +
  '<p>The server encountered an internal error and was unable to complete your request. Either the server is overloaded or there is an error in the application.</p>\n';

function send(res, status, contentType, body, headOnly) {
  const buf = Buffer.from(body, 'utf8');
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': buf.length });
  res.end(headOnly ? undefined : buf);
}

const server = http.createServer((req, res) => {
  const headOnly = req.method === 'HEAD';
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'text/html; charset=utf-8', PAGE_405, headOnly);
    }
    const url = new URL(req.url, 'http://dashboard.local');
    const pathname = url.pathname;
    let m;

    if (pathname === '/') {
      return send(res, 200, 'text/html; charset=utf-8', renderIndex(), headOnly);
    }
    if ((m = pathname.match(/^\/job\/([^/]+)$/))) {
      return send(res, 200, 'text/html; charset=utf-8', renderJob(decodeURIComponent(m[1])), headOnly);
    }
    if (pathname === '/api/jobs') {
      const out = jobIds().map((jid) => ({ id: jid, name: jobName(jid), ...summary(jid) }));
      return send(res, 200, 'application/json', JSON.stringify(out), headOnly);
    }
    if ((m = pathname.match(/^\/api\/jobs\/([^/]+)\/events$/))) {
      const rawSince = url.searchParams.get('since');
      let since = 0;
      if (rawSince !== null) {
        // Python float(...) raises ValueError on garbage; the view doesn't
        // catch it, so Flask answers 500 (verified against the real app).
        if (rawSince.trim() === '' || Number.isNaN(Number(rawSince))) {
          throw new Error(`ValueError: could not convert string to float: '${rawSince}'`);
        }
        since = Number(rawSince);
      }
      const jobId = decodeURIComponent(m[1]);
      const evs = readEvents(jobId).filter((e) => e.ts > since);
      return send(res, 200, 'application/json', JSON.stringify(evs), headOnly);
    }
    return send(res, 404, 'text/html; charset=utf-8', PAGE_404, headOnly);
  } catch (err) {
    // Flask turns unhandled view exceptions into a 500 page
    return send(res, 500, 'text/html; charset=utf-8', PAGE_500, headOnly);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[dashboard] listening on http://${HOST}:${PORT} (JOBS_DIR=${JOBS_DIR})`);
});
