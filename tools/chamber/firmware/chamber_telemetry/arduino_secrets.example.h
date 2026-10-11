// WiFi credentials and collector address.
//
// Copy to arduino_secrets.h (gitignored) and fill in before flashing.
// Never commit the real file.

#define SECRET_SSID "YOUR_WIFI_SSID"
#define SECRET_PASS "YOUR_WIFI_PASSWORD"

// Where telemetry goes. Today: the Mac running env_control's collector.py
// (a DHCP address -- if telemetry silently stops, check this first).
// Moving to the chamber tool's /ingest on dot-y.co in build 14.
#define COLLECTOR_HOST "192.168.0.x"
#define COLLECTOR_PORT 8080
