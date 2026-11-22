// Real parts from the JLCPCB/LCSC catalogue made usable on the canvas and
// the PCB. Pure functions (UMD, tested in node):
//   parseSpecs   catalogue parameters → numbers the simulator and DRC use
//   kindOf       what a part is (resistor, LED, regulator, IC…)
//   footprintFor which KiCad footprint fits its package
//   matchSymbol  which KiCad symbol gives its pinout
//   toCanvasPart the part placed on the wiring canvas, with its pads
// Nothing is guessed: a pinout comes from a KiCad symbol for that part number
// (or the plain two terminals of a passive), a footprint from KiCad's library
// for that exact package. When either is missing the part says so ("check").
(function (root) {
  'use strict';

  // ---- numbers out of catalogue text ------------------------------------------------
  const SI = { p: 1e-12, n: 1e-9, u: 1e-6, µ: 1e-6, μ: 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9 };
  // "4.7kΩ" → 4700, "100nF" → 1e-7, "2.1V" → 2.1, "20mA" → 0.02
  function siNum(text, unit) {
    const t = String(text || '').replace(/\s+/g, '').replace(/,/g, '');
    const re = new RegExp('(-?\\d+(?:\\.\\d+)?)([pnuµμmkKMG]?)' + unit, 'i');
    const m = re.exec(t);
    if (!m) return null;
    const mult = m[2] ? (m[2] === 'm' && /^(Ω|ohm)$/i.test(unit) ? 1e-3 : (m[2] === 'M' && unit === 'Ω' ? 1e6 : SI[m[2]] || SI[m[2].toLowerCase()] || 1)) : 1;
    return +(Number(m[1]) * mult).toPrecision(12);
  }
  // "4.5V~16V" → { min: 4.5, max: 16 }
  function range(text, unit) {
    const parts = String(text || '').split(/~|to/);
    if (parts.length < 2) { const v = siNum(text, unit); return v == null ? null : { min: v, max: v }; }
    const a = siNum(parts[0], unit), b = siNum(parts[1], unit);
    return a == null && b == null ? null : { min: a, max: b };
  }
  const COLORS = ['red', 'green', 'blue', 'yellow', 'orange', 'white', 'amber', 'pink', 'purple', 'violet', 'warm white', 'cold white', 'emerald', 'yellow-green'];

  // params: [{ name, value }] (LCSC "paramVOList") and/or an attributes object;
  // desc: the catalogue's one-line description (fills gaps)
  function parseSpecs(params, desc) {
    const raw = {};
    for (const p of params || []) if (p && p.name) raw[p.name] = String(p.value);
    const get = (re) => { for (const [k, v] of Object.entries(raw)) if (re.test(k)) return v; return null; };
    const d = String(desc || '');
    const s = { raw };
    const res = get(/^Resistance$/i); if (res) s.r = siNum(res, 'Ω');
    const pw = get(/^Power\(?Watts\)?$|^Power$/i) || (/(\d+(?:\.\d+)?m?W)\b/.exec(d) || [])[1];
    if (pw) s.watts = siNum(pw, 'W');
    const tol = get(/^Tolerance$/i); if (tol) { const m = /([\d.]+)%/.exec(tol); if (m) s.tol = Number(m[1]) / 100; }
    const cap = get(/^Capacitance$/i); if (cap) s.cap = siNum(cap, 'F');
    const vr = get(/^Voltage Rating|^Rated Voltage|^Voltage Rated|^Voltage - Rated/i); if (vr) s.vr = siNum(vr, 'V');
    const vf = get(/^Forward Voltage|^Voltage - Forward|^Vf/i); if (vf) s.vf = siNum(vf, 'V');
    const ifw = get(/^Forward Current|^Current - Forward|^If\b|^Average Rectified Current|^Current - Average Rectified/i); if (ifw) s.ifwd = siNum(ifw, 'A');
    const vz = get(/^Zener Voltage|^Voltage - Zener/i); if (vz) s.vz = siNum(vz, 'V');
    const vrr = get(/^Reverse Voltage|^Voltage - DC Reverse|^Reverse Withstand|Repetitive Peak Reverse/i); if (vrr) s.vrr = siNum(vrr, 'V');
    const col = get(/Illumination Color|^Emitted Color|^Color$/i) || (/\b(red|green|blue|yellow|orange|white|amber)\b/i.exec(d) || [])[1];
    if (col) { const c = String(col).toLowerCase(); s.color = COLORS.find((x) => c.includes(x)) || c; }
    const vout = get(/^Output Voltage|^Voltage - Output/i); if (vout) { const r2 = range(vout, 'V'); if (r2) s.vout = r2.min === r2.max ? r2.min : null, s.voutRange = r2; }
    const vin = get(/^Input Voltage|^Voltage - Input|Maximum Input Voltage/i); if (vin) { const r2 = range(vin, 'V'); if (r2) s.vin = r2; }
    const sup = get(/^Voltage - Supply|^Supply Voltage|^Operating Voltage/i); if (sup) { const r2 = range(sup, 'V'); if (r2) s.supply = r2; }
    const drop = get(/^Dropout Voltage|^Voltage Dropout/i); if (drop) s.dropout = siNum(drop, 'V');
    const iout = get(/^Output Current|^Current - Output|^Current Rating|^Rated Current|^Current - Collector \(Ic\)|^Continuous Drain Current/i); if (iout) s.imax = siNum(iout, 'A');
    const itest = get(/^Test Current$/i); if (itest) s.itest = siNum(itest, 'A');
    const fuse = get(/^Current - Hold|^Hold Current|^Rated Current/i); if (fuse) s.ihold = siNum(fuse, 'A');
    const ind = get(/^Inductance$/i); if (ind) s.ind = siNum(ind, 'H');
    const t = get(/Operating Temperature/i) || (/(-?\d+)℃~\+?(-?\d+)℃/.exec(d) || [])[0];
    if (t) { const m = /(-?\d+)\s*℃?\s*~\s*\+?(-?\d+)/.exec(t); if (m) s.temp = { min: Number(m[1]), max: Number(m[2]) }; }
    // the description fills what the parameter list did not say
    if (s.r == null) { const m = /(\d+(?:\.\d+)?[kKM]?)Ω/.exec(d); if (m) s.r = siNum(m[0], 'Ω'); }
    if (s.cap == null) { const m = /(\d+(?:\.\d+)?[pnuµμ]F)/.exec(d); if (m) s.cap = siNum(m[1], 'F'); }
    if (s.vr == null && /capacitor/i.test(d)) { const m = /(\d+(?:\.\d+)?V)\b/.exec(d); if (m) s.vr = siNum(m[1], 'V'); }
    for (const k of Object.keys(s)) if (s[k] == null) delete s[k];
    return s;
  }

  // ---- what the part is ---------------------------------------------------------------
  // category: "Resistors / Chip Resistor - Surface Mount" etc.
  function kindOf(category, desc, mfr) {
    const c = String(category || '') + ' | ' + String(desc || '');
    if (/potentiometer|trimmer|variable resistor/i.test(c)) return 'pot';
    if (/resistor network|resistor array/i.test(c)) return 'ic';
    if (/\bResistors?\b/i.test(category || '') || /Chip Resistor|Through Hole Resistor|Current Sense Resistor/i.test(c)) return 'resistor';
    if (/Aluminum Electrolytic|Tantalum|Polymer|Electric Double Layer|Supercap/i.test(c)) return 'capE';
    if (/Capacitor|MLCC/i.test(c)) return 'capC';
    if (/LED Indication|Light Emitting Diode|\bLEDs?\b.*Discrete|Discrete.*LED/i.test(c) && !/driver|RGB|addressable|WS28|SK68|matrix|display|segment/i.test(c)) return 'led';
    if (/Zener/i.test(c)) return 'zener';
    if (/Schottky/i.test(c)) return 'schottky';
    if (/Diodes? - General|Rectifier|Switching Diode|Fast Recovery|Diodes?\b/i.test(category || '') && !/TVS|ESD|bridge|array/i.test(c)) return 'diode';
    if (/Resettable Fuse|PTC|Fuses?\b/i.test(category || '')) return 'fuse';
    if (/Inductor|Choke/i.test(c) && !/common mode|transformer/i.test(c)) return 'inductor';
    if (/Bipolar|BJT/i.test(c)) return /PNP/i.test(c) ? 'pnp' : 'npn';
    if (/MOSFET/i.test(c)) return /P-Channel|P Channel|PMOS/i.test(c) ? 'pmos' : 'nmos';
    if (/Linear Voltage Regulator|LDO|Low Dropout/i.test(c)) return 'linreg';
    return 'ic';
  }
  const TWO_PIN = { resistor: 1, capC: 1, capE: 1, led: 1, diode: 1, schottky: 1, zener: 1, fuse: 1, inductor: 1 };

  // ---- footprints ---------------------------------------------------------------------
  const METRIC = { '0201': '0603', '0402': '1005', '0603': '1608', '0805': '2012', '1206': '3216', '1210': '3225', '1812': '4532', '2010': '5025', '2512': '6332' };
  const CHIP_LIB = { resistor: ['Resistor_SMD', 'R'], capC: ['Capacitor_SMD', 'C'], capE: ['Capacitor_Tantalum_SMD', 'CP'], led: ['LED_SMD', 'LED'],
    diode: ['Diode_SMD', 'D'], schottky: ['Diode_SMD', 'D'], zener: ['Diode_SMD', 'D'], inductor: ['Inductor_SMD', 'L'], fuse: ['Fuse', 'Fuse'] };
  // pkg: the catalogue's package ("0603", "SOIC-8", "SOT-23-5", "LQFP-48(7x7)")
  // ids: every KiCad footprint id ("Lib:Name"). Returns { id, how } or null.
  function footprintFor(pkg, kind, ids, pinCount) {
    const P = String(pkg || '').trim();
    const U = P.toUpperCase().replace(/\s+/g, '');
    const has = (id) => ids.has ? ids.has(id) : ids.includes(id);
    const list = ids.has ? [...ids] : ids;
    const one = (re) => { const m = list.filter((id) => re.test(id)); return m.length === 1 ? m[0] : null; };
    // chip passives
    const chip = /^(0201|0402|0603|0805|1206|1210|1812|2010|2512)$/.exec(U);
    if (chip && CHIP_LIB[kind]) {
      const [lib, pre] = CHIP_LIB[kind];
      const id = `${lib}:${pre}_${chip[1]}_${METRIC[chip[1]]}Metric`;
      if (has(id)) return { id, how: 'package' };
    }
    // diode packages
    const dp = { 'SOD-123': 'Diode_SMD:D_SOD-123', 'SOD-123F': 'Diode_SMD:D_SOD-123F', 'SOD-323': 'Diode_SMD:D_SOD-323', 'SOD-523': 'Diode_SMD:D_SOD-523',
      'SMA': 'Diode_SMD:D_SMA', 'SMB': 'Diode_SMD:D_SMB', 'SMC': 'Diode_SMD:D_SMC', 'DO-214AC': 'Diode_SMD:D_SMA', 'DO-214AA': 'Diode_SMD:D_SMB', 'DO-214AB': 'Diode_SMD:D_SMC',
      'MINIMELF': 'Diode_SMD:D_MiniMELF', 'LL-34': 'Diode_SMD:D_MiniMELF', 'SOD-80': 'Diode_SMD:D_MiniMELF',
      'DO-41': 'Diode_THT:D_DO-41_SOD81_P10.16mm_Horizontal', 'DO-35': 'Diode_THT:D_DO-35_SOD27_P7.62mm_Horizontal',
      'DO-201AD': 'Diode_THT:D_DO-201AD_P15.24mm_Horizontal', 'DO-15': 'Diode_THT:D_DO-15_P10.16mm_Horizontal' };
    const dk = U.replace(/\(.*\)$/, '');
    if (dp[dk] && has(dp[dk]) && /diode|schottky|zener|led/.test(kind)) return { id: dp[dk], how: 'package' };
    // transistor / regulator packages (pin order still comes from the symbol)
    const tp = { 'SOT-23': 'Package_TO_SOT_SMD:SOT-23', 'SOT-23-3': 'Package_TO_SOT_SMD:SOT-23', 'SOT-23-3L': 'Package_TO_SOT_SMD:SOT-23',
      'SOT-23-5': 'Package_TO_SOT_SMD:SOT-23-5', 'SOT-23-6': 'Package_TO_SOT_SMD:SOT-23-6', 'SOT-23-8': 'Package_TO_SOT_SMD:SOT-23-8',
      'SOT-323': 'Package_TO_SOT_SMD:SOT-323_SC-70', 'SC-70': 'Package_TO_SOT_SMD:SOT-323_SC-70', 'SOT-363': 'Package_TO_SOT_SMD:SOT-363_SC-70-6',
      'SOT-89': 'Package_TO_SOT_SMD:SOT-89-3', 'SOT-89-3': 'Package_TO_SOT_SMD:SOT-89-3', 'SOT-223': 'Package_TO_SOT_SMD:SOT-223-3_TabPin2',
      'SOT-223-3': 'Package_TO_SOT_SMD:SOT-223-3_TabPin2', 'TO-252': 'Package_TO_SOT_SMD:TO-252-2', 'TO-252-2': 'Package_TO_SOT_SMD:TO-252-2', 'DPAK': 'Package_TO_SOT_SMD:TO-252-2',
      'TO-263': 'Package_TO_SOT_SMD:TO-263-2', 'TO-263-2': 'Package_TO_SOT_SMD:TO-263-2', 'D2PAK': 'Package_TO_SOT_SMD:TO-263-2',
      'TO-220': 'Package_TO_SOT_THT:TO-220-3_Vertical', 'TO-220-3': 'Package_TO_SOT_THT:TO-220-3_Vertical', 'TO-220F': 'Package_TO_SOT_THT:TO-220F-3_Vertical',
      'TO-92': 'Package_TO_SOT_THT:TO-92_Inline', 'TO-92-3': 'Package_TO_SOT_THT:TO-92_Inline', 'TO-247': 'Package_TO_SOT_THT:TO-247-3_Vertical' };
    if (tp[dk] && has(tp[dk])) return { id: tp[dk], how: 'package' };
    // SOIC / SOP / TSSOP / MSOP / DIP / QFN / QFP families
    let m = /^(SOIC|SOP|SO)-?(\d+)(?:-(150|208|300)MIL)?/.exec(U);
    if (m) {
      const n = Number(m[2]);
      const wide = m[3] === '300' || n >= 18;
      const body = m[3] === '208' ? '5.3x' : wide ? '7.5x' : '3.9x';
      const id = one(new RegExp('^Package_SO:(SOIC|SOP)-' + n + '_' + body.replace('.', '\\.') + '[\\d.]+mm_P1\\.27mm$'));
      if (id) return { id, how: 'package' };
    }
    m = /^(TSSOP|MSOP|VSSOP|SSOP|HTSSOP)-?(\d+)/.exec(U);
    if (m) {
      const fam = m[1] === 'VSSOP' ? 'VSSOP' : m[1];
      const body = fam === 'TSSOP' ? '4\\.4x' : fam === 'MSOP' || fam === 'VSSOP' ? '3x' : '';
      const id = one(new RegExp('^Package_SO:' + fam + '-' + m[2] + '_' + body + '[\\d.]+mm_P0\\.65mm$'));
      if (id) return { id, how: 'package' };
    }
    m = /^(?:DIP|PDIP)-?(\d+)/.exec(U);
    if (m) { const id = 'Package_DIP:DIP-' + m[1] + '_W7.62mm'; if (has(id)) return { id, how: Number(m[1]) >= 24 ? 'check-width' : 'package' }; }
    m = /^(LQFP|TQFP|QFP)-?(\d+)\(?(\d+(?:\.\d+)?)X(\d+(?:\.\d+)?)/.exec(U);
    if (m) { const id = one(new RegExp('^Package_QFP:' + (m[1] === 'QFP' ? 'LQFP' : m[1]) + '-' + m[2] + '_' + m[3] + 'x' + m[4] + 'mm_P[\\d.]+mm$')); if (id) return { id, how: 'package' }; }
    m = /^(QFN|DFN|VQFN|WQFN|UQFN)-?(\d+)\(?(\d+(?:\.\d+)?)X(\d+(?:\.\d+)?)/.exec(U);
    if (m) {
      const fam = m[1] === 'VQFN' || m[1] === 'WQFN' || m[1] === 'UQFN' ? m[1] : m[1];
      const c = list.filter((id) => new RegExp('^Package_DFN_QFN:' + fam + '-' + m[2] + '(-1EP)?_' + m[3] + 'x' + m[4] + 'mm_P[\\d.]+mm').test(id) && !/ThermalVias|EP\d/.test(id.split('_P')[1] || ''));
      if (c.length === 1) return { id: c[0], how: 'package' };
    }
    // 2.54 mm pin headers: "Pin header 1x4 2.54mm" or "P=2.54mm" with a pin count
    m = /(\d+)X(\d+).*2\.54/.exec(U);
    if (m && /header|connector/i.test(kind === 'ic' ? P + ' header' : '')) { const id = `Connector_PinHeader_2.54mm:PinHeader_${m[1]}x${String(m[2]).padStart(2, '0')}_P2.54mm_Vertical`; if (has(id)) return { id, how: 'package' }; }
    return null;
  }
  // the KiCad package family, to check a symbol's own footprint agrees with the catalogue
  function family(s) {
    const u = String(s || '').replace(/^[^:]*:/, '').toUpperCase();
    const m = /(SOIC|SOP|TSSOP|MSOP|SSOP|DIP|QFN|DFN|LQFP|TQFP|SOT-23|SOT-223|SOT-89|SOT-363|SOT-323|SC-70|TO-220|TO-92|TO-252|TO-263|TO-247|SOD-\d+|SMA|SMB|SMC)/.exec(u.replace(/SO-(\d)/, 'SOIC-$1'));
    if (!m) return '';
    return m[1] === 'SOP' ? 'SOIC' : m[1] === 'SC-70' ? 'SOT-323' : m[1];
  }
  function pinCountOf(pkg) { const m = /-(\d+)/.exec(String(pkg || '')); return m ? Number(m[1]) : null; }

  // ---- symbols (pinouts) --------------------------------------------------------------
  const norm = (s) => String(s || '').toUpperCase().replace(/\(.*?\)/g, '').replace(/[\s_]/g, '');
  // index: Map normalised name → [symbol]
  function symbolIndex(symbols) {
    const idx = new Map();
    idx.wild = new Map();   // STM32F103C8Tx: lowercase x stands for any one character
    idx.base = new Map();   // LM7805_TO220: one symbol per package, suffixed
    const add = (m, k, s) => { if (!m.has(k)) m.set(k, []); m.get(k).push(s); };
    for (const s of symbols) {
      add(idx, norm(s.n), s);
      if (/[A-Z0-9]x/.test(s.n)) {
        const pat = norm(s.n.replace(/x/g, '\u0001'));
        add(idx.wild, pat.slice(0, 4), { s, re: new RegExp('^' + pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\u0001/g, '.') + '$') });
      }
      const u = s.n.indexOf('_');
      if (u > 2) add(idx.base, norm(s.n.slice(0, u)), s);
    }
    return idx;
  }
  // a KiCad symbol for this manufacturer part number. Exact name first; then
  // KiCad's wildcard names (STM32F103C8Tx); then its per-package variants
  // (LM7805_TO220); then the longest symbol name the part number starts with
  // (NE555DR → NE555D: the suffix is tape-and-reel packing). The symbol's own
  // footprint must be the same package family as the catalogue's, or the pin
  // numbers could differ.
  function matchSymbol(mpn, pkg, idx) {
    const M = norm(mpn);
    if (M.length < 3) return null;
    const fam = family(pkg);
    const ok = (s) => !s.f || !fam || family(s.f) === fam;
    const exact = (idx.get(M) || []).filter(ok);
    if (exact.length) return { sym: exact[0], how: 'exact' };
    if (idx.wild) {
      const w = (idx.wild.get(M.slice(0, 4)) || []).filter((c) => c.re.test(M) && ok(c.s));
      if (w.length) return { sym: w[0].s, how: 'exact' };
    }
    const fams = (s) => s.f && fam && family(s.f) === fam;
    for (let L = M.length; L >= Math.max(4, M.length - 5); L--) {
      if (idx.base) {
        const b = (idx.base.get(M.slice(0, L)) || []).filter(fams);
        if (b.length === 1) return { sym: b[0], how: L === M.length ? 'exact' : 'prefix' };
      }
      if (L === M.length) continue;
      const c = (idx.get(M.slice(0, L)) || []).filter(ok);
      if (c.length) return { sym: c[0], how: 'prefix' };
    }
    return null;
  }

  // electrical type → wire colour class on the canvas
  function portType(name, etype) {
    const n = String(name || '').toUpperCase().replace(/[~{}]/g, '');
    if (/^(GND|VSS|AGND|DGND|PGND|V-|VEE|EP|PAD)$/.test(n)) return 'neg';
    if (etype === 'power_in' && /^(VCC|VDD|V\+|VIN|VI|VBAT|VBUS|AVCC|AVDD|DVDD|VS|IN|VCCIO)$/.test(n)) return 'pos';
    if (etype === 'power_out' || /^(VO|VOUT|OUT)$/.test(n) && etype === 'power_out') return 'pos';
    return 'sig';
  }

  // ---- the canvas part -------------------------------------------------------------
  // info: { lcsc, mfr, maker, pkg, desc, category, datasheet, stock, price, basic, params }
  // kicad: { symbols index, footprint ids (Set), footprint(id) → compact def }
  function toCanvasPart(info, kicad) {
    const specs = parseSpecs(info.params, info.desc);
    const kind = kindOf(info.category, info.desc, info.mfr);
    const notes = [];
    const lib = { lcsc: info.lcsc || '', mfr: info.mfr || '', maker: info.maker || '', pkg: info.pkg || '', desc: info.desc || '', category: info.category || '',
      datasheet: info.datasheet || '', basic: !!info.basic, specs, source: 'JLCPCB/LCSC catalogue', kind };
    let fp = footprintFor(info.pkg, kind, kicad.ids, pinCountOf(info.pkg));
    let sym = null;
    if (!TWO_PIN[kind]) {
      sym = matchSymbol(info.mfr, info.pkg, kicad.symbols);
      if (sym && sym.sym.f && kicad.ids.has(sym.sym.f)) {
        // KiCad's own pairing of symbol and footprint beats a package-name lookup
        if (!fp || family(sym.sym.f) === family(fp.id)) fp = { id: sym.sym.f, how: 'symbol' };
      }
    }
    if (fp && fp.how === 'check-width') notes.push('DIP width assumed 7.62 mm (300 mil); some 24+ pin DIPs are 15.24 mm');
    lib.fp = fp ? fp.id : '';
    if (!fp) notes.push(`no KiCad footprint for package "${info.pkg}" found automatically: pick one in the PCB panel`);
    const base = { name: info.mfr || 'Part', lib };
    // two-terminal parts: pad 1 / pad 2 by KiCad convention (LED/diode pad 1 = cathode, polarised cap pad 1 = +)
    if (TWO_PIN[kind]) {
      const pads = kind === 'led' || kind === 'diode' || kind === 'schottky' || kind === 'zener' ? { cathode: '1', anode: '2' } :
        kind === 'capE' ? { pos: '1', neg: '2' } : { a: '1', b: '2' };
      const out = { ...base, type: kind, lib: { ...lib, pads } };
      if (kind === 'resistor' && specs.r) out.r = specs.r;
      if (kind === 'resistor' && specs.watts) out.watts = specs.watts;
      if (kind === 'capE' && specs.vr) out.vr = specs.vr;
      if (kind === 'capC' && specs.vr) out.vr = specs.vr;
      if (kind === 'led') { if (specs.color) out.color = ['red', 'orange', 'yellow', 'green', 'blue', 'white'].find((c) => specs.color.includes(c)) || 'red'; if (specs.vf) out.vf = specs.vf; if (specs.ifwd || specs.itest) out.ifmax = specs.ifwd || specs.itest; }
      if ((kind === 'diode' || kind === 'schottky') && specs.vf) out.vf = specs.vf;
      if (kind === 'zener' && specs.vz) out.vz = specs.vz;
      if (kind === 'fuse' && (specs.ihold || specs.imax)) out.r = specs.ihold || specs.imax;
      if (kind === 'led' || kind === 'diode' || kind === 'schottky' || kind === 'zener') notes.push('polarity follows KiCad: pad 1 is the cathode; match the cathode mark on the part');
      out.lib.notes = notes;
      return out;
    }
    // everything else: the pins of its KiCad symbol, pad numbers as KiCad numbers them
    let pins;
    if (sym) {
      pins = sym.sym.p.map(([num, name, et]) => ({ id: 'p' + num, num, label: (name && name !== '~' ? name.replace(/[~{}]/g, '') : num), etype: et, type: portType(name, et) }));
      lib.symbol = sym.sym.l + ':' + sym.sym.n;
      lib.symbolMatch = sym.how;
      if (sym.how !== 'exact') notes.push(`pinout from KiCad symbol ${sym.sym.n} (${info.mfr} is that part with a packing/grade suffix): confirm against the datasheet`);
      if (!lib.datasheet && sym.sym.ds) lib.datasheet = sym.sym.ds;
    } else {
      const f = fp && kicad.footprint(fp.id);
      const nums = f ? [...new Set(f.p.map((p) => p[0]).filter((n) => n !== ''))] : [];
      pins = nums.map((num) => ({ id: 'p' + num, num, label: num, etype: 'passive', type: 'sig' }));
      notes.push('no KiCad symbol for ' + (info.mfr || 'this part') + ': pins are numbered from the footprint, so check the datasheet for what each one does');
    }
    lib.pins = pins;
    lib.pads = Object.fromEntries(pins.map((p) => [p.id, p.num]));
    lib.notes = notes;
    // parts the simulator models from their specs
    const named = (re) => pins.find((p) => re.test(p.label.toUpperCase()));
    if (kind === 'linreg' && specs.vout) {
      const pin = { in: named(/^(VI|VIN|IN|INPUT)$/), gnd: named(/^(GND|ADJ\/GND|GND\/ADJ)$/), out: named(/^(VO|VOUT|OUT|OUTPUT)$/) };
      if (pin.in && pin.gnd && pin.out && specs.vout) {
        if (!specs.dropout) notes.push('dropout not listed by the catalogue: the simulator assumes 1.2 V');
        const vmax = specs.vin && specs.vin.max;
        const ratings = vmax ? { pairs: [{ p: 'in', n: 'gnd', min: specs.vout, max: vmax, abs: +(vmax * 1.1).toFixed(2), name: 'IN' }] } : undefined;
        return { ...base, type: 'linreg', ratings, vout: specs.vout, dropout: specs.dropout || 1.2, vinMax: specs.vin && specs.vin.max, imax: specs.imax,
          lib: { ...lib, pads: { in: pin.in.num, gnd: pin.gnd.num, out: pin.out.num }, pins: undefined, notes } };
      }
    }
    if (kind === 'npn' || kind === 'pnp' || kind === 'nmos' || kind === 'pmos') {
      const bjt = kind === 'npn' || kind === 'pnp';
      const map = bjt ? { b: named(/^B$/), c: named(/^C$/), e: named(/^E$/) } : { g: named(/^G$/), d: named(/^D$/), s: named(/^S$/) };
      if (Object.values(map).every(Boolean) && pins.length === 3) {
        return { ...base, type: kind, lib: { ...lib, pads: Object.fromEntries(Object.entries(map).map(([k, p]) => [k, p.num])), pins: undefined, notes } };
      }
    }
    // supply ratings by pin name, for the over-voltage check (approximate: one pair)
    const vcc = named(/^(VCC|VDD|V\+|VS|VBAT|AVCC)$/), gnd = named(/^(GND|VSS|V-)$/);
    const out = { ...base, type: 'lib', lib };
    if (vcc && gnd && specs.supply && specs.supply.max) {
      out.ratings = { pairs: [{ p: vcc.id, n: gnd.id, min: specs.supply.min, max: specs.supply.max, abs: +(specs.supply.max * 1.1).toFixed(2), name: vcc.label }] };
      notes.push('the simulator checks its ' + vcc.label + ' supply against ' + specs.supply.min + '–' + specs.supply.max + ' V; its logic is not simulated');
    } else notes.push('not simulated beyond its connections');
    lib.approx = true;
    return out;
  }

  // ---- catalogue records → one shape -------------------------------------------------
  const cnum = (v) => (v == null || v === '' ? '' : /^C\d+$/i.test(String(v)) ? String(v).toUpperCase() : /^\d+$/.test(String(v)) ? 'C' + v : '');
  // a row from the JLCPCB search (jlcsearch): lcsc is a number, attributes a JSON string
  function infoFromSearch(r) {
    let attrs = r.attributes;
    if (typeof attrs === 'string') { try { attrs = JSON.parse(attrs); } catch (e) { attrs = null; } }
    const price = r.price1 != null ? r.price1 : r.price;
    return { lcsc: cnum(r.lcsc), mfr: r.mfr || '', maker: r.manufacturer || '', pkg: r.package || '', desc: r.description || '',
      category: [r.category, r.subcategory].filter(Boolean).join(' / ') || guessCategory(r), stock: r.stock != null ? Number(r.stock) : null,
      price: price != null && isFinite(price) ? Number(price) : null, basic: !!r.is_basic, preferred: !!r.is_preferred,
      params: attrs && typeof attrs === 'object' ? Object.entries(attrs).map(([name, value]) => ({ name, value })) : [] };
  }
  // the category rows (resistors/list.json…) carry no category; the description does
  function guessCategory(r) {
    const d = String(r.description || '');
    const m = /(Chip Resistor - Surface Mount|Through Hole Resistors|Multilayer Ceramic Capacitors MLCC - SMD\/SMT|Aluminum Electrolytic Capacitors[^R]*|LED Indication - Discrete|Schottky Diodes?|Zener Diodes?|Switching Diodes?|Diodes - General Purpose)/i.exec(d);
    return m ? m[1].trim() : '';
  }
  // the LCSC product detail record
  function infoFromLcsc(x) {
    if (!x) return null;
    const ladder = (x.productPriceList || []).map((p) => ({ qty: p.ladder, usd: p.usdPrice != null ? p.usdPrice : p.productPrice }));
    return { lcsc: cnum(x.productCode), mfr: x.productModel || '', maker: x.brandNameEn || '', pkg: x.encapStandard || '',
      desc: x.productIntroEn || x.productDescEn || '', category: [x.parentCatalogName, x.catalogName].filter(Boolean).join(' / '),
      datasheet: x.pdfUrl || '', stock: x.stockNumber != null ? Number(x.stockNumber) : null, price: ladder.length ? ladder[0].usd : null, ladder,
      image: (x.productImages || [])[0] || '', params: (x.paramVOList || []).map((p) => ({ name: p.paramNameEn, value: p.paramValueEn })) };
  }

  // KiCad compact footprint → the PCB editor's footprint format
  function kicadToFp(id, c) {
    if (!c) return null;
    const [libName, name] = String(id).split(':');
    const silk = (c.l || []).map((l) => ({ l })).concat((c.c || []).map((cc) => ({ c: cc })));
    return { name, lib: libName, label: name, kicad: id,
      pads: c.p.map(([num, shape, x, y, w, h, drill]) => ({ num: String(num), x, y, shape, w, h, drill })),
      silk, npth: (c.n || []).map(([x, y, d]) => ({ x, y, d })), smd: !!c.s, odd: !!c.o, courtyard: c.cy || null, descr: c.d || '' };
  }

  // the ports a placed catalogue part shows on the canvas (null: use the
  // built-in part type's own ports, e.g. a catalogue resistor is a resistor)
  const LINREG_PORTS = [{ id: 'in', label: 'IN', type: 'pos' }, { id: 'gnd', label: 'GND', type: 'neg' }, { id: 'out', label: 'OUT', type: 'pos' }];
  function portsOf(part) {
    if (!part || !part.lib) return null;
    if (part.type === 'linreg') return LINREG_PORTS;
    if (part.type === 'lib' && Array.isArray(part.lib.pins)) return part.lib.pins.map((p) => ({ id: p.id, label: p.label === p.num ? p.num : p.num + ' ' + p.label, type: p.type || 'sig', num: p.num }));
    return null;
  }
  // PCB: the footprint and which pad each port lands on, straight from the catalogue part
  function pcbFootprint(part) {
    const L = part && part.lib;
    if (!L || !L.fp || !L.fpData || !L.pads) return null;
    const REF = { resistor: 'R', capC: 'C', capE: 'C', led: 'D', diode: 'D', schottky: 'D', zener: 'D', fuse: 'F', inductor: 'L', npn: 'Q', pnp: 'Q', nmos: 'Q', pmos: 'Q', linreg: 'U', lib: 'U' };
    const def = kicadToFp(L.fp, L.fpData);
    const pins = {};
    for (const [port, pad] of Object.entries(L.pads)) pins[port] = String(pad);
    const notes = (L.notes || []).filter((n) => !/simulat/i.test(n));
    return { fp: 'K:' + L.fp, fpDef: def, pins, ref: REF[part.type] || 'U', check: notes.join('; '), note: L.lcsc ? 'LCSC ' + L.lcsc + (L.mfr ? ' · ' + L.mfr : '') : '' };
  }

  const api = { portsOf, pcbFootprint, LINREG_PORTS, infoFromSearch, infoFromLcsc, cnum, siNum, range, parseSpecs, kindOf, footprintFor, family, matchSymbol, symbolIndex, portType, toCanvasPart, kicadToFp, TWO_PIN, METRIC };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ElectriCADPartLib = api;
})(typeof window !== 'undefined' ? window : globalThis);
