// ElectriCADTelemetry — feeds the ElectriCAD IDE's live board view.
//
//   #include <ElectriCADTelemetry.h>
//   void setup() { Serial.begin(115200); ELECTRICAD_BEGIN(); }
//   void loop()  { ELECTRICAD_TICK(); ... }
//
//   ELECTRICAD_DELAY(ms)      drop-in delay() that keeps the board view live
//   ELECTRICAD_I2C_SCAN(Wire) probe the bus; the IDE's I2C panel names each
//                             device (call Wire.begin() first)
//
// Non-invasive: reads the hardware registers rather than asking the user to
// book-keep anything. Rate-limited internally; ELECTRICAD_TICK() in a tight loop
// is fine.
//
// Architectures:
//   AVR      generic — uses the core's own pin->port mapping tables, so Uno,
//            Nano, Mega 2560, Leonardo, Micro, and any other AVR all work
//            (pull-ups reported from the PORT latch of input pins)
//   ESP32    GPIO_ENABLE / GPIO_OUT / GPIO_IN registers (pins 0..39, the
//            second bank via GPIO_*1_REG where the chip has one)
//   ESP8266  GPE / GPO / GPI core macros (pins 0..16)
//   RP2040   sio_hw gpio_oe / gpio_out / gpio_in, pad pull-ups, and PWM
//            duty from the slice compare registers (Pico/Pico 2, pins 0..29)
//   SAMD     PORT DIR / OUT / IN through the variant's g_APinDescription,
//            pull-ups from PINCFG.PULLEN (Feather/Metro M0 and M4, Zero, MKR)
//   Renesas  UNO R4 Minima / WiFi: each pin's PmnPFS register through the
//            variant's g_pin_cfg (PDR direction, PODR latch, PIDR level, PCR
//            pull-up). On the R4 WiFi the 12×8 LED matrix frame is sent too,
//            when Arduino_LED_Matrix.h is included before this header.
//
// Onboard NeoPixels: ELECTRICAD_NEOPIXEL(strip) after strip.begin() sends
// the colour of the first pixels (any Adafruit_NeoPixel-style object), so
// the board view lights the real RGB LED. ElectriCAD's "Add live telemetry"
// command adds the line for you.
//
// Analog reads never reconfigure a pin the sketch is using digitally: on
// cores where analogRead() would steal the pin (RP2040, SAMD) a pin that is
// an output or a digital input is skipped and reported as an empty field.
//
// Wire format (one line per tick, masks hex, LSB = pin 0, up to 64 pins):
//   ~PN1|t=<millis>|m=<modeMask>|o=<outLatch>|d=<levels>|u=<pullups>|a=<csv>|p=<pin:duty,...>
//        [|n=<pin>:RRGGBB,...]  NeoPixels, as shown (brightness applied)
//        [|x=<24 hex>]          UNO R4 WiFi matrix, bit i = pixel i
//   ~PNI|n=<count>|a=<hex addr,...>          (one line per ELECTRICAD_I2C_SCAN)
#ifndef ELECTRICAD_TELEMETRY_H
#define ELECTRICAD_TELEMETRY_H

#include <Arduino.h>

#ifndef ELECTRICAD_INTERVAL_MS
#ifdef PINODE_INTERVAL_MS       /* legacy knob still honored */
#define ELECTRICAD_INTERVAL_MS PINODE_INTERVAL_MS
#else
#define ELECTRICAD_INTERVAL_MS 50   /* 20 Hz default */
#endif
#endif

