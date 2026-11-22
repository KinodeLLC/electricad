// MicroPython + CircuitPython boards. Everything goes over the same serial
// port the monitor uses, through MicroPython's raw REPL:
//   Ctrl-C Ctrl-C (stop the running program) → Ctrl-A (raw REPL, prompt ">")
//   → code + Ctrl-D → board answers "OK" <stdout> \x04 <stderr> \x04 ">"
//   → Ctrl-B back to the friendly REPL.
// Files are written in small chunks (the raw REPL input buffer is small on
// ESP8266/SAMD) and each chunk waits for its reply, like mpremote does.
// CircuitPython mounts as a USB drive (CIRCUITPY) and makes its filesystem
// read-only to code while mounted, so "upload" there copies code.py to the
// drive instead; the drive is found by its boot_out.txt.
const fs = require('fs');
const path = require('path');
const bridge = require('./serialbridge');

const CTRL_A = '\x01', CTRL_B = '\x02', CTRL_C = '\x03', CTRL_D = '\x04';
const CHUNK = 192;

// ---- pure helpers (tested) --------------------------------------------------
// bytes → a python bytes literal that survives any content
function pyBytes(buf) {
  let s = "b'";
  for (const b of buf) {
    if (b === 0x5c) s += '\\\\';
    else if (b === 0x27) s += "\\'";
    else if (b >= 0x20 && b < 0x7f) s += String.fromCharCode(b);
    else if (b === 0x0a) s += '\\n';
    else s += '\\x' + b.toString(16).padStart(2, '0');
  }
  return s + "'";
}
const pyStr = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";

// the statements that write a file, one exec per chunk
function writeFileScript(name, content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  const steps = [`f=open(${pyStr(name)},'wb')\nw=f.write`];
  for (let i = 0; i < buf.length; i += CHUNK) steps.push(`w(${pyBytes(buf.subarray(i, i + CHUNK))})`);
  steps.push('f.close()');
  return steps;
}

// parse one raw-REPL reply: "OK" out \x04 err \x04 ">"
function parseReply(text) {
  const i = text.indexOf('OK');
  if (i < 0) return null;
  const rest = text.slice(i + 2);
  const a = rest.indexOf(CTRL_D);
  if (a < 0) return null;
  const b = rest.indexOf(CTRL_D, a + 1);
  if (b < 0) return null;
  return { out: rest.slice(0, a), err: rest.slice(a + 1, b) };
}

// ---- raw REPL session -------------------------------------------------------
function waitFor(port, pred, ms) {
  return new Promise((resolve, reject) => {
    let acc = '';
    const untap = bridge.tap(port, (chunk) => {
      acc += chunk.toString('latin1');
      const r = pred(acc);
      if (r) { clearTimeout(t); untap(); resolve(r); }
    });
    const t = setTimeout(() => { untap(); reject(new Error('board did not answer (is it running MicroPython, and is the baud 115200?)')); }, ms);
  });
}

let busy = false;
async function session(port, fn, opts = {}) {
  if (busy) throw new Error('another board operation is still running');
  if (!bridge.isOpen(port)) throw new Error('open the board\'s serial port first');
  busy = true;
  try {
    const ready = waitFor(port, (s) => /raw REPL; CTRL-B to exit\r?\n>/.test(s), 4000);
    await bridge.writeRaw(port, CTRL_C + CTRL_C);
    await new Promise((r) => setTimeout(r, 120));
    await bridge.writeRaw(port, '\r' + CTRL_A);
    await ready;
    const exec = async (code, ms = 10000) => {
      const reply = waitFor(port, (s) => parseReply(s), ms);
      await bridge.writeRaw(port, code + CTRL_D);
      return reply;
    };
    return await fn(exec);
  } finally {
    if (!opts.stayRaw) { try { await bridge.writeRaw(port, CTRL_B); } catch (e) {} }
    busy = false;
  }
}

// run code once (not saved). Most board programs loop forever, so this
// returns as soon as the board accepts the code ("OK"); everything it prints
// (and any traceback) streams into the serial monitor. Stop = interrupt().
async function run(port, code) {
  return session(port, async () => {
    const accepted = waitFor(port, (s) => ((s.includes('OK') || s.includes(CTRL_D)) ? s : null), 5000);
    await bridge.writeRaw(port, code + CTRL_D);
    const s = await accepted;
    if (!s.includes('OK')) throw new Error('the board rejected the code');
    return { ok: true, started: true };
  }, { stayRaw: true });
}

