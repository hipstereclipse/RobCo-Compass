/* render-screens.cjs  -  generate faithful PNG screenshots of the Compass UI.
 *
 *   node tools/render-screens.cjs        (or: npm run shots)
 *
 * HOW IT STAYS HONEST
 * -------------------
 * This does NOT mock up the look by hand. It evaluates the REAL app factory in
 * src/COMPASS.JS against a mock Espruino `h` that RECORDS every draw op the app
 * emits (drawString / drawLine / drawRect / fillRect / drawCircle / clear, each
 * tagged with the integer palette index the app set via setColor). It then
 * replays those ops through a small rasterizer that mimics the device:
 *
 *   - the two device fonts: a chunky monospaced bitmap face for "Monofonto23"
 *     and a smaller one for "6x8" (the footer / compact readouts);
 *   - the 4-level green phosphor palette (BG/DIM/MID/FG);
 *   - the ROUND glass: pixels outside the rounded-rectangle bezel are masked to
 *     black, so the screenshot shows EXACTLY what the curved display reveals.
 *     If anything were drawn in a clipped corner, it would visibly disappear
 *     here too -- the screenshots can't hide a layout that bleeds into the arc.
 *   - a light CRT post (bloom + scanlines + vignette).
 *
 * Because the same draw ops that reach the device produce these images, the
 * screenshots track the shipping UI: change the app, re-run this, they update.
 *
 * Output (screenshots/):
 *   01-home.png 02-calibrate.png 03-morse-keypad.png 04-morse-transmit.png
 *   05-home-amber.png   preview-contact-sheet.png
 */
"use strict";
var fs = require("fs");
var path = require("path");
var zlib = require("zlib");

var SRC = path.join(__dirname, "..", "src", "COMPASS.JS");
var OUT_DIR = path.join(__dirname, "..", "screenshots");
var SRC_CODE = fs.readFileSync(SRC, "utf8");

var DEV_W = 480, DEV_H = 320;   // device logical resolution (landscape)
var SCALE = 2;                  // output = 2x device  => 960 x 640
var IW = DEV_W * SCALE, IH = DEV_H * SCALE;
var CORNER = 46;                // rounded-glass corner radius (device px)

/* Phosphor palette, indexed to match the app's setColor(0..3). */
var PALETTE = {
  green: { 0: [0, 10, 5], 1: [0, 95, 0], 2: [109, 218, 118], 3: [26, 255, 128] },
  amber: { 0: [12, 7, 0], 1: [110, 60, 0], 2: [206, 150, 70], 3: [255, 182, 66] }
};

/* ----------------------------------------------------------------- *
 *  Monospaced uppercase bitmap font (5x7 cells). Rendered chunky to
 *  read like the device's Monofonto. Lowercase maps to caps; unknown
 *  glyphs render blank.
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
  "-": ["     ", "     ", "     ", "XXXXX", "     ", "     ", "     "],
  "+": ["     ", "  X  ", "  X  ", "XXXXX", "  X  ", "  X  ", "     "],
  "/": ["    X", "    X", "   X ", "  X  ", " X   ", "X    ", "X    "],
  "?": [" XXX ", "X   X", "    X", "   X ", "  X  ", "     ", "  X  "],
  "_": ["     ", "     ", "     ", "     ", "     ", "     ", "XXXXX"],
  "(": ["  XX ", " X   ", " X   ", " X   ", " X   ", " X   ", "  XX "],
  ")": [" XX  ", "   X ", "   X ", "   X ", "   X ", "   X ", " XX  "],
  "[": [" XXX ", " X   ", " X   ", " X   ", " X   ", " X   ", " XXX "],
  "]": [" XXX ", "   X ", "   X ", "   X ", "   X ", "   X ", " XXX "],
  "<": ["   X ", "  X  ", " X   ", "X    ", " X   ", "  X  ", "   X "],
  ">": [" X   ", "  X  ", "   X ", "    X", "   X ", "  X  ", " X   "],
  "=": ["     ", "     ", "XXXXX", "     ", "XXXXX", "     ", "     "],
  "*": ["     ", "X X X", " XXX ", "XXXXX", " XXX ", "X X X", "     "],
  "\xB0": [" XX  ", "X  X ", " XX  ", "     ", "     ", "     ", "     "]
};

/* Font metrics, matched to the DEVICE so stringWidth-driven layout (button
 * widths, centering, right-alignment) lands where the app intends:
 *   Monofonto23 (big): ~14 px advance, ~23 px tall
 *   6x8 (small):       ~8 px advance, ~8 px tall
 * `px` is the cell scale; `adv` is the per-character advance the renderer AND
 * the recorder's stringWidth both use, so they agree with the device. */
