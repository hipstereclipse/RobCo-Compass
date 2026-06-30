/* build.js  -  produce the device build APPS/COMPASS.JS from src/COMPASS.JS.
 *
 * Mirrors the reference repos: readable source lives in src/, the file shipped
 * to the SD card under APPS/ is the terser-minified build. The minified file is
 * GENERATED - never hand-edit it.
 *
 *   npm install            # installs terser (see package.json)
 *   node tools/build.js
 *
 * If terser is not installed, a conservative comment/whitespace strip is used as
 * a fallback so a build still succeeds, and a warning is printed. Use terser for
 * the real, RAM-friendly build (~the difference between LOW_MEMORY and not).
 */
"use strict";
var fs = require("fs");
var path = require("path");

var SRC = path.join(__dirname, "..", "src", "COMPASS.JS");
var OUT = path.join(__dirname, "..", "APPS", "COMPASS.JS");
var source = fs.readFileSync(SRC, "utf8");

function writeOut(code) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, code, "utf8");
  console.log("Wrote APPS/COMPASS.JS  " + source.length + " -> " + code.length +
    " bytes  (" + Math.round(100 - code.length * 100 / source.length) + "% smaller)");
}

var terser;
try { terser = require("terser"); } catch (e) { terser = null; }

if (terser) {
  terser.minify(source, {
    ecma: 5,                 // Espruino is ES5
    // The app file is a single top-level function EXPRESSION that the loader
    // eval()s and then calls. side_effects:false stops the compressor deleting
    // it as a "useless" expression statement (which silently empties the build).
    compress: { passes: 2, drop_console: true, side_effects: false },
    mangle: { toplevel: false },
    format: { ascii_only: true, comments: false }
  }).then(function (r) {
    if (r.error) throw r.error;
    writeOut(r.code);
  }).catch(function (err) { console.error("terser failed:", err); process.exit(1); });
} else {
  console.warn("! terser not installed - using conservative fallback (run `npm install` for the real build).");
  // Safe fallback: drop block comments and comment-only / blank lines, keep
  // newlines (so Automatic Semicolon Insertion is preserved) and inline code.
  var out = source
    .replace(/\/\*[\s\S]*?\*\//g, "")          // block comments
    .split("\n")
    .map(function (l) { return l.replace(/\s+$/, ""); })
    .filter(function (l) { return l.trim() !== "" && l.trim().indexOf("//") !== 0; })
    .join("\n");
  writeOut(out);
}
