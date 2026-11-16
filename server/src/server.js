// server.js - sensor2cloud core backend (test version).
// Run locally:   DEVICE_KEY=test123 npm start
// On Beanstalk:  set DEVICE_KEY in Configuration > Environment properties. Beanstalk sets PORT.

const express = require("express");
const crypto = require("crypto");
const db = require("./db");

const PORT = process.env.PORT || 8080;
const DEVICE_KEY = process.env.DEVICE_KEY;
if (!DEVICE_KEY) {
  console.error("DEVICE_KEY env var is not set. Refusing to start.");
  process.exit(1);
}

const MAX_LINES_PER_BATCH = 500;
const MAX_LINE_BYTES = 1024;

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---------- helpers ----------

function keyMatches(given) {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(DEVICE_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireKey(req, res, next) {
  const header = req.get("authorization") || "";
  const key = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!keyMatches(key)) return res.status(401).json({ error: "bad or missing device key" });
  next();
}

// Accepts "AA:BB:CC:DD:EE:FF", "aa-bb-...", or "AABBCCDDEEFF". Returns "AABBCCDDEEFF" or null.
function normalizeMac(mac) {
  if (typeof mac !== "string") return null;
  const hex = mac.replace(/[:\-]/g, "").toUpperCase();
  return /^[0-9A-F]{12}$/.test(hex) ? hex : null;
}

const isInt = (v) => Number.isInteger(v) && v >= 0;

// ---------- routes ----------

// Beanstalk health check hits "/" by default.
app.get("/", (req, res) => res.json({ ok: true, service: "sensor2cloud" }));

/*
  POST /api/v1/batch
  Header: Authorization: Bearer <deviceKey>
  Body:
  {
    "mac": "AA:BB:CC:DD:EE:FF",
    "name": "greenhouse",          // optional
    "bootId": 3141592653,          // random number picked at each boot
    "sentUptimeMs": 61000,         // node uptime when this batch was sent
    "lines": [
      { "seq": 0, "uptimeMs": 1200, "text": "humidity=19" },
      { "seq": 1, "uptimeMs": 2200, "ts": 1763290000000, "text": "temp=24.5" },
      { "seq": 2, "uptimeMs": 3200, "text": "GPS fix lo", "incomplete": true }
    ]
  }
*/
app.post("/api/v1/batch", requireKey, (req, res) => {
  const receivedAt = Date.now();
  const { name, bootId, sentUptimeMs, lines } = req.body || {};
  const mac = normalizeMac(req.body?.mac);

  if (!mac) return res.status(400).json({ error: "mac must be 12 hex digits" });
  if (!isInt(bootId)) return res.status(400).json({ error: "bootId must be a non-negative integer" });
  if (!isInt(sentUptimeMs)) return res.status(400).json({ error: "sentUptimeMs must be a non-negative integer" });
  // An empty lines array is a check-in: the node has nothing to print but wants its commands.
  if (!Array.isArray(lines)) return res.status(400).json({ error: "lines must be an array" });
  if (lines.length > MAX_LINES_PER_BATCH) return res.status(413).json({ error: `max ${MAX_LINES_PER_BATCH} lines per batch` });
  if (name !== undefined && (typeof name !== "string" || name.length > 64)) {
    return res.status(400).json({ error: "name must be a string up to 64 chars" });
  }

  // Command replies ride along with the batch, but are stored apart from print data.
  const replies = req.body.replies ?? [];
  if (!Array.isArray(replies) || replies.length > 50) {
    return res.status(400).json({ error: "replies must be an array of up to 50" });
  }
  for (let i = 0; i < replies.length; i++) {
    const r = replies[i];
    if (!r || !isInt(r.id) || typeof r.ok !== "boolean" || typeof r.text !== "string" || Buffer.byteLength(r.text) > MAX_LINE_BYTES) {
      return res.status(400).json({ error: `reply ${i}: needs id (int), ok (bool), text (string up to ${MAX_LINE_BYTES} bytes)` });
    }
  }

  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l || !isInt(l.seq) || !isInt(l.uptimeMs) || typeof l.text !== "string") {
      return res.status(400).json({ error: `line ${i}: needs seq, uptimeMs (ints) and text (string)` });
    }
    if (Buffer.byteLength(l.text) > MAX_LINE_BYTES) {
      return res.status(400).json({ error: `line ${i}: text over ${MAX_LINE_BYTES} bytes` });
    }

    // Timestamp: trust NTP time from the node if it sent one,
    // otherwise estimate it = arrival time - how long ago the node printed it.
    let ts, tsSource;
    if (isInt(l.ts) && l.ts > 1_600_000_000_000) {
      ts = l.ts;
      tsSource = "ntp";
    } else {
      ts = receivedAt - Math.max(0, sentUptimeMs - l.uptimeMs);
      tsSource = "server";
    }
    rows.push({ seq: l.seq, uptimeMs: l.uptimeMs, ts, tsSource, text: l.text, incomplete: !!l.incomplete });
  }

  const { isNew } = db.touchNode(mac, name, bootId);
  const { inserted, duplicates } = db.insertLines(mac, bootId, rows);
  const repliesApplied = db.applyReplies(mac, replies);
  const commands = db.takeCommandsForDelivery(mac);

  // Node treats any 2xx as "batch delivered, drop it from the buffer".
  res.json({ ok: true, mac, newNode: isNew, inserted, duplicates, repliesApplied, commands });
});

