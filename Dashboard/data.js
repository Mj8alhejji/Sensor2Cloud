/* This file supplies data. dashboard.js displays it without knowing how it was obtained. */
const DATA_SETTINGS = {
  source: "simulation", // Change to "backend" only after an HTTP endpoint is ready.
  apiUrl: "" // Example later: http://localhost:8000/api/devices
};

// These are display placeholders, not wiring instructions. Edit after wiring is approved.
const GPIO_CONFIG = {
  "esp32-s3-01": {
    potentiometer: "ADC: not assigned",
    photoresistor: "ADC: not assigned",
    bmp280: "SDA / SCL: not assigned",
    mfrc522: "SCK / MOSI / MISO / CS / RST: not assigned"
  },
  "esp32-s3-02": {
    potentiometer: "ADC: not assigned",
    photoresistor: "ADC: not assigned",
    bmp280: "SDA / SCL: not assigned",
    mfrc522: "SCK / MOSI / MISO / CS / RST: not assigned"
  }
};

// Each board shows every proposed sensor type for demonstration purposes only.
const simulatedDevices = [
  { id: "esp32-s3-01", name: "ESP32-S3 01", group: "Lab A", connected: true, lastSeen: null, sensors: [] },
  { id: "esp32-s3-02", name: "ESP32-S3 02", group: "Lab B", connected: true, lastSeen: null, sensors: [] }
];

// Pick a random number in an illustrative range, rounded to one decimal place.
function randomReading(minimum, maximum) {
  return Math.round((minimum + Math.random() * (maximum - minimum)) * 10) / 10;
}

// Create one sample per sensor. BMP280 temperature and pressure share the same I2C placeholder.
function createSimulatedSensors(deviceId, timestamp) {
  const gpio = GPIO_CONFIG[deviceId];
  return [
    { id: "potentiometer", name: "Potentiometer position", interface: "Analog", gpio: gpio.potentiometer, value: randomReading(0, 100), unit: "%", recordedAt: timestamp },
    { id: "photoresistor", name: "Photoresistor relative light", interface: "Analog", gpio: gpio.photoresistor, value: randomReading(0, 100), unit: "%", recordedAt: timestamp },
    { id: "temperature", name: "BMP280 temperature", interface: "I2C", gpio: gpio.bmp280, value: randomReading(20, 32), unit: "°C", recordedAt: timestamp },
    { id: "pressure", name: "BMP280 pressure", interface: "I2C", gpio: gpio.bmp280, value: randomReading(990, 1025), unit: "hPa", recordedAt: timestamp },
    { id: "rfid", name: "MFRC522 RFID tag", interface: "SPI", gpio: gpio.mfrc522, value: Math.random() < 0.5 ? "No tag" : "04:A1:B2:C3", unit: "", recordedAt: timestamp }
  ];
}

// Change only the demo connection state. This never contacts a board or broker.
function setSimulatedConnection(deviceId, connected) {
  const device = simulatedDevices.find(function (item) { return item.id === deviceId; });
  if (DATA_SETTINGS.source === "simulation" && device) device.connected = connected;
}

// Reject malformed backend data so the page can show a useful error instead of crashing.
function validateDevices(devices) {
  if (!Array.isArray(devices) || devices.length !== 2) throw new Error("Expected an array containing two devices.");
  const deviceIds = [];
  devices.forEach(function (device) {
    if (!device || typeof device.id !== "string" || !device.id || deviceIds.includes(device.id) ||
        typeof device.name !== "string" || typeof device.group !== "string" ||
        typeof device.connected !== "boolean" || !Array.isArray(device.sensors) ||
        (device.lastSeen !== null && (typeof device.lastSeen !== "string" || !Number.isFinite(Date.parse(device.lastSeen))))) {
      throw new Error("Invalid device fields or duplicate device ID.");
    }
    deviceIds.push(device.id);
    const sensorIds = [];
    device.sensors.forEach(function (sensor) {
      if (!sensor || typeof sensor.id !== "string" || !sensor.id || sensorIds.includes(sensor.id) ||
          typeof sensor.name !== "string" || typeof sensor.interface !== "string" ||
          typeof sensor.gpio !== "string" || typeof sensor.unit !== "string" ||
          !(sensor.value === null || typeof sensor.value === "string" || (typeof sensor.value === "number" && Number.isFinite(sensor.value))) ||
          (sensor.recordedAt !== null && (typeof sensor.recordedAt !== "string" || !Number.isFinite(Date.parse(sensor.recordedAt))))) {
        throw new Error("Invalid sensor fields or duplicate sensor ID.");
      }
      sensorIds.push(sensor.id);
    });
  });
  return devices;
}

// This is the single entry point for future integration. Never fall back to fake data on API failure.
async function loadDevices() {
  if (DATA_SETTINGS.source === "backend") {
    if (!DATA_SETTINGS.apiUrl) throw new Error("Set DATA_SETTINGS.apiUrl before enabling backend mode.");
    const response = await fetch(DATA_SETTINGS.apiUrl, { cache: "no-store" });
    if (!response.ok) throw new Error("Backend returned HTTP " + response.status + ".");
    return validateDevices(await response.json());
  }
  if (DATA_SETTINGS.source !== "simulation") throw new Error("Unknown data source setting.");
  const timestamp = new Date().toISOString();
  simulatedDevices.forEach(function (device) {
    if (device.connected) {
      device.lastSeen = timestamp;
      device.sensors = createSimulatedSensors(device.id, timestamp);
    }
  });
  // Return a copy, so the dashboard can compare this sample with its previous sample.
  return validateDevices(JSON.parse(JSON.stringify(simulatedDevices)));
}
