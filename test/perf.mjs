// Performance view: with perfView on, the app samples each cell's process tree and pushes
// per-cell + per-window CPU/RAM to the renderer.
import fs from 'fs';
import path from 'path';
import { launchApp, sleep, shot, tmpUserDataDir } from './_helper.mjs';

const udd = tmpUserDataDir();
fs.mkdirSync(path.join(udd, 'windows'), { recursive: true });
fs.writeFileSync(path.join(udd, 'windows', 'w1.json'),
  JSON.stringify({ windowId: 'w1', title: 'window-1', layout: { rows: 2, cols: 2 }, rootFolder: null, cells: {} }));
fs.writeFileSync(path.join(udd, 'settings.json'), JSON.stringify({ perfView: true }));

let fail = false;
const assert = (c, m) => { if (!c) { fail = true; console.log('FAIL:', m); } else console.log('ok:', m); };

const { app, win } = await launchApp({ launchCmd: 'SHELL', userDataDir: udd });
try {
  await win.waitForFunction(() => window.__ready === true, { timeout: 15000 });
  assert(await win.evaluate(() => document.body.classList.contains('perf-on')), 'perf-on class applied from saved setting');

  let perf = null;
  for (let i = 0; i < 14; i++) {
    await sleep(1500);
    perf = await win.evaluate(() => window.__perf);
    if (perf && perf.cells && Object.keys(perf.cells).length) break;
  }
  console.log('perf sample:', JSON.stringify(perf));
  assert(perf && perf.cells, 'received a perf update');
  assert(perf && perf.cells && '0' in perf.cells, 'cell 0 has perf data');
  assert(perf && perf.cells['0'] && typeof perf.cells['0'].mem === 'number' && perf.cells['0'].mem > 0, 'cell 0 has a memory reading (MB)');
  assert(perf && perf.total && typeof perf.total.mem === 'number', 'window total present');

  const badge = await win.locator('.cell[data-cell="0"] .cell-perf').textContent();
  assert(/\d+% ·/.test(badge || ''), `cell badge shows CPU/RAM (got "${badge}")`);
  await win.screenshot({ path: shot('shot-11-perf.png') });

  console.log(fail ? 'RESULT: FAIL' : 'RESULT: PASS');
} finally {
  await app.close();
}
fs.rmSync(udd, { recursive: true, force: true });
if (fail) process.exit(1);
