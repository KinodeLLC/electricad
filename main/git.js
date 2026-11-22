// Git, through the git CLI the user already has (Git for Windows). Nothing
// here rewrites history or throws work away: init, status, diff, stage,
// commit, log, branch info. Anything destructive stays in the user's hands.
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

function git(cwd, args, input) {
  return new Promise((resolve) => {
    const child = execFile('git', args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } },
      (err, stdout, stderr) => resolve({ code: err ? (err.code === 'ENOENT' ? -1 : (err.code || 1)) : 0, out: stdout, err: stderr }));
    if (input != null) { child.stdin.write(input); child.stdin.end(); }
  });
}

async function available() {
  const r = await git(process.cwd(), ['--version']);
  return r.code === 0 ? r.out.trim() : null;
}

// porcelain v1 with branch header → structured status (pure, tested)
function parseStatus(text) {
  const out = { branch: '', upstream: '', ahead: 0, behind: 0, files: [] };
  for (const line of String(text || '').split('\n')) {
    if (!line) continue;
    if (line.startsWith('## ')) {
      const h = line.slice(3);
      const m = /^(?:No commits yet on )?([^.\s]+)(?:\.\.\.(\S+))?(?: \[(.*)\])?/.exec(h);
      if (m) {
        out.branch = m[1]; out.upstream = m[2] || '';
        const ab = m[3] || '';
        const a = /ahead (\d+)/.exec(ab), b = /behind (\d+)/.exec(ab);
        out.ahead = a ? Number(a[1]) : 0; out.behind = b ? Number(b[1]) : 0;
      }
      continue;
    }
    const x = line[0], y = line[1];
    let file = line.slice(3);
    let from = '';
    if (file.includes(' -> ')) [from, file] = file.split(' -> ');
    const unq = (s) => s.replace(/^"(.*)"$/, '$1');
    out.files.push({ path: unq(file), from: unq(from), staged: x !== ' ' && x !== '?', x, y,
      kind: x === '?' ? 'untracked' : (x === 'A' || y === 'A') ? 'added' : (x === 'D' || y === 'D') ? 'deleted'
          : (x === 'R') ? 'renamed' : (x === 'U' || y === 'U') ? 'conflict' : 'modified' });
  }
  return out;
}

function parseLog(text) {
  return String(text || '').split('\n').filter(Boolean).map((l) => {
    const [hash, date, author, ...subject] = l.split('\x1f');
    return { hash, short: hash.slice(0, 7), date, author, subject: subject.join('\x1f') };
  });
}

async function status(dir) {
  const r = await git(dir, ['status', '--porcelain=v1', '-b', '-uall']);
  if (r.code === -1) return { available: false };
  if (r.code !== 0) return { available: true, repo: false, error: r.err.trim() };
  return { available: true, repo: true, ...parseStatus(r.out) };
}

async function init(dir) {
  const r = await git(dir, ['init', '-b', 'main']);
  if (r.code !== 0) {
    const r2 = await git(dir, ['init']);   // git < 2.28 has no -b
    if (r2.code !== 0) throw new Error(r2.err.trim());
  }
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, 'build/\n.electricad-build/\n*.electricad-tmp\n__pycache__/\n');
  return status(dir);
}

async function diff(dir, file, staged) {
  const args = ['diff', '--no-color', '--no-ext-diff'];
  if (staged) args.push('--cached');
  args.push('--', file);
  const r = await git(dir, args);
  return r.out;
}

// the committed version of a file, for side-by-side diff in the editor
async function show(dir, file) {
  const rel = path.relative(dir, path.resolve(dir, file)).split(path.sep).join('/');
  const r = await git(dir, ['show', 'HEAD:' + rel]);
  return r.code === 0 ? r.out : '';
}

async function stage(dir, files) {
  const r = await git(dir, ['add', '-A', '--', ...(files && files.length ? files : ['.'])]);
  if (r.code !== 0) throw new Error(r.err.trim());
  return status(dir);
}
async function unstage(dir, files) {
  let r = await git(dir, ['restore', '--staged', '--', ...(files && files.length ? files : ['.'])]);
  if (r.code !== 0) r = await git(dir, ['reset', '-q', 'HEAD', '--', ...(files && files.length ? files : ['.'])]);
  return status(dir);
}

