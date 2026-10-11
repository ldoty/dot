// chamber_telemetry - read the SHT41 and POST readings to the Mac collector
//
// Board:  Arduino UNO R4 WiFi
// Wiring: SHT41 (STEMMA QT) -> Qwiic connector (Wire1)
// Pair with: collector/collector.py running on the Mac
//
// Fill in arduino_secrets.h before flashing.
//
// Design rules, from BUILD.md "Telemetry":
//   - Control logic never depends on the network. Telemetry is
//     fire-and-forget: a failed POST is dropped, never retried, never
//     queued. If WiFi dies the chamber must keep working.
//   - No blocking waits in loop(). Everything is millis()-scheduled.
//   - No device timestamps. The collector stamps on receipt; the R4's RTC
//     loses time across power cycles without a backup battery.
//   - Line protocol, not JSON. String concat is far cheaper on 32KB RAM.
//
// Actuators under automated control: light (12h schedule), fan (FAE bursts),
// atomizer (RH band with software interlocks). All three are driven from
// millis()-scheduled state, and all three report their state in the payload
// -- otherwise you can see that RH dropped but not whether anything was
// trying to do something about it.

#include <WiFiS3.h>
#include <WDT.h>

#include "Adafruit_SHT4x.h"
#include "arduino_secrets.h"
#include "pwm.h"

Adafruit_SHT4x sht4 = Adafruit_SHT4x();

// Bump on every flash. Published as fw_build so each CSV row says which
// firmware produced it -- 2026-09-27 saw six flashes in one afternoon.
const int FW_BUILD = 14;

// The fan is wired but has no control logic yet. It still has to be driven:
// a 4-wire fan with an UNDRIVEN PWM line runs at 100%, not off. Leaving D3
// alone would put a fan at full tilt inside the sealed tote and destroy the
// passive baseline we're trying to measure. So hold it explicitly at 0%.
const int FAN_PWM_PIN = 3;
const float FAN_PWM_FREQ_HZ = 25000.0;

// Bench override for the fan. Set >= 0 to pin the fan at a fixed duty and
// disable FAE bursts entirely -- that is what the airflow-through-polyfill
// test wanted (70% measured ~3950 RPM loaded vs 3760 unloaded; the filter
// restricts flow, so the fan unloads and speeds UP).
//
// Set to -1.0 for normal operation, where the climate state machine owns the
// fan. This replaces the old constant-on FAN_DUTY_PCT, which was a standing
// hazard: left at 100 it silently invalidated any passive measurement.
const float FAN_FORCE_DUTY_PCT = -1.0;

// Tach feedback. The commanded duty only proves the timer accepted a config;
// the tach proves the fan is actually turning. Noctua emits 2 pulses/rev.
// Expect ~3760 RPM at 70% duty, unloaded (see BUILD.md commissioning data).
const int FAN_TACH_PIN = 2;
const int FAN_PULSES_PER_REV = 2;

PwmOut fanPwm(FAN_PWM_PIN);

// Light channel: IRLZ44N low-side switching the 12V COB strip.
//
// 1 kHz, not the fan's 25 kHz -- a lower frequency keeps the MOSFET's
// switching transition a negligible slice of each pulse, which matters
// because the useful duty range here is at the bottom of the scale.
//
// D3 is on GPT channel 1 and D9 on channel 7, so the two PwmOut instances
// drive independent timers and don't fight over frequency.
const int LIGHT_PWM_PIN = 9;
const float LIGHT_PWM_FREQ_HZ = 1000.0;

// 25% measured about right by eye through the lid on the full uncut strip.
// If the strip is later cut to lid length, this needs to roughly double.
float LIGHT_ON_DUTY_PCT = 25.0;

// Colonization runs dark; fruiting runs 12h (BUILD.md two-mode table).
// Flip this to false to suppress the light without touching wiring.
bool LIGHT_ENABLED = true;

// Wall-clock schedule, local time. Used once the collector has told us what
// time it is; see readTimeSync().
int LIGHT_ON_HOUR  = 6;   // 06:00
int LIGHT_OFF_HOUR = 18;  // 18:00

// Fallback cycle used before the first time sync, or if the collector is
// never reachable. Control must not depend on the network, so the light
// still runs 12h on / 12h off from boot -- just not aligned to the clock.
const unsigned long LIGHT_ON_MS  = 12UL * 60UL * 60UL * 1000UL;
const unsigned long LIGHT_OFF_MS = 12UL * 60UL * 60UL * 1000UL;

PwmOut lightPwm(LIGHT_PWM_PIN);

// ---------------------------------------------------------------------------
// Climate control: FAE + humidity
// ---------------------------------------------------------------------------
//
// One state machine owns both the fan and the atomizer, because BUILD.md's
// sequencing rule is that they must never run at once -- venting and misting
// directly oppose each other. Vent first, then mist to recover.
//
//   IDLE -> VENT -> VENT_SETTLE -> IDLE
//   IDLE -> MIST -> MIST_SETTLE -> IDLE
//
// The SETTLE states are the load-bearing part and the reason this is not just
// "mist until RH hits target". The atomizer emits suspended droplets, not
// vapour: RH keeps climbing for a minute or more AFTER the atomizer stops, as
// those droplets evaporate. Stopping the instant the sensor reads target
// overshoots into condensation on the lid, which drips on the block and
// causes bacterial blotch. So: bounded burst, then wait, then re-read.

enum Mode {
  MODE_COLONIZATION,  // fan off, light off, no misting -- high CO2 is desired
  MODE_FRUITING,      // full climate control
};

const Mode MODE = MODE_FRUITING;

// Atomizer: on/off only. Never PWM the driver's supply -- it generates its
// own 108 kHz and chopping the rail just makes it misbehave.
const int ATOMIZER_PIN = 10;

// RH hysteresis band, inside the 85-95% target from BUILD.md "Setpoints".
// Stop at 92 rather than 95 deliberately: post-burst rise eats the rest.
// 87, not 85: RH dips a few points after every burst and vent, so triggering
// at the band floor let true RH sag just under it. The margin keeps it in.
float RH_MIST_ON_PCT = 87.0;
float RH_MIST_OFF_PCT = 92.0;

// ---------------------------------------------------------------------------
// RUNTIME SETTINGS. The ALL_CAPS values marked as settings below (RH band,
// FAE, rest fan, mist burst/settle, heater cadence, light) are the FIRMWARE
// DEFAULTS, and may be overridden while running from the collector's settings
// panel -- see applySettings(). Every override is range-checked here on the
// board, so a bad value from the network cannot command anything unsafe.
// The guards (duty ceiling, volume budget, dry-run check) are deliberately
// NOT settable: they are the protection against a bad setting.
// ---------------------------------------------------------------------------

// FAE schedule -- roughly 4-8 air changes/hour. This is a GUESS until the
// SCD41 lands and we can tune it against a real CO2 decay curve. Shorten
// FAE_PERIOD_MS to a couple of minutes if you want to watch it cycle on the
// bench rather than waiting 40 minutes for the first vent.
//
// 2026-09-27: with the tote sealed down to one polyfill exhaust, a 90s vent
// replaced only ~6% of the air (dewpoint tracer) and cost ~1.7% RH, which
// recovered in one mist cycle. Exchange is outlet-limited, so vent longer
// and more often; humidity can afford it. Burst capped at 3 min because
// long drafts dry pins. Re-tune once the exhaust flap valve is fitted.
// Period is measured from the END of one vent, so vents start every ~18-21
// min in practice.
// Build 14 (2026-10-11): defaults = settings v19, tuned live on the 24V atomizer
// with FAE routed through the reservoir bin. The cloud starts with no saved
// settings, so these are what the board runs until the page saves some.
unsigned long FAE_PERIOD_MS = 10UL * 60UL * 1000UL;
unsigned long FAE_BURST_MS = 200UL * 1000UL;
float FAE_FAN_DUTY_PCT = 70.0;

