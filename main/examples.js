// Built-in examples. Every one streams live telemetry, so the board view lights
// up the moment it is uploaded, and the ones that print use label:value lines
// so the plotter draws them with no setup. libs = libraries the example needs
// (the IDE installs them through arduino-cli when the project is created).
// Pure data; the test suite checks every example is well-formed.
const TELEMETRY_NOTE = '// ELECTRICAD_TICK() streams live pin states to the board view.\n';

const EXAMPLES = [
  {
    id: 'blink', name: 'Blink', type: 'arduino', libs: [],
    desc: 'The onboard LED, on and off once a second — watch it light on the live board.',
    code: `#include <ElectriCADTelemetry.h>
${TELEMETRY_NOTE}
void setup() {
  Serial.begin(115200);
  ELECTRICAD_BEGIN();
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  ELECTRICAD_TICK();
  digitalWrite(LED_BUILTIN, HIGH);
  ELECTRICAD_DELAY(500);   // like delay(), but the board view keeps updating
  digitalWrite(LED_BUILTIN, LOW);
  ELECTRICAD_DELAY(500);
}
`
  },
  {
    id: 'blink-nodelay', name: 'Blink without delay()', type: 'arduino', libs: [],
    desc: 'Non-blocking timing with millis() — the pattern every real sketch grows into.',
    code: `#include <ElectriCADTelemetry.h>
${TELEMETRY_NOTE}
const unsigned long INTERVAL_MS = 250;
unsigned long lastToggle = 0;
bool ledOn = false;

void setup() {
  Serial.begin(115200);
  ELECTRICAD_BEGIN();
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  ELECTRICAD_TICK();
  unsigned long now = millis();
  if (now - lastToggle >= INTERVAL_MS) {   // subtraction survives millis() rollover
    lastToggle = now;
    ledOn = !ledOn;
    digitalWrite(LED_BUILTIN, ledOn ? HIGH : LOW);
  }
}
`
  },
  {
    id: 'button', name: 'Button (debounced, INPUT_PULLUP)', type: 'arduino', libs: [],
    desc: 'Button from pin 2 to GND, no resistor needed. Each press toggles the LED.',
    code: `#include <ElectriCADTelemetry.h>
${TELEMETRY_NOTE}
const int BUTTON_PIN = 2;          // button between pin 2 and GND
const unsigned long DEBOUNCE_MS = 30;

int stableState = HIGH;            // pull-up: released = HIGH
int lastReading = HIGH;
unsigned long lastChange = 0;
bool ledOn = false;

void setup() {
  Serial.begin(115200);
  ELECTRICAD_BEGIN();
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  ELECTRICAD_TICK();
  int reading = digitalRead(BUTTON_PIN);
  if (reading != lastReading) lastChange = millis();
  lastReading = reading;

  if (millis() - lastChange > DEBOUNCE_MS && reading != stableState) {
    stableState = reading;
    if (stableState == LOW) {      // pressed
      ledOn = !ledOn;
      digitalWrite(LED_BUILTIN, ledOn);
      Serial.print("presses:");
      Serial.println(ledOn ? 1 : 0);
    }
  }
}
`
  },
  {
    id: 'fade', name: 'Fade (PWM)', type: 'arduino', libs: [],
    desc: 'LED + 220Ω on pin 9 breathing with analogWrite — the board view shows the duty live.',
    code: `#include <ElectriCADTelemetry.h>
${TELEMETRY_NOTE}
const int LED_PIN = 9;   // a PWM pin (~) on Uno/Nano
int brightness = 0;
int step = 5;

void setup() {
  Serial.begin(115200);
  ELECTRICAD_BEGIN();
  pinMode(LED_PIN, OUTPUT);
}

void loop() {
  ELECTRICAD_TICK();
  analogWrite(LED_PIN, brightness);
  Serial.print("duty:");
  Serial.println(brightness);
  brightness += step;
  if (brightness <= 0 || brightness >= 255) step = -step;
  ELECTRICAD_DELAY(30);
}
`
  },
  {
    id: 'analog-plot', name: 'Analog read → plotter', type: 'arduino', libs: [],
    desc: 'A potentiometer wiper (or any sensor) on A0, plotted live in volts and raw counts.',
    code: `#include <ElectriCADTelemetry.h>
${TELEMETRY_NOTE}
// set this to your board's logic voltage (5.0 for Uno/Nano/Mega, 3.3 for ESP32/Pico)
const float VREF = 5.0;

void setup() {
  Serial.begin(115200);
  ELECTRICAD_BEGIN();
}

void loop() {
  ELECTRICAD_TICK();
  int raw = analogRead(A0);
  float volts = raw * VREF / 1023.0;
  Serial.print("raw:");
  Serial.print(raw);
  Serial.print(" volts:");
  Serial.println(volts, 3);
  ELECTRICAD_DELAY(50);
}
`
  },
  {
    id: 'plotter-demo', name: 'Plotter demo (no wiring needed)', type: 'arduino', libs: [],
    desc: 'Sine, cosine and a sawtooth — see the plotter work before you build anything.',
    code: `#include <ElectriCADTelemetry.h>
${TELEMETRY_NOTE}
void setup() {
  Serial.begin(115200);
  ELECTRICAD_BEGIN();
}

void loop() {
  ELECTRICAD_TICK();
  float t = millis() / 1000.0;
  Serial.print("sine:");
  Serial.print(sin(t * 2.0), 3);
  Serial.print(" cosine:");
  Serial.print(cos(t * 2.0), 3);
  Serial.print(" saw:");
  Serial.println(fmod(t, 2.0) - 1.0, 3);
  ELECTRICAD_DELAY(40);
}
`
  },
  {
    id: 'traffic', name: 'Traffic light (state machine)', type: 'arduino', libs: [],
    desc: 'Red/yellow/green LEDs on pins 12/11/10, sequenced without blocking.',
    code: `#include <ElectriCADTelemetry.h>
${TELEMETRY_NOTE}
const int RED = 12, YELLOW = 11, GREEN = 10;   // each through 220Ω to its LED
enum Phase { GO, CAUTION, STOP };
Phase phase = STOP;
unsigned long phaseStart = 0;

unsigned long durationOf(Phase p) {
  switch (p) {
    case GO: return 4000;
    case CAUTION: return 1200;
    default: return 3500;
  }
}

void show(Phase p) {
  digitalWrite(GREEN,  p == GO);
  digitalWrite(YELLOW, p == CAUTION);
  digitalWrite(RED,    p == STOP);
}

void setup() {
  Serial.begin(115200);
  ELECTRICAD_BEGIN();
  pinMode(RED, OUTPUT);
  pinMode(YELLOW, OUTPUT);
  pinMode(GREEN, OUTPUT);
  show(phase);
}

void loop() {
  ELECTRICAD_TICK();
  if (millis() - phaseStart >= durationOf(phase)) {
    phase = phase == STOP ? GO : (phase == GO ? CAUTION : STOP);
    phaseStart = millis();
    show(phase);
  }
}
`
  },
  {
    id: 'i2c-scan', name: 'I2C bus scanner', type: 'arduino', libs: [],
    desc: 'Finds every I2C device on the bus — the IDE names them in Tools → I2C Bus.',
    code: `#include <Wire.h>
#include <ElectriCADTelemetry.h>
${TELEMETRY_NOTE}
void setup() {
  Serial.begin(115200);
  Wire.begin();
  ELECTRICAD_BEGIN();
}

void loop() {
  ELECTRICAD_TICK();
  static unsigned long lastScan = 0;
  if (millis() - lastScan > 3000) {    // rescan every 3s: hot-plug STEMMA QT boards
    lastScan = millis();
    ELECTRICAD_I2C_SCAN(Wire);          // prints ~PNI|... which the IDE decodes
  }
}
`
  },
  {
    id: 'sonar', name: 'HC-SR04 distance', type: 'arduino', libs: [],
    desc: 'Trig on 5, Echo on 6 — distance in cm, plotted. (Echo is 5V: level-shift on 3.3V boards.)',
    code: `#include <ElectriCADTelemetry.h>
${TELEMETRY_NOTE}
const int TRIG = 5, ECHO = 6;

void setup() {
  Serial.begin(115200);
  ELECTRICAD_BEGIN();
  pinMode(TRIG, OUTPUT);
  pinMode(ECHO, INPUT);
}

void loop() {
  ELECTRICAD_TICK();
  digitalWrite(TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG, LOW);
  unsigned long us = pulseIn(ECHO, HIGH, 30000UL);   // 30ms timeout ≈ 5m
  if (us > 0) {
    Serial.print("cm:");
    Serial.println(us / 58.0, 1);
  }
  ELECTRICAD_DELAY(60);
}
`
  },
  {
    id: 'servo', name: 'Servo sweep', type: 'arduino', libs: ['Servo'],
    desc: 'Signal on pin 9. One small servo off USB 5V is fine; more need their own supply.',
    code: `#include <Servo.h>
#include <ElectriCADTelemetry.h>
${TELEMETRY_NOTE}
Servo servo;
int angle = 0, step = 2;

void setup() {
  Serial.begin(115200);
  ELECTRICAD_BEGIN();
  servo.attach(9);
}

void loop() {
  ELECTRICAD_TICK();
  servo.write(angle);
  Serial.print("angle:");
  Serial.println(angle);
  angle += step;
  if (angle <= 0 || angle >= 180) step = -step;
  ELECTRICAD_DELAY(20);
}
`
  },
  {
    id: 'neopixel', name: 'NeoPixel rainbow', type: 'arduino', libs: ['Adafruit NeoPixel'],
    desc: '8 pixels on pin 6 through 470Ω, 1000µF across the strip supply.',
    code: `#include <Adafruit_NeoPixel.h>
#include <ElectriCADTelemetry.h>
${TELEMETRY_NOTE}
const int PIXEL_PIN = 6;
const int PIXEL_COUNT = 8;
Adafruit_NeoPixel strip(PIXEL_COUNT, PIXEL_PIN, NEO_GRB + NEO_KHZ800);
uint16_t hue = 0;

void setup() {
  Serial.begin(115200);
  ELECTRICAD_BEGIN();
  strip.begin();
  strip.setBrightness(40);   // ~15%: keeps USB current sane
  strip.show();
}

void loop() {
  ELECTRICAD_TICK();
  for (int i = 0; i < PIXEL_COUNT; i++) {
    strip.setPixelColor(i, strip.gamma32(strip.ColorHSV(hue + i * 65536L / PIXEL_COUNT)));
  }
  strip.show();
  hue += 256;
  ELECTRICAD_DELAY(20);
}
`
  },
  {
    id: 'pi-button-led', name: 'Pi: button toggles LED', type: 'pi', libs: [],
    desc: 'gpiozero: LED on GPIO17, button on GPIO27 to GND. Watch both live over pigpiod.',
    code: `#!/usr/bin/env python3
# ElectriCAD Raspberry Pi example. Run on the Pi; the board panel watches the
# header live over pigpiod (sudo systemctl enable --now pigpiod).
from gpiozero import LED, Button
from signal import pause

led = LED(17)                      # GPIO17 -> 330R -> LED -> GND
button = Button(27, pull_up=True)  # GPIO27 -> button -> GND

button.when_pressed = led.toggle
print("press the button on GPIO27")
pause()
`
  },
  {
    id: 'upy-blink', name: 'MicroPython: blink + plot', type: 'micropython', libs: [],
    desc: 'Toggle the onboard LED and print its state for the Plotter. F5 runs it, Upload makes it main.py.',
    code: `# MicroPython: blink the onboard LED and plot it.
from machine import Pin
import time

try:
    led = Pin("LED", Pin.OUT)      # Pico, Pico W, many boards
except (TypeError, ValueError):
    led = Pin(2, Pin.OUT)          # ESP32 DevKit

n = 0
while True:
    led.value(n % 2)
    print("led:", led.value(), "count:", n)
    n += 1
    time.sleep(0.5)
`
  },
  {
    id: 'upy-adc', name: 'MicroPython: read a pot', type: 'micropython', libs: [],
    desc: 'Pot wiper on ADC0 (Pico GP26) printed as a 0-3.3 V trace for the Plotter.',
    code: `# MicroPython: pot wiper on ADC0 (Pico: GP26). Watch it in the Plotter.
from machine import ADC
import time

adc = ADC(0)                       # Pico: ADC0 = GP26. ESP32: use ADC(Pin(34))
while True:
    raw = adc.read_u16()           # 0..65535 on every port
    print("volts:", round(raw * 3.3 / 65535, 3))
    time.sleep(0.05)
`
  },
  {
    id: 'upy-i2c-scan', name: 'MicroPython: I2C scan', type: 'micropython', libs: [],
    desc: 'Lists I2C devices. Output lands in the I2C Bus panel, named.',
    code: `# MicroPython I2C scan. Pico: SDA=GP4, SCL=GP5 (I2C0). ESP32: SDA=21, SCL=22.
from machine import I2C, Pin
import time

i2c = I2C(0, sda=Pin(4), scl=Pin(5), freq=100000)
while True:
    found = i2c.scan()
    # the same line format the Arduino library prints, so the I2C panel decodes it
    print("~PNI|n=%d|a=%s" % (len(found), ",".join("%02X" % a for a in found)))
    time.sleep(2)
`
  },
  {
    id: 'cpy-blink', name: 'CircuitPython: blink + plot', type: 'circuitpython', libs: [],
    desc: 'board.LED blink with a plotted trace. Upload copies it to CIRCUITPY as code.py.',
    code: `# CircuitPython: blink board.LED and plot it.
import time
import board
import digitalio

led = digitalio.DigitalInOut(board.LED)
led.direction = digitalio.Direction.OUTPUT

while True:
    led.value = not led.value
    print("led:", int(led.value))
    time.sleep(0.5)
`
  },
  {
    id: 'cpy-neopixel', name: 'CircuitPython: NeoPixel rainbow', type: 'circuitpython', libs: [],
    desc: 'Cycles the onboard NeoPixel (board.NEOPIXEL) through the rainbow. Needs neopixel.mpy in CIRCUITPY/lib.',
    code: `# CircuitPython: onboard NeoPixel rainbow.
# Needs neopixel.mpy in CIRCUITPY/lib (from the Adafruit CircuitPython bundle).
import time
import board
import neopixel
from rainbowio import colorwheel

pixel = neopixel.NeoPixel(board.NEOPIXEL, 1, brightness=0.2)
i = 0
while True:
    pixel[0] = colorwheel(i & 255)
    i += 1
    time.sleep(0.02)
`
  }
];

module.exports = { EXAMPLES };