async function upload(port, name, content) {
  return session(port, async (exec) => {
    for (const step of writeFileScript(name, content)) {
      const r = await exec(step, 8000);
      if (r.err) {
        if (/EROFS|Errno 30|read-only/i.test(r.err)) throw new Error('the board\'s filesystem is read-only from code. On CircuitPython, copy to the CIRCUITPY drive instead.');
        throw new Error(r.err.trim().split('\n').pop());
      }
    }
    const v = await exec(`import os\nprint(os.stat(${pyStr(name)})[6])`);
    const size = parseInt(v.out, 10);
    const want = Buffer.byteLength(String(content), 'utf8');
    if (size !== want) throw new Error(`wrote ${size} bytes, expected ${want}`);
    return { ok: true, bytes: size };
  });
}

async function listFiles(port) {
  return session(port, async (exec) => {
    const r = await exec("import os\nfor n in os.listdir():\n  s=os.stat(n)\n  print(n, s[0] & 0x4000 and -1 or s[6])");
    if (r.err) throw new Error(r.err.trim().split('\n').pop());
    return r.out.split(/\r?\n/).filter(Boolean).map((l) => {
      const i = l.lastIndexOf(' ');
      const size = Number(l.slice(i + 1));
      return { name: l.slice(0, i), dir: size < 0, size: size < 0 ? 0 : size };
    });
  });
}

async function readFile(port, name) {
  return session(port, async (exec) => {
    const r = await exec(`f=open(${pyStr(name)},'rb')\nimport sys\nwhile True:\n  b=f.read(256)\n  if not b: break\n  sys.stdout.write(b.hex())\nf.close()`, 20000);
    if (r.err) throw new Error(r.err.trim().split('\n').pop());
    return Buffer.from(r.out.trim(), 'hex').toString('utf8');
  });
}

// raw bytes as base64 (binary-safe: images, .mpy, fonts)
async function readFileB64(port, name) {
  return session(port, async (exec) => {
    const r = await exec(`f=open(${pyStr(name)},'rb')\nimport sys\nwhile True:\n  b=f.read(256)\n  if not b: break\n  sys.stdout.write(b.hex())\nf.close()`, 30000);
    if (r.err) throw new Error(r.err.trim().split('\n').pop());
    return Buffer.from(r.out.trim(), 'hex').toString('base64');
  });
}

// set the board's RTC to a given local time (MicroPython machine.RTC, or
// CircuitPython rtc.RTC); weekday is Monday = 0 on both
function clockScript(d) {
  const Y = d.getFullYear(), M = d.getMonth() + 1, D = d.getDate(), h = d.getHours(), m = d.getMinutes(), s = d.getSeconds();
  const wd = (d.getDay() + 6) % 7;
  return `try:\n import machine\n machine.RTC().datetime((${Y},${M},${D},${wd},${h},${m},${s},0))\n` +
         `except ImportError:\n import rtc,time\n rtc.RTC().datetime=time.struct_time((${Y},${M},${D},${h},${m},${s},${wd},-1,-1))\n` +
         `import time\nprint(time.localtime())`;
}
async function setClock(port, when) {
  return session(port, async (exec) => {
    const r = await exec(clockScript(when ? new Date(when) : new Date()));
    if (r.err) throw new Error(r.err.trim().split('\n').pop());
    return { ok: true, now: r.out.trim() };
  });
}

async function removeFile(port, name) {
  return session(port, async (exec) => {
    const r = await exec(`import os\nos.remove(${pyStr(name)})`);
    if (r.err) throw new Error(r.err.trim().split('\n').pop());
    return { ok: true };
  });
}

async function info(port) {
  return session(port, async (exec) => {
    const r = await exec("import sys\nprint(sys.implementation.name)\nprint(sys.version)\nprint(getattr(sys.implementation,'_machine',sys.platform))\n" +
      "try:\n import gc\n gc.collect()\n print(gc.mem_free())\nexcept Exception:\n print(-1)\n" +
      "try:\n import os\n s=os.statvfs('/')\n print(s[0]*s[3])\n print(s[0]*s[2])\nexcept Exception:\n print(-1)\n print(-1)");
    const [impl, version, machine, ram, free, total] = r.out.split(/\r?\n/);
    const n = (x) => (Number(x) >= 0 ? Number(x) : null);
    return { impl: impl || '', version: version || '', machine: machine || '',
             ramFree: n(ram), flashFree: n(free), flashTotal: n(total) };
  });
}

async function mkdir(port, name) {
  return session(port, async (exec) => {
    const r = await exec(`import os\nos.mkdir(${pyStr(name)})`);
    if (r.err) {
      if (/EEXIST|Errno 17/.test(r.err)) throw new Error(name + ' already exists on the board');
      throw new Error(r.err.trim().split('\n').pop());
    }
    return { ok: true };
  });
}

