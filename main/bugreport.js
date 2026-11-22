// In-app bug and wrong-image reports → usekinode.app (the ElectriCAD product
// page's report API). Sent from the main process: the renderer's file://
// origin would be refused by CORS. Nothing is sent unless the user presses Send.
const os = require('os');
const ENDPOINT = 'https://usekinode.app/api/bugreports';
const FALLBACK = 'https://usekinode.app/products/electricad#report-wrong-image';
const KINDS = new Set(['bug', 'crash', 'wrong_image', 'feature', 'other']);
const LIMITS = { title: 140, description: 5000, steps: 4000, expected: 2000, email: 254, appVersion: 40, os: 80, board: 80, boardRevision: 60, view: 60, imageId: 160 };

function clean(r, appVersion) {
  const out = { product: 'electricad', source: 'app', kind: KINDS.has(r.kind) ? r.kind : 'bug' };
  for (const [k, n] of Object.entries(LIMITS)) {
    const v = r[k] == null ? '' : String(r[k]).trim();
    if (v) out[k] = v.slice(0, n);
  }
  out.appVersion = String(appVersion || out.appVersion || '').slice(0, 40);
  out.os = (process.platform + ' ' + os.release() + ' ' + process.arch).slice(0, 80);
  if (!out.description) out.description = '';
  if (r.context && typeof r.context === 'object') {
    let c = r.context;
    let s = JSON.stringify(c);
    if (s.length > 16000) c = { truncated: true, text: s.slice(0, 15000) };
    out.context = c;
  }
  if (r.screenshot && /^data:image\/(png|jpeg|webp);base64,/.test(r.screenshot) && r.screenshot.length < 5.4e6) out.screenshot = r.screenshot;
  return out;
}
// what the report must satisfy before it goes (same rules as the server)
function check(p) {
  if (p.kind !== 'wrong_image' && (!p.title || p.title.length < 4)) return 'Give the report a short title (at least 4 characters).';
  const imageOk = p.kind === 'wrong_image' && (p.board || p.imageId);
  if (!imageOk && (!p.description || p.description.length < 10)) return 'Describe what happened (at least 10 characters).';
  if (p.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email)) return 'That email address does not look right (or leave it empty).';
  return null;
}

async function send(report, opts) {
  const p = clean(report || {}, opts && opts.appVersion);
  const bad = check(p);
  if (bad) return { ok: false, error: bad };
  let f = globalThis.fetch;
  try { const { net } = require('electron'); if (net && net.fetch) f = net.fetch.bind(net); } catch (e) { /* node */ }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await f((opts && opts.endpoint) || ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'ElectriCAD/' + p.appVersion }, body: JSON.stringify(p), signal: ctl.signal });
    let j = {};
    try { j = await r.json(); } catch (e) { /* empty */ }
    if (r.status === 201 || r.status === 200) return { ok: true, ref: j.ref || '', id: j.id, duplicate: !!j.duplicate };
    if (r.status === 429) return { ok: false, error: j.error || 'Too many reports from this computer just now.', retryAfter: j.retryAfter || null };
    if (r.status === 400) return { ok: false, error: j.error || 'The report was not accepted.' };
    return { ok: false, error: 'The report server answered ' + r.status + '.', offline: true, fallback: FALLBACK };
  } catch (e) {
    return { ok: false, error: 'Could not reach usekinode.app (' + (e.name === 'AbortError' ? 'timed out' : e.message) + ').', offline: true, fallback: FALLBACK };
  } finally { clearTimeout(t); }
}

module.exports = { send, clean, check, ENDPOINT, FALLBACK };
