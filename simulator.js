#!/usr/bin/env node
/**
 * ============================================================================
 * SMART KITCHEN GUARD - ESP32 HARDWARE TELEMETRY SIMULATOR (ZERO DEPENDENCIES)
 * ============================================================================
 * Giả lập đầy đủ phần cứng ESP32 (Bộ lọc Moving Average 10 mẫu, DHT11, MQ-2,
 * Flame IR ISR, Relay Kênh 1 Điện bếp, Relay Kênh 2 Quạt thông gió 5V).
 *
 * Cách chạy:
 *   node simulator.js [auto|normal|cooking|warning|gas_danger|fire]
 *
 * Mặc định: `auto` (tự động luân chuyển mượt mà qua các kịch bản để demo biểu đồ
 * hoặc lập tức tuân theo lệnh điều khiển / kịch bản từ Web Dashboard & Telegram).
 * ============================================================================
 */

const http = require('http');

const SERVER_HOST = process.env.SERVER_HOST || 'localhost';
const SERVER_PORT = Number(process.env.SERVER_PORT || 3000);
const INTERVAL_MS = Number(process.env.SIM_INTERVAL_MS || 1500);

const VALID_MODES = ['auto', 'normal', 'cooking', 'warning', 'gas_danger', 'fire'];
const cliArg = (process.argv[2] || 'auto').toLowerCase();
let currentMode = VALID_MODES.includes(cliArg) ? cliArg : 'auto';

// Chu kỳ kịch bản khi chạy ở chế độ `auto` (mỗi kịch bản kéo dài ~10 nhịp = 15 giây)
const AUTO_SEQUENCE = ['normal', 'cooking', 'warning', 'gas_danger', 'normal', 'fire', 'normal'];
let autoStepIndex = 0;
let ticksInCurrentStep = 0;
const TICKS_PER_AUTO_STEP = 10;

// Lấy thông số mục tiêu theo từng kịch bản
function getScenarioTargets(scenario) {
  switch (scenario) {
    case 'cooking':
      // Đang nấu ăn: Độ ẩm > 72%, Gas tăng nhẹ 1550-1750 do hơi thức ăn, Nhiệt ~37.5°C, tempRoR thấp (< 2.0)
      return {
        targetGas: 1650,
        noiseAmp: 170,
        targetTemp: 37.5,
        targetHum: 78.0,
        baseTempRoR: 1.2,
        baseGasRoR: 85,
        flame: false
      };
    case 'warning':
      // Rò gas nhẹ: Độ ẩm bình thường 54%, Gas ~1950 (>= 1600), Nhiệt ~44.5°C
      return {
        targetGas: 1950,
        noiseAmp: 210,
        targetTemp: 44.5,
        targetHum: 54.0,
        baseTempRoR: 3.2,
        baseGasRoR: 340,
        flame: false
      };
    case 'gas_danger':
      // Rò gas nặng: Gas vọt lên ~3150 (>= 2600), Nhiệt ~49°C
      return {
        targetGas: 3150,
        noiseAmp: 250,
        targetTemp: 49.0,
        targetHum: 50.0,
        baseTempRoR: 4.5,
        baseGasRoR: 920,
        flame: false
      };
    case 'fire':
      // Cháy lửa: Cảm biến lửa IR kích hoạt (flame = true), Nhiệt tăng cao ~62°C, Khói ~2450
      return {
        targetGas: 2450,
        noiseAmp: 240,
        targetTemp: 62.0,
        targetHum: 38.0,
        baseTempRoR: 12.5,
        baseGasRoR: 680,
        flame: true
      };
    case 'normal':
    default:
      // Bình thường an toàn
      return {
        targetGas: 620,
        noiseAmp: 130,
        targetTemp: 30.5,
        targetHum: 56.0,
        baseTempRoR: 0.2,
        baseGasRoR: 5,
        flame: false
      };
  }
}

// Bộ lọc Moving Average 10 mẫu (Chuẩn Lab 5 - Bài 1)
const WINDOW_SIZE = 10;
const initialScenario = currentMode === 'auto' ? AUTO_SEQUENCE[0] : currentMode;
const initialTargets = getScenarioTargets(initialScenario);

const gasWindow = Array(WINDOW_SIZE).fill(initialTargets.targetGas);
let windowIdx = 0;

// Trạng thái phần cứng ESP32 giả lập khởi tạo đúng theo kịch bản ban đầu
let temperature = initialTargets.targetTemp;
let humidity = initialTargets.targetHum;
let prevTemp = initialTargets.targetTemp;
let prevGasMA10 = initialTargets.targetGas;
let lastActiveScenario = initialScenario;

let relayOn = true;           // Relay 1 (GPIO 26): Nguồn điện bếp
let fanOn = false;            // Relay 2 (GPIO 27): Quạt thông gió 5V
let isLatched = false;        // Chốt an toàn khi xảy ra DANGER
let isMuted = false;          // Còi báo động bị tắt tiếng tạm thời
let manualFanOverride = null; // null | true | false

