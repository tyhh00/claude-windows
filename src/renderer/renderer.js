// Renderer: a grid of PANES; each pane holds a stack of session terminals as TABS.
// Shrinking the layout moves orphaned sessions into tabs (never kills them). Sessions keep a
// stable id so glow/resume/persistence all key off the session, not the pane position.

const TerminalCtor = window.Terminal;
const FitAddonCtor = window.FitAddon.FitAddon;

const THEME = { background: '#000000', foreground: '#d4d4d4', cursor: '#d4d4d4', selectionBackground: '#264f78' };

const CLAUDE_MARK =
  '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">' +
  '<g stroke="#d97757" stroke-width="2.2" stroke-linecap="round">' +
  '<line x1="12" y1="3.5" x2="12" y2="20.5"/><line x1="4.4" y1="7.75" x2="19.6" y2="16.25"/>' +
  '<line x1="4.4" y1="16.25" x2="19.6" y2="7.75"/></g><circle cx="12" cy="12" r="2.5" fill="#e8a893"/></svg>';

const terms = new Map();  // sid -> { sid, term, fit, wrap, termEl, opened, name, glow, pendingGlow }
let panes = [];           // index -> { el, tabsEl, bodyEl, perfEl, tabs:[sid], active:sid }
let seq = 0;              // next fresh session id
let savedState = null;

window.__cellTerms = {};
window.__launch = {};
window.__glow = {};
window.__perf = {};
window.__signals = [];

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

const settings = {
  glowEnabled: true, glowOn: 'idle',
  launch: { command: 'claude', shell: 'auto' },
  doneSound: { enabled: false, path: null },
  permissionSound: { enabled: false, path: null },
};
const persistSettings = () => window.grid.settingsChanged(settings);

// ---- sounds ----------------------------------------------------------------
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

// ---- sessions + panes ------------------------------------------------------
const countSessions = () => terms.size;
const paneOf = (sid) => panes.find((p) => p && p.tabs.includes(sid));
const defaultName = (sid) => (/^\d+$/.test(sid) ? `Cell ${Number(sid) + 1}` : 'Claude');

function createSession(sid, saved = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'term-wrap';
  wrap.dataset.sid = sid;
  wrap.style.display = 'none';
  const termEl = document.createElement('div');
  termEl.className = 'term';
  wrap.appendChild(termEl);

  const term = new TerminalCtor({
    fontSize: 13, fontFamily: 'Cascadia Mono, Consolas, monospace',
    cursorBlink: true, theme: THEME, scrollback: 5000,
  });
  const fit = new FitAddonCtor();
  term.loadAddon(fit);

  const rec = {
    sid, term, fit, wrap, termEl, opened: false,
    name: saved.name || defaultName(sid), glow: 'none',
    pendingGlow: saved.glow && saved.glow !== 'none' ? saved.glow : null,
  };
  terms.set(sid, rec);
  window.__cellTerms[sid] = term;

  term.onData((d) => window.grid.sendInput(sid, d));   // forward all bytes (incl. auto-replies)
  term.onKey(() => clearGlow(sid));                    // real keypress -> you've engaged
  return rec;
}

function createPane(i) {
  const el = document.createElement('div');
  el.className = 'cell';
  el.dataset.pane = String(i);
  el.innerHTML =
    `<div class="cell-header">` +
      `<span class="cell-mark">${CLAUDE_MARK}</span>` +
      `<div class="tabs"></div>` +
      `<span class="cell-perf"></span>` +
      `<button class="cell-code" title="Open folder in VS Code">&lt;/&gt;</button>` +
    `</div><div class="pane-body"></div>`;
  gridEl.appendChild(el);
  const pane = {
    el, tabsEl: el.querySelector('.tabs'), bodyEl: el.querySelector('.pane-body'),
    perfEl: el.querySelector('.cell-perf'), tabs: [], active: null,
  };
  el.querySelector('.cell-code').addEventListener('click', () => { if (pane.active) window.grid.openInVsCode(pane.active); });
  el.querySelector('.cell-header').addEventListener('contextmenu', (e) => {
    if (e.target.closest('.cell-code') || e.target.closest('.cell-name')) return;
    e.preventDefault();
    if (pane.active) { const span = pane.tabsEl.querySelector('.tab.active .cell-name'); if (span) startRename(span, pane.active); }
  });
  panes[i] = pane;
  return pane;
}

