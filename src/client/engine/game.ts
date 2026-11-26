import { ARTIFACTS } from '@shared/data/artifacts';
import { BOSSES } from '@shared/data/enemies';
import { PALETTE } from '@shared/data/palette';
import { SYNERGIES } from '@shared/data/synergies';
import type {
  AbilityId,
  ArtifactDef,
  ArtifactId,
  BossId,
  GroundSpriteId,
  HeroId,
  SynergyDef,
  SynergyId,
} from '@shared/data/types';
import type { SimEvent } from '@shared/sim/events';
import { tileHash } from '@shared/sim/math';
import {
  DEFAULT_LOCAL_PLAYER_ID,
  GameSimulation,
} from '@shared/sim/simulation';
import type {
  ActiveAbilitySlot,
  BossActiveInfo,
  ComputedPlayerStats,
  EnemyEntity,
  GameState,
  GlobalPassiveEntry,
  LevelUpChoice,
  ParticleBurstOptions,
  PlayerInput,
  PlayerState,
  RunStatsSnapshot,
} from '@shared/sim/types';
import {
  drawPixelSprite,
  initSprites,
  type SpriteAtlas,
} from '../art/sprites';
import { AudioManager } from './audio';
import { InputManager } from './input';
import { AbilityRenderer } from './renderer/abilityRenderer';
import { BossRenderer } from './renderer/bossRenderer';
import { recordRunResult, type AimMode } from './storage';

export type {
  BossActiveInfo,
  GameState,
  LevelUpChoice,
  PlayerState,
  RunStatsSnapshot,
};

export interface CameraState {
  x: number;
  y: number;
  smoothness: number;
  shakeIntensity: number;
  shakeTimeLeft: number;
  shakeOffsetX: number;
  shakeOffsetY: number;
}

export interface FloatingNumber {
  x: number;
  y: number;
  vx: number;
  vy: number;
  text: string;
  color: string;
  isCrit: boolean;
  life: number;
  maxLife: number;
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  maxRadius?: number;
  color: string;
  shape: 'square' | 'circle' | 'spark' | 'ring';
  gravity: number;
  life: number;
  maxLife: number;
}

export interface GameEngineCallbacks {
  onStateChange?: (state: GameState) => void;
  onAimModeChange?: (mode: AimMode) => void;
  onLevelUp?: (choices: LevelUpChoice[]) => void;
  onBossSpawned?: (boss: BossActiveInfo) => void;
  onBossDefeated?: (boss: BossActiveInfo) => void;
  onBossChestCollected?: (choices: ArtifactDef[]) => void;
  onGameOver?: (summary: RunStatsSnapshot) => void;
}

const MAX_DT = 0.05;
const PIXEL_SCALE = 3;
const TILE_PX = 16 * PIXEL_SCALE;
const CAMERA_SMOOTHNESS = 8.5;
const MAX_PARTICLES = 450;
const MAX_FLOATING_NUMBERS = 140;

const DECOR_KEYS: readonly GroundSpriteId[] = [
  'flower_pink',
  'flower_blue',
  'flower_yellow',
  'clover',
  'pebble',
  'tuft',
];

/**
 * Client-side GameEngine wrapping the headless `GameSimulation`.
 * Owns Canvas 2D rendering, procedural sprite atlas, Web Audio SFX, input capture,
 * smooth camera tracking, and client-only VFX (particles, floating damage numbers,
 * screen shake, boss alert banner) driven by `SimEvent`s from the simulation.
 */
export class GameEngine {
  public readonly canvas: HTMLCanvasElement;
  public readonly ctx: CanvasRenderingContext2D;
  public readonly sprites: SpriteAtlas;
  public readonly audio: AudioManager;
  public readonly input: InputManager;
  public readonly sim: GameSimulation;
  public readonly camera: CameraState;

  public floatingNumbers: FloatingNumber[] = [];
  public particles: Particle[] = [];

  private readonly abilityRenderer = new AbilityRenderer();
  private readonly bossRenderer = new BossRenderer();
  private readonly callbacks: GameEngineCallbacks;

  private viewportWidth = 0;
  private viewportHeight = 0;
  private rafId: number | null = null;
  private lastTimestamp = 0;
  private lastReportedState: GameState = 'menu';

  // Boss spawn alert banner (client visual state)
  private bossAlertTimer = 0;
  private bossAlertTitle = '';
  private bossAlertSubtitle = '';
  private bossAlertColor: string = PALETTE.coral;

  // Reusable solo input map to avoid per-frame allocations
  private readonly localInputMap = new Map<string, PlayerInput>();

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
    this.sim = new GameSimulation();

    this.input = new InputManager(canvas, {
      onPauseToggle: () => this.togglePause(),
      onAimModeToggle: (mode) => {
        this.audio.playClick();
        this.callbacks.onAimModeChange?.(mode);
      },
      onUserGesture: () => this.audio.unlock(),
    });

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

  // ==========================================================================
  // PUBLIC ACCESSORS (PRESERVED FOR UIManager & SOLO OFFLINE COMPATIBILITY)
  // ==========================================================================

  public get player(): PlayerState {
    return this.sim.getPrimaryPlayer();
  }

  public get enemies(): EnemyEntity[] {
    return this.sim.enemies;
  }

  public getState(): GameState {
    return this.sim.getState();
  }

  public getElapsedRunSec(): number {
    return this.sim.getElapsedRunSec();
  }

