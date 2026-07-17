// P5 verification: settings pane persists choices, reflects them after restart, the sound
// pipeline yields a data URL, and hook connect/disconnect writes to an ISOLATED config dir.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchApp, sleep, shot, tmpUserDataDir } from './_helper.mjs';

const udd = tmpUserDataDir();
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-cfg-')); // fake ~/.claude
const wav = path.join(cfgDir, 'ding.wav');
fs.writeFileSync(wav, Buffer.from('RIFFfake-wav-bytes')); // extension is what matters here

let fail = false;
const assert = (c, m) => { if (!c) { fail = true; console.log('FAIL:', m); } else console.log('ok:', m); };

// ---- Session 1: change settings via the UI, connect hooks ----
{
  const { app, win } = await launchApp({ launchCmd: 'SHELL', userDataDir: udd, extraEnv: { CLAUDE_CONFIG_DIR: cfgDir } });
  await win.waitForFunction(() => window.__ready === true, { timeout: 10000 });

  await win.locator('#settings-btn').click();
  await sleep(150);
  await win.locator('#set-glow-enabled').uncheck();
  await win.locator('#set-glow-on').selectOption('stop');
  await win.locator('#set-launch').fill('claude --resume-picker');
  await win.locator('.panel h2').click(); // blur -> change
  await win.locator('#set-done-enabled').check();
  await sleep(600); // debounced save
  await win.screenshot({ path: shot('shot-7-settings.png') });

  // Sound pipeline: main reads a file and returns a data: URL.
  const dataUrl = await win.evaluate((p) => window.grid.loadSound(p), wav);
  assert(typeof dataUrl === 'string' && dataUrl.startsWith('data:audio/wav;base64,'), 'sound file loads as data URL');

  await win.locator('#hooks-connect').click();
  await sleep(500);
  await app.close();
}

// ---- global settings.json reflects the changes ----
const s2 = JSON.parse(fs.readFileSync(path.join(udd, 'settings.json'), 'utf8'));
assert(s2.glowEnabled === false, 'glowEnabled persisted (false)');
assert(s2.glowOn === 'stop', 'glowOn persisted (stop)');
assert(s2.launch.command === 'claude --resume-picker', 'launch command persisted');
assert(s2.doneSound.enabled === true, 'doneSound enabled persisted');

// ---- hooks written to the ISOLATED config dir (never the real ~/.claude) ----
const hj = JSON.parse(fs.readFileSync(path.join(cfgDir, 'settings.json'), 'utf8'));
const ours = (g) => g.hooks[0].command.includes('signal.ps1');
assert(hj.hooks?.SessionStart?.some(ours), 'hooks connected into CLAUDE_CONFIG_DIR');
assert(hj.hooks?.Notification?.filter(ours).length === 2, 'idle+permission notification hooks connected');

// ---- Session 2: controls reflect saved settings; then disconnect hooks ----
{
  const { app, win } = await launchApp({ launchCmd: 'SHELL', userDataDir: udd, extraEnv: { CLAUDE_CONFIG_DIR: cfgDir } });
  await win.waitForFunction(() => window.__ready === true, { timeout: 10000 });
  await win.locator('#settings-btn').click();
  await sleep(200);
  assert((await win.locator('#set-glow-enabled').isChecked()) === false, 'glow checkbox reflects saved state');
  assert((await win.locator('#set-glow-on').inputValue()) === 'stop', 'glow-on reflects saved state');
  assert((await win.locator('#set-launch').inputValue()) === 'claude --resume-picker', 'launch field reflects saved state');
  assert((await win.locator('#set-done-enabled').isChecked()) === true, 'done-sound checkbox reflects saved state');

  await win.locator('#hooks-disconnect').click();
  await sleep(400);
  await app.close();
}

const hj2 = JSON.parse(fs.readFileSync(path.join(cfgDir, 'settings.json'), 'utf8'));
assert(!hj2.hooks || !hj2.hooks.SessionStart, 'hooks disconnected (SessionStart removed)');

console.log(fail ? 'RESULT: FAIL' : 'RESULT: PASS');
for (const d of [udd, cfgDir]) fs.rmSync(d, { recursive: true, force: true });
if (fail) process.exit(1);
