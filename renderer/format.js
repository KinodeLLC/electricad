// Code formatter for Arduino/C/C++: re-indents by brace depth, outside of
// strings, chars and comments, the way Arduino IDE's Auto Format does.
// Never reorders or rewrites tokens, so it cannot change what compiles.
// Python is semantic indentation: there we only trim trailing whitespace.
(function (root) {
  'use strict';

  // scan one line, updating the lexer state; returns brace/paren deltas and
  // the "code only" text (strings/comments blanked) for pattern checks
  function scanLine(line, st) {
    let code = '';
    let opens = 0, closes = 0, lead = 0, parens = 0;
    let leading = true;          // still in the run of '}' at the line start
    for (let i = 0; i < line.length; i++) {
      const c = line[i], n = line[i + 1];
      if (st.block) {
        if (c === '*' && n === '/') { st.block = false; i++; }
        code += ' ';
        continue;
      }
      if (st.str) {
        if (c === '\\') { i++; code += '  '; continue; }
        if (c === st.str) st.str = null;
        code += ' ';
        continue;
      }
      if (c === '/' && n === '/') break;
      if (c === '/' && n === '*') { st.block = true; i++; code += '  '; continue; }
      if (c === '"' || c === "'") { st.str = c; code += c; leading = false; continue; }
      if (c === '}') { closes++; if (leading) lead++; }
      else if (!/\s/.test(c)) leading = false;
      if (c === '{') opens++;
      else if (c === '(') parens++;
      else if (c === ')') parens--;
      code += c;
    }
    // an unterminated '...' or "..." never spans lines in C (except with \)
    if (st.str && !/\\$/.test(line)) st.str = null;
    return { code, opens, closes, lead, parens };
  }

  function formatC(text, opts) {
    const unit = (opts && opts.useTabs) ? '\t' : ' '.repeat((opts && opts.tabSize) || 2);
    const eol = /\r\n/.test(text) ? '\r\n' : '\n';
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const out = [];
    const st = { block: false, str: null };
    const stack = [];            // one entry per open brace: { sw: isSwitch, inCase }
    let depth = 0;
    let paren = 0;               // open parens carried over from earlier lines
    let oneShot = 0;             // brace-less if/for/while/else body
    let pendingSwitch = false;
    let blank = 0;
    for (const raw of lines) {
      const startedInBlock = st.block;
      const trimmed = raw.trim();
      if (!trimmed) {
        if (startedInBlock) { out.push(''); continue; }
        blank++;
        if (blank <= 2) out.push('');
        continue;
      }
      blank = 0;
      const s = scanLine(trimmed, st);
      // preprocessor lines live in column 0
      if (!startedInBlock && /^#/.test(trimmed)) { out.push(trimmed); continue; }
      let d = depth - s.lead;
      const top = stack[stack.length - 1 - s.lead];
      const isCase = !startedInBlock && /^(case\b.*|default\s*):/.test(s.code.trim());
      if (top && top.sw && !s.lead) {
        if (isCase) top.inCase = true;
        else if (top.inCase) d++;
      }
      if (paren > 0) d++;
      if (oneShot && !/^\{/.test(trimmed)) d++;
      if (startedInBlock) {
        // keep the familiar " * " alignment inside block comments
        out.push(unit.repeat(Math.max(0, d)) + (/^\*/.test(trimmed) ? ' ' : '') + trimmed);
      } else {
        out.push(unit.repeat(Math.max(0, d)) + trimmed);
      }
      if (startedInBlock && !s.opens && !s.closes) continue;
      // update block structure
      const codeT = s.code.trim();
      if (/\bswitch\s*\(/.test(codeT)) pendingSwitch = true;
      // walk braces in order so "} else {" pops then pushes
      let sawOpen = false;
      for (const ch of s.code) {
        if (ch === '{') { stack.push({ sw: pendingSwitch, inCase: false }); pendingSwitch = false; depth++; sawOpen = true; }
        else if (ch === '}') { if (stack.length) stack.pop(); depth = Math.max(0, depth - 1); }
      }
      paren = Math.max(0, paren + s.parens);
      // brace-less control statement: the next line is its body
      if (oneShot && !sawOpen) oneShot = 0;
      if (!sawOpen && paren === 0 && /^(}\s*)?((else\s+)?if|for|while)\s*\(.*\)\s*$|^(}\s*)?else\s*$/.test(codeT)) oneShot = 1;
      else if (oneShot && paren === 0) oneShot = 0;
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    return out.join(eol) + eol;
  }

  function formatPython(text) {
    const eol = /\r\n/.test(text) ? '\r\n' : '\n';
    const lines = text.replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, ''));
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.join(eol) + eol;
  }

  function format(text, lang, opts) {
    if (lang === 'python') return formatPython(text);
    return formatC(text, opts);
  }

  const api = { format, formatC, formatPython };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ElectriCADFormat = api;
})(typeof window !== 'undefined' ? window : globalThis);
