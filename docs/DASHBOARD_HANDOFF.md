# sensor2cloud: handoff for the dashboard team

SOEN 4315 Cloud Computing project. Repo: `Mj8alhejji/Sensor2Cloud`.

## The system in one paragraph

An ESP32 runs our library. The sketch calls `cloud.println("temp=24.5")`. The library buffers lines in RAM
and a background task POSTs them in batches (every 5 s, max 100 lines) to the Node.js server, which stores
them in SQLite. **The firmware never parses anything.** Each line is stored as raw text. Turning text into
charts, tables and alerts is the dashboard's job. That is the part you are building.

```
ESP32 sketch -> cloud.println() -> RAM buffer -> background task -> POST /api/v1/batch
  -> server (Express) -> SQLite -> GET /api/v1/... -> dashboard (you)
```

## Status

| Piece | State |
|---|---|
| Server (`server/` in this repo, Node 22+, Express, SQLite) | Done, tested locally. Not deployed yet. Target: AWS Elastic Beanstalk, eu-north-1 (pick the Node 22 platform) |
| ESP32 library v0.1 (WiFi, buffer, batch send, cloud commands) | Compiles, passes the dry run with a fake device. First real hardware test pending |
| Status LED, NTP time, HTTPS | Not started |
| Dashboard | **Yours** |

## Run it locally (no ESP32 needed)

```bash
cd server
npm install
DEVICE_KEY=test123 npm start      # listens on :8080, creates sensor2cloud.db
npm run test:fake-device          # 2nd terminal: a fake ESP32 that prints ~180 lines, checks in every second and answers commands
```

`npm run test:fake-device` gives you a live node to build against, including command round trips.

On Windows PowerShell use `$env:DEVICE_KEY="test123"; npm start`.

## Read API (what the dashboard uses)

All endpoints need `Authorization: Bearer <DEVICE_KEY>`. MACs are returned as 12 uppercase hex chars
(`AABBCCDDEEFF`). URLs accept `AA:BB:..`, `aa-bb-..` or the plain form. All times are **unix milliseconds**.

### `GET /api/v1/nodes`
One row per device, most recently seen first.
```json
[{ "mac": "AABBCCDDEEFF", "name": "greenhouse", "first_seen": 1763290000000,
   "last_seen": 1763290061000, "last_boot": 3141592653 }]
```
- `name` is a label only. It defaults to the MAC if the device never set one.
- Online/offline is up to you: a running node checks in every 5 s even when it prints nothing, so
  `now - last_seen > ~20 s` is a reasonable "offline" rule.

### `GET /api/v1/nodes/:mac/lines?limit=100`
The printed lines, **newest first**. `limit` defaults to 100, max 1000. 404 if the MAC is unknown.
```json
[{ "id": 42, "boot_id": 3141592653, "seq": 17, "ts": 1763290017000, "ts_source": "server",
   "uptime_ms": 18200, "text": "temp=24.5", "incomplete": 0, "received_at": 1763290021000 }]
```
| Field | Meaning |
|---|---|
| `text` | The raw line, up to 1 KB. **Parse this.** |
| `ts` | When the line was printed. Use this for charts. |
| `ts_source` | `ntp` = the device clock was synced (accurate). `server` = estimated from uptime (good to roughly network latency). |
| `incomplete` | 1 = the line was cut: longer than 1 KB, or no newline for 5 s. Show it, but don't trust it for parsing. |
| `boot_id`, `seq` | `boot_id` changes on every reboot. `seq` restarts at 0 each boot. Together they are unique. A `boot_id` change = the device rebooted. |
| `uptime_ms` | Device uptime when printed. |
| `received_at` | When the server stored it. |

### `GET /api/v1/nodes/:mac/logs?limit=100`
System events, newest first: `registered`, `boot` (detail `bootId=...`), `renamed` (detail `old -> new`).
```json
[{ "id": 3, "ts": 1763290000000, "event": "boot", "detail": "bootId=3141592653" }]
```

