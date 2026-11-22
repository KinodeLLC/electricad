// Board definitions for the live view.
//
// The Arduino boards below are drawn to scale from Arduino's own CAD files
// (CC-BY-SA 4.0, docs.arduino.cc): every header pin sits where its pad is on
// the real PCB, in the real order, seen from the top with the USB end on the
// left (the Nanos stand upright, USB at the top). `at` is the pad centre in
// millimetres in that CAD file's frame (origin bottom-left, y up).
//   Uno R3        UNO-TH_Rev3e.brd (A000066)    Mega 2560  MEGA2560_Rev3e.brd (A000067)
//   Leonardo      Leonardo_Rev3d.brd (A000057)  Nano       NanoV3.3.brd (A000005)
//   Nano Every    NANOEveryV4.0 Gerber + placement (ABX00028)
// The UNO R4 boards keep the R3 shield headers (same pads, by design, so
// every shield fits), which is why they share the Uno's pin geometry.
// Chips, connectors and LEDs come from the same files' placement; their
// bodies are drawn as plain outlines.
//
// The other boards are not from manufacturer CAD and are marked `geo:null`
// in the UI as "pin order checked, positions approximate".
//
// digital: index into the telemetry masks. analogIndex: index into a= csv.
// A board def is { id, name, w, h, fqbnMatch, pins: [...], decor: [...] }
// pin: { label, tele, x, y, side, analogIndex?, note?, extra? }  tele=null → power pin
// extra: drawn on the board (ICSP, NC) but not offered as a wiring port.
// Pin ORDER is part of saved projects (wires point at board:<index>), so new
// pins are only ever appended.
const PINODE_REV = {};
window.PINODE_BOARD_REVISIONS = PINODE_REV;
window.PINODE_BOARDS = (() => {
  function header(x, y, dy, defs) {
    return defs.map((d, i) => ({ ...d, x, y: y + i * dy }));
  }

  // ---- to-scale geometry ----------------------------------------------------
  const U = 4;   // drawing units per millimetre
  function mmBoard(def, g) {
    // margin for parts that overhang the edge (USB, jack), or for labels
    // outside the board on the narrow Nanos
    const M = g.margin || 10;
    const P = g.portrait ? (x, y) => [M + y * U, M + x * U] : (x, y) => [M + x * U, M + (g.h - y) * U];
    def.w = 2 * M + (g.portrait ? g.h : g.w) * U;
    def.h = 2 * M + (g.portrait ? g.w : g.h) * U;
    def.unitsPerMm = U;
    def.geo = g;
    def.toUnits = P;
    def.labelsIn = !g.labelsOut;
    def.pad = 6.6;
    if (g.outline) def.outline = g.outline.map(([x, y]) => P(x, y));
    def.holes = (g.holes || []).map(([x, y, d]) => { const [hx, hy] = P(x, y); return { x: hx, y: hy, r: (d / 2) * U }; });
    const W = def.w, H = def.h;
    for (const p of def.pins) {
      if (!p.at) continue;
      [p.x, p.y] = P(p.at[0], p.at[1]);
      if (!p.side) {
        const d = { left: p.x, right: W - p.x, top: p.y, bottom: H - p.y };
        p.side = Object.keys(d).reduce((a, b) => (d[b] < d[a] ? b : a));
      }
    }
    for (const d of def.decor) {
      if (d.at && d.at.length === 4) {
        const [ax, ay] = P(d.at[0], d.at[1]), [bx, by] = P(d.at[2], d.at[3]);
        d.x = Math.min(ax, bx); d.y = Math.min(ay, by); d.w = Math.abs(bx - ax); d.h = Math.abs(by - ay);
      } else if (d.at) [d.x, d.y] = P(d.at[0], d.at[1]);
      if (d.cells) d.points = d.cells.map(([x, y]) => P(x, y));
    }
    return def;
  }
  // a run of header pads, pitch 2.54 mm, from (x, y) stepping by (dx, dy) pitches
  const run = (x, y, dx, dy, list) => list.map((p, i) => ({ ...p, at: [+(x + i * dx * 2.54).toFixed(3), +(y + i * dy * 2.54).toFixed(3)] }));
  // the Uno outline (Arduino shield shape), corners from the CAD outline layer
  const UNO_OUTLINE = [[1, 0], [65.04, 0], [66.04, 1], [66.04, 2.54], [68.58, 5.08], [68.58, 37.846], [66.04, 40.386], [66.04, 51.816], [64.516, 53.34], [1, 53.34], [0, 52.34], [0, 1]];
  const UNO_HOLES = [[66.04, 35.56, 3.2], [66.04, 7.62, 3.2], [15.24, 50.8, 3.2], [13.97, 2.54, 3.2]];
  // shared by Uno, Leonardo and Mega: same USB-B / jack / reset places
  const usbB = { kind: 'usb', at: [-6.3, 32.1, 9.9, 44.1], label: 'USB' };
  const jack = { kind: 'jack', at: [-1.9, 3.9, 12.5, 12.9] };
  const resetBtn = (x, y) => ({ kind: 'button', at: [x - 3.1, y - 3.1, x + 3.1, y + 3.1], label: 'RESET' });
  // ICSP 2×3 next to the main chip; pin 1 MISO. The pins repeat D12/D13/D11
  // (or the board's SPI pins), so they light with them.
  const icsp = (miso, sck, mosi, note) => ([
    { label: 'MISO', tele: miso, extra: true, note: 'ICSP 1 · ' + note[0], at: [63.627, 30.48], labelAt: 'left' },
    { label: '5V', tele: null, power: 'v5', extra: true, note: 'ICSP 2', at: [66.167, 30.48], labelAt: 'right' },
    { label: 'SCK', tele: sck, extra: true, note: 'ICSP 3 · ' + note[1], at: [63.627, 27.94], labelAt: 'left' },
    { label: 'MOSI', tele: mosi, extra: true, note: 'ICSP 4 · ' + note[2], at: [66.167, 27.94], labelAt: 'right' },
    { label: 'RST', tele: null, extra: true, note: 'ICSP 5', at: [63.627, 25.4], labelAt: 'left' },
    { label: 'GND', tele: null, power: 'gnd', extra: true, note: 'ICSP 6', at: [66.167, 25.4], labelAt: 'right' }
  ]);
  // Uno-shaped power header, pads 2..8 (pad 1 is unconnected)
  const unoPower = () => run(30.48, 2.54, 1, 0, [
    { label: 'IOREF', tele: null }, { label: 'RST', tele: null }, { label: '3V3', tele: null, power: 'v33' },
    { label: '5V', tele: null, power: 'v5' }, { label: 'GND', tele: null, power: 'gnd' },
    { label: 'GND', tele: null, power: 'gnd' }, { label: 'VIN', tele: null, power: 'vin' }
  ]);
  const NC = { label: 'NC', tele: null, extra: true, note: 'not connected', at: [27.94, 2.54] };

  // ---- Arduino Uno (R3, R4 Minima, R4 WiFi) ----------------------------------
  const uno = mmBoard({
    id: 'uno', name: 'Arduino Uno', w: 0, h: 0,
    fqbnMatch: /arduino:avr:uno|arduino:renesas_uno:/,   // UNO R4 keeps the R3 numbering
    digitalCount: 23,   // 0–19 on the headers; 21/22 are the R4 Minima's TX/RX LEDs
    pins: [
      // top header, right to left like the silkscreen: SCL SDA AREF GND 13..8
      ...run(18.796, 50.8, 1, 0, [
        { label: 'SCL', tele: 19, note: 'A5/SCL' }, { label: 'SDA', tele: 18, note: 'A4/SDA' },
        { label: 'AREF', tele: null }, { label: 'GND', tele: null, power: 'gnd' },
        { label: '13', tele: 13 }, { label: '12', tele: 12 }, { label: '~11', tele: 11, pwm: true },
        { label: '~10', tele: 10, pwm: true }, { label: '~9', tele: 9, pwm: true }, { label: '8', tele: 8 }
      ]),
      ...run(45.72, 50.8, 1, 0, [
        { label: '7', tele: 7 }, { label: '~6', tele: 6, pwm: true }, { label: '~5', tele: 5, pwm: true },
        { label: '4', tele: 4 }, { label: '~3', tele: 3, pwm: true }, { label: '2', tele: 2 },
        { label: 'TX1', tele: 1 }, { label: 'RX0', tele: 0 }
      ]),
      ...unoPower(),
      ...run(50.8, 2.54, 1, 0, [
        { label: 'A0', tele: 14, analogIndex: 0 }, { label: 'A1', tele: 15, analogIndex: 1 },
        { label: 'A2', tele: 16, analogIndex: 2 }, { label: 'A3', tele: 17, analogIndex: 3 },
        { label: 'A4', tele: 18, analogIndex: 4 }, { label: 'A5', tele: 19, analogIndex: 5 }
      ]),
      NC,
      ...icsp(12, 13, 11, ['D12', 'D13', 'D11'])
    ],
    decor: [
      usbB, jack, resetBtn(6.35, 49.403),
      { kind: 'chip', at: [29.0, 13.0, 63.7, 19.8], label: 'ATMEGA328P' },
      { kind: 'chip', at: [17.4, 32.2, 22.4, 37.1], label: '16U2', small: true },
      { kind: 'led', at: [27.94, 42.164], tele: 13, label: 'L', color: '#ffd94a' },
      { kind: 'led', at: [58.42, 36.576], role: 'power', label: 'ON', color: '#3fd07a' },
      { kind: 'led', at: [27.94, 36.576], role: 'tx', label: 'TX', color: '#ffd94a' },
      { kind: 'led', at: [27.94, 34.29], role: 'rx', label: 'RX', color: '#ffd94a' }
    ]
  }, { w: 68.58, h: 53.34, outline: UNO_OUTLINE, holes: UNO_HOLES, source: 'Arduino UNO R3 CAD (UNO-TH_Rev3e.brd, A000066)' });

  // ---- Arduino Nano (3.x) ----------------------------------------------------
  // Upright, USB at the top. Seen from the top, D12…TX1 run down the right
  // edge and D13…VIN down the left, D12/D13 nearest the USB socket.
  const nano = mmBoard({
    id: 'nano', name: 'Arduino Nano', w: 0, h: 0,
    fqbnMatch: /arduino:avr:nano/,
    digitalCount: 20,
    pins: [
      // pads 1..15 of the digital row (pad 1 = D1/TX, at the far end from USB)
      ...run(39.37, 16.51, -1, 0, [
        { label: 'TX1', tele: 1 }, { label: 'RX0', tele: 0 }, { label: 'RST', tele: null },
        { label: 'GND', tele: null, power: 'gnd' }, { label: '2', tele: 2 }, { label: '~3', tele: 3, pwm: true },
        { label: '4', tele: 4 }, { label: '~5', tele: 5, pwm: true }, { label: '~6', tele: 6, pwm: true },
        { label: '7', tele: 7 }, { label: '8', tele: 8 }, { label: '~9', tele: 9, pwm: true },
        { label: '~10', tele: 10, pwm: true }, { label: '~11', tele: 11, pwm: true }, { label: '12', tele: 12 }
      ]),
      // the other row: VIN at the far end, D13 nearest USB (pad 13 AREF added below)
      ...run(39.37, 1.27, -1, 0, [
        { label: 'VIN', tele: null, power: 'vin' }, { label: 'GND', tele: null, power: 'gnd' },
        { label: 'RST', tele: null }, { label: '5V', tele: null, power: 'v5' },
        { label: 'A7', tele: null, analogIndex: 7 }, { label: 'A6', tele: null, analogIndex: 6 },
        { label: 'A5', tele: 19, analogIndex: 5 }, { label: 'A4', tele: 18, analogIndex: 4 },
        { label: 'A3', tele: 17, analogIndex: 3 }, { label: 'A2', tele: 16, analogIndex: 2 },
        { label: 'A1', tele: 15, analogIndex: 1 }, { label: 'A0', tele: 14, analogIndex: 0 }
      ]),
      { label: '3V3', tele: null, power: 'v33', at: [6.35, 1.27] },
      { label: 'D13', tele: 13, at: [3.81, 1.27] },
      { label: 'AREF', tele: null, at: [8.89, 1.27] },
      // ICSP at the far end (2×3, pin 1 MISO)
      { label: 'MISO', tele: 12, extra: true, note: 'ICSP 1 · D12', at: [41.808, 6.35], labelAt: 'down' },
      { label: '5V', tele: null, power: 'v5', extra: true, note: 'ICSP 2', at: [39.268, 6.35], labelAt: 'up' },
      { label: 'SCK', tele: 13, extra: true, note: 'ICSP 3 · D13', at: [41.808, 8.89], labelAt: 'down' },
      { label: 'MOSI', tele: 11, extra: true, note: 'ICSP 4 · D11', at: [39.268, 8.89], labelAt: 'up' },
      { label: 'RST', tele: null, extra: true, note: 'ICSP 5', at: [41.808, 11.43], labelAt: 'down' },
      { label: 'GND', tele: null, power: 'gnd', extra: true, note: 'ICSP 6', at: [39.268, 11.43], labelAt: 'up' }
    ],
    decor: [
      { kind: 'usb', at: [-1.5, 5.04, 7.7, 12.74], label: 'USB' },
      { kind: 'chip', at: [13.0, 6.3, 18.0, 11.3], label: '328P', rot45: true },
      { kind: 'button', at: [22.8, 9.4, 26.2, 12.4], label: 'RST' },
      { kind: 'led', at: [28.956, 4.318], tele: 13, label: 'L', color: '#ffd94a' },
      { kind: 'led', at: [28.956, 7.366], role: 'power', label: 'PWR', color: '#3fd07a' },
      { kind: 'led', at: [28.956, 13.462], role: 'tx', label: 'TX', color: '#3fd07a' },
      { kind: 'led', at: [28.956, 10.414], role: 'rx', label: 'RX', color: '#ff5c5c' }
    ]
  }, { w: 43.18, h: 17.78, portrait: true, margin: 22, labelsOut: true, holes: [[1.27, 16.51, 1.651], [1.27, 1.27, 1.651], [41.91, 1.27, 1.651], [41.91, 16.51, 1.651]],
    source: 'Arduino Nano 3.x CAD (NanoV3.3.brd, A000005)' });

  // ---- Arduino Leonardo -----------------------------------------------------
  // Uno-shaped, but an ATmega32u4: A0–A5 are digital 18–23, SDA/SCL are D2/D3,
  // PWM on 3 5 6 9 10 11 13, and the TX/RX LEDs show USB traffic. The ICSP
  // pins are the 32u4's only SPI pins: MISO 14, SCK 15, MOSI 16.
  const leonardo = mmBoard({
    id: 'leonardo', name: 'Arduino Leonardo', w: 0, h: 0,
    fqbnMatch: /arduino:avr:leonardo(?::|$)/,
    digitalCount: 31,
    pins: [
      ...run(18.796, 50.8, 1, 0, [
        { label: 'SCL', tele: 3, note: 'D3/SCL' }, { label: 'SDA', tele: 2, note: 'D2/SDA' },
        { label: 'AREF', tele: null }, { label: 'GND', tele: null, power: 'gnd' },
        { label: '13', tele: 13, pwm: true }, { label: '12', tele: 12, note: 'A11' }, { label: '~11', tele: 11, pwm: true },
        { label: '~10', tele: 10, pwm: true, note: 'A10' }, { label: '~9', tele: 9, pwm: true, note: 'A9' }, { label: '8', tele: 8, note: 'A8' }
      ]),
      ...run(45.72, 50.8, 1, 0, [
        { label: '7', tele: 7 }, { label: '~6', tele: 6, pwm: true, note: 'A7' }, { label: '~5', tele: 5, pwm: true },
        { label: '4', tele: 4, note: 'A6' }, { label: '~3', tele: 3, pwm: true, note: 'SCL' }, { label: '2', tele: 2, note: 'SDA' },
        { label: 'TX1', tele: 1 }, { label: 'RX0', tele: 0 }
      ]),
      ...unoPower(),
      ...run(50.8, 2.54, 1, 0, [
        { label: 'A0', tele: 18, analogIndex: 0 }, { label: 'A1', tele: 19, analogIndex: 1 },
        { label: 'A2', tele: 20, analogIndex: 2 }, { label: 'A3', tele: 21, analogIndex: 3 },
        { label: 'A4', tele: 22, analogIndex: 4 }, { label: 'A5', tele: 23, analogIndex: 5 }
      ]),
      NC,
      ...icsp(14, 15, 16, ['D14', 'D15', 'D16'])
    ],
    decor: [
      { kind: 'usb', at: [-1.0, 34.4, 4.6, 41.8], label: 'USB' },
      jack, resetBtn(6.35, 49.403),
      { kind: 'chip', at: [41.99, 11.51, 51.99, 21.51], label: 'ATMEGA32U4' },
      { kind: 'led', at: [4.445, 20.32], tele: 13, label: 'L', color: '#ffd94a' },
      { kind: 'led', at: [4.445, 16.51], role: 'power', label: 'ON', color: '#3fd07a' },
      // TX/RX hang off the 32u4 itself (TXLED = PD5 = D30, RXLED = PB0 = D17,
      // to +5V so LOW = lit); the core pulses them on USB traffic
      { kind: 'led', at: [4.445, 24.13], role: 'tx', tele: 30, invert: true, label: 'TX', color: '#ffd94a' },
      { kind: 'led', at: [4.445, 27.94], role: 'rx', tele: 17, invert: true, label: 'RX', color: '#ffd94a' }
    ]
  }, { w: 68.58, h: 53.34, outline: UNO_OUTLINE, holes: UNO_HOLES, source: 'Arduino Leonardo CAD (Leonardo_Rev3d.brd, A000057)' });

  // ---- Arduino Nano Every ---------------------------------------------------
  // Nano footprint, ATmega4809: A0–A7 are all digital-capable (14–21), PWM on
  // 3 5 6 9 10 only. Labels are plain numbers like its silkscreen. Pads from
  // the top-copper Gerber: same pitch and order as the Nano, rows 15.24 apart.
  const nanoevery = mmBoard({
    id: 'nanoevery', name: 'Arduino Nano Every', w: 0, h: 0,
    fqbnMatch: /arduino:megaavr:nona4809/,
    digitalCount: 22,
    pins: [
      ...run(39.37, 16.51, -1, 0, [
        { label: 'TX1', tele: 1 }, { label: 'RX0', tele: 0 }, { label: 'RST', tele: null },
        { label: 'GND', tele: null, power: 'gnd' }, { label: 'D2', tele: 2 }, { label: 'D3', tele: 3, pwm: true },
        { label: 'D4', tele: 4 }, { label: 'D5', tele: 5, pwm: true }, { label: 'D6', tele: 6, pwm: true },
        { label: 'D7', tele: 7 }, { label: 'D8', tele: 8 }, { label: 'D9', tele: 9, pwm: true },
        { label: 'D10', tele: 10, pwm: true }, { label: 'D11', tele: 11, note: 'MOSI' }, { label: 'D12', tele: 12, note: 'MISO' }
      ]),
      ...run(39.37, 1.27, -1, 0, [
        { label: 'VIN', tele: null, power: 'vin' }, { label: 'GND', tele: null, power: 'gnd' },
        { label: 'RST', tele: null }, { label: '5V', tele: null, power: 'v5' },
        { label: 'A7', tele: 21, analogIndex: 7 }, { label: 'A6', tele: 20, analogIndex: 6 },
        { label: 'A5', tele: 19, analogIndex: 5, note: 'SCL' }, { label: 'A4', tele: 18, analogIndex: 4, note: 'SDA' },
        { label: 'A3', tele: 17, analogIndex: 3 }, { label: 'A2', tele: 16, analogIndex: 2 },
        { label: 'A1', tele: 15, analogIndex: 1 }, { label: 'A0', tele: 14, analogIndex: 0 }
      ]),
      { label: '3V3', tele: null, power: 'v33', at: [6.35, 1.27] },
      { label: 'D13', tele: 13, note: 'SCK', at: [3.81, 1.27] },
      { label: 'AREF', tele: null, at: [8.89, 1.27] }
    ],
    decor: [
      { kind: 'usb', at: [-0.8, 5.1, 4.6, 12.68], label: 'USB' },
      { kind: 'chip', at: [28.22, 5.39, 35.22, 12.39], label: '4809', rot45: true },
      { kind: 'chip', at: [18.55, 7.2, 22.55, 11.2], label: 'SAMD11', small: true },
      { kind: 'button', at: [9.6, 7.4, 12.6, 10.4], label: 'RST' },
      // DL1 on D13/SCK, DL2 on 3V3, DL3/DL4 on the USB chip's RX/TX (schematic)
      { kind: 'led', at: [1.9, 3.1], tele: 13, label: 'L', color: '#ffd94a' },
      { kind: 'led', at: [1.9, 14.7], role: 'power', label: 'ON', color: '#3fd07a' },
      { kind: 'led', at: [24.05, 8.45], role: 'tx', label: 'TX', color: '#ffd94a' },
      { kind: 'led', at: [25.6, 8.45], role: 'rx', label: 'RX', color: '#ffd94a' }
    ]
  }, { w: 43.18, h: 17.78, portrait: true, margin: 22, labelsOut: true, source: 'Arduino Nano Every CAD (NANOEveryV4.0, ABX00028)' });

  // ---- ESP32 DevKit (30-pin) ------------------------------------------------
  const esp32 = {
    id: 'esp32', name: 'ESP32 DevKit', w: 150, h: 280,
    fqbnMatch: /esp32:esp32/,
    digitalCount: 40,
    pins: [
      ...[
        { label: 'EN', tele: null }, { label: 'VP/36', tele: 36, note: 'input only' },
        { label: 'VN/39', tele: 39, note: 'input only' }, { label: '34', tele: 34, note: 'input only' },
        { label: '35', tele: 35, note: 'input only' }, { label: '32', tele: 32 },
        { label: '33', tele: 33 }, { label: '25', tele: 25 }, { label: '26', tele: 26 },
        { label: '27', tele: 27 }, { label: '14', tele: 14 }, { label: '12', tele: 12 },
        { label: 'GND', tele: null, power: 'gnd' }, { label: '13', tele: 13 }, { label: 'VIN', tele: null, power: 'vin' }
      ].map((p, i) => ({ ...p, x: 14, y: 40 + i * 15, side: 'left' })),
      ...[
        { label: '23', tele: 23 }, { label: '22', tele: 22, note: 'SCL' }, { label: 'TX0', tele: 1 },
        { label: 'RX0', tele: 3 }, { label: '21', tele: 21, note: 'SDA' }, { label: 'GND', tele: null, power: 'gnd' },
        { label: '19', tele: 19 }, { label: '18', tele: 18 }, { label: '5', tele: 5 },
        { label: '17', tele: 17 }, { label: '16', tele: 16 }, { label: '4', tele: 4 },
        { label: '0', tele: 0 }, { label: '2', tele: 2, note: 'onboard LED' }, { label: '3V3', tele: null, power: 'v33' }
      ].map((p, i) => ({ ...p, x: 136, y: 40 + i * 15, side: 'right' }))
    ],
    decor: [
      { kind: 'usb', x: 59, y: 2, w: 32, h: 20 },
      { kind: 'chip', x: 40, y: 40, w: 70, h: 60, label: 'ESP32-WROOM' },
      { kind: 'led', x: 60, y: 120, tele: 2, label: '2', color: '#4aa3ff' },
      { kind: 'led', x: 78, y: 120, role: 'power', label: 'PWR', color: '#ff5c5c' }
    ]
  };

  // ---- Raspberry Pi 40-pin header ------------------------------------------
  // Physical layout: 2×20. Odd pins left column, even right. tele = BCM number.
  const piHeader = [
    ['3V3', null, 'v33'], ['5V', null, 'v5'],
    ['GPIO2', 2, null, 'SDA'], ['5V', null, 'v5'],
    ['GPIO3', 3, null, 'SCL'], ['GND', null, 'gnd'],
    ['GPIO4', 4], ['GPIO14', 14, null, 'TXD'],
    ['GND', null, 'gnd'], ['GPIO15', 15, null, 'RXD'],
    ['GPIO17', 17], ['GPIO18', 18, null, 'PWM0'],
    ['GPIO27', 27], ['GND', null, 'gnd'],
    ['GPIO22', 22], ['GPIO23', 23],
    ['3V3', null, 'v33'], ['GPIO24', 24],
    ['GPIO10', 10, null, 'MOSI'], ['GND', null, 'gnd'],
    ['GPIO9', 9, null, 'MISO'], ['GPIO25', 25],
    ['GPIO11', 11, null, 'SCLK'], ['GPIO8', 8, null, 'CE0'],
    ['GND', null, 'gnd'], ['GPIO7', 7, null, 'CE1'],
    ['ID_SD', null], ['ID_SC', null],
    ['GPIO5', 5], ['GND', null, 'gnd'],
    ['GPIO6', 6], ['GPIO12', 12, null, 'PWM0'],
    ['GPIO13', 13, null, 'PWM1'], ['GND', null, 'gnd'],
    ['GPIO19', 19, null, 'MISO'], ['GPIO16', 16],
    ['GPIO26', 26], ['GPIO20', 20, null, 'MOSI'],
    ['GND', null, 'gnd'], ['GPIO21', 21, null, 'SCLK']
  ];
  const pi = {
    id: 'pi', name: 'Raspberry Pi GPIO', w: 170, h: 340,
    fqbnMatch: /^$/, digitalCount: 28,
    pins: piHeader.map(([label, tele, power, note], i) => ({
      label, tele, power, note,
      x: i % 2 === 0 ? 62 : 108,
      y: 24 + Math.floor(i / 2) * 15,
      side: i % 2 === 0 ? 'left' : 'right',
      physical: i + 1
    })),
    decor: [{ kind: 'chip', x: 20, y: 130, w: 30, h: 80, label: 'PI' }]
  };

  // ---- Arduino Mega 2560 (Rev3) ---------------------------------------------
  // From MEGA2560_Rev3e.brd: top edge SCL SDA AREF GND 13..8 | 7..0 |
  // 14..21; the 2×18 header at the far end has 5V 5V at the top, then
  // 22/23 … 52/53, then GND GND; EVEN pins on the inner column, ODD on the
  // edge. Bottom edge: power, A0–A7, A8–A15. ICSP for the 2560 (SPI = 50 51 52)
  // by the chip, and a second ICSP for the USB chip (16U2) by the USB socket.
  const megaTop = [
    { label: 'SCL', tele: 21 }, { label: 'SDA', tele: 20 },
    { label: 'AREF', tele: null }, { label: 'GND', tele: null, power: 'gnd' },
    { label: '13', tele: 13, pwm: true }, { label: '12', tele: 12, pwm: true },
    { label: '11', tele: 11, pwm: true }, { label: '10', tele: 10, pwm: true },
    { label: '9', tele: 9, pwm: true }, { label: '8', tele: 8, pwm: true },
    { label: '7', tele: 7, pwm: true }, { label: '6', tele: 6, pwm: true },
    { label: '5', tele: 5, pwm: true }, { label: '4', tele: 4, pwm: true },
    { label: '3', tele: 3, pwm: true }, { label: '2', tele: 2, pwm: true },
    { label: 'TX0', tele: 1, note: 'D1 · Serial TX' }, { label: 'RX0', tele: 0, note: 'D0 · Serial RX' },
    { label: 'TX3', tele: 14, note: 'D14 · Serial3 TX' }, { label: 'RX3', tele: 15, note: 'D15 · Serial3 RX' },
    { label: 'TX2', tele: 16, note: 'D16 · Serial2 TX' }, { label: 'RX2', tele: 17, note: 'D17 · Serial2 RX' },
    { label: 'TX1', tele: 18, note: 'D18 · Serial1 TX' }, { label: 'RX1', tele: 19, note: 'D19 · Serial1 RX' }
  ];
  const megaTopAt = [18.796, 21.336, 23.876, 26.416, 28.956, 31.496, 34.036, 36.576, 39.116, 41.656,
    45.72, 48.26, 50.8, 53.34, 55.88, 58.42, 60.96, 63.5,
    68.58, 71.12, 73.66, 76.2, 78.74, 81.28];
  const MEGA_SPI = { 50: 'MISO', 51: 'MOSI', 52: 'SCK', 53: 'SS' };
  const mega = mmBoard({
    id: 'mega', name: 'Arduino Mega 2560', w: 0, h: 0,
    fqbnMatch: /arduino:avr:mega/,
    digitalCount: 64,
    pins: [
      ...megaTop.map((p, i) => ({ ...p, at: [megaTopAt[i], 50.8] })),
      // 2×18 header 22..53: row r holds 22+2r (inner column) and 23+2r (edge)
      ...Array.from({ length: 32 }, (_, i) => {
        const pin = 22 + i, row = Math.floor(i / 2), inner = i % 2 === 0;
        return { label: String(pin), tele: pin, pwm: pin >= 44 && pin <= 46, note: MEGA_SPI[pin],
                 at: [inner ? 93.98 : 96.52, +(48.26 - row * 2.54).toFixed(2)], side: 'right', labelAt: inner ? 'left' : 'right' };
      }),
      ...unoPower(),
      // A0..A15 (A10+ are past the 64-bit digital mask: they still show ADC
      // values via analogIndex, just no digital state)
      ...Array.from({ length: 16 }, (_, i) => ({
        label: 'A' + i, tele: i < 10 ? 54 + i : null, analogIndex: i,
        at: [i < 8 ? 50.8 + i * 2.54 : 73.66 + (i - 8) * 2.54, 2.54]
      })),
      // appended in 0.9.4: pins the old drawing left out
      { label: 'SDA', tele: 20, note: 'D20 · same pin as SDA by AREF', at: [83.82, 50.8] },
      { label: 'SCL', tele: 21, note: 'D21 · same pin as SCL by AREF', at: [86.36, 50.8] },
      { label: '5V', tele: null, power: 'v5', at: [93.98, 50.8], side: 'right', labelAt: 'left' },
      { label: '5V', tele: null, power: 'v5', at: [96.52, 50.8], side: 'right', labelAt: 'right' },
      { label: 'GND', tele: null, power: 'gnd', at: [93.98, 7.62], side: 'right', labelAt: 'left' },
      { label: 'GND', tele: null, power: 'gnd', at: [96.52, 7.62], side: 'right', labelAt: 'right' },
      NC,
      ...icsp(50, 52, 51, ['D50', 'D52', 'D51'])
    ],
    decor: [
      usbB, jack, resetBtn(6.223, 48.769),
      { kind: 'chip', at: [43.8, 21.35, 57.8, 35.35], label: 'ATMEGA2560' },
      { kind: 'chip', at: [17.4, 32.3, 22.4, 37.2], label: '16U2', small: true },
      { kind: 'led', at: [27.94, 42.164], tele: 13, label: 'L', color: '#ffd94a' },
      { kind: 'led', at: [76.2, 36.83], role: 'power', label: 'ON', color: '#3fd07a' },
      { kind: 'led', at: [27.94, 36.576], role: 'tx', label: 'TX', color: '#ffd94a' },
      { kind: 'led', at: [27.94, 34.29], role: 'rx', label: 'RX', color: '#ffd94a' }
    ]
  }, { w: 101.6, h: 53.34,
    outline: [[1, 0], [98.06, 0], [99.06, 1], [99.06, 2.54], [101.6, 5.08], [101.6, 37.846], [99.06, 40.386], [99.06, 51.816], [97.536, 53.34], [1, 53.34], [0, 52.34], [0, 1]],
    holes: [[96.52, 2.54, 3.2], [15.24, 50.8, 3.2], [90.17, 50.8, 3.2], [13.97, 2.54, 3.2], [66.04, 35.56, 3.2], [66.04, 7.62, 3.2]],
    source: 'Arduino Mega 2560 Rev3 CAD (MEGA2560_Rev3e.brd, A000067)' });

  // ---- Raspberry Pi Pico ----------------------------------------------------
  // 40-pin DIP: GP pins + power interleaved, tele = GP number.
  const picoLeft = [
    ['GP0', 0], ['GP1', 1], ['GND', null, 'gnd'], ['GP2', 2], ['GP3', 3],
    ['GP4', 4], ['GP5', 5], ['GND', null, 'gnd'], ['GP6', 6], ['GP7', 7],
    ['GP8', 8], ['GP9', 9], ['GND', null, 'gnd'], ['GP10', 10], ['GP11', 11],
    ['GP12', 12], ['GP13', 13], ['GND', null, 'gnd'], ['GP14', 14], ['GP15', 15]
  ];
  const picoRight = [
    ['VBUS', null, 'v5'], ['VSYS', null, 'vin'], ['GND', null, 'gnd'],
    ['3V3EN', null], ['3V3', null, 'v33'], ['ADC_REF', null],
    ['GP28/A2', 28, null, 'A2'], ['GND', null, 'gnd'], ['GP27/A1', 27, null, 'A1'],
    ['GP26/A0', 26, null, 'A0'], ['RUN', null], ['GP22', 22],
    ['GND', null, 'gnd'], ['GP21', 21], ['GP20', 20], ['GP19', 19],
    ['GP18', 18], ['GND', null, 'gnd'], ['GP17', 17], ['GP16', 16]
  ];
  const pico = {
    id: 'pico', name: 'Raspberry Pi Pico', w: 130, h: 330,
    fqbnMatch: /rp2040:rp2040/,
    digitalCount: 30,
    pins: [
      ...picoLeft.map(([label, tele, power, note], i) => ({
        label, tele, power, note, x: 14, y: 24 + i * 15, side: 'left',
        analogIndex: undefined
      })),
      ...picoRight.map(([label, tele, power, note], i) => ({
        label, tele, power, note, x: 116, y: 24 + i * 15, side: 'right',
        analogIndex: tele === 26 ? 0 : tele === 27 ? 1 : tele === 28 ? 2 : undefined
      }))
    ],
    decor: [
      { kind: 'usb', x: 49, y: 2, w: 32, h: 18 },
      { kind: 'chip', x: 45, y: 90, w: 40, h: 40, label: 'RP2040' },
      // the Pico's only LED is GP25 — there is no power LED, and that's accurate
      { kind: 'led', x: 36, y: 40, tele: 25, label: '25', color: '#3fd07a' }
    ]
  };

  // ---- ESP8266 NodeMCU ------------------------------------------------------
  // D-numbers on the silkscreen, GPIO numbers in telemetry.
  const nodeLeft = [
    ['A0', null, null, 'ADC'], ['RSV', null], ['RSV', null], ['SD3', 10],
    ['SD2', 9], ['SD1', null], ['CMD', null], ['SD0', null], ['CLK', null],
    ['GND', null, 'gnd'], ['3V3', null, 'v33'], ['EN', null], ['RST', null],
    ['GND', null, 'gnd'], ['VIN', null, 'vin']
  ];
  const nodeRight = [
    ['D0/G16', 16, null, 'no int'], ['D1/G5', 5, null, 'SCL'], ['D2/G4', 4, null, 'SDA'],
    ['D3/G0', 0, null, 'flash'], ['D4/G2', 2, null, 'LED'], ['3V3', null, 'v33'],
    ['GND', null, 'gnd'], ['D5/G14', 14, null, 'SCLK'], ['D6/G12', 12, null, 'MISO'],
    ['D7/G13', 13, null, 'MOSI'], ['D8/G15', 15, null, 'CS'], ['RX/G3', 3],
    ['TX/G1', 1], ['GND', null, 'gnd'], ['3V3', null, 'v33']
  ];
  const nodemcu = {
    id: 'nodemcu', name: 'ESP8266 NodeMCU', w: 140, h: 270,
    fqbnMatch: /esp8266:esp8266/,
    digitalCount: 17,
    pins: [
      ...nodeLeft.map(([label, tele, power, note], i) => ({
        label, tele, power, note, x: 14, y: 32 + i * 15, side: 'left',
        analogIndex: label === 'A0' ? 0 : undefined
      })),
      ...nodeRight.map(([label, tele, power, note], i) => ({
        label, tele, power, note, x: 126, y: 32 + i * 15, side: 'right'
      }))
    ],
    decor: [
      { kind: 'usb', x: 54, y: 2, w: 32, h: 20 },
      { kind: 'chip', x: 34, y: 150, w: 72, h: 96, label: 'ESP-12E' },
      { kind: 'chip', x: 52, y: 62, w: 36, h: 30, label: 'CP2102', small: true },
      // NodeMCU DevKit 1.0 (nodemcu-devkit-v1.0 schematic): a blue LED on the
      // ESP-12E module (GPIO2) and a blue board LED (LED1) on GPIO16/D0, both
      // wired to 3V3 so LOW turns them on. The board has no power LED (some
      // clones add one).
      { kind: 'led', x: 92, y: 160, tele: 2, label: 'G2', color: '#4aa3ff', invert: true },
      { kind: 'led', x: 46, y: 44, tele: 16, label: 'D0', color: '#4aa3ff', invert: true }
    ]
  };

  // ---- Adafruit Feathers (to scale, from Adafruit's Eagle files) -------------
  // 50.8 × 22.86 mm, USB on the left. A 16-pin header runs the bottom edge
  // from RESET (x 6.35) and a 12-pin header the top edge from BAT (x 16.51),
  // 2.54 mm pitch. Pads, LEDs and parts come from each board's .brd on
  // github.com/adafruit (CC BY-SA). Every Feather has a red LED on D13 and an
  // orange CHG LED that the battery charger drives; the Express and RP2040
  // boards add a NeoPixel.
  const FEATHER_OUTLINE = (() => {
    const pts = [], R = 2.54;
    const arc = (cx, cy, a0) => { for (let k = 0; k <= 4; k++) { const a = (a0 + k * 22.5) * Math.PI / 180; pts.push([+(cx + R * Math.cos(a)).toFixed(3), +(cy + R * Math.sin(a)).toFixed(3)]); } };
    arc(48.26, 2.54, 270); arc(48.26, 20.32, 0); arc(2.54, 20.32, 90); arc(2.54, 2.54, 180);
    return pts;
  })();
  const FEATHER_HOLES = [[2.54, 2.54, 2.5], [2.54, 20.32, 2.5], [48.26, 2.54, 2.54], [48.26, 20.32, 2.54]];
  function featherPins(bottom16, top12, topY) {
    return [
      ...bottom16.map(([label, tele, power, note, analogIndex], i) => ({
        label, tele, power, note, analogIndex, at: [+(6.35 + i * 2.54).toFixed(2), 1.27], side: 'bottom' })),
      ...top12.map(([label, tele, power, note], i) => ({
        label, tele, power, note, at: [+(16.51 + i * 2.54).toFixed(2), topY || 21.59], side: 'top' }))
    ];
  }
  const featherGeo = (file, holes) => ({ w: 50.8, h: 22.86, margin: 22, labelsOut: true, outline: FEATHER_OUTLINE,
    holes: holes || FEATHER_HOLES, source: 'Adafruit ' + file + ' (Eagle, github.com/adafruit)' });
  const microUsb = { kind: 'usb', at: [-1.0, 7.7, 4.6, 15.2], label: 'USB' };
  const featherJst = { kind: 'jack', at: [6.8, 15.2, 14.8, 22.86], label: 'BAT' };
  const fLed = (at, tele) => ({ kind: 'led', at, tele, label: '13', color: '#ff3b30' });
  const fChg = (at) => ({ kind: 'led', at, role: 'charge', label: 'CHG', color: '#ff9f1a' });
  const fNeo = (at, tele) => ({ kind: 'rgb', at, tele, label: 'NEO' });
  const kmr2 = (cx, cy, vertical) => ({ kind: 'button', at: vertical ? [cx - 1.4, cy - 2.1, cx + 1.4, cy + 2.1] : [cx - 2.1, cy - 1.4, cx + 2.1, cy + 1.4], label: 'RST' });

  // Feather ESP32 (HUZZAH32) — GPIO numbers straight off the silkscreen.
  // The third bottom pad has no net on the board (NC).
  const featheresp32 = mmBoard({
    id: 'featheresp32', name: 'Feather ESP32 (HUZZAH32)', w: 0, h: 0,
    fqbnMatch: /esp32:esp32:featheresp32(?::|$)/,   // HUZZAH32 only: V2/S2/S3 Feathers differ
    digitalCount: 40,
    pins: featherPins(
      [ ['RST', null], ['3V', null, 'v33'], ['NC', null], ['GND', null, 'gnd'],
        ['A0/26', 26, null, null, 0], ['A1/25', 25, null, null, 1],
        ['A2/34', 34, null, 'input only', 2], ['A3/39', 39, null, 'input only', 3],
        ['A4/36', 36, null, 'input only', 4], ['A5/4', 4, null, null, 5],
        ['SCK/5', 5], ['MO/18', 18], ['MI/19', 19], ['RX/16', 16], ['TX/17', 17], ['21', 21] ],
      [ ['BAT', null, 'vin'], ['EN', null], ['USB', null, 'v5'],
        ['13', 13, null, 'red LED'], ['12', 12], ['27', 27], ['33', 33],
        ['15', 15], ['32', 32], ['14', 14], ['SCL/22', 22], ['SDA/23', 23] ]),
    decor: [
      microUsb, featherJst, kmr2(9.144, 6.223, true),
      { kind: 'chip', at: [25.6, 2.43, 51.1, 20.43], label: 'ESP32-WROOM-32' },
      { kind: 'chip', at: [14.9, 4.5, 18.9, 8.5], label: 'CP2104', small: true },
      fLed([2.858, 17.336], 13), fChg([2.413, 5.588])
    ]
  }, featherGeo('HUZZAH32 ESP32 Feather.brd', [[2.54, 2.54, 2.5], [2.54, 20.32, 2.5], [48.26, 1.842, 2.2], [48.26, 20.955, 2.2]]));

  // Feather RP2040 — GP numbers per the Adafruit pinout. The third bottom
  // pad is a second 3V3 on this board (not AREF/NC as on the others).
  const featherrp2040 = mmBoard({
    id: 'featherrp2040', name: 'Feather RP2040', w: 0, h: 0,
    fqbnMatch: /rp2040:rp2040:adafruit_feather(?::|$)/,   // plain Feather RP2040 only
    digitalCount: 30,
    pins: featherPins(
      [ ['RST', null], ['3V', null, 'v33'], ['3V', null, 'v33'], ['GND', null, 'gnd'],
        ['A0/GP26', 26, null, null, 0], ['A1/GP27', 27, null, null, 1],
        ['A2/GP28', 28, null, null, 2], ['A3/GP29', 29, null, null, 3],
        ['D24', 24], ['D25', 25],
        ['SCK/GP14', 14], ['MO/GP15', 15], ['MI/GP8', 8], ['RX/GP1', 1], ['TX/GP0', 0], ['D4', 4] ],
      [ ['BAT', null, 'vin'], ['EN', null], ['USB', null, 'v5'],
        ['D13', 13, null, 'red LED'], ['D12', 12], ['D11', 11], ['D10', 10],
        ['D9', 9], ['D6', 6], ['D5', 5], ['SCL/GP3', 3], ['SDA/GP2', 2] ], 21.65),
    decor: [
      { kind: 'usb', at: [-1.2, 7.0, 6.3, 15.9], label: 'USB-C' }, featherJst, kmr2(11.811, 6.414),
      { kind: 'button', at: [47.9, 13.0, 50.4, 17.6], label: 'BOOT' },
      { kind: 'chip', at: [31.0, 8.0, 37.9, 14.9], label: 'RP2040' },
      { kind: 'chip', at: [40.8, 12.2, 43.2, 15.9], label: 'FLASH', small: true },
      fLed([1.82, 17.423], 13), fChg([1.778, 5.398]), fNeo([17.755, 5.982], 16)
    ]
  }, featherGeo('Feather RP2040.brd'));

  // Feather M0 (Basic / Express) — Arduino numbers per the
  // adafruit_feather_m0 variant: A0–A5 = 14–19, SDA 20, SCL 21, MISO 22,
  // MOSI 23, SCK 24. The 16th bottom pad is GND on both the Basic and the
  // Express .brd. The Express adds a NeoPixel on D8 (its own revision).
  const featherm0 = mmBoard({
    id: 'featherm0', name: 'Feather M0', w: 0, h: 0,
    fqbnMatch: /adafruit:samd:adafruit_feather_m0/,
    digitalCount: 26,
    pins: featherPins(
      [ ['RST', null], ['3V', null, 'v33'], ['AREF', null], ['GND', null, 'gnd'],
        ['A0', 14, null, null, 0], ['A1', 15, null, null, 1],
        ['A2', 16, null, null, 2], ['A3', 17, null, null, 3],
        ['A4', 18, null, null, 4], ['A5', 19, null, null, 5],
        ['SCK', 24], ['MO', 23], ['MI', 22], ['RX', 0], ['TX', 1], ['GND', null, 'gnd'] ],
      [ ['BAT', null, 'vin'], ['EN', null], ['USB', null, 'v5'],
        ['D13', 13, null, 'red LED'], ['D12', 12], ['D11', 11], ['D10', 10],
        ['D9', 9, null, 'A7 · battery divider'], ['D6', 6], ['D5', 5], ['SCL', 21], ['SDA', 20] ]),
    decor: [
      microUsb, featherJst, kmr2(9.398, 6.477),
      { kind: 'chip', at: [20.7, 6.2, 27.6, 13.1], label: 'SAMD21' },
      fLed([2.645, 17.359], 13), fChg([2.413, 5.588])
    ]
  }, featherGeo('Feather M0 Basic rev C.brd / Feather M0 Express.brd'));

  // Feather M4 Express — adafruit_feather_m4 variant numbering.
  const featherm4 = mmBoard({
    id: 'featherm4', name: 'Feather M4 Express', w: 0, h: 0,
    fqbnMatch: /adafruit:samd:adafruit_feather_m4/,
    digitalCount: 26,
    pins: featherPins(
      [ ['RST', null], ['3V', null, 'v33'], ['AREF', null], ['GND', null, 'gnd'],
        ['A0', 14, null, null, 0], ['A1', 15, null, null, 1],
        ['A2', 16, null, null, 2], ['A3', 17, null, null, 3],
        ['A4', 18, null, null, 4], ['A5', 19, null, null, 5],
        ['SCK', 25], ['MO', 24], ['MI', 23], ['RX', 0], ['TX', 1], ['D4', 4] ],
      [ ['BAT', null, 'vin'], ['EN', null], ['USB', null, 'v5'],
        ['D13', 13, null, 'red LED'], ['D12', 12], ['D11', 11], ['D10', 10],
        ['D9', 9], ['D6', 6], ['D5', 5], ['SCL', 22], ['SDA', 21] ]),
    decor: [
      microUsb, featherJst, kmr2(9.398, 6.541),
      { kind: 'chip', at: [25.7, 6.6, 34.6, 15.5], label: 'SAMD51' },
      { kind: 'chip', at: [35.8, 7.2, 37.3, 9.6], label: 'FLASH', small: true },
      fLed([2.645, 17.359], 13), fChg([2.413, 5.588]), fNeo([16.485, 6.109], 8)
    ]
  }, featherGeo('Feather M4 Express.brd'));

  // ---- revisions and real images --------------------------------------------
  // Each revision can rename pins, move parts (LEDs, USB, chip) and has its own
  // pictures. Pictures are stored already rectified into the board's drawing
  // frame (perspective-corrected and cropped to def.w × def.h at 5 px/unit),
  // so pads line up with the photo and survive rotate/flip. Back pictures are
  // kept as photographed (the mirrored frame). Every picture is openly
  // licensed; the credit is shown under it.
  const DOCS = (path) => ({ credit: 'Arduino SA', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    source: 'https://github.com/arduino/docs-content/blob/main/content/hardware/' + path, note: 'Official Arduino board illustration' });
  const COMMONS = (file, by, lic) => ({ credit: by, license: lic,
    licenseUrl: lic === 'CC BY-SA 3.0' ? 'https://creativecommons.org/licenses/by-sa/3.0/' : 'https://creativecommons.org/licenses/by-sa/4.0/',
    source: 'https://commons.wikimedia.org/wiki/File:' + encodeURIComponent(file.replace(/ /g, '_')), note: 'Photo' });
  const img = (id, kind, face, meta) => ({ id, kind, face, src: 'img/boards/' + id + '.webp', ...meta });
  const mmDecor = (def, list) => mmBoard({ pins: [], decor: list }, def.geo).decor;
  // UNO R4 LEDs from the Altium placement (PCB.PcbDoc, minus the 25.4 mm
  // origin offset). Minima: TX/RX are RA4M1 pins 21/22 (P012/P013, LED to
  // +5V, so LOW = lit). WiFi: TX sits on the RA4M1 UART to the ESP32-S3 and
  // RX on the ESP32's reply, so they blink with the serial traffic itself.
  const R4_LEDS = (l, tx, rx, on, txTele, rxTele) => [
    { kind: 'led', at: l, tele: 13, label: 'L', color: '#ffd94a' },
    { kind: 'led', at: on, role: 'power', label: 'ON', color: '#3fd07a' },
    { kind: 'led', at: tx, role: 'tx', label: 'TX', color: '#ffd94a', ...(txTele != null ? { tele: txTele, invert: true } : {}) },
    { kind: 'led', at: rx, role: 'rx', label: 'RX', color: '#ffd94a', ...(rxTele != null ? { tele: rxTele, invert: true } : {}) }];
  // the R4 WiFi's 12×8 red matrix (designators 1–96 = frame pixels 0–95,
  // row by row from the top-left; checked against Arduino_LED_Matrix's
  // charlieplex table and the board's nets). 2.1 mm pitch.
  const R4_MATRIX = { kind: 'matrix', cols: 12, rows: 8, color: '#ff2a2a', label: 'LED MATRIX',
    cells: Array.from({ length: 96 }, (_, i) => [+(34.412 + (i % 12) * 2.1).toFixed(3), +(26.53 - Math.floor(i / 12) * 2.1).toFixed(3)]) };
  uno.revisions = [
    { id: 'r3', name: 'UNO R3', fqbn: /arduino:avr:uno/, note: 'ATmega328P, through-hole (A000066). The SMD R3 has the same headers.',
      images: [img('uno-r3-render', 'render', 'front', DOCS('uno/boards/uno-rev3/image.svg'))] },
    { id: 'r4minima', name: 'UNO R4 Minima', fqbn: /arduino:renesas_uno:minima/, note: 'RA4M1, USB-C (ABX00080). Pin 1 of the power header is BOOT.',
      pinLabels: { NC: 'BOOT' },
      decor: [
        { kind: 'usb', at: [-1.5, 33.3, 6.7, 42.5], label: 'USB-C' }, { kind: 'jack', at: [-3.3, 4.6, 12.9, 12.9] },
        { kind: 'button', at: [3.75, 44.1, 10, 50], label: 'RESET' },
        { kind: 'chip', at: [39.2, 27.1, 47.5, 35.4], label: 'RA4M1' },
        ...R4_LEDS([27.94, 42.164], [27.94, 36.576], [27.94, 34.29], [58.42, 36.576], 21, 22)],
      images: [img('uno-r4minima-photo', 'photo', 'front', COMMONS('Arduino Uno R4 Minima.webp', 'Arduino', 'CC BY-SA 3.0')),
        img('uno-r4minima-render', 'render', 'front', DOCS('uno/boards/uno-r4-minima/image.svg'))] },
    { id: 'r4wifi', name: 'UNO R4 WiFi', fqbn: /arduino:renesas_uno:unor4wifi/, note: 'RA4M1 + ESP32-S3, USB-C, LED matrix (ABX00087). The ESP32 header, Qwiic and OFF/VRTC pins are not drawn.',
      decor: [
        { kind: 'usb', at: [-1.5, 33.3, 6.7, 39.2 + 3.3], label: 'USB-C' }, { kind: 'jack', at: [-3.3, 4.6, 12.9, 12.9] },
        { kind: 'button', at: [3.75, 44.1, 10, 50], label: 'RESET' },
        { kind: 'chip', at: [47.5, 30.8, 57.5, 40.4], label: 'RA4M1' },
        { kind: 'chip', at: [7.5, 14.6, 21.25, 28.8], label: 'ESP32-S3' },
        ...R4_LEDS([26.416, 42.164], [26.416, 36.576], [26.416, 34.29], [64.897, 39.553]), R4_MATRIX],
      images: [img('uno-r4wifi-photo', 'photo', 'front', COMMONS('Arduino Uno R4 WiFi.webp', 'Arduino', 'CC BY-SA 3.0')),
        img('uno-r4wifi-render', 'render', 'front', DOCS('uno/boards/uno-r4-wifi/image.svg'))] }
  ];
  for (const r of uno.revisions) if (r.decor) r.decor = mmDecor(uno, r.decor);
  mega.revisions = [{ id: 'rev3', name: 'Mega 2560 Rev3', fqbn: /arduino:avr:mega/, note: 'ATmega2560 (A000067)',
    images: [img('mega-rev3-render', 'render', 'front', DOCS('mega/boards/mega-2560/image.svg'))] }];
  leonardo.revisions = [{ id: 'rev3', name: 'Leonardo', fqbn: /arduino:avr:leonardo/, note: 'ATmega32u4 (A000057)',
    images: [img('leonardo-photo', 'photo', 'front', COMMONS('Arduino Leonardo board.JPG', 'Kszapsza', 'CC BY-SA 4.0')),
      img('leonardo-render', 'render', 'front', DOCS('hero/boards/leonardo/image.svg'))] }];
  nano.revisions = [{ id: 'v3', name: 'Nano 3.x', fqbn: /arduino:avr:nano/, note: 'ATmega328P (A000005). Clones often differ in LEDs and parts, never in the header order.',
    images: [img('nano-render', 'render', 'front', DOCS('nano/boards/nano/image.svg')),
      img('nano-back-photo', 'photo', 'back', COMMONS('Arduino nano bottm.jpg', 'MakeMagazinDE', 'CC BY-SA 4.0'))] }];
  nanoevery.revisions = [{ id: 'every', name: 'Nano Every', fqbn: /arduino:megaavr:nona4809/, note: 'ATmega4809 (ABX00028)',
    images: [img('nanoevery-photo', 'photo', 'front', COMMONS('Arduino Nano Every.png', 'Enirstad', 'CC BY-SA 4.0')),
      img('nanoevery-render', 'render', 'front', DOCS('nano/boards/nano-every/image.svg'))] }];

  featherm0.revisions = [
    { id: 'basic', name: 'Feather M0 Basic', fqbn: /adafruit:samd:adafruit_feather_m0(?::|$)/, note: 'ATSAMD21G18, no NeoPixel (Feather M0 Basic rev C)' },
    { id: 'express', name: 'Feather M0 Express', fqbn: /adafruit:samd:adafruit_feather_m0_express/, note: 'Adds 2 MB SPI flash and a NeoPixel on D8',
      decor: [
        microUsb, featherJst, kmr2(9.398, 6.477),
        { kind: 'chip', at: [20.7, 6.2, 27.6, 13.1], label: 'SAMD21' },
        { kind: 'chip', at: [32.0, 5.1, 35.8, 11.7], label: 'FLASH', small: true },
        fLed([2.645, 17.359], 13), fChg([2.413, 5.588]), fNeo([33.782, 16.764], 8)] }
  ];
  featherm0.revisions[1].decor = mmDecor(featherm0, featherm0.revisions[1].decor.map((d) => ({ ...d })));
  // Pico W / Pico 2 W: the LED hangs off the CYW43 wireless chip (WL_GPIO0),
  // which no RP2040 register shows, so it is drawn but marked as not readable.
  pico.revisions = [
    { id: 'pico', name: 'Pico / Pico 2', fqbn: /rp2040:rp2040:rpipico2?(?::|$)/, note: 'Green LED on GP25 (D2, QSME-C194). No power LED.' },
    { id: 'picow', name: 'Pico W / Pico 2 W', fqbn: /rp2040:rp2040:rpipico2?w(?::|$)/, note: 'The LED is on the wireless chip (WL_GPIO0), so the live view cannot see it.',
      decor: pico.decor.map((d) => (d.kind === 'led' ? { ...d, tele: null, unreadable: true, label: 'LED', note: 'on the wireless chip: not readable live' } : d)) }
  ];

  // a board as one revision draws it: names, parts and pin labels swapped in.
  // Pins keep their order (saved wires point at them by index).
  function withRevision(def, revId) {
    const revs = def.revisions || [];
    const rev = revs.find((r) => r.id === revId) || revs[0] || null;
    if (!rev) return { def, rev: null };
    const pins = rev.pinLabels ? def.pins.map((p) => (rev.pinLabels[p.label] ? { ...p, label: rev.pinLabels[p.label] } : p)) : def.pins;
    return { def: { ...def, name: def.name, title: rev.name, pins, decor: rev.decor || def.decor }, rev };
  }
  Object.defineProperty(PINODE_REV, 'withRevision', { value: withRevision });

  // feather defs go first so their fqbnMatch wins over the generic families
  return { featheresp32, featherrp2040, featherm0, featherm4, leonardo, nanoevery, uno, nano, mega, esp32, nodemcu, pico, pi };
})();
