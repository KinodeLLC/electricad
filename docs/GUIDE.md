# ElectriCAD guide

ElectriCAD is a desktop IDE for Arduino, ESP32, Pico, MicroPython, CircuitPython and the Raspberry Pi. It shows your board's pins live, simulates the circuit you wire, and now turns that circuit into a printed circuit board you can order.

## The side bar

| Icon | What it opens |
|---|---|
| 🗂 Files | The project's files. Right-click a file to rename, duplicate or copy its path. |
| 🔍 Search | Search the project. Ctrl+Shift+H replaces across files with a preview. |
| 📚 Libraries | Install libraries and board cores. Sketch → Install a Library Version picks an older version. |
| 📦 Parts | The offline Adafruit catalog. Add a part to the wiring canvas from here. |
| 🔌 Wiring | The wiring canvas with a live circuit simulator. |
| 🟩 PCB | Lay out a board from the wiring canvas and order it. |
| ⎇ Git | Commit, branch, push, pull and blame. |
| ⚙ Settings | Everything else. Type in the search box at the top to find a setting. |

Settings → Appearance → Icon size switches between large labelled icons and small ones.

## Writing code

- **Ctrl+P** opens any file, **Ctrl+Shift+O** jumps to a function in this file, **F12** (or Edit → Go to Definition) jumps into other open files.
- **Edit → Lines** sorts, joins, duplicates, deletes and changes case. Column (box) selection is there too.
- **Edit → Local History** shows every saved copy of the file (the last 20), side by side with what you have now, and restores any of them.
- **Compare with Saved** shows unsaved changes. **Compare with Another File** diffs two files.
- Unsaved work is mirrored every 5 seconds. After a crash or power cut ElectriCAD offers it back when it starts.
- **Ctrl+Alt+R** looks up the word under the cursor in the Arduino reference.
- Images open in a preview. **To C array** turns them into a 1-bit bitmap for OLED `drawBitmap`.

## Building and uploading

- **Ctrl+R** verifies, **Ctrl+U** uploads. **Ctrl+Alt+U** uploads the last build without compiling again.
- **Sketch → Build for Several Boards** compiles the sketch for each ticked board and shows flash and RAM use side by side.
- **Sketch → Build Flags and Defines** stores `-D` defines and extra compiler flags in the project.
- **Settings → Build → Extra board manager URLs** adds third-party cores such as ATTinyCore or MiniCore.

## The wiring canvas

Drag parts from the palette, drag from pin to pin to wire, and press play to simulate. The simulator solves the real circuit: LED current, resistor heat, voltage drop, battery life. New in 0.9: hall sensor, tilt switch, solar cell, MQ-2 gas sensor, TP4056 charger, vibration motor and joystick.

## Real parts (JLCPCB / LCSC)

Open **Parts** and stay on the **JLCPCB / LCSC** tab. Type a part number (NE555), a value (10k 0603, 4k7) or an LCSC number (C25804). Every part JLCPCB can assemble shows its price, stock and whether it is a **basic** part (no extra assembly fee). Click one to see its specs, price breaks, datasheet, pinout and footprint, then **Place on canvas**.

- Pinouts come from the KiCad symbol for that exact part number, and footprints from KiCad's library for that package. When the match is only close (a packing suffix), or nothing matches, the card says so in red. Check those against the datasheet.
- On the PCB, a placed part uses its real footprint. Click the part to pick a different KiCad footprint.
- The BOM fills in the JLCPCB part number (C-number) and the manufacturer part number for these parts. Parts from the built-in palette stay blank, because ElectriCAD never guesses a part number. Right-click a canvas part and pick **Choose a real part** to swap it for a catalogue part. Its wires stay connected.
- The simulator uses the catalogue's numbers: LED forward voltage, zener voltage, regulator output and dropout, and supply ranges.
- Parts you open are saved on this computer, so they work offline. Parts you place are listed under My parts.
- Symbols and footprints come from the KiCad libraries (CC-BY-SA 4.0, KiCad Libraries Team).

## Reporting a problem

**Help → Report a Bug…** (or the command palette) sends a report to Kinode with the app version, the Windows version and your board, plus an optional screenshot. **⚑ Report wrong image** under the Live Board reports a picture that does not match your board.

## Grid

