// The Settings importer must be ADDITIVE: it dedupes against sessions already open in this window,
// lands only in free slots (empty panes after a ✕, or brand-new terminals with no conversation),
// never clobbers a real conversation, grows the grid when free slots run out, and marks
// already-open sessions in the list. Regression for: "resume 5 via settings -> only 1 gets added /
// sometimes it replaces all sessions in the window".
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchApp, sleep, tmpUserDataDir } from './_helper.mjs';

const udd = tmpUserDataDir();
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-home-')); // empty: no profiles, no SoT
const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-proj-'));

let fail = false;
const assert = (c, m) => { if (!c) { fail = true; console.log('FAIL:', m); } else console.log('ok:', m); };
const S = (n) => ({ sessionId: `ADD-S${n}`, title: `session ${n}`, cwd: projDir, mtime: 1700000000000 });
const resumeCounts = (win) => win.evaluate(() => {
  const out = {};
  for (const l of Object.values(window.__launch)) if (l && l.resumeId) out[l.resumeId] = (out[l.resumeId] || 0) + 1;
  return out;
});

const { app, win } = await launchApp({
  launchCmd: 'echo resumed', userDataDir: udd,
  extraEnv: { HOME: fakeHome, CLAUDE_CONFIG_DIR: '', CW_ROOT_FOLDER: projDir },
});
try {
  await win.waitForFunction(() => window.__ready === true, { timeout: 20000 });
  await sleep(1200);
  const paneCount = await win.evaluate(() => document.querySelectorAll('.cell').length);

  // Pane 0 holds a REAL conversation; pane 2's session is closed via ✕ (empty "+ New session" area).
  await win.evaluate((p) => window.grid.importSession('0', 'ADD-S1', p, 80, 24), projDir);
  await sleep(1200);
  await win.evaluate(() => document.querySelector('.cell[data-pane="2"] .cell-btn.close').click());
  await sleep(400);
  const emptied = await win.evaluate(() => !document.querySelector('.cell[data-pane="2"]').dataset.cell);
  assert(emptied, 'pane 2 emptied via ✕');

  // ---- the reported bug: add 5 (one a duplicate of what's open) -------------
  await win.evaluate((list) => window.__doImport(list), [S(2), S(1), S(3), S(4), S(5)]);
  await sleep(1500);
  let counts = await resumeCounts(win);
  assert(counts['ADD-S1'] === 1, `already-open session deduped, not re-imported (S1 x${counts['ADD-S1']})`);
  for (const n of [2, 3, 4, 5]) assert(counts[`ADD-S${n}`] === 1, `S${n} landed exactly once (x${counts[`ADD-S${n}`] || 0})`);
  const s1Home = await win.evaluate(() => window.__launch['0']);
  assert(s1Home && s1Home.resumeId === 'ADD-S1', 'the real conversation in pane 0 was NOT clobbered');
  const pane2 = await win.evaluate(() => {
    const sid = document.querySelector('.cell[data-pane="2"]').dataset.cell;
    return sid ? (window.__launch[sid] || {}).resumeId : null;
  });
  assert(!!pane2, `the ✕'d pane got one of the appended sessions (got ${pane2})`);

  // ---- re-importing the same batch is a no-op -------------------------------
  await win.evaluate((list) => window.__doImport(list), [S(2), S(3)]);
  await sleep(800);
  counts = await resumeCounts(win);
  assert(counts['ADD-S2'] === 1 && counts['ADD-S3'] === 1, 're-import of open sessions changes nothing');

  // ---- free slots run out -> the grid grows, real cells untouched -----------
  const batch = [10, 11, 12, 13, 14, 15, 16, 17].map(S);
  await win.evaluate((list) => window.__doImport(list), batch);
  await sleep(1500);
  const paneCount2 = await win.evaluate(() => document.querySelectorAll('.cell').length);
  assert(paneCount2 > paneCount, `grid grew to fit (${paneCount} -> ${paneCount2} panes)`);
  counts = await resumeCounts(win);
  for (const n of [10, 17]) assert(counts[`ADD-S${n}`] === 1, `S${n} from the big batch landed`);
  assert(counts['ADD-S1'] === 1, 'pane 0 still holds its original conversation after the grid grew');

  // ---- the list marks what's already in this window --------------------------
  await win.evaluate((rows) => window.__showImport({ folder: rows[0].cwd, sessions: rows }, true), [S(1), S(2), S(99)]);
  await sleep(300);
  const ui = await win.evaluate(() => {
    const rows = [...document.querySelectorAll('#imp-list .imp-row')];
    return {
      open: rows.filter((r) => r.classList.contains('imp-open') && r.querySelector('input').disabled).length,
      chips: document.querySelectorAll('#imp-list .imp-here').length,
      count: document.getElementById('imp-count').textContent,
    };
  });
  assert(ui.open === 2, `already-open sessions shown disabled (got ${ui.open}/2)`);
  assert(ui.chips === 2, 'each carries an "in this window" chip');
  assert(/^1 /.test(ui.count), `only the new session is selected (got "${ui.count}")`);
  await win.evaluate(() => document.getElementById('imp-all').click());
  const countAfterAll = await win.evaluate(() => document.getElementById('imp-count').textContent);
  assert(/^1 /.test(countAfterAll), '"select all" cannot re-select what is already open');
  await win.evaluate(() => document.getElementById('imp-skip').click());

  console.log(fail ? 'RESULT: FAIL' : 'RESULT: PASS');
} finally {
  await app.close();
}
for (const d of [udd, fakeHome, projDir]) fs.rmSync(d, { recursive: true, force: true });
if (fail) process.exit(1);
