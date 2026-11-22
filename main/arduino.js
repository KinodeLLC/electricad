// Toolchain layer. arduino-cli does the heavy lifting (index, cores, libs,
// compile, upload); we bootstrap it ourselves so a fresh ElectriCAD install needs
// nothing preinstalled. Everything returns parsed JSON, and compile output is
// normalized into VS-style diagnostics for the Problems panel.
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');

const settings = require('./settings');
const coreurls = require('./coreurls');

const emitter = new EventEmitter();

const CLI_VERSION = '1.1.1';
function cliDir() { return path.join(app.getPath('userData'), 'arduino-cli'); }
function cliPath() {
  return path.join(cliDir(), process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli');
}
function cliUrl() {
  const base = `https://github.com/arduino/arduino-cli/releases/download/v${CLI_VERSION}/arduino-cli_${CLI_VERSION}_`;
  if (process.platform === 'win32') return base + 'Windows_64bit.zip';
  if (process.platform === 'darwin') return base + 'macOS_64bit.tar.gz';
  return base + 'Linux_64bit.tar.gz';
}

// Our bundled PinodeTelemetry library is copied into the sketchbook's
// libraries dir so every compile can #include it.
function sketchbookDir() { return settings.get('projectsDir'); }

function progress(step, detail) { emitter.emit('progress', { step, detail }); }

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('too many redirects'));
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, dest, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' for ' + url)); }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    }).on('error', reject);
  });
}

async function extract(archive, dir) {
  // Windows ships tar.exe since 10; it reads zips too. Everything else: tar.
  await run('tar', ['-xf', archive, '-C', dir]);
}

// every child process is tracked so a build can be cancelled, and every one
// has a timeout so a wedged arduino-cli (port held open, dead network) can
// never hang the IDE forever
const running = new Set();
let busyCount = 0;
function run(cmd, args, opts = {}) {
  const { timeoutMs = 120000, onStderr, ...spawnOpts } = opts;
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { ...spawnOpts, windowsHide: true });
    running.add(p);
    let out = '', err = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { p.kill(); } catch (e) {} }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; if (onStderr) onStderr(String(d)); });
    p.on('error', (e) => { clearTimeout(timer); running.delete(p); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      running.delete(p);
      if (timedOut) err += '\n[ElectriCAD] arduino-cli timed out after ' + Math.round(timeoutMs / 1000) + 's and was stopped.';
      if (p._cancelled) err += '\n[ElectriCAD] cancelled.';
      resolve({ code, out, err, cancelled: !!p._cancelled, timedOut });
    });
  });
}

function cancel() {
  let n = 0;
  for (const p of running) { p._cancelled = true; try { p.kill(); n++; } catch (e) {} }
  if (n) progress('ready', 'Cancelled');
  return n;
}
function isBusy() { return busyCount > 0; }
async function busy(fn) {
  busyCount++;
  try { return await fn(); } finally { busyCount--; }
}

let ensured = null;
function ensureCli() {
  if (ensured) return ensured;
  ensured = (async () => {
    fs.mkdirSync(cliDir(), { recursive: true });
    if (!fs.existsSync(cliPath())) {
      progress('download', 'Downloading arduino-cli ' + CLI_VERSION + '…');
      const archive = path.join(cliDir(), path.basename(cliUrl()));
      await download(cliUrl(), archive);
      progress('extract', 'Extracting toolchain…');
      await extract(archive, cliDir());
      try { fs.unlinkSync(archive); } catch (e) {}
      if (process.platform !== 'win32') fs.chmodSync(cliPath(), 0o755);
    }
    // config: keep everything under our dir, sketchbook = projects dir
    const cfg = path.join(cliDir(), 'arduino-cli.yaml');
    if (!fs.existsSync(cfg)) {
      fs.writeFileSync(cfg, [
        'directories:',
        '  data: ' + JSON.stringify(path.join(cliDir(), 'data')),
        '  downloads: ' + JSON.stringify(path.join(cliDir(), 'staging')),
        '  user: ' + JSON.stringify(sketchbookDir()),
        ''
      ].join('\n'));
    }
    // board-manager URLs for esp32 / esp8266 / rp2040 / adafruit / teensy —
    // injected idempotently so every family compiles, not just AVR
    let urlsChanged = false;
    try {
      const r = coreurls.ensureUrlsInYaml(fs.readFileSync(cfg, 'utf8'), settings.get('boardUrls') || []);
      if (r.changed) { fs.writeFileSync(cfg, r.text); urlsChanged = true; }
    } catch (e) { /* cfg unreadable; cli will complain loudly enough */ }
    installBundledLibrary();
    const idx = path.join(cliDir(), 'data', 'package_index.json');
    if (!fs.existsSync(idx) || urlsChanged) {
      progress('index', 'Updating board index…');
      await cli(['core', 'update-index'], { timeoutMs: 300000 });
    }
    // the AVR core covers Uno/Nano/Mega out of the box
    const avr = await cli(['core', 'list']).catch(() => null);
    const plats = (avr && avr.json && avr.json.platforms) || [];
    if (!plats.some((c) => (c.id || '') === 'arduino:avr')) {
      progress('core', 'Installing AVR core (Uno/Nano/Mega)…');
      await cli(['core', 'install', 'arduino:avr'], { timeoutMs: 600000 }).catch(() => {});
    }
    progress('ready', 'Toolchain ready');
    return { ok: true, cli: cliPath() };
  })();
  ensured.catch(() => { ensured = null; });
  return ensured;
}