// EXPERIMENT (2026-09-27): fan held at a low speed in every fruiting state
// except VENT, instead of off. The hypothesis is that it limits
// leakage through the idle fan port; the expectation from the airflow design
// is that it acts as a slow continuous vent instead. The data will say.
// Set to 0.0 to restore fan-off between vents.
//
// 10% is the lowest commissioned duty (~450 RPM unloaded, BUILD.md "Fan:
// duty vs RPM"). Tried 2026-09-27: 5% stalls (0-6 RPM on 12V); 10% runs at
// ~320-420 RPM in the chamber and appeared to cap RH near 84%; 7.5% also
// stalls (0 RPM). So the working floor is 10%. Tune live from the settings
// panel; 0 = fan off between vents.
// 20% from build 14 (settings v19): with FAE through the reservoir bin the
// rest fan carries fog into the chamber as assist air.
float FAN_REST_DUTY_PCT = 20.0;

// Whether the rest speed also applies during MIST. A running fan pushes
// chamber air out the exhaust, fog included. Set false to stop the fan for
// the 30s burst if bursts come out weaker than the fan-off baseline.
bool FAN_REST_DURING_MIST = true;

// Let the air mix and the sensor catch up before trusting a reading again.
unsigned long VENT_SETTLE_MS = 60UL * 1000UL;

// A single mist burst is bounded. This is what replaces "run until 92%":
// every failure mode -- empty reservoir, wet sensor, lid off, MOSFET stuck
// on -- turns an unbounded wait into misting forever.
// 45s from 2026-09-27 build 9 (was 30): with the rest fan running, bursts
// starting near 83% barely moved RH. Longer bursts risk outrunning the wick,
// which is why the 92% cutoff and the dry-run check stay in force.
// 20s from build 11 (2026-10-11): new 24V 1A (24W) atomizer, likely several
// times the old 5V module's output. Start short so one burst cannot blow
// through the band and wet the sensor; lengthen from the settings panel.
// 60s from build 14 (settings v19): run live on the 24V unit with no overshoot
// past the band and no condensation. 60s is also the firmware's hard cap.
unsigned long MIST_BURST_MAX_MS = 60UL * 1000UL;
// 150s, not 90: the atomizer is wick-fed, and back-to-back 30/90 cycles (25%
// duty) looked like they outran the wick's refill (2026-09-27). A longer
// settle gives the wick time to re-wet and gives the dry-run check a longer
// window to catch the peak. Duty is now 30/180 = 17%.
// 100s from build 14 (settings v19): the 24V atomizer is float-fed, not
// wick-fed, so there is no wick to re-wet.
unsigned long MIST_SETTLE_MS = 100UL * 1000UL;

// ---- Guards (BUILD.md "No float switch -- software interlock instead") ----

// PLACEHOLDER. Measure this for real with the `atomizer_output` sketch --
// weigh the reservoir, run 10 min, weigh again -- and put the true number
// here. Until then the volume budget is a guess and the no-response check
// below is doing the actual dry-run protection.
//
// 8.0 from build 11 (2026-10-11): deliberately HIGH guess for the new 24W
// atomizer. Overestimating makes the budget trip early (safe: a nuisance
// stop); underestimating lets the reservoir run dry before it trips.
const float MIST_ML_PER_MIN = 8.0;
const float RESERVOIR_ML = 500.0;

// Rate limit, so a slow leak of duty cannot drain the reservoir unnoticed
// even while every individual burst looks reasonable.
const float MIST_DUTY_CEILING_PCT = 15.0;
const unsigned long MIST_DUTY_WINDOW_MS = 60UL * 60UL * 1000UL;

// Dry-run detector: an atomizer firing into an empty reservoir makes no fog,
// so it produces no RH rise. Bursts shorter than this are not judged, since
// a burst cut short by another guard proves nothing either way.
// Judged on the PEAK RH across burst + settle, not the settled value; see
// CLIMATE_MIST_SETTLE for why.
const float MIST_RESPONSE_MIN_RH = 0.5;
const int MIST_NO_RESPONSE_LIMIT = 3;

// What a dry-run trip does. RH is an indirect signal and has false-tripped
// on a working channel (lid opened, plume missing the sensor), so a trip
// pauses misting for a cooldown and then tries again rather than latching
// straight away. An unattended false trip then costs half an hour of RH,
// not the rest of the night. A trip that keeps recurring is believed:
// after MIST_FAULT_COOLDOWNS cooldowns in a row with no good burst between,
// the next trip latches until power cycle.
//
// Worst case for a genuinely empty reservoir: 4 trips x 3 bursts = 12 dry
// 30s bursts spread over ~2h before the latch.
const unsigned long MIST_FAULT_COOLDOWN_MS = 30UL * 60UL * 1000UL;
const int MIST_FAULT_COOLDOWNS = 3;

// Hardware watchdog: resets the board if loop() stops running. 5s is under
// the RA4M1's ~5.59s ceiling, and above every bounded stall in the loop --
// which is why WIFI_CONNECT_TIMEOUT_MS below exists.
const uint32_t WATCHDOG_MS = 5000;
// STAGED OFF (2026-09-27) until every loop stall is confirmed < 5s -- the
// WiFiS3 modem layer can wait up to 10s on an unresponsive AT command.
// loop_max_ms in telemetry is the evidence for turning this on. Also needs
// the mist volume budget persisted first (a watchdog reset clears it).
const bool WATCHDOG_ENABLED = false;

// WiFi.begin() waits up to 10s for a connection by default, which would trip
// the watchdog on every reconnect attempt while the AP is down. The status
// keeps being checked each loop, so a slower connect is still picked up.
const unsigned long WIFI_CONNECT_TIMEOUT_MS = 3000;
const unsigned long MIST_RESPONSE_MIN_BURST_MS = 5000;

// A sensor with condensation on it reads pinned near 100% regardless of the
// actual air. That would mask a genuinely dry chamber, so treat a long pin
// as "do not trust", not as "humid enough".
const float WET_SENSOR_RH_PCT = 99.0;
const unsigned long WET_SENSOR_MS = 10UL * 60UL * 1000UL;

// BENCH OVERRIDE: pin the atomizer on and bypass the burst/settle cycle
// entirely. Set false for normal operation.
//
// Why this exists: the RH-response and duty guards are calibrated for a sealed
// 11L tote. On an open bench the fog disperses into the room, so a working
// atomizer produces only ~0.16% RH per burst -- well under the 0.5% the
// dry-run check demands -- and the channel latches off despite being fine.
// This lets you get an uninterrupted RH curve to prove the channel out.
//
// Still enforced, because neither depends on chamber geometry: the volume
// budget, and a hard runtime cap so this cannot run away if you walk off.
const bool MIST_FORCE_ON = false;
const unsigned long MIST_FORCE_MAX_MS = 10UL * 60UL * 1000UL;