// compile() on the board itself: catches syntax errors with the board's own
// parser before a broken main.py replaces a working one. Ports built without
// compile() say so and the upload goes ahead unchecked.
function syntaxScript(name, code) {
  return `try:\n compile(${pyBytes(Buffer.from(String(code), 'utf8'))}.decode(),${pyStr(name)},'exec')\n print('SYNTAX-OK')\n` +
         `except SyntaxError as e:\n print('SYNTAX-ERR', getattr(e,'lineno',None) or (e.args[1][1] if len(e.args)>1 and e.args[1] else 0), e.args[0] if e.args else e)\n` +
         `except NameError:\n print('SYNTAX-NA')`;
}
function parseSyntax(out) {
  const t = String(out || '');
  if (/SYNTAX-OK/.test(t)) return { ok: true };
  if (/SYNTAX-NA/.test(t)) return { ok: true, unchecked: true };
  const m = /SYNTAX-ERR (\S+) (.*)/.exec(t);
  if (m) return { ok: false, line: Number(m[1]) || 0, message: m[2].trim() };
  return { ok: true, unchecked: true };
}
async function syntaxCheck(port, name, code) {
  return session(port, async (exec) => {
    const r = await exec(syntaxScript(name, code), 15000);
    if (r.err && /MemoryError/.test(r.err)) return { ok: true, unchecked: true, note: 'too big to check on the board' };
    if (r.err && !r.out) return { ok: true, unchecked: true };
    return parseSyntax(r.out);
  });
}

// interrupt (Ctrl-C) and soft reboot (Ctrl-D in the friendly REPL)
const interrupt = (port) => bridge.writeRaw(port, CTRL_C + CTRL_C).then(() => new Promise((r) => setTimeout(r, 80)))
  .then(() => bridge.writeRaw(port, CTRL_B)).then(() => true);
const softReset = (port) => bridge.writeRaw(port, CTRL_C + CTRL_C + CTRL_B + CTRL_D).then(() => true);

// ---- CircuitPython drive -----------------------------------------------------
function circuitpyDrives() {
  const out = [];
  const letters = process.platform === 'win32' ? 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => l + ':\\') : [];
  const unixRoots = process.platform === 'win32' ? [] :
    ['/media', '/run/media', '/Volumes'].flatMap((r) => {
      try { return fs.readdirSync(r).flatMap((u) => { const p = path.join(r, u); try { return fs.readdirSync(p).map((v) => path.join(p, v)).concat(p); } catch (e) { return [p]; } }); } catch (e) { return []; }
    });
  for (const root of letters.concat(unixRoots)) {
    try {
      const boot = path.join(root, 'boot_out.txt');
      if (!fs.existsSync(boot)) continue;
      const txt = fs.readFileSync(boot, 'utf8');
      const m = /Adafruit CircuitPython ([^\s;]+)[^;]*;\s*([^\r\n]+?)(?: with ([^\r\n]+))?\r?\n/.exec(txt);
      out.push({ root, version: m ? m[1] : '', board: m ? m[2].trim() : '', chip: m && m[3] ? m[3].trim() : '',
                 hasCode: fs.existsSync(path.join(root, 'code.py')) });
    } catch (e) {}
  }
  return out;
}

function copyToDrive(root, name, content) {
  const dst = path.join(root, name);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, content);
  return { ok: true, path: dst };
}

// copy a project folder (lib/, fonts, assets) onto CIRCUITPY, only files
// whose size or date differ, so a 2 MB lib folder isn't rewritten every time
function copyDirToDrive(root, srcDir, sub) {
  const from = path.join(srcDir, sub), to = path.join(root, sub);
  if (!fs.existsSync(from)) return { ok: true, copied: 0, skipped: 0, missing: true };
  let copied = 0, skipped = 0;
  const walk = (a, b) => {
    fs.mkdirSync(b, { recursive: true });
    for (const ent of fs.readdirSync(a, { withFileTypes: true })) {
      if (ent.name === '__pycache__' || ent.name.startsWith('.')) continue;
      const pa = path.join(a, ent.name), pb = path.join(b, ent.name);
      if (ent.isDirectory()) { walk(pa, pb); continue; }
      const sa = fs.statSync(pa);
      let same = false;
      try { const sb = fs.statSync(pb); same = sb.size === sa.size && sb.mtimeMs >= sa.mtimeMs - 2000; } catch (e) {}
      if (same) { skipped++; continue; }
      fs.copyFileSync(pa, pb);
      copied++;
    }
  };
  walk(from, to);
  return { ok: true, copied, skipped };
}

module.exports = { run, upload, listFiles, readFile, readFileB64, setClock, clockScript, removeFile, info, interrupt, softReset,
  circuitpyDrives, copyToDrive, copyDirToDrive, mkdir, syntaxCheck, syntaxScript, parseSyntax, pyBytes, pyStr, writeFileScript, parseReply };
