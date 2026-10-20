/*
 * esp32-json.ino - ESP32 som adapter til HMI-huben: Wi-Fi, WebSocket og JSON.
 *
 * Adapteren ligger i selve ESP32-programmet: kortet kobler seg til huben som WebSocket-klient,
 * registrerer taggene sine, sender målinger når de endres, og utfører skrivinger fra HMI-en
 * (Switch, Slider, Button, Number input). Ingen bro eller annen maskin trengs.
 *
 * Biblioteker (Arduino IDE -> Tools -> Manage Libraries):
 *   - "WebSockets"  av Markus Sattler   (links2004/arduinoWebSockets)
 *   - "ArduinoJson" av Benoit Blanchon  (versjon 7.x)
 * Kort: en hvilken som helst ESP32 med Espressifs arduino-esp32-kjerne 2.0.2 eller nyere.
 * Uten internett: last ned bibliotekene som .zip på en annen maskin, og bruk
 * Sketch -> Include Library -> Add .ZIP Library.
 *
 * Taggene (med NAME = "esp32_1"):
 *   esp32_1.temp          brikkens temperatur, °C   (grov: bytt gjerne til en ekte sensor)
 *   esp32_1.analog        ADC på ANALOG_PIN, %       (koble et potmeter dit)
 *   esp32_1.button        BOOT-knappen               (leses)
 *   esp32_1.uptime        sekunder siden oppstart    (leses)
 *   esp32_1.rssi          Wi-Fi-signal, dBm          (leses)
 *   esp32_1.led           LED_PIN                    (skrivbar: Switch)
 *   esp32_1.pwm           PWM på PWM_PIN, 0-100 %    (skrivbar: Slider eller Number input)
 *   esp32_1.alarm_limit   alarmgrense, °C            (skrivbar)
 *   esp32_1.temp_high     temp over alarm_limit      (alarm i HMI-ens alarmliste)
 */
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>

// ---------------------------------------------------------------- innstillinger
const char*    WIFI_SSID = "your-wifi";
const char*    WIFI_PASS = "your-password";
const char*    HUB_HOST  = "192.168.1.10";   // maskinen der hub.js kjører (Pi-en)
const uint16_t HUB_PORT  = 8080;
const char*    NAME      = "esp32_1";        // tagprefiks, unikt for hvert kort

// pinner for et vanlig ESP32-DevKit; på en ESP32-S3 er f.eks. LED 48, PWM 5, analog 4
const int LED_PIN    = 2;
const int PWM_PIN    = 4;
const int ANALOG_PIN = 34;                   // bare inngang: koble et potmeter dit
const int BUTTON_PIN = 0;                    // BOOT-knappen, aktiv lav
const unsigned long PUBLISH_MS = 1000;       // hvor ofte målingene sendes (bare endrede verdier går ut)

// ---------------------------------------------------------------- taggene
// Én linje per tag. alarm: teksten for en alarm som står så lenge verdien er true, ellers nullptr.
struct TagDef { const char* key; const char* dataType; const char* unit; bool writable; const char* alarm; };
const TagDef TAGS[] = {
  { "temp",        "number",  "°C",  false, nullptr },
  { "analog",      "number",  "%",   false, nullptr },
  { "button",      "boolean", "",    false, nullptr },
  { "uptime",      "number",  "s",   false, nullptr },
  { "rssi",        "number",  "dBm", false, nullptr },
  { "led",         "boolean", "",    true,  nullptr },
  { "pwm",         "number",  "%",   true,  nullptr },
  { "alarm_limit", "number",  "°C",  true,  nullptr },
  { "temp_high",   "boolean", "",    false, "ESP32 temperature above limit" },
};

// ---------------------------------------------------------------- tilstand
WebSocketsClient ws;
bool          hubReady    = false;
unsigned long lastPublish = 0;
bool          ledOn       = false;
float         pwmPct      = 0;
float         alarmLimit  = 60.0;
bool          lastButton  = false;
JsonDocument  sent;      // siste verdi sendt for hver tag, så bare endringer går ut
JsonDocument  pending;   // endringer som venter på neste update-melding

String full(const char* key) { return String(NAME) + "." + key; }

void sendJson(JsonDocument& doc) {
  String out;
  serializeJson(doc, out);
  ws.sendTXT(out);
}

// ---------------------------------------------------------------- protokollen
void sendHello() {
  JsonDocument doc;
  doc["type"] = "hello";
  doc["role"] = "adapter";
  doc["name"] = NAME;
  sendJson(doc);
}

void registerTags() {
  JsonDocument doc;
  doc["type"] = "register";
  JsonArray tags = doc["tags"].to<JsonArray>();
  for (const TagDef& t : TAGS) {
    JsonObject o = tags.add<JsonObject>();
    o["name"]     = full(t.key);
    o["dataType"] = t.dataType;
    o["unit"]     = t.unit;
    o["writable"] = t.writable;
    if (t.alarm) {
      JsonObject a = o["alarm"].to<JsonObject>();
      a["severity"] = "alarm";
      a["text"]     = t.alarm;
      a["delay"]    = 3000;            // må stå på i 3 s før alarmen kommer
    }
  }
  sendJson(doc);
  sent.clear();                        // etter en ny tilkobling sendes alle verdiene på nytt
}

