// SLS v3 single-gate ESP32 firmware.
// Recycled protocol subset from orig firmware v1.2.2 (`hardware/src/main.cpp`):
// kept WELCOME/BYE/UNLOCK/LOCK/DENY/BEEP/PING/STATUS/VERSION + ACK + auto-relock.
// Dropped for v3 single-cam: ALERT_TAILGATE/ALARM, LCD screens, IDLE/NVS brand,
// FINDRELAY/STOPRELAY diagnostics, watchdog (re-add with LCD + wdt when needed).
// Wiring: LOCK_PIN=GPIO3 active-LOW relay (COM/NO maglock), buzzer GPIO10,
//         EXIT_BTN_PIN=GPIO4 physical exit button (active-LOW, INPUT_PULLUP).
//         115200 baud.
#include <Arduino.h>
#ifndef LOCK_PIN
#define LOCK_PIN 3
#endif
#ifndef BUZZER_PIN
#define BUZZER_PIN 10
#endif
#ifndef EXIT_BTN_PIN
#define EXIT_BTN_PIN 4
#endif
static const char* FW_VERSION = "3.1.0";
// S3 super-mini boards expose USB only via a CH343 bridge on UART0: native-USB
// `GATE_PORT` goes nowhere, so the gate protocol runs on UART0 (`GATE_PORT0`).
// Native-USB builds (CDC on boot) keep using `GATE_PORT`.
#if defined(CONFIG_IDF_TARGET_ESP32S3) && !ARDUINO_USB_CDC_ON_BOOT
#define GATE_PORT Serial0
#else
#define GATE_PORT Serial
#endif
static bool unlocked = false;
static unsigned long relock_at = 0;

// Exit button debounce
static unsigned long lastExitBtnMs = 0;
static const unsigned long EXIT_BTN_DEBOUNCE_MS = 500;

static void lock_now() { digitalWrite(LOCK_PIN, HIGH); unlocked = false; }
static void unlock_for(unsigned long ms) {
  digitalWrite(LOCK_PIN, LOW); unlocked = true; relock_at = millis() + ms;
  GATE_PORT.print("ACK:UNLOCK:"); GATE_PORT.println(ms);
}
static void beep(int freq, int ms) { tone(BUZZER_PIN, freq, ms); }

void setup() {
  pinMode(LOCK_PIN, OUTPUT); lock_now();
  pinMode(EXIT_BTN_PIN, INPUT_PULLUP);
  GATE_PORT.begin(115200);
  GATE_PORT.print("READY:fw="); GATE_PORT.println(FW_VERSION);
}

void loop() {
  if (unlocked && (long)(millis() - relock_at) >= 0) { lock_now(); GATE_PORT.println("ACK:RELOCK"); }

  // Physical exit button: debounced, active-LOW (pulled HIGH normally)
  if (digitalRead(EXIT_BTN_PIN) == LOW) {
    unsigned long now = millis();
    if (now - lastExitBtnMs >= EXIT_BTN_DEBOUNCE_MS) {
      lastExitBtnMs = now;
      GATE_PORT.println("EVT:EXIT_BTN");
      beep(1500, 150);
      unlock_for(3000);
    }
  }

  if (!GATE_PORT.available()) return;
  String cmd = GATE_PORT.readStringUntil('\n'); cmd.trim();
  String up = cmd; up.toUpperCase();
  if (up == "PING") { GATE_PORT.println("ACK:PONG"); }
  else if (up == "STATUS") { GATE_PORT.print("ACK:STATUS:"); GATE_PORT.println(unlocked ? "UNLOCKED" : "LOCKED"); }
  else if (up == "VERSION") { GATE_PORT.print("ACK:VERSION:"); GATE_PORT.println(FW_VERSION); }
  else if (up.startsWith("WELCOME:")) { // WELCOME:<name>|<secs>
    int bar = cmd.indexOf('|'); long secs = bar > 0 ? cmd.substring(bar + 1).toInt() : 3;
    if (secs <= 0) secs = 3; beep(2000, 150); unlock_for(secs * 1000L);
  }
  else if (up.startsWith("BYE:")) { // kept for compat; v3 gate-IN only
    int bar = cmd.indexOf('|'); long secs = bar > 0 ? cmd.substring(bar + 1).toInt() : 3;
    if (secs <= 0) secs = 3; beep(1500, 150); unlock_for(secs * 1000L);
  }
  else if (up.startsWith("UNLOCK")) { // UNLOCK or UNLOCK:<secs|ms>
    long v = cmd.indexOf(':') > 0 ? cmd.substring(cmd.indexOf(':') + 1).toInt() : 5;
    if (v <= 0) v = 5; if (v > 30) v = 30; // cap 30s (orig accepted s or ms)
    beep(2000, 150); unlock_for(v * 1000L);
  }
  else if (up == "LOCK") { lock_now(); GATE_PORT.println("ACK:LOCK"); }
  else if (up.startsWith("DENY")) { beep(400, 150); delay(200); beep(400, 150); GATE_PORT.println("ACK:DENY"); }
  else if (up == "BEEP") { beep(2000, 150); GATE_PORT.println("ACK:BEEP"); }
  else if (up == "BEEP_LONG") { beep(2000, 2000); GATE_PORT.println("ACK:BEEP_LONG"); }
}
