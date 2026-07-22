// Electron main process (multi-window).
// Each window is an independent, session-keyed grid with its own persisted state file.
// Global settings (glow/sounds/launch/hooks) are shared across all windows.
// Cells are globally keyed as `${windowId}#${index}`; the renderer only ever sees local indices.

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { startSignalServer } = require('./signal-server');
const hooks = require('./hooks');
const platform = require('./platform');

const HOOK_SCRIPT = platform.hookScriptPath(path.join(__dirname, '..', 'hooks'));
const ICON = path.join(__dirname, '..', '..', 'build', 'icon.png');

let pty;
try { pty = require('@lydell/node-pty'); }
catch (e) { pty = require('node-pty'); }

// Safety net: a stray error during window/pty teardown should never pop a crash dialog.
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err && err.stack ? err.stack : err);
});

// ---- global settings (shared across windows) -------------------------------
let settings = {
  glowEnabled: true,
  glowOn: 'idle',
  launch: { command: 'claude', shell: 'auto' },
  autoHooks: true,
  perfView: false, // debug: sample per-cell CPU/RAM (off by default; sampler only runs when on)
  sidebarCollapsed: false,
  doneSound: { enabled: false, path: null },
  permissionSound: { enabled: false, path: null },
  recentFolders: [],       // most-recent-first list of opened workspace folders (home page)
  workspaceChosen: false,  // true once the user has picked a folder (or dismissed the home page)
  seenImport: {},          // normFolder -> true; a folder whose import prompt was already handled
  theme: 'graphite',       // active color theme (graphite | claude | midnight | light)
  overflowChoice: null,    // bulk resume overflow: 'windows' | 'tabs' | null (null = ask each time)
  portOnSwitch: null,      // account switch: 'port' | 'fresh' | null (null = ask each time)
  extraClaudeDirs: [],     // Claude config dirs added by hand (beyond the ~/.claude* auto-scan)
  claudeDirMeta: {},       // normalized dir -> { label, color } for the multi-account UI
};
function settingsFile() { return path.join(app.getPath('userData'), 'settings.json'); }
function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch (_) {}
}
let settingsTimer = null;
function saveSettings() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => writeJsonAtomic(settingsFile(), settings), 300);
}

// ---- shared helpers --------------------------------------------------------
function writeJsonAtomic(p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, p);
  } catch (_) {}
}
function defaultCwd() { return process.env.USERPROFILE || process.env.HOME || process.cwd(); }

const AUDIO_MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac' };
function readAudioDataUrl(p) {
  try {
    const ext = path.extname(p).slice(1).toLowerCase();
    const mime = AUDIO_MIME[ext] || 'application/octet-stream';
    return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
  } catch (_) { return null; }
}

// ---- windows + sessions ----------------------------------------------------
const windows = new Map();  // windowId -> { win, state, saveTimer, removed }
const wcToWin = new Map();  // webContents.id -> windowId
const sessions = new Map(); // `${windowId}#${index}` -> pty
let signal = { port: 0, token: '' };
let homeWin = null;         // the launcher/home window (no grid); null once a workspace is opened
let homeWcId = null;
let appQuitting = false;    // set on before-quit so a clean quit restores windows (not marked closed)
app.on('before-quit', () => { appQuitting = true; });

function windowsDir() { return path.join(app.getPath('userData'), 'windows'); }
function windowStateFile(id) { return path.join(windowsDir(), `${id}.json`); }
function baseName(f) { return String(f || '').split(/[\\/]/).filter(Boolean).pop() || 'window'; }
function defaultWindowState(id, n, folder) {
  return { windowId: id, title: `${baseName(folder)}-${n}`, workspace: folder, open: true, layout: { rows: 3, cols: 4 }, cells: {}, panes: [], seq: 0 };
}
// The folder a window (or the invoking IPC sender) belongs to. Windows are per-folder, so this is
// per-window — NOT a single global workspace, which lets several folders be open at once.
function folderOf(rec) { return (rec && rec.state && rec.state.workspace) || currentWorkspace || defaultCwd(); }
function wsHash(folder) {
  const s = normFolder(folder);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
// Per-folder window numbering: each folder's windows count from 1, ids namespaced by folder hash.
// N is parsed from the windowId (`...-w<N>`) so it is independent of the (renamable) title.
function nextWindowInfo(folder) {
  const cw = normFolder(folder);
  let max = 0;
  const scan = (st) => {
    if (!st || normFolder(st.workspace) !== cw) return;
    const m = /-w(\d+)$/.exec(st.windowId || '');
    if (m) max = Math.max(max, +m[1]);
  };
  for (const rec of windows.values()) scan(rec.state);
  try {
    for (const f of fs.readdirSync(windowsDir())) {
      if (!f.endsWith('.json')) continue;
      try { scan(JSON.parse(fs.readFileSync(path.join(windowsDir(), f), 'utf8'))); } catch (_) {}
    }
  } catch (_) {}
  const n = max + 1;
  return { n, id: `${wsHash(folder)}-w${n}` };
}
function scheduleWindowSave(rec) {
  clearTimeout(rec.saveTimer);
  rec.saveTimer = setTimeout(() => writeJsonAtomic(windowStateFile(rec.state.windowId), rec.state), 400);
}
function saveWindowNow(rec) { writeJsonAtomic(windowStateFile(rec.state.windowId), rec.state); }
function recFromEvent(e) { const id = wcToWin.get(e.sender.id); return id ? windows.get(id) : null; }
// Send links to the user's DEFAULT browser (Chrome/etc.) instead of a chromeless Electron window.
// Claude emits OSC 8 terminal hyperlinks; xterm's default handler would window.open() them, which
// Electron turns into a bare popup window. Deny that and open externally.
function wireExternalLinks(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url && !url.startsWith('file:')) { e.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); }
  });
}
// Guarded send: never throw if the window/webContents was destroyed mid-teardown.
function sendTo(rec, channel, ...args) {
  try {
    if (rec && rec.win && !rec.win.isDestroyed() && !rec.win.webContents.isDestroyed()) {
      rec.win.webContents.send(channel, ...args);
    }
  } catch (_) {}
}
function cellRec(rec, index) { const c = rec.state.cells; if (!c[index]) c[index] = {}; return c[index]; }
// The current workspace folder. Fresh sessions start here; windows are scoped to it.
let currentWorkspace = null;
function normFolder(f) {
  try { return path.resolve(f || defaultCwd()).toLowerCase(); }
  catch (_) { return String(f || '').toLowerCase(); }
}
function resolveWorkspace() {
  for (const c of [process.env.CW_ROOT_FOLDER, settings.lastWorkspace, defaultCwd()]) {
    try { if (c && fs.existsSync(c)) return c; } catch (_) {}
  }
  return defaultCwd();
}
function effectiveRoot() { return currentWorkspace || defaultCwd(); }
function launchBase() {
  const v = process.env.CW_LAUNCH_CMD;
  if (v !== undefined) return v === 'SHELL' ? '' : v;
  return (settings.launch && settings.launch.command) || 'claude';
}