// Quy đổi tương đối ADC (0-4095) -> PPM
function estimateGasPPM(adc) {
  if (adc <= 400) return Math.round(20 + (adc / 400) * 130);
  if (adc <= 1600) return Math.round(150 + ((adc - 400) / 1200) * 850);
  if (adc <= 2600) return Math.round(1000 + ((adc - 1600) / 1000) * 2000);
  return Math.round(3000 + ((adc - 2600) / 1495) * 7000);
}

// Sinh nhiễu tự nhiên cho cảm biến Analog MQ-2 để thấy rõ tác dụng làm mượt của MA10 trên biểu đồ
function randomNoise(amplitude) {
  return (Math.random() - 0.5) * 2 * amplitude;
}

// Đặt nhanh trạng thái cảm biến khi chuyển kịch bản để phản hồi tức thì & không gây vọt RoR giả
function applyScenarioBaseline(scenario) {
  const t = getScenarioTargets(scenario);
  for (let i = 0; i < WINDOW_SIZE; i++) {
    gasWindow[i] = Math.round(t.targetGas + randomNoise(t.noiseAmp * 0.25));
  }
  temperature = t.targetTemp;
  humidity = t.targetHum;
  prevTemp = t.targetTemp;
  prevGasMA10 = t.targetGas;
  lastActiveScenario = scenario;

  if (scenario === 'normal' || scenario === 'cooking' || scenario === 'warning') {
    isLatched = false;
    isMuted = false;
    relayOn = true;
    manualFanOverride = null;
  }
}

// Áp dụng lệnh điều khiển trả về từ Server (Web Dashboard / Telegram Bot)
function handleServerCommand(cmd) {
  if (!cmd || cmd === 'NONE') return;
  console.log(`\n⚡ [ESP32-SIM] Nhận lệnh từ Server: ${cmd}`);

  switch (cmd) {
    case 'CUT_POWER':
      isLatched = true;
      relayOn = false;
      break;
    case 'RESTORE':
      if (currentMode === 'gas_danger' || currentMode === 'fire') {
        currentMode = 'normal';
      }
      applyScenarioBaseline('normal');
      fanOn = false;
      break;
    case 'MUTE':
      isMuted = true;
      break;
    case 'FAN_ON':
      manualFanOverride = true;
      fanOn = true;
      break;
    case 'FAN_OFF':
      manualFanOverride = false;
      fanOn = false;
      break;
    case 'SIM_NORMAL':
      currentMode = 'normal';
      applyScenarioBaseline('normal');
      break;
    case 'SIM_COOKING':
      currentMode = 'cooking';
      applyScenarioBaseline('cooking');
      break;
    case 'SIM_WARNING':
      currentMode = 'warning';
      applyScenarioBaseline('warning');
      break;
    case 'SIM_GAS':
      currentMode = 'gas_danger';
      applyScenarioBaseline('gas_danger');
      break;
    case 'SIM_FIRE':
      currentMode = 'fire';
      applyScenarioBaseline('fire');
      break;
    default:
      break;
  }
}

