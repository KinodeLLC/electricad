// Builds renderer/boardsilk.js: the silkscreen of each Eagle-drawn board
// (logos, labels, part outlines, "MADE IN ITALY"...) straight from the maker's
// .brd, in the same CAD mm frame as boards.js. Run by hand like
// extract-board-parts.js:
//   node tools/extract-board-silk.js <cad dir> > renderer/boardsilk.js
// Top silk = layers 21 (tPlace) + 25 (tNames); bottom = 22 + 26.
const fs = require('fs'), path = require('path');
const DIR = process.argv[2];
const attr = (s) => { const o = {}; s.replace(/([\w-]+)="([^"]*)"/g, (_, k, v) => { o[k] = v; }); return o; };
// 200/201: Adafruit's bitmap silk (logos and pin labels as pixel rectangles)
const TOP = { 21: 1, 25: 1, 200: 1 }, BOT = { 22: 1, 26: 1, 201: 1 };
const BMP = { 200: 1, 201: 1 };
const r2 = (v) => +(+v).toFixed(2);
const r3 = (v) => +(+v).toFixed(3);
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// an arc from (x1,y1) to (x2,y2) turning `curve` degrees (Eagle: CCW positive)
function arcPts(x1, y1, x2, y2, curve) {
  const a = (curve * Math.PI) / 180;
  const dx = x2 - x1, dy = y2 - y1, d = Math.hypot(dx, dy);
  if (!d || !a) return [[x1, y1], [x2, y2]];
  const r = d / (2 * Math.sin(a / 2));
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const h = Math.sqrt(Math.max(0, r * r - (d / 2) * (d / 2))) * Math.sign(a) * (Math.abs(a) > Math.PI ? -1 : 1);
  const cx = mx - (dy / d) * h, cy = my + (dx / d) * h;
  const s = Math.atan2(y1 - cy, x1 - cx), n = Math.max(4, Math.ceil(Math.abs(a) / (Math.PI / 18)));
  const R = Math.abs(r), out = [];
  for (let i = 0; i <= n; i++) { const t = s + (a * i) / n; out.push([cx + R * Math.cos(t), cy + R * Math.sin(t)]); }
  return out;
}
function rotFn(rot) {
  const mir = /M/.test(rot || ''), ang = ((+String(rot || 'R0').replace(/[^0-9.]/g, '')) || 0) * Math.PI / 180;
  return { mir, deg: ((+String(rot || 'R0').replace(/[^0-9.]/g, '')) || 0), f: (x, y) => { const X = mir ? -x : x; return [X * Math.cos(ang) - y * Math.sin(ang), X * Math.sin(ang) + y * Math.cos(ang)]; } };
}