// en ny verdi for en tag: samles opp, og sendes med flush() bare hvis den er endret
template <typename T>
void setTag(const char* key, T value) {
  if (sent[key].is<T>() && sent[key].as<T>() == value) return;
  sent[key] = value;
  pending[full(key)] = value;
}

void flush() {
  if (!hubReady || pending.as<JsonObject>().size() == 0) return;
  JsonDocument doc;
  doc["type"]   = "update";
  doc["values"] = pending.as<JsonObject>();
  sendJson(doc);
  pending.clear();
}

void sendEvent(const char* severity, const String& message) {   // info, warning eller alarm
  if (!hubReady) return;
  JsonDocument doc;
  doc["type"]     = "event";
  doc["severity"] = severity;
  doc["message"]  = message;
  sendJson(doc);
}

// HMI-en skriver en tag: utfør det, og send verdien som faktisk ble satt tilbake (ekkoet)
void handleWrite(JsonDocument& msg) {
  String tag = msg["tag"] | "";
  String prefix = String(NAME) + ".";
  if (!tag.startsWith(prefix)) return;
  String key = tag.substring(prefix.length());
  JsonVariantConst v = msg["value"];

  JsonDocument echo;
  echo["type"] = "update";
  echo["tag"]  = tag;
  if (key == "led") {
    ledOn = v.as<bool>();
    digitalWrite(LED_PIN, ledOn ? HIGH : LOW);
    echo["value"] = ledOn;
    sent["led"]   = ledOn;
  } else if (key == "pwm" || key == "alarm_limit") {
    float* target = key == "pwm" ? &pwmPct : &alarmLimit;
    if (!v.is<float>()) {              // avvist: ekko den gamle verdien, så kontrollen hopper tilbake
      sendEvent("info", "Write to " + tag + " refused: not a number");
    } else if (key == "pwm") {
      pwmPct = constrain(v.as<float>(), 0.0f, 100.0f);
      analogWrite(PWM_PIN, (int)(pwmPct * 255 / 100));
    } else {
      alarmLimit = v.as<float>();
    }
    echo["value"]    = *target;
    sent[key.c_str()] = *target;
  } else {
    sendEvent("info", "Write to " + tag + " refused: not a writable tag");
    return;
  }
  sendJson(echo);
  Serial.printf("write %s = %s\n", key.c_str(), echo["value"].as<String>().c_str());
}

void onWsEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.println("hub: connected");
      sendHello();
      registerTags();
      hubReady = true;
      lastPublish = 0;                 // send alle målingene med en gang
      break;
    case WStype_DISCONNECTED:
      if (hubReady) Serial.println("hub: disconnected, trying again");
      hubReady = false;
      break;
    case WStype_TEXT: {
      JsonDocument doc;
      if (deserializeJson(doc, payload, length)) return;
      const char* t = doc["type"] | "";
      if (strcmp(t, "write") == 0) handleWrite(doc);
      else if (strcmp(t, "error") == 0) Serial.printf("hub says: %s\n", (const char*)(doc["message"] | ""));
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------- målingene
void publish() {
  float temp = roundf(temperatureRead() * 10) / 10;          // brikkens egen sensor, grov
  setTag("temp", temp);
  setTag("analog", roundf(analogRead(ANALOG_PIN) * 1000.0f / 4095.0f) / 10);
  setTag("uptime", (unsigned long)(millis() / 1000));
  setTag("rssi", (int)WiFi.RSSI());
  setTag("led", ledOn);
  setTag("pwm", pwmPct);
  setTag("alarm_limit", alarmLimit);
  setTag("temp_high", temp > alarmLimit);
}

// ---------------------------------------------------------------- arduino
void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  digitalWrite(LED_PIN, LOW);
  analogWrite(PWM_PIN, 0);

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);          // Wi-Fi kobler til igjen av seg selv
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Wi-Fi");
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print('.'); }
  Serial.print("\nIP: ");
  Serial.println(WiFi.localIP());

  ws.begin(HUB_HOST, HUB_PORT, "/");
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(3000);        // prøv igjen hvert 3. s når huben ikke svarer
  ws.enableHeartbeat(15000, 3000, 2);   // oppdag en død forbindelse og koble til på nytt
}

void loop() {
  ws.loop();                            // tar imot skrivinger, svarer på ping, kobler til igjen
  if (!hubReady) return;

  // knappen sendes med en gang den endres, ikke bare hvert sekund
  bool pressed = digitalRead(BUTTON_PIN) == LOW;
  if (pressed != lastButton) {
    lastButton = pressed;
    setTag("button", pressed);
    if (pressed) sendEvent("info", String("BOOT button pressed on ") + NAME);
  }

  if (lastPublish == 0 || millis() - lastPublish >= PUBLISH_MS) {
    lastPublish = millis();
    publish();
  }
  flush();
}
