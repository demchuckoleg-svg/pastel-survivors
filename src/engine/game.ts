import { PALETTE } from '../art/palette';
import {
  drawPixelSprite,
  initSprites,
  type EnemySpriteId,
  type GroundSpriteId,
  type HeroId,
  type PickupSpriteId,
  type SpriteAtlas,
} from '../art/sprites';
import { ABILITIES, getAbilitiesForClass, getAbilityDef } from '../data/abilities';
import {
  ARTIFACTS,
  getArtifactDef,
  getAvailableBossArtifacts,
} from '../data/artifacts';
import {
  CLASSES,
  MAX_ABILITY_LEVEL,
  MAX_ACTIVE_ABILITY_SLOTS,
} from '../data/classes';
import {
  BOSS_SPAWN_INTERVAL_MIN,
  BOSSES,
  ENEMIES,
  enemyHP,
  enemySpawnRate,
  enemyXP,
  getBossForEncounter,
  pickWaveArchetype,
  xpNeeded,
} from '../data/enemies';
import {
  getSynergiesForClass,
  getSynergyDef,
  SYNERGIES,
} from '../data/synergies';
import type {
  AbilityId,
  ArtifactDef,
  ArtifactId,
  BossId,
  GlobalStatKey,
  SynergyDef,
  SynergyId,
} from '../data/types';
import {
  AbilityRunner,
  type ActiveAbilitySlot,
  type CombatContext,
  type ComputedPlayerStats,
  type DamageOptions,
  type EnemyEntity,
  type GlobalPassiveEntry,
  type ParticleBurstOptions,
} from '../entities/abilityRunner';
import {
  BossAIManager,
  getBossDamageScale,
  getBossScaledHp,
  type BossActiveInfo,
  type BossAIContext,
} from '../entities/bossAI';
import { AudioManager } from './audio';
import { InputManager } from './input';
import { SpatialHash } from './spatialHash';
import { recordRunResult, type AimMode, type NewBestFlags } from './storage';

