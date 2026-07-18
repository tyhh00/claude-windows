// Renderer: a grid of PANES; each pane holds a stack of session terminals as TABS.
// Shrinking the layout moves orphaned sessions into tabs (never kills them). Sessions keep a
// stable id so glow/resume/persistence all key off the session, not the pane position.

const TerminalCtor = window.Terminal;
const FitAddonCtor = window.FitAddon.FitAddon;

// Cross-platform monospace stack (Windows: Cascadia/Consolas; macOS: SF Mono/Menlo; Linux fallbacks).
const MONO_FONT = "'Cascadia Mono', 'Cascadia Code', Menlo, 'SF Mono', Monaco, Consolas, 'DejaVu Sans Mono', ui-monospace, monospace";

// Terminal colors follow the active theme's --term-bg (read at create/switch time).
function cssVar(name) { return getComputedStyle(document.body).getPropertyValue(name).trim(); }
function termTheme() {
  return { background: cssVar('--term-bg') || '#0b0b0d', foreground: '#d6d8da', cursor: '#d6d8da', selectionBackground: '#2a3f63' };
}

// HNA-Code mark: two linked nodes (humans + agents), themeable via --accent.
function HNA_MARK(size = 18) {
  const id = 'hna-grad-' + size;
  return `<svg viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true">` +
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="var(--accent)"/><stop offset="1" stop-color="var(--accent-hover)"/></linearGradient></defs>` +
    `<rect x="2" y="2" width="28" height="28" rx="8" fill="url(#${id})"/>` +
    `<circle cx="12" cy="16" r="3.3" fill="#fff"/>` +
    `<circle cx="20" cy="16" r="3.3" fill="#fff" fill-opacity=".8"/>` +
    `<path d="M12 16 H20" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>`;
}
const CELL_MARK =
  '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">' +
  '<circle cx="8" cy="12" r="2.6" fill="var(--accent)"/>' +
  '<circle cx="16" cy="12" r="2.6" fill="var(--accent)" fill-opacity=".68"/>' +
  '<path d="M8 12 H16" stroke="var(--accent)" stroke-width="1.8" stroke-linecap="round"/></svg>';

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

const REPO_URL = 'https://github.com/tyhh00/HNA-Code';
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
  sidebarCollapsed: false,
  recentFolders: [],
  theme: 'graphite',
};
const THEMES = [
  { key: 'graphite', label: 'Graphite', accent: '#4c8dff', bg: '#1b1c1e' },
  { key: 'claude', label: 'Claude', accent: '#d97757', bg: '#201b18' },
  { key: 'midnight', label: 'Midnight', accent: '#6d8bff', bg: '#131722' },
  { key: 'light', label: 'Light', accent: '#2f6fed', bg: '#f2f3f5' },
];
function applyTheme(name) {
  const t = THEMES.find((x) => x.key === name) ? name : 'graphite';
  document.body.setAttribute('data-theme', t);
  for (const rec of terms.values()) { try { rec.term.options.theme = termTheme(); } catch (_) {} }
  document.querySelectorAll('#theme-swatches .theme-swatch').forEach((el) => el.classList.toggle('active', el.dataset.theme === t));
}
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
    fontSize: 13, fontFamily: MONO_FONT,
    cursorBlink: true, theme: termTheme(), scrollback: 5000,
    // OSC 8 terminal hyperlinks -> open in the OS default browser (no bare Electron popup, no prompt).
    linkHandler: { activate: (_e, uri) => { if (/^https?:\/\//.test(uri)) window.grid.openExternal(uri); } },
  });
  const fit = new FitAddonCtor();
  term.loadAddon(fit);

  const rec = {
    sid, term, fit, wrap, termEl, opened: false,
    name: saved.name || defaultName(sid), glow: 'none',
    pendingGlow: saved.glow && saved.glow !== 'none' ? saved.glow : null,
    // "real" = actually resumed a conversation or has produced a turn; only these show in the sidebar.
    real: !!saved.sessionId,
  };
  terms.set(sid, rec);
  window.__cellTerms[sid] = term;

  term.onData((d) => window.grid.sendInput(sid, d));   // forward all bytes (incl. auto-replies)
  term.onKey(() => { clearGlow(sid); markReal(sid); }); // real keypress -> engaged + a real session
  // Ctrl+V pastes the clipboard; Ctrl+C copies the selection (falling through to SIGINT otherwise).
  // On macOS the native Edit menu (Cmd+V/C) handles this, so we don't double-handle it there.
  if (window.grid.platform !== 'darwin') {
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !e.ctrlKey || e.metaKey || e.altKey) return true;
      const k = (e.key || '').toLowerCase();
      if (k === 'v' && !e.shiftKey) { const t = window.grid.clipboardRead(); if (t) term.paste(t); return false; }
      if (k === 'c' && term.hasSelection()) { window.grid.clipboardWrite(term.getSelection()); return false; }
      return true;
    });
  }
  // Clicking into a glowing cell is an implicit acknowledgement -> fade the glow away.
  wrap.addEventListener('mousedown', () => clearGlow(sid));
  return rec;
}

function createPane(i) {
  const el = document.createElement('div');
  el.className = 'cell';
  el.dataset.pane = String(i);
  el.innerHTML =
    `<div class="cell-header">` +
      `<span class="cell-mark">${CELL_MARK}</span>` +
      `<div class="tabs"></div>` +
      `<span class="cell-perf"></span>` +
      `<button class="cell-btn code" title="Open folder in VS Code">&lt;/&gt;</button>` +
      `<button class="cell-btn close" title="Close this session">✕</button>` +
    `</div>` +
    `<div class="pane-body"><div class="pane-empty"><button class="pane-new">＋ New session</button></div></div>`;
  gridEl.appendChild(el);
  const pane = {
    el, tabsEl: el.querySelector('.tabs'), bodyEl: el.querySelector('.pane-body'),
    perfEl: el.querySelector('.cell-perf'), emptyEl: el.querySelector('.pane-empty'), tabs: [], active: null,
  };
  el.querySelector('.cell-btn.code').addEventListener('click', () => { if (pane.active) window.grid.openInVsCode(pane.active); });
  el.querySelector('.cell-btn.close').addEventListener('click', () => { if (pane.active) closeTab(pane, pane.active); });
  el.querySelector('.pane-new').addEventListener('click', () => newSessionInPane(pane));
  el.querySelector('.cell-header').addEventListener('contextmenu', (e) => {
    if (e.target.closest('.cell-btn') || e.target.closest('.cell-name')) return;
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
    if (sid !== pane.active) {
      if (rec.glow !== 'none') tab.classList.add('tab-' + rec.glow);
      else if (rec.running) tab.classList.add('tab-running');
    }
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
  scheduleSidebar();
}

function setPaneEmpty(pane, show) { if (pane.emptyEl) pane.emptyEl.classList.toggle('show', show); }
function newSessionInPane(pane) {
  const sid = String(seq++);
  createSession(sid, {});
  setPaneEmpty(pane, false);
  addTab(pane, sid, { activate: true });
}

function addTab(pane, sid, { activate = false } = {}) {
  if (pane.tabs.includes(sid)) return;
  setPaneEmpty(pane, false);
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
  scheduleSidebar();
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
    else {
      // Last session in this pane closed -> leave it empty (do NOT auto-spawn a new Claude here).
      pane.active = null;
      pane.el.removeAttribute('data-cell');
      setPaneEmpty(pane, true);
      renderTabs(pane);
      updatePaneGlow(pane);
    }
  } else { renderTabs(pane); }
  savePanes();
  scheduleSidebar();
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
    scheduleSidebar();
  };
}

// ---- glow ------------------------------------------------------------------
function setGlow(sid, s, { persist = true } = {}) {
  const rec = terms.get(sid); if (!rec) return;
  rec.glow = s;
  window.__glow[sid] = s;
  const pane = paneOf(sid);
  if (pane) { updatePaneGlow(pane); renderTabs(pane); }
  scheduleSidebar();
  if (persist) window.grid.glowChanged(sid, s);
}
function clearGlow(sid) { const r = terms.get(sid); if (r && r.glow !== 'none') setGlow(sid, 'none'); }
// Mark a session "real" (resumed, or the user/agent has engaged) so it surfaces in the sidebar.
function markReal(sid) { const r = terms.get(sid); if (r) { r.real = true; r.lastActivity = Date.now(); scheduleSidebar(); } }
function setRunning(sid, on) {
  const r = terms.get(sid); if (!r) return;
  if (r.running === on) return;
  r.running = on;
  const pane = paneOf(sid); if (pane) renderTabs(pane);
  scheduleSidebar();
}

// ---- wiring ----------------------------------------------------------------
window.grid.onLaunched((sid, info) => {
  window.__launch[sid] = info;
  // A resumed launch means a genuine conversation is back -> surface it in the sidebar.
  if (info && info.resumeId) { const r = terms.get(sid); if (r) { r.real = true; scheduleSidebar(); } }
});

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
  if (!terms.has(sid)) return;
  const trec = terms.get(sid);
  if (trec) {
    trec.topicFetched = false; // may have new content -> refresh topic
    trec.lastActivity = Date.now();
    // Any post-start signal (turn end / waiting / permission) means real activity happened here.
    if (sig.kind !== 'start') trec.real = true;
  }
  scheduleSidebar();
  switch (sig.kind) {
    case 'stop':
    case 'idle':
      setRunning(sid, false);
      if (settings.glowEnabled && settings.glowOn !== 'permission-only') { setGlow(sid, 'idle'); playSound('done'); }
      break;
    case 'permission':
      setRunning(sid, false);
      if (settings.glowEnabled) { setGlow(sid, 'permission'); playSound('permission'); }
      break;
    case 'prompt': // user submitted a prompt -> the agent is now working
      markReal(sid); clearGlow(sid); setRunning(sid, true);
      break;
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

// ---- Sidebar (needs-you-first session list) --------------------------------
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
// True when name and topic are effectively the same text (so we don't show a duplicate subtitle).
function sameStart(a, b) {
  if (!a || !b) return false;
  const x = a.trim().toLowerCase(), y = b.trim().toLowerCase();
  if (x === y) return true;
  const n = Math.min(18, x.length, y.length);
  return n >= 8 && (x.startsWith(y.slice(0, n)) || y.startsWith(x.slice(0, n)));
}
let sbTimer = null;
function scheduleSidebar() { clearTimeout(sbTimer); sbTimer = setTimeout(renderSidebar, 80); }
function fetchTopic(sid) {
  const rec = terms.get(sid);
  if (!rec || rec.topicFetched) return;
  rec.topicFetched = true;
  window.grid.sessionTopic(sid).then((r) => {
    if (!r) return;
    const t = terms.get(sid); if (!t) return;
    let changed = false;
    if (r.topic && r.topic !== t.topic) { t.topic = r.topic; changed = true; }
    if (r.mtime && r.mtime > (t.lastActivity || 0)) { t.lastActivity = r.mtime; changed = true; }
    if (changed) scheduleSidebar();
  });
}
// Recency bucket for the sidebar section titles.
function recencyBucket(ms) {
  if (!ms) return 'Older';
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startWeek = startToday - ((now.getDay() + 6) % 7) * 86400000; // week starts Monday
  const startMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  if (ms >= startToday) return 'Today';
  if (ms >= startWeek) return 'This week';
  if (ms >= startMonth) return 'This month';
  return 'Older';
}
function renderSidebar() {
  const listEl = document.getElementById('sb-list');
  if (!listEl) return;
  const items = [];
  // Only surface sessions that are actually real (resumed, or that produced a turn). Fresh/never-used
  // cells stay out of the list until Claude actually does something in them.
  panes.forEach((p, pi) => { if (p) p.tabs.forEach((sid, ti) => { if (terms.get(sid)?.real) items.push({ sid, pi, ti }); }); });
  if (!items.length) {
    listEl.innerHTML = '<div class="sb-empty">No active sessions yet. They show up here once a Claude session is running or resumed.</div>';
    return;
  }
  const recOf = (it) => terms.get(it.sid);
  const glowing = (it) => recOf(it) && recOf(it).glow !== 'none';
  // Needs-you (glowing) pinned on top, permission before idle; everything else grouped by recency.
  const needs = items.filter(glowing).sort((a, b) => {
    const p = (it) => (recOf(it).glow === 'permission' ? 0 : 1);
    return p(a) - p(b) || (recOf(b).lastActivity || 0) - (recOf(a).lastActivity || 0);
  });
  const rest = items.filter((it) => !glowing(it)).sort((a, b) => (recOf(b).lastActivity || 0) - (recOf(a).lastActivity || 0));

  const rowHtml = (sid) => {
    const rec = terms.get(sid);
    const active = paneOf(sid)?.active === sid;
    const dot = rec.glow !== 'none' ? rec.glow : (rec.running ? 'running' : 'none');
    const showTopic = rec.topic && !sameStart(rec.name, rec.topic);
    return `<div class="sb-item${active ? ' active' : ''}" data-sid="${sid}">` +
      `<span class="sb-dot ${dot}"></span>` +
      `<span class="sb-body"><span class="sb-name">${escapeHtml(rec.name)}</span>` +
      (showTopic ? `<span class="sb-topic">${escapeHtml(rec.topic)}</span>` : '') + '</span></div>';
  };

  let html = '';
  if (needs.length) { html += '<div class="sb-section">Needs you</div>' + needs.map((it) => rowHtml(it.sid)).join(''); }
  let lastBucket = null;
  for (const it of rest) {
    const bucket = recencyBucket(recOf(it).lastActivity);
    if (bucket !== lastBucket) { html += `<div class="sb-section">${bucket}</div>`; lastBucket = bucket; }
    html += rowHtml(it.sid);
  }
  listEl.innerHTML = html;
  listEl.querySelectorAll('.sb-item').forEach((el) => {
    el.addEventListener('click', () => { const p = paneOf(el.dataset.sid); if (p) setActive(p, el.dataset.sid); });
  });
  for (const { sid } of items) fetchTopic(sid);
}
function applySidebar() {
  const c = !!settings.sidebarCollapsed;
  document.body.classList.toggle('sb-collapsed', c);
  const btn = document.getElementById('sb-collapse');
  if (btn) { btn.textContent = c ? '☰' : '«'; btn.title = c ? 'Show sessions' : 'Hide sessions'; }
}
function setSidebarCollapsed(c) { settings.sidebarCollapsed = c; applySidebar(); persistSettings(); }
function initSidebar() {
  document.getElementById('sb-collapse').addEventListener('click', () => setSidebarCollapsed(!settings.sidebarCollapsed));
  applySidebar();
  renderSidebar();
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
      else setPaneEmpty(pane, true); // a pane the user emptied stays empty across restarts
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

  // Theme swatches
  const sw = $('theme-swatches');
  if (sw) {
    sw.innerHTML = THEMES.map((t) =>
      `<div class="theme-swatch" data-theme="${t.key}" title="${t.label}" style="background:${t.bg}"><span style="background:${t.accent}"></span></div>`).join('');
    sw.querySelectorAll('.theme-swatch').forEach((el) => el.addEventListener('click', () => {
      settings.theme = el.dataset.theme; applyTheme(settings.theme); persistSettings();
    }));
    sw.querySelectorAll('.theme-swatch').forEach((el) => el.classList.toggle('active', el.dataset.theme === (settings.theme || 'graphite')));
  }

  $('import-open').addEventListener('click', () => { overlay.classList.remove('open'); openImportManual(); });

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
  const menu = document.getElementById('folder-menu');
  const label = document.getElementById('folder-name');
  const root = await window.grid.getRoot();
  const curNorm = String(root || '').toLowerCase();
  label.textContent = shortFolder(root);
  btn.title = `New sessions start in:\n${root}\n(click for recent folders)`;

  function buildMenu() {
    const recents = (settings.recentFolders || []).filter(Boolean);
    let html = '<div class="group-label">Open recent</div>';
    if (recents.length) {
      html += recents.map((f) => {
        const active = String(f).toLowerCase() === curNorm ? ' active' : '';
        return `<div class="menu-item${active}" data-folder="${escapeHtml(f)}">` +
          `<span class="fm-name">${escapeHtml(bn(f))}</span>` +
          `<span class="fm-path">${escapeHtml(f)}</span></div>`;
      }).join('');
    } else {
      html += '<div class="group-label" style="color:#666;text-transform:none">No recent folders</div>';
    }
    html += '<div class="menu-item open-row" data-open="1">📂 Open folder…</div>';
    menu.innerHTML = html;
    menu.querySelectorAll('.menu-item[data-folder]').forEach((el) => el.addEventListener('click', () => {
      menu.classList.remove('open');
      if (el.dataset.folder.toLowerCase() === curNorm) return; // already here
      window.grid.openWorkspace(el.dataset.folder); // switch workspace in place
    }));
    menu.querySelector('[data-open]').addEventListener('click', async () => {
      menu.classList.remove('open');
      const dir = await window.grid.pickRoot();
      if (dir) window.grid.openWorkspace(dir);
    });
  }
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!menu.classList.contains('open')) buildMenu();
    menu.classList.toggle('open');
  });
  document.addEventListener('click', () => menu.classList.remove('open'));
}

function startWindowRename() {
  const titleEl = document.getElementById('win-title');
  titleEl.setAttribute('contenteditable', 'true');
  titleEl.focus();
  const r = document.createRange(); r.selectNodeContents(titleEl);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
}
async function initWindowUI() {
  const info = await window.grid.windowInfo();
  const titleEl = document.getElementById('win-title');
  if (info) { window.__windowId = info.windowId; window.__windowTitle = info.title; titleEl.textContent = info.title; }
  titleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); } e.stopPropagation(); });
  titleEl.addEventListener('blur', () => {
    titleEl.setAttribute('contenteditable', 'false');
    const t = (titleEl.textContent || '').replace(/\s+/g, ' ').trim() || (window.__windowTitle || 'window');
    titleEl.textContent = t; window.__windowTitle = t; window.grid.renameWindow(t);
  });

  const btn = document.getElementById('win-btn');
  const menu = document.getElementById('win-menu');
  async function build() {
    const { folder, windows: wins } = await window.grid.listWindows();
    let html = `<div class="group-label">Windows · ${escapeHtml(bn(folder))}</div>`;
    html += wins.map((w) => {
      const cls = 'menu-item wm-win' + (w.current ? ' wm-current' : '') + (w.open ? '' : ' wm-closed');
      const tag = w.current ? '<span class="wm-tag">this</span>' : (w.open ? '<span class="wm-tag open">open</span>' : '<span class="wm-tag">closed</span>');
      return `<div class="${cls}" data-win="${escapeHtml(w.windowId)}" data-open="${w.open ? 1 : 0}"><span class="wm-name">${escapeHtml(w.title)}</span>${tag}</div>`;
    }).join('');
    html += `<div class="menu-item open-row" data-new="1">＋ New window for ${escapeHtml(bn(folder))}</div>`;
    html += `<div class="menu-item" data-rename="1">✎ Rename this window</div>`;
    html += `<div class="menu-item" data-openfolder="1">📂 Open another folder…</div>`;
    menu.innerHTML = html;
    menu.querySelectorAll('[data-win]').forEach((el) => el.addEventListener('click', () => {
      menu.classList.remove('open');
      const id = el.dataset.win;
      if (id === window.__windowId) return;              // already here
      if (el.dataset.open === '1') window.grid.focusWindow(id);      // open -> focus it
      else window.grid.openExistingWindow(id);                       // closed -> open it
    }));
    menu.querySelector('[data-new]').addEventListener('click', () => { menu.classList.remove('open'); window.grid.newWindow(); });
    menu.querySelector('[data-rename]').addEventListener('click', () => { menu.classList.remove('open'); startWindowRename(); });
    menu.querySelector('[data-openfolder]').addEventListener('click', () => { menu.classList.remove('open'); window.grid.openHomeWindow(); });
  }
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!menu.classList.contains('open')) await build();
    menu.classList.toggle('open');
  });
  document.addEventListener('click', () => menu.classList.remove('open'));
}
// Tools menu: Broadcast + Home, with names.
function initTools() {
  const btn = document.getElementById('tools-btn');
  const menu = document.getElementById('tools-menu');
  menu.innerHTML =
    `<div class="menu-item" data-act="broadcast">📢 Broadcast to all cells <span style="color:var(--text-3);margin-left:6px">Ctrl+Shift+B</span></div>` +
    `<div class="menu-item" data-act="home">🏠 Home / open a folder</div>`;
  menu.querySelectorAll('.menu-item').forEach((el) => el.addEventListener('click', () => {
    menu.classList.remove('open');
    if (el.dataset.act === 'broadcast') toggleBroadcast();
    if (el.dataset.act === 'home') window.grid.openHomeWindow();
  }));
  btn.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('open'); });
  document.addEventListener('click', () => menu.classList.remove('open'));
}

// ---- Home page + one-click import of existing sessions (#24) ----------------
const bn = (p) => (!p ? 'home' : String(p).split(/[\\/]/).filter(Boolean).pop() || p);
function fitLayoutKey(n) {
  const cand = LAYOUTS.filter((l) => l.group === 'Landscape').sort((a, b) => a.rows * a.cols - b.rows * b.cols);
  const L = cand.find((l) => l.rows * l.cols >= n) || cand[cand.length - 1];
  return L ? L.key : '4x4';
}
function showHome() { document.getElementById('home-overlay').classList.add('open'); }
function hideHome() { document.getElementById('home-overlay').classList.remove('open'); }
function renderRecents() {
  const el = document.getElementById('home-recents');
  const recents = (settings.recentFolders || []).filter(Boolean);
  if (!recents.length) { el.innerHTML = '<div class="recent-empty">No recent folders yet.</div>'; return; }
  el.innerHTML = recents.map((f) =>
    `<div class="recent-item" data-folder="${escapeHtml(f)}">` +
    `<span class="recent-name">${escapeHtml(bn(f))}</span>` +
    `<span class="recent-path">${escapeHtml(f)}</span></div>`).join('');
  el.querySelectorAll('.recent-item').forEach((row) => row.addEventListener('click', () => window.grid.openWorkspace(row.dataset.folder)));
}
// The launcher home page: opening a folder loads that workspace's grid in place (no relaunch).
function initHome() {
  renderRecents();
  const root = savedState && savedState.root;
  document.getElementById('home-open').addEventListener('click', async () => {
    const dir = await window.grid.pickRoot();
    if (dir) window.grid.openWorkspace(dir);
  });
  document.getElementById('home-skip').addEventListener('click', () => { if (root) window.grid.openWorkspace(root); });
}

let importScan = null; // { folder, sessions:[{sessionId,title,mtime}] }
function fmtDate(ms) {
  if (!ms) return '';
  try { return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch (_) { return ''; }
}
function importChecked() {
  return [...document.querySelectorAll('#imp-list .imp-row input:checked')].map((c) => c.dataset.sid);
}
function importCheckedSessions() {
  const ids = new Set(importChecked());
  return (importScan ? importScan.sessions : []).filter((s) => ids.has(s.sessionId));
}
function updateImportCount() {
  const n = importChecked().length;
  document.getElementById('imp-count').textContent = `${n} selected`;
  document.getElementById('imp-go').textContent = n > 0 ? `Resume ${n} session${n === 1 ? '' : 's'}` : 'Resume selected';
}
function renderImportList() {
  const listEl = document.getElementById('imp-list');
  if (!importScan.sessions.length) {
    listEl.innerHTML = '<div class="recent-empty">No importable sessions found in this folder. ' +
      'Only sessions started in this exact folder show up here.</div>';
    updateImportCount();
    return;
  }
  listEl.innerHTML = importScan.sessions.map((s) =>
    `<label class="imp-row">` +
    `<input type="checkbox" data-sid="${escapeHtml(s.sessionId)}" data-mtime="${s.mtime || 0}" checked />` +
    `<span class="imp-body"><span class="imp-title">${escapeHtml(s.title)}</span>` +
    `<span class="imp-date">${fmtDate(s.mtime)}</span></span></label>`).join('');
  listEl.querySelectorAll('input').forEach((c) => c.addEventListener('change', updateImportCount));
  updateImportCount();
}
function showImport(scan, manual = false) {
  importScan = scan;
  const n = scan.sessions.length;
  document.getElementById('imp-project-row').style.display = manual ? '' : 'none';
  document.getElementById('import-desc').textContent = manual
    ? (n ? 'Pick sessions to bring into this window. Each resumes in its own original folder.'
         : 'No resumable sessions in this project folder.')
    : (n ? `You have ${n} Claude session${n === 1 ? '' : 's'} in ${bn(scan.folder)} that aren't in HNA-Code yet. Pick the ones to bring in.`
         : `Looking in ${bn(scan.folder)}.`);
  document.getElementById('imp-go').style.display = n ? '' : 'none';
  renderImportList();
  document.getElementById('import-overlay').classList.add('open');
}
function hideImport() { document.getElementById('import-overlay').classList.remove('open'); }
// Settings importer: browse every Claude project folder and pull specific sessions in. Not gated by
// the once-per-folder auto flag, and can reach sessions from any folder (not just this workspace).
async function openImportManual() {
  const sel = document.getElementById('imp-project');
  let projects = [];
  try { projects = await window.grid.listProjects(); } catch (_) {}
  if (!projects.length) { showImport({ folder: '', sessions: [] }, true); return; }
  const cur = String((await window.grid.getRoot()) || '').toLowerCase();
  sel.innerHTML = projects.map((p) =>
    `<option value="${escapeHtml(p.dir)}" title="${escapeHtml(p.path)}">${escapeHtml(bn(p.path))} — ${escapeHtml(p.path)} (${p.count})</option>`).join('');
  const match = projects.find((p) => String(p.path).toLowerCase() === cur);
  if (match) sel.value = match.dir;
  sel.onchange = () => loadProjectSessions(sel.value);
  await loadProjectSessions(sel.value);
}
async function loadProjectSessions(dir) {
  let res; try { res = await window.grid.scanProject(dir); } catch (_) { res = { sessions: [] }; }
  const folder = (res.sessions[0] && res.sessions[0].cwd) || dir;
  showImport({ folder, sessions: res.sessions }, true);
}
async function maybeShowImport() {
  if (importSeenAtBoot) return;
  // If this window already resumed real sessions, there's nothing to migrate.
  const hasReal = Object.values((savedState && savedState.cells) || {}).some((c) => c && c.sessionId);
  if (hasReal) return;
  let scan;
  try { scan = await window.grid.scanWorkspace(); } catch (_) { return; }
  if (scan && scan.sessions && scan.sessions.length) showImport(scan);
}
async function doImport(selected) {
  hideImport();
  window.grid.markImportSeen();
  importSeenAtBoot = true;
  if (!selected.length) return;
  const folder = importScan ? importScan.folder : null;
  if (panes.length < selected.length) setLayout(fitLayoutKey(selected.length));
  const capacity = panes.length;
  const here = selected.slice(0, capacity);
  const overflow = selected.slice(capacity);
  for (let i = 0; i < here.length; i++) {
    const pane = panes[i]; if (!pane || !pane.active) continue;
    const sid = pane.active; const rec = terms.get(sid); if (!rec) continue;
    try { rec.term.reset(); } catch (_) {}
    const name = (here[i].title && here[i].title !== '(untitled session)') ? here[i].title.slice(0, 28) : rec.name;
    rec.name = name;
    // Resume each session in ITS OWN folder (where Claude stored it), not the current workspace.
    await window.grid.importSession(sid, here[i].sessionId, here[i].cwd || folder, rec.term.cols, rec.term.rows);
    window.grid.rename(sid, name);
    renderTabs(pane);
  }
  scheduleSidebar();
  for (let i = 0; i < overflow.length; i += 16) {
    const chunk = overflow.slice(i, i + 16).map((s) => ({
      sessionId: s.sessionId, cwd: s.cwd || folder,
      title: (s.title && s.title !== '(untitled session)') ? s.title.slice(0, 28) : undefined,
    }));
    await window.grid.newWindowWithSessions(chunk);
  }
}
function initImport() {
  document.getElementById('imp-all').addEventListener('click', () => {
    document.querySelectorAll('#imp-list .imp-row input').forEach((c) => (c.checked = true)); updateImportCount();
  });
  document.getElementById('imp-none').addEventListener('click', () => {
    document.querySelectorAll('#imp-list .imp-row input').forEach((c) => (c.checked = false)); updateImportCount();
  });
  document.getElementById('imp-after').addEventListener('change', (e) => {
    const cut = e.target.value ? new Date(e.target.value).getTime() : 0;
    document.querySelectorAll('#imp-list .imp-row input').forEach((c) => { c.checked = (+c.dataset.mtime >= cut); });
    updateImportCount();
  });
  document.getElementById('imp-skip').addEventListener('click', () => {
    window.grid.markImportSeen(); importSeenAtBoot = true; hideImport();
  });
  document.getElementById('imp-go').addEventListener('click', () => doImport(importCheckedSessions()));
}
let importSeenAtBoot = false;

