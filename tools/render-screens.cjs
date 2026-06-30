/* render-screens.cjs  -  generate faithful PNG screenshots of the Compass UI.
 *
 *   node tools/render-screens.cjs        (or: npm run shots)
 *
 * This does NOT mock up the look by hand. It evaluates the REAL app factory in
 * src/COMPASS.JS against a from-scratch software rasterizer that implements the
 * exact Espruino Graphics subset the app calls (setColor/drawString/drawLine/
 * drawRect/fillRect/drawCircle/setFontAlign/stringWidth). The app draws itself;
 * we just capture the framebuffer, add a phosphor-CRT post-process (bloom +
 * scanlines + vignette) and encode a PNG with zlib. No external dependencies.
 *
 * Output (screenshots/):
 *   01-home.png 02-calibrate.png 03-morse-keypad.png 04-morse-transmit.png
 *   05-home-amber.png   preview-contact-sheet.png
 *
 * Because the same code path that ships to the device produces these images,
 * the screenshots stay honest: if the UI changes, re-run this and they update.
 */
"use strict";
var fs = require("fs");
var path = require("path");
var zlib = require("zlib");

var SRC = path.join(__dirname, "..", "src", "COMPASS.JS");
var OUT_DIR = path.join(__dirname, "..", "screenshots");
var SRC_CODE = fs.readFileSync(SRC, "utf8");

var DEV_W = 480, DEV_H = 320;   // device logical resolution
var SCALE = 2;                  // output = 2x device  => 960 x 640
var IW = DEV_W * SCALE, IH = DEV_H * SCALE;

/* ----------------------------------------------------------------- *
 *  5x7 uppercase phosphor font (all-caps RobCo terminal aesthetic).
 *  Lowercase is mapped to caps; unknown glyphs render blank.
 * ----------------------------------------------------------------- */
