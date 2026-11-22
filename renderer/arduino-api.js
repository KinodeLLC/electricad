// Arduino language knowledge for the editor: completions, hover docs and
// signature help for the core API, so the IDE knows pinMode from pinMod
// without a language server. UMD: the test suite checks the table.
(function (root) {
  // [name, signature, doc, kind]   kind: f=function c=constant k=keyword/type m=method(Serial…)
  const API = [
    // digital / analog I/O
    ['pinMode', 'pinMode(pin, mode)', 'Configure a pin as INPUT, OUTPUT or INPUT_PULLUP. Call in setup() before using the pin.', 'f'],
    ['digitalWrite', 'digitalWrite(pin, value)', 'Drive an OUTPUT pin HIGH or LOW. On an INPUT pin, HIGH enables the internal pull-up (AVR).', 'f'],
    ['digitalRead', 'digitalRead(pin) → int', 'Read HIGH or LOW from a pin. A floating input (nothing pulling it) reads random noise: use INPUT_PULLUP or a resistor.', 'f'],
    ['analogRead', 'analogRead(pin) → int', 'Read the ADC: 0..1023 on AVR (10-bit), 0..4095 on ESP32 (12-bit). ~100µs per read on AVR.', 'f'],
    ['analogWrite', 'analogWrite(pin, value)', 'PWM duty 0..255 on a PWM-capable pin (~ on Uno/Nano: 3,5,6,9,10,11). Not a true analog voltage — it is a fast square wave.', 'f'],
    ['analogReference', 'analogReference(type)', 'Set the ADC reference: DEFAULT, INTERNAL, EXTERNAL (AVR). Never apply a voltage to AREF while DEFAULT is selected.', 'f'],
    ['analogReadResolution', 'analogReadResolution(bits)', 'Set analogRead() resolution (SAMD, ESP32, RP2040, Due).', 'f'],
    ['analogWriteResolution', 'analogWriteResolution(bits)', 'Set analogWrite() resolution (SAMD, ESP32, RP2040, Due).', 'f'],
    // timing
    ['delay', 'delay(ms)', 'Block for ms milliseconds. Nothing else runs (except interrupts) — prefer millis() timing in real sketches, or ELECTRICAD_DELAY(ms) to keep the board view live.', 'f'],
    ['delayMicroseconds', 'delayMicroseconds(us)', 'Block for us microseconds. Accurate from ~3µs up to 16383µs on AVR.', 'f'],
    ['millis', 'millis() → unsigned long', 'Milliseconds since boot. Rolls over after ~49.7 days; compare with subtraction (now - last >= interval) and it survives the rollover.', 'f'],
    ['micros', 'micros() → unsigned long', 'Microseconds since boot (4µs resolution at 16MHz). Rolls over after ~70 minutes.', 'f'],
    // advanced I/O
    ['tone', 'tone(pin, frequency [, duration])', 'Square wave on a pin (uses a timer: on Uno it disables PWM on pins 3 and 11).', 'f'],
    ['noTone', 'noTone(pin)', 'Stop a tone() on that pin.', 'f'],
    ['pulseIn', 'pulseIn(pin, value [, timeout]) → unsigned long', 'Measure a pulse length in µs (HC-SR04 echo, RC receivers). Blocks up to timeout µs (default 1s).', 'f'],
    ['pulseInLong', 'pulseInLong(pin, value [, timeout]) → unsigned long', 'pulseIn() using micros(); works with interrupts enabled.', 'f'],
    ['shiftOut', 'shiftOut(dataPin, clockPin, bitOrder, value)', 'Bit-bang a byte out (74HC595). bitOrder: MSBFIRST or LSBFIRST.', 'f'],
    ['shiftIn', 'shiftIn(dataPin, clockPin, bitOrder) → byte', 'Bit-bang a byte in (74HC165).', 'f'],
    // interrupts
    ['attachInterrupt', 'attachInterrupt(digitalPinToInterrupt(pin), ISR, mode)', 'Run ISR on RISING, FALLING, CHANGE or LOW. Keep ISRs tiny; mark shared variables volatile; no delay()/Serial inside.', 'f'],
    ['detachInterrupt', 'detachInterrupt(digitalPinToInterrupt(pin))', 'Stop calling the ISR for that pin.', 'f'],
    ['digitalPinToInterrupt', 'digitalPinToInterrupt(pin) → int', 'Map a pin number to its interrupt number (Uno: pins 2 and 3 only).', 'f'],
    ['interrupts', 'interrupts()', 'Re-enable interrupts.', 'f'],
    ['noInterrupts', 'noInterrupts()', 'Disable interrupts (keep the section short — millis() and Serial stop).', 'f'],
    // math
    ['map', 'map(value, fromLow, fromHigh, toLow, toHigh) → long', 'Re-map a number between ranges. Integer math — fractions are truncated.', 'f'],
    ['constrain', 'constrain(x, a, b)', 'Clamp x to [a, b].', 'f'],
    ['min', 'min(a, b)', 'The smaller of two values (macro: don\'t pass expressions with side effects like i++).', 'f'],
    ['max', 'max(a, b)', 'The larger of two values (macro).', 'f'],
    ['abs', 'abs(x)', 'Absolute value (macro).', 'f'],
    ['random', 'random([min,] max) → long', 'Pseudo-random number in [min, max). Seed it with randomSeed(analogRead(unconnectedPin)).', 'f'],
    ['randomSeed', 'randomSeed(seed)', 'Seed the random generator.', 'f'],
    ['bitRead', 'bitRead(x, n)', 'Read bit n of x.', 'f'], ['bitWrite', 'bitWrite(x, n, b)', 'Write bit n of x.', 'f'],
    ['bitSet', 'bitSet(x, n)', 'Set bit n of x.', 'f'], ['bitClear', 'bitClear(x, n)', 'Clear bit n of x.', 'f'],
    ['bit', 'bit(n)', '1 << n.', 'f'], ['lowByte', 'lowByte(x)', 'Low byte of a word.', 'f'], ['highByte', 'highByte(x)', 'High byte of a word.', 'f'],
    // serial (methods)
    ['Serial.begin', 'Serial.begin(baud)', 'Open the serial port. 115200 matches ElectriCAD\'s monitor default; both ends must agree or you get garbage.', 'm'],
    ['Serial.print', 'Serial.print(value [, format])', 'Print without newline. format: DEC, HEX, BIN, or decimal places for floats.', 'm'],
    ['Serial.println', 'Serial.println(value [, format])', 'Print with a newline. Print "label:value" pairs and the plotter graphs them.', 'm'],
    ['Serial.available', 'Serial.available() → int', 'Bytes waiting in the receive buffer (64 on AVR).', 'm'],
    ['Serial.read', 'Serial.read() → int', 'Next received byte, or -1 if none.', 'm'],
    ['Serial.readStringUntil', 'Serial.readStringUntil(terminator) → String', 'Read until a character (e.g. \'\\n\') or timeout.', 'm'],
    ['Serial.parseInt', 'Serial.parseInt() → long', 'Parse the next integer from the stream (waits up to the timeout).', 'm'],
    ['Serial.parseFloat', 'Serial.parseFloat() → float', 'Parse the next float from the stream.', 'm'],
    ['Serial.write', 'Serial.write(byte | buf, len)', 'Send raw bytes.', 'm'],
    ['Serial.flush', 'Serial.flush()', 'Wait until outgoing data has been sent.', 'm'],
    ['Serial.setTimeout', 'Serial.setTimeout(ms)', 'Timeout for parse/readString functions (default 1000ms).', 'm'],
    // Wire / SPI
    ['Wire.begin', 'Wire.begin([address])', 'Join the I2C bus (as controller with no address). Needs pull-ups on SDA/SCL — most breakouts include them.', 'm'],
    ['Wire.beginTransmission', 'Wire.beginTransmission(address)', 'Start a write to a 7-bit I2C address.', 'm'],
    ['Wire.endTransmission', 'Wire.endTransmission([stop]) → byte', '0 = ACK (device present), 2 = address NACK, 3 = data NACK, 4 = other error.', 'm'],
    ['Wire.requestFrom', 'Wire.requestFrom(address, quantity) → byte', 'Read bytes from a device; then Wire.read() each one.', 'm'],
    ['Wire.write', 'Wire.write(value)', 'Queue a byte for the current transmission.', 'm'],
    ['Wire.read', 'Wire.read() → int', 'Next received byte.', 'm'],
    ['Wire.setClock', 'Wire.setClock(hz)', '100000 (standard) or 400000 (fast mode).', 'm'],
    ['SPI.begin', 'SPI.begin()', 'Start the SPI bus. Drive each device\'s CS pin yourself.', 'm'],
    ['SPI.transfer', 'SPI.transfer(byte) → byte', 'Full-duplex: send one byte, receive one.', 'm'],
    ['SPI.beginTransaction', 'SPI.beginTransaction(SPISettings(speed, MSBFIRST, SPI_MODE0))', 'Claim the bus with the device\'s settings.', 'm'],
    ['SPI.endTransaction', 'SPI.endTransaction()', 'Release the bus.', 'm'],
    // ElectriCAD telemetry
    ['ELECTRICAD_BEGIN', 'ELECTRICAD_BEGIN()', 'ElectriCAD live board view: call once in setup() after Serial.begin().', 'f'],
    ['ELECTRICAD_TICK', 'ELECTRICAD_TICK()', 'ElectriCAD: call every loop(). Rate-limited internally (20 Hz) — streams every pin\'s mode/level/PWM to the board view.', 'f'],
    ['ELECTRICAD_DELAY', 'ELECTRICAD_DELAY(ms)', 'ElectriCAD: like delay(), but keeps streaming telemetry while it waits, so the board view never stalls.', 'f'],
    ['ELECTRICAD_I2C_SCAN', 'ELECTRICAD_I2C_SCAN(Wire)', 'ElectriCAD: probe every I2C address and report what answered — shown, with device names, in Tools → I2C Bus.', 'f'],
    // constants
    ['HIGH', 'HIGH', 'Logic 1: ~VCC on an output, above ~0.6·VCC on an input.', 'c'],
    ['LOW', 'LOW', 'Logic 0.', 'c'],
    ['INPUT', 'INPUT', 'High-impedance input. Needs an external pull resistor or it floats.', 'c'],
    ['OUTPUT', 'OUTPUT', 'Push-pull output: ~20mA recommended, 40mA absolute max per AVR pin.', 'c'],
    ['INPUT_PULLUP', 'INPUT_PULLUP', 'Input with the internal ~35kΩ pull-up: idle HIGH, a button to GND reads LOW.', 'c'],
    ['INPUT_PULLDOWN', 'INPUT_PULLDOWN', 'Input with internal pull-down (ESP32, RP2040, SAMD — not AVR).', 'c'],
    ['LED_BUILTIN', 'LED_BUILTIN', 'The board\'s onboard LED pin (13 on Uno/Nano/Mega, 2 on most ESP32 DevKits, 25 on Pico).', 'c'],
    ['RISING', 'RISING', 'Interrupt on a LOW→HIGH edge.', 'c'], ['FALLING', 'FALLING', 'Interrupt on a HIGH→LOW edge.', 'c'],
    ['CHANGE', 'CHANGE', 'Interrupt on any edge.', 'c'], ['MSBFIRST', 'MSBFIRST', 'Most significant bit first.', 'c'],
    ['LSBFIRST', 'LSBFIRST', 'Least significant bit first.', 'c'],
    ['A0', 'A0', 'Analog input 0 (also usable as a digital pin).', 'c'],
    // types
    ['byte', 'byte', 'Unsigned 8-bit (0..255).', 'k'], ['word', 'word', 'Unsigned 16-bit.', 'k'],
    ['boolean', 'boolean', 'Alias of bool.', 'k'], ['String', 'String', 'Arduino heap string. Convenient, but heavy concatenation fragments 2KB of AVR RAM — prefer char buffers in long-running sketches.', 'k'],
    ['F', 'F("text")', 'Keep a string literal in flash instead of RAM: Serial.print(F("hello")). Saves precious SRAM on AVR.', 'f'],
    ['PROGMEM', 'PROGMEM', 'Store constant data in flash (AVR). Read it back with pgm_read_byte()/memcpy_P().', 'k'],
    ['volatile', 'volatile', 'Required on variables shared between an ISR and loop().', 'k']
  ];

  const SNIPPETS = [
    ['setup/loop', 'void setup() {\n\tSerial.begin(115200);\n\t${1}\n}\n\nvoid loop() {\n\t${2}\n}', 'Sketch skeleton'],
    ['every N ms (millis)', 'static unsigned long ${1:last} = 0;\nif (millis() - ${1:last} >= ${2:1000}) {\n\t${1:last} = millis();\n\t${3}\n}', 'Non-blocking timer'],
    ['debounced button', 'static int ${1:stable} = HIGH, ${2:lastRead} = HIGH;\nstatic unsigned long ${3:lastChange} = 0;\nint r = digitalRead(${4:2});\nif (r != ${2:lastRead}) ${3:lastChange} = millis();\n${2:lastRead} = r;\nif (millis() - ${3:lastChange} > 30 && r != ${1:stable}) {\n\t${1:stable} = r;\n\tif (${1:stable} == LOW) {\n\t\t${5:// pressed}\n\t}\n}', 'Debounce with millis()'],
    ['plot values', 'Serial.print("${1:a}:");\nSerial.print(${2:valueA});\nSerial.print(" ${3:b}:");\nSerial.println(${4:valueB});', 'label:value lines for the plotter'],
    ['electricad telemetry', '#include <ElectriCADTelemetry.h>\n', 'Live board view include'],
    ['state machine', 'enum State { ${1:IDLE}, ${2:RUNNING} };\nstatic State state = ${1:IDLE};\nswitch (state) {\n\tcase ${1:IDLE}:\n\t\t${3}\n\t\tbreak;\n\tcase ${2:RUNNING}:\n\t\t${4}\n\t\tbreak;\n}', 'switch-based state machine'],
    ['read serial line', 'if (Serial.available()) {\n\tString ${1:line} = Serial.readStringUntil(\'\\n\');\n\t${1:line}.trim();\n\t${2}\n}', 'Read one command line from the serial monitor'],
    ['interrupt pin', 'volatile bool ${1:triggered} = false;\nvoid ${2:onEdge}() { ${1:triggered} = true; }\n// in setup():\n// attachInterrupt(digitalPinToInterrupt(${3:2}), ${2:onEdge}, ${4:FALLING});', 'Flag set from an interrupt'],
    ['i2c scan', 'Wire.begin();\nfor (uint8_t a = 1; a < 127; a++) {\n\tWire.beginTransmission(a);\n\tif (Wire.endTransmission() == 0) {\n\t\tSerial.print("found 0x");\n\t\tSerial.println(a, HEX);\n\t}\n}', 'List every I2C address that answers'],
    ['smooth analog', 'static float ${1:avg} = analogRead(${2:A0});\n${1:avg} += (analogRead(${2:A0}) - ${1:avg}) * ${3:0.1};', 'Exponential moving average of an analog pin'],
    ['map to volts', 'float ${1:volts} = analogRead(${2:A0}) * ${3:5.0} / 1023.0;', 'ADC counts to volts (10-bit)'],
    ['fade led', 'for (int ${1:b} = 0; ${1:b} <= 255; ${1:b}++) {\n\tanalogWrite(${2:9}, ${1:b});\n\tdelay(${3:4});\n}', 'Ramp a PWM pin'],
    ['print formatted', 'char ${1:buf}[64];\nsnprintf(${1:buf}, sizeof(${1:buf}), "${2:t=%lu}", ${3:millis()});\nSerial.println(${1:buf});', 'printf-style output'],
    ['eeprom put/get', '#include <EEPROM.h>\n// EEPROM.put(${1:0}, ${2:value});\n// EEPROM.get(${1:0}, ${2:value});', 'Store a value across power cycles']
  ];

  // MicroPython (machine/time/network) and CircuitPython (board/digitalio…)
  const PY_SNIPPETS = [
    ['upy: blink', 'from machine import Pin\nimport time\n\nled = Pin(${1:25}, Pin.OUT)\nwhile True:\n    led.value(not led.value())\n    time.sleep_ms(${2:500})', 'MicroPython blink'],
    ['upy: button', 'from machine import Pin\n\n${1:btn} = Pin(${2:14}, Pin.IN, Pin.PULL_UP)\nif ${1:btn}.value() == 0:\n    ${3:pass}', 'Button to GND with the internal pull-up'],
    ['upy: pwm', 'from machine import Pin, PWM\n\n${1:pwm} = PWM(Pin(${2:15}))\n${1:pwm}.freq(${3:1000})\n${1:pwm}.duty_u16(${4:32768})', 'PWM output, 16-bit duty'],
    ['upy: adc', 'from machine import ADC, Pin\n\n${1:adc} = ADC(Pin(${2:26}))\nraw = ${1:adc}.read_u16()   # 0..65535', 'Analog read, 16-bit'],
    ['upy: i2c scan', 'from machine import I2C, Pin\n\ni2c = I2C(${1:0}, scl=Pin(${2:5}), sda=Pin(${3:4}), freq=400000)\nprint([hex(a) for a in i2c.scan()])', 'List I2C devices'],
    ['upy: interrupt', 'from machine import Pin\n\ndef ${1:on_edge}(pin):\n    ${2:print("edge", pin)}\n\nPin(${3:14}, Pin.IN, Pin.PULL_UP).irq(trigger=Pin.IRQ_FALLING, handler=${1:on_edge})', 'Pin interrupt'],
    ['upy: every N ms', 'import time\n\n${1:last} = time.ticks_ms()\nwhile True:\n    if time.ticks_diff(time.ticks_ms(), ${1:last}) >= ${2:1000}:\n        ${1:last} = time.ticks_ms()\n        ${3:pass}', 'Non-blocking timer with ticks'],
    ['upy: neopixel', 'from machine import Pin\nimport neopixel\n\nnp = neopixel.NeoPixel(Pin(${1:16}), ${2:8})\nnp[0] = (${3:255}, 0, 0)\nnp.write()', 'NeoPixel strip'],
    ['upy: wifi', 'import network, time\n\nwlan = network.WLAN(network.STA_IF)\nwlan.active(True)\nwlan.connect("${1:ssid}", "${2:password}")\nwhile not wlan.isconnected():\n    time.sleep_ms(200)\nprint(wlan.ifconfig())', 'Join a WiFi network'],
    ['upy: uart', 'from machine import UART, Pin\n\nuart = UART(${1:1}, baudrate=${2:9600}, tx=Pin(${3:4}), rx=Pin(${4:5}))\nuart.write(b"${5:hello}\\n")', 'Hardware serial port'],
    ['cpy: blink', 'import board, digitalio, time\n\nled = digitalio.DigitalInOut(board.LED)\nled.direction = digitalio.Direction.OUTPUT\nwhile True:\n    led.value = not led.value\n    time.sleep(${1:0.5})', 'CircuitPython blink'],
    ['cpy: button', 'import board, digitalio\n\n${1:btn} = digitalio.DigitalInOut(board.${2:D5})\n${1:btn}.switch_to_input(pull=digitalio.Pull.UP)\nif not ${1:btn}.value:\n    ${3:pass}', 'Button with the internal pull-up'],
    ['cpy: analog in', 'import board, analogio\n\n${1:pot} = analogio.AnalogIn(board.${2:A0})\nvolts = ${1:pot}.value * ${1:pot}.reference_voltage / 65535', 'Analog read in volts'],
    ['cpy: pwm', 'import board, pwmio\n\n${1:pwm} = pwmio.PWMOut(board.${2:D5}, frequency=${3:5000}, duty_cycle=0)\n${1:pwm}.duty_cycle = ${4:32768}', 'PWM output, 16-bit duty'],
    ['cpy: i2c scan', 'import board\n\ni2c = board.I2C()\nwhile not i2c.try_lock():\n    pass\nprint([hex(a) for a in i2c.scan()])\ni2c.unlock()', 'List I2C devices'],
    ['cpy: neopixel', 'import board, neopixel\n\npixels = neopixel.NeoPixel(board.NEOPIXEL, ${1:1}, brightness=${2:0.3})\npixels.fill((${3:255}, 0, 0))', 'Onboard NeoPixel (needs the neopixel library in lib/)']
  ];

  function lookup(word) {
    return API.find((a) => a[0] === word) || null;
  }

  const api = { API, SNIPPETS, PY_SNIPPETS, lookup };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ElectriCADArduinoApi = api;
})(typeof window !== 'undefined' ? window : globalThis);
