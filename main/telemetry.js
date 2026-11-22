// ElectriCADTelemetry wire format parser. The Arduino library emits one
// compact line per tick so the stream stays human-openable in any serial
// monitor:
//
//   ~PN1|t=123456|m=3FFF|o=0A31|d=0A31|u=0004|a=512,17,0,1023,88,3|p=9:128,10:64
//
//   t  millis
//   m  mode mask     (bit set = pin is OUTPUT)     hex, LSB = pin 0
//   o  output latch  (PORTx values for outputs)    hex
//   d  digital reads (PINx values, all pins)       hex
//   u  pull-up mask  (input with internal pull-up) hex   (v0.6+, optional)
//   a  analog reads A0..A5 (or more), decimal csv
//   p  pwm duty per active pwm pin, pin:val csv (0-255)
//   n  NeoPixels registered with ELECTRICAD_NEOPIXEL: <data pin>:RRGGBB,...
//      as shown (brightness applied)                             (v0.9.5+)
//   x  UNO R4 WiFi LED matrix framebuffer, 12 bytes as 24 hex digits,
//      bit i = pixel i, row by row from the top-left              (v0.9.5+)
//
// I2C scans arrive as their own line:  ~PNI|n=2|a=3C,76   (7-bit hex addrs)
//
// ESP32 sends the same shape with more mask bits. Parsing is tolerant: any
// missing field is simply absent from the snapshot, and a marker that lands
// mid-line (a Serial.print without newline right before the tick) is split
// off cleanly — the text half still reaches the serial monitor.
const TELE = '~PN1|';
const I2C = '~PNI|';

function splitLine(line) {
  const out = { text: '', telemetry: null, i2c: null };
  let s = String(line || '');
  const ti = s.indexOf(TELE);
  const ii = s.indexOf(I2C);
  const at = [ti, ii].filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (at === undefined) { out.text = s; return out; }
  out.text = s.slice(0, at);
  const rest = s.slice(at);
  if (rest.startsWith(TELE)) {
    // a second marker on the same line means the first was torn — keep the last
    const again = rest.lastIndexOf(TELE);
    out.telemetry = rest.slice(again);
  } else out.i2c = rest;
  return out;
}

function parseLine(line) {
  if (!line || !line.startsWith(TELE)) return null;
  const snap = { t: 0, modeMask: 0n, outMask: 0n, inMask: 0n, pullMask: 0n, hasPull: false, analog: [], pwm: {} };
  for (const part of line.slice(TELE.length).split('|')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i);
    const val = part.slice(i + 1).trim();
    try {
      if (key === 't') snap.t = Number(val) || 0;
      else if (key === 'm') snap.modeMask = hex(val);
      else if (key === 'o') snap.outMask = hex(val);
      else if (key === 'd') snap.inMask = hex(val);
      else if (key === 'u') { snap.pullMask = hex(val); snap.hasPull = true; }
      else if (key === 'a') snap.analog = val ? val.split(',').map((n) => (n.trim() === '' ? null : Number(n) || 0)) : [];
      else if (key === 'n') {
        const [pin, list] = val.split(':');
        if (pin !== '' && list !== undefined && /^\d+$/.test(pin)) {
          snap.neopixel = { pin: Number(pin), colors: list.split(',').filter((h) => /^[0-9a-fA-F]{1,6}$/.test(h)).map((h) => parseInt(h, 16)).slice(0, 64) };
        }
      }
      else if (key === 'x') {
        if (/^[0-9a-fA-F]{24}$/.test(val)) snap.matrix = val.match(/../g).map((h) => parseInt(h, 16));
      }
      else if (key === 'p') {
        for (const pair of val.split(',')) {
          const [pin, duty] = pair.split(':');
          if (pin !== undefined && duty !== undefined && pin !== '') snap.pwm[Number(pin)] = Number(duty) || 0;
        }
      }
    } catch (e) { /* tolerate a torn line */ }
  }
  return snap;
}

function hex(val) {
  if (!/^[0-9a-fA-F]+$/.test(val)) throw new Error('bad hex');
  return BigInt('0x' + val);
}

function parseI2c(line) {
  if (!line || !line.startsWith(I2C)) return null;
  const out = { addresses: [], ts: Date.now() };
  for (const part of line.slice(I2C.length).split('|')) {
    const [k, v] = part.split('=');
    if (k === 'a' && v) {
      out.addresses = v.split(',').map((h) => parseInt(h, 16)).filter((n) => Number.isFinite(n) && n >= 0 && n < 128);
    } else if (k === 'e' && v) out.error = v;
  }
  return out;
}

// BigInt doesn't survive structured clone into the renderer; ship hex strings.
function serialize(snap) {
  const s = {
    t: snap.t,
    modeMask: snap.modeMask.toString(16),
    outMask: snap.outMask.toString(16),
    inMask: snap.inMask.toString(16),
    analog: snap.analog,
    pwm: snap.pwm
  };
  if (snap.neopixel) s.neopixel = snap.neopixel;
  if (snap.matrix) s.matrix = snap.matrix;
  if (snap.hasPull) s.pullMask = snap.pullMask.toString(16);
  return s;
}

// Expand a snapshot into per-pin states the renderer can paint directly.
// digitalCount = how many digital pins the board view cares about.
function pinStates(snap, digitalCount) {
  const pins = [];
  for (let i = 0; i < digitalCount; i++) {
    const bit = 1n << BigInt(i);
    const isOut = (snap.modeMask & bit) !== 0n;
    const level = isOut ? (snap.outMask & bit) !== 0n : (snap.inMask & bit) !== 0n;
    const st = {
      pin: i,
      mode: snap.pwm[i] !== undefined ? 'pwm' : (isOut ? 'out' : 'in'),
      level: level ? 1 : 0,
      pwm: snap.pwm[i]
    };
    if (!isOut && snap.pullMask && (snap.pullMask & bit) !== 0n) st.pull = 'up';
    pins.push(st);
  }
  return pins;
}

module.exports = { parseLine, parseI2c, splitLine, serialize, pinStates };
