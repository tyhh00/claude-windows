// Bridges the sandboxed renderer to main over a minimal, explicit API.
const { contextBridge, ipcRenderer, clipboard } = require('electron');

contextBridge.exposeInMainWorld('grid', {
  platform: process.platform,
  // renderer -> main
  cellReady: (cellId, cols, rows) => ipcRenderer.send('cell:ready', cellId, cols, rows),
  sendInput: (cellId, data) => ipcRenderer.send('pty:input', cellId, data),
  resize: (cellId, cols, rows) => ipcRenderer.send('pty:resize', cellId, cols, rows),
  disposeCell: (cellId) => ipcRenderer.send('cell:dispose', cellId),
  rename: (cellId, name) => ipcRenderer.send('cell:rename', cellId, name),
  glowChanged: (cellId, glow) => ipcRenderer.send('glow:changed', cellId, glow),
  layoutChanged: (rows, cols) => ipcRenderer.send('layout:changed', rows, cols),
  panesChanged: (panes, seq) => ipcRenderer.send('panes:changed', panes, seq),
  settingsChanged: (settings) => ipcRenderer.send('settings:changed', settings),

  // request/response
  getState: () => ipcRenderer.invoke('state:get'),
  sessionTopic: (cellId) => ipcRenderer.invoke('session:topic', cellId),

  // main -> renderer
  onData: (cb) => ipcRenderer.on('pty:data', (_e, cellId, data) => cb(cellId, data)),
  onExit: (cb) => ipcRenderer.on('pty:exit', (_e, cellId) => cb(cellId)),
  onSignal: (cb) => ipcRenderer.on('signal', (_e, payload) => cb(payload)),
  onLaunched: (cb) => ipcRenderer.on('cell:launched', (_e, cellId, info) => cb(cellId, info)),
  onPerf: (cb) => ipcRenderer.on('perf', (_e, data) => cb(data)),

  // hooks (explicit user action only)
  installHooks: () => ipcRenderer.invoke('hooks:install'),
  uninstallHooks: () => ipcRenderer.invoke('hooks:uninstall'),

  // sounds
  pickSound: () => ipcRenderer.invoke('dialog:pickSound'),
  loadSound: (p) => ipcRenderer.invoke('sound:load', p),

  // folder + vscode
  pickRoot: () => ipcRenderer.invoke('root:pick'),
  setRoot: (folder) => ipcRenderer.invoke('root:set', folder),
  getRoot: () => ipcRenderer.invoke('root:get'),
  relaunchApp: () => ipcRenderer.send('app:relaunch'),
  markWorkspaceChosen: () => ipcRenderer.send('workspace:chosen'),
  openWorkspace: (folder) => ipcRenderer.invoke('workspace:open', folder),
  openHomeWindow: () => ipcRenderer.send('window:home'),

  // home page + one-click import of existing sessions
  scanWorkspace: () => ipcRenderer.invoke('workspace:scan'),
  listProjects: () => ipcRenderer.invoke('sessions:projects'),
  scanProject: (dir) => ipcRenderer.invoke('sessions:scanProject', dir),
  importSession: (cellId, sessionId, cwd, cols, rows) => ipcRenderer.invoke('cell:importSession', cellId, sessionId, cwd, cols, rows),
  newWindowWithSessions: (list) => ipcRenderer.invoke('window:newWithSessions', list),
  markImportSeen: () => ipcRenderer.send('workspace:importSeen'),
  openInVsCode: (cellId) => ipcRenderer.send('cell:openInVsCode', cellId),
  openExternal: (url) => ipcRenderer.send('open:external', url),

  // windows
  windowInfo: () => ipcRenderer.invoke('window:info'),
  newWindow: () => ipcRenderer.send('window:new'),
  renameWindow: (title) => ipcRenderer.send('window:rename', title),
  removeWindow: () => ipcRenderer.send('window:remove'),
  listWindows: () => ipcRenderer.invoke('windows:list'),
  focusWindow: (id) => ipcRenderer.send('window:focus', id),
  openExistingWindow: (id) => ipcRenderer.send('window:openExisting', id),

  // clipboard (Ctrl+V paste / Ctrl+C copy in the terminal — the app menu is disabled, which on
  // Windows also strips the default paste accelerator, so we bridge the clipboard ourselves)
  clipboardRead: () => clipboard.readText(),
  clipboardWrite: (text) => clipboard.writeText(String(text || '')),
});
