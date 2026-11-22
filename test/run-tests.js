// Fast sanity tests for the pure-logic modules (no Electron needed).
const assert = require('assert');
const path = require('path');

let failures = 0;
const pending = [];
function t(name, fn) {
  const fail = (e) => { failures++; console.error('FAIL  ' + name + ' — ' + e.message); };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') pending.push(r.then(() => console.log('  ok  ' + name), fail));
    else console.log('  ok  ' + name);
  } catch (e) { fail(e); }
}

// telemetry parser
const telemetry = require('../main/telemetry');
t('parses a full telemetry line', () => {
  const s = telemetry.parseLine('~PN1|t=12345|m=2020|o=2000|d=2031|a=512,17|p=9:128,10:64');
  assert.strictEqual(s.t, 12345);
  assert.strictEqual(s.modeMask, 0x2020n);
  assert.strictEqual(s.outMask, 0x2000n);
  assert.deepStrictEqual(s.analog, [512, 17]);
  assert.deepStrictEqual(s.pwm, { 9: 128, 10: 64 });
});
t('ignores non-telemetry lines', () => {
  assert.strictEqual(telemetry.parseLine('hello world'), null);
  assert.strictEqual(telemetry.parseLine('~PNX|t=1'), null);
});
t('expands pin states', () => {
  const s = telemetry.parseLine('~PN1|t=1|m=20|o=20|d=31|a=|p=');
  const pins = telemetry.pinStates(s, 8);
  // pin 5: mode bit set, out latch high
  assert.strictEqual(pins[5].mode, 'out');
  assert.strictEqual(pins[5].level, 1);
  // pin 0: input, PIN reads high
  assert.strictEqual(pins[0].mode, 'in');
  assert.strictEqual(pins[0].level, 1);
  // pin 1: input, low
  assert.strictEqual(pins[1].level, 0);
});
t('pwm pin reported as pwm', () => {
  const s = telemetry.parseLine('~PN1|t=1|m=208|o=0|d=0|p=9:200');
  const pins = telemetry.pinStates(s, 12);
  assert.strictEqual(pins[9].mode, 'pwm');
  assert.strictEqual(pins[9].pwm, 200);
});
t('tolerates torn lines', () => {
  const s = telemetry.parseLine('~PN1|t=99|m=ZZ|d=');
  assert.strictEqual(s.t, 99);
});

// diagnostics parser (require arduino.js pieces without electron: fake app)
t('parses gcc diagnostics', () => {
  // parseDiagnostics is pure — reimplement the regex contract here to pin it
  const re = /^(.+?):(\d+):(\d+):\s+(error|warning|note):\s+(.*)$/gm;
  const text = 'C:\\proj\\blink\\blink.ino:12:3: error: expected ; before }\nnote: something';
  const m = re.exec(text);
  assert(m);
  assert.strictEqual(Number(m[2]), 12);
  assert.strictEqual(m[4], 'error');
});

// boards data integrity (runs in node by faking window)
t('board defs are consistent', () => {
  global.window = {};
  require('../renderer/boards.js');
  const B = global.window.PINODE_BOARDS;
  for (const def of Object.values(B)) {
    assert(def.id && def.name && def.w > 0 && def.h > 0, def.id + ' shape');
    for (const p of def.pins) {
      assert(typeof p.label === 'string' && p.label.length, def.id + ' pin label');
      assert(p.x >= 0 && p.x <= def.w && p.y >= 0 && p.y <= def.h,
        `${def.id} pin ${p.label} inside board (${p.x},${p.y})`);
      if (p.tele != null) assert(p.tele >= 0 && p.tele < def.digitalCount,
        `${def.id} pin ${p.label} tele ${p.tele} < ${def.digitalCount}`);
    }
  }
  // uno must expose 0..13 + A0..A5
  const unoTeles = new Set(B.uno.pins.filter((p) => p.tele != null).map((p) => p.tele));
  for (let i = 0; i <= 13; i++) assert(unoTeles.has(i), 'uno digital ' + i);
});

// circuit simulator — the physics has to be right
const sim = require('../renderer/sim.js');
function circ(parts, wires, pins) {
  return {
    boardVolts: 5,
    parts, wires,
    boardPins: [
      { key: 'board:0', tele: 9, label: '9' },
      { key: 'board:1', tele: null, label: '5V', power: 'v5' },
      { key: 'board:2', tele: null, label: 'GND', power: 'gnd' }
    ],
    pinStates: new Map(pins || [])
  };
}
t('LED + resistor: realistic current, LED lights', () => {
  const r = sim.solve(circ(
    [{ uid: 1, type: 'resistor', r: 220 }, { uid: 2, type: 'led', color: 'red' }],
    [{ from: 'board:0', to: 'part:1:a' },
     { from: 'part:1:b', to: 'part:2:anode' },
     { from: 'part:2:cathode', to: 'board:2' }],
    [[9, { mode: 'out', level: 1 }]]
  ));
  const st = r.partState[2];
  assert(st.on, 'LED should be on');
  // (5 - 1.8) / (25 + 220 + 12) ≈ 12.5mA
  assert(st.current > 0.008 && st.current < 0.02, 'current ' + st.current);
});
t('LED backwards: no current, hint raised', () => {
  const r = sim.solve(circ(
    [{ uid: 1, type: 'resistor', r: 220 }, { uid: 2, type: 'led' }],
    [{ from: 'board:0', to: 'part:1:a' },
     { from: 'part:1:b', to: 'part:2:cathode' },
     { from: 'part:2:anode', to: 'board:2' }],
    [[9, { mode: 'out', level: 1 }]]
  ));
  assert(!r.partState[2].on, 'LED must be dark');
  assert(r.warnings.some((w) => /backwards/.test(w.msg)), 'wants a backwards hint');
});
t('dead short on the rail is a fire warning', () => {
  const r = sim.solve(circ([], [{ from: 'board:1', to: 'board:2' }]));
  assert(r.warnings.some((w) => /SHORT/.test(w.msg)), JSON.stringify(r.warnings));
});
t('NPN switches a load when base driven', () => {
  const parts = [{ uid: 1, type: 'resistor', r: 1000 }, { uid: 2, type: 'npn' },
                 { uid: 3, type: 'buzzer' }];
  const wires = [
    { from: 'board:0', to: 'part:1:a' }, { from: 'part:1:b', to: 'part:2:b' },
    { from: 'board:1', to: 'part:3:pos' }, { from: 'part:3:neg', to: 'part:2:c' },
    { from: 'part:2:e', to: 'board:2' }];
  const on = sim.solve(circ(parts, wires, [[9, { mode: 'out', level: 1 }]]));
  assert(on.partState[3].on, 'buzzer should sound');
  const off = sim.solve(circ(parts, wires, [[9, { mode: 'out', level: 0 }]]));
  assert(!off.partState[3].on, 'buzzer should be silent');
});
t('stepper straight off pins triggers driver warning', () => {
  const r = sim.solve(circ(
    [{ uid: 1, type: 'stepper' }],
    [{ from: 'board:0', to: 'part:1:a1' }, { from: 'part:1:a2', to: 'board:2' }],
    [[9, { mode: 'out', level: 1 }]]
  ));
  assert(r.warnings.some((w) => /driver/.test(w.msg)), 'wants driver warning');
  assert(r.warnings.some((w) => /over the absolute max/.test(w.msg)), 'wants overcurrent');
});
t('psu respects user volts and flags over-capacity', () => {
  const r = sim.solve(circ(
    [{ uid: 1, type: 'psu', volts: 12, amps: 0.1 }, { uid: 2, type: 'resistor', r: 47 }],
    [{ from: 'part:1:pos', to: 'part:2:a' }, { from: 'part:2:b', to: 'part:1:neg' },
     { from: 'part:1:neg', to: 'board:2' }]
  ));
  // 12V / ~47.25Ω ≈ 250mA > 100mA rating
  assert(r.warnings.some((w) => /over capacity/.test(w.msg)), JSON.stringify(r.warnings));
});
t('blue LED needs its higher forward voltage', () => {
  // 3V rail equivalent: drive from a 3.3-ish psu through big resistor
  const r = sim.solve(circ(
    [{ uid: 1, type: 'psu', volts: 3.0 }, { uid: 2, type: 'resistor', r: 100 },
     { uid: 3, type: 'led', color: 'blue' }],
    [{ from: 'part:1:pos', to: 'part:2:a' }, { from: 'part:2:b', to: 'part:3:anode' },
     { from: 'part:3:cathode', to: 'part:1:neg' }, { from: 'part:1:neg', to: 'board:2' }]
  ));
  assert(!r.partState[3].on || r.partState[3].current < 0.002,
    'blue LED at 3.0V should be dark or barely lit');
});

// ---- parts knowledge base: every hookup must be real ------------------------
const kb = require('../renderer/parts.js');
t('every part has info: how it works, voltage, failure mode', () => {
  for (const p of kb.PARTS) {
    const info = kb.PART_INFO[p.type];
    assert(info, p.type + ' has an info card');
    assert(info.how && info.how.length > 20, p.type + ' explains how it works');
    assert(info.volts, p.type + ' states its designed voltage');
    assert(info.fail, p.type + ' states its failure mode');
  }
});
t('every hookup schematic resolves: real parts, real ports', () => {
  const portIds = (type) => {
    const def = kb.PARTS.find((d) => d.type === type);
    assert(def, 'part type ' + type + ' exists');
    return new Set(def.ports.map((p) => p.id));
  };
  for (const [type, h] of Object.entries(kb.HOOKUPS)) {
    assert(kb.PARTS.some((d) => d.type === type), 'hookup anchor ' + type);
    assert(h.parts.some((s) => s.type === type), type + ' hookup places its own part');
    const placed = h.parts.map((s) => portIds(s.type));
    for (const [a, b] of h.wires) {
      for (const spec of [a, b]) {
        if (/^p\d+:/.test(spec)) {
          const [pi, port] = spec.slice(1).split(':');
          assert(placed[Number(pi)], `${type}: part ref ${spec}`);
          assert(placed[Number(pi)].has(port), `${type}: port ${spec}`);
        } else {
          assert(spec === '5v' || spec === 'gnd' || spec === '3v3' || spec === 'vin' ||
                 spec.startsWith('pin:'), `${type}: board spec ${spec}`);
        }
      }
    }
  }
  // every placeable part except the blank one carries its schematic
  for (const p of kb.PARTS) {
    if (p.type === 'generic') continue;
    assert(kb.HOOKUPS[p.type], p.type + ' has a canonical hookup');
  }
  for (const r of kb.RECIPES) assert(kb.HOOKUPS[r.use], 'recipe ' + r.name);
});
t('catalog classification: interfaces and exclusions', () => {
  assert.strictEqual(kb.classify('Adafruit MCP9808 High Accuracy I2C Temperature Sensor Breakout', 'Sensors').type, 'i2cmod');
  assert.strictEqual(kb.classify('NeoPixel Ring - 16 x 5050 RGB LED with Integrated Drivers').type, 'neopixel');
  assert.strictEqual(kb.classify('Adafruit Ultimate GPS Breakout').type, 'uartmod');
  assert.strictEqual(kb.classify('Micro Servo SG92R').type, 'servo');
  assert.strictEqual(kb.classify('Adafruit BME280 STEMMA QT Pressure Sensor', 'Sensors').type, 'i2cmod');
  assert.strictEqual(kb.classify('STEMMA QT / Qwiic JST SH 4-Pin Cable - 100mm'), null);
  assert.strictEqual(kb.classify('Adafruit Gift Certificate - $25'), null);
  assert.strictEqual(kb.classify('DHT22 temperature-humidity sensor + extras').type, 'dht22');
});

