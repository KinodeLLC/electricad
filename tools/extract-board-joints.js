// Builds renderer/boardjoints.js: every pad (solder joint) on each board, with
// the part and pad it belongs to and the net it is wired to, straight from the
// makers' design files (run by hand like extract-board-parts.js; the CAD files
// are not shipped). Usage:
//   node tools/extract-board-joints.js <cad dir> > renderer/boardjoints.js
// Each board: { nets: [name], p: [[x, y, hx, hy, ref, pad, net, kind]] } in mm,
// the same frame as boards.js `at`. kind: 0 through-hole (a joint on both
// faces), 1 SMD on the top, 2 SMD on the bottom. Pads with no net are left out.
// The Nano Every publishes no copper (only a BOM and placement), so it has none.
const fs = require('fs'), path = require('path');
const DIR = process.argv[2];
const attr = (s) => { const o = {}; s.replace(/([\w-]+)="([^"]*)"/g, (_, k, v) => { o[k] = v; }); return o; };
const r2 = (v) => +v.toFixed(2);

function eagle(file) {
  const x = fs.readFileSync(path.join(DIR, file), 'utf8');
  const pk = {};
  const lsec = x.slice(x.indexOf('<libraries>'), x.indexOf('</libraries>'));
  for (const lm of lsec.matchAll(/<library name="([^"]*)"[^>]*>([\s\S]*?)<\/library>/g)) {
    for (const pm of lm[2].matchAll(/<package name="([^"]*)"[^>]*>([\s\S]*?)<\/package>/g)) {
      const pads = [];
      for (const m of pm[2].matchAll(/<(pad|smd) ([^>]*?)\/?>/g)) {
        const a = attr(m[2]);
        const th = m[1] === 'pad';
        const r = th ? (+a.diameter || +a.drill * 1.6 || 1.6) / 2 : 0;
        const rot = /R(90|270)/.test(a.rot || '');
        const dx = th ? r : +a.dx / 2, dy = th ? r : +a.dy / 2;
        pads.push({ n: a.name, x: +a.x, y: +a.y, hx: rot ? dy : dx, hy: rot ? dx : dy, th, layer: +a.layer || 1 });
      }
      pk[lm[1] + '/' + pm[1]] = pads;
    }
  }
  const net = {};   // element|pad -> net
  for (const sm of x.matchAll(/<signal name="([^"]*)"[^>]*>([\s\S]*?)<\/signal>/g)) {
    for (const c of sm[2].matchAll(/<contactref ([^>]*)\/>/g)) { const a = attr(c[1]); net[a.element + '|' + a.pad] = sm[1]; }
  }
  const out = [];
  for (const m of x.matchAll(/<element ([^>]*?)(\/>|>)/g)) {
    const e = attr(m[1]);
    const pads = pk[e.library + '/' + e.package] || [];
    const rot = e.rot || 'R0', mir = /M/.test(rot), deg = +(rot.replace(/[^0-9.]/g, '')) || 0, ang = deg * Math.PI / 180;
    const quarter = Math.round(deg / 90) % 2 === 1;
    for (const p of pads) {
      const n = net[e.name + '|' + p.n];
      if (!n) continue;
      const X = mir ? -p.x : p.x;
      const x0 = +e.x + X * Math.cos(ang) - p.y * Math.sin(ang), y0 = +e.y + X * Math.sin(ang) + p.y * Math.cos(ang);
      // an SMD pad sits on its layer; a mirrored part puts it on the other face
      const kind = p.th ? 0 : ((p.layer === 16) !== mir ? 2 : 1);
      out.push([r2(x0), r2(y0), r2(quarter ? p.hy : p.hx), r2(quarter ? p.hx : p.hy), e.name, p.n, n, kind]);
    }
  }
  return out;
}

