// Electronics calculators: pure math, no DOM. Standard IEC 60063 E-series
// values, resistor colour codes, LED resistors, dividers, RC, Ohm's law,
// battery life and ADC conversion.
(function (root) {
  'use strict';

  const E12 = [1.0, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2];
  const E24 = [1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1];
  const E96 = [1.00, 1.02, 1.05, 1.07, 1.10, 1.13, 1.15, 1.18, 1.21, 1.24, 1.27, 1.30, 1.33, 1.37, 1.40, 1.43, 1.47, 1.50,
    1.54, 1.58, 1.62, 1.65, 1.69, 1.74, 1.78, 1.82, 1.87, 1.91, 1.96, 2.00, 2.05, 2.10, 2.15, 2.21, 2.26, 2.32, 2.37, 2.43,
    2.49, 2.55, 2.61, 2.67, 2.74, 2.80, 2.87, 2.94, 3.01, 3.09, 3.16, 3.24, 3.32, 3.40, 3.48, 3.57, 3.65, 3.74, 3.83, 3.92,
    4.02, 4.12, 4.22, 4.32, 4.42, 4.53, 4.64, 4.75, 4.87, 4.99, 5.11, 5.23, 5.36, 5.49, 5.62, 5.76, 5.90, 6.04, 6.19, 6.34,
    6.49, 6.65, 6.81, 6.98, 7.15, 7.32, 7.50, 7.68, 7.87, 8.06, 8.25, 8.45, 8.66, 8.87, 9.09, 9.31, 9.53, 9.76];
  const SERIES = { E12, E24, E96 };

  const round = (v, d = 6) => Number(v.toPrecision(d));

  // every value of a series from 1Ω to 10MΩ, ascending
  function seriesValues(name) {
    const base = SERIES[name] || E24;
    const out = [];
    for (let dec = 0; dec <= 6; dec++) for (const b of base) out.push(round(b * Math.pow(10, dec), 4));
    out.push(10e6);
    return out;
  }

  // nearest value; mode 'up' = smallest value ≥ target (safe for LED resistors)
  function nearest(target, name = 'E24', mode = 'nearest') {
    const vals = seriesValues(name);
    if (mode === 'up') return vals.find((v) => v >= target * (1 - 1e-9)) || vals[vals.length - 1];
    if (mode === 'down') { const lo = vals.filter((v) => v <= target * (1 + 1e-9)); return lo.length ? lo[lo.length - 1] : vals[0]; }
    let best = vals[0];
    for (const v of vals) if (Math.abs(Math.log(v / target)) < Math.abs(Math.log(best / target))) best = v;
    return best;
  }

  // engineering format: 4700 → "4.7k", 0.0001 → "100µ"
  function eng(v, unit = '') {
    if (v == null || !isFinite(v)) return '—';
    if (v === 0) return '0' + unit;
    const pre = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p']];
    const a = Math.abs(v);
    for (const [f, p] of pre) if (a >= f * 0.9995) return round(v / f, 3) + p + unit;
    return round(v / 1e-12, 3) + 'p' + unit;
  }

  // LED series resistor: R = (Vs − Vf) / I
  function ledResistor(vs, vf, mA, series = 'E24') {
    const i = mA / 1000;
    if (!(vs > vf) || !(i > 0)) return { error: 'The supply must be higher than the LED forward voltage' };
    const exact = (vs - vf) / i;
    const r = nearest(exact, series, 'up');
    const actual = (vs - vf) / r;
    const p = actual * actual * r;
    const watt = [0.125, 0.25, 0.5, 1, 2, 3, 5].find((w) => w >= p * 2) || 5;   // 2× margin
    return { exact, r, actualmA: actual * 1000, powerW: p, ratingW: watt };
  }

  // Vout = Vin · R2 / (R1 + R2)
  function divider(vin, r1, r2) {
    if (!(r1 > 0) || !(r2 > 0)) return { error: 'Both resistors must be above 0Ω' };
    return { vout: vin * r2 / (r1 + r2), currentmA: vin / (r1 + r2) * 1000, ratio: r2 / (r1 + r2) };
  }

  // best standard pair for a target ratio, total resistance near `total`
  function solveDivider(vin, vout, series = 'E24', total = 10000) {
    if (!(vin > 0) || !(vout > 0) || vout >= vin) return { error: 'Vout must be between 0 and Vin' };
    const vals = seriesValues(series).filter((v) => v >= total / 100 && v <= total * 100);
    let best = null;
    for (const r2 of vals) {
      const r1 = nearest(r2 * (vin - vout) / vout, series);
      const v = vin * r2 / (r1 + r2);
      const err = Math.abs(v - vout) / vout;
      const spread = Math.abs(Math.log((r1 + r2) / total));
      const score = err * 100 + spread * 0.05;
      if (!best || score < best.score) best = { r1, r2, vout: v, errorPct: err * 100, score };
    }
    delete best.score;
    return best;
  }

  const COLORS = ['black', 'brown', 'red', 'orange', 'yellow', 'green', 'blue', 'violet', 'grey', 'white'];
  const MULT = { silver: -2, gold: -1, black: 0, brown: 1, red: 2, orange: 3, yellow: 4, green: 5, blue: 6, violet: 7, grey: 8, white: 9 };
  const TOL = { brown: 1, red: 2, green: 0.5, blue: 0.25, violet: 0.1, grey: 0.05, gold: 5, silver: 10 };

  // colour bands for a value: 4-band (2 digits) or 5-band (3 digits)
  function colorCode(ohms, bands = 4, tolerance) {
    const digits = bands === 5 ? 3 : 2;
    if (!(ohms > 0)) return { error: 'Enter a resistance above 0Ω' };
    let exp = Math.floor(Math.log10(ohms)) - (digits - 1);
    let mant = Math.round(ohms / Math.pow(10, exp));
    if (mant >= Math.pow(10, digits)) { mant /= 10; exp++; }
    if (exp < -2 || exp > 9) return { error: 'Out of colour-code range' };
    const ds = String(mant).padStart(digits, '0').split('').map(Number);
    const mult = Object.keys(MULT).find((k) => MULT[k] === exp);
    const tol = tolerance || (bands === 5 ? 'brown' : 'gold');
    return { bands: [...ds.map((d) => COLORS[d]), mult, tol], value: mant * Math.pow(10, exp), tolerancePct: TOL[tol] };
  }

  // value from colour bands
  function fromColors(list) {
    const b = list.map((c) => String(c).toLowerCase());
    const digits = b.length >= 5 ? 3 : 2;
    let v = 0;
    for (let i = 0; i < digits; i++) {
      const d = COLORS.indexOf(b[i]);
      if (d < 0) return { error: 'Band ' + (i + 1) + ' must be a digit colour' };
      v = v * 10 + d;
    }
    const m = MULT[b[digits]];
    if (m == null) return { error: 'Unknown multiplier colour' };
    const tol = b[digits + 1] ? TOL[b[digits + 1]] : 20;
    return { ohms: round(v * Math.pow(10, m), 6), tolerancePct: tol };
  }

  // RC: time constant and −3 dB cutoff
  function rc(r, c) {
    if (!(r > 0) || !(c > 0)) return { error: 'R and C must be above 0' };
    const tau = r * c;
    return { tau, fc: 1 / (2 * Math.PI * tau), settle99: 5 * tau };
  }

  // Ohm's law from any two of V, I, R, P (unknowns null)
  function ohm({ v, i, r, p }) {
    const has = (x) => x != null && isFinite(x);
    if (has(v) && has(i)) return { v, i, r: v / i, p: v * i };
    if (has(v) && has(r)) return { v, i: v / r, r, p: v * v / r };
    if (has(i) && has(r)) return { v: i * r, i, r, p: i * i * r };
    if (has(p) && has(v)) return { v, i: p / v, r: v * v / p, p };
    if (has(p) && has(i)) return { v: p / i, i, r: p / (i * i), p };
    if (has(p) && has(r)) return { v: Math.sqrt(p * r), i: Math.sqrt(p / r), r, p };
    return { error: 'Fill in any two values' };
  }

  // battery life: capacity derated (self-discharge, cutoff) over the average draw
  function batteryLife({ mAh, activemA, sleepmA = 0, dutyPct = 100, derate = 0.85 }) {
    const duty = Math.min(100, Math.max(0, dutyPct)) / 100;
    const avg = activemA * duty + sleepmA * (1 - duty);
    if (!(mAh > 0) || !(avg > 0)) return { error: 'Capacity and current must be above 0' };
    const hours = mAh * derate / avg;
    return { avgmA: avg, hours, days: hours / 24 };
  }

  // ADC counts ↔ volts
  function adc({ bits = 10, vref = 5, counts, volts }) {
    const max = Math.pow(2, bits) - 1;
    if (counts != null && isFinite(counts)) return { volts: counts * vref / max, counts, lsb: vref / max };
    if (volts != null && isFinite(volts)) return { counts: Math.round(Math.min(vref, Math.max(0, volts)) / vref * max), volts, lsb: vref / max };
    return { error: 'Enter counts or volts' };
  }

  // "4.7k", "4k7", "100n", "2.2u", "1M", "330" → number (null if unreadable)
  function parseEng(str) {
    const t = String(str == null ? '' : str).trim().replace(/(Ω|ohms?|[FVAWH]|Hz)$/, '').replace(/\s+/g, '');
    if (!t) return null;
    const mult = { p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9 };
    let m = /^([-+]?\d*\.?\d+)([pnuµmkKMG])?$/.exec(t);
    if (m) return Number(m[1]) * (m[2] ? mult[m[2]] : 1);
    m = /^(\d+)([pnuµmkKMGR])(\d+)$/.exec(t);            // 4k7, 2R2
    if (m) return Number(m[1] + '.' + m[3]) * (m[2] === 'R' ? 1 : mult[m[2]]);
    return null;
  }

  // NE555 astable: f = 1.44 / ((R1 + 2·R2)·C), high time 0.693·(R1+R2)·C
  function timer555(r1, r2, c) {
    if (!(r1 > 0) || !(r2 > 0) || !(c > 0)) return { error: 'R1, R2 and C must be above 0' };
    const high = 0.693 * (r1 + r2) * c, low = 0.693 * r2 * c;
    return { freq: 1 / (high + low), high, low, dutyPct: high / (high + low) * 100 };
  }

  // capacitor marking: "104" = 10 × 10⁴ pF = 100nF; "4R7" = 4.7pF; "47" = 47pF
  function capCode(code) {
    const c = String(code || '').trim().toUpperCase().replace(/[JKMZ]$/, '');
    let pf = null;
    if (/^\d+R\d+$/.test(c)) pf = Number(c.replace('R', '.'));
    else if (/^\d{3}$/.test(c)) pf = Number(c.slice(0, 2)) * Math.pow(10, Number(c[2]));
    else if (/^\d{1,2}$/.test(c)) pf = Number(c);
    if (pf == null) return { error: 'Use the 3-digit code printed on the cap, like 104 or 472' };
    return { farads: pf * 1e-12, pf };
  }
  // farads → 3-digit code (inverse), for values ≥ 10pF
  function capToCode(f) {
    const pf = Math.round(f * 1e12 * 1000) / 1000;
    if (!(pf >= 10)) return null;
    const exp = Math.floor(Math.log10(pf)) - 1;
    const two = Math.round(pf / Math.pow(10, exp));
    return two >= 100 ? String(10) + (exp + 1) : String(two).padStart(2, '0') + exp;
  }

  // AVR USART: UBRR = F_CPU/(16·baud) − 1 (U2X: /8); error of the real rate
  function avrBaud(fcpu, baud) {
    if (!(fcpu > 0) || !(baud > 0)) return { error: 'Clock and baud must be above 0' };
    const calc = (div) => {
      const ubrr = Math.max(0, Math.min(4095, Math.round(fcpu / (div * baud)) - 1));
      const actual = fcpu / (div * (ubrr + 1));
      return { ubrr, actual, errorPct: (actual - baud) / baud * 100 };
    };
    return { normal: calc(16), u2x: calc(8) };
  }

  // linear regulator: everything above Vout is heat
  function regulatorHeat(vin, vout, mA, thetaJA = 50) {
    if (!(vin > vout)) return { error: 'Vin must be above Vout' };
    const w = (vin - vout) * mA / 1000;
    return { watts: w, efficiencyPct: vout / vin * 100, riseC: w * thetaJA };
  }

  // battery pack: S cells in series × P in parallel
  function batteryPack(cellV, cellmAh, s, p) {
    if (!(cellV > 0) || !(cellmAh > 0) || !(s >= 1) || !(p >= 1)) return { error: 'Fill in all four values' };
    return { volts: cellV * s, mAh: cellmAh * p, wh: cellV * s * cellmAh * p / 1000, cells: s * p };
  }

  // ---- v0.9 ----------------------------------------------------------------
  const nums = (list) => (list || []).map(Number).filter((x) => x > 0);
  function seriesR(list) { const v = nums(list); return v.length ? v.reduce((a, b) => a + b, 0) : null; }
  function parallelR(list) { const v = nums(list); return v.length ? 1 / v.reduce((a, b) => a + 1 / b, 0) : null; }
  const seriesC = parallelR, parallelC = seriesR;   // capacitors combine the other way round

  // American Wire Gauge: d = 0.127 mm × 92^((36 − n)/39); annealed copper
  // at 20 °C, ρ = 1.724e-8 Ω·m (IACS). Drop is for the round trip (out + back).
  function awg(n) {
    const g = Number(n);
    const d = 0.127 * Math.pow(92, (36 - g) / 39);       // mm
    const area = Math.PI * d * d / 4;                     // mm²
    return { gauge: g, diameterMm: d, areaMm2: area, ohmsPerM: 1.724e-8 / (area * 1e-6) };
  }
  function wireDrop(gauge, lengthM, amps, volts) {
    if (!(lengthM > 0) || !(amps > 0)) return { error: 'Length and current must be above 0' };
    const w = awg(gauge);
    const r = w.ohmsPerM * lengthM * 2;
    const drop = r * amps;
    return { ...w, roundTripOhms: r, drop, watts: drop * amps, pct: volts > 0 ? drop / volts * 100 : null };
  }

  // IPC-2221: I = k · ΔT^0.44 · A^0.725 (A in mil²; k = 0.048 outer, 0.024
  // inner layers); 1 oz/ft² copper is 1.378 mil (35 µm) thick
  function traceWidth(amps, riseC = 10, oz = 1, inner = false) {
    if (!(amps > 0) || !(riseC > 0) || !(oz > 0)) return { error: 'Current, temperature rise and copper weight must be above 0' };
    const k = inner ? 0.024 : 0.048;
    const areaMil2 = Math.pow(amps / (k * Math.pow(riseC, 0.44)), 1 / 0.725);
    const widthMil = areaMil2 / (oz * 1.378);
    return { areaMil2, widthMil, widthMm: widthMil * 0.0254 };
  }

  // switching a load with an NPN: drive it into saturation with a forced
  // beta of 10 (Ib = Ic/10), the usual rule for a clean low-loss switch
  function baseResistor(vDrive, loadmA, hFE = 100, vbe = 0.7, forced = 10) {
    if (!(vDrive > vbe)) return { error: 'The drive voltage must be above Vbe (0.7 V)' };
    if (!(loadmA > 0)) return { error: 'Load current must be above 0' };
    const ib = loadmA / 1000 / Math.min(forced, hFE);
    const r = (vDrive - vbe) / ib;
    return { ibmA: ib * 1000, ohms: r, nearest: nearest(r, 'E24', 'down'), minIbmA: loadmA / hFE,
             warn: ib * 1000 > 20 ? 'Base current is over 20 mA, more than a GPIO pin should give. Use a MOSFET or a Darlington (ULN2003).' : '' };
  }

  // zener shunt regulator: R = (Vin,min − Vz) / (Iload + Iz,min)
  function zenerResistor(vinMin, vinMax, vz, loadmA, izMinmA = 5) {
    if (!(vinMin > vz)) return { error: 'The minimum input must be above the zener voltage' };
    const vmax = vinMax > 0 ? Math.max(vinMax, vinMin) : vinMin;
    const r = (vinMin - vz) / ((loadmA + izMinmA) / 1000);
    const rStd = nearest(r, 'E24', 'down');
    const iMax = (vmax - vz) / rStd;
    return { ohms: r, nearest: rStd, resistorW: (vmax - vz) * iMax, zenerW: vz * iMax };
  }

  function pwm(dutyPct, vHigh, freq) {
    const d = Math.max(0, Math.min(100, Number(dutyPct))) / 100;
    const out = { avg: d * vHigh, value8: Math.round(d * 255), value10: Math.round(d * 1023) };
    if (freq > 0) { out.period = 1 / freq; out.onTime = d / freq; out.offTime = (1 - d) / freq; }
    return out;
  }

  // Arduino Servo library: write(0..180) maps to 544..2400 µs by default
  function servo(angle, minUs = 544, maxUs = 2400) {
    const a = Math.max(0, Math.min(180, Number(angle)));
    return { us: Math.round(minUs + (maxUs - minUs) * a / 180), angle: a };
  }
  function servoAngle(us, minUs = 544, maxUs = 2400) {
    return Math.max(0, Math.min(180, (Number(us) - minUs) * 180 / (maxUs - minUs)));
  }

  // stepper: belt (pitch × pulley teeth) or leadscrew (lead per turn)
  function stepper({ stepAngle = 1.8, microsteps = 16, beltPitch = 0, teeth = 0, lead = 0, speedMmS = 0 }) {
    const perRev = 360 / stepAngle * microsteps;
    const mmPerRev = beltPitch > 0 && teeth > 0 ? beltPitch * teeth : lead > 0 ? lead : 0;
    if (!(mmPerRev > 0)) return { stepsPerRev: perRev, error: 'Enter a belt pitch and pulley teeth, or a leadscrew lead' };
    const spm = perRev / mmPerRev;
    const out = { stepsPerRev: perRev, mmPerRev, stepsPerMm: spm, resolutionUm: 1000 / spm };
    if (speedMmS > 0) { out.stepRate = speedMmS * spm; out.rpm = speedMmS / mmPerRev * 60; }
    return out;
  }

  // NTC thermistor, Beta equation: 1/T = 1/T0 + ln(R/R0)/B
  function thermistor(r, r0 = 10000, beta = 3950, t0C = 25) {
    if (!(r > 0) || !(r0 > 0) || !(beta > 0)) return { error: 'Resistances and Beta must be above 0' };
    const invT = 1 / (t0C + 273.15) + Math.log(r / r0) / beta;
    const c = 1 / invT - 273.15;
    return { c, f: c * 9 / 5 + 32, k: c + 273.15 };
  }
  // ADC reading → thermistor resistance. thermistorLow: thermistor between
  // the pin and GND with the fixed resistor to Vcc (the common wiring)
  function thermistorFromAdc(reading, max = 1023, rFixed = 10000, thermistorLow = true) {
    const x = Number(reading);
    if (!(x > 0 && x < max)) return null;
    return thermistorLow ? rFixed * x / (max - x) : rFixed * (max - x) / x;
  }

  // AVR Timer1 (16-bit) in CTC mode: interrupt rate = F_CPU / (N · (OCR1A + 1));
  // a pin toggled on compare runs at half that
  function avrTimer1(fcpu, target) {
    if (!(fcpu > 0) || !(target > 0)) return { error: 'Clock and target frequency must be above 0' };
    const out = [];
    for (const n of [1, 8, 64, 256, 1024]) {
      const ocr = Math.round(fcpu / (n * target)) - 1;
      if (ocr < 0 || ocr > 65535) continue;
      const actual = fcpu / (n * (ocr + 1));
      out.push({ prescaler: n, ocr, actual, errorPct: (actual - target) / target * 100, toggleHz: actual / 2 });
    }
    if (!out.length) return { error: 'No prescaler reaches that frequency with a 16-bit timer' };
    out.sort((a, b) => Math.abs(a.errorPct) - Math.abs(b.errorPct) || a.prescaler - b.prescaler);
    const cs = { 1: '_BV(CS10)', 8: '_BV(CS11)', 64: '_BV(CS11) | _BV(CS10)', 256: '_BV(CS12)', 1024: '_BV(CS12) | _BV(CS10)' };
    const b = out[0];
    b.code = `noInterrupts();\nTCCR1A = 0;\nTCCR1B = _BV(WGM12) | ${cs[b.prescaler]};  // CTC, ÷${b.prescaler}\nOCR1A = ${b.ocr};\nTIMSK1 = _BV(OCIE1A);\ninterrupts();\n\nISR(TIMER1_COMPA_vect) {\n  // runs ${b.actual.toFixed(3)} times a second\n}`;
    return { best: b, all: out };
  }

  function dbFromRatio(ratio, power) { return (power ? 10 : 20) * Math.log10(ratio); }
  function ratioFromDb(db, power) { return Math.pow(10, db / (power ? 10 : 20)); }

  const api = { seriesR, parallelR, seriesC, parallelC, awg, wireDrop, traceWidth, baseResistor, zenerResistor, pwm, servo, servoAngle,
                stepper, thermistor, thermistorFromAdc, avrTimer1, dbFromRatio, ratioFromDb, timer555, capCode, capToCode, avrBaud, regulatorHeat, batteryPack, parseEng, E12, E24, E96, seriesValues, nearest, eng, ledResistor, divider, solveDivider, colorCode, fromColors,
                COLORS, rc, ohm, batteryLife, adc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ElectriCADCalc = api;
})(typeof window !== 'undefined' ? window : globalThis);
