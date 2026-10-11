# Mushroom Fruiting Chamber — Build Notes

11L chamber, Arduino UNO R4 WiFi. Controls humidity, fresh air exchange (FAE),
light, and optionally heat.

Room ambient ~70°F / 21°C — suits pearl oyster and lion's mane without
temperature control. No active cooling planned (see "Rejected" below).

---

## Status

**Have:** UNO R4 WiFi, proto screw shield, SHT41, atomizer module,
NF-A4x20 5V PWM fan, 12V COB LED strip, Qwiic / STEMMA QT cables

**Working on the bench (2026-08-24):** full closed-loop climate control.
One state machine drives fan (FAE bursts), light (12h schedule) and atomizer
(RH band with software interlocks), logging over WiFi to a collector on the
Mac. Ran headless on the bench supply with no USB. Drove RH 49% → 85%, vented,
and recovered. See "Where we left off (2026-08-24)".

**Still to get:** **24V ≥3A supply** (current brick is 24V 1A — too small, see "Power architecture"), SCD41 (CO2), inline fuse, male barrel pigtail, perlite,
20mm ID tubing, aluminum U-channel, distilled water

---

## Do these before mounting anything

### SCD41 — disable automatic self-calibration

Ships with ASC **enabled**. It assumes the sensor periodically sees fresh
outdoor air (~400 ppm) and re-zeros against the lowest reading over ~a week.

A sealed fruiting chamber never sees 400 ppm, so ASC will progressively drag
the calibration down and report plausible-looking numbers that are wrong.

- [ ] Disable ASC in firmware
- [ ] Do a forced recalibration in fresh outdoor air **before** mounting it
- [ ] Repeat the outdoor recalibration every few months

### SCD41 — protect it from condensation

Rated 0–95% RH **non-condensing**. Chamber runs 85–95% with active fogging,
so it's at or past its limit, and it has no onboard heater to clear itself.

**Sensor choice is settled — keep the SCD41.** No consumer NDIR CO2 sensor is
rated for condensing humidity (SCD40/41, SCD30, MH-Z19B/C, Senseair S8 are all
0–95% non-condensing). The obvious upgrade is worse: the SCD30 has documented
RH cross-sensitivity, where CO2 readings track humidity changes — unusable in a
chamber cycling between mist and vent.

So this is a protection problem, not a parts problem. These stack:

- [ ] **ePTFE vent membrane** over the sensor's gas port. Hydrophobic and
      gas-permeable — CO2 diffuses through, liquid water doesn't.
      **NOT plumber's PTFE thread tape** — that's solid, non-porous film and
      will block gas exchange completely. You want *expanded* PTFE: search
      "ePTFE vent patch", "Gore protective vent", or "adhesive vent membrane"
- [ ] Cover the **port only**, or build a small enclosure with a
      membrane-covered vent. Never wrap the whole module — that traps air and
      destroys response time
- [ ] Do **not** membrane the SHT41. It must contact chamber air directly, and
      it has its own heater for condensation
- [ ] **Run continuous mode, not low-power single-shot.** Self-heating puts the
      sensor 2–4°C above ambient, i.e. above the chamber dewpoint, so water
      condenses on the lid instead of on it
- [ ] **Conformal coat the breakout PCB** — mask the optical/acoustic port first
- [ ] **Mount high and vertical** so condensate runs off rather than pooling

Placement alternative if it still struggles: mount it **just outside the exhaust
vent, downstream of the fan**. Reads real chamber air while venting, stays out of
the fog entirely. Readings are only valid during/after a vent cycle — acceptable,
since that's exactly when the vent-or-not decision gets made.

The SHT41 must be inside the chamber; the SCD41 does not.

### If the SCD41 proves inadequate — the up-market option

**Vaisala GMP252**, ~$730–780 new. IP65, and critically a **heated sensor head
specifically to prevent condensation**. Built for greenhouses and agriculture;
what commercial mushroom farms actually use. 0–10,000 ppm.

Note the differentiator is deliberate heating, not a better detector — same
principle as the SHT41's onboard heater.

Integration notes if ever pursued:

- Get the **0–5V output variant** — wires straight to an R4 analog pin
  (14-bit ADC, 0–5V reference). The 0–10V variant needs a 2:1 divider
- **Check supply voltage** — typically wants 15–30 VDC for analog output
  modes. The 12V rail may be insufficient
- Modbus variants need an RS-485 transceiver

**Buy used.** These turn up on eBay regularly — industrial instruments get
replaced on schedule, not on failure. $150–300 used is a realistic find and
would be bulletproof here. Worth watching listings during commissioning.

(E+E EE872 is a possible mid-tier option, ~$400–600 — specs unverified.)

At $730 new against a ~$150 total BOM this is disproportionate. Decide only
after commissioning shows whether continuous CO2 control is actually needed.

### CO2 sensing may be temporary

Legitimate alternative to permanent CO2 control:

1. Run the SCD41 during commissioning to learn the chamber's actual CO2
   accumulation rate
2. Use that to tune a **fixed FAE schedule** (e.g. "vent 90s every 40 min")
3. Remove the sensor, run open-loop

CO2 buildup for a given chamber and block size is fairly repeatable, and a
tuned timer captures most of the benefit without leaving an optical sensor in a
fog chamber indefinitely. Decide after commissioning — it changes how much
protection is worth building.

