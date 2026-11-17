/**
 * SMART KITCHEN GUARD - ALL-IN-ONE BACKEND (EIU CSN 302 IoT Project)
 * ------------------------------------------------------------------
 *  - Express REST API   : POST /api/telemetry, GET /api/state, POST /api/command, POST /api/ai-ask
 *  - SQLite database    : smart_home.db (telemetry, incidents, command_audit)
 *  - Web Dashboard      : ./public  ->  http://localhost:3000
 *  - Telegram Bot       : /status /off /restore /mute /fan_on /fan_off + hoi dap AI (tieng Viet)
 *  - AI Safety Advisor  : Gemini (neu co GEMINI_API_KEY) hoac bo phan tich noi bo tieng Viet
 *  - Demo engine        : tu sinh du lieu gia lap khi chua co ESP32 / simulator.js
 *
 * Bien moi truong (tuy chon):
 *   PORT, BOT_TOKEN, CHAT_ID, GEMINI_API_KEY
 *   DISABLE_TG_POLLING=true  -> khong nhan lenh Telegram (van gui duoc canh bao)
 *   DISABLE_TG=true          -> tat han Telegram (khong polling, khong gui) - dung khi test tu dong
 *
 * Quy uoc du lieu: moi co (flame, relay_on, fan_on, latched, muted) la so 0/1.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();

// Load .env neu co (khong ghi de bien moi truong da set san)
try {
  const envFile = path.join(__dirname, '.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
      }
    }
  }
} catch (_) {}

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ALLOWED_CHAT_ID = String(process.env.CHAT_ID || '');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const TG_DISABLED = process.env.DISABLE_TG === 'true';
const TG_POLLING_DISABLED = TG_DISABLED || process.env.DISABLE_TG_POLLING === 'true' || process.env.TELEGRAM_POLLING === 'false';

const EXTERNAL_TIMEOUT_MS = 10000;   // sau 10s khong co telemetry that -> server tu sinh du lieu demo
const SIM_TICK_MS = 1500;
const ALERT_COOLDOWN_MS = 30000;
const CMD_TTL_MS = 30000;

const log = (...a) => console.log(new Date().toLocaleTimeString('vi-VN'), ...a);
process.on('unhandledRejection', (e) => log('[unhandledRejection]', e && e.message ? e.message : e));
process.on('uncaughtException', (e) => log('[uncaughtException]', e && e.message ? e.message : e));

// =====================================================================
// 1. SQLITE
// =====================================================================
const db = new sqlite3.Database(path.join(__dirname, 'smart_home.db'));
const dbRun = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res({ lastID: this.lastID, changes: this.changes }); }));
const dbAll = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
const dbGet = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r))));

async function initDb() {
  await dbRun(`CREATE TABLE IF NOT EXISTS telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, temp REAL, hum REAL,
    gas_raw INTEGER, gas_ma10 INTEGER, gas_ppm REAL, temp_ror REAL, gas_ror REAL,
    flame INTEGER, level INTEGER, status TEXT, relay_on INTEGER, fan_on INTEGER,
    latched INTEGER, muted INTEGER)`);
  await dbRun(`CREATE TABLE IF NOT EXISTS incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, level INTEGER, status TEXT,
    reason TEXT, gas_ma10 INTEGER, temp REAL, resolved_at TEXT)`);
  await dbRun(`CREATE TABLE IF NOT EXISTS command_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, source TEXT, chat_id TEXT,
    command TEXT, result TEXT)`);
}

// Tuan tu hoa moi thao tac ghi trang thai de tranh race giua telemetry that / gia lap / lenh
let chain = Promise.resolve();
function serial(fn) {
  const p = chain.then(() => fn());
  chain = p.catch((e) => log('[serial]', e && e.message ? e.message : e));
  return p;
}

async function logAudit(source, chatId, command, result) {
  try {
    await dbRun('INSERT INTO command_audit (timestamp, source, chat_id, command, result) VALUES (?,?,?,?,?)',
      [new Date().toISOString(), source || 'unknown', chatId ? String(chatId) : '', command, result || '']);
  } catch (e) { log('[audit]', e.message); }
}

// =====================================================================
// 2. TRANG THAI HIEN TAI
// =====================================================================
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const flag = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);
const r1 = (v) => Math.round(v * 10) / 10;

let simMode = 'normal';                 // normal | cooking | warning | gas_danger | fire
let lastExternalTs = 0;                 // thoi diem nhan telemetry that cuoi cung
let lastExternalSource = 'esp32';
let current = null;                     // ban ghi telemetry moi nhat (+ sim_mode, source, device_online)
let cmdQueue = [];                      // lenh cho thiet bi that: [{command, ts}]
let insertCount = 0;

const deviceOnline = () => Date.now() - lastExternalTs < EXTERNAL_TIMEOUT_MS;

function gasToPpm(ma) { return Math.round(Math.max(0, ma - 500) * 1.6); } // xap xi cho MQ-2 (LPG)

function levelFromStatus(status) {
  const s = String(status || '').toUpperCase();
  if (s.includes('DANGER') || s.includes('FIRE')) return 2;
  if (s.includes('WARNING')) return 1;
  return 0;
}

// Tinh toc do tang (Rate-of-Rise) / phut tu lich su gan day (dung khi thiet bi khong gui san)
const rorHist = [];
function computeRor(ts, temp, gas) {
  rorHist.push({ ts, temp, gas });
  while (rorHist.length && ts - rorHist[0].ts > 60000) rorHist.shift();
  const first = rorHist[0];
  const dt = (ts - first.ts) / 60000;
  if (dt < 10 / 60) return { temp_ror: 0, gas_ror: 0 };
  return { temp_ror: r1((temp - first.temp) / dt), gas_ror: Math.round((gas - first.gas) / dt) };
}

function normalize(raw) {
  const t = {};
  t.temp = r1(num(raw.temp, 30));
  t.hum = r1(num(raw.hum, 50));
  t.gas_raw = Math.round(num(raw.gas_raw, 0));
  t.gas_ma10 = Math.round(num(raw.gas_ma10, t.gas_raw));
  t.gas_ppm = raw.gas_ppm !== undefined ? Math.round(num(raw.gas_ppm)) : gasToPpm(t.gas_ma10);
  t.flame = flag(raw.flame);
  t.status = String(raw.status || 'SAFE');
  t.level = raw.level !== undefined ? Math.round(num(raw.level)) : levelFromStatus(t.status);
  t.relay_on = raw.relay_on === undefined ? 1 : flag(raw.relay_on);
  t.fan_on = flag(raw.fan_on);
  t.latched = flag(raw.latched);
  t.muted = flag(raw.muted);
  if (raw.temp_ror !== undefined || raw.gas_ror !== undefined) {
    t.temp_ror = r1(num(raw.temp_ror));
    t.gas_ror = Math.round(num(raw.gas_ror));
  }
  return t;
}

async function saveTelemetry(t) {
  await dbRun(`INSERT INTO telemetry (timestamp,temp,hum,gas_raw,gas_ma10,gas_ppm,temp_ror,gas_ror,flame,level,status,relay_on,fan_on,latched,muted)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [t.timestamp, t.temp, t.hum, t.gas_raw, t.gas_ma10, t.gas_ppm, t.temp_ror, t.gas_ror, t.flame, t.level, t.status, t.relay_on, t.fan_on, t.latched, t.muted]);
  if (++insertCount % 500 === 0) {
    dbRun('DELETE FROM telemetry WHERE id < (SELECT MAX(id) FROM telemetry) - 20000').catch(() => {});
  }
}

// =====================================================================
// 3. SU CO (INCIDENTS) + CANH BAO TELEGRAM
// =====================================================================
let openIncident = null; // { id, level, peakGas, peakTemp, lastAlertTs, lastAlertLevel, status }

function buildReasons(t) {
  const r = [];
  if (t.flame) r.push('Cảm biến lửa IR phát hiện ngọn lửa');
  if (t.gas_ma10 >= 2600) r.push(`Nồng độ khí gas rất cao (MA10=${t.gas_ma10}, ~${t.gas_ppm} ppm)`);
  else if (t.gas_ma10 >= 1600) r.push(`Khí gas vượt ngưỡng cảnh báo (MA10=${t.gas_ma10}, ~${t.gas_ppm} ppm)`);
  if (t.temp >= 55) r.push(`Nhiệt độ bếp quá cao (${t.temp}°C)`);
  else if (t.temp >= 46) r.push(`Nhiệt độ bếp cao (${t.temp}°C)`);
  if (t.temp_ror >= 4) r.push(`Nhiệt độ tăng nhanh (+${t.temp_ror}°C/phút)`);
  if (!r.length && t.latched) r.push('Chốt an toàn đang giữ / cắt điện thủ công');
  if (!r.length) r.push(`Trạng thái ${t.status}`);
  return r.join('; ');
}

let tgBot = null;
function tgSend(text, opts) {
  if (!tgBot || !ALLOWED_CHAT_ID) return Promise.resolve();
  return tgBot.sendMessage(ALLOWED_CHAT_ID, text, opts).catch((e) => log('[telegram send]', e.message));
}

function alertText(t, reason, source) {
  const tag = source === 'internal' ? ' [GIẢ LẬP]' : '';
  const head = t.flame ? '🔥 BÁO ĐỘNG CHÁY!' : t.level >= 2 ? '🚨 NGUY HIỂM - RÒ RỈ GAS / QUÁ NHIỆT!' : '⚠️ CẢNH BÁO NHÀ BẾP';
  const action = t.level >= 2
    ? `Điện bếp: ${t.relay_on ? 'CHƯA cắt' : 'ĐÃ CẮT'} | Quạt: ${t.fan_on ? 'BẬT' : 'TẮT'}`
    : `Quạt hút: ${t.fan_on ? 'BẬT' : 'TẮT'}`;
  return `${head}${tag}\nTrạng thái: ${t.status}\nLý do: ${reason}\nNhiệt độ ${t.temp}°C | Ẩm ${t.hum}% | Gas MA10 ${t.gas_ma10} (~${t.gas_ppm} ppm)\n${action}\n\nLệnh: /status /mute /restore /fan_on /fan_off`;
}

async function handleIncident(t, source) {
  const now = Date.now();
  if (t.level >= 1) {
    const reason = buildReasons(t);
    if (!openIncident) {
      const r = await dbRun('INSERT INTO incidents (timestamp, level, status, reason, gas_ma10, temp, resolved_at) VALUES (?,?,?,?,?,?,NULL)',
        [t.timestamp, t.level, t.status, reason, t.gas_ma10, t.temp]);
      openIncident = { id: r.lastID, level: t.level, status: t.status, peakGas: t.gas_ma10, peakTemp: t.temp, lastAlertTs: 0, lastAlertLevel: 0 };
      log(`[incident #${r.lastID}] ${t.status} - ${reason}`);
    } else {
      const escalated = t.level > openIncident.level || (t.status !== openIncident.status && t.level >= openIncident.level);
      const higherGas = t.gas_ma10 > openIncident.peakGas;
      const higherTemp = t.temp > openIncident.peakTemp;
      if (escalated || higherGas || higherTemp) {
        openIncident.level = Math.max(openIncident.level, t.level);
        if (escalated) openIncident.status = t.status;
        openIncident.peakGas = Math.max(openIncident.peakGas, t.gas_ma10);
        openIncident.peakTemp = Math.max(openIncident.peakTemp, t.temp);
        if (escalated) {
          await dbRun('UPDATE incidents SET level=?, status=?, reason=?, gas_ma10=?, temp=? WHERE id=?',
            [openIncident.level, openIncident.status, reason, openIncident.peakGas, openIncident.peakTemp, openIncident.id]);
        } else {
          await dbRun('UPDATE incidents SET gas_ma10=?, temp=? WHERE id=?', [openIncident.peakGas, openIncident.peakTemp, openIncident.id]);
        }
      }
    }
    // Canh bao Telegram: leo thang thi gui ngay, cung muc thi cach nhau >= 30s
    const escalatedAlert = t.level > openIncident.lastAlertLevel;
    const cooled = now - openIncident.lastAlertTs >= ALERT_COOLDOWN_MS;
    if (escalatedAlert && (t.level >= 2 || cooled)) {
      openIncident.lastAlertTs = now;
      openIncident.lastAlertLevel = t.level;
      tgSend(alertText(t, reason, source));
    }
  } else if (openIncident) {
    await dbRun('UPDATE incidents SET resolved_at=? WHERE id=?', [t.timestamp, openIncident.id]);
    log(`[incident #${openIncident.id}] đã xử lý xong`);
    if (openIncident.lastAlertLevel > 0) {
      tgSend(`✅ Nhà bếp đã trở lại AN TOÀN${source === 'internal' ? ' [GIẢ LẬP]' : ''}.\nTrạng thái: ${t.status} | Gas MA10 ${t.gas_ma10} | ${t.temp}°C`);
    }
    openIncident = null;
  }
}

// Ghi nhan 1 ban ghi telemetry (chung cho ESP32, simulator.js va engine noi bo)
function ingest(raw, source) {
  return serial(async () => {
    const t = normalize(raw);
    t.timestamp = new Date().toISOString();
    if (t.temp_ror === undefined) Object.assign(t, computeRor(Date.now(), t.temp, t.gas_ma10));
    else computeRor(Date.now(), t.temp, t.gas_ma10);
    if (source !== 'internal') { lastExternalTs = Date.now(); lastExternalSource = source; }
    current = Object.assign({}, t, { sim_mode: simMode, source, device_online: source !== 'internal' });
    await saveTelemetry(t);
    await handleIncident(t, source);
    return current;
  });
}

// =====================================================================
// 4. ENGINE GIA LAP (DEMO) - phan anh dung logic firmware
// =====================================================================
const SCEN = {
  normal:     { gas: 700,  temp: 29, hum: 55, flame: 0, sigma: 35 },
  cooking:    { gas: 1500, temp: 34, hum: 82, flame: 0, sigma: 90 },
  warning:    { gas: 1950, temp: 35, hum: 55, flame: 0, sigma: 90 },
  gas_danger: { gas: 3100, temp: 33, hum: 52, flame: 0, sigma: 110 },
  fire:       { gas: 1300, temp: 64, hum: 38, flame: 1, sigma: 90 },
  custom:     { gas: 700,  temp: 29, hum: 55, flame: 0, sigma: 15 },
};
const SIM_CMD = { SIM_NORMAL: 'normal', SIM_COOKING: 'cooking', SIM_WARNING: 'warning', SIM_GAS: 'gas_danger', SIM_FIRE: 'fire' };

const sim = {
  base: { gas: 700, temp: 29, hum: 55 },
  win: new Array(10).fill(700),
  winIdx: 0,
  latched: 0, latchType: null,   // 'fire' | 'gas' | 'manual'
  muted: 0,
  fanOverride: null,             // {value, status}
  status: 'SAFE', level: 0,
};
const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

function simHardReset(mode) {
  const sc = SCEN[mode];
  sim.base = { gas: sc.gas, temp: sc.temp, hum: sc.hum };
  sim.win.fill(sc.gas);
  sim.latched = 0; sim.latchType = null; sim.muted = 0; sim.fanOverride = null;
  sim.status = 'SAFE'; sim.level = 0;
}

function simSetMode(mode) {
  const sc = SCEN[mode];
  simMode = mode;
  // Chon kich ban = mo khoa chot + dua cam bien ve kich ban ngay (1-click demo)
  sim.latched = 0; sim.latchType = null; sim.muted = 0; sim.fanOverride = null;
  sim.base.gas = sc.gas; sim.base.hum = sc.hum;
  sim.win.fill(sc.gas);
  if (mode !== 'fire') sim.base.temp = sc.temp;   // nhiet do cua kich ban chay se tang dan (de thay Rate-of-Rise)
  sim.status = 'SAFE'; sim.level = 0;
}

function simBuildTelemetry() {
  const sc = SCEN[simMode];
  sim.base.gas += (sc.gas - sim.base.gas) * 0.35;
  const tStep = (sc.temp - sim.base.temp) * 0.12;
  const tMax = simMode === 'fire' ? 1.5 : 0.06;   // < 4°C/phut (tru khi chay) de khong kich hoat nhanh Rate-of-Rise
  sim.base.temp += Math.max(-tMax, Math.min(tMax, tStep));
  sim.base.hum += (sc.hum - sim.base.hum) * 0.3;
  const raw = Math.max(0, Math.min(4095, Math.round(sim.base.gas + gauss() * sc.sigma)));
  sim.win[sim.winIdx] = raw; sim.winIdx = (sim.winIdx + 1) % 10;
  const ma = Math.round(sim.win.reduce((a, b) => a + b, 0) / 10);
  const temp = r1(sim.base.temp + gauss() * 0.15);
  const hum = r1(Math.max(0, Math.min(100, sim.base.hum + gauss() * 0.8)));
  const flame = sc.flame;
  const { temp_ror } = computeRorPeek(temp);

  // ---- Phan loai trang thai (giong evaluateSafety() cua firmware) ----
  const flameNow = !!flame;
  let status = sim.status, level = sim.level, fan = 0, relay = 1;
  if (flameNow && sim.latchType !== 'fire') { sim.latched = 1; sim.latchType = 'fire'; }
  if (!sim.latched && (ma >= 2600 || temp >= 55)) { sim.latched = 1; sim.latchType = 'gas'; }
  if (sim.latched) {
    level = 2; relay = 0;
    status = sim.latchType === 'fire' ? 'FIRE ALARM!' : 'GAS DANGER!';
    fan = sim.latchType === 'fire' ? 0 : 1;
  } else if (hum > 72 && ma >= 1400 && ma < 2000 && temp < 48) {
    level = 0; status = 'COOKING (FAN)'; fan = 1; sim.muted = 0;
  } else if (ma >= 1600 || temp >= 46 || temp_ror >= 4) {
    level = 1; status = 'WARNING!'; fan = 1;
  } else if (ma < 1400 && temp < 43) {
    level = 0; status = 'SAFE'; fan = 0; sim.muted = 0;
  } else {
    fan = (sim.level >= 1 || sim.status.startsWith('COOKING')) ? 1 : 0; // vung hysteresis: giu nguyen
  }
  if (status !== sim.status && sim.fanOverride && sim.fanOverride.status !== status) sim.fanOverride = null;
  sim.status = status; sim.level = level;
  if (sim.fanOverride && !flameNow && sim.latchType !== 'fire') fan = sim.fanOverride.value;
  return {
    temp, hum, gas_raw: raw, gas_ma10: ma, gas_ppm: gasToPpm(ma), flame, level, status,
    relay_on: relay, fan_on: fan, latched: sim.latched, muted: sim.muted,
  };
}
function computeRorPeek(temp) {
  const first = rorHist[0];
  if (!first) return { temp_ror: 0 };
  const dt = (Date.now() - first.ts) / 60000;
  return dt < 10 / 60 ? { temp_ror: 0 } : { temp_ror: (temp - first.temp) / dt };
}

function internalTick() {
  if (deviceOnline()) return Promise.resolve();
  return ingest(simBuildTelemetry(), 'internal');
}

// =====================================================================
// 5. LENH DIEU KHIEN (Web / Telegram)
// =====================================================================
const REAL_CMDS = ['CUT_POWER', 'RESTORE', 'MUTE', 'FAN_ON', 'FAN_OFF'];
const ALL_CMDS = REAL_CMDS.concat(Object.keys(SIM_CMD));

function isHazard(c) { return !!c.flame || c.gas_ma10 >= 1400 || c.temp >= 43; }

/** Thuc thi 1 lenh. Tra ve { ok, result } */
function executeCommand(command, source, chatId) {
  return serial(async () => {
    let ok = true, result = '';
    const cur = current || {};
    const live = deviceOnline();

    if (SIM_CMD[command]) {
      simSetMode(SIM_CMD[command]);
      result = live
        ? `Đã chọn kịch bản ${simMode}. Thiết bị đang gửi dữ liệu thật nên chỉ simulator.js mới làm theo`
        : `Đã chuyển kịch bản giả lập: ${simMode}`;
      if (!live) { const t = simBuildTelemetry(); await ingestLocked(t, 'internal'); }
      else if (current) {
        current.sim_mode = simMode;
        cmdQueue.push({ command, ts: Date.now() });   // simulator.js nhận SIM_* qua trường "command" (ESP32 thật bỏ qua lệnh lạ)
      }
    } else if (command === 'RESTORE' && isHazard(cur)) {
      ok = false;
      result = `Từ chối: chưa an toàn (${cur.flame ? 'còn lửa' : `Gas MA10=${cur.gas_ma10}, ${cur.temp}°C`}). Hạ gas < 1400, nhiệt < 43°C rồi thử lại`;
    } else if (command === 'FAN_ON' && (cur.flame || String(cur.status).startsWith('FIRE'))) {
      ok = false;
      result = 'Từ chối: đang có lửa, bật quạt sẽ thổi oxy làm cháy to hơn';
    } else {
      // --- cap nhat ngay trang thai de giao dien phan hoi tuc thi ---
      if (!live) {
        applyToSim(command);
        await ingestLocked(simBuildTelemetry(), 'internal');
        result = 'Đã thực hiện (chế độ giả lập)';
      } else {
        patchCurrent(command);
        cmdQueue.push({ command, ts: Date.now() });
        result = 'Đã gửi lệnh, chờ thiết bị nhận ở lượt đồng bộ kế tiếp (≤2s)';
      }
    }
    await logAudit(source, chatId, command, `${ok ? 'OK' : 'REFUSED'}: ${result}`);
    log(`[cmd] ${source} ${command} -> ${ok ? 'OK' : 'REFUSED'}`);
    return { ok, result };
  });
}

