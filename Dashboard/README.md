# Sensor2Cloud Dashboard

A local HTML and JavaScript demonstration for the Sensor2Cloud Cloud Computing project.

**Current mode: simulation. No physical boards, MQTT broker, backend, or database are connected.**

## Run locally

1. Open this folder.
2. Double-click `index.html` to open it in a modern browser.
3. Two ESP32-S3 panels appear. Simulated samples update every five seconds while the page is open.

No installation, internet connection, package manager, or build step is required for simulation mode.

For a consistent browser storage origin, or when testing a future backend, serve the folder locally. If Python is installed, open a terminal **inside this folder** and run:

```text
python -m http.server 8080 --bind 127.0.0.1
```

On Windows, `py` can be used instead of `python` if that is how Python is installed. Open `http://127.0.0.1:8080/`. Keep the terminal open; press Ctrl+C to stop the server. Always use the same address and port to reuse browser-saved device details.

## What each file does

| File | Purpose |
| --- | --- |
| `index.html` | Page structure, buttons, tables, labels, and the reusable device panel template. |
| `styles.css` | Basic colors, spacing, borders, and table readability. No frameworks, layout libraries, or advanced CSS. |
| `data.js` | Simulated devices, configurable GPIO placeholders, sample generation, backend data validation, and the future HTTP data connection. |
| `dashboard.js` | Displays devices, handles buttons, saves local names and groups, and manages reading history. |
| `README.md` | Running instructions, function explanations, testing steps, and the proposed backend data contract. |
| `dashboard-preview.png` | A captured overview of the working simulation for visual review and report preparation. |

The HTML loads `data.js` before `dashboard.js`. Both scripts use `defer`, which means they run after the HTML has been read. They are ordinary scripts, so the simulation also works by opening the HTML file directly.

## Match to the proposal

- Two ESP32-S3 development boards.
- Potentiometer: simulated position from 0 to 100%, using the Analog interface.
- Photoresistor: simulated relative light from 0 to 100%, using the Analog interface. This is not a lux measurement.
- BMP280: simulated temperature in degrees Celsius and pressure in hPa, using I2C.
- MFRC522: a simulated tag UID or `No tag`, using SPI. No real RFID identifiers are read.
- Proposed firmware capabilities also include PWM and UART. No current sensor reading is invented for these interfaces.

For demonstration, **both boards display all four proposed sensor types**. This is a configurable demo layout, not a statement about the final hardware distribution. The BMP280 produces two table rows, so each device has five readings per update.

All GPIO fields are unassigned. Edit `GPIO_CONFIG` near the top of `data.js` only after the team confirms the pin assignments. The BMP280 temperature and pressure rows use the same I2C configuration text. These labels do not configure board firmware or validate electrical connections.

## How the JavaScript works

The main flow is:

```text
timer or button -> refreshDashboard() -> loadDevices()
               -> recordReadings() -> renderDashboard() -> renderHistory()
```

`async` lets a function wait for data. `await` waits for that result without freezing the page. An event listener runs a function when someone clicks a button, submits a form, or changes a filter.

### Functions in data.js

| Function | Simple explanation |
| --- | --- |
| `randomReading(minimum, maximum)` | Picks a random demo number between two limits and rounds it to one decimal place. |
| `createSimulatedSensors(deviceId, timestamp)` | Builds the five example readings for one board using its GPIO placeholder text. |
| `setSimulatedConnection(deviceId, connected)` | Changes the demo board's online/offline state. It sends no hardware command. |
| `validateDevices(devices)` | Checks the two-device data structure, unique IDs, value types, and timestamps before displaying it. |
| `loadDevices()` | Returns either simulated data or validated JSON from a configured HTTP endpoint. This is the main place to connect the future backend. |

### Functions in dashboard.js

| Function | Simple explanation |
| --- | --- |
| `loadSavedDetails()` | Reads names and groups from this browser's local storage. Invalid or unavailable storage does not stop the page. |
| `getDeviceDetails(device)` | Uses the local name/group when available; otherwise uses the source defaults. |
| `showMessage(text, isError)` | Shows a short success or error message on the page. |
| `formatTime(timestamp)` | Converts a timestamp to the browser's local date and time. |
| `formatValue(sensor)` | Joins a reading and its unit, including text readings such as an RFID tag. |
| `addCell(row, text)` | Adds plain text to a table cell. Names are never interpreted as HTML. |
| `saveDeviceDetails(device, form)` | Checks the entered name, saves the name and group locally, and refreshes the labels and filters. |
| `createDevicePanel(device)` | Copies the HTML template and attaches its form and connection-button actions. The panel is kept during refreshes so typing is not interrupted. |
| `updateFilters()` | Updates group and device choices when device details change. |
| `recordReadings(nextDevices)` | Adds new timestamped samples, skips offline devices and unchanged samples, sorts newest first, and keeps at most 100 rows. |
| `renderHistory()` | Displays history for all devices or the selected device. |
| `renderDashboard()` | Updates device labels, connection states, readings, group visibility, and history. |
| `refreshDashboard()` | Requests one data update. If the request fails, it retains previous readings and marks connection status unknown. Overlapping updates are skipped. |
| `toggleAutomaticUpdates()` | Pauses or resumes the five-second timer. Manual refresh remains available. |

