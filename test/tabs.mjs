// Tabbed panes: shrinking the layout must NOT kill sessions — orphaned sessions become tabs.
import fs from 'fs';
import path from 'path';
import { launchApp, sleep, shot, tmpUserDataDir, bufOf } from './_helper.mjs';

const udd = tmpUserDataDir();
fs.mkdirSync(path.join(udd, 'windows'), { recursive: true });
fs.writeFileSync(path.join(udd, 'windows', 'w1.json'),
  JSON.stringify({ windowId: 'w1', title: 'window-1', layout: { rows: 2, cols: 4 }, rootFolder: null, cells: {}, panes: [], seq: 0 }));

let fail = false;
const assert = (c, m) => { if (!c) { fail = true; console.log('FAIL:', m); } else console.log('ok:', m); };
const paneCount = (win) => win.locator('.cell').count();
const sessionCount = (win) => win.evaluate(() => Object.keys(window.__cellTerms).length);

const { app, win } = await launchApp({ launchCmd: 'SHELL', userDataDir: udd });
try {
  await win.waitForFunction(() => window.__ready === true, { timeout: 15000 });
  await sleep(2500);

  assert((await paneCount(win)) === 8, '2x4 shows 8 panes');
  assert((await sessionCount(win)) === 8, '8 sessions exist');

  // Put a unique marker into session 7 so we can prove it survives a shrink.
  await win.locator('.cell[data-cell="7"] .xterm-helper-textarea').click();
  for (let i = 0; i < 20 && !/PS [A-Z]:/.test(await bufOf(win, '7')); i++) await sleep(300);
  await win.keyboard.type('Write-Output "keepme-42"');
  await win.keyboard.press('Enter');
  await sleep(1000);

  // Shrink 2x4 (8) -> 2x2 (4). Sessions 4..7 should become tabs, not die.
  await win.evaluate((k) => window.__setLayout(k), '2x2');
  await sleep(1500);

  assert((await paneCount(win)) === 4, 'after shrink: 4 panes');
  assert((await sessionCount(win)) === 8, 'after shrink: still 8 sessions (NONE killed)');

  // Session 7 is alive and kept its output.
  assert((await bufOf(win, '7')).includes('keepme-42'), 'session 7 survived shrink with its output intact');

  // The last remaining pane now has multiple tabs.
  const tabCount = await win.locator('.cell[data-pane="3"] .tab').count();
  assert(tabCount > 1, `last pane stacked orphaned sessions as tabs (got ${tabCount})`);
  await win.screenshot({ path: shot('shot-12-tabs.png') });

  // Clicking a tab switches the active session in that pane.
  await win.locator('.cell[data-pane="3"] .tab:last-child').click();
  await sleep(400);
  const active = await win.locator('.cell[data-pane="3"]').getAttribute('data-cell');
  assert(active === '7', `clicking the last tab activates session 7 (got ${active})`);

  console.log(fail ? 'RESULT: FAIL' : 'RESULT: PASS');
} finally {
  await app.close();
}
fs.rmSync(udd, { recursive: true, force: true });
if (fail) process.exit(1);