// ingest() dung serial(); trong executeCommand da o trong serial nen dung ban khong khoa
async function ingestLocked(raw, source) {
  const t = normalize(raw);
  t.timestamp = new Date().toISOString();
  Object.assign(t, computeRor(Date.now(), t.temp, t.gas_ma10));
  current = Object.assign({}, t, { sim_mode: simMode, source, device_online: false });
  await saveTelemetry(t);
  await handleIncident(t, source);
}

function applyToSim(command) {
  const cur = current || {};
  if (command === 'CUT_POWER') { if (!sim.latched) { sim.latched = 1; sim.latchType = 'manual'; } }
  else if (command === 'RESTORE') { sim.latched = 0; sim.latchType = null; sim.muted = 0; sim.status = 'SAFE'; sim.level = 0; }
  else if (command === 'MUTE') sim.muted = 1;
  else if (command === 'FAN_ON') sim.fanOverride = { value: 1, status: cur.status };
  else if (command === 'FAN_OFF') sim.fanOverride = { value: 0, status: cur.status };
}

function patchCurrent(command) {
  if (!current) return;
  if (command === 'CUT_POWER') Object.assign(current, { relay_on: 0, latched: 1, level: 2 });
  else if (command === 'RESTORE') Object.assign(current, { relay_on: 1, latched: 0, level: 0, status: 'SAFE' });
  else if (command === 'MUTE') current.muted = 1;
  else if (command === 'FAN_ON') current.fan_on = 1;
  else if (command === 'FAN_OFF') current.fan_on = 0;
}

