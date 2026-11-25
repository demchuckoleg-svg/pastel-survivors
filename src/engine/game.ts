import { PALETTE } from '../art/palette';
import {
  drawPixelSprite,
  initSprites,
  type GroundSpriteId,
  type HeroId,
  type SpriteAtlas,
} from '../art/sprites';
import { AudioManager } from './audio';
import { InputManager } from './input';
import { SpatialHash, type SpatialEntity } from './spatialHash';
import type { AimMode } from './storage';

/**
 * Core clamped-dt game loop, smooth camera tracking, and player movement engine.
 */

export type GameState =
  | 'menu'
  | 'playing'
  | 'paused'
  | 'levelup'
  | 'artifact'
  | 'gameover';

export interface PlayerState {
  heroId: HeroId;
  x: number;
  y: number;
  vx: number;
  vy: number;
  speed: number;
  radius: number;
  hp: number;
  maxHp: number;
  facingLeft: boolean;
  aimAngle: number;
  walkTime: number;
  isMoving: boolean;
}

export interface CameraState {
  x: number;
  y: number;
  smoothness: number;
  shakeIntensity: number;
  shakeTimeLeft: number;
  shakeOffsetX: number;
  shakeOffsetY: number;
}

export interface GameEngineCallbacks {
  onStateChange?: (state: GameState) => void;
  onAimModeChange?: (mode: AimMode) => void;
}

const MAX_DT = 0.05;
const PIXEL_SCALE = 3;
const TILE_PX = 16 * PIXEL_SCALE;
const CAMERA_SMOOTHNESS = 8.5;

const HERO_BASE_STATS: Record<HeroId, { maxHp: number; speed: number }> = {
  mage: { maxHp: 85, speed: 118 },
  ranger: { maxHp: 95, speed: 138 },
  knight: { maxHp: 135, speed: 112 },
};

