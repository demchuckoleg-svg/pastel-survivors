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
  ENEMIES,
  enemyHP,
  enemySpawnRate,
  enemyXP,
  getBossForEncounter,
  pickWaveArchetype,
  xpNeeded,
} from '../data/enemies';
import { PALETTE } from '../data/palette';
import { getSynergyDef } from '../data/synergies';
import type {
  AbilityId,
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
  generateLevelUpChoicesForPlayer,
  getAvailableSynergyEvolutionsForPlayer,
} from './progression';
import { createRng, type RngSource } from './rng';
import { SpatialHash } from './spatialHash';
import type {
  ActiveAbilitySlot,
  BossActiveInfo,
  DamageOptions,
  EnemyEntity,
  EnemyProjectile,
  GameState,
  GlobalPassiveEntry,
  LevelUpChoice,
  ParticleBurstOptions,
  PickupEntity,
  PlayerId,
  PlayerInput,
  PlayerState,
  RunStatsSnapshot,
} from './types';

export const DEFAULT_LOCAL_PLAYER_ID: PlayerId = 'local';
export const MAX_PLAYERS = 4;
export const MAX_ENEMIES = 320;
export const MAX_PICKUPS = 320;

export interface PlayerInitConfig {
  id: PlayerId;
  heroId: HeroId;
}

export interface StartRunOptions {
  seed?: number;
}

