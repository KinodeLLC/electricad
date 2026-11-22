// Serial layer — MULTI-PORT. Every detected board can be open at once, each
// with its own parser; telemetry and monitor lines are tagged with the port
// they came from. Telemetry lines (~PN1|...) are demuxed to 'telemetry',
// I2C scan reports (~PNI|...) to 'i2c'; everything else flows to the serial
// monitor — batched every 40ms so a chatty sketch can't flood the UI with
// thousands of IPC messages a second.
const { EventEmitter } = require('events');
const telemetry = require('./telemetry');

let SerialPort = null, ReadlineParser = null;
try {
  ({ SerialPort } = require('serialport'));
  ({ ReadlineParser } = require('@serialport/parser-readline'));
} catch (e) { /* surfaced on open() */ }

const emitter = new EventEmitter();
const ports = new Map(); // path -> { port, baud, pending: [], timer }

const FLUSH_MS = 40;
const MAX_PENDING = 2000; // lines buffered per flush before old ones are dropped

async function listPorts() {
  if (!SerialPort) return [];
  const list = await SerialPort.list();
  return list.map((p) => ({
    path: p.path,
    manufacturer: p.manufacturer || '',
    serialNumber: p.serialNumber || '',
    vendorId: p.vendorId || '',
    productId: p.productId || '',
    friendly: p.friendlyName || p.path,
    open: ports.has(p.path)
  }));
}

function statusEvent() {
  emitter.emit('status', {
    open: [...ports.keys()],
    bauds: Object.fromEntries([...ports].map(([k, v]) => [k, v.baud])),
    count: ports.size
  });
}

function queueLine(portPath, line) {
  const e = ports.get(portPath);
  if (!e) return;
  e.pending.push({ line, ts: Date.now() });
  if (e.pending.length > MAX_PENDING) {
    const dropped = e.pending.length - MAX_PENDING;
    e.pending.splice(0, dropped);
    e.dropped = (e.dropped || 0) + dropped;
  }
  if (!e.timer) e.timer = setTimeout(() => flush(portPath), FLUSH_MS);
}

function flush(portPath) {
  const e = ports.get(portPath);
  if (!e) return;
  e.timer = null;
  if (!e.pending.length) return;
  const lines = e.pending;
  e.pending = [];
  if (e.dropped) {
    lines.unshift({ line: `⚠ ${e.dropped} lines dropped — the sketch is printing faster than the monitor can show`, ts: Date.now(), meta: true });
    e.dropped = 0;
  }
  emitter.emit('data', { port: portPath, lines });
}

// MicroPython's raw REPL speaks in control bytes (\x04 ends each reply);
// they'd render as garbage boxes, so the monitor never sees them
// ESC (\x1b) is kept: ANSI colour codes are rendered by the monitor
const CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g;

function handleLine(portPath, raw) {
  const line = raw.replace(/\r$/, '').replace(CTRL, '');
  const split = telemetry.splitLine(line);
  if (split.text) queueLine(portPath, split.text);
  if (split.telemetry) {
    const snap = telemetry.parseLine(split.telemetry);
    if (snap) emitter.emit('telemetry', { source: 'serial', port: portPath, snap: telemetry.serialize(snap) });
  }
  if (split.i2c) {
    const scan = telemetry.parseI2c(split.i2c);
    if (scan) emitter.emit('i2c', { port: portPath, ...scan });
  }
}

function open({ path: portPath, baud }) {
  if (!SerialPort) return Promise.reject(new Error('serialport module not available — run npm install'));
  if (ports.has(portPath)) return Promise.resolve({ ok: true, already: true });
  const rate = Number(baud) || 115200;
  return new Promise((resolve, reject) => {
    const port = new SerialPort({ path: portPath, baudRate: rate }, (err) => {
      if (err) return reject(new Error(portPath + ': ' + friendlyError(err.message)));
      ports.set(portPath, { port, baud: rate, pending: [], timer: null });
      statusEvent();
      resolve({ ok: true });
    });
    const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));
    // raw byte taps (MicroPython raw REPL waits on prompts that never end a line)
    port.on('data', (chunk) => {
      const e = ports.get(portPath);
      if (e && e.taps) for (const fn of e.taps) { try { fn(chunk); } catch (err) {} }
    });
    parser.on('data', (line) => handleLine(portPath, line));
    port.on('close', () => {
      flush(portPath);
      const e = ports.get(portPath);
      if (e && e.port === port) { if (e.timer) clearTimeout(e.timer); ports.delete(portPath); }
      statusEvent();
    });
    port.on('error', (e) => {
      emitter.emit('data', { port: portPath, lines: [{ line: '⚠ ' + friendlyError(e.message), ts: Date.now(), meta: true }] });
      const ent = ports.get(portPath);
      if (ent && ent.port === port) ports.delete(portPath);
      statusEvent();
    });
  });
}

