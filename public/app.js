/**
 * Bếp An Toàn · Smart Kitchen Guard — dashboard client
 * GET  /api/state            poll every 1.5s
 * POST /api/command          real actions (CUT_POWER, RESTORE, MUTE, FAN_ON, FAN_OFF) and SIM_* presets
 * POST /api/simulate-custom  manual sliders { temp, hum, gas, flame }
 * POST /api/ai-ask           safety assistant
 * No colour literals here: chart colours are read from the CSS tokens in style.css.
 */
'use strict';

const POLL_INTERVAL_MS = 1500;
const SLIDER_SEND_DEBOUNCE_MS = 120;
const SLIDER_HOLD_MS = 3000; // after the last manual slider touch, do not overwrite slider positions from /api/state
const RESULT_FLASH_MS = 1800;

const T = {
  gasSafe: 1400, gasWarn: 1600, gasDanger: 2600,
  tempSafe: 43, tempWarn: 46, tempDanger: 55,
  rorWarn: 4, humCooking: 72,
  gasScaleMax: 4000, tempScaleMin: 20, tempScaleMax: 80,
};

const COMMAND_LABEL = {
  CUT_POWER: 'Ngắt điện bếp',
  RESTORE: 'Khôi phục điện bếp',
  MUTE: 'Tắt tiếng còi',
  FAN_ON: 'Bật quạt thông gió',
  FAN_OFF: 'Tắt quạt thông gió',
  SIM_NORMAL: 'Kịch bản Bình thường',
  SIM_COOKING: 'Kịch bản Đang nấu ăn',
  SIM_WARNING: 'Kịch bản Rò gas nhẹ',
  SIM_GAS: 'Kịch bản Rò gas nặng',
  SIM_FIRE: 'Kịch bản Cháy lửa',
};

const SIM_MODE_LABEL = {
  normal: 'Bình thường (An toàn)',
  cooking: 'Đang nấu ăn (Hơi nước)',
  warning: 'Rò gas nhẹ (Cảnh báo)',
  gas_danger: 'Rò gas nặng (Nguy hiểm)',
  fire: 'Cháy lửa (Báo động cháy)',
  custom: 'Tùy chỉnh bằng thanh trượt',
};

let gasChart = null;
let envChart = null;
let lastSuccessTime = 0;
let fetching = false;
let commandInFlight = false;
let lastRelayOn = true;
let lastFanOn = false;
let lastMuted = false;
let lastHazard = false;

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const setText = (id, text) => { const el = $(id); if (el && el.textContent !== text) el.textContent = text; };
const isTrue = (v) => v === true || Number(v) === 1;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const gasToPpm = (ma) => Math.round(Math.max(0, Number(ma || 0) - 500) * 1.6);

function formatTimeShort(ts) {
  if (!ts) return '--:--:--';
  const d = new Date(ts);
  if (isNaN(d.getTime())) {
    const parts = String(ts).split(' ');
    return parts[parts.length - 1] || String(ts);
  }
  return d.toLocaleTimeString('vi-VN', { hour12: false });
}

function formatNumber(val, decimals = 1) {
  const num = Number(val);
  if (val === null || val === undefined || isNaN(num)) return '--';
  return num.toFixed(decimals);
}

