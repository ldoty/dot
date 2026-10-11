// WiFi credentials, where telemetry goes, and the device key.
//
// Copy to arduino_secrets.h (gitignored) and fill in before flashing.
// Never commit the real file.

#define SECRET_SSID "YOUR_WIFI_SSID"
#define SECRET_PASS "YOUR_WIFI_PASSWORD"

// The chamber tool's API (tofu output api_url, without https://). HTTPS only.
#define COLLECTOR_HOST "xxxxxxxxxx.execute-api.us-east-1.amazonaws.com"
#define COLLECTOR_PORT 443

// Must match the SecureString /family/chamber/device-key (see infra/ingest.tf)
#define DEVICE_KEY "YOUR_DEVICE_KEY"
