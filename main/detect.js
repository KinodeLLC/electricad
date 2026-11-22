// Device detection engine. Continuously discovers EVERYTHING attached:
// every serial board at once (arduino-cli identification first, USB VID/PID
// fingerprints for the clones and bare chips arduino-cli can't name), plus
// Raspberry Pis on the network (pigpiod probe). Emits the full device list
// on every change; the renderer shows them all simultaneously.
const { EventEmitter } = require('events');
const net = require('net');

const emitter = new EventEmitter();

// USB fingerprints. vid:pid (lowercase hex, no 0x) -> identity.
// boardId picks the live board view; fqbn is a best-guess compile target.
const USB_IDS = {
  // genuine Arduino
  '2341:0043': { name: 'Arduino Uno R3', boardId: 'uno', fqbn: 'arduino:avr:uno', chip: 'ATmega328P' },
  '2341:0001': { name: 'Arduino Uno', boardId: 'uno', fqbn: 'arduino:avr:uno', chip: 'ATmega328P' },
  '2341:0243': { name: 'Arduino Uno (clone bootloader)', boardId: 'uno', fqbn: 'arduino:avr:uno', chip: 'ATmega328P' },
  '2341:0042': { name: 'Arduino Mega 2560', boardId: 'mega', fqbn: 'arduino:avr:mega', chip: 'ATmega2560' },
  '2341:0010': { name: 'Arduino Mega', boardId: 'mega', fqbn: 'arduino:avr:mega', chip: 'ATmega2560' },
  '2341:0044': { name: 'Arduino Mega 2560 (DFU)', boardId: 'mega', fqbn: 'arduino:avr:mega', chip: 'ATmega2560' },
  '2a03:0042': { name: 'Arduino Mega 2560 (org)', boardId: 'mega', fqbn: 'arduino:avr:mega', chip: 'ATmega2560' },
  '2a03:0043': { name: 'Arduino Uno (org)', boardId: 'uno', fqbn: 'arduino:avr:uno', chip: 'ATmega328P' },
  '2341:003d': { name: 'Arduino Due (programming)', boardId: 'mega', fqbn: 'arduino:sam:arduino_due_x_dbg', chip: 'SAM3X8E' },
  '2341:003e': { name: 'Arduino Due (native)', boardId: 'mega', fqbn: 'arduino:sam:arduino_due_x', chip: 'SAM3X8E' },
  '2341:804d': { name: 'Arduino Zero', boardId: 'nano', fqbn: 'arduino:samd:arduino_zero_native', chip: 'SAMD21' },
  '2341:8054': { name: 'Arduino MKR WiFi 1010', boardId: 'nano', fqbn: 'arduino:samd:mkrwifi1010', chip: 'SAMD21' },
  '2341:8052': { name: 'Arduino MKR GSM 1400', boardId: 'nano', fqbn: 'arduino:samd:mkrgsm1400', chip: 'SAMD21' },
  '2341:804e': { name: 'Arduino MKR Zero', boardId: 'nano', fqbn: 'arduino:samd:mkrzero', chip: 'SAMD21' },
  '2341:0266': { name: 'Arduino GIGA R1 WiFi', boardId: 'mega', fqbn: 'arduino:mbed_giga:giga', chip: 'STM32H747' },
  '2341:056b': { name: 'Arduino Nano ESP32', boardId: 'esp32', fqbn: 'arduino:esp32:nano_nora', chip: 'ESP32-S3' },
  '2341:0070': { name: 'Arduino UNO R4 Minima', boardId: 'uno', fqbn: 'arduino:renesas_uno:minima', chip: 'RA4M1' },
  '2341:1002': { name: 'Arduino UNO R4 WiFi', boardId: 'uno', fqbn: 'arduino:renesas_uno:unor4wifi', chip: 'RA4M1' },
  '2341:8036': { name: 'Arduino Leonardo', boardId: 'leonardo', fqbn: 'arduino:avr:leonardo', chip: 'ATmega32u4' },
  '2341:8037': { name: 'Arduino Micro', boardId: 'nano', fqbn: 'arduino:avr:micro', chip: 'ATmega32u4' },
  '2341:0058': { name: 'Arduino Nano Every', boardId: 'nanoevery', fqbn: 'arduino:megaavr:nona4809', chip: 'ATmega4809' },
  '2341:805a': { name: 'Arduino Nano 33 BLE', boardId: 'nano', fqbn: 'arduino:mbed_nano:nano33ble', chip: 'nRF52840' },
  '2341:8057': { name: 'Arduino Nano 33 IoT', boardId: 'nano', fqbn: 'arduino:samd:nano_33_iot', chip: 'SAMD21' },
  // usb-serial bridge chips — the whole clone universe
  '1a86:7523': { name: 'CH340 device (Nano clone / dev board)', boardId: 'nano', fqbn: 'arduino:avr:nano', chip: 'CH340 bridge' },
  '1a86:55d4': { name: 'CH9102 device (ESP32 dev board)', boardId: 'esp32', fqbn: 'esp32:esp32:esp32', chip: 'CH9102 bridge' },
  '10c4:ea60': { name: 'CP210x device (ESP32/ESP8266 dev board)', boardId: 'esp32', fqbn: 'esp32:esp32:esp32', chip: 'CP210x bridge' },
  '0403:6001': { name: 'FTDI FT232 device', boardId: 'nano', fqbn: 'arduino:avr:nano', chip: 'FT232 bridge' },
  '0403:6015': { name: 'FTDI FT231X device', boardId: 'nano', fqbn: 'arduino:avr:nano', chip: 'FT231X bridge' },
  // espressif native usb
  '303a:1001': { name: 'ESP32-S3/C3 (native USB)', boardId: 'esp32', fqbn: 'esp32:esp32:esp32s3', chip: 'ESP32-S3' },
  '303a:0002': { name: 'ESP32-S2 (native USB)', boardId: 'esp32', fqbn: 'esp32:esp32:esp32s2', chip: 'ESP32-S2' },
  // raspberry pi pico family
  '2e8a:0005': { name: 'Raspberry Pi Pico (MicroPython)', boardId: 'pico', fqbn: 'rp2040:rp2040:rpipico', chip: 'RP2040' },
  '2e8a:000a': { name: 'Raspberry Pi Pico (C/C++ SDK)', boardId: 'pico', fqbn: 'rp2040:rp2040:rpipico', chip: 'RP2040' },
  '2e8a:000f': { name: 'Raspberry Pi Pico W', boardId: 'pico', fqbn: 'rp2040:rp2040:rpipicow', chip: 'RP2040+CYW43' },
  '2e8a:00c0': { name: 'Raspberry Pi Pico 2', boardId: 'pico', fqbn: 'rp2040:rp2040:rpipico2', chip: 'RP2350' },
  // esp8266 boards (nodemcu/wemos usually enumerate as their bridge chip;
  // CP2102/CH340 entries above catch them — cli identification refines)
  '1a86:5523': { name: 'CH341 device', boardId: 'nodemcu', fqbn: 'esp8266:esp8266:nodemcuv2', chip: 'CH341 bridge' },
  // others commonly on the bench
  '16c0:0483': { name: 'Teensy', boardId: 'nano', fqbn: 'teensy:avr:teensy41', chip: 'Teensy' },
  '16c0:0478': { name: 'Teensy (bootloader)', boardId: 'nano', fqbn: '', chip: 'Teensy HalfKay' },
  '0483:5740': { name: 'STM32 (CDC)', boardId: 'nano', fqbn: 'STMicroelectronics:stm32:GenF4', chip: 'STM32' },
  '0483:374b': { name: 'ST-LINK/V2-1 (Nucleo)', boardId: 'nano', fqbn: '', chip: 'STM32 via ST-LINK' },
  '0d28:0204': { name: 'BBC micro:bit (DAPLink)', boardId: 'nano', fqbn: '', chip: 'nRF52833' },
  '239a:800b': { name: 'Adafruit Feather M0', boardId: 'featherm0', fqbn: 'adafruit:samd:adafruit_feather_m0', chip: 'SAMD21' },
  '1b4f:9206': { name: 'SparkFun SAMD21', boardId: 'nano', fqbn: 'SparkFun:samd:samd21_dev', chip: 'SAMD21' },
  '1b4f:9205': { name: 'SparkFun Pro Micro 5V', boardId: 'nano', fqbn: 'SparkFun:avr:promicro', chip: 'ATmega32u4' },
  '1b4f:9204': { name: 'SparkFun Pro Micro 3V3', boardId: 'nano', fqbn: 'SparkFun:avr:promicro', chip: 'ATmega32u4' },
  '16d0:0753': { name: 'Digispark (ATtiny85)', boardId: 'nano', fqbn: 'digistump:avr:digispark-tiny', chip: 'ATtiny85' },
  '03eb:2404': { name: 'ATmega32u4 (DFU bootloader)', boardId: 'nano', fqbn: '', chip: 'ATmega32u4' },
  '03eb:2ff4': { name: 'ATmega32u4 (Atmel DFU)', boardId: 'nano', fqbn: '', chip: 'ATmega32u4' },
  // ---- adafruit (vid 239a) — the well-known catalog; anything not listed
  // still identifies via the vendor catch-all below ----
  '239a:8014': { name: 'Adafruit Metro M4', boardId: 'uno', fqbn: 'adafruit:samd:adafruit_metro_m4', chip: 'SAMD51' },
  '239a:801b': { name: 'Adafruit Feather M0 Express', boardId: 'featherm0', fqbn: 'adafruit:samd:adafruit_feather_m0_express', chip: 'SAMD21' },
  '239a:8022': { name: 'Adafruit Feather M4 Express', boardId: 'featherm4', fqbn: 'adafruit:samd:adafruit_feather_m4', chip: 'SAMD51' },
  '239a:800c': { name: 'Adafruit Feather 32u4', boardId: 'nano', fqbn: 'adafruit:avr:feather32u4', chip: 'ATmega32u4' },
  '239a:800a': { name: 'Adafruit Feather 32u4 (bootloader)', boardId: 'nano', fqbn: 'adafruit:avr:feather32u4', chip: 'ATmega32u4' },
  '239a:8019': { name: 'Adafruit Circuit Playground Express', boardId: 'nano', fqbn: 'adafruit:samd:adafruit_circuitplayground_m0', chip: 'SAMD21' },
  '239a:8011': { name: 'Adafruit ItsyBitsy M0', boardId: 'nano', fqbn: 'adafruit:samd:adafruit_itsybitsy_m0', chip: 'SAMD21' },
  '239a:802b': { name: 'Adafruit ItsyBitsy M4', boardId: 'nano', fqbn: 'adafruit:samd:adafruit_itsybitsy_m4', chip: 'SAMD51' },
  '239a:8031': { name: 'Adafruit Metro M4 AirLift', boardId: 'uno', fqbn: 'adafruit:samd:adafruit_metro_m4_airliftlite', chip: 'SAMD51' },
  '239a:8020': { name: 'Adafruit Metro M0 Express', boardId: 'uno', fqbn: 'adafruit:samd:adafruit_metro_m0', chip: 'SAMD21' },
  '239a:8021': { name: 'Adafruit Grand Central M4', boardId: 'mega', fqbn: 'adafruit:samd:adafruit_grandcentral_m4', chip: 'SAMD51' },
  '239a:8026': { name: 'Adafruit Trinket M0', boardId: 'nano', fqbn: 'adafruit:samd:adafruit_trinket_m0', chip: 'SAMD21' },
  '239a:801e': { name: 'Adafruit Gemma M0', boardId: 'nano', fqbn: 'adafruit:samd:adafruit_gemma_m0', chip: 'SAMD21' },
  '239a:8071': { name: 'Adafruit QT Py M0', boardId: 'nano', fqbn: 'adafruit:samd:adafruit_qtpy_m0', chip: 'SAMD21' },
  '239a:80f9': { name: 'Adafruit QT Py ESP32-S2', boardId: 'esp32', fqbn: 'esp32:esp32:adafruit_qtpy_esp32s2', chip: 'ESP32-S2' },
  '239a:8111': { name: 'Adafruit QT Py ESP32-S3', boardId: 'esp32', fqbn: 'esp32:esp32:adafruit_qtpy_esp32s3_nopsram', chip: 'ESP32-S3' },
  '239a:80d2': { name: 'Adafruit Feather ESP32-S2', boardId: 'esp32', fqbn: 'esp32:esp32:adafruit_feather_esp32s2', chip: 'ESP32-S2' },
  '239a:80eb': { name: 'Adafruit Feather ESP32-S3', boardId: 'esp32', fqbn: 'esp32:esp32:adafruit_feather_esp32s3_nopsram', chip: 'ESP32-S3' },
  '239a:80ac': { name: 'Adafruit Feather RP2040', boardId: 'featherrp2040', fqbn: 'rp2040:rp2040:adafruit_feather', chip: 'RP2040' },
  '239a:80f1': { name: 'Adafruit ItsyBitsy RP2040', boardId: 'pico', fqbn: 'rp2040:rp2040:adafruit_itsybitsy', chip: 'RP2040' },
  '239a:80f7': { name: 'Adafruit QT Py RP2040', boardId: 'pico', fqbn: 'rp2040:rp2040:adafruit_qtpy', chip: 'RP2040' },
  '239a:80fd': { name: 'Adafruit Trinkey QT2040', boardId: 'pico', fqbn: 'rp2040:rp2040:adafruit_trinkeyrp2040qt', chip: 'RP2040' },
  '239a:8038': { name: 'Adafruit PyPortal', boardId: 'nano', fqbn: 'adafruit:samd:adafruit_pyportal_m4', chip: 'SAMD51' },
  '239a:80a4': { name: 'Adafruit MagTag', boardId: 'esp32', fqbn: 'esp32:esp32:adafruit_magtag29_esp32s2', chip: 'ESP32-S2' },
  '239a:80a8': { name: 'Adafruit FunHouse', boardId: 'esp32', fqbn: 'esp32:esp32:adafruit_funhouse_esp32s2', chip: 'ESP32-S2' },
  '239a:8036': { name: 'Adafruit PyBadge', boardId: 'nano', fqbn: 'adafruit:samd:adafruit_pybadge_m4', chip: 'SAMD51' },
  '239a:803c': { name: 'Adafruit PyGamer', boardId: 'nano', fqbn: 'adafruit:samd:adafruit_pygamer_m4', chip: 'SAMD51' },
  '239a:8046': { name: 'Adafruit Feather nRF52840 Express', boardId: 'nano', fqbn: 'adafruit:nrf52:feather52840', chip: 'nRF52840' },
  '239a:8029': { name: 'Adafruit Feather nRF52832', boardId: 'nano', fqbn: 'adafruit:nrf52:feather52832', chip: 'nRF52832' },
  '239a:80cb': { name: 'Adafruit Feather ESP32 V2', boardId: 'esp32', fqbn: 'esp32:esp32:adafruit_feather_esp32_v2', chip: 'ESP32' },
  '239a:800e': { name: 'Adafruit Metro 328', boardId: 'uno', fqbn: 'arduino:avr:uno', chip: 'ATmega328P' }
};