enum ClimateState {
  CLIMATE_IDLE = 0,
  CLIMATE_VENT = 1,
  CLIMATE_VENT_SETTLE = 2,
  CLIMATE_MIST = 3,
  CLIMATE_MIST_SETTLE = 4,
};

// Why misting is currently not allowed. Published as an integer so it lands
// in the CSV as a plottable column rather than a string.
enum MistBlock {
  MIST_BLOCK_NONE = 0,
  MIST_BLOCK_BUDGET = 1,       // latched -- reservoir budget spent
  MIST_BLOCK_DUTY = 2,         // transient -- clears next window
  MIST_BLOCK_NO_RESPONSE = 3,  // latched -- misting produces no RH rise
  MIST_BLOCK_WET_SENSOR = 4,   // transient -- clears when RH falls
  MIST_BLOCK_NO_SENSOR = 5,    // transient -- no valid reading to act on
  MIST_BLOCK_MODE = 6,         // colonization mode
  MIST_BLOCK_FORCE_CAP = 7,    // bench force-on runtime cap reached
  MIST_BLOCK_COOLDOWN = 8,     // transient -- dry-run trip, retrying later
};

ClimateState climateState = CLIMATE_IDLE;
unsigned long climateStateAt = 0;
unsigned long lastVentAt = 0;

bool atomizerOn = false;
unsigned long mistBurstStartedAt = 0;
unsigned long lastBurstMs = 0;
float rhAtBurstStart = 0;
float rhPeakSinceBurst = 0;
int mistNoResponseCount = 0;
int mistFaultTrips = 0;
bool mistCoolingDown = false;
unsigned long mistCooldownStartedAt = 0;

unsigned long mistOnMsTotal = 0;
unsigned long mistOnMsWindow = 0;
unsigned long mistWindowStartedAt = 0;
unsigned long mistBursts = 0;

unsigned long mistForceTickAt = 0;
unsigned long mistForceElapsed = 0;

bool rhHighTracking = false;
unsigned long rhHighSinceMs = 0;

// Latched faults survive until a power cycle, on purpose: they mean something
// is physically wrong, and silently resuming would hide it.
MistBlock mistLatchedFault = MIST_BLOCK_NONE;
MistBlock mistBlock = MIST_BLOCK_NONE;

// SHT41 heater pulse (BUILD.md "SHT41 -- heater pulse + creep mitigation").
// At 85-92% RH with cold fog the die condenses (a wet SHT41 reads a flat
// 100%) and the polymer creeps high. A short heat burst drives both off.
//
// Datasheet hard limits: max 1s on-time per command, max 10% duty. 1s every
// 60s is 1.7%. Medium power (110 mW) rather than high: enough to clear a
// film of condensate without the longer cool-down high power needs.
//
// The heated die reads hot and dry, so RH AND temp are discarded for the
// pulse plus SHT_HEATER_RECOVER_MS -- otherwise the loop would mist on a
// heater-warmed reading. Control holds the last pre-pulse values meanwhile.
//
// 2026-09-27: a 10s recovery was far too short. Readings 20-40s after a pulse
// were still ~0.2C warm and 1.5-2% RH low, and because the 180s mist cycle is
// a multiple of the 60s pulse interval, every settle ended in that window and
// triggered a burst on a chamber actually holding 87%. Residual was visible
// out to ~60s, so hold 60s, and pulse every 5 min so the sensor is blind 20%
// of the time rather than always.
unsigned long SHT_HEATER_INTERVAL_MS = 5UL * 60UL * 1000UL;
const unsigned long SHT_HEATER_PULSE_MS = 1100;  // 1s heat + measurement
unsigned long SHT_HEATER_RECOVER_MS = 60000;

const unsigned long SAMPLE_INTERVAL_MS  = 1000;   // control cadence
// 10s, not 20: at 20s a 30s burst got one or two samples, which made the
// peak-vs-settled analysis guesswork.
const unsigned long PUBLISH_INTERVAL_MS = 10000;  // telemetry cadence
const unsigned long WIFI_RETRY_MS       = 30000;  // between reconnect tries
const unsigned long SENSOR_RETRY_MS     = 5000;   // between re-init tries

// Bounds how long a single POST can stall the loop. Fire-and-forget means
// we would rather drop a sample than hold up control logic.
// 3s from build 14: the connect now includes a TLS handshake to AWS.
const int HTTP_TIMEOUT_MS = 3000;

// How long we will wait for the collector's reply to read the time out of it.
// Deliberately short -- the reply is a bonus, not something control depends on.
// 1.5s from build 14 (was 300ms on the LAN): API Gateway + Lambda, which is
// slower again on a cold start. A late reply only costs that cycle's time and
// settings sync; sends never happen during a mist burst, so it cannot stretch one.
const unsigned long HTTP_READ_TIMEOUT_MS = 1500;

// Bounded so the board still runs headless on a USB brick with no Mac
// attached. An unbounded `while (!Serial)` would hang the whole chamber.
const unsigned long SERIAL_WAIT_MS = 3000;

float lastTempC = 0, lastRh = 0;
bool haveReading = false;
bool sensorOk = false;

// Heater pulse state. Driven with raw I2C commands rather than the library's
// setHeater() + getEvent(), which delay()s 1.1s inside the call -- a blocking
// stall that would stretch a mist burst past MIST_BURST_MAX_MS.
bool heaterPending = false;
unsigned long heaterStartedAt = 0;
unsigned long lastHeaterAt = 0;
unsigned long heaterPulses = 0;

// Commanded fan duty. Logged so a baseline run carries proof the fan was
// actually off, rather than us assuming it.
float fanDutyPct = 0.0;

// Tach pulse count, incremented from an ISR. Measured over each publish
// window rather than with a blocking count, so it costs the loop nothing.
volatile unsigned long tachPulses = 0;
unsigned long lastTachSampleAt = 0;
long fanRpm = 0;

// Commanded light duty.
float lightDutyPct = 0.0;

// Local time-of-day learned from the collector, plus the millis() reading
// when we learned it. Between syncs we extrapolate with millis(), so the
// schedule keeps running if the network goes away.
bool haveTime = false;
unsigned long timeOfDaySec = 0;
unsigned long timeSyncedAtMs = 0;
unsigned long timeSyncs = 0;

unsigned long lastSampleAt = 0, lastPublishAt = 0;
unsigned long lastWifiAttempt = 0, lastSensorAttempt = 0;

unsigned long sensorErrors = 0, wifiReconnects = 0, publishFailures = 0;

// Longest single loop() pass since the last publish. The evidence needed
// before enabling the watchdog: every pass must stay well under WATCHDOG_MS.
unsigned long loopMaxMs = 0;
unsigned long loopStartedAt = 0;

// Magnus formula. Condensation forms on any surface below this temp, which
// is what makes the chamber lid drip.
float dewPointC(float tempC, float rh) {
  const float a = 17.62, b = 243.12;
  float gamma = (a * tempC) / (b + tempC) + log(rh / 100.0);
  return (b * gamma) / (a - gamma);
}

// Two-decimal fixed point. Avoids depending on %f support in this core's
// snprintf, which is not guaranteed for floats.
void fmt2(char *out, size_t n, float v) {
  bool neg = v < 0;
  if (neg) v = -v;
  long scaled = lround(v * 100.0);
  snprintf(out, n, "%s%ld.%02ld", neg ? "-" : "", scaled / 100, scaled % 100);
}