// Resolve a bare command name (e.g. `claude`) to its absolute path ONCE, via a login shell, so every
// cell launches the binary directly instead of re-resolving it on PATH. A GUI launch starts from the
// minimal launchd PATH, and per-cell shell init (path_helper, direnv, plugin managers) can rebuild
// PATH differently across a dozen concurrent resumes — which intermittently left some cells unable to
// find `claude`. Resolving up front removes that dependency. Fails safe: if we can't resolve to a
// real absolute file, the original name is used and behaviour is exactly as before.
const resolvedBin = new Map();
function resolveBinary(name) {
  if (!name || name.includes('/') || platform.isWin) return name; // already a path, empty, or Windows
  if (resolvedBin.has(name)) return resolvedBin.get(name);
  let resolved = name;
  try {
    const { spawnSync } = require('child_process');
    const sh = platform.loginShell();
    const r = spawnSync(sh, ['-lic', `command -v ${name} 2>/dev/null`], { encoding: 'utf8', timeout: 8000 });
    // A login shell may print unrelated noise (history saves, MOTD); take the first line that is an
    // absolute path to an existing executable. A shell builtin/alias yields no path -> no change.
    const cand = String((r && r.stdout) || '').split('\n').map((s) => s.trim())
      .find((p) => p.startsWith('/') && (() => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } })());
    if (cand) resolved = cand;
  } catch (_) {}
  resolvedBin.set(name, resolved);
  return resolved;
}
// Rewrite a launch command so its FIRST token is absolute when we can resolve it (keeping any args).
function absolutizeLaunch(base) {
  const b = String(base || '').trim();
  if (!b) return b;
  const sp = b.search(/\s/);
  const first = sp === -1 ? b : b.slice(0, sp);
  const rest = sp === -1 ? '' : b.slice(sp);
  const abs = resolveBinary(first);
  return abs === first ? b : abs + rest;
}

// ---- Claude profiles (multi-account) ---------------------------------------
// A "profile" is one CLAUDE_CONFIG_DIR: its own credentials, settings and transcript store. Cells
// can each run against a different one, which is how several Claude accounts stay live at once.
function defaultClaudeDir() { return path.join(os.homedir(), '.claude'); }
function claudeDir() { return process.env.CLAUDE_CONFIG_DIR || defaultClaudeDir(); }
function isDirectory(p) { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } }

// The default profile keeps its config at ~/.claude.json (home root); a custom CLAUDE_CONFIG_DIR
// keeps it INSIDE the dir. Getting this asymmetry wrong silently reports "no account".
function configJsonFor(dir) {
  return normFolder(dir) === normFolder(defaultClaudeDir())
    ? path.join(os.homedir(), '.claude.json')
    : path.join(dir, '.claude.json');
}
// Which account a profile is signed in as. Read from plain config JSON — never from credentials
// (those live in the OS keychain on macOS and are none of our business).
function accountOf(dir) {
  try {
    const oa = JSON.parse(fs.readFileSync(configJsonFor(dir), 'utf8')).oauthAccount || {};
    return { email: oa.emailAddress || null, org: oa.organizationName || null, uuid: oa.accountUuid || null };
  } catch (_) { return { email: null, org: null, uuid: null }; }
}
// Profiles found by convention: ~/.claude plus any ~/.claude-* that has a transcript store or its
// own config. An explicit CLAUDE_CONFIG_DIR (tests, or a user pinning one profile) wins outright
// and suppresses the scan, so an isolated environment stays isolated.
function discoverClaudeDirs() {
  if (process.env.CLAUDE_CONFIG_DIR) return [process.env.CLAUDE_CONFIG_DIR];
  const home = os.homedir();
  const out = [];
  if (isDirectory(defaultClaudeDir())) out.push(defaultClaudeDir());
  try {
    for (const name of fs.readdirSync(home)) {
      if (!/^\.claude-/.test(name)) continue;
      const full = path.join(home, name);
      if (!isDirectory(full)) continue;
      if (isDirectory(path.join(full, 'projects')) || fs.existsSync(path.join(full, '.claude.json'))) out.push(full);
    }
  } catch (_) {}
  return out;
}
// Auto-discovered profiles + any the user added by hand, each with its bound account and colour.
function claudeDirRegistry() {
  const manual = process.env.CLAUDE_CONFIG_DIR ? [] : (settings.extraClaudeDirs || []);
  const meta = settings.claudeDirMeta || {};
  const seen = new Set();
  const out = [];
  for (const d of [...discoverClaudeDirs(), ...manual]) {
    const key = normFolder(d);
    if (seen.has(key) || !isDirectory(d)) continue;
    seen.add(key);
    const m = meta[key] || {};
    if (m.hidden) continue; // user dismissed it (e.g. a stray ~/.claude-backup the scan picked up)
    out.push({
      dir: d, key, label: m.label || baseName(d), color: m.color || null,
      account: accountOf(d), isDefault: key === normFolder(claudeDir()),
    });
  }
  return out;
}
// Hooks must exist in EVERY profile, not just the ambient one: a profile without them emits no
// signals, so cells running under it get no glow and — because onSignal is where a fresh session's
// id is captured — would never persist or resume.
function hooksForAllProfiles(fn) {
  const dirs = claudeDirRegistry().map((p) => p.dir);
  const out = [];
  for (const d of (dirs.length ? dirs : [claudeDir()])) {
    try { out.push(fn(HOOK_SCRIPT, d)); } catch (_) {}
  }
  return out;
}
function installHooksEverywhere() { return hooksForAllProfiles(hooks.installHooks); }
function uninstallHooksEverywhere() { return hooksForAllProfiles(hooks.uninstallHooks); }

function profileFor(dir) {
  const key = normFolder(dir || claudeDir());
  return claudeDirRegistry().find((p) => p.key === key) || null;
}

