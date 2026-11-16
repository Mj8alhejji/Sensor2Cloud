// fake-hwtest-device.js - pretends to be an ESP32 running examples/hardware_test.
// It speaks the same protocol as the library: batches of up to 100 lines, a check-in POST when idle,
// and command replies riding along with the next batch. Use it to dry-run check-hwtest.js
// without hardware:
//
//   terminal 1:  DEVICE_KEY=test123 npm start
//   terminal 2:  node test/fake-hwtest-device.js         (keeps running, Ctrl+C to stop)
//   terminal 3:  node test/check-hwtest.js
//
// This tests the server and the checker, not the firmware.

const { expectedLines, NODE_NAME } = require("./hwtest-expected");

const SERVER = (process.env.SERVER || "http://localhost:8080").replace(/\/+$/, "");
const KEY = process.env.DEVICE_KEY || "test123";
const MAC = process.env.MAC || "02:00:00:00:00:01";
const INTERVAL_MS = 1000;

const bootTime = Date.now();
const uptime = () => Date.now() - bootTime;
const bootId = Math.floor(Math.random() * 2 ** 32);

const queue = expectedLines().map((l, seq) => ({ seq, uptimeMs: uptime(), text: l.text, ...(l.incomplete && { incomplete: true }) }));
let nextSeq = queue.length;
let replies = [];
let lastCommandId = 0;
let beat = 0;

function run(cmd, args) {
  if (cmd === "ping") return [true, "pong"];
  if (cmd === "status") return [true, `uptime=${uptime()} heap=200000 queued=${queue.length} dropped=0 rssi=-50 bootId=${bootId}`];
  if (cmd === "blink") return [true, `blinking ${parseInt(args, 10) > 0 ? parseInt(args, 10) : 3}x`];
  return [false, `unknown command: ${cmd}`];
}

async function tick() {
  const lines = queue.slice(0, 100);
  const sentReplies = replies;
  const body = { mac: MAC, name: NODE_NAME, bootId, lines, sentUptimeMs: uptime() };
  if (sentReplies.length) body.replies = sentReplies;

  const res = await fetch(`${SERVER}/api/v1/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return console.log(`POST -> ${res.status} ${JSON.stringify(json)}`);

  queue.splice(0, lines.length);
  replies = replies.slice(sentReplies.length);
  if (lines.length || sentReplies.length) console.log(`sent ${lines.length} lines, ${sentReplies.length} replies -> ${res.status}`);

  for (const c of json.commands || []) {
    if (c.id <= lastCommandId) continue;
    lastCommandId = c.id;
    const [ok, text] = run(c.cmd, c.args);
    console.log(`command #${c.id} ${c.cmd}(${c.args}) -> ${ok ? "ok" : "failed"} ${text}`);
    replies.push({ id: c.id, ok, text });
  }
}

console.log(`fake ${NODE_NAME} node ${MAC}, bootId ${bootId} -> ${SERVER}`);
setInterval(() => queue.push({ seq: nextSeq++, uptimeMs: uptime(), text: `heartbeat n=${beat++} heap=200000` }), 10_000);
(async () => {
  for (;;) {
    await tick().catch((e) => console.log(`POST failed: ${e.message}`));
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
})();
