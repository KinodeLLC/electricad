// Project system. An ElectriCAD project is a folder with an electricad.json
// manifest (older projects with pinode.json are read and migrated in place).
// type: 'arduino' (sketch folder, .ino named after the folder) or 'pi'
// (python/any project deployed to a Raspberry Pi over the network).
// Plain Arduino IDE sketch folders (no manifest) open too: a manifest is
// written for them on first open, so the whole Arduino sketchbook just works.
const path = require('path');
const fs = require('fs');
const settings = require('./settings');
const { EXAMPLES } = require('./examples');

const IGNORE = new Set(['node_modules', '.git', 'build', '__pycache__', '.pinode-build', '.electricad-build', '.vscode']);

const SKETCH_TEMPLATE = `#include <ElectriCADTelemetry.h>

void setup() {
  Serial.begin(115200);
  ELECTRICAD_BEGIN();      // live pin view in the ElectriCAD board panel

  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  ELECTRICAD_TICK();       // keep the board view fed

  digitalWrite(LED_BUILTIN, HIGH);
  ELECTRICAD_DELAY(500);   // delay() that keeps the board view live
  digitalWrite(LED_BUILTIN, LOW);
  ELECTRICAD_DELAY(500);
}
`;

const UPY_TEMPLATE = `# ElectriCAD MicroPython project. F5 runs this file on the board without
# saving it; Python → Upload saves it as main.py so it runs at every boot.
from machine import Pin
import time

try:
    led = Pin("LED", Pin.OUT)      # Pico / Pico W / many boards name it "LED"
except (TypeError, ValueError):
    led = Pin(2, Pin.OUT)          # ESP32 DevKit: onboard LED on GPIO2

while True:
    led.toggle() if hasattr(led, "toggle") else led.value(not led.value())
    print("led:", led.value())     # label:value lines plot in the Plotter
    time.sleep(0.5)
`;

const CPY_TEMPLATE = `# ElectriCAD CircuitPython project. F5 runs this file on the board;
# Python → Upload copies it to the CIRCUITPY drive as code.py.
import time
import board
import digitalio

led = digitalio.DigitalInOut(board.LED)
led.direction = digitalio.Direction.OUTPUT

while True:
    led.value = not led.value
    print("led:", int(led.value))
    time.sleep(0.5)
`;

const PI_TEMPLATE = `#!/usr/bin/env python3
# ElectriCAD Raspberry Pi project. Run on the Pi; the ElectriCAD board panel
# watches the GPIO header live over pigpiod (sudo systemctl enable --now pigpiod).
import gpiozero
from time import sleep

led = gpiozero.LED(17)

while True:
    led.on()
    sleep(0.5)
    led.off()
    sleep(0.5)
`;

const MANIFEST = 'electricad.json';
const LEGACY_MANIFEST = 'pinode.json';

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function manifest(dir) {
  return readJson(path.join(dir, MANIFEST)) || readJson(path.join(dir, LEGACY_MANIFEST));
}

// a folder ElectriCAD can adopt: an Arduino sketch (.ino) or a python project
function sniffType(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return null; }
  if (names.some((n) => /\.ino$/i.test(n))) return 'arduino';
  if (names.includes('code.py') || names.includes('boot_out.txt')) return 'circuitpython';
  if (names.some((n) => /\.py$/i.test(n))) {
    try {
      const main = names.find((n) => /^(main|boot)\.py$/i.test(n));
      if (main && /^\s*(from|import)\s+(machine|micropython|network|utime)\b/m.test(fs.readFileSync(path.join(dir, main), 'utf8'))) return 'micropython';
    } catch (e) {}
    return 'pi';
  }
  return null;
}

// old pinode.json projects become electricad.json projects the moment
// they're opened — content carried over, legacy file removed
function migrateManifest(dir, m) {
  const target = path.join(dir, MANIFEST);
  if (fs.existsSync(target)) return;
  try {
    fs.writeFileSync(target, JSON.stringify(m, null, 2));
    if (fs.existsSync(path.join(dir, LEGACY_MANIFEST))) fs.unlinkSync(path.join(dir, LEGACY_MANIFEST));
  } catch (e) { /* read-only project dir — keep working off the in-memory manifest */ }
}

function entryFor(dir, m) {
  return { dir, name: m.name || path.basename(dir), type: m.type || 'arduino', fqbn: m.fqbn || '',
           modified: mtime(dir) };
}
function mtime(dir) {
  try { return fs.statSync(dir).mtimeMs; } catch (e) { return 0; }
}

