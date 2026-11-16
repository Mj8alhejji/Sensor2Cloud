// check-hwtest.js - verifies a real ESP32 running examples/hardware_test against the server.
//
// Usage (from server/, with the server running):
//   node test/check-hwtest.js
//   SERVER=http://localhost:8080 DEVICE_KEY=test123 MAC=AABBCCDDEEFF node test/check-hwtest.js
//   node test/check-hwtest.js --no-commands      (only check the data)
//
// Without MAC it picks the most recently seen node named "hwtest".
// Part 1: every line of the latest boot is in the DB, in order, no gaps, text + incomplete flag exact.
// Part 2: sends ping / status / blink / an unknown command and waits for the node's replies.
// Exit code 0 = all passed.

const { expectedLines, NODE_NAME } = require("./hwtest-expected");

const SERVER = (process.env.SERVER || "http://localhost:8080").replace(/\/+$/, "");
const KEY = process.env.DEVICE_KEY || "test123";
const WANT_MAC = process.env.MAC ? process.env.MAC.replace(/[:\-]/g, "").toUpperCase() : null;
const SKIP_COMMANDS = process.argv.includes("--no-commands");
const COMMAND_TIMEOUT_MS = 45_000;

let failures = 0;
const pass = (msg) => console.log(`  PASS  ${msg}`);
const fail = (msg) => { failures++; console.log(`  FAIL  ${msg}`); };
const info = (msg) => console.log(`  info  ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (s) => (s.length > 40 ? JSON.stringify(s.slice(0, 37)) + `... (${Buffer.byteLength(s)} bytes)` : JSON.stringify(s));

async function api(method, path, body) {
  const res = await fetch(SERVER + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function findNode() {
  const nodes = await api("GET", "/api/v1/nodes");
  const node = WANT_MAC
    ? nodes.find((n) => n.mac === WANT_MAC)
    : nodes.filter((n) => n.name === NODE_NAME).sort((a, b) => b.last_seen - a.last_seen)[0];
  if (!node) {
    throw new Error(WANT_MAC ? `no node with MAC ${WANT_MAC}` : `no node named "${NODE_NAME}" yet. Did the sketch connect?`);
  }
  return node;
}

async function checkData(node) {
  console.log("\n[1] data path");
  const ageS = (Date.now() - node.last_seen) / 1000;
  if (ageS < 15) pass(`node is checking in (last seen ${ageS.toFixed(1)} s ago)`);
  else fail(`node last seen ${ageS.toFixed(0)} s ago. Expected a check-in every ~5 s. Is it still running?`);

  const all = await api("GET", `/api/v1/nodes/${node.mac}/lines?limit=1000`);
  const lines = all.filter((l) => l.boot_id === node.last_boot).sort((a, b) => a.seq - b.seq);
  info(`boot ${node.last_boot}: ${lines.length} lines in DB`);

  const expected = expectedLines();
  const bySeq = new Map(lines.map((l) => [l.seq, l]));

  if (!bySeq.has(0) || bySeq.get(0).text !== "hwtest start") {
    fail(`seq 0 is ${bySeq.has(0) ? short(bySeq.get(0).text) : "missing"}, not "hwtest start". Is the hardware_test sketch the one running?`);
    return;
  }

  const missing = [];
  let wrong = 0;
  expected.forEach((exp, seq) => {
    const got = bySeq.get(seq);
    if (!got) return missing.push(seq);
    const gotIncomplete = !!got.incomplete;
    if (got.text !== exp.text || gotIncomplete !== exp.incomplete) {
      wrong++;
      if (wrong <= 10) {
        fail(`seq ${seq}: expected ${short(exp.text)}${exp.incomplete ? " [incomplete]" : ""}, ` +
             `got ${short(got.text)}${gotIncomplete ? " [incomplete]" : ""}`);
      }
    }
  });

  if (missing.length === 0) pass(`all ${expected.length} test lines present (seq 0..${expected.length - 1}), no gaps`);
  else fail(`${missing.length} lines missing, seq: ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? ", ..." : ""}`);
  if (wrong === 0 && missing.length < expected.length) pass("text and incomplete flag match for every line present");
  else if (wrong > 10) fail(`...and ${wrong - 10} more mismatches`);

  // Named edge cases, so a failure says what broke.
  const at = (s) => bySeq.get(s);
  const edge = (seq, name) => {
    const got = at(seq);
    const exp = expected[seq];
    if (got && got.text === exp.text && !!got.incomplete === exp.incomplete) pass(name);
  };
  edge(173, "2500-byte line split into 1024 + 1024 + 452");
  edge(175, "UTF-8 char not cut at the 1 KB boundary");
  edge(176, "UTF-8 text survives the round trip");
  edge(177, "several print() calls form one line");
  edge(178, "empty println() is stored as an empty line");
  edge(179, "unterminated text sealed as incomplete after 5 s");
  edge(181, "flush() seals unterminated text as incomplete");

  const beats = lines.filter((l) => l.seq >= expected.length);
  const badBeats = beats.filter((l) => !/^heartbeat n=\d+ heap=\d+$/.test(l.text));
  if (badBeats.length) fail(`${badBeats.length} unexpected lines after "hwtest done", e.g. ${short(badBeats[0].text)}`);
  info(`${beats.length} heartbeat lines after the test sequence`);

  let backwards = 0;
  for (let i = 1; i < lines.length; i++) if (lines[i].ts < lines[i - 1].ts - 1000) backwards++;
  if (backwards === 0) pass("timestamps increase with seq");
  else fail(`${backwards} lines have a timestamp more than 1 s earlier than the line before`);
  const sources = lines.reduce((m, l) => ((m[l.ts_source] = (m[l.ts_source] || 0) + 1), m), {});
  info(`ts_source: ${JSON.stringify(sources)} (all "server" until NTP is added)`);

  const lags = lines.map((l) => l.received_at - l.ts);
  info(`print -> stored delay: median ${median(lags)} ms, max ${Math.max(...lags)} ms`);
}

async function checkCommands(node) {
  console.log("\n[2] cloud commands");
  const tests = [
    { cmd: "ping", args: "", status: "done", reply: (r) => r === "pong", want: '"pong"' },
    { cmd: "status", args: "", status: "done", reply: (r) => /uptime=\d+ heap=\d+ queued=\d+ dropped=\d+ rssi=-?\d+/.test(r), want: "uptime=... heap=..." },
    { cmd: "blink", args: "3", status: "done", reply: (r) => r === "blinking 3x", want: '"blinking 3x"' },
    { cmd: "selfdestruct", args: "", status: "failed", reply: (r) => /unknown command/.test(r), want: "unknown command" },
  ];
  for (const t of tests) {
    t.id = (await api("POST", `/api/v1/nodes/${node.mac}/commands`, { cmd: t.cmd, args: t.args })).id;
  }
  info(`sent ${tests.map((t) => `#${t.id} ${t.cmd}`).join(", ")}. Waiting for replies (max ${COMMAND_TIMEOUT_MS / 1000} s)...`);

  const t0 = Date.now();
  let rows = [];
  while (Date.now() - t0 < COMMAND_TIMEOUT_MS) {
    rows = await api("GET", `/api/v1/nodes/${node.mac}/commands?limit=100`);
    const open = tests.filter((t) => !["done", "failed"].includes(rows.find((r) => r.id === t.id)?.status));
    if (open.length === 0) break;
    await sleep(1000);
  }

  for (const t of tests) {
    const row = rows.find((r) => r.id === t.id);
    const label = `${t.cmd}${t.args ? "(" + t.args + ")" : ""}`;
    if (!row || !["done", "failed"].includes(row.status)) {
      fail(`${label}: no reply (status ${row?.status}). "pending" = node never picked it up, "sent" = reply never came back`);
      continue;
    }
    const roundTrip = row.done_at - row.created_at;
    if (row.status === t.status && t.reply(row.reply || "")) pass(`${label} -> ${row.status} ${JSON.stringify(row.reply)} in ${roundTrip} ms`);
    else fail(`${label}: expected ${t.status} ${t.want}, got ${row.status} ${JSON.stringify(row.reply)}`);
  }
  info("blink: check that the board's LED flashed blue 3 times");

  // Replies must not leak into the print data.
  const lines = await api("GET", `/api/v1/nodes/${node.mac}/lines?limit=200`);
  if (lines.some((l) => l.text === "pong" || /^blinking \d+x$/.test(l.text))) fail("command replies showed up as print lines");
  else pass("replies stored apart from print lines");
}

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

(async () => {
  console.log(`server ${SERVER}`);
  const node = await findNode();
  console.log(`node   ${node.name} (${node.mac}), boot ${node.last_boot}`);
  await checkData(node);
  if (!SKIP_COMMANDS) await checkCommands(node);
  console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error(`\nERROR: ${e.message}`);
  process.exit(2);
});