function signed(val, decimals = 1) {
  const n = Number(val) || 0;
  return (n >= 0 ? '+' : '') + n.toFixed(decimals);
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function tagHtml(tone, text) {
  return `<span class="tag" data-tone="${tone}">${escapeHtml(text)}</span>`;
}

function setLed(el, tone) { if (el) el.dataset.tone = tone; }

// ---------- state classification (mirrors server evaluateSafety) ----------
function classify(cur) {
  const s = String(cur.status || 'SAFE').toUpperCase();
  const level = Number(cur.level || 0);
  if (s.includes('FIRE') || isTrue(cur.flame)) return 'fire';
  if (s.includes('DANGER') || level >= 2) return 'gas';
  if (s.includes('WARNING') || level === 1) return 'warning';
  if (s.includes('COOKING')) return 'cooking';
  return 'safe';
}

const STATE_COPY = {
  safe: {
    label: 'AN TOÀN', tone: 'ok',
    headline: 'Bếp đang an toàn.',
    guide: () => 'Gas, nhiệt độ và lửa đều trong mức bình thường. Điện bếp đang cấp và quạt ở chế độ chờ.',
    steps: () => [],
  },
  cooking: {
    label: 'ĐANG NẤU ĂN', tone: 'cool',
    headline: 'Bạn đang nấu ăn.',
    guide: () => 'Độ ẩm cao kèm khói nhẹ là hơi nước nấu ăn, không phải sự cố. Quạt tự bật và còi được giữ im lặng để tránh báo giả.',
    steps: () => ['Mở cửa sổ nếu bếp ngột ngạt.', 'Đừng rời bếp khi đang đun dầu mỡ.'],
  },
  warning: {
    label: 'CẢNH BÁO SỚM', tone: 'warn',
    headline: 'Có dấu hiệu bất thường.',
    guide: (m) => `Gas MA10 ${m.gas} ADC, nhiệt độ ${formatNumber(m.temp, 1)}°C đã chạm ngưỡng cảnh báo. Quạt đã bật và còi đang báo.`,
    steps: () => ['Kiểm tra van bình gas và các mối nối ống dẫn.', 'Tắt bếp nếu nhiệt độ vẫn tăng.', 'Mở cửa cho thoáng.'],
  },
  gas: {
    label: 'NGUY HIỂM KHÍ GAS', tone: 'danger',
    headline: 'Khí gas ở mức nguy hiểm.',
    guide: (m) => `Gas MA10 ${m.gas} ADC (khoảng ${formatNumber(m.ppm, 0)} PPM). Hệ thống đã ngắt điện bếp và bật quạt hút để làm loãng khí gas.`,
    steps: () => [
      'Không bật lửa, không bấm công tắc điện, không dùng điện thoại trong bếp.',
      'Khóa van bình gas nếu tiếp cận được an toàn.',
      'Mở cửa, rời khỏi bếp và gọi cứu hộ nếu mùi gas không giảm.',
    ],
  },
  heat: {
    label: 'NGUY HIỂM QUÁ NHIỆT', tone: 'danger',
    headline: 'Nhiệt độ bếp quá cao.',
    guide: (m) => `Nhiệt độ ${formatNumber(m.temp, 1)}°C vượt ngưỡng nguy hiểm ${T.tempDanger}°C. Hệ thống đã ngắt điện bếp và bật quạt.`,
    steps: () => ['Tắt mọi nguồn nhiệt trên bếp.', `Chờ nhiệt độ xuống dưới ${T.tempSafe}°C rồi mới khôi phục điện.`],
  },
  latched_safe: {
    label: 'ĐÃ NGẮT ĐIỆN · CHỜ KHÔI PHỤC', tone: 'warn',
    headline: 'Cảm biến đã an toàn · Chốt ngắt điện đang giữ.',
    guide: (m) => `Gas MA10 (${m.gas} ADC) và nhiệt độ (${formatNumber(m.temp, 1)}°C) đang ở mức an toàn, nhưng rơ-le điện bếp vẫn đang ngắt bởi chốt an toàn (Latch). Bạn có thể bấm "Khôi phục điện bếp" ngay bên dưới để cấp điện trở lại.`,
    steps: () => [
      'Kiểm tra khu vực bếp đã thông thoáng và công tắc bếp ở vị trí an toàn.',
      'Bấm nút "Khôi phục điện bếp" màu xanh bên dưới để mở khóa chốt Latch.',
    ],
  },
  fire: {
    label: 'BÁO ĐỘNG CHÁY', tone: 'danger',
    headline: 'Có lửa tại bếp.',
    guide: () => 'Cảm biến đã thấy lửa. Điện bếp đã ngắt và quạt bị khóa tắt để không thổi thêm oxy vào đám cháy.',
    steps: () => [
      'Dập lửa bằng vung nồi hoặc chăn chống cháy. Không tạt nước vào chảo dầu.',
      'Rời khỏi bếp nếu lửa lan rộng và gọi 114.',
      'Chỉ khôi phục điện sau khi lửa đã tắt hẳn.',
    ],
  },
};

// ---------- charts ----------
function initCharts() {
  const gasCanvas = $('gasChart');
  const envCanvas = $('envChart');
  if (typeof Chart === 'undefined') {
    [gasCanvas, envCanvas].forEach((c) => {
      if (!c) return;
      const note = document.createElement('p');
      note.className = 'chart-box__fallback';
      note.textContent = 'Không tải được thư viện biểu đồ (Chart.js). Kiểm tra kết nối mạng rồi tải lại trang.';
      c.replaceWith(note);
    });
    return;
  }

  Chart.defaults.font.family = cssVar('--font-mono');
  Chart.defaults.font.size = 12;
  Chart.defaults.color = cssVar('--color-muted');

  const ink = cssVar('--color-ink');
  const muted = cssVar('--color-muted');
  const warn = cssVar('--color-warn');
  const danger = cssVar('--color-danger');
  const cool = cssVar('--color-cool');
  const grid = cssVar('--color-grid');
  const coolFill = cssVar('--color-cool-fill');

  const tooltip = {
    backgroundColor: ink,
    titleColor: cssVar('--color-paper-hi'),
    bodyColor: cssVar('--color-paper'),
    cornerRadius: 6,
    padding: 10,
    displayColors: true,
  };
  const base = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: false }, tooltip },
  };

  gasChart = new Chart(gasCanvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'Gas Raw (ADC nhiễu)', data: [], borderColor: muted, borderWidth: 1.5, borderDash: [2, 3], pointRadius: 1.5, pointBackgroundColor: muted, tension: 0.1 },
        { label: 'Gas MA10 (đã lọc)', data: [], borderColor: ink, backgroundColor: coolFill, borderWidth: 2.5, pointRadius: 0, fill: true, tension: 0.3 },
        { label: 'Ngưỡng cảnh báo 1600', data: [], borderColor: warn, borderWidth: 1.5, borderDash: [6, 4], pointRadius: 0 },
        { label: 'Ngưỡng nguy hiểm 2600', data: [], borderColor: danger, borderWidth: 1.5, borderDash: [6, 4], pointRadius: 0 },
      ],
    },
    options: Object.assign({}, base, {
      scales: {
        x: { ticks: { maxTicksLimit: 6, maxRotation: 0 }, grid: { color: grid } },
        y: { min: 0, suggestedMax: 3400, grid: { color: grid }, title: { display: true, text: 'ADC 12-bit (0–4095)' } },
      },
    }),
  });

  envChart = new Chart(envCanvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'Nhiệt độ (°C)', data: [], borderColor: ink, borderWidth: 2.5, pointRadius: 0, tension: 0.3, yAxisID: 'yTemp' },
        { label: 'Độ ẩm (% RH)', data: [], borderColor: cool, borderWidth: 2.5, pointRadius: 0, tension: 0.3, yAxisID: 'yHum' },
      ],
    },
    options: Object.assign({}, base, {
      scales: {
        x: { ticks: { maxTicksLimit: 6, maxRotation: 0 }, grid: { color: grid } },
        yTemp: { type: 'linear', position: 'left', suggestedMin: 20, suggestedMax: 65, grid: { color: grid }, title: { display: true, text: '°C' } },
        yHum: { type: 'linear', position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false }, title: { display: true, text: '% RH' } },
      },
    }),
  });
}

