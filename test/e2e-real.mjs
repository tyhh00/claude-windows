// REAL end-to-end: launch actual authenticated `claude` in one cell, send a prompt, and confirm
// the app receives SessionStart (=> resume works) and Stop (=> glow) hook signals, then that a
// relaunch resumes the same session id. Uses the real ~/.claude (auth) but an isolated app state
// dir. NOT part of `npm test` (needs auth + network + modifies real settings.json via auto-hooks).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchApp, sleep, shot, tmpUserDataDir, bufOf } from './_helper.mjs';

const udd = tmpUserDataDir();
const rootDir = path.join(os.homedir(), 'claude-windows'); // an existing folder
// One cell only, to keep it to a single real session.
fs.mkdirSync(path.join(udd, 'windows'), { recursive: true });
fs.writeFileSync(path.join(udd, 'windows', 'w1.json'),
  JSON.stringify({ windowId: 'w1', title: 'window-1', layout: { rows: 1, cols: 1 }, rootFolder: null, cells: {} }));

const sigs = (win) => win.evaluate(() => window.__signals || []);
const glow0 = (win) => win.evaluate(() => window.__glow[0] || 'none');
let capturedSession = null;

console.log('rootDir:', rootDir);
const { app, win } = await launchApp({ launchCmd: 'claude', userDataDir: udd, extraEnv: { CW_ROOT_FOLDER: rootDir } });
try {
  // Let claude boot; handle a possible folder-trust prompt by accepting the default.
  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    const b = await bufOf(win, '0');
    if (/trust|proceed|Do you|❯|Yes,/i.test(b) && !/session_id|╭|Welcome/i.test(b)) {
      console.log('[trust prompt detected -> Enter]');
      await win.locator('.cell[data-cell="0"] .xterm-helper-textarea').click();
      await win.keyboard.press('Enter');
    }
    const s = await sigs(win);
    const start = s.find((x) => x.kind === 'start' && x.session_id);
    if (start) { capturedSession = start.session_id; console.log('SessionStart signal:', capturedSession); break; }
  }
  await win.screenshot({ path: shot('shot-8-claude-boot.png') });
  console.log('signals so far:', JSON.stringify(await sigs(win)));

  // Send a prompt.
  await win.locator('.cell[data-cell="0"] .xterm-helper-textarea').click();
  await win.keyboard.type('reply with just the word: pong');
  await win.keyboard.press('Enter');

  // Wait for the turn to finish -> Stop/idle signal -> glow.
  let glowed = false;
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    const g = await glow0(win);
    if (g === 'idle' || g === 'permission') { glowed = true; break; }
  }
  await win.screenshot({ path: shot('shot-9-claude-glow.png') });
  console.log('glow after reply:', await glow0(win));
  console.log('all signals:', JSON.stringify(await sigs(win)));
  console.log(glowed ? 'GLOW: PASS' : 'GLOW: FAIL (no stop/idle signal)');

  await app.close();
} catch (e) {
  console.log('ERROR:', e.message);
  try { await app.close(); } catch (_) {}
}

// ---- Relaunch: does it resume the same session? ----
if (capturedSession) {
  const { app: app2, win: win2 } = await launchApp({ launchCmd: 'claude', userDataDir: udd, extraEnv: { CW_ROOT_FOLDER: rootDir } });
  try {
    await win2.waitForFunction(() => window.__ready === true, { timeout: 10000 });
    await sleep(2500);
    const l0 = await win2.evaluate(() => window.__launch['0']);
    console.log('relaunch launch info:', JSON.stringify(l0));
    console.log(l0 && l0.resumeId === capturedSession ? 'RESUME: PASS' : 'RESUME: FAIL');
    await win2.screenshot({ path: shot('shot-10-resumed.png') });
    await app2.close();
  } catch (e) { console.log('relaunch ERROR:', e.message); try { await app2.close(); } catch (_) {} }
} else {
  console.log('RESUME: SKIPPED (no session captured)');
}

fs.rmSync(udd, { recursive: true, force: true });
