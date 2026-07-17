# Deferred ideas

Things we want to build later, captured so we do not lose them.

## Focused Mode

A mode for when you want to step away from the grid and work in another app (browser, editor)
but still get pulled back the instant a Claude session needs you.

Rough shape:
- **Spotify / audio control:** connect to the desktop Spotify app. Play music while you work, and
  duck or pause other audio sources when a session needs attention (or when you enter Focused Mode).
- **Attention popup when unfocused:** when the Claude Windows app is not the focused window and a
  session raises a question (an `ask_user_question` / permission / idle event), surface a small
  always-on-top popup for just that one session. It shows the question and lets you answer inline,
  in a compact "playback-style" render, without switching back to the full grid.
- Net effect: you can browse the web or code elsewhere, and the one session that needs you pops up
  in your face for a quick answer, then gets out of the way.

Open questions:
- Spotify integration surface (Web API with OAuth vs local desktop control).
- Which Claude Code events map to "needs you" (Notification `permission_prompt`, `idle_prompt`,
  and any future `ask_user_question` hook).
- How to render an inline answer box that can send input back into the right PTY.
- Always-on-top popup vs OS notification with inline reply.

## Freeform tabbed layout (big v2 of the layout engine)

Turn the fixed grid into a freeform tiling workspace so no session is ever orphaned.

- **Tabbed panes:** a cell can hold a stack of sessions as tabs; click the header to switch.
- **Draggable panes:** drag a pane (or a tab) to rearrange; drop onto another pane to stack it there.
- **No orphaning on shrink:** switching to a layout with fewer cells moves the extra sessions into
  tabs on remaining panes instead of killing them.
- **Snap-resize / canvas awareness:** when a pane is removed, an adjacent pane can expand into the
  freed space (e.g. a 1x1 grows to 2x1), but only vertically OR horizontally, unless both
  directions free up evenly. Panes snap to a grid of gaps.
- Once panes are moved/resized, the layout becomes freeform (no longer a named 3x4 etc.).

Model impact (large): cells stop being fixed indices. State becomes a set of panes, each with a
position + size + an ordered list of sessions (the tabs) + the active tab. The named layouts
become presets that seed this freeform model. Drag/drop + a tiling/snap solver + tab bars are all
new UI. Best done as a dedicated effort with its own tests, on top of the current stable build.

Note: the CURRENT build kills sessions when you switch to a smaller layout. Until the freeform
model lands, we should at least guard that (confirm-before-shrink, or keep orphaned sessions
alive in an overflow) so no conversation is lost.

## Other parked ideas

- Pinned / stateful dev-server ports per cell (one-click start a repo's localhost on a fixed port).
  Needs a clearer spec: is it a per-cell startup command, a port reservation, or both?
