// SLS v3 single-gate ESP32 firmware.
// Recycled protocol subset from orig firmware v1.2.2 (`hardware/src/main.cpp`):
// kept WELCOME/BYE/UNLOCK/LOCK/DENY/BEEP/PING/STATUS/VERSION + ACK + auto-relock.
// Dropped for v3 single-cam: ALERT_TAILGATE/ALARM, LCD screens, IDLE/NVS brand,
// FINDRELAY/STOPRELAY diagnostics, watchdog (re-add with LCD + wdt when needed).
// Wiring: LOCK_PIN=GPIO3 active-LOW relay (COM/NO maglock), buzzer GPIO10, 115200 baud.
#include <Arduino.h>
#ifndef LOCK_PIN
#define LOCK_PIN 3
#endif
#ifndef BUZZER_PIN
#define BUZZER_PIN 10
#endif
static const char* FW_VERSION = "3.0.0";
static bool unlocked = false;
static unsigned long relock_at = 0;

static void lock_now() { digitalWrite(LOCK_PIN, HIGH); unlocked = false; }
static void unlock_for(unsigned long ms) {
  digitalWrite(LOCK_PIN, LOW); unlocked = true; relock_at = millis() + ms;
  Serial.print("ACK:UNLOCK:"); Serial.println(ms);
}
static void beep(int freq, int ms) { tone(BUZZER_PIN, freq, ms); }

void setup() {
  pinMode(LOCK_PIN, OUTPUT); lock_now();
  Serial.begin(115200);
  Serial.print("READY:fw="); Serial.println(FW_VERSION);
}

void loop() {
  if (unlocked && (long)(millis() - relock_at) >= 0) { lock_now(); Serial.println("ACK:RELOCK"); }
  if (!Serial.available()) return;
  String cmd = Serial.readStringUntil('\n'); cmd.trim();
  String up = cmd; up.toUpperCase();
  if (up == "PING") { Serial.println("ACK:PONG"); }
  else if (up == "STATUS") { Serial.print("ACK:STATUS:"); Serial.println(unlocked ? "UNLOCKED" : "LOCKED"); }
  else if (up == "VERSION") { Serial.print("ACK:VERSION:"); Serial.println(FW_VERSION); }
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
  else if (up == "LOCK") { lock_now(); Serial.println("ACK:LOCK"); }
  else if (up.startsWith("DENY")) { beep(400, 150); delay(200); beep(400, 150); Serial.println("ACK:DENY"); }
  else if (up == "BEEP") { beep(2000, 150); Serial.println("ACK:BEEP"); }
  else if (up == "BEEP_LONG") { beep(2000, 2000); Serial.println("ACK:BEEP_LONG"); }
}
