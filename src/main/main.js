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

const HOOK_SCRIPT = path.join(__dirname, '..', 'hooks', 'signal.ps1');
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
  doneSound: { enabled: false, path: null },
  permissionSound: { enabled: false, path: null },
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

function windowsDir() { return path.join(app.getPath('userData'), 'windows'); }
function windowStateFile(id) { return path.join(windowsDir(), `${id}.json`); }
function defaultWindowState(id, n) {
  return { windowId: id, title: `window-${n}`, layout: { rows: 3, cols: 4 }, rootFolder: null, cells: {}, panes: [], seq: 0 };
}
function nextWindowNumber() {
  let max = 0;
  for (const id of windows.keys()) { const m = /^w(\d+)$/.exec(id); if (m) max = Math.max(max, +m[1]); }
  try { for (const f of fs.readdirSync(windowsDir())) { const m = /^w(\d+)\.json$/.exec(f); if (m) max = Math.max(max, +m[1]); } } catch (_) {}
  return max + 1;
}
function scheduleWindowSave(rec) {
  clearTimeout(rec.saveTimer);
  rec.saveTimer = setTimeout(() => writeJsonAtomic(windowStateFile(rec.state.windowId), rec.state), 400);
}
function saveWindowNow(rec) { writeJsonAtomic(windowStateFile(rec.state.windowId), rec.state); }
function recFromEvent(e) { const id = wcToWin.get(e.sender.id); return id ? windows.get(id) : null; }
// Guarded send: never throw if the window/webContents was destroyed mid-teardown.
function sendTo(rec, channel, ...args) {
  try {
    if (rec && rec.win && !rec.win.isDestroyed() && !rec.win.webContents.isDestroyed()) {
      rec.win.webContents.send(channel, ...args);
    }
  } catch (_) {}
}
function cellRec(rec, index) { const c = rec.state.cells; if (!c[index]) c[index] = {}; return c[index]; }
function effectiveRoot(rec) {
  const r = (rec && rec.state.rootFolder) || process.env.CW_ROOT_FOLDER;
  try { if (r && fs.existsSync(r)) return r; } catch (_) {}
  return defaultCwd();
}
function launchBase() {
  const v = process.env.CW_LAUNCH_CMD;
  if (v !== undefined) return v === 'SHELL' ? '' : v;
  return (settings.launch && settings.launch.command) || 'claude';
}