bool initSensor() {
  if (!sht4.begin(&Wire1)) return false;
  sht4.setPrecision(SHT4X_HIGH_PRECISION);
  // Normal reads never heat. The periodic pulse is issued separately by
  // updateHeater(), non-blocking.
  sht4.setHeater(SHT4X_NO_HEATER);
  return true;
}

// Should the light be on right now?
//
// Prefers wall-clock scheduling once the collector has told us the local
// time, and falls back to a boot-relative cycle otherwise. The fallback is
// the important half: the chamber must keep cycling light even if the Mac is
// off, the network is down, or the collector was never started.
bool lightShouldBeOn(unsigned long now) {
  // Colonization runs dark (BUILD.md two-mode table), so the mode gates the
  // light as well as the fan and mist. LIGHT_ENABLED stays as an independent
  // override for suppressing the light without leaving fruiting mode.
  if (MODE != MODE_FRUITING) return false;
  if (!LIGHT_ENABLED) return false;

  if (haveTime) {
    // Read the clock fresh rather than using the caller's `now`. publish()
    // runs earlier in the same loop pass and can set timeSyncedAtMs to a
    // value LATER than `now` -- and with unsigned arithmetic that subtraction
    // underflows to ~4.29e9 instead of going negative, producing a garbage
    // time-of-day and a visible one-pass flash of the light every publish.
    unsigned long nowMs = millis();
    unsigned long elapsed =
        (nowMs > timeSyncedAtMs) ? (nowMs - timeSyncedAtMs) / 1000UL : 0UL;
    unsigned long tod = (timeOfDaySec + elapsed) % 86400UL;

    unsigned long on = (unsigned long)LIGHT_ON_HOUR * 3600UL;
    unsigned long off = (unsigned long)LIGHT_OFF_HOUR * 3600UL;

    if (on < off) return tod >= on && tod < off;
    return tod >= on || tod < off;  // schedule wraps past midnight
  }

  // Unsynced fallback: 12h on / 12h off measured from boot. Phase is
  // arbitrary, which is exactly what the time sync is here to fix.
  unsigned long cycle = LIGHT_ON_MS + LIGHT_OFF_MS;
  return (now % cycle) < LIGHT_ON_MS;
}

void updateLight(unsigned long now) {
  float want = lightShouldBeOn(now) ? LIGHT_ON_DUTY_PCT : 0.0;
  if (want == lightDutyPct) return;

  lightDutyPct = want;
  lightPwm.pulse_perc(lightDutyPct);

  Serial.print("# light: ");
  Serial.println(want > 0.0 ? "on" : "off");
}

// Read the collector's reply and pull the local time-of-day out of it.
//
// This piggybacks on the POST we were already making rather than adding a
// second request. Bounded by a short deadline: telemetry is still allowed to
// fail silently, and a slow collector must not stall the control loop.
// Settings version the board is running. 0 = firmware defaults. The
// collector numbers every saved change; the board applies a version once and
// reports what it is running, so the UI can show "applied" vs "pending".
long cfgVersion = 0;
long cfgRejectedVersion = 0;  // last version refused; not retried
unsigned long cfgRejects = 0;
bool cfgReportDue = true;  // send a chamber_cfg line with the next publish

// Parse and apply one "cfg=<ver>;key=val;key=val" line. All-or-nothing: the
// candidate values are checked as a set (e.g. rh_off must stay above rh_on)
// and a single bad key rejects the whole update, leaving the board as it was.
void applySettings(char *line) {
  char *save = nullptr;
  char *tok = strtok_r(line, ";", &save);
  if (!tok) return;
  long ver = atol(tok);
  if (ver <= 0 || ver == cfgVersion || ver == cfgRejectedVersion) return;

  float rhOn = RH_MIST_ON_PCT, rhOff = RH_MIST_OFF_PCT;
  unsigned long faePeriod = FAE_PERIOD_MS, vent = FAE_BURST_MS;
  float ventDuty = FAE_FAN_DUTY_PCT, restFan = FAN_REST_DUTY_PCT;
  bool restMist = FAN_REST_DURING_MIST;
  unsigned long ventSettle = VENT_SETTLE_MS, burst = MIST_BURST_MAX_MS;
  unsigned long settle = MIST_SETTLE_MS, htrInt = SHT_HEATER_INTERVAL_MS;
  unsigned long htrHold = SHT_HEATER_RECOVER_MS;
  int lOn = LIGHT_ON_HOUR, lOff = LIGHT_OFF_HOUR;
  float lDuty = LIGHT_ON_DUTY_PCT;
  bool lEn = LIGHT_ENABLED;
  bool ok = true;

  // Range check helpers: reject (not clamp) -- a silently clamped value
  // would make the UI and the board disagree about what is running.
  #define IN(v, lo, hi) ((v) >= (lo) && (v) <= (hi))
  while ((tok = strtok_r(nullptr, ";", &save)) != nullptr) {
    char *eq = strchr(tok, '=');
    if (!eq) { ok = false; break; }
    *eq = '\0';
    const char *k = tok;
    float v = atof(eq + 1);
    if      (!strcmp(k, "rh_on"))         { rhOn = v;        ok &= IN(v, 50, 94); }
    else if (!strcmp(k, "rh_off"))        { rhOff = v;       ok &= IN(v, 51, 95); }
    else if (!strcmp(k, "fae_period_s"))  { faePeriod = v * 1000UL; ok &= IN(v, 60, 7200); }
    else if (!strcmp(k, "vent_s"))        { vent = v * 1000UL;      ok &= IN(v, 10, 600); }
    else if (!strcmp(k, "vent_duty"))     { ventDuty = v;    ok &= IN(v, 20, 100); }
    else if (!strcmp(k, "vent_settle_s")) { ventSettle = v * 1000UL; ok &= IN(v, 0, 600); }
    else if (!strcmp(k, "rest_fan"))      { restFan = v;     ok &= IN(v, 0, 60); }
    else if (!strcmp(k, "rest_fan_mist")) { restMist = v != 0; }
    // 60s hard cap on a burst: the wick-fed disc must not run long dry.
    else if (!strcmp(k, "mist_burst_s"))  { burst = v * 1000UL;  ok &= IN(v, 5, 60); }
    else if (!strcmp(k, "mist_settle_s")) { settle = v * 1000UL; ok &= IN(v, 30, 900); }
    // Heater: >= 60s interval keeps a 1.1s pulse under 2% duty (limit 10%).
    else if (!strcmp(k, "heater_interval_s")) { htrInt = v * 1000UL; ok &= IN(v, 60, 3600); }
    else if (!strcmp(k, "heater_hold_s")) { htrHold = v * 1000UL; ok &= IN(v, 5, 300); }
    else if (!strcmp(k, "light_on_h"))    { lOn = (int)v;    ok &= IN(v, 0, 23); }
    else if (!strcmp(k, "light_off_h"))   { lOff = (int)v;   ok &= IN(v, 0, 23); }
    else if (!strcmp(k, "light_duty"))    { lDuty = v;       ok &= IN(v, 0, 100); }
    else if (!strcmp(k, "light_enabled")) { lEn = v != 0; }
    else ok = false;  // unknown key: newer collector than firmware
    if (!ok) break;
  }
  #undef IN
  ok &= rhOff > rhOn;
  ok &= htrHold < htrInt;

  if (!ok) {
    cfgRejects++;
    Serial.print("# settings: REJECTED version ");
    Serial.println(ver);
    cfgRejectedVersion = ver;  // keep running cfgVersion; report the refusal
    cfgReportDue = true;
    return;
  }

  RH_MIST_ON_PCT = rhOn;           RH_MIST_OFF_PCT = rhOff;
  FAE_PERIOD_MS = faePeriod;       FAE_BURST_MS = vent;
  FAE_FAN_DUTY_PCT = ventDuty;     FAN_REST_DUTY_PCT = restFan;
  FAN_REST_DURING_MIST = restMist; VENT_SETTLE_MS = ventSettle;
  MIST_BURST_MAX_MS = burst;       MIST_SETTLE_MS = settle;
  SHT_HEATER_INTERVAL_MS = htrInt; SHT_HEATER_RECOVER_MS = htrHold;
  LIGHT_ON_HOUR = lOn;             LIGHT_OFF_HOUR = lOff;
  LIGHT_ON_DUTY_PCT = lDuty;       LIGHT_ENABLED = lEn;
  cfgVersion = ver;
  cfgReportDue = true;
  Serial.print("# settings: applied version ");
  Serial.println(ver);
}

