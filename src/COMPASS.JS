/* ============================================================================
 * COMPASS  -  RobCo Navigation instrument for The Wand Company Pip-Boy 3000
 * ----------------------------------------------------------------------------
 * A centered circular digital compass rendered as a RobCo terminal instrument,
 * with two sub-screens: CALIBRATE and MORSE.
 *
 * Target  : Espruino on STM32F407VE (Cortex-M4, tight RAM). ES5 only.
 * Style   : copied from Robco-Chronometer (draw dispatcher + ticker + fs),
 *           Robco-Calculator (grid-keypad: K1 rows, K2 cols, K1 press select)
 *           and Robco-Weather (lat/long + persisted USER config).
 *
 * THE HONEST PART (read this before judging the heading code):
 *   An accelerometer measures GRAVITY (tilt), not heading. Rotating a level
 *   device about the vertical axis produces zero change in the accelerometer,
 *   so you CANNOT derive a compass heading from the accelerometer alone.
 *   This app therefore never claims to. It probes the hardware and picks one of
 *   three HeadingProvider strategies:
 *     MAGNETIC        - true compass (only if a magnetometer is detected)
 *     DEAD-RECKONING  - gyro integrated from a known reference (only if a gyro
 *                       is detected); drifts, prompts recal
 *     MANUAL BEARING  - calibration-driven held bearing (accelerometer-only /
 *                       no extra sensor). THIS is what ships on confirmed
 *                       hardware, because only an accelerometer is confirmed.
 *   The on-screen MODE line always tells the truth about which one is live.
 *
 * Drawing instance, accel API, torch control and audio ids are FEATURE-DETECTED
 * because the public SDK does not document them all for this firmware. Every
 * hardware touch is wrapped so a missing feature degrades instead of crashing.
 * ==========================================================================*/