function updateCharts(history) {
  if (!Array.isArray(history) || !gasChart || !envChart) return;
  const labels = history.map((r) => formatTimeShort(r.timestamp));
  gasChart.data.labels = labels;
  gasChart.data.datasets[0].data = history.map((r) => Number(r.gas_raw ?? 0));
  gasChart.data.datasets[1].data = history.map((r) => Number(r.gas_ma10 ?? 0));
  gasChart.data.datasets[2].data = history.map(() => T.gasWarn);
  gasChart.data.datasets[3].data = history.map(() => T.gasDanger);
  gasChart.update('none');

  envChart.data.labels = labels;
  envChart.data.datasets[0].data = history.map((r) => Number(r.temp ?? 0));
  envChart.data.datasets[1].data = history.map((r) => Number(r.hum ?? 0));
  envChart.update('none');
}

// ---------- header ----------
function updateHeader(cur) {
  setLed($('connDot'), 'ok');
  setText('connText', 'trực tuyến');
  setText('lastUpdatedTime', formatTimeShort(cur && cur.timestamp ? cur.timestamp : new Date().toISOString()));

  const badge = $('sourceBadge');
  if (!cur) {
    setLed($('espDot'), 'off');
    setText('espText', 'chưa có tín hiệu');
    badge.dataset.source = 'unknown';
    setText('sourceText', '—');
    return;
  }
  const online = isTrue(cur.device_online);
  if (online) {
    setLed($('espDot'), 'ok');
    setText('espText', 'đang gửi dữ liệu');
    badge.dataset.source = 'real';
    setText('sourceText', 'Thật');
  } else if (cur.source === 'esp32') {
    setLed($('espDot'), 'danger');
    setText('espText', 'mất kết nối');
    badge.dataset.source = 'stale';
    setText('sourceText', 'Thật · mất tín hiệu');
  } else {
    setLed($('espDot'), 'off');
    setText('espText', 'chưa kết nối');
    badge.dataset.source = 'sim';
    setText('sourceText', cur.source === 'simulator' ? 'Giả lập · simulator.js' : 'Giả lập · máy chủ');
  }
}

// ---------- status panel + controls ----------
function updateStatusPanel(m) {
  const hazard = m.flame || m.gas >= T.gasSafe || m.temp >= T.tempSafe;
  let key = m.state;
  if (!m.relayOn && !hazard) key = 'latched_safe';
  else if (key === 'gas' && m.gas < T.gasDanger && m.temp >= T.tempDanger) key = 'heat';
  const copy = STATE_COPY[key] || STATE_COPY.safe;
  const panel = $('statusPanel');
  panel.dataset.state = key === 'latched_safe' ? 'warning' : m.state;
  setLed($('stateLed'), copy.tone);
  setText('stateLabel', copy.label);
  setText('stateHeadline', copy.headline);
  setText('stateGuide', copy.guide(m));

  const steps = copy.steps(m);
  const list = $('stateSteps');
  const sig = steps.join('|');
  if (list.dataset.sig !== sig) {
    list.dataset.sig = sig;
    list.innerHTML = steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('');
  }
  list.hidden = steps.length === 0;

  document.title = (m.state === 'safe' || m.state === 'cooking' ? '' : `[${copy.label}] `) + 'Bếp An Toàn · Smart Kitchen Guard';
}