// ---- Broadcast: type once, send to every cell ------------------------------
// Two birds: answer a prompt (e.g. Claude's "trust this folder?") across all cells at once, and
// kick off the same starting prompt in every agent.
function broadcast(data) {
  for (const p of panes) { if (p && p.active) window.grid.sendInput(p.active, data); }
}
function toggleBroadcast(force) {
  const on = force === undefined ? !document.body.classList.contains('bc-on') : force;
  document.body.classList.toggle('bc-on', on);
  requestAnimationFrame(refitAll); // grid height changed
  if (on) document.getElementById('bc-input').focus();
}
function initBroadcast() {
  const inp = document.getElementById('bc-input');
  const send = () => { broadcast(inp.value + '\r'); inp.value = ''; inp.focus(); };
  document.getElementById('bc-close').addEventListener('click', () => toggleBroadcast(false));
  document.getElementById('bc-send').addEventListener('click', send);
  document.getElementById('bc-enter').addEventListener('click', () => { broadcast('\r'); inp.focus(); });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } e.stopPropagation(); });
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'B' || e.key === 'b')) { e.preventDefault(); toggleBroadcast(); }
  }, true);
}

function afterSettings() {
  window.__settings = settings;
  loadSoundInto('done', settings.doneSound && settings.doneSound.path);
  loadSoundInto('permission', settings.permissionSound && settings.permissionSound.path);
  initSettingsUI();
  initFolderUI();
  initWindowUI();
  initSidebar();
  initImport();
  initBroadcast();
  initTools();
  applyPerfClass();
}