function renderTabs(pane) {
  if (pane.tabsEl.querySelector('[contenteditable="true"]')) return; // don't clobber an in-progress rename
  pane.tabsEl.innerHTML = '';
  for (const sid of pane.tabs) {
    const rec = terms.get(sid);
    if (!rec) continue;
    const tab = document.createElement('div');
    tab.className = 'tab' + (sid === pane.active ? ' active' : '');
    if (sid !== pane.active && rec.glow !== 'none') tab.classList.add('tab-' + rec.glow);
    const nameSpan = document.createElement('span');
    nameSpan.className = 'cell-name';
    nameSpan.title = 'Click to switch · double-click to rename';
    nameSpan.textContent = rec.name;
    tab.appendChild(nameSpan);
    if (pane.tabs.length > 1) {
      const x = document.createElement('span');
      x.className = 'tab-close'; x.textContent = '×'; x.title = 'Close session';
      x.addEventListener('click', (e) => { e.stopPropagation(); closeTab(pane, sid); });
      tab.appendChild(x);
    }
    tab.addEventListener('click', () => setActive(pane, sid));
    nameSpan.addEventListener('dblclick', (e) => { e.stopPropagation(); startRename(nameSpan, sid); });
    pane.tabsEl.appendChild(tab);
  }
}

function updatePaneGlow(pane) {
  const g = pane.active ? (terms.get(pane.active)?.glow || 'none') : 'none';
  pane.el.classList.toggle('glow-idle', g === 'idle');
  pane.el.classList.toggle('glow-permission', g === 'permission');
}

function setActive(pane, sid) {
  const changed = pane.active !== sid;
  pane.active = sid;
  pane.el.dataset.cell = sid;
  for (const s of pane.tabs) { const r = terms.get(s); if (r) r.wrap.style.display = (s === sid) ? 'block' : 'none'; }
  // Only rebuild the tab DOM when the active tab actually changed — otherwise a click that
  // precedes a double-click-to-rename would destroy the name element mid-gesture.
  if (changed) renderTabs(pane);
  updatePaneGlow(pane);
  const rec = terms.get(sid);
  if (rec && rec.opened) { rec.fit.fit(); window.grid.resize(sid, rec.term.cols, rec.term.rows); }
  savePanes();
}

function addTab(pane, sid, { activate = false } = {}) {
  if (pane.tabs.includes(sid)) return;
  pane.tabs.push(sid);
  const rec = terms.get(sid);
  pane.bodyEl.appendChild(rec.wrap);
  if (!rec.opened) {
    rec.term.open(rec.termEl);
    rec.fit.fit();
    rec.opened = true;
    window.grid.cellReady(sid, rec.term.cols, rec.term.rows);
    if (rec.pendingGlow) { setGlow(sid, rec.pendingGlow, { persist: false }); rec.pendingGlow = null; }
  }
  if (activate || pane.active == null) setActive(pane, sid);
  else { rec.wrap.style.display = 'none'; renderTabs(pane); }
}

function closeTab(pane, sid) {
  window.grid.disposeCell(sid);
  const rec = terms.get(sid);
  if (rec) { try { rec.term.dispose(); } catch (_) {} rec.wrap.remove(); }
  terms.delete(sid);
  delete window.__cellTerms[sid];
  delete window.__glow[sid];
  pane.tabs = pane.tabs.filter((s) => s !== sid);
  if (pane.active === sid) {
    if (pane.tabs.length) setActive(pane, pane.tabs[0]);
    else { const ns = String(seq++); createSession(ns, {}); addTab(pane, ns, { activate: true }); }
  } else { renderTabs(pane); }
  savePanes();
}

