// The small box that follows the mouse over any component (board drawing,
// wiring canvas, PCB): name, part number, value, package and what it does,
// with a Details button for the full card and buy links. Buy links only open
// search or product pages in the browser: nothing is ever ordered or sent.
window.PinodePartTip = (function () {
  let box = null, hideT = null, cur = null;
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // where to buy: a part number goes to each shop's search, a generic part
  // (100nF 0603) too; an LCSC C-number opens its product page
  function buyLinks(q, lcsc) {
    const e = encodeURIComponent(q || '');
    return [
      { id: 'lcsc', label: 'LCSC', url: lcsc ? 'https://www.lcsc.com/product-detail/' + lcsc + '.html' : 'https://www.lcsc.com/search?q=' + e },
      { id: 'digikey', label: 'Digi-Key', url: 'https://www.digikey.com/en/products/result?keywords=' + e },
      { id: 'mouser', label: 'Mouser', url: 'https://www.mouser.com/c/?q=' + e }
    ];
  }
  function open(url) {
    const api = window.electricad || window.api;
    if (api && api.openExternal) api.openExternal(url); else window.open(url, '_blank', 'noopener');
  }

  function ensure() {
    if (box) return box;
    box = document.createElement('div');
    box.className = 'part-tip';
    box.setAttribute('role', 'tooltip');
    box.addEventListener('mouseenter', () => clearTimeout(hideT));
    box.addEventListener('mouseleave', () => hideSoon());
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tip]');
      if (!b || !cur) return;
      if (b.dataset.tip === 'details') { const c = cur; hide(); c.details && c.details(); }
      else if (b.dataset.url) open(b.dataset.url);
    });
    document.body.appendChild(box);
    return box;
  }

  // info: { title, sub, role, rows: [[k, v]], details: fn, buy: query, lcsc, mark: [lines], warn }
  function show(info, x, y) {
    clearTimeout(hideT);
    const b = ensure();
    cur = info;
    const rows = (info.rows || []).filter((r) => r && r[1]);
    b.innerHTML = `
      <div class="pt-title">${esc(info.title)}${info.sub ? ` <span class="pt-sub">${esc(info.sub)}</span>` : ''}</div>
      ${info.role ? `<div class="pt-role">${esc(info.role)}</div>` : ''}
      ${rows.length ? `<div class="pt-rows">${rows.map(([k, v]) => `<span>${esc(k)}</span><b>${esc(v)}</b>`).join('')}</div>` : ''}
      ${info.warn ? `<div class="pt-warn">${esc(info.warn)}</div>` : ''}
      <div class="pt-btns">
        ${info.details ? '<button class="action primary" data-tip="details" title="Specs, pinout, datasheet, pictures and where to buy">Details</button>' : ''}
        ${info.buy ? buyLinks(info.buy, info.lcsc).map((l) => `<button class="action" data-tip="buy" data-url="${esc(l.url)}" title="Open ${esc(l.label)} in your browser (nothing is ordered)">${esc(l.label)} ↗</button>`).join('') : ''}
      </div>`;
    b.style.display = 'block';
    place(x, y);
  }
  function place(x, y) {
    if (!box) return;
    const r = box.getBoundingClientRect();
    const W = window.innerWidth, H = window.innerHeight;
    let left = x + 16, top = y + 16;
    if (left + r.width > W - 8) left = Math.max(8, x - r.width - 16);
    if (top + r.height > H - 8) top = Math.max(8, y - r.height - 16);
    box.style.left = left + 'px';
    box.style.top = top + 'px';
  }
  // a short grace period so the mouse can travel from the part into the box
  function hideSoon(ms) { clearTimeout(hideT); hideT = setTimeout(hide, ms == null ? 350 : ms); }
  function hide() { clearTimeout(hideT); if (box) box.style.display = 'none'; cur = null; }
  function visible() { return !!(box && box.style.display === 'block'); }

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  window.addEventListener('blur', () => hide());
  return { show, hide, hideSoon, place, visible, buyLinks, open };
})();
