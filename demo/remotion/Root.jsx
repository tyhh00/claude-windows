import React from 'react';
import { Composition } from 'remotion';
import { Scene } from './Scene.jsx';

// Dimensions + duration come from each scene's meta.json (passed as input props at render time).
export const RemotionRoot = () => (
  <Composition
    id="Scene"
    component={Scene}
    defaultProps={{ scene: 'accounts', meta: { fps: 30, viewport: { w: 1280, h: 788 }, frames: [], cursor: [], captions: [], durationMs: 1000 } }}
    calculateMetadata={({ props }) => {
      const fps = props.meta.fps || 30;
      return {
        fps,
        durationInFrames: Math.max(1, Math.ceil((props.meta.durationMs / 1000) * fps)),
        width: props.width || 2560,
        height: props.height || 1576,
      };
    }}
  />
);