### `GET /`
Health check: `{ "ok": true, "service": "sensor2cloud" }`.

## Commands API (dashboard → device)

### `POST /api/v1/nodes/:mac/commands`  body `{ "cmd": "blink", "args": "3" }`
`cmd`: 1–32 chars of letters, digits, `_` or `-`. `args`: optional string, up to 256 chars. Returns 201 with the row below.
404 for an unknown MAC.

### `GET /api/v1/nodes/:mac/commands?limit=50`
Newest first.
```json
[{ "id": 3, "mac": "AABBCCDDEEFF", "cmd": "blink", "args": "3", "status": "done",
   "reply": "blinking 3x", "created_at": 1763290100000, "sent_at": 1763290103000, "done_at": 1763290104000 }]
```
| `status` | Meaning |
|---|---|
| `pending` | Waiting for the node's next check-in (every ~5 s while online) |
| `sent` | Delivered, waiting for the reply. Re-delivered if there's no reply after 30 s |
| `done` | Node replied OK. `reply` holds its answer |
| `failed` | Node replied with an error (for example unknown command) |

How it works: the node POSTs to `/api/v1/batch` every 5 s, even with nothing to print. The server puts pending
commands in that response. The node runs them and sends the replies with its next batch. Expect about 5–10 s from
click to reply. Poll `GET .../commands` every second or so after sending one.

Commands available now:

| cmd | args | reply |
|---|---|---|
| `ping` | none | `pong` |
| `status` | none | `uptime=<ms> heap=<bytes> queued=<lines> dropped=<lines> rssi=<dBm> bootId=<n>` |
| anything else | free text | Handled by the sketch (the hardware test sketch knows `blink <times>`). Otherwise `failed` / `unknown command` |

Not handled yet: a command sent while the node is offline stays `pending` forever (no expiry). Show its age in the UI.

## Things that will bite you

1. **No CORS on the server.** A browser dashboard served from another origin (for example Vite on :5173)
   gets blocked. Either serve the dashboard from the same Express app, use a dev proxy, or add the `cors`
   middleware to the server. Agree on one with the backend owner.
2. **There is one shared `DEVICE_KEY`, and it is the same key the devices use to write.** Putting it in
   browser JS exposes it. That's fine for the local demo, but not for the deployed version. Options: a
   separate read-only dashboard key, or the dashboard backend calls the API server-side. Needs a decision.
3. **No "since" / pagination on `/lines`.** Live view today means polling the newest N and de-duplicating on `id`.
   If you need `?since=<id>` or `?from=&to=` for charts, ask for it. It's a small server change.
4. **Line format is not fixed.** The example sketch prints `counter=5` and `heap=201344`. A sensible first
   parser: split on whitespace/commas, take `key=value` pairs where the value is numeric → one time series per key,
   per node. Lines that don't match still show in a raw log view. Don't assume every line parses.
5. **Duplicates are already removed** by the server (`UNIQUE(boot_id, seq)`). Lines can arrive late (after a
   WiFi outage the device sends its backlog). Sort by `ts`, not by arrival.
6. Storage is one table per node (`node_<MAC>_data`, `node_<MAC>_logs`) plus `nodes`. SQLite will be swapped
   for RDS Postgres later. Only use the HTTP API, never the DB file directly.

## Suggested first version of the dashboard

- Node list: name, MAC, online/offline, last seen, reboots (from logs).
- Node page: a live raw-line log (poll every 2–5 s), and charts for the numeric `key=value` series.
- Mark `incomplete` lines and `ts_source=server` timestamps visibly.

## Coming later (plan around it, don't build it yet)

- More commands (for example live mode). Same API as above, just new `cmd` values.
- HTTPS (load balancer + cert, or CloudFront) once deployed. The base URL will change from the local one.
- NTP on the device, after which most `ts_source` values become `ntp`.
