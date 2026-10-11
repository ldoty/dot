// sht41_test - read the SHT41 and log CSV to serial
//
// Board:  Arduino UNO R4 WiFi
// Wiring: SHT41 (Adafruit STEMMA QT) -> R4 WiFi Qwiic connector
// Library: "Adafruit SHT4x" (installs Adafruit BusIO + Unified Sensor)
//
// Output is CSV so you can paste it straight into a spreadsheet to get
// your chamber's baseline RH decay curve:
//
//   seconds,temp_c,rh_pct,dewpoint_c
//
// NOTE: the Qwiic connector is on Wire1, not Wire. If the sensor isn't
// found, run i2c_scan first to confirm which bus it's on.

#include "Adafruit_SHT4x.h"

Adafruit_SHT4x sht4 = Adafruit_SHT4x();

const unsigned long SAMPLE_INTERVAL_MS = 5000;

// Magnus formula. Condensation forms on any surface below this temp,
// which is what makes your chamber lid drip.
float dewPointC(float tempC, float rh) {
  const float a = 17.62, b = 243.12;
  float gamma = (a * tempC) / (b + tempC) + log(rh / 100.0);
  return (b * gamma) / (a - gamma);
}

void setup() {
  Serial.begin(115200);
  while (!Serial) delay(10);

  if (!sht4.begin(&Wire1)) {
    Serial.println("SHT41 not found on Wire1 (Qwiic). Check the cable, "
                   "then run i2c_scan.");
    while (1) delay(100);
  }

  sht4.setPrecision(SHT4X_HIGH_PRECISION);

  // No heater for normal logging. Once the chamber is running wet you'll
  // want to pulse this periodically to clear condensation off the die --
  // see the note in the walkthrough.
  sht4.setHeater(SHT4X_NO_HEATER);

  Serial.println("seconds,temp_c,rh_pct,dewpoint_c");
}

void loop() {
  sensors_event_t humidity, temp;
  sht4.getEvent(&humidity, &temp);

  float t  = temp.temperature;
  float rh = humidity.relative_humidity;

  Serial.print(millis() / 1000);
  Serial.print(",");
  Serial.print(t, 2);
  Serial.print(",");
  Serial.print(rh, 2);
  Serial.print(",");
  Serial.println(dewPointC(t, rh), 2);

  delay(SAMPLE_INTERVAL_MS);
}