// ---- undo/redo history ------------------------------------------------------
const { makeHistory } = require('../renderer/history.js');
t('history: undo/redo round trip, cap, redo cleared on push', () => {
  const h = makeHistory(3);
  const s = (n) => ({ n, parts: [] });
  h.push(s(1)); h.push(s(2)); h.push(s(3));
  assert(h.canUndo() && !h.canRedo());
  const back = h.undo(s(4));
  assert.strictEqual(back.n, 3);
  assert(h.canRedo());
  const fwd = h.redo(back);
  assert.strictEqual(fwd.n, 4);
  h.push(s(5));
  assert(!h.canRedo(), 'push clears redo');
  h.push(s(6)); h.push(s(7)); h.push(s(8)); // over cap of 3
  assert.strictEqual(h.undo({}).n, 8);
  assert.strictEqual(h.undo({}).n, 7);
  assert.strictEqual(h.undo({}).n, 6);
  assert(!h.canUndo(), 'cap holds 3');
});

// ---- A4988 + ratings: the sim knows what parts are designed for -------------
function circ2(volts, parts, wires, pins) {
  return { boardVolts: volts, parts, wires,
    boardPins: [
      { key: 'board:0', tele: 9, label: '9' },
      { key: 'board:1', tele: null, label: '5V', power: 'v5' },
      { key: 'board:2', tele: null, label: 'GND', power: 'gnd' },
      { key: 'board:3', tele: 2, label: '2' }
    ],
    pinStates: new Map(pins || []) };
}
t('A4988 drives a stepper: current-limited, no false driver warning', () => {
  const parts = [
    { uid: 1, type: 'a4988', name: 'A4988', ratings: kb.PART_INFO.a4988.ratings },
    { uid: 2, type: 'stepper', name: 'Stepper' },
    { uid: 3, type: 'psu', name: 'PSU', volts: 12, amps: 2 }
  ];
  const wires = [
    { from: 'part:3:pos', to: 'part:1:vmot' }, { from: 'part:3:neg', to: 'part:1:gnd' },
    { from: 'board:0', to: 'part:1:step' }, { from: 'board:2', to: 'part:1:gnd' },
    { from: 'part:1:o1a', to: 'part:2:a1' }, { from: 'part:1:o1b', to: 'part:2:a2' },
    { from: 'part:1:o2a', to: 'part:2:b1' }, { from: 'part:1:o2b', to: 'part:2:b2' }
  ];
  const r = sim.solve(circ2(5, parts, wires, [[9, { mode: 'out', level: 1 }]]));
  const st = r.partState[2];
  assert(st.on, 'coils energized');
  assert(st.current > 0.4 && st.current < 1.1, 'hold current limited: ' + st.current);
  assert(!r.warnings.some((w) => /straight off a pin/.test(w.msg)), 'no false pin warning');
  assert(!r.warnings.some((w) => /rail/.test(w.msg) && /motor/.test(w.msg)), 'no false rail warning');
});
t('A4988 undervolted VMOT: dead coils + undervolt hint', () => {
  const parts = [
    { uid: 1, type: 'a4988', name: 'A4988', ratings: kb.PART_INFO.a4988.ratings },
    { uid: 2, type: 'stepper', name: 'Stepper' },
    { uid: 3, type: 'psu', name: 'PSU', volts: 5, amps: 2 }
  ];
  const wires = [
    { from: 'part:3:pos', to: 'part:1:vmot' }, { from: 'part:3:neg', to: 'part:1:gnd' },
    { from: 'part:1:o1a', to: 'part:2:a1' }, { from: 'part:1:o1b', to: 'part:2:a2' }
  ];
  const r = sim.solve(circ2(5, parts, wires));
  assert(!r.partState[2].on, 'no drive below 8V VMOT');
  assert(r.warnings.some((w) => /undervolted/.test(w.msg)), JSON.stringify(r.warnings));
});
t('motor on the rail warns; motor behind NPN + own supply is clean', () => {
  const onRail = sim.solve(circ2(5,
    [{ uid: 1, type: 'dcmotor', name: 'DC motor' }],
    [{ from: 'board:1', to: 'part:1:pos' }, { from: 'part:1:neg', to: 'board:2' }]));
  assert(onRail.warnings.some((w) => /rail/.test(w.msg)), 'rail warning wanted');
  assert(!onRail.warnings.some((w) => /straight off a pin/.test(w.msg)), 'not a pin warning');
  const proper = sim.solve(circ2(5, [
    { uid: 1, type: 'psu', name: 'PSU', volts: 6, amps: 2 },
    { uid: 2, type: 'resistor', name: 'R', r: 1000 },
    { uid: 3, type: 'npn', name: 'NPN' },
    { uid: 4, type: 'dcmotor', name: 'DC motor' },
    { uid: 5, type: 'diode', name: 'Flyback' }
  ], [
    { from: 'board:0', to: 'part:2:a' }, { from: 'part:2:b', to: 'part:3:b' },
    { from: 'part:1:pos', to: 'part:4:pos' }, { from: 'part:4:neg', to: 'part:3:c' },
    { from: 'part:3:e', to: 'part:1:neg' }, { from: 'part:3:e', to: 'board:2' },
    { from: 'part:5:cathode', to: 'part:4:pos' }, { from: 'part:5:anode', to: 'part:4:neg' }
  ], [[9, { mode: 'out', level: 1 }]]));
  assert(proper.partState[4].on, 'motor runs');
  assert(!proper.warnings.some((w) => /straight off a pin|rail/.test(w.msg)),
    JSON.stringify(proper.warnings.map((w) => w.msg)));
});
t('ratings: 9V into a DHT22 is flagged as damage', () => {
  const r = sim.solve(circ2(5, [
    { uid: 1, type: 'psu', name: 'PSU', volts: 9, amps: 1 },
    { uid: 2, type: 'dht22', name: 'DHT22', ratings: kb.PART_INFO.dht22.ratings }
  ], [
    { from: 'part:1:pos', to: 'part:2:vcc' }, { from: 'part:2:gnd', to: 'part:1:neg' },
    { from: 'part:1:neg', to: 'board:2' }
  ]));
  assert(r.warnings.some((w) => w.level === 'danger' && /absolute max/.test(w.msg)),
    JSON.stringify(r.warnings.map((w) => w.msg)));
});
t('NeoPixel: 3.3V logic into a 5V strip wants a level shifter', () => {
  const r = sim.solve(circ2(3.3, [
    { uid: 1, type: 'psu', name: 'PSU', volts: 5, amps: 2 },
    { uid: 2, type: 'neopixel', name: 'NeoPixel', ratings: kb.PART_INFO.neopixel.ratings }
  ], [
    { from: 'part:1:pos', to: 'part:2:v5' }, { from: 'part:2:gnd', to: 'part:1:neg' },
    { from: 'part:1:neg', to: 'board:2' }, { from: 'board:0', to: 'part:2:din' }
  ], [[9, { mode: 'out', level: 1 }]]));
  assert(r.warnings.some((w) => /0\.7×VDD/.test(w.msg)), JSON.stringify(r.warnings.map((w) => w.msg)));
});

t('flash chip on a stock CH341A 5V rail = damage; on 3V3 = clean', () => {
  const mk = (rail) => sim.solve(circ2(5, [
    { uid: 1, type: 'ch341a', name: 'CH341A' },
    { uid: 2, type: 'spiflash', name: 'W25Q64', ratings: kb.PART_INFO.spiflash.ratings }
  ], [
    { from: 'part:1:' + rail, to: 'part:2:vcc' }, { from: 'part:2:gnd', to: 'part:1:gnd' },
    { from: 'part:1:gnd', to: 'board:2' }
  ]));
  const bad = mk('v5');
  assert(bad.warnings.some((w) => w.level === 'danger' && /absolute max/.test(w.msg)),
    JSON.stringify(bad.warnings.map((w) => w.msg)));
  const good = mk('v33');
  assert(!good.warnings.some((w) => /absolute max/.test(w.msg)), '3V3 rail is fine');
});

// ---- feather board defs -----------------------------------------------------
t('feather defs: real GPIO mappings where they matter', () => {
  const B = global.window.PINODE_BOARDS;
  const by = (id, label) => B[id].pins.find((p) => p.label === label);
  assert.strictEqual(by('featherrp2040', 'D13').tele, 13);
  assert.strictEqual(by('featherrp2040', 'SDA/GP2').tele, 2);
  assert.strictEqual(by('featherrp2040', 'A0/GP26').tele, 26);
  assert.strictEqual(by('featheresp32', 'SDA/23').tele, 23);
  // input-only pins are still readable: the library reads GPIO_IN1 for 32+
  assert.strictEqual(by('featheresp32', 'A2/34').tele, 34);
  assert(/input only/.test(by('featheresp32', 'A2/34').note));
  assert.strictEqual(by('featherm4', 'SCK').tele, 25);
  assert.strictEqual(by('featherm0', 'SCK').tele, 24);
  assert.strictEqual(by('featherm0', 'SDA').tele, 20);
  assert.strictEqual(by('featherm0', 'MI').tele, 22);
  // red LED on "13" in every variant — like the real boards
  for (const id of ['featheresp32', 'featherrp2040', 'featherm0', 'featherm4']) {
    assert(B[id].decor.some((d) => d.kind === 'led' && d.tele === 13), id + ' has the 13 LED');
  }
});

// ---- core url injection -----------------------------------------------------
const coreurls = require('../main/coreurls.js');
t('core urls: injected once, idempotent, fqbn → core id', () => {
  const first = coreurls.ensureUrlsInYaml('directories:\n  data: "x"\n');
  assert(first.changed);
  for (const u of coreurls.ADDITIONAL_URLS) assert(first.text.includes(u), u);
  const again = coreurls.ensureUrlsInYaml(first.text);
  assert(!again.changed, 'second pass is a no-op');
  assert.strictEqual(coreurls.coreIdFromFqbn('esp8266:esp8266:nodemcuv2'), 'esp8266:esp8266');
  assert.strictEqual(coreurls.coreIdFromFqbn('rp2040:rp2040:adafruit_feather'), 'rp2040:rp2040');
  assert.strictEqual(coreurls.coreIdFromFqbn('garbage'), null);
});

// ---- offline adafruit catalog ----------------------------------------------
t('catalog: loads offline, searches, knows real products', () => {
  const catalog = require('../main/catalog.js');
  const s = catalog.stats();
  assert(s.products > 5000, 'products: ' + s.products);
  const hits = catalog.search({ q: 'feather m4 can' });
  assert(hits.some((p) => p.id === 4759), 'Feather M4 CAN found');
  const p = catalog.get(4759);
  assert(/Feather M4 CAN/i.test(p.name), p.name);
  assert.strictEqual(p.url, 'https://www.adafruit.com/product/4759');
  assert(catalog.categories().length > 20, 'categories flattened');
  const stock = catalog.search({ q: 'neopixel', inStock: true });
  assert(stock.every((x) => x.stock > 0), 'stock filter');
});


// ---- v0.6 -------------------------------------------------------------------
t('splitLine pulls telemetry and I2C markers out of mid-line text', () => {
  const a = telemetry.splitLine('temp:21.5~PN1|t=5|m=0|o=0|d=1|p=');
  assert.strictEqual(a.text, 'temp:21.5');
  assert(a.telemetry && a.telemetry.startsWith('~PN1|'), 'telemetry part');
  const b = telemetry.splitLine('~PNI|n=2|a=3C,76');
  assert(b.i2c && !b.text, 'i2c only');
  const c = telemetry.splitLine('plain text');
  assert.strictEqual(c.text, 'plain text');
  assert(!c.telemetry && !c.i2c);
});
t('u= pull-up mask parses and marks INPUT_PULLUP pins', () => {
  const s = telemetry.parseLine('~PN1|t=1|m=0|o=0|d=4|u=4|p=');
  assert.strictEqual(s.pullMask, 4n);
  assert(s.hasPull);
  const pins = telemetry.pinStates(s, 8);
  assert.strictEqual(pins[2].pull, 'up');
  assert(!pins[1].pull);
});
t('skipped analog fields come through as null, not 0', () => {
  const s = telemetry.parseLine('~PN1|t=1|m=0|o=0|d=0|a=512,,7|p=');
  assert.deepStrictEqual(s.analog, [512, null, 7]);
});
t('parseI2c reads the address list', () => {
  const r = telemetry.parseI2c('~PNI|n=2|a=3C,76');
  assert.deepStrictEqual(r.addresses, [0x3c, 0x76]);
  assert.deepStrictEqual(telemetry.parseI2c('~PNI|n=0|a=').addresses, []);
  assert.strictEqual(telemetry.parseI2c('nope'), null);
});
t('torn hex never throws or poisons a snapshot', () => {
  const s = telemetry.parseLine('~PN1|t=1|m=zz|o=0|d=1');
  assert.strictEqual(s.modeMask, 0n);
  assert.strictEqual(s.inMask, 1n);
});

