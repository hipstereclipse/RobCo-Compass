/* make-icon.js  -  generate APPINFO/HOLO.IMG, a 64x64 1-bpp Espruino image
 * (holotape compass glyph) in the format the Pip-Boy launcher draws:
 *   byte0 = width, byte1 = height, byte2 = bpp(1), then bits MSB-first,
 *   packed continuously (no per-row byte padding), foreground = 1.
 *
 * Run:  node tools/make-icon.js
 * The stock holotape icon may be substituted instead - see README.
 */
"use strict";
var fs = require("fs");
var path = require("path");

var W = 64, H = 64, CX = 31.5, CY = 31.5;
var px = new Uint8Array(W * H); // 1 = lit

function set(x, y) { x = x | 0; y = y | 0; if (x >= 0 && x < W && y >= 0 && y < H) px[y * W + x] = 1; }
function ring(r, t) {
  for (var a = 0; a < 360; a += 1) {
    var rad = a * Math.PI / 180;
    for (var d = 0; d < t; d++) set(CX + Math.cos(rad) * (r - d), CY + Math.sin(rad) * (r - d));
  }
}
function disc(cx, cy, r) {
  for (var y = -r; y <= r; y++) for (var x = -r; x <= r; x++) if (x * x + y * y <= r * r) set(cx + x, cy + y);
}
function tick(angleDeg, rOuter, rInner) {
  var rad = (angleDeg - 90) * Math.PI / 180;
  for (var rr = rInner; rr <= rOuter; rr += 0.5) set(CX + Math.cos(rad) * rr, CY + Math.sin(rad) * rr);
}

// outer bezel + inner ring
ring(30, 2);
ring(22, 1);
// cardinal ticks (N E S W) major, intercardinals minor
tick(0, 30, 23); tick(90, 30, 24); tick(180, 30, 24); tick(270, 30, 24);
tick(45, 30, 27); tick(135, 30, 27); tick(225, 30, 27); tick(315, 30, 27);
// north needle: filled triangle pointing up to the top index
for (var y = 8; y <= 31; y++) {
  var halfW = (y - 8) * 0.30; // widen toward the hub
  for (var x = -halfW; x <= halfW; x++) set(CX + x, y);
}
// south tail (thin)
for (var yy = 32; yy <= 50; yy++) { set(CX, yy); set(CX - 1, yy); }
// center hub
disc(CX, CY, 3);

// pack to Espruino 1-bpp string: header + continuous MSB-first bits
var bytes = [W, H, 1];
var acc = 0, nbits = 0;
for (var i = 0; i < W * H; i++) {
  acc = (acc << 1) | (px[i] ? 1 : 0); nbits++;
  if (nbits === 8) { bytes.push(acc & 0xFF); acc = 0; nbits = 0; }
}
if (nbits) bytes.push((acc << (8 - nbits)) & 0xFF);

var outDir = path.join(__dirname, "..", "APPINFO");
fs.writeFileSync(path.join(outDir, "HOLO.IMG"), Buffer.from(bytes), "binary");
console.log("Wrote APPINFO/HOLO.IMG  (" + bytes.length + " bytes, " + W + "x" + H + " 1bpp)");
