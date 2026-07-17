// Multi-window: two independent session-keyed windows, glow isolated per window,
// renamable titles, both persist and reopen on relaunch.
import fs from 'fs';
import path from 'path';
import { _electron as electron } from 'playwright';
import { root, sleep, runtime, fireHook, tmpUserDataDir } from './_helper.mjs';

const udd = tmpUserDataDir();
// Pre-seed w1 small so the test stays light; the second window opens at default 3x4.
fs.mkdirSync(path.join(udd, 'windows'), { recursive: true });
fs.writeFileSync(path.join(udd, 'windows', 'w1.json'),
  JSON.stringify({ windowId: 'w1', title: 'window-1', layout: { rows: 2, cols: 2 }, rootFolder: null, cells: {} }));

let fail = false;
const assert = (c, m) => { if (!c) { fail = true; console.log('FAIL:', m); } else console.log('ok:', m); };
const launch = () => electron.launch({ args: [root, `--user-data-dir=${udd}`], cwd: root, env: { ...process.env, CW_LAUNCH_CMD: 'SHELL' } });
const idOf = (p) => p.evaluate(() => window.__windowId);
const glowOf = (p, i) => p.evaluate((n) => window.__glow[n] || 'none', i);

const app = await launch();
try {
  const w1 = await app.firstWindow();
  await w1.waitForFunction(() => window.__ready === true, { timeout: 15000 });
  assert((await idOf(w1)) === 'w1', 'first window is w1');

  await w1.locator('#new-window-btn').click();
  const w2 = await app.waitForEvent('window', { timeout: 10000 });
  await w2.waitForFunction(() => window.__ready === true, { timeout: 15000 });
  assert((await idOf(w2)) === 'w2', 'second window is w2');
  assert(app.windows().length === 2, 'two windows open');

  const rt = runtime(udd);

  // Glow is isolated per window.
  await fireHook({ kind: 'idle', cell: 'w2#0', port: rt.port, token: rt.token });
  await sleep(800);
  assert((await glowOf(w2, 0)) === 'idle', 'w2 cell0 glows');
  assert((await glowOf(w1, 0)) === 'none', 'w1 cell0 does NOT glow (isolated)');

  await fireHook({ kind: 'permission', cell: 'w1#1', port: rt.port, token: rt.token });
  await sleep(800);
  assert((await glowOf(w1, 1)) === 'permission', 'w1 cell1 glows blue');
  assert((await glowOf(w2, 1)) === 'none', 'w2 cell1 does NOT glow (isolated)');

  // Rename window 1.
  const t = w1.locator('#win-title');
  await t.dblclick();
  await w1.keyboard.press('Control+A');
  await w1.keyboard.type('Left Monitor');
  await w1.keyboard.press('Enter');
  await sleep(600);

  assert(fs.existsSync(path.join(udd, 'windows', 'w1.json')), 'w1.json exists');
  assert(fs.existsSync(path.join(udd, 'windows', 'w2.json')), 'w2.json exists');
  const w1state = JSON.parse(fs.readFileSync(path.join(udd, 'windows', 'w1.json'), 'utf8'));
  assert(w1state.title === 'Left Monitor', 'w1 title persisted');

  await app.close();
} catch (e) { fail = true; console.log('ERROR:', e.message); try { await app.close(); } catch (_) {} }

// Relaunch: both windows come back.
const app2 = await launch();
try {
  await sleep(3500);
  assert(app2.windows().length === 2, 'both windows reopen on relaunch');
  await app2.close();
} catch (e) { fail = true; console.log('ERROR2:', e.message); try { await app2.close(); } catch (_) {} }

console.log(fail ? 'RESULT: FAIL' : 'RESULT: PASS');
fs.rmSync(udd, { recursive: true, force: true });
if (fail) process.exit(1);