// Vendor-level identification: ANY device from these vendors is named even
// when its exact product id isn't in the table above. The device's own USB
// product string (Windows friendlyName) supplies the model when present.
const VENDORS = {
  '2341': 'Arduino', '2a03': 'Arduino (org)', '239a': 'Adafruit',
  '1b4f': 'SparkFun', '303a': 'Espressif', '2e8a': 'Raspberry Pi',
  '16c0': 'Teensy/V-USB', '10c4': 'Silicon Labs', '1a86': 'QinHeng (CH34x)',
  '0403': 'FTDI', '04d8': 'Microchip', '03eb': 'Atmel', '0483': 'STMicro',
  '0d28': 'ARM mbed', '16d0': 'MCS', '1781': 'V-USB', '2886': 'Seeed'
};

// Guess which live board view fits from whatever name we have.
function guessBoardId(text) {
  const t = String(text || '').toLowerCase();
  // feathers get their real full-size form factor
  if (/feather/.test(t)) {
    if (/rp2040|rp2350/.test(t)) return 'featherrp2040';
    if (/esp32-?s[23]|esp32 v2|esp32-?c[36]/.test(t)) return 'esp32'; // different pinouts: generic view
    if (/esp32|huzzah/.test(t)) return 'featheresp32';
    if (/\bm0\b|samd21|feather_m0/.test(t)) return 'featherm0';
    if (/\bm4\b|samd51|feather_m4/.test(t)) return 'featherm4';
    // nRF52, 32u4 and others: no pin-accurate view yet, generic below
  }
  if (/esp32|esp-s2|esp-s3|s3 |s2 |c3 |xiao esp/.test(t)) return 'esp32';
  if (/esp8266|8266|nodemcu|wemos|d1 mini/.test(t)) return 'nodemcu';
  if (/rp2040|rp2350|pico/.test(t)) return 'pico';
  if (/leonardo/.test(t)) return 'leonardo';
  if (/nano every|4809/.test(t)) return 'nanoevery';
  if (/mega|due|giga|grand central/.test(t)) return 'mega';
  if (/uno|metro/.test(t)) return 'uno';
  if (/nano|micro|feather|itsy|qt py|trinket|trinkey|gemma|xiao|teensy|playground/.test(t)) return 'nano';
  return 'uno';
}

