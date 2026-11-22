// Pure helpers shared by the renderer panels — plotter parsing, I2C device
// names, the canvas's pins.h and bill-of-materials generators. UMD so the
// test suite runs every one of them in node.
(function (root) {
  // ---- plotter -------------------------------------------------------------
  // Accepts everything people actually print:
  //   "temp:21.5 hum:40"   "temp=21.5,hum=40"   (labelled, any separator)
  //   "21.5,40,3"   "21.5 40 3"   "21.5\t40"      (Arduino IDE plotter style)
  // Returns [{ k, v }] or [] for lines that are not data.
  const NUM = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?';
  const LABELLED = new RegExp('([A-Za-z_][\\w.\\-]*)\\s*[:=]\\s*(' + NUM + ')(?![\\w.])', 'g');
  const BARE = new RegExp('^\\s*' + NUM + '(?:\\s*[,;\\t ]\\s*' + NUM + ')*\\s*[,;]?\\s*$');
  function parsePlotLine(line) {
    const s = String(line || '');
    if (!s || s.startsWith('~PN')) return [];
    const out = [];
    for (const m of s.matchAll(LABELLED)) {
      const v = Number(m[2]);
      if (Number.isFinite(v)) out.push({ k: m[1], v });
    }
    if (out.length) return out;
    if (BARE.test(s)) {
      s.trim().split(/\s*[,;\t ]\s*/).filter(Boolean).forEach((n, i) => {
        const v = Number(n);
        if (Number.isFinite(v)) out.push({ k: 'value' + (i + 1), v });
      });
    }
    return out;
  }

  // ---- I2C address book ----------------------------------------------------
  // The usual suspects at each 7-bit address (several parts share addresses,
  // so every candidate is listed — the scan tells you WHERE, this says WHAT).
  const I2C_KNOWN = {
    0x0C: 'AK8975 magnetometer', 0x0D: 'QMC5883L compass', 0x10: 'VEML7700 lux / VEML6075 UV',
    0x18: 'LIS3DH accel / MCP9808 temp', 0x19: 'LSM303 accel / LIS3DH (alt)', 0x1C: 'LIS3MDL magnetometer / MMA8451 (alt)',
    0x1D: 'MMA8451 accel / ADXL345 (alt)', 0x1E: 'HMC5883L / LSM303 mag', 0x20: 'MCP23017/PCF8574 IO expander',
    0x21: 'MCP23017/PCF8574 (A0)', 0x23: 'BH1750 light', 0x24: 'PCF8574 / PN532 (alt)', 0x25: 'PCF8574',
    0x26: 'PCF8574', 0x27: 'PCF8574 LCD backpack (most 16×2 / 20×4 I2C LCDs)', 0x28: 'BNO055 IMU / CAP1188',
    0x29: 'VL53L0X/VL53L1X ToF / TSL2591 / BNO055 (alt)', 0x36: 'MAX17048 fuel gauge / STEMMA soil sensor',
    0x38: 'AHT20 / AHT10 temp-hum / FT6206 touch', 0x39: 'TSL2561 / APDS-9960 gesture', 0x3C: 'SSD1306/SH1106 OLED',
    0x3D: 'SSD1306 OLED (alt)', 0x3E: 'SX1509 IO expander', 0x40: 'INA219/INA260 power / PCA9685 PWM / HTU21D / Si7021',
    0x41: 'INA219 (A0) / PCA9685 (A0)', 0x44: 'SHT31/SHT4x temp-hum / INA219 (A1)', 0x45: 'SHT31 (alt) / INA219',
    0x48: 'ADS1115/ADS1015 ADC / TMP102 / PCF8591', 0x49: 'ADS1115 (alt) / TSL2561 (alt) / AS7262',
    0x4A: 'ADS1115 (alt) / BNO08x (alt)', 0x4B: 'ADS1115 (alt) / BNO08x', 0x50: 'AT24C EEPROM / FRAM',
    0x51: 'AT24C EEPROM (A0) / PCF8563 RTC', 0x52: 'EEPROM / Wii Nunchuck', 0x53: 'ADXL345 accel / EEPROM',
    0x57: 'MAX30102 pulse-ox / DS3231 EEPROM', 0x58: 'SGP30 air quality', 0x59: 'SGP40 VOC',
    0x5A: 'MLX90614 IR temp / CCS811 / MPR121 / DRV2605 haptic', 0x5B: 'CCS811 (alt) / MPR121 (alt)',
    0x5C: 'AM2320 / BH1750 (alt) / LPS22 (alt)', 0x5D: 'LPS22 / LPS25 pressure', 0x60: 'MCP4725 DAC / Si1145 UV / ATECC608',
    0x61: 'SCD30 CO₂ / MCP4725 (alt)', 0x62: 'SCD40/SCD41 CO₂ / MCP4725 (alt)', 0x68: 'DS3231/DS1307 RTC / MPU6050/MPU9250 IMU',
    0x69: 'MPU6050 (AD0 high) / ICM-20948', 0x6A: 'LSM6DS3/LSM6DSOX IMU', 0x6B: 'LSM6DS (alt) / LSM9DS1',
    0x70: 'TCA9548A I2C mux / HT16K33 LED backpack', 0x71: 'HT16K33 (alt) / TCA9548A (alt)',
    0x76: 'BME280/BMP280/BME680 (SDO low) / MS5611', 0x77: 'BME280/BMP280/BME680 / BMP180 / BMP388',
    0x7E: '(reserved)'
  };
  function i2cName(addr) { return I2C_KNOWN[addr] || 'unknown device'; }
  const hex2 = (n) => '0x' + n.toString(16).toUpperCase().padStart(2, '0');

  // ---- nets over the canvas model -----------------------------------------
  function nets(model) {
    const parent = new Map();
    const find = (x) => {
      if (!parent.has(x)) parent.set(x, x);
      while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
      return x;
    };
    for (const w of model.wires || []) parent.set(find(w.from), find(w.to));
    const groups = new Map();
    for (const w of model.wires || []) {
      for (const k of [w.from, w.to]) {
        const r = find(k);
        if (!groups.has(r)) groups.set(r, new Set());
        groups.get(r).add(k);
      }
    }
    return { find, groups };
  }

  // two-terminal passives a signal "passes through" on its way to the real part
  const PASSTHROUGH = { resistor: ['a', 'b'], fuse: ['a', 'b'], inductor: ['a', 'b'], ammeter: ['pos', 'neg'] };

  const macroize = (s) => {
    let m = String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!m) m = 'PIN';
    if (/^\d/.test(m)) m = 'P_' + m;
    return m;
  };

  // pins.h from the canvas: every board GPIO that reaches a part becomes a
  // named constant, following through series resistors so "LED_ANODE" names
  // the LED, not the resistor in front of it. Analog pins emit A0..An.
  function buildPinsHeader(model, def) {
    const { find, groups } = nets(model);
    const partOf = (key) => {
      const [, uid, port] = key.split(':');
      return { part: (model.parts || []).find((p) => p.uid === Number(uid)), port };
    };
    const lines = [];
    const used = new Set();
    const seenPins = new Set();
    (def.pins || []).forEach((pin, i) => {
      if (pin.tele == null || pin.power) return;
      const key = 'board:' + i;
      if (seenPins.has(pin.tele)) return;
      const root = find(key);
      const group = groups.get(root);
      if (!group || group.size < 2) return;
      seenPins.add(pin.tele);
      // collect real part ports on this net, hopping once through passives
      const names = [];
      for (const k of group) {
        if (!k.startsWith('part:')) continue;
        const { part, port } = partOf(k);
        if (!part) continue;
        const pass = PASSTHROUGH[part.type];
        if (pass) {
          const other = pass[0] === port ? pass[1] : pass[0];
          const far = groups.get(find('part:' + part.uid + ':' + other));
          let hopped = false;
          if (far) for (const fk of far) {
            if (!fk.startsWith('part:') || fk.startsWith('part:' + part.uid + ':')) continue;
            const f = partOf(fk);
            if (f.part && !PASSTHROUGH[f.part.type]) { names.push(f.part.name + '_' + f.port); hopped = true; }
          }
          if (!hopped) names.push(part.name + '_' + port);
        } else names.push(part.name + '_' + port);
      }
      if (!names.length) return;
      let macro = macroize(names[0]);
      let n = 2;
      while (used.has(macro)) macro = macroize(names[0]) + '_' + n++;
      used.add(macro);
      const value = pin.analogIndex != null && /^A\d/.test(pin.label) ? 'A' + pin.analogIndex : String(pin.tele);
      const extra = names.length > 1 ? ' (also ' + names.slice(1).join(', ') + ')' : '';
      lines.push({ macro, value, comment: pin.label + extra });
    });
    const width = Math.max(8, ...lines.map((l) => l.macro.length));
    return [
      '// ElectriCAD canvas — pin map for this circuit (' + (def.name || def.id) + ')',
      '// Regenerate from the canvas (Export pins.h) after rewiring.',
      '#pragma once',
      '',
      ...lines.map((l) => `#define ${l.macro.padEnd(width)} ${String(l.value).padEnd(4)} // ${l.comment}`),
      ''
    ].join('\n');
  }

  // Bill of materials: parts grouped by what you would actually order
  // (type + value + product), with catalog prices when the part came from
  // the Adafruit catalog. Returns { rows, csv, total }.
  function buildBom(model, prices) {
    const value = (p) => {
      if (p.type === 'resistor' || p.type === 'ldr' || p.type === 'thermistor') return ohms(p.r || (p.type === 'resistor' ? 220 : 10000));
      if (p.type === 'pot') return ohms(p.r || 10000);
      if (p.type === 'led') return p.color || 'red';
      if (p.type === 'fuse') return (p.r || 1) + 'A';
      if (p.type === 'psu') return (p.volts || 5) + 'V' + (p.amps ? ' ' + Number(p.amps).toFixed(2) + 'A' : '');
      if (p.type === 'capE') return (p.vr || 16) + 'V';
      return '';
    };
    const map = new Map();
    for (const p of model.parts || []) {
      if (p.type === 'voltmeter' || p.type === 'ammeter') continue; // bench gear, not BOM
      const v = value(p);
      const key = p.type + '|' + v + '|' + (p.catalogId || '') + '|' + (p.catalogId ? '' : p.name);
      if (!map.has(key)) map.set(key, { name: p.name, type: p.type, value: v, qty: 0, catalogId: p.catalogId || null });
      map.get(key).qty++;
    }
    const rows = [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
    let total = 0;
    for (const r of rows) {
      const price = r.catalogId && prices ? prices[r.catalogId] : null;
      r.unit = price != null ? price : null;
      r.ext = price != null ? Math.round(price * r.qty * 100) / 100 : null;
      if (r.ext) total += r.ext;
      r.url = r.catalogId ? 'https://www.adafruit.com/product/' + r.catalogId : '';
    }
    const q = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
    const csv = ['Qty,Part,Value,Adafruit PID,Unit price,Extended,Link']
      .concat(rows.map((r) => [r.qty, q(r.name), q(r.value), r.catalogId || '', r.unit != null ? r.unit.toFixed(2) : '',
                               r.ext != null ? r.ext.toFixed(2) : '', r.url].join(',')))
      .join('\n') + '\n';
    return { rows, csv, total: Math.round(total * 100) / 100 };
  }

  function ohms(r) {
    r = Number(r) || 0;
    if (r >= 1e6) return trim(r / 1e6) + 'MΩ';
    if (r >= 1e3) return trim(r / 1e3) + 'kΩ';
    return trim(r) + 'Ω';
  }
  const trim = (n) => String(Math.round(n * 100) / 100);

  function fmtBytes(n) {
    n = Number(n) || 0;
    return n >= 1024 * 1024 ? (n / 1048576).toFixed(2) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B';
  }

  // si formatting for meter readings: 0.0143 A → "14.3 mA"
  function si(v, unit) {
    const a = Math.abs(v);
    if (a >= 1 || a === 0) return v.toFixed(a >= 100 ? 0 : 2) + ' ' + unit;
    if (a >= 1e-3) return (v * 1e3).toFixed(1) + ' m' + unit;
    if (a >= 1e-6) return (v * 1e6).toFixed(1) + ' µ' + unit;
    return (v * 1e9).toFixed(0) + ' n' + unit;
  }

  // serial hex view / raw send
  const hexByte = (b) => b.toString(16).toUpperCase().padStart(2, '0');
  function toHexBytes(bytes) { return Array.from(bytes, hexByte).join(' '); }
  function toHex(text) {
    if (typeof TextEncoder !== 'undefined') return toHexBytes(new TextEncoder().encode(String(text)));
    return toHexBytes(Buffer.from(String(text), 'utf8'));
  }
  // "01 FF 7e", "01ff7e", "0x01,0xFF" → [1,255,126]; null if not hex
  function parseHex(s) {
    const t = String(s || '').replace(/0x/gi, '').replace(/[\s,:;-]+/g, '');
    if (!t || t.length % 2 || /[^0-9a-f]/i.test(t)) return null;
    const out = [];
    for (let i = 0; i < t.length; i += 2) out.push(parseInt(t.slice(i, i + 2), 16));
    return out;
  }

  // ANSI SGR colour codes (ESP-IDF logs, MicroPython, colour debug libs) →
  // styled runs. Anything else after ESC (cursor moves) is dropped.
  const ANSI_FG = ['#2e2e2e', '#ff5c5c', '#3fd07a', '#ffcc66', '#4aa3ff', '#c77dff', '#5ce1e6', '#e8e8e8'];
  const ANSI_BRIGHT = ['#7a7a7a', '#ff8a8a', '#7cf0a8', '#ffe08a', '#8cc4ff', '#dcb0ff', '#9ef3f6', '#ffffff'];
  function parseAnsi(text) {
    const out = [];
    let st = { fg: null, bg: null, bold: false };
    const re = /\x1b\[([0-9;]*)([A-Za-z])/g;
    let last = 0, m;
    const t = String(text || '');
    while ((m = re.exec(t))) {
      if (m.index > last) out.push({ text: t.slice(last, m.index), ...st });
      last = re.lastIndex;
      if (m[2] !== 'm') continue;
      const codes = m[1] === '' ? [0] : m[1].split(';').map(Number);
      for (let i = 0; i < codes.length; i++) {
        const c = codes[i];
        if (c === 0) st = { fg: null, bg: null, bold: false };
        else if (c === 1) st = { ...st, bold: true };
        else if (c === 22) st = { ...st, bold: false };
        else if (c >= 30 && c <= 37) st = { ...st, fg: (st.bold ? ANSI_BRIGHT : ANSI_FG)[c - 30] };
        else if (c >= 90 && c <= 97) st = { ...st, fg: ANSI_BRIGHT[c - 90] };
        else if (c === 39) st = { ...st, fg: null };
        else if (c >= 40 && c <= 47) st = { ...st, bg: ANSI_FG[c - 40] };
        else if (c === 49) st = { ...st, bg: null };
        else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
          const col = 'rgb(' + [codes[i + 2], codes[i + 3], codes[i + 4]].map((x) => Number(x) || 0).join(',') + ')';
          st = c === 38 ? { ...st, fg: col } : { ...st, bg: col }; i += 4;
        } else if ((c === 38 || c === 48) && codes[i + 1] === 5) {
          const n = Number(codes[i + 2]) || 0;
          const col = n < 8 ? ANSI_FG[n] : n < 16 ? ANSI_BRIGHT[n - 8] : null;
          if (col) st = c === 38 ? { ...st, fg: col } : { ...st, bg: col };
          i += 2;
        }
      }
    }
    if (last < t.length) out.push({ text: t.slice(last), ...st });
    return out.filter((r) => r.text);
  }
  const stripAnsi = (t) => String(t || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b/g, '');

  const api = { parseAnsi, stripAnsi, parsePlotLine, toHex, toHexBytes, parseHex, I2C_KNOWN, i2cName, hex2, nets, buildPinsHeader, buildBom, ohms, fmtBytes, si, macroize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ElectriCADUtil = api;
})(typeof window !== 'undefined' ? window : globalThis);
