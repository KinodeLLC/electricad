// Board definitions for the live view. Geometry is stylized-but-honest:
// headers where they really are, pins in their real order, real names.
// digital: index into the telemetry masks. analogIndex: index into a= csv.
// A board def is { id, name, w, h, fqbnMatch, pins: [...], decor: [...] }
// pin: { label, tele, x, y, side, analogIndex? , note? }  tele=null → power pin
window.PINODE_BOARDS = (() => {
  function header(x, y, dy, defs) {
    return defs.map((d, i) => ({ ...d, x, y: y + i * dy }));
  }

  // ---- Arduino Uno R3 -------------------------------------------------------
  const uno = {
    id: 'uno', name: 'Arduino Uno', w: 260, h: 200,
    fqbnMatch: /arduino:avr:uno|arduino:renesas_uno:/,   // UNO R4 keeps the R3 numbering
    digitalCount: 20,
    pins: [
      // top header, right to left like the silkscreen: SCL SDA AREF GND 13..8
      ...header(238, 14, 0, []),
      ...[
        { label: 'SCL', tele: 19, note: 'A5/SCL' }, { label: 'SDA', tele: 18, note: 'A4/SDA' },
        { label: 'AREF', tele: null }, { label: 'GND', tele: null, power: 'gnd' },
        { label: '13', tele: 13 }, { label: '12', tele: 12 }, { label: '~11', tele: 11, pwm: true },
        { label: '~10', tele: 10, pwm: true }, { label: '~9', tele: 9, pwm: true }, { label: '8', tele: 8 }
      ].map((p, i) => ({ ...p, x: 250 - i * 11, y: 16, side: 'top' })),
      ...[
        { label: '7', tele: 7 }, { label: '~6', tele: 6, pwm: true }, { label: '~5', tele: 5, pwm: true },
        { label: '4', tele: 4 }, { label: '~3', tele: 3, pwm: true }, { label: '2', tele: 2 },
        { label: 'TX1', tele: 1 }, { label: 'RX0', tele: 0 }
      ].map((p, i) => ({ ...p, x: 138 - i * 11, y: 16, side: 'top' })),
      // bottom-left power header
      ...[
        { label: 'IOREF', tele: null }, { label: 'RST', tele: null }, { label: '3V3', tele: null, power: 'v33' },
        { label: '5V', tele: null, power: 'v5' }, { label: 'GND', tele: null, power: 'gnd' },
        { label: 'GND', tele: null, power: 'gnd' }, { label: 'VIN', tele: null, power: 'vin' }
      ].map((p, i) => ({ ...p, x: 92 + i * 11, y: 184, side: 'bottom' })),
      // bottom-right analog header
      ...[
        { label: 'A0', tele: 14, analogIndex: 0 }, { label: 'A1', tele: 15, analogIndex: 1 },
        { label: 'A2', tele: 16, analogIndex: 2 }, { label: 'A3', tele: 17, analogIndex: 3 },
        { label: 'A4', tele: 18, analogIndex: 4 }, { label: 'A5', tele: 19, analogIndex: 5 }
      ].map((p, i) => ({ ...p, x: 186 + i * 11, y: 184, side: 'bottom' }))
    ],
    decor: [
      { kind: 'usb', x: 2, y: 40, w: 34, h: 34 },
      { kind: 'jack', x: 2, y: 140, w: 30, h: 26 },
      { kind: 'chip', x: 120, y: 120, w: 100, h: 26, label: 'ATMEGA328P' },
      { kind: 'led', x: 60, y: 60, tele: 13, label: 'L', color: '#ffd94a' },
      { kind: 'led', x: 60, y: 78, role: 'power', label: 'ON', color: '#3fd07a' },
      { kind: 'led', x: 74, y: 60, role: 'tx', label: 'TX', color: '#ffd94a' },
      { kind: 'led', x: 74, y: 78, role: 'rx', label: 'RX', color: '#ffd94a' }
    ]
  };

  // ---- Arduino Nano ---------------------------------------------------------
  const nano = {
    id: 'nano', name: 'Arduino Nano', w: 120, h: 260,
    fqbnMatch: /arduino:avr:nano/,
    digitalCount: 20,
    pins: [
      ...[
        { label: 'TX1', tele: 1 }, { label: 'RX0', tele: 0 }, { label: 'RST', tele: null },
        { label: 'GND', tele: null, power: 'gnd' }, { label: '2', tele: 2 }, { label: '~3', tele: 3, pwm: true },
        { label: '4', tele: 4 }, { label: '~5', tele: 5, pwm: true }, { label: '~6', tele: 6, pwm: true },
        { label: '7', tele: 7 }, { label: '8', tele: 8 }, { label: '~9', tele: 9, pwm: true },
        { label: '~10', tele: 10, pwm: true }, { label: '~11', tele: 11, pwm: true }, { label: '12', tele: 12 }
      ].map((p, i) => ({ ...p, x: 14, y: 26 + i * 15, side: 'left' })),
      ...[
        { label: 'VIN', tele: null, power: 'vin' }, { label: 'GND', tele: null, power: 'gnd' },
        { label: 'RST', tele: null }, { label: '5V', tele: null, power: 'v5' },
        { label: 'A7', tele: null, analogIndex: 7 }, { label: 'A6', tele: null, analogIndex: 6 },
        { label: 'A5', tele: 19, analogIndex: 5 }, { label: 'A4', tele: 18, analogIndex: 4 },
        { label: 'A3', tele: 17, analogIndex: 3 }, { label: 'A2', tele: 16, analogIndex: 2 },
        { label: 'A1', tele: 15, analogIndex: 1 }, { label: 'A0', tele: 14, analogIndex: 0 },
        { label: '3V3', tele: null, power: 'v33' }, { label: 'D13', tele: 13 }
      ].map((p, i) => ({ ...p, x: 106, y: 26 + i * 15, side: 'right' }))
    ],
    decor: [
      { kind: 'usb', x: 44, y: 2, w: 32, h: 18 },
      { kind: 'chip', x: 38, y: 110, w: 44, h: 44, label: '328P' },
      { kind: 'led', x: 52, y: 70, tele: 13, label: 'L', color: '#ffd94a' },
      { kind: 'led', x: 68, y: 70, role: 'power', label: 'PWR', color: '#3fd07a' },
      { kind: 'led', x: 52, y: 86, role: 'tx', label: 'TX', color: '#ffd94a' },
      { kind: 'led', x: 68, y: 86, role: 'rx', label: 'RX', color: '#ffd94a' }
    ]
  };

  // ---- Arduino Leonardo -----------------------------------------------------
  // Uno-shaped, but an ATmega32u4: A0–A5 are digital 18–23, SDA/SCL are D2/D3,
  // PWM on 3 5 6 9 10 11 13, and the TX/RX LEDs show USB traffic.
  const leonardo = {
    id: 'leonardo', name: 'Arduino Leonardo', w: 260, h: 200,
    fqbnMatch: /arduino:avr:leonardo(?::|$)/,
    digitalCount: 31,
    pins: [
      ...[
        { label: 'SCL', tele: 3, note: 'D3/SCL' }, { label: 'SDA', tele: 2, note: 'D2/SDA' },
        { label: 'AREF', tele: null }, { label: 'GND', tele: null, power: 'gnd' },
        { label: '13', tele: 13, pwm: true }, { label: '12', tele: 12, note: 'A11' }, { label: '~11', tele: 11, pwm: true },
        { label: '~10', tele: 10, pwm: true, note: 'A10' }, { label: '~9', tele: 9, pwm: true, note: 'A9' }, { label: '8', tele: 8, note: 'A8' }
      ].map((p, i) => ({ ...p, x: 250 - i * 11, y: 16, side: 'top' })),
      ...[
        { label: '7', tele: 7 }, { label: '~6', tele: 6, pwm: true, note: 'A7' }, { label: '~5', tele: 5, pwm: true },
        { label: '4', tele: 4, note: 'A6' }, { label: '~3', tele: 3, pwm: true, note: 'SCL' }, { label: '2', tele: 2, note: 'SDA' },
        { label: 'TX1', tele: 1 }, { label: 'RX0', tele: 0 }
      ].map((p, i) => ({ ...p, x: 138 - i * 11, y: 16, side: 'top' })),
      ...[
        { label: 'IOREF', tele: null }, { label: 'RST', tele: null }, { label: '3V3', tele: null, power: 'v33' },
        { label: '5V', tele: null, power: 'v5' }, { label: 'GND', tele: null, power: 'gnd' },
        { label: 'GND', tele: null, power: 'gnd' }, { label: 'VIN', tele: null, power: 'vin' }
      ].map((p, i) => ({ ...p, x: 92 + i * 11, y: 184, side: 'bottom' })),
      ...[
        { label: 'A0', tele: 18, analogIndex: 0 }, { label: 'A1', tele: 19, analogIndex: 1 },
        { label: 'A2', tele: 20, analogIndex: 2 }, { label: 'A3', tele: 21, analogIndex: 3 },
        { label: 'A4', tele: 22, analogIndex: 4 }, { label: 'A5', tele: 23, analogIndex: 5 }
      ].map((p, i) => ({ ...p, x: 186 + i * 11, y: 184, side: 'bottom' }))
    ],
    decor: [
      { kind: 'usb', x: 2, y: 44, w: 26, h: 22 },
      { kind: 'jack', x: 2, y: 140, w: 30, h: 26 },
      { kind: 'chip', x: 120, y: 112, w: 60, h: 60, label: 'ATMEGA32U4' },
      { kind: 'led', x: 60, y: 60, tele: 13, label: 'L', color: '#ffd94a' },
      { kind: 'led', x: 60, y: 78, role: 'power', label: 'ON', color: '#3fd07a' },
      { kind: 'led', x: 74, y: 60, role: 'tx', label: 'TX', color: '#ffd94a' },
      { kind: 'led', x: 74, y: 78, role: 'rx', label: 'RX', color: '#ffd94a' }
    ]
  };

  // ---- Arduino Nano Every ---------------------------------------------------
  // Nano footprint, ATmega4809: A0–A7 are all digital-capable (14–21), PWM on
  // 3 5 6 9 10 only. Labels are plain numbers like its silkscreen.
  const nanoevery = {
    id: 'nanoevery', name: 'Arduino Nano Every', w: 120, h: 260,
    fqbnMatch: /arduino:megaavr:nona4809/,
    digitalCount: 22,
    pins: [
      ...[
        { label: 'TX1', tele: 1 }, { label: 'RX0', tele: 0 }, { label: 'RST', tele: null },
        { label: 'GND', tele: null, power: 'gnd' }, { label: 'D2', tele: 2 }, { label: 'D3', tele: 3, pwm: true },
        { label: 'D4', tele: 4 }, { label: 'D5', tele: 5, pwm: true }, { label: 'D6', tele: 6, pwm: true },
        { label: 'D7', tele: 7 }, { label: 'D8', tele: 8 }, { label: 'D9', tele: 9, pwm: true },
        { label: 'D10', tele: 10, pwm: true }, { label: 'D11', tele: 11, note: 'MOSI' }, { label: 'D12', tele: 12, note: 'MISO' }
      ].map((p, i) => ({ ...p, x: 14, y: 26 + i * 15, side: 'left' })),
      ...[
        { label: 'VIN', tele: null, power: 'vin' }, { label: 'GND', tele: null, power: 'gnd' },
        { label: 'RST', tele: null }, { label: '5V', tele: null, power: 'v5' },
        { label: 'A7', tele: 21, analogIndex: 7 }, { label: 'A6', tele: 20, analogIndex: 6 },
        { label: 'A5', tele: 19, analogIndex: 5, note: 'SCL' }, { label: 'A4', tele: 18, analogIndex: 4, note: 'SDA' },
        { label: 'A3', tele: 17, analogIndex: 3 }, { label: 'A2', tele: 16, analogIndex: 2 },
        { label: 'A1', tele: 15, analogIndex: 1 }, { label: 'A0', tele: 14, analogIndex: 0 },
        { label: '3V3', tele: null, power: 'v33' }, { label: 'D13', tele: 13, note: 'SCK' }
      ].map((p, i) => ({ ...p, x: 106, y: 26 + i * 15, side: 'right' }))
    ],
    decor: [
      { kind: 'usb', x: 44, y: 2, w: 32, h: 18 },
      { kind: 'chip', x: 38, y: 110, w: 44, h: 44, label: '4809' },
      { kind: 'led', x: 52, y: 70, tele: 13, label: 'L', color: '#ffd94a' },
      { kind: 'led', x: 68, y: 70, role: 'power', label: 'ON', color: '#3fd07a' }
    ]
  };

  // ---- ESP32 DevKit (30-pin) ------------------------------------------------
  const esp32 = {
    id: 'esp32', name: 'ESP32 DevKit', w: 150, h: 280,
    fqbnMatch: /esp32:esp32/,
    digitalCount: 40,
    pins: [
      ...[
        { label: 'EN', tele: null }, { label: 'VP/36', tele: 36, note: 'input only' },
        { label: 'VN/39', tele: 39, note: 'input only' }, { label: '34', tele: 34, note: 'input only' },
        { label: '35', tele: 35, note: 'input only' }, { label: '32', tele: 32 },
        { label: '33', tele: 33 }, { label: '25', tele: 25 }, { label: '26', tele: 26 },
        { label: '27', tele: 27 }, { label: '14', tele: 14 }, { label: '12', tele: 12 },
        { label: 'GND', tele: null, power: 'gnd' }, { label: '13', tele: 13 }, { label: 'VIN', tele: null, power: 'vin' }
      ].map((p, i) => ({ ...p, x: 14, y: 40 + i * 15, side: 'left' })),
      ...[
        { label: '23', tele: 23 }, { label: '22', tele: 22, note: 'SCL' }, { label: 'TX0', tele: 1 },
        { label: 'RX0', tele: 3 }, { label: '21', tele: 21, note: 'SDA' }, { label: 'GND', tele: null, power: 'gnd' },
        { label: '19', tele: 19 }, { label: '18', tele: 18 }, { label: '5', tele: 5 },
        { label: '17', tele: 17 }, { label: '16', tele: 16 }, { label: '4', tele: 4 },
        { label: '0', tele: 0 }, { label: '2', tele: 2, note: 'onboard LED' }, { label: '3V3', tele: null, power: 'v33' }
      ].map((p, i) => ({ ...p, x: 136, y: 40 + i * 15, side: 'right' }))
    ],
    decor: [
      { kind: 'usb', x: 59, y: 2, w: 32, h: 20 },
      { kind: 'chip', x: 40, y: 40, w: 70, h: 60, label: 'ESP32-WROOM' },
      { kind: 'led', x: 60, y: 120, tele: 2, label: '2', color: '#4aa3ff' },
      { kind: 'led', x: 78, y: 120, role: 'power', label: 'PWR', color: '#ff5c5c' }
    ]
  };

  // ---- Raspberry Pi 40-pin header ------------------------------------------
  // Physical layout: 2×20. Odd pins left column, even right. tele = BCM number.
  const piHeader = [
    ['3V3', null, 'v33'], ['5V', null, 'v5'],
    ['GPIO2', 2, null, 'SDA'], ['5V', null, 'v5'],
    ['GPIO3', 3, null, 'SCL'], ['GND', null, 'gnd'],
    ['GPIO4', 4], ['GPIO14', 14, null, 'TXD'],
    ['GND', null, 'gnd'], ['GPIO15', 15, null, 'RXD'],
    ['GPIO17', 17], ['GPIO18', 18, null, 'PWM0'],
    ['GPIO27', 27], ['GND', null, 'gnd'],
    ['GPIO22', 22], ['GPIO23', 23],
    ['3V3', null, 'v33'], ['GPIO24', 24],
    ['GPIO10', 10, null, 'MOSI'], ['GND', null, 'gnd'],
    ['GPIO9', 9, null, 'MISO'], ['GPIO25', 25],
    ['GPIO11', 11, null, 'SCLK'], ['GPIO8', 8, null, 'CE0'],
    ['GND', null, 'gnd'], ['GPIO7', 7, null, 'CE1'],
    ['ID_SD', null], ['ID_SC', null],
    ['GPIO5', 5], ['GND', null, 'gnd'],
    ['GPIO6', 6], ['GPIO12', 12, null, 'PWM0'],
    ['GPIO13', 13, null, 'PWM1'], ['GND', null, 'gnd'],
    ['GPIO19', 19, null, 'MISO'], ['GPIO16', 16],
    ['GPIO26', 26], ['GPIO20', 20, null, 'MOSI'],
    ['GND', null, 'gnd'], ['GPIO21', 21, null, 'SCLK']
  ];
  const pi = {
    id: 'pi', name: 'Raspberry Pi GPIO', w: 170, h: 340,
    fqbnMatch: /^$/, digitalCount: 28,
    pins: piHeader.map(([label, tele, power, note], i) => ({
      label, tele, power, note,
      x: i % 2 === 0 ? 62 : 108,
      y: 24 + Math.floor(i / 2) * 15,
      side: i % 2 === 0 ? 'left' : 'right',
      physical: i + 1
    })),
    decor: [{ kind: 'chip', x: 20, y: 130, w: 30, h: 80, label: 'PI' }]
  };

  // ---- Arduino Mega 2560 ----------------------------------------------------
  // Uno-shaped but long: top header 0..13 + comm pins, right-side double-row
  // header 22..53, bottom analog A0..A15. tele = arduino pin number.
  const megaTop = [
    { label: 'SCL', tele: 21 }, { label: 'SDA', tele: 20 },
    { label: 'AREF', tele: null }, { label: 'GND', tele: null, power: 'gnd' },
    { label: '13', tele: 13, pwm: true }, { label: '12', tele: 12, pwm: true },
    { label: '11', tele: 11, pwm: true }, { label: '10', tele: 10, pwm: true },
    { label: '9', tele: 9, pwm: true }, { label: '8', tele: 8, pwm: true },
    { label: '7', tele: 7, pwm: true }, { label: '6', tele: 6, pwm: true },
    { label: '5', tele: 5, pwm: true }, { label: '4', tele: 4, pwm: true },
    { label: '3', tele: 3, pwm: true }, { label: '2', tele: 2, pwm: true },
    { label: 'TX1', tele: 1 }, { label: 'RX0', tele: 0 },
    { label: 'TX3', tele: 14 }, { label: 'RX3', tele: 15 },
    { label: 'TX2', tele: 16 }, { label: 'RX2', tele: 17 },
    { label: 'TX1b', tele: 18 }, { label: 'RX1b', tele: 19 }
  ];
  const mega = {
    id: 'mega', name: 'Arduino Mega 2560', w: 340, h: 240,
    fqbnMatch: /arduino:avr:mega/,
    digitalCount: 64,
    pins: [
      ...megaTop.map((p, i) => ({ ...p, x: 330 - i * 11, y: 16, side: 'top' })),
      // double-row digital header 22..53 down the right edge (even outer, odd inner)
      ...Array.from({ length: 32 }, (_, i) => {
        const pin = 22 + i;
        const row = Math.floor(i / 2);
        return { label: String(pin), tele: pin,
                 x: i % 2 === 0 ? 330 : 318, y: 40 + row * 11.5,
                 side: i % 2 === 0 ? 'right' : 'left' };
      }),
      // power header bottom-left
      ...[
        { label: 'IOREF', tele: null }, { label: 'RST', tele: null },
        { label: '3V3', tele: null, power: 'v33' }, { label: '5V', tele: null, power: 'v5' },
        { label: 'GND', tele: null, power: 'gnd' }, { label: 'GND', tele: null, power: 'gnd' },
        { label: 'VIN', tele: null, power: 'vin' }
      ].map((p, i) => ({ ...p, x: 60 + i * 11, y: 224, side: 'bottom' })),
      // analog A0..A15 along the bottom (A10+ exceed the 64-bit digital mask —
      // they still show ADC values via analogIndex, just no digital state)
      ...Array.from({ length: 16 }, (_, i) => ({
        label: 'A' + i, tele: i < 10 ? 54 + i : null, analogIndex: i,
        x: 146 + i * 11, y: 224, side: 'bottom'
      }))
    ],
    decor: [
      { kind: 'usb', x: 2, y: 40, w: 34, h: 34 },
      { kind: 'jack', x: 2, y: 160, w: 30, h: 26 },
      { kind: 'chip', x: 120, y: 110, w: 110, h: 28, label: 'ATMEGA2560' },
      { kind: 'led', x: 60, y: 70, tele: 13, label: 'L', color: '#ffd94a' },
      { kind: 'led', x: 60, y: 88, role: 'power', label: 'ON', color: '#3fd07a' },
      { kind: 'led', x: 76, y: 70, role: 'tx', label: 'TX', color: '#ffd94a' },
      { kind: 'led', x: 76, y: 88, role: 'rx', label: 'RX', color: '#ffd94a' }
    ]
  };

  // ---- Raspberry Pi Pico ----------------------------------------------------
  // 40-pin DIP: GP pins + power interleaved, tele = GP number.
  const picoLeft = [
    ['GP0', 0], ['GP1', 1], ['GND', null, 'gnd'], ['GP2', 2], ['GP3', 3],
    ['GP4', 4], ['GP5', 5], ['GND', null, 'gnd'], ['GP6', 6], ['GP7', 7],
    ['GP8', 8], ['GP9', 9], ['GND', null, 'gnd'], ['GP10', 10], ['GP11', 11],
    ['GP12', 12], ['GP13', 13], ['GND', null, 'gnd'], ['GP14', 14], ['GP15', 15]
  ];
  const picoRight = [
    ['VBUS', null, 'v5'], ['VSYS', null, 'vin'], ['GND', null, 'gnd'],
    ['3V3EN', null], ['3V3', null, 'v33'], ['ADC_REF', null],
    ['GP28/A2', 28, null, 'A2'], ['GND', null, 'gnd'], ['GP27/A1', 27, null, 'A1'],
    ['GP26/A0', 26, null, 'A0'], ['RUN', null], ['GP22', 22],
    ['GND', null, 'gnd'], ['GP21', 21], ['GP20', 20], ['GP19', 19],
    ['GP18', 18], ['GND', null, 'gnd'], ['GP17', 17], ['GP16', 16]
  ];
  const pico = {
    id: 'pico', name: 'Raspberry Pi Pico', w: 130, h: 330,
    fqbnMatch: /rp2040:rp2040/,
    digitalCount: 30,
    pins: [
      ...picoLeft.map(([label, tele, power, note], i) => ({
        label, tele, power, note, x: 14, y: 24 + i * 15, side: 'left',
        analogIndex: undefined
      })),
      ...picoRight.map(([label, tele, power, note], i) => ({
        label, tele, power, note, x: 116, y: 24 + i * 15, side: 'right',
        analogIndex: tele === 26 ? 0 : tele === 27 ? 1 : tele === 28 ? 2 : undefined
      }))
    ],
    decor: [
      { kind: 'usb', x: 49, y: 2, w: 32, h: 18 },
      { kind: 'chip', x: 45, y: 90, w: 40, h: 40, label: 'RP2040' },
      // the Pico's only LED is GP25 — there is no power LED, and that's accurate
      { kind: 'led', x: 92, y: 40, tele: 25, label: '25', color: '#3fd07a' }
    ]
  };

  // ---- ESP8266 NodeMCU ------------------------------------------------------
  // D-numbers on the silkscreen, GPIO numbers in telemetry.
  const nodeLeft = [
    ['A0', null, null, 'ADC'], ['RSV', null], ['RSV', null], ['SD3', 10],
    ['SD2', 9], ['SD1', null], ['CMD', null], ['SD0', null], ['CLK', null],
    ['GND', null, 'gnd'], ['3V3', null, 'v33'], ['EN', null], ['RST', null],
    ['GND', null, 'gnd'], ['VIN', null, 'vin']
  ];
  const nodeRight = [
    ['D0/G16', 16, null, 'no int'], ['D1/G5', 5, null, 'SCL'], ['D2/G4', 4, null, 'SDA'],
    ['D3/G0', 0, null, 'flash'], ['D4/G2', 2, null, 'LED'], ['3V3', null, 'v33'],
    ['GND', null, 'gnd'], ['D5/G14', 14, null, 'SCLK'], ['D6/G12', 12, null, 'MISO'],
    ['D7/G13', 13, null, 'MOSI'], ['D8/G15', 15, null, 'CS'], ['RX/G3', 3],
    ['TX/G1', 1], ['GND', null, 'gnd'], ['3V3', null, 'v33']
  ];
  const nodemcu = {
    id: 'nodemcu', name: 'ESP8266 NodeMCU', w: 140, h: 270,
    fqbnMatch: /esp8266:esp8266/,
    digitalCount: 17,
    pins: [
      ...nodeLeft.map(([label, tele, power, note], i) => ({
        label, tele, power, note, x: 14, y: 32 + i * 15, side: 'left',
        analogIndex: label === 'A0' ? 0 : undefined
      })),
      ...nodeRight.map(([label, tele, power, note], i) => ({
        label, tele, power, note, x: 126, y: 32 + i * 15, side: 'right'
      }))
    ],
    decor: [
      { kind: 'usb', x: 54, y: 2, w: 32, h: 20 },
      { kind: 'chip', x: 40, y: 60, w: 60, h: 50, label: 'ESP8266' },
      // the real NodeMCU blue LED sits on GPIO2 and is ACTIVE-LOW:
      // digitalWrite(2, LOW) turns it ON. Modeled faithfully.
      { kind: 'led', x: 100, y: 130, tele: 2, label: '2', color: '#4aa3ff', invert: true },
      { kind: 'led', x: 40, y: 130, role: 'power', label: 'PWR', color: '#ff5c5c' }
    ]
  };

  // ---- Adafruit Feather (full-size, real form factor) -----------------------
  // The Feather spec: a 16-pin header the full length of one edge and a
  // 12-pin header starting from the USB end of the other. Same physical
  // positions across the family; the chip variant decides the GPIO numbers.
  // All three variants keep their red LED on "13" — faithfully.
  function featherPins(bottom16, top12) {
    return [
      ...bottom16.map(([label, tele, power, note, analogIndex], i) => ({
        label, tele, power, note, analogIndex,
        x: 20 + i * 12, y: 84, side: 'bottom'
      })),
      ...top12.map(([label, tele, power, note], i) => ({
        label, tele, power, note,
        x: 20 + i * 12, y: 16, side: 'top'
      }))
    ];
  }
  const featherDecor = (chipLabel, extraLeds) => [
    { kind: 'usb', x: 2, y: 38, w: 24, h: 22 },
    { kind: 'jack', x: 2, y: 62, w: 16, h: 14 },           // JST battery
    { kind: 'chip', x: 88, y: 38, w: 64, h: 26, label: chipLabel },
    { kind: 'led', x: 62, y: 44, tele: 13, label: '13', color: '#ff5c5c' },
    ...(extraLeds || [])
  ];

  // Feather ESP32 (HUZZAH32) — GPIO numbers straight off the silkscreen.
  const featheresp32 = {
    id: 'featheresp32', name: 'Feather ESP32 (HUZZAH32)', w: 214, h: 100,
    fqbnMatch: /esp32:esp32:featheresp32(?::|$)/,   // HUZZAH32 only: V2/S2/S3 Feathers differ
    digitalCount: 40,
    pins: featherPins(
      [ ['RST', null], ['3V', null, 'v33'], ['NC', null], ['GND', null, 'gnd'],
        ['A0/26', 26, null, null, 0], ['A1/25', 25, null, null, 1],
        ['A2/34', 34, null, 'input only', 2], ['A3/39', 39, null, 'input only', 3],
        ['A4/36', 36, null, 'input only', 4], ['A5/4', 4, null, null, 5],
        ['SCK/5', 5], ['MO/18', 18], ['MI/19', 19], ['RX/16', 16], ['TX/17', 17], ['21', 21] ],
      [ ['BAT', null, 'vin'], ['EN', null], ['USB', null, 'v5'],
        ['13', 13, null, 'red LED'], ['12', 12], ['27', 27], ['33', 33],
        ['15', 15], ['32', 32], ['14', 14], ['SCL/22', 22], ['SDA/23', 23] ]),
    decor: featherDecor('ESP32')
  };

  // Feather RP2040 — GP numbers per the Adafruit pinout.
  const featherrp2040 = {
    id: 'featherrp2040', name: 'Feather RP2040', w: 214, h: 100,
    fqbnMatch: /rp2040:rp2040:adafruit_feather(?::|$)/,   // plain Feather RP2040 only
    digitalCount: 30,
    pins: featherPins(
      [ ['RST', null], ['3V', null, 'v33'], ['NC', null], ['GND', null, 'gnd'],
        ['A0/GP26', 26, null, null, 0], ['A1/GP27', 27, null, null, 1],
        ['A2/GP28', 28, null, null, 2], ['A3/GP29', 29, null, null, 3],
        ['D24', 24], ['D25', 25],
        ['SCK/GP14', 14], ['MO/GP15', 15], ['MI/GP8', 8], ['RX/GP1', 1], ['TX/GP0', 0], ['D4', 4] ],
      [ ['BAT', null, 'vin'], ['EN', null], ['USB', null, 'v5'],
        ['D13', 13, null, 'red LED'], ['D12', 12], ['D11', 11], ['D10', 10],
        ['D9', 9], ['D6', 6], ['D5', 5], ['SCL/GP3', 3], ['SDA/GP2', 2] ]),
    decor: featherDecor('RP2040', [
      { kind: 'led', x: 62, y: 58, tele: 16, label: 'NEO', color: '#ffffff' }
    ])
  };

  // Feather M0/M4 class (SAMD21/51, nRF52840 share the layout) — Arduino
  // pin numbers per the M4 Express variant.
  // Feather M0 (Basic / Express / Adalogger) — Arduino numbers per the
  // adafruit_feather_m0 variant: A0–A5 = 14–19, SDA 20, SCL 21, MISO 22,
  // MOSI 23, SCK 24. The 16th bottom pin is not a GPIO on every M0 Feather,
  // so it gets no telemetry here; the M0 Express NeoPixel (pin 8) is not drawn
  // because the basic M0 has no NeoPixel.
  const featherm0 = {
    id: 'featherm0', name: 'Feather M0', w: 214, h: 100,
    fqbnMatch: /adafruit:samd:adafruit_feather_m0/,
    digitalCount: 26,
    pins: featherPins(
      [ ['RST', null], ['3V', null, 'v33'], ['AREF', null], ['GND', null, 'gnd'],
        ['A0', 14, null, null, 0], ['A1', 15, null, null, 1],
        ['A2', 16, null, null, 2], ['A3', 17, null, null, 3],
        ['A4', 18, null, null, 4], ['A5', 19, null, null, 5],
        ['SCK', 24], ['MO', 23], ['MI', 22], ['RX', 0], ['TX', 1], ['—', null, null, 'check your board\'s pinout'] ],
      [ ['BAT', null, 'vin'], ['EN', null], ['USB', null, 'v5'],
        ['D13', 13, null, 'red LED'], ['D12', 12], ['D11', 11], ['D10', 10],
        ['D9', 9, null, 'A7 · battery divider'], ['D6', 6], ['D5', 5], ['SCL', 21], ['SDA', 20] ]),
    decor: featherDecor('SAMD21')
  };

  // Feather M4 Express — adafruit_feather_m4 variant numbering.
  const featherm4 = {
    id: 'featherm4', name: 'Feather M4 Express', w: 214, h: 100,
    fqbnMatch: /adafruit:samd:adafruit_feather_m4/,
    digitalCount: 26,
    pins: featherPins(
      [ ['RST', null], ['3V', null, 'v33'], ['AREF', null], ['GND', null, 'gnd'],
        ['A0', 14, null, null, 0], ['A1', 15, null, null, 1],
        ['A2', 16, null, null, 2], ['A3', 17, null, null, 3],
        ['A4', 18, null, null, 4], ['A5', 19, null, null, 5],
        ['SCK', 25], ['MO', 24], ['MI', 23], ['RX', 0], ['TX', 1], ['D4', 4] ],
      [ ['BAT', null, 'vin'], ['EN', null], ['USB', null, 'v5'],
        ['D13', 13, null, 'red LED'], ['D12', 12], ['D11', 11], ['D10', 10],
        ['D9', 9], ['D6', 6], ['D5', 5], ['SCL', 22], ['SDA', 21] ]),
    decor: featherDecor('SAMD51', [
      { kind: 'led', x: 62, y: 58, tele: 8, label: 'NEO', color: '#ffffff' }
    ])
  };

  // feather defs go first so their fqbnMatch wins over the generic families
  return { featheresp32, featherrp2040, featherm0, featherm4, leonardo, nanoevery, uno, nano, mega, esp32, nodemcu, pico, pi };
})();