var FONT = {
  " ": ["     ", "     ", "     ", "     ", "     ", "     ", "     "],
  "A": [" XXX ", "X   X", "X   X", "XXXXX", "X   X", "X   X", "X   X"],
  "B": ["XXXX ", "X   X", "X   X", "XXXX ", "X   X", "X   X", "XXXX "],
  "C": [" XXX ", "X   X", "X    ", "X    ", "X    ", "X   X", " XXX "],
  "D": ["XXXX ", "X   X", "X   X", "X   X", "X   X", "X   X", "XXXX "],
  "E": ["XXXXX", "X    ", "X    ", "XXXX ", "X    ", "X    ", "XXXXX"],
  "F": ["XXXXX", "X    ", "X    ", "XXXX ", "X    ", "X    ", "X    "],
  "G": [" XXX ", "X   X", "X    ", "X XXX", "X   X", "X   X", " XXXX"],
  "H": ["X   X", "X   X", "X   X", "XXXXX", "X   X", "X   X", "X   X"],
  "I": ["XXXXX", "  X  ", "  X  ", "  X  ", "  X  ", "  X  ", "XXXXX"],
  "J": ["XXXXX", "   X ", "   X ", "   X ", "X  X ", "X  X ", " XX  "],
  "K": ["X   X", "X  X ", "X X  ", "XX   ", "X X  ", "X  X ", "X   X"],
  "L": ["X    ", "X    ", "X    ", "X    ", "X    ", "X    ", "XXXXX"],
  "M": ["X   X", "XX XX", "X X X", "X X X", "X   X", "X   X", "X   X"],
  "N": ["X   X", "XX  X", "X X X", "X X X", "X  XX", "X   X", "X   X"],
  "O": [" XXX ", "X   X", "X   X", "X   X", "X   X", "X   X", " XXX "],
  "P": ["XXXX ", "X   X", "X   X", "XXXX ", "X    ", "X    ", "X    "],
  "Q": [" XXX ", "X   X", "X   X", "X   X", "X X X", "X  X ", " XX X"],
  "R": ["XXXX ", "X   X", "X   X", "XXXX ", "X X  ", "X  X ", "X   X"],
  "S": [" XXXX", "X    ", "X    ", " XXX ", "    X", "    X", "XXXX "],
  "T": ["XXXXX", "  X  ", "  X  ", "  X  ", "  X  ", "  X  ", "  X  "],
  "U": ["X   X", "X   X", "X   X", "X   X", "X   X", "X   X", " XXX "],
  "V": ["X   X", "X   X", "X   X", "X   X", "X   X", " X X ", "  X  "],
  "W": ["X   X", "X   X", "X   X", "X X X", "X X X", "XX XX", "X   X"],
  "X": ["X   X", "X   X", " X X ", "  X  ", " X X ", "X   X", "X   X"],
  "Y": ["X   X", "X   X", " X X ", "  X  ", "  X  ", "  X  ", "  X  "],
  "Z": ["XXXXX", "    X", "   X ", "  X  ", " X   ", "X    ", "XXXXX"],
  "0": [" XXX ", "X   X", "X  XX", "X X X", "XX  X", "X   X", " XXX "],
  "1": ["  X  ", " XX  ", "  X  ", "  X  ", "  X  ", "  X  ", " XXX "],
  "2": [" XXX ", "X   X", "    X", "   X ", "  X  ", " X   ", "XXXXX"],
  "3": ["XXXXX", "   X ", "  X  ", "   X ", "    X", "X   X", " XXX "],
  "4": ["   X ", "  XX ", " X X ", "X  X ", "XXXXX", "   X ", "   X "],
  "5": ["XXXXX", "X    ", "XXXX ", "    X", "    X", "X   X", " XXX "],
  "6": [" XXX ", "X    ", "X    ", "XXXX ", "X   X", "X   X", " XXX "],
  "7": ["XXXXX", "    X", "   X ", "  X  ", " X   ", " X   ", " X   "],
  "8": [" XXX ", "X   X", "X   X", " XXX ", "X   X", "X   X", " XXX "],
  "9": [" XXX ", "X   X", "X   X", " XXXX", "    X", "    X", " XXX "],
  ".": ["     ", "     ", "     ", "     ", "     ", " XX  ", " XX  "],
  ",": ["     ", "     ", "     ", "     ", " XX  ", " XX  ", "X    "],
  ":": ["     ", " XX  ", " XX  ", "     ", " XX  ", " XX  ", "     "],
  ";": ["     ", " XX  ", " XX  ", "     ", " XX  ", " XX  ", "X    "],
  "-": ["     ", "     ", "     ", "XXXXX", "     ", "     ", "     "],
  "+": ["     ", "  X  ", "  X  ", "XXXXX", "  X  ", "  X  ", "     "],
  "/": ["    X", "    X", "   X ", "  X  ", " X   ", "X    ", "X    "],
  "?": [" XXX ", "X   X", "    X", "   X ", "  X  ", "     ", "  X  "],
  "_": ["     ", "     ", "     ", "     ", "     ", "     ", "XXXXX"],
  "(": ["  XX ", " X   ", " X   ", " X   ", " X   ", " X   ", "  XX "],
  ")": [" XX  ", "   X ", "   X ", "   X ", "   X ", "   X ", " XX  "],
  "[": [" XXX ", " X   ", " X   ", " X   ", " X   ", " X   ", " XXX "],
  "]": [" XXX ", "   X ", "   X ", "   X ", "   X ", "   X ", " XXX "],
  "!": ["  X  ", "  X  ", "  X  ", "  X  ", "  X  ", "     ", "  X  "],
  "=": ["     ", "     ", "XXXXX", "     ", "XXXXX", "     ", "     "],
  "*": ["     ", "X X X", " XXX ", "XXXXX", " XXX ", "X X X", "     "],
  "°": [" XX  ", "X  X ", " XX  ", "     ", "     ", "     ", "     "]
};

