// Distill the raw Adafruit API dumps into the compact offline catalog the app
// ships with (assets/adafruit-catalog.json). Column-array format keeps it small.
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const products = JSON.parse(fs.readFileSync(path.join(dir, 'raw-products.json'), 'utf8'));
const cats = JSON.parse(fs.readFileSync(path.join(dir, 'raw-categories.json'), 'utf8'));

// Flatten the category tree into id -> name (subcategories nest arbitrarily).
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
    mfg === 'Adafruit' ? '' : mfg,            // blank = Adafruit (the common case)
    Number.isFinite(price) ? price : null,
    Number.isFinite(stock) ? stock : 0,
    parseInt(p.product_master_category, 10) || 0,
    parseInt(p.parent_pid, 10) || 0,
    flags
  ]);
}
rows.sort((a, b) => a[0] - b[0]);

const out = {
  source: 'adafruit products api',
  baked: new Date().toISOString().slice(0, 10),
  columns: ['id', 'name', 'model', 'mpn', 'mfg', 'price', 'stock', 'cat', 'parent', 'flags'],
  flagBits: { discontinued: 1, comingSoon: 2, virtual: 4 },
  cats: catNames,
  products: rows
};

const outPath = path.join(dir, '..', 'assets', 'adafruit-catalog.json');
fs.writeFileSync(outPath, JSON.stringify(out));
const bytes = fs.statSync(outPath).size;
console.log('products kept:', rows.length, 'categories:', Object.keys(catNames).length, 'bytes:', bytes);
const inStock = rows.filter(r => r[6] > 0).length;
const disc = rows.filter(r => r[9] & 1).length;
console.log('in stock:', inStock, 'discontinued:', disc);
console.log('sample row:', JSON.stringify(rows.find(r => r[0] === 4759) || rows[100]));
console.log('DONE');
