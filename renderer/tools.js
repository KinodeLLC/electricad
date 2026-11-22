// Bench tools: number converter, ASCII table, RGB565, image → C bitmap,
// note frequencies, CRC. Pure functions; the UI lives in app.js.
(function (root) {
  'use strict';

  // "255", "0xFF", "0b1111_1111", "'A'", "377o" → integer (null if unreadable)
  function parseNumber(str) {
    const t = String(str == null ? '' : str).trim().replace(/_/g, '');
    if (!t) return null;
    let m;
    if ((m = /^'(.)'$/.exec(t))) return m[1].charCodeAt(0);
    if ((m = /^([-+]?)0x([0-9a-f]+)$/i.exec(t))) return (m[1] === '-' ? -1 : 1) * parseInt(m[2], 16);
    if ((m = /^([-+]?)0b([01]+)$/i.exec(t))) return (m[1] === '-' ? -1 : 1) * parseInt(m[2], 2);
    if ((m = /^([-+]?)0o([0-7]+)$/i.exec(t))) return (m[1] === '-' ? -1 : 1) * parseInt(m[2], 8);
    if ((m = /^([0-9a-f]+)h$/i.exec(t))) return parseInt(m[1], 16);
    if (/^[-+]?\d+$/.test(t)) return parseInt(t, 10);
    return null;
  }
  // one integer in every base, plus the C types it fits in
  function convert(n, bits) {
    if (n == null || !isFinite(n)) return null;
    const width = bits || (Math.abs(n) <= 0xff ? 8 : Math.abs(n) <= 0xffff ? 16 : 32);
    const mask = width >= 32 ? 0xffffffff : (1 << width) - 1;
    const u = width >= 32 ? (n >>> 0) : (n & mask);
    const group = (s, g) => s.replace(new RegExp(`(?=(?:.{${g}})+$)`, 'g'), ' ').trim();
    const fits = [];
    if (n >= 0 && n <= 255) fits.push('uint8_t / byte');
    if (n >= -128 && n <= 127) fits.push('int8_t');
    if (n >= 0 && n <= 65535) fits.push('uint16_t');
    if (n >= -32768 && n <= 32767) fits.push('int16_t (AVR int)');
    if (n >= 0 && n <= 4294967295) fits.push('uint32_t');
    if (n >= -2147483648 && n <= 2147483647) fits.push('int32_t (AVR long)');
    return {
      dec: String(n), hex: '0x' + u.toString(16).toUpperCase().padStart(Math.ceil(width / 4), '0'),
      bin: '0b' + group(u.toString(2).padStart(width, '0'), 4), oct: '0' + u.toString(8),
      char: n >= 32 && n < 127 ? "'" + String.fromCharCode(n) + "'" : (CONTROL[n] || ''),
      bits: width, fits
    };
  }

  const CONTROL = { 0: 'NUL \\0', 7: 'BEL \\a', 8: 'BS \\b', 9: 'TAB \\t', 10: 'LF \\n', 11: 'VT \\v', 12: 'FF \\f',
    13: 'CR \\r', 27: 'ESC', 127: 'DEL', 1: 'SOH', 2: 'STX', 3: 'ETX (Ctrl+C)', 4: 'EOT (Ctrl+D)', 5: 'ENQ', 6: 'ACK',
    14: 'SO', 15: 'SI', 16: 'DLE', 17: 'XON', 18: 'DC2', 19: 'XOFF', 20: 'DC4', 21: 'NAK', 22: 'SYN', 23: 'ETB',
    24: 'CAN', 25: 'EM', 26: 'SUB', 28: 'FS', 29: 'GS', 30: 'RS', 31: 'US' };
  function asciiTable() {
    const out = [];
    for (let i = 0; i < 128; i++) out.push({ dec: i, hex: '0x' + i.toString(16).toUpperCase().padStart(2, '0'),
      char: i >= 32 && i < 127 ? String.fromCharCode(i) : '', name: CONTROL[i] || (i === 32 ? 'space' : '') });
    return out;
  }

  // 24-bit colour → RGB565 (Adafruit_GFX / TFT_eSPI colour format)
  function rgb565(r, g, b) {
    const v = ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);
    return { value: v, hex: '0x' + v.toString(16).toUpperCase().padStart(4, '0') };
  }
  function from565(v) {
    const r5 = (v >> 11) & 0x1f, g6 = (v >> 5) & 0x3f, b5 = v & 0x1f;
    // scale back to 8 bits the way displays do (replicate the top bits)
    return { r: (r5 << 3) | (r5 >> 2), g: (g6 << 2) | (g6 >> 4), b: (b5 << 3) | (b5 >> 2) };
  }
  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return { r: n >> 16, g: (n >> 8) & 255, b: n & 255 };
  }

  // RGBA pixels → 1-bit bitmap for Adafruit_GFX drawBitmap(): rows padded to
  // whole bytes, most significant bit = leftmost pixel. "on" = darker than
  // the threshold (or lighter, with invert). Transparent pixels are off.
  function bitmap(rgba, w, h, opts) {
    const o = opts || {};
    const thr = o.threshold == null ? 128 : o.threshold;
    const rowBytes = Math.ceil(w / 8);
    const bytes = new Array(rowBytes * h).fill(0);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = rgba[i + 3];
      const lum = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      let on = a >= 128 && lum < thr;
      if (o.invert && a >= 128) on = !on;
      if (on) bytes[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
    return { bytes, rowBytes, w, h };
  }
  function bitmapToC(bm, name) {
    const id = String(name || 'image').replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'image';
    const lines = [];
    for (let i = 0; i < bm.bytes.length; i += 16) {
      lines.push('  ' + bm.bytes.slice(i, i + 16).map((b) => '0x' + b.toString(16).toUpperCase().padStart(2, '0')).join(', ') + ',');
    }
    return `// ${bm.w} × ${bm.h} px, ${bm.bytes.length} bytes. Draw with:\n//   display.drawBitmap(x, y, ${id}, ${bm.w}, ${bm.h}, SSD1306_WHITE);\n` +
      `const unsigned char ${id}[] PROGMEM = {\n${lines.join('\n').replace(/,$/, '')}\n};\n`;
  }

  // equal temperament, A4 = 440 Hz, rounded like Arduino's pitches.h
  const NOTE_NAMES = ['C', 'CS', 'D', 'DS', 'E', 'F', 'FS', 'G', 'GS', 'A', 'AS', 'B'];
  function noteFreq(name) {
    const m = /^([A-G])([#Ss]|b)?(-?\d)$/.exec(String(name || '').trim());
    if (!m) return null;
    let idx = NOTE_NAMES.indexOf(m[1]);
    if (m[2] === '#' || m[2] === 'S' || m[2] === 's') idx++;
    if (m[2] === 'b') idx--;
    const midi = (Number(m[3]) + 1) * 12 + idx;
    return { midi, hz: 440 * Math.pow(2, (midi - 69) / 12), rounded: Math.round(440 * Math.pow(2, (midi - 69) / 12)) };
  }
  function noteTable(fromOct = 2, toOct = 7) {
    const out = [];
    for (let o = fromOct; o <= toOct; o++) for (let i = 0; i < 12; i++) {
      const midi = (o + 1) * 12 + i;
      const hz = 440 * Math.pow(2, (midi - 69) / 12);
      out.push({ name: 'NOTE_' + NOTE_NAMES[i] + o, label: NOTE_NAMES[i].replace('S', '#') + o, hz, rounded: Math.round(hz) });
    }
    return out;
  }
  function nearestNote(hz) {
    if (!(hz > 0)) return null;
    const midi = Math.round(69 + 12 * Math.log2(hz / 440));
    const exact = 440 * Math.pow(2, (midi - 69) / 12);
    const o = Math.floor(midi / 12) - 1;
    return { label: NOTE_NAMES[midi % 12].replace('S', '#') + o, hz: exact, cents: 1200 * Math.log2(hz / exact) };
  }

  // ---- CRC (check values over "123456789" are in the tests) ----------------
  const bytesOf = (data) => (typeof data === 'string' ? Array.from(new TextEncoder().encode(data)) : Array.from(data));
  function parseBytes(str, mode) {
    if (mode === 'hex') {
      const t = String(str || '').replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '');
      if (t.length % 2) return null;
      const out = [];
      for (let i = 0; i < t.length; i += 2) out.push(parseInt(t.slice(i, i + 2), 16));
      return out;
    }
    return bytesOf(String(str || ''));
  }
  // CRC-8/SMBUS: poly 0x07, init 0 (I2C PEC)
  function crc8(data) {
    let c = 0;
    for (const b of bytesOf(data)) { c ^= b; for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff; }
    return c;
  }
  // CRC-8/MAXIM (Dallas 1-Wire: DS18B20 ROM and scratchpad)
  function crc8maxim(data) {
    let c = 0;
    for (const b of bytesOf(data)) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? (c >> 1) ^ 0x8c : c >> 1; }
    return c;
  }
  // CRC-16/MODBUS: reflected poly 0xA001, init 0xFFFF; sent low byte first
  function crc16modbus(data) {
    let c = 0xffff;
    for (const b of bytesOf(data)) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? (c >> 1) ^ 0xa001 : c >> 1; }
    return c;
  }
  // CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF
  function crc16ccitt(data) {
    let c = 0xffff;
    for (const b of bytesOf(data)) { c ^= b << 8; for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff; }
    return c;
  }
  // CRC-32 (zip, Ethernet)
  function crc32(data) {
    let c = 0xffffffff;
    for (const b of bytesOf(data)) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; }
    return (c ^ 0xffffffff) >>> 0;
  }
  function crcAll(data) {
    const h = (v, n) => '0x' + v.toString(16).toUpperCase().padStart(n, '0');
    const m = crc16modbus(data);
    return [
      { name: 'CRC-8/SMBUS', value: h(crc8(data), 2) },
      { name: 'CRC-8/MAXIM (1-Wire)', value: h(crc8maxim(data), 2) },
      { name: 'CRC-16/MODBUS', value: h(m, 4), note: 'sent as ' + h(m & 0xff, 2) + ' ' + h(m >> 8, 2) },
      { name: 'CRC-16/CCITT-FALSE', value: h(crc16ccitt(data), 4) },
      { name: 'CRC-32', value: h(crc32(data), 8) }
    ];
  }

  const api = { parseNumber, convert, asciiTable, rgb565, from565, hexToRgb, bitmap, bitmapToC, noteFreq, noteTable, nearestNote,
                parseBytes, crc8, crc8maxim, crc16modbus, crc16ccitt, crc32, crcAll, CONTROL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ElectriCADTools = api;
})(typeof window !== 'undefined' ? window : globalThis);
