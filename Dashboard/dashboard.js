const REFRESH_INTERVAL = 5000;
const HISTORY_LIMIT = 100;
const STORAGE_KEY = "sensor2cloud-device-details-v1";
let devices = [];
let readings = [];
let savedDetails = loadSavedDetails();
let lastRecorded = {};
let refreshTimer = null;

// Read device names and groups saved in this browser.
function loadSavedDetails() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    const details = [];
    if (!Array.isArray(stored)) return details;

    for (const item of stored) {
      if (!item || typeof item.id !== "string" || typeof item.name !== "string" ||
          typeof item.group !== "string") continue;
      if (item.name.trim() === "" || item.name.length > 60 || item.group.length > 60) continue;
      details.push(item);
    }
    return details;
  } catch (error) {
    return [];
  }
}

function getDeviceDetails(device) {
  for (const details of savedDetails) {
    if (details.id === device.id) return details;
  }
  return device;
}

function showMessage(text, isError) {
  const message = document.getElementById("message");
  message.textContent = text;
  message.className = "";
  if (isError) message.className = "error";
}

function formatTime(timestamp) {
  if (!timestamp) return "No reading yet";
  return new Date(timestamp).toLocaleString();
}

function formatValue(sensor) {
  if (sensor.value === null) return "No reading yet";
  if (sensor.unit === "") return String(sensor.value);
  return sensor.value + " " + sensor.unit;
}

// Add text to a table cell.
function addCell(row, text) {
  const cell = document.createElement("td");
  cell.textContent = text;
  row.appendChild(cell);
}

function saveDeviceDetails(device, form) {
  const nameInput = form.querySelector(".name-input");
  const groupInput = form.querySelector(".group-input");
  const name = nameInput.value.trim();
  let group = groupInput.value.trim();
  nameInput.setCustomValidity("");
  if (name === "") nameInput.setCustomValidity("Please enter a device name.");
  if (!form.reportValidity()) return;
  if (group === "") group = "Ungrouped";

  const details = { id: device.id, name: name, group: group };
  let found = false;
  for (let i = 0; i < savedDetails.length; i++) {
    if (savedDetails[i].id === device.id) {
      savedDetails[i] = details;
      found = true;
      break;
    }
  }
  if (!found) savedDetails.push(details);

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedDetails));
    showMessage("Device name and group saved in this browser.", false);
  } catch (error) {
    showMessage("Details changed for this session. Browser storage is unavailable.", true);
  }
  nameInput.value = name;
  groupInput.value = group;
  updateFilters();
  renderDashboard();
}

// Create each panel once so refreshes do not erase text being typed.
function createDevicePanel(device) {
  const template = document.getElementById("device-template");
  const copy = template.content.cloneNode(true);
  const panel = copy.querySelector(".device-card");
  panel.id = "device-" + device.id;
  const form = panel.querySelector(".device-form");
  const details = getDeviceDetails(device);
  const nameInput = form.querySelector(".name-input");
  nameInput.value = details.name;
  form.querySelector(".group-input").value = details.group;

  nameInput.addEventListener("input", function () {
    nameInput.setCustomValidity("");
  });
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    saveDeviceDetails(device, form);
  });
  panel.querySelector(".connection-button").addEventListener("click", function () {
    setSimulatedConnection(device.id, !device.connected);
    refreshDashboard();
  });
  document.getElementById("device-list").appendChild(copy);
}

function updateFilters() {
  const groupFilter = document.getElementById("group-filter");
  const historyFilter = document.getElementById("history-filter");
  const selectedGroup = groupFilter.value;
  const selectedDevice = historyFilter.value;
  const groups = [];
  groupFilter.options.length = 1;
  historyFilter.options.length = 1;

  for (const device of devices) {
    const details = getDeviceDetails(device);
    if (!groups.includes(details.group)) {
      groups.push(details.group);
      groupFilter.add(new Option(details.group, details.group));
    }
    historyFilter.add(new Option(details.name + " (" + device.id + ")", device.id));
  }
  if (groups.includes(selectedGroup)) groupFilter.value = selectedGroup;
  historyFilter.value = selectedDevice;
}