function applyControlButtons(m) {
  const hazard = m.flame || m.gas >= T.gasSafe || m.temp >= T.tempSafe;
  lastRelayOn = m.relayOn;
  lastFanOn = m.fanOn;
  lastMuted = m.muted;
  lastHazard = hazard;

  // Update live actuator badges in .controls__summary
  const pwrBadge = $('ctrlStatePower');
  if (pwrBadge) {
    pwrBadge.dataset.tone = m.relayOn ? 'ok' : 'danger';
    pwrBadge.textContent = m.relayOn ? 'Đang cấp' : 'Đã ngắt';
  }
  const buzBadge = $('ctrlStateBuzzer');
  if (buzBadge) {
    if (m.muted) { buzBadge.dataset.tone = 'warn'; buzBadge.textContent = 'Đã tắt tiếng'; }
    else if (m.level >= 1) { buzBadge.dataset.tone = 'danger'; buzBadge.textContent = 'Đang kêu'; }
    else { buzBadge.dataset.tone = 'off'; buzBadge.textContent = 'Im lặng'; }
  }
  const fanBadge = $('ctrlStateFan');
  if (fanBadge) {
    fanBadge.dataset.tone = m.fanOn ? 'cool' : 'off';
    fanBadge.textContent = m.fanOn ? 'Đang chạy' : 'Đang tắt';
  }

  const relay = $('btnRelay');
  relay.dataset.command = m.relayOn ? 'CUT_POWER' : 'RESTORE';
  relay.className = 'btn ' + (m.relayOn ? 'btn--danger' : 'btn--safe');
  relay.textContent = m.relayOn ? 'Ngắt điện bếp khẩn cấp' : 'Khôi phục điện bếp';
  relay.classList.toggle('is-locked', !m.relayOn && hazard);

  const fanLocked = m.flame || m.status.toUpperCase().startsWith('FIRE');
  const fan = $('btnFan');
  fan.dataset.command = m.fanOn ? 'FAN_OFF' : 'FAN_ON';
  fan.textContent = m.fanOn ? 'Tắt quạt thông gió' : 'Bật quạt thông gió';
  fan.classList.toggle('is-locked', !m.fanOn && fanLocked);

  const mute = $('btnMute');
  mute.textContent = m.muted ? 'Tắt tiếng còi (Đã tắt)' : 'Tắt tiếng còi báo';

  const hint = $('interlockHint');
  const lines = [];
  if (fanLocked) lines.push('Đang có lửa (hoặc chốt báo cháy đang giữ): quạt bị khóa vì sẽ thổi thêm oxy vào đám cháy.');
  if (!m.relayOn && hazard) {
    lines.push(`Chỉ khôi phục điện khi gas MA10 dưới ${T.gasSafe}, nhiệt độ dưới ${T.tempSafe}°C và hết lửa (hiện ${m.gas} ADC, ${formatNumber(m.temp, 1)}°C).`);
  } else if (!m.relayOn && !hazard) {
    lines.push('Cảm biến đã về ngưỡng an toàn — bạn có thể bấm "Khôi phục điện bếp" ngay.');
  }
  hint.dataset.lock = (!m.relayOn && hazard) || fanLocked ? 'true' : 'false';
  hint.textContent = lines.length ? 'Khóa an toàn: ' + lines.join(' ') : 'Khóa an toàn: hệ thống từ chối lệnh nguy hiểm và nói rõ lý do ngay bên dưới.';

  // Show inline quick-recovery button whenever power is cut during a hazard or when a command was refused
  const actionsBox = $('cmdFeedbackActions');
  const feedbackBox = $('cmdFeedback');
  if (actionsBox) {
    const showQuickRecover = (!m.relayOn && hazard) || (feedbackBox && feedbackBox.dataset.state === 'refused');
    actionsBox.hidden = !showQuickRecover;
    if (!m.relayOn && hazard && feedbackBox && feedbackBox.dataset.state === 'idle') {
      setFeedback('refused', 'Điện bếp đang ngắt để bảo vệ an toàn', 'Nếu bạn đang thử nghiệm, hãy bấm nút bên dưới để đưa cảm biến về mức An toàn và khôi phục điện ngay.');
    }
  }

  refreshControlDisabled();
}

function refreshControlDisabled() {
  $('btnRelay').disabled = commandInFlight;
  $('btnFan').disabled = commandInFlight;
  $('btnMute').disabled = commandInFlight;
  const quickBtn = $('btnQuickSafeRestore');
  if (quickBtn) quickBtn.disabled = commandInFlight;
  const resetBtn = $('btnResetSim');
  if (resetBtn) resetBtn.disabled = commandInFlight;
  document.querySelectorAll('.seg').forEach((b) => { b.disabled = commandInFlight; });
}

// ---------- readouts ----------
function setMeter(id, fraction) {
  const el = $(id);
  if (el) el.style.setProperty('--fill', clamp(fraction, 0, 1).toFixed(3));
}

function updateReadouts(m) {
  // Temperature
  setText('valTemp', formatNumber(m.temp, 1));
  setText('valTempRor', `${signed(m.tempRor, 1)} °C/phút`);
  setMeter('barTemp', (m.temp - T.tempScaleMin) / (T.tempScaleMax - T.tempScaleMin));
  let tLevel = 'ok', tTone = 'ok', tText = 'Bình thường';
  if (m.temp >= T.tempDanger) { tLevel = 'danger'; tTone = 'danger'; tText = 'Quá nhiệt'; }
  else if (m.temp >= T.tempWarn || m.tempRor >= T.rorWarn) { tLevel = 'warn'; tTone = 'warn'; tText = 'Nhiệt tăng cao'; }
  $('rowTemp').dataset.level = tLevel;
  $('tempTag').dataset.tone = tTone;
  setText('tempTag', tText);

  // Humidity
  setText('valHum', formatNumber(m.hum, 0));
  setMeter('barHum', m.hum / 100);
  const cooking = m.state === 'cooking' || (m.hum > T.humCooking && m.gas >= T.gasSafe && m.gas < 2000);
  let hLevel = 'ok', hTone = 'ok', hTag = 'Ổn định', hNote = 'Chưa nhận diện hơi nước nấu ăn';
  if (cooking) { hLevel = 'cool'; hTone = 'cool'; hTag = 'Hơi nước nấu ăn'; hNote = 'Nhận diện đang nấu ăn: quạt bật, còi im lặng'; }
  else if (m.hum > T.humCooking) { hLevel = 'cool'; hTone = 'cool'; hTag = 'Độ ẩm cao'; hNote = 'Trên 72% RH, chưa có khói hay gas kèm theo'; }
  $('rowHum').dataset.level = hLevel;
  $('humTag').dataset.tone = hTone;
  setText('humTag', hTag);
  setText('valCookingState', hNote);

  // Gas
  setText('valGasMa10', String(m.gas));
  setText('valGasPpm', `${formatNumber(m.ppm, 0)} PPM`);
  setText('valGasRaw', String(m.gasRaw));
  setText('valGasRor', `${signed(m.gasRor, 0)}/phút`);
  setMeter('barGas', m.gas / T.gasScaleMax);
  let gLevel = 'ok', gTone = 'ok', gText = 'An toàn';
  if (m.gas >= T.gasDanger) { gLevel = 'danger'; gTone = 'danger'; gText = 'Rò gas nguy hiểm'; }
  else if (m.gas >= T.gasWarn) { gLevel = 'warn'; gTone = 'warn'; gText = 'Cảnh báo rò gas'; }
  else if (m.gas >= T.gasSafe) { gLevel = 'ok'; gTone = 'off'; gText = 'Theo dõi'; }
  $('rowGas').dataset.level = gLevel;
  $('gasTag').dataset.tone = gTone;
  setText('gasTag', gText);
}

