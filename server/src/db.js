// db.js - all database access lives here.
// Test version uses SQLite (one file). Later, swap this file for RDS Postgres
// and nothing else in the server has to change.
//
// Layout (matches the per-node store design):
//   nodes                    -> one row per MAC
//   node_<mac>_data          -> every cloud.print() line from that node
//   node_<mac>_logs          -> system events (registered, boot, ...)

const Database = require("better-sqlite3");
const path = require("path");

const DB_FILE = process.env.DB_FILE || path.join(__dirname, "..", "sensor2cloud.db");
const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS nodes (
    mac         TEXT PRIMARY KEY,          -- 'AABBCCDDEEFF'
    name        TEXT,                      -- display name, MAC by default
    first_seen  INTEGER NOT NULL,          -- unix ms
    last_seen   INTEGER NOT NULL,
    last_boot   INTEGER                    -- last bootId seen
  );

  -- Cloud commands (dashboard -> node). Kept apart from print data.
  -- status: pending -> sent -> done | failed
  CREATE TABLE IF NOT EXISTS commands (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    mac         TEXT NOT NULL,
    cmd         TEXT NOT NULL,
    args        TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'pending',
    reply       TEXT,
    created_at  INTEGER NOT NULL,
    sent_at     INTEGER,
    done_at     INTEGER
  );
  CREATE INDEX IF NOT EXISTS commands_by_mac ON commands (mac, status);
`);

// MAC is validated as 12 hex chars before it reaches here, so it's safe in a table name.
function dataTable(mac) { return `node_${mac}_data`; }
function logsTable(mac) { return `node_${mac}_logs`; }

function createNodeTables(mac) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${dataTable(mac)} (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      boot_id     INTEGER NOT NULL,
      seq         INTEGER NOT NULL,
      ts          INTEGER NOT NULL,          -- unix ms (NTP from node, or server-estimated)
      ts_source   TEXT NOT NULL,             -- 'ntp' or 'server'
      uptime_ms   INTEGER NOT NULL,
      text        TEXT NOT NULL,             -- raw printed line (source of truth)
      incomplete  INTEGER NOT NULL DEFAULT 0,
      received_at INTEGER NOT NULL,
      UNIQUE (boot_id, seq)                  -- dedupe for at-least-once delivery
    );
    CREATE TABLE IF NOT EXISTS ${logsTable(mac)} (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      ts     INTEGER NOT NULL,
      event  TEXT NOT NULL,
      detail TEXT
    );
  `);
}

function addLog(mac, event, detail = null) {
  db.prepare(`INSERT INTO ${logsTable(mac)} (ts, event, detail) VALUES (?, ?, ?)`)
    .run(Date.now(), event, detail);
}

// Registers the node if new, logs a boot if bootId changed. Returns { isNew }.
function touchNode(mac, name, bootId) {
  const now = Date.now();
  const existing = db.prepare("SELECT * FROM nodes WHERE mac = ?").get(mac);

  if (!existing) {
    createNodeTables(mac);
    db.prepare(
      "INSERT INTO nodes (mac, name, first_seen, last_seen, last_boot) VALUES (?, ?, ?, ?, ?)"
    ).run(mac, name || mac, now, now, bootId);
    addLog(mac, "registered", name ? `name=${name}` : null);
    addLog(mac, "boot", `bootId=${bootId}`);
    return { isNew: true };
  }

  if (existing.last_boot !== bootId) addLog(mac, "boot", `bootId=${bootId}`);
  if (name && name !== existing.name) addLog(mac, "renamed", `${existing.name} -> ${name}`);

  db.prepare("UPDATE nodes SET last_seen = ?, last_boot = ?, name = COALESCE(?, name) WHERE mac = ?")
    .run(now, bootId, name || null, mac);
  return { isNew: false };
}

// Inserts lines in one transaction. Duplicates (same bootId+seq) are skipped.
function insertLines(mac, bootId, rows) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO ${dataTable(mac)}
      (boot_id, seq, ts, ts_source, uptime_ms, text, incomplete, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = Date.now();
  let inserted = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      inserted += stmt.run(bootId, r.seq, r.ts, r.tsSource, r.uptimeMs, r.text, r.incomplete ? 1 : 0, now).changes;
    }
  });
  tx();
  return { inserted, duplicates: rows.length - inserted };
}

function listNodes() {
  return db.prepare("SELECT * FROM nodes ORDER BY last_seen DESC").all();
}

function nodeExists(mac) {
  return !!db.prepare("SELECT 1 FROM nodes WHERE mac = ?").get(mac);
}

function getLines(mac, limit) {
  return db.prepare(`SELECT * FROM ${dataTable(mac)} ORDER BY ts DESC, id DESC LIMIT ?`).all(limit);
}

function getLogs(mac, limit) {
  return db.prepare(`SELECT * FROM ${logsTable(mac)} ORDER BY id DESC LIMIT ?`).all(limit);
}

// ---------- commands ----------

const MAX_COMMANDS_PER_REPLY = 8;
const RESEND_AFTER_MS = 30_000; // 'sent' but no reply yet -> deliver again (the node dedupes by id)

function createCommand(mac, cmd, args) {
  const info = db.prepare("INSERT INTO commands (mac, cmd, args, created_at) VALUES (?, ?, ?, ?)")
    .run(mac, cmd, args, Date.now());
  return db.prepare("SELECT * FROM commands WHERE id = ?").get(info.lastInsertRowid);
}

function listCommands(mac, limit) {
  return db.prepare("SELECT * FROM commands WHERE mac = ? ORDER BY id DESC LIMIT ?").all(mac, limit);
}

// Picks the commands to put in this node's batch response and marks them 'sent'.
function takeCommandsForDelivery(mac) {
  const now = Date.now();
  const tx = db.transaction(() => {
    const rows = db.prepare(`
      SELECT id, cmd, args FROM commands
      WHERE mac = ? AND (status = 'pending' OR (status = 'sent' AND sent_at < ?))
      ORDER BY id LIMIT ?
    `).all(mac, now - RESEND_AFTER_MS, MAX_COMMANDS_PER_REPLY);
    const mark = db.prepare("UPDATE commands SET status = 'sent', sent_at = ? WHERE id = ?");
    for (const r of rows) mark.run(now, r.id);
    return rows;
  });
  return tx();
}

// replies: [{ id, ok, text }] from the node. Only closes this node's open commands.
function applyReplies(mac, replies) {
  const now = Date.now();
  const stmt = db.prepare(`
    UPDATE commands SET status = ?, reply = ?, done_at = ?
    WHERE id = ? AND mac = ? AND status IN ('pending', 'sent')
  `);
  let applied = 0;
  const tx = db.transaction(() => {
    for (const r of replies) applied += stmt.run(r.ok ? "done" : "failed", r.text, now, r.id, mac).changes;
  });
  tx();
  return applied;
}

module.exports = {
  touchNode, insertLines, listNodes, nodeExists, getLines, getLogs,
  createCommand, listCommands, takeCommandsForDelivery, applyReplies,
  DB_FILE,
};