function friendlyError(msg) {
  if (/access denied|access is denied/i.test(msg)) {
    return msg + ' — another program has this port open (Arduino IDE, a terminal, Cura…). Close it and try again.';
  }
  if (/file not found|cannot find the file|no such file/i.test(msg)) {
    return msg + ' — the device was unplugged or re-enumerated on a new port.';
  }
  return msg;
}

function close(portPath) {
  const shut = (e) => new Promise((resolve) => {
    if (e.timer) clearTimeout(e.timer);
    try { e.port.close(() => resolve()); } catch (err) { resolve(); }
    setTimeout(resolve, 800); // never wait forever on a dead handle
  });
  let waits = [];
  if (portPath) {
    const e = ports.get(portPath);
    if (e) { waits.push(shut(e)); ports.delete(portPath); }
  } else {
    waits = [...ports.values()].map(shut);
    ports.clear();
  }
  statusEvent();
  // resolve only once the OS handle is really released — upload needs it free
  return Promise.all(waits).then(() => true);
}

const ENDINGS = { none: '', lf: '\n', cr: '\r', crlf: '\r\n' };

function writeLine(portPath, line, ending) {
  // one-port convenience: if no path given and exactly one port open, use it
  if (!portPath && ports.size === 1) portPath = [...ports.keys()][0];
  const e = ports.get(portPath);
  if (!e) throw new Error('serial port not open: ' + (portPath || '(none)'));
  const end = ENDINGS[ending] !== undefined ? ENDINGS[ending] : '\n';
  e.port.write(String(line) + end);
  return true;
}

async function setBaud(portPath, baud) {
  const e = ports.get(portPath);
  if (!e) return { ok: false, error: 'port not open' };
  const rate = Number(baud) || 115200;
  await new Promise((resolve, reject) => e.port.update({ baudRate: rate }, (err) => err ? reject(err) : resolve()));
  e.baud = rate;
  statusEvent();
  return { ok: true };
}

// Reset the board the way each family expects, in one sequence that is safe
// for both: AVR auto-reset caps fire on DTR asserting; ESP auto-reset
// circuits (cross-coupled DTR/RTS → IO0/EN) reset on RTS alone and boot
// normally when both are released together (esptool's "hard reset").
async function resetBoard(portPath) {
  if (!portPath && ports.size === 1) portPath = [...ports.keys()][0];
  const e = ports.get(portPath);
  if (!e) throw new Error('serial port not open: ' + (portPath || '(none)'));
  const set = (o) => new Promise((resolve) => e.port.set(o, () => resolve()));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await set({ dtr: true, rts: false });   // AVR: reset pulse through the cap
  await wait(60);
  await set({ dtr: false, rts: false });
  await wait(20);
  await set({ dtr: false, rts: true });   // ESP: EN held low
  await wait(110);
  await set({ dtr: false, rts: false });  // ESP: release with IO0 high → run
  return true;
}

// drive DTR / RTS by hand (ESP32 boot strapping, holding a board in reset)
async function setSignals(portPath, sig) {
  if (!portPath && ports.size === 1) portPath = [...ports.keys()][0];
  const e = ports.get(portPath);
  if (!e) throw new Error('serial port not open: ' + (portPath || '(none)'));
  const o = {};
  if (typeof sig.dtr === 'boolean') o.dtr = sig.dtr;
  if (typeof sig.rts === 'boolean') o.rts = sig.rts;
  await new Promise((resolve, reject) => e.port.set(o, (err) => (err ? reject(err) : resolve())));
  e.signals = { ...(e.signals || {}), ...o };
  return e.signals;
}

function openPorts() { return [...ports.keys()]; }

function writeRaw(portPath, data) {
  if (!portPath && ports.size === 1) portPath = [...ports.keys()][0];
  const e = ports.get(portPath);
  if (!e) return Promise.reject(new Error('serial port not open: ' + (portPath || '(none)')));
  return new Promise((resolve, reject) => {
    e.port.write(data, (err) => (err ? reject(err) : e.port.drain(() => resolve(true))));
  });
}

function tap(portPath, fn) {
  const e = ports.get(portPath);
  if (!e) throw new Error('serial port not open: ' + (portPath || '(none)'));
  e.taps = e.taps || new Set();
  e.taps.add(fn);
  return () => e.taps.delete(fn);
}

function isOpen(portPath) { return ports.has(portPath); }

module.exports = {
  on: emitter.on.bind(emitter),
  listPorts, open, close, writeLine, setBaud, resetBoard, setSignals, openPorts, writeRaw, tap, isOpen,
  _handleLine: handleLine
};
