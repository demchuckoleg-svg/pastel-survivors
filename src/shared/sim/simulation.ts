import { ABILITIES, getAbilityDef } from '../data/abilities';
import { getArtifactDef, getAvailableBossArtifacts } from '../data/artifacts';
import {
  CLASSES,
  MAX_ABILITY_LEVEL,
  MAX_ACTIVE_ABILITY_SLOTS,
} from '../data/classes';
import {
  BOSS_SPAWN_INTERVAL_MIN,
  BOSSES,
  COOP_BOSS_SPAWN_INTERVAL_MIN,
  COOP_PACE_TIME_SCALE,
  ENEMIES,
  getBossForEncounter,
  pickWaveArchetype,
  scaledBossHP,
  scaledEnemyHP,
  scaledEnemyXP,
  scaledSpawnRate,
  xpNeeded,
} from '../data/enemies';
import { PALETTE } from '../data/palette';
import { getSynergyDef } from '../data/synergies';
import type {
  AbilityId,
  ArtifactDef,
  ArtifactId,
  BossId,
  EnemySpriteId,
  HeroId,
  PickupSpriteId,
  SynergyDef,
  SynergyId,
} from '../data/types';
import { AbilityRunner, type CombatContext } from './abilityRunner';
import {
  BossAIManager,
  getBossDamageScale,
  getBossScaledHp,
  type BossAIContext,
} from './bossAI';
import type { SimEvent } from './events';
import {
  buildComputedStats,
  generateBossArtifactChoicesForPlayer,
  generateLevelUpChoicesForPlayer,
  getAvailableSynergyEvolutionsForPlayer,
  refreshPendingChoiceBatch,
} from './progression';
import { createRng, type RngSource } from './rng';
import { SpatialHash } from './spatialHash';
import {
  EnemyStateFlag,
  PlayerStateFlag,
  type ActiveAbilitySlot,
  type BossActiveInfo,
  type DamageOptions,
  type EnemyEntity,
  type EnemyProjectile,
  type EnemySnapshot,
  type GameState,
  type GlobalPassiveEntry,
  type LevelUpChoice,
  type ParticleBurstOptions,
  type PendingChoiceBatch,
  type PendingChoiceSource,
  type PersonalUpgradePayload,
  type PickupEntity,
  type PickupSnapshot,
  type PlayerId,
  type PlayerInput,
  type PlayerSnapshot,
  type PlayerState,
  type RoomMode,
  type RoomPaceMode,
  type RoomSnapshot,
  type RunStatsSnapshot,
  type UpgradeChoiceIndex,
} from './types';

export const DEFAULT_LOCAL_PLAYER_ID: PlayerId = 'local';
export const MAX_PLAYERS = 4;
export const MAX_ENEMIES = 650;
export const MAX_PICKUPS = 400;

export const REVIVE_CIRCLE_RADIUS = 72;
export const REVIVE_DURATION_SEC = 10.0;
export const REVIVE_HP_RATIO = 0.2;
export const BOSS_KILL_REVIVE_HP_RATIO = 0.5;
export const REVIVE_INVULN_SEC = 2.0;
export const GHOST_DRIFT_SPEED_MULT = 0.35;

export interface PlayerInitConfig {
  id: PlayerId;
  heroId: HeroId;
}

export interface StartRunOptions {
  seed?: number;
  mode?: RoomMode;
  paceMode?: RoomPaceMode;
  /** When true (default in co-op), level-ups & Boss Chests queue asynchronously without pausing the room. */
  asyncLevelUps?: boolean;
}

export interface OverflowMultipliers {
  hpMult: number;
  xpMult: number;
  eliteChance: number;
}

/**
 * Pure headless game simulation for Pastel Survivors.
 *
 * - Supports 1 player (Solo Offline) or up to 4 players (Co-op).
 * - Zero browser, DOM, Canvas, or Web Audio dependencies.
 * - Emits lightweight typed `SimEvent` objects every tick for the client
 *   renderer/audio/UI layers or authoritative co-op server to consume.
 */
export class GameSimulation {
  public readonly spatialHash: SpatialHash<EnemyEntity>;
  public readonly bossAI: BossAIManager;

  public readonly players = new Map<PlayerId, PlayerState>();
  public readonly abilityRunners = new Map<PlayerId, AbilityRunner>();

  public enemies: EnemyEntity[] = [];
  public enemyProjectiles: EnemyProjectile[] = [];
  public pickups: PickupEntity[] = [];

  private rng: RngSource;
  private state: GameState = 'menu';
  private mode: RoomMode = 'solo';
  private paceMode: RoomPaceMode = 'standard';
  private asyncLevelUps = false;
  private tickCount = 0;
  private elapsedRunSec = 0;

  // Reference viewport / arena dimensions used for wave spawn & recycle rings
  private arenaWidth = 1280;
  private arenaHeight = 720;

  // Wave director & run counters
  private nextEnemyId = 1;
  private nextPickupId = 1;
  private nextChoiceBatchId = 1;
  private nextProjectileNetId = 1;
  private readonly replicatedEnemyProjectiles = new Map<number, EnemyProjectile>();
  private readonly seenEnemyProjIdsBuf = new Set<number>();
  private spawnAccumulator = 0;
  private overflowSpawnPressure = 0;
  private nextBossEncounterIndex = 0;
  private nextSwarmWaveSec = 45;
  private kills = 0;
  private bossesDefeated = 0;

  // Reusable buffers
  private readonly sepQueryBuf: EnemyEntity[] = [];
  private readonly tauntQueryBuf: EnemyEntity[] = [];
  private events: SimEvent[] = [];

  constructor(seed?: number) {
    this.rng = createRng(seed);
    this.spatialHash = new SpatialHash<EnemyEntity>(64);
    this.bossAI = new BossAIManager();

    // Initialize a default solo local player so UI/menu queries always have a valid player
    this.createPlayerState(DEFAULT_LOCAL_PLAYER_ID, 'mage');
  }

  // ==========================================================================
  // PUBLIC ACCESSORS
  // ==========================================================================

  public getState(): GameState {
    return this.state;
  }

  public setState(next: GameState): void {
    this.state = next;
  }

  public getMode(): RoomMode {
    return this.mode;
  }

  public getPaceMode(): RoomPaceMode {
    return this.paceMode;
  }

  public setPaceMode(paceMode: RoomPaceMode): void {
    this.paceMode = paceMode;
  }

  public isAsyncLevelUps(): boolean {
    return this.asyncLevelUps;
  }

  public getTickCount(): number {
    return this.tickCount;
  }

  public getElapsedRunSec(): number {
    return this.elapsedRunSec;
  }

  public getEffectiveMinutes(): number {
    const rawMinutes = this.elapsedRunSec / 60;
    return this.paceMode === 'coop_pace' ? rawMinutes * COOP_PACE_TIME_SCALE : rawMinutes;
  }

  public getBossSpawnIntervalSec(): number {
    const intervalMin =
      this.paceMode === 'coop_pace' ? COOP_BOSS_SPAWN_INTERVAL_MIN : BOSS_SPAWN_INTERVAL_MIN;
    return intervalMin * 60;
  }

  public getPlayerCount(): number {
    return Math.max(1, this.players.size);
  }

  public getOverflowPressure(): number {
    return this.overflowSpawnPressure;
  }

  public getOverflowMultipliers(): OverflowMultipliers {
    const ratio = Math.min(1, Math.max(0, this.overflowSpawnPressure) / 50);
    return {
      hpMult: 1 + ratio * 0.35,
      xpMult: 1 + ratio * 0.45,
      eliteChance: ratio * 0.25,
    };
  }

  public getKills(): number {
    return this.kills;
  }

  public getBossesDefeated(): number {
    return this.bossesDefeated;
  }

  public setArenaViewport(width: number, height: number): void {
    if (width > 0 && height > 0) {
      this.arenaWidth = width;
      this.arenaHeight = height;
    }
  }

  public getArenaViewport(): { width: number; height: number } {
    return { width: this.arenaWidth, height: this.arenaHeight };
  }

  public getPlayer(playerId: PlayerId = DEFAULT_LOCAL_PLAYER_ID): PlayerState | undefined {
    return this.players.get(playerId);
  }

  public getPrimaryPlayer(): PlayerState {
    const local = this.players.get(DEFAULT_LOCAL_PLAYER_ID);
    if (local) return local;
    const first = this.players.values().next().value;
    if (!first) {
      return this.createPlayerState(DEFAULT_LOCAL_PLAYER_ID, 'mage');
    }
    return first;
  }

  public getPlayers(): PlayerState[] {
    return Array.from(this.players.values());
  }

  public getAlivePlayers(): PlayerState[] {
    const alive: PlayerState[] = [];
    for (const p of this.players.values()) {
      if (p.alive && !p.downed) alive.push(p);
    }
    return alive;
  }

  public getAbilityRunner(playerId: PlayerId = DEFAULT_LOCAL_PLAYER_ID): AbilityRunner | undefined {
    return this.abilityRunners.get(playerId);
  }

  public getActiveBoss(): EnemyEntity | null {
    for (let i = 0; i < this.enemies.length; i++) {
      if (this.enemies[i].isBoss && this.enemies[i].alive) {
        return this.enemies[i];
      }
    }
    return null;
  }

  public getActiveBosses(): EnemyEntity[] {
    return this.enemies.filter((e) => e.isBoss && e.alive);
  }

  public getActiveBossInfo(): BossActiveInfo | null {
    const boss = this.getActiveBoss();
    if (!boss) return null;
    const info = this.bossAI.getBossInfo(boss);
    if (!info) return null;

    // Shared Boss HP bar for The Twin Macarons duo encounter
    if (boss.bossId === 'twin_macaron_mint' || boss.bossId === 'twin_macaron_rose') {
      const partner = boss.linkedBossId
        ? this.enemies.find((e) => e.id === boss.linkedBossId && e.alive)
        : undefined;
      if (partner) {
        return {
          ...info,
          name: 'The Twin Macarons',
          title: 'Mint & Rose Patisserie Duo',
          hp: Math.max(0, boss.hp) + Math.max(0, partner.hp),
          maxHp: boss.maxHp + partner.maxHp,
        };
      }
      return {
        ...info,
        name: boss.bossId === 'twin_macaron_mint' ? 'Mint Macaron' : 'Rose Macaron',
      };
    }

    return info;
  }

  public getNextBossCountdownSec(): number {
    const nextSec = (this.nextBossEncounterIndex + 1) * this.getBossSpawnIntervalSec();
    return Math.max(0, nextSec - this.elapsedRunSec);
  }

  public getRunStatsSnapshot(playerId?: PlayerId): RunStatsSnapshot {
    const p = this.resolvePlayer(playerId);
    return {
      elapsedRunSec: this.elapsedRunSec,
      level: p.level,
      xp: p.xp,
      xpToNext: p.xpToNext,
      kills: this.kills,
      bossesDefeated: this.bossesDefeated,
    };
  }

  /**
   * Produces a broadcast-ready authoritative room snapshot for co-op clients,
   * including per-player `xp`, `xpToNext`, `level`, `revivePct`, `stateFlags`,
   * `pendingQueueCount`, and shared enemy debuff flags (`chilled`, `tauntTargetId`, `isElite`).
   */
  public getRoomSnapshot(): RoomSnapshot {
    const players: PlayerSnapshot[] = [];
    for (const p of this.players.values()) {
      players.push({
        id: p.id,
        heroId: p.heroId,
        x: p.x,
        y: p.y,
        vx: p.vx,
        vy: p.vy,
        hp: p.hp,
        maxHp: p.maxHp,
        xp: p.xp,
        xpToNext: p.xpToNext,
        level: p.level,
        facingLeft: p.facingLeft,
        aimAngle: p.aimAngle,
        alive: p.alive,
        downed: p.downed,
        revivePct: p.revivePct,
        invulnTimer: p.invulnTimer,
        stateFlags: p.stateFlags,
        pendingQueueCount: p.pendingQueueCount,
      });
    }

    const enemies: EnemySnapshot[] = [];
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (!e.alive) continue;
      enemies.push({
        id: e.id,
        archetypeId: e.archetypeId,
        bossId: e.bossId,
        isBoss: e.isBoss,
        isElite: e.isElite,
        x: e.x,
        y: e.y,
        hp: e.hp,
        maxHp: e.maxHp,
        radius: e.radius,
        facingLeft: e.facingLeft,
        chilled: e.chilled,
        tauntTargetId: e.tauntTargetId,
        stateFlags: e.stateFlags,
      });
    }

