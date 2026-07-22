// Demo capture library: drive the REAL HNA-Code UI with Playwright, record the renderer as a PNG
// frame stream via CDP screencast, and log a synthetic-cursor path so Remotion can add cursor-follow
// zoom + captions on top. Everything here uses fake placeholder accounts — never real credentials.
import { _electron as electron } from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

export const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.join(__dirname, '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = (cwd) => cwd.replace(/[:\\/]/g, '-');

// Two fake Claude profiles under a throwaway HOME, so the account UI is real but the accounts are not.
export function makeFakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hna-demo-home-'));
  const mk = (dir, email, isDefault) => {
    fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
    const cfg = isDefault ? path.join(home, '.claude.json') : path.join(dir, '.claude.json');
    fs.writeFileSync(cfg, JSON.stringify({ oauthAccount: { emailAddress: email, organizationName: email } }));
  };
  const personal = path.join(home, '.claude');
  const work = path.join(home, '.claude-work');
  mk(personal, 'demo@personal.dev', true);
  mk(work, 'demo@work.dev', false);
  // Neutral, PII-free shell prompt for recordings. The demo launches bash as a login shell (see
  // launchDemoApp: SHELL=/bin/bash) with this fake HOME, so these files own the prompt instead of
  // the user's real ~/.zshrc — no real username or machine name ever appears on screen.
  const rc = "export PS1='demo:~/billing$ '\nexport CLICOLOR=1\nexport BASH_SILENCE_DEPRECATION_WARNING=1\n";
  fs.writeFileSync(path.join(home, '.bashrc'), rc);
  fs.writeFileSync(path.join(home, '.bash_profile'), 'source ~/.bashrc\n');
  return { home, personal, work };
}
export function seedTranscript(dir, sessionId, cwd, firstText) {
  const d = path.join(dir, 'projects', enc(cwd));
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${sessionId}.jsonl`),
    JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: firstText }, sessionId }) + '\n');
}

// A visible cursor + click ripple, injected into the page so it's baked into the recording. We drive
// window.__cursor(x,y)/__click() ourselves alongside Playwright's real mouse, so the dot is exact.
const CURSOR_JS = `
(() => {
  if (window.__cursorInit) return; window.__cursorInit = true;
  const c = document.createElement('div');
  c.id = '__democursor';
  c.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transform:translate(-2px,-2px);transition:left .09s linear,top .09s linear;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))';
  c.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2 L4 20 L9 15 L12.5 22 L15.5 20.5 L12 14 L19 14 Z" fill="#fff" stroke="#111" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  document.body.appendChild(c);
  window.__cursor = (x, y) => { c.style.left = x + 'px'; c.style.top = y + 'px'; };
  window.__click = (x, y) => {
    const r = document.createElement('div');
    r.style.cssText = 'position:fixed;left:'+(x-14)+'px;top:'+(y-14)+'px;width:28px;height:28px;border-radius:50%;z-index:2147483646;pointer-events:none;border:2px solid var(--accent,#4c8dff);opacity:.9';
    r.animate([{transform:'scale(.3)',opacity:.9},{transform:'scale(1.4)',opacity:0}],{duration:420,easing:'ease-out'});
    document.body.appendChild(r); setTimeout(() => r.remove(), 460);
  };
})();`;

export async function launchDemoApp({ home, projDir, extraEnv = {}, autoImport = false }) {
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'hna-demo-udd-'));
  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${udd}`],
    env: {
      ...process.env, HOME: home, CLAUDE_CONFIG_DIR: '',
      ...(autoImport ? {} : { CW_NO_IMPORT: '1' }),
      // Force bash + the fake HOME so the on-screen prompt is our neutral 'demo:~/billing$', never
      // the user's real zsh 'user@host' prompt.
      SHELL: '/bin/bash',
      // Suppress macOS's Apple-Terminal bash session save/restore, which otherwise prints
      // "Restored session" + an rm error for the missing ~/.bash_sessions in the throwaway HOME.
      SHELL_SESSION_DID_INIT: '1', SHELL_SESSION_HISTORY: '0', TERM_PROGRAM: '',
      CW_LAUNCH_CMD: 'echo resumed', CW_SKIP_HOME: '1', CW_ROOT_FOLDER: projDir,
      ...extraEnv,
    },
  });
  const win = await app.firstWindow();
  await win.waitForSelector('.xterm', { timeout: 30000 });
  await win.waitForFunction(() => window.__ready === true, { timeout: 20000 });
  await win.evaluate(CURSOR_JS);
  return { app, win, udd };
}

// Records the renderer as a timestamped PNG frame stream via CDP screencast, and tracks the
// synthetic cursor so a demo script can "move" and "click" with the dot following along.
export class Recorder {
  constructor(win) { this.win = win; this.frames = []; this.cursor = []; this.captions = []; this.t0 = 0; this.x = 40; this.y = 40; }
  // A caption that fades in at the current moment and holds for durMs (Remotion renders it as an
  // overlay). Call it right before the action it narrates.
  caption(text, durMs = 1800) { this.captions.push({ tMs: Date.now() - this.t0, text, durMs }); }
  async start() {
    this.client = await this.win.context().newCDPSession(this.win);
    this.t0 = Date.now();
    this.client.on('Page.screencastFrame', async (f) => {
      this.frames.push({ tMs: Date.now() - this.t0, data: f.data });
      try { await this.client.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch (_) {}
    });
    await this.client.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
    await this.win.evaluate(({ x, y }) => window.__cursor(x, y), { x: this.x, y: this.y });
  }
  _log() { this.cursor.push({ tMs: Date.now() - this.t0, x: this.x, y: this.y }); }
  async moveTo(x, y, steps = 16) {
    const fx = this.x, fy = this.y;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // ease-in-out
      this.x = Math.round(fx + (x - fx) * e); this.y = Math.round(fy + (y - fy) * e);
      await this.win.mouse.move(this.x, this.y);
      await this.win.evaluate(({ x, y }) => window.__cursor(x, y), { x: this.x, y: this.y });
      this._log();
      await sleep(16);
    }
  }
  async moveToSel(selector, steps) {
    const b = await this.win.locator(selector).first().boundingBox();
    if (b) await this.moveTo(Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2), steps);
    return b;
  }
  async click() {
    await this.win.evaluate(({ x, y }) => window.__click(x, y), { x: this.x, y: this.y });
    this.cursor.push({ tMs: Date.now() - this.t0, x: this.x, y: this.y, click: true });
    await this.win.mouse.click(this.x, this.y);
  }
  async clickSel(selector) { await this.moveToSel(selector); await sleep(120); await this.click(); }
  async hold(ms) { const end = Date.now() + ms; while (Date.now() < end) { this._log(); await sleep(50); } }
  async stop(outDir) {
    try { await this.client.send('Page.stopScreencast'); } catch (_) {}
    // Cursor coords are CSS pixels; frames are device pixels. Store the viewport so the compositor
    // can scale cursor positions onto the frames (dpr = frameWidth / cssWidth).
    const vp = await this.win.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    this.frames.forEach((f, i) => fs.writeFileSync(path.join(outDir, `f${String(i).padStart(4, '0')}.png`), Buffer.from(f.data, 'base64')));
    const meta = { fps: 30, viewport: vp, frames: this.frames.map((f, i) => ({ i, tMs: f.tMs })), cursor: this.cursor,
      captions: this.captions,
      durationMs: this.frames.length ? this.frames[this.frames.length - 1].tMs : 0 };
    fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
    return meta;
  }
}