function fingerprint(p) {
  const vid = (p.vendorId || '').toLowerCase();
  const pid = (p.productId || '').toLowerCase();
  const hit = USB_IDS[vid + ':' + pid];
  if (hit) return { ...hit, vid, pid };
  if (VENDORS[vid]) {
    // known vendor, unlisted product: name from the device's own USB strings
    const product = (p.friendly || '').replace(/\s*\(COM\d+\)$/i, '').trim();
    const name = product && !/^COM\d+$/i.test(product)
      ? VENDORS[vid] + ' ' + product.replace(new RegExp('^' + VENDORS[vid] + '\\s*', 'i'), '')
      : VENDORS[vid] + ' device';
    return { name, boardId: guessBoardId(name + ' ' + (p.manufacturer || '')),
             fqbn: '', chip: 'pid ' + pid, vid, pid };
  }
  if (vid) return { name: (p.manufacturer || 'Unknown USB serial') + ' device',
                    boardId: guessBoardId(p.friendly), fqbn: '', chip: 'vid ' + vid + ' pid ' + pid, vid, pid };
  return null; // not usb (COM1 motherboard header etc.) — still listed, unnamed
}

// board view from an FQBN when arduino-cli names the board: the fqbn is the
// most reliable identity we get, so it decides the view when it is known
function boardIdFromFqbn(fqbn) {
  const f = String(fqbn || '');
  if (!f) return null;
  if (/adafruit_feather_m0/.test(f)) return 'featherm0';
  if (/adafruit:samd:adafruit_feather_m4/.test(f)) return 'featherm4';
  if (/rp2040:rp2040:adafruit_feather(?::|$)/.test(f)) return 'featherrp2040';
  if (/esp32:esp32:featheresp32(?::|$)/.test(f)) return 'featheresp32';
  if (/:avr:uno|adafruit_metro_m[04]|arduino:renesas_uno:/.test(f)) return 'uno';
  if (/:avr:leonardo(?::|$)/.test(f)) return 'leonardo';
  if (/arduino:megaavr:nona4809/.test(f)) return 'nanoevery';
  if (/:avr:(nano|pro)\b/.test(f)) return 'nano';
  if (/:avr:mega/.test(f)) return 'mega';
  if (/esp8266:/.test(f)) return 'nodemcu';
  if (/esp32:/.test(f)) return 'esp32';
  if (/rp2040:/.test(f)) return 'pico';
  return null;
}