// ---------- hardware strip ----------
function setDevice(id, ledId, tone, stateText, spin) {
  const li = $(id);
  li.dataset.tone = tone;
  if (spin !== undefined) li.dataset.spin = spin ? 'true' : 'false';
  setLed($(ledId), tone);
  setText(id + 'State', stateText);
}

function updateDevices(m) {
  setDevice('devFlame', 'ledFlame', m.flame ? 'danger' : 'ok', m.flame ? 'Phát hiện lửa' : 'Không có lửa');
  setDevice('devRelay', 'ledRelay', m.relayOn ? 'ok' : 'danger', m.relayOn ? 'Đang cấp điện' : 'Đã ngắt điện');
  setDevice('devFan', 'ledFan', m.fanOn ? 'cool' : 'off', m.fanOn ? 'Đang chạy, hút gió' : 'Đang tắt', m.fanOn);
  const latch = m.latched ? 'Latch đã khóa' : 'Latch mở';
  let tone = 'off', text = `Im lặng · ${latch}`;
  if (m.muted) { tone = 'warn'; text = `Đã tắt tiếng · ${latch}`; }
  else if (m.level >= 1) { tone = 'danger'; text = `Còi đang kêu · ${latch}`; }
  setDevice('devBuzzer', 'ledBuzzer', tone, text);
}

// ---------- simulation bench ----------
const simUi = { dragging: false, lastTouch: 0, pending: false, timer: null };
const SLIDER_IDS = ['sliderTemp', 'sliderHum', 'sliderGas', 'sliderFlame'];

function paintRange(el) {
  const min = Number(el.min), max = Number(el.max);
  el.style.setProperty('--pct', `${clamp(((Number(el.value) - min) / (max - min)) * 100, 0, 100).toFixed(1)}%`);
}

function paintSliderLabels() {
  const temp = parseFloat($('sliderTemp').value);
  const hum = parseFloat($('sliderHum').value);
  const gas = parseInt($('sliderGas').value, 10);
  const flame = $('sliderFlame').checked;
  const ppm = gasToPpm(gas);
  setText('sliderTempVal', `${temp.toFixed(1)} °C`);
  setText('sliderHumVal', `${hum} %`);
  setText('sliderGasVal', `${gas} ADC · ≈${ppm} PPM`);
  setText('sliderFlameVal', flame ? 'Có lửa' : 'Không có lửa');
  paintRange($('sliderTemp')); paintRange($('sliderHum')); paintRange($('sliderGas'));
}

function syncSlidersFromState(m, force = false) {
  if (!force) {
    if (simUi.dragging || simUi.pending) return;
    if (Date.now() - simUi.lastTouch < SLIDER_HOLD_MS) return;
    const active = document.activeElement;
    if (active && SLIDER_IDS.includes(active.id)) return;
  }

  const t = clamp(Math.round(m.temp * 2) / 2, 20, 80);
  const h = clamp(Math.round(m.hum), 20, 98);
  const g = clamp(Math.round(m.gas / 25) * 25, 300, 3800);
  const set = (id, v) => { const el = $(id); if (Number(el.value) !== v) el.value = String(v); };
  set('sliderTemp', t); set('sliderHum', h); set('sliderGas', g);
  $('sliderFlame').checked = m.flame;
  paintSliderLabels();
}

function updateBench(cur, m) {
  const mode = String(cur.sim_mode || '').toLowerCase();
  setText('simModeText', SIM_MODE_LABEL[mode] || (mode ? mode : '—'));
  document.querySelectorAll('.seg').forEach((b) => b.setAttribute('aria-pressed', b.dataset.mode === mode ? 'true' : 'false'));
  $('benchLiveWarn').hidden = !isTrue(cur.device_online);
  syncSlidersFromState(m);
}

function setSimFeedback(state, text) {
  const el = $('simFeedback');
  el.dataset.state = state;
  el.textContent = text;
}

function onSimInput() {
  simUi.lastTouch = Date.now();
  paintSliderLabels();
  simUi.pending = true;
  clearTimeout(simUi.timer);
  simUi.timer = setTimeout(sendCustomSim, SLIDER_SEND_DEBOUNCE_MS);
}

