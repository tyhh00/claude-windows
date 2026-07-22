// Scene: switching a session between Claude accounts (the flagship feature).
// Records the real UI: badge -> click -> port dialog -> Proceed -> badge + cell tint change account.
import fs from 'fs'; import os from 'os'; import path from 'path';
import { makeFakeHome, seedTranscript, launchDemoApp, Recorder, sleep, __dirname } from './lib.mjs';

const { home, personal } = makeFakeHome();
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'hna-demo-proj-'));
seedTranscript(personal, 'DEMO-PAY', proj, 'add Stripe checkout to the billing page');

const { app, win, udd } = await launchDemoApp({ home, projDir: proj });
try {
  // Resume the seeded session into cell 0 so it carries a real conversation to port.
  await win.evaluate((p) => window.grid.importSession('0', 'DEMO-PAY', p, 80, 24), proj);
  await win.evaluate(() => { const r = window.__cellTerms && window.__cellTerms['0']; if (r) r.reset(); });
  await sleep(1600);
  // Compact 2x2, then clear the stacked tabs so the board is clean (one session per pane).
  await win.evaluate(() => window.__setLayout && window.__setLayout('2x2'));
  await sleep(500);
  await win.evaluate(() => window.__cleanBoard && window.__cleanBoard());
  await sleep(700);

  const rec = new Recorder(win);
  await rec.start();
  rec.caption('Each cell shows the Claude account it runs as', 1600);
  await rec.hold(1300);

  // 1) move to the account badge on the first cell and open the switch menu
  rec.caption('Click the badge to switch accounts', 1500);
  await rec.clickSel('.cell .cell-acct');
  await rec.hold(700);

  // 2) pick the other account from the menu
  await rec.moveToSel('.acct-menu .acct-row:not(.current)');
  await sleep(150); await rec.click();
  await rec.hold(600);

  // 3) the port confirmation — Proceed
  await win.waitForSelector('#port-overlay.open', { timeout: 4000 }).catch(() => {});
  rec.caption('Carry the live conversation across', 1500);
  await rec.clickSel('#port-proceed');
  await rec.hold(900);
  // Move the cursor back onto the badge so the payoff — it flips to the other account's colour —
  // is the final framed shot, instead of the zoom parking on an empty corner.
  rec.caption('Resumed on the other account — no lost context', 2200);
  await rec.moveToSel('.cell .cell-acct');
  await rec.hold(2400); // badge + tint change to the new account, held under the cursor

  const meta = await rec.stop(path.join(__dirname, 'frames', 'accounts'));
  console.log(`accounts scene: ${meta.frames.length} frames, ${meta.durationMs}ms, ${meta.cursor.length} cursor points`);
} finally {
  try { await Promise.race([app.close(), sleep(3500)]); } catch (_) {}
  for (const d of [home, proj, udd]) fs.rmSync(d, { recursive: true, force: true });
}