const DECOR_KEYS: readonly GroundSpriteId[] = [
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

export class GameEngine {
  public readonly canvas: HTMLCanvasElement;
  public readonly ctx: CanvasRenderingContext2D;
  public readonly sprites: SpriteAtlas;
  public readonly audio: AudioManager;
  public readonly input: InputManager;
  public readonly spatialHash: SpatialHash<SpatialEntity>;

  public readonly player: PlayerState;
  public readonly camera: CameraState;

  private readonly callbacks: GameEngineCallbacks;
  private state: GameState = 'playing';
  private viewportWidth = 0;
  private viewportHeight = 0;
  private elapsedRunSec = 0;
  private rafId: number | null = null;
  private lastTimestamp = 0;

  constructor(canvas: HTMLCanvasElement, callbacks: GameEngineCallbacks = {}) {
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to initialize 2D canvas context');
    }

    this.canvas = canvas;
    this.ctx = ctx;
    this.callbacks = callbacks;
    this.sprites = initSprites();
    this.audio = new AudioManager();
    this.spatialHash = new SpatialHash<SpatialEntity>(64);

    this.input = new InputManager(canvas, {
      onPauseToggle: () => this.togglePause(),
      onAimModeToggle: (mode) => {
        this.audio.playClick();
        this.callbacks.onAimModeChange?.(mode);
      },
      onUserGesture: () => this.audio.unlock(),
    });

    const base = HERO_BASE_STATS.mage;
    this.player = {
      heroId: 'mage',
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      speed: base.speed,
      radius: 14,
      hp: base.maxHp,
      maxHp: base.maxHp,
      facingLeft: false,
      aimAngle: 0,
      walkTime: 0,
      isMoving: false,
    };

    this.camera = {
      x: 0,
      y: 0,
      smoothness: CAMERA_SMOOTHNESS,
      shakeIntensity: 0,
      shakeTimeLeft: 0,
      shakeOffsetX: 0,
      shakeOffsetY: 0,
    };

    this.handleResize();
    window.addEventListener('resize', this.handleResize);
  }

  public getState(): GameState {
    return this.state;
  }

  public getElapsedRunSec(): number {
    return this.elapsedRunSec;
  }

  public getViewportSize(): { width: number; height: number } {
    return { width: this.viewportWidth, height: this.viewportHeight };
  }

  public setState(next: GameState): void {
    if (this.state === next) return;
    this.state = next;
    if (next !== 'playing') {
      this.input.reset();
    }
    this.callbacks.onStateChange?.(next);
  }

  public startRun(heroId: HeroId = 'mage'): void {
    const base = HERO_BASE_STATS[heroId];
    this.player.heroId = heroId;
    this.player.x = 0;
    this.player.y = 0;
    this.player.vx = 0;
    this.player.vy = 0;
    this.player.speed = base.speed;
    this.player.hp = base.maxHp;
    this.player.maxHp = base.maxHp;
    this.player.facingLeft = false;
    this.player.aimAngle = 0;
    this.player.walkTime = 0;
    this.player.isMoving = false;

    this.camera.x = 0;
    this.camera.y = 0;
    this.camera.shakeIntensity = 0;
    this.camera.shakeTimeLeft = 0;
    this.camera.shakeOffsetX = 0;
    this.camera.shakeOffsetY = 0;

    this.elapsedRunSec = 0;
    this.spatialHash.clear();
    this.setState('playing');
  }

  public pause(): void {
    if (this.state === 'playing') {
      this.setState('paused');
    }
  }

  public resume(): void {
    if (this.state === 'paused') {
      this.lastTimestamp = performance.now();
      this.setState('playing');
    }
  }

  public togglePause(): void {
    if (this.state === 'playing') {
      this.audio.playClick();
      this.pause();
    } else if (this.state === 'paused') {
      this.audio.playClick();
      this.resume();
    }
  }

  public addScreenShake(intensity: number, durationSec: number): void {
    if (intensity >= this.camera.shakeIntensity) {
      this.camera.shakeIntensity = intensity;
    }
    this.camera.shakeTimeLeft = Math.max(this.camera.shakeTimeLeft, durationSec);
  }

  public worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return {
      x: wx - (this.camera.x + this.camera.shakeOffsetX) + this.viewportWidth / 2,
      y: wy - (this.camera.y + this.camera.shakeOffsetY) + this.viewportHeight / 2,
    };
  }

  public screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: sx - this.viewportWidth / 2 + this.camera.x,
      y: sy - this.viewportHeight / 2 + this.camera.y,
    };
  }

  public start(): void {
    if (this.rafId !== null) return;
    this.lastTimestamp = performance.now();
    this.rafId = requestAnimationFrame(this.loop);
  }

  public stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  public destroy(): void {
    this.stop();
    window.removeEventListener('resize', this.handleResize);
    this.input.destroy();
  }

  private readonly handleResize = (): void => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.viewportWidth = window.innerWidth;
    this.viewportHeight = window.innerHeight;
    this.canvas.width = Math.floor(this.viewportWidth * dpr);
    this.canvas.height = Math.floor(this.viewportHeight * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
  };

  private readonly loop = (now: number): void => {
    const rawDt = (now - this.lastTimestamp) / 1000;
    this.lastTimestamp = now;
    const dt = Math.min(Math.max(rawDt, 0), MAX_DT);

    if (this.state === 'playing') {
      this.update(dt);
    }

    this.render();
    this.rafId = requestAnimationFrame(this.loop);
  };

  private update(dt: number): void {
    this.elapsedRunSec += dt;
    this.updatePlayer(dt);
    this.updateCamera(dt);
  }

  private updatePlayer(dt: number): void {
    const move = this.input.getMoveVector();
    const p = this.player;

    p.vx = move.x * p.speed;
    p.vy = move.y * p.speed;
    p.x += p.vx * dt;
    p.y += p.vy * dt;

    p.isMoving = Math.abs(move.x) > 0.01 || Math.abs(move.y) > 0.01;
    if (p.isMoving) {
      p.walkTime += dt;
      if (Math.abs(move.x) > 0.05) {
        p.facingLeft = move.x < 0;
      }
      if (this.input.getAimMode() === 'auto') {
        p.aimAngle = Math.atan2(move.y, move.x);
      }
    } else {
      p.walkTime = 0;
    }

    if (this.input.getAimMode() === 'mouse' && this.input.hasMousePosition()) {
      const mouseWorld = this.input.getMouseWorld(
        this.camera.x,
        this.camera.y,
        this.viewportWidth,
        this.viewportHeight
      );
      const dx = mouseWorld.x - p.x;
      const dy = mouseWorld.y - p.y;
      if (dx * dx + dy * dy > 1) {
        p.aimAngle = Math.atan2(dy, dx);
        if (!p.isMoving && Math.abs(dx) > 4) {
          p.facingLeft = dx < 0;
        }
      }
    }
  }

  private updateCamera(dt: number): void {
    const cam = this.camera;
    // Frame-rate independent exponential smoothing toward the player
    const alpha = 1 - Math.exp(-cam.smoothness * dt);
    cam.x += (this.player.x - cam.x) * alpha;
    cam.y += (this.player.y - cam.y) * alpha;

    if (cam.shakeTimeLeft > 0) {
      cam.shakeTimeLeft = Math.max(0, cam.shakeTimeLeft - dt);
      const decay = cam.shakeTimeLeft > 0 ? cam.shakeIntensity : 0;
      cam.shakeOffsetX = (Math.random() * 2 - 1) * decay;
      cam.shakeOffsetY = (Math.random() * 2 - 1) * decay;
      if (cam.shakeTimeLeft === 0) {
        cam.shakeIntensity = 0;
        cam.shakeOffsetX = 0;
        cam.shakeOffsetY = 0;
      }
    }
  }

  private render(): void {
    const ctx = this.ctx;
    const width = this.viewportWidth;
    const height = this.viewportHeight;
    const camX = this.camera.x + this.camera.shakeOffsetX;
    const camY = this.camera.y + this.camera.shakeOffsetY;

    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = PALETTE.groundBase;
    ctx.fillRect(0, 0, width, height);

    this.renderGround(ctx, camX, camY, width, height);
    this.renderPlayer(ctx);

    if (this.state === 'playing' && this.input.getAimMode() === 'mouse' && this.input.hasMousePosition()) {
      this.renderMouseReticle(ctx);
    }

    if (this.state === 'playing') {
      this.input.renderJoystick(ctx);
    }

    if (this.state === 'paused') {
      this.renderPauseOverlay(ctx, width, height);
    }
  }

  private renderGround(
    ctx: CanvasRenderingContext2D,
    camX: number,
    camY: number,
    width: number,
    height: number
  ): void {
    const startTx = Math.floor((camX - width / 2) / TILE_PX) - 1;
    const endTx = Math.ceil((camX + width / 2) / TILE_PX) + 1;
    const startTy = Math.floor((camY - height / 2) / TILE_PX) - 1;
    const endTy = Math.ceil((camY + height / 2) / TILE_PX) + 1;

    for (let ty = startTy; ty <= endTy; ty++) {
      for (let tx = startTx; tx <= endTx; tx++) {
        const sx = Math.round(tx * TILE_PX - camX + width / 2);
        const sy = Math.round(ty * TILE_PX - camY + height / 2);
        ctx.drawImage(this.sprites.ground.tile, sx, sy, TILE_PX, TILE_PX);

        const h = tileHash(tx, ty);
        if (h < 18) {
          const decor = this.sprites.ground[DECOR_KEYS[h % DECOR_KEYS.length]];
          ctx.drawImage(decor, sx, sy, TILE_PX, TILE_PX);
        }
      }
    }
  }

  private renderPlayer(ctx: CanvasRenderingContext2D): void {
    const p = this.player;
    const screen = this.worldToScreen(p.x, p.y);
    const walkFrame = p.isMoving ? Math.floor(p.walkTime * 7) % 2 : 0;
    const bobOffset = p.isMoving && walkFrame === 1 ? -2 : 0;

    // Ground contact shadow
    ctx.fillStyle = PALETTE.shadow;
    ctx.beginPath();
    ctx.ellipse(screen.x, screen.y + 20, 14, 6, 0, 0, Math.PI * 2);
    ctx.fill();

    // 16x16 Hero sprite
    drawPixelSprite(
      ctx,
      this.sprites.heroes[p.heroId][walkFrame],
      screen.x,
      screen.y + bobOffset,
      PIXEL_SCALE,
      p.facingLeft
    );

    // Compact pastel HP bar directly beneath hero
    const barW = 40;
    const barH = 6;
    const bx = Math.round(screen.x - barW / 2);
    const by = Math.round(screen.y + 28);
    const hpRatio = Math.max(0, Math.min(1, p.hp / p.maxHp));

    ctx.fillStyle = PALETTE.outline;
    ctx.fillRect(bx - 1, by - 1, barW + 2, barH + 2);
    ctx.fillStyle = PALETTE.creamDark;
    ctx.fillRect(bx, by, barW, barH);
    ctx.fillStyle = hpRatio > 0.35 ? PALETTE.mintDark : PALETTE.coral;
    ctx.fillRect(bx, by, Math.round(barW * hpRatio), barH);
  }

  private renderMouseReticle(ctx: CanvasRenderingContext2D): void {
    const { x, y } = this.input.getMouseScreen();
    ctx.save();
    ctx.strokeStyle = PALETTE.outline;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = PALETTE.lavender;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x - 12, y);
    ctx.lineTo(x - 5, y);
    ctx.moveTo(x + 5, y);
    ctx.lineTo(x + 12, y);
    ctx.moveTo(x, y - 12);
    ctx.lineTo(x, y - 5);
    ctx.moveTo(x, y + 5);
    ctx.lineTo(x, y + 12);
    ctx.stroke();
    ctx.restore();
  }

  private renderPauseOverlay(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number
  ): void {
    ctx.save();
    ctx.fillStyle = 'rgba(58, 50, 69, 0.28)';
    ctx.fillRect(0, 0, width, height);

    const boxW = 240;
    const boxH = 84;
    const bx = Math.round(width / 2 - boxW / 2);
    const by = Math.round(height / 2 - boxH / 2);

    ctx.fillStyle = PALETTE.cream;
    ctx.fillRect(bx, by, boxW, boxH);
    ctx.lineWidth = 3;
    ctx.strokeStyle = PALETTE.outline;
    ctx.strokeRect(bx, by, boxW, boxH);

    ctx.fillStyle = PALETTE.outline;
    ctx.font = 'bold 20px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('PAUSED', width / 2, by + 32);

    ctx.font = '12px ui-monospace, monospace';
    ctx.fillStyle = PALETTE.slateDark;
    ctx.fillText('Press ESC or P to resume', width / 2, by + 58);
    ctx.restore();
  }
}
