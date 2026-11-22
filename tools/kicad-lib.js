// Builds assets/kicad/{symbols,footprints}.json.gz from KiCad's official
// libraries (gitlab.com/kicad/libraries, CC-BY-SA 4.0 with the design
// exception: see assets/kicad/LICENSE.md). Run:
//   node tools/kicad-lib.js <kicad-symbols dir> <kicad-footprints dir>
// Symbols keep what ElectriCAD needs to wire a part: pins (number, name,
// electrical type), default footprint, datasheet, description, keywords.
// Footprints keep pads, holes, silkscreen and the courtyard, in mm.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---- s-expressions -------------------------------------------------------------
function parse(text) {
  let i = 0;
  const n = text.length;
  function list() {
    const out = [];
    i++; // (
    for (;;) {
      while (i < n && /\s/.test(text[i])) i++;
      if (i >= n) return out;
      const c = text[i];
      if (c === ')') { i++; return out; }
      if (c === '(') { out.push(list()); continue; }
      if (c === '"') {
        let s = ''; i++;
        while (i < n && text[i] !== '"') { if (text[i] === '\\') { i++; s += text[i] === 'n' ? '\n' : text[i]; } else s += text[i]; i++; }
        i++; out.push({ s }); continue;
      }
      let a = '';
      while (i < n && !/[\s()]/.test(text[i])) a += text[i++];
      out.push(a);
    }
  }
  while (i < n && text[i] !== '(') i++;
  return list();
}
const head = (x) => (Array.isArray(x) ? x[0] : null);
const str = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x.s : x);
const kids = (x, name) => (Array.isArray(x) ? x.filter((k) => head(k) === name) : []);
const kid = (x, name) => kids(x, name)[0];
const num = (x) => Number(str(x));
const r3 = (v) => Math.round(v * 1000) / 1000;

// ---- symbols --------------------------------------------------------------------
function symbolsFrom(dir) {
  const out = [];
  const libs = fs.readdirSync(dir).filter((d) => d.endsWith('.kicad_symdir'));
  for (const libDir of libs) {
    const lib = libDir.replace(/\.kicad_symdir$/, '');
    if (lib === 'power') continue;
    const raw = {};
    for (const f of fs.readdirSync(path.join(dir, libDir))) {
      if (!f.endsWith('.kicad_sym')) continue;
      const t = parse(fs.readFileSync(path.join(dir, libDir, f), 'utf8'));
      for (const sym of kids(t, 'symbol')) {
        const name = str(sym[1]);
        const props = {};
        for (const p of kids(sym, 'property')) props[str(p[1])] = str(p[2]);
        const ext = kid(sym, 'extends');
        const pins = new Map();
        const walk = (node) => {
          for (const k of node) {
            if (head(k) === 'symbol') walk(k);
            if (head(k) === 'pin') {
              const nm = kid(k, 'name'), nb = kid(k, 'number');
              const number = nb ? str(nb[1]) : '';
              if (!pins.has(number)) pins.set(number, [number, nm ? str(nm[1]) : '', String(k[1])]);
            }
          }
        };
        walk(sym);
        raw[name] = { n: name, l: lib, e: ext ? str(ext[1]) : '', f: props.Footprint || '', ds: props.Datasheet && props.Datasheet !== '~' ? props.Datasheet : '',
          d: props.Description || '', k: props.ki_keywords || '', ff: props.ki_fp_filters || '', v: props.Value || name, p: [...pins.values()] };
      }
    }
    for (const s of Object.values(raw)) {
      // a derived symbol inherits its parent's pins (and anything it leaves blank)
      let base = s, guard = 0;
      while (base.e && raw[base.e] && guard++ < 8) base = raw[base.e];
      const pins = s.p.length ? s.p : base.p;
      const rec = { n: s.n, l: s.l, f: s.f || base.f, ds: s.ds || base.ds, d: s.d || base.d, k: s.k || base.k, p: pins };
      if (s.ff || base.ff) rec.ff = s.ff || base.ff;
      out.push(rec);
    }
  }
  return out;
}

