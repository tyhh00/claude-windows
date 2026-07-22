// Render a captured scene into a polished, size-trimmed GIF:
//   real-UI frames + cursor-follow zoom + captions  (Remotion -> high-quality mp4)
//   -> ffmpeg two-pass palette GIF at ~1400px / 24fps  (crisp but ~5-6MB, not 11)
// Usage: node render.mjs <scene>   reads demo/frames/<scene>, writes docs/media/<scene>.gif
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { bundle } from '@remotion/bundler';
import { selectComposition, renderMedia, ensureBrowser } from '@remotion/renderer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scene = process.argv[2] || 'accounts';
const framesDir = path.join(__dirname, 'frames');
const sceneDir = path.join(framesDir, scene);
if (!fs.existsSync(path.join(sceneDir, 'meta.json'))) {
  console.error(`No capture at ${sceneDir}. Run the scene script first.`);
  process.exit(1);
}
const meta = JSON.parse(fs.readFileSync(path.join(sceneDir, 'meta.json'), 'utf8'));
const png = fs.readFileSync(path.join(sceneDir, 'f0000.png'));
const width = png.readUInt32BE(16), height = png.readUInt32BE(20);

const GIF_WIDTH = 1400; // trimmed target (max-fidelity but not the full 2560px)
const GIF_FPS = 24;

const outDir = path.join(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });
const mp4 = path.join(outDir, `${scene}.mp4`);
const palette = path.join(outDir, `${scene}-palette.png`);
const gif = path.join(__dirname, '..', 'docs', 'media', `${scene}.gif`);
fs.mkdirSync(path.dirname(gif), { recursive: true });

console.log(`[${scene}] ${meta.frames.length} frames, ${meta.durationMs}ms, ${width}x${height}`);

// 1) Remotion -> near-lossless mp4 (real UI + zoom + captions, full resolution).
await ensureBrowser();
const serveUrl = await bundle({ entryPoint: path.join(__dirname, 'remotion', 'index.js'), publicDir: framesDir });
const inputProps = { scene, meta, width, height };
const composition = await selectComposition({ serveUrl, id: 'Scene', inputProps });
await renderMedia({
  composition, serveUrl, codec: 'h264', crf: 16, outputLocation: mp4, inputProps,
  onProgress: ({ progress }) => process.stdout.write(`\r  mp4 ${Math.round(progress * 100)}%   `),
});
process.stdout.write('\n');

// 2) ffmpeg two-pass palette -> a crisp, size-trimmed GIF.
const vf = `fps=${GIF_FPS},scale=${GIF_WIDTH}:-1:flags=lanczos`;
execFileSync('ffmpeg', ['-y', '-i', mp4, '-vf', `${vf},palettegen=max_colors=256:stats_mode=diff`, palette], { stdio: 'ignore' });
execFileSync('ffmpeg', ['-y', '-i', mp4, '-i', palette,
  '-filter_complex', `${vf}[x];[x][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle`, gif], { stdio: 'ignore' });

const kb = Math.round(fs.statSync(gif).size / 1024);
console.log(`[${scene}] wrote ${path.relative(path.join(__dirname, '..'), gif)} (${(kb / 1024).toFixed(1)} MB, ${GIF_WIDTH}px @ ${GIF_FPS}fps)`);