/**
 * Core clamped-dt game loop, smooth camera tracking, wave director,
 * Global Passive Ledger, Synergy Evolution, pickups, particles, and combat engine.
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
  xp: number;
  level: number;
  facingLeft: boolean;
  aimAngle: number;
  walkTime: number;
  isMoving: boolean;
  invulnTimer: number;
  hitFlashTimer: number;
  retributionBuffTimer: number;
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

export interface PickupEntity {
  kind: PickupSpriteId;
  x: number;
  y: number;
  vx: number;
  vy: number;
  value: number;
  radius: number;
  magnetized: boolean;
  age: number;
}

export interface EnemyProjectile {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  damage: number;
  life: number;
  maxLife: number;
  color: string;
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

export interface LevelUpChoice {
  kind: 'ability' | 'synergy' | 'mastery';
  abilityId?: AbilityId;
  synergyId?: SynergyId;
  masteryId?: string;
  title: string;
  subtitle: string;
  description: string;
  passivePreview?: string;
  nextLevel?: number;
  isNew?: boolean;
  color: string;
  masteryModifiers?: Partial<Record<GlobalStatKey, number>>;
  masteryHeal?: number;
}

export interface RunStatsSnapshot {
  elapsedRunSec: number;
  level: number;
  xp: number;
  xpToNext: number;
  kills: number;
  bossesDefeated: number;
  newBests?: NewBestFlags;
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
const MAX_ENEMIES = 320;
const MAX_PARTICLES = 450;
const MAX_FLOATING_NUMBERS = 140;
const MAX_PICKUPS = 320;

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
  public readonly spatialHash: SpatialHash<EnemyEntity>;
  public readonly abilityRunner: AbilityRunner;
  public readonly bossAI: BossAIManager;

  public readonly player: PlayerState;
  public readonly camera: CameraState;

  public enemies: EnemyEntity[] = [];
  public enemyProjectiles: EnemyProjectile[] = [];
  public pickups: PickupEntity[] = [];
  public floatingNumbers: FloatingNumber[] = [];
  public particles: Particle[] = [];

  private readonly callbacks: GameEngineCallbacks;
  private state: GameState = 'menu';
  private viewportWidth = 0;
  private viewportHeight = 0;
  private elapsedRunSec = 0;
  private rafId: number | null = null;
  private lastTimestamp = 0;

  // Combat, wave director & progression state
  private nextEnemyId = 1;
  private spawnAccumulator = 0;
  private nextBossEncounterIndex = 0;
  private nextSwarmWaveSec = 45;
  private kills = 0;
  private bossesDefeated = 0;
  private masteryCount = 0;
  private pendingLevelUps = 0;
  private pendingChoices: LevelUpChoice[] = [];
  private pendingArtifactChoices: ArtifactDef[] = [];

  // Boss spawn alert banner
  private bossAlertTimer = 0;
  private bossAlertTitle = '';
  private bossAlertSubtitle = '';
  private bossAlertColor: string = PALETTE.coral;

  // Reusable query buffer for zero-allocation enemy separation
  private readonly sepQueryBuf: EnemyEntity[] = [];

  // Ability slots, Synergy evolution & Global Passive Ledger
  private activeSlots: ActiveAbilitySlot[] = [];
  private readonly consumedAbilities = new Set<AbilityId>();
  private readonly ownedSynergies = new Set<SynergyId>();
  private ownedArtifacts: ArtifactId[] = [];
  private globalPassives: GlobalPassiveEntry[] = [];
  private computedStats: ComputedPlayerStats;

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
    this.spatialHash = new SpatialHash<EnemyEntity>(64);
    this.abilityRunner = new AbilityRunner();
    this.bossAI = new BossAIManager();

    this.input = new InputManager(canvas, {
      onPauseToggle: () => this.togglePause(),
      onAimModeToggle: (mode) => {
        this.audio.playClick();
        this.callbacks.onAimModeChange?.(mode);
      },
      onUserGesture: () => this.audio.unlock(),
    });

    const base = CLASSES.mage.baseStats;
    this.player = {
      heroId: 'mage',
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      speed: base.moveSpeed,
      radius: 14,
      hp: base.maxHp,
      maxHp: base.maxHp,
      xp: 0,
      level: 1,
      facingLeft: false,
      aimAngle: 0,
      walkTime: 0,
      isMoving: false,
      invulnTimer: 0,
      hitFlashTimer: 0,
      retributionBuffTimer: 0,
    };

    this.computedStats = this.buildComputedStats('mage');

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
  // PUBLIC STATE GETTERS
  // ==========================================================================

  public getState(): GameState {
    return this.state;
  }

  public getElapsedRunSec(): number {
    return this.elapsedRunSec;
  }

  public getKills(): number {
    return this.kills;
  }

  public getBossesDefeated(): number {
    return this.bossesDefeated;
  }

  public getViewportSize(): { width: number; height: number } {
    return { width: this.viewportWidth, height: this.viewportHeight };
  }

  public getActiveSlots(): readonly ActiveAbilitySlot[] {
    return this.activeSlots;
  }

  public getConsumedAbilities(): ReadonlySet<AbilityId> {
    return this.consumedAbilities;
  }

  public getOwnedSynergies(): ReadonlySet<SynergyId> {
    return this.ownedSynergies;
  }

  public getOwnedArtifacts(): readonly ArtifactId[] {
    return this.ownedArtifacts;
  }

  public getGlobalPassives(): readonly GlobalPassiveEntry[] {
    return this.globalPassives;
  }

  public getComputedStats(): ComputedPlayerStats {
    return this.computedStats;
  }

  public getPendingLevelUpChoices(): readonly LevelUpChoice[] {
    return this.pendingChoices;
  }

  public getPendingLevelUps(): number {
    return this.pendingLevelUps;
  }

  public getPendingArtifactChoices(): readonly ArtifactDef[] {
    return this.pendingArtifactChoices;
  }

  public getActiveBoss(): EnemyEntity | null {
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (e.alive && e.isBoss) return e;
    }
    return null;
  }

  public getActiveBosses(): EnemyEntity[] {
    return this.enemies.filter((e) => e.alive && e.isBoss);
  }

  public getActiveBossInfo(): BossActiveInfo | null {
    const boss = this.getActiveBoss();
    return boss ? this.bossAI.getBossInfo(boss) : null;
  }

  public getNextBossCountdownSec(): number {
    const nextSpawnSec = (this.nextBossEncounterIndex + 1) * BOSS_SPAWN_INTERVAL_MIN * 60;
    return Math.max(0, nextSpawnSec - this.elapsedRunSec);
  }

  public getRunStatsSnapshot(): RunStatsSnapshot {
    return {
      elapsedRunSec: this.elapsedRunSec,
      level: this.player.level,
      xp: this.player.xp,
      xpToNext: xpNeeded(this.player.level),
      kills: this.kills,
      bossesDefeated: this.bossesDefeated,
    };
  }

  public getAbilityLevel(abilityId: AbilityId): number {
    const slot = this.activeSlots.find((s) => s.kind === 'ability' && s.id === abilityId);
    if (slot) return slot.level;
    if (this.consumedAbilities.has(abilityId)) return MAX_ABILITY_LEVEL;
    return 0;
  }

  // ==========================================================================
  // LIFECYCLE & RUN CONTROL
  // ==========================================================================

  public setState(next: GameState): void {
    if (this.state === next) return;
    this.state = next;
    if (next !== 'playing') {
      this.input.reset();
    }
    this.callbacks.onStateChange?.(next);
  }

  public startRun(heroId: HeroId = 'mage'): void {
    const classDef = CLASSES[heroId];
    const base = classDef.baseStats;

    this.player.heroId = heroId;
    this.player.x = 0;
    this.player.y = 0;
    this.player.vx = 0;
    this.player.vy = 0;
    this.player.speed = base.moveSpeed;
    this.player.hp = base.maxHp;
    this.player.maxHp = base.maxHp;
    this.player.xp = 0;
    this.player.level = 1;
    this.player.facingLeft = false;
    this.player.aimAngle = 0;
    this.player.walkTime = 0;
    this.player.isMoving = false;
    this.player.invulnTimer = 0;
    this.player.hitFlashTimer = 0;
    this.player.retributionBuffTimer = 0;

    this.camera.x = 0;
    this.camera.y = 0;
    this.camera.shakeIntensity = 0;
    this.camera.shakeTimeLeft = 0;
    this.camera.shakeOffsetX = 0;
    this.camera.shakeOffsetY = 0;

    this.elapsedRunSec = 0;
    this.nextEnemyId = 1;
    this.spawnAccumulator = 0;
    this.nextBossEncounterIndex = 0;
    this.nextSwarmWaveSec = 45;
    this.kills = 0;
    this.bossesDefeated = 0;
    this.masteryCount = 0;
    this.pendingLevelUps = 0;
    this.pendingChoices = [];
    this.pendingArtifactChoices = [];
    this.bossAlertTimer = 0;

    this.enemies.length = 0;
    this.enemyProjectiles.length = 0;
    this.pickups.length = 0;
    this.floatingNumbers.length = 0;
    this.particles.length = 0;

    this.activeSlots = [];
    this.consumedAbilities.clear();
    this.ownedSynergies.clear();
    this.ownedArtifacts = [];
    this.globalPassives = [];

    this.spatialHash.clear();
    this.abilityRunner.reset();
    this.bossAI.reset();

    this.recomputeStats(false);
    // Equip hero's signature starting ability at Lv 1
    this.acquireOrUpgradeAbility(classDef.startingAbilityId);

    this.setState('playing');
  }

  public pause(): void {
    if (this.state === 'playing') {
      this.setState('paused');
    }
  }

  public resume(): void {
    if (this.state === 'paused' && this.pendingLevelUps > 0) {
      this.pendingLevelUps--;
      this.openNextLevelUp();
      return;
    }
    if (this.state === 'paused' || this.state === 'levelup' || this.state === 'artifact') {
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

  // ==========================================================================
  // 6-SLOT CAP, GLOBAL PASSIVE LEDGER & SYNERGY EVOLUTION
  // ==========================================================================

  /**
   * Returns true if a new base ability can be acquired into an active slot.
   * Respects the 6-active-slot cap and rejects already active or consumed abilities.
   */
  public canAcquireNewAbility(abilityId: AbilityId): boolean {
    if (this.consumedAbilities.has(abilityId)) return false;
    if (this.activeSlots.some((s) => s.kind === 'ability' && s.id === abilityId)) {
      return false;
    }
    return this.activeSlots.length < MAX_ACTIVE_ABILITY_SLOTS;
  }

  /**
   * Acquires a new ability at Lv 1 (within the 6-slot cap) or upgrades an existing
   * active ability by +1 level (up to Lv 10), recording Lv 5 and Lv 10 permanent
   * global passives in the Global Passive Ledger.
   */
  public acquireOrUpgradeAbility(abilityId: AbilityId): boolean {
    if (this.consumedAbilities.has(abilityId)) return false;

    const def = getAbilityDef(abilityId);
    const existing = this.activeSlots.find(
      (s) => s.kind === 'ability' && s.id === abilityId
    );

    if (existing) {
      if (existing.level >= MAX_ABILITY_LEVEL) return false;
      existing.level += 1;

      if (existing.level === 5) {
        this.recordGlobalPassive({
          id: def.lv5Passive.id,
          sourceType: 'ability_lv5',
          sourceId: def.id,
          sourceName: `${def.name} Lv 5`,
          label: def.lv5Passive.label,
          modifiers: def.lv5Passive.modifiers,
        });
      } else if (existing.level === 10) {
        this.recordGlobalPassive({
          id: def.lv10Passive.id,
          sourceType: 'ability_lv10',
          sourceId: def.id,
          sourceName: `${def.name} Lv 10`,
          label: def.lv10Passive.label,
          modifiers: def.lv10Passive.modifiers,
        });
      }

      this.recomputeStats(true);
      return true;
    }

    if (this.activeSlots.length >= MAX_ACTIVE_ABILITY_SLOTS) {
      return false;
    }

    this.activeSlots.push({
      kind: 'ability',
      id: abilityId,
      level: 1,
      cooldownTimer: 0.08,
    });
    this.recomputeStats(true);
    return true;
  }

  /**
   * Returns all Synergy Evolutions currently ready for this run
   * (both component abilities active at Lv 10 and Synergy not yet owned).
   */
  public getAvailableSynergyEvolutions(): SynergyDef[] {
    const classSynergies = getSynergiesForClass(this.player.heroId);
    return classSynergies.filter((syn) => {
      if (this.ownedSynergies.has(syn.id)) return false;
      const [reqA, reqB] = syn.requires;
      const slotA = this.activeSlots.find(
        (s) => s.kind === 'ability' && s.id === reqA && s.level >= MAX_ABILITY_LEVEL
      );
      const slotB = this.activeSlots.find(
        (s) => s.kind === 'ability' && s.id === reqB && s.level >= MAX_ABILITY_LEVEL
      );
      return Boolean(slotA && slotB);
    });
  }

  /**
   * Executes the Synergy Evolution rule:
   * - Requires both component abilities at Lv 10.
   * - Consumes both component abilities (removes them from activeSlots, freeing 1 active slot).
   * - Preserves all Lv 5 and Lv 10 global passives already granted by those two abilities.
   * - Adds the evolved Synergy to activeSlots and appends the Synergy's bonus global passive.
   */
  public evolveSynergy(synergyId: SynergyId): boolean {
    if (this.ownedSynergies.has(synergyId)) return false;

    const syn = getSynergyDef(synergyId);
    const [reqA, reqB] = syn.requires;

    const idxA = this.activeSlots.findIndex(
      (s) => s.kind === 'ability' && s.id === reqA && s.level >= MAX_ABILITY_LEVEL
    );
    const idxB = this.activeSlots.findIndex(
      (s) => s.kind === 'ability' && s.id === reqB && s.level >= MAX_ABILITY_LEVEL
    );
    if (idxA === -1 || idxB === -1) return false;

    // Guarantee both components' Lv 5 & Lv 10 passives remain preserved in the ledger
    for (const compId of [reqA, reqB] as const) {
      const compDef = ABILITIES[compId];
      this.recordGlobalPassive({
        id: compDef.lv5Passive.id,
        sourceType: 'ability_lv5',
        sourceId: compDef.id,
        sourceName: `${compDef.name} Lv 5`,
        label: compDef.lv5Passive.label,
        modifiers: compDef.lv5Passive.modifiers,
      });
      this.recordGlobalPassive({
        id: compDef.lv10Passive.id,
        sourceType: 'ability_lv10',
        sourceId: compDef.id,
        sourceName: `${compDef.name} Lv 10`,
        label: compDef.lv10Passive.label,
        modifiers: compDef.lv10Passive.modifiers,
      });
    }

    // Consume both Lv 10 abilities (removing 2 slots) and clean up base persistent effects
    this.consumedAbilities.add(reqA);
    this.consumedAbilities.add(reqB);
    this.abilityRunner.clearEffectsForAbility(reqA);
    this.abilityRunner.clearEffectsForAbility(reqB);

    const insertIdx = Math.min(idxA, idxB);
    this.activeSlots = this.activeSlots.filter(
      (s) => !(s.kind === 'ability' && (s.id === reqA || s.id === reqB))
    );

    // Insert the single evolved Synergy slot (net 1 active slot freed!)
    const evolvedSlot: ActiveAbilitySlot = {
      kind: 'synergy',
      id: synergyId,
      level: 1,
      cooldownTimer: 0.05,
    };
    this.activeSlots.splice(Math.min(insertIdx, this.activeSlots.length), 0, evolvedSlot);
    this.ownedSynergies.add(synergyId);

    // Grant the Synergy's bonus permanent global passive
    this.recordGlobalPassive({
      id: syn.bonusPassive.id,
      sourceType: 'synergy',
      sourceId: syn.id,
      sourceName: `${syn.name} Synergy`,
      label: syn.bonusPassive.label,
      modifiers: syn.bonusPassive.modifiers,
    });

    this.recomputeStats(true);
    this.audio.playSynergy();
    this.spawnRingParticle(this.player.x, this.player.y, syn.color, 130, 0.5);
    this.spawnParticles(this.player.x, this.player.y, syn.color, 26, {
      speedMin: 80,
      speedMax: 240,
    });
    this.spawnFloatingText(
      this.player.x,
      this.player.y - 34,
      `${syn.name.toUpperCase()}!`,
      syn.color,
      true
    );

    return true;
  }

  /**
   * Grants a Boss Artifact (or Ascended Relic fallback), records its passive in
   * the Global Passive Ledger, and triggers immediate pickup effects.
   */
  public grantArtifact(artifactId: ArtifactId): void {
    const def = getArtifactDef(artifactId);
    this.ownedArtifacts.push(artifactId);

    const uniqueId = def.isFallback
      ? `${def.passive.id}_${this.ownedArtifacts.length}`
      : def.passive.id;

    this.recordGlobalPassive({
      id: uniqueId,
      sourceType: 'artifact',
      sourceId: def.id,
      sourceName: def.name,
      label: def.passive.label,
      modifiers: def.passive.modifiers,
    });

    this.recomputeStats(true);

    if (def.specialEffect === 'full_heal_on_pickup') {
      this.player.hp = this.player.maxHp;
      this.spawnFloatingText(this.player.x, this.player.y - 26, 'FULL HEAL!', PALETTE.mint, true);
    }

    this.audio.playSynergy();
    this.spawnRingParticle(this.player.x, this.player.y, def.color, 110, 0.45);
    this.spawnParticles(this.player.x, this.player.y, def.color, 22, {
      speedMin: 70,
      speedMax: 210,
    });

    this.pendingArtifactChoices = [];

    if (this.state === 'artifact') {
      if (this.pendingLevelUps > 0) {
        this.pendingLevelUps--;
        this.openNextLevelUp();
      } else {
        this.resume();
      }
    }
  }

  /**
   * Generates up to `count` level-up choice cards, prioritizing Synergy Evolutions,
   * then active upgrades and new class abilities (respecting the 6-slot cap), with
   * endless mastery fallback cards once all slots are maxed.
   */
  public generateLevelUpChoices(count = 3): LevelUpChoice[] {
    const choices: LevelUpChoice[] = [];

    // 1. High-priority Synergy Evolution cards
    const readySynergies = this.getAvailableSynergyEvolutions();
    for (const syn of readySynergies) {
      if (choices.length >= count) break;
      const [reqA, reqB] = syn.requires;
      choices.push({
        kind: 'synergy',
        synergyId: syn.id,
        title: syn.name,
        subtitle: `SYNERGY EVOLUTION (${ABILITIES[reqA].name} + ${ABILITIES[reqB].name})`,
        description: syn.description,
        passivePreview: `Frees 1 slot + keeps Lv5/Lv10 passives + ${syn.bonusPassive.label}`,
        color: syn.color,
      });
    }

    // 2. Pool of eligible upgrades and new abilities
    const pool: LevelUpChoice[] = [];
    const classAbilities = getAbilitiesForClass(this.player.heroId);
    const hasFreeSlot = this.activeSlots.length < MAX_ACTIVE_ABILITY_SLOTS;

    for (const ab of classAbilities) {
      if (this.consumedAbilities.has(ab.id)) continue;

      const active = this.activeSlots.find(
        (s) => s.kind === 'ability' && s.id === ab.id
      );

      if (active) {
        if (active.level >= MAX_ABILITY_LEVEL) continue;
        const nextLv = active.level + 1;
        const step = ab.levels.find((l) => l.level === nextLv);
        let passivePreview: string | undefined;
        if (nextLv === 5) passivePreview = `Lv 5 Global Passive: ${ab.lv5Passive.label}`;
        else if (nextLv === 10) passivePreview = `Lv 10 Global Passive: ${ab.lv10Passive.label}`;

        pool.push({
          kind: 'ability',
          abilityId: ab.id,
          title: ab.name,
          subtitle: `Lv ${active.level} -> Lv ${nextLv}`,
          description: step ? step.description : ab.description,
          passivePreview,
          nextLevel: nextLv,
          isNew: false,
          color: ab.color,
        });
      } else if (hasFreeSlot) {
        pool.push({
          kind: 'ability',
          abilityId: ab.id,
          title: ab.name,
          subtitle: 'NEW ABILITY (Lv 1)',
          description: ab.description,
          passivePreview: `Lv 5: ${ab.lv5Passive.label} | Lv 10: ${ab.lv10Passive.label}`,
          nextLevel: 1,
          isNew: true,
          color: ab.color,
        });
      }
    }

    // Shuffle eligible ability pool
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
    }

    while (choices.length < count && pool.length > 0) {
      const next = pool.shift();
      if (next) choices.push(next);
    }

    // 3. Endless Mastery fallback cards when all 6 slots are maxed
    const masteries: LevelUpChoice[] = [
      {
        kind: 'mastery',
        masteryId: 'mastery_power',
        title: 'Pastel Might',
        subtitle: 'ENDLESS MASTERY',
        description: '+10% All Damage permanently.',
        color: PALETTE.coral,
        masteryModifiers: { damageMult: 0.1 },
      },
      {
        kind: 'mastery',
        masteryId: 'mastery_haste',
        title: 'Pastel Haste',
        subtitle: 'ENDLESS MASTERY',
        description: '-6% All Cooldowns & +5% Move Speed permanently.',
        color: PALETTE.babyBlue,
        masteryModifiers: { cooldownReduction: 0.06, moveSpeedMult: 0.05 },
      },
      {
        kind: 'mastery',
        masteryId: 'mastery_vitality',
        title: 'Pastel Vitality',
        subtitle: 'ENDLESS MASTERY',
        description: '+25 Max HP, +0.5 HP/s Regen, and heal 35 HP.',
        color: PALETTE.mint,
        masteryModifiers: { maxHpFlat: 25, hpRegen: 0.5 },
        masteryHeal: 35,
      },
    ];

    let mIdx = 0;
    while (choices.length < count && mIdx < masteries.length) {
      choices.push(masteries[mIdx++]);
    }

    return choices;
  }

  /**
   * Applies a selected LevelUpChoice and either opens the next queued level-up
   * or resumes gameplay.
   */
  public applyLevelUpChoice(choice: LevelUpChoice): void {
    if (choice.kind === 'synergy' && choice.synergyId) {
      this.evolveSynergy(choice.synergyId);
    } else if (choice.kind === 'ability' && choice.abilityId) {
      this.acquireOrUpgradeAbility(choice.abilityId);
    } else if (choice.kind === 'mastery' && choice.masteryModifiers) {
      this.masteryCount++;
      this.recordGlobalPassive({
        id: `${choice.masteryId ?? 'mastery'}_${this.masteryCount}`,
        sourceType: 'mastery',
        sourceId: choice.masteryId ?? 'mastery',
        sourceName: choice.title,
        label: choice.description,
        modifiers: choice.masteryModifiers,
      });
      this.recomputeStats(true);
      if (choice.masteryHeal) {
        this.healPlayer(choice.masteryHeal);
      }
    }

    this.pendingChoices = [];
    if (this.pendingLevelUps > 0) {
      this.pendingLevelUps--;
      this.openNextLevelUp();
    } else if (this.state === 'levelup') {
      this.resume();
    }
  }

  /**
   * Debug / helper utility to grant levels quickly (e.g. from Pause Debug Tools).
   */
  public grantLevels(levels = 1): void {
    for (let i = 0; i < levels; i++) {
      this.player.level += 1;
      this.pendingLevelUps += 1;
    }
    this.audio.playLevelUp();
    if (this.state === 'playing' && this.pendingLevelUps > 0) {
      this.pendingLevelUps--;
      this.openNextLevelUp();
    }
  }

  private recordGlobalPassive(entry: GlobalPassiveEntry): void {
    if (this.globalPassives.some((p) => p.id === entry.id)) return;
    this.globalPassives.push(entry);
  }

  private buildComputedStats(heroId: HeroId): ComputedPlayerStats {
    const base = CLASSES[heroId].baseStats;
    let maxHpFlat = 0;
    let moveSpeedMult = 0;
    let pickupRadiusMult = 0;
    let armorBonus = 0;
    let critChanceBonus = 0;
    let critMultBonus = 0;
    let hpRegenBonus = 0;
    let damageMultBonus = 0;
    let cooldownReduction = 0;
    let areaMultBonus = 0;
    let xpGainMultBonus = 0;
    let knockbackMultBonus = 0;
    let projectileBonus = 0;
    let pierceBonus = 0;

    for (let i = 0; i < this.globalPassives.length; i++) {
      const m = this.globalPassives[i].modifiers;
      if (m.maxHpFlat) maxHpFlat += m.maxHpFlat;
      if (m.moveSpeedMult) moveSpeedMult += m.moveSpeedMult;
      if (m.pickupRadiusMult) pickupRadiusMult += m.pickupRadiusMult;
      if (m.armor) armorBonus += m.armor;
      if (m.critChance) critChanceBonus += m.critChance;
      if (m.critMultiplier) critMultBonus += m.critMultiplier;
      if (m.hpRegen) hpRegenBonus += m.hpRegen;
      if (m.damageMult) damageMultBonus += m.damageMult;
      if (m.cooldownReduction) cooldownReduction += m.cooldownReduction;
      if (m.areaMult) areaMultBonus += m.areaMult;
      if (m.xpGainMult) xpGainMultBonus += m.xpGainMult;
      if (m.knockbackMult) knockbackMultBonus += m.knockbackMult;
      if (m.projectileBonus) projectileBonus += m.projectileBonus;
      if (m.pierceBonus) pierceBonus += m.pierceBonus;
    }

    const retributionBonus = this.player.retributionBuffTimer > 0 ? 0.25 : 0;

    return {
      maxHp: Math.round(base.maxHp + maxHpFlat),
      moveSpeed: base.moveSpeed * (1 + moveSpeedMult),
      pickupRadius: base.pickupRadius * (1 + pickupRadiusMult),
      armor: Math.min(0.75, base.armor + armorBonus),
      critChance: Math.min(0.95, base.critChance + critChanceBonus),
      critMultiplier: base.critMultiplier + critMultBonus,
      hpRegen: base.hpRegen + hpRegenBonus,
      damageMult: 1 + damageMultBonus + retributionBonus,
      cooldownMult: Math.max(0.25, 1 - cooldownReduction),
      areaMult: 1 + areaMultBonus,
      xpGainMult: 1 + xpGainMultBonus,
      knockbackMult: 1 + knockbackMultBonus,
      projectileBonus: Math.round(projectileBonus),
      pierceBonus: Math.round(pierceBonus),
      hasDoubleCast: this.ownedArtifacts.includes('aether_chronometer'),
      hasRetributionAegis: this.ownedArtifacts.includes('retribution_aegis'),
    };
  }

  private recomputeStats(healOnMaxHpGain: boolean): void {
    const prevMaxHp = this.player.maxHp;
    this.computedStats = this.buildComputedStats(this.player.heroId);
    this.player.speed = this.computedStats.moveSpeed;
    this.player.maxHp = this.computedStats.maxHp;
    if (healOnMaxHpGain && this.player.maxHp > prevMaxHp) {
      this.player.hp = Math.min(
        this.player.maxHp,
        this.player.hp + (this.player.maxHp - prevMaxHp)
      );
    } else {
      this.player.hp = Math.min(this.player.maxHp, this.player.hp);
    }
  }

  // ==========================================================================
  // ENEMY SPAWNING & COMBAT ACTIONS
  // ==========================================================================

  public spawnEnemy(
    archetypeId: EnemySpriteId,
    x: number,
    y: number,
    hpOverride?: number
  ): EnemyEntity {
    const def = ENEMIES[archetypeId];
    const minutes = this.elapsedRunSec / 60;
    const maxHp = Math.round(hpOverride ?? enemyHP(def.baseHp, minutes));
    const xpValue = Math.max(1, Math.round(enemyXP(def.baseXp, minutes)));

    const enemy: EnemyEntity = {
      id: this.nextEnemyId++,
      archetypeId,
      isBoss: false,
      x,
      y,
      vx: 0,
      vy: 0,
      kbVx: 0,
      kbVy: 0,
      radius: def.radius,
      hp: maxHp,
      maxHp,
      speed: def.speed,
      damage: def.damage * (1 + 0.06 * minutes),
      xpValue,
      knockbackResist: def.knockbackResist,
      facingLeft: x > this.player.x,
      walkTime: Math.random() * 2,
      hitFlashTimer: 0,
      slowTimer: 0,
      slowFactor: 1,
      freezeTimer: 0,
      stunTimer: 0,
      burnTimer: 0,
      burnDps: 0,
      burnTickTimer: 0,
      burnColor: PALETTE.coral,
      rangedCooldown: def.rangedCooldown ? def.rangedCooldown * (0.5 + Math.random() * 0.5) : 0,
      aiState: 'normal',
      aiTimer: 0,
      aiCooldown: def.behavior === 'chase_tank' ? 2.2 + Math.random() * 2.0 : 0,
      alive: true,
    };

    this.enemies.push(enemy);
    return enemy;
  }

  /**
   * Spawns a scheduled or debug Boss (King Mochi, Lady Wisteria, or Aegis) with
   * cycle-scaled HP, contact damage, and telegraphed attack state machine.
   */
  public spawnBoss(bossId?: BossId, encounterIndexOverride?: number): EnemyEntity {
    const encounterIndex =
      encounterIndexOverride !== undefined
        ? encounterIndexOverride
        : bossId !== undefined
        ? this.bossesDefeated
        : this.nextBossEncounterIndex;

    const bossDef = bossId ? BOSSES[bossId] : getBossForEncounter(encounterIndex);
    const minutes = this.elapsedRunSec / 60;
    const maxHp = getBossScaledHp(bossDef, minutes, encounterIndex);
    const xpValue = Math.max(40, Math.round(enemyXP(bossDef.baseXp, minutes)));
    const contactDamage = bossDef.contactDamage * getBossDamageScale(minutes, encounterIndex);

    // Guarantee room for the boss even if regular waves hit MAX_ENEMIES
    if (this.enemies.length >= MAX_ENEMIES) {
      let farIdx = -1;
      let farDistSq = -1;
      for (let i = 0; i < this.enemies.length; i++) {
        const candidate = this.enemies[i];
        if (candidate.isBoss) continue;
        const dx = candidate.x - this.player.x;
        const dy = candidate.y - this.player.y;
        const dSq = dx * dx + dy * dy;
        if (dSq > farDistSq) {
          farDistSq = dSq;
          farIdx = i;
        }
      }
      if (farIdx !== -1) {
        this.enemies.splice(farIdx, 1);
      }
    }

    // Spawn just inside/near the perimeter ahead of the player for dramatic arrival
    const spawnDist = Math.min(
      Math.max(260, Math.min(this.viewportWidth, this.viewportHeight) * 0.44),
      380
    );
    const angle = this.player.isMoving
      ? Math.atan2(this.player.vy, this.player.vx) + (Math.random() - 0.5) * 0.9
      : Math.random() * Math.PI * 2;
    const sx = this.player.x + Math.cos(angle) * spawnDist;
    const sy = this.player.y + Math.sin(angle) * spawnDist;

    const boss: EnemyEntity = {
      id: this.nextEnemyId++,
      archetypeId: 'golem',
      bossId: bossDef.id,
      isBoss: true,
      bossEncounterIndex: encounterIndex,
      x: sx,
      y: sy,
      vx: 0,
      vy: 0,
      kbVx: 0,
      kbVy: 0,
      radius: bossDef.radius,
      hp: maxHp,
      maxHp,
      speed: bossDef.speed,
      damage: contactDamage,
      xpValue,
      knockbackResist: 0.92,
      facingLeft: sx > this.player.x,
      walkTime: 0,
      hitFlashTimer: 0,
      slowTimer: 0,
      slowFactor: 1,
      freezeTimer: 0,
      stunTimer: 0,
      burnTimer: 0,
      burnDps: 0,
      burnTickTimer: 0,
      burnColor: bossDef.accentColor,
      rangedCooldown: 0,
      aiState: 'normal',
      aiTimer: 0,
      aiCooldown: 0,
      alive: true,
    };

    this.enemies.push(boss);
    this.bossAI.registerBoss(boss, bossDef.id, encounterIndex);

    this.audio.playBossAlert();
    this.addScreenShake(5.5, 0.32);
    this.spawnRingParticle(sx, sy, bossDef.accentColor, 145, 0.55);
    this.spawnParticles(sx, sy, bossDef.accentColor, 26, {
      speedMin: 75,
      speedMax: 220,
      sizeMin: 4,
      sizeMax: 8,
    });

    this.bossAlertTimer = 3.2;
    this.bossAlertTitle = bossDef.name.toUpperCase();
    this.bossAlertSubtitle = bossDef.title;
    this.bossAlertColor = bossDef.accentColor;

    const info = this.bossAI.getBossInfo(boss);
    if (info) {
      this.callbacks.onBossSpawned?.(info);
    }

    return boss;
  }

  public spawnPickup(
    kind: PickupSpriteId,
    x: number,
    y: number,
    value = 0
  ): void {
    // Soft cap XP gems to protect framerate in extreme swarms (never cap hearts/magnets/chests)
    if (this.pickups.length >= MAX_PICKUPS && kind.startsWith('xp_')) {
      const oldestXp = this.pickups.find((p) => p.kind.startsWith('xp_'));
      if (oldestXp) {
        oldestXp.value += value;
        oldestXp.kind = oldestXp.value >= 20 ? 'xp_large' : oldestXp.value >= 9 ? 'xp_medium' : 'xp_small';
        return;
      }
    }

    const scatter = kind === 'chest' ? 14 : 45;
    this.pickups.push({
      kind,
      x,
      y,
      vx: (Math.random() - 0.5) * scatter,
      vy: (Math.random() - 0.5) * scatter,
      value,
      radius: kind === 'chest' ? 20 : 10,
      magnetized: false,
      age: 0,
    });
  }

  public damageEnemy = (
    enemy: EnemyEntity,
    rawDamage: number,
    opts: DamageOptions = {}
  ): boolean => {
    if (!enemy.alive) return false;

    const critChance = Math.min(0.98, this.computedStats.critChance + (opts.bonusCritChance ?? 0));
    const isCrit = Math.random() < critChance;
    const critMult = this.computedStats.critMultiplier + (opts.bonusCritMult ?? 0);

    let finalDamage = rawDamage * (isCrit ? critMult : 1);

    // Absolute Zero shatter bonus against frozen or chilled targets
    let shattered = false;
    if (opts.shatterBonus && (enemy.freezeTimer > 0 || enemy.slowTimer > 0)) {
      finalDamage *= 1.5;
      shattered = true;
    }

    const dmg = Math.max(1, Math.round(finalDamage));
    enemy.hp -= dmg;
    enemy.hitFlashTimer = 0.11;

    // Status effects
    if (opts.chillDuration && opts.chillDuration > 0) {
      enemy.slowTimer = Math.max(enemy.slowTimer, opts.chillDuration);
      enemy.slowFactor = Math.min(enemy.slowFactor, opts.chillFactor ?? 0.55);
    }
    if (opts.freezeDuration && opts.freezeDuration > 0 && !enemy.isBoss) {
      enemy.freezeTimer = Math.max(enemy.freezeTimer, opts.freezeDuration);
    }
    if (opts.stunDuration && opts.stunDuration > 0 && !enemy.isBoss) {
      enemy.stunTimer = Math.max(enemy.stunTimer, opts.stunDuration);
    }
    if (opts.burnDps && opts.burnDuration && opts.burnDuration > 0) {
      enemy.burnTimer = Math.max(enemy.burnTimer, opts.burnDuration);
      enemy.burnDps = Math.max(enemy.burnDps, opts.burnDps);
      enemy.burnColor = opts.burnColor ?? PALETTE.coral;
    }

    // Knockback impulse
    if (opts.knockback && opts.knockback > 0) {
      const resist = Math.max(0, Math.min(1, enemy.knockbackResist));
      const impulse = opts.knockback * (1 - resist);
      if (impulse > 1) {
        const sx = opts.sourceX ?? this.player.x;
        const sy = opts.sourceY ?? this.player.y;
        const dx = enemy.x - sx;
        const dy = enemy.y - sy;
        const dist = Math.hypot(dx, dy);
        if (dist > 0.01) {
          enemy.kbVx += (dx / dist) * impulse;
          enemy.kbVy += (dy / dist) * impulse;
        }
      }
    }

    // Floating damage number & pastel hit sparks
    this.spawnFloatingText(
      enemy.x + (Math.random() - 0.5) * 14,
      enemy.y - enemy.radius - 4,
      shattered ? `${dmg}!` : `${dmg}`,
      shattered ? PALETTE.babyBlueLight : isCrit ? PALETTE.butter : PALETTE.cream,
      isCrit || shattered
    );

    this.spawnParticles(
      enemy.x,
      enemy.y,
      opts.color ?? PALETTE.cream,
      isCrit || shattered ? 7 : 4,
      { speedMin: 35, speedMax: 120, sizeMin: 3, sizeMax: 5 }
    );

    if (!opts.silent) {
      this.audio.playHit(isCrit);
    }

    if (enemy.hp <= 0) {
      this.handleEnemyDeath(enemy);
      return true;
    }
    return false;
  };

  public healPlayer = (amount: number): void => {
    if (amount <= 0) return;
    const before = this.player.hp;
    this.player.hp = Math.min(this.player.maxHp, this.player.hp + amount);
    const healed = Math.round(this.player.hp - before);
    if (healed > 0) {
      this.spawnFloatingText(
        this.player.x,
        this.player.y - 24,
        `+${healed}`,
        PALETTE.mint,
        false
      );
      this.spawnParticles(this.player.x, this.player.y, PALETTE.mintLight, 6, {
        speedMin: 30,
        speedMax: 85,
      });
    }
  };

  public damagePlayer(rawDamage: number): void {
    if (this.player.invulnTimer > 0 || this.state !== 'playing') return;

    const mitigated = Math.max(1, Math.round(rawDamage * (1 - this.computedStats.armor)));
    this.player.hp = Math.max(0, this.player.hp - mitigated);
    this.player.invulnTimer = 0.45;
    this.player.hitFlashTimer = 0.16;

    this.audio.playPlayerHit();
    this.addScreenShake(5.5, 0.18);
    this.spawnFloatingText(
      this.player.x,
      this.player.y - 24,
      `-${mitigated}`,
      PALETTE.coral,
      true
    );
    this.spawnParticles(this.player.x, this.player.y, PALETTE.coral, 10, {
      speedMin: 55,
      speedMax: 150,
    });

    // Retribution Aegis artifact special effect
    if (this.computedStats.hasRetributionAegis && this.player.hp > 0) {
      this.player.retributionBuffTimer = 4.0;
      this.recomputeStats(false);
      this.abilityRunner.triggerRetributionShockwave(this.createCombatContext());
    }

    if (this.player.hp <= 0) {
      this.handleGameOver();
    }
  }

  public spawnParticles = (
    x: number,
    y: number,
    color: string,
    count: number,
    opts: ParticleBurstOptions = {}
  ): void => {
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
  };

  public spawnRingParticle = (
    x: number,
    y: number,
    color: string,
    maxRadius: number,
    duration = 0.3
  ): void => {
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
  };

  public spawnFloatingText = (
    x: number,
    y: number,
    text: string,
    color: string,
    isCrit = false
  ): void => {
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
  };

  private handleEnemyDeath(enemy: EnemyEntity): void {
    enemy.alive = false;
    this.kills += 1;

    if (enemy.isBoss) {
      const bossInfo = this.bossAI.getBossInfo(enemy);
      this.bossAI.onBossRemoved(enemy.id);
      this.bossesDefeated += 1;

      const bossAccent = bossInfo?.accentColor ?? PALETTE.butter;
      this.spawnRingParticle(enemy.x, enemy.y, bossAccent, 165, 0.55);
      this.spawnRingParticle(enemy.x, enemy.y, PALETTE.butter, 115, 0.45);
      this.spawnParticles(enemy.x, enemy.y, bossAccent, 30, {
        speedMin: 60,
        speedMax: 250,
        sizeMin: 4,
        sizeMax: 8,
      });
      this.spawnParticles(enemy.x, enemy.y, PALETTE.butter, 16, {
        speedMin: 50,
        speedMax: 190,
        sizeMin: 3,
        sizeMax: 6,
      });
      this.spawnFloatingText(
        enemy.x,
        enemy.y - enemy.radius - 16,
        'BOSS DEFEATED!',
        PALETTE.butter,
        true
      );
      this.addScreenShake(8.0, 0.4);
      this.audio.playPickup();

      // Scatter a rewarding burst of large XP gems around the boss
      const gemCount = 4;
      const perGemXp = Math.max(10, Math.round(enemy.xpValue / gemCount));
      for (let g = 0; g < gemCount; g++) {
        const a = (Math.PI * 2 * g) / gemCount + 0.35;
        this.spawnPickup(
          'xp_large',
          enemy.x + Math.cos(a) * 26,
          enemy.y + Math.sin(a) * 26,
          perGemXp
        );
      }

      // Drop Boss Chest at the boss's defeat location
      this.spawnPickup('chest', enemy.x, enemy.y, 0);

      if (bossInfo) {
        this.callbacks.onBossDefeated?.(bossInfo);
      }
      return;
    }

    // Standard enemy pastel death burst
    const burstColor =
      enemy.archetypeId === 'slime'
        ? PALETTE.rose
        : enemy.archetypeId === 'golem'
        ? PALETTE.peach
        : enemy.archetypeId === 'wisp'
        ? PALETTE.lavender
        : PALETTE.mint;

    this.spawnParticles(enemy.x, enemy.y, burstColor, 10, {
      speedMin: 50,
      speedMax: 145,
      sizeMin: 4,
      sizeMax: 7,
    });

    // Drop XP gem (3 tiers)
    const xpTier: PickupSpriteId =
      enemy.xpValue >= 20 ? 'xp_large' : enemy.xpValue >= 9 ? 'xp_medium' : 'xp_small';
    this.spawnPickup(xpTier, enemy.x, enemy.y, enemy.xpValue);

    // Rare regular enemy drops: Magnet Orb (0.55%) & Pastel Heart (1.25%)
    const roll = Math.random();
    if (roll < 0.0055) {
      this.spawnPickup('magnet', enemy.x + 8, enemy.y, 0);
    } else if (roll < 0.018) {
      this.spawnPickup('heart', enemy.x + 8, enemy.y, 0);
    }
  }

  private handleGameOver(): void {
    const { newBests } = recordRunResult(this.player.heroId, {
      timeSec: this.elapsedRunSec,
      level: this.player.level,
      kills: this.kills,
      bosses: this.bossesDefeated,
    });
    const snapshot: RunStatsSnapshot = {
      ...this.getRunStatsSnapshot(),
      newBests,
    };
    this.setState('gameover');
    this.callbacks.onGameOver?.(snapshot);
  }

  private openNextLevelUp(): void {
    const choices = this.generateLevelUpChoices(3);
    this.pendingChoices = choices;
    if (this.callbacks.onLevelUp) {
      this.setState('levelup');
      this.callbacks.onLevelUp(choices);
    }
  }

  private createCombatContext(): CombatContext {
    return {
      player: this.player,
      stats: this.computedStats,
      aimMode: this.input.getAimMode(),
      spatialHash: this.spatialHash,
      enemies: this.enemies,
      sprites: this.sprites,
      viewportWidth: this.viewportWidth,
      viewportHeight: this.viewportHeight,
      damageEnemy: this.damageEnemy,
      healPlayer: this.healPlayer,
      spawnParticles: this.spawnParticles,
      spawnRingParticle: this.spawnRingParticle,
      spawnFloatingText: this.spawnFloatingText,
      addScreenShake: (intensity, dur) => this.addScreenShake(intensity, dur),
      playHitSound: (isCrit) => this.audio.playHit(isCrit),
    };
  }

  private createBossAIContext(): BossAIContext {
    return {
      player: this.player,
      elapsedRunSec: this.elapsedRunSec,
      damagePlayer: (rawDamage) => this.damagePlayer(rawDamage),
      spawnEnemyProjectile: (opts) => {
        this.enemyProjectiles.push({
          x: opts.x,
          y: opts.y,
          vx: opts.vx,
          vy: opts.vy,
          radius: opts.radius,
          damage: opts.damage,
          life: 0,
          maxLife: opts.maxLife,
          color: opts.color,
        });
      },
      spawnMinion: (archetypeId, x, y, impulseX = 0, impulseY = 0) => {
        if (this.enemies.length >= MAX_ENEMIES) return;
        const minion = this.spawnEnemy(archetypeId, x, y);
        minion.kbVx = impulseX;
        minion.kbVy = impulseY;
      },
      spawnParticles: this.spawnParticles,
      spawnRingParticle: this.spawnRingParticle,
      spawnFloatingText: this.spawnFloatingText,
      addScreenShake: (intensity, dur) => this.addScreenShake(intensity, dur),
      getMinionCount: () => {
        let count = 0;
        for (let i = 0; i < this.enemies.length; i++) {
          if (this.enemies[i].alive && this.enemies[i].archetypeId === 'minislime') {
            count++;
          }
        }
        return count;
      },
    };
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
  };

  private readonly loop = (now: number): void => {
    const rawDt = (now - this.lastTimestamp) / 1000;
    this.lastTimestamp = now;
    const dt = Math.min(Math.max(rawDt, 0), MAX_DT);

    if (this.state === 'playing') {
      this.update(dt);
    } else if (this.state === 'menu') {
      this.camera.x += dt * 16;
      this.camera.y += dt * 8;
    }

    this.render();
    this.rafId = requestAnimationFrame(this.loop);
  };

  private update(dt: number): void {
    this.elapsedRunSec += dt;
    if (this.bossAlertTimer > 0) {
      this.bossAlertTimer = Math.max(0, this.bossAlertTimer - dt);
    }

    this.updatePlayer(dt);
    this.updateWaveSpawner(dt);
    this.updateEnemies(dt);
    this.updateEnemyProjectiles(dt);

    // Populate 64px spatial hash, apply mass-aware separation, and refresh for combat queries
    this.spatialHash.clear();
    this.spatialHash.insertAll(this.enemies);
    this.resolveEnemySeparation();
    this.spatialHash.clear();
    this.spatialHash.insertAll(this.enemies);

    // Execute all active abilities & evolved synergies
    const combatCtx = this.createCombatContext();
    this.abilityRunner.update(dt, this.activeSlots, combatCtx);

    // Prune dead enemies after combat step
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      if (!this.enemies[i].alive) {
        if (this.enemies[i].isBoss) {
          this.bossAI.onBossRemoved(this.enemies[i].id);
        }
        this.enemies.splice(i, 1);
      }
    }

    this.updatePickups(dt);
    this.updateParticles(dt);
    this.updateFloatingNumbers(dt);
    this.updateCamera(dt);
  }

  private updatePlayer(dt: number): void {
    const move = this.input.getMoveVector();
    const p = this.player;

    if (p.invulnTimer > 0) p.invulnTimer = Math.max(0, p.invulnTimer - dt);
    if (p.hitFlashTimer > 0) p.hitFlashTimer = Math.max(0, p.hitFlashTimer - dt);

    if (p.retributionBuffTimer > 0) {
      p.retributionBuffTimer = Math.max(0, p.retributionBuffTimer - dt);
      if (p.retributionBuffTimer === 0) {
        this.recomputeStats(false);
      }
    }

    // Passive HP regeneration
    if (this.computedStats.hpRegen > 0 && p.hp < p.maxHp) {
      p.hp = Math.min(p.maxHp, p.hp + this.computedStats.hpRegen * dt);
    }

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

  /**
   * Wave Director:
   * - Spawns scheduled Bosses every 10 minutes (King Mochi 10:00, Lady Wisteria 20:00,
   *   Aegis 30:00, cycling indefinitely with scaled HP and faster cooldowns).
   * - Continuously scales regular enemy spawn rate, HP, and XP drops with elapsed minutes `t`.
   * - Triggers periodic coordinated swarmer clusters for exciting wave rhythm.
   */
  private updateWaveSpawner(dt: number): void {
    // 1. Scheduled 10-minute Boss encounters
    let nextBossSec = (this.nextBossEncounterIndex + 1) * BOSS_SPAWN_INTERVAL_MIN * 60;
    while (this.elapsedRunSec >= nextBossSec) {
      const encounterIdx = this.nextBossEncounterIndex;
      this.nextBossEncounterIndex += 1;
      const bossDef = getBossForEncounter(encounterIdx);
      this.spawnBoss(bossDef.id, encounterIdx);
      nextBossSec = (this.nextBossEncounterIndex + 1) * BOSS_SPAWN_INTERVAL_MIN * 60;
    }

    if (this.enemies.length >= MAX_ENEMIES) return;

    const minutes = this.elapsedRunSec / 60;
    const bossActive = this.bossAI.hasActiveBoss();
    const spawnRadius = Math.hypot(this.viewportWidth * 0.5, this.viewportHeight * 0.5) + 75;

    // 2. Continuous scaled wave spawning (eased slightly during boss fights for readability)
    const rate = enemySpawnRate(minutes) * (bossActive ? 0.55 : 1);
    this.spawnAccumulator += rate * dt;

    while (this.spawnAccumulator >= 1 && this.enemies.length < MAX_ENEMIES) {
      this.spawnAccumulator -= 1;
      const archetype = pickWaveArchetype(minutes);
      const angle = Math.random() * Math.PI * 2;
      const dist = spawnRadius + Math.random() * 80;
      const sx = this.player.x + Math.cos(angle) * dist;
      const sy = this.player.y + Math.sin(angle) * dist;
      this.spawnEnemy(archetype.id, sx, sy);
    }

    // 3. Periodic coordinated swarm clusters (every 50s when no boss is active)
    if (!bossActive && this.elapsedRunSec >= this.nextSwarmWaveSec) {
      this.nextSwarmWaveSec += 50;
      const packSize = Math.min(18, 6 + Math.floor(minutes * 1.4));
      const baseAngle = Math.random() * Math.PI * 2;
      const arcSpan = Math.min(Math.PI * 1.2, 0.7 + minutes * 0.06);

      for (let i = 0; i < packSize && this.enemies.length < MAX_ENEMIES; i++) {
        const frac = packSize > 1 ? i / (packSize - 1) - 0.5 : 0;
        const a = baseAngle + frac * arcSpan + (Math.random() - 0.5) * 0.12;
        const d = spawnRadius + 30 + Math.random() * 75;
        const sx = this.player.x + Math.cos(a) * d;
        const sy = this.player.y + Math.sin(a) * d;
        const isBruteLead = minutes >= 3.5 && i === Math.floor(packSize / 2);
        this.spawnEnemy(isBruteLead ? 'golem' : 'slime', sx, sy);
      }
    }
  }

  private updateEnemies(dt: number): void {
    const p = this.player;
    const despawnDistSq =
      (Math.hypot(this.viewportWidth, this.viewportHeight) * 0.9 + 260) ** 2;
    const kbDecay = Math.exp(-10 * dt);
    const bossCtx = this.bossAI.hasActiveBoss() ? this.createBossAIContext() : null;

    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (!e.alive) continue;

      if (e.hitFlashTimer > 0) e.hitFlashTimer = Math.max(0, e.hitFlashTimer - dt);
      if (e.freezeTimer > 0) e.freezeTimer = Math.max(0, e.freezeTimer - dt);
      if (e.stunTimer > 0) e.stunTimer = Math.max(0, e.stunTimer - dt);
      if (e.slowTimer > 0) {
        e.slowTimer = Math.max(0, e.slowTimer - dt);
        if (e.slowTimer === 0) e.slowFactor = 1;
      }

      // Burn / bleed DoT ticks
      if (e.burnTimer > 0) {
        e.burnTimer = Math.max(0, e.burnTimer - dt);
        e.burnTickTimer -= dt;
        if (e.burnTickTimer <= 0) {
          e.burnTickTimer = 0.4;
          const tickDmg = Math.max(1, e.burnDps * 0.4);
          this.damageEnemy(e, tickDmg, {
            color: e.burnColor,
            silent: true,
          });
          if (!e.alive) continue;
        }
      }

      // Boss state machine execution
      if (e.isBoss && bossCtx) {
        const canDealContact = this.bossAI.updateBoss(e, dt, bossCtx);
        if (canDealContact) {
          const bdx = p.x - e.x;
          const bdy = p.y - e.y;
          const hitDist = p.radius + e.radius - 3;
          if (bdx * bdx + bdy * bdy <= hitDist * hitDist) {
            this.damagePlayer(e.damage);
          }
        }
        continue;
      }

      const dx = p.x - e.x;
      const dy = p.y - e.y;
      const distSq = dx * dx + dy * dy;

      // Recycle far-away standard enemies back around the arena edge
      if (distSq > despawnDistSq) {
        const angle = Math.random() * Math.PI * 2;
        const r = Math.hypot(this.viewportWidth * 0.5, this.viewportHeight * 0.5) + 90;
        e.x = p.x + Math.cos(angle) * r;
        e.y = p.y + Math.sin(angle) * r;
        e.aiState = 'normal';
        e.aiTimer = 0;
        continue;
      }

      const dist = Math.sqrt(distSq);
      const immobilized = e.freezeTimer > 0 || e.stunTimer > 0;

      if (!immobilized && dist > 0.01) {
        const def = ENEMIES[e.archetypeId];
        const moveSpd = e.speed * (e.slowTimer > 0 ? e.slowFactor : 1);
        const nx = dx / dist;
        const ny = dy / dist;

        if (def.behavior === 'ranged_kiter' && def.rangedRange) {
          // RANGED KITER (Wisteria Wisp): maintains firing band & telegraphs orb casts
          if (e.aiState === 'windup') {
            e.vx = nx * moveSpd * 0.15;
            e.vy = ny * moveSpd * 0.15;
            e.aiTimer = (e.aiTimer ?? 0) - dt;
            if ((e.aiTimer ?? 0) <= 0) {
              e.aiState = 'normal';
              e.rangedCooldown = (def.rangedCooldown ?? 2.6) * (0.9 + Math.random() * 0.2);
              const projSpd = def.projectileSpeed ?? 185;
              this.enemyProjectiles.push({
                x: e.x,
                y: e.y,
                vx: nx * projSpd,
                vy: ny * projSpd,
                radius: 7,
                damage: e.damage,
                life: 0,
                maxLife: 2.8,
                color: PALETTE.lavender,
              });
              this.spawnParticles(e.x, e.y, PALETTE.lavenderLight, 4, {
                speedMin: 25,
                speedMax: 80,
                sizeMin: 2,
                sizeMax: 4,
              });
            }
          } else {
            if (dist > def.rangedRange) {
              e.vx = nx * moveSpd;
              e.vy = ny * moveSpd;
            } else if (dist < def.rangedRange * 0.7) {
              e.vx = -nx * moveSpd * 0.65;
              e.vy = -ny * moveSpd * 0.65;
            } else {
              const strafeDir = e.id % 2 === 0 ? 1 : -1;
              e.vx = -ny * moveSpd * 0.6 * strafeDir;
              e.vy = nx * moveSpd * 0.6 * strafeDir;
            }

            e.rangedCooldown -= dt;
            if (e.rangedCooldown <= 0 && dist <= def.rangedRange * 1.35) {
              e.aiState = 'windup';
              e.aiTimer = 0.36;
            }
          }
        } else if (def.behavior === 'chase_tank') {
          // SLOW BRUTE (Porcelain Golem): relentless heavy march + short telegraphed shoulder lunge
          e.aiCooldown = Math.max(0, (e.aiCooldown ?? 0) - dt);
          if (e.aiState === 'windup') {
            e.vx = 0;
            e.vy = 0;
            e.aiTimer = (e.aiTimer ?? 0) - dt;
            if ((e.aiTimer ?? 0) <= 0) {
              e.aiState = 'lunge';
              e.aiTimer = 0.32;
              e.lungeDirX = nx;
              e.lungeDirY = ny;
              this.spawnParticles(e.x, e.y + 8, PALETTE.peach, 5, {
                speedMin: 30,
                speedMax: 95,
              });
            }
          } else if (e.aiState === 'lunge') {
            const lx = e.lungeDirX ?? nx;
            const ly = e.lungeDirY ?? ny;
            e.vx = lx * moveSpd * 1.85;
            e.vy = ly * moveSpd * 1.85;
            e.aiTimer = (e.aiTimer ?? 0) - dt;
            if ((e.aiTimer ?? 0) <= 0) {
              e.aiState = 'normal';
              e.aiCooldown = 4.6;
            }
          } else {
            e.vx = nx * moveSpd;
            e.vy = ny * moveSpd;
            if (dist < 125 && (e.aiCooldown ?? 0) <= 0) {
              e.aiState = 'windup';
              e.aiTimer = 0.38;
            }
          }
        } else {
          // FAST SWARMERS (Mochi Slime & Mini Mochi): energetic flanking weave & close-range surge
          const weave = Math.sin(e.walkTime * 3.8 + e.id * 1.7) * 0.28;
          const surge = dist < 175 ? 1.12 : 1.0;
          const mvx = nx - ny * weave;
          const mvy = ny + nx * weave;
          const mLen = Math.hypot(mvx, mvy) || 1;
          e.vx = (mvx / mLen) * moveSpd * surge;
          e.vy = (mvy / mLen) * moveSpd * surge;
        }

        e.walkTime += dt;
        if (Math.abs(nx) > 0.08) {
          e.facingLeft = nx < 0;
        }
      } else {
        e.vx = 0;
        e.vy = 0;
      }

      // Apply movement + damped knockback
      e.x += (e.vx + e.kbVx) * dt;
      e.y += (e.vy + e.kbVy) * dt;
      e.kbVx *= kbDecay;
      e.kbVy *= kbDecay;

      // Contact damage check with player
      const hitDist = p.radius + e.radius - 2;
      if (distSq <= hitDist * hitDist) {
        this.damagePlayer(e.damage);
      }
    }
  }

  /**
   * Mass-aware circle separation powered by the 64px spatial hash.
   * Swarmers spread cleanly around packs; heavy brutes resist displacement;
   * bosses act as immovable anchors (and skip separation while airborne).
   */
  private resolveEnemySeparation(): void {
    const items = this.enemies;
    const neighbors = this.sepQueryBuf;
    const strength = 0.42;

    for (let i = 0; i < items.length; i++) {
      const a = items[i];
      if (!a.alive) continue;
      if (a.isBoss && this.bossAI.isAirborne(a.id)) continue;

      const invMassA = a.isBoss ? 0 : a.archetypeId === 'golem' ? 0.35 : 1.0;
      this.spatialHash.queryRadius(a.x, a.y, a.radius * 2.2, neighbors);

      for (let j = 0; j < neighbors.length; j++) {
        const b = neighbors[j];
        if (!b.alive || a.id >= b.id) continue;
        if (b.isBoss && this.bossAI.isAirborne(b.id)) continue;

        const invMassB = b.isBoss ? 0 : b.archetypeId === 'golem' ? 0.35 : 1.0;
        const totalInvMass = invMassA + invMassB;
        if (totalInvMass <= 0) continue;

        const minDist = a.radius + b.radius;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const distSq = dx * dx + dy * dy;

        if (distSq < minDist * minDist) {
          const shareA = invMassA / totalInvMass;
          const shareB = invMassB / totalInvMass;
          if (distSq > 0.0001) {
            const dist = Math.sqrt(distSq);
            const push = (minDist - dist) * strength;
            const nx = dx / dist;
            const ny = dy / dist;
            a.x += nx * push * shareA;
            a.y += ny * push * shareA;
            b.x -= nx * push * shareB;
            b.y -= ny * push * shareB;
          } else {
            const angle = (a.id * 1.61803398875) % (Math.PI * 2);
            const nudge = minDist * 0.25 * strength;
            a.x += Math.cos(angle) * nudge * shareA;
            a.y += Math.sin(angle) * nudge * shareA;
            b.x -= Math.cos(angle) * nudge * shareB;
            b.y -= Math.sin(angle) * nudge * shareB;
          }
        }
      }
    }
  }

  private updateEnemyProjectiles(dt: number): void {
    const p = this.player;
    for (let i = this.enemyProjectiles.length - 1; i >= 0; i--) {
      const proj = this.enemyProjectiles[i];
      proj.life += dt;
      if (proj.life >= proj.maxLife) {
        this.enemyProjectiles.splice(i, 1);
        continue;
      }

      proj.x += proj.vx * dt;
      proj.y += proj.vy * dt;

      const dx = p.x - proj.x;
      const dy = p.y - proj.y;
      const hitR = p.radius + proj.radius;
      if (dx * dx + dy * dy <= hitR * hitR) {
        this.damagePlayer(proj.damage);
        this.spawnParticles(proj.x, proj.y, proj.color, 5, { speedMin: 30, speedMax: 90 });
        this.enemyProjectiles.splice(i, 1);
      }
    }
  }

  private updatePickups(dt: number): void {
    const p = this.player;
    const pickupRadius = this.computedStats.pickupRadius;
    const pickupRadiusSq = pickupRadius * pickupRadius;
    const drag = Math.exp(-7 * dt);

    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const item = this.pickups[i];
      item.age += dt;

      const dx = p.x - item.x;
      const dy = p.y - item.y;
      const distSq = dx * dx + dy * dy;

      const isXp = item.kind.startsWith('xp_');
      if (!item.magnetized) {
        const attractSq = isXp ? pickupRadiusSq : (pickupRadius * 0.65) ** 2;
        if (distSq <= attractSq && item.kind !== 'chest') {
          item.magnetized = true;
        }
      }

      if (item.magnetized && distSq > 0.01) {
        const dist = Math.sqrt(distSq);
        const pullSpd = Math.min(720, 320 + item.age * 240);
        item.vx = (dx / dist) * pullSpd;
        item.vy = (dy / dist) * pullSpd;
        item.x += item.vx * dt;
        item.y += item.vy * dt;
      } else {
        item.x += item.vx * dt;
        item.y += item.vy * dt;
        item.vx *= drag;
        item.vy *= drag;
      }

      const collectR = p.radius + (item.kind === 'chest' ? item.radius + 10 : 14);
      const postDx = p.x - item.x;
      const postDy = p.y - item.y;
      if (postDx * postDx + postDy * postDy <= collectR * collectR) {
        this.collectPickup(item);
        this.pickups.splice(i, 1);
      }
    }
  }

  private collectPickup(item: PickupEntity): void {
    const p = this.player;

    if (item.kind === 'xp_small' || item.kind === 'xp_medium' || item.kind === 'xp_large') {
      const gained = Math.max(1, Math.round(item.value * this.computedStats.xpGainMult));
      p.xp += gained;

      const tier: 1 | 2 | 3 =
        item.kind === 'xp_large' ? 3 : item.kind === 'xp_medium' ? 2 : 1;
      this.audio.playXp(tier);
      this.spawnParticles(item.x, item.y, PALETTE.mintLight, 4, {
        speedMin: 25,
        speedMax: 75,
        sizeMin: 2,
        sizeMax: 4,
      });

      let leveled = false;
      while (p.xp >= xpNeeded(p.level)) {
        p.xp -= xpNeeded(p.level);
        p.level += 1;
        this.pendingLevelUps += 1;
        leveled = true;
      }

      if (leveled) {
        this.audio.playLevelUp();
        this.spawnRingParticle(p.x, p.y, PALETTE.butter, 96, 0.42);
        this.spawnParticles(p.x, p.y, PALETTE.butter, 18, { speedMin: 70, speedMax: 190 });
        this.spawnFloatingText(p.x, p.y - 30, `LEVEL ${p.level}!`, PALETTE.butter, true);

        if (this.state === 'playing' && this.pendingLevelUps > 0) {
          this.pendingLevelUps--;
          this.openNextLevelUp();
        }
      }
      return;
    }

    if (item.kind === 'heart') {
      this.audio.playPickup();
      this.healPlayer(Math.round(p.maxHp * 0.25));
      this.spawnParticles(item.x, item.y, PALETTE.rose, 12, { speedMin: 40, speedMax: 130 });
      return;
    }

    if (item.kind === 'magnet') {
      this.audio.playPickup();
      for (let i = 0; i < this.pickups.length; i++) {
        if (this.pickups[i].kind.startsWith('xp_')) {
          this.pickups[i].magnetized = true;
        }
      }
      this.spawnRingParticle(p.x, p.y, PALETTE.periwinkle, 160, 0.45);
      this.spawnFloatingText(p.x, p.y - 28, 'MAGNET!', PALETTE.periwinkle, true);
      return;
    }

    if (item.kind === 'chest') {
      this.healPlayer(Math.round(p.maxHp * 0.35));
      this.spawnRingParticle(p.x, p.y, PALETTE.butter, 130, 0.5);
      this.spawnParticles(p.x, p.y, PALETTE.butter, 22, { speedMin: 60, speedMax: 200 });
      this.spawnFloatingText(p.x, p.y - 36, 'BOSS CHEST!', PALETTE.butter, true);

      const ownedSet = new Set(this.ownedArtifacts);
      const available = getAvailableBossArtifacts(p.heroId, ownedSet);
      this.pendingArtifactChoices = available;

      if (this.callbacks.onBossChestCollected) {
        this.audio.playSynergy();
        this.setState('artifact');
        this.callbacks.onBossChestCollected(available);
      } else if (available.length > 0) {
        // Standalone fallback when no UI modal callback is attached
        this.grantArtifact(available[0].id);
      }
    }
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

    if (this.state === 'menu') {
      return;
    }

    // 2. Ground-level combat effects & boss telegraphs (under entities so hero stays clear)
    this.abilityRunner.renderGroundLayer(ctx, toScreen, this.sprites);
    this.bossAI.renderGroundTelegraphs(ctx, this.enemies, toScreen);

    // 3. Pickups (XP gems, Pastel Hearts, Magnet Orbs, Boss Chests)
    this.renderPickups(ctx);

    // 4. Enemies & Bosses
    this.renderEnemies(ctx);

    // 5. Player
    this.renderPlayer(ctx);

    // 6. Foreground combat visuals & ignited boss beams
    this.abilityRunner.renderForegroundLayer(
      ctx,
      this.player.x,
      this.player.y,
      toScreen,
      this.sprites
    );
    this.bossAI.renderForegroundEffects(ctx, this.enemies, toScreen);

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
    if (this.state === 'playing' && this.input.getAimMode() === 'mouse' && this.input.hasMousePosition()) {
      this.renderMouseReticle(ctx);
    }

    if (this.state === 'playing') {
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
    for (let i = 0; i < this.pickups.length; i++) {
      const item = this.pickups[i];
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

      // Soft pulsing beacon under rare drops & Boss Chests
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

      // Ground shadow
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
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
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

      const bossVis = e.isBoss ? this.bossAI.getVisualState(e.id) : null;
      const jumpHeight = bossVis ? bossVis.jumpHeight : 0;
      const shadowScale = Math.max(0.45, 1 - jumpHeight / 220);

      // Ground shadow (shrinks dynamically while King Mochi leaps high)
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

      // Enraged pastel aura ring beneath Bosses in Phase 2
      if (bossVis && bossVis.enraged) {
        const pulse = 0.5 + 0.5 * Math.sin(this.elapsedRunSec * 8);
        ctx.save();
        ctx.globalAlpha = 0.28 + pulse * 0.16;
        ctx.strokeStyle = bossVis.accentColor;
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        ctx.arc(screen.x, screen.y - jumpHeight, e.radius + 10 + pulse * 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // Standard enemy attack telegraphs (Wisp charge & Golem lunge brace)
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

      // Sprite with hit flash silhouette (supports Boss leap height + squash/stretch)
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

      // Freeze / Stun status overlays
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
      } else if (e.stunTimer > 0) {
        ctx.save();
        ctx.strokeStyle = PALETTE.butter;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(screen.x, screen.y - e.radius - 6, 6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // World-space Boss HP bar & title plate beneath active Bosses
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
        // Compact HP bar above damaged standard enemies
        const bw = 26;
        const bh = 4;
        const bx = Math.round(screen.x - bw / 2);
        const by = Math.round(screen.y - e.radius - 12);
        const ratio = Math.max(0, Math.min(1, e.hp / e.maxHp));
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
    for (let i = 0; i < this.enemyProjectiles.length; i++) {
      const proj = this.enemyProjectiles[i];
      const screen = this.worldToScreen(proj.x, proj.y);
      if (
        screen.x < -pad ||
        screen.x > this.viewportWidth + pad ||
        screen.y < -pad ||
        screen.y > this.viewportHeight + pad
      ) {
        continue;
      }

      // Color-coded pastel aura so each boss/wisp orb family reads clearly
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

    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (e.alive && e.isBoss && e.bossId) {
        drawPointer(e.x, e.y, BOSSES[e.bossId].accentColor, 'BOSS');
      }
    }

    for (let i = 0; i < this.pickups.length; i++) {
      const item = this.pickups[i];
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

  private renderPlayer(ctx: CanvasRenderingContext2D): void {
    const p = this.player;
    const screen = this.worldToScreen(p.x, p.y);
    const walkFrame = p.isMoving ? Math.floor(p.walkTime * 7) % 2 : 0;
    const bobOffset = p.isMoving && walkFrame === 1 ? -2 : 0;

    // Retribution Aegis active buff aura
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

    // Ground contact shadow
    ctx.fillStyle = PALETTE.shadow;
    ctx.beginPath();
    ctx.ellipse(screen.x, screen.y + 20, 14, 6, 0, 0, Math.PI * 2);
    ctx.fill();

    // 16x16 Hero sprite (flashes cream on hit)
    drawPixelSprite(
      ctx,
      this.sprites.heroes[p.heroId][walkFrame],
      screen.x,
      screen.y + bobOffset,
      PIXEL_SCALE,
      p.facingLeft,
      p.hitFlashTimer > 0
    );

    // Compact pastel HP bar directly beneath hero
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
export type { BossActiveInfo };