// =====================================================================
// 6. AI SAFETY ADVISOR (Gemini hoac bo phan tich noi bo)
// =====================================================================
const stripVi = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');

function describeState(c) {
  return `Trạng thái: ${c.status} (mức ${c.level}). Nhiệt độ ${c.temp}°C (${c.temp_ror >= 0 ? '+' : ''}${c.temp_ror}°C/phút), độ ẩm ${c.hum}%, ` +
    `Gas MA10 = ${c.gas_ma10} (~${c.gas_ppm} ppm, raw ${c.gas_raw}), lửa: ${c.flame ? 'CÓ' : 'không'}. ` +
    `Điện bếp: ${c.relay_on ? 'đang cấp' : 'ĐÃ CẮT'}, quạt hút: ${c.fan_on ? 'BẬT' : 'tắt'}, chốt an toàn: ${c.latched ? 'đang khóa' : 'không'}, còi: ${c.muted ? 'đã tắt tiếng' : (c.level >= 1 ? 'đang kêu' : 'im')}.`;
}

function advice(c) {
  if (c.flame || String(c.status).startsWith('FIRE'))
    return '🔥 CÓ LỬA! Tắt bình gas/van gas nếu an toàn, rời khỏi bếp, KHÔNG bật quạt (thổi oxy làm lửa lớn hơn), dùng bình chữa cháy hoặc gọi 114. Sau khi dập tắt xong mới nhấn Khôi phục điện.';
  if (c.level >= 2)
    return '🚨 Nghi rò gas/quá nhiệt: khóa van bình gas, KHÔNG bật/tắt công tắc điện hay dùng lửa, mở cửa thông gió (quạt hút đang chạy), rời khỏi khu vực. Chỉ khôi phục điện khi gas < 1400 và nhiệt < 43°C.';
  if (c.level === 1)
    return '⚠️ Cảnh báo sớm: kiểm tra van gas, ống dẫn và bếp có bị tắt lửa không, mở cửa sổ. Quạt đã bật để làm loãng khí; theo dõi xu hướng Gas trên dashboard.';
  if (String(c.status).startsWith('COOKING'))
    return '🍳 Đang nấu ăn: độ ẩm cao kèm khí/khói nhẹ nên hệ thống bật quạt hút mà không hú còi (tránh báo giả). Nếu gas tiếp tục tăng ≥ 1600 sẽ chuyển WARNING.';
  return '✅ Mọi thứ bình thường, không cần xử lý. Quạt tắt, điện bếp cấp đầy đủ.';
}

