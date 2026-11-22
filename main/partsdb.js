// Real parts: the JLCPCB/LCSC catalogue (live) plus KiCad's symbol and
// footprint libraries (built in, CC-BY-SA 4.0, see assets/kicad/LICENSE.md).
//   search   → jlcsearch.tscircuit.com (JLCPCB's in-stock catalogue, no key)
//   details  → LCSC product page data: specs, price breaks, datasheet
//   build    → renderer/partlib.js turns that into a canvas part with the
//              KiCad pinout and footprint (or says it could not)
// Every part looked at is cached in userData/parts-cache so it works offline,
// and the parts actually placed are kept as "My parts".
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const PL = require('../renderer/partlib.js');

const ASSETS = path.join(__dirname, '..', 'assets', 'kicad');
let userDir = null;
function dir() {
  if (!userDir) {
    try { userDir = path.join(require('electron').app.getPath('userData'), 'parts-cache'); } catch (e) { userDir = path.join(require('os').tmpdir(), 'electricad-parts-cache'); }
  }
  fs.mkdirSync(userDir, { recursive: true });
  return userDir;
}
function setDir(d) { userDir = d; }

// ---- KiCad libraries (loaded on first use, ~1 s) ------------------------------------
let K = null;
function kicad() {
  if (K) return K;
  const syms = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ASSETS, 'symbols.json.gz'))).toString('utf8'));
  const fps = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ASSETS, 'footprints.json.gz'))).toString('utf8'));
  K = { syms, fps, symbols: PL.symbolIndex(syms), ids: new Set(Object.keys(fps)), footprint: (id) => fps[id] || null };
  return K;
}

