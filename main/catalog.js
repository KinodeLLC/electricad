// Adafruit parts catalog — fully offline. The dataset ships with the app
// (assets/adafruit-catalog.json, baked from the public products API) so
// browsing needs no network and has no rate limits. Refresh re-downloads on
// demand: exactly two requests, honoring the API's 5-requests/minute ask.
const https = require('https');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'assets', 'adafruit-catalog.json');

let data = null;      // { baked, columns, flagBits, cats, products: [rows] }
let index = null;     // rows mapped to objects once, for search speed

function colObjects(d) {
  const c = d.columns; // ['id','name','model','mpn','mfg','price','stock','cat','parent','flags']
  return d.products.map((r) => {
    const o = {};
    c.forEach((k, i) => { o[k] = r[i]; });
    o.catName = d.cats[String(o.cat)] || '';
    o.url = 'https://www.adafruit.com/product/' + o.id;
    return o;
  });
}

function loadSync() {
  if (data) return data;
  try {
    data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    index = colObjects(data);
  } catch (e) {
    data = { baked: null, columns: [], cats: {}, products: [] };
    index = [];
  }
  return data;
}

function stats() {
  loadSync();
  return { baked: data.baked, products: index.length, cats: Object.keys(data.cats || {}).length };
}

function categories() {
  loadSync();
  // only categories that actually contain products, sorted by name
  const used = new Map();
  for (const p of index) {
    if (!p.cat) continue;
    used.set(p.cat, (used.get(p.cat) || 0) + 1);
  }
  return [...used.entries()]
    .map(([id, n]) => ({ id, name: (data.cats[String(id)] || 'Category ' + id), n }))
    .filter((c) => c.n >= 3)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Relevance-ranked search. Every term must appear somewhere (name, model,
// mpn, id, category); results are then ordered by how well they match —
// whole-word hits in the product NAME beat substring hits in the category —
// with in-stock, current products ahead of discontinued ones.
function search({ q, cat, inStock, limit }) {
  loadSync();
  const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const max = limit || 80;
  const scored = [];
  for (const p of index) {
    if (cat && p.cat !== cat) continue;
    if (inStock && !(p.stock > 0)) continue;
    let score = 0;
    if (terms.length) {
      const name = (p.name || '').toLowerCase();
      const hay = (name + ' ' + p.model + ' ' + p.mpn + ' ' + p.id + ' ' + p.catName).toLowerCase();
      if (!terms.every((t) => hay.includes(t))) continue;
      for (const t of terms) {
        if (new RegExp('(^|[^a-z0-9])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z0-9])').test(name)) score += 10;
        else if (name.includes(t)) score += 5;
        else score += 1;
      }
      if (name.startsWith(terms[0])) score += 3;
      if (name.replace(/^adafruit\s+/, '').startsWith(terms.join(' '))) score += 6;
    }
    if (p.stock > 0) score += 2;
    if (p.flags & 1) score -= 4;   // discontinued
    if (p.flags & 4) score -= 3;   // virtual (gift cards, downloads)
    scored.push({ p, score });
  }
  // stable within equal scores: newest product ids first (newer parts)
  scored.sort((a, b) => (b.score - a.score) || (b.p.id - a.p.id));
  const out = scored.slice(0, max).map((x) => x.p);
  // exact product-id query jumps to the top
  const asId = Number(q);
  if (asId) {
    const hit = index.find((p) => p.id === asId);
    if (hit) { const i = out.indexOf(hit); if (i >= 0) out.splice(i, 1); out.unshift(hit); }
  }
  return out;
}

function get(id) {
  loadSync();
  return index.find((p) => p.id === Number(id)) || null;
}

// ---- refresh: re-fetch from adafruit.com and re-distill --------------------
function fetchUrl(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'ElectriCAD catalog refresh', Accept: 'application/json' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 3) {
        res.resume();
        return resolve(fetchUrl(new URL(res.headers.location, url).toString(), redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function distill(products, cats) {
  const catNames = {};
  (function walk(list) {
    for (const c of list || []) {
      if (c && c.category_id != null) catNames[String(c.category_id)] = String(c.category_name || '').trim();
      if (c && Array.isArray(c.subcategories)) walk(c.subcategories);
    }
  })(cats);
  const rows = [];
  for (const p of products) {
    const id = parseInt(p.product_id, 10);
    if (!id) continue;
    const stock = parseInt(p.product_stock, 10);
    const price = parseFloat(p.product_price);
    let flags = 0;
    if (String(p.discontinue_status || '').toLowerCase().includes('discontinued')) flags |= 1;
    if (String(p.products_coming_soon) === '1') flags |= 2;
    if (String(p.products_virtual) === '1') flags |= 4;
    const mfg = String(p.product_manufacturer || '').trim();
    rows.push([
      id,
      String(p.product_name || '').trim(),
      String(p.product_model || '').trim(),
      String(p.product_mpn || '').trim(),
      mfg === 'Adafruit' ? '' : mfg,
      Number.isFinite(price) ? price : null,
      Number.isFinite(stock) ? stock : 0,
      parseInt(p.product_master_category, 10) || 0,
      parseInt(p.parent_pid, 10) || 0,
      flags
    ]);
  }
  rows.sort((a, b) => a[0] - b[0]);
  return {
    source: 'adafruit products api',
    baked: new Date().toISOString().slice(0, 10),
    columns: ['id', 'name', 'model', 'mpn', 'mfg', 'price', 'stock', 'cat', 'parent', 'flags'],
    flagBits: { discontinued: 1, comingSoon: 2, virtual: 4 },
    cats: catNames,
    products: rows
  };
}

let refreshing = null;
function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const prods = JSON.parse(await fetchUrl('https://www.adafruit.com/api/products'));
    const cats = JSON.parse(await fetchUrl('https://www.adafruit.com/api/categories'));
    const next = distill(prods, cats);
    fs.writeFileSync(FILE, JSON.stringify(next));
    data = next;
    index = colObjects(next);
    return stats();
  })();
  refreshing.finally(() => { refreshing = null; });
  return refreshing;
}

module.exports = { stats, categories, search, get, refresh };