/* ----------------------------------------------------------------- *
 *  Software rasterizer that speaks the Espruino Graphics subset.
 *  fb holds opaque RGB floats (0..1) on near-black; primitives paint
 *  with coverage so diagonals/circles are anti-aliased.
 * ----------------------------------------------------------------- */
function makeRaster() {
  var fb = new Float32Array(IW * IH * 3);
  var cur = [0, 0, 0];
  var fontBig = false;
  var alignX = -1, alignY = -1;
  var drawn = [];                    // strings drawn since last reset (for state detection)

  function adv() { return fontBig ? 18 : 6; }
  function fh() { return fontBig ? 21 : 7; }
  function fp() { return fontBig ? 3 : 1; }   // device px per font-pixel

  function blend(ix, iy, a) {
    if (a <= 0 || ix < 0 || iy < 0 || ix >= IW || iy >= IH) return;
    if (a > 1) a = 1;
    var o = (iy * IW + ix) * 3, ia = 1 - a;
    fb[o] = fb[o] * ia + cur[0] * a;
    fb[o + 1] = fb[o + 1] * ia + cur[1] * a;
    fb[o + 2] = fb[o + 2] * ia + cur[2] * a;
  }

  function fillBox(dx1, dy1, dx2, dy2) {           // device coords, solid
    var x1 = Math.round(Math.min(dx1, dx2) * SCALE);
    var y1 = Math.round(Math.min(dy1, dy2) * SCALE);
    var x2 = Math.round(Math.max(dx1, dx2) * SCALE);
    var y2 = Math.round(Math.max(dy1, dy2) * SCALE);
    if (x1 < 0) x1 = 0; if (y1 < 0) y1 = 0;
    if (x2 > IW) x2 = IW; if (y2 > IH) y2 = IH;
    for (var y = y1; y < y2; y++) for (var x = x1; x < x2; x++) blend(x, y, 1);
  }

  function lineSeg(dx1, dy1, dx2, dy2) {           // device coords, AA, ~1 device px
    var ax = dx1 * SCALE, ay = dy1 * SCALE, bx = dx2 * SCALE, by = dy2 * SCALE;
    var half = SCALE / 2;
    var minx = Math.floor(Math.min(ax, bx) - half - 1), maxx = Math.ceil(Math.max(ax, bx) + half + 1);
    var miny = Math.floor(Math.min(ay, by) - half - 1), maxy = Math.ceil(Math.max(ay, by) + half + 1);
    var vx = bx - ax, vy = by - ay, len2 = vx * vx + vy * vy;
    for (var y = miny; y <= maxy; y++) {
      for (var x = minx; x <= maxx; x++) {
        var t = len2 ? ((x - ax) * vx + (y - ay) * vy) / len2 : 0;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        var px = ax + vx * t, py = ay + vy * t;
        var d = Math.sqrt((x - px) * (x - px) + (y - py) * (y - py));
        blend(x, y, half + 0.5 - d);
      }
    }
  }

  function ring(dcx, dcy, dr) {                    // device coords, AA circle
    var cx = dcx * SCALE, cy = dcy * SCALE, r = dr * SCALE, half = SCALE / 2;
    var minx = Math.floor(cx - r - half - 1), maxx = Math.ceil(cx + r + half + 1);
    var miny = Math.floor(cy - r - half - 1), maxy = Math.ceil(cy + r + half + 1);
    for (var y = miny; y <= maxy; y++) {
      for (var x = minx; x <= maxx; x++) {
        var d = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
        blend(x, y, half + 0.5 - Math.abs(d - r));
      }
    }
  }

  function glyph(ch, dx, dy) {
    var g = FONT[ch] || FONT[ch.toUpperCase()] || null;
    if (!g) return;
    var s = fp();
    for (var r = 0; r < 7; r++) {
      var row = g[r];
      for (var c = 0; c < 5; c++) {
        if (row[c] === "X") fillBox(dx + c * s, dy + r * s, dx + c * s + s, dy + r * s + s);
      }
    }
  }

  return {
    getWidth: function () { return DEV_W; },
    getHeight: function () { return DEV_H; },
    setColor: function (r, g, b) {
      cur = [Math.max(0, Math.min(1, +r || 0)), Math.max(0, Math.min(1, +g || 0)), Math.max(0, Math.min(1, +b || 0))];
      return this;
    },
    setFont: function (name) { fontBig = /23|2[0-9]|Big|Large/.test("" + name); return this; },
    setFontVector: function (n) { fontBig = (+n || 0) >= 18; return this; },
    setFontAlign: function (x, y) { alignX = x; if (y !== undefined) alignY = y; return this; },
    drawString: function (s, x, y) {
      s = "" + s; drawn.push(s);
      var w = s.length * adv(), h = fh();
      var x0 = alignX === 0 ? x - w / 2 : (alignX > 0 ? x - w : x);
      var y0 = alignY === 0 ? y - h / 2 : (alignY > 0 ? y - h : y);
      for (var i = 0; i < s.length; i++) glyph(s[i], x0 + i * adv(), y0);
      return this;
    },
    drawLine: function (x1, y1, x2, y2) { lineSeg(x1, y1, x2, y2); return this; },
    drawRect: function (x1, y1, x2, y2) {
      lineSeg(x1, y1, x2, y1); lineSeg(x2, y1, x2, y2);
      lineSeg(x2, y2, x1, y2); lineSeg(x1, y2, x1, y1); return this;
    },
    fillRect: function (x1, y1, x2, y2) { fillBox(x1, y1, x2 + 1, y2 + 1); return this; },
    drawCircle: function (x, y, r) { ring(x, y, r); return this; },
    stringWidth: function (s) { return ("" + s).length * adv(); },
    reset: function () { return this; },
    clear: function () { fb.fill(0); return this; },
    flip: function () { return this; },
    _fb: fb,
    _drawn: drawn,
    _resetDrawn: function () { drawn.length = 0; }
  };
}

