// Pin checker: reads a sketch and flags pin numbers that are wrong for the
// selected board — nonexistent pins, analogWrite on pins without PWM,
// analogRead on pins without an ADC, ESP32 input-only and flash pins, the
// USB serial pins 0/1. Pin tables are only defined for boards whose pinout is
// fixed and documented; any other board gets no checks rather than guesses.
(function (root) {
  'use strict';

  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const analogNames = (first, count) => Object.fromEntries(range(0, count - 1).map((i) => ['A' + i, first + i]));

  // Pin numbers are the core's own (pins_arduino.h for each variant).
  const BOARDS = {
    // ATmega328P: D0–D13, A0–A5 = 14–19. analogRead() also takes 0–5 as channels.
    uno: {
      name: 'Arduino Uno', digital: range(0, 19), pwm: [3, 5, 6, 9, 10, 11],
      names: { ...analogNames(14, 6), LED_BUILTIN: 13, SDA: 18, SCL: 19 },
      adc: [...range(0, 5), ...range(14, 19)], serialPins: { 0: 'RX', 1: 'TX' }
    },
    // Nano (328P): A6/A7 = 20/21 are ADC-only (no digital buffer)
    nano: {
      name: 'Arduino Nano', digital: range(0, 19), pwm: [3, 5, 6, 9, 10, 11],
      names: { ...analogNames(14, 8), LED_BUILTIN: 13, SDA: 18, SCL: 19 },
      adc: [...range(0, 7), ...range(14, 21)], analogOnly: [20, 21], serialPins: { 0: 'RX', 1: 'TX' }
    },
    // Mega 2560: D0–D53, A0–A15 = 54–69; PWM on 2–13 and 44–46
    mega: {
      name: 'Arduino Mega 2560', digital: range(0, 69), pwm: [...range(2, 13), 44, 45, 46],
      names: { ...analogNames(54, 16), LED_BUILTIN: 13, SDA: 20, SCL: 21 },
      adc: [...range(0, 15), ...range(54, 69)], serialPins: { 0: 'RX', 1: 'TX' }
    },
    // Leonardo (32u4): A0–A5 = 18–23, A6–A11 = 24–29 (on D4, D6, D8, D9, D10, D12);
    // Serial is native USB, so D0/D1 are free (Serial1)
    leonardo: {
      name: 'Arduino Leonardo', digital: range(0, 30), pwm: [3, 5, 6, 9, 10, 11, 13],
      names: { ...analogNames(18, 12), LED_BUILTIN: 13, SDA: 2, SCL: 3 },
      adc: [...range(0, 11), ...range(18, 29)], serialPins: false
    },
    // Nano Every (ATmega4809): A0–A7 = 14–21; PWM 3, 5, 6, 9, 10; Serial is USB
    nanoevery: {
      name: 'Arduino Nano Every', digital: range(0, 21), pwm: [3, 5, 6, 9, 10],
      names: { ...analogNames(14, 8), LED_BUILTIN: 13 }, adc: null, serialPins: false
    },
    // classic ESP32 (WROOM/WROVER): GPIO 0–39 minus 20, 24, 28–31
    esp32: {
      name: 'ESP32', gpio: true, digital: range(0, 39).filter((g) => ![20, 24, 28, 29, 30, 31].includes(g)), pwm: null,
      // A-names and LED_BUILTIN differ per ESP32 variant (the Feather's A0 is
      // GPIO 26, the DevKit's is 36), so only raw GPIO numbers are checked
      names: {},
      adc: [32, 33, 34, 35, 36, 37, 38, 39, 0, 2, 4, 12, 13, 14, 15, 25, 26, 27],
      adc2: [0, 2, 4, 12, 13, 14, 15, 25, 26, 27],
      inputOnly: [34, 35, 36, 37, 38, 39], flash: [6, 7, 8, 9, 10, 11], serialPins: { 3: 'RX', 1: 'TX' }
    },
    // Raspberry Pi Pico (RP2040, earlephilhower core): GP0–GP29, A0–A3 = 26–29
    pico: {
      name: 'Raspberry Pi Pico', gpio: true, digital: range(0, 29), pwm: null,
      names: { ...analogNames(26, 4), LED_BUILTIN: 25 }, adc: [26, 27, 28, 29], serialPins: false
    }
  };

  // only FQBNs whose pinout is exactly one of the tables above
  const ESP32_CLASSIC = /^esp32:esp32:(esp32|esp32da|esp32wrover|featheresp32|nodemcu-32s|esp32doit-devkit-v1|lolin32)(:|$)/;
  function boardFor(fqbn) {
    const f = String(fqbn || '');
    if (/^arduino:avr:uno(:|$)/.test(f)) return BOARDS.uno;
    if (/^arduino:avr:nano(:|$)/.test(f)) return BOARDS.nano;
    if (/^arduino:avr:mega(:|$)/.test(f)) return BOARDS.mega;
    if (/^arduino:avr:leonardo(:|$)/.test(f)) return BOARDS.leonardo;
    if (/^arduino:megaavr:nona4809(:|$)/.test(f)) return BOARDS.nanoevery;
    if (ESP32_CLASSIC.test(f)) return BOARDS.esp32;
    if (/^rp2040:rp2040:rpipico(:|$)/.test(f)) return BOARDS.pico;
    return null;
  }

  // blank comments and string/char literals, keeping columns and lines
  function stripCode(text) {
    let out = '';
    let i = 0, mode = null;
    while (i < text.length) {
      const c = text[i], n = text[i + 1];
      if (mode === 'line') { if (c === '\n') { mode = null; out += c; } else out += ' '; i++; continue; }
      if (mode === 'block') { if (c === '*' && n === '/') { mode = null; out += '  '; i += 2; continue; } out += c === '\n' ? c : ' '; i++; continue; }
      if (mode === '"' || mode === "'") {
        if (c === '\\') { out += '  '; i += 2; continue; }
        if (c === mode || c === '\n') mode = null;
        out += c === '\n' ? c : ' '; i++; continue;
      }
      if (c === '/' && n === '/') { mode = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && n === '*') { mode = 'block'; out += '  '; i += 2; continue; }
      if (c === '"' || c === "'") { mode = c; out += ' '; i++; continue; }
      out += c; i++;
    }
    return out;
  }

  // integer constants from #define and const/constexpr declarations
  function constants(code) {
    const k = {};
    const num = (s) => /^0x[0-9a-f]+$/i.test(s) ? parseInt(s, 16) : /^\d+$/.test(s) ? Number(s) : null;
    for (const m of code.matchAll(/^[ \t]*#define[ \t]+([A-Za-z_]\w*)[ \t]+\(?\s*(0x[0-9a-fA-F]+|\d+|A\d+)\s*\)?[ \t]*$/gm)) k[m[1]] = m[2];
    for (const m of code.matchAll(/\b(?:static\s+)?(?:const|constexpr)\s+(?:unsigned\s+)?(?:int|byte|uint8_t|int8_t|uint16_t|int16_t|short|long|pin_size_t)\s+([A-Za-z_]\w*)\s*=\s*(0x[0-9a-fA-F]+|\d+|A\d+)\s*;/g)) k[m[1]] = m[2];
    const out = {};
    for (const [name, v] of Object.entries(k)) out[name] = num(v) != null ? num(v) : v;
    return out;
  }

  const CALL = /\b(pinMode|digitalWrite|digitalRead|analogWrite|analogRead|tone|noTone)\s*\(\s*([A-Za-z_]\w*|\d+)\s*(?:,\s*([A-Za-z_]\w*))?/g;

  function check(text, fqbn) {
    const b = boardFor(fqbn);
    if (!b) return [];
    const code = stripCode(String(text || ''));
    const consts = constants(code);
    const resolve = (tok) => {
      let v = tok, guard = 0;
      while (typeof v === 'string' && guard++ < 4) {
        if (/^\d+$/.test(v)) return { pin: Number(v), name: tok, literal: v === tok };
        if (b.names[v] != null) return { pin: b.names[v], name: tok, viaName: v };
        if (consts[v] != null) v = consts[v]; else return null;
      }
      return typeof v === 'number' ? { pin: v, name: tok } : null;
    };
    const lineStarts = [0];
    for (let i = 0; i < code.length; i++) if (code[i] === '\n') lineStarts.push(i + 1);
    const pos = (idx) => {
      let lo = 0, hi = lineStarts.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1; }
      return { line: lo + 1, col: idx - lineStarts[lo] + 1 };
    };
    const out = [];
    const seen = new Set();
    const add = (idx, severity, message) => {
      const p = pos(idx);
      const key = p.line + ':' + message;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ line: p.line, col: p.col, severity, message });
    };
    const word = b.gpio ? 'GPIO ' : 'pin ';
    const label = (r) => r.name === String(r.pin) ? word + r.pin : `${r.name} (${word}${r.pin})`;
    const usesWifi = /#\s*include\s*<(WiFi|WiFiClient|WebServer|ESPAsyncWebServer|BluetoothSerial|BLEDevice)\.h>/.test(text || '');
    const usesSerial = /\bSerial\s*\.\s*begin\s*\(/.test(code);

    for (const m of code.matchAll(CALL)) {
      const [, fn, tok, mode] = m;
      const r = resolve(tok);
      if (!r) continue;
      const at = m.index + m[0].indexOf(tok);
      const p = r.pin;
      if (fn === 'analogRead') {
        if (b.adc && !b.adc.includes(p)) add(at, 'error', `${label(r)} has no analog input on the ${b.name} — ADC pins: ${b.gpio ? 'GPIO ' + b.adc.slice().sort((x, y) => x - y).join(', ') : 'the A pins'}`);
        if (b.adc2 && b.adc2.includes(p) && usesWifi) add(at, 'warning', `${label(r)} is on ESP32 ADC2, which stops working while WiFi is on — use GPIO 32–39 (ADC1)`);
        continue;
      }
      const exists = b.digital.includes(p) || (b.analogOnly && b.analogOnly.includes(p));
      if (!exists) { add(at, 'error', `${label(r)} doesn't exist on the ${b.name}`); continue; }
      if (b.analogOnly && b.analogOnly.includes(p)) {
        add(at, 'error', `${label(r)} is analog-input only on the ${b.name} — ${fn}() can't use it; analogRead() only`);
        continue;
      }
      if (b.flash && b.flash.includes(p)) { add(at, 'error', `GPIO ${p} is wired to the ESP32's SPI flash chip — using it crashes the board`); continue; }
      const drives = fn === 'digitalWrite' || fn === 'analogWrite' || fn === 'tone' ||
                     (fn === 'pinMode' && mode && /^OUTPUT/.test(mode));
      if (b.inputOnly && b.inputOnly.includes(p) && drives) {
        add(at, 'error', `GPIO ${p} is input-only on the ESP32 — it can't be an output`);
        continue;
      }
      if (b.inputOnly && b.inputOnly.includes(p) && fn === 'pinMode' && /^INPUT_PULL(UP|DOWN)$/.test(mode || '')) {
        add(at, 'warning', `GPIO ${p} has no internal pull resistors on the ESP32 — ${mode} does nothing; add an external resistor`);
      }
      if (fn === 'analogWrite' && b.pwm && !b.pwm.includes(p)) {
        add(at, 'warning', `${label(r)} has no PWM on the ${b.name} — analogWrite() will only switch it fully on (≥128) or off. PWM pins: ${b.pwm.join(', ')}`);
      }
      if (b.serialPins && usesSerial && b.serialPins[p]) {
        add(at, 'warning', `${label(r)} is the USB serial line (${b.serialPins[p]}) — with Serial in use it garbles uploads and the monitor`);
      }
    }
    return out;
  }

  const api = { check, boardFor, constants, stripCode, BOARDS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ElectriCADPinCheck = api;
})(typeof window !== 'undefined' ? window : globalThis);