function metrics(isBig) {
  // sx/sy = per-cell pixel scale (x,y); big text is tall (Monofonto-like) with a
  // narrower advance so headings read correctly and don't collide.
  return isBig ? { sx: 2, sy: 3, adv: 14, gh: 21 } : { sx: 1, sy: 1, adv: 8, gh: 7 };
}

/* ----------------------------------------------------------------- *
 *  Recording graphics mock: the REAL app draws through this; we keep
 *  an ordered op list with the integer palette index per op.
 * ----------------------------------------------------------------- */
function makeRecorder() {
  var ops = [];
  var color = 3, font = "Monofonto23", ax = -1, ay = -1;
  function rec(o) { o.color = color; ops.push(o); }
  /* The app installs a setColor compat shim that maps its indexed colors 0..3
   * to tinted RGB. To recover the level here, our setColor accepts either:
   *   - a plain integer 0..3 (when the shim is absent), or
   *   - the value our toColor() returned (the shim's preferred path): we encode
   *     the level into that value as 0x10|level so it round-trips unambiguously.
   *   - 3 float args (shim fallback): we map by the green component (levels
   *     scale green by 0 / 0.34 / 0.67 / 1, giving distinct values). */
  function levelFromGreen(g) {
    if (g > 0.84) return 3; if (g > 0.50) return 2; if (g > 0.17) return 1; return 0;
  }
  var G = {
    getWidth: function () { return DEV_W; },
    getHeight: function () { return DEV_H; },
    reset: function () { color = 3; font = "Monofonto23"; ax = -1; ay = -1; return G; },
    clear: function () { ops.length = 0; return G; },
    setColor: function (a) {
      if (arguments.length >= 3) { color = levelFromGreen(+arguments[1] || 0); return G; }
      if (typeof a === "number") { color = (a >= 0x10) ? (a & 0x0f) : (a | 0); }
      return G;
    },
    setFont: function (n) { font = "" + n; return G; },
    setFontVector: function () { return G; },
    setFontAlign: function (x, y) { ax = x; if (y !== undefined) ay = y; return G; },
    // Encode the level (derived from the green channel) so setColor can decode it.
    toColor: function (r, g, b) { return 0x10 | levelFromGreen(+g || 0); },
    drawString: function (s, x, y) { rec({ t: "text", s: "" + s, x: x, y: y, ax: ax, ay: ay, big: /Monofonto|2[0-9]/.test(font) }); return G; },
    drawLine: function (x1, y1, x2, y2) { rec({ t: "line", x1: x1, y1: y1, x2: x2, y2: y2 }); return G; },
    drawRect: function (x1, y1, x2, y2) { rec({ t: "rect", x1: x1, y1: y1, x2: x2, y2: y2 }); return G; },
    fillRect: function (x1, y1, x2, y2) { rec({ t: "fill", x1: x1, y1: y1, x2: x2, y2: y2 }); return G; },
    drawCircle: function (x, y, r) { rec({ t: "circ", x: x, y: y, r: r }); return G; },
    stringWidth: function (s) { return ("" + s).length * metrics(/Monofonto|2[0-9]/.test(font)).adv; },
    flip: function () { return G; }
  };
  return { G: G, ops: ops };
}

/* ----------------------------------------------------------------- *
 *  Rasterizer: replays recorded ops onto a float coverage buffer
 *  (one channel = phosphor intensity per palette level is folded in
 *  at colorize time; here we store level+coverage).
 * ----------------------------------------------------------------- */