### SHT41 — heater pulse + creep mitigation

Two separate problems, one solution.

**Condensation:** at 90% RH with cold fog, water on the die is inevitable, and
a wet SHT41 reads a flat 100% forever.

**Creep:** Sensirion documents that sustained **>90% RH** causes a *reversible
positive offset* — water soaks into the sensing polymer faster than it escapes,
so readings drift high. This is our exact operating point; expect it. Sensirion
app note: "Using the Integrated Heater of SHT4x in High-Humidity Environments."
Self-recovers once back in normal RH.

Heater limits from the datasheet — these are hard constraints:

- **Max 1 second on-time per command.** Longer needs repeated commands
- **Max 10% duty cycle.** Exceeding it damages the sensor

- [x] Pulse the heater ~1s every 30–60s (stays under 10% duty) -- 60s, medium
- [x] Discard RH **and temp** readings during the pulse and for several seconds
      after, while it returns to ambient -- 10s after the 1.1s pulse
- [ ] Tune the interval once baseline data shows actual condensation behavior

**Sensor choice is settled.** Creep is a property of capacitive polymer RH
sensing, not of this part — SHT45, SHT85, HTU31, BME280 all do it. The SHT4x is
the best hobby-tier choice precisely because it has an integrated heater and a
published mitigation. The real upgrade is a heated industrial probe (Vaisala
HMP series, $500+), same tier as the GMP252 discussion.

### SHT41 — placement and fault detection

- [ ] Mount **vertically** (condensate runs off) in **moving air** (dead air
      wets faster and stays wet), away from the fog plume
- [ ] **Fault detection:** RH flat at 100% for several minutes AND unresponsive
      to a vent cycle = wet/failed sensor, not a wet chamber. Alert, and fail
      safe by suspending misting rather than running the atomizer into an
      already-saturated box

That fault check matters more than any sensor upgrade. A crept sensor reading
3% high is a nuisance; a stuck-at-100% sensor silently stops all misting.

- [ ] Optional: second SHT41 (~$7) as a cross-check. Two sensors disagreeing
      identifies the compromised one. Better value than upgrading to ±1.0%

---

## Immediate next steps

- [x] Run `i2c_scan` — SHT41 confirmed at `0x44` on **Wire1**; nothing on Wire
- [x] Run `sht41_test` — clean readings, noise ±0.02°C / ±0.06% RH, well
      inside the ±0.2°C / ±1.8% spec
- [ ] Log 24h baseline in the sealed empty tote → passive RH, decay rate,
      day/night temp swing.
      **Use `chamber_telemetry` + `collector/collector.py`, not `sht41_test`.**
      Run the collector under `caffeinate -i` so the Mac can't sleep mid-run
- [x] Bench-test atomizer — driver board required, disc does nothing on DC
- [x] Add MOSFET channel for atomizer — built, and debugged 2026-08-24
- [x] Measure RH response — see "Mist response and vent exchange (2026-08-24)"
- [ ] **Measure actual atomizer output**: weigh reservoir, run 10 min, weigh
      again. 1g = 1mL. Still outstanding, and `MIST_ML_PER_MIN` is a
      placeholder until it is done
- [ ] Build reservoir bin + short duct. **No float switch** — replaced by the
      software interlocks, see "No float switch — software interlock instead"

Bus note: Qwiic connector is `Wire1`; A4/A5 header pins are `Wire`.

---

## Bench toolchain

macOS, `arduino-cli` (no IDE). Board FQBN `arduino:renesas_uno:unor4wifi`.

```
arduino-cli compile -b arduino:renesas_uno:unor4wifi <sketch>
arduino-cli upload  -b arduino:renesas_uno:unor4wifi -p /dev/cu.usbmodem* <sketch>
```

Four things that each cost a failed attempt during first bring-up:

- **Rosetta 2 is required.** The `arduino:renesas_uno` core (1.6.0, latest)
  ships an x86_64-only `arm-none-eabi-gcc`, so Apple Silicon fails with
  "bad CPU type in executable". Fix:
  `softwareupdate --install-rosetta --agree-to-license`
- **The library is named "Adafruit SHT4x Library"** in the index. Installing
  "Adafruit SHT4x" fails with "not found".
- **`arduino-cli monitor` emits nothing when redirected to a file**, and macOS
  `script` can't wrap it either. Read the port with pyserial instead, asserting
  DTR — sketches gated on `while (!Serial)` hang without it. pyserial is not in
  the system python3 and needs a venv.
- **Uploads fail once the resident sketch uses WiFi.** Upload triggers the
  bootloader with a 1200-baud touch that the running sketch must notice; a
  sketch blocking in `WiFi.begin()` can't, so it dies with "No device found".
  Double-tapping RESET makes it *worse* — the board re-enumerates as
  `UNO WiFi R4 CMSIS_DAP` (the ESP32-S3 debug interface), which bossac can't
  talk to at all, and goes silent on serial.
  **Fix: unplug and replug USB, then upload immediately.** Do not reach for
  the RESET double-tap.

That last one is an argument for making the WiFi reconnect genuinely
non-blocking, beyond just the control-loop rule in "Telemetry".

---

## Where we left off (2026-08-24)

**Closed-loop humidity control ran end to end for the first time.** The
chamber_telemetry sketch now owns fan, light and atomizer through one climate
state machine, and it drove RH from 49% to the 85% band, held it, vented on
schedule, and recovered. Telemetry ran headless over WiFi on the bench supply
with no USB attached.

