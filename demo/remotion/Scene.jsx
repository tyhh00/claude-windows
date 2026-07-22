import React from 'react';
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig, interpolate, Easing } from 'remotion';

const SMAX = 1.55;       // zoom factor at the peak of an interaction
const RAMP = 420;        // ms to ease the zoom in/out around a click
const HOLD = 900;        // ms the zoom holds after a click

// Cursor position (device px) at time tMs, linearly interpolated between logged CSS points.
function cursorAt(cursor, tMs, dpr) {
  if (!cursor.length) return { x: 0, y: 0 };
  let a = cursor[0], b = cursor[cursor.length - 1];
  for (let i = 0; i < cursor.length - 1; i++) {
    if (cursor[i].tMs <= tMs && cursor[i + 1].tMs >= tMs) { a = cursor[i]; b = cursor[i + 1]; break; }
    if (cursor[i].tMs > tMs) { b = a = cursor[i]; break; }
  }
  const span = Math.max(1, b.tMs - a.tMs);
  const f = Math.max(0, Math.min(1, (tMs - a.tMs) / span));
  return { x: (a.x + (b.x - a.x) * f) * dpr, y: (a.y + (b.y - a.y) * f) * dpr };
}

// Zoom envelope: rises to SMAX around each click, holds, then eases back to 1.
function zoomAt(cursor, tMs) {
  const clicks = cursor.filter((c) => c.click);
  let z = 1;
  for (const c of clicks) {
    const t0 = c.tMs, up = t0 - RAMP, down = t0 + HOLD, end = down + RAMP;
    if (tMs >= up && tMs <= end) {
      let s;
      if (tMs < t0) s = interpolate(tMs, [up, t0], [0, 1], { easing: Easing.inOut(Easing.ease), extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
      else if (tMs <= down) s = 1;
      else s = interpolate(tMs, [down, end], [1, 0], { easing: Easing.inOut(Easing.ease), extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
      z = Math.max(z, 1 + (SMAX - 1) * s);
    }
  }
  return z;
}

export const Scene = ({ scene, meta }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const tMs = (frame / fps) * 1000;
  const dpr = meta.viewport ? width / meta.viewport.w : 2;

  // Nearest captured frame at or before now (the real UI at this instant).
  let idx = meta.frames.length ? meta.frames[0].i : 0;
  for (const f of meta.frames) { if (f.tMs <= tMs) idx = f.i; else break; }
  const src = staticFile(`${scene}/f${String(idx).padStart(4, '0')}.png`);

  const S = zoomAt(meta.cursor, tMs);
  const cur = cursorAt(meta.cursor, tMs, dpr);
  // Focus blends from centre (no pan at 1x) to the cursor (full follow at peak zoom).
  const k = (S - 1) / (SMAX - 1);
  const fx = width / 2 + (cur.x - width / 2) * k;
  const fy = height / 2 + (cur.y - height / 2) * k;
  // Keep the focus point centred while scaling by S, clamped so the frame never shows empty edges.
  let tx = width / 2 - fx * S, ty = height / 2 - fy * S;
  tx = Math.min(0, Math.max(width - width * S, tx));
  ty = Math.min(0, Math.max(height - height * S, ty));

  // Active caption (fade in/out).
  const cap = (meta.captions || []).find((c) => tMs >= c.tMs && tMs <= c.tMs + c.durMs);
  let capOpacity = 0;
  if (cap) {
    const inT = 220, outT = 260;
    capOpacity = interpolate(tMs, [cap.tMs, cap.tMs + inT, cap.tMs + cap.durMs - outT, cap.tMs + cap.durMs],
      [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  }

  return (
    <AbsoluteFill style={{ backgroundColor: '#0b0b0d' }}>
      <AbsoluteFill style={{ transform: `translate(${tx}px, ${ty}px) scale(${S})`, transformOrigin: '0 0' }}>
        <Img src={src} style={{ width, height }} />
      </AbsoluteFill>
      {cap && (
        <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', paddingBottom: height * 0.06 }}>
          <div style={{
            opacity: capOpacity, maxWidth: '78%',
            font: `600 ${Math.round(height * 0.032)}px -apple-system, "Segoe UI", system-ui, sans-serif`,
            color: '#fff', background: 'rgba(18,19,22,0.82)', backdropFilter: 'blur(6px)',
            border: '1px solid rgba(255,255,255,0.10)', borderRadius: 14,
            padding: `${Math.round(height * 0.018)}px ${Math.round(height * 0.032)}px`,
            boxShadow: '0 10px 40px rgba(0,0,0,0.5)', textAlign: 'center', letterSpacing: 0.2,
          }}>{cap.text}</div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};
