import { ABILITIES } from '@shared/data/abilities';
import { ARTIFACTS, getArtifactDef } from '@shared/data/artifacts';
import { CLASSES } from '@shared/data/classes';
import { BOSSES, ENEMIES, xpNeeded } from '@shared/data/enemies';
import { PALETTE } from '@shared/data/palette';
import { SYNERGIES } from '@shared/data/synergies';
import type {
  AbilityId,
  ArtifactDef,
  ArtifactId,
  BossId,
  EnemySpriteId,
  GroundSpriteId,
  HeroId,
  SynergyDef,
  SynergyId,
} from '@shared/data/types';
import {
  WireEnemyFlag,
  WirePlayerFlag,
  type BinaryCombatEvent,
  type MatchSummaryPlayer,
  type RoomStatePayload,
  type ServerControlMessage,
  type WireBossState,
  type WireEnemyTypeName,
  type WireSnapshot,
} from '@shared/protocol';
import type { SimEvent } from '@shared/sim/events';
import { tileHash } from '@shared/sim/math';
import {
  buildComputedStats,
  ENDLESS_MASTERY_CARDS,
} from '@shared/sim/progression';
import {
  DEFAULT_LOCAL_PLAYER_ID,
  GameSimulation,
  REVIVE_CIRCLE_RADIUS,
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
  PendingChoiceSource,
  PlayerInput,
  PlayerState,
  RoomPaceMode,
  RunStatsSnapshot,
  UpgradeChoiceIndex,
} from '@shared/sim/types';
import {
  drawPixelSprite,
  initSprites,
  type SpriteAtlas,
} from '../art/sprites';
import {
  NetClient,
  type InterpolatedPlayer,
  type InterpolatedWorldState,
  type NetConnectionState,
} from '../netClient';
import { AudioManager } from './audio';
import { CoopVfxSystem } from './coopVfx';
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

export type SessionMode = 'solo' | 'coop';

export interface CoopUpgradeState {
  batchId: number;
  source: PendingChoiceSource;
  choices: LevelUpChoice[];
  pendingQueueCount: number;
  pickInFlight: boolean;
}

export interface CoopMatchEndSummary {
  victory: boolean;
  elapsedRunSec: number;
  kills: number;
  bossesDefeated: number;
  players: MatchSummaryPlayer[];
}

interface CoopLocalProgression {
  heroId: HeroId;
  activeSlots: ActiveAbilitySlot[];
  consumedAbilities: Set<AbilityId>;
  ownedSynergies: Set<SynergyId>;
  ownedArtifacts: ArtifactId[];
  globalPassives: GlobalPassiveEntry[];
  computedStats: ComputedPlayerStats;
  masteryCount: number;
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

  // Online Co-op callbacks
  onCoopConnectionChange?: (state: NetConnectionState) => void;
  onCoopRoomState?: (roomState: RoomStatePayload) => void;
  onCoopUpgradeChoices?: (upgrade: CoopUpgradeState | null) => void;
  onCoopPauseToggle?: (open: boolean) => void;
  onCoopMatchEnd?: (summary: CoopMatchEndSummary) => void;
  onCoopError?: (code: string, message: string) => void;
  onCoopReconnectFailed?: (reason: string) => void;
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

function isBossWireType(type: WireEnemyTypeName): type is BossId {
  return type === 'king_mochi' || type === 'lady_wisteria' || type === 'aegis';
}

function getEnemyAccentColor(type: WireEnemyTypeName): string {
  if (isBossWireType(type)) return BOSSES[type].accentColor;
  if (type === 'golem') return PALETTE.babyBlue;
  if (type === 'wisp') return PALETTE.lavender;
  if (type === 'minislime') return PALETTE.rose;
  return PALETTE.coral;
}

function createInitialCoopProgression(heroId: HeroId): CoopLocalProgression {
  const cls = CLASSES[heroId];
  const prog: CoopLocalProgression = {
    heroId,
    activeSlots: [
      {
        kind: 'ability',
        id: cls.startingAbilityId,
        level: 1,
        cooldownTimer: 0,
      },
    ],
    consumedAbilities: new Set<AbilityId>(),
    ownedSynergies: new Set<SynergyId>(),
    ownedArtifacts: [],
    globalPassives: [],
    computedStats: buildComputedStats({
      heroId,
      globalPassives: [],
      ownedArtifacts: [],
      retributionBuffTimer: 0,
    }),
    masteryCount: 0,
  };
  return prog;
}

/**
 * Client-side GameEngine supporting:
 *  - Solo Offline mode: wraps local headless `GameSimulation` with zero network calls.
 *  - Online Co-op mode: connects via `NetClient`, streams inputs at 20-30 Hz, renders
 *    interpolated 60 FPS snapshots + client VFX with dimmed teammate attacks, live
 *    non-blocking upgrade strip, and non-pausing pause overlay.
 */
export class GameEngine {
  public readonly canvas: HTMLCanvasElement;
  public readonly ctx: CanvasRenderingContext2D;
  public readonly sprites: SpriteAtlas;
  public readonly audio: AudioManager;
  public readonly input: InputManager;
  public readonly sim: GameSimulation;
  public readonly net: NetClient;
  public readonly camera: CameraState;

  public floatingNumbers: FloatingNumber[] = [];
  public particles: Particle[] = [];

  private readonly abilityRenderer = new AbilityRenderer();
  private readonly bossRenderer = new BossRenderer();
  private readonly coopVfx = new CoopVfxSystem();
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

  // Online Co-op runtime state (untouched during Solo Offline)
  private sessionMode: SessionMode = 'solo';
  private coopState: GameState = 'menu';
  private coopPauseOpen = false;
  private coopWorld: InterpolatedWorldState | null = null;
  private coopPendingUpgrade: CoopUpgradeState | null = null;
  private coopProgression: CoopLocalProgression = createInitialCoopProgression('mage');
  private coopLastBossEnemyId = -1;
  private coopVisualTimeSec = 0;
  private coopLastAimAngle = 0;

  // Reusable boss Entity shim for reusing BossRenderer in Co-op
  private readonly coopBossShimList: EnemyEntity[] = [];

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

    this.net = new NetClient({
      onConnectionStateChange: (st) => this.callbacks.onCoopConnectionChange?.(st),
      onRoomState: (rs) => this.callbacks.onCoopRoomState?.(rs),
      onMatchStarted: (msg) => this.handleCoopMatchStarted(msg),
      onSnapshot: (snap, prev) => this.handleCoopSnapshot(snap, prev),
      onBinaryEvents: (events) => this.handleCoopBinaryEvents(events),
      onUpgradeChoices: (msg) => this.handleCoopUpgradeChoices(msg),
      onUpgradeApplied: (msg) => this.handleCoopUpgradeApplied(msg),
      onGameOver: (msg) => this.handleCoopMatchEnd(false, msg),
      onVictory: (msg) => this.handleCoopMatchEnd(true, msg),
      onReconnected: (msg) => this.handleCoopReconnected(msg),
      onError: (code, message) => this.callbacks.onCoopError?.(code, message),
      onReconnectFailed: (reason) => this.callbacks.onCoopReconnectFailed?.(reason),
    });

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
  // MODE & CO-OP SESSION ACCESSORS
  // ==========================================================================

  public getSessionMode(): SessionMode {
    return this.sessionMode;
  }

  public isCoopMode(): boolean {
    return this.sessionMode === 'coop';
  }

  public isCoopPauseOpen(): boolean {
    return this.sessionMode === 'coop' && this.coopPauseOpen;
  }

  public getCoopConnectionState(): NetConnectionState {
    return this.net.getConnectionState();
  }

