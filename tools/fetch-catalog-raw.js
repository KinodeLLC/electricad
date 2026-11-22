// Download the Adafruit products + categories APIs to raw JSON files, and
// print the field names actually present so the distiller can match reality.
// Two requests total, well under the API's 5-requests-per-minute guidance.
const https = require('https');
const fs = require('fs');
const path = require('path');

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'ElectriCAD catalog bake', 'Accept': 'application/json' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 3) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' for ' + url)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  const dir = __dirname;
  console.log('fetching products…');
  const prodsRaw = await get('https://www.adafruit.com/api/products');
  fs.writeFileSync(path.join(dir, 'raw-products.json'), prodsRaw);
  const products = JSON.parse(prodsRaw);
  console.log('products:', products.length, 'bytes:', prodsRaw.length);
  console.log('product keys:', Object.keys(products[0]).join(', '));
  console.log('sample:', JSON.stringify(products[0]).slice(0, 1200));

  console.log('fetching categories…');
  const catsRaw = await get('https://www.adafruit.com/api/categories');
  fs.writeFileSync(path.join(dir, 'raw-categories.json'), catsRaw);
  const cats = JSON.parse(catsRaw);
  console.log('categories:', cats.length, 'bytes:', catsRaw.length);
  console.log('category keys:', Object.keys(cats[0]).join(', '));
  console.log('DONE');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
