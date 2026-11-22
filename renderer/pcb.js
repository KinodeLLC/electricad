// PCB layout core: footprints, the netlist from the wiring canvas,
// connectivity / ratsnest, design-rule check, and the fab outputs
// (RS-274X Gerbers, Excellon drill, BOM, pick-and-place, KiCad netlist).
// Pure functions in millimetres; the editor UI lives in pcbview.js.
//
// Footprint geometry follows the KiCad standard library footprint of the
// same name (pad size, drill, pitch) so boards match real parts. Parts whose
// package varies between vendors (modules, relays, pots) get a plain 2.54 mm
// header in the canvas's port order and are flagged "check" so nobody is
// misled into thinking it matches their exact part.
(function (root) {
  'use strict';

  // ---- footprints ------------------------------------------------------------
  // pad: { num, x, y, shape: 'circle'|'rect'|'oval', w, h, drill (0 = SMD) }
  // silk: [{ l: [x1, y1, x2, y2] } | { c: [x, y, r] }]
  const TH = (num, x, y, d, drill, shape) => ({ num: String(num), x, y, shape: shape || 'circle', w: d, h: d, drill });
  const box = (x1, y1, x2, y2) => [{ l: [x1, y1, x2, y1] }, { l: [x2, y1, x2, y2] }, { l: [x2, y2, x1, y2] }, { l: [x1, y2, x1, y1] }];

  function header(n, label) {
    const pads = [];
    for (let i = 0; i < n; i++) pads.push({ num: String(i + 1), x: 0, y: i * 2.54, shape: i ? 'oval' : 'rect', w: 1.7, h: 1.7, drill: 1.0 });
    return { name: 'PinHeader_1x' + String(n).padStart(2, '0') + '_P2.54mm_Vertical', lib: 'Connector_PinHeader_2.54mm',
      label: label || n + '-pin header, 2.54 mm', pads, silk: box(-1.33, -1.33, 1.33, (n - 1) * 2.54 + 1.33) };
  }
  function dip(n, rowMm, name) {
    const pads = [], half = n / 2;
    for (let i = 0; i < half; i++) pads.push({ num: String(i + 1), x: 0, y: i * 2.54, shape: i ? 'oval' : 'rect', w: 1.6, h: 1.6, drill: 0.8 });
    for (let i = 0; i < half; i++) pads.push({ num: String(half + i + 1), x: rowMm, y: (half - 1 - i) * 2.54, shape: 'oval', w: 1.6, h: 1.6, drill: 0.8 });
    const y2 = (half - 1) * 2.54;
    return { name: name || 'DIP-' + n + '_W' + rowMm.toFixed(2) + 'mm', lib: 'Package_DIP', label: 'DIP-' + n, pads,
      silk: [{ l: [1.2, -1.33, rowMm - 1.2, -1.33] }, { l: [rowMm - 1.2, -1.33, rowMm - 1.2, y2 + 1.33] },
             { l: [rowMm - 1.2, y2 + 1.33, 1.2, y2 + 1.33] }, { l: [1.2, y2 + 1.33, 1.2, -1.33] }, { c: [rowMm / 2, -0.3, 0.5] }] };
  }

  const FOOTPRINTS = {
    R_Axial: { name: 'R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal', lib: 'Resistor_THT', label: 'Axial resistor, 10.16 mm',
      pads: [TH(1, 0, 0, 1.6, 0.8), TH(2, 10.16, 0, 1.6, 0.8)],
      silk: [...box(1.93, -1.37, 8.23, 1.37), { l: [1.04, 0, 1.93, 0] }, { l: [9.12, 0, 8.23, 0] }] },
    D_DO41: { name: 'D_DO-41_SOD81_P10.16mm_Horizontal', lib: 'Diode_THT', label: 'DO-41 diode, 10.16 mm',
      pads: [TH(1, 0, 0, 2.2, 1.1, 'rect'), TH(2, 10.16, 0, 2.2, 1.1)],
      silk: [...box(2.89, -1.47, 7.27, 1.47), { l: [3.6, -1.47, 3.6, 1.47] }] },   // band = cathode (pad 1)
    LED_5mm: { name: 'LED_D5.0mm', lib: 'LED_THT', label: '5 mm LED, 2.54 mm',
      pads: [TH(1, 0, 0, 1.8, 0.9, 'rect'), TH(2, 2.54, 0, 1.8, 0.9)],   // pad 1 = cathode (flat side)
      silk: [{ c: [1.27, 0, 2.9] }, { l: [-1.23, -1.47, -1.23, 1.47] }] },
    C_Disc: { name: 'C_Disc_D5.0mm_W2.5mm_P5.00mm', lib: 'Capacitor_THT', label: 'Ceramic disc, 5.00 mm',
      pads: [TH(1, 0, 0, 1.6, 0.8), TH(2, 5, 0, 1.6, 0.8)], silk: box(-0.25, -1.37, 5.25, 1.37) },
    CP_Radial: { name: 'CP_Radial_D5.0mm_P2.00mm', lib: 'Capacitor_THT', label: 'Electrolytic Ø5 mm, 2.00 mm',
      pads: [TH(1, 0, 0, 1.6, 0.8, 'rect'), TH(2, 2, 0, 1.6, 0.8)],       // pad 1 = +
      silk: [{ c: [1, 0, 2.62] }, { l: [-1.3, -1.9, -1.3, -0.9] }, { l: [-1.8, -1.4, -0.8, -1.4] }] },
    // TO-92 with 2.54 mm leads (easier to solder than the 1.27 mm inline)
    TO92: { name: 'TO-92_Inline_Wide', lib: 'Package_TO_SOT_THT', label: 'TO-92, 2.54 mm',
      pads: [TH(1, 0, 0, 1.5, 0.8, 'rect'), TH(2, 2.54, 0, 1.5, 0.8), TH(3, 5.08, 0, 1.5, 0.8)],
      silk: [{ l: [0.74, 1.85, 4.34, 1.85] }, { c: [2.54, 0, 2.5] }] },
    TO220: { name: 'TO-220-3_Vertical', lib: 'Package_TO_SOT_THT', label: 'TO-220, vertical',
      pads: [{ num: '1', x: 0, y: 0, shape: 'rect', w: 1.905, h: 2.0, drill: 1.1 },
             { num: '2', x: 2.54, y: 0, shape: 'oval', w: 1.905, h: 2.0, drill: 1.1 },
             { num: '3', x: 5.08, y: 0, shape: 'oval', w: 1.905, h: 2.0, drill: 1.1 }],
      silk: [...box(-2.46, -3.27, 7.54, 1.25), { l: [-2.46, -1.76, 7.54, -1.76] }] },
    // AMS1117 is SMD: SOT-223 with the tab tied to pin 2 (OUT)
    SOT223: { name: 'SOT-223-3_TabPin2', lib: 'Package_TO_SOT_SMD', label: 'SOT-223 (SMD)',
      pads: [{ num: '1', x: -2.3, y: 3.15, shape: 'rect', w: 1.5, h: 2.0, drill: 0 },
             { num: '2', x: 0, y: 3.15, shape: 'rect', w: 1.5, h: 2.0, drill: 0 },
             { num: '3', x: 2.3, y: 3.15, shape: 'rect', w: 1.5, h: 2.0, drill: 0 },
             { num: '2', x: 0, y: -3.15, shape: 'rect', w: 3.8, h: 2.0, drill: 0 }],
      silk: box(-3.4, -1.85, 3.4, 1.85), smd: true },
    // 6 × 6 mm tactile switch: the pads 6.5 mm apart are joined inside the
    // switch (same number); pressing joins 1 to 2 across the 4.5 mm gap
    SW_6mm: { name: 'SW_PUSH_6mm', lib: 'Button_Switch_THT', label: '6 mm tactile switch',
      pads: [TH(1, 0, 0, 2.0, 1.1), TH(2, 0, 4.5, 2.0, 1.1), TH(1, 6.5, 0, 2.0, 1.1), TH(2, 6.5, 4.5, 2.0, 1.1)],
      silk: [...box(0.25, -0.75, 6.25, 5.25), { c: [3.25, 2.25, 1.75] }] },
    DIP4: dip(4, 7.62, 'DIP-4_W7.62mm'),
    DIP16: dip(16, 7.62, 'DIP-16_W7.62mm'),
    // Arduino Nano: 2 × 15 pins, rows 15.24 mm apart, pin 1 = D1/TX
    Nano: (() => { const f = dip(30, 15.24, 'Arduino_Nano'); f.lib = 'Module'; f.label = 'Arduino Nano (plugs in)';
      f.silk = box(-1.27, -3.9, 16.51, 39.37); return f; })(),
    // Raspberry Pi Pico: 2 × 20 pins, rows 17.78 mm apart, pin 1 = GP0
    Pico: (() => { const f = dip(40, 17.78, 'RPi_Pico_TH'); f.lib = 'Module'; f.label = 'Raspberry Pi Pico (plugs in)';
      f.silk = box(-1.61, -1.63, 19.39, 49.63); return f; })(),
    MountingHole_M3: { name: 'MountingHole_3.2mm_M3', lib: 'MountingHole', label: 'M3 mounting hole',
      pads: [], npth: [{ x: 0, y: 0, d: 3.2 }], silk: [{ c: [0, 0, 3.0] }] }
  };
  function footprint(id) {
    if (FOOTPRINTS[id]) return FOOTPRINTS[id];
    const m = /^H(\d+)$/.exec(id);
    if (m) return header(Number(m[1]));
    return null;
  }

  // canvas part type → footprint + which pad each port lands on.
  // check: true = a stand-in footprint; the user must confirm it fits.
  const PART_FP = {
    resistor: { fp: 'R_Axial', pins: { a: 1, b: 2 }, ref: 'R' },
    ldr: { fp: 'R_Axial', pins: { a: 1, b: 2 }, ref: 'R', check: 'LDR leads vary; 10.16 mm pads accept most 5 mm cells' },
    thermistor: { fp: 'R_Axial', pins: { a: 1, b: 2 }, ref: 'TH', check: 'bead thermistors have short leads; 10.16 mm is for axial ones' },
    fuse: { fp: 'H2', pins: { a: 1, b: 2 }, ref: 'F', check: 'two pads for a fuse holder or pigtail fuse' },
    inductor: { fp: 'R_Axial', pins: { a: 1, b: 2 }, ref: 'L', check: 'axial inductor footprint' },
    capC: { fp: 'C_Disc', pins: { a: 1, b: 2 }, ref: 'C' },
    capE: { fp: 'CP_Radial', pins: { pos: 1, neg: 2 }, ref: 'C' },
    led: { fp: 'LED_5mm', pins: { cathode: 1, anode: 2 }, ref: 'D' },
    diode: { fp: 'D_DO41', pins: { cathode: 1, anode: 2 }, ref: 'D' },
    schottky: { fp: 'D_DO41', pins: { cathode: 1, anode: 2 }, ref: 'D' },
    zener: { fp: 'D_DO41', pins: { cathode: 1, anode: 2 }, ref: 'D' },
    button: { fp: 'SW_6mm', pins: { a: 1, b: 2 }, ref: 'SW' },
    // PN2222A / PN2907A (TO-92): pin 1 E, 2 B, 3 C, flat face towards you
    npn: { fp: 'TO92', pins: { e: 1, b: 2, c: 3 }, ref: 'Q', note: 'PN2222A pinout E-B-C. Other NPNs (BC547: C-B-E) differ: check yours.' },
    pnp: { fp: 'TO92', pins: { e: 1, b: 2, c: 3 }, ref: 'Q', note: 'PN2907A pinout E-B-C. Other PNPs differ: check yours.' },
    // TO-220 MOSFETs (IRLZ44N, IRL540N, IRF9540): G-D-S
    nmos: { fp: 'TO220', pins: { g: 1, d: 2, s: 3 }, ref: 'Q', note: 'TO-220 G-D-S (IRLZ44N, IRL540N)' },
    pmos: { fp: 'TO220', pins: { g: 1, d: 2, s: 3 }, ref: 'Q', note: 'TO-220 G-D-S (IRF9540N)' },
    reg7805: { fp: 'TO220', pins: { in: 1, gnd: 2, out: 3 }, ref: 'U', note: 'L7805 TO-220: IN-GND-OUT. Add the 0.33 µF / 0.1 µF caps.' },
    reg33: { fp: 'SOT223', pins: { gnd: 1, out: 2, in: 3 }, ref: 'U', note: 'AMS1117-3.3 SOT-223: GND-OUT-IN, tab = OUT. Needs 10 µF on IN and OUT.' },
    pc817: { fp: 'DIP4', pins: { anode: 1, cathode: 2, emi: 3, col: 4 }, ref: 'U' },
    uln2003: { fp: 'DIP16', pins: { in1: 1, in2: 2, in3: 3, in4: 4, gnd: 8, com: 9, out4: 13, out3: 14, out2: 15, out1: 16 }, ref: 'U' },
    // HC-SR04 header order is printed on every module: VCC TRIG ECHO GND
    hcsr04: { fp: 'H4', pins: { vcc: 1, trig: 2, echo: 3, gnd: 4 }, ref: 'J' },
    // hobby servo plug: brown GND, red V+, orange signal
    servo: { fp: 'H3', pins: { gnd: 1, vcc: 2, sig: 3 }, ref: 'J', note: 'Servo plug order GND-V+-SIG' },
    // DHT22 bare sensor: 1 VCC, 2 DATA, 3 NC, 4 GND
    dht22: { fp: 'H4', pins: { vcc: 1, data: 2, gnd: 4 }, ref: 'U', note: 'Bare DHT22: VCC, DATA, NC, GND. Add a 10k pull-up on DATA.' }
  };
  // everything else: a header in the part's own port order
  const NOT_ON_PCB = new Set(['voltmeter', 'ammeter']);

  function partFootprint(part, def) {
    const known = PART_FP[part.type];
    if (known) return { ...known, fpDef: footprint(known.fp) };
    const ports = (def && def.ports) || [];
    const pins = {};
    ports.forEach((p, i) => { pins[p.id] = i + 1; });
    const ref = /bat|psu|lipo|cr2032|solar/.test(part.type) ? 'BT' : /motor|stepper|buzzer/.test(part.type) ? 'M' : 'J';
    return { fp: 'H' + Math.max(1, ports.length), pins, ref, fpDef: footprint('H' + Math.max(1, ports.length)),
             check: 'connector for an off-board ' + ((def && def.name) || part.type) + ', pins in the order ' + ports.map((p) => p.label).join(', ') };
  }

  // ---- netlist from the canvas -----------------------------------------------
  // the board's own pins → physical pin numbers for boards that plug in
  const BOARD_PINS = {
    nano: (i) => (i <= 14 ? i + 1 : [30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 17, 16][i - 15]),
    pico: (i) => (i <= 19 ? i + 1 : 60 - i)
  };
  const BOARD_FP = { nano: 'Nano', pico: 'Pico' };
  const BOARD_FP_SET = { Nano: true, Pico: true };

  function valueOf(p) {
    const ohm = (r) => (r >= 1e6 ? +(r / 1e6).toFixed(2) + 'M' : r >= 1e3 ? +(r / 1e3).toFixed(2) + 'k' : String(r));
    if (p.type === 'resistor') return ohm(p.r || 220);
    if (p.type === 'ldr' || p.type === 'thermistor') return ohm(p.r || 10000);
    if (p.type === 'led') return 'LED ' + (p.color || 'red');
    if (p.type === 'capE') return 'C ' + (p.vr || 16) + 'V';
    if (p.type === 'fuse') return (p.r || 1) + 'A';
    return '';
  }

  // model: the wiring.json canvas; boardDef: PINODE_BOARDS entry; boardId its key
  function netlist(model, boardDef, boardId, partDefs) {
    const defs = partDefs || [];
    const parent = new Map();
    const find = (x) => { if (!parent.has(x)) parent.set(x, x); while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    const unite = (a, b) => parent.set(find(a), find(b));
    for (const w of model.wires || []) unite(w.from, w.to);
    // an ammeter is a wire on a real board; a voltmeter isn't there at all
    for (const p of model.parts || []) if (p.type === 'ammeter') unite('part:' + p.uid + ':pos', 'part:' + p.uid + ':neg');

    const comps = [];
    const counters = {};
    const nextRef = (pre) => { counters[pre] = (counters[pre] || 0) + 1; return pre + counters[pre]; };
    const usedBoard = new Set();
    for (const w of model.wires || []) for (const k of [w.from, w.to]) if (k.startsWith('board:')) usedBoard.add(Number(k.split(':')[1]));
    if (boardDef && usedBoard.size) {
      if (BOARD_FP[boardId]) {
        const map = BOARD_PINS[boardId];
        const pads = boardDef.pins.map((pin, i) => ({ key: 'board:' + i, pad: String(map(i)), label: pin.label }));
        comps.push({ ref: 'A1', uid: 0, type: 'board', name: boardDef.name, value: boardDef.name, fp: BOARD_FP[boardId], pads });
      } else {
        // boards that don't plug into a PCB connect through a header of the pins used
        const used = [...usedBoard].sort((a, b) => a - b);
        comps.push({ ref: 'J' + 'B', uid: 0, type: 'board', name: boardDef.name + ' connector', value: boardDef.name,
          fp: 'H' + used.length, check: 'wires to the ' + boardDef.name + '; header pins: ' + used.map((i) => boardDef.pins[i].label).join(', '),
          pads: used.map((i, n) => ({ key: 'board:' + i, pad: String(n + 1), label: boardDef.pins[i].label })) });
      }
    }
    for (const p of model.parts || []) {
      if (NOT_ON_PCB.has(p.type)) continue;
      const def = defs.find((d) => d.type === p.type);
      const f = partFootprint(p, def);
      const pads = Object.entries(f.pins).map(([port, pad]) => ({ key: 'part:' + p.uid + ':' + port, pad: String(pad),
        label: (def && (def.ports.find((x) => x.id === port) || {}).label) || port }));
      comps.push({ ref: nextRef(f.ref), uid: p.uid, type: p.type, name: p.name || (def && def.name) || p.type, value: valueOf(p) || p.name || '',
        fp: f.fp, pads, check: f.check || '', note: f.note || '', catalogId: p.catalogId || null });
    }
    // nets: group pad keys by root; name them after power pins / board pins
    const groups = new Map();
    for (const c of comps) for (const pd of c.pads) {
      const r = find(pd.key);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push({ ref: c.ref, pad: pd.pad, key: pd.key });
    }
    const nets = [];
    let anon = 0;
    const POWER = { gnd: 'GND', v5: '+5V', v33: '+3V3', vin: 'VIN' };
    const taken = new Set();
    for (const nodes of groups.values()) {
      if (nodes.length < 2) continue;
      let name = '';
      for (const n of nodes) {
        if (!n.key.startsWith('board:') || !boardDef) continue;
        const pin = boardDef.pins[Number(n.key.split(':')[1])];
        if (pin && pin.power && POWER[pin.power]) { name = POWER[pin.power]; break; }
        if (pin && !name) name = pin.label.replace(/^~/, '').split('/')[0];
      }
      if (!name || (taken.has(name) && !Object.values(POWER).includes(name))) name = 'N' + (++anon);
      taken.add(name);
      nets.push({ name, nodes: nodes.map(({ ref, pad }) => ({ ref, pad })) });
    }
    // merge nets that share a name (several GND pins on the board are one net)
    const merged = [];
    for (const n of nets) {
      const ex = merged.find((m) => m.name === n.name);
      if (ex) ex.nodes.push(...n.nodes); else merged.push(n);
    }
    return { comps, nets: merged };
  }

  // ---- geometry ----------------------------------------------------------------
  // placement: { x, y, rot (0|90|180|270), side ('F'|'B') }; pads rotate about
  // the footprint origin, bottom-side parts are mirrored in X
  function xform(pl, x, y) {
    let px = pl.side === 'B' ? -x : x, py = y;
    const r = ((pl.rot || 0) % 360 + 360) % 360;
    let qx = px, qy = py;
    if (r === 90) { qx = -py; qy = px; } else if (r === 180) { qx = -px; qy = -py; } else if (r === 270) { qx = py; qy = -px; }
    return [pl.x + qx, pl.y + qy];
  }
  function padsWorld(comp, pl) {
    const f = footprint(comp.fp);
    if (!f) return [];
    const swap = (pl.rot || 0) % 180 === 90;
    // per-part override of the through-hole pads: { dia, drill } in mm.
    // dia scales the pad so its narrow side is dia (oval pads keep their shape)
    const ov = pl.pad || null;
    return f.pads.map((p0) => {
      let p = p0;
      if (ov && p0.drill) {
        const k = ov.dia > 0 ? ov.dia / Math.min(p0.w, p0.h) : 1;
        p = { ...p0, w: +(p0.w * k).toFixed(3), h: +(p0.h * k).toFixed(3), drill: ov.drill > 0 ? ov.drill : p0.drill };
      }
      const [x, y] = xform(pl, p.x, p.y);
      return { ...p, x, y, w: swap ? p.h : p.w, h: swap ? p.w : p.h, ref: comp.ref,
               layers: p.drill ? ['F', 'B'] : [pl.side === 'B' ? 'B' : 'F'] };
    });
  }
  function bboxOf(comp, pl) {
    const f = footprint(comp.fp);
    const pts = [];
    for (const p of f.pads) { pts.push(xform(pl, p.x - p.w / 2, p.y - p.h / 2), xform(pl, p.x + p.w / 2, p.y + p.h / 2)); }
    for (const s of f.silk || []) {
      if (s.l) pts.push(xform(pl, s.l[0], s.l[1]), xform(pl, s.l[2], s.l[3]));
      if (s.c) pts.push(xform(pl, s.c[0] - s.c[2], s.c[1] - s.c[2]), xform(pl, s.c[0] + s.c[2], s.c[1] + s.c[2]));
    }
    for (const h of f.npth || []) pts.push(xform(pl, h.x - h.d / 2, h.y - h.d / 2), xform(pl, h.x + h.d / 2, h.y + h.d / 2));
    if (!pts.length) return { x1: pl.x, y1: pl.y, x2: pl.x, y2: pl.y };
    return { x1: Math.min(...pts.map((p) => p[0])), y1: Math.min(...pts.map((p) => p[1])),
             x2: Math.max(...pts.map((p) => p[0])), y2: Math.max(...pts.map((p) => p[1])) };
  }

  const GRID = 0.635;   // 25 mil
  const snap = (v, g = GRID) => Math.round(v / g) * g;

  // first placement: shelf-pack footprints left to right, biggest first,
  // with 2.54 mm between them, then size the board around them
  function autoPlace(net, existing, opts) {
    const place = { ...(existing || {}) };
    const todo = net.comps.filter((c) => !place[c.ref]);
    const sizeOf = (c) => { const b = bboxOf(c, { x: 0, y: 0, rot: 0, side: 'F' }); return { w: b.x2 - b.x1, h: b.y2 - b.y1, ox: -b.x1, oy: -b.y1 }; };
    todo.sort((a, b) => sizeOf(b).h - sizeOf(a).h);
    const margin = (opts && opts.margin) || 3.81, gap = 2.54, maxW = 80;
    let x = margin, y = margin, rowH = 0;
    // start below anything already placed
    for (const [ref, pl] of Object.entries(place)) {
      const c = net.comps.find((q) => q.ref === ref);
      if (c) y = Math.max(y, bboxOf(c, pl).y2 + gap);
    }
    for (const c of todo) {
      const s = sizeOf(c);
      if (x + s.w > maxW && x > margin) { x = margin; y += rowH + gap; rowH = 0; }
      place[c.ref] = { x: snap(x + s.ox), y: snap(y + s.oy), rot: 0, side: 'F' };
      x += s.w + gap; rowH = Math.max(rowH, s.h);
    }
    return place;
  }
  function fitBoard(net, place, margin = 3) {
    let x2 = 10, y2 = 10;
    for (const c of net.comps) { const pl = place[c.ref]; if (!pl) continue; const b = bboxOf(c, pl); x2 = Math.max(x2, b.x2); y2 = Math.max(y2, b.y2); }
    return { w: Math.ceil((x2 + margin) / 0.5) * 0.5, h: Math.ceil((y2 + margin) / 0.5) * 0.5 };
  }

  // ---- distance helpers --------------------------------------------------------
  function ptSeg(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1, L = dx * dx + dy * dy;
    let t = L ? ((px - x1) * dx + (py - y1) * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }
  function segSeg(a, b) {
    const [x1, y1, x2, y2] = a, [x3, y3, x4, y4] = b;
    const d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
    if (d) {
      const t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d, u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
    }
    return Math.min(ptSeg(x1, y1, x3, y3, x4, y4), ptSeg(x2, y2, x3, y3, x4, y4), ptSeg(x3, y3, x1, y1, x2, y2), ptSeg(x4, y4, x1, y1, x2, y2));
  }
  // every copper object as a capsule (segment + radius) or a rectangle
  function padShape(p) {
    if (p.shape === 'rect') return { rect: [p.x - p.w / 2, p.y - p.h / 2, p.x + p.w / 2, p.y + p.h / 2] };
    if (p.shape === 'oval' && p.w !== p.h) {
      const r = Math.min(p.w, p.h) / 2, e = (Math.max(p.w, p.h) - Math.min(p.w, p.h)) / 2;
      return p.w > p.h ? { seg: [p.x - e, p.y, p.x + e, p.y], r } : { seg: [p.x, p.y - e, p.x, p.y + e], r };
    }
    return { seg: [p.x, p.y, p.x, p.y], r: p.w / 2 };
  }
  function rectEdges(r) { const [a, b, c, d] = r; return [[a, b, c, b], [c, b, c, d], [c, d, a, d], [a, d, a, b]]; }
  function inRect(x, y, r) { return x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]; }
  // gap between two shapes (≤ 0 = touching/overlapping)
  function gap(s1, s2) {
    if (s1.seg && s2.seg) return segSeg(s1.seg, s2.seg) - s1.r - s2.r;
    if (s1.rect && s2.rect) {
      const [a, b] = [s1.rect, s2.rect];
      const dx = Math.max(0, Math.max(a[0], b[0]) - Math.min(a[2], b[2])), dy = Math.max(0, Math.max(a[1], b[1]) - Math.min(a[3], b[3]));
      return Math.hypot(dx, dy) * ((dx || dy) ? 1 : -1);
    }
    const s = s1.seg ? s1 : s2, r = s1.rect ? s1.rect : s2.rect;
    if (inRect(s.seg[0], s.seg[1], r) || inRect(s.seg[2], s.seg[3], r)) return -s.r;
    return Math.min(...rectEdges(r).map((e) => segSeg(s.seg, e))) - s.r;
  }

  // ---- layer stack ---------------------------------------------------------------
  // copper layer ids top to bottom: F, In1..In4, B. A 1-layer board has its
  // copper on the bottom only (parts on top, soldered underneath), the way
  // single-sided through-hole boards are made.
  const INNER = ['In1', 'In2', 'In3', 'In4'];
  const STACKS = [1, 2, 4, 6];
  function layerCount(layout) { const n = Number(layout && layout.stack && layout.stack.count); return STACKS.includes(n) ? n : 2; }
  function copperLayers(layout) { const n = layerCount(layout); return n === 1 ? ['B'] : ['F', ...INNER.slice(0, n - 2), 'B']; }
  function layerLabel(id) { return id === 'F' ? 'Top copper' : id === 'B' ? 'Bottom copper' : id && id.startsWith('In') ? 'Inner ' + id.slice(2) : String(id); }
  // the net an inner layer is a solid plane of ('' = a signal layer)
  function planeNet(layout, id) { const p = layout && layout.stack && layout.stack.planes; return (p && INNER.includes(id) && copperLayers(layout).includes(id) && p[id]) || ''; }
  // through-hole pads have copper on every layer; SMD pads on their side only
  function padLayers(p, CL) { return p.drill ? CL.slice() : p.layers.slice(); }
  // file name, Gerber extension and X2 file function for each copper layer
  function copperFile(layout, id) {
    const CL = copperLayers(layout), i = CL.indexOf(id);
    const pos = id === 'F' ? 'Top' : id === 'B' ? 'Bot' : 'Inr';
    return { name: id + '_Cu', ext: id === 'F' ? 'gtl' : id === 'B' ? 'gbl' : 'g' + id.slice(2),
      func: 'Copper,L' + (i + 1) + ',' + pos + (pos === 'Inr' ? ',' + (planeNet(layout, id) ? 'Plane' : 'Signal') : '') };
  }
  // mounting holes and footprint NPTH holes
  function npthHoles(layout, net) {
    const out = (layout.holes || []).map((h) => ({ x: h.x, y: h.y, d: h.d }));
    for (const c of net.comps) { const pl = layout.place[c.ref]; if (!pl) continue; const f = footprint(c.fp); for (const h of f.npth || []) { const [x, y] = xform(pl, h.x, h.y); out.push({ x, y, d: h.d }); } }
    return out;
  }

  // ---- copper zones: inner planes and pours ------------------------------------------
  // A zone fills its outline with copper of one net, keeping its clearance from
  // other nets and holes. Same-net pads join through four thermal spokes (or
  // solidly), traces and vias of the net join solidly. The same list of shapes
  // drives the on-screen fill, the connectivity check and the Gerber, so what
  // you see is what the fab gets.
  const ZONE_CLEAR = 0.3;
  function pointInPoly(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  const growShape = (sh, c) => (sh.rect ? { rect: [sh.rect[0] - c, sh.rect[1] - c, sh.rect[2] + c, sh.rect[3] + c] } : { seg: sh.seg, r: sh.r + c });
  const inShape = (x, y, sh) => (sh.rect ? inRect(x, y, sh.rect) : ptSeg(x, y, sh.seg[0], sh.seg[1], sh.seg[2], sh.seg[3]) <= sh.r);
  const shapeBox = (sh) => (sh.rect ? sh.rect : [Math.min(sh.seg[0], sh.seg[2]) - sh.r, Math.min(sh.seg[1], sh.seg[3]) - sh.r, Math.max(sh.seg[0], sh.seg[2]) + sh.r, Math.max(sh.seg[1], sh.seg[3]) + sh.r]);
  function zonesOf(layout, R) {
    const CL = copperLayers(layout), B = layout.board, out = [];
    const e = Math.max(R.edge, R.clearance);
    const clamp = (pts) => pts.map(([x, y]) => [Math.min(B.w - e, Math.max(e, x)), Math.min(B.h - e, Math.max(e, y))]);
    const pc = Math.max(R.clearance, Number(layout.stack && layout.stack.clearance) || ZONE_CLEAR);
    for (const id of CL) {
      const n = planeNet(layout, id);
      if (n) out.push({ src: 'plane', layer: id, net: n, clearance: pc, thermal: true, poly: clamp([[0, 0], [B.w, 0], [B.w, B.h], [0, B.h]]) });
    }
    (layout.pours || []).forEach((p, i) => {
      if (!p || !Array.isArray(p.pts) || p.pts.length < 3) return;
      out.push({ src: 'pour', i, layer: p.layer, net: p.net || '', clearance: Math.max(R.clearance, Number(p.clearance) || ZONE_CLEAR), thermal: p.thermal !== false, poly: clamp(p.pts), onBoard: CL.includes(p.layer) });
    });
    return out;
  }
  // the shapes that make a zone, in drawing order
  function zoneOps(zone, items, holes, spoke) {
    const gapClear = [], spokes = [], clear = [];
    for (const it of items) {
      if (!it.layers.includes(zone.layer)) continue;
      if (it.net && it.net === zone.net) {
        if (it.kind === 'pad' && zone.thermal) {
          gapClear.push(growShape(it.shape, zone.clearance));
          const p = it.pad;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const len = (dx ? p.w : p.h) / 2 + zone.clearance + 0.25;
            const ex = p.x + dx * len, ey = p.y + dy * len;
            if (pointInPoly(ex, ey, zone.poly)) spokes.push({ seg: [p.x, p.y, ex, ey], r: spoke / 2 });
          }
        }
        continue;
      }
      clear.push(growShape(it.shape, zone.clearance));
    }
    for (const h of holes) clear.push({ seg: [h.x, h.y, h.x, h.y], r: h.d / 2 + zone.clearance });
    return { gapClear, spokes, clear };
  }
  // raster of a zone on the board's own grid: 1 = copper; lab = island number
  function fillZone(zone, ops, B, res) {
    const nx = Math.max(1, Math.ceil(B.w / res)), ny = Math.max(1, Math.ceil(B.h / res));
    const grid = new Uint8Array(nx * ny);
    const poly = zone.poly;
    for (let j = 0; j < ny; j++) {
      const y = (j + 0.5) * res, xs = [];
      for (let i = 0, k = poly.length - 1; i < poly.length; k = i++) {
        const [x1, y1] = poly[i], [x2, y2] = poly[k];
        if ((y1 > y) !== (y2 > y)) xs.push(x1 + (y - y1) * (x2 - x1) / (y2 - y1));
      }
      xs.sort((a, b) => a - b);
      for (let q = 0; q + 1 < xs.length; q += 2) {
        const i0 = Math.max(0, Math.ceil(xs[q] / res - 0.5)), i1 = Math.min(nx - 1, Math.floor(xs[q + 1] / res - 0.5));
        for (let i = i0; i <= i1; i++) grid[j * nx + i] = 1;
      }
    }
    const paint = (sh, v, inPoly) => {
      const b = shapeBox(sh);
      const i0 = Math.max(0, Math.floor(b[0] / res)), i1 = Math.min(nx - 1, Math.floor(b[2] / res));
      const j0 = Math.max(0, Math.floor(b[1] / res)), j1 = Math.min(ny - 1, Math.floor(b[3] / res));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x = (i + 0.5) * res, y = (j + 0.5) * res;
        if (inShape(x, y, sh) && (!inPoly || pointInPoly(x, y, poly))) grid[j * nx + i] = v;
      }
    };
    for (const sh of ops.gapClear) paint(sh, 0);
    for (const sh of ops.spokes) paint({ seg: sh.seg, r: Math.max(sh.r, res * 0.55) }, 1, true);
    for (const sh of ops.clear) paint(sh, 0);
    const lab = new Int32Array(nx * ny).fill(-1);
    const sizes = [];
    const stack = new Int32Array(nx * ny);
    for (let s0 = 0; s0 < grid.length; s0++) {
      if (!grid[s0] || lab[s0] >= 0) continue;
      const id = sizes.length; let n = 0, top = 0;
      stack[top++] = s0; lab[s0] = id;
      while (top) {
        const c = stack[--top]; n++;
        const ci = c % nx;
        if (ci > 0 && grid[c - 1] && lab[c - 1] < 0) { lab[c - 1] = id; stack[top++] = c - 1; }
        if (ci < nx - 1 && grid[c + 1] && lab[c + 1] < 0) { lab[c + 1] = id; stack[top++] = c + 1; }
        if (c >= nx && grid[c - nx] && lab[c - nx] < 0) { lab[c - nx] = id; stack[top++] = c - nx; }
        if (c + nx < grid.length && grid[c + nx] && lab[c + nx] < 0) { lab[c + nx] = id; stack[top++] = c + nx; }
      }
      sizes.push(n);
    }
    return { res, nx, ny, grid, lab, sizes, count: sizes.length };
  }
  // copper, zones and connectivity for a layout, cached until something changes
  let ACACHE = null;
  function analyze(layout, net, rules) {
    const R = { ...RULES, ...(rules || {}) };
    const key = JSON.stringify([layout.board, layout.place, layout.traces, layout.vias, layout.holes, layout.stack, layout.pours, R]);
    if (ACACHE && ACACHE.net === net && ACACHE.key === key) return ACACHE.val;
    const items = copperItems(layout, net);
    const holes = npthHoles(layout, net);
    const B = layout.board;
    const res = Math.max(0.1, Math.sqrt((B.w * B.h) / 400000));
    const spoke = Math.max(R.minTrace, 0.3);
    const zones = zonesOf(layout, R);
    const links = [];
    let nodes = items.length;
    for (const z of zones) {
      if (!z.net || !z.onBoard && z.src === 'pour') { z.fill = null; continue; }
      z.ops = zoneOps(z, items, holes, spoke);
      z.fill = fillZone(z, z.ops, B, res);
      z.base = nodes; nodes += z.fill.count;
      z.used = new Uint8Array(z.fill.count);
      const F = z.fill;
      items.forEach((it, idx) => {
        if (!it.layers.includes(z.layer) || it.net !== z.net) return;
        const b = shapeBox(it.shape), seen = new Set();
        const i0 = Math.max(0, Math.floor(b[0] / res)), i1 = Math.min(F.nx - 1, Math.floor(b[2] / res));
        const j0 = Math.max(0, Math.floor(b[1] / res)), j1 = Math.min(F.ny - 1, Math.floor(b[3] / res));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const l = F.lab[j * F.nx + i];
          if (l >= 0 && !seen.has(l) && inShape((i + 0.5) * res, (j + 0.5) * res, growShape(it.shape, res * 0.5))) seen.add(l);
        }
        for (const l of seen) { links.push([idx, z.base + l]); z.used[l] = 1; }
      });
    }
    const island = connectivity(items, links, nodes);
    const val = { R, items, holes, zones, island, layers: copperLayers(layout) };
    ACACHE = { net, key, val };
    return val;
  }

  // ---- copper items & connectivity ----------------------------------------------
  function copperItems(layout, net) {
    const CL = copperLayers(layout);
    const items = [];
    for (const c of net.comps) {
      const pl = layout.place[c.ref];
      if (!pl) continue;
      for (const p of padsWorld(c, pl)) {
        const nn = (net.nets.find((n) => n.nodes.some((q) => q.ref === c.ref && q.pad === p.num)) || {}).name || '';
        items.push({ kind: 'pad', ref: c.ref, num: p.num, layers: padLayers(p, CL), shape: padShape(p), net: nn, pad: p, internal: c.type === 'board' && !!BOARD_FP_SET[c.fp] });
      }
    }
    (layout.traces || []).forEach((t, ti) => {
      for (let i = 0; i + 1 < t.pts.length; i++) {
        items.push({ kind: 'trace', ti, seg: i, layers: [t.layer], shape: { seg: [t.pts[i][0], t.pts[i][1], t.pts[i + 1][0], t.pts[i + 1][1]], r: t.w / 2 }, net: t.net || '', w: t.w });
      }
    });
    (layout.vias || []).forEach((v, vi) => items.push({ kind: 'via', vi, layers: CL.slice(), shape: { seg: [v.x, v.y, v.x, v.y], r: v.dia / 2 }, net: v.net || '', via: v }));
    return items;
  }
  // which items are electrically joined by copper (touching on a shared layer)
  // extra links join items to zone islands (node numbers past the items)
  function connectivity(items, links, nodes) {
    const parent = Array.from({ length: Math.max(items.length, nodes || 0) }, (_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      if (!a.layers.some((l) => b.layers.includes(l))) continue;
      if (a.kind === 'pad' && b.kind === 'pad') continue;   // pads only join through copper
      if (gap(a.shape, b.shape) <= 1e-6) parent[find(i)] = find(j);
    }
    // the same pad number twice in one footprint is joined inside the part
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      if (a.kind === 'pad' && b.kind === 'pad' && a.ref === b.ref && a.num === b.num) parent[find(i)] = find(j);
      // a plug-in board's GND pins are joined on the board itself
      if (a.kind === 'pad' && b.kind === 'pad' && a.ref === b.ref && a.internal && a.net && a.net === b.net) parent[find(i)] = find(j);
    }
    for (const [a, b] of links || []) parent[find(a)] = find(b);
    return items.map((_, i) => find(i));
  }
  // unrouted connections: per net, a minimum spanning tree over the copper
  // islands that still need joining, drawn pad to nearest pad
  function ratsnest(layout, net, rules) {
    const { items, island } = analyze(layout, net, rules || layout.rules);
    const lines = [];
    for (const n of net.nets) {
      const pads = items.map((it, i) => ({ it, i })).filter(({ it }) => it.kind === 'pad' && it.net === n.name);
      const groups = new Map();
      for (const p of pads) { const k = island[p.i]; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p.it.pad); }
      const g = [...groups.values()];
      if (g.length < 2) continue;
      const inTree = [g[0]];
      const rest = g.slice(1);
      while (rest.length) {
        let best = null;
        for (let ri = 0; ri < rest.length; ri++) for (const a of rest[ri]) for (const t of inTree) for (const b of t) {
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (!best || d < best.d) best = { d, ri, a, b };
        }
        lines.push({ net: n.name, x1: best.b.x, y1: best.b.y, x2: best.a.x, y2: best.a.y });
        inTree.push(rest[best.ri]);
        rest.splice(best.ri, 1);
      }
    }
    return lines;
  }

  // ---- design rules ------------------------------------------------------------
  // conservative 2-layer limits that every mainstream fab (JLCPCB, PCBWay,
  // OSH Park, Aisler) meets with room to spare
  const RULES = { clearance: 0.2, minTrace: 0.2, minDrill: 0.3, minAnnular: 0.15, edge: 0.3, viaDrill: 0.4, viaDia: 0.8 };
  function drc(layout, net, rules) {
    const R = { ...RULES, ...(rules || {}) };
    const out = [];
    const add = (sev, msg, x, y) => out.push({ severity: sev, message: msg, x, y });
    const A = analyze(layout, net, R);
    const { items, island } = A;
    const CL = A.layers;
    const at = (it) => (it.shape.seg ? [it.shape.seg[0], it.shape.seg[1]] : [(it.shape.rect[0] + it.shape.rect[2]) / 2, (it.shape.rect[1] + it.shape.rect[3]) / 2]);
    const label = (it) => (it.kind === 'pad' ? it.ref + ' pad ' + it.num : it.kind === 'via' ? 'via' : 'trace');
    // copper of different nets too close, or shorted
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      if (!a.layers.some((l) => b.layers.includes(l))) continue;
      if (a.kind === 'pad' && b.kind === 'pad' && a.ref === b.ref) continue;
      const g = gap(a.shape, b.shape);
      const netA = a.net || null, netB = b.net || null;
      if (netA && netB && netA === netB) continue;
      if (g <= 1e-6 && netA && netB) { add('error', `Short: ${label(a)} (${netA}) touches ${label(b)} (${netB})`, ...at(a)); continue; }
      if (g < R.clearance - 1e-6 && !(island[i] === island[j] && (!netA || !netB))) {
        if (g <= 1e-6) continue;   // touching unassigned copper just extends that net
        add('error', `Clearance ${g.toFixed(2)} mm between ${label(a)} and ${label(b)} (needs ${R.clearance} mm)`, ...at(a));
      }
    }
    // an island holding pads of two nets is a short through traces
    const islandNets = new Map();
    items.forEach((it, i) => { if (it.kind === 'pad' && it.net) { const s = islandNets.get(island[i]) || new Set(); s.add(it.net); islandNets.set(island[i], s); } });
    for (const s of islandNets.values()) if (s.size > 1) add('error', 'Short between nets ' + [...s].join(' and ') + ' through copper', null, null);
    for (const t of layout.traces || []) {
      if (t.w < R.minTrace - 1e-6) add('error', `Trace ${t.w} mm is thinner than ${R.minTrace} mm`, t.pts[0][0], t.pts[0][1]);
      if (!CL.includes(t.layer)) add('error', `A trace is on ${layerLabel(t.layer)}, which a ${CL.length}-layer board doesn't have`, t.pts[0][0], t.pts[0][1]);
    }
    if (CL.length === 1 && (layout.vias || []).length) add('error', `${layout.vias.length} via${layout.vias.length === 1 ? '' : 's'} on a 1-layer board: there is no other layer to reach`, layout.vias[0].x, layout.vias[0].y);
    for (const it of items) if (it.kind === 'pad' && !it.pad.drill && !CL.includes(it.layers[0])) {
      add('error', `${it.ref} is a surface-mount part on the top, but a 1-layer board only has bottom copper: flip it (F)`, it.pad.x, it.pad.y);
    }
    // zones: planes and pours
    const netNames = new Set(net.nets.map((n) => n.name));
    for (const z of A.zones) {
      const what = z.src === 'plane' ? `${z.net} plane on ${layerLabel(z.layer)}` : `Pour on ${layerLabel(z.layer)}`;
      const [px, py] = z.poly[0];
      if (z.src === 'pour' && !z.onBoard) { add('error', `${what}: this board has no such layer`, px, py); continue; }
      if (!z.net) { add('warning', `${what} has no net yet, so it is left out of the Gerbers: pick one (GND is usual)`, px, py); continue; }
      if (!netNames.has(z.net)) add('warning', `${what}: no net called ${z.net} on the wiring canvas, so it connects to nothing`, px, py);
      if (!z.fill) continue;
      const linked = z.used.reduce((a, b) => a + b, 0);
      if (!linked && netNames.has(z.net)) add('warning', `${what} (${z.net}) touches no ${z.net} pad, trace or via`, px, py);
      const loose = z.fill.sizes.filter((n, i) => !z.used[i] && n * z.fill.res * z.fill.res > 0.5).length;
      if (loose && linked) add('warning', `${what} (${z.net}) has ${loose} island${loose === 1 ? '' : 's'} of copper cut off from the rest; add a via or trace to join ${loose === 1 ? 'it' : 'them'}, or shrink the pour`, px, py);
    }
    // zones of different nets on one layer must keep apart
    for (let i = 0; i < A.zones.length; i++) for (let j = i + 1; j < A.zones.length; j++) {
      const a = A.zones[i], b = A.zones[j];
      if (!a.fill || !b.fill || a.layer !== b.layer || a.net === b.net) continue;
      const F = a.fill, k = Math.ceil(Math.max(a.clearance, b.clearance) / F.res);
      let hitAt = -1;
      for (let c = 0; c < F.grid.length && hitAt < 0; c++) {
        if (!F.grid[c]) continue;
        const ci = c % F.nx, cj = (c - ci) / F.nx;
        for (let dj = -k; dj <= k && hitAt < 0; dj++) for (let di = -k; di <= k; di++) {
          const ii = ci + di, jj = cj + dj;
          if (ii >= 0 && jj >= 0 && ii < F.nx && jj < F.ny && b.fill.grid[jj * F.nx + ii]) { hitAt = c; break; }
        }
      }
      if (hitAt >= 0) add('error', `${a.net} and ${b.net} copper areas overlap or come too close on ${layerLabel(a.layer)}`, ((hitAt % F.nx) + 0.5) * F.res, (Math.floor(hitAt / F.nx) + 0.5) * F.res);
    }
    const holes = [];
    for (const it of items) {
      if (it.kind === 'pad' && it.pad.drill) holes.push({ x: it.pad.x, y: it.pad.y, d: it.pad.drill, ring: (Math.min(it.pad.w, it.pad.h) - it.pad.drill) / 2, what: label(it) });
      if (it.kind === 'via') holes.push({ x: it.via.x, y: it.via.y, d: it.via.drill, ring: (it.via.dia - it.via.drill) / 2, what: 'via' });
    }
    for (const h of holes) {
      if (h.d < R.minDrill - 1e-6) add('error', `${h.what}: drill ${h.d} mm is under ${R.minDrill} mm`, h.x, h.y);
      if (h.ring < R.minAnnular - 1e-6) add('error', `${h.what}: annular ring ${h.ring.toFixed(2)} mm is under ${R.minAnnular} mm`, h.x, h.y);
    }
    // board edge
    const B = layout.board;
    for (const it of items) {
      const s = it.shape;
      const ext = s.rect ? s.rect : [Math.min(s.seg[0], s.seg[2]) - s.r, Math.min(s.seg[1], s.seg[3]) - s.r, Math.max(s.seg[0], s.seg[2]) + s.r, Math.max(s.seg[1], s.seg[3]) + s.r];
      if (ext[0] < R.edge || ext[1] < R.edge || ext[2] > B.w - R.edge || ext[3] > B.h - R.edge) {
        add('error', `${label(it)} is closer than ${R.edge} mm to the board edge (or outside it)`, ...at(it));
      }
    }
    // mounting holes: unplated, so copper must stay clear of the hole and the screw head
    for (const h of layout.holes || []) {
      const keep = h.d / 2 + R.clearance;
      for (const it of items) {
        const sh = it.shape;
        const d = sh.rect ? Math.hypot(Math.max(sh.rect[0] - h.x, 0, h.x - sh.rect[2]), Math.max(sh.rect[1] - h.y, 0, h.y - sh.rect[3]))
          : ptSeg(h.x, h.y, sh.seg[0], sh.seg[1], sh.seg[2], sh.seg[3]) - sh.r;
        if (d < keep) { add('error', `Mounting hole at ${h.x.toFixed(1)}, ${h.y.toFixed(1)} mm cuts into ${label(it)}`, h.x, h.y); break; }
      }
      for (const c of net.comps) {
        const pl = layout.place[c.ref];
        if (!pl) continue;
        const b = bboxOf(c, pl);
        const head = 3;                     // M3 screw head radius
        if (h.x + head > b.x1 && h.x - head < b.x2 && h.y + head > b.y1 && h.y - head < b.y2) { add('warning', `Mounting hole at ${h.x.toFixed(1)}, ${h.y.toFixed(1)} mm sits under ${c.ref}`, h.x, h.y); break; }
      }
    }
    for (const h of layout.holes || []) {
      if (h.x - h.d / 2 < R.edge || h.y - h.d / 2 < R.edge || h.x + h.d / 2 > B.w - R.edge || h.y + h.d / 2 > B.h - R.edge) add('error', 'Mounting hole too close to the edge', h.x, h.y);
    }
    // overlapping parts on the same side
    const comps = net.comps.filter((c) => layout.place[c.ref]);
    for (let i = 0; i < comps.length; i++) for (let j = i + 1; j < comps.length; j++) {
      const pa = layout.place[comps[i].ref], pb = layout.place[comps[j].ref];
      if (pa.side !== pb.side) continue;
      const a = bboxOf(comps[i], pa), b = bboxOf(comps[j], pb);
      if (a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2) add('warning', `${comps[i].ref} and ${comps[j].ref} overlap`, pa.x, pa.y);
    }
    const rn = ratsnest(layout, net, R);
    if (rn.length) add('error', `${rn.length} connection${rn.length === 1 ? '' : 's'} not routed yet (the thin lines)`, rn[0].x1, rn[0].y1);
    for (const c of net.comps) if (c.check) add('info', `${c.ref}: ${c.check}`, layout.place[c.ref] && layout.place[c.ref].x, layout.place[c.ref] && layout.place[c.ref].y);
    for (const c of net.comps) if (c.note) add('info', `${c.ref}: ${c.note}`, layout.place[c.ref] && layout.place[c.ref].x, layout.place[c.ref] && layout.place[c.ref].y);
    return out;
  }

  // ---- stroke font for silkscreen (references) -----------------------------------
  // glyphs on a 4 × 6 grid as polylines; height 6 units
  const GLYPHS = {
    A: [[0, 6, 0, 2, 2, 0, 4, 2, 4, 6], [0, 3.5, 4, 3.5]], B: [[0, 6, 0, 0, 3, 0, 4, 1, 4, 2, 3, 3, 0, 3], [3, 3, 4, 4, 4, 5, 3, 6, 0, 6]],
    C: [[4, 1, 3, 0, 1, 0, 0, 1, 0, 5, 1, 6, 3, 6, 4, 5]], D: [[0, 0, 0, 6, 2.5, 6, 4, 4.5, 4, 1.5, 2.5, 0, 0, 0]],
    E: [[4, 0, 0, 0, 0, 6, 4, 6], [0, 3, 3, 3]], F: [[4, 0, 0, 0, 0, 6], [0, 3, 3, 3]],
    G: [[4, 1, 3, 0, 1, 0, 0, 1, 0, 5, 1, 6, 3, 6, 4, 5, 4, 3.5, 2.5, 3.5]], H: [[0, 0, 0, 6], [4, 0, 4, 6], [0, 3, 4, 3]],
    I: [[1, 0, 3, 0], [2, 0, 2, 6], [1, 6, 3, 6]], J: [[4, 0, 4, 5, 3, 6, 1, 6, 0, 5]], K: [[0, 0, 0, 6], [4, 0, 0, 4], [1.3, 2.7, 4, 6]],
    L: [[0, 0, 0, 6, 4, 6]], M: [[0, 6, 0, 0, 2, 3, 4, 0, 4, 6]], N: [[0, 6, 0, 0, 4, 6, 4, 0]],
    O: [[1, 0, 3, 0, 4, 1, 4, 5, 3, 6, 1, 6, 0, 5, 0, 1, 1, 0]], P: [[0, 6, 0, 0, 3, 0, 4, 1, 4, 2, 3, 3, 0, 3]],
    Q: [[1, 0, 3, 0, 4, 1, 4, 5, 3, 6, 1, 6, 0, 5, 0, 1, 1, 0], [2.5, 4.5, 4, 6]], R: [[0, 6, 0, 0, 3, 0, 4, 1, 4, 2, 3, 3, 0, 3], [2, 3, 4, 6]],
    S: [[4, 1, 3, 0, 1, 0, 0, 1, 0, 2, 1, 3, 3, 3, 4, 4, 4, 5, 3, 6, 1, 6, 0, 5]], T: [[0, 0, 4, 0], [2, 0, 2, 6]],
    U: [[0, 0, 0, 5, 1, 6, 3, 6, 4, 5, 4, 0]], V: [[0, 0, 2, 6, 4, 0]], W: [[0, 0, 1, 6, 2, 3, 3, 6, 4, 0]],
    X: [[0, 0, 4, 6], [4, 0, 0, 6]], Y: [[0, 0, 2, 3, 4, 0], [2, 3, 2, 6]], Z: [[0, 0, 4, 0, 0, 6, 4, 6]],
    0: [[1, 0, 3, 0, 4, 1, 4, 5, 3, 6, 1, 6, 0, 5, 0, 1, 1, 0], [4, 1, 0, 5]], 1: [[1, 1, 2, 0, 2, 6], [1, 6, 3, 6]],
    2: [[0, 1, 1, 0, 3, 0, 4, 1, 4, 2, 0, 6, 4, 6]], 3: [[0, 0, 4, 0, 2, 2.5, 3, 2.5, 4, 3.5, 4, 5, 3, 6, 1, 6, 0, 5]],
    4: [[3, 6, 3, 0, 0, 4, 4, 4]], 5: [[4, 0, 0, 0, 0, 2.5, 3, 2.5, 4, 3.5, 4, 5, 3, 6, 0, 6]],
    6: [[3, 0, 1, 0, 0, 1, 0, 5, 1, 6, 3, 6, 4, 5, 4, 4, 3, 3, 0, 3]], 7: [[0, 0, 4, 0, 1.5, 6]],
    8: [[1, 3, 0, 2, 0, 1, 1, 0, 3, 0, 4, 1, 4, 2, 3, 3, 1, 3, 0, 4, 0, 5, 1, 6, 3, 6, 4, 5, 4, 4, 3, 3]],
    9: [[4, 3, 1, 3, 0, 2, 0, 1, 1, 0, 3, 0, 4, 1, 4, 5, 3, 6, 1, 6]],
    '+': [[2, 1.5, 2, 4.5], [0.5, 3, 3.5, 3]], '-': [[0.5, 3, 3.5, 3]], '.': [[1.8, 6, 2.2, 6]], '/': [[0, 6, 4, 0]],
    '_': [[0, 6, 4, 6]], ':': [[2, 1.5, 2, 2], [2, 4.5, 2, 5]], '(': [[2.5, 0, 1.5, 1.5, 1.5, 4.5, 2.5, 6]], ')': [[1.5, 0, 2.5, 1.5, 2.5, 4.5, 1.5, 6]]
  };
  // text → line segments in mm, height h, anchored at its centre
  function textStrokes(str, cx, cy, h, mirror) {
    const s = h / 6, adv = 5.5 * s;
    const t = String(str).toUpperCase();
    const width = t.length * adv - 1.5 * s;
    const segs = [];
    [...t].forEach((ch, i) => {
      const g = GLYPHS[ch];
      if (!g) return;
      const ox = -width / 2 + i * adv;
      for (const poly of g) for (let k = 0; k + 3 < poly.length; k += 2) {
        let x1 = ox + poly[k] * s, x2 = ox + poly[k + 2] * s;
        if (mirror) { x1 = -x1; x2 = -x2; }
        segs.push([cx + x1, cy - h / 2 + poly[k + 1] * s, cx + x2, cy - h / 2 + poly[k + 3] * s]);
      }
    });
    return segs;
  }

  // ---- Gerber RS-274X writer ------------------------------------------------------
  // Y is flipped so the board's bottom-left corner is the Gerber origin
  function gerber(func, attrs, draw) {
    const fmt = (v) => String(Math.round(v * 1e6));
    const apertures = new Map();
    const body = [];
    let cur = null;
    const ap = (key, def) => {
      if (!apertures.has(key)) apertures.set(key, { code: 10 + apertures.size, def });
      return apertures.get(key).code;
    };
    const use = (code) => { if (cur !== code) { body.push('D' + code + '*'); cur = code; } };
    const H = attrs.h;
    const api = {
      line(x1, y1, x2, y2, w) {
        use(ap('C' + w.toFixed(4), 'C,' + w.toFixed(4)));
        body.push('X' + fmt(x1) + 'Y' + fmt(H - y1) + 'D02*', 'X' + fmt(x2) + 'Y' + fmt(H - y2) + 'D01*');
      },
      flash(shape, x, y, w, h) {
        const k = shape === 'rect' ? 'R' : shape === 'oval' && w !== h ? 'O' : 'C';
        const def = k === 'C' ? 'C,' + w.toFixed(4) : k + ',' + w.toFixed(4) + 'X' + h.toFixed(4);
        use(ap(k + w.toFixed(4) + 'x' + h.toFixed(4), def));
        body.push('X' + fmt(x) + 'Y' + fmt(H - y) + 'D03*');
      },
      // a filled polygon (G36/G37 region)
      region(pts) {
        if (!pts || pts.length < 3) return;
        body.push('G36*', 'X' + fmt(pts[0][0]) + 'Y' + fmt(H - pts[0][1]) + 'D02*');
        for (let i = 1; i < pts.length; i++) body.push('X' + fmt(pts[i][0]) + 'Y' + fmt(H - pts[i][1]) + 'D01*');
        body.push('X' + fmt(pts[0][0]) + 'Y' + fmt(H - pts[0][1]) + 'D01*', 'G37*');
      },
      // dark (adds copper) or clear (removes what was drawn before it)
      polarity(dark) { body.push(dark ? '%LPD*%' : '%LPC*%'); },
      shape(sh) {   // a copper shape from the geometry code: { rect } or { seg, r }
        if (sh.rect) { const [a, b, c, d] = sh.rect; api.flash('rect', (a + c) / 2, (b + d) / 2, c - a, d - b); }
        else if (sh.seg[0] === sh.seg[2] && sh.seg[1] === sh.seg[3]) api.flash('circle', sh.seg[0], sh.seg[1], 2 * sh.r, 2 * sh.r);
        else api.line(sh.seg[0], sh.seg[1], sh.seg[2], sh.seg[3], 2 * sh.r);
      },
      circle(x, y, r, w) {   // an outline circle from line segments
        const n = Math.max(24, Math.ceil(r * 12));
        for (let i = 0; i < n; i++) {
          const a1 = (i / n) * 2 * Math.PI, a2 = ((i + 1) / n) * 2 * Math.PI;
          api.line(x + r * Math.cos(a1), y + r * Math.sin(a1), x + r * Math.cos(a2), y + r * Math.sin(a2), w);
        }
      }
    };
    draw(api);
    const head = ['G04 ElectriCAD ' + (attrs.version || '') + '*', '%TF.GenerationSoftware,ElectriCAD,PCB,' + (attrs.version || '') + '*%',
      '%TF.FileFunction,' + func + '*%', '%TF.FilePolarity,' + (/Soldermask/.test(func) ? 'Negative' : 'Positive') + '*%',
      '%FSLAX46Y46*%', '%MOMM*%', '%LPD*%', 'G01*'];
    for (const a of apertures.values()) head.push('%ADD' + a.code + a.def + '*%');
    return head.concat(body, ['M02*']).join('\n') + '\n';
  }

  // the outputs for one layout: { name: text } for every fab file
  function fabFiles(layout, net, opts) {
    const o = opts || {};
    const base = String(o.name || 'board').replace(/[^A-Za-z0-9_-]+/g, '_') || 'board';
    const H = layout.board.h, W = layout.board.w;
    const ver = o.version || '';
    const mask = 0.05;   // solder-mask expansion per side
    const comps = net.comps.filter((c) => layout.place[c.ref]);
    const CL = copperLayers(layout), N = CL.length;
    const pads = comps.flatMap((c) => padsWorld(c, layout.place[c.ref])).map((p) => ({ ...p, layers: padLayers(p, CL) }));
    const smd = pads.some((p) => !p.drill);
    const A = analyze(layout, net, layout.rules);
    const copper = (L) => gerber(copperFile(layout, L).func, { h: H, version: ver }, (g) => {
      // zones first: fill, thermal gaps, spokes, then clearances cut out
      for (const z of A.zones) {
        if (z.layer !== L || !z.fill) continue;
        g.polarity(true); g.region(z.poly);
        if (z.ops.gapClear.length) { g.polarity(false); z.ops.gapClear.forEach(g.shape); }
        if (z.ops.spokes.length) { g.polarity(true); z.ops.spokes.forEach(g.shape); }
        if (z.ops.clear.length) { g.polarity(false); z.ops.clear.forEach(g.shape); }
      }
      g.polarity(true);
      for (const t of layout.traces || []) if (t.layer === L) for (let i = 0; i + 1 < t.pts.length; i++) g.line(t.pts[i][0], t.pts[i][1], t.pts[i + 1][0], t.pts[i + 1][1], t.w);
      for (const p of pads) if (p.layers.includes(L)) g.flash(p.shape, p.x, p.y, p.w, p.h);
      if (N > 1) for (const v of layout.vias || []) g.flash('circle', v.x, v.y, v.dia, v.dia);
    });
    const maskL = (L) => gerber('Soldermask,' + (L === 'F' ? 'Top' : 'Bot'), { h: H, version: ver }, (g) => {
      for (const p of pads) if (p.layers.includes(L)) g.flash(p.shape, p.x, p.y, p.w + 2 * mask, p.h + 2 * mask);
      // vias are tented (covered by mask)
      for (const c of comps) { const f = footprint(c.fp); for (const h of f.npth || []) { const [x, y] = xform(layout.place[c.ref], h.x, h.y); g.flash('circle', x, y, h.d + 2 * mask, h.d + 2 * mask); } }
      for (const h of layout.holes || []) g.flash('circle', h.x, h.y, h.d + 2 * mask, h.d + 2 * mask);
    });
    const silk = (L) => gerber('Legend,' + (L === 'F' ? 'Top' : 'Bot'), { h: H, version: ver }, (g) => {
      const w = 0.15;
      for (const c of comps) {
        const pl = layout.place[c.ref];
        if ((pl.side || 'F') !== L) continue;
        const f = footprint(c.fp);
        for (const s of f.silk || []) {
          if (s.l) { const [a, b] = xform(pl, s.l[0], s.l[1]); const [cc, d] = xform(pl, s.l[2], s.l[3]); g.line(a, b, cc, d, w); }
          if (s.c) { const [x, y] = xform(pl, s.c[0], s.c[1]); g.circle(x, y, s.c[2], w); }
        }
        const bb = bboxOf(c, pl);
        const ty = bb.y1 - 1.2 < 0.6 ? bb.y2 + 1.2 : bb.y1 - 1.2;
        for (const sg of textStrokes(c.ref, (bb.x1 + bb.x2) / 2, ty, 1.0, L === 'B')) g.line(sg[0], sg[1], sg[2], sg[3], w);
      }
      for (const t of layout.texts || []) if ((t.layer || 'F') === L) for (const sg of textStrokes(t.text, t.x, t.y, t.h || 1.5, L === 'B')) g.line(sg[0], sg[1], sg[2], sg[3], 0.2);
    });
    const edge = gerber('Profile,NP', { h: H, version: ver }, (g) => {
      const w = 0.1;
      g.line(0, 0, W, 0, w); g.line(W, 0, W, H, w); g.line(W, H, 0, H, w); g.line(0, H, 0, 0, w);
    });
    const files = {};
    for (const L of CL) { const cf = copperFile(layout, L); files[base + '-' + cf.name + '.' + cf.ext] = copper(L); }
    // a 1-layer board gets mask on its copper side only
    if (CL.includes('F')) files[base + '-F_Mask.gts'] = maskL('F');
    files[base + '-B_Mask.gbs'] = maskL('B');
    files[base + '-F_Silkscreen.gto'] = silk('F');
    if (comps.some((c) => layout.place[c.ref].side === 'B') || (layout.texts || []).some((t) => t.layer === 'B')) files[base + '-B_Silkscreen.gbo'] = silk('B');
    files[base + '-Edge_Cuts.gm1'] = edge;
    if (smd) {
      files[base + '-F_Paste.gtp'] = gerber('Paste,Top', { h: H, version: ver }, (g) => { for (const p of pads) if (!p.drill && p.layers.includes('F')) g.flash(p.shape, p.x, p.y, p.w, p.h); });
      if (pads.some((p) => !p.drill && p.layers.includes('B'))) files[base + '-B_Paste.gbp'] = gerber('Paste,Bot', { h: H, version: ver }, (g) => { for (const p of pads) if (!p.drill && p.layers.includes('B')) g.flash(p.shape, p.x, p.y, p.w, p.h); });
    }
    // Excellon: plated holes (pads, vias) and non-plated (mounting) apart
    const pth = pads.filter((p) => p.drill).map((p) => ({ x: p.x, y: p.y, d: p.drill }))
      .concat(N > 1 ? (layout.vias || []).map((v) => ({ x: v.x, y: v.y, d: v.drill })) : []);
    const npth = npthHoles(layout, net);
    // single-sided boards have no plating: every hole goes in one unplated file
    if (N === 1) files[base + '-NPTH.drl'] = excellon(pth.concat(npth), H, false, ver, N);
    else {
      files[base + '-PTH.drl'] = excellon(pth, H, true, ver, N);
      if (npth.length) files[base + '-NPTH.drl'] = excellon(npth, H, false, ver, N);
    }
    if (N >= 4) files[base + '-stackup.txt'] = stackupText(layout, base, o.maker);
    return files;
  }
  // layer order and what to choose on the order page. Thicknesses and the
  // dielectric build-up are the maker's own standard stackups, so they are
  // named, not invented here.
  function stackupText(layout, base, maker) {
    const CL = copperLayers(layout), N = CL.length;
    const lines = ['ElectriCAD layer stackup for ' + base, '', N + ' copper layers, top to bottom:'];
    CL.forEach((id, i) => {
      const cf = copperFile(layout, id), pn = planeNet(layout, id);
      lines.push('  L' + (i + 1) + '  ' + base + '-' + cf.name + '.' + cf.ext + '  ' + layerLabel(id) + (id === 'F' || id === 'B' ? ' (signal, parts)' : pn ? ' (' + pn + ' plane)' : ' (signal)'));
    });
    lines.push('', 'Drill: ' + base + '-PTH.drl plated through all ' + N + ' layers; ' + base + '-NPTH.drl unplated (mounting holes), if present.',
      'Board thickness: 1.6 mm unless you choose otherwise on the order page.', '',
      'JLCPCB: set Layers to ' + N + '. The file names above give the layer order; if asked, confirm L1 to L' + N + ' as listed. Pick one of the standard',
      '  stackups JLCPCB offers for ' + N + ' layers at 1.6 mm (shown under "Specify Stackup" / impedance control). Only choose a specific',
      '  one if you need controlled impedance.',
      'PCBWay: set Layers to ' + N + ' and leave the default stackup, or add a note with the layer order above. Their engineers confirm the',
      '  stackup with you before production if anything is unclear.',
      '', 'Heavier inner copper or impedance control usually costs extra: leave the defaults unless your design needs them.');
    return lines.join('\r\n') + '\r\n';
  }
  function excellon(holes, H, plated, ver, n) {
    const layers = n || 2;
    const sizes = [...new Set(holes.map((h) => h.d.toFixed(3)))].sort((a, b) => a - b);
    const out = ['M48', '; DRILL file ElectriCAD ' + (ver || ''), '; FORMAT={-:-/ absolute / metric / decimal}',
      '; #@! TF.FileFunction,' + (plated ? 'Plated,1,' + layers + ',PTH' : 'NonPlated,1,' + layers + ',NPTH'), 'FMAT,2', 'METRIC'];
    sizes.forEach((s, i) => out.push('T' + (i + 1) + 'C' + s));
    out.push('%', 'G90', 'G05');
    sizes.forEach((s, i) => {
      out.push('T' + (i + 1));
      for (const h of holes) if (h.d.toFixed(3) === s) out.push('X' + h.x.toFixed(3) + 'Y' + (H - h.y).toFixed(3));
    });
    out.push('T0', 'M30');
    return out.join('\n') + '\n';
  }

  // ---- Gerber / Excellon reader (preview, zip check) --------------------------------
  // handles what fabs actually receive: FS/MO, C/R/O apertures, D01/D02/D03,
  // G01/G02/G03 with G75, regions (G36/G37) and polarity. Returns primitives
  // in mm with Y up, and the extents.
  function parseGerber(text) {
    const t = String(text || '');
    let unit = 1, xd = 6, yd = 6, absolute = true;
    const ap = {};
    const prims = [];
    let x = 0, y = 0, cur = null, interp = 1, region = null, dark = true;
    const ext = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
    const grow = (px, py, r) => { ext.x1 = Math.min(ext.x1, px - r); ext.y1 = Math.min(ext.y1, py - r); ext.x2 = Math.max(ext.x2, px + r); ext.y2 = Math.max(ext.y2, py + r); };
    const num = (s, d) => {
      if (s == null) return null;
      if (s.includes('.')) return Number(s) * unit;
      return Number(s) / Math.pow(10, d) * unit;
    };
    const ext2 = t.replace(/\r/g, '');
    const blocks = [];
    // split into %...% extended blocks and *-terminated words
    for (let i = 0; i < ext2.length;) {
      if (/\s/.test(ext2[i])) { i++; continue; }
      if (ext2[i] === '%') { const j = ext2.indexOf('%', i + 1); if (j < 0) break; blocks.push({ ext: ext2.slice(i + 1, j) }); i = j + 1; continue; }
      const j = ext2.indexOf('*', i);
      if (j < 0) break;
      const w = ext2.slice(i, j).trim();
      if (w) blocks.push({ w });
      i = j + 1;
    }
    for (const b of blocks) {
      if (b.ext != null) {
        for (const part of b.ext.split('*').map((s) => s.trim()).filter(Boolean)) {
          let m;
          if ((m = /^FS([LT])([AI])X(\d)(\d)Y(\d)(\d)/.exec(part))) { absolute = m[2] === 'A'; xd = Number(m[4]); yd = Number(m[6]); }
          else if (/^MOIN/.test(part)) unit = 25.4;
          else if (/^MOMM/.test(part)) unit = 1;
          else if ((m = /^ADD(\d+)([A-Za-z_$][\w.$]*),?(.*)$/.exec(part))) {
            const p = m[3].split('X').map(Number).map((v) => v * unit);
            ap[m[1]] = { type: m[2], w: p[0] || 0, h: p[1] != null && !isNaN(p[1]) ? p[1] : p[0] || 0 };
          } else if (/^LPC/.test(part)) dark = false;
          else if (/^LPD/.test(part)) dark = true;
        }
        continue;
      }
      let w = b.w;
      if (/^G04/.test(w) || /^M0[02]/.test(w)) continue;
      if (/^G36/.test(w)) { region = []; continue; }
      if (/^G37/.test(w)) { if (region && region.length > 2) { prims.push({ k: 'poly', pts: region, dark }); for (const p of region) grow(p[0], p[1], 0); } region = null; continue; }
      let m;
      if ((m = /^G0?([123])/.exec(w))) { interp = Number(m[1]); w = w.slice(m[0].length); }
      if (/^G7[45]/.test(w)) continue;
      if ((m = /^(?:G54)?D(\d+)$/.exec(w)) && Number(m[1]) >= 10) { cur = ap[m[1]] || null; continue; }
      const mx = /X([-+]?[\d.]+)/.exec(w), my = /Y([-+]?[\d.]+)/.exec(w), mi = /I([-+]?[\d.]+)/.exec(w), mj = /J([-+]?[\d.]+)/.exec(w);
      const md = /D0?([123])$/.exec(w);
      let nx = mx ? num(mx[1], xd) : x, ny = my ? num(my[1], yd) : y;
      if (!absolute) { nx = mx ? x + num(mx[1], xd) : x; ny = my ? y + num(my[1], yd) : y; }
      const op = md ? Number(md[1]) : (mx || my ? 1 : 0);
      if (!op) continue;
      if (op === 2) { if (region) region.push([nx, ny]); x = nx; y = ny; continue; }
      if (op === 1) {
        if (interp === 1) {
          if (region) region.push([nx, ny]);
          else if (cur) { prims.push({ k: 'line', x1: x, y1: y, x2: nx, y2: ny, w: cur.w, dark }); grow(x, y, cur.w / 2); grow(nx, ny, cur.w / 2); }
        } else {
          // arc: centre = start + (I, J); sample it into segments
          const cx = x + (mi ? num(mi[1], xd) : 0), cy = y + (mj ? num(mj[1], yd) : 0);
          const r = Math.hypot(x - cx, y - cy);
          let a1 = Math.atan2(y - cy, x - cx), a2 = Math.atan2(ny - cy, nx - cx);
          if (interp === 3 && a2 <= a1) a2 += 2 * Math.PI;
          if (interp === 2 && a2 >= a1) a2 -= 2 * Math.PI;
          const n = Math.max(8, Math.ceil(Math.abs(a2 - a1) * 16));
          let px = x, py = y;
          for (let i = 1; i <= n; i++) {
            const a = a1 + (a2 - a1) * i / n, qx = cx + r * Math.cos(a), qy = cy + r * Math.sin(a);
            if (region) region.push([qx, qy]);
            else if (cur) { prims.push({ k: 'line', x1: px, y1: py, x2: qx, y2: qy, w: cur.w, dark }); grow(qx, qy, cur.w / 2); }
            px = qx; py = qy;
          }
        }
        x = nx; y = ny; continue;
      }
      if (op === 3 && cur) { prims.push({ k: 'flash', x: nx, y: ny, ap: cur, dark }); grow(nx, ny, Math.max(cur.w, cur.h) / 2); x = nx; y = ny; }
    }
    if (ext.x1 === Infinity) { ext.x1 = ext.y1 = ext.x2 = ext.y2 = 0; }
    const fn = /%TF\.FileFunction,([^*%]+)/.exec(t);
    return { prims, ext, fileFunction: fn ? fn[1] : '' };
  }
  function parseExcellon(text) {
    const tools = {}, holes = [];
    let unit = 1, tool = null, inHeader = false, lz = true, digits = [3, 3];
    for (const raw of String(text || '').split(/\r?\n/)) {
      const l = raw.trim();
      if (!l || l.startsWith(';')) continue;
      if (l === 'M48') { inHeader = true; continue; }
      if (l === '%' || l === 'M95') { inHeader = false; continue; }
      if (/^INCH/.test(l)) { unit = 25.4; lz = !/TZ/.test(l); digits = [2, 4]; }
      if (/^METRIC/.test(l)) { unit = 1; lz = !/TZ/.test(l); digits = [3, 3]; }
      let m;
      if ((m = /^T(\d+)(?:F\d+)?(?:S\d+)?C([\d.]+)/.exec(l))) { tools[Number(m[1])] = Number(m[2]) * unit; continue; }
      if (inHeader) continue;
      if ((m = /^T(\d+)$/.exec(l))) { tool = Number(m[1]); continue; }
      if ((m = /^(?:G0[05])?X([-+]?[\d.]+)?Y?([-+]?[\d.]+)?/.exec(l)) && /X|Y/.test(l)) {
        const cv = (s) => {
          if (s.includes('.')) return Number(s) * unit;
          const neg = s.startsWith('-'); const d = s.replace(/^[-+]/, '');
          const v = lz ? Number(d.padEnd(digits[0] + digits[1], '0')) / Math.pow(10, digits[1]) : Number(d) / Math.pow(10, digits[1]);
          return (neg ? -v : v) * unit;
        };
        const mx = /X([-+]?[\d.]+)/.exec(l), my = /Y([-+]?[\d.]+)/.exec(l);
        const last = holes[holes.length - 1];
        holes.push({ x: mx ? cv(mx[1]) : last ? last.x : 0, y: my ? cv(my[1]) : last ? last.y : 0, d: tools[tool] || 0 });
      }
    }
    return { tools, holes };
  }

  // ---- fab packages ----------------------------------------------------------------
  // which Gerber layer a file is, from its X2 attribute or its name
  function layerOf(name, text) {
    const n = String(name).toLowerCase();
    const fn = text ? (/%TF\.FileFunction,([^*%]+)/.exec(text) || [])[1] || '' : '';
    if (/^Copper,L\d+,Bot/i.test(fn)) return 'bottom-copper';
    if (/^Copper,L1|Copper,.*Top/i.test(fn)) return 'top-copper';
    if (/^Copper,L\d+,Inr/i.test(fn)) return 'inner-copper';
    if (/^Soldermask,Top/i.test(fn)) return 'top-mask';
    if (/^Soldermask,Bot/i.test(fn)) return 'bottom-mask';
    if (/^Legend,Top/i.test(fn)) return 'top-silk';
    if (/^Legend,Bot/i.test(fn)) return 'bottom-silk';
    if (/^Paste,Top/i.test(fn)) return 'top-paste';
    if (/^Paste,Bot/i.test(fn)) return 'bottom-paste';
    if (/^Profile/i.test(fn)) return 'outline';
    if (/\.(gtl)$|f[._]cu\.g(br|tl)|-top\.gbr$|copper_top|toplayer/.test(n)) return 'top-copper';
    if (/\.(gbl)$|b[._]cu\.g(br|bl)|-bottom\.gbr$|copper_bottom|bottomlayer/.test(n)) return 'bottom-copper';
    if (/\.g[1-9]\d?$|in\d+[._]cu/.test(n)) return 'inner-copper';
    if (/\.gts$|f[._]mask|soldermask_top|topsoldermask/.test(n)) return 'top-mask';
    if (/\.gbs$|b[._]mask|soldermask_bottom|bottomsoldermask/.test(n)) return 'bottom-mask';
    if (/\.gto$|f[._]silk|silkscreen_top|topsilk/.test(n)) return 'top-silk';
    if (/\.gbo$|b[._]silk|silkscreen_bottom|bottomsilk/.test(n)) return 'bottom-silk';
    if (/\.gtp$|f[._]paste/.test(n)) return 'top-paste';
    if (/\.gbp$|b[._]paste/.test(n)) return 'bottom-paste';
    if (/\.(gm1|gko|gml|gm)$|edge[._]cuts|outline|boardoutline|profile/.test(n)) return 'outline';
    if (/\.(drl|xln|exc|drd|txt)$/.test(n) && (!text || /M48|^T\d+C/m.test(text))) return 'drill';
    return '';
  }
  // check a Gerber zip's contents before upload: [{ name, text }]
  function checkGerbers(files) {
    const found = {};
    for (const f of files) { const l = layerOf(f.name, f.text); if (l) (found[l] = found[l] || []).push(f.name); }
    const problems = [], notes = [];
    if (!found['top-copper'] && !found['bottom-copper']) problems.push('No copper layer found');
    const need = [['outline', 'board outline (Edge.Cuts / .GKO / .GM1)'], ['drill', 'drill file (.DRL / .XLN)']];
    for (const [k, label] of need) if (!found[k]) problems.push('No ' + label + ' found');
    if (!found['top-mask'] && found['top-copper']) notes.push('No top solder mask: the fab will make the board without one, or ask');
    if (!found['top-silk']) notes.push('No top silkscreen (optional)');
    if (found['bottom-copper'] && !found['bottom-mask']) notes.push('Bottom copper but no bottom solder mask');
    let size = null;
    const outline = files.find((f) => layerOf(f.name, f.text) === 'outline' && f.text);
    if (outline) {
      const g = parseGerber(outline.text);
      if (g.prims.length) {
        // outline extents measured on the line centres (fabs do the same)
        let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
        for (const p of g.prims) {
          const pts = p.k === 'line' ? [[p.x1, p.y1], [p.x2, p.y2]] : p.k === 'poly' ? p.pts : [[p.x, p.y]];
          for (const [a, b] of pts) { x1 = Math.min(x1, a); y1 = Math.min(y1, b); x2 = Math.max(x2, a); y2 = Math.max(y2, b); }
        }
        size = { w: +(x2 - x1).toFixed(2), h: +(y2 - y1).toFixed(2) };
      } else problems.push('The outline file has no shape in it');
    }
    const layers = (found['top-copper'] ? 1 : 0) + (found['bottom-copper'] ? 1 : 0) + (found['inner-copper'] || []).length;
    if (found['inner-copper'] && (!found['top-copper'] || !found['bottom-copper'])) problems.push('Inner copper layers but no top or bottom copper');
    if (found['inner-copper'] && found['inner-copper'].length % 2) notes.push('An odd number of inner layers: fabs build 4, 6, 8 layers, so check nothing is missing');
    let holes = 0, minDrill = null;
    for (const f of files) if (layerOf(f.name, f.text) === 'drill' && f.text) {
      const d = parseExcellon(f.text);
      holes += d.holes.length;
      for (const h of d.holes) if (h.d && (minDrill == null || h.d < minDrill)) minDrill = h.d;
    }
    if (minDrill != null && minDrill < 0.3) notes.push('Smallest hole is ' + minDrill.toFixed(2) + ' mm; under 0.3 mm costs extra at most fabs');
    return { ok: !problems.length, layers, size, holes, minDrill, found, problems, notes };
  }

  // PCB makers: where each one takes a Gerber zip. Nothing is uploaded by
  // ElectriCAD; the page opens and the zip is shown in Explorer.
  const MAKERS = [
    { id: 'jlcpcb', name: 'JLCPCB', url: 'https://cart.jlcpcb.com/quote', accepts: 'Gerber zip (RS-274X), BOM + CPL for assembly',
      note: 'Assembly uses LCSC part numbers in the BOM.' },
    { id: 'pcbway', name: 'PCBWay', url: 'https://www.pcbway.com/QuickOrderOnline.aspx', accepts: 'Gerber zip, BOM + centroid for assembly',
      note: 'Assembly quote takes a BOM with manufacturer part numbers.' },
    { id: 'oshpark', name: 'OSH Park', url: 'https://oshpark.com/', accepts: 'Gerber zip or a .kicad_pcb file', note: 'Purple boards made in the USA, priced per square inch.' },
    { id: 'aisler', name: 'Aisler', url: 'https://aisler.net/', accepts: 'Gerber zip or KiCad project', note: 'Made in Europe.' },
    { id: 'eurocircuits', name: 'Eurocircuits', url: 'https://www.eurocircuits.com/', accepts: 'Gerber zip (RS-274X / X2)', note: 'Made in Europe, with design checks before the order.' },
    { id: 'seeed', name: 'Seeed Fusion', url: 'https://www.seeedstudio.com/fusion_pcb.html', accepts: 'Gerber zip, BOM + pick-and-place', note: '' }
  ];

  // BOM / CPL for assembly. Part numbers are never guessed: the columns are
  // left for the user, with search links for each row.
  function bomRows(net) {
    const map = new Map();
    for (const c of net.comps) {
      if (c.type === 'board' && c.fp !== 'Nano' && c.fp !== 'Pico') continue;
      const f = footprint(c.fp);
      const key = c.type + '|' + c.value + '|' + c.fp;
      if (!map.has(key)) map.set(key, { comment: c.value || c.name, name: c.name, footprint: f ? f.name : c.fp, refs: [], smd: !!(f && f.smd), type: c.type });
      map.get(key).refs.push(c.ref);
    }
    return [...map.values()].map((r) => ({ ...r, qty: r.refs.length,
      search: {
        lcsc: 'https://www.lcsc.com/search?q=' + encodeURIComponent(r.comment),
        digikey: 'https://www.digikey.com/en/products/result?keywords=' + encodeURIComponent(r.comment),
        mouser: 'https://www.mouser.com/c/?q=' + encodeURIComponent(r.comment)
      } }));
  }
  const csvq = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
  function bomCsv(net, format) {
    const rows = bomRows(net);
    if (format === 'jlcpcb') {
      return ['Comment,Designator,Footprint,JLCPCB Part #'].concat(rows.map((r) => [csvq(r.comment), csvq(r.refs.join(',')), csvq(r.footprint), ''].join(','))).join('\r\n') + '\r\n';
    }
    if (format === 'pcbway') {
      return ['Item #,Designator,Qty,Manufacturer,Mfg Part #,Description / Value,Package/Footprint,Type,Your Instructions / Notes']
        .concat(rows.map((r, i) => [i + 1, csvq(r.refs.join(',')), r.qty, '', '', csvq(r.comment), csvq(r.footprint), r.smd ? 'SMD' : 'THT', ''].join(','))).join('\r\n') + '\r\n';
    }
    return ['Qty,Designators,Value,Footprint,Type,LCSC search,Digi-Key search,Mouser search']
      .concat(rows.map((r) => [r.qty, csvq(r.refs.join(' ')), csvq(r.comment), csvq(r.footprint), r.smd ? 'SMD' : 'THT', r.search.lcsc, r.search.digikey, r.search.mouser].join(','))).join('\r\n') + '\r\n';
  }
  // pick-and-place: component centre in mm from the board's bottom-left
  function cplCsv(layout, net, format) {
    const rows = net.comps.filter((c) => layout.place[c.ref]).map((c) => {
      const pl = layout.place[c.ref], b = bboxOf(c, pl);
      const pads = padsWorld(c, pl);
      const cx = pads.length ? pads.reduce((s, p) => s + p.x, 0) / pads.length : (b.x1 + b.x2) / 2;
      const cy = pads.length ? pads.reduce((s, p) => s + p.y, 0) / pads.length : (b.y1 + b.y2) / 2;
      return { ref: c.ref, x: cx, y: layout.board.h - cy, rot: ((360 - (pl.rot || 0)) % 360), layer: pl.side === 'B' ? 'Bottom' : 'Top',
               fp: (footprint(c.fp) || {}).name || c.fp, val: c.value || c.name };
    });
    const mm = (v) => v.toFixed(3) + 'mm';
    if (format === 'pcbway') {
      return ['Designator,Footprint,Mid X,Mid Y,Layer,Rotation,Comment'].concat(rows.map((r) => [r.ref, csvq(r.fp), mm(r.x), mm(r.y), r.layer === 'Top' ? 'T' : 'B', r.rot, csvq(r.val)].join(','))).join('\r\n') + '\r\n';
    }
    return ['Designator,Mid X,Mid Y,Layer,Rotation'].concat(rows.map((r) => [r.ref, mm(r.x), mm(r.y), r.layer, r.rot].join(','))).join('\r\n') + '\r\n';
  }
  // KiCad netlist (S-expression): Pcbnew → File → Import → Netlist
  function kicadNetlist(net, title) {
    const q = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    const out = ['(export (version "E")', '  (design (source ' + q(title || 'ElectriCAD') + ') (tool "ElectriCAD"))', '  (components'];
    for (const c of net.comps) {
      const f = footprint(c.fp);
      out.push('    (comp (ref ' + q(c.ref) + ') (value ' + q(c.value || c.name) + ') (footprint ' + q((f && f.lib ? f.lib + ':' : '') + (f ? f.name : c.fp)) + '))');
    }
    out.push('  )', '  (nets');
    net.nets.forEach((n, i) => {
      out.push('    (net (code ' + q(i + 1) + ') (name ' + q(n.name) + ')');
      for (const nd of n.nodes) out.push('      (node (ref ' + q(nd.ref) + ') (pin ' + q(nd.pad) + '))');
      out.push('    )');
    });
    out.push('  )', ')');
    return out.join('\n') + '\n';
  }
  function netlistCsv(net) {
    return ['Net,Reference,Pad'].concat(net.nets.flatMap((n) => n.nodes.map((nd) => [csvq(n.name), nd.ref, nd.pad].join(',')))).join('\r\n') + '\r\n';
  }

  const api = { FOOTPRINTS, PART_FP, RULES, MAKERS, GRID, footprint, header, partFootprint, netlist, xform, padsWorld, bboxOf, snap,
                autoPlace, fitBoard, copperItems, connectivity, ratsnest, drc, analyze, zonesOf, pointInPoly, copperLayers, layerCount, layerLabel, planeNet, copperFile, stackupText, STACKS, INNER, gap, ptSeg, segSeg, textStrokes, gerber, fabFiles, excellon,
                parseGerber, parseExcellon, layerOf, checkGerbers, bomRows, bomCsv, cplCsv, kicadNetlist, netlistCsv, BOARD_PINS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ElectriCADPcb = api;
})(typeof window !== 'undefined' ? window : globalThis);
