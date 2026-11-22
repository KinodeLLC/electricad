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
          el('rect', { x: d.x, y: d.y, width: d.w, height: d.h, rx: 1.5, class: 'chip-body' + cls,
            transform: d.rot45 ? `rotate(45 ${cx} ${cy})` : '' }, draw);
        }
      }
    }
    // LEDs light up in every mode; on the back they are hidden by the board
    if (!T.back && (showDrawing || opt.mode === 'image')) {
      for (const d of def.decor || []) {
        if (d.kind !== 'led') continue;
        const led = el('circle', { cx: d.x, cy: d.y, r: def.unitsPerMm ? 3.4 : 4, class: 'pin-pad mode-out level-0 led' }, g);
        led.dataset.led = '1';
        led.dataset.color = d.color || '#3fd07a';
        if (d.tele != null) led.setAttribute('data-tele', d.tele);
        if (d.role) led.dataset.role = d.role;
        if (d.invert) led.dataset.invert = '1';
      }
    }

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
        if (d.kind === 'chip' && d.label) {
          const [x, y] = T.pt(d.x + d.w / 2, d.y + d.h / 2);
          text(x, y + 2, d.label, 'pin-label' + (d.small ? ' small' : ''));
        } else if (d.kind === 'led' && d.label) {
          const [x, y] = T.pt(d.x, d.y);
          text(x, y + (def.unitsPerMm ? 9.5 : 11), d.label, 'pin-label');
        }
      }
    }
    if (showDrawing && def.name) {
      const t = el('text', { x: 8, y: T.vh - 8, class: 'board-title' }, labels);
      t.textContent = (opt.title || def.name).toUpperCase() + (T.back ? ' (BACK)' : '');
      // narrow boards (the Nanos) get a smaller title so it stays on the board
      const fit = (T.vw - 16) / (t.textContent.length * 0.78);
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
    // led decor with a pin joins the pad map; role leds are driven directly
    svg.querySelectorAll('[data-led]').forEach((led) => {
      if (led.dataset.role) { (shared.roleLeds[led.dataset.role] || []).push(led); return; }
      const t = Number(led.getAttribute('data-tele'));
      if (!shared.pads.has(t)) shared.pads.set(t, []);
      shared.pads.get(t).push(led);
    });
    return svg;
  }

  function create(host, def, onHover, opts) {
    const opt = Object.assign({ mode: 'drawn', face: 'front', rot: 0, image: null, opacity: 0.5 }, opts || {});
    if (opt.mode !== 'drawn' && !opt.image) opt.mode = 'drawn';
    host.innerHTML = '';
    const shared = { pads: new Map(), history: new Map(), roleLeds: { power: [], tx: [], rx: [] }, latest: null };
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

    function setLed(led, on) {
      const c = led.dataset.color;
      led.style.fill = on ? c : '#2a2a2a';
      led.style.filter = on ? `drop-shadow(0 0 5px ${c})` : '';
    }

    function paint(states, analog) {
      lastFrame = Date.now();
      lastAnalog = analog || [];
      for (const s of states) {
        lastStates.set(s.pin, s);
        const els = shared.pads.get(s.pin);
        if (!els) continue;
        const cls = 'pin-pad mode-' + s.mode + ' level-' + s.level;
        for (const e of els) {
          if (e.dataset.led) {
            // faithful behavior: LED is lit when its pin drives it —
            // active-high normally, active-low where the real board inverts
            // (NodeMCU's blue LED). PWM = proportionally dim glow.
            const lit = e.dataset.invert
              ? (s.mode !== 'in' && !s.level)
              : (s.level === 1 || s.mode === 'pwm');
            const c = e.dataset.color;
            e.style.fill = lit ? c : '#2a2a2a';
            const glow = s.mode === 'pwm' ? Math.max(1, ((s.pwm || 0) / 255) * 6) : 5;
            e.style.filter = lit ? `drop-shadow(0 0 ${glow}px ${c})` : '';
          } else {
            e.setAttribute('class', cls);
          }
        }
        const h = shared.history.get(s.pin);
        if (h) {
          h.ring[h.i] = s.mode === 'pwm' ? 2 : s.level;
          h.i = (h.i + 1) % HISTORY;
          h.n = Math.min(h.n + 1, HISTORY);
        }
      }
    }

    function markStale() {
      host.querySelectorAll('.pin-pad:not(.stale)').forEach((e) => {
        if (!e.style.fill) e.classList.add('stale');
      });
      shared.roleLeds.power.forEach((l) => setLed(l, false)); // board went dark
    }

    // power LED follows telemetry liveness; tx/rx flash on real serial bytes
    function powerOn(on) { shared.roleLeds.power.forEach((l) => setLed(l, on)); }
    const flashTimers = {};
    function flash(role) {
      const leds = shared.roleLeds[role] || [];
      leds.forEach((l) => setLed(l, true));
      clearTimeout(flashTimers[role]);
      flashTimers[role] = setTimeout(() => leds.forEach((l) => setLed(l, false)), 90);
    }

    return { paint, markStale, latest: shared.latest, def, powerOn, flash, opts: opt };
  }

  return { create, viewTransform };
})();