function localAdvisor(question, c) {
  if (!c) return 'Chưa có dữ liệu cảm biến. Hãy bật ESP32 hoặc chờ vài giây để hệ thống thu thập dữ liệu.';
  const q = stripVi(question);
  const has = (...k) => k.some((x) => q.includes(x));
  let ans;
  if (has('quat', 'fan', 'thong gio', 'hut gio')) {
    ans = `Quạt hút hiện ${c.fan_on ? 'đang BẬT' : 'đang TẮT'}. Quy tắc: SAFE → tắt; COOKING/WARNING/GAS DANGER → bật để làm loãng khí và hơi; FIRE → luôn TẮT vì quạt thổi oxy vào đám cháy. ` +
      (c.fan_on ? 'Bật vì ' + (c.level >= 1 ? 'khí gas/nhiệt đang cao.' : 'đang nấu ăn (độ ẩm ' + c.hum + '%).') : 'Vì chưa cần thông gió.');
  } else if (has('gas', 'khi', 'khoi', 'mq')) {
    ans = `Gas MQ-2 lọc MA10 = ${c.gas_ma10} (raw ${c.gas_raw}, ~${c.gas_ppm} ppm). Ngưỡng: < 1400 an toàn, ≥ 1600 cảnh báo, ≥ 2600 nguy hiểm (cắt điện). ` +
      (c.gas_ma10 >= 2600 ? 'Đang ở mức NGUY HIỂM.' : c.gas_ma10 >= 1600 ? 'Đang ở mức CẢNH BÁO.' : c.gas_ma10 >= 1400 ? 'Hơi cao nhưng chưa tới ngưỡng cảnh báo.' : 'Trong ngưỡng an toàn.') +
      ` Tốc độ thay đổi: ${c.gas_ror >= 0 ? '+' : ''}${c.gas_ror}/phút.`;
  } else if (has('nhiet', 'nong', 'temp')) {
    ans = `Nhiệt độ bếp ${c.temp}°C, tốc độ thay đổi ${c.temp_ror >= 0 ? '+' : ''}${c.temp_ror}°C/phút. Ngưỡng: ≥ 46°C cảnh báo, ≥ 55°C nguy hiểm, tăng ≥ 4°C/phút cũng cảnh báo sớm. ` +
      (c.temp >= 55 ? 'Đang QUÁ NHIỆT.' : c.temp >= 46 ? 'Đang cao, cần kiểm tra bếp.' : 'Bình thường.');
  } else if (has('am', 'hum', 'nau', 'hoi nuoc', 'bao gia', 'cooking')) {
    ans = `Độ ẩm ${c.hum}%. Khi độ ẩm > 72% kèm gas/khói 1400–2000 và nhiệt < 48°C, hệ thống nhận diện là đang NẤU ĂN (COOKING): bật quạt, không hú còi để tránh báo động giả. Hiện tại: ${c.status}.`;
  } else if (has('dien', 'relay', 'cat', 'khoi phuc', 'reset', 'chot', 'latch')) {
    ans = `Điện bếp (Relay 1) ${c.relay_on ? 'đang cấp' : 'ĐÃ BỊ CẮT'}, chốt an toàn ${c.latched ? 'đang khóa' : 'không khóa'}. ` +
      (c.latched ? 'Chỉ khôi phục được khi hết lửa, Gas MA10 < 1400 và nhiệt < 43°C (nhấn nút trên mạch, Telegram /restore hoặc nút Khôi phục trên dashboard).' : 'Hệ thống sẽ tự cắt điện khi có lửa, gas ≥ 2600 hoặc nhiệt ≥ 55°C.');
  } else if (has('lua', 'chay', 'flame', 'fire')) {
    ans = c.flame ? 'Cảm biến lửa IR ĐANG phát hiện lửa!' : 'Cảm biến lửa IR hiện KHÔNG phát hiện lửa. Khi có lửa, ISR cắt điện + bật còi trong < 1ms, không phụ thuộc Wi-Fi.';
  } else if (has('an toan', 'sao', 'tinh trang', 'status', 'the nao', 'ok khong', 'binh thuong')) {
    ans = c.level === 0 ? 'Hiện tại bếp ' + (String(c.status).startsWith('COOKING') ? 'đang nấu ăn, vẫn an toàn.' : 'an toàn.') : 'Hiện tại KHÔNG hoàn toàn an toàn.';
  } else {
    ans = '';
  }
  return `${ans ? ans + '\n\n' : ''}📊 ${describeState(c)}\n\n${advice(c)}`;
}

