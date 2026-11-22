// Native AI: bring your own key or point at local Ollama.
// The differentiator is context — the model sees the code AND the hardware:
// live pin snapshot, serial tail, last build diagnostics, board identity.
// Streaming via the provider's SSE, re-emitted to the renderer in chunks.
const settings = require('./settings');

let inflight = null;

const SYSTEM = `You are ElectriCAD's built-in hardware copilot, embedded in an IDE for Arduino and Raspberry Pi.
You can see the user's code, their board, LIVE pin states sampled from the physical hardware, recent serial output, and compiler diagnostics.
Ground every answer in that telemetry when it is present — it is the actual state of the physical board, more trustworthy than assumptions from code.
Pin state legend: mode in/out/pwm, level 0/1, pwm 0-255 duty. Analog values are raw ADC counts.
Be concrete and terse. When writing code, write complete working sketches or complete functions, not fragments. When diagnosing, name the exact pin and the exact line.`;

function contextBlock(ctx) {
  const parts = [];
  if (ctx.board) parts.push(`Board: ${ctx.board}`);
  if (ctx.fileName) parts.push(`Open file: ${ctx.fileName}\n\`\`\`\n${(ctx.code || '').slice(0, 24000)}\n\`\`\``);
  if (ctx.pins && ctx.pins.length) {
    const live = ctx.pins.map((p) =>
      `pin ${p.label || p.pin}: ${p.mode}${p.mode === 'pwm' ? ' duty=' + p.pwm : ''} level=${p.level}`).join('; ');
    parts.push(`LIVE pin states (right now, from hardware): ${live}`);
  }
  if (ctx.analog && ctx.analog.length) parts.push(`Analog reads: ${ctx.analog.map((v, i) => 'A' + i + '=' + v).join(' ')}`);
  if (ctx.serialTail) parts.push(`Recent serial output:\n${ctx.serialTail.slice(-4000)}`);
  if (ctx.diagnostics && ctx.diagnostics.length) {
    parts.push('Compiler diagnostics:\n' + ctx.diagnostics.map((d) =>
      `${d.severity} ${d.file}:${d.line}:${d.col} ${d.message}`).join('\n'));
  }
  return parts.join('\n\n');
}

// long chats would resend everything forever; keep the recent turns (the
// live workspace context is re-attached fresh on every request anyway)
const MAX_TURNS = 24;
function trimHistory(messages) {
  const clean = (messages || []).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content);
  let out = clean.slice(-MAX_TURNS);
  while (out.length && out[0].role !== 'user') out = out.slice(1);
  return out;
}

async function chat({ messages, context }, onChunk) {
  const cfg = settings.get('ai') || {};
  messages = trimHistory(messages);
  if (!messages.length) return { ok: false, error: 'Nothing to send.' };
  if (cfg.provider === 'anthropic' && !cfg.apiKey) {
    return { ok: false, error: 'No Anthropic API key yet — add one in Settings (⚙) → AI API key, or switch the provider to Ollama for a local model.' };
  }
  const ctl = new AbortController();
  inflight = ctl;

  const sys = SYSTEM + (context ? '\n\n=== CURRENT WORKSPACE ===\n' + contextBlock(context) : '');
  try {
    if (cfg.provider === 'anthropic') return await anthropic(cfg, sys, messages, onChunk, ctl);
    return await openaiCompatible(cfg, sys, messages, onChunk, ctl); // openai | ollama | custom
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, aborted: true };
    return { ok: false, error: e.message };
  } finally {
    if (inflight === ctl) inflight = null;
  }
}

async function anthropic(cfg, system, messages, onChunk, ctl) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: ctl.signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.apiKey || '',
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: cfg.model || 'claude-opus-5-5',
      max_tokens: Number(cfg.maxTokens) || 16000,
      system,
      stream: true,
      messages: messages.map((m) => ({ role: m.role, content: m.content }))
    })
  });
  if (!res.ok) throw new Error('Anthropic API ' + res.status + ': ' + (await res.text()).slice(0, 300));
  let full = '', stop = null, streamErr = null;
  await readSse(res, (data) => {
    try {
      const j = JSON.parse(data);
      if (j.type === 'content_block_delta' && j.delta && j.delta.type === 'text_delta' && j.delta.text) {
        full += j.delta.text;
        onChunk({ text: j.delta.text });
      } else if (j.type === 'message_delta' && j.delta && j.delta.stop_reason) {
        stop = j.delta.stop_reason;
      } else if (j.type === 'error') {
        streamErr = (j.error && j.error.message) || 'stream error';
      }
    } catch (e) {}
  }, ctl);
  if (streamErr && !full) throw new Error('Anthropic API: ' + streamErr);
  if (stop === 'max_tokens') {
    const note = '\n\n— (reply hit the length limit; ask me to continue)';
    full += note; onChunk({ text: note });
  } else if (stop === 'refusal' && !full) {
    full = 'The model declined this request.'; onChunk({ text: full });
  }
  return { ok: true, text: full };
}

async function openaiCompatible(cfg, system, messages, onChunk, ctl) {
  const base =
    cfg.provider === 'ollama' ? (cfg.baseUrl || 'http://127.0.0.1:11434/v1')
    : cfg.provider === 'openai' ? (cfg.baseUrl || 'https://api.openai.com/v1')
    : (cfg.baseUrl || '');
  if (!base) throw new Error('No AI endpoint configured — set one in Settings → AI');
  const headers = { 'content-type': 'application/json' };
  if (cfg.apiKey) headers.authorization = 'Bearer ' + cfg.apiKey;
  const res = await fetch(base.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    signal: ctl.signal,
    headers,
    body: JSON.stringify({
      model: cfg.model || (cfg.provider === 'ollama' ? 'llama3.1' : 'gpt-4o-mini'),
      stream: true,
      messages: [{ role: 'system', content: system },
                 ...messages.map((m) => ({ role: m.role, content: m.content }))]
    })
  });
  if (!res.ok) throw new Error('AI endpoint ' + res.status + ': ' + (await res.text()).slice(0, 300));
  let full = '';
  await readSse(res, (data) => {
    if (data === '[DONE]') return;
    try {
      const j = JSON.parse(data);
      const t = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
      if (t) { full += t; onChunk({ text: t }); }
    } catch (e) {}
  }, ctl);
  return { ok: true, text: full };
}

async function readSse(res, onData, ctl) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done || ctl.signal.aborted) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line.startsWith('data:')) onData(line.slice(5).trim());
    }
  }
}

function abort() {
  if (inflight) inflight.abort();
  return true;
}

module.exports = { chat, abort };