### What was proven

| | |
|---|---|
| Climate state machine | IDLE / VENT / VENT_SETTLE / MIST / MIST_SETTLE, non-blocking |
| Sequencing rule | Enforced structurally -- VENT is only reachable from IDLE, so a mist settle always completes first |
| Mist channel | 49% -> 85% RH under closed-loop control |
| FAE channel | 90s @ 70% moved RH 85% -> 75% |
| Headless operation | Ran on bench supply, no USB, telemetry over WiFi |
| Guards | Dry-run detector caught a real fault (see below); duty ceiling and volume budget wired and reporting |

### The loose solder joint

Roughly two hours went into chasing "atomizer switches but RH does not move".
Root cause was **a loose solder joint in the atomizer channel**, found by
inspection, not by instrument.

Evidence pattern, worth recognising again:

- Firmware driving D10 correctly, `atomizer_on=1` in telemetry
- RH **falling** across every mist settle (-0.39% net over 12 min)
- After the resolder, the very first healthy burst gave **+4.16%**, then
  **+25%** and **+30%** as it filled from far below equilibrium

So a working channel is not subtle. ~0.15% per burst was the fault;
healthy is 8-30x the 0.5% detection threshold.

**Metering trap that cost most of that time.** Two things make a working
atomizer channel measure as dead:

1. **The MOSFET is low-side -- it switches the driver's GROUND.** The driver's
   +5V pin sits at 5V continuously from the buck regardless of MOSFET state.
   Metering +5V against power ground tells you nothing. Probe the driver's
   **GND pin**: ~0V when conducting, floating toward +5V when off.
2. **The disc output (`HM`) is 108 kHz AC.** A DVM reads ~0V in DC mode and
   most meters cannot track 108 kHz in AC mode either. A perfectly good driver
   measures as nothing there.

Diagnostic ladder, all referenced to Arduino GND unless noted:

| Point | Expect when misting |
|---|---|
| D10 (before the 150R) | ~5V |
| MOSFET gate (after 150R) | ~5V |
| MOSFET drain -> source | < 0.2V |
| Buck output | 5.0V |
| Driver V+ -> driver GND | ~5V |

### Board vs source: RELOAD BEFORE TESTING

The board is currently flashed with **bench values** -- `FAE_PERIOD_MS` 15 min
and `PUBLISH_INTERVAL_MS` 5s. The **source has been restored** to 40 min and
20s. First action tomorrow is a reflash, or the test runs at bench cadence.

### To resume

- [ ] **Reflash `chamber_telemetry`** -- source and board are out of sync (above)
- [ ] Fix the three known firmware issues below **before any unattended run**
- [ ] **Measure atomizer output** (`atomizer_output`): weigh reservoir, run
      10 min, weigh again. `MIST_ML_PER_MIN` is still a **1.5 placeholder**, so
      the volume budget is a guess and the dry-run check is carrying the real
      protection
- [ ] **Run the 24h baseline.** Still outstanding from 08-17
- [ ] Build the reservoir bin + short duct
- [ ] Still not purchased: SCD41 (CO2), inline fuse, male barrel pigtail

### Known firmware issues

**All three fixed in source 2026-09-27** (notes below kept for the why):

1. Dry-run check now judges the **peak** RH rise across burst + settle
   (>= 0.5), not the settled delta. In the real tote with polyfill vents,
   every healthy burst peaked ~+6 then leaked back to its start within the
   90s settle, so any settled-delta rule strikes a working channel. A dry
   atomizer makes no fog and so no peak. (An intermediate headroom-scaled
   rule was tried and failed live the same day.)
2. WiFi reconnects never run during a burst, and a POST is skipped if its
   worst-case stall would overrun the burst bound (`mistBurstCanAbsorb()`).
3. Heater pulse implemented non-blocking over raw I2C: medium heat, 1s every
   60s (1.7% duty), RH and temp held for 11s after. The library's heater path
   `delay()`s 1.1s inside `getEvent()`, which would have reopened issue 2.
   Reported as `heater_pulses` -- a new CSV column, so start a fresh CSV.

Original descriptions:

1. **Dry-run check false-positives near setpoint.** As RH approaches the 85%
   floor from below, per-cycle deltas shrink toward zero -- that is what
   approaching equilibrium means. The check demands +0.5% regardless, so it
   starts striking a healthy channel exactly when it is closest to target.
   Observed live: at 84.87% (0.13 below the floor) it demanded a rise that
   would overshoot the setpoint. Three strikes latches misting off and needs a
   power cycle. **This would fire unattended on a well-tuned chamber.**
   Fix: skip the check when `RH_MIST_ON_PCT - rhAtBurstStart <
   MIST_RESPONSE_MIN_RH` (unanswerable test), and only strike on `delta <= 0`
   (a dry atomizer gives zero or negative, not small positive).

2. **`MIST_BURST_MAX_MS` is not a real bound.** `maintainWifi()` calls
   `WiFi.begin()`, which blocks ~3s and stalls the control loop. Observed: a
   burst ran **33s** instead of 30 because the first reconnect attempt landed
   mid-burst (`lastWifiAttempt` starts at 0, so the first retry fires at
   uptime 30s). Any blocking call directly extends actuator on-time.
   Fix: latch a hard "must be off by" deadline at burst start and check it
   before anything that can block.