// A session's transcript within ONE profile.
function sessionFileIn(dir, sessionId, cwd) {
  if (!sessionId || !dir) return null;
  const projects = path.join(dir, 'projects');
  if (cwd) {
    const g = path.join(projects, encodeProject(cwd), `${sessionId}.jsonl`);
    try { if (fs.existsSync(g)) return g; } catch (_) {}
  }
  try {
    for (const d of fs.readdirSync(projects)) {
      const f = path.join(projects, d, `${sessionId}.jsonl`);
      try { if (fs.existsSync(f)) return f; } catch (_) {}
    }
  } catch (_) {}
  return null;
}
// Switching an account COPIES the transcript and leaves the original, so one sessionId can exist in
// several profiles. Newest mtime is the source of truth: a switch stamps the copy, so the target
// profile wins immediately and keeps winning while it's the one being used.
function resolveSessionSoT(sessionId, cwd) {
  if (!sessionId) return null;
  let best = null;
  for (const p of claudeDirRegistry()) {
    const file = sessionFileIn(p.dir, sessionId, cwd);
    if (!file) continue;
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch (_) { continue; }
    if (!best || mtime > best.mtime) best = { file, mtime, dir: p.dir, profile: p };
  }
  return best;
}
// The transcript to read for a session. `dir` pins a specific profile; otherwise the SoT wins.
function sessionTranscriptFile(sessionId, cwd, dir) {
  if (!sessionId) return null;
  if (dir) return sessionFileIn(dir, sessionId, cwd);
  const sot = resolveSessionSoT(sessionId, cwd);
  return sot ? sot.file : null;
}
function readHead(file, bytes = 262144) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    fs.closeSync(fd);
    return buf.toString('utf8', 0, n);
  } catch (_) { return ''; }
}
// A session is only resumable if Claude actually persisted a conversation (a user turn exists).
// A session opened but never used has no real transcript, and `claude --resume` errors.
function isResumable(sessionId, cwd) {
  return resumeInfo(sessionId, cwd).ok;
}
// Decide whether/where to resume. `claude --resume <id>` only looks in the CURRENT directory's
// project folder, so we must launch it in the exact cwd the transcript was recorded under (read
// from the transcript itself) — not wherever the cell was last saved. This fixes the intermittent
// "No conversation found with session ID" when a session's real folder differs from the cell's.
// `dir` pins a profile (a cell the user bound to a specific account); otherwise the source-of-truth
// profile is chosen by recency, and `configDir` comes back so the cell relaunches under it.
function resumeInfo(sessionId, cwd, dir) {
  if (!sessionId) return { ok: false };
  const sot = dir ? { file: sessionFileIn(dir, sessionId, cwd), dir } : resolveSessionSoT(sessionId, cwd);
  if (!sot || !sot.file) return { ok: false };
  const head = readHead(sot.file);
  if (!/"type"\s*:\s*"user"/.test(head)) return { ok: false };
  return { ok: true, cwd: cwdFromText(head) || cwd, configDir: sot.dir };
}
// Encode a folder path the way Claude stores its per-project transcript directory.
function encodeProject(folder) { return String(folder).replace(/[:\\/]/g, '-'); }
// The cwd a session actually ran in, read straight from its transcript (authoritative — the encoded
// directory name is lossy and can't be reversed reliably).
function cwdFromText(text) {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch (_) { continue; }
    if (o && typeof o.cwd === 'string' && o.cwd) return o.cwd;
  }
  return null;
}
// Resumable sessions in a transcript directory, newest first, minus any in `exclude`. Each carries
// its own real cwd so it can be resumed in the exact folder Claude stored it under (no file moving).
function sessionsInDir(dir, fallbackCwd, exclude = new Set()) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return out; }
  for (const f of names) {
    if (!f.endsWith('.jsonl')) continue;
    const sessionId = f.slice(0, -6);
    if (exclude.has(sessionId)) continue;
    const file = path.join(dir, f);
    const head = readHead(file);
    if (!/"type"\s*:\s*"user"/.test(head)) continue; // only ones with a real conversation
    let mtime = 0; try { mtime = fs.statSync(file).mtimeMs; } catch (_) {}
    out.push({ sessionId, title: firstPromptFromText(head) || '(untitled session)', mtime, cwd: cwdFromText(head) || fallbackCwd || null });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}
// Tag a scanned session with the profile it came from, so the UI can show which account owns it.
function tagged(s, p) {
  return { ...s, configDir: p.dir, profileLabel: p.label, profileColor: p.color, account: p.account };
}
// Collapse the same sessionId seen in several profiles down to its source of truth (newest wins).
// Without this a session that's been switched between accounts would be listed once per profile.
function dedupeToSoT(rows) {
  const best = new Map();
  for (const s of rows) {
    const prev = best.get(s.sessionId);
    if (!prev || s.mtime > prev.mtime) best.set(s.sessionId, s);
  }
  return [...best.values()].sort((a, b) => b.mtime - a.mtime);
}
// Sessions that live under `folder`, across every profile.
function scanWorkspaceSessions(folder, exclude = new Set()) {
  const rows = [];
  for (const p of claudeDirRegistry()) {
    for (const s of sessionsInDir(path.join(p.dir, 'projects', encodeProject(folder)), folder, exclude)) rows.push(tagged(s, p));
  }
  return dedupeToSoT(rows);
}
// Sessions in a specific encoded project directory (used by the Settings importer, which can browse
// across every project Claude knows about, not just the current workspace).
function scanProjectSessions(encodedDir) {
  const rows = [];
  for (const p of claudeDirRegistry()) {
    for (const s of sessionsInDir(path.join(p.dir, 'projects', encodedDir), null)) rows.push(tagged(s, p));
  }
  return dedupeToSoT(rows);
}
// Every Claude project directory that has at least one resumable session, with its real path.
// Merged across profiles: a project folder is the same project whichever account worked in it.
// Sessions are keyed by id so a transcript copied between profiles counts once, not twice.
function listProjects() {
  const byDir = new Map(); // encoded project dir -> { dir, path, sessions:Map(sessionId->mtime), latest }
  for (const p of claudeDirRegistry()) {
    const base = path.join(p.dir, 'projects');
    let dirs = [];
    try { dirs = fs.readdirSync(base); } catch (_) { continue; }
    for (const d of dirs) {
      const full = path.join(base, d);
      if (!isDirectory(full)) continue;
      let files = [];
      try { files = fs.readdirSync(full); } catch (_) { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const head = readHead(path.join(full, f), 65536);
        if (!/"type"\s*:\s*"user"/.test(head)) continue;
        let e = byDir.get(d);
        if (!e) { e = { dir: d, path: null, sessions: new Map(), latest: 0 }; byDir.set(d, e); }
        if (!e.path) e.path = cwdFromText(head);
        let m = 0; try { m = fs.statSync(path.join(full, f)).mtimeMs; } catch (_) {}
        const sid = f.slice(0, -6);
        if (m > (e.sessions.get(sid) || 0)) e.sessions.set(sid, m);
        if (m > e.latest) e.latest = m;
      }
    }
  }
  const out = [...byDir.values()].map((e) => ({ dir: e.dir, path: e.path || e.dir, count: e.sessions.size, latest: e.latest }));
  out.sort((a, b) => b.latest - a.latest);
  return out;
}
// Smallest landscape layout that fits `count` sessions (capped at 4x4).
const FIT_LAYOUTS = [{ rows: 2, cols: 2 }, { rows: 2, cols: 4 }, { rows: 3, cols: 4 }, { rows: 4, cols: 4 }];
function pickFitLayout(count) { for (const L of FIT_LAYOUTS) if (L.rows * L.cols >= count) return L; return { rows: 4, cols: 4 }; }
// Remember a folder at the top of the recent-workspaces list (deduped, capped).
function pushRecent(folder) {
  if (!folder) return;
  const norm = normFolder(folder);
  settings.recentFolders = (settings.recentFolders || []).filter((f) => normFolder(f) !== norm);
  settings.recentFolders.unshift(folder);
  if (settings.recentFolders.length > 10) settings.recentFolders.length = 10;
}

