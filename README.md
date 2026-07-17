# Claude Windows

A Windows desktop app that hosts many **Claude Code** sessions in a configurable grid, glows a
cell the moment its session is done and waiting on you, and restores the whole board (sessions,
names, glow state, folders) after a restart or crash.

Built for running 12 to 16 Claude Code sessions at once without losing your place.

## Features

- **Grid of live terminals.** One real terminal (ConPTY) per cell, each running `claude`.
  Landscape layouts (2x4, 3x4, 4x4, 2x2) and portrait layouts for vertical monitors
  (4x2, 6x2, 8x2, 6x1). The layout dropdown shows a little grid glyph for each option.
- **Glow when a session needs you.** Driven by Claude Code hooks:
  - steady amber: the session finished its turn and is waiting for your reply
  - breathing blue: the session is blocked needing a permission approval
  - typing into a cell clears its glow.
- **Optional sounds.** Attach your own mp3 or wav, separately for "done" and "needs permission".
- **Autosave and resume.** On reopen, every cell resumes its exact conversation
  (`claude --resume <id>`) in its original folder, with the name you set and its glow restored.
- **Editable names.** Double-click or right-click a cell header to rename. The name is bound to
  the session, so it follows that conversation across restarts.
- **Project folder.** Point the app at a folder and new sessions all start there.
- **Open in VS Code.** Each cell has a button that opens its folder in VS Code.
- **Your config stays yours.** Glow hooks are added to `~/.claude/settings.json` on startup, but
  only Claude Windows entries are touched. Your own hooks are preserved, and you can disconnect.

## Requirements

- Windows 10 or 11 with Windows Terminal / ConPTY (built in on Windows 11)
- Node.js (used to run Electron; no C++ compiler needed, the PTY ships prebuilt)
- Claude Code installed and on PATH (`claude`)

## Compatibility

- **Claude Code hooks tested against: `2.1.x`.**

The glow and resume features rely on Claude Code's hook schema (SessionStart, the Notification
matchers `idle_prompt` and `permission_prompt`, Stop, and `claude --resume`). These were verified
on the `2.1.x` line. If a future Claude Code release changes them, glow degrades gracefully
(no crash) rather than breaking. Contributions that widen the tested range are very welcome:
bump this note and add coverage as you confirm newer versions.

## Install and run

```bash
npm install
npm start
```

Glow and resume work out of the box: the app installs its hooks on startup and learns each
session id as it starts.

## How it works

```
 Electron main                                each cell
 - one node-pty per cell (runs claude)        powershell -> claude --resume <id>
 - 127.0.0.1 signal server (+ per-run token)          |
 - state.json (layout, names, glow, sessions)         | hooks POST {cell, session_id, kind}
 Renderer                                             v
 - xterm.js grid, glow, settings          signal.ps1 (SessionStart / Stop /
                                           idle_prompt / permission_prompt)
```

- Each cell is spawned with `CC_CELL_ID` plus the signal server's port and token in its
  environment.
- A small PowerShell hook (`src/hooks/signal.ps1`) posts `{cell, session_id, kind}` back to the
  app on SessionStart, Stop, idle, and permission. That is how the app learns each cell's session
  id (race free) and when to glow.
- State is written atomically (temp then rename) and debounced, so a crash leaves the last good
  state.

See `docs/ARCHITECTURE.md` for the full design.

## Tests

```bash
npm test
```

Every phase is verified by driving the real app with Playwright (screenshots plus terminal-buffer
assertions):

| Test | Covers |
|------|--------|
| `test/hooks.cjs` | settings.json merge preserves your own hooks; idempotent; clean uninstall |
| `test/smoke.mjs` | one live terminal, real PTY round trip |
| `test/grid.mjs` | 12 independent terminals, layout switching |
| `test/signal.mjs` | real `signal.ps1` round trip, cell correlation, bad-token rejection |
| `test/glow.mjs` | done to amber, permission to breathing blue, keystroke clears |
| `test/persist.mjs` | autosave and resume: names, glow, sessions, cwd survive restart |
| `test/settings.mjs` | settings persist and reflect after restart; sound pipeline; hooks connect |

There is also `test/e2e-real.mjs`, a live test against an authenticated `claude` (not part of
`npm test`, since it needs auth and network).

## Notes and limitations

- Restores conversations, not processes. A session that was running a dev server reopens in the
  right folder, but you restart the server yourself.
- Uses `@lydell/node-pty` (prebuilt ConPTY, no compiler), pinned to `1.1.0` to avoid a debug
  assertion on PTY teardown in the beta builds.
- Electron is pinned to `32` because its installer runs on Node 20; newer Electron needs Node 22.
- Depends on Claude Code's hook schema (SessionStart, Notification matchers, `--resume`), verified
  against Claude Code 2.1.x. If those change, glow degrades gracefully rather than breaking.

## Contributing

Issues and pull requests are welcome. Good first areas: widening the tested Claude Code version
range (see Compatibility), more layouts, packaging, and cross-checking the hook schema on newer
Claude Code releases.

## License

MIT