async function commit(dir, message, all) {
  if (!String(message || '').trim()) throw new Error('write a commit message first');
  if (all) await git(dir, ['add', '-A']);
  const r = await git(dir, ['commit', '-F', '-'], String(message));
  if (r.code !== 0) {
    const msg = (r.err + r.out).trim();
    if (/Please tell me who you are|user\.email/i.test(msg)) throw new Error('git doesn\'t know your name yet. Set it once in Settings → Git identity.');
    if (/nothing to commit/i.test(msg)) throw new Error('nothing to commit');
    throw new Error(msg.split('\n').slice(-3).join(' '));
  }
  return status(dir);
}

async function log(dir, n = 40) {
  const r = await git(dir, ['log', '-n', String(n), '--date=short', '--pretty=format:%H%x1f%ad%x1f%an%x1f%s']);
  return r.code === 0 ? parseLog(r.out) : [];
}

async function identity(dir) {
  const n = await git(dir, ['config', 'user.name']);
  const e = await git(dir, ['config', 'user.email']);
  return { name: n.out.trim(), email: e.out.trim() };
}
async function setIdentity(name, email) {
  if (name) await git(process.cwd(), ['config', '--global', 'user.name', name]);
  if (email) await git(process.cwd(), ['config', '--global', 'user.email', email]);
  return identity(process.cwd());
}

// throw away working-tree edits to tracked files (the UI asks first)
async function discard(dir, files) {
  const list = files && files.length ? files : [];
  if (!list.length) throw new Error('no file given');
  let r = await git(dir, ['restore', '--', ...list]);
  if (r.code !== 0) r = await git(dir, ['checkout', '--', ...list]);
  if (r.code !== 0) throw new Error((r.err || r.out).trim().split('\n').pop());
  return status(dir);
}
async function branches(dir) {
  const r = await git(dir, ['branch', '--format=%(refname:short)']);
  return r.code === 0 ? r.out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : [];
}
async function createBranch(dir, name) {
  if (!/^[A-Za-z0-9._\/-]+$/.test(String(name || '')) || /^-|\.\.|\/$|\.lock$/.test(name)) throw new Error('not a valid branch name');
  let r = await git(dir, ['switch', '-c', name]);
  if (r.code !== 0) r = await git(dir, ['checkout', '-b', name]);
  if (r.code !== 0) throw new Error((r.err || r.out).trim().split('\n').pop());
  return status(dir);
}
async function switchBranch(dir, name) {
  let r = await git(dir, ['switch', name]);
  if (r.code !== 0 && /not a git command|unknown/i.test(r.err)) r = await git(dir, ['checkout', name]);
  if (r.code !== 0) throw new Error((r.err || r.out).trim().split('\n').slice(-2).join(' '));
  return status(dir);
}