3. **SHT41 heater pulse still not implemented.** `initSensor()` sets
   `SHT4X_NO_HEATER`. Now that the atomizer runs and RH sits in the 80s, both
   condensation and creep are live concerns. Not a one-liner: RH **and temp**
   must be discarded during the pulse and for several seconds after, or the
   control loop mists on heater-warmed readings. Spec is in "SHT41 -- heater
   pulse + creep mitigation".

---

## Power architecture — 24V (2026-10-11)

Replaced the 5V atomizer with a **24V 1A (24W)** unit. Power is now a single
24V supply split into two branches:

```
24V supply + ──[F1 main T2.5A]──┬──[F2 T1.5A]── atomizer + ... atomizer − → MOSFET drain (D10)
                                └── buck 24V→12V ──[F3 T2A]── 12V rail (LED, R4 barrel, 5V buck → fan)
24V supply − ── common ground (all supplies/bucks/R4 GND)
```

**Current brick is 24V 1A (24W) — undersized; the atomizer alone uses all of it. Replace before the full test.**

**Interim wiring until the bigger brick arrives (2026-10-11):** two supplies.
24V 1A brick feeds only the atomizer (24V+ → atomizer+, atomizer− → D10 MOSFET
drain). The 12V supply feeds the 12V rail directly as before, through the T2A
fuse; the 24V→12V buck is out of circuit. **Both supplies' − join the common
ground bus** — the atomizer's return current goes through the MOSFET to that
bus and has to get back to the 24V brick. Never join the + sides. The brick
runs at 100% of its rating, so any startup sag it has can no longer reset the
Arduino.

Budget: atomizer 24W + 12V side ~18W (LED ~15W, R4 + sensors, fan) ÷ ~90%
buck efficiency ≈ 44W ≈ **1.85A at 24V**. Supply must be **≥ 24V 3A**; the
24V→12V buck must be good for ≥ 2A continuous at 12V.

Fuses — all slow-blow (`T`), all on the **+ wire as close to the source as
possible** (a fuse protects only the wiring downstream of it):

| Fuse | Where | Rating | Why this size |
|---|---|---|---|
| F1 | 24V supply + output, before the split | **T2.5A** | ~1.35× the 1.85A total; must be ≤ supply rating or it can never blow |
| F2 | 24V atomizer branch | **T1.5A** | 1.5× the 1A draw; slow-blow rides through driver inrush |
| F3 | 12V buck output | **T2A** | ~1.3× the 12V-side 1.5A; protects the 12V rail wiring |

Branch fuses are smaller than the main, so a fault in one branch blows its
own fuse and leaves the other running instead of killing everything.

**Interim (two supplies):** T2A on the 12V supply's + right after its barrel
breakout; T1.5A holder on the 24V brick's +. When the 24V 3A brick arrives,
the 24V holder becomes F1 (swap in T2.5A) and the 12V holder moves to the
buck output as F3. Use 5×20mm glass **T**-rated fuses in inline holders —
automotive blade fuses are not slow-blow. Fuse + only, never the − wire.

**Minimum for fire protection: F1 alone**, because the wiring is 20 AWG. The
buck halves current going down, so F1 behaves like a ~4.5A fuse on the 12V
side, which 20 AWG carries without heating. F2 adds nothing for fire
(F1 sees atomizer current directly). F3 is the worthwhile upgrade. Any
thinner wire on the 12V side (factory leads, pigtails, jumpers) breaks this
and needs F3.

No fuse catches a **stuck-on atomizer running dry**: it draws its normal 1A.
That case relies on the firmware RH-response check and volume budget.

- Set the 24V→12V buck to 12.0V **before** connecting the 12V rail (same rule
  as the 5V buck)
- The old 12V→5V buck no longer feeds the atomizer
- **The 24V atomizer has its own float + low-water cutoff.** That is the
  hardware dry-run interlock the old setup lacked: it holds even if the
  MOSFET fails short or firmware hangs. The firmware guards stay as a second
  layer (a cut-out atomizer makes no RH rise, so the dry-run check flags it)
- Reservoir is now **~750 mL** (firmware `RESERVOIR_ML` still 500 -- trips
  early, the safe direction; raise once `MIST_ML_PER_MIN` is measured)
- **`MIST_ML_PER_MIN` (1.5) was a placeholder for the old atomizer.** A 24W
  unit almost certainly outputs far more, so the volume budget undercounts
  until `atomizer_output` is rerun on the new unit

## Humidification architecture — atomizer channel

### The disc needs a driver board

A bare piezo disc does **nothing** on DC — it flexes once and stops. It needs
a driver generating its resonant frequency (108 kHz here). Symptoms of driving
a bare disc with DC: no fog, no ripple on the water, no heat, correct voltage
present, nothing happening regardless of polarity or depth. The driver board
ships in the same box; check before ordering anything.

Driver connections: `GVS` (Ground / +5V / Signal) is the primary interface,
`HM` is the disc output.

### S floating means ON

The driver runs whenever it has power; `S` does nothing at rest. That is the
**wrong default for safety** — an Arduino pin is undriven during reset, so
driving the driver from a bare logic pin would mist on every boot.

**So the MOSFET switches the driver's 5V supply**, low-side on its ground,
exactly like the LED channel. The gate pulldown makes the fail-safe direction
correct by construction: no gate drive → no power → no mist.