function altium(file, off) {
  const { execFileSync } = require('child_process');
  // Pads6 record: name, 3 skipped blocks, the geometry block, one more block.
  // Geometry: byte 0 layer (1 top, 32 bottom, 74 multi-layer = through-hole).
  const py = `
import olefile,struct,json,sys
f=olefile.OleFileIO(sys.argv[1])
def recs(s):
    d=f.openstream(s).read();o=[];i=0
    while i+4<=len(d):
        n=struct.unpack_from('<I',d,i)[0];i+=4;o.append(d[i:i+n].decode('latin1'));i+=n
    return o
kv=lambda r:dict(p.split('=',1) for p in r.strip('\\x00').split('|') if '=' in p)
comps=[kv(r).get('SOURCEDESIGNATOR') for r in recs('Components6/Data')]
nets=[kv(r).get('NAME') for r in recs('Nets6/Data')]
d=f.openstream('Pads6/Data').read();i=0;pads=[]
while i<len(d):
    i+=1;n=struct.unpack_from('<I',d,i)[0];i+=4;s1=d[i:i+n];i+=n
    for k in range(3):
        n=struct.unpack_from('<I',d,i)[0];i+=4+n
    n=struct.unpack_from('<I',d,i)[0];i+=4;s5=d[i:i+n];i+=n
    layer=s5[0];net=struct.unpack_from('<H',s5,3)[0];comp=struct.unpack_from('<H',s5,7)[0];x,y=struct.unpack_from('<ii',s5,13);sx,sy=struct.unpack_from('<ii',s5,21)
    n=struct.unpack_from('<I',d,i)[0];i+=4+n
    name=s1[1:1+s1[0]].decode('latin1') if len(s1) else ''
    pads.append([comps[comp] if comp<len(comps) else None,name,nets[net] if net<len(nets) else None,layer,x/10000*0.0254,y/10000*0.0254,sx/10000*0.0254,sy/10000*0.0254])
print(json.dumps(pads))`;
  const pads = JSON.parse(execFileSync('python3', ['-c', py, path.join(DIR, file)], { maxBuffer: 1 << 26 }).toString());
  return pads.filter((p) => p[0] && p[2]).map(([ref, pad, n, layer, x, y, sx, sy]) =>
    [r2(x - off), r2(y - off), r2(sx / 2), r2(sy / 2), ref, pad, n, layer === 74 ? 0 : layer === 32 ? 2 : 1]);
}

const P = require('./extract-board-parts.js').SOURCES;
void P;
const SOURCES = {
  'uno/r3': () => eagle('A000066/A000066-cad-files/UNO-TH_Rev3e.brd'),
  'uno/r4minima': () => altium('ABX00080/ABX00080-cad-files/Altium files/PCB.PcbDoc', 25.4),
  'uno/r4wifi': () => altium('ABX00087/ABX00087-cad-files/Altium files/PCB.PcbDoc', 25.4),
  'mega/rev3': () => eagle('A000067/A000067-cad-files/MEGA2560_Rev3e.brd'),
  'leonardo/rev3': () => eagle('A000057/A000057-cad-files/Leonardo_Rev3d.brd'),
  'nano/v3': () => eagle('A000005/A00005-cad-files/NanoV3.3.brd'),
  featheresp32: () => eagle('Adafruit-HUZZAH32-ESP32-Feather-PCB/Adafruit HUZZAH32 ESP32 Feather.brd'),
  featherrp2040: () => eagle('Adafruit-Feather-RP2040-PCB/Adafruit Feather RP2040.brd'),
  'featherm0/basic': () => eagle('Adafruit-Feather-M0-Basic-Proto-PCB/Adafruit Feather M0 Basic rev C.brd'),
  'featherm0/express': () => eagle('Adafruit-Feather-M0-Express-PCB/Adafruit Feather M0 Express.brd'),
  featherm4: () => eagle('Adafruit-Feather-M4-Express-PCB/Adafruit Feather M4 Express.brd')
};
module.exports = { SOURCES, eagle, altium };
if (require.main === module) {
  const all = {};
  for (const [k, f] of Object.entries(SOURCES)) {
    let rows = f();
    // a test-point pad drawn on top of a through-hole joint of the same net
    // (Arduino puts TP_* on every header pin) is the same copper: keep the joint
    const th = rows.filter((r) => r[7] === 0);
    rows = rows.filter((r) => r[7] === 0 || !th.some((t) => t[6] === r[6] && Math.abs(t[0] - r[0]) <= t[2] && Math.abs(t[1] - r[1]) <= t[3]));
    const nets = [...new Set(rows.map((r) => r[6]))].sort();
    const ix = new Map(nets.map((n, i) => [n, i]));
    all[k] = { nets, p: rows.map((r) => { r[6] = ix.get(r[6]); return r; }) };
  }
  process.stdout.write('// Every solder joint (pad) on the board drawings with its part, pad and net,\n' +
    '// from the makers\' design files (Arduino CAD: CC BY-SA 4.0; Adafruit PCB files:\n' +
    '// CC BY-SA). Generated by tools/extract-board-joints.js, do not edit by hand.\n' +
    '// p: [x, y, half-width, half-height, part, pad, net index, 0 through-hole | 1 top | 2 bottom]\n' +
    'window.PINODE_BOARD_JOINTS = ' + JSON.stringify(all).replace(/\],\[/g, '],\n[') + ';\n');
}