let devices = [];        // current merged list
let cliBoards = new Map(); // port path -> {name, fqbn} from arduino-cli
let scanTimer = null, cliTimer = null, piTimer = null;
let deps = null;         // { listPorts, cliBoardList, piHosts }
let netPis = new Map();  // host -> { alive, hwver }

function key(d) { return d.kind + '|' + d.id + '|' + (d.name || '') + '|' + (d.fqbn || '') + '|' + (d.alive ? 1 : 0); }

async function scanSerial() {
  try {
    const ports = await deps.listPorts();
    const out = [];
    for (const p of ports) {
      const fp = fingerprint(p) || {};
      const cli = cliBoards.get(p.path);
      out.push({
        kind: 'serial',
        id: p.path,
        path: p.path,
        // arduino-cli's identification beats the fingerprint when present
        name: (cli && cli.name) || fp.name || p.friendly || p.path,
        fqbn: (cli && cli.fqbn) || fp.fqbn || '',
        boardId: (cli && boardIdFromFqbn(cli.fqbn)) || fp.boardId || 'uno',
        chip: fp.chip || '',
        serialNumber: p.serialNumber || '',
        alive: true
      });
    }
    for (const [host, info] of netPis) {
      out.push({
        kind: 'pi', id: host, host,
        name: 'Raspberry Pi @ ' + host, boardId: 'pi', fqbn: '',
        chip: info.hwver ? 'hw 0x' + info.hwver.toString(16) : '',
        alive: info.alive
      });
    }
    const sig = out.map(key).sort().join(';');
    if (sig !== devices._sig) {
      out._sig = sig;
      devices = out;
      emitter.emit('devices', out.map((d) => ({ ...d })));
    }
  } catch (e) { /* scan again next tick */ }
}