function startRename(nameEl, sid) {
  nameEl.setAttribute('contenteditable', 'true');
  nameEl.focus();
  const r = document.createRange(); r.selectNodeContents(nameEl);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
  nameEl.dataset.prev = nameEl.textContent;
  nameEl.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
    if (e.key === 'Escape') { nameEl.textContent = nameEl.dataset.prev; nameEl.blur(); }
    e.stopPropagation();
  };
  nameEl.onblur = () => {
    nameEl.setAttribute('contenteditable', 'false');
    const name = (nameEl.textContent || '').replace(/\s+/g, ' ').trim() || defaultName(sid);
    nameEl.textContent = name;
    const rec = terms.get(sid); if (rec) rec.name = name;
    window.grid.rename(sid, name);
  };
}

// ---- glow ------------------------------------------------------------------
function setGlow(sid, s, { persist = true } = {}) {
  const rec = terms.get(sid); if (!rec) return;
  rec.glow = s;
  window.__glow[sid] = s;
  const pane = paneOf(sid);
  if (pane) { updatePaneGlow(pane); renderTabs(pane); }
  if (persist) window.grid.glowChanged(sid, s);
}
function clearGlow(sid) { const r = terms.get(sid); if (r && r.glow !== 'none') setGlow(sid, 'none'); }

// ---- wiring ----------------------------------------------------------------
window.grid.onLaunched((sid, info) => { window.__launch[sid] = info; });

window.grid.onPerf((data) => {
  window.__perf = data;
  for (const pane of panes) {
    if (!pane) continue;
    const p = pane.active && data.cells && data.cells[pane.active];
    if (pane.perfEl) pane.perfEl.textContent = p ? `${p.cpu}% · ${p.mem}MB` : '';
  }
  const totalEl = document.getElementById('perf-total');
  if (totalEl && data.total) totalEl.textContent = `Σ ${data.total.cpu}% · ${data.total.mem}MB`;
});
function applyPerfClass() { document.body.classList.toggle('perf-on', !!settings.perfView); }

window.grid.onSignal((sig) => {
  window.__signals.push(sig);
  const sid = String(sig.cell);
  if (!terms.has(sid) || !settings.glowEnabled) return;
  switch (sig.kind) {
    case 'stop':
    case 'idle':
      if (settings.glowOn !== 'permission-only') { setGlow(sid, 'idle'); playSound('done'); }
      break;
    case 'permission': setGlow(sid, 'permission'); playSound('permission'); break;
    case 'start': clearGlow(sid); break;
  }
});

window.grid.onData((sid, data) => { const r = terms.get(String(sid)); if (r) r.term.write(data); });
window.grid.onExit((sid) => { const r = terms.get(String(sid)); if (r) r.term.write('\r\n\x1b[31m[process exited]\x1b[0m\r\n'); });

function refitAll() {
  for (const pane of panes) {
    if (!pane || !pane.active) continue;
    const rec = terms.get(pane.active);
    if (rec && rec.opened) { rec.fit.fit(); window.grid.resize(pane.active, rec.term.cols, rec.term.rows); }
  }
}

function savePanes() {
  const arr = panes.map((p) => (p ? { tabs: [...p.tabs], active: p.active } : { tabs: [], active: null }));
  window.grid.panesChanged(arr, seq);
}

function setGridTemplate(rows, cols) {
  gridEl.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  gridEl.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
}
function updateStatus() {
  statusEl.textContent = `${countSessions()} sessions · ${panes.length} panes (${currentLayout.rows}×${currentLayout.cols})`;
}

