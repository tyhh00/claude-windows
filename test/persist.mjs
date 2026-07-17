// P4 verification: autosave + resume. Create sessions/names/glow, restart the app in the same
// user-data-dir, and confirm layout, names, glow, and resume wiring all come back.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchApp, sleep, shot, runtime, fireHook, tmpUserDataDir } from './_helper.mjs';

const udd = tmpUserDataDir();
// Real folders so resume-in-cwd is genuinely exercised (a real project dir would exist).
const alphaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-alpha-'));
const betaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-beta-'));
let fail = false;
const assert = (c, m) => { if (!c) { fail = true; console.log('FAIL:', m); } else console.log('ok:', m); };

// ---- Session 1: set things up, then close (triggers save) ----
{
  const { app, win } = await launchApp({ launchCmd: 'Write-Output launched', userDataDir: udd });
  await sleep(1500);
  const rt = runtime(udd);

  // Two "claude sessions" land in cells 0 and 1 with their own cwds.
  await fireHook({ kind: 'start', cell: 0, sessionId: 'SESS-AAA', port: rt.port, token: rt.token, cwd: alphaDir });
  await fireHook({ kind: 'start', cell: 1, sessionId: 'SESS-BBB', port: rt.port, token: rt.token, cwd: betaDir });
  // Cell 1 ends up needing permission (glow should persist).
  await fireHook({ kind: 'permission', cell: 1, sessionId: 'SESS-BBB', port: rt.port, token: rt.token, cwd: betaDir });
  await sleep(600);

  // Rename cell 0 through the UI.
  await win.locator('.cell[data-cell="0"] .cell-name').dblclick();
  await win.keyboard.press('Control+A');
  await win.keyboard.type('Alpha Session');
  await win.keyboard.press('Enter');
  await sleep(800); // let the 400ms debounced save flush
  await app.close();
}

// ---- window state on disk ----
const st = JSON.parse(fs.readFileSync(path.join(udd, 'windows', 'w1.json'), 'utf8'));
assert(st.cells['0'].sessionId === 'SESS-AAA', 'cell0 sessionId persisted');
assert(st.cells['0'].cwd === alphaDir, 'cell0 cwd persisted');
assert(st.cells['0'].name === 'Alpha Session', 'cell0 name persisted');
assert(st.cells['1'].sessionId === 'SESS-BBB', 'cell1 sessionId persisted');
assert(st.cells['1'].glow === 'permission', 'cell1 glow persisted');

// ---- Session 2: relaunch, verify restore + resume ----
{
  const { app, win } = await launchApp({ launchCmd: 'Write-Output launched', userDataDir: udd });
  await win.waitForFunction(() => window.__ready === true, { timeout: 10000 });
  await sleep(1800); // let cell:launched events arrive

  const name0 = (await win.locator('.cell[data-cell="0"] .cell-name').textContent()).trim();
  assert(name0 === 'Alpha Session', 'name restored after restart');

  assert((await win.evaluate(() => window.__glow[1])) === 'permission', 'glow restored after restart');

  const l0 = await win.evaluate(() => window.__launch['0']);
  const l1 = await win.evaluate(() => window.__launch['1']);
  const l2 = await win.evaluate(() => window.__launch['2']);
  assert(l0 && l0.resumeId === 'SESS-AAA', 'cell0 resumed with SESS-AAA');
  assert(l0 && l0.cwd === alphaDir, 'cell0 resumed in its saved cwd');
  assert(l0 && l0.line.includes('--resume SESS-AAA'), 'cell0 launch line includes --resume');
  assert(l1 && l1.resumeId === 'SESS-BBB', 'cell1 resumed with SESS-BBB');
  assert(l2 && !l2.resumeId, 'fresh cell (2) has no resume');

  await win.screenshot({ path: shot('shot-6-restored.png') });
  await app.close();
}

console.log(fail ? 'RESULT: FAIL' : 'RESULT: PASS');
for (const d of [udd, alphaDir, betaDir]) fs.rmSync(d, { recursive: true, force: true });
if (fail) process.exit(1);
