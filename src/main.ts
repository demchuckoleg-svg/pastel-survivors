import './style.css';
import { PALETTE } from './art/palette';
import {
  drawPixelSprite,
  initSprites,
  type GroundSpriteId,
} from './art/sprites';

const PIXEL_SCALE = 3;
const TILE_PX = 16 * PIXEL_SCALE;
const DECOR_KEYS: GroundSpriteId[] = [
  'flower_pink',
  'flower_blue',
  'flower_yellow',
  'clover',
  'pebble',
  'tuft',
];

function tileHash(tx: number, ty: number): number {
  let h = (tx * 374761393 + ty * 668265263) | 0;
  h = ((h ^ (h >> 13)) * 1274126177) | 0;
  return ((h ^ (h >> 16)) >>> 0) % 100;
}

function bootstrap(): void {
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const sprites = initSprites();

  let width = window.innerWidth;
  let height = window.innerHeight;

  const resize = (): void => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
  };

  resize();
  window.addEventListener('resize', resize);

  let camX = 0;
  let camY = 0;
  let lastTime = performance.now();
  let elapsed = 0;

  const frame = (now: number): void => {
    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;
    elapsed += dt;

    // Gentle diagonal scroll to demonstrate infinite pastel ground
    camX += 42 * dt;
    camY += 18 * dt;

    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = PALETTE.groundBase;
    ctx.fillRect(0, 0, width, height);

    const startTx = Math.floor((camX - width / 2) / TILE_PX) - 1;
    const endTx = Math.ceil((camX + width / 2) / TILE_PX) + 1;
    const startTy = Math.floor((camY - height / 2) / TILE_PX) - 1;
    const endTy = Math.ceil((camY + height / 2) / TILE_PX) + 1;

    for (let ty = startTy; ty <= endTy; ty++) {
      for (let tx = startTx; tx <= endTx; tx++) {
        const sx = Math.round(tx * TILE_PX - camX + width / 2);
        const sy = Math.round(ty * TILE_PX - camY + height / 2);
        ctx.drawImage(sprites.ground.tile, sx, sy, TILE_PX, TILE_PX);

        const h = tileHash(tx, ty);
        if (h < 18) {
          const decor = sprites.ground[DECOR_KEYS[h % DECOR_KEYS.length]];
          ctx.drawImage(decor, sx, sy, TILE_PX, TILE_PX);
        }
      }
    }

    // Draw test hero sprite at screen center with subtle shadow & 2-frame walk bob
    const cx = width / 2;
    const cy = height / 2;
    const walkFrame = Math.floor(elapsed * 5) % 2;

    ctx.fillStyle = PALETTE.shadow;
    ctx.beginPath();
    ctx.ellipse(cx, cy + 20, 14, 6, 0, 0, Math.PI * 2);
    ctx.fill();

    drawPixelSprite(ctx, sprites.heroes.mage[walkFrame], cx, cy, PIXEL_SCALE);

    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);
}

bootstrap();
