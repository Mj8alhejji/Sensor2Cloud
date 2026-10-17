const REFRESH_INTERVAL = 5000;
const HISTORY_LIMIT = 100;
const STORAGE_KEY = "sensor2cloud-device-details-v1";
let devices = [];
let history = [];
let savedDetails = loadSavedDetails();
let refreshTimer = null;
let refreshInProgress = false;
let lastRefreshFailed = false;
let filterSignature = "";

// Load names and groups saved in this browser. Restricted storage does not stop the demo.
function loadSavedDetails() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(stored)) return [];
    return stored.filter(function (item) {
      return item && typeof item.id === "string" && typeof item.name === "string" &&
        item.name.trim().length > 0 && item.name.length <= 60 &&
        typeof item.group === "string" && item.group.length <= 60;
    });
  } catch (error) {
    return [];
  }
}

// Prefer a locally saved name and group; otherwise use the data source's defaults.
function getDeviceDetails(device) {
  return savedDetails.find(function (item) { return item.id === device.id; }) || device;
}

function showMessage(text, isError) {
  const message = document.getElementById("message");
  message.textContent = text;
  message.className = isError ? "error" : "";
}

function formatTime(timestamp) {
  return timestamp ? new Date(timestamp).toLocaleString() : "No reading yet";
}

function formatValue(sensor) {
  if (sensor.value === null) return "No reading yet";
  return String(sensor.value) + (sensor.unit ? " " + sensor.unit : "");
}

// textContent displays names and RFID strings as plain text, never as HTML.
function addCell(row, text) {
  const cell = document.createElement("td");
  cell.textContent = text;
  row.appendChild(cell);
}

// Store edits locally. These changes do not rename devices on a future backend.
function saveDeviceDetails(device, form) {
  const nameInput = form.querySelector(".name-input");
  const name = nameInput.value.trim();
  const group = form.querySelector(".group-input").value.trim() || "Ungrouped";
  nameInput.setCustomValidity(name ? "" : "Please enter a device name.");
  if (!form.reportValidity()) return;
  const details = { id: device.id, name: name, group: group };
  const index = savedDetails.findIndex(function (item) { return item.id === device.id; });
  if (index === -1) savedDetails.push(details);
  else savedDetails[index] = details;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedDetails));
    showMessage("Device name and group saved in this browser.", false);
  } catch (error) {
    showMessage("Details changed for this session. Browser storage is unavailable.", true);
  }
  nameInput.value = name;
  form.querySelector(".group-input").value = group;
  renderDashboard();
}

// Build the editable panel once, so automatic refreshes do not interrupt typing.
function createDevicePanel(device) {
  const fragment = document.getElementById("device-template").content.cloneNode(true);
  const panel = fragment.querySelector(".device-card");
  panel.id = "device-" + device.id;
  const details = getDeviceDetails(device);
  const form = panel.querySelector(".device-form");
  const nameInput = form.querySelector(".name-input");
  nameInput.value = details.name;
  form.querySelector(".group-input").value = details.group;
  nameInput.addEventListener("input", function () { nameInput.setCustomValidity(""); });
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    saveDeviceDetails(device, form);
  });
  panel.querySelector(".connection-button").addEventListener("click", function () {
    if (refreshInProgress) return;
    const current = devices.find(function (item) { return item.id === device.id; });
    setSimulatedConnection(device.id, !current.connected);
    refreshDashboard();
  });
  document.getElementById("device-list").appendChild(fragment);
  return panel;
}

// Rebuild filter choices only when device names or groups change.
function updateFilters() {
  const signature = JSON.stringify(devices.map(function (device) {
    const details = getDeviceDetails(device);
    return [device.id, details.name, details.group];
  }));
  if (signature === filterSignature) return;
  filterSignature = signature;
  const groupFilter = document.getElementById("group-filter");
  const historyFilter = document.getElementById("history-filter");
  const selectedGroup = groupFilter.value;
  const selectedDevice = historyFilter.value;
  groupFilter.replaceChildren(new Option("All groups", ""));
  historyFilter.replaceChildren(new Option("All devices", ""));
  const groups = [];
  devices.forEach(function (device) {
    const details = getDeviceDetails(device);
    if (!groups.includes(details.group)) groups.push(details.group);
    historyFilter.add(new Option(details.name + " (" + device.id + ")", device.id));
  });
  groups.sort().forEach(function (group) { groupFilter.add(new Option(group, group)); });
  groupFilter.value = groups.includes(selectedGroup) ? selectedGroup : "";
  historyFilter.value = devices.some(function (device) { return device.id === selectedDevice; }) ? selectedDevice : "";
}

// Add only new, timestamped samples from online devices. Repeated backend samples are skipped.
function recordReadings(nextDevices) {
  nextDevices.forEach(function (device) {
    if (!device.connected) return;
    const previousDevice = devices.find(function (item) { return item.id === device.id; });
    device.sensors.forEach(function (sensor) {
      if (sensor.value === null || !sensor.recordedAt) return;
      const previousSensor = previousDevice && previousDevice.sensors.find(function (item) { return item.id === sensor.id; });
      if (previousSensor && Date.parse(previousSensor.recordedAt) >= Date.parse(sensor.recordedAt)) return;
      history.push({ deviceId: device.id, deviceName: getDeviceDetails(device).name,
        sensorName: sensor.name, value: formatValue(sensor), recordedAt: sensor.recordedAt,
        source: DATA_SETTINGS.source === "simulation" ? "Simulated" : "Backend" });
    });
  });
  history.sort(function (a, b) { return Date.parse(b.recordedAt) - Date.parse(a.recordedAt); });
  history = history.slice(0, HISTORY_LIMIT);
}

