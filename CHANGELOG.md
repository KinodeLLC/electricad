# Changelog

All notable changes to ElectriCAD. Downloads for each version are on the
[Releases page](https://github.com/KinodeLLC/electricad/releases). The full
design notes for each version are in [docs/ROADMAP.md](docs/ROADMAP.md).

## 0.9.7 — Real-looking boards, clones and 3D

- 3D view: spin any board that has design-file geometry (UNO family, Mega,
  Leonardo, Nano, Nano Every, the Feathers). Parts sit where the design files
  put them at their package's standard height; silkscreen, markings and live
  pins are painted on; hover a part for its box. Boards without that geometry
  keep the flat front and back. Uses three.js 0.159 (MIT), loaded on demand.
- "Report wrong image" is now a clear bordered button with a flag icon under
  the board picture.
- Board drawings now carry the real silkscreen from the makers' design files:
  pin labels, PWM / COMMUNICATION / POWER / ANALOG IN / DIGITAL headings,
  "MADE IN ITALY", part outlines, and the bitmap logos on the Adafruit
  Feathers (tools/extract-board-silk.js → renderer/boardsilk.js and
  renderer/img/silk). Only what the files contain is drawn.
- Boards are drawn in their real solder-mask colour (Arduino teal, sampled
  from Arduino's renders; black for the Adafruit Feathers) with a soft sheen.
- Fitted headers are drawn as black plastic with depth: female sockets on the
  shield headers, male 2×3 headers on ICSP (including the USB chip's ICSP on
  the Uno, Mega and Leonardo).
- Real photos, perspective-corrected so every pad sits on its pin, all
  openly licensed (credits in renderer/img/boards/CREDITS.md): a genuine
  UNO R3, and photos are cropped to the board instead of showing the table.
- Clone boards as revisions you can pick (the genuine board stays the
  default for detection): the blue SMD UNO with CH340G (photo), the black
  Mega 2560 + WiFi HW-888 with CH340G and ESP8266 (front and back photos),
  and the blue CH340G and USB-C Mega clones. Where no photo or design file
  exists, only what every clone shares is drawn (outline, holes, headers)
  and the parts are left out rather than guessed.

## 0.9.6 — Every component, hover box and full card

- Every fitted part (541 across 12 boards and revisions) placed from the
  makers' design files, with part numbers, values, packages and roles.
- Factory markings shown only where the print is known; nothing is invented.
- Hover any part on the board, the wiring canvas or the PCB for a short box
  with Details and LCSC / Digi-Key / Mouser links (they only open pages).
- Details card with connections, a close-up from the board picture, live
  specs, price breaks, stock, datasheet, footprint and pinout.

## 0.9.5 — Onboard LEDs

- Every board's LEDs placed from the makers' files and driven the way the
  real board drives them: pin LEDs, ON, TX/RX, Feather charge, NeoPixels and
  the UNO R4 WiFi LED matrix.
- Telemetry library 0.7.0 with UNO R4 support.

## 0.9.4 — Real boards

- Uno R3, Mega 2560 Rev3, Nano 3.x, Leonardo and Nano Every drawn in mm from
  Arduino's CAD, with official pictures and photos rectified onto the pins.
- Drawn / image / both / overlay views, front and back, rotate, and a
  revision picker with board detection.

## 0.9.3 — Real parts, grid, bug reports

- Live JLCPCB / LCSC parts search with KiCad symbols and footprints built in.
- Real catalogue parts on the canvas, PCB, BOM and CPL.
- Grid on the canvas and PCB, and in-app bug and wrong-image reports.

## 0.9.2 — PCB layers, pours, full screen

- 1, 2, 4 and 6 layer boards, inner planes, copper pours, per-layer Gerbers.
- Layers panel, pour tool, full screen by default.

## 0.9.1 — PCB editing controls

- Undo, redo, delete, nudge, and a properties panel for holes, vias, traces,
  text and parts.

## 0.9 and earlier

- PCB layout, ordering exports and the Windows .exe (0.9), and the earlier
  phases listed in [docs/ROADMAP.md](docs/ROADMAP.md).
