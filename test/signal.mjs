// P2 integration test: fire the REAL signal.ps1 hook; the app receives it, correlates the
// cell, and rejects a bad token.
import { launchApp, sleep, runtime, fireHook } from './_helper.mjs';

const { app, win, userDataDir } = await launchApp({ launchCmd: 'SHELL' });
let fail = false;
const assert = (c, m) => { if (!c) { fail = true; console.log('FAIL:', m); } else console.log('ok:', m); };
try {
  await sleep(1500);
  const rt = runtime(userDataDir);
  console.log('signal server port:', rt.port);

  await fireHook({ kind: 'start', cell: 3, sessionId: 'sess-abc-123', port: rt.port, token: rt.token });
  await sleep(900);
  let sigs = await win.evaluate(() => window.__signals || []);
  const got = sigs.find((s) => s.cell === '3' && s.session_id === 'sess-abc-123');
  assert(got, 'valid SessionStart signal received & correlated to cell 3');
  if (got) assert(got.kind === 'start', 'kind propagated (start)');

  await fireHook({ kind: 'permission', cell: 3, sessionId: 'sess-abc-123', port: rt.port, token: rt.token });
  await sleep(900);
  sigs = await win.evaluate(() => window.__signals || []);
  assert(sigs.some((s) => s.kind === 'permission' && s.cell === '3'), 'permission notification received');

  await fireHook({ kind: 'idle', cell: 9, sessionId: 'sess-SPOOF', port: rt.port, token: 'WRONG-TOKEN' });
  await sleep(900);
  sigs = await win.evaluate(() => window.__signals || []);
  assert(!sigs.some((s) => s.session_id === 'sess-SPOOF'), 'bad-token signal rejected by server');

  console.log(fail ? 'RESULT: FAIL' : 'RESULT: PASS');
} finally {
  await app.close();
}
if (fail) process.exit(1);
