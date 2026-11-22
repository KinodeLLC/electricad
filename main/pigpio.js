// Raspberry Pi live GPIO over the network, no agent install needed beyond
// `sudo systemctl enable --now pigpiod` on the Pi. We speak the pigpiod
// socket protocol directly (little-endian u32 quads: cmd, p1, p2, p3/res).
//
//   BR1 (10)  read GPIO bank 1 levels (pins 0..31) in one call
//   MODEG (1) get mode of one pin (0 in, 1 out, 4 alt0 ... )
//   WRITE (4) set level, MODES (0) set mode
//
// Poll loop: BR1 every tick (cheap), MODEG sweep once a second (28 calls).
// One TCP connection, strictly serialized — pigpiod answers in order.
const { EventEmitter } = require('events');
const net = require('net');

const emitter = new EventEmitter();

const CMD = { MODES: 0, MODEG: 1, WRITE: 4, BR1: 10, HWVER: 17 };
const PI_PINS = 28; // BCM 0..27 on the 40-pin header

let sock = null;
let queue = [];       // {resolve, reject}
let buffer = Buffer.alloc(0);
let pollTimer = null;
let modeTimer = null;
let modes = new Array(PI_PINS).fill(0);
let connected = false;

function cmd(c, p1 = 0, p2 = 0) {
  return new Promise((resolve, reject) => {
    if (!sock || !connected) return reject(new Error('not connected'));
    const b = Buffer.alloc(16);
    b.writeUInt32LE(c, 0); b.writeUInt32LE(p1, 4); b.writeUInt32LE(p2, 8); b.writeUInt32LE(0, 12);
    queue.push({ resolve, reject });
    sock.write(b);
  });
}

function onData(d) {
  buffer = Buffer.concat([buffer, d]);
  while (buffer.length >= 16) {
    const res = buffer.readInt32LE(12);
    buffer = buffer.subarray(16);
    const waiter = queue.shift();
    if (waiter) waiter.resolve(res);
  }
}

async function connect({ host, port }) {
  disconnect();
  return new Promise((resolve, reject) => {
    sock = net.createConnection({ host, port: port || 8888 }, async () => {
      connected = true;
      try {
        const hw = await cmd(CMD.HWVER);
        emitter.emit('status', { open: true, host, hwver: hw >>> 0 });
        startPolling();
        resolve({ ok: true, hwver: hw >>> 0 });
      } catch (e) { reject(e); }
    });
    sock.on('data', onData);
    sock.on('error', (e) => {
      emitter.emit('status', { open: false, error: e.message });
      if (!connected) reject(new Error(e.message));
      cleanup();
    });
    sock.on('close', () => { emitter.emit('status', { open: false }); cleanup(); });
    sock.setTimeout(5000, () => {
      if (!connected) { sock.destroy(); reject(new Error('connection timed out')); }
    });
  });
}

function startPolling() {
  // each loop is guarded so a slow link (Wi-Fi Pi, busy pigpiod) can't stack
  // up hundreds of queued requests — a tick that is still waiting is skipped
  let sweeping = false, polling = false;
  const sweepModes = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      for (let i = 0; i < PI_PINS; i++) modes[i] = await cmd(CMD.MODEG, i);
    } catch (e) {} finally { sweeping = false; }
  };
  sweepModes();
  modeTimer = setInterval(sweepModes, 1000);
  pollTimer = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      const bank = (await cmd(CMD.BR1)) >>> 0;
      let modeMask = 0n, levelMask = BigInt(bank);
      for (let i = 0; i < PI_PINS; i++) if (modes[i] === 1) modeMask |= 1n << BigInt(i);
      emitter.emit('telemetry', {
        source: 'pi',
        snap: {
          t: Date.now(),
          modeMask: modeMask.toString(16),
          outMask: (levelMask & modeMask).toString(16),
          inMask: levelMask.toString(16),
          analog: [], pwm: {}
        }
      });
    } catch (e) {} finally { polling = false; }
  }, 50); // 20 Hz
}

function cleanup() {
  connected = false;
  if (pollTimer) clearInterval(pollTimer);
  if (modeTimer) clearInterval(modeTimer);
  pollTimer = modeTimer = null;
  for (const w of queue) w.reject(new Error('disconnected'));
  queue = [];
  buffer = Buffer.alloc(0);
  sock = null;
}

function disconnect() {
  if (sock) { try { sock.destroy(); } catch (e) {} }
  cleanup();
}

function checkPin(pin) {
  const n = Number(pin);
  if (!Number.isInteger(n) || n < 0 || n >= PI_PINS) throw new Error('GPIO ' + pin + ' is not on the 40-pin header');
  return n;
}
async function write(pin, level) {
  const n = checkPin(pin);
  const r = await cmd(CMD.WRITE, n, level ? 1 : 0);
  if (r < 0) throw new Error('pigpiod refused write to GPIO' + n + ' (error ' + r + ')');
  return true;
}
async function setMode(pin, mode) {
  const n = checkPin(pin);
  const r = await cmd(CMD.MODES, n, mode === 'out' ? 1 : 0);
  if (r < 0) throw new Error('pigpiod refused mode change on GPIO' + n + ' (error ' + r + ')');
  modes[n] = mode === 'out' ? 1 : 0;
  return true;
}

module.exports = { on: emitter.on.bind(emitter), connect, disconnect, write, setMode };