async function sendCustomSim() {
  const temp = clamp(parseFloat($('sliderTemp').value) || 30, 0, 100);
  const hum = clamp(parseFloat($('sliderHum').value) || 55, 0, 100);
  const gas = clamp(parseInt($('sliderGas').value, 10) || 700, 0, 4095);
  const flame = $('sliderFlame').checked;
  try {
    const res = await fetch('/api/simulate-custom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ temp, hum, gas, flame }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      setSimFeedback('ok', `Đã áp dụng giả lập: ${temp.toFixed(1)}°C, ${hum}% RH, gas ${gas} ADC (≈${gasToPpm(gas)} PPM), ${flame ? 'có lửa' : 'không có lửa'}.`);
    } else {
      setSimFeedback('error', `Không áp dụng được giả lập: ${data.error || 'lỗi máy chủ'}.`);
    }
  } catch (e) {
    setSimFeedback('error', 'Mất kết nối khi gửi thông số giả lập.');
  } finally {
    simUi.lastTouch = Date.now();
    simUi.pending = false;
    fetchState();
  }
}

// ---------- tables ----------
function renderIncidents(incidents) {
  const tbody = $('incidentsTableBody');
  setText('incidentCountBadge', String(incidents.length));
  if (!incidents.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-row">Chưa có sự cố nào được ghi nhận.</td></tr>';
    return;
  }
  tbody.innerHTML = incidents.map((inc) => {
    const lvl = Number(inc.level || 1);
    const lvlTag = lvl >= 2 ? tagHtml('danger', 'Mức 2 · Nguy hiểm') : tagHtml('warn', 'Mức 1 · Cảnh báo');
    const resolved = inc.resolved_at
      ? tagHtml('ok', `Đã xử lý ${formatTimeShort(inc.resolved_at)}`)
      : tagHtml('danger', 'Đang diễn ra');
    return `<tr>
      <td class="mono">#${escapeHtml(inc.id)}</td>
      <td class="mono">${escapeHtml(formatTimeShort(inc.timestamp))}</td>
      <td>${lvlTag}</td>
      <td><strong>${escapeHtml(inc.status)}</strong></td>
      <td class="reason">${escapeHtml(inc.reason || '—')}</td>
      <td class="mono">${escapeHtml(inc.gas_ma10 ?? '—')}</td>
      <td class="mono">${formatNumber(inc.temp, 1)}°C</td>
      <td>${resolved}</td>
    </tr>`;
  }).join('');
}

function renderAudits(audits) {
  const tbody = $('auditsTableBody');
  setText('auditCountBadge', String(audits.length));
  if (!audits.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-row">Chưa có lệnh điều khiển nào được thực thi.</td></tr>';
    return;
  }
  tbody.innerHTML = audits.map((a) => {
    const raw = String(a.result || '');
    const match = raw.match(/^(OK|REFUSED):\s*([\s\S]*)$/);
    let resultHtml;
    if (match) {
      resultHtml = `${match[1] === 'OK' ? tagHtml('ok', 'Đã thực hiện') : tagHtml('warn', 'Bị từ chối')} ${escapeHtml(match[2])}`;
    } else if (/DENIED|UNAUTHORIZED/i.test(String(a.command) + raw)) {
      resultHtml = `${tagHtml('danger', 'Chặn truy cập')} ${escapeHtml(raw)}`;
    } else {
      resultHtml = escapeHtml(raw || '—');
    }
    return `<tr>
      <td class="mono">#${escapeHtml(a.id)}</td>
      <td class="mono">${escapeHtml(formatTimeShort(a.timestamp))}</td>
      <td>${escapeHtml(a.source || 'web_dashboard')}</td>
      <td class="mono">${escapeHtml(a.chat_id || '—')}</td>
      <td class="mono"><strong>${escapeHtml(a.command)}</strong></td>
      <td class="result">${resultHtml}</td>
    </tr>`;
  }).join('');
}

// ---------- main update ----------
function buildMetrics(cur) {
  const status = String(cur.status || 'SAFE');
  const gas = Number(cur.gas_ma10 ?? 0);
  return {
    state: classify(cur),
    status,
    level: Number(cur.level || 0),
    temp: Number(cur.temp ?? 30),
    hum: Number(cur.hum ?? 55),
    gasRaw: Number(cur.gas_raw ?? 0),
    gas,
    ppm: Number(cur.gas_ppm ?? gasToPpm(gas)),
    tempRor: Number(cur.temp_ror ?? 0),
    gasRor: Number(cur.gas_ror ?? 0),
    flame: isTrue(cur.flame),
    relayOn: cur.relay_on === undefined ? true : isTrue(cur.relay_on),
    fanOn: isTrue(cur.fan_on),
    latched: isTrue(cur.latched),
    muted: isTrue(cur.muted),
  };
}

function updateDashboard(data) {
  if (!data) return;
  const cur = data.current;
  updateHeader(cur);

  if (cur) {
    const m = buildMetrics(cur);
    updateStatusPanel(m);
    applyControlButtons(m);
    updateReadouts(m);
    updateDevices(m);
    updateBench(cur, m);
  } else {
    setText('stateGuide', 'Chưa có dữ liệu cảm biến. Hãy bật ESP32 hoặc chờ vài giây để hệ thống thu thập dữ liệu.');
  }

  updateCharts(data.history);
  renderIncidents(data.incidents || []);
  renderAudits(data.audits || []);
}

