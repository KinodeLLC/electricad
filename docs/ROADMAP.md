# ElectriCAD roadmap — the monster plan

Target: Visual Studio-grade depth, every feature justified by microcontroller
work. Phases ordered so each ships something usable.

## 0.9.2 — PCB layers, pours, full screen

- L.stack = {count: 1|2|4|6, planes: {In1: 'GND', …}}; layer ids F, In1–In4, B
  (1-layer = bottom copper, unplated holes). THT pads and vias span every layer
- Zones (inner planes + L.pours[{layer, net, pts, clearance, thermal}]) are
  rasterised once in pcb.js analyze() (cached); the same shape list writes the
  Gerber (G36 region, %LPC% cut-outs, thermal spokes), so view = DRC = Gerber
- Per-layer Gerbers (In1_Cu.g1 …, Copper,Ln,Inr,Plane|Signal), Excellon
  Plated,1,N, stackup.txt for 4+ layers (layer order; maker stackups named,
  never invented); DRC: missing layers, 1-layer vias/top SMD, pour nets,
  cut-off islands, different-net zones too close
- Layers panel (show/hide, colour, active layer), Pour tool, preview per inner layer
- Full screen by default (window.fullscreen in settings), F11 / ⛶, min/close in
  the top bar; PCB view hides side/right/bottom panels (◫ Panels toggles)

## 0.9.1 — PCB editing controls

- Undo/Redo/Delete/Clear/Reset on the PCB toolbar, arrow-key nudge
- Properties panel: hole, via, trace, text and part edits incl. per-part pad
  and hole size (pl.pad = {dia, drill}, applied in pcb.js padsWorld so copper,
  drill files and DRC all follow); board size, default sizes, design rules

## Phase 1.9 — SHIPPED in v0.9 (123 items: PCB layout, ordering, .exe)

- PCB layout (renderer/pcb.js + pcbview.js): netlist from the wiring canvas,
  THT footprint library with KiCad sizes (generic headers with a "check" note
  where a package varies), placement on a 0.635 mm grid, two-layer routing
  with vias and ratsnest, outline and M3 holes, DRC (clearance, shorts,
  unrouted, drill, annular ring, edge, holes, overlaps), RS-274X X2 Gerbers
  plus Excellon zipped with KiCad-style names, Gerber preview read back from
  the files
- Manufacturing: Order button (JLCPCB, PCBWay, OSH Park, Aisler,
  Eurocircuits, Seeed) opens the maker page and reveals the zip, nothing is
  uploaded; Gerber-zip checker; BOM (generic/JLCPCB/PCBWay, search links,
  never guessed part numbers); CPL; KiCad and CSV netlists
- Editor: document symbols and go to definition across open files, replace
  in project with preview, local history (20 saves) with diff and restore,
  compare with saved / another file, hot exit, Markdown and image preview
  (image → C bitmap), line tools, column selection, cursor/line-number/
  font/guides settings, save on focus loss, ● in the title when unsaved
- Build: several boards at once, per-project defines and flags, upload last
  build, open build folder, library versions and details, third-party board
  URLs, project rename/duplicate/archive, datasheet search
- Serial: ANSI colours, Δt timestamps, freeze, record, DTR/RTS, Ctrl+C/D,
  repeat sender, raw typing; plotter legend toggles, crosshair, PNG; timeline CSV
- Git: push/pull/fetch, remotes, commit details, blame
- Python: syntax check before upload, edit files on the board, upload one
  file, mkdir, CircuitPython lib/ sync, firmware links
- Parts: hall, tilt, solar cell, MQ-2, TP4056, vibration motor, joystick
- 17 more calculators and tools; AI fix button, sketch from a description,
  save chat; accent colours, compact mode, bigger labelled icons, pinned
  projects, What's New, built-in guide, settings search and reset
- Windows installer (NSIS, desktop + Start menu shortcuts) and portable .exe
  via electron-builder (npm run dist)
- Still open: SMD footprints beyond SOT-223, auto-router, copper pours,
  importing a .kicad_pcb

## Phase 1.8 — SHIPPED in v0.8 (the 102-item round)

- Build: Board Options from the core's own menus (stored in the FQBN), Board
  Info, Upload Using Programmer, Burn Bootloader, clean build, warnings and
  verbose settings, flash/RAM delta per build, taskbar progress, desktop
  notifications, Include Library, Library Examples (copied into a project)
