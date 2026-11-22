// Builds renderer/boardparts.js: every component on each board drawing,
// straight from the maker's design files (run by hand when a board is added;
// the CAD files are not shipped). Usage:
//   node tools/extract-board-parts.js <cad dir> > renderer/boardparts.js
// <cad dir> holds the unpacked Arduino docs-content CAD zips and the
// Adafruit PCB repos (see SOURCES below). Positions are millimetres in the
// same frame as boards.js (`at`: origin bottom-left, top view).
const fs = require('fs'), path = require('path');
const DIR = process.argv[2];
const attr = (s) => { const o = {}; s.replace(/([\w-]+)="([^"]*)"/g, (_, k, v) => { o[k] = v; }); return o; };

// ---- Eagle .brd -------------------------------------------------------------------
function eagle(file) {
  const x = fs.readFileSync(path.join(DIR, file), 'utf8');
  const pk = {};
  const lsec = x.slice(x.indexOf('<libraries>'), x.indexOf('</libraries>'));
  for (const lm of lsec.matchAll(/<library name="([^"]*)"[^>]*>([\s\S]*?)<\/library>/g)) {
    for (const pm of lm[2].matchAll(/<package name="([^"]*)"[^>]*>([\s\S]*?)<\/package>/g)) {
      const g = { pads: [], body: { 21: [], 51: [] } };
      for (const m of pm[2].matchAll(/<(pad|smd) ([^>]*?)\/?>/g)) {
        const a = attr(m[2]);
        const r = m[1] === 'pad' ? (+a.diameter || +a.drill * 1.6 || 1.6) / 2 : 0;
        const dx = m[1] === 'smd' ? +a.dx / 2 : r, dy = m[1] === 'smd' ? +a.dy / 2 : r;
        const rot = /R(90|270)/.test(a.rot || '');
        g.pads.push({ n: a.name, x: +a.x, y: +a.y, hx: rot ? dy : dx, hy: rot ? dx : dy });
      }
      for (const m of pm[2].matchAll(/<wire ([^>]*?)\/?>/g)) { const a = attr(m[1]); if (g.body[a.layer]) g.body[a.layer].push([+a.x1, +a.y1], [+a.x2, +a.y2]); }
      for (const m of pm[2].matchAll(/<rectangle ([^>]*?)\/?>/g)) { const a = attr(m[1]); if (g.body[a.layer]) g.body[a.layer].push([+a.x1, +a.y1], [+a.x2, +a.y2]); }
      for (const m of pm[2].matchAll(/<circle ([^>]*?)\/?>/g)) { const a = attr(m[1]); if (g.body[a.layer]) { const r = +a.radius; g.body[a.layer].push([+a.x - r, +a.y - r], [+a.x + r, +a.y + r]); } }
      pk[lm[1] + '/' + pm[1]] = g;
    }
  }
  const nets = {};
  for (const sm of x.matchAll(/<signal name="([^"]*)"[^>]*>([\s\S]*?)<\/signal>/g)) {
    for (const c of sm[2].matchAll(/<contactref ([^>]*)\/>/g)) { const a = attr(c[1]); (nets[a.element] = nets[a.element] || new Set()).add(sm[1]); }
  }
  const out = [];
  for (const m of x.matchAll(/<element ([^>]*?)(\/>|>([\s\S]*?)<\/element>)/g)) {
    const e = attr(m[1]);
    const at = {}; for (const a of (m[3] || '').matchAll(/<attribute name="(\w+)" value="([^"]*)"/g)) at[a[1]] = a[2];
    const g = pk[e.library + '/' + e.package] || { pads: [], body: { 21: [], 51: [] } };
    const rot = e.rot || 'R0', mir = /M/.test(rot), ang = (+(rot.replace(/[^0-9.]/g, '')) || 0) * Math.PI / 180;
    const T = ([px, py]) => { const X = mir ? -px : px; return [+e.x + X * Math.cos(ang) - py * Math.sin(ang), +e.y + X * Math.sin(ang) + py * Math.cos(ang)]; };
    let pts = g.body[51].length ? g.body[51] : g.body[21];
    const padPts = g.pads.flatMap((p) => [[p.x - p.hx, p.y - p.hy], [p.x + p.hx, p.y + p.hy]]);
    if (!pts.length) pts = padPts; else pts = pts.concat(padPts);
    out.push({ ref: e.name, value: e.value || at.VALUE || '', pkg: e.package, case: at.CASE || '', pn: at.PART_NUMBER || '', maker: at.MANUFACTURER || '',
      side: mir ? 'bottom' : 'top', rot: Math.round(ang * 180 / Math.PI), pins: g.pads.length,
      box: pts.length ? bbox(pts.map(T)) : null, center: [+e.x, +e.y], nets: [...(nets[e.name] || [])] });
  }
  return out;
}
function bbox(pts) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map((v) => +v.toFixed(2));
}

