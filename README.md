# Sensor2Cloud

`cloud.print()` for ESP32. Whatever you print is buffered in RAM and sent to the sensor2cloud server
in the background as raw lines. All parsing happens in the cloud.

Target: ESP32-S3 (other ESP32s should work, untested).

```cpp
#include <Sensor2Cloud.h>

Sensor2Cloud cloud("wifi", "password", "device-key");

void setup() {
  cloud.server("http://192.168.1.50:8080");
  cloud.nodeName("greenhouse");   // optional, the server falls back to the MAC
  cloud.begin();                  // non-blocking
}

void loop() {
  cloud.println("temp=24.5");
  delay(1000);
}
```

## Behaviour (v0.1)

- WiFi and HTTP run in a FreeRTOS task on core 0 (priority 1, 8 KB stack). `loop()` is never blocked.
- Lines go into a 16 KB RAM ring buffer (`begin(bytes)` to change it). When it is full, the oldest lines are dropped.
- A batch is sent every 5 s (`sendInterval(ms)`), or early once 100 lines are queued. `flush()` sends now.
- Lines are capped at 1 KB. Longer text is split, and the pieces are marked `incomplete`.
  Text without a newline for one send interval is also sent as `incomplete`.
- Delivery is at-least-once. Lines leave the buffer only after a 2xx. The server dedupes on (bootId, seq).
  On 400/413 the batch is dropped, since resending it can never succeed. On 401, a network error or 5xx, it retries with backoff (up to 60 s).
- `debug(Serial)` turns on library log output. It is off by default.

- Cloud commands: the node POSTs every 5 s even with nothing to print (a check-in). The server answers with any
  pending commands. `ping` and `status` are built in. Anything else goes to `cloud.onCommand(handler)`.
  Replies ride along with the next batch, but are stored apart from the printed lines.

## Repo layout

| Path | What |
|---|---|
| `src/` | The library |
| `examples/basic/` | Minimal sketch |
| `examples/hardware_test/` | End-to-end hardware test (pairs with `server/test/check-hwtest.js`) |
| `include/secrets.h` | WiFi, device key, server URL (gitignored; copy `secrets.example.h`) |
| `server/` | Node.js backend (Express + SQLite). Node 22+ |
| `docs/` | Handoffs |

## Hardware test (ESP32 + local server)

1. Server: `cd server && npm install && DEVICE_KEY=test123 npm start`
   (PowerShell: `$env:DEVICE_KEY="test123"; npm start`). Allow Node through Windows Firewall when asked.
2. Copy `include/secrets.example.h` to `include/secrets.h`. Set WiFi, `DEVICE_KEY "test123"`, and
   `SERVER_URL "http://<PC LAN IP>:8080"` (`ipconfig` → IPv4 address. Not `localhost`: that would be the ESP32 itself).
3. Flash: `pio run -e hwtest -t upload -t monitor`. It takes about 15 s and ends with `HWTEST DONE`.
4. Check: `cd server && npm run test:hw`. It verifies all 183 lines in the DB, then sends
   ping/status/blink/unknown commands and waits for replies. The LED should flash blue 3 times.

No board? `npm run test:fake-device` in a second terminal stands in for the ESP32 (tests the server and checker only).

## Roadmap

Status LED, NTP timestamps, buffer tester, serial mirror, HTTPS.