**Leave `S` unconnected**, and do not wire it to the Arduino. With the
driver's ground being switched, a wire from `S` to an Arduino pin gives
current a sneak path through the input protection diode, and the driver can
half-run with the MOSFET off.

On/off only — never PWM the driver's supply. It generates its own 108 kHz.

### No float switch — software interlock instead

Decided against the hardware float switch. What that gives up: a MOSFET failed
short cannot be caught by firmware, since it is downstream of everything
firmware controls. What replaces it:

- **Volume budget** — track cumulative mL dispensed against reservoir
  capacity, refuse to mist past it, manual reset on refill. This covers the
  realistic case (reservoir empties during normal running) and is why the
  mL/min measurement is load-bearing
- **Max continuous runtime and duty ceiling**
- **RH-response check** — if misting runs and RH does not rise, stop and flag.
  An atomizer firing into an empty reservoir produces no humidity, making this
  a genuine dry-run detector
- The stuck-at-100% wet-sensor check already specified above

### Fog transport — don't duct it far

Free plume rises ~6 inches. Enclosing it in a PVC tube **degrades it badly**:
droplets coalesce on the walls, wall friction strips the plume's momentum, and
nothing entrains air to carry it. Fog does not travel on its own.

**Settled approach: separate reservoir bin, elevated, very short wide port.**

- Reservoir in its own bin so it lifts out for draining and sanitizing
  without touching the grow chamber
- **Mounted above the tote** — fog is denser than air and flows downhill, so
  gravity does the transport passively with no fan and no assist air
- Short wide port between the two, angled slightly down toward the tote
- **Reservoir bin needs its own filtered makeup-air vent** or nothing flows.
  Note this becomes a second outflow path, so filter it to the same standard
  as the exhaust or spores can reach the water
- Aim the outlet so condensate does not drip on the block (bacterial blotch)
- Driver board stays outside the bin, dry; only disc wires cross in
- Give it its own vent rather than routing the fan through it — that would
  recouple ventilation and humidification, which the sequencing rule wants
  independent

### Reconfigured 2026-10-11: FAE now routes through the reservoir bin

Supersedes "give it its own vent" above. Order: intake filter → fan (dry side)
→ reservoir bin → chamber. Consequences:

- FAE still exchanges CO2/O2; incoming air is just pre-humidified. A vent
  cost only −3.1% RH (87.0 → 83.9) on the first run
- **RH no longer works as an air-exchange tracer** (the vapour-pressure ACH
  trick below assumes dry makeup air). FAE adequacy now needs the SCD41
- Path is a little more restrictive: 70% duty runs ~4030 rpm vs 3780–3960 on
  2026-09-27 (rising RPM at matched duty = more restriction)
- Option to try: `rest_fan_mist` = 1 to use the fan as assist air for fog

### Buck converter

Adjustable module, set to 5.0V. Tune it **under load**, measured at the
driver's input — not unloaded at the buck's terminals. Do not compensate for
wiring loss by raising the setpoint: the drop only exists while current flows,
so when the MOSFET switches off the device sees the full elevated voltage.
Fix the resistance instead. Dupont jumpers cost ~0.4V and are not acceptable
on this rail.

---

## Commissioning data

### Fan: duty vs RPM (2026-08-15)

NF-A4x20 5V PWM, 25 kHz via the core's `PwmOut`, **unloaded — no filter**.
Measured from the tach on D2, 2 pulses/rev.

| Duty | RPM | Duty | RPM |
|---:|---:|---:|---:|
| 0% | 0 | 60% | 3320 |
| 10% | 450 | 70% | 3760 |
| 20% | 1100 | 80% | 4210 |
| 30% | 1770 | 90% | 4570 |
| 40% | 2360 | 100% | 4980 |
| 50% | 2860 | | |

- 100% → 4980 RPM against a rated ~5000, which cross-validates the PWM
  frequency, the duty scale, and the tach math all at once
- **No stall risk:** still turns at 10% duty, far below the planned 60–80%
  burst band
- **0% genuinely stops it** — no separate enable line or MOSFET needed to
  hold the fan off during colonization
- Static pressure by the RPM² relation: 60% ≈ 1.8 mm H2O, 80% ≈ 2.9 mm
  against the ~4 mm ceiling. Going to 100% is ~75% more pressure held in
  reserve if the filter stack proves restrictive

**Re-run this sweep with the filter fitted** and diff against these numbers.
RPM rising at matched duty quantifies restriction. This is the only unloaded
reference that will ever exist, so keep it.

Caveat that undercuts the tach-as-watchdog idea in "Telemetry": RPM will
**not** catch a clogged intake filter. Restrict an axial fan and it unloads,
so RPM holds steady or rises while airflow collapses. The tach catches a
*seized* fan; only the CO2 decay rate catches a *clogged* one.

---

### Mist response and vent exchange (2026-08-24)

**Measured in a small bench enclosure, NOT the 11L tote.** Absolute numbers
will not transfer -- different volume, leak rate, no perlite buffer. The
*methods* below do.

Settled RH per mist cycle (30s burst + 90s settle), climbing from 49%:

| Cycle | Settled RH | Delta |
|---:|---:|---:|
| 3 | 53.71 -> 79.03 | +25.32 |
| 4 | 79.03 -> 80.97 | +1.94 |
| 5 | 80.97 -> 82.11 | +1.14 |
| 6 | 82.11 -> 82.80 | +0.69 |
| 7 | 82.80 -> 83.59 | +0.79 |
| 8 | 83.59 -> 85.03 | +1.44 |

Deltas collapse as it nears equilibrium. Early cycles fill from far below the
ceiling and move 25-30 points; near setpoint the same 30s burst gives <1.

**Read the settled value, never mid-burst.** RH and dewpoint both *fall*
during a burst and recover during the settle -- the ultrasonic jet entrains
dry room air faster than the fog evaporates. Mid-burst readings look like the
atomizer is doing nothing. This nearly caused a false "intermittent
connection" diagnosis. The settle window exists precisely because the
transient is not the signal.

**FAE cost:** 90s @ 70% took RH 85.03% -> 75.15%, about -10 points.
**Recovery:** ~+2.6%/cycle, 3 cycles (~6 min) back to the band.

That ratio is the one that decides whether an FAE cadence is viable: recovery
must finish well inside the FAE period, or the chamber chases its own tail and
never reaches the band. 6 min recovery against a 15 min interval is
comfortable; at the design 40 min it is trivial.

**Watch the first ~10s of a vent** -- RH went *up*, 85.03 -> 87.68, dewpoint
with it. The fan mobilises water off wet surfaces before exchange dominates.
A short vent could leave the chamber wetter than it started.

### Humidity as a tracer gas

Useful trick: humidity measures air exchange, so you can estimate ACH without
a CO2 sensor. **Use dewpoint, not RH** -- dewpoint tracks absolute water
content and is not confounded by temperature drift.

Convert dewpoint to vapour pressure (Magnus), then:

    fraction replaced = (e_start - e_end) / (e_start - e_room)

For the 08-24 vent: 24.67 -> 20.83 hPa against room 13.94 hPa = **35.8% of
the air replaced in 90s**, implying **~17.7 air changes/hour** if run
continuously. Design target is 4-8, so the vent may want to be *shorter* than
90s once the real chamber is sealed.

Two caveats:

- **It is a floor, not a ceiling.** Wet chamber surfaces evaporate during the
  vent and put water back, masking part of the exchange. CO2 has no such
  replenishment from the walls, so true air exchange is higher.
- **CO2 will not mirror it**, because mycelium is a CO2 *source*. Water only
  leaves during a vent; CO2 leaves and is continuously produced, so CO2
  rebounds faster. This gets you the air-change rate, not the production rate
  you are fighting -- which is still the argument for the SCD41.

---

## Setpoints

