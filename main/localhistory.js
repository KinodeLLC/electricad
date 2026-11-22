// Local history: every save keeps a copy (the last 20 per file) under the
// app-data folder, so an overwritten sketch can always be brought back.
// Hot exit: dirty editor buffers are mirrored to one JSON file every few
// seconds and offered back after a crash or power cut.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEEP = 20;
let rootDir = null;
function root() {
  if (!rootDir) { const { app } = require('electron'); rootDir = app.getPath('userData'); }
  return rootDir;
}
function setRoot(d) { rootDir = d; }   // tests
const keyFor = (file) => crypto.createHash('sha1').update(path.resolve(file).toLowerCase()).digest('hex').slice(0, 20);
const dirFor = (file) => path.join(root(), 'history', keyFor(file));

function snapshot(file, content) {
  const d = dirFor(file);
  fs.mkdirSync(d, { recursive: true });
  const names = fs.readdirSync(d).filter((n) => /^\d+\.txt$/.test(n)).sort();
  if (names.length) {
    const last = fs.readFileSync(path.join(d, names[names.length - 1]), 'utf8');
    if (last === content) return false;          // unchanged: no duplicate entry
  }
  let stamp = Date.now();
  while (fs.existsSync(path.join(d, stamp + '.txt'))) stamp++;
  fs.writeFileSync(path.join(d, stamp + '.txt'), content, 'utf8');
  fs.writeFileSync(path.join(d, 'path.txt'), path.resolve(file), 'utf8');
  const all = names.concat(stamp + '.txt');
  for (const old of all.slice(0, Math.max(0, all.length - KEEP))) { try { fs.unlinkSync(path.join(d, old)); } catch (e) {} }
  return true;
}
function list(file) {
  const d = dirFor(file);
  let names = [];
  try { names = fs.readdirSync(d).filter((n) => /^\d+\.txt$/.test(n)); } catch (e) { return []; }
  return names.sort().reverse().map((n) => {
    const st = fs.statSync(path.join(d, n));
    return { id: n.replace(/\.txt$/, ''), time: Number(n.replace(/\.txt$/, '')), bytes: st.size };
  });
}
function read(file, id) {
  if (!/^\d+$/.test(String(id))) throw new Error('bad history id');
  return fs.readFileSync(path.join(dirFor(file), id + '.txt'), 'utf8');
}

const hotFile = () => path.join(root(), 'hot-exit.json');
function hotSave(buffers) {
  const list = (buffers || []).filter((b) => b && b.path && typeof b.content === 'string');
  if (!list.length) { try { fs.unlinkSync(hotFile()); } catch (e) {} return true; }
  fs.writeFileSync(hotFile() + '.tmp', JSON.stringify({ saved: Date.now(), buffers: list }));
  fs.renameSync(hotFile() + '.tmp', hotFile());
  return true;
}
function hotLoad() {
  try { return JSON.parse(fs.readFileSync(hotFile(), 'utf8')); } catch (e) { return null; }
}
function hotClear() { try { fs.unlinkSync(hotFile()); } catch (e) {} return true; }

module.exports = { snapshot, list, read, hotSave, hotLoad, hotClear, setRoot, KEEP };
