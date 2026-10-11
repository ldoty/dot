// i2c_scan - find devices on both I2C buses of the UNO R4 WiFi
//
// The R4 WiFi has TWO separate I2C buses:
//   Wire  -> the A4/A5 header pins
//   Wire1 -> the Qwiic / STEMMA QT connector
//
// A Qwiic-connected sensor shows up on Wire1, NOT Wire. This sketch
// scans both so you know which bus to pass to the sensor library.
//
// Expected: SHT41 at 0x44.  (SCD41, when you add it, appears at 0x62.)

#include <Wire.h>

void scanBus(TwoWire &bus, const char *name) {
  Serial.print("Scanning ");
  Serial.print(name);
  Serial.println("...");

  int found = 0;
  for (uint8_t addr = 1; addr < 127; addr++) {
    bus.beginTransmission(addr);
    if (bus.endTransmission() == 0) {
      Serial.print("  device at 0x");
      if (addr < 16) Serial.print("0");
      Serial.println(addr, HEX);
      found++;
    }
  }

  if (found == 0) Serial.println("  (nothing found)");
  Serial.println();
}

void setup() {
  Serial.begin(115200);
  while (!Serial) delay(10);

  Wire.begin();
  Wire1.begin();

  Serial.println();
  Serial.println("=== I2C scan ===");
  Serial.println();
}

void loop() {
  scanBus(Wire,  "Wire  (A4/A5 pins)");
  scanBus(Wire1, "Wire1 (Qwiic connector)");
  Serial.println("---");
  delay(5000);
}
