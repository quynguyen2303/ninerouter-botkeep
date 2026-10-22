# aos-server — Attack on Software, combined one-server package

Runs **both** 9router and the AoS factory dashboard on a single Botkeep
server (Node 22 profile, 512 MB RAM, 1024 MB storage, one public port).

## Layout

```
server.js       launcher + reverse proxy (the only public listener)
dashboard.js    zero-dependency Node port of the Flask factory dashboard
factory/        factory package (events/tasks/agents/orchestrator) — data layer source
lib/            factory router library (bundled; read by factory code)
config.json     factory model/gateway config (key *names* only, no secrets)
jobs/           created at runtime: one dir per job, events.jsonl inside
                (override with JOBS_DIR)
node_modules/   9router (installed by npm)
```

## Ports

| Listener | Bind | Purpose |
|---|---|---|
| proxy (`server.js`) | `0.0.0.0:$SERVER_PORT` (default 20128) | the only public port |
| 9router | `127.0.0.1:12012` | gateway + its own dashboard |
| dashboard (`dashboard.js`) | `127.0.0.1:12013` | factory dashboard |

## Routing

- `/factory` and `/factory/*` → dashboard on 12013, with the `/factory`
  prefix stripped (`/factory` alone becomes `/`):
  - `/factory/` → job list
  - `/factory/job/<job_id>` → job event stream
  - `/factory/api/jobs`, `/factory/api/jobs/<job_id>/events?since=<ts>` → JSON API
- Everything else → 9router on 12012, including its dashboard, the
  OpenAI-compatible API (`/v1/models`, `/v1/chat/completions`, …) and
  WebSocket `upgrade` requests (proxied as a raw socket pipe).

Note: dashboard pages link to absolute paths (`/job/<id>`, `/`) exactly as
the original Flask app did — those links resolve against the proxy root
(9router), not `/factory`. Use the `/factory/...` URLs directly.

## Lifecycle

`server.js` spawns both children with inherited stdio. If either child
exits, the launcher kills the other and exits with a non-zero code so the
host supervisor restarts the whole server. SIGTERM/SIGINT shut everything
down cleanly.

## Environment variables

| Var | Used by | Meaning |
|---|---|---|
| `SERVER_PORT` | proxy | public port assigned by Botkeep (default 20128) |
| `DATA_DIR` | 9router | data root; holds `db/data.sqlite` (providers, keys, settings) |
| `JOBS_DIR` | dashboard | factory job event logs (default `./jobs`) |
| `DASH_PORT` | dashboard | loopback port when run standalone (server.js pins it to 12013) |

## Run

```
npm install --omit=dev
npm start
```