// The first real user prompt from a transcript's text — used as the session's "topic".
function firstPromptFromText(text) {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch (_) { continue; }
    if (o.type !== 'user') continue;
    const c = o.message && o.message.content;
    let t = typeof c === 'string' ? c : (Array.isArray(c) ? (c.find((x) => x && x.type === 'text') || {}).text : null);
    if (t && !/^\s*</.test(t)) return t.replace(/\s+/g, ' ').trim().slice(0, 120);
  }
  return null;
}
function firstPrompt(sessionId, cwd) {
  const file = sessionTranscriptFile(sessionId, cwd);
  return file ? firstPromptFromText(readHead(file)) : null;
}

function createWindow(state) {
  const win = new BrowserWindow({
    width: 1280, height: 820, backgroundColor: '#1b1c1e',
    title: `${state.title} - HNA-Code`,
    icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  const wcId = win.webContents.id; // capture now; webContents is gone by 'closed'
  const rec = { win, wcId, state, saveTimer: null, removed: false };
  state.open = true; // it's open now
  windows.set(state.windowId, rec);
  wcToWin.set(wcId, state.windowId);
  wireExternalLinks(win);

  // Zoom in/out/reset that actually works for + as well as -, and never reloads the grid.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta)) return;
    const wc = win.webContents;
    const set = (lvl) => wc.setZoomLevel(Math.max(-3, Math.min(4, lvl)));
    if (input.key === '=' || input.key === '+') { set(wc.getZoomLevel() + 0.5); event.preventDefault(); }
    else if (input.key === '-' || input.key === '_') { set(wc.getZoomLevel() - 0.5); event.preventDefault(); }
    else if (input.key === '0') { set(0); event.preventDefault(); }
  });

  win.on('close', () => {
    if (rec.removed) return;
    // A window the USER closes (while the app keeps running) is remembered as closed, so reopening
    // its folder doesn't pop it back up. A clean app quit leaves open=true so everything restores.
    if (!appQuitting && windows.size > 1) rec.state.open = false;
    saveWindowNow(rec);
  });
  win.on('closed', () => {
    for (const [gid, proc] of sessions) {
      if (gid.startsWith(state.windowId + '#')) { try { proc.kill(); } catch (_) {} sessions.delete(gid); }
    }
    wcToWin.delete(wcId);
    windows.delete(state.windowId);
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  return rec;
}

// Open every saved window that belongs to `folder` (or a fresh default if none). Windows already
// open for other folders are left untouched, so multiple folders can be open simultaneously.
function openSavedWindows(folder) {
  const cw = normFolder(folder);
  let all = [];
  try {
    for (const f of fs.readdirSync(windowsDir())) {
      if (!f.endsWith('.json')) continue;
      try { all.push(JSON.parse(fs.readFileSync(path.join(windowsDir(), f), 'utf8'))); } catch (_) {}
    }
  } catch (_) {}

  const mine = [];
  for (const st of all) {
    if (st.workspace === undefined || st.workspace === null) {
      st.workspace = folder; // legacy window (pre per-folder): adopt it into the folder being opened
      writeJsonAtomic(windowStateFile(st.windowId), st);
      mine.push(st);
    } else if (normFolder(st.workspace) === cw) {
      mine.push(st);
    }
  }
  mine.sort((a, b) => String(a.windowId).localeCompare(String(b.windowId), undefined, { numeric: true }));

  // Only reopen windows that were open (open !== false). If none were, open the most recent one so
  // the folder isn't empty. Brand-new folder -> a default window.
  let toOpen = mine.filter((st) => st.open !== false);
  if (toOpen.length === 0 && mine.length > 0) { toOpen = [mine[mine.length - 1]]; }
  if (toOpen.length === 0) {
    const { n, id } = nextWindowInfo(folder);
    const st = defaultWindowState(id, n, folder);
    writeJsonAtomic(windowStateFile(id), st);
    toOpen = [st];
  }
  for (const st of toOpen) if (!windows.has(st.windowId)) createWindow(st);
}
// All saved windows for a folder (open + closed), for the window dropdown.
function listFolderWindows(folder) {
  const cw = normFolder(folder);
  const out = [];
  const seen = new Set();
  for (const rec of windows.values()) {
    if (normFolder(rec.state.workspace) !== cw) continue;
    out.push({ windowId: rec.state.windowId, title: rec.state.title, open: true });
    seen.add(rec.state.windowId);
  }
  try {
    for (const f of fs.readdirSync(windowsDir())) {
      if (!f.endsWith('.json')) continue;
      let st; try { st = JSON.parse(fs.readFileSync(path.join(windowsDir(), f), 'utf8')); } catch (_) { continue; }
      if (!st || seen.has(st.windowId) || normFolder(st.workspace) !== cw) continue;
      out.push({ windowId: st.windowId, title: st.title, open: false });
    }
  } catch (_) {}
  out.sort((a, b) => String(a.windowId).localeCompare(String(b.windowId), undefined, { numeric: true }));
  return out;
}
// Open a saved-but-closed window by id.
function openExistingWindow(id) {
  if (windows.has(id)) { const r = windows.get(id); if (r.win && !r.win.isDestroyed()) r.win.focus(); return; }
  let st; try { st = JSON.parse(fs.readFileSync(windowStateFile(id), 'utf8')); } catch (_) { return; }
  st.open = true;
  createWindow(st);
}

// The launcher window: the app opens here (a folder chooser) with NO grid and NO sessions spawned.
// Picking a folder is what actually loads a workspace's grid windows (see openWorkspace).
function createHomeWindow() {
  if (homeWin && !homeWin.isDestroyed()) { homeWin.focus(); return homeWin; }
  const win = new BrowserWindow({
    width: 860, height: 620, backgroundColor: '#1b1c1e', title: 'HNA-Code',
    icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  homeWin = win; homeWcId = win.webContents.id;
  wireExternalLinks(win);
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta)) return;
    const wc = win.webContents;
    const set = (lvl) => wc.setZoomLevel(Math.max(-3, Math.min(4, lvl)));
    if (input.key === '=' || input.key === '+') { set(wc.getZoomLevel() + 0.5); event.preventDefault(); }
    else if (input.key === '-' || input.key === '_') { set(wc.getZoomLevel() - 0.5); event.preventDefault(); }
    else if (input.key === '0') { set(0); event.preventDefault(); }
  });
  win.on('closed', () => { if (homeWin === win) { homeWin = null; homeWcId = null; } });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  return win;
}