namespace electricad {

struct Masks { uint32_t modeLo, modeHi, outLo, outHi, inLo, inHi, pullLo, pullHi; };

inline void setBit(uint32_t& lo, uint32_t& hi, uint8_t i) {
  if (i < 32) lo |= ((uint32_t)1 << i);
  else if (i < 64) hi |= ((uint32_t)1 << (i - 32));
}

inline void printMask(Print& out, uint32_t lo, uint32_t hi) {
  if (hi) { out.print(hi, HEX); // pad low word to 8 digits under a high word
    for (int8_t sh = 28; sh >= 0; sh -= 4) out.print((lo >> sh) & 0xF, HEX);
  } else out.print(lo, HEX);
}

#if defined(__AVR__)
// Generic AVR: walk every digital pin through the core's mapping tables.
#ifndef ELECTRICAD_ANALOG_COUNT
#ifdef PINODE_ANALOG_COUNT
#define ELECTRICAD_ANALOG_COUNT PINODE_ANALOG_COUNT
#else
#define ELECTRICAD_ANALOG_COUNT (NUM_ANALOG_INPUTS > 8 ? 8 : NUM_ANALOG_INPUTS)
#endif
#endif
#define ELECTRICAD_DIGITAL_COUNT (NUM_DIGITAL_PINS > 64 ? 64 : NUM_DIGITAL_PINS)

inline void gather(Masks& m) {
  for (uint8_t pin = 0; pin < ELECTRICAD_DIGITAL_COUNT; pin++) {
    uint8_t port = digitalPinToPort(pin);
    if (port == NOT_A_PIN) continue;
    uint8_t bit = digitalPinToBitMask(pin);
    if (*portModeRegister(port) & bit) {
      setBit(m.modeLo, m.modeHi, pin);
      if (*portOutputRegister(port) & bit) setBit(m.outLo, m.outHi, pin);
    }
#if !defined(ARDUINO_ARCH_MEGAAVR)     // megaAVR keeps pull-ups in PINnCTRL, not OUT
    else if (*portOutputRegister(port) & bit) {
      setBit(m.pullLo, m.pullHi, pin);   // classic AVR: input with PORT bit set = INPUT_PULLUP
    }
#endif
    if (*portInputRegister(port) & bit) setBit(m.inLo, m.inHi, pin);
  }
}
// PWM duty: check the timer attached to each pin; if its compare output is
// enabled, report the pin as PWM. digitalPinToTimer covers every AVR.
#if !defined(ARDUINO_ARCH_MEGAAVR)
#define ELECTRICAD_HAS_PULL 1
#endif
inline bool analogSafe(uint8_t i) { (void)i; return true; }
inline void printPwm(Print& out) {
  bool first = true;
  for (uint8_t pin = 0; pin < ELECTRICAD_DIGITAL_COUNT; pin++) {
    uint8_t t = digitalPinToTimer(pin);
    if (t == NOT_ON_TIMER) continue;
    uint16_t duty = 0; bool on = false;
    switch (t) {
#if defined(TCCR0A) && defined(COM0A1)
      case TIMER0A: on = TCCR0A & _BV(COM0A1); duty = OCR0A; break;
#endif
#if defined(TCCR0A) && defined(COM0B1)
      case TIMER0B: on = TCCR0A & _BV(COM0B1); duty = OCR0B; break;
#endif
#if defined(TCCR1A) && defined(COM1A1)
      case TIMER1A: on = TCCR1A & _BV(COM1A1); duty = OCR1A; break;
#endif
#if defined(TCCR1A) && defined(COM1B1)
      case TIMER1B: on = TCCR1A & _BV(COM1B1); duty = OCR1B; break;
#endif
#if defined(TCCR1A) && defined(COM1C1)
      case TIMER1C: on = TCCR1A & _BV(COM1C1); duty = OCR1C; break;
#endif
#if defined(TCCR2A) && defined(COM2A1)
      case TIMER2A: on = TCCR2A & _BV(COM2A1); duty = OCR2A; break;
#endif
#if defined(TCCR2A) && defined(COM2B1)
      case TIMER2B: on = TCCR2A & _BV(COM2B1); duty = OCR2B; break;
#endif
#if defined(TCCR3A) && defined(COM3A1)
      case TIMER3A: on = TCCR3A & _BV(COM3A1); duty = OCR3A; break;
#endif
#if defined(TCCR3A) && defined(COM3B1)
      case TIMER3B: on = TCCR3A & _BV(COM3B1); duty = OCR3B; break;
#endif
#if defined(TCCR3A) && defined(COM3C1)
      case TIMER3C: on = TCCR3A & _BV(COM3C1); duty = OCR3C; break;
#endif
#if defined(TCCR4A) && defined(COM4A1)
      case TIMER4A: on = TCCR4A & _BV(COM4A1); duty = OCR4A; break;
#endif
#if defined(TCCR4A) && defined(COM4B1)
      case TIMER4B: on = TCCR4A & _BV(COM4B1); duty = OCR4B; break;
#endif
#if defined(TCCR4A) && defined(COM4C1)
      case TIMER4C: on = TCCR4A & _BV(COM4C1); duty = OCR4C; break;
#endif
#if defined(TCCR5A) && defined(COM5A1)
      case TIMER5A: on = TCCR5A & _BV(COM5A1); duty = OCR5A; break;
#endif
#if defined(TCCR5A) && defined(COM5B1)
      case TIMER5B: on = TCCR5A & _BV(COM5B1); duty = OCR5B; break;
#endif
#if defined(TCCR5A) && defined(COM5C1)
      case TIMER5C: on = TCCR5A & _BV(COM5C1); duty = OCR5C; break;
#endif
      default: break;
    }
    if (on) {
      if (!first) out.print(',');
      out.print(pin); out.print(':'); out.print(duty & 0xFF);
      first = false;
    }
  }
}

#elif defined(ESP32)
#include "soc/gpio_reg.h"
#ifndef ELECTRICAD_ANALOG_COUNT
#ifdef PINODE_ANALOG_COUNT
#define ELECTRICAD_ANALOG_COUNT PINODE_ANALOG_COUNT
#else
#define ELECTRICAD_ANALOG_COUNT 0   // ESP32 ADC reads can disturb WiFi; opt in
#endif
#endif
#define ELECTRICAD_DIGITAL_COUNT 40
inline void gather(Masks& m) {
  m.modeLo = REG_READ(GPIO_ENABLE_REG);
  m.outLo  = REG_READ(GPIO_OUT_REG) & m.modeLo;
  m.inLo   = REG_READ(GPIO_IN_REG);
#if defined(GPIO_ENABLE1_REG) && defined(GPIO_OUT1_REG) && defined(GPIO_IN1_REG)
  // pins 32+ live in the second bank (ESP32: 32..39, S2/S3: 32..48)
  m.modeHi = REG_READ(GPIO_ENABLE1_REG) & 0x1FFFF;
  m.outHi  = REG_READ(GPIO_OUT1_REG) & m.modeHi;
  m.inHi   = REG_READ(GPIO_IN1_REG) & 0x1FFFF;
#endif
}
inline bool analogSafe(uint8_t i) { (void)i; return true; }
inline void printPwm(Print& out) { (void)out; }

#elif defined(ESP8266)
#ifndef ELECTRICAD_ANALOG_COUNT
#ifdef PINODE_ANALOG_COUNT
#define ELECTRICAD_ANALOG_COUNT PINODE_ANALOG_COUNT
#else
#define ELECTRICAD_ANALOG_COUNT 1   // A0
#endif
#endif
#define ELECTRICAD_DIGITAL_COUNT 17
inline void gather(Masks& m) {
  m.modeLo = (uint32_t)GPE & 0xFFFF;
  m.outLo  = (uint32_t)GPO & m.modeLo;
  m.inLo   = (uint32_t)GPI & 0xFFFF;
  if (GP16E & 1) { m.modeLo |= 1UL << 16; if (GP16O & 1) m.outLo |= 1UL << 16; }
  if (GP16I & 1) m.inLo |= 1UL << 16;
}
inline bool analogSafe(uint8_t i) { (void)i; return true; }
inline void printPwm(Print& out) { (void)out; }

#elif defined(ARDUINO_ARCH_RP2040)
#include "hardware/structs/sio.h"
#include "hardware/gpio.h"
#include "hardware/pwm.h"
#include "hardware/structs/pwm.h"
#ifndef ELECTRICAD_ANALOG_COUNT
#ifdef PINODE_ANALOG_COUNT
#define ELECTRICAD_ANALOG_COUNT PINODE_ANALOG_COUNT
#else
#define ELECTRICAD_ANALOG_COUNT 3   // A0..A2 (GP26..28)
#endif
#endif
#define ELECTRICAD_DIGITAL_COUNT 30
#define ELECTRICAD_HAS_PULL 1
inline void gather(Masks& m) {
  m.modeLo = sio_hw->gpio_oe & 0x3FFFFFFF;
  m.outLo  = sio_hw->gpio_out & m.modeLo;
  m.inLo   = sio_hw->gpio_in & 0x3FFFFFFF;
  for (uint8_t pin = 0; pin < ELECTRICAD_DIGITAL_COUNT; pin++) {
    if (!(m.modeLo & (1UL << pin)) && gpio_is_pulled_up(pin)) m.pullLo |= 1UL << pin;
  }
}
// analogRead() hands the pin to the ADC (and drops its digital input), so
// only pins the sketch hasn't claimed (function NULL) or already reads as
// analog are sampled. A0 = GP26.
inline bool analogSafe(uint8_t i) {
  return gpio_get_function(26 + i) == GPIO_FUNC_NULL;
}
// PWM: pins muxed to a running slice report duty scaled to 0..255.
inline void printPwm(Print& out) {
  bool first = true;
  for (uint8_t pin = 0; pin < ELECTRICAD_DIGITAL_COUNT; pin++) {
    if (gpio_get_function(pin) != GPIO_FUNC_PWM) continue;
    uint slice = pwm_gpio_to_slice_num(pin);
    if (!(pwm_hw->slice[slice].csr & 1u)) continue;        // CSR.EN
    uint32_t top = pwm_hw->slice[slice].top;
    uint32_t cc = pwm_hw->slice[slice].cc;
    uint32_t level = pwm_gpio_to_channel(pin) ? (cc >> 16) : (cc & 0xFFFF);
    uint32_t duty = top ? (level * 255u + top / 2) / (top + 1u) : 0;
    if (level > top) duty = 255;
    if (!first) out.print(',');
    out.print(pin); out.print(':'); out.print(duty > 255 ? 255 : duty);
    first = false;
  }
}

#elif defined(ARDUINO_ARCH_SAMD)
// SAMD21 / SAMD51: the variant table maps Arduino pins to PORT group + bit.
#ifndef ELECTRICAD_ANALOG_COUNT
#ifdef PINODE_ANALOG_COUNT
#define ELECTRICAD_ANALOG_COUNT PINODE_ANALOG_COUNT
#else
#define ELECTRICAD_ANALOG_COUNT 6   // A0..A5
#endif
#endif
#if defined(PINS_COUNT)
#define ELECTRICAD_DIGITAL_COUNT (PINS_COUNT > 64 ? 64 : PINS_COUNT)
#elif defined(NUM_DIGITAL_PINS)
#define ELECTRICAD_DIGITAL_COUNT (NUM_DIGITAL_PINS > 64 ? 64 : NUM_DIGITAL_PINS)
#else
#define ELECTRICAD_DIGITAL_COUNT 26
#endif
#define ELECTRICAD_HAS_PULL 1
inline void gather(Masks& m) {
  for (uint8_t pin = 0; pin < ELECTRICAD_DIGITAL_COUNT; pin++) {
    const PinDescription& d = g_APinDescription[pin];
    if ((int)d.ulPort < 0) continue;                      // NOT_A_PORT
    const uint32_t bit = 1UL << d.ulPin;
    PortGroup& g = PORT->Group[d.ulPort];
    if (g.DIR.reg & bit) {
      setBit(m.modeLo, m.modeHi, pin);
      if (g.OUT.reg & bit) setBit(m.outLo, m.outHi, pin);
    } else if ((g.PINCFG[d.ulPin].reg & PORT_PINCFG_PULLEN) && (g.OUT.reg & bit)) {
      setBit(m.pullLo, m.pullHi, pin);                     // PULLEN + OUT=1 = pull-up
    }
    if (g.IN.reg & bit) setBit(m.inLo, m.inHi, pin);
  }
}
// analogRead() re-muxes the pin to the ADC; skip pins in digital use
// (output, or input buffer enabled by pinMode).
inline bool analogSafe(uint8_t i) {
  const uint8_t pin = A0 + i;
  if (pin >= ELECTRICAD_DIGITAL_COUNT) return false;
  const PinDescription& d = g_APinDescription[pin];
  if ((int)d.ulPort < 0) return false;
  PortGroup& g = PORT->Group[d.ulPort];
  if (g.DIR.reg & (1UL << d.ulPin)) return false;
  const uint8_t cfg = g.PINCFG[d.ulPin].reg;
  if (cfg & PORT_PINCFG_INEN) return false;
  if (cfg & PORT_PINCFG_PMUXEN) {
    const uint8_t mux = g.PMUX[d.ulPin >> 1].reg;
    const uint8_t fn = (d.ulPin & 1) ? (mux >> 4) : (mux & 0x0F);
    if (fn != 1) return false;                              // muxed to something other than analog (B)
  }
  return true;
}
inline void printPwm(Print& out) { (void)out; }

#elif defined(ARDUINO_ARCH_RENESAS_UNO) || defined(ARDUINO_ARCH_RENESAS)
// UNO R4 (RA4M1). PmnPFS bits: 0 PODR, 1 PIDR, 2 PDR, 4 PCR, 15 ASEL, 16 PMR.
#ifndef ELECTRICAD_ANALOG_COUNT
#ifdef PINODE_ANALOG_COUNT
#define ELECTRICAD_ANALOG_COUNT PINODE_ANALOG_COUNT
#else
#define ELECTRICAD_ANALOG_COUNT 6   // A0..A5
#endif
#endif
#define ELECTRICAD_HAS_PULL 1
inline uint32_t pfsOf(int pin) {
  const bsp_io_port_pin_t pp = g_pin_cfg[pin].pin;
  return R_PFS->PORT[pp >> 8].PIN[pp & 0xFF].PmnPFS;
}
inline void gather(Masks& m) {
  const int n = (int)PINS_COUNT < 64 ? (int)PINS_COUNT : 64;
  for (int pin = 0; pin < n; pin++) {
    const uint32_t pfs = pfsOf(pin);
    if (!(pfs & (1UL << 16)) && (pfs & (1UL << 2))) {     // GPIO output
      setBit(m.modeLo, m.modeHi, pin);
      if (pfs & 1UL) setBit(m.outLo, m.outHi, pin);
    } else if (pfs & (1UL << 4)) setBit(m.pullLo, m.pullHi, pin);
    if (pfs & (1UL << 1)) setBit(m.inLo, m.inHi, pin);
  }
}
// analogRead() switches a pin to analog for good, which would break a
// digitalRead() on it, so only pins the sketch already reads as analog
// (ASEL set) are sampled.
inline bool analogSafe(uint8_t i) {
  const int pin = A0 + i;
  if (pin >= (int)PINS_COUNT) return false;
  return (pfsOf(pin) & (1UL << 15)) != 0;
}
inline void printPwm(Print& out) { (void)out; }

#else
#ifndef ELECTRICAD_ANALOG_COUNT
#ifdef PINODE_ANALOG_COUNT
#define ELECTRICAD_ANALOG_COUNT PINODE_ANALOG_COUNT
#else
#define ELECTRICAD_ANALOG_COUNT 0
#endif
#endif
#define ELECTRICAD_DIGITAL_COUNT 0
inline void gather(Masks& m) { (void)m; }
inline bool analogSafe(uint8_t i) { (void)i; return true; }
inline void printPwm(Print& out) { (void)out; }
#endif

// ---- onboard RGB (NeoPixel) -------------------------------------------------
// Templated so this header needs no NeoPixel library of its own: anything
// with getPixelColor(i), numPixels(), getBrightness() and getPin() works.
struct PixelSource {
  void* obj;
  uint32_t (*color)(void*, uint16_t);
  uint16_t (*count)(void*);
  uint8_t (*bright)(void*);
  int16_t (*pin)(void*);
};
inline PixelSource& pixels() { static PixelSource p = { 0, 0, 0, 0, 0 }; return p; }
template <typename S>
inline void watchPixels(S& strip) {
  PixelSource& p = pixels();
  p.obj = &strip;
  p.color = [](void* o, uint16_t i) -> uint32_t { return ((S*)o)->getPixelColor(i); };
  p.count = [](void* o) -> uint16_t { return ((S*)o)->numPixels(); };
  p.bright = [](void* o) -> uint8_t { return ((S*)o)->getBrightness(); };
  p.pin = [](void* o) -> int16_t { return ((S*)o)->getPin(); };
}
inline void printHex2(Print& out, uint8_t v) {
  const char* H = "0123456789ABCDEF";
  out.print(H[v >> 4]); out.print(H[v & 15]);
}
inline void printPixels(Print& out) {
  PixelSource& p = pixels();
  if (!p.obj) return;
  const int16_t pin = p.pin(p.obj);
  if (pin < 0) return;
  uint16_t n = p.count(p.obj);
  if (n > 8) n = 8;
  const uint16_t b = (uint16_t)p.bright(p.obj) + 1;   // 1..256
  out.print(F("|n=")); out.print(pin); out.print(':');
  for (uint16_t i = 0; i < n; i++) {
    const uint32_t c = p.color(p.obj, i);
    if (i) out.print(',');
    printHex2(out, (uint8_t)((((c >> 16) & 255) * b) >> 8));
    printHex2(out, (uint8_t)((((c >> 8) & 255) * b) >> 8));
    printHex2(out, (uint8_t)(((c & 255) * b) >> 8));
  }
}
// ---- UNO R4 WiFi LED matrix -------------------------------------------------
// Arduino_LED_Matrix.h keeps the live frame in a file-level `framebuffer`
// (bit i = pixel i), visible here when it was included first.
#if (defined(ARDUINO_ARCH_RENESAS_UNO) || defined(ARDUINO_ARCH_RENESAS)) && defined(NUM_LEDS) && defined(renderBitmap)
#define ELECTRICAD_HAS_MATRIX 1
inline void printMatrix(Print& out) {
  out.print(F("|x="));
  for (uint8_t i = 0; i < NUM_LEDS / 8; i++) printHex2(out, framebuffer[i]);
}
#else
inline void printMatrix(Print& out) { (void)out; }
#endif

inline void tick(Stream& out) {
  static unsigned long last = 0;
  unsigned long now = millis();
  if (now - last < ELECTRICAD_INTERVAL_MS) return;
  last = now;

  Masks m = { 0, 0, 0, 0, 0, 0, 0, 0 };
  gather(m);

  out.print(F("~PN1|t=")); out.print(now);
  out.print(F("|m=")); printMask(out, m.modeLo, m.modeHi);
  out.print(F("|o=")); printMask(out, m.outLo, m.outHi);
  out.print(F("|d=")); printMask(out, m.inLo, m.inHi);
#ifdef ELECTRICAD_HAS_PULL
  out.print(F("|u=")); printMask(out, m.pullLo, m.pullHi);
#endif
#if ELECTRICAD_ANALOG_COUNT > 0
  out.print(F("|a="));
  for (uint8_t i = 0; i < ELECTRICAD_ANALOG_COUNT; i++) {
    if (i) out.print(',');
    if (analogSafe(i)) out.print(analogRead(A0 + i));
  }
#endif
  out.print(F("|p="));
  printPwm(out);
  printPixels(out);
  printMatrix(out);
  out.println();
}

// delay() that keeps ticking, so the board view stays live during waits.
inline void delayTicking(Stream& out, unsigned long ms) {
  const unsigned long start = millis();
  for (;;) {
    tick(out);
    const unsigned long spent = millis() - start;
    if (spent >= ms) break;
    const unsigned long left = ms - spent;
    delay(left > 5 ? 5 : left);
  }
}

// I2C bus probe. Templated on the bus type so this header never needs
// <Wire.h> itself: works with Wire, Wire1, or any TwoWire-like object.
template <typename Bus>
inline uint8_t i2cScan(Bus& bus, Print& out) {
  uint8_t found[16];   // bitmap of addresses 0..127
  uint8_t n = 0;
  for (uint8_t i = 0; i < 16; i++) found[i] = 0;
  for (uint8_t addr = 1; addr < 127; addr++) {
    bus.beginTransmission(addr);
    if (bus.endTransmission() == 0) { found[addr >> 3] |= (uint8_t)(1 << (addr & 7)); n++; }
  }
  out.print(F("~PNI|n=")); out.print(n); out.print(F("|a="));
  bool first = true;
  for (uint8_t addr = 1; addr < 127; addr++) {
    if (!(found[addr >> 3] & (1 << (addr & 7)))) continue;
    if (!first) out.print(',');
    if (addr < 16) out.print('0');
    out.print(addr, HEX);
    first = false;
  }
  out.println();
  return n;
}

} // namespace electricad

#define ELECTRICAD_BEGIN() do {} while (0)
#define ELECTRICAD_TICK()  electricad::tick(Serial)
#define ELECTRICAD_DELAY(ms) electricad::delayTicking(Serial, (unsigned long)(ms))
#define ELECTRICAD_I2C_SCAN(bus) electricad::i2cScan((bus), Serial)
#define ELECTRICAD_NEOPIXEL(strip) electricad::watchPixels(strip)

/* legacy names — older sketches keep compiling unchanged */
#define PINODE_BEGIN() ELECTRICAD_BEGIN()
#define PINODE_TICK()  ELECTRICAD_TICK()

#endif
