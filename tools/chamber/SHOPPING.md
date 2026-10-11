# Shopping List — Mushroom Chamber Controller

Checked items are already ordered or in hand.

---

## Already have

- [x] Arduino UNO R4 WiFi
- [x] Proto screw shield (DIYables, Uno R3/R4 compatible)
- [x] SHT41 breakout (STEMMA QT)
- [x] Ultrasonic atomizer module (5V, 108 kHz)
- [x] Noctua NF-A4x20 **5V** PWM fan
- [x] 12V COB LED strip (6500K, CRI 93, ~9.6W/m)
- [x] Qwiic / STEMMA QT cables — en route
- [x] Polyfill adhesive filter disks, 2.5" (6-pack)

---

## Power

- [ ] **12V 3A power supply**, 5.5×2.1mm barrel plug
      Covers ~15W LED + fan + atomizer + board, with margin
- [ ] **Barrel jack breakout** (5.5×2.1mm female → screw terminals)
      Lets you tap 12V without cutting the plug
- [ ] **Buck converter, 12V → 5V, 2A+**
      MP1584 or similar. **Set output to 5.0V with a multimeter BEFORE
      connecting anything** — adjustable modules ship at arbitrary voltages and
      will kill the atomizer and board. A fixed-5V module avoids this risk
      entirely and is worth the extra dollar
- [ ] **Inline fuse holder + 2A slow-blow fuse**
      Cheap insurance on an unattended device running 16h/day

R4 accepts 6–24V on its barrel jack, so it runs directly off the 12V rail.

---

## Sensors

- [ ] **SCD41 CO2 sensor** (STEMMA QT / Qwiic version)
      Chains off the SHT41. Disable ASC in firmware; recalibrate outdoors first
- [ ] *Optional:* second **SHT41** (~$7) as a cross-check
      Two sensors disagreeing tells you which one is wet or crept

---

## Switching

- [ ] **IRLZ44N** ×5 (need 3: LED, atomizer, heater — spares are cheap)
      Must be **logic-level**. IRLB8721 is an equivalent. **Not IRF520** —
      it won't fully turn on at 5V gate drive
- [ ] **150Ω resistors** ×10 (gate series)
- [ ] **10kΩ resistors** ×10 (gate pulldown — not optional, see BUILD.md)

A resistor assortment kit covers both and is useful later.

---

## Interlock

- [ ] **Float switch** (water level, small side-mount or vertical)
      Hard interlock against dry-firing the atomizer. Signal-level current, so
      almost any cheap unit works. Install *before* any automation

---

## Wiring and connectors

- [ ] **Screw terminal blocks**, 3.5mm pitch — 2-pin ×4, 3-pin ×1
      For the 12V rail and switched outputs in the proto area. The shield's
      built-in terminals are signal-only
- [ ] **Qwiic / STEMMA QT cables**, assorted lengths
      Short for chaining sensors, 200–500mm to reach into the chamber
- [ ] **4-pin fan extension cable** (cut in half for a clean pigtail)
      Or use the OmniJoin adapters Noctua included
- [ ] **Hookup wire** — 20 AWG (LED run), 22 AWG (signals)
- [ ] **Dupont jumpers** M-M and M-F, for bench prototyping
- [ ] **Heat shrink assortment**
- [ ] **WAGO 221 lever nuts** — for 12V distribution

---

## Optional

- [ ] **SSD1306 OLED**, Qwiic version (~$5)
      Shares the I2C bus. Local temp/RH/CO2/duty readout during tuning
- [ ] **12V PTC heating film**, 10–20W
      Only if baseline logging shows winter nights dropping out of range.
      **PTC specifically** — self-regulating, cannot thermally run away

---

## Tools

- [ ] **Soldering iron** — Pinecil V2 (~$40, needs a USB-C **PD** supply, which
      you may not already own) or Hakko FX-888D (~$110, self-contained)
- [ ] **Solder**, 63/37 leaded, 0.8mm rosin core — far easier than lead-free
- [ ] **Flux pen** — makes more difference than the iron does
- [ ] **Multimeter** — non-negotiable. Any $30 unit
- [ ] **Wire strippers**
- [ ] **Flush cutters**
- [ ] **Step drill bit (Unibit)** — clean holes in plastic; a twist bit cracks it
- [ ] **Electrical or Kapton tape** — over the USB connector before seating the
      shield (classic Uno short)
- [ ] *Optional:* helping hands / PCB vise

---

## Not electronics, but needed

- [ ] **PTFE filter patches** for the exhaust (sterile passive diffusion during
      colonization + spore containment during fruiting)
- [ ] **ePTFE vent patch** for the SCD41 — *expanded* PTFE, **not plumber's
      thread tape**, which is solid and blocks gas exchange entirely
- [ ] **Aluminum U-channel** for the LED strip (thermal — doubles strip life)
- [ ] **Silicone tubing**, 20mm+ ID, for the fog duct
- [ ] **100% silicone (aquarium-grade) or E6000** — hot glue fails in warm,
      humid, wet conditions
- [ ] **Closed-cell foam weatherstrip** + **latches/clamps** for the lid seal
      (load-bearing for the positive-pressure design)
- [ ] **Nylon standoffs/washers** — so the fan doesn't seal flush against the
      filter disk
- [ ] **Perlite** — passive humidity buffer, cuts atomizer duty
- [ ] **Distilled water** — scale and biology, not just purity
