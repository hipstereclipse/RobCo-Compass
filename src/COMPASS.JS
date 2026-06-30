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

  var appId = "RobCo Compass";
  var SET_FILE = "USER/COMPASS.SET";

  /* ------------------------------------------------------------------ *
   *  GRAPHICS INSTANCE  (3000 = h, the live screen; fall back to g)
   * ------------------------------------------------------------------ */
  var G =
    (typeof h !== "undefined" && h) ? h :
    (typeof g !== "undefined" && g) ? g : null;
  var HAS_FLIP = !!(G && typeof G.flip === "function");
  var W = (G && G.getWidth) ? G.getWidth() : 480;
  var H = (G && G.getHeight) ? G.getHeight() : 320;

  /* Round-safe insets. The Pip-Boy glass clips its CORNERS, so all content
   * stays inside the SAFE box; CONTENT is the body box and TEXT is where
   * left/right-aligned strings start so they clear the corner brackets.
   * (Values mirror the sibling RobCo apps' shared _LIB.) */
  var SAFE_L = 24, SAFE_T = 12, SAFE_R = W - 24, SAFE_B = H - 14;
  var CONTENT_L = SAFE_L + 8, CONTENT_R = SAFE_R - 8;
  var TEXT_L = CONTENT_L + 6, TEXT_R = CONTENT_R - 6;

  /* ------------------------------------------------------------------ *
   *  COLOR  -  INDEXED, not RGB.  setColor(0..3) = BG/DIM/MID/FG.
   *  On this hardware passing RGB floats is a bug: low-flash Espruino
   *  treats setColor(r,g,b) as "r = integer color, g/b ignored", so a
   *  fractional DIM/MID level truncates to 0 = black (invisible text).
   *  We draw with the 4 indices everywhere; installRenderCompat() wraps
   *  h.setColor so the indices map to the live Pip-Boy theme via toColor.
   * ------------------------------------------------------------------ */
  var FG = 3, MID = 2, DIM = 1, BG = 0;
  var THEMES = {
    green: [0.102, 1.00, 0.502], // Fallout 3  ~ #1AFF80
    amber: [1.00, 0.714, 0.259]  // New Vegas  ~ #FFB642
  };
  var DRAW = THEMES.green;        // active hue (filled from settings/theme)
  var compat = null;
  function onDevice() { return typeof setInterval !== "undefined"; }
  function levelFor(k) { return k <= 0 ? 0 : k === 1 ? 0.34 : k === 2 ? 0.67 : 1; }
  function col(lvl) { if (G) try { G.setColor(lvl); } catch (e) {} }

  function installRenderCompat() {
    if (!G) return;
    compat = G._compassCompat || (G._compassCompat = {});
    if (G.setColor && G.setColor !== compat.cWrap) {
      compat.origColor = G.setColor;
      compat.cWrap = function (a) {
        var c = G._compassCompat || compat;
        if (arguments.length === 1 && typeof a === "number" && a >= 0 && a <= 3) {
          var k = a | 0;
          if (c.levels && c.levels[k] != null) { try { return c.origColor.call(G, c.levels[k]); } catch (e) {} }
          var l = levelFor(k);
          try { return c.origColor.call(G, DRAW[0] * l, DRAW[1] * l, DRAW[2] * l); } catch (e2) {}
          try { return c.origColor.call(G, k); } catch (e3) {}
        }
        try { return c.origColor.apply(G, arguments); } catch (e4) { return G; }
      };
      G.setColor = compat.cWrap;
    }
    if (G.setFont && G.setFont !== compat.fWrap) {
      compat.origFont = G.setFont;
      compat.fWrap = function (name, size) {
        var c = G._compassCompat || compat;
        try { return c.origFont.call(G, name, size); }
        catch (e) {
          try { return c.origFont.call(G, "6x8"); }
          catch (e2) { try { return G.setFontVector ? G.setFontVector(22) : G; } catch (e3) { return G; } }
        }
      };
      G.setFont = compat.fWrap;
    }
    updateCompatLevels();
  }
  function updateCompatLevels() {
    if (!compat) return;
    compat.levels = null;
    if (!G.toColor) return;        // no native packer -> wrapper uses raw floats
    var lv = [], ok = true, k, l;
    for (k = 0; k < 4; k++) {
      l = levelFor(k);
      try { lv[k] = G.toColor(DRAW[0] * l, DRAW[1] * l, DRAW[2] * l); }
      catch (e) { ok = false; break; }
    }
    if (ok) compat.levels = lv;
  }
  function restoreRenderCompat() {
    if (!G || !G._compassCompat) return;
    var c = G._compassCompat;
    if (c.origColor && G.setColor === c.cWrap) G.setColor = c.origColor;
    if (c.origFont && G.setFont === c.fWrap) G.setFont = c.origFont;
    try { delete G._compassCompat; } catch (e) { G._compassCompat = null; }
  }
  /* Match the user's configured Pip-Boy HUD color when exposed; else use the
   * app's own theme toggle; else green. Best-effort + guarded. */
  function applyTheme() {
    var c = null, names = ["pipboyColor", "uPipboyColor", "color", "theme"], i, v;
    try {
      if (typeof Pip !== "undefined") for (i = 0; i < names.length; i++) {
        v = Pip[names[i]];
        if (v && v.length >= 3 && typeof v[0] === "number") { c = [v[0], v[1], v[2]]; break; }
      }
    } catch (e) {}
    if (!c) c = THEMES[cfg.theme] || THEMES.green;
    if (c[0] > 1 || c[1] > 1 || c[2] > 1) c = [c[0] / 255, c[1] / 255, c[2] / 255];
    DRAW = c; updateCompatLevels();
  }

  /* ------------------------------------------------------------------ *
   *  Thin draw helpers.  Only two fonts exist on this device:
   *  "Monofonto23" (headings/rows) and "6x8" (footer + compact readouts,
   *  drawn small so they clear the ROUND bezel).  setFont is wrapped on
   *  device so an unknown name degrades instead of throwing.
   * ------------------------------------------------------------------ */
  function setFontBig() { if (G) try { G.setFont("Monofonto23"); } catch (e) {} }
  function setFontBig2() { if (G) try { G.setFont("Monofonto23", 2); } catch (e) {} }
  function setFontSmall() { if (G) try { G.setFont("6x8"); } catch (e) {} }
  function align(x, y) { if (G && G.setFontAlign) try { G.setFontAlign(x, y); } catch (e) {} }
  function str(s, x, y) { if (G) try { G.drawString(s, x, y); } catch (e) {} }
  function line(x1, y1, x2, y2) { if (G) try { G.drawLine(x1, y1, x2, y2); } catch (e) {} }
  function rect(x1, y1, x2, y2) { if (G) try { G.drawRect(x1, y1, x2, y2); } catch (e) {} }
  function fillRect(x1, y1, x2, y2) { if (G) try { G.fillRect(x1, y1, x2, y2); } catch (e) {} }
  function circle(x, y, r) { if (G && G.drawCircle) try { G.drawCircle(x, y, r); } catch (e) {} }
  function sw(s) { try { return G.stringWidth(s); } catch (e) { return ("" + s).length * 13; } }
  function caps(s) { return ("" + s).toUpperCase(); }
  function fitLeft(s, n) { s = "" + s; return s.length > n ? "<" + s.slice(s.length - n + 1) : s; }
  function fitRight(s, n) { s = "" + s; return s.length > n ? s.slice(0, n - 1) + ">" : s; }

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
  // Corner brackets that trace the rounded bezel, drawn just inside SAFE.
  function drawCorners(x0, y0, x1, y1, n) {
    line(x0, y0 + n, x0, y0); line(x0, y0, x0 + n, y0);
    line(x1 - n, y0, x1, y0); line(x1, y0, x1, y0 + n);
    line(x0, y1 - n, x0, y1); line(x0, y1, x0 + n, y1);
    line(x1 - n, y1, x1, y1); line(x1, y1 - n, x1, y1);
  }
  // Standard top chrome: black field, dim corner brackets, brand left, screen
  // title right, a rule under. The brand/title use the SMALL font so the banner
  // stays compact and well clear of the rounded corners. Everything inside SAFE.
  function header(title) {
    if (G) try { G.reset(); } catch (e) {}
    col(BG); fillRect(0, 0, W - 1, H - 1);
    col(DIM); drawCorners(SAFE_L, SAFE_T, SAFE_R, SAFE_B, 14);
    setFontSmall();
    col(MID); align(-1, -1); str("ROBCO TERMLINK", TEXT_L, SAFE_T + 6);
    col(FG); align(1, -1); str(caps(title), TEXT_R, SAFE_T + 6);
    col(DIM); line(CONTENT_L, 30, CONTENT_R, 30);
    setFontBig();
  }
  // Standard bottom chrome: a dim rule + a centered control legend in the SMALL
  // font so it clears the rounded bottom corners.
  function footer(text) {
    col(DIM); line(CONTENT_L, H - 32, CONTENT_R, H - 32);
    setFontSmall(); col(MID); align(0, 0); str(fitRight(caps(text), 60), W / 2, H - 21);
    setFontBig();
  }

  function compassDisc(cx, cy, r, heading) {
    var i, ang, x1, y1, x2, y2, len;
    col(FG); circle(cx, cy, r); circle(cx, cy, r - 1);
    // rotating rose: a label/tick at bearing b sits at screen angle (b - heading)
    for (i = 0; i < 360; i += 10) {
      ang = rad(i - heading);
      var major = (i % 30 === 0);
      len = major ? 11 : 6;
      col(major ? FG : DIM);
      x1 = cx + Math.sin(ang) * r; y1 = cy - Math.cos(ang) * r;
      x2 = cx + Math.sin(ang) * (r - len); y2 = cy - Math.cos(ang) * (r - len);
      line(x1, y1, x2, y2);
    }
    // cardinal + intercardinal letters (small font, centered on their point)
    var labels = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    setFontSmall(); align(0, 0);
    for (i = 0; i < 8; i++) {
      ang = rad(i * 45 - heading);
      var lr = r - 16;
      var lx = cx + Math.sin(ang) * lr, ly = cy - Math.cos(ang) * lr;
      col(i === 0 ? FG : MID); // North brightest
      str(labels[i], lx, ly);
    }
    // fixed lubber index at top (the direction the device points)
    col(FG);
    line(cx, cy - r - 2, cx - 7, cy - r - 13);
    line(cx, cy - r - 2, cx + 7, cy - r - 13);
    line(cx - 7, cy - r - 13, cx + 7, cy - r - 13);
    // center hub
    col(MID); fillRect(cx - 2, cy - 2, cx + 2, cy + 2);
  }

  function cardinalLabel(h) {
    var names = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
    return names[Math.round(wrap360(h) / 22.5) % 16];
  }

  function drawHome() {
    header("NAVIGATION");
    var heading = Heading.getHeading();
    var cx = W / 2, cy = 148, r = 86;
    compassDisc(cx, cy, r, heading);

    // big numeric readout inside the disc; small cardinal label beneath it
    col(FG); setFontBig(); align(0, 0);
    str(pad(Math.round(wrap360(heading)), 3) + "\xB0", cx, cy - 6);
    setFontSmall(); col(MID); align(0, 0); str(caps(cardinalLabel(heading)), cx, cy + 16);

    // honest MODE / confidence line (small font, just under the disc)
    col(MID); align(0, 0); str(Heading.status(), cx, cy + r + 14);

    // three soft buttons: COMPASS (center)  CALIBRATE (left)  MORSE (right),
    // small font, kept inside CONTENT so they clear the rounded corners.
    var btns = [
      { t: "[COMPASS]", x: cx, f: 0 },
      { t: "CALIBRATE", x: CONTENT_L + 48, f: 1 },
      { t: "MORSE", x: CONTENT_R - 32, f: 2 }
    ];
    align(0, 0);
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i], on = (homeFocus === b.f);
      if (on) { col(FG); var bw = sw(b.t) + 12; fillRect(b.x - bw / 2, H - 60, b.x + bw / 2, H - 44); col(BG); }
      else col(MID);
      str(b.t, b.x, H - 52);
    }
    setFontBig();
    footer("WHEEL SELECT  PUSH OPEN  THUMB BEARING +/-  ITEMS EXIT");
    flip();
  }

  // A label/value row in the SMALL font (keeps the 8-field list uncrowded and
  // clear of the rounded corners). The label is ALWAYS bright (readable even
  // when not selected); the selected row gets a ">" caret + an underline + a
  // dim bar so the cursor reads at a glance.
  function calRow(label, val, y, sel) {
    if (sel) {
      col(DIM); fillRect(CONTENT_L, y - 2, CONTENT_R, y + 11);
      col(FG); align(-1, -1); str(">", TEXT_L - 2, y); str(fitRight(label, 12), TEXT_L + 10, y);
      align(1, -1); str(fitLeft(val, 26), TEXT_R, y);
    } else {
      col(FG); align(-1, -1); str(fitRight(label, 12), TEXT_L, y);
      col(MID); align(1, -1); str(fitLeft(val, 28), TEXT_R, y);
    }
  }
  function drawCalibrate() {
    header("CALIBRATION");
    setFontSmall();
    var y = 46, lh = 20, i;
    var sun = solarAzimuth(cfg.lat, cfg.lon, new Date(), cfg.utcOff);
    var vals = {
      METHOD: calMethod ? "SOLAR (AIM AT SUN)" : "MANUAL (KNOBS)",
      BEARING: pad(Math.round(wrap360(cfg.bearing + cfg.trim)), 3) + "\xB0 (" + (calCoarse ? "x10" : "x1") + ")",
      TRIM: (cfg.trim >= 0 ? "+" : "") + cfg.trim + "\xB0",
      DECL: (cfg.decl >= 0 ? "+" : "") + cfg.decl + "\xB0 " + (Heading.modeName() === "MAGNETIC" ? "" : "(MAG ONLY)"),
      LAT: cfg.lat.toFixed(2) + (cfg.locSet ? "" : " NOT SET"),
      LON: cfg.lon.toFixed(2),
      UTC: (cfg.utcOff >= 0 ? "+" : "") + cfg.utcOff + "H",
      ACTION: CAL_ACTIONS[calAction]
    };
    for (i = 0; i < CAL_FIELDS.length; i++) {
      var f = CAL_FIELDS[i];
      calRow(f, vals[f], y + i * lh, calIdx === i);
    }
    // live preview of the solar reference
    var sy = y + CAL_FIELDS.length * lh + 4;
    col(DIM); line(CONTENT_L, sy, CONTENT_R, sy);
    col(MID); align(-1, -1);
    var sline = "SUN AZIMUTH: " + (sun === null ? "SET LAT/LON (~" + coarseSolar("now") + "\xB0)" : Math.round(sun) + "\xB0")
              + "   MODE: " + Heading.modeName();
    str(sline, TEXT_L, sy + 7);
    setFontBig();
    footer("THUMB FIELD  WHEEL VALUE  PUSH DO  TORCH BACK");
    flip();
  }

  function repLabel() { return cfg.repeatMode === 0 ? "ONCE" : (cfg.repeatMode === 1 ? ("x" + cfg.repeatCount) : "LOOP"); }
  function tgtLabel() { return cfg.flashTarget === 0 ? "SCREEN" : (cfg.flashTarget === 1 ? "TORCH/LED" : "BOTH"); }

  function drawMorse() {
    if (tx.active) {
      // transmit view: bright fill on pulse, dim "TRANSMITTING" plate on gaps.
      if (tx.flashOn) { col(FG); fillRect(0, 0, W - 1, H - 1); flip(); return; }
      header("MORSE");
      col(FG); setFontBig2(); align(0, 0); str("TRANSMITTING", W / 2, 120);
      setFontBig(); col(MID); str(caps(msg), W / 2, 168);
      setFontSmall(); str("RPT " + repLabel() + "    WPM " + cfg.wpm + "    TGT " + tgtLabel(), W / 2, 200);
      setFontBig();
      footer("TORCH STOP");
      flip(); return;
    }
    header("MORSE");
    // composed message + live Morse preview (small font, inside CONTENT)
    setFontSmall();
    col(FG); align(-1, -1); str("MSG: " + caps(msg || "_"), TEXT_L, 40);
    col(MID); var pv = morsePreview(msg); if (pv.length > 64) pv = pv.slice(0, 61) + "...";
    str(pv, TEXT_L, 54);
    // settings, right-aligned on the same top band
    col(MID); align(1, -1);
    str("WPM " + cfg.wpm + "  RPT " + repLabel() + "  TGT " + tgtLabel(), TEXT_R, 40);

    // keypad grid: 10 cols x 5 rows inside CONTENT (K1 rows, K2 cols, K1 press).
    var cols = 10, gx = CONTENT_L, gw = CONTENT_R - CONTENT_L;
    var cw = gw / cols, ch = 30, gy = 70, ri, cci;
    align(0, 0);
    for (ri = 0; ri < KEYS.length; ri++) {
      for (cci = 0; cci < KEYS[ri].length; cci++) {
        var kx = gx + cci * cw, ky = gy + ri * ch;
        var sel = (curRow === ri && curCol === cci);
        if (sel) { col(FG); fillRect(kx + 1, ky + 1, kx + cw - 2, ky + ch - 2); col(BG); }
        else { col(DIM); rect(kx + 1, ky + 1, kx + cw - 2, ky + ch - 2); col(FG); }
        str(KEYS[ri][cci], kx + cw / 2, ky + ch / 2);
      }
    }
    footer("WHEEL ROW  THUMB COL  PUSH KEY  TORCH BACK");
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
    installRenderCompat();   // make indexed setColor(0..3) honor the live theme
    applyTheme();
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
    if (onDevice()) ticker = setInterval(tick, 120); // ~8 fps; smoothing kills jitter
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
    restoreRenderCompat();
  }

  start();

  return {
    id: appId,
    notDefault: true, // a press of ITEMS closes the app
    fullscreen: true, // skip the page header / top icons
    remove: cleanup
  };
})