| Parameter | Target |
|---|---|
| RH | 85–95% |
| CO2 | < ~1000 ppm |
| Light | ~200 lux, ~12 h/day |
| Temp | 18–24°C (oyster, lion's mane) |
| FAE | ~4–8 air changes/hour |

**Sequencing:** FAE and misting oppose each other. Vent first, *then* mist to
recover RH. Never run both at once.

**Never blow air directly on fruiting bodies** — dries pins, causes aborts and
cracked caps. Exchange headspace air only; baffle the exhaust.

**Light is a pinning trigger, not photosynthesis.** Full 1m strip at 100% is
~11,000 lux; need ~200.

~~Use a 15–20cm segment rather than the full meter at 2% — better PWM
resolution.~~ **Corrected 2026-08-15: resolution is not a constraint on this
board.** `FspTimer` derives the PWM period from PCLKD (48 MHz) with a 32-bit
counter, so 1 kHz gives ~48,000 counts per period — even 2% duty leaves ~960
steps. The concern was 8-bit `analogWrite()` thinking, where 2% really is ~5
steps.

With resolution off the table, prefer a **longer run, lower duty**:

- **Uniformity** — a short segment over an 11L tub is nearly a point source,
  bright underneath and dim at the corners. Even light, even pinning
- **Thermal** — same light output either way, but spread over more length is
  lower linear power density and longer strip life

Measure before cutting: lay the uncut strip where it will live and read lux
**through the lid at substrate height** (IP30 means the strip stays outside,
so lid transmission is part of the system). Pick a length that puts the
operating point around 20–50% duty.

Cut only on the marked lines — LEDs are in series groups of three — and note
a cut end needs soldering or a clip connector to re-terminate.

---

## Pin map (planned — verify against shield labels)

| Pin | Function |
|---|---|
| D9 | LED strip PWM → MOSFET gate |
| D10 | Atomizer on/off → MOSFET gate |
| D11 | Heater on/off → MOSFET gate (stub, config-flagged off) |
| D3 | Fan PWM (blue wire) — 25 kHz via `PwmOut`, GPT channel 1 |
| D2 | Fan tach (green wire) — `INPUT_PULLUP` + FALLING interrupt |
| ~~D4~~ | ~~Float switch~~ — dropped, replaced by software interlock |

**Verified as built on the soldered shield, 2026-08-17.**

Pin capability notes, from the variant tables:

- **Only the fan and LED genuinely need PWM pins.** Atomizer and heater are
  on/off, so they can move to any digital pin for layout convenience
- **No analog pin has PWM.** A0–A3 cannot drive the fan
- **A0 has no interrupt either** (analog/DAC only), so it cannot take the
  tach. A1/A2/A3 can
- Free PWM pins if the fan needs relocating: D5, D6
- D2 and D3 share GPT channel 1; fine here since D2 is only an interrupt input
| Wire1 | SHT41 `0x44` → SCD41 `0x62` (daisy-chained via Qwiic) |

Each MOSFET channel: IRLZ44N + 150Ω gate series + 10kΩ gate pulldown.

**Pulldowns are not optional.** Arduino pins float during boot/reset; a
floating gate can drift partly on and fire the atomizer before firmware has
checked the water level.

Arduino default PWM is 490/980 Hz — fan spec wants **25 kHz** or it buzzes.

---

## Wiring rules

- Shield's built-in screw terminals are **signal only** — they're wired to
  MCU pins. Never land 12V there.
- Add separate terminal blocks in the proto area for 12V rail, switched
  outputs, and power ground bus.
- Power ground gets its own current path; tie to Arduino GND at a single point.
- All grounds common, or MOSFET gates have no reference and nothing switches.
- Tape over the USB connector before seating the shield (classic Uno short).
- Connectorize every wall penetration — you'll be opening this constantly.
- IRLZ44N pinout (facing label, legs down): **G, D, S**. Tab is drain.

---

## Contamination — the dominant failure mode

Ultrasonic humidifiers aerosolize whatever lives in the reservoir, straight
into the chamber.

- Distilled water only — biology, not just scale
- Drain and dry the reservoir between runs; standing water breeds bacteria
  within days
- Sanitize reservoir and duct regularly (isopropyl or dilute bleach rinse)
- Filter the intake — see "Airflow architecture" for media selection
- **Perlite layer in the chamber floor** as a passive humidity buffer. Cuts
  atomizer duty dramatically, which cuts aerosolization
- Watch lid condensation — drips onto fruits cause bacterial blotch

---

## Fog ducting

Ultrasonic fog is a droplet aerosol, not vapor. It's heavy, falls, and
condenses fast. Expect 2–3 attempts here.

- Shortest run possible, ideally < 15cm
- Widest bore practical, 20mm+ ID
- Slope downhill toward the reservoir so condensate drains back
- Use assist air — a small fan across the reservoir surface moves fog far
  better than letting it drift
- Don't glue anything permanently until fog actually arrives in the chamber
- Hot melt fails in warm/humid/wet conditions. Use 100% silicone
  (aquarium-grade) or E6000 for anything sealing or structural

---

## Airflow architecture — SETTLED

**Positive pressure. Fan pushes filtered air IN. PTFE patch on the exhaust.**

Serves both goals at once, but only if the tub is sealed:

- Contaminants can't enter — all inflow is through the fan filter
- Spores can't escape unfiltered — all outflow is forced through the PTFE patch

**Seal quality is load-bearing.** A leaky tub defeats spore containment (air
escapes through seams instead of the filter).

- [ ] Closed-cell foam weatherstrip around the lid rim
- [ ] Latches/clamps to actually compress the gasket — resting on foam ≠ sealed
- [ ] Silicone every penetration

Pressure is negligible (~40 Pa max) — no risk of bulging the tub.

### "Sealed" during colonization ≠ airtight

Mycelium consumes O2. Fully airtight for weeks suffocates it — this is exactly
why grow bags have filter patches.

The PTFE patch does double duty:

- **Colonization:** passive gas diffusion (its native design purpose)
- **Fruiting:** filtered outflow under positive pressure

This is the argument for PTFE over pleated media on the exhaust — coarse media
doesn't give sterile passive diffusion during the vulnerable stage.

### Filter selection

| Port | Media | Why |
|---|---|---|
| Fan intake | Pleated (MERV 11–13) or polyfill | Low ΔP; fruiting-stage risk is low |
| Exhaust | PTFE micron patch | Passive diffusion + spore capture |

**Fruiting-stage contamination risk is low** — substrate arrives colonized and
mycelium defends its territory. Don't over-filter the intake; a 0.2 µm patch in
front of a 40mm fan is a plug.

**Oyster spores are ~8–11 µm** — a 0.2 µm rating is ~50× overkill for spore
capture. That rating is for bacteria (colonization concern), not spores.

### Sizing the exhaust

PTFE restriction is real for fruiting FAE. Options:

- Multiple PTFE patches in parallel — one port, more area, simplest
- Two exhaust ports: small PTFE for passive colonization + larger coarse-filtered
  port used only during fruiting. More plumbing, much better airflow

Verify with the CO2 decay curve, don't guess.

### Fan duty — bursts, not continuous

Static pressure scales with RPM². At 30% duty you've lost ~90% of it and may
move no air through a filter at all.

Run **60–80% duty for 60–90s, several times an hour** — not low continuous.
Matches how FAE should work anyway, and no persistent draft on the fruits.

NF-A4x20 is ~4 mm H2O at full speed (the 20mm thickness is why — A4x10 is much
weaker).

### Spore control that isn't filtration

- **Harvest timing does more than any filter.** Oysters release spores once caps
  flatten or upturn. Pick just before, while caps still curl under. Free
- **Species choice** — lion's mane sporulates far less than oyster. Sporeless
  oyster strains exist, bred for exactly this reason

---

## Two operating modes

| | Colonization | Fruiting |
|---|---|---|
| Fan | Off | Burst FAE |
| Light | Off | ~200 lux, 12h |
| Mist | Minimal / off | 85–95% RH |
| CO2 | High, uncontrolled | < ~1000 ppm |
| Exhaust | Passive diffusion | Filtered outflow |

High CO2 during colonization is *desirable* — favors vegetative growth,
suppresses premature pinning. FAE only matters at fruiting.

---

## Telemetry

R4 has ~32KB RAM — enough for the control loop, nowhere near enough for
history. Ship data off-board.

### The rule

**Control logic stays entirely on the Arduino. Telemetry is fire-and-forget.**

If WiFi drops, the mushrooms still need misting. The chamber must never depend
on the network to function.

- No blocking network calls in the control loop
- Short timeouts; drop failed sends rather than retrying
- Setpoints live in firmware/EEPROM, not fetched from a server

### What's actually built (2026-08-15)

Not MQTT yet. `chamber_telemetry` POSTs InfluxDB line protocol over HTTP to
`collector/collector.py` on the Mac, which stamps on receipt and appends CSV.
Zero infrastructure; swapping to MQTT later only touches `publish()`.

- Sensor sampled at 1 Hz, published every 20 s, all `millis()`-scheduled
- Failed POSTs are counted and dropped — never retried, never queued
- Readings also print to serial, so USB logging works with WiFi down
- Sensor failure re-inits on a timer rather than halting. The early sketches
  used `while(1)` on a missing SHT41, which would brick an unattended run
  over one transient I2C glitch
- `while (!Serial)` is bounded to 3 s, or the board hangs forever when run
  headless on a USB brick with no Mac attached
- Payload carries `fan_duty_pct` and `light_duty_pct` so a run proves what the
  actuators were doing rather than us assuming it
- **Light channel is live** on D9: IRLZ44N low-side, 1 kHz PWM, 25% duty,
  12h on / 12h off. The cycle is measured from boot, not wall clock — a power
  cut re-phases day/night. Accepted: the cycle existing matters far more than
  its phase, and there is no reliable clock on this board anyway.
  `LIGHT_ENABLED = false` suppresses it for colonization without rewiring
- **Known gap:** `WiFi.begin()` still blocks on reconnect. Publishing is
  fire-and-forget, reconnection is not

Collector endpoints: `POST /ingest`, `GET /` status page, `GET /data.csv`.

### Transport: MQTT (planned)

- Persistent connection, low per-message overhead
- Bidirectional — push setpoint changes down without an HTTP server on the device
- **Last Will and Testament** → broker publishes "offline" automatically if the
  controller dies. Free dead-device alerting on an unattended chamber
- Decouples device from storage; swap backends without touching firmware

### Sink

| Option | Effort | Notes |
|---|---|---|
| Home Assistant | Low | MQTT discovery, long-term stats, **mobile push alerts** |
| Mosquitto → Telegraf → InfluxDB → Grafana | Medium | Classic stack, best graphs |
| Direct HTTP → InfluxDB line protocol | Lowest | No broker; data only, no commands |
| Adafruit IO / ThingSpeak | Lowest | Free tiers, limited retention |

Leaning Home Assistant if plausible — 3am alerting matters more than pretty
graphs. Data volume is trivial either way (~50k points/day).

### Firmware notes

- **Server timestamps on receipt.** Don't sync NTP / send device timestamps —
  less code, less RAM, one less failure mode. R4 RTC loses time on power cycle
  without a backup battery anyway
- **Line protocol over JSON** — string concat is far cheaper than ArduinoJson
  on 32KB
- **Publish on its own timer.** Control at 1Hz, telemetry every 15–30s
- **Skip TLS on the local network** — heavy on WiFiS3, buys nothing behind the
  firewall

### Log actuator state, not just sensors

Without it you can see RH dropped but not whether the humidifier was trying.
Every tuning question needs cause and effect on one timeline.

- **Sensors:** temp, RH, dewpoint, CO2
- **Actuators:** mist on/off, fan duty, light duty, heater on/off
- **Derived:** cumulative mist mL, fan RPM from tach
- **Diagnostics:** WiFi RSSI, uptime, sensor error counts

Fan RPM specifically — it's the only way to catch a stalled fan before CO2
climbs.

---

## Optional: heating

Leave a spare MOSFET channel and free pin. Add only if baseline logging shows
winter nights dropping out of range.

- 12V **PTC** heating film, 10–20W, adhesive to outside of tote
- PTC is self-regulating — resistance rises with temperature, so it physically
  cannot run away. A plain resistive pad with a failed sensor means 100% duty
  into a plastic tote
- Add a firmware max-temp cutoff regardless; hardware is the real backstop
- No new sensor needed — SHT41 already reports temperature
- 11L needs only ~6W to hold +5°C over ambient

---

## Rejected

**Active cooling.** A TEC1-12706 pulls 6A at 12V (double the whole supply),
needs heatsinks and fans on both faces, and at 95% RH the cold side becomes a
condensation machine inside a chamber whose purpose is staying humid. If
cooling is ever genuinely needed (e.g. king oyster), use a thermoelectric wine
cooler or small fridge *as* the chamber instead.

**Free alternative:** more FAE pulls chamber temp toward ambient at no
hardware cost. Bias toward venting when warm and CO2 allows.

---

## Known constraints

- 11L is small — roughly one fruiting block. Standard chambers are 50–60L.
- No temperature control as built. Fine at 21°C ambient for oyster and lion's
  mane; shiitake is at the top edge, king oyster too warm.
- LED strip is IP30 — **must** stay outside the chamber.