// ---- boot ------------------------------------------------------------------
(async function boot() {
  let st = null;
  try { st = await window.grid.getState(); } catch (_) {}
  if (st) { Object.assign(settings, st.settings || {}); savedState = st; }

  // Brand marks + theme apply in both modes.
  document.getElementById('brand-mark').innerHTML = HNA_MARK(18);
  document.getElementById('home-mark').innerHTML = HNA_MARK(30);
  applyTheme(settings.theme);

  // Launcher window: show ONLY the home page. No grid, no sessions, until a folder is opened.
  if (st && st.mode === 'home') {
    document.body.classList.add('home-mode');
    initHome();
    showHome();
    window.__ready = true;
    return;
  }

  // Workspace window: build the grid.
  let rows = 3, cols = 4;
  if (st && st.layout) { rows = st.layout.rows; cols = st.layout.cols; }
  currentLayout = { rows, cols };
  buildLayoutPicker();
  buildHelpMenu();
  const L = resolveLayout(`${rows}x${cols}`) || { key: `${rows}x${cols}`, rows, cols };
  updateLayoutBtn(L);
  updateLayoutMenuActive(L.key);
  buildInitial(rows, cols);
  afterSettings();

  // Offer to import this folder's existing sessions (home page never shows in a grid window).
  importSeenAtBoot = !!(savedState && savedState.importSeen);
  maybeShowImport();

  window.__ready = true;
})();