function renderHistory() {
  const body = document.getElementById("history-body");
  const selectedDevice = document.getElementById("history-filter").value;
  body.replaceChildren();
  history.forEach(function (reading) {
    if (selectedDevice && reading.deviceId !== selectedDevice) return;
    const device = devices.find(function (item) { return item.id === reading.deviceId; });
    const name = device ? getDeviceDetails(device).name : reading.deviceName;
    const row = document.createElement("tr");
    [formatTime(reading.recordedAt), name + " (" + reading.deviceId + ")", reading.sensorName,
      reading.value, reading.source].forEach(function (text) { addCell(row, text); });
    body.appendChild(row);
  });
  if (!body.children.length) {
    const row = document.createElement("tr");
    addCell(row, "No readings to show.");
    row.firstChild.colSpan = 5;
    body.appendChild(row);
  }
}

// Update status and tables, keeping existing edit forms intact.
function renderDashboard() {
  updateFilters();
  const simulation = DATA_SETTINGS.source === "simulation";
  const online = devices.filter(function (device) { return device.connected; }).length;
  document.getElementById("device-summary").textContent = lastRefreshFailed ?
    "Connection status unknown: the latest update failed. Displayed values are last known readings." :
    (simulation ? "Simulated online: " : "Backend reports online: ") + online + " of " + devices.length + " devices.";
  const list = document.getElementById("device-list");
  Array.from(list.children).forEach(function (panel) {
    if (!devices.some(function (device) { return panel.id === "device-" + device.id; })) panel.remove();
  });
  devices.forEach(function (device) {
    const panel = document.getElementById("device-" + device.id) || createDevicePanel(device);
    const details = getDeviceDetails(device);
    panel.hidden = Boolean(document.getElementById("group-filter").value && document.getElementById("group-filter").value !== details.group);
    panel.querySelector(".device-name").textContent = details.name;
    panel.querySelector(".device-info").textContent = device.id + " | ESP32-S3 | Group: " + details.group;
    const status = panel.querySelector(".connection-status");
    status.textContent = lastRefreshFailed ? "Status unknown — update failed" :
      (simulation ? "Simulated status: " : "Backend status: ") + (device.connected ? "Online" : "Offline — showing last known readings");
    status.className = "connection-status " + (lastRefreshFailed || !device.connected ? "offline" : "online");
    panel.querySelector(".last-seen").textContent = (simulation ? "Last simulated contact: " : "Last contact reported by backend: ") + formatTime(device.lastSeen);
    panel.querySelector(".sensor-caption").textContent = details.name + (simulation ? " — simulated readings" : " — readings reported by backend");
    const body = panel.querySelector(".sensor-body");
    body.replaceChildren();
    device.sensors.forEach(function (sensor) {
      const row = document.createElement("tr");
      [sensor.name, sensor.interface, sensor.gpio, formatValue(sensor), formatTime(sensor.recordedAt)]
        .forEach(function (text) { addCell(row, text); });
      body.appendChild(row);
    });
    const button = panel.querySelector(".connection-button");
    button.hidden = !simulation;
    button.disabled = refreshInProgress;
    button.textContent = device.connected ? "Simulate offline" : "Simulate online";
  });
  renderHistory();
}

// Fetch a snapshot, update history, then display it. Only one refresh can run at a time.
async function refreshDashboard() {
  if (refreshInProgress) return;
  refreshInProgress = true;
  document.getElementById("refresh-button").disabled = true;
  try {
    const nextDevices = await loadDevices();
    recordReadings(nextDevices);
    devices = nextDevices;
    if (lastRefreshFailed) showMessage("Data updates have recovered.", false);
    lastRefreshFailed = false;
  } catch (error) {
    lastRefreshFailed = true;
    showMessage("Could not update readings: " + error.message, true);
  } finally {
    refreshInProgress = false;
    document.getElementById("refresh-button").disabled = false;
    renderDashboard();
  }
}

// Pausing stops automatic requests; manual refresh and demo connection buttons still work.
function toggleAutomaticUpdates() {
  if (refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
    document.getElementById("pause-button").textContent = "Resume automatic updates";
    document.getElementById("refresh-status").textContent = "Automatic updates paused. Values and status show the last update.";
  } else {
    refreshTimer = setInterval(refreshDashboard, REFRESH_INTERVAL);
    document.getElementById("pause-button").textContent = "Pause automatic updates";
    document.getElementById("refresh-status").textContent = "Automatic updates every 5 seconds while this page is open.";
    refreshDashboard();
  }
}

// The scripts use defer, so the page elements exist before these listeners are added.
document.getElementById("refresh-button").addEventListener("click", refreshDashboard);
document.getElementById("pause-button").addEventListener("click", toggleAutomaticUpdates);
document.getElementById("group-filter").addEventListener("change", renderDashboard);
document.getElementById("history-filter").addEventListener("change", renderHistory);
document.getElementById("clear-history-button").addEventListener("click", function () {
  history = [];
  renderHistory();
  showMessage("Reading history cleared for this page session.", false);
});
if (DATA_SETTINGS.source === "backend") {
  document.getElementById("mode-heading").textContent = "Backend mode";
  document.getElementById("mode-description").textContent = "Readings and connection states come from the configured backend. The dashboard does not directly connect to an ESP32-S3 or MQTT broker.";
}
toggleAutomaticUpdates();
