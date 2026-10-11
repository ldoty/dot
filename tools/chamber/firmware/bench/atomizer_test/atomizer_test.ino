// atomizer_test - bring up the ultrasonic atomizer channel
//
// Board:  Arduino UNO R4 WiFi
// Load:   ultrasonic atomizer driver board (5V) + 108kHz disc
// Switch: IRLZ44N low-side on the driver's GROUND, 150R gate series,
//         10k gate pulldown
//
// Wiring:
//   buck 5V+ ---------------> driver V   (GVS connector)
//   driver G (GVS) ---------> MOSFET DRAIN
//   MOSFET SOURCE ----------> ground bus <-- buck 5V- <-- Arduino GND
//   D10 --- 150R -----------> MOSFET GATE
//   10k from GATE to SOURCE
//
// The driver's S pin stays UNCONNECTED. Wiring it to the Arduino while the
// driver's ground is switched would give current a sneak path through the
// Arduino's input protection diode, and the driver could half-run with the
// MOSFET off.
//
// On/off only, deliberately -- no PWM. The driver generates its own 108kHz
// drive; chopping its supply at kHz rates would just confuse its regulator.
//
// SAFETY: the wick must be wet before running this. Pulses are kept short
// and the duty low so that even a dry run can't do damage while you watch
// the first few cycles.

const int ATOMIZER_PIN = 10;

const unsigned long ON_MS = 5000;
const unsigned long OFF_MS = 15000;

// Stop after this many cycles so an unattended board can't mist forever.
const int MAX_CYCLES = 20;

int cycles = 0;

void setup() {
  Serial.begin(115200);
  unsigned long startedAt = millis();
  while (!Serial && millis() - startedAt < 3000) delay(10);

  // Drive it low BEFORE making it an output, so configuring the pin can't
  // produce even a momentary high.
  digitalWrite(ATOMIZER_PIN, LOW);
  pinMode(ATOMIZER_PIN, OUTPUT);
  digitalWrite(ATOMIZER_PIN, LOW);

  Serial.println();
  Serial.println("=== atomizer test ===");
  Serial.print("5s on / 15s off, stopping after ");
  Serial.print(MAX_CYCLES);
  Serial.println(" cycles. Wick must be wet.");
}

void loop() {
  if (cycles >= MAX_CYCLES) {
    digitalWrite(ATOMIZER_PIN, LOW);
    Serial.println("=== done, atomizer off ===");
    while (1) delay(1000);
  }

  cycles++;

  Serial.print(cycles);
  Serial.println(",on");
  digitalWrite(ATOMIZER_PIN, HIGH);
  delay(ON_MS);

  digitalWrite(ATOMIZER_PIN, LOW);
  Serial.print(cycles);
  Serial.println(",off");
  delay(OFF_MS);
}