/**
 * Pure headless game simulation for Pastel Survivors.
 *
 * - Supports 1 player (Solo Offline) or up to 4 players (future online Co-op).
 * - Zero browser, DOM, Canvas, or Web Audio dependencies.
 * - Emits lightweight typed `SimEvent` objects every tick for the client
 *   renderer/audio/UI layers to consume.
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
  private elapsedRunSec = 0;

  // Reference viewport / arena dimensions used for wave spawn & recycle rings
  private arenaWidth = 1280;
  private arenaHeight = 720;

  // Wave director & run counters
  private nextEnemyId = 1;
  private spawnAccumulator = 0;
  private nextBossEncounterIndex = 0;
  private nextSwarmWaveSec = 45;
  private kills = 0;
  private bossesDefeated = 0;

  // Reusable buffers
  private readonly sepQueryBuf: EnemyEntity[] = [];
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

  public getElapsedRunSec(): number {
    return this.elapsedRunSec;
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
      if (p.alive) alive.push(p);
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
    return boss ? this.bossAI.getBossInfo(boss) : null;
  }

  public getNextBossCountdownSec(): number {
    const nextSec = (this.nextBossEncounterIndex + 1) * BOSS_SPAWN_INTERVAL_MIN * 60;
    return Math.max(0, nextSec - this.elapsedRunSec);
  }

  public getRunStatsSnapshot(playerId?: PlayerId): RunStatsSnapshot {
    const p = this.resolvePlayer(playerId);
    return {
      elapsedRunSec: this.elapsedRunSec,
      level: p.level,
      xp: p.xp,
      xpToNext: xpNeeded(p.level),
      kills: this.kills,
      bossesDefeated: this.bossesDefeated,
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
      level: 1,
      facingLeft: false,
      aimAngle: 0,
      aimMode: 'auto',
      walkTime: 0,
      isMoving: false,
      invulnTimer: 0,
      hitFlashTimer: 0,
      retributionBuffTimer: 0,
      alive: true,
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
      },
      masteryCount: 0,
      pendingLevelUps: 0,
      pendingChoices: [],
      pendingArtifactChoices: [],
    };
    this.players.set(id, player);
    this.abilityRunners.set(id, new AbilityRunner());
    return player;
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

    this.players.clear();
    this.abilityRunners.clear();
    this.events = [];

    this.elapsedRunSec = 0;
    this.nextEnemyId = 1;
    this.spawnAccumulator = 0;
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
    if (fullHeal) {
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

    p.pendingArtifactChoices = [];

    if (this.state === 'artifact') {
      if (p.pendingLevelUps > 0) {
        p.pendingLevelUps--;
        this.openNextLevelUp(p);
      } else {
        this.state = 'playing';
      }
    }

    return this.drainEvents();
  }

  public generateLevelUpChoices(count = 3, playerId?: PlayerId): LevelUpChoice[] {
    const p = this.resolvePlayer(playerId);
    return generateLevelUpChoicesForPlayer(p, this.rng, count);
  }

  public applyLevelUpChoice(choice: LevelUpChoice, playerId?: PlayerId): SimEvent[] {
    const p = this.resolvePlayer(playerId);

    if (choice.kind === 'synergy' && choice.synergyId) {
      this.evolveSynergy(choice.synergyId, p.id);
    } else if (choice.kind === 'ability' && choice.abilityId) {
      this.acquireOrUpgradeAbility(choice.abilityId, p.id);
    } else if (choice.kind === 'mastery' && choice.masteryModifiers) {
      p.masteryCount++;
      this.recordGlobalPassive(p, {
        id: `${choice.masteryId ?? 'mastery'}_${p.masteryCount}`,
        sourceType: 'mastery',
        sourceId: choice.masteryId ?? 'mastery',
        sourceName: choice.title,
        label: choice.description,
        modifiers: choice.masteryModifiers,
      });
      this.recomputeStats(p, true);
      if (choice.masteryHeal) {
        this.healPlayer(choice.masteryHeal, p.id);
      }
    }

    p.pendingChoices = [];
    if (p.pendingLevelUps > 0) {
      p.pendingLevelUps--;
      this.openNextLevelUp(p);
    } else if (this.state === 'levelup') {
      this.state = 'playing';
    }

    return this.drainEvents();
  }

  public grantLevels(levels = 1, playerId?: PlayerId): SimEvent[] {
    const p = this.resolvePlayer(playerId);
    for (let i = 0; i < levels; i++) {
      p.level += 1;
      p.pendingLevelUps += 1;
    }

    if (this.state === 'playing' && p.pendingLevelUps > 0) {
      p.pendingLevelUps--;
      this.openNextLevelUp(p);
    } else {
      this.emit({
        type: 'LevelUpTriggered',
        playerId: p.id,
        newLevel: p.level,
        x: p.x,
        y: p.y,
        choices: [],
      });
    }

    return this.drainEvents();
  }

  public resume(playerId?: PlayerId): SimEvent[] {
    const p = this.resolvePlayer(playerId);
    if (this.state === 'paused' && p.pendingLevelUps > 0) {
      p.pendingLevelUps--;
      this.openNextLevelUp(p);
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
    if (healOnMaxHpGain && player.maxHp > prevMaxHp) {
      player.hp = Math.min(player.maxHp, player.hp + (player.maxHp - prevMaxHp));
    } else {
      player.hp = Math.min(player.maxHp, player.hp);
    }
  }

  private openNextLevelUp(player: PlayerState): void {
    const choices = this.generateLevelUpChoices(3, player.id);
    player.pendingChoices = choices;
    this.state = 'levelup';
    this.emit({
      type: 'LevelUpTriggered',
      playerId: player.id,
      newLevel: player.level,
      x: player.x,
      y: player.y,
      choices,
    });
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
    const nearest = this.findNearestAlivePlayer(x, y);

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
      facingLeft: nearest ? x > nearest.x : false,
      walkTime: this.rng.next() * 2,
      hitFlashTimer: 0,
      slowTimer: 0,
      slowFactor: 1,
      freezeTimer: 0,
      stunTimer: 0,
      burnTimer: 0,
      burnDps: 0,
      burnTickTimer: 0,
      burnColor: PALETTE.coral,
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
      facingLeft: sx > anchor.x,
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

    const info = this.bossAI.getBossInfo(boss);
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
    this.pickups.push({
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

  public healPlayer = (amount: number, playerId?: PlayerId): void => {
    if (amount <= 0) return;
    const p = this.resolvePlayer(playerId);
    if (!p.alive) return;
    const before = p.hp;
    p.hp = Math.min(p.maxHp, p.hp + amount);
    const healed = Math.round(p.hp - before);
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
    if (!p.alive || p.invulnTimer > 0 || this.state !== 'playing') return;

    const mitigated = Math.max(1, Math.round(rawDamage * (1 - p.computedStats.armor)));
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
      p.alive = false;
      // Game over when all players are downed
      if (this.getAlivePlayers().length === 0) {
        this.state = 'gameover';
        this.emit({
          type: 'GameOverTriggered',
          snapshot: this.getRunStatsSnapshot(p.id),
        });
      }
    }
  }

  private handleEnemyDeath(enemy: EnemyEntity): void {
    enemy.alive = false;
    this.kills += 1;

    if (enemy.isBoss) {
      const bossInfo = this.bossAI.getBossInfo(enemy);
      this.bossAI.onBossRemoved(enemy.id);
      this.bossesDefeated += 1;

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

    this.elapsedRunSec += dt;

    this.updatePlayers(dt, inputs);
    this.updateWaveSpawner(dt);
    this.updateEnemies(dt);
    this.updateEnemyProjectiles(dt);

    // Populate 64px spatial hash, apply mass-aware separation, and refresh for combat queries
    this.spatialHash.clear();
    this.spatialHash.insertAll(this.enemies);
    this.resolveEnemySeparation();
    this.spatialHash.clear();
    this.spatialHash.insertAll(this.enemies);

    // Execute all active abilities & evolved synergies for every alive player
    for (const player of this.players.values()) {
      if (!player.alive) continue;
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
      if (!p.alive) continue;

      if (p.invulnTimer > 0) p.invulnTimer = Math.max(0, p.invulnTimer - dt);
      if (p.hitFlashTimer > 0) p.hitFlashTimer = Math.max(0, p.hitFlashTimer - dt);

      if (p.retributionBuffTimer > 0) {
        p.retributionBuffTimer = Math.max(0, p.retributionBuffTimer - dt);
        if (p.retributionBuffTimer === 0) {
          this.recomputeStats(p, false);
        }
      }

      // Passive HP regeneration
      if (p.computedStats.hpRegen > 0 && p.hp < p.maxHp) {
        p.hp = Math.min(p.maxHp, p.hp + p.computedStats.hpRegen * dt);
      }

      const input = this.getInputForPlayer(p.id, inputs);
      const mx = input?.moveX ?? 0;
      const my = input?.moveY ?? 0;
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
      }
    }
  }

  private findNearestAlivePlayer(x: number, y: number): PlayerState | null {
    let best: PlayerState | null = null;
    let bestDistSq = Infinity;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
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
    const spawnRadius = Math.hypot(this.arenaWidth * 0.5, this.arenaHeight * 0.5) + 75;

    // 2. Continuous scaled wave spawning (eased slightly during boss fights for readability)
    const rate = enemySpawnRate(minutes) * (bossActive ? 0.55 : 1);
    this.spawnAccumulator += rate * dt;

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

    // 3. Periodic coordinated swarm clusters (every 50s when no boss is active)
    if (!bossActive && this.elapsedRunSec >= this.nextSwarmWaveSec) {
      this.nextSwarmWaveSec += 50;
      const anchor = alivePlayers[Math.floor(this.rng.next() * alivePlayers.length)];
      const packSize = Math.min(18, 6 + Math.floor(minutes * 1.4));
      const baseAngle = this.rng.next() * Math.PI * 2;
      const arcSpan = Math.min(Math.PI * 1.2, 0.7 + minutes * 0.06);

      for (let i = 0; i < packSize && this.enemies.length < MAX_ENEMIES; i++) {
        const frac = packSize > 1 ? i / (packSize - 1) - 0.5 : 0;
        const a = baseAngle + frac * arcSpan + (this.rng.next() - 0.5) * 0.12;
        const d = spawnRadius + 30 + this.rng.next() * 75;
        const sx = anchor.x + Math.cos(a) * d;
        const sy = anchor.y + Math.sin(a) * d;
        const isBruteLead = minutes >= 3.5 && i === Math.floor(packSize / 2);
        this.spawnEnemy(isBruteLead ? 'golem' : 'slime', sx, sy);
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

      const target = this.findNearestAlivePlayer(e.x, e.y);
      if (!target) continue;

      // Boss state machine execution
      if (e.isBoss) {
        const bossCtx = this.createBossAIContext(target);
        const canDealContact = this.bossAI.updateBoss(e, dt, bossCtx);
        if (canDealContact) {
          for (let pi = 0; pi < alivePlayers.length; pi++) {
            const pl = alivePlayers[pi];
            if (!pl.alive) continue;
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
        if (!pl.alive) continue;
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
  }

  private updatePickups(dt: number): void {
    const alivePlayers = this.getAlivePlayers();
    if (alivePlayers.length === 0) return;
    const drag = Math.exp(-7 * dt);

    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const item = this.pickups[i];
      item.age += dt;

      // Determine attracting/nearest alive player
      let target: PlayerState | null = item.magnetTargetId
        ? this.players.get(item.magnetTargetId) ?? null
        : null;
      if (!target || !target.alive) {
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
    if (item.kind === 'xp_small' || item.kind === 'xp_medium' || item.kind === 'xp_large') {
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

      let leveled = false;
      while (player.xp >= xpNeeded(player.level)) {
        player.xp -= xpNeeded(player.level);
        player.level += 1;
        player.pendingLevelUps += 1;
        leveled = true;
      }

      if (leveled) {
        if (this.state === 'playing' && player.pendingLevelUps > 0) {
          player.pendingLevelUps--;
          this.openNextLevelUp(player);
        } else {
          this.emit({
            type: 'LevelUpTriggered',
            playerId: player.id,
            newLevel: player.level,
            x: player.x,
            y: player.y,
            choices: [],
          });
        }
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
      for (let i = 0; i < this.pickups.length; i++) {
        if (this.pickups[i].kind.startsWith('xp_')) {
          this.pickups[i].magnetized = true;
          this.pickups[i].magnetTargetId = player.id;
        }
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
      this.healPlayer(Math.round(player.maxHp * 0.35), player.id);
      const ownedSet = new Set(player.ownedArtifacts);
      const available = getAvailableBossArtifacts(player.heroId, ownedSet);
      player.pendingArtifactChoices = available;
      this.state = 'artifact';

      this.emit({
        type: 'BossChestOpened',
        playerId: player.id,
        x: player.x,
        y: player.y,
        choices: available,
      });
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
      healPlayer: (amount) => this.healPlayer(amount, player.id),
      spawnParticles: (x, y, color, count, opts?: ParticleBurstOptions) =>
        this.emit({ type: 'VfxBurst', x, y, color, count, opts }),
      spawnRingParticle: (x, y, color, maxRadius, duration) =>
        this.emit({ type: 'VfxRing', x, y, color, maxRadius, duration }),
      spawnFloatingText: (x, y, text, color, isCrit) =>
        this.emit({ type: 'VfxText', x, y, text, color, isCrit }),
      addScreenShake: (intensity, durationSec) =>
        this.emit({ type: 'ScreenShake', intensity, durationSec }),
      onAbilityFired: (abilityId, isSynergy, color, isDoubleCast) =>
        this.emit({
          type: 'AbilityFired',
          playerId: player.id,
          abilityId,
          isSynergy,
          x: player.x,
          y: player.y,
          color,
          isDoubleCast,
        }),
    };
  }

  private createBossAIContext(target: PlayerState): BossAIContext {
    return {
      player: target,
      elapsedRunSec: this.elapsedRunSec,
      damagePlayer: (rawDamage) => this.damagePlayer(rawDamage, target.id),
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
    };
  }
}
