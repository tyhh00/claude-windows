// Hero scene: a board of agents, one glows the moment it needs you, a click clears it.
// The signature "what is this" clip for the top of the README.
import fs from 'fs'; import os from 'os'; import path from 'path';
import { makeFakeHome, launchDemoApp, Recorder, sleep, __dirname } from './lib.mjs';

const { home } = makeFakeHome();
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'hna-demo-proj-'));

const { app, win, udd } = await launchDemoApp({ home, projDir: proj });
try {
  // Clean 2x2 board with task-like names, so the sidebar reads like real work.
  await win.evaluate(() => window.__setLayout && window.__setLayout('2x2'));
  await sleep(500);
  await win.evaluate(() => window.__cleanBoard && window.__cleanBoard());
  await sleep(500);
  const names = [
    ['0', 'auth-refactor', 'refactor the auth module to use sessions'],
    ['1', 'stripe-checkout', 'add Stripe checkout to billing'],
    ['2', 'flaky-tests', 'fix the flaky CI test suite'],
    ['3', 'api-docs', 'generate OpenAPI docs from routes'],
  ];
  await win.evaluate((ns) => ns.forEach(([sid, name, topic]) => { window.__rename(sid, name); window.__markReal(sid, topic); }), names);
  // Two agents working (green pulse), the board alive.
  await win.evaluate(() => { window.__setRunning('1', true); window.__setRunning('2', true); });
  await sleep(700);

  const rec = new Recorder(win);
  await rec.start();
  rec.caption('Run many coding agents at once — one grid', 1900);
  await rec.hold(1700);

  // One agent finishes and now needs you: its cell glows amber and jumps to the top of the sidebar.
  rec.caption('A cell glows the moment its agent needs you', 2000);
  await win.evaluate(() => { window.__setRunning('0', false); window.__setGlow('0', 'idle'); });
  await rec.moveToSel('#sb-list .sb-item'); // drift toward the needs-you list
  await rec.hold(1600);

  // Click into the glowing cell — the glow clears (implicit acknowledgement).
  rec.caption('Click in to pick it up — the glow clears', 1800);
  await rec.clickSel('.cell.glow-idle .pane-body');
  await rec.hold(900);
  rec.caption('Close and reopen — the whole board resumes', 2100);
  await rec.hold(2100);

  const meta = await rec.stop(path.join(__dirname, 'frames', 'hero'));
  console.log(`hero scene: ${meta.frames.length} frames, ${meta.durationMs}ms`);
} finally {
  try { await Promise.race([app.close(), sleep(3500)]); } catch (_) {}
  for (const d of [home, proj, udd]) fs.rmSync(d, { recursive: true, force: true });
}