// Build the initial panes from saved state (or fresh).
function buildInitial(rows, cols) {
  setGridTemplate(rows, cols);
  const savedPanes = savedState && Array.isArray(savedState.panes) ? savedState.panes : null;
  if (savedPanes && savedPanes.length) {
    seq = savedState.seq || 0;
    for (const pd of savedPanes) for (const sid of pd.tabs) if (!terms.has(sid)) createSession(sid, (savedState.cells || {})[sid] || {});
    for (let i = 0; i < savedPanes.length; i++) {
      const pane = createPane(i);
      for (const sid of savedPanes[i].tabs) addTab(pane, sid, { activate: false });
      const act = savedPanes[i].active;
      if (act && pane.tabs.includes(act)) setActive(pane, act);
      else if (pane.tabs.length) setActive(pane, pane.tabs[0]);
    }
  } else {
    const P = rows * cols;
    for (let i = 0; i < P; i++) {
      const pane = createPane(i);
      const sid = String(seq++);
      createSession(sid, (savedState && savedState.cells || {})[sid] || {});
      addTab(pane, sid, { activate: true });
    }
  }
  updateStatus();
  requestAnimationFrame(() => requestAnimationFrame(refitAll));
}

// Change layout: grow adds fresh panes; shrink moves orphaned sessions into tabs (no kill).
function applyLayout(rows, cols) {
  setGridTemplate(rows, cols);
  const newP = rows * cols;
  const oldP = panes.length;
  if (newP < oldP) {
    // Collect orphaned sessions from the removed panes, then spread them evenly (round-robin)
    // across the remaining panes as tabs — no pile-up on the last pane, nothing killed.
    const orphans = [];
    for (let i = newP; i < oldP; i++) { orphans.push(...panes[i].tabs); panes[i].tabs = []; panes[i].el.remove(); }
    panes.length = newP;
    orphans.forEach((sid, k) => addTab(panes[k % newP], sid, { activate: false }));
  } else if (newP > oldP) {
    for (let i = oldP; i < newP; i++) {
      const pane = createPane(i);
      const sid = String(seq++);
      createSession(sid, {});
      addTab(pane, sid, { activate: true });
    }
  }
  updateStatus();
  requestAnimationFrame(() => requestAnimationFrame(refitAll));
  savePanes();
}

// ---- layout picker ---------------------------------------------------------
function updateLayoutBtn(L) {
  document.getElementById('layout-btn').innerHTML =
    `<span class="layout-ico">${layoutIcon(L.rows, L.cols, 22, 16)}</span><span>${L.rows} × ${L.cols}</span>`;
}
function updateLayoutMenuActive(key) {
  document.querySelectorAll('#layout-menu .menu-item').forEach((el) => el.classList.toggle('active', el.dataset.key === key));
}
function resolveLayout(key) {
  let L = LAYOUTS.find((l) => l.key === key);
  if (!L) { const m = /^(\d+)x(\d+)$/.exec(key); if (m) L = { key, rows: +m[1], cols: +m[2] }; }
  return L;
}
function setLayout(key) {
  const L = resolveLayout(key);
  if (!L) return;
  currentLayout = { rows: L.rows, cols: L.cols };
  applyLayout(L.rows, L.cols);
  updateLayoutBtn(L);
  updateLayoutMenuActive(L.key);
  window.grid.layoutChanged(L.rows, L.cols);
}
window.__setLayout = (key) => setLayout(key);

function buildLayoutPicker() {
  const btn = document.getElementById('layout-btn');
  const menu = document.getElementById('layout-menu');
  let html = '', lastGroup = null;
  for (const L of LAYOUTS) {
    if (L.group !== lastGroup) { html += `<div class="group-label">${L.group}</div>`; lastGroup = L.group; }
    html += `<div class="menu-item" data-key="${L.key}"><span class="layout-ico">${layoutIcon(L.rows, L.cols)}</span>` +
      `<span>${L.rows} × ${L.cols} &nbsp;<span style="color:#888">(${L.rows * L.cols})</span></span></div>`;
  }
  menu.innerHTML = html;
  menu.querySelectorAll('.menu-item').forEach((el) => el.addEventListener('click', () => { setLayout(el.dataset.key); menu.classList.remove('open'); }));
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
  menu.querySelectorAll('.menu-item').forEach((el) => el.addEventListener('click', () => {
    if (el.dataset.act === 'github') window.grid.openExternal(REPO_URL);
    if (el.dataset.act === 'issues') window.grid.openExternal(REPO_URL + '/issues');
    if (el.dataset.act === 'remove') window.grid.removeWindow();
    menu.classList.remove('open');
  }));
  btn.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('open'); });
  document.addEventListener('click', () => menu.classList.remove('open'));
}

