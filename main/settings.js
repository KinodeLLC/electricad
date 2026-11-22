// Flat JSON settings store in the user's app-data dir. Synchronous on purpose:
// it's tiny, and every consumer wants it at require-time.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const FILE = () => path.join(app.getPath('userData'), 'electricad-settings.json');
const LEGACY_FILE = () => path.join(app.getPath('userData'), 'pinode-settings.json');

const DEFAULTS = {
  projectsDir: '',            // set on first run
  theme: 'dark',
  editorFontSize: 14,
  editor: {
    wordWrap: false,
    minimap: true,
    autoSave: true,           // save dirty tabs ~1.5s after typing stops
    formatOnSave: false,
    tabSize: 2,
    autoClose: true,          // brackets and quotes
    cursorStyle: 'line',      // line | block | underline
    lineNumbers: 'on',        // on | relative | off
    guides: true,             // indentation guides
    smoothCaret: false,
    fontFamily: '',           // '' = Cascadia Code / Consolas fallback chain
    saveOnBlur: false         // save every dirty tab when the window loses focus
  },
  telemetryHz: 20,
  serialBaud: 115200,
  serial: {
    lineEnding: 'lf',         // none | lf | cr | crlf
    timestamps: false,
    autoscroll: true
  },
  window: {},
  lastProject: '',
  lastFqbn: '',
  lastPort: '',
  pi: { host: '', port: 8888 },
  ai: {
    provider: 'anthropic',    // anthropic | openai | ollama | custom
    baseUrl: '',              // custom/openai-compatible endpoint
    apiKey: '',
    model: '',
    maxTokens: 8192
  },
  git: { autoFetch: false },
  recentProjects: [],
  pinnedProjects: [],
  boardUrls: [],              // extra board-manager index URLs (third-party cores)
  accent: 'orange',           // orange | blue | green | purple
  density: 'normal',          // normal | compact
  iconSize: 'large',          // large (with labels) | normal
  openLast: true,             // reopen the last project on start
  notifications: true,        // desktop notification when a long build finishes
  lastSeenVersion: ''
};

let cache = null;

// defaults fill in nested objects too, so a settings file written by an older
// version still gets every new knob (editor.*, serial.*) with a sane value
function withDefaults(saved) {
  const out = { ...DEFAULTS, ...saved };
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && saved && saved[k] && typeof saved[k] === 'object') {
      out[k] = { ...v, ...saved[k] };
    }
  }
  return out;
}

function load() {
  if (cache) return cache;
  try {
    cache = withDefaults(JSON.parse(fs.readFileSync(FILE(), 'utf8')));
  } catch (e) {
    // migrate from the old pinode-settings.json (API keys, projects dir…)
    try {
      cache = withDefaults(JSON.parse(fs.readFileSync(LEGACY_FILE(), 'utf8')));
      save();
      try { fs.unlinkSync(LEGACY_FILE()); } catch (e2) {}
    } catch (e3) {
      cache = withDefaults({});
    }
  }
  if (!cache.projectsDir) {
    cache.projectsDir = path.join(app.getPath('documents'), 'ElectriCAD');
  }
  return cache;
}

function save() {
  try { fs.mkdirSync(path.dirname(FILE()), { recursive: true }); } catch (e) {}
  // temp + rename: a crash mid-write can't truncate the settings (API keys!)
  const tmp = FILE() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
  try { fs.renameSync(tmp, FILE()); } catch (e) { fs.writeFileSync(FILE(), JSON.stringify(cache, null, 2), 'utf8'); }
}

module.exports = {
  all() { return load(); },
  // back to defaults, keeping what a user would never want wiped: where the
  // projects live, the recent/pinned lists, the AI key, the Pi address, git
  reset() {
    const old = load();
    const keep = {};
    for (const k of ['projectsDir', 'recentProjects', 'pinnedProjects', 'lastProject', 'lastFqbn', 'lastPort', 'ai', 'pi', 'git', 'window', 'lastSeenVersion']) {
      if (old[k] !== undefined) keep[k] = old[k];
    }
    cache = withDefaults(keep);
    save();
    return cache;
  },
  get(k) { return load()[k]; },
  set(patch) {
    load();
    // one level of merge for nested objects (ai, pi, git, editor, serial)
    for (const [k, v] of Object.entries(patch || {})) {
      if (v && typeof v === 'object' && !Array.isArray(v) && cache[k] && typeof cache[k] === 'object' && !Array.isArray(cache[k])) {
        cache[k] = { ...cache[k], ...v };
      } else {
        cache[k] = v;
      }
    }
    save();
    return cache;
  }
};