  public getCoopRoomState(): RoomStatePayload | null {
    return this.net.getRoomState();
  }

  public getCoopPendingUpgrade(): CoopUpgradeState | null {
    return this.coopPendingUpgrade;
  }

  public getCoopPlayers(): readonly InterpolatedPlayer[] {
    return this.coopWorld?.players ?? [];
  }

  public getCoopLocalPlayer(): InterpolatedPlayer | null {
    if (!this.coopWorld) return null;
    const selfId = this.coopWorld.selfSlotId;
    return this.coopWorld.players.find((p) => p.id === selfId) ?? null;
  }

  public createCoopRoom(opts: {
    heroId: HeroId;
    paceMode?: RoomPaceMode;
    name?: string;
    serverUrl?: string;
  }): void {
    this.sessionMode = 'coop';
    this.coopState = 'menu';
    this.coopPauseOpen = false;
    this.net.createRoom(opts);
  }

  public joinCoopRoom(opts: {
    roomCode: string;
    heroId: HeroId;
    name?: string;
    serverUrl?: string;
  }): boolean {
    this.sessionMode = 'coop';
    this.coopState = 'menu';
    this.coopPauseOpen = false;
    return this.net.joinRoom(opts);
  }

  public leaveCoopRoom(): void {
    this.net.disconnect();
    this.coopWorld = null;
    this.coopPendingUpgrade = null;
    this.coopPauseOpen = false;
    this.coopLastBossEnemyId = -1;
    this.coopVfx.reset();
    this.floatingNumbers.length = 0;
    this.particles.length = 0;
    this.bossAlertTimer = 0;
    this.sessionMode = 'solo';
    this.coopState = 'menu';
    this.callbacks.onCoopUpgradeChoices?.(null);
    this.callbacks.onCoopPauseToggle?.(false);
    this.setState('menu');
  }

  public pickCoopUpgrade(choiceIndex: UpgradeChoiceIndex): boolean {
    if (this.sessionMode !== 'coop' || !this.coopPendingUpgrade) return false;
    if (this.coopPendingUpgrade.pickInFlight) return false;
    if (!this.coopPendingUpgrade.choices[choiceIndex]) return false;

    const sent = this.net.sendPickUpgrade(choiceIndex);
    if (sent) {
      this.coopPendingUpgrade.pickInFlight = true;
      this.audio.unlock();
      this.audio.playClick();
    }
    return sent;
  }

  // ==========================================================================
  // PUBLIC ACCESSORS (UNIFIED FOR SOLO OFFLINE & ONLINE CO-OP HUD/PAUSE)
  // ==========================================================================

  public get player(): PlayerState {
    return this.sim.getPrimaryPlayer();
  }

  public get enemies(): EnemyEntity[] {
    return this.sim.enemies;
  }

  public getState(): GameState {
    return this.sessionMode === 'coop' ? this.coopState : this.sim.getState();
  }

  public getLocalHeroId(): HeroId {
    if (this.sessionMode === 'coop') {
      const lp = this.getCoopLocalPlayer();
      return lp?.classId ?? this.coopProgression.heroId;
    }
    return this.player.heroId;
  }

  public getLocalLevel(): number {
    if (this.sessionMode === 'coop') {
      return this.getCoopLocalPlayer()?.level ?? 1;
    }
    return this.player.level;
  }

  public getLocalXp(): { xp: number; xpToNext: number } {
    if (this.sessionMode === 'coop') {
      if (this.coopWorld) {
        return {
          xp: this.coopWorld.selfXp,
          xpToNext: Math.max(1, this.coopWorld.selfXpToNext),
        };
      }
      return { xp: 0, xpToNext: xpNeeded(1) };
    }
    return { xp: this.player.xp, xpToNext: xpNeeded(this.player.level) };
  }

  public getLocalHp(): {
    hp: number;
    maxHp: number;
    hpPct: number;
    downed: boolean;
    revivePct: number;
  } {
    if (this.sessionMode === 'coop') {
      const lp = this.getCoopLocalPlayer();
      const maxHp = Math.max(1, Math.round(this.coopProgression.computedStats.maxHp));
      const hpPct = lp?.hpPct ?? 100;
      const downed = lp ? (lp.stateFlags & WirePlayerFlag.DOWNED) !== 0 : false;
      const hp = downed ? 0 : Math.round((hpPct / 100) * maxHp);
      return { hp, maxHp, hpPct, downed, revivePct: lp?.revivePct ?? 0 };
    }
    const maxHp = Math.max(1, Math.round(this.player.maxHp));
    return {
      hp: Math.max(0, Math.ceil(this.player.hp)),
      maxHp,
      hpPct: Math.round((this.player.hp / maxHp) * 100),
      downed: this.player.downed,
      revivePct: Math.round(this.player.revivePct * 100),
    };
  }

  public getLocalWalkState(): { isMoving: boolean; walkTime: number } {
    if (this.sessionMode === 'coop') {
      const lp = this.getCoopLocalPlayer();
      return { isMoving: lp?.isMoving ?? false, walkTime: lp?.walkTime ?? 0 };
    }
    return { isMoving: this.player.isMoving, walkTime: this.player.walkTime };
  }

  public getElapsedRunSec(): number {
    if (this.sessionMode === 'coop') {
      return this.coopWorld?.elapsedSec ?? 0;
    }
    return this.sim.getElapsedRunSec();
  }

  public getKills(): number {
    if (this.sessionMode === 'coop') {
      return this.coopWorld?.kills ?? 0;
    }
    return this.sim.getKills();
  }

  public getBossesDefeated(): number {
    if (this.sessionMode === 'coop') {
      return this.coopWorld?.bossesDefeated ?? 0;
    }
    return this.sim.getBossesDefeated();
  }

  public getViewportSize(): { width: number; height: number } {
    return { width: this.viewportWidth, height: this.viewportHeight };
  }

  public getActiveSlots(): readonly ActiveAbilitySlot[] {
    if (this.sessionMode === 'coop') {
      return this.coopProgression.activeSlots;
    }
    return this.player.activeSlots;
  }

  public getConsumedAbilities(): ReadonlySet<AbilityId> {
    if (this.sessionMode === 'coop') {
      return this.coopProgression.consumedAbilities;
    }
    return this.player.consumedAbilities;
  }

  public getOwnedSynergies(): ReadonlySet<SynergyId> {
    if (this.sessionMode === 'coop') {
      return this.coopProgression.ownedSynergies;
    }
    return this.player.ownedSynergies;
  }

  public getOwnedArtifacts(): readonly ArtifactId[] {
    if (this.sessionMode === 'coop') {
      return this.coopProgression.ownedArtifacts;
    }
    return this.player.ownedArtifacts;
  }

  public getGlobalPassives(): readonly GlobalPassiveEntry[] {
    if (this.sessionMode === 'coop') {
      return this.coopProgression.globalPassives;
    }
    return this.player.globalPassives;
  }

  public getComputedStats(): ComputedPlayerStats {
    if (this.sessionMode === 'coop') {
      return this.coopProgression.computedStats;
    }
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
    if (this.sessionMode === 'coop') {
      const b = this.coopWorld?.boss;
      if (!b) return null;
      const def = BOSSES[b.bossId];
      const attackSpec = b.attackId
        ? def.attacks.find((a) => a.id === b.attackId) ?? null
        : null;
      const playerCount = Math.max(1, this.coopWorld?.players.length ?? 1);
      const approxMaxHp = Math.round(
        def.baseHp * (1 + 0.85 * (playerCount - 1)) * (1 + b.cycle * 0.65)
      );
      return {
        enemyId: b.enemyId,
        bossId: b.bossId,
        name: def.name,
        title: def.title,
        hp: Math.round((b.hpPct / 100) * approxMaxHp),
        maxHp: approxMaxHp,
        accentColor: def.accentColor,
        cycle: b.cycle,
        encounterIndex: b.encounterIndex,
        enraged: b.enraged,
        state: b.phase,
        currentAttackName: attackSpec?.name ?? null,
      };
    }
    return this.sim.getActiveBossInfo();
  }

