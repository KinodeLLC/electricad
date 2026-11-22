// Live board renderer. Draws a board def as SVG once, then paints pin pads
// in place on every telemetry frame — no re-layout, just class/attr swaps.
// Also keeps a short history ring per pin for the inspector sparkline and
// feeds the timeline recorder.
window.PinodeBoard = (function () {
  const NS = 'http://www.w3.org/2000/svg';
  const HISTORY = 240; // frames kept per pin (~12s at 20Hz)

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  }

  function create(host, def, onHover) {
    host.innerHTML = '';
    const svg = el('svg', { viewBox: `0 0 ${def.w} ${def.h}` }, host);
    el('rect', { x: 1, y: 1, width: def.w - 2, height: def.h - 2, rx: 8,
                 class: 'pcb' + (def.id === 'pi' ? ' pi' : '') }, svg);
    el('text', { x: 8, y: def.h - 8, class: 'board-title' }, svg).textContent = def.name.toUpperCase();

    for (const d of def.decor || []) {
      if (d.kind === 'usb' || d.kind === 'jack') {
        el('rect', { x: d.x, y: d.y, width: d.w, height: d.h, rx: 3, class: 'usb' }, svg);
      } else if (d.kind === 'chip') {
        el('rect', { x: d.x, y: d.y, width: d.w, height: d.h, rx: 2, class: 'chip-body' }, svg);
        const t = el('text', { x: d.x + d.w / 2, y: d.y + d.h / 2 + 2, class: 'pin-label',
                               'text-anchor': 'middle' }, svg);
        t.textContent = d.label || '';
      } else if (d.kind === 'led') {
        const led = el('circle', { cx: d.x, cy: d.y, r: 4, class: 'pin-pad mode-out level-0' }, svg);
        led.dataset.led = '1';
        led.dataset.color = d.color || '#3fd07a';
        if (d.tele != null) led.setAttribute('data-tele', d.tele);
        if (d.role) led.dataset.role = d.role;
        if (d.invert) led.dataset.invert = '1';
        const t = el('text', { x: d.x, y: d.y + 11, class: 'pin-label', 'text-anchor': 'middle' }, svg);
        t.textContent = d.label || '';
      }
    }

    const pads = new Map(); // tele -> [elements]
    const history = new Map(); // tele -> Uint8Array ring
    for (const p of def.pins) {
      const pad = el('rect', {
        x: p.x - 4, y: p.y - 4, width: 8, height: 8, rx: 1.5,
        class: 'pin-pad ' + (p.tele == null ? 'stale' : 'mode-in level-0')
      }, svg);
      if (p.power === 'gnd') pad.style.fill = '#1c1c1c';
      if (p.power === 'v5' || p.power === 'vin') pad.style.fill = '#5c1e1e';
      if (p.power === 'v33') pad.style.fill = '#5c3a1e';
      const lbl = el('text', {
        x: p.side === 'right' ? p.x + 7 : (p.side === 'left' ? p.x - 7 : p.x),
        y: p.side === 'top' ? p.y + 12 : (p.side === 'bottom' ? p.y - 8 : p.y + 2),
        class: 'pin-label',
        'text-anchor': p.side === 'left' ? 'end' : (p.side === 'right' ? 'start' : 'middle')
      }, svg);
      lbl.textContent = p.label;
      pad.addEventListener('mouseenter', () => onHover && onHover(p, latest(p)));
      if (p.tele != null) {
        if (!pads.has(p.tele)) pads.set(p.tele, []);
        pads.get(p.tele).push(pad);
        if (!history.has(p.tele)) history.set(p.tele, { ring: new Uint8Array(HISTORY), i: 0, n: 0 });
      }
    }
    // led decor pads with a pin join the pad map; role leds are driven directly
    const roleLeds = { power: [], tx: [], rx: [] };
    svg.querySelectorAll('[data-led]').forEach((led) => {
      if (led.dataset.role) { (roleLeds[led.dataset.role] || []).push(led); return; }
      const t = Number(led.getAttribute('data-tele'));
      if (!pads.has(t)) pads.set(t, []);
      pads.get(t).push(led);
    });
    function setLed(led, on) {
      const c = led.dataset.color;
      led.style.fill = on ? c : '#2a2a2a';
      led.style.filter = on ? `drop-shadow(0 0 5px ${c})` : '';
    }

    let lastStates = new Map();
    let lastAnalog = [];
    let lastFrame = 0;

    function latest(p) {
      return {
        state: p.tele != null ? lastStates.get(p.tele) : null,
        analog: p.analogIndex != null ? lastAnalog[p.analogIndex] : undefined,
        history: p.tele != null ? history.get(p.tele) : null,
        fresh: Date.now() - lastFrame < 1500
      };
    }

    function paint(states, analog) {
      lastFrame = Date.now();
      lastAnalog = analog || [];
      for (const s of states) {
        lastStates.set(s.pin, s);
        const els = pads.get(s.pin);
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
        const h = history.get(s.pin);
        if (h) {
          h.ring[h.i] = s.mode === 'pwm' ? 2 : s.level;
          h.i = (h.i + 1) % HISTORY;
          h.n = Math.min(h.n + 1, HISTORY);
        }
      }
    }

    function markStale() {
      svg.querySelectorAll('.pin-pad:not(.stale)').forEach((e) => {
        if (!e.style.fill) e.classList.add('stale');
      });
      roleLeds.power.forEach((l) => setLed(l, false)); // board went dark
    }

    // power LED follows telemetry liveness; tx/rx flash on real serial bytes
    function powerOn(on) { roleLeds.power.forEach((l) => setLed(l, on)); }
    const flashTimers = {};
    function flash(role) {
      const leds = roleLeds[role] || [];
      leds.forEach((l) => setLed(l, true));
      clearTimeout(flashTimers[role]);
      flashTimers[role] = setTimeout(() => leds.forEach((l) => setLed(l, false)), 90);
    }

    return { paint, markStale, latest, def, powerOn, flash };
  }

  return { create };
})();