t('floating supply (no ground reference) solves to finite voltages', () => {
  const r = sim.solve(circ(
    [{ uid: 1, type: 'psu', volts: 9, name: 'PSU' }, { uid: 2, type: 'resistor', r: 1000 }],
    [{ from: 'part:1:pos', to: 'part:2:a' }, { from: 'part:2:b', to: 'part:1:neg' }]));
  for (const v of r.netVolts) assert(Number.isFinite(v), 'finite ' + v);
  const ia = r.wireCurrents[0].current;
  assert(Math.abs(ia - 0.009) < 0.001, '9V/1k ≈ 9mA, got ' + ia);
});
t('pot wiper position sets the divider', () => {
  const run = (pos) => {
    const r = sim.solve(circ(
      [{ uid: 1, type: 'pot', r: 10000, pos }, { uid: 2, type: 'voltmeter', name: 'V' }],
      [{ from: 'board:1', to: 'part:1:vcc' }, { from: 'part:1:gnd', to: 'board:2' },
       { from: 'part:1:wiper', to: 'part:2:pos' }, { from: 'part:2:neg', to: 'board:2' }]));
    return r.partState[2].reading.value;
  };
  assert(Math.abs(run(0.25) - 1.25) < 0.05, 'quarter: ' + run(0.25));
  assert(Math.abs(run(0.75) - 3.75) < 0.05, 'three quarters: ' + run(0.75));
});
t('ammeter in series reads the LED current', () => {
  const r = sim.solve(circ(
    [{ uid: 1, type: 'ammeter', name: 'A' }, { uid: 2, type: 'resistor', r: 220 }, { uid: 3, type: 'led' }],
    [{ from: 'board:0', to: 'part:1:pos' }, { from: 'part:1:neg', to: 'part:2:a' },
     { from: 'part:2:b', to: 'part:3:anode' }, { from: 'part:3:cathode', to: 'board:2' }],
    [[9, { mode: 'out', level: 1 }]]));
  const a = r.partState[1].reading;
  assert.strictEqual(a.unit, 'A');
  assert(a.value > 0.008 && a.value < 0.02, 'amps ' + a.value);
  assert(Math.abs(a.value - r.partState[3].current) < 0.0005, 'matches the LED');
});
t('TMP36 outputs 0.5 V + 10 mV/°C', () => {
  const r = sim.solve(circ(
    [{ uid: 1, type: 'tmp36', tempC: 30 }, { uid: 2, type: 'voltmeter', name: 'V' }],
    [{ from: 'board:1', to: 'part:1:vcc' }, { from: 'part:1:gnd', to: 'board:2' },
     { from: 'part:1:out', to: 'part:2:pos' }, { from: 'part:2:neg', to: 'board:2' }]));
  assert(Math.abs(r.partState[2].reading.value - 0.8) < 0.02, 'V ' + r.partState[2].reading.value);
});
t('INPUT_PULLUP + button to GND: HIGH released, LOW pressed', () => {
  const run = (closed) => sim.solve(circ(
    [{ uid: 1, type: 'button', closed }],
    [{ from: 'board:0', to: 'part:1:a' }, { from: 'part:1:b', to: 'board:2' }],
    [[9, { mode: 'in', pull: 'up', level: 0 }]])).pinReads['board:0'];
  assert.strictEqual(run(false), 'HIGH');
  assert.strictEqual(run(true), 'LOW');
});
t('plain INPUT on an open button floats (and says so)', () => {
  const r = sim.solve(circ(
    [{ uid: 1, type: 'button', closed: false }],
    [{ from: 'board:0', to: 'part:1:a' }, { from: 'part:1:b', to: 'board:2' }],
    [[9, { mode: 'in', level: 0 }]]));
  assert.strictEqual(r.pinReads['board:0'], 'FLOAT');
  assert(r.warnings.some((w) => /nothing pulling it/.test(w.msg)), 'float hint');
});

