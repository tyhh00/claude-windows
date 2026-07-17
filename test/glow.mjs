// P3 verification: hook signals drive glow; keystroke clears it.
import { launchApp, sleep, shot, runtime, fireHook } from './_helper.mjs';

const glowOf = (win, i) => win.evaluate((n) => window.__glow[n] || 'none', i);
const hasClass = (win, i, cls) =>
  win.locator(`.cell[data-cell="${i}"]`).evaluate((el, c) => el.classList.contains(c), cls);

const { app, win, userDataDir } = await launchApp({ launchCmd: 'SHELL' });
let fail = false;
const assert = (c, m) => { if (!c) { fail = true; console.log('FAIL:', m); } else console.log('ok:', m); };
try {
  await sleep(1500);
  const rt = runtime(userDataDir);

  await fireHook({ kind: 'idle', cell: 2, port: rt.port, token: rt.token });
  await sleep(700);
  assert((await glowOf(win, 2)) === 'idle', 'cell 2 glow=idle after idle_prompt');
  assert(await hasClass(win, 2, 'glow-idle'), 'cell 2 has .glow-idle class');

  await fireHook({ kind: 'permission', cell: 7, port: rt.port, token: rt.token });
  await sleep(700);
  assert((await glowOf(win, 7)) === 'permission', 'cell 7 glow=permission after permission_prompt');
  assert(await hasClass(win, 7, 'glow-permission'), 'cell 7 has .glow-permission class');

  await win.screenshot({ path: shot('shot-5-glow.png') });

  await win.locator('.cell[data-cell="2"] .xterm-helper-textarea').click();
  await win.keyboard.type('x');
  await sleep(500);
  assert((await glowOf(win, 2)) === 'none', 'cell 2 glow cleared after keystroke');
  assert((await glowOf(win, 7)) === 'permission', 'cell 7 still glowing (untouched)');

  await fireHook({ kind: 'start', cell: 7, port: rt.port, token: rt.token });
  await sleep(600);
  assert((await glowOf(win, 7)) === 'none', 'cell 7 glow cleared on SessionStart');

  console.log(fail ? 'RESULT: FAIL' : 'RESULT: PASS');
} finally {
  await app.close();
}
if (fail) process.exit(1);