// Open a folder: persist the choice and open that folder's grid windows. Windows for OTHER folders
// stay open (work on several projects at once). Only the launcher is dismissed. No relaunch.
function openWorkspace(folder) {
  try { if (!folder || !fs.existsSync(folder)) return false; } catch (_) { return false; }
  currentWorkspace = folder; // the "most recently opened" folder, used as the launcher default
  settings.lastWorkspace = folder;
  settings.workspaceChosen = true;
  pushRecent(folder);
  writeJsonAtomic(settingsFile(), settings);
  const before = new Set(windows.keys());
  openSavedWindows(folder);
  // Focus a window we just opened for this folder.
  for (const [id, rec] of windows) {
    if (!before.has(id) && rec.win && !rec.win.isDestroyed()) { rec.win.focus(); break; }
  }
  if (homeWin && !homeWin.isDestroyed()) homeWin.close();
  return true;
}
// Create one more window for a specific folder (the window dropdown's "New window").
function newWindowForFolder(folder) {
  const { n, id } = nextWindowInfo(folder);
  const st = defaultWindowState(id, n, folder);
  writeJsonAtomic(windowStateFile(id), st);
  return createWindow(st);
}

function spawnCell(windowId, index, opts = {}) {
  const rec = windows.get(windowId);
  if (!rec) return;
  const gid = `${windowId}#${index}`;
  let cwd = opts.cwd || folderOf(rec); // fresh cells start in this window's own folder
  try { if (!fs.existsSync(cwd)) cwd = defaultCwd(); } catch (_) { cwd = defaultCwd(); }
  const base = absolutizeLaunch(launchBase());
  const line = opts.resumeId && base ? `${base} --resume ${opts.resumeId}` : base;
  const { file, args } = platform.cellCommand(line);

  // A cell bound to a Claude profile launches under that profile's CLAUDE_CONFIG_DIR, which is what
  // makes it run as that account. Unbound cells inherit the ambient env exactly as before.
  const proc = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: opts.cols || 80, rows: opts.rows || 24, cwd,
    env: {
      ...process.env, CC_CELL_ID: gid, CC_SIGNAL_PORT: String(signal.port), CC_SIGNAL_TOKEN: signal.token,
      ...(opts.configDir ? { CLAUDE_CONFIG_DIR: opts.configDir } : {}),
    },
  });
  proc.onData((d) => sendTo(windows.get(windowId), 'pty:data', index, d));
  proc.onExit(() => {
    // Only react if this pty is still the cell's current one. During an import we kill the old pty
    // right after spawning its replacement; the old pty's late onExit must NOT evict the new session
    // (that left resumed cells unresponsive) or print a spurious "[process exited]".
    if (sessions.get(gid) === proc) { sessions.delete(gid); sendTo(windows.get(windowId), 'pty:exit', index); }
  });
  sessions.set(gid, proc);
  const prof = opts.configDir ? profileFor(opts.configDir) : null;
  sendTo(rec, 'cell:launched', index, {
    line, cwd, resumeId: opts.resumeId || null,
    configDir: opts.configDir || null,
    profile: prof ? { dir: prof.dir, label: prof.label, color: prof.color, account: prof.account } : null,
  });
  return proc;
}

// ---- signal server ---------------------------------------------------------
async function initSignal() {
  const s = await startSignalServer(onSignal);
  signal.port = s.port; signal.token = s.token;
  // Per-instance runtime file (in this instance's userData) so tools/tests read the right port.
  try {
    fs.writeFileSync(path.join(app.getPath('userData'), 'runtime.json'),
      JSON.stringify({ port: s.port, token: s.token, pid: process.pid }));
  } catch (_) {}
}
function parseCell(cellVal) {
  const s = String(cellVal);
  if (s.includes('#')) { const [w, i] = s.split('#'); return { windowId: w, index: i }; }
  if (windows.size === 1) return { windowId: [...windows.keys()][0], index: s }; // bare index (tests / single window)
  return { windowId: null, index: s };
}
function onSignal(payload) {
  const { windowId, index } = parseCell(payload.cell);
  const rec = windowId && windows.get(windowId);
  if (!rec) return;
  if (payload.session_id) cellRec(rec, index).sessionId = payload.session_id;
  if (payload.cwd) cellRec(rec, index).cwd = payload.cwd;
  scheduleWindowSave(rec);
  sendTo(rec, 'signal', { ...payload, cell: index });
}

// ---- performance sampler (opt-in) ------------------------------------------
// Sums each cell's PTY process subtree (claude + whatever it spawns) for CPU% and RAM.
// One OS process query per tick (WMI on Windows, `ps` elsewhere); only runs while perfView is on.
const { spawn: cpSpawn } = require('child_process');
let perfTimer = null;
let perfBusy = false;

function samplePerf() {
  if (perfBusy) return;
  perfBusy = true;
  let out = '';
  const { file, args } = platform.perfCommand();
  const ps = cpSpawn(file, args, { windowsHide: true });
  ps.stdout.on('data', (d) => (out += d));
  ps.on('error', () => { perfBusy = false; });
  ps.on('close', () => {
    perfBusy = false;
    const list = platform.perfParse(out);
    if (!list) return;
    const byPid = new Map(), children = new Map();
    for (const r of list) {
      byPid.set(r.p, r);
      if (!children.has(r.pp)) children.set(r.pp, []);
      children.get(r.pp).push(r.p);
    }
    const cores = os.cpus().length || 1;
    const subtree = (pid) => {
      const stack = [pid], seen = new Set(); let cpu = 0, mem = 0;
      while (stack.length) {
        const id = stack.pop(); if (seen.has(id)) continue; seen.add(id);
        const r = byPid.get(id); if (r) { cpu += r.c; mem += r.m; }
        const ch = children.get(id); if (ch) for (const c of ch) stack.push(c);
      }
      return { cpu: cpu / cores, mem };
    };
    for (const [windowId, rec] of windows) {
      const cells = {}; let wCpu = 0, wMem = 0;
      for (const [gid, proc] of sessions) {
        if (!gid.startsWith(windowId + '#')) continue;
        const index = gid.split('#')[1];
        const s = subtree(proc.pid);
        cells[index] = { cpu: Math.round(s.cpu), mem: Math.round(s.mem / 1048576) };
        wCpu += s.cpu; wMem += s.mem;
      }
      sendTo(rec, 'perf', { cells, total: { cpu: Math.round(wCpu), mem: Math.round(wMem / 1048576) } });
    }
  });
}
function applyPerfSetting() {
  if (settings.perfView && !perfTimer) { samplePerf(); perfTimer = setInterval(samplePerf, 2500); }
  else if (!settings.perfView && perfTimer) { clearInterval(perfTimer); perfTimer = null; }
}

