// ElectriCAD renderer shell. One deliberate file: state at the top, then panels,
// then wiring. Everything hardware comes in over window.electricad (preload IPC).
/* global monaco, require, PINODE_BOARDS, PinodeBoard, ElectriCADUtil, ElectriCADArduinoApi */
(() => {
  const $ = (id) => document.getElementById(id);
  const api = window.electricad;
  const U = window.ElectriCADUtil;

  // ---- state ---------------------------------------------------------------
  const S = {
    settings: null,
    project: null,          // { dir, manifest, tree }
    fqbn: '', port: '',
    devices: [],            // live-detected boards/chips (serial + network)
    selectedId: '',         // detect id of the device driving the board view
    uploading: false,
    openTabs: [],           // { path, name, model, dirty }
    activeTab: null,
    editor: null,
    board: null,            // PinodeBoard instance
    boardDefId: 'uno',
    diagnostics: [],
    serialTail: [],         // last N serial lines for AI context
    lastSnap: null,         // latest telemetry (serialized)
    lastPins: [],           // expanded pin states
    plot: { series: new Map(), t: 0, paused: false, window: 600, rows: [] },
    timeline: { pins: new Map(), t0: Date.now(), span: 10000, paused: false },  // tele -> [{t, level}]
    ai: { messages: [], streaming: false, useContext: true },
    serial: { lines: [], history: [], histIdx: -1, filter: '', timestamps: false, autoscroll: true, bauds: {} },
    i2c: { addresses: [], ts: 0, port: '' },
    building: false,
    memory: null,
    paletteSel: 0
  };

  // ---- helpers -------------------------------------------------------------
  // ---- modal dialogs (Electron has no prompt(); this is ours) --------------
  // dialog({ title, fields: [{key,label,value,type:'text'|'password'|'number',
  //          options?: [..] (renders a select), readonly?, browse?: true}],
  //          okLabel }) -> Promise<{key:value,...}|null>
  function dialog(opts) {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'modal-overlay';
      const box = document.createElement('div');
      box.className = 'modal';
      box.innerHTML = `<div class="modal-title">${esc(opts.title || '')}</div>`;
      const inputs = {};
      for (const f of opts.fields || []) {
        const row = document.createElement('div');
        row.className = 'modal-row';
        row.innerHTML = `<label>${esc(f.label)}</label>`;
        let input;
        if (f.options) {
          input = document.createElement('select');
          for (const o of f.options) {
            const opt = document.createElement('option');
            opt.value = o.value !== undefined ? o.value : o;
            opt.textContent = o.label !== undefined ? o.label : o;
            input.appendChild(opt);
          }
          if (f.value !== undefined) input.value = f.value;
        } else {
          input = document.createElement('input');
          input.type = f.type || 'text';
          input.value = f.value !== undefined && f.value !== null ? f.value : '';
          if (f.placeholder) input.placeholder = f.placeholder;
          if (f.readonly) input.readOnly = true;
        }
        input.className = 'input';
        input.style.margin = '0';
        input.style.width = '100%';
        inputs[f.key] = input;
        row.appendChild(input);
        if (f.browse) {
          const b = document.createElement('button');
          b.className = 'mini';
          b.textContent = 'Browse…';
          b.addEventListener('click', async () => {
            const dir = await api.project.pickFolder();
            if (dir) input.value = dir;
          });
          row.appendChild(b);
        }
        box.appendChild(row);
      }
      const btns = document.createElement('div');
      btns.className = 'modal-btns';
      const cancel = document.createElement('button');
      cancel.className = 'action';
      cancel.textContent = 'Cancel';
      const ok = document.createElement('button');
      ok.className = 'action primary';
      ok.textContent = opts.okLabel || 'OK';
      btns.appendChild(cancel); btns.appendChild(ok);
      box.appendChild(btns);
      ov.appendChild(box);
      document.body.appendChild(ov);
      makeModalDraggable(box);
      const done = (result) => { ov.remove(); resolve(result); };
      cancel.addEventListener('click', () => done(null));
      ov.addEventListener('mousedown', (e) => { if (e.target === ov) done(null); });
      ok.addEventListener('click', () => {
        const out = {};
        for (const [k, el] of Object.entries(inputs)) out[k] = el.value;
        done(out);
      });
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.tagName !== 'SELECT') ok.click();
        if (e.key === 'Escape') done(null);
      });
      const first = Object.values(inputs).find((i) => !i.readOnly);
      if (first) { first.focus(); if (first.select) first.select(); }
    });
  }
  window.electricadDialog = dialog; // wiring.js editors use it too
  window.pinodeDialog = dialog;     // legacy alias

  // ---- draggable frames -----------------------------------------------------
  // every splitter resizes its neighbor; sizes persist across launches
  function initSplitters() {
    const remember = (k, v) => { try { localStorage.setItem('mc_split_' + k, v); } catch (e) {} };
    const recall = (k) => { try { return localStorage.getItem('mc_split_' + k); } catch (e) { return null; } };
    const forget = (k) => { try { localStorage.removeItem('mc_split_' + k); } catch (e) {} };
    // sizes are capped by the window, so a full screen can give a panel most of the room;
    // dragging a panel nearly shut collapses it, dragging the strip back out opens it,
    // and a double-click puts the default size back
    const W = () => window.innerWidth, H = () => window.innerHeight;
    const defs = [
      { el: 'splitSide', target: 'side', pane: 'side', axis: 'x', prop: 'width', dir: 1, min: 150, def: 250, max: () => W() * 0.5 },
      { el: 'splitRight', target: 'right', pane: 'right', axis: 'x', prop: 'width', dir: -1, min: 240, def: 380, max: () => W() * 0.6 },
      { el: 'splitBottom', target: 'bottom', pane: 'bottom', axis: 'y', prop: 'height', dir: -1, min: 90, def: 220, max: () => ($('center') ? $('center').offsetHeight : H()) - 120 },
      { el: 'splitBoard', target: 'boardPane', axis: 'y', prop: 'height', dir: 1, min: 0, def: null, max: () => ($('right') ? $('right').offsetHeight : H()) - 6 }
    ];
    const layoutAll = () => { if (S.editor) S.editor.layout(); window.dispatchEvent(new Event('resize')); };
    // the live board / AI split: either side can be shut by dragging to the end
    const boardEnds = (size) => {
      const ai = $('aiPane'), full = $('right').offsetHeight - 6;
      if (ai) ai.classList.toggle('hidden', size >= full - 1);
      $('boardPane').classList.toggle('hidden', size <= 0);
    };
    const setSize = (d, target, size) => {
      target.style[d.prop] = size + 'px';
      if (d.prop === 'width') target.style.minWidth = size + 'px';
      if (d.target === 'boardPane') boardEnds(size);
    };
    for (const d of defs) {
      const splitter = $(d.el), target = $(d.target);
      if (!splitter || !target) continue;
      splitter.title = 'Drag to resize · drag shut to hide · double-click for the default size';
      const saved = recall(d.target);
      if (saved != null && saved !== '') setSize(d, target, Math.min(Number(saved), d.max()));
      splitter.addEventListener('dblclick', () => {
        forget(d.target);
        target.style[d.prop] = ''; if (d.prop === 'width') target.style.minWidth = '';
        if (d.target === 'boardPane') { $('boardPane').classList.remove('hidden'); $('aiPane').classList.remove('hidden'); }
        if (d.pane && target.classList.contains('collapsed')) togglePane(d.pane, true);
        layoutAll();
      });
      splitter.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        splitter.classList.add('dragging');
        document.body.classList.add(d.axis === 'x' ? 'resizing-x' : 'resizing-y');
        const start = d.axis === 'x' ? e.clientX : e.clientY;
        const wasCollapsed = d.pane && target.classList.contains('collapsed');
        const hiddenBoard = d.target === 'boardPane' && $('boardPane').classList.contains('hidden');
        const startSize = wasCollapsed || hiddenBoard ? 0 : (d.axis === 'x' ? target.offsetWidth : target.offsetHeight);
        let last = startSize;
        const move = (ev) => {
          const now = d.axis === 'x' ? ev.clientX : ev.clientY;
          let size = startSize + d.dir * (now - start);
          if (d.pane) {
            const shut = size < d.min * 0.5;
            if (shut !== target.classList.contains('collapsed')) togglePane(d.pane, !shut);
            if (shut) { last = 0; return; }
            size = Math.max(d.min, size);
          } else if (size < 40) size = 0;                    // board view shut
          else if (size > d.max() - 60) size = d.max();      // AI copilot shut
          size = Math.min(d.max(), size);
          setSize(d, target, size);
          last = size;
          if (S.editor) S.editor.layout();
        };
        const up = () => {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          splitter.classList.remove('dragging');
          document.body.classList.remove('resizing-x', 'resizing-y');
          if (!d.pane || last > 0) remember(d.target, last);
          layoutAll();
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
    }
    // the icon bar: drag its edge and the icons and labels grow with it
    (function iconBar() {
      const sp = $('splitAct'); if (!sp) return;
      const DEF = 92, MIN = 44, MAX = 200;
      const set = (w, keep) => {
        if (w == null) document.body.style.removeProperty('--actw');
        else document.body.style.setProperty('--actw', w + 'px');
        const now = w == null ? DEF : w;
        document.body.classList.toggle('act-narrow', now < 64);
        if (keep) { if (w == null) forget('activity'); else remember('activity', w); }
      };
      const saved = Number(recall('activity'));
      if (saved >= MIN) set(Math.min(MAX, saved), false); else set(null, false);
      sp.addEventListener('dblclick', () => { set(null, true); layoutAll(); });
      sp.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        sp.classList.add('dragging'); document.body.classList.add('resizing-x');
        const x0 = e.clientX, w0 = $('activity').offsetWidth;
        let w = w0;
        const move = (ev) => { w = Math.round(Math.max(MIN, Math.min(MAX, w0 + ev.clientX - x0))); set(w, false); if (S.editor) S.editor.layout(); };
        const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); sp.classList.remove('dragging'); document.body.classList.remove('resizing-x'); set(w, true); layoutAll(); };
        document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
      });
    })();
    // a smaller window never leaves a panel wider than it allows
    window.addEventListener('resize', () => {
      for (const d of defs) {
        const t = $(d.target), v = t && parseFloat(t.style[d.prop]);
        if (v && v > d.max()) setSize(d, t, Math.max(d.min, d.max()));
      }
    });
  }

  // dialogs are frames too — drag them by the title
  function makeModalDraggable(box) {
    const title = box.querySelector('.modal-title');
    if (!title) return;
    title.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const r = box.getBoundingClientRect();
      box.style.position = 'fixed';
      box.style.margin = '0';
      box.style.left = r.left + 'px';
      box.style.top = r.top + 'px';
      const ox = e.clientX - r.left, oy = e.clientY - r.top;
      const move = (ev) => {
        box.style.left = Math.max(0, ev.clientX - ox) + 'px';
        box.style.top = Math.max(0, ev.clientY - oy) + 'px';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  function toast(msg, ms = 2600) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.add('hidden'), ms);
  }
  function logTo(elId, text, cls) {
    const box = $(elId);
    const div = document.createElement('div');
    if (cls) div.className = cls;
    div.textContent = text;
    box.appendChild(div);
    while (box.childNodes.length > 3000) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const sep = (dir) => (dir.includes('\\') ? '\\' : '/');
  const joinPath = (dir, name) => dir.replace(/[\\/]+$/, '') + sep(dir) + name;
  const baseName = (p) => String(p).split(/[\\/]/).pop();
  const dirName = (p) => String(p).replace(/[\\/][^\\/]*$/, '');

  // small yes/no/cancel style confirm built on the modal system
  function confirmDialog(title, message, buttons) {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'modal-overlay';
      const box = document.createElement('div');
      box.className = 'modal';
      box.innerHTML = `<div class="modal-title">${esc(title)}</div><div class="modal-msg">${esc(message)}</div>`;
      const row = document.createElement('div');
      row.className = 'modal-btns';
      for (const b of buttons) {
        const el = document.createElement('button');
        el.className = 'action' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : '');
        el.textContent = b.label;
        el.addEventListener('click', () => { ov.remove(); resolve(b.value); });
        row.appendChild(el);
      }
      box.appendChild(row);
      ov.appendChild(box);
      document.body.appendChild(ov);
      makeModalDraggable(box);
      ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { ov.remove(); resolve(null); } });
      const first = row.querySelector('.primary') || row.querySelector('button');
      if (first) first.focus();
    });
  }

  // read-only info sheet (About, shortcuts, guides)
  function infoDialog(title, html) {
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal winfo';
    box.innerHTML = `<div class="modal-title">${esc(title)}</div><div class="info-body">${html}</div>
      <div class="modal-btns"><button class="action primary">Close</button></div>`;
    ov.appendChild(box);
    document.body.appendChild(ov);
    makeModalDraggable(box);
    const close = () => ov.remove();
    box.querySelector('.modal-btns button').addEventListener('click', close);
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    box.querySelector('.modal-btns button').focus();
    return box;
  }

  // right-click menus (tree, tabs)
  function contextMenu(x, y, items) {
    const m = $('ctxMenu');
    m.innerHTML = '';
    for (const it of items) {
      if (it === '-') { const hr = document.createElement('div'); hr.className = 'ctx-sep'; m.appendChild(hr); continue; }
      const d = document.createElement('div');
      d.className = 'ctx-item' + (it.danger ? ' danger' : '');
      d.textContent = it.label;
      if (it.keys) { const k = document.createElement('span'); k.className = 'ctx-keys'; k.textContent = it.keys; d.appendChild(k); }
      d.addEventListener('mousedown', (e) => { e.stopPropagation(); hideCtx(); it.run(); });
      m.appendChild(d);
    }
    m.classList.remove('hidden');
    const r = m.getBoundingClientRect();
    m.style.left = Math.min(x, window.innerWidth - r.width - 6) + 'px';
    m.style.top = Math.min(y, window.innerHeight - r.height - 6) + 'px';
  }
  window.electricadContextMenu = contextMenu; // wiring.js uses it too
  window.electricadConfirm = confirmDialog;
  function hideCtx() { $('ctxMenu').classList.add('hidden'); }
  document.addEventListener('mousedown', (e) => { if (!$('ctxMenu').contains(e.target)) hideCtx(); });
  window.addEventListener('blur', hideCtx);

  // expand hex-mask snapshot into per-pin states
  function expandSnap(snap, digitalCount) {
    const mode = BigInt('0x' + (snap.modeMask || '0'));
    const out = BigInt('0x' + (snap.outMask || '0'));
    const inp = BigInt('0x' + (snap.inMask || '0'));
    const pull = BigInt('0x' + (snap.pullMask || '0'));
    const pins = [];
    for (let i = 0; i < digitalCount; i++) {
      const bit = 1n << BigInt(i);
      const isOut = (mode & bit) !== 0n;
      const level = (isOut ? (out & bit) : (inp & bit)) !== 0n ? 1 : 0;
      pins.push({
        pin: i,
        mode: snap.pwm && snap.pwm[i] !== undefined ? 'pwm' : (isOut ? 'out' : 'in'),
        level, pwm: snap.pwm ? snap.pwm[i] : undefined,
        ...(!isOut && (pull & bit) !== 0n ? { pull: 'up' } : {})
      });
    }
    return pins;
  }

  // ---- editor --------------------------------------------------------------
  function editorOptions() {
    const e = (S.settings && S.settings.editor) || {};
    return {
      fontSize: (S.settings && S.settings.editorFontSize) || 14,
      minimap: { enabled: e.minimap !== false },
      wordWrap: e.wordWrap ? 'on' : 'off',
      tabSize: e.tabSize || 2,
      stickyScroll: { enabled: !!e.stickyScroll },
      renderWhitespace: e.renderWhitespace ? 'all' : 'selection',
      fontLigatures: !!e.ligatures,
      autoClosingBrackets: e.autoClose === false ? 'never' : 'languageDefined',
      autoClosingQuotes: e.autoClose === false ? 'never' : 'languageDefined',
      cursorStyle: ['line', 'block', 'underline'].includes(e.cursorStyle) ? e.cursorStyle : 'line',
      lineNumbers: ['on', 'off', 'relative'].includes(e.lineNumbers) ? e.lineNumbers : 'on',
      guides: { indentation: e.guides !== false, bracketPairs: e.guides !== false ? 'active' : false },
      cursorSmoothCaretAnimation: e.smoothCaret ? 'on' : 'off',
      fontFamily: e.fontFamily || '"Cascadia Code", Consolas, "Courier New", monospace',
      columnSelection: !!S.columnSelection
    };
  }

  function initMonaco() {
    return new Promise((resolve) => {
      require.config({ paths: { vs: '../node_modules/monaco-editor/min/vs' } });
      require(['vs/editor/editor.main'], () => {
        monaco.editor.defineTheme('electricad', {
          base: 'vs-dark', inherit: true,
          rules: [{ token: 'comment', foreground: '6a9955' }],
          colors: {
            'editor.background': '#121212',
            'editorCursor.foreground': '#ff6500',
            'editorLineNumber.activeForeground': '#ff6500'
          }
        });
        monaco.editor.defineTheme('electricad-light', {
          base: 'vs', inherit: true,
          rules: [{ token: 'comment', foreground: '3d7a33' }],
          colors: {
            'editor.background': '#fbfbfa',
            'editorCursor.foreground': '#e05a00',
            'editorLineNumber.activeForeground': '#e05a00'
          }
        });
        S.editor = monaco.editor.create($('editor'), {
          theme: S.settings && S.settings.theme === 'light' ? 'electricad-light' : 'electricad',
          automaticLayout: true,
          model: null,
          bracketPairColorization: { enabled: true },
          smoothScrolling: true,
          renderWhitespace: 'selection',
          ...editorOptions()
        });
        S.editor.onDidChangeCursorPosition((e) => {
          $('stCursor').textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
        });
        S.editor.onDidChangeCursorSelection(() => renderEditorStatus());
        S.editor.onDidChangeModel(() => renderEditorStatus());
        registerArduinoLanguage();
        registerFormatters();
        resolve();
      });
    });
  }

  // Arduino API knowledge in the editor: completion, hover, signature help
  function registerArduinoLanguage() {
    const A = window.ElectriCADArduinoApi;
    if (!A) return;
    const K = monaco.languages.CompletionItemKind;
    monaco.languages.registerCompletionItemProvider('cpp', {
      triggerCharacters: ['.'],
      provideCompletionItems(model, position) {
        const word = model.getWordUntilPosition(position);
        const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber,
                        startColumn: word.startColumn, endColumn: word.endColumn };
        const before = model.getLineContent(position.lineNumber).slice(0, word.startColumn - 1);
        const obj = (/(\w+)\.$/.exec(before) || [])[1];
        const items = [];
        for (const [name, sig, doc, kind] of A.API) {
          if (obj) {
            if (!name.startsWith(obj + '.')) continue;
          } else if (name.includes('.')) continue;
          const label = obj ? name.slice(obj.length + 1) : name;
          const isCall = kind === 'f' || kind === 'm';
          const hasArgs = isCall && !/\(\)/.test(sig);
          items.push({
            label, range, detail: sig, documentation: doc,
            kind: kind === 'c' ? K.Constant : kind === 'k' ? K.Keyword : kind === 'm' ? K.Method : K.Function,
            insertText: isCall ? label + (hasArgs ? '($0)' : '()') : label,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
          });
        }
        if (!obj) for (const [label, body, doc] of A.SNIPPETS) {
          items.push({ label, range, kind: K.Snippet, documentation: doc, detail: 'snippet', insertText: body,
                       insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet });
        }
        return { suggestions: items };
      }
    });
    monaco.languages.registerHoverProvider('cpp', {
      provideHover(model, position) {
        const w = model.getWordAtPosition(position);
        if (!w) return null;
        const line = model.getLineContent(position.lineNumber);
        const pre = line.slice(0, w.startColumn - 1);
        const obj = (/(\w+)\.$/.exec(pre) || [])[1];
        const hit = A.lookup(obj ? obj + '.' + w.word : w.word);
        if (!hit) return null;
        return { contents: [{ value: '`' + hit[1] + '`' }, { value: hit[2] }] };
      }
    });
    monaco.languages.registerSignatureHelpProvider('cpp', {
      signatureHelpTriggerCharacters: ['(', ','],
      provideSignatureHelp(model, position) {
        const text = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
        // innermost unclosed call on this line
        let depth = 0, i = text.length - 1, commas = 0;
        for (; i >= 0; i--) {
          const c = text[i];
          if (c === ')') depth++;
          else if (c === '(') { if (depth === 0) break; depth--; }
          else if (c === ',' && depth === 0) commas++;
        }
        if (i < 0) return null;
        const m = /([\w.]+)\s*$/.exec(text.slice(0, i));
        const hit = m && A.lookup(m[1]);
        if (!hit) return null;
        const params = ((/\((.*)\)/.exec(hit[1]) || [])[1] || '').split(',').map((x) => x.trim()).filter(Boolean)
          .map((label) => ({ label }));
        return {
          value: { signatures: [{ label: hit[1], documentation: hit[2], parameters: params }],
                   activeSignature: 0, activeParameter: Math.min(commas, Math.max(0, params.length - 1)) },
          dispose() {}
        };
      }
    });
  }

  function applyEditorSettings() {
    if (S.editor) S.editor.updateOptions(editorOptions());
  }
  async function setFontSize(n) {
    const size = Math.max(9, Math.min(32, n));
    S.settings = await api.settings.set({ editorFontSize: size });
    applyEditorSettings();
    toast('Editor font ' + size + 'px', 900);
  }

  function langFor(p) {
    if (/\.(ino|pde|cpp|cc|cxx|h|hh|hpp|c|S)$/i.test(p)) return 'cpp';
    if (/\.py$/i.test(p)) return 'python';
    if (/\.json$/i.test(p)) return 'json';
    if (/\.md$/i.test(p)) return 'markdown';
    if (/\.(ya?ml)$/i.test(p)) return 'yaml';
    if (/\.(sh|bash)$/i.test(p)) return 'shell';
    if (/\.(js|mjs)$/i.test(p)) return 'javascript';
    if (/\.(html?)$/i.test(p)) return 'html';
    if (/\.css$/i.test(p)) return 'css';
    if (/\.(ini|properties|txt|csv)$/i.test(p)) return 'plaintext';
    return 'plaintext';
  }

  const BINARY = /\.(png|jpe?g|gif|bmp|ico|bin|hex|elf|uf2|zip|7z|pdf|exe|dll|o|a|so)$/i;

  async function openFile(p, name, opts = {}) {
    if (/\.(png|jpe?g|gif|bmp|ico|webp)$/i.test(p) && !opts.quiet) return showImage(p);
    if (BINARY.test(p)) {
      if (!opts.quiet) toast(baseName(p) + ' is a binary file — opened in Explorer instead');
      api.file.reveal(p);
      return null;
    }
    let tab = S.openTabs.find((t) => t.path === p);
    if (!tab) {
      let content;
      try { content = await api.file.read(p); }
      catch (e) { toast('Could not open ' + baseName(p) + ': ' + e.message, 4000); return null; }
      const model = monaco.editor.createModel(content, langFor(p), monaco.Uri.file(p));
      tab = { path: p, name: name || baseName(p), model, dirty: false, savedVersion: model.getAlternativeVersionId() };
      model.onDidChangeContent(() => {
        const dirty = model.getAlternativeVersionId() !== tab.savedVersion;
        if (dirty !== tab.dirty) { tab.dirty = dirty; renderTabs(); }
        scheduleAutoSave();
        if (tab === S.activeTab) scheduleOutline();
        schedulePinCheck(tab);
      });
      S.openTabs.push(tab);
      applyMarkers(tab);
      runPinCheck(tab);
    }
    activateTab(tab);
    return tab;
  }

  function activateTab(tab) {
    if (tab && pcbActive()) setPcbMode(false);
    S.activeTab = tab;
    S.editor.setModel(tab ? tab.model : null);
    if (tab && tab.viewState) S.editor.restoreViewState(tab.viewState);
    renderTabs();
    renderTree();
    renderOutline();
    showWelcome(!tab && !PinodeWiring.isActive() && !pcbActive());
    if (tab) S.editor.focus();
  }

  async function saveTab(t, quiet) {
    if (!t || !t.dirty) return true;
    try {
      formatBeforeSave(t);
      const ed = (S.settings && S.settings.editor) || {};
      if (ed.trimOnSave && !ed.formatOnSave) {
        const v = t.model.getValue();
        const trimmed = v.replace(/[ \t]+(\r?\n)/g, '$1').replace(/[ \t]+$/, '');
        if (trimmed !== v) t.model.pushEditOperations([], [{ range: t.model.getFullModelRange(), text: trimmed }], () => null);
      }
      await api.file.write(t.path, t.model.getValue());
      t.savedVersion = t.model.getAlternativeVersionId();
      t.dirty = false;
      renderTabs();
      if (t.boardFile) {
        // a file opened from the board: write it straight back
        try {
          const chk = /\.py$/i.test(t.boardFile.name) ? await api.upy.syntax(t.boardFile.port, t.boardFile.name, t.model.getValue()).catch(() => ({ ok: true })) : { ok: true };
          if (!chk.ok) { toast(`Saved on the PC only: line ${chk.line}: ${chk.message}`, 6000); return true; }
          const r = await api.upy.upload(t.boardFile.port, t.boardFile.name, t.model.getValue());
          if (!quiet) toast(`Saved ${t.boardFile.name} to the board (${r.bytes} bytes)`, 1600);
        } catch (e) { toast('Saved on the PC, but writing to the board failed: ' + e.message, 6000); }
        return true;
      }
      if (!quiet) toast('Saved ' + t.name, 1000);
      return true;
    } catch (e) {
      toast('Save failed: ' + t.name + ' — ' + e.message, 5000);
      return false;
    }
  }
  async function saveActive() {
    const t = S.activeTab;
    if (!t) return;
    if (!t.dirty) { toast('No changes in ' + t.name, 800); return; }
    await saveTab(t);
  }
  async function saveAll(quiet) {
    let n = 0;
    for (const t of S.openTabs) if (t.dirty && await saveTab(t, true)) n++;
    if (n && !quiet) toast('Saved ' + n + ' file' + (n > 1 ? 's' : ''), 1000);
    return n;
  }
  // auto-save: dirty tabs are written ~1.5s after typing stops (Settings)
  let autoSaveT = null;
  function scheduleAutoSave() {
    if (!S.settings || !S.settings.editor || S.settings.editor.autoSave === false) return;
    clearTimeout(autoSaveT);
    autoSaveT = setTimeout(() => saveAll(true), 1500);
  }

  async function closeTab(tab) {
    const i = S.openTabs.indexOf(tab);
    if (i < 0) return;
    if (tab.dirty) {
      const r = await confirmDialog('Unsaved changes', `Save changes to ${tab.name} before closing?`, [
        { label: 'Save', value: 'save', primary: true }, { label: "Don't save", value: 'discard', danger: true },
        { label: 'Cancel', value: null }]);
      if (!r) return;
      if (r === 'save' && !(await saveTab(tab, true))) return;
    }
    S.openTabs.splice(i, 1);
    closedTabs.push(tab.path);
    if (closedTabs.length > 30) closedTabs.shift();
    tab.model.dispose();
    if (S.activeTab === tab) activateTab(S.openTabs[Math.max(0, i - 1)] || null);
    else renderTabs();
  }

  function renderTabs() {
    saveSession();
    updateTitle();
    const box = $('tabs');
    box.innerHTML = '';
    for (const t of S.openTabs) {
      const el = document.createElement('div');
      el.className = 'tab' + (t === S.activeTab ? ' on' : '');
      el.title = t.path;
      el.innerHTML = `${t.dirty ? '<span class="dot">●</span>' : ''}<span>${esc(t.name)}</span><span class="x" title="Close (Ctrl+W)">✕</span>`;
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('x')) closeTab(t);
        else if (t !== S.activeTab) {
          if (S.activeTab) S.activeTab.viewState = S.editor.saveViewState();
          activateTab(t);
        }
      });
      el.addEventListener('auxclick', (e) => { if (e.button === 1) closeTab(t); });
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        contextMenu(e.clientX, e.clientY, [
          { label: 'Close', run: () => closeTab(t) },
          { label: 'Close others', run: async () => { for (const o of S.openTabs.slice()) if (o !== t) await closeTab(o); } },
          { label: 'Close saved', run: async () => { for (const o of S.openTabs.slice()) if (!o.dirty) await closeTab(o); } },
          '-',
          { label: 'Reveal in Explorer', run: () => api.file.reveal(t.path) },
          { label: 'Copy path', run: () => { navigator.clipboard.writeText(t.path); toast('Path copied', 900); } }
        ]);
      });
      box.appendChild(el);
    }
  }

  // ---- outline: functions in the active file ---------------------------------
  let outlineT = null;
  function scheduleOutline() { clearTimeout(outlineT); outlineT = setTimeout(renderOutline, 400); }
  function renderOutline() {
    const box = $('outline');
    if (!box) return;
    box.innerHTML = '';
    const t = S.activeTab;
    if (!t) return;
    const lines = t.model.getLinesContent();
    const items = [];
    const isPy = /\.py$/i.test(t.path);
    const cfn = /^\s*(?:static\s+|inline\s+|virtual\s+)*(?:[\w:<>*&]+\s+)+\**([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:const\s*)?\{?\s*$/;
    const ctype = /^\s*(class|struct|enum)\s+([A-Za-z_]\w*)/;
    lines.forEach((ln, i) => {
      let m;
      if (isPy) {
        if ((m = /^\s*(def|class)\s+([A-Za-z_]\w*)/.exec(ln))) items.push({ kind: m[1] === 'def' ? 'ƒ' : '◆', name: m[2], line: i + 1 });
      } else if ((m = ctype.exec(ln))) items.push({ kind: '◆', name: m[2], line: i + 1 });
      else if ((m = cfn.exec(ln)) && !/^(if|for|while|switch|return|else)$/.test(m[1])) {
        items.push({ kind: 'ƒ', name: m[1], line: i + 1 });
      }
    });
    for (const it of items.slice(0, 200)) {
      const d = document.createElement('div');
      d.className = 'node';
      d.innerHTML = `<span class="caret">${it.kind}</span>${esc(it.name)} <span class="dim2">${it.line}</span>`;
      d.addEventListener('click', () => {
        S.editor.revealLineInCenter(it.line);
        S.editor.setPosition({ lineNumber: it.line, column: 1 });
        S.editor.focus();
      });
      box.appendChild(d);
    }
    $('outlineHead').style.display = items.length ? '' : 'none';
  }

  // ---- explorer ------------------------------------------------------------
  const collapsed = new Set(JSON.parse(localStorage.getItem('ec_collapsed') || '[]'));
  const fileIcon = (name) => /\.(ino|pde)$/i.test(name) ? '⚡' : /\.(h|hpp)$/i.test(name) ? 'ʜ' :
    /\.(c|cpp|cc)$/i.test(name) ? 'ᴄ' : /\.py$/i.test(name) ? '🐍' : /wiring\.json$/i.test(name) ? '🔌' :
    /\.json$/i.test(name) ? '{}' : /\.md$/i.test(name) ? '✎' : '·';

  function renderTree() {
    const box = $('tree');
    box.innerHTML = '';
    if (!S.project) { box.innerHTML = '<p class="dim">No project open. ▣ creates one, Ctrl+O opens one.</p>'; return; }
    const walk = (nodes, depth) => {
      for (const n of nodes) {
        const div = document.createElement('div');
        const isOpen = n.dir && !collapsed.has(n.path);
        div.className = 'node' + (S.activeTab && S.activeTab.path === n.path ? ' sel' : '');
        div.style.paddingLeft = 6 + depth * 14 + 'px';
        const dirty = !n.dir && S.openTabs.some((t) => t.path === n.path && t.dirty);
        div.innerHTML = `<span class="caret">${n.dir ? (isOpen ? '▾' : '▸') : fileIcon(n.name)}</span>${esc(n.name)}${dirty ? ' <span class="dot">●</span>' : ''}`;
        div.title = n.path;
        div.addEventListener('click', () => {
          if (n.dir) {
            if (collapsed.has(n.path)) collapsed.delete(n.path); else collapsed.add(n.path);
            localStorage.setItem('ec_collapsed', JSON.stringify([...collapsed]));
            renderTree();
          } else openFile(n.path, n.name);
        });
        div.addEventListener('contextmenu', (e) => { e.preventDefault(); treeMenu(e, n); });
        box.appendChild(div);
        if (n.dir && isOpen && n.children) walk(n.children, depth + 1);
      }
    };
    walk(S.project.tree, 0);
    box.oncontextmenu = (e) => {
      if (e.target !== box) return;
      e.preventDefault();
      treeMenu(e, { dir: true, path: S.project.dir, name: S.project.manifest.name, root: true });
    };
  }

  function treeMenu(e, n) {
    const folder = n.dir ? n.path : dirName(n.path);
    const items = [
      { label: 'New file…', run: () => newFileIn(folder) },
      { label: 'New folder…', run: () => newFolderIn(folder) },
      '-'
    ];
    if (!n.root) {
      items.push({ label: 'Rename…', run: () => renamePath(n) });
      items.push({ label: 'Delete (to Recycle Bin)', danger: true, run: () => trashPath(n) });
      items.push('-');
    }
    items.push({ label: 'Reveal in Explorer', run: () => api.file.reveal(n.path) });
    if (!n.dir) items.push({ label: 'Duplicate', run: () => duplicateFile(n).catch((e) => toast(e.message, 4000)) });
    items.push({ label: 'Copy path', run: () => { navigator.clipboard.writeText(n.path); toast('Path copied', 900); } });
    if (S.project && n.path.startsWith(S.project.dir)) {
      items.push({ label: 'Copy relative path', run: () => {
        navigator.clipboard.writeText(n.path.slice(S.project.dir.length).replace(/^[\\/]+/, '').replace(/\\/g, '/') || '.');
        toast('Relative path copied', 900);
      } });
    }
    contextMenu(e.clientX, e.clientY, items);
  }

  async function newFileIn(folder) {
    const r = await dialog({ title: 'New file', okLabel: 'Create',
      fields: [{ key: 'name', label: 'File name (e.g. helpers.h, sensors.cpp)', placeholder: 'helpers.h' }] });
    if (!r || !r.name.trim()) return;
    const name = r.name.trim();
    if (/[<>:"|?*]/.test(name)) return toast('That name has characters Windows does not allow');
    const p = joinPath(folder, name);
    if (await api.file.exists(p)) { toast(name + ' already exists — opening it'); return openFile(p, baseName(p)); }
    await api.file.create(p);
    if (/\.h$/i.test(name)) await api.file.write(p, `#pragma once\n// ${name}\n\n`);
    await refreshTree();
    openFile(p, baseName(p));
  }
  async function newFolderIn(folder) {
    const r = await dialog({ title: 'New folder', okLabel: 'Create', fields: [{ key: 'name', label: 'Folder name', placeholder: 'src' }] });
    if (!r || !r.name.trim()) return;
    await api.file.mkdir(joinPath(folder, r.name.trim()));
    refreshTree();
  }
  async function renamePath(n) {
    const r = await dialog({ title: 'Rename', okLabel: 'Rename', fields: [{ key: 'name', label: 'New name', value: n.name }] });
    if (!r || !r.name.trim() || r.name.trim() === n.name) return;
    const to = joinPath(dirName(n.path), r.name.trim());
    if (/\.ino$/i.test(n.name) && S.project && baseName(dirName(n.path)) === n.name.replace(/\.ino$/i, '')) {
      toast('Heads-up: arduino-cli needs the main .ino named after its folder', 4000);
    }
    try {
      await api.file.rename(n.path, to);
      for (const t of S.openTabs) {
        if (t.path === n.path || t.path.startsWith(n.path + sep(n.path))) {
          const np = to + t.path.slice(n.path.length);
          const content = t.model.getValue();
          const lang = langFor(np);
          t.model.dispose();
          t.model = monaco.editor.createModel(content, lang, monaco.Uri.file(np));
          t.savedVersion = t.dirty ? -1 : t.model.getAlternativeVersionId();
          t.model.onDidChangeContent(() => {
            const d = t.model.getAlternativeVersionId() !== t.savedVersion;
            if (d !== t.dirty) { t.dirty = d; renderTabs(); }
            scheduleAutoSave();
          });
          t.path = np; t.name = baseName(np);
          if (t === S.activeTab) S.editor.setModel(t.model);
        }
      }
      await refreshTree();
      renderTabs();
    } catch (e) { toast('Rename failed: ' + e.message, 4000); }
  }
  async function trashPath(n) {
    const r = await confirmDialog('Delete ' + n.name + '?', 'It goes to the Recycle Bin, so you can restore it.', [
      { label: 'Delete', value: true, danger: true }, { label: 'Cancel', value: false, primary: true }]);
    if (!r) return;
    try {
      await api.file.trash(n.path);
      for (const t of S.openTabs.slice()) {
        if (t.path === n.path || t.path.startsWith(n.path + sep(n.path))) { t.dirty = false; await closeTab(t); }
      }
      refreshTree();
    } catch (e) { toast('Delete failed: ' + e.message, 4000); }
  }

  async function refreshTree() {
    if (!S.project) return;
    S.project.tree = await api.project.tree(S.project.dir);
    renderTree();
  }

  // ---- project / board / port chips ---------------------------------------
  async function chooseProject() {
    const projects = await api.project.list();
    const items = [
      { label: '＋ New Arduino sketch…', run: () => newProject('arduino') },
      { label: '＋ New from example…', run: chooseExample },
      { label: '＋ New Raspberry Pi project…', run: () => newProject('pi') },
      { label: '📂 Open folder / Arduino sketch…', run: openFolder },
      ...projects.map((p) => ({
        label: `${typeIcon(p.type)} ${p.name}${p.fqbn ? '  ·  ' + p.fqbn : ''}${p.unmanaged ? '  ·  Arduino sketch' : ''}`,
        run: async () => loadProject(await api.project.open(p.dir).catch((e) => (toast(e.message, 4000), null)))
      }))
    ];
    palette(items, 'Open project…');
  }

  async function openFolder() {
    const dir = await api.project.pickFolder();
    if (dir) loadProject(await api.project.open(dir).catch((e) => (toast(e.message, 5000), null)));
  }

  async function newProject(type, example) {
    const r = await dialog({
      title: example ? 'New project from "' + example.name + '"' : 'New project',
      okLabel: 'Create',
      fields: [
        { key: 'name', label: 'Project name (letters, numbers, - and _)',
          value: example ? example.id.replace(/-/g, '_') : '',
          placeholder: type === 'arduino' || !type ? 'my_sketch' : 'my_' + type + '_project' },
        ...(example ? [] : [{ key: 'type', label: 'Type', options: [
            { value: 'arduino', label: 'Arduino sketch (.ino)' },
            { value: 'micropython', label: 'MicroPython board (main.py)' },
            { value: 'circuitpython', label: 'CircuitPython board (code.py)' },
            { value: 'pi', label: 'Raspberry Pi (Python)' }
          ], value: type || 'arduino' }]),
        { key: 'dir', label: 'Create in', value: S.settings.projectsDir, browse: true }
      ]
    });
    if (!r || !r.name.trim()) return;
    if (r.dir && r.dir !== S.settings.projectsDir) {
      S.settings = await api.settings.set({ projectsDir: r.dir });
    }
    try {
      const proj = await api.project.create({ name: r.name.trim(), type: r.type || type, fqbn: S.fqbn,
                                              example: example ? example.id : undefined });
      await loadProject(proj);
      toast('Created ' + proj.manifest.name);
      if (example && example.libs && example.libs.length) ensureLibraries(example.libs);
    } catch (e) { toast(e.message, 4000); }
  }

  const typeIcon = (t) => ({ pi: '🥧', micropython: '🐍', circuitpython: '🐍' }[t] || '⚡');
  async function chooseExample() {
    const list = await api.project.examples().catch(() => []);
    palette(list.map((ex) => ({
      label: `${typeIcon(ex.type)} ${ex.name} — ${ex.desc}`,
      run: () => newProject(ex.type, ex)
    })), 'New project from example…');
  }

  // libraries an example/project needs: installed in the background, once
  async function ensureLibraries(libs) {
    const have = await api.toolchain.libInstalled().catch(() => []);
    for (const name of libs) {
      if (have.some((l) => (l.name || '').toLowerCase() === name.toLowerCase())) continue;
      toast('Installing library ' + name + '…', 2500);
      const r = await api.toolchain.libInstall(name).catch((e) => ({ ok: false, err: e.message }));
      logTo('outputLog', r.ok ? '✓ installed library ' + name : '✗ library ' + name + ': ' + (r.err || 'failed'), r.ok ? 'meta' : 'err');
    }
  }

  async function loadProject(proj) {
    if (!proj) return;
    S.restoring = true;
    try { await loadProjectInner(proj); } finally { S.restoring = false; saveSession(); }
  }
  async function loadProjectInner(proj) {
    // leaving a project: offer to save its open files, then close them
    const dirty = S.openTabs.filter((t) => t.dirty);
    if (S.project && S.project.dir !== proj.dir && dirty.length) {
      const r = await confirmDialog('Unsaved changes', `${dirty.length} file(s) in ${S.project.manifest.name} have unsaved changes.`, [
        { label: 'Save all', value: 'save', primary: true }, { label: "Don't save", value: 'discard', danger: true },
        { label: 'Cancel', value: null }]);
      if (!r) return;
      if (r === 'save') await saveAll(true);
    }
    if (S.project && S.project.dir !== proj.dir) {
      for (const t of S.openTabs) t.model.dispose();
      S.openTabs = [];
      S.activeTab = null;
      setDiagnostics([]);
    }
    S.project = proj;
    $('btnProject').textContent = proj.manifest.name;
    updateTitle();
    if (proj.manifest.fqbn) setFqbn(proj.manifest.fqbn, null, true);
    if (proj.manifest.type === 'pi') setBoardView('pi');
    if (PY_TYPES[proj.manifest.type]) $('btnBoard').textContent = PY_TYPES[proj.manifest.type];
    if (!$('view-git').classList.contains('on')) S.gitDirty = true; else renderGit();
    if (proj.manifest.imported) toast('Opened Arduino sketch ' + proj.manifest.name + ' — ElectriCAD project file added', 3500);
    renderTree();
    // open the main file: the .ino named after the folder first
    const folder = baseName(proj.dir);
    const files = proj.tree.filter((n) => !n.dir);
    const main = files.find((n) => n.name === folder + '.ino') || files.find((n) => n.name === 'code.py' || n.name === 'main.py') ||
                 files.find((n) => /\.(ino|py)$/i.test(n.name));
    if (main) await openFile(main.path, main.name);
    else activateTab(S.activeTab);
    await restoreSession(proj);
    if (PinodeWiring.isActive()) PinodeWiring.onProjectChange();
  }

  function setFqbn(fqbn, label, fromProject) {
    S.fqbn = fqbn;
    $('btnBoard').textContent = label || fqbn || 'Select board';
    $('btnBoard').title = fqbn ? 'FQBN: ' + fqbn : 'Board (FQBN)';
    for (const def of Object.values(PINODE_BOARDS)) {
      if (fqbn && def.fqbnMatch.test(fqbn)) {
        // the board's FQBN names the exact revision when it can (UNO R3 / R4 Minima / R4 WiFi)
        const r = (def.revisions || []).find((x) => x.fqbn && x.fqbn.test(fqbn));
        if (r) { BV.rev[def.id] = r.id; saveBV(); }
        setBoardView(def.id); break;
      }
    }
    renderStatusBoard();
    if (typeof recheckPins === 'function' && S.openTabs) recheckPins();
    if (!fqbn) return;
    // remember it: globally for the next launch, and in the project manifest
    if (S.settings && S.settings.lastFqbn !== fqbn) api.settings.set({ lastFqbn: fqbn }).then((st) => { S.settings = st; });
    if (!fromProject && S.project && S.project.manifest.fqbn !== fqbn) {
      S.project.manifest.fqbn = fqbn;
      api.project.update(S.project.dir, { fqbn }).catch(() => {});
    }
  }

  async function chooseBoard() {
    const detected = await api.toolchain.boards().catch(() => []);
    const items = [];
    for (const p of detected) {
      for (const b of p.boards) {
        items.push({ label: `● ${b.name} — ${p.address}`, run: () => { setFqbn(b.fqbn, b.name); setPort(p.address); } });
      }
    }
    const common = [
      ['Arduino Uno', 'arduino:avr:uno'], ['Arduino Nano', 'arduino:avr:nano'],
      ['Arduino Nano (old bootloader — most clones)', 'arduino:avr:nano:cpu=atmega328old'],
      ['Arduino Mega 2560', 'arduino:avr:mega'], ['ESP32 Dev Module', 'esp32:esp32:esp32'],
      ['NodeMCU 1.0 (ESP8266)', 'esp8266:esp8266:nodemcuv2'], ['Raspberry Pi Pico', 'rp2040:rp2040:rpipico'],
      ['Adafruit Feather RP2040', 'rp2040:rp2040:adafruit_feather'], ['Adafruit Feather M4 Express', 'adafruit:samd:adafruit_feather_m4'],
      ['Adafruit Feather M0', 'adafruit:samd:adafruit_feather_m0'], ['Adafruit Feather ESP32 (HUZZAH32)', 'esp32:esp32:featheresp32']
    ];
    for (const [name, fqbn] of common) items.push({ label: `${S.fqbn === fqbn ? '✓' : '○'} ${name}  ·  ${fqbn}`, run: () => setFqbn(fqbn, name) });
    items.push({ label: '⟳ All installed boards…', run: async () => {
      const all = await api.toolchain.knownBoards().catch(() => []);
      if (!all.length) return toast('No board list yet — the toolchain is still setting up');
      palette(all.map((b) => ({ label: b.name + '  ·  ' + b.fqbn, run: () => setFqbn(b.fqbn, b.name) })), 'Board…');
    } });
    items.push({ label: '✎ Enter an FQBN (with options)…', run: async () => {
      const r = await dialog({ title: 'Board FQBN', fields: [{ key: 'f', label: 'vendor:arch:board[:option=value,…]', value: S.fqbn, placeholder: 'esp32:esp32:esp32:PartitionScheme=huge_app' }] });
      if (r && r.f.trim()) setFqbn(r.f.trim());
    } });
    palette(items, 'Board…');
  }

  function setPort(p) { S.port = p; renderDeviceChip(); renderStatusBoard(); }

  function renderStatusBoard() {
    const el = $('stBoard');
    if (!el) return;
    el.textContent = (S.fqbn ? S.fqbn.split(':').slice(0, 3).join(':') : 'no board') + (S.port ? ' on ' + S.port : '');
  }

  function renderDeviceChip() {
    const sel = S.devices.find((d) => d.id === S.selectedId);
    const n = S.devices.length;
    $('btnPort').textContent = sel
      ? `${sel.name}${sel.kind === 'serial' ? ' · ' + sel.path : ''}`
      : (S.port ? S.port : (n ? `${n} device${n > 1 ? 's' : ''} detected` : 'No devices'));
  }

  async function selectDevice(d) {
    S.selectedId = d.id;
    if (d.boardId) setBoardView(d.boardId);
    if (d.kind === 'serial') {
      setPort(d.path);
      if (d.fqbn && !S.fqbn) setFqbn(d.fqbn, d.name);
      await api.serial.open({ path: d.path, baud: S.settings.serialBaud }).catch((e) => toast(e.message, 5000));
    } else if (d.kind === 'pi') {
      S.settings = await api.settings.set({ pi: { host: d.host } });
      await api.pi.connect({ host: d.host, port: (S.settings.pi && S.settings.pi.port) || 8888 }).catch((e) => toast('Pi: ' + e.message, 4000));
    }
    renderDeviceChip();
  }

  function deviceMenu() {
    if (!S.devices.length) {
      return palette([{ label: 'No boards detected — plug one in (scanning continuously)', run: () => {} },
                      { label: 'Connect to a Raspberry Pi by address…', run: connectPi }], 'Devices…');
    }
    palette(S.devices.map((d) => ({
      label: `${d.kind === 'pi' ? '🥧' : '⚡'} ${d.name}` +
             `${d.kind === 'serial' ? '  ·  ' + d.path : ''}` +
             `${d.chip ? '  ·  ' + d.chip : ''}` +
             `${d.fqbn ? '  ·  ' + d.fqbn : ''}` +
             `${d.id === S.selectedId ? '  ✓' : ''}`,
      run: () => selectDevice(d)
    })).concat([
      { label: '🥧 Connect to a Raspberry Pi by address…', run: connectPi },
      { label: '✕ Close all serial ports', run: () => api.serial.close() }
    ]), 'Devices…');
  }

  // continuous discovery — every board and chip, all at once
  let lastDeviceIds = new Set();
  let lastDevices = [];
  api.on('devices:update', (list) => {
    const ids = new Set(list.map((d) => d.id));
    // auto-reconnect: the open board was unplugged and is back on the same port
    if (!S.uploading && S.port) {
      const had = lastDevices.some((d) => d.path === S.port), has = list.some((d) => d.path === S.port);
      if (had && !has && S.serial.bauds && S.serial.bauds[S.port]) S.reconnectPort = S.port;
      if (!had && has && S.reconnectPort === S.port && (!S.settings.serial || S.settings.serial.autoReconnect !== false)) {
        S.reconnectPort = null;
        setTimeout(() => api.serial.open({ path: S.port, baud: S.settings.serialBaud }).then(() => pushSerial('— reconnected to ' + S.port + ' —', 'meta')).catch(() => {}), 600);
      }
    }
    lastDevices = list;
    for (const d of list) if (!lastDeviceIds.has(d.id) && lastDeviceIds.size) toast('🔌 Connected: ' + d.name, 2200);
    for (const id of lastDeviceIds) if (!ids.has(id)) {
      toast('Disconnected: ' + id, 2200);
      if (id === S.selectedId) S.selectedId = '';
    }
    lastDeviceIds = ids;
    S.devices = list;
    renderDeviceChip();
    updateBoardPower();
    // auto-adopt: exactly one recognized device and nothing selected yet
    if (!S.selectedId && !S.uploading) {
      const known = list.filter((d) => d.alive && (d.fqbn || d.chip || d.kind === 'pi'));
      if (known.length === 1) {
        toast('Detected ' + known[0].name);
        selectDevice(known[0]);
      }
    }
    $('stSerial').textContent = 'devices: ' + list.length;
    if (document.querySelector('#view-catalog.on')) renderBench();
  });

  // ---- build / upload ------------------------------------------------------
  function setBuilding(label) {
    S.building = !!label;
    $('buildState').textContent = label || '';
    $('buildState').classList.toggle('hidden', !label);
    $('btnCancel').classList.toggle('hidden', !label);
    $('btnVerify').disabled = !!label;
    $('btnUpload').disabled = !!label;
  }

  async function verify(opts = {}) {
    if (!S.project) { toast('Open or create a project first (Ctrl+O / Ctrl+N)'); return false; }
    if (S.project.manifest.type === 'pi') { toast('Raspberry Pi projects run on the Pi — nothing to compile here'); return false; }
    if (isPyBoard()) { if (!opts.quiet) upyRun(); return false; }
    if (!S.fqbn) { toast('Pick a board first'); chooseBoard(); return false; }
    if (S.building) return false;
    await saveAll(true);
    setBuilding(opts.clean ? 'clean build…' : 'compiling…');
    buildProgress(true);
    logTo('outputLog', `— ${opts.clean ? 'clean build' : 'verify'} ${S.project.manifest.name} [${S.fqbn}] —`, 'meta');
    const b = (S.settings && S.settings.build) || {};
    let r;
    try {
      const m = S.project.manifest || {};
      r = await api.toolchain.compile({ sketchDir: S.project.dir, fqbn: opts.fqbn || S.fqbn, warnings: b.warnings || 'default',
                                        verbose: !!b.verbose, clean: !!opts.clean, extraFlags: m.buildFlags || '', defines: m.defines || [] });
      if (r && r.ok && r.buildPath && !opts.fqbn) S.lastBuild = { dir: S.project.dir, fqbn: S.fqbn, buildPath: r.buildPath, at: Date.now() };
    } catch (e) {
      buildProgress(false);
      setBuilding(null);
      logTo('outputLog', '✗ ' + e.message, 'err');
      toast('✗ Toolchain error — see Output', 4000);
      return false;
    }
    if (!opts.keepBusy || !r.ok) { setBuilding(null); buildProgress(false); }
    setDiagnostics(r.diagnostics || []);
    if (r.raw) logTo('outputLog', r.raw);
    showMemory(r.memory);
    if (r.cancelled) { toast('Build cancelled'); return false; }
    if (r.ok) {
      const mem = r.memory && r.memory.flash ? ` · flash ${r.memory.flash.pct}%` + (r.memory.ram ? `, RAM ${r.memory.ram.pct}%` : '') : '';
      logTo('outputLog', `✓ compiled in ${r.seconds.toFixed(1)}s${mem}`, 'meta');
      // what changed since the last build of this sketch on this board
      if (r.memory && r.memory.flash) {
        const key = S.project.dir + '|' + S.fqbn;
        S.lastSizes = S.lastSizes || {};
        const prev = S.lastSizes[key];
        if (prev) {
          const d = (a, b2) => (a == null || b2 == null ? null : a - b2);
          const df = d(r.memory.flash.used, prev.flash), dr = d(r.memory.ram && r.memory.ram.used, prev.ram);
          const fmt = (x) => (x > 0 ? '+' : '') + x + ' B';
          if (df || dr) logTo('outputLog', `  since last build: flash ${df != null ? fmt(df) : '—'}${dr != null ? ', RAM ' + fmt(dr) : ''}`, 'meta');
        }
        S.lastSizes[key] = { flash: r.memory.flash.used, ram: r.memory.ram ? r.memory.ram.used : null };
      }
      const pins = await pinCheckReport(true);
      for (const d of pins) logTo('outputLog', `△ pin check  ${d.file.name}:${d.line}  ${d.message}`, d.severity === 'error' ? 'err' : 'warn');
      if (!opts.keepBusy) notifyDone('Compiled ' + S.project.manifest.name, `${r.seconds.toFixed(1)} s${mem}`);
      if (!opts.quiet) toast(`✓ Compiled in ${r.seconds.toFixed(1)}s${mem}`);
      if (r.memory && r.memory.ram && r.memory.ram.pct >= 80) {
        logTo('outputLog', `△ RAM ${r.memory.ram.pct}% used — under ~20% free, the stack can collide with globals at runtime (random resets). Move strings to flash with F("…").`, 'warn');
      }
    } else {
      toast('✗ Compile failed — see Problems');
      showPanel('problems');
      notifyDone('Compile failed', S.project.manifest.name);
    }
    return r.ok;
  }

  function showMemory(m) {
    S.memory = m || null;
    const el = $('stMemory');
    if (!m || !m.flash) { el.classList.add('hidden'); return; }
    for (const k of ['flash', 'ram']) if (m[k] && m[k].max && m[k].pct == null) m[k].pct = Math.round((m[k].used / m[k].max) * 1000) / 10;
    const part = (k, label) => m[k] ? `${label} ${U.fmtBytes(m[k].used)}${m[k].max ? ' / ' + U.fmtBytes(m[k].max) + ' (' + m[k].pct + '%)' : ''}` : '';
    el.textContent = [part('flash', 'flash'), part('ram', 'RAM')].filter(Boolean).join(' · ');
    el.className = (m.ram && m.ram.pct >= 80) || (m.flash.pct >= 95) ? 'warn' : '';
  }

  async function upload(opts = {}) {
    if (!S.project) return toast('Open or create a project first');
    if (isPyBoard()) return upyUpload();
    if (!S.port) { toast('Pick a device first'); deviceMenu(); return; }
    let inputDir = null;
    if (opts.lastBuild) {
      const lb = S.lastBuild;
      if (!lb || lb.dir !== S.project.dir || lb.fqbn !== S.fqbn) return toast('No build of this sketch for this board yet. Verify first.', 3000);
      if (S.openTabs.some((t) => t.dirty)) toast('Unsaved edits are NOT in the last build', 2500);
      inputDir = lb.buildPath;
      setBuilding('uploading…'); buildProgress(true);
    } else if (!(await verify({ keepBusy: true, quiet: true }))) return;
    S.uploading = true;
    setBuilding('uploading…');
    const port = S.port;
    const wasOpen = true;
    await api.serial.close(port).catch(() => {});   // free just this port
    logTo('outputLog', `— upload to ${port} —`, 'meta');
    if (S.settings.serial && S.settings.serial.clearOnUpload) clearSerial();
    let r;
    uploadLeds(true);
    try {
      r = await api.toolchain.upload({ sketchDir: S.project.dir, fqbn: S.fqbn, port, inputDir });
    } catch (e) { r = { ok: false, raw: e.message }; }
    uploadLeds(false);
    S.uploading = false;
    setBuilding(null);
    buildProgress(false);
    notifyDone(r.ok ? 'Uploaded ' + S.project.manifest.name : 'Upload failed', port);
    if (r.ok && S.settings.serial && S.settings.serial.showAfterUpload) showPanel('serial');
    if (r.raw) logTo('outputLog', r.raw);
    if (r.hint) logTo('outputLog', '💡 ' + r.hint, 'warn');
    toast(r.ok ? '▶ Uploaded' : r.cancelled ? 'Upload cancelled' : '✗ Upload failed — see Output', r.ok ? 2600 : 4500);
    if (!r.ok) showPanel('output');
    // native-USB boards (32u4, SAMD, ESP32-S2/S3, RP2040) re-enumerate after
    // flashing; give the port a moment and retry before giving up
    if (wasOpen) reopenPort(port, 6);
  }

  async function reopenPort(port, tries) {
    for (let i = 0; i < tries; i++) {
      await new Promise((res) => setTimeout(res, i === 0 ? 400 : 700));
      try { await api.serial.open({ path: port, baud: S.serial.bauds[port] || S.settings.serialBaud }); return true; }
      catch (e) { /* not back yet */ }
    }
    logTo('serialLog', `⚠ ${port} did not come back after upload — pick the device again if it moved to a new port`, 'meta');
    return false;
  }

  async function cancelBuild() {
    const n = await api.toolchain.cancel().catch(() => 0);
    if (!n) toast('Nothing running', 900);
  }

  function applyMarkers(tab) {
    if (!tab || !window.monaco) return;
    const norm = (p) => String(p).replace(/\//g, '\\').toLowerCase();
    const mine = S.diagnostics.filter((d) => norm(d.file) === norm(tab.path));
    monaco.editor.setModelMarkers(tab.model, 'electricad', mine.map((d) => ({
      startLineNumber: d.line, endLineNumber: d.line, startColumn: d.col,
      endColumn: tab.model.getLineMaxColumn(Math.min(d.line, tab.model.getLineCount())),
      message: d.message,
      severity: d.severity === 'error' ? monaco.MarkerSeverity.Error
              : d.severity === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info
    })));
  }

  function setDiagnostics(diags) {
    S.diagnostics = diags;
    const inSketch = diags.filter((d) => d.inSketch);
    const n = inSketch.filter((d) => d.severity === 'error').length;
    const badge = $('problemCount');
    badge.textContent = n || '';
    badge.className = 'badge' + (n ? '' : ' off');
    const box = $('problemsList');
    box.innerHTML = '';
    if (!diags.length) box.innerHTML = '<p class="dim">No problems. ✓</p>';
    // sketch problems first, errors before warnings
    const rank = (d) => (d.inSketch ? 0 : 2) + (d.severity === 'error' ? 0 : 1);
    for (const d of diags.slice().sort((a, b) => rank(a) - rank(b))) {
      if (d.severity === 'note') continue;
      const div = document.createElement('div');
      div.className = 'problem ' + (d.severity === 'error' ? 'err' : 'warn') + (d.inSketch ? '' : ' external');
      div.innerHTML = `<span>${esc(d.severity)}: ${esc(baseName(d.file))}:${d.line}${d.col ? ':' + d.col : ''} — ${esc(d.message)}</span>`;
      div.style.cursor = 'pointer';
      div.addEventListener('click', async () => {
        const tab = await openFile(d.file);
        if (!tab) return;
        S.editor.revealLineInCenter(d.line);
        S.editor.setPosition({ lineNumber: d.line, column: d.col || 1 });
        S.editor.focus();
      });
      const actions = document.createElement('span');
      actions.className = 'pactions';
      if (d.missingHeader) {
        const b = document.createElement('button');
        b.className = 'mini';
        b.textContent = '📚 Find library for ' + d.missingHeader;
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          document.querySelector('.act[data-view="libs"]').click();
          $('libBox').value = d.missingHeader.replace(/\.h$/, '');
          libSearch();
        });
        actions.appendChild(b);
      }
      const ask = document.createElement('button');
      ask.className = 'mini';
      ask.textContent = '✨ Explain';
      ask.title = 'Ask the AI copilot to explain and fix this';
      ask.addEventListener('click', (e) => {
        e.stopPropagation();
        aiAsk(`Explain this compiler ${d.severity} and show the fix:\n${baseName(d.file)}:${d.line}${d.col ? ':' + d.col : ''}: ${d.message}`);
      });
      actions.appendChild(ask);
      if (d.inSketch && d.severity === 'error') {
        const fix = document.createElement('button');
        fix.className = 'mini';
        fix.textContent = '🔧 Fix';
        fix.title = 'Ask the copilot for the corrected code (Insert puts it in the editor)';
        fix.addEventListener('click', (e) => { e.stopPropagation(); aiFix(d); });
        actions.appendChild(fix);
      }
      div.appendChild(actions);
      box.appendChild(div);
    }
    for (const t of S.openTabs) applyMarkers(t);
  }

  // ---- MicroPython / CircuitPython ------------------------------------------
  // Python boards ride the same serial port as the monitor. F5 runs the file
  // through the raw REPL (output streams into the monitor), Upload saves the
  // project to the board: main.py over the REPL for MicroPython, a copy onto
  // the CIRCUITPY drive for CircuitPython.
  const PY_TYPES = { micropython: 'MicroPython', circuitpython: 'CircuitPython' };
  const projType = () => (S.project ? S.project.manifest.type : '');
  const isPyBoard = () => !!PY_TYPES[projType()];

  async function pyPort() {
    if (!S.port) { toast('Pick the board\'s serial port first'); deviceMenu(); return null; }
    await api.serial.open({ path: S.port, baud: 115200 }).catch(() => {});
    return S.port;
  }
  function pyMainFile() {
    const want = projType() === 'circuitpython' ? 'code.py' : 'main.py';
    const t = S.activeTab && /\.py$/i.test(S.activeTab.name) ? S.activeTab : null;
    if (t) return t;
    return S.openTabs.find((x) => x.name === want) || null;
  }
  async function upyRun() {
    if (!S.project) return toast('Open a project first');
    const port = await pyPort();
    if (!port) return;
    let tab = pyMainFile();
    let code;
    if (tab) code = tab.model.getValue();
    else {
      const f = (S.project.tree || []).find((n) => !n.dir && /\.py$/i.test(n.name));
      if (!f) return toast('No .py file in this project');
      code = await api.file.read(f.path);
      tab = { name: f.name };
    }
    await saveAll(true);
    setBuilding('running…');
    showPanel('serial');
    pushSerial(`— running ${tab.name} on ${port} (Shift+F5 stops) —`, 'meta');
    try { await api.upy.run(port, code); toast('▶ Running ' + tab.name, 1400); }
    catch (e) { pushSerial('⚠ ' + e.message, 'meta'); toast(e.message, 5000); }
    setBuilding(null);
  }
  async function upyStop() {
    if (!S.port) return;
    await api.upy.interrupt(S.port).catch((e) => toast(e.message));
    pushSerial('— stopped —', 'meta');
  }
  async function upySoftReset() {
    if (!S.port) return toast('No board port selected');
    await api.upy.softReset(S.port).catch((e) => toast(e.message));
    pushSerial('— soft reset —', 'meta');
  }
  async function upyUpload() {
    if (!S.project) return toast('Open a project first');
    await saveAll(true);
    const files = (S.project.tree || []).filter((n) => !n.dir && /\.(py|mpy|txt|json|csv)$/i.test(n.name));
    if (!files.length) return toast('No files to upload');
    if (projType() === 'circuitpython') {
      const drives = await api.upy.drives().catch(() => []);
      if (!drives.length) return infoDialog('CIRCUITPY drive not found',
        '<p>Plug the board in over a data USB cable. CircuitPython boards show up as a drive named <b>CIRCUITPY</b>; ElectriCAD finds it by its <code>boot_out.txt</code>.</p><p class="dim">No drive at all? The board may be running MicroPython or Arduino firmware. Double-tap reset for the UF2 bootloader and drag the CircuitPython .uf2 for your board onto it.</p>');
      let drive = drives[0];
      if (drives.length > 1) {
        drive = await new Promise((res) => palette(drives.map((d) => ({ label: `${d.root}  ${d.board} · CircuitPython ${d.version}`, run: () => res(d) })), 'Which board?'));
        if (!drive) return;
      }
      for (const f of files) await api.upy.copyToDrive(drive.root, f.name, await api.file.read(f.path));
      // the project's lib/ folder (Adafruit bundle libraries) goes along too
      let libMsg = '';
      if ((S.project.tree || []).some((n) => n.dir && n.name === 'lib')) {
        const lr = await api.upy.copyDir(drive.root, S.project.dir, 'lib').catch((e) => ({ error: e.message }));
        libMsg = lr.error ? ' (lib/ failed: ' + lr.error + ')' : ` + lib/ (${lr.copied} updated, ${lr.skipped} unchanged)`;
      }
      toast(`✓ Copied ${files.length} file${files.length > 1 ? 's' : ''}${libMsg} to ${drive.root} (${drive.board}). The board restarts by itself.`, 4000);
      logTo('outputLog', `✓ ${files.map((f) => f.name).join(', ')}${libMsg} → ${drive.root}`, 'meta');
      return;
    }
    const port = await pyPort();
    if (!port) return;
    setBuilding('uploading…');
    try {
      // check every .py with the board's own parser first: a typo must never
      // replace a main.py that works
      for (const f of files.filter((x) => /\.py$/i.test(x.name))) {
        const chk = await api.upy.syntax(port, f.name, await api.file.read(f.path)).catch(() => ({ ok: true, unchecked: true }));
        if (!chk.ok) {
          setBuilding(null);
          logTo('outputLog', `✗ ${f.name}:${chk.line} SyntaxError: ${chk.message}. Nothing was uploaded.`, 'err');
          toast(`✗ ${f.name} line ${chk.line}: ${chk.message}. Nothing was uploaded.`, 6000);
          const tab = await openFile(f.path);
          if (tab && chk.line) { S.editor.revealLineInCenter(chk.line); S.editor.setPosition({ lineNumber: chk.line, column: 1 }); }
          return;
        }
      }
      for (const f of files) {
        const content = await api.file.read(f.path);
        const r = await api.upy.upload(port, f.name, content);
        logTo('outputLog', `✓ ${f.name} → board (${r.bytes} bytes)`, 'meta');
      }
      toast('✓ Uploaded ' + files.length + ' file' + (files.length > 1 ? 's' : '') + '. Soft-resetting to start main.py…', 3000);
      await api.upy.softReset(port);
    } catch (e) {
      logTo('outputLog', '✗ ' + e.message, 'err');
      toast('Upload failed: ' + e.message, 6000);
    }
    setBuilding(null);
  }
  async function upyFiles() {
    const port = await pyPort();
    if (!port) return;
    let list;
    try { list = await api.upy.ls(port); } catch (e) { return toast(e.message, 5000); }
    palette(list.map((f) => ({
      label: `${f.dir ? '📁' : '📄'} ${f.name}${f.dir ? '' : '  ·  ' + U.fmtBytes(f.size)}`,
      run: () => !f.dir && palette([
        { label: '✎ Edit on the board (Ctrl+S writes it back)', run: () => upyEditBoardFile(port, f.name) },
        { label: '⬇ Copy into the project and open', run: async () => {
          if (!S.project) return toast('Open a project first');
          const text = await api.upy.read(port, f.name).catch((e) => (toast(e.message), null));
          if (text == null) return;
          const p = joinPath(S.project.dir, f.name);
          if (await api.file.exists(p)) {
            const ok = await confirmDialog('Overwrite?', f.name + ' already exists in the project. Replace it with the board\'s copy?',
              [{ label: 'Cancel', value: false }, { label: 'Replace', value: true, danger: true }]);
            if (!ok) return;
          }
          await api.file.write(p, text);
          await refreshTree();
          openFile(p, f.name);
        } },
        { label: '🗑 Delete from the board', run: async () => {
          const ok = await confirmDialog('Delete from board', 'Delete ' + f.name + ' from the board\'s flash? This can\'t be undone.',
            [{ label: 'Cancel', value: false }, { label: 'Delete', value: true, danger: true }]);
          if (ok) { await api.upy.rm(port, f.name).catch((e) => toast(e.message)); toast('Deleted ' + f.name); }
        } }
      ], f.name)
    })), list.length + ' files on the board');
  }
  async function upyInfo() {
    const port = await pyPort();
    if (!port) return;
    const drives = await api.upy.drives().catch(() => []);
    try {
      const i = await api.upy.info(port);
      infoDialog('Board info', `<p><b>${esc(i.impl)}</b> ${esc(i.version)}</p><p>${esc(i.machine)}</p>` +
        (drives.length ? '<p class="dim">' + drives.map((d) => `${esc(d.root)} · CircuitPython ${esc(d.version)} · ${esc(d.board)}`).join('<br>') + '</p>' : ''));
    } catch (e) { toast(e.message, 5000); }
  }

  // ---- source control (git) ------------------------------------------------
  let gitBusy = false;
  async function renderGit() {
    const box = $('gitPanel');
    if (!box) return;
    if (!S.project) { box.innerHTML = '<p class="dim">Open a project to see its changes.</p>'; return; }
    const st = await api.git.status(S.project.dir).catch((e) => ({ available: true, repo: false, error: e.message }));
    box.innerHTML = '';
    if (!st.available) {
      box.innerHTML = '<p class="dim">Git isn\'t installed. Install <b>Git for Windows</b>, then reopen this panel.</p>';
      const b = document.createElement('button'); b.className = 'mini'; b.style.margin = '0 10px';
      b.textContent = 'Get Git for Windows ↗'; b.addEventListener('click', () => api.openExternal('https://git-scm.com/download/win'));
      box.appendChild(b); return;
    }
    if (!st.repo) {
      box.innerHTML = '<p class="dim">This project isn\'t under version control yet. A repository keeps every version of your sketch, so you can always see what changed.</p>';
      const b = document.createElement('button'); b.className = 'action'; b.style.margin = '4px 10px';
      b.textContent = 'Initialize repository';
      b.addEventListener('click', async () => { await api.git.init(S.project.dir).catch((e) => toast(e.message)); renderGit(); });
      box.appendChild(b); return;
    }
    const head = document.createElement('div');
    head.className = 'git-branch';
    head.textContent = '⎇ ' + st.branch + (st.upstream ? `  ↑${st.ahead} ↓${st.behind}` : '');
    head.title = 'Click to switch or create a branch';
    head.style.cursor = 'pointer';
    head.addEventListener('click', gitBranchMenu);
    box.appendChild(head);
    const msg = document.createElement('textarea');
    msg.id = 'gitMsg'; msg.className = 'input git-msg';
    msg.placeholder = 'Commit message (Ctrl+Enter commits all changes)';
    msg.value = S.gitDraft || '';
    msg.addEventListener('input', () => { S.gitDraft = msg.value; });
    const doCommit = async () => {
      if (gitBusy) return;
      gitBusy = true;
      try {
        await saveAll(true);
        const anyStaged = st.files.some((f) => f.staged);
        await api.git.commit(S.project.dir, msg.value, !anyStaged);
        S.gitDraft = '';
        toast('✓ Committed', 1400);
      } catch (e) {
        if (/name yet/.test(e.message)) gitIdentity(); else toast(e.message, 4000);
      }
      gitBusy = false;
      renderGit();
    };
    msg.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doCommit(); } });
    box.appendChild(msg);
    const row = document.createElement('div'); row.className = 'git-row';
    const cbtn = document.createElement('button'); cbtn.className = 'action primary';
    const staged = st.files.filter((f) => f.staged).length;
    cbtn.textContent = staged ? `✓ Commit ${staged} staged` : `✓ Commit all (${st.files.length})`;
    cbtn.disabled = !st.files.length;
    cbtn.addEventListener('click', doCommit);
    const rbtn = document.createElement('button'); rbtn.className = 'mini'; rbtn.textContent = '⟳';
    rbtn.title = 'Refresh'; rbtn.addEventListener('click', renderGit);
    row.appendChild(cbtn); row.appendChild(rbtn);
    box.appendChild(row);
    const net = document.createElement('div'); net.className = 'git-row';
    const nb = (label, title, fn) => { const b = document.createElement('button'); b.className = 'mini'; b.textContent = label; b.title = title; b.addEventListener('click', fn); net.appendChild(b); return b; };
    nb('⇡ Push', st.upstream ? `Send ${st.ahead} commit${st.ahead === 1 ? '' : 's'} to ${st.upstream}` : 'Push this branch (sets the upstream the first time)', () => gitNet('push'));
    nb('⇣ Pull', 'Get new commits from the remote (fast-forward only, never a surprise merge)', () => gitNet('pull'));
    nb('⟲ Fetch', 'Check the remote for new commits without changing your files', () => gitNet('fetch'));
    nb('🔗 Remote…', 'Set the URL of the remote (origin)', gitSetRemote);
    box.appendChild(net);
    const KIND = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U', conflict: '!' };
    const group = (title, files, isStaged) => {
      if (!files.length) return;
      const h = document.createElement('div'); h.className = 'view-head git-group'; h.textContent = title + ' (' + files.length + ')';
      const all = document.createElement('button'); all.className = 'mini';
      all.textContent = isStaged ? '− all' : '+ all';
      all.title = isStaged ? 'Unstage everything' : 'Stage everything';
      all.addEventListener('click', async () => {
        await (isStaged ? api.git.unstage(S.project.dir, []) : api.git.stage(S.project.dir, [])).catch((er) => toast(er.message));
        renderGit();
      });
      h.appendChild(all);
      box.appendChild(h);
      for (const f of files) {
        const d = document.createElement('div');
        d.className = 'git-file k-' + f.kind;
        d.innerHTML = `<span class="git-k">${KIND[f.kind] || '?'}</span><span class="git-name">${esc(f.path)}</span>`;
        const act = document.createElement('button'); act.className = 'mini';
        act.textContent = isStaged ? '−' : '+';
        act.title = isStaged ? 'Unstage' : 'Stage';
        act.addEventListener('click', async (e) => {
          e.stopPropagation();
          await (isStaged ? api.git.unstage(S.project.dir, [f.path]) : api.git.stage(S.project.dir, [f.path])).catch((er) => toast(er.message));
          renderGit();
        });
        if (!isStaged && f.kind !== 'untracked') {
          const undo = document.createElement('button'); undo.className = 'mini';
          undo.textContent = '↶'; undo.title = 'Discard changes (back to the last commit)';
          undo.addEventListener('click', async (e) => {
            e.stopPropagation();
            const ok = await confirmDialog('Discard changes', `Throw away your changes to ${f.path} and go back to the last committed version? This can't be undone.`,
              [{ label: 'Cancel', value: null }, { label: 'Discard', value: 'go', danger: true }]);
            if (ok !== 'go') return;
            const open = S.openTabs.find((t) => t.path.replace(/\\/g, '/').endsWith('/' + f.path));
            await api.git.discard(S.project.dir, [f.path]).catch((er) => toast(er.message, 4000));
            if (open) { const txt = await api.file.read(open.path).catch(() => null); if (txt != null) { open.model.setValue(txt); open.savedVersion = open.model.getAlternativeVersionId(); open.dirty = false; renderTabs(); } }
            renderGit();
          });
          d.appendChild(undo);
        }
        d.appendChild(act);
        d.title = 'Click to see what changed';
        d.addEventListener('click', () => gitShowDiff(f, isStaged));
        box.appendChild(d);
      }
    };
    group('STAGED', st.files.filter((f) => f.staged), true);
    group('CHANGES', st.files.filter((f) => !f.staged), false);
    if (!st.files.length) {
      const p = document.createElement('p'); p.className = 'dim'; p.textContent = 'Nothing changed since the last commit.';
      box.appendChild(p);
    }
    const log = await api.git.log(S.project.dir, 25).catch(() => []);
    if (log.length) {
      const h = document.createElement('div'); h.className = 'view-head'; h.textContent = 'HISTORY';
      box.appendChild(h);
      for (const c of log) {
        const d = document.createElement('div'); d.className = 'git-commit';
        d.innerHTML = `<span class="git-hash">${esc(c.short)}</span> ${esc(c.subject)}<div class="dim2">${esc(c.date)} · ${esc(c.author)}</div>`;
        d.title = 'Click to see what this commit changed';
        d.style.cursor = 'pointer';
        d.addEventListener('click', () => gitCommitDetails(c));
        box.appendChild(d);
      }
    }
  }
  let gitNetBusy = false;
  async function gitNet(op) {
    if (!S.project || gitNetBusy) return;
    gitNetBusy = true;
    const label = { push: 'Pushing', pull: 'Pulling', fetch: 'Fetching' }[op];
    toast(label + '…', 8000);
    try {
      if (op !== 'fetch') await saveAll(true);
      const r = await api.git[op](S.project.dir);
      if (r && r.log) logTo('outputLog', '— git ' + op + ' —\n' + r.log, 'meta');
      const st = r && r.status;
      toast(op === 'fetch' ? (st && st.behind ? `${st.behind} new commit${st.behind === 1 ? '' : 's'} on the remote. Pull to get them.` : 'Up to date with the remote') :
            op === 'pull' ? '✓ Pulled' : '✓ Pushed', 2400);
      if (op === 'pull') await reloadOpenTabsFromDisk();
    } catch (e) { toast('git ' + op + ': ' + e.message, 6000); }
    gitNetBusy = false;
    renderGit();
  }
  async function gitSetRemote() {
    if (!S.project) return;
    const cur = await api.git.remotes(S.project.dir).catch(() => ({}));
    const r = await dialog({ title: 'Git remote', okLabel: 'Save', fields: [{ key: 'url', label: 'URL of origin (https://github.com/you/repo.git)', value: cur.origin || '' }] });
    if (!r || !r.url.trim()) return;
    try { await api.git.setRemote(S.project.dir, r.url.trim()); toast('Remote set. Push sends your commits there.', 2200); }
    catch (e) { toast(e.message, 4000); }
    renderGit();
  }
  async function gitCommitDetails(c) {
    let text;
    try { text = await api.git.commitDetails(S.project.dir, c.hash); } catch (e) { return toast(e.message, 4000); }
    const html = esc(text).split('\n').map((l) => {
      const cls = /^\+(?!\+\+)/.test(l) ? 'd-add' : /^-(?!--)/.test(l) ? 'd-del' : /^@@/.test(l) ? 'd-hunk' : /^diff --git|^commit /.test(l) ? 'd-file' : '';
      return `<div class="${cls}">${l || '&nbsp;'}</div>`;
    }).join('');
    infoDialog(c.short + ' · ' + c.subject, `<div class="diffview">${html}</div>`);
  }
  // blame: who last changed each line, shown at the end of every line
  let blameDeco = [], blameTab = null;
  async function gitBlame() {
    const tab = S.activeTab;
    if (!tab || !S.project) return toast('Open a file first');
    if (blameTab === tab && blameDeco.length) { blameDeco = tab.model.deltaDecorations(blameDeco, []); blameTab = null; return toast('Blame hidden', 900); }
    let lines;
    try { lines = await api.git.blame(S.project.dir, tab.path); } catch (e) { return toast(e.message, 4000); }
    if (tab.dirty) toast('Unsaved edits: blame shows the saved file', 2000);
    const decos = lines.map((b) => ({ range: new monaco.Range(b.line, 1, b.line, 1), options: {
      after: { content: '    ' + (b.uncommitted ? 'not committed yet' : `${b.author}, ${b.date} · ${b.summary}`).slice(0, 80), inlineClassName: 'blame-text' },
      isWholeLine: true } })).filter((d) => d.range.startLineNumber <= tab.model.getLineCount());
    for (const d of decos) d.range = new monaco.Range(d.range.startLineNumber, tab.model.getLineMaxColumn(d.range.startLineNumber), d.range.startLineNumber, tab.model.getLineMaxColumn(d.range.startLineNumber));
    if (blameTab && blameTab !== tab && blameDeco.length) blameTab.model.deltaDecorations(blameDeco, []);
    blameDeco = tab.model.deltaDecorations([], decos);
    blameTab = tab;
    toast('Blame on. Run it again to hide.', 1500);
  }
  async function gitBranchMenu() {
    if (!S.project) return;
    const list = await api.git.branches(S.project.dir).catch(() => []);
    const st = await api.git.status(S.project.dir).catch(() => ({}));
    palette([
      ...list.map((b) => ({ label: (b === st.branch ? '✓ ' : '⎇ ') + b, run: async () => {
        if (b === st.branch) return;
        await saveAll(true);
        try { await api.git.switchBranch(S.project.dir, b); toast('Switched to ' + b, 1500); await reloadOpenTabsFromDisk(); }
        catch (e) { toast(e.message, 5000); }
        renderGit();
      } })),
      { label: '＋ New branch from here…', run: async () => {
        const r = await dialog({ title: 'New branch', okLabel: 'Create', fields: [{ key: 'n', label: 'Branch name', placeholder: 'try-new-sensor' }] });
        if (!r || !r.n.trim()) return;
        try { await api.git.createBranch(S.project.dir, r.n.trim()); toast('On new branch ' + r.n.trim(), 1500); }
        catch (e) { toast(e.message, 4500); }
        renderGit();
      } }
    ], 'Branch…');
  }
  // after a branch switch the files on disk changed under the open tabs
  async function reloadOpenTabsFromDisk() {
    for (const t of S.openTabs.slice()) {
      const txt = await api.file.read(t.path).catch(() => null);
      if (txt == null) continue;
      if (txt !== t.model.getValue()) { t.model.setValue(txt); t.savedVersion = t.model.getAlternativeVersionId(); t.dirty = false; }
    }
    renderTabs();
    await refreshTree();
  }
  async function gitShowDiff(f, staged) {
    let text;
    if (f.kind === 'untracked') {
      const content = await api.file.read(joinPath(S.project.dir, f.path)).catch(() => '');
      text = content.split('\n').map((l) => '+' + l).join('\n');
    } else text = await api.git.diff(S.project.dir, f.path, staged).catch((e) => e.message);
    const html = (text || '(no textual changes)').split('\n').slice(0, 2000).map((l) => {
      const c = l.startsWith('+++') || l.startsWith('---') ? 'dm' : l[0] === '+' ? 'da' : l[0] === '-' ? 'dd' : l.startsWith('@@') ? 'dh' : '';
      return `<div class="${c}">${esc(l) || '&nbsp;'}</div>`;
    }).join('');
    infoDialog(f.path, `<div class="diffview">${html}</div>`);
  }
  async function gitIdentity() {
    const cur = await api.git.identity(S.project ? S.project.dir : '.').catch(() => ({}));
    const r = await dialog({ title: 'Git identity', okLabel: 'Save', fields: [
      { key: 'name', label: 'Your name (shown on commits)', value: cur.name || '' },
      { key: 'email', label: 'Email (shown on commits)', value: cur.email || '' }] });
    if (!r) return;
    await api.git.setIdentity(r.name.trim(), r.email.trim()).catch((e) => toast(e.message));
    toast('Git identity saved');
  }

  // ---- build extras ----------------------------------------------------------
  async function exportBinary() {
    if (!S.project || isPyBoard() || projType() === 'pi') return toast('Open an Arduino sketch first');
    if (!S.fqbn) { toast('Pick a board first'); return chooseBoard(); }
    await saveAll(true);
    setBuilding('exporting…');
    const r = await api.toolchain.compile({ sketchDir: S.project.dir, fqbn: S.fqbn, exportBinaries: true }).catch((e) => ({ ok: false, raw: e.message }));
    setBuilding(null);
    setDiagnostics(r.diagnostics || []);
    if (!r.ok) { logTo('outputLog', r.raw || 'export failed', 'err'); return toast('✗ Compile failed — see Problems'); }
    const files = r.exported || [];
    for (const f of files) logTo('outputLog', '✓ ' + f, 'meta');
    toast(files.length ? `✓ Exported ${files.length} file${files.length > 1 ? 's' : ''} to build/` : 'Compiled, but the core exported no binaries', 3000);
    if (files.length) api.file.reveal(files.find((f) => /\.(hex|uf2|bin)$/i.test(f) && !/bootloader|partitions/i.test(f)) || files[0]);
    refreshTree();
  }
  async function libZip() {
    const p = await api.project.pickFile({ filters: [{ name: 'Arduino library', extensions: ['zip'] }] });
    if (!p) return;
    const r = await api.toolchain.libInstallZip(p).catch((e) => ({ ok: false, err: e.message }));
    toast(r.ok ? '✓ Library installed from ' + baseName(p) : '✗ ' + String(r.err || 'install failed').slice(0, 200), 4000);
    refreshInstalledLibs();
  }
  async function libUpgradeAll() {
    const ups = await api.toolchain.libUpdatable().catch(() => []);
    if (!ups.length) return toast('All libraries are up to date');
    const ok = await confirmDialog('Update libraries', `Update ${ups.length} librar${ups.length === 1 ? 'y' : 'ies'}?\n\n` +
      ups.map((l) => `${l.name} ${l.version} → ${l.latest}`).join('\n'),
      [{ label: 'Cancel', value: false }, { label: 'Update all', value: true, primary: true }]);
    if (!ok) return;
    const r = await api.toolchain.libUpgradeAll();
    toast(r.ok ? '✓ Libraries updated' : '✗ Update failed', 3000);
    refreshInstalledLibs();
  }
  async function coreUpgradeAll() {
    const ok = await confirmDialog('Update board cores', 'Download and install the newest version of every installed board core? Big cores (ESP32) can take several minutes.',
      [{ label: 'Cancel', value: false }, { label: 'Update', value: true, primary: true }]);
    if (!ok) return;
    const r = await api.toolchain.coreUpgradeAll();
    toast(r.ok ? '✓ Cores updated' : '✗ Update failed', 3000);
    refreshCores();
  }

  // ---- bottom panels -------------------------------------------------------
  function showPanel(name) {
    document.querySelectorAll('.btab').forEach((b) => b.classList.toggle('on', b.dataset.panel === name));
    document.querySelectorAll('.bpanel').forEach((p) => p.classList.toggle('on', p.id === 'panel-' + name));
    $('toolsSerial').classList.toggle('hidden', name !== 'serial');
    $('toolsPlotter').classList.toggle('hidden', name !== 'plotter');
    $('toolsTimeline').classList.toggle('hidden', name !== 'timeline');
    $('toolsOutput').classList.toggle('hidden', name !== 'output');
    if ($('bottom').classList.contains('collapsed')) togglePane('bottom');
  }
  document.querySelectorAll('.btab').forEach((b) =>
    b.addEventListener('click', () => showPanel(b.dataset.panel)));

  // ---- serial monitor ------------------------------------------------------
  // Lines are kept in a ring (so filter/timestamp toggles re-render the whole
  // history) and painted in one batch per frame.
  let SERIAL_MAX = 5000;   // Settings → Serial → buffer
  let serialPaintQueued = false;
  const fmtTs = (ts) => {
    const d = new Date(ts);
    return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  };
  function serialLineEl(l) {
    const div = document.createElement('div');
    if (l.cls) div.className = l.cls;
    else if (/\b(error|fail(ed|ure)?|panic|guru meditation|exception|traceback|brownout)\b/i.test(l.text)) div.className = 'sl-err';
    else if (/\b(warn(ing)?)\b/i.test(l.text)) div.className = 'sl-warn';
    const prefix = (S.serial.timestamps ? (S.serial.tsMode === 'delta' ? ('+' + (l.dt == null ? 0 : l.dt) + ' ms').padStart(9) + '  ' : fmtTs(l.ts) + '  ') : '') +
                   (S.multiOpen && l.port ? `[${l.port}] ` : '');
    if (!S.serial.hex && /\x1b\[/.test(l.text)) {
      // ANSI colours from the board (ESP-IDF logs, colour debug output)
      div.appendChild(document.createTextNode(prefix));
      for (const run of U.parseAnsi(l.text)) {
        const sp = document.createElement('span');
        sp.textContent = run.text;
        if (run.fg) sp.style.color = run.fg;
        if (run.bg) sp.style.background = run.bg;
        if (run.bold) sp.style.fontWeight = '600';
        div.appendChild(sp);
      }
      return div;
    }
    const body = S.serial.hex && !l.cls ? U.toHex(l.text) : l.text.replace(/\x1b/g, '');
    div.textContent = prefix + body;
    return div;
  }
  const serialMatch = (l) => !S.serial.filter || U.stripAnsi(l.text).toLowerCase().includes(S.serial.filter);
  let serialPending = [];
  const lastTs = {};
  function pushSerial(text, cls, port, ts) {
    const l = { text, cls, port, ts: ts || Date.now() };
    if (!cls) { const k = port || ''; if (lastTs[k]) l.dt = l.ts - lastTs[k]; lastTs[k] = l.ts; }
    if (S.serial.recording && !cls) { serialRecBuf.push(fmtTs(l.ts) + '  ' + U.stripAnsi(text)); scheduleRecFlush(); }
    S.serial.lines.push(l);
    if (S.serial.lines.length > SERIAL_MAX) S.serial.lines.splice(0, S.serial.lines.length - SERIAL_MAX);
    serialPending.push(l);
    if (!serialPaintQueued) { serialPaintQueued = true; requestAnimationFrame(paintSerial); }
  }
  function paintSerial() {
    serialPaintQueued = false;
    if (S.serial.frozen) return;   // lines keep arriving in the ring; the view holds still
    const box = $('serialLog');
    const frag = document.createDocumentFragment();
    for (const l of serialPending) if (serialMatch(l)) frag.appendChild(serialLineEl(l));
    serialPending = [];
    box.appendChild(frag);
    while (box.childNodes.length > SERIAL_MAX) box.removeChild(box.firstChild);
    if (S.serial.autoscroll) box.scrollTop = box.scrollHeight;
  }
  function rerenderSerial() {
    const box = $('serialLog');
    box.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const l of S.serial.lines) if (serialMatch(l)) frag.appendChild(serialLineEl(l));
    box.appendChild(frag);
    box.scrollTop = box.scrollHeight;
  }

  // logTo('serialLog', …) callers elsewhere go through the ring too
  const _logTo = logTo;
  logTo = function (elId, text, cls) {
    if (elId === 'serialLog') return pushSerial(text, cls);
    return _logTo(elId, text, cls);
  };

  // serial monitor + plotter feed (multi-port: tag lines when several open)
  let rxPaintT = null;
  api.on('serial:data', (msg) => {
    const lines = msg.lines || [{ line: msg.line, ts: msg.ts }];
    const mine = !msg.port || msg.port === S.port;
    S.serial.rxLines = (S.serial.rxLines || 0) + lines.length;
    for (const l of lines) S.serial.rxBytes = (S.serial.rxBytes || 0) + (l.line ? l.line.length + 1 : 0);
    if (!rxPaintT) rxPaintT = setTimeout(() => { rxPaintT = null; $('stRx').textContent = `rx ${S.serial.rxLines} lines · ${U.fmtBytes(S.serial.rxBytes)}`; }, 300);
    for (const l of lines) {
      pushSerial(l.line, l.meta ? 'meta' : '', msg.port, l.ts);
      if (mine && !l.meta) {
        const plain = /\x1b/.test(l.line) ? U.stripAnsi(l.line) : l.line;
        S.serialTail.push(plain);
        if (S.serialTail.length > 200) S.serialTail.shift();
        feedPlotter(plain, l.ts);
      }
    }
    // the real board's TX LED just blinked; ours does too
    if (mine && lines.length) S.board && S.board.flash && S.board.flash('tx');
  });
  api.on('serial:status', (s) => {
    S.multiOpen = (s.open || []).length > 1;
    S.serial.bauds = s.bauds || {};
    if (S.port && S.serial.bauds[S.port]) $('serialBaud').value = String(S.serial.bauds[S.port]);
    $('stSerial').textContent = s.count ? 'serial: ' + s.open.join(', ') : 'serial: closed';
  });
  $('serialSendBtn').addEventListener('click', sendSerial);
  $('serialSend').addEventListener('keydown', (e) => {
    const h = S.serial.history;
    if (e.key === 'Enter') sendSerial();
    else if (e.key === 'ArrowUp' && h.length) {
      e.preventDefault();
      S.serial.histIdx = Math.max(0, (S.serial.histIdx < 0 ? h.length : S.serial.histIdx) - 1);
      $('serialSend').value = h[S.serial.histIdx];
    } else if (e.key === 'ArrowDown' && h.length && S.serial.histIdx >= 0) {
      e.preventDefault();
      S.serial.histIdx = Math.min(h.length, S.serial.histIdx + 1);
      $('serialSend').value = h[S.serial.histIdx] || '';
    }
  });
  function sendSerial() {
    const v = $('serialSend').value;
    const ending = $('serialEnding').value;
    if (S.serial.hex) {
      const bytes = U.parseHex(v);
      if (!bytes) return toast('Hex mode: type bytes like 01 FF 7e or 01ff7e');
      api.serial.writeRaw(S.port, bytes).then(() => pushSerial('» ' + U.toHexBytes(bytes), 'meta')).catch((e) => toast(e.message));
      if (S.serial.history[S.serial.history.length - 1] !== v) S.serial.history.push(v);
      S.serial.histIdx = -1;
      $('serialSend').value = '';
      return;
    }
    if (!v && ending === 'none') return;
    api.serial.writeLine(S.port, v, ending).then(() => {
      pushSerial('» ' + v, 'meta');
      S.board && S.board.flash && S.board.flash('rx'); // board is receiving
    }).catch((e) => toast(e.message));
    if (v && S.serial.history[S.serial.history.length - 1] !== v) S.serial.history.push(v);
    if (S.serial.history.length > 50) S.serial.history.shift();
    S.serial.histIdx = -1;
    $('serialSend').value = '';
  }
  $('serialBaud').addEventListener('change', async () => {
    const baud = Number($('serialBaud').value);
    S.settings = await api.settings.set({ serialBaud: baud });
    if (S.port) {
      const r = await api.serial.setBaud(S.port, baud).catch((e) => ({ ok: false, error: e.message }));
      if (r && r.ok) pushSerial(`— ${S.port} now at ${baud} baud —`, 'meta');
    }
  });
  $('serialEnding').addEventListener('change', () => api.settings.set({ serial: { lineEnding: $('serialEnding').value } }));
  // timestamps: off → clock time → time since the previous line (Δ ms)
  $('serialTs').addEventListener('click', () => {
    const next = !S.serial.timestamps ? 'clock' : S.serial.tsMode === 'clock' ? 'delta' : 'off';
    S.serial.timestamps = next !== 'off';
    S.serial.tsMode = next === 'off' ? 'clock' : next;
    $('serialTs').classList.toggle('on', S.serial.timestamps);
    $('serialTs').textContent = next === 'delta' ? 'Δt' : '⏱';
    $('serialTs').title = next === 'off' ? 'Timestamps: off (click for clock time)' : next === 'clock' ? 'Timestamps: clock time (click for time between lines)' : 'Timestamps: ms since the previous line (click to turn off)';
    api.settings.set({ serial: { timestamps: S.serial.timestamps, tsMode: S.serial.tsMode } });
    rerenderSerial();
  });
  // freeze: the display holds still while data keeps arriving underneath
  $('serialFreeze').addEventListener('click', () => {
    S.serial.frozen = !S.serial.frozen;
    $('serialFreeze').classList.toggle('on', S.serial.frozen);
    if (!S.serial.frozen) { serialPending = []; rerenderSerial(); }
    else toast('Display frozen. Data is still being received; click again to catch up.', 2200);
  });
  // record: every received line appended to a file as it arrives
  let serialRecBuf = [], serialRecT = null;
  function scheduleRecFlush() {
    if (serialRecT) return;
    serialRecT = setTimeout(async () => {
      serialRecT = null;
      const chunk = serialRecBuf.join('\n') + '\n'; serialRecBuf = [];
      if (S.serial.recording) await api.file.append(S.serial.recording, chunk).catch((e) => { toast('Recording stopped: ' + e.message, 4000); stopRecording(); });
    }, 500);
  }
  function stopRecording() {
    if (!S.serial.recording) return;
    const p = S.serial.recording;
    if (serialRecBuf.length) api.file.append(p, serialRecBuf.join('\n') + '\n').catch(() => {});
    serialRecBuf = []; S.serial.recording = null;
    $('serialRec').classList.remove('on', 'rec');
    toast('Recording saved to ' + baseName(p), 2500);
  }
  $('serialRec').addEventListener('click', async () => {
    if (S.serial.recording) return stopRecording();
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const p = await api.file.saveDialog({ defaultPath: (S.project ? joinPath(S.project.dir, '') : '') + 'serial-' + stamp + '.log', filters: [{ name: 'Log', extensions: ['log', 'txt'] }] });
    if (!p) return;
    await api.file.write(p, `# ElectriCAD serial recording started ${new Date().toString()}\n`);
    S.serial.recording = p;
    $('serialRec').classList.add('on', 'rec');
    toast('Recording every line to ' + baseName(p), 2200);
  });
  // DTR / RTS by hand (ESP32 boot-mode strapping, holding a board in reset)
  for (const sig of ['dtr', 'rts']) {
    $('serial' + sig.toUpperCase()).addEventListener('click', async () => {
      if (!S.port) return toast('No serial port open');
      S.serial.signals = S.serial.signals || { dtr: false, rts: false };
      const want = !S.serial.signals[sig];
      try {
        await api.serial.signals(S.port, { [sig]: want });
        S.serial.signals[sig] = want;
        $('serial' + sig.toUpperCase()).classList.toggle('on', want);
        pushSerial(`— ${sig.toUpperCase()} ${want ? 'asserted' : 'released'} —`, 'meta');
      } catch (e) { toast(e.message); }
    });
  }
  // Ctrl+C / Ctrl+D for Python REPLs
  $('serialCtrlC').addEventListener('click', () => S.port ? api.serial.writeRaw(S.port, [3]).then(() => pushSerial('» Ctrl+C', 'meta')).catch((e) => toast(e.message)) : toast('No serial port open'));
  $('serialCtrlD').addEventListener('click', () => S.port ? api.serial.writeRaw(S.port, [4]).then(() => pushSerial('» Ctrl+D', 'meta')).catch((e) => toast(e.message)) : toast('No serial port open'));
  // send the same line every N ms (polling a sensor command, stress tests)
  let repeatT = null;
  $('serialRepeat').addEventListener('click', async () => {
    if (repeatT) { clearInterval(repeatT); repeatT = null; $('serialRepeat').classList.remove('on'); return toast('Repeat stopped', 1000); }
    if (!S.port) return toast('No serial port open');
    const r = await dialog({ title: 'Send repeatedly', okLabel: 'Start', fields: [
      { key: 't', label: 'Text to send', value: $('serialSend').value },
      { key: 'ms', label: 'Every (ms)', value: 1000, type: 'number' },
      { key: 'n', label: 'Times (0 = until stopped)', value: 0, type: 'number' }] });
    if (!r) return;
    const ms = Math.max(20, Number(r.ms) || 1000), max = Math.max(0, Number(r.n) || 0);
    let n = 0;
    $('serialRepeat').classList.add('on');
    repeatT = setInterval(() => {
      if (!S.port || (max && n >= max)) { clearInterval(repeatT); repeatT = null; $('serialRepeat').classList.remove('on'); return; }
      n++;
      api.serial.writeLine(S.port, r.t, $('serialEnding').value).catch(() => { clearInterval(repeatT); repeatT = null; $('serialRepeat').classList.remove('on'); });
    }, ms);
    toast(`Sending "${r.t}" every ${ms} ms. Click ⟳ again to stop.`, 2500);
  });
  // send-as-you-type: each key goes out at once (menus that read one char)
  $('serialType').addEventListener('click', () => {
    S.serial.typeMode = !S.serial.typeMode;
    $('serialType').classList.toggle('on', S.serial.typeMode);
    $('serialSend').placeholder = S.serial.typeMode ? 'Type: every key is sent immediately (Enter sends the line ending)' : 'Send to the board… (Enter sends, ↑/↓ history)';
    $('serialSend').focus();
  });
  $('serialSend').addEventListener('keydown', (e) => {
    if (!S.serial.typeMode || !S.port) return;
    const endings = { none: '', lf: '\n', cr: '\r', crlf: '\r\n' };
    let out = null;
    if (e.key === 'Enter') out = endings[$('serialEnding').value] || '\n';
    else if (e.key === 'Backspace') out = '\b';
    else if (e.key === 'Escape') out = '\x1b';
    else if (e.key === 'Tab') out = '\t';
    else if (e.key.length === 1 && !e.ctrlKey && !e.altKey) out = e.key;
    else if (e.ctrlKey && /^[a-z]$/i.test(e.key)) out = String.fromCharCode(e.key.toLowerCase().charCodeAt(0) - 96);
    if (out == null) return;
    e.preventDefault(); e.stopImmediatePropagation();
    api.serial.writeRaw(S.port, Array.from(new TextEncoder().encode(out))).catch((err) => toast(err.message));
    $('serialSend').value = '';
  }, true);
  $('serialHex').addEventListener('click', () => {
    S.serial.hex = !S.serial.hex;
    $('serialHex').classList.toggle('on', S.serial.hex);
    $('serialSend').placeholder = S.serial.hex ? 'Hex bytes to send, e.g. 01 FF 7E (Enter sends)' : 'Send to the board… (Enter sends, ↑/↓ history)';
    rerenderSerial();
  });
  $('serialScroll').addEventListener('click', () => {
    S.serial.autoscroll = !S.serial.autoscroll;
    $('serialScroll').classList.toggle('on', S.serial.autoscroll);
    api.settings.set({ serial: { autoscroll: S.serial.autoscroll } });
  });
  $('serialFilter').addEventListener('input', () => {
    S.serial.filter = $('serialFilter').value.trim().toLowerCase();
    rerenderSerial();
  });
  $('serialClear').addEventListener('click', clearSerial);
  function clearSerial() { S.serial.rxLines = 0; S.serial.rxBytes = 0; $('stRx').textContent = ''; S.serial.lines = []; serialPending = []; $('serialLog').innerHTML = ''; }
  $('serialReset').addEventListener('click', resetBoard);
  async function resetBoard() {
    if (!S.port) return toast('No serial port open');
    try { await api.serial.reset(S.port); pushSerial('— reset ' + S.port + ' —', 'meta'); }
    catch (e) { toast(e.message); }
  }
  $('serialSave').addEventListener('click', async () => {
    if (!S.serial.lines.length) return toast('Nothing to save yet');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const p = await api.file.saveDialog({ defaultPath: 'serial-' + stamp + '.log',
      filters: [{ name: 'Log', extensions: ['log', 'txt'] }] });
    if (!p) return;
    await api.file.write(p, S.serial.lines.map((l) => fmtTs(l.ts) + '  ' + l.text).join('\n') + '\n');
    toast('Saved ' + S.serial.lines.length + ' lines');
  });
  $('outputClear').addEventListener('click', () => { $('outputLog').innerHTML = ''; });

  // ---- plotter -------------------------------------------------------------
  // Accepts label:value pairs and Arduino-IDE-style comma/space separated
  // numbers; up to 2000 points per series, pause, CSV export, autoscaled axis.
  function feedPlotter(line, ts) {
    if (S.plot.paused) return;
    const pts = U.parsePlotLine(line);
    if (!pts.length) return;
    const row = { t: ts || Date.now() };
    for (const { k, v } of pts) { pushPoint(k, v); row[k] = v; }
    S.plot.rows.push(row);
    if (S.plot.rows.length > 5000) S.plot.rows.shift();
  }
  function pushPoint(k, v) {
    if (!S.plot.series.has(k)) {
      if (S.plot.series.size >= 12) return; // a runaway label stream shouldn't eat memory
      S.plot.series.set(k, []);
    }
    const arr = S.plot.series.get(k);
    arr.push(v);
    if (arr.length > 2000) arr.shift();
  }
  const PLOT_COLORS = ['#ff6500', '#4aa3ff', '#3fd07a', '#c77dff', '#ffcc66', '#ff5c8a', '#5ce1e6', '#e8e8e8'];
  const niceNum = (v) => Math.abs(v) >= 1000 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
  function drawPlotter() {
    const cv = $('plotCanvas');
    if (!cv.offsetParent) return;
    const { width: w, height: h } = cv.getBoundingClientRect();
    if (cv.width !== Math.round(w * devicePixelRatio) || cv.height !== Math.round(h * devicePixelRatio)) {
      cv.width = Math.round(w * devicePixelRatio); cv.height = Math.round(h * devicePixelRatio);
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '11px Consolas, monospace';
    const N = S.plot.window;
    let min = Infinity, max = -Infinity;
    const stats = new Map();
    for (const [k, arr] of S.plot.series) {
      let mn = Infinity, mx = -Infinity, sum = 0, n = 0;
      for (let i = Math.max(0, arr.length - N); i < arr.length; i++) { mn = Math.min(mn, arr[i]); mx = Math.max(mx, arr[i]); sum += arr[i]; n++; }
      stats.set(k, { mn, mx, avg: n ? sum / n : 0 });
      min = Math.min(min, mn); max = Math.max(max, mx);
    }
    if (min === Infinity) {
      ctx.fillStyle = '#666';
      ctx.fillText('Print label:value pairs (temp:21.5 hum:40) or comma-separated numbers to plot them. Try File → New from Example → Plotter demo.', 12, 20);
      return;
    }
    if (S.plot.yRange) { min = S.plot.yRange[0]; max = S.plot.yRange[1]; }
    else {
      if (min === max) { min -= 1; max += 1; }
      const pad = (max - min) * 0.08; min -= pad; max += pad;
    }
    const L = 52, T = 22, B = 6, R = 8;
    const yOf = (v) => T + (1 - (v - min) / (max - min)) * (h - T - B);
    // grid + axis labels
    ctx.strokeStyle = '#262626'; ctx.fillStyle = '#7a7a7a'; ctx.lineWidth = 1;
    if (document.body.classList.contains('light')) { ctx.strokeStyle = '#e2e2e2'; ctx.fillStyle = '#666'; }
    for (let g = 0; g <= 4; g++) {
      const v = min + (max - min) * (g / 4), y = yOf(v);
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(w - R, y); ctx.stroke();
      ctx.fillText(niceNum(v), 4, y + 4);
    }
    if (min < 0 && max > 0) { ctx.strokeStyle = '#3a3a3a'; ctx.beginPath(); ctx.moveTo(L, yOf(0)); ctx.lineTo(w - R, yOf(0)); ctx.stroke(); }
    let ci = 0, lx = L;
    S.plot.legend = [];
    S.plot.hidden = S.plot.hidden || new Set();
    for (const [k, arr] of S.plot.series) {
      const color = PLOT_COLORS[ci % PLOT_COLORS.length];
      const start = Math.max(0, arr.length - N);
      const hidden = S.plot.hidden.has(k);
      ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.beginPath();
      if (!hidden) for (let i = start; i < arr.length; i++) {
        const x = L + ((i - start) / Math.max(1, N - 1)) * (w - L - R);
        const y = yOf(arr[i]);
        i > start ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
      const st = stats.get(k);
      const label = `${hidden ? '□' : '■'} ${k}=${niceNum(arr[arr.length - 1])}` + (S.plot.showStats && st ? ` (${niceNum(st.mn)}…${niceNum(st.mx)}, avg ${niceNum(st.avg)})` : '');
      ctx.fillStyle = hidden ? '#666' : color; ctx.fillText(label, lx, 14);
      const lw = ctx.measureText(label).width;
      S.plot.legend.push({ k, x1: lx, x2: lx + lw, y1: 2, y2: 18 });
      lx += lw + 14;
      ci++;
    }
    // crosshair: values of every series at the mouse
    const m = S.plot.mouse;
    if (m && m.x > L && m.x < w - R && m.y > T) {
      ctx.strokeStyle = 'rgba(160,160,160,0.6)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(m.x, T); ctx.lineTo(m.x, h - B); ctx.moveTo(L, m.y); ctx.lineTo(w - R, m.y); ctx.stroke(); ctx.setLineDash([]);
      const frac = (m.x - L) / (w - L - R);
      const yv = min + (1 - (m.y - T) / (h - T - B)) * (max - min);
      const lines = [`y ${niceNum(yv)}`];
      let cj = 0;
      for (const [k, arr] of S.plot.series) {
        const start = Math.max(0, arr.length - N);
        const idx = start + Math.round(frac * Math.max(1, N - 1));
        if (!S.plot.hidden.has(k) && idx < arr.length) lines.push({ k, v: arr[idx], c: PLOT_COLORS[cj % PLOT_COLORS.length] });
        cj++;
      }
      const bw = 130, bh = 14 * lines.length + 6;
      const bx = Math.min(m.x + 10, w - bw - 4), by = Math.min(m.y + 10, h - bh - 4);
      ctx.fillStyle = document.body.classList.contains('light') ? 'rgba(255,255,255,0.92)' : 'rgba(20,20,20,0.9)';
      ctx.fillRect(bx, by, bw, bh);
      lines.forEach((ln, i) => {
        ctx.fillStyle = typeof ln === 'string' ? '#9a9a9a' : ln.c;
        ctx.fillText(typeof ln === 'string' ? ln : `${ln.k} = ${niceNum(ln.v)}`, bx + 6, by + 14 + i * 14);
      });
    }
    if (S.plot.paused) { ctx.fillStyle = '#ffcc66'; ctx.fillText('❚❚ paused', w - 80, 14); }
  }
  $('plotCanvas').addEventListener('mousemove', (e) => { const r = $('plotCanvas').getBoundingClientRect(); S.plot.mouse = { x: e.clientX - r.left, y: e.clientY - r.top }; });
  $('plotCanvas').addEventListener('mouseleave', () => { S.plot.mouse = null; });
  // click a series name to hide / show it
  $('plotCanvas').addEventListener('click', (e) => {
    const r = $('plotCanvas').getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const hitL = (S.plot.legend || []).find((l) => x >= l.x1 && x <= l.x2 && y >= l.y1 && y <= l.y2);
    if (!hitL) return;
    S.plot.hidden = S.plot.hidden || new Set();
    if (S.plot.hidden.has(hitL.k)) S.plot.hidden.delete(hitL.k); else S.plot.hidden.add(hitL.k);
  });
  $('plotPng').addEventListener('click', async () => {
    const cv = $('plotCanvas');
    if (!cv.offsetParent) return toast('Open the plotter first');
    const p = await api.file.saveDialog({ defaultPath: (S.project ? joinPath(S.project.dir, 'plot.png') : 'plot.png'), filters: [{ name: 'PNG image', extensions: ['png'] }] });
    if (!p) return;
    // paint a solid background under the transparent canvas
    const out = document.createElement('canvas'); out.width = cv.width; out.height = cv.height;
    const c2 = out.getContext('2d');
    c2.fillStyle = document.body.classList.contains('light') ? '#ffffff' : '#121212'; c2.fillRect(0, 0, out.width, out.height);
    c2.drawImage(cv, 0, 0);
    await api.file.writeBase64(p, out.toDataURL('image/png').split(',')[1]);
    toast('Saved ' + baseName(p), 1600);
  });
  $('plotPause').addEventListener('click', () => {
    S.plot.paused = !S.plot.paused;
    $('plotPause').classList.toggle('on', S.plot.paused);
    $('plotPause').textContent = S.plot.paused ? '▶' : '❚❚';
  });
  $('plotStats').addEventListener('click', () => {
    S.plot.showStats = !S.plot.showStats;
    $('plotStats').classList.toggle('on', S.plot.showStats);
  });
  $('plotY').addEventListener('click', async () => {
    const cur = S.plot.yRange || ['', ''];
    const r = await dialog({ title: 'Plotter Y range', okLabel: 'Apply', fields: [
      { key: 'min', label: 'Minimum (blank = automatic)', value: cur[0], type: 'number' },
      { key: 'max', label: 'Maximum (blank = automatic)', value: cur[1], type: 'number' }] });
    if (!r) return;
    const a = r.min === '' ? null : Number(r.min), b = r.max === '' ? null : Number(r.max);
    S.plot.yRange = a != null && b != null && b > a ? [a, b] : null;
    $('plotY').classList.toggle('on', !!S.plot.yRange);
    toast(S.plot.yRange ? `Y fixed to ${a} … ${b}` : 'Y range automatic', 1200);
  });
  $('plotClear').addEventListener('click', () => { S.plot.series.clear(); S.plot.rows = []; });
  $('plotWindow').addEventListener('change', () => { S.plot.window = Number($('plotWindow').value) || 600; });
  $('plotCsv').addEventListener('click', async () => {
    if (!S.plot.rows.length) return toast('No plot data yet');
    const keys = [...S.plot.series.keys()];
    const t0 = S.plot.rows[0].t;
    const csv = ['ms,' + keys.join(',')].concat(S.plot.rows.map((r) =>
      [r.t - t0, ...keys.map((k) => (r[k] !== undefined ? r[k] : ''))].join(','))).join('\n') + '\n';
    const p = await api.file.saveDialog({ defaultPath: 'plot.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (p) { await api.file.write(p, csv); toast('Exported ' + S.plot.rows.length + ' rows'); }
  });

  // ---- timeline: record digital transitions, draw logic-analyzer style -----
  function feedTimeline(pins) {
    if (S.timeline.paused) return;
    const now = Date.now();
    for (const p of pins) {
      if (!S.timeline.pins.has(p.pin)) S.timeline.pins.set(p.pin, []);
      const arr = S.timeline.pins.get(p.pin);
      const last = arr[arr.length - 1];
      const level = p.mode === 'pwm' ? 2 : p.level;
      if (!last || last.level !== level) {
        arr.push({ t: now, level });
        if (arr.length > 600) arr.shift();
      }
    }
  }
  function drawTimeline() {
    const cv = $('timelineCanvas');
    if (!cv.offsetParent) return;
    const { width: w, height: h } = cv.getBoundingClientRect();
    if (cv.width !== Math.round(w * devicePixelRatio) || cv.height !== Math.round(h * devicePixelRatio)) {
      cv.width = Math.round(w * devicePixelRatio); cv.height = Math.round(h * devicePixelRatio);
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '11px Consolas, monospace';
    const def = PINODE_BOARDS[S.boardDefId];
    // pins that ever changed, in board order
    const active = [...S.timeline.pins.entries()]
      .filter(([, arr]) => arr.length > 1)
      .sort((a, b) => a[0] - b[0])
      .slice(0, 16);
    if (!active.length) { ctx.fillStyle = '#666'; ctx.fillText('Pin transitions appear here once telemetry flows (add ELECTRICAD_TICK() to loop()).', 12, 20); return; }
    const now = S.timeline.paused ? (S.timeline.frozenAt || Date.now()) : Date.now();
    const span = S.timeline.span;
    const rowH = Math.min(30, (h - 8) / active.length);
    const X0 = 56;
    active.forEach(([pin, arr], row) => {
      const y0 = 4 + row * rowH, yHi = y0 + 4, yLo = y0 + rowH - 6, yMid = (yHi + yLo) / 2;
      const label = (def.pins.find((p) => p.tele === pin) || {}).label || pin;
      ctx.fillStyle = '#9a9a9a'; ctx.fillText(String(label), 4, yMid + 4);
      // count edges in the window → approximate frequency
      let edges = 0;
      ctx.lineWidth = 1.4;
      let prevX = X0, prevLevel = arr[0].level;
      ctx.beginPath(); ctx.strokeStyle = '#3fd07a';
      const yFor = (lv) => (lv === 2 ? yMid : lv ? yHi : yLo);
      for (const ev of arr) {
        const age = now - ev.t;
        if (age > span) { prevLevel = ev.level; continue; }
        const x = X0 + (1 - age / span) * (w - X0 - 8);
        ctx.moveTo(prevX, yFor(prevLevel)); ctx.lineTo(x, yFor(prevLevel));
        ctx.lineTo(x, yFor(ev.level));
        prevX = x; prevLevel = ev.level; edges++;
      }
      ctx.lineTo(w - 8, yFor(prevLevel));
      ctx.stroke();
      if (edges > 2) {
        ctx.fillStyle = '#6a6a6a';
        ctx.fillText((edges / 2 / (span / 1000)).toFixed(1) + ' Hz', w - 70, y0 + 11);
      }
    });
    if (S.timeline.paused) { ctx.fillStyle = '#ffcc66'; ctx.fillText('❚❚ frozen', w - 150, 12); }
  }
  $('tlSpan').addEventListener('change', () => { S.timeline.span = Number($('tlSpan').value) || 10000; });
  $('tlPause').addEventListener('click', () => {
    S.timeline.paused = !S.timeline.paused;
    S.timeline.frozenAt = Date.now();
    $('tlPause').classList.toggle('on', S.timeline.paused);
    $('tlPause').textContent = S.timeline.paused ? '▶' : '❚❚';
  });
  $('tlClear').addEventListener('click', () => S.timeline.pins.clear());
  $('tlCsv').addEventListener('click', async () => {
    const def = PINODE_BOARDS[S.boardDefId];
    const rows = [];
    for (const [pin, arr] of S.timeline.pins) for (const ev of arr) rows.push({ t: ev.t, pin, level: ev.level });
    if (!rows.length) return toast('No pin transitions recorded yet');
    rows.sort((a, b) => a.t - b.t);
    const t0 = rows[0].t;
    const csv = ['ms,pin,label,level'].concat(rows.map((r) => [r.t - t0, r.pin, '"' + String((def.pins.find((p) => p.tele === r.pin) || {}).label || r.pin) + '"', r.level === 2 ? 'PWM' : r.level].join(','))).join('\n') + '\n';
    const p = await api.file.saveDialog({ defaultPath: (S.project ? joinPath(S.project.dir, 'timeline.csv') : 'timeline.csv'), filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (p) { await api.file.write(p, csv); toast('Exported ' + rows.length + ' transitions', 1600); }
  });

  // ---- I2C bus (from ELECTRICAD_I2C_SCAN) ----------------------------------
  api.on('i2c:scan', (scan) => {
    if (S.port && scan.port && scan.port !== S.port) return;
    const prev = new Set(S.i2c.addresses);
    S.i2c = { addresses: scan.addresses || [], ts: scan.ts || Date.now(), port: scan.port, error: scan.error };
    const added = S.i2c.addresses.filter((a) => !prev.has(a));
    if (prev.size && added.length) toast('I2C: new device at ' + added.map(U.hex2).join(', '), 2400);
    renderI2c();
  });
  function renderI2c() {
    const box = $('i2cList');
    const n = S.i2c.addresses.length;
    $('i2cCount').textContent = n || '';
    $('i2cCount').className = 'badge' + (n ? '' : ' off');
    box.innerHTML = '';
    if (!S.i2c.ts) {
      box.innerHTML = '<p class="dim">No scan yet. Call <b>ELECTRICAD_I2C_SCAN(Wire);</b> in your sketch (File → New from Example → I2C bus scanner) and every device on the bus shows up here, named.</p>';
      return;
    }
    const head = document.createElement('div');
    head.className = 'meta';
    head.textContent = `${n} device${n === 1 ? '' : 's'} on ${S.i2c.port || 'the bus'} · scanned ${new Date(S.i2c.ts).toLocaleTimeString()}`;
    box.appendChild(head);
    if (!n) {
      const d = document.createElement('div');
      d.className = 'warn';
      d.textContent = 'Nothing answered. Check SDA/SCL are not swapped, the module has power, and pull-ups exist (most breakouts include them).';
      box.appendChild(d);
    }
    for (const a of S.i2c.addresses) {
      const d = document.createElement('div');
      d.className = 'i2c-row';
      d.innerHTML = `<b>${U.hex2(a)}</b> <span class="dim2">(${a})</span> ${esc(U.i2cName(a))}`;
      box.appendChild(d);
    }
  }

  // ---- live board ----------------------------------------------------------
  // view settings survive restarts; the revision is remembered per board
  const BV = (() => { try { return JSON.parse(localStorage.getItem('ec_boardview')) || {}; } catch (e) { return {}; } })();
  BV.mode = BV.mode || 'image'; BV.face = BV.face || 'front'; BV.rot = BV.rot || 0;
  BV.opacity = BV.opacity != null ? BV.opacity : 0.5; BV.rev = BV.rev || {}; BV.pick = BV.pick || {};
  const saveBV = () => { try { localStorage.setItem('ec_boardview', JSON.stringify(BV)); } catch (e) { /* private window */ } };
  function currentBoard() {
    const base = PINODE_BOARDS[S.boardDefId];
    return window.PINODE_BOARD_REVISIONS.withRevision(base, BV.rev[S.boardDefId]);
  }
  function boardImagesNow() {
    const { rev } = currentBoard();
    return ((rev && rev.images) || []).filter((i) => i.face === BV.face);
  }
  function currentBoardImage() {
    const imgs = boardImagesNow();
    const key = S.boardDefId + ':' + ((currentBoard().rev || {}).id || '') + ':' + BV.face;
    return imgs.find((i) => i.id === BV.pick[key]) || imgs.find((i) => i.kind === 'photo') || imgs[0] || null;
  }
  function setBoardView(id) {
    S.boardDefId = id;
    $('boardViewSelect').value = id;
    renderBoard();
  }
  function renderBoard() {
    const { def, rev } = currentBoard();
    const base = PINODE_BOARDS[S.boardDefId];
    // revision picker
    const rs = $('boardRev');
    rs.innerHTML = '';
    for (const r of base.revisions || []) { const o = document.createElement('option'); o.value = r.id; o.textContent = r.name; o.title = r.note || ''; rs.appendChild(o); }
    rs.style.display = (base.revisions || []).length > 1 ? '' : 'none';
    if (rev) { rs.value = rev.id; rs.title = rev.note || ''; }
    // pictures for this side
    const imgs = boardImagesNow();
    const image = currentBoardImage();
    const is = $('boardImg');
    is.innerHTML = '';
    for (const i of imgs) { const o = document.createElement('option'); o.value = i.id; o.textContent = i.kind === 'photo' ? 'Photo' : 'Arduino image'; is.appendChild(o); }
    if (image) is.value = image.id;
    is.style.display = imgs.length > 1 && BV.mode !== 'drawn' ? '' : 'none';
    $('boardOpacity').style.display = BV.mode === 'overlay' && image ? '' : 'none';
    $('boardOpacity').value = String(Math.round(BV.opacity * 100));
    for (const b of $('boardMode').querySelectorAll('button')) {
      b.classList.toggle('on', b.dataset.m === BV.mode);
      b.disabled = b.dataset.m !== 'drawn' && !imgs.length;
    }
    $('boardFace').textContent = BV.face === 'back' ? 'Back' : 'Front';
    $('boardFace').classList.toggle('on', BV.face === 'back');
    $('boardRot').textContent = '⟳ ' + BV.rot + '°';
    if (S.board && S.board.destroy) S.board.destroy();
    S.board = PinodeBoard.create($('boardHost'), def, onPinHover, {
      mode: imgs.length ? BV.mode : 'drawn', face: BV.face, rot: BV.rot, image, opacity: BV.opacity, battery: BV.battery || 'none',
      parts: boardPartsNow(), onPart: onBoardPart,
      title: rev ? (/^(Feather|Pico)/.test(rev.name) ? rev.name : 'Arduino ' + rev.name.replace(/^Arduino /, '')) : def.name });
    $('boardBattery').style.display = S.board.hasCharge ? '' : 'none';
    $('boardBattery').value = BV.battery || 'none';
    if (BV.mode !== 'drawn' && !imgs.length) {
      const n = document.createElement('div');
      n.className = 'bv-note';
      n.textContent = (base.revisions ? 'No picture of the ' + BV.face + ' of this board yet' : 'No checked picture of this board yet') + ', showing the drawing';
      $('boardHost').appendChild(n);
    }
    // credit for the picture on screen, or where the drawing comes from
    const cr = $('boardCredit');
    cr.innerHTML = '';
    if (image && (BV.mode !== 'drawn')) {
      cr.append((image.kind === 'photo' ? 'Photo: ' : 'Image: ') + image.credit + ', ');
      const a = document.createElement('a'); a.href = '#'; a.textContent = image.license; a.title = image.source;
      a.addEventListener('click', (e) => { e.preventDefault(); api.openExternal(image.source); });
      cr.append(a, image.kind === 'photo' ? ' · straightened to fit the pins' : '');
    } else {
      cr.textContent = base.geo ? 'Drawn to scale from ' + base.geo.source : 'Pin order checked, positions approximate';
    }
    cr.title = cr.textContent;
    if (S.lastPins && S.lastPins.length) S.board.paint(S.lastPins, (S.lastSnap && S.lastSnap.analog) || [], S.lastSnap);
    updateBoardPower();
  }
  // ---- components on the board: hover box and full card ------------------------
  function boardPartsKey() {
    const { rev } = currentBoard();
    const id = S.boardDefId;
    const all = window.PINODE_BOARD_PARTS || {};
    return rev && all[id + '/' + rev.id] ? id + '/' + rev.id : all[id] ? id : null;
  }
  function boardPartsNow() { const k = boardPartsKey(); return k ? window.PINODE_BOARD_PARTS[k] : null; }
  const BP_KIND = { ic: 'Chip', module: 'Module', cap: 'Ceramic capacitor', ecap: 'Capacitor', res: 'Resistor', rarray: 'Resistor array',
    led: 'LED', rgb: 'NeoPixel', xtal: 'Crystal / resonator', diode: 'Diode', tvs: 'ESD protection', fet: 'Transistor', fuse: 'Fuse', ferrite: 'Ferrite bead',
    ind: 'Inductor', button: 'Button', jumper: 'Solder jumper', usb: 'USB connector', jack: 'Power jack', conn: 'Connector' };
  function bpKind(c) { return c.kind === 'ecap' ? (/PANASONIC/.test(c.pkg || '') ? 'Aluminium electrolytic capacitor' : 'Tantalum capacitor') : BP_KIND[c.kind] || 'Part'; }
  function bpSize(c) { const m = /(0201|0402|0603|0805|1206|1210|1812)/.exec(c.pkg || '') || /\b(0402|0603|0805|1206)\b/.exec(c.desc || ''); return m ? m[1] : ''; }
  function bpRole(c) {
    const l = c.led;
    if (l) {
      if (l.rgb) return 'NeoPixel on pin ' + l.tele + ': shows the colour your sketch sets';
      if (l.role === 'power') return 'The ' + l.label + ' LED: lit while the board has power';
      if (l.role === 'charge') return 'The ' + l.label + ' LED: lit while the battery charges';
      if (l.role === 'tx') return 'The ' + l.label + ' LED: blinks when the board sends serial data';
      if (l.role === 'rx') return 'The ' + l.label + ' LED: blinks when the board receives serial data';
      if (l.tele != null) return 'The ' + l.label + ' LED: follows pin ' + l.tele + (l.invert ? ' (LOW = on)' : '');
      if (l.note) return 'The ' + l.label + ' LED: ' + l.note;
    }
    if (/^\d+$/.test(c.ref) && c.kind === 'led') return 'LED matrix pixel ' + c.ref + ' of 96 (12 × 8)';
    return c.role || bpKind(c);
  }
  function bpQuery(c) {
    if (c.mpn) return c.mpn.split(' or ')[0];
    const size = bpSize(c);
    if (c.value && /^(cap|res|rarray|ind|ferrite|xtal|led|fuse)$/.test(c.kind)) return [c.value.replace(/\s+\d+V$/, ''), size, c.kind === 'cap' ? 'capacitor' : c.kind === 'res' ? 'resistor' : c.kind === 'rarray' ? 'resistor array' : c.kind === 'xtal' ? 'crystal' : c.kind === 'led' ? 'LED' : ''].filter(Boolean).join(' ');
    return '';
  }
  function bpTip(c) {
    return {
      title: c.ref + ' · ' + (c.mpn || c.value || bpKind(c)),
      sub: c.maker || (c.mpn && c.value ? c.value : ''),
      role: bpRole(c),
      rows: [['Part', c.mpn ? c.mpn : ''], ['Value', c.value], ['Package', c.pkg + (bpSize(c) && !c.pkg.includes(bpSize(c)) ? ' (' + bpSize(c) + ')' : '')], ['Marking', c.mark ? c.mark.join(' ') : '']],
      buy: bpQuery(c),
      details: () => showBoardPartCard(c)
    };
  }
  function onBoardPart(c, what, e) {
    if (what === 'enter') PinodePartTip.show(bpTip(c), e.clientX, e.clientY);
    else if (what === 'leave') PinodePartTip.hideSoon();
    else if (what === 'click') { PinodePartTip.hide(); showBoardPartCard(c); }
  }
  // what is printed on it, and what we can and cannot know from the files
  function bpMarkingHtml(c) {
    const lot = 'The date and lot code under it changes from batch to batch, so it is not drawn.';
    if (c.mark && (c.kind === 'ic' || c.kind === 'module')) {
      return `<div class="bpc-mark">${esc(c.mark.join(' '))}</div><div class="whint hint">${/^RP2-/.test(c.mark[0]) ? 'Printed on the chip.' : 'The drawing shows the part name from the design file. Big chips carry their name; the exact layout of the print is in the datasheet\'s marking section.'} ${lot}</div>`;
    }
    if (c.mark) return `<div class="bpc-mark">${esc(c.mark.join(' '))}</div><div class="whint hint">${c.kind === 'ecap' ? 'The capacitance printed on the can (µF). The design file does not give its voltage rating, so none is drawn.' : c.kind === 'xtal' ? 'The frequency printed on the can (MHz).' : 'The part\'s marking code.'}</div>`;
    if (/^(cap|res|rarray|ferrite)$/.test(c.kind) && /0201|0402|0603|CAY16|RESPACK/.test((c.pkg || '') + (c.mpn || ''))) return '<div class="whint hint">No print: chip parts this small are not marked.</div>';
    if (c.kind === 'led') return '<div class="whint hint">No print. The colour is in the part number' + (c.value ? ' (' + esc(c.value) + ')' : '') + '.</div>';
    if (/^(conn|usb|jack|button|jumper)$/.test(c.kind)) return '<div class="whint hint">Not marked.</div>';
    return '<div class="whint hint">Small packages carry a short marking code that the maker lists in the datasheet. The design file does not give it, so none is drawn.</div>';
  }
  async function showBoardPartCard(c) {
    const key = boardPartsKey();
    const src = (window.PINODE_BOARD_PARTS_SOURCE || {})[key] || '';
    const { def } = currentBoard();
    const q = bpQuery(c);
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal wide-modal part-modal';
    const kv = (k, v) => (v ? `<div class="pd-kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>` : '');
    const pics = (BOARD_IMAGES_FOR_CARD() || []).filter((i) => (i.face === 'back') === (c.side === 'bottom'));
    box.innerHTML = `
      <div class="modal-title">${esc(c.ref)} · ${esc(c.mpn || c.value || bpKind(c))} <span class="dim" style="padding:0">${esc(c.maker || '')}</span></div>
      <div class="pd-sub">${esc(bpRole(c))}</div>
      <div class="pd-grid">
        <div>
          ${kv('Type', bpKind(c))}${kv('Part number', c.mpn)}${kv('Maker', c.maker)}${kv('Value', c.value)}${kv('Package', c.pkg)}${kv('Description', c.desc)}
          ${kv('Side', c.side === 'bottom' ? 'Bottom of the board' : 'Top of the board')}${c.pins ? kv('Pads', String(c.pins)) : ''}
          ${c.note ? `<div class="whint danger">Check: ${esc(c.note)}</div>` : ''}
          <div class="pd-h">Factory marking</div>${bpMarkingHtml(c)}
          ${c.nets && c.nets.length ? `<div class="pd-h">Connected to</div><div class="bpc-nets">${c.nets.map((n) => `<span>${esc(n)}</span>`).join('')}</div>` : ''}
          <div class="pd-h">From the catalogue</div>
          <div class="bpc-cat"><p class="dim">${q ? 'Looking up ' + esc(q) + ' at LCSC…' : 'No part number in the design file for this one.'}</p></div>
        </div>
        <div>
          <div class="pd-h">On the board</div>
          <canvas class="bpc-photo" width="460" height="220"></canvas>
          <div class="dim bpc-photo-note" style="padding:2px 0 8px"></div>
          <div class="bpc-right"></div>
        </div>
      </div>
      <div class="pd-foot dim">Part data from ${esc(src || 'the maker\'s design files')}. Buy links open the shop's page in your browser: ElectriCAD never orders parts or sends files for you.</div>
      <div class="modal-btns">
        <span class="bpc-ds"></span>
        ${q ? PinodePartTip.buyLinks(q).map((l) => `<button class="action" data-url="${esc(l.url)}" data-shop="${l.id}">${esc(l.label)} ↗</button>`).join('') : ''}
        ${c.mpn ? '<button class="action" data-a="copy">Copy part number</button>' : ''}
        <button class="action" data-a="close">Close</button>
      </div>`;
    ov.appendChild(box);
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    box.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.url) api.openExternal(b.dataset.url);
      if (b.dataset.a === 'close') close();
      if (b.dataset.a === 'copy') { navigator.clipboard.writeText(c.mpn).catch(() => {}); toast('Copied ' + c.mpn, 1200); }
    });
    drawBoardPartPicture(box.querySelector('.bpc-photo'), box.querySelector('.bpc-photo-note'), def, c, pics);
    if (!q) return;
    // live catalogue: the exact part when LCSC has it, else the closest matches
    const cat = box.querySelector('.bpc-cat');
    const res = await api.parts.search({ q, limit: 12 }).catch((e) => ({ error: e.message, rows: [] }));
    if (!document.body.contains(box)) return;
    const rows = (res && res.rows) || [];
    const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const exact = c.mpn ? rows.find((r) => norm(r.mfr) === norm(q)) || rows.find((r) => norm(r.mfr).startsWith(norm(q)) && norm(q).length >= 6) : null;
    if (!exact) {
      cat.innerHTML = (res && res.error ? `<p class="dim">Catalogue unreachable (${esc(res.error)}). The buy links below still work.</p>` : '') +
        (rows.length ? `<p class="dim">${c.mpn ? 'LCSC does not list ' + esc(q) + ' itself. Close matches:' : 'Generic part: matching catalogue parts.'}</p>` +
          rows.slice(0, 4).map((r) => `<div class="catItem lcItem bpc-alt" data-lcsc="${esc(r.lcsc)}"><b>${esc(r.mfr)}</b> <span class="dim" style="padding:0">${esc(r.pkg || '')}</span><div class="lc-desc">${esc(r.desc || '')}</div><div class="cmeta"><span class="cprice">${money(r.price)}</span>${r.stock != null ? `<span class="cstock">${Number(r.stock).toLocaleString()} in stock</span>` : ''}<span class="dim" style="padding:0">${esc(r.lcsc)}</span></div></div>`).join('')
          : !(res && res.error) ? '<p class="dim">No catalogue match. Try the buy links below.</p>' : '');
      cat.querySelectorAll('[data-lcsc]').forEach((d) => d.addEventListener('click', () => { const r = rows.find((x) => x.lcsc === d.dataset.lcsc); openPartDetails(r.lcsc, r); }));
      return;
    }
    const d = await api.parts.details(exact.lcsc, { row: exact }).catch((e) => ({ error: e.message }));
    if (!document.body.contains(box)) return;
    const info = (d && !d.error && d.info) || { lcsc: exact.lcsc, mfr: exact.mfr, pkg: exact.pkg, desc: exact.desc, stock: exact.stock, price: exact.price };
    const ladder = (info.ladder || []).filter((l) => l.usd != null);
    const specs = (info.params || []).filter((p) => p.name && p.value && p.value !== '-');
    cat.innerHTML = `
      ${kv('LCSC #', info.lcsc)}${kv('Catalogue name', info.mfr)}${info.stock != null ? kv('Stock', Number(info.stock).toLocaleString()) : ''}
      ${ladder.length ? kv('Price', ladder.slice(0, 4).map((l) => l.qty + '+: ' + money(l.usd)).join(' · ')) : info.price != null ? kv('Price', money(info.price)) : ''}
      ${d && d.offline ? '<div class="whint hint">Offline: saved copy.</div>' : ''}
      <div class="pd-specs">${specs.slice(0, 14).map((p) => kv(p.name, p.value)).join('')}</div>`;
    // the LCSC shop button goes straight to the product page now
    const lb = box.querySelector('[data-shop="lcsc"]');
    if (lb) lb.dataset.url = 'https://www.lcsc.com/product-detail/' + info.lcsc + '.html';
    if (info.datasheet) {
      box.querySelector('.bpc-ds').innerHTML = '<button class="action primary" data-url="' + esc(info.datasheet) + '">📄 Datasheet</button>';
    }
    const right = box.querySelector('.bpc-right');
    const pins = d && d.part ? (PL.portsOf(d.part) || []) : [];
    const padOf = (d && d.part && d.part.lib && d.part.lib.pads) || {};
    right.innerHTML = `
      ${d && d.fp && d.fp.def ? '<div class="pd-h">Footprint</div><canvas class="pd-fp" width="460" height="220"></canvas>' : ''}
      ${pins.length ? `<div class="pd-h">Pinout</div><div class="pd-pins">${pins.map((p) => `<div class="pd-pin t-${esc(p.type)}"><b>${esc(padOf[p.id] || p.num || '')}</b><span>${esc(String(p.label).replace(/^\d+\s/, ''))}</span></div>`).join('')}</div>` : ''}
      ${d && d.part ? '<button class="action" data-a="full" style="margin-top:8px">Open the full catalogue card</button>' : ''}`;
    const fpc = right.querySelector('.pd-fp');
    if (fpc) drawFootprint(fpc, d.fp.def, padOf);
    const full = right.querySelector('[data-a="full"]');
    if (full) full.addEventListener('click', () => { close(); showPartDetails(d.part, { info: d.info, fpDef: d.fp && d.fp.def, offline: d.offline, partial: d.partial }); });
  }
  function BOARD_IMAGES_FOR_CARD() {
    const { rev } = currentBoard();
    return (rev && rev.images) || [];
  }
  // a close-up of the part: from Arduino's picture of the same revision when
  // there is one (front pictures for top parts, back photos for bottom ones),
  // else from the drawing
  function drawBoardPartPicture(cv, note, def, c, pics) {
    const g = cv.getContext('2d');
    g.fillStyle = '#0d0d0d'; g.fillRect(0, 0, cv.width, cv.height);
    const U = def.unitsPerMm || 4, s = 5;
    let [ax, ay] = def.toUnits(c.box[0], c.box[1]), [bx, by] = def.toUnits(c.box[2], c.box[3]);
    // a bottom part is shown as seen from the back: the mirrored frame
    if (c.side === 'bottom') { ax = def.w - ax; bx = def.w - bx; }
    const pad = 3 * U;
    let x1 = Math.min(ax, bx) - pad, y1 = Math.min(ay, by) - pad, w = Math.abs(bx - ax) + 2 * pad, h = Math.abs(by - ay) + 2 * pad;
    // keep the canvas shape so nothing is stretched
    const want = cv.width / cv.height;
    if (w / h < want) { const nw = h * want; x1 -= (nw - w) / 2; w = nw; } else { const nh = w / want; y1 -= (nh - h) / 2; h = nh; }
    const pic = pics.find((p) => p.kind === 'photo') || pics[0];
    const outline = () => {
      const k = cv.width / w;
      g.strokeStyle = '#ffa500'; g.lineWidth = 2;
      g.strokeRect((Math.min(ax, bx) - x1) * k, (Math.min(ay, by) - y1) * k, Math.abs(bx - ax) * k, Math.abs(by - ay) * k);
    };
    if (!pic) {
      // from the live drawing on screen
      const svg = $('boardHost').querySelector('svg');
      note.textContent = 'From the drawing (no picture of this side yet).';
      if (!svg) return;
      const clone = svg.cloneNode(true);
      clone.querySelectorAll('.bv-labels, .bv-hits').forEach((n) => n.remove());
      const gg = clone.querySelector('g'); if (gg) gg.setAttribute('transform', c.side === 'bottom' ? `matrix(-1 0 0 1 ${def.w} 0)` : 'matrix(1 0 0 1 0 0)');
      clone.setAttribute('viewBox', `0 0 ${def.w} ${def.h}`);
      clone.setAttribute('width', def.w * s); clone.setAttribute('height', def.h * s);
      const css = '.pcb{fill:#173420}.bp-ic{fill:#1b1b1d}.bp-module{fill:#b8bcc2}.bp-cap{fill:#b8956a}.bp-res,.bp-dark{fill:#181818}.bp-end{fill:#c9ccd0}.bp-xtal,.bp-can{fill:#cfd3d8}.bp-mark{fill:#ddd;font-family:monospace;font-weight:600}.bp-mark.dark{fill:#111}.pin-pad{fill:#c9a227}.led-lens{fill:#333}.hole{fill:#000}.usb{fill:#9aa0a6}';
      const st = document.createElementNS('http://www.w3.org/2000/svg', 'style'); st.textContent = css; clone.insertBefore(st, clone.firstChild);
      const img = new Image();
      img.onload = () => { g.drawImage(img, x1 * s, y1 * s, w * s, h * s, 0, 0, cv.width, cv.height); outline(); };
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(clone));
      return;
    }
    note.textContent = (pic.kind === 'photo' ? 'Photo: ' : 'Image: ') + pic.credit + ' (' + pic.license + ')';
    const img = new Image();
    img.onload = () => {
      // back pictures are stored as photographed, the same mirrored frame
      g.drawImage(img, x1 * s, y1 * s, w * s, h * s, 0, 0, cv.width, cv.height);
      outline();
    };
    img.src = pic.src;
  }

  $('boardBattery').addEventListener('change', (e) => { BV.battery = e.target.value; saveBV(); if (S.board) S.board.setBattery(BV.battery); });

  // ---- onboard LEDs: power, simulator ------------------------------------------
  // The ON LED is lit while the board has power: plugged in (its port is
  // listed), streaming telemetry, or the circuit simulator running it.
  // With no live board, a running simulation drives the pins (and so L and
  // any other pin LED) from the pins you set on the wiring canvas.
  function teleFresh() { return Date.now() - (S.lastTeleTs || 0) < 2000; }
  function boardPlugged() { return !!(S.port && (S.devices || []).some((d) => d.path === S.port)); }
  function simStates() { return window.PinodeWiring && PinodeWiring.simPinStates ? PinodeWiring.simPinStates() : null; }
  function updateBoardPower() {
    if (!S.board) return;
    S.board.powerOn(teleFresh() || boardPlugged() || !!simStates());
  }
  setInterval(() => {
    updateBoardPower();
    if (teleFresh() || !S.board) return;
    const sim = simStates();
    if (!sim) { if (S.boardSimPainted) { S.boardSimPainted = false; S.board.markStale(); } return; }
    const def = PINODE_BOARDS[S.boardDefId];
    const pins = [];
    for (let i = 0; i < (def.digitalCount || 0); i++) pins.push(sim.get(i) ? { pin: i, level: 0, ...sim.get(i) } : { pin: i, mode: 'in', level: 0 });
    S.board.paint(pins, []);
    S.boardSimPainted = true;
    const ts = $('teleState');
    if (ts.textContent !== 'simulated') { ts.textContent = 'simulated'; ts.className = 'badge sim'; }
  }, 400);
  // an upload is real serial traffic both ways: the TX/RX LEDs flicker
  let uploadBlink = null;
  function uploadLeds(on) {
    clearInterval(uploadBlink); uploadBlink = null;
    if (on) uploadBlink = setInterval(() => { if (!S.board) return; S.board.flash(Math.random() < 0.5 ? 'tx' : 'rx'); }, 70);
  }
  // side by side or stacked depends on the pane's shape: redo it when that changes
  if (window.ResizeObserver) {
    let rz = 0, lastDir = '';
    new ResizeObserver(() => { clearTimeout(rz); rz = setTimeout(() => {
      if (BV.mode !== 'both' || !S.board) return;
      const h = $('boardHost'), dir = h.clientWidth > h.clientHeight * 1.6 ? 'w' : 't';
      if (dir !== lastDir) { lastDir = dir; renderBoard(); }
    }, 150); }).observe($('boardHost'));
  }
  $('boardRev').addEventListener('change', (e) => { BV.rev[S.boardDefId] = e.target.value; saveBV(); renderBoard(); });
  $('boardImg').addEventListener('change', (e) => { BV.pick[S.boardDefId + ':' + ((currentBoard().rev || {}).id || '') + ':' + BV.face] = e.target.value; saveBV(); renderBoard(); });
  $('boardMode').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b || b.disabled) return; BV.mode = b.dataset.m; saveBV(); renderBoard(); });
  $('boardFace').addEventListener('click', () => { BV.face = BV.face === 'back' ? 'front' : 'back'; saveBV(); renderBoard(); });
  $('boardRot').addEventListener('click', () => { BV.rot = (BV.rot + 90) % 360; saveBV(); renderBoard(); });
  $('boardOpacity').addEventListener('input', (e) => {
    BV.opacity = Number(e.target.value) / 100; saveBV();
    const d = $('boardHost').querySelector('.bv-overlay .bv-draw'); if (d) d.setAttribute('opacity', String(BV.opacity));
  });

  function onPinHover(pin, latest) {
    const box = $('pinInspector');
    if (pin.tele == null) {
      box.textContent = `${pin.label}${pin.note ? ' — ' + pin.note : ''}${pin.power ? ' (power rail)' : ''}`;
      return;
    }
    const s = latest.state;
    let txt = `${pin.label}${pin.note ? ' (' + pin.note + ')' : ''} — `;
    if (!s || !latest.fresh) txt += 'no telemetry';
    else {
      txt += `${s.mode.toUpperCase()} · ${s.level ? 'HIGH' : 'LOW'}`;
      if (s.mode === 'pwm') txt += ` · duty ${s.pwm}/255`;
      if (pin.analogIndex != null && latest.analog != null) txt += ` · ADC ${latest.analog}`;
    }
    // sparkline from history ring
    if (latest.history && latest.history.n > 1) {
      const { ring, i, n } = latest.history;
      let spark = ' ';
      for (let k = 0; k < Math.min(n, 60); k++) {
        const v = ring[(i - Math.min(n, 60) + k + ring.length) % ring.length];
        spark += v === 2 ? '▒' : (v ? '▀' : '▁');
      }
      txt += '\n' + spark;
    }
    box.textContent = txt;
  }

  api.on('pins:telemetry', ({ source, port, snap }) => {
    // route: only the SELECTED device paints the board view
    if (source === 'serial') {
      if (!S.port) setPort(port);            // first stream wins if nothing chosen
      else if (port !== S.port) return;      // other boards keep streaming, quietly
    }
    S.lastTeleTs = Date.now();
    S.board && S.board.powerOn && S.board.powerOn(true);
    S.lastSnap = snap;
    const def = PINODE_BOARDS[S.boardDefId];
    if (source === 'pi' && S.boardDefId !== 'pi') setBoardView('pi');
    const pins = expandSnap(snap, def.digitalCount);
    S.lastPins = pins;
    S.board && S.board.paint(pins, snap.analog, snap);
    if (source === 'serial') S.board && S.board.flash && S.board.flash('tx');   // the telemetry line is serial out
    feedTimeline(pins.filter((p) => def.pins.some((q) => q.tele === p.pin)));
    const ts = $('teleState');
    ts.textContent = source === 'pi' ? 'pi live' : 'live';
    ts.className = 'badge';
    clearTimeout(ts._h);
    ts._h = setTimeout(() => { ts.textContent = 'stalled'; ts.className = 'badge off'; S.board && S.board.markStale(); updateBoardPower(); }, 2000);
  });
  api.on('pi:status', (s) => {
    $('stPi').textContent = 'pi: ' + (s.open ? s.host : 'off');
  });

  $('boardViewSelect').addEventListener('change', (e) => setBoardView(e.target.value));
  $('boardReport').addEventListener('click', (e) => { e.preventDefault(); reportBug(boardImageReport()); });

  // ---- AI copilot ----------------------------------------------------------
  function aiContext() {
    if (!S.ai.useContext) return null;
    const def = PINODE_BOARDS[S.boardDefId];
    const labeled = S.lastPins
      .map((p) => ({ ...p, label: (def.pins.find((q) => q.tele === p.pin) || {}).label }))
      .filter((p) => p.label);
    return {
      board: $('btnBoard').textContent + (S.fqbn ? ' (' + S.fqbn + ')' : ''),
      fileName: S.activeTab ? S.activeTab.name : '',
      code: S.activeTab ? S.activeTab.model.getValue() : '',
      selection: selectedText(),
      pins: labeled,
      analog: (S.lastSnap && S.lastSnap.analog) || [],
      serialTail: S.serialTail.slice(-60).join('\n'),
      diagnostics: S.diagnostics.filter((d) => d.inSketch).slice(0, 20),
      memory: S.memory || null,
      i2c: S.i2c.ts ? S.i2c.addresses.map((a) => U.hex2(a) + ' ' + U.i2cName(a)) : null
    };
  }
  function selectedText() {
    if (!S.editor || !S.activeTab) return '';
    const sel = S.editor.getSelection();
    return sel && !sel.isEmpty() ? S.activeTab.model.getValueInRange(sel).slice(0, 4000) : '';
  }

  function aiRender(role, text) {
    const box = $('aiLog');
    const hint = box.querySelector('.ai-hint');
    if (hint) hint.remove();
    const div = document.createElement('div');
    div.className = 'aiMsg ' + (role === 'user' ? 'user' : 'ai');
    div.innerHTML = `<div class="who">${role === 'user' ? 'YOU' : 'ELECTRICAD AI'}</div><div class="body"></div>`;
    renderMarkdownInto(div.querySelector('.body'), text);
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    return div.querySelector('.body');
  }

  // Small, safe renderer. Text is always set via textContent; only **bold**
  // and `code` get elements. Fenced blocks get Copy / Insert-at-cursor.
  function inlineInto(parent, text) {
    const re = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      const tok = m[0];
      const el = document.createElement(tok[0] === '`' ? 'code' : 'b');
      el.textContent = tok[0] === '`' ? tok.slice(1, -1) : tok.slice(2, -2);
      parent.appendChild(el);
      last = m.index + tok.length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }
  function renderMarkdownInto(el, text) {
    el.innerHTML = '';
    const parts = text.split(/```[\w+-]*\n?/);
    parts.forEach((part, i) => {
      if (i % 2 === 1) {
        const code = part.replace(/\n$/, '');
        const wrap = document.createElement('div');
        wrap.className = 'codeblock';
        const pre = document.createElement('pre');
        pre.textContent = code;
        const bar = document.createElement('div');
        bar.className = 'codebar';
        const copy = document.createElement('button');
        copy.className = 'mini'; copy.textContent = 'Copy';
        copy.addEventListener('click', () => {
          navigator.clipboard.writeText(code).then(() => { copy.textContent = '✓ Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1200); });
        });
        const ins = document.createElement('button');
        ins.className = 'mini'; ins.textContent = 'Insert';
        ins.title = 'Insert at the cursor (replaces the selection)';
        ins.addEventListener('click', () => {
          if (!S.activeTab) return toast('Open a file first');
          const sel = S.editor.getSelection();
          S.editor.executeEdits('ai', [{ range: sel, text: code, forceMoveMarkers: true }]);
          S.editor.focus();
        });
        bar.appendChild(copy); bar.appendChild(ins);
        wrap.appendChild(bar); wrap.appendChild(pre);
        el.appendChild(wrap);
      } else if (part) {
        const span = document.createElement('span');
        inlineInto(span, part);
        el.appendChild(span);
      }
    });
  }

  function aiHint() {
    const box = $('aiLog');
    if (box.children.length) return;
    box.innerHTML = '<div class="ai-hint dim">Ask anything about your sketch, wiring or board. With <b>ctx</b> on, the copilot sees your code, selection, live pins, serial output, compile errors and I2C devices.</div>';
  }

  async function aiAsk(text) {
    const q = String(text || '').trim();
    if (!q) return;
    if (S.ai.streaming) return toast('The copilot is still answering');
    if ($('right').classList.contains('collapsed')) togglePane('right');
    aiRender('user', q);
    S.ai.messages.push({ role: 'user', content: q });
    S.ai.streaming = true;
    $('aiStopBtn').classList.add('on');
    const body = aiRender('ai', '…');
    let acc = '', painted = false;
    const un = api.on('ai:chunk', ({ text }) => {
      acc += text;
      if (!painted) {
        painted = true;
        requestAnimationFrame(() => {
          painted = false;
          renderMarkdownInto(body, acc);
          $('aiLog').scrollTop = $('aiLog').scrollHeight;
        });
      }
    });
    let r;
    try { r = await api.ai.chat({ messages: S.ai.messages, context: aiContext() }); }
    catch (e) { r = { ok: false, error: e.message }; }
    un();
    S.ai.streaming = false;
    $('aiStopBtn').classList.remove('on');
    if (r.ok) {
      S.ai.messages.push({ role: 'assistant', content: r.text });
      renderMarkdownInto(body, r.text);
    } else {
      S.ai.messages.pop(); // don't keep an unanswered turn in the history
      renderMarkdownInto(body, r.aborted ? (acc || '') + '\n\n■ stopped' : '⚠ ' + (r.error || 'AI request failed. Configure a provider in Settings.'));
    }
    $('aiLog').scrollTop = $('aiLog').scrollHeight;
  }
  function aiSend() {
    const input = $('aiInput');
    const q = input.value.trim();
    if (!q || S.ai.streaming) return;
    input.value = '';
    aiAsk(q);
  }
  function aiClear() {
    if (S.ai.streaming) api.ai.abort();
    S.ai.messages = [];
    $('aiLog').innerHTML = '';
    aiHint();
  }
  $('aiInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); aiSend(); }
  });
  $('aiStopBtn').addEventListener('click', () => api.ai.abort());
  $('aiClearBtn').addEventListener('click', aiClear);
  $('aiContextBtn').addEventListener('click', () => {
    S.ai.useContext = !S.ai.useContext;
    $('aiContextBtn').classList.toggle('on', S.ai.useContext);
  });
  aiHint();

  // ---- side views / activity bar -------------------------------------------
  document.querySelectorAll('.act[data-view]').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.act').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('#side .view').forEach((v) =>
      v.classList.toggle('on', v.id === 'view-' + b.dataset.view));
    setWiringMode(false);
    if (b.dataset.view === 'libs') { refreshCores(); refreshInstalledLibs(); }
    if (b.dataset.view === 'catalog') { if ($('adaPane').classList.contains('hidden')) initJlc(); else initCatalog(); }
    if (b.dataset.view === 'settings') renderSettings();
    if (b.dataset.view === 'git') renderGit();
  }));

  // wiring designer toggle — swaps the editor for the canvas
  let wiringInited = false;
  function setWiringMode(on) {
    if (on && pcbActive()) { $('pcbHost').classList.add('hidden'); $('actPcb').classList.remove('on'); document.body.classList.remove('pcb-full'); }
    $('wiringHost').classList.toggle('hidden', !on);
    $('editor').classList.toggle('hidden', on || pcbActive());
    $('actWiring').classList.toggle('on', on);
    if (on) $('welcome').classList.add('hidden');
    else if (!S.activeTab && !pcbActive()) showWelcome(true);
    if (on && !wiringInited) {
      wiringInited = true;
      PinodeWiring.init($('wiringHost'), {
        api,
        getBoardDef: () => PINODE_BOARDS[S.boardDefId],
        getProjectDir: () => (S.project ? S.project.dir : ''),
        getPinStates: () => S.lastPins,
        telemetryFresh: () => Date.now() - (S.lastTeleTs || 0) < 2000,
        onFilesChanged: () => refreshTree(),
        toast
      });
    } else if (on) {
      PinodeWiring.onProjectChange();
    }
  }
  $('actWiring').addEventListener('click', () => setWiringMode($('wiringHost').classList.contains('hidden')));
  setInterval(() => { if (PinodeWiring.isActive()) PinodeWiring.refreshLive(); }, 500);

  // search in project (walks the loaded tree, reads files on demand)
  const TEXT_EXT = /\.(ino|pde|c|cc|cpp|cxx|h|hh|hpp|py|txt|md|json|ya?ml|ini|cfg|toml|js|ts|csv|S|s|properties)$/i;
  async function runSearch() {
    if (!S.project) return toast('Open a project first');
    const q = $('searchBox').value;
    if (!q.trim()) return;
    const box = $('searchResults');
    let re;
    try {
      const flags = $('searchCase').checked ? 'g' : 'gi';
      re = $('searchRegex').checked ? new RegExp(q, flags)
        : new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    } catch (e) { box.innerHTML = `<p class="warn">Bad regex: ${esc(e.message)}</p>`; return; }
    box.innerHTML = '<p class="dim">Searching…</p>';
    const files = [];
    (function collect(nodes) {
      for (const n of nodes) n.dir ? collect(n.children || []) : TEXT_EXT.test(n.name) && files.push(n);
    })(S.project.tree || []);
    const hits = [];
    let filesHit = 0;
    for (const f of files.slice(0, 600)) {
      if (hits.length >= 300) break;
      let text;
      const open = S.openTabs.find((t) => t.path === f.path);
      try { text = open ? open.model.getValue() : await api.file.read(f.path); } catch (err) { continue; }
      let any = false;
      text.split('\n').forEach((line, i) => {
        re.lastIndex = 0;
        if (hits.length < 300 && re.test(line)) { hits.push({ f, line: i + 1, text: line.trim().slice(0, 140) }); any = true; }
      });
      if (any) filesHit++;
    }
    box.innerHTML = '';
    if (!hits.length) { box.innerHTML = '<p class="dim">No matches.</p>'; return; }
    const sum = document.createElement('p');
    sum.className = 'dim';
    sum.textContent = `${hits.length}${hits.length >= 300 ? '+' : ''} matches in ${filesHit} file${filesHit === 1 ? '' : 's'}`;
    box.appendChild(sum);
    for (const h of hits) {
      const div = document.createElement('div');
      div.className = 'hit';
      div.innerHTML = `<div>${esc(h.text)}</div><div class="where">${esc(h.f.name)}:${h.line}</div>`;
      div.addEventListener('click', async () => {
        await openFile(h.f.path, h.f.name);
        S.editor.revealLineInCenter(h.line);
        S.editor.setPosition({ lineNumber: h.line, column: 1 });
        S.editor.focus();
      });
      box.appendChild(div);
    }
  }
  $('searchBox').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
  function findInProject() {
    document.querySelector('.act[data-view="search"]').click();
    const sel = selectedText();
    if (sel && !sel.includes('\n')) $('searchBox').value = sel;
    $('searchBox').focus();
    $('searchBox').select();
  }

  // libraries + cores
  async function libSearch(q) {
    document.querySelector('.act[data-view="libs"]').click();
    if (q != null) $('libBox').value = q;
    q = $('libBox').value.trim();
    if (!q) { $('libBox').focus(); return; }
    const box = $('libResults');
    box.innerHTML = '<p class="dim">Searching…</p>';
    const [libs, installed] = await Promise.all([
      api.toolchain.libSearch(q).catch(() => []),
      api.toolchain.libInstalled().catch(() => [])
    ]);
    const have = new Map(installed.map((l) => [l.name, l.version]));
    box.innerHTML = '';
    if (!libs.length) { box.innerHTML = '<p class="dim">No libraries found.</p>'; return; }
    for (const l of libs.slice(0, 50)) {
      const div = document.createElement('div');
      div.className = 'libItem';
      const v = have.get(l.name);
      div.innerHTML = `<b>${esc(l.name)}</b> <span class="dim">${esc(l.version || '')}${l.author ? ' · ' + esc(l.author) : ''}</span>
        <p>${esc(l.sentence || '')}</p>`;
      const btn = document.createElement('button');
      btn.className = 'mini';
      btn.textContent = v ? (v === l.version ? '✓ Installed' : 'Update to ' + l.version) : 'Install';
      btn.disabled = v === l.version;
      btn.addEventListener('click', async () => {
        btn.textContent = '…'; btn.disabled = true;
        const r = await api.toolchain.libInstall(l.name);
        btn.textContent = r.ok ? '✓ Installed' : 'Failed';
        if (!r.ok) { btn.disabled = false; toast((r.err || 'Install failed').slice(0, 200), 5000); }
        refreshInstalledLibs();
      });
      div.appendChild(btn);
      box.appendChild(div);
    }
  }
  $('libBox').addEventListener('keydown', (e) => { if (e.key === 'Enter') libSearch(); });
  $('btnLibsRefresh').addEventListener('click', () => { refreshInstalledLibs(); refreshCores(); });
  $('btnLibZip').addEventListener('click', () => libZip());
  $('btnLibUpd').addEventListener('click', () => libUpgradeAll());
  $('btnCoreUpd').addEventListener('click', () => coreUpgradeAll());
  async function refreshInstalledLibs() {
    const box = $('libInstalled');
    const libs = await api.toolchain.libInstalled().catch(() => []);
    box.innerHTML = '';
    api.toolchain.libUpdatable().then((ups) => {
      $('btnLibUpd').textContent = '⬆ ' + ups.length;
      $('btnLibUpd').classList.toggle('hidden', !ups.length);
    }).catch(() => {});
    if (!libs.length) { box.innerHTML = '<p class="dim">None yet.</p>'; return; }
    for (const l of libs.sort((a, b) => a.name.localeCompare(b.name))) {
      const div = document.createElement('div');
      div.className = 'libItem slim';
      div.innerHTML = `<b>${esc(l.name)}</b> <span class="dim">${esc(l.version || '')}</span>`;
      if (l.name !== 'ElectriCADTelemetry') {
        const btn = document.createElement('button');
        btn.className = 'mini'; btn.textContent = 'Remove';
        btn.addEventListener('click', async () => {
          const ok = await confirmDialog('Remove library', `Uninstall ${l.name} ${l.version || ''}?`,
            [{ label: 'Cancel', value: false }, { label: 'Uninstall', value: true, danger: true }]);
          if (!ok) return;
          const r = await api.toolchain.libUninstall(l.name);
          toast(r.ok ? 'Removed ' + l.name : 'Uninstall failed');
          refreshInstalledLibs();
        });
        div.appendChild(btn);
      }
      box.appendChild(div);
    }
  }
  async function refreshCores() {
    const cores = await api.toolchain.cores().catch(() => []);
    const box = $('coreList');
    box.innerHTML = '';
    // all of these have their board-manager URLs pre-injected: one click
    // installs, and compiling a detected board auto-installs its core anyway
    const known = [
      { id: 'arduino:avr', name: 'Arduino AVR (Uno, Nano, Mega)' },
      { id: 'esp32:esp32', name: 'ESP32 (DevKit, Feather ESP32, QT Py…)' },
      { id: 'esp8266:esp8266', name: 'ESP8266 (NodeMCU, Wemos D1)' },
      { id: 'rp2040:rp2040', name: 'RP2040/RP2350 (Pico, Feather RP2040)' },
      { id: 'adafruit:samd', name: 'Adafruit SAMD (Feather/Metro M0+M4)' },
      { id: 'adafruit:nrf52', name: 'Adafruit nRF52 (Feather Bluefruit)' },
      { id: 'adafruit:avr', name: 'Adafruit AVR (Feather 32u4, Trinket)' },
      { id: 'teensy:avr', name: 'Teensy' },
      { id: 'arduino:megaavr', name: 'Arduino megaAVR' },
      { id: 'arduino:samd', name: 'Arduino SAMD (Zero, MKR)' }
    ];
    for (const c of cores) {
      if (!known.some((k) => k.id === c.id)) known.push({ id: c.id, name: c.name || c.id });
    }
    for (const k of known) {
      const inst = cores.find((c) => c.id === k.id);
      const div = document.createElement('div');
      div.className = 'libItem slim';
      const upd = inst && inst.latest_version && inst.installed_version && inst.latest_version !== inst.installed_version;
      div.innerHTML = `<b>${esc(k.name)}</b> <span class="dim">${inst ? 'installed ' + esc(inst.installed_version || '') : ''}${upd ? ' · ' + esc(inst.latest_version) + ' available' : ''}</span>`;
      const btn = document.createElement('button');
      btn.className = 'mini';
      if (!inst || upd) {
        btn.textContent = upd ? 'Update' : 'Install';
        btn.addEventListener('click', async () => {
          btn.textContent = '…'; btn.disabled = true;
          const r = await api.toolchain.coreInstall(k.id);
          btn.textContent = r.ok ? '✓' : 'Failed';
          refreshCores();
        });
      } else {
        btn.textContent = 'Remove';
        btn.disabled = k.id === 'arduino:avr';
        btn.title = btn.disabled ? 'The AVR core is the fallback toolchain' : 'Uninstall this core';
        btn.addEventListener('click', async () => {
          const ok = await confirmDialog('Remove board core', `Uninstall ${k.name}? You can reinstall it any time.`,
            [{ label: 'Cancel', value: false }, { label: 'Uninstall', value: true, danger: true }]);
          if (!ok) return;
          btn.textContent = '…'; btn.disabled = true;
          const r = await api.toolchain.coreUninstall(k.id);
          toast(r.ok ? 'Removed ' + k.id : 'Uninstall failed');
          refreshCores();
        });
      }
      div.appendChild(btn);
      box.appendChild(div);
    }
  }

  // ---- adafruit parts catalog ----------------------------------------------
  // 5,500+ products, fully offline. Search, filter, and "Wire it": the item
  // is classified by interface and lands on the canvas with its canonical
  // hookup already wired to this board, ratings attached.

  // ---- bug and wrong-image reports → usekinode.app (sent by main/bugreport.js)
  const REPORT_KINDS = [['bug', 'Something is broken'], ['wrong_image', 'A picture is wrong (board, part, pins)'], ['crash', 'The app crashed or froze'], ['feature', 'An idea or request'], ['other', 'Something else']];
  function boardImageReport(extra) {
    const def = PINODE_BOARDS[S.boardDefId] || {};
    const cur = def.pins ? currentBoard() : { rev: null };
    const image = def.pins && BV.mode !== 'drawn' ? currentBoardImage() : null;
    const rev = cur.rev ? cur.rev.name : '';
    return { kind: 'wrong_image', board: S.boardDefId || S.fqbn || '', boardRevision: (extra && extra.revision) || rev, view: 'live board · ' + BV.mode + ' · ' + BV.face + ' · ' + BV.rot + '°',
      imageId: (extra && extra.imageId) || (image ? image.id : 'drawn:' + (S.boardDefId || 'unknown') + (cur.rev ? ':' + cur.rev.id : '') + ':' + BV.face),
      title: 'Wrong image: ' + (rev || def.name || S.boardDefId || 'board') + (BV.face === 'back' ? ' (back)' : ''), ...(extra || {}) };
  }
  window.electricadReportBug = (pre) => reportBug(pre || {});
  window.electricadReportImage = (extra) => reportBug(boardImageReport(extra));
  function reportBug(pre) {
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal report-modal';
    let email = '';
    try { email = localStorage.getItem('ec_report_email') || ''; } catch (e) { /* ok */ }
    const ctxRows = [['Board', pre.board], ['Revision', pre.boardRevision], ['View', pre.view], ['Image', pre.imageId]].filter(([, v]) => v);
    box.innerHTML = `
      <div class="modal-title">Report ${pre.kind === 'wrong_image' ? 'a wrong image' : 'a problem'}</div>
      <div class="rp-f"><label>What kind</label><select class="input" data-k="kind">${REPORT_KINDS.map(([v, l]) => `<option value="${v}" ${v === (pre.kind || 'bug') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
      <div class="rp-f"><label>Title</label><input class="input" data-k="title" maxlength="140" value="${esc(pre.title || '')}" placeholder="One line: what is wrong"></div>
      <div class="rp-f"><label>What happened</label><textarea class="input" data-k="description" maxlength="5000" rows="5" placeholder="${pre.kind === 'wrong_image' ? 'What is wrong in the picture: a pin label, header position, orientation, the wrong revision… (optional)' : 'What you did and what went wrong'}">${esc(pre.description || '')}</textarea></div>
      <div class="rp-f rp-bug"><label>Steps to repeat it</label><textarea class="input" data-k="steps" maxlength="4000" rows="3" placeholder="1. … 2. … (optional)"></textarea></div>
      <div class="rp-f rp-bug"><label>What you expected</label><input class="input" data-k="expected" maxlength="2000" placeholder="(optional)"></div>
      ${ctxRows.length ? `<div class="rp-ctx">${ctxRows.map(([k, v]) => `<div class="pd-kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>` : ''}
      <div class="rp-f"><label>Your email</label><input class="input" data-k="email" maxlength="254" value="${esc(email)}" placeholder="only if you want a reply (optional)"></div>
      <label class="rp-check"><input type="checkbox" data-k="shot" ${pre.kind === 'wrong_image' || !pre.kind || pre.kind === 'bug' ? 'checked' : ''}> Attach a screenshot of the app window</label>
      <div class="pd-foot dim">Sent to Kinode (usekinode.app) with the app version, Windows version and your board. Nothing else from your computer is included.</div>
      <div class="rp-err whint danger hidden"></div>
      <div class="modal-btns"><button class="action" data-a="cancel">Cancel</button><button class="action primary" data-a="send">Send report</button></div>`;
    ov.appendChild(box);
    document.body.appendChild(ov);
    const q = (k) => box.querySelector(`[data-k="${k}"]`);
    const syncKind = () => box.querySelectorAll('.rp-bug').forEach((e) => e.classList.toggle('hidden', q('kind').value === 'wrong_image' || q('kind').value === 'feature'));
    q('kind').addEventListener('change', syncKind); syncKind();
    const close = () => ov.remove();
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    box.querySelector('[data-a="cancel"]').addEventListener('click', close);
    const errEl = box.querySelector('.rp-err');
    box.querySelector('[data-a="send"]').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      const rep = { ...pre, kind: q('kind').value, title: q('title').value.trim(), description: q('description').value.trim(), steps: q('steps').value.trim(),
        expected: q('expected').value.trim(), email: q('email').value.trim(),
        context: { fqbn: S.fqbn || '', boardDefId: S.boardDefId || '', project: S.project ? S.project.manifest && S.project.manifest.type : '', view: pre.view || '' } };
      if (rep.kind === 'wrong_image' && !rep.title) rep.title = 'Wrong image: ' + (rep.board || 'board');
      try { localStorage.setItem('ec_report_email', rep.email); } catch (e) { /* ok */ }
      const shot = q('shot').checked;
      btn.disabled = true; btn.textContent = 'Sending…';
      // the screenshot shows the app, not this form
      if (shot) ov.style.visibility = 'hidden';
      await new Promise((r) => setTimeout(r, shot ? 120 : 0));
      const res = await api.bug.send(rep, { screenshot: shot }).catch((e) => ({ ok: false, error: e.message, offline: true }));
      ov.style.visibility = '';
      btn.disabled = false; btn.textContent = 'Send report';
      if (res && res.ok) {
        close();
        toast((res.duplicate ? 'Already reported as ' : 'Thanks! Report sent as ') + (res.ref || 'received') + '.', 4500);
        return;
      }
      errEl.classList.remove('hidden');
      errEl.innerHTML = esc((res && res.error) || 'The report could not be sent.') +
        (res && res.offline ? ' <a href="#" class="rp-web">Use the form on usekinode.app instead</a>' : '');
      const w = errEl.querySelector('.rp-web');
      if (w) w.addEventListener('click', (e) => { e.preventDefault(); api.openExternal(res.fallback || 'https://usekinode.app/products/electricad#report-wrong-image'); });
    });
    setTimeout(() => (pre.kind === 'wrong_image' ? q('description') : q('title')).focus(), 50);
  }

  // ---- JLCPCB / LCSC: every part JLCPCB can assemble, live -------------------
  // Search runs in main (main/partsdb.js); a part opens with its specs, price
  // breaks, datasheet, KiCad pinout and footprint, and drops onto the canvas.
  const PL = window.ElectriCADPartLib;
  let jlcInited = false, lcT = null, lcSeq = 0;
  function initJlc() {
    if (jlcInited) return;
    jlcInited = true;
    document.querySelectorAll('.cat-tab').forEach((b) => b.addEventListener('click', () => catTab(b.dataset.src)));
    const rerun = () => { clearTimeout(lcT); lcT = setTimeout(lcSearch, 350); };
    $('lcBox').addEventListener('input', rerun);
    $('lcBox').addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(lcT); lcSearch(); } });
    $('lcStock').addEventListener('change', lcSearch);
    $('lcBasic').addEventListener('change', lcSearch);
    api.parts.stats().then((st) => {
      if (st && !st.error) $('lcStats').innerHTML = `KiCad libraries: ${st.symbols.toLocaleString()} symbols, ${st.footprints.toLocaleString()} footprints (CC-BY-SA 4.0, KiCad Libraries Team) · ${st.cached} parts saved offline`;
    }).catch(() => {});
    lcSearch();
  }
  function catTab(src) {
    document.querySelectorAll('.cat-tab').forEach((b) => b.classList.toggle('on', b.dataset.src === src));
    $('jlcPane').classList.toggle('hidden', src !== 'jlc');
    $('adaPane').classList.toggle('hidden', src !== 'ada');
    if (src === 'ada') initCatalog();
    else initJlc();
  }
  // open the Parts view on the JLCPCB tab with a query (from the canvas palette)
  function searchRealParts(q) {
    const btn = document.querySelector('.act[data-view="catalog"]');
    if (btn && !btn.classList.contains('active')) btn.click();
    catTab('jlc');
    $('lcBox').value = q || '';
    lcSearch();
    $('lcBox').focus();
  }
  window.electricadSearchParts = searchRealParts;
  const money = (v) => (v == null ? '' : v < 0.01 ? '$' + v.toFixed(4) : v < 1 ? '$' + v.toFixed(3) : '$' + v.toFixed(2));
  async function lcSearch() {
    const q = $('lcBox').value.trim();
    const seq = ++lcSeq;
    $('lcStatus').textContent = q ? 'Searching the JLCPCB catalogue…' : '';
    const res = await api.parts.search({ q, inStock: $('lcStock').checked, basic: $('lcBasic').checked, limit: 60 }).catch((e) => ({ error: e.message, rows: [] }));
    if (seq !== lcSeq) return;
    const box = $('lcResults');
    box.innerHTML = '';
    const rows = (res && res.rows) || [];
    $('lcStatus').textContent = res && res.error ? res.error
      : !q ? (rows.length ? 'My parts: the ones you have placed. Search for anything else.' : 'Type a part number, a value (10k 0603) or an LCSC C-number.')
      : rows.length + ' part' + (rows.length === 1 ? '' : 's') + (res.source === 'offline' ? ' saved on this computer' : ' from JLCPCB');
    for (const r of rows) box.appendChild(lcItemEl(r));
  }
  function lcItemEl(r) {
    const div = document.createElement('div');
    div.className = 'catItem lcItem';
    const tag = r.basic ? '<span class="lc-basic" title="Basic part: no extra JLCPCB assembly setup fee">basic</span>'
      : r.preferred ? '<span class="lc-basic pref" title="Preferred extended part: no setup fee">preferred</span>'
      : '<span class="lc-ext" title="Extended part: JLCPCB charges a one-off setup fee per part type">extended</span>';
    const stock = r.stock == null ? '' : r.stock > 0 ? `<span class="cstock">${r.stock.toLocaleString()} in stock</span>` : '<span class="cdisc">out of stock</span>';
    div.innerHTML = `<b>${esc(r.mfr || r.lcsc)}</b> <span class="dim" style="padding:0">${esc(r.pkg || '')}</span>
      <div class="lc-desc">${esc(r.desc || '')}</div>
      <div class="cmeta"><span class="cprice">${money(r.price)}</span>${stock}${tag}<span class="dim" style="padding:0">${esc(r.lcsc)}</span>${r.cached ? '<span class="dim" style="padding:0" title="Saved on this computer: works offline">●</span>' : ''}</div>`;
    div.title = 'Specs, pinout, footprint and datasheet';
    div.addEventListener('click', () => openPartDetails(r.lcsc, r));
    return div;
  }
  async function openPartDetails(lcsc, row) {
    toast('Loading ' + lcsc + '…', 1200);
    const d = await api.parts.details(lcsc, { row }).catch((e) => ({ error: e.message }));
    if (!d || d.error) { toast('Could not load ' + lcsc + ': ' + ((d && d.error) || 'no answer'), 4500); return; }
    showPartDetails(d.part, { info: d.info, fpDef: d.fp && d.fp.def, offline: d.offline, partial: d.partial, fetched: d.fetched });
  }
  // a placed catalogue part: everything travels inside it, so this works offline
  window.electricadPartDetails = (part) => {
    const L = part.lib || {};
    showPartDetails(part, { info: { lcsc: L.lcsc, mfr: L.mfr, maker: L.maker, pkg: L.pkg, desc: L.desc, category: L.category, datasheet: L.datasheet, price: L.priceUsd,
      basic: L.basic, params: Object.entries((L.specs && L.specs.raw) || {}).map(([name, value]) => ({ name, value })) },
      fpDef: L.fpData ? PL.kicadToFp(L.fp, L.fpData) : null, placed: true });
  };
  function drawFootprint(cv, f, pads) {
    const g = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    g.fillStyle = '#0b3d22'; g.fillRect(0, 0, W, H);
    if (!f) { g.fillStyle = '#9ab'; g.font = '13px sans-serif'; g.textAlign = 'center'; g.fillText('No footprint assigned', W / 2, H / 2); return; }
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    const grow = (x, y) => { x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); };
    for (const p of f.pads) { grow(p.x - p.w / 2, p.y - p.h / 2); grow(p.x + p.w / 2, p.y + p.h / 2); }
    for (const s of f.silk || []) { if (s.l) { grow(s.l[0], s.l[1]); grow(s.l[2], s.l[3]); } if (s.c) { grow(s.c[0] - s.c[2], s.c[1] - s.c[2]); grow(s.c[0] + s.c[2], s.c[1] + s.c[2]); } }
    if (!isFinite(x1)) return;
    const z = Math.min((W - 40) / (x2 - x1 || 1), (H - 40) / (y2 - y1 || 1));
    const S = (x, y) => [W / 2 + (x - (x1 + x2) / 2) * z, H / 2 + (y - (y1 + y2) / 2) * z];
    g.strokeStyle = '#e8e8e8'; g.lineWidth = Math.max(1, 0.15 * z);
    for (const s of f.silk || []) {
      g.beginPath();
      if (s.l) { const a = S(s.l[0], s.l[1]), b = S(s.l[2], s.l[3]); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); }
      if (s.c) { const c = S(s.c[0], s.c[1]); g.arc(c[0], c[1], s.c[2] * z, 0, Math.PI * 2); }
      g.stroke();
    }
    const named = new Map(Object.entries(pads || {}).map(([k, v]) => [String(v), k]));
    for (const p of f.pads) {
      const [cx, cy] = S(p.x, p.y), w = p.w * z, h = p.h * z;
      g.fillStyle = p.num === '1' ? '#f0b040' : '#d4a72c';
      g.beginPath();
      if (p.shape === 'circle') g.arc(cx, cy, w / 2, 0, Math.PI * 2);
      else if (p.shape === 'oval') { const r = Math.min(w, h) / 2; g.roundRect ? g.roundRect(cx - w / 2, cy - h / 2, w, h, r) : g.rect(cx - w / 2, cy - h / 2, w, h); }
      else g.rect(cx - w / 2, cy - h / 2, w, h);
      g.fill();
      if (p.drill) { g.fillStyle = '#0b1410'; g.beginPath(); g.arc(cx, cy, p.drill * z / 2, 0, Math.PI * 2); g.fill(); }
      if (Math.min(w, h) > 11) { g.fillStyle = '#10161a'; g.font = `600 ${Math.min(14, Math.min(w, h) * 0.6)}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(p.num, cx, cy); }
    }
    for (const n of f.npth || []) { const [cx, cy] = S(n.x, n.y); g.fillStyle = '#000'; g.beginPath(); g.arc(cx, cy, n.d * z / 2, 0, Math.PI * 2); g.fill(); }
    g.fillStyle = '#9ab'; g.font = '11px sans-serif'; g.textAlign = 'left'; g.textBaseline = 'bottom';
    g.fillText(`${(x2 - x1).toFixed(2)} × ${(y2 - y1).toFixed(2)} mm · pad 1 highlighted`, 8, H - 6);
  }
  function showPartDetails(part, o) {
    const info = o.info || {}, L = part.lib || {};
    const swap = !o.placed && window.PinodeWiring.swapInfo ? window.PinodeWiring.swapInfo() : null;
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal wide-modal part-modal';
    const specs = (info.params || []).filter((p) => p.name && p.value && p.value !== '-');
    const sim = [];
    if (part.r != null) sim.push(['Resistance', U.ohms ? U.ohms(part.r) : part.r + ' Ω']);
    if (part.watts != null) sim.push(['Power rating', part.watts + ' W']);
    if (part.vr != null) sim.push(['Voltage rating', part.vr + ' V']);
    if (part.vf != null) sim.push(['Forward voltage', part.vf + ' V']);
    if (part.ifmax != null) sim.push(['Rated current', +(part.ifmax * 1000).toFixed(1) + ' mA']);
    if (part.vz != null) sim.push(['Zener voltage', part.vz + ' V']);
    if (part.vout != null) sim.push(['Output', part.vout + ' V (dropout ' + (part.dropout || 1.2) + ' V)']);
    if (part.ratings) for (const r of part.ratings.pairs) sim.push([(r.name || 'Supply') + ' range', r.min + '–' + r.max + ' V (damage above ' + r.abs + ' V)']);
    const pins = PL.portsOf(part) || ((window.PinodeParts.defOf(part) || {}).ports || []);
    const padOf = L.pads || {};
    const ladder = (info.ladder || []).filter((l) => l.usd != null);
    const notes = L.notes || [];
    const kind = { resistor: 'Resistor', capC: 'Ceramic capacitor', capE: 'Polarised capacitor', led: 'LED', diode: 'Diode', schottky: 'Schottky diode', zener: 'Zener diode',
      fuse: 'Fuse', inductor: 'Inductor', npn: 'NPN transistor', pnp: 'PNP transistor', nmos: 'N-MOSFET', pmos: 'P-MOSFET', linreg: 'Linear regulator', lib: 'IC / module' }[part.type] || part.type;
    box.innerHTML = `
      <div class="modal-title">${esc(info.mfr || part.name)} <span class="dim" style="padding:0">${esc(info.maker || '')}</span></div>
      <div class="pd-sub">${esc(info.desc || '')}</div>
      <div class="pd-grid">
        <div>
          <div class="pd-kv"><span>LCSC #</span><b class="pd-copy" title="Click to copy">${esc(info.lcsc || '—')}</b></div>
          <div class="pd-kv"><span>Package</span><b>${esc(info.pkg || '—')}</b></div>
          <div class="pd-kv"><span>On the canvas as</span><b>${esc(kind)}</b></div>
          <div class="pd-kv"><span>Category</span><b>${esc(info.category || '—')}</b></div>
          ${info.stock != null ? `<div class="pd-kv"><span>JLCPCB stock</span><b>${Number(info.stock).toLocaleString()}</b></div>` : ''}
          <div class="pd-kv"><span>Assembly</span><b>${info.basic ? 'Basic part (no setup fee)' : info.preferred ? 'Preferred (no setup fee)' : 'Extended (one-off setup fee)'}</b></div>
          ${ladder.length ? `<div class="pd-kv"><span>Price</span><b>${ladder.map((l) => esc(l.qty + '+: ' + money(l.usd))).join(' · ')}</b></div>` : info.price != null ? `<div class="pd-kv"><span>Price</span><b>${money(info.price)}</b></div>` : ''}
          ${o.offline ? '<div class="whint hint">Offline: showing what was saved on this computer.</div>' : ''}
          ${o.partial ? '<div class="whint hint">LCSC detail page unreachable: specs are from the search result only.</div>' : ''}
          ${sim.length ? `<div class="pd-h">What the simulator uses</div>${sim.map(([k, v]) => `<div class="pd-kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}` : ''}
          ${notes.length ? `<div class="pd-h">Check before you build</div>${notes.map((n) => `<div class="whint ${/confirm|no KiCad|assum|check the datasheet|pick one|polarity/i.test(n) ? 'danger' : 'hint'}">${esc(n)}</div>`).join('')}` : ''}
          <div class="pd-h">Specs (from the catalogue)</div>
          <div class="pd-specs">${specs.length ? specs.map((p) => `<div class="pd-kv"><span>${esc(p.name)}</span><b>${esc(p.value)}</b></div>`).join('') : '<p class="dim">The catalogue lists no parameters for this part.</p>'}</div>
        </div>
        <div>
          <div class="pd-h">Footprint ${L.fp ? `<span class="dim" style="padding:0">${esc(L.fp)}</span>` : ''}</div>
          <canvas class="pd-fp" width="460" height="300"></canvas>
          <div class="pd-h">Pinout ${L.symbol ? `<span class="dim" style="padding:0">KiCad ${esc(L.symbol)}${L.symbolMatch === 'prefix' ? ' (closest match)' : ''}</span>` : ''}</div>
          <div class="pd-pins">${pins.length ? pins.map((p) => `<div class="pd-pin t-${esc(p.type)}"><b>${esc(padOf[p.id] || p.num || '')}</b><span>${esc(String(p.label).replace(/^\d+\s/, ''))}</span></div>`).join('') : '<p class="dim">—</p>'}</div>
        </div>
      </div>
      <div class="pd-foot dim">Catalogue data from JLCPCB/LCSC${L.checked ? ', checked ' + esc(L.checked) : ''}. Symbols and footprints from the KiCad libraries (CC-BY-SA 4.0). ElectriCAD never orders parts for you.</div>
      <div class="modal-btns">
        ${info.datasheet ? '<button class="action" data-a="ds">📄 Datasheet</button>' : ''}
        ${info.lcsc ? '<button class="action" data-a="lcsc">LCSC page ↗</button>' : ''}
        ${!o.placed && swap ? `<button class="action primary" data-a="swap">⇄ Use for ${esc(swap.name)}</button><button class="action" data-a="place">🔌 Place as a new part</button>` : !o.placed ? '<button class="action primary" data-a="place">🔌 Place on canvas</button>' : '<button class="action" data-a="refresh">⟳ Latest stock and price</button>'}
        <button class="action" data-a="close">Close</button>
      </div>`;
    ov.appendChild(box);
    document.body.appendChild(ov);
    drawFootprint(box.querySelector('.pd-fp'), o.fpDef, padOf);
    const close = () => ov.remove();
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    box.querySelector('.pd-copy').addEventListener('click', () => { if (info.lcsc) { navigator.clipboard.writeText(info.lcsc).catch(() => {}); toast('Copied ' + info.lcsc, 1200); } });
    box.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', async () => {
      const a = b.dataset.a;
      if (a === 'close') close();
      if (a === 'ds') api.openExternal(info.datasheet);
      if (a === 'lcsc') api.openExternal('https://www.lcsc.com/product-detail/' + info.lcsc + '.html');
      if (a === 'refresh') { close(); const d = await api.parts.details(info.lcsc, { refresh: true }).catch(() => null); if (d && !d.error) showPartDetails(part, { info: d.info, fpDef: o.fpDef, placed: true, offline: d.offline }); else toast('Could not reach LCSC', 3000); }
      if (a === 'swap') {
        close();
        setWiringMode(true);
        setTimeout(() => { window.PinodeWiring.swapLibPart(swap.uid, part); if (info.lcsc) api.parts.used(info.lcsc).catch(() => {}); }, 150);
      }
      if (a === 'place') {
        close();
        setWiringMode(true);
        setTimeout(() => {
          window.PinodeWiring.placeLibPart(part);
          if (info.lcsc) api.parts.used(info.lcsc).catch(() => {});
        }, 150);
      }
    }));
  }

  let catalogInited = false;
  let catSearchT = null;
  async function initCatalog() {
    renderBench();
    if (catalogInited) return;
    catalogInited = true;
    const stats = await api.catalog.stats().catch(() => null);
    if (!stats || !stats.products) {
      $('catResults').innerHTML = '<p class="dim">Catalog data missing — hit ⟳ Refresh to download it from adafruit.com.</p>';
    } else {
      $('catCount').textContent = stats.products.toLocaleString();
      $('catCount').className = 'badge';
      $('catBaked').textContent = 'data: ' + (stats.baked || '?');
    }
    const cats = await api.catalog.cats().catch(() => []);
    for (const c of cats) {
      const o = document.createElement('option');
      o.value = c.id; o.textContent = `${c.name} (${c.n})`;
      $('catCategory').appendChild(o);
    }
    const rerun = () => { clearTimeout(catSearchT); catSearchT = setTimeout(catSearch, 180); };
    $('catBox').addEventListener('input', rerun);
    $('catCategory').addEventListener('change', catSearch);
    $('catStock').addEventListener('change', catSearch);
    $('catRefresh').addEventListener('click', async () => {
      $('catRefresh').textContent = '…downloading';
      try {
        const s = await api.catalog.refresh();
        $('catCount').textContent = s.products.toLocaleString();
        $('catBaked').textContent = 'data: ' + s.baked;
        toast('Catalog refreshed: ' + s.products.toLocaleString() + ' products');
        catSearch();
      } catch (e) { toast('Refresh failed: ' + e.message, 4000); }
      $('catRefresh').textContent = '⟳ Refresh data';
    });
    catSearch();
  }

  async function catSearch() {
    const rows = await api.catalog.search({
      q: $('catBox').value.trim(),
      cat: Number($('catCategory').value) || 0,
      inStock: $('catStock').checked,
      limit: 60
    }).catch(() => []);
    const box = $('catResults');
    box.innerHTML = '';
    if (!rows.length) { box.innerHTML = '<p class="dim">No matches.</p>'; return; }
    for (const p of rows) box.appendChild(catItemEl(p));
  }

  function catItemEl(p, benchNote) {
    const div = document.createElement('div');
    div.className = 'catItem';
    const price = p.price != null ? '$' + p.price.toFixed(2) : '';
    const stock = (p.flags & 1) ? '<span class="cdisc">discontinued</span>'
                : p.stock > 0 ? `<span class="cstock">${p.stock} in stock</span>`
                : '<span class="cdisc">out of stock</span>';
    const cls = window.PinodeParts.classify(p.name, p.catName);
    div.innerHTML = `<b>${esc(p.name)}</b>
      <div class="cmeta"><span class="cprice">${price}</span>${stock}
        ${cls ? `<span class="ciface">${esc(cls.iface)}</span>` : ''}
        <span class="dim" style="padding:0">#${p.id}</span></div>`;
    if (benchNote) div.querySelector('.cmeta').insertAdjacentHTML('beforeend',
      `<span class="cstock">● ${esc(benchNote)}</span>`);
    div.addEventListener('click', () => {
      if (div.querySelector('.cat-actions')) { div.querySelector('.cat-actions').remove(); return; }
      document.querySelectorAll('.cat-actions').forEach((a) => a.remove());
      const act = document.createElement('div');
      act.className = 'cat-actions';
      const wire = document.createElement('button');
      wire.className = 'mini';
      wire.textContent = '🔌 Wire it';
      wire.title = 'Place on the canvas with its canonical hookup, wired to this board';
      wire.addEventListener('click', (e) => {
        e.stopPropagation();
        setWiringMode(true);
        const r = window.PinodeWiring.placeCatalogItem({ id: p.id, name: p.name, catName: p.catName });
        if (r.iface) toast('Wired as ' + r.iface);
      });
      const open = document.createElement('button');
      open.className = 'mini';
      open.textContent = 'Product page ↗';
      open.addEventListener('click', (e) => { e.stopPropagation(); api.openExternal(p.url); });
      const info = document.createElement('button');
      info.className = 'mini';
      info.textContent = 'ⓘ how it wires';
      info.addEventListener('click', (e) => {
        e.stopPropagation();
        const c = window.PinodeParts.classify(p.name, p.catName);
        if (c) window.PinodeWiring.showPartInfo(c.type, p.name, c.iface);
        else toast('No interface classification — check the product\'s Adafruit guide.', 3000);
      });
      act.appendChild(wire); act.appendChild(info); act.appendChild(open);
      div.appendChild(act);
    });
    return div;
  }

  // live-detected Adafruit hardware ↔ catalog entries ("on your bench")
  async function renderBench() {
    const box = $('catBench');
    if (!box) return;
    box.innerHTML = '';
    const ada = S.devices.filter((d) => d.alive !== false &&
      /adafruit/i.test((d.name || '') + ' ' + (d.chip || '')));
    if (!ada.length) return;
    const head = document.createElement('div');
    head.className = 'view-head';
    head.textContent = 'ON YOUR BENCH';
    box.appendChild(head);
    for (const d of ada) {
      const row = document.createElement('div');
      row.className = 'benchItem';
      row.innerHTML = `⚡ ${esc(d.name)} <span class="dim2">${esc(d.path || '')}</span>`;
      row.title = 'Find this device in the catalog';
      row.addEventListener('click', async () => {
        $('catBox').value = d.name.replace(/^Adafruit\s+/i, '').replace(/\s*\(.*$/, '');
        catSearch();
      });
      box.appendChild(row);
    }
  }

  // settings panel
  function renderSettings() {
    const s = S.settings;
    const box = $('settingsPanel');
    box.innerHTML = '';
    // search box: hides every setting whose label doesn't match
    const search = document.createElement('input');
    search.className = 'input set-search'; search.placeholder = 'Search settings…'; search.value = S.setQuery || '';
    box.appendChild(search);
    const applyQuery = () => {
      const q = search.value.trim().toLowerCase();
      S.setQuery = search.value;
      let sec = null, secHas = false;
      const flush = () => { if (sec) sec.classList.toggle('hidden', !!q && !secHas); };
      for (const el of box.children) {
        if (el === search) continue;
        if (el.classList.contains('set-section')) { flush(); sec = el; secHas = false; continue; }
        const hit = !q || el.textContent.toLowerCase().includes(q) || (el.dataset.k || '').includes(q);
        el.classList.toggle('hidden', !hit);
        if (hit) secHas = true;
      }
      flush();
    };
    search.addEventListener('input', applyQuery);
    setTimeout(applyQuery, 0);
    const section = (title) => {
      const h = document.createElement('div');
      h.className = 'set-section';
      h.textContent = title;
      box.appendChild(h);
    };
    const field = (label, value, onChange, type = 'text', hint) => {
      const wrap = document.createElement('div');
      wrap.className = 'set-row';
      wrap.innerHTML = `<div class="dim">${esc(label)}</div>`;
      const input = document.createElement('input');
      input.className = 'input'; input.type = type; input.value = value ?? '';
      if (hint) input.placeholder = hint;
      input.addEventListener('change', () => onChange(input.value));
      wrap.appendChild(input);
      box.appendChild(wrap);
    };
    const sel = (label, value, options, onChange) => {
      const wrap = document.createElement('div');
      wrap.className = 'set-row';
      wrap.innerHTML = `<div class="dim">${esc(label)}</div>`;
      const s2 = document.createElement('select');
      s2.className = 'input';
      for (const o of options) {
        const [v, l] = Array.isArray(o) ? o : [o, o];
        const opt = document.createElement('option');
        opt.value = v; opt.textContent = l; s2.appendChild(opt);
      }
      s2.value = String(value);
      s2.addEventListener('change', () => onChange(s2.value));
      wrap.appendChild(s2);
      box.appendChild(wrap);
    };
    const check = (label, value, onChange) => {
      const wrap = document.createElement('label');
      wrap.className = 'set-check';
      const input = document.createElement('input');
      input.type = 'checkbox'; input.checked = !!value;
      input.addEventListener('change', () => onChange(input.checked));
      wrap.appendChild(input);
      wrap.appendChild(document.createTextNode(' ' + label));
      box.appendChild(wrap);
    };
    const ed = s.editor || {};
    section('EDITOR');
    field('Font size', s.editorFontSize || 14, (v) => setFontSize(Number(v) || 14), 'number');
    sel('Tab size', ed.tabSize || 2, [2, 4, 8], (v) => saveEd({ tabSize: Number(v) }));
    check('Word wrap', ed.wordWrap, (v) => saveEd({ wordWrap: v }));
    check('Minimap', ed.minimap !== false, (v) => saveEd({ minimap: v }));
    check('Auto-save (1.5 s after typing stops)', ed.autoSave !== false, (v) => saveEd({ autoSave: v }));
    check('Format on save (Arduino/C++)', !!ed.formatOnSave, (v) => saveEd({ formatOnSave: v }));
    check('Trim trailing whitespace on save', !!ed.trimOnSave, (v) => saveEd({ trimOnSave: v }));
    check('Sticky scroll (keep the function name at the top)', !!ed.stickyScroll, (v) => saveEd({ stickyScroll: v }));
    check('Show whitespace', !!ed.renderWhitespace, (v) => saveEd({ renderWhitespace: v }));
    check('Font ligatures (needs a font that has them, like Cascadia Code)', !!ed.ligatures, (v) => saveEd({ ligatures: v }));
    check('Pin check: warn about wrong pins for the board', s.pinCheck !== false, async (v) => { await save({ pinCheck: v }); recheckPins(); });
    check('Auto-close brackets and quotes', ed.autoClose !== false, (v) => saveEd({ autoClose: v }));
    sel('Cursor style', ed.cursorStyle || 'line', [['line', 'Line'], ['block', 'Block'], ['underline', 'Underline']], (v) => saveEd({ cursorStyle: v }));
    sel('Line numbers', ed.lineNumbers || 'on', [['on', 'On'], ['relative', 'Relative to the cursor'], ['off', 'Off']], (v) => saveEd({ lineNumbers: v }));
    check('Indentation guides', ed.guides !== false, (v) => saveEd({ guides: v }));
    check('Smooth cursor animation', !!ed.smoothCaret, (v) => saveEd({ smoothCaret: v }));
    sel('Editor font', ed.fontFamily || '', [['', 'Cascadia Code / Consolas (default)'], ['Consolas, monospace', 'Consolas'], ['"Courier New", monospace', 'Courier New'],
        ['"Lucida Console", monospace', 'Lucida Console'], ['"JetBrains Mono", Consolas, monospace', 'JetBrains Mono (if installed)'], ['"Fira Code", Consolas, monospace', 'Fira Code (if installed)']], (v) => saveEd({ fontFamily: v }));
    check('Save every file when ElectriCAD loses focus', !!ed.saveOnBlur, (v) => saveEd({ saveOnBlur: v }));
    section('APPEARANCE');
    sel('Theme', s.theme === 'light' ? 'light' : 'dark', ['dark', 'light'], async (v) => { await save({ theme: v }); applyTheme(v); });
    sel('Accent colour', s.accent || 'orange', [['orange', 'Orange'], ['blue', 'Blue'], ['green', 'Green'], ['purple', 'Purple']], async (v) => { await save({ accent: v }); applyLook(); });
    sel('Interface density', s.density || 'normal', [['normal', 'Normal'], ['compact', 'Compact']], async (v) => { await save({ density: v }); applyLook(); });
    sel('Icon size', s.iconSize || 'large', [['large', 'Large, with labels'], ['normal', 'Small']], async (v) => { await save({ iconSize: v }); applyLook(); });
    section('BUILD');
    sel('Compiler warnings', (s.build && s.build.warnings) || 'default', ['none', 'default', 'more', 'all'], (v) => save({ build: { warnings: v } }));
    check('Verbose build output', !!(s.build && s.build.verbose), (v) => save({ build: { verbose: v } }));
    {
      const wrap = document.createElement('div'); wrap.className = 'set-row'; wrap.dataset.k = 'board manager urls third-party cores';
      wrap.innerHTML = '<div class="dim">Extra board manager URLs, one per line (third-party boards: ATTinyCore, MiniCore, STM32…)</div>';
      const ta = document.createElement('textarea'); ta.className = 'input set-urls'; ta.rows = 3; ta.value = (s.boardUrls || []).join('\n');
      ta.placeholder = 'https://example.com/package_vendor_index.json';
      const b = document.createElement('button'); b.className = 'action'; b.style.margin = '0 10px 8px'; b.textContent = 'Save and update the board index';
      b.addEventListener('click', async () => {
        const urls = ta.value.split(/\s+/).map((x) => x.trim()).filter(Boolean);
        const bad = urls.filter((u) => !/^https?:\/\/\S+\.json(\?.*)?$/i.test(u));
        if (bad.length) return toast('Not a board index URL: ' + bad[0], 4000);
        await save({ boardUrls: urls });
        toast('Updating the board index…', 8000);
        const r = await api.toolchain.applyBoardUrls().catch((e) => ({ ok: false, err: e.message }));
        toast(r.ok ? '✓ Board index updated. New boards are in the board picker and Libraries → Board cores.' : 'Index update failed: ' + (r.err || 'unknown'), 5000);
      });
      wrap.appendChild(ta); wrap.appendChild(b); box.appendChild(wrap);
    }
    section('SERIAL');
    sel('Default baud', s.serialBaud || 115200, [9600, 19200, 38400, 57600, 74880, 115200, 230400, 460800, 921600],
        async (v) => { await save({ serialBaud: Number(v) }); $('serialBaud').value = v; });
    sel('Line ending', (s.serial && s.serial.lineEnding) || 'lf',
        [['none', 'No line ending'], ['lf', 'Newline'], ['cr', 'Carriage return'], ['crlf', 'Both NL & CR']],
        async (v) => { await save({ serial: { lineEnding: v } }); $('serialEnding').value = v; });
    sel('Lines kept in the monitor', (s.serial && s.serial.maxLines) || 5000, [1000, 5000, 20000, 50000],
        async (v) => { await save({ serial: { maxLines: Number(v) } }); SERIAL_MAX = Number(v); });
    check('Reconnect when the board is plugged back in', !(s.serial && s.serial.autoReconnect === false), (v) => save({ serial: { autoReconnect: v } }));
    check('Show the serial monitor after upload', !!(s.serial && s.serial.showAfterUpload), (v) => save({ serial: { showAfterUpload: v } }));
    check('Clear the serial monitor on upload', !!(s.serial && s.serial.clearOnUpload), (v) => save({ serial: { clearOnUpload: v } }));
    section('AI COPILOT');
    sel('Provider', s.ai.provider, ['anthropic', 'openai', 'ollama', 'custom'],
        (v) => save({ ai: { provider: v } }));
    field('Model', s.ai.model, (v) => save({ ai: { model: v.trim() } }), 'text', 'claude-opus-5-5');
    field('API key', s.ai.apiKey, (v) => save({ ai: { apiKey: v.trim() } }), 'password');
    field('Base URL (ollama/custom)', s.ai.baseUrl, (v) => save({ ai: { baseUrl: v.trim() } }));
    field('Max answer length (tokens)', s.ai.maxTokens || 8192, (v) => save({ ai: { maxTokens: Math.max(256, Number(v) || 8192) } }), 'number');
    section('RASPBERRY PI');
    field('Host (pigpiod)', s.pi.host, (v) => save({ pi: { host: v.trim() } }), 'text', 'raspberrypi.local');
    const btn = document.createElement('button');
    btn.className = 'action'; btn.style.margin = '6px 10px';
    btn.textContent = 'Connect to Pi';
    btn.addEventListener('click', connectPi);
    box.appendChild(btn);
    section('PROJECTS');
    field('Projects folder', s.projectsDir, (v) => save({ projectsDir: v.trim() }));
    check('Open the last project when ElectriCAD starts', s.openLast !== false, (v) => save({ openLast: v }));
    section('APP');
    check('Desktop notification when a long build or upload finishes', s.notifications !== false, (v) => save({ notifications: v }));
    {
      const b = document.createElement('button'); b.className = 'action danger'; b.style.margin = '6px 10px'; b.textContent = 'Reset all settings to defaults…';
      b.addEventListener('click', resetSettings);
      box.appendChild(b);
    }
    const about = document.createElement('p');
    about.className = 'dim';
    api.app.info().then((i) => { about.textContent = `ElectriCAD ${i.version} · Electron ${i.electron} · Node ${i.node}`; }).catch(() => {});
    box.appendChild(about);
    async function save(patch) { S.settings = await api.settings.set(patch); }
    async function saveEd(patch) { await save({ editor: patch }); applyEditorSettings(); }
  }

  async function connectPi() {
    let host = S.settings.pi.host;
    if (!host) {
      const r = await dialog({ title: 'Connect to Raspberry Pi', okLabel: 'Connect',
        fields: [{ key: 'host', label: 'Hostname / IP (pigpiod must be running)',
                   placeholder: 'raspberrypi.local' }] });
      host = r && r.host.trim();
    }
    if (!host) return;
    S.settings = await api.settings.set({ pi: { host } });
    toast('Connecting to ' + host + '…');
    try {
      await api.pi.connect({ host, port: S.settings.pi.port });
      setBoardView('pi');
      toast('🥧 Pi connected — GPIO live');
    } catch (e) { toast('Pi: ' + e.message, 4000); }
  }

  // ---- command palette -----------------------------------------------------
  let paletteItems = [];
  function palette(items, placeholder) {
    paletteItems = items;
    S.paletteSel = 0;
    $('paletteInput').value = '';
    $('paletteInput').placeholder = placeholder || 'Type a command…';
    $('palette').classList.remove('hidden');
    renderPalette();
    $('paletteInput').focus();
  }
  function renderPalette() {
    const q = $('paletteInput').value.toLowerCase();
    const list = $('paletteList');
    list.innerHTML = '';
    const vis = paletteItems.filter((i) => i.label.toLowerCase().includes(q)).slice(0, 40);
    vis.forEach((item, i) => {
      const div = document.createElement('div');
      div.className = 'pitem' + (i === S.paletteSel ? ' sel' : '');
      div.innerHTML = `<span>${item.recent ? '<span class="recent-dot" title="recently used">●</span> ' : ''}${esc(item.label)}</span>${item.keys ? `<span class="keys">${item.keys}</span>` : ''}`;
      div.addEventListener('click', () => { hidePalette(); item.run(); });
      list.appendChild(div);
    });
    list._vis = vis;
  }
  function hidePalette() { $('palette').classList.add('hidden'); }
  $('paletteInput').addEventListener('input', () => { S.paletteSel = 0; renderPalette(); });
  $('paletteInput').addEventListener('keydown', (e) => {
    const vis = $('paletteList')._vis || [];
    if (e.key === 'Escape') hidePalette();
    else if (e.key === 'ArrowDown') { S.paletteSel = Math.min(S.paletteSel + 1, vis.length - 1); renderPalette(); }
    else if (e.key === 'ArrowUp') { S.paletteSel = Math.max(S.paletteSel - 1, 0); renderPalette(); }
    else if (e.key === 'Enter' && vis[S.paletteSel]) { hidePalette(); vis[S.paletteSel].run(); }
  });
  // click-away closes the palette — on MOUSEDOWN, not click: a palette opened
  // synchronously from a button's click handler would otherwise be closed by
  // that very click as it bubbles to the document (Devices chip, ⌘ button).
  document.addEventListener('mousedown', (e) => {
    if (!$('palette').classList.contains('hidden') && !$('palette').contains(e.target)) hidePalette();
  });

  function mainPalette() {
    const items = [
      { label: 'Board options (CPU speed, partition scheme, USB mode…)', keys: 'Ctrl+Alt+O', run: boardOptions },
      { label: 'Board info', run: boardInfo },
      { label: 'Upload using programmer', keys: 'Ctrl+Shift+U', run: uploadProgrammer },
      { label: 'Burn bootloader…', run: burnBootloader },
      { label: 'Clean build (rebuild everything)', run: () => verify({ clean: true }) },
      { label: 'Include library…', run: includeLib },
      { label: 'Library examples…', run: libExamplesMenu },
      { label: 'Check pins against the board', keys: 'Ctrl+Alt+P', run: () => pinCheckReport(false) },
      { label: 'Format document', keys: 'Shift+Alt+F', run: formatActive },
      { label: 'Go to file…', keys: 'Ctrl+P', run: quickOpen },
      { label: 'Go to line…', keys: 'Ctrl+G', run: () => editorAction('editor.action.gotoLine') },
      { label: 'TODO / FIXME list', run: todoList },
      { label: 'New class (.h + .cpp)…', run: newClass },
      { label: 'Reopen closed tab', keys: 'Ctrl+Shift+T', run: reopenTab },
      { label: 'Close other tabs', run: () => closeOthers() },
      { label: 'Close all tabs', run: closeAll },
      { label: 'Toggle word wrap', keys: 'Alt+Z', run: () => toggleEditorSetting('wordWrap', 'Word wrap') },
      { label: 'Toggle minimap', run: () => toggleEditorSetting('minimap', 'Minimap') },
      { label: 'Electronics calculators', keys: 'Ctrl+Alt+C', run: () => showCalculators() },
      ...CALCS.map((c) => ({ label: 'Calculator: ' + c.name, run: () => showCalculators(c.id) })),
      { label: 'Board pinout', keys: 'Ctrl+Alt+I', run: showPinout },
      { label: 'Toggle light / dark theme', keys: 'Ctrl+Alt+T', run: toggleTheme },
      { label: 'Zen mode (editor only)', keys: 'Ctrl+Alt+Z', run: zen },
      { label: 'Serial: send a file…', run: serialSendFile },
      { label: 'Serial: quick-send commands…', keys: 'Ctrl+Alt+M', run: serialMacros },
      { label: 'Serial: copy all output', run: serialCopy },
      { label: 'Python: run selection on board', keys: 'F6', run: upyRunSel },
      { label: 'Python: download all board files', run: upyDownloadAll },
      { label: 'Python: set board clock to PC time', run: upySetClock },
      { label: 'CircuitPython: open CIRCUITPY drive', run: cpyOpenDrive },
      { label: 'Git: switch / create branch…', run: gitBranchMenu },
      { label: 'Canvas: save as PNG image', run: () => { setWiringMode(true); setTimeout(() => PinodeWiring.exportImage(), 300); } },
      { label: 'Export settings…', run: exportSettings },
      { label: 'Import settings…', run: importSettings },
      { label: 'Verify / Compile', keys: 'Ctrl+R', run: verify },
      { label: 'Upload', keys: 'Ctrl+U', run: upload },
      { label: 'Cancel build', run: cancelBuild },
      { label: 'Export compiled binary (.hex/.bin/.uf2)', keys: 'Ctrl+Alt+S', run: exportBinary },
      { label: 'Python: run on board', keys: 'F5', run: upyRun },
      { label: 'Python: stop program', keys: 'Shift+F5', run: upyStop },
      { label: 'Python: soft reset board', run: upySoftReset },
      { label: 'Python: upload project to board', run: upyUpload },
      { label: 'Python: board files…', run: upyFiles },
      { label: 'Python: board info', run: upyInfo },
      { label: 'New MicroPython project…', run: () => newProject('micropython') },
      { label: 'New CircuitPython project…', run: () => newProject('circuitpython') },
      { label: 'Source control', keys: 'Ctrl+Shift+G', run: () => document.querySelector('.act[data-view="git"]').click() },
      { label: 'Git: set name & email for commits', run: gitIdentity },
      { label: 'Add .ZIP library…', run: libZip },
      { label: 'Update all libraries', run: libUpgradeAll },
      { label: 'Update all board cores', run: coreUpgradeAll },
      { label: 'Save file', keys: 'Ctrl+S', run: saveActive },
      { label: 'Save all', keys: 'Ctrl+Shift+S', run: () => saveAll() },
      { label: 'Open project…', keys: 'Ctrl+O', run: chooseProject },
      { label: 'Open folder / Arduino sketch…', run: openFolder },
      { label: 'New Arduino sketch…', keys: 'Ctrl+N', run: () => newProject('arduino') },
      { label: 'New from example…', keys: 'Ctrl+Shift+E', run: chooseExample },
      { label: 'New Raspberry Pi project…', run: () => newProject('pi') },
      { label: 'New file in project…', run: () => S.project && newFileIn(S.project.dir) },
      { label: 'Find in project', keys: 'Ctrl+Shift+F', run: findInProject },
      { label: 'Select board…', keys: 'Ctrl+Shift+B', run: chooseBoard },
      { label: 'Devices — all detected boards & chips…', keys: 'Ctrl+Shift+D', run: deviceMenu },
      { label: 'Add live telemetry to this sketch', run: addTelemetry },
      { label: 'Reset board (DTR/RTS)', run: resetBoard },
      { label: 'Wiring designer', keys: 'Ctrl+Shift+W', run: () => setWiringMode(true) },
      { label: 'Library manager', keys: 'Ctrl+Shift+I', run: () => libSearch() },
      { label: 'Adafruit parts catalog…', run: () => document.querySelector('.act[data-view="catalog"]').click() },
      { label: 'Connect to Raspberry Pi (live GPIO)…', run: connectPi },
      { label: 'Disconnect Pi', run: () => api.pi.disconnect() },
      { label: 'Close all serial ports', run: () => api.serial.close() },
      { label: 'Serial monitor', keys: 'Ctrl+Shift+M', run: () => showPanel('serial') },
      { label: 'Plotter', keys: 'Ctrl+Shift+L', run: () => showPanel('plotter') },
      { label: 'Pin timeline', run: () => showPanel('timeline') },
      { label: 'I2C bus', run: () => showPanel('i2c') },
      { label: 'Clear serial monitor', run: clearSerial },
      { label: 'Toggle side bar', keys: 'Ctrl+B', run: () => togglePane('side') },
      { label: 'Toggle bottom panel', keys: 'Ctrl+J', run: () => togglePane('bottom') },
      { label: 'Toggle board & AI pane', keys: 'Ctrl+Alt+B', run: () => togglePane('right') },
      { label: 'Reveal project in Explorer', keys: 'Ctrl+K', run: revealProject },
      { label: 'AI: explain the selection', run: () => { const t = selectedText(); t ? aiAsk('Explain this code:\n```cpp\n' + t + '\n```') : toast('Select some code first'); } },
      { label: 'AI: new conversation', run: aiClear },
      { label: 'Settings', keys: 'Ctrl+,', run: () => document.querySelector('.act[data-view="settings"]').click() },
      { label: 'Full screen on or off', keys: 'F11', run: () => api.app.win('fullscreen') },
      { label: 'Report a bug', run: () => reportBug({}) },
      { label: 'Report a wrong board image', run: () => reportBug(boardImageReport()) },
      { label: 'Keyboard shortcuts', keys: 'F1', run: showShortcuts },
      ...Object.values(PINODE_BOARDS).map((b) => ({
        label: 'Board view: ' + b.name, run: () => setBoardView(b.id)
      })),
      { label: 'Refresh file tree', run: refreshTree },
      { label: 'About ElectriCAD', run: showAbout },
      // v0.9
      { label: 'PCB layout', keys: 'Ctrl+Shift+X', run: () => setPcbMode(true) },
      { label: 'Manufacturing overview (fab files, BOM, order)', run: manufacturing },
      { label: 'Order PCBs from a Gerber zip…', run: () => orderFromZip() },
      { label: 'Preview a Gerber zip…', run: () => COMMANDS.gerberPreview() },
      { label: 'Export BOM…', run: exportBom },
      { label: 'Export netlist (KiCad / CSV)…', run: exportNetlist },
      { label: 'Export pick-and-place (CPL)', run: exportCpl },
      { label: 'Local history of this file…', run: localHistory },
      { label: 'Compare with saved', run: compareWithSaved },
      { label: 'Compare with another file…', run: compareFiles },
      { label: 'Replace in project…', keys: 'Ctrl+Shift+H', run: replaceInProject },
      { label: 'Go to symbol in file…', keys: 'Ctrl+Shift+O', run: () => editorAction('editor.action.quickOutline') },
      { label: 'Go to definition', keys: 'F12 in the editor', run: () => editorAction('editor.action.revealDefinition') },
      { label: 'Markdown preview', run: markdownPreview },
      { label: 'Image to C array…', run: imageToC },
      { label: 'Sort lines', run: () => editorAction('editor.action.sortLinesAscending') },
      { label: 'Join lines', run: () => editorAction('editor.action.joinLines') },
      { label: 'UPPER CASE selection', run: () => editorAction('editor.action.transformToUppercase') },
      { label: 'lower case selection', run: () => editorAction('editor.action.transformToLowercase') },
      { label: 'Duplicate selection', run: () => editorAction('editor.action.duplicateSelection') },
      { label: 'Delete line', keys: 'Ctrl+Shift+K', run: () => editorAction('editor.action.deleteLines') },
      { label: 'Jump to matching bracket', run: () => editorAction('editor.action.jumpToBracket') },
      { label: 'Column (box) selection on/off', run: toggleColumnSelection },
      { label: 'Arduino reference for the word at the cursor', keys: 'Ctrl+Alt+R', run: arduinoReference },
      { label: 'Build for several boards…', run: multiBuild },
      { label: 'Build flags and defines…', run: buildFlags },
      { label: 'Open the build folder', run: openBuildFolder },
      { label: 'Upload the last build (no recompile)', keys: 'Ctrl+Alt+U', run: () => upload({ lastBuild: true }) },
      { label: 'Install a library version…', run: () => libVersionInstall() },
      { label: 'Installed library details…', run: libDetails },
      { label: 'Rename project…', run: renameProject },
      { label: 'Duplicate project…', run: duplicateProject },
      { label: 'Archive project as .zip…', run: archiveProject },
      { label: 'Find a datasheet…', run: datasheet },
      { label: 'Python: upload this file only', run: upyUploadCurrent },
      { label: 'Python: new folder on the board…', run: upyMkdir },
      { label: 'Python: get firmware…', run: pyFirmware },
      { label: 'AI: new sketch from a description…', run: aiGenerate },
      { label: 'AI: save the chat as Markdown…', run: aiSaveChat },
      { label: 'ElectriCAD guide', run: showGuide },
      { label: 'What\'s new', run: () => showWhatsNew(appVersion) },
      { label: 'Reset all settings…', run: resetSettings },
      ...['series', 'wire', 'trace', 'npn', 'zener', 'pwm', 'servo', 'stepper', 'ntc', 'timer1', 'db', 'numconv', 'ascii', 'rgb565', 'notes', 'i2c', 'crc']
        .map((id) => ({ label: 'Calculator: ' + (CALCS.find((c) => c.id === id) || {}).name, run: () => showCalculators(id) }))
    ];
    // recently used first, then everything else
    const recent = recentCommands();
    const top = recent.map((l) => items.find((i) => i.label === l)).filter(Boolean).map((i) => ({ ...i, label: i.label, recent: true }));
    const rest = items.filter((i) => !recent.includes(i.label));
    palette(top.concat(rest).map((i) => ({ ...i, run: () => { rememberCommand(i.label); return i.run(); } })));
  }

  // ---- panes ---------------------------------------------------------------
  const PANE_SPLIT = { side: 'splitSide', bottom: 'splitBottom', right: 'splitRight' };
  function togglePane(name, force) {
    const el = $(name);
    const collapse = force != null ? !force : !el.classList.contains('collapsed');
    el.classList.toggle('collapsed', collapse);
    // the strip stays, so a hidden panel can be dragged (or double-clicked) back open
    $(PANE_SPLIT[name]).classList.remove('hidden');
    $(PANE_SPLIT[name]).classList.toggle('split-shut', collapse);
    try { localStorage.setItem('ec_pane_' + name, collapse ? '0' : '1'); } catch (e) {}
    if (S.editor) setTimeout(() => S.editor.layout(), 0);
  }

  // ---- welcome screen --------------------------------------------------------
  async function showWelcome(on) {
    const w = $('welcome');
    w.classList.toggle('hidden', !on);
    if (!PinodeWiring.isActive()) $('editor').classList.toggle('hidden', !!on);
    if (!on) return;
    const projects = await api.project.list().catch(() => []);
    const examples = await api.project.examples().catch(() => []);
    w.innerHTML = `<div class="welcome-inner">
      <h1><span class="brand-mark">◧</span> ElectriCAD</h1>
      <p class="dim">Write it, wire it, watch it run.</p>
      <div class="welcome-cols">
        <div><h3>Start</h3><div id="wStart"></div></div>
        <div><h3>Recent</h3><div id="wRecent"></div></div>
        <div><h3>Examples</h3><div id="wExamples"></div></div>
      </div>
      <p class="welcome-tip">💡 ${esc(TIPS[Math.floor(Math.random() * TIPS.length)])}</p>
      <p class="dim2">Ctrl+Shift+P for every command · F1 for shortcuts</p>
    </div>`;
    const link = (parent, label, run, sub) => {
      const a = document.createElement('div');
      a.className = 'wlink';
      a.innerHTML = `<span>${esc(label)}</span>${sub ? `<span class="dim2">${esc(sub)}</span>` : ''}`;
      a.addEventListener('click', run);
      parent.appendChild(a);
    };
    const start = w.querySelector('#wStart');
    if (S.project) {
      link(start, '＋ New file in ' + S.project.manifest.name, () => newFileIn(S.project.dir));
      (S.project.tree || []).filter((n) => !n.dir).slice(0, 6).forEach((n) => link(start, '📄 ' + n.name, () => openFile(n.path, n.name)));
    }
    link(start, '⚡ New Arduino sketch', () => newProject('arduino'), 'Ctrl+N');
    link(start, '🐍 New MicroPython / CircuitPython project', () => newProject('micropython'));
    link(start, '🥧 New Raspberry Pi project', () => newProject('pi'));
    link(start, '📂 Open folder / Arduino sketch', openFolder);
    link(start, '🔌 Wiring designer', () => setWiringMode(true), 'Ctrl+Shift+W');
    link(start, '📚 Library examples', libExamplesMenu);
    link(start, '🧮 Electronics calculators', () => showCalculators(), 'Ctrl+Alt+C');
    const rec = w.querySelector('#wRecent');
    if (!projects.length) rec.innerHTML = '<p class="dim">No projects yet.</p>';
    projects.slice(0, Math.max(8, projects.filter((p) => p.pinned).length)).forEach((p) => {
      link(rec, (p.pinned ? '★ ' : '') + typeIcon(p.type) + ' ' + p.name,
        async () => loadProject(await api.project.open(p.dir).catch((e) => (toast(e.message, 4000), null))),
        p.fqbn || (p.unmanaged ? 'Arduino sketch' : ''));
      const row = rec.lastChild;
      const pin = document.createElement('button');
      pin.className = 'mini wpin' + (p.pinned ? ' on' : '');
      pin.textContent = p.pinned ? '★' : '☆';
      pin.title = p.pinned ? 'Unpin from the top of this list' : 'Pin to the top of this list';
      pin.addEventListener('click', async (e) => { e.stopPropagation(); await api.project.pin(p.dir, !p.pinned); showWelcome(true); });
      row.appendChild(pin);
    });
    const ex = w.querySelector('#wExamples');
    examples.forEach((e) => link(ex, typeIcon(e.type) + ' ' + e.name, () => newProject(e.type, e), e.desc));
  }

  // ---- telemetry helper ------------------------------------------------------
  function addTelemetry() {
    const tab = S.activeTab;
    if (!tab || !/\.(ino|pde)$/i.test(tab.name)) return toast('Open the sketch (.ino) first');
    const m = tab.model;
    let src = m.getValue();
    if (/ELECTRICAD_TICK\s*\(/.test(src) && /ElectriCADTelemetry\.h/.test(src)) return toast('This sketch already streams telemetry');
    const edits = [];
    // after the sketch's own includes, so it can see the LED matrix frame
    if (!/ElectriCADTelemetry\.h/.test(src)) {
      const incs = [...src.matchAll(/^[ \t]*#include[^\n]*\n/gm)];
      const at = incs.length ? incs[incs.length - 1].index + incs[incs.length - 1][0].length : 0;
      src = src.slice(0, at) + '#include <ElectriCADTelemetry.h>\n' + src.slice(at);
    }
    if (!/ELECTRICAD_BEGIN\s*\(/.test(src)) {
      const setupRe = /(void\s+setup\s*\(\s*\)\s*\{[^\n]*\n)/;
      const serialRe = /^([ \t]*)Serial\.begin\s*\([^)]*\)\s*;[^\n]*\n/m;
      if (serialRe.test(src)) src = src.replace(serialRe, (line, ind) => line + ind + 'ELECTRICAD_BEGIN();\n');
      else src = src.replace(setupRe, '$1  Serial.begin(115200);\n  ELECTRICAD_BEGIN();\n');
    }
    if (!/ELECTRICAD_TICK\s*\(/.test(src)) {
      src = src.replace(/(void\s+loop\s*\(\s*\)\s*\{[^\n]*\n)/, '$1  ELECTRICAD_TICK();\n');
    }
    if (!/ELECTRICAD_BEGIN\s*\(/.test(src) || !/ELECTRICAD_TICK\s*\(/.test(src)) {
      return toast('Couldn\'t find setup()/loop() — add ELECTRICAD_BEGIN() and ELECTRICAD_TICK() by hand', 5000);
    }
    // an Adafruit_NeoPixel object: send its colours so the onboard RGB lights
    if (!/ELECTRICAD_NEOPIXEL\s*\(/.test(src)) {
      const np = /\bAdafruit_NeoPixel\s+(\w+)\s*[({]/.exec(src);
      if (np) {
        const beginRe = new RegExp('^([ \\t]*)' + np[1] + '\\.begin\\s*\\(\\s*\\)\\s*;[^\\n]*\\n', 'm');
        if (beginRe.test(src)) src = src.replace(beginRe, (line, ind) => line + ind + 'ELECTRICAD_NEOPIXEL(' + np[1] + ');\n');
      }
    }
    edits.push({ range: m.getFullModelRange(), text: src });
    S.editor.pushUndoStop();
    S.editor.executeEdits('telemetry', edits);
    S.editor.pushUndoStop();
    toast('Telemetry added. Verify & upload to see live pins (Ctrl+Z undoes)', 3500);
  }

  function revealProject() {
    if (!S.project) return toast('Open a project first');
    api.file.reveal(S.activeTab ? S.activeTab.path : S.project.dir);
  }

  function showShortcuts() {
    const rows = [
      ['Ctrl+R', 'Verify / compile'], ['Ctrl+U', 'Upload'], ['Ctrl+S', 'Save'], ['Ctrl+Shift+S', 'Save all'],
      ['Ctrl+W', 'Close tab'], ['Ctrl+O', 'Open project'], ['Ctrl+N', 'New sketch'],
      ['Ctrl+Shift+P', 'Command palette'], ['Ctrl+Shift+F', 'Find in project'], ['Ctrl+F / Ctrl+H', 'Find / replace in file'],
      ['Ctrl+Shift+B', 'Select board'], ['Ctrl+Shift+D', 'Devices'], ['Ctrl+Shift+W', 'Wiring designer'],
      ['Ctrl+Shift+I', 'Libraries'], ['F5 / Shift+F5', 'Python: run on board / stop'], ['Ctrl+Shift+G', 'Source control'], ['Ctrl+Alt+S', 'Export compiled binary'], ['Ctrl+Shift+M / Ctrl+Shift+L', 'Serial monitor / plotter'], ['Ctrl+Shift+E', 'New from example'], ['Ctrl+K', 'Show sketch folder'], ['Ctrl+B / Ctrl+J', 'Toggle side bar / bottom panel'],
      ['Ctrl+= / Ctrl+- / Ctrl+0', 'Editor font bigger / smaller / reset'], ['Ctrl+Space', 'Arduino completions'],
      ['Alt+↑ / Alt+↓', 'Move line'], ['Ctrl+/', 'Toggle comment'], ['F12', 'Developer tools'],
      ['Wiring: Delete', 'Delete selected part'], ['Wiring: Ctrl+D', 'Duplicate selected part'],
      ['Wiring: right-click a wire', 'Delete that wire'],
      ['Ctrl+P', 'Go to file'], ['Ctrl+G', 'Go to line'], ['Shift+Alt+F', 'Format document'],
      ['Ctrl+Shift+T', 'Reopen closed tab'], ['Ctrl+Tab / Ctrl+Shift+Tab', 'Next / previous tab'],
      ['Ctrl+Alt+O', 'Board options'], ['Ctrl+Shift+U', 'Upload using programmer'], ['Ctrl+Alt+P', 'Check pins against the board'],
      ['F6', 'Python: run selection on board'], ['Ctrl+Alt+M', 'Serial quick-send commands'],
      ['Ctrl+Alt+C', 'Electronics calculators'], ['Ctrl+Alt+I', 'Board pinout'],
      ['Ctrl+Alt+T', 'Light / dark theme'], ['Ctrl+Alt+Z', 'Zen mode'], ['Alt+Z', 'Word wrap'],
      ['Ctrl+Shift+= / Ctrl+Shift+- / Ctrl+Shift+0', 'Zoom the interface'],
      ['Shift+Alt+↓ / ↑', 'Duplicate line'], ['Ctrl+D', 'Select next match'], ['F2', 'Rename symbol in file']
    ];
    infoDialog('Keyboard shortcuts', '<table class="keys-table">' +
      rows.map(([k, d]) => `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(d)}</td></tr>`).join('') + '</table>');
  }
  function showTelemetryHelp() {
    infoDialog('Live telemetry', `<p>Add three lines to any sketch and the board view, pin timeline and AI copilot see the real pins:</p>
<pre>#include &lt;ElectriCADTelemetry.h&gt;
void setup() { Serial.begin(115200); ELECTRICAD_BEGIN(); }
void loop()  { ELECTRICAD_TICK(); /* your code */ }</pre>
<p><b>ELECTRICAD_DELAY(ms)</b> is a drop-in <code>delay()</code> that keeps telemetry flowing while it waits.</p>
<p><b>ELECTRICAD_I2C_SCAN(Wire)</b> lists every I2C device in the I2C Bus panel, with names.</p>
<p>Telemetry lines start with <code>~PN</code> and never show in the serial monitor, so your own <code>Serial.print</code> output stays clean. The plotter reads <code>label:value</code> pairs or comma-separated numbers.</p>
<p><b>ELECTRICAD_NEOPIXEL(strip)</b> after <code>strip.begin()</code> sends the NeoPixel colours, so the board's RGB LED lights in its real colour. On the UNO R4 WiFi the LED matrix is sent by itself when <code>Arduino_LED_Matrix.h</code> is included before the telemetry header.</p>
<p class="dim">Supported: AVR (Uno, Nano, Mega, Leonardo), megaAVR (Nano Every), UNO R4, ESP32, ESP8266, RP2040, SAMD (Feather M0/M4). Command palette → "Add live telemetry to this sketch" does it for you, NeoPixel line included.</p>`);
  }
  async function showAbout() {
    const i = await api.app.info().catch(() => ({}));
    const cliV = await api.toolchain.version().catch(() => '');
    i.platform = (i.platform || '') + (cliV ? ' · arduino-cli ' + cliV : '');
    infoDialog('About ElectriCAD', `<p><b>ElectriCAD ${esc(i.version || '')}</b> — an Arduino and Raspberry Pi IDE with live hardware view, circuit simulation and an AI copilot.</p>
<p class="dim">Electron ${esc(i.electron || '')} · Chrome ${esc(i.chrome || '')} · Node ${esc(i.node || '')} · ${esc(i.platform || '')}</p>
<p class="dim">Settings and toolchain: ${esc(i.userData || '')}</p>`);
  }

  // ---- v0.8: board options, programmers, library examples, formatting, ----
  // ---- pin checks, calculators, pinout, theme, zen, sessions -------------
  const FMT = window.ElectriCADFormat;
  const PC = window.ElectriCADPinCheck;
  const CALC = window.ElectriCADCalc;
  const fqbnBase = (f) => String(f || '').split(':').slice(0, 3).join(':');
  function fqbnOpts(f) {
    const o = {};
    const extra = String(f || '').split(':')[3];
    if (extra) for (const kv of extra.split(',')) { const [k, v] = kv.split('='); if (k && v != null) o[k] = v; }
    return o;
  }

  // Tools → Board Options: the core's own menus (Processor, CPU speed,
  // partition scheme, USB CDC on boot…), stored in the FQBN like the IDE does
  async function boardOptions() {
    if (isPyBoard()) return toast('MicroPython/CircuitPython boards have no build options');
    if (!S.fqbn) { toast('Pick a board first'); return chooseBoard(); }
    toast('Reading board options…', 1200);
    let d;
    try { d = await api.toolchain.boardDetails(fqbnBase(S.fqbn)); }
    catch (e) { return toast('Board options: ' + e.message, 5000); }
    if (!d.options.length) return toast((d.name || fqbnBase(S.fqbn)) + ' has no extra options');
    const cur = fqbnOpts(S.fqbn);
    const def = (o) => (o.values.find((v) => v.selected) || o.values[0] || {}).value;
    const r = await dialog({
      title: 'Board options — ' + (d.name || fqbnBase(S.fqbn)), okLabel: 'Apply',
      fields: d.options.map((o) => ({ key: o.option, label: o.label, value: cur[o.option] || def(o),
        options: o.values.map((v) => ({ value: v.value, label: v.label })) }))
    });
    if (!r) return;
    const pairs = d.options.filter((o) => r[o.option] && r[o.option] !== def(o)).map((o) => o.option + '=' + r[o.option]);
    setFqbn(fqbnBase(S.fqbn) + (pairs.length ? ':' + pairs.join(',') : ''), d.name);
    toast(pairs.length ? 'Board options: ' + pairs.length + ' changed from default' : 'Board options: all defaults', 2200);
  }

  async function pickProgrammer() {
    if (!S.fqbn) { toast('Pick a board first'); chooseBoard(); return null; }
    let d;
    try { d = await api.toolchain.boardDetails(fqbnBase(S.fqbn)); }
    catch (e) { toast('Programmers: ' + e.message, 5000); return null; }
    if (!d.programmers.length) { toast('The ' + (d.name || 'selected') + ' core defines no programmers'); return null; }
    const last = S.settings.lastProgrammer;
    const list = d.programmers.slice().sort((a, b) => (b.id === last) - (a.id === last));
    return new Promise((res) => palette(list.map((p) => ({
      label: `${p.id === last ? '✓' : '○'} ${p.name}  ·  ${p.id}`,
      run: () => { api.settings.set({ lastProgrammer: p.id }).then((st) => { S.settings = st; }); res(p.id); }
    })), 'Programmer…'));
  }

  async function uploadProgrammer() {
    if (!S.project) return toast('Open or create a project first');
    if (isPyBoard()) return upyUpload();
    const programmer = await pickProgrammer();
    if (!programmer) return;
    if (!(await verify({ keepBusy: true, quiet: true }))) return;
    S.uploading = true;
    setBuilding('uploading…');
    if (S.port) await api.serial.close(S.port).catch(() => {});
    logTo('outputLog', `— upload with programmer ${programmer} —`, 'meta');
    let r;
    try { r = await api.toolchain.uploadProgrammer({ sketchDir: S.project.dir, fqbn: S.fqbn, port: S.port, programmer }); }
    catch (e) { r = { ok: false, raw: e.message }; }
    S.uploading = false;
    setBuilding(null);
    if (r.raw) logTo('outputLog', r.raw);
    toast(r.ok ? '▶ Uploaded with ' + programmer : '✗ Upload failed — see Output', r.ok ? 2600 : 4500);
    if (!r.ok) showPanel('output');
    if (S.port) reopenPort(S.port, 6);
  }

  async function burnBootloader() {
    if (!S.fqbn) { toast('Pick a board first'); return chooseBoard(); }
    const programmer = await pickProgrammer();
    if (!programmer) return;
    const ok = await confirmDialog('Burn bootloader',
      `This erases the chip on the target board and rewrites its bootloader and fuses for ${fqbnBase(S.fqbn)} using ${programmer}. Any sketch on it is lost.`,
      [{ label: 'Cancel', value: null }, { label: 'Burn bootloader', value: 'go', danger: true }]);
    if (ok !== 'go') return;
    setBuilding('burning bootloader…');
    logTo('outputLog', `— burn bootloader [${S.fqbn}] with ${programmer} —`, 'meta');
    let r;
    try { r = await api.toolchain.burnBootloader({ fqbn: S.fqbn, port: S.port, programmer }); }
    catch (e) { r = { ok: false, raw: e.message }; }
    setBuilding(null);
    if (r.raw) logTo('outputLog', r.raw);
    toast(r.ok ? '✓ Bootloader burned' : '✗ Burn bootloader failed — see Output', r.ok ? 3000 : 5000);
    if (!r.ok) showPanel('output');
  }

  // File → Library Examples: every example inside the installed libraries
  async function libExamplesMenu() {
    toast('Reading library examples…', 1200);
    const libs = await api.toolchain.libExamples(S.fqbn || '').catch((e) => (toast('Library examples: ' + e.message, 4000), null));
    if (!libs) return;
    const items = [];
    for (const l of libs) for (const ex of l.examples) items.push({ label: `${l.library} › ${ex.name}`, run: () => openLibExample(ex) });
    if (!items.length) return toast('No library examples yet — install a library first (Ctrl+Shift+I)', 3500);
    palette(items, `Library example… (${items.length})`);
  }
  async function openLibExample(ex) {
    try {
      const p = await api.project.create({ fromDir: ex.dir, name: ex.name, fqbn: S.fqbn || '' });
      await loadProject(p);
      toast('Copied the ' + ex.name + ' example into a new project', 2600);
    } catch (e) { toast(e.message, 4500); }
  }

  // Edit → Go to File (Ctrl+P)
  function quickOpen() {
    if (!S.project) return toast('Open a project first');
    const files = [];
    const walk = (nodes, rel) => {
      for (const n of nodes || []) {
        if (n.dir) walk(n.children, rel + n.name + '/');
        else files.push({ n, rel: rel + n.name });
      }
    };
    walk(S.project.tree, '');
    if (!files.length) return toast('This project has no files yet');
    palette(files.map((f) => ({ label: f.rel, run: () => openFile(f.n.path, f.n.name) })), 'Go to file…');
  }

  // Shift+Alt+F — also wired as Monaco's own Format Document provider
  function formatText(text, lang) {
    return FMT.format(text, lang, { tabSize: editorOptions().tabSize });
  }
  function registerFormatters() {
    for (const lang of ['cpp', 'python']) {
      monaco.languages.registerDocumentFormattingEditProvider(lang, {
        provideDocumentFormattingEdits(model) {
          const before = model.getValue();
          const after = formatText(before, lang);
          return after === before ? [] : [{ range: model.getFullModelRange(), text: after }];
        }
      });
    }
    // MicroPython / CircuitPython snippets in .py files
    const A = window.ElectriCADArduinoApi;
    if (!A || !A.PY_SNIPPETS) return;
    monaco.languages.registerCompletionItemProvider('python', {
      provideCompletionItems(model, position) {
        const word = model.getWordUntilPosition(position);
        const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber,
                        startColumn: word.startColumn, endColumn: word.endColumn };
        const t = projType();
        const want = t === 'circuitpython' ? /^cpy:/ : t === 'micropython' ? /^upy:/ : /./;
        return { suggestions: A.PY_SNIPPETS.filter(([label]) => want.test(label)).map(([label, body, doc]) => ({
          label, range, kind: monaco.languages.CompletionItemKind.Snippet, documentation: doc, detail: 'snippet',
          insertText: body, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet })) };
      }
    });
  }
  async function formatActive() {
    const tab = S.activeTab;
    if (!tab) return toast('Open a file first');
    const lang = tab.model.getLanguageId();
    if (lang !== 'cpp' && lang !== 'python') return toast('Formatting works on Arduino/C/C++ and Python files');
    if (formatText(tab.model.getValue(), lang) === tab.model.getValue()) return toast('Already formatted', 900);
    await S.editor.getAction('editor.action.formatDocument').run();
    toast('Formatted — Ctrl+Z undoes it', 1400);
  }
  // format-on-save (Settings → Editor): edits the model so undo still works
  function formatBeforeSave(t) {
    const ed = (S.settings && S.settings.editor) || {};
    if (!ed.formatOnSave) return;
    const lang = t.model.getLanguageId();
    if (lang !== 'cpp') return;
    const before = t.model.getValue();
    const after = formatText(before, lang);
    if (after !== before) t.model.pushEditOperations([], [{ range: t.model.getFullModelRange(), text: after }], () => null);
  }

  // pin checks: live squiggles while typing + a full report on demand
  const PIN_SRC = /\.(ino|pde|c|cc|cpp|cxx|h|hh|hpp)$/i;
  function runPinCheck(tab) {
    if (!tab || !window.monaco || !PC || tab.model.isDisposed()) return [];
    const on = PIN_SRC.test(tab.path) && !isPyBoard() && S.settings && S.settings.pinCheck !== false;
    const found = on ? PC.check(tab.model.getValue(), S.fqbn) : [];
    monaco.editor.setModelMarkers(tab.model, 'pincheck', found.map((d) => {
      const w = tab.model.getWordAtPosition({ lineNumber: d.line, column: d.col });
      return { startLineNumber: d.line, endLineNumber: d.line, startColumn: d.col, endColumn: w ? w.endColumn : d.col + 1,
               message: d.message, source: 'pin check',
               severity: d.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning };
    }));
    return found;
  }
  function schedulePinCheck(tab) {
    clearTimeout(tab._pcT);
    tab._pcT = setTimeout(() => runPinCheck(tab), 500);
  }
  function recheckPins() { for (const t of S.openTabs) runPinCheck(t); }
  async function pinCheckReport(quiet) {
    if (!S.project) { if (!quiet) toast('Open a project first'); return []; }
    if (!PC.boardFor(S.fqbn)) {
      if (!quiet) toast('Pin checks cover Uno, Nano, Mega, Leonardo, Nano Every, classic ESP32 and Pico. Other boards are not guessed.', 5000);
      return [];
    }
    // every source file in the project, open or not
    const files = [];
    const walk = (nodes) => { for (const n of nodes || []) { if (n.dir) walk(n.children); else if (PIN_SRC.test(n.name)) files.push(n); } };
    walk(S.project.tree);
    const all = [];
    for (const f of files.slice(0, 60)) {
      const tab = S.openTabs.find((t) => t.path === f.path);
      let text = tab ? tab.model.getValue() : null;
      if (text == null) { try { text = await api.file.read(f.path); } catch (e) { continue; } }
      for (const d of PC.check(text, S.fqbn)) all.push({ ...d, file: f });
      if (tab) runPinCheck(tab);
    }
    if (quiet) return all;
    if (!all.length) { toast('✓ No pin problems for ' + PC.boardFor(S.fqbn).name, 2200); return all; }
    palette(all.map((d) => ({
      label: `${d.severity === 'error' ? '✗' : '△'} ${d.file.name}:${d.line}  ${d.message}`,
      run: async () => {
        const tab = await openFile(d.file.path, d.file.name);
        if (tab) { S.editor.revealLineInCenter(d.line); S.editor.setPosition({ lineNumber: d.line, column: d.col }); S.editor.focus(); }
      }
    })), `${all.length} pin issue${all.length === 1 ? '' : 's'} on the ${PC.boardFor(S.fqbn).name}`);
    return all;
  }

  // Tools → Electronics Calculators
  const BAND_CSS = { black: '#111', brown: '#7a4a1f', red: '#d62828', orange: '#f77f00', yellow: '#fcd116', green: '#2a9d3f',
                     blue: '#1f6feb', violet: '#8e44ad', grey: '#8a8a8a', white: '#f4f4f4', gold: '#c9a43a', silver: '#c0c0c0' };
  const swatches = (bands) => '<span class="calc-bands">' + bands.map((b) =>
    `<span class="calc-band" style="background:${BAND_CSS[b]}" title="${b}"></span>`).join('') + '</span> ' + bands.join(' · ');
  const CALCS = [
    { id: 'led', name: 'LED resistor', fields: [['vs', 'Supply voltage (V)', '5'], ['vf', 'LED forward voltage (V) — red 2.0, green 2.1, blue/white 3.0', '2.0'],
        ['ma', 'LED current (mA)', '15'], ['series', 'Resistor series', 'E24', ['E12', 'E24', 'E96']]],
      run: (v) => { const r = CALC.ledResistor(+v.vs, +v.vf, +v.ma, v.series); return r.error || `Use <b>${CALC.eng(r.r, 'Ω')}</b> (exact ${CALC.eng(r.exact, 'Ω')}) → ${r.actualmA.toFixed(1)} mA, ${(r.powerW * 1000).toFixed(0)} mW in the resistor — a ${r.ratingW} W part is plenty.<br>${swatches(CALC.colorCode(r.r).bands)}`; } },
    { id: 'div', name: 'Voltage divider: Vout', fields: [['vin', 'Vin (V)', '5'], ['r1', 'R1, top (Ω) — 10k, 4k7…', '10k'], ['r2', 'R2, bottom (Ω)', '20k']],
      run: (v) => { const r = CALC.divider(+v.vin, CALC.parseEng(v.r1), CALC.parseEng(v.r2)); return r.error || `Vout = <b>${r.vout.toFixed(3)} V</b> · divider current ${r.currentmA.toFixed(3)} mA`; } },
    { id: 'divsolve', name: 'Voltage divider: pick resistors', fields: [['vin', 'Vin (V)', '5'], ['vout', 'Wanted Vout (V)', '3.3'],
        ['total', 'Roughly how much total resistance (Ω)', '10k'], ['series', 'Resistor series', 'E24', ['E12', 'E24', 'E96']]],
      run: (v) => { const r = CALC.solveDivider(+v.vin, +v.vout, v.series, CALC.parseEng(v.total) || 10000); return r.error || `R1 (top) <b>${CALC.eng(r.r1, 'Ω')}</b>, R2 (bottom) <b>${CALC.eng(r.r2, 'Ω')}</b> → ${r.vout.toFixed(3)} V (${r.errorPct.toFixed(2)}% off)`; } },
    { id: 'color', name: 'Resistor colour code', fields: [['ohms', 'Resistance (Ω) — 220, 4k7, 1M…', '4k7'], ['bands', 'Bands', '4', ['4', '5']]],
      run: (v) => { const r = CALC.colorCode(CALC.parseEng(v.ohms), Number(v.bands)); return r.error || `${swatches(r.bands)}<br>${CALC.eng(r.value, 'Ω')} ±${r.tolerancePct}%`; } },
    { id: 'bands', name: 'Colour bands → value', fields: [['b1', 'Band 1', 'brown', CALC.COLORS], ['b2', 'Band 2', 'black', CALC.COLORS],
        ['b3', 'Band 3 (5-band only)', '—', ['—', ...CALC.COLORS]], ['mult', 'Multiplier', 'red', ['silver', 'gold', ...CALC.COLORS.slice(0, 10)]],
        ['tol', 'Tolerance', 'gold', ['gold', 'silver', 'brown', 'red', 'green', 'blue', 'violet', 'grey']]],
      run: (v) => { const list = [v.b1, v.b2, ...(v.b3 !== '—' ? [v.b3] : []), v.mult, v.tol]; const r = CALC.fromColors(list); return r.error || `<b>${CALC.eng(r.ohms, 'Ω')}</b> ±${r.tolerancePct}%<br>${swatches(list)}`; } },
    { id: 'rc', name: 'RC time constant / filter', fields: [['r', 'R (Ω)', '10k'], ['c', 'C (F) — 100n, 1u, 10u…', '1u']],
      run: (v) => { const r = CALC.rc(CALC.parseEng(v.r), CALC.parseEng(v.c)); return r.error || `τ = <b>${CALC.eng(r.tau, 's')}</b> · 99% settled after ${CALC.eng(r.settle99, 's')} · low-pass cutoff <b>${CALC.eng(r.fc, 'Hz')}</b>`; } },
    { id: 'ohm', name: "Ohm's law & power", fields: [['v', 'Voltage (V)', '5'], ['i', 'Current (A) — 20m = 20 mA', ''], ['r', 'Resistance (Ω)', '220'], ['p', 'Power (W)', '']],
      run: (v) => { const n = (x) => (String(x).trim() === '' ? null : CALC.parseEng(x)); const r = CALC.ohm({ v: n(v.v), i: n(v.i), r: n(v.r), p: n(v.p) }); return r.error || `<b>${CALC.eng(r.v, 'V')}</b> · <b>${CALC.eng(r.i, 'A')}</b> · <b>${CALC.eng(r.r, 'Ω')}</b> · <b>${CALC.eng(r.p, 'W')}</b><br><span class="dim2">Fill in any two; leave the others blank.</span>`; } },
    { id: 'batt', name: 'Battery life', fields: [['mah', 'Capacity (mAh)', '2000'], ['active', 'Current while awake (mA)', '50'], ['sleep', 'Current while asleep (mA)', '0.1'], ['duty', 'Time awake (%)', '100']],
      run: (v) => { const r = CALC.batteryLife({ mAh: +v.mah, activemA: +v.active, sleepmA: +v.sleep, dutyPct: +v.duty }); return r.error || `About <b>${r.hours < 48 ? r.hours.toFixed(1) + ' hours' : r.days.toFixed(1) + ' days'}</b> at an average ${r.avgmA.toFixed(3)} mA<br><span class="dim2">Uses 85% of the rated capacity (cutoff voltage, self-discharge, temperature).</span>`; } },
    { id: 'adc', name: 'ADC counts ↔ volts', fields: [['bits', 'ADC resolution', '10', ['8', '10', '12', '14', '16']], ['vref', 'Reference (V) — 5 on Uno, 3.3 on ESP32/Pico', '5'],
        ['counts', 'Reading (counts)', '512'], ['volts', '…or voltage (V)', '']],
      run: (v) => { const r = String(v.counts).trim() !== '' ? CALC.adc({ bits: +v.bits, vref: +v.vref, counts: +v.counts }) : CALC.adc({ bits: +v.bits, vref: +v.vref, volts: +v.volts }); return r.error || `${r.counts} counts = <b>${r.volts.toFixed(4)} V</b> · 1 count = ${CALC.eng(r.lsb, 'V')}`; } }
  ];
  function showCalculators(startId) {
    const box = infoDialog('Electronics calculators', `<div class="calc-wrap"><div class="calc-list"></div><div class="calc-body"></div></div>`);
    box.classList.add('calc-modal');
    const list = box.querySelector('.calc-list');
    const body = box.querySelector('.calc-body');
    const open = (c) => {
      list.querySelectorAll('.calc-item').forEach((x) => x.classList.toggle('on', x.dataset.id === c.id));
      body.innerHTML = `<h4>${esc(c.name)}</h4>`;
      const vals = {};
      const out = document.createElement('div');
      out.className = 'calc-out';
      const recompute = () => {
        let html;
        try { html = c.run(vals); } catch (e) { html = 'Check the numbers'; }
        out.innerHTML = html;
      };
      for (const [key, label, value, opts] of c.fields) {
        const row = document.createElement('label');
        row.className = 'calc-row';
        row.innerHTML = `<span>${esc(label)}</span>`;
        let input;
        if (opts) {
          input = document.createElement('select');
          for (const o of opts) { const op = document.createElement('option'); op.value = op.textContent = o; input.appendChild(op); }
        } else { input = document.createElement('input'); input.type = 'text'; }
        input.className = 'input';
        input.value = value;
        vals[key] = value;
        input.addEventListener('input', () => { vals[key] = input.value; recompute(); });
        row.appendChild(input);
        body.appendChild(row);
      }
      body.appendChild(out);
      recompute();
      try { localStorage.setItem('ec_calc', c.id); } catch (e) {}
    };
    for (const c of CALCS) {
      const it = document.createElement('div');
      it.className = 'calc-item';
      it.dataset.id = c.id;
      it.textContent = c.name;
      it.addEventListener('click', () => open(c));
      list.appendChild(it);
    }
    let last = startId;
    try { last = last || localStorage.getItem('ec_calc'); } catch (e) {}
    open(CALCS.find((c) => c.id === last) || CALCS[0]);
  }

  // Tools → Board Pinout: the verified pin map behind the live board view
  function showPinout() {
    const def = PINODE_BOARDS[S.boardDefId];
    if (!def) return toast('No board view selected');
    const rows = def.pins.slice().sort((a, b) => (a.tele == null) - (b.tele == null) || (a.tele ?? 0) - (b.tele ?? 0) ||
      String(a.label).localeCompare(String(b.label), undefined, { numeric: true }));
    const seen = new Set();
    const html = rows.filter((p) => { const k = p.label + '|' + p.tele; if (seen.has(k)) return false; seen.add(k); return true; }).map((p) => {
      const fn = [p.pwm ? 'PWM' : '', p.analogIndex != null ? 'analog ' + p.analogIndex : '', p.power ? 'power' : '', p.note || ''].filter(Boolean).join(' · ');
      return `<tr><td><b>${esc(p.label)}</b></td><td>${p.tele != null ? p.tele : '—'}</td><td>${esc(fn)}</td></tr>`;
    }).join('');
    const box = infoDialog('Pinout — ' + def.name, `<input class="input pinout-filter" placeholder="Filter pins (e.g. PWM, A0, SDA)…">
      <table class="pinout-table"><thead><tr><th>Pin</th><th>Number in code</th><th>Functions</th></tr></thead><tbody>${html}</tbody></table>
      <p class="dim2">From the same pin map that drives the live board view. Change it with the board view selector.</p>`);
    const f = box.querySelector('.pinout-filter');
    f.addEventListener('input', () => {
      const q = f.value.toLowerCase();
      box.querySelectorAll('.pinout-table tbody tr').forEach((tr) => { tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none'; });
    });
    f.focus();
  }

  // View → light / dark theme
  function applyTheme(t) {
    document.body.classList.toggle('light', t === 'light');
    if (window.monaco) monaco.editor.setTheme(t === 'light' ? 'electricad-light' : 'electricad');
    if (S.board && S.board.redraw) S.board.redraw();
  }
  async function toggleTheme() {
    const t = S.settings.theme === 'light' ? 'dark' : 'light';
    S.settings = await api.settings.set({ theme: t });
    applyTheme(t);
  }

  // View → Zen mode: editor only, and back exactly as it was
  let zenPrev = null;
  function zen() {
    if (zenPrev) {
      for (const [p, wasCollapsed] of Object.entries(zenPrev)) togglePane(p, !wasCollapsed);
      zenPrev = null;
      toast('Zen mode off', 900);
      return;
    }
    zenPrev = {};
    for (const p of ['side', 'bottom', 'right']) { zenPrev[p] = $(p).classList.contains('collapsed'); togglePane(p, false); }
    toast('Zen mode — Ctrl+Alt+Z to come back', 1800);
  }

  // Tools → Send File to Serial: line by line, paced so small boards keep up
  async function serialSendFile() {
    if (!S.port) { toast('Pick a device first'); return deviceMenu(); }
    const p = await api.project.pickFile({ filters: [{ name: 'Text', extensions: ['txt', 'csv', 'gcode', 'nc', 'json', 'py', 'cfg', '*'] }] });
    if (!p) return;
    let text;
    try { text = await api.file.read(p); } catch (e) { return toast('Could not read ' + baseName(p) + ': ' + e.message, 4000); }
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const ending = $('serialEnding').value === 'none' ? 'lf' : $('serialEnding').value;
    pushSerial(`— sending ${baseName(p)} (${lines.length} lines) —`, 'meta');
    for (let i = 0; i < lines.length; i++) {
      try { await api.serial.writeLine(S.port, lines[i], ending); }
      catch (e) { pushSerial('✗ stopped at line ' + (i + 1) + ': ' + e.message, 'meta'); return; }
      if (i % 16 === 15) await new Promise((r) => setTimeout(r, 15));
    }
    pushSerial(`— sent ${lines.length} lines —`, 'meta');
  }

  // reopen each project's tabs where you left them
  let sessT = null;
  function saveSession() {
    if (!S.project || S.restoring) return;
    clearTimeout(sessT);
    const dir = S.project.dir;
    sessT = setTimeout(() => {
      const sess = { files: S.openTabs.map((t) => t.path).slice(0, 24), active: S.activeTab ? S.activeTab.path : '' };
      api.settings.set({ sessions: { [dir]: sess } }).then((st) => { S.settings = st; }).catch(() => {});
    }, 400);
  }
  async function restoreSession(proj) {
    const sess = ((S.settings && S.settings.sessions) || {})[proj.dir];
    if (!sess || !Array.isArray(sess.files)) return;
    const exists = new Set();
    const walk = (nodes) => { for (const n of nodes || []) { if (n.dir) walk(n.children); else exists.add(n.path); } };
    walk(proj.tree);
    for (const f of sess.files) if (exists.has(f) && !S.openTabs.some((t) => t.path === f)) await openFile(f, baseName(f), { quiet: true });
    const act = S.openTabs.find((t) => t.path === sess.active);
    if (act) activateTab(act);
  }

  // ---- v0.8 (continued) ----------------------------------------------------
  CALCS.push(
    { id: '555', name: '555 timer (astable)', fields: [['r1', 'R1 (Ω)', '1k'], ['r2', 'R2 (Ω)', '10k'], ['c', 'C (F)', '10u']],
      run: (v) => { const r = CALC.timer555(CALC.parseEng(v.r1), CALC.parseEng(v.r2), CALC.parseEng(v.c)); return r.error || `<b>${CALC.eng(r.freq, 'Hz')}</b> · high ${CALC.eng(r.high, 's')}, low ${CALC.eng(r.low, 's')} · duty ${r.dutyPct.toFixed(1)}%<br><span class="dim2">Duty is always above 50% in this circuit; add a diode across R2 to go lower.</span>`; } },
    { id: 'capcode', name: 'Capacitor code', fields: [['code', 'Code printed on the cap (104, 472, 4R7…)', '104'], ['val', '…or a value to encode (F) — 100n, 4n7', '']],
      run: (v) => {
        if (String(v.val).trim()) { const f = CALC.parseEng(v.val); const code = f ? CALC.capToCode(f) : null; return code ? `${CALC.eng(f, 'F')} is printed as <b>${code}</b>` : 'Values from 10 pF up have a 3-digit code'; }
        const r = CALC.capCode(v.code); return r.error || `<b>${CALC.eng(r.farads, 'F')}</b> (${r.pf} pF)`; } },
    { id: 'baud', name: 'AVR serial baud error', fields: [['f', 'CPU clock (Hz) — 16M, 8M, 20M', '16M'], ['baud', 'Baud rate', '115200']],
      run: (v) => { const r = CALC.avrBaud(CALC.parseEng(v.f), CALC.parseEng(v.baud)); if (r.error) return r.error;
        const line = (x, name) => `${name}: UBRR ${x.ubrr} → ${Math.round(x.actual)} baud, <b>${x.errorPct >= 0 ? '+' : ''}${x.errorPct.toFixed(2)}%</b>${Math.abs(x.errorPct) > 2 ? ' ✗ unreliable' : ' ✓'}`;
        return line(r.normal, 'Normal speed') + '<br>' + line(r.u2x, 'Double speed (U2X, what Arduino uses when it is closer)') + '<br><span class="dim2">Keep the error under ±2%.</span>'; } },
    { id: 'heat', name: 'Linear regulator heat', fields: [['vin', 'Vin (V)', '12'], ['vout', 'Vout (V)', '5'], ['ma', 'Load current (mA)', '300'], ['theta', 'Package θJA (°C/W) — TO-220 50, SOT-223 ~90', '50']],
      run: (v) => { const r = CALC.regulatorHeat(+v.vin, +v.vout, +v.ma, +v.theta); return r.error || `<b>${r.watts.toFixed(2)} W</b> of heat · ${r.efficiencyPct.toFixed(0)}% efficient · about <b>+${r.riseC.toFixed(0)}°C</b> above the air with no heatsink${r.riseC > 100 ? ' ✗ it will shut down — use a heatsink or a buck converter' : ''}`; } },
    { id: 'pack', name: 'Battery pack (series × parallel)', fields: [['v', 'Cell voltage (V) — Li-ion 3.7, NiMH 1.2, alkaline 1.5', '3.7'], ['mah', 'Cell capacity (mAh)', '2500'], ['s', 'Cells in series', '3'], ['p', 'Strings in parallel', '1']],
      run: (v) => { const r = CALC.batteryPack(+v.v, +v.mah, +v.s, +v.p); return r.error || `<b>${r.volts.toFixed(1)} V</b> · <b>${r.mAh} mAh</b> · ${r.wh.toFixed(1)} Wh from ${r.cells} cells${+v.s > 1 && /^3\.[67]/.test(v.v) ? '<br><span class="dim2">Series lithium cells need a balancing BMS.</span>' : ''}`; } }
  );

  // board info from the installed core
  async function boardInfo() {
    if (!S.fqbn) { toast('Pick a board first'); return chooseBoard(); }
    let d;
    try { d = await api.toolchain.boardDetails(fqbnBase(S.fqbn)); } catch (e) { return toast('Board info: ' + e.message, 5000); }
    const opts = fqbnOpts(S.fqbn);
    infoDialog('Board info', `<p><b>${esc(d.name)}</b></p>
      <table class="keys-table">
        <tr><td>FQBN</td><td><code>${esc(S.fqbn)}</code></td></tr>
        <tr><td>Core version</td><td>${esc(d.version || '—')}</td></tr>
        <tr><td>Maintainer</td><td>${esc(d.platform || '—')}</td></tr>
        <tr><td>Options set</td><td>${Object.keys(opts).length ? Object.entries(opts).map(([k, v]) => esc(k + '=' + v)).join(', ') : 'defaults'}</td></tr>
        <tr><td>Menu options</td><td>${d.options.map((o) => esc(o.label)).join(', ') || 'none'}</td></tr>
        <tr><td>Programmers</td><td>${d.programmers.map((p) => esc(p.name)).join(', ') || 'none'}</td></tr>
        <tr><td>Pin check</td><td>${PC.boardFor(S.fqbn) ? 'yes — ' + esc(PC.boardFor(S.fqbn).name) : 'not covered (no guessing)'}</td></tr>
      </table>`);
  }

  // Sketch → Include Library
  async function includeLib() {
    const tab = S.activeTab;
    if (!tab || tab.model.getLanguageId() !== 'cpp') return toast('Open a sketch or C++ file first');
    const libs = await api.toolchain.libInstalled().catch(() => []);
    if (!libs.length) return toast('No libraries installed yet (Ctrl+Shift+I)');
    palette(libs.map((l) => ({ label: `${l.name}  ·  ${l.version || ''}${l.sentence ? '  ·  ' + l.sentence.slice(0, 70) : ''}`, run: () => {
      const heads = l.includes && l.includes.length ? l.includes : [l.name.replace(/\s+/g, '_') + '.h'];
      const text = tab.model.getValue();
      const missing = heads.filter((h) => !new RegExp('#\\s*include\\s*[<"]' + h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[>"]').test(text));
      if (!missing.length) return toast(l.name + ' is already included');
      // after the last existing #include, else at the top
      const lines = text.split('\n');
      let at = 0;
      lines.forEach((ln, i) => { if (/^\s*#\s*include\b/.test(ln)) at = i + 1; });
      S.editor.pushUndoStop();
      S.editor.executeEdits('include', [{ range: new monaco.Range(at + 1, 1, at + 1, 1), text: missing.map((h) => `#include <${h}>\n`).join('') }]);
      S.editor.pushUndoStop();
      toast('Added ' + missing.map((h) => '<' + h + '>').join(' '), 1800);
    } })), 'Include library…');
  }

  // Edit menu → editor actions (menu accelerators reach us before Monaco)
  function editorAction(id) {
    if (!S.activeTab) return toast('Open a file first');
    S.editor.focus();
    const a = S.editor.getAction(id);
    if (a) a.run();
  }

  // tabs
  const closedTabs = [];
  async function reopenTab() {
    while (closedTabs.length) {
      const p = closedTabs.pop();
      if (S.openTabs.some((t) => t.path === p)) continue;
      if (await api.file.exists(p).catch(() => false)) { await openFile(p, baseName(p)); return; }
    }
    toast('No closed tabs to reopen', 900);
  }
  function cycleTab(dir) {
    if (S.openTabs.length < 2) return;
    const i = S.openTabs.indexOf(S.activeTab);
    activateTab(S.openTabs[(i + dir + S.openTabs.length) % S.openTabs.length]);
  }
  async function closeOthers(keep) {
    keep = keep || S.activeTab;
    for (const t of S.openTabs.slice()) if (t !== keep) await closeTab(t);
  }
  async function closeAll() { for (const t of S.openTabs.slice()) await closeTab(t); }

  // View toggles persisted as editor settings
  async function toggleEditorSetting(key, label) {
    const ed = (S.settings && S.settings.editor) || {};
    const on = key === 'minimap' ? ed.minimap === false : !ed[key];
    S.settings = await api.settings.set({ editor: { [key]: on } });
    applyEditorSettings();
    toast(label + (on ? ' on' : ' off'), 900);
  }

  // TODO / FIXME list
  async function todoList() {
    if (!S.project) return toast('Open a project first');
    const files = [];
    const walk = (nodes) => { for (const n of nodes || []) { if (n.dir) walk(n.children); else if (TEXT_EXT.test(n.name)) files.push(n); } };
    walk(S.project.tree);
    const hits = [];
    for (const f of files.slice(0, 200)) {
      const tab = S.openTabs.find((t) => t.path === f.path);
      let text = tab ? tab.model.getValue() : null;
      if (text == null) { try { text = await api.file.read(f.path); } catch (e) { continue; } }
      text.split(/\r?\n/).forEach((ln, i) => {
        const m = /\b(TODO|FIXME|HACK|XXX|BUG)\b[:\s]*(.*)/.exec(ln);
        if (m && /\/\/|\/\*|#|\*/.test(ln.slice(0, m.index + 1))) hits.push({ f, line: i + 1, tag: m[1], text: m[2].trim() });
      });
    }
    if (!hits.length) return toast('No TODO / FIXME comments in this project', 1800);
    palette(hits.map((h) => ({ label: `${h.tag}  ${h.f.name}:${h.line}  ${h.text}`, run: async () => {
      const tab = await openFile(h.f.path, h.f.name);
      if (tab) { S.editor.revealLineInCenter(h.line); S.editor.setPosition({ lineNumber: h.line, column: 1 }); S.editor.focus(); }
    } })), `${hits.length} TODO / FIXME`);
  }

  // File → New Class: Name.h (include guard) + Name.cpp
  async function newClass() {
    if (!S.project) return toast('Open a project first');
    const r = await dialog({ title: 'New class', okLabel: 'Create', fields: [{ key: 'n', label: 'Class name', placeholder: 'MotorDriver' }] });
    if (!r) return;
    const name = r.n.trim();
    if (!/^[A-Za-z_]\w*$/.test(name)) return toast('Use a C++ name: letters, digits and _ (not starting with a digit)', 3500);
    const h = joinPath(S.project.dir, name + '.h'), c = joinPath(S.project.dir, name + '.cpp');
    if (await api.file.exists(h) || await api.file.exists(c)) return toast(name + '.h or .cpp already exists', 3000);
    const guard = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase() + '_H';
    await api.file.create(h);
    await api.file.write(h, `#ifndef ${guard}\n#define ${guard}\n\n#include <Arduino.h>\n\nclass ${name} {\n  public:\n    ${name}();\n    void begin();\n\n  private:\n};\n\n#endif\n`);
    await api.file.create(c);
    await api.file.write(c, `#include "${name}.h"\n\n${name}::${name}() {\n}\n\nvoid ${name}::begin() {\n}\n`);
    await refreshTree();
    await openFile(c, name + '.cpp');
    await openFile(h, name + '.h');
    toast(`Created ${name}.h and ${name}.cpp — add #include "${name}.h" to the sketch`, 3500);
  }

  // duplicate a file next to itself: "name copy.ext", "name copy 2.ext"…
  async function duplicateFile(n) {
    const dir = dirName(n.path);
    const m = /^(.*?)(\.[^.]*)?$/.exec(n.name);
    let target, i = 1;
    do { target = joinPath(dir, `${m[1]} copy${i > 1 ? ' ' + i : ''}${m[2] || ''}`); i++; } while (await api.file.exists(target));
    const text = await api.file.read(n.path);
    await api.file.create(target);
    await api.file.write(target, text);
    await refreshTree();
    toast('Duplicated as ' + baseName(target), 1500);
  }

  // serial: saved quick-send commands
  function serialMacros() {
    const list = (S.settings.serial && S.settings.serial.macros) || [];
    const saveList = async (l) => { S.settings = await api.settings.set({ serial: { macros: l } }); };
    palette([
      ...list.map((m, i) => ({ label: `▶ ${m.name}  ·  ${m.text}`, run: () => {
        if (!S.port) return toast('Pick a device first');
        api.serial.writeLine(S.port, m.text, $('serialEnding').value).then(() => pushSerial('» ' + m.text, 'meta')).catch((e) => toast(e.message));
      } })),
      { label: '＋ Add a command…', run: async () => {
        const r = await dialog({ title: 'Quick-send command', fields: [{ key: 'name', label: 'Name', placeholder: 'LED on' }, { key: 'text', label: 'Text to send', placeholder: 'led 1' }] });
        if (r && r.text) { await saveList(list.concat([{ name: r.name || r.text, text: r.text }])); toast('Saved — Ctrl+Alt+M to send it', 1800); }
      } },
      ...list.map((m, i) => ({ label: `✕ Remove "${m.name}"`, run: () => saveList(list.filter((_, j) => j !== i)) }))
    ], 'Quick-send…');
  }
  function serialCopy() {
    const text = S.serial.lines.filter(serialMatch).map((l) => (S.serial.timestamps ? fmtTs(l.ts) + '  ' : '') + l.text).join('\n');
    if (!text) return toast('The serial monitor is empty');
    navigator.clipboard.writeText(text).then(() => toast('Copied ' + S.serial.lines.length + ' lines', 1200)).catch(() => toast('Clipboard not available'));
  }

  // Python extras
  async function upyRunSel() {
    if (!isPyBoard()) return toast('Run selection works in MicroPython / CircuitPython projects');
    const code = selectedText() || (S.editor && S.editor.getModel() ? S.editor.getModel().getLineContent(S.editor.getPosition().lineNumber) : '');
    if (!code.trim()) return toast('Select some code first');
    const port = await pyPort();
    if (!port) return;
    // dedent so a selected block from inside a function still runs
    const lines = code.replace(/\r\n/g, '\n').split('\n');
    const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)[0].length));
    const src = lines.map((l) => l.slice(ind)).join('\n');
    showPanel('serial');
    pushSerial('— running selection on ' + port + ' —', 'meta');
    try { await api.upy.run(port, src); } catch (e) { toast('Run: ' + e.message, 4500); }
  }
  async function upySetClock() {
    const port = await pyPort();
    if (!port) return;
    try { const r = await api.upy.setClock(port, Date.now()); toast('Board clock set: ' + r.now, 3000); }
    catch (e) { toast('Clock: ' + e.message, 4500); }
  }
  async function upyDownloadAll() {
    if (!S.project) return toast('Open a project first');
    const port = await pyPort();
    if (!port) return;
    let files;
    try { files = (await api.upy.ls(port)).filter((f) => !f.dir); } catch (e) { return toast('Board files: ' + e.message, 4500); }
    if (!files.length) return toast('No files on the board');
    const dir = joinPath(S.project.dir, 'from-board');
    await api.file.mkdir(dir).catch(() => {});
    let n = 0;
    for (const f of files) {
      try { const b64 = await api.upy.readB64(port, f.name); await api.file.writeBase64(joinPath(dir, f.name), b64); n++; }
      catch (e) { pushSerial(`✗ ${f.name}: ${e.message}`, 'meta'); }
    }
    await refreshTree();
    toast(`Downloaded ${n} of ${files.length} files into from-board/`, 3000);
  }
  async function cpyOpenDrive() {
    const drives = await api.upy.drives().catch(() => []);
    if (!drives.length) return toast('No CIRCUITPY drive found — plug the board in (it shows up as a USB drive)', 3500);
    for (const d of drives) api.file.reveal(joinPath(d.root, 'boot_out.txt'));
  }

  // settings export / import (the AI key never leaves the machine)
  async function exportSettings() {
    const s = JSON.parse(JSON.stringify(S.settings || {}));
    if (s.ai) delete s.ai.apiKey;
    delete s.sessions; delete s.window;
    const p = await api.file.saveDialog({ defaultPath: 'electricad-settings.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (!p) return;
    await api.file.write(p, JSON.stringify(s, null, 2) + '\n');
    toast('Settings exported (without your AI key)', 2200);
  }
  async function importSettings() {
    const p = await api.project.pickFile({ filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (!p) return;
    let s;
    try { s = JSON.parse(await api.file.read(p)); } catch (e) { return toast('Not a settings file: ' + e.message, 4000); }
    if (!s || typeof s !== 'object' || Array.isArray(s)) return toast('Not a settings file');
    for (const k of ['sessions', 'window', 'projectsDir', 'lastProject', 'recentProjects']) delete s[k];
    if (s.ai) delete s.ai.apiKey;
    S.settings = await api.settings.set(s);
    applyEditorSettings();
    applyTheme(S.settings.theme);
    toast('Settings imported', 1800);
  }

  // build feedback: taskbar progress + desktop notification when unfocused
  let buildStart = 0;
  function buildProgress(on) {
    if (on) { buildStart = Date.now(); api.app.progress(2).catch(() => {}); }   // >1 = indeterminate
    else api.app.progress(-1).catch(() => {});
  }
  function notifyDone(title, body) {
    if (S.settings && S.settings.notifications === false) return;
    if (document.hasFocus() || Date.now() - buildStart < 4000) return;
    try { new Notification(title, { body, silent: false }); } catch (e) {}
  }

  // command palette remembers what you run
  function rememberCommand(label) {
    try {
      const r = JSON.parse(localStorage.getItem('ec_recent_cmds') || '[]').filter((x) => x !== label);
      r.unshift(label);
      localStorage.setItem('ec_recent_cmds', JSON.stringify(r.slice(0, 6)));
    } catch (e) {}
  }
  function recentCommands() {
    try { return JSON.parse(localStorage.getItem('ec_recent_cmds') || '[]'); } catch (e) { return []; }
  }

  // status bar: language · selection · line endings
  function renderEditorStatus() {
    const el = $('stEditor');
    if (!el) return;
    const m = S.editor && S.editor.getModel();
    if (!m) { el.textContent = ''; return; }
    const sel = S.editor.getSelection();
    const chars = sel && !sel.isEmpty() ? m.getValueLengthInRange(sel) : 0;
    const lines = sel && !sel.isEmpty() ? sel.endLineNumber - sel.startLineNumber + 1 : 0;
    const lang = { cpp: 'C++ / Arduino', python: 'Python' }[m.getLanguageId()] || m.getLanguageId();
    el.textContent = (chars ? `${chars} selected${lines > 1 ? ' (' + lines + ' lines)' : ''} · ` : '') + lang + ' · ' + (m.getEOL() === '\r\n' ? 'CRLF' : 'LF');
  }

  // anything that slips through shows up in Output instead of vanishing
  window.addEventListener('error', (e) => { try { logTo('outputLog', '⚠ ' + (e.message || 'error') + (e.filename ? ` (${baseName(e.filename)}:${e.lineno})` : ''), 'warn'); } catch (x) {} });
  window.addEventListener('unhandledrejection', (e) => { try { logTo('outputLog', '⚠ ' + ((e.reason && e.reason.message) || String(e.reason)), 'warn'); } catch (x) {} });

  const TIPS = [
    'Ctrl+P jumps to any file in the project.',
    'Shift+Alt+F formats the sketch; turn on format-on-save in Settings.',
    'Wrong pins get squiggles as you type: analogWrite on a non-PWM pin, ESP32 input-only pins, and more.',
    'Tools → Electronics Calculators: LED resistors, dividers, colour codes, 555 timers, battery life…',
    'Ctrl+Alt+O opens the board\'s own options: CPU speed, partition scheme, USB mode.',
    'File → Library Examples opens any example from your installed libraries as a new project.',
    'F6 runs just the selected lines on a MicroPython board.',
    'Ctrl+Alt+M sends saved serial commands with one keypress.',
    'Ctrl+Alt+Z hides everything but the editor. Ctrl+Alt+T switches light and dark.',
    'Right-click a file in the tree to duplicate it or copy its relative path.',
    'The canvas Image button saves a PNG of your circuit.',
    'Ctrl+Shift+T reopens the tab you just closed.'
  ];

  // ==== v0.9 ===================================================================
  const T = window.ElectriCADTools;
  const PCB = window.ElectriCADPcb;

  // ---- look: accent colour, density, icon size ---------------------------------
  function applyLook() {
    const s = S.settings || {};
    for (const a of ['orange', 'blue', 'green', 'purple']) document.body.classList.toggle('accent-' + a, (s.accent || 'orange') === a);
    document.body.classList.toggle('compact', s.density === 'compact');
    document.body.classList.toggle('icons-small', s.iconSize === 'normal');
  }
  var appVersion = '';
  api.app.info().then((i) => { appVersion = i.version; updateTitle(); }).catch(() => {});
  function updateTitle() {
    const dirty = S.openTabs.some((t) => t.dirty);
    const parts = [];
    if (S.activeTab) parts.push(S.activeTab.name);
    if (S.project) parts.push(S.project.manifest.name);
    parts.push('ElectriCAD' + (appVersion ? ' ' + appVersion : ''));
    document.title = (dirty ? '● ' : '') + parts.join(' — ');
  }
  async function resetSettings() {
    const ok = await confirmDialog('Reset settings', 'Every setting goes back to its default. Your projects folder, recent and pinned projects, AI key and Pi address are kept.',
      [{ label: 'Cancel', value: false }, { label: 'Reset', value: true, danger: true }]);
    if (!ok) return;
    S.settings = await api.settings.reset();
    applyTheme(S.settings.theme); applyLook(); applyEditorSettings(); renderSettings();
    toast('Settings reset to defaults');
  }
  window.addEventListener('blur', () => {
    const ed = (S.settings && S.settings.editor) || {};
    if (ed.saveOnBlur && S.openTabs.some((t) => t.dirty)) saveAll(true);
  });

  // ---- editor: symbols, go to definition across files ----------------------------
  const CFN = /^\s*(?:static\s+|inline\s+|virtual\s+|IRAM_ATTR\s+)*(?:[\w:<>*&]+\s+)+\**([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:const\s*)?\{?\s*$/;
  const NOT_FN = /^(if|for|while|switch|return|else|sizeof)$/;
  function symbolsOf(model) {
    const out = [];
    const isPy = model.getLanguageId() === 'python';
    const lines = model.getLinesContent();
    lines.forEach((ln, i) => {
      let m;
      const add = (name, kind, detail) => {
        const col = ln.indexOf(name) + 1 || 1;
        out.push({ name, kind, detail: detail || '', line: i + 1, col, len: name.length });
      };
      if (isPy) {
        if ((m = /^(\s*)(def|class)\s+([A-Za-z_]\w*)/.exec(ln))) add(m[3], m[2] === 'def' ? (m[1] ? 'method' : 'function') : 'class');
        else if ((m = /^([A-Z_][A-Z0-9_]*)\s*=/.exec(ln))) add(m[1], 'constant');
        return;
      }
      if ((m = /^\s*#\s*define\s+([A-Za-z_]\w*)/.exec(ln))) add(m[1], 'constant', '#define');
      else if ((m = /^\s*(class|struct|enum(?:\s+class)?)\s+([A-Za-z_]\w*)/.exec(ln)) && !/;\s*$/.test(ln)) add(m[2], m[1].startsWith('enum') ? 'enum' : 'class');
      else if ((m = CFN.exec(ln)) && !NOT_FN.test(m[1])) add(m[1], 'function');
      else if ((m = /^(?:static\s+|const\s+|volatile\s+|constexpr\s+)*(?:unsigned\s+)?(?:int|long|float|double|bool|byte|char|uint\d+_t|int\d+_t|String|[A-Z]\w+)\s+\*?([A-Za-z_]\w*)\s*(?:=|;|\[|\()/.exec(ln)) && !/^\s/.test(ln)) add(m[1], 'variable');
    });
    return out;
  }
  function initLanguageExtras() {
    const KIND = monaco.languages.SymbolKind;
    const kindOf = (k) => ({ function: KIND.Function, method: KIND.Method, class: KIND.Class, enum: KIND.Enum, constant: KIND.Constant, variable: KIND.Variable }[k] || KIND.Variable);
    for (const lang of ['cpp', 'python']) {
      monaco.languages.registerDocumentSymbolProvider(lang, {
        provideDocumentSymbols(model) {
          return symbolsOf(model).map((s) => {
            const range = new monaco.Range(s.line, 1, s.line, model.getLineMaxColumn(s.line));
            return { name: s.name, detail: s.detail, kind: kindOf(s.kind), range, selectionRange: new monaco.Range(s.line, s.col, s.line, s.col + s.len), tags: [] };
          });
        }
      });
      monaco.languages.registerDefinitionProvider(lang, {
        provideDefinition(model, position) {
          const w = model.getWordAtPosition(position);
          if (!w) return null;
          const out = [];
          for (const m of monaco.editor.getModels()) {
            if (m.getLanguageId() !== lang) continue;
            for (const s of symbolsOf(m)) if (s.name === w.word) out.push({ uri: m.uri, range: new monaco.Range(s.line, s.col, s.line, s.col + s.len) });
          }
          return out;
        }
      });
    }
    // Go to Definition into another open file: switch our tab, then reveal
    if (monaco.editor.registerEditorOpener) {
      monaco.editor.registerEditorOpener({
        openCodeEditor(source, resource, sel) {
          const tab = S.openTabs.find((t) => t.model.uri.toString() === resource.toString());
          if (!tab) return false;
          activateTab(tab);
          if (sel) {
            const line = sel.startLineNumber || sel.lineNumber;
            const col = sel.startColumn || sel.column || 1;
            S.editor.revealLineInCenter(line);
            S.editor.setPosition({ lineNumber: line, column: col });
          }
          return true;
        }
      });
    }
  }

  // ---- diff viewer (local history, compare with saved, two files) ---------------
  function showDiff(title, left, right, lang, opts = {}) {
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal diff-modal';
    box.innerHTML = `<div class="modal-title">${esc(title)}</div>
      <div class="diff-labels"><span>${esc(opts.leftLabel || 'Before')}</span><span>${esc(opts.rightLabel || 'Now')}</span></div>
      <div class="diff-host"></div><div class="modal-btns"></div>`;
    ov.appendChild(box);
    document.body.appendChild(ov);
    const a = monaco.editor.createModel(left, lang);
    const b = monaco.editor.createModel(right, lang);
    const de = monaco.editor.createDiffEditor(box.querySelector('.diff-host'), {
      readOnly: true, originalEditable: false, automaticLayout: true, renderSideBySide: true,
      theme: S.settings.theme === 'light' ? 'electricad-light' : 'electricad', fontSize: (S.settings.editorFontSize || 14) - 1
    });
    de.setModel({ original: a, modified: b });
    const close = () => { de.dispose(); a.dispose(); b.dispose(); ov.remove(); };
    const btns = box.querySelector('.modal-btns');
    const btn = (label, cls, fn) => { const el = document.createElement('button'); el.className = 'action ' + (cls || ''); el.textContent = label; el.addEventListener('click', fn); btns.appendChild(el); return el; };
    btn('↑ Previous change', '', () => de.goToDiff && de.goToDiff('previous'));
    btn('↓ Next change', '', () => de.goToDiff && de.goToDiff('next'));
    if (opts.onRestore) btn(opts.restoreLabel || 'Restore this version', 'danger', () => { opts.onRestore(left); close(); });
    btn('Close', 'primary', close).focus();
    ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  }
  function replaceModelText(tab, text) {
    tab.model.pushEditOperations([], [{ range: tab.model.getFullModelRange(), text }], () => null);
  }
  async function localHistory() {
    const t = S.activeTab;
    if (!t) return toast('Open a file first');
    const list = await api.file.historyList(t.path).catch(() => []);
    if (!list.length) return toast('No saved versions of ' + t.name + ' yet. Each save keeps one (the last 20).', 3000);
    palette(list.map((v) => ({
      label: `🕘 ${new Date(v.time).toLocaleString()}  ·  ${U.fmtBytes(v.bytes)}`,
      run: async () => {
        const old = await api.file.historyRead(t.path, v.id);
        showDiff(t.name + ' — saved ' + new Date(v.time).toLocaleString(), old, t.model.getValue(), t.model.getLanguageId(),
          { leftLabel: 'Saved ' + new Date(v.time).toLocaleString(), rightLabel: 'In the editor now',
            onRestore: (txt) => { replaceModelText(t, txt); toast('Restored. Ctrl+Z undoes it; Ctrl+S saves it.', 3000); } });
      }
    })), 'Local history of ' + t.name);
  }
  async function compareWithSaved() {
    const t = S.activeTab;
    if (!t) return toast('Open a file first');
    const disk = await api.file.read(t.path).catch(() => null);
    if (disk == null) return toast('The file is not on disk yet');
    if (disk === t.model.getValue()) return toast('No unsaved changes in ' + t.name, 1500);
    showDiff(t.name + ' — unsaved changes', disk, t.model.getValue(), t.model.getLanguageId(),
      { leftLabel: 'On disk', rightLabel: 'In the editor', restoreLabel: 'Revert to the saved file', onRestore: (txt) => replaceModelText(t, txt) });
  }
  function projectFiles() {
    const files = [];
    (function collect(nodes) { for (const n of nodes) n.dir ? collect(n.children || []) : files.push(n); })((S.project && S.project.tree) || []);
    return files;
  }
  async function compareFiles() {
    const t = S.activeTab;
    if (!t) return toast('Open the first file, then pick the second');
    const files = projectFiles().filter((f) => f.path !== t.path && TEXT_EXT.test(f.name));
    if (!files.length) return toast('No other text files in the project');
    palette(files.map((f) => ({
      label: '📄 ' + (S.project ? f.path.slice(S.project.dir.length + 1) : f.name),
      run: async () => {
        const open = S.openTabs.find((x) => x.path === f.path);
        const other = open ? open.model.getValue() : await api.file.read(f.path);
        showDiff(t.name + ' ↔ ' + f.name, t.model.getValue(), other, langFor(f.path), { leftLabel: t.name, rightLabel: f.name });
      }
    })), 'Compare ' + t.name + ' with…');
  }

  // ---- hot exit: unsaved buffers survive a crash or a power cut --------------------
  setInterval(() => {
    const bufs = S.openTabs.filter((t) => t.dirty && !t.boardFile).map((t) => ({ path: t.path, name: t.name, content: t.model.getValue() }));
    if (!bufs.length && !S.hotHad) return;
    S.hotHad = bufs.length > 0;
    api.file.hotSave(bufs).catch(() => {});
  }, 5000);
  async function offerHotExit() {
    const hot = await api.file.hotLoad().catch(() => null);
    if (!hot || !hot.buffers || !hot.buffers.length) return;
    const n = hot.buffers.length;
    const ok = await confirmDialog('Restore unsaved work?',
      `ElectriCAD closed with ${n} unsaved file${n === 1 ? '' : 's'} (${hot.buffers.map((b) => b.name).join(', ')}) on ${new Date(hot.saved).toLocaleString()}. Restore ${n === 1 ? 'it' : 'them'} into the editor?`,
      [{ label: 'Discard', value: false, danger: true }, { label: 'Restore', value: true, primary: true }]);
    if (ok) {
      for (const b of hot.buffers) {
        const tab = await openFile(b.path, b.name, { quiet: true });
        if (tab && tab.model.getValue() !== b.content) replaceModelText(tab, b.content);
      }
      toast('Restored your unsaved work. Ctrl+Z in a file goes back to the saved version.', 3500);
    }
    api.file.hotClear().catch(() => {});
  }

  // ---- replace in project, with a preview -----------------------------------------
  async function replaceInProject() {
    if (!S.project) return toast('Open a project first');
    const r = await dialog({ title: 'Replace in project', okLabel: 'Preview', fields: [
      { key: 'find', label: 'Find', value: $('searchBox').value || selectedText() || '' },
      { key: 'repl', label: 'Replace with', value: '' },
      { key: 'mode', label: 'Match', value: 'word', options: [{ value: 'text', label: 'Text, ignoring case' }, { value: 'case', label: 'Text, matching case' },
        { value: 'word', label: 'Whole word, matching case' }, { value: 'regex', label: 'Regular expression ($1 in the replacement)' }] }
    ] });
    if (!r || !r.find) return;
    let re;
    try {
      const lit = r.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      re = r.mode === 'regex' ? new RegExp(r.find, 'g') : new RegExp(r.mode === 'word' ? '\\b' + lit + '\\b' : lit, r.mode === 'text' ? 'gi' : 'g');
    } catch (e) { return toast('Bad regular expression: ' + e.message, 4000); }
    const plan = [];
    for (const f of projectFiles().filter((x) => TEXT_EXT.test(x.name)).slice(0, 800)) {
      const tab = S.openTabs.find((t) => t.path === f.path);
      let text;
      try { text = tab ? tab.model.getValue() : await api.file.read(f.path); } catch (e) { continue; }
      re.lastIndex = 0;
      const n = (text.match(re) || []).length;
      if (!n) continue;
      const samples = [];
      text.split('\n').forEach((ln, i) => { re.lastIndex = 0; if (samples.length < 4 && re.test(ln)) { re.lastIndex = 0; samples.push({ line: i + 1, before: ln.trim(), after: ln.replace(re, r.repl).trim() }); } });
      plan.push({ f, tab, text, n, samples });
    }
    if (!plan.length) return toast('No matches for ' + r.find);
    const total = plan.reduce((a, p) => a + p.n, 0);
    const box = infoDialog('Replace in project', `<p><b>${total}</b> match${total === 1 ? '' : 'es'} in <b>${plan.length}</b> file${plan.length === 1 ? '' : 's'}. Untick a file to leave it alone.</p>
      <div class="rip-list">${plan.map((p, i) => `<label class="rip-file"><input type="checkbox" data-i="${i}" checked> <b>${esc(p.f.name)}</b> <span class="dim">${p.n}×</span></label>
        ${p.samples.map((s) => `<div class="rip-line"><span class="dim2">${s.line}</span> <span class="d-del">${esc(s.before.slice(0, 120))}</span><br><span class="dim2">${s.line}</span> <span class="d-add">${esc(s.after.slice(0, 120))}</span></div>`).join('')}`).join('')}</div>`);
    const go = document.createElement('button');
    go.className = 'action danger';
    go.textContent = 'Replace';
    box.querySelector('.modal-btns').prepend(go);
    go.addEventListener('click', async () => {
      const picked = [...box.querySelectorAll('.rip-file input')].filter((c) => c.checked).map((c) => plan[Number(c.dataset.i)]);
      box.parentElement.remove();
      let files = 0;
      for (const p of picked) {
        re.lastIndex = 0;
        const next = p.text.replace(re, r.repl);
        if (p.tab) replaceModelText(p.tab, next);          // open files: undoable, saved by the user
        else { await api.file.write(p.f.path, p.text); await api.file.write(p.f.path, next); }   // keeps the old copy in local history
        files++;
      }
      toast(`Replaced in ${files} file${files === 1 ? '' : 's'}. Open files are unsaved (Ctrl+Z undoes); closed files were saved, with the old copy in local history.`, 5000);
      refreshTree();
    });
  }

  // full Markdown for documents (the chat renderer above is for short replies)
  function docMarkdown(el, md) {
    const inline = (t) => esc(t)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="#" data-href="$2">$1</a>');
    const lines = String(md || '').replace(/\r/g, '').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const ln = lines[i];
      let m;
      if (/^```/.test(ln)) {
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push('<pre class="calc-code">' + esc(buf.join('\n')) + '</pre>');
        continue;
      }
      if ((m = /^(#{1,4})\s+(.*)$/.exec(ln))) { out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++; continue; }
      if (/^\s*([-*]|\d+\.)\s+/.test(ln)) {
        const ordered = /^\s*\d+\./.test(ln);
        const items = [];
        while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ''));
        out.push((ordered ? '<ol>' : '<ul>') + items.map((x) => '<li>' + inline(x) + '</li>').join('') + (ordered ? '</ol>' : '</ul>'));
        continue;
      }
      if (/^\|.*\|\s*$/.test(ln)) {
        const rows = [];
        while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
        const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const body = rows.filter((r) => !/^\|[\s:|-]+\|$/.test(r.trim()));
        out.push('<table class="calc-table">' + body.map((r, n) => '<tr>' + cells(r).map((c) => (n ? '<td>' : '<th>') + inline(c) + (n ? '</td>' : '</th>')).join('') + '</tr>').join('') + '</table>');
        continue;
      }
      if (!ln.trim()) { i++; continue; }
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*([-*]|\d+\.)\s|\|)/.test(lines[i])) para.push(lines[i++]);
      out.push('<p>' + inline(para.join(' ')) + '</p>');
    }
    el.innerHTML = out.join('\n');
    el.querySelectorAll('a[data-href]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); api.openExternal(a.dataset.href); }));
  }

  // ---- previews: Markdown, images (→ C array) ------------------------------------
  function markdownPreview() {
    const t = S.activeTab;
    if (!t || !/\.md$/i.test(t.path)) return toast('Open a .md file first');
    const box = infoDialog(t.name, '<div class="md-preview"></div>');
    box.classList.add('wide-modal');
    docMarkdown(box.querySelector('.md-preview'), t.model.getValue());
  }
  async function showImage(p) {
    let b64;
    try { b64 = await api.file.readBase64(p); } catch (e) { return toast('Could not read ' + baseName(p) + ': ' + e.message, 4000); }
    const ext = (/\.(\w+)$/.exec(p) || [, 'png'])[1].toLowerCase();
    const mime = { jpg: 'jpeg', svg: 'svg+xml', ico: 'x-icon' }[ext] || ext;
    const url = `data:image/${mime};base64,${b64}`;
    const box = infoDialog(baseName(p), `<div class="img-preview"><img alt=""></div><p class="dim img-meta"></p>
      <div class="img-tools"><label>Threshold <input type="range" min="1" max="254" value="128" class="img-th"></label>
      <label><input type="checkbox" class="img-inv"> Invert</label>
      <label>Width <input type="number" class="input img-w" min="1" max="1024" style="width:80px"></label>
      <button class="action img-c">To C array (1-bit, for OLED drawBitmap)</button></div><pre class="img-out hidden"></pre>`);
    box.classList.add('wide-modal');
    const img = box.querySelector('img');
    img.src = url;
    img.onload = () => {
      box.querySelector('.img-meta').textContent = `${img.naturalWidth} × ${img.naturalHeight} px · ${U.fmtBytes(Math.round(b64.length * 3 / 4))}`;
      box.querySelector('.img-w').value = Math.min(img.naturalWidth, 128);
    };
    box.querySelector('.img-c').addEventListener('click', () => {
      const w = Math.max(1, Math.min(1024, Number(box.querySelector('.img-w').value) || img.naturalWidth));
      const h = Math.max(1, Math.round(img.naturalHeight * w / img.naturalWidth));
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      const g = cv.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);      // transparent → white (off)
      g.drawImage(img, 0, 0, w, h);
      const bm = T.bitmap(g.getImageData(0, 0, w, h).data, w, h, { threshold: Number(box.querySelector('.img-th').value), invert: box.querySelector('.img-inv').checked });
      const name = baseName(p).replace(/\.\w+$/, '').replace(/[^A-Za-z0-9_]/g, '_');
      const code = T.bitmapToC(bm, name);
      const out = box.querySelector('.img-out');
      out.textContent = code; out.classList.remove('hidden');
      const btns = box.querySelector('.modal-btns');
      if (!btns.querySelector('.img-copy')) {
        const cp = document.createElement('button'); cp.className = 'action img-copy'; cp.textContent = 'Copy';
        cp.addEventListener('click', () => { navigator.clipboard.writeText(out.textContent); toast('Copied'); });
        const sv = document.createElement('button'); sv.className = 'action img-save'; sv.textContent = 'Save as .h in the project';
        sv.addEventListener('click', async () => {
          if (!S.project) return toast('Open a project first');
          const hp = joinPath(S.project.dir, name + '.h');
          await api.file.write(hp, '#pragma once\n#include <Arduino.h>\n\n' + out.textContent + '\n');
          await refreshTree(); openFile(hp);
          box.parentElement.remove();
        });
        btns.prepend(sv); btns.prepend(cp);
      }
    });
  }
  async function imageToC() {
    const p = await api.project.pickFile({ filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp'] }] });
    if (p) showImage(p);
  }

  // ---- editor actions --------------------------------------------------------------
  function toggleColumnSelection() {
    S.columnSelection = !S.columnSelection;
    if (S.editor) S.editor.updateOptions({ columnSelection: S.columnSelection });
    toast('Column (box) selection ' + (S.columnSelection ? 'on: drag to select a rectangle' : 'off'), 1600);
  }
  function arduinoReference() {
    const m = S.editor && S.editor.getModel();
    const w = m && (selectedText() || (m.getWordAtPosition(S.editor.getPosition()) || {}).word);
    if (!w) return toast('Put the cursor on a function name first');
    api.openExternal('https://www.google.com/search?q=' + encodeURIComponent('site:docs.arduino.cc ' + w));
  }

  // ---- build: several boards, flags, folders --------------------------------------
  const COMMON_FQBNS = [
    ['arduino:avr:uno', 'Arduino Uno'], ['arduino:avr:nano', 'Arduino Nano'], ['arduino:avr:mega', 'Arduino Mega 2560'],
    ['arduino:avr:leonardo', 'Arduino Leonardo'], ['arduino:megaavr:nona4809', 'Arduino Nano Every'],
    ['esp32:esp32:esp32', 'ESP32 Dev Module'], ['esp8266:esp8266:nodemcuv2', 'NodeMCU 1.0 (ESP8266)'], ['rp2040:rp2040:rpipico', 'Raspberry Pi Pico']
  ];
  async function multiBuild() {
    if (!S.project || isPyBoard()) return toast('Open an Arduino sketch first');
    await saveAll(true);
    const m = S.project.manifest || {};
    const picked = new Set(m.buildTargets && m.buildTargets.length ? m.buildTargets : [S.fqbn].filter(Boolean));
    const list = COMMON_FQBNS.slice();
    if (S.fqbn && !list.some(([f]) => f === S.fqbn.split(':').slice(0, 3).join(':'))) list.unshift([S.fqbn, S.fqbn]);
    const box = infoDialog('Build for several boards', `<p class="dim">Compiles ${esc(m.name)} once per board. Board cores that aren't installed yet are downloaded first.</p>
      <table class="mb-table"><tbody>${list.map(([f, n]) => `<tr data-f="${esc(f)}"><td><label><input type="checkbox" ${picked.has(f) ? 'checked' : ''}> ${esc(n)}</label><div class="dim2">${esc(f)}</div></td><td class="mb-res"></td></tr>`).join('')}</tbody></table>`);
    box.classList.add('wide-modal');
    const go = document.createElement('button');
    go.className = 'action primary'; go.textContent = '▶ Build';
    box.querySelector('.modal-btns').prepend(go);
    go.addEventListener('click', async () => {
      const rows = [...box.querySelectorAll('tr')].filter((tr) => tr.querySelector('input').checked);
      if (!rows.length) return toast('Tick at least one board');
      go.disabled = true;
      await api.project.update(S.project.dir, { buildTargets: rows.map((tr) => tr.dataset.f) }).catch(() => {});
      setBuilding('building for ' + rows.length + ' boards…'); buildProgress(true);
      let ok = 0;
      try {
        for (const tr of rows) {
          const cell = tr.querySelector('.mb-res');
          cell.innerHTML = '<span class="dim">compiling…</span>';
          let r;
          try {
            r = await api.toolchain.compile({ sketchDir: S.project.dir, fqbn: tr.dataset.f, warnings: 'default', extraFlags: m.buildFlags || '', defines: m.defines || [] });
          } catch (e) { r = { ok: false, raw: e.message }; }
          if (r.cancelled) { cell.textContent = 'cancelled'; break; }
          if (r.ok) {
            ok++;
            const mem = r.memory || {};
            const fmt = (x) => (x && x.pct != null ? x.pct + '%' : x ? U.fmtBytes(x.used) : '–');
            cell.innerHTML = `<span class="ok">✓</span> flash ${fmt(mem.flash)} · RAM ${fmt(mem.ram)} · ${r.seconds.toFixed(1)} s`;
          } else {
            const first = (r.diagnostics || []).find((d) => d.severity === 'error');
            cell.innerHTML = `<span class="bad">✗</span> ${esc(first ? baseName(first.file) + ':' + first.line + ' ' + first.message : (r.raw || 'failed').split('\n').slice(-2).join(' ')).slice(0, 220)}`;
            logTo('outputLog', `— ${tr.dataset.f} —\n` + (r.raw || ''), 'err');
          }
        }
      } finally { setBuilding(null); buildProgress(false); go.disabled = false; }
      toast(`${ok} of ${rows.length} board${rows.length === 1 ? '' : 's'} built`, 2500);
    });
  }
  async function buildFlags() {
    if (!S.project) return toast('Open a project first');
    const m = S.project.manifest || {};
    const r = await dialog({ title: 'Build flags for ' + m.name, okLabel: 'Save', fields: [
      { key: 'defines', label: 'Defines, comma separated (DEBUG, BAUD=115200)', value: (m.defines || []).map((d) => (typeof d === 'string' ? d : d.value !== undefined && d.value !== '' ? d.name + '=' + d.value : d.name)).join(', ') },
      { key: 'flags', label: 'Extra compiler flags (-O2, -Wno-unused…)', value: m.buildFlags || '' }
    ] });
    if (!r) return;
    const list = r.defines.split(',').map((x) => x.trim()).filter(Boolean);
    const bad = list.find((d) => !/^[A-Za-z_]\w*(=[^\s"]*)?$/.test(d));
    if (bad) return toast('Not a valid define: ' + bad, 4000);
    const defines = list.map((d) => { const i = d.indexOf('='); return i < 0 ? { name: d, value: '' } : { name: d.slice(0, i), value: d.slice(i + 1) }; });
    if (/[;&|`$]/.test(r.flags)) return toast('Flags can\'t contain ; & | ` or $', 4000);
    S.project.manifest = await api.project.update(S.project.dir, { defines, buildFlags: r.flags.trim() }) || { ...m, defines, buildFlags: r.flags.trim() };
    toast('Saved. The next build uses them; arduino-cli rebuilds everything when flags change.', 3000);
  }
  async function openBuildFolder() {
    if (!S.lastBuild || !S.lastBuild.buildPath) return toast('Verify the sketch first');
    api.file.openPath(S.lastBuild.buildPath).catch((e) => toast(e.message, 4000));
  }
  async function libVersionInstall(name) {
    if (!name) {
      const r = await dialog({ title: 'Install a specific library version', okLabel: 'Find versions', fields: [{ key: 'name', label: 'Library name (exactly as in the Library Manager)', value: '' }] });
      if (!r || !r.name.trim()) return;
      name = r.name.trim();
    }
    toast('Looking up versions of ' + name + '…', 1500);
    const vers = await api.toolchain.libVersions(name).catch((e) => (toast(e.message, 4000), null));
    if (!vers) return;
    if (!vers.length) return toast('No library called "' + name + '" in the index', 3000);
    palette(vers.map((v, i) => ({ label: `📦 ${name} ${v}${i === 0 ? '  (latest)' : ''}`, run: async () => {
      toast(`Installing ${name} ${v}…`, 6000);
      const res = await api.toolchain.libInstallVersion(name, v).catch((e) => ({ ok: false, error: e.message }));
      if (res && res.ok === false) return toast('Install failed: ' + (res.error || res.err || ''), 5000);
      toast(`✓ ${name} ${v} installed`); refreshInstalledLibs();
    } })), 'Version of ' + name);
  }
  async function libDetails() {
    const libs = await api.toolchain.libInstalled().catch(() => []);
    if (!libs.length) return toast('No libraries installed');
    palette(libs.map((l) => ({ label: `📚 ${l.name} ${l.version || ''}`, run: () => {
      const box = infoDialog(l.name + ' ' + (l.version || ''), `<p>${esc(l.paragraph || l.sentence || '')}</p>
        <table class="kv">${[['Author', l.author], ['Maintainer', l.maintainer], ['Category', l.category], ['Architectures', (l.architectures || []).join(', ')],
          ['Installed in', l.dir], ['Location', l.location]].filter(([, v]) => v).map(([k, v]) => `<tr><td>${k}</td><td>${esc(v)}</td></tr>`).join('')}</table>`);
      const btns = box.querySelector('.modal-btns');
      if (l.dir) { const b = document.createElement('button'); b.className = 'action'; b.textContent = 'Open its folder'; b.addEventListener('click', () => api.file.openPath(l.dir)); btns.prepend(b); }
      const v = document.createElement('button'); v.className = 'action'; v.textContent = 'Other versions…';
      v.addEventListener('click', () => { box.parentElement.remove(); libVersionInstall(l.name); });
      btns.prepend(v);
    } })), 'Installed libraries');
  }
  async function archiveProject() {
    if (!S.project) return toast('Open a project first');
    await saveAll(true);
    const stamp = new Date().toISOString().slice(0, 10);
    const p = await api.file.saveDialog({ defaultPath: joinPath(dirName(S.project.dir), S.project.manifest.name + '-' + stamp + '.zip'), filters: [{ name: 'Zip archive', extensions: ['zip'] }] });
    if (!p) return;
    const r = await api.project.archive(S.project.dir, p).catch((e) => (toast(e.message, 4000), null));
    if (r) { toast(`✓ Archived ${r.files || ''} files to ${baseName(p)}`, 3000); api.file.reveal(p); }
  }
  async function renameProject() {
    if (!S.project) return toast('Open a project first');
    const r = await dialog({ title: 'Rename project', okLabel: 'Rename', fields: [{ key: 'name', label: 'New name (letters, numbers, - and _)', value: S.project.manifest.name }] });
    if (!r || !r.name.trim() || r.name.trim() === S.project.manifest.name) return;
    if (!(await saveAll(true) >= 0) || S.openTabs.some((t) => t.dirty)) return toast('Save your files first', 3000);
    const dir = S.project.dir;
    for (const t of S.openTabs.slice()) { t.model.dispose(); }
    S.openTabs = []; S.activeTab = null;
    try {
      const proj = await api.project.rename(dir, r.name.trim());
      await loadProject(proj);
      toast('Renamed to ' + proj.manifest.name);
    } catch (e) { toast(e.message, 5000); loadProject(await api.project.open(dir).catch(() => null)); }
  }
  async function duplicateProject() {
    if (!S.project) return toast('Open a project first');
    await saveAll(true);
    const r = await dialog({ title: 'Duplicate project', okLabel: 'Duplicate', fields: [{ key: 'name', label: 'Name of the copy', value: S.project.manifest.name + '_copy' }] });
    if (!r || !r.name.trim()) return;
    try { const proj = await api.project.duplicate(S.project.dir, r.name.trim()); await loadProject(proj); toast('Opened the copy, ' + proj.manifest.name); }
    catch (e) { toast(e.message, 5000); }
  }
  async function datasheet() {
    const r = await dialog({ title: 'Find a datasheet', okLabel: 'Search', fields: [{ key: 'part', label: 'Part number (ATmega328P, LM7805, BME280…)', value: selectedText() || '' }] });
    if (!r || !r.part.trim()) return;
    const q = encodeURIComponent(r.part.trim());
    palette([
      { label: '🔎 Octopart', run: () => api.openExternal('https://octopart.com/search?q=' + q) },
      { label: '🔎 Digi-Key', run: () => api.openExternal('https://www.digikey.com/en/products/result?keywords=' + q) },
      { label: '🔎 LCSC', run: () => api.openExternal('https://www.lcsc.com/search?q=' + q) },
      { label: '🔎 Mouser', run: () => api.openExternal('https://www.mouser.com/c/?q=' + q) },
      { label: '🔎 Web search for the PDF', run: () => api.openExternal('https://www.google.com/search?q=' + q + '+datasheet+filetype%3Apdf') }
    ], 'Where to look for ' + r.part.trim());
  }

  // ---- Python boards ----------------------------------------------------------------
  async function upyUploadCurrent() {
    const t = S.activeTab;
    if (!t || !/\.(py|txt|json|csv)$/i.test(t.name)) return toast('Open a .py file first');
    await saveTab(t, true);
    if (projType() === 'circuitpython') {
      const drives = await api.upy.drives().catch(() => []);
      if (!drives.length) return toast('No CIRCUITPY drive found', 3000);
      const rel = S.project ? t.path.slice(S.project.dir.length + 1).replace(/\\/g, '/') : t.name;
      await api.upy.copyToDrive(drives[0].root, rel, t.model.getValue());
      return toast(`✓ ${rel} → ${drives[0].root}`, 2500);
    }
    const port = await pyPort();
    if (!port) return;
    const rel = S.project ? t.path.slice(S.project.dir.length + 1).replace(/\\/g, '/') : t.name;
    if (/\.py$/i.test(rel)) {
      const chk = await api.upy.syntax(port, rel, t.model.getValue()).catch(() => ({ ok: true }));
      if (!chk.ok) { S.editor.revealLineInCenter(chk.line || 1); S.editor.setPosition({ lineNumber: chk.line || 1, column: 1 }); return toast(`Not uploaded: line ${chk.line}: ${chk.message}`, 6000); }
    }
    if (rel.includes('/')) await api.upy.mkdir(port, rel.replace(/\/[^/]*$/, '')).catch(() => {});
    const r = await api.upy.upload(port, rel, t.model.getValue()).catch((e) => (toast(e.message, 5000), null));
    if (r) toast(`✓ ${rel} on the board (${r.bytes} bytes)`, 2500);
  }
  async function upyMkdir() {
    const port = await pyPort();
    if (!port) return;
    const r = await dialog({ title: 'New folder on the board', okLabel: 'Create', fields: [{ key: 'name', label: 'Folder (lib, data/logs…)', value: 'lib' }] });
    if (!r || !r.name.trim()) return;
    try { await api.upy.mkdir(port, r.name.trim()); toast('Created /' + r.name.trim().replace(/^\/+/, '')); } catch (e) { toast(e.message, 4000); }
  }
  function pyFirmware() {
    palette([
      { label: '🐍 MicroPython firmware (micropython.org/download)', run: () => api.openExternal('https://micropython.org/download/') },
      { label: '🐍 CircuitPython firmware (circuitpython.org/downloads)', run: () => api.openExternal('https://circuitpython.org/downloads') },
      { label: '📚 CircuitPython library bundle', run: () => api.openExternal('https://circuitpython.org/libraries') },
      { label: '🔧 ESP32/ESP8266: flash with esptool in the browser (espressif.github.io/esptool-js)', run: () => api.openExternal('https://espressif.github.io/esptool-js/') }
    ], 'Python firmware');
  }
  async function upyEditBoardFile(port, name) {
    const text = await api.upy.read(port, name).catch((e) => (toast(e.message, 4000), null));
    if (text == null) return;
    const info = await api.app.info();
    const dir = joinPath(info.userData, 'board-files');
    await api.file.mkdir(dir).catch(() => {});
    const local = joinPath(dir, port.replace(/[^\w]/g, '_') + '__' + name.replace(/[\\/]/g, '__'));
    await api.file.write(local, text);
    const old = S.openTabs.find((t) => t.path === local);
    if (old) await closeTab(old);
    const tab = await openFile(local, '⚡ ' + baseName(name));
    if (!tab) return;
    tab.boardFile = { port, name };
    renderTabs();
    toast(`Editing ${name} on the board. Ctrl+S checks the syntax and writes it back.`, 3500);
  }

  // ---- AI ----------------------------------------------------------------------------
  async function aiFix(d) {
    const open = S.openTabs.find((t) => t.path === d.file);
    let text = open ? open.model.getValue() : await api.file.read(d.file).catch(() => '');
    const lines = text.split('\n');
    const from = Math.max(0, d.line - 25), to = Math.min(lines.length, d.line + 25);
    const whole = lines.length <= 200;
    const snippet = whole ? text : lines.slice(from, to).join('\n');
    aiAsk(`Fix this compile error. Reply with the corrected ${whole ? 'file' : 'lines ' + (from + 1) + '–' + to} as ONE code block I can paste over the original, then one sentence on what was wrong. Don't change anything else.\n\n` +
      `${baseName(d.file)}:${d.line}${d.col ? ':' + d.col : ''}: ${d.message}\n\n\`\`\`${/\.py$/i.test(d.file) ? 'python' : 'cpp'}\n${snippet}\n\`\`\``);
  }
  async function aiGenerate() {
    const r = await dialog({ title: 'New sketch from a description', okLabel: 'Create', fields: [
      { key: 'desc', label: 'What should it do? (blink an LED on pin 9 when the button on pin 2 is pressed…)', value: '' },
      { key: 'name', label: 'Project name', value: 'my_sketch' }
    ] });
    if (!r || !r.desc.trim()) return;
    let proj;
    try { proj = await api.project.create({ name: (r.name || 'my_sketch').trim().replace(/[^\w-]/g, '_'), type: 'arduino', fqbn: S.fqbn }); }
    catch (e) { return toast(e.message, 4000); }
    await loadProject(proj);
    aiAsk(`Write a complete, commented Arduino sketch for the ${S.fqbn || 'Arduino Uno'} that does this: ${r.desc.trim()}\n` +
      'Use only pins that exist on this board, say which libraries to install, and give the whole sketch as ONE cpp code block (Insert puts it in the editor).');
  }
  async function aiSaveChat() {
    if (!S.ai.messages.length) return toast('The chat is empty');
    const p = await api.file.saveDialog({ defaultPath: (S.project ? joinPath(S.project.dir, 'copilot-chat.md') : 'copilot-chat.md'), filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (!p) return;
    const md = '# ElectriCAD copilot chat\n\n' + S.ai.messages.map((m) => (m.role === 'user' ? '## You\n\n' : '## Copilot\n\n') + m.content).join('\n\n') + '\n';
    await api.file.write(p, md);
    toast('Saved ' + baseName(p));
  }

  // ---- help, what's new ---------------------------------------------------------------
  async function showGuide() {
    let md;
    try { md = await api.app.docs('GUIDE.md'); } catch (e) { return toast('The guide is missing from this install', 3000); }
    const box = infoDialog('ElectriCAD guide', '<div class="md-preview"></div>');
    box.classList.add('wide-modal');
    docMarkdown(box.querySelector('.md-preview'), md);
  }
  const WHATS_NEW = [
    ['🔍 Every component (0.9.6)', 'Every resistor, capacitor, chip and connector on the drawn boards now comes from the maker\'s design files. Hover any of them, on the board, the wiring canvas or the PCB, to see what it is and what it does.'],
    ['🗂 Part cards and buy links (0.9.6)', 'Details opens a full card: part number, maker, package, connections, a close-up from the board picture, live LCSC specs, prices, stock and the datasheet. LCSC, Digi-Key and Mouser links open the shop page; nothing is ever ordered for you.'],
    ['🏷 Factory markings (0.9.6)', 'Chips carry their names, electrolytic cans their µF, crystals their frequency, diodes their code. Only where the print is known: tiny chip parts have none and date codes change per batch.'],
    ['💡 Onboard LEDs (0.9.5)', 'Every board LED is where it really is, in its real colour, and works like the real one: ON with power, L with its pin (dimmed by PWM), TX/RX with serial traffic and uploads, the Feather charge LED, NeoPixel colours and the UNO R4 WiFi LED matrix. Hover an LED to see what drives it.'],
    ['🪶 Feathers to scale (0.9.5)', 'The Feather ESP32, RP2040, M0 (Basic and Express) and M4 are now drawn from Adafruit\'s own board files, so every pin, LED and part is where it is on the real board.'],
    ['🧪 LEDs in the simulator (0.9.5)', 'No board plugged in? Press Run on the wiring canvas and the pins you set there light the board\'s LEDs. Live telemetry now also covers the UNO R4.'],
    ['📷 Real boards (0.9.4)', 'The Live Board shows the real board: official Arduino images and real photos, lined up pad for pad with the live pins. Pick Drawn, Image, Both (side by side) or Overlay, turn the board over to see the back, and rotate it in 90° steps.'],
    ['📐 Drawn to scale (0.9.4)', 'Uno, Mega, Nano, Leonardo and Nano Every are now drawn from Arduino\'s own CAD files: every header, ICSP pin, LED and mounting hole where it really is. The Mega now has its 2×18 header the right way round and the Nano is no longer mirrored.'],
    ['🔀 Revisions (0.9.4)', 'UNO R3, R4 Minima and R4 WiFi each have their own picture, LEDs and pin names, picked from the board you select. ⚑ Report wrong image sends the exact picture and revision.'],
    ['🔎 Real parts (0.9.3)', 'Parts → JLCPCB / LCSC searches every part JLCPCB can assemble: price, stock, specs, datasheet, the KiCad pinout and footprint. Place it and it lands on the canvas, the PCB (real footprint) and the BOM with its LCSC number.'],
    ['⇄ Choose a real part (0.9.3)', 'Right-click a resistor, LED, regulator or transistor on the canvas and pick a real catalogue part for it. Its wires stay connected.'],
    ['⚑ Report a bug (0.9.3)', 'Help → Report a Bug, or ⚑ under the Live Board for a wrong picture. Reports go straight to Kinode, with an optional screenshot.'],
    ['# Grid (0.9.2)', 'The wiring canvas and the PCB have a grid that moves and zooms with your design. G shows or hides it, Shift+G turns snapping on or off, and the toolbar sets the grid size (down to 0.1 mm on the PCB).'],
    ['🧱 PCB layers (0.9.2)', 'Choose 1, 2, 4 or 6 copper layers in the PCB side panel. Inner layers can be signal layers or solid GND and power planes. The Layers list shows, hides and recolours every layer and picks the one you route on (L or 1–6).'],
    ['▰ Copper pours', 'Draw a pour (P) or pour a whole layer in one click. Pours keep clear of other nets, join their own pads with thermal spokes, and the rule check flags cut-off islands. Gerbers, drill files and a stackup note for JLCPCB and PCBWay cover every layer.'],
    ['⛶ Full screen', 'ElectriCAD opens full screen. F11 or ⛶ in the top bar switches it, and minimise and close sit next to it. The PCB view takes the whole window; ◫ Panels brings the side panels back. The left icon bar is bigger and resizes too. Drag the strips between panels to resize them, drag one shut to hide it, double-click a strip for the default size.'],
    ['✏ PCB editing (0.9.1)', 'Undo, redo, delete, clear and reset on the PCB toolbar. Click a hole, via, trace, text or part to change its size in the side panel; with nothing selected, set the board size, default sizes and rules.'],
    ['🟩 PCB layout', 'A PCB tab turns your wiring canvas into a real board: place, route top and bottom, design-rule check, then export Gerbers, drill, BOM and pick-and-place in one zip.'],
    ['🏭 Order boards', 'One Order button exports and opens JLCPCB, PCBWay, OSH Park, Aisler, Eurocircuits or Seeed. You can also check any Gerber zip before you upload it.'],
    ['🔍 Bigger icons', 'The side bar icons are larger and labelled. Settings → Appearance → Icon size switches back.'],
    ['🕘 Local history', 'Every save keeps a copy (the last 20). Tools → Local history shows the differences and restores any of them. Unsaved work also survives a crash.'],
    ['⎇ Git', 'Push, pull, fetch, set a remote, blame and commit details.'],
    ['🖥 Serial', 'ANSI colours, Δt timestamps, record to file, DTR/RTS, Ctrl+C/Ctrl+D, a repeat sender and a raw typing mode.'],
    ['🧮 Tools', '12 more calculators plus number converter, ASCII, RGB565, image → C array, notes, I²C addresses and CRCs.'],
    ['🔌 Parts', 'Hall sensor, tilt switch, solar cell, MQ-2 gas sensor, TP4056 charger, vibration motor and joystick, all simulated.'],
    ['🏗 Builds', 'Build for several boards at once, per-project defines and flags, upload the last build, third-party board URLs.']
  ];
  function showWhatsNew(ver) {
    infoDialog('What\'s new in ElectriCAD ' + (ver || ''), `<div class="whatsnew">${WHATS_NEW.map(([h, t]) => `<div class="wn-item"><b>${esc(h)}</b><span>${esc(t)}</span></div>`).join('')}</div>
      <p class="dim">Help → Guide has the whole manual.</p>`).classList.add('wide-modal');
  }
  async function maybeWhatsNew() {
    const info = await api.app.info().catch(() => null);
    if (!info) return;
    const seen = S.settings.lastSeenVersion || '';
    if (seen === info.version) return;
    S.settings = await api.settings.set({ lastSeenVersion: info.version });
    if (seen) showWhatsNew(info.version);     // not on the very first run
  }

  // ---- tools as calculators -------------------------------------------------------------
  const calcNum = (x) => (String(x).trim() === '' ? NaN : CALC.parseEng(x));
  const calcTable = (rows, head) => `<table class="calc-table">${head ? '<tr>' + head.map((h) => `<th>${h}</th>`).join('') + '</tr>' : ''}${rows.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('')}</table>`;
  CALCS.push(
    { id: 'series', name: 'Series / parallel R and C', fields: [['vals', 'Values, comma separated (10k, 4k7, 22k)', '10k, 10k'], ['kind', 'Part', 'Resistors', ['Resistors', 'Capacitors']]],
      run: (v) => { const xs = v.vals.split(/[,;\s]+/).filter(Boolean).map(CALC.parseEng); if (xs.some((x) => !(x > 0))) return 'Enter values above 0';
        const R = v.kind === 'Resistors'; const u = R ? 'Ω' : 'F';
        return `Series <b>${CALC.eng(R ? CALC.seriesR(xs) : CALC.seriesC(xs), u)}</b> · parallel <b>${CALC.eng(R ? CALC.parallelR(xs) : CALC.parallelC(xs), u)}</b>`; } },
    { id: 'wire', name: 'Wire gauge (AWG) voltage drop', fields: [['g', 'AWG', '22'], ['len', 'Cable length, one way (m)', '2'], ['a', 'Current (A)', '1'], ['v', 'Supply (V)', '5']],
      run: (v) => { const r = CALC.wireDrop(+v.g, +v.len, +v.a, +v.v); return r.error || `${r.diameterMm.toFixed(3)} mm, ${r.areaMm2.toFixed(3)} mm², ${(r.ohmsPerM * 1000).toFixed(1)} mΩ/m<br>Drop <b>${r.drop.toFixed(3)} V</b>${r.pct != null ? ` (${r.pct.toFixed(1)}%)` : ''} over the round trip, ${CALC.eng(r.watts, 'W')} lost in the wire${r.pct > 5 ? '<br><span class="bad">Over 5%: use a thicker wire (smaller AWG).</span>' : ''}`; } },
    { id: 'trace', name: 'PCB trace width (IPC-2221)', fields: [['a', 'Current (A)', '1'], ['rise', 'Temperature rise allowed (°C)', '10'], ['oz', 'Copper (oz/ft²)', '1', ['0.5', '1', '2']], ['layer', 'Layer', 'Outer', ['Outer', 'Inner']]],
      run: (v) => { const r = CALC.traceWidth(+v.a, +v.rise, +v.oz, v.layer === 'Inner'); return r.error || `Minimum width <b>${r.widthMm.toFixed(3)} mm</b> (${r.widthMil.toFixed(1)} mil)<br><span class="dim2">Use at least 0.25 mm for signals; the PCB editor's widths are 0.25 to 2 mm.</span>`; } },
    { id: 'npn', name: 'Transistor base resistor', fields: [['vd', 'Drive voltage from the pin (V)', '5'], ['ma', 'Load current (mA)', '100'], ['hfe', 'hFE (datasheet minimum)', '100']],
      run: (v) => { const r = CALC.baseResistor(+v.vd, +v.ma, +v.hfe); return r.error || `Base resistor <b>${CALC.eng(r.nearest, 'Ω')}</b> (exact ${CALC.eng(r.ohms, 'Ω')}) · base current ${r.ibmA.toFixed(2)} mA, driven hard into saturation${r.warn ? '<br><span class="bad">' + esc(r.warn) + '</span>' : ''}`; } },
    { id: 'zener', name: 'Zener regulator resistor', fields: [['vmin', 'Lowest input (V)', '9'], ['vmax', 'Highest input (V)', '12'], ['vz', 'Zener voltage (V)', '5.1'], ['ma', 'Load current (mA)', '20']],
      run: (v) => { const r = CALC.zenerResistor(+v.vmin, +v.vmax, +v.vz, +v.ma); return r.error || `Resistor <b>${CALC.eng(r.nearest, 'Ω')}</b> (exact ${CALC.eng(r.ohms, 'Ω')})<br>Worst case with no load: resistor ${CALC.eng(r.resistorW, 'W')}, zener ${CALC.eng(r.zenerW, 'W')}. Pick parts rated at twice that.`; } },
    { id: 'pwm', name: 'PWM duty cycle', fields: [['d', 'Duty (%)', '25'], ['v', 'High level (V)', '5'], ['f', 'Frequency (Hz) — Uno pin 9: 490, pins 5/6: 980', '490']],
      run: (v) => { const r = CALC.pwm(+v.d, +v.v, +v.f); return `analogWrite(pin, <b>${r.value8}</b>) · 10-bit ${r.value10} · average ${r.avg.toFixed(2)} V${r.period ? `<br>On ${CALC.eng(r.onTime, 's')}, off ${CALC.eng(r.offTime, 's')}, period ${CALC.eng(r.period, 's')}` : ''}`; } },
    { id: 'servo', name: 'Servo angle ↔ pulse', fields: [['a', 'Angle (°)', '90'], ['us', '…or pulse (µs)', ''], ['min', 'Pulse at 0° (µs; Servo library default 544)', '544'], ['max', 'Pulse at 180° (µs; default 2400)', '2400']],
      run: (v) => { if (String(v.us).trim()) return `${v.us} µs = <b>${CALC.servoAngle(+v.us, +v.min, +v.max).toFixed(1)}°</b>`; const r = CALC.servo(+v.a, +v.min, +v.max); return `${r.angle}° = <b>${r.us} µs</b> · servo.writeMicroseconds(${r.us})`; } },
    { id: 'stepper', name: 'Stepper steps per mm', fields: [['ang', 'Step angle (°)', '1.8', ['1.8', '0.9', '7.5', '5.625']], ['ms', 'Microsteps', '16', ['1', '2', '4', '8', '16', '32', '64', '128', '256']],
        ['pitch', 'Belt pitch (mm), GT2 = 2', '2'], ['teeth', 'Pulley teeth', '20'], ['lead', '…or leadscrew lead (mm/turn), T8 = 8', ''], ['speed', 'Speed (mm/s)', '50']],
      run: (v) => { const lead = String(v.lead).trim() ? +v.lead : 0; const r = CALC.stepper({ stepAngle: +v.ang, microsteps: +v.ms, beltPitch: lead ? 0 : +v.pitch, teeth: lead ? 0 : +v.teeth, lead, speedMmS: +v.speed });
        return r.error || `<b>${r.stepsPerMm.toFixed(3)} steps/mm</b> · ${r.stepsPerRev} steps/rev · ${r.resolutionUm.toFixed(2)} µm per step${r.stepRate ? `<br>${Math.round(r.stepRate)} steps/s at ${v.speed} mm/s (${r.rpm.toFixed(0)} rpm)` : ''}`; } },
    { id: 'ntc', name: 'NTC thermistor temperature', fields: [['adc', 'analogRead() value', '512'], ['max', 'ADC maximum', '1023', ['1023', '4095']], ['rf', 'Fixed resistor (Ω)', '10k'],
        ['r0', 'Thermistor at 25 °C (Ω)', '10k'], ['beta', 'Beta (datasheet, often 3950)', '3950']],
      run: (v) => { const r = CALC.thermistorFromAdc(+v.adc, +v.max, calcNum(v.rf), true); if (!r) return 'Reading must be between 0 and the maximum'; const t = CALC.thermistor(r, calcNum(v.r0), +v.beta);
        return t.error || `Thermistor ${CALC.eng(r, 'Ω')} → <b>${t.c.toFixed(1)} °C</b> (${t.f.toFixed(1)} °F)<br><span class="dim2">Wiring: thermistor from the pin to GND, fixed resistor from the pin to Vcc.</span>`; } },
    { id: 'timer1', name: 'AVR Timer1 interrupt', fields: [['f', 'CPU clock (Hz)', '16M'], ['t', 'Interrupt rate wanted (Hz)', '1']],
      run: (v) => { const r = CALC.avrTimer1(calcNum(v.f), calcNum(v.t)); if (r.error) return r.error; const b = r.best;
        return `Prescaler <b>÷${b.prescaler}</b>, OCR1A <b>${b.ocr}</b> → ${b.actual.toFixed(4)} Hz (${b.errorPct.toFixed(4)}% off)<pre class="calc-code">${esc(b.code)}</pre>`; } },
    { id: 'db', name: 'Decibels ↔ ratio', fields: [['x', 'Ratio (Vout/Vin) or dB', '2'], ['mode', 'Convert', 'Ratio → dB', ['Ratio → dB', 'dB → ratio']], ['kind', 'Quantity', 'Voltage / current (20 log)', ['Voltage / current (20 log)', 'Power (10 log)']]],
      run: (v) => { const p = v.kind.startsWith('Power'); const x = +v.x; return v.mode === 'Ratio → dB' ? (x > 0 ? `<b>${CALC.dbFromRatio(x, p).toFixed(2)} dB</b>` : 'Ratio must be above 0') : `<b>×${CALC.ratioFromDb(x, p).toPrecision(5)}</b>`; } },
    { id: 'numconv', name: 'Number converter (dec / hex / bin)', fields: [['n', 'Number: 200, 0xC8, 0b11001000, \'A\'', '0xC8'], ['bits', 'Width', 'auto', ['auto', '8', '16', '32']]],
      run: (v) => { const n = T.parseNumber(v.n); if (n == null) return 'Not a number I can read'; const r = T.convert(n, v.bits === 'auto' ? 0 : +v.bits);
        return calcTable([['Decimal', r.dec], ['Hex', r.hex], ['Binary', r.bin], ['Octal', r.oct], ['Char', esc(r.char) || '–'], ['Fits in', r.fits.join(', ') || 'none of the usual types']].map(([a, b]) => [a, `<code>${b}</code>`])); } },
    { id: 'ascii', name: 'ASCII table', fields: [['q', 'Filter (letter, number or name)', '']],
      run: (v) => { const q = String(v.q).trim().toLowerCase(); const rows = T.asciiTable().filter((r) => !q || String(r.dec) === q || r.hex.toLowerCase() === q || r.char.toLowerCase() === q || r.name.toLowerCase().includes(q));
        return calcTable(rows.map((r) => [r.dec, r.hex, `<code>${esc(r.char)}</code>`, esc(r.name)]), ['Dec', 'Hex', 'Char', 'Name']); } },
    { id: 'rgb565', name: 'RGB565 colour (TFT displays)', fields: [['hex', 'Colour #RRGGBB', '#FF6500'], ['v565', '…or a 565 value (0xFB20)', '']],
      run: (v) => { if (String(v.v565).trim()) { const n = T.parseNumber(v.v565); if (n == null || n < 0 || n > 0xffff) return 'Enter 0 to 0xFFFF'; const c = T.from565(n); const h = '#' + [c.r, c.g, c.b].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
          return `<span class="swatch" style="background:${h}"></span> ${h} · r ${c.r} g ${c.g} b ${c.b}`; }
        const c = T.hexToRgb(v.hex); if (!c) return 'Enter a colour like #FF6500'; const r = T.rgb565(c.r, c.g, c.b);
        return `<span class="swatch" style="background:${esc(v.hex)}"></span> <b>${r.hex}</b> (${r.value}) · tft.fillScreen(${r.hex});`; } },
    { id: 'notes', name: 'Musical notes for tone()', fields: [['n', 'Note (A4, C#5, Eb3) or a frequency in Hz', 'A4']],
      run: (v) => { const s = String(v.n).trim(); const f = T.noteFreq(s); if (f) return `${esc(s)} = <b>${f.hz.toFixed(2)} Hz</b> · tone(pin, ${f.rounded}) · MIDI ${f.midi}`;
        const hz = Number(s); const nn = T.nearestNote(hz); return nn ? `${hz} Hz is closest to <b>${nn.label}</b> (${nn.hz.toFixed(2)} Hz, ${nn.cents >= 0 ? '+' : ''}${nn.cents.toFixed(0)} cents)` : 'Enter a note like A4 or a frequency'; } },
    { id: 'i2c', name: 'I²C address directory', fields: [['q', 'Address (0x3C) or chip name (BME280)', '']],
      run: (v) => { const q = String(v.q).trim().toLowerCase(); const rows = Object.entries(U.I2C_KNOWN).filter(([a, n]) => !q || ('0x' + Number(a).toString(16)).toLowerCase() === q.replace(/^0x0*/, '0x') || String(n).toLowerCase().includes(q));
        return rows.length ? calcTable(rows.map(([a, n]) => [`<code>0x${Number(a).toString(16).toUpperCase().padStart(2, '0')}</code>`, esc(n)]), ['Address', 'Usually']) : 'Not in the directory'; } },
    { id: 'crc', name: 'CRC / checksums', fields: [['data', 'Data', '123456789'], ['mode', 'Data is', 'Text', ['Text', 'Hex bytes']]],
      run: (v) => { const bytes = T.parseBytes(v.data, v.mode === 'Text' ? 'text' : 'hex'); if (!bytes) return 'Hex needs pairs of digits (01 A0 FF)';
        return `${bytes.length} byte${bytes.length === 1 ? '' : 's'}` + calcTable(T.crcAll(bytes).map((c) => [c.name, `<code>${c.value}</code>`, c.note || ''])); } }
  );

  // ---- PCB layout view ---------------------------------------------------------------
  var pcbInited = false;
  function setPcbMode(on) {
    const host = $('pcbHost');
    if (!host) return;
    if (on && !$('wiringHost').classList.contains('hidden')) {
      $('wiringHost').classList.add('hidden'); $('actWiring').classList.remove('on');
    }
    host.classList.toggle('hidden', !on);
    $('editor').classList.toggle('hidden', on || !$('wiringHost').classList.contains('hidden'));
    $('actPcb').classList.toggle('on', on);
    // the board gets the whole window unless the panels were asked back (Panels button)
    document.body.classList.toggle('pcb-full', on && localStorage.getItem('ec_pcb_panels') !== '1');
    if (!on) setTimeout(() => S.editor && S.editor.layout(), 30);
    if (on) { $('welcome').classList.add('hidden'); if (!S.project) toast('Open a project, wire parts on the canvas, then lay out the board here', 3500); }
    else if (!S.activeTab && $('wiringHost').classList.contains('hidden')) showWelcome(true);
    if (on && !pcbInited) {
      pcbInited = true;
      ElectriCADPcbView.init(host, {
        api, toast,
        getProjectDir: () => (S.project ? S.project.dir : ''),
        getBoardDef: () => PINODE_BOARDS[S.boardDefId],
        getBoardId: () => S.boardDefId,
        onFilesChanged: () => refreshTree()
      });
    } else if (on) ElectriCADPcbView.onShow();
  }
  function pcbActive() { return !!$('pcbHost') && !$('pcbHost').classList.contains('hidden'); }
  if ($('actPcb')) $('actPcb').addEventListener('click', () => setPcbMode(!pcbActive()));
  // the other views turn the board view off
  document.querySelectorAll('.act[data-view]').forEach((b) => b.addEventListener('click', () => pcbActive() && setPcbMode(false)));

  // Gerber preview: read back what was written, layer by layer
  const GLAYERS = [
    ['outline', 'Outline', '#e8e8e8'], ['bottom-copper', 'Bottom copper', '#3d7bd9'], ['bottom-mask', 'Bottom mask', '#2d6a3e'],
    ['bottom-silk', 'Bottom silk', '#bbbbbb'], ['top-copper', 'Top copper', '#d9733d'], ['top-mask', 'Top mask', '#2e8b57'],
    ['top-paste', 'Top paste', '#9a9a9a'], ['top-silk', 'Top silk', '#ffffff'], ['drill', 'Drill', '#111111']
  ];
  async function gerberPreview(zipPath) {
    const files = await api.file.zipList(zipPath).catch((e) => (toast('Could not read ' + baseName(zipPath) + ': ' + e.message, 4000), null));
    if (!files) return;
    const layers = {};
    // inner copper layers each get their own row, in file order (In1, In2, …)
    const INNER_COL = ['#d9a53d', '#b45cd6', '#3fbf9f', '#9cc23f', '#d95c8a', '#5cc8d9'];
    const inner = files.filter((f) => PCB.layerOf(f.name, f.text) === 'inner-copper').sort((a, b) => {
      const n = (x) => Number((/In(\d+)[._]Cu/i.exec(x.name) || /\.g(\d+)$/i.exec(x.name) || [0, 99])[1]);
      return n(a) - n(b);
    });
    const glayers = GLAYERS.slice();
    inner.slice().reverse().forEach((f, ri) => {
      const i = inner.length - 1 - ri, k = 'inner-copper:' + i;
      layers[k] = { g: PCB.parseGerber(f.text), files: [f.name] };
      glayers.splice(glayers.findIndex((x) => x[0] === 'top-copper'), 0, [k, 'Inner ' + (i + 1) + ' copper', INNER_COL[i % INNER_COL.length]]);
    });
    for (const f of files) {
      const l = PCB.layerOf(f.name, f.text);
      if (!l || l === 'inner-copper') continue;
      if (l === 'drill') { const d = PCB.parseExcellon(f.text); (layers.drill = layers.drill || { holes: [], files: [] }).holes.push(...d.holes); layers.drill.files.push(f.name); continue; }
      layers[l] = { g: PCB.parseGerber(f.text), files: [f.name] };
    }
    const chk = PCB.checkGerbers(files);
    const box = infoDialog('Gerber preview — ' + baseName(zipPath), `<div class="gp-wrap"><canvas class="gp-cv" width="${Math.round(Math.max(760, Math.min(1500, window.innerWidth * 0.66)))}" height="${Math.round(Math.max(520, Math.min(980, window.innerHeight * 0.68)))}"></canvas>
      <div class="gp-side"><div class="gp-layers">${glayers.filter(([k]) => layers[k]).map(([k, n, c]) => `<label><input type="checkbox" data-k="${k}" ${k.includes('mask') || k.includes('paste') || k.startsWith('inner') ? '' : 'checked'}> <span class="swatch" style="background:${c}"></span>${n}</label>`).join('')}</div>
      <label class="gp-flip"><input type="checkbox" class="gp-bottom"> View from the bottom</label>
      <div class="gp-sum">${gerberSummary(chk)}</div></div></div>
      <p class="dim">Drawn from the files themselves, the way a fab's viewer reads them.</p>`);
    box.classList.add('wide-modal');
    const cv = box.querySelector('.gp-cv');
    const g = cv.getContext('2d');
    const ext = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
    for (const l of Object.values(layers)) if (l.g && isFinite(l.g.ext.x1)) { ext.x1 = Math.min(ext.x1, l.g.ext.x1); ext.y1 = Math.min(ext.y1, l.g.ext.y1); ext.x2 = Math.max(ext.x2, l.g.ext.x2); ext.y2 = Math.max(ext.y2, l.g.ext.y2); }
    if (!isFinite(ext.x1)) { g.fillStyle = '#888'; g.fillText('No drawable layers in this zip', 20, 30); return; }
    const draw = () => {
      const W = cv.width, H = cv.height, pad = 20;
      const z = Math.min((W - 2 * pad) / (ext.x2 - ext.x1), (H - 2 * pad) / (ext.y2 - ext.y1));
      const flip = box.querySelector('.gp-bottom').checked;
      const ox = (W - (ext.x2 - ext.x1) * z) / 2, oy = (H - (ext.y2 - ext.y1) * z) / 2;
      const X = (x) => flip ? W - (ox + (x - ext.x1) * z) : ox + (x - ext.x1) * z;
      const Y = (y) => H - (oy + (y - ext.y1) * z);
      g.fillStyle = '#14301e'; g.fillRect(0, 0, W, H);
      const on = new Set([...box.querySelectorAll('.gp-layers input')].filter((c) => c.checked).map((c) => c.dataset.k));
      const inK = glayers.map(([k]) => k).filter((k) => k.startsWith('inner'));
      let order = glayers.map(([k]) => k);
      if (flip) order = ['outline', 'top-copper', 'top-mask', 'top-silk', 'top-paste'].concat(inK, ['bottom-copper', 'bottom-mask', 'bottom-silk', 'drill']);
      // each layer is drawn on its own sheet, so a plane's clearances only cut that layer
      const sheet = gerberPreview._sheet || (gerberPreview._sheet = document.createElement('canvas'));
      sheet.width = W; sheet.height = H;
      const g0 = g;
      for (const k of order) {
        if (!on.has(k) || !layers[k]) continue;
        const col = glayers.find((x) => x[0] === k)[2];
        const L = layers[k];
        const alpha = k.includes('mask') ? 0.45 : k.startsWith('inner') ? 0.6 : k.includes('copper') && flip !== k.startsWith('bottom') ? 0.55 : 1;
        g0.globalAlpha = alpha;
        if (k === 'drill') {
          g0.fillStyle = '#0b0b0b';
          for (const h of L.holes) { g0.beginPath(); g0.arc(X(h.x), Y(h.y), Math.max(0.8, h.d * z / 2), 0, Math.PI * 2); g0.fill(); }
          continue;
        }
        const g = sheet.getContext('2d');
        g.globalCompositeOperation = 'source-over'; g.clearRect(0, 0, W, H);
        g.lineCap = 'round'; g.lineJoin = 'round';
        for (const p of L.g.prims) {
          g.globalCompositeOperation = p.dark === false ? 'destination-out' : 'source-over';
          g.strokeStyle = g.fillStyle = col;
          if (p.k === 'line') { g.lineWidth = Math.max(1, p.w * z); g.beginPath(); g.moveTo(X(p.x1), Y(p.y1)); g.lineTo(X(p.x2), Y(p.y2)); g.stroke(); }
          else if (p.k === 'poly') { g.beginPath(); p.pts.forEach(([a, b], i) => (i ? g.lineTo(X(a), Y(b)) : g.moveTo(X(a), Y(b)))); g.closePath(); g.fill(); }
          else if (p.k === 'flash') {
            const w = p.ap.w * z, h = p.ap.h * z;
            g.beginPath();
            if (p.ap.type === 'C') g.arc(X(p.x), Y(p.y), Math.max(0.6, w / 2), 0, Math.PI * 2);
            else if (p.ap.type === 'O') { const r = Math.min(w, h) / 2; g.roundRect ? g.roundRect(X(p.x) - w / 2, Y(p.y) - h / 2, w, h, r) : g.rect(X(p.x) - w / 2, Y(p.y) - h / 2, w, h); }
            else g.rect(X(p.x) - w / 2, Y(p.y) - h / 2, w, h);
            g.fill();
          }
        }
        g.globalCompositeOperation = 'source-over';
        g0.drawImage(sheet, 0, 0);
      }
      g.globalAlpha = 1;
      g.fillStyle = '#9fb'; g.font = '12px sans-serif';
      g.fillText(`${(ext.x2 - ext.x1).toFixed(1)} × ${(ext.y2 - ext.y1).toFixed(1)} mm${flip ? ' · bottom view (mirrored)' : ''}`, 8, H - 8);
    };
    box.querySelectorAll('input').forEach((c) => c.addEventListener('change', draw));
    draw();
  }
  window.electricadGerberPreview = gerberPreview;
  function gerberSummary(chk) {
    return `<div class="${chk.ok ? 'ok' : 'bad'}">${chk.ok ? '✓ Looks complete' : '✗ ' + esc(chk.problems.join('; '))}</div>
      <div>${chk.layers} copper layer${chk.layers === 1 ? '' : 's'}${chk.size ? ` · ${chk.size.w} × ${chk.size.h} mm` : ''} · ${chk.holes} hole${chk.holes === 1 ? '' : 's'}${chk.minDrill != null ? `, smallest ${chk.minDrill.toFixed(2)} mm` : ''}</div>
      ${chk.notes.map((n) => `<div class="dim">• ${esc(n)}</div>`).join('')}`;
  }
  // Order PCB from any Gerber zip (made here or in KiCad/EasyEDA/Eagle)
  async function orderFromZip(zipPath) {
    if (!zipPath) zipPath = await api.project.pickFile({ filters: [{ name: 'Gerber zip', extensions: ['zip'] }] });
    if (!zipPath) return;
    const files = await api.file.zipList(zipPath).catch((e) => (toast(e.message, 4000), null));
    if (!files) return;
    const chk = PCB.checkGerbers(files);
    const box = infoDialog('Order boards — ' + baseName(zipPath), `${gerberSummary(chk)}
      <p class="dim">Pick a maker: ElectriCAD opens their upload page and shows the zip in Explorer, so you drag it across. Nothing is uploaded or ordered by ElectriCAD.</p>
      <div class="maker-list">${PCB.MAKERS.map((m) => `<button class="action maker" data-id="${m.id}"><b>${esc(m.name)}</b><span class="dim2">${esc(m.accepts)}</span></button>`).join('')}</div>`);
    box.classList.add('wide-modal');
    const pv = document.createElement('button'); pv.className = 'action'; pv.textContent = 'Preview layers';
    pv.addEventListener('click', () => gerberPreview(zipPath));
    box.querySelector('.modal-btns').prepend(pv);
    box.querySelectorAll('.maker').forEach((b) => b.addEventListener('click', () => {
      const m = PCB.MAKERS.find((x) => x.id === b.dataset.id);
      api.openExternal(m.url); api.file.reveal(zipPath);
      toast(`Opened ${m.name}. Drag ${baseName(zipPath)} onto their upload box.`, 6000);
    }));
  }
  async function canvasNet() {
    if (!S.project) { toast('Open a project first'); return null; }
    const raw = await api.file.read(joinPath(S.project.dir, 'wiring.json')).catch(() => null);
    if (!raw) { toast('No wiring yet: place and wire parts on the canvas first', 3000); return null; }
    let model;
    try { model = JSON.parse(raw); } catch (e) { toast('wiring.json is damaged: ' + e.message, 4000); return null; }
    const net = PCB.netlist(model, PINODE_BOARDS[S.boardDefId], S.boardDefId, PinodeParts.PARTS);
    if (!net.comps.length) { toast('The canvas has no parts that go on a board', 3000); return null; }
    return net;
  }
  async function writeFab(name, text) {
    const dir = joinPath(S.project.dir, 'fab');
    await api.file.mkdir(dir).catch(() => {});
    const p = joinPath(dir, name);
    await api.file.write(p, text);
    refreshTree();
    return p;
  }
  async function exportBom() {
    const net = await canvasNet();
    if (!net) return;
    palette([['generic', 'Generic BOM (CSV, with LCSC / Digi-Key / Mouser search links)'], ['jlcpcb', 'JLCPCB assembly BOM'], ['pcbway', 'PCBWay assembly BOM']].map(([k, label]) => ({
      label: '🧾 ' + label,
      run: async () => {
        const p = await writeFab(S.project.manifest.name + '-bom' + (k === 'generic' ? '' : '-' + k) + '.csv', PCB.bomCsv(net, k));
        toast('Saved fab\\' + baseName(p) + (k !== 'generic' ? '. Fill in the LCSC / MPN column: ElectriCAD never guesses part numbers.' : ''), 4500);
        openFile(p);
      }
    })), 'Bill of materials');
  }
  async function exportNetlist() {
    const net = await canvasNet();
    if (!net) return;
    palette([
      { label: '🔗 KiCad netlist (.net, import into Pcbnew)', run: async () => { const p = await writeFab(S.project.manifest.name + '.net', PCB.kicadNetlist(net, S.project.manifest.name)); toast('Saved fab\\' + baseName(p)); api.file.reveal(p); } },
      { label: '🔗 CSV netlist (net, ref, pad)', run: async () => { const p = await writeFab(S.project.manifest.name + '-netlist.csv', PCB.netlistCsv(net)); toast('Saved fab\\' + baseName(p)); openFile(p); } }
    ], 'Netlist');
  }
  async function exportCpl() {
    if (!S.project) return toast('Open a project first');
    setPcbMode(true);
    const st = ElectriCADPcbView._state();
    if (!st.L || !st.net.comps.length) return toast('Lay out the board in the PCB tab first: pick-and-place needs part positions', 3500);
    for (const k of ['jlcpcb', 'pcbway']) await writeFab(S.project.manifest.name + '-cpl-' + k + '.csv', PCB.cplCsv(st.L, st.net, k));
    toast('Saved fab\\…-cpl-jlcpcb.csv and …-cpl-pcbway.csv (positions in mm from the board\'s bottom-left corner)', 4500);
  }
  async function manufacturing() {
    const net = S.project ? await canvasNet() : null;
    const fabDir = S.project ? joinPath(S.project.dir, 'fab') : '';
    const zip = S.project ? joinPath(fabDir, S.project.manifest.name + '-gerbers.zip') : '';
    const haveZip = zip && await api.file.exists(zip).catch(() => false);
    const st = pcbInited ? ElectriCADPcbView._state() : null;
    const routed = st && st.issues ? st.issues.filter((x) => x.severity === 'error').length : null;
    const box = infoDialog('Manufacturing', `<div class="mfg">
      <div class="mfg-row ${net ? 'good' : ''}"><b>1. Circuit</b><span>${net ? `${net.comps.length} parts, ${net.nets.length} nets from the canvas` : 'Wire parts on the canvas first'}</span></div>
      <div class="mfg-row ${st && st.net && st.net.comps.length ? (routed ? '' : 'good') : ''}"><b>2. Board layout</b><span>${st && st.net && st.net.comps.length ? (routed ? routed + ' design-rule problems left' : 'Laid out, no design-rule errors') : 'Open the PCB tab to place and route'}</span></div>
      <div class="mfg-row ${haveZip ? 'good' : ''}"><b>3. Fab files</b><span>${haveZip ? 'fab\\' + esc(baseName(zip)) : 'Not exported yet'}</span></div>
      <div class="mfg-row"><b>4. Order</b><span>Opens the maker's page with the zip ready to drag in. Nothing is uploaded for you.</span></div></div>`);
    box.classList.add('wide-modal');
    const btns = box.querySelector('.modal-btns');
    const add = (label, fn, cls) => { const b = document.createElement('button'); b.className = 'action ' + (cls || ''); b.textContent = label; b.addEventListener('click', () => { box.parentElement.remove(); fn(); }); btns.prepend(b); };
    add('Check a Gerber zip…', () => orderFromZip());
    if (net) { add('BOM…', exportBom); add('Netlist…', exportNetlist); }
    if (haveZip) add('Preview', () => gerberPreview(zip));
    add('Open the PCB tab', () => setPcbMode(true), 'primary');
  }

  // ---- application menu → commands -------------------------------------------
  const COMMANDS = {
    newSketch: () => newProject('arduino'),
    newPi: () => newProject('pi'),
    newMicroPython: () => newProject('micropython'),
    newCircuitPython: () => newProject('circuitpython'),
    upyRun, upyStop, upySoftReset, upyUpload, upyFiles, upyInfo,
    exportBinary, libZip, libUpgradeAll, coreUpgradeAll,
    git: () => document.querySelector('.act[data-view="git"]').click(),
    examples: chooseExample,
    openProject: chooseProject,
    openFolder,
    newFile: () => (S.project ? newFileIn(S.project.dir) : toast('Open a project first')),
    save: saveActive,
    saveAll: () => saveAll(),
    closeTab: () => S.activeTab && closeTab(S.activeTab),
    settings: () => document.querySelector('.act[data-view="settings"]').click(),
    findInProject,
    palette: mainPalette,
    verify: () => verify(),
    upload,
    cancelBuild,
    selectBoard: chooseBoard,
    devices: deviceMenu,
    addTelemetry,
    revealProject,
    'panel:serial': () => showPanel('serial'),
    'panel:plotter': () => showPanel('plotter'),
    'panel:timeline': () => showPanel('timeline'),
    'panel:i2c': () => showPanel('i2c'),
    resetBoard,
    wiring: () => setWiringMode($('wiringHost').classList.contains('hidden')),
    catalog: () => document.querySelector('.act[data-view="catalog"]').click(),
    reportBug: () => reportBug({}),
    libs: () => libSearch(),
    connectPi,
    closePorts: () => api.serial.close(),
    toggleSide: () => togglePane('side'),
    toggleBottom: () => togglePane('bottom'),
    toggleRight: () => togglePane('right'),
    fontUp: () => setFontSize(((S.settings && S.settings.editorFontSize) || 14) + 1),
    fontDown: () => setFontSize(((S.settings && S.settings.editorFontSize) || 14) - 1),
    fontReset: () => setFontSize(14),
    reload: async () => { await saveAll(true); if (!S.openTabs.some((t) => t.dirty)) api.app.reload(); },
    shortcuts: showShortcuts,
    telemetryHelp: showTelemetryHelp,
    about: showAbout,
    // v0.8
    libExamples: libExamplesMenu, newClass, quickOpen, format: formatActive,
    toggleComment: () => editorAction('editor.action.commentLine'),
    find: () => editorAction('actions.find'),
    replace: () => editorAction('editor.action.startFindReplaceAction'),
    gotoLine: () => editorAction('editor.action.gotoLine'),
    todos: todoList,
    closeOthers: () => closeOthers(), closeAll, reopenTab,
    nextTab: () => cycleTab(1), prevTab: () => cycleTab(-1),
    exportSettings, importSettings,
    cleanBuild: () => verify({ clean: true }),
    uploadProgrammer, burnBootloader, boardOptions, boardInfo, includeLib,
    pinCheck: () => pinCheckReport(false),
    upyRunSel, upyDownloadAll, upySetClock, cpyOpenDrive,
    serialSendFile, serialMacros, serialCopy,
    calc: () => showCalculators(), pinout: showPinout,
    toggleTheme, zen,
    wordWrap: () => toggleEditorSetting('wordWrap', 'Word wrap'),
    minimap: () => toggleEditorSetting('minimap', 'Minimap'),
    // v0.9
    pcb: () => setPcbMode(!pcbActive()), manufacturing, orderFromZip: () => orderFromZip(),
    gerberPreview: async () => { const p = await api.project.pickFile({ filters: [{ name: 'Gerber zip', extensions: ['zip'] }] }); if (p) gerberPreview(p); },
    exportBom, exportNetlist, exportCpl,
    localHistory, compareWithSaved, compareFiles, replaceInProject, markdownPreview, imageToC,
    sortLines: () => editorAction('editor.action.sortLinesAscending'),
    sortLinesDesc: () => editorAction('editor.action.sortLinesDescending'),
    upperCase: () => editorAction('editor.action.transformToUppercase'),
    lowerCase: () => editorAction('editor.action.transformToLowercase'),
    joinLines: () => editorAction('editor.action.joinLines'),
    duplicateSelection: () => editorAction('editor.action.duplicateSelection'),
    deleteLine: () => editorAction('editor.action.deleteLines'),
    jumpBracket: () => editorAction('editor.action.jumpToBracket'),
    goToSymbol: () => editorAction('editor.action.quickOutline'),
    goToDefinition: () => editorAction('editor.action.revealDefinition'),
    columnSelection: toggleColumnSelection, arduinoReference,
    multiBuild, buildFlags, openBuildFolder, uploadLast: () => upload({ lastBuild: true }),
    libVersion: () => libVersionInstall(), libDetails,
    archiveProject, renameProject, duplicateProject, datasheet,
    upyUploadCurrent, upyMkdir, pyFirmware,
    aiGenerate, aiSaveChat,
    guide: showGuide, whatsNew: () => showWhatsNew(appVersion), resetSettings
  };
  api.on('menu:command', (id) => {
    const fn = COMMANDS[id];
    if (!fn) return;
    // the editor's own Ctrl+F etc. keep working; menu commands while a modal
    // dialog is open are ignored so a dialog can't be stacked under itself
    if (document.querySelector('.modal-overlay') && id !== 'save') return;
    Promise.resolve().then(fn).catch((e) => toast(e.message || String(e), 4000));
  });

  // ---- closing with unsaved work ---------------------------------------------
  api.on('app:closeRequest', async () => {
    api.app.closeAck();
    const dirty = S.openTabs.filter((t) => t.dirty);
    if (!dirty.length) { await api.file.hotClear().catch(() => {}); return api.app.confirmClose(); }
    const choice = await confirmDialog('Unsaved changes',
      `${dirty.length} file${dirty.length === 1 ? ' has' : 's have'} unsaved changes: ${dirty.map((t) => t.name).join(', ')}`,
      [{ label: 'Cancel', value: 'cancel' }, { label: 'Don\'t save', value: 'discard', danger: true },
       { label: 'Save all & quit', value: 'save', primary: true }]);
    if (choice === 'save') {
      await saveAll(true);
      if (S.openTabs.some((t) => t.dirty)) return toast('Some files could not be saved, so ElectriCAD stayed open', 5000);
      await api.file.hotClear().catch(() => {});
      api.app.confirmClose();
    }
    else if (choice === 'discard') { await api.file.hotClear().catch(() => {}); api.app.confirmClose(); }
  });

  // ---- top bar wiring ------------------------------------------------------
  $('btnProject').addEventListener('click', chooseProject);
  $('btnBoard').addEventListener('click', chooseBoard);
  $('btnPort').addEventListener('click', deviceMenu);
  $('btnVerify').addEventListener('click', () => verify());
  $('btnUpload').addEventListener('click', upload);
  $('btnCancel').addEventListener('click', cancelBuild);
  $('btnPalette').addEventListener('click', mainPalette);
  // fullscreen first: the title bar is gone then, so minimise and close live in the top bar
  $('btnFull').addEventListener('click', () => api.app.win('fullscreen'));
  $('btnMin').addEventListener('click', () => api.app.win('minimize'));
  $('btnClose').addEventListener('click', () => api.app.win('close'));
  api.on('win:fullscreen', (on) => { document.body.classList.toggle('is-fullscreen', !!on); $('btnFull').title = on ? 'Leave full screen (F11)' : 'Full screen (F11)'; setTimeout(() => S.editor && S.editor.layout(), 50); });
  $('btnNewProject').addEventListener('click', () => newProject('arduino'));
  $('btnRefreshTree').addEventListener('click', refreshTree);
  $('btnNewFile').addEventListener('click', () => (S.project ? newFileIn(S.project.dir) : toast('Open a project first')));

  api.on('toolchain:progress', ({ step, detail }) => {
    $('stToolchain').textContent = 'toolchain: ' + detail;
    if (step === 'ready') setTimeout(() => { $('stToolchain').textContent = 'toolchain: ready'; }, 1500);
  });

  // ---- boot ----------------------------------------------------------------
  (async function boot() {
    S.settings = await api.settings.get();
    const ser = S.settings.serial || {};
    S.serial.timestamps = !!ser.timestamps;
    S.serial.tsMode = ser.tsMode === 'delta' ? 'delta' : 'clock';
    S.serial.autoscroll = ser.autoscroll !== false;
    $('serialTs').classList.toggle('on', S.serial.timestamps);
    if (S.serial.timestamps && S.serial.tsMode === 'delta') $('serialTs').textContent = 'Δt';
    $('serialScroll').classList.toggle('on', S.serial.autoscroll);
    $('serialEnding').value = ser.lineEnding || 'lf';
    $('serialBaud').value = String(S.settings.serialBaud || 115200);
    SERIAL_MAX = Number(ser.maxLines) || 5000;
    applyTheme(S.settings.theme);
    applyLook();
    // board view selector
    for (const def of Object.values(PINODE_BOARDS)) {
      const opt = document.createElement('option');
      opt.value = def.id; opt.textContent = def.name;
      $('boardViewSelect').appendChild(opt);
    }
    await initMonaco();
    try { initLanguageExtras(); } catch (e) { console.error(e); }
    initSplitters();
    for (const p of ['side', 'bottom', 'right']) {
      try { if (localStorage.getItem('ec_pane_' + p) === '0') togglePane(p, false); } catch (e) {}
    }
    setBoardView('uno');
    renderI2c();
    setInterval(drawPlotter, 120);
    setInterval(drawTimeline, 200);
    api.toolchain.ensure().catch((e) => toast('Toolchain: ' + e.message, 5000));
    api.devices.list().then((list) => { S.devices = list || []; renderDeviceChip(); }).catch(() => {});
    updateTitle();
    if (S.settings.lastFqbn) setFqbn(S.settings.lastFqbn);
    // restore last project (its manifest board wins over lastFqbn)
    if (S.settings.lastProject && S.settings.openLast !== false) {
      try { await loadProject(await api.project.open(S.settings.lastProject)); } catch (e) {}
    }
    renderTree();
    if (!S.activeTab) showWelcome(true);
    await offerHotExit();
    maybeWhatsNew();
  })();
})();
