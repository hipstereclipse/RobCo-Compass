# COMPASS — RobCo Navigation for the Pip-Boy 3000

A centered circular digital compass for **The Wand Company Pip-Boy 3000** (the 1:1
Fallout 3 / New Vegas replica, Espruino on STM32F407VE). Rendered as a RobCo
terminal instrument — green phosphor, Monofonto, all-caps, scanline flip — with
two sub-screens: **CALIBRATE** and **MORSE**. Installs as **Compass** under
**ITEMS › MISC**.

Built in the style of, and feature-compatible with, the reference apps:
[Robco-Chronometer](https://github.com/hipstereclipse/Robco-Chronometer),
[Robco-Calculator](https://github.com/hipstereclipse/Robco-Calculator),
[Robco-Weather](https://github.com/hipstereclipse/Robco-Weather).

> **Highly experimental. Please do not attempt to use this for survival.** This is
> a hobby instrument for a replica prop, not certified navigation equipment — read
> the honesty section below to understand exactly what it can and cannot do.

---

## Screenshots

![The four Compass screens — home compass, calibrate, Morse keypad, Morse transmit](screenshots/preview-contact-sheet.png)

| HOME / COMPASS | CALIBRATE |
|:---:|:---:|
| ![Home compass screen](screenshots/01-home.png) | ![Calibrate screen](screenshots/02-calibrate.png) |
| **MORSE — compose** | **MORSE — transmit** |
| ![Morse keypad](screenshots/03-morse-keypad.png) | ![Morse transmitting](screenshots/04-morse-transmit.png) |

<sub>These are **generated from the real app code**, not mock-ups — `npm run shots`
runs the shipping `src/COMPASS.JS` against a software rasterizer and captures the
framebuffer. See [docs/MAINTAINING.md](docs/MAINTAINING.md#4-the-four-pipelines).
Theme toggles between Fallout-3 green and New-Vegas
[amber](screenshots/05-home-amber.png).</sub>

---

## Documentation

| Doc | For |
|---|---|
| **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** | How the program works — a guided tour of every subsystem, with diagrams and screenshots. |
| **[docs/MAINTAINING.md](docs/MAINTAINING.md)** | Taking over the code — toolchain setup, the build/test/screenshot pipeline, copy-paste recipes, and the platform footguns. |
| **[docs/README.md](docs/README.md)** | Documentation index. |

**One-click installer:** open [`install.html`](install.html) in Chrome or Edge to
write the app straight to a mounted microSD card (or download a `.zip` to extract).
See [Install](#install).

---

## ⚠️ Honesty & caveats — read this first

**An accelerometer measures gravity (tilt), not heading.** Rotating a level
device left/right about the vertical axis produces *zero* change in the
accelerometer, because gravity is invariant under rotation about its own axis.
You **cannot** derive a compass heading from an accelerometer alone — and this
app never pretends to.

The Pip-Boy 3000 has a **confirmed accelerometer** (it powers the RAD tilt /
shake-to-fix-CRT effects). It has **no publicly confirmed magnetometer or
gyroscope.** So the app probes the hardware at runtime and picks the most honest
heading source available. The on-screen `MODE:` line always tells you which one
is live:

| Mode shown | When | What it means |
|---|---|---|
| `MODE: MANUAL BEARING` | accelerometer-only (**the confirmed hardware → this is what ships**) | Continuous yaw cannot be sensed. The heading is the bearing you set in CALIBRATE; you nudge it manually. An optional, clearly-labelled low-confidence turn-gesture estimate can be enabled, but it is never presented as a real compass. |
| `MODE: MAGNETIC` | a magnetometer is detected | True tilt-compensated compass. CALIBRATE sets declination so a known bearing reads correctly. |
| `MODE: DEAD-RECKONING — RECAL ADVISED` | a gyro (+accel) is detected | Calibrate to a known bearing, then integrated yaw-rate tracks turning. Drifts over time — recalibrate periodically. |

**On today's confirmed hardware you should expect `MANUAL BEARING`.** The
MAGNETIC and DEAD-RECKONING paths are fully implemented and will light up
automatically *if* a future firmware/hardware revision exposes those sensors —
but the app will not claim a capability it cannot back up.

Other honestly-flagged assumptions (the app feature-detects and degrades, never
crashes — see [Hardware assumptions](#hardware-assumptions)):

- **Rear torch LED** may be OS-only (toggled by long-pressing ITEMS), not
  JS-addressable. The Morse "Torch/LED" flash drives the addressable **green
  panel LED** and tries a `Pip.torch`-style hook if one exists; the **screen
  flash always works** as a guaranteed fallback.
- **Accelerometer read call** is not in the public SDK; the app probes a
  `Pip.on('accel')` event stream plus a few poll methods.
- **No GPS** — latitude/longitude for solar calibration is entered by hand and
  persisted (Weather-app style).

---

## Install

> **Back up your entire SD card before changing anything.**
> **Never click "Send to Espruino" / the upload or flash icons in the Web IDE** —
> that can overwrite firmware and brick the device. This app is installed by
> **copying files to the SD card**, not by flashing.

### Option A — one-click web installer (easiest)

Open [`install.html`](install.html) in **Chrome or Edge** (it can also be served
from GitHub Pages). Click **Select microSD Root**, pick the mounted card, and hit
**Install** — it downloads the payload from this repo and writes `APPS/` +
`APPINFO/` for you. If your card throws a `NotReadableError` (a known
removable-media quirk), use **Download .zip** instead and extract it to the card
root. Works in any browser, writes nothing directly.

### Option B — copy the files by hand

1. Power off the Pip-Boy and remove the microSD card (or use the USB-C web file
   manager).
2. Copy these three files onto the card, preserving folders:
   ```
   APPS/COMPASS.JS          <- the minified device build
   APPINFO/COMPASS.info
   APPINFO/HOLO.IMG
   ```
3. Reinsert the card and **reboot**. **Compass** appears under **ITEMS › MISC**.

> Menu ordering is controlled by the OS. The name "Compass" sorts near the top of
> MISC; if your firmware sorts differently, that's cosmetic only.

---

## Controls

`K1` = Knob 1 (turns **and** presses). `K2` = Knob 2 (**turn only** — this
firmware exposes no Knob-2 press). **TORCH** = the torch button, repurposed in-app
as **BACK / panic-STOP**. **ITEMS** exits the whole app (the app sets
`notDefault:true`). The active bindings are drawn in the footer of every screen.

### HOME (compass)
| Control | Action |
|---|---|
| **K1 turn** | Move highlight across `COMPASS → CALIBRATE → MORSE` |
| **K1 press** | Open the highlighted sub-screen |
| **K2 turn** | Nudge the held bearing ±1° |
| **TORCH** | (no-op on home) |
| **ITEMS** | Exit Compass |

### CALIBRATE
| Control | Action |
|---|---|
| **K2 turn** | Select field: `METHOD · BEARING · TRIM · DECL · LAT · LON · UTC · ACTION` |
| **K1 turn** | Change the selected field's value |
| **K1 press** | Context action: toggle coarse/fine on `BEARING`, flip `METHOD`, or run the selected `ACTION` |
| **ACTION** values | `APPLY` · `CAPTURE SUN` · `TOGGLE THEME` · `RESET CAL` |
| **TORCH** | Back to HOME |

### MORSE
| Control | Action |
|---|---|
| **K1 turn** | Move keypad **row** |
| **K2 turn** | Move keypad **column** |
| **K1 press** | Select key under cursor |
| keys | `A–Z 0–9 . , ? /`, plus `SPC DEL CLR WPM- WPM+ RPT TGT TX STOP` |
| **TORCH** | **STOP transmission** (or back to HOME when idle) |

---

## CALIBRATE in detail

Two methods, toggled with the `METHOD` field:

- **MANUAL (knobs).** Set `BEARING` = "the direction I am currently facing".
  K1 press toggles coarse (×10°) / fine (×1°). `TRIM` applies a fine offset to
  every reading; `DECL` is magnetic declination (only meaningful in MAGNETIC
  mode).
- **SOLAR (aim at the sun).** Point the top **lubber line** straight at the sun,
  select `ACTION = CAPTURE SUN`, and press. The app computes the sun's **true
  azimuth** from the device clock + your saved latitude/longitude (NOAA
  declination + equation-of-time algorithm) and sets the reference so
  *lubber direction = solar azimuth at that instant*.
  - Set `LAT`/`LON` with K1 (persisted). Set `UTC` to your clock's offset from
    UTC so the solar time is correct.
  - **Accuracy honesty:** the sun is due-east/due-west only at the equinoxes, so
    the app prefers the *computed* azimuth over assuming 090°/270°. With no
    location set it falls back to a coarse N-hemisphere `Sunrise≈E /
    Solar-noon≈S / Sunset≈W` and says so on screen.

What a capture sets depends on the live mode (per the physics): **MANUAL** → the
held bearing; **DEAD-RECKONING** → the absolute integrator reference; **MAGNETIC**
→ the declination offset. `RESET CAL` clears bearing/trim/declination.

---

## MORSE in detail

Compose a message on the grid keypad (Calculator idiom: K1 rows, K2 columns, K1
press selects). The screen shows the composed text and a live `· —` preview.

**Transmit (`TX`)** flashes the **screen** and the **LED/torch** together using
standard relative Morse timing — dot = 1 unit, dash = 3, intra-character gap = 1,
inter-character gap = 3, inter-word gap = 7 — with `unit_ms = 1200 / WPM` (PARIS
standard). Everything is easy to change live:

| Setting | Key | Range / values |
|---|---|---|
| **Speed** | `WPM-` / `WPM+` | 1–60 WPM, with live `unit ms` readout |
| **Repeat** | `RPT` | `ONCE` → `×N` (N = repeat count) → `LOOP` until stopped |
| **Flash target** | `TGT` | `SCREEN` / `TORCH/LED` / `BOTH` |

**Stop** is instant: press `STOP`, or the **TORCH** button, at any time. Leaving
the screen and `remove()` also kill every transmit timer and force the screen +
LED back to a safe idle — there are no orphaned flashers.

---

## Theme

Single hue at multiple brightness levels on near-black — **never** a second hue
on screen. Default **Fallout-3 green** `#1AFF80`; toggle to **New-Vegas amber**
`#FFB642` via `CALIBRATE → ACTION → TOGGLE THEME` (persisted). The native
scanline/phosphor flip is provided by the device; the app just draws in the
palette.

---

## Hardware assumptions

Everything below is **feature-detected at runtime**; a missing feature degrades
gracefully and is reflected on screen.

| Concern | What the app does | If wrong |
|---|---|---|
| **Graphics instance** | Prefers `h` (3000), then `bC`/`g` (Mk V); uses `.flip()` if present | Falls back to direct draw |
| **Knob/torch events** | `Pip.on("knob1"\|"knob2"\|"torch")`; `dir===0` press / `±1` turn; K2 turn-only | Controls designed to never need a K2 press |
| **Accelerometer** | `Pip.on('accel')` event stream + `Pip.accelRd/getAcceleration/accel` poll probes | Tilt features off; MANUAL bearing still works |
| **Magnetometer / gyro** | Probes `Pip.magRd/gyroRd/…`; absent on confirmed hw | Stays in honest MANUAL mode |
| **Torch / LED** | `Pip.torch`/`setTorch` if present, else `digitalWrite(LED_GREEN,…)` | Screen flash is the guaranteed path |
| **Audio** | `Pip.audioBuiltin("CLICK"/"OK"/…)`, guarded | Silent if ids differ |
| **Persistence** | `require("fs")` → `Storage` → `E.openFile` for `USER/COMPASS.SET`, all in try/catch | Defaults used; never crashes |

Confirmed pin aliases used: `LED_GREEN = E5`, `BTN_TORCH = A2`, knobs on
`A3/A10/A8/B1/B0`. Sources:
[official SDK](https://github.com/thewandcompany/pip-boy) ·
[RobCo docs](https://log.robco-industries.org/documentation/pipboy-3000/) ·
[hardware deep-dive](https://log.robco-industries.org/log/entry012/) ·
[Espruino IMU modules](https://www.espruino.com/Accelerometer).

---

## Build (producing the minified `APPS/COMPASS.JS`)

Readable source lives in [`src/COMPASS.JS`](src/COMPASS.JS); the file shipped to
the card under `APPS/` is the **terser-minified build** (~13.5 KB vs ~35 KB
source — the kind of reduction that keeps you clear of `LOW_MEMORY` / `ERROR:
CALLBACK`). **Never hand-edit the minified file** — regenerate it:

```bash
npm install          # installs terser
npm run build        # src/COMPASS.JS -> APPS/COMPASS.JS  (minified)
npm run icon         # regenerate APPINFO/HOLO.IMG (64x64 1-bpp glyph)
npm run shots        # regenerate screenshots/*.png from the real app code
npm test             # mock-hardware smoke test (see below)
```

> Build note: the app file is a single top-level **function expression** that the
> loader `eval()`s and calls. The build sets terser `compress.side_effects:false`
> so the compressor doesn't delete it as a "useless" statement (which would
> silently produce an empty build). If terser isn't installed, `build.js` falls
> back to a conservative comment/whitespace strip and warns.

### Tests

`npm test` ([`tools/test-harness.cjs`](tools/test-harness.cjs)) stubs the
Espruino globals, evaluates the factory and drives the full flow — asserting the
honest `MODE` line, solar capture + persistence, synchronised Morse flashing, the
sensor-upgrade branches, and that `remove()` detaches every listener/timer and
leaves the torch off. It's a **logic** smoke test, not a hardware substitute.

---

## Dev workflow & safety

1. **Prototype** on the [pip-boy.com](https://www.pip-boy.com) 3000 simulator
   before hardware.
2. **Develop live** in the Espruino Web IDE REPL over Web Serial (Chrome). Use
   the REPL to confirm the real accel/torch/graphics API on *your* firmware:
   ```js
   // in the device REPL — see what's actually exposed:
   Object.keys(Pip).filter(k => /accel|mag|gyro|torch|led/i.test(k));
   Pip.on('accel', a => print(a));   // does an accel event stream exist?
   ```
3. **Install by copying files** to the SD card and rebooting. **Do not flash.**
4. **Back up the SD card** before any change.

---

## File manifest

```
src/COMPASS.JS            readable, commented ES5 source (edit this)
APPS/COMPASS.JS           minified device build (generated — copy to card)
APPINFO/COMPASS.info      launcher manifest (copy to card)
APPINFO/HOLO.IMG          64x64 1-bpp holotape icon (copy to card)
install.html             one-click RobCo web installer (Chrome/Edge)
docs/                    ARCHITECTURE.md + MAINTAINING.md deep-dive guides
screenshots/             generated UI images (npm run shots)
tools/build.js            terser minifier  (src -> APPS)
tools/make-icon.js        regenerates HOLO.IMG
tools/render-screens.cjs  runs the real app -> PNG screenshots (npm run shots)
tools/test-harness.cjs    mock-hardware smoke test (npm test)
package.json              build/test scripts + terser devDependency
LICENSE                  Apache License 2.0
```

`COMPASS.info`:
```json
{
  "id": "robco-compass",
  "name": "Compass",
  "version": "1.00",
  "files": "APPS/COMPASS.JS,APPINFO/COMPASS.info,APPINFO/HOLO.IMG",
  "src": "APPS/COMPASS.JS",
  "icon": "APPINFO/HOLO.IMG"
}
```
(`id`/`version`/`files` are for loaders & uninstall, not the Pip-Boy itself;
`src` is what runs; `icon` is required.)

---

## License

Licensed under the **Apache License, Version 2.0** — see [LICENSE](LICENSE). You
may use, modify, and redistribute this freely under its terms;
it is provided **as-is, without warranty** (which is doubly true for anything
calling itself a survival compass — see the disclaimer at the top).

*Fallout, Pip-Boy, RobCo, and Vault-Tec are trademarks of Bethesda Softworks /
ZeniMax. This is an unofficial, non-commercial fan project for The Wand Company's
licensed replica and is not affiliated with or endorsed by either company.*