async function scanCli() {
  // arduino-cli is single-threaded about its data dir; never pile a board
  // list on top of a running compile or upload
  if (deps.busy && deps.busy()) return;
  try {
    const list = await deps.cliBoardList(); // [{address, boards:[{name,fqbn}]}]
    cliBoards = new Map();
    for (const p of list) {
      if (p.boards && p.boards.length) cliBoards.set(p.address, p.boards[0]);
    }
  } catch (e) { /* cli not ready yet */ }
}

// probe a host's pigpiod port without holding the connection
function probePi(host) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port: 8888 });
    const done = (alive) => { try { s.destroy(); } catch (e) {} resolve(alive); };
    s.setTimeout(1500, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

async function scanPis() {
  const hosts = new Set((deps.piHosts() || []).filter(Boolean));
  hosts.add('raspberrypi.local');
  for (const host of hosts) {
    const alive = await probePi(host);
    const prev = netPis.get(host);
    if (alive) netPis.set(host, { alive: true, hwver: prev && prev.hwver });
    else if (prev) netPis.set(host, { alive: false });
    // hosts never seen alive stay out of the list entirely
    if (!alive && (!prev || !prev.alive)) netPis.delete(host);
  }
}

function start(d) {
  deps = d;
  stop();
  scanCli();
  scanPis().then(scanSerial);
  scanTimer = setInterval(scanSerial, 2500);
  cliTimer = setInterval(scanCli, 10000);
  piTimer = setInterval(() => scanPis(), 15000);
}

function stop() {
  for (const t of [scanTimer, cliTimer, piTimer]) if (t) clearInterval(t);
  scanTimer = cliTimer = piTimer = null;
}

function list() { return devices.map((d) => ({ ...d })); }

module.exports = { on: emitter.on.bind(emitter), start, stop, list, fingerprint, guessBoardId,
                   boardIdFromFqbn, USB_IDS };
