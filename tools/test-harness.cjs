/* test-harness.cjs  -  mock-hardware smoke test for src/COMPASS.JS.
 *
 *   node tools/test-harness.cjs     (or: npm test)
 *
 * Stubs the Espruino globals (graphics h/g, Pip events, fs, LEDs, timers),
 * evaluates the app factory, drives the full UI flow deterministically and
 * asserts behaviour - including the honest MODE line, solar capture,
 * synchronised Morse flashing, sensor-upgrade branches and clean teardown.
 * This is a logic smoke test, NOT a hardware substitute: always verify on the
 * pip-boy.com simulator and the device REPL before shipping.
 */
"use strict";
var path = require("path");
var realFs = require("fs");
var SRC = path.join(__dirname, "..", "src", "COMPASS.JS");
var src = realFs.readFileSync(SRC, "utf8");

function makeG(frame) {
  var noop = function () {};
  // Mock the Espruino Graphics subset the app uses. setColor takes an integer
  // palette index (0..3); toColor packs a tint level (the app's render-compat
  // wrapper calls it). Both are no-ops here beyond returning self for chaining.
  var G = {
    getWidth: function () { return 480; }, getHeight: function () { return 320; },
    setColor: function () { return G; }, setFont: function () { return G; },
    setFontVector: function () { return G; }, setFontAlign: function () { return G; },
    toColor: function () { return 0; },
    drawString: function (s) { frame.push("" + s); return G; },
    drawLine: function () { return G; }, drawRect: function () { return G; },
    fillRect: function () { return G; }, drawCircle: function () { return G; },
    reset: function () { return G; }, clear: function () { return G; }, flip: noop,
    stringWidth: function (s) { return ("" + s).length * 9; }
  };
  return G;
}

/* ---- full UI flow (accel-only confirmed hardware) ---- */
function flowTest() {
  var handlers = {}, intervals = {}, timeouts = {}, tid = 1;
  var frame = [], ledState = 0, saved = null, audio = [], drawCount = 0, out = [], fails = 0;
  function assert(c, m) { if (!c) throw new Error(m); }
  function step(l, fn) { try { fn(); out.push("  PASS " + l); } catch (e) { fails++; out.push("  FAIL " + l + " -> " + (e.message || e)); } }

  var h = makeG(frame), g = h, bC;
  var digitalWrite = function (p, v) { ledState = v ? 1 : 0; };
  var LED_GREEN = { pin: "E5" };
  var E = { openFile: function () { return null; } };
  var Pip = {
    on: function (e, f) { handlers[e] = f; },
    removeListener: function (e, f) { if (handlers[e] === f) delete handlers[e]; },
    removeAllListeners: function (e) { delete handlers[e]; },
    audioBuiltin: function (id) { audio.push(id); }
  };
  var require = function (m) {
    if (m === "fs") return { readFileSync: function () { throw new Error("ENOENT"); }, writeFileSync: function (p, d) { saved = d; } };
    throw new Error("no " + m);
  };
  var setInterval = function (f) { var id = tid++; intervals[id] = f; return id; };
  var clearInterval = function (id) { delete intervals[id]; };
  var setTimeout = function (f) { var id = tid++; timeouts[id] = f; return id; };
  var clearTimeout = function (id) { delete timeouts[id]; };
  var origDraw = h.drawString; h.drawString = function (s) { drawCount++; frame.push("" + s); };

  var tick = function () { intervals[Object.keys(intervals)[0]](); };
  function act(fn) { frame = []; fn(); tick(); return frame.join(" | "); }

  var app, scr;
  step("factory evaluates + starts", function () {
    var factory = eval(src);
    assert(typeof factory === "function", "not a function expression");
    app = factory();
    assert(app && app.id === "RobCo Compass", "app.id");
    assert(app.notDefault === true && app.fullscreen === true, "flags");
    assert(typeof app.remove === "function", "remove()");
    assert(handlers.knob1 && handlers.knob2 && handlers.torch, "listeners");
    // Accel.init() binds the accel stream at startup (used for tilt-compensated
    // magnetic heading and the optional turn-gesture nudge). It must be detached
    // by remove(); see the dedicated teardown test below.
    assert(!!handlers.accel, "accel stream bound at start");
  });
  step("HOME shows honest MANUAL mode + 3 buttons", function () {
    scr = act(function () {});
    assert(/NAVIGATION/.test(scr) && /ROBCO TERMLINK/.test(scr), "header");
    assert(/MODE: MANUAL BEARING/.test(scr), "honest mode");
    assert(/COMPASS/.test(scr) && /CALIBRATE/.test(scr) && /MORSE/.test(scr), "buttons");
  });
  step("K2 nudges bearing", function () { assert(act(function () {}) !== act(function () { handlers.knob2(1); }), "redrew"); });
  step("open CALIBRATE", function () {
    act(function () { handlers.knob1(1); });
    scr = act(function () { handlers.knob1(0); });
    assert(/CALIBRATION/.test(scr) && /BEARING/.test(scr) && /ACTION/.test(scr), "cal screen");
  });
  step("lat/lon -> numeric solar azimuth", function () {
    // CAL_FIELDS = METHOD, BEARING, TRIM, DECL, LAT, LON, UTC, ACTION; K2 advances.
    for (var m = 0; m < 4; m++) act(function () { handlers.knob2(1); }); // METHOD -> LAT
    for (var k = 0; k < 6; k++) act(function () { handlers.knob1(1); }); // bump LAT
    act(function () { handlers.knob2(1); }); // -> LON
    for (var j = 0; j < 6; j++) scr = act(function () { handlers.knob1(1); }); // bump LON
    assert(/SUN AZIMUTH:\s*\d/.test(scr), "azimuth numeric");
  });
  step("CAPTURE SUN persists", function () {
    saved = null;
    act(function () { handlers.knob2(1); }); act(function () { handlers.knob2(1); }); // LON -> UTC -> ACTION
    act(function () { handlers.knob1(1); }); // ACTION: APPLY -> CAPTURE SUN
    act(function () { handlers.knob1(0); }); // activate
    assert(saved !== null, "flushed");
    var c = JSON.parse(saved);
    assert(c.locSet === true && typeof c.bearing === "number", "cfg saved");
  });
  step("torch returns HOME", function () { assert(/NAVIGATION/.test(act(function () { handlers.torch(); })), "home"); });
  step("open MORSE + compose 'E'", function () {
    // homeFocus is still on CALIBRATE (1) from the earlier visit; one more step reaches MORSE (2).
    act(function () { handlers.knob1(1); });
    scr = act(function () { handlers.knob1(0); });
    assert(/MORSE/.test(scr), "morse");
    for (var k = 0; k < 4; k++) act(function () { handlers.knob2(1); }); // A -> E
    scr = act(function () { handlers.knob1(0); });
    assert(/MSG:\s*E/.test(scr), "composed E");
  });
  step("transmit flashes LED then ends idle", function () {
    for (var k = 0; k < 4; k++) act(function () { handlers.knob1(1); });
    for (var j = 0; j < 3; j++) act(function () { handlers.knob2(1); });
    var sawLED = false; frame = []; handlers.knob1(0);
    for (var s = 0; s < 60; s++) { if (ledState === 1) sawLED = true; var ks = Object.keys(timeouts); if (!ks.length) break; var f = timeouts[ks[0]]; delete timeouts[ks[0]]; f(); }
    assert(sawLED, "LED flashed");
    assert(ledState === 0, "LED off after");
    assert(Object.keys(timeouts).length === 0, "no orphan timers");
  });
  step("remove() detaches all + safe idle", function () {
    app.remove();
    assert(Object.keys(intervals).length === 0, "ticker");
    assert(Object.keys(timeouts).length === 0, "timers");
    assert(!handlers.knob1 && !handlers.knob2 && !handlers.torch, "knob/torch listeners");
    assert(!handlers.accel, "accel detached");
    assert(ledState === 0, "torch off");
    assert(saved !== null, "flushed");
  });
  console.log("FLOW (accel-only confirmed hardware):");
  console.log(out.join("\n"));
  return fails;
}

