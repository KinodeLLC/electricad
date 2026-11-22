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
    bar.innerHTML = '<button class="mini" data-v="top" title="Look straight down at the top">Top</button>' +
      '<button class="mini" data-v="tilt" title="Tilted view">Tilt</button>' +
      '<button class="mini" data-v="bottom" title="Look at the back">Bottom</button>' +
      '<span class="dim2">Drag to spin · wheel to zoom · double-click to reset</span>';
    wrap.appendChild(bar);

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
    const view = { theta: -Math.PI / 2, phi: 0.75, dist: 0, target: null };
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
      tm.position.z = T + 0.005; scene.add(tm);
      const bot = mapUv(new THREE.ShapeGeometry(sh, 24), uvB);
      const bm = new THREE.Mesh(bot, new THREE.MeshStandardMaterial({ map: texB, roughness: 0.55, metalness: 0.05, side: THREE.BackSide }));
      bm.position.z = -0.005; scene.add(bm);

      // parts, at their standard package heights
      for (const c of parts) {
        const h = partHeight(c);
        if (!h || !BODY[c.kind]) continue;
        const r = { x1: c.box[0], y1: c.box[1], x2: c.box[2], y2: c.box[3] };
        const down = (c.side || 'top') === 'bottom';
        const odd = ((c.rot || 0) % 90 + 90) % 90;
        const round = c.kind === 'ecap' && /PANASONIC/i.test(c.pkg || '');
        const m = body(r, down ? 0 : T, h, BODY[c.kind], { down, round, metal: c.kind === 'module' || c.kind === 'xtal' || round, rot: odd ? ((g0.portrait ? 1 : -1) * odd * Math.PI) / 180 : 0 });
        m.userData.part = c;
        pickables.push(m);
      }
      // the headers the board ships with
      for (const b of B2().headerBoxes ? B2().headerBoxes(def, opt.parts) : []) {
        if (!def.headers) break;
        body(b, T, b.male ? 2.5 : 8.5, 0x121213, {});
        if (b.male) {
          const posts = b.pinsAt || (def.pins || []).filter((p) => p.at && p.at[0] > b.x1 && p.at[0] < b.x2 && p.at[1] > b.y1 && p.at[1] < b.y2).map((p) => p.at);
          for (const [px, py] of posts) {
            const pm = new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.64, 8.5), new THREE.MeshStandardMaterial({ color: 0xd9b45a, metalness: 0.8, roughness: 0.3 }));
            pm.position.set(px, py, T + 4.25 + 0.5); scene.add(pm);
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
      const cx = g0.w / 2, cy = g0.h / 2;
      view.target = new THREE.Vector3(cx, cy, 2);
      view.dist = Math.max(g0.w, g0.h) * 1.9;
    }

    function place() {
      const { theta, phi, dist, target } = view;
      camera.position.set(target.x + dist * Math.sin(phi) * Math.cos(theta), target.y + dist * Math.sin(phi) * Math.sin(theta), target.z + dist * Math.cos(phi));
      camera.up.set(0, 1, 0);
      if (Math.sin(phi) > 0.02) camera.up.set(0, 0, 1);
      camera.lookAt(target);
      dirty = true;
    }
    function preset(v) {
      if (v === 'top') { view.theta = -Math.PI / 2; view.phi = 0.001; }
      else if (v === 'bottom') { view.theta = -Math.PI / 2; view.phi = Math.PI - 0.001; }
      else { view.theta = -Math.PI / 2 - 0.5; view.phi = 0.85; }
      place();
    }
    function size() {
      const w = Math.max(50, wrap.clientWidth), h = Math.max(50, wrap.clientHeight - 0);
      renderer.setSize(w, h, false);
      camera.aspect = w / h; camera.updateProjectionMatrix();
      // until someone zooms, keep the whole board (and what hangs off it) in view
      if (!view.zoomed) {
        const ext = Math.max(g0.w, g0.h) * 0.62 + 12, t = Math.tan((camera.fov * Math.PI) / 360);
        view.dist = Math.max(ext / t, ext / (t * camera.aspect));
        place();
      }
      dirty = true;
    }
    function loop() {
      if (dead) return;
      raf = requestAnimationFrame(loop);
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

    // pointer: drag spins, wheel zooms, double-click resets, hover shows the part
    let drag = null, hoverPart = null;
    const ray = () => new THREE.Raycaster();
    function partAt(e) {
      const r = renderer.domElement.getBoundingClientRect();
      const p = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      const rc = ray(); rc.setFromCamera(p, camera);
      const hit = rc.intersectObjects(pickables, false)[0];
      return hit ? hit.object.userData.part : null;
    }
    function bindPointer(cv) {
      cv.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, t: view.theta, p: view.phi, moved: false }; cv.setPointerCapture(e.pointerId); });
      cv.addEventListener('pointermove', (e) => {
        if (drag) {
          const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
          if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
          view.theta = drag.t - dx * 0.008;
          view.phi = Math.max(0.001, Math.min(Math.PI - 0.001, drag.p - dy * 0.008));
          place();
          if (hoverPart && opt.onPart) { opt.onPart(hoverPart, 'leave', e); hoverPart = null; }
          return;
        }
        const c = partAt(e);
        if (c !== hoverPart && opt.onPart) {
          if (hoverPart) opt.onPart(hoverPart, 'leave', e);
          hoverPart = c;
          if (c) opt.onPart(c, 'enter', e);
        } else if (c && opt.onPart) opt.onPart(c, 'move', e);
      });
      cv.addEventListener('pointerup', (e) => {
        const d = drag; drag = null;
        if (d && !d.moved && opt.onPart) { const c = partAt(e); if (c) opt.onPart(c, 'click', e); }
      });
      cv.addEventListener('pointerleave', (e) => { if (hoverPart && opt.onPart) opt.onPart(hoverPart, 'leave', e); hoverPart = null; });
      cv.addEventListener('wheel', (e) => { e.preventDefault(); view.zoomed = true; view.dist = Math.max(20, Math.min(600, view.dist * Math.exp(e.deltaY * 0.0012))); place(); }, { passive: false });
      cv.addEventListener('dblclick', () => { view.zoomed = false; preset('tilt'); size(); });
    }
    bar.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && camera) preset(b.dataset.v); });

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
        preset(opt.view || 'tilt');
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
      ready: () => !!renderer,
      canvases: () => [cvF, cvB]
    };
  }
  return { create, supported, partHeight, loadThree, svgToCanvas };
})();
