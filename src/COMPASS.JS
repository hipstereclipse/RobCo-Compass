/* COMPASS - RobCo Navigation for The Wand Company Pip-Boy 3000
 * Accelerometer-only build. With no magnetometer, the device cannot sense
 * north on its own (an accelerometer measures tilt, not heading), so north
 * is set by you (manual bearing) or captured from the sun. The MODE line
 * says so honestly. Target: Espruino / STM32F407VE, ES5, tight RAM.
 *
 * This file is a function EXPRESSION. The launcher calls it and uses the
 * returned descriptor; do NOT add a trailing () to invoke it yourself.
 */
(function () {
  "use strict";

  var SET_FILE = "USER/COMPASS.SET";

  /* Graphics instance: 3000 = h, Mk V = bC (offscreen) / g */
  var G = (typeof h !== "undefined" && h) ? h
        : (typeof bC !== "undefined" && bC) ? bC
        : (typeof g !== "undefined" && g) ? g : null;
  var HAS_FLIP = !!(G && G.flip);
  var W = G ? G.getWidth() : 480;
  var H = G ? G.getHeight() : 320;

  /* Safe inset so nothing lands under the screen's rounded corners. */
  var PAD = 20;
  var X0 = PAD, Y0 = PAD, X1 = W - 1 - PAD, Y1 = H - 1 - PAD;

  /* One hue, four brightness levels, near-black background. */
  var THEMES = { green: [0.10, 1.00, 0.50], amber: [1.00, 0.71, 0.26] };
  var LEVEL = [0.0, 0.30, 0.62, 1.0];

  var cfg = {
    theme: "green",
    bearing: 0, trim: 0,
    lat: 0, lon: 0, locSet: false, utcOff: 0,
    wpm: 12, repeatMode: 0, repeatCount: 3, flashTarget: 2,
    motionEst: false
  };

  /* ---- tiny math helpers ---- */
  var DEG = Math.PI / 180;
  function rad(d) { return d * DEG; }
  function wrap360(d) { d %= 360; return d < 0 ? d + 360 : d; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function pad3(n) { n = "" + n; while (n.length < 3) n = "0" + n; return n; }
  function head3() { return pad3(Math.round(wrap360(cfg.bearing + cfg.trim)) % 360); }

  /* ---- draw helpers (every hardware touch is guarded) ---- */
  function col(l) {
    if (!G) return;
    var t = THEMES[cfg.theme] || THEMES.green, b = LEVEL[l];
    try { G.setColor(t[0] * b, t[1] * b, t[2] * b); }
    catch (e) { try { G.setColor(l); } catch (e2) {} }
  }
  function fBig() { try { G.setFont("Monofonto23"); } catch (e) { try { G.setFontVector(20); } catch (e2) {} } }
  function fSmall() { try { G.setFont("Monofonto", 1); } catch (e) { try { G.setFontVector(12); } catch (e2) {} } }
  function al(x, y) { try { G.setFontAlign(x, y); } catch (e) {} }
  function str(s, x, y) { try { G.drawString(s, x, y); } catch (e) {} }
  function line(a, b, c, d) { try { G.drawLine(a, b, c, d); } catch (e) {} }
  function rect(a, b, c, d) { try { G.drawRect(a, b, c, d); } catch (e) {} }
  function fill(a, b, c, d) { try { G.fillRect(a, b, c, d); } catch (e) {} }
  function circ(x, y, r) { try { G.drawCircle(x, y, r); } catch (e) {} }
  function sw(s) { try { return G.stringWidth(s); } catch (e) { return s.length * 10; } }
  function beep(id) { try { if (typeof Pip !== "undefined" && Pip.audioBuiltin) Pip.audioBuiltin(id); } catch (e) {} }
  function flip() { if (HAS_FLIP) { try { G.flip(); } catch (e) {} } }

  /* ---- persistence: fs -> Storage -> openFile, all guarded ---- */
  function readRaw(p) {
    try { return require("fs").readFileSync(p); } catch (e) {}
    try { return require("Storage").read(p.replace(/^USER\//, "")); } catch (e) {}
    try { var f = E.openFile(p, "r"); if (f) { var s = f.read(2048); f.close(); return s; } } catch (e) {}
    return null;
  }
  function writeRaw(p, d) {
    try { require("fs").writeFileSync(p, d); return true; } catch (e) {}
    try { require("Storage").write(p.replace(/^USER\//, ""), d); return true; } catch (e) {}
    try { var f = E.openFile(p, "w"); if (f) { f.write(d); f.close(); return true; } } catch (e) {}
    return false;
  }
  function loadCfg() {
    var raw = readRaw(SET_FILE); if (!raw) return;
    try { var o = JSON.parse(raw); for (var k in o) if (cfg.hasOwnProperty(k)) cfg[k] = o[k]; } catch (e) {}
  }
  function saveCfg() { try { writeRaw(SET_FILE, JSON.stringify(cfg)); } catch (e) {} }

  /* ---- accelerometer (confirmed present): optional MOTION ASSIST only.
   * The listener is registered ONLY while the feature is on, so it costs
   * nothing by default. One sample object is reused to avoid per-event
   * garbage that would otherwise churn the heap at ~12.5 Hz. ---- */
  var accSample = { x: 0, y: 0, z: 1 }, accSeen = false, accBound = false;
  function onAccel(a) {
    if (!a) return;
    accSample.x = +a.x || 0; accSample.y = +a.y || 0; accSample.z = +a.z || 0;
    accSeen = true;
  }
  function accelStart() {
    if (accBound || typeof Pip === "undefined" || !Pip.on) return;
    try { Pip.on("accel", onAccel); accBound = true; if (Pip.accelOn) Pip.accelOn(12.5); } catch (e) {}
  }
  function accelStop() {
    if (!accBound) return;
    try { if (Pip.removeListener) Pip.removeListener("accel", onAccel); } catch (e) {}
    try { if (Pip.accelOff) Pip.accelOff(); } catch (e) {}
    accBound = false;
  }
  function accelRead() {
    if (!accBound && typeof Pip !== "undefined" && Pip.accelRd) {
      try { var r = Pip.accelRd(); if (r) { onAccel(r); return accSample; } } catch (e) {}
    }
    return accSeen ? accSample : null;
  }

  /* ---- heading: MANUAL bearing only, EMA-smoothed across the 0/360 wrap
   * so the needle glides instead of snapping. ---- */
  var disp = 0;
  function headingRaw() { return wrap360(cfg.bearing + cfg.trim); }
  function headingSmooth() {
    var target = headingRaw();
    var d = ((target - disp + 540) % 360) - 180;
    disp = wrap360(disp + d * 0.25);
    return disp;
  }
  function setReference(trueBearing) {
    cfg.bearing = wrap360(trueBearing - cfg.trim);
    disp = wrap360(trueBearing);
  }
  function nudge(delta) { setReference(wrap360(headingRaw() + delta)); }

  /* ---- solar azimuth (NOAA): the only absolute reference available without
   * a magnetometer. Aim the lubber line at the sun, then CAPTURE SUN. Falls
   * back to a coarse time-of-day estimate when no location is set. ---- */
  function dayOfYear(d) { return Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000); }
  function solarAzimuth(when) {
    if (!cfg.locSet) return null;
    var d = when || new Date();
    var ut = (d.getHours() - cfg.utcOff) + d.getMinutes() / 60 + d.getSeconds() / 3600;
    var g = (2 * Math.PI / 365) * (dayOfYear(d) - 1 + (ut - 12) / 24);
    var eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
                        - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    var dec = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g)
              - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
              - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
    var tst = ut * 60 + eqt + 4 * cfg.lon;
    var ha = tst / 4 - 180;
    var latR = rad(cfg.lat), haR = rad(ha);
    var cz = clamp(Math.sin(latR) * Math.sin(dec) + Math.cos(latR) * Math.cos(dec) * Math.cos(haR), -1, 1);
    var zen = Math.acos(cz), sz = Math.sin(zen);
    if (Math.abs(sz) < 1e-6) return 180;
    var az = Math.acos(clamp((Math.sin(dec) - Math.sin(latR) * cz) / (Math.cos(latR) * sz), -1, 1)) / DEG;
    if (ha > 0) az = 360 - az;
    return wrap360(az);
  }
  function coarseSolar() {
    var hr = new Date().getHours();
    if (hr < 10) return 90;                  // morning -> sun ~east
    if (hr < 14) return cfg.lat < 0 ? 0 : 180; // midday -> equator-ward
    return 270;                              // afternoon -> sun ~west
  }

  /* ---- Morse ---- */
  var MORSE = {
    A: ".-", B: "-...", C: "-.-.", D: "-..", E: ".", F: "..-.", G: "--.", H: "....",
    I: "..", J: ".---", K: "-.-", L: ".-..", M: "--", N: "-.", O: "---", P: ".--.",
    Q: "--.-", R: ".-.", S: "...", T: "-", U: "..-", V: "...-", W: ".--", X: "-..-",
    Y: "-.--", Z: "--..", "0": "-----", "1": ".----", "2": "..---", "3": "...--",
    "4": "....-", "5": ".....", "6": "-....", "7": "--...", "8": "---..", "9": "----.",
    ".": ".-.-.-", ",": "--..--", "?": "..--..", "/": "-..-."
  };
  function morseSeq(m) {
    var seq = [], words = m.toUpperCase().split(" "), wi, ci, si;
    for (wi = 0; wi < words.length; wi++) {
      var w = words[wi];
      for (ci = 0; ci < w.length; ci++) {
        var c = MORSE[w[ci]]; if (!c) continue;
        for (si = 0; si < c.length; si++) {
          seq.push({ on: true, units: c[si] === "-" ? 3 : 1 });
          if (si < c.length - 1) seq.push({ on: false, units: 1 });
        }
        seq.push({ on: false, units: 3 }); // gap between letters
      }
      if (wi < words.length - 1) seq.push({ on: false, units: 4 }); // +word gap
    }
    return seq;
  }
  function morsePreview(m) {
    var out = "", u = m.toUpperCase(), i, c;
    for (i = 0; i < u.length; i++) {
      if (u[i] === " ") { out += "/ "; continue; }
      c = MORSE[u[i]]; if (c) out += c + " ";
    }
    return out;
  }
  function torchSet(on) {
    try { if (typeof Pip !== "undefined" && Pip.torch) Pip.torch(on ? 1 : 0); } catch (e) {}
    try { if (typeof Pip !== "undefined" && Pip.setTorch) Pip.setTorch(!!on); } catch (e) {}
    try { if (typeof LED_GREEN !== "undefined") digitalWrite(LED_GREEN, on ? 1 : 0); } catch (e) {}
  }
  var tx = { active: false, seq: null, idx: 0, timer: null, flashOn: false, reps: 0 };
  function unitMs() { return Math.round(1200 / clamp(cfg.wpm, 1, 60)); }
  function txClear() {
    if (tx.timer) { clearTimeout(tx.timer); tx.timer = null; }
    tx.active = false; tx.seq = null; tx.idx = 0; tx.flashOn = false; tx.reps = 0;
    torchSet(0);
  }
  function applyFlash(on) {
    tx.flashOn = on && (cfg.flashTarget === 0 || cfg.flashTarget === 2);
    if (cfg.flashTarget === 1 || cfg.flashTarget === 2) torchSet(on);
  }
  function txStep() {
    try {
      if (!tx.active) return;
      if (tx.idx >= tx.seq.length) {
        applyFlash(false);
        tx.reps++;
        var more = (cfg.repeatMode === 2) || (cfg.repeatMode === 1 && tx.reps < cfg.repeatCount);
        if (!more) { txClear(); draw(); return; }
        tx.idx = 0;
        tx.timer = setTimeout(txStep, unitMs() * 7);
        return;
      }
      var p = tx.seq[tx.idx++];
      applyFlash(p.on);
      draw();
      tx.timer = setTimeout(txStep, unitMs() * p.units);
    } catch (e) { txClear(); }
  }
  function txStart() {
    if (tx.active || !msg.length) return;
    txClear();
    tx.seq = morseSeq(msg); tx.active = true;
    beep("OK"); txStep();
  }
  function txStop() { if (tx.active) { txClear(); beep("PREV"); redraw(); } }

  /* ---- app state ---- */
  var SCR = { HOME: 0, CAL: 1, MORSE: 2 };
  var screen = SCR.HOME;
  var ticker = null;
  var redrawPending = false;
  function redraw() { redrawPending = true; }
  var homeFocus = 0; // 0 compass, 1 calibrate, 2 morse
  var meLast = null;

  var CAL_FIELDS = ["BEARING", "TRIM", "LAT", "LON", "UTC", "ACTION"];
  var CAL_ACTIONS = ["APPLY", "CAPTURE SUN", "THEME", "MOTION", "RESET"];
  var calIdx = 0, calAction = 0, calCoarse = false;

  var msg = "";
  var KEYS = [
    ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"],
    ["K", "L", "M", "N", "O", "P", "Q", "R", "S", "T"],
    ["U", "V", "W", "X", "Y", "Z", "0", "1", "2", "3"],
    ["4", "5", "6", "7", "8", "9", ".", ",", "?", "/"],
    ["SPC", "DEL", "CLR", "WPM-", "WPM+", "RPT", "TGT", "TX", "STOP"]
  ];
  var curRow = 0, curCol = 0;

  /* Fixed data hoisted out of the draw loop (no per-frame allocations). */
  var CARD8 = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  var CARD16 = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  var HOME_BTNS = [
    { t: "( COMPASS )",   x: W / 2,    f: 0 },
    { t: "[ CALIBRATE ]", x: X0 + 76,  f: 1 },
    { t: "[ MORSE ]",     x: X1 - 76,  f: 2 }
  ];

  /* ---- chrome ---- */
  function frame() {
    col(0); fill(0, 0, W - 1, H - 1);       // black everywhere; corners stay dark
    col(1);                                  // chamfered octagon clears the rounding
    var c = 10;
    line(X0 + c, Y0, X1 - c, Y0);
    line(X1, Y0 + c, X1, Y1 - c);
    line(X1 - c, Y1, X0 + c, Y1);
    line(X0, Y1 - c, X0, Y0 + c);
    line(X0, Y0 + c, X0 + c, Y0);
    line(X1 - c, Y0, X1, Y0 + c);
    line(X1, Y1 - c, X1 - c, Y1);
    line(X0 + c, Y1, X0, Y1 - c);
  }
  function header(title) {
    fSmall(); col(2); al(-1, -1);
    str("ROBCO INDUSTRIES (TM) TERMLINK", X0 + 12, Y0 + 5);
    col(3); al(1, -1); str(title, X1 - 12, Y0 + 5);
    col(1); line(X0 + 8, Y0 + 22, X1 - 8, Y0 + 22);
  }
  function footer(text) {
    col(1); line(X0 + 8, Y1 - 22, X1 - 8, Y1 - 22);
    fSmall(); col(2); al(-1, -1); str(text, X0 + 12, Y1 - 16);
  }

  /* ---- compass face ---- */
  function compassDisc(cx, cy, r, heading) {
    var i, ang, len, major, lr, lx, ly;
    col(1); circ(cx, cy, r); circ(cx, cy, r - 1);
    fSmall(); al(0, 0);
    for (i = 0; i < 360; i += 10) {          // tick ring
      ang = rad(i - heading);
      major = (i % 30 === 0); len = major ? 11 : 6;
      col(major ? 3 : 1);
      line(cx + Math.sin(ang) * r, cy - Math.cos(ang) * r,
           cx + Math.sin(ang) * (r - len), cy - Math.cos(ang) * (r - len));
    }
    for (i = 0; i < 8; i++) {                // rotating cardinal letters
      ang = rad(i * 45 - heading);
      lr = r - 22; lx = cx + Math.sin(ang) * lr; ly = cy - Math.cos(ang) * lr;
      col(i === 0 ? 3 : 2); str(CARD8[i], lx, ly);
    }
    col(3);                                  // fixed lubber arrow = where you point
    line(cx, cy - r - 2, cx - 7, cy - r - 13);
    line(cx, cy - r - 2, cx + 7, cy - r - 13);
    line(cx - 7, cy - r - 13, cx + 7, cy - r - 13);
    col(2); fill(cx - 2, cy - 2, cx + 2, cy + 2);
  }
  function cardinalName(hh) { return CARD16[Math.round(wrap360(hh) / 22.5) % 16]; }

  function drawHome() {
    frame(); header("ROBCO NAVIGATION");
    var heading = headingSmooth();
    var cx = W / 2, cy = 148, r = 80;
    compassDisc(cx, cy, r, heading);

    col(3); fBig(); al(0, 0); str(pad3(Math.round(wrap360(heading)) % 360) + "\xB0", cx, cy - 4);
    col(2); fSmall(); al(0, 0); str(cardinalName(heading), cx, cy + 20);
    col(2); str("MODE: MANUAL BEARING", cx, cy + r + 6);

    al(0, 0); fSmall();
    for (var i = 0; i < HOME_BTNS.length; i++) {
      var b = HOME_BTNS[i];
      if (homeFocus === b.f) {
        var bw = sw(b.t) + 12;
        col(2); fill(b.x - bw / 2, Y1 - 40, b.x + bw / 2, Y1 - 24); col(0);
      } else col(2);
      str(b.t, b.x, Y1 - 32);
    }
    footer("K1 TURN:SELECT  PRESS:OPEN  K2:BEARING  ITEMS:EXIT");
    flip();
  }

  /* ---- calibration ---- */
  function actionLabel(i) {
    if (i === 2) return "THEME: " + cfg.theme.toUpperCase();
    if (i === 3) return "MOTION ASSIST: " + (cfg.motionEst ? "ON" : "OFF");
    return CAL_ACTIONS[i];
  }
  function calValue(i) {
    switch (CAL_FIELDS[i]) {
      case "BEARING": return head3() + "\xB0 (" + (calCoarse ? "x10" : "x1") + ")";
      case "TRIM":    return (cfg.trim >= 0 ? "+" : "") + cfg.trim + "\xB0";
      case "LAT":     return cfg.lat.toFixed(1) + (cfg.locSet ? "" : " (NOT SET)");
      case "LON":     return cfg.lon.toFixed(1);
      case "UTC":     return (cfg.utcOff >= 0 ? "+" : "") + cfg.utcOff + "H";
      case "ACTION":  return actionLabel(calAction);
    }
    return "";
  }
  function drawCalibrate() {
    frame(); header("CALIBRATION");
    var y = Y0 + 26, lh = 22, i, yy, sel;
    fSmall();
    for (i = 0; i < CAL_FIELDS.length; i++) {
      yy = y + i * lh; sel = (calIdx === i);
      if (sel) { col(2); fill(X0 + 6, yy - 2, X1 - 6, yy + lh - 6); col(0); } else col(2);
      al(-1, -1); str(CAL_FIELDS[i], X0 + 14, yy);
      col(sel ? 0 : 3); str(calValue(i), X0 + 122, yy);
    }
    var sy = y + CAL_FIELDS.length * lh + 4;
    col(1); line(X0 + 6, sy - 2, X1 - 6, sy - 2);
    var sun = solarAzimuth(new Date());
    col(2); al(-1, -1);
    str("SUN: " + (sun === null ? "SET LAT/LON (~" + coarseSolar() + "\xB0)" : Math.round(sun) + "\xB0"),
        X0 + 14, sy + 4);
    footer("K2:FIELD  K1:VALUE  K1 PRESS:DO  TORCH:BACK");
    flip();
  }
  function changeField(dir) {
    var s = dir > 0 ? 1 : -1, f = CAL_FIELDS[calIdx];
    if (f === "BEARING") setReference(wrap360(cfg.bearing + cfg.trim + s * (calCoarse ? 10 : 1)));
    else if (f === "TRIM") cfg.trim = clamp(cfg.trim + s, -180, 180);
    else if (f === "LAT") { cfg.lat = clamp(cfg.lat + s * 0.5, -90, 90); cfg.locSet = true; }
    else if (f === "LON") { cfg.lon = clamp(cfg.lon + s * 0.5, -180, 180); cfg.locSet = true; }
    else if (f === "UTC") cfg.utcOff = clamp(cfg.utcOff + s, -12, 14);
    else if (f === "ACTION") calAction = (calAction + (s > 0 ? 1 : CAL_ACTIONS.length - 1)) % CAL_ACTIONS.length;
  }
  function calActivate() {
    var f = CAL_FIELDS[calIdx];
    if (f === "BEARING") { calCoarse = !calCoarse; beep("CLICK"); redraw(); return; }
    if (f !== "ACTION") { beep("CLICK"); return; }
    if (calAction === 0) { saveCfg(); beep("OK"); }                       // APPLY
    else if (calAction === 1) {                                           // CAPTURE SUN
      var sun = solarAzimuth(new Date()); if (sun === null) sun = coarseSolar();
      setReference(sun); saveCfg(); beep("OK");
    } else if (calAction === 2) {                                         // THEME
      cfg.theme = cfg.theme === "green" ? "amber" : "green"; saveCfg(); beep("OK");
    } else if (calAction === 3) {                                         // MOTION ASSIST
      cfg.motionEst = !cfg.motionEst;
      if (cfg.motionEst) accelStart(); else accelStop();
      saveCfg(); beep("OK");
    } else { cfg.bearing = 0; cfg.trim = 0; setReference(0); saveCfg(); beep("PREV"); } // RESET
    redraw();
  }

  /* ---- Morse screen ---- */
  function repLabel() { return cfg.repeatMode === 0 ? "ONCE" : (cfg.repeatMode === 1 ? ("x" + cfg.repeatCount) : "LOOP"); }
  function tgtLabel() { return cfg.flashTarget === 0 ? "SCREEN" : (cfg.flashTarget === 1 ? "TORCH" : "BOTH"); }
  function drawMorse() {
    if (tx.active) {
      if (tx.flashOn) { col(3); fill(0, 0, W - 1, H - 1); flip(); return; } // max-light pulse
      frame(); header("MORSE TX");
      col(3); fBig(); al(0, 0); str("TRANSMITTING", W / 2, Y0 + 90);
      col(2); fSmall();
      str(msg, W / 2, Y0 + 120);
      str("RPT " + repLabel() + "   WPM " + cfg.wpm + "   TGT " + tgtLabel(), W / 2, Y0 + 144);
      footer("TORCH:STOP");
      flip(); return;
    }
    frame(); header("MORSE TX");
    fSmall(); col(3); al(-1, -1);
    str("MSG: " + (msg || "_"), X0 + 10, Y0 + 6);
    col(2); var pv = morsePreview(msg); if (pv.length > 52) pv = pv.slice(0, 49) + "...";
    str(pv, X0 + 10, Y0 + 22);
    col(1); line(X0 + 6, Y0 + 38, X1 - 6, Y0 + 38);
    col(2); al(-1, -1);
    str("WPM:" + cfg.wpm + " UNIT:" + unitMs() + "ms RPT:" + repLabel() + " TGT:" + tgtLabel(), X0 + 10, Y0 + 42);

    var gx = X0 + 3, gy = Y0 + 64, cw = 43, ch = 26, ri, ci, kx, ky, sel;
    al(0, 0);
    for (ri = 0; ri < KEYS.length; ri++) {
      for (ci = 0; ci < KEYS[ri].length; ci++) {
        kx = gx + ci * cw; ky = gy + ri * ch; sel = (curRow === ri && curCol === ci);
        if (sel) { col(2); fill(kx, ky, kx + cw - 3, ky + ch - 3); col(0); }
        else { col(1); rect(kx, ky, kx + cw - 3, ky + ch - 3); col(2); }
        str(KEYS[ri][ci], kx + (cw - 3) / 2, ky + (ch - 3) / 2);
      }
    }
    footer("K1:ROW  K2:COL  K1 PRESS:KEY  TORCH:BACK");
    flip();
  }
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

  /* ---- dispatch + loop ---- */
  function draw() {
    if (!G) return;
    if (screen === SCR.HOME) drawHome();
    else if (screen === SCR.CAL) drawCalibrate();
    else drawMorse();
  }
  function motionEstimate() {
    var a = accelRead(); if (!a) return;
    if (meLast !== null) { var dy = a.y - meLast; if (Math.abs(dy) > 0.25) nudge(dy > 0 ? 2 : -2); }
    meLast = a.y;
  }
  function tick() {
    try {
      if (screen === SCR.HOME) {
        if (cfg.motionEst) motionEstimate();
        redrawPending = true;                // animate the needle
      }
      if (redrawPending) { redrawPending = false; draw(); }
    } catch (e) {}
  }

  /* ---- input ---- */
  function press1() {
    if (screen === SCR.HOME) {
      if (homeFocus === 1) gotoCal();
      else if (homeFocus === 2) gotoMorse();
      else beep("OK");
    } else if (screen === SCR.CAL) calActivate();
    else morseActivate();
  }
  function onKnob1(dir) {
    try {
      if (dir === 0) { press1(); return; }
      if (screen === SCR.HOME) { homeFocus = (homeFocus + (dir > 0 ? 1 : 2)) % 3; beep("CLICK"); redraw(); }
      else if (screen === SCR.CAL) { changeField(dir); beep("CLICK"); redraw(); }
      else { curRow = clamp(curRow + (dir > 0 ? 1 : -1), 0, KEYS.length - 1); curCol = clamp(curCol, 0, KEYS[curRow].length - 1); beep("CLICK"); redraw(); }
    } catch (e) {}
  }
  function onKnob2(dir) {
    try {
      if (screen === SCR.HOME) { nudge(dir > 0 ? 1 : -1); beep("CLICK"); redraw(); }
      else if (screen === SCR.CAL) { calIdx = (calIdx + (dir > 0 ? 1 : CAL_FIELDS.length - 1)) % CAL_FIELDS.length; beep("CLICK"); redraw(); }
      else { curCol = clamp(curCol + (dir > 0 ? 1 : -1), 0, KEYS[curRow].length - 1); beep("CLICK"); redraw(); }
    } catch (e) {}
  }
  function onTorch() {
    try {
      if (screen === SCR.MORSE && tx.active) { txStop(); return; }
      if (screen !== SCR.HOME) { saveCfg(); screen = SCR.HOME; beep("OK"); redraw(); }
    } catch (e) {}
  }
  function gotoCal() { screen = SCR.CAL; calIdx = 0; beep("OK"); redraw(); }
  function gotoMorse() { screen = SCR.MORSE; curRow = 0; curCol = 0; beep("OK"); redraw(); }

  /* ---- lifecycle ---- */
  function start() {
    loadCfg();
    if (cfg.motionEst) accelStart();
    disp = headingRaw();
    try {
      if (typeof Pip !== "undefined" && Pip.on) {
        Pip.on("knob1", onKnob1);
        Pip.on("knob2", onKnob2);
        Pip.on("torch", onTorch);
      }
    } catch (e) {}
    draw();
    ticker = setInterval(tick, 120);
  }
  function cleanup() {
    try { if (ticker) clearInterval(ticker); } catch (e) {}
    ticker = null;
    try { txClear(); } catch (e) {}
    torchSet(0);
    try {
      if (typeof Pip !== "undefined") {
        if (Pip.removeListener) {
          Pip.removeListener("knob1", onKnob1);
          Pip.removeListener("knob2", onKnob2);
          Pip.removeListener("torch", onTorch);
        } else if (Pip.removeAllListeners) {
          Pip.removeAllListeners("knob1");
          Pip.removeAllListeners("knob2");
          Pip.removeAllListeners("torch");
        }
      }
    } catch (e) {}
    accelStop();
    saveCfg();
  }

  start();

  return { id: "COMPASS", notDefault: true, fullscreen: true, remove: cleanup };
})
