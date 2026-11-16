// Basic Sensor2Cloud example: prints a counter every second.
// Every line shows up on the server under this board's MAC address.
#include <Arduino.h>
#include <Sensor2Cloud.h>

#include "secrets.h"

Sensor2Cloud cloud(WIFI_SSID, WIFI_PASSWORD, DEVICE_KEY);

void setup() {
  Serial.begin(115200);
  cloud.debug(Serial);           // optional: library status on the serial monitor
  cloud.server(SERVER_URL);
  cloud.nodeName("greenhouse");  // optional label
  cloud.begin();                 // non-blocking, WiFi connects in the background
}

void loop() {
  static uint32_t counter = 0;
  cloud.print("counter=");
  cloud.println(counter++);
  cloud.printf("heap=%u\n", (unsigned)ESP.getFreeHeap());
  delay(1000);
}
