// atomizer_output - measure the atomizer's water output rate
//
// Weigh the reservoir, run a fixed pattern of mist bursts, weigh again.
// 1 g = 1 mL.
//
//   mL per minute of ON time = (start_g - end_g) / (on_seconds / 60)
//
// That per-minute-of-on-time number is what MIST_ML_PER_MIN in
// chamber_telemetry means, and the volume budget and duty ceiling are only
// as good as it is.
//
// Rewritten 2026-09-27 from the original continuous 10-minute run:
//
//   - BURSTS, not continuous. The atomizer is wick-fed. A continuous run can
//     outpace the wick, which both under-measures (the disc runs on a drying
//     wick) and risks the disc running dry. The chamber only ever runs it in
//     bursts, so measure the rate it can sustain in bursts. The default
//     pattern matches the settings in use when this was written: 60s on,
//     100s off.
//   - STARTS ON COMMAND, over serial. The old sketch started at boot, which
//     left no time to weigh first and fired while the board was on USB only
//     (no 12V, no fog). Send 's' to start, 'x' to abort.
//   - HOLDS THE FAN OFF. A 4-wire fan with an undriven PWM line runs at
//     100%; the old sketch never touched D3. The light is held off too.
//   - REPORTS EXACT ON-TIME, measured with millis(), so the division uses
//     what actually happened rather than what was configured.
//
// Measure under the real build conditions: the real reservoir and wick, the
// 12V supply and buck (not Dupont jumpers), and enough water that it cannot
// run dry inside the test.

#include "pwm.h"

const int ATOMIZER_PIN = 10;
const int FAN_PWM_PIN = 3;
const int LIGHT_PWM_PIN = 9;

// Pattern. 12 x 60s = 12 min of on-time, ~32 min total: enough loss (~15-20 g
// at the placeholder 1.5 mL/min) to read on a 1 g kitchen scale to ~5-7%.
const unsigned long BURST_MS = 60UL * 1000UL;
const unsigned long REST_MS = 100UL * 1000UL;
const int BURSTS = 12;

const unsigned long STATUS_MS = 10000;

PwmOut fanPwm(FAN_PWM_PIN);

enum Phase { WAITING, BURST, REST, DONE };
Phase phase = WAITING;
int burstNum = 0;
unsigned long phaseAt = 0, onStartedAt = 0, onMsTotal = 0, lastStatusAt = 0;
unsigned long testStartedAt = 0;

void atomizer(bool on) {
  digitalWrite(ATOMIZER_PIN, on ? HIGH : LOW);
  if (on) {
    onStartedAt = millis();
  } else if (onStartedAt != 0) {
    onMsTotal += millis() - onStartedAt;
    onStartedAt = 0;
  }
}

void printOnTime() {
  unsigned long ms = onMsTotal + (onStartedAt ? millis() - onStartedAt : 0);
  Serial.print("on_time_s=");
  Serial.print(ms / 1000);
  Serial.print(".");
  Serial.print((ms % 1000) / 100);
}

void finish(const char *why) {
  atomizer(false);
  phase = DONE;
  Serial.print("=== ");
  Serial.print(why);
  Serial.print(": ");
  Serial.print(burstNum);
  Serial.print(" bursts, ");
  printOnTime();
  Serial.println(" ===");
  Serial.println("Weigh the reservoir again now. mL/min of on-time = grams lost / (on_time_s / 60)");
}

void setup() {
  // Everything off before anything else can run.
  digitalWrite(ATOMIZER_PIN, LOW);
  pinMode(ATOMIZER_PIN, OUTPUT);
  digitalWrite(ATOMIZER_PIN, LOW);
  digitalWrite(LIGHT_PWM_PIN, LOW);
  pinMode(LIGHT_PWM_PIN, OUTPUT);
  digitalWrite(LIGHT_PWM_PIN, LOW);
  fanPwm.begin(25000.0f, 0.0f);  // driven at 0%, so the fan is genuinely off

  Serial.begin(115200);
  unsigned long waitStart = millis();
  while (!Serial && millis() - waitStart < 3000) delay(10);

  Serial.println();
  Serial.println("=== atomizer output test (bursts) ===");
  Serial.print("pattern: ");
  Serial.print(BURSTS);
  Serial.print(" x ");
  Serial.print(BURST_MS / 1000);
  Serial.print("s on / ");
  Serial.print(REST_MS / 1000);
  Serial.println("s off. Fan and light held off.");
  Serial.println("Weigh the reservoir, then send 's' to start ('x' aborts).");
}

void loop() {
  unsigned long now = millis();

  while (Serial.available()) {
    char c = Serial.read();
    if (c == 's' && phase == WAITING) {
      burstNum = 1;
      phase = BURST;
      phaseAt = testStartedAt = lastStatusAt = now;
      atomizer(true);
      Serial.println("started: burst 1 ON");
    } else if (c == 'x' && phase != DONE) {
      finish("ABORTED");
    } else if (c == '?') {
      Serial.print("phase=");
      Serial.print(phase);
      Serial.print(" burst=");
      Serial.print(burstNum);
      Serial.print(" ");
      printOnTime();
      Serial.println();
    }
  }

  if (phase == BURST && now - phaseAt >= BURST_MS) {
    atomizer(false);
    if (burstNum >= BURSTS) {
      finish("DONE");
      return;
    }
    phase = REST;
    phaseAt = now;
    Serial.print("burst ");
    Serial.print(burstNum);
    Serial.println(" off, resting");
  } else if (phase == REST && now - phaseAt >= REST_MS) {
    burstNum++;
    phase = BURST;
    phaseAt = now;
    atomizer(true);
    Serial.print("burst ");
    Serial.print(burstNum);
    Serial.println(" ON");
  }

  if ((phase == BURST || phase == REST) && now - lastStatusAt >= STATUS_MS) {
    lastStatusAt = now;
    Serial.print("t=");
    Serial.print((now - testStartedAt) / 1000);
    Serial.print("s burst ");
    Serial.print(burstNum);
    Serial.print("/");
    Serial.print(BURSTS);
    Serial.print(phase == BURST ? " ON  " : " rest ");
    printOnTime();
    Serial.println();
  }
}