function makeCanvas() {
  // True last-writer-wins framebuffer (like the device): each op paints in
  // order. Full-coverage pixels overwrite (so a BG=level-0 label punches dark
  // through a bright fill); anti-aliased edges blend toward the new level.
  var lvl = new Uint8Array(IW * IH);
  var cov = new Float32Array(IW * IH);
  function put(ix, iy, level, a) {
    if (a <= 0 || ix < 0 || iy < 0 || ix >= IW || iy >= IH) return;
    if (a > 1) a = 1;
    var o = iy * IW + ix;
    if (a >= 0.999) { lvl[o] = level; cov[o] = 1; return; }   // opaque: overwrite
    // partial coverage (AA edge): blend the edge's level in over what's there
    if (level >= lvl[o]) { lvl[o] = level; cov[o] = Math.max(cov[o], a); }
    else if (a > 0.5) { lvl[o] = level; cov[o] = a; }
  }
  function fillBox(level, dx1, dy1, dx2, dy2) {
    var x1 = Math.round(Math.min(dx1, dx2) * SCALE), y1 = Math.round(Math.min(dy1, dy2) * SCALE);
    var x2 = Math.round(Math.max(dx1, dx2) * SCALE), y2 = Math.round(Math.max(dy1, dy2) * SCALE);
    if (x1 < 0) x1 = 0; if (y1 < 0) y1 = 0; if (x2 > IW) x2 = IW; if (y2 > IH) y2 = IH;
    for (var y = y1; y < y2; y++) for (var x = x1; x < x2; x++) put(x, y, level, 1);
  }
  function lineSeg(level, dx1, dy1, dx2, dy2) {
    var ax = dx1 * SCALE, ay = dy1 * SCALE, bx = dx2 * SCALE, by = dy2 * SCALE;
    var half = SCALE / 2;
    var minx = Math.floor(Math.min(ax, bx) - half - 1), maxx = Math.ceil(Math.max(ax, bx) + half + 1);
    var miny = Math.floor(Math.min(ay, by) - half - 1), maxy = Math.ceil(Math.max(ay, by) + half + 1);
    var vx = bx - ax, vy = by - ay, len2 = vx * vx + vy * vy;
    for (var y = miny; y <= maxy; y++) for (var x = minx; x <= maxx; x++) {
      var t = len2 ? ((x - ax) * vx + (y - ay) * vy) / len2 : 0;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      var px = ax + vx * t, py = ay + vy * t;
      var d = Math.sqrt((x - px) * (x - px) + (y - py) * (y - py));
      put(x, y, level, half + 0.5 - d);
    }
  }
  function ring(level, dcx, dcy, dr) {
    var cx = dcx * SCALE, cy = dcy * SCALE, r = dr * SCALE, half = SCALE / 2;
    var minx = Math.floor(cx - r - half - 1), maxx = Math.ceil(cx + r + half + 1);
    var miny = Math.floor(cy - r - half - 1), maxy = Math.ceil(cy + r + half + 1);
    for (var y = miny; y <= maxy; y++) for (var x = minx; x <= maxx; x++) {
      var d = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
      put(x, y, level, half + 0.5 - Math.abs(d - r));
    }
  }
  function glyph(level, ch, dx, dy, m) {
    var g = FONT[ch] || FONT[ch.toUpperCase()] || null; if (!g) return;
    var sx = m.sx, sy = m.sy, r, c, row;
    for (r = 0; r < 7; r++) { row = g[r]; for (c = 0; c < 5; c++) if (row[c] === "X") fillBox(level, dx + c * sx, dy + r * sy, dx + c * sx + sx, dy + r * sy + sy); }
  }
  function text(level, s, x, y, ax, ay, isBig) {
    var m = metrics(isBig), w = s.length * m.adv, hh = m.gh;
    var x0 = ax === 0 ? x - w / 2 : (ax > 0 ? x - w : x);
    var y0 = ay === 0 ? y - hh / 2 : (ay > 0 ? y - hh : y);
    for (var i = 0; i < s.length; i++) glyph(level, s[i], x0 + i * m.adv, y0, m);
  }
  function replay(ops) {
    for (var i = 0; i < ops.length; i++) {
      var o = ops[i], L = o.color | 0;
      if (o.t === "fill") fillBox(L, o.x1, o.y1, o.x2 + 1, o.y2 + 1);
      else if (o.t === "rect") { lineSeg(L, o.x1, o.y1, o.x2, o.y1); lineSeg(L, o.x2, o.y1, o.x2, o.y2); lineSeg(L, o.x2, o.y2, o.x1, o.y2); lineSeg(L, o.x1, o.y2, o.x1, o.y1); }
      else if (o.t === "line") lineSeg(L, o.x1, o.y1, o.x2, o.y2);
      else if (o.t === "circ") ring(L, o.x, o.y, o.r);
      else if (o.t === "text") text(L, o.s, o.x, o.y, o.ax, o.ay, o.big);
    }
  }
  return { lvl: lvl, cov: cov, replay: replay };
}