  public getKills(): number {
    return this.sim.getKills();
  }

  public getBossesDefeated(): number {
    return this.sim.getBossesDefeated();
  }

  public getViewportSize(): { width: number; height: number } {
    return { width: this.viewportWidth, height: this.viewportHeight };
  }

  public getActiveSlots(): readonly ActiveAbilitySlot[] {
    return this.player.activeSlots;
  }

  public getConsumedAbilities(): ReadonlySet<AbilityId> {
    return this.player.consumedAbilities;
  }

  public getOwnedSynergies(): ReadonlySet<SynergyId> {
    return this.player.ownedSynergies;
  }

  public getOwnedArtifacts(): readonly ArtifactId[] {
    return this.player.ownedArtifacts;
  }

  public getGlobalPassives(): readonly GlobalPassiveEntry[] {
    return this.player.globalPassives;
  }

  public getComputedStats(): ComputedPlayerStats {
    return this.player.computedStats;
  }

  public getPendingLevelUpChoices(): readonly LevelUpChoice[] {
    return this.player.pendingChoices;
  }

  public getPendingLevelUps(): number {
    return this.player.pendingLevelUps;
  }

  public getPendingArtifactChoices(): readonly ArtifactDef[] {
    return this.player.pendingArtifactChoices;
  }

  public getActiveBoss(): EnemyEntity | null {
    return this.sim.getActiveBoss();
  }

  public getActiveBosses(): EnemyEntity[] {
    return this.sim.getActiveBosses();
  }

  public getActiveBossInfo(): BossActiveInfo | null {
    return this.sim.getActiveBossInfo();
  }

  public getNextBossCountdownSec(): number {
    return this.sim.getNextBossCountdownSec();
  }

  public getRunStatsSnapshot(): RunStatsSnapshot {
    return this.sim.getRunStatsSnapshot();
  }

  public getAbilityLevel(abilityId: AbilityId): number {
    return this.sim.getAbilityLevel(abilityId);
  }

  public getAvailableSynergyEvolutions(): SynergyDef[] {
    return this.sim.getAvailableSynergyEvolutions();
  }

  // ==========================================================================
  // LIFECYCLE & RUN CONTROL
  // ==========================================================================

  public setState(next: GameState): void {
    const prev = this.sim.getState();
    this.sim.setState(next);
    if (next !== 'playing') {
      this.input.reset();
    }
    if (prev !== next || this.lastReportedState !== next) {
      this.lastReportedState = next;
      this.callbacks.onStateChange?.(next);
    }
  }

  public startRun(heroId: HeroId = 'mage'): void {
    this.camera.x = 0;
    this.camera.y = 0;
    this.camera.shakeIntensity = 0;
    this.camera.shakeTimeLeft = 0;
    this.camera.shakeOffsetX = 0;
    this.camera.shakeOffsetY = 0;

    this.floatingNumbers.length = 0;
    this.particles.length = 0;
    this.bossAlertTimer = 0;

    this.sim.setArenaViewport(this.viewportWidth, this.viewportHeight);
    const events = this.sim.startRun(heroId);
    this.processSimEvents(events);
    this.syncStateCallback();
  }

  public pause(): void {
    if (this.sim.getState() === 'playing') {
      this.setState('paused');
    }
  }

  public resume(): void {
    const events = this.sim.resume();
    if (this.sim.getState() === 'playing') {
      this.lastTimestamp = performance.now();
    }
    this.processSimEvents(events);
    this.syncStateCallback();
  }

  public togglePause(): void {
    const st = this.sim.getState();
    if (st === 'playing') {
      this.audio.playClick();
      this.pause();
    } else if (st === 'paused') {
      this.audio.playClick();
      this.resume();
    }
  }

  public applyLevelUpChoice(choice: LevelUpChoice): void {
    const events = this.sim.applyLevelUpChoice(choice);
    if (this.sim.getState() === 'playing') {
      this.lastTimestamp = performance.now();
    }
    this.processSimEvents(events);
    this.syncStateCallback();
  }

  public grantArtifact(artifactId: ArtifactId): void {
    const events = this.sim.grantArtifact(artifactId);
    if (this.sim.getState() === 'playing') {
      this.lastTimestamp = performance.now();
    }
    this.processSimEvents(events);
    this.syncStateCallback();
  }

  public grantLevels(levels = 1): void {
    const events = this.sim.grantLevels(levels);
    this.processSimEvents(events);
    this.syncStateCallback();
  }