/* ----------------------------------------------------------------- *
 *  Phosphor-CRT post-process + PNG encode.
 * ----------------------------------------------------------------- */
var THEME_RGB = { green: [0.10, 1.00, 0.50], amber: [1.00, 0.71, 0.26] };

function boxBlur(src, w, h, radius) {
  var tmp = new Float32Array(w * h), out = new Float32Array(w * h), x, y, i, sum;
  var n = radius * 2 + 1;
  for (y = 0; y < h; y++) {            // horizontal
    sum = 0;
    for (i = -radius; i <= radius; i++) sum += src[y * w + Math.min(w - 1, Math.max(0, i))];
    for (x = 0; x < w; x++) {
      tmp[y * w + x] = sum / n;
      var add = Math.min(w - 1, x + radius + 1), sub = Math.max(0, x - radius);
      sum += src[y * w + add] - src[y * w + sub];
    }
  }
  for (x = 0; x < w; x++) {            // vertical
    sum = 0;
    for (i = -radius; i <= radius; i++) sum += tmp[Math.min(h - 1, Math.max(0, i)) * w + x];
    for (y = 0; y < h; y++) {
      out[y * w + x] = sum / n;
      var add2 = Math.min(h - 1, y + radius + 1), sub2 = Math.max(0, y - radius);
      sum += tmp[add2 * w + x] - tmp[sub2 * w + x];
    }
  }
  return out;
}