function list() {
  const root = settings.get('projectsDir');
  try { fs.mkdirSync(root, { recursive: true }); } catch (e) {}
  const out = [];
  let names = [];
  try { names = fs.readdirSync(root); } catch (e) {}
  for (const name of names) {
    if (name === 'libraries') continue;  // the sketchbook's library folder
    const dir = path.join(root, name);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      const m = manifest(dir);
      if (m) out.push(entryFor(dir, m));
      else {
        // plain Arduino IDE sketches in the sketchbook are projects too
        const type = sniffType(dir);
        if (type === 'arduino') out.push({ dir, name, type, fqbn: '', modified: mtime(dir), unmanaged: true });
      }
    } catch (e) {}
  }
  // recents that live outside the projects dir
  for (const dir of settings.get('recentProjects') || []) {
    if (out.some((p) => p.dir === dir)) continue;
    const m = manifest(dir);
    if (m) out.push(entryFor(dir, m));
  }
  // most recently used first, then most recently modified
  const recents = settings.get('recentProjects') || [];
  const rank = (p) => { const i = recents.indexOf(p.dir); return i < 0 ? 1e6 : i; };
  const pinned = settings.get('pinnedProjects') || [];
  for (const p of out) p.pinned = pinned.includes(p.dir);
  out.sort((a, b) => (b.pinned - a.pinned) || (rank(a) - rank(b)) || (b.modified - a.modified));
  return out;
}

function safeName(name) {
  return String(name || 'sketch').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'sketch';
}

// never overwrite: "blink" exists → "blink_2", "blink_3"…
function uniqueDir(root, base) {
  let name = base, n = 2;
  while (fs.existsSync(path.join(root, name))) name = base + '_' + n++;
  return { name, dir: path.join(root, name) };
}

function create({ name, type, fqbn, example, fromDir }) {
  if (fromDir) return createFromDir({ name, fqbn, fromDir });
  const ex = example ? EXAMPLES.find((e) => e.id === example) : null;
  const kind = ex ? ex.type : (type || 'arduino');
  const root = settings.get('projectsDir');
  fs.mkdirSync(root, { recursive: true });
  const { name: safe, dir } = uniqueDir(root, safeName(name || (ex && ex.id)));
  fs.mkdirSync(dir, { recursive: true });
  const m = { name: safe, type: kind, fqbn: fqbn || '', created: new Date().toISOString() };
  if (ex && ex.libs && ex.libs.length) m.libraries = ex.libs.slice();
  fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(m, null, 2));
  if (kind === 'pi') {
    fs.writeFileSync(path.join(dir, 'main.py'), ex ? ex.code : PI_TEMPLATE);
  } else if (kind === 'micropython') {
    fs.writeFileSync(path.join(dir, 'main.py'), ex ? ex.code : UPY_TEMPLATE);
  } else if (kind === 'circuitpython') {
    fs.writeFileSync(path.join(dir, 'code.py'), ex ? ex.code : CPY_TEMPLATE);
  } else {
    // arduino-cli requires the .ino to be named after its folder
    fs.writeFileSync(path.join(dir, safe + '.ino'), ex ? ex.code : SKETCH_TEMPLATE);
  }
  return open(dir);
}

// copy a library example (or any sketch folder) into a fresh project; the
// sketch's main .ino is renamed to match the new folder as arduino-cli needs
function createFromDir({ name, fqbn, fromDir }) {
  if (!fs.existsSync(fromDir) || !fs.statSync(fromDir).isDirectory()) throw new Error('Example folder not found: ' + fromDir);
  const root = settings.get('projectsDir');
  fs.mkdirSync(root, { recursive: true });
  const { name: safe, dir } = uniqueDir(root, safeName(name || path.basename(fromDir)));
  fs.cpSync(fromDir, dir, { recursive: true });
  const oldMain = path.join(dir, path.basename(fromDir) + '.ino');
  const inos = fs.readdirSync(dir).filter((f) => /\.ino$/i.test(f));
  const src = fs.existsSync(oldMain) ? oldMain : (inos.length === 1 ? path.join(dir, inos[0]) : null);
  if (src && path.basename(src) !== safe + '.ino') fs.renameSync(src, path.join(dir, safe + '.ino'));
  const m = { name: safe, type: 'arduino', fqbn: fqbn || '', created: new Date().toISOString(), fromExample: fromDir };
  fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(m, null, 2));
  return open(dir);
}

