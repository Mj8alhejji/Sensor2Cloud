# Sensor2Cloud Dashboard

An initial dashboard for our Cloud Computing project, using HTML, basic CSS, and JavaScript.
All readings and connection states are simulated. GPIO pins are not assigned yet.

## Run

Open `index.html` in a browser. No installation is needed.

## Current features

- Two ESP32-S3 device panels.
- Simulated potentiometer, light, BMP280 temperature and pressure, and RFID readings.
- Automatic updates every 5 seconds, manual refresh, and pause/resume.
- Editable device names and groups, saved in the browser.
- Group filtering and simulated online/offline status.
- Timestamped history with a device filter and clear button. It keeps up to 100 readings and resets when the page reloads.

## Files

- `index.html`: page structure and controls.
- `styles.css`: basic page styling.
- `data.js`: simulated readings, GPIO placeholders, and a place to connect the backend later.
- `dashboard.js`: updates the page, handles buttons, saves device details, and displays history.

## Next steps

Confirm GPIO assignments with the team and connect the dashboard to the backend.
Real devices, MQTT, and database history are not connected yet.