  public getNextBossCountdownSec(): number {
    if (this.sessionMode === 'coop') {
      return this.coopWorld?.nextBossSec ?? 0;
    }
    return this.sim.getNextBossCountdownSec();
  }

  public getRunStatsSnapshot(): RunStatsSnapshot {
    return this.sim.getRunStatsSnapshot();
  }

  public getAbilityLevel(abilityId: AbilityId): number {
    if (this.sessionMode === 'coop') {
      if (this.coopProgression.consumedAbilities.has(abilityId)) return 10;
      const slot = this.coopProgression.activeSlots.find(
        (s) => s.kind === 'ability' && s.id === abilityId
      );
      return slot ? slot.level : 0;
    }
    return this.sim.getAbilityLevel(abilityId);
  }

  public getAvailableSynergyEvolutions(): SynergyDef[] {
    return this.sim.getAvailableSynergyEvolutions();
  }

  // ==========================================================================
  // LIFECYCLE & RUN CONTROL (SOLO OFFLINE UNTOUCHED)
  // ==========================================================================

  public setState(next: GameState): void {
    if (this.sessionMode === 'coop') {
      const prev = this.coopState;
      this.coopState = next;
      if (next !== 'playing') {
        this.coopPauseOpen = false;
        this.input.reset();
      }
      if (prev !== next || this.lastReportedState !== next) {
        this.lastReportedState = next;
        this.callbacks.onStateChange?.(next);
      }
      return;
    }

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
    // Ensure Solo Offline never touches WebSocket / Co-op state
    if (this.sessionMode === 'coop') {
      this.net.disconnect();
      this.sessionMode = 'solo';
      this.coopWorld = null;
      this.coopPendingUpgrade = null;
      this.coopPauseOpen = false;
      this.coopVfx.reset();
      this.callbacks.onCoopUpgradeChoices?.(null);
      this.callbacks.onCoopPauseToggle?.(false);
    }

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
    if (this.sessionMode === 'coop') {
      if (this.coopState === 'playing' && !this.coopPauseOpen) {
        this.coopPauseOpen = true;
        this.callbacks.onCoopPauseToggle?.(true);
      }
      return;
    }
    if (this.sim.getState() === 'playing') {
      this.setState('paused');
    }
  }

  public resume(): void {
    if (this.sessionMode === 'coop') {
      if (this.coopPauseOpen) {
        this.coopPauseOpen = false;
        this.callbacks.onCoopPauseToggle?.(false);
      }
      return;
    }
    const events = this.sim.resume();
    if (this.sim.getState() === 'playing') {
      this.lastTimestamp = performance.now();
    }
    this.processSimEvents(events);
    this.syncStateCallback();
  }

  public togglePause(): void {
    if (this.sessionMode === 'coop') {
      if (this.coopState !== 'playing') return;
      this.audio.playClick();
      this.coopPauseOpen = !this.coopPauseOpen;
      this.callbacks.onCoopPauseToggle?.(this.coopPauseOpen);
      return;
    }

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
    this.net.disconnect();
    window.removeEventListener('resize', this.handleResize);
    this.input.destroy();
  }

  // ==========================================================================
  // CO-OP NETWORK EVENT HANDLERS
  // ==========================================================================

  private handleCoopMatchStarted(
    msg: Extract<ServerControlMessage, { type: 'MATCH_STARTED' }>
  ): void {
    this.sessionMode = 'coop';
    this.coopPauseOpen = false;
    this.coopPendingUpgrade = null;
    this.coopWorld = null;
    this.coopLastBossEnemyId = -1;
    this.coopVisualTimeSec = 0;
    this.coopVfx.reset();
    this.floatingNumbers.length = 0;
    this.particles.length = 0;
    this.bossAlertTimer = 0;

    this.camera.x = 0;
    this.camera.y = 0;
    this.camera.shakeIntensity = 0;
    this.camera.shakeTimeLeft = 0;
    this.camera.shakeOffsetX = 0;
    this.camera.shakeOffsetY = 0;

    const selfSlot = this.net.getSlotId();
    const myInfo = msg.roomState.players.find((p) => p.slotId === selfSlot);
    this.coopProgression = createInitialCoopProgression(myInfo?.heroId ?? 'mage');

    this.callbacks.onCoopUpgradeChoices?.(null);
    this.callbacks.onCoopPauseToggle?.(false);
    this.setState('playing');
  }

  private handleCoopReconnected(
    msg: Extract<ServerControlMessage, { type: 'RECONNECTED' }>
  ): void {
    if (msg.roomState.status === 'playing' && this.coopState !== 'playing') {
      this.sessionMode = 'coop';
      this.setState('playing');
    }
    if (msg.personalUpgrade) {
      this.coopPendingUpgrade = {
        batchId: msg.personalUpgrade.batchId,
        source: msg.personalUpgrade.source,
        choices: msg.personalUpgrade.choices,
        pendingQueueCount: msg.personalUpgrade.pendingQueueCount,
        pickInFlight: false,
      };
      this.callbacks.onCoopUpgradeChoices?.(this.coopPendingUpgrade);
    } else {
      this.coopPendingUpgrade = null;
      this.callbacks.onCoopUpgradeChoices?.(null);
    }
  }

  private handleCoopSnapshot(
    snap: WireSnapshot,
    prev: WireSnapshot | null
  ): void {
    const selfId = this.net.getSlotId() || snap.selfPlayerId;
    const currSelf = snap.players.find((p) => p.id === selfId);
    const prevSelf = prev?.players.find((p) => p.id === selfId);

    if (currSelf && prevSelf) {
      // Personal XP gain chime
      if (snap.selfXp > prev!.selfXp || currSelf.level > prevSelf.level) {
        this.audio.playXp(currSelf.level > prevSelf.level ? 3 : 1);
      }

      // Personal level-up burst
      if (currSelf.level > prevSelf.level) {
        this.audio.playLevelUp();
        this.spawnRingParticle(currSelf.x, currSelf.y, PALETTE.butter, 96, 0.42);
        this.spawnParticles(currSelf.x, currSelf.y, PALETTE.butter, 18, {
          speedMin: 70,
          speedMax: 190,
        });
        this.spawnFloatingText(
          currSelf.x,
          currSelf.y - 30,
          `LEVEL ${currSelf.level}!`,
          PALETTE.butter,
          true
        );
      }

      // Local player damage feedback
      if (currSelf.hpPct < prevSelf.hpPct) {
        this.audio.playPlayerHit();
        this.addScreenShake(4.8, 0.16);
        this.net.triggerPlayerHitFlash(selfId, 0.16);
        this.spawnParticles(currSelf.x, currSelf.y, PALETTE.coral, 8, {
          speedMin: 50,
          speedMax: 140,
        });
      } else if (currSelf.hpPct >= prevSelf.hpPct + 8) {
        this.audio.playPickup();
        this.spawnParticles(currSelf.x, currSelf.y, PALETTE.mintLight, 8, {
          speedMin: 35,
          speedMax: 100,
        });
      }
    }

    // Detect newly spawned Boss for alert banner + siren SFX
    if (snap.boss && snap.boss.enemyId !== this.coopLastBossEnemyId) {
      this.coopLastBossEnemyId = snap.boss.enemyId;
      const bossDef = BOSSES[snap.boss.bossId];
      const bossEnemy = snap.enemies.find((e) => e.id === snap.boss!.enemyId);
      this.audio.playBossAlert();
      this.addScreenShake(5.5, 0.32);
      if (bossEnemy) {
        this.spawnRingParticle(bossEnemy.x, bossEnemy.y, bossDef.accentColor, 145, 0.55);
        this.spawnParticles(bossEnemy.x, bossEnemy.y, bossDef.accentColor, 26, {
          speedMin: 75,
          speedMax: 220,
          sizeMin: 4,
          sizeMax: 8,
        });
      }
      this.bossAlertTimer = 3.2;
      this.bossAlertTitle = bossDef.name.toUpperCase();
      this.bossAlertSubtitle = bossDef.title;
      this.bossAlertColor = bossDef.accentColor;
    } else if (!snap.boss) {
      this.coopLastBossEnemyId = -1;
    }
  }