// network: push / pull / fetch. GIT_TERMINAL_PROMPT=0 means a missing
// credential fails fast with a message instead of hanging on a hidden prompt;
// Git for Windows' credential manager still pops its own sign-in window.
function netError(r) {
  const msg = (r.err + '\n' + r.out).trim();
  if (/No configured push destination|does not appear to be a git repository|No remote repository/i.test(msg)) return 'this project has no remote yet. Add one in Git → Set remote.';
  if (/no upstream branch|has no upstream/i.test(msg)) return 'no upstream';
  if (/Authentication failed|could not read Username|terminal prompts disabled|403/i.test(msg)) return 'sign-in failed. Git for Windows’ credential manager signs you in the first time you push from a terminal.';
  if (/rejected.*fetch first|non-fast-forward/i.test(msg)) return 'the remote has commits you don’t have. Pull first, then push.';
  if (/CONFLICT|Automatic merge failed/i.test(msg)) return 'the pull hit merge conflicts. Fix the files marked "conflict", stage them and commit.';
  return msg.split('\n').filter(Boolean).slice(-2).join(' ') || 'git failed';
}
async function remotes(dir) {
  const r = await git(dir, ['remote', '-v']);
  const out = {};
  for (const l of r.out.split(/\r?\n/)) { const m = /^(\S+)\s+(\S+)\s+\(fetch\)/.exec(l); if (m) out[m[1]] = m[2]; }
  return out;
}
async function setRemote(dir, url) {
  if (!/^(https?:\/\/|git@|ssh:\/\/|file:\/\/|[A-Za-z]:[\\/]|\/)/.test(String(url || ''))) throw new Error('that doesn’t look like a git URL');
  const have = await remotes(dir);
  const r = await git(dir, have.origin ? ['remote', 'set-url', 'origin', url] : ['remote', 'add', 'origin', url]);
  if (r.code !== 0) throw new Error(netError(r));
  return remotes(dir);
}
async function push(dir) {
  let r = await git(dir, ['push']);
  if (r.code !== 0 && netError(r) === 'no upstream') {
    const st = await status(dir);
    r = await git(dir, ['push', '-u', 'origin', st.branch || 'HEAD']);
  }
  if (r.code !== 0) throw new Error(netError(r));
  return { status: await status(dir), log: (r.err + r.out).trim() };
}
async function pull(dir) {
  // --ff-only never makes a surprise merge commit; if it can't fast-forward
  // the user hears why and decides
  let r = await git(dir, ['pull', '--ff-only']);
  if (r.code !== 0 && /Not possible to fast-forward|diverging/i.test(r.err + r.out)) {
    throw new Error('your branch and the remote have both moved on. Commit your work, then run "git pull --rebase" or merge in a terminal.');
  }
  if (r.code !== 0) throw new Error(netError(r));
  return { status: await status(dir), log: (r.out + r.err).trim() };
}
async function fetch(dir) {
  const r = await git(dir, ['fetch', '--all', '--prune']);
  if (r.code !== 0) throw new Error(netError(r));
  return { status: await status(dir), log: (r.err + r.out).trim() };
}
// one commit: header + per-file stat + patch
async function commitDetails(dir, hash) {
  if (!/^[0-9a-f]{4,40}$/i.test(String(hash || ''))) throw new Error('bad commit id');
  const r = await git(dir, ['show', '--no-color', '--stat', '--patch', '--date=iso', '--format=commit %H%nAuthor: %an <%ae>%nDate:   %ad%n%n%B', hash]);
  if (r.code !== 0) throw new Error(netError(r));
  return r.out;
}
// git blame --porcelain → [{line, hash, author, date, summary}]
function parseBlame(text) {
  const info = {}, out = [];
  let cur = null;
  for (const l of String(text || '').split('\n')) {
    const h = /^([0-9a-f]{40}) (\d+) (\d+)/.exec(l);
    if (h) { cur = { hash: h[1], line: Number(h[3]) }; info[h[1]] = info[h[1]] || {}; continue; }
    if (!cur) continue;
    if (l.startsWith('author ')) info[cur.hash].author = l.slice(7);
    else if (l.startsWith('author-time ')) info[cur.hash].time = Number(l.slice(12));
    else if (l.startsWith('summary ')) info[cur.hash].summary = l.slice(8);
    else if (l.startsWith('\t')) {
      const i = info[cur.hash];
      out.push({ line: cur.line, hash: cur.hash, short: cur.hash.slice(0, 7), author: i.author || '',
        date: i.time ? new Date(i.time * 1000).toISOString().slice(0, 10) : '', summary: i.summary || '',
        uncommitted: /^0+$/.test(cur.hash) });
      cur = null;
    }
  }
  return out;
}
async function blame(dir, file) {
  const rel = path.relative(dir, path.resolve(dir, file)).split(path.sep).join('/');
  const r = await git(dir, ['blame', '--porcelain', '--', rel]);
  if (r.code !== 0) throw new Error(/no such path|not in|fatal: no such ref/i.test(r.err) ? 'this file isn’t committed yet' : netError(r));
  return parseBlame(r.out);
}

module.exports = { remotes, setRemote, push, pull, fetch, commitDetails, blame, parseBlame, discard, branches, createBranch, switchBranch, available, status, init, diff, show, stage, unstage, commit, log, identity, setIdentity, parseStatus, parseLog };