- Pin checker (renderer/pincheck.js): live squiggles + project report +
  Output after compile, for Uno/Nano/Mega/Leonardo/Nano Every, classic ESP32
  and Pico only — every other FQBN is deliberately unchecked
- Editor: formatter (renderer/format.js, Shift+Alt+F, format/trim on save),
  Ctrl+P, Ctrl+G, find/replace menu, comment toggle, reopen closed tab,
  tab cycling, close others/all, per-project tab sessions, word wrap /
  minimap / sticky scroll / whitespace / ligatures, status bar language +
  selection + EOL, TODO list, New Class, duplicate file, copy relative path,
  14 C++ and 16 MicroPython/CircuitPython snippets
- Serial: send file, quick-send macros, copy output, error/warning colours,
  auto-reconnect on replug, rx counter, buffer size, show/clear on upload;
  plotter min/max/avg and fixed Y range
- Python: run selection (F6), set board clock, download all board files,
  open CIRCUITPY, free RAM/flash in board info
- Git: discard file (confirmed), create/switch branch, stage/unstage all
- Canvas: PNG export; parts PIR, PC817, LM2596 buck, LM317, VS1838B IR
  receiver, capacitive soil sensor (hookups, recipes, catalog classify)
- Calculators (renderer/calc.js): 14 tools incl. 555, cap codes, AVR baud
  error, regulator heat, battery packs; engineering input (4k7, 100n)
- App: pinout table, light theme, zen mode, UI zoom, recent commands,
  welcome tips, arduino-cli version in About, errors to Output, settings
  export/import (API key excluded). 71 tests.

## Phase 1.7 — SHIPPED in v0.7 (more of everything)

- MicroPython: new project type, Run (F5) over the raw REPL with output
  streamed to the monitor, Stop (Shift+F5), soft reset, upload every
  project file with size verification, board file browser (copy in /
  delete), board info
- CircuitPython: new project type, CIRCUITPY drive detection (boot_out.txt),
  upload = copy code.py and friends to the drive
- Git: source control panel (Ctrl+Shift+G) with init, stage/unstage,
  commit (Ctrl+Enter), diffs and history, identity setup
- Boards: Leonardo (32u4) and Nano Every (4809) views with exact pin maps,
  Uno R4 detected as Uno-compatible header, nRF52 feathers no longer shown
  as M4 (generic view instead, accuracy rule); Adafruit SAMD and RP2040
  cores compile-verified with the telemetry library
- Build: Export Compiled Binary (Ctrl+Alt+S), install library from ZIP,
  upgrade all libraries / all cores, updatable-library badge
- Serial: hex view and hex send (raw bytes)
- Sim: reed switch, SPDT slide switch, LM35, CR2032 coin cell
- 5 Python examples (17 total), async test runner, 61 tests

## Phase 1.6 — SHIPPED in v0.6 (the polish pass)

- Fixes: Ctrl+R no longer reloads the window (real app menu), unsaved-work
  guard on close/reload, atomic file + settings writes, new projects never
  overwrite, plain Arduino sketch folders open as projects, last board
  remembered, Verify saves every tab, squiggles on every open file,
  floating circuits solve cleanly (GMIN), serial IPC batched, telemetry
  markers found mid-line, pigpio polling can't pile up, catalog search ranked
- IDE: welcome screen, 12 examples (File → New from Example), Arduino
  completions/hover/signature help, outline, collapsible tree with
  rename/delete/new folder, tab context menu, auto-save, settings for
  editor/serial/AI, toggleable panes, F1 shortcut sheet
- Build: cancel, flash/RAM usage with warnings, upload hints (port busy,
  not in sync, ESP boot mode), missing-header → library search, AI explain
- Serial: timestamps, filter, baud switch, line endings, history, board
  reset, save log; plotter CSV + pause; timeline span + Hz; I2C bus panel
- Sim: voltmeter, ammeter, TMP36, pot wiper, INPUT_PULLUP and FLOAT reads
- Canvas: duplicate/delete/rename, wire right-click delete, live meter
  readouts, pins.h via net tracing, BOM CSV with catalog prices
- Library 0.6: ELECTRICAD_DELAY, ELECTRICAD_I2C_SCAN, pull-ups, ESP32 pins
  32–39, RP2040 PWM duty, SAMD support, analog reads that never steal pins
- Boards: Feather M0 view; Feather M4 / RP2040 / HUZZAH32 matched exactly
  (variants with different pinouts fall back to generic views)