function colorize(fb, theme) {        // fb -> RGBA Buffer with bloom/scanline/vignette
  var tint = THEME_RGB[theme] || THEME_RGB.green;
  var lum = new Float32Array(IW * IH), i;
  for (i = 0; i < IW * IH; i++) lum[i] = Math.max(fb[i * 3], fb[i * 3 + 1], fb[i * 3 + 2]);
  var glow = boxBlur(boxBlur(lum, IW, IH, 2), IW, IH, 4);
  var rgba = Buffer.alloc(IW * IH * 4);
  var cx = IW / 2, cy = IH / 2, maxd = Math.sqrt(cx * cx + cy * cy);
  for (var y = 0; y < IH; y++) {
    var scan = (y % 2 === 0) ? 1.0 : 0.84;
    for (var x = 0; x < IW; x++) {
      i = y * IW + x; var o = i * 3;
      var g = glow[i] * 0.7;
      var r = fb[o] + tint[0] * g + tint[0] * 0.018;
      var gg = fb[o + 1] + tint[1] * g + tint[1] * 0.018;
      var b = fb[o + 2] + tint[2] * g + tint[2] * 0.018;
      var dx = x - cx, dy = y - cy, vig = 1 - 0.42 * Math.pow(Math.sqrt(dx * dx + dy * dy) / maxd, 2.2);
      var f = scan * vig;
      var p = i * 4;
      rgba[p] = Math.max(0, Math.min(255, Math.round(r * f * 255)));
      rgba[p + 1] = Math.max(0, Math.min(255, Math.round(gg * f * 255)));
      rgba[p + 2] = Math.max(0, Math.min(255, Math.round(b * f * 255)));
      rgba[p + 3] = 255;
    }
  }
  return rgba;
}

