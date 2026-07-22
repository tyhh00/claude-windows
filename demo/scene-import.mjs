// Scene: bring existing sessions in — they cascade into the grid one at a time (staggered).
import fs from 'fs'; import os from 'os'; import path from 'path';
import { makeFakeHome, seedTranscript, launchDemoApp, Recorder, sleep, __dirname } from './lib.mjs';

const { home, personal } = makeFakeHome();
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'hna-demo-proj-'));
// A handful of real-looking sessions already in this folder, for the importer to find.
const tasks = [
  ['IMP-1', 'refactor the auth module'], ['IMP-2', 'add Stripe checkout'],
  ['IMP-3', 'fix the flaky CI tests'], ['IMP-4', 'write OpenAPI docs'],
  ['IMP-5', 'migrate to Postgres 16'], ['IMP-6', 'add dark mode to settings'],
  ['IMP-7', 'add API rate limiting'], ['IMP-8', 'wire up Slack webhooks'],
];
tasks.forEach(([id, text]) => seedTranscript(personal, id, proj, text));

const { app, win, udd } = await launchDemoApp({ home, projDir: proj, autoImport: true });
try {
  // Keep the default 3x4 grid (one fresh cell per pane, no tabs) so the 8 sessions cascade in
  // cleanly, one per pane — no shrink-orphans folding into tabs.
  await win.waitForSelector('#import-overlay.open', { timeout: 8000 });
  await sleep(600);

  const rec = new Recorder(win);
  await rec.start();
  rec.caption('Bring the Claude sessions you already have into the grid', 2100);
  await rec.hold(1700);

  // Resume all — they open one at a time with an arrival pulse.
  rec.caption('They open one at a time — you see the board fill up', 2600);
  await rec.clickSel('#imp-go');
  // Move up into the grid so the zoom frames the cells filling in (top-first), not the empty bottom.
  await rec.moveTo(430, 250, 10);
  await rec.hold(6000); // 8 sessions x ~500ms stagger + arrival animations

  const meta = await rec.stop(path.join(__dirname, 'frames', 'import'));
  console.log(`import scene: ${meta.frames.length} frames, ${meta.durationMs}ms`);
} finally {
  try { await Promise.race([app.close(), sleep(3500)]); } catch (_) {}
  for (const d of [home, proj, udd]) fs.rmSync(d, { recursive: true, force: true });
}