function installBundledLibrary() {
  // copy library/ElectriCADTelemetry -> <sketchbook>/libraries/…, and retire
  // any old PinodeTelemetry copy (the new lib ships a PinodeTelemetry.h shim,
  // so old sketches keep compiling — but only one lib may own that header)
  try {
    const src = path.join(__dirname, '..', 'library', 'ElectriCADTelemetry');
    const dst = path.join(sketchbookDir(), 'libraries', 'ElectriCADTelemetry');
    fs.mkdirSync(dst, { recursive: true });
    fs.cpSync(src, dst, { recursive: true });
    const legacy = path.join(sketchbookDir(), 'libraries', 'PinodeTelemetry');
    if (fs.existsSync(legacy)) fs.rmSync(legacy, { recursive: true, force: true });
  } catch (e) { /* first run before projectsDir exists; retried next ensure */ }
}

async function cli(args, opts = {}) {
  await undefined; // keep stack async even on cached ensure
  const cfg = path.join(cliDir(), 'arduino-cli.yaml');
  const r = await run(cliPath(), ['--config-file', cfg, ...args, '--json'], opts);
  let parsed = null;
  try { parsed = JSON.parse(r.out); } catch (e) {}
  return { ...r, json: parsed };
}

// ---- public API ------------------------------------------------------------
async function boardList() {
  await ensureCli();
  const r = await cli(['board', 'list']);
  const ports = (r.json && (r.json.detected_ports || r.json)) || [];
  return (Array.isArray(ports) ? ports : []).map((p) => ({
    address: p.port && p.port.address,
    protocol: p.port && p.port.protocol,
    label: p.port && p.port.label,
    boards: (p.matching_boards || []).map((b) => ({ name: b.name, fqbn: b.fqbn }))
  })).filter((p) => p.address);
}

async function knownBoards() {
  await ensureCli();
  const r = await cli(['board', 'listall']);
  const list = (r.json && r.json.boards) || [];
  return list.map((b) => ({ name: b.name, fqbn: b.fqbn }));
}

async function coreList() {
  await ensureCli();
  const r = await cli(['core', 'list']);
  return (r.json && r.json.platforms) || [];
}

async function coreInstall(id) {
  await ensureCli();
  progress('core', 'Installing core ' + id + '…');
  const r = await cli(['core', 'install', id], { timeoutMs: 900000 });
  progress('ready', r.code === 0 ? 'Core installed' : 'Core install failed');
  return { ok: r.code === 0, err: r.err };
}

async function coreUninstall(id) {
  await ensureCli();
  progress('core', 'Removing core ' + id + '…');
  const r = await cli(['core', 'uninstall', id]);
  progress('ready', r.code === 0 ? 'Core removed' : 'Core removal failed');
  return { ok: r.code === 0, err: r.err };
}

