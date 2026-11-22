// Live board renderer. Draws a board def as SVG once, then paints pin pads
// in place on every telemetry frame — no re-layout, just class/attr swaps.
// Also keeps a short history ring per pin for the inspector sparkline and
// feeds the timeline recorder.
//
// View options (all optional):
//   mode    'drawn' | 'image' | 'both' (side by side) | 'overlay'
//   face    'front' | 'back'  (back = the board turned over left-to-right,
//           so everything is mirrored, exactly as you would see it)
//   rot     0 | 90 | 180 | 270, clockwise
//   image   { src, ... } from PinodeBoardImages, already in board units
//   opacity drawing opacity over the image in overlay mode (0..1)
//   parts   every component from the maker's design file (boardparts.js);
//           drawn with their markings, and each one answers the mouse
//   onPart  (part, 'enter' | 'move' | 'leave', event) for the hover box
window.PinodeBoard = (function () {
  const NS = 'http://www.w3.org/2000/svg';
  const HISTORY = 240; // frames kept per pin (~12s at 20Hz)

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  }

  // board units → what you see: mirror for the back, then rotate clockwise
  function viewTransform(def, face, rot) {
    const W = def.w, H = def.h;
    const r = ((Number(rot) || 0) % 360 + 360) % 360;
    const back = face === 'back';
    // affine [a b c d e f]: X = a x + c y + e, Y = b x + d y + f
    let m = back ? [-1, 0, 0, 1, W, 0] : [1, 0, 0, 1, 0, 0];
    const mul = (p, q) => [p[0] * q[0] + p[2] * q[1], p[1] * q[0] + p[3] * q[1], p[0] * q[2] + p[2] * q[3], p[1] * q[2] + p[3] * q[3],
      p[0] * q[4] + p[2] * q[5] + p[4], p[1] * q[4] + p[3] * q[5] + p[5]];
    if (r === 90) m = mul([0, 1, -1, 0, H, 0], m);
    else if (r === 180) m = mul([-1, 0, 0, -1, W, H], m);
    else if (r === 270) m = mul([0, -1, 1, 0, 0, W], m);
    const vw = r === 90 || r === 270 ? H : W, vh = r === 90 || r === 270 ? W : H;
    const pt = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    const dir = (x, y) => [m[0] * x + m[2] * y, m[1] * x + m[3] * y];
    return { m, vw, vh, pt, dir, back, rot: r, attr: 'matrix(' + m.map((v) => +v.toFixed(4)).join(' ') + ')' };
  }
  const SIDE_VEC = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] };
  const LABEL_VEC = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
  function sideOf(v) {
    const [x, y] = v;
    if (Math.abs(x) > Math.abs(y)) return x < 0 ? 'left' : 'right';
    return y < 0 ? 'top' : 'bottom';
  }

  // one SVG of the board; pads register into the shared maps
  function drawView(host, def, opt, shared, onHover) {
    const T = viewTransform(def, opt.face, opt.rot);
    const showImage = opt.mode === 'image' || opt.mode === 'overlay';
    const showDrawing = opt.mode !== 'image';
    const svg = el('svg', { viewBox: `0 0 ${+T.vw.toFixed(2)} ${+T.vh.toFixed(2)}`, class: 'bv bv-' + opt.mode + (T.back ? ' bv-back' : '') }, host);
    const g = el('g', { transform: T.attr }, svg);
    const pad = def.pad || 8;

    if (showImage && opt.image) {
      // images are stored in board units already; a photo of the back is kept
      // as photographed, which is the mirrored frame, so undo the mirror here
      const ig = el('g', { transform: T.back ? `matrix(-1 0 0 1 ${def.w} 0)` : 'matrix(1 0 0 1 0 0)' }, g);
      const im = el('image', { x: 0, y: 0, width: def.w, height: def.h, preserveAspectRatio: 'none', class: 'bv-img' }, ig);
      im.setAttribute('href', opt.image.src);
    }
    const draw = el('g', { class: 'bv-draw' }, g);
    if (opt.mode === 'overlay') draw.setAttribute('opacity', String(opt.opacity != null ? opt.opacity : 0.5));
    if (showDrawing) {
      if (def.outline) {
        el('path', { d: 'M' + def.outline.map((p) => p.map((v) => +v.toFixed(2)).join(' ')).join('L') + 'Z', class: 'pcb' + (T.back ? ' back' : '') }, draw);
      } else {
        el('rect', { x: 1, y: 1, width: def.w - 2, height: def.h - 2, rx: 8, class: 'pcb' + (def.id === 'pi' ? ' pi' : '') + (T.back ? ' back' : '') }, draw);
      }
      for (const h of def.holes || []) el('circle', { cx: h.x, cy: h.y, r: h.r, class: 'hole' }, draw);
      for (const d of def.decor || []) {
        // from the back you only see what goes through the board: parts on
        // the top side are outlined faintly so you can still find your way
        const cls = T.back ? ' ghost' : '';
        if (d.kind === 'usb' || d.kind === 'jack') {
          el('rect', { x: d.x, y: d.y, width: d.w, height: d.h, rx: 2, class: 'usb' + cls }, draw);
        } else if (d.kind === 'button') {
          el('rect', { x: d.x, y: d.y, width: d.w, height: d.h, rx: 1.5, class: 'btn-body' + cls }, draw);
          if (!T.back) el('circle', { cx: d.x + d.w / 2, cy: d.y + d.h / 2, r: Math.min(d.w, d.h) * 0.28, class: 'btn-cap' }, draw);
        } else if (d.kind === 'chip') {
          const cx = d.x + d.w / 2, cy = d.y + d.h / 2;
          // with the real parts known, the chips are drawn from them instead
          if (!(opt.parts && opt.parts.length)) el('rect', { x: d.x, y: d.y, width: d.w, height: d.h, rx: 1.5, class: 'chip-body' + cls,
            transform: d.rot45 ? `rotate(45 ${cx} ${cy})` : '' }, draw);
        }
      }
      if (opt.parts && def.toUnits) drawParts(draw, def, opt.parts, T);
    }
    // LEDs light up in every mode; on the back they are hidden by the board.
    // Each one is a dark lens with a glow layer whose opacity is the light.
    if (!T.back && (showDrawing || opt.mode === 'image')) {
      const R = def.unitsPerMm ? 3.4 : 4;
      const tip = (d, what) => { const t = el('title', {}, null); t.textContent = d.label + ' · ' + what; return t; };
      for (const d of def.decor || []) {
        if (d.kind === 'led') {
          const led = el('g', { class: 'led' + (d.unreadable ? ' unknown' : '') }, g);
          el('circle', { cx: d.x, cy: d.y, r: R, class: 'led-lens' }, led);
          el('circle', { cx: d.x, cy: d.y, r: R, class: 'led-glow', fill: d.color || '#3fd07a', opacity: 0 }, led);
          led.appendChild(tip(d, d.note || (d.role === 'power' ? 'lit while the board has power'
            : d.role === 'charge' ? 'battery charger: lit while charging'
            : d.role ? (d.role === 'tx' ? 'blinks when the board sends serial data' : 'blinks when the board receives serial data')
            : d.tele != null ? 'follows pin ' + d.tele + (d.invert ? ' (LOW = on)' : '') : 'onboard LED')));
          led.dataset.led = '1';
          led.dataset.color = d.color || '#3fd07a';
          if (d.tele != null) led.setAttribute('data-tele', d.tele);
          if (d.role) led.dataset.role = d.role;
          if (d.invert) led.dataset.invert = '1';
        } else if (d.kind === 'rgb') {
          // a NeoPixel: white 3.5 mm package, the die shows the colour
          const s = def.unitsPerMm ? 1.75 * def.unitsPerMm : 7;
          const led = el('g', { class: 'led rgb' }, g);
          el('rect', { x: d.x - s, y: d.y - s, width: 2 * s, height: 2 * s, rx: 1, class: 'rgb-body' }, led);
          el('circle', { cx: d.x, cy: d.y, r: s * 0.62, class: 'led-lens' }, led);
          el('circle', { cx: d.x, cy: d.y, r: s * 0.62, class: 'led-glow', fill: '#000', opacity: 0 }, led);
          led.appendChild(tip(d, 'NeoPixel on pin ' + d.tele + ' (shows its colour when the sketch uses ELECTRICAD_NEOPIXEL)'));
          led.dataset.rgb = String(d.tele);
        } else if (d.kind === 'matrix' && d.points) {
          const mg = el('g', { class: 'led-matrix' }, g);
          const w = def.unitsPerMm ? 1.6 * def.unitsPerMm : 6, h = def.unitsPerMm ? 0.8 * def.unitsPerMm : 3;
          d.points.forEach(([x, y], i) => {
            el('rect', { x: x - w / 2, y: y - h / 2, width: w, height: h, rx: 0.4, class: 'led-lens' }, mg);
            const lit = el('rect', { x: x - w / 2 - 0.6, y: y - h / 2 - 0.6, width: w + 1.2, height: h + 1.2, rx: 0.8, class: 'led-glow', fill: d.color, opacity: 0 }, mg);
            lit.dataset.px = String(i);
          });
          mg.appendChild(tip(d, '12 × 8, follows Arduino_LED_Matrix'));
        }
      }
    }

    if (opt.parts && def.toUnits) partHotspots(g, def, opt.parts, T, opt);

    const labels = el('g', { class: 'bv-labels' }, svg);
    const text = (x, y, s, cls, anchor, rot) => {
      const t = el('text', { x: +x.toFixed(2), y: +y.toFixed(2), class: cls, 'text-anchor': anchor || 'middle' }, labels);
      if (rot) t.setAttribute('transform', `rotate(${rot} ${+x.toFixed(2)} ${+y.toFixed(2)})`);
      t.textContent = s;
      return t;
    };
    // chip and LED captions stay upright whatever the rotation
    if (showDrawing && !T.back) {
      for (const d of def.decor || []) {
        if (d.kind === 'chip' && d.label && !(opt.parts && opt.parts.length)) {
          const [x, y] = T.pt(d.x + d.w / 2, d.y + d.h / 2);
          text(x, y + 2, d.label, 'pin-label' + (d.small ? ' small' : ''));
        } else if (d.kind === 'led' && d.label) {
          const [x, y] = T.pt(d.x, d.y);
          text(x, y + (def.unitsPerMm ? 9.5 : 11), d.label, 'pin-label');
        }
      }
    }
    if (showDrawing && def.name) {
      // boards with their labels outside along the long edges (Feathers, a
      // turned Nano) carry the title on the board, clear of those labels
      const inside = def.geo && !def.labelsIn && T.vw > T.vh;
      const M = (def.geo && def.geo.margin) || 10;
      const t = el('text', inside ? { x: M + 20 * def.unitsPerMm, y: T.vh - M - 3.4 * def.unitsPerMm, class: 'board-title' } : { x: 8, y: T.vh - 8, class: 'board-title' }, labels);
      t.textContent = (opt.title || def.name).toUpperCase() + (T.back ? ' (BACK)' : '');
      // narrow boards (the Nanos) get a smaller title so it stays on the board
      const fit = (T.vw - 16 - (inside ? 2 * M + 22 * def.unitsPerMm : 0)) / (t.textContent.length * 0.78);
      if (fit < 7) t.style.fontSize = Math.max(3.5, fit).toFixed(2) + 'px';
    }

    for (const p of def.pins) {
      const padEl = el('rect', {
        x: +(p.x - pad / 2).toFixed(2), y: +(p.y - pad / 2).toFixed(2), width: pad, height: pad, rx: 1.5,
        class: 'pin-pad ' + (p.tele == null ? 'stale' : 'mode-in level-0')
      }, g);
      if (opt.mode !== 'image') {
        if (p.power === 'gnd') padEl.style.fill = '#1c1c1c';
        if (p.power === 'v5' || p.power === 'vin') padEl.style.fill = '#5c1e1e';
        if (p.power === 'v33') padEl.style.fill = '#5c3a1e';
      }
      // label beside the pad, upright. labelAt (board units: left/right/up/
      // down) wins; otherwise labelsIn boards put it on the board side of
      // the pad and the older drawings outside it
      const [x, y] = T.pt(p.x, p.y);
      const side = sideOf(T.dir(...(SIDE_VEC[p.side] || [0, -1])));
      const gap = pad / 2 + 2.2;
      let t;
      if (p.labelAt || def.unitsPerMm) {
        const v = p.labelAt ? LABEL_VEC[p.labelAt] : SIDE_VEC[p.side] || [0, -1];
        const d = sideOf(T.dir(...(p.labelAt || !def.labelsIn ? v : [-v[0], -v[1]])));
        if (d === 'bottom') t = text(x + 1.9, y + gap, p.label, 'pin-label', 'end', -90);
        else if (d === 'top') t = text(x + 1.9, y - gap, p.label, 'pin-label', 'start', -90);
        else if (d === 'right') t = text(x + gap, y + 1.9, p.label, 'pin-label', 'start');
        else t = text(x - gap, y + 1.9, p.label, 'pin-label', 'end');
      } else if (side === 'top' || side === 'bottom') {
        t = text(x, side === 'top' ? y + 12 : y - 8, p.label, 'pin-label');
      } else if (side === 'left') {
        t = text(x - 7, y + 2, p.label, 'pin-label', 'end');
      } else {
        t = text(x + 7, y + 2, p.label, 'pin-label', 'start');
      }
      if (p.extra) t.classList.add('extra');
      padEl.addEventListener('mouseenter', () => onHover && onHover(p, shared.latest(p)));
      if (p.tele != null) {
        if (!shared.pads.has(p.tele)) shared.pads.set(p.tele, []);
        shared.pads.get(p.tele).push(padEl);
        if (!shared.history.has(p.tele)) shared.history.set(p.tele, { ring: new Uint8Array(HISTORY), i: 0, n: 0 });
      }
    }
    // LEDs: by pin, by role (power, tx, rx, charge; a role LED can also sit
    // on a pin, like the Leonardo's), NeoPixels by data pin, matrix pixels
    svg.querySelectorAll('[data-led]').forEach((led) => {
      if (led.dataset.role) (shared.roleLeds[led.dataset.role] || []).push(led);
      if (led.getAttribute('data-tele') == null) return;
      const t = Number(led.getAttribute('data-tele'));
      if (!shared.leds.has(t)) shared.leds.set(t, []);
      shared.leds.get(t).push(led);
    });
    svg.querySelectorAll('[data-rgb]').forEach((led) => shared.rgb.push(led));
    svg.querySelectorAll('[data-px]').forEach((px) => { shared.matrix[Number(px.dataset.px)] = shared.matrix[Number(px.dataset.px)] || []; shared.matrix[Number(px.dataset.px)].push(px); });
    return svg;
  }

  // ---- components from the design files ---------------------------------------
  // body rectangle of a part in board units
  function partRect(def, c) {
    const [ax, ay] = def.toUnits(c.box[0], c.box[1]), [bx, by] = def.toUnits(c.box[2], c.box[3]);
    return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
  }
  const onSide = (c, T) => (c.side || 'top') === (T.back ? 'bottom' : 'top');
  // parts drawn elsewhere (LEDs, connectors, USB, jack, button) only get a hotspot
  const BODY = { ic: 'bp-ic', module: 'bp-module', cap: 'bp-cap', res: 'bp-res', rarray: 'bp-res', ecap: 'bp-ecap', xtal: 'bp-xtal',
    diode: 'bp-dark', tvs: 'bp-dark', fet: 'bp-dark', fuse: 'bp-fuse', ferrite: 'bp-dark', ind: 'bp-ind' };
  function drawParts(parent, def, parts, T) {
    const top = el('g', { class: 'bv-parts' }, parent);
    for (const c of parts) {
      if (!c.box || !onSide(c, T) || !BODY[c.kind]) continue;
      const r = partRect(def, c);
      const cls = 'bp ' + BODY[c.kind];
      // parts placed at an angle (the Nano Every's chips sit at 45°)
      const odd = ((c.rot || 0) % 90 + 90) % 90;
      const layer = odd ? el('g', { transform: `rotate(${odd} ${+(r.x + r.w / 2).toFixed(2)} ${+(r.y + r.h / 2).toFixed(2)})` }, top) : top;
      if (c.kind === 'ecap' && /PANASONIC/.test(c.pkg || '')) {
        // aluminium can seen from above: a round lid on a square base
        el('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: 1, class: 'bp bp-dark' }, layer);
        el('circle', { cx: r.x + r.w / 2, cy: r.y + r.h / 2, r: Math.min(r.w, r.h) * 0.46, class: 'bp bp-can' }, layer);
      } else {
        el('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: c.kind === 'xtal' ? Math.min(r.w, r.h) / 2.4 : 0.6, class: cls }, layer);
        if (/^(cap|res|rarray|ferrite|fuse)$/.test(c.kind)) {
          // metal end caps along the long side
          const along = r.w >= r.h, e = (along ? r.w : r.h) * 0.18;
          if (along) { el('rect', { x: r.x, y: r.y, width: e, height: r.h, class: 'bp bp-end' }, layer); el('rect', { x: r.x + r.w - e, y: r.y, width: e, height: r.h, class: 'bp bp-end' }, layer); }
          else { el('rect', { x: r.x, y: r.y, width: r.w, height: e, class: 'bp bp-end' }, layer); el('rect', { x: r.x, y: r.y + r.h - e, width: r.w, height: e, class: 'bp bp-end' }, layer); }
        }
      }
      if (c.mark) markText(layer, r, c.mark, c.kind === 'ecap' || c.kind === 'xtal' || c.kind === 'module' ? 'bp-mark dark' : 'bp-mark', T.back);
    }
  }
  // the factory print, sized to the body, along its long side
  function markText(parent, r, lines, cls, back) {
    const s = lines.join(' ');
    const vert = r.h > r.w * 1.25;
    const len = vert ? r.h : r.w, thick = vert ? r.w : r.h;
    // printed text on real parts is about 1–1.5 mm tall
    const fs = Math.max(0.9, Math.min(thick * 0.42, (len * 0.86) / (s.length * 0.62), 6));
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    let tr = vert ? `rotate(-90 ${+cx.toFixed(2)} ${+cy.toFixed(2)})` : '';
    // on the back the board is mirrored; print is read the right way round
    if (back) tr = `translate(${+(2 * cx).toFixed(2)} 0) scale(-1 1) ` + tr;
    const t = el('text', { x: +cx.toFixed(2), y: +(cy + fs * 0.35).toFixed(2), class: cls, 'text-anchor': 'middle', 'font-size': fs.toFixed(2), transform: tr }, parent);
    t.textContent = s;
  }
  // an invisible hit area per part (at least 1.4 mm, small parts on top)
  function partHotspots(parent, def, parts, T, opt) {
    const layer = el('g', { class: 'bv-hits' }, parent);
    const U = def.unitsPerMm || 4, min = 1.4 * U;
    const leds = (def.decor || []).filter((d) => d.kind === 'led' || d.kind === 'rgb');
    const list = parts.filter((c) => c.box && onSide(c, T)).map((c) => ({ c, r: partRect(def, c) }))
      .sort((a, b) => b.r.w * b.r.h - a.r.w * a.r.h);
    for (const { c, r } of list) {
      const w = Math.max(r.w, min), h = Math.max(r.h, min);
      const hit = el('rect', { x: r.x + r.w / 2 - w / 2, y: r.y + r.h / 2 - h / 2, width: w, height: h, rx: 0.8, class: 'bp-hit' }, layer);
      hit.dataset.ref = c.ref;
      // an onboard LED from the board definition: carry what it shows
      if ((c.kind === 'led' || c.kind === 'rgb') && !c.led) {
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        const d = leds.find((l) => Math.hypot(l.x - cx, l.y - cy) < 2.2 * U);
        if (d) c.led = { label: d.label, tele: d.tele, role: d.role, invert: !!d.invert, color: d.color, note: d.note, rgb: d.kind === 'rgb' };
      }
      if (opt.onPart) {
        hit.addEventListener('mouseenter', (e) => opt.onPart(c, 'enter', e));
        hit.addEventListener('mousemove', (e) => opt.onPart(c, 'move', e));
        hit.addEventListener('mouseleave', (e) => opt.onPart(c, 'leave', e));
        hit.addEventListener('click', (e) => opt.onPart(c, 'click', e));
      }
    }
  }

  function create(host, def, onHover, opts) {
    const opt = Object.assign({ mode: 'drawn', face: 'front', rot: 0, image: null, opacity: 0.5 }, opts || {});
    if (opt.mode !== 'drawn' && !opt.image) opt.mode = 'drawn';
    host.innerHTML = '';
    const shared = { pads: new Map(), leds: new Map(), history: new Map(), roleLeds: { power: [], tx: [], rx: [], charge: [] }, rgb: [], matrix: [], latest: null };
    const lastStates = new Map();
    let lastAnalog = [];
    let lastFrame = 0;
    shared.latest = function latest(p) {
      return {
        state: p.tele != null ? lastStates.get(p.tele) : null,
        analog: p.analogIndex != null ? lastAnalog[p.analogIndex] : undefined,
        history: p.tele != null ? shared.history.get(p.tele) : null,
        fresh: Date.now() - lastFrame < 1500
      };
    };
    if (opt.mode === 'both') {
      const wrap = document.createElement('div');
      wrap.className = 'bv-pair';
      host.appendChild(wrap);
      // side by side when there is room across, else one above the other
      const T = viewTransform(def, opt.face, opt.rot);
      const r = host.clientWidth / Math.max(1, host.clientHeight);
      wrap.style.flexDirection = r > (2 * T.vw) / T.vh * 0.8 ? 'row' : 'column';
      for (const mode of ['drawn', 'image']) {
        const cell = document.createElement('div');
        cell.className = 'bv-cell';
        wrap.appendChild(cell);
        drawView(cell, def, { ...opt, mode }, shared, onHover);
      }
    } else drawView(host, def, opt, shared, onHover);

    // b = 0..1 light output. What the eye sees is brighter than the duty
    // cycle at low PWM, so the glow follows a square-root curve.
    function setLed(led, b) {
      const glow = led.querySelector('.led-glow');
      if (!glow) return;
      const v = b > 0 ? Math.min(1, Math.sqrt(b)) : 0;
      glow.setAttribute('opacity', v.toFixed(3));
      glow.style.filter = v > 0.05 ? `drop-shadow(0 0 ${(1 + v * 4).toFixed(1)}px ${glow.getAttribute('fill')})` : '';
      led.classList.toggle('lit', v > 0.05);
    }
    const pinDriven = new Map();   // tele → true while telemetry says the pin is an output

    function paint(states, analog, extra) {
      lastFrame = Date.now();
      lastAnalog = analog || [];
      for (const s of states) {
        lastStates.set(s.pin, s);
        const els = shared.pads.get(s.pin);
        const cls = 'pin-pad mode-' + s.mode + ' level-' + s.level;
        if (els) for (const e of els) e.setAttribute('class', cls);
        const leds = shared.leds.get(s.pin);
        if (leds) for (const led of leds) {
          const b = ledLevel(s, !!led.dataset.invert);
          // a role LED on a pin (Leonardo TX/RX) follows the pin while the
          // sketch's core drives it, and the serial blinks otherwise
          if (led.dataset.role) { pinDriven.set(s.pin, b != null); if (b == null) continue; }
          setLed(led, b || 0);
        }
        const h = shared.history.get(s.pin);
        if (h) {
          h.ring[h.i] = s.mode === 'pwm' ? 2 : s.level;
          h.i = (h.i + 1) % HISTORY;
          h.n = Math.min(h.n + 1, HISTORY);
        }
      }
      if (extra && extra.neopixel) paintRgb(extra.neopixel);
      if (extra && extra.matrix) paintMatrix(extra.matrix);
    }
    function paintRgb(np) {
      for (const led of shared.rgb) {
        const c = np.pin === Number(led.dataset.rgb) ? np.colors[0] : null;
        const glow = led.querySelector('.led-glow');
        if (c == null) { glow.setAttribute('opacity', '0'); glow.style.filter = ''; continue; }
        const r = (c >> 16) & 255, gg = (c >> 8) & 255, b = c & 255, m = Math.max(r, gg, b);
        if (!m) { glow.setAttribute('opacity', '0'); glow.style.filter = ''; continue; }
        // hue from the ratio, light from the strongest channel
        const hex = '#' + [r, gg, b].map((v) => Math.round((v / m) * 255).toString(16).padStart(2, '0')).join('');
        glow.setAttribute('fill', hex);
        const v = Math.min(1, Math.sqrt(m / 255));
        glow.setAttribute('opacity', v.toFixed(3));
        glow.style.filter = `drop-shadow(0 0 ${(1 + v * 5).toFixed(1)}px ${hex})`;
      }
    }
    function paintMatrix(bytes) {
      for (let i = 0; i < shared.matrix.length; i++) {
        const on = !!(bytes[i >> 3] & (1 << (i & 7)));
        for (const px of shared.matrix[i] || []) px.setAttribute('opacity', on ? '1' : '0');
      }
    }

    function markStale() {
      host.querySelectorAll('.pin-pad:not(.stale)').forEach((e) => e.classList.add('stale'));
    }

    // power LEDs follow the board having power (plugged in, streaming, or
    // the simulator running); the charge LED follows the battery setting
    let powered = false, chgTimer = null;
    function powerOn(on) {
      const was = powered;
      powered = !!on;
      shared.roleLeds.power.forEach((l) => setLed(l, on ? 1 : 0));
      // no power, no light: every LED on the board goes dark
      if (!on) {
        shared.roleLeds.tx.concat(shared.roleLeds.rx).forEach((l) => setLed(l, 0));
        for (const list of shared.leds.values()) list.forEach((l) => setLed(l, 0));
        shared.rgb.forEach((l) => { const g = l.querySelector('.led-glow'); g.setAttribute('opacity', '0'); g.style.filter = ''; });
        shared.matrix.forEach((list) => (list || []).forEach((px) => px.setAttribute('opacity', '0')));
      }
      if (was !== powered) setBattery(opt.battery);
    }
    // battery: 'none' (Adafruit: the CHG LED may flicker with no battery),
    // 'charging' (steady) or 'full' (off). Only on USB power.
    function setBattery(state) {
      opt.battery = state || 'none';
      clearInterval(chgTimer); chgTimer = null;
      const leds = shared.roleLeds.charge;
      if (!leds.length) return;
      if (!powered || opt.battery === 'full') return leds.forEach((l) => setLed(l, 0));
      if (opt.battery === 'charging') return leds.forEach((l) => setLed(l, 1));
      let k = 0;
      chgTimer = setInterval(() => { k++; leds.forEach((l) => setLed(l, (k * 7919) % 5 < 2 ? 0.7 : 0.1)); }, 140);
    }
    const flashTimers = {};
    function flash(role) {
      const leds = (shared.roleLeds[role] || []).filter((l) => !pinDriven.get(Number(l.getAttribute('data-tele'))));
      if (!leds.length) return;
      leds.forEach((l) => setLed(l, 1));
      clearTimeout(flashTimers[role]);
      flashTimers[role] = setTimeout(() => leds.forEach((l) => setLed(l, 0)), 60);
    }
    function destroy() { clearInterval(chgTimer); }

    return { paint, markStale, latest: shared.latest, def, powerOn, flash, setBattery, destroy, opts: opt, hasCharge: shared.roleLeds.charge.length > 0 };
  }

  // light from one LED given its pin's state: an output drives it (LOW lights
  // an active-low LED), PWM dims it by duty, an input leaves it dark except
  // for the faint glow a pull-up leaks through an active-high LED. null when
  // the pin isn't driven at all (so a role LED keeps its serial blinks).
  function ledLevel(s, invert) {
    if (!s) return null;
    if (s.mode === 'pwm') { const d = Math.max(0, Math.min(1, (s.pwm || 0) / 255)); return invert ? 1 - d : d; }
    if (s.mode === 'out') return invert ? (s.level ? 0 : 1) : (s.level ? 1 : 0);
    if (s.mode === 'in' && s.pull === 'up' && !invert) return 0.02;
    return invert ? null : 0;
  }

  return { create, viewTransform, ledLevel };
})();