async function askAI(question) {
  const c = current;
  if (GEMINI_API_KEY && c) {
    try {
      const { GoogleGenerativeAI } = require('@google/generative-ai');
      const model = new GoogleGenerativeAI(GEMINI_API_KEY).getGenerativeModel({ model: 'gemini-2.5-flash' });
      const prompt = `Bạn là trợ lý an toàn nhà bếp thông minh (hệ thống ESP32 + MQ-2 + cảm biến lửa + DHT11). Trả lời NGẮN GỌN bằng tiếng Việt, ưu tiên an toàn.\n` +
        `Quy tắc hệ thống: SAFE (gas MA10<1400, nhiệt<43): quạt tắt. COOKING (ẩm>72%, gas 1400-2000, nhiệt<48): quạt bật, không còi. WARNING (gas>=1600 hoặc nhiệt>=46 hoặc nhiệt tăng>=4°C/phút): quạt+còi. ` +
        `GAS DANGER (gas>=2600 hoặc nhiệt>=55, chốt): cắt điện bếp, quạt bật, còi. FIRE ALARM (cảm biến lửa, chốt): cắt điện, quạt TẮT, còi.\n` +
        `Dữ liệu hiện tại: ${describeState(c)}\nCâu hỏi của người dùng: ${question}`;
      const result = await Promise.race([model.generateContent(prompt), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 9000))]);
      const text = result.response.text();
      if (text) return text.trim();
    } catch (e) { log('[gemini] lỗi, dùng bộ phân tích nội bộ:', e.message); }
  }
  return localAdvisor(question, c);
}