    const pickups: PickupSnapshot[] = [];
    for (let i = 0; i < this.pickups.length; i++) {
      const item = this.pickups[i];
      pickups.push({
        id: item.id,
        kind: item.kind,
        x: item.x,
        y: item.y,
        value: item.value,
      });
    }

    return {
      tick: this.tickCount,
      elapsedRunSec: this.elapsedRunSec,
      mode: this.mode,
      paceMode: this.paceMode,
      state: this.state,
      playerCount: this.players.size,
      enemyCount: enemies.length,
      enemyCap: MAX_ENEMIES,
      overflowPressure: this.overflowSpawnPressure,
      kills: this.kills,
      bossesDefeated: this.bossesDefeated,
      nextBossCountdownSec: this.getNextBossCountdownSec(),
      players,
      enemies,
      pickups,
      activeBoss: this.getActiveBossInfo(),
    };
  }

  /**
   * Returns the private upgrade draft payload for a specific player if they have
   * an open choice batch, or `null` if their personal queue is empty.
   */
  public getPersonalUpgradePayload(playerId: PlayerId): PersonalUpgradePayload | null {
    const p = this.players.get(playerId);
    if (!p || p.pendingChoiceQueue.length === 0) return null;
    const head = p.pendingChoiceQueue[0];
    return {
      playerId: p.id,
      batchId: head.id,
      source: head.source,
      choices: head.choices,
      pendingQueueCount: p.pendingQueueCount,
    };
  }

  public getAbilityLevel(abilityId: AbilityId, playerId?: PlayerId): number {
    const p = this.resolvePlayer(playerId);
    const slot = p.activeSlots.find((s) => s.kind === 'ability' && s.id === abilityId);
    return slot ? slot.level : 0;
  }

  public drainEvents(): SimEvent[] {
    if (this.events.length === 0) return [];
    const out = this.events;
    this.events = [];
    return out;
  }

  private emit(event: SimEvent): void {
    this.events.push(event);
  }

  private resolvePlayer(playerId?: PlayerId): PlayerState {
    if (playerId) {
      const found = this.players.get(playerId);
      if (found) return found;
    }
    return this.getPrimaryPlayer();
  }

  private createPlayerState(id: PlayerId, heroId: HeroId): PlayerState {
    const base = CLASSES[heroId].baseStats;
    const player: PlayerState = {
      id,
      heroId,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      speed: base.moveSpeed,
      radius: 14,
      hp: base.maxHp,
      maxHp: base.maxHp,
      xp: 0,
      xpToNext: xpNeeded(1),
      level: 1,
      facingLeft: false,
      aimAngle: 0,
      aimMode: 'auto',
      walkTime: 0,
      isMoving: false,
      invulnTimer: 0,
      hitFlashTimer: 0,
      retributionBuffTimer: 0,
      shieldHp: 0,
      shieldTimer: 0,
      hasteBuffTimer: 0,
      starlightBuffTimer: 0,
      sharedCdAuraTimer: 0,
      totemRegenTimer: 0,
      alive: true,
      downed: false,
      reviveProgressSec: 0,
      revivePct: 0,
      stateFlags: PlayerStateFlag.NONE,
      activeSlots: [],
      consumedAbilities: new Set<AbilityId>(),
      ownedSynergies: new Set<SynergyId>(),
      ownedArtifacts: [],
      globalPassives: [],
      computedStats: {
        maxHp: base.maxHp,
        moveSpeed: base.moveSpeed,
        pickupRadius: base.pickupRadius,
        armor: base.armor,
        critChance: base.critChance,
        critMultiplier: base.critMultiplier,
        hpRegen: base.hpRegen,
        damageMult: 1,
        cooldownMult: 1,
        areaMult: 1,
        xpGainMult: 1,
        knockbackMult: 1,
        projectileBonus: 0,
        pierceBonus: 0,
        hasDoubleCast: false,
        hasRetributionAegis: false,
        hasAuraRadiusBoost: false,
        hasOverhealToShield: false,
        hasSharedCooldownAura: false,
      },
      masteryCount: 0,
      pendingLevelUps: 0,
      pendingChoiceQueue: [],
      pendingQueueCount: 0,
      pendingChoices: [],
      pendingArtifactChoices: [],
    };
    this.players.set(id, player);
    this.abilityRunners.set(id, new AbilityRunner());
    return player;
  }

  /**
   * Removes a disconnected player from an active room and checks if all
   * remaining connected players are downed.
   */
  public removePlayer(playerId: PlayerId): SimEvent[] {
    const runner = this.abilityRunners.get(playerId);
    if (runner && this.mode === 'coop') {
      const stale = runner.drainReplicatedProjectiles();
      for (let i = 0; i < stale.length; i++) {
        this.emit({
          type: 'ProjectileDespawned',
          netId: stale[i].netId,
          x: stale[i].x,
          y: stale[i].y,
        });
      }
    }
    this.players.delete(playerId);
    this.abilityRunners.delete(playerId);

    // Clear any enemy taunts pointing at the removed player
    for (let i = 0; i < this.enemies.length; i++) {
      if (this.enemies[i].tauntTargetId === playerId) {
        this.enemies[i].tauntTargetId = null;
        this.enemies[i].tauntTimer = 0;
        this.syncEnemyStateFlags(this.enemies[i]);
      }
    }

    if (this.state === 'playing' && this.players.size > 0 && this.getAlivePlayers().length === 0) {
      this.state = 'gameover';
      this.emit({
        type: 'GameOverTriggered',
        snapshot: this.getRunStatsSnapshot(),
      });
    }

    return this.drainEvents();
  }

  private allocEnemyId(): number {
    const id = this.nextEnemyId;
    this.nextEnemyId = this.nextEnemyId >= 65535 ? 1 : this.nextEnemyId + 1;
    return id;
  }

  private allocProjectileNetId(): number {
    const id = this.nextProjectileNetId;
    this.nextProjectileNetId = this.nextProjectileNetId >= 65535 ? 1 : this.nextProjectileNetId + 1;
    return id;
  }

  // ==========================================================================
  // RUN LIFECYCLE
  // ==========================================================================

  /**
   * Starts a new run for 1 player (HeroId shorthand for Solo) or up to 4 players.
   */
  public startRun(
    config: HeroId | readonly PlayerInitConfig[] = 'mage',
    options: StartRunOptions = {}
  ): SimEvent[] {
    if (options.seed !== undefined) {
      this.rng = createRng(options.seed);
    }

    const roster: readonly PlayerInitConfig[] =
      typeof config === 'string'
        ? [{ id: DEFAULT_LOCAL_PLAYER_ID, heroId: config }]
        : config.slice(0, MAX_PLAYERS);

    this.mode = options.mode ?? (roster.length > 1 ? 'coop' : 'solo');
    this.paceMode = options.paceMode ?? (this.mode === 'coop' ? 'coop_pace' : 'standard');
    this.asyncLevelUps = options.asyncLevelUps ?? this.mode === 'coop';

    this.players.clear();
    this.abilityRunners.clear();
    this.events = [];

    this.tickCount = 0;
    this.elapsedRunSec = 0;
    this.nextEnemyId = 1;
    this.nextPickupId = 1;
    this.nextChoiceBatchId = 1;
    this.nextProjectileNetId = 1;
    this.replicatedEnemyProjectiles.clear();
    this.seenEnemyProjIdsBuf.clear();
    this.spawnAccumulator = 0;
    this.overflowSpawnPressure = 0;
    this.nextBossEncounterIndex = 0;
    this.nextSwarmWaveSec = 45;
    this.kills = 0;
    this.bossesDefeated = 0;

    this.enemies.length = 0;
    this.enemyProjectiles.length = 0;
    this.pickups.length = 0;
    this.spatialHash.clear();
    this.bossAI.reset();

    for (let i = 0; i < roster.length; i++) {
      const entry = roster[i];
      const player = this.createPlayerState(entry.id, entry.heroId);
      if (roster.length > 1) {
        const angle = (Math.PI * 2 * i) / roster.length;
        player.x = Math.cos(angle) * 48;
        player.y = Math.sin(angle) * 48;
      }
      this.recomputeStats(player, false);
      const classDef = CLASSES[entry.heroId];
      this.acquireOrUpgradeAbility(classDef.startingAbilityId, player.id);
    }

    this.state = 'playing';
    return this.drainEvents();
  }

  // ==========================================================================
  // 6-SLOT CAP, GLOBAL PASSIVE LEDGER & SYNERGY EVOLUTION
  // ==========================================================================

  public canAcquireNewAbility(abilityId: AbilityId, playerId?: PlayerId): boolean {
    const p = this.resolvePlayer(playerId);
    if (p.consumedAbilities.has(abilityId)) return false;
    if (p.activeSlots.some((s) => s.kind === 'ability' && s.id === abilityId)) {
      return false;
    }
    return p.activeSlots.length < MAX_ACTIVE_ABILITY_SLOTS;
  }

  public acquireOrUpgradeAbility(abilityId: AbilityId, playerId?: PlayerId): boolean {
    const p = this.resolvePlayer(playerId);
    if (p.consumedAbilities.has(abilityId)) return false;

    const def = getAbilityDef(abilityId);
    const existing = p.activeSlots.find(
      (s) => s.kind === 'ability' && s.id === abilityId
    );

    if (existing) {
      if (existing.level >= MAX_ABILITY_LEVEL) return false;
      existing.level += 1;

      if (existing.level === 5) {
        this.recordGlobalPassive(p, {
          id: def.lv5Passive.id,
          sourceType: 'ability_lv5',
          sourceId: def.id,
          sourceName: `${def.name} Lv 5`,
          label: def.lv5Passive.label,
          modifiers: def.lv5Passive.modifiers,
        });
      } else if (existing.level === 10) {
        this.recordGlobalPassive(p, {
          id: def.lv10Passive.id,
          sourceType: 'ability_lv10',
          sourceId: def.id,
          sourceName: `${def.name} Lv 10`,
          label: def.lv10Passive.label,
          modifiers: def.lv10Passive.modifiers,
        });
      }

      this.recomputeStats(p, true);
      return true;
    }

    if (p.activeSlots.length >= MAX_ACTIVE_ABILITY_SLOTS) {
      return false;
    }

    p.activeSlots.push({
      kind: 'ability',
      id: abilityId,
      level: 1,
      cooldownTimer: 0.08,
    });
    this.recomputeStats(p, true);
    return true;
  }

  public getAvailableSynergyEvolutions(playerId?: PlayerId): SynergyDef[] {
    const p = this.resolvePlayer(playerId);
    return getAvailableSynergyEvolutionsForPlayer(p);
  }

  public evolveSynergy(synergyId: SynergyId, playerId?: PlayerId): boolean {
    const p = this.resolvePlayer(playerId);
    if (p.ownedSynergies.has(synergyId)) return false;

    const syn = getSynergyDef(synergyId);
    const [reqA, reqB] = syn.requires;

    const idxA = p.activeSlots.findIndex(
      (s) => s.kind === 'ability' && s.id === reqA && s.level >= MAX_ABILITY_LEVEL
    );
    const idxB = p.activeSlots.findIndex(
      (s) => s.kind === 'ability' && s.id === reqB && s.level >= MAX_ABILITY_LEVEL
    );
    if (idxA === -1 || idxB === -1) return false;

    // Guarantee both components' Lv 5 & Lv 10 passives remain preserved in the ledger
    for (const compId of [reqA, reqB] as const) {
      const compDef = ABILITIES[compId];
      this.recordGlobalPassive(p, {
        id: compDef.lv5Passive.id,
        sourceType: 'ability_lv5',
        sourceId: compDef.id,
        sourceName: `${compDef.name} Lv 5`,
        label: compDef.lv5Passive.label,
        modifiers: compDef.lv5Passive.modifiers,
      });
      this.recordGlobalPassive(p, {
        id: compDef.lv10Passive.id,
        sourceType: 'ability_lv10',
        sourceId: compDef.id,
        sourceName: `${compDef.name} Lv 10`,
        label: compDef.lv10Passive.label,
        modifiers: compDef.lv10Passive.modifiers,
      });
    }

    p.consumedAbilities.add(reqA);
    p.consumedAbilities.add(reqB);
    const runner = this.abilityRunners.get(p.id);
    runner?.clearEffectsForAbility(reqA);
    runner?.clearEffectsForAbility(reqB);

    const insertIdx = Math.min(idxA, idxB);
    p.activeSlots = p.activeSlots.filter(
      (s) => !(s.kind === 'ability' && (s.id === reqA || s.id === reqB))
    );

    const evolvedSlot: ActiveAbilitySlot = {
      kind: 'synergy',
      id: synergyId,
      level: 1,
      cooldownTimer: 0.05,
    };
    p.activeSlots.splice(Math.min(insertIdx, p.activeSlots.length), 0, evolvedSlot);
    p.ownedSynergies.add(synergyId);

    this.recordGlobalPassive(p, {
      id: syn.bonusPassive.id,
      sourceType: 'synergy',
      sourceId: syn.id,
      sourceName: `${syn.name} Synergy`,
      label: syn.bonusPassive.label,
      modifiers: syn.bonusPassive.modifiers,
    });

    this.recomputeStats(p, true);

    this.emit({
      type: 'SynergyEvolved',
      playerId: p.id,
      synergyId: syn.id,
      name: syn.name,
      color: syn.color,
      x: p.x,
      y: p.y,
    });

    return true;
  }

  public grantArtifact(artifactId: ArtifactId, playerId?: PlayerId): SimEvent[] {
    const p = this.resolvePlayer(playerId);
    this.applyArtifactInternal(p, artifactId);

    // If the head queued batch is a boss_chest batch, shift it and advance the queue
    if (p.pendingChoiceQueue.length > 0 && p.pendingChoiceQueue[0].source === 'boss_chest') {
      const chosen =
        p.pendingChoiceQueue[0].choices.find((c) => c.artifactId === artifactId) ??
        p.pendingChoiceQueue[0].choices[0];
      p.pendingChoiceQueue.shift();
      this.advanceChoiceQueueAfterPick(p, chosen);
    } else {
      p.pendingArtifactChoices = [];
      if (!this.asyncLevelUps && this.state === 'artifact') {
        if (p.pendingChoiceQueue.length > 0) {
          this.openHeadBatchForSolo(p);
        } else {
          this.state = 'playing';
        }
      }
      this.syncPlayerChoiceState(p);
    }

    return this.drainEvents();
  }

  private applyArtifactInternal(p: PlayerState, artifactId: ArtifactId): void {
    const def = getArtifactDef(artifactId);
    p.ownedArtifacts.push(artifactId);

    const uniqueId = def.isFallback
      ? `${def.passive.id}_${p.ownedArtifacts.length}`
      : def.passive.id;

    this.recordGlobalPassive(p, {
      id: uniqueId,
      sourceType: 'artifact',
      sourceId: def.id,
      sourceName: def.name,
      label: def.passive.label,
      modifiers: def.passive.modifiers,
    });

    this.recomputeStats(p, true);

    const fullHeal = def.specialEffect === 'full_heal_on_pickup';
    if (fullHeal && !p.downed) {
      p.hp = p.maxHp;
    }

    this.emit({
      type: 'ArtifactGranted',
      playerId: p.id,
      artifactId: def.id,
      name: def.name,
      color: def.color,
      x: p.x,
      y: p.y,
      fullHeal,
    });
  }

  public generateLevelUpChoices(count = 3, playerId?: PlayerId): LevelUpChoice[] {
    const p = this.resolvePlayer(playerId);
    return generateLevelUpChoicesForPlayer(p, this.rng, count);
  }

  /**
   * Handles a player's `PICK_UPGRADE (0 | 1 | 2)` action against their active
   * head choice batch (either a personal level-up or a shared Boss Artifact roll).
   * Applies the upgrade immediately and deals the next queued set of 3 choices if any.
   */
  public pickUpgrade(playerId: PlayerId, choiceIndex: UpgradeChoiceIndex): SimEvent[] {
    const p = this.players.get(playerId);
    if (!p || p.pendingChoiceQueue.length === 0) {
      return this.drainEvents();
    }

    const head = p.pendingChoiceQueue[0];
    if (choiceIndex < 0 || choiceIndex >= head.choices.length) {
      return this.drainEvents();
    }

    const choice = head.choices[choiceIndex];
    this.applySingleChoiceEffect(p, choice);
    p.pendingChoiceQueue.shift();
    this.advanceChoiceQueueAfterPick(p, choice);

    return this.drainEvents();
  }

  public applyLevelUpChoice(choice: LevelUpChoice, playerId?: PlayerId): SimEvent[] {
    const p = this.resolvePlayer(playerId);
    this.applySingleChoiceEffect(p, choice);

    if (p.pendingChoiceQueue.length > 0) {
      p.pendingChoiceQueue.shift();
    }
    this.advanceChoiceQueueAfterPick(p, choice);

    return this.drainEvents();
  }

  private applySingleChoiceEffect(p: PlayerState, choice: LevelUpChoice): void {
    if (choice.kind === 'artifact' && choice.artifactId) {
      this.applyArtifactInternal(p, choice.artifactId);
    } else if (choice.kind === 'synergy' && choice.synergyId) {
      this.evolveSynergy(choice.synergyId, p.id);
    } else if (choice.kind === 'ability' && choice.abilityId) {
      this.acquireOrUpgradeAbility(choice.abilityId, p.id);
    } else if (choice.kind === 'mastery' && choice.masteryModifiers) {
      p.masteryCount++;
      const { projectileBonus: _ignoredProj, ...safeMasteryMods } = choice.masteryModifiers;
      this.recordGlobalPassive(p, {
        id: `${choice.masteryId ?? 'mastery'}_${p.masteryCount}`,
        sourceType: 'mastery',
        sourceId: choice.masteryId ?? 'mastery',
        sourceName: choice.title,
        label: choice.description,
        modifiers: safeMasteryMods,
      });
      this.recomputeStats(p, true);
      if (choice.masteryHeal) {
        this.healPlayer(choice.masteryHeal, p.id);
      }
    }
  }

  private advanceChoiceQueueAfterPick(p: PlayerState, pickedChoice?: LevelUpChoice): void {
    if (p.pendingChoiceQueue.length > 0) {
      // Refresh the newly active batch so all 3 choices reflect the player's latest build
      p.pendingChoiceQueue[0] = refreshPendingChoiceBatch(p, p.pendingChoiceQueue[0], this.rng);
    }

    this.syncPlayerChoiceState(p);

    if (pickedChoice) {
      const nextHead = p.pendingChoiceQueue[0];
      this.emit({
        type: 'UpgradePicked',
        playerId: p.id,
        choice: pickedChoice,
        remainingQueueCount: p.pendingQueueCount,
        nextBatchId: nextHead?.id,
        nextChoices: nextHead ? nextHead.choices : [],
      });
    }

    if (!this.asyncLevelUps) {
      if (p.pendingChoiceQueue.length > 0) {
        this.openHeadBatchForSolo(p);
      } else if (this.state === 'levelup' || this.state === 'artifact') {
        this.state = 'playing';
      }
    }
  }

  private openHeadBatchForSolo(p: PlayerState): void {
    const head = p.pendingChoiceQueue[0];
    if (!head) return;

    if (head.source === 'boss_chest') {
      const artifactDefs: ArtifactDef[] = head.choices
        .filter((c): c is LevelUpChoice & { artifactId: ArtifactId } => Boolean(c.artifactId))
        .map((c) => getArtifactDef(c.artifactId));
      p.pendingArtifactChoices = artifactDefs;
      this.state = 'artifact';
      this.emit({
        type: 'BossChestOpened',
        playerId: p.id,
        x: p.x,
        y: p.y,
        choices: artifactDefs,
        upgradeChoices: head.choices,
        batchId: head.id,
        pendingQueueCount: p.pendingQueueCount,
      });
    } else {
      this.state = 'levelup';
      this.emit({
        type: 'LevelUpTriggered',
        playerId: p.id,
        newLevel: p.level,
        x: p.x,
        y: p.y,
        choices: head.choices,
        batchId: head.id,
        pendingQueueCount: p.pendingQueueCount,
      });
    }
  }

  public grantLevels(levels = 1, playerId?: PlayerId): SimEvent[] {
    const p = this.resolvePlayer(playerId);
    for (let i = 0; i < levels; i++) {
      this.triggerSinglePersonalLevelUp(p);
    }
    return this.drainEvents();
  }

  private triggerSinglePersonalLevelUp(player: PlayerState): void {
    player.level += 1;
    player.xpToNext = xpNeeded(player.level);

    // Immediately roll 3 valid upgrade choices and push into this player's personal queue.
    // No automatic knockback pulse — live drafting remains high-tension.
    const rolled = this.generateLevelUpChoices(3, player.id);
    const { batch, isActive } = this.enqueueChoiceBatch(player, 'levelup', rolled);

    if (!this.asyncLevelUps && this.state === 'playing' && isActive) {
      this.state = 'levelup';
    }

    this.emit({
      type: 'LevelUpTriggered',
      playerId: player.id,
      newLevel: player.level,
      x: player.x,
      y: player.y,
      choices: isActive ? batch.choices : [],
      batchId: batch.id,
      pendingQueueCount: player.pendingQueueCount,
    });
  }

  private enqueueChoiceBatch(
    player: PlayerState,
    source: PendingChoiceSource,
    choices: LevelUpChoice[]
  ): { batch: PendingChoiceBatch; isActive: boolean } {
    const batch: PendingChoiceBatch = {
      id: this.nextChoiceBatchId++,
      source,
      choices,
    };
    const isActive = player.pendingChoiceQueue.length === 0;
    player.pendingChoiceQueue.push(batch);
    this.syncPlayerChoiceState(player);

    this.emit({
      type: 'UpgradeChoicesQueued',
      playerId: player.id,
      batchId: batch.id,
      source,
      choices: batch.choices,
      pendingQueueCount: player.pendingQueueCount,
      isActive,
    });

    return { batch, isActive };
  }

  private syncPlayerChoiceState(player: PlayerState): void {
    const head = player.pendingChoiceQueue[0];
    player.pendingChoices = head ? head.choices : [];
    player.pendingQueueCount = Math.max(0, player.pendingChoiceQueue.length - 1);
    player.pendingLevelUps = player.pendingQueueCount;

    if (head && head.source === 'boss_chest') {
      player.pendingArtifactChoices = head.choices
        .filter((c): c is LevelUpChoice & { artifactId: ArtifactId } => Boolean(c.artifactId))
        .map((c) => getArtifactDef(c.artifactId));
    } else {
      player.pendingArtifactChoices = [];
    }

    this.syncPlayerStateFlags(player);
  }

  private syncPlayerStateFlags(player: PlayerState): void {
    // Preserve transient revive-circle flags; recompute persistent status flags
    let flags =
      player.stateFlags & (PlayerStateFlag.REVIVING_ALLY | PlayerStateFlag.BEING_REVIVED);
    if (player.pendingChoiceQueue.length > 0) {
      flags |= PlayerStateFlag.CHOOSING_UPGRADE;
    }
    if (player.downed) {
      flags |= PlayerStateFlag.DOWNED;
    }
    if (!player.downed && player.invulnTimer > 0) {
      flags |= PlayerStateFlag.INVULNERABLE;
    }
    player.stateFlags = flags;
  }

  private syncEnemyStateFlags(enemy: EnemyEntity): void {
    let flags = EnemyStateFlag.NONE;
    if (enemy.slowTimer > 0) flags |= EnemyStateFlag.CHILLED;
    if (enemy.freezeTimer > 0) flags |= EnemyStateFlag.FROZEN;
    if (enemy.stunTimer > 0) flags |= EnemyStateFlag.STUNNED;
    if (enemy.burnTimer > 0) flags |= EnemyStateFlag.BURNING;
    if (enemy.tauntTimer > 0 && enemy.tauntTargetId !== null) flags |= EnemyStateFlag.TAUNTED;
    if (enemy.isElite) flags |= EnemyStateFlag.ELITE;
    if (enemy.armorShredTimer > 0) flags |= EnemyStateFlag.ARMOR_SHRED;
    enemy.chilled = enemy.slowTimer > 0;
    enemy.stateFlags = flags;
  }

  public resume(playerId?: PlayerId): SimEvent[] {
    const p = this.resolvePlayer(playerId);
    if (!this.asyncLevelUps && this.state === 'paused' && p.pendingChoiceQueue.length > 0) {
      this.openHeadBatchForSolo(p);
      return this.drainEvents();
    }
    if (this.state === 'paused' || this.state === 'levelup' || this.state === 'artifact') {
      this.state = 'playing';
    }
    return this.drainEvents();
  }

  private recordGlobalPassive(player: PlayerState, entry: GlobalPassiveEntry): void {
    if (player.globalPassives.some((p) => p.id === entry.id)) return;
    player.globalPassives.push(entry);
  }

  private recomputeStats(player: PlayerState, healOnMaxHpGain: boolean): void {
    const prevMaxHp = player.maxHp;
    player.computedStats = buildComputedStats(player);
    player.speed = player.computedStats.moveSpeed;
    player.maxHp = player.computedStats.maxHp;
    if (!player.downed && healOnMaxHpGain && player.maxHp > prevMaxHp) {
      player.hp = Math.min(player.maxHp, player.hp + (player.maxHp - prevMaxHp));
    } else if (!player.downed) {
      player.hp = Math.min(player.maxHp, player.hp);
    }
  }

  // ==========================================================================
  // ENEMY SPAWNING & COMBAT ACTIONS
  // ==========================================================================

  public spawnEnemy(
    archetypeId: EnemySpriteId,
    x: number,
    y: number,
    hpOverride?: number,
    opts?: { forceElite?: boolean; skipOverflow?: boolean }
  ): EnemyEntity {
    const def = ENEMIES[archetypeId];
    const minutes = this.getEffectiveMinutes();
    const playerCount = this.getPlayerCount();
    const overflow = opts?.skipOverflow
      ? { hpMult: 1, xpMult: 1, eliteChance: 0 }
      : this.getOverflowMultipliers();

    const isElite =
      opts?.forceElite ?? (overflow.eliteChance > 0 && this.rng.next() < overflow.eliteChance);
    const eliteHpMult = isElite ? 1.6 : 1;
    const eliteXpMult = isElite ? 2.0 : 1;
    const eliteDmgMult = isElite ? 1.15 : 1;

    const scaledHp = scaledEnemyHP(def.baseHp, minutes, playerCount) * overflow.hpMult * eliteHpMult;
    const maxHp = Math.round(hpOverride ?? scaledHp);
    const xpValue = Math.max(
      1,
      Math.round(scaledEnemyXP(def.baseXp, minutes, playerCount) * overflow.xpMult * eliteXpMult)
    );
    const nearest = this.findNearestAlivePlayer(x, y);

    const enemy: EnemyEntity = {
      id: this.allocEnemyId(),
      archetypeId,
      isBoss: false,
      isElite,
      x,
      y,
      vx: 0,
      vy: 0,
      kbVx: 0,
      kbVy: 0,
      radius: isElite ? Math.round(def.radius * 1.2) : def.radius,
      hp: maxHp,
      maxHp,
      speed: def.speed,
      damage: def.damage * (1 + 0.06 * minutes) * eliteDmgMult,
      xpValue,
      knockbackResist: isElite
        ? Math.min(0.85, def.knockbackResist + 0.2)
        : def.knockbackResist,
      facingLeft: nearest ? x > nearest.x : false,
      walkTime: this.rng.next() * 2,
      hitFlashTimer: 0,
      slowTimer: 0,
      slowFactor: 1,
      chilled: false,
      freezeTimer: 0,
      stunTimer: 0,
      burnTimer: 0,
      burnDps: 0,
      burnTickTimer: 0,
      burnColor: PALETTE.coral,
      armorShredTimer: 0,
      armorShredBonus: 0,
      tauntTimer: 0,
      tauntTargetId: null,
      stateFlags: isElite ? EnemyStateFlag.ELITE : EnemyStateFlag.NONE,
      rangedCooldown: def.rangedCooldown
        ? def.rangedCooldown * (0.5 + this.rng.next() * 0.5)
        : 0,
      aiState: 'normal',
      aiTimer: 0,
      aiCooldown: def.behavior === 'chase_tank' ? 2.2 + this.rng.next() * 2.0 : 0,
      alive: true,
    };

    this.enemies.push(enemy);
    return enemy;
  }

  public spawnBoss(bossId?: BossId, encounterIndexOverride?: number): EnemyEntity {
    const anchor = this.getAlivePlayers()[0] ?? this.getPrimaryPlayer();
    const encounterIndex =
      encounterIndexOverride !== undefined
        ? encounterIndexOverride
        : bossId !== undefined
        ? this.bossesDefeated
        : this.nextBossEncounterIndex;

    const bossDef = bossId ? BOSSES[bossId] : getBossForEncounter(encounterIndex);
    const minutes = this.getEffectiveMinutes();
    const playerCount = this.getPlayerCount();
    const soloBossHp = getBossScaledHp(bossDef, minutes, encounterIndex);
    const maxHp = scaledBossHP(soloBossHp, playerCount);
    const xpValue = Math.max(40, Math.round(scaledEnemyXP(bossDef.baseXp, minutes, playerCount)));
    const contactDamage = bossDef.contactDamage * getBossDamageScale(minutes, encounterIndex);

    // Guarantee room for the boss even if regular waves hit MAX_ENEMIES (350)
    if (this.enemies.length >= MAX_ENEMIES) {
      let farIdx = -1;
      let farDistSq = -1;
      for (let i = 0; i < this.enemies.length; i++) {
        const candidate = this.enemies[i];
        if (candidate.isBoss) continue;
        const dx = candidate.x - anchor.x;
        const dy = candidate.y - anchor.y;
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

    const spawnDist = Math.min(
      Math.max(260, Math.min(this.arenaWidth, this.arenaHeight) * 0.44),
      380
    );
    const angle = anchor.isMoving
      ? Math.atan2(anchor.vy, anchor.vx) + (this.rng.next() - 0.5) * 0.9
      : this.rng.next() * Math.PI * 2;
    const sx = anchor.x + Math.cos(angle) * spawnDist;
    const sy = anchor.y + Math.sin(angle) * spawnDist;

    const isTwinMacarons = bossDef.id === 'twin_macaron_mint';
    const perBossHp = isTwinMacarons ? Math.round(maxHp * 0.55) : maxHp;

    const boss: EnemyEntity = {
      id: this.allocEnemyId(),
      archetypeId: 'golem',
      bossId: bossDef.id,
      isBoss: true,
      isElite: false,
      bossEncounterIndex: encounterIndex,
      x: sx,
      y: sy,
      vx: 0,
      vy: 0,
      kbVx: 0,
      kbVy: 0,
      radius: bossDef.radius,
      hp: perBossHp,
      maxHp: perBossHp,
      speed: bossDef.speed,
      damage: contactDamage,
      xpValue,
      knockbackResist: 0.92,
      facingLeft: sx > anchor.x,
      walkTime: 0,
      hitFlashTimer: 0,
      slowTimer: 0,
      slowFactor: 1,
      chilled: false,
      freezeTimer: 0,
      stunTimer: 0,
      burnTimer: 0,
      burnDps: 0,
      burnTickTimer: 0,
      burnColor: bossDef.accentColor,
      armorShredTimer: 0,
      armorShredBonus: 0,
      tauntTimer: 0,
      tauntTargetId: null,
      stateFlags: EnemyStateFlag.NONE,
      rangedCooldown: 0,
      aiState: 'normal',
      aiTimer: 0,
      aiCooldown: 0,
      alive: true,
    };

    this.enemies.push(boss);
    this.bossAI.registerBoss(boss, bossDef.id, encounterIndex);

    // Spawn linked Rose Macaron partner symmetrically opposite Mint Macaron
    if (isTwinMacarons) {
      const roseDef = BOSSES.twin_macaron_rose;
      const roseAngle = angle + Math.PI * 0.85;
      const rx = anchor.x + Math.cos(roseAngle) * spawnDist;
      const ry = anchor.y + Math.sin(roseAngle) * spawnDist;
      const roseContactDmg = roseDef.contactDamage * getBossDamageScale(minutes, encounterIndex);
      const rose: EnemyEntity = {
        id: this.allocEnemyId(),
        archetypeId: 'golem',
        bossId: roseDef.id,
        linkedBossId: boss.id,
        isBoss: true,
        isElite: false,
        bossEncounterIndex: encounterIndex,
        x: rx,
        y: ry,
        vx: 0,
        vy: 0,
        kbVx: 0,
        kbVy: 0,
        radius: roseDef.radius,
        hp: perBossHp,
        maxHp: perBossHp,
        speed: roseDef.speed,
        damage: roseContactDmg,
        xpValue,
        knockbackResist: 0.92,
        facingLeft: rx > anchor.x,
        walkTime: 0,
        hitFlashTimer: 0,
        slowTimer: 0,
        slowFactor: 1,
        chilled: false,
        freezeTimer: 0,
        stunTimer: 0,
        burnTimer: 0,
        burnDps: 0,
        burnTickTimer: 0,
        burnColor: roseDef.accentColor,
        armorShredTimer: 0,
        armorShredBonus: 0,
        tauntTimer: 0,
        tauntTargetId: null,
        stateFlags: EnemyStateFlag.NONE,
        rangedCooldown: 0,
        aiState: 'normal',
        aiTimer: 0,
        aiCooldown: 0,
        alive: true,
      };
      boss.linkedBossId = rose.id;
      this.enemies.push(rose);
      this.bossAI.registerBoss(rose, roseDef.id, encounterIndex);
    }

    const info = this.getActiveBossInfo();
    if (info) {
      this.emit({
        type: 'BossSpawned',
        boss: info,
        x: sx,
        y: sy,
      });
    }

    return boss;
  }

  public spawnPickup(
    kind: PickupSpriteId,
    x: number,
    y: number,
    value = 0,
    sourceBossId?: BossId
  ): void {
    // Soft cap XP gems to protect framerate in extreme swarms (never cap hearts/magnets/chests)
    if (this.pickups.length >= MAX_PICKUPS && kind.startsWith('xp_')) {
      const oldestXp = this.pickups.find((p) => p.kind.startsWith('xp_'));
      if (oldestXp) {
        oldestXp.value += value;
        oldestXp.kind =
          oldestXp.value >= 20 ? 'xp_large' : oldestXp.value >= 9 ? 'xp_medium' : 'xp_small';
        return;
      }
    }

    const scatter = kind === 'chest' ? 14 : 45;
    const pickupId = this.nextPickupId;
    this.nextPickupId = this.nextPickupId >= 65535 ? 1 : this.nextPickupId + 1;
    this.pickups.push({
      id: pickupId,
      kind,
      x,
      y,
      vx: (this.rng.next() - 0.5) * scatter,
      vy: (this.rng.next() - 0.5) * scatter,
      value,
      radius: kind === 'chest' ? 20 : 10,
      magnetized: false,
      age: 0,
    });

    if (kind === 'chest') {
      this.emit({
        type: 'ChestSpawned',
        x,
        y,
        sourceBossId,
      });
    }
  }

  public damageEnemy = (
    enemy: EnemyEntity,
    rawDamage: number,
    opts: DamageOptions = {}
  ): boolean => {
    if (!enemy.alive) return false;

    const attacker = this.resolvePlayer(opts.playerId);
    const critChance = Math.min(
      0.98,
      attacker.computedStats.critChance + (opts.bonusCritChance ?? 0)
    );
    const isCrit = this.rng.next() < critChance;
    const critMult = attacker.computedStats.critMultiplier + (opts.bonusCritMult ?? 0);

    let finalDamage = rawDamage * (isCrit ? critMult : 1);

    // Acid Flask / Caustic Singularity corrosive armor shred amplifies damage from ALL players
    if (enemy.armorShredTimer > 0 && enemy.armorShredBonus > 0) {
      finalDamage *= 1 + enemy.armorShredBonus;
    }

    // Absolute Zero / Plague Glacier shatter bonus against frozen or chilled targets
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
      enemy.chilled = true;
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
    if (opts.armorShredDuration && opts.armorShredDuration > 0) {
      enemy.armorShredTimer = Math.max(enemy.armorShredTimer, opts.armorShredDuration);
      enemy.armorShredBonus = Math.max(enemy.armorShredBonus, opts.armorShredBonus ?? 0.28);
    }
    if (opts.tauntDuration && opts.tauntDuration > 0 && !enemy.isBoss) {
      const taunterId = opts.tauntTargetId ?? attacker.id;
      enemy.tauntTimer = Math.max(enemy.tauntTimer, opts.tauntDuration);
      enemy.tauntTargetId = taunterId;
      this.emit({
        type: 'EnemyTaunted',
        enemyId: enemy.id,
        targetPlayerId: taunterId,
        durationSec: enemy.tauntTimer,
        x: enemy.x,
        y: enemy.y,
      });
    }
    this.syncEnemyStateFlags(enemy);

    // Knockback impulse
    if (opts.knockback && opts.knockback > 0) {
      const resist = Math.max(0, Math.min(1, enemy.knockbackResist));
      const impulse = opts.knockback * (1 - resist);
      if (impulse > 1) {
        const sx = opts.sourceX ?? attacker.x;
        const sy = opts.sourceY ?? attacker.y;
        const dx = enemy.x - sx;
        const dy = enemy.y - sy;
        const d = Math.hypot(dx, dy);
        if (d > 0.01) {
          enemy.kbVx += (dx / d) * impulse;
          enemy.kbVy += (dy / d) * impulse;
        }
      }
    }

    this.emit({
      type: 'DamageDealt',
      enemyId: enemy.id,
      playerId: opts.playerId,
      x: enemy.x,
      y: enemy.y,
      radius: enemy.radius,
      amount: dmg,
      isCrit,
      shattered,
      color: opts.color ?? PALETTE.cream,
      silent: opts.silent,
    });

    if (enemy.hp <= 0) {
      this.handleEnemyDeath(enemy);
      return true;
    }
    return false;
  };

  /**
   * Taunts nearby non-boss enemies within `radius` to focus `taunterId` for `durationSec`.
   * Used by Knight's Shield Bash and Bastion Quake to peel packs off teammates.
   */
  public tauntNearbyEnemies(
    taunterId: PlayerId,
    x: number,
    y: number,
    radius: number,
    durationSec = 2.5
  ): number {
    const taunter = this.players.get(taunterId);
    if (!taunter || !taunter.alive || taunter.downed || durationSec <= 0) return 0;

    const candidates = this.spatialHash.queryRadius(x, y, radius, this.tauntQueryBuf);
    let tauntedCount = 0;

    for (let i = 0; i < candidates.length; i++) {
      const enemy = candidates[i];
      if (!enemy.alive || enemy.isBoss) continue;
      enemy.tauntTimer = Math.max(enemy.tauntTimer, durationSec);
      enemy.tauntTargetId = taunterId;
      this.syncEnemyStateFlags(enemy);
      this.emit({
        type: 'EnemyTaunted',
        enemyId: enemy.id,
        targetPlayerId: taunterId,
        durationSec: enemy.tauntTimer,
        x: enemy.x,
        y: enemy.y,
      });
      tauntedCount++;
    }

    return tauntedCount;
  }

  public healPlayer = (
    amount: number,
    playerId?: PlayerId,
    allowOverhealShield = false
  ): void => {
    if (amount <= 0) return;
    const p = this.resolvePlayer(playerId);
    if (!p.alive || p.downed) return;
    const before = p.hp;
    const rawNewHp = p.hp + amount;
    p.hp = Math.min(p.maxHp, rawNewHp);
    const healed = Math.round(p.hp - before);

    // Aether Alembic: excess healing converts into temporary pastel shield HP (up to 25% Max HP)
    const overheal = rawNewHp - p.maxHp;
    if (overheal > 0 && (allowOverhealShield || p.computedStats.hasOverhealToShield)) {
      const maxShield = Math.round(p.maxHp * 0.25);
      p.shieldHp = Math.min(maxShield, p.shieldHp + overheal * 0.5);
      p.shieldTimer = Math.max(p.shieldTimer, 3.5);
    }

    if (healed > 0) {
      this.emit({
        type: 'PlayerHealed',
        playerId: p.id,
        x: p.x,
        y: p.y,
        amount: healed,
      });
    }
  };

  public damagePlayer(rawDamage: number, playerId?: PlayerId): void {
    const p = this.resolvePlayer(playerId);
    if (!p.alive || p.downed || p.invulnTimer > 0 || this.state !== 'playing') return;

    let mitigated = Math.max(1, Math.round(rawDamage * (1 - p.computedStats.armor)));

    // Protective Ward / Aegis Lantern / Aether Alembic pastel shield absorbs damage first
    if (p.shieldHp > 0) {
      const absorbed = Math.min(p.shieldHp, mitigated);
      p.shieldHp = Math.max(0, p.shieldHp - absorbed);
      mitigated -= absorbed;
      if (mitigated <= 0) {
        p.invulnTimer = 0.35;
        this.emit({
          type: 'VfxRing',
          x: p.x,
          y: p.y,
          color: PALETTE.butterLight,
          maxRadius: 34,
          duration: 0.25,
        });
        this.syncPlayerStateFlags(p);
        return;
      }
    }

    p.hp = Math.max(0, p.hp - mitigated);
    p.invulnTimer = 0.45;
    p.hitFlashTimer = 0.16;

    this.emit({
      type: 'PlayerDamaged',
      playerId: p.id,
      x: p.x,
      y: p.y,
      amount: mitigated,
      remainingHp: p.hp,
    });

    // Retribution Aegis artifact special effect
    if (p.computedStats.hasRetributionAegis && p.hp > 0) {
      p.retributionBuffTimer = 4.0;
      this.recomputeStats(p, false);
      const runner = this.abilityRunners.get(p.id);
      runner?.triggerRetributionShockwave(this.createCombatContext(p));
    }

    if (p.hp <= 0) {
      p.hp = 0;
      p.shieldHp = 0;
      p.shieldTimer = 0;
      p.alive = false;
      p.downed = true;
      p.invulnTimer = 0;
      p.reviveProgressSec = 0;
      p.revivePct = 0;
      this.syncPlayerStateFlags(p);

      this.emit({
        type: 'PlayerDowned',
        playerId: p.id,
        x: p.x,
        y: p.y,
      });

      // Game over triggers ONLY when ALL connected players are downed simultaneously
      if (this.getAlivePlayers().length === 0) {
        this.state = 'gameover';
        this.emit({
          type: 'GameOverTriggered',
          snapshot: this.getRunStatsSnapshot(p.id),
        });
      }
    } else {
      this.syncPlayerStateFlags(p);
    }
  }

  private revivePlayer(
    player: PlayerState,
    hpRatio: number,
    reason: 'circle' | 'boss_kill',
    reviverIds: PlayerId[]
  ): void {
    if (!player.downed && player.alive) return;
    player.downed = false;
    player.alive = true;
    player.hp = Math.max(1, Math.round(player.maxHp * hpRatio));
    player.invulnTimer = Math.max(player.invulnTimer, REVIVE_INVULN_SEC);
    player.reviveProgressSec = 0;
    player.revivePct = 0;
    player.stateFlags &= ~(PlayerStateFlag.BEING_REVIVED | PlayerStateFlag.DOWNED);
    this.syncPlayerStateFlags(player);

    this.emit({
      type: 'PlayerRevived',
      playerId: player.id,
      reason,
      reviverIds,
      x: player.x,
      y: player.y,
      hp: player.hp,
    });
  }

  private handleEnemyDeath(enemy: EnemyEntity): void {
    enemy.alive = false;
    this.kills += 1;

    if (enemy.isBoss) {
      const bossInfo = this.bossAI.getBossInfo(enemy);
      this.bossAI.onBossRemoved(enemy.id);

      const bossAccent = bossInfo?.accentColor ?? PALETTE.butter;
      this.emit({
        type: 'EnemyKilled',
        enemyId: enemy.id,
        archetypeId: enemy.archetypeId,
        isBoss: true,
        bossId: enemy.bossId,
        x: enemy.x,
        y: enemy.y,
        radius: enemy.radius,
        accentColor: bossAccent,
      });

      // Duo Boss (The Twin Macarons): if the partner is still alive, enrage them and wait
      // until BOTH twins are defeated before dropping the Boss Chest & auto-reviving!
      const survivingPartner = enemy.linkedBossId
        ? this.enemies.find((e) => e.id === enemy.linkedBossId && e.alive)
        : undefined;
      if (survivingPartner) {
        this.bossAI.triggerEnrage(survivingPartner.id);
        this.emit({
          type: 'VfxText',
          x: survivingPartner.x,
          y: survivingPartner.y - survivingPartner.radius - 18,
          text: 'PARTNER FALLEN! ENRAGED!',
          color: survivingPartner.burnColor,
          isCrit: true,
        });
        this.emit({
          type: 'VfxRing',
          x: survivingPartner.x,
          y: survivingPartner.y,
          color: survivingPartner.burnColor,
          maxRadius: 140,
          duration: 0.5,
        });
        return;
      }

      this.bossesDefeated += 1;

      // Killing any Boss immediately auto-revives all downed players at 50% HP
      for (const p of this.players.values()) {
        if (p.downed || !p.alive) {
          this.revivePlayer(p, BOSS_KILL_REVIVE_HP_RATIO, 'boss_kill', []);
        }
      }

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

      // Drop one shared Boss Chest at the boss's defeat location
      this.spawnPickup('chest', enemy.x, enemy.y, 0, enemy.bossId);

      if (bossInfo) {
        this.emit({
          type: 'BossDefeated',
          boss: bossInfo,
          x: enemy.x,
          y: enemy.y,
        });
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

    this.emit({
      type: 'EnemyKilled',
      enemyId: enemy.id,
      archetypeId: enemy.archetypeId,
      isBoss: false,
      x: enemy.x,
      y: enemy.y,
      radius: enemy.radius,
      accentColor: burstColor,
    });

    // Drop XP gem (3 tiers)
    const xpTier: PickupSpriteId =
      enemy.xpValue >= 20 ? 'xp_large' : enemy.xpValue >= 9 ? 'xp_medium' : 'xp_small';
    this.spawnPickup(xpTier, enemy.x, enemy.y, enemy.xpValue);

    // Rare regular enemy drops: Magnet Orb (0.55%) & Pastel Heart (1.25%)
    const roll = this.rng.next();
    if (roll < 0.0055) {
      this.spawnPickup('magnet', enemy.x + 8, enemy.y, 0);
    } else if (roll < 0.018) {
      this.spawnPickup('heart', enemy.x + 8, enemy.y, 0);
    }
  }

  // ==========================================================================
  // SIMULATION TICK
  // ==========================================================================

  /**
   * Advances the headless simulation by `dt` seconds given per-player inputs
   * and returns all `SimEvent`s emitted during this tick.
   */
  public step(
    dt: number,
    inputs: ReadonlyMap<PlayerId, PlayerInput> | Readonly<Record<PlayerId, PlayerInput>>
  ): SimEvent[] {
    if (this.state !== 'playing') {
      return this.drainEvents();
    }

    this.tickCount += 1;
    this.elapsedRunSec += dt;

    this.updatePlayers(dt, inputs);
    this.updateReviveCircles(dt);
    this.updateWaveSpawner(dt);
    this.updateEnemies(dt);
    this.updateEnemyProjectiles(dt);

    // Populate 64px spatial hash, apply mass-aware separation, and refresh for combat queries
    this.spatialHash.clear();
    this.spatialHash.insertAll(this.enemies);
    this.resolveEnemySeparation();
    this.spatialHash.clear();
    this.spatialHash.insertAll(this.enemies);

    // Execute all active abilities & evolved synergies for every alive (non-downed) player
    for (const player of this.players.values()) {
      if (!player.alive || player.downed) continue;
      const runner = this.abilityRunners.get(player.id);
      if (!runner) continue;
      const combatCtx = this.createCombatContext(player);
      runner.update(dt, player.activeSlots, combatCtx);
    }

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

    return this.drainEvents();
  }

  private getInputForPlayer(
    playerId: PlayerId,
    inputs: ReadonlyMap<PlayerId, PlayerInput> | Readonly<Record<PlayerId, PlayerInput>>
  ): PlayerInput | undefined {
    if (inputs instanceof Map) {
      return inputs.get(playerId);
    }
    return (inputs as Readonly<Record<PlayerId, PlayerInput>>)[playerId];
  }

  private updatePlayers(
    dt: number,
    inputs: ReadonlyMap<PlayerId, PlayerInput> | Readonly<Record<PlayerId, PlayerInput>>
  ): void {
    for (const p of this.players.values()) {
      const input = this.getInputForPlayer(p.id, inputs);
      const mx = input?.moveX ?? 0;
      const my = input?.moveY ?? 0;

      // Downed Pastel Ghost / Spirit: slow drift only, cannot attack, regen, or collect XP
      if (p.downed || !p.alive) {
        const ghostSpeed = p.speed * GHOST_DRIFT_SPEED_MULT;
        p.vx = mx * ghostSpeed;
        p.vy = my * ghostSpeed;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.isMoving = Math.abs(mx) > 0.01 || Math.abs(my) > 0.01;
        if (p.isMoving) {
          p.walkTime += dt * 0.6;
          if (Math.abs(mx) > 0.05) {
            p.facingLeft = mx < 0;
          }
        } else {
          p.walkTime = 0;
        }
        this.syncPlayerStateFlags(p);
        continue;
      }

      if (p.invulnTimer > 0) p.invulnTimer = Math.max(0, p.invulnTimer - dt);
      if (p.hitFlashTimer > 0) p.hitFlashTimer = Math.max(0, p.hitFlashTimer - dt);

      let needsRecompute = false;
      if (p.retributionBuffTimer > 0) {
        p.retributionBuffTimer = Math.max(0, p.retributionBuffTimer - dt);
        if (p.retributionBuffTimer === 0) needsRecompute = true;
      }
      if (p.hasteBuffTimer > 0) {
        p.hasteBuffTimer = Math.max(0, p.hasteBuffTimer - dt);
        if (p.hasteBuffTimer === 0) needsRecompute = true;
      }
      if (p.starlightBuffTimer > 0) {
        p.starlightBuffTimer = Math.max(0, p.starlightBuffTimer - dt);
        if (p.starlightBuffTimer === 0) needsRecompute = true;
      }
      if (p.sharedCdAuraTimer > 0) {
        p.sharedCdAuraTimer = Math.max(0, p.sharedCdAuraTimer - dt);
        if (p.sharedCdAuraTimer === 0) needsRecompute = true;
      }
      if (p.totemRegenTimer > 0) {
        p.totemRegenTimer = Math.max(0, p.totemRegenTimer - dt);
        if (p.totemRegenTimer === 0) needsRecompute = true;
      }
      if (p.shieldTimer > 0) {
        p.shieldTimer = Math.max(0, p.shieldTimer - dt);
        if (p.shieldTimer === 0) {
          p.shieldHp = 0;
        }
      }
      if (needsRecompute) {
        this.recomputeStats(p, false);
      }

      // Chrono Distillate artifact: passively grant nearby allies -12% Cooldown Haste
      if (p.computedStats.hasSharedCooldownAura) {
        const auraR = 220 * p.computedStats.areaMult * (p.computedStats.hasAuraRadiusBoost ? 1.25 : 1);
        const auraRSq = auraR * auraR;
        for (const ally of this.players.values()) {
          if (ally.id === p.id || !ally.alive || ally.downed) continue;
          const adx = ally.x - p.x;
          const ady = ally.y - p.y;
          if (adx * adx + ady * ady <= auraRSq) {
            const wasInactive = ally.sharedCdAuraTimer <= 0;
            ally.sharedCdAuraTimer = Math.max(ally.sharedCdAuraTimer, 0.35);
            if (wasInactive) {
              this.recomputeStats(ally, false);
            }
          }
        }
      }

      // Passive HP regeneration
      if (p.computedStats.hpRegen > 0 && p.hp < p.maxHp) {
        p.hp = Math.min(p.maxHp, p.hp + p.computedStats.hpRegen * dt);
      }

      p.aimMode = input?.aimMode ?? 'auto';

      p.vx = mx * p.speed;
      p.vy = my * p.speed;
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      p.isMoving = Math.abs(mx) > 0.01 || Math.abs(my) > 0.01;
      if (p.isMoving) {
        p.walkTime += dt;
        if (Math.abs(mx) > 0.05) {
          p.facingLeft = mx < 0;
        }
        if (p.aimMode === 'auto') {
          p.aimAngle = Math.atan2(my, mx);
        }
      } else {
        p.walkTime = 0;
      }

      if (
        p.aimMode === 'mouse' &&
        input?.hasAimTarget &&
        input.aimTargetX !== undefined &&
        input.aimTargetY !== undefined
      ) {
        const dx = input.aimTargetX - p.x;
        const dy = input.aimTargetY - p.y;
        if (dx * dx + dy * dy > 1) {
          p.aimAngle = Math.atan2(dy, dx);
          if (!p.isMoving && Math.abs(dx) > 4) {
            p.facingLeft = dx < 0;
          }
        }
      } else if (
        p.aimMode === 'mouse' &&
        input?.aimAngle !== undefined &&
        Number.isFinite(input.aimAngle)
      ) {
        p.aimAngle = input.aimAngle;
        if (!p.isMoving) {
          const cos = Math.cos(input.aimAngle);
          if (Math.abs(cos) > 0.05) {
            p.facingLeft = cos < 0;
          }
        }
      }

      this.syncPlayerStateFlags(p);
    }
  }

  /**
   * Standing inside a downed ally's revive circle accumulates progress toward
   * 10.0 cumulative seconds (does NOT reset when stepping out to dodge).
   * Reaching 10.0s revives the ally at 20% HP with 2.0s of invulnerability.
   */
  private updateReviveCircles(dt: number): void {
    const reviveRadiusSq = REVIVE_CIRCLE_RADIUS * REVIVE_CIRCLE_RADIUS;

    // Reset transient circle flags each tick
    for (const p of this.players.values()) {
      p.stateFlags &= ~(PlayerStateFlag.REVIVING_ALLY | PlayerStateFlag.BEING_REVIVED);
    }

    const alivePlayers = this.getAlivePlayers();
    if (alivePlayers.length === 0) return;

    for (const downedPlayer of this.players.values()) {
      if (!downedPlayer.downed) continue;

      const reviversInside: PlayerId[] = [];
      for (let i = 0; i < alivePlayers.length; i++) {
        const ally = alivePlayers[i];
        if (ally.id === downedPlayer.id) continue;
        const dx = ally.x - downedPlayer.x;
        const dy = ally.y - downedPlayer.y;
        if (dx * dx + dy * dy <= reviveRadiusSq) {
          reviversInside.push(ally.id);
          ally.stateFlags |= PlayerStateFlag.REVIVING_ALLY;
        }
      }

      // Check if any deployed Revive Totem / Aegis Lantern covers this downed ally
      let totemBoostMult = 1.0;
      let totemSoloRate = 0;
      for (const runner of this.abilityRunners.values()) {
        const totems = runner.getActiveTotems();
        for (let ti = 0; ti < totems.length; ti++) {
          const t = totems[ti];
          const tdx = t.x - downedPlayer.x;
          const tdy = t.y - downedPlayer.y;
          if (tdx * tdx + tdy * tdy <= t.radius * t.radius) {
            totemBoostMult = Math.max(totemBoostMult, t.reviveBoostMult);
            totemSoloRate = Math.max(totemSoloRate, t.soloReviveRate);
          }
        }
      }

      if (reviversInside.length > 0 || totemSoloRate > 0) {
        downedPlayer.stateFlags |= PlayerStateFlag.BEING_REVIVED;
        const speedMult = reviversInside.length > 0 ? totemBoostMult : totemSoloRate;
        downedPlayer.reviveProgressSec = Math.min(
          REVIVE_DURATION_SEC,
          downedPlayer.reviveProgressSec + dt * speedMult
        );
        downedPlayer.revivePct = Math.min(1, downedPlayer.reviveProgressSec / REVIVE_DURATION_SEC);

        if (downedPlayer.reviveProgressSec >= REVIVE_DURATION_SEC - 1e-6) {
          this.revivePlayer(downedPlayer, REVIVE_HP_RATIO, 'circle', reviversInside);
        }
      } else {
        // Cumulative progress is preserved while no ally or totem is inside
        downedPlayer.revivePct = Math.min(1, downedPlayer.reviveProgressSec / REVIVE_DURATION_SEC);
      }
    }
  }

  private findNearestAlivePlayer(x: number, y: number): PlayerState | null {
    let best: PlayerState | null = null;
    let bestDistSq = Infinity;
    for (const p of this.players.values()) {
      if (!p.alive || p.downed) continue;
      const dx = p.x - x;
      const dy = p.y - y;
      const dSq = dx * dx + dy * dy;
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        best = p;
      }
    }
    return best;
  }

  private updateWaveSpawner(dt: number): void {
    const alivePlayers = this.getAlivePlayers();
    if (alivePlayers.length === 0) return;

    // 1. Scheduled Boss encounters (Standard: 10:00/20:00/30:00, Co-op Pace: 5:00/10:00/15:00/20:00)
    const bossIntervalSec = this.getBossSpawnIntervalSec();
    let nextBossSec = (this.nextBossEncounterIndex + 1) * bossIntervalSec;
    while (this.elapsedRunSec >= nextBossSec) {
      const encounterIdx = this.nextBossEncounterIndex;
      this.nextBossEncounterIndex += 1;
      const bossDef = getBossForEncounter(encounterIdx);
      this.spawnBoss(bossDef.id, encounterIdx);
      nextBossSec = (this.nextBossEncounterIndex + 1) * bossIntervalSec;
    }

    const minutes = this.getEffectiveMinutes();
    const playerCount = this.getPlayerCount();
    const bossActive = this.bossAI.hasActiveBoss();
    const spawnRadius = Math.hypot(this.arenaWidth * 0.5, this.arenaHeight * 0.5) + 75;

    // 2. Continuous scaled wave spawning (eased slightly during boss fights for readability)
    const rate = scaledSpawnRate(minutes, playerCount) * (bossActive ? 0.55 : 1);
    this.spawnAccumulator += rate * dt;

    // Hard Active Enemy Cap: 350 enemies per room.
    // Above the cap, stop adding entities and convert overflow spawn pressure into
    // higher enemy HP, XP gem value, and elite spawn chance.
    if (this.enemies.length >= MAX_ENEMIES) {
      const overflowUnits = Math.floor(this.spawnAccumulator);
      if (overflowUnits > 0) {
        this.spawnAccumulator -= overflowUnits;
        this.overflowSpawnPressure = Math.min(100, this.overflowSpawnPressure + overflowUnits * 0.6);
      }
    } else {
      while (this.spawnAccumulator >= 1 && this.enemies.length < MAX_ENEMIES) {
        this.spawnAccumulator -= 1;
        const anchor = alivePlayers[Math.floor(this.rng.next() * alivePlayers.length)];
        const archetype = pickWaveArchetype(minutes, this.rng.next());
        const angle = this.rng.next() * Math.PI * 2;
        const dist = spawnRadius + this.rng.next() * 80;
        const sx = anchor.x + Math.cos(angle) * dist;
        const sy = anchor.y + Math.sin(angle) * dist;
        this.spawnEnemy(archetype.id, sx, sy);
      }

      if (this.enemies.length >= MAX_ENEMIES && this.spawnAccumulator >= 1) {
        const overflowUnits = Math.floor(this.spawnAccumulator);
        this.spawnAccumulator -= overflowUnits;
        this.overflowSpawnPressure = Math.min(100, this.overflowSpawnPressure + overflowUnits * 0.6);
      } else if (this.overflowSpawnPressure > 0) {
        this.overflowSpawnPressure = Math.max(0, this.overflowSpawnPressure - dt * 1.2);
      }
    }

    // 3. Periodic coordinated swarm clusters (every 50s when no boss is active)
    if (!bossActive && this.elapsedRunSec >= this.nextSwarmWaveSec) {
      this.nextSwarmWaveSec += 50;
      const anchor = alivePlayers[Math.floor(this.rng.next() * alivePlayers.length)];
      const packSize = Math.min(48, Math.round((7 + Math.floor(minutes * 2.4)) * (1 + 0.35 * (playerCount - 1))));
      const baseAngle = this.rng.next() * Math.PI * 2;
      const arcSpan = Math.min(Math.PI * 1.2, 0.7 + minutes * 0.06);

      let skipped = 0;
      for (let i = 0; i < packSize; i++) {
        if (this.enemies.length >= MAX_ENEMIES) {
          skipped++;
          continue;
        }
        const frac = packSize > 1 ? i / (packSize - 1) - 0.5 : 0;
        const a = baseAngle + frac * arcSpan + (this.rng.next() - 0.5) * 0.12;
        const d = spawnRadius + 30 + this.rng.next() * 75;
        const sx = anchor.x + Math.cos(a) * d;
        const sy = anchor.y + Math.sin(a) * d;
        const isBruteLead = minutes >= 3.5 && i === Math.floor(packSize / 2);
        this.spawnEnemy(isBruteLead ? 'golem' : 'slime', sx, sy);
      }

      if (skipped > 0) {
        this.overflowSpawnPressure = Math.min(100, this.overflowSpawnPressure + skipped * 0.5);
      }
    }
  }

  private updateEnemies(dt: number): void {
    const alivePlayers = this.getAlivePlayers();
    if (alivePlayers.length === 0) return;

    const despawnDistSq =
      (Math.hypot(this.arenaWidth, this.arenaHeight) * 0.9 + 260) ** 2;
    const kbDecay = Math.exp(-10 * dt);

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
      if (e.tauntTimer > 0) {
        e.tauntTimer = Math.max(0, e.tauntTimer - dt);
        if (e.tauntTimer === 0) e.tauntTargetId = null;
      }
      if (e.armorShredTimer > 0) {
        e.armorShredTimer = Math.max(0, e.armorShredTimer - dt);
        if (e.armorShredTimer === 0) e.armorShredBonus = 0;
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

      this.syncEnemyStateFlags(e);

      // Taunted non-boss enemies aggressively focus the taunting Knight
      let target: PlayerState | null = null;
      if (!e.isBoss && e.tauntTimer > 0 && e.tauntTargetId) {
        const taunter = this.players.get(e.tauntTargetId);
        if (taunter && taunter.alive && !taunter.downed) {
          target = taunter;
        } else {
          e.tauntTimer = 0;
          e.tauntTargetId = null;
          this.syncEnemyStateFlags(e);
        }
      }
      if (!target) {
        // Rose Macaron prefers orbiting a different player than Mint Macaron in Co-op
        if (e.bossId === 'twin_macaron_rose' && alivePlayers.length > 1) {
          const mint = e.linkedBossId
            ? this.enemies.find((other) => other.id === e.linkedBossId && other.alive)
            : undefined;
          const mintTarget = mint ? this.findNearestAlivePlayer(mint.x, mint.y) : null;
          let bestAlt: PlayerState | null = null;
          let bestAltDistSq = Infinity;
          for (let pi = 0; pi < alivePlayers.length; pi++) {
            const pl = alivePlayers[pi];
            if (mintTarget && pl.id === mintTarget.id) continue;
            const dSq = (pl.x - e.x) ** 2 + (pl.y - e.y) ** 2;
            if (dSq < bestAltDistSq) {
              bestAltDistSq = dSq;
              bestAlt = pl;
            }
          }
          target = bestAlt ?? this.findNearestAlivePlayer(e.x, e.y);
        } else {
          target = this.findNearestAlivePlayer(e.x, e.y);
        }
      }
      if (!target) continue;

      // Boss state machine execution
      if (e.isBoss) {
        const bossCtx = this.createBossAIContext(target);
        const canDealContact = this.bossAI.updateBoss(e, dt, bossCtx);
        if (canDealContact) {
          for (let pi = 0; pi < alivePlayers.length; pi++) {
            const pl = alivePlayers[pi];
            if (!pl.alive || pl.downed) continue;
            const bdx = pl.x - e.x;
            const bdy = pl.y - e.y;
            const hitDist = pl.radius + e.radius - 3;
            if (bdx * bdx + bdy * bdy <= hitDist * hitDist) {
              this.damagePlayer(e.damage, pl.id);
            }
          }
        }
        continue;
      }

      const dx = target.x - e.x;
      const dy = target.y - e.y;
      const distSq = dx * dx + dy * dy;

      // Recycle far-away standard enemies back around the arena edge
      if (distSq > despawnDistSq) {
        const angle = this.rng.next() * Math.PI * 2;
        const r = Math.hypot(this.arenaWidth * 0.5, this.arenaHeight * 0.5) + 90;
        e.x = target.x + Math.cos(angle) * r;
        e.y = target.y + Math.sin(angle) * r;
        e.aiState = 'normal';
        e.aiTimer = 0;
        continue;
      }

      const d = Math.sqrt(distSq);
      const immobilized = e.freezeTimer > 0 || e.stunTimer > 0;

      if (!immobilized && d > 0.01) {
        const def = ENEMIES[e.archetypeId];
        const moveSpd = e.speed * (e.slowTimer > 0 ? e.slowFactor : 1);
        const nx = dx / d;
        const ny = dy / d;

        if (def.behavior === 'ranged_kiter' && def.rangedRange) {
          if (e.aiState === 'windup') {
            e.vx = nx * moveSpd * 0.15;
            e.vy = ny * moveSpd * 0.15;
            e.aiTimer = (e.aiTimer ?? 0) - dt;
            if ((e.aiTimer ?? 0) <= 0) {
              e.aiState = 'normal';
              e.rangedCooldown = (def.rangedCooldown ?? 2.6) * (0.9 + this.rng.next() * 0.2);
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
              this.emit({
                type: 'VfxBurst',
                x: e.x,
                y: e.y,
                color: PALETTE.lavenderLight,
                count: 4,
                opts: { speedMin: 25, speedMax: 80, sizeMin: 2, sizeMax: 4 },
              });
            }
          } else {
            if (d > def.rangedRange) {
              e.vx = nx * moveSpd;
              e.vy = ny * moveSpd;
            } else if (d < def.rangedRange * 0.7) {
              e.vx = -nx * moveSpd * 0.65;
              e.vy = -ny * moveSpd * 0.65;
            } else {
              const strafeDir = e.id % 2 === 0 ? 1 : -1;
              e.vx = -ny * moveSpd * 0.6 * strafeDir;
              e.vy = nx * moveSpd * 0.6 * strafeDir;
            }

            e.rangedCooldown -= dt;
            if (e.rangedCooldown <= 0 && d <= def.rangedRange * 1.35) {
              e.aiState = 'windup';
              e.aiTimer = 0.36;
            }
          }
        } else if (def.behavior === 'chase_tank') {
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
              this.emit({
                type: 'VfxBurst',
                x: e.x,
                y: e.y + 8,
                color: PALETTE.peach,
                count: 5,
                opts: { speedMin: 30, speedMax: 95 },
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
            if (d < 125 && (e.aiCooldown ?? 0) <= 0) {
              e.aiState = 'windup';
              e.aiTimer = 0.38;
            }
          }
        } else {
          const weave = Math.sin(e.walkTime * 3.8 + e.id * 1.7) * 0.28;
          const surge = d < 175 ? 1.12 : 1.0;
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

      // Contact damage check against alive players
      for (let pi = 0; pi < alivePlayers.length; pi++) {
        const pl = alivePlayers[pi];
        if (!pl.alive) continue;
        const cdx = pl.x - e.x;
        const cdy = pl.y - e.y;
        const hitDist = pl.radius + e.radius - 2;
        if (cdx * cdx + cdy * cdy <= hitDist * hitDist) {
          this.damagePlayer(e.damage, pl.id);
        }
      }
    }
  }

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
        const dSq = dx * dx + dy * dy;

        if (dSq < minDist * minDist) {
          const shareA = invMassA / totalInvMass;
          const shareB = invMassB / totalInvMass;
          if (dSq > 0.0001) {
            const d = Math.sqrt(dSq);
            const push = (minDist - d) * strength;
            const nx = dx / d;
            const ny = dy / d;
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
    const alivePlayers = this.getAlivePlayers();

    for (let i = this.enemyProjectiles.length - 1; i >= 0; i--) {
      const proj = this.enemyProjectiles[i];
      proj.life += dt;
      if (proj.life >= proj.maxLife) {
        this.enemyProjectiles.splice(i, 1);
        continue;
      }

      proj.x += proj.vx * dt;
      proj.y += proj.vy * dt;

      let hit = false;
      for (let pi = 0; pi < alivePlayers.length; pi++) {
        const pl = alivePlayers[pi];
        if (!pl.alive || pl.downed) continue;
        const dx = pl.x - proj.x;
        const dy = pl.y - proj.y;
        const hitR = pl.radius + proj.radius;
        if (dx * dx + dy * dy <= hitR * hitR) {
          this.damagePlayer(proj.damage, pl.id);
          this.emit({
            type: 'VfxBurst',
            x: proj.x,
            y: proj.y,
            color: proj.color,
            count: 5,
            opts: { speedMin: 30, speedMax: 90 },
          });
          hit = true;
          break;
        }
      }
      if (hit) {
        this.enemyProjectiles.splice(i, 1);
      }
    }

    if (this.mode === 'coop') {
      this.reconcileEnemyProjectiles();
    }
  }

  private reconcileEnemyProjectiles(): void {
    this.seenEnemyProjIdsBuf.clear();

    for (let i = 0; i < this.enemyProjectiles.length; i++) {
      const proj = this.enemyProjectiles[i];
      if (proj.netId === undefined) {
        const netId = this.allocProjectileNetId();
        proj.netId = netId;
        this.replicatedEnemyProjectiles.set(netId, proj);
        this.seenEnemyProjIdsBuf.add(netId);
        this.emit({
          type: 'ProjectileSpawned',
          netId,
          playerId: '',
          sourceId: 'fireball',
          spriteId: 'enemy_orb',
          kind: 'linear',
          x: proj.x,
          y: proj.y,
          vx: proj.vx,
          vy: proj.vy,
          radius: proj.radius,
          scale: Math.max(1.5, proj.radius / 4.2),
          spinSpeed: 0,
          remainingLifeSec: Math.max(0.1, proj.maxLife - proj.life),
        });
      } else {
        this.seenEnemyProjIdsBuf.add(proj.netId);
      }
    }

    for (const [netId, proj] of this.replicatedEnemyProjectiles) {
      if (!this.seenEnemyProjIdsBuf.has(netId)) {
        this.replicatedEnemyProjectiles.delete(netId);
        this.emit({
          type: 'ProjectileDespawned',
          netId,
          x: proj.x,
          y: proj.y,
        });
      }
    }
  }

  private updatePickups(dt: number): void {
    const alivePlayers = this.getAlivePlayers();
    if (alivePlayers.length === 0) return;
    const drag = Math.exp(-7 * dt);

    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const item = this.pickups[i];
      item.age += dt;

      // Determine attracting/nearest living (non-downed) player
      let target: PlayerState | null = item.magnetTargetId
        ? this.players.get(item.magnetTargetId) ?? null
        : null;
      if (!target || !target.alive || target.downed) {
        item.magnetized = false;
        item.magnetTargetId = undefined;
        target = this.findNearestAlivePlayer(item.x, item.y);
      }
      if (!target) continue;

      const dx = target.x - item.x;
      const dy = target.y - item.y;
      const dSq = dx * dx + dy * dy;

      const isXp = item.kind.startsWith('xp_');
      if (!item.magnetized && item.kind !== 'chest') {
        const pickupRadius = target.computedStats.pickupRadius;
        const attractSq = isXp ? pickupRadius * pickupRadius : (pickupRadius * 0.65) ** 2;
        if (dSq <= attractSq) {
          item.magnetized = true;
          item.magnetTargetId = target.id;
        }
      }

      if (item.magnetized && dSq > 0.01) {
        const d = Math.sqrt(dSq);
        const pullSpd = Math.min(720, 320 + item.age * 240);
        item.vx = (dx / d) * pullSpd;
        item.vy = (dy / d) * pullSpd;
        item.x += item.vx * dt;
        item.y += item.vy * dt;
      } else {
        item.x += item.vx * dt;
        item.y += item.vy * dt;
        item.vx *= drag;
        item.vy *= drag;
      }

      const collectR = target.radius + (item.kind === 'chest' ? item.radius + 10 : 14);
      const postDx = target.x - item.x;
      const postDy = target.y - item.y;
      if (postDx * postDx + postDy * postDy <= collectR * collectR) {
        this.collectPickup(item, target);
        this.pickups.splice(i, 1);
      }
    }
  }

  private collectPickup(item: PickupEntity, player: PlayerState): void {
    if (!player.alive || player.downed) return;

    if (item.kind === 'xp_small' || item.kind === 'xp_medium' || item.kind === 'xp_large') {
      // Strictly personal XP: add XP ONLY to the player who collected the gem
      const gained = Math.max(1, Math.round(item.value * player.computedStats.xpGainMult));
      player.xp += gained;

      const tier: 1 | 2 | 3 =
        item.kind === 'xp_large' ? 3 : item.kind === 'xp_medium' ? 2 : 1;

      this.emit({
        type: 'PickupCollected',
        playerId: player.id,
        kind: item.kind,
        x: item.x,
        y: item.y,
        value: gained,
        xpTier: tier,
      });

      while (player.xp >= player.xpToNext) {
        player.xp -= player.xpToNext;
        this.triggerSinglePersonalLevelUp(player);
      }
      return;
    }

    if (item.kind === 'heart') {
      this.emit({
        type: 'PickupCollected',
        playerId: player.id,
        kind: 'heart',
        x: item.x,
        y: item.y,
        value: Math.round(player.maxHp * 0.25),
      });
      this.healPlayer(Math.round(player.maxHp * 0.25), player.id);
      return;
    }

    if (item.kind === 'magnet') {
      const isCoop = this.mode === 'coop' || this.players.size > 1;
      const coopMagnetRadius = 420;
      const coopMagnetRadiusSq = coopMagnetRadius * coopMagnetRadius;
      for (let i = 0; i < this.pickups.length; i++) {
        const pk = this.pickups[i];
        if (!pk.kind.startsWith('xp_')) continue;
        if (isCoop) {
          const dx = pk.x - player.x;
          const dy = pk.y - player.y;
          if (dx * dx + dy * dy > coopMagnetRadiusSq) continue;
        }
        pk.magnetized = true;
        pk.magnetTargetId = player.id;
      }
      if (isCoop) {
        this.emit({
          type: 'VfxRing',
          x: player.x,
          y: player.y,
          color: PALETTE.babyBlue,
          maxRadius: coopMagnetRadius,
          duration: 0.45,
        });
      }
      this.emit({
        type: 'PickupCollected',
        playerId: player.id,
        kind: 'magnet',
        x: player.x,
        y: player.y,
        value: 0,
      });
      return;
    }

    if (item.kind === 'chest') {
      if (this.asyncLevelUps || this.players.size > 1) {
        // Shared Boss Chest: heal all living players and simultaneously push a
        // 3-option Boss Artifact choice batch into EVERY player's personal queue (zero loot stealing).
        for (const p of this.players.values()) {
          if (p.alive && !p.downed) {
            this.healPlayer(Math.round(p.maxHp * 0.35), p.id);
          }
          const ownedSet = new Set(p.ownedArtifacts);
          const availableDefs = getAvailableBossArtifacts(p.heroId, ownedSet);
          const artifactChoices = generateBossArtifactChoicesForPlayer(p, 3);
          const { batch } = this.enqueueChoiceBatch(p, 'boss_chest', artifactChoices);

          this.emit({
            type: 'BossChestOpened',
            playerId: p.id,
            openedByPlayerId: player.id,
            x: item.x,
            y: item.y,
            choices: availableDefs,
            upgradeChoices: batch.choices,
            batchId: batch.id,
            pendingQueueCount: p.pendingQueueCount,
          });
        }
      } else {
        // Solo offline mode: pause and present modal
        this.healPlayer(Math.round(player.maxHp * 0.35), player.id);
        const ownedSet = new Set(player.ownedArtifacts);
        const availableDefs = getAvailableBossArtifacts(player.heroId, ownedSet);
        const artifactChoices = generateBossArtifactChoicesForPlayer(player, 3);
        const { batch, isActive } = this.enqueueChoiceBatch(player, 'boss_chest', artifactChoices);
        if (isActive) {
          player.pendingArtifactChoices = availableDefs;
          this.state = 'artifact';
        }

        this.emit({
          type: 'BossChestOpened',
          playerId: player.id,
          openedByPlayerId: player.id,
          x: player.x,
          y: player.y,
          choices: availableDefs,
          upgradeChoices: batch.choices,
          batchId: batch.id,
          pendingQueueCount: player.pendingQueueCount,
        });
      }
    }
  }

  // ==========================================================================
  // CONTEXT FACTORIES FOR ABILITY RUNNER & BOSS AI
  // ==========================================================================

  private createCombatContext(player: PlayerState): CombatContext {
    return {
      player,
      stats: player.computedStats,
      aimMode: player.aimMode,
      spatialHash: this.spatialHash,
      enemies: this.enemies,
      viewportWidth: this.arenaWidth,
      viewportHeight: this.arenaHeight,
      damageEnemy: (enemy, rawDamage, opts = {}) =>
        this.damageEnemy(enemy, rawDamage, { ...opts, playerId: player.id }),
      tauntNearbyEnemies: (x, y, radius, durationSec) =>
        this.tauntNearbyEnemies(player.id, x, y, radius, durationSec),
      healPlayer: (amount) =>
        this.healPlayer(amount, player.id, player.computedStats.hasOverhealToShield),
      healAlliesInRadius: (x, y, radius, amount, allowOverhealShield = false) => {
        const rSq = radius * radius;
        let count = 0;
        for (const ally of this.players.values()) {
          if (!ally.alive || ally.downed) continue;
          const dx = ally.x - x;
          const dy = ally.y - y;
          if (dx * dx + dy * dy <= rSq) {
            this.healPlayer(
              amount,
              ally.id,
              allowOverhealShield || player.computedStats.hasOverhealToShield
            );
            count++;
          }
        }
        return count;
      },
      grantShieldInRadius: (x, y, radius, shieldAmount, durationSec) => {
        const rSq = radius * radius;
        let count = 0;
        for (const ally of this.players.values()) {
          if (!ally.alive || ally.downed) continue;
          const dx = ally.x - x;
          const dy = ally.y - y;
          if (dx * dx + dy * dy <= rSq) {
            const maxShield = Math.round(ally.maxHp * 0.25);
            ally.shieldHp = Math.min(maxShield, ally.shieldHp + shieldAmount);
            ally.shieldTimer = Math.max(ally.shieldTimer, durationSec);
            count++;
          }
        }
        return count;
      },
      grantHasteInRadius: (x, y, radius, durationSec) => {
        const rSq = radius * radius;
        let count = 0;
        for (const ally of this.players.values()) {
          if (!ally.alive || ally.downed) continue;
          const dx = ally.x - x;
          const dy = ally.y - y;
          if (dx * dx + dy * dy <= rSq) {
            const wasInactive = ally.hasteBuffTimer <= 0;
            ally.hasteBuffTimer = Math.max(ally.hasteBuffTimer, durationSec);
            if (wasInactive) {
              this.recomputeStats(ally, false);
            }
            count++;
          }
        }
        return count;
      },
      grantStarlightInRadius: (x, y, radius, durationSec) => {
        const rSq = radius * radius;
        let count = 0;
        for (const ally of this.players.values()) {
          if (!ally.alive || ally.downed) continue;
          const dx = ally.x - x;
          const dy = ally.y - y;
          if (dx * dx + dy * dy <= rSq) {
            const wasInactive = ally.starlightBuffTimer <= 0;
            ally.starlightBuffTimer = Math.max(ally.starlightBuffTimer, durationSec);
            if (wasInactive) {
              this.recomputeStats(ally, false);
            }
            count++;
          }
        }
        return count;
      },
      grantTotemRegenInRadius: (x, y, radius, durationSec) => {
        const rSq = radius * radius;
        let count = 0;
        for (const ally of this.players.values()) {
          if (!ally.alive || ally.downed) continue;
          const dx = ally.x - x;
          const dy = ally.y - y;
          if (dx * dx + dy * dy <= rSq) {
            const wasInactive = ally.totemRegenTimer <= 0;
            ally.totemRegenTimer = Math.max(ally.totemRegenTimer, durationSec);
            if (wasInactive) {
              this.recomputeStats(ally, false);
            }
            count++;
          }
        }
        return count;
      },
      spawnParticles: (x, y, color, count, opts?: ParticleBurstOptions) =>
        this.emit({ type: 'VfxBurst', x, y, color, count, opts }),
      spawnRingParticle: (x, y, color, maxRadius, duration) =>
        this.emit({ type: 'VfxRing', x, y, color, maxRadius, duration }),
      spawnFloatingText: (x, y, text, color, isCrit) =>
        this.emit({ type: 'VfxText', x, y, text, color, isCrit }),
      addScreenShake: (intensity, durationSec) =>
        this.emit({ type: 'ScreenShake', intensity, durationSec }),
      onAbilityFired: (abilityId, isSynergy, color, isDoubleCast, aimAngle) =>
        this.emit({
          type: 'AbilityFired',
          playerId: player.id,
          abilityId,
          isSynergy,
          x: player.x,
          y: player.y,
          color,
          isDoubleCast,
          aimAngle,
        }),
      ...(this.mode === 'coop'
        ? {
            allocProjectileNetId: () => this.allocProjectileNetId(),
            onProjectileSpawned: (proj, netId) =>
              this.emit({
                type: 'ProjectileSpawned',
                netId,
                playerId: player.id,
                sourceId: proj.sourceId,
                spriteId: proj.spriteId,
                kind: proj.kind,
                x: proj.x,
                y: proj.y,
                vx: proj.vx,
                vy: proj.vy,
                radius: proj.radius,
                scale: proj.scale,
                spinSpeed: proj.spinSpeed,
                remainingLifeSec: Math.max(0.08, proj.maxLife - proj.age),
              }),
            onProjectileMoved: (proj, netId) =>
              this.emit({
                type: 'ProjectileMoved',
                netId,
                x: proj.x,
                y: proj.y,
                vx: proj.vx,
                vy: proj.vy,
              }),
            onProjectileDespawned: (netId, x, y) =>
              this.emit({
                type: 'ProjectileDespawned',
                netId,
                x,
                y,
              }),
          }
        : {}),
    };
  }

  private createBossAIContext(target: PlayerState): BossAIContext {
    const alivePlayers = this.getAlivePlayers();
    return {
      player: target,
      allAlivePlayers: alivePlayers,
      playerCount: this.getPlayerCount(),
      elapsedRunSec: this.elapsedRunSec,
      damagePlayer: (rawDamage) => this.damagePlayer(rawDamage, target.id),
      damagePlayerById: (playerId, rawDamage) => this.damagePlayer(rawDamage, playerId),
      getEnemyById: (enemyId) => this.enemies.find((e) => e.id === enemyId),
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
      spawnParticles: (x, y, color, count, opts?: ParticleBurstOptions) =>
        this.emit({ type: 'VfxBurst', x, y, color, count, opts }),
      spawnRingParticle: (x, y, color, maxRadius, duration) =>
        this.emit({ type: 'VfxRing', x, y, color, maxRadius, duration }),
      spawnFloatingText: (x, y, text, color, isCrit) =>
        this.emit({ type: 'VfxText', x, y, text, color, isCrit }),
      addScreenShake: (intensity, durationSec) =>
        this.emit({ type: 'ScreenShake', intensity, durationSec }),
      getMinionCount: () => {
        let count = 0;
        for (let i = 0; i < this.enemies.length; i++) {
          if (this.enemies[i].alive && this.enemies[i].archetypeId === 'minislime') {
            count++;
          }
        }
        return count;
      },
      onTelegraph: (info) =>
        this.emit({
          type: 'BossTelegraph',
          ...info,
        }),
      onHazard: (info) =>
        this.emit({
          type: 'BossHazard',
          ...info,
        }),
    };
  }
}