  private handleCoopBinaryEvents(events: readonly BinaryCombatEvent[]): void {
    const players = this.coopWorld?.players ?? [];
    const enemies = this.coopWorld?.enemies ?? [];
    const selfPlayer = this.getCoopLocalPlayer();

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      switch (ev.type) {
        case 'AbilityFired': {
          this.coopVfx.spawnFromAbilityFired(ev, players, enemies);
          if (ev.isDoubleCast) {
            this.spawnRingParticle(ev.x, ev.y, PALETTE.babyBlue, 38, 0.25);
          }
          break;
        }

        case 'DamageNumber': {
          this.net.triggerEnemyHitFlash(ev.enemyId, 0.11);
          this.spawnFloatingText(
            ev.x + (Math.random() - 0.5) * 14,
            ev.y - 16,
            ev.shattered ? `${ev.amount}!` : `${ev.amount}`,
            ev.shattered ? PALETTE.babyBlueLight : ev.isCrit ? PALETTE.butter : PALETTE.cream,
            ev.isCrit || ev.shattered
          );
          this.spawnParticles(
            ev.x,
            ev.y,
            ev.shattered ? PALETTE.babyBlueLight : PALETTE.cream,
            ev.isCrit || ev.shattered ? 6 : 3,
            {
              speedMin: 35,
              speedMax: 110,
              sizeMin: 3,
              sizeMax: 5,
            }
          );
          if (!ev.silent) {
            // Only play hit SFX for impacts near our camera so far-off teammates stay clean
            const nearCam =
              !selfPlayer ||
              Math.hypot(ev.x - selfPlayer.x, ev.y - selfPlayer.y) <= 580;
            if (nearCam) {
              this.audio.playHit(ev.isCrit);
            }
          }
          break;
        }

        case 'EnemyKilled': {
          const accent = getEnemyAccentColor(ev.enemyType);
          if (ev.isBoss) {
            this.spawnRingParticle(ev.x, ev.y, accent, 165, 0.55);
            this.spawnRingParticle(ev.x, ev.y, PALETTE.butter, 115, 0.45);
            this.spawnParticles(ev.x, ev.y, accent, 30, {
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
            this.spawnFloatingText(ev.x, ev.y - 44, 'BOSS DEFEATED!', PALETTE.butter, true);
            this.addScreenShake(8.0, 0.4);
            this.audio.playPickup();
          } else {
            this.spawnParticles(ev.x, ev.y, accent, 9, {
              speedMin: 48,
              speedMax: 140,
              sizeMin: 3,
              sizeMax: 6,
            });
          }
          break;
        }

        case 'BossTelegraph': {
          this.coopVfx.recordBossTelegraphEvent(ev);
          break;
        }

        case 'PlayerDowned': {
          this.audio.playPlayerHit();
          this.spawnRingParticle(ev.x, ev.y, PALETTE.lavenderLight, 76, 0.48);
          this.spawnParticles(ev.x, ev.y, PALETTE.lavender, 14, {
            speedMin: 45,
            speedMax: 135,
          });
          this.spawnFloatingText(ev.x, ev.y - 26, 'DOWNED!', PALETTE.coral, true);
          break;
        }

        case 'PlayerRevived': {
          this.audio.playLevelUp();
          this.spawnRingParticle(ev.x, ev.y, PALETTE.mintLight, 96, 0.5);
          this.spawnParticles(ev.x, ev.y, PALETTE.mint, 16, {
            speedMin: 60,
            speedMax: 160,
          });
          this.spawnFloatingText(
            ev.x,
            ev.y - 30,
            ev.reason === 'boss_kill' ? 'BOSS REVIVE!' : 'REVIVED!',
            PALETTE.mint,
            true
          );
          break;
        }
      }
    }
  }

  private handleCoopUpgradeChoices(
    msg: Extract<ServerControlMessage, { type: 'UpgradeChoices' }>
  ): void {
    const isNewBatch =
      !this.coopPendingUpgrade || this.coopPendingUpgrade.batchId !== msg.batchId;
    if (isNewBatch && msg.source === 'boss_chest') {
      this.audio.playSynergy();
      const lp = this.getCoopLocalPlayer();
      if (lp) {
        this.spawnRingParticle(lp.x, lp.y, PALETTE.butter, 125, 0.45);
        this.spawnFloatingText(lp.x, lp.y - 34, 'BOSS CHEST!', PALETTE.butter, true);
      }
    }
    this.coopPendingUpgrade = {
      batchId: msg.batchId,
      source: msg.source,
      choices: msg.choices,
      pendingQueueCount: msg.pendingQueueCount,
      pickInFlight: false,
    };
    this.callbacks.onCoopUpgradeChoices?.(this.coopPendingUpgrade);
  }

  private handleCoopUpgradeApplied(
    msg: Extract<ServerControlMessage, { type: 'UpgradeApplied' }>
  ): void {
    const selfSlot = this.net.getSlotId();
    if (msg.slotId !== selfSlot) {
      return;
    }

    const prog = this.coopProgression;
    const lp = this.getCoopLocalPlayer();

    if (msg.kind === 'ability' && msg.abilityId) {
      const ab = ABILITIES[msg.abilityId];
      const nextLv = msg.nextLevel ?? 1;
      const existing = prog.activeSlots.find(
        (s) => s.kind === 'ability' && s.id === msg.abilityId
      );
      if (existing) {
        existing.level = nextLv;
      } else {
        prog.activeSlots.push({
          kind: 'ability',
          id: msg.abilityId,
          level: nextLv,
          cooldownTimer: 0,
        });
      }
      if (nextLv === 5) {
        prog.globalPassives.push({
          id: ab.lv5Passive.id,
          sourceType: 'ability_lv5',
          sourceId: ab.id,
          sourceName: `${ab.name} Lv 5`,
          label: ab.lv5Passive.label,
          modifiers: ab.lv5Passive.modifiers,
        });
      } else if (nextLv === 10) {
        prog.globalPassives.push({
          id: ab.lv10Passive.id,
          sourceType: 'ability_lv10',
          sourceId: ab.id,
          sourceName: `${ab.name} Lv 10`,
          label: ab.lv10Passive.label,
          modifiers: ab.lv10Passive.modifiers,
        });
      }
    } else if (msg.kind === 'synergy' && msg.synergyId) {
      const syn = SYNERGIES[msg.synergyId];
      for (const reqId of syn.requires) {
        prog.consumedAbilities.add(reqId);
      }
      prog.activeSlots = prog.activeSlots.filter(
        (s) => !(s.kind === 'ability' && syn.requires.includes(s.id as AbilityId))
      );
      prog.activeSlots.push({
        kind: 'synergy',
        id: syn.id,
        level: 1,
        cooldownTimer: 0,
      });
      prog.ownedSynergies.add(syn.id);
      prog.globalPassives.push({
        id: syn.bonusPassive.id,
        sourceType: 'synergy',
        sourceId: syn.id,
        sourceName: syn.name,
        label: syn.bonusPassive.label,
        modifiers: syn.bonusPassive.modifiers,
      });
      this.audio.playSynergy();
      if (lp) {
        this.spawnRingParticle(lp.x, lp.y, syn.color, 130, 0.5);
        this.spawnParticles(lp.x, lp.y, syn.color, 24, { speedMin: 75, speedMax: 220 });
        this.spawnFloatingText(lp.x, lp.y - 34, `${syn.name.toUpperCase()}!`, syn.color, true);
      }
    } else if (msg.kind === 'artifact' && msg.artifactId) {
      const art = getArtifactDef(msg.artifactId as ArtifactId);
      if (!art.isFallback && !prog.ownedArtifacts.includes(art.id)) {
        prog.ownedArtifacts.push(art.id);
      }
      prog.globalPassives.push({
        id: `${art.passive.id}_${prog.globalPassives.length}`,
        sourceType: 'artifact',
        sourceId: art.id,
        sourceName: art.name,
        label: art.passive.label,
        modifiers: art.passive.modifiers,
      });
      this.audio.playSynergy();
      if (lp) {
        this.spawnRingParticle(lp.x, lp.y, art.color, 110, 0.45);
        this.spawnParticles(lp.x, lp.y, art.color, 20, { speedMin: 65, speedMax: 195 });
      }
    } else if (msg.kind === 'mastery') {
      prog.masteryCount += 1;
      const card = ENDLESS_MASTERY_CARDS.find(
        (c) => c.title === msg.title || c.shortTitle === msg.shortTitle
      );
      if (card?.masteryModifiers) {
        prog.globalPassives.push({
          id: `mastery_${prog.masteryCount}`,
          sourceType: 'mastery',
          sourceId: card.masteryId ?? 'mastery',
          sourceName: card.title,
          label: card.shortTag,
          modifiers: card.masteryModifiers,
        });
      }
    }

    prog.computedStats = buildComputedStats({
      heroId: prog.heroId,
      globalPassives: prog.globalPassives,
      ownedArtifacts: prog.ownedArtifacts,
      retributionBuffTimer: 0,
    });

    // Clear active strip immediately when no more queued batches remain
    if (msg.remainingQueueCount === 0) {
      this.coopPendingUpgrade = null;
      this.callbacks.onCoopUpgradeChoices?.(null);
    }
  }

  private handleCoopMatchEnd(
    victory: boolean,
    msg:
      | Extract<ServerControlMessage, { type: 'GameOver' }>
      | Extract<ServerControlMessage, { type: 'Victory' }>
  ): void {
    this.coopPendingUpgrade = null;
    this.coopPauseOpen = false;
    this.callbacks.onCoopUpgradeChoices?.(null);
    this.callbacks.onCoopPauseToggle?.(false);
    this.setState('gameover');
    this.callbacks.onCoopMatchEnd?.({
      victory,
      elapsedRunSec: msg.elapsedRunSec,
      kills: msg.kills,
      bossesDefeated: msg.bossesDefeated,
      players: msg.players,
    });
  }

  // ==========================================================================
  // SIMULATION EVENT CONSUMER (SOLO OFFLINE)
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
        case 'ChestSpawned':
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
  // CORE LOOP & UPDATE SUBSYSTEMS
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

    const state = this.getState();
    if (this.sessionMode === 'coop') {
      if (state === 'playing') {
        this.updateCoop(dt, now);
      } else if (state === 'menu') {
        this.camera.x += dt * 16;
        this.camera.y += dt * 8;
      }
      this.renderCoop();
    } else {
      if (state === 'playing') {
        this.updateSolo(dt);
      } else if (state === 'menu') {
        this.camera.x += dt * 16;
        this.camera.y += dt * 8;
      }
      this.renderSolo();
    }

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

  private updateSolo(dt: number): void {
    if (this.bossAlertTimer > 0) {
      this.bossAlertTimer = Math.max(0, this.bossAlertTimer - dt);
    }

    this.localInputMap.set(DEFAULT_LOCAL_PLAYER_ID, this.buildLocalPlayerInput());
    const events = this.sim.step(dt, this.localInputMap);
    this.processSimEvents(events);
    this.syncStateCallback();

    this.updateParticles(dt);
    this.updateFloatingNumbers(dt);
    this.updateCameraToward(this.player.x, this.player.y, dt);
  }

  private updateCoop(dt: number, nowMs: number): void {
    this.coopVisualTimeSec += dt;
    if (this.bossAlertTimer > 0) {
      this.bossAlertTimer = Math.max(0, this.bossAlertTimer - dt);
    }

    const move = this.input.getMoveVector();
    const aimMode = this.input.getAimMode();
    const manualAim = aimMode === 'mouse' && this.input.hasMousePosition();
    const selfPlayerPrev = this.getCoopLocalPlayer();

    let aimAngle = this.coopLastAimAngle;
    if (manualAim && selfPlayerPrev) {
      const mouseWorld = this.input.getMouseWorld(
        this.camera.x,
        this.camera.y,
        this.viewportWidth,
        this.viewportHeight
      );
      aimAngle = Math.atan2(mouseWorld.y - selfPlayerPrev.y, mouseWorld.x - selfPlayerPrev.x);
      this.coopLastAimAngle = aimAngle;
    } else if (move.x !== 0 || move.y !== 0) {
      aimAngle = Math.atan2(move.y, move.x);
      this.coopLastAimAngle = aimAngle;
    }

    // Stream binary input at 20-30 Hz (or immediately on change)
    this.net.sendInput(move.x, move.y, aimAngle, manualAim, nowMs);

    // Sample 60 FPS interpolated world with gentle local prediction/reconciliation
    const moveSpeed = this.coopProgression.computedStats.moveSpeed;
    this.coopWorld = this.net.sampleInterpolatedWorld(nowMs, dt, move.x, move.y, moveSpeed);

    if (this.coopWorld) {
      const bossEnemy = this.coopWorld.boss
        ? this.coopWorld.enemies.find((e) => e.id === this.coopWorld!.boss!.enemyId)
        : undefined;
      this.coopVfx.syncBossState(this.coopWorld.boss, bossEnemy, dt);
      this.coopVfx.update(dt, this.coopWorld.players, this.coopWorld.enemies);

      const selfPlayer = this.getCoopLocalPlayer();
      if (selfPlayer) {
        this.updateCameraToward(selfPlayer.x, selfPlayer.y, dt);
      }
    }

    this.updateParticles(dt);
    this.updateFloatingNumbers(dt);
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

  private updateCameraToward(targetX: number, targetY: number, dt: number): void {
    const cam = this.camera;
    const alpha = 1 - Math.exp(-cam.smoothness * dt);
    cam.x += (targetX - cam.x) * alpha;
    cam.y += (targetY - cam.y) * alpha;

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
  // SOLO OFFLINE RENDERING PIPELINE (UNTOUCHED)
  // ==========================================================================

  private renderSolo(): void {
    const ctx = this.ctx;
    const width = this.viewportWidth;
    const height = this.viewportHeight;
    const camX = this.camera.x + this.camera.shakeOffsetX;
    const camY = this.camera.y + this.camera.shakeOffsetY;
    const toScreen = (wx: number, wy: number) => this.worldToScreen(wx, wy);

    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = PALETTE.groundBase;
    ctx.fillRect(0, 0, width, height);

    this.renderGround(ctx, camX, camY, width, height);

    const state = this.sim.getState();
    if (state === 'menu') {
      return;
    }

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

    this.renderPickups(ctx);
    this.renderEnemies(ctx);

    for (const p of this.sim.players.values()) {
      if (p.alive) {
        this.renderPlayer(ctx, p);
      }
    }

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

    this.renderEnemyProjectiles(ctx);
    this.renderParticles(ctx);
    this.renderFloatingNumbers(ctx);
    this.renderOffscreenIndicators(ctx, width, height);
    if (this.bossAlertTimer > 0) {
      this.renderBossAlertBanner(ctx, width);
    }

    if (
      state === 'playing' &&
      this.input.getAimMode() === 'mouse' &&
      this.input.hasMousePosition()
    ) {
      this.renderMouseReticle(ctx);
    }

    if (state === 'playing') {
      this.input.renderJoystick(ctx);
    }
  }

  // ==========================================================================
  // ONLINE CO-OP RENDERING PIPELINE (60 FPS INTERPOLATED + READABILITY POLISH)
  // ==========================================================================

  private renderCoop(): void {
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

    if (this.coopState === 'menu' || !this.coopWorld) {
      return;
    }

    const world = this.coopWorld;
    const selfSlotId = world.selfSlotId;

    // Prepare single-boss shim for BossRenderer
    this.coopBossShimList.length = 0;
    if (world.boss) {
      const bossEnemy = world.enemies.find((e) => e.id === world.boss!.enemyId);
      if (bossEnemy) {
        const def = BOSSES[world.boss.bossId];
        this.coopBossShimList.push({
          id: bossEnemy.id,
          archetypeId: 'slime',
          bossId: world.boss.bossId,
          isBoss: true,
          isElite: false,
          x: bossEnemy.x,
          y: bossEnemy.y,
          vx: 0,
          vy: 0,
          kbVx: 0,
          kbVy: 0,
          radius: def.radius,
          hp: world.boss.hpPct,
          maxHp: 100,
          speed: def.speed,
          damage: def.contactDamage,
          xpValue: 0,
          knockbackResist: 1,
          facingLeft: (bossEnemy.flags & WireEnemyFlag.FACING_LEFT) !== 0,
          walkTime: bossEnemy.walkTime,
          hitFlashTimer: bossEnemy.hitFlashTimer,
          slowTimer: 0,
          slowFactor: 1,
          chilled: (bossEnemy.flags & WireEnemyFlag.CHILLED) !== 0,
          freezeTimer: 0,
          stunTimer: 0,
          burnTimer: 0,
          burnDps: 0,
          burnTickTimer: 0,
          burnColor: PALETTE.coral,
          tauntTimer: 0,
          tauntTargetId: null,
          stateFlags: 0,
          rangedCooldown: 0,
          alive: true,
        });
      }
    }

    // 2. Ground AoE effects (teammates dimmed to 50%, self 100%) + crisp Boss telegraphs
    this.coopVfx.renderGroundLayer(ctx, selfSlotId, toScreen);
    if (this.coopBossShimList.length > 0) {
      this.bossRenderer.renderGroundTelegraphs(
        ctx,
        this.coopBossShimList,
        (id) => this.coopVfx.getBossRuntime(id),
        toScreen
      );
    }

    // 3. Pickups (XP gems, Hearts, Magnets, Boss Chests)
    this.renderCoopPickups(ctx, world);

    // 4. Enemies & Bosses (with chilled tint, hit flash, elite/taunt indicators)
    this.renderCoopEnemies(ctx, world);

    // 5. Squad Players (living heroes, Pastel Ghost downed allies + revive ring, upgrading icon)
    this.renderCoopPlayers(ctx, world);

    // 6. Foreground projectiles/beams/melee (teammates 50%, self 100%) & ignited boss beams
    this.coopVfx.renderForegroundLayer(ctx, selfSlotId, world.players, toScreen, this.sprites);
    if (this.coopBossShimList.length > 0) {
      this.bossRenderer.renderForegroundEffects(
        ctx,
        this.coopBossShimList,
        (id) => this.coopVfx.getBossRuntime(id),
        toScreen
      );
    }

    // 7. Pastel particles & floating damage numbers
    this.renderParticles(ctx);
    this.renderFloatingNumbers(ctx);

    // 8. Edge-of-screen directional arrows (living teammates, downed teammates, bosses, chests)
    this.renderCoopOffscreenIndicators(ctx, world, width, height);

    if (this.bossAlertTimer > 0) {
      this.renderBossAlertBanner(ctx, width);
    }

    if (
      this.coopState === 'playing' &&
      this.input.getAimMode() === 'mouse' &&
      this.input.hasMousePosition()
    ) {
      this.renderMouseReticle(ctx);
    }

    if (this.coopState === 'playing') {
      this.input.renderJoystick(ctx);
    }
  }

  private renderCoopPickups(
    ctx: CanvasRenderingContext2D,
    world: InterpolatedWorldState
  ): void {
    const pad = 44;
    const pickups = world.pickups;
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
          ctx.globalAlpha = 0.78;
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
      ctx.ellipse(
        screen.x,
        screen.y + 10,
        item.kind === 'chest' ? 15 : 7,
        3.5,
        0,
        0,
        Math.PI * 2
      );
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

  private renderCoopEnemies(
    ctx: CanvasRenderingContext2D,
    world: InterpolatedWorldState
  ): void {
    const pad = 120;
    const enemies = world.enemies;
    const bossState: WireBossState | null = world.boss;

    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      const screen = this.worldToScreen(e.x, e.y);
      if (
        screen.x < -pad ||
        screen.x > this.viewportWidth + pad ||
        screen.y < -pad ||
        screen.y > this.viewportHeight + pad
      ) {
        continue;
      }

      const isBoss = isBossWireType(e.type);
      const isElite = (e.flags & WireEnemyFlag.ELITE) !== 0;
      const isChilled = (e.flags & WireEnemyFlag.CHILLED) !== 0;
      const isTaunted = (e.flags & WireEnemyFlag.TAUNTED) !== 0;
      const facingLeft = (e.flags & WireEnemyFlag.FACING_LEFT) !== 0;

      const radius = isBoss
        ? BOSSES[e.type as BossId].radius
        : ENEMIES[e.type as EnemySpriteId].radius;
      const frame = Math.floor(e.walkTime * 6) % 2;
      const bob = frame === 1 ? -1.5 : 0;
      const scale = isBoss ? 3 : e.type === 'minislime' ? 2.2 : PIXEL_SCALE;
      const sprite = isBoss
        ? this.sprites.bosses[e.type as BossId][frame]
        : this.sprites.enemies[e.type as EnemySpriteId][frame];

      const bossRt = isBoss ? this.coopVfx.getBossRuntime(e.id) : undefined;
      const jumpHeight = bossRt ? bossRt.jumpHeight : 0;
      const shadowScale = Math.max(0.45, 1 - jumpHeight / 220);

      // Ground shadow
      ctx.fillStyle = PALETTE.shadow;
      ctx.beginPath();
      ctx.ellipse(
        screen.x,
        screen.y + radius + 4,
        radius * 0.9 * shadowScale,
        5 * shadowScale,
        0,
        0,
        Math.PI * 2
      );
      ctx.fill();

      // Boss enraged pulsing aura
      if (isBoss && bossState && bossState.enemyId === e.id && bossState.enraged) {
        const pulse = 0.5 + 0.5 * Math.sin(this.coopVisualTimeSec * 8);
        ctx.save();
        ctx.globalAlpha = 0.28 + pulse * 0.16;
        ctx.strokeStyle = BOSSES[e.type as BossId].accentColor;
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        ctx.arc(screen.x, screen.y - jumpHeight, radius + 10 + pulse * 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      drawPixelSprite(
        ctx,
        sprite,
        screen.x,
        screen.y + bob - jumpHeight,
        scale,
        facingLeft,
        e.hitFlashTimer > 0
      );

      if (isElite && !isBoss) {
        ctx.save();
        ctx.globalAlpha = 0.58;
        ctx.strokeStyle = PALETTE.butter;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, radius + 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // Chilled enemy pastel ice tint + frost rim
      if (isChilled) {
        ctx.save();
        ctx.fillStyle = 'rgba(182, 226, 248, 0.36)';
        ctx.strokeStyle = PALETTE.babyBlueLight;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.arc(screen.x, screen.y - jumpHeight, radius + 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }

      if (isTaunted && !isBoss) {
        ctx.save();
        ctx.strokeStyle = PALETTE.coral;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(screen.x, screen.y - radius - 8, 4.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // HP Bar
      if (isBoss) {
        const bossDef = BOSSES[e.type as BossId];
        const bw = 78;
        const bh = 7;
        const bx = Math.round(screen.x - bw / 2);
        const by = Math.round(screen.y + radius + 12);
        const ratio = Math.max(0, Math.min(1, e.hpPct / 100));
        ctx.fillStyle = PALETTE.outline;
        ctx.fillRect(bx - 2, by - 2, bw + 4, bh + 4);
        ctx.fillStyle = PALETTE.creamDark;
        ctx.fillRect(bx, by, bw, bh);
        ctx.fillStyle = bossDef.accentColor;
        ctx.fillRect(bx, by, Math.round(bw * ratio), bh);
      } else if (e.hpPct < 100) {
        const bw = 26;
        const bh = 4;
        const bx = Math.round(screen.x - bw / 2);
        const by = Math.round(screen.y - radius - 12);
        const ratio = Math.max(0, Math.min(1, e.hpPct / 100));
        ctx.fillStyle = PALETTE.outline;
        ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
        ctx.fillStyle = PALETTE.creamDark;
        ctx.fillRect(bx, by, bw, bh);
        ctx.fillStyle = PALETTE.coral;
        ctx.fillRect(bx, by, Math.round(bw * ratio), bh);
      }
    }
  }

  private renderCoopPlayers(
    ctx: CanvasRenderingContext2D,
    world: InterpolatedWorldState
  ): void {
    // Draw teammates first, local player on top so local hero is always crystal clear
    const sorted = [...world.players].sort((a, b) => (a.isLocal ? 1 : 0) - (b.isLocal ? 1 : 0));

    for (let i = 0; i < sorted.length; i++) {
      const p = sorted[i];
      const screen = this.worldToScreen(p.x, p.y);
      const isDowned = (p.stateFlags & WirePlayerFlag.DOWNED) !== 0;
      const isUpgrading = (p.stateFlags & WirePlayerFlag.UPGRADING) !== 0;
      const isInvuln = (p.stateFlags & WirePlayerFlag.INVULN) !== 0;
      const isBeingRevived = (p.stateFlags & WirePlayerFlag.BEING_REVIVED) !== 0;
      const isDisconnected = (p.stateFlags & WirePlayerFlag.DISCONNECTED) !== 0;
      const facingLeft = (p.stateFlags & WirePlayerFlag.FACING_LEFT) !== 0;

      if (isDowned) {
        this.renderDownedGhostPlayer(ctx, p, screen.x, screen.y, isBeingRevived, facingLeft);
        continue;
      }

      const walkFrame = p.isMoving ? Math.floor(p.walkTime * 7) % 2 : 0;
      const bobOffset = p.isMoving && walkFrame === 1 ? -2 : 0;
      const classColor = CLASSES[p.classId].accentColor;

      // Ground shadow
      ctx.fillStyle = PALETTE.shadow;
      ctx.beginPath();
      ctx.ellipse(screen.x, screen.y + 20, 14, 6, 0, 0, Math.PI * 2);
      ctx.fill();

      // Subtle class-colored ring beneath teammates (and crisp ring under self)
      ctx.save();
      ctx.globalAlpha = p.isLocal ? 0.55 : 0.4;
      ctx.strokeStyle = p.isLocal ? PALETTE.cream : classColor;
      ctx.lineWidth = p.isLocal ? 2.5 : 2;
      ctx.beginPath();
      ctx.ellipse(screen.x, screen.y + 19, 17, 7, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // Hero sprite (with invulnerability blink or disconnected fade)
      ctx.save();
      if (isDisconnected) {
        ctx.globalAlpha = 0.55;
      } else if (isInvuln) {
        ctx.globalAlpha = 0.58 + 0.35 * Math.sin(this.coopVisualTimeSec * 22);
      }
      drawPixelSprite(
        ctx,
        this.sprites.heroes[p.classId][walkFrame],
        screen.x,
        screen.y + bobOffset,
        PIXEL_SCALE,
        facingLeft,
        p.hitFlashTimer > 0
      );
      ctx.restore();

      // Name tag above teammates
      if (!p.isLocal) {
        ctx.save();
        ctx.font = 'bold 10px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const tag = isDisconnected ? `${p.name} (DC)` : p.name;
        ctx.lineWidth = 3;
        ctx.strokeStyle = PALETTE.outline;
        ctx.strokeText(tag, Math.round(screen.x), Math.round(screen.y - 31));
        ctx.fillStyle = classColor;
        ctx.fillText(tag, Math.round(screen.x), Math.round(screen.y - 31));
        ctx.restore();
      }

      // Floating scroll/up-arrow icon above teammates currently picking an upgrade
      if (!p.isLocal && isUpgrading) {
        this.renderUpgradingBadge(ctx, screen.x, screen.y - 48);
      }

      // HP bar below hero
      const barW = p.isLocal ? 40 : 34;
      const barH = p.isLocal ? 6 : 5;
      const bx = Math.round(screen.x - barW / 2);
      const by = Math.round(screen.y + 28);
      const hpRatio = Math.max(0, Math.min(1, p.hpPct / 100));

      ctx.fillStyle = PALETTE.outline;
      ctx.fillRect(bx - 1, by - 1, barW + 2, barH + 2);
      ctx.fillStyle = PALETTE.creamDark;
      ctx.fillRect(bx, by, barW, barH);
      ctx.fillStyle = hpRatio > 0.35 ? PALETTE.mintDark : PALETTE.coral;
      ctx.fillRect(bx, by, Math.round(barW * hpRatio), barH);
    }
  }

  /**
   * Renders a downed teammate (or self) as a floating Pastel Ghost inside a dashed
   * revive zone with a crisp circular revive progress ring around the ghost.
   */
  private renderDownedGhostPlayer(
    ctx: CanvasRenderingContext2D,
    p: InterpolatedPlayer,
    sx: number,
    sy: number,
    isBeingRevived: boolean,
    facingLeft: boolean
  ): void {
    const pulse = 0.5 + 0.5 * Math.sin(this.coopVisualTimeSec * 5.2);
    const ghostBob = Math.sin(this.coopVisualTimeSec * 3.8) * 4;
    const progress = Math.max(0, Math.min(1, p.revivePct / 100));

    ctx.save();

    // 1. Revive standing zone circle on the ground
    ctx.globalAlpha = isBeingRevived ? 0.24 + pulse * 0.1 : 0.14 + pulse * 0.08;
    ctx.fillStyle = isBeingRevived ? PALETTE.mint : PALETTE.coral;
    ctx.beginPath();
    ctx.arc(sx, sy, REVIVE_CIRCLE_RADIUS, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = isBeingRevived ? PALETTE.mintDark : PALETTE.coral;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([7, 5]);
    ctx.beginPath();
    ctx.arc(sx, sy, REVIVE_CIRCLE_RADIUS, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // 2. Ethereal Pastel Ghost halo & semi-transparent tinted hero sprite
    ctx.globalAlpha = 0.35 + pulse * 0.15;
    ctx.fillStyle = PALETTE.lavenderLight;
    ctx.beginPath();
    ctx.arc(sx, sy + ghostBob, 24, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = 0.62;
    drawPixelSprite(
      ctx,
      this.sprites.heroes[p.classId][0],
      sx,
      sy + ghostBob,
      PIXEL_SCALE,
      facingLeft,
      true
    );

    // 3. Circular revive progress ring tightly framing the Pastel Ghost
    const ringR = 32;
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = 'rgba(58, 50, 69, 0.55)';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.arc(sx, sy, ringR, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(253, 246, 227, 0.55)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(sx, sy, ringR, 0, Math.PI * 2);
    ctx.stroke();

    if (progress > 0.005) {
      const startA = -Math.PI * 0.5;
      const endA = startA + Math.PI * 2 * progress;
      ctx.strokeStyle = PALETTE.outline;
      ctx.lineWidth = 7.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(sx, sy, ringR, startA, endA);
      ctx.stroke();

      ctx.strokeStyle = PALETTE.mint;
      ctx.lineWidth = 4.5;
      ctx.beginPath();
      ctx.arc(sx, sy, ringR, startA, endA);
      ctx.stroke();
    }

    // 4. Label above ghost
    ctx.globalAlpha = 1;
    ctx.font = 'bold 10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label =
      progress > 0
        ? `REVIVING ${p.revivePct}%`
        : p.isLocal
        ? 'DOWNED — WAIT FOR REVIVE'
        : `REVIVE ${p.name}`;
    ctx.lineWidth = 3;
    ctx.strokeStyle = PALETTE.outline;
    ctx.strokeText(label, Math.round(sx), Math.round(sy - 42));
    ctx.fillStyle = isBeingRevived ? PALETTE.mint : PALETTE.cream;
    ctx.fillText(label, Math.round(sx), Math.round(sy - 42));

    ctx.restore();
  }

  /**
   * Draws a subtle floating pastel scroll + up-arrow icon above a teammate
   * whose `upgrading` flag is active so allies know to cover them.
   */
  private renderUpgradingBadge(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number
  ): void {
    const bob = Math.sin(this.coopVisualTimeSec * 5.5) * 3;
    const bx = Math.round(x);
    const by = Math.round(y + bob);

    ctx.save();
    // Little parchment scroll card
    ctx.fillStyle = PALETTE.cream;
    ctx.strokeStyle = PALETTE.outline;
    ctx.lineWidth = 2;
    ctx.fillRect(bx - 10, by - 9, 20, 17);
    ctx.strokeRect(bx - 10, by - 9, 20, 17);

    // Butter top roll edge
    ctx.fillStyle = PALETTE.butter;
    ctx.fillRect(bx - 9, by - 8, 18, 4);

    // Crisp upward arrow icon inside scroll
    ctx.fillStyle = PALETTE.lavenderDark;
    ctx.beginPath();
    ctx.moveTo(bx, by - 4);
    ctx.lineTo(bx + 5, by + 2);
    ctx.lineTo(bx + 2, by + 2);
    ctx.lineTo(bx + 2, by + 6);
    ctx.lineTo(bx - 2, by + 6);
    ctx.lineTo(bx - 2, by + 2);
    ctx.lineTo(bx - 5, by + 2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /**
   * Edge-of-screen directional arrows for Co-op:
   * - Living teammates (class-colored)
   * - Downed teammates (pulsing coral/white arrow + revive cross icon)
   * - Active Bosses
   * - Unopened Boss Chests
   */
  private renderCoopOffscreenIndicators(
    ctx: CanvasRenderingContext2D,
    world: InterpolatedWorldState,
    width: number,
    height: number
  ): void {
    const margin = 30;
    const pulse = 0.5 + 0.5 * Math.sin(this.coopVisualTimeSec * 8);

    const drawArrow = (
      wx: number,
      wy: number,
      fillColor: string,
      label: string,
      isRevive = false
    ): void => {
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

      // Pulsing halo for downed teammate revive arrows
      if (isRevive) {
        ctx.save();
        ctx.globalAlpha = 0.35 + pulse * 0.35;
        ctx.fillStyle = PALETTE.coral;
        ctx.beginPath();
        ctx.arc(0, 0, 15 + pulse * 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      ctx.save();
      ctx.rotate(angle);
      ctx.fillStyle = isRevive && pulse > 0.55 ? PALETTE.white : fillColor;
      ctx.strokeStyle = PALETTE.outline;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(12, 0);
      ctx.lineTo(-8, -8.5);
      ctx.lineTo(-4, 0);
      ctx.lineTo(-8, 8.5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      if (isRevive) {
        // Crisp medical/revive cross icon badge next to arrow
        const ix = -cos * 18;
        const iy = -sin * 18;
        ctx.fillStyle = PALETTE.cream;
        ctx.strokeStyle = PALETTE.outline;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(ix, iy, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = PALETTE.coral;
        ctx.fillRect(Math.round(ix - 1.5), Math.round(iy - 4.5), 3, 9);
        ctx.fillRect(Math.round(ix - 4.5), Math.round(iy - 1.5), 9, 3);
      }

      ctx.font = 'bold 10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.strokeStyle = PALETTE.outline;
      ctx.lineWidth = 3;
      const ly = py < 52 ? 18 : -17;
      ctx.strokeText(label, 0, ly);
      ctx.fillStyle = isRevive ? PALETTE.coralLight : PALETTE.cream;
      ctx.fillText(label, 0, ly);
      ctx.restore();
    };

    // 1. Living & Downed Teammates
    for (let i = 0; i < world.players.length; i++) {
      const p = world.players[i];
      if (p.isLocal) continue;
      const isDowned = (p.stateFlags & WirePlayerFlag.DOWNED) !== 0;
      if (isDowned) {
        drawArrow(p.x, p.y, PALETTE.coral, `REVIVE ${p.name.slice(0, 8)}`, true);
      } else {
        drawArrow(p.x, p.y, CLASSES[p.classId].accentColor, p.name.slice(0, 8), false);
      }
    }

    // 2. Active Bosses
    for (let i = 0; i < world.enemies.length; i++) {
      const e = world.enemies[i];
      if (isBossWireType(e.type)) {
        drawArrow(e.x, e.y, BOSSES[e.type].accentColor, 'BOSS', false);
      }
    }

    // 3. Unopened Boss Chests
    for (let i = 0; i < world.pickups.length; i++) {
      const item = world.pickups[i];
      if (item.kind === 'chest') {
        drawArrow(item.x, item.y, PALETTE.butter, 'CHEST', false);
      }
    }
  }

  // ==========================================================================
  // SHARED RENDERING PRIMITIVES
  // ==========================================================================

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
      ctx.ellipse(
        screen.x,
        screen.y + 10,
        item.kind === 'chest' ? 15 : 7,
        3.5,
        0,
        0,
        Math.PI * 2
      );
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