async function libSearch(q) {
  await ensureCli();
  const r = await cli(['lib', 'search', q], { timeoutMs: 60000 });
  const libs = (r.json && r.json.libraries) || [];
  // arduino-cli 1.x: latest is under releases[latest_version]; 0.x: .latest
  const latestOf = (l) => l.latest || (l.releases && l.latest_version && l.releases[l.latest_version]) ||
                          (l.releases && Object.values(l.releases).pop()) || {};
  // exact / prefix name matches first — "servo" should put Servo on top
  const ql = String(q || '').toLowerCase();
  const score = (l) => {
    const n = String(l.name || '').toLowerCase();
    return n === ql ? 0 : n.startsWith(ql) ? 1 : n.includes(ql) ? 2 : 3;
  };
  return libs.slice().sort((a, b) => score(a) - score(b)).slice(0, 50).map((l) => {
    const latest = latestOf(l);
    return {
      name: l.name,
      author: latest.author,
      sentence: latest.sentence,
      version: latest.version || l.latest_version,
      website: latest.website
    };
  });
}

async function libInstall(name, version) {
  await ensureCli();
  if (version && !/^[0-9A-Za-z.+-]+$/.test(version)) throw new Error('bad version');
  const spec = version ? name + '@' + version : name;
  progress('lib', 'Installing library ' + spec + '…');
  const r = await cli(['lib', 'install', spec], { timeoutMs: 300000 });
  progress('ready', r.code === 0 ? 'Library installed' : 'Library install failed');
  return { ok: r.code === 0, err: r.err };
}

async function libUninstall(name) {
  await ensureCli();
  const r = await cli(['lib', 'uninstall', name]);
  progress('ready', r.code === 0 ? 'Library removed' : 'Library removal failed');
  return { ok: r.code === 0, err: r.err };
}

async function libList() {
  await ensureCli();
  const r = await cli(['lib', 'list']);
  const libs = (r.json && r.json.installed_libraries) || [];
  return libs.map((l) => ({
    name: l.library && l.library.name,
    version: l.library && l.library.version,
    includes: (l.library && l.library.provides_includes) || [],
    sentence: (l.library && l.library.sentence) || '',
    website: (l.library && l.library.website) || '',
    author: (l.library && l.library.author) || '',
    maintainer: (l.library && l.library.maintainer) || '',
    paragraph: (l.library && l.library.paragraph) || '',
    category: (l.library && l.library.category) || '',
    architectures: (l.library && l.library.architectures) || [],
    dir: (l.library && (l.library.install_dir || l.library.source_dir)) || '',
    location: (l.library && l.library.location) || ''
  })).filter((l) => l.name);
}

// every published version of a library, newest first
const vparts = (v) => String(v).split(/[.+-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
function cmpVersion(a, b) {
  const x = vparts(a), y = vparts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] == null ? 0 : x[i], q = y[i] == null ? 0 : y[i];
    if (p === q) continue;
    if (typeof p === 'number' && typeof q === 'number') return p - q;
    return String(p).localeCompare(String(q));
  }
  return 0;
}
async function libVersions(name) {
  await ensureCli();
  const r = await cli(['lib', 'search', name], { timeoutMs: 60000 });
  const lib = ((r.json && r.json.libraries) || []).find((l) => l.name === name);
  if (!lib) return [];
  const vs = lib.available_versions || Object.keys(lib.releases || {});
  return vs.slice().sort(cmpVersion).reverse();
}

// rewrite the yaml's board-manager list with the user's extra URLs, then
// re-download the index so their boards show up
async function applyBoardUrls() {
  await ensureCli();
  const cfg = path.join(cliDir(), 'arduino-cli.yaml');
  const r = coreurls.ensureUrlsInYaml(fs.readFileSync(cfg, 'utf8'), settings.get('boardUrls') || []);
  if (r.changed) fs.writeFileSync(cfg, r.text);
  progress('index', 'Updating board index…');
  const u = await cli(['core', 'update-index'], { timeoutMs: 300000 });
  progress('ready', u.code === 0 ? 'Board index updated' : 'Board index update failed');
  return { ok: u.code === 0, err: (u.err || '').trim() };
}