// ---- app lifecycle ---------------------------------------------------------
app.whenReady().then(async () => {
  // Windows/Linux: no app menu (we handle zoom ourselves; avoids an accidental Ctrl+R reload).
  // macOS: a standard menu is expected — it provides Cmd+Q and native Cmd+C/V/A in text inputs.
  if (platform.isMac) {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'windowMenu' },
      { label: 'Help', submenu: [{ label: 'GitHub', click: () => shell.openExternal('https://github.com/tyhh00/HNA-Code') }] },
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }
  loadSettings();
  currentWorkspace = resolveWorkspace(); // a sensible default; the grid only opens once a folder is chosen
  // Resolve the launch binary's absolute path once, off the critical path, so the first cell spawn
  // doesn't block and every cell launches the same resolved binary (see resolveBinary).
  try { const b = launchBase(); if (b) absolutizeLaunch(b); } catch (_) {}
  if (settings.autoHooks !== false) { try { installHooksEverywhere(); } catch (_) {} }
  await initSignal();
  applyPerfSetting();

  ipcMain.handle('state:get', (e) => {
    const rec = recFromEvent(e);
    const root = rec ? folderOf(rec) : effectiveRoot();
    // The launcher window renders the home page (no grid); every other window is a workspace grid.
    const mode = (e.sender && e.sender.id === homeWcId) ? 'home' : 'grid';
    // CW_NO_IMPORT lets tests launch without the auto-import prompt firing.
    const importSeen = !!process.env.CW_NO_IMPORT || !!(settings.seenImport && settings.seenImport[normFolder(root)]);
    const extra = { settings, root, mode, importSeen };
    return rec ? { ...rec.state, ...extra } : extra;
  });
  ipcMain.handle('window:info', (e) => { const rec = recFromEvent(e); return rec ? { windowId: rec.state.windowId, title: rec.state.title } : null; });
  ipcMain.handle('session:topic', (e, index) => {
    const rec = recFromEvent(e); if (!rec) return null;
    const c = rec.state.cells[index];
    if (!c || !c.sessionId) return null;
    const file = sessionTranscriptFile(c.sessionId, c.cwd);
    let mtime = 0; try { if (file) mtime = fs.statSync(file).mtimeMs; } catch (_) {}
    return { topic: firstPrompt(c.sessionId, c.cwd), mtime };
  });

  ipcMain.handle('hooks:install', () => installHooksEverywhere());
  ipcMain.handle('hooks:uninstall', () => uninstallHooksEverywhere());

  ipcMain.on('cell:ready', (e, index, cols, rows) => {
    const rec = recFromEvent(e); if (!rec) return;
    if (sessions.has(`${rec.state.windowId}#${index}`)) return;
    const saved = rec.state.cells[index] || {};
    // A cell remembers the Claude profile it was bound to (falling back to the window's default), so
    // reopening a window relaunches every cell under the same account it was running as before.
    let bound = saved.configDir || rec.state.defaultConfigDir || null;
    // A profile directory can be deleted or renamed between runs. Trusting a dead binding would
    // launch Claude against a nonexistent config (blank + unauthenticated) AND skip the resume,
    // silently losing the conversation — so drop the stale binding and fall back to the SoT.
    if (bound && !isDirectory(bound)) {
      bound = null;
      if (saved.configDir) { delete cellRec(rec, index).configDir; scheduleWindowSave(rec); }
    }
    // Only resume sessions with a persisted conversation, and do it in the folder the transcript
    // was actually recorded under (so `claude --resume` can find it).
    const info = resumeInfo(saved.sessionId, saved.cwd, bound || undefined);
    const resumeId = info.ok ? saved.sessionId : undefined;
    const cwd = info.ok ? info.cwd : saved.cwd;
    if (info.ok && info.cwd && info.cwd !== saved.cwd) { const c = cellRec(rec, index); c.cwd = info.cwd; scheduleWindowSave(rec); }
    // With several profiles around, an unbound cell adopts whichever one its session actually lives
    // in, so the binding shows up in the UI without the user setting it. With a single profile we
    // pass nothing and stay on exactly the pre-multi-account launch path.
    const multi = claudeDirRegistry().length > 1;
    const configDir = bound || (multi && info.ok ? info.configDir : null);
    if (configDir && configDir !== saved.configDir) { cellRec(rec, index).configDir = configDir; scheduleWindowSave(rec); }
    spawnCell(rec.state.windowId, index, { cols, rows, cwd, resumeId, configDir: configDir || undefined });
  });
  ipcMain.on('pty:input', (e, index, data) => {
    const rec = recFromEvent(e); if (!rec) return;
    const p = sessions.get(`${rec.state.windowId}#${index}`); if (p) p.write(data);
  });
  ipcMain.on('pty:resize', (e, index, cols, rows) => {
    const rec = recFromEvent(e); if (!rec) return;
    const p = sessions.get(`${rec.state.windowId}#${index}`);
    if (p && cols > 0 && rows > 0) { try { p.resize(cols, rows); } catch (_) {} }
  });
  ipcMain.on('cell:dispose', (e, index) => {
    const rec = recFromEvent(e); if (!rec) return;
    const gid = `${rec.state.windowId}#${index}`;
    const p = sessions.get(gid); if (p) { try { p.kill(); } catch (_) {} sessions.delete(gid); }
    delete rec.state.cells[index];
    scheduleWindowSave(rec);
  });

  ipcMain.on('cell:rename', (e, index, name) => { const rec = recFromEvent(e); if (rec) { cellRec(rec, index).name = name; scheduleWindowSave(rec); } });
  ipcMain.on('glow:changed', (e, index, g) => { const rec = recFromEvent(e); if (rec) { cellRec(rec, index).glow = g; scheduleWindowSave(rec); } });
  ipcMain.on('layout:changed', (e, rows, cols) => { const rec = recFromEvent(e); if (rec) { rec.state.layout = { rows, cols }; scheduleWindowSave(rec); } });
  ipcMain.on('panes:changed', (e, panesArr, seq) => { const rec = recFromEvent(e); if (rec) { rec.state.panes = panesArr; rec.state.seq = seq; scheduleWindowSave(rec); } });
  ipcMain.on('settings:changed', (_e, s) => { settings = { ...settings, ...s }; saveSettings(); applyPerfSetting(); });

  // sounds (global)
  ipcMain.handle('dialog:pickSound', async (e) => {
    const rec = recFromEvent(e);
    const r = await dialog.showOpenDialog(rec ? rec.win : null, {
      title: 'Choose a sound', properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return { path: r.filePaths[0], dataUrl: readAudioDataUrl(r.filePaths[0]) };
  });
  ipcMain.handle('sound:load', (_e, p) => (p ? readAudioDataUrl(p) : null));

  // workspace folder — picking one switches the workspace (relaunch reopens its windows)
  ipcMain.handle('root:pick', async (e) => {
    const rec = recFromEvent(e);
    const r = await dialog.showOpenDialog(rec ? rec.win : null, { title: 'Open folder as workspace', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    settings.lastWorkspace = r.filePaths[0];
    settings.workspaceChosen = true;
    pushRecent(r.filePaths[0]);
    writeJsonAtomic(settingsFile(), settings); // persist before the renderer relaunches
    return r.filePaths[0];
  });
  // Switch to a specific folder (e.g. a recent one) without a dialog; renderer then relaunches.
  ipcMain.handle('root:set', (_e, folder) => {
    try { if (!folder || !fs.existsSync(folder)) return null; } catch (_) { return null; }
    settings.lastWorkspace = folder;
    settings.workspaceChosen = true;
    pushRecent(folder);
    writeJsonAtomic(settingsFile(), settings);
    return folder;
  });
  ipcMain.handle('root:get', (e) => folderOf(recFromEvent(e)));
  ipcMain.on('workspace:chosen', () => { settings.workspaceChosen = true; saveSettings(); });
  // Enter a folder from the launcher (or open another folder from a grid window): loads the grid in
  // place, no relaunch, without closing other folders. Returns true if the folder opened.
  ipcMain.handle('workspace:open', (_e, folder) => openWorkspace(folder));
  ipcMain.on('window:home', () => createHomeWindow()); // open the launcher to switch/open a workspace

  // ---- one-click import of a folder's existing Claude sessions (#24) --------
  ipcMain.handle('workspace:scan', (e) => {
    const folder = folderOf(recFromEvent(e));
    const exclude = new Set();
    for (const rec of windows.values()) {
      if (normFolder(rec.state.workspace) !== normFolder(folder)) continue;
      for (const c of Object.values(rec.state.cells || {})) if (c && c.sessionId) exclude.add(c.sessionId);
    }
    return { folder, sessions: scanWorkspaceSessions(folder, exclude) };
  });
  ipcMain.on('workspace:importSeen', (e) => {
    settings.seenImport = settings.seenImport || {};
    settings.seenImport[normFolder(folderOf(recFromEvent(e)))] = true;
    saveSettings();
  });
  // Settings importer: browse every Claude project and pull specific sessions in (each resumes in
  // its own original folder, so nothing gets copied out of Claude's normal store).
  ipcMain.handle('sessions:projects', () => listProjects());
  ipcMain.handle('sessions:scanProject', (_e, dir) => ({ dir, sessions: scanProjectSessions(dir) }));
  // Resume an existing session into a live cell: kill whatever's there, then respawn with --resume.
  ipcMain.handle('cell:importSession', (e, index, sessionId, cwd, cols, rows) => {
    const rec = recFromEvent(e); if (!rec) return false;
    const gid = `${rec.state.windowId}#${index}`;
    const p = sessions.get(gid); if (p) { try { p.kill(); } catch (_) {} sessions.delete(gid); }
    const c = cellRec(rec, index); c.sessionId = sessionId; c.cwd = cwd || folderOf(rec);
    // Resume under whichever profile actually holds this transcript, so an imported session keeps
    // running as the account that owns it rather than the ambient default.
    const multi = claudeDirRegistry().length > 1;
    const sot = multi ? resolveSessionSoT(sessionId, c.cwd) : null;
    if (sot) c.configDir = sot.dir;
    scheduleWindowSave(rec);
    spawnCell(rec.state.windowId, index, { cwd: c.cwd, resumeId: sessionId, cols, rows, configDir: sot ? sot.dir : undefined });
    return true;
  });
  // ---- multi-account: Claude profiles --------------------------------------
  ipcMain.handle('profiles:list', () => claudeDirRegistry().map((p) => ({
    dir: p.dir, label: p.label, color: p.color, account: p.account, isDefault: p.isDefault,
  })));
  ipcMain.handle('profiles:add', async (e) => {
    const rec = recFromEvent(e);
    const r = await dialog.showOpenDialog(rec ? rec.win : null, {
      title: 'Add a Claude config directory (CLAUDE_CONFIG_DIR)', properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const dir = r.filePaths[0];
    settings.extraClaudeDirs = (settings.extraClaudeDirs || []).filter((d) => normFolder(d) !== normFolder(dir));
    settings.extraClaudeDirs.push(dir);
    // Un-hide it if it was previously dismissed, and give it hooks immediately — a profile without
    // them emits no signals, so cells bound to it would never glow or persist their session id.
    settings.claudeDirMeta = settings.claudeDirMeta || {};
    const key = normFolder(dir);
    if (settings.claudeDirMeta[key]) delete settings.claudeDirMeta[key].hidden;
    saveSettings();
    if (settings.autoHooks !== false) { try { hooks.installHooks(HOOK_SCRIPT, dir); } catch (_) {} }
    return dir;
  });
  // Hide a profile from the app (auto-discovered dirs can't be deleted, only dismissed). Cells
  // already bound to it keep working; it just stops appearing in the switch menu and the registry.
  ipcMain.on('profiles:hide', (_e, dir) => {
    const key = normFolder(dir);
    settings.extraClaudeDirs = (settings.extraClaudeDirs || []).filter((d) => normFolder(d) !== key);
    settings.claudeDirMeta = settings.claudeDirMeta || {};
    settings.claudeDirMeta[key] = { ...(settings.claudeDirMeta[key] || {}), hidden: true };
    saveSettings();
  });
  ipcMain.on('profiles:setMeta', (_e, dir, meta) => {
    settings.claudeDirMeta = settings.claudeDirMeta || {};
    const key = normFolder(dir);
    settings.claudeDirMeta[key] = { ...(settings.claudeDirMeta[key] || {}), ...(meta || {}) };
    saveSettings();
  });
  // What a cell is bound to, and where its transcript actually lives right now.
  ipcMain.handle('cell:profile', (e, index) => {
    const rec = recFromEvent(e); if (!rec) return null;
    const c = rec.state.cells[index] || {};
    const bound = c.configDir || rec.state.defaultConfigDir || null;
    const sot = c.sessionId ? resolveSessionSoT(c.sessionId, c.cwd) : null;
    const p = profileFor(bound || (sot && sot.dir));
    return {
      configDir: bound,
      profile: p ? { dir: p.dir, label: p.label, color: p.color, account: p.account } : null,
      sotDir: sot ? sot.dir : null,
      sotLabel: sot ? sot.profile.label : null,
    };
  });
  ipcMain.on('window:setDefaultProfile', (e, dir) => {
    const rec = recFromEvent(e); if (!rec) return;
    rec.state.defaultConfigDir = dir || null;
    saveWindowNow(rec);
  });
  // Move a live session to another Claude account: COPY its transcript into the target profile
  // (the original stays as a rollback), stamp the copy so "newest wins" makes the target the source
  // of truth, then relaunch the cell under that profile with --resume.
  // Can this cell's conversation actually be carried to another account? A cell that has merely
  // STARTED Claude already has a sessionId (the SessionStart hook sets it) but no transcript on
  // disk until a real turn happens — so "has a session id" is not the same as "has something to
  // port", and treating them as equal is what produced a bogus "no transcript found" error.
  ipcMain.handle('cell:portable', (e, index) => {
    const rec = recFromEvent(e); if (!rec) return { portable: false };
    const c = rec.state.cells[index] || {};
    if (!c.sessionId) return { portable: false };
    return { portable: !!resumeInfo(c.sessionId, c.cwd).ok, sessionId: c.sessionId };
  });
  // Move a cell to another Claude account. With `port` the transcript is COPIED into the target
  // profile (the original stays as a rollback) and resumed there; otherwise the cell simply rebinds
  // and starts a fresh conversation. A cell with nothing to port always takes the fresh path.
  ipcMain.handle('cell:switchProfile', (e, index, targetDir, cols, rows, opts = {}) => {
    const rec = recFromEvent(e); if (!rec) return { ok: false, error: 'no window' };
    if (!isDirectory(targetDir)) return { ok: false, error: 'that Claude directory no longer exists' };
    const c = cellRec(rec, index);
    // Portability must use the SAME test as cell:portable — a transcript merely EXISTING is not
    // enough, it needs a real user turn to be resumable. Deciding on file existence alone would
    // copy an empty transcript and hand `claude --resume` an id it will reject.
    const portable = c.sessionId ? resumeInfo(c.sessionId, c.cwd).ok : false;
    const sot = portable ? resolveSessionSoT(c.sessionId, c.cwd) : null;
    const wantPort = opts.port !== false;
    let resumeId;

    if (sot && wantPort) {
      // Resume only works from the folder the transcript was recorded under, so mirror that layout.
      const realCwd = cwdFromText(readHead(sot.file)) || c.cwd || folderOf(rec);
      const destDir = path.join(targetDir, 'projects', encodeProject(realCwd));
      const dest = path.join(destDir, `${c.sessionId}.jsonl`);
      if (normFolder(sot.file) !== normFolder(dest)) {
        try {
          fs.mkdirSync(destDir, { recursive: true });
          fs.copyFileSync(sot.file, dest);
          // The SoT rule is "newest mtime wins", so the copy MUST end up strictly newer than its
          // source. Don't rely on the copy's incidental mtime, and don't stamp a bare Date.now():
          // stored mtimes carry sub-millisecond precision while Date.now() is millisecond-resolution,
          // so a naive stamp can land BEHIND a source written moments earlier — which would leave
          // the stale original as the source of truth and resume the wrong copy.
          const stamp = Math.max(Date.now(), sot.mtime + 1000) / 1000;
          fs.utimesSync(dest, stamp, stamp);
        } catch (err) {
          return { ok: false, error: String((err && err.message) || err) };
        }
      }
      c.cwd = realCwd;
      resumeId = c.sessionId;
    } else {
      // Nothing to carry over, or the user asked for a clean start: drop the old session id so the
      // cell comes up as a new conversation and a later restart doesn't try to resume an id the
      // target profile has never seen.
      delete c.sessionId;
    }

    c.configDir = targetDir;
    scheduleWindowSave(rec);
    const gid = `${rec.state.windowId}#${index}`;
    const p = sessions.get(gid);
    if (p) { try { p.kill(); } catch (_) {} sessions.delete(gid); }
    spawnCell(rec.state.windowId, index, {
      cwd: c.cwd || folderOf(rec), resumeId, configDir: targetDir, cols, rows,
    });
    return { ok: true, ported: !!resumeId };
  });

  // Overflow import: create a new window whose cells are pre-seeded to resume `sessionList`.
  ipcMain.handle('window:newWithSessions', (e, sessionList) => {
    if (!Array.isArray(sessionList) || !sessionList.length) return null;
    const folder = folderOf(recFromEvent(e));
    const { n, id } = nextWindowInfo(folder);
    const L = pickFitLayout(sessionList.length);
    const st = defaultWindowState(id, n, folder);
    st.layout = { rows: L.rows, cols: L.cols };
    const total = Math.max(L.rows * L.cols, sessionList.length);
    st.panes = [];
    for (let i = 0; i < total; i++) {
      const sid = String(i);
      if (i < sessionList.length) {
        const s = sessionList[i];
        st.cells[sid] = { sessionId: s.sessionId, cwd: s.cwd || folder };
        if (s.title) st.cells[sid].name = s.title;
      }
      st.panes.push({ tabs: [sid], active: sid });
    }
    st.seq = total;
    writeJsonAtomic(windowStateFile(id), st);
    createWindow(st);
    return id;
  });
  ipcMain.on('app:relaunch', () => { for (const rec of windows.values()) saveWindowNow(rec); app.relaunch(); app.exit(0); });
  ipcMain.on('open:external', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });
  ipcMain.on('cell:openInVsCode', (e, index) => {
    const rec = recFromEvent(e); if (!rec) return;
    const dir = (rec.state.cells[index] && rec.state.cells[index].cwd) || folderOf(rec);
    try { require('child_process').spawn('code', [dir], { shell: true, detached: true, stdio: 'ignore' }).unref(); } catch (_) {}
  });

  // windows — a new window belongs to the SAME folder as the one it was opened from.
  ipcMain.on('window:new', (e) => { newWindowForFolder(folderOf(recFromEvent(e))); });
  ipcMain.handle('windows:list', (e) => {
    const rec = recFromEvent(e);
    const folder = folderOf(rec);
    const wins = listFolderWindows(folder).map((w) => ({ ...w, current: !!(rec && w.windowId === rec.state.windowId) }));
    return { folder, windows: wins };
  });
  ipcMain.on('window:focus', (_e, id) => { const r = windows.get(id); if (r && r.win && !r.win.isDestroyed()) { if (r.win.isMinimized()) r.win.restore(); r.win.focus(); } });
  ipcMain.on('window:openExisting', (_e, id) => openExistingWindow(id));
  ipcMain.on('window:rename', (e, title) => {
    const rec = recFromEvent(e); if (!rec) return;
    rec.state.title = String(title || '').trim() || rec.state.title;
    saveWindowNow(rec);
    if (!rec.win.isDestroyed()) rec.win.setTitle(`${rec.state.title} - HNA-Code`);
  });
  ipcMain.on('window:remove', (e) => {
    const rec = recFromEvent(e); if (!rec) return;
    rec.removed = true;
    try { fs.rmSync(windowStateFile(rec.state.windowId), { force: true }); } catch (_) {}
    rec.win.close();
  });

  // Open to the launcher (home page) by default. A forced folder (env) or a test that opts out of
  // the home flow jumps straight into the workspace grid.
  const bootStraightToGrid = !!process.env.CW_ROOT_FOLDER || !!process.env.CW_SKIP_HOME;
  if (bootStraightToGrid) openSavedWindows(currentWorkspace);
  else createHomeWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createHomeWindow();
  });
});

app.on('window-all-closed', () => {
  for (const p of sessions.values()) { try { p.kill(); } catch (_) {} }
  sessions.clear();
  app.quit();
});