(function () {
  "use strict";

  var appId = "COMPASS";
  var SET_FILE = "USER/COMPASS.SET";

  /* ------------------------------------------------------------------ *
   *  GRAPHICS INSTANCE  (3000 = h ; Mk V = g direct / bC offscreen)
   *  Prefer the offscreen buffer so the native scanline flip applies.
   * ------------------------------------------------------------------ */
  var G =
    (typeof h !== "undefined" && h) ? h :
    (typeof bC !== "undefined" && bC) ? bC :
    (typeof g !== "undefined" && g) ? g : null;
  var HAS_FLIP = !!(G && typeof G.flip === "function");
  var W = G ? G.getWidth() : 480;
  var H = G ? G.getHeight() : 320;

  /* ------------------------------------------------------------------ *
   *  THEME  -  single hue at brightness levels on near-black.
   *  We only ever use ONE hue; setColor(r,g,b) maps to the nearest
   *  palette entry on a 2-bit buffer and renders true colour on g.
   * ------------------------------------------------------------------ */
  var THEMES = {
    green: [0.10, 1.00, 0.50], // Fallout 3  ~ #1AFF80
    amber: [1.00, 0.71, 0.26]  // New Vegas  ~ #FFB642
  };
  var LEVEL = [0.0, 0.30, 0.62, 1.0]; // 0 bg, 1 dim, 2 mid, 3 bright

  function col(lvl) {
    if (!G) return;
    var t = THEMES[cfg.theme] || THEMES.green;
    var b = LEVEL[lvl];
    try { G.setColor(t[0] * b, t[1] * b, t[2] * b); } catch (e) {
      try { G.setColor(lvl); } catch (e2) {} // fall back to palette index
    }
  }

  /* ------------------------------------------------------------------ *
   *  Thin draw helpers (match the reference repos' primitive names)
   * ------------------------------------------------------------------ */
  function setFontBig() { if (!G) return; try { G.setFont("Monofonto23"); } catch (e) { try { G.setFontVector(20); } catch (e2) {} } }
  function setFontSmall() { if (!G) return; try { G.setFont("Monofonto", 1); } catch (e) { try { G.setFontVector(12); } catch (e2) {} } }
  function align(x, y) { if (G && G.setFontAlign) try { G.setFontAlign(x, y); } catch (e) {} }
  function str(s, x, y) { if (G) try { G.drawString(s, x, y); } catch (e) {} }
  function line(x1, y1, x2, y2) { if (G) try { G.drawLine(x1, y1, x2, y2); } catch (e) {} }
  function rect(x1, y1, x2, y2) { if (G) try { G.drawRect(x1, y1, x2, y2); } catch (e) {} }
  function fillRect(x1, y1, x2, y2) { if (G) try { G.fillRect(x1, y1, x2, y2); } catch (e) {} }
  function circle(x, y, r) { if (G && G.drawCircle) try { G.drawCircle(x, y, r); } catch (e) {} }
  function sw(s) { try { return G.stringWidth(s); } catch (e) { return s.length * 10; } }

  function beep(id) { try { if (typeof Pip !== "undefined" && Pip.audioBuiltin) Pip.audioBuiltin(id); } catch (e) {} }

  var DEG = Math.PI / 180;
  function rad(d) { return d * DEG; }
  function pad(n, w) { n = "" + n; while (n.length < w) n = "0" + n; return n; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function wrap360(d) { d = d % 360; if (d < 0) d += 360; return d; }

  /* ============================================================ *
   *  CONFIG  +  PERSISTENCE  (fs -> Storage -> E.openFile, all
   *  guarded so a missing/corrupt file never crashes the app)
   * ============================================================ */
  var cfg = {
    theme: "green",
    bearing: 0,        // held heading: "I am facing this many degrees"
    trim: 0,           // fine manual offset applied to every reading
    decl: 0,           // magnetic declination (mag mode only)
    lat: 0, lon: 0, locSet: false, // observer location for solar azimuth
    utcOff: 0,         // hours to subtract from device clock to get UTC
    wpm: 12,           // Morse speed
    repeatMode: 0,     // 0 once, 1 N times, 2 loop
    repeatCount: 3,
    flashTarget: 2,    // 0 screen, 1 torch/LED, 2 both
    motionEst: false   // low-confidence accel turn-gesture nudging (off)
  };

  function readRaw(path) {
    try { return require("fs").readFileSync(path); } catch (e) {}
    try { return require("Storage").read(path.replace(/^USER\//, "")); } catch (e) {}
    try { var f = E.openFile(path, "r"); if (f) { var s = f.read(4096); f.close(); return s; } } catch (e) {}
    return null;
  }
  function writeRaw(path, data) {
    try { require("fs").writeFileSync(path, data); return true; } catch (e) {}
    try { require("Storage").write(path.replace(/^USER\//, ""), data); return true; } catch (e) {}
    try { var f = E.openFile(path, "w"); if (f) { f.write(data); f.close(); return true; } } catch (e) {}
    return false;
  }
  function loadCfg() {
    var raw = readRaw(SET_FILE);
    if (!raw) return;
    try {
      var o = JSON.parse(raw);
      for (var k in o) if (cfg.hasOwnProperty(k)) cfg[k] = o[k];
    } catch (e) { /* corrupt file -> keep defaults */ }
  }
  function saveCfg() { try { writeRaw(SET_FILE, JSON.stringify(cfg)); } catch (e) {} }

  /* ============================================================ *
   *  ACCELEROMETER abstraction
   *  The read call is NOT documented in the public SDK, so we probe
   *  a few known idioms and cache whichever delivers data. Returns
   *  {x,y,z} in g, or null. Used for tilt display, mag-mode leveling,
   *  the optional turn-gesture estimate and shake-to-recenter.
   * ============================================================ */
  var Accel = (function () {
    var last = null, evtSeen = false, onAccelRef = null, method = "none";

    function onAccelEvt(a) {
      if (!a) return;
      evtSeen = true;
      last = { x: +a.x || 0, y: +a.y || 0, z: +a.z || 0 };
    }
    function init() {
      // 1) Bangle/Espruino-style event stream (most likely on this firmware)
      try {
        if (typeof Pip !== "undefined" && Pip.on) {
          onAccelRef = onAccelEvt;
          Pip.on("accel", onAccelRef);
          if (Pip.accelOn) try { Pip.accelOn(12.5); } catch (e) {}
          method = "event";
        }
      } catch (e) {}
    }
    function read() {
      // 2) Direct poll methods, if the firmware exposes any
      if (typeof Pip !== "undefined") {
        try { if (Pip.accelRd) { var r = Pip.accelRd(); if (r) return (last = r); } } catch (e) {}
        try { if (Pip.getAcceleration) { var r2 = Pip.getAcceleration(); if (r2) return (last = r2); } } catch (e) {}
        try { if (Pip.accel && typeof Pip.accel.x === "number") return (last = Pip.accel); } catch (e) {}
      }
      return last; // newest event sample, or null if nothing ever arrived
    }
    function available() { return evtSeen || method !== "none" || last !== null; }
    function stop() {
      try { if (onAccelRef && Pip.removeListener) Pip.removeListener("accel", onAccelRef); } catch (e) {}
      try { if (typeof Pip !== "undefined" && Pip.accelOff) Pip.accelOff(); } catch (e) {}
    }
    return { init: init, read: read, available: available, stop: stop };
  })();

  /* ============================================================ *
   *  SOLAR AZIMUTH  (NOAA algorithm: declination + equation of
   *  time).  Fed UTC derived from the device clock and cfg.utcOff.
   *  Returns the sun's true compass bearing in degrees, or null
   *  if no location is set (caller then uses the coarse fallback).
   * ============================================================ */
  function dayOfYear(d) {
    var start = new Date(d.getFullYear(), 0, 0);
    return Math.floor((d - start) / 86400000);
  }
  function solarAzimuth(lat, lon, when, utcOff) {
    if (lat === 0 && lon === 0 && !cfg.locSet) return null;
    var d = when || new Date();
    // device clock -> UTC fractional hour
    var utHour = (d.getHours() - (utcOff || 0)) + d.getMinutes() / 60 + d.getSeconds() / 3600;
    var n = dayOfYear(d);
    var gamma = (2 * Math.PI / 365) * (n - 1 + (utHour - 12) / 24);
    var eqtime = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
      - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma)); // minutes
    var decl = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
      - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
      - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma); // radians
    // true solar time (minutes); longitude east-positive, tz handled via utHour
    var tst = (utHour * 60) + eqtime + 4 * lon;
    var ha = (tst / 4) - 180; // hour angle, degrees
    var latR = rad(lat), haR = rad(ha);
    var cosZen = Math.sin(latR) * Math.sin(decl) + Math.cos(latR) * Math.cos(decl) * Math.cos(haR);
    cosZen = clamp(cosZen, -1, 1);
    var zen = Math.acos(cosZen);
    var sinZen = Math.sin(zen);
    if (Math.abs(sinZen) < 1e-6) return 180; // sun at zenith: bearing undefined
    var cosAz = (Math.sin(decl) - Math.sin(latR) * cosZen) / (Math.cos(latR) * sinZen);
    var az = Math.acos(clamp(cosAz, -1, 1)) / DEG; // 0 = north
    if (ha > 0) az = 360 - az; // afternoon -> west of south
    return wrap360(az);
  }
  // Coarse N-hemisphere fallback when no location is set.
  function coarseSolar(kind) {
    // kind: 'now' uses clock to pick nearest of sunrise/noon/sunset
    var hr = new Date().getHours();
    if (kind === "sunrise") return 90;
    if (kind === "noon") return cfg.lat < 0 ? 0 : 180;
    if (kind === "sunset") return 270;
    if (hr < 10) return 90; if (hr < 14) return (cfg.lat < 0 ? 0 : 180); return 270;
  }

  /* ============================================================ *
   *  HEADING PROVIDER  -  one abstraction, three strategies.
   *  getRaw() returns the instantaneous heading for the active
   *  strategy; getHeading() applies EMA smoothing across the wrap.
   * ============================================================ */
  var Heading = (function () {
    var MODE = { MANUAL: 0, MAGNETIC: 1, DR: 2 };
    var mode = MODE.MANUAL;
    var hasMag = false, hasGyro = false;
    var disp = 0;            // smoothed displayed heading
    var drYaw = 0, lastT = 0; // dead-reckoning integrator
    // mag calibration (hard-iron offsets / soft-iron scale)
    var magCal = { ox: 0, oy: 0, oz: 0, sx: 1, sy: 1, sz: 1 };

    function probe() {
      // Magnetometer / gyro are NOT confirmed on this hardware. We look for
      // them anyway so the app lights up automatically if firmware exposes
      // them; otherwise we stay honestly in MANUAL mode.
      try {
        if (typeof Pip !== "undefined") {
          if (Pip.magRd || Pip.getMagnetometer || Pip.mag) hasMag = true;
          if (Pip.gyroRd || Pip.getGyro || Pip.gyro) hasGyro = true;
        }
      } catch (e) {}
      mode = hasMag ? MODE.MAGNETIC : (hasGyro ? MODE.DR : MODE.MANUAL);
      disp = wrap360(cfg.bearing + cfg.trim);
    }

    function readMag() {
      try { if (Pip.magRd) return Pip.magRd(); } catch (e) {}
      try { if (Pip.getMagnetometer) return Pip.getMagnetometer(); } catch (e) {}
      try { if (Pip.mag) return Pip.mag; } catch (e) {}
      return null;
    }
    function readGyro() {
      try { if (Pip.gyroRd) return Pip.gyroRd(); } catch (e) {}
      try { if (Pip.getGyro) return Pip.getGyro(); } catch (e) {}
      try { if (Pip.gyro) return Pip.gyro; } catch (e) {}
      return null;
    }

    // Tilt-compensated magnetic heading using accel for level reference.
    function magHeading() {
      var m = readMag(); if (!m) return cfg.bearing;
      var a = Accel.read();
      var mx = (m.x - magCal.ox) * magCal.sx;
      var my = (m.y - magCal.oy) * magCal.sy;
      var mz = (m.z - magCal.oz) * magCal.sz;
      var heading;
      if (a) {
        var nx = a.x, ny = a.y, nz = a.z, nn = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nx /= nn; ny /= nn; nz /= nn;
        var pitch = Math.asin(-nx);
        var roll = Math.atan2(ny, nz);
        var cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
        var xh = mx * cp + mz * sp;
        var yh = mx * sr * sp + my * cr - mz * sr * cp;
        heading = Math.atan2(-yh, xh) / DEG;
      } else {
        heading = Math.atan2(-my, mx) / DEG;
      }
      return wrap360(heading + cfg.decl);
    }

    // Dead-reckoning: integrate yaw-rate from the calibrated reference.
    function drHeading() {
      var gy = readGyro(); var now = Date.now();
      if (gy && lastT) {
        var dt = (now - lastT) / 1000;
        var rate = (typeof gy.z === "number") ? gy.z : (gy.yaw || 0); // deg/s about vertical
        var a = Accel.read(); // use gravity to damp drift when stationary
        if (a) { var mag = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z); if (Math.abs(mag - 1) < 0.04 && Math.abs(rate) < 0.8) rate = 0; }
        drYaw += rate * dt;
      }
      lastT = now;
      return wrap360(cfg.bearing + drYaw + cfg.trim);
    }

    function getRaw() {
      if (mode === MODE.MAGNETIC) return magHeading();
      if (mode === MODE.DR) return drHeading();
      return wrap360(cfg.bearing + cfg.trim); // MANUAL
    }

    // EMA smoothing across the 0/360 wrap (shortest-angle delta).
    function getHeading() {
      var target = getRaw();
      var d = ((target - disp + 540) % 360) - 180;
      disp = wrap360(disp + d * 0.25);
      return disp;
    }

    function setReference(trueBearing) {
      // "Lubber line currently points at trueBearing." How that anchors the
      // reading depends on the active strategy (per spec):
      if (mode === MODE.MAGNETIC) {
        // adjust declination so the live magnetic heading reads trueBearing now
        var raw = wrap360(magHeading() - cfg.decl); // sensor heading w/o decl
        var nd = wrap360(trueBearing - raw); if (nd > 180) nd -= 360;
        cfg.decl = Math.round(nd);
      } else {
        // MANUAL: held bearing.  DR: absolute integrator reference.
        cfg.bearing = wrap360(trueBearing - cfg.trim);
        drYaw = 0; lastT = 0;
      }
      disp = wrap360(trueBearing);
    }
    function status() {
      if (mode === MODE.MAGNETIC) return "MODE: MAGNETIC";
      if (mode === MODE.DR) return "MODE: DEAD-RECKONING - RECAL ADVISED";
      return "MODE: MANUAL BEARING";
    }
    function modeName() { return mode === MODE.MAGNETIC ? "MAGNETIC" : (mode === MODE.DR ? "DEAD-RECKONING" : "MANUAL"); }
    function nudge(delta) { setReference(wrap360(getRaw() + delta)); }

    return {
      probe: probe, getHeading: getHeading, getRaw: getRaw,
      setReference: setReference, status: status, modeName: modeName,
      nudge: nudge, isManual: function () { return mode === MODE.MANUAL; },
      _setDispSeed: function () { disp = wrap360(cfg.bearing + cfg.trim); }
    };
  })();

  /* ============================================================ *
   *  MORSE  -  encoder + synchronised screen/LED flasher
   * ============================================================ */
  var MORSE_MAP = {
    A: ".-", B: "-...", C: "-.-.", D: "-..", E: ".", F: "..-.", G: "--.",
    H: "....", I: "..", J: ".---", K: "-.-", L: ".-..", M: "--", N: "-.",
    O: "---", P: ".--.", Q: "--.-", R: ".-.", S: "...", T: "-", U: "..-",
    V: "...-", W: ".--", X: "-..-", Y: "-.--", Z: "--..",
    "0": "-----", "1": ".----", "2": "..---", "3": "...--", "4": "....-",
    "5": ".....", "6": "-....", "7": "--...", "8": "---..", "9": "----.",
    ".": ".-.-.-", ",": "--..--", "?": "..--..", "/": "-..-."
  };

  function morseOf(msg) {
    // Build a flat pulse list: {on:bool, units:n}. Standard relative timing:
    // dot=1, dash=3, intra-char gap=1, inter-char gap=3, inter-word gap=7.
    var seq = [], words = msg.toUpperCase().split(" "), wi, ci, si;
    for (wi = 0; wi < words.length; wi++) {
      var w = words[wi];
      for (ci = 0; ci < w.length; ci++) {
        var code = MORSE_MAP[w[ci]]; if (!code) continue;
        for (si = 0; si < code.length; si++) {
          seq.push({ on: true, units: code[si] === "-" ? 3 : 1 });
          if (si < code.length - 1) seq.push({ on: false, units: 1 });
        }
        seq.push({ on: false, units: 3 }); // inter-character
      }
      if (wi < words.length - 1) seq.push({ on: false, units: 7 - 3 }); // top up to word gap
    }
    return seq;
  }
  function morsePreview(msg) {
    var out = "", u = msg.toUpperCase(), i;
    for (i = 0; i < u.length; i++) {
      if (u[i] === " ") { out += "/ "; continue; }
      var c = MORSE_MAP[u[i]]; if (c) out += c + " ";
    }
    return out;
  }

  // -------- torch / LED control (rear torch is likely OS-only; we drive the
  // addressable green panel LED and try a Pip.torch hook if one exists) ------
  function torchSet(on) {
    var did = false;
    try { if (typeof Pip !== "undefined" && Pip.torch) { Pip.torch(on ? 1 : 0); did = true; } } catch (e) {}
    try { if (typeof Pip !== "undefined" && Pip.setTorch) { Pip.setTorch(!!on); did = true; } } catch (e) {}
    try { if (typeof LED_GREEN !== "undefined") { digitalWrite(LED_GREEN, on ? 1 : 0); did = true; } } catch (e) {}
    return did;
  }

  var tx = { active: false, seq: null, idx: 0, timer: null, flashOn: false, reps: 0 };

  function txClear() {
    if (tx.timer) { clearTimeout(tx.timer); tx.timer = null; }
    tx.active = false; tx.seq = null; tx.idx = 0; tx.flashOn = false; tx.reps = 0;
    torchSet(0);
  }
  // Drive both flash targets from a single pulse on/off, honouring flashTarget:
  //   0 = SCREEN, 1 = TORCH/LED, 2 = BOTH.
  function applyFlash(on) {
    tx.flashOn = on && (cfg.flashTarget === 0 || cfg.flashTarget === 2); // screen flag
    if (cfg.flashTarget === 1 || cfg.flashTarget === 2) torchSet(on);     // LED
  }
  function txStep() {
    if (!tx.active) return;
    if (tx.idx >= tx.seq.length) { // one pass complete -> handle repeat
      applyFlash(false);
      tx.reps++;
      var more = (cfg.repeatMode === 2) || (cfg.repeatMode === 1 && tx.reps < cfg.repeatCount);
      if (!more) { txClear(); draw(); return; }
      tx.idx = 0;
      tx.timer = setTimeout(txStep, unitMs() * 7); // inter-repeat gap
      return;
    }
    var p = tx.seq[tx.idx++];
    applyFlash(p.on);
    draw(); // draw immediately so the screen flash stays in sync with the chain
    tx.timer = setTimeout(txStep, unitMs() * p.units);
  }
  function unitMs() { return Math.round(1200 / clamp(cfg.wpm, 1, 60)); }
  function txStart() {
    if (tx.active || !msg.length) return;
    txClear();
    tx.seq = morseOf(msg); tx.idx = 0; tx.active = true; tx.reps = 0;
    beep("OK");
    txStep();
  }
  function txStop() { if (tx.active) { txClear(); beep("CANCEL"); redraw(); } }

  /* ============================================================ *
   *  APP STATE  +  SCREEN ROUTING
   * ============================================================ */
  var SCR = { HOME: 0, CAL: 1, MORSE: 2 };
  var screen = SCR.HOME;
  var ticker = null;

  // HOME focus order: 0 COMPASS, 1 CALIBRATE, 2 MORSE
  var homeFocus = 0;

  // CALIBRATE fields
  var CAL_FIELDS = ["METHOD", "BEARING", "TRIM", "DECL", "LAT", "LON", "UTC", "ACTION"];
  var calIdx = 0;
  var calMethod = 0;     // 0 manual, 1 solar
  var calCoarse = false; // bearing step 10 vs 1
  var calAction = 0;     // 0 APPLY, 1 CAPTURE SUN, 2 RESET THEME, 3 RESET CAL
  var CAL_ACTIONS = ["APPLY", "CAPTURE SUN", "TOGGLE THEME", "RESET CAL"];

  // MORSE keypad
  var msg = "";
  var KEYS = [
    ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"],
    ["K", "L", "M", "N", "O", "P", "Q", "R", "S", "T"],
    ["U", "V", "W", "X", "Y", "Z", "0", "1", "2", "3"],
    ["4", "5", "6", "7", "8", "9", ".", ",", "?", "/"],
    ["SPC", "DEL", "CLR", "WPM-", "WPM+", "RPT", "TGT", "TX", "STOP"]
  ];
  var curRow = 0, curCol = 0;

  /* ============================================================ *
   *  DRAWING
   * ============================================================ */
  // Espruino setFontAlign uses -1 (left/top), 0 (center), 1 (right/bottom).
  function frame() {
    col(0); fillRect(0, 0, W - 1, H - 1);
    col(1); rect(2, 2, W - 3, H - 3);
  }
  function header(title) {
    col(2); align(-1, -1); setFontSmall();
    str("ROBCO INDUSTRIES (TM) TERMLINK", 8, 5);
    align(1, -1); col(3); str(title, W - 8, 5);
    col(1); line(4, 18, W - 5, 18);
  }
  function footer(text) {
    col(1); line(4, H - 18, W - 5, H - 18);
    col(2); setFontSmall(); align(-1, -1); str(text, 8, H - 14);
  }

  function compassDisc(cx, cy, r, heading) {
    var i, ang, x1, y1, x2, y2, len;
    col(1); circle(cx, cy, r); circle(cx, cy, r - 1);
    // rotating rose: a label/tick at bearing b sits at screen angle (b - heading)
    for (i = 0; i < 360; i += 10) {
      ang = rad(i - heading);
      var major = (i % 30 === 0);
      len = major ? 12 : 6;
      col(major ? 3 : 1);
      x1 = cx + Math.sin(ang) * r; y1 = cy - Math.cos(ang) * r;
      x2 = cx + Math.sin(ang) * (r - len); y2 = cy - Math.cos(ang) * (r - len);
      line(x1, y1, x2, y2);
    }
    // cardinal + intercardinal letters
    var labels = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    setFontSmall(); align(0, 0);
    for (i = 0; i < 8; i++) {
      ang = rad(i * 45 - heading);
      var lr = r - 26;
      var lx = cx + Math.sin(ang) * lr, ly = cy - Math.cos(ang) * lr;
      col(i === 0 ? 3 : 2); // North brightest
      align(0, 0);
      str(labels[i], lx - sw(labels[i]) / 2, ly - 6);
    }
    // fixed lubber index at top (the direction the device points)
    col(3);
    line(cx, cy - r - 2, cx - 7, cy - r - 14);
    line(cx, cy - r - 2, cx + 7, cy - r - 14);
    line(cx - 7, cy - r - 14, cx + 7, cy - r - 14);
    // center hub
    col(2); fillRect(cx - 2, cy - 2, cx + 2, cy + 2);
  }

  function cardinalLabel(h) {
    var names = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
    return names[Math.round(wrap360(h) / 22.5) % 16];
  }

  function drawHome() {
    frame(); header("ROBCO NAVIGATION");
    var heading = Heading.getHeading();
    var cx = W / 2, cy = 138, r = 96;
    compassDisc(cx, cy, r, heading);

    // big numeric readout inside the disc
    col(3); setFontBig(); align(0, 0);
    str(pad(Math.round(wrap360(heading)), 3) + "\xB0", cx, cy - 4);
    setFontSmall(); col(2); align(0, 0); str(cardinalLabel(heading), cx, cy + 18);

    // honest MODE / confidence line
    col(2); setFontSmall(); align(0, -1);
    str(Heading.status(), cx, 244);

    // three soft buttons: CALIBRATE (left)  COMPASS (center)  MORSE (right)
    var btns = [
      { t: "( COMPASS )", x: cx, f: 0 },
      { t: "[ CALIBRATE ]", x: 92, f: 1 },
      { t: "[ MORSE ]", x: W - 92, f: 2 }
    ];
    align(0, 0); setFontSmall();
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i], on = (homeFocus === b.f);
      if (on) { col(2); var bw = sw(b.t) + 8; fillRect(b.x - bw / 2, 263, b.x + bw / 2, 281); col(0); }
      else col(2);
      str(b.t, b.x, 272);
    }
    footer("K1 TURN:SELECT  K1 PRESS:OPEN   K2:BEARING+/-   ITEMS:EXIT");
    flip();
  }

  function drawCalibrate() {
    frame(); header("CALIBRATION");
    var y = 30, lh = 22, i;
    var sun = solarAzimuth(cfg.lat, cfg.lon, new Date(), cfg.utcOff);
    var vals = {
      METHOD: calMethod ? "SOLAR (AIM AT SUN)" : "MANUAL (KNOBS)",
      BEARING: pad(Math.round(wrap360(cfg.bearing + cfg.trim)), 3) + "\xB0  (" + (calCoarse ? "x10" : "x1") + ")",
      TRIM: (cfg.trim >= 0 ? "+" : "") + cfg.trim + "\xB0",
      DECL: (cfg.decl >= 0 ? "+" : "") + cfg.decl + "\xB0 " + (Heading.modeName() === "MAGNETIC" ? "" : "(MAG ONLY)"),
      LAT: cfg.lat.toFixed(2) + (cfg.locSet ? "" : "  NOT SET"),
      LON: cfg.lon.toFixed(2),
      UTC: (cfg.utcOff >= 0 ? "+" : "") + cfg.utcOff + "H",
      ACTION: CAL_ACTIONS[calAction]
    };
    setFontSmall(); align(-1, -1);
    for (i = 0; i < CAL_FIELDS.length; i++) {
      var f = CAL_FIELDS[i], sel = (calIdx === i), yy = y + i * lh;
      if (sel) { col(2); fillRect(8, yy - 2, W - 9, yy + lh - 6); col(0); }
      else col(2);
      str(f, 16, yy);
      col(sel ? 0 : 3); str(vals[f], 150, yy);
    }
    // live preview of the solar reference
    col(1); line(8, y + 8 * lh, W - 9, y + 8 * lh);
    col(2); align(-1, -1);
    var sline = "SUN AZIMUTH: " + (sun === null ? "SET LAT/LON  (coarse " + coarseSolar("now") + "\xB0)" : Math.round(sun) + "\xB0");
    str(sline, 16, y + 8 * lh + 6);
    col(2); str("MODE: " + Heading.modeName(), 16, y + 8 * lh + 22);
    footer("K2:FIELD  K1 TURN:VALUE  K1 PRESS:ACT/TOGGLE  TORCH:BACK");
    flip();
  }

  function repLabel() { return cfg.repeatMode === 0 ? "ONCE" : (cfg.repeatMode === 1 ? ("x" + cfg.repeatCount) : "LOOP"); }
  function tgtLabel() { return cfg.flashTarget === 0 ? "SCREEN" : (cfg.flashTarget === 1 ? "TORCH/LED" : "BOTH"); }

  function drawMorse() {
    if (tx.active) {
      // transmit view: bright fill on pulse, dim "TRANSMITTING" plate on gaps.
      if (tx.flashOn) { col(3); fillRect(0, 0, W - 1, H - 1); flip(); return; }
      frame(); header("MORSE TRANSMITTER");
      col(3); setFontBig(); align(0, 0); str("TRANSMITTING", W / 2, 120);
      setFontSmall(); col(2);
      str(msg, W / 2, 152);
      str("RPT " + repLabel() + "   WPM " + cfg.wpm + "   TGT " + tgtLabel(), W / 2, 176);
      footer("TORCH:STOP");
      flip(); return;
    }
    frame(); header("MORSE TRANSMITTER");
    // composed message + live Morse preview
    col(3); setFontSmall(); align(-1, -1);
    str("MSG: " + (msg || "_"), 12, 24);
    col(2); var pv = morsePreview(msg); if (pv.length > 56) pv = pv.slice(0, 53) + "...";
    str(pv, 12, 40);
    // settings strip
    col(1); line(8, 54, W - 9, 54);
    col(2);
    str("WPM:" + cfg.wpm + "  UNIT:" + unitMs() + "ms  RPT:" + repLabel() + "  TGT:" + tgtLabel(), 12, 58);

    // keypad grid (K1 rows, K2 cols, K1 press selects - Calculator idiom)
    var gx = 16, gy = 80, cw = 44, ch = 26, ri, cci;
    setFontSmall(); align(0, 0);
    for (ri = 0; ri < KEYS.length; ri++) {
      for (cci = 0; cci < KEYS[ri].length; cci++) {
        var kx = gx + cci * cw, ky = gy + ri * ch;
        var sel = (curRow === ri && curCol === cci);
        if (sel) { col(2); fillRect(kx, ky, kx + cw - 3, ky + ch - 3); col(0); }
        else { col(1); rect(kx, ky, kx + cw - 3, ky + ch - 3); col(2); }
        str(KEYS[ri][cci], kx + (cw - 3) / 2, ky + (ch - 3) / 2);
      }
    }
    footer("K1:ROW  K2:COL  K1 PRESS:SELECT   TORCH:STOP/BACK");
    flip();
  }

  function flip() { if (HAS_FLIP) try { G.flip(); } catch (e) {} }

  function draw() {
    if (!G) return;
    if (screen === SCR.HOME) drawHome();
    else if (screen === SCR.CAL) drawCalibrate();
    else drawMorse();
  }
  var redrawPending = false;
  function redraw() { redrawPending = true; }

  /* ============================================================ *
   *  TICKER  -  read provider, advance estimate, redraw
   * ============================================================ */
  function tick() {
    if (screen === SCR.HOME) {
      if (cfg.motionEst && Heading.isManual()) motionEstimate();
      redrawPending = true; // home animates the rose smoothly
    }
    if (redrawPending) { redrawPending = false; draw(); }
  }

  // Optional, low-confidence: detect a left/right turn from transient lateral
  // acceleration and nudge the held bearing. Clearly an ESTIMATE, default off.
  var meLast = null;
  function motionEstimate() {
    var a = Accel.read(); if (!a) return;
    if (meLast) {
      var dy = a.y - meLast.y;
      if (Math.abs(dy) > 0.25) Heading.nudge(dy > 0 ? 2 : -2);
    }
    meLast = { x: a.x, y: a.y, z: a.z };
  }

  /* ============================================================ *
   *  INPUT HANDLERS
   * ============================================================ */
  function onKnob1(dir) {
    if (dir === 0) return press1();
    if (screen === SCR.HOME) {
      homeFocus = (homeFocus + (dir > 0 ? 1 : 2)) % 3; beep("CLICK"); redraw();
    } else if (screen === SCR.CAL) {
      changeField(dir); beep("CLICK"); redraw();
    } else { // MORSE: K1 = row
      curRow = clamp(curRow + (dir > 0 ? 1 : -1), 0, KEYS.length - 1);
      curCol = clamp(curCol, 0, KEYS[curRow].length - 1);
      beep("CLICK"); redraw();
    }
  }
  function onKnob2(dir) {
    if (screen === SCR.HOME) {
      Heading.nudge(dir > 0 ? 1 : -1); beep("CLICK"); redraw();
    } else if (screen === SCR.CAL) {
      calIdx = (calIdx + (dir > 0 ? 1 : CAL_FIELDS.length - 1)) % CAL_FIELDS.length; beep("CLICK"); redraw();
    } else { // MORSE: K2 = column
      curCol = clamp(curCol + (dir > 0 ? 1 : -1), 0, KEYS[curRow].length - 1);
      beep("CLICK"); redraw();
    }
  }
  function press1() {
    if (screen === SCR.HOME) {
      if (homeFocus === 1) { gotoCal(); }
      else if (homeFocus === 2) { gotoMorse(); }
      else { beep("OK"); } // press on COMPASS = acknowledge / recenter hook
    } else if (screen === SCR.CAL) {
      calActivate();
    } else {
      morseActivate();
    }
  }
  function onTorch() {
    // Torch button repurposed: STOP transmit if running, else BACK to HOME.
    if (screen === SCR.MORSE && tx.active) { txStop(); return; }
    if (screen !== SCR.HOME) { saveCfg(); screen = SCR.HOME; beep("OK"); redraw(); }
  }

  /* ---- CALIBRATE behaviour ---- */
  function changeField(dir) {
    var s = dir > 0 ? 1 : -1, f = CAL_FIELDS[calIdx];
    if (f === "METHOD") calMethod = calMethod ? 0 : 1;
    else if (f === "BEARING") { Heading.setReference(wrap360(cfg.bearing + cfg.trim + s * (calCoarse ? 10 : 1))); }
    else if (f === "TRIM") cfg.trim = clamp(cfg.trim + s, -180, 180);
    else if (f === "DECL") cfg.decl = clamp(cfg.decl + s, -30, 30);
    else if (f === "LAT") { cfg.lat = clamp(cfg.lat + s * 0.5, -90, 90); cfg.locSet = true; }
    else if (f === "LON") { cfg.lon = clamp(cfg.lon + s * 0.5, -180, 180); cfg.locSet = true; }
    else if (f === "UTC") cfg.utcOff = clamp(cfg.utcOff + s, -12, 14);
    else if (f === "ACTION") calAction = (calAction + (s > 0 ? 1 : CAL_ACTIONS.length - 1)) % CAL_ACTIONS.length;
  }
  function calActivate() {
    var f = CAL_FIELDS[calIdx];
    if (f === "BEARING") { calCoarse = !calCoarse; beep("CLICK"); redraw(); return; }
    if (f === "METHOD") { calMethod = calMethod ? 0 : 1; beep("CLICK"); redraw(); return; }
    if (f !== "ACTION") { beep("CLICK"); return; }
    // ACTION field pressed -> run selected action
    if (calAction === 0) { saveCfg(); beep("OK"); }                 // APPLY
    else if (calAction === 1) {                                      // CAPTURE SUN
      var sun = solarAzimuth(cfg.lat, cfg.lon, new Date(), cfg.utcOff);
      if (sun === null) sun = coarseSolar("now");
      Heading.setReference(sun); saveCfg(); beep("OK");
    } else if (calAction === 2) {                                    // TOGGLE THEME
      cfg.theme = cfg.theme === "green" ? "amber" : "green"; saveCfg(); beep("OK");
    } else {                                                         // RESET CAL
      cfg.bearing = 0; cfg.trim = 0; cfg.decl = 0; Heading.setReference(0); saveCfg(); beep("CANCEL");
    }
    redraw();
  }

  /* ---- MORSE behaviour ---- */
  function morseActivate() {
    var k = KEYS[curRow][curCol];
    beep("CLICK");
    if (k === "SPC") msg += " ";
    else if (k === "DEL") msg = msg.slice(0, -1);
    else if (k === "CLR") msg = "";
    else if (k === "WPM-") cfg.wpm = clamp(cfg.wpm - 1, 1, 60);
    else if (k === "WPM+") cfg.wpm = clamp(cfg.wpm + 1, 1, 60);
    else if (k === "RPT") { cfg.repeatMode = (cfg.repeatMode + 1) % 3; if (cfg.repeatMode === 1) cfg.repeatCount = clamp(cfg.repeatCount, 2, 20); }
    else if (k === "TGT") cfg.flashTarget = (cfg.flashTarget + 1) % 3;
    else if (k === "TX") { saveCfg(); txStart(); return; }
    else if (k === "STOP") { txStop(); return; }
    else if (msg.length < 60) msg += k;
    redraw();
  }

  function gotoCal() { screen = SCR.CAL; calIdx = 0; beep("OK"); redraw(); }
  function gotoMorse() { screen = SCR.MORSE; curRow = 0; curCol = 0; beep("OK"); redraw(); }

  /* ============================================================ *
   *  LIFECYCLE
   * ============================================================ */
  function start() {
    loadCfg();
    Accel.init();
    Heading.probe();
    Heading._setDispSeed();
    try {
      if (typeof Pip !== "undefined" && Pip.on) {
        Pip.on("knob1", onKnob1);
        Pip.on("knob2", onKnob2);
        Pip.on("torch", onTorch);
      }
    } catch (e) {}
    draw();
    ticker = setInterval(tick, 120); // ~8 fps; smoothing kills jitter
  }

  function cleanup() {
    // MANDATORY: kill timers, detach listeners, torch OFF, save, no orphans.
    try { if (ticker) clearInterval(ticker); } catch (e) {} ticker = null;
    try { txClear(); } catch (e) {}      // clears transmit chain + torch off
    torchSet(0);
    try {
      if (typeof Pip !== "undefined") {
        if (Pip.removeListener) {
          Pip.removeListener("knob1", onKnob1);
          Pip.removeListener("knob2", onKnob2);
          Pip.removeListener("torch", onTorch);
        } else if (Pip.removeAllListeners) {
          Pip.removeAllListeners("knob1"); Pip.removeAllListeners("knob2"); Pip.removeAllListeners("torch");
        }
      }
    } catch (e) {}
    Accel.stop();
    saveCfg();
  }

  start();

  return {
    id: appId,
    notDefault: true, // a press of ITEMS closes the app
    fullscreen: true, // skip the page header / top icons
    remove: cleanup
  };
})