// Tạo 1 gói dữ liệu Telemetry chuẩn xác theo thuật toán trên ESP32
function generateTelemetryStep() {
  let activeScenario = currentMode;
  if (currentMode === 'auto') {
    activeScenario = AUTO_SEQUENCE[autoStepIndex];
    ticksInCurrentStep++;
    if (ticksInCurrentStep >= TICKS_PER_AUTO_STEP) {
      ticksInCurrentStep = 0;
      autoStepIndex = (autoStepIndex + 1) % AUTO_SEQUENCE.length;
      activeScenario = AUTO_SEQUENCE[autoStepIndex];
      applyScenarioBaseline(activeScenario);
    }
  } else if (activeScenario !== lastActiveScenario) {
    applyScenarioBaseline(activeScenario);
  }

  const targets = getScenarioTargets(activeScenario);

  // Tiến dần Nhiệt độ & Độ ẩm về giá trị mục tiêu với độ mượt thực tế của DHT11
  temperature += (targets.targetTemp - temperature) * 0.35 + randomNoise(0.2);
  humidity += (targets.targetHum - humidity) * 0.35 + randomNoise(0.5);
  temperature = Math.max(20, Math.min(95, temperature));
  humidity = Math.max(20, Math.min(99, humidity));

  // Đọc mẫu Gas Raw có nhiễu mạnh (mô phỏng nhiễu ADC thực tế của MQ-2)
  const rawSample = Math.round(
    Math.max(100, Math.min(4095, targets.targetGas + randomNoise(targets.noiseAmp)))
  );

  // Cập nhật cửa sổ trượt Moving Average 10 mẫu (MA10)
  gasWindow[windowIdx] = rawSample;
  windowIdx = (windowIdx + 1) % WINDOW_SIZE;
  const gasMA10 = Math.round(gasWindow.reduce((sum, val) => sum + val, 0) / WINDOW_SIZE);
  const gasPPM = estimateGasPPM(gasMA10);

  // Tính tốc độ biến thiên (Rate-of-Rise) mỗi phút mượt mà, không bị khuếch đại nhiễu 1.5s
  const tempRoR = Number(
    Math.max(-2.0, targets.baseTempRoR + randomNoise(0.25)).toFixed(1)
  );
  const gasRoR = Math.round(targets.baseGasRoR + randomNoise(25));
  prevTemp = temperature;
  prevGasMA10 = gasMA10;

  const flame = Boolean(targets.flame);

  // Phân loại trạng thái & Điều khiển Quạt / Relay y hệt hàm evaluateSafety() trên ESP32
  let level = 0;
  let status = 'SAFE';

  if (flame || gasMA10 >= 2600 || temperature >= 55.0 || isLatched) {
    level = 2;
    isLatched = true;
    relayOn = false; // Cắt nguồn điện bếp

    // Quy tắc PCCC: Có lửa -> TẮT QUẠT (tránh thổi oxy); Rò gas nặng -> BẬT QUẠT hút gas
    if (flame) {
      status = 'FIRE ALARM!';
      fanOn = false;
    } else {
      status = 'GAS DANGER!';
      fanOn = true;
    }
  } else if (humidity > 72.0 && gasMA10 >= 1400 && gasMA10 < 2000 && temperature < 48.0) {
    level = 0;
    status = 'COOKING (FAN)';
    relayOn = true;
    fanOn = true; // Bật quạt hút khói/hơi nước nấu ăn, không kêu còi
  } else if (gasMA10 >= 1600 || temperature >= 46.0 || tempRoR >= 4.0) {
    level = 1;
    status = 'WARNING!';
    relayOn = true;
    fanOn = true; // Bật quạt thông gió
  } else {
    level = 0;
    status = 'SAFE';
    relayOn = true;
    isMuted = false;
    fanOn = manualFanOverride !== null ? manualFanOverride : false;
  }

  return {
    source: 'simulator',
    temp: Number(temperature.toFixed(1)),
    hum: Number(humidity.toFixed(1)),
    gas_raw: rawSample,
    gas_ma10: gasMA10,
    gas_ppm: gasPPM,
    temp_ror: tempRoR,
    gas_ror: gasRoR,
    flame,
    level,
    status,
    relay_on: relayOn,
    fan_on: fanOn,
    latched: isLatched,
    muted: isMuted,
    sim_scenario: activeScenario
  };
}

// Gửi HTTP POST tới http://localhost:3000/api/telemetry
function sendTelemetry() {
  const payload = generateTelemetryStep();
  const body = JSON.stringify(payload);

  const req = http.request(
    {
      hostname: SERVER_HOST,
      port: SERVER_PORT,
      path: '/api/telemetry',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 3000
    },
    (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        console.log(
          `[ESP32->Server] Mode=${payload.sim_scenario.toUpperCase()} | ` +
            `T=${payload.temp}°C (RoR:${payload.temp_ror}) H=${payload.hum}% | ` +
            `GasRaw=${payload.gas_raw} MA10=${payload.gas_ma10} (${payload.gas_ppm}ppm) | ` +
            `ST="${payload.status}" | Pwr=${payload.relay_on ? 'ON' : 'CUT'} Fan=${payload.fan_on ? 'ON' : 'OFF'}`
        );
        try {
          const parsed = JSON.parse(data);
          if (parsed && parsed.command && parsed.command !== 'NONE') {
            handleServerCommand(parsed.command);
          } else if (
            parsed &&
            parsed.sim_mode &&
            VALID_MODES.includes(String(parsed.sim_mode).toLowerCase()) &&
            currentMode !== 'auto' &&
            String(parsed.sim_mode).toLowerCase() !== currentMode
          ) {
            currentMode = String(parsed.sim_mode).toLowerCase();
            applyScenarioBaseline(currentMode);
          }
        } catch (_) {
          // Bỏ qua nếu phản hồi không phải JSON
        }
      });
    }
  );

  req.on('error', (err) => {
    console.error(`[ESP32-SIM] Không kết nối được Server (${SERVER_HOST}:${SERVER_PORT}): ${err.message}`);
  });

  req.write(body);
  req.end();
}

console.log('====================================================================');
console.log(' 🚀 SMART KITCHEN GUARD - ESP32 SIMULATOR STARTED');
console.log(` 📍 Target API : http://${SERVER_HOST}:${SERVER_PORT}/api/telemetry`);
console.log(` 🎛️  CLI Mode   : ${currentMode.toUpperCase()} (Hỗ trợ: auto | normal | cooking | warning | gas_danger | fire)`);
console.log('====================================================================');

sendTelemetry();
setInterval(sendTelemetry, INTERVAL_MS);