// ---- commands (dashboard -> node) ----

/*
  POST /api/v1/nodes/:mac/commands   { "cmd": "blink", "args": "3" }   // args optional
  -> 201 { id, mac, cmd, args, status: "pending", ... }
  The node picks it up in the response to its next batch (within ~5 s) and replies in a later batch.
  Built into the library: "ping" -> "pong", "status" -> "uptime=... heap=...". Anything else goes to the sketch.
*/
app.post("/api/v1/nodes/:mac/commands", requireKey, (req, res) => {
  const mac = normalizeMac(req.params.mac);
  if (!mac || !db.nodeExists(mac)) return res.status(404).json({ error: "unknown node" });
  const { cmd, args = "" } = req.body || {};
  if (typeof cmd !== "string" || !/^[a-zA-Z0-9_\-]{1,32}$/.test(cmd)) {
    return res.status(400).json({ error: "cmd must be 1-32 chars of letters, digits, _ or -" });
  }
  if (typeof args !== "string" || args.length > 256) {
    return res.status(400).json({ error: "args must be a string up to 256 chars" });
  }
  res.status(201).json(db.createCommand(mac, cmd, args));
});

app.get("/api/v1/nodes/:mac/commands", requireKey, (req, res) => {
  const mac = normalizeMac(req.params.mac);
  if (!mac || !db.nodeExists(mac)) return res.status(404).json({ error: "unknown node" });
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 1000);
  res.json(db.listCommands(mac, limit));
});

// ---- read endpoints (for testing now, dashboard later) ----

app.get("/api/v1/nodes", requireKey, (req, res) => {
  res.json(db.listNodes());
});

app.get("/api/v1/nodes/:mac/lines", requireKey, (req, res) => {
  const mac = normalizeMac(req.params.mac);
  if (!mac || !db.nodeExists(mac)) return res.status(404).json({ error: "unknown node" });
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
  res.json(db.getLines(mac, limit));
});

app.get("/api/v1/nodes/:mac/logs", requireKey, (req, res) => {
  const mac = normalizeMac(req.params.mac);
  if (!mac || !db.nodeExists(mac)) return res.status(404).json({ error: "unknown node" });
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
  res.json(db.getLogs(mac, limit));
});

// Bad JSON etc.
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "invalid JSON" });
  if (err.type === "entity.too.large") return res.status(413).json({ error: "body too large" });
  console.error(err);
  res.status(500).json({ error: "server error" });
});

app.listen(PORT, () => {
  console.log(`sensor2cloud listening on :${PORT}, db = ${db.DB_FILE}`);
});