`devices`, `history`, and `savedDetails` are arrays: lists of related objects. `find()` locates one object; `filter()` selects matching objects; `forEach()` performs an action for each object. `JSON.stringify()` changes an object into text, and `JSON.parse()` changes that text back into an object. These are used for browser storage and to copy the simulated snapshot.

## Use the dashboard

- Change a device name or group and select **Save details**. Empty names are rejected. An empty group becomes `Ungrouped`. Names and groups are limited to 60 characters.
- Use **Show device group** to filter the device panels. The history filter works separately.
- Select **Simulate offline**. That board keeps its last readings and timestamps; it produces no new history until it is simulated online again.
- Use **Pause automatic updates** to stop the timer. **Refresh now** still takes one sample. Resuming also refreshes immediately.
- Use the history device filter or **Clear history** to inspect the latest samples.

Names and groups are stored only in this browser, under `sensor2cloud-device-details-v1`. They are not sent to a server. Storage can depend on the browser and address; if saving is blocked, edits last only for the current page session and the page shows a message.

History is held in memory, with a maximum of **100 individual sensor rows across both devices**. One full update adds ten rows while both devices are online. Refreshing the browser clears history. It is not a database. The connection state resets to the demo default on reload.

## Future backend integration

Planned flow:

```text
ESP32-S3 -> Wi-Fi -> MQTT Broker -> Backend -> Database -> Web Dashboard
```

The backend team can use Python or Node.js and SQL or SQLite. The dashboard only needs a JSON HTTP response and does not depend on the backend programming language. MQTT messages should be received and processed by that backend. Broker and database credentials do not belong in these browser files.

The current adapter is a proposed **read-only** interface. The URL below is an example, not a running service. To connect it later:

1. Agree on an endpoint such as `GET /api/devices` and the JSON structure below.
2. Have the backend return exactly two devices, stable device/sensor IDs, all required fields, and timestamps with a timezone such as UTC `Z`.
3. The backend decides connection status from incoming device messages and a team-defined timeout. `lastSeen` is the last device contact; each sensor's `recordedAt` is its measurement time. Keep that measurement timestamp unchanged if no new sample arrives.
4. Serve the dashboard over local HTTP rather than opening a file. If the endpoint has another origin, configure the backend's CORS policy for the dashboard origin. Agree on authentication before deployment.
5. Set `DATA_SETTINGS.apiUrl` in `data.js`, then change `source` from `"simulation"` to `"backend"`.

Minimal **illustrative** response (one sensor per device shown to keep the example short; include all agreed sensor entries in the real endpoint):

```json
[
  {
    "id": "esp32-s3-01",
    "name": "ESP32-S3 01",
    "group": "Lab A",
    "connected": true,
    "lastSeen": "2026-10-17T09:00:00Z",
    "sensors": [
      {"id": "potentiometer", "name": "Potentiometer position", "interface": "Analog", "gpio": "ADC: not assigned", "value": 42.5, "unit": "%", "recordedAt": "2026-10-17T09:00:00Z"}
    ]
  },
  {
    "id": "esp32-s3-02",
    "name": "ESP32-S3 02",
    "group": "Lab B",
    "connected": false,
    "lastSeen": null,
    "sensors": [
      {"id": "rfid", "name": "MFRC522 RFID tag", "interface": "SPI", "gpio": "SPI pins: not assigned", "value": null, "unit": "", "recordedAt": null}
    ]
  }
]
```

Each sensor requires `id`, `name`, `interface`, `gpio`, `value`, `unit`, and `recordedAt`. The value can be a finite number, text, or `null` for no reading. Use `null` for unknown timestamps and an empty unit for RFID text. Both timestamps and connection states must come from the backend in backend mode.

Backend mode hides the simulation connection buttons and changes the source labels. Failed requests show an error and mark status unknown; they never generate replacement simulation readings. Names and groups still remain local overrides. Shared naming, database history, MQTT subscriptions, authentication, and server-side device commands require future backend work.

## Manual testing checklist

The first version passed local browser checks for the two-device display, timed updates, pause/manual refresh, editing during updates, safe text display, name validation, local persistence, grouping, offline simulation, history filtering/clearing/limits, narrow-screen layout, and blocked browser storage. Mock HTTP responses checked backend data validation, unchanged-sample handling, configuration errors, failed requests, and recovery. These checks used local simulation and mock responses, not live hardware or cloud services.

1. Open the page: verify two boards, five sensor rows each, a simulation notice, and unassigned GPIO labels.
2. Wait at least five seconds: timestamps and values update; history grows, newest first.
3. Pause updates: values stop changing. Refresh manually, then resume.
4. Type into a device name while an automatic update occurs: the text should remain. Save the name and group, filter by that group, and reload to check persistence.
5. Try a name made only of spaces: the form should reject it.
6. Simulate one board offline: its last readings remain, its timestamps stop, and only the online board adds new history. Simulate it online again.
7. Filter history by device. Clear history and confirm the empty message. New samples should appear on the next update.
8. Allow more than ten full updates: confirm history never exceeds 100 sensor rows.
9. Narrow the browser window: tables should scroll horizontally and controls should wrap naturally.
10. When integrating a backend, test valid data, repeated measurement timestamps, missing configuration, HTTP errors, and malformed JSON. Status should become unknown on failures, without generating fake readings.
