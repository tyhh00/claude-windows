// Scene: grid layouts (landscape <-> portrait) and jumping between sessions from the sidebar.
import fs from 'fs'; import os from 'os'; import path from 'path';
import { makeFakeHome, launchDemoApp, Recorder, sleep, __dirname } from './lib.mjs';

const { home } = makeFakeHome();
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'hna-demo-proj-'));

const { app, win, udd } = await launchDemoApp({ home, projDir: proj });
try {
  await win.evaluate(() => window.__setLayout && window.__setLayout('2x4'));
  await sleep(500);
  await win.evaluate(() => window.__cleanBoard && window.__cleanBoard());
  const names = [
    ['0', 'auth-refactor', 'refactor the auth module'], ['1', 'stripe-checkout', 'add Stripe checkout'],
    ['2', 'flaky-tests', 'fix the flaky CI tests'], ['3', 'api-docs', 'write OpenAPI docs'],
    ['4', 'pg-migrate', 'migrate to Postgres 16'], ['5', 'dark-mode', 'add dark mode'],
    ['6', 'rate-limit', 'add API rate limiting'], ['7', 'webhooks', 'wire up webhooks'],
  ];
  await win.evaluate((ns) => ns.forEach(([sid, name, topic]) => { window.__rename(sid, name); window.__markReal(sid, topic); }), names);
  await win.evaluate(() => { window.__setRunning('1', true); window.__setRunning('4', true); window.__setGlow('2', 'permission'); });
  await sleep(700);

  const rec = new Recorder(win);
  await rec.start();
  rec.caption('Lay the grid out however you work', 1500);
  await rec.hold(1200);

  // Reflow the SAME 8 sessions between landscape (2x4) and portrait (4x2) — equal pane counts, so
  // nothing folds into tabs; the board just rearranges. Portrait suits a vertical monitor.
  rec.caption('Portrait for a vertical monitor, landscape for wide', 1800);
  await win.evaluate(() => window.__setLayout('4x2')); await rec.hold(1300);
  await win.evaluate(() => window.__setLayout('2x4')); await rec.hold(1000);

  // Jump straight to a session from the needs-you-first sidebar.
  rec.caption('Jump to whatever needs you from the sidebar', 1700);
  await rec.clickSel('#sb-list .sb-item');
  await rec.hold(1300);

  const meta = await rec.stop(path.join(__dirname, 'frames', 'layouts'));
  console.log(`layouts scene: ${meta.frames.length} frames, ${meta.durationMs}ms`);
} finally {
  try { await Promise.race([app.close(), sleep(3500)]); } catch (_) {}
  for (const d of [home, proj, udd]) fs.rmSync(d, { recursive: true, force: true });
}