/* ----------------------------------------------------------------- *
 *  Colorize: level+coverage -> RGBA, with the round bezel mask, a
 *  bloom pass, scanlines and a vignette.
 * ----------------------------------------------------------------- */
function boxBlur(src, w, h, radius) {
  var tmp = new Float32Array(w * h), out = new Float32Array(w * h), x, y, i, sum;
  var n = radius * 2 + 1;
  for (y = 0; y < h; y++) { sum = 0; for (i = -radius; i <= radius; i++) sum += src[y * w + Math.min(w - 1, Math.max(0, i))]; for (x = 0; x < w; x++) { tmp[y * w + x] = sum / n; sum += src[y * w + Math.min(w - 1, x + radius + 1)] - src[y * w + Math.max(0, x - radius)]; } }
  for (x = 0; x < w; x++) { sum = 0; for (i = -radius; i <= radius; i++) sum += tmp[Math.min(h - 1, Math.max(0, i)) * w + x]; for (y = 0; y < h; y++) { out[y * w + x] = sum / n; sum += tmp[Math.min(h - 1, y + radius + 1) * w + x] - tmp[Math.max(0, y - radius) * w + x]; } }
  return out;
}
/* 1 inside the rounded-rectangle glass, 0 outside (the masked corners). */
function insideBezel(x, y) {
  var r = CORNER * SCALE, w = IW, h = IH;
  var cx = x < r ? r : (x > w - r ? w - r : x);
  var cy = y < r ? r : (y > h - r ? h - r : y);
  var dx = x - cx, dy = y - cy;
  return (dx * dx + dy * dy) <= r * r ? 1 : 0;
}
function colorize(canvas, themeName) {
  var pal = PALETTE[themeName] || PALETTE.green;
  var lum = new Float32Array(IW * IH), i;
  // luminance proxy for bloom: brightest level scaled by coverage
  for (i = 0; i < IW * IH; i++) { var L = canvas.lvl[i]; lum[i] = L ? (pal[L][1] / 255) * Math.min(1, canvas.cov[i]) : 0; }
  var glow = boxBlur(boxBlur(lum, IW, IH, 2), IW, IH, 4);
  var rgba = Buffer.alloc(IW * IH * 4);
  var cx = IW / 2, cy = IH / 2, maxd = Math.sqrt(cx * cx + cy * cy);
  for (var y = 0; y < IH; y++) {
    var scan = (y % 2 === 0) ? 1.0 : 0.86;
    for (var x = 0; x < IW; x++) {
      i = y * IW + x;
      var inside = insideBezel(x, y);
      var L = canvas.lvl[i], a = Math.min(1, canvas.cov[i]);
      var base = (L ? pal[L] : pal[0]);
      var bg = pal[0];
      // composite glyph/line color over background by coverage
      var r = bg[0] + (base[0] - bg[0]) * a;
      var g = bg[1] + (base[1] - bg[1]) * a;
      var b = bg[2] + (base[2] - bg[2]) * a;
      var gl = glow[i] * 90;        // additive bloom
      r += pal[3][0] / 255 * gl; g += pal[3][1] / 255 * gl; b += pal[3][2] / 255 * gl;
      var dx = x - cx, dy = y - cy, vig = 1 - 0.42 * Math.pow(Math.sqrt(dx * dx + dy * dy) / maxd, 2.2);
      var f = scan * vig * inside;  // outside the bezel -> pure black
      var p = i * 4;
      rgba[p] = Math.max(0, Math.min(255, Math.round(r * f)));
      rgba[p + 1] = Math.max(0, Math.min(255, Math.round(g * f)));
      rgba[p + 2] = Math.max(0, Math.min(255, Math.round(b * f)));
      rgba[p + 3] = 255;
    }
  }
  return rgba;
}