var CRC_T = (function () {
  var t = new Uint32Array(256);
  for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { var c = 0xFFFFFFFF; for (var i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function pngChunk(type, data) {
  var len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  var t = Buffer.from(type, "ascii");
  var crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(w, h, rgba) {
  var stride = w * 4, raw = Buffer.alloc((stride + 1) * h);
  for (var y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride); }
  var idat = zlib.deflateSync(raw, { level: 9 });
  var sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}

/* ----------------------------------------------------------------- *
 *  Drive the REAL app into a given screen state, return its framebuffer.
 * ----------------------------------------------------------------- */
function runScenario(cfgSeed, drive) {
  var G = makeRaster();
  var handlers = {}, intervals = {}, timeouts = {}, tid = 1, ledState = 0;
  var env = {
    h: G, g: G, bC: undefined,
    digitalWrite: function (p, v) { ledState = v ? 1 : 0; },
    LED_GREEN: { pin: "E5" },
    E: { openFile: function () { return null; } },
    Pip: {
      on: function (e, f) { handlers[e] = f; },
      removeListener: function (e, f) { if (handlers[e] === f) delete handlers[e]; },
      removeAllListeners: function (e) { delete handlers[e]; },
      audioBuiltin: function () {}
    },
    require: function (m) {
      if (m === "fs") return {
        readFileSync: function () { if (cfgSeed) return JSON.stringify(cfgSeed); throw new Error("ENOENT"); },
        writeFileSync: function () {}
      };
      throw new Error("no " + m);
    },
    setInterval: function (f) { var id = tid++; intervals[id] = f; return id; },
    clearInterval: function (id) { delete intervals[id]; },
    setTimeout: function (f) { var id = tid++; timeouts[id] = f; return id; },
    clearTimeout: function (id) { delete timeouts[id]; }
  };
  // Evaluate the factory with the Espruino globals in (non-strict) scope.
  var factory = new Function(
    "h", "g", "bC", "digitalWrite", "LED_GREEN", "E", "Pip", "require",
    "setInterval", "clearInterval", "setTimeout", "clearTimeout", "src",
    "return eval(src);"
  )(env.h, env.g, env.bC, env.digitalWrite, env.LED_GREEN, env.E, env.Pip, env.require,
    env.setInterval, env.clearInterval, env.setTimeout, env.clearTimeout, SRC_CODE);

  var app = factory();
  var ctx = {
    G: G, app: app,
    knob1: function (d) { handlers.knob1(d); },
    knob2: function (d) { handlers.knob2(d); },
    torch: function () { handlers.torch(); },
    accel: function (a) { if (handlers.accel) handlers.accel(a); },
    tick: function () { var k = Object.keys(intervals); if (k.length) intervals[k[0]](); },
    stepTimeout: function () { var k = Object.keys(timeouts); if (!k.length) return false; var f = timeouts[k[0]]; delete timeouts[k[0]]; G._resetDrawn(); f(); return true; },
    timeoutCount: function () { return Object.keys(timeouts).length; }
  };
  var captured = drive(ctx);                  // may return a captured fb copy
  try { app.remove(); } catch (e) {}
  return captured || G._fb;
}

function snapshot(fb) { var c = new Float32Array(fb.length); c.set(fb); return c; }

/* --- scenario drivers --------------------------------------------- */
function driveHome(ctx) { ctx.accel({ x: 0.02, y: -0.01, z: 0.99 }); ctx.tick(); return null; }

function driveCalibrate(ctx) {
  // HOME -> focus CALIBRATE (homeFocus 0->1) -> press to open
  ctx.knob1(1); ctx.tick();
  ctx.knob1(0); ctx.tick();
  // select METHOD field, flip to SOLAR so the screen shows the solar workflow
  ctx.tick();
  return null;
}

function navMorse(ctx) { ctx.knob1(1); ctx.tick(); ctx.knob1(1); ctx.tick(); ctx.knob1(0); ctx.tick(); }
function morseKey(ctx, row, col) {
  // move to (row,col) on the keypad then press select
  for (var r = 0; r < 6; r++) { ctx.knob1(-1); ctx.tick(); }   // home row
  for (var rr = 0; rr < row; rr++) { ctx.knob1(1); ctx.tick(); }
  for (var c = 0; c < 12; c++) { ctx.knob2(-1); ctx.tick(); }  // home col
  for (var cc = 0; cc < col; cc++) { ctx.knob2(1); ctx.tick(); }
  ctx.knob1(0); ctx.tick();
}
function driveMorseKeypad(ctx) {
  navMorse(ctx);
  morseKey(ctx, 1, 8); // S
  morseKey(ctx, 1, 4); // O
  morseKey(ctx, 1, 8); // S
  return null;
}
function driveMorseTransmit(ctx) {
  navMorse(ctx);
  morseKey(ctx, 1, 8); morseKey(ctx, 1, 4); morseKey(ctx, 1, 8); // SOS
  morseKey(ctx, 4, 7); // TX  (row4 index7) -> starts transmit synchronously
  // Step the pulse chain until a "TRANSMITTING" plate frame is drawn, capture it.
  for (var i = 0; i < 16; i++) {
    if (ctx.G._drawn.join(" ").indexOf("TRANSMITTING") >= 0 && ctx.G._drawn.join(" ").indexOf("WPM") >= 0) {
      return snapshot(ctx.G._fb);
    }
    if (!ctx.stepTimeout()) break;
  }
  return null;
}

/* ----------------------------------------------------------------- */
var LOC = { lat: 39.5, lon: -105.0, locSet: true, utcOff: -6 };
function seed(extra) {
  var base = { theme: "green", bearing: 42, trim: 0, decl: 0 };
  for (var k in LOC) base[k] = LOC[k];
  if (extra) for (var j in extra) base[j] = extra[j];
  return base;
}

var SHOTS = [
  { file: "01-home.png", theme: "green", seed: seed(), drive: driveHome, label: "HOME / COMPASS" },
  { file: "02-calibrate.png", theme: "green", seed: seed(), drive: driveCalibrate, label: "CALIBRATE" },
  { file: "03-morse-keypad.png", theme: "green", seed: seed(), drive: driveMorseKeypad, label: "MORSE KEYPAD" },
  { file: "04-morse-transmit.png", theme: "green", seed: seed(), drive: driveMorseTransmit, label: "MORSE TRANSMIT" },
  { file: "05-home-amber.png", theme: "amber", seed: seed({ theme: "amber", bearing: 213 }), drive: driveHome, label: "AMBER THEME" }
];

/* --- contact sheet (2 x 2 of the core screens, downscaled) -------- */
function downscale2(rgba, w, h) {
  var ow = w >> 1, oh = h >> 1, out = Buffer.alloc(ow * oh * 4);
  for (var y = 0; y < oh; y++) for (var x = 0; x < ow; x++) {
    var sx = x * 2, sy = y * 2, o = (y * ow + x) * 4;
    for (var ch = 0; ch < 4; ch++) {
      out[o + ch] = Math.round((rgba[(sy * w + sx) * 4 + ch] + rgba[(sy * w + sx + 1) * 4 + ch] +
        rgba[((sy + 1) * w + sx) * 4 + ch] + rgba[((sy + 1) * w + sx + 1) * 4 + ch]) / 4);
    }
  }
  return { rgba: out, w: ow, h: oh };
}
function sheetText(buf, w, s, dx, dy, tint) {
  for (var i = 0; i < s.length; i++) {
    var g = FONT[s[i]] || FONT[(s[i] || "").toUpperCase()]; if (!g) continue;
    for (var r = 0; r < 7; r++) for (var c = 0; c < 5; c++) if (g[r][c] === "X") {
      for (var py = 0; py < 2; py++) for (var px = 0; px < 2; px++) {
        var X = dx + i * 12 + c * 2 + px, Y = dy + r * 2 + py, o = (Y * w + X) * 4;
        buf[o] = Math.round(tint[0] * 255); buf[o + 1] = Math.round(tint[1] * 255); buf[o + 2] = Math.round(tint[2] * 255); buf[o + 3] = 255;
      }
    }
  }
}
function buildContactSheet(cells) {        // cells: [{rgba,w,h,label}]
  var cw = cells[0].w, ch = cells[0].h, pad = 22, lab = 26;
  var cols = 2, rows = 2;
  var W = pad + cols * cw + (cols - 1) * pad + pad;
  var H = pad + rows * (lab + ch) + (rows - 1) * pad + pad;
  var buf = Buffer.alloc(W * H * 4);
  for (var i = 0; i < W * H; i++) { buf[i * 4] = 3; buf[i * 4 + 1] = 16; buf[i * 4 + 2] = 9; buf[i * 4 + 3] = 255; }
  for (var idx = 0; idx < cells.length && idx < 4; idx++) {
    var cxi = idx % cols, cyi = (idx / cols) | 0;
    var ox = pad + cxi * (cw + pad), oy = pad + cyi * (lab + ch + pad);
    sheetText(buf, W, cells[idx].label, ox + 2, oy + 6, THEME_RGB.green);
    var img = cells[idx].rgba;
    for (var y = 0; y < ch; y++) for (var x = 0; x < cw; x++) {
      var so = (y * cw + x) * 4, dO = ((oy + lab + y) * W + (ox + x)) * 4;
      buf[dO] = img[so]; buf[dO + 1] = img[so + 1]; buf[dO + 2] = img[so + 2]; buf[dO + 3] = 255;
    }
  }
  return { rgba: buf, w: W, h: H };
}

/* ----------------------------------------------------------------- */
function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  var cells = [];
  SHOTS.forEach(function (shot) {
    var fb = runScenario(shot.seed, shot.drive);
    var rgba = colorize(fb, shot.theme);
    fs.writeFileSync(path.join(OUT_DIR, shot.file), encodePNG(IW, IH, rgba));
    console.log("Wrote screenshots/" + shot.file + "  (" + IW + "x" + IH + ")");
    if (shot.file.indexOf("amber") < 0) {
      var ds = downscale2(rgba, IW, IH);
      cells.push({ rgba: ds.rgba, w: ds.w, h: ds.h, label: shot.label });
    }
  });
  var sheet = buildContactSheet(cells);
  fs.writeFileSync(path.join(OUT_DIR, "preview-contact-sheet.png"), encodePNG(sheet.w, sheet.h, sheet.rgba));
  console.log("Wrote screenshots/preview-contact-sheet.png  (" + sheet.w + "x" + sheet.h + ")");
}
main();