// ---- footprints -----------------------------------------------------------------
function arcPts(s, m, e) {
  // circle through three points, then 8 segments from start to end through mid
  const [x1, y1] = s, [x2, y2] = m, [x3, y3] = e;
  const d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
  if (Math.abs(d) < 1e-9) return [s, e];
  const ux = ((x1 * x1 + y1 * y1) * (y2 - y3) + (x2 * x2 + y2 * y2) * (y3 - y1) + (x3 * x3 + y3 * y3) * (y1 - y2)) / d;
  const uy = ((x1 * x1 + y1 * y1) * (x3 - x2) + (x2 * x2 + y2 * y2) * (x1 - x3) + (x3 * x3 + y3 * y3) * (x2 - x1)) / d;
  const r = Math.hypot(x1 - ux, y1 - uy);
  const a1 = Math.atan2(y1 - uy, x1 - ux), a2 = Math.atan2(y2 - uy, x2 - ux), a3 = Math.atan2(y3 - uy, x3 - ux);
  const norm = (a) => { while (a < 0) a += 2 * Math.PI; while (a >= 2 * Math.PI) a -= 2 * Math.PI; return a; };
  let sweep = norm(a3 - a1);
  if (norm(a2 - a1) > sweep) sweep -= 2 * Math.PI;
  const pts = [];
  for (let k = 0; k <= 8; k++) { const a = a1 + (sweep * k) / 8; pts.push([ux + r * Math.cos(a), uy + r * Math.sin(a)]); }
  return pts;
}
function footprintFrom(t) {
  const name = str(t[1]);
  const fp = { d: '', p: [], l: [], c: [], n: [] };
  const descr = kid(t, 'descr'); if (descr) fp.d = str(descr[1]);
  const attr = kid(t, 'attr'); if (attr && attr.includes('smd')) fp.s = 1;
  let cy = null;
  const growCy = (x, y) => { if (!cy) cy = [x, y, x, y]; else { cy[0] = Math.min(cy[0], x); cy[1] = Math.min(cy[1], y); cy[2] = Math.max(cy[2], x); cy[3] = Math.max(cy[3], y); } };
  const layerOf = (k) => { const l = kid(k, 'layer'); return l ? str(l[1]) : ''; };
  const xy = (k, nm) => { const a = kid(k, nm); return a ? [num(a[1]), num(a[2])] : null; };
  const lines = { silk: [], fab: [] }, circles = { silk: [], fab: [] };
  for (const k of t) {
    const h = head(k);
    if (!h || !/^fp_/.test(h)) continue;
    const L = layerOf(k);
    const bucket = L === 'F.SilkS' ? 'silk' : L === 'F.Fab' ? 'fab' : L === 'F.CrtYd' ? 'cy' : null;
    if (!bucket) continue;
    const segs = [];
    if (h === 'fp_line') { const a = xy(k, 'start'), b = xy(k, 'end'); if (a && b) segs.push([a, b]); }
    else if (h === 'fp_rect') { const a = xy(k, 'start'), b = xy(k, 'end'); if (a && b) segs.push([a, [b[0], a[1]]], [[b[0], a[1]], b], [b, [a[0], b[1]]], [[a[0], b[1]], a]); }
    else if (h === 'fp_arc') { const a = xy(k, 'start'), m = xy(k, 'mid'), b = xy(k, 'end'); if (a && m && b) { const p = arcPts(a, m, b); for (let q = 0; q + 1 < p.length; q++) segs.push([p[q], p[q + 1]]); } }
    else if (h === 'fp_poly') { const pts = kid(k, 'pts'); const p = pts ? kids(pts, 'xy').map((v) => [num(v[1]), num(v[2])]) : []; for (let q = 0; q < p.length; q++) segs.push([p[q], p[(q + 1) % p.length]]); }
    else if (h === 'fp_circle') {
      const c = xy(k, 'center'), e = xy(k, 'end');
      if (c && e) { const r = Math.hypot(e[0] - c[0], e[1] - c[1]); if (bucket === 'cy') { growCy(c[0] - r, c[1] - r); growCy(c[0] + r, c[1] + r); } else circles[bucket].push([r3(c[0]), r3(c[1]), r3(r)]); }
    }
    for (const [a, b] of segs) {
      if (bucket === 'cy') { growCy(a[0], a[1]); growCy(b[0], b[1]); }
      else lines[bucket].push([r3(a[0]), r3(a[1]), r3(b[0]), r3(b[1])]);
    }
  }
  // silkscreen when there is one, else the fab outline (so every part has a body drawn)
  fp.l = lines.silk.length || circles.silk.length ? lines.silk : lines.fab;
  fp.c = lines.silk.length || circles.silk.length ? circles.silk : circles.fab;
  if (cy) fp.cy = cy.map(r3);
  let odd = false;
  for (const p of kids(t, 'pad')) {
    const number = str(p[1]), kind = String(p[2]), shape0 = String(p[3]);
    const at = kid(p, 'at'), size = kid(p, 'size'), drill = kid(p, 'drill');
    const x = num(at[1]), y = num(at[2]), rot = at[3] != null ? ((num(at[3]) % 360) + 360) % 360 : 0;
    let w = size ? num(size[1]) : 0, hh = size ? num(size[2]) : 0;
    let dr = 0;
    if (drill) { const vals = drill.slice(1).filter((v) => typeof v !== 'object' || v.s !== undefined).map(str).filter((v) => v !== 'oval' && !isNaN(Number(v))).map(Number); dr = vals.length ? Math.min(...vals) : 0; }
    if (kind === 'np_thru_hole') { fp.n.push([r3(x), r3(y), r3(dr || Math.min(w, hh))]); continue; }
    const layers = kid(p, 'layers');
    const onBack = layers && layers.slice(1).map(str).every((l) => /^B\./.test(l));
    if (kind === 'smd' && onBack) continue;            // back-side-only pads (rare) are left out
    if (rot === 90 || rot === 270) [w, hh] = [hh, w];
    else if (rot !== 0 && rot !== 180) odd = true;
    const shape = shape0 === 'circle' ? 'circle' : shape0 === 'oval' ? 'oval' : 'rect';
    if (shape0 === 'custom' || shape0 === 'trapezoid') odd = true;
    fp.p.push([number, shape, r3(x), r3(y), r3(w), r3(hh), kind === 'thru_hole' ? r3(dr) : 0]);
  }
  if (odd) fp.o = 1;   // pads at odd angles or custom shapes: drawn as their bounding pad
  if (!fp.n.length) delete fp.n;
  if (!fp.c.length) delete fp.c;
  return [name, fp];
}
function footprintsFrom(dir) {
  const out = {};
  for (const lib of fs.readdirSync(dir).filter((d) => d.endsWith('.pretty'))) {
    const L = lib.replace(/\.pretty$/, '');
    for (const f of fs.readdirSync(path.join(dir, lib))) {
      if (!f.endsWith('.kicad_mod')) continue;
      try {
        const [name, fp] = footprintFrom(parse(fs.readFileSync(path.join(dir, lib, f), 'utf8')));
        out[L + ':' + name] = fp;
      } catch (e) { console.error('skip', lib, f, e.message); }
    }
  }
  return out;
}

if (require.main === module) {
  const [symDir, fpDir] = process.argv.slice(2);
  const outDir = path.join(__dirname, '..', 'assets', 'kicad');
  fs.mkdirSync(outDir, { recursive: true });
  const syms = symbolsFrom(symDir);
  fs.writeFileSync(path.join(outDir, 'symbols.json.gz'), zlib.gzipSync(JSON.stringify(syms), { level: 9 }));
  console.log('symbols', syms.length);
  const fps = footprintsFrom(fpDir);
  fs.writeFileSync(path.join(outDir, 'footprints.json.gz'), zlib.gzipSync(JSON.stringify(fps), { level: 9 }));
  console.log('footprints', Object.keys(fps).length);
  fs.copyFileSync(path.join(symDir, 'LICENSE.md'), path.join(outDir, 'LICENSE.md'));
}
module.exports = { parse, footprintFrom, symbolsFrom, footprintsFrom };
