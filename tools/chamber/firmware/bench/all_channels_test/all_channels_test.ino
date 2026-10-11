// all_channels_test - post-assembly smoke test of every channel
//
// Run this after transferring from breadboard to the proto shield. It walks
// each subsystem in turn and reports what it sees, so a bad solder joint
// shows up as one failed channel rather than a mysteriously misbehaving
// chamber later.
//
// Order is deliberate: sensor first (proves I2C), then fan (the only channel
// with feedback, so it self-verifies), then light (visual), then atomizer
// (visual, and the one that needs water present).
//
// BEFORE RUNNING: the atomizer fires for 5 seconds near the end. Make sure
// the wick is wet, or set TEST_ATOMIZER to false.

#include "Adafruit_SHT4x.h"
#include "pwm.h"

const int FAN_PWM_PIN = 3;
const int FAN_TACH_PIN = 2;
const int LIGHT_PWM_PIN = 9;
const int ATOMIZER_PIN = 10;

const int FAN_PULSES_PER_REV = 2;
const float FAN_PWM_FREQ_HZ = 25000.0;
const float LIGHT_PWM_FREQ_HZ = 1000.0;

const bool TEST_ATOMIZER = true;
const unsigned long ATOMIZER_ON_MS = 5000;

// Expected RPM from the commissioning sweep (unloaded). A filter fitted will
// read somewhat HIGHER, not lower -- a restricted axial fan unloads.
const long EXPECTED_RPM_50 = 2860;
const long EXPECTED_RPM_100 = 4980;

Adafruit_SHT4x sht4 = Adafruit_SHT4x();
PwmOut fanPwm(FAN_PWM_PIN);
PwmOut lightPwm(LIGHT_PWM_PIN);

volatile unsigned long tachPulses = 0;

void tachISR() {
  tachPulses++;
}

long measureRpm(unsigned long windowMs) {
  noInterrupts();
  tachPulses = 0;
  interrupts();

  delay(windowMs);

  noInterrupts();
  unsigned long pulses = tachPulses;
  interrupts();

  return (long)((pulses * 60000.0) / (FAN_PULSES_PER_REV * (float)windowMs));
}

void banner(const char *s) {
  Serial.println();
  Serial.print("--- ");
  Serial.println(s);
}

void setup() {
  Serial.begin(115200);
  unsigned long waitStart = millis();
  while (!Serial && millis() - waitStart < 3000) delay(10);

  // Everything to a safe state before anything else happens.
  digitalWrite(ATOMIZER_PIN, LOW);
  pinMode(ATOMIZER_PIN, OUTPUT);
  digitalWrite(ATOMIZER_PIN, LOW);

  pinMode(FAN_TACH_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(FAN_TACH_PIN), tachISR, FALLING);

  Serial.println();
  Serial.println("=== all channels test ===");

  // ---- 1. Sensor / I2C ----
  banner("1. SHT41 on Wire1");
  if (!sht4.begin(&Wire1)) {
    Serial.println("FAIL: SHT41 not found. Check the Qwiic cable and run i2c_scan.");
  } else {
    sht4.setPrecision(SHT4X_HIGH_PRECISION);
    sht4.setHeater(SHT4X_NO_HEATER);
    sensors_event_t humidity, temp;
    sht4.getEvent(&humidity, &temp);
    Serial.print("PASS: temp_c=");
    Serial.print(temp.temperature, 2);
    Serial.print(" rh_pct=");
    Serial.println(humidity.relative_humidity, 2);
  }

  // ---- 2. Fan + tach ----
  banner("2. fan PWM + tach");
  if (!fanPwm.begin(FAN_PWM_FREQ_HZ, 0.0)) {
    Serial.println("FAIL: PwmOut.begin() on fan pin");
  } else {
    delay(3000);
    Serial.print("0%   rpm=");
    Serial.println(measureRpm(3000));

    fanPwm.pulse_perc(50.0);
    delay(6000);
    long rpm50 = measureRpm(3000);
    Serial.print("50%  rpm=");
    Serial.print(rpm50);
    Serial.print("  (commissioned ~");
    Serial.print(EXPECTED_RPM_50);
    Serial.println(")");

    fanPwm.pulse_perc(100.0);
    delay(6000);
    long rpm100 = measureRpm(3000);
    Serial.print("100% rpm=");
    Serial.print(rpm100);
    Serial.print("  (commissioned ~");
    Serial.print(EXPECTED_RPM_100);
    Serial.println(")");

    fanPwm.pulse_perc(0.0);

    if (rpm100 == 0) {
      Serial.println("NOTE: 0 rpm at full duty -- tach wire, or fan not spinning.");
    } else if (rpm50 == 0 && rpm100 > 0) {
      Serial.println("NOTE: no reading at 50% but fine at 100% -- suspect PWM wiring.");
    }
  }

  // ---- 3. Light ----
  banner("3. light channel (visual)");
  if (!lightPwm.begin(LIGHT_PWM_FREQ_HZ, 0.0)) {
    Serial.println("FAIL: PwmOut.begin() on light pin");
  } else {
    Serial.println("off 3s -- strip should be DARK");
    delay(3000);
    Serial.println("25% 5s -- strip should be dimly lit");
    lightPwm.pulse_perc(25.0);
    delay(5000);
    Serial.println("100% 3s -- strip should be bright");
    lightPwm.pulse_perc(100.0);
    delay(3000);
    lightPwm.pulse_perc(0.0);
    Serial.println("off -- strip should be DARK again");
    delay(2000);
  }

  // ---- 4. Atomizer ----
  banner("4. atomizer channel (visual)");
  if (!TEST_ATOMIZER) {
    Serial.println("SKIPPED (TEST_ATOMIZER = false)");
  } else {
    Serial.println("on 5s -- expect fog. Wick must be wet.");
    digitalWrite(ATOMIZER_PIN, HIGH);
    delay(ATOMIZER_ON_MS);
    digitalWrite(ATOMIZER_PIN, LOW);
    Serial.println("off -- fog should stop COMPLETELY, not just weaken.");
  }

  banner("done -- all outputs off");
}

void loop() {
  delay(1000);
}
