// ElectriCAD circuit simulator — the electricity under the wiring canvas.
// A real (small) nodal-analysis solver: wires form nets, components stamp
// conductances and EMFs, and we solve G·V = I by Gaussian elimination.
// Nonlinear devices — diodes/LEDs, BJTs, MOSFETs, relays, fuses, voltage
// regulators, open-collector drivers — iterate to a fixed point through a
// generalized condition engine: each device contributes conditions evaluated
// against the last solution, and conducting branches re-stamp until stable.
// DC operating point only; capacitors are opens (with polarity/rating checks),
// inductors are near-shorts. Exactly enough physics to show what a bench
// build would really do, instantly, and to flag what would burn.
(function (root) {
  const R_GPIO = 25;
  const R_SRC = 0.5;
  const I_GPIO_WARN = 0.020, I_GPIO_MAX = 0.040;
  const I_RAIL_WARN = 0.5;
  // GMIN: a 1GΩ leak from every net to ground, as SPICE does. Keeps floating
  // nets (a battery circuit not tied to GND, a lone input pin) solvable and
  // well-conditioned instead of producing garbage from a singular matrix.
  const GMIN = 1e-9;
  // typical MCU internal pull-up (AVR ~20–50k, RP2040 ~50k, ESP32 ~45k)
  const R_PULLUP = 35000;

  // real LEDs drop different forward voltages by color — red is easy at 1.8V,
  // blue and white need ~3V (and barely light on a 3.3V rail through a big R)
  const LED_VF = { red: 1.8, orange: 2.0, yellow: 2.1, green: 2.2, blue: 3.0, white: 3.2 };
  const effVf = (part, pair) => pair.isLed ? (LED_VF[part.color] || 2.0) : pair.vf;

  // ---- device models --------------------------------------------------------
  // pairs: passive two-terminal stamps.
  //   kind res    {a,b,r}                    plain conductance
  //   kind switch {a,b,rOn}                  part.closed gates it
  //   kind diode  {a,b,vf,rOn,vz?}           conducts a->b past vf; zener
  //                                          conducts b->a past vz
  //   kind src    {a,b,v,rInt}               battery: EMF v driving a(+)->b(−)
  //   kind cap    {a,b,polar?,vr?}           DC open; polarity/rating checked
  //   kind fuse   {a,b,rating}               blows (opens) above rating amps
  // cond: conditional branches gated by a test on the last solution.
  //   test 'vdiff' {p, n, min}               V(p)-V(n) > min
  //   then {a, b, r} or {a, gnd:true, r} or {a, b, src:volts, r}
  const MODELS = {
    // --- basics ---
    led:      { pairs: [{ a: 'anode', b: 'cathode', kind: 'diode', vf: 2.0, rOn: 12, isLed: true }] },
    resistor: { pairs: [{ a: 'a', b: 'b', kind: 'res', r: 220 }], editR: true },
    ldr:      { pairs: [{ a: 'a', b: 'b', kind: 'res', r: 10000 }], editR: true },
    thermistor:{ pairs: [{ a: 'a', b: 'b', kind: 'res', r: 10000 }], editR: true },
    inductor: { pairs: [{ a: 'a', b: 'b', kind: 'res', r: 1 }] },
    capC:     { pairs: [{ a: 'a', b: 'b', kind: 'cap' }] },
    capE:     { pairs: [{ a: 'pos', b: 'neg', kind: 'cap', polar: true, vr: 16 }] },
    fuse:     { pairs: [{ a: 'a', b: 'b', kind: 'fuse', rating: 1 }], editR: 'rating' },
    button:   { pairs: [{ a: 'a', b: 'b', kind: 'switch', rOn: 0.2 }] },
    reed:     { pairs: [{ a: 'a', b: 'b', kind: 'switch', rOn: 0.15 }] },     // closed = magnet near
    // SPDT slide switch: part.closed = slid toward B; COM→A otherwise
    slide:    { pairs: [{ a: 'com', b: 'a', kind: 'switch', rOn: 0.05, whenOpen: true },
                        { a: 'com', b: 'b', kind: 'switch', rOn: 0.05 }] },
    cr2032:   { pairs: [{ a: 'pos', b: 'neg', kind: 'src', v: 3.0, rInt: 25 }] },  // coin cell: high Rint (10–40Ω)
    // pot: part.r = total track resistance, part.pos = wiper position 0..1
    // (0 = at the gnd end). Each half is recomputed from those two numbers.
    pot:      { pairs: [{ a: 'vcc', b: 'wiper', kind: 'res', r: 5000, potHalf: 'top' },
                        { a: 'wiper', b: 'gnd', kind: 'res', r: 5000, potHalf: 'bottom' }] },
    // test equipment: a voltmeter is 10MΩ (like a real DMM), an ammeter is a
    // 10mΩ shunt that must sit IN SERIES — across a supply it is a short,
    // exactly the classic multimeter-fuse-killer the sim then flags
    voltmeter:{ pairs: [{ a: 'pos', b: 'neg', kind: 'res', r: 10e6, meter: 'V' }] },
    ammeter:  { pairs: [{ a: 'pos', b: 'neg', kind: 'res', r: 0.01, meter: 'A' }] },
    // TMP36 analog temperature sensor: OUT = 0.5V + 10mV/°C (part.tempC),
    // needs ≥2.7V supply, draws ~50µA
    tmp36:    { pairs: [{ a: 'vcc', b: 'gnd', kind: 'res', r: 60000 }],
                cond: [{ test: { p: 'vcc', n: 'gnd', min: 2.7 },
                         then: { a: 'out', b: 'gnd', src: (part) => 0.5 + 0.01 * (part.tempC != null ? part.tempC : 25), r: 100 } }] },
    // LM35: OUT = 10mV/°C from 0°C (basic configuration, no negative temps),
    // 4–30V supply, ~60µA
    lm35:     { pairs: [{ a: 'vcc', b: 'gnd', kind: 'res', r: 80000 }],
                cond: [{ test: { p: 'vcc', n: 'gnd', min: 4 },
                         then: { a: 'out', b: 'gnd', src: (part) => Math.max(0, 0.01 * (part.tempC != null ? part.tempC : 25)), r: 100 } }] },
    // --- diodes ---
    diode:    { pairs: [{ a: 'anode', b: 'cathode', kind: 'diode', vf: 0.7, rOn: 2 }] },
    schottky: { pairs: [{ a: 'anode', b: 'cathode', kind: 'diode', vf: 0.3, rOn: 2 }] },
    zener:    { pairs: [{ a: 'anode', b: 'cathode', kind: 'diode', vf: 0.7, rOn: 2, vz: 5.1 }] },
    // --- transistors: control junction + gated channel ---
    npn: { pairs: [{ a: 'b', b: 'e', kind: 'diode', vf: 0.65, rOn: 150 }],
           cond: [{ test: { p: 'b', n: 'e', min: 0.6 }, then: { a: 'c', b: 'e', r: 0.6 } }] },
    pnp: { pairs: [{ a: 'e', b: 'b', kind: 'diode', vf: 0.65, rOn: 150 }],
           cond: [{ test: { p: 'e', n: 'b', min: 0.6 }, then: { a: 'e', b: 'c', r: 0.6 } }] },
    nmos: { pairs: [],
            cond: [{ test: { p: 'g', n: 's', min: 2.2 }, then: { a: 'd', b: 's', r: 0.08 } }] },
    pmos: { pairs: [],
            cond: [{ test: { p: 's', n: 'g', min: 2.2 }, then: { a: 's', b: 'd', r: 0.08 } }] },
    // --- power ---
    psu:    { pairs: [{ a: 'pos', b: 'neg', kind: 'src', v: 5, rInt: 0.25, isPsu: true }] },
    bat9v:  { pairs: [{ a: 'pos', b: 'neg', kind: 'src', v: 9, rInt: 1.5 }] },
    bat4aa: { pairs: [{ a: 'pos', b: 'neg', kind: 'src', v: 6, rInt: 0.6 }] },
    lipo:   { pairs: [{ a: 'pos', b: 'neg', kind: 'src', v: 3.7, rInt: 0.15 }],
              note: 'LiPo cells vent/catch fire if shorted or overdrawn — fuse the lead' },
    reg7805: { pairs: [],
               cond: [{ test: { p: 'in', n: 'gnd', min: 7 }, then: { a: 'out', b: 'gnd', src: 5, r: 0.4 } }],
               note: 'needs ≥7V in; gets hot above ~100mA without a heatsink' },
    reg33:   { pairs: [],
               cond: [{ test: { p: 'in', n: 'gnd', min: 4.5 }, then: { a: 'out', b: 'gnd', src: 3.3, r: 0.4 } }] },
    // LM2596 buck module: OUT regulated to part.vout (default 5V) once IN is
    // at least ~1.5V above it (its dropout); ~5mA quiescent from IN
    buck:    { pairs: [{ a: 'in', b: 'gnd', kind: 'res', r: 2400 }],
               cond: [{ test: { p: 'in', n: 'gnd', min: (part) => Math.max(4.5, (part.vout != null ? part.vout : 5) + 1.5) },
                        then: { a: 'out', b: 'gnd', src: (part) => (part.vout != null ? part.vout : 5), r: 0.1 } }] },
    // LM317 adjustable linear regulator: OUT = 1.25·(1 + R2/R1), modeled by
    // part.vout; needs ~2V headroom (dropout), 5mA minimum load ignored
    lm317:   { pairs: [{ a: 'in', b: 'gnd', kind: 'res', r: 100000 }],
               cond: [{ test: { p: 'in', n: 'gnd', min: (part) => (part.vout != null ? part.vout : 5) + 2 },
                        then: { a: 'out', b: 'gnd', src: (part) => (part.vout != null ? part.vout : 5), r: 0.1 } }] },
    // VS1838B 38kHz IR receiver: OUT idles HIGH through an internal pull-up
    // and is pulled LOW while a remote's burst arrives (part.closed)
    irrecv:  { pairs: [{ a: 'vcc', b: 'gnd', kind: 'res', r: 5000 }, { a: 'out', b: 'vcc', kind: 'res', r: 30000 }],
               cond: [{ test: { p: 'vcc', n: 'gnd', min: (part) => (part.closed ? 2.7 : Infinity) },
                        then: { a: 'out', gnd: true, r: 50 } }] },
    // capacitive soil sensor v1.2 (onboard 3.3V regulator): OUT ≈ 2.8V bone
    // dry down to ≈ 1.2V in water — every unit differs, so calibrate
    soil:    { pairs: [{ a: 'vcc', b: 'gnd', kind: 'res', r: 1000 }],
               cond: [{ test: { p: 'vcc', n: 'gnd', min: 3.2 },
                        then: { a: 'out', b: 'gnd', src: (part) => 2.8 - 1.6 * Math.min(100, Math.max(0, part.moisture != null ? part.moisture : 40)) / 100, r: 10000 } }] },
    // PC817 optocoupler: an IR LED (Vf ≈ 1.2V) that turns on a phototransistor
    // across an isolation barrier; modeled as C–E closing when the LED conducts
    pc817:   { pairs: [{ a: 'anode', b: 'cathode', kind: 'diode', vf: 1.2, rOn: 10 }],
               cond: [{ test: { p: 'anode', n: 'cathode', min: 1.0 }, then: { a: 'col', b: 'emi', r: 60 } }] },
    // HC-SR501 PIR motion sensor: 4.5–20V in, OUT is 3.3V while motion is
    // seen (part.closed), 0V otherwise; ~65µA idle
    pir:     { pairs: [{ a: 'vcc', b: 'gnd', kind: 'res', r: 75000 }],
               cond: [{ test: { p: 'vcc', n: 'gnd', min: 4.5 },
                        then: { a: 'out', b: 'gnd', src: (part) => (part.closed ? 3.3 : 0), r: 1000 } }] },
    // --- relays: coil + real changeover contacts ---
    relay:   { pairs: [{ a: 'coilp', b: 'coiln', kind: 'res', r: 70, isCoil: true }],
               cond: [
                 { test: { p: 'coilp', n: 'coiln', min: 3.5 }, then: { a: 'com', b: 'no', r: 0.05 } },
                 { test: { p: 'coilp', n: 'coiln', min: 3.5 }, invert: true, then: { a: 'com', b: 'nc', r: 0.05 } }
               ],
               note: 'contact side can switch mains — shock risk, keep fingers off the COM/NO/NC row' },
    // --- loads / modules ---
    buzzer:   { pairs: [{ a: 'pos', b: 'neg', kind: 'res', r: 100 }] },
    servo:    { pairs: [{ a: 'vcc', b: 'gnd', kind: 'res', r: 55 }] },
    neopixel: { pairs: [{ a: 'v5', b: 'gnd', kind: 'res', r: 85 }] },
    dht22:    { pairs: [{ a: 'vcc', b: 'gnd', kind: 'res', r: 3300 }] },
    oled:     { pairs: [{ a: 'vcc', b: 'gnd', kind: 'res', r: 250 }] },
    hcsr04:   { pairs: [{ a: 'vcc', b: 'gnd', kind: 'res', r: 330 }] },
    dcmotor:  { pairs: [{ a: 'pos', b: 'neg', kind: 'res', r: 6 }], heavyLoad: true },
    stepper:  { pairs: [{ a: 'a1', b: 'a2', kind: 'res', r: 2.4 },
                        { a: 'b1', b: 'b2', kind: 'res', r: 2.4 }], heavyLoad: true },
    uln2003:  { pairs: [], cond: [1, 2, 3, 4].map((i) => (
                 { test: { p: 'in' + i, n: null, min: 2.0 }, then: { a: 'out' + i, gnd: true, r: 1.2 } })) },
    // A4988: a chopper driver. With VMOT present it holds a set coil current
    // regardless of supply voltage — modeled at DC as a limited source per
    // coil (≈0.8A into a 2.4Ω winding, a typical vref setting).
    a4988:    { pairs: [], isDriver: true,
                cond: [
                  { test: { p: 'vmot', n: 'gnd', min: 8 }, then: { a: 'o1a', b: 'o1b', src: 3.4, r: 2 } },
                  { test: { p: 'vmot', n: 'gnd', min: 8 }, then: { a: 'o2a', b: 'o2b', src: 3.4, r: 2 } }
                ],
                note: 'keep the bulk electrolytic right at VMOT — steppers kill capless drivers' },
    // firmware-bench gear: the adapters ARE sources (USB-powered), so wiring
    // a flash chip to the CH341A's 5V rail trips its ratings for real.
    usbuart:  { pairs: [{ a: 'vcc', b: 'gnd', kind: 'src', v: 3.3, rInt: 1 }] },
    ch341a:   { pairs: [{ a: 'v33', b: 'gnd', kind: 'src', v: 3.3, rInt: 1 },
                        { a: 'v5', b: 'gnd', kind: 'src', v: 5, rInt: 1 }] },
    spiflash: { pairs: [{ a: 'vcc', b: 'gnd', kind: 'res', r: 10000 }] },
    ipcam:    { pairs: [{ a: 'pwr', b: 'gnd', kind: 'res', r: 24 }] },
    // generic breakout modules: honest supply draw, so rails and ratings
    // checks see them. analog module centers OUT at half its supply.
    i2cmod:   { pairs: [{ a: 'vcc', b: 'gnd', kind: 'res', r: 400 }] },
    spimod:   { pairs: [{ a: 'vcc', b: 'gnd', kind: 'res', r: 400 }] },
    uartmod:  { pairs: [{ a: 'vcc', b: 'gnd', kind: 'res', r: 400 }] },
    analogmod:{ pairs: [{ a: 'vcc', b: 'gnd', kind: 'res', r: 10000 },
                        { a: 'vcc', b: 'out', kind: 'res', r: 20000 },
                        { a: 'out', b: 'gnd', kind: 'res', r: 20000 }] },
    // --- v0.9 ---
    // A3144 unipolar Hall switch: 4.5–24V, ~4.4mA supply; open-collector OUT
    // sinks to GND while a magnet's SOUTH pole is near (part.closed) — it
    // needs a pull-up (10k or INPUT_PULLUP), on its own OUT floats
    hall:     { pairs: [{ a: 'vcc', b: 'gnd', kind: 'res', r: 1100 }],
                cond: [{ test: { p: 'vcc', n: 'gnd', min: (part) => (part.closed ? 4.5 : Infinity) },
                         then: { a: 'out', gnd: true, r: 20 } }] },
    // SW-520D ball tilt switch: closed while upright (part.closed)
    tilt:     { pairs: [{ a: 'a', b: 'b', kind: 'switch', rOn: 1 }] },
    // small solar panel as a Thevenin source: Voc barely moves with light,
    // short-circuit current scales with it (part.light %, part.volts Voc,
    // part.mA Isc at full sun). A crude but honest DC picture of a panel.
    solar:    { pairs: [{ a: 'pos', b: 'neg', kind: 'src',
                          v: (part) => ((part.light ?? 100) > 0 ? (part.volts || 6) * (0.85 + 0.15 * Math.min(100, part.light ?? 100) / 100) : 0),
                          rInt: (part) => (part.volts || 6) / Math.max(1e-4, (part.mA || 170) / 1000 * Math.max(0.001, Math.min(100, part.light ?? 100) / 100)) }] },
    // MQ-2 module: the heater is 33Ω (≈150mA at 5V — too much for a USB
    // port's 3.3V regulator). AOUT rises with gas (part.gas %); DOUT is the
    // onboard comparator, LOW once AOUT passes the trimpot (part.threshold)
    mq2:      { pairs: [{ a: 'vcc', b: 'gnd', kind: 'res', r: 33, isHeater: true }, { a: 'dout', b: 'vcc', kind: 'res', r: 10000 }],
                cond: [{ test: { p: 'vcc', n: 'gnd', min: 4.5 },
                         then: { a: 'aout', b: 'gnd', src: (part) => 0.4 + 3.6 * Math.min(100, Math.max(0, part.gas ?? 0)) / 100, r: 1000 } },
                       { test: { p: 'vcc', n: 'gnd', min: (part) => ((part.gas ?? 0) > (part.threshold ?? 50) ? 4.5 : Infinity) },
                         then: { a: 'dout', gnd: true, r: 50 } }] },
    // TP4056 Li-ion charger module (1A with the usual 1.2k R_PROG): from
    // 4.5–5.5V on IN it charges BAT up to 4.2V (CC/CV, modeled as 4.2V
    // behind 0.5Ω); quiescent draw from IN while idle is small
    tp4056:   { pairs: [{ a: 'inp', b: 'inn', kind: 'res', r: 20000 }],
                cond: [{ test: { p: 'inp', n: 'inn', min: 4.0 }, then: { a: 'batp', b: 'batn', src: 4.2, r: 0.5 } }] },
    // coin vibration motor (3V, ~75mA): too much for a GPIO — use a transistor
    vibmotor: { pairs: [{ a: 'pos', b: 'neg', kind: 'res', r: 40 }], heavyLoad: true },
    // analog thumb joystick: two 10k pots (part.x / part.y, 0..1, 0.5 =
    // centred) and a push switch from SW to GND (part.closed)
    joystick: { pairs: [{ a: 'vcc', b: 'vrx', kind: 'res', r: 5000, potHalf: 'top', posKey: 'x' },
                        { a: 'vrx', b: 'gnd', kind: 'res', r: 5000, potHalf: 'bottom', posKey: 'x' },
                        { a: 'vcc', b: 'vry', kind: 'res', r: 5000, potHalf: 'top', posKey: 'y' },
                        { a: 'vry', b: 'gnd', kind: 'res', r: 5000, potHalf: 'bottom', posKey: 'y' },
                        { a: 'sw', b: 'gnd', kind: 'switch', rOn: 0.5 }] },
    generic:  { pairs: [] }
  };

  function solveLinear(G, I) {
    const n = I.length;
    const A = G.map((row, i) => [...row, I[i]]);
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      if (Math.abs(A[piv][c]) < 1e-12) { A[c][c] = 1e-12; continue; }
      [A[c], A[piv]] = [A[piv], A[c]];
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
      }
    }
    return A.map((row, i) => row[n] / (Math.abs(row[i]) < 1e-12 ? 1e-12 : row[i]));
  }

  function buildNets(circuit) {
    const parent = new Map();
    const find = (x) => {
      if (!parent.has(x)) parent.set(x, x);
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r);
      let c = x;
      while (parent.get(c) !== c) { const nx = parent.get(c); parent.set(c, r); c = nx; }
      return r;
    };
    for (const w of circuit.wires) {
      const ra = find(w.from), rb = find(w.to);
      parent.set(ra, rb);
    }
    return { find };
  }

  function solve(circuit) {
    const vcc = circuit.boardVolts || 5;
    const { find } = buildNets(circuit);
    const warnings = [];
    const partState = {};

    const netOf = new Map();
    const netIds = new Map();
    const netId = (key) => {
      const r = find(key);
      if (!netIds.has(r)) netIds.set(r, netIds.size);
      netOf.set(key, netIds.get(r));
      return netIds.get(r);
    };
    for (const w of circuit.wires) { netId(w.from); netId(w.to); }

    const gndNets = new Set();
    const rails = []; // {net, v}
    for (const bp of circuit.boardPins) {
      if (!netOf.has(bp.key)) continue;
      const n = netOf.get(bp.key);
      if (bp.power === 'gnd') gndNets.add(n);
      else if (bp.power === 'v5') rails.push({ net: n, v: 5 });
      else if (bp.power === 'v33') rails.push({ net: n, v: 3.3 });
      else if (bp.power === 'vin') rails.push({ net: n, v: 9 });
    }

    const N = netIds.size;
    if (!N) return { netVolts: [], netOf, wireCurrents: [], partState, warnings, pinReads: {} };

    const pk = (part, id) => 'part:' + part.uid + ':' + id;
    const netOfPort = (part, id) => netOf.has(pk(part, id)) ? netOf.get(pk(part, id)) : null;

    // condition state keys: '<uid>:diode<i>' '<uid>:cond<i>' '<uid>:blown<i>'
    let state = new Set();
    let V = new Array(N).fill(0);

    function assemble() {
      const branches = [];
      for (const bp of circuit.boardPins) {
        if (!netOf.has(bp.key) || bp.power || bp.tele == null) continue;
        const st = circuit.pinStates.get(bp.tele);
        if (st && st.mode === 'in' && st.pull === 'up') {
          // INPUT_PULLUP: a weak resistor to the logic rail inside the chip
          branches.push({ n1: -1, n2: netOf.get(bp.key), g: 1 / R_PULLUP, src: vcc, tag: 'pullup', pin: bp });
          continue;
        }
        if (!st || st.mode === 'in') continue;
        const lvl = st.mode === 'pwm' ? (st.pwm || 0) / 255 : st.level;
        branches.push({ n1: -1, n2: netOf.get(bp.key), g: 1 / R_GPIO,
                        src: lvl * vcc, tag: 'gpio', pin: bp });
      }
      for (const r of rails) branches.push({ n1: -1, n2: r.net, g: 1 / R_SRC, src: r.v, tag: 'rail' });

      for (const part of circuit.parts) {
        const model = MODELS[part.type] || MODELS.generic;
        (model.pairs || []).forEach((pair, pi) => {
          const na = netOfPort(part, pair.a), nb = netOfPort(part, pair.b);
          if (na == null || nb == null || na === nb) return;
          const tag = 'pp:' + part.uid + ':' + pi;
          if (pair.kind === 'res') {
            let r = part.r || pair.r;
            if (pair.potHalf) {
              const total = part.r || 10000;
              const raw = part[pair.posKey || 'pos'];
              const pos = Math.min(1, Math.max(0, raw != null ? raw : 0.5));
              r = Math.max(1, total * (pair.potHalf === 'top' ? 1 - pos : pos));
            } else if (pair.meter) r = pair.r;   // meters keep their own impedance
            branches.push({ n1: na, n2: nb, g: 1 / r, tag, part, pair });
          } else if (pair.kind === 'switch') {
            if (!!part.closed !== !!pair.whenOpen) branches.push({ n1: na, n2: nb, g: 1 / pair.rOn, tag, part, pair });
          } else if (pair.kind === 'src') {
            // battery: open-circuit V(pos)-V(neg) = v; loaded, branch current
            // runs n2->n1 internally (out of + externally)
            const v = typeof pair.v === 'function' ? pair.v(part) : (part.volts !== undefined ? part.volts : pair.v);
            const rInt = typeof pair.rInt === 'function' ? pair.rInt(part) : pair.rInt;
            branches.push({ n1: na, n2: nb, g: 1 / rInt, emf: v, tag, part, pair, isSrc: true });
          } else if (pair.kind === 'fuse') {
            if (!state.has(part.uid + ':blown' + pi)) {
              branches.push({ n1: na, n2: nb, g: 1 / 0.05, tag, part, pair, isFuse: true, rating: part.r || pair.rating });
            }
          } else if (pair.kind === 'diode') {
            if (state.has(part.uid + ':diode' + pi)) {
              branches.push({ n1: na, n2: nb, g: 1 / pair.rOn, emf: effVf(part, pair), tag, part, pair, isDiode: true });
            } else if (pair.vz && state.has(part.uid + ':zener' + pi)) {
              branches.push({ n1: nb, n2: na, g: 1 / pair.rOn, emf: pair.vz, tag: tag + 'z', part, pair });
            }
          }
          // kind cap: no DC stamp
        });
        (model.cond || []).forEach((c, ci) => {
          const onKey = part.uid + ':cond' + ci;
          const active = state.has(onKey) !== !!c.invert;
          if (!active) return;
          const t = c.then;
          const na = netOfPort(part, t.a);
          if (na == null) return;
          if (t.gnd) {
            branches.push({ n1: na, gnd: true, g: 1 / t.r, tag: 'cond:' + onKey, part });
          } else {
            const nb = netOfPort(part, t.b);
            if (nb == null || nb === na) return;
            if (t.src !== undefined) {
              // regulated source between out and reference (src may be
              // computed from the part, e.g. a sensor's output voltage)
              const v = typeof t.src === 'function' ? t.src(part) : t.src;
              branches.push({ n1: na, n2: nb, g: 1 / t.r, emf: v, tag: 'cond:' + onKey, part, isSrc: true });
            } else {
              branches.push({ n1: na, n2: nb, g: 1 / t.r, tag: 'cond:' + onKey, part });
            }
          }
        });
      }
      return branches;
    }

    function stamp(branches) {
      const G = Array.from({ length: N }, () => new Array(N).fill(0));
      const I = new Array(N).fill(0);
      for (const b of branches) {
        if (b.n1 === -1) { G[b.n2][b.n2] += b.g; I[b.n2] += b.src * b.g; }
        else if (b.gnd) { G[b.n1][b.n1] += b.g; }
        else {
          G[b.n1][b.n1] += b.g; G[b.n2][b.n2] += b.g;
          G[b.n1][b.n2] -= b.g; G[b.n2][b.n1] -= b.g;
          // series EMF E in the n1->n2 branch: I = (V1 - V2 - E)·g, so the
          // constant term moves to the RHS with +E·g at n1, −E·g at n2
          if (b.emf) { I[b.n1] += b.emf * b.g; I[b.n2] -= b.emf * b.g; }
        }
      }
      for (let n = 0; n < N; n++) G[n][n] += GMIN;
      for (const n of gndNets) { G[n] = new Array(N).fill(0); G[n][n] = 1; I[n] = 0; }
      return solveLinear(G, I);
    }

    const vAt = (part, id) => {
      const n = netOfPort(part, id);
      return n == null ? null : V[n];
    };

    function evalState(branches) {
      const next = new Set();
      for (const part of circuit.parts) {
        const model = MODELS[part.type] || MODELS.generic;
        (model.pairs || []).forEach((pair, pi) => {
          if (pair.kind === 'diode') {
            const va = vAt(part, pair.a), vb = vAt(part, pair.b);
            if (va != null && vb != null) {
              if (va - vb >= effVf(part, pair) - 0.05) next.add(part.uid + ':diode' + pi);
              else if (pair.vz && vb - va >= pair.vz - 0.05) next.add(part.uid + ':zener' + pi);
            }
          }
          if (pair.kind === 'fuse' && state.has(part.uid + ':blown' + pi)) {
            next.add(part.uid + ':blown' + pi); // blown stays blown this run
          }
        });
        (model.cond || []).forEach((c, ci) => {
          const vp = vAt(part, c.test.p);
          const vn = c.test.n ? vAt(part, c.test.n) : 0;
          const min = typeof c.test.min === 'function' ? c.test.min(part) : c.test.min;
          if (vp != null && vn != null && vp - vn > min) next.add(part.uid + ':cond' + ci);
        });
      }
      // fuse blowing needs currents
      branches.forEach((b) => {
        if (!b.isFuse) return;
        const i = Math.abs((V[b.n1] - V[b.n2]) * b.g);
        if (i > b.rating) {
          const pi = Number(b.tag.split(':')[2]);
          next.add(b.part.uid + ':blown' + pi);
        }
      });
      return next;
    }

    let branches = assemble();
    for (let iter = 0; iter < 10; iter++) {
      V = stamp(branches);
      const next = evalState(branches);
      const same = next.size === state.size && [...next].every((x) => state.has(x));
      state = next;
      branches = assemble();
      if (same && iter > 0) break;
    }
    V = stamp(branches);

    const branchI = branches.map((b) => {
      if (b.n1 === -1) return (b.src - V[b.n2]) * b.g;
      if (b.gnd) return V[b.n1] * b.g;
      return (V[b.n1] - V[b.n2] - (b.emf || 0)) * b.g;
    });

    const wireCurrents = circuit.wires.map((w) => {
      const n = netOf.get(w.from);
      let best = 0;
      branches.forEach((b, i) => {
        if (b.n1 === n || b.n2 === n) best = Math.max(best, Math.abs(branchI[i]));
      });
      const va = V[netOf.get(w.from)] || 0, vb = V[netOf.get(w.to)] || 0;
      return { current: best, volts: va, dir: va >= vb ? 1 : -1 };
    });

    // ---- part states + safety ----------------------------------------------
    for (const part of circuit.parts) {
      const model = MODELS[part.type] || MODELS.generic;
      const st = { current: 0, on: false, reversed: false, connected: false, blown: false, engaged: false };
      (model.pairs || []).forEach((pair, pi) => {
        const na = netOfPort(part, pair.a), nb = netOfPort(part, pair.b);
        if (na == null || nb == null) return;
        st.connected = true;
        const bi = branches.findIndex((b) => b.part === part && b.pair === pair);
        const dv = V[na] - V[nb];
        if (pair.kind === 'diode') {
          const on = state.has(part.uid + ':diode' + pi);
          const i = on && bi >= 0 ? Math.max(0, branchI[bi]) : 0;
          st.current = Math.max(st.current, i);
          st.on = st.on || i > 0.0005;
          if (!on && dv < -0.5 && !pair.vz) st.reversed = true;
        } else if (pair.kind === 'cap') {
          if (pair.polar && dv < -0.5) {
            st.reversed = true;
            warnings.push({ level: 'danger',
              msg: `Electrolytic capacitor is reverse-polarized (${(-dv).toFixed(1)}V backwards) — it can vent or burst. Flip it.` });
          }
          if (Math.abs(dv) > (part.vr || pair.vr || 16)) warnings.push({ level: 'warn',
            msg: `Capacitor sees ${Math.abs(dv).toFixed(1)}V — over its ${part.vr || pair.vr}V rating.` });
        } else if (pair.kind === 'fuse') {
          if (state.has(part.uid + ':blown' + pi)) {
            st.blown = true;
            warnings.push({ level: 'warn',
              msg: `Fuse blew (${((part.r || pair.rating)).toFixed(1)}A rating exceeded) — circuit beyond it is dead. That's the fuse doing its job.` });
          } else if (bi >= 0) { st.current = Math.abs(branchI[bi]); st.on = st.current > 0.0005; }
        } else if (pair.meter && bi >= 0) {
          st.connected = true;
          if (pair.meter === 'V') st.reading = { unit: 'V', value: dv };
          else st.reading = { unit: 'A', value: branchI[bi] };
        } else if (bi >= 0) {
          st.current = Math.max(st.current, Math.abs(branchI[bi]));
          st.on = st.on || Math.abs(branchI[bi]) > 0.0005;
          if (pair.kind === 'src') {
            const i = Math.abs(branchI[bi]);
            if (i > 2 && !pair.isPsu) warnings.push({ level: 'danger',
              msg: `${part.name} is short-circuited (${i.toFixed(1)}A)! Batteries dump huge current into a short — heat, burns, fire.` });
            if (pair.isPsu) {
              const cap = part.watts && part.volts ? part.watts / part.volts : part.amps;
              if (cap && i > cap * 3) warnings.push({ level: 'danger',
                msg: `Power supply shorted or massively overloaded: ${i.toFixed(2)}A against a ${cap.toFixed(2)}A rating. Real supplies shut down, cheap ones burn.` });
              else if (cap && i > cap) warnings.push({ level: 'warn',
                msg: `Power supply over capacity: ${(i * 1000).toFixed(0)}mA drawn, rated ${(cap * 1000).toFixed(0)}mA${part.watts ? ' (' + part.watts + 'W @ ' + part.volts + 'V)' : ''}. Voltage will sag.` });
            }
          }
          if (pair.isCoil && Math.abs(dv) > 3.5) st.engaged = true;
        }
      });
      (model.cond || []).forEach((c, ci) => {
        if (state.has(part.uid + ':cond' + ci)) st.engaged = true;
      });
      partState[part.uid] = st;
      // motor-class loads: WHERE the current comes from decides the verdict —
      // a GPIO pin is a dead pin, the board rail is a brownout, a proper
      // driver with its own supply is exactly right (no warning).
      if (model.heavyLoad && st.on) {
        const gpioNets = new Set(branches.filter((b) => b.tag === 'gpio').map((b) => b.n2));
        const railNets = new Set(rails.map((r) => r.net));
        const portNets = [];
        (model.pairs || []).forEach((pair) => {
          for (const id of [pair.a, pair.b]) {
            const n = netOfPort(part, id);
            if (n != null) portNets.push(n);
          }
        });
        if (portNets.some((n) => gpioNets.has(n))) warnings.push({ level: 'danger',
          msg: `${part.name} draws motor-class current. Never straight off a pin — use a driver (ULN2003/A4988) with its own supply.` });
        else if (portNets.some((n) => railNets.has(n))) warnings.push({ level: 'warn',
          msg: `${part.name} is running off the board's rail — motor surges brown the board out. Give it its own supply through a driver.` });
      }
      if (model.note && st.connected) warnings.push({ level: 'hint', msg: `${part.name}: ${model.note}` });
      if (part.type === 'led') {
        if (st.reversed) warnings.push({ level: 'hint',
          msg: 'LED is wired backwards (anode to the lower voltage). No current flows — flip it.' });
        if (st.current > 0.025) warnings.push({ level: 'warn',
          msg: `LED at ${(st.current * 1000).toFixed(0)}mA — add/raise the series resistor (target ≤20mA).` });
        if (st.current > 0.030) warnings.push({ level: 'danger',
          msg: 'LED far over its rating — it will burn out (and can crack).' });
      }
      if ((part.type === 'npn' || part.type === 'pnp') && st.engaged) {
        const bji = branches.findIndex((b) => b.part === part && b.isDiode);
        if (bji >= 0 && Math.abs(branchI[bji]) > 0.02) warnings.push({ level: 'warn',
          msg: `${part.name}: base current ${(Math.abs(branchI[bji]) * 1000).toFixed(0)}mA — add a base resistor (1k–10k).` });
      }
    }

    let totalGpio = 0;
    branches.forEach((b, i) => {
      if (b.tag !== 'gpio') return;
      const I0 = Math.abs(branchI[i]);
      totalGpio += I0;
      if (I0 > I_GPIO_MAX) warnings.push({ level: 'danger',
        msg: `Pin ${b.pin.label}: ${(I0 * 1000).toFixed(0)}mA — over the absolute max (40mA). This can burn the pin out. Put a transistor or driver in between.` });
      else if (I0 > I_GPIO_WARN) warnings.push({ level: 'warn',
        msg: `Pin ${b.pin.label}: ${(I0 * 1000).toFixed(0)}mA — above the recommended 20mA.` });
    });
    if (totalGpio > 0.2) warnings.push({ level: 'danger',
      msg: `Total GPIO current ${(totalGpio * 1000).toFixed(0)}mA — beyond what the chip package survives (~200mA).` });
    branches.forEach((b, i) => {
      if (b.tag !== 'rail') return;
      const I0 = Math.abs(branchI[i]);
      if (I0 > 2) warnings.push({ level: 'danger',
        msg: `SHORT CIRCUIT on the ${b.src}V rail (${I0.toFixed(1)}A). Wires heat fast — fire risk. Unplug and re-check.` });
      else if (I0 > I_RAIL_WARN) warnings.push({ level: 'warn',
        msg: `${b.src}V rail at ${(I0 * 1000).toFixed(0)}mA — beyond a USB port's 500mA budget.` });
    });
    if (vcc < 5) {
      for (const bp of circuit.boardPins) {
        if (!netOf.has(bp.key) || bp.power || bp.tele == null) continue;
        const v = V[netOf.get(bp.key)];
        if (v > vcc + 0.6) warnings.push({ level: 'danger',
          msg: `Pin ${bp.label} sees ${v.toFixed(1)}V on a ${vcc}V board — that can kill the chip. Level-shift it.` });
      }
    }

    // an ammeter across a supply: the classic way to pop a multimeter fuse
    for (const part of circuit.parts) {
      if (part.type !== 'ammeter') continue;
      const st = partState[part.uid];
      if (st && st.reading && Math.abs(st.reading.value) > 10) warnings.push({ level: 'danger',
        msg: `${part.name} reads ${Math.abs(st.reading.value).toFixed(1)}A — it is wired ACROSS a supply instead of in series. A real meter's fuse blows (or the meter does). Put it in the path of the current.` });
    }

    // ---- what each input pin would READ -------------------------------------
    // HIGH above 0.6·VCC, LOW below 0.3·VCC (CMOS thresholds), the band in
    // between is undefined, and a pin with nothing driving it floats — the
    // number-one "my button reads random" bug, now visible before you build.
    const netDriven = new Array(N).fill(false);
    for (const b of branches) {
      if (b.n1 === -1) netDriven[b.n2] = true;
      else if (b.gnd) netDriven[b.n1] = true;
      else if (b.g > 1e-7) { netDriven[b.n1] = true; netDriven[b.n2] = true; }
    }
    // a net is really driven only if it connects (through conductances) to a
    // source or ground: walk from every anchored net
    const adj = Array.from({ length: N }, () => []);
    for (const b of branches) {
      if (b.n1 >= 0 && !b.gnd && b.n2 != null && b.g > 1e-7) { adj[b.n1].push(b.n2); adj[b.n2].push(b.n1); }
    }
    const anchored = new Array(N).fill(false);
    const stack = [];
    for (const n of gndNets) { anchored[n] = true; stack.push(n); }
    for (const b of branches) {
      const n = b.n1 === -1 ? b.n2 : (b.gnd ? b.n1 : null);
      if (n != null && !anchored[n]) { anchored[n] = true; stack.push(n); }
    }
    while (stack.length) {
      const n = stack.pop();
      for (const m of adj[n]) if (!anchored[m]) { anchored[m] = true; stack.push(m); }
    }
    const pinReads = {};
    for (const bp of circuit.boardPins) {
      if (bp.power || bp.tele == null || !netOf.has(bp.key)) continue;
      const st = circuit.pinStates.get(bp.tele);
      if (st && st.mode !== 'in') continue;
      const n = netOf.get(bp.key);
      const v = V[n];
      pinReads[bp.key] = !anchored[n] ? 'FLOAT' : v >= 0.6 * vcc ? 'HIGH' : v <= 0.3 * vcc ? 'LOW' : 'UNDEFINED';
      if (pinReads[bp.key] === 'FLOAT' && circuit.wires.some((w) => w.from === bp.key || w.to === bp.key)) {
        warnings.push({ level: 'hint',
          msg: `Pin ${bp.label} is an input with nothing pulling it — it will read random noise. Add a pull-up/down resistor or use INPUT_PULLUP.` });
      } else if (pinReads[bp.key] === 'UNDEFINED') {
        warnings.push({ level: 'warn',
          msg: `Pin ${bp.label} sits at ${v.toFixed(2)}V — between the LOW and HIGH thresholds, so digitalRead() is unreliable. Use analogRead() or fix the divider.` });
      }
    }

    // ---- ratings: every part knows what voltage it is designed for ---------
    // part.ratings.pairs = [{p, n, min, max, abs, name?}] measured V(p)−V(n).
    // Injected by the wiring layer from the parts knowledge base (and by
    // catalog classification for real products). abs = damage, max = out of
    // spec, min = won't run. The info card explains the failure mode.
    for (const part of circuit.parts) {
      const rat = part.ratings;
      if (!rat || !rat.pairs) continue;
      for (const pr of rat.pairs) {
        const vp = vAt(part, pr.p), vn = vAt(part, pr.n);
        if (vp == null || vn == null) continue;
        const dv = vp - vn;
        const nm = part.name + (pr.name ? ' ' + pr.name : '');
        if (pr.abs != null && dv > pr.abs + 0.05) warnings.push({ level: 'danger',
          msg: `${nm} sees ${dv.toFixed(1)}V — past its ${pr.abs}V absolute max. That is damage, not margin (ⓘ on the part explains how it fails).` });
        else if (pr.max != null && dv > pr.max + 0.05) warnings.push({ level: 'warn',
          msg: `${nm} at ${dv.toFixed(1)}V — designed for ${pr.min != null ? pr.min + '–' : 'up to '}${pr.max}V. Out of spec; lifetime and behavior suffer.` });
        else if (pr.min != null && dv > 0.5 && dv < pr.min - 0.05) warnings.push({ level: 'hint',
          msg: `${nm} undervolted: ${dv.toFixed(1)}V against a ${pr.min}V minimum — expect it to misbehave or not start.` });
        if (pr.abs != null && dv < -0.5) warnings.push({ level: 'warn',
          msg: `${nm} is reverse-powered (${(-dv).toFixed(1)}V backwards) — check + and −.` });
      }
    }
    // NeoPixel data threshold: DIN must see ≥0.7×VDD. A 5V-powered strip on
    // 3.3V logic is the classic glitchy-rainbow — flag it before the build.
    for (const part of circuit.parts) {
      if (part.type !== 'neopixel') continue;
      const vP = vAt(part, 'v5'), vN = vAt(part, 'gnd');
      if (vP == null || vN == null) continue;
      const vdd = vP - vN;
      const dinNet = netOfPort(part, 'din');
      if (dinNet == null || vdd < 3) continue;
      const driven = branches.some((b) => b.tag === 'gpio' && b.n2 === dinNet);
      if (driven && vcc < 0.7 * vdd) warnings.push({ level: 'warn',
        msg: `NeoPixel data: ${vcc}V logic into a ${vdd.toFixed(1)}V-powered strip is below the 0.7×VDD threshold — glitches ahead. Level-shift DIN (74AHCT125) or run the strip at ${vcc}V.` });
    }

    // a circuit needs a source: a power-supply block, a battery, a wired
    // board power pin, or a driven GPIO. Otherwise nothing can flow.
    const hasSource = rails.length > 0 ||
      branches.some((b) => b.tag === 'gpio' || b.isSrc);
    if (circuit.wires.length && !hasSource) warnings.push({ level: 'hint',
      msg: 'No power source in this circuit — add a Power supply block (or a battery, or wire the board\'s 5V/3V3 + GND). Nothing conducts until something sources voltage.' });

    return { netVolts: V, netOf, wireCurrents, partState, warnings, pinReads };
  }

  const api = { solve, MODELS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PinodeSim = api;
})(typeof window !== 'undefined' ? window : globalThis);