// The board's active settings as a line-protocol record, so the collector
// always knows what is really running -- including firmware defaults.
int formatSettings(char *out, size_t n) {
  char a[12], b[12], c[12], d[12], e[12];
  fmt2(a, sizeof(a), RH_MIST_ON_PCT);
  fmt2(b, sizeof(b), RH_MIST_OFF_PCT);
  fmt2(c, sizeof(c), FAE_FAN_DUTY_PCT);
  fmt2(d, sizeof(d), FAN_REST_DUTY_PCT);
  fmt2(e, sizeof(e), LIGHT_ON_DUTY_PCT);
  return snprintf(out, n,
      "chamber_cfg version=%ldi,rejected=%ldi,fw_build=%di,rh_on=%s,rh_off=%s,"
      "fae_period_s=%lui,vent_s=%lui,vent_duty=%s,vent_settle_s=%lui,"
      "rest_fan=%s,rest_fan_mist=%di,mist_burst_s=%lui,mist_settle_s=%lui,"
      "heater_interval_s=%lui,heater_hold_s=%lui,light_on_h=%di,"
      "light_off_h=%di,light_duty=%s,light_enabled=%di",
      cfgVersion, cfgRejectedVersion, FW_BUILD, a, b, FAE_PERIOD_MS / 1000UL, FAE_BURST_MS / 1000UL,
      c, VENT_SETTLE_MS / 1000UL, d, FAN_REST_DURING_MIST ? 1 : 0,
      MIST_BURST_MAX_MS / 1000UL, MIST_SETTLE_MS / 1000UL,
      SHT_HEATER_INTERVAL_MS / 1000UL, SHT_HEATER_RECOVER_MS / 1000UL,
      LIGHT_ON_HOUR, LIGHT_OFF_HOUR, e, LIGHT_ENABLED ? 1 : 0);
}

void readTimeSync(WiFiClient &client) {
  // Headers come first, then "time=...\n" and an optional "cfg=...\n".
  // static, not stack: the R4's main stack is nominally 1 KB
  // (BSP_CFG_STACK_MAIN_BYTES) and publish() already holds the payload.
  static char buf[768];
  size_t n = 0;
  unsigned long startedAt = millis();

  while (millis() - startedAt < HTTP_READ_TIMEOUT_MS && n < sizeof(buf) - 1) {
    while (client.available() && n < sizeof(buf) - 1) {
      buf[n++] = (char)client.read();
    }
    if (!client.connected() && !client.available()) break;
  }
  buf[n] = '\0';

  char *cfg = strstr(buf, "cfg=");
  if (cfg) {
    char *end = strpbrk(cfg, "\r\n");
    if (end) *end = '\0';
    applySettings(cfg + 4);
  }

  const char *p = strstr(buf, "time=");
  if (!p) return;

  long tod = atol(p + 5);
  if (tod < 0 || tod >= 86400) return;  // ignore anything implausible

  timeOfDaySec = (unsigned long)tod;
  timeSyncedAtMs = millis();
  timeSyncs++;

  if (!haveTime) {
    haveTime = true;
    Serial.print("# time: synced, local time-of-day ");
    Serial.print(tod / 3600);
    Serial.print("h");
    Serial.println((tod % 3600) / 60);
  }
}

// True during a heater pulse and its cool-down, when readings are wrong.
bool sensorBlanked(unsigned long now) {
  return heaterStartedAt != 0 &&
         now - heaterStartedAt < SHT_HEATER_PULSE_MS + SHT_HEATER_RECOVER_MS;
}

void updateHeater(unsigned long now) {
  // Collect (and discard) the hot measurement the heater command ends with,
  // so the sensor is idle and ready for the next ordinary read.
  if (heaterPending && now - heaterStartedAt >= SHT_HEATER_PULSE_MS) {
    Wire1.requestFrom(SHT4x_DEFAULT_ADDR, 6);
    while (Wire1.available()) Wire1.read();
    heaterPending = false;
  }

  if (!sensorOk || heaterPending) return;
  if (now - lastHeaterAt < SHT_HEATER_INTERVAL_MS) return;

  // Pulse only while IDLE. MIST needs live RH for the RH_MIST_OFF_PCT cutoff,
  // and MIST_SETTLE is when the post-burst peak happens -- the dry-run check
  // needs to see it. If back-to-back misting leaves no IDLE for a whole extra
  // interval, pulse anyway outside MIST so creep mitigation cannot starve.
  if (climateState == CLIMATE_MIST) return;
  bool overdue = now - lastHeaterAt >= 2 * SHT_HEATER_INTERVAL_MS;
  if (climateState != CLIMATE_IDLE && !overdue) return;

  lastHeaterAt = now;
  Wire1.beginTransmission(SHT4x_DEFAULT_ADDR);
  Wire1.write(SHT4x_MEDHEAT_1S);
  if (Wire1.endTransmission() != 0) {
    sensorErrors++;
    return;
  }
  heaterPending = true;
  heaterStartedAt = now;
  heaterPulses++;
}

// Recent valid RH samples, for the mist-start decision. A single reading
// trips on any one-off dip (heater residue, a lid opening, noise); the
// median of the last 30s does not. Held (heater-blanked) seconds add nothing.
const int RH_HISTORY_N = 30;
float rhHistory[RH_HISTORY_N];
int rhHistoryCount = 0, rhHistoryNext = 0;

void pushRhHistory(float rh) {
  rhHistory[rhHistoryNext] = rh;
  rhHistoryNext = (rhHistoryNext + 1) % RH_HISTORY_N;
  if (rhHistoryCount < RH_HISTORY_N) rhHistoryCount++;
}

float rhMedian() {
  if (rhHistoryCount == 0) return lastRh;
  float v[RH_HISTORY_N];
  for (int i = 0; i < rhHistoryCount; i++) v[i] = rhHistory[i];
  for (int i = 1; i < rhHistoryCount; i++) {  // insertion sort, n <= 30
    float x = v[i];
    int j = i - 1;
    while (j >= 0 && v[j] > x) { v[j + 1] = v[j]; j--; }
    v[j + 1] = x;
  }
  return v[rhHistoryCount / 2];
}