Both the wiring canvas and the PCB show a grid that pans and zooms with your design. **G** shows or hides it, **Shift+G** turns snapping on or off, and the toolbar has the same switches (**#** and **⌗**) plus the grid size: 10 to 80 px on the canvas, 0.1 to 2.54 mm on the PCB (0.635 mm is 25 mil, 1.27 mm is 50 mil, 2.54 mm is the 0.1 inch pin pitch). On the PCB, parts, traces, vias, holes and pours snap to the grid you pick, and the arrow keys nudge by one grid step. On the canvas, hold **Alt** while dragging a part to place it freely. Your choices are remembered.

## Full screen

ElectriCAD is laid out for a full screen and opens that way. **F11** or **⛶** in the top bar switches full screen on and off; while it is on, minimise (—) and close (✕) are in the top bar. The PCB tab uses the whole window: **◫ Panels** on its toolbar brings the file, board and serial panels back.

Every panel resizes, the left icon bar included (its icons and labels grow as it widens): drag the gripped strip between the icon bar, the explorer, the editor, the serial/output panel, the Live Board and the AI Copilot. Drag a strip all the way shut to hide that panel and drag it back out to open it again. Double-click a strip to put that panel back to its default size. Sizes are remembered.

## PCB layout

1. Wire the circuit on the canvas.
2. Open the **PCB** tab. Parts arrive with real footprints, placed in rows on a board with M3 corner holes.
3. Drag parts into place. **R** rotates, **F** moves a part to the bottom side, **Del** deletes.
4. Press **X** (Route), click a pad, click to bend, and click the target pad. **L** switches top and bottom copper; **V** drops a via while routing. Thin lines show what is still unrouted.
5. The panel on the right is the design-rule check (every layer, planes and pours included). Click a problem to jump to it.
6. **Editing:** Undo, Redo, Delete, Clear (removes every trace, via, hole and text) and Reset (starts the board again) are on the toolbar; Ctrl+Z / Ctrl+Y and Del work too, and arrow keys nudge the selection (Shift for 2.54 mm). Clicking an item shows its sizes in the side panel: hole size (M2 to M5 or any diameter), via drill and pad, trace width and layer, text, and for a part its position, rotation, side, and pad and hole size for all its pins. With nothing selected the panel edits the board size, the default sizes for new holes, vias and traces, and the design rules.
7. **Layers:** the Layers list in the side panel sets 1, 2, 4 or 6 copper layers. A 1-layer board has its copper underneath and no plated holes. On 4 and 6 layers, each inner layer is a signal layer or a solid plane of one net (GND under the top layer is the usual choice); planes join their net's pads with thermal spokes. Each row shows or hides its layer, sets its colour, and clicking it makes it the layer you route on (**L** cycles, **1**–**6** pick one; switching layers mid-trace drops a via). Silkscreen, mask openings, paste, outline and holes have rows too.
8. **Copper pours:** **P** (Pour) and click the corners, then click the first corner, double-click or press Enter. The pour takes the net of the pad you started on, or GND. **Pour on …** fills the whole active layer. Select a pour to change its net, layer, clearance and whether pads join by thermal spokes or solid copper. The rule check warns about pieces of a pour that are cut off from the rest.
9. **Export** writes Gerbers, drill files, a BOM, pick-and-place files and a KiCad netlist into the project's `fab` folder. **Preview** draws the Gerbers back from the files.

Footprints are through-hole (KiCad sizes). Parts whose package varies, such as modules and sensors on breakout boards, get a plain pin header in the canvas's pin order and a **check** note: measure your module before you order.

## Ordering boards

**Order PCB** in the PCB tab checks the design, exports, opens the maker's upload page and shows the zip in Explorer: drag the zip onto their page. Makers: JLCPCB, PCBWay, OSH Park, Aisler, Eurocircuits and Seeed Fusion.

**Tools → Manufacturing → Order PCBs from a Gerber Zip** does the same for a zip from KiCad, EasyEDA or Eagle, after checking it for missing layers and reading the board size and holes.

ElectriCAD never uploads files or places orders. The BOM has columns for LCSC or manufacturer part numbers and search links to LCSC, Digi-Key and Mouser, but it never guesses a part number.

## Serial monitor

Colours from ANSI codes, clock or Δt timestamps, freeze, record to a file, DTR and RTS, Ctrl+C and Ctrl+D buttons for Python boards, a repeat sender and a raw typing mode (⌨) that sends each key as you press it.

## Python boards

**F5** runs the open file on the board, **Shift+F5** stops it, **F6** runs the selection. Python → Upload This File Only sends one file after checking its syntax on the board. Board Files → Edit on the board opens a file from the board; Ctrl+S writes it back.

## Calculators and tools

Tools → Electronics Calculators has 31 tools: LED resistor, dividers, colour codes, RC, 555, Ohm's law, battery life, ADC, series and parallel, wire gauge drop, PCB trace width, transistor base resistor, zener, PWM, servo, stepper steps/mm, NTC thermistor, AVR Timer1, decibels, number converter, ASCII, RGB565, notes for `tone()`, I²C addresses and CRCs.

## Keyboard

F1 lists every shortcut. Ctrl+Shift+P opens the command palette, which finds any command by name.