// ---------- polling ----------
async function fetchState() {
  if (fetching) return;
  fetching = true;
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    lastSuccessTime = Date.now();
    updateDashboard(data);
  } catch (err) {
    if (Date.now() - lastSuccessTime > 4000) {
      setLed($('connDot'), 'danger');
      setText('connText', 'mất kết nối, đang thử lại…');
      setLed($('espDot'), 'off');
    }
  } finally {
    fetching = false;
  }
}

// ---------- commands ----------
function setFeedback(state, title, text) {
  const box = $('cmdFeedback');
  box.dataset.state = state;
  setText('cmdFeedbackTitle', title);
  setText('cmdFeedbackText', text);
  const actionsBox = $('cmdFeedbackActions');
  if (actionsBox) {
    actionsBox.hidden = !(state === 'refused' || (!lastRelayOn && lastHazard));
  }
}

function cleanResult(result) {
  const s = String(result || '').replace(/^Từ chối:\s*/i, '').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

async function sendCommand(command, opts = {}) {
  if (commandInFlight) return;
  const isSim = opts.target === 'sim' || String(command).startsWith('SIM_');
  const label = COMMAND_LABEL[command] || command;
  const button = opts.button || null;

  // Whenever switching a SIM_* preset, clear slider hold timer so sliders sync immediately
  if (String(command).startsWith('SIM_')) {
    clearTimeout(simUi.timer);
    simUi.dragging = false;
    simUi.pending = false;
    simUi.lastTouch = 0;
  }

  commandInFlight = true;
  refreshControlDisabled();
  if (button) button.setAttribute('aria-busy', 'true');
  if (isSim) setSimFeedback('busy', `Đang chuyển ${label}…`);
  else setFeedback('busy', `Đang gửi: ${label}`, 'Chờ máy chủ và khóa an toàn xác nhận…');

  let outcome = 'error';
  try {
    const res = await fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, source: 'web_dashboard' }),
    });
    const data = await res.json().catch(() => ({}));
    const when = formatTimeShort(new Date().toISOString());
    if (res.ok && data.ok) {
      outcome = 'ok';
      if (isSim) {
        setSimFeedback('ok', `${label}. ${cleanResult(data.result)}`);
        if (command === 'SIM_NORMAL' && $('cmdFeedback').dataset.state === 'refused') {
          setFeedback('ok', `Đã đưa bếp về trạng thái An toàn · ${when}`, 'Cảm biến đã an toàn và điện bếp đã được cấp trở lại.');
        }
      } else {
        setFeedback('ok', `Đã thực hiện: ${label} · ${when}`, cleanResult(data.result) || 'Lệnh đã được ghi nhận.');
      }
      if (data.current && String(command).startsWith('SIM_')) {
        syncSlidersFromState(buildMetrics(data.current), true);
      }
    } else if (res.ok) {
      outcome = 'refused';
      if (isSim) setSimFeedback('error', `${label} bị từ chối. ${cleanResult(data.result)}`);
      else setFeedback('refused', `Bị từ chối bởi khóa an toàn: ${label} · ${when}`, cleanResult(data.result) || 'Lệnh này đang bị khóa vì lý do an toàn.');
    } else {
      outcome = 'error';
      const reason = data.error || `Lỗi máy chủ (HTTP ${res.status})`;
      if (isSim) setSimFeedback('error', reason);
      else setFeedback('error', `Không gửi được: ${label}`, reason);
    }
  } catch (err) {
    outcome = 'error';
    if (isSim) setSimFeedback('error', 'Mất kết nối tới máy chủ khi gửi kịch bản.');
    else setFeedback('error', `Không gửi được: ${label}`, 'Mất kết nối tới máy chủ. Lệnh chưa được thực hiện.');
  } finally {
    commandInFlight = false;
    if (button) {
      button.removeAttribute('aria-busy');
      button.dataset.result = outcome === 'ok' ? 'ok' : 'error';
      setTimeout(() => { delete button.dataset.result; }, RESULT_FLASH_MS);
    }
    refreshControlDisabled();
    await fetchState();
  }
}

async function recoverToSafeAndRestore() {
  if (commandInFlight) return;
  const btn = $('btnQuickSafeRestore');
  clearTimeout(simUi.timer);
  simUi.dragging = false;
  simUi.pending = false;
  simUi.lastTouch = 0;

  commandInFlight = true;
  refreshControlDisabled();
  if (btn) btn.setAttribute('aria-busy', 'true');
  setFeedback('busy', 'Đang đưa bếp về An toàn & Khôi phục điện…', 'Đang đặt lại cảm biến an toàn và mở khóa rơ-le điện bếp…');

  try {
    await fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'SIM_NORMAL', source: 'web_dashboard' }),
    });
    const res = await fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'RESTORE', source: 'web_dashboard' }),
    });
    const data = await res.json().catch(() => ({}));
    const when = formatTimeShort(new Date().toISOString());
    if (res.ok && data.ok) {
      setFeedback('ok', `Đã khôi phục an toàn · ${when}`, 'Cảm biến đã về ngưỡng An toàn và điện bếp đã được cấp trở lại.');
      setSimFeedback('ok', 'Kịch bản Bình thường. Đã đặt lại thông số an toàn.');
      if (data.current) syncSlidersFromState(buildMetrics(data.current), true);
    } else {
      setFeedback('error', 'Chưa thể khôi phục điện', cleanResult(data.result) || 'Hãy kiểm tra lại trạng thái cảm biến.');
    }
  } catch (err) {
    setFeedback('error', 'Lỗi kết nối', 'Mất kết nối tới máy chủ khi khôi phục an toàn.');
  } finally {
    commandInFlight = false;
    if (btn) btn.removeAttribute('aria-busy');
    refreshControlDisabled();
    await fetchState();
  }
}