  public spawnBoss(bossId?: BossId, encounterIndexOverride?: number): EnemyEntity {
    const boss = this.sim.spawnBoss(bossId, encounterIndexOverride);
    this.processSimEvents(this.sim.drainEvents());
    return boss;
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

  // ==========================================================================
  // SIMULATION EVENT CONSUMER (VFX, AUDIO, CAMERA SHAKE, UI CALLBACKS)
  // ==========================================================================

  private syncStateCallback(): void {
    const current = this.sim.getState();
    if (current !== this.lastReportedState) {
      this.lastReportedState = current;
      if (current !== 'playing') {
        this.input.reset();
      }
      this.callbacks.onStateChange?.(current);
    }
  }

  private processSimEvents(events: readonly SimEvent[]): void {
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      switch (ev.type) {
        case 'AbilityFired':
          // Available for future per-ability cast SFX / co-op cast indicators
          break;

        case 'DamageDealt': {
          this.spawnFloatingText(
            ev.x + (Math.random() - 0.5) * 14,
            ev.y - ev.radius - 4,
            ev.shattered ? `${ev.amount}!` : `${ev.amount}`,
            ev.shattered ? PALETTE.babyBlueLight : ev.isCrit ? PALETTE.butter : PALETTE.cream,
            ev.isCrit || ev.shattered
          );
          this.spawnParticles(ev.x, ev.y, ev.color, ev.isCrit || ev.shattered ? 7 : 4, {
            speedMin: 35,
            speedMax: 120,
            sizeMin: 3,
            sizeMax: 5,
          });
          if (!ev.silent) {
            this.audio.playHit(ev.isCrit);
          }
          break;
        }

        case 'EnemyKilled': {
          if (ev.isBoss) {
            this.spawnRingParticle(ev.x, ev.y, ev.accentColor, 165, 0.55);
            this.spawnRingParticle(ev.x, ev.y, PALETTE.butter, 115, 0.45);
            this.spawnParticles(ev.x, ev.y, ev.accentColor, 30, {
              speedMin: 60,
              speedMax: 250,
              sizeMin: 4,
              sizeMax: 8,
            });
            this.spawnParticles(ev.x, ev.y, PALETTE.butter, 16, {
              speedMin: 50,
              speedMax: 190,
              sizeMin: 3,
              sizeMax: 6,
            });
            this.spawnFloatingText(
              ev.x,
              ev.y - ev.radius - 16,
              'BOSS DEFEATED!',
              PALETTE.butter,
              true
            );
            this.addScreenShake(8.0, 0.4);
            this.audio.playPickup();
          } else {
            this.spawnParticles(ev.x, ev.y, ev.accentColor, 10, {
              speedMin: 50,
              speedMax: 145,
              sizeMin: 4,
              sizeMax: 7,
            });
          }
          break;
        }

        case 'PlayerDamaged': {
          this.audio.playPlayerHit();
          this.addScreenShake(5.5, 0.18);
          this.spawnFloatingText(ev.x, ev.y - 24, `-${ev.amount}`, PALETTE.coral, true);
          this.spawnParticles(ev.x, ev.y, PALETTE.coral, 10, {
            speedMin: 55,
            speedMax: 150,
          });
          break;
        }

        case 'PlayerHealed': {
          this.spawnFloatingText(ev.x, ev.y - 24, `+${ev.amount}`, PALETTE.mint, false);
          this.spawnParticles(ev.x, ev.y, PALETTE.mintLight, 6, {
            speedMin: 30,
            speedMax: 85,
          });
          break;
        }

        case 'PickupCollected': {
          if (ev.xpTier) {
            this.audio.playXp(ev.xpTier);
            this.spawnParticles(ev.x, ev.y, PALETTE.mintLight, 4, {
              speedMin: 25,
              speedMax: 75,
              sizeMin: 2,
              sizeMax: 4,
            });
          } else if (ev.kind === 'heart') {
            this.audio.playPickup();
            this.spawnParticles(ev.x, ev.y, PALETTE.rose, 12, {
              speedMin: 40,
              speedMax: 130,
            });
          } else if (ev.kind === 'magnet') {
            this.audio.playPickup();
            this.spawnRingParticle(ev.x, ev.y, PALETTE.periwinkle, 160, 0.45);
            this.spawnFloatingText(ev.x, ev.y - 28, 'MAGNET!', PALETTE.periwinkle, true);
          }
          break;
        }

        case 'LevelUpTriggered': {
          this.audio.playLevelUp();
          this.spawnRingParticle(ev.x, ev.y, PALETTE.butter, 96, 0.42);
          this.spawnParticles(ev.x, ev.y, PALETTE.butter, 18, {
            speedMin: 70,
            speedMax: 190,
          });
          this.spawnFloatingText(ev.x, ev.y - 30, `LEVEL ${ev.newLevel}!`, PALETTE.butter, true);
          if (ev.choices.length > 0 && this.callbacks.onLevelUp) {
            this.syncStateCallback();
            this.callbacks.onLevelUp(ev.choices);
          }
          break;
        }

        case 'SynergyEvolved': {
          this.audio.playSynergy();
          this.spawnRingParticle(ev.x, ev.y, ev.color, 130, 0.5);
          this.spawnParticles(ev.x, ev.y, ev.color, 26, {
            speedMin: 80,
            speedMax: 240,
          });
          this.spawnFloatingText(ev.x, ev.y - 34, `${ev.name.toUpperCase()}!`, ev.color, true);
          break;
        }

        case 'ArtifactGranted': {
          if (ev.fullHeal) {
            this.spawnFloatingText(ev.x, ev.y - 26, 'FULL HEAL!', PALETTE.mint, true);
          }
          this.audio.playSynergy();
          this.spawnRingParticle(ev.x, ev.y, ev.color, 110, 0.45);
          this.spawnParticles(ev.x, ev.y, ev.color, 22, {
            speedMin: 70,
            speedMax: 210,
          });
          break;
        }

        case 'BossSpawned': {
          this.audio.playBossAlert();
          this.addScreenShake(5.5, 0.32);
          this.spawnRingParticle(ev.x, ev.y, ev.boss.accentColor, 145, 0.55);
          this.spawnParticles(ev.x, ev.y, ev.boss.accentColor, 26, {
            speedMin: 75,
            speedMax: 220,
            sizeMin: 4,
            sizeMax: 8,
          });

          this.bossAlertTimer = 3.2;
          this.bossAlertTitle = ev.boss.name.toUpperCase();
          this.bossAlertSubtitle = ev.boss.title;
          this.bossAlertColor = ev.boss.accentColor;

          this.callbacks.onBossSpawned?.(ev.boss);
          break;
        }

        case 'BossDefeated': {
          this.callbacks.onBossDefeated?.(ev.boss);
          break;
        }

        case 'BossTelegraph':
          // Ground telegraph visuals are rendered directly from BossRuntime state
          break;

        case 'ChestSpawned':
          // Chest drop is rendered in renderPickups & offscreen indicators
          break;

        case 'BossChestOpened': {
          this.spawnRingParticle(ev.x, ev.y, PALETTE.butter, 130, 0.5);
          this.spawnParticles(ev.x, ev.y, PALETTE.butter, 22, {
            speedMin: 60,
            speedMax: 200,
          });
          this.spawnFloatingText(ev.x, ev.y - 36, 'BOSS CHEST!', PALETTE.butter, true);

          if (this.callbacks.onBossChestCollected) {
            this.audio.playSynergy();
            this.syncStateCallback();
            this.callbacks.onBossChestCollected(ev.choices);
          } else if (ev.choices.length > 0) {
            this.grantArtifact(ev.choices[0].id);
          }
          break;
        }

        case 'VfxBurst': {
          this.spawnParticles(ev.x, ev.y, ev.color, ev.count, ev.opts);
          break;
        }

        case 'VfxRing': {
          this.spawnRingParticle(ev.x, ev.y, ev.color, ev.maxRadius, ev.duration);
          break;
        }

        case 'VfxText': {
          this.spawnFloatingText(ev.x, ev.y, ev.text, ev.color, ev.isCrit);
          break;
        }

        case 'ScreenShake': {
          this.addScreenShake(ev.intensity, ev.durationSec);
          break;
        }

        case 'PlayerDowned': {
          this.spawnRingParticle(ev.x, ev.y, PALETTE.lavenderLight, 72, 0.45);
          this.spawnFloatingText(ev.x, ev.y - 26, 'DOWNED!', PALETTE.lavender, true);
          break;
        }

        case 'PlayerRevived': {
          this.audio.playLevelUp();
          this.spawnRingParticle(ev.x, ev.y, PALETTE.mintLight, 96, 0.5);
          this.spawnParticles(ev.x, ev.y, PALETTE.mint, 16, {
            speedMin: 60,
            speedMax: 160,
          });
          this.spawnFloatingText(ev.x, ev.y - 30, 'REVIVED!', PALETTE.mint, true);
          break;
        }

        case 'EnemyTaunted':
        case 'UpgradeChoicesQueued':
        case 'UpgradePicked':
          break;

        case 'GameOverTriggered': {
          const { newBests } = recordRunResult(this.player.heroId, {
            timeSec: ev.snapshot.elapsedRunSec,
            level: ev.snapshot.level,
            kills: ev.snapshot.kills,
            bosses: ev.snapshot.bossesDefeated,
          });
          const summary: RunStatsSnapshot = {
            ...ev.snapshot,
            newBests,
          };
          this.syncStateCallback();
          this.callbacks.onGameOver?.(summary);
          break;
        }
      }
    }
  }