// gcc diagnostics: "/path/file.ino:12:3: error: message" (column optional,
// as the linker and some preprocessor errors omit it). Duplicates — gcc
// repeats the same error once per translation unit — are folded.
const normPath = (p) => String(p || '').replace(/\//g, '\\').toLowerCase();
function parseDiagnostics(text, sketchDir) {
  const diags = [];
  const seen = new Set();
  const re = /^(.+?):(\d+)(?::(\d+))?:\s+(fatal error|error|warning|note):\s+(.*)$/gm;
  const root = sketchDir ? normPath(sketchDir) : '';
  let m;
  while ((m = re.exec(text))) {
    const file = m[1].trim();
    const key = file + ':' + m[2] + ':' + (m[3] || 1) + ':' + m[5];
    if (seen.has(key)) continue;
    seen.add(key);
    diags.push({
      file, line: Number(m[2]), col: Number(m[3] || 1),
      severity: m[4] === 'fatal error' ? 'error' : m[4], message: m[5],
      inSketch: root ? normPath(file).startsWith(root) : true
    });
  }
  // missing library → a fix-it the IDE can offer ("Install library…")
  for (const d of diags) {
    const lib = /^([\w\-.]+)\.h: No such file or directory/.exec(d.message);
    if (lib) d.missingHeader = lib[1] + '.h';
  }
  return diags;
}

// executable_sections_size → { flash:{used,max,pct}, ram:{used,max,pct} }
function memoryUsage(sections) {
  if (!Array.isArray(sections)) return null;
  const out = {};
  for (const s of sections) {
    const name = String(s.name || '').toLowerCase();
    const key = name === 'text' || name === 'flash' ? 'flash' : name === 'data' || name === 'ram' ? 'ram' : null;
    if (!key) continue;
    const used = Number(s.size) || 0, max = Number(s.max_size) || 0;
    out[key] = { used, max, pct: max ? Math.round((used / max) * 1000) / 10 : null };
  }
  return Object.keys(out).length ? out : null;
}

// the core for this FQBN, installed on demand — detect an ESP8266, hit
// compile, and the right platform arrives by itself
async function ensureCoreFor(fqbn) {
  const id = coreurls.coreIdFromFqbn(fqbn);
  if (!id) return;
  try {
    const installed = await coreList();
    if (installed.some((c) => (c.id || '').startsWith(id))) return;
    progress('core', `Installing ${id} core (first use) — this can take a few minutes…`);
    await cli(['core', 'update-index'], { timeoutMs: 300000 });
    const r = await cli(['core', 'install', id], { timeoutMs: 900000 });
    progress('ready', r.code === 0 ? id + ' core installed' : id + ' core install failed');
  } catch (e) { /* compile will surface the real error */ }
}

function compile({ sketchDir, fqbn, warnings, exportBinaries, verbose, clean, extraFlags, defines }) {
  return busy(async () => {
    await ensureCli();
    await ensureCoreFor(fqbn);
    installBundledLibrary();
    progress('compile', 'Compiling…');
    const t0 = Date.now();
    const args = ['compile', '--fqbn', fqbn, '--warnings', warnings || 'default'];
    if (exportBinaries) args.push('--export-binaries');
    if (verbose) args.push('--verbose');
    if (clean) args.push('--clean');
    for (const bp of buildProperties(extraFlags, defines)) args.push('--build-property', bp);
    args.push(sketchDir);
    const r = await cli(args, { timeoutMs: 600000 });
    const j = r.json || {};
    const builder = j.builder_result || {};
    const text = [j.compiler_out || '', j.compiler_err || '', r.err || ''].filter(Boolean).join('\n');
    const sections = builder.executable_sections_size;
    const result = {
      ok: !r.cancelled && (j.success === true || (j.success === undefined && r.code === 0)),
      cancelled: r.cancelled,
      seconds: (Date.now() - t0) / 1000,
      diagnostics: parseDiagnostics(text, sketchDir),
      raw: text.trim(),
      size: sections,
      memory: memoryUsage(sections),
      buildPath: builder.build_path || '',
      exported: exportBinaries ? listExported(sketchDir) : []
    };
    progress('ready', result.cancelled ? 'Compile cancelled' : result.ok ? 'Compile OK' : 'Compile failed');
    return result;
  });
}

// --export-binaries drops .hex/.bin/.uf2/.elf into <sketch>/build/<fqbn dots>/
function listExported(sketchDir) {
  const out = [];
  const walk = (d, depth) => {
    let names = [];
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const n of names) {
      const p = path.join(d, n.name);
      if (n.isDirectory() && depth < 2) walk(p, depth + 1);
      else if (/\.(hex|bin|uf2|elf|eep)$/i.test(n.name)) out.push(p);
    }
  };
  walk(path.join(sketchDir, 'build'), 0);
  return out;
}

