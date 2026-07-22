// Verifies the launch binary is resolved to an absolute path before a cell spawns, so resume never
// depends on each cell's shell rebuilding PATH. Uses `ls` as a stand-in for `claude` (a real binary
// that resolves the same way, but needs no auth). A fresh cell's launch line must be absolute.
import { launchApp, sleep, tmpUserDataDir } from './_helper.mjs';
import { platform } from 'os';

let fail = false;
const assert = (c, m) => { if (!c) { fail = true; console.log('FAIL:', m); } else console.log('ok:', m); };

// Skip on Windows: resolution is Unix-only (PowerShell resolves differently and wasn't the issue).
if (platform() === 'win32') { console.log('ok: skipped on Windows'); console.log('RESULT: PASS'); process.exit(0); }

const { app, win, userDataDir } = await launchApp({ launchCmd: 'ls' });
try {
  await win.waitForFunction(() => window.__ready === true, { timeout: 20000 });
  await sleep(1200); // let the first cells spawn and report their launch line

  const lines = await win.evaluate(() => Object.values(window.__launch).map((l) => l && l.line).filter(Boolean));
  assert(lines.length > 0, `cells reported a launch line (got ${lines.length})`);
  const line = lines[0];
  assert(line.startsWith('/'), `launch binary is an absolute path, not bare 'ls' (got "${line}")`);
  assert(/\/ls$/.test(line), `resolved to the real ls binary (got "${line}")`);
  console.log(fail ? 'RESULT: FAIL' : 'RESULT: PASS');
} finally {
  await app.close();
}
import fs from 'fs';
fs.rmSync(userDataDir, { recursive: true, force: true });
if (fail) process.exit(1);
