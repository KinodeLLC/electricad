// A board you can spin: built only from what the 2D view already knows for
// certain. The outline, holes and every part's position and footprint come
// from the makers' design files (boardparts.js, boards.js); the top and back
// faces are the drawn view itself (silkscreen, pads, markings, live pins),
// painted onto the board. Part heights are the package's standard height
// (an 0603 resistor is 0.45 mm, a female header 8.5 mm), not measured from
// each board. Boards without design-file geometry stay flat (front and back).
window.PinodeBoard3D = (function () {
  const B2 = () => window.PinodeBoard;
  let threeLoading = null;
  // three.js is only loaded the first time someone opens the 3D view
  function loadThree() {
    if (window.THREE) return Promise.resolve(window.THREE);
    if (threeLoading) return threeLoading;
    threeLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '../node_modules/three/build/three.min.js';
      // the editor's AMD loader would swallow three.js as a module: hide it while three loads
      const amd = window.define;
      window.define = undefined;
      const done = () => { window.define = amd; };
      s.onload = () => { done(); window.THREE ? resolve(window.THREE) : reject(new Error('three.js did not load')); };
      s.onerror = () => { done(); threeLoading = null; reject(new Error('three.js is missing')); };
      document.head.appendChild(s);
    });
    return threeLoading;
  }
  function supported(def) { return !!(def && def.geo && def.geo.w && def.unitsPerMm && def.toUnits); }

  // ---- standard package heights (mm) ---------------------------------------------
  function partHeight(c) {
    const pk = (c.pkg || '') + ' ' + (c.mpn || '') + ' ' + (c.desc || '');
    switch (c.kind) {
      case 'ic':
        if (/P?DIP|DIL/i.test(pk)) return 3.8;
        if (/QFN|MLF|DFN|LGA|WLCSP|VQFN/i.test(pk)) return 0.9;
        if (/TQFP|LQFP|QFP/i.test(pk)) return 1.2;
        if (/TSSOP|MSOP|SSOP|TSOT/i.test(pk)) return 1.1;
        if (/SOIC|SO-?\d|SOP|SO\b/i.test(pk)) return 1.6;
        if (/SOT|SC-?70|SC70/i.test(pk)) return 1.1;
        return 1.2;
      case 'module': return /MINI/i.test(pk) ? 2.4 : 3.1;
      case 'cap': return /0402/.test(pk) ? 0.5 : /0805/.test(pk) ? 1.25 : /1206|1210/.test(pk) ? 1.6 : 0.8;
      case 'res': case 'rarray': return /0402/.test(pk) ? 0.35 : 0.5;
      case 'ecap': {
        const m = /PANASONIC_?([B-H])/i.exec(pk);
        if (m) return { B: 5.4, C: 5.4, D: 5.8, E: 5.8, F: 7.7, G: 10, H: 13.5 }[m[1].toUpperCase()] || 5.8;
        return 1.8;   // tantalum
      }
      case 'led': return 0.8;
      case 'rgb': return /2020/.test(pk) ? 0.9 : /3535/.test(pk) ? 1.6 : 1.6;
      case 'xtal': return /HC-?49/i.test(pk) ? 3.5 : /CSTCE|RESONATOR/i.test(pk) ? 1.2 : 0.9;
      case 'diode': return /SMA|DO-?214|SMB/i.test(pk) ? 2.3 : 1.1;
      case 'tvs': case 'fet': return 1.1;
      case 'fuse': return 0.9;
      case 'ferrite': return 0.8;
      case 'ind': return /CD54|CDRH|SRN|SRR|12\d\d|10\d\d/i.test(pk) ? 4.5 : 1.2;
      case 'conn': return /SM0\dB|SRSS/i.test(pk) ? 4.25 : /^JST[-_ ]?PH/i.test(c.pkg || '') ? 6 : 0;   // pin headers come from headerBoxes
      default: return 0;
    }
  }
  const BODY = { ic: 0x1b1b1d, module: 0xc8ccd2, cap: 0xb08a64, res: 0x141414, rarray: 0x141414, ecap: 0xc9ccd0, led: 0xe8e8e0,
    rgb: 0xf0f0f0, xtal: 0xd6d8dc, diode: 0x1a1a1a, tvs: 0x1a1a1a, fet: 0x1a1a1a, fuse: 0x2a2a2a, ferrite: 0x2a2a2a, ind: 0x2b2b2b, conn: 0xf2efe6 };

  // ---- the drawn view as a picture ----------------------------------------------
  const STYLE_PROPS = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'opacity', 'display',
    'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'letter-spacing', 'white-space'];
  const dataUrls = new Map();
  function toDataUrl(src) {
    if (dataUrls.has(src)) return dataUrls.get(src);
    const p = new Promise((resolve) => {
      const im = new Image();
      im.onload = () => {
        const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
        c.getContext('2d').drawImage(im, 0, 0);
        try { resolve(c.toDataURL('image/png')); } catch (e) { resolve(''); }
      };
      im.onerror = () => resolve('');
      im.src = src;
    });
    dataUrls.set(src, p);
    return p;
  }
  // copy the computed look of every element into the clone, so the SVG draws
  // the same outside the page (as an <img>, then onto a canvas)
  async function svgToCanvas(svg, canvas) {
    const clone = svg.cloneNode(true);
    const a = svg.querySelectorAll('*'), b = clone.querySelectorAll('*');
    for (let i = 0; i < a.length; i++) {
      const cs = getComputedStyle(a[i]);
      let st = '';
      for (const k of STYLE_PROPS) { const v = cs.getPropertyValue(k); if (v) st += k + ':' + v + ';'; }
      b[i].setAttribute('style', st);
      if (b[i].tagName === 'image') {
        const href = a[i].getAttribute('href');
        if (href && !/^data:/.test(href)) b[i].setAttribute('href', await toDataUrl(href));
      }
    }
    // board parts the 2D view only shows on hover stay hidden
    clone.querySelectorAll('.bv-hits, .bv-labels').forEach((n) => n.remove());
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', canvas.width); clone.setAttribute('height', canvas.height);
    clone.removeAttribute('class');
    const xml = new XMLSerializer().serializeToString(clone);
    const url = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml)));
    await new Promise((resolve) => {
      const im = new Image();
      im.onload = () => { const g = canvas.getContext('2d'); g.clearRect(0, 0, canvas.width, canvas.height); g.drawImage(im, 0, 0, canvas.width, canvas.height); resolve(); };
      im.onerror = () => { console.warn('3D: board picture did not render'); resolve(); };
      im.src = url;
    });
  }

  // ---- the 3D view ----------------------------------------------------------------
  // ── camera ────────────────────────────────────────────────────────────
  // theta: the angle round the board from +x; phi: from straight above.
  // "Front" looks at the edge nearest you in the Top view (the -y edge), as
  // CAD tools do; Bottom turns the board over sideways like the 2D back face.
  const ISO_PHI = Math.acos(1 / Math.sqrt(3));
  const PRESETS = {
    home:   { theta: -Math.PI / 2 - 0.5, phi: 0.85 },
    iso:    { theta: -Math.PI * 3 / 4, phi: ISO_PHI },
    top:    { theta: -Math.PI / 2, phi: 0 },
    bottom: { theta: Math.PI / 2, phi: Math.PI },
    front:  { theta: -Math.PI / 2, phi: Math.PI / 2 },
    back:   { theta: Math.PI / 2, phi: Math.PI / 2 },
    left:   { theta: Math.PI, phi: Math.PI / 2 },
    right:  { theta: 0, phi: Math.PI / 2 }
  };
  const PHI_MIN = 0.0005, PHI_MAX = Math.PI - 0.0005;
  const clampPhi = (p) => Math.max(PHI_MIN, Math.min(PHI_MAX, p));
  // the same direction, reached the short way round from where we are
  const nearestAngle = (cur, goal) => goal + 2 * Math.PI * Math.round((cur - goal) / (2 * Math.PI));
  // frame-rate independent easing toward the goal
  const ease = (dt, rate) => 1 - Math.exp(-dt * rate);
  // camera up: the direction of increasing phi reversed, so it never flips
  const upFor = (theta, phi) => [-Math.cos(phi) * Math.cos(theta), -Math.cos(phi) * Math.sin(theta), Math.sin(phi)];

  const VIEW_ICON = { home: '⌂', iso: '◇', top: '▣', bottom: '▢', front: '▭', back: '▭', left: '▯', right: '▯' };
  const VIEW_BTNS = [
    ['home', 'Home', 'H', 'Back to the starting view'],
    ['iso', 'Iso', '0', 'Isometric view from the front left corner'],
    ['top', 'Top', '5', 'Look straight down at the top'],
    ['bottom', 'Bottom', '6', 'Turn the board over to see the bottom'],
    ['front', 'Front', '1', 'Look at the front edge'],
    ['back', 'Back', '2', 'Look at the back edge'],
    ['left', 'Left', '3', 'Look at the left edge'],
    ['right', 'Right', '4', 'Look at the right edge']
  ];
  const PAD_BTNS = [
    ['spinL', '⟲', 'Left', 'Spin left (← or A, hold to keep going)'],
    ['tiltU', '▲', 'Up', 'Tilt up (↑ or W)'],
    ['spinR', '⟳', 'Right', 'Spin right (→ or D)'],
    ['zoomIn', '＋', 'Zoom', 'Zoom in (+ or wheel)'],
    ['tiltD', '▼', 'Down', 'Tilt down (↓ or S)'],
    ['zoomOut', '－', 'Zoom', 'Zoom out (− or wheel)'],
    ['fit', '⤢', 'Fit', 'Fit the whole board in view (F, or double-click)'],
    ['spin', '↻', 'Auto', 'Auto-spin on or off (Space)'],
    ['help', '?', 'Keys', 'All mouse, touchpad and keyboard controls (?)']
  ];
  const HELP = [
    ['Mouse', [['Left drag', 'Spin and tilt'], ['Right drag', 'Move (pan)'], ['Shift + drag', 'Move (pan)'], ['Wheel', 'Zoom at the pointer'], ['Double-click', 'Fit the board'], ['Click a part', 'Open its card']]],
    ['Touchpad', [['Click + drag', 'Spin and tilt'], ['Pinch', 'Zoom'], ['Two-finger swipe sideways', 'Spin'], ['Two-finger swipe up/down', 'Zoom']]],
    ['Touch', [['One finger', 'Spin and tilt'], ['Two fingers', 'Pinch to zoom, drag to move']]],
    ['Keyboard (click the view first)', [['← → or A D', 'Spin'], ['↑ ↓ or W S', 'Tilt'], ['Shift + arrows', 'Move (pan)'], ['+ −  or PgUp PgDn', 'Zoom'], ['1 2 3 4', 'Front, Back, Left, Right'], ['5 6 0', 'Top, Bottom, Iso'], ['H / Home', 'Home view'], ['F', 'Fit'], ['Space', 'Auto-spin'], ['?', 'This list'], ['Esc', 'Close this list']]]
  ];

  function create(host, def, opts) {
    const opt = Object.assign({}, opts || {});
    host.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'b3d';
    host.appendChild(wrap);
    const note = document.createElement('div');
    note.className = 'b3d-note';
    note.textContent = 'Loading 3D…';
    wrap.appendChild(note);
    const bar = document.createElement('div');
    bar.className = 'b3d-bar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', '3D views');
    bar.innerHTML = VIEW_BTNS.map(([v, label, key, tip]) =>
      `<button class="b3d-btn" data-v="${v}" title="${tip} (${key})" aria-label="${label} view (${key})"><span class="b3d-ic">${VIEW_ICON[v]}</span><span>${label}</span></button>`).join('');
    wrap.appendChild(bar);
    const pad = document.createElement('div');
    pad.className = 'b3d-pad';
    pad.setAttribute('role', 'toolbar');
    pad.setAttribute('aria-label', '3D movement');
    pad.innerHTML = PAD_BTNS.map(([a, ic, label, tip]) =>
      `<button class="b3d-btn${a === 'spin' ? ' b3d-spin' : ''}" data-a="${a}" title="${tip}" aria-label="${tip}"${a === 'spin' ? ' aria-pressed="false"' : ''}><span class="b3d-ic">${ic}</span><span>${label}</span></button>`).join('');
    wrap.appendChild(pad);
    const help = document.createElement('div');
    help.className = 'b3d-help';
    help.hidden = true;
    help.innerHTML = '<div class="b3d-help-h"><b>3D controls</b><button class="b3d-btn" data-a="help" title="Close (Esc)" aria-label="Close">✕</button></div>' +
      HELP.map(([h, rows]) => `<div class="b3d-help-g">${h}</div>` + rows.map(([k, v]) => `<div class="b3d-help-r"><kbd>${k}</kbd><span>${v}</span></div>`).join('')).join('');
    wrap.appendChild(help);

    // two hidden 2D boards (front and back) keep the live state; the 3D
    // faces are pictures of them, refreshed when they change
    const off = document.createElement('div');
    off.className = 'b3d-offscreen';
    document.body.appendChild(off);
    const hostF = document.createElement('div'), hostB = document.createElement('div');
    off.append(hostF, hostB);
    const common = { mode: 'drawn', rot: 0, battery: opt.battery, parts: opt.parts, silk: opt.silk, title: opt.title };
    const front = B2().create(hostF, def, null, { ...common, face: 'front' });
    const back = B2().create(hostB, def, null, { ...common, face: 'back' });
    const both = [front, back];

    const U = def.unitsPerMm, g0 = def.geo, M = g0.margin || 10;
    const scale = Math.min(5, 4096 / Math.max(def.w, def.h));
    const cvF = document.createElement('canvas'), cvB = document.createElement('canvas');
    for (const c of [cvF, cvB]) { c.width = Math.round(def.w * scale); c.height = Math.round(def.h * scale); }
    // board mm → texture uv (front picture; the back picture is mirrored)
    const uvF = (x, y) => { const [ux, uy] = def.toUnits(x, y); return [ux / def.w, 1 - uy / def.h]; };
    const uvB = (x, y) => { const [ux, uy] = def.toUnits(x, y); return [1 - ux / def.w, 1 - uy / def.h]; };

    let THREE, renderer, scene, camera, texF, texB, raf = 0, dead = false, dirty = true;
    const goal = { theta: PRESETS.home.theta, phi: PRESETS.home.phi, dist: 0, tx: 0, ty: 0, tz: 0 };
    const cur = Object.assign({}, goal);
    const vel = { t: 0, p: 0 };
    const T3 = 1.6;   // board thickness, mm
    let bounds = null, box = null, fitted = true, spin = false;
    const reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    try { spin = localStorage.getItem('ec.b3d.autospin') === '1'; } catch (e) { /* storage off */ }
    const parts = (opt.parts || []).filter((c) => c.box);
    const pickables = [];

    function pcbShape() {
      // the Nanos have no outline in the files we use: their board is the plain rectangle
      const ol = g0.outline || [[0, 0], [g0.w, 0], [g0.w, g0.h], [0, g0.h]];
      const pts = ol.map(([x, y]) => new THREE.Vector2(x, y));
      const sh = new THREE.Shape(pts);
      for (const [x, y, d] of g0.holes || []) { const h = new THREE.Path(); h.absarc(x, y, d / 2, 0, Math.PI * 2, true); sh.holes.push(h); }
      return sh;
    }
    // uvs from world x/y for a face that looks straight up or down
    function mapUv(geom, fn) {
      const pos = geom.attributes.position, uv = new Float32Array(pos.count * 2);
      for (let i = 0; i < pos.count; i++) { const [u, v] = fn(pos.getX(i), pos.getY(i)); uv[2 * i] = u; uv[2 * i + 1] = v; }
      geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      return geom;
    }
    // a solid body with its top (or bottom) painted from the board picture
    function body(rect, z0, h, color, opts2) {
      const o = opts2 || {};
      const w = rect.x2 - rect.x1, d = rect.y2 - rect.y1, cx = (rect.x1 + rect.x2) / 2, cy = (rect.y1 + rect.y2) / 2;
      const grp = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color, roughness: o.metal ? 0.35 : 0.7, metalness: o.metal ? 0.6 : 0.05 });
      let g;
      if (o.round) g = new THREE.CylinderGeometry(Math.min(w, d) / 2, Math.min(w, d) / 2, h, 40).rotateX(Math.PI / 2);
      else g = new THREE.BoxGeometry(w, d, h);
      if (o.rot) g.rotateZ(o.rot);
      const m = new THREE.Mesh(g, mat);
      m.position.set(cx, cy, z0 + (o.down ? -h / 2 : h / 2));
      grp.add(m);
      if (o.cap !== false) {
        const cg = o.round ? new THREE.CircleGeometry(Math.min(w, d) / 2 * 0.98, 40) : new THREE.PlaneGeometry(w * 0.999, d * 0.999);
        if (o.rot) cg.rotateZ(o.rot);
        cg.translate(cx, cy, 0);
        const down = !!o.down;
        if (down) cg.rotateY(Math.PI).translate(2 * cx, 0, 0);
        mapUv(cg, down ? uvB : uvF);
        const cm = new THREE.Mesh(cg, new THREE.MeshStandardMaterial({ map: down ? texB : texF, roughness: 0.6, transparent: true }));
        cm.position.z = down ? z0 - h - 0.01 : z0 + h + 0.01;
        grp.add(cm);
      }
      scene.add(grp);
      return m;
    }
    const decorMm = (d) => {
      // decor boxes are in drawing units: back to board mm
      const p = (X, Y) => (g0.portrait ? [(Y - M) / U, (X - M) / U] : [(X - M) / U, g0.h - (Y - M) / U]);
      const [ax, ay] = p(d.x, d.y), [bx, by] = p(d.x + d.w, d.y + d.h);
      return { x1: Math.min(ax, bx), y1: Math.min(ay, by), x2: Math.max(ax, bx), y2: Math.max(ay, by) };
    };

    function build() {
      scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight(0xffffff, 0x404048, 1.6));
      const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(-60, -80, 160); scene.add(sun);
      const fill = new THREE.DirectionalLight(0xffffff, 0.6); fill.position.set(80, 60, -120); scene.add(fill);
      texF = new THREE.CanvasTexture(cvF); texB = new THREE.CanvasTexture(cvB);
      for (const t of [texF, texB]) { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; }
      const T = 1.6;
      const sh = pcbShape();
      const mask = new THREE.Color(def.mask || '#1d3a28');
      // sides: the FR4 edge with mask on it
      const ex = new THREE.ExtrudeGeometry(sh, { depth: T, bevelEnabled: false, curveSegments: 24 });
      scene.add(new THREE.Mesh(ex, [new THREE.MeshBasicMaterial({ visible: false }), new THREE.MeshStandardMaterial({ color: mask.clone().multiplyScalar(0.7), roughness: 0.8 })]));
      const top = mapUv(new THREE.ShapeGeometry(sh, 24), uvF);
      const tm = new THREE.Mesh(top, new THREE.MeshStandardMaterial({ map: texF, roughness: 0.55, metalness: 0.05 }));
      tm.position.z = T + 0.005; tm.userData.face = 'top'; scene.add(tm);
      const bot = mapUv(new THREE.ShapeGeometry(sh, 24), uvB);
      const bm = new THREE.Mesh(bot, new THREE.MeshStandardMaterial({ map: texB, roughness: 0.55, metalness: 0.05, side: THREE.BackSide }));
      bm.position.z = -0.005; bm.userData.face = 'bottom'; scene.add(bm);

      // solder joints from the design files: through-hole joints on both faces
      // (except the header pins, which the painted faces draw with their live
      // state) and the pads of parts on the bottom
      if (opt.joints && opt.joints.p) {
        const pinAt = (x, y) => (def.pins || []).some((p) => p.at && Math.hypot(p.at[0] - x, p.at[1] - y) < 0.3);
        const tin = new THREE.MeshStandardMaterial({ color: 0xc9cbc6, metalness: 0.75, roughness: 0.32, side: THREE.DoubleSide });
        const groups = { top: [], bottom: [] };
        for (const r of opt.joints.p) {
          if (r[7] === 0 && !pinAt(r[0], r[1])) { groups.top.push(r); groups.bottom.push(r); }
          else if (r[7] === 2) groups.bottom.push(r);
        }
        const disc = new THREE.CircleGeometry(1, 20), sq = new THREE.PlaneGeometry(2, 2);
        for (const [face, rows] of Object.entries(groups)) {
          for (const [geo, list] of [[disc, rows.filter((r) => r[7] === 0)], [sq, rows.filter((r) => r[7] !== 0)]]) {
            if (!list.length) continue;
            const im = new THREE.InstancedMesh(geo, tin, list.length);
            const mx = new THREE.Matrix4();
            list.forEach((r, i) => {
              const rr = r[7] === 0 ? Math.min(r[2], r[3]) * 0.92 : 0;
              mx.makeScale(rr || r[2], rr || r[3], 1).setPosition(r[0], r[1], face === 'top' ? T + 0.015 : -0.015);
              im.setMatrixAt(i, mx);
            });
            im.userData.face = face;
            scene.add(im);
          }
        }
      }
      // parts, at their standard package heights
      for (const c of parts) {
        const h = partHeight(c);
        if (!h || !BODY[c.kind]) continue;
        const r = { x1: c.box[0], y1: c.box[1], x2: c.box[2], y2: c.box[3] };
        const down = (c.side || 'top') === 'bottom';
        const odd = ((c.rot || 0) % 90 + 90) % 90;
        const round = c.kind === 'ecap' && /PANASONIC/i.test(c.pkg || '');
        const m = body(r, down ? 0 : T, h, BODY[c.kind], { down, round, metal: c.kind === 'module' || c.kind === 'xtal' || round, rot: odd ? ((g0.portrait ? 1 : -1) * odd * Math.PI) / 180 : 0 });
        // the body and its painted cap both answer for the part
        for (const ch of m.parent.children) ch.userData.part = c;
        pickables.push(m);
      }
      // the headers the board ships with
      for (const b of B2().headerBoxes ? B2().headerBoxes(def, opt.parts) : []) {
        if (!def.headers) break;
        const hm = body(b, T, b.male ? 2.5 : 8.5, 0x121213, {});
        for (const ch of hm.parent.children) ch.userData.th = true;   // header plastic: the pin under the pointer
        if (b.male) {
          const posts = b.pinsAt || (def.pins || []).filter((p) => p.at && p.at[0] > b.x1 && p.at[0] < b.x2 && p.at[1] > b.y1 && p.at[1] < b.y2).map((p) => p.at);
          for (const [px, py] of posts) {
            const pm = new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.64, 8.5), new THREE.MeshStandardMaterial({ color: 0xd9b45a, metalness: 0.8, roughness: 0.3 }));
            pm.position.set(px, py, T + 4.25 + 0.5); pm.userData.th = true; scene.add(pm);
          }
        }
      }
      // connectors and the reset button from the board definition
      for (const d of def.decor || []) {
        if (!d.w || !/^(usb|jack|button)$/.test(d.kind)) continue;
        const r = decorMm(d);
        if (d.kind === 'usb') {
          // USB-B is 10.9 mm tall, mini-B 3.9, micro-B 2.7, USB-C 3.2
          const lb = d.label || '', small = Math.min(r.x2 - r.x1, r.y2 - r.y1);
          const h = /C$/.test(lb) ? 3.2 : /micro/i.test(lb) ? 2.7 : def.id === 'nano' ? 3.9 : small >= 10 ? 10.9 : 2.7;
          body(r, T, h, 0xc9ccd2, { metal: true, cap: false });
        } else if (d.kind === 'jack') {
          if (d.label === 'BAT') body(r, T, 6, 0xeee8d5, { cap: false });   // JST PH battery socket
          else body(r, T, 11, 0x161616, { cap: false });                     // barrel jack
        }
        else {
          const w = r.x2 - r.x1;
          body(r, T, w > 4.5 ? 3.1 : 1.5, 0x2a2a2a, { cap: false });
          const cr = Math.min(r.x2 - r.x1, r.y2 - r.y1) * 0.28, cx = (r.x1 + r.x2) / 2, cy = (r.y1 + r.y2) / 2;
          body({ x1: cx - cr, y1: cy - cr, x2: cx + cr, y2: cy + cr }, T + (w > 4.5 ? 3.1 : 1.5), w > 4.5 ? 1.2 : 0.4, 0x9a6b3c, { round: true, cap: false });
        }
      }
      // what "fit" frames: everything on the board, connectors included
      box = new THREE.Box3().setFromObject(scene);
      bounds = box.getBoundingSphere(new THREE.Sphere());
      const c0 = bounds.center;
      goal.tx = cur.tx = c0.x; goal.ty = cur.ty = c0.y; goal.tz = cur.tz = c0.z;
    }

    // goal is where the controls want the camera; cur eases toward it
    // the distance that just frames the board's bounding box from this direction
    function fitDist(theta = goal.theta, phi = goal.phi, center = bounds && bounds.center) {
      const tV = Math.tan((camera.fov * Math.PI) / 360), tH = tV * camera.aspect;
      const up = upFor(theta, phi);
      const back = [Math.sin(phi) * Math.cos(theta), Math.sin(phi) * Math.sin(theta), Math.cos(phi)];
      const right = [up[1] * back[2] - up[2] * back[1], up[2] * back[0] - up[0] * back[2], up[0] * back[1] - up[1] * back[0]];
      let need = 10;
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
        const o = [x - center.x, y - center.y, z - center.z];
        const dot = (v) => v[0] * o[0] + v[1] * o[1] + v[2] * o[2];
        const c = dot(back);
        need = Math.max(need, c + Math.abs(dot(right)) / tH, c + Math.abs(dot(up)) / tV);
      }
      return need * 1.1 + 4;
    }
    function zoomLimits() { const f = fitDist(PRESETS.home.theta, PRESETS.home.phi); return [Math.max(8, f * 0.08), f * 4]; }
    function place() {
      const { theta, phi, dist } = cur;
      camera.position.set(cur.tx + dist * Math.sin(phi) * Math.cos(theta), cur.ty + dist * Math.sin(phi) * Math.sin(theta), cur.tz + dist * Math.cos(phi));
      camera.up.set(...upFor(theta, phi));
      camera.lookAt(cur.tx, cur.ty, cur.tz);
      dirty = true;
    }
    function snap() { Object.assign(cur, goal); place(); }
    function preset(v) {
      const p = PRESETS[v] || PRESETS.home;
      goal.theta = nearestAngle(cur.theta, p.theta);
      goal.phi = clampPhi(p.phi);
      vel.t = vel.p = 0;
      if (v === 'home' || fitted) fit(true);
      if (reduced) snap();
      dirty = true;
    }
    // frame the whole board; recenter too unless only the distance is wanted
    function fit(recenter) {
      fitted = true;
      if (recenter !== false && bounds) { goal.tx = bounds.center.x; goal.ty = bounds.center.y; goal.tz = bounds.center.z; }
      goal.dist = fitDist();
      if (reduced) snap();
      dirty = true;
    }
    function orbit(dt, dp) { goal.theta += dt; goal.phi = clampPhi(goal.phi + dp); dirty = true; }
    function zoom(f, at) {
      const [lo, hi] = zoomLimits();
      const nd = Math.max(lo, Math.min(hi, goal.dist * f));
      const k = nd / goal.dist;
      // keep the point under the pointer still while zooming
      if (at) { goal.tx = at.x + (goal.tx - at.x) * k; goal.ty = at.y + (goal.ty - at.y) * k; goal.tz = at.z + (goal.tz - at.z) * k; }
      goal.dist = nd;
      fitted = false; dirty = true;
    }
    // move the target across the screen by dx, dy pixels
    function pan(dx, dy) {
      const h = Math.max(50, renderer.domElement.clientHeight);
      const per = (2 * goal.dist * Math.tan((camera.fov * Math.PI) / 360)) / h;
      const up = upFor(goal.theta, goal.phi);
      const fwd = [-Math.sin(goal.phi) * Math.cos(goal.theta), -Math.sin(goal.phi) * Math.sin(goal.theta), -Math.cos(goal.phi)];
      const right = [fwd[1] * up[2] - fwd[2] * up[1], fwd[2] * up[0] - fwd[0] * up[2], fwd[0] * up[1] - fwd[1] * up[0]];
      goal.tx += (-dx * right[0] + dy * up[0]) * per;
      goal.ty += (-dx * right[1] + dy * up[1]) * per;
      goal.tz += (-dx * right[2] + dy * up[2]) * per;
      // never lose the board: keep the target near it
      if (bounds) {
        const r = bounds.radius * 1.5, c0 = bounds.center;
        const ox = goal.tx - c0.x, oy = goal.ty - c0.y, oz = goal.tz - c0.z, d = Math.hypot(ox, oy, oz);
        if (d > r) { goal.tx = c0.x + (ox * r) / d; goal.ty = c0.y + (oy * r) / d; goal.tz = c0.z + (oz * r) / d; }
      }
      fitted = false; dirty = true;
    }
    function setSpin(on) {
      spin = !!on;
      const b = pad.querySelector('[data-a="spin"]');
      if (b) { b.classList.toggle('on', spin); b.setAttribute('aria-pressed', String(spin)); }
      try { localStorage.setItem('ec.b3d.autospin', spin ? '1' : '0'); } catch (e) { /* private window */ }
      dirty = true;
    }
    function toggleHelp(show) {
      help.hidden = show == null ? !help.hidden : !show;
      const b = pad.querySelector('[data-a="help"]');
      if (b) b.classList.toggle('on', !help.hidden);
    }
    function size() {
      const w = Math.max(50, wrap.clientWidth), h = Math.max(50, wrap.clientHeight);
      renderer.setSize(w, h, false);
      camera.aspect = w / h; camera.updateProjectionMatrix();
      // until someone zooms or pans, keep the whole board in view
      if (fitted) { goal.dist = fitDist(); if (!cur.dist) cur.dist = goal.dist; }
      dirty = true;
    }

    // held keys and held buttons move at a steady rate; taps nudge
    const RATE = { spin: 1.6, tilt: 1.1, zoom: 1.9, pan: 420 };
    const held = new Set();
    let holdAct = null, holdT = null;
    function act(a, s) {
      // s: seconds of movement (a tap is a fixed nudge)
      if (a === 'spinL') orbit(-RATE.spin * s, 0);
      else if (a === 'spinR') orbit(RATE.spin * s, 0);
      else if (a === 'tiltU') orbit(0, -RATE.tilt * s);
      else if (a === 'tiltD') orbit(0, RATE.tilt * s);
      else if (a === 'zoomIn') zoom(Math.exp(-RATE.zoom * s));
      else if (a === 'zoomOut') zoom(Math.exp(RATE.zoom * s));
      else if (a === 'panL') pan(RATE.pan * s, 0);
      else if (a === 'panR') pan(-RATE.pan * s, 0);
      else if (a === 'panU') pan(0, RATE.pan * s);
      else if (a === 'panD') pan(0, -RATE.pan * s);
    }
    const KEY_ACT = {
      ArrowLeft: 'spinL', a: 'spinL', ArrowRight: 'spinR', d: 'spinR', ArrowUp: 'tiltU', w: 'tiltU', ArrowDown: 'tiltD', s: 'tiltD',
      '+': 'zoomIn', '=': 'zoomIn', PageUp: 'zoomIn', '-': 'zoomOut', '_': 'zoomOut', PageDown: 'zoomOut'
    };
    const PAN_OF = { spinL: 'panL', spinR: 'panR', tiltU: 'panU', tiltD: 'panD' };
    const KEY_VIEW = { 1: 'front', 2: 'back', 3: 'left', 4: 'right', 5: 'top', 6: 'bottom', 0: 'iso', h: 'home', Home: 'home' };
    function heldActs() {
      const out = [];
      for (const k of held) {
        const [key, shift] = k.split('|');
        const a = KEY_ACT[key];
        if (a) out.push(shift === '1' && PAN_OF[a] ? PAN_OF[a] : a);
      }
      if (holdAct) out.push(holdAct);
      return out;
    }

    function step(dt) {
      if (!camera) return false;
      for (const a of heldActs()) act(a, dt);
      if (spin && !drag && !held.size && !holdAct) goal.theta += 0.35 * dt;
      // a flick keeps turning and slows down
      if (!drag && (Math.abs(vel.t) > 1e-4 || Math.abs(vel.p) > 1e-4)) {
        goal.theta += vel.t * dt; goal.phi = clampPhi(goal.phi + vel.p * dt);
        const k = Math.exp(-dt * 4.5); vel.t *= k; vel.p *= k;
      }
      const e = reduced ? 1 : ease(dt, 11);
      let moved = false;
      for (const key of ['theta', 'phi', 'dist', 'tx', 'ty', 'tz']) {
        const d = goal[key] - cur[key];
        const tol = key === 'dist' ? 1e-3 : key[0] === 't' && key.length === 2 ? 1e-4 : 1e-5;
        if (Math.abs(d) > tol) { cur[key] += d * e; moved = true; } else if (d) { cur[key] = goal[key]; moved = true; }
      }
      if (moved) place();
      return moved;
    }
    let last = 0;
    function loop(t) {
      if (dead) return;
      raf = requestAnimationFrame(loop);
      const dt = last ? Math.min(0.05, (t - last) / 1000) : 1 / 60; last = t;
      step(dt);
      if (!dirty) return;
      dirty = false;
      renderer.render(scene, camera);
    }

    // refresh the painted faces when the hidden 2D boards change
    let pending = false, busy = false;
    async function repaint() {
      if (busy) { pending = true; return; }
      busy = true;
      try {
        const sF = hostF.querySelector('svg'), sB = hostB.querySelector('svg');
        if (sF) await svgToCanvas(sF, cvF);
        if (sB) await svgToCanvas(sB, cvB);
        if (texF) { texF.needsUpdate = true; texB.needsUpdate = true; dirty = true; }
      } finally { busy = false; }
      if (pending && !dead) { pending = false; setTimeout(repaint, 120); }
    }
    let repaintT = null;
    const mo = new MutationObserver(() => { if (repaintT) return; repaintT = setTimeout(() => { repaintT = null; repaint(); }, 150); });
    mo.observe(off, { attributes: true, subtree: true, attributeFilter: ['class', 'opacity', 'fill', 'style'] });

    // pointer: drag spins, right/shift drag pans, wheel zooms at the pointer,
    // two fingers pinch and pan, double-click fits, hover shows the part
    let drag = null, hoverPart = null, hoverJoint = null;
    const touches = new Map();
    function ndc(e) {
      const r = renderer.domElement.getBoundingClientRect();
      return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    }
    // what the pointer is really on: the nearest visible surface, so a part
    // on the far face never answers through the board
    const visibleHit = (h) => {
      const m = h.object.material;
      const mat = Array.isArray(m) ? m[h.face ? h.face.materialIndex : 0] : m;
      return mat && mat.visible !== false && h.object.visible !== false;
    };
    const JOINTS = opt.joints && opt.joints.p ? opt.joints : null;
    function jointAt(x, y, face, near) {
      if (!JOINTS) return null;
      let best = null, bd = Infinity;
      for (const r of JOINTS.p) {
        if (face === 'top' ? r[7] === 2 : face === 'bottom' ? r[7] === 1 : r[7] !== 0) continue;
        const dx = Math.abs(x - r[0]), dy = Math.abs(y - r[1]);
        const inside = near ? Math.hypot(dx, dy) < near : dx <= r[2] + 0.12 && dy <= r[3] + 0.12;
        if (!inside) continue;
        const d = Math.hypot(dx, dy);
        if (d < bd) { bd = d; best = r; }
      }
      return best ? { x: best[0], y: best[1], hx: best[2], hy: best[3], ref: best[4], pad: best[5], net: JOINTS.nets[best[6]], kind: best[7], face, row: best } : null;
    }
    function pickAt(e) {
      const rc = new THREE.Raycaster(); rc.setFromCamera(ndc(e), camera);
      const hit = rc.intersectObjects(scene.children, true).find(visibleHit);
      if (!hit || hit.object.userData.noPick) return null;
      const u = hit.object.userData;
      if (u.part) return { part: u.part };
      if (u.face) { const j = jointAt(hit.point.x, hit.point.y, u.face); return j ? { joint: j } : null; }
      if (u.th) { const j = jointAt(hit.point.x, hit.point.y, null, 1.4); return j ? { joint: Object.assign(j, { face: 'top' }) } : null; }
      return null;
    }
    function partAt(e) { const p = pickAt(e); return p && p.part ? p.part : null; }
    // light up the joint under the pointer and every joint on the same net
    let glow = null;
    function showNet(j) {
      if (glow) { scene.remove(glow); glow.traverse((o) => o.geometry && o.geometry.dispose()); glow = null; }
      if (!j || !JOINTS) { dirty = true; return; }
      glow = new THREE.Group();
      const net = j.row[6];
      const matNet = new THREE.MeshBasicMaterial({ color: 0xffb020, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false });
      const matMe = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false });
      for (const r of JOINTS.p) {
        if (r[6] !== net) continue;
        const me = r === j.row;
        const g = new THREE.PlaneGeometry(Math.max(0.5, r[2] * 2 + 0.3), Math.max(0.5, r[3] * 2 + 0.3));
        for (const z of r[7] === 0 ? [T3 + 0.03, -0.03] : r[7] === 1 ? [T3 + 0.03] : [-0.03]) {
          const m = new THREE.Mesh(g, me ? matMe : matNet);
          m.position.set(r[0], r[1], z); m.renderOrder = 5; m.userData.noPick = true; m.raycast = () => {};
          glow.add(m);
        }
      }
      scene.add(glow);
      dirty = true;
    }
    // the point on the board (or the plane through the target) under the pointer
    function pointAt(e) {
      const rc = new THREE.Raycaster(); rc.setFromCamera(ndc(e), camera);
      const hit = rc.intersectObjects(scene.children, true)[0];
      if (hit) return hit.point;
      const pl = new THREE.Plane(new THREE.Vector3(0, 0, 1), -cur.tz), p = new THREE.Vector3();
      return rc.ray.intersectPlane(pl, p) ? p : null;
    }
    function leaveHover(e) {
      if (hoverPart && opt.onPart) opt.onPart(hoverPart, 'leave', e);
      hoverPart = null;
      if (hoverJoint) { if (opt.onJoint) opt.onJoint(hoverJoint, 'leave', e); hoverJoint = null; showNet(null); }
    }
    function bindPointer(cv) {
      cv.tabIndex = 0;
      cv.setAttribute('aria-label', '3D board view. Arrow keys spin and tilt, plus and minus zoom, question mark lists every control.');
      cv.addEventListener('contextmenu', (e) => e.preventDefault());
      cv.addEventListener('pointerdown', (e) => {
        cv.focus({ preventScroll: true });
        cv.setPointerCapture(e.pointerId);
        if (e.pointerType === 'touch') touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (touches.size >= 2) { drag = { pinch: true, moved: true }; leaveHover(e); return; }
        const panMode = e.button === 2 || e.button === 1 || e.shiftKey || e.ctrlKey || e.metaKey;
        drag = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, lt: performance.now(), pan: panMode, moved: false };
        vel.t = vel.p = 0;
      });
      cv.addEventListener('pointermove', (e) => {
        if (touches.has(e.pointerId)) {
          const prev = touches.get(e.pointerId);
          if (touches.size >= 2) {
            const pts = [...touches.values()];
            const mid0 = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }, d0 = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
            touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
            const q = [...touches.values()];
            const mid1 = { x: (q[0].x + q[1].x) / 2, y: (q[0].y + q[1].y) / 2 }, d1 = Math.hypot(q[0].x - q[1].x, q[0].y - q[1].y);
            if (d0 > 0 && d1 > 0) zoom(d0 / d1);
            pan(mid1.x - mid0.x, mid1.y - mid0.y);
            if (reduced) snap();
            return;
          }
          touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
          void prev;
        }
        if (drag && !drag.pinch) {
          const dx = e.clientX - drag.lx, dy = e.clientY - drag.ly;
          if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 3) drag.moved = true;
          const now = performance.now(), ms = Math.max(1, now - drag.lt);
          drag.lx = e.clientX; drag.ly = e.clientY; drag.lt = now;
          if (drag.pan) pan(dx, dy);
          else {
            orbit(-dx * 0.008, -dy * 0.008);
            // remember the speed for the flick (radians per second)
            vel.t = (-dx * 0.008 * 1000) / ms; vel.p = (-dy * 0.008 * 1000) / ms;
          }
          // follow the hand closely while dragging
          Object.assign(cur, goal); place();
          leaveHover(e);
          return;
        }
        const pk = pickAt(e);
        const c = pk && pk.part ? pk.part : null, j = pk && pk.joint ? pk.joint : null;
        if (c !== hoverPart && opt.onPart) {
          if (hoverPart) opt.onPart(hoverPart, 'leave', e);
          hoverPart = c;
          if (c) opt.onPart(c, 'enter', e);
        } else if (c && opt.onPart) opt.onPart(c, 'move', e);
        const jr = j ? j.row : null;
        if (jr !== (hoverJoint && hoverJoint.row)) {
          if (hoverJoint && opt.onJoint) opt.onJoint(hoverJoint, 'leave', e);
          hoverJoint = j;
          showNet(j);
          if (j && opt.onJoint) opt.onJoint(j, 'enter', e);
        } else if (j && opt.onJoint) opt.onJoint(j, 'move', e);
      });
      const up = (e) => {
        touches.delete(e.pointerId);
        const d = drag;
        if (touches.size) return;          // one finger still down after a pinch
        drag = null;
        if (!d) return;
        // a flick only counts if the hand was still moving when it let go
        if (d.pan || d.pinch || performance.now() - (d.lt || 0) > 80) vel.t = vel.p = 0;
        if (!d.moved && !d.pinch && e.type === 'pointerup' && e.button === 0) {
          const pk = pickAt(e);
          if (pk && pk.part && opt.onPart) opt.onPart(pk.part, 'click', e);
          else if (pk && pk.joint && opt.onJoint) opt.onJoint(pk.joint, 'click', e);
        }
      };
      cv.addEventListener('pointerup', up);
      cv.addEventListener('pointercancel', up);
      cv.addEventListener('pointerleave', (e) => { if (!drag) leaveHover(e); });
      cv.addEventListener('wheel', (e) => {
        e.preventDefault();
        const px = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
        const dx = e.deltaX * px, dy = e.deltaY * px;
        if (e.shiftKey && !e.ctrlKey) { pan(-(dx || dy) * 0.6, 0); return; }
        // pinch on a touchpad arrives as ctrl + wheel
        if (e.ctrlKey) { zoom(Math.exp(dy * 0.01), pointAt(e)); return; }
        // a sideways two-finger swipe spins; up and down zoom at the pointer
        if (Math.abs(dx) > Math.abs(dy)) { orbit(-dx * 0.005, 0); return; }
        zoom(Math.exp(dy * 0.0015), pointAt(e));
      }, { passive: false });
      cv.addEventListener('dblclick', (e) => { e.preventDefault(); fit(true); });
      cv.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
        if (KEY_ACT[k]) {
          e.preventDefault(); e.stopPropagation();
          if (!e.repeat) { held.add(k + '|' + (e.shiftKey ? 1 : 0)); const a = e.shiftKey && PAN_OF[KEY_ACT[k]] ? PAN_OF[KEY_ACT[k]] : KEY_ACT[k]; act(a, 0.12); }
          return;
        }
        let handled = true;
        if (KEY_VIEW[k] != null && !e.shiftKey) preset(KEY_VIEW[k]);
        else if (k === 'f') fit(true);
        else if (k === ' ') setSpin(!spin);
        else if (k === '?' || (k === '/' && e.shiftKey)) toggleHelp();
        else if (k === 'Escape' && !help.hidden) toggleHelp(false);
        else handled = false;
        if (handled) { e.preventDefault(); e.stopPropagation(); }
      });
      cv.addEventListener('keyup', (e) => {
        const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
        held.delete(k + '|0'); held.delete(k + '|1');
      });
      cv.addEventListener('blur', () => held.clear());
    }
    bar.addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (b && camera) preset(b.dataset.v); });
    // pad: tap for a nudge, hold to keep moving
    const stopHold = () => { holdAct = null; clearTimeout(holdT); };
    pad.addEventListener('pointerdown', (e) => {
      const b = e.target.closest('button[data-a]');
      if (!b || !camera || e.button !== 0) return;
      const a = b.dataset.a;
      if (a === 'fit') return fit(true);
      if (a === 'spin') return setSpin(!spin);
      if (a === 'help') return toggleHelp();
      e.preventDefault();
      act(a, 0.14);
      clearTimeout(holdT);
      holdT = setTimeout(() => { holdAct = a; }, 280);
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) pad.addEventListener(ev, stopHold);
    // the pad buttons still work from the keyboard (Tab to one, Enter)
    pad.addEventListener('keydown', (e) => {
      const b = e.target.closest('button[data-a]');
      if (!b || !camera || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      const a = b.dataset.a;
      if (a === 'fit') fit(true); else if (a === 'spin') setSpin(!spin); else if (a === 'help') toggleHelp(); else act(a, 0.14);
    });
    help.addEventListener('click', (e) => { if (e.target.closest('[data-a="help"]')) toggleHelp(false); });

    let ro = null;
    (async () => {
      try {
        THREE = await loadThree();
        if (dead) return;
        // wait for the silkscreen pictures, then paint both faces
        await Promise.all([...off.querySelectorAll('image')].map((i) => toDataUrl(i.getAttribute('href'))));
        await repaint();
        if (dead) return;
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: !!opt.keepBuffer });
        renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.domElement.className = 'b3d-canvas';
        wrap.insertBefore(renderer.domElement, note);
        camera = new THREE.PerspectiveCamera(32, 1, 1, 4000);
        build();
        bindPointer(renderer.domElement);
        size();
        const p0 = PRESETS[opt.view] || PRESETS.home;
        goal.theta = p0.theta; goal.phi = clampPhi(p0.phi);
        fit(true); snap();
        setSpin(spin);
        note.remove();
        ro = new ResizeObserver(() => size());
        ro.observe(wrap);
        loop();
      } catch (err) {
        note.textContent = '3D view unavailable: ' + (err && err.message ? err.message : err) + '. Showing front and back still works.';
      }
    })();

    function destroy() {
      dead = true;
      cancelAnimationFrame(raf);
      mo.disconnect();
      if (ro) ro.disconnect();
      both.forEach((b) => b.destroy && b.destroy());
      off.remove();
      if (renderer) { renderer.dispose(); renderer.forceContextLoss && renderer.forceContextLoss(); }
    }
    return {
      def, opts: opt, is3d: true,
      paint: (...a) => both.forEach((b) => b.paint(...a)),
      markStale: (...a) => both.forEach((b) => b.markStale && b.markStale(...a)),
      powerOn: (...a) => both.forEach((b) => b.powerOn(...a)),
      flash: (...a) => both.forEach((b) => b.flash(...a)),
      setBattery: (...a) => both.forEach((b) => b.setBattery(...a)),
      latest: front.latest,
      hasCharge: front.hasCharge,
      destroy,
      preset: (v) => camera && preset(v),
      fit: () => camera && fit(true),
      setSpin: (on) => setSpin(on),
      spinning: () => spin,
      view: () => Object.assign({}, goal),
      settle: () => camera && snap(),
      ready: () => !!renderer,
      canvases: () => [cvF, cvB]
    };
  }
  return { create, supported, partHeight, loadThree, svgToCanvas, PRESETS, _cam: { nearestAngle, upFor, ease, clampPhi } };
})();