async function libUpdatable() {
  await ensureCli();
  const r = await cli(['lib', 'list', '--updatable']);
  const libs = (r.json && r.json.installed_libraries) || [];
  return libs.map((l) => ({ name: l.library && l.library.name, version: l.library && l.library.version,
    latest: l.release && l.release.version })).filter((l) => l.name);
}

async function libUpgradeAll() {
  await ensureCli();
  progress('lib', 'Updating libraries…');
  await cli(['lib', 'update-index'], { timeoutMs: 300000 });
  const r = await cli(['lib', 'upgrade'], { timeoutMs: 900000 });
  progress('ready', r.code === 0 ? 'Libraries up to date' : 'Library update failed');
  return { ok: r.code === 0, err: r.err };
}

async function coreUpgradeAll() {
  await ensureCli();
  progress('core', 'Updating board cores…');
  await cli(['core', 'update-index'], { timeoutMs: 300000 });
  const r = await cli(['core', 'upgrade'], { timeoutMs: 1800000 });
  progress('ready', r.code === 0 ? 'Cores up to date' : 'Core update failed');
  return { ok: r.code === 0, err: r.err };
}

// install a library from a .zip (Arduino IDE's "Add .ZIP Library")
async function libInstallZip(zipPath) {
  await ensureCli();
  const cfg = path.join(cliDir(), 'arduino-cli.yaml');
  try {
    const y = fs.readFileSync(cfg, 'utf8');
    if (!/enable_unsafe_install:\s*true/.test(y)) {
      fs.writeFileSync(cfg, /library:\s*\n/.test(y) ? y.replace(/library:\s*\n/, 'library:\n  enable_unsafe_install: true\n')
                                                     : y.replace(/\s*$/, '\nlibrary:\n  enable_unsafe_install: true\n'));
    }
  } catch (e) {}
  progress('lib', 'Installing ' + path.basename(zipPath) + '…');
  const r = await cli(['lib', 'install', '--zip-path', zipPath], { timeoutMs: 300000 });
  progress('ready', r.code === 0 ? 'Library installed' : 'Library install failed');
  return { ok: r.code === 0, err: r.err || r.out };
}