// Keep new samples from online devices, up to 100 sensor readings.
function recordReadings() {
  for (const device of devices) {
    if (!device.connected) continue;
    for (const sensor of device.sensors) {
      const key = device.id + "/" + sensor.id;
      if (!sensor.recordedAt || sensor.value === null) continue;
      if (lastRecorded[key] === sensor.recordedAt) continue;
      lastRecorded[key] = sensor.recordedAt;
      readings.unshift({
        deviceId: device.id,
        sensorName: sensor.name,
        value: formatValue(sensor),
        recordedAt: sensor.recordedAt
      });
    }
  }
  readings = readings.slice(0, HISTORY_LIMIT);
}

function renderHistory() {
  const body = document.getElementById("history-body");
  const selectedDevice = document.getElementById("history-filter").value;
  body.textContent = "";

  for (const reading of readings) {
    if (selectedDevice !== "" && reading.deviceId !== selectedDevice) continue;
    let name = reading.deviceId;
    for (const device of devices) {
      if (device.id === reading.deviceId) name = getDeviceDetails(device).name;
    }
    const row = document.createElement("tr");
    addCell(row, formatTime(reading.recordedAt));
    addCell(row, name + " (" + reading.deviceId + ")");
    addCell(row, reading.sensorName);
    addCell(row, reading.value);
    addCell(row, "Simulated");
    body.appendChild(row);
  }
  if (body.children.length === 0) {
    const row = document.createElement("tr");
    addCell(row, "No readings to show.");
    row.firstChild.colSpan = 5;
    body.appendChild(row);
  }
}

// Update the labels and readings without rebuilding the edit forms.
function renderDashboard() {
  const selectedGroup = document.getElementById("group-filter").value;
  let onlineCount = 0;

  for (const device of devices) {
    const panel = document.getElementById("device-" + device.id);
    const details = getDeviceDetails(device);
    panel.hidden = selectedGroup !== "" && selectedGroup !== details.group;
    panel.querySelector(".device-name").textContent = details.name;
    panel.querySelector(".device-info").textContent = device.id + " | ESP32-S3 | Group: " + details.group;
    panel.querySelector(".last-seen").textContent = "Last simulated contact: " + formatTime(device.lastSeen);
    panel.querySelector(".sensor-caption").textContent = details.name + " — simulated readings";

    const status = panel.querySelector(".connection-status");
    const button = panel.querySelector(".connection-button");
    if (device.connected) {
      onlineCount++;
      status.textContent = "Simulated status: Online";
      status.className = "connection-status online";
      button.textContent = "Simulate offline";
    } else {
      status.textContent = "Simulated status: Offline — showing last known readings";
      status.className = "connection-status offline";
      button.textContent = "Simulate online";
    }

    const body = panel.querySelector(".sensor-body");
    body.textContent = "";
    for (const sensor of device.sensors) {
      const row = document.createElement("tr");
      addCell(row, sensor.name);
      addCell(row, sensor.interface);
      addCell(row, sensor.gpio);
      addCell(row, formatValue(sensor));
      addCell(row, formatTime(sensor.recordedAt));
      body.appendChild(row);
    }
  }
  document.getElementById("device-summary").textContent =
    "Simulated online: " + onlineCount + " of " + devices.length + " devices.";
  renderHistory();
}

function refreshDashboard() {
  devices = loadDevices();
  recordReadings();
  renderDashboard();
}

function toggleAutomaticUpdates() {
  if (refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
    document.getElementById("pause-button").textContent = "Resume automatic updates";
    document.getElementById("refresh-status").textContent = "Automatic updates paused.";
  } else {
    refreshTimer = setInterval(refreshDashboard, REFRESH_INTERVAL);
    document.getElementById("pause-button").textContent = "Pause automatic updates";
    document.getElementById("refresh-status").textContent = "Automatic updates every 5 seconds while this page is open.";
    refreshDashboard();
  }
}

// Set up the page and its buttons.
devices = loadDevices();
for (const device of devices) createDevicePanel(device);
updateFilters();
document.getElementById("refresh-button").addEventListener("click", refreshDashboard);
document.getElementById("pause-button").addEventListener("click", toggleAutomaticUpdates);
document.getElementById("group-filter").addEventListener("change", renderDashboard);
document.getElementById("history-filter").addEventListener("change", renderHistory);
document.getElementById("clear-history-button").addEventListener("click", function () {
  readings = [];
  renderHistory();
  showMessage("Reading history cleared for this page session.", false);
});
toggleAutomaticUpdates();