function open(dir) {
  let m = manifest(dir);
  if (!m) {
    const type = sniffType(dir);
    if (!type) throw new Error('Not an ElectriCAD project or Arduino sketch (no electricad.json, .ino or .py): ' + dir);
    m = { name: path.basename(dir), type, fqbn: '', created: new Date().toISOString(), imported: true };
  }
  migrateManifest(dir, m);
  const recents = (settings.get('recentProjects') || []).filter((d) => d !== dir);
  recents.unshift(dir);
  settings.set({ recentProjects: recents.slice(0, 12), lastProject: dir });
  return { dir, manifest: m, tree: tree(dir) };
}

// merge fields into a project's manifest (board choice, libraries…)
function updateManifest(dir, patch) {
  const m = { ...(manifest(dir) || { name: path.basename(dir), type: 'arduino' }), ...(patch || {}) };
  fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(m, null, 2));
  return m;
}

function forget(dir) {
  settings.set({ recentProjects: (settings.get('recentProjects') || []).filter((d) => d !== dir) });
  return true;
}

function tree(dir, depth = 0) {
  if (depth > 6) return [];
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
  for (const ent of entries) {
    if (IGNORE.has(ent.name) || ent.name.endsWith('.electricad-tmp')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push({ name: ent.name, path: full, dir: true, children: tree(full, depth + 1) });
    } else {
      out.push({ name: ent.name, path: full, dir: false });
    }
  }
  return out;
}

function createFile(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (!fs.existsSync(p)) fs.writeFileSync(p, '');
  return true;
}

function renamePath(from, to) {
  if (fs.existsSync(to)) throw new Error('Already exists: ' + path.basename(to));
  fs.renameSync(from, to);
  return true;
}

function examples() {
  return EXAMPLES.map(({ id, name, type, desc, libs }) => ({ id, name, type, desc, libs }));
}

// rename the project folder and its main sketch (arduino-cli needs them to match)
function renameProject(dir, newName) {
  const safe = safeName(newName);
  if (!safe) throw new Error('give the project a name');
  const parent = path.dirname(dir);
  const to = path.join(parent, safe);
  if (path.resolve(to).toLowerCase() === path.resolve(dir).toLowerCase() && path.basename(dir) === safe) return open(dir);
  if (fs.existsSync(to) && path.resolve(to).toLowerCase() !== path.resolve(dir).toLowerCase()) throw new Error('a project called ' + safe + ' already exists');
  const oldIno = path.join(dir, path.basename(dir) + '.ino');
  if (fs.existsSync(oldIno)) fs.renameSync(oldIno, path.join(dir, safe + '.ino'));
  fs.renameSync(dir, to);
  const m = manifest(to);
  if (m) { m.name = safe; fs.writeFileSync(path.join(to, MANIFEST), JSON.stringify(m, null, 2)); }
  const fix = (list) => (list || []).map((d) => (d === dir ? to : d));
  settings.set({ recentProjects: fix(settings.get('recentProjects')), pinnedProjects: fix(settings.get('pinnedProjects')) });
  return open(to);
}

// copy a project under a new name (Save As); build output is left behind
function duplicateProject(dir, newName) {
  const root = path.dirname(dir);
  const { name: safe, dir: to } = uniqueDir(root, safeName(newName || path.basename(dir) + '_copy'));
  const SKIPDIR = new Set(['build', '.electricad-build', '.git']);
  fs.cpSync(dir, to, { recursive: true, filter: (src) => !path.relative(dir, src).split(path.sep).some((seg) => SKIPDIR.has(seg)) });
  const oldIno = path.join(to, path.basename(dir) + '.ino');
  if (fs.existsSync(oldIno)) fs.renameSync(oldIno, path.join(to, safe + '.ino'));
  const m = manifest(to);
  if (m) { m.name = safe; m.created = new Date().toISOString(); delete m.imported; fs.writeFileSync(path.join(to, MANIFEST), JSON.stringify(m, null, 2)); }
  return open(to);
}

// the project as a .zip, folder name at the top like Arduino IDE's "Archive Sketch"
function archiveProject(dir, zipPath) {
  const zip = require('./zip');
  const entries = zip.entriesFromDir(dir, path.basename(dir));
  if (!entries.length) throw new Error('the project folder is empty');
  fs.writeFileSync(zipPath, zip.build(entries));
  return { ok: true, files: entries.length, bytes: fs.statSync(zipPath).size, path: zipPath };
}

function setPinned(dir, pinned) {
  const list = (settings.get('pinnedProjects') || []).filter((d) => d !== dir);
  if (pinned) list.unshift(dir);
  settings.set({ pinnedProjects: list.slice(0, 20) });
  return list;
}

module.exports = { renameProject, duplicateProject, archiveProject, setPinned, list, create, open, tree, createFile, updateManifest, forget, renamePath, examples,
                   safeName, sniffType, createFromDir };