void sample() {
  if (!sensorOk) return;
  if (sensorBlanked(millis())) return;  // hold last good values

  sensors_event_t humidity, temp;
  if (!sht4.getEvent(&humidity, &temp)) {
    sensorErrors++;
    sensorOk = false;  // force a re-init attempt
    return;
  }

  lastTempC = temp.temperature;
  lastRh = humidity.relative_humidity;
  haveReading = true;
  pushRhHistory(lastRh);
}

// A blocking call made while the atomizer is on extends the burst by however
// long it blocks, so MIST_BURST_MAX_MS is only a real bound if nothing that
// can block runs past it (BUILD.md "Known firmware issues" #2). Callers that
// can block ask this first, passing their worst-case stall.
bool mistBurstCanAbsorb(unsigned long stallMs) {
  // Bench force-on is not a burst; it has its own minutes-scale cap.
  if (!atomizerOn || MIST_FORCE_ON) return true;
  unsigned long elapsed = millis() - mistBurstStartedAt;
  if (elapsed >= MIST_BURST_MAX_MS) return false;
  return MIST_BURST_MAX_MS - elapsed > stallMs;
}

// Attempt a reconnect at most every WIFI_RETRY_MS. WiFi.begin() does block,
// so this is the one place the loop can stall; the retry interval keeps that
// stall rare rather than every iteration.
//
// Never during a mist burst: WiFi.begin() has no timeout we control, so no
// amount of remaining burst time is provably enough. The retry just waits
// for the burst to end, at most MIST_BURST_MAX_MS.
void maintainWifi(unsigned long now) {
  if (WiFi.status() == WL_CONNECTED) return;
  if (!mistBurstCanAbsorb(WIFI_RETRY_MS)) return;
  if (now - lastWifiAttempt < WIFI_RETRY_MS) return;

  lastWifiAttempt = now;
  wifiReconnects++;
  Serial.println("# wifi: reconnecting...");
  WiFi.begin(SECRET_SSID, SECRET_PASS);

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("# wifi: connected, ip=");
    Serial.println(WiFi.localIP());
  }
}

void tachISR() {
  tachPulses++;
}

// Convert pulses accumulated since the last publish into RPM.
void updateFanRpm() {
  unsigned long nowMs = millis();
  unsigned long windowMs = nowMs - lastTachSampleAt;
  if (windowMs == 0) return;

  noInterrupts();
  unsigned long pulses = tachPulses;
  tachPulses = 0;
  interrupts();

  lastTachSampleAt = nowMs;
  fanRpm = (long)((pulses * 60000.0) /
                  (FAN_PULSES_PER_REV * (float)windowMs));
}

// ---------------------------------------------------------------------------
// Climate state machine
// ---------------------------------------------------------------------------

// Both actuators go through setters that no-op on an unchanged value, so the
// state machine can assert its intent every pass without spamming serial or
// re-poking the PWM timer.
void setAtomizer(bool on) {
  if (on == atomizerOn) return;
  atomizerOn = on;
  digitalWrite(ATOMIZER_PIN, on ? HIGH : LOW);
  Serial.print("# mist: ");
  Serial.println(on ? "ON" : "off");
}

void setFanDuty(float pct) {
  if (pct == fanDutyPct) return;
  fanDutyPct = pct;
  fanPwm.pulse_perc(pct);
  Serial.print("# fan: ");
  Serial.print((int)pct);
  Serial.println("%");
}

// Fan speed for every fruiting state except VENT. Colonization stays off.
float restFanDuty() {
  return MODE == MODE_FRUITING ? FAN_REST_DUTY_PCT : 0.0;
}

float mistMlTotal() {
  return (mistOnMsTotal / 60000.0) * MIST_ML_PER_MIN;
}

// Bucketed rather than a true sliding window: it needs no ring buffer, and
// the difference does not matter for a ceiling this loose.
void rollMistWindow(unsigned long now) {
  if (now - mistWindowStartedAt >= MIST_DUTY_WINDOW_MS) {
    mistWindowStartedAt = now;
    mistOnMsWindow = 0;
  }
}

void updateWetSensorTracking(unsigned long now) {
  if (!haveReading || lastRh < WET_SENSOR_RH_PCT) {
    rhHighTracking = false;
    return;
  }
  if (!rhHighTracking) {
    rhHighTracking = true;
    rhHighSinceMs = now;
  }
}

bool sensorLooksWet(unsigned long now) {
  return rhHighTracking && (now - rhHighSinceMs) >= WET_SENSOR_MS;
}

MistBlock evaluateMistBlock(unsigned long now) {
  if (MODE != MODE_FRUITING) return MIST_BLOCK_MODE;
  if (mistLatchedFault != MIST_BLOCK_NONE) return mistLatchedFault;

  if (mistCoolingDown) {
    if (now - mistCooldownStartedAt < MIST_FAULT_COOLDOWN_MS) {
      return MIST_BLOCK_COOLDOWN;
    }
    mistCoolingDown = false;
    Serial.println("# mist: cooldown over, retrying");
  }

  // Never mist on a stale or absent reading -- that is open-loop misting.
  if (!sensorOk || !haveReading) return MIST_BLOCK_NO_SENSOR;

  if (sensorLooksWet(now)) return MIST_BLOCK_WET_SENSOR;

  if (mistMlTotal() >= RESERVOIR_ML) {
    mistLatchedFault = MIST_BLOCK_BUDGET;
    Serial.println("# mist: FAULT volume budget spent -- refill and reboot");
    return MIST_BLOCK_BUDGET;
  }

  unsigned long allowance =
      (unsigned long)(MIST_DUTY_WINDOW_MS * (MIST_DUTY_CEILING_PCT / 100.0));
  if (mistOnMsWindow >= allowance) return MIST_BLOCK_DUTY;

  return MIST_BLOCK_NONE;
}

void enterClimateState(ClimateState next, unsigned long now) {
  climateState = next;
  climateStateAt = now;

  if (next == CLIMATE_MIST) {
    mistBurstStartedAt = now;
    rhAtBurstStart = lastRh;
    rhPeakSinceBurst = lastRh;
    mistBursts++;
  }
}

// Close out a burst, accounting its on-time against both the lifetime total
// (volume budget) and the current window (duty ceiling).
void endMistBurst(unsigned long now) {
  lastBurstMs = now - mistBurstStartedAt;
  mistOnMsTotal += lastBurstMs;
  mistOnMsWindow += lastBurstMs;
  setAtomizer(false);
}

