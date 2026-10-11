// led_test - step the 12V COB LED strip through duty levels via a MOSFET
//
// Board:  Arduino UNO R4 WiFi
// Load:   12V COB strip, 6500K, ~9.6W/m  (0.8A per metre at 12V)
// Switch: IRLZ44N low-side, 150R gate series, 10k gate pulldown
//
// Wiring:
//   12V+  ------------------> LED strip +
//   LED strip -  -----------> MOSFET DRAIN  (tab)
//   MOSFET SOURCE ----------> ground bus  --- tied to Arduino GND at ONE point
//   D9 --- 150R ------------> MOSFET GATE
//   10k from GATE to SOURCE  (pulldown -- NOT optional, see BUILD.md)
//
// IRLZ44N pinout, facing the label with legs down: G, D, S.
//
// The pulldown is what holds the gate off while the Arduino boots or is
// unplugged. Without it the gate floats and the strip can come on by itself.
//
// PWM frequency: 1 kHz. Well above anything the eye sees, but low enough that
// the MOSFET's switching transition stays a negligible slice of each pulse.
// The 150R gate resistor needs ~1.5us to move the gate; at 1 kHz that's 0.15%
// of the period, at 20 kHz it would be 3% and would hurt low-duty linearity --
// which matters here because the useful range is at the BOTTOM of the scale.
//
// Target is ~200 lux (BUILD.md). A full 1m strip at 100% is ~11,000 lux, so
// expect to want single-digit duty with a full metre, or 10-20% with a
// 15-20cm segment. The segment is the better answer: same light, far more
// PWM resolution to control it with.
//
// Output is CSV:  duty_pct,seconds
// Measure lux at each step with a phone light-meter app (rough, but the
// difference between 200 and 2000 lux is not subtle).

#include "pwm.h"

const int LED_PWM_PIN = 9;

const float PWM_FREQ_HZ = 1000.0;

// Long enough to get a phone meter settled on each step.
const unsigned long DWELL_MS = 6000;

// Weighted toward the low end -- that's where the useful operating point is.
const float DUTIES[] = {0, 1, 2, 5, 10, 15, 20, 30, 50, 75, 100};

PwmOut led(LED_PWM_PIN);

void setup() {
  Serial.begin(115200);
  unsigned long startedAt = millis();
  while (!Serial && millis() - startedAt < 3000) delay(10);

  // Begin at 0% so the strip does not flash to full on reset.
  if (!led.begin(PWM_FREQ_HZ, 0.0)) {
    Serial.println("PwmOut.begin() failed on D9 -- not a PWM-capable pin?");
    while (1) delay(100);
  }

  Serial.println();
  Serial.println("=== LED duty sweep, 1 kHz ===");
  Serial.println("duty_pct,seconds");
}

void loop() {
  for (unsigned i = 0; i < sizeof(DUTIES) / sizeof(DUTIES[0]); i++) {
    led.pulse_perc(DUTIES[i]);

    Serial.print(DUTIES[i], 0);
    Serial.print(",");
    Serial.println(millis() / 1000);

    delay(DWELL_MS);
  }

  // Park dark between passes so the strip is not left driven if you walk away.
  led.pulse_perc(0.0);
  Serial.println("=== pass complete, dark for 10s ===");
  delay(10000);
}
