// PCB layout editor: the board view. Parts and nets come from the wiring
// canvas (wiring.json); placement, copper and the outline live in pcb.json
// next to it. Geometry, DRC and the fab outputs are in pcb.js.
window.ElectriCADPcbView = (function () {
  'use strict';
  const PCB = window.ElectriCADPcb;
  const PARTS = window.PinodeParts.PARTS;

  let ctx = null, host = null, cv = null, g = null, side = null, statusEl = null;
  let net = { comps: [], nets: [] };
  let L = null;                        // layout (pcb.json)
  let view = { x: 20, y: 20, z: 8 };   // screen px of world origin, px per mm
  let tool = 'select', layer = 'F', width = 0.4;
  let sel = null;                      // { kind: 'comp'|'trace'|'via'|'hole'|'text'|'pour', ref|i }
  let A = null;                        // PCB.analyze(): copper, zone fills, connectivity
  let pourDraft = null;                // [[x, y], …] while drawing a pour outline
  let drag = null, route = null, mouse = { x: 0, y: 0, wx: 0, wy: 0 };
  let issues = [], rats = [];
  let saveT = null;
  const WIDTHS = [0.25, 0.3, 0.4, 0.5, 0.8, 1.0, 1.5, 2.0];

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sep = (d) => (d.includes('\\') ? '\\' : '/');
  const fileFor = (dir) => dir + sep(dir) + 'pcb.json';
  const wiringFile = (dir) => dir + sep(dir) + 'wiring.json';
  const css = (name, fb) => (getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb);

  // ---- persistence -------------------------------------------------------------
  const DEFAULTS = { holeD: 3.2, viaDrill: 0.4, viaDia: 0.8, traceW: 0.4 };
  function emptyLayout() { return { version: 1, board: { w: 50, h: 40 }, place: {}, traces: [], vias: [], holes: [], texts: [], pours: [], stack: { count: 2, planes: {} }, rules: {}, defaults: { ...DEFAULTS }, maker: 'jlcpcb' }; }

  // ---- layers: stack, visibility, colours ------------------------------------------
  const LAYER_COL = { F: '#dc463c', In1: '#e3a33a', In2: '#b45cd6', In3: '#3fbf9f', In4: '#9cc23f', B: '#4682eb',
    silkF: '#f0f0f0', silkB: '#b4c8ff', mask: '#2fbf6a', paste: '#b8b8b8', edge: '#e8d44d', drill: '#c9c9c9' };
  const OTHER_LAYERS = [['silkF', 'Top silkscreen'], ['silkB', 'Bottom silkscreen'], ['mask', 'Solder mask openings'], ['paste', 'Paste (SMD)'], ['edge', 'Board outline'], ['drill', 'Holes and vias']];
  const CLs = () => PCB.copperLayers(L);
  const viewPrefs = () => (L.view = L.view || { hide: { mask: true, paste: true }, col: {} });
  const vis = (id) => !(viewPrefs().hide || {})[id];
  const colOf = (id) => (viewPrefs().col || {})[id] || LAYER_COL[id] || '#888888';
  const rgba = (hex, a) => { const n = parseInt(String(hex).slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };
  function setView(fn) { const v = viewPrefs(); v.hide = v.hide || {}; v.col = v.col || {}; fn(v); save(); renderLayers(); draw(); }
  const netNames = () => net.nets.map((n) => n.name).sort((a, b) => (a === 'GND' ? -1 : b === 'GND' ? 1 : a.localeCompare(b)));
  const powerNet = () => netNames().find((n) => /^\+?(5V|3V3|3\.3V|VCC|VIN|VBUS|12V)$/i.test(n)) || '';
  // change the number of copper layers; copper on layers that go away is removed (undo brings it back)
  function setStack(n) {
    const before = CLs();
    let gone = 0;
    mutate(() => {
      const st = L.stack = { count: n, planes: { ...((L.stack && L.stack.planes) || {}) } };
      const CL = PCB.copperLayers(L);
      if (n >= 4 && !before.includes('In1')) {
        // a ground plane right under the top layer and power deeper in is the usual choice
        st.planes.In1 = netNames().includes('GND') ? 'GND' : '';
        st.planes[n === 4 ? 'In2' : 'In4'] = powerNet();
      }
      for (const k of Object.keys(st.planes)) if (!CL.includes(k)) delete st.planes[k];
      const keepT = L.traces.filter((t) => CL.includes(t.layer)), keepP = (L.pours || []).filter((p) => CL.includes(p.layer));
      gone = L.traces.length - keepT.length + (L.pours || []).length - keepP.length + (n === 1 ? L.vias.length : 0);
      L.traces = keepT; L.pours = keepP; if (n === 1) L.vias = [];
    });
    if (!CLs().includes(layer)) setLayer(CLs()[0]);
    ctx.toast(`${n}-layer board` + (gone ? `: ${gone} trace${gone === 1 ? '' : 's'}, pours or vias on removed layers were taken off. Ctrl+Z brings them back.` : ''), gone ? 3600 : 1600);
  }
  function addPour(pts, ly, netName) {
    mutate(() => {
      L.pours = L.pours || [];
      L.pours.push({ layer: ly, net: netName, pts, clearance: 0.3, thermal: true });
      sel = { kind: 'pour', i: L.pours.length - 1 };
    });
  }
  function pourWholeLayer() {
    const ly = layer, nn = netNames().includes('GND') ? 'GND' : '';
    if (PCB.planeNet(L, ly)) return ctx.toast(PCB.layerLabel(ly) + ' is already a ' + PCB.planeNet(L, ly) + ' plane', 2000);
    const B = L.board;
    addPour([[0, 0], [B.w, 0], [B.w, B.h], [0, B.h]], ly, nn);
    ctx.toast(`${nn || 'Copper'} pour over all of ${PCB.layerLabel(ly)}${nn ? '' : ': pick its net in the panel'}`, 2200);
  }
  const D = () => ({ ...DEFAULTS, ...(L.defaults || {}) });
  const rulesNow = () => ({ ...PCB.RULES, ...(L.rules || {}) });
  async function load() {
    const dir = ctx.getProjectDir();
    L = emptyLayout();
    if (!dir) { net = { comps: [], nets: [] }; return; }
    try { const j = JSON.parse(await ctx.api.file.read(fileFor(dir))); if (j && j.place) L = { ...emptyLayout(), ...j }; } catch (e) {}
    pourDraft = null;
    if (root && !CLs().includes(layer)) setLayer(CLs()[0]);
    width = D().traceW;
    if (root) { const ws = root.querySelector('#pcbWidth'); if (ws) ws.value = String(width); }
    sel = null;
    await syncNetlist(false);
  }
  function save() {
    clearTimeout(saveT);
    saveT = setTimeout(async () => {
      const dir = ctx.getProjectDir();
      if (dir && L) { try { await ctx.api.file.write(fileFor(dir), JSON.stringify(L, null, 1)); } catch (e) {} }
    }, 300);
  }
  const hist = window.PinodeHistory.makeHistory(100);
  function mutate(fn) { hist.push(JSON.parse(JSON.stringify(L))); fn(); save(); refresh(); }
  function undo(redo) {
    if (route) { route = null; draw(); return; }        // first undo just drops a trace being drawn
    const s = redo ? hist.redo(JSON.parse(JSON.stringify(L))) : hist.undo(JSON.parse(JSON.stringify(L)));
    if (!s) return ctx.toast(redo ? 'Nothing to redo' : 'Nothing to undo', 1200);
    L = s; sel = validSel(sel); save(); refresh();
  }
  function validSel(x) {
    if (!x) return null;
    if (x.kind === 'comp') return L.place[x.ref] ? x : null;
    const arr = { trace: L.traces, via: L.vias, hole: L.holes, text: L.texts, pour: L.pours || [] }[x.kind];
    return arr && arr[x.i] ? x : null;
  }
  function deleteSel() {
    if (!sel) return ctx.toast('Click something on the board first, then Delete', 1600);
    if (sel.kind === 'comp') return ctx.toast(sel.ref + ' comes from the wiring canvas: delete it there and it leaves the board too', 3000);
    const s = sel; sel = null;
    mutate(() => { const arr = { trace: L.traces, via: L.vias, hole: L.holes, text: L.texts, pour: L.pours }[s.kind]; arr.splice(s.i, 1); });
  }
  async function clearBoard() {
    const np = (L.pours || []).length;
    const n = L.traces.length + L.vias.length + L.holes.length + L.texts.length + np;
    if (!n) return ctx.toast('Nothing to clear: no traces, vias, pours, holes or text on the board', 2000);
    const ok = await window.electricadConfirm('Clear board',
      `Remove all ${L.traces.length} traces, ${L.vias.length} vias, ${np} pours, ${L.holes.length} holes and ${L.texts.length} texts? Parts and the layer setup stay. Undo brings it all back.`,
      [{ label: 'Cancel', value: false }, { label: 'Clear', value: true, danger: true }]);
    if (!ok) return;
    sel = null;
    mutate(() => { L.traces = []; L.vias = []; L.holes = []; L.texts = []; L.pours = []; });
    ctx.toast('Board cleared. Ctrl+Z undoes it.', 2000);
  }
  async function resetBoard() {
    const ok = await window.electricadConfirm('Reset board',
      'Start this board again: parts are laid out fresh, the board is sized to fit with M3 corner holes, and sizes and rules go back to their defaults. Traces, vias, pours and text are removed; the layer count stays. Undo brings it back.',
      [{ label: 'Cancel', value: false }, { label: 'Reset', value: true, danger: true }]);
    if (!ok) return;
    sel = null;
    mutate(() => {
      const keep = { maker: L.maker, stack: L.stack, view: L.view };
      Object.assign(L, emptyLayout(), keep);
      L.place = PCB.autoPlace(net, {}, { margin: HOLE_MARGIN });
      if (net.comps.length) { L.board = PCB.fitBoard(net, L.place, HOLE_MARGIN); addCornerHoles(false); }
    });
    width = D().traceW; root.querySelector('#pcbWidth').value = String(width);
    fit();
    ctx.toast('Board reset. Ctrl+Z undoes it.', 2000);
  }

  // the canvas is the schematic: rebuild the netlist from wiring.json, place
  // any new parts, forget parts that were removed
  async function syncNetlist(announce) {
    const dir = ctx.getProjectDir();
    let model = { parts: [], wires: [] };
    try { model = JSON.parse(await ctx.api.file.read(wiringFile(dir))); } catch (e) {}
    // footprints picked here for catalogue parts (by canvas part uid)
    for (const p of model.parts || []) {
      const o = L.fpOver && L.fpOver[p.uid];
      if (o && p.lib) { p.lib.fp = o.fp; p.lib.fpData = o.fpData; if (!p.lib.pads && o.pads) p.lib.pads = o.pads; }
    }
    net = PCB.netlist(model, ctx.getBoardDef(), ctx.getBoardId(), PARTS);
    const refs = new Set(net.comps.map((c) => c.ref));
    const before = Object.keys(L.place).length;
    for (const r of Object.keys(L.place)) if (!refs.has(r)) delete L.place[r];
    const fresh = !Object.keys(L.place).length;
    // a fresh board gets M3 corner holes, so parts start clear of them
    L.place = PCB.autoPlace(net, L.place, fresh ? { margin: HOLE_MARGIN } : null);
    if (fresh && net.comps.length) { L.board = PCB.fitBoard(net, L.place, HOLE_MARGIN); addCornerHoles(false); }
    // traces keep their net names; re-derive them from the pads they touch
    save();
    if (announce) {
      const added = Object.keys(L.place).length - before;
      ctx.toast(net.comps.length ? `${net.comps.length} parts, ${net.nets.length} nets from the wiring canvas` + (added > 0 ? ` (${added} new)` : '') :
        'The wiring canvas is empty. Place parts and wire them there first (🔌).', 3200);
    }
    refresh();
  }
  // corner hole centre 3.5 mm in + M3 screw head (≈3 mm radius) + a little air
  const HOLE_MARGIN = 7.62;
  function addCornerHoles(asMutation) {
    const B = L.board, m = 3.5;
    const set = () => { L.holes = [[m, m], [B.w - m, m], [m, B.h - m], [B.w - m, B.h - m]].map(([x, y]) => ({ x, y, d: D().holeD })); };
    if (asMutation) mutate(set); else set();
  }

  // ---- coordinates ------------------------------------------------------------
  const toScreen = (x, y) => [view.x + x * view.z, view.y + y * view.z];
  const toWorld = (sx, sy) => [(sx - view.x) / view.z, (sy - view.y) / view.z];
  function fit() {
    const r = cv.getBoundingClientRect();
    const B = L.board;
    const z = Math.min((r.width - 40) / Math.max(10, B.w), (r.height - 40) / Math.max(10, B.h));
    view.z = Math.max(1, Math.min(60, z));
    view.x = (r.width - B.w * view.z) / 2; view.y = (r.height - B.h * view.z) / 2;
    draw();
  }

  // ---- hit testing --------------------------------------------------------------
  function padsAll() {
    const out = [];
    for (const c of net.comps) { const pl = L.place[c.ref]; if (pl) for (const p of PCB.padsWorld(c, pl)) out.push({ ...p, comp: c }); }
    return out;
  }
  function netOfPad(ref, num) { const n = net.nets.find((nn) => nn.nodes.some((q) => q.ref === ref && q.pad === num)); return n ? n.name : ''; }
  function padAt(wx, wy) {
    let best = null;
    for (const p of padsAll()) {
      const d = Math.max(Math.abs(wx - p.x) - p.w / 2, Math.abs(wy - p.y) - p.h / 2);
      if (d <= 0.2 && (!best || d < best.d)) best = { d, p };
    }
    return best ? best.p : null;
  }
  function hit(wx, wy) {
    const tol = 6 / view.z;
    for (let i = (L.vias || []).length - 1; i >= 0; i--) { const v = L.vias[i]; if (Math.hypot(wx - v.x, wy - v.y) <= v.dia / 2 + tol) return { kind: 'via', i }; }
    for (let i = (L.holes || []).length - 1; i >= 0; i--) { const h = L.holes[i]; if (Math.hypot(wx - h.x, wy - h.y) <= h.d / 2 + tol) return { kind: 'hole', i }; }
    for (let i = (L.texts || []).length - 1; i >= 0; i--) { const t = L.texts[i]; if (Math.abs(wx - t.x) < String(t.text).length * (t.h || 1.5) * 0.5 && Math.abs(wy - t.y) < (t.h || 1.5)) return { kind: 'text', i }; }
    // traces on the active layer first
    const order = [layer].concat(CLs().filter((l) => l !== layer)).filter(vis);
    for (const ly of order) for (let i = L.traces.length - 1; i >= 0; i--) {
      const t = L.traces[i];
      if (t.layer !== ly) continue;
      for (let k = 0; k + 1 < t.pts.length; k++) if (PCB.ptSeg(wx, wy, t.pts[k][0], t.pts[k][1], t.pts[k + 1][0], t.pts[k + 1][1]) <= t.w / 2 + tol) return { kind: 'trace', i };
    }
    for (const c of net.comps.slice().reverse()) {
      const pl = L.place[c.ref]; if (!pl) continue;
      const b = PCB.bboxOf(c, pl);
      if (wx >= b.x1 && wx <= b.x2 && wy >= b.y1 && wy <= b.y2) return { kind: 'comp', ref: c.ref };
    }
    // pours: on the outline of any visible one, or inside one on the active layer
    const pours = L.pours || [];
    for (let i = pours.length - 1; i >= 0; i--) {
      const p = pours[i]; if (!vis(p.layer)) continue;
      for (let k = 0; k < p.pts.length; k++) { const a = p.pts[k], b = p.pts[(k + 1) % p.pts.length]; if (PCB.ptSeg(wx, wy, a[0], a[1], b[0], b[1]) <= tol) return { kind: 'pour', i }; }
    }
    for (let i = pours.length - 1; i >= 0; i--) if (pours[i].layer === layer && PCB.pointInPoly(wx, wy, pours[i].pts)) return { kind: 'pour', i };
    return null;
  }

  // ---- drawing --------------------------------------------------------------------
  function refresh() {
    A = PCB.analyze(L, net, L.rules);
    rats = PCB.ratsnest(L, net);
    issues = PCB.drc(L, net, L.rules);
    renderSide();
    draw();
  }
  // ---- grid: what you see and what things snap to (a viewer preference) ----
  const GRID_STEPS = [0.1, 0.25, 0.5, 0.635, 1, 1.27, 2.54];
  let grid = { on: true, step: PCB.GRID, snap: true };
  try { grid = { ...grid, ...JSON.parse(localStorage.getItem('ec_pcb_grid') || '{}') }; } catch (e) { /* defaults */ }
  function setGrid(patch, say) {
    grid = { ...grid, ...patch };
    try { localStorage.setItem('ec_pcb_grid', JSON.stringify(grid)); } catch (e) { /* ok */ }
    syncGridUi(); draw();
    if (say) ctx.toast(say, 1200);
  }
  function syncGridUi() {
    if (!root) return;
    const b = root.querySelector('#pcbGrid'), sb = root.querySelector('#pcbSnap'), st = root.querySelector('#pcbGridStep');
    if (b) b.classList.toggle('on', grid.on);
    if (sb) sb.classList.toggle('on', grid.snap);
    if (st) st.value = String(grid.step);
  }
  // snap to the grid; with snap off, to 0.01 mm so numbers stay readable
  const sn = (v) => (grid.snap ? Math.round(Math.round(v / grid.step) * grid.step * 1e4) / 1e4 : Math.round(v * 100) / 100);
  function drawGrid(r, S) {
    const z = view.z;
    // the grid you chose, thinned out (×2, ×5, ×10…) until dots are at least 8 px apart
    let s = grid.step;
    for (const k of [1, 2, 4, 5, 10, 20, 40, 50, 100, 200]) { s = grid.step * k; if (s * z >= 8) break; }
    if (s * z < 8) return;
    const major = s * 5;
    const [x0, y0] = toWorld(0, 0), [x1, y1] = toWorld(r.width, r.height);
    g.fillStyle = 'rgba(255,255,255,0.28)';
    for (let x = Math.floor(x0 / s) * s; x < x1; x += s) for (let y = Math.floor(y0 / s) * s; y < y1; y += s) { const [sx, sy] = S(x, y); g.fillRect(sx - 0.75, sy - 0.75, 1.5, 1.5); }
    g.strokeStyle = 'rgba(255,255,255,0.09)'; g.lineWidth = 1; g.beginPath();
    for (let x = Math.floor(x0 / major) * major; x < x1; x += major) { const sx = Math.round(S(x, 0)[0]) + 0.5; g.moveTo(sx, 0); g.lineTo(sx, r.height); }
    for (let y = Math.floor(y0 / major) * major; y < y1; y += major) { const sy = Math.round(S(0, y)[1]) + 0.5; g.moveTo(0, sy); g.lineTo(r.width, sy); }
    g.stroke();
  }
  function draw() {
    if (!cv || !L) return;
    const dpr = window.devicePixelRatio || 1;
    const r = cv.getBoundingClientRect();
    if (cv.width !== Math.round(r.width * dpr) || cv.height !== Math.round(r.height * dpr)) { cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = css('--pcb-bg', '#101418'); g.fillRect(0, 0, r.width, r.height);
    const z = view.z;
    const S = (x, y) => toScreen(x, y);
    // board
    const [bx, by] = S(0, 0);
    g.fillStyle = '#0b3d22'; g.fillRect(bx, by, L.board.w * z, L.board.h * z);
    if (grid.on) drawGrid(r, S);
    if (vis('edge')) { g.strokeStyle = colOf('edge'); g.lineWidth = 1.5; g.strokeRect(bx, by, L.board.w * z, L.board.h * z); }
    const seg = (x1, y1, x2, y2, w, style) => { const a = S(x1, y1), b = S(x2, y2); g.strokeStyle = style; g.lineWidth = Math.max(1, w * z); g.lineCap = 'round'; g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke(); };
    // copper, the far layers first and the active layer on top
    const CL = CLs();
    const layersOrder = CL.filter((l) => l !== layer).reverse().concat(CL.includes(layer) ? [layer] : []);
    const anyCopper = CL.some(vis);
    for (const ly of layersOrder) {
      if (!vis(ly)) continue;
      const act = ly === layer;
      for (const zn of (A && A.zones) || []) if (zn.layer === ly && zn.fill) {
        g.globalAlpha = act ? 0.5 : 0.25; g.imageSmoothingEnabled = false;
        g.drawImage(zoneImage(zn, colOf(ly)), bx, by, zn.fill.nx * zn.fill.res * z, zn.fill.ny * zn.fill.res * z);
        g.globalAlpha = 1;
      }
      L.traces.forEach((t, i) => {
        if (t.layer !== ly) return;
        const selected = sel && sel.kind === 'trace' && sel.i === i;
        for (let k = 0; k + 1 < t.pts.length; k++) seg(t.pts[k][0], t.pts[k][1], t.pts[k + 1][0], t.pts[k + 1][1], t.w, selected ? '#ffffff' : rgba(colOf(ly), act ? 0.95 : 0.45));
      });
      (L.pours || []).forEach((p, i) => {
        if (p.layer !== ly) return;
        const selected = sel && sel.kind === 'pour' && sel.i === i;
        g.strokeStyle = selected ? '#ffffff' : rgba(colOf(ly), act ? 0.9 : 0.5); g.lineWidth = selected ? 2 : 1; g.setLineDash([6, 4]);
        g.beginPath(); p.pts.forEach(([x, y], k) => { const [a, b] = S(x, y); k ? g.lineTo(a, b) : g.moveTo(a, b); }); g.closePath(); g.stroke(); g.setLineDash([]);
      });
    }
    // pads: through-hole on every layer, surface-mount on their side
    for (const p of padsAll()) {
      if (p.drill ? !anyCopper : !vis(p.layers[0])) continue;
      const [sx, sy] = S(p.x, p.y);
      const w = p.w * z, h = p.h * z;
      g.fillStyle = p.drill ? '#d7b34a' : rgba(colOf(p.layers[0]), 0.9);
      g.beginPath();
      if (p.shape === 'rect') g.rect(sx - w / 2, sy - h / 2, w, h);
      else if (p.shape === 'oval' && w !== h) { const rr = Math.min(w, h) / 2; g.roundRect ? g.roundRect(sx - w / 2, sy - h / 2, w, h, rr) : g.rect(sx - w / 2, sy - h / 2, w, h); }
      else g.arc(sx, sy, w / 2, 0, Math.PI * 2);
      g.fill();
      if (p.drill && vis('drill')) { g.fillStyle = '#101418'; g.beginPath(); g.arc(sx, sy, p.drill * z / 2, 0, Math.PI * 2); g.fill(); }
      if (vis('paste') && !p.drill) { g.fillStyle = rgba(colOf('paste'), 0.75); g.fillRect(sx - w / 2 + 1, sy - h / 2 + 1, Math.max(1, w - 2), Math.max(1, h - 2)); }
      if (vis('mask')) { const m = 0.05 * z * 2; g.strokeStyle = colOf('mask'); g.lineWidth = 1; g.strokeRect(sx - (w + m) / 2, sy - (h + m) / 2, w + m, h + m); }
      if (z > 10) {
        g.fillStyle = 'rgba(0,0,0,0.75)'; g.font = Math.max(8, Math.min(12, z * 0.7)) + 'px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        const nn = netOfPad(p.comp.ref, p.num);
        if (nn && z > 14) g.fillText(nn.length > 6 ? nn.slice(0, 6) : nn, sx, sy);
      }
    }
    // vias, holes
    (L.vias || []).forEach((v, i) => {
      if (!anyCopper) return;
      const [sx, sy] = S(v.x, v.y);
      g.fillStyle = sel && sel.kind === 'via' && sel.i === i ? '#ffffff' : '#c9c9c9';
      g.beginPath(); g.arc(sx, sy, v.dia * z / 2, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#101418'; g.beginPath(); g.arc(sx, sy, v.drill * z / 2, 0, Math.PI * 2); g.fill();
    });
    (L.holes || []).forEach((h, i) => {
      if (!vis('drill')) return;
      const [sx, sy] = S(h.x, h.y);
      g.fillStyle = '#05070a'; g.beginPath(); g.arc(sx, sy, h.d * z / 2, 0, Math.PI * 2); g.fill();
      g.strokeStyle = sel && sel.kind === 'hole' && sel.i === i ? '#ffffff' : '#7d8790'; g.lineWidth = 1; g.stroke();
    });
    // silkscreen + references
    g.lineCap = 'round';
    for (const c of net.comps) {
      const pl = L.place[c.ref]; if (!pl) continue;
      const f = PCB.footprint(c.fp);
      const sk = (pl.side || 'F') === 'F' ? 'silkF' : 'silkB';
      const silkOn = vis(sk);
      const silkCol = silkOn ? rgba(colOf(sk), sk === 'silkF' ? 0.9 : 0.55) : 'rgba(0,0,0,0)';
      if (silkOn) for (const s of f.silk || []) {
        if (s.l) { const [a, b] = PCB.xform(pl, s.l[0], s.l[1]); const [c2, d] = PCB.xform(pl, s.l[2], s.l[3]); seg(a, b, c2, d, 0.15, silkCol); }
        if (s.c) { const [x, y] = PCB.xform(pl, s.c[0], s.c[1]); const [sx, sy] = S(x, y); g.strokeStyle = silkCol; g.lineWidth = Math.max(1, 0.15 * z); g.beginPath(); g.arc(sx, sy, s.c[2] * z, 0, Math.PI * 2); g.stroke(); }
      }
      const bb = PCB.bboxOf(c, pl);
      const ty = bb.y1 - 1.2 < 0.6 ? bb.y2 + 1.2 : bb.y1 - 1.2;
      if (silkOn) for (const sg of PCB.textStrokes(c.ref, (bb.x1 + bb.x2) / 2, ty, 1.0, pl.side === 'B')) seg(sg[0], sg[1], sg[2], sg[3], 0.15, silkCol);
      if (sel && sel.kind === 'comp' && sel.ref === c.ref) {
        const [x1, y1] = S(bb.x1, bb.y1), [x2, y2] = S(bb.x2, bb.y2);
        g.strokeStyle = '#4aa3ff'; g.lineWidth = 1.5; g.setLineDash([4, 3]); g.strokeRect(x1 - 3, y1 - 3, x2 - x1 + 6, y2 - y1 + 6); g.setLineDash([]);
      }
      if (c.check && z > 5) { const [sx, sy] = S(bb.x2, bb.y1); g.fillStyle = '#ffb347'; g.font = '11px sans-serif'; g.textAlign = 'left'; g.fillText('check', sx + 2, sy + 8); }
    }
    (L.texts || []).forEach((t, i) => {
      const sk = t.layer === 'B' ? 'silkB' : 'silkF';
      if (!vis(sk)) return;
      const col = sel && sel.kind === 'text' && sel.i === i ? '#4aa3ff' : rgba(colOf(sk), sk === 'silkB' ? 0.55 : 0.9);
      for (const sg of PCB.textStrokes(t.text, t.x, t.y, t.h || 1.5, t.layer === 'B')) seg(sg[0], sg[1], sg[2], sg[3], 0.2, col);
    });
    // ratsnest
    g.setLineDash([]);
    for (const rl of rats) seg(rl.x1, rl.y1, rl.x2, rl.y2, 0, 'rgba(255,240,150,0.75)');
    // route in progress
    if (route) {
      const pts = route.pts.concat([route.next || [mouse.wx, mouse.wy]]);
      for (let k = 0; k + 1 < pts.length; k++) seg(pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1], route.w, rgba(colOf(route.layer), 0.7));
      const [sx, sy] = S(pts[pts.length - 1][0], pts[pts.length - 1][1]);
      g.strokeStyle = '#fff'; g.lineWidth = 1; g.beginPath(); g.arc(sx, sy, route.w * z / 2 + 2, 0, Math.PI * 2); g.stroke();
    }
    // pour outline being drawn
    if (pourDraft) {
      const pts = pourDraft.concat([[mouse.wx, mouse.wy]]);
      g.strokeStyle = rgba(colOf(layer), 0.95); g.lineWidth = 1.5; g.setLineDash([6, 4]);
      g.beginPath(); pts.forEach(([x, y], k) => { const [a, b] = S(x, y); k ? g.lineTo(a, b) : g.moveTo(a, b); }); g.stroke(); g.setLineDash([]);
      const [fx, fy] = S(pourDraft[0][0], pourDraft[0][1]);
      g.strokeStyle = '#fff'; g.beginPath(); g.arc(fx, fy, 6, 0, Math.PI * 2); g.stroke();
    }
    // DRC markers
    for (const is of issues) {
      if (is.severity !== 'error' || is.x == null) continue;
      const [sx, sy] = S(is.x, is.y);
      g.strokeStyle = '#ff4d4d'; g.lineWidth = 2; g.beginPath(); g.arc(sx, sy, 7, 0, Math.PI * 2); g.stroke();
    }
    // size label
    g.fillStyle = '#e8d44d'; g.font = '12px sans-serif'; g.textAlign = 'left'; g.textBaseline = 'bottom';
    g.fillText(`${L.board.w} × ${L.board.h} mm`, bx, by - 4);
    const [cx, cy] = [mouse.wx, mouse.wy];
    statusEl.textContent = `${cx.toFixed(2)}, ${cy.toFixed(2)} mm · ${PCB.layerLabel(layer)} (${CL.length} layers) · ${width} mm` +
      (route ? ` · routing ${route.net || '(no net)'}: click to bend, click a pad to finish, V = via, L or 1–6 = via to another layer, Esc = stop` :
       pourDraft ? ' · click to add corners, click the first corner (or double-click, Enter) to finish, Esc = cancel' :
       tool === 'pour' ? ' · click the corners of a copper pour on ' + PCB.layerLabel(layer) :
       tool === 'route' ? ' · click a pad to start a trace' : tool === 'via' ? ' · click to place a via' : tool === 'hole' ? ' · click to place an M3 hole' : tool === 'text' ? ' · click to place text' :
       ' · drag parts · R rotate · F flip · Del delete · Ctrl+Z undo');
  }

  // a zone's fill as an image, one pixel per fill cell, cached per fill and colour
  const zoneImgs = new WeakMap();
  function zoneImage(zn, col) {
    const c0 = zoneImgs.get(zn.fill);
    if (c0 && c0.col === col) return c0.cv;
    const F = zn.fill, cvz = document.createElement('canvas');
    cvz.width = F.nx; cvz.height = F.ny;
    const gz = cvz.getContext('2d'), img = gz.createImageData(F.nx, F.ny);
    const n = parseInt(col.slice(1), 16), r = (n >> 16) & 255, gg = (n >> 8) & 255, b = n & 255;
    for (let i = 0; i < F.grid.length; i++) if (F.grid[i]) { img.data[i * 4] = r; img.data[i * 4 + 1] = gg; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255; }
    gz.putImageData(img, 0, 0);
    zoneImgs.set(zn.fill, { col, cv: cvz });
    return cvz;
  }

  // ---- layers panel ------------------------------------------------------------------
  function renderLayers() {
    const el = side && side.querySelector('.pcb-layers');
    if (!el) return;
    const CL = CLs(), n = CL.length, nets = netNames();
    const row = (id, name, extra, copper) => `<div class="pcb-lr${copper && id === layer ? ' on' : ''}" data-l="${id}" ${copper ? '' : 'data-other="1"'}>
      ${copper ? `<input type="radio" name="pcbAct" data-act="${id}" ${id === layer ? 'checked' : ''} title="Route on this layer">` : '<span class="pcb-lr-sp"></span>'}
      <input type="checkbox" data-vis="${id}" ${vis(id) ? 'checked' : ''} title="Show or hide">
      <input type="color" data-col="${id}" value="${colOf(id)}" title="Colour">
      <span class="pcb-lr-n">${esc(name)}</span>${extra || ''}</div>`;
    const planeSel = (id) => `<select class="input slim pcb-lr-t" data-plane="${id}" title="Signal layer for traces, or a solid plane of one net">
      <option value="">Signal</option>${nets.map((nn) => `<option value="${esc(nn)}" ${PCB.planeNet(L, id) === nn ? 'selected' : ''}>${esc(nn)} plane</option>`).join('')}</select>`;
    el.innerHTML = `<div class="pcb-ph">Layers</div>
      <label class="pcb-f"><span>Copper layers</span><select class="input slim" data-stack="1">${PCB.STACKS.map((k) => `<option value="${k}" ${k === n ? 'selected' : ''}>${k} layer${k === 1 ? '' : 's'}</option>`).join('')}</select></label>
      ${CL.map((id) => row(id, PCB.layerLabel(id), id.startsWith('In') ? planeSel(id) : '', true)).join('')}
      <div class="pcb-btns"><button class="mini" data-a="pourAll" title="Fill the whole active layer with GND copper, kept clear of other nets">▰ Pour on ${esc(PCB.layerLabel(layer))}</button></div>
      ${OTHER_LAYERS.map(([id, nm]) => row(id, nm, '', false)).join('')}
      <div class="pcb-hint">${n === 1 ? 'Single-sided: parts on top, copper underneath. Holes are not plated.' : n === 2 ? 'Click a row to route on it. L switches layers.' : 'Click a row to route on it; L or 1–' + n + ' switch layers. Planes connect their net\'s pads by thermal spokes.'}</div>`;
    el.querySelector('[data-stack]').addEventListener('change', (e) => setStack(Number(e.target.value)));
    el.querySelectorAll('[data-act]').forEach((r) => r.addEventListener('change', () => setLayer(r.dataset.act)));
    el.querySelectorAll('.pcb-lr:not([data-other])').forEach((r) => r.addEventListener('click', (e) => { if (e.target.tagName === 'DIV' || e.target.tagName === 'SPAN') setLayer(r.dataset.l); }));
    el.querySelectorAll('[data-vis]').forEach((c) => c.addEventListener('change', () => setView((v) => { if (c.checked) delete v.hide[c.dataset.vis]; else v.hide[c.dataset.vis] = true; })));
    el.querySelectorAll('[data-col]').forEach((c) => c.addEventListener('input', () => setView((v) => { v.col[c.dataset.col] = c.value; })));
    el.querySelectorAll('[data-plane]').forEach((c) => c.addEventListener('change', () => mutate(() => {
      L.stack = { count: n, ...(L.stack || {}), planes: { ...((L.stack && L.stack.planes) || {}), [c.dataset.plane]: c.value } };
    })));
    el.querySelector('[data-a="pourAll"]').addEventListener('click', pourWholeLayer);
  }

  // ---- side panel: rule check, nets, makers ----------------------------------------
  function renderSide() {
    if (!side) return;
    renderProps();
    renderLayers();
    const drcEl = side.querySelector('.pcb-drc');
    const errs = issues.filter((x) => x.severity === 'error'), warns = issues.filter((x) => x.severity === 'warning'), infos = issues.filter((x) => x.severity === 'info');
    const routed = net.nets.length ? net.nets.length - new Set(rats.map((r) => r.net)).size : 0;
    drcEl.innerHTML = `
      <div class="pcb-sec"><b>Board</b> ${L.board.w} × ${L.board.h} mm · ${CLs().length} layer${CLs().length === 1 ? '' : 's'} · ${net.comps.length} parts · ${routed}/${net.nets.length} nets routed</div>
      <div class="pcb-sec ${errs.length ? 'bad' : 'good'}"><b>${errs.length ? errs.length + ' problem' + (errs.length === 1 ? '' : 's') : '✓ Design rules pass'}</b>${warns.length ? ` · ${warns.length} warning${warns.length === 1 ? '' : 's'}` : ''}</div>
      <div class="pcb-issues">${errs.concat(warns).map((x, i) => `<div class="pcb-issue ${x.severity}" data-i="${i}">${x.severity === 'error' ? '✖' : '⚠'} ${esc(x.message)}</div>`).join('')}</div>
      ${infos.length ? `<details class="pcb-sec"><summary>${infos.length} footprint note${infos.length === 1 ? '' : 's'}</summary>${infos.map((x) => `<div class="pcb-issue info">${esc(x.message)}</div>`).join('')}</details>` : ''}
      <div class="pcb-sec dim">Rules: ${rulesNow().clearance} mm clearance, ${rulesNow().minTrace} mm traces, ${rulesNow().minDrill} mm holes${L.rules && Object.keys(L.rules).length ? ' (custom)' : '. Every mainstream fab meets these'}.</div>`;
    const list = errs.concat(warns);
    drcEl.querySelectorAll('.pcb-issue[data-i]').forEach((el) => el.addEventListener('click', () => {
      const x = list[Number(el.dataset.i)];
      if (x && x.x != null) { const r = cv.getBoundingClientRect(); view.x = r.width / 2 - x.x * view.z; view.y = r.height / 2 - x.y * view.z; draw(); }
    }));
  }


  // ---- properties: the selected item, or the board and its defaults ------------------
  const HOLE_SIZES = [['2.2', 'M2 (2.2 mm)'], ['2.7', 'M2.5 (2.7 mm)'], ['3.2', 'M3 (3.2 mm)'], ['4.3', 'M4 (4.3 mm)'], ['5.3', 'M5 (5.3 mm)']];
  function renderProps() {
    const el = side.querySelector('.pcb-props');
    if (!el) return;
    sel = validSel(sel);
    const f = (key, label, value, o = {}) => {
      if (o.options) return `<label class="pcb-f"><span>${label}</span><select class="input slim" data-k="${key}">${o.options.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
      return `<label class="pcb-f"><span>${label}</span><input class="input slim" data-k="${key}" type="${o.text ? 'text' : 'number'}" ${o.text ? '' : `step="${o.step || 0.05}" min="${o.min != null ? o.min : 0}"`} value="${esc(value)}"${o.ro ? ' readonly' : ''}></label>`;
    };
    const r2 = (v) => +Number(v).toFixed(3);
    let html = '', apply = null;
    const D0 = D(), R = rulesNow();
    if (!sel) {
      html = `<div class="pcb-ph">Board</div>
        ${f('bw', 'Width (mm)', L.board.w, { step: 0.5, min: 5 })}${f('bh', 'Height (mm)', L.board.h, { step: 0.5, min: 5 })}
        <div class="pcb-btns"><button class="mini" data-a="fitb" title="Shrink or grow the board to the parts, with room for corner holes">Fit to parts</button><button class="mini" data-a="corners" title="Put a mounting hole 3.5 mm in from each corner">Corner holes</button></div>
        <div class="pcb-ph">New items</div>
        ${f('holeD', 'Hole size', D0.holeD, { options: HOLE_SIZES.concat(HOLE_SIZES.some(([v]) => +v === D0.holeD) ? [] : [[String(D0.holeD), D0.holeD + ' mm']]) })}
        ${f('holeDc', 'or hole (mm)', D0.holeD, { min: 0.5 })}
        ${f('viaDrill', 'Via drill (mm)', D0.viaDrill, { min: 0.2 })}${f('viaDia', 'Via pad (mm)', D0.viaDia, { min: 0.4 })}
        ${f('traceW', 'Trace width (mm)', D0.traceW, { min: 0.1 })}
        <div class="pcb-ph">Design rules</div>
        ${f('clearance', 'Clearance (mm)', R.clearance, { min: 0.1 })}${f('minTrace', 'Thinnest trace (mm)', R.minTrace, { min: 0.1 })}
        ${f('minDrill', 'Smallest hole (mm)', R.minDrill, { min: 0.1 })}${f('minAnnular', 'Ring around holes (mm)', R.minAnnular, { min: 0.05 })}
        ${f('edge', 'Copper to edge (mm)', R.edge, { min: 0 })}
        <div class="pcb-btns"><button class="mini" data-a="rules0" title="JLCPCB/PCBWay-safe values">Default rules</button></div>
        <div class="pcb-hint">Click a part, trace, via, hole or text to edit it here.</div>`;
      apply = (k, v) => {
        const n = Number(v);
        if (k === 'bw' || k === 'bh') { if (!(n >= 5 && n <= 500)) return ctx.toast('Board sides go from 5 to 500 mm', 2000); mutate(() => { L.board[k === 'bw' ? 'w' : 'h'] = r2(n); }); fit(); return; }
        if (k === 'holeD' || k === 'holeDc') { if (!(n >= 0.5 && n <= 10)) return ctx.toast('Holes go from 0.5 to 10 mm', 2000); mutate(() => { L.defaults = { ...D(), holeD: r2(n) }; }); return; }
        if (k === 'traceW') { if (!(n >= 0.1 && n <= 10)) return ctx.toast('Traces go from 0.1 to 10 mm', 2000); mutate(() => { L.defaults = { ...D(), traceW: r2(n) }; }); width = r2(n); syncWidthSelect(); return; }
        if (k === 'viaDrill' || k === 'viaDia') {
          const nd = { ...D(), [k]: r2(n) };
          if (!(nd.viaDrill >= 0.2) || !(nd.viaDia > nd.viaDrill)) return ctx.toast('The via pad has to be bigger than its drill', 2200);
          mutate(() => { L.defaults = nd; }); return;
        }
        if (['clearance', 'minTrace', 'minDrill', 'minAnnular', 'edge'].includes(k)) { if (!(n >= 0 && n <= 5)) return; mutate(() => { L.rules = { ...(L.rules || {}), [k]: r2(n) }; }); }
      };
    } else if (sel.kind === 'comp') {
      const c = net.comps.find((q) => q.ref === sel.ref), pl = L.place[sel.ref];
      const fp = PCB.footprint(c.fp);
      const tht = fp.pads.find((p) => p.drill);
      const dia0 = tht ? Math.min(tht.w, tht.h) : 0;
      html = `<div class="pcb-ph">${esc(c.ref)} · ${esc(c.value || c.name)}</div><div class="pcb-hint">${esc(fp.name || c.fp)}</div>
        ${f('x', 'X (mm)', r2(pl.x), { step: 0.635 })}${f('y', 'Y (mm)', r2(pl.y), { step: 0.635 })}
        ${f('rot', 'Rotation', pl.rot || 0, { options: [['0', '0°'], ['90', '90°'], ['180', '180°'], ['270', '270°']] })}
        ${f('side', 'Side', pl.side || 'F', { options: [['F', 'Top'], ['B', 'Bottom']] })}
        ${tht ? `<div class="pcb-ph">Pins (all ${fp.pads.filter((p) => p.drill).length} through-hole pads)</div>
        ${f('dia', 'Pad size (mm)', pl.pad && pl.pad.dia ? pl.pad.dia : dia0, { min: 0.5 })}${f('drill', 'Hole (mm)', pl.pad && pl.pad.drill ? pl.pad.drill : tht.drill, { min: 0.2 })}
        <div class="pcb-hint">Footprint default: ${dia0} mm pad, ${tht.drill} mm hole.${c.check ? ' Check: ' + esc(c.check) : ''}</div>
        ${pl.pad ? '<div class="pcb-btns"><button class="mini" data-a="padreset">Footprint sizes</button></div>' : ''}` : ''}
        ${c.lcsc || /^K:/.test(c.fp) || c.type === 'lib' ? `<div class="pcb-ph">KiCad footprint</div>
        <div class="pcb-hint">${L.fpOver && L.fpOver[c.uid] ? 'Picked here: ' + esc(L.fpOver[c.uid].fp) : /^K:/.test(c.fp) ? 'Matched from the package (' + esc(c.fp.slice(2)) + ')' : 'None matched: pick the one for this package'}</div>
        <input class="input slim pcb-fpq" placeholder="Search footprints: SOT-23-5, QFN-32 5x5…">
        <div class="pcb-fplist"></div>
        ${L.fpOver && L.fpOver[c.uid] ? '<div class="pcb-btns"><button class="mini" data-a="fpreset">Use the matched footprint</button></div>' : ''}` : ''}`;
      apply = (k, v) => {
        const n = Number(v);
        if (k === 'x' || k === 'y') return mutate(() => { pl[k] = sn(n); });
        if (k === 'rot') return mutate(() => { pl.rot = Number(v); });
        if (k === 'side') return mutate(() => { pl.side = v; });
        if (k === 'dia' || k === 'drill') {
          const cur = { dia: pl.pad && pl.pad.dia ? pl.pad.dia : dia0, drill: pl.pad && pl.pad.drill ? pl.pad.drill : tht.drill, [k]: r2(n) };
          if (!(cur.drill >= 0.2) || !(cur.dia > cur.drill)) return ctx.toast('The pad has to be bigger than its hole', 2200);
          if (cur.drill > 6 || cur.dia > 10) return ctx.toast('That is bigger than any pin pad (hole up to 6 mm, pad up to 10 mm)', 2400);
          mutate(() => { pl.pad = cur; });
        }
      };
    } else if (sel.kind === 'hole') {
      const h = L.holes[sel.i];
      html = `<div class="pcb-ph">Mounting hole</div>
        ${f('d', 'Size', h.d, { options: HOLE_SIZES.concat(HOLE_SIZES.some(([v]) => +v === h.d) ? [] : [[String(h.d), h.d + ' mm']]) })}
        ${f('dc', 'or diameter (mm)', h.d, { min: 0.5 })}${f('x', 'X (mm)', r2(h.x), { step: 0.635 })}${f('y', 'Y (mm)', r2(h.y), { step: 0.635 })}
        <div class="pcb-hint">Unplated hole. M3 screws take 3.2 mm (close fit) to 3.4 mm (normal fit).</div>`;
      apply = (k, v) => {
        const n = Number(v);
        if (k === 'd' || k === 'dc') { if (!(n >= 0.5 && n <= 10)) return ctx.toast('Holes go from 0.5 to 10 mm', 2000); return mutate(() => { h.d = r2(n); }); }
        if (k === 'x' || k === 'y') mutate(() => { h[k] = sn(n); });
      };
    } else if (sel.kind === 'via') {
      const v0 = L.vias[sel.i];
      html = `<div class="pcb-ph">Via${v0.net ? ' · ' + esc(v0.net) : ''}</div>
        ${f('drill', 'Drill (mm)', v0.drill, { min: 0.2 })}${f('dia', 'Pad (mm)', v0.dia, { min: 0.4 })}
        ${f('x', 'X (mm)', r2(v0.x), { step: 0.635 })}${f('y', 'Y (mm)', r2(v0.y), { step: 0.635 })}`;
      apply = (k, v) => {
        const n = Number(v);
        if (k === 'drill' || k === 'dia') {
          const nd = { drill: v0.drill, dia: v0.dia, [k]: r2(n) };
          if (!(nd.drill >= 0.2) || !(nd.dia > nd.drill)) return ctx.toast('The via pad has to be bigger than its drill', 2200);
          return mutate(() => { v0.drill = nd.drill; v0.dia = nd.dia; });
        }
        mutate(() => { v0[k] = sn(n); });
      };
    } else if (sel.kind === 'trace') {
      const t = L.traces[sel.i];
      let len = 0; for (let k = 0; k + 1 < t.pts.length; k++) len += Math.hypot(t.pts[k + 1][0] - t.pts[k][0], t.pts[k + 1][1] - t.pts[k][1]);
      html = `<div class="pcb-ph">Trace${t.net ? ' · ' + esc(t.net) : ''}</div>
        ${f('w', 'Width (mm)', t.w, { min: 0.1 })}${f('layer', 'Layer', t.layer, { options: CLs().concat(CLs().includes(t.layer) ? [] : [t.layer]).map((l) => [l, PCB.layerLabel(l)]) })}
        <div class="pcb-hint">${len.toFixed(2)} mm long, ${t.pts.length - 1} segment${t.pts.length === 2 ? '' : 's'}.</div>`;
      apply = (k, v) => {
        if (k === 'w') { const n = Number(v); if (!(n >= 0.1 && n <= 10)) return ctx.toast('Traces go from 0.1 to 10 mm', 2000); return mutate(() => { t.w = r2(n); }); }
        if (k === 'layer') mutate(() => { t.layer = v; });
      };
    } else if (sel.kind === 'pour') {
      const p = L.pours[sel.i];
      const zn = A && A.zones.find((zz) => zz.src === 'pour' && zz.i === sel.i);
      const area = zn && zn.fill ? zn.fill.grid.reduce((a, b) => a + b, 0) * zn.fill.res * zn.fill.res : 0;
      html = `<div class="pcb-ph">Copper pour</div>
        ${f('net', 'Net', p.net || '', { options: [['', '(pick a net)']].concat(netNames().map((nn) => [nn, nn])) })}
        ${f('layer', 'Layer', p.layer, { options: CLs().map((l) => [l, PCB.layerLabel(l)]) })}
        ${f('clearance', 'Clearance (mm)', p.clearance || 0.3, { min: 0.1 })}
        ${f('thermal', 'Pads join by', p.thermal === false ? '0' : '1', { options: [['1', 'Thermal spokes'], ['0', 'Solid copper']] })}
        <div class="pcb-btns"><button class="mini" data-a="pourBoard" title="Make this pour cover the whole board">Whole board</button></div>
        <div class="pcb-hint">${p.pts.length} corners · ${area.toFixed(0)} mm² of copper. Thermal spokes make pads easier to hand-solder.</div>`;
      apply = (k, v) => {
        if (k === 'clearance') { const n = Number(v); if (!(n >= 0.1 && n <= 5)) return ctx.toast('Clearance goes from 0.1 to 5 mm', 2000); return mutate(() => { p.clearance = r2(n); }); }
        if (k === 'thermal') return mutate(() => { p.thermal = v === '1'; });
        mutate(() => { p[k] = v; });
      };
    } else if (sel.kind === 'text') {
      const t = L.texts[sel.i];
      html = `<div class="pcb-ph">Silkscreen text</div>
        ${f('text', 'Text', t.text, { text: true })}${f('h', 'Height (mm)', t.h || 1.5, { min: 0.8, step: 0.1 })}
        ${f('layer', 'Side', t.layer || 'F', { options: [['F', 'Top'], ['B', 'Bottom']] })}
        ${f('x', 'X (mm)', r2(t.x), { step: 0.635 })}${f('y', 'Y (mm)', r2(t.y), { step: 0.635 })}`;
      apply = (k, v) => {
        if (k === 'text') { const s2 = String(v).trim().slice(0, 40); if (!s2) return; return mutate(() => { t.text = s2; }); }
        if (k === 'h') return mutate(() => { t.h = Math.max(0.8, Math.min(5, Number(v) || 1.5)); });
        if (k === 'layer') return mutate(() => { t.layer = v; });
        mutate(() => { t[k] = sn(Number(v)); });
      };
    }
    if (sel) html += `<div class="pcb-btns"><button class="mini" data-a="desel">Done</button>${sel.kind !== 'comp' ? '<button class="mini danger" data-a="del">🗑 Delete</button>' : ''}</div>`;
    el.innerHTML = html;
    el.querySelectorAll('[data-k]').forEach((inp) => inp.addEventListener('change', () => { apply(inp.dataset.k, inp.value); renderProps(); }));
    el.querySelectorAll('input[data-k]').forEach((inp) => inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); }));
    el.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => {
      const a = b.dataset.a;
      if (a === 'del') return deleteSel();
      if (a === 'desel') { sel = null; renderProps(); return draw(); }
      if (a === 'fitb') { mutate(() => { L.board = PCB.fitBoard(net, L.place, (L.holes || []).length ? HOLE_MARGIN : 3); }); return fit(); }
      if (a === 'corners') return addCornerHoles(true);
      if (a === 'rules0') return mutate(() => { L.rules = {}; });
      if (a === 'pourBoard') { const B = L.board; const p = L.pours[sel.i]; return mutate(() => { p.pts = [[0, 0], [B.w, 0], [B.w, B.h], [0, B.h]]; }); }
      if (a === 'padreset') { const pl = L.place[sel.ref]; return mutate(() => { delete pl.pad; }); }
      if (a === 'fpreset') { const c = net.comps.find((q) => q.ref === sel.ref); mutate(() => { delete L.fpOver[c.uid]; }); return syncNetlist(false); }
    }));
    const fq = el.querySelector('.pcb-fpq');
    if (fq) {
      let t = null;
      const list = el.querySelector('.pcb-fplist');
      const c = net.comps.find((q) => q.ref === sel.ref);
      fq.addEventListener('input', () => { clearTimeout(t); t = setTimeout(async () => {
        const rows = fq.value.trim().length < 2 ? [] : await ctx.api.parts.fpSearch(fq.value.trim()).catch(() => []);
        list.innerHTML = (Array.isArray(rows) ? rows : []).slice(0, 30).map((r) => `<div class="pcb-fprow" data-id="${esc(r.id)}" title="${esc(r.d)}">${esc(r.id.split(':')[1])} <span class="dim" style="padding:0">${r.pads} pads${r.smd ? ' · SMD' : ''}</span></div>`).join('') || (fq.value.trim().length >= 2 ? '<div class="pcb-hint">No KiCad footprint matches.</div>' : '');
        list.querySelectorAll('.pcb-fprow').forEach((row) => row.addEventListener('click', async () => {
          const r = await ctx.api.parts.fp(row.dataset.id).catch(() => null);
          if (!r || r.error) return ctx.toast('Could not load that footprint', 2500);
          // every pin the part uses must exist on the footprint
          const nums = new Set(r.def.pads.map((p) => p.num));
          const missing = c.pads.map((p) => p.pad).filter((n) => !nums.has(String(n)));
          const usesPorts = /^H\d+$/.test(c.fp);
          if (missing.length && !usesPorts) return ctx.toast(r.id.split(':')[1] + ' has no pad ' + [...new Set(missing)].join(', ') + ' for this part', 3500);
          mutate(() => { L.fpOver = { ...(L.fpOver || {}), [c.uid]: { fp: r.id, fpData: r.compact } }; });
          await syncNetlist(false);
          ctx.toast(c.ref + ' now uses ' + r.id.split(':')[1] + '. Check its pin numbers against the datasheet.', 3500);
        }));
      }, 250); });
    }
    updateButtons();
  }
  function syncWidthSelect() {
    const ws = root.querySelector('#pcbWidth');
    if (!ws) return;
    if (![...ws.options].some((o) => Number(o.value) === width)) { const o = document.createElement('option'); o.value = String(width); o.textContent = width + ' mm'; ws.appendChild(o); }
    ws.value = String(width);
  }
  function updateButtons() {
    if (!root) return;
    const d = root.querySelector('#pcbDel');
    if (d) d.disabled = !sel || sel.kind === 'comp';
  }

  // ---- interaction --------------------------------------------------------------------
  const snapPt = (x, y) => [sn(x), sn(y)];
  function setTool(t) {
    tool = t; route = null; pourDraft = null;
    root.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
    draw();
  }
  function setLayer(l) {
    if (!CLs().includes(l)) return;
    // switching layers mid-trace drops a via there, the way it is made
    if (route && route.layer !== l) return routeVia(l);
    layer = l;
    const b = root.querySelector('#pcbLayer');
    if (b) { b.textContent = PCB.layerLabel(l); b.style.borderColor = colOf(l); b.classList.toggle('bottom', l === 'B'); }
    renderLayers();
    draw();
  }
  const nextLayer = (l) => { const CL = CLs(); return CL[(CL.indexOf(l) + 1) % CL.length]; };
  function routeVia(to) {
    if (CLs().length === 1) return ctx.toast('A 1-layer board has no other layer to via to', 1800);
    const at = route.next || route.pts[route.pts.length - 1];
    const pts = route.pts.concat([at]);
    if (pts.length >= 2 && !(pts.length === 2 && pts[0][0] === pts[1][0] && pts[0][1] === pts[1][1])) route.done.push({ layer: route.layer, w: route.w, pts, net: route.net });
    route.vias.push({ x: at[0], y: at[1], drill: D().viaDrill, dia: D().viaDia, net: route.net });
    route.pts = [at];
    route.layer = to;
    setLayer(to);
  }
  function finishRoute(endPad) {
    if (!route) return;
    const pts = route.pts.slice();
    if (endPad) pts.push([endPad.x, endPad.y]);
    if (pts.length >= 2) {
      const segs = [];
      for (const s of route.done || []) segs.push(s);
      segs.push({ layer: route.layer, w: route.w, pts, net: route.net });
      mutate(() => { for (const s of segs) if (s.pts.length >= 2) L.traces.push(s); for (const v of route.vias || []) L.vias.push(v); });
    } else if ((route.done || []).length) {
      mutate(() => { for (const s of route.done) L.traces.push(s); for (const v of route.vias || []) L.vias.push(v); });
    }
    route = null;
    refresh();
  }
  function onDown(e) {
    const r = cv.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const [wx, wy] = toWorld(sx, sy);
    if (e.button === 1 || e.button === 2 || (e.button === 0 && e.altKey)) { drag = { pan: true, sx, sy, vx: view.x, vy: view.y }; return; }
    if (e.button !== 0) return;
    const pad = padAt(wx, wy);
    if (tool === 'pour') {
      const p0 = snapPt(wx, wy);
      if (!pourDraft) { pourDraft = [p0]; return draw(); }
      const [fx, fy] = toScreen(pourDraft[0][0], pourDraft[0][1]);
      if (Math.hypot(fx - sx, fy - sy) <= 8) return finishPour();
      pourDraft.push(p0); return draw();
    }
    if (tool === 'route') {
      if (!route) {
        if (!pad) return ctx.toast('Start a trace on a pad', 1400);
        route = { layer, w: width, pts: [[pad.x, pad.y]], net: netOfPad(pad.comp.ref, pad.num), done: [], vias: [] };
      } else if (pad && !(pad.x === route.pts[0][0] && pad.y === route.pts[0][1] && route.pts.length === 1)) {
        const pn = netOfPad(pad.comp.ref, pad.num);
        if (route.net && pn && pn !== route.net) return ctx.toast(`That pad is on net ${pn}; this trace is ${route.net}`, 2000);
        finishRoute(pad);
      } else {
        route.pts.push(constrain(route.pts[route.pts.length - 1], snapPt(wx, wy), e.shiftKey));
      }
      draw(); return;
    }
    if (tool === 'via' || tool === 'hole') {
      const h0 = hit(wx, wy);
      if (h0 && h0.kind === tool) {        // clicking an existing one selects it (and drags it)
        sel = h0; const o = tool === 'via' ? L.vias[h0.i] : L.holes[h0.i];
        drag = { obj: o, ox: o.x, oy: o.y, wx, wy, moved: false, snap: JSON.parse(JSON.stringify(L)) };
        renderProps(); draw(); return;
      }
      const [x, y] = snapPt(wx, wy);
      if (tool === 'via') mutate(() => { L.vias.push({ x, y, drill: D().viaDrill, dia: D().viaDia, net: '' }); sel = { kind: 'via', i: L.vias.length - 1 }; });
      else mutate(() => { L.holes.push({ x, y, d: D().holeD }); sel = { kind: 'hole', i: L.holes.length - 1 }; });
      return;
    }
    if (tool === 'text') {
      const [x, y] = snapPt(wx, wy);
      window.electricadDialog({ title: 'Silkscreen text', okLabel: 'Place', fields: [{ key: 't', label: 'Text (A–Z, 0–9, + - . / : _ ( ))', value: '' },
        { key: 'h', label: 'Height (mm)', value: 1.5, type: 'number' }, { key: 'l', label: 'Side', value: layer === 'B' ? 'B' : 'F', options: [{ value: 'F', label: 'Top' }, { value: 'B', label: 'Bottom' }] }] })
        .then((res) => { if (res && res.t.trim()) mutate(() => L.texts.push({ text: res.t.trim().slice(0, 40), x, y, h: Math.max(0.8, Math.min(5, Number(res.h) || 1.5)), layer: res.l })); });
      return;
    }
    const h = hit(wx, wy);
    sel = h;
    renderProps();
    if (h && (h.kind === 'comp' || h.kind === 'via' || h.kind === 'hole' || h.kind === 'text')) {
      const o = h.kind === 'comp' ? L.place[h.ref] : h.kind === 'via' ? L.vias[h.i] : h.kind === 'hole' ? L.holes[h.i] : L.texts[h.i];
      drag = { obj: o, ox: o.x, oy: o.y, wx, wy, moved: false, snap: JSON.parse(JSON.stringify(L)) };
    }
    draw();
  }
  // Shift: keep the segment horizontal, vertical or at 45°
  function constrain(from, to, on) {
    if (!on) return to;
    const dx = to[0] - from[0], dy = to[1] - from[1];
    const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const len = Math.abs(Math.cos(a)) > 0.1 && Math.abs(Math.sin(a)) > 0.1 ? Math.max(Math.abs(dx), Math.abs(dy)) * Math.SQRT2 : Math.hypot(dx, dy);
    return [sn(from[0] + Math.cos(a) * len), sn(from[1] + Math.sin(a) * len)];
  }
  function onMove(e) {
    const r = cv.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    [mouse.wx, mouse.wy] = toWorld(sx, sy); mouse.x = sx; mouse.y = sy;
    if (drag && drag.pan) { view.x = drag.vx + sx - drag.sx; view.y = drag.vy + sy - drag.sy; draw(); return; }
    if (drag && drag.obj) {
      drag.obj.x = sn(drag.ox + mouse.wx - drag.wx); drag.obj.y = sn(drag.oy + mouse.wy - drag.wy);
      drag.moved = true; draw(); return;
    }
    if (route) {
      const pad = padAt(mouse.wx, mouse.wy);
      route.next = pad ? [pad.x, pad.y] : constrain(route.pts[route.pts.length - 1], snapPt(mouse.wx, mouse.wy), e.shiftKey);
    }
    draw();
  }
  function onUp() {
    if (drag && drag.obj && drag.moved) { hist.push(drag.snap); save(); refresh(); }
    drag = null;
  }
  function onWheel(e) {
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const [wx, wy] = toWorld(sx, sy);
    view.z = Math.max(1, Math.min(80, view.z * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    view.x = sx - wx * view.z; view.y = sy - wy * view.z;
    draw();
  }
  function finishPour() {
    const pts = pourDraft; pourDraft = null;
    if (!pts || pts.length < 3) { draw(); return ctx.toast('A pour needs at least 3 corners', 1600); }
    // the net: what the first corner sits on, else GND
    const pad = padAt(pts[0][0], pts[0][1]);
    const nn = (pad && netOfPad(pad.comp.ref, pad.num)) || (netNames().includes('GND') ? 'GND' : '');
    addPour(pts, layer, nn);
  }
  function onDbl() { if (route) finishRoute(null); else if (pourDraft) { if (pourDraft.length > 3) pourDraft.pop(); finishPour(); } }
  function onKey(e) {
    if (!isActive() || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || document.querySelector('.modal-overlay')) return;
    const k = e.key.toLowerCase();
    if (k === 'enter' && pourDraft) { finishPour(); e.preventDefault(); return; }
    if (k === 'escape') { if (pourDraft) { pourDraft = null; draw(); } else if (route) { finishRoute(null); } else { sel = null; renderProps(); setTool('select'); } e.preventDefault(); return; }
    if (e.ctrlKey && k === 'z') { e.preventDefault(); undo(e.shiftKey); return; }
    if (e.ctrlKey && k === 'y') { e.preventDefault(); undo(true); return; }
    if (e.ctrlKey) return;
    if (k === 'v' && route) {
      // via here, carry on on the other outer layer (from an inner one: the top)
      routeVia(route.layer === 'F' ? 'B' : 'F');
      e.preventDefault(); return;
    }
    if (/^[1-6]$/.test(k) && CLs()[Number(k) - 1]) { setLayer(CLs()[Number(k) - 1]); e.preventDefault(); return; }
    if (k === 'r' && sel && sel.kind === 'comp') { mutate(() => { const p = L.place[sel.ref]; p.rot = ((p.rot || 0) + 90) % 360; }); e.preventDefault(); return; }
    if (k === 'f' && sel && sel.kind === 'comp') { mutate(() => { const p = L.place[sel.ref]; p.side = p.side === 'B' ? 'F' : 'B'; }); e.preventDefault(); return; }
    if ((k === 'delete' || k === 'backspace') && sel) { deleteSel(); e.preventDefault(); return; }
    if (sel && /^arrow/.test(k)) {
      // nudge by one grid step (Shift: 2.54 mm)
      const st = e.shiftKey ? 2.54 : grid.step;
      const dx = k === 'arrowleft' ? -st : k === 'arrowright' ? st : 0, dy = k === 'arrowup' ? -st : k === 'arrowdown' ? st : 0;
      const o = sel.kind === 'comp' ? L.place[sel.ref] : sel.kind === 'trace' || sel.kind === 'pour' ? null : { via: L.vias, hole: L.holes, text: L.texts }[sel.kind][sel.i];
      if (o) mutate(() => { o.x = sn(o.x + dx); o.y = sn(o.y + dy); });
      else if (sel.kind === 'pour') mutate(() => { const p = L.pours[sel.i]; p.pts = p.pts.map(([x, y]) => [sn(x + dx), sn(y + dy)]); });
      else if (sel.kind === 'trace') mutate(() => { L.traces[sel.i].pts = L.traces[sel.i].pts.map(([x, y]) => [sn(x + dx), sn(y + dy)]); });
      e.preventDefault(); return;
    }
    if (k === 'x' || k === 't') { setTool('route'); e.preventDefault(); return; }
    if (k === 'l') { setLayer(nextLayer(layer)); e.preventDefault(); return; }
    if (k === 'p') { setTool('pour'); e.preventDefault(); return; }
    if (k === 's') { setTool('select'); e.preventDefault(); return; }
    if (k === 'g' && !e.ctrlKey && !e.altKey) {
      if (e.shiftKey) setGrid({ snap: !grid.snap }, grid.snap ? 'Snap off' : 'Snap to grid on');
      else setGrid({ on: !grid.on }, grid.on ? 'Grid hidden' : 'Grid shown');
      e.preventDefault(); return;
    }
    if (k === 'home' || k === '0') { fit(); e.preventDefault(); }
  }

  // ---- outputs ---------------------------------------------------------------------
  function projName() { const d = ctx.getProjectDir(); return d ? d.split(/[\\/]/).pop() : 'board'; }
  function fabDir() { const d = ctx.getProjectDir(); return d + sep(d) + 'fab'; }
  // writes the Gerber zip (and BOM / CPL / netlist beside it); returns the zip path
  async function exportFab(quiet) {
    if (!ctx.getProjectDir()) { ctx.toast('Open a project first'); return null; }
    if (!net.comps.length) { ctx.toast('Nothing on the board yet. Click "From canvas" after wiring parts.', 2600); return null; }
    const name = projName();
    const info = await ctx.api.app.info().catch(() => ({}));
    const files = PCB.fabFiles(L, net, { name, version: info.version || '' });
    const dir = fabDir();
    await ctx.api.file.mkdir(dir);
    const zip = dir + sep(dir) + name + '-gerbers.zip';
    await ctx.api.file.zipWrite(zip, Object.entries(files).map(([n, text]) => ({ name: n, text })));
    await ctx.api.file.write(dir + sep(dir) + name + '-bom.csv', PCB.bomCsv(net, 'generic'));
    await ctx.api.file.write(dir + sep(dir) + name + '-bom-jlcpcb.csv', PCB.bomCsv(net, 'jlcpcb'));
    await ctx.api.file.write(dir + sep(dir) + name + '-bom-pcbway.csv', PCB.bomCsv(net, 'pcbway'));
    await ctx.api.file.write(dir + sep(dir) + name + '-cpl-jlcpcb.csv', PCB.cplCsv(L, net, 'jlcpcb'));
    await ctx.api.file.write(dir + sep(dir) + name + '-cpl-pcbway.csv', PCB.cplCsv(L, net, 'pcbway'));
    await ctx.api.file.write(dir + sep(dir) + name + '.net', PCB.kicadNetlist(net, name));
    if (ctx.onFilesChanged) ctx.onFilesChanged();
    if (!quiet) ctx.toast(`Gerbers, drill, BOM and pick-and-place saved in fab\\ (${Object.keys(files).length} files)`, 3200);
    return zip;
  }
  // the one-click order: rule check, export, open the maker's page, show the zip
  async function order() {
    const errs = issues.filter((x) => x.severity === 'error');
    if (errs.length) {
      const go = await window.electricadConfirm('Design rule problems',
        `${errs.length} problem${errs.length === 1 ? '' : 's'} on the board (first: ${esc(errs[0].message)}). The fab will make exactly what you send.`,
        [{ label: 'Fix first', value: false }, { label: 'Export and order anyway', value: true, danger: true }]);
      if (!go) return;
    }
    const zip = await exportFab(true);
    if (!zip) return;
    const m = PCB.MAKERS.find((x) => x.id === (L.maker || 'jlcpcb')) || PCB.MAKERS[0];
    ctx.api.openExternal(m.url);
    ctx.api.file.reveal(zip);
    ctx.toast(`Opened ${m.name}. Drag ${zip.split(/[\\/]/).pop()} from Explorer onto their upload box.`, 6000);
  }
  async function preview() {
    const zip = await exportFab(true);
    if (zip && window.electricadGerberPreview) window.electricadGerberPreview(zip);
  }

  // ---- build ----------------------------------------------------------------------
  let root = null;
  function build(h) {
    host = h;
    root = document.createElement('div');
    root.className = 'pcb-root';
    root.innerHTML = `
      <div class="pcb-bar">
        <button class="mini pcb-b" id="pcbSync" title="Load the parts and connections from the wiring canvas">⟲ From canvas</button>
        <span class="pcb-gap"></span>
        <button class="mini pcb-b on" data-tool="select" title="Select and move parts (S)">⬚ Select</button>
        <button class="mini pcb-b" data-tool="route" title="Draw copper traces (X): click a pad, click to bend, click a pad to finish">╱ Route</button>
        <button class="mini pcb-b" data-tool="via" title="Place a via (V while routing)">◎ Via</button>
        <button class="mini pcb-b" data-tool="hole" title="Place an M3 mounting hole">○ Hole</button>
        <button class="mini pcb-b" data-tool="text" title="Place silkscreen text">T Text</button>
        <button class="mini pcb-b" data-tool="pour" title="Draw a copper pour (P): click its corners on the active layer">▰ Pour</button>
        <span class="pcb-gap"></span>
        <button class="mini pcb-b" id="pcbLayer" title="Copper layer for new traces (L cycles, 1–6 picks). Layer count and planes are in the side panel.">Top copper</button>
        <select class="input slim" id="pcbWidth" title="Width of new traces">${WIDTHS.map((w) => `<option value="${w}" ${w === width ? 'selected' : ''}>${w} mm</option>`).join('')}</select>
        <button class="mini pcb-b" id="pcbSize" title="Board size, default hole/via/trace sizes and design rules (in the side panel)">▭ Board</button>
        <button class="mini pcb-b" id="pcbAuto" title="Lay the parts out again in rows">⊞ Auto</button>
        <button class="mini pcb-b" id="pcbFit" title="Fit the board to the view (Home)">⤢ Fit</button>
        <button class="mini pcb-b" id="pcbGrid" title="Show or hide the grid (G)">#</button>
        <select class="input slim" id="pcbGridStep" style="width:70px" title="Grid spacing in mm: what parts, traces and vias snap to">${GRID_STEPS.map((v) => `<option value="${v}" title="${v === 0.635 ? '25 mil' : v === 1.27 ? '50 mil' : v === 2.54 ? '100 mil, the 0.1 inch pin pitch' : ''}">${v}</option>`).join('')}</select>
        <button class="mini pcb-b" id="pcbSnap" title="Snap to the grid (Shift+G)">⌗</button>
        <button class="mini pcb-b" id="pcbPanels" title="Show or hide the file, board and serial panels around the PCB">◫</button>
        <span class="pcb-gap"></span>
        <button class="mini pcb-b" id="pcbUndo" title="Undo (Ctrl+Z)">↶</button>
        <button class="mini pcb-b" id="pcbRedo" title="Redo (Ctrl+Y)">↷</button>
        <button class="mini pcb-b" id="pcbDel" title="Delete the selected trace, via, hole or text (Del)" disabled>🗑 Delete</button>
        <button class="mini pcb-b" id="pcbClear" title="Remove every trace, via, hole and text (parts stay)">✕ Clear</button>
        <button class="mini pcb-b" id="pcbReset" title="Start the board again: fresh layout, default sizes and rules">⟲ Reset</button>
        <span class="grow"></span>
        <button class="mini pcb-b" id="pcbExport" title="Save Gerbers, drill, BOM, pick-and-place and a KiCad netlist in the project's fab folder">⇩ Export</button>
        <button class="mini pcb-b" id="pcbPreview" title="Draw the exported Gerber files back from disk">👁 Preview</button>
        <select class="input slim" id="pcbMaker" title="Which board maker the Order button opens">${PCB.MAKERS.map((m) => `<option value="${m.id}">${m.name}</option>`).join('')}</select>
        <button class="action primary pcb-order" id="pcbOrder" title="Check, export, open the maker's upload page and show the zip">🛒 Order PCB</button>
      </div>
      <div class="pcb-main"><canvas class="pcb-cv"></canvas><div class="pcb-side"><div class="pcb-props"></div><div class="pcb-layers"></div><div class="pcb-drc"></div></div></div>
      <div class="pcb-status dim"></div>`;
    host.appendChild(root);
    cv = root.querySelector('.pcb-cv'); g = cv.getContext('2d');
    side = root.querySelector('.pcb-side'); statusEl = root.querySelector('.pcb-status');
    cv.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', (e) => { if (isActive() && (drag || e.target === cv)) onMove(e); });
    window.addEventListener('mouseup', () => { if (isActive()) onUp(); });
    cv.addEventListener('wheel', onWheel, { passive: false });
    cv.addEventListener('dblclick', onDbl);
    cv.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (route) { finishRoute(null); return; }
      const r = cv.getBoundingClientRect();
      const [wx, wy] = toWorld(e.clientX - r.left, e.clientY - r.top);
      const h = hit(wx, wy);
      if (!h || !window.electricadContextMenu) return;
      sel = h; draw();
      const items = h.kind === 'comp' ? [
        { label: 'Rotate 90°', keys: 'R', run: () => mutate(() => { const p = L.place[h.ref]; p.rot = ((p.rot || 0) + 90) % 360; }) },
        { label: (L.place[h.ref].side === 'B' ? 'Move to top' : 'Move to bottom'), keys: 'F', run: () => mutate(() => { const p = L.place[h.ref]; p.side = p.side === 'B' ? 'F' : 'B'; }) }]
        : [{ label: 'Delete', keys: 'Del', danger: true, run: () => { sel = null; mutate(() => ({ trace: L.traces, via: L.vias, hole: L.holes, text: L.texts, pour: L.pours }[h.kind]).splice(h.i, 1)); } }];
      if (h.kind === 'trace' && CLs().length > 1) items.unshift({ label: 'Move to ' + PCB.layerLabel(nextLayer(L.traces[h.i].layer)), run: () => mutate(() => { const t = L.traces[h.i]; t.layer = nextLayer(t.layer); }) },
        { label: 'Width…', run: async () => { const r2 = await window.electricadDialog({ title: 'Trace width', fields: [{ key: 'w', label: 'Width (mm)', value: L.traces[h.i].w, type: 'number' }] }); const n = r2 && Number(r2.w); if (n >= 0.1 && n <= 10) mutate(() => { L.traces[h.i].w = n; }); } });
      window.electricadContextMenu(e.clientX, e.clientY, items);
    });
    window.addEventListener('keydown', onKey);
    new ResizeObserver(() => draw()).observe(cv);
    root.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
    root.querySelector('#pcbLayer').addEventListener('click', () => setLayer(nextLayer(layer)));
    root.querySelector('#pcbWidth').addEventListener('change', (e) => { width = Number(e.target.value); L.defaults = { ...D(), traceW: width }; save(); renderProps(); draw(); });
    root.querySelector('#pcbUndo').addEventListener('click', () => undo(false));
    root.querySelector('#pcbRedo').addEventListener('click', () => undo(true));
    root.querySelector('#pcbDel').addEventListener('click', deleteSel);
    root.querySelector('#pcbClear').addEventListener('click', clearBoard);
    root.querySelector('#pcbReset').addEventListener('click', resetBoard);
    root.querySelector('#pcbSync').addEventListener('click', () => syncNetlist(true));
    root.querySelector('#pcbFit').addEventListener('click', fit);
    root.querySelector('#pcbGrid').addEventListener('click', () => setGrid({ on: !grid.on }));
    root.querySelector('#pcbSnap').addEventListener('click', () => setGrid({ snap: !grid.snap }, grid.snap ? 'Snap off' : 'Snap to grid on'));
    root.querySelector('#pcbGridStep').addEventListener('change', (e) => setGrid({ step: Number(e.target.value) || PCB.GRID }));
    syncGridUi();
    root.querySelector('#pcbPanels').addEventListener('click', () => {
      const full = document.body.classList.toggle('pcb-full');
      try { localStorage.setItem('ec_pcb_panels', full ? '0' : '1'); } catch (e) {}
      requestAnimationFrame(fit);
    });
    root.querySelector('#pcbAuto').addEventListener('click', () => mutate(() => {
      const holes = (L.holes || []).length > 0, m = holes ? HOLE_MARGIN : 3;
      L.place = PCB.autoPlace(net, {}, { margin: holes ? HOLE_MARGIN : 3.81 });
      L.board = PCB.fitBoard(net, L.place, m);
      if (holes) addCornerHoles(false);
    }));
    // board size, default sizes and rules live in the side panel when nothing is selected
    root.querySelector('#pcbSize').addEventListener('click', () => {
      sel = null; renderProps(); draw();
      const w = side.querySelector('[data-k="bw"]'); if (w) { w.focus(); w.select(); }
    });
    root.querySelector('#pcbExport').addEventListener('click', async () => { const z = await exportFab(false); if (z) ctx.api.file.reveal(z); });
    root.querySelector('#pcbPreview').addEventListener('click', preview);
    root.querySelector('#pcbMaker').addEventListener('change', (e) => { L.maker = e.target.value; save(); });
    root.querySelector('#pcbOrder').addEventListener('click', order);
  }
  function isActive() { return !!(root && root.offsetParent); }

  return {
    async init(h, context) { ctx = context; build(h); await load(); root.querySelector('#pcbMaker').value = L.maker || 'jlcpcb'; requestAnimationFrame(fit); },
    async onShow() { await load(); root.querySelector('#pcbMaker').value = L.maker || 'jlcpcb'; requestAnimationFrame(() => { if (!drag) fit(); }); },
    isActive, exportFab, order,
    _state: () => ({ L, net, issues, rats, layer, A }),
    _select: (s) => { sel = s; renderProps(); draw(); },
    _select: (x) => { sel = x; renderProps(); draw(); }
  };
})();