## Phase 1.5 — SHIPPED in v0.5

- Canvas UX: pan (drag empty space), wheel-zoom-to-cursor, fit view,
  drag-to-wire with ghost preview, undo/redo (Ctrl+Z/Y), part filter box
- Parts knowledge base: every part carries how-it-works, designed voltage
  range, failure mode, and a canonical hookup schematic in canvas-native
  form (ⓘ info cards, "Place canonical hookup")
- Ratings engine: solved node voltages checked against every part's
  designed/absolute-max range; NeoPixel 0.7×VDD data check; motor loads
  judged by where the current comes from (pin/rail/driver)
- A4988 stepper driver modeled (current-limited coil drive, VMOT window)
- Full-size Feather family boards (ESP32 HUZZAH32 / RP2040 / M0-M4) with
  real GPIO maps + detection routing
- Offline Adafruit catalog (5,573 products) with interface classification
  and one-click "Wire it" canonical hookups; on-your-bench device matching
- Core auto-install: board-manager URLs injected (esp32/esp8266/rp2040/
  adafruit/teensy), missing core installed on first compile
- Firmware bench for thingino camera work: USB-UART, CH341A (5V-data-line
  hazard simulated), W25Q SPI flash, Ingenic IP cam target
- Surgical updater (only ElectriCAD's electron killed); ElectriCAD logo

## Phase 1 — SHIPPED in v0.1 (this repo)

- Electron shell: activity bar, explorer, tabs, Monaco (cpp/python), command
  palette, keyboard shortcuts, status bar, toasts
- Toolchain: arduino-cli auto-bootstrap, AVR core auto-install, board
  detect/select, compile + upload, Problems panel with click-through
  diagnostics + editor squiggles, library search/install, core manager
- Live board views: Uno, Nano, ESP32 DevKit, Pi 40-pin header — pin pads
  painted by mode (in/out/pwm) and level, onboard LED glow, pin inspector
  with history sparkline, stale detection
- Telemetry: PinodeTelemetry lib (AVR register-direct + ESP32), serial demux,
  pigpiod network client for Pi (BR1 bank reads @20 Hz, mode sweep @1 Hz)
- Panels: serial monitor with send, auto-plotter (label:value lines),
  pin timeline (logic-analyzer-lite, 10 s window), output log
- AI copilot: streaming, Anthropic/OpenAI-compatible/Ollama, hardware context
  (live pins + serial tail + diagnostics + code), stop button, ctx toggle
- Project system: pinode.json manifests, templates, recents, workspace search

## Phase 2 — IDE depth

- clangd language server for real IntelliSense (arduino-cli can export
  compile_commands.json) — completions, hover types, go-to-definition
- Git: status/stage/commit/branch in the Source Control view (spawn git)
- Multi-root workspaces; split editors; drag-dock panels
- Serial: multiple simultaneous ports (one per board), per-port monitors
- Windows installer (electron-builder NSIS) + file association for .ino
- Settings sync file format; import from Arduino IDE sketchbook

## Phase 3 — hardware depth

- Protocol decoders on the timeline: UART, I2C, SPI from sampled edges;
  pigpiod NOTIFY socket (microsecond edge timestamps) instead of polling
- I2C bus scanner ("what's on the bus?" — needs telemetry lib command channel)
- PWM/servo/tone inspector; interrupt counters
- Wiring designer: parts library (LED, button, sensors), draws onto the board
  view, generates pin-assignment header file
- Pi: remote file sync + run-over-SSH (deploy main.py, stream stdout back);
  gpiozero-aware templates
- Debugger: GDB via arduino-cli debug for SAMD/ESP32; on-target variable watch

## Phase 4 — AI depth

- AI tool-use: let the model request a compile, read a file, set a pin (with
  confirmation), run an I2C scan — closes the diagnose→verify loop
- "Explain this timeline" — hand the model a captured trace window
- Wiring photos: drop a photo of the breadboard, AI cross-checks against the
  sketch's pin usage
- Sketch review mode: pre-upload lint (blocking delays in ISRs, un-debounced
  inputs, float in tight loops)

## Phase 5 — ecosystem

- Simulator (AVR8js) for boardless development
- Board definition plugin format (JSON) so new boards are data, not code
- Share/import projects; example browser wired to installed libraries
- Telemetry over WiFi for ESP32 (UDP beacon → no serial cable)
