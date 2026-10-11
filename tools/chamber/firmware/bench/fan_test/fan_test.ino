// fan_test - characterize the NF-A4x20 5V PWM fan: duty vs RPM
//
// Board:  Arduino UNO R4 WiFi
// Fan:    Noctua NF-A4x20 *5V* PWM (4-wire)
//
// Wiring (Noctua colors):
//   black  -> GND
//   yellow -> 5V        <-- the 5V pin. This is the 5V fan variant.
//   green  -> D2        tach, open-collector, needs INPUT_PULLUP
//   blue   -> D3        PWM in, 25 kHz
//
// A 4-wire PWM fan has its own switching electronics, so no MOSFET is
// needed here -- unlike the LED and atomizer channels.
//
// Arduino's analogWrite() runs at 490/980 Hz, which makes these fans buzz
// audibly. The Renesas core's PwmOut class takes an explicit frequency, so
// we ask for 25 kHz directly (Intel 4-wire spec is 21-28 kHz).
//
// Output is CSV:  duty_pct,rpm
//
// What to look for:
//   - RPM should rise monotonically with duty
//   - note the lowest duty that still spins -- below that the fan stalls,
//     and a stalled fan during an FAE burst means no air exchange at all
//   - BUILD.md plans 60-80% duty bursts; confirm that's well clear of stall

#include "pwm.h"

const int FAN_TACH_PIN = 2;
const int FAN_PWM_PIN  = 3;

const float PWM_FREQ_HZ = 25000.0;

// Noctua tachs emit 2 pulses per revolution.
const int PULSES_PER_REV = 2;

// Let the fan reach steady state before trusting a reading. Spinning up
// from stopped is the slow direction, so this is deliberately generous.
const unsigned long SETTLE_MS = 6000;
const unsigned long COUNT_MS  = 3000;

PwmOut fanPwm(FAN_PWM_PIN);

volatile unsigned long tachPulses = 0;

void tachISR() {
  tachPulses++;
}

// Drive the fan at `duty` percent, let it settle, then count tach pulses
// over a fixed window and convert to RPM.
long measureRpm(int duty) {
  fanPwm.pulse_perc((float)duty);
  delay(SETTLE_MS);

  noInterrupts();
  tachPulses = 0;
  interrupts();

  delay(COUNT_MS);

  noInterrupts();
  unsigned long pulses = tachPulses;
  interrupts();

  // pulses over COUNT_MS -> revs per minute
  return (long)((pulses * 60000.0) / (PULSES_PER_REV * (float)COUNT_MS));
}

void setup() {
  Serial.begin(115200);
  while (!Serial) delay(10);

  pinMode(FAN_TACH_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(FAN_TACH_PIN), tachISR, FALLING);

  if (!fanPwm.begin(PWM_FREQ_HZ, 0.0)) {
    Serial.println("PwmOut.begin() failed on D3 -- not a PWM-capable pin?");
    while (1) delay(100);
  }

  Serial.println();
  Serial.println("=== fan sweep, 25 kHz ===");
  Serial.println("duty_pct,rpm");

  const int duties[] = {0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100};
  for (unsigned i = 0; i < sizeof(duties) / sizeof(duties[0]); i++) {
    long rpm = measureRpm(duties[i]);
    Serial.print(duties[i]);
    Serial.print(",");
    Serial.println(rpm);
  }

  Serial.println("=== sweep complete ===");

  // Park at a plausible FAE burst duty so the fan is audible/feelable
  // for a physical sanity check after the sweep.
  fanPwm.pulse_perc(70.0);
}

void loop() {
  delay(1000);
}
