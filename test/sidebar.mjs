// Sidebar: lists only REAL sessions (resumed / active), floats needs-you to the top, click
// activates, and collapses from a control on the SESSIONS header row.
import fs from 'fs';
import path from 'path';
import { launchApp, sleep, shot, runtime, fireHook, tmpUserDataDir } from './_helper.mjs';

const udd = tmpUserDataDir();
fs.mkdirSync(path.join(udd, 'windows'), { recursive: true });
fs.writeFileSync(path.join(udd, 'windows', 'w1.json'),
  JSON.stringify({ windowId: 'w1', title: 'window-1', layout: { rows: 2, cols: 2 }, cells: {}, panes: [], seq: 0 }));

let fail = false;
const assert = (c, m) => { if (!c) { fail = true; console.log('FAIL:', m); } else console.log('ok:', m); };

const { app, win, userDataDir } = await launchApp({ launchCmd: 'SHELL', userDataDir: udd });
try {
  await win.waitForFunction(() => window.__ready === true, { timeout: 15000 });
  await sleep(1500);

  // Fresh cells with no real activity do NOT clutter the sidebar.
  assert((await win.locator('#sb-list .sb-item').count()) === 0, 'fresh cells are not listed');
  assert((await win.locator('#sb-list .sb-empty').count()) === 1, 'empty-state shown when nothing is real');

  const rt = runtime(userDataDir);
  await fireHook({ kind: 'idle', cell: 0, port: rt.port, token: rt.token });
  await fireHook({ kind: 'idle', cell: 1, port: rt.port, token: rt.token });
  await fireHook({ kind: 'permission', cell: 3, port: rt.port, token: rt.token });
  await sleep(900);

  assert((await win.locator('#sb-list .sb-item').count()) === 3, 'only the 3 active sessions are listed');
  assert((await win.locator('#sb-list .sb-section').first().textContent()) === 'Needs you', 'Needs-you section is first');
  const firstSid = await win.locator('#sb-list .sb-item').first().getAttribute('data-sid');
  assert(firstSid === '3', `permission session floated to the very top (got ${firstSid})`);
  assert((await win.locator('#sb-list .sb-dot.permission, #sb-list .sb-dot.idle').count()) === 3, 'three glowing sessions surfaced');
  await win.screenshot({ path: shot('shot-13-sidebar.png') });

  await win.locator('#sb-list .sb-item').first().click();
  await sleep(400);
  assert((await win.locator('.cell[data-pane="3"]').getAttribute('data-cell')) === '3', 'clicking a sidebar row activates that session');

  // Collapse/expand from the rail control (stays in the left panel, not the top nav).
  await win.locator('#sb-collapse').click();
  await sleep(300);
  assert(await win.evaluate(() => document.body.classList.contains('sb-collapsed')), 'rail control collapses the sidebar');
  assert(await win.locator('#sb-collapse').isVisible(), 'rail toggle stays visible while collapsed');
  await win.locator('#sb-collapse').click();
  await sleep(300);
  assert(!(await win.evaluate(() => document.body.classList.contains('sb-collapsed'))), 'rail toggle re-opens the sidebar');

  console.log(fail ? 'RESULT: FAIL' : 'RESULT: PASS');
} finally {
  await app.close();
}
fs.rmSync(udd, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
if (fail) process.exit(1);