function createWindow(state) {
  const win = new BrowserWindow({
    width: 1280, height: 820, backgroundColor: '#1e1e1e',
    title: `${state.title} - Claude Windows`,
    icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  const wcId = win.webContents.id; // capture now; webContents is gone by 'closed'
  const rec = { win, wcId, state, saveTimer: null, removed: false };
  windows.set(state.windowId, rec);
  wcToWin.set(wcId, state.windowId);

  // Zoom in/out/reset that actually works for + as well as -, and never reloads the grid.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta)) return;
    const wc = win.webContents;
    const set = (lvl) => wc.setZoomLevel(Math.max(-3, Math.min(4, lvl)));
    if (input.key === '=' || input.key === '+') { set(wc.getZoomLevel() + 0.5); event.preventDefault(); }
    else if (input.key === '-' || input.key === '_') { set(wc.getZoomLevel() - 0.5); event.preventDefault(); }
    else if (input.key === '0') { set(0); event.preventDefault(); }
  });

  win.on('close', () => { if (!rec.removed) saveWindowNow(rec); });
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

function openSavedWindows() {
  let states = [];
  try {
    for (const f of fs.readdirSync(windowsDir())) {
      if (!f.endsWith('.json')) continue;
      try { states.push(JSON.parse(fs.readFileSync(path.join(windowsDir(), f), 'utf8'))); } catch (_) {}
    }
  } catch (_) {}
  states.sort((a, b) => String(a.windowId).localeCompare(String(b.windowId), undefined, { numeric: true }));
  if (states.length === 0) {
    const st = defaultWindowState('w1', 1);
    writeJsonAtomic(windowStateFile('w1'), st);
    states = [st];
  }
  for (const st of states) if (!windows.has(st.windowId)) createWindow(st);
}

function spawnCell(windowId, index, opts = {}) {
  const rec = windows.get(windowId);
  if (!rec) return;
  const gid = `${windowId}#${index}`;
  let cwd = opts.cwd || effectiveRoot(rec);
  try { if (!fs.existsSync(cwd)) cwd = defaultCwd(); } catch (_) { cwd = defaultCwd(); }
  const base = launchBase();
  const line = opts.resumeId && base ? `${base} --resume ${opts.resumeId}` : base;
  const args = line && line.trim() ? ['-NoLogo', '-NoExit', '-Command', line] : [];

  const proc = pty.spawn('powershell.exe', args, {
    name: 'xterm-256color',
    cols: opts.cols || 80, rows: opts.rows || 24, cwd,
    env: { ...process.env, CC_CELL_ID: gid, CC_SIGNAL_PORT: String(signal.port), CC_SIGNAL_TOKEN: signal.token },
  });
  proc.onData((d) => sendTo(windows.get(windowId), 'pty:data', index, d));
  proc.onExit(() => { sessions.delete(gid); sendTo(windows.get(windowId), 'pty:exit', index); });
  sessions.set(gid, proc);
  sendTo(rec, 'cell:launched', index, { line, cwd, resumeId: opts.resumeId || null });
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
// One PowerShell/CIM query per tick; only runs while settings.perfView is on.
const { spawn: cpSpawn } = require('child_process');
let perfTimer = null;
let perfBusy = false;
const PERF_PS =
  '$parent=@{}; Get-CimInstance Win32_Process | ForEach-Object { $parent[[int]$_.ProcessId]=[int]$_.ParentProcessId };' +
  'Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.IDProcess -ne 0 } | ForEach-Object {' +
  ' [pscustomobject]@{ p=[int]$_.IDProcess; pp=$parent[[int]$_.IDProcess]; c=[int]$_.PercentProcessorTime; m=[long]$_.WorkingSet } } | ConvertTo-Json -Compress';

function samplePerf() {
  if (perfBusy) return;
  perfBusy = true;
  let out = '';
  const ps = cpSpawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', PERF_PS], { windowsHide: true });
  ps.stdout.on('data', (d) => (out += d));
  ps.on('error', () => { perfBusy = false; });
  ps.on('close', () => {
    perfBusy = false;
    let list;
    try { const j = JSON.parse(out); list = Array.isArray(j) ? j : [j]; } catch (_) { return; }
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
  Menu.setApplicationMenu(null); // we handle zoom ourselves; avoids accidental Ctrl+R reload
  loadSettings();
  if (settings.autoHooks !== false) { try { hooks.installHooks(HOOK_SCRIPT); } catch (_) {} }
  await initSignal();
  applyPerfSetting();

  ipcMain.handle('state:get', (e) => { const rec = recFromEvent(e); return rec ? { ...rec.state, settings } : { settings }; });
  ipcMain.handle('window:info', (e) => { const rec = recFromEvent(e); return rec ? { windowId: rec.state.windowId, title: rec.state.title } : null; });

  ipcMain.handle('hooks:install', () => hooks.installHooks(HOOK_SCRIPT));
  ipcMain.handle('hooks:uninstall', () => hooks.uninstallHooks(HOOK_SCRIPT));

  ipcMain.on('cell:ready', (e, index, cols, rows) => {
    const rec = recFromEvent(e); if (!rec) return;
    if (sessions.has(`${rec.state.windowId}#${index}`)) return;
    const saved = rec.state.cells[index] || {};
    spawnCell(rec.state.windowId, index, { cols, rows, cwd: saved.cwd, resumeId: saved.sessionId });
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

  // folder (per window)
  ipcMain.handle('root:pick', async (e) => {
    const rec = recFromEvent(e); if (!rec) return null;
    const r = await dialog.showOpenDialog(rec.win, { title: 'Open folder', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    rec.state.rootFolder = r.filePaths[0]; saveWindowNow(rec);
    return r.filePaths[0];
  });
  ipcMain.handle('root:get', (e) => effectiveRoot(recFromEvent(e)));
  ipcMain.on('app:relaunch', () => { app.relaunch(); app.exit(0); });
  ipcMain.on('open:external', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });
  ipcMain.on('cell:openInVsCode', (e, index) => {
    const rec = recFromEvent(e); if (!rec) return;
    const dir = (rec.state.cells[index] && rec.state.cells[index].cwd) || effectiveRoot(rec);
    try { require('child_process').spawn('code', [dir], { shell: true, detached: true, stdio: 'ignore' }).unref(); } catch (_) {}
  });

  // windows
  ipcMain.on('window:new', () => {
    const n = nextWindowNumber(); const id = `w${n}`;
    const st = defaultWindowState(id, n);
    writeJsonAtomic(windowStateFile(id), st);
    createWindow(st);
  });
  ipcMain.on('window:rename', (e, title) => {
    const rec = recFromEvent(e); if (!rec) return;
    rec.state.title = String(title || '').trim() || rec.state.title;
    saveWindowNow(rec);
    if (!rec.win.isDestroyed()) rec.win.setTitle(`${rec.state.title} - Claude Windows`);
  });
  ipcMain.on('window:remove', (e) => {
    const rec = recFromEvent(e); if (!rec) return;
    rec.removed = true;
    try { fs.rmSync(windowStateFile(rec.state.windowId), { force: true }); } catch (_) {}
    rec.win.close();
  });

  openSavedWindows();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) openSavedWindows(); });
});

app.on('window-all-closed', () => {
  for (const p of sessions.values()) { try { p.kill(); } catch (_) {} }
  sessions.clear();
  app.quit();
});