// =====================================================================
// 7. EXPRESS API
// =====================================================================
const app = express();
app.use(cors());
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => res.json({ ok: true, device_online: deviceOnline(), sim_mode: simMode, uptime_s: Math.round(process.uptime()) }));

app.post('/api/telemetry', async (req, res) => {
  try {
    const body = req.body || {};
    if (typeof body !== 'object' || (body.temp === undefined && body.gas_raw === undefined && body.gas_ma10 === undefined)) {
      return res.status(400).json({ ok: false, error: 'Thiếu dữ liệu telemetry (temp / gas_raw / gas_ma10)' });
    }
    const source = ['esp32', 'simulator'].includes(body.source) ? body.source : 'esp32';
    await ingest(body, source);
    cmdQueue = cmdQueue.filter((c) => Date.now() - c.ts < CMD_TTL_MS);
    const next = cmdQueue.shift();
    res.json({ ok: true, command: next ? next.command : 'NONE', sim_mode: simMode });
  } catch (e) {
    log('[telemetry]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/state', async (req, res) => {
  try {
    const history = (await dbAll('SELECT * FROM telemetry ORDER BY id DESC LIMIT 40')).reverse();
    const incidents = await dbAll('SELECT * FROM incidents ORDER BY id DESC LIMIT 20');
    const audits = await dbAll('SELECT * FROM command_audit ORDER BY id DESC LIMIT 20');
    const cur = current ? Object.assign({}, current, { sim_mode: simMode, device_online: deviceOnline() && current.source !== 'internal' }) : null;
    res.json({ current: cur, history, incidents, audits });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/command', async (req, res) => {
  const { command, source } = req.body || {};
  if (!ALL_CMDS.includes(command)) return res.status(400).json({ ok: false, error: `Lệnh không hợp lệ. Hỗ trợ: ${ALL_CMDS.join(', ')}` });
  try {
    const r = await executeCommand(command, source || 'web_dashboard', '');
    res.json({ ok: r.ok, command, result: r.result, current });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/simulate-custom', async (req, res) => {
  try {
    const { temp, hum, gas, flame } = req.body || {};
    const tVal = r1(num(temp, 29));
    const hVal = r1(num(hum, 55));
    const gVal = Math.round(num(gas, 700));
    const fVal = flag(flame);

    simMode = 'custom';
    sim.base = { gas: gVal, temp: tVal, hum: hVal };
    sim.win.fill(gVal);
    SCEN.custom = { gas: gVal, temp: tVal, hum: hVal, flame: fVal, sigma: 10 };

    const telemetry = simBuildTelemetry();
    await ingest(telemetry, 'internal');

    res.json({ ok: true, current, sim_mode: simMode });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/ai-ask', async (req, res) => {
  const question = String((req.body && req.body.question) || '').trim();
  if (!question) return res.status(400).json({ ok: false, error: 'Thiếu câu hỏi', answer: 'Bạn hãy nhập câu hỏi nhé.' });
  try { res.json({ ok: true, answer: await askAI(question) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message, answer: 'Xin lỗi, trợ lý AI đang gặp lỗi.' }); }
});

// =====================================================================
// 8. TELEGRAM BOT
// =====================================================================
const TG_HELP = '🏠 SMART KITCHEN GUARD\n/status (hoặc /tinhtrang) - xem tình trạng\n/off (hoặc /cat) - cắt điện bếp\n/restore (hoặc /khoiphuc) - khôi phục điện\n/mute - tắt còi\n/fan_on - bật quạt hút\n/fan_off - tắt quạt hút\nHoặc cứ nhắn tự nhiên, ví dụ: "bếp có an toàn không?"';
const TG_MAP = { off: 'CUT_POWER', cat: 'CUT_POWER', restore: 'RESTORE', khoiphuc: 'RESTORE', mute: 'MUTE', fan_on: 'FAN_ON', fan_off: 'FAN_OFF' };

function statusText() {
  const c = current;
  if (!c) return 'Chưa có dữ liệu.';
  const src = c.source === 'internal' ? 'giả lập (chưa có ESP32)' : c.source === 'simulator' ? 'simulator.js' : (deviceOnline() ? 'ESP32 (online)' : 'ESP32 (mất kết nối)');
  return `${c.level >= 2 ? '🚨' : c.level === 1 ? '⚠️' : '✅'} ${c.status}\n🌡 ${c.temp}°C (${c.temp_ror >= 0 ? '+' : ''}${c.temp_ror}/phút) | 💧 ${c.hum}%\n🧪 Gas MA10 ${c.gas_ma10} (~${c.gas_ppm} ppm) | Lửa: ${c.flame ? 'CÓ' : 'không'}\n🔌 Điện bếp: ${c.relay_on ? 'cấp' : 'ĐÃ CẮT'} | 🌀 Quạt: ${c.fan_on ? 'bật' : 'tắt'} | 🔒 Chốt: ${c.latched ? 'khóa' : 'mở'}\n📡 Nguồn dữ liệu: ${src}`;
}

function startTelegram() {
  if (TG_DISABLED || !BOT_TOKEN) { log('[telegram] Tắt hoặc chưa cấu hình BOT_TOKEN -> bỏ qua Telegram'); return; }
  let TelegramBot;
  try { TelegramBot = require('node-telegram-bot-api'); } catch (e) { log('[telegram] thiếu thư viện:', e.message); return; }
  try { tgBot = new TelegramBot(BOT_TOKEN, { polling: !TG_POLLING_DISABLED }); }
  catch (e) { log('[telegram] không khởi tạo được:', e.message); tgBot = null; return; }

  let lastPollErr = 0;
  tgBot.on('polling_error', (e) => {
    if (Date.now() - lastPollErr > 60000) { lastPollErr = Date.now(); log('[telegram polling]', e && e.message ? e.message : e); }
  });
  tgBot.on('error', (e) => log('[telegram error]', e && e.message ? e.message : e));

  tgBot.on('message', async (msg) => {
    try {
      const chatId = String(msg.chat.id);
      const text = String(msg.text || '').trim();
      if (!text) return;
      if (chatId !== ALLOWED_CHAT_ID) {
        await logAudit('telegram', chatId, 'DENIED_UNAUTHORIZED', `Thử gửi: ${text.slice(0, 80)}`);
        log(`[telegram] từ chối chat ${chatId}`);
        return tgBot.sendMessage(chatId, '⛔ Bạn không có quyền điều khiển hệ thống này.').catch(() => {});
      }
      const m = text.match(/^\/(\w+)(?:@\w+)?/);
      const reply = (t, o) => tgBot.sendMessage(chatId, t, o).catch((e) => log('[telegram send]', e.message));
      if (m) {
        const cmd = m[1].toLowerCase();
        if (cmd === 'start' || cmd === 'help') {
          await logAudit('telegram', chatId, '/' + cmd, 'OK');
          return reply(TG_HELP, { reply_markup: { keyboard: [['/status', '/mute'], ['/off', '/restore'], ['/fan_on', '/fan_off']], resize_keyboard: true } });
        }
        if (cmd === 'status' || cmd === 'tinhtrang') { await logAudit('telegram', chatId, '/' + cmd, 'OK'); return reply(statusText()); }
        if (TG_MAP[cmd]) {
          const r = await executeCommand(TG_MAP[cmd], 'telegram', chatId);
          return reply(`${r.ok ? '✅' : '❌'} ${TG_MAP[cmd]}: ${r.result}`);
        }
        return reply('Lệnh không hợp lệ.\n\n' + TG_HELP);
      }
      await logAudit('telegram', chatId, 'AI_ASK', text.slice(0, 120));
      return reply(await askAI(text));
    } catch (e) { log('[telegram handler]', e.message); }
  });
  log(`[telegram] bot sẵn sàng (polling: ${!TG_POLLING_DISABLED}, chat được phép: ${ALLOWED_CHAT_ID})`);
  
  // Thiết lập danh sách lệnh mặc định để hiển thị popup khi người dùng gõ /
  const botCommands = [
    { command: 'tinhtrang', description: '📊 Xem trạng thái bếp, nhiệt độ & khí gas' },
    { command: 'status', description: '📊 Kiểm tra thông số hệ thống' },
    { command: 'cat', description: '⚡ Cắt nguồn điện bếp ngay lập tức (Relay 1)' },
    { command: 'off', description: '⚡ Ngắt điện khẩn cấp' },
    { command: 'khoiphuc', description: '🔄 Mở lại nguồn điện bếp (Reset Latch)' },
    { command: 'restore', description: '🔄 Khôi phục hệ thống khi đã an toàn' },
    { command: 'mute', description: '🔇 Tắt tiếng còi báo động Buzzer' },
    { command: 'fan_on', description: '🌀 Bật quạt thông gió (Relay 2)' },
    { command: 'fan_off', description: '⏹️ Tắt quạt thông gió' },
    { command: 'help', description: '❓ Hướng dẫn sử dụng & danh sách lệnh' },
  ];
  tgBot.setMyCommands(botCommands).then(() => {
    log('[telegram] Đã thiết lập danh sách lệnh mặc định vào menu bot (setMyCommands OK)');
  }).catch((e) => log('[telegram setMyCommands]', e.message));
}

// =====================================================================
// 9. KHOI DONG
// =====================================================================
async function main() {
  await initDb();
  const open = await dbAll('SELECT * FROM incidents WHERE resolved_at IS NULL ORDER BY id DESC');
  if (open.length) { // dong cac su co treo tu lan chay truoc
    await dbRun('UPDATE incidents SET resolved_at=? WHERE resolved_at IS NULL', [new Date().toISOString()]);
  }
  startTelegram();
  await ingest(simBuildTelemetry(), 'internal');
  setInterval(() => internalTick().catch((e) => log('[sim tick]', e.message)), SIM_TICK_MS);

  app.listen(PORT, '0.0.0.0', () => {
    log(`✅ Smart Kitchen Guard server chạy tại http://localhost:${PORT}`);
    const ips = [];
    Object.values(os.networkInterfaces()).forEach((l) => (l || []).forEach((i) => { if (i.family === 'IPv4' && !i.internal) ips.push(i.address); }));
    ips.forEach((ip) => log(`   ESP32 serverUrl:  "http://${ip}:${PORT}/api/telemetry"`));
    log(`   Gemini AI: ${GEMINI_API_KEY ? 'BẬT' : 'không có GEMINI_API_KEY → dùng bộ phân tích nội bộ'}`);
  });
}
main().catch((e) => { console.error('Khởi động thất bại:', e); process.exit(1); });

