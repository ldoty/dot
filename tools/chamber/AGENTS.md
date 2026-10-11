# Agent notes: Chamber

Mushroom fruiting chamber: an Arduino UNO R4 WiFi runs the climate (humidity, fresh air, light)
and reports telemetry; this tool will receive it and show it. `BUILD.md` is the hardware build
log and design record; read the relevant section before changing firmware behaviour.
Moved here from `~/Workspace/env_control` on 2026-10-11 (that folder still holds the run data
and the old `collector.py`; not tracked here).

**Control stays on the Arduino.** Telemetry is fire-and-forget: if the network or AWS is down
the chamber must keep running on its last settings. Nothing in the cloud side may become a
dependency of the control loop.

## Firmware

- `firmware/chamber_telemetry/` is the controller. Bump `FW_BUILD` on every flash; it is
  published in each reading so the data says which build produced it.
- `firmware/bench/` are one-off bench sketches (atomizer output weigh test, channel tests,
  I2C scan). `atomizer_output` is still needed: `MIST_ML_PER_MIN` is a placeholder.
- `arduino_secrets.h` is gitignored (WiFi password, later the device key). Copy
  `arduino_secrets.example.h` and fill it in.

## Toolchain (macOS, `arduino-cli`, no IDE)

```sh
arduino-cli compile -b arduino:renesas_uno:unor4wifi firmware/chamber_telemetry
arduino-cli upload  -b arduino:renesas_uno:unor4wifi -p /dev/cu.usbmodem… firmware/chamber_telemetry
```

Each of these cost a failed attempt or a false diagnosis:

- The port suffix changes between plug-ins: re-check with `arduino-cli board list`.
- **`upload` doesn't compile**: it flashes whatever was last compiled from that sketch folder.
  Always `compile` right before `upload`, especially after compiling with the example secrets.
- The `arduino:renesas_uno` core ships an x86_64-only compiler: Apple Silicon needs Rosetta 2
  ("bad CPU type in executable" otherwise).
- The library is **"Adafruit SHT4x Library"**; "Adafruit SHT4x" is "not found".
- `arduino-cli monitor` emits nothing when its stdout is redirected, and `script` can't wrap it.
  Read serial with pyserial (in a venv; it isn't in the system python3).
- **Never de-assert DTR.** DTR low (a 1200-baud touch, or toggling DTR to force a reset) drops
  the R4 into its CMSIS-DAP state: sketch stops, serial goes silent, only a USB replug recovers
  it. Every "board died / all channels dead" incident traced back to this. A serial reader must
  open the port and leave DTR asserted, so captures join a running sketch mid-stream.
- **Uploads can fail while the resident sketch is inside `WiFi.begin()`.** Arm a loop that
  retries the upload every 2 s, *then* replug USB; it catches the boot window. Do not reach for
  the RESET double-tap (makes it worse). When the resident sketch isn't stuck in WiFi, a plain
  upload works first time (2026-10-11).
- The firmware sends nothing while the atomizer is on, and counts each skipped send in
  `publish_failures`: gaps of ~50 s around a burst and a rising failure count are by design.

## Bench sessions with Luke

Luke is learning electronics as he builds. Explain the "why is this part here" (pulldowns,
grounds, slow-blow fuses) alongside the instruction, plainly; he asks for depth when he wants it.

During hands-on work he can't watch a screen. Arm a background watch on the telemetry that
emits **one line per state transition** (burst ran + RH rise and pass/fail, vent start/end,
safety block changes, reboots, stale telemetry) and relay each in a sentence or two. Detect
reboots by uptime going backwards (he power-cycles freely), set the stale threshold above the
burst gap (a 60 s burst sends nothing: use ~2 min), and don't repeat a question he hasn't answered.
