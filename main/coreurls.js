// Board-manager index URLs for every platform family the app understands,
// plus the pure logic that injects them into arduino-cli.yaml and picks the
// right core for an FQBN. Pure node (no electron) so the test suite runs it.
const ADDITIONAL_URLS = [
  // espressif esp32 (incl. every Adafruit/SparkFun esp32 board definition)
  'https://espressif.github.io/arduino-esp32/package_esp32_index.json',
  // esp8266 community core (NodeMCU, Wemos D1…)
  'https://arduino.esp8266.com/stable/package_esp8266com_index.json',
  // earlephilhower rp2040/rp2350 core (Pico, Feather RP2040, KB2040…)
  'https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json',
  // adafruit's own AVR/SAMD/nRF52 boards
  'https://adafruit.github.io/arduino-board-index/package_adafruit_index.json',
  // teensy
  'https://www.pjrc.com/teensy/package_teensy_index.json'
];

// vendor:arch → the core id to install for that platform
function coreIdFromFqbn(fqbn) {
  const m = /^([^:]+):([^:]+):/.exec(String(fqbn || ''));
  return m ? m[1] + ':' + m[2] : null;
}

// Idempotently ensure the yaml carries our board_manager URLs.
// Returns { text, changed }. Handles: no section at all, an existing
// board_manager section, and partial URL lists (missing ones appended).
function ensureUrlsInYaml(text, extra) {
  let t = String(text || '');
  const ALL = ADDITIONAL_URLS.concat((extra || []).filter((u) => /^https?:\/\/\S+$/.test(u) && !ADDITIONAL_URLS.includes(u)));
  const missing = ALL.filter((u) => !t.includes(u));
  if (!missing.length) return { text: t, changed: false };
  if (!/^board_manager:/m.test(t)) {
    if (t.length && !t.endsWith('\n')) t += '\n';
    t += 'board_manager:\n  additional_urls:\n';
    for (const u of ALL) t += '    - ' + u + '\n';
    return { text: t, changed: true };
  }
  if (!/^\s*additional_urls:/m.test(t)) {
    t = t.replace(/^board_manager:\s*$/m, 'board_manager:\n  additional_urls:');
  }
  // append missing urls right under additional_urls, matching its indent
  t = t.replace(/^(\s*)additional_urls:\s*$/m, (line, ind) =>
    line + '\n' + missing.map((u) => ind + '  - ' + u).join('\n'));
  // additional_urls: [] or inline list — fall back to a clean rewrite
  if (missing.some((u) => !t.includes(u))) {
    t = t.replace(/^board_manager:[\s\S]*?(?=^\S|\Z)/m,
      'board_manager:\n  additional_urls:\n' + ALL.map((u) => '    - ' + u).join('\n') + '\n');
  }
  return { text: t, changed: true };
}

module.exports = { ADDITIONAL_URLS, coreIdFromFqbn, ensureUrlsInYaml };