function silk(file) {
  const x = fs.readFileSync(path.join(DIR, file), 'utf8');
  const out = { top: { s: {}, f: [], t: [], bmp: [] }, bottom: { s: {}, f: [], t: [], bmp: [] } };
  const side = (layer, mirrored) => {
    // Eagle swaps 21/22 and 25/26 when a part is mirrored, but not the
    // bitmap layers: Adafruit keeps 200 for the top and 201 for the bottom
    if (BMP[layer]) return TOP[layer] ? 'top' : 'bottom';
    if (TOP[layer]) return mirrored ? 'bottom' : 'top';
    if (BOT[layer]) return mirrored ? 'top' : 'bottom';
    return null;
  };
  const stroke = (sd, w, pts) => {
    const k = (Math.max(0.1, +w || 0.15)).toFixed(3);
    (out[sd].s[k] = out[sd].s[k] || []).push('M' + pts.map((p) => r3(p[0]) + ' ' + r3(p[1])).join('L'));
  };
  // shapes of one container (package body or the board's <plain>), placed by T
  function shapes(body, T, mirrored) {
    for (const m of body.matchAll(/<wire ([^>]*?)\/>/g)) {
      const a = attr(m[1]); const sd = side(a.layer, mirrored); if (!sd) continue;
      const pts = arcPts(+a.x1, +a.y1, +a.x2, +a.y2, +a.curve || 0).map(([px, py]) => T(px, py));
      stroke(sd, a.width, pts);
    }
    for (const m of body.matchAll(/<circle ([^>]*?)\/>/g)) {
      const a = attr(m[1]); const sd = side(a.layer, mirrored); if (!sd) continue;
      const r = +a.radius, pts = [];
      for (let i = 0; i <= 36; i++) pts.push(T(+a.x + r * Math.cos(i * Math.PI / 18), +a.y + r * Math.sin(i * Math.PI / 18)));
      if (+a.width === 0) out[sd].f.push('M' + pts.map((p) => r3(p[0]) + ' ' + r3(p[1])).join('L') + 'Z');
      else stroke(sd, a.width, pts);
    }
    for (const m of body.matchAll(/<rectangle ([^>]*?)\/>/g)) {
      const a = attr(m[1]); const sd = side(a.layer, mirrored); if (!sd) continue;
      // filled rectangles (bitmap logos and labels, layer 200/201 or 21) go into one picture
      const R0 = rotFn(a.rot);
      if (BMP[a.layer] || R0.deg % 90 === 0) { const p1 = T(+a.x1, +a.y1), p2 = T(+a.x2, +a.y2); if (R0.deg % 180 === 0) { out[sd].bmp.push([p1[0], p1[1], p2[0], p2[1]]); continue; } }
      const cx = (+a.x1 + +a.x2) / 2, cy = (+a.y1 + +a.y2) / 2, R = rotFn(a.rot);
      const c = [[+a.x1, +a.y1], [+a.x2, +a.y1], [+a.x2, +a.y2], [+a.x1, +a.y2]].map(([px, py]) => { const [qx, qy] = R.f(px - cx, py - cy); return T(cx + qx, cy + qy); });
      // axis-aligned (nearly all of them): a short relative path
      const xs = c.map((p) => p[0]), ys = c.map((p) => p[1]);
      const ax = new Set(xs.map(r2)).size === 2 && new Set(ys.map(r2)).size === 2;
      if (ax) { const x0 = Math.min(...xs), y0 = Math.min(...ys); out[sd].f.push('M' + r2(x0) + ' ' + r2(y0) + 'h' + r2(Math.max(...xs) - x0) + 'v' + r2(Math.max(...ys) - y0) + 'h' + r2(x0 - Math.max(...xs)) + 'z'); }
      else out[sd].f.push('M' + c.map((p) => r3(p[0]) + ' ' + r3(p[1])).join('L') + 'Z');
    }
    for (const m of body.matchAll(/<polygon ([^>]*)>([\s\S]*?)<\/polygon>/g)) {
      const a = attr(m[1]); const sd = side(a.layer, mirrored); if (!sd) continue;
      const vs = [...m[2].matchAll(/<vertex ([^>]*?)\/>/g)].map((v) => attr(v[1]));
      const pts = [];
      vs.forEach((v, i) => { const n = vs[(i + 1) % vs.length]; const seg = arcPts(+v.x, +v.y, +n.x, +n.y, +v.curve || 0); seg.pop(); pts.push(...seg); });
      out[sd].f.push('M' + pts.map(([px, py]) => T(px, py)).map((p) => r3(p[0]) + ' ' + r3(p[1])).join('L') + 'Z');
    }
  }
  const text = (sd, a, s, x, y, extraDeg, mirrored) => {
    const R = rotFn(a.rot);
    const mir = R.mir !== !!mirrored;
    out[sd].t.push([r3(x), r3(y), r3(a.size), (R.deg + extraDeg) % 360, a.align || 'bottom-left', unesc(s), mir ? 1 : 0]);
  };
  // board-level silk
  const plain = x.slice(x.indexOf('<plain>'), x.indexOf('</plain>'));
  shapes(plain, (px, py) => [px, py], false);
  for (const m of plain.matchAll(/<text ([^>]*)>([^<]*)<\/text>/g)) {
    const a = attr(m[1]); const sd = side(a.layer, false); if (!sd || !m[2].trim()) continue;
    text(sd, a, m[2], +a.x, +a.y, 0, false);
  }
  // package silk, placed per element
  const pk = {};
  const lsec = x.slice(x.indexOf('<libraries>'), x.indexOf('</libraries>'));
  for (const lm of lsec.matchAll(/<library name="([^"]*)"[^>]*>([\s\S]*?)<\/library>/g))
    for (const pm of lm[2].matchAll(/<package name="([^"]*)"[^>]*>([\s\S]*?)<\/package>/g)) pk[lm[1] + '/' + pm[1]] = pm[2];
  for (const m of x.matchAll(/<element ([^>]*?)(\/>|>([\s\S]*?)<\/element>)/g)) {
    const e = attr(m[1]);
    if (/^(DNP|NM)$|- ?NM$/i.test(e.value || '')) continue;
    const body = pk[e.library + '/' + e.package]; if (!body) continue;
    const R = rotFn(e.rot);
    const T = (px, py) => { const [qx, qy] = R.f(px, py); return [+e.x + qx, +e.y + qy]; };
    shapes(body.replace(/<text [\s\S]*?<\/text>/g, ''), T, R.mir);
    // texts drawn by the package itself (logos spelled in text), not >NAME / >VALUE placeholders
    for (const t of body.matchAll(/<text ([^>]*)>([^<]*)<\/text>/g)) {
      if (/^&gt;/.test(t[2]) || /^>/.test(t[2])) continue;
      const a = attr(t[1]); const sd = side(a.layer, R.mir); if (!sd) continue;
      const [tx, ty] = T(+a.x, +a.y);
      text(sd, a, t[2], tx, ty, R.deg, R.mir);
    }
    // smashed NAME / VALUE shown on the silk
    for (const t of (m[3] || '').matchAll(/<attribute ([^>]*?)\/>/g)) {
      const a = attr(t[1]);
      if (!/^(NAME|VALUE)$/.test(a.name) || a.display === 'off' || !a.x) continue;
      const sd = side(a.layer, false); if (!sd) continue;
      const s = a.name === 'NAME' ? e.name : e.value;
      if (!s || /^U\$|^FRAME|^FD\d|^TP/.test(s)) continue;
      text(sd, a, s, +a.x, +a.y, 0, false);
    }
  }
  // text that would run off the board edge is not printed (the board house
  // clips silk to the outline), so leave it out
  const dim = [...x.matchAll(/<wire ([^>]*layer="20"[^>]*?)\/>/g)].map((m) => attr(m[1]));
  if (dim.length) {
    const xs = dim.flatMap((a) => [+a.x1, +a.x2]), ys = dim.flatMap((a) => [+a.y1, +a.y2]);
    const X1 = Math.min(...xs), X2 = Math.max(...xs), Y1 = Math.min(...ys), Y2 = Math.max(...ys);
    for (const sd of ['top', 'bottom']) out[sd].t = out[sd].t.filter(([tx, ty, size, deg, , str]) => {
      const L = size * 0.85 * str.length, a = (deg * Math.PI) / 180;
      const ex = tx + Math.cos(a) * L, ey = ty + Math.sin(a) * L;
      return [[tx, ty], [ex, ey]].every(([px, py]) => px >= X1 - 0.3 && px <= X2 + 0.3 && py >= Y1 - 0.3 && py <= Y2 + 0.3);
    });
  }
  if (dim.length) {
    const xs = dim.flatMap((a) => [+a.x1, +a.x2]), ys = dim.flatMap((a) => [+a.y1, +a.y2]);
    const X1 = Math.min(...xs) - 0.5, X2 = Math.max(...xs) + 0.5, Y1 = Math.min(...ys) - 0.5, Y2 = Math.max(...ys) + 0.5;
    for (const sd of ['top', 'bottom']) out[sd].bmp = out[sd].bmp.filter((r) => Math.min(r[0], r[2]) >= X1 && Math.max(r[0], r[2]) <= X2 && Math.min(r[1], r[3]) >= Y1 && Math.max(r[1], r[3]) <= Y2);
  }
  for (const sd of ['top', 'bottom']) out[sd].s = Object.entries(out[sd].s).map(([w, list]) => [+w, list.join('')]);
  return out;
}
// Adafruit's bitmap silk as a transparent PNG (white ink), 20 px/mm, and its
// frame in CAD mm, so the drawing can lay it in as one image
function rasterize(rects, file) {
  if (!rects.length) return null;
  const xs = rects.flatMap((r) => [r[0], r[2]]), ys = rects.flatMap((r) => [r[1], r[3]]);
  const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map((v) => +v.toFixed(3));
  const { execFileSync } = require('child_process');
  const py = `
import json,sys
from PIL import Image, ImageDraw
d=json.load(sys.stdin); k=20; ss=3; x0,y0,x1,y1=d['box']
W=int((x1-x0)*k)+2; H=int((y1-y0)*k)+2
im=Image.new('L',(W*ss,H*ss),0); g=ImageDraw.Draw(im)
for a,b,c,e in d['rects']:
    l,r=sorted([a,c]); lo,hi=sorted([b,e])
    X0=(l-x0)*k*ss; Y0=(y1-hi)*k*ss; g.rectangle([X0,Y0,max(X0,(r-x0)*k*ss-1),max(Y0,(y1-lo)*k*ss-1)],fill=255)
im=im.resize((W,H),Image.LANCZOS)
out=Image.new('RGBA',(W,H),(233,238,240,0)); out.putalpha(im); out.save(d['file'],optimize=True)
print(W,H)`;
  const wh = execFileSync('python3', ['-c', py], { input: JSON.stringify({ rects, box, file }) }).toString().trim().split(' ').map(Number);
  return { src: 'img/silk/' + path.basename(file), box: [box[0], box[1], box[0] + (wh[0]) / 20, box[1] + 0], w: wh[0] / 20, h: wh[1] / 20, x: box[0], y: box[3] };
}