// per-project flags and #defines. They go into compiler.{c,cpp}.extra_flags,
// which every mainstream core (AVR, megaAVR, SAMD, ESP32, ESP8266, RP2040)
// leaves empty for the user; build.extra_flags is NOT touched because boards
// like the Leonardo keep their USB IDs there.
function buildProperties(extraFlags, defines) {
  const parts = [];
  for (const f of String(extraFlags || '').split(/\s+/).filter(Boolean)) parts.push(f);
  for (const d of defines || []) {
    const name = String(d.name || '').trim();
    if (!/^[A-Za-z_]\w*$/.test(name)) continue;
    const v = d.value == null ? '' : String(d.value).trim();
    parts.push(v === '' ? '-D' + name : '-D' + name + '=' + (/\s/.test(v) ? '"' + v.replace(/"/g, '\\"') + '"' : v));
  }
  if (!parts.length) return [];
  const flags = parts.join(' ');
  return ['compiler.c.extra_flags=' + flags, 'compiler.cpp.extra_flags=' + flags];
}

function upload({ sketchDir, fqbn, port, inputDir }) {
  return busy(async () => {
    await ensureCli();
    progress('upload', 'Uploading to ' + port + '…');
    const args = ['upload', '--fqbn', fqbn, '--port', port];
    // re-upload the last build without compiling again
    if (inputDir) { if (!fs.existsSync(inputDir)) throw new Error('the last build is gone; compile again first'); args.push('--input-dir', inputDir); }
    args.push(sketchDir);
    const r = await cli(args, { timeoutMs: 300000 });
    const ok = r.code === 0 && !r.cancelled;
    let hint = '';
    const txt = (r.err || '') + (r.out || '');
    if (!ok) {
      if (/access is denied|busy|resource busy|could not open port/i.test(txt)) {
        hint = 'The port is held by another program (Arduino IDE serial monitor, PuTTY, Cura…). Close it and retry.';
      } else if (/not in sync|stk500_recv|programmer is not responding/i.test(txt)) {
        hint = 'The bootloader did not answer: wrong board selected (Nano clones often need "ATmega328P (Old Bootloader)"), a shield on pins 0/1, or a charge-only USB cable.';
      } else if (/no device found|failed to connect to esp/i.test(txt)) {
        hint = 'ESP chip not in download mode: hold BOOT, tap EN/RST, release BOOT, then upload again.';
      }
    }
    progress('ready', ok ? 'Upload complete' : 'Upload failed');
    return { ok, cancelled: r.cancelled, hint, raw: txt.trim() };
  });
}

// ---- v0.8: board options, programmers, library examples --------------------
const baseFqbn = (fqbn) => String(fqbn || '').split(':').slice(0, 3).join(':');

// the board's menu options (Processor, CPU speed, Partition scheme, USB mode…)
// and programmers, straight from the installed core's boards.txt
async function boardDetails(fqbn) {
  await ensureCli();
  await ensureCoreFor(fqbn).catch(() => {});
  const r = await cli(['board', 'details', '-b', fqbn]);
  const d = r.json || {};
  if (!d.fqbn && !d.name) throw new Error((r.err || r.out || 'No details for ' + fqbn).trim().split('\n').pop());
  return {
    fqbn: d.fqbn || baseFqbn(fqbn), name: d.name || '', version: d.version || '',
    platform: (d.package && d.package.maintainer) || '', website: (d.package && d.package.website_url) || '',
    options: (d.config_options || []).map((o) => ({
      option: o.option, label: o.option_label || o.option,
      values: (o.values || []).map((v) => ({ value: v.value, label: v.value_label || v.value, selected: !!v.selected }))
    })),
    programmers: (d.programmers || []).map((p) => ({ id: p.id, name: p.name }))
  };
}

// examples shipped inside installed libraries (user + the board's platform)
async function libExamples(fqbn) {
  await ensureCli();
  const args = ['lib', 'examples'];
  if (fqbn) args.push('-b', baseFqbn(fqbn));
  const r = await cli(args);
  const list = (r.json && r.json.examples) || [];
  return list.filter((x) => x.library && (x.examples || []).length).map((x) => ({
    library: x.library.name, location: x.library.location || '',
    examples: x.examples.map((dir) => ({ name: path.basename(dir), dir }))
  })).sort((a, b) => a.library.localeCompare(b.library));
}

function uploadProgrammer({ sketchDir, fqbn, port, programmer }) {
  return busy(async () => {
    await ensureCli();
    progress('upload', 'Uploading with ' + programmer + '…');
    const args = ['upload', '--fqbn', fqbn, '-P', programmer, sketchDir];
    if (port) args.splice(1, 0, '--port', port);
    const r = await cli(args, { timeoutMs: 300000 });
    const ok = r.code === 0 && !r.cancelled;
    progress('ready', ok ? 'Upload complete' : 'Upload failed');
    return { ok, cancelled: r.cancelled, raw: ((r.err || '') + (r.out || '')).trim() };
  });
}

function burnBootloader({ fqbn, port, programmer }) {
  return busy(async () => {
    await ensureCli();
    await ensureCoreFor(fqbn).catch(() => {});
    progress('upload', 'Burning bootloader with ' + programmer + '…');
    const args = ['burn-bootloader', '-b', fqbn, '-P', programmer];
    if (port) args.push('--port', port);
    const r = await cli(args, { timeoutMs: 300000 });
    const ok = r.code === 0 && !r.cancelled;
    progress('ready', ok ? 'Bootloader burned' : 'Burn bootloader failed');
    return { ok, cancelled: r.cancelled, raw: ((r.err || '') + (r.out || '')).trim() };
  });
}

async function cliVersion() {
  await ensureCli();
  const r = await cli(['version']);
  return (r.json && (r.json.VersionString || r.json.version_string)) || (r.out || '').trim();
}

module.exports = {
  cliVersion, libVersions, cmpVersion, applyBoardUrls, buildProperties,
  on: emitter.on.bind(emitter),
  ensureCli, boardList, knownBoards, coreList, coreInstall, coreUninstall,
  libSearch, libInstall, libUninstall, libList, compile, upload, cancel, isBusy,
  parseDiagnostics, memoryUsage, libUpdatable, libUpgradeAll, coreUpgradeAll, libInstallZip, listExported,
  boardDetails, libExamples, uploadProgrammer, burnBootloader, baseFqbn
};