let resizeTimer = null;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(refitAll, 100); });

// ---- settings panel --------------------------------------------------------
function fileName(p) { return String(p).split(/[\\/]/).pop(); }
function initSettingsUI() {
  const $ = (id) => document.getElementById(id);
  const overlay = $('settings-overlay');
  $('settings-btn').addEventListener('click', () => overlay.classList.add('open'));
  $('settings-close').addEventListener('click', () => overlay.classList.remove('open'));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('open'); });

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
  $('set-launch').addEventListener('change', (e) => { settings.launch = { ...(settings.launch || {}), command: e.target.value.trim() || 'claude' }; persistSettings(); });
  $('set-done-enabled').addEventListener('change', (e) => { settings.doneSound.enabled = e.target.checked; persistSettings(); });
  $('set-perm-enabled').addEventListener('change', (e) => { settings.permissionSound.enabled = e.target.checked; persistSettings(); });
  $('set-perf').addEventListener('change', (e) => { settings.perfView = e.target.checked; persistSettings(); applyPerfClass(); });

  const pick = async (which) => {
    const r = await window.grid.pickSound();
    if (!r) return;
    (which === 'done' ? settings.doneSound : settings.permissionSound).path = r.path;
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

function shortFolder(p) { if (!p) return 'home'; return String(p).split(/[\\/]/).filter(Boolean).pop() || p; }
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
    window.grid.relaunchApp();
  });
}

async function initWindowUI() {
  const info = await window.grid.windowInfo();
  const titleEl = document.getElementById('win-title');
  if (info) { window.__windowId = info.windowId; window.__windowTitle = info.title; titleEl.textContent = info.title; }
  titleEl.addEventListener('dblclick', () => {
    titleEl.setAttribute('contenteditable', 'true');
    titleEl.focus();
    const r = document.createRange(); r.selectNodeContents(titleEl);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  titleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); } e.stopPropagation(); });
  titleEl.addEventListener('blur', () => {
    titleEl.setAttribute('contenteditable', 'false');
    const t = (titleEl.textContent || '').replace(/\s+/g, ' ').trim() || (window.__windowTitle || 'window');
    titleEl.textContent = t; window.__windowTitle = t; window.grid.renameWindow(t);
  });
  document.getElementById('new-window-btn').addEventListener('click', () => window.grid.newWindow());
}

function afterSettings() {
  window.__settings = settings;
  loadSoundInto('done', settings.doneSound && settings.doneSound.path);
  loadSoundInto('permission', settings.permissionSound && settings.permissionSound.path);
  initSettingsUI();
  initFolderUI();
  initWindowUI();
  applyPerfClass();
}

// ---- boot ------------------------------------------------------------------
(async function boot() {
  let rows = 3, cols = 4;
  try {
    const st = await window.grid.getState();
    if (st) {
      Object.assign(settings, st.settings || {});
      savedState = st;
      if (st.layout) { rows = st.layout.rows; cols = st.layout.cols; }
    }
  } catch (_) {}
  currentLayout = { rows, cols };
  buildLayoutPicker();
  buildHelpMenu();
  const L = resolveLayout(`${rows}x${cols}`) || { key: `${rows}x${cols}`, rows, cols };
  updateLayoutBtn(L);
  updateLayoutMenuActive(L.key);
  buildInitial(rows, cols);
  afterSettings();
  window.__ready = true;
})();