const SOURCES = {
  'uno/r3': 'A000066/A000066-cad-files/UNO-TH_Rev3e.brd',
  'mega/rev3': 'A000067/A000067-cad-files/MEGA2560_Rev3e.brd',
  'leonardo/rev3': 'A000057/A000057-cad-files/Leonardo_Rev3d.brd',
  'nano/v3': 'A000005/A00005-cad-files/NanoV3.3.brd',
  featheresp32: 'Adafruit-HUZZAH32-ESP32-Feather-PCB/Adafruit HUZZAH32 ESP32 Feather.brd',
  featherrp2040: 'Adafruit-Feather-RP2040-PCB/Adafruit Feather RP2040.brd',
  'featherm0/basic': 'Adafruit-Feather-M0-Basic-Proto-PCB/Adafruit Feather M0 Basic rev C.brd',
  'featherm0/express': 'Adafruit-Feather-M0-Express-PCB/Adafruit Feather M0 Express.brd',
  featherm4: 'Adafruit-Feather-M4-Express-PCB/Adafruit Feather M4 Express.brd'
};
module.exports = { silk, arcPts };
if (require.main === module) {
  const all = {};
  const imgDir = path.join(__dirname, '..', 'renderer', 'img', 'silk');
  fs.mkdirSync(imgDir, { recursive: true });
  for (const [k, f] of Object.entries(SOURCES)) {
    const sk = silk(f);
    for (const sd of ['top', 'bottom']) {
      const im = rasterize(sk[sd].bmp, path.join(imgDir, k.replace('/', '-') + '-' + sd + '.png'));
      delete sk[sd].bmp;
      if (im) sk[sd].img = { src: im.src, x: im.x, y: im.y, w: im.w, h: im.h };
    }
    all[k] = sk;
  }
  process.stdout.write('// Silkscreen of the Eagle-drawn boards from the makers\' .brd files (Arduino CAD:\n' +
    '// CC BY-SA 4.0; Adafruit PCB files: CC BY-SA). Generated by tools/extract-board-silk.js,\n' +
    '// do not edit by hand. CAD mm, y up. s: [[width, path]], f: filled paths,\n' +
    '// t: [x, y, size, rotDeg, align, text, mirrored].\n' +
    'window.PINODE_BOARD_SILK = ' + JSON.stringify(all) + ';\n');
}
