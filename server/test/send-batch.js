// send-batch.js - pretends to be an ESP32 and sends a batch, then reads it back.
// Usage:
//   SERVER=http://localhost:8080 DEVICE_KEY=test123 npm run test:send
//   SERVER=http://your-env.eu-north-1.elasticbeanstalk.com DEVICE_KEY=... npm run test:send

const SERVER = process.env.SERVER || "http://localhost:8080";
const KEY = process.env.DEVICE_KEY || "test123";
const MAC = process.env.MAC || "24:6F:28:AB:CD:EF";

async function call(method, path, body) {
  const res = await fetch(SERVER + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  console.log(`${method} ${path} -> ${res.status}`);
  console.log(JSON.stringify(json, null, 2));
  return { status: res.status, json };
}

(async () => {
  const bootId = Math.floor(Math.random() * 2 ** 32);
  const batch = {
    mac: MAC,
    name: "test-node",
    bootId,
    sentUptimeMs: 5000,
    lines: [
      { seq: 0, uptimeMs: 1000, text: "humidity=19 temp=24.5" },
      { seq: 1, uptimeMs: 2000, text: "humidity=20 temp=24.6" },
      { seq: 2, uptimeMs: 3000, ts: Date.now() - 2000, text: "this one has an NTP timestamp" },
      { seq: 3, uptimeMs: 4000, text: "cut off mid-li", incomplete: true },
    ],
  };

  await call("POST", "/api/v1/batch", batch);
  console.log("\n--- sending the same batch again (should be 4 duplicates) ---");
  await call("POST", "/api/v1/batch", batch);

  const mac = MAC.replace(/:/g, "").toUpperCase();
  console.log("\n--- read back ---");
  await call("GET", `/api/v1/nodes/${mac}/lines?limit=10`);
  await call("GET", `/api/v1/nodes/${mac}/logs`);
})();
