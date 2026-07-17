// Shared test helpers: launch the app in an isolated user-data-dir, fire real hooks, read buffers.
import { _electron as electron } from 'playwright';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const root = path.join(__dirname, '..');
export const HOOK = path.join(root, 'src', 'hooks', 'signal.ps1');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const shot = (n) => path.join(__dirname, n);

export function tmpUserDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-udd-'));
}

// launchCmd 'SHELL' => bare interactive shell (default for tests). userDataDir isolates state.
export async function launchApp({ launchCmd = 'SHELL', userDataDir, extraEnv = {} } = {}) {
  const udd = userDataDir || tmpUserDataDir();
  const app = await electron.launch({
    args: [root, `--user-data-dir=${udd}`],
    cwd: root,
    env: { ...process.env, CW_LAUNCH_CMD: launchCmd, ...extraEnv },
  });
  const win = await app.firstWindow();
  await win.waitForSelector('.xterm', { timeout: 20000 });
  return { app, win, userDataDir: udd };
}

export function runtime(userDataDir) {
  return JSON.parse(fs.readFileSync(path.join(userDataDir, 'runtime.json'), 'utf8'));
}

// Run the REAL signal.ps1 exactly as Claude Code would.
export function fireHook({ kind, cell, sessionId = `sess-${cell}`, port, token, source = 'startup', cwd = 'C:\\test\\proj' }) {
  return new Promise((resolve) => {
    const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HOOK, '-Kind', kind], {
      env: { ...process.env, CC_CELL_ID: String(cell), CC_SIGNAL_PORT: String(port), CC_SIGNAL_TOKEN: token },
    });
    const evt = kind === 'start' ? 'SessionStart' : (kind === 'stop' ? 'Stop' : 'Notification');
    ps.stdin.write(JSON.stringify({ hook_event_name: evt, session_id: sessionId, source, cwd }));
    ps.stdin.end();
    ps.on('close', () => resolve());
  });
}

export function bufOf(win, id) {
  return win.evaluate((cid) => {
    const t = window.__cellTerms && window.__cellTerms[cid];
    if (!t) return '';
    const b = t.buffer.active; const lines = [];
    for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) lines.push(l.translateToString(true)); }
    return lines.join('\n');
  }, id);
}
