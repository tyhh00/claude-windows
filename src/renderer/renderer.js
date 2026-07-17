// Renderer: build a grid of live terminals, one PTY per cell.
// Restores layout, names, and glow from persisted state; notifies main of changes to persist.

const TerminalCtor = window.Terminal;
const FitAddonCtor = window.FitAddon.FitAddon;

const THEME = {
  background: '#000000',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
  selectionBackground: '#264f78',
};

// Claude "spark" mark shown to the left of each cell name.
const CLAUDE_MARK =
  '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">' +
  '<g stroke="#d97757" stroke-width="2.2" stroke-linecap="round">' +
  '<line x1="12" y1="3.5" x2="12" y2="20.5"/>' +
  '<line x1="4.4" y1="7.75" x2="19.6" y2="16.25"/>' +
  '<line x1="4.4" y1="16.25" x2="19.6" y2="7.75"/>' +
  '</g><circle cx="12" cy="12" r="2.5" fill="#e8a893"/></svg>';

const cells = new Map();        // cellId (number) -> { term, fit, el }
window.__cellTerms = {};
window.__launch = {};           // cellId -> {line, cwd, resumeId} (test hook)

const gridEl = document.getElementById('grid');
const statusEl = document.getElementById('status');

const REPO_URL = 'https://github.com/tyhh00/claude-windows';
const LAYOUTS = [
  { key: '2x4', rows: 2, cols: 4, group: 'Landscape' },
  { key: '3x4', rows: 3, cols: 4, group: 'Landscape' },
  { key: '4x4', rows: 4, cols: 4, group: 'Landscape' },
  { key: '2x2', rows: 2, cols: 2, group: 'Landscape' },
  { key: '4x2', rows: 4, cols: 2, group: 'Portrait (vertical monitor)' },
  { key: '6x2', rows: 6, cols: 2, group: 'Portrait (vertical monitor)' },
  { key: '8x2', rows: 8, cols: 2, group: 'Portrait (vertical monitor)' },
  { key: '6x1', rows: 6, cols: 1, group: 'Portrait (vertical monitor)' },
];
let currentLayout = { rows: 3, cols: 4 };