/* ----------------------------------------------------------------- *  PNG encode  */
var CRC_T = (function () { var t = new Uint32Array(256); for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
function crc32(buf) { var c = 0xFFFFFFFF; for (var i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function pngChunk(type, data) { var len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0); var t = Buffer.from(type, "ascii"); var crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0); return Buffer.concat([len, t, data, crc]); }
function encodePNG(w, h, rgba) {
  var stride = w * 4, raw = Buffer.alloc((stride + 1) * h);
  for (var y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride); }
  var idat = zlib.deflateSync(raw, { level: 9 });
  var sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  var ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}

/* ----------------------------------------------------------------- *
 *  Drive the REAL app into a screen state, capturing its draw ops.
 * ----------------------------------------------------------------- */
function runScenario(cfgSeed, drive) {
  var rec = makeRecorder();
  var handlers = {}, intervals = {}, timeouts = {}, tid = 1, ledState = 0;
  var env = {
    h: rec.G, g: rec.G,
    digitalWrite: function (p, v) { ledState = v ? 1 : 0; },
    LED_GREEN: { pin: "E5" },
    E: { openFile: function () { return null; } },
    Pip: {
      on: function (e, f) { handlers[e] = f; },
      removeListener: function (e, f) { if (handlers[e] === f) delete handlers[e]; },
      removeAllListeners: function (e) { delete handlers[e]; },
      audioBuiltin: function () {},
      accelOn: function () {}, accelOff: function () {}
    },
    require: function (m) {
      if (m === "fs") return { readFileSync: function () { if (cfgSeed) return JSON.stringify(cfgSeed); throw new Error("ENOENT"); }, writeFileSync: function () {} };
      throw new Error("no " + m);
    },
    setInterval: function (f) { var id = tid++; intervals[id] = f; return id; },
    clearInterval: function (id) { delete intervals[id]; },
    setTimeout: function (f) { var id = tid++; timeouts[id] = f; return id; },
    clearTimeout: function (id) { delete timeouts[id]; }
  };
  var factory = new Function(
    "h", "g", "digitalWrite", "LED_GREEN", "E", "Pip", "require",
    "setInterval", "clearInterval", "setTimeout", "clearTimeout", "src",
    "return eval(src);"
  )(env.h, env.g, env.digitalWrite, env.LED_GREEN, env.E, env.Pip, env.require,
    env.setInterval, env.clearInterval, env.setTimeout, env.clearTimeout, SRC_CODE);
  var app = factory();
  var ctx = {
    knob1: function (d) { handlers.knob1(d); },
    knob2: function (d) { handlers.knob2(d); },
    torch: function () { handlers.torch(); },
    tick: function () { var k = Object.keys(intervals); if (k.length) intervals[k[0]](); },
    stepTimeout: function () { var k = Object.keys(timeouts); if (!k.length) return false; var f = timeouts[k[0]]; delete timeouts[k[0]]; f(); return true; },
    ops: rec.ops
  };
  drive(ctx);
  try { app.remove(); } catch (e) {}
  // snapshot whatever ops are currently buffered (last full frame)
  return rec.ops.slice();
}

/* --- scenario drivers --------------------------------------------- */
function driveHome(ctx) { ctx.tick(); }                                 // HOME auto-animates
function driveCalibrate(ctx) { ctx.knob1(1); ctx.tick(); ctx.knob1(0); ctx.tick(); ctx.tick(); }
function navMorse(ctx) { ctx.knob1(1); ctx.tick(); ctx.knob1(1); ctx.tick(); ctx.knob1(0); ctx.tick(); }
function pressKey(ctx, row, col) {
  for (var r = 0; r < 6; r++) { ctx.knob1(-1); ctx.tick(); }            // home to row 0
  for (var rr = 0; rr < row; rr++) { ctx.knob1(1); ctx.tick(); }
  for (var c = 0; c < 12; c++) { ctx.knob2(-1); ctx.tick(); }           // home to col 0
  for (var cc = 0; cc < col; cc++) { ctx.knob2(1); ctx.tick(); }
  ctx.knob1(0); ctx.tick();
}
function driveMorseKeypad(ctx) { navMorse(ctx); pressKey(ctx, 1, 8); pressKey(ctx, 1, 4); pressKey(ctx, 1, 8); } // SOS
function driveMorseTransmit(ctx) {
  navMorse(ctx);
  pressKey(ctx, 1, 8); pressKey(ctx, 1, 4); pressKey(ctx, 1, 8);        // SOS
  pressKey(ctx, 4, 7);                                                  // TX -> starts transmit
  // step the pulse chain until a non-flash "TRANSMITTING" plate is buffered
  for (var i = 0; i < 20; i++) {
    var hasPlate = ctx.ops.some(function (o) { return o.t === "text" && o.s.indexOf("TRANSMITTING") >= 0; });
    var hasMeta = ctx.ops.some(function (o) { return o.t === "text" && o.s.indexOf("WPM") >= 0; });
    if (hasPlate && hasMeta) return;
    if (!ctx.stepTimeout()) break;
  }
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

function renderShot(shot) {
  var ops = runScenario(shot.seed, shot.drive);
  var canvas = makeCanvas();
  canvas.replay(ops);
  return colorize(canvas, shot.theme);
}

/* --- contact sheet (2x2 of the core screens, downscaled) ---------- */
function downscale2(rgba, w, h) {
  var ow = w >> 1, oh = h >> 1, out = Buffer.alloc(ow * oh * 4);
  for (var y = 0; y < oh; y++) for (var x = 0; x < ow; x++) {
    var sx = x * 2, sy = y * 2, o = (y * ow + x) * 4;
    for (var ch = 0; ch < 4; ch++) out[o + ch] = Math.round((rgba[(sy * w + sx) * 4 + ch] + rgba[(sy * w + sx + 1) * 4 + ch] + rgba[((sy + 1) * w + sx) * 4 + ch] + rgba[((sy + 1) * w + sx + 1) * 4 + ch]) / 4);
  }
  return { rgba: out, w: ow, h: oh };
}
function sheetText(buf, w, s, dx, dy) {
  for (var i = 0; i < s.length; i++) { var g = FONT[s[i]] || FONT[(s[i] || "").toUpperCase()]; if (!g) continue; for (var r = 0; r < 7; r++) for (var c = 0; c < 5; c++) if (g[r][c] === "X") for (var py = 0; py < 2; py++) for (var px = 0; px < 2; px++) { var X = dx + i * 12 + c * 2 + px, Y = dy + r * 2 + py, o = (Y * w + X) * 4; buf[o] = 26; buf[o + 1] = 255; buf[o + 2] = 128; buf[o + 3] = 255; } }
}
function buildContactSheet(cells) {
  var cw = cells[0].w, ch = cells[0].h, pad = 22, lab = 26, cols = 2, rows = 2;
  var W = pad + cols * cw + (cols - 1) * pad + pad, H = pad + rows * (lab + ch) + (rows - 1) * pad + pad;
  var buf = Buffer.alloc(W * H * 4);
  for (var i = 0; i < W * H; i++) { buf[i * 4] = 0; buf[i * 4 + 1] = 10; buf[i * 4 + 2] = 5; buf[i * 4 + 3] = 255; }
  for (var idx = 0; idx < cells.length && idx < 4; idx++) {
    var cxi = idx % cols, cyi = (idx / cols) | 0, ox = pad + cxi * (cw + pad), oy = pad + cyi * (lab + ch + pad);
    sheetText(buf, W, cells[idx].label, ox + 2, oy + 6);
    var img = cells[idx].rgba;
    for (var y = 0; y < ch; y++) for (var x = 0; x < cw; x++) { var so = (y * cw + x) * 4, dO = ((oy + lab + y) * W + (ox + x)) * 4; buf[dO] = img[so]; buf[dO + 1] = img[so + 1]; buf[dO + 2] = img[so + 2]; buf[dO + 3] = 255; }
  }
  return { rgba: buf, w: W, h: H };
}

/* ----------------------------------------------------------------- */
function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  var cells = [];
  SHOTS.forEach(function (shot) {
    var rgba = renderShot(shot);
    fs.writeFileSync(path.join(OUT_DIR, shot.file), encodePNG(IW, IH, rgba));
    console.log("Wrote screenshots/" + shot.file + "  (" + IW + "x" + IH + ")");
    if (shot.file.indexOf("amber") < 0) { var ds = downscale2(rgba, IW, IH); cells.push({ rgba: ds.rgba, w: ds.w, h: ds.h, label: shot.label }); }
  });
  var sheet = buildContactSheet(cells);
  fs.writeFileSync(path.join(OUT_DIR, "preview-contact-sheet.png"), encodePNG(sheet.w, sheet.h, sheet.rgba));
  console.log("Wrote screenshots/preview-contact-sheet.png  (" + sheet.w + "x" + sheet.h + ")");
}
main();
