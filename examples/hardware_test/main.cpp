// Hardware test for Sensor2Cloud. Pair with the PC-side checker:
//
//   1. PC:    cd server && DEVICE_KEY=test123 npm start
//   2. ESP32: pio run -e hwtest -t upload -t monitor
//   3. Wait for "HWTEST DONE" in the serial monitor, then on the PC:
//             cd server && node test/check-hwtest.js
//
// The sketch prints a fixed sequence of lines that exercise the edge cases (bursts, 1 KB split,
// UTF-8 at the split point, unterminated text, flush(), empty line). The checker reads them back
// from the server and compares them line by line, then sends commands (ping/status/blink/unknown)
// and waits for the replies.
//
// !! If you change what is printed here, update EXPECTED in server/test/check-hwtest.js too.
#include <Arduino.h>
#include <Sensor2Cloud.h>

#include "secrets.h"

Sensor2Cloud cloud(WIFI_SSID, WIFI_PASSWORD, DEVICE_KEY);

// Set by the command handler (network task), consumed by loop(). `volatile` = "another task
// may change this, always re-read it from memory".
volatile int blinkRequests = 0;

bool handleCommand(const char* cmd, const char* args, String& reply) {
  if (strcmp(cmd, "blink") == 0) {
    int times = atoi(args);
    if (times <= 0) times = 3;
    blinkRequests = times;
    reply = "blinking " + String(times) + "x";
    return true;
  }
  reply = String("unknown command: ") + cmd;
  return false;
}

void ledColor(uint8_t r, uint8_t g, uint8_t b) {
#ifdef PIN_NEOPIXEL
  neopixelWrite(PIN_NEOPIXEL, r, g, b);
#endif
}

void step(const char* what) { Serial.printf("\n[hwtest] %s\n", what); }

void setup() {
  Serial.begin(115200);
  delay(3000);  // time to open the serial monitor
#ifdef NEOPIXEL_POWER
  pinMode(NEOPIXEL_POWER, OUTPUT);
  digitalWrite(NEOPIXEL_POWER, NEOPIXEL_POWER_ON);
#endif

  cloud.debug(Serial);
  cloud.server(SERVER_URL);
  cloud.nodeName("hwtest");
  cloud.onCommand(handleCommand);
  if (!cloud.begin()) {
    Serial.println("[hwtest] begin() failed, check SERVER_URL in secrets.h");
    while (true) delay(1000);
  }

  step("waiting for WiFi (max 30 s)...");
  uint32_t t0 = millis();
  while (!cloud.connected() && millis() - t0 < 30000) delay(250);
  step(cloud.connected() ? "WiFi up" : "WiFi NOT up yet, lines stay buffered until it is");

  // seq 0
  cloud.println("hwtest start");

  step("1) 20 normal lines, 200 ms apart");  // seq 1..20
  for (int i = 0; i < 20; i++) {
    cloud.print("line i=");
    cloud.println(i);
    delay(200);
  }

  step("2) burst of 150 lines (should trigger early sends)");  // seq 21..170
  for (int i = 0; i < 150; i++) cloud.printf("burst i=%d\n", i);

  step("3) 2500-byte line (should split 1024 / 1024 / 452)");  // seq 171..173
  String longLine;
  for (int i = 0; i < 2500; i++) longLine += char('0' + i % 10);
  cloud.println(longLine);

  step("4) UTF-8 char sitting on the 1 KB split point");  // seq 174..175
  String edge;
  for (int i = 0; i < 1023; i++) edge += 'a';
  edge += "\xC3\xA9end";  // "éend": é is 2 bytes, starting at byte 1023
  cloud.println(edge);

  step("5) UTF-8 text");  // seq 176
  cloud.println("utf8 \xC3\xA9 \xC3\xBC \xE6\xB8\xA9\xE5\xBA\xA6 \xE2\x9C\x93");  // "utf8 é ü 温度 ✓"

  step("6) one line from several print() calls");  // seq 177
  cloud.print("pieces a=");
  cloud.print(1);
  cloud.println(" b=2");

  step("7) empty line");  // seq 178
  cloud.println();

  step("8) unterminated text, waiting 7 s (should arrive as incomplete)");  // seq 179
  cloud.print("partial-no-newline");
  delay(7000);
  cloud.println("after partial");  // seq 180

  step("9) flush() on unterminated text");  // seq 181
  cloud.print("flushed-partial");
  cloud.flush();

  cloud.println("hwtest done");  // seq 182

  step("10) waiting for the buffer to drain...");
  t0 = millis();
  while (cloud.queuedLines() > 0 && millis() - t0 < 60000) delay(250);
  Serial.printf("\n[hwtest] HWTEST DONE: queued=%u dropped=%u\n", (unsigned)cloud.queuedLines(),
                (unsigned)cloud.droppedLines());
  Serial.println("[hwtest] now run on the PC:  cd server && node test/check-hwtest.js");
  Serial.println("[hwtest] it will send commands; watch for 'command #' lines and the LED blinking.");
}

void loop() {
  // seq 183+: a heartbeat every 10 s, so you can watch it live in the DB
  static uint32_t lastBeat = 0;
  static uint32_t beat = 0;
  if (millis() - lastBeat >= 10000) {
    lastBeat = millis();
    cloud.printf("heartbeat n=%u heap=%u\n", (unsigned)beat++, (unsigned)ESP.getFreeHeap());
  }

  if (blinkRequests > 0) {
    int n = blinkRequests;
    blinkRequests = 0;
    for (int i = 0; i < n; i++) {
      ledColor(0, 0, 40);  // blue
      delay(200);
      ledColor(0, 0, 0);
      delay(200);
    }
  }
  delay(20);
}
