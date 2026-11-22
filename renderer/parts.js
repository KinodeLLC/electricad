// The parts knowledge base. Every part the canvas can place lives here with:
//   ports    — its real terminals (typed for wire coloring)
//   info     — how it works, what voltage it is designed for, and what
//              actually happens when you exceed it (the failure mode)
//   hookup   — the canonical wiring schematic, converted into the canvas's
//              native form (parts + wires resolved against the current board)
//              so the app UNDERSTANDS the schematic instead of showing a picture
// Plus classify(): maps an Adafruit catalog product onto a wireable module
// (I2C / SPI / UART / analog / NeoPixel / servo / motor…) with real ratings.
// UMD: the test suite loads this in node and validates every hookup.
(function (root) {

  const PART_GROUPS = [
    { group: 'POWER (start here)', parts: [
      { type: 'psu', name: 'Power supply', required: true, ports: [
        { id: 'pos', label: '+', type: 'pos' }, { id: 'neg', label: '−', type: 'neg' }],
        defaults: { volts: 5, amps: 1 } },
      { type: 'bat9v', name: 'Battery 9V', ports: [
        { id: 'pos', label: '+', type: 'pos' }, { id: 'neg', label: '−', type: 'neg' }] },
      { type: 'bat4aa', name: 'Battery 4×AA (6V)', ports: [
        { id: 'pos', label: '+', type: 'pos' }, { id: 'neg', label: '−', type: 'neg' }] },
      { type: 'cr2032', name: 'Coin cell CR2032 (3V)', ports: [
        { id: 'pos', label: '+', type: 'pos' }, { id: 'neg', label: '−', type: 'neg' }] },
      { type: 'lipo', name: 'LiPo cell 3.7V', ports: [
        { id: 'pos', label: '+', type: 'pos' }, { id: 'neg', label: '−', type: 'neg' }] },
      { type: 'solar', name: 'Solar panel 6V', ports: [
        { id: 'pos', label: '+', type: 'pos' }, { id: 'neg', label: '−', type: 'neg' }], defaults: { volts: 6, mA: 170, light: 100 } },
      { type: 'tp4056', name: 'TP4056 Li-ion charger', ports: [
        { id: 'inp', label: 'IN+', type: 'pos' }, { id: 'inn', label: 'IN−', type: 'neg' },
        { id: 'batp', label: 'B+', type: 'pos' }, { id: 'batn', label: 'B−', type: 'neg' }] },
      { type: 'reg7805', name: '7805 regulator (5V)', ports: [
        { id: 'in', label: 'IN', type: 'pos' }, { id: 'gnd', label: 'GND', type: 'neg' }, { id: 'out', label: 'OUT', type: 'pos' }] },
      { type: 'reg33', name: 'AMS1117 (3.3V)', ports: [
        { id: 'in', label: 'IN', type: 'pos' }, { id: 'gnd', label: 'GND', type: 'neg' }, { id: 'out', label: 'OUT', type: 'pos' }] },
      { type: 'buck', name: 'Buck converter LM2596', ports: [
        { id: 'in', label: 'IN+', type: 'pos' }, { id: 'gnd', label: 'GND', type: 'neg' }, { id: 'out', label: 'OUT+', type: 'pos' }],
        defaults: { vout: 5 } },
      { type: 'lm317', name: 'LM317 adjustable regulator', ports: [
        { id: 'in', label: 'IN', type: 'pos' }, { id: 'gnd', label: 'GND/ADJ', type: 'neg' }, { id: 'out', label: 'OUT', type: 'pos' }],
        defaults: { vout: 5 } },
      { type: 'fuse', name: 'Fuse', ports: [
        { id: 'a', label: '1', type: 'sig' }, { id: 'b', label: '2', type: 'sig' }] }
    ] },
    { group: 'PASSIVES', parts: [
      { type: 'resistor', name: 'Resistor', ports: [
        { id: 'a', label: '1', type: 'sig' }, { id: 'b', label: '2', type: 'sig' }] },
      { type: 'pot', name: 'Potentiometer', ports: [
        { id: 'vcc', label: '+', type: 'pos' }, { id: 'wiper', label: 'W', type: 'sig' }, { id: 'gnd', label: '−', type: 'neg' }] },
      { type: 'ldr', name: 'LDR (photoresistor)', ports: [
        { id: 'a', label: '1', type: 'sig' }, { id: 'b', label: '2', type: 'sig' }] },
      { type: 'thermistor', name: 'Thermistor', ports: [
        { id: 'a', label: '1', type: 'sig' }, { id: 'b', label: '2', type: 'sig' }] },
      { type: 'capC', name: 'Capacitor (ceramic)', ports: [
        { id: 'a', label: '1', type: 'sig' }, { id: 'b', label: '2', type: 'sig' }] },
      { type: 'capE', name: 'Capacitor (electrolytic)', ports: [
        { id: 'pos', label: '+', type: 'pos' }, { id: 'neg', label: '−', type: 'neg' }] },
      { type: 'inductor', name: 'Inductor', ports: [
        { id: 'a', label: '1', type: 'sig' }, { id: 'b', label: '2', type: 'sig' }] },
      { type: 'slide', name: 'Slide switch (SPDT)', ports: [
        { id: 'a', label: 'A', type: 'sig' }, { id: 'com', label: 'COM', type: 'sig' }, { id: 'b', label: 'B', type: 'sig' }] },
      { type: 'button', name: 'Button', ports: [
        { id: 'a', label: '1', type: 'sig' }, { id: 'b', label: '2', type: 'sig' }] }
    ] },
    { group: 'SEMICONDUCTORS', parts: [
      { type: 'led', name: 'LED', ports: [
        { id: 'anode', label: '+ anode', type: 'pos' }, { id: 'cathode', label: '− cathode', type: 'neg' }] },
      { type: 'diode', name: 'Diode (1N4001)', ports: [
        { id: 'anode', label: 'A', type: 'pos' }, { id: 'cathode', label: 'K', type: 'neg' }] },
      { type: 'schottky', name: 'Schottky diode', ports: [
        { id: 'anode', label: 'A', type: 'pos' }, { id: 'cathode', label: 'K', type: 'neg' }] },
      { type: 'zener', name: 'Zener 5.1V', ports: [
        { id: 'anode', label: 'A', type: 'pos' }, { id: 'cathode', label: 'K', type: 'neg' }] },
      { type: 'npn', name: 'NPN (2N2222)', ports: [
        { id: 'b', label: 'B', type: 'sig' }, { id: 'c', label: 'C', type: 'sig' }, { id: 'e', label: 'E', type: 'sig' }] },
      { type: 'pnp', name: 'PNP (2N2907)', ports: [
        { id: 'b', label: 'B', type: 'sig' }, { id: 'c', label: 'C', type: 'sig' }, { id: 'e', label: 'E', type: 'sig' }] },
      { type: 'nmos', name: 'N-MOSFET (logic)', ports: [
        { id: 'g', label: 'G', type: 'sig' }, { id: 'd', label: 'D', type: 'sig' }, { id: 's', label: 'S', type: 'sig' }] },
      { type: 'pmos', name: 'P-MOSFET (logic)', ports: [
        { id: 'g', label: 'G', type: 'sig' }, { id: 'd', label: 'D', type: 'sig' }, { id: 's', label: 'S', type: 'sig' }] }
    ] },
    { group: 'ELECTROMECHANICAL', parts: [
      { type: 'relay', name: 'Relay (SPDT)', ports: [
        { id: 'coilp', label: 'coil +', type: 'pos' }, { id: 'coiln', label: 'coil −', type: 'neg' },
        { id: 'com', label: 'COM', type: 'sig' }, { id: 'no', label: 'NO', type: 'sig' }, { id: 'nc', label: 'NC', type: 'sig' }] },
      { type: 'dcmotor', name: 'DC motor', ports: [
        { id: 'pos', label: '+', type: 'pos' }, { id: 'neg', label: '−', type: 'neg' }] },
      { type: 'vibmotor', name: 'Vibration motor (coin)', ports: [
        { id: 'pos', label: '+', type: 'pos' }, { id: 'neg', label: '−', type: 'neg' }] },
      { type: 'stepper', name: 'Stepper (bipolar)', ports: [
        { id: 'a1', label: 'A+', type: 'sig' }, { id: 'a2', label: 'A−', type: 'sig' },
        { id: 'b1', label: 'B+', type: 'sig' }, { id: 'b2', label: 'B−', type: 'sig' }] },
      { type: 'servo', name: 'Servo', ports: [
        { id: 'vcc', label: '+', type: 'pos' }, { id: 'sig', label: 'S', type: 'sig' }, { id: 'gnd', label: '−', type: 'neg' }] },
      { type: 'buzzer', name: 'Buzzer', ports: [
        { id: 'pos', label: '+', type: 'pos' }, { id: 'neg', label: '−', type: 'neg' }] }
    ] },
    { group: 'DRIVERS & MODULES', parts: [
      { type: 'pc817', name: 'Optocoupler PC817', ports: [
        { id: 'anode', label: 'A', type: 'pos' }, { id: 'cathode', label: 'K', type: 'neg' },
        { id: 'col', label: 'C', type: 'sig' }, { id: 'emi', label: 'E', type: 'sig' }] },
      { type: 'uln2003', name: 'ULN2003 driver', ports: [
        { id: 'in1', label: 'IN1', type: 'sig' }, { id: 'out1', label: 'OUT1', type: 'sig' },
        { id: 'in2', label: 'IN2', type: 'sig' }, { id: 'out2', label: 'OUT2', type: 'sig' },
        { id: 'in3', label: 'IN3', type: 'sig' }, { id: 'out3', label: 'OUT3', type: 'sig' },
        { id: 'in4', label: 'IN4', type: 'sig' }, { id: 'out4', label: 'OUT4', type: 'sig' },
        { id: 'com', label: 'COM', type: 'pos' }, { id: 'gnd', label: 'GND', type: 'neg' }] },
      { type: 'a4988', name: 'A4988 stepper driver', ports: [
        { id: 'en', label: 'EN', type: 'sig' }, { id: 'step', label: 'STEP', type: 'sig' },
        { id: 'dir', label: 'DIR', type: 'sig' }, { id: 'vdd', label: 'VDD', type: 'pos' },
        { id: 'vmot', label: 'VMOT', type: 'pos' }, { id: 'gnd', label: 'GND', type: 'neg' },
        { id: 'o1a', label: '1A', type: 'sig' }, { id: 'o1b', label: '1B', type: 'sig' },
        { id: 'o2a', label: '2A', type: 'sig' }, { id: 'o2b', label: '2B', type: 'sig' }] },
      { type: 'hcsr04', name: 'HC-SR04 sonar', ports: [
        { id: 'vcc', label: '+', type: 'pos' }, { id: 'trig', label: 'Trig', type: 'sig' },
        { id: 'echo', label: 'Echo', type: 'sig' }, { id: 'gnd', label: '−', type: 'neg' }] },
      { type: 'dht22', name: 'DHT22 temp/hum', ports: [
        { id: 'vcc', label: '+', type: 'pos' }, { id: 'data', label: 'Data', type: 'sig' }, { id: 'gnd', label: '−', type: 'neg' }] },
      { type: 'oled', name: 'OLED (I2C)', ports: [
        { id: 'vcc', label: '+', type: 'pos' }, { id: 'gnd', label: '−', type: 'neg' },
        { id: 'scl', label: 'SCL', type: 'sig' }, { id: 'sda', label: 'SDA', type: 'sig' }] },
      { type: 'neopixel', name: 'NeoPixel strip', ports: [
        { id: 'v5', label: '5V', type: 'pos' }, { id: 'gnd', label: '−', type: 'neg' }, { id: 'din', label: 'DIN', type: 'sig' }] },
      { type: 'generic', name: 'Generic part', ports: [
        { id: 'p1', label: '1', type: 'sig' }, { id: 'p2', label: '2', type: 'sig' },
        { id: 'p3', label: '3', type: 'sig' }, { id: 'p4', label: '4', type: 'sig' }] }
    ] },
    { group: 'FIRMWARE BENCH', parts: [
      { type: 'usbuart', name: 'USB-UART adapter', ports: [
        { id: 'vcc', label: '3V3', type: 'pos' }, { id: 'tx', label: 'TX', type: 'sig' },
        { id: 'rx', label: 'RX', type: 'sig' }, { id: 'gnd', label: 'GND', type: 'neg' }] },
      { type: 'ch341a', name: 'CH341A programmer', ports: [
        { id: 'v33', label: '3V3', type: 'pos' }, { id: 'v5', label: '5V', type: 'pos' },
        { id: 'cs', label: 'CS', type: 'sig' }, { id: 'clk', label: 'CLK', type: 'sig' },
        { id: 'mosi', label: 'MOSI', type: 'sig' }, { id: 'miso', label: 'MISO', type: 'sig' },
        { id: 'gnd', label: 'GND', type: 'neg' }] },
      { type: 'spiflash', name: 'SPI NOR flash (W25Q, SOIC-8)', ports: [
        { id: 'cs', label: 'CS', type: 'sig' }, { id: 'do', label: 'DO', type: 'sig' },
        { id: 'wp', label: 'WP', type: 'sig' }, { id: 'gnd', label: 'GND', type: 'neg' },
        { id: 'di', label: 'DI', type: 'sig' }, { id: 'clk', label: 'CLK', type: 'sig' },
        { id: 'hold', label: 'HOLD', type: 'sig' }, { id: 'vcc', label: 'VCC', type: 'pos' }] },
      { type: 'ipcam', name: 'IP camera (Ingenic)', ports: [
        { id: 'pwr', label: 'PWR', type: 'pos' }, { id: 'gnd', label: 'GND', type: 'neg' },
        { id: 'tx', label: 'TX', type: 'sig' }, { id: 'rx', label: 'RX', type: 'sig' }] }
    ] },
    { group: 'TEST EQUIPMENT', parts: [
      { type: 'voltmeter', name: 'Voltmeter (DMM)', ports: [
        { id: 'pos', label: 'V+', type: 'pos' }, { id: 'neg', label: 'COM', type: 'neg' }] },
      { type: 'ammeter', name: 'Ammeter (DMM, series)', ports: [
        { id: 'pos', label: 'A+', type: 'pos' }, { id: 'neg', label: 'COM', type: 'neg' }] }
    ] },
    { group: 'SENSORS', parts: [
      { type: 'tmp36', name: 'TMP36 temperature', ports: [
        { id: 'vcc', label: '+Vs', type: 'pos' }, { id: 'out', label: 'Vout', type: 'sig' }, { id: 'gnd', label: 'GND', type: 'neg' }],
        defaults: { tempC: 25 } },
      { type: 'lm35', name: 'LM35 temperature', ports: [
        { id: 'vcc', label: '+Vs', type: 'pos' }, { id: 'out', label: 'Vout', type: 'sig' }, { id: 'gnd', label: 'GND', type: 'neg' }],
        defaults: { tempC: 25 } },
      { type: 'pir', name: 'PIR motion HC-SR501', ports: [
        { id: 'vcc', label: 'VCC', type: 'pos' }, { id: 'out', label: 'OUT', type: 'sig' }, { id: 'gnd', label: 'GND', type: 'neg' }] },
      { type: 'irrecv', name: 'IR receiver VS1838B', ports: [
        { id: 'out', label: 'OUT', type: 'sig' }, { id: 'gnd', label: 'GND', type: 'neg' }, { id: 'vcc', label: 'VCC', type: 'pos' }] },
      { type: 'soil', name: 'Soil moisture (capacitive)', ports: [
        { id: 'vcc', label: 'VCC', type: 'pos' }, { id: 'out', label: 'AOUT', type: 'sig' }, { id: 'gnd', label: 'GND', type: 'neg' }],
        defaults: { moisture: 40 } },
      { type: 'reed', name: 'Reed switch (magnet)', ports: [
        { id: 'a', label: '1', type: 'sig' }, { id: 'b', label: '2', type: 'sig' }] },
      { type: 'hall', name: 'Hall sensor A3144', ports: [
        { id: 'vcc', label: 'VCC', type: 'pos' }, { id: 'gnd', label: 'GND', type: 'neg' }, { id: 'out', label: 'OUT', type: 'sig' }] },
      { type: 'tilt', name: 'Tilt switch SW-520D', ports: [
        { id: 'a', label: '1', type: 'sig' }, { id: 'b', label: '2', type: 'sig' }], defaults: { closed: true } },
      { type: 'mq2', name: 'MQ-2 gas sensor module', ports: [
        { id: 'vcc', label: 'VCC', type: 'pos' }, { id: 'gnd', label: 'GND', type: 'neg' },
        { id: 'dout', label: 'DOUT', type: 'sig' }, { id: 'aout', label: 'AOUT', type: 'sig' }], defaults: { gas: 0, threshold: 50 } },
      { type: 'joystick', name: 'Analog joystick', ports: [
        { id: 'gnd', label: 'GND', type: 'neg' }, { id: 'vcc', label: '+5V', type: 'pos' },
        { id: 'vrx', label: 'VRx', type: 'sig' }, { id: 'vry', label: 'VRy', type: 'sig' }, { id: 'sw', label: 'SW', type: 'sig' }],
        defaults: { x: 0.5, y: 0.5 } }
    ] },
    { group: 'GENERIC BREAKOUTS', parts: [
      { type: 'i2cmod', name: 'I2C module', ports: [
        { id: 'vcc', label: 'VIN', type: 'pos' }, { id: 'gnd', label: 'GND', type: 'neg' },
        { id: 'scl', label: 'SCL', type: 'sig' }, { id: 'sda', label: 'SDA', type: 'sig' }] },
      { type: 'spimod', name: 'SPI module', ports: [
        { id: 'vcc', label: 'VIN', type: 'pos' }, { id: 'gnd', label: 'GND', type: 'neg' },
        { id: 'sck', label: 'SCK', type: 'sig' }, { id: 'mosi', label: 'MOSI', type: 'sig' },
        { id: 'miso', label: 'MISO', type: 'sig' }, { id: 'cs', label: 'CS', type: 'sig' }] },
      { type: 'uartmod', name: 'UART module', ports: [
        { id: 'vcc', label: 'VIN', type: 'pos' }, { id: 'gnd', label: 'GND', type: 'neg' },
        { id: 'tx', label: 'TX', type: 'sig' }, { id: 'rx', label: 'RX', type: 'sig' }] },
      { type: 'analogmod', name: 'Analog sensor module', ports: [
        { id: 'vcc', label: 'VIN', type: 'pos' }, { id: 'gnd', label: 'GND', type: 'neg' },
        { id: 'out', label: 'OUT', type: 'sig' }] }
    ] }
  ];
  const PARTS = PART_GROUPS.flatMap((g) => g.parts);

  // ---- how each part works, what voltage it wants, and how it dies ----------
  // volts: designed range (display). fail: what physically happens past
  // absolute max — the "where does the smoke come from" answer.
  // ratings: machine-readable; the simulator checks solved node voltages
  // against these (pairs of ports measured p minus n).
  const PART_INFO = {
    voltmeter: { how: 'A digital multimeter on DC volts: 10MΩ input, so it barely disturbs what it measures. Clip V+ and COM across anything; the reading shows live in the node header while the sim runs.',
      volts: 'reads any voltage the sim produces (real DMMs: up to 600V CAT II on this range)',
      fail: 'On the volts range a DMM is nearly impossible to hurt at hobby voltages. The real danger is leaving the probes in the 10A jack and touching a battery: that is the ammeter short.' },
    ammeter: { how: 'A DMM on the current range: a 10mΩ shunt that must sit IN the current path (break the circuit and put the meter in series). Reads signed amps live; positive = current entering A+.',
      volts: 'up to ~10A on the high range, 200–400mA on the fused mA range',
      fail: 'Wired across a supply it is a dead short: amps flow, the meter fuse blows (or a cheap meter melts). The sim flags exactly this.' },
    lm35: { how: 'Analog temperature sensor: Vout = 10mV per °C from 0°C (25°C → 0.25V). In the basic hookup it cannot show temperatures below about +2°C. Double-click to set the temperature; °C = volts × 100.',
      volts: '4–30V supply, ~60µA (not for 3.3V boards: it needs at least 4V)',
      fail: 'A capacitive load on Vout makes it oscillate; add 75Ω + 1µF in series if the wire is long. Reverse supply past −0.2V damages it.',
      ratings: { pairs: [{ p: 'vcc', n: 'gnd', min: 4, max: 30, abs: 35 }] } },
    slide: { how: 'Single-pole double-throw: COM connects to A or to B, never both (break-before-make). Double-click to slide it. As a power switch, use COM and one side.',
      volts: 'typical hobby slide switches: 50V DC, 0.3–0.5A',
      fail: 'Switching motors or lamps above the contact rating pits and welds the contacts.' },
    hall: { how: 'A3144 unipolar Hall-effect switch: a magnet\'s SOUTH pole held to the printed face pulls OUT low (north does nothing). OUT is open-collector, so it needs a pull-up: INPUT_PULLUP or a 10k resistor to the board\'s logic voltage. Double-click to bring the magnet near.',
      volts: 'VCC 4.5–24V, OUT sinks up to 25mA; with the pull-up to your board\'s own logic rail it is safe on 3.3V and 5V boards',
      fail: 'Below 4.5V it does not switch reliably (it will not run from 3.3V). Pulling OUT up to 5V into a 3.3V board\'s pin back-feeds the pin. Reversed VCC/GND can kill it: the flat printed face faces you, pins are VCC, GND, OUT left to right.',
      ratings: { pairs: [{ p: 'vcc', n: 'gnd', min: 4.5, max: 24, abs: 28 }] } },
    tilt: { how: 'SW-520D ball tilt switch: a metal ball in a can closes the two pins while it is upright and rolls away when tipped past ~45°. Wire it like a button with INPUT_PULLUP. Double-click to tip it. It bounces, so debounce in code.',
      volts: 'Any logic voltage, a few mA through the contacts',
      fail: 'Not a precision level: it chatters near the switching angle, and it cannot tell which way it tipped. Use an accelerometer for angles.' },
    solar: { how: 'A small solar panel acts like a current source: the open-circuit voltage (≈6–7V for a "6V" panel) barely changes with light, but the current it can give scales with sunlight. Double-click to set the light level. Always use a diode or a charger so a battery cannot flow back into it at night.',
      volts: 'Voc ≈ 6–7V in full sun for a 6V panel; Isc set by panel size (170mA ≈ 1W)',
      fail: 'Its open-circuit voltage is higher than its label: a "6V" panel straight into a 5V board can exceed 5.5V in bright sun. Without a blocking diode a battery discharges back through the panel in the dark.' },
    mq2: { how: 'MQ-2 gas module: a tin-oxide element on a heater whose resistance drops in smoke, LPG, propane and hydrogen. AOUT rises with gas; DOUT goes LOW when AOUT passes the trimpot threshold. Readings are only meaningful after a 24–48 h burn-in and a few minutes of warm-up each time. Double-click to set the gas level.',
      volts: 'VCC 5V ±0.1V. The heater is 33Ω, about 150mA at 5V, so power it from a real 5V supply, not a 3.3V pin.',
      fail: 'Run from 3.3V the heater never reaches temperature and readings are garbage. AOUT reaches ~4V and DOUT is pulled up to 5V: on a 3.3V board (ESP32, Pico) put a divider on both. It is not a calibrated safety detector; never use it as a smoke alarm.',
      ratings: { pairs: [{ p: 'vcc', n: 'gnd', min: 4.9, max: 5.1, abs: 6, name: 'heater VCC' }] } },
    tp4056: { how: 'TP4056 single-cell Li-ion/LiPo charger module: 5V in (USB) charges a 3.7V cell with constant current, then holds it at 4.2V until the current drops off. The red LED is charging, blue/green is full. Most modules are set to 1A by a 1.2kΩ R_PROG resistor; swap it for small cells (e.g. 3k ≈ 400mA).',
      volts: 'IN 4.5–5.5V (8V absolute max), BAT charges to 4.2V ±1%',
      fail: 'Charging a cell smaller than ~1000mAh at the default 1A overheats it: change R_PROG. The bare TP4056 board has no over-discharge cut-off; use the version with the DW01 protection chip and OUT± pads for the load. Reversing the battery destroys the module.',
      ratings: { pairs: [{ p: 'inp', n: 'inn', min: 4.5, max: 5.5, abs: 8, name: 'IN' }] } },
    vibmotor: { how: 'Coin (ERM) vibration motor: a tiny DC motor with an off-centre weight. About 75mA at 3V, so drive it through a transistor or MOSFET with a flyback diode, like any motor.',
      volts: '2.5–3.5V typical (check your part); ~75mA running, more at start',
      fail: 'Straight from a GPIO it draws more than the pin can give and can damage the pin; the kickback when it stops can too. Running it at 5V shortens its life a lot.' },
    joystick: { how: 'Analog thumb joystick: two 10k potentiometers (X and Y) whose wipers sit at about half the supply when centred, plus a push switch to GND when you press the stick down. Read VRx and VRy with analogRead, SW with INPUT_PULLUP. Double-click to move the stick.',
      volts: 'Any supply up to 5V. Power it from the board\'s own logic voltage so the outputs stay inside the ADC range.',
      fail: 'Powered from 5V on a 3.3V board, the outputs go above 3.3V and can damage the ADC pin. Centre is rarely exactly 512: calibrate a dead zone. The SW pin floats without a pull-up.' },
    reed: { how: 'Two ferromagnetic reeds in a glass tube that touch when a magnet is near (door/window sensors). Double-click to bring the magnet close. Wire it like a button: pin to one side, GND to the other, INPUT_PULLUP.',
      volts: 'small reeds: ~100V, 0.5A switching',
      fail: 'The glass cracks if the leads are bent near the body. Inductive loads arc the contacts until they stick closed.' },
    cr2032: { how: 'A 3V lithium coin cell, ~220mAh, with a high internal resistance (10–40Ω). Great for µA-level loads (RTC, sleeping sensors); an LED pulls its voltage down noticeably.',
      volts: '3.0V nominal, ~2.0V when empty',
      fail: 'Pulsed loads above a few mA drop its voltage and waste capacity. Swallowed cells cause severe internal burns: keep them away from children.' },
    tmp36: { how: 'Analog temperature sensor: Vout = 0.5V + 10mV per °C (25°C → 0.75V), linear from −40 to +125°C. Double-click to set the temperature; read Vout on an analog pin and convert: °C = (volts − 0.5) × 100.',
      volts: '2.7–5.5V supply, ~50µA',
      fail: 'Reverse the supply and it heats instantly and dies (a bare silicon die with no protection). Above 5.5V the output stage is overstressed.',
      ratings: { pairs: [{ p: 'vcc', n: 'gnd', min: 2.7, max: 5.5, abs: 6.0 }] } },
    psu: { how: 'An ideal-ish bench supply: holds its set voltage until you draw more than its amp/watt rating, then the sim flags the overload (real supplies sag, trip, or burn).',
      volts: 'you choose — every connected part is checked against it',
      fail: 'Oversize the voltage and every downstream part is checked against its own rating — the safety strip lists exactly which ones object.' },
    bat9v: { how: 'A 9V PP3 battery: 9V EMF behind ~1.5Ω internal resistance. Great for smoke detectors, marginal for motors — the internal resistance eats the voltage under load.',
      volts: '9V nominal (drops under load)',
      fail: 'Shorted, it dumps ~6A through itself: the battery gets burning hot and can rupture. The sim calls this out as a short.' },
    bat4aa: { how: 'Four AA cells in series: 6V fresh, ~0.6Ω total internal resistance. The classic hobby-servo and breadboard pack.',
      volts: '6V fresh, ~4.8V near empty',
      fail: 'Shorts cook the cells; alkalines leak, NiMH can vent. Fuse packs that leave the bench.' },
    lipo: { how: 'A single lithium-polymer cell: 3.7V nominal, 4.2V full, very low internal resistance — it can source enormous current, which is exactly why it is dangerous.',
      volts: '3.0–4.2V over its charge curve',
      fail: 'Shorted or overdrawn it heats, swells, vents flammable electrolyte and can catch fire. ALWAYS fuse the lead; never charge unattended.' },
    reg7805: { how: 'A linear regulator: burns off the difference between IN and 5V as heat. Needs at least ~7V in to regulate; the canonical schematic adds the datasheet input/output capacitors.',
      volts: 'IN 7–25V → OUT 5V',
      fail: 'Past 25V in, the pass transistor breaks down. And the drop×current becomes heat: 12V→5V at 500mA is 3.5W — scorching without a heatsink (thermal shutdown if you are lucky).',
      ratings: { pairs: [{ p: 'in', n: 'gnd', min: 7, max: 25, abs: 35, name: 'IN' }] } },
    buck: { how: 'A switching step-down regulator: it chops the input at ~150kHz and filters it, so unlike a 7805 it wastes little power as heat (≈85–90% efficient). The trimpot sets OUT; double-click to set it. It needs about 1.5V more in than out.',
      volts: 'IN 4.5–40V → OUT 1.25–35V (adjustable), up to ~2A without a heatsink',
      fail: 'Past 40V on IN the LM2596 dies, often shorted. Many cheap modules ship with OUT set near IN — always measure OUT with a meter before connecting a board.',
      ratings: { pairs: [{ p: 'in', n: 'gnd', min: 4.5, max: 40, abs: 45, name: 'IN' }] } },
    lm317: { how: 'Adjustable linear regulator: it holds 1.25V between OUT and ADJ, so two resistors set the output: Vout = 1.25 × (1 + R2/R1), with R1 = 240Ω from OUT to ADJ. Double-click to set Vout. The difference between IN and OUT is burned as heat.',
      volts: 'Vout 1.25–37V; IN must be ~2V above OUT; up to 1.5A with a heatsink',
      fail: 'More than 40V between IN and OUT destroys it. Heat is (IN − OUT) × current: 12V→5V at 0.5A is 3.5W, far too much without a heatsink — it shuts down thermally, then cycles.',
      ratings: { pairs: [{ p: 'in', n: 'out', max: 37, abs: 40, name: 'IN–OUT' }] } },
    irrecv: { how: 'A photodiode, amplifier and 38kHz band-pass filter in one: it ignores sunlight and lamps and only answers a remote control. OUT sits HIGH and pulses LOW with each burst. Read it with the IRremote library. Double-click to press a remote button.',
      volts: 'VCC 2.7–5.5V, OUT is open-collector with an internal pull-up (matches the supply)',
      fail: 'Swapped VCC and GND (the pin order differs between makers: check the datasheet) kills it instantly. Long wires or a noisy supply cause phantom codes: add 100Ω + 10µF on VCC.',
      ratings: { pairs: [{ p: 'vcc', n: 'gnd', min: 2.7, max: 5.5, abs: 6 }] } },
    soil: { how: 'Measures moisture by capacitance through its coating, so unlike the bare two-prong probes it does not corrode. Wetter soil → lower voltage. Double-click to set the moisture. Calibrate: read it in dry air and in a glass of water, then map between the two.',
      volts: 'VCC 3.3–5.5V (onboard regulator), AOUT ≈ 1.2–2.8V — safe for 3.3V ADCs',
      fail: 'The electronics on top are not waterproof: push it in only up to the line. Cheap batches miss the regulator or have a wrong resistor; if readings drift with the supply, that is why.',
      ratings: { pairs: [{ p: 'vcc', n: 'gnd', min: 3.3, max: 5.5, abs: 6 }] } },
    pc817: { how: 'An LED and a phototransistor in one package with no electrical connection between them. Current through A→K lights the LED, which turns on C→E. Use it to switch a circuit with a separate ground (a 12V system, mains-side logic) from a GPIO.',
      volts: 'LED: Vf ≈ 1.2V, 5–20mA (50mA max); output: up to 35V C–E, 50mA',
      fail: 'Driving the LED without a series resistor burns it out (it is a 1.2V LED). The output only sinks a few mA times the CTR (50–600%), so it cannot drive a relay coil on its own.',
      ratings: { pairs: [{ p: 'col', n: 'emi', max: 35, abs: 35, name: 'C–E' }] } },
    pir: { how: 'Passive infrared motion sensor: two pyroelectric elements behind a Fresnel lens notice a warm body moving across the view. OUT goes HIGH (3.3V) for the delay set on its trimpot. Double-click to simulate motion. Give it ~30–60 s to settle after power-up.',
      volts: 'VCC 4.5–20V (onboard 3.3V regulator), OUT 3.3V logic — safe for 3.3V and 5V boards',
      fail: 'Reverse polarity on VCC destroys the onboard regulator. Fed from the board\'s 3.3V it will not start (it needs 4.5V or more on VCC).',
      ratings: { pairs: [{ p: 'vcc', n: 'gnd', min: 4.5, max: 20, abs: 24 }] } },
    reg33: { how: 'AMS1117-3.3 linear regulator: same idea as the 7805 but 3.3V out, ~1.1V dropout — feed it 4.5V or more.',
      volts: 'IN 4.5–15V → OUT 3.3V',
      fail: 'Past 15V absolute max the die punches through and it often fails SHORTED — passing full input voltage to your 3.3V parts. That is how one bad regulator kills a whole board.',
      ratings: { pairs: [{ p: 'in', n: 'gnd', min: 4.5, max: 15, abs: 18, name: 'IN' }] } },
    fuse: { how: 'A sacrificial wire: below its rating it is nearly a short; above it, it melts and opens the circuit. The sim blows it exactly like the real one.',
      volts: 'any — it cares about CURRENT (set its amp rating)',
      fail: 'It is supposed to die — that is the job. If a fuse keeps blowing, the fault is downstream of it.' },
    resistor: { how: 'Ohm\'s law in a package: I = V/R. Sets LED current, limits base current, pulls pins up or down, divides voltages.',
      volts: 'any (watch the wattage: V²/R)',
      fail: 'Past its wattage it browns, smokes, then opens. A 1/4W resistor across 12V needs ≥576Ω or it cooks.' },
    pot: { how: 'A resistor with a tap you slide: outer pins across a rail make the wiper a voltage divider (0..VCC). Read it on an analog pin.',
      volts: 'any within its wattage',
      fail: 'Wiring the WIPER to a rail with the track end grounded burns a track segment through the tiny wiper contact.' },
    ldr: { how: 'Light-dependent resistor: bright ≈ 1kΩ, dark ≈ 100kΩ. Pair with a fixed resistor as a divider and read the middle on an analog pin. Double-click to set its current resistance (i.e., the light level).',
      volts: 'any small signal',
      fail: 'Nearly indestructible at sensor currents; just don\'t use it as a power resistor.' },
    thermistor: { how: 'Temperature-dependent resistor (NTC 10k): resistance falls as it warms. Divider + analog pin + the Steinhart-Hart curve in code gives you °C. Double-click to set its current resistance.',
      volts: 'any small signal',
      fail: 'Self-heating: push real current through it and it reads its own dissipation, not the room.' },
    capC: { how: 'Ceramic capacitor: unpolarized, fast. 0.1µF across every chip\'s power pins is the single most effective noise fix in electronics. Blocks DC (the sim treats it as open).',
      volts: 'up to its rating, either way round',
      fail: 'Overvolted ceramics crack — often invisibly — and turn into intermittent shorts.' },
    capE: { how: 'Electrolytic capacitor: big storage for rails and motor surges. POLARIZED — the stripe is negative. The sim checks polarity and voltage rating (double-click to set it).',
      volts: 'up to its printed rating, + must stay above −',
      fail: 'Reverse it or overvolt it and the electrolyte boils: it swells, vents, and can pop like a firework. The sim flags reverse polarity as a danger.',
      },
    inductor: { how: 'A coil: resists changes in current. At DC it is nearly a wire (the sim models its winding resistance); its interesting behavior is switching/filtering — phase 2 transient sim territory.',
      volts: 'any; it cares about current and saturation',
      fail: 'Interrupt its current and it spikes voltage trying to keep flowing — that is why coils get flyback diodes.' },
    button: { how: 'A momentary switch: open until pressed. Double-click it on the canvas to press/release. Canonical hookup: pin to button to GND with INPUT_PULLUP in code — pressed reads LOW.',
      volts: 'any logic-level use',
      fail: 'Mechanical contacts bounce — debounce in code (or a 0.1µF across it) or one press counts as five.' },
    led: { how: 'A diode that emits light. Current flows anode→cathode once past the forward voltage — 1.8V for red up to ~3.2V for white/blue (each color is modeled). It does NOT limit its own current: the resistor does. Brightness on the canvas tracks real current.',
      volts: 'Vf 1.8–3.2V by color, ~20mA target',
      fail: 'No resistor means the LED is a near-short above Vf: current runs away, the junction cooks, brightness spikes then dies — sometimes with a crack. Reversed, it just stays dark (≤5V reverse is safe).' },
    diode: { how: '1N4001 rectifier: one-way valve, 0.7V toll. Blocks reverse voltage, steers current, snubs relay/motor kickback as a flyback diode.',
      volts: '0.7V forward drop, 50V reverse max',
      fail: 'Past 50V reverse it avalanches; past 1A continuous it overheats and fails — usually SHORTED, which then takes out what it was protecting.' },
    schottky: { how: 'Schottky diode: same valve, smaller toll (~0.3V) and faster. Use where the 0.7V loss hurts — power ORing, low-voltage rails.',
      volts: '0.3V forward drop',
      fail: 'Leakier in reverse than silicon, and reverse overvoltage kills it the same way.' },
    zener: { how: 'A diode designed to break down on purpose: forward it is a normal 0.7V diode; reversed it clamps at its zener voltage (5.1V here). Feed it through a resistor and the cathode node holds ~5.1V.',
      volts: 'clamps at 5.1V reversed',
      fail: 'The clamp only survives within its wattage: a 1W zener at 5.1V handles ~200mA — beyond that it burns open and the "protected" node floats up to the raw supply.' },
    npn: { how: 'NPN transistor as a low-side switch: small base current (through a resistor!) lets big collector→emitter current flow. Load lives between + and the collector; emitter to GND.',
      volts: 'base needs ~0.65V above emitter; 40V/800mA max (2N2222)',
      fail: 'No base resistor = the base-emitter junction is a diode straight to your pin: it draws whatever the pin can give and cooks the pin or the junction. Past 40V or 800mA the transistor itself lets go.' },
    pnp: { how: 'PNP transistor as a high-side switch: pull the base LOW (through a resistor) to let current flow emitter→collector from the + rail into the load.',
      volts: 'base ~0.65V below emitter to conduct',
      fail: 'Same failure modes as the NPN, mirrored. Watch that a 5V-rail PNP\'s base driven from a 3.3V pin never fully turns off — it needs the base near the rail.' },
    nmos: { how: 'Logic-level N-MOSFET: voltage-controlled low-side switch. Gate above ~2.2V turns the drain-source channel hard on (0.08Ω modeled) with essentially no gate current.',
      volts: 'gate 2.2V+ (logic-level); check Vds max on your part',
      fail: 'The gate oxide is nanometers thick: static or spikes past ±20V punch through it permanently. And a HALF-on MOSFET (gate at 1–2V) is a resistor — it dissipates and dies where fully-on would run cold.' },
    pmos: { how: 'Logic-level P-MOSFET: high-side switch. Source to +, gate pulled LOW turns it on; gate at the rail turns it off.',
      volts: 'gate 2.2V+ below source',
      fail: 'Same fragile gate. Driving a 12V-rail PMOS from a 5V pin leaves 7V gate-source when "off" — it never turns off and slowly cooks.' },
    relay: { how: 'An electromagnet throws real metal contacts: coil side (5V, ~70mA modeled) is completely isolated from the contact side. COM connects to NC at rest, snaps to NO when the coil energizes — the sim switches them for real. The canonical hookup includes the flyback diode.',
      volts: 'coil 5V; contacts rated to mains',
      fail: 'Coil kickback: cutting coil current spikes hundreds of volts backwards — without a flyback diode that spike kills your transistor or pin. The contact side can switch mains: shock hazard is real, keep fingers off COM/NO/NC.',
      },
    dcmotor: { how: 'Brushed DC motor: a few ohms of winding, so it draws amps at startup/stall — far beyond any GPIO or USB rail. Drive it through a transistor/driver from its own supply, always with a flyback diode.',
      volts: 'per motor (3–12V hobby range)',
      fail: 'Straight off a pin: the pin dies (40mA absolute max vs the amp it wants). Off the 5V rail: the board browns out and resets. No flyback diode: the kickback spike kills the driver.' },
    stepper: { how: 'Bipolar stepper: two coils (~2.4Ω each) energized in sequence to step the shaft. It has no idea of position — the DRIVER sequences it. Use an A4988 (or ULN2003 for the little 28BYJ-48).',
      volts: 'coils driven at 8–35V through a current-limiting driver',
      fail: 'Coils straight off pins pull far past absolute max — dead pins. Disconnecting a stepper WHILE the driver is powered kills the driver (the coil kickback has nowhere to go).' },
    servo: { how: 'Hobby servo: motor + gearbox + control loop in a box. Power from 5V (one servo max off USB), signal is a 50Hz pulse — the pulse width IS the position command.',
      volts: '4.8–6V power, logic-level signal',
      fail: 'Above ~6V the control board cooks. Stalled against an obstacle it draws near an amp continuously — browning out your rail and stripping gears.',
      ratings: { pairs: [{ p: 'vcc', n: 'gnd', min: 4.5, max: 6, abs: 7.2 }] } },
    buzzer: { how: 'Active buzzer: internal oscillator, just feed it DC (~30mA at 5V modeled). (A passive piezo instead wants a tone() square wave.)',
      volts: '3–5V typical',
      fail: 'Overvolted it distorts then the oscillator dies quietly. Reversed, most active buzzers simply stay silent.',
      ratings: { pairs: [{ p: 'pos', n: 'neg', min: 3, max: 5.5, abs: 8 }] } },
    uln2003: { how: 'Seven (here: four) Darlington switches in a chip with built-in flyback diodes to COM: logic input HIGH sinks the matching OUT to ground. Made for relay banks and the 28BYJ-48 stepper.',
      volts: 'logic in 2V+; outputs sink up to 500mA, COM up to 50V',
      fail: 'Each Darlington drops ~1V — at 500mA that is half a watt of heat per channel. Forget to wire COM to the load supply and the flyback diodes do nothing: kickback kills the chip.',
      ratings: { pairs: [{ p: 'com', n: 'gnd', min: 0, max: 50, abs: 50, name: 'COM' }] } },
    a4988: { how: 'Microstepping stepper driver: STEP pulses move one (micro)step, DIR sets direction, EN low enables. It CHOPS the motor supply to hold a set coil current — that is why it can run 2.4Ω coils from 12V without cooking them. The sim models the current-limited coil drive at DC (hold current).',
      volts: 'VMOT 8–35V (with a ≥47µF cap!), VDD logic 3–5.5V',
      fail: 'VMOT over 35V pops the driver instantly. No bulk capacitor: the supply inductance spikes past 35V on the first step — same result. Unplugging the motor while powered kills it. Set the current limit with the tiny pot or it either misses steps or bakes the motor.',
      ratings: { pairs: [{ p: 'vmot', n: 'gnd', min: 8, max: 35, abs: 36, name: 'VMOT' },
                         { p: 'vdd', n: 'gnd', min: 3, max: 5.5, abs: 6, name: 'VDD' }] } },
    hcsr04: { how: 'Ultrasonic sonar: 10µs pulse on Trig, it chirps at 40kHz and raises Echo for the round-trip time. Distance = duration/58 cm. A 5V part through and through.',
      volts: '4.5–5.5V — it genuinely needs 5V',
      fail: 'At 3.3V it fires weakly or not at all. Its ECHO output is 5V: feed that straight into a 3.3V board and you are over that pin\'s absolute max — divider or level shifter required (the sim checks 5V-into-3.3V).',
      ratings: { pairs: [{ p: 'vcc', n: 'gnd', min: 4.5, max: 5.5, abs: 6 }] } },
    dht22: { how: 'Temperature + humidity sensor speaking a one-wire-ish protocol on Data. Wants a 10k pull-up to VCC (in the canonical hookup) and no faster than one read per 2s.',
      volts: '3.3–6V',
      fail: 'Past ~6.5V the sensor die cooks and it reads nonsense forever after. Missing pull-up = intermittent checksum failures that look like software bugs.',
      ratings: { pairs: [{ p: 'vcc', n: 'gnd', min: 3, max: 6, abs: 6.5 }] } },
    oled: { how: 'SSD1306 OLED over I2C (address 0x3C): SDA/SCL to the board\'s I2C pins, pull-ups usually on the module. The panel itself is 3.3V; module regulators make most boards 5V-tolerant.',
      volts: '3.3–5V (module with regulator)',
      fail: 'A BARE 3.3V panel on 5V dies quickly. OLEDs also wear: pixels lit for months dim permanently — blank the display when idle.',
      ratings: { pairs: [{ p: 'vcc', n: 'gnd', min: 3, max: 5.5, abs: 6 }] } },
    neopixel: { how: 'WS2812 addressable LEDs: one data line clocks color down the chain. Canonical hookup per the datasheet: 300–500Ω into DIN, ≥1000µF across the supply, data level ≥0.7×VDD. Budget 60mA per pixel at full white.',
      volts: '3.5–5.3V supply; data must be ≥0.7×VDD',
      fail: 'Over 5.3V (or hot-plugging power) pops the first pixel — which then corrupts data for the whole strip. 3.3V data into a 5V strip is below spec: glitchy rainbows. 30 pixels at full white is 1.8A — plan the supply.',
      ratings: { pairs: [{ p: 'v5', n: 'gnd', min: 3.5, max: 5.3, abs: 5.5 }] } },
    generic: { how: 'A blank 4-pin part: stand-in for anything not modeled yet. It conducts nothing in the sim but holds wires and exports pin assignments.',
      volts: '—', fail: '—' },
    usbuart: { how: 'USB to 3.3V serial: your window into any device with a console — ESP bootloaders, Pi serial, IP cameras (thingino flashing). Lines CROSS: adapter TX → target RX. Grounds must be common; the target runs on its OWN power.',
      volts: '3.3V logic for cameras/ESP/Pi — if the adapter has a 5V jumper, it stays on 3.3V',
      fail: 'Set to 5V against a 3.3V console pad, the pad\'s protection diodes conduct until they don\'t — dead console, sometimes a dead SoC. Powering the target from the adapter\'s tiny regulator browns out mid-boot.' },
    ch341a: { how: 'The $3 USB flash programmer flashrom/thingino users live on: speaks SPI (and I2C) to read and write NOR flash, through a SOIC-8 clip or with the chip in the ZIF seat.',
      volts: 'supplies 3.3V and 5V rails — but STOCK boards drive the DATA lines at 5V. Do the well-known 3.3V mod (or use a 3.3V-fixed clone) before touching a camera\'s flash.',
      fail: 'Unmodified, its 5V logic stresses a 3.6V-max flash chip on every clock edge: corrupt dumps, flaky writes, and eventually a dead chip — while the 3.3V VCC pin lulls you into thinking it\'s fine.' },
    spiflash: { how: 'The SOIC-8 NOR chip (W25Q64/128 class) that holds a device\'s bootloader + firmware — this is what thingino replaces on a camera. Read/flash it over SPI; in-circuit with a clip works ONLY with the target board unpowered (the programmer back-powers the chip).',
      volts: '2.7–3.6V — never 5V, not even "briefly"',
      fail: 'Past 3.6V absolute max the die is damaged — the classic unmodded-CH341A casualty. Clipping it while the camera is powered has two masters driving one bus: corrupted flash, bricked camera (recoverable by reflashing).',
      ratings: { pairs: [{ p: 'vcc', n: 'gnd', min: 2.7, max: 3.6, abs: 4.0 }] } },
    ipcam: { how: 'An Ingenic-SoC IP camera as a bench target (thingino firmware). Console: 3.3V UART on the TX/RX/GND pads at 115200 8N1. Firmware lives in the SOIC-8 SPI flash. Install routes: serial + U-Boot, SD card (FAT32), USB cloner, or clip the flash directly.',
      volts: '5V (USB-style) or 12V (barrel) depending on the model — check the label; UART pads are 3.3V logic',
      fail: 'A 12V barrel into a 5V camera cooks the input DC-DC. A 5V UART adapter kills the console pads. Clipping the flash while powered corrupts it. All three are one careless Tuesday.',
      ratings: { pairs: [{ p: 'pwr', n: 'gnd', min: 4.75, max: 12.6, abs: 13.5, name: 'PWR' }] } },
    i2cmod: { how: 'A generic I2C breakout (this is what most modern sensor boards are — STEMMA QT / Qwiic connectors are I2C): VIN/GND power it, SDA/SCL carry data, several devices share the same two wires at different addresses.',
      volts: '3.3–5V (typical breakout with regulator + level shift)',
      fail: 'Check the specific board: RAW 3.3V-only chips die on 5V VIN. Missing pull-ups (rare on breakouts) = a hung bus that reads as the sketch freezing.',
      ratings: { pairs: [{ p: 'vcc', n: 'gnd', min: 3, max: 5.5, abs: 6 }] } },
    spimod: { how: 'A generic SPI breakout: faster than I2C, one CS line per device. SCK/MOSI/MISO shared, CS selects this device.',
      volts: '3.3–5V (check the specific board)',
      fail: 'MISO contention: two devices with CS both low fight over the line — nothing burns immediately but the bus reads garbage.',
      ratings: { pairs: [{ p: 'vcc', n: 'gnd', min: 3, max: 5.5, abs: 6 }] } },
    uartmod: { how: 'A serial device: its TX crosses to the board\'s RX and vice versa. Only one UART device per hardware serial port (or use SoftwareSerial).',
      volts: '3.3–5V logic (check the specific board)',
      fail: 'TX-to-TX (uncrossed) just doesn\'t work. A 5V TX into a 3.3V-only RX pin overdrives it — divider it.',
      ratings: { pairs: [{ p: 'vcc', n: 'gnd', min: 3, max: 5.5, abs: 6 }] } },
    analogmod: { how: 'A sensor with a voltage output: read OUT on an analog pin. Its output can never exceed its supply, so power it from the board\'s logic voltage to keep the ADC happy.',
      volts: '3.3–5V (check the specific board)',
      fail: 'Powered at 5V on a 3.3V board, its OUT can reach 5V — past the ADC pin\'s absolute max. Power it from 3V3 instead.',
      ratings: { pairs: [{ p: 'vcc', n: 'gnd', min: 3, max: 5.5, abs: 6 }] } }
  };

  // ---- canonical hookups: the schematic, in canvas-native form --------------
  // Wire spec grammar (resolved against the CURRENT board by wiring.js):
  //   'pin:A|B|C'  first telemetry-capable board pin whose label matches
  //   '5v' 'gnd' '3v3' 'vin'   board power pins ('3v3' falls back to 5v etc.)
  //   'pN:port'    port on the Nth part placed by this hookup
  // Every entry is validated by the test suite: parts exist, ports exist.
  const HOOKUPS = {
    voltmeter: { note: 'Measuring the LED drop: V+ on the anode, COM on the cathode. Run the sim to read it.',
      parts: [{ type: 'voltmeter' }, { type: 'resistor', r: 220 }, { type: 'led' }],
      wires: [['pin:~9|9|GP15|D1/G5|25', 'p1:a'], ['p1:b', 'p2:anode'], ['p2:cathode', 'gnd'],
              ['p0:pos', 'p2:anode'], ['p0:neg', 'p2:cathode']] },
    ammeter: { note: 'The meter sits IN the loop, between resistor and LED: all the current goes through it.',
      parts: [{ type: 'ammeter' }, { type: 'resistor', r: 220 }, { type: 'led' }],
      wires: [['pin:~9|9|GP15|D1/G5|25', 'p1:a'], ['p1:b', 'p0:pos'], ['p0:neg', 'p2:anode'], ['p2:cathode', 'gnd']] },
    lm35: { note: 'Vout to A0 on a 5V board. °C = analogRead(A0) × 5.0 / 1023 × 100.',
      parts: [{ type: 'lm35', tempC: 25 }],
      wires: [['p0:out', 'pin:A0|GP26/A0|A0/26|A0/GP26|26'], ['5v', 'p0:vcc'], ['gnd', 'p0:gnd']] },
    lm317: { note: '12V in, LM317 set to 5V out, LED load. On the real board R1 = 240Ω (OUT→ADJ) and R2 = 720Ω (ADJ→GND) give 5V.',
      parts: [{ type: 'psu', volts: 12 }, { type: 'lm317', vout: 5 }, { type: 'resistor', r: 330 }, { type: 'led' }],
      wires: [['p0:pos', 'p1:in'], ['p0:neg', 'p1:gnd'], ['p1:out', 'p2:a'], ['p2:b', 'p3:anode'], ['p3:cathode', 'p1:gnd']] },
    irrecv: { note: 'OUT to pin 11 (IRremote\'s usual pin), VCC 5V, GND. digitalRead is LOW during a remote\'s burst.',
      parts: [{ type: 'irrecv' }],
      wires: [['p0:out', 'pin:11|GP15|D11/G12|25'], ['5v', 'p0:vcc'], ['gnd', 'p0:gnd']] },
    soil: { note: 'AOUT to A0, VCC 5V (3.3V works too). Lower readings = wetter soil.',
      parts: [{ type: 'soil', moisture: 40 }],
      wires: [['p0:out', 'pin:A0|GP26/A0|A0/26|A0/GP26|26'], ['5v', 'p0:vcc'], ['gnd', 'p0:gnd']] },
    pir: { note: 'VCC to 5V, OUT to pin 2 (3.3V logic, safe for any board). digitalRead(2) is HIGH while there is motion.',
      parts: [{ type: 'pir' }],
      wires: [['5v', 'p0:vcc'], ['p0:out', 'pin:2|GP16|D2/G4|26'], ['gnd', 'p0:gnd']] },
    pc817: { note: 'Pin 7 lights the opto LED through 330Ω; the isolated side pulls pin 2 (INPUT_PULLUP) low through C–E. Swap that side for any circuit with its own ground.',
      parts: [{ type: 'pc817' }, { type: 'resistor', r: 330 }],
      wires: [['pin:7|GP11|D7/G13|27', 'p1:a'], ['p1:b', 'p0:anode'], ['p0:cathode', 'gnd'],
              ['pin:2|GP16|D2/G4|26', 'p0:col'], ['p0:emi', 'gnd']] },
    buck: { note: '12V supply stepped down to 5V for the board and servos. Set OUT before connecting anything.',
      parts: [{ type: 'psu', volts: 12 }, { type: 'buck', vout: 5 }, { type: 'resistor', r: 330 }, { type: 'led' }],
      wires: [['p0:pos', 'p1:in'], ['p0:neg', 'p1:gnd'], ['p1:out', 'p2:a'], ['p2:b', 'p3:anode'], ['p3:cathode', 'p1:gnd']] },
    hall: { note: 'VCC to 5V, OUT to pin 2 with INPUT_PULLUP. Reads LOW when a magnet\'s south pole is at the printed face. Needs 4.5V or more on VCC.',
      parts: [{ type: 'hall' }],
      wires: [['5v', 'p0:vcc'], ['gnd', 'p0:gnd'], ['p0:out', 'pin:2|GP16|D2/G4|26']] },
    tilt: { note: 'Pin 2 to one leg, GND to the other, INPUT_PULLUP. LOW = upright, HIGH = tipped.',
      parts: [{ type: 'tilt', closed: true }],
      wires: [['pin:2|GP16|D2/G4|26', 'p0:a'], ['p0:b', 'gnd']] },
    solar: { note: 'A blocking Schottky diode so nothing flows back into the panel; the meter shows what it delivers. Double-click the panel to change the light.',
      parts: [{ type: 'solar' }, { type: 'schottky' }, { type: 'voltmeter' }],
      wires: [['p0:pos', 'p1:anode'], ['p1:cathode', 'p2:pos'], ['p2:neg', 'p0:neg']] },
    mq2: { note: 'VCC to 5V (the heater draws ~150mA), AOUT to A0, DOUT to pin 2. On a 3.3V board add dividers on AOUT and DOUT first. Let it warm up for a few minutes.',
      parts: [{ type: 'mq2' }],
      wires: [['5v', 'p0:vcc'], ['gnd', 'p0:gnd'], ['p0:aout', 'pin:A0|GP26/A0|A0/26|32'], ['p0:dout', 'pin:2|GP16|D2/G4|26']] },
    tp4056: { note: '5V into IN+/IN−, the cell on B+/B−. The default 1A charge suits cells of 1000mAh or more.',
      parts: [{ type: 'psu', volts: 5, amps: 2 }, { type: 'tp4056' }, { type: 'lipo' }],
      wires: [['p0:pos', 'p1:inp'], ['p0:neg', 'p1:inn'], ['p1:batp', 'p2:pos'], ['p1:batn', 'p2:neg']] },
    vibmotor: { note: 'Pin 9 → 1k → NPN base; motor from 5V into the collector, flyback diode across the motor. analogWrite sets the strength.',
      parts: [{ type: 'resistor', r: 1000 }, { type: 'npn' }, { type: 'vibmotor' }, { type: 'diode' }],
      wires: [['pin:~9|9|GP15|D1/G5|25', 'p0:a'], ['p0:b', 'p1:b'], ['5v', 'p2:pos'], ['p2:neg', 'p1:c'], ['p1:e', 'gnd'],
              ['p3:cathode', 'p2:pos'], ['p3:anode', 'p2:neg']] },
    joystick: { note: 'Powered from 3.3V so it is safe on every board (on a 5V board, 5V gives the full 0–1023). VRx → A0, VRy → A1, SW → pin 2 with INPUT_PULLUP.',
      parts: [{ type: 'joystick' }],
      wires: [['3v3', 'p0:vcc'], ['gnd', 'p0:gnd'], ['p0:vrx', 'pin:A0|GP26/A0|A0/26|32'], ['p0:vry', 'pin:A1|GP27/A1|A1/25|33'],
              ['p0:sw', 'pin:2|GP16|D2/G4|26']] },
    reed: { note: 'Door sensor: pin 2 to the reed, other side to GND, INPUT_PULLUP. Reads LOW when the magnet is near.',
      parts: [{ type: 'reed' }],
      wires: [['pin:2|GP16|D2/G4|26', 'p0:a'], ['p0:b', 'gnd']] },
    slide: { note: 'COM to pin 2, A to GND, B to 5V: the pin reads LOW or HIGH depending on the switch.',
      parts: [{ type: 'slide' }],
      wires: [['pin:2|GP16|D2/G4|26', 'p0:com'], ['p0:a', 'gnd'], ['p0:b', '5v']] },
    cr2032: { note: 'A coin cell lighting an LED directly — its internal resistance limits the current.',
      parts: [{ type: 'cr2032' }, { type: 'led', color: 'red' }],
      wires: [['p0:pos', 'p1:anode'], ['p1:cathode', 'p0:neg']] },
    tmp36: { note: 'Vout to A0. °C = (analogRead(A0) × VREF / 1023 − 0.5) × 100. A 0.1µF cap at the supply pins steadies readings.',
      parts: [{ type: 'tmp36', tempC: 25 }, { type: 'capC' }],
      wires: [['p0:out', 'pin:A0|GP26/A0|A0/26|A0/GP26|26'], ['5v', 'p0:vcc'], ['gnd', 'p0:gnd'], ['p1:a', 'p0:vcc'], ['p1:b', 'p0:gnd']] },
    psu: { note: 'Set volts/amps by double-clicking the supply. Demo load: 330Ω into an LED.',
      parts: [{ type: 'psu', volts: 5, amps: 1 }, { type: 'resistor', r: 330 }, { type: 'led' }],
      wires: [['p0:pos', 'p1:a'], ['p1:b', 'p2:anode'], ['p2:cathode', 'p0:neg']] },
    bat9v: { note: 'A 9V battery regulated down to 5V by a 7805 — the classic portable rail.',
      parts: [{ type: 'bat9v' }, { type: 'reg7805' }, { type: 'capC' }, { type: 'capE' }, { type: 'resistor', r: 330 }, { type: 'led' }],
      wires: [['p0:pos', 'p1:in'], ['p0:neg', 'p1:gnd'], ['p2:a', 'p1:in'], ['p2:b', 'p1:gnd'],
              ['p3:pos', 'p1:out'], ['p3:neg', 'p1:gnd'], ['p1:out', 'p4:a'], ['p4:b', 'p5:anode'], ['p5:cathode', 'p1:gnd']] },
    bat4aa: { note: '6V pack lighting an LED through a resistor.',
      parts: [{ type: 'bat4aa' }, { type: 'resistor', r: 220 }, { type: 'led' }],
      wires: [['p0:pos', 'p1:a'], ['p1:b', 'p2:anode'], ['p2:cathode', 'p0:neg']] },
    lipo: { note: 'ALWAYS fuse the lead — a shorted LiPo is a fire, not a mistake.',
      parts: [{ type: 'lipo' }, { type: 'fuse', r: 2 }, { type: 'resistor', r: 100 }, { type: 'led' }],
      wires: [['p0:pos', 'p1:a'], ['p1:b', 'p2:a'], ['p2:b', 'p3:anode'], ['p3:cathode', 'p0:neg']] },
    reg7805: { note: 'Datasheet hookup: 9V in, caps on both sides, 5V out into a demo load.',
      parts: [{ type: 'reg7805' }, { type: 'bat9v' }, { type: 'capC' }, { type: 'capE' }, { type: 'resistor', r: 330 }, { type: 'led' }],
      wires: [['p1:pos', 'p0:in'], ['p1:neg', 'p0:gnd'], ['p2:a', 'p0:in'], ['p2:b', 'p0:gnd'],
              ['p3:pos', 'p0:out'], ['p3:neg', 'p0:gnd'], ['p0:out', 'p4:a'], ['p4:b', 'p5:anode'], ['p5:cathode', 'p0:gnd']] },
    reg33: { note: 'Making a clean 3.3V from the board\'s 5V rail.',
      parts: [{ type: 'reg33' }, { type: 'capC' }, { type: 'resistor', r: 150 }, { type: 'led' }],
      wires: [['5v', 'p0:in'], ['gnd', 'p0:gnd'], ['p1:a', 'p0:out'], ['p1:b', 'p0:gnd'],
              ['p0:out', 'p2:a'], ['p2:b', 'p3:anode'], ['p3:cathode', 'gnd']] },
    fuse: { note: 'The fuse sits in the + lead, before anything else. Rate it just above normal draw.',
      parts: [{ type: 'psu', volts: 12, amps: 2 }, { type: 'fuse', r: 1 }, { type: 'resistor', r: 47 }],
      wires: [['p0:pos', 'p1:a'], ['p1:b', 'p2:a'], ['p2:b', 'p0:neg']] },
    resistor: { note: 'The hello-world: pin → 220Ω → LED → GND. The resistor sets ~14mA.',
      parts: [{ type: 'resistor', r: 220 }, { type: 'led' }],
      wires: [['pin:~9|9|GP15|D1/G5|25', 'p0:a'], ['p0:b', 'p1:anode'], ['p1:cathode', 'gnd']] },
    pot: { note: 'Outer legs across the rail, wiper to an analog pin: a knob from 0 to VCC.',
      parts: [{ type: 'pot' }],
      wires: [['5v', 'p0:vcc'], ['gnd', 'p0:gnd'], ['p0:wiper', 'pin:A0|GP26/A0|25|32']] },
    ldr: { note: 'Divider: bright pulls the analog pin high. Swap positions to invert.',
      parts: [{ type: 'ldr', r: 10000 }, { type: 'resistor', r: 10000 }],
      wires: [['5v', 'p0:a'], ['p0:b', 'p1:a'], ['p1:b', 'gnd'], ['p0:b', 'pin:A0|GP26/A0|25|32']] },
    thermistor: { note: '10k NTC + 10k fixed = a temperature divider on the analog pin.',
      parts: [{ type: 'thermistor', r: 10000 }, { type: 'resistor', r: 10000 }],
      wires: [['5v', 'p0:a'], ['p0:b', 'p1:a'], ['p1:b', 'gnd'], ['p0:b', 'pin:A0|GP26/A0|25|32']] },
    capC: { note: 'Decoupling: 0.1µF straight across a load\'s power pins, as close as possible.',
      parts: [{ type: 'capC' }, { type: 'oled' }],
      wires: [['5v', 'p1:vcc'], ['gnd', 'p1:gnd'], ['p0:a', 'p1:vcc'], ['p0:b', 'p1:gnd'],
              ['pin:SDA|A4|GP4|21|D2/G4', 'p1:sda'], ['pin:SCL|A5|GP5|22|D1/G5', 'p1:scl']] },
    capE: { note: 'Bulk storage across the rail — stripe (−) to GND. Double-click to set its voltage rating.',
      parts: [{ type: 'capE', vr: 16 }],
      wires: [['5v', 'p0:pos'], ['gnd', 'p0:neg']] },
    inductor: { note: 'In series with a load at DC it is nearly a wire — its story is switching (phase 2).',
      parts: [{ type: 'inductor' }, { type: 'resistor', r: 100 }],
      wires: [['5v', 'p0:a'], ['p0:b', 'p1:a'], ['p1:b', 'gnd']] },
    button: { note: 'Pin to button to GND, INPUT_PULLUP in code: pressed reads LOW. No external resistor needed.',
      parts: [{ type: 'button' }],
      wires: [['pin:2|GP16|D2/G4|26', 'p0:a'], ['p0:b', 'gnd']] },
    led: { note: 'Anode (+, long leg) toward the pin, resistor always in the loop.',
      parts: [{ type: 'resistor', r: 220 }, { type: 'led' }],
      wires: [['pin:~9|9|GP15|D1/G5|25', 'p0:a'], ['p0:b', 'p1:anode'], ['p1:cathode', 'gnd']] },
    diode: { note: 'Flyback duty: cathode to +, anode to the switched side, straight across the coil.',
      parts: [{ type: 'relay' }, { type: 'diode' }],
      wires: [['5v', 'p0:coilp'], ['pin:7|GP11|D7/G13|27', 'p0:coiln'],
              ['p1:cathode', 'p0:coilp'], ['p1:anode', 'p0:coiln']] },
    schottky: { note: 'Reverse-polarity guard: battery + through the Schottky into the load — only 0.3V lost.',
      parts: [{ type: 'bat4aa' }, { type: 'schottky' }, { type: 'resistor', r: 100 }],
      wires: [['p0:pos', 'p1:anode'], ['p1:cathode', 'p2:a'], ['p2:b', 'p0:neg']] },
    zener: { note: 'Crude 5.1V reference: 12V through 470Ω, zener clamps the tap (cathode up).',
      parts: [{ type: 'psu', volts: 12, amps: 0.5 }, { type: 'resistor', r: 470 }, { type: 'zener' }],
      wires: [['p0:pos', 'p1:a'], ['p1:b', 'p2:cathode'], ['p2:anode', 'p0:neg']] },
    npn: { note: 'Low-side switch: pin → 1k → base, load from 5V to collector, emitter to GND.',
      parts: [{ type: 'resistor', r: 1000 }, { type: 'npn' }, { type: 'buzzer' }],
      wires: [['pin:7|GP11|D7/G13|27', 'p0:a'], ['p0:b', 'p1:b'],
              ['5v', 'p2:pos'], ['p2:neg', 'p1:c'], ['p1:e', 'gnd']] },
    pnp: { note: 'High-side switch: emitter to 5V, pin → 1k → base (LOW = on), load from collector to GND.',
      parts: [{ type: 'resistor', r: 1000 }, { type: 'pnp' }, { type: 'buzzer' }],
      wires: [['pin:7|GP11|D7/G13|27', 'p0:a'], ['p0:b', 'p1:b'],
              ['5v', 'p1:e'], ['p1:c', 'p2:pos'], ['p2:neg', 'gnd']] },
    nmos: { note: 'Gate straight to the pin (MOSFETs take no current), load between 5V and drain, source to GND.',
      parts: [{ type: 'nmos' }, { type: 'buzzer' }],
      wires: [['pin:~9|9|GP15|D1/G5|25', 'p0:g'], ['5v', 'p1:pos'], ['p1:neg', 'p0:d'], ['p0:s', 'gnd']] },
    pmos: { note: 'High-side MOSFET: source to 5V, load from drain to GND, pin LOW turns it on.',
      parts: [{ type: 'pmos' }, { type: 'buzzer' }],
      wires: [['pin:~9|9|GP15|D1/G5|25', 'p0:g'], ['5v', 'p0:s'], ['p0:d', 'p1:pos'], ['p1:neg', 'gnd']] },
    relay: { note: 'Coil from 5V, pin sinks the coil (transistor-module style), flyback diode across the coil. Contacts switch the big stuff — carefully.',
      parts: [{ type: 'relay' }, { type: 'diode' }],
      wires: [['5v', 'p0:coilp'], ['pin:7|GP11|D7/G13|27', 'p0:coiln'],
              ['p1:cathode', 'p0:coilp'], ['p1:anode', 'p0:coiln']] },
    dcmotor: { note: 'Motor on its OWN supply through an NPN, flyback diode across the motor. Never off a pin.',
      parts: [{ type: 'psu', volts: 6, amps: 2 }, { type: 'resistor', r: 1000 }, { type: 'npn' }, { type: 'dcmotor' }, { type: 'diode' }],
      wires: [['pin:~9|9|GP15|D1/G5|25', 'p1:a'], ['p1:b', 'p2:b'],
              ['p0:pos', 'p3:pos'], ['p3:neg', 'p2:c'], ['p2:e', 'p0:neg'], ['p2:e', 'gnd'],
              ['p4:cathode', 'p3:pos'], ['p4:anode', 'p3:neg']] },
    stepper: { note: 'Bipolar stepper the right way: A4988 with 12V motor supply. STEP/DIR from pins.',
      parts: [{ type: 'a4988' }, { type: 'stepper' }, { type: 'psu', volts: 12, amps: 2 }, { type: 'capE', vr: 35 }],
      wires: [['pin:2|GP16|D2/G4|26', 'p0:step'], ['pin:~3|3|GP17|D3/G0|27', 'p0:dir'],
              ['5v', 'p0:vdd'], ['gnd', 'p0:gnd'],
              ['p2:pos', 'p0:vmot'], ['p2:neg', 'p0:gnd'],
              ['p3:pos', 'p0:vmot'], ['p3:neg', 'p0:gnd'],
              ['p0:o1a', 'p1:a1'], ['p0:o1b', 'p1:a2'], ['p0:o2a', 'p1:b1'], ['p0:o2b', 'p1:b2']] },
    servo: { note: 'Signal on a PWM pin, power from 5V. ONE servo max off USB — more need their own 5–6V supply.',
      parts: [{ type: 'servo' }],
      wires: [['pin:~9|9|GP15|D1/G5|25', 'p0:sig'], ['5v', 'p0:vcc'], ['gnd', 'p0:gnd']] },
    buzzer: { note: 'Active buzzer straight off a pin is fine (~30mA at 5V is over the 20mA comfort line — the sim will note it; a transistor is kinder).',
      parts: [{ type: 'buzzer' }],
      wires: [['pin:8|GP12|D5/G14|26', 'p0:pos'], ['p0:neg', 'gnd']] },
    uln2003: { note: '28BYJ-48 stepper on the classic driver: pins 8–11 → IN1–4, COM to 5V.',
      parts: [{ type: 'uln2003' }, { type: 'stepper' }],
      wires: [['pin:8|GP12|D5/G14|26', 'p0:in1'], ['pin:~9|9|GP13|D6/G12|25', 'p0:in2'],
              ['pin:~10|10|GP14|D7/G13|33', 'p0:in3'], ['pin:~11|11|GP15|D8/G15|32', 'p0:in4'],
              ['p0:out1', 'p1:a1'], ['p0:out2', 'p1:a2'], ['p0:out3', 'p1:b1'], ['p0:out4', 'p1:b2'],
              ['5v', 'p0:com'], ['gnd', 'p0:gnd']] },
    a4988: { note: 'VMOT 8–35V with the bulk cap RIGHT at the pins, VDD from board logic, stepper on 1A/1B/2A/2B.',
      parts: [{ type: 'a4988' }, { type: 'psu', volts: 12, amps: 2 }, { type: 'capE', vr: 35 }, { type: 'stepper' }],
      wires: [['pin:2|GP16|D2/G4|26', 'p0:step'], ['pin:~3|3|GP17|D3/G0|27', 'p0:dir'],
              ['5v', 'p0:vdd'], ['gnd', 'p0:gnd'],
              ['p1:pos', 'p0:vmot'], ['p1:neg', 'p0:gnd'],
              ['p2:pos', 'p0:vmot'], ['p2:neg', 'p0:gnd'],
              ['p0:o1a', 'p3:a1'], ['p0:o1b', 'p3:a2'], ['p0:o2a', 'p3:b1'], ['p0:o2b', 'p3:b2']] },
    hcsr04: { note: 'Trig pin 5, Echo pin 6. Echo is a 5V output — level-shift it on 3.3V boards.',
      parts: [{ type: 'hcsr04' }],
      wires: [['pin:~5|5|GP2|D1/G5|25', 'p0:trig'], ['pin:~6|6|GP3|D2/G4|26', 'p0:echo'],
              ['5v', 'p0:vcc'], ['gnd', 'p0:gnd']] },
    dht22: { note: 'Data on pin 4 with the 10k pull-up to VCC the datasheet asks for.',
      parts: [{ type: 'dht22' }, { type: 'resistor', r: 10000 }],
      wires: [['pin:4|GP6|D4/G2|26', 'p0:data'], ['5v', 'p0:vcc'], ['gnd', 'p0:gnd'],
              ['p1:a', 'p0:vcc'], ['p1:b', 'p0:data']] },
    oled: { note: 'SDA/SCL to the board\'s I2C pins. Address 0x3C in code.',
      parts: [{ type: 'oled' }],
      wires: [['pin:SDA|A4|GP4|21|D2/G4', 'p0:sda'], ['pin:SCL|A5|GP5|22|D1/G5', 'p0:scl'],
              ['5v', 'p0:vcc'], ['gnd', 'p0:gnd']] },
    neopixel: { note: 'Datasheet hookup: 470Ω into DIN, 1000µF across the supply, common ground. 60mA/pixel at full white.',
      parts: [{ type: 'neopixel' }, { type: 'resistor', r: 470 }, { type: 'capE', vr: 16 }],
      wires: [['pin:~6|6|GP3|D4/G2|26', 'p1:a'], ['p1:b', 'p0:din'],
              ['5v', 'p0:v5'], ['gnd', 'p0:gnd'],
              ['p2:pos', 'p0:v5'], ['p2:neg', 'p0:gnd']] },
    usbuart: { note: 'Console at 115200 8N1. Lines cross (TX→RX), grounds common, and the camera runs on its OWN supply — never off the adapter.',
      parts: [{ type: 'usbuart' }, { type: 'ipcam' }, { type: 'psu', volts: 12, amps: 1 }],
      wires: [['p0:tx', 'p1:rx'], ['p0:rx', 'p1:tx'], ['p0:gnd', 'p1:gnd'],
              ['p2:pos', 'p1:pwr'], ['p2:neg', 'p1:gnd']] },
    ch341a: { note: 'SOIC-8 clip wiring, target UNPOWERED. WP and HOLD tie high. 3.3V-modded programmer only.',
      parts: [{ type: 'ch341a' }, { type: 'spiflash' }],
      wires: [['p0:cs', 'p1:cs'], ['p0:clk', 'p1:clk'], ['p0:mosi', 'p1:di'], ['p0:miso', 'p1:do'],
              ['p0:v33', 'p1:vcc'], ['p0:gnd', 'p1:gnd'],
              ['p1:wp', 'p1:vcc'], ['p1:hold', 'p1:vcc']] },
    spiflash: { note: 'Dump/flash rig: CH341A (3.3V-modded!) through the clip, WP/HOLD high, target board unpowered.',
      parts: [{ type: 'spiflash' }, { type: 'ch341a' }],
      wires: [['p1:cs', 'p0:cs'], ['p1:clk', 'p0:clk'], ['p1:mosi', 'p0:di'], ['p1:miso', 'p0:do'],
              ['p1:v33', 'p0:vcc'], ['p1:gnd', 'p0:gnd'],
              ['p0:wp', 'p0:vcc'], ['p0:hold', 'p0:vcc']] },
    ipcam: { note: 'thingino bench: 3.3V UART console (crossed) + the camera\'s own supply. Flash lives in the SOIC-8 — SD/serial/clip methods per thingino.com.',
      parts: [{ type: 'ipcam' }, { type: 'usbuart' }, { type: 'psu', volts: 12, amps: 1 }],
      wires: [['p1:tx', 'p0:rx'], ['p1:rx', 'p0:tx'], ['p1:gnd', 'p0:gnd'],
              ['p2:pos', 'p0:pwr'], ['p2:neg', 'p0:gnd']] },
    i2cmod: { note: 'The universal modern-breakout hookup: power + two shared bus wires. Daisy-chain more I2C devices on the same pins.',
      parts: [{ type: 'i2cmod' }],
      wires: [['pin:SDA|A4|GP4|21|D2/G4', 'p0:sda'], ['pin:SCL|A5|GP5|22|D1/G5', 'p0:scl'],
              ['3v3', 'p0:vcc'], ['gnd', 'p0:gnd']] },
    spimod: { note: 'SCK/MOSI/MISO are the shared bus; CS is this device\'s own select line.',
      parts: [{ type: 'spimod' }],
      wires: [['pin:13|GP18|D5/G14|18', 'p0:sck'], ['pin:~11|11|GP19|D7/G13|23', 'p0:mosi'],
              ['pin:12|GP16|D6/G12|19', 'p0:miso'], ['pin:~10|10|GP17|D8/G15|5', 'p0:cs'],
              ['3v3', 'p0:vcc'], ['gnd', 'p0:gnd']] },
    uartmod: { note: 'Cross the lines: device TX → board RX, device RX → board TX.',
      parts: [{ type: 'uartmod' }],
      wires: [['pin:RX0|GP1|RX/G3|3', 'p0:tx'], ['pin:TX1|GP0|TX/G1|1', 'p0:rx'],
              ['3v3', 'p0:vcc'], ['gnd', 'p0:gnd']] },
    analogmod: { note: 'OUT to an analog pin. Power from the board\'s logic voltage so the output can never exceed the ADC range.',
      parts: [{ type: 'analogmod' }],
      wires: [['p0:out', 'pin:A0|GP26/A0|25|32'], ['3v3', 'p0:vcc'], ['gnd', 'p0:gnd']] }
  };

  // Curated multi-part circuits, kept from before (recipes menu).
  const RECIPES = [
    { name: 'LED + resistor', desc: 'pin 9 → 220Ω → LED → GND. The hello world.', use: 'led' },
    { name: 'Button (pull-up)', desc: 'pin 2 to button to GND — use INPUT_PULLUP in code.', use: 'button' },
    { name: 'Motion sensor (PIR)', desc: 'HC-SR501 on pin 2 — HIGH while something moves.', use: 'pir' },
    { name: 'Isolated input (PC817)', desc: 'optocoupler: a pin drives the LED, the isolated side pulls pin 2 low.', use: 'pc817' },
    { name: 'Remote control (IR)', desc: 'VS1838B receiver on pin 11 for the IRremote library.', use: 'irrecv' },
    { name: 'Plant watering sensor', desc: 'capacitive soil moisture sensor into A0.', use: 'soil' },
    { name: '12V → 5V (LM317)', desc: 'adjustable linear regulator, the classic way.', use: 'lm317' },
    { name: '12V → 5V buck', desc: 'LM2596 module stepping a 12V supply down for the board.', use: 'buck' },
    { name: 'Magnet sensor (Hall)', desc: 'A3144 on pin 2 with INPUT_PULLUP, LOW when a magnet is near.', use: 'hall' },
    { name: 'Tilt alarm', desc: 'SW-520D ball switch on pin 2: HIGH when tipped over.', use: 'tilt' },
    { name: 'Solar panel', desc: '6V panel through a blocking diode, with a meter to watch the output.', use: 'solar' },
    { name: 'Gas / smoke sensor', desc: 'MQ-2 module into A0 and pin 2 (needs a real 5V supply).', use: 'mq2' },
    { name: 'LiPo charger', desc: 'TP4056 charging a 3.7V cell from 5V.', use: 'tp4056' },
    { name: 'Vibration motor', desc: 'coin motor switched by an NPN from pin 9, with a flyback diode.', use: 'vibmotor' },
    { name: 'Joystick', desc: 'two axes into A0/A1 and the press button on pin 2.', use: 'joystick' },
    { name: 'Door sensor (reed)', desc: 'reed switch on pin 2 with INPUT_PULLUP — bring the magnet near.', use: 'reed' },
    { name: 'Slide switch', desc: 'SPDT: COM to pin 2, sides to GND and 5V — a clean HIGH/LOW selector.', use: 'slide' },
    { name: 'Temperature (LM35)', desc: '10mV/°C sensor into A0 on a 5V board.', use: 'lm35' },
    { name: 'Servo', desc: 'signal on pin 9, powered from 5V. One servo max off USB.', use: 'servo' },
    { name: 'Stepper + A4988', desc: 'STEP/DIR driver with 12V motor supply — the right way.', use: 'a4988' },
    { name: 'Stepper + ULN2003', desc: '28BYJ-48 hookup: pins 8–11 → IN1–4.', use: 'uln2003' },
    { name: 'NPN drives a load', desc: 'pin → 1k → base; load on the collector; emitter to GND.', use: 'npn' },
    { name: 'Relay + flyback diode', desc: 'coil from 5V, pin sinks it, diode across the coil.', use: 'relay' },
    { name: 'DC motor, done right', desc: 'own supply + NPN + flyback diode.', use: 'dcmotor' },
    { name: 'OLED (I2C)', desc: 'SDA/SCL to the board I2C pins.', use: 'oled' },
    { name: 'HC-SR04 sonar', desc: 'Trig 5, Echo 6. Echo is 5V — level-shift on 3.3V boards.', use: 'hcsr04' },
    { name: 'DHT22 sensor', desc: 'data on pin 4 with a 10k pull-up.', use: 'dht22' },
    { name: 'NeoPixel strip', desc: '470Ω into DIN, 1000µF across the rail.', use: 'neopixel' },
    { name: 'Light meter (LDR)', desc: 'divider into A0 — bright reads high.', use: 'ldr' },
    { name: 'Knob (potentiometer)', desc: 'wiper into A0: 0..VCC.', use: 'pot' },
    { name: 'Temperature (TMP36)', desc: 'analog temp sensor into A0 — set the room temperature and watch the volts.', use: 'tmp36' },
    { name: 'Measure an LED (voltmeter)', desc: 'a DMM across the LED reads its real forward drop.', use: 'voltmeter' },
    { name: 'Measure current (ammeter)', desc: 'meter in series with the LED loop — reads the real mA.', use: 'ammeter' },
    { name: 'Camera console (thingino)', desc: '3.3V UART into an Ingenic IP cam — crossed lines, own supply.', use: 'ipcam' },
    { name: 'Flash dump rig (CH341A)', desc: 'SOIC-8 clip onto the NOR chip, WP/HOLD high, target unpowered.', use: 'spiflash' }
  ];

  // ---- Adafruit catalog → wireable module -----------------------------------
  // Given a product name (+ optional category name), pick the part type that
  // wires it correctly, with honest ratings where the family is known.
  // Order matters: most specific first.
  function classify(name, catName) {
    const t = (String(name || '') + ' ' + String(catName || '')).toLowerCase();
    const is = (re) => re.test(t);
    // things that are not electrical parts at all
    if (is(/gift card|sticker|t-shirt|mug|poster|book(?!let pcb)|magazine|enclosure|case for|tool|tweezer|solder(?!ing iron kit)|cable|adapter plate|standoff|screw|tape(?! led)|filament/) &&
        !is(/led|sensor|driver|breakout/)) return null;
    if (is(/neopixel|ws2812|sk6812|neo ?matrix|neopixel ring|neopixel stick/)) {
      return { type: 'neopixel', iface: 'NeoPixel',
               ratings: { pairs: [{ p: 'v5', n: 'gnd', min: 3.5, max: 5.3, abs: 5.5 }] } };
    }
    if (is(/dotstar|apa102/)) {
      return { type: 'spimod', iface: 'SPI (DotStar)',
               ratings: { pairs: [{ p: 'vcc', n: 'gnd', min: 3.5, max: 5.3, abs: 5.5 }] } };
    }
    if (is(/servo(?! driver| hat| shield| controller)/)) return { type: 'servo', iface: 'PWM servo' };
    if (is(/stepper motor(?! driver| hat| shield)/)) return { type: 'stepper', iface: 'stepper (needs driver)' };
    if (is(/a4988|drv8825|stepper.*driver|motor driver|dc.*motor.*(featherwing|shield|hat|driver)|tb6612|l9110|drv8871/)) {
      return { type: 'a4988', iface: 'STEP/DIR motor driver' };
    }
    if (is(/vibrating|vibration motor|pager motor|haptic motor(?! driver)/)) return { type: 'vibmotor', iface: 'vibration motor (needs a transistor)' };
    if (is(/dc (gear ?)?motor|tt motor|hobby motor/)) return { type: 'dcmotor', iface: 'DC motor' };
    if (is(/\ba3144\b|hall effect sensor|hall sensor|hall-effect/) && !is(/current sensor|i2c|stemma/)) return { type: 'hall', iface: 'digital magnet (open collector)' };
    if (is(/tilt (ball )?switch|tilt sensor|sw-520d|ball tilt/)) return { type: 'tilt', iface: 'switch' };
    if (is(/solar panel|solar cell|photovoltaic/)) return { type: 'solar', iface: 'power' };
    if (is(/\bmq-?2\b/)) return { type: 'mq2', iface: 'analog + digital gas (5V heater)' };
    if (is(/\btp4056\b/)) return { type: 'tp4056', iface: 'power (Li-ion charger)' };
    if (is(/joystick|thumbstick|thumb stick/) && !is(/featherwing|i2c|stemma|seesaw|gamepad|bonnet/)) return { type: 'joystick', iface: 'analog 2-axis + button' };
    if (is(/photocell|photoresistor|photo cell|\bldr\b/)) return { type: 'ldr', iface: 'analog (resistive)' };
    if (is(/thermistor/)) return { type: 'thermistor', iface: 'analog (resistive)' };
    if (is(/tmp36/)) return { type: 'tmp36', iface: 'analog temperature' };
    if (is(/\blm35\b/)) return { type: 'lm35', iface: 'analog temperature' };
    if (is(/\bpir\b|hc-sr501|motion sensor/)) return { type: 'pir', iface: 'digital motion' };
    if (is(/\bpc817\b|optocoupler|opto-?isolator/)) return { type: 'pc817', iface: 'isolation' };
    if (is(/\blm2596\b|buck converter|step-down/)) return { type: 'buck', iface: 'power' };
    if (is(/\blm317\b/)) return { type: 'lm317', iface: 'power' };
    if (is(/vs1838|tsop38|ir receiver|infrared receiver/)) return { type: 'irrecv', iface: 'digital IR' };
    if (is(/soil moisture|capacitive moisture/)) return { type: 'soil', iface: 'analog moisture' };
    if (is(/reed switch|magnetic contact switch|door sensor/)) return { type: 'reed', iface: 'switch' };
    if (is(/cr2032|coin cell/)) return { type: 'cr2032', iface: 'power' };
    if (is(/potentiometer|slide pot|rotary pot|trimmer/)) return { type: 'pot', iface: 'analog (divider)' };
    if (is(/piezo|buzzer|speaker(?! bonnet| featherwing)/)) return { type: 'buzzer', iface: 'driven load' };
    if (is(/\brelay\b/)) return { type: 'relay', iface: 'relay' };
    if (is(/arcade button|push.?button|tactile|toggle switch|micro ?switch|reed switch|tilt switch|key ?switch/)) {
      return { type: 'button', iface: 'switch' };
    }
    if (is(/ultrasonic|hc-?sr04|us-100/)) return { type: 'hcsr04', iface: 'trig/echo sonar' };
    if (is(/dht22|dht11|am2302/)) return { type: 'dht22', iface: 'one-wire-ish' };
    if (is(/single |diffused |clear |\b5mm\b|\b3mm\b|\b10mm\b/) && is(/\bled\b/) && !is(/matrix|strip|ring|driver|backpack/)) {
      return { type: 'led', iface: 'plain LED' };
    }
    // interface keywords + the modern connector ecosystems (STEMMA QT/Qwiic = I2C)
    if (is(/stemma qt|qwiic|\bi2c\b|i²c/)) return { type: 'i2cmod', iface: 'I2C (STEMMA QT/Qwiic)' };
    if (is(/\bspi\b/)) return { type: 'spimod', iface: 'SPI' };
    if (is(/\buart\b|rs-?232|rs-?485|\bgps\b|serial.*(module|breakout)/)) return { type: 'uartmod', iface: 'UART' };
    if (is(/analog.*(sensor|out)|\bfsr\b|flex sensor|soft pot|anemometer|moisture/)) return { type: 'analogmod', iface: 'analog out' };
    // family knowledge: most Adafruit sensor breakouts of the modern era are I2C
    if (is(/sensor|accelerometer|gyro|magnetometer|barometric|pressure|temperature|humidity|proximity|gesture|color sensor|light sensor|adc|dac|io expander|rtc|real time clock|fram|eeprom/)) {
      return { type: 'i2cmod', iface: 'I2C (typical for this family — check the guide)' };
    }
    if (is(/oled|lcd|tft|e-?ink|e-?paper|display|matrix.*backpack|7-?segment|charlieplex/)) {
      return { type: is(/tft|e-?ink|e-?paper/) ? 'spimod' : 'i2cmod', iface: 'display bus' };
    }
    if (is(/led strip|led tape|analog rgb/)) return { type: 'neopixel', iface: 'LED strip (check: analog strips need drivers)' };
    return null; // dev boards, kits, everything else: not a single wireable module
  }

  // the definition (ports) of a placed part: a part picked from the JLCPCB/LCSC
  // catalogue carries its own pins; everything else uses its type's
  const PLIB = root.ElectriCADPartLib || (typeof require === 'function' ? require('./partlib.js') : null);
  function defOf(part) {
    const own = PLIB && part && PLIB.portsOf(part);
    if (own) return { type: part.type, name: part.name, ports: own, lib: true };
    return PARTS.find((d) => d.type === (part && part.type)) || null;
  }
  const api = { PART_GROUPS, PARTS, PART_INFO, HOOKUPS, RECIPES, classify, defOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PinodeParts = api;
})(typeof window !== 'undefined' ? window : globalThis);