  // ==========================================================================
  // CLIENT VFX HELPERS (PARTICLES & FLOATING NUMBERS)
  // ==========================================================================

  public spawnParticles(
    x: number,
    y: number,
    color: string,
    count: number,
    opts: ParticleBurstOptions = {}
  ): void {
    const speedMin = opts.speedMin ?? 45;
    const speedMax = opts.speedMax ?? 145;
    const sizeMin = opts.sizeMin ?? 3;
    const sizeMax = opts.sizeMax ?? 6;
    const lifeMin = opts.lifeMin ?? 0.22;
    const lifeMax = opts.lifeMax ?? 0.48;
    const shape = opts.shape ?? 'square';
    const gravity = opts.gravity ?? 0;

    for (let i = 0; i < count; i++) {
      if (this.particles.length >= MAX_PARTICLES) {
        this.particles.shift();
      }
      const angle = Math.random() * Math.PI * 2;
      const spd = speedMin + Math.random() * (speedMax - speedMin);
      const life = lifeMin + Math.random() * (lifeMax - lifeMin);
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * spd,
        vy: Math.sin(angle) * spd,
        size: sizeMin + Math.random() * (sizeMax - sizeMin),
        color,
        shape,
        gravity,
        life,
        maxLife: life,
      });
    }
  }

  public spawnRingParticle(
    x: number,
    y: number,
    color: string,
    maxRadius: number,
    duration = 0.3
  ): void {
    if (this.particles.length >= MAX_PARTICLES) {
      this.particles.shift();
    }
    this.particles.push({
      x,
      y,
      vx: 0,
      vy: 0,
      size: 6,
      maxRadius,
      color,
      shape: 'ring',
      gravity: 0,
      life: duration,
      maxLife: duration,
    });
  }

  public spawnFloatingText(
    x: number,
    y: number,
    text: string,
    color: string,
    isCrit = false
  ): void {
    if (this.floatingNumbers.length >= MAX_FLOATING_NUMBERS) {
      this.floatingNumbers.shift();
    }
    const maxLife = isCrit ? 0.78 : 0.62;
    this.floatingNumbers.push({
      x,
      y,
      vx: (Math.random() - 0.5) * 26,
      vy: isCrit ? -66 : -48,
      text,
      color,
      isCrit,
      life: maxLife,
      maxLife,
    });
  }

  // ==========================================================================
  // CORE LOOP & CLIENT UPDATE SUBSYSTEMS
  // ==========================================================================

  private readonly handleResize = (): void => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.viewportWidth = window.innerWidth;
    this.viewportHeight = window.innerHeight;
    this.canvas.width = Math.floor(this.viewportWidth * dpr);
    this.canvas.height = Math.floor(this.viewportHeight * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
    this.sim.setArenaViewport(this.viewportWidth, this.viewportHeight);
  };

  private readonly loop = (now: number): void => {
    const rawDt = (now - this.lastTimestamp) / 1000;
    this.lastTimestamp = now;
    const dt = Math.min(Math.max(rawDt, 0), MAX_DT);

    const state = this.sim.getState();
    if (state === 'playing') {
      this.update(dt);
    } else if (state === 'menu') {
      this.camera.x += dt * 16;
      this.camera.y += dt * 8;
    }

    this.render();
    this.rafId = requestAnimationFrame(this.loop);
  };

  private buildLocalPlayerInput(): PlayerInput {
    const move = this.input.getMoveVector();
    const aimMode = this.input.getAimMode();
    const hasAimTarget = aimMode === 'mouse' && this.input.hasMousePosition();
    let aimTargetX: number | undefined;
    let aimTargetY: number | undefined;
    if (hasAimTarget) {
      const mouseWorld = this.input.getMouseWorld(
        this.camera.x,
        this.camera.y,
        this.viewportWidth,
        this.viewportHeight
      );
      aimTargetX = mouseWorld.x;
      aimTargetY = mouseWorld.y;
    }

    return {
      moveX: move.x,
      moveY: move.y,
      aimMode,
      hasAimTarget,
      aimTargetX,
      aimTargetY,
    };
  }

  private update(dt: number): void {
    if (this.bossAlertTimer > 0) {
      this.bossAlertTimer = Math.max(0, this.bossAlertTimer - dt);
    }

    this.localInputMap.set(DEFAULT_LOCAL_PLAYER_ID, this.buildLocalPlayerInput());
    const events = this.sim.step(dt, this.localInputMap);
    this.processSimEvents(events);
    this.syncStateCallback();

    this.updateParticles(dt);
    this.updateFloatingNumbers(dt);
    this.updateCamera(dt);
  }

  private updateParticles(dt: number): void {
    const drag = Math.exp(-4.5 * dt);
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const pt = this.particles[i];
      pt.life -= dt;
      if (pt.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      if (pt.shape === 'ring' && pt.maxRadius !== undefined) {
        const progress = 1 - pt.life / pt.maxLife;
        pt.size = pt.maxRadius * (1 - (1 - progress) * (1 - progress));
      } else {
        pt.vy += pt.gravity * dt;
        pt.x += pt.vx * dt;
        pt.y += pt.vy * dt;
        pt.vx *= drag;
        pt.vy *= drag;
      }
    }
  }

  private updateFloatingNumbers(dt: number): void {
    for (let i = this.floatingNumbers.length - 1; i >= 0; i--) {
      const fn = this.floatingNumbers[i];
      fn.life -= dt;
      if (fn.life <= 0) {
        this.floatingNumbers.splice(i, 1);
        continue;
      }
      fn.x += fn.vx * dt;
      fn.y += fn.vy * dt;
      fn.vy *= Math.exp(-2.8 * dt);
    }
  }

  private updateCamera(dt: number): void {
    const cam = this.camera;
    const p = this.player;
    const alpha = 1 - Math.exp(-cam.smoothness * dt);
    cam.x += (p.x - cam.x) * alpha;
    cam.y += (p.y - cam.y) * alpha;

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

  // ==========================================================================
  // RENDERING PIPELINE
  // ==========================================================================

  private render(): void {
    const ctx = this.ctx;
    const width = this.viewportWidth;
    const height = this.viewportHeight;
    const camX = this.camera.x + this.camera.shakeOffsetX;
    const camY = this.camera.y + this.camera.shakeOffsetY;
    const toScreen = (wx: number, wy: number) => this.worldToScreen(wx, wy);

    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = PALETTE.groundBase;
    ctx.fillRect(0, 0, width, height);

    // 1. Tiled pastel ground
    this.renderGround(ctx, camX, camY, width, height);

    const state = this.sim.getState();
    if (state === 'menu') {
      return;
    }

    // 2. Ground-level combat effects & boss telegraphs (under entities so heroes stay clear)
    for (const runner of this.sim.abilityRunners.values()) {
      this.abilityRenderer.renderGroundLayer(
        runner.getRenderState(),
        ctx,
        toScreen,
        this.sprites
      );
    }
    this.bossRenderer.renderGroundTelegraphs(
      ctx,
      this.sim.enemies,
      (id) => this.sim.bossAI.getRuntime(id),
      toScreen
    );

    // 3. Pickups (XP gems, Pastel Hearts, Magnet Orbs, Boss Chests)
    this.renderPickups(ctx);

    // 4. Enemies & Bosses
    this.renderEnemies(ctx);

    // 5. All active Players (1 in Solo Offline, up to 4 in Co-op)
    for (const p of this.sim.players.values()) {
      if (p.alive) {
        this.renderPlayer(ctx, p);
      }
    }

    // 6. Foreground combat visuals & ignited boss beams
    for (const p of this.sim.players.values()) {
      const runner = this.sim.abilityRunners.get(p.id);
      if (!runner) continue;
      this.abilityRenderer.renderForegroundLayer(
        runner.getRenderState(),
        ctx,
        p.x,
        p.y,
        toScreen,
        this.sprites
      );
    }
    this.bossRenderer.renderForegroundEffects(
      ctx,
      this.sim.enemies,
      (id) => this.sim.bossAI.getRuntime(id),
      toScreen
    );

    // 7. Enemy & Boss projectiles
    this.renderEnemyProjectiles(ctx);

    // 8. Pastel particle bursts
    this.renderParticles(ctx);

    // 9. Floating damage numbers
    this.renderFloatingNumbers(ctx);

    // 10. Offscreen Boss / Boss Chest directional pointers & Boss arrival banner
    this.renderOffscreenIndicators(ctx, width, height);
    if (this.bossAlertTimer > 0) {
      this.renderBossAlertBanner(ctx, width);
    }

    // 11. Aim reticle & floating joystick
    if (state === 'playing' && this.input.getAimMode() === 'mouse' && this.input.hasMousePosition()) {
      this.renderMouseReticle(ctx);
    }

    if (state === 'playing') {
      this.input.renderJoystick(ctx);
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

  private renderPickups(ctx: CanvasRenderingContext2D): void {
    const pad = 44;
    const pickups = this.sim.pickups;
    for (let i = 0; i < pickups.length; i++) {
      const item = pickups[i];
      const screen = this.worldToScreen(item.x, item.y);
      if (
        screen.x < -pad ||
        screen.x > this.viewportWidth + pad ||
        screen.y < -pad ||
        screen.y > this.viewportHeight + pad
      ) {
        continue;
      }

      const bob = Math.sin(item.age * 5.2 + i) * 2.5;
      const scale = item.kind === 'chest' ? 2.6 : item.kind === 'xp_large' ? 2.0 : 1.75;

      if (item.kind === 'chest' || item.kind === 'heart' || item.kind === 'magnet') {
        const pulse = 0.5 + 0.5 * Math.sin(item.age * 6.0);
        const glowColor =
          item.kind === 'chest'
            ? PALETTE.butter
            : item.kind === 'heart'
            ? PALETTE.rose
            : PALETTE.periwinkle;
        const glowR = item.kind === 'chest' ? 24 + pulse * 6 : 14 + pulse * 3;
        ctx.save();
        ctx.globalAlpha = item.kind === 'chest' ? 0.34 + pulse * 0.16 : 0.24 + pulse * 0.12;
        ctx.fillStyle = glowColor;
        ctx.beginPath();
        ctx.arc(screen.x, screen.y + 2, glowR, 0, Math.PI * 2);
        ctx.fill();
        if (item.kind === 'chest') {
          ctx.globalAlpha = 0.75;
          ctx.strokeStyle = PALETTE.cream;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(screen.x, screen.y + 2, glowR + 2, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
      }

      ctx.fillStyle = PALETTE.shadow;
      ctx.beginPath();
      ctx.ellipse(screen.x, screen.y + 10, item.kind === 'chest' ? 15 : 7, 3.5, 0, 0, Math.PI * 2);
      ctx.fill();

      drawPixelSprite(
        ctx,
        this.sprites.pickups[item.kind],
        screen.x,
        screen.y + bob,
        scale,
        false,
        false
      );
    }
  }

  private renderEnemies(ctx: CanvasRenderingContext2D): void {
    const pad = 120;
    const enemies = this.sim.enemies;
    const elapsedRunSec = this.sim.getElapsedRunSec();

    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.alive) continue;

      const screen = this.worldToScreen(e.x, e.y);
      if (
        screen.x < -pad ||
        screen.x > this.viewportWidth + pad ||
        screen.y < -pad ||
        screen.y > this.viewportHeight + pad
      ) {
        continue;
      }

      const frame = Math.floor(e.walkTime * 6) % 2;
      const bob = frame === 1 ? -1.5 : 0;
      const scale = e.isBoss ? 3 : e.archetypeId === 'minislime' ? 2.2 : PIXEL_SCALE;
      const sprite =
        e.isBoss && e.bossId
          ? this.sprites.bosses[e.bossId][frame]
          : this.sprites.enemies[e.archetypeId][frame];

      const bossVis = e.isBoss ? this.sim.bossAI.getVisualState(e.id) : null;
      const jumpHeight = bossVis ? bossVis.jumpHeight : 0;
      const shadowScale = Math.max(0.45, 1 - jumpHeight / 220);

      ctx.fillStyle = PALETTE.shadow;
      ctx.beginPath();
      ctx.ellipse(
        screen.x,
        screen.y + e.radius + 4,
        e.radius * 0.9 * shadowScale,
        5 * shadowScale,
        0,
        0,
        Math.PI * 2
      );
      ctx.fill();

      if (bossVis && bossVis.enraged) {
        const pulse = 0.5 + 0.5 * Math.sin(elapsedRunSec * 8);
        ctx.save();
        ctx.globalAlpha = 0.28 + pulse * 0.16;
        ctx.strokeStyle = bossVis.accentColor;
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        ctx.arc(screen.x, screen.y - jumpHeight, e.radius + 10 + pulse * 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      if (!e.isBoss && e.aiState === 'windup') {
        ctx.save();
        ctx.globalAlpha = 0.7;
        ctx.strokeStyle = e.archetypeId === 'wisp' ? PALETTE.lavenderLight : PALETTE.peachLight;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, e.radius + 5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      if (bossVis && (bossVis.scaleX !== 1 || bossVis.scaleY !== 1)) {
        ctx.save();
        ctx.translate(screen.x, screen.y + bob - jumpHeight);
        ctx.scale(bossVis.scaleX, bossVis.scaleY);
        drawPixelSprite(ctx, sprite, 0, 0, scale, e.facingLeft, e.hitFlashTimer > 0);
        ctx.restore();
      } else {
        drawPixelSprite(
          ctx,
          sprite,
          screen.x,
          screen.y + bob - jumpHeight,
          scale,
          e.facingLeft,
          e.hitFlashTimer > 0
        );
      }

      if (e.isElite && !e.isBoss) {
        ctx.save();
        ctx.globalAlpha = 0.55;
        ctx.strokeStyle = PALETTE.butter;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, e.radius + 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      if (e.freezeTimer > 0) {
        ctx.save();
        ctx.fillStyle = 'rgba(168, 216, 240, 0.45)';
        ctx.strokeStyle = PALETTE.babyBlueLight;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, e.radius + 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      } else if (e.chilled || e.slowTimer > 0) {
        // Shared chilled debuff visual: translucent pastel ice tint + frost rim
        ctx.save();
        ctx.fillStyle = 'rgba(182, 226, 248, 0.32)';
        ctx.strokeStyle = PALETTE.babyBlueLight;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, e.radius + 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      } else if (e.stunTimer > 0) {
        ctx.save();
        ctx.strokeStyle = PALETTE.butter;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(screen.x, screen.y - e.radius - 6, 6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      if (e.tauntTimer > 0 && !e.isBoss) {
        ctx.save();
        ctx.strokeStyle = PALETTE.coral;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(screen.x, screen.y - e.radius - 8, 4.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      if (e.isBoss && e.bossId) {
        const bossDef = BOSSES[e.bossId];
        const bw = 78;
        const bh = 7;
        const bx = Math.round(screen.x - bw / 2);
        const by = Math.round(screen.y + e.radius + 12);
        const ratio = Math.max(0, Math.min(1, e.hp / Math.max(1, e.maxHp)));

        ctx.fillStyle = PALETTE.outline;
        ctx.fillRect(bx - 2, by - 2, bw + 4, bh + 4);
        ctx.fillStyle = PALETTE.creamDark;
        ctx.fillRect(bx, by, bw, bh);
        ctx.fillStyle = bossDef.accentColor;
        ctx.fillRect(bx, by, Math.round(bw * ratio), bh);
      } else if (!e.isBoss && e.hp < e.maxHp) {
        const bw = 26;
        const bh = 4;
        const bx = Math.round(screen.x - bw / 2);
        const by = Math.round(screen.y - e.radius - 12);
        const ratio = Math.max(0, Math.min(1, e.hp / Math.max(1, e.maxHp)));
        ctx.fillStyle = PALETTE.outline;
        ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
        ctx.fillStyle = PALETTE.creamDark;
        ctx.fillRect(bx, by, bw, bh);
        ctx.fillStyle = PALETTE.coral;
        ctx.fillRect(bx, by, Math.round(bw * ratio), bh);
      }
    }
  }

  private renderEnemyProjectiles(ctx: CanvasRenderingContext2D): void {
    const pad = 28;
    const projectiles = this.sim.enemyProjectiles;
    for (let i = 0; i < projectiles.length; i++) {
      const proj = projectiles[i];
      const screen = this.worldToScreen(proj.x, proj.y);
      if (
        screen.x < -pad ||
        screen.x > this.viewportWidth + pad ||
        screen.y < -pad ||
        screen.y > this.viewportHeight + pad
      ) {
        continue;
      }

      ctx.save();
      ctx.globalAlpha = 0.42;
      ctx.fillStyle = proj.color;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, proj.radius + 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      const scale = Math.max(1.6, (proj.radius / 7) * 1.9);
      drawPixelSprite(
        ctx,
        this.sprites.projectiles.enemy_orb,
        screen.x,
        screen.y,
        scale,
        false,
        false
      );
    }
  }

  private renderOffscreenIndicators(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number
  ): void {
    const margin = 28;

    const drawPointer = (wx: number, wy: number, color: string, label: string): void => {
      const screen = this.worldToScreen(wx, wy);
      if (
        screen.x >= margin &&
        screen.x <= width - margin &&
        screen.y >= margin &&
        screen.y <= height - margin
      ) {
        return;
      }

      const cx = width * 0.5;
      const cy = height * 0.5;
      const angle = Math.atan2(screen.y - cy, screen.x - cx);
      const halfW = cx - margin;
      const halfH = cy - margin;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const tX = Math.abs(cos) > 0.001 ? halfW / Math.abs(cos) : Number.POSITIVE_INFINITY;
      const tY = Math.abs(sin) > 0.001 ? halfH / Math.abs(sin) : Number.POSITIVE_INFINITY;
      const t = Math.min(tX, tY);
      const px = cx + cos * t;
      const py = cy + sin * t;

      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(angle);

      ctx.fillStyle = color;
      ctx.strokeStyle = PALETTE.outline;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(11, 0);
      ctx.lineTo(-8, -8);
      ctx.lineTo(-4, 0);
      ctx.lineTo(-8, 8);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      ctx.rotate(-angle);
      ctx.font = 'bold 10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.strokeStyle = PALETTE.outline;
      ctx.lineWidth = 3;
      ctx.strokeText(label, 0, -16);
      ctx.fillStyle = PALETTE.cream;
      ctx.fillText(label, 0, -16);
      ctx.restore();
    };

    const enemies = this.sim.enemies;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (e.alive && e.isBoss && e.bossId) {
        drawPointer(e.x, e.y, BOSSES[e.bossId].accentColor, 'BOSS');
      }
    }

    const pickups = this.sim.pickups;
    for (let i = 0; i < pickups.length; i++) {
      const item = pickups[i];
      if (item.kind === 'chest') {
        drawPointer(item.x, item.y, PALETTE.butter, 'CHEST');
      }
    }
  }

  private renderBossAlertBanner(ctx: CanvasRenderingContext2D, width: number): void {
    const alpha = Math.min(1, this.bossAlertTimer / 0.55);
    const bw = Math.min(340, width - 32);
    const bh = 54;
    const bx = Math.round(width / 2 - bw / 2);
    const by = 72;

    ctx.save();
    ctx.globalAlpha = alpha * 0.94;
    ctx.fillStyle = PALETTE.cream;
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = this.bossAlertColor;
    ctx.fillRect(bx, by, bw, 6);
    ctx.strokeStyle = PALETTE.outline;
    ctx.lineWidth = 3;
    ctx.strokeRect(bx, by, bw, bh);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = PALETTE.outline;
    ctx.font = 'bold 16px ui-monospace, monospace';
    ctx.fillText(`BOSS: ${this.bossAlertTitle}`, width / 2, by + 24);
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillStyle = PALETTE.slateDark;
    ctx.fillText(this.bossAlertSubtitle, width / 2, by + 42);
    ctx.restore();
  }

  private renderPlayer(ctx: CanvasRenderingContext2D, p: PlayerState): void {
    const screen = this.worldToScreen(p.x, p.y);
    const walkFrame = p.isMoving ? Math.floor(p.walkTime * 7) % 2 : 0;
    const bobOffset = p.isMoving && walkFrame === 1 ? -2 : 0;

    if (p.retributionBuffTimer > 0) {
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = PALETTE.coral;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, 26, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    ctx.fillStyle = PALETTE.shadow;
    ctx.beginPath();
    ctx.ellipse(screen.x, screen.y + 20, 14, 6, 0, 0, Math.PI * 2);
    ctx.fill();

    drawPixelSprite(
      ctx,
      this.sprites.heroes[p.heroId][walkFrame],
      screen.x,
      screen.y + bobOffset,
      PIXEL_SCALE,
      p.facingLeft,
      p.hitFlashTimer > 0
    );

    const barW = 40;
    const barH = 6;
    const bx = Math.round(screen.x - barW / 2);
    const by = Math.round(screen.y + 28);
    const hpRatio = Math.max(0, Math.min(1, p.hp / Math.max(1, p.maxHp)));

    ctx.fillStyle = PALETTE.outline;
    ctx.fillRect(bx - 1, by - 1, barW + 2, barH + 2);
    ctx.fillStyle = PALETTE.creamDark;
    ctx.fillRect(bx, by, barW, barH);
    ctx.fillStyle = hpRatio > 0.35 ? PALETTE.mintDark : PALETTE.coral;
    ctx.fillRect(bx, by, Math.round(barW * hpRatio), barH);
  }

  private renderParticles(ctx: CanvasRenderingContext2D): void {
    for (let i = 0; i < this.particles.length; i++) {
      const pt = this.particles[i];
      const screen = this.worldToScreen(pt.x, pt.y);
      const alpha = Math.max(0, pt.life / pt.maxLife);

      ctx.save();
      ctx.globalAlpha = alpha;
      if (pt.shape === 'ring') {
        ctx.strokeStyle = pt.color;
        ctx.lineWidth = 3 * alpha + 1;
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, pt.size, 0, Math.PI * 2);
        ctx.stroke();
      } else if (pt.shape === 'circle') {
        ctx.fillStyle = pt.color;
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, pt.size * 0.5, 0, Math.PI * 2);
        ctx.fill();
      } else {
        const s = Math.max(2, Math.round(pt.size * (0.4 + 0.6 * alpha)));
        const sx = Math.round(screen.x - s / 2);
        const sy = Math.round(screen.y - s / 2);
        ctx.fillStyle = PALETTE.outline;
        ctx.fillRect(sx - 1, sy - 1, s + 2, s + 2);
        ctx.fillStyle = pt.color;
        ctx.fillRect(sx, sy, s, s);
      }
      ctx.restore();
    }
  }

  private renderFloatingNumbers(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let i = 0; i < this.floatingNumbers.length; i++) {
      const fn = this.floatingNumbers[i];
      const screen = this.worldToScreen(fn.x, fn.y);
      const ratio = Math.max(0, fn.life / fn.maxLife);
      const alpha = Math.min(1, ratio * 1.6);
      const size = fn.isCrit ? 16 : 13;

      ctx.globalAlpha = alpha;
      ctx.font = `bold ${size}px ui-monospace, monospace`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = PALETTE.outline;
      ctx.strokeText(fn.text, Math.round(screen.x), Math.round(screen.y));
      ctx.fillStyle = fn.color;
      ctx.fillText(fn.text, Math.round(screen.x), Math.round(screen.y));
    }

    ctx.restore();
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
}

export { ARTIFACTS, SYNERGIES };