void updateClimate(unsigned long now) {
  rollMistWindow(now);
  updateWetSensorTracking(now);
  mistBlock = evaluateMistBlock(now);

  bool fanOverridden = (FAN_FORCE_DUTY_PCT >= 0.0);
  if (fanOverridden) setFanDuty(FAN_FORCE_DUTY_PCT);

  if (MIST_FORCE_ON) {
    if (!fanOverridden) setFanDuty(0.0);

    // Accumulate on-time continuously rather than at burst end, so mist_ml
    // and mist_on_s stay live throughout the run.
    if (atomizerOn) {
      unsigned long tick = now - mistForceTickAt;
      mistOnMsTotal += tick;
      mistForceElapsed += tick;
    }
    mistForceTickAt = now;

    bool capped = mistForceElapsed >= MIST_FORCE_MAX_MS;
    bool budgetSpent = mistMlTotal() >= RESERVOIR_ML;

    if (capped || budgetSpent) {
      if (atomizerOn) {
        Serial.println(capped ? "# mist: force-on runtime cap reached"
                              : "# mist: force-on stopped, volume budget spent");
      }
      setAtomizer(false);
      mistBlock = capped ? MIST_BLOCK_FORCE_CAP : MIST_BLOCK_BUDGET;
      climateState = CLIMATE_IDLE;
    } else {
      setAtomizer(true);
      mistBlock = MIST_BLOCK_NONE;
      climateState = CLIMATE_MIST;
    }
    return;
  }

  if (climateState == CLIMATE_MIST || climateState == CLIMATE_MIST_SETTLE) {
    if (lastRh > rhPeakSinceBurst) rhPeakSinceBurst = lastRh;
  }

  switch (climateState) {
    case CLIMATE_IDLE:
      setAtomizer(false);
      if (!fanOverridden) setFanDuty(restFanDuty());

      // FAE takes priority over misting: vent first, then recover RH. Skipped
      // entirely while the fan is pinned by the bench override, since the fan
      // is not ours to schedule in that case.
      if (MODE == MODE_FRUITING && !fanOverridden &&
          now - lastVentAt >= FAE_PERIOD_MS) {
        enterClimateState(CLIMATE_VENT, now);
        break;
      }

      if (mistBlock == MIST_BLOCK_NONE && rhMedian() < RH_MIST_ON_PCT) {
        enterClimateState(CLIMATE_MIST, now);
      }
      break;

    case CLIMATE_VENT:
      setAtomizer(false);  // sequencing rule: never both at once
      setFanDuty(FAE_FAN_DUTY_PCT);
      if (now - climateStateAt >= FAE_BURST_MS) {
        lastVentAt = now;
        enterClimateState(CLIMATE_VENT_SETTLE, now);
      }
      break;

    case CLIMATE_VENT_SETTLE:
      if (!fanOverridden) setFanDuty(restFanDuty());
      if (now - climateStateAt >= VENT_SETTLE_MS) {
        enterClimateState(CLIMATE_IDLE, now);
      }
      break;

    case CLIMATE_MIST:
      // A guard tripping mid-burst stops it immediately.
      if (mistBlock != MIST_BLOCK_NONE) {
        endMistBurst(now);
        enterClimateState(CLIMATE_MIST_SETTLE, now);
        break;
      }

      setAtomizer(true);
      if (!fanOverridden) {
        setFanDuty(FAN_REST_DURING_MIST ? restFanDuty() : 0.0);
      }

      if (lastRh >= RH_MIST_OFF_PCT ||
          now - climateStateAt >= MIST_BURST_MAX_MS) {
        endMistBurst(now);
        enterClimateState(CLIMATE_MIST_SETTLE, now);
      }
      break;

    case CLIMATE_MIST_SETTLE:
      setAtomizer(false);
      if (!fanOverridden) setFanDuty(restFanDuty());
      if (now - climateStateAt < MIST_SETTLE_MS) break;

      // Now, with the fog given time to evaporate, the reading means
      // something -- so this is where the dry-run check belongs.
      //
      // Judge on the peak, not the settled value. How far RH has fallen
      // back by the end of the settle is a property of the chamber's leak
      // rate, not of the atomizer: in the real tote with polyfill vents
      // (2026-09-27) every healthy burst peaked ~+6 and then leaked back to
      // exactly where it started, which a settled-delta check struck three
      // times running. A dry atomizer makes no fog, so it produces no peak
      // at all -- that is the thing to detect. The peak also catches the
      // 08-24 bench shape, where RH dipped during the burst and rose after.
      bool judgeable = lastBurstMs >= MIST_RESPONSE_MIN_BURST_MS && haveReading;
      if (judgeable) {
        if (rhPeakSinceBurst - rhAtBurstStart < MIST_RESPONSE_MIN_RH) {
          mistNoResponseCount++;
          Serial.print("# mist: no RH response (");
          Serial.print(mistNoResponseCount);
          Serial.print("/");
          Serial.print(MIST_NO_RESPONSE_LIMIT);
          Serial.println(")");
          if (mistNoResponseCount >= MIST_NO_RESPONSE_LIMIT) {
            mistNoResponseCount = 0;
            mistFaultTrips++;
            if (mistFaultTrips > MIST_FAULT_COOLDOWNS) {
              mistLatchedFault = MIST_BLOCK_NO_RESPONSE;
              Serial.println("# mist: FAULT dry run, persists after retries -- latched off");
            } else {
              mistCoolingDown = true;
              mistCooldownStartedAt = now;
              Serial.print("# mist: dry run suspected -- cooling down, trip ");
              Serial.print(mistFaultTrips);
              Serial.print("/");
              Serial.println(MIST_FAULT_COOLDOWNS + 1);
            }
          }
        } else {
          mistNoResponseCount = 0;
          mistFaultTrips = 0;  // a good burst clears the trip history
        }
      }

      enterClimateState(CLIMATE_IDLE, now);
      break;
  }
}

