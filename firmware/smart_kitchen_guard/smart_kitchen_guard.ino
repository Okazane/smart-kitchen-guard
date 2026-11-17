/**
 * ============================================================================
 * SMART KITCHEN GAS & FIRE SAFETY SYSTEM (CHUẨN LAB 5 MỞ RỘNG - EIU CSN 302)
 * ============================================================================
 * Kỹ thuật Lab 5 áp dụng:
 *  1. Bộ lọc Moving Average 10 mẫu (MA10) đọc mỗi 200ms cho cảm biến MQ-2 (GPIO 34)
 *  2. Ngắt ngoài phần cứng attachInterrupt (FALLING) cho Flame IR (GPIO 35) & Button (GPIO 18)
 *  3. Màn hình OLED SSD1306 I2C (GPIO 21, 22) cập nhật mỗi 100ms bằng millis() (Non-blocking)
 *  4. Phân loại thông minh 5 trạng thái + Điều khiển Quạt thông gió qua Relay Kênh 2 (GPIO 27):
 *     - SAFE          : Điện ON  | Quạt OFF | Còi OFF
 *     - COOKING (FAN) : Điện ON  | Quạt ON  | Còi OFF (Chống báo động giả khi nấu ăn độ ẩm > 72%)
 *     - WARNING!      : Điện ON  | Quạt ON  | Còi ON  (Rò gas nhẹ / Nhiệt tăng nhanh)
 *     - GAS DANGER!   : Điện CẮT | Quạt ON  | Còi ON  (Chốt Latch + Hút khí gas ra ngoài)
 *     - FIRE ALARM!   : Điện CẮT | Quạt OFF | Còi ON  (Chốt Latch + TẮT QUẠT tránh thổi oxy vào lửa!)
 *  5. Đồng bộ JSON hai chiều qua HTTPClient mỗi 2000ms tới Node.js Server (SQLite + Web + Telegram)
 * ============================================================================
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <DHT.h>
#include <math.h>

// ================= 1. ĐỊNH NGHĨA CHÂN GPIO (HARDWARE PINOUT) =================
#define DHT_PIN       4     // Cảm biến Nhiệt độ & Độ ẩm DHT11
#define DHT_TYPE      DHT11
#define BUTTON_PIN    18    // Ngắt ngoài (INPUT_PULLUP): Nút nhấn Tắt còi / Reset Latch
#define BUZZER_PIN    25    // Còi báo động Active Buzzer (HIGH = Kêu, LOW = Tắt)
#define RELAY_PWR_PIN 26    // Relay Kênh 1 (IN1): Nguồn điện bếp (HIGH = ON, LOW = CUT)
#define RELAY_FAN_PIN 27    // Relay Kênh 2 (IN2): Quạt thông gió 5V (LOW = ON, HIGH = OFF)
#define GAS_PIN       34    // ADC1_CH6: Cảm biến khí Gas MQ-2 (hoặc LDR giả lập)
#define FLAME_PIN     35    // Ngắt ngoài (INPUT): Cảm biến lửa IR (LOW = Có lửa)

// Định nghĩa mức kích cho Quạt thông gió qua Relay Kênh 2 (Active-LOW)
#define FAN_ON        LOW
#define FAN_OFF       HIGH

// Cấu hình màn hình OLED 0.96" I2C (SDA = GPIO 21, SCL = GPIO 22)
#define SCREEN_WIDTH  128
#define SCREEN_HEIGHT 64
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);
DHT dht(DHT_PIN, DHT_TYPE);

// ================= 2. CẤU HÌNH WI-FI & BACKEND SERVER =================
const char* ssid     = "YOUR_WIFI_SSID";
const char* password = "YOUR_WIFI_PASSWORD";
// Đổi IP dưới đây thành IPv4 của máy tính chạy `node server.js`
String serverUrl     = "http://YOUR_SERVER_IP:3000/api/telemetry";

// ================= 3. BỘ LỌC MOVING AVERAGE 10 MẪU (LAB 5 - BÀI 1) =================
const int WINDOW_SIZE = 10;
int gasReadings[WINDOW_SIZE];
int readIndex = 0;
long gasTotal = 0;
int gasRaw    = 0;
int gasMA10   = 0;
int gasPPM    = 0;

// Biến tính tốc độ tăng (Rate-of-Rise: RoR) mỗi phút
int prevGasMA10   = 0;
float prevTemp    = 30.0;
float gasRoR      = 0.0; // ADC/phút
float tempRoR     = 0.0; // °C/phút

// ================= 4. BIẾN TRẠNG THÁI & NGẮT PHẦN CỨNG ISR (LAB 5 - BÀI 2 & 3) =================
volatile int systemLevel       = 0;     // 0: SAFE/COOKING, 1: WARNING, 2: DANGER
volatile bool isLatched        = false; // Chốt an toàn khi xảy ra DANGER (Gas nặng / Lửa)
volatile bool isMuted          = false; // Trạng thái tắt tiếng còi tạm thời
volatile bool flameFlag        = false; // Cờ ngắt phát hiện lửa từ flameISR
volatile bool btnPressedFlag   = false; // Cờ ngắt nút nhấn từ buttonISR
volatile unsigned long lastBtnIrqTime = 0;

bool isFanRunning       = false;
bool manualFanOverride  = false;
bool manualFanState     = false;
bool isWarmingUp        = true;

float temperature = 30.0;
float humidity    = 55.0;
String statusLabel = "WARM-UP";

// Mốc thời gian millis() cho đa nhiệm không chặn (Non-blocking scheduling)
unsigned long bootTime        = 0;
unsigned long lastGasRead     = 0;
unsigned long lastDhtRead     = 0;
unsigned long lastOledUpdate  = 0;
unsigned long lastServerSend  = 0;
unsigned long lastRoRCalc     = 0;

const unsigned long WARMUP_DURATION_MS = 10000; // 10 giây làm nóng cảm biến MQ-2 khi khởi động

// ISR 1: Ngắt phần cứng khi phát hiện LỬA (Phản ứng tức thì < 1ms, không phụ thuộc Wi-Fi)
void IRAM_ATTR flameISR() {
  flameFlag   = true;
  systemLevel = 2;
  isLatched   = true;
  isMuted     = false;
  digitalWrite(RELAY_PWR_PIN, LOW);     // Cắt nguồn điện bếp ngay lập tức!
  digitalWrite(RELAY_FAN_PIN, FAN_OFF); // TẮT QUẠT ngay lập tức để không thổi oxy vào lửa!
  digitalWrite(BUZZER_PIN, HIGH);       // Hú còi báo động khẩn cấp!
}

// ISR 2: Ngắt phần cứng khi người dùng nhấn NÚT (Chống dội 250ms + Tắt còi tức thì)
void IRAM_ATTR buttonISR() {
  unsigned long now = millis();
  if (now - lastBtnIrqTime < 250) return; // Debounce 250ms chống nhiễu tiếp điểm
  lastBtnIrqTime = now;

  isMuted = true;
  digitalWrite(BUZZER_PIN, LOW); // Tắt tiếng còi ngay lập tức
  btnPressedFlag = true;         // Đánh dấu để loop() kiểm tra điều kiện mở khóa Relay an toàn
}

// Hàm quy đổi tương đối giá trị ADC (0-4095) sang nồng độ PPM cho MQ-2
int estimateGasPPM(int adcValue) {
  if (adcValue <= 400) return map(adcValue, 0, 400, 20, 150);
  if (adcValue <= 1600) return map(adcValue, 400, 1600, 150, 1000);
  if (adcValue <= 2600) return map(adcValue, 1600, 2600, 1000, 3000);
  return map(adcValue, 2600, 4095, 3000, 10000);
}

// Khôi phục trạng thái bình thường (khi nhấn nút Reset hoặc nhận lệnh RESTORE từ xa)
void tryRestoreSystem(bool forceRestore) {
  bool flameClear = (digitalRead(FLAME_PIN) == HIGH);
  bool gasSafe    = (gasMA10 < 1400 && temperature < 45.0);

  if (forceRestore || (flameClear && gasSafe)) {
    isLatched         = false;
    flameFlag         = false;
    isMuted           = false;
    manualFanOverride = false;
    systemLevel       = 0;
    statusLabel       = "SAFE";
    isFanRunning      = false;
    digitalWrite(BUZZER_PIN, LOW);
    digitalWrite(RELAY_PWR_PIN, HIGH);    // Cấp điện bếp trở lại
    digitalWrite(RELAY_FAN_PIN, FAN_OFF); // Tắt quạt hút
  }
}

// ================= 5. HÀM PHÂN LOẠI THÔNG MINH & ĐIỀU KHIỂN QUẠT =================
void evaluateSafety() {
  // Xử lý cờ nút nhấn từ buttonISR
  if (btnPressedFlag) {
    btnPressedFlag = false;
    tryRestoreSystem(false);
  }

  bool flameNow = (digitalRead(FLAME_PIN) == LOW);

  // -------------------------------------------------------------------------
  // TRƯỜNG HỢP 1: NGUY HIỂM MỨC 2 - CÓ LỬA HOẶC RÒ GAS NẶNG (CHỐT LATCH)
  // -------------------------------------------------------------------------
  if (flameNow || flameFlag || gasMA10 >= 2600 || temperature >= 55.0 || isLatched) {
    systemLevel = 2;
    isLatched   = true;
    digitalWrite(RELAY_PWR_PIN, LOW); // Cắt nguồn điện bếp
    digitalWrite(BUZZER_PIN, isMuted ? LOW : HIGH);

    // Quy tắc PCCC:
    // - Có lửa (FIRE ALARM!): Bắt buộc TẮT QUẠT để không thổi thêm oxy làm bùng đám cháy!
    // - Rò gas nặng (GAS DANGER!): BẬT QUẠT tối đa để đẩy khí gas ra ngoài, làm loãng nồng độ!
    if (flameNow || flameFlag) {
      statusLabel  = "FIRE ALARM!";
      isFanRunning = false;
      digitalWrite(RELAY_FAN_PIN, FAN_OFF);
    } else {
      statusLabel  = "GAS DANGER!";
      isFanRunning = true;
      digitalWrite(RELAY_FAN_PIN, FAN_ON);
    }
    return;
  }

  // -------------------------------------------------------------------------
  // TRƯỜNG HỢP 2: ĐANG NẤU ĂN (COOKING) - CHỐNG BÁO ĐỘNG GIẢ
  // Độ ẩm cao (> 72%) + Khí/mùi tăng vừa phải (1400 <= gasMA10 < 2000) + Nhiệt < 48°C
  // -> Giữ điện bếp ON, Tự động BẬT QUẠT hút khói/hơi nước, KHÔNG hú còi!
  // -------------------------------------------------------------------------
  if (humidity > 72.0 && gasMA10 >= 1400 && gasMA10 < 2000 && temperature < 48.0) {
    systemLevel  = 0;
    statusLabel  = "COOKING (FAN)";
    isFanRunning = true;
    digitalWrite(BUZZER_PIN, LOW);
    digitalWrite(RELAY_PWR_PIN, HIGH);
    digitalWrite(RELAY_FAN_PIN, FAN_ON);
    return;
  }

  // -------------------------------------------------------------------------
  // TRƯỜNG HỢP 3: CẢNH BÁO SỚM MỨC 1 (WARNING!)
  // Rò gas nhẹ (gasMA10 >= 1600) hoặc Nhiệt cao (>= 46°C) hoặc Nhiệt tăng đột ngột (tempRoR >= 4.0)
  // -> Giữ điện bếp ON, BẬT QUẠT thông gió + BẬT CÒI cảnh báo sớm
  // -------------------------------------------------------------------------
  if (gasMA10 >= 1600 || temperature >= 46.0 || tempRoR >= 4.0) {
    systemLevel  = 1;
    statusLabel  = "WARNING!";
    isFanRunning = true;
    digitalWrite(RELAY_PWR_PIN, HIGH);
    digitalWrite(RELAY_FAN_PIN, FAN_ON);
    digitalWrite(BUZZER_PIN, isMuted ? LOW : HIGH);
    return;
  }

  // -------------------------------------------------------------------------
  // TRƯỜNG HỢP 4: AN TOÀN (SAFE) - Áp dụng ngưỡng trễ Hysteresis (< 1400 & < 43°C)
  // -------------------------------------------------------------------------
  if (gasMA10 < 1400 && temperature < 43.0) {
    systemLevel = 0;
    isMuted     = false;
    statusLabel = "SAFE";
    digitalWrite(BUZZER_PIN, LOW);
    digitalWrite(RELAY_PWR_PIN, HIGH);

    if (manualFanOverride) {
      isFanRunning = manualFanState;
      digitalWrite(RELAY_FAN_PIN, isFanRunning ? FAN_ON : FAN_OFF);
    } else {
      isFanRunning = false;
      digitalWrite(RELAY_FAN_PIN, FAN_OFF);
    }
  }
}

// ================= 6. HIỂN THỊ OLED MỖI 100MS (LAB 5 - BÀI 3.3) =================
void updateOLED(unsigned long now) {
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);

  // Màn hình tiến trình làm nóng cảm biến MQ-2 trong 10 giây đầu (Non-blocking Warm-up)
  if (isWarmingUp) {
    unsigned long elapsed = now - bootTime;
    int progress = constrain((int)((elapsed * 100UL) / WARMUP_DURATION_MS), 0, 100);

    display.setCursor(10, 0);
    display.println("SMART KITCHEN GUARD");
    display.drawLine(0, 10, 128, 10, SSD1306_WHITE);

    display.setCursor(8, 18);
    display.println("MQ-2 Sensor Warm-up");

    // Vẽ thanh Progress Bar
    display.drawRect(10, 32, 108, 12, SSD1306_WHITE);
    int fillWidth = map(progress, 0, 100, 0, 104);
    display.fillRect(12, 34, fillWidth, 8, SSD1306_WHITE);

    display.setCursor(48, 48);
    display.print(progress);
    display.println(" %");
    display.display();
    return;
  }

  // Giao diện giám sát chính chuẩn Lab 5
  display.setCursor(10, 0);
  display.println("SMART KITCHEN GUARD");
  display.drawLine(0, 10, 128, 10, SSD1306_WHITE);

  display.setCursor(0, 14);
  display.print("T:");
  display.print(temperature, 1);
  display.print("C  H:");
  display.print(humidity, 0);
  display.println("%");

  display.setCursor(0, 26);
  display.print("Gas Raw:");
  display.print(gasRaw);
  display.print(" MA:");
  display.println(gasMA10);

  display.drawLine(0, 37, 128, 37, SSD1306_WHITE);

  display.setCursor(0, 42);
  display.print("ST: ");
  display.println(statusLabel);

  display.setCursor(0, 54);
  display.print("Pwr:");
  display.print(digitalRead(RELAY_PWR_PIN) == HIGH ? "ON " : "CUT");
  display.print(" | Fan:");
  display.print(isFanRunning ? "ON" : "OFF");

  display.display();
}

// ================= 7. ĐỒNG BỘ DỮ LIỆU LÊN SERVER & NHẬN LỆNH TỪ XA =================
void syncWithServer() {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  http.begin(serverUrl);
  http.addHeader("Content-Type", "application/json");

  bool flameDetected = (digitalRead(FLAME_PIN) == LOW) || flameFlag;

  StaticJsonDocument<384> doc;
  doc["temp"]     = round(temperature * 10.0) / 10.0;
  doc["hum"]      = round(humidity * 10.0) / 10.0;
  doc["gas_raw"]  = gasRaw;
  doc["gas_ma10"] = gasMA10;
  doc["gas_ppm"]  = gasPPM;
  doc["temp_ror"] = round(tempRoR * 10.0) / 10.0;
  doc["gas_ror"]  = round(gasRoR);
  doc["flame"]    = flameDetected;
  doc["level"]    = systemLevel;
  doc["status"]   = statusLabel;
  doc["relay_on"] = (digitalRead(RELAY_PWR_PIN) == HIGH);
  doc["fan_on"]   = isFanRunning;
  doc["latched"]  = isLatched;
  doc["muted"]    = isMuted;

  String requestBody;
  serializeJson(doc, requestBody);

  int httpCode = http.POST(requestBody);
  if (httpCode == 200) {
    String response = http.getString();
    StaticJsonDocument<256> resDoc;
    if (!deserializeJson(resDoc, response)) {
      String cmd = resDoc["command"] | "NONE";

      if (cmd == "CUT_POWER") {
        systemLevel = 2;
        isLatched   = true;
        statusLabel = "MANUAL CUT!";
        digitalWrite(RELAY_PWR_PIN, LOW);
      } else if (cmd == "RESTORE") {
        tryRestoreSystem(true);
      } else if (cmd == "MUTE") {
        isMuted = true;
        digitalWrite(BUZZER_PIN, LOW);
      } else if (cmd == "FAN_ON") {
        // Chỉ bật quạt nếu KHÔNG có lửa cháy
        if (!flameDetected) {
          manualFanOverride = true;
          manualFanState    = true;
          isFanRunning      = true;
          digitalWrite(RELAY_FAN_PIN, FAN_ON);
        }
      } else if (cmd == "FAN_OFF") {
        manualFanOverride = true;
        manualFanState    = false;
        isFanRunning      = false;
        digitalWrite(RELAY_FAN_PIN, FAN_OFF);
      }
    }
  }
  http.end();
}

// ================= 8. KHỞI TẠO HỆ THỐNG (SETUP) =================
void setup() {
  Serial.begin(115200);
  analogReadResolution(12); // Độ phân giải ADC 12-bit (0 - 4095) chuẩn ESP32

  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(RELAY_PWR_PIN, OUTPUT);
  pinMode(RELAY_FAN_PIN, OUTPUT);

  // Trạng thái khởi động an toàn
  digitalWrite(BUZZER_PIN, LOW);
  digitalWrite(RELAY_PWR_PIN, HIGH);    // Cấp nguồn điện bếp
  digitalWrite(RELAY_FAN_PIN, FAN_OFF); // Tắt quạt hút gió

  // GPIO 35 là chân Input-only (module Flame IR có sẵn LM393 kéo mức logic)
  pinMode(FLAME_PIN, INPUT);
  pinMode(BUTTON_PIN, INPUT_PULLUP);

  // Gắn 2 ngắt ngoài chuẩn Lab 5
  attachInterrupt(digitalPinToInterrupt(FLAME_PIN), flameISR, FALLING);
  attachInterrupt(digitalPinToInterrupt(BUTTON_PIN), buttonISR, FALLING);

  dht.begin();
  Wire.begin(21, 22);
  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);

  // Khởi tạo mảng bộ lọc Moving Average 10 mẫu bằng giá trị đọc ban đầu
  int initialGas = analogRead(GAS_PIN);
  gasTotal = 0;
  for (int i = 0; i < WINDOW_SIZE; i++) {
    gasReadings[i] = initialGas;
    gasTotal += initialGas;
  }
  gasRaw      = initialGas;
  gasMA10     = initialGas;
  prevGasMA10 = initialGas;
  gasPPM      = estimateGasPPM(gasMA10);

  bootTime = millis();

  WiFi.begin(ssid, password);
  Serial.print("Connecting to WiFi");
  int retry = 0;
  while (WiFi.status() != WL_CONNECTED && retry < 15) {
    delay(300);
    Serial.print(".");
    retry++;
  }
  Serial.println("\nSmart Kitchen Guard Initialized!");
}

// ================= 9. VÒNG LẶP CHÍNH (NON-BLOCKING MILLIS LOOP) =================
void loop() {
  unsigned long now = millis();

  // Kiểm tra hoàn tất 10 giây làm nóng cảm biến MQ-2 (Non-blocking)
  if (isWarmingUp && (now - bootTime >= WARMUP_DURATION_MS)) {
    isWarmingUp = false;
    statusLabel = "SAFE";
  }

  // 1. Đọc cảm biến Gas & Lọc Moving Average 10 mẫu mỗi 200ms (Lab 5 - Bài 1.2)
  if (now - lastGasRead >= 200) {
    lastGasRead = now;

    gasTotal = gasTotal - gasReadings[readIndex];
    gasRaw = analogRead(GAS_PIN);
    gasReadings[readIndex] = gasRaw;
    gasTotal = gasTotal + gasReadings[readIndex];
    readIndex = (readIndex + 1) % WINDOW_SIZE;

    gasMA10 = gasTotal / WINDOW_SIZE;
    gasPPM  = estimateGasPPM(gasMA10);

    if (!isWarmingUp) {
      evaluateSafety();
    }

    // In ra Serial Plotter theo chuẩn Lab 5 để đối chiếu đường Raw vs MA10
    Serial.print("Gas_Raw:");
    Serial.print(gasRaw);
    Serial.print("\tGas_MA10:");
    Serial.println(gasMA10);
  }

  // 2. Đọc cảm biến Nhiệt độ & Độ ẩm DHT11 mỗi 2000ms
  if (now - lastDhtRead >= 2000) {
    lastDhtRead = now;
    float t = dht.readTemperature();
    float h = dht.readHumidity();
    if (!isnan(t) && !isnan(h)) {
      temperature = t;
      humidity    = h;
    }
  }

  // 3. Tính tốc độ gia tăng nhiệt độ & khí gas (Rate-of-Rise per minute) mỗi 5000ms
  if (now - lastRoRCalc >= 5000) {
    float dtMin = (now - lastRoRCalc) / 60000.0;
    lastRoRCalc = now;
    if (dtMin > 0) {
      tempRoR = (temperature - prevTemp) / dtMin;
      gasRoR  = (gasMA10 - prevGasMA10) / dtMin;
      prevTemp    = temperature;
      prevGasMA10 = gasMA10;
    }
  }

  // 4. Cập nhật màn hình OLED mỗi 100ms (Lab 5 - Bài 3.3)
  if (now - lastOledUpdate >= 100) {
    lastOledUpdate = now;
    updateOLED(now);
  }

  // 5. Đồng bộ dữ liệu JSON lên Server & nhận lệnh điều khiển mỗi 2000ms
  if (now - lastServerSend >= 2000) {
    lastServerSend = now;
    syncWithServer();
  }
}