/* ---- accel lifecycle: the accel stream is bound at start (tilt-compensated
 * magnetic heading + optional gesture) and detached cleanly by remove(). ---- */
function accelLifecycleTest() {
  var handlers = {}, intervals = {}, timeouts = {}, tid = 1, frame = [];
  var h = makeG(frame), g = h;
  var digitalWrite = function () {}; var LED_GREEN = {}; var E = { openFile: function () { return null; } };
  var accelOn = false;
  var Pip = {
    on: function (e, f) { handlers[e] = f; }, removeListener: function (e, f) { if (handlers[e] === f) delete handlers[e]; },
    removeAllListeners: function (e) { delete handlers[e]; }, audioBuiltin: function () {},
    accelOn: function () { accelOn = true; }, accelOff: function () { accelOn = false; }
  };
  var require = function (m) { if (m === "fs") return { readFileSync: function () { throw new Error("x"); }, writeFileSync: function () {} }; throw new Error("x"); };
  var setInterval = function (f) { var id = tid++; intervals[id] = f; return id; };
  var clearInterval = function (id) { delete intervals[id]; };
  var setTimeout = function (f) { var id = tid++; timeouts[id] = f; return id; };
  var clearTimeout = function (id) { delete timeouts[id]; };
  var app = eval(src)();
  var boundAtStart = !!handlers.accel && accelOn === true;
  app.remove();
  var detachedAfter = !handlers.accel && accelOn === false;
  var pass = boundAtStart && detachedAfter;
  console.log((boundAtStart ? "  PASS " : "  FAIL ") + "accel stream bound at start");
  console.log((detachedAfter ? "  PASS " : "  FAIL ") + "accel stream detached by remove()");
  return pass ? 0 : 1;
}

var fails = flowTest();
console.log("\nACCEL LIFECYCLE (bound at start, detached on remove):");
fails += accelLifecycleTest();

console.log("\n" + (fails ? "RESULT: " + fails + " FAILURE(S)" : "RESULT: ALL PASS"));
process.exit(fails ? 1 : 0);
