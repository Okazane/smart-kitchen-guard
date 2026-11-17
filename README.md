# Smart Kitchen Guard

An end-to-end IoT kitchen gas & fire safety system built for **EIU CSN 302**, combining **ESP32 firmware (C/C++)**, a **Node.js + Express + SQLite** backend, a real-time **Web Dashboard**, **Telegram Bot** alerts/controls, and an **AI Safety Advisor**.

---

## Architecture

- **Firmware (`firmware/smart_kitchen_guard/smart_kitchen_guard.ino`)**:
  - Reads **MQ-2** gas sensor with a **10-sample Moving Average (MA10)** filter every `200 ms`
  - Reads **DHT11** temperature & humidity
  - Uses hardware external interrupts (`attachInterrupt`, `FALLING`) for **IR Flame** detection and **Mute/Reset** button
  - Updates an **SSD1306 I2C OLED** display every `100 ms` (non-blocking `millis()`)
  - Classifies 5 safety states (`SAFE`, `COOKING (FAN)`, `WARNING!`, `GAS DANGER!`, `FIRE ALARM!`) with fail-safe **Relay Latch** & ventilation fan control
  - Syncs JSON telemetry over HTTP every `2000 ms`
- **Backend (`server.js`)**:
  - Express REST API (`POST /api/telemetry`, `GET /api/state`, `POST /api/command`, `POST /api/ai-ask`)
  - SQLite persistence (`telemetry`, `incidents`, `command_audit`)
  - Telegram Bot control (`/status`, `/off`, `/restore`, `/mute`, `/fan_on`, `/fan_off` + natural-language Q&A)
  - AI Safety Advisor powered by **Google Gemini** (`GEMINI_API_KEY`) with built-in local Vietnamese fallback analyzer
  - Built-in demo engine when no external ESP32/simulator is connected
- **Hardware Simulator (`simulator.js`)**:
  - Zero-dependency ESP32 telemetry simulator supporting `auto`, `normal`, `cooking`, `warning`, `gas_danger`, and `fire` modes
- **Web Dashboard (`public/`)**:
  - Live telemetry gauges/charts, incident history, command audit log, and AI safety chat

---

## ESP32 Pinout

| Component | GPIO | Notes |
| :--- | :---: | :--- |
| DHT11 (Temp & Humidity) | `4` | Digital sensor |
| Push Button (Mute / Reset Latch) | `18` | `INPUT_PULLUP`, external interrupt |
| OLED SSD1306 I2C (`SDA` / `SCL`) | `21` / `22` | `128x64` display |
| Active Buzzer | `25` | `HIGH = ON`, `LOW = OFF` |
| Relay Channel 1 (Kitchen Power) | `26` | `HIGH = ON`, `LOW = CUT` |
| Relay Channel 2 (Ventilation Fan) | `27` | Active-LOW (`LOW = ON`, `HIGH = OFF`) |
| MQ-2 Gas Sensor | `34` | `ADC1_CH6` |
| IR Flame Sensor | `35` | External interrupt (`LOW = flame`) |

---

## Getting Started

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
```bash
cp .env.example .env
```
Edit `.env` with your optional `BOT_TOKEN`, `CHAT_ID`, and `GEMINI_API_KEY` (or set `DISABLE_TG=true` to run without Telegram).

### 3. Run Backend & Web Dashboard
```bash
npm start
```
Open `http://localhost:3000` in your browser.

### 4. Run Hardware Simulator (Optional)
```bash
npm run sim
# or pick a specific scenario:
node simulator.js warning
```

### 5. Flash ESP32 Firmware (Optional)
Open `firmware/smart_kitchen_guard/smart_kitchen_guard.ino` in Arduino IDE, update `YOUR_WIFI_SSID`, `YOUR_WIFI_PASSWORD`, and `YOUR_SERVER_IP` to match your computer's local IPv4 address, then upload to your ESP32.