const U = require('../renderer/util.js');
t('plot lines: labelled pairs and bare CSV', () => {
  assert.deepStrictEqual(U.parsePlotLine('temp:21.5 hum:40'), [{ k: 'temp', v: 21.5 }, { k: 'hum', v: 40 }]);
  assert.deepStrictEqual(U.parsePlotLine('1,2.5,-3').map((p) => p.v), [1, 2.5, -3]);
  assert.deepStrictEqual(U.parsePlotLine('hello world'), []);
});
t('I2C names and hex formatting', () => {
  assert.strictEqual(U.hex2(0x3c), '0x3C');
  assert(/SSD1306|OLED/i.test(U.i2cName(0x3c)), U.i2cName(0x3c));
});
t('pins.h follows the wiring through passthrough parts', () => {
  global.window = global.window || {};
  const B = global.window.PINODE_BOARDS;
  const def = B.uno;
  const i9 = def.pins.findIndex((p) => p.tele === 9);
  const iA0 = def.pins.findIndex((p) => p.analogIndex === 0);
  const gnd = def.pins.findIndex((p) => p.power === 'gnd');
  const model = {
    parts: [{ uid: 1, type: 'resistor', name: 'R1', r: 220 }, { uid: 2, type: 'led', name: 'Status LED' },
            { uid: 3, type: 'pot', name: 'Knob' }],
    wires: [{ from: 'board:' + i9, to: 'part:1:a' }, { from: 'part:1:b', to: 'part:2:anode' },
            { from: 'part:2:cathode', to: 'board:' + gnd }, { from: 'board:' + iA0, to: 'part:3:wiper' }]
  };
  const h = U.buildPinsHeader(model, def);
  assert(/#pragma once/.test(h), 'pragma');
  assert(/#define STATUS_LED_\w*\s+9\b/.test(h), 'LED via resistor → 9:\n' + h);
  assert(/#define KNOB_\w*\s+A0\b/.test(h), 'analog uses A0:\n' + h);
});
t('BOM groups, prices and totals', () => {
  const bom = U.buildBom({ parts: [
    { uid: 1, type: 'resistor', name: 'Resistor', r: 220 }, { uid: 2, type: 'resistor', name: 'Resistor', r: 220 },
    { uid: 3, type: 'oled', name: 'OLED', catalogId: 326 }, { uid: 4, type: 'voltmeter', name: 'V' }] }, { 326: 17.5 });
  const r = bom.rows.find((x) => x.type === 'resistor');
  assert.strictEqual(r.qty, 2);
  assert.strictEqual(r.value, '220Ω');
  assert(!bom.rows.some((x) => x.type === 'voltmeter'), 'meters are not BOM');
  assert.strictEqual(bom.total, 17.5);
  assert(/^Qty,Part/.test(bom.csv));
});
t('si / ohms formatting', () => {
  assert.strictEqual(U.si(0.0143, 'A'), '14.3 mA');
  assert.strictEqual(U.ohms(4700), '4.7kΩ');
  assert.strictEqual(U.ohms(1e6), '1MΩ');
});

const AA = require('../renderer/arduino-api.js');
t('Arduino API table is well formed', () => {
  assert(AA.API.length > 60, 'entries ' + AA.API.length);
  for (const e of AA.API) {
    assert(e.length === 4 && e[0] && e[2] && 'fckm'.includes(e[3]), 'entry ' + e[0]);
  }
  assert(AA.lookup('digitalWrite'), 'digitalWrite known');
  assert(AA.lookup('ELECTRICAD_DELAY'), 'ElectriCAD macros documented');
});

const { EXAMPLES } = require('../main/examples.js');
t('examples are complete and use only real macros', () => {
  const ids = new Set();
  for (const ex of EXAMPLES) {
    assert(ex.id && ex.name && ex.desc && ex.type && ex.code, 'fields ' + ex.id);
    assert(!ids.has(ex.id), 'unique ' + ex.id); ids.add(ex.id);
    if (ex.type === 'arduino') {
      assert(/void\s+setup\s*\(/.test(ex.code) && /void\s+loop\s*\(/.test(ex.code), ex.id + ' setup/loop');
      const macros = ex.code.match(/ELECTRICAD_\w+/g) || [];
      for (const m of macros) assert(['ELECTRICAD_BEGIN', 'ELECTRICAD_TICK', 'ELECTRICAD_DELAY', 'ELECTRICAD_I2C_SCAN'].includes(m), ex.id + ' ' + m);
    }
  }
  const hdr = require('fs').readFileSync(path.join(__dirname, '../library/ElectriCADTelemetry/src/ElectriCADTelemetry.h'), 'utf8');
  for (const m of ['ELECTRICAD_BEGIN', 'ELECTRICAD_TICK', 'ELECTRICAD_DELAY', 'ELECTRICAD_I2C_SCAN']) {
    assert(new RegExp('#define ' + m + '\\(').test(hdr), 'library defines ' + m);
  }
});

const detect = require('../main/detect.js');
t('board view from FQBN is pin-accurate or nothing', () => {
  const f = detect.boardIdFromFqbn;
  assert.strictEqual(f('arduino:avr:uno'), 'uno');
  assert.strictEqual(f('arduino:avr:nano:cpu=atmega328old'), 'nano');
  assert.strictEqual(f('arduino:avr:leonardo'), 'leonardo');
  assert.strictEqual(f('arduino:avr:micro'), null);
  assert.strictEqual(f('arduino:megaavr:nona4809'), 'nanoevery');
  assert.strictEqual(f('arduino:renesas_uno:minima'), 'uno');
  assert.strictEqual(f('adafruit:samd:adafruit_feather_m0'), 'featherm0');
  assert.strictEqual(f('adafruit:samd:adafruit_feather_m4'), 'featherm4');
  assert.notStrictEqual(f('adafruit:nrf52:feather52840'), 'featherm4');
  assert.strictEqual(f('esp32:esp32:featheresp32'), 'featheresp32');
  assert.strictEqual(f('esp32:esp32:adafruit_feather_esp32s3'), 'esp32');
  assert.strictEqual(f('rp2040:rp2040:adafruit_feather'), 'featherrp2040');
  assert.strictEqual(f('rp2040:rp2040:adafruit_feather_scorpio'), 'pico');
});
t('board defs: fqbnMatch agrees with detect', () => {
  const B = global.window.PINODE_BOARDS;
  const pick = (fqbn) => (Object.values(B).find((d) => d.fqbnMatch.test(fqbn)) || {}).id;
  assert.strictEqual(pick('adafruit:samd:adafruit_feather_m0'), 'featherm0');
  assert.strictEqual(pick('adafruit:samd:adafruit_feather_m4'), 'featherm4');
  assert.strictEqual(pick('adafruit:nrf52:feather52840'), undefined);
  assert.strictEqual(pick('esp32:esp32:adafruit_feather_esp32_v2'), 'esp32');
  assert(B.esp32.pins.some((p) => p.tele === 34 && /input only/.test(p.note)), 'esp32 34 live');
});
t('guessBoardId: feather families', () => {
  const g = detect.guessBoardId;
  assert.strictEqual(g('Adafruit Feather M0 Express'), 'featherm0');
  assert.strictEqual(g('Adafruit Feather M4 Express'), 'featherm4');
  assert.strictEqual(g('Adafruit Feather ESP32-S3'), 'esp32');
  assert.notStrictEqual(g('Adafruit Feather nRF52840'), 'featherm4');
});

t('catalog ranks exact name hits first', () => {
  const catalog = require('../main/catalog.js');
  const hits = catalog.search({ q: 'feather m4 express', limit: 5 });
  assert(hits.length && /feather m4 express/i.test(hits[0].name), hits[0] && hits[0].name);
  assert.strictEqual(catalog.search({ q: '4759', limit: 3 })[0].id, 4759, 'exact id first');
});


// ---- v0.7 -------------------------------------------------------------------
const upyMod = require('../main/upy.js');
t('MicroPython bytes literal survives quotes, backslashes, UTF-8', () => {
  assert.strictEqual(upyMod.pyBytes(Buffer.from("a'b\\c\n")), "b'a\\'b\\\\c\\n'");
  assert.strictEqual(upyMod.pyBytes(Buffer.from('é')), "b'\\xc3\\xa9'");
  assert.strictEqual(upyMod.pyStr("it's"), "'it\\'s'");
});
t('file upload is chunked and closes the file', () => {
  const steps = upyMod.writeFileScript('main.py', 'x'.repeat(500));
  assert(/^f=open\('main\.py','wb'\)/.test(steps[0]));
  assert.strictEqual(steps[steps.length - 1], 'f.close()');
  assert.strictEqual(steps.length, 2 + Math.ceil(500 / 192));
});
t('raw REPL replies parse out stdout and stderr', () => {
  assert.deepStrictEqual(upyMod.parseReply('OKhello\r\n\x04\x04>'), { out: 'hello\r\n', err: '' });
  assert.deepStrictEqual(upyMod.parseReply('OK\x04Traceback\x04>'), { out: '', err: 'Traceback' });
  assert.strictEqual(upyMod.parseReply('OKhalf\x04'), null);
});
t('upload talks raw REPL to a simulated MicroPython board', async () => {
  // fake board: executes our tiny scripts by pattern
  const bridgePath = require.resolve('../main/serialbridge.js');
  const realBridge = require.cache[bridgePath];
  let taps = new Set(), file = '', mode = 'friendly', buf = '';
  const board = (s) => setTimeout(() => taps.forEach((f) => f(Buffer.from(s, 'latin1'))), 2);
  require.cache[bridgePath] = { exports: {
    isOpen: () => true,
    tap: (p, fn) => { taps.add(fn); return () => taps.delete(fn); },
    writeRaw: async (p, data) => {
      for (const ch of String(data)) {
        if (ch === '\x01') { mode = 'raw'; buf = ''; board('raw REPL; CTRL-B to exit\r\n>'); }
        else if (ch === '\x02') mode = 'friendly';
        else if (ch === '\x04' && mode === 'raw') {
          let out = '';
          for (const m of buf.matchAll(/w\(b'((?:[^'\\]|\\.)*)'\)/g)) file += m[1].replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
          if (/os\.stat/.test(buf)) out = Buffer.byteLength(file) + '\r\n';
          board('OK' + out + '\x04\x04>');
          buf = '';
        } else if (mode === 'raw') buf += ch;
      }
      return true;
    }
  } };
  delete require.cache[require.resolve('../main/upy.js')];
  const upy2 = require('../main/upy.js');
  const r = await upy2.upload('COM9', 'main.py', "print('hi')\n");
  require.cache[bridgePath] = realBridge;
  delete require.cache[require.resolve('../main/upy.js')];
  assert.strictEqual(r.bytes, 12);
  assert.strictEqual(file, "print('hi')\n");
  assert.strictEqual(mode, 'friendly', 'leaves raw REPL afterwards');
});

const gitMod = require('../main/git.js');
t('git status porcelain parses branch, tracking and file kinds', () => {
  const s = gitMod.parseStatus('## main...origin/main [ahead 2, behind 1]\n M blink.ino\nA  pins.h\n?? notes.txt\nR  old.h -> new.h\n');
  assert.strictEqual(s.branch, 'main');
  assert.strictEqual(s.upstream, 'origin/main');
  assert.strictEqual(s.ahead, 2); assert.strictEqual(s.behind, 1);
  assert.deepStrictEqual(s.files.map((f) => f.kind), ['modified', 'added', 'untracked', 'renamed']);
  assert.strictEqual(s.files[3].path, 'new.h');
  assert(s.files[1].staged && !s.files[0].staged && !s.files[2].staged);
  assert.strictEqual(gitMod.parseStatus('## No commits yet on main\n').branch, 'main');
});
t('git log format parses', () => {
  const l = gitMod.parseLog('abcdef1234\x1f2026-11-22\x1fSam\x1ffix: led | pin\n');
  assert.strictEqual(l[0].short, 'abcdef1');
  assert.strictEqual(l[0].subject, 'fix: led | pin');
});

t('hex serial helpers', () => {
  assert.deepStrictEqual(U.parseHex('0x01, 0xff 7e'), [1, 255, 126]);
  assert.strictEqual(U.parseHex('1g'), null);
  assert.strictEqual(U.parseHex('abc'), null);
  assert.strictEqual(U.toHex('A\n'), '41 0A');
});

t('Leonardo and Nano Every views use their real numbering', () => {
  const B = global.window.PINODE_BOARDS;
  const by = (id, label) => B[id].pins.find((p) => p.label === label);
  assert.strictEqual(by('leonardo', 'A0').tele, 18);
  assert.strictEqual(by('leonardo', 'A5').tele, 23);
  assert.strictEqual(by('leonardo', 'SDA').tele, 2);
  assert.strictEqual(by('nanoevery', 'A7').tele, 21);
  assert(!by('nanoevery', 'D11').pwm, 'Every: D11 has no PWM');
  const pick = (fqbn) => (Object.values(B).find((d) => d.fqbnMatch.test(fqbn)) || {}).id;
  assert.strictEqual(pick('arduino:avr:leonardo'), 'leonardo');
  assert.strictEqual(pick('arduino:avr:leonardoeth'), undefined);
  assert.strictEqual(pick('arduino:megaavr:nona4809'), 'nanoevery');
  assert.strictEqual(pick('arduino:renesas_uno:minima'), 'uno');
});

t('SPDT slide switch routes COM to A or B', () => {
  const run = (closed) => sim.solve(circ([{ uid: 1, type: 'slide', closed }],
    [{ from: 'board:0', to: 'part:1:com' }, { from: 'part:1:a', to: 'board:2' }, { from: 'part:1:b', to: 'board:1' }],
    [[9, { mode: 'in', level: 0 }]])).pinReads['board:0'];
  assert.strictEqual(run(false), 'LOW');
  assert.strictEqual(run(true), 'HIGH');
});
t('LM35 outputs 10 mV/°C and needs 4 V', () => {
  const r = sim.solve(circ([{ uid: 1, type: 'lm35', tempC: 30 }, { uid: 2, type: 'voltmeter' }],
    [{ from: 'board:1', to: 'part:1:vcc' }, { from: 'part:1:gnd', to: 'board:2' },
     { from: 'part:1:out', to: 'part:2:pos' }, { from: 'part:2:neg', to: 'board:2' }]));
  assert(Math.abs(r.partState[2].reading.value - 0.3) < 0.01, 'V ' + r.partState[2].reading.value);
  assert(kb.PART_INFO.lm35.ratings.pairs[0].min === 4);
});
t('new parts are complete: palette, info, hookups', () => {
  for (const type of ['slide', 'reed', 'lm35', 'cr2032']) {
    assert(kb.PARTS.some((p) => p.type === type), type + ' in palette');
    assert(kb.PART_INFO[type] && kb.PART_INFO[type].how, type + ' info');
    assert(kb.HOOKUPS[type], type + ' hookup');
  }
});
t('MicroPython/CircuitPython examples', () => {
  const py = EXAMPLES.filter((e) => e.type === 'micropython' || e.type === 'circuitpython');
  assert(py.length >= 4, 'py examples');
  for (const e of py) assert(!/ELECTRICAD_/.test(e.code) && /import /.test(e.code), e.id);
});

// ---- v0.8 ------------------------------------------------------------------
const PC = require('../renderer/pincheck.js');
const FMT = require('../renderer/format.js');
const CALC = require('../renderer/calc.js');
t('pin check: Nano rules (PWM, A6/A7, nonexistent, serial pins, analogRead)', () => {
  const d = PC.check(`#define LED 7
const int POT = A2;
const byte BAD = 22;
void setup(){ Serial.begin(9600); pinMode(LED, OUTPUT); pinMode(BAD, OUTPUT); pinMode(1, OUTPUT); }
void loop(){ analogWrite(LED, 100); analogWrite(9, 3); analogRead(POT); analogRead(3); analogRead(13); // analogWrite(4, 1)
  digitalWrite(A6, 1); Serial.println("analogWrite(4,1)"); }`, 'arduino:avr:nano:cpu=atmega328old');
  const msgs = d.map((x) => x.line + ':' + x.message);
  assert(msgs.some((m) => /^4:BAD \(pin 22\) doesn't exist/.test(m)), 'nonexistent');
  assert(msgs.some((m) => /^4:pin 1 is the USB serial line \(TX\)/.test(m)), 'serial');
  assert(msgs.some((m) => /^5:LED \(pin 7\) has no PWM/.test(m)), 'pwm');
  assert(msgs.some((m) => /^5:pin 13 has no analog input/.test(m)), 'adc');
  assert(msgs.some((m) => /^6:A6 \(pin 20\) is analog-input only/.test(m)), 'A6');
  assert(!msgs.some((m) => /pin 9|POT|pin 3 |pin 4/.test(m)), 'no false positives: ' + msgs.join(' | '));
  assert.strictEqual(d.length, 5);
});
t('pin check: classic ESP32 rules; S3 and unknown boards are not guessed', () => {
  const d = PC.check(`#include <WiFi.h>
void setup(){ pinMode(34, OUTPUT); pinMode(35, INPUT_PULLUP); digitalWrite(6, 1); analogRead(25); analogRead(5); analogRead(36); pinMode(2, OUTPUT); }`, 'esp32:esp32:esp32');
  const m = d.map((x) => x.message).join('\n');
  assert(/GPIO 34 is input-only/.test(m) && /GPIO 35 has no internal pull/.test(m) && /GPIO 6 is wired to the ESP32's SPI flash/.test(m));
  assert(/GPIO 25 is on ESP32 ADC2/.test(m) && /GPIO 5 has no analog input/.test(m));
  assert(!/GPIO 36|GPIO 2\b/.test(m));
  assert.deepStrictEqual(PC.check('void setup(){ pinMode(40, OUTPUT); analogWrite(7, 1); }', 'esp32:esp32:esp32s3'), []);
  assert.deepStrictEqual(PC.check('void setup(){ analogWrite(7, 1); }', 'arduino:renesas_uno:minima'), []);
  assert.deepStrictEqual(PC.check('void setup(){ analogWrite(7, 1); }', ''), []);
});
t('pin check: Uno, Mega, Leonardo, Nano Every, Pico tables', () => {
  const one = (code, f) => PC.check(code, f).map((x) => x.message);
  assert.strictEqual(one('void f(){ analogWrite(44, 1); analogWrite(13, 1); pinMode(A15, INPUT); analogRead(A15); analogRead(69); }', 'arduino:avr:mega').length, 0);
  assert.strictEqual(one('void f(){ analogWrite(13, 1); analogRead(A11); analogRead(11); pinMode(30, OUTPUT); Serial.begin(9600); digitalWrite(1, 1); }', 'arduino:avr:leonardo').length, 0);
  assert(/no PWM/.test(one('void f(){ analogWrite(11, 9); }', 'arduino:megaavr:nona4809')[0]));
  assert(/doesn't exist/.test(one('void f(){ digitalWrite(20, 1); }', 'arduino:avr:uno')[0]));
  assert(/has no analog input/.test(one('void f(){ analogRead(6); }', 'arduino:avr:uno')[0]));
  assert(/has no analog input/.test(one('void f(){ analogRead(0); }', 'rp2040:rp2040:rpipico')[0]));
  assert.strictEqual(one('void f(){ analogRead(A3); pinMode(LED_BUILTIN, OUTPUT); }', 'rp2040:rp2040:rpipico').length, 0);
});
t('formatter re-indents C++ without touching strings or comments, and is idempotent', () => {
  const src = 'void setup() {\nSerial.begin(9600);\n      if (x)\n  doIt();\nconst char* s = "{";\n  switch (m) {\n  case 1:\n  a();\n  break;\n  }\n}\n';
  const out = FMT.format(src, 'cpp', { tabSize: 2 });
  assert.strictEqual(out, 'void setup() {\n  Serial.begin(9600);\n  if (x)\n    doIt();\n  const char* s = "{";\n  switch (m) {\n    case 1:\n      a();\n      break;\n  }\n}\n');
  assert.strictEqual(FMT.format(out, 'cpp', { tabSize: 2 }), out);
  assert.strictEqual(FMT.format('x = 1   \n\n\n', 'python'), 'x = 1\n');
  assert.strictEqual(FMT.format('#if A\nint a;\n#endif\n', 'cpp'), '#if A\nint a;\n#endif\n');
});
t('calculators: E-series, LED resistor, colour code, divider, RC, Ohm, battery, ADC', () => {
  assert.strictEqual(CALC.nearest(4500, 'E12'), 4700);
  assert.strictEqual(CALC.nearest(151, 'E24', 'up'), 160);
  const led = CALC.ledResistor(5, 2, 20);
  assert.strictEqual(led.r, 150);
  assert.deepStrictEqual(CALC.colorCode(4700).bands, ['yellow', 'violet', 'red', 'gold']);
  assert.deepStrictEqual(CALC.colorCode(10).bands, ['brown', 'black', 'black', 'gold']);
  assert.strictEqual(CALC.fromColors(['brown', 'black', 'black', 'red', 'brown']).ohms, 10000);
  const dv = CALC.solveDivider(5, 3.3);
  assert(dv.errorPct < 1, 'divider error ' + dv.errorPct);
  assert(Math.abs(CALC.rc(10000, 1e-6).fc - 15.9155) < 1e-3);
  assert(Math.abs(CALC.ohm({ v: 5, r: 250 }).i - 0.02) < 1e-12);
  assert(Math.abs(CALC.batteryLife({ mAh: 1000, activemA: 10, derate: 1 }).hours - 100) < 1e-9);
  assert.strictEqual(CALC.adc({ bits: 10, vref: 5, volts: 5 }).counts, 1023);
  assert.strictEqual(CALC.eng(4700, 'Ω'), '4.7kΩ');
});
t('snippets: C++ and MicroPython/CircuitPython sets are well formed', () => {
  const A = require('../renderer/arduino-api.js');
  assert(A.SNIPPETS.length >= 12 && A.PY_SNIPPETS.length >= 12);
  for (const [label, body] of [...A.SNIPPETS, ...A.PY_SNIPPETS]) assert(label && body && !/undefined/.test(body), label);
});
t('PIR, optocoupler and buck converter behave', () => {
  const pir = (motion) => sim.solve(circ([{ uid: 1, type: 'pir', closed: motion }, { uid: 2, type: 'voltmeter' }],
    [{ from: 'board:1', to: 'part:1:vcc' }, { from: 'part:1:gnd', to: 'board:2' },
     { from: 'part:1:out', to: 'part:2:pos' }, { from: 'part:2:neg', to: 'board:2' }])).partState[2].reading.value;
  assert(Math.abs(pir(true) - 3.3) < 0.05 && Math.abs(pir(false)) < 0.05);
  const buck = sim.solve(circ([{ uid: 1, type: 'psu', volts: 12 }, { uid: 2, type: 'buck', vout: 3.3 }, { uid: 3, type: 'voltmeter' }],
    [{ from: 'part:1:pos', to: 'part:2:in' }, { from: 'part:1:neg', to: 'part:2:gnd' },
     { from: 'part:2:out', to: 'part:3:pos' }, { from: 'part:3:neg', to: 'part:2:gnd' }]));
  assert(Math.abs(buck.partState[3].reading.value - 3.3) < 0.05, 'buck ' + buck.partState[3].reading.value);
  const opto = (on) => sim.solve(circ([{ uid: 1, type: 'resistor', r: 330 }, { uid: 2, type: 'pc817' }, { uid: 3, type: 'resistor', r: 10000 }, { uid: 4, type: 'voltmeter' }],
    [...(on ? [{ from: 'board:1', to: 'part:1:a' }] : []), { from: 'part:1:b', to: 'part:2:anode' }, { from: 'part:2:cathode', to: 'board:2' },
     { from: 'board:1', to: 'part:3:a' }, { from: 'part:3:b', to: 'part:2:col' }, { from: 'part:2:emi', to: 'board:2' },
     { from: 'part:2:col', to: 'part:4:pos' }, { from: 'part:4:neg', to: 'board:2' }])).partState[4].reading.value;
  assert(opto(true) < 0.2 && opto(false) > 4.9, 'opto ' + opto(true) + ' / ' + opto(false));
  for (const type of ['pir', 'pc817', 'buck']) {
    assert(kb.PARTS.some((p) => p.type === type), type + ' in palette');
    assert(kb.PART_INFO[type] && kb.PART_INFO[type].how, type + ' info');
    assert(kb.HOOKUPS[type], type + ' hookup');
  }
});

t('LM317, IR receiver and soil sensor behave; parts complete', () => {
  const meter = (parts, wires) => sim.solve(circ(parts, wires)).partState;
  const lm = meter([{ uid: 1, type: 'psu', volts: 12 }, { uid: 2, type: 'lm317', vout: 3.3 }, { uid: 3, type: 'voltmeter' }],
    [{ from: 'part:1:pos', to: 'part:2:in' }, { from: 'part:1:neg', to: 'part:2:gnd' }, { from: 'part:2:out', to: 'part:3:pos' }, { from: 'part:3:neg', to: 'part:2:gnd' }]);
  assert(Math.abs(lm[3].reading.value - 3.3) < 0.05, 'lm317 ' + lm[3].reading.value);
  const lmLow = meter([{ uid: 1, type: 'psu', volts: 6 }, { uid: 2, type: 'lm317', vout: 5 }, { uid: 3, type: 'voltmeter' }],
    [{ from: 'part:1:pos', to: 'part:2:in' }, { from: 'part:1:neg', to: 'part:2:gnd' }, { from: 'part:2:out', to: 'part:3:pos' }, { from: 'part:3:neg', to: 'part:2:gnd' }]);
  assert(lmLow[3].reading.value < 1, 'dropout: no regulation at 6V in for 5V out');
  const ir = (on) => meter([{ uid: 1, type: 'irrecv', closed: on }, { uid: 2, type: 'voltmeter' }],
    [{ from: 'board:1', to: 'part:1:vcc' }, { from: 'part:1:gnd', to: 'board:2' }, { from: 'part:1:out', to: 'part:2:pos' }, { from: 'part:2:neg', to: 'board:2' }])[2].reading.value;
  assert(ir(false) > 4.9 && ir(true) < 0.1, 'ir ' + ir(false) + ' / ' + ir(true));
  const soil = (m) => meter([{ uid: 1, type: 'soil', moisture: m }, { uid: 2, type: 'voltmeter' }],
    [{ from: 'board:1', to: 'part:1:vcc' }, { from: 'part:1:gnd', to: 'board:2' }, { from: 'part:1:out', to: 'part:2:pos' }, { from: 'part:2:neg', to: 'board:2' }])[2].reading.value;
  assert(soil(0) > soil(100) && Math.abs(soil(0) - 2.8) < 0.05 && Math.abs(soil(100) - 1.2) < 0.05);
  for (const type of ['lm317', 'irrecv', 'soil']) {
    assert(kb.PARTS.some((p) => p.type === type) && kb.PART_INFO[type].how && kb.HOOKUPS[type], type);
  }
  assert.strictEqual(kb.classify('Capacitive Soil Moisture Sensor').type, 'soil');
  assert.strictEqual(kb.classify('PIR (motion) sensor').type, 'pir');
});
t('calculators v2: 555, capacitor code, AVR baud, regulator heat, pack, parseEng', () => {
  assert(Math.abs(CALC.timer555(1000, 10000, 1e-5).freq - 6.87) < 0.01);
  assert.strictEqual(CALC.capCode('104').pf, 100000);
  assert.strictEqual(CALC.capCode('4R7').pf, 4.7);
  assert.strictEqual(CALC.capToCode(4.7e-9), '472');
  const b = CALC.avrBaud(16e6, 9600).normal;
  assert.strictEqual(b.ubrr, 103);
  assert(Math.abs(b.errorPct - 0.16) < 0.01);
  assert(Math.abs(CALC.avrBaud(16e6, 115200).u2x.errorPct - 2.12) < 0.01);
  assert.strictEqual(CALC.regulatorHeat(12, 5, 500).watts, 3.5);
  assert.strictEqual(CALC.batteryPack(3.7, 2500, 3, 2).mAh, 5000);
  assert.deepStrictEqual(['4k7', '100n', '1M', '20m', '2R2'].map(CALC.parseEng).map((x) => Number(x.toPrecision(6))), [4700, 1e-7, 1e6, 0.02, 2.2]);
});
t('MicroPython clock script uses Monday = 0 weekdays for both firmwares', () => {
  const upy2 = require('../main/upy');
  const s = upy2.clockScript(new Date(2026, 10, 22, 9, 5, 7));   // a Sunday
  assert(/machine\.RTC\(\)\.datetime\(\(2026,11,22,6,9,5,7,0\)\)/.test(s), s);
  assert(/time\.struct_time\(\(2026,11,22,9,5,7,6,-1,-1\)\)/.test(s), s);
});

// ---- v0.9 ------------------------------------------------------------------
{
  // main-process modules that touch electron get a stub app (temp folder)
  const Module = require('module');
  const os = require('os');
  const fs = require('fs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-test-'));
  const load = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'electron') return { app: { getPath: () => tmp, getVersion: () => '0.9.0', isPackaged: false }, shell: {}, Notification: function () {} };
    return load.call(this, req, ...rest);
  };
  global.__ecTmp = tmp;
}
const TOOLS = require('../renderer/tools.js');
t('tools: CRC check values over "123456789"', () => {
  const d = TOOLS.parseBytes('123456789');
  assert.strictEqual(TOOLS.crc8(d), 0xF4);
  assert.strictEqual(TOOLS.crc8maxim(d), 0xA1);
  assert.strictEqual(TOOLS.crc16modbus(d), 0x4B37);
  assert.strictEqual(TOOLS.crc16ccitt(d), 0x29B1);
  assert.strictEqual(TOOLS.crc32(d), 0xCBF43926);
  assert.deepStrictEqual(TOOLS.parseBytes('01 a0 FF', 'hex'), [1, 160, 255]);
  assert.strictEqual(TOOLS.parseBytes('abc', 'hex'), null);
});
t('tools: number converter, RGB565, notes, bitmap', () => {
  assert.strictEqual(TOOLS.parseNumber('0xC8'), 200);
  assert.strictEqual(TOOLS.parseNumber('0b1010'), 10);
  assert.strictEqual(TOOLS.parseNumber("'A'"), 65);
  const c = TOOLS.convert(200);
  assert.strictEqual(c.hex, '0xC8');
  assert.strictEqual(c.bin, '0b1100 1000');
  assert(c.fits.includes('uint8_t / byte') && !c.fits.includes('int8_t'));
  assert.strictEqual(TOOLS.convert(-1, 8).hex, '0xFF');
  assert.strictEqual(TOOLS.rgb565(255, 0, 0).hex, '0xF800');
  assert.strictEqual(TOOLS.rgb565(255, 255, 255).value, 0xFFFF);
  assert.deepStrictEqual(TOOLS.from565(0xF800), { r: 255, g: 0, b: 0 });
  assert.strictEqual(TOOLS.noteFreq('A4').rounded, 440);
  assert.strictEqual(TOOLS.noteFreq('C4').rounded, 262);       // pitches.h NOTE_C4
  assert.strictEqual(TOOLS.noteFreq('C#5').rounded, 554);      // NOTE_CS5
  assert.strictEqual(TOOLS.nearestNote(445).label, 'A4');
  // 10×2 image: left pixel black, rest white → MSB-first, rows padded to 2 bytes
  const rgba = new Uint8ClampedArray(10 * 2 * 4).fill(255);
  rgba[0] = rgba[1] = rgba[2] = 0;
  const bm = TOOLS.bitmap(rgba, 10, 2, { threshold: 128 });
  assert.strictEqual(bm.rowBytes, 2);
  assert.strictEqual(bm.bytes.length, 4);
  assert.strictEqual(bm.bytes[0], 0x80);
  assert(/PROGMEM/.test(TOOLS.bitmapToC(bm, 'logo')));
});
t('calculators v3: wire, trace, transistor, zener, timer, servo, stepper, NTC', () => {
  assert(Math.abs(CALC.awg(22).ohmsPerM - 0.05296) < 0.0002);
  assert(Math.abs(CALC.wireDrop(22, 1, 1, 5).drop - 0.1059) < 0.001);      // round trip
  assert(Math.abs(CALC.traceWidth(1, 10, 1).widthMil - 11.8) < 0.3);       // IPC-2221 outer layer
  assert.strictEqual(CALC.baseResistor(5, 100).nearest, 430);
  assert.strictEqual(CALC.zenerResistor(9, 12, 5.1, 10).nearest, 240);    // (9 − 5.1) / 15 mA = 260 Ω → 240 (rounded down)
  const tm = CALC.avrTimer1(16e6, 1).best;
  assert.strictEqual(tm.prescaler, 256);
  assert.strictEqual(tm.ocr, 62499);
  assert.strictEqual(CALC.servo(90).us, 1472);
  assert.strictEqual(CALC.stepper({ stepAngle: 1.8, microsteps: 16, beltPitch: 2, teeth: 20 }).stepsPerMm, 80);
  assert.strictEqual(CALC.stepper({ stepAngle: 1.8, microsteps: 16, lead: 8 }).stepsPerMm, 400);
  assert(Math.abs(CALC.thermistor(10000).c - 25) < 1e-9);
  assert.strictEqual(CALC.thermistorFromAdc(512, 1023, 10000), 10000 * 512 / 511);
  assert(Math.abs(CALC.parallelR([10000, 10000]) - 5000) < 1e-9);
  assert(Math.abs(CALC.seriesC([1e-6, 1e-6]) - 5e-7) < 1e-15);
  assert(Math.abs(CALC.dbFromRatio(10) - 20) < 1e-9);
});
t('new parts: palette, info, hookups and classification', () => {
  for (const type of ['hall', 'tilt', 'solar', 'mq2', 'tp4056', 'vibmotor', 'joystick']) {
    assert(kb.PARTS.some((p) => p.type === type), type + ' in palette');
    assert(kb.PART_INFO[type] && kb.PART_INFO[type].how, type + ' info');
    assert(kb.HOOKUPS[type], type + ' hookup');
  }
  assert.strictEqual(kb.classify('MQ-2 Gas Sensor').type, 'mq2');
  assert.strictEqual(kb.classify('Vibrating Mini Motor Disc').type, 'vibmotor');
  assert.notStrictEqual((kb.classify('Joy FeatherWing') || {}).type, 'joystick');
});
t('ANSI colours are parsed and stripped', () => {
  const U2 = require('../renderer/util.js');
  const segs = U2.parseAnsi('a\x1b[31mred\x1b[0m\x1b[1;92mok');
  assert.deepStrictEqual(segs.map((x) => x.text), ['a', 'red', 'ok']);
  assert(segs[1].fg && segs[2].bold);
  assert.strictEqual(U2.stripAnsi('\x1b[38;5;208mX\x1b[0m'), 'X');
});
t('zip: build → read round trip, deflated and stored', () => {
  const zip = require('../main/zip');
  const big = 'G04 test*\n'.repeat(400);
  const buf = zip.build([{ name: 'a/b.gbr', data: big }, { name: 'x.bin', data: Buffer.from([1, 2, 3]) }]);
  const e = zip.read(buf);
  assert.deepStrictEqual(e.map((x) => x.name), ['a/b.gbr', 'x.bin']);
  assert.strictEqual(e[0].read().toString(), big);
  assert.deepStrictEqual([...e[1].read()], [1, 2, 3]);
  assert(buf.length < big.length);
  assert.strictEqual(zip.crc32(Buffer.from('123456789')), 0xCBF43926);
});
t('local history keeps versions, skips duplicates; hot exit saves and clears', () => {
  const lh = require('../main/localhistory');
  lh.setRoot(global.__ecTmp);
  const f = path.join(global.__ecTmp, 'sketch.ino');
  assert.strictEqual(lh.snapshot(f, 'one'), true);
  assert.strictEqual(lh.snapshot(f, 'one'), false);
  const t0 = Date.now(); while (Date.now() === t0) { /* new ms → new id */ }
  lh.snapshot(f, 'two');
  const list = lh.list(f);
  assert.strictEqual(list.length, 2);
  assert.strictEqual(lh.read(f, list[0].id), 'two');
  lh.hotSave([{ path: f, name: 'sketch.ino', content: 'unsaved' }]);
  assert.strictEqual(lh.hotLoad().buffers[0].content, 'unsaved');
  lh.hotSave([]);
  assert.strictEqual(lh.hotLoad(), null);
});
t('git blame porcelain is parsed', () => {
  const git = require('../main/git');
  const out = 'abcdef1234567890abcdef1234567890abcdef12 1 1 2\nauthor Ana\nauthor-time 1700000000\nsummary first\nfilename a.ino\n\tline one\n' +
    'abcdef1234567890abcdef1234567890abcdef12 2 2\n\tline two\n' +
    '0000000000000000000000000000000000000000 3 3 1\nauthor Not Committed Yet\nauthor-time 1700000100\nsummary Version of a.ino\nfilename a.ino\n\tnew\n';
  const b = git.parseBlame(out);
  assert.strictEqual(b.length, 3);
  assert.strictEqual(b[1].author, 'Ana');
  assert.strictEqual(b[0].short, 'abcdef1');
  assert.strictEqual(b[2].uncommitted, true);
});
t('MicroPython syntax check replies are parsed', () => {
  const upy3 = require('../main/upy');
  assert.deepStrictEqual(upy3.parseSyntax('SYNTAX-OK'), { ok: true });
  assert.deepStrictEqual(upy3.parseSyntax('SYNTAX-ERR 7 invalid syntax'), { ok: false, line: 7, message: 'invalid syntax' });
  assert.strictEqual(upy3.parseSyntax('SYNTAX-NA').unchecked, true);
});
t('build flags and defines become compiler.*.extra_flags', () => {
  const ard = require('../main/arduino');
  assert.deepStrictEqual(ard.buildProperties('', []), []);
  const bp = ard.buildProperties('-O2', [{ name: 'DEBUG', value: '' }, { name: 'BAUD', value: '115200' }, { name: 'bad name', value: 1 }]);
  assert.deepStrictEqual(bp, ['compiler.c.extra_flags=-O2 -DDEBUG -DBAUD=115200', 'compiler.cpp.extra_flags=-O2 -DDEBUG -DBAUD=115200']);
});
t('board manager URLs: extra http(s) URLs are merged, junk is ignored', () => {
  const cu = require('../main/coreurls');
  const y = cu.ensureUrlsInYaml('', ['https://example.com/package_x_index.json', 'file:///etc/passwd', 'not a url']).text;
  assert(y.includes('https://example.com/package_x_index.json'));
  assert(!y.includes('passwd') && !y.includes('not a url'));
});
const PCB = require('../renderer/pcb.js');
function pcbFixture() {
  const B = global.window.PINODE_BOARDS;
  const idx = (lab) => B.nano.pins.findIndex((p) => p.label === lab);
  const model = { parts: [{ uid: 1, type: 'resistor', r: 220 }, { uid: 2, type: 'led', color: 'red' }, { uid: 3, type: 'button' }],
    wires: [{ from: 'board:' + idx('D13'), to: 'part:1:a' }, { from: 'part:1:b', to: 'part:2:anode' }, { from: 'part:2:cathode', to: 'board:' + idx('GND') },
            { from: 'board:' + idx('2'), to: 'part:3:a' }, { from: 'part:3:b', to: 'board:16' }] };
  return PCB.netlist(model, B.nano, 'nano', kb.PARTS);
}
t('PCB netlist: Nano plugs in with real pin numbers, nets named', () => {
  const net = pcbFixture();
  const refs = net.comps.map((c) => c.ref).sort();
  assert.deepStrictEqual(refs, ['A1', 'D1', 'R1', 'SW1']);
  const gnd = net.nets.find((n) => n.name === 'GND');
  assert(gnd, 'GND net');
  // both Nano GND pads (4 and 29) and the LED cathode and button are on it
  const a1 = gnd.nodes.filter((n) => n.ref === 'A1').map((n) => n.pad).sort();
  assert(a1.includes('4') || a1.includes('29'));
  const d13 = net.nets.find((n) => n.nodes.some((x) => x.ref === 'A1' && x.pad === '16'));
  assert(d13 && d13.nodes.some((x) => x.ref === 'R1'), 'D13 is Nano pin 16 and goes to R1');
  const led = net.comps.find((c) => c.ref === 'D1');
  assert.strictEqual(led.pads.find((p) => p.key.endsWith(':cathode')).pad, '1');   // LED_5mm pad 1 = cathode
});
t('PCB: auto-place, DRC finds unrouted nets and shorts, Gerbers read back', () => {
  const net = pcbFixture();
  const place = PCB.autoPlace(net, {});
  const layout = { board: PCB.fitBoard(net, place), place, traces: [], vias: [], holes: [], texts: [] };
  let issues = PCB.drc(layout, net);
  assert(issues.some((x) => x.severity === 'error' && /not routed/i.test(x.message)), 'unrouted nets reported');
  // a trace straight across the board touches pads of different nets
  const r1 = PCB.padsWorld(net.comps.find((c) => c.ref === 'R1'), place.R1);
  const d1 = PCB.padsWorld(net.comps.find((c) => c.ref === 'D1'), place.D1);
  // R1 pad 1 (D13 net) straight to the LED cathode (GND): a short
  layout.traces.push({ layer: 'F', w: 0.5, pts: [[r1[0].x, r1[0].y], [d1[0].x, d1[0].y]] });
  issues = PCB.drc(layout, net);
  assert(issues.some((x) => x.severity === 'error' && /short|clearance|touch/i.test(x.message)), 'crossing trace reported: ' + issues.map((x) => x.message).join(' | '));
  // a proper trace instead: R1 pad 2 → LED anode, the same net
  const anode = d1.find((p) => p.num === '2' || p.pad === '2' || p.n === '2') || d1[1];
  layout.traces = [{ layer: 'F', w: 0.5, pts: [[r1[1].x, r1[1].y], [anode.x, anode.y]] }];
  const files = PCB.fabFiles(layout, net, { name: 'demo', version: '0.9.0' });
  for (const n of ['demo-F_Cu.gtl', 'demo-B_Cu.gbl', 'demo-F_Mask.gts', 'demo-B_Mask.gbs', 'demo-F_Silkscreen.gto', 'demo-Edge_Cuts.gm1', 'demo-PTH.drl']) assert(files[n], n);
  const top = PCB.parseGerber(files['demo-F_Cu.gtl']);
  assert(top.prims.some((p) => p.k === 'flash') && top.prims.some((p) => p.k === 'line'));
  assert.strictEqual(PCB.layerOf('demo-F_Cu.gtl', files['demo-F_Cu.gtl']), 'top-copper');
  const chk = PCB.checkGerbers(Object.entries(files).map(([name, text]) => ({ name, text })));
  assert(chk.ok, chk.problems.join('; '));
  assert.strictEqual(chk.layers, 2);
  assert(Math.abs(chk.size.w - layout.board.w) < 0.01 && Math.abs(chk.size.h - layout.board.h) < 0.01);
  const pads = net.comps.reduce((a, c) => a + c.pads.length, 0);
  const drl = PCB.parseExcellon(files['demo-PTH.drl']);
  assert(drl.holes.length >= pads - 4, 'every THT pad drilled');
  assert(drl.holes.every((h) => h.d >= 0.3));
  const missing = PCB.checkGerbers([{ name: 'x.gtl', text: files['demo-F_Cu.gtl'] }]);
  assert(!missing.ok && missing.problems.some((p) => /outline/.test(p)));
});
t('PCB: corner holes clear the parts; a hole on a pad is an error', () => {
  const net = pcbFixture();
  const place = PCB.autoPlace(net, {}, { margin: 7.62 });
  const board = PCB.fitBoard(net, place, 7.62);
  const m = 3.5;
  const holes = [[m, m], [board.w - m, m], [m, board.h - m], [board.w - m, board.h - m]].map(([x, y]) => ({ x, y, d: 3.2 }));
  const ok = PCB.drc({ board, place, traces: [], vias: [], holes, texts: [] }, net);
  assert(!ok.some((x) => /Mounting hole/.test(x.message)), ok.map((x) => x.message).join(' | '));
  const pad = PCB.padsWorld(net.comps.find((c) => c.ref === 'R1'), place.R1)[0];
  const bad = PCB.drc({ board, place, traces: [], vias: [], holes: [{ x: pad.x, y: pad.y, d: 3.2 }], texts: [] }, net);
  assert(bad.some((x) => x.severity === 'error' && /cuts into/.test(x.message)));
});
t('PCB: per-part pad and hole sizes reach the copper and the drill file', () => {
  const net = pcbFixture();
  const place = PCB.autoPlace(net, {});
  const r1 = net.comps.find((c) => c.ref === 'R1');
  assert.strictEqual(PCB.padsWorld(r1, place.R1)[0].drill, 0.8);
  place.R1.pad = { dia: 2.0, drill: 1.0 };
  const pads = PCB.padsWorld(r1, place.R1);
  assert(pads.every((p) => p.drill === 1.0 && Math.min(p.w, p.h) === 2.0));
  const layout = { board: PCB.fitBoard(net, place), place, traces: [], vias: [], holes: [{ x: 3, y: 3, d: 2.7 }], texts: [] };
  const files = PCB.fabFiles(layout, net, { name: 'x' });
  const pth = PCB.parseExcellon(files['x-PTH.drl']).holes.filter((h) => Math.abs(h.d - 1.0) < 1e-6);
  assert.strictEqual(pth.length, 2);
  assert(PCB.parseExcellon(files['x-NPTH.drl']).holes.some((h) => Math.abs(h.d - 2.7) < 1e-6));
  // a pad smaller than its hole leaves no ring: the rule check catches it
  place.R1.pad = { dia: 1.0, drill: 0.95 };
  assert(PCB.drc(layout, net).some((x) => /annular/.test(x.message)));
});
t('PCB: BOM never guesses part numbers; CPL and KiCad netlist', () => {
  const net = pcbFixture();
  const bom = PCB.bomCsv(net, 'jlcpcb');
  assert(/Part #/.test(bom.split('\r\n')[0]));
  assert(!/C\d{4,}/.test(bom.split('\r\n').slice(1).join('\n')), 'no LCSC numbers invented');
  const place = PCB.autoPlace(net, {});
  const cpl = PCB.cplCsv({ board: PCB.fitBoard(net, place), place }, net, 'jlcpcb');
  assert(/Designator/.test(cpl) && /R1/.test(cpl));
  const kn = PCB.kicadNetlist(net, 'demo');
  assert(/\(export \(version "?E"?\)/.test(kn) && /Resistor_THT/.test(kn));
});

t('PCB layers: a 4-layer board with a GND plane joins GND pads and writes every layer', () => {
  const net = pcbFixture();
  const place = PCB.autoPlace(net, {}, { margin: 7.62 });
  const layout = { board: PCB.fitBoard(net, place, 7.62), place, traces: [], vias: [], holes: [{ x: 3.5, y: 3.5, d: 3.2 }], texts: [] };
  const gndOpen = PCB.ratsnest(layout, net).filter((r) => r.net === 'GND').length;
  assert(gndOpen > 0, 'GND needs routing on 2 layers');
  layout.stack = { count: 4, planes: { In1: 'GND', In2: '' } };
  assert.deepStrictEqual(PCB.copperLayers(layout), ['F', 'In1', 'In2', 'B']);
  assert.strictEqual(PCB.ratsnest(layout, net).filter((r) => r.net === 'GND').length, 0, 'the plane joins GND');
  assert(PCB.ratsnest(layout, net).some((r) => r.net !== 'GND'), 'other nets still need traces');
  const files = PCB.fabFiles(layout, net, { name: 'x' });
  for (const n of ['x-F_Cu.gtl', 'x-In1_Cu.g1', 'x-In2_Cu.g2', 'x-B_Cu.gbl', 'x-stackup.txt']) assert(files[n], n);
  assert(/FileFunction,Copper,L2,Inr,Plane/.test(files['x-In1_Cu.g1']));
  assert(/FileFunction,Copper,L3,Inr,Signal/.test(files['x-In2_Cu.g2']));
  assert(/FileFunction,Copper,L4,Bot/.test(files['x-B_Cu.gbl']));
  assert(/G36\*/.test(files['x-In1_Cu.g1']) && /%LPC\*%/.test(files['x-In1_Cu.g1']), 'plane is a region with clearances cut out');
  assert(/Plated,1,4,PTH/.test(files['x-PTH.drl']));
  assert(/L2 +x-In1_Cu\.g1 +Inner 1 \(GND plane\)/.test(files['x-stackup.txt']));
  const parsed = PCB.parseGerber(files['x-In1_Cu.g1']);
  assert(parsed.prims.some((p) => p.k === 'poly'), 'reader sees the plane region');
  const chk = PCB.checkGerbers(Object.entries(files).map(([name, text]) => ({ name, text })));
  assert(chk.ok, chk.problems.join('; '));
  assert.strictEqual(chk.layers, 4);
  assert(!PCB.drc(layout, net).some((x) => /plane/.test(x.message) && x.severity === 'error'));
});
t('PCB layers: a copper pour joins its net, keeps clear of others, and flags trouble', () => {
  const net = pcbFixture();
  const place = PCB.autoPlace(net, {});
  const B = PCB.fitBoard(net, place);
  const layout = { board: B, place, traces: [], vias: [], holes: [], texts: [],
    pours: [{ layer: 'B', net: 'GND', pts: [[0, 0], [B.w, 0], [B.w, B.h], [0, B.h]] }] };
  assert.strictEqual(PCB.ratsnest(layout, net).filter((r) => r.net === 'GND').length, 0);
  const A = PCB.analyze(layout, net);
  const z = A.zones[0];
  assert(z.ops.spokes.length >= 8, 'thermal spokes on the GND pads');
  assert(z.ops.clear.length > 0, 'other-net pads are cut out');
  // the fill never touches another net's pad
  const other = A.items.find((it) => it.kind === 'pad' && it.net && it.net !== 'GND');
  const F = z.fill, p = other.pad;
  assert.strictEqual(F.grid[Math.floor(p.y / F.res) * F.nx + Math.floor(p.x / F.res)], 0);
  assert(/G36\*/.test(PCB.fabFiles(layout, net, { name: 'x' })['x-B_Cu.gbl']));
  // a pour on a layer the board lacks, one with no net, and two nets overlapping
  layout.pours.push({ layer: 'In1', net: 'GND', pts: [[1, 1], [5, 1], [5, 5]] });
  layout.pours.push({ layer: 'F', net: '', pts: [[1, 1], [5, 1], [5, 5]] });
  const vccNet = net.nets.find((n) => n.name !== 'GND').name;
  layout.pours.push({ layer: 'B', net: vccNet, pts: [[1, 1], [8, 1], [8, 8], [1, 8]] });
  const d = PCB.drc(layout, net);
  assert(d.some((x) => x.severity === 'error' && /no such layer/.test(x.message)));
  assert(d.some((x) => /has no net yet/.test(x.message)));
  assert(d.some((x) => x.severity === 'error' && /overlap or come too close/.test(x.message)));
});
t('PCB layers: 1-layer boards use bottom copper; vias and top SMD are flagged', () => {
  const net = pcbFixture();
  const place = PCB.autoPlace(net, {});
  const layout = { board: PCB.fitBoard(net, place), place, traces: [{ layer: 'F', w: 0.4, pts: [[5, 5], [6, 5]], net: '' }], vias: [{ x: 5, y: 5, drill: 0.4, dia: 0.8 }], holes: [], texts: [], stack: { count: 1 } };
  assert.deepStrictEqual(PCB.copperLayers(layout), ['B']);
  const d = PCB.drc(layout, net);
  assert(d.some((x) => /1-layer board: there is no other layer/.test(x.message)));
  assert(d.some((x) => /Top copper, which a 1-layer board/.test(x.message)));
  layout.traces = []; layout.vias = [];
  const files = PCB.fabFiles(layout, net, { name: 'x' });
  assert(!files['x-F_Cu.gtl'] && !files['x-F_Mask.gts'] && files['x-B_Cu.gbl']);
  assert(/FileFunction,Copper,L1,Bot/.test(files['x-B_Cu.gbl']));
  assert(!files['x-PTH.drl'] && /NonPlated,1,1,NPTH/.test(files['x-NPTH.drl']));
  const chk = PCB.checkGerbers(Object.entries(files).map(([name, text]) => ({ name, text })));
  assert(chk.ok, chk.problems.join('; '));
  assert.strictEqual(chk.layers, 1);
  assert.strictEqual(PCB.layerOf('a.gbl', files['x-B_Cu.gbl']), 'bottom-copper');
});

// ---- 0.9.3 real parts: catalogue → canvas → PCB -------------------------------
const PLIB = require('../renderer/partlib.js');
const PDB = require('../main/partsdb.js');
PDB.setDir(require('path').join(require('os').tmpdir(), 'ec-test-parts-' + process.pid));
t('parts: catalogue numbers parse into real units', () => {
  assert.strictEqual(PLIB.siNum('4.7kΩ', 'Ω'), 4700);
  assert.strictEqual(PLIB.siNum('100nF', 'F'), 1e-7);
  assert.strictEqual(PLIB.siNum('100mW', 'W'), 0.1);
  const s = PLIB.parseSpecs([{ name: 'Voltage - Supply', value: '4.5V~16V' }, { name: 'Operating Temperature', value: '-40℃~+85℃' }, { name: 'Voltage - Forward(Vf)', value: '2.1V' }], '');
  assert.deepStrictEqual(s.supply, { min: 4.5, max: 16 });
  assert.deepStrictEqual(s.temp, { min: -40, max: 85 });
  assert.strictEqual(s.vf, 2.1);
});
t('parts: KiCad pinouts come from the symbol, never guessed', () => {
  const K = PDB.kicad();
  const ne = PLIB.matchSymbol('NE555DR', 'SOIC-8', K.symbols);
  assert.strictEqual(ne.sym.n, 'NE555D'); assert.strictEqual(ne.how, 'prefix');
  assert.strictEqual(PLIB.matchSymbol('STM32F103C8T6', 'LQFP-48(7x7)', K.symbols).sym.n, 'STM32F103C8Tx');
  assert.strictEqual(PLIB.matchSymbol('LM7805', 'TO-220', K.symbols).sym.n, 'LM7805_TO220');
  // a symbol whose own footprint is another package is not used
  assert.strictEqual(PLIB.matchSymbol('ATMEGA328P-AU', 'DIP-28', K.symbols), null);
  assert.strictEqual(PLIB.matchSymbol('XYZ-NOT-A-PART-123', 'SOIC-8', K.symbols), null);
});
t('parts: footprints by package, KiCad names', () => {
  const ids = PDB.kicad().ids;
  assert.strictEqual(PLIB.footprintFor('0603', 'resistor', ids).id, 'Resistor_SMD:R_0603_1608Metric');
  assert.strictEqual(PLIB.footprintFor('0805', 'led', ids).id, 'LED_SMD:LED_0805_2012Metric');
  assert.strictEqual(PLIB.footprintFor('SOP-16', 'ic', ids).id, 'Package_SO:SOIC-16_3.9x9.9mm_P1.27mm');
  assert.strictEqual(PLIB.footprintFor('LQFP-48(7x7)', 'ic', ids).id, 'Package_QFP:LQFP-48_7x7mm_P0.5mm');
  assert.strictEqual(PLIB.footprintFor('SMD,3.2x1.3mm', 'led', ids), null);   // unknown: the user picks
});
t('parts: an LDO from the catalogue is simulated and lands on its real pads', () => {
  const b = PDB.build({ lcsc: 'C6186', mfr: 'AMS1117-3.3', pkg: 'SOT-223', category: 'Power Management / Linear Voltage Regulators (LDO)',
    params: [{ name: 'Output Voltage', value: '3.3V' }, { name: 'Maximum Input Voltage', value: '15V' }, { name: 'Dropout Voltage', value: '1.3V@(1A)' }] });
  const p = b.part;
  assert.strictEqual(p.type, 'linreg'); assert.strictEqual(p.vout, 3.3); assert.strictEqual(p.dropout, 1.3);
  assert.deepStrictEqual(p.lib.pads, { in: '3', gnd: '1', out: '2' });   // AMS1117: 1 GND, 2 VO, 3 VI
  assert.strictEqual(p.lib.fp, 'Package_TO_SOT_SMD:SOT-223-3_TabPin2');
  // sim: 5V in → 3.3V out
  const model = { parts: [{ uid: 1, type: 'psu', volts: 5 }, { uid: 2, ...p }, { uid: 3, type: 'resistor', r: 330 }],
    wires: [{ from: 'part:1:pos', to: 'part:2:in' }, { from: 'part:1:neg', to: 'part:2:gnd' }, { from: 'part:2:out', to: 'part:3:a' }, { from: 'part:3:b', to: 'part:1:neg' }] };
  const r = sim.solve(circ(model.parts, model.wires));
  const vout = r.netVolts[r.netOf.get('part:2:out')] - r.netVolts[r.netOf.get('part:2:gnd')];
  assert(Math.abs(vout - 3.3) < 0.05, 'vout ' + vout);
  // PCB + BOM carry the real footprint and the LCSC number
  const net = PCB.netlist(model, null, null, kb.PARTS);
  const u = net.comps.find((c) => c.uid === 2);
  assert.strictEqual(u.fp, 'K:Package_TO_SOT_SMD:SOT-223-3_TabPin2');
  assert.strictEqual(u.ref, 'U1');
  assert.deepStrictEqual(u.pads.map((x) => x.pad).sort(), ['1', '2', '3']);
  assert(PCB.footprint(u.fp).smd);
  assert(/"AMS1117-3.3","U1","SOT-223-3_TabPin2",C6186/.test(PCB.bomCsv(net, 'jlcpcb')));
  const plain = net.comps.find((c) => c.uid === 3);
  assert(new RegExp('"' + plain.value + '","R1",[^\\r]*,\\r').test(PCB.bomCsv(net, 'jlcpcb')), 'built-in parts have no guessed C-number');
});
t('parts: two-terminal polarity follows KiCad (pad 1 = cathode / +)', () => {
  const led = PDB.build({ lcsc: 'C1', mfr: 'X', pkg: '0805', category: 'Optoelectronics / LED Indication - Discrete', desc: 'Red 0805 LED', params: [{ name: 'Voltage - Forward(Vf)', value: '2.1V' }] }).part;
  assert.strictEqual(led.type, 'led'); assert.deepStrictEqual(led.lib.pads, { cathode: '1', anode: '2' }); assert.strictEqual(led.vf, 2.1);
  const cap = PDB.build({ lcsc: 'C2', mfr: 'Y', pkg: '1206', category: 'Capacitors / Tantalum Capacitors', params: [{ name: 'Voltage Rating', value: '16V' }] }).part;
  assert.strictEqual(cap.type, 'capE'); assert.deepStrictEqual(cap.lib.pads, { pos: '1', neg: '2' }); assert.strictEqual(cap.vr, 16);
});
t('parts: resistor values search the full catalogue table in ohms', () => {
  assert(/resistance=10000&package=0603$/.test(PDB.smartQuery('10k 0603')));
  assert(/resistance=4700$/.test(PDB.smartQuery('4k7')));
  assert.strictEqual(PDB.smartQuery('NE555'), null);
  assert.strictEqual(PDB.smartQuery('100nF 0402'), null);
});

// ---- 0.9.4 boards to scale ---------------------------------------------------
t('boards: pin order is unchanged for saved projects (new pins only appended)', () => {
  const B = global.window.PINODE_BOARDS;
  const OLD = {"uno":"19,18,-,gnd,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-,-,v33,v5,gnd,gnd,vin,14,15,16,17,18,19","nano":"1,0,-,gnd,2,3,4,5,6,7,8,9,10,11,12,vin,gnd,-,v5,-,-,19,18,17,16,15,14,v33,13","leonardo":"3,2,-,gnd,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-,-,v33,v5,gnd,gnd,vin,18,19,20,21,22,23","nanoevery":"1,0,-,gnd,2,3,4,5,6,7,8,9,10,11,12,vin,gnd,-,v5,21,20,19,18,17,16,15,14,v33,13","mega":"21,20,-,gnd,13,12,11,10,9,8,7,6,5,4,3,2,1,0,14,15,16,17,18,19,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,-,-,v33,v5,gnd,gnd,vin,54,55,56,57,58,59,60,61,62,63,-,-,-,-,-,-"};
  for (const [id, seq] of Object.entries(OLD)) {
    const now = B[id].pins.map((p) => (p.tele == null ? (p.power || '-') : p.tele)).slice(0, seq.split(',').length).join(',');
    assert.strictEqual(now, seq, id);
  }
});
t('boards: Arduino headers sit on the CAD grid, in the right places', () => {
  const B = global.window.PINODE_BOARDS;
  const at = (id, label, n = 0) => B[id].pins.filter((p) => p.label === label)[n].at;
  // Uno R3: D0 at the right end of the top header, A5 at the right of the bottom one
  assert.deepStrictEqual(at('uno', 'RX0'), [63.5, 50.8]); assert.deepStrictEqual(at('uno', 'A5'), [63.5, 2.54]);
  assert.deepStrictEqual(at('uno', 'SCL'), [18.796, 50.8]); assert.deepStrictEqual(at('uno', 'VIN'), [45.72, 2.54]);
  // Mega: even pins on the inner column, 22 at the top, 53 at the bottom, 20/21 on the comms header too
  assert.deepStrictEqual(at('mega', '22'), [93.98, 48.26]); assert.deepStrictEqual(at('mega', '23'), [96.52, 48.26]);
  assert.deepStrictEqual(at('mega', '53'), [96.52, 10.16]); assert.deepStrictEqual(at('mega', 'A15'), [91.44, 2.54]);
  assert.deepStrictEqual(at('mega', 'SDA', 1), [83.82, 50.8]); assert.strictEqual(B.mega.pins.filter((p) => p.label === 'MISO')[0].tele, 50);
  // Nano: D12 and D13 at the USB end (x small), TX1 and VIN at the far end, on opposite rows
  assert.deepStrictEqual(at('nano', '12'), [3.81, 16.51]); assert.deepStrictEqual(at('nano', 'D13'), [3.81, 1.27]);
  assert.deepStrictEqual(at('nano', 'TX1'), [39.37, 16.51]); assert.deepStrictEqual(at('nano', 'VIN'), [39.37, 1.27]);
  // drawn upright with USB at the top: the digital row is on the right
  const n = B.nano; const usb = n.decor.find((d) => d.kind === 'usb');
  assert(usb.y < n.pins[0].y && n.pins.find((p) => p.label === '12').x > n.pins.find((p) => p.label === 'D13').x);
  // every pad is on the board and no two pads overlap
  for (const id of ['uno', 'mega', 'nano', 'leonardo', 'nanoevery']) {
    const ps = B[id].pins;
    for (const p of ps) assert(p.x > 0 && p.y > 0 && p.x < B[id].w && p.y < B[id].h, id + ' ' + p.label);
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
      const d = Math.hypot(ps[i].at[0] - ps[j].at[0], ps[i].at[1] - ps[j].at[1]);
      assert(d > 2.5, id + ' pads overlap: ' + ps[i].label + ' / ' + ps[j].label);
    }
  }
});
t('boards: revisions follow the FQBN and swap names and parts, not pin order', () => {
  const B = global.window.PINODE_BOARDS, R = global.window.PINODE_BOARD_REVISIONS;
  const pick = (fqbn) => B.uno.revisions.find((r) => r.fqbn.test(fqbn)).id;
  assert.strictEqual(pick('arduino:avr:uno'), 'r3'); assert.strictEqual(pick('arduino:renesas_uno:minima'), 'r4minima');
  assert.strictEqual(pick('arduino:renesas_uno:unor4wifi'), 'r4wifi');
  const m = R.withRevision(B.uno, 'r4minima');
  assert.strictEqual(m.def.pins.length, B.uno.pins.length); assert.strictEqual(m.def.pins[31].label, 'BOOT');
  assert.strictEqual(B.uno.pins[31].label, 'NC'); assert(m.def.decor.some((d) => d.label === 'RA4M1'));
  // every picture named exists, has a licence and a source
  const fs = require('fs');
  for (const def of Object.values(B)) for (const r of def.revisions || []) for (const im of r.images) {
    assert(fs.existsSync(path.join(__dirname, '..', 'renderer', im.src)), im.src);
    assert(/^CC BY-SA [34]\.0$/.test(im.license) && /^https:\/\//.test(im.source) && im.credit, im.id);
  }
});
t('boards: the back view mirrors and rotation keeps the board in view', () => {
  global.window.PinodeBoard = undefined;
  require('../renderer/board.js');
  const V = global.window.PinodeBoard.viewTransform;
  const def = global.window.PINODE_BOARDS.uno;
  const usb = def.decor.find((d) => d.kind === 'usb');
  const front = V(def, 'front', 0), back = V(def, 'back', 0);
  assert(front.pt(usb.x, usb.y)[0] < def.w / 2 && back.pt(usb.x, usb.y)[0] > def.w / 2, 'USB swaps sides when turned over');
  for (const rot of [0, 90, 180, 270]) for (const face of ['front', 'back']) {
    const T = V(def, face, rot);
    for (const p of def.pins) { const [x, y] = T.pt(p.x, p.y); assert(x >= 0 && y >= 0 && x <= T.vw + 1e-6 && y <= T.vh + 1e-6, rot + face); }
  }
  // 90° clockwise: the top header ends up on the right
  const r = V(def, 'front', 90); assert(r.pt(def.pins[0].x, def.pins[0].y)[0] > r.vw / 2);
});

Promise.all(pending).then(() => {
  console.log(failures ? `\n${failures} FAILED` : '\nall tests passed');
  process.exit(failures ? 1 : 0);
});