// ---- Altium PcbDoc (via python olefile; positions minus the origin offset) ----------
function altium(file, bom, off) {
  const { execFileSync } = require('child_process');
  const py = `
import olefile,struct,json,sys
f=olefile.OleFileIO(sys.argv[1])
def recs(s):
    d=f.openstream(s).read();o=[];i=0
    while i+4<=len(d):
        n=struct.unpack_from('<I',d,i)[0];i+=4;o.append(d[i:i+n].decode('latin1'));i+=n
    return o
kv=lambda r:dict(p.split('=',1) for p in r.strip('\\x00').split('|') if '=' in p)
comps=[kv(r) for r in recs('Components6/Data')]
nets=[kv(r).get('NAME') for r in recs('Nets6/Data')]
d=f.openstream('Pads6/Data').read();i=0;pads=[]
while i<len(d):
    i+=1;n=struct.unpack_from('<I',d,i)[0];i+=4;s1=d[i:i+n];i+=n
    for k in range(3):
        n=struct.unpack_from('<I',d,i)[0];i+=4+n
    n=struct.unpack_from('<I',d,i)[0];i+=4;s5=d[i:i+n];i+=n
    net=struct.unpack_from('<H',s5,3)[0];comp=struct.unpack_from('<H',s5,7)[0];x,y=struct.unpack_from('<ii',s5,13);sx,sy=struct.unpack_from('<ii',s5,21)
    n=struct.unpack_from('<I',d,i)[0];i+=4+n
    pads.append([comp,nets[net] if net<len(nets) else None,x/10000*0.0254,y/10000*0.0254,sx/10000*0.0254,sy/10000*0.0254])
print(json.dumps({'comps':[{k:c.get(k) for k in ('SOURCEDESIGNATOR','PATTERN','X','Y','LAYER','ROTATION','SOURCEDESCRIPTION')} for c in comps],'pads':pads}))`;
  const j = JSON.parse(execFileSync('python3', ['-c', py, path.join(DIR, file)], { maxBuffer: 1 << 26 }).toString());
  const B = bomCsv(path.join(DIR, bom));
  return j.comps.map((c, idx) => {
    const ps = j.pads.filter((p) => p[0] === idx);
    const pts = ps.flatMap((p) => [[p[2] - p[4] / 2 - off, p[3] - p[5] / 2 - off], [p[2] + p[4] / 2 - off, p[3] + p[5] / 2 - off]]);
    const ref = c.SOURCEDESIGNATOR, b = B[ref] || {};
    return { ref, value: b.value || '', pkg: c.PATTERN, case: '', pn: b.pn || '', maker: b.maker || '', desc: b.desc || c.SOURCEDESCRIPTION || '',
      side: c.LAYER === 'BOTTOM' ? 'bottom' : 'top', rot: Math.round(parseFloat(c.ROTATION) || 0), pins: ps.length,
      box: pts.length ? bbox(pts) : null, center: [+(parseFloat(c.X) * 0.0254 - off).toFixed(3), +(parseFloat(c.Y) * 0.0254 - off).toFixed(3)],
      nets: [...new Set(ps.map((p) => p[1]).filter(Boolean))] };
  });
}
function csvRows(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { row.push(cur); cur = ''; } else if (ch === '\n' || ch === '\r') { if (cur || row.length) { row.push(cur); rows.push(row); row = []; cur = ''; } } else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
// Altium BOM: Quantity, Designator, Part Number, Manufacturer, Description
function bomCsv(file) {
  const rows = csvRows(fs.readFileSync(file, 'utf8')); const h = rows[0]; const o = {};
  const col = (n) => h.findIndex((x) => x.trim() === n);
  for (const r of rows.slice(1)) for (const d of (r[col('Designator')] || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const desc = r[col('Description')] || '';
    o[d] = { pn: r[col('Part Number')] || '', maker: r[col('Manufacturer')] || '', desc, value: valueFromDesc(desc) };
  }
  return o;
}
function valueFromDesc(d) {
  const m = /(?:^|\s)(\d+(?:[.,]\d+)?\s?(?:[pnuµm]F|[uµn]H|MHz|kHz)|\d+[kKMR]\d*|\d+(?:\.\d+)?\s?(?:Ω|ohm))(?=\s|$|,)/.exec(d);
  return m ? m[1].replace(',', '.').replace(/(\d)\s+(?=[a-zA-Z])/, '$1') : '';
}

// ---- Nano Every: Eagle BOM export + mount file (no nets in the docs) ------------------
function nanoEvery() {
  const base = 'ABX00028/NANOEveryV4.0_Documentation/NANOEveryV4.0';
  const rows = csvRows(fs.readFileSync(path.join(DIR, base + '.csv'), 'utf8')); const h = rows[0];
  const col = (n) => h.indexOf(n); const B = {};
  for (const r of rows.slice(1)) for (const d of r[col('Parts')].split(',').map((s) => s.trim())) B[d] = { value: r[col('Value')], pkg: r[col('Package')], desc: r[col('Description')], pn: r[col('MANUFACTURER-PN')] !== '-' ? r[col('MANUFACTURER-PN')] : '', maker: r[col('MANUFACTURER')] !== '-' ? r[col('MANUFACTURER')] : '' };
  const out = [];
  for (const line of fs.readFileSync(path.join(DIR, base + '.mnt'), 'utf8').split('\n')) {
    const m = /^(\S+)\s+([-\d.]+)\s+([-\d.]+)\s+(\d+)\s+(\S+)/.exec(line); if (!m) continue;
    const b = B[m[1]] || {}; const [w, h2] = sizeOf(b.pkg || m[5]); const r = +m[4] % 180 === 90;
    const hw = (r ? h2 : w) / 2, hh = (r ? w : h2) / 2;
    out.push({ ref: m[1], value: b.value || '', pkg: b.pkg || '', case: '', pn: b.pn || '', maker: b.maker || '', desc: b.desc || '', side: 'top', rot: +m[4], pins: 0,
      box: [+m[2] - hw, +m[3] - hh, +m[2] + hw, +m[3] + hh].map((v) => +v.toFixed(2)), center: [+m[2], +m[3]], nets: [] });
  }
  return out;
}
function sizeOf(p) {
  const s = String(p).toUpperCase();
  if (/0201/.test(s)) return [0.6, 0.3]; if (/0402|1005/.test(s)) return [1.0, 0.5]; if (/0603|1608/.test(s)) return [1.6, 0.8];
  if (/0805|2012/.test(s)) return [2.0, 1.25]; if (/1206|3216/.test(s)) return [3.2, 1.6];
  if (/^\d{4}-/.test(s) && /0402-1005/.test(s)) return [1.0, 0.5]; if (/0805-R2013/.test(s)) return [2.0, 1.25];
  if (/SOT-?23-?[56]|SOT23-[56]/.test(s)) return [2.9, 2.8]; if (/SOT-?23/.test(s)) return [2.9, 2.4]; if (/SOD-?123/.test(s)) return [2.7, 1.6];
  if (/QFN-?32|VQFN32|MLF32/.test(s)) return [5, 5]; if (/TQFP48/.test(s)) return [9, 9]; if (/HVQFN24/.test(s)) return [4, 4];
  if (/^MPM3610/.test(s)) return [3, 5]; if (/SOT363/.test(s)) return [2.1, 2]; if (/SOT25/.test(s)) return [2.9, 2.8];
  if (/SODFL3517/.test(s)) return [3.5, 1.7]; if (/SOT190P230/.test(s)) return [2.9, 2.4]; if (/ZX62/.test(s)) return [7.5, 5];
  if (/PTS820/.test(s)) return [4.2, 3.2]; if (/PMF42/.test(s)) return [4.2, 4.2]; if (/LEDC1608/.test(s)) return [1.6, 0.8]; if (/QFN-?48|VQFN48/.test(s)) return [7, 7]; if (/SSOP|TSSOP/.test(s)) return [5, 4.4];
  return [1.6, 1.6];
}

const SOURCES = {
  'uno/r3': () => eagle('A000066/A000066-cad-files/UNO-TH_Rev3e.brd'),
  'uno/r4minima': () => altium('ABX00080/ABX00080-cad-files/Altium files/PCB.PcbDoc', 'ABX00080/ABX00080-cad-files/Manufacturing files/BOM/Bill of Materials-UNO_R4_MINIMA(ABX00080).csv', 25.4),
  'uno/r4wifi': () => altium('ABX00087/ABX00087-cad-files/Altium files/PCB.PcbDoc', 'ABX00087/ABX00087-cad-files/Manufacturing files/BOM/Bill of Materials-UNO R4 WiFi(ABX00087).csv', 25.4),
  'mega/rev3': () => eagle('A000067/A000067-cad-files/MEGA2560_Rev3e.brd'),
  'leonardo/rev3': () => eagle('A000057/A000057-cad-files/Leonardo_Rev3d.brd'),
  'nano/v3': () => eagle('A000005/A00005-cad-files/NanoV3.3.brd'),
  'nanoevery/every': nanoEvery,
  'featheresp32/': () => eagle('Adafruit-HUZZAH32-ESP32-Feather-PCB/Adafruit HUZZAH32 ESP32 Feather.brd'),
  'featherrp2040/': () => eagle('Adafruit-Feather-RP2040-PCB/Adafruit Feather RP2040.brd'),
  'featherm0/basic': () => eagle('Adafruit-Feather-M0-Basic-Proto-PCB/Adafruit Feather M0 Basic rev C.brd'),
  'featherm0/express': () => eagle('Adafruit-Feather-M0-Express-PCB/Adafruit Feather M0 Express.brd'),
  'featherm4/': () => eagle('Adafruit-Feather-M4-Express-PCB/Adafruit Feather M4 Express.brd')
};
module.exports = { SOURCES, eagle, altium, nanoEvery };
if (require.main === module) setImmediate(() => {
  const all = {};
  for (const [k, f] of Object.entries(SOURCES)) all[k.replace(/\/$/, '')] = module.exports.finish(f(), k.replace(/\/$/, ''));
  const head = '// Every fitted component on the board drawings, from the makers\' design files\n' +
    '// (Arduino CAD: CC BY-SA 4.0; Adafruit PCB files: CC BY-SA). Generated by\n' +
    '// tools/extract-board-parts.js, do not edit by hand. Key: <board>/<revision>.\n' +
    '// box = [x1, y1, x2, y2] mm in the board\'s CAD frame (as boards.js `at`).\n';
  const SRC = { 'uno/r3': 'Arduino UNO R3 CAD (UNO-TH_Rev3e.brd, A000066)', 'uno/r4minima': 'Arduino UNO R4 Minima CAD (Altium PCB + BOM, ABX00080)',
    'uno/r4wifi': 'Arduino UNO R4 WiFi CAD (Altium PCB + BOM, ABX00087)', 'mega/rev3': 'Arduino Mega 2560 CAD (MEGA2560_Rev3e.brd, A000067)',
    'leonardo/rev3': 'Arduino Leonardo CAD (Leonardo_Rev3d.brd, A000057)', 'nano/v3': 'Arduino Nano CAD (NanoV3.3.brd, A000005)',
    'nanoevery/every': 'Arduino Nano Every CAD (NANOEveryV4.0 BOM + placement, ABX00028)', featheresp32: 'Adafruit HUZZAH32 ESP32 Feather PCB (Eagle)',
    featherrp2040: 'Adafruit Feather RP2040 PCB (Eagle)', 'featherm0/basic': 'Adafruit Feather M0 Basic rev C PCB (Eagle)',
    'featherm0/express': 'Adafruit Feather M0 Express PCB (Eagle)', featherm4: 'Adafruit Feather M4 Express PCB (Eagle)' };
  process.stdout.write(head + 'window.PINODE_BOARD_PARTS_SOURCE = ' + JSON.stringify(SRC) + ';\n' + 'window.PINODE_BOARD_PARTS = ' + JSON.stringify(all).replace(/\],"/g, '],\n"').replace(/\},\{/g, '},\n{') + ';\n');
});

// ---- clean-up: what is actually fitted, its real part number, kind, role, marking ----
const SKIP = /^(TP|TP_|GND_TP|ORIGIN|FRAME|FD\d|FID|Fiducial|LOVE$|MD$|VIN_TOP|BUCK_IN|SWDIO|SWCLK|VCC1$|GND\d$|VBUS_CONN|D[+-]1?$|1$)/;
function fitted(c, board) {
  if (/^(DNP|NM)$|- ?NM$|^\d+x\d+ ?M - NM$/i.test(c.value) || /^DNP$/i.test(c.pn) || /^DNP$/i.test(c.desc)) return false;
  if (/TEST ?POINT|TP-|TP_SP|FIDUC|MOUNTINGHOLE|FRAME|LOGO|PCBFEAT|ADAFRUIT_|RP2040_(TOP|BOT)|FEATHERM4_|HUZZAH32$|B1,27/i.test(c.pkg)) return false;
  if (board !== 'uno/r4wifi' && board !== 'uno/r4minima' && SKIP.test(c.ref)) return false;
  if ((board === 'uno/r4wifi' || board === 'uno/r4minima') && /^(LOVE|MD|VIN_TOP1|BUCK_IN_TOP1|SWDIO1|SWCLK1|VCC1|GND\d|VBUS_CONN|D[+-]|Fiducial_\d)$/.test(c.ref)) return false;
  if (board === 'uno/r4minima' && c.ref === '1') return false;
  if (!c.box && !c.pins) return false;
  if (/^U\$/.test(c.ref) && (!c.pins || /DNP|MOUNTING/i.test(c.value))) return false;
  // the Leonardo PCB has a QFN-44 (U1) inside a TQFP-44 footprint (U2) for the
  // alternate package; Arduino's photo and render both show the QFN fitted
  if (board === 'leonardo/rev3' && c.ref === 'U2') return false;
  return true;
}
const unesc = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();
const looksMpn = (s) => !/\d\s?[kM]?Hz/i.test(s) && /[A-Z]/i.test(s) && /\d/.test(s) && s.length >= 5 && !/^\d+(\.\d+)?\s?[pnuµ]?F$/i.test(s) && !/_0603$|^0603_|^\d+[pnu]F_/i.test(s) && !/^P0\d{8}/.test(s);
function cleanMpn(c) {
  let pn = unesc(c.pn);
  const alts = pn.split(/_\/_|\s*\/\s*(?=[A-Z]{2})/).map((s) => s.replace(/^\d{3}R_[^_]+_?$/, '').replace(/^[\dA-Z]+_[\dA-Z]+_/, '').trim()).filter(Boolean);
  if (/^1uF_0603\//.test(pn)) pn = pn.split('/')[1];
  else if (/_\/_/.test(pn)) pn = pn.split('_/_').map((s) => s.trim()).filter((s) => !/^\d{3}R_/.test(s)).join(' or ');
  if (/^TEX/.test(pn)) pn = pn.slice(3);
  if (/^cl10b104kbnc$/.test(pn)) pn = 'CL10B104KBNC';
  if (pn && !looksMpn(pn.split(' or ')[0])) pn = '';
  void alts;
  // Eagle files without a part-number attribute: the value is the part when it looks like one
  const v = unesc(c.value);
  const vs = v.replace(/ \d+mA$| KX-7$| 16MHZ$/i, '');
  if (!pn && looksMpn(vs) && !/\s/.test(vs) && !/^(POWERSUPPLY|USB|\d+x\d|FH254|XXXX|TS42|KMR2|SPST|JSTPH|ESP32_WROOM32_SKINNY|RP2040_QFN56|ATSAMD21G18_QFN|STEMMA|CG0603MLC-05E$|BLM21$)/i.test(v)) pn = v.replace(/ \d+mA$/, '').replace(/ KX-7$/, '').replace(/ 16MHZ$/i, '');
  if (c.ref === 'IC3' && v === '328P-MUR') pn = 'ATMEGA328P-MUR';
  pn = pn.replace(/^ATMEGA32U4-XU(MU|AU)$/, 'ATMEGA32U4-$1');
  // Adafruit library names for the main chips
  const AF = { RP2040_QFN56: 'RP2040', ATSAMD21G18_QFN: 'ATSAMD21G18', ATSAMD51J: 'ATSAMD51J', ESP32_WROOM32_SKINNY: 'ESP32-WROOM-32' };
  if (!pn && AF[v]) pn = AF[v];
  return pn.replace(/\s+$/, '');
}
function kindOf(c) {
  const r = c.ref, p = (c.pkg + ' ' + c.desc + ' ' + c.value).toUpperCase();
  if (/^\d+$/.test(r)) return 'led';
  if (/WS2812|SK6812|LED3535|LED5050/.test(p)) return 'rgb';
  if (/LED|^ON$|^L$|^RX$|^TX$|^PWR$|^CHG$|^DL\d|^D3$/.test(r) && /LED/.test(p)) return 'led';
  if (/^(RN|RP)\d|RESPACK|CAY16/.test(r + ' ' + p)) return 'rarray';
  if (/^R\d/.test(r)) return 'res';
  if (/^PC\d|SMC_B|TAN-|PANASONIC/.test(r + ' ' + p)) return 'ecap';
  if (/^C\d/.test(r)) return 'cap';
  if (/^(L|FB)\d/.test(r)) return /FERRITE|BLM|MH2029|470R/.test(p) ? 'ferrite' : 'ind';
  if (/^F\d/.test(r)) return 'fuse';
  if (/^Z\d/.test(r)) return 'tvs';
  if (/^Y\d|^X2$/.test(r) && /MHZ|RESONATOR|CRYSTAL|XTAL|32\.768/.test(p)) return 'xtal';
  if (/^(D|Z)\d/.test(r)) return /PRTR|TVS/.test(p) ? 'tvs' : 'diode';
  if (/^(Q|T)\d/.test(r)) return 'fet';
  if (/^(SW|PB)\d|^RESET$/.test(r)) return 'button';
  if (/SJ|SOLDERJUMPER/.test(c.pkg) || /^(GROUND|RESET-EN|SJ\d)$/.test(r)) return 'jumper';
  if (/WROOM|ESP32-S3-MINI/.test(p)) return 'module';
  if (/USB|PN61729|20329|CX90B|ZX62|CUSB31/.test(p)) return 'usb';
  if (/POWERSUPPLY|PWR JACK/.test(p)) return 'jack';
  if (/^(J|JP|X|ICSP|IOL|IOH|AD|POWER|PWML|ADCL|ADCH|COMMUNICATION|XIO|CONN|EXTPOWER|JDIGITAL|JANALOG|JOFF)\d*$/.test(r)) return 'conn';
  if (/^LED\d/.test(r)) return 'rgb';
  if (/^M\d|WROOM|ESP32/.test(r + ' ' + p)) return 'module';
  return 'ic';
}
const MCU = /ATMEGA328P|ATMEGA2560|ATMEGA32U4|ATMEGA4809|R7FA4M1|ATSAMD21G18|ATSAMD51|RP2040/i;
function roleOf(c, all) {
  const v = (c.mpn + ' ' + c.value + ' ' + c.desc).toUpperCase(), n = c.nets;
  const peer = (re) => all.find((o) => o !== c && re.test(o.mpn + ' ' + o.value) && o.nets.some((x) => n.includes(x) && !/GND/.test(x)));
  switch (c.kind) {
    case 'ic': case 'module':
      if (MCU.test(v)) return 'Main microcontroller: runs your sketch';
      if (/ESP32-S3/.test(v)) return 'Wi-Fi and Bluetooth module (ESP32-S3); also the USB bridge for the RA4M1';
      if (/WROOM|ESP32/.test(v)) return 'Main microcontroller with Wi-Fi and Bluetooth: runs your sketch';
      if (/16U2|FT232|CP210|SAMD11|CH340/.test(v)) return 'USB-to-serial bridge: the serial port your computer sees, used for uploads and Serial';
      if (/MCP73831/.test(v)) return 'LiPo battery charger (charges from USB, CHG LED shows it)';
      if (/LMV358/.test(v)) return 'Dual op-amp: switches USB power off when VIN is above about 6.6 V, and buffers pin 13 to the L LED';
      if (/ISL854102|MPM3610/.test(v)) return 'Buck converter: steps VIN down to 5 V';
      if (/1117|LD1117/.test(v)) return '5 V linear regulator: makes 5 V from VIN / the barrel jack';
      if (/2985|AP2112|SPX3819|RT9080|SGM2205/.test(v)) return '3.3 V regulator: makes the 3V3 pin supply';
      if (/TXB0108/.test(v)) return 'Level shifter between the 5 V RA4M1 and the 3.3 V ESP32-S3';
      if (/NLASB3157/.test(v)) return 'Analog switch: routes the USB-C data lines to the RA4M1 or the ESP32-S3';
      if (/W25Q|FLASH|GD25|SOIC8|USON8/.test(v + c.pkg.toUpperCase())) return 'SPI flash memory (program storage / CircuitPython drive)';
      return 'Integrated circuit';
    case 'led': return 'LED';
    case 'rgb': return 'NeoPixel (addressable RGB LED)';
    case 'xtal': { const f = /(\d+(?:\.\d+)?)\s?MHZ|32\.768/i.exec(c.value + ' ' + c.desc) || ((m) => m && [m[0], m[1]])(/CSTCE(\d+)M/.exec(c.mpn)); const ic = peer(MCU) || peer(/16U2|SAMD11|FT232|CP210/i) || all.find((o) => MCU.test(o.mpn));
      return (f ? (f[1] ? +f[1] + ' MHz' : '32.768 kHz') : '') + ' clock' + (ic ? ' for the ' + shortName(ic) : ''); }
    case 'cap': case 'ecap': {
      const rail = n.find((x) => !/GND/.test(x));
      if (n.includes('DTR') || /RESET/.test(n.join()) && n.some((x) => /DTR/.test(x))) return 'Auto-reset capacitor: the DTR pulse resets the chip when an upload starts';
      const xt = all.find((o) => o.kind === 'xtal' && o.nets.some((x) => n.includes(x) && !/GND/.test(x)));
      if (xt && parseCap(c.value) < 1e-9) return 'Load capacitor for the ' + xt.ref + ' crystal';
      if (/GND/.test(n.join()) && rail) return (parseCap(c.value) >= 4.7e-6 || c.kind === 'ecap' ? 'Bulk capacitor on ' : 'Decoupling capacitor on ') + rail;
      return n.length === 2 ? 'Capacitor between ' + n.join(' and ') : n.length === 1 ? 'Capacitor on ' + n[0] : 'Capacitor';
    }
    case 'res': {
      if (/^0R/.test(c.value)) return 'Zero-ohm link' + (n.length ? ' on ' + n.join(' / ') : '');
      const led = all.find((o) => o.kind === 'led' && o.nets.some((x) => n.includes(x) && !/GND|\+/.test(x)));
      if (led) return 'Current-limiting resistor for the ' + led.ref + ' LED';
      if (n.some((x) => /^CC\d/.test(x))) return 'USB-C CC pull-down: tells the charger this is a 5 V device';
      return n.length === 2 ? 'Resistor between ' + n.join(' and ') : n.length === 1 ? 'Resistor on ' + n[0] : 'Resistor';
    }
    case 'rarray': return 'Resistor array (4 resistors)' + (/22R/i.test(c.value) ? ': series resistors on the USB data lines' : '');
    case 'ferrite': return 'Ferrite bead: filters noise on ' + (n.filter((x) => !/^N\$/.test(x)).join(' / ') || 'the supply');
    case 'ind': return 'Inductor' + (/BUCK|SW/.test(n.join()) || all.some((o) => /ISL854102|MPM3610/.test(o.mpn)) ? ' for the buck converter' : '');
    case 'fuse': return 'Resettable fuse (500 mA): protects your computer\'s USB port';
    case 'tvs': return 'ESD protection on the USB lines';
    case 'diode': return /M7|SMB/.test(v + c.pkg) ? 'Reverse-polarity protection for the barrel jack' : 'Diode in the power path (stops back-feeding between USB, VIN and battery)';
    case 'fet': return /FDN340|PMV48|DMG341/.test(v) ? 'P-MOSFET power switch: disconnects USB 5 V when another supply is present' : /2222/.test(v) ? 'Transistor: auto-reset / boot circuit for uploads' : 'N-MOSFET switch / level shifter';
    case 'button': return /TS42|RESET|KMR2|PTS820|1571636|IT-1/i.test(v + c.pkg + c.ref) && !/^SW3$/.test(c.ref) ? 'Reset button' : 'Boot / user button';
    case 'jumper': return 'Solder jumper';
    case 'usb': return 'USB connector';
    case 'jack': return 'DC barrel jack (2.1 mm, centre positive)';
    case 'conn': return /ICSP/.test(c.ref) || c.pins === 6 && /2X03/.test(c.pkg) ? 'ICSP header: program the chip directly' : /JST|JSTPH/.test(c.pkg + c.value) ? 'LiPo battery connector (JST PH)' : /SRSS|SH4|STEMMA/.test(c.pkg + c.mpn) ? 'Qwiic / STEMMA QT I²C connector' : /1\.27|SWD/.test(c.pkg + c.value) ? 'SWD debug header' : 'Header';
  }
  return '';
}
function shortName(o) { const m = MCU.exec(o.mpn + ' ' + o.value); return m ? m[0].replace(/R7FA4M1/, 'RA4M1').toUpperCase().replace('ATSAMD', 'SAMD') : (o.mpn || o.value).replace(/-.*/, ''); }
function parseCap(v) {
  const m = /^(\d+)(?:[.,](\d+))?\s?([pnuµ])?(\d*)F?/i.exec(String(v).replace(',', '.')); if (!m) return 0;
  const mul = { p: 1e-12, n: 1e-9, u: 1e-6, µ: 1e-6 }[(m[3] || 'u').toLowerCase()] || 1e-6;
  return parseFloat(m[1] + '.' + (m[2] || m[4] || '0')) * mul;
}
function normValue(c) {
  let v = unesc(c.value).replace(/\\$/, '');
  if (!v || /^(\d+x\d|FH254|POWERSUPPLY|XXXX|USB|-|TS42|KMR2|ICSP|STEMMA|Mini RA|SPST|JSTPH|TP)/i.test(v) || v === c.mpn) v = '';
  if (v && c.mpn && v.startsWith(c.mpn + ' ')) v = v.slice(c.mpn.length + 1);
  if (/^[A-Z]{2,}-?\w*\d\w*-\w+ (\d)/.test(v)) v = v.replace(/^\S+ /, '');
  if (!v && c.desc) v = valueFromDesc(c.desc);
  return v.replace(/µ/g, 'u').replace(/^(\d+),(\d+)uF_(\d+V)$/, '$1.$2uF $3');
}
// Factory markings: only what the maker's files say is printed, never a guess.
// Chip parts below 1206 carry no print. A chip carries its part name; the
// date/lot line is per batch, so it is shown as a placeholder.
function markingOf(c) {
  const big = c.box && (c.box[2] - c.box[0]) * (c.box[3] - c.box[1]) >= 16;
  if (c.kind === 'ecap' && /PANASONIC/.test(c.pkg)) { const m = /([\d.,]+)\s?u/i.exec(c.value); const volt = /(\d+)\s?V\b/.exec(c.value + ' ' + c.desc); return m ? [m[1].replace(',', '.') + (volt ? ' ' + volt[1] + 'V' : '')] : null; }
  if (c.kind === 'xtal') { const f = /(\d+(?:\.\d+)?)\s?MHz/i.exec(c.value + ' ' + c.desc); return f && big ? [(+f[1]).toFixed(3).replace(/\.?0+$/, (s) => s.length > 2 ? '.000'.slice(0, 4) : s)] : null; }
  if (c.kind === 'diode' && /^M[1-7]$/.test(c.raw)) return [c.raw];
  // the RP2040's top print is the die code, not the name (B2 = current stepping)
  if (/^RP2040$/.test(c.mpn)) return ['RP2-B2'];
  if ((c.kind === 'ic' || c.kind === 'module') && big && c.mpn) return [c.mpn.split(' or ')[0].replace(/#.*$|\(R\)$|\/TR$/, '')];
  return null;
}
const NOTES = {
  'leonardo/rev3:U1': 'The PCB also has a TQFP-44 footprint (U2) around this chip for the other package; Arduino\'s photo and render show the QFN version fitted.',
  'mega/rev3:IC3': 'The design file\'s value says ATMEGA2560-15AU but its part-number field says ATMEGA2560-16AU, the 16 MHz grade the board runs at.',
  'mega/rev3:Y2': 'Arduino lists this crystal by an internal code (P011052006); only the 16 MHz frequency is given.',
  'nano/v3:IC3': 'The design file names it 328P-MUR: the ATmega328P in the 32-pin VQFN package.',
  'featherm0/express:U1': 'Adafruit\'s file only says "2MB Flash"; the maker of the SPI flash varies between batches.',
  'featherrp2040:IC1': 'The RP2040 is printed RP2-B2 (the silicon stepping); early boards read RP2-B0 or RP2-B1.',
  'featheresp32:X2': 'Adafruit\'s file names the WROOM-32 footprint; later HUZZAH32 batches use the ESP32-WROOM-32E, which has the same pins.',
  'featherm4:U1': 'Adafruit\'s file only says "2MB Flash"; the maker of the QSPI flash varies between batches.'
};
function finish(list, board) {
  const out = list.filter((c) => fitted(c, board)).map((c) => {
    const d = { ...c, raw: unesc(c.value), value: '', mpn: cleanMpn(c), maker: unesc(c.maker), desc: unesc(c.desc) };
    d.kind = kindOf({ ...c, value: unesc(c.value) });
    // a body thinner than its package (pads only at the ends): use the package size
    if (d.box && sizeOf(c.pkg)[0] > 1.6 && Math.min(d.box[2] - d.box[0], d.box[3] - d.box[1]) < 0.8) {
      const [w, h] = sizeOf(c.pkg), cx = (d.box[0] + d.box[2]) / 2, cy = (d.box[1] + d.box[3]) / 2;
      d.box = [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2].map((v) => +v.toFixed(2));
    }
    d.value = /^(res|rarray|cap|ecap|ind|ferrite|xtal|led|fuse)$/.test(d.kind) ? normValue({ ...c, mpn: d.mpn }) : '';
    d.nets = [...new Set(c.nets.filter((x) => !/^(N\$|N_)\d|^Net|^\$/.test(x)).map((x) => x.replace(/\\/g, '').replace(/_1$/, '')))].sort();
    return d;
  });
  for (const d of out) { d.role = roleOf(d, out); d.mark = markingOf(d); }
  return out.map((d) => {
    const o = { ref: d.ref, kind: d.kind, box: d.box, side: d.side, rot: d.rot };
    for (const k of ['value', 'mpn', 'maker', 'desc', 'pkg', 'role']) if (d[k]) o[k] = d[k];
    if (d.mark) o.mark = d.mark;
    if (d.nets.length) o.nets = d.nets;
    if (d.pins) o.pins = d.pins;
    if (NOTES[board + ':' + d.ref]) o.note = NOTES[board + ':' + d.ref];
    return o;
  });
}
module.exports.finish = finish;