void publish() {
  updateFanRpm();

  if (!haveReading) return;

  char t[16], h[16], d[16];
  fmt2(t, sizeof(t), lastTempC);
  fmt2(h, sizeof(h), lastRh);
  fmt2(d, sizeof(d), dewPointC(lastTempC, lastRh));

  char f[16], l[16], m[16], med[16];
  fmt2(med, sizeof(med), rhMedian());
  fmt2(f, sizeof(f), fanDutyPct);
  fmt2(l, sizeof(l), lightDutyPct);
  fmt2(m, sizeof(m), mistMlTotal());

  // BUILD.md:405 -- log actuator state, not just sensors, or you can see that
  // RH dropped but not whether anything was trying to do something about it.
  // mist_state and mist_block are integer codes (see the enums) so they land
  // in the CSV as plottable columns.
  static char payload[600];  // static: see readTimeSync()
  snprintf(payload, sizeof(payload),
           "chamber temp_c=%s,rh_pct=%s,dewpoint_c=%s,"
           "fan_duty_pct=%s,fan_rpm=%ldi,light_duty_pct=%s,"
           "mist_state=%di,mist_block=%di,atomizer_on=%di,"
           "mist_ml=%s,mist_on_s=%lui,mist_bursts=%lui,"
           "rssi=%ldi,uptime_s=%lui,sensor_errors=%lui,"
           "wifi_reconnects=%lui,publish_failures=%lui,time_synced=%di,"
           "heater_pulses=%lui,sensor_held=%di,rh_median=%s,"
           "loop_max_ms=%lui,fw_build=%di,cfg_version=%ldi,cfg_rejects=%lui",
           t, h, d, f, fanRpm, l,
           (int)climateState, (int)mistBlock, atomizerOn ? 1 : 0,
           m, mistOnMsTotal / 1000UL, mistBursts,
           (long)WiFi.RSSI(), millis() / 1000,
           sensorErrors, wifiReconnects, publishFailures, haveTime ? 1 : 0,
           heaterPulses, sensorBlanked(millis()) ? 1 : 0, med, loopMaxMs,
           FW_BUILD, cfgVersion, cfgRejects);
  loopMaxMs = 0;  // max since the previous publish

  // Always echo to serial, so USB logging still works with WiFi down.
  Serial.println(payload);

  if (WiFi.status() != WL_CONNECTED) {
    publishFailures++;
    return;
  }

  // No network I/O at all while the atomizer is on. The connect timeout does
  // not bound every step: on 2026-09-27 a single POST blocked the loop for
  // 10,058 ms (loop_max_ms) -- the WiFiS3 modem's 10s AT-command timeout.
  // Budgeting a 2.8s worst case was wrong, so do not budget: skip. The
  // payload has already gone to serial above.
  if (!mistBurstCanAbsorb(MIST_BURST_MAX_MS)) {
    publishFailures++;
    Serial.println("# post: skipped, would overrun mist burst");
    return;
  }

  // HTTPS to the chamber tool on dot-y.co (build 14). The TLS itself runs on
  // the R4's ESP32-S3 modem, which carries the root certificates.
  WiFiSSLClient client;
  client.setConnectionTimeout(HTTP_TIMEOUT_MS);

  if (!client.connect(COLLECTOR_HOST, COLLECTOR_PORT)) {
    publishFailures++;
    Serial.println("# post: connect failed");
    return;
  }

  client.print("POST /ingest HTTP/1.1\r\nHost: ");
  client.print(COLLECTOR_HOST);
  // The device key: the ingest Lambda refuses anything without it
  client.print("\r\nx-chamber-key: ");
  client.print(DEVICE_KEY);
  // Piggyback the active settings as a second record when they changed (or
  // after boot), so the collector learns what the board is really running.
  static char cfgLine[480];  // static: see readTimeSync()
  cfgLine[0] = '\0';
  bool sendingCfg = cfgReportDue;
  if (sendingCfg) formatSettings(cfgLine, sizeof(cfgLine));
  size_t bodyLen = strlen(payload) + (sendingCfg ? 1 + strlen(cfgLine) : 0);

  client.print("\r\nContent-Type: text/plain\r\nContent-Length: ");
  client.print(bodyLen);
  client.print("\r\nConnection: close\r\n\r\n");
  client.print(payload);
  if (sendingCfg) {
    client.print("\n");
    client.print(cfgLine);
    cfgReportDue = false;  // best effort; a reboot re-sends
  }

  // The one thing we do read back: the collector's local time, used to align
  // the light schedule. Still fire-and-forget in spirit -- if the read times
  // out or the reply is malformed we simply carry on with the last known
  // time, and the light falls back to its boot-relative cycle if we never
  // got one at all.
  readTimeSync(client);

  client.stop();
}

void setup() {
  Serial.begin(115200);
  unsigned long startedAt = millis();
  while (!Serial && millis() - startedAt < SERIAL_WAIT_MS) delay(10);

  pinMode(LED_BUILTIN, OUTPUT);

  // Atomizer to a known-off state before anything else can run. Order matters:
  // drive the latch low BEFORE switching the pin to an output, so it never
  // presents a high edge to the gate on the way. The 10k gate pulldown covers
  // the window before this line executes.
  digitalWrite(ATOMIZER_PIN, LOW);
  pinMode(ATOMIZER_PIN, OUTPUT);
  digitalWrite(ATOMIZER_PIN, LOW);

  // Tach is open-collector -- the fan can only pull the line low, so we
  // supply the high side ourselves or it floats and reads as noise.
  pinMode(FAN_TACH_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(FAN_TACH_PIN), tachISR, FALLING);
  lastTachSampleAt = millis();

  // Start at 0%; updateClimate() takes ownership from the first loop() pass.
  if (!fanPwm.begin(FAN_PWM_FREQ_HZ, 0.0)) {
    // Worth shouting about: if this fails the PWM line is undriven, and a
    // 4-wire fan with no PWM signal runs at 100% rather than stopping.
    Serial.println("# fan: PwmOut.begin() FAILED -- fan is likely at 100%");
  } else {
    fanDutyPct = 0.0;
  }

  // Phase all the climate timers from boot. First vent therefore lands one
  // FAE_PERIOD_MS in, which leaves misting to bring a cold-start chamber up
  // to the band first -- the right order for a chamber that starts dry.
  unsigned long bootAt = millis();
  climateStateAt = bootAt;
  lastVentAt = bootAt;
  lastHeaterAt = bootAt;
  mistWindowStartedAt = bootAt;
  mistForceTickAt = bootAt;

  if (MIST_FORCE_ON) {
    Serial.print("# mist: BENCH FORCE-ON, cap ");
    Serial.print(MIST_FORCE_MAX_MS / 60000UL);
    Serial.println(" min -- burst/settle and RH guards bypassed");
  }

  Serial.print("# mode: ");
  Serial.println(MODE == MODE_FRUITING ? "fruiting" : "colonization");
  if (FAN_FORCE_DUTY_PCT >= 0.0) {
    Serial.print("# fan: BENCH OVERRIDE pinned at ");
    Serial.print((int)FAN_FORCE_DUTY_PCT);
    Serial.println("% -- FAE bursts disabled");
  }

  // Begin at 0% so the strip does not flash to full during startup.
  // updateLight() takes over from the first loop() pass and will bring it up
  // if the schedule says so.
  if (!lightPwm.begin(LIGHT_PWM_FREQ_HZ, 0.0)) {
    Serial.println("# light: PwmOut.begin() FAILED on D9");
  }

  sensorOk = initSensor();
  if (!sensorOk) {
    Serial.println("# sht41: not found on Wire1, will keep retrying");
  }

  WiFi.setTimeout(WIFI_CONNECT_TIMEOUT_MS);
  WiFi.begin(SECRET_SSID, SECRET_PASS);
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("# wifi: connected, ip=");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("# wifi: not connected yet, will keep retrying");
  }

  Serial.print("# posting to ");
  Serial.print(COLLECTOR_HOST);
  Serial.print(":");
  Serial.println(COLLECTOR_PORT);

  // Armed last, so setup()'s own blocking (serial wait, first WiFi.begin)
  // cannot trip it.
  if (WATCHDOG_ENABLED && WDT.begin(WATCHDOG_MS) < 0) {
    Serial.println("# watchdog: begin FAILED -- running without it");
  }
}

void loop() {
  if (WATCHDOG_ENABLED) WDT.refresh();
  unsigned long now = millis();
  if (loopStartedAt != 0 && now - loopStartedAt > loopMaxMs) {
    loopMaxMs = now - loopStartedAt;
  }
  loopStartedAt = now;

  // Unsigned subtraction, so all of these stay correct across the ~49-day
  // millis() rollover.
  if (now - lastSampleAt >= SAMPLE_INTERVAL_MS) {
    lastSampleAt = now;
    sample();
  }

  if (!sensorOk && now - lastSensorAttempt >= SENSOR_RETRY_MS) {
    lastSensorAttempt = now;
    sensorOk = initSensor();
    if (sensorOk) Serial.println("# sht41: recovered");
  }

  if (now - lastPublishAt >= PUBLISH_INTERVAL_MS) {
    lastPublishAt = now;
    publish();
  }

  updateHeater(now);
  updateClimate(now);
  updateLight(now);
  maintainWifi(now);

  // Solid = healthy, dark = sensor down. Visible across the room without
  // a laptop attached.
  digitalWrite(LED_BUILTIN, sensorOk ? HIGH : LOW);
}