// ---- network ------------------------------------------------------------------------
const UA = 'ElectriCAD parts search';
async function getJson(url, ms = 15000) {
  let f = globalThis.fetch;
  try { const { net } = require('electron'); if (net && net.fetch) f = net.fetch.bind(net); } catch (e) { /* node */ }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await f(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
const JLC = 'https://jlcsearch.tscircuit.com';

// "10k 0603", "4k7", "220 ohm" → the catalogue's resistor table, which holds
// every part of that value rather than the top text matches
function smartQuery(q) {
  const s = String(q).trim();
  const pkg = (/\b(0201|0402|0603|0805|1206|1210|2010|2512)\b/.exec(s) || [])[1];
  const rest = s.replace(/\b(0201|0402|0603|0805|1206|1210|2010|2512)\b/, '').replace(/\b(resistors?|res|ohms?)\b|Ω/gi, ' ').trim();
  let val = null;
  const plain = /^(\d+(?:\.\d+)?)\s*([kKM]?)$/.exec(rest);
  const rkm = /^(\d+)([kKMR])(\d+)$/.exec(rest);   // 4k7, 2R2
  const mult = (c) => (c === 'k' || c === 'K' ? 1e3 : c === 'M' ? 1e6 : 1);
  // the table wants plain ohms ("10k" would be read as 10 Ω)
  if (plain) val = Number(plain[1]) * mult(plain[2]);
  else if (rkm) val = Number(rkm[1] + '.' + rkm[3]) * mult(rkm[2]);
  if (val) val = +val.toPrecision(6);
  if (val) return JLC + '/resistors/list.json?resistance=' + encodeURIComponent(val) + (pkg ? '&package=' + pkg : '');
  return null;
}

// rows: { lcsc, mfr, pkg, desc, stock, price, basic, preferred, cached }
async function search(opts) {
  const q = String((opts && opts.q) || '').trim();
  const limit = Math.min(100, (opts && opts.limit) || 40);
  if (!q) return { rows: mine(), source: 'mine' };
  let rows = [], error = null, source = 'jlcpcb';
  try {
    const smart = smartQuery(q);
    let data = smart ? await getJson(smart) : null;
    let list = data ? Object.values(data).find(Array.isArray) || [] : [];
    if (!list.length) {
      data = await getJson(JLC + '/api/search?q=' + encodeURIComponent(q) + '&limit=' + limit);
      list = data.components || Object.values(data).find(Array.isArray) || [];
    }
    rows = list.slice(0, smart ? 200 : limit).map(PL.infoFromSearch);
    // an exact C-number typed in jumps straight to that part
    if (/^C\d{2,}$/i.test(q) && !rows.some((r) => r.lcsc === q.toUpperCase())) {
      const d = await details(q).catch(() => null);
      if (d) rows.unshift(d.info);
    }
  } catch (e) {
    error = 'The JLCPCB catalogue could not be reached (' + e.message + '). Showing parts saved on this computer.';
    source = 'offline';
  }
  if (opts && opts.inStock) rows = rows.filter((r) => r.stock == null || r.stock > 0);
  if (opts && opts.basic) rows = rows.filter((r) => r.basic || r.preferred);
  // basic parts (no extra JLCPCB assembly fee), then stock
  rows.sort((a, b) => (b.basic - a.basic) || ((b.preferred ? 1 : 0) - (a.preferred ? 1 : 0)) || ((b.stock || 0) - (a.stock || 0)));
  rows = rows.slice(0, limit);
  const cachedSet = new Set(listCache().map((c) => c.lcsc));
  for (const r of rows) r.cached = cachedSet.has(r.lcsc);
  if (source === 'offline') {
    const ql = q.toLowerCase();
    rows = listCache().filter((c) => (c.lcsc + ' ' + c.mfr + ' ' + c.desc + ' ' + c.pkg).toLowerCase().includes(ql));
  }
  return { rows, source, error };
}

// ---- cache ---------------------------------------------------------------------------
const file = (lcsc) => path.join(dir(), String(lcsc).toUpperCase().replace(/[^C0-9]/g, '') + '.json');
function readCache(lcsc) { try { return JSON.parse(fs.readFileSync(file(lcsc), 'utf8')); } catch (e) { return null; } }
function writeCache(entry) { try { fs.writeFileSync(file(entry.info.lcsc), JSON.stringify(entry)); } catch (e) { /* read-only disk: still works online */ } }
function listCache() {
  let names = [];
  try { names = fs.readdirSync(dir()).filter((n) => /^C\d+\.json$/.test(n)); } catch (e) { return []; }
  return names.map((n) => { try { const e = JSON.parse(fs.readFileSync(path.join(dir(), n), 'utf8')); return { ...e.info, used: e.used || 0, fetched: e.fetched }; } catch (x) { return null; } }).filter(Boolean);
}
function mine() { return listCache().filter((c) => c.used).sort((a, b) => b.used - a.used).map((c) => ({ ...c, cached: true })); }
function markUsed(lcsc) { const e = readCache(lcsc); if (e) { e.used = Date.now(); writeCache(e); } return !!e; }

// ---- one part, everything about it -----------------------------------------------------
// returns { info, part, fp: { id, def } | null, fetched, offline? }
async function details(lcsc, opts) {
  const code = String(lcsc || '').toUpperCase().trim();
  if (!/^C\d+$/.test(code)) throw new Error('Not an LCSC part number: ' + lcsc);
  let entry = readCache(code), offline = false;
  const stale = !entry || Date.now() - (entry.fetched || 0) > 7 * 864e5 || (opts && opts.refresh);
  if (stale) {
    try {
      const d = await getJson('https://wmsc.lcsc.com/ftps/wm/product/detail?productCode=' + code);
      const info = PL.infoFromLcsc(d && d.result);
      if (!info || !info.lcsc) throw new Error('LCSC has no part ' + code);
      // JLCPCB's basic / preferred flags only come with the search rows
      if (opts && opts.row) { info.basic = !!opts.row.basic; info.preferred = !!opts.row.preferred; }
      else if (entry) { info.basic = entry.info.basic; info.preferred = entry.info.preferred; }
      entry = { info, fetched: Date.now(), used: entry ? entry.used : 0 };
      writeCache(entry);
    } catch (e) {
      if (!entry) {
        // no detail page reachable: fall back to the search row the user clicked
        if (opts && opts.row) entry = { info: { ...opts.row }, fetched: 0, partial: true };
        else throw e;
      }
      offline = true;
    }
  }
  return { ...build(entry.info), fetched: entry.fetched, offline, partial: !!entry.partial };
}

function build(info) {
  const k = kicad();
  const part = PL.toCanvasPart(info, k);
  const fpId = part.lib.fp;
  const compact = fpId ? k.footprint(fpId) : null;
  // the footprint travels inside the part, so a project opens anywhere
  if (compact) part.lib.fpData = compact;
  part.lib.priceUsd = info.price != null ? info.price : null;
  part.lib.checked = new Date().toISOString().slice(0, 10);
  return { info, part, fp: compact ? { id: fpId, def: PL.kicadToFp(fpId, compact) } : null };
}

// ---- KiCad browsing ---------------------------------------------------------------------
function fpSearch(q, limit = 60) {
  const k = kicad();
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out = [];
  for (const id of k.ids) {
    const l = id.toLowerCase();
    if (words.every((w) => l.includes(w))) { out.push({ id, pads: (k.fps[id].p || []).length, smd: !!k.fps[id].s, d: k.fps[id].d || '' }); if (out.length >= limit) break; }
  }
  return out;
}
function fp(id) { const k = kicad(); const c = k.footprint(id); return c ? { id, compact: c, def: PL.kicadToFp(id, c) } : null; }
function symSearch(q, limit = 40) {
  const k = kicad();
  const ql = String(q || '').toLowerCase();
  if (!ql) return [];
  return k.syms.filter((s) => s.n.toLowerCase().includes(ql) || (s.k || '').toLowerCase().includes(ql)).slice(0, limit)
    .map((s) => ({ name: s.n, lib: s.l, fp: s.f, desc: s.d, pins: s.p.length, ds: s.ds }));
}
function stats() {
  const k = kicad();
  return { symbols: k.syms.length, footprints: k.ids.size, cached: listCache().length };
}

module.exports = { search, details, build, fpSearch, fp, symSearch, stats, markUsed, mine, smartQuery, setDir, kicad };
