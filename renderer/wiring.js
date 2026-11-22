// Wiring designer + live circuit simulation. Parts are draggable nodes with
// typed ports; the current board is a node whose ports are its real pins.
// Wires connect ports — click-click or drag, in any color — and RUN turns on
// the electricity: PinodeSim solves the circuit and the canvas shows exactly
// what would happen — current animating along each wire (direction and
// thickness are real), LEDs lighting at their actual brightness, reversed
// parts staying dark, and a safety strip calling out shorts, overcurrent,
// out-of-spec voltages, fire and shock risks BEFORE you build it for real.
// Every part carries its knowledge (PinodeParts): how it works, what voltage
// it is designed for, how it fails, and its canonical hookup schematic in
// canvas-native form. The canvas pans (drag empty space), zooms (wheel),
// and undoes (Ctrl+Z / Ctrl+Y).
/* global PINODE_BOARDS, PinodeSim, PinodeParts, PinodeHistory */
window.PinodeWiring = (function () {
  const NS = 'http://www.w3.org/2000/svg';

  const WIRE_COLORS = ['#ff5c5c', '#111111', '#ff9d3f', '#ffd94a', '#3fd07a',
                       '#4aa3ff', '#c77dff', '#e8e8e8', '#8b5a2b'];

  const P = window.PinodeParts;
  const PART_GROUPS = P.PART_GROUPS;
  const PARTS = P.PARTS;
  const PART_INFO = P.PART_INFO;
  const HOOKUPS = P.HOOKUPS;
  const RECIPES = P.RECIPES;

  let ctx = null;
  let root = null, svg = null, canvasEl = null, nodesEl = null, warnEl = null, barInfo = null, zoomLabel = null;
  let model = null;     // { parts, wires: [{from,to,color?}], boardX, boardY, manualPins, view }
  let pending = null;   // port key waiting for its second click
  let ghost = null;     // {fromKey, x, y} screen-space preview wire
  let dragWire = null;  // active drag-to-wire {fromKey}
  let suppressClick = false;
  let selWire = -1;
  let selPart = 0;      // uid of the selected part (Delete / Ctrl+D)
  let uidSeq = 1;
  let simOn = false;
  let simResult = null;
  let simTimer = null;
  const hist = PinodeHistory.makeHistory(120);

  // ---- helpers --------------------------------------------------------------
  function portType(key) {
    const [kind, uid, portId] = key.split(':');
    if (kind === 'board') {
      const pin = ctx.getBoardDef().pins[Number(uid)];
      if (!pin) return 'sig';
      return pin.power === 'gnd' ? 'neg' : pin.power ? 'pos' : 'sig';
    }
    const part = model.parts.find((p) => p.uid === Number(uid));
    const def = P.defOf(part);
    const port = def && def.ports.find((p) => p.id === portId);
    return (port && port.type) || 'sig';
  }
  const defaultColor = (a, b) => {
    const t = portType(a) + portType(b);
    if (t.includes('pos')) return WIRE_COLORS[0];
    if (t.includes('neg')) return WIRE_COLORS[1];
    return WIRE_COLORS[2];
  };
  const partDef = (type) => PARTS.find((d) => d.type === type);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const U = window.ElectriCADUtil;
  const sep = (dir) => (dir.includes('\\') ? '\\' : '/');

  function removePart(uid) {
    mutate(() => {
      model.parts = model.parts.filter((p) => p.uid !== uid);
      model.wires = model.wires.filter((w) =>
        !w.from.startsWith('part:' + uid + ':') && !w.to.startsWith('part:' + uid + ':'));
    });
    if (selPart === uid) selPart = 0;
  }
  function duplicatePart(uid) {
    const src = model.parts.find((p) => p.uid === uid);
    if (!src) return;
    const copy = JSON.parse(JSON.stringify(src));
    copy.uid = uidSeq++;
    copy.x = (src.x || 0) + 30; copy.y = (src.y || 0) + 30;
    mutate(() => { model.parts.push(copy); });
    selPart = copy.uid;
    render();
  }
  async function renamePart(part) {
    const r = await window.electricadDialog({ title: 'Rename part', okLabel: 'Rename',
      fields: [{ key: 'n', label: 'Name (used for #define names in pins.h)', value: part.name }] });
    if (r && r.n.trim()) mutate(() => { part.name = r.n.trim().slice(0, 40); });
  }

  // ---- history: snapshots exclude the viewport (undo shouldn't jump it) ----
  function snapshot() {
    const { view, ...rest } = model;
    return rest;
  }
  function restore(m) {
    model = { ...m, view: model.view };
    uidSeq = Math.max(1, ...model.parts.map((p) => p.uid + 1), 1);
  }
  // every mutation goes through here: history, persist, repaint
  function mutate(fn) {
    hist.push(snapshot());
    fn();
    save();
    if (simOn) { render(); runSim(); } else render();
  }
  function undoRedo(redo) {
    const m = redo ? hist.redo(snapshot()) : hist.undo(snapshot());
    if (!m) return ctx.toast(redo ? 'Nothing to redo' : 'Nothing to undo', 1200);
    restore(m);
    pending = null; ghost = null; selWire = -1;
    save();
    if (simOn) { render(); runSim(); } else render();
  }

  // ---- persistence ----------------------------------------------------------
  function fileFor(dir) { return dir + (dir.includes('\\') ? '\\' : '/') + 'wiring.json'; }
  async function load() {
    model = { parts: [], wires: [], manualPins: {}, view: { x: 0, y: 0, z: 1 } };
    const dir = ctx.getProjectDir();
    if (!dir) return;
    try {
      const j = JSON.parse(await ctx.api.file.read(fileFor(dir)));
      if (j && Array.isArray(j.parts)) model = { manualPins: {}, view: { x: 0, y: 0, z: 1 }, ...j };
      if (!model.view) model.view = { x: 0, y: 0, z: 1 };
      uidSeq = Math.max(1, ...model.parts.map((p) => p.uid + 1), 1);
    } catch (e) { /* fresh canvas */ }
    hist.clear();
  }
  async function save() {
    const dir = ctx.getProjectDir();
    if (!dir) return;
    try { await ctx.api.file.write(fileFor(dir), JSON.stringify(model, null, 2)); } catch (e) {}
  }

  // ---- viewport: pan / zoom -------------------------------------------------
  function applyView() {
    const v = model.view;
    nodesEl.style.transformOrigin = '0 0';
    nodesEl.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.z})`;
    paintGrid();
    if (zoomLabel) zoomLabel.textContent = Math.round(v.z * 100) + '%';
    scheduleWires();
  }
  // ---- grid: drawn in world units so it pans and zooms with the parts ------
  const GRID_KEY = 'ec_wgrid';
  let grid = { on: true, step: 20, snap: true };
  try { grid = { ...grid, ...JSON.parse(localStorage.getItem(GRID_KEY) || '{}') }; } catch (e) { /* defaults */ }
  const saveGrid = () => { try { localStorage.setItem(GRID_KEY, JSON.stringify(grid)); } catch (e) { /* ok */ } };
  function paintGrid() {
    if (!canvasEl || !model) return;
    const v = model.view;
    canvasEl.classList.toggle('grid-off', !grid.on);
    const minor = grid.step * v.z, major = minor * 5;
    canvasEl.style.setProperty('--gmin', minor + 'px');
    canvasEl.style.setProperty('--gmaj', major + 'px');
    canvasEl.style.backgroundPosition = `${v.x}px ${v.y}px`;
    canvasEl.classList.toggle('grid-fine', minor < 7);
    const b = root && root.querySelector('#wiringGrid'), sb = root && root.querySelector('#wiringSnap'), st = root && root.querySelector('#wiringGridStep');
    if (b) b.classList.toggle('on', grid.on);
    if (sb) sb.classList.toggle('on', grid.snap);
    if (st) st.value = String(grid.step);
  }
  function setGrid(patch, say) {
    grid = { ...grid, ...patch };
    saveGrid(); paintGrid();
    if (say) ctx.toast(say, 1200);
  }
  const snapW = (n) => (grid.snap ? Math.round(n / grid.step) * grid.step : Math.round(n));
  function screenToWorld(cx, cy) {
    const v = model.view;
    return { x: (cx - v.x) / v.z, y: (cy - v.y) / v.z };
  }
  function zoomAt(cx, cy, factor) {
    const v = model.view;
    const z2 = Math.min(2.5, Math.max(0.25, v.z * factor));
    v.x = cx - (cx - v.x) * (z2 / v.z);
    v.y = cy - (cy - v.y) * (z2 / v.z);
    v.z = z2;
    applyView();
    saveViewSoon();
  }
  function fitView() {
    const kids = [...nodesEl.children];
    if (!kids.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const k of kids) {
      x0 = Math.min(x0, k.offsetLeft); y0 = Math.min(y0, k.offsetTop);
      x1 = Math.max(x1, k.offsetLeft + k.offsetWidth);
      y1 = Math.max(y1, k.offsetTop + k.offsetHeight);
    }
    const cw = canvasEl.clientWidth, ch = canvasEl.clientHeight;
    const z = Math.min(1.4, Math.max(0.25, Math.min(cw / (x1 - x0 + 80), ch / (y1 - y0 + 80))));
    model.view.z = z;
    model.view.x = (cw - (x1 - x0) * z) / 2 - x0 * z;
    model.view.y = (ch - (y1 - y0) * z) / 2 - y0 * z;
    applyView();
    saveViewSoon();
  }
  let viewSaveT = null;
  function saveViewSoon() { clearTimeout(viewSaveT); viewSaveT = setTimeout(save, 600); }

  function viewportCenterWorld() {
    return screenToWorld(canvasEl.clientWidth / 2, canvasEl.clientHeight / 2);
  }

  // ---- pin states: real telemetry wins, manual drives the rest --------------
  function currentPinStates() {
    const map = new Map();
    const live = ctx.getPinStates() || [];
    const fresh = ctx.telemetryFresh && ctx.telemetryFresh();
    if (fresh) {
      for (const s of live) map.set(s.pin, s);
    }
    for (const [tele, v] of Object.entries(model.manualPins || {})) {
      if (!fresh) map.set(Number(tele), v === 'pullup' ? { mode: 'in', pull: 'up', level: 0 }
                                                     : { mode: 'out', level: v === 'high' ? 1 : 0 });
    }
    return map;
  }

  // ---- simulation loop ------------------------------------------------------
  function runSim() {
    const def = ctx.getBoardDef();
    const boardPins = def.pins.map((pin, i) => ({
      key: 'board:' + i, tele: pin.tele, label: pin.label, power: pin.power }));
    // parts go in with their knowledge-base ratings attached, so the solver
    // can judge every solved voltage against what the part is designed for
    const parts = model.parts.map((p) => {
      const rat = p.ratings || ((PART_INFO[p.type] || {}).ratings);
      return rat ? { ...p, ratings: rat } : p;
    });
    simResult = PinodeSim.solve({
      boardVolts: /esp|pico|pi|nodemcu|feather/.test(def.id) ? 3.3 : 5,
      wires: model.wires,
      parts,
      boardPins,
      pinStates: currentPinStates()
    });
    renderWarnings();
    drawWires();
    paintParts();
  }

  function setSim(on) {
    simOn = on;
    root.querySelector('#wiringRun').textContent = on ? '■ Stop' : '▶ Run';
    root.querySelector('#wiringRun').classList.toggle('running', on);
    if (simTimer) { clearInterval(simTimer); simTimer = null; }
    if (on) { runSim(); simTimer = setInterval(runSim, 300); }
    else { simResult = null; renderWarnings(); render(); }
  }

  function renderWarnings() {
    if (!warnEl) return;
    warnEl.innerHTML = '';
    if (!simOn || !simResult) { warnEl.classList.add('hidden'); return; }
    const list = simResult.warnings;
    const seen = new Set();
    const unique = list.filter((w) => !seen.has(w.msg) && seen.add(w.msg));
    if (!unique.length) {
      warnEl.classList.remove('hidden');
      warnEl.innerHTML = '<div class="whint ok">✓ No electrical issues detected in this circuit.</div>';
      return;
    }
    warnEl.classList.remove('hidden');
    const order = { danger: 0, warn: 1, hint: 2 };
    unique.sort((a, b) => (order[a.level] || 3) - (order[b.level] || 3));
    for (const w of unique.slice(0, 8)) {
      const d = document.createElement('div');
      d.className = 'whint ' + w.level;
      d.textContent = (w.level === 'danger' ? '⚠ ' : w.level === 'warn' ? '△ ' : '💡 ') + w.msg;
      warnEl.appendChild(d);
    }
  }

  // ---- canonical hookups: the schematic engine ------------------------------
  function findBoardPort(spec) {
    const def = ctx.getBoardDef();
    const byPower = (kinds) => {
      for (const k of kinds) {
        const i = def.pins.findIndex((p) => p.power === k);
        if (i >= 0) return 'board:' + i;
      }
      return null;
    };
    if (spec === 'gnd') return byPower(['gnd']);
    if (spec === '5v') return byPower(['v5', 'v33']);
    if (spec === '3v3') return byPower(['v33', 'v5']);
    if (spec === 'vin') return byPower(['vin', 'v5', 'v33']);
    if (spec.startsWith('pin:')) {
      for (const label of spec.slice(4).split('|')) {
        const i = def.pins.findIndex((p) => p.label === label && p.tele != null);
        if (i >= 0) return 'board:' + i;
      }
    }
    return null;
  }

  // Place a canonical hookup. over = { name, ratings, catalogId } customizes
  // the first part of the anchor type (used for real Adafruit products).
  function placeHookup(type, over) {
    const h = HOOKUPS[type];
    if (!h) { ctx.toast('No canonical hookup for ' + type); return false; }
    const c = viewportCenterWorld();
    let applied = false;
    const placed = [];
    mutate(() => {
      h.parts.forEach((spec, i) => {
        const def2 = partDef(spec.type);
        const part = { uid: uidSeq++, type: spec.type, name: def2.name, ...spec,
                       x: Math.round(c.x + 40 + (i % 2) * 170),
                       y: Math.round(c.y - 120 + Math.floor(i / 2) * 110) };
        if (over && !applied && spec.type === type) {
          if (over.name) part.name = over.name;
          if (over.ratings) part.ratings = over.ratings;
          if (over.catalogId) part.catalogId = over.catalogId;
          applied = true;
        }
        model.parts.push(part);
        placed.push(part);
      });
      let missed = 0;
      for (const [a, b] of h.wires) {
        const resolve = (s) => {
          if (/^p\d+:/.test(s)) {
            const [pi, port] = s.slice(1).split(':');
            return 'part:' + placed[Number(pi)].uid + ':' + port;
          }
          return findBoardPort(s);
        };
        const ka = resolve(a), kb = resolve(b);
        if (ka && kb) model.wires.push({ from: ka, to: kb, color: defaultColor(ka, kb) });
        else missed++;
      }
      if (h.note) ctx.toast((over && over.name ? over.name : partDef(type).name) + ': ' + h.note, 5200);
      if (missed) setTimeout(() => ctx.toast(missed + ' wire(s) had no matching pin on this board', 3000), 300);
    });
    return true;
  }

  // Real product from the Adafruit catalog → classified module on the canvas.
  function placeCatalogItem(prod) {
    const cls = P.classify(prod.name, prod.catName);
    const shortName = prod.name.replace(/^Adafruit\s+/i, '').slice(0, 44);
    if (!cls) {
      const c = viewportCenterWorld();
      mutate(() => {
        model.parts.push({ uid: uidSeq++, type: 'generic', name: shortName,
                           catalogId: prod.id, x: Math.round(c.x), y: Math.round(c.y) });
      });
      ctx.toast('Placed as a generic part — no interface classification for this product. Check its Adafruit guide.', 4200);
      return { ok: true, iface: null };
    }
    placeHookup(cls.type, { name: shortName, ratings: cls.ratings, catalogId: prod.id });
    return { ok: true, iface: cls.iface };
  }

  // swap a generic canvas part for a real catalogue one, keeping its wires
  const SWAP_QUERY = {
    resistor: (p) => U.ohms(p.r || 220).replace('Ω', '') + ' resistor', led: (p) => (p.color || 'red') + ' LED', capC: () => '100nF capacitor', capE: (p) => (p.vr || 16) + 'V electrolytic capacitor',
    diode: () => '1N4001', schottky: () => '1N5819', zener: () => 'zener 5.1V', npn: () => '2N2222', pnp: () => '2N2907', nmos: () => 'AO3400', pmos: () => 'AO3401',
    reg7805: () => 'L7805', reg33: () => 'AMS1117-3.3', fuse: (p) => 'fuse ' + (p.r || 1) + 'A', inductor: () => 'inductor', lm317: () => 'LM317'
  };
  let swapTarget = 0;
  function chooseRealPart(part) {
    swapTarget = part.uid;
    const q = part.lib ? (part.lib.mfr || part.name) : SWAP_QUERY[part.type](part);
    if (window.electricadSearchParts) window.electricadSearchParts(q);
    ctx.toast('Pick the part for ' + part.name + ': its card has a "Use for" button', 3500);
  }
  function swapInfo() { const p = swapTarget && model && model.parts.find((x) => x.uid === swapTarget); return p ? { uid: p.uid, name: p.name || ((P.defOf(p) || {}).name) || p.type, type: p.type } : null; }
  function swapLibPart(uid, spec) {
    const old = model.parts.find((p) => p.uid === uid);
    if (!old) return false;
    const fresh = JSON.parse(JSON.stringify(spec));
    const ports = new Set(((P.defOf(fresh) || {}).ports || []).map((p) => p.id));
    let dropped = 0;
    mutate(() => {
      Object.keys(old).forEach((k) => { if (!['uid', 'x', 'y'].includes(k)) delete old[k]; });
      Object.assign(old, fresh, { uid: old.uid });
      model.wires = model.wires.filter((w) => {
        const keep = [w.from, w.to].every((k) => !k.startsWith('part:' + uid + ':') || ports.has(k.split(':')[2]));
        if (!keep) dropped++;
        return keep;
      });
    });
    swapTarget = 0;
    ctx.toast(old.name + (old.lib && old.lib.lcsc ? ' (' + old.lib.lcsc + ')' : '') + ' swapped in' + (dropped ? '; ' + dropped + ' wire(s) had no matching pin and were removed' : ', wires kept'), dropped ? 5000 : 2500);
    return true;
  }

  // A real part from the JLCPCB/LCSC catalogue (built by partlib.toCanvasPart)
  function placeLibPart(spec) {
    const c = viewportCenterWorld();
    const part = JSON.parse(JSON.stringify(spec));
    mutate(() => {
      // the first free spot near the middle of the view (rows of 220 × 170)
      const busy = (x, y) => model.parts.some((p) => Math.abs((p.x || 0) - x) < 200 && Math.abs((p.y || 0) - y) < 150);
      let at = { x: c.x - 80, y: c.y - 60 };
      for (let i = 0; i < 60 && busy(at.x, at.y); i++) at = { x: c.x - 80 + ((i % 4) - 1) * 220, y: c.y - 60 + Math.floor(i / 4) * 170 };
      model.parts.push({ ...part, uid: uidSeq++, x: snapW(at.x), y: snapW(at.y) });
    });
    const notes = (part.lib && part.lib.notes) || [];
    const warn = notes.find((n) => /confirm|no KiCad|check the datasheet|pick one/i.test(n));
    ctx.toast(part.name + (part.lib && part.lib.lcsc ? ' (' + part.lib.lcsc + ')' : '') + ' placed' + (warn ? '. Check: ' + warn : ''), warn ? 6000 : 2200);
    return true;
  }

  // ---- part info card: how it works, its voltage, how it fails --------------
  function showPartInfo(type, displayName, iface) {
    const info = PART_INFO[type] || {};
    const def2 = partDef(type);
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal winfo';
    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const ports = (def2 ? def2.ports : []).map((p) => esc(p.label)).join(' · ');
    box.innerHTML = `
      <div class="modal-title">${esc(displayName || (def2 && def2.name) || type)}</div>
      ${iface ? `<div class="winfo-row"><span class="winfo-k">INTERFACE</span><span>${esc(iface)}</span></div>` : ''}
      <div class="winfo-row"><span class="winfo-k">PINS</span><span>${ports}</span></div>
      <div class="winfo-row"><span class="winfo-k">HOW IT WORKS</span><span>${esc(info.how || '—')}</span></div>
      <div class="winfo-row"><span class="winfo-k">DESIGNED FOR</span><span>${esc(info.volts || '—')}</span></div>
      <div class="winfo-row danger"><span class="winfo-k">IF YOU OVERDO IT</span><span>${esc(info.fail || '—')}</span></div>
      ${HOOKUPS[type] && HOOKUPS[type].note ? `<div class="winfo-row"><span class="winfo-k">CANONICAL HOOKUP</span><span>${esc(HOOKUPS[type].note)}</span></div>` : ''}
      <div class="modal-btns">
        ${HOOKUPS[type] ? '<button class="action primary" id="winfoPlace">⚡ Place canonical hookup</button>' : ''}
        <button class="action" id="winfoClose">Close</button>
      </div>`;
    ov.appendChild(box);
    document.body.appendChild(ov);
    const close = () => ov.remove();
    box.querySelector('#winfoClose').addEventListener('click', close);
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    const pl = box.querySelector('#winfoPlace');
    if (pl) pl.addEventListener('click', () => { close(); placeHookup(type); });
  }

  // ---- building the view ----------------------------------------------------
  function build(host) {
    host.innerHTML = '';
    root = document.createElement('div');
    root.id = 'wiringRoot';
    root.innerHTML = `
      <div id="wiringParts">
        <div class="view-head">ELECTRICAD</div>
        <input id="wiringFilter" class="input slim wfilter" placeholder="filter parts…">
        <div id="wiringPartsList"></div>
      </div>
      <div id="wiringCanvas">
        <svg id="wiringSvg"></svg>
        <div id="wiringNodes"></div>
        <div id="wiringWarn" class="hidden"></div>
      </div>
      <div id="wiringBar">
        <button class="mini" id="wiringRun" title="Simulate the circuit">▶ Run</button>
        <span id="wiringColors" class="hidden"></span>
        <span id="wiringInfo" class="dim" style="padding:0">drag port → port to wire · right-click for more · F1 lists shortcuts</span>
        <span class="grow"></span>
        <button class="mini" id="wiringZoomOut" title="Zoom out">−</button>
        <span id="wiringZoom" class="dim" style="padding:0;min-width:38px;text-align:center">100%</span>
        <button class="mini" id="wiringZoomIn" title="Zoom in">＋</button>
        <button class="mini" id="wiringFit" title="Fit everything in view">⛶</button>
        <button class="mini" id="wiringGrid" title="Show or hide the grid (G)"># Grid</button>
        <select class="input slim" id="wiringGridStep" title="Grid spacing">${[10, 20, 40, 80].map((n) => `<option value="${n}">${n} px</option>`).join('')}</select>
        <button class="mini" id="wiringSnap" title="Snap parts to the grid when you move them (Shift+G). Hold Alt while dragging to place freely.">⌗ Snap</button>
        <button class="mini" id="wiringExport" title="Write pins.h with a #define for every wired signal">Export pins.h</button>
        <button class="mini" id="wiringBom" title="Bill of materials as CSV, with Adafruit prices where known">BOM</button>
        <button class="mini" id="wiringImage" title="Save the canvas as a PNG image">Image</button>
        <button class="mini" id="wiringClear">Clear</button>
      </div>`;
    host.appendChild(root);
    svg = root.querySelector('#wiringSvg');
    canvasEl = root.querySelector('#wiringCanvas');
    nodesEl = root.querySelector('#wiringNodes');
    warnEl = root.querySelector('#wiringWarn');
    barInfo = root.querySelector('#wiringInfo');
    zoomLabel = root.querySelector('#wiringZoom');

    buildPalette('');
    root.querySelector('#wiringFilter').addEventListener('input', (e) => buildPalette(e.target.value));

    // wire color palette (shown when a wire is selected)
    const colors = root.querySelector('#wiringColors');
    for (const c of WIRE_COLORS) {
      const s = document.createElement('span');
      s.className = 'wcolor';
      s.style.background = c;
      s.addEventListener('click', () => {
        if (selWire >= 0 && model.wires[selWire]) {
          mutate(() => { model.wires[selWire].color = c; });
        }
      });
      colors.appendChild(s);
    }
    root.querySelector('#wiringRun').addEventListener('click', () => setSim(!simOn));
    root.querySelector('#wiringExport').addEventListener('click', exportHeader);
    root.querySelector('#wiringBom').addEventListener('click', exportBom);
    root.querySelector('#wiringImage').addEventListener('click', exportImage);
    root.querySelector('#wiringClear').addEventListener('click', () => {
      if (!model.parts.length && !model.wires.length) return;
      mutate(() => { model.parts = []; model.wires = []; });
      ctx.toast('Canvas cleared — Ctrl+Z brings it back', 2600);
    });
    root.querySelector('#wiringZoomIn').addEventListener('click', () =>
      zoomAt(canvasEl.clientWidth / 2, canvasEl.clientHeight / 2, 1.2));
    root.querySelector('#wiringZoomOut').addEventListener('click', () =>
      zoomAt(canvasEl.clientWidth / 2, canvasEl.clientHeight / 2, 1 / 1.2));
    root.querySelector('#wiringFit').addEventListener('click', fitView);
    root.querySelector('#wiringGrid').addEventListener('click', () => setGrid({ on: !grid.on }));
    root.querySelector('#wiringSnap').addEventListener('click', () => setGrid({ snap: !grid.snap }, grid.snap ? 'Snap off' : 'Snap to grid on'));
    root.querySelector('#wiringGridStep').addEventListener('change', (e) => setGrid({ step: Number(e.target.value) || 20 }));

    // wheel zoom, anchored on the cursor
    canvasEl.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = canvasEl.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    }, { passive: false });

    // drag empty space to pan
    canvasEl.addEventListener('mousedown', (e) => {
      if (e.target !== canvasEl && e.target !== svg && e.target !== nodesEl) return;
      if (e.button !== 0 && e.button !== 1) return;
      e.preventDefault();
      const start = { x: e.clientX, y: e.clientY, vx: model.view.x, vy: model.view.y };
      canvasEl.classList.add('panning');
      const move = (ev) => {
        model.view.x = start.vx + (ev.clientX - start.x);
        model.view.y = start.vy + (ev.clientY - start.y);
        applyView();
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        canvasEl.classList.remove('panning');
        saveViewSoon();
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    // click empty space: cancel a pending wire, deselect
    canvasEl.addEventListener('click', (e) => {
      if (e.target !== canvasEl && e.target !== svg && e.target !== nodesEl) return;
      if (pending) { pending = null; ghost = null; render(); }
      if (selPart) { selPart = 0; nodesEl.querySelectorAll('.wnode.selected').forEach((x) => x.classList.remove('selected')); }
      if (selWire >= 0) { selWire = -1; root.querySelector('#wiringColors').classList.add('hidden'); drawWires(); }
    });
    // ghost wire follows the cursor
    canvasEl.addEventListener('mousemove', (e) => {
      if (!pending && !dragWire) return;
      const r = svg.getBoundingClientRect();
      ghost = { fromKey: dragWire ? dragWire.fromKey : pending,
                x: e.clientX - r.left, y: e.clientY - r.top };
      scheduleWires();
    });

    document.addEventListener('keydown', onKeydown);
  }

  function buildPalette(filter) {
    const list = root.querySelector('#wiringPartsList');
    list.innerHTML = '';
    const q = (filter || '').toLowerCase();
    // every real part: hand the query to the JLCPCB/LCSC search in the Parts view
    const real = document.createElement('div');
    real.className = 'wpart wreal';
    real.innerHTML = q ? `🔎 <span>Search JLCPCB / LCSC for “${esc(filter.trim())}”</span>` : '🔎 <span>Real parts: search JLCPCB / LCSC</span>';
    real.title = 'Any part JLCPCB can assemble, with its real pinout, footprint, specs and LCSC number';
    real.addEventListener('click', () => window.electricadSearchParts && window.electricadSearchParts(filter ? filter.trim() : ''));
    list.appendChild(real);
    if (!q) {
      const rh = document.createElement('div');
      rh.className = 'view-head';
      rh.textContent = 'RECIPES';
      list.appendChild(rh);
      for (const r of RECIPES) {
        const b = document.createElement('div');
        b.className = 'wpart recipe';
        b.textContent = '⚡ ' + r.name;
        b.title = r.desc;
        b.addEventListener('click', () => placeHookup(r.use));
        list.appendChild(b);
      }
    }
    for (const g of PART_GROUPS) {
      const matches = g.parts.filter((p) => !q || p.name.toLowerCase().includes(q) || p.type.includes(q));
      if (!matches.length) continue;
      const h = document.createElement('div');
      h.className = 'view-head';
      h.textContent = g.group;
      list.appendChild(h);
      for (const p of matches) {
        const b = document.createElement('div');
        b.className = 'wpart';
        b.innerHTML = `<span>${esc(p.name)}</span><span class="winfobtn" title="How it works, ratings, canonical hookup">ⓘ</span>`;
        b.addEventListener('click', (e) => {
          if (e.target.classList.contains('winfobtn')) { showPartInfo(p.type); return; }
          const c = viewportCenterWorld();
          mutate(() => {
            model.parts.push({ uid: uidSeq++, type: p.type, name: p.name,
                               ...(p.defaults || {}),
                               x: Math.round(c.x - 60 + Math.random() * 120), y: Math.round(c.y - 80 + Math.random() * 120) });
          });
        });
        list.appendChild(b);
      }
    }
  }

  function onKeydown(e) {
    if (!root || !root.offsetParent) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' ||
              (t.closest && t.closest('.monaco-editor')))) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undoRedo(false); }
    else if (mod && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); undoRedo(true); }
    else if (mod && e.key.toLowerCase() === 'd' && selPart) { e.preventDefault(); duplicatePart(selPart); }
    else if (!mod && !e.altKey && e.key.toLowerCase() === 'g') {
      e.preventDefault();
      if (e.shiftKey) setGrid({ snap: !grid.snap }, grid.snap ? 'Snap off' : 'Snap to grid on');
      else setGrid({ on: !grid.on }, grid.on ? 'Grid hidden' : 'Grid shown');
    }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selWire < 0 && selPart) { e.preventDefault(); removePart(selPart); }
    else if (e.key === 'Delete' && selWire >= 0) {
      const i = selWire;
      selWire = -1;
      root.querySelector('#wiringColors').classList.add('hidden');
      mutate(() => { model.wires.splice(i, 1); });
    } else if (e.key === 'Escape') {
      if (pending || dragWire) { pending = null; dragWire = null; ghost = null; render(); }
      if (selWire >= 0) { selWire = -1; root.querySelector('#wiringColors').classList.add('hidden'); drawWires(); }
      if (selPart) { selPart = 0; nodesEl.querySelectorAll('.wnode.selected').forEach((x) => x.classList.remove('selected')); }
    }
  }

  function connectPorts(a, b) {
    if (a === b) return;
    const dup = model.wires.some((w) => (w.from === a && w.to === b) || (w.from === b && w.to === a));
    if (dup) { ctx.toast('Already wired', 1200); return; }
    mutate(() => { model.wires.push({ from: a, to: b, color: defaultColor(a, b) }); });
  }

  function portDot(key, label, type, live, extras) {
    const d = document.createElement('div');
    d.className = 'wport t-' + type + (pending === key ? ' pending' : '');
    d.dataset.key = key;
    d.innerHTML = `<span class="dot${live ? ' live-' + live : ''}"></span><span class="wplabel">${esc(label)}</span>` +
                  (extras ? `<span class="wvolt">${esc(extras)}</span>` : '');
    // drag-to-wire: press, pull, release on another port. A no-move press
    // falls back to the classic click-click pending flow.
    d.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const sx = e.clientX, sy = e.clientY;
      let started = false;
      const move = (ev) => {
        if (!started && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 6) {
          started = true;
          dragWire = { fromKey: key };
          d.classList.add('pending');
        }
        if (started) {
          const r = svg.getBoundingClientRect();
          ghost = { fromKey: key, x: ev.clientX - r.left, y: ev.clientY - r.top };
          scheduleWires();
        }
      };
      const up = (ev) => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        if (!started) return; // plain click — the click handler takes it
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 0);
        dragWire = null; ghost = null;
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        const portEl = el && el.closest && el.closest('.wport');
        if (portEl && portEl.dataset.key) connectPorts(key, portEl.dataset.key);
        else { d.classList.remove('pending'); scheduleWires(); }
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    d.addEventListener('click', (e) => {
      e.stopPropagation();
      if (suppressClick) return;
      if (!pending) { pending = key; render(); return; }
      if (pending !== key) connectPorts(pending, key);
      pending = null; ghost = null; render();
    });
    return d;
  }

  function render() {
    if (!root) return;
    nodesEl.innerHTML = '';
    const def = ctx.getBoardDef();
    const pinStates = currentPinStates();

    // board node
    const bn = document.createElement('div');
    bn.className = 'wnode board';
    bn.style.left = (model.boardX || 20) + 'px';
    bn.style.top = (model.boardY || 30) + 'px';
    bn.innerHTML = `<div class="whead">⚡ ${esc(def.name)}</div>`;
    const cols = document.createElement('div');
    cols.className = 'wcols';
    const colA = document.createElement('div'), colB = document.createElement('div');
    def.pins.forEach((pin, i) => {
      if (pin.extra) return;   // ICSP repeats and NC: drawn on the live board, not wiring ports
      const key = 'board:' + i;
      const st = pin.tele != null ? pinStates.get(pin.tele) : null;
      const live = st ? (st.mode === 'pwm' ? 'pwm' : (st.level ? 'hi' : 'lo')) : '';
      const type = pin.power === 'gnd' ? 'neg' : pin.power ? 'pos' : 'sig';
      let extras = '';
      if (simOn && simResult && simResult.netOf.has(key)) {
        const v = simResult.netVolts[simResult.netOf.get(key)];
        if (v !== undefined) extras = v.toFixed(1) + 'V';
        const rd = simResult.pinReads && simResult.pinReads[key];
        if (rd) extras += (extras ? ' ' : '') + (rd === 'UNDEFINED' ? '?' : rd);
      }
      const dot = portDot(key, pin.label, type, live, extras);
      if (pin.tele != null && !pin.power) {
        dot.title = 'double-click: drive this pin (input → HIGH → LOW → INPUT_PULLUP)';
        dot.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          mutate(() => {
            const cur = model.manualPins[pin.tele];
            model.manualPins[pin.tele] = cur === 'high' ? 'low' : cur === 'low' ? 'pullup' : cur === 'pullup' ? undefined : 'high';
            if (model.manualPins[pin.tele] === undefined) delete model.manualPins[pin.tele];
          });
        });
        const manual = model.manualPins[pin.tele];
        if (manual) dot.classList.add('manual-' + manual);
      }
      (i % 2 ? colB : colA).appendChild(dot);
    });
    cols.appendChild(colA); cols.appendChild(colB);
    bn.appendChild(cols);
    draggable(bn, (x, y) => { model.boardX = x; model.boardY = y; });
    nodesEl.appendChild(bn);

    // part nodes
    for (const part of model.parts) {
      const def2 = P.defOf(part) || { ports: [] };
      const n = document.createElement('div');
      n.className = 'wnode';
      n.dataset.uid = part.uid;
      n.style.left = part.x + 'px';
      n.style.top = part.y + 'px';
      const sub = part.type === 'resistor' || part.type === 'ldr' || part.type === 'thermistor'
                    ? ` <span class="dim">${part.r || (part.type === 'resistor' ? 220 : 10000)}Ω</span>` :
                  part.type === 'button' ? ` <span class="dim">${part.closed ? 'PRESSED' : 'open'}</span>` :
                  part.type === 'psu' ? ` <span class="dim">${part.volts || 5}V${part.amps ? ' ' + part.amps + 'A' : ''}${part.watts ? ' ' + part.watts + 'W' : ''}</span>` :
                  part.type === 'fuse' ? ` <span class="dim">${part.r || 1}A</span>` :
                  part.type === 'pot' ? ` <span class="dim">${U.ohms(part.r || 10000)} @${Math.round((part.pos ?? 0.5) * 100)}%</span>` :
                  part.type === 'tmp36' || part.type === 'lm35' ? ` <span class="dim">${part.tempC ?? 25}°C</span>` :
                  part.type === 'reed' ? ` <span class="dim">${part.closed ? 'magnet' : 'open'}</span>` :
                  part.type === 'pir' ? ` <span class="dim">${part.closed ? 'MOTION' : 'still'}</span>` :
                  part.type === 'buck' || part.type === 'lm317' ? ` <span class="dim">→${part.vout ?? 5}V</span>` :
                  part.type === 'irrecv' ? ` <span class="dim">${part.closed ? 'RECEIVING' : 'idle'}</span>` :
                  part.type === 'soil' ? ` <span class="dim">${part.moisture ?? 40}% wet</span>` :
                  part.type === 'slide' ? ` <span class="dim">COM→${part.closed ? 'B' : 'A'}</span>` :
                  part.type === 'hall' ? ` <span class="dim">${part.closed ? 'magnet' : 'no field'}</span>` :
                  part.type === 'tilt' ? ` <span class="dim">${part.closed ? 'upright' : 'TIPPED'}</span>` :
                  part.type === 'solar' ? ` <span class="dim">${part.light ?? 100}% sun</span>` :
                  part.type === 'mq2' ? ` <span class="dim">gas ${part.gas ?? 0}%</span>` :
                  part.type === 'joystick' ? ` <span class="dim">X${Math.round((part.x ?? 0.5) * 100)} Y${Math.round((part.y ?? 0.5) * 100)}${part.closed ? ' ●' : ''}</span>` :
                  part.type === 'linreg' ? ` <span class="dim">→${part.vout}V</span>` :
                  part.type === 'led' && part.color ? ` <span class="dim">${esc(part.color)}</span>` : '';
      const libTag = part.lib ? ` <span class="wlib" title="${esc((part.lib.lcsc ? 'LCSC ' + part.lib.lcsc + ' · ' : '') + (part.lib.maker || '') + ' ' + (part.lib.mfr || '') + ' · ' + (part.lib.pkg || ''))}">${esc(part.lib.pkg || 'lib')}</span>` : '';
      const pst = simOn && simResult ? simResult.partState[part.uid] : null;
      const meter = pst && pst.reading ? ` <span class="wmeter">${U.si(pst.reading.value, pst.reading.unit)}</span>` :
                    (part.type === 'voltmeter' || part.type === 'ammeter') ? ' <span class="wmeter off">—</span>' : '';
      if (part.uid === selPart) n.classList.add('selected');
      n.innerHTML = `<div class="whead"><span class="wled"></span><span class="wname">${esc(part.name)}</span>${sub}${libTag}${meter}` +
                    `<span class="winfobtn wnodei" title="How it works">ⓘ</span><span class="wx" title="Remove">✕</span></div>`;
      n.querySelector('.wx').addEventListener('click', () => removePart(part.uid));
      n.querySelector('.whead').addEventListener('mousedown', () => {
        if (selPart !== part.uid) {
          selPart = part.uid;
          nodesEl.querySelectorAll('.wnode.selected').forEach((x) => x.classList.remove('selected'));
          n.classList.add('selected');
        }
      });
      n.querySelector('.whead').addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const cm = window.electricadContextMenu;
        if (!cm) return;
        cm(e.clientX, e.clientY, [
          ...(editors[part.type] ? [{ label: { button: 'Press / release', reed: 'Magnet near / away', slide: 'Slide', pir: 'Motion / still', irrecv: 'Remote button / idle', hall: 'Magnet near / away', tilt: 'Tip / stand up' }[part.type] || 'Edit values…', run: editors[part.type] }] : []),
          { label: 'Rename…', run: () => renamePart(part) },
          { label: 'Duplicate', keys: 'Ctrl+D', run: () => duplicatePart(part.uid) },
          ...(SWAP_QUERY[part.type] || part.lib ? [{ label: part.lib ? 'Choose a different real part…' : 'Choose a real part (JLCPCB / LCSC)…', run: () => chooseRealPart(part) }] : []),
          { label: part.lib ? 'Datasheet, specs and pinout' : 'How it works', run: () => (part.lib && window.electricadPartDetails ? window.electricadPartDetails(part) : showPartInfo(part.type, part.name !== (def2 && def2.name) ? part.name : null)) },
          '-',
          { label: 'Delete', keys: 'Del', danger: true, run: () => removePart(part.uid) }
        ]);
      });
      if (def2.ports.length > 10) n.classList.add('wnode-wide');
      n.querySelector('.wnodei').addEventListener('click', (e) => {
        e.stopPropagation();
        if (part.lib && window.electricadPartDetails) { window.electricadPartDetails(part); return; }
        showPartInfo(part.type, part.name !== (def2 && def2.name) ? part.name : null);
      });
      // interactive parts (window.electricadDialog — Electron has no prompt())
      const ask = window.electricadDialog;
      const oneNum = (title, label, cur, min, apply) => async () => {
        const r = await ask({ title, fields: [{ key: 'v', label, value: cur, type: 'number' }] });
        if (r && r.v !== '') mutate(() => apply(Math.max(min, Number(r.v) || min)));
      };
      const editors = {
        button: () => { mutate(() => { part.closed = !part.closed; }); },
        reed: () => { mutate(() => { part.closed = !part.closed; }); },
        slide: () => { mutate(() => { part.closed = !part.closed; }); },
        pir: () => { mutate(() => { part.closed = !part.closed; }); },
        irrecv: () => { mutate(() => { part.closed = !part.closed; }); },
        hall: () => { mutate(() => { part.closed = !part.closed; }); },
        tilt: () => { mutate(() => { part.closed = !part.closed; }); },
        solar: oneNum('Solar panel', 'Sunlight (%), 0 = dark … 100 = full sun', part.light ?? 100, 0, (v) => { part.light = Math.min(100, v); }),
        mq2: async () => {
          const r = await ask({ title: 'MQ-2 gas sensor', okLabel: 'Set', fields: [
            { key: 'g', label: 'Gas level (0 = clean air … 100 = heavy smoke)', value: part.gas ?? 0, type: 'number' },
            { key: 't', label: 'DOUT threshold (trimpot, 0 … 100)', value: part.threshold ?? 50, type: 'number' }] });
          if (r) mutate(() => { part.gas = Math.max(0, Math.min(100, Number(r.g) || 0)); part.threshold = Math.max(0, Math.min(100, Number(r.t) || 0)); });
        },
        joystick: async () => {
          const r = await ask({ title: 'Joystick', okLabel: 'Set', fields: [
            { key: 'x', label: 'X position (0 … 100 %, 50 = centre)', value: Math.round((part.x ?? 0.5) * 100), type: 'number' },
            { key: 'y', label: 'Y position (0 … 100 %, 50 = centre)', value: Math.round((part.y ?? 0.5) * 100), type: 'number' },
            { key: 'p', label: 'Button', value: part.closed ? 'pressed' : 'released', options: ['released', 'pressed'] }] });
          if (r) mutate(() => { part.x = Math.max(0, Math.min(100, Number(r.x))) / 100; part.y = Math.max(0, Math.min(100, Number(r.y))) / 100; part.closed = r.p === 'pressed'; });
        },
        lm317: oneNum('LM317', 'Output voltage (V), 1.25 … 37', part.vout ?? 5, 1.25, (v) => { part.vout = Math.min(37, v); }),
        soil: oneNum('Soil moisture', 'Moisture (%), 0 = dry air … 100 = water', part.moisture ?? 40, 0, (v) => { part.moisture = Math.min(100, v); }),
        buck: oneNum('Buck converter', 'Output voltage (V), 1.25 … 35', part.vout ?? 5, 1.25, (v) => { part.vout = Math.min(35, v); }),
        lm35: oneNum('LM35', 'Temperature (°C), 2 … 150', part.tempC ?? 25, 0, (v) => { part.tempC = Math.min(150, v); }),
        resistor: oneNum('Resistor', 'Resistance (Ω)', part.r || 220, 1, (v) => { part.r = v; }),
        ldr: oneNum('LDR', 'Resistance right now (Ω) — bright ≈ 1k, dark ≈ 100k', part.r || 10000, 1, (v) => { part.r = v; }),
        thermistor: oneNum('Thermistor', 'Resistance right now (Ω)', part.r || 10000, 1, (v) => { part.r = v; }),
        fuse: oneNum('Fuse', 'Rating (A)', part.r || 1, 0.05, (v) => { part.r = v; }),
        capE: oneNum('Electrolytic capacitor', 'Voltage rating (V)', part.vr || 16, 1, (v) => { part.vr = v; }),
        tmp36: oneNum('TMP36', 'Temperature (°C), −40 … 125', part.tempC ?? 25, -40, (v) => { part.tempC = Math.min(125, v); }),
        pot: async () => {
          const r = await ask({ title: 'Potentiometer', okLabel: 'Set', fields: [
            { key: 'r', label: 'Total resistance (Ω)', value: part.r || 10000, type: 'number' },
            { key: 'pos', label: 'Wiper position (0 … 100 %)', value: Math.round((part.pos ?? 0.5) * 100), type: 'number' }
          ] });
          if (!r) return;
          mutate(() => {
            part.r = Math.max(10, Number(r.r) || 10000);
            part.pos = Math.min(1, Math.max(0, (Number(r.pos) || 0) / 100));
          });
        },
        led: async () => {
          const r = await ask({ title: 'LED', fields: [{ key: 'c', label: 'Color',
            options: ['red', 'orange', 'yellow', 'green', 'blue', 'white'], value: part.color || 'red' }] });
          if (r) mutate(() => { part.color = r.c; });
        },
        psu: async () => {
          const r = await ask({ title: 'Power supply', okLabel: 'Set', fields: [
            { key: 'volts', label: 'Voltage (V) — required', value: part.volts ?? 5, type: 'number' },
            { key: 'amps', label: 'Current capacity (A) — blank = unlimited', value: part.amps ?? 1, type: 'number' },
            { key: 'watts', label: 'Power (W) — optional, overrides amps', value: part.watts ?? '', type: 'number' }
          ] });
          if (!r || r.volts === '') return;
          mutate(() => {
            part.volts = Math.max(0.1, Number(r.volts) || 5);
            part.amps = r.amps === '' ? undefined : Math.max(0.01, Number(r.amps) || 1);
            part.watts = r.watts === '' ? undefined : Math.max(0.1, Number(r.watts));
            if (part.watts) part.amps = part.watts / part.volts;
          });
        }
      };
      if (part.type === 'pot') {
        n.querySelector('.whead').addEventListener('wheel', (e) => {
          e.preventDefault(); e.stopPropagation();
          part.pos = Math.min(1, Math.max(0, (part.pos ?? 0.5) + (e.deltaY < 0 ? 0.05 : -0.05)));
          const d = n.querySelector('.whead .dim');
          if (d) d.textContent = `${U.ohms(part.r || 10000)} @${Math.round(part.pos * 100)}%`;
          if (simOn) runSim();
          saveViewSoon();
        }, { passive: false });
      }
      if (editors[part.type]) {
        n.querySelector('.whead').addEventListener('dblclick', editors[part.type]);
        n.title = part.type === 'button' ? 'double-click: press/release · right-click: more'
          : part.type === 'pot' ? 'double-click: edit · scroll on the title: turn the knob'
          : 'double-click: edit values · right-click: more';
      }
      for (const port of def2.ports) {
        const key = 'part:' + part.uid + ':' + port.id;
        let extras = '';
        if (simOn && simResult && simResult.netOf.has(key)) {
          const v = simResult.netVolts[simResult.netOf.get(key)];
          if (v !== undefined) extras = v.toFixed(1) + 'V';
        }
        n.appendChild(portDot(key, port.label, port.type, '', extras));
      }
      draggable(n, (x, y) => { part.x = x; part.y = y; });
      nodesEl.appendChild(n);
    }
    applyView();
    requestAnimationFrame(() => { drawWires(); paintParts(); });
  }

  function paintParts() {
    if (!nodesEl) return;
    for (const part of model.parts) {
      const el = nodesEl.querySelector(`[data-uid="${part.uid}"] .wled`);
      if (!el) continue;
      const st = simOn && simResult ? simResult.partState[part.uid] : null;
      const meter = nodesEl.querySelector(`[data-uid="${part.uid}"] .wmeter`);
      if (meter) {
        const rd = st && st.reading;
        meter.textContent = rd ? U.si(rd.value, rd.unit) : '—';
        meter.classList.toggle('off', !rd);
      }
      if (st && st.on) {
        const bright = Math.min(1, st.current / 0.02);
        const LEDC = { red: '#ff5c5c', green: '#3fd07a', blue: '#4aa3ff', yellow: '#ffd94a',
                       white: '#ffffff', orange: '#ff9d3f' };
        const c = part.type === 'led' ? (LEDC[part.color] || '#ff5c5c') : '#3fd07a';
        el.style.background = c;
        el.style.boxShadow = `0 0 ${4 + bright * 10}px ${c}`;
        el.title = (st.current * 1000).toFixed(1) + ' mA';
      } else if (st && st.reversed) {
        el.style.background = '#ff5c5c';
        el.style.boxShadow = 'none';
        el.title = 'reversed — no current';
      } else {
        el.style.background = '#333';
        el.style.boxShadow = 'none';
        el.title = '';
      }
    }
  }

  function draggable(el, onMove) {
    const head = el.querySelector('.whead');
    head.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.classList.contains('wx') || e.target.classList.contains('winfobtn')) return;
      const z = model.view.z;
      const sx = e.clientX, sy = e.clientY;
      const startL = el.offsetLeft, startT = el.offsetTop;
      let moved = false;
      const move = (ev) => {
        moved = true;
        el.style.left = (ev.altKey ? Math.round(startL + (ev.clientX - sx) / z) : snapW(startL + (ev.clientX - sx) / z)) + 'px';
        el.style.top = (ev.altKey ? Math.round(startT + (ev.clientY - sy) / z) : snapW(startT + (ev.clientY - sy) / z)) + 'px';
        scheduleWires();
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        if (moved) {
          hist.push(snapshot());          // pre-move state — one undo step per drag
          onMove(el.offsetLeft, el.offsetTop);
          save();
        }
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  function portCenter(key) {
    const el = nodesEl.querySelector(`[data-key="${key}"] .dot`);
    if (!el) return null;
    const r = el.getBoundingClientRect(), c = svg.getBoundingClientRect();
    return { x: r.left + r.width / 2 - c.left, y: r.top + r.height / 2 - c.top };
  }

  let wireRaf = 0;
  function scheduleWires() {
    if (wireRaf) return;
    wireRaf = requestAnimationFrame(() => { wireRaf = 0; drawWires(); });
  }

  function drawWires() {
    if (!svg) return;
    svg.innerHTML = '';
    model.wires.forEach((w, i) => {
      const a = portCenter(w.from), b = portCenter(w.to);
      if (!a || !b) return;
      const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
      const sim = simOn && simResult ? simResult.wireCurrents[i] : null;
      const mA = sim ? sim.current * 1000 : 0;
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', w.color || defaultColor(w.from, w.to));
      path.setAttribute('stroke-width', i === selWire ? 4 : (mA > 1 ? Math.min(5, 2 + mA / 40) : 2.2));
      path.setAttribute('stroke-linecap', 'round');
      path.style.cursor = 'pointer';
      if (i === selWire) path.setAttribute('stroke-dasharray', '6 4');
      else if (mA > 0.5) {
        path.setAttribute('stroke-dasharray', '7 5');
        path.classList.add(sim.dir >= 0 ? 'flow-f' : 'flow-r');
      }
      const title = document.createElementNS(NS, 'title');
      title.textContent = sim ? `${mA.toFixed(1)} mA · ${sim.volts.toFixed(2)} V` : 'wire';
      path.appendChild(title);
      path.addEventListener('click', (e) => {
        e.stopPropagation();
        selWire = i;
        root.querySelector('#wiringColors').classList.remove('hidden');
        drawWires();
      });
      path.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        selWire = -1;
        root.querySelector('#wiringColors').classList.add('hidden');
        mutate(() => { model.wires.splice(i, 1); });
        ctx.toast('Wire removed — Ctrl+Z restores it', 1600);
      });
      svg.appendChild(path);
    });
    // ghost preview while wiring
    if (ghost) {
      const a = portCenter(ghost.fromKey);
      if (a) {
        const path = document.createElementNS(NS, 'path');
        const dx = Math.max(30, Math.abs(ghost.x - a.x) / 2);
        path.setAttribute('d', `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${ghost.x - dx} ${ghost.y}, ${ghost.x} ${ghost.y}`);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', '#ff6500');
        path.setAttribute('stroke-width', 2);
        path.setAttribute('stroke-dasharray', '4 4');
        path.setAttribute('opacity', '0.75');
        path.style.pointerEvents = 'none';
        svg.appendChild(path);
      }
    }
  }

  async function exportHeader() {
    const dir = ctx.getProjectDir();
    if (!dir) return ctx.toast('Open a project first');
    const def = ctx.getBoardDef();
    const text = U.buildPinsHeader(model, def);
    if (!/#define/.test(text)) return ctx.toast('Wire a part to a board pin first: nothing to export yet', 2600);
    const path = dir + sep(dir) + 'pins.h';
    if (await ctx.api.file.exists(path)) {
      const cur = await ctx.api.file.read(path).catch(() => '');
      if (cur && !/ElectriCAD/.test(cur)) {
        const ok = await window.electricadConfirm('pins.h exists',
          'Your project already has a pins.h that ElectriCAD did not write. Overwrite it?',
          [{ label: 'Cancel', value: false }, { label: 'Overwrite', value: true, danger: true }]);
        if (!ok) return;
      }
    }
    await ctx.api.file.write(path, text);
    ctx.toast('pins.h written — #include "pins.h" in your sketch');
    if (ctx.onFilesChanged) ctx.onFilesChanged();
  }

  async function exportBom() {
    if (!model.parts.length) return ctx.toast('The canvas is empty');
    const ids = [...new Set(model.parts.map((p) => p.catalogId).filter(Boolean))];
    const prices = {};
    for (const id of ids) {
      try { const item = await ctx.api.catalog.get(id); if (item && item.price != null) prices[id] = item.price; } catch (e) {}
    }
    const bom = U.buildBom(model, prices);
    const dir = ctx.getProjectDir();
    const p = await ctx.api.file.saveDialog({ defaultPath: (dir ? dir + sep(dir) : '') + 'bom.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (!p) return;
    await ctx.api.file.write(p, bom.csv);
    ctx.toast(`BOM: ${bom.rows.length} line${bom.rows.length === 1 ? '' : 's'}` + (bom.total ? ` · $${bom.total.toFixed(2)} known` : ''), 3000);
    if (ctx.onFilesChanged) ctx.onFilesChanged();
  }

  // a pixel-exact PNG of what's on screen (Electron captures the region)
  async function exportImage() {
    if (!model.parts.length) return ctx.toast('The canvas is empty');
    const dir = ctx.getProjectDir();
    const p = await ctx.api.file.saveDialog({ defaultPath: (dir ? dir + sep(dir) : '') + 'circuit.png',
      filters: [{ name: 'PNG image', extensions: ['png'] }] });
    if (!p) return;
    const r = canvasEl.getBoundingClientRect();
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    await ctx.api.app.capture({ x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }, p);
    ctx.toast('Saved ' + p.split(/[\\/]/).pop(), 2200);
    if (ctx.onFilesChanged) ctx.onFilesChanged();
  }

  return {
    exportImage,
    async init(host, context) { ctx = context; build(host); await load(); render(); },
    async onProjectChange() { if (root) { await load(); setSim(false); render(); } },
    refreshLive() {
      // telemetry sync while simulating: real pin states drive the circuit
      if (root && root.offsetParent && simOn) runSim();
    },
    isActive() { return !!(root && root.offsetParent); },
    placeCatalogItem,
    placeLibPart,
    swapLibPart,
    swapInfo,
    showPartInfo
  };
})();