// A little grid glyph for a layout, drawn as rows x cols mini rectangles.
function layoutIcon(rows, cols, w = 26, h = 18) {
  const pad = 2, gap = 1.5;
  const cw = (w - 2 * pad - (cols - 1) * gap) / cols;
  const ch = (h - 2 * pad - (rows - 1) * gap) / rows;
  let rects = '';
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = pad + c * (cw + gap), y = pad + r * (ch + gap);
    rects += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cw.toFixed(1)}" height="${ch.toFixed(1)}" rx="1"/>`;
  }
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${rects}</svg>`;
}

// Local mirror of settings + saved cell data (populated from main on boot).
const settings = {
  glowEnabled: true,
  glowOn: 'idle',
  launch: { command: 'claude', shell: 'auto' },
  doneSound: { enabled: false, path: null },
  permissionSound: { enabled: false, path: null },
};
const persistSettings = () => window.grid.settingsChanged(settings);
let savedCells = {};            // cellId(string) -> { sessionId, cwd, name, glow }

// ---- Glow ------------------------------------------------------------------
const glowState = new Map();
window.__glow = {};

function setGlow(i, s, { persist = true } = {}) {
  const c = cells.get(i);
  if (!c) return;
  glowState.set(i, s);
  window.__glow[i] = s;
  c.el.classList.toggle('glow-idle', s === 'idle');
  c.el.classList.toggle('glow-permission', s === 'permission');
  if (persist) window.grid.glowChanged(String(i), s);
}
function clearGlow(i) {
  if (glowState.get(i) && glowState.get(i) !== 'none') setGlow(i, 'none');
}

const audio = { done: new Audio(), permission: new Audio() };
function playSound(which) {
  const cfg = which === 'done' ? settings.doneSound : settings.permissionSound;
  const a = audio[which];
  if (!cfg.enabled || !a.src) return;
  try { a.currentTime = 0; a.play(); } catch (_) {}
}
async function loadSoundInto(which, p) {
  if (!p) { audio[which].removeAttribute('src'); return; }
  const dataUrl = await window.grid.loadSound(p);
  if (dataUrl) audio[which].src = dataUrl;
}

// ---- Cells -----------------------------------------------------------------
function setName(i, name) {
  const c = cells.get(i);
  if (c) c.el.querySelector('.cell-name').textContent = name;
}

function startRename(nameEl, i) {
  nameEl.setAttribute('contenteditable', 'true');
  nameEl.focus();
  const r = document.createRange();
  r.selectNodeContents(nameEl);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  nameEl.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
    if (e.key === 'Escape') { nameEl.textContent = nameEl.dataset.prev || nameEl.textContent; nameEl.blur(); }
    e.stopPropagation();
  };
  nameEl.onblur = () => {
    nameEl.setAttribute('contenteditable', 'false');
    const name = (nameEl.textContent || '').replace(/\s+/g, ' ').trim() || `Cell ${i + 1}`;
    nameEl.textContent = name;
    window.grid.rename(String(i), name);
  };
  nameEl.dataset.prev = nameEl.textContent;
}

function wireHeader(i, el) {
  const nameEl = el.querySelector('.cell-name');
  nameEl.addEventListener('dblclick', () => startRename(nameEl, i));
  // Right-click anywhere on the header (except the VS Code button) renames.
  el.querySelector('.cell-header').addEventListener('contextmenu', (e) => {
    if (e.target.closest('.cell-code')) return;
    e.preventDefault();
    startRename(nameEl, i);
  });
  el.querySelector('.cell-code').addEventListener('click', () => window.grid.openInVsCode(String(i)));
}

function createCell(i) {
  const id = String(i);
  const saved = savedCells[id] || {};

  const el = document.createElement('div');
  el.className = 'cell';
  el.dataset.cell = id;
  el.innerHTML =
    `<div class="cell-header">` +
      `<span class="cell-mark">${CLAUDE_MARK}</span>` +
      `<span class="cell-name" title="Right-click or double-click to rename"></span>` +
      `<span class="cell-perf"></span>` +
      `<button class="cell-code" title="Open folder in VS Code">&lt;/&gt;</button>` +
    `</div>` +
    `<div class="term"></div>`;
  gridEl.appendChild(el);

  const nameEl = el.querySelector('.cell-name');
  nameEl.textContent = saved.name || `Cell ${i + 1}`;
  wireHeader(i, el);

  const term = new TerminalCtor({
    fontSize: 13,
    fontFamily: 'Cascadia Mono, Consolas, monospace',
    cursorBlink: true,
    theme: THEME,
    scrollback: 5000,
  });
  const fit = new FitAddonCtor();
  term.loadAddon(fit);
  term.open(el.querySelector('.term'));
  fit.fit();

  window.__cellTerms[id] = term;
  cells.set(i, { term, fit, el });

  window.grid.cellReady(id, term.cols, term.rows);
  // Forward ALL bytes to the PTY, including xterm's automatic replies to escape-sequence
  // queries (e.g. cursor-position reports) — those are not user input.
  term.onData((data) => window.grid.sendInput(id, data));
  // Only a real keypress means you've engaged this session, so clear glow here (not onData).
  term.onKey(() => clearGlow(i));

  // Restore glow (R6) without re-persisting.
  if (saved.glow && saved.glow !== 'none') setGlow(i, saved.glow, { persist: false });
}

function disposeCell(i) {
  const c = cells.get(i);
  if (!c) return;
  window.grid.disposeCell(String(i));
  try { c.term.dispose(); } catch (_) {}
  c.el.remove();
  delete window.__cellTerms[String(i)];
  glowState.delete(i);
  cells.delete(i);
}

// ---- Wiring ----------------------------------------------------------------
window.grid.onLaunched((cellId, info) => { window.__launch[cellId] = info; });

// Performance meter updates (only sent when perfView is on).
window.__perf = {};
window.grid.onPerf((data) => {
  window.__perf = data;
  for (const [i, c] of cells) {
    const p = data.cells && data.cells[String(i)];
    const el = c.el.querySelector('.cell-perf');
    if (el) el.textContent = p ? `${p.cpu}% · ${p.mem}MB` : '';
  }
  const totalEl = document.getElementById('perf-total');
  if (totalEl && data.total) totalEl.textContent = `Σ ${data.total.cpu}% · ${data.total.mem}MB`;
});
function applyPerfClass() { document.body.classList.toggle('perf-on', !!settings.perfView); }

window.__signals = [];
window.grid.onSignal((sig) => {
  window.__signals.push(sig);
  const i = Number(sig.cell);
  if (Number.isNaN(i) || !cells.has(i)) return;
  if (!settings.glowEnabled) return;

  switch (sig.kind) {
    case 'stop':  // end of a turn — the reliable "Claude finished, your move" signal
    case 'idle':  // Claude explicitly idle-waiting on you
      // 'idle' mode glows on both; 'stop' mode is the same here. permission always glows blue.
      if (settings.glowOn !== 'permission-only') { setGlow(i, 'idle'); playSound('done'); }
      break;
    case 'permission':
      setGlow(i, 'permission'); playSound('permission'); break;
    case 'start':
      clearGlow(i); break;
  }
});

window.grid.onData((id, data) => {
  const c = cells.get(Number(id));
  if (c) c.term.write(data);
});
window.grid.onExit((id) => {
  const c = cells.get(Number(id));
  if (c) c.term.write('\r\n\x1b[31m[process exited]\x1b[0m\r\n');
});

function refitAll() {
  for (const [i, c] of cells) {
    c.fit.fit();
    window.grid.resize(String(i), c.term.cols, c.term.rows);
  }
}

function applyLayout(rows, cols) {
  gridEl.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  gridEl.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  const count = rows * cols;
  for (const i of [...cells.keys()]) if (i >= count) disposeCell(i);
  for (let i = 0; i < count; i++) if (!cells.has(i)) createCell(i);
  statusEl.textContent = `${count} sessions (${rows}×${cols})`;
  requestAnimationFrame(() => requestAnimationFrame(refitAll));
}

function updateLayoutBtn(L) {
  document.getElementById('layout-btn').innerHTML =
    `<span class="layout-ico">${layoutIcon(L.rows, L.cols, 22, 16)}</span><span>${L.rows} × ${L.cols}</span>`;
}
function updateLayoutMenuActive(key) {
  document.querySelectorAll('#layout-menu .menu-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.key === key);
  });
}
function setLayout(key, { persist = true } = {}) {
  let L = LAYOUTS.find((l) => l.key === key);
  if (!L) { const m = /^(\d+)x(\d+)$/.exec(key); if (m) L = { key, rows: +m[1], cols: +m[2] }; }
  if (!L) return;
  currentLayout = { rows: L.rows, cols: L.cols };
  applyLayout(L.rows, L.cols);
  updateLayoutBtn(L);
  updateLayoutMenuActive(L.key);
  if (persist) window.grid.layoutChanged(L.rows, L.cols);
}
window.__setLayout = (key) => setLayout(key); // test hook

function buildLayoutPicker() {
  const btn = document.getElementById('layout-btn');
  const menu = document.getElementById('layout-menu');
  let html = '', lastGroup = null;
  for (const L of LAYOUTS) {
    if (L.group !== lastGroup) { html += `<div class="group-label">${L.group}</div>`; lastGroup = L.group; }
    html += `<div class="menu-item" data-key="${L.key}">` +
      `<span class="layout-ico">${layoutIcon(L.rows, L.cols)}</span>` +
      `<span>${L.rows} × ${L.cols} &nbsp;<span style="color:#888">(${L.rows * L.cols})</span></span></div>`;
  }
  menu.innerHTML = html;
  menu.querySelectorAll('.menu-item').forEach((el) => {
    el.addEventListener('click', () => { setLayout(el.dataset.key); menu.classList.remove('open'); });
  });
  btn.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('open'); });
  document.addEventListener('click', () => menu.classList.remove('open'));
}

function buildHelpMenu() {
  const btn = document.getElementById('help-btn');
  const menu = document.getElementById('help-menu');
  menu.innerHTML =
    `<div class="menu-item" data-act="github">GitHub repo</div>` +
    `<div class="menu-item" data-act="issues">Report an issue</div>` +
    `<div class="menu-item" data-act="remove" style="color:#e07a7a">Remove this window</div>`;
  menu.querySelectorAll('.menu-item').forEach((el) => {
    el.addEventListener('click', () => {
      if (el.dataset.act === 'github') window.grid.openExternal(REPO_URL);
      if (el.dataset.act === 'issues') window.grid.openExternal(REPO_URL + '/issues');
      if (el.dataset.act === 'remove') window.grid.removeWindow();
      menu.classList.remove('open');
    });
  });
  btn.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('open'); });
  document.addEventListener('click', () => menu.classList.remove('open'));
}

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(refitAll, 100);
});

// ---- Settings panel --------------------------------------------------------
function initSettingsUI() {
  const $ = (id) => document.getElementById(id);
  const overlay = $('settings-overlay');
  const open = () => overlay.classList.add('open');
  const close = () => overlay.classList.remove('open');

  $('settings-btn').addEventListener('click', open);
  $('settings-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  // Reflect current settings into the controls.
  $('set-glow-enabled').checked = !!settings.glowEnabled;
  $('set-glow-on').value = settings.glowOn || 'idle';
  $('set-launch').value = (settings.launch && settings.launch.command) || 'claude';
  $('set-done-enabled').checked = !!settings.doneSound.enabled;
  $('set-perm-enabled').checked = !!settings.permissionSound.enabled;
  $('set-perf').checked = !!settings.perfView;
  $('done-file').textContent = settings.doneSound.path ? fileName(settings.doneSound.path) : 'no file';
  $('perm-file').textContent = settings.permissionSound.path ? fileName(settings.permissionSound.path) : 'no file';

  $('set-glow-enabled').addEventListener('change', (e) => { settings.glowEnabled = e.target.checked; persistSettings(); });
  $('set-glow-on').addEventListener('change', (e) => { settings.glowOn = e.target.value; persistSettings(); });
  $('set-launch').addEventListener('change', (e) => {
    settings.launch = { ...(settings.launch || {}), command: e.target.value.trim() || 'claude' };
    persistSettings();
  });
  $('set-done-enabled').addEventListener('change', (e) => { settings.doneSound.enabled = e.target.checked; persistSettings(); });
  $('set-perm-enabled').addEventListener('change', (e) => { settings.permissionSound.enabled = e.target.checked; persistSettings(); });
  $('set-perf').addEventListener('change', (e) => { settings.perfView = e.target.checked; persistSettings(); applyPerfClass(); });

  const pick = async (which) => {
    const r = await window.grid.pickSound();
    if (!r) return;
    const cfg = which === 'done' ? settings.doneSound : settings.permissionSound;
    cfg.path = r.path;
    if (r.dataUrl) audio[which].src = r.dataUrl;
    $(which === 'done' ? 'done-file' : 'perm-file').textContent = fileName(r.path);
    persistSettings();
  };
  $('done-pick').addEventListener('click', () => pick('done'));
  $('perm-pick').addEventListener('click', () => pick('permission'));
  $('done-test').addEventListener('click', () => { const a = audio.done; if (a.src) { a.currentTime = 0; a.play().catch(() => {}); } });
  $('perm-test').addEventListener('click', () => { const a = audio.permission; if (a.src) { a.currentTime = 0; a.play().catch(() => {}); } });

  const hooksStatus = $('hooks-status');
  $('hooks-connect').addEventListener('click', async () => {
    try { await window.grid.installHooks(); hooksStatus.textContent = 'Connected ✓ (restart Claude sessions to activate)'; }
    catch (_) { hooksStatus.textContent = 'Failed to connect hooks'; }
  });
  $('hooks-disconnect').addEventListener('click', async () => {
    try { await window.grid.uninstallHooks(); hooksStatus.textContent = 'Disconnected'; }
    catch (_) { hooksStatus.textContent = 'Failed to disconnect hooks'; }
  });
}
function fileName(p) { return String(p).split(/[\\/]/).pop(); }

function shortFolder(p) {
  if (!p) return 'home';
  return String(p).split(/[\\/]/).filter(Boolean).pop() || p;
}
async function initFolderUI() {
  const btn = document.getElementById('folder-btn');
  const label = document.getElementById('folder-name');
  const root = await window.grid.getRoot();
  label.textContent = shortFolder(root);
  btn.title = `New sessions start in:\n${root}\n(click to change — reopens the app)`;
  btn.addEventListener('click', async () => {
    const dir = await window.grid.pickRoot();
    if (!dir) return;
    label.textContent = shortFolder(dir);
    window.grid.relaunchApp(); // reopen so fresh sessions start in the new folder
  });
}

async function initWindowUI() {
  const info = await window.grid.windowInfo();
  const titleEl = document.getElementById('win-title');
  if (info) {
    window.__windowId = info.windowId;
    window.__windowTitle = info.title;
    titleEl.textContent = info.title;
  }
  titleEl.addEventListener('dblclick', () => {
    titleEl.setAttribute('contenteditable', 'true');
    titleEl.focus();
    const r = document.createRange(); r.selectNodeContents(titleEl);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  titleEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); }
    e.stopPropagation();
  });
  titleEl.addEventListener('blur', () => {
    titleEl.setAttribute('contenteditable', 'false');
    const t = (titleEl.textContent || '').replace(/\s+/g, ' ').trim() || (window.__windowTitle || 'window');
    titleEl.textContent = t;
    window.__windowTitle = t;
    window.grid.renameWindow(t);
  });
  document.getElementById('new-window-btn').addEventListener('click', () => window.grid.newWindow());
}

function afterSettings() {
  window.__settings = settings; // test hook
  loadSoundInto('done', settings.doneSound && settings.doneSound.path);
  loadSoundInto('permission', settings.permissionSound && settings.permissionSound.path);
  initSettingsUI();
  initFolderUI();
  initWindowUI();
  applyPerfClass();
}

// ---- Boot: pull persisted state, then build the grid -----------------------
(async function boot() {
  try {
    const st = await window.grid.getState();
    if (st) {
      Object.assign(settings, st.settings || {});
      savedCells = st.cells || {};
      const { rows, cols } = st.layout || { rows: 3, cols: 4 };
      buildLayoutPicker();
      buildHelpMenu();
      setLayout(`${rows}x${cols}`, { persist: false });
      afterSettings();
      window.__ready = true;
      return;
    }
  } catch (_) {}
  buildLayoutPicker();
  buildHelpMenu();
  setLayout('3x4', { persist: false });
  afterSettings();
  window.__ready = true;
})();