// ---------- AI assistant ----------
function appendAiMessage(role, text, pending = false) {
  const box = $('aiChatMessages');
  const wrap = document.createElement('div');
  wrap.className = `msg ${role === 'user' ? 'msg--user' : 'msg--bot'}${pending ? ' msg--pending' : ''}`;
  const who = document.createElement('p');
  who.className = 'msg__role';
  who.textContent = role === 'user' ? 'Bạn' : 'Trợ lý';
  const body = document.createElement('p');
  body.className = 'msg__text';
  body.textContent = text;
  wrap.append(who, body);
  box.appendChild(wrap);
  box.scrollTop = box.scrollHeight;
  return wrap;
}

async function askAiQuestion(question) {
  const q = String(question || '').trim();
  if (!q) return;
  const input = $('aiQuestionInput');
  const sendBtn = $('aiSendBtn');
  input.value = '';
  appendAiMessage('user', q);
  sendBtn.disabled = true;
  sendBtn.textContent = 'Đang trả lời';
  const pending = appendAiMessage('bot', 'Đang đọc số đo hiện tại của bếp…', true);
  try {
    const res = await fetch('/api/ai-ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q }),
    });
    const data = await res.json().catch(() => ({}));
    pending.classList.remove('msg--pending');
    pending.querySelector('.msg__text').textContent = data.answer || data.reply || data.error || 'Không nhận được phản hồi từ trợ lý.';
  } catch (err) {
    pending.classList.remove('msg--pending');
    pending.querySelector('.msg__text').textContent = 'Không kết nối được máy chủ. Hãy kiểm tra server.js đang chạy.';
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = 'Gửi';
    const box = $('aiChatMessages');
    box.scrollTop = box.scrollHeight;
  }
}

function handleAiSubmit(event) {
  event.preventDefault();
  askAiQuestion($('aiQuestionInput').value);
}
function askPresetQuestion(text) { askAiQuestion(text); }

// ---------- tabs ----------
function selectTab(tab) {
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t === tab;
    t.setAttribute('aria-selected', on ? 'true' : 'false');
    t.tabIndex = on ? 0 : -1;
    const panel = $(t.getAttribute('aria-controls'));
    if (panel) panel.hidden = !on;
  });
}

function wireTabs() {
  const tabs = Array.from(document.querySelectorAll('.tab'));
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      selectTab(next);
      next.focus();
    });
  });
}

// ---------- wiring ----------
function wireEvents() {
  // Real controls: the command is read at click time, so the toggle labels always match the live state
  ['btnRelay', 'btnMute', 'btnFan'].forEach((id) => {
    const btn = $(id);
    if (btn) btn.addEventListener('click', () => sendCommand(btn.dataset.command, { button: btn }));
  });

  const quickRecoverBtn = $('btnQuickSafeRestore');
  if (quickRecoverBtn) {
    quickRecoverBtn.addEventListener('click', recoverToSafeAndRestore);
  }

  // Simulation presets (separate feedback line, never mixed with real controls)
  document.querySelectorAll('.seg').forEach((btn) => {
    btn.addEventListener('click', () => {
      simUi.lastTouch = 0;
      sendCommand(btn.dataset.sim, { target: 'sim', button: btn });
    });
  });

  const resetSimBtn = $('btnResetSim');
  if (resetSimBtn) {
    resetSimBtn.addEventListener('click', () => {
      simUi.lastTouch = 0;
      $('sliderTemp').value = '30';
      $('sliderHum').value = '55';
      $('sliderGas').value = '700';
      $('sliderFlame').checked = false;
      paintSliderLabels();
      sendCommand('SIM_NORMAL', { target: 'sim', button: resetSimBtn });
    });
  }

  // Sliders
  ['sliderTemp', 'sliderHum', 'sliderGas'].forEach((id) => {
    const el = $(id);
    el.addEventListener('pointerdown', () => { simUi.dragging = true; });
    el.addEventListener('input', onSimInput);
    el.addEventListener('keydown', () => { simUi.lastTouch = Date.now(); });
  });
  $('sliderFlame').addEventListener('change', onSimInput);
  const release = () => { if (simUi.dragging) { simUi.dragging = false; simUi.lastTouch = Date.now(); } };
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  window.addEventListener('blur', release);

  // Assistant
  $('aiForm').addEventListener('submit', handleAiSubmit);
  document.querySelectorAll('[data-ask]').forEach((chip) => {
    chip.addEventListener('click', () => askAiQuestion(chip.dataset.ask));
  });

  wireTabs();
}

window.sendCommand = sendCommand;
window.recoverToSafeAndRestore = recoverToSafeAndRestore;
window.handleAiSubmit = handleAiSubmit;
window.askPresetQuestion = askPresetQuestion;

window.addEventListener('DOMContentLoaded', () => {
  paintSliderLabels();
  initCharts();
  wireEvents();
  fetchState();
  setInterval(fetchState, POLL_INTERVAL_MS);
});
