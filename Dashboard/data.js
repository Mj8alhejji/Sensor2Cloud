// GPIO labels will be updated after the team confirms the wiring.
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

const simulatedDevices = [
  { id: "esp32-s3-01", name: "ESP32-S3 01", group: "Lab A", connected: true, lastSeen: null, sensors: [] },
  { id: "esp32-s3-02", name: "ESP32-S3 02", group: "Lab B", connected: true, lastSeen: null, sensors: [] }
];

// Make a random reading with one decimal place.
function randomReading(minimum, maximum) {
  const value = minimum + Math.random() * (maximum - minimum);
  return Math.round(value * 10) / 10;
}

function createSensor(id, name, interfaceName, gpio, value, unit, timestamp) {
  return {
    id: id,
    name: name,
    interface: interfaceName,
    gpio: gpio,
    value: value,
    unit: unit,
    recordedAt: timestamp
  };
}

// Both boards show these example sensors in the demo.
function createSimulatedSensors(deviceId, timestamp) {
  const gpio = GPIO_CONFIG[deviceId];
  let tag = "No tag";
  if (Math.random() < 0.5) tag = "04:A1:B2:C3";

  return [
    createSensor("potentiometer", "Potentiometer position", "Analog", gpio.potentiometer,
      randomReading(0, 100), "%", timestamp),
    createSensor("photoresistor", "Photoresistor relative light", "Analog", gpio.photoresistor,
      randomReading(0, 100), "%", timestamp),
    createSensor("temperature", "BMP280 temperature", "I2C", gpio.bmp280,
      randomReading(20, 32), "°C", timestamp),
    createSensor("pressure", "BMP280 pressure", "I2C", gpio.bmp280,
      randomReading(990, 1025), "hPa", timestamp),
    createSensor("rfid", "MFRC522 RFID tag", "SPI", gpio.mfrc522,
      tag, "", timestamp)
  ];
}

function setSimulatedConnection(deviceId, connected) {
  for (const device of simulatedDevices) {
    if (device.id === deviceId) {
      device.connected = connected;
      return;
    }
  }
}

// Returns demo data now. Connect the backend here when its API is ready.
function loadDevices() {
  const timestamp = new Date().toISOString();
  for (const device of simulatedDevices) {
    if (device.connected) {
      device.lastSeen = timestamp;
      device.sensors = createSimulatedSensors(device.id, timestamp);
    }
  }
  return simulatedDevices;
}
