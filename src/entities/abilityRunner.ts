import { PALETTE } from '../art/palette';
import {
  drawPixelSprite,
  type BossId,
  type EnemySpriteId,
  type ProjectileSpriteId,
  type SpriteAtlas,
} from '../art/sprites';
import { ABILITIES, getAbilityStatsAtLevel } from '../data/abilities';
import { SYNERGIES } from '../data/synergies';
import type {
  AbilityId,
  AbilityStats,
  ClassId,
  GlobalStatKey,
  SynergyId,
} from '../data/types';
import type { SpatialEntity, SpatialHash } from '../engine/spatialHash';
import type { AimMode } from '../engine/storage';

// ============================================================================
// SHARED COMBAT RUNTIME TYPES
// ============================================================================

export interface EnemyEntity extends SpatialEntity {
  id: number;
  archetypeId: EnemySpriteId;
  bossId?: BossId;
  isBoss: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  kbVx: number;
  kbVy: number;
  radius: number;
  hp: number;
  maxHp: number;
  speed: number;
  damage: number;
  xpValue: number;
  knockbackResist: number;
  facingLeft: boolean;
  walkTime: number;
  hitFlashTimer: number;
  slowTimer: number;
  slowFactor: number;
  freezeTimer: number;
  stunTimer: number;
  burnTimer: number;
  burnDps: number;
  burnTickTimer: number;
  burnColor: string;
  rangedCooldown: number;
  alive: boolean;
}

export interface GlobalPassiveEntry {
  id: string;
  sourceType: 'ability_lv5' | 'ability_lv10' | 'synergy' | 'artifact' | 'mastery';
  sourceId: string;
  sourceName: string;
  label: string;
  modifiers: Partial<Record<GlobalStatKey, number>>;
}

export interface ComputedPlayerStats {
  maxHp: number;
  moveSpeed: number;
  pickupRadius: number;
  armor: number;
  critChance: number;
  critMultiplier: number;
  hpRegen: number;
  damageMult: number;
  cooldownMult: number;
  areaMult: number;
  xpGainMult: number;
  knockbackMult: number;
  projectileBonus: number;
  pierceBonus: number;
  hasDoubleCast: boolean;
  hasRetributionAegis: boolean;
}

export interface ActiveAbilitySlot {
  kind: 'ability' | 'synergy';
  id: AbilityId | SynergyId;
  level: number;
  cooldownTimer: number;
}

export interface DamageOptions {
  knockback?: number;
  sourceX?: number;
  sourceY?: number;
  color?: string;
  bonusCritChance?: number;
  bonusCritMult?: number;
  chillDuration?: number;
  chillFactor?: number;
  freezeDuration?: number;
  stunDuration?: number;
  burnDps?: number;
  burnDuration?: number;
  burnColor?: string;
  shatterBonus?: boolean;
  silent?: boolean;
}

export interface ParticleBurstOptions {
  speedMin?: number;
  speedMax?: number;
  sizeMin?: number;
  sizeMax?: number;
  lifeMin?: number;
  lifeMax?: number;
  shape?: 'square' | 'circle' | 'spark';
  gravity?: number;
}

export interface CombatContext {
  player: {
    heroId: ClassId;
    x: number;
    y: number;
    aimAngle: number;
    facingLeft: boolean;
    hp: number;
    maxHp: number;
  };
  stats: ComputedPlayerStats;
  aimMode: AimMode;
  spatialHash: SpatialHash<EnemyEntity>;
  enemies: readonly EnemyEntity[];
  sprites: SpriteAtlas;
  viewportWidth: number;
  viewportHeight: number;
  damageEnemy: (enemy: EnemyEntity, rawDamage: number, opts?: DamageOptions) => boolean;
  healPlayer: (amount: number) => void;
  spawnParticles: (
    x: number,
    y: number,
    color: string,
    count: number,
    opts?: ParticleBurstOptions
  ) => void;
  spawnRingParticle: (x: number, y: number, color: string, maxRadius: number, duration?: number) => void;
  spawnFloatingText: (
    x: number,
    y: number,
    text: string,
    color: string,
    isCrit?: boolean
  ) => void;
  addScreenShake: (intensity: number, durationSec: number) => void;
  playHitSound: (isCrit: boolean) => void;
}

// ============================================================================
// INTERNAL ACTIVE COMBAT EFFECT TYPES
// ============================================================================

interface ActiveProjectile {
  kind: 'linear' | 'homing' | 'boomerang' | 'ricochet' | 'dash' | 'spiral_boomerang';
  sourceId: AbilityId | SynergyId;
  spriteId?: ProjectileSpriteId;
  color: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  speed: number;
  radius: number;
  damage: number;
  knockback: number;
  pierceLeft: number;
  age: number;
  maxLife: number;
  rotation: number;
  spinSpeed: number;
  scale: number;
  hitIds: Set<number>;
  hitCooldowns?: Map<number, number>;
  explosiveRadius?: number;
  clusterShrapnelCount?: number;
  chillDuration?: number;
  chillFactor?: number;
  shatterBonus?: boolean;
  pullRadius?: number;
  pullStrength?: number;
  burnDps?: number;
  burnDuration?: number;
  burnColor?: string;
  explosiveFinish?: boolean;
  splinterOnBounce?: boolean;
  retargetOnPierce?: boolean;
  bonusCritChance?: number;
  turnRate?: number;
  tetherToPlayer?: boolean;
  leaveTrail?: boolean;
  trailTimer?: number;
  boomerangReturned?: boolean;
  spiralDir?: number;
  dashChainCount?: number;
}

interface ActiveBeam {
  sourceId: AbilityId | SynergyId;
  spriteId?: ProjectileSpriteId;
  x: number;
  y: number;
  angle: number;
  length: number;
  width: number;
  color: string;
  coreColor: string;
  damage: number;
  knockback: number;
  age: number;
  maxLife: number;
  hitIds: Set<number>;
  secondTickAt?: number;
  secondTickDone: boolean;
  chainArcCount?: number;
  chainArcRange?: number;
  bonusCritChance?: number;
  bonusCritMult?: number;
  afterglowAt?: number;
  afterglowDone: boolean;
}

interface ActiveNova {
  sourceId: string;
  x: number;
  y: number;
  maxRadius: number;
  currentRadius: number;
  color: string;
  ringColor: string;
  damage: number;
  knockback: number;
  age: number;
  maxLife: number;
  hitIds: Set<number>;
  chillDuration?: number;
  chillFactor?: number;
  freezeDuration?: number;
  stunDuration?: number;
  followPlayer: boolean;
  lifestealOnMultiKill?: boolean;
  killsThisCast: number;
  lifestealAwarded: boolean;
}

interface ActiveOrbitGroup {
  sourceId: AbilityId | SynergyId;
  visualKind: 'orb' | 'blade' | 'flail' | 'singularity' | 'greatsword';
  spriteId?: ProjectileSpriteId;
  color: string;
  count: number;
  orbitRadius: number;
  itemRadius: number;
  angularSpeed: number;
  baseAngle: number;
  damage: number;
  knockback: number;
  age: number;
  maxLife: number;
  hitCooldowns: Map<number, number>;
  emitBoltTimer?: number;
  gravityDragRadius?: number;
  cleavePulseTimer?: number;
}

interface ActiveMeleeArc {
  sourceId: AbilityId;
  visualKind: 'greatsword' | 'shield';
  angle: number;
  arcSpread: number;
  radius: number;
  color: string;
  damage: number;
  knockback: number;
  age: number;
  maxLife: number;
  hitIds: Set<number>;
}

interface ActiveStrikeOrRain {
  sourceId: string;
  visualKind:
    | 'earth_spike'
    | 'ground_slam'
    | 'meteor'
    | 'arrow_rain'
    | 'holy_hammer'
    | 'cataclysm_meteor'
    | 'divine_hammer';
  spriteId?: ProjectileSpriteId;
  x: number;
  y: number;
  radius: number;
  color: string;
  damage: number;
  knockback: number;
  delay: number;
  elapsed: number;
  impacted: boolean;
  lingerTime: number;
  radialEarthSpikes?: boolean;
  seismicAftershock?: boolean;
  lifestealOnMultiKill?: boolean;
  screenShake?: number;
}

interface ActiveChainArc {
  points: Array<{ x: number; y: number }>;
  color: string;
  age: number;
  maxLife: number;
  lineWidth: number;
}

interface ActiveTurret {
  sourceId: 'gatling_turret' | 'artillery_barrage';
  x: number;
  y: number;
  angle: number;
  range: number;
  damage: number;
  speed: number;
  pierce: number;
  knockback: number;
  color: string;
  age: number;
  maxLife: number;
  fireTimer: number;
  fireInterval: number;
  barrageTimer: number;
  isArtillery: boolean;
}

interface ActiveGroundTrail {
  kind: 'damage_lane' | 'afterimage' | 'starlight_pulse';
  x: number;
  y: number;
  x2: number;
  y2: number;
  radius: number;
  color: string;
  damage: number;
  knockback: number;
  age: number;
  maxLife: number;
  hitCooldowns: Map<number, number>;
  heroId?: ClassId;
  facingLeft?: boolean;
}

interface DelayedCast {
  timer: number;
  action: () => void;
}

// ============================================================================
// MATH HELPERS
// ============================================================================

function normalizeAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function pointToSegmentDistSq(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 0.0001) {
    const ox = px - x1;
    const oy = py - y1;
    return ox * ox + oy * oy;
  }
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  const ox = px - projX;
  const oy = py - projY;
  return ox * ox + oy * oy;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled ability/synergy id: ${String(value)}`);
}

// ============================================================================
// ABILITY RUNNER
// ============================================================================

export class AbilityRunner {
  private projectiles: ActiveProjectile[] = [];
  private beams: ActiveBeam[] = [];
  private novas: ActiveNova[] = [];
  private orbits: ActiveOrbitGroup[] = [];
  private meleeArcs: ActiveMeleeArc[] = [];
  private strikes: ActiveStrikeOrRain[] = [];
  private chainArcs: ActiveChainArc[] = [];
  private turrets: ActiveTurret[] = [];
  private trails: ActiveGroundTrail[] = [];
  private delayedCasts: DelayedCast[] = [];

  private castCounter = 0;
  private readonly queryBuf: EnemyEntity[] = [];

  public reset(): void {
    this.projectiles.length = 0;
    this.beams.length = 0;
    this.novas.length = 0;
    this.orbits.length = 0;
    this.meleeArcs.length = 0;
    this.strikes.length = 0;
    this.chainArcs.length = 0;
    this.turrets.length = 0;
    this.trails.length = 0;
    this.delayedCasts.length = 0;
    this.castCounter = 0;
  }

  /**
   * Removes persistent orbit/turret instances belonging to consumed base abilities
   * upon Synergy Evolution so the evolved effect replaces them cleanly.
   */
  public clearEffectsForAbility(abilityId: AbilityId): void {
    this.orbits = this.orbits.filter((o) => o.sourceId !== abilityId);
    this.turrets = this.turrets.filter((t) => t.sourceId !== abilityId);
  }

  /**
   * Triggers a Retribution Aegis defensive shockwave centered on the player.
   */
  public triggerRetributionShockwave(ctx: CombatContext): void {
    const area = 132 * ctx.stats.areaMult;
    const damage = 36 * ctx.stats.damageMult;
    this.novas.push({
      sourceId: 'retribution_aegis',
      x: ctx.player.x,
      y: ctx.player.y,
      maxRadius: area,
      currentRadius: 12,
      color: PALETTE.coral,
      ringColor: PALETTE.cream,
      damage,
      knockback: 250 * ctx.stats.knockbackMult,
      age: 0,
      maxLife: 0.38,
      hitIds: new Set<number>(),
      followPlayer: true,
      killsThisCast: 0,
      lifestealAwarded: false,
    });
    ctx.spawnParticles(ctx.player.x, ctx.player.y, PALETTE.coral, 16, {
      speedMin: 90,
      speedMax: 210,
    });
    ctx.addScreenShake(4.5, 0.16);
  }

  /**
   * Ticks all active ability slots, fires ready abilities/synergies, and updates
   * all active projectiles, beams, novas, orbits, melee arcs, strikes, turrets, and trails.
   */
  public update(dt: number, slots: ActiveAbilitySlot[], ctx: CombatContext): void {
    // 1. Tick slot cooldowns and execute ready casts
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      slot.cooldownTimer -= dt;
      if (slot.cooldownTimer <= 0) {
        if (slot.kind === 'ability') {
          const def = ABILITIES[slot.id as AbilityId];
          const stats = getAbilityStatsAtLevel(def, slot.level);
          const effectiveCd = Math.max(0.14, stats.cooldown * ctx.stats.cooldownMult);
          slot.cooldownTimer = effectiveCd;
          this.castWithChronometer(ctx, () => this.executeAbility(def.id, stats, ctx));
        } else {
          const syn = SYNERGIES[slot.id as SynergyId];
          const stats = syn.evolvedSpec.stats;
          const effectiveCd = Math.max(0.14, stats.cooldown * ctx.stats.cooldownMult);
          slot.cooldownTimer = effectiveCd;
          this.castWithChronometer(ctx, () => this.executeSynergy(syn.id, stats, ctx));
        }
      }
    }

    // 2. Tick delayed casts (double-casts, staggered follow-ups, multi-ring waves)
    for (let i = this.delayedCasts.length - 1; i >= 0; i--) {
      const d = this.delayedCasts[i];
      d.timer -= dt;
      if (d.timer <= 0) {
        this.delayedCasts.splice(i, 1);
        d.action();
      }
    }

    // 3. Update all active combat subsystems
    this.updateProjectiles(dt, ctx);
    this.updateBeams(dt, ctx);
    this.updateNovas(dt, ctx);
    this.updateOrbits(dt, ctx);
    this.updateMeleeArcs(dt, ctx);
    this.updateStrikes(dt, ctx);
    this.updateChainArcs(dt);
    this.updateTurrets(dt, ctx);
    this.updateTrails(dt, ctx);
  }

  private castWithChronometer(ctx: CombatContext, castFn: () => void): void {
    castFn();
    this.castCounter++;
    if (ctx.stats.hasDoubleCast && this.castCounter % 5 === 0) {
      this.delayedCasts.push({
        timer: 0.12,
        action: () => {
          castFn();
          ctx.spawnRingParticle(ctx.player.x, ctx.player.y, PALETTE.babyBlue, 38, 0.25);
        },
      });
    }
  }

  // ==========================================================================
  // TARGETING HELPERS
  // ==========================================================================

  private getAimAngle(ctx: CombatContext, maxRange = 460): number {
    if (ctx.aimMode === 'mouse') {
      return ctx.player.aimAngle;
    }
    const nearest = ctx.spatialHash.findNearest(
      ctx.player.x,
      ctx.player.y,
      maxRange,
      (e) => e.alive
    );
    if (nearest) {
      return Math.atan2(nearest.y - ctx.player.y, nearest.x - ctx.player.x);
    }
    return ctx.player.aimAngle;
  }

  private pickTargetEnemies(
    ctx: CombatContext,
    count: number,
    maxRange = 420
  ): EnemyEntity[] {
    const candidates = ctx.spatialHash.queryRadius(
      ctx.player.x,
      ctx.player.y,
      maxRange,
      this.queryBuf
    );
    const alive: EnemyEntity[] = [];
    for (let i = 0; i < candidates.length; i++) {
      if (candidates[i].alive) alive.push(candidates[i]);
    }
    if (alive.length === 0) return [];

    // Sort by distance ascending so nearest threats are prioritized, with variety
    alive.sort((a, b) => {
      const da = (a.x - ctx.player.x) ** 2 + (a.y - ctx.player.y) ** 2;
      const db = (b.x - ctx.player.x) ** 2 + (b.y - ctx.player.y) ** 2;
      return da - db;
    });

    const picked: EnemyEntity[] = [];
    for (let i = 0; i < count; i++) {
      picked.push(alive[i % alive.length]);
    }
    return picked;
  }

  // ==========================================================================
  // EXECUTION FOR ALL 30 BASE ABILITIES (EXHAUSTIVE)
  // ==========================================================================

  private executeAbility(id: AbilityId, stats: AbilityStats, ctx: CombatContext): void {
    const p = ctx.player;
    const damage = stats.damage * ctx.stats.damageMult;
    const area = stats.area * ctx.stats.areaMult;
    const kb = (stats.knockback ?? 0) * ctx.stats.knockbackMult;
    const count = Math.max(1, stats.count + ctx.stats.projectileBonus);
    const pierce = stats.pierce >= 999 ? 999 : stats.pierce + ctx.stats.pierceBonus;
    const baseAngle = this.getAimAngle(ctx);

    switch (id) {
      // ----------------------------------------------------------------------
      // MAGE (10)
      // ----------------------------------------------------------------------
      case 'fireball': {
        const spread = count > 1 ? Math.min(0.45, (count - 1) * 0.14) : 0;
        for (let i = 0; i < count; i++) {
          const angle =
            count === 1 ? baseAngle : baseAngle - spread / 2 + (spread * i) / (count - 1);
          this.projectiles.push({
            kind: 'linear',
            sourceId: 'fireball',
            spriteId: 'fireball',
            color: PALETTE.coral,
            x: p.x,
            y: p.y,
            vx: Math.cos(angle) * stats.speed,
            vy: Math.sin(angle) * stats.speed,
            speed: stats.speed,
            radius: 13,
            damage,
            knockback: kb,
            pierceLeft: pierce,
            age: 0,
            maxLife: stats.duration,
            rotation: angle,
            spinSpeed: 0,
            scale: 2.2,
            hitIds: new Set(),
            explosiveRadius: area,
          });
        }
        return;
      }

      case 'wind_blade': {
        const spread = count > 1 ? Math.min(0.95, (count - 1) * 0.24) : 0;
        for (let i = 0; i < count; i++) {
          const angle =
            count === 1 ? baseAngle : baseAngle - spread / 2 + (spread * i) / (count - 1);
          this.projectiles.push({
            kind: 'boomerang',
            sourceId: 'wind_blade',
            spriteId: 'arcane',
            color: PALETTE.mint,
            x: p.x,
            y: p.y,
            vx: Math.cos(angle) * stats.speed,
            vy: Math.sin(angle) * stats.speed,
            speed: stats.speed,
            radius: Math.max(14, area * 0.72),
            damage,
            knockback: kb,
            pierceLeft: pierce,
            age: 0,
            maxLife: stats.duration,
            rotation: angle,
            spinSpeed: 12,
            scale: 2.0,
            hitIds: new Set(),
            hitCooldowns: new Map(),
          });
        }
        return;
      }

      case 'ice_shard': {
        const spread = count > 1 ? Math.min(0.65, (count - 1) * 0.13) : 0;
        for (let i = 0; i < count; i++) {
          const angle =
            count === 1 ? baseAngle : baseAngle - spread / 2 + (spread * i) / (count - 1);
          this.projectiles.push({
            kind: 'linear',
            sourceId: 'ice_shard',
            spriteId: 'ice',
            color: PALETTE.babyBlue,
            x: p.x,
            y: p.y,
            vx: Math.cos(angle) * stats.speed,
            vy: Math.sin(angle) * stats.speed,
            speed: stats.speed,
            radius: Math.max(10, area * 0.65),
            damage,
            knockback: kb,
            pierceLeft: pierce,
            age: 0,
            maxLife: stats.duration,
            rotation: angle,
            spinSpeed: 0,
            scale: 1.9,
            hitIds: new Set(),
            chillDuration: 2.0,
            chillFactor: 0.55,
          });
        }
        return;
      }

      case 'frost_nova': {
        this.novas.push({
          sourceId: 'frost_nova',
          x: p.x,
          y: p.y,
          maxRadius: area,
          currentRadius: 12,
          color: PALETTE.babyBlueLight,
          ringColor: PALETTE.babyBlue,
          damage,
          knockback: kb,
          age: 0,
          maxLife: stats.duration,
          hitIds: new Set(),
          chillDuration: 2.6,
          chillFactor: 0.45,
          followPlayer: true,
          killsThisCast: 0,
          lifestealAwarded: false,
        });
        ctx.spawnParticles(p.x, p.y, PALETTE.babyBlueLight, 14, {
          speedMin: 60,
          speedMax: 160,
        });
        return;
      }

      case 'chain_lightning': {
        this.castChainLightning(
          p.x,
          p.y,
          count,
          area,
          damage,
          kb,
          stats.duration,
          PALETTE.butter,
          ctx
        );
        return;
      }

      case 'plasma_beam': {
        const beamCount = Math.min(5, count);
        const beamLength = Math.max(540, Math.hypot(ctx.viewportWidth, ctx.viewportHeight) * 0.62);
        for (let i = 0; i < beamCount; i++) {
          let angle = baseAngle;
          if (beamCount === 2) {
            angle = baseAngle + (i === 0 ? -0.18 : 0.18);
          } else if (beamCount > 2) {
            angle = baseAngle + ((i - (beamCount - 1) / 2) * 0.24);
          }
          this.beams.push({
            sourceId: 'plasma_beam',
            x: p.x,
            y: p.y,
            angle,
            length: beamLength,
            width: area,
            color: PALETTE.rose,
            coreColor: PALETTE.white,
            damage,
            knockback: kb,
            age: 0,
            maxLife: stats.duration,
            hitIds: new Set(),
            secondTickAt: stats.duration * 0.55,
            secondTickDone: false,
            afterglowDone: true,
          });
        }
        return;
      }

      case 'arcane_orb': {
        const orbitRadius = 74 * Math.sqrt(ctx.stats.areaMult);
        this.orbits = this.orbits.filter((o) => o.sourceId !== 'arcane_orb');
        this.orbits.push({
          sourceId: 'arcane_orb',
          visualKind: 'orb',
          spriteId: 'arcane',
          color: PALETTE.lavender,
          count,
          orbitRadius,
          itemRadius: Math.max(14, area * 0.85),
          angularSpeed: stats.speed / Math.max(30, orbitRadius),
          baseAngle: Math.random() * Math.PI * 2,
          damage,
          knockback: kb,
          age: 0,
          maxLife: stats.duration,
          hitCooldowns: new Map(),
        });
        return;
      }

      case 'shadow_bolt': {
        const spread = count > 1 ? Math.min(1.2, (count - 1) * 0.28) : 0;
        for (let i = 0; i < count; i++) {
          const angle =
            count === 1 ? baseAngle : baseAngle - spread / 2 + (spread * i) / (count - 1);
          this.projectiles.push({
            kind: 'homing',
            sourceId: 'shadow_bolt',
            spriteId: 'shadow',
            color: PALETTE.lavenderDark,
            x: p.x,
            y: p.y,
            vx: Math.cos(angle) * stats.speed,
            vy: Math.sin(angle) * stats.speed,
            speed: stats.speed,
            radius: Math.max(11, area * 0.72),
            damage,
            knockback: kb,
            pierceLeft: pierce,
            age: 0,
            maxLife: stats.duration,
            rotation: angle,
            spinSpeed: 4,
            scale: 2.0,
            hitIds: new Set(),
            turnRate: 6.4,
            retargetOnPierce: true,
          });
        }
        return;
      }

      case 'earth_spike': {
        const targets = this.pickTargetEnemies(ctx, count, 380);
        for (let i = 0; i < count; i++) {
          const t = targets[i];
          const tx = t
            ? t.x + (Math.random() - 0.5) * 16
            : p.x + Math.cos(baseAngle + i * 0.9) * (95 + i * 28);
          const ty = t
            ? t.y + (Math.random() - 0.5) * 16
            : p.y + Math.sin(baseAngle + i * 0.9) * (95 + i * 28);
          this.strikes.push({
            sourceId: 'earth_spike',
            visualKind: 'earth_spike',
            x: tx,
            y: ty,
            radius: area,
            color: PALETTE.sage,
            damage,
            knockback: kb,
            delay: 0.14 + i * 0.06,
            elapsed: 0,
            impacted: false,
            lingerTime: stats.duration,
            screenShake: 2.0,
          });
        }
        return;
      }

      case 'meteor_rain': {
        const targets = this.pickTargetEnemies(ctx, count, 430);
        for (let i = 0; i < count; i++) {
          const t = targets[i];
          const tx = t
            ? t.x + (Math.random() - 0.5) * 32
            : p.x + (Math.random() - 0.5) * 340;
          const ty = t
            ? t.y + (Math.random() - 0.5) * 32
            : p.y + (Math.random() - 0.5) * 260;
          this.strikes.push({
            sourceId: 'meteor_rain',
            visualKind: 'meteor',
            spriteId: 'fireball',
            x: tx,
            y: ty,
            radius: area,
            color: PALETTE.peachDark,
            damage,
            knockback: kb,
            delay: 0.42 + i * 0.12,
            elapsed: 0,
            impacted: false,
            lingerTime: stats.duration,
            screenShake: 3.4,
          });
        }
        return;
      }

      // ----------------------------------------------------------------------
      // RANGER (10)
      // ----------------------------------------------------------------------
      case 'twin_pistols': {
        const perpX = -Math.sin(baseAngle);
        const perpY = Math.cos(baseAngle);
        for (let i = 0; i < count; i++) {
          const offset = (i - (count - 1) / 2) * 8;
          const angle = baseAngle + (i - (count - 1) / 2) * 0.055;
          this.projectiles.push({
            kind: 'linear',
            sourceId: 'twin_pistols',
            spriteId: 'bullet',
            color: PALETTE.butter,
            x: p.x + perpX * offset,
            y: p.y + perpY * offset,
            vx: Math.cos(angle) * stats.speed,
            vy: Math.sin(angle) * stats.speed,
            speed: stats.speed,
            radius: Math.max(8, area * 0.75),
            damage,
            knockback: kb,
            pierceLeft: pierce,
            age: 0,
            maxLife: stats.duration,
            rotation: angle,
            spinSpeed: 0,
            scale: 1.75,
            hitIds: new Set(),
          });
        }
        return;
      }

      case 'homing_arrow': {
        const spread = count > 1 ? Math.min(1.0, (count - 1) * 0.22) : 0;
        for (let i = 0; i < count; i++) {
          const angle =
            count === 1 ? baseAngle : baseAngle - spread / 2 + (spread * i) / (count - 1);
          this.projectiles.push({
            kind: 'homing',
            sourceId: 'homing_arrow',
            spriteId: 'arrow',
            color: PALETTE.mint,
            x: p.x,
            y: p.y,
            vx: Math.cos(angle) * stats.speed,
            vy: Math.sin(angle) * stats.speed,
            speed: stats.speed,
            radius: Math.max(9, area * 0.72),
            damage,
            knockback: kb,
            pierceLeft: pierce,
            age: 0,
            maxLife: stats.duration,
            rotation: angle,
            spinSpeed: 0,
            scale: 1.9,
            hitIds: new Set(),
            turnRate: 7.8,
            retargetOnPierce: true,
          });
        }
        return;
      }

      case 'magic_longbow': {
        const spread = count > 1 ? Math.min(0.32, (count - 1) * 0.11) : 0;
        for (let i = 0; i < count; i++) {
          const angle =
            count === 1 ? baseAngle : baseAngle - spread / 2 + (spread * i) / (count - 1);
          this.projectiles.push({
            kind: 'linear',
            sourceId: 'magic_longbow',
            spriteId: 'arrow',
            color: PALETTE.periwinkle,
            x: p.x,
            y: p.y,
            vx: Math.cos(angle) * stats.speed,
            vy: Math.sin(angle) * stats.speed,
            speed: stats.speed,
            radius: Math.max(11, area * 0.68),
            damage,
            knockback: kb,
            pierceLeft: pierce,
            age: 0,
            maxLife: stats.duration,
            rotation: angle,
            spinSpeed: 0,
            scale: 2.25,
            hitIds: new Set(),
          });
        }
        return;
      }

      case 'piercing_rail_bow': {
        const beamCount = Math.min(4, count);
        const railLength = Math.max(760, Math.hypot(ctx.viewportWidth, ctx.viewportHeight) * 0.85);
        for (let i = 0; i < beamCount; i++) {
          const angle =
            beamCount === 1
              ? baseAngle
              : baseAngle + (i - (beamCount - 1) / 2) * 0.14;
          this.beams.push({
            sourceId: 'piercing_rail_bow',
            x: p.x,
            y: p.y,
            angle,
            length: railLength,
            width: area,
            color: PALETTE.babyBlue,
            coreColor: PALETTE.white,
            damage,
            knockback: kb,
            age: 0,
            maxLife: stats.duration,
            hitIds: new Set(),
            secondTickDone: true,
            afterglowDone: true,
          });
        }
        ctx.addScreenShake(2.2, 0.1);
        return;
      }

      case 'shotgun_blast': {
        const coneRad = 0.66; // ~38 degrees
        for (let i = 0; i < count; i++) {
          const t = count === 1 ? 0.5 : i / (count - 1);
          const jitter = (Math.random() - 0.5) * 0.05;
          const angle = baseAngle - coneRad / 2 + coneRad * t + jitter;
          const spd = stats.speed * (0.92 + Math.random() * 0.16);
          this.projectiles.push({
            kind: 'linear',
            sourceId: 'shotgun_blast',
            spriteId: 'bullet',
            color: PALETTE.peach,
            x: p.x,
            y: p.y,
            vx: Math.cos(angle) * spd,
            vy: Math.sin(angle) * spd,
            speed: spd,
            radius: Math.max(8, area * 0.72),
            damage,
            knockback: kb,
            pierceLeft: pierce,
            age: 0,
            maxLife: stats.duration,
            rotation: angle,
            spinSpeed: 0,
            scale: 1.65,
            hitIds: new Set(),
          });
        }
        ctx.spawnParticles(
          p.x + Math.cos(baseAngle) * 18,
          p.y + Math.sin(baseAngle) * 18,
          PALETTE.peachLight,
          7,
          { speedMin: 70, speedMax: 160 }
        );
        return;
      }

      case 'explosive_crossbow': {
        const spread = count > 1 ? Math.min(0.42, (count - 1) * 0.15) : 0;
        for (let i = 0; i < count; i++) {
          const angle =
            count === 1 ? baseAngle : baseAngle - spread / 2 + (spread * i) / (count - 1);
          this.projectiles.push({
            kind: 'linear',
            sourceId: 'explosive_crossbow',
            spriteId: 'arrow',
            color: PALETTE.coral,
            x: p.x,
            y: p.y,
            vx: Math.cos(angle) * stats.speed,
            vy: Math.sin(angle) * stats.speed,
            speed: stats.speed,
            radius: 12,
            damage,
            knockback: kb,
            pierceLeft: pierce,
            age: 0,
            maxLife: stats.duration,
            rotation: angle,
            spinSpeed: 0,
            scale: 2.15,
            hitIds: new Set(),
            explosiveRadius: area,
          });
        }
        return;
      }

      case 'ricochet_revolver': {
        const spread = count > 1 ? Math.min(0.55, (count - 1) * 0.16) : 0;
        for (let i = 0; i < count; i++) {
          const angle =
            count === 1 ? baseAngle : baseAngle - spread / 2 + (spread * i) / (count - 1);
          this.projectiles.push({
            kind: 'ricochet',
            sourceId: 'ricochet_revolver',
            spriteId: 'bullet',
            color: PALETTE.rose,
            x: p.x,
            y: p.y,
            vx: Math.cos(angle) * stats.speed,
            vy: Math.sin(angle) * stats.speed,
            speed: stats.speed,
            radius: Math.max(9, area * 0.72),
            damage,
            knockback: kb,
            pierceLeft: Math.max(1, pierce),
            age: 0,
            maxLife: stats.duration,
            rotation: angle,
            spinSpeed: 0,
            scale: 1.85,
            hitIds: new Set(),
          });
        }
        return;
      }

      case 'frost_quiver': {
        const spread = count > 1 ? Math.min(0.62, (count - 1) * 0.14) : 0;
        for (let i = 0; i < count; i++) {
          const angle =
            count === 1 ? baseAngle : baseAngle - spread / 2 + (spread * i) / (count - 1);
          this.projectiles.push({
            kind: 'linear',
            sourceId: 'frost_quiver',
            spriteId: 'ice',
            color: PALETTE.babyBlue,
            x: p.x,
            y: p.y,
            vx: Math.cos(angle) * stats.speed,
            vy: Math.sin(angle) * stats.speed,
            speed: stats.speed,
            radius: Math.max(10, area * 0.65),
            damage,
            knockback: kb,
            pierceLeft: pierce,
            age: 0,
            maxLife: stats.duration,
            rotation: angle,
            spinSpeed: 0,
            scale: 2.0,
            hitIds: new Set(),
            chillDuration: 2.2,
            chillFactor: 0.5,
          });
        }
        return;
      }

      case 'gatling_turret': {
        const maxTurrets = count;
        const existing = this.turrets.filter((t) => t.sourceId === 'gatling_turret');
        if (existing.length >= maxTurrets) {
          const oldest = existing[0];
          const idx = this.turrets.indexOf(oldest);
          if (idx >= 0) this.turrets.splice(idx, 1);
        }
        const placeAngle = baseAngle + (Math.random() - 0.5) * 0.9;
        const tx = p.x + Math.cos(placeAngle) * 44;
        const ty = p.y + Math.sin(placeAngle) * 44;
        this.turrets.push({
          sourceId: 'gatling_turret',
          x: tx,
          y: ty,
          angle: baseAngle,
          range: area,
          damage,
          speed: stats.speed,
          pierce,
          knockback: kb,
          color: PALETTE.sage,
          age: 0,
          maxLife: stats.duration,
          fireTimer: 0.08,
          fireInterval: 0.25,
          barrageTimer: 999,
          isArtillery: false,
        });
        ctx.spawnRingParticle(tx, ty, PALETTE.sage, 30, 0.25);
        return;
      }

      case 'rain_of_arrows': {
        const target = this.pickTargetEnemies(ctx, 1, 400)[0];
        const cx = target ? target.x : p.x + Math.cos(baseAngle) * 150;
        const cy = target ? target.y : p.y + Math.sin(baseAngle) * 150;
        for (let i = 0; i < count; i++) {
          const jx = (Math.random() - 0.5) * area * 0.5;
          const jy = (Math.random() - 0.5) * area * 0.5;
          this.strikes.push({
            sourceId: 'rain_of_arrows',
            visualKind: 'arrow_rain',
            spriteId: 'arrow',
            x: cx + jx,
            y: cy + jy,
            radius: area,
            color: PALETTE.mintDark,
            damage,
            knockback: kb,
            delay: 0.22 + i * 0.13,
            elapsed: 0,
            impacted: false,
            lingerTime: 0.32,
          });
        }
        return;
      }

      // ----------------------------------------------------------------------
      // KNIGHT (10)
      // ----------------------------------------------------------------------
      case 'greatsword_cleave': {
        const swings = Math.min(4, count);
        for (let i = 0; i < swings; i++) {
          const swingAngle = i % 2 === 0 ? baseAngle : baseAngle + Math.PI;
          const delay = i * 0.11;
          const spawnSwing = (): void => {
            this.meleeArcs.push({
              sourceId: 'greatsword_cleave',
              visualKind: 'greatsword',
              angle: swingAngle,
              arcSpread: 2.35, // ~135°
              radius: area,
              color: PALETTE.peach,
              damage,
              knockback: kb,
              age: 0,
              maxLife: stats.duration,
              hitIds: new Set(),
            });
          };
          if (delay === 0) {
            spawnSwing();
          } else {
            this.delayedCasts.push({ timer: delay, action: spawnSwing });
          }
        }
        return;
      }

      case 'orbiting_blades': {
        const orbitRadius = 78 * Math.sqrt(ctx.stats.areaMult);
        this.orbits = this.orbits.filter((o) => o.sourceId !== 'orbiting_blades');
        this.orbits.push({
          sourceId: 'orbiting_blades',
          visualKind: 'blade',
          color: PALETTE.periwinkle,
          count,
          orbitRadius,
          itemRadius: Math.max(16, area * 0.85),
          angularSpeed: stats.speed / Math.max(30, orbitRadius),
          baseAngle: Math.random() * Math.PI * 2,
          damage,
          knockback: kb,
          age: 0,
          maxLife: stats.duration,
          hitCooldowns: new Map(),
        });
        return;
      }

      case 'shield_bash': {
        const bashes = Math.min(4, count);
        for (let i = 0; i < bashes; i++) {
          const delay = i * 0.14;
          const spawnBash = (): void => {
            const aimNow = this.getAimAngle(ctx);
            this.meleeArcs.push({
              sourceId: 'shield_bash',
              visualKind: 'shield',
              angle: aimNow,
              arcSpread: 1.9, // ~110°
              radius: area,
              color: PALETTE.babyBlue,
              damage,
              knockback: kb,
              age: 0,
              maxLife: stats.duration,
              hitIds: new Set(),
            });
            ctx.addScreenShake(2.2, 0.1);
          };
          if (delay === 0) {
            spawnBash();
          } else {
            this.delayedCasts.push({ timer: delay, action: spawnBash });
          }
        }
        return;
      }

      case 'shockwave_stomp': {
        this.novas.push({
          sourceId: 'shockwave_stomp',
          x: p.x,
          y: p.y,
          maxRadius: area,
          currentRadius: 14,
          color: PALETTE.butter,
          ringColor: PALETTE.cream,
          damage,
          knockback: kb,
          age: 0,
          maxLife: stats.duration,
          hitIds: new Set(),
          followPlayer: true,
          killsThisCast: 0,
          lifestealAwarded: false,
        });
        ctx.addScreenShake(3.2, 0.14);
        ctx.spawnParticles(p.x, p.y, PALETTE.butter, 12, {
          speedMin: 70,
          speedMax: 165,
        });
        return;
      }

      case 'spinning_axe': {
        const spread = count > 1 ? Math.min(1.1, (count - 1) * 0.28) : 0;
        for (let i = 0; i < count; i++) {
          const angle =
            count === 1 ? baseAngle : baseAngle - spread / 2 + (spread * i) / (count - 1);
          this.projectiles.push({
            kind: 'boomerang',
            sourceId: 'spinning_axe',
            spriteId: 'axe',
            color: PALETTE.coral,
            x: p.x,
            y: p.y,
            vx: Math.cos(angle) * stats.speed,
            vy: Math.sin(angle) * stats.speed,
            speed: stats.speed,
            radius: Math.max(16, area * 0.75),
            damage,
            knockback: kb,
            pierceLeft: pierce,
            age: 0,
            maxLife: stats.duration,
            rotation: angle,
            spinSpeed: 15,
            scale: 2.2,
            hitIds: new Set(),
            hitCooldowns: new Map(),
          });
        }
        return;
      }

      case 'chain_flail': {
        const orbitRadius = 94 * Math.sqrt(ctx.stats.areaMult);
        this.orbits = this.orbits.filter((o) => o.sourceId !== 'chain_flail');
        this.orbits.push({
          sourceId: 'chain_flail',
          visualKind: 'flail',
          color: PALETTE.slateLight,
          count,
          orbitRadius,
          itemRadius: Math.max(18, area * 0.8),
          angularSpeed: (stats.speed * 1.15) / Math.max(30, orbitRadius),
          baseAngle,
          damage,
          knockback: kb,
          age: 0,
          maxLife: stats.duration,
          hitCooldowns: new Map(),
        });
        return;
      }

      case 'ground_slam': {
        for (let i = 0; i < count; i++) {
          const dist = 76 + i * (area * 0.95);
          const sx = p.x + Math.cos(baseAngle) * dist;
          const sy = p.y + Math.sin(baseAngle) * dist;
          this.strikes.push({
            sourceId: 'ground_slam',
            visualKind: 'ground_slam',
            x: sx,
            y: sy,
            radius: area,
            color: PALETTE.peachDark,
            damage,
            knockback: kb,
            delay: 0.1 + i * 0.12,
            elapsed: 0,
            impacted: false,
            lingerTime: stats.duration,
            screenShake: 3.5,
          });
        }
        return;
      }

      case 'holy_hammer': {
        const targets = this.pickTargetEnemies(ctx, count, 380);
        for (let i = 0; i < count; i++) {
          const t = targets[i];
          const hx = t
            ? t.x + (Math.random() - 0.5) * 18
            : p.x + Math.cos(baseAngle + i * 1.2) * 120;
          const hy = t
            ? t.y + (Math.random() - 0.5) * 18
            : p.y + Math.sin(baseAngle + i * 1.2) * 120;
          this.strikes.push({
            sourceId: 'holy_hammer',
            visualKind: 'holy_hammer',
            spriteId: 'hammer',
            x: hx,
            y: hy,
            radius: area,
            color: PALETTE.butterLight,
            damage,
            knockback: kb,
            delay: 0.34 + i * 0.11,
            elapsed: 0,
            impacted: false,
            lingerTime: stats.duration,
            screenShake: 3.0,
          });
        }
        return;
      }

      case 'spear_thrust': {
        const thrusts = Math.min(5, count);
        const reach = 175 * ctx.stats.areaMult;
        for (let i = 0; i < thrusts; i++) {
          const delay = i * 0.085;
          const angleOffset = thrusts === 1 ? 0 : (i - (thrusts - 1) / 2) * 0.16;
          const spawnThrust = (): void => {
            const aimNow = this.getAimAngle(ctx) + angleOffset;
            this.beams.push({
              sourceId: 'spear_thrust',
              spriteId: 'spear',
              x: ctx.player.x,
              y: ctx.player.y,
              angle: aimNow,
              length: reach,
              width: area,
              color: PALETTE.mint,
              coreColor: PALETTE.cream,
              damage,
              knockback: kb,
              age: 0,
              maxLife: stats.duration,
              hitIds: new Set(),
              secondTickDone: true,
              afterglowDone: true,
            });
          };
          if (delay === 0) {
            spawnThrust();
          } else {
            this.delayedCasts.push({ timer: delay, action: spawnThrust });
          }
        }
        return;
      }

      case 'blade_dash': {
        const dashes = Math.min(5, count);
        const spread = dashes > 1 ? Math.min(0.85, (dashes - 1) * 0.28) : 0;
        for (let i = 0; i < dashes; i++) {
          const angle =
            dashes === 1 ? baseAngle : baseAngle - spread / 2 + (spread * i) / (dashes - 1);
          this.projectiles.push({
            kind: 'dash',
            sourceId: 'blade_dash',
            color: PALETTE.rose,
            x: p.x,
            y: p.y,
            vx: Math.cos(angle) * stats.speed,
            vy: Math.sin(angle) * stats.speed,
            speed: stats.speed,
            radius: Math.max(20, area * 0.8),
            damage,
            knockback: kb,
            pierceLeft: 999,
            age: 0,
            maxLife: stats.duration,
            rotation: angle,
            spinSpeed: 0,
            scale: 2.2,
            hitIds: new Set(),
            leaveTrail: true,
            trailTimer: 0,
          });
        }
        return;
      }

      default:
        assertNever(id);
    }
  }

  // ==========================================================================
  // EXECUTION FOR ALL 15 EVOLVED SYNERGIES (EXHAUSTIVE)
  // ==========================================================================

  private executeSynergy(id: SynergyId, stats: AbilityStats, ctx: CombatContext): void {
    const p = ctx.player;
    const damage = stats.damage * ctx.stats.damageMult;
    const area = stats.area * ctx.stats.areaMult;
    const kb = (stats.knockback ?? 0) * ctx.stats.knockbackMult;
    const count = Math.max(1, stats.count + ctx.stats.projectileBonus);
    const pierce = stats.pierce >= 999 ? 999 : stats.pierce + ctx.stats.pierceBonus;
    const baseAngle = this.getAimAngle(ctx);

    switch (id) {
      // ----------------------------------------------------------------------
      // MAGE SYNERGIES (5)
      // ----------------------------------------------------------------------
      case 'firestorm': {
        // Blazing tornado fireballs: pull_vortex, burn_dot, explosive_finish
        for (let i = 0; i < count; i++) {
          const angle = baseAngle + (i * Math.PI * 2) / count;
          this.projectiles.push({
            kind: 'spiral_boomerang',
            sourceId: 'firestorm',
            spriteId: 'fireball',
            color: PALETTE.coral,
            x: p.x,
            y: p.y,
            vx: Math.cos(angle) * stats.speed,
            vy: Math.sin(angle) * stats.speed,
            speed: stats.speed,
            radius: Math.max(26, area * 0.58),
            damage,
            knockback: kb,
            pierceLeft: 999,
            age: 0,
            maxLife: stats.duration,
            rotation: angle,
            spinSpeed: 14,
            scale: 2.8,
            hitIds: new Set(),
            hitCooldowns: new Map(),
            pullRadius: area * 1.5,
            pullStrength: 175,
            burnDps: damage * 0.28,
            burnDuration: 2.5,
            burnColor: PALETTE.coral,
            explosiveRadius: area * 1.35,
            explosiveFinish: true,
            spiralDir: i % 2 === 0 ? 1 : -1,
          });
        }
        return;
      }

      case 'absolute_zero': {
        // Massive frost nova (freeze_slow) + radial_ice_lances (shatter_bonus)
        this.novas.push({
          sourceId: 'absolute_zero',
          x: p.x,
          y: p.y,
          maxRadius: area,
          currentRadius: 16,
          color: PALETTE.babyBlueLight,
          ringColor: PALETTE.babyBlue,
          damage,
          knockback: kb,
          age: 0,
          maxLife: 0.55,
          hitIds: new Set(),
          chillDuration: 3.5,
          chillFactor: 0.4,
          freezeDuration: 1.65,
          followPlayer: true,
          killsThisCast: 0,
          lifestealAwarded: false,
        });

        for (let i = 0; i < count; i++) {
          const angle = baseAngle + (i * Math.PI * 2) / count;
          this.projectiles.push({
            kind: 'linear',
            sourceId: 'absolute_zero',
            spriteId: 'ice',
            color: PALETTE.babyBlue,
            x: p.x,
            y: p.y,
            vx: Math.cos(angle) * stats.speed,
            vy: Math.sin(angle) * stats.speed,
            speed: stats.speed,
            radius: 15,
            damage: damage * 0.85,
            knockback: kb * 0.7,
            pierceLeft: 999,
            age: 0,
            maxLife: stats.duration,
            rotation: angle,
            spinSpeed: 0,
            scale: 2.4,
            hitIds: new Set(),
            chillDuration: 2.8,
            chillFactor: 0.45,
            shatterBonus: true,
          });
        }
        ctx.spawnParticles(p.x, p.y, PALETTE.babyBlueLight, 22, {
          speedMin: 80,
          speedMax: 220,
        });
        ctx.addScreenShake(3.2, 0.16);
        return;
      }

      case 'tempest_lance': {
        // Dual high-voltage screen-wide beams + chain_arc_on_hit + crit_surge
        const beamCount = Math.min(4, count);
        const beamLength = Math.max(840, Math.hypot(ctx.viewportWidth, ctx.viewportHeight) * 0.95);
        for (let i = 0; i < beamCount; i++) {
          const angle =
            beamCount === 1
              ? baseAngle
              : baseAngle + (i - (beamCount - 1) / 2) * 0.24;
          this.beams.push({
            sourceId: 'tempest_lance',
            x: p.x,
            y: p.y,
            angle,
            length: beamLength,
            width: area,
            color: PALETTE.butter,
            coreColor: PALETTE.white,
            damage,
            knockback: kb,
            age: 0,
            maxLife: stats.duration,
            hitIds: new Set(),
            secondTickAt: stats.duration * 0.5,
            secondTickDone: false,
            chainArcCount: 4,
            chainArcRange: 145 * ctx.stats.areaMult,
            bonusCritChance: 0.2,
            afterglowDone: true,
          });
        }
        ctx.addScreenShake(4.0, 0.18);
        return;
      }

      case 'eclipse_singularity': {
        // Perpetual dark-arcane orbiting orbs + emit_homing_bolts + gravity_drag
        const orbitRadius = 88 * Math.sqrt(ctx.stats.areaMult);
        const existing = this.orbits.find((o) => o.sourceId === 'eclipse_singularity');
        const startAngle = existing ? existing.baseAngle : Math.random() * Math.PI * 2;
        this.orbits = this.orbits.filter((o) => o.sourceId !== 'eclipse_singularity');
        this.orbits.push({
          sourceId: 'eclipse_singularity',
          visualKind: 'singularity',
          spriteId: 'shadow',
          color: PALETTE.lavenderDark,
          count,
          orbitRadius,
          itemRadius: Math.max(20, area * 0.8),
          angularSpeed: stats.speed / Math.max(30, orbitRadius),
          baseAngle: startAngle,
          damage,
          knockback: kb,
          age: 0,
          maxLife: Math.max(stats.duration, stats.cooldown * ctx.stats.cooldownMult + 0.35),
          hitCooldowns: existing ? existing.hitCooldowns : new Map(),
          emitBoltTimer: 0.35,
          gravityDragRadius: 115 * ctx.stats.areaMult,
        });
        return;
      }

      case 'cataclysm': {
        // Colossal meteors + radial_earth_spikes + heavy_screen_shake + seismic_knockback
        const targets = this.pickTargetEnemies(ctx, count, 480);
        for (let i = 0; i < count; i++) {
          const t = targets[i];
          const mx = t
            ? t.x + (Math.random() - 0.5) * 40
            : p.x + (Math.random() - 0.5) * 380;
          const my = t
            ? t.y + (Math.random() - 0.5) * 40
            : p.y + (Math.random() - 0.5) * 280;
          this.strikes.push({
            sourceId: 'cataclysm',
            visualKind: 'cataclysm_meteor',
            spriteId: 'fireball',
            x: mx,
            y: my,
            radius: area,
            color: PALETTE.peachDark,
            damage,
            knockback: kb,
            delay: 0.4 + i * 0.11,
            elapsed: 0,
            impacted: false,
            lingerTime: stats.duration,
            radialEarthSpikes: true,
            screenShake: 6.2,
          });
        }
        return;
      }

      // ----------------------------------------------------------------------
      // RANGER SYNERGIES (5)
      // ----------------------------------------------------------------------
      case 'smart_bullets': {
        // Rapid curving auto-lock rounds: rapid_homing, retarget_on_pierce, crit_precision
        const spread = Math.min(1.1, (count - 1) * 0.16);
        for (let i = 0; i < count; i++) {
          const angle =
            count === 1 ? baseAngle : baseAngle - spread / 2 + (spread * i) / (count - 1);
          this.projectiles.push({
            kind: 'homing',
            sourceId: 'smart_bullets',
            spriteId: 'bullet',
            color: PALETTE.mint,
            x: p.x,
            y: p.y,
            vx: Math.cos(angle) * stats.speed,
            vy: Math.sin(angle) * stats.speed,
            speed: stats.speed,
            radius: Math.max(10, area * 0.72),
            damage,
            knockback: kb,
            pierceLeft: pierce,
            age: 0,
            maxLife: stats.duration,
            rotation: angle,
            spinSpeed: 0,
            scale: 2.0,
            hitIds: new Set(),
            turnRate: 11.5,
            retargetOnPierce: true,
            bonusCritChance: 0.15,
          });
        }
        return;
      }

      case 'starlight_railgun': {
        // 3 synchronized screen-wide starlight beams + bonus_crit_mult + starlight_afterglow
        const beamCount = Math.min(5, count);
        const railLength = Math.max(880, Math.hypot(ctx.viewportWidth, ctx.viewportHeight) * 1.0);
        for (let i = 0; i < beamCount; i++) {
          const angle =
            beamCount === 1
              ? baseAngle
              : baseAngle + (i - (beamCount - 1) / 2) * 0.13;
          this.beams.push({
            sourceId: 'starlight_railgun',
            x: p.x,
            y: p.y,
            angle,
            length: railLength,
            width: area,
            color: PALETTE.periwinkle,
            coreColor: PALETTE.white,
            damage,
            knockback: kb,
            age: 0,
            maxLife: stats.duration,
            hitIds: new Set(),
            secondTickDone: true,
            bonusCritChance: 0.25,
            bonusCritMult: 0.5,
            afterglowAt: 0.22,
            afterglowDone: false,
          });
        }
        ctx.addScreenShake(4.5, 0.16);
        return;
      }

      case 'cluster_cannon': {
        // Wide cone of explosive shrapnel shells: explosive_cone, cluster_shrapnel, heavy_knockback
        const coneRad = 0.78;
        for (let i = 0; i < count; i++) {
          const t = count === 1 ? 0.5 : i / (count - 1);
          const angle = baseAngle - coneRad / 2 + coneRad * t;
          this.projectiles.push({
            kind: 'linear',
            sourceId: 'cluster_cannon',
            spriteId: 'fireball',
            color: PALETTE.coral,
            x: p.x,
            y: p.y,
            vx: Math.cos(angle) * stats.speed,
            vy: Math.sin(angle) * stats.speed,
            speed: stats.speed,
            radius: 14,
            damage,
            knockback: kb,
            pierceLeft: pierce,
            age: 0,
            maxLife: stats.duration,
            rotation: angle,
            spinSpeed: 0,
            scale: 2.3,
            hitIds: new Set(),
            explosiveRadius: area,
            clusterShrapnelCount: 4,
          });
        }
        ctx.addScreenShake(3.8, 0.14);
        return;
      }

      case 'glacial_ricochet': {
        // Hyper-bouncing frost slugs: freeze_slow, splinter_on_bounce, high_ricochet
        const spread = count > 1 ? Math.min(0.75, (count - 1) * 0.16) : 0;
        for (let i = 0; i < count; i++) {
          const angle =
            count === 1 ? baseAngle : baseAngle - spread / 2 + (spread * i) / (count - 1);
          this.projectiles.push({
            kind: 'ricochet',
            sourceId: 'glacial_ricochet',
            spriteId: 'ice',
            color: PALETTE.babyBlue,
            x: p.x,
            y: p.y,
            vx: Math.cos(angle) * stats.speed,
            vy: Math.sin(angle) * stats.speed,
            speed: stats.speed,
            radius: Math.max(12, area * 0.65),
            damage,
            knockback: kb,
            pierceLeft: Math.max(8, pierce),
            age: 0,
            maxLife: stats.duration,
            rotation: angle,
            spinSpeed: 0,
            scale: 2.15,
            hitIds: new Set(),
            chillDuration: 2.5,
            chillFactor: 0.45,
            splinterOnBounce: true,
          });
        }
        return;
      }

      case 'artillery_barrage': {
        // Up to 3 twin-barrel artillery turrets: turret_calls_arrow_rain, rapid_turret_fire, extended_range
        const maxTurrets = count;
        const existing = this.turrets.filter((t) => t.sourceId === 'artillery_barrage');
        if (existing.length >= maxTurrets) {
          const oldest = existing[0];
          const idx = this.turrets.indexOf(oldest);
          if (idx >= 0) this.turrets.splice(idx, 1);
        }
        const placeAngle = baseAngle + (existing.length * 2.1) + (Math.random() - 0.5) * 0.5;
        const tx = p.x + Math.cos(placeAngle) * 54;
        const ty = p.y + Math.sin(placeAngle) * 54;
        this.turrets.push({
          sourceId: 'artillery_barrage',
          x: tx,
          y: ty,
          angle: baseAngle,
          range: area,
          damage,
          speed: stats.speed,
          pierce,
          knockback: kb,
          color: PALETTE.sage,
          age: 0,
          maxLife: stats.duration,
          fireTimer: 0.06,
          fireInterval: 0.21,
          barrageTimer: 0.9,
          isArtillery: true,
        });
        ctx.spawnRingParticle(tx, ty, PALETTE.mint, 42, 0.3);
        return;
      }

      // ----------------------------------------------------------------------
      // KNIGHT SYNERGIES (5)
      // ----------------------------------------------------------------------
      case 'whirlwind_tempest': {
        // 6 giant orbiting porcelain greatswords + 360_cleave_pulse + perpetual_orbit
        const orbitRadius = Math.max(82, area * 0.88);
        const existing = this.orbits.find((o) => o.sourceId === 'whirlwind_tempest');
        const startAngle = existing ? existing.baseAngle : baseAngle;
        this.orbits = this.orbits.filter((o) => o.sourceId !== 'whirlwind_tempest');
        this.orbits.push({
          sourceId: 'whirlwind_tempest',
          visualKind: 'greatsword',
          color: PALETTE.peach,
          count,
          orbitRadius,
          itemRadius: Math.max(24, area * 0.28),
          angularSpeed: stats.speed / Math.max(36, orbitRadius),
          baseAngle: startAngle,
          damage,
          knockback: kb,
          age: 0,
          maxLife: Math.max(stats.duration, stats.cooldown * ctx.stats.cooldownMult + 0.35),
          hitCooldowns: existing ? existing.hitCooldowns : new Map(),
          cleavePulseTimer: 0.05,
        });
        return;
      }

      case 'bastion_quake': {
        // Double-ringed porcelain bastion quake: double_shockwave_ring, massive_knockback, micro_stun
        const rings = Math.max(2, stats.count);
        for (let i = 0; i < rings; i++) {
          const delay = i * 0.22;
          const spawnRing = (): void => {
            this.novas.push({
              sourceId: 'bastion_quake',
              x: ctx.player.x,
              y: ctx.player.y,
              maxRadius: area * (i === 0 ? 0.88 : 1.08),
              currentRadius: 16,
              color: PALETTE.babyBlue,
              ringColor: PALETTE.cream,
              damage,
              knockback: kb,
              age: 0,
              maxLife: stats.duration,
              hitIds: new Set(),
              stunDuration: 0.55,
              followPlayer: true,
              killsThisCast: 0,
              lifestealAwarded: false,
            });
            ctx.addScreenShake(5.0, 0.2);
            ctx.spawnParticles(ctx.player.x, ctx.player.y, PALETTE.babyBlueLight, 18, {
              speedMin: 90,
              speedMax: 230,
            });
          };
          if (delay === 0) {
            spawnRing();
          } else {
            this.delayedCasts.push({ timer: delay, action: spawnRing });
          }
        }
        return;
      }

      case 'reapers_pendulum': {
        // Heavy spiraling boomerang flail-axes: spiral_boomerang, bleed_bonus_crit, infinite_pierce
        for (let i = 0; i < count; i++) {
          const angle = baseAngle + (i * Math.PI * 2) / count;
          this.projectiles.push({
            kind: 'spiral_boomerang',
            sourceId: 'reapers_pendulum',
            spriteId: 'axe',
            color: PALETTE.coralDark,
            x: p.x,
            y: p.y,
            vx: Math.cos(angle) * stats.speed,
            vy: Math.sin(angle) * stats.speed,
            speed: stats.speed,
            radius: Math.max(22, area * 0.72),
            damage,
            knockback: kb,
            pierceLeft: 999,
            age: 0,
            maxLife: stats.duration,
            rotation: angle,
            spinSpeed: 18,
            scale: 2.6,
            hitIds: new Set(),
            hitCooldowns: new Map(),
            tetherToPlayer: true,
            bonusCritChance: 0.2,
            burnDps: damage * 0.2,
            burnDuration: 2.0,
            burnColor: PALETTE.coralDark,
            spiralDir: i % 2 === 0 ? 1 : -1,
          });
        }
        return;
      }

      case 'divine_judgment': {
        // Towering holy hammers + seismic_aftershock + holy_crater + minor_lifesteal
        const targets = this.pickTargetEnemies(ctx, count, 450);
        for (let i = 0; i < count; i++) {
          const t = targets[i];
          const hx = t
            ? t.x + (Math.random() - 0.5) * 28
            : p.x + Math.cos(baseAngle + i * 1.25) * 145;
          const hy = t
            ? t.y + (Math.random() - 0.5) * 28
            : p.y + Math.sin(baseAngle + i * 1.25) * 145;
          this.strikes.push({
            sourceId: 'divine_judgment',
            visualKind: 'divine_hammer',
            spriteId: 'hammer',
            x: hx,
            y: hy,
            radius: area,
            color: PALETTE.butter,
            damage,
            knockback: kb,
            delay: 0.36 + i * 0.1,
            elapsed: 0,
            impacted: false,
            lingerTime: stats.duration,
            seismicAftershock: true,
            lifestealOnMultiKill: true,
            screenShake: 5.5,
          });
        }
        return;
      }

      case 'valkyrie_blitz': {
        // 4 high-speed valkyrie spear phantoms: multi_phantom_dash, piercing_trail, high_speed_blitz
        const targets = this.pickTargetEnemies(ctx, count, 460);
        for (let i = 0; i < count; i++) {
          const t = targets[i];
          const angle = t
            ? Math.atan2(t.y - p.y, t.x - p.x) + (i - (count - 1) / 2) * 0.08
            : baseAngle + (i - (count - 1) / 2) * 0.35;
          this.projectiles.push({
            kind: 'dash',
            sourceId: 'valkyrie_blitz',
            spriteId: 'spear',
            color: PALETTE.rose,
            x: p.x,
            y: p.y,
            vx: Math.cos(angle) * stats.speed,
            vy: Math.sin(angle) * stats.speed,
            speed: stats.speed,
            radius: Math.max(24, area * 0.72),
            damage,
            knockback: kb,
            pierceLeft: 999,
            age: 0,
            maxLife: stats.duration,
            rotation: angle,
            spinSpeed: 0,
            scale: 2.5,
            hitIds: new Set(),
            leaveTrail: true,
            trailTimer: 0,
            dashChainCount: 2,
          });
        }
        return;
      }

      default:
        assertNever(id);
    }
  }

  // ==========================================================================
  // SUBSYSTEM UPDATE LOOPS
  // ==========================================================================

  private updateProjectiles(dt: number, ctx: CombatContext): void {
    const p = ctx.player;

    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const proj = this.projectiles[i];
      proj.age += dt;
      const expired = proj.age >= proj.maxLife;

      if (expired) {
        if (proj.explosiveFinish && proj.explosiveRadius) {
          this.triggerExplosion(
            proj.x,
            proj.y,
            proj.explosiveRadius,
            proj.damage * 1.15,
            proj.knockback * 1.4,
            proj.color,
            ctx,
            proj.burnDps,
            proj.burnDuration
          );
        }
        this.projectiles.splice(i, 1);
        continue;
      }

      // Tick per-enemy hit cooldowns if used
      if (proj.hitCooldowns) {
        for (const [eid, cd] of proj.hitCooldowns) {
          const next = cd - dt;
          if (next <= 0) proj.hitCooldowns.delete(eid);
          else proj.hitCooldowns.set(eid, next);
        }
      }

      // Motion behavior per projectile kind
      if (proj.kind === 'homing') {
        const target = ctx.spatialHash.findNearest(
          proj.x,
          proj.y,
          360,
          (e) => e.alive && !proj.hitIds.has(e.id)
        );
        if (target) {
          const curAngle = Math.atan2(proj.vy, proj.vx);
          const desired = Math.atan2(target.y - proj.y, target.x - proj.x);
          const diff = normalizeAngle(desired - curAngle);
          const maxTurn = (proj.turnRate ?? 7) * dt;
          const nextAngle = curAngle + Math.max(-maxTurn, Math.min(maxTurn, diff));
          proj.vx = Math.cos(nextAngle) * proj.speed;
          proj.vy = Math.sin(nextAngle) * proj.speed;
          if (proj.spinSpeed === 0) proj.rotation = nextAngle;
        }
      } else if (proj.kind === 'boomerang') {
        const t = proj.age / proj.maxLife;
        if (t > 0.38) {
          if (!proj.boomerangReturned) {
            proj.boomerangReturned = true;
            proj.hitIds.clear();
          }
          const dx = p.x - proj.x;
          const dy = p.y - proj.y;
          const dist = Math.hypot(dx, dy);
          if (dist > 1) {
            const accel = proj.speed * 3.4;
            proj.vx += (dx / dist) * accel * dt;
            proj.vy += (dy / dist) * accel * dt;
            const curSpd = Math.hypot(proj.vx, proj.vy);
            if (curSpd > proj.speed * 1.25) {
              proj.vx = (proj.vx / curSpd) * proj.speed * 1.25;
              proj.vy = (proj.vy / curSpd) * proj.speed * 1.25;
            }
          }
          if (t > 0.65 && dist < 24) {
            this.projectiles.splice(i, 1);
            continue;
          }
        } else {
          // Gentle outbound deceleration
          const drag = Math.max(0.25, 1 - 1.35 * dt);
          proj.vx *= drag;
          proj.vy *= drag;
        }
      } else if (proj.kind === 'spiral_boomerang') {
        const t = proj.age / proj.maxLife;
        const dir = proj.spiralDir ?? 1;
        const dx = p.x - proj.x;
        const dy = p.y - proj.y;
        const dist = Math.max(1, Math.hypot(dx, dy));
        // Combine radial pull back toward player after 0.35t with perpendicular swirl
        const radialWeight = t < 0.35 ? -0.35 : 1.75;
        const perpX = (-dy / dist) * dir;
        const perpY = (dx / dist) * dir;
        const ax = ((dx / dist) * radialWeight + perpX * 1.35) * proj.speed * 2.0;
        const ay = ((dy / dist) * radialWeight + perpY * 1.35) * proj.speed * 2.0;
        proj.vx += ax * dt;
        proj.vy += ay * dt;
        const curSpd = Math.hypot(proj.vx, proj.vy);
        if (curSpd > proj.speed * 1.2) {
          proj.vx = (proj.vx / curSpd) * proj.speed * 1.2;
          proj.vy = (proj.vy / curSpd) * proj.speed * 1.2;
        }
      } else if (proj.kind === 'dash' && proj.leaveTrail) {
        proj.trailTimer = (proj.trailTimer ?? 0) - dt;
        if (proj.trailTimer <= 0) {
          proj.trailTimer = 0.045;
          if (proj.sourceId === 'valkyrie_blitz') {
            // Piercing damage trail behind valkyrie spear phantoms
            const segLen = 36;
            const dir = Math.atan2(proj.vy, proj.vx);
            this.trails.push({
              kind: 'damage_lane',
              x: proj.x - Math.cos(dir) * segLen,
              y: proj.y - Math.sin(dir) * segLen,
              x2: proj.x,
              y2: proj.y,
              radius: proj.radius * 0.72,
              color: PALETTE.rose,
              damage: proj.damage * 0.35,
              knockback: proj.knockback * 0.4,
              age: 0,
              maxLife: 0.45,
              hitCooldowns: new Map(),
            });
          } else {
            // Blade dash visual phantom afterimage
            this.trails.push({
              kind: 'afterimage',
              x: proj.x,
              y: proj.y,
              x2: proj.x,
              y2: proj.y,
              radius: proj.radius,
              color: proj.color,
              damage: 0,
              knockback: 0,
              age: 0,
              maxLife: 0.24,
              hitCooldowns: new Map(),
              heroId: p.heroId,
              facingLeft: proj.vx < 0,
            });
          }
        }
      }

      // Advance position & rotation
      proj.x += proj.vx * dt;
      proj.y += proj.vy * dt;
      if (proj.spinSpeed !== 0) {
        proj.rotation += proj.spinSpeed * dt;
      }

      // Firestorm pull_vortex mechanic
      if (proj.pullRadius && proj.pullStrength) {
        const pulled = ctx.spatialHash.queryRadius(
          proj.x,
          proj.y,
          proj.pullRadius,
          this.queryBuf
        );
        for (let k = 0; k < pulled.length; k++) {
          const enemy = pulled[k];
          if (!enemy.alive) continue;
          const dx = proj.x - enemy.x;
          const dy = proj.y - enemy.y;
          const dist = Math.hypot(dx, dy);
          if (dist > 8) {
            const pull = proj.pullStrength * (1 - enemy.knockbackResist * 0.7) * dt;
            enemy.x += (dx / dist) * pull;
            enemy.y += (dy / dist) * pull;
          }
        }
      }

      // Collision check against spatial hash
      const hits = ctx.spatialHash.queryRadius(proj.x, proj.y, proj.radius, this.queryBuf);
      let destroyed = false;

      for (let h = 0; h < hits.length; h++) {
        const enemy = hits[h];
        if (!enemy.alive) continue;

        if (proj.hitCooldowns) {
          if (proj.hitCooldowns.has(enemy.id)) continue;
          proj.hitCooldowns.set(enemy.id, 0.28);
        } else {
          if (proj.hitIds.has(enemy.id)) continue;
          proj.hitIds.add(enemy.id);
        }

        // Apply direct or explosive hit
        if (proj.explosiveRadius && !proj.explosiveFinish) {
          this.triggerExplosion(
            proj.x,
            proj.y,
            proj.explosiveRadius,
            proj.damage,
            proj.knockback,
            proj.color,
            ctx,
            proj.burnDps,
            proj.burnDuration
          );
          if (proj.clusterShrapnelCount && proj.clusterShrapnelCount > 0) {
            this.spawnClusterShrapnel(
              proj.x,
              proj.y,
              proj.clusterShrapnelCount,
              proj.damage * 0.45,
              proj.knockback * 0.5,
              ctx
            );
          }
        } else {
          ctx.damageEnemy(enemy, proj.damage, {
            knockback: proj.knockback,
            sourceX: proj.x - proj.vx * 0.05,
            sourceY: proj.y - proj.vy * 0.05,
            color: proj.color,
            chillDuration: proj.chillDuration,
            chillFactor: proj.chillFactor,
            burnDps: proj.burnDps,
            burnDuration: proj.burnDuration,
            burnColor: proj.burnColor,
            shatterBonus: proj.shatterBonus,
            bonusCritChance: proj.bonusCritChance,
          });
        }

        // Valkyrie Blitz chain-dash retargeting
        if (proj.kind === 'dash' && proj.dashChainCount && proj.dashChainCount > 0) {
          const nextEnemy = ctx.spatialHash.findNearest(
            proj.x,
            proj.y,
            260,
            (e) => e.alive && !proj.hitIds.has(e.id)
          );
          if (nextEnemy) {
            proj.dashChainCount--;
            const na = Math.atan2(nextEnemy.y - proj.y, nextEnemy.x - proj.x);
            proj.vx = Math.cos(na) * proj.speed;
            proj.vy = Math.sin(na) * proj.speed;
            proj.rotation = na;
          }
        }

        // Ricochet bounce behavior
        if (proj.kind === 'ricochet') {
          if (proj.splinterOnBounce) {
            this.spawnFrostSplinters(proj.x, proj.y, proj.rotation, proj.damage * 0.45, ctx);
          }
          if (proj.pierceLeft > 0) {
            proj.pierceLeft--;
            const nextTarget = ctx.spatialHash.findNearest(
              proj.x,
              proj.y,
              290,
              (e) => e.alive && e.id !== enemy.id && !proj.hitIds.has(e.id)
            );
            if (nextTarget) {
              const na = Math.atan2(nextTarget.y - proj.y, nextTarget.x - proj.x);
              proj.vx = Math.cos(na) * proj.speed;
              proj.vy = Math.sin(na) * proj.speed;
              proj.rotation = na;
              ctx.spawnParticles(proj.x, proj.y, proj.color, 5, {
                speedMin: 40,
                speedMax: 120,
              });
            } else {
              // Reflect sharply if no un-hit neighbor
              const na = proj.rotation + Math.PI * 0.72 + (Math.random() - 0.5) * 0.5;
              proj.vx = Math.cos(na) * proj.speed;
              proj.vy = Math.sin(na) * proj.speed;
              proj.rotation = na;
              proj.hitIds.clear();
              proj.hitIds.add(enemy.id);
            }
            break; // Process 1 bounce per frame cleanly
          } else {
            destroyed = true;
            break;
          }
        }

        // Smart Bullets & Homing retarget on pierce
        if (proj.retargetOnPierce && proj.pierceLeft > 0) {
          const nextTarget = ctx.spatialHash.findNearest(
            proj.x,
            proj.y,
            300,
            (e) => e.alive && !proj.hitIds.has(e.id)
          );
          if (nextTarget) {
            const na = Math.atan2(nextTarget.y - proj.y, nextTarget.x - proj.x);
            proj.vx = Math.cos(na) * proj.speed;
            proj.vy = Math.sin(na) * proj.speed;
            proj.rotation = na;
          }
        }

        // Decrement pierce for non-infinite projectiles
        if (proj.pierceLeft < 999) {
          if (proj.pierceLeft <= 0) {
            destroyed = true;
            break;
          }
          proj.pierceLeft--;
        }
      }

      if (destroyed) {
        this.projectiles.splice(i, 1);
      }
    }
  }

  private triggerExplosion(
    x: number,
    y: number,
    radius: number,
    damage: number,
    knockback: number,
    color: string,
    ctx: CombatContext,
    burnDps?: number,
    burnDuration?: number
  ): void {
    const victims = ctx.spatialHash.queryRadius(x, y, radius, this.queryBuf);
    for (let i = 0; i < victims.length; i++) {
      const e = victims[i];
      if (!e.alive) continue;
      ctx.damageEnemy(e, damage, {
        knockback,
        sourceX: x,
        sourceY: y,
        color,
        burnDps,
        burnDuration,
        burnColor: color,
      });
    }
    ctx.spawnRingParticle(x, y, color, radius, 0.28);
    ctx.spawnParticles(x, y, color, 10, { speedMin: 55, speedMax: 165 });
  }

  private spawnClusterShrapnel(
    x: number,
    y: number,
    count: number,
    damage: number,
    knockback: number,
    ctx: CombatContext
  ): void {
    const base = Math.random() * Math.PI * 2;
    for (let i = 0; i < count; i++) {
      const a = base + (i * Math.PI * 2) / count;
      this.projectiles.push({
        kind: 'linear',
        sourceId: 'cluster_cannon',
        spriteId: 'bullet',
        color: PALETTE.peach,
        x,
        y,
        vx: Math.cos(a) * 380,
        vy: Math.sin(a) * 380,
        speed: 380,
        radius: 9,
        damage,
        knockback,
        pierceLeft: 2,
        age: 0,
        maxLife: 0.42,
        rotation: a,
        spinSpeed: 0,
        scale: 1.4,
        hitIds: new Set(),
      });
    }
    ctx.spawnParticles(x, y, PALETTE.butter, 6, { speedMin: 70, speedMax: 170 });
  }

  private spawnFrostSplinters(
    x: number,
    y: number,
    baseAngle: number,
    damage: number,
    ctx: CombatContext
  ): void {
    const offsets = [-0.62, 0.62];
    for (const off of offsets) {
      const a = baseAngle + off;
      this.projectiles.push({
        kind: 'linear',
        sourceId: 'glacial_ricochet',
        spriteId: 'ice',
        color: PALETTE.babyBlueLight,
        x,
        y,
        vx: Math.cos(a) * 410,
        vy: Math.sin(a) * 410,
        speed: 410,
        radius: 8,
        damage,
        knockback: 25,
        pierceLeft: 1,
        age: 0,
        maxLife: 0.45,
        rotation: a,
        spinSpeed: 0,
        scale: 1.35,
        hitIds: new Set(),
        chillDuration: 1.6,
        chillFactor: 0.55,
      });
    }
    ctx.spawnParticles(x, y, PALETTE.babyBlueLight, 5, { speedMin: 40, speedMax: 110 });
  }

  private updateBeams(dt: number, ctx: CombatContext): void {
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i];
      b.age += dt;
      if (b.age >= b.maxLife) {
        this.beams.splice(i, 1);
        continue;
      }

      // Keep beams anchored to player for snappy tracking
      b.x = ctx.player.x;
      b.y = ctx.player.y;
      const x2 = b.x + Math.cos(b.angle) * b.length;
      const y2 = b.y + Math.sin(b.angle) * b.length;

      // Second sear tick for sustained beams (plasma_beam, tempest_lance)
      let dmgMultiplier = 1;
      if (!b.secondTickDone && b.secondTickAt !== undefined && b.age >= b.secondTickAt) {
        b.secondTickDone = true;
        b.hitIds.clear();
        dmgMultiplier = 0.5;
      }

      // Starlight Railgun afterglow secondary pulse
      if (!b.afterglowDone && b.afterglowAt !== undefined && b.age >= b.afterglowAt) {
        b.afterglowDone = true;
        this.trails.push({
          kind: 'starlight_pulse',
          x: b.x,
          y: b.y,
          x2,
          y2,
          radius: b.width * 0.85,
          color: PALETTE.periwinkle,
          damage: b.damage * 0.4,
          knockback: b.knockback * 0.45,
          age: 0,
          maxLife: 0.35,
          hitCooldowns: new Map(),
        });
        for (let s = 1; s <= 6; s++) {
          const frac = s / 7;
          ctx.spawnParticles(
            b.x + (x2 - b.x) * frac,
            b.y + (y2 - b.y) * frac,
            PALETTE.butterLight,
            4,
            { speedMin: 30, speedMax: 90 }
          );
        }
      }

      // Query spatial hash within beam AABB
      const halfW = b.width * 0.5;
      const minX = Math.min(b.x, x2) - halfW - 24;
      const maxX = Math.max(b.x, x2) + halfW + 24;
      const minY = Math.min(b.y, y2) - halfW - 24;
      const maxY = Math.max(b.y, y2) + halfW + 24;
      const candidates = ctx.spatialHash.queryRect(minX, minY, maxX, maxY, this.queryBuf);

      for (let c = 0; c < candidates.length; c++) {
        const enemy = candidates[c];
        if (!enemy.alive || b.hitIds.has(enemy.id)) continue;

        const hitRadius = halfW + enemy.radius;
        const distSq = pointToSegmentDistSq(enemy.x, enemy.y, b.x, b.y, x2, y2);
        if (distSq <= hitRadius * hitRadius) {
          b.hitIds.add(enemy.id);
          ctx.damageEnemy(enemy, b.damage * dmgMultiplier, {
            knockback: b.knockback,
            sourceX: b.x,
            sourceY: b.y,
            color: b.color,
            bonusCritChance: b.bonusCritChance,
            bonusCritMult: b.bonusCritMult,
          });

          // Tempest Lance chain_arc_on_hit mechanic
          if (b.chainArcCount && b.chainArcRange) {
            this.castChainLightning(
              enemy.x,
              enemy.y,
              b.chainArcCount,
              b.chainArcRange,
              b.damage * 0.55,
              b.knockback * 0.4,
              0.2,
              PALETTE.butter,
              ctx,
              enemy.id
            );
          }
        }
      }
    }
  }

  private updateNovas(dt: number, ctx: CombatContext): void {
    for (let i = this.novas.length - 1; i >= 0; i--) {
      const n = this.novas[i];
      n.age += dt;
      if (n.age >= n.maxLife) {
        this.novas.splice(i, 1);
        continue;
      }

      if (n.followPlayer) {
        n.x = ctx.player.x;
        n.y = ctx.player.y;
      }

      const progress = Math.min(1, n.age / n.maxLife);
      // Ease-out expansion
      n.currentRadius = n.maxRadius * (1 - (1 - progress) * (1 - progress));

      const victims = ctx.spatialHash.queryRadius(n.x, n.y, n.currentRadius, this.queryBuf);
      for (let v = 0; v < victims.length; v++) {
        const enemy = victims[v];
        if (!enemy.alive || n.hitIds.has(enemy.id)) continue;
        n.hitIds.add(enemy.id);

        const died = ctx.damageEnemy(enemy, n.damage, {
          knockback: n.knockback,
          sourceX: n.x,
          sourceY: n.y,
          color: n.color,
          chillDuration: n.chillDuration,
          chillFactor: n.chillFactor,
          freezeDuration: n.freezeDuration,
          stunDuration: n.stunDuration,
        });
        if (died) {
          n.killsThisCast++;
          if (n.lifestealOnMultiKill && !n.lifestealAwarded && n.killsThisCast >= 2) {
            n.lifestealAwarded = true;
            ctx.healPlayer(2);
          }
        }
      }
    }
  }

  private updateOrbits(dt: number, ctx: CombatContext): void {
    const p = ctx.player;

    for (let i = this.orbits.length - 1; i >= 0; i--) {
      const orb = this.orbits[i];
      orb.age += dt;
      if (orb.age >= orb.maxLife) {
        this.orbits.splice(i, 1);
        continue;
      }

      orb.baseAngle += orb.angularSpeed * dt;

      // Decay per-enemy hit cooldowns
      for (const [eid, cd] of orb.hitCooldowns) {
        const next = cd - dt;
        if (next <= 0) orb.hitCooldowns.delete(eid);
        else orb.hitCooldowns.set(eid, next);
      }

      // Eclipse Singularity gravity_drag
      if (orb.gravityDragRadius) {
        const nearby = ctx.spatialHash.queryRadius(
          p.x,
          p.y,
          orb.orbitRadius + orb.gravityDragRadius,
          this.queryBuf
        );
        for (let k = 0; k < nearby.length; k++) {
          const e = nearby[k];
          if (!e.alive) continue;
          const dx = e.x - p.x;
          const dy = e.y - p.y;
          const dist = Math.hypot(dx, dy);
          if (dist > orb.orbitRadius + 8 && dist < orb.orbitRadius + orb.gravityDragRadius) {
            const pull = 46 * (1 - e.knockbackResist * 0.7) * dt;
            e.x -= (dx / dist) * pull;
            e.y -= (dy / dist) * pull;
          }
        }
      }

      // Eclipse Singularity emit_homing_bolts
      if (orb.emitBoltTimer !== undefined) {
        orb.emitBoltTimer -= dt;
        if (orb.emitBoltTimer <= 0) {
          orb.emitBoltTimer = 0.65;
          const boltsToFire = Math.min(orb.count, 3);
          for (let b = 0; b < boltsToFire; b++) {
            const idx = Math.floor((b * orb.count) / boltsToFire);
            const a = orb.baseAngle + (idx * Math.PI * 2) / orb.count;
            const ox = p.x + Math.cos(a) * orb.orbitRadius;
            const oy = p.y + Math.sin(a) * orb.orbitRadius;
            this.projectiles.push({
              kind: 'homing',
              sourceId: 'eclipse_singularity',
              spriteId: 'shadow',
              color: PALETTE.lavenderDark,
              x: ox,
              y: oy,
              vx: Math.cos(a) * 340,
              vy: Math.sin(a) * 340,
              speed: 340,
              radius: 11,
              damage: orb.damage * 0.75,
              knockback: orb.knockback * 0.5,
              pierceLeft: 1,
              age: 0,
              maxLife: 2.0,
              rotation: a,
              spinSpeed: 6,
              scale: 1.85,
              hitIds: new Set(),
              turnRate: 8.5,
              retargetOnPierce: true,
            });
          }
        }
      }

      // Whirlwind Tempest 360_cleave_pulse
      if (orb.cleavePulseTimer !== undefined) {
        orb.cleavePulseTimer -= dt;
        if (orb.cleavePulseTimer <= 0) {
          orb.cleavePulseTimer = 0.65;
          this.novas.push({
            sourceId: 'whirlwind_tempest',
            x: p.x,
            y: p.y,
            maxRadius: orb.orbitRadius * 1.18,
            currentRadius: 18,
            color: PALETTE.peach,
            ringColor: PALETTE.cream,
            damage: orb.damage * 0.85,
            knockback: orb.knockback,
            age: 0,
            maxLife: 0.28,
            hitIds: new Set(),
            followPlayer: true,
            killsThisCast: 0,
            lifestealAwarded: false,
          });
        }
      }

      // Hit checks for every orbiting item
      for (let k = 0; k < orb.count; k++) {
        const a = orb.baseAngle + (k * Math.PI * 2) / orb.count;
        const ix = p.x + Math.cos(a) * orb.orbitRadius;
        const iy = p.y + Math.sin(a) * orb.orbitRadius;
        const hits = ctx.spatialHash.queryRadius(ix, iy, orb.itemRadius, this.queryBuf);

        for (let h = 0; h < hits.length; h++) {
          const enemy = hits[h];
          if (!enemy.alive || orb.hitCooldowns.has(enemy.id)) continue;
          orb.hitCooldowns.set(enemy.id, 0.28);
          ctx.damageEnemy(enemy, orb.damage, {
            knockback: orb.knockback,
            sourceX: p.x,
            sourceY: p.y,
            color: orb.color,
          });
        }
      }
    }
  }

  private updateMeleeArcs(dt: number, ctx: CombatContext): void {
    const p = ctx.player;
    for (let i = this.meleeArcs.length - 1; i >= 0; i--) {
      const arc = this.meleeArcs[i];
      arc.age += dt;
      if (arc.age >= arc.maxLife) {
        this.meleeArcs.splice(i, 1);
        continue;
      }

      const halfSpread = arc.arcSpread * 0.5;
      const candidates = ctx.spatialHash.queryRadius(p.x, p.y, arc.radius, this.queryBuf);
      for (let c = 0; c < candidates.length; c++) {
        const enemy = candidates[c];
        if (!enemy.alive || arc.hitIds.has(enemy.id)) continue;

        const dx = enemy.x - p.x;
        const dy = enemy.y - p.y;
        const dist = Math.hypot(dx, dy);
        // Point-blank enemies are always hit; otherwise check sector angle
        const angleDiff = Math.abs(normalizeAngle(Math.atan2(dy, dx) - arc.angle));
        if (dist <= enemy.radius + 14 || angleDiff <= halfSpread + 0.14) {
          arc.hitIds.add(enemy.id);
          ctx.damageEnemy(enemy, arc.damage, {
            knockback: arc.knockback,
            sourceX: p.x,
            sourceY: p.y,
            color: arc.color,
          });
        }
      }
    }
  }

  private updateStrikes(dt: number, ctx: CombatContext): void {
    for (let i = this.strikes.length - 1; i >= 0; i--) {
      const s = this.strikes[i];
      s.elapsed += dt;

      if (!s.impacted && s.elapsed >= s.delay) {
        s.impacted = true;
        const victims = ctx.spatialHash.queryRadius(s.x, s.y, s.radius, this.queryBuf);
        let kills = 0;

        for (let v = 0; v < victims.length; v++) {
          const enemy = victims[v];
          if (!enemy.alive) continue;
          const died = ctx.damageEnemy(enemy, s.damage, {
            knockback: s.knockback,
            sourceX: s.x,
            sourceY: s.y,
            color: s.color,
          });
          if (died) kills++;
        }

        if (s.lifestealOnMultiKill && kills >= 2) {
          ctx.healPlayer(2);
        }

        ctx.spawnRingParticle(s.x, s.y, s.color, s.radius, 0.3);
        ctx.spawnParticles(s.x, s.y, s.color, 12, { speedMin: 60, speedMax: 185 });

        if (s.screenShake && s.screenShake > 0) {
          ctx.addScreenShake(s.screenShake, 0.16);
        }

        // Cataclysm: radial_earth_spikes around meteor crater
        if (s.radialEarthSpikes) {
          const spikeCount = 5;
          const ringDist = s.radius * 0.78;
          for (let k = 0; k < spikeCount; k++) {
            const a = (k * Math.PI * 2) / spikeCount + Math.random() * 0.2;
            this.strikes.push({
              sourceId: 'cataclysm',
              visualKind: 'earth_spike',
              x: s.x + Math.cos(a) * ringDist,
              y: s.y + Math.sin(a) * ringDist,
              radius: s.radius * 0.45,
              color: PALETTE.sage,
              damage: s.damage * 0.55,
              knockback: s.knockback * 0.65,
              delay: 0.12 + k * 0.03,
              elapsed: 0,
              impacted: false,
              lingerTime: 0.35,
            });
          }
        }

        // Divine Judgment: seismic_aftershock
        if (s.seismicAftershock) {
          const cx = s.x;
          const cy = s.y;
          const rad = s.radius * 1.35;
          const dmg = s.damage * 0.55;
          const kb = s.knockback * 0.85;
          this.delayedCasts.push({
            timer: 0.24,
            action: () => {
              this.novas.push({
                sourceId: 'divine_judgment',
                x: cx,
                y: cy,
                maxRadius: rad,
                currentRadius: 16,
                color: PALETTE.butter,
                ringColor: PALETTE.cream,
                damage: dmg,
                knockback: kb,
                age: 0,
                maxLife: 0.38,
                hitIds: new Set(),
                followPlayer: false,
                lifestealOnMultiKill: true,
                killsThisCast: 0,
                lifestealAwarded: false,
              });
            },
          });
        }
      }

      if (s.impacted && s.elapsed >= s.delay + s.lingerTime) {
        this.strikes.splice(i, 1);
      }
    }
  }

  private castChainLightning(
    startX: number,
    startY: number,
    jumps: number,
    arcRange: number,
    damage: number,
    knockback: number,
    duration: number,
    color: string,
    ctx: CombatContext,
    initialExcludeId?: number
  ): void {
    const visited = new Set<number>();
    if (initialExcludeId !== undefined) visited.add(initialExcludeId);

    const points: Array<{ x: number; y: number }> = [{ x: startX, y: startY }];
    let curX = startX;
    let curY = startY;
    const firstRange = Math.max(arcRange * 1.6, 260);

    for (let j = 0; j < jumps; j++) {
      const searchR = j === 0 && initialExcludeId === undefined ? firstRange : arcRange;
      const target = ctx.spatialHash.findNearest(
        curX,
        curY,
        searchR,
        (e) => e.alive && !visited.has(e.id)
      );
      if (!target) break;

      visited.add(target.id);
      points.push({ x: target.x, y: target.y });
      ctx.damageEnemy(target, damage, {
        knockback,
        sourceX: curX,
        sourceY: curY,
        color,
      });
      ctx.spawnParticles(target.x, target.y, color, 5, { speedMin: 40, speedMax: 120 });
      curX = target.x;
      curY = target.y;
    }

    if (points.length >= 2) {
      this.chainArcs.push({
        points,
        color,
        age: 0,
        maxLife: Math.max(0.18, duration),
        lineWidth: initialExcludeId !== undefined ? 2.5 : 3.5,
      });
    }
  }

  private updateChainArcs(dt: number): void {
    for (let i = this.chainArcs.length - 1; i >= 0; i--) {
      this.chainArcs[i].age += dt;
      if (this.chainArcs[i].age >= this.chainArcs[i].maxLife) {
        this.chainArcs.splice(i, 1);
      }
    }
  }

  private updateTurrets(dt: number, ctx: CombatContext): void {
    for (let i = this.turrets.length - 1; i >= 0; i--) {
      const t = this.turrets[i];
      t.age += dt;
      if (t.age >= t.maxLife) {
        ctx.spawnParticles(t.x, t.y, t.color, 8, { speedMin: 35, speedMax: 95 });
        this.turrets.splice(i, 1);
        continue;
      }

      const target = ctx.spatialHash.findNearest(t.x, t.y, t.range, (e) => e.alive);
      if (target) {
        t.angle = Math.atan2(target.y - t.y, target.x - t.x);
      }

      t.fireTimer -= dt;
      if (t.fireTimer <= 0 && target) {
        t.fireTimer = t.fireInterval;
        const barrels = t.isArtillery ? 2 : 1;
        const perpX = -Math.sin(t.angle);
        const perpY = Math.cos(t.angle);

        for (let b = 0; b < barrels; b++) {
          const offset = barrels === 1 ? 0 : (b === 0 ? -5 : 5);
          this.projectiles.push({
            kind: 'linear',
            sourceId: t.sourceId,
            spriteId: t.isArtillery ? 'arrow' : 'bullet',
            color: t.isArtillery ? PALETTE.mint : PALETTE.butter,
            x: t.x + Math.cos(t.angle) * 12 + perpX * offset,
            y: t.y + Math.sin(t.angle) * 12 + perpY * offset,
            vx: Math.cos(t.angle) * t.speed,
            vy: Math.sin(t.angle) * t.speed,
            speed: t.speed,
            radius: 9,
            damage: t.damage,
            knockback: t.knockback,
            pierceLeft: t.pierce,
            age: 0,
            maxLife: 1.2,
            rotation: t.angle,
            spinSpeed: 0,
            scale: 1.6,
            hitIds: new Set(),
          });
        }
      }

      // Artillery Barrage: turret_calls_arrow_rain
      if (t.isArtillery) {
        t.barrageTimer -= dt;
        if (t.barrageTimer <= 0 && target) {
          t.barrageTimer = 1.65;
          for (let w = 0; w < 2; w++) {
            this.strikes.push({
              sourceId: 'artillery_barrage',
              visualKind: 'arrow_rain',
              spriteId: 'arrow',
              x: target.x + (Math.random() - 0.5) * 36,
              y: target.y + (Math.random() - 0.5) * 36,
              radius: 72 * ctx.stats.areaMult,
              color: PALETTE.mintDark,
              damage: t.damage * 1.15,
              knockback: t.knockback * 1.1,
              delay: 0.22 + w * 0.14,
              elapsed: 0,
              impacted: false,
              lingerTime: 0.3,
            });
          }
        }
      }
    }
  }

  private updateTrails(dt: number, ctx: CombatContext): void {
    for (let i = this.trails.length - 1; i >= 0; i--) {
      const tr = this.trails[i];
      tr.age += dt;
      if (tr.age >= tr.maxLife) {
        this.trails.splice(i, 1);
        continue;
      }

      if (tr.kind === 'afterimage' || tr.damage <= 0) continue;

      for (const [eid, cd] of tr.hitCooldowns) {
        const next = cd - dt;
        if (next <= 0) tr.hitCooldowns.delete(eid);
        else tr.hitCooldowns.set(eid, next);
      }

      const minX = Math.min(tr.x, tr.x2) - tr.radius - 20;
      const maxX = Math.max(tr.x, tr.x2) + tr.radius + 20;
      const minY = Math.min(tr.y, tr.y2) - tr.radius - 20;
      const maxY = Math.max(tr.y, tr.y2) + tr.radius + 20;
      const candidates = ctx.spatialHash.queryRect(minX, minY, maxX, maxY, this.queryBuf);

      for (let c = 0; c < candidates.length; c++) {
        const enemy = candidates[c];
        if (!enemy.alive || tr.hitCooldowns.has(enemy.id)) continue;
        const hitR = tr.radius + enemy.radius;
        if (pointToSegmentDistSq(enemy.x, enemy.y, tr.x, tr.y, tr.x2, tr.y2) <= hitR * hitR) {
          tr.hitCooldowns.set(enemy.id, 0.26);
          ctx.damageEnemy(enemy, tr.damage, {
            knockback: tr.knockback,
            sourceX: tr.x,
            sourceY: tr.y,
            color: tr.color,
          });
        }
      }
    }
  }

  // ==========================================================================
  // RENDERING (GROUND LAYER + FOREGROUND LAYER)
  // ==========================================================================

  /**
   * Renders ground-level combat telegraphs, craters, nova waves, turrets, and damage trails.
   */
  public renderGroundLayer(
    ctx2d: CanvasRenderingContext2D,
    worldToScreen: (wx: number, wy: number) => { x: number; y: number },
    sprites: SpriteAtlas
  ): void {
    // 1. Expanding Novas
    for (let i = 0; i < this.novas.length; i++) {
      const n = this.novas[i];
      const pos = worldToScreen(n.x, n.y);
      const alpha = Math.max(0, 1 - n.age / n.maxLife);

      ctx2d.save();
      ctx2d.globalAlpha = alpha * 0.34;
      ctx2d.fillStyle = n.color;
      ctx2d.beginPath();
      ctx2d.arc(pos.x, pos.y, n.currentRadius, 0, Math.PI * 2);
      ctx2d.fill();

      ctx2d.globalAlpha = alpha * 0.92;
      ctx2d.strokeStyle = n.ringColor;
      ctx2d.lineWidth = 4;
      ctx2d.beginPath();
      ctx2d.arc(pos.x, pos.y, n.currentRadius, 0, Math.PI * 2);
      ctx2d.stroke();

      ctx2d.strokeStyle = PALETTE.outline;
      ctx2d.lineWidth = 1.5;
      ctx2d.beginPath();
      ctx2d.arc(pos.x, pos.y, n.currentRadius + 2, 0, Math.PI * 2);
      ctx2d.stroke();
      ctx2d.restore();
    }

    // 2. Ground Trails & Afterimages
    for (let i = 0; i < this.trails.length; i++) {
      const tr = this.trails[i];
      const alpha = Math.max(0, 1 - tr.age / tr.maxLife);
      const s1 = worldToScreen(tr.x, tr.y);

      ctx2d.save();
      if (tr.kind === 'afterimage' && tr.heroId) {
        ctx2d.globalAlpha = alpha * 0.55;
        drawPixelSprite(
          ctx2d,
          sprites.heroes[tr.heroId][0],
          s1.x,
          s1.y,
          3,
          Boolean(tr.facingLeft),
          true
        );
      } else {
        const s2 = worldToScreen(tr.x2, tr.y2);
        ctx2d.globalAlpha = alpha * 0.65;
        ctx2d.strokeStyle = tr.color;
        ctx2d.lineCap = 'round';
        ctx2d.lineWidth = tr.radius * 1.4;
        ctx2d.beginPath();
        ctx2d.moveTo(s1.x, s1.y);
        ctx2d.lineTo(s2.x, s2.y);
        ctx2d.stroke();

        ctx2d.globalAlpha = alpha * 0.9;
        ctx2d.strokeStyle = PALETTE.white;
        ctx2d.lineWidth = Math.max(2, tr.radius * 0.45);
        ctx2d.stroke();
      }
      ctx2d.restore();
    }

    // 3. Strikes & Rain Telegraphs / Ground Craters
    for (let i = 0; i < this.strikes.length; i++) {
      const s = this.strikes[i];
      const pos = worldToScreen(s.x, s.y);

      ctx2d.save();
      if (!s.impacted) {
        const progress = Math.min(1, s.elapsed / Math.max(0.01, s.delay));
        // Soft pastel telegraph ring
        ctx2d.globalAlpha = 0.25 + progress * 0.25;
        ctx2d.fillStyle = s.color;
        ctx2d.beginPath();
        ctx2d.arc(pos.x, pos.y, s.radius * progress, 0, Math.PI * 2);
        ctx2d.fill();

        ctx2d.globalAlpha = 0.78;
        ctx2d.strokeStyle = s.color;
        ctx2d.lineWidth = 2;
        ctx2d.setLineDash([5, 4]);
        ctx2d.beginPath();
        ctx2d.arc(pos.x, pos.y, s.radius, 0, Math.PI * 2);
        ctx2d.stroke();
        ctx2d.setLineDash([]);
      } else {
        const lingerAlpha = Math.max(0, 1 - (s.elapsed - s.delay) / Math.max(0.01, s.lingerTime));
        ctx2d.globalAlpha = lingerAlpha * 0.42;
        ctx2d.fillStyle = s.color;
        ctx2d.beginPath();
        ctx2d.arc(pos.x, pos.y, s.radius, 0, Math.PI * 2);
        ctx2d.fill();

        ctx2d.globalAlpha = lingerAlpha * 0.9;
        ctx2d.strokeStyle = PALETTE.outline;
        ctx2d.lineWidth = 2;
        ctx2d.beginPath();
        ctx2d.arc(pos.x, pos.y, s.radius, 0, Math.PI * 2);
        ctx2d.stroke();
      }
      ctx2d.restore();
    }

    // 4. Deployed Turrets
    for (let i = 0; i < this.turrets.length; i++) {
      const t = this.turrets[i];
      const pos = worldToScreen(t.x, t.y);
      const lifeRatio = Math.max(0, 1 - t.age / t.maxLife);

      ctx2d.save();
      // Shadow
      ctx2d.fillStyle = PALETTE.shadow;
      ctx2d.beginPath();
      ctx2d.ellipse(pos.x, pos.y + 11, 13, 5, 0, 0, Math.PI * 2);
      ctx2d.fill();

      // Base chassis
      ctx2d.fillStyle = t.isArtillery ? PALETTE.mintDark : PALETTE.sage;
      ctx2d.strokeStyle = PALETTE.outline;
      ctx2d.lineWidth = 2;
      ctx2d.beginPath();
      ctx2d.arc(pos.x, pos.y, t.isArtillery ? 12 : 10, 0, Math.PI * 2);
      ctx2d.fill();
      ctx2d.stroke();

      // Rotating barrel(s)
      ctx2d.translate(pos.x, pos.y);
      ctx2d.rotate(t.angle);
      ctx2d.fillStyle = PALETTE.cream;
      if (t.isArtillery) {
        ctx2d.fillRect(2, -6, 15, 4);
        ctx2d.strokeRect(2, -6, 15, 4);
        ctx2d.fillRect(2, 2, 15, 4);
        ctx2d.strokeRect(2, 2, 15, 4);
      } else {
        ctx2d.fillRect(2, -3, 14, 6);
        ctx2d.strokeRect(2, -3, 14, 6);
      }
      ctx2d.restore();

      // Tiny lifetime bar under turret
      const bw = 24;
      const bx = Math.round(pos.x - bw / 2);
      const by = Math.round(pos.y + 15);
      ctx2d.fillStyle = PALETTE.outline;
      ctx2d.fillRect(bx - 1, by - 1, bw + 2, 5);
      ctx2d.fillStyle = PALETTE.creamDark;
      ctx2d.fillRect(bx, by, bw, 3);
      ctx2d.fillStyle = t.isArtillery ? PALETTE.mint : PALETTE.butter;
      ctx2d.fillRect(bx, by, Math.round(bw * lifeRatio), 3);
    }
  }

  /**
   * Renders foreground combat visuals: melee arcs, beams, lightning chains,
   * orbiting weapons, falling meteors/hammers/arrows, and active projectiles.
   */
  public renderForegroundLayer(
    ctx2d: CanvasRenderingContext2D,
    playerX: number,
    playerY: number,
    worldToScreen: (wx: number, wy: number) => { x: number; y: number },
    sprites: SpriteAtlas
  ): void {
    const pScreen = worldToScreen(playerX, playerY);

    // 1. Melee Arcs (Greatsword Cleave & Shield Bash)
    for (let i = 0; i < this.meleeArcs.length; i++) {
      const arc = this.meleeArcs[i];
      const progress = Math.min(1, arc.age / arc.maxLife);
      const alpha = Math.max(0, 1 - progress * 0.85);
      const half = arc.arcSpread * 0.5;

      ctx2d.save();
      ctx2d.translate(pScreen.x, pScreen.y);
      ctx2d.globalAlpha = alpha * 0.45;
      ctx2d.fillStyle = arc.color;
      ctx2d.beginPath();
      ctx2d.moveTo(0, 0);
      ctx2d.arc(0, 0, arc.radius, arc.angle - half, arc.angle + half);
      ctx2d.closePath();
      ctx2d.fill();

      // Crisp sweeping rim
      ctx2d.globalAlpha = alpha;
      ctx2d.strokeStyle = PALETTE.cream;
      ctx2d.lineWidth = arc.visualKind === 'shield' ? 9 : 6;
      ctx2d.lineCap = 'round';
      ctx2d.beginPath();
      ctx2d.arc(0, 0, arc.radius - 3, arc.angle - half, arc.angle + half);
      ctx2d.stroke();

      ctx2d.strokeStyle = PALETTE.outline;
      ctx2d.lineWidth = 2;
      ctx2d.beginPath();
      ctx2d.arc(0, 0, arc.radius + 1, arc.angle - half, arc.angle + half);
      ctx2d.stroke();
      ctx2d.restore();
    }

    // 2. Beams (Plasma Beam, Rail-Bow, Spear Thrust, Tempest Lance, Starlight Railgun)
    for (let i = 0; i < this.beams.length; i++) {
      const b = this.beams[i];
      const alpha = Math.max(0, 1 - (b.age / b.maxLife) * 0.75);
      const s1 = worldToScreen(b.x, b.y);
      const s2 = worldToScreen(
        b.x + Math.cos(b.angle) * b.length,
        b.y + Math.sin(b.angle) * b.length
      );
      const pulseW = b.width * (0.8 + 0.25 * Math.sin(b.age * 40));

      ctx2d.save();
      ctx2d.lineCap = 'round';

      // Outer dark plum outline glow
      ctx2d.globalAlpha = alpha * 0.6;
      ctx2d.strokeStyle = PALETTE.outline;
      ctx2d.lineWidth = pulseW + 4;
      ctx2d.beginPath();
      ctx2d.moveTo(s1.x, s1.y);
      ctx2d.lineTo(s2.x, s2.y);
      ctx2d.stroke();

      // Main pastel beam body
      ctx2d.globalAlpha = alpha * 0.88;
      ctx2d.strokeStyle = b.color;
      ctx2d.lineWidth = pulseW;
      ctx2d.beginPath();
      ctx2d.moveTo(s1.x, s1.y);
      ctx2d.lineTo(s2.x, s2.y);
      ctx2d.stroke();

      // Bright core
      ctx2d.globalAlpha = alpha;
      ctx2d.strokeStyle = b.coreColor;
      ctx2d.lineWidth = Math.max(3, pulseW * 0.38);
      ctx2d.beginPath();
      ctx2d.moveTo(s1.x, s1.y);
      ctx2d.lineTo(s2.x, s2.y);
      ctx2d.stroke();

      // Spear sprite along thrust tip
      if (b.spriteId) {
        const tipFrac = Math.min(1, 0.4 + (b.age / b.maxLife) * 0.6);
        const tx = s1.x + (s2.x - s1.x) * tipFrac;
        const ty = s1.y + (s2.y - s1.y) * tipFrac;
        this.drawRotatedSprite(ctx2d, sprites.projectiles[b.spriteId], tx, ty, b.angle, 2.4);
      }
      ctx2d.restore();
    }

    // 3. Chain Lightning Arcs
    for (let i = 0; i < this.chainArcs.length; i++) {
      const arc = this.chainArcs[i];
      const alpha = Math.max(0, 1 - arc.age / arc.maxLife);

      ctx2d.save();
      ctx2d.lineJoin = 'round';
      ctx2d.lineCap = 'round';
      ctx2d.globalAlpha = alpha;

      for (let pIdx = 0; pIdx < arc.points.length - 1; pIdx++) {
        const a = worldToScreen(arc.points[pIdx].x, arc.points[pIdx].y);
        const b = worldToScreen(arc.points[pIdx + 1].x, arc.points[pIdx + 1].y);
        const midX = (a.x + b.x) * 0.5 + (Math.random() - 0.5) * 18;
        const midY = (a.y + b.y) * 0.5 + (Math.random() - 0.5) * 18;

        ctx2d.strokeStyle = PALETTE.outline;
        ctx2d.lineWidth = arc.lineWidth + 3;
        ctx2d.beginPath();
        ctx2d.moveTo(a.x, a.y);
        ctx2d.lineTo(midX, midY);
        ctx2d.lineTo(b.x, b.y);
        ctx2d.stroke();

        ctx2d.strokeStyle = arc.color;
        ctx2d.lineWidth = arc.lineWidth;
        ctx2d.stroke();

        ctx2d.strokeStyle = PALETTE.white;
        ctx2d.lineWidth = 1.4;
        ctx2d.stroke();
      }
      ctx2d.restore();
    }

    // 4. Orbiting Weapons (Arcane Orb, Orbiting Blades, Chain Flail, Eclipse Singularity, Whirlwind Tempest)
    for (let i = 0; i < this.orbits.length; i++) {
      const orb = this.orbits[i];
      for (let k = 0; k < orb.count; k++) {
        const a = orb.baseAngle + (k * Math.PI * 2) / orb.count;
        const ix = playerX + Math.cos(a) * orb.orbitRadius;
        const iy = playerY + Math.sin(a) * orb.orbitRadius;
        const pos = worldToScreen(ix, iy);

        ctx2d.save();
        if (orb.visualKind === 'flail') {
          // Chain tether links
          ctx2d.strokeStyle = PALETTE.outline;
          ctx2d.lineWidth = 3;
          ctx2d.setLineDash([4, 4]);
          ctx2d.beginPath();
          ctx2d.moveTo(pScreen.x, pScreen.y);
          ctx2d.lineTo(pos.x, pos.y);
          ctx2d.stroke();
          ctx2d.setLineDash([]);

          // Spiked pastel flail head
          ctx2d.fillStyle = PALETTE.slateLight;
          ctx2d.strokeStyle = PALETTE.outline;
          ctx2d.lineWidth = 2;
          ctx2d.beginPath();
          ctx2d.arc(pos.x, pos.y, orb.itemRadius * 0.72, 0, Math.PI * 2);
          ctx2d.fill();
          ctx2d.stroke();

          ctx2d.fillStyle = PALETTE.cream;
          ctx2d.beginPath();
          ctx2d.arc(pos.x - 3, pos.y - 3, 3.5, 0, Math.PI * 2);
          ctx2d.fill();
        } else if (orb.visualKind === 'blade' || orb.visualKind === 'greatsword') {
          const isGreat = orb.visualKind === 'greatsword';
          const len = isGreat ? 32 : 22;
          const wid = isGreat ? 10 : 7;
          ctx2d.translate(pos.x, pos.y);
          ctx2d.rotate(a + Math.PI / 2);

          // Blade body
          ctx2d.fillStyle = orb.color;
          ctx2d.strokeStyle = PALETTE.outline;
          ctx2d.lineWidth = 2;
          ctx2d.beginPath();
          ctx2d.moveTo(len * 0.65, 0);
          ctx2d.lineTo(-len * 0.35, -wid * 0.5);
          ctx2d.lineTo(-len * 0.55, 0);
          ctx2d.lineTo(-len * 0.35, wid * 0.5);
          ctx2d.closePath();
          ctx2d.fill();
          ctx2d.stroke();

          // Highlight streak
          ctx2d.fillStyle = PALETTE.cream;
          ctx2d.fillRect(-len * 0.2, -1.5, len * 0.65, 3);
        } else {
          // Arcane Orb or Eclipse Singularity
          if (orb.visualKind === 'singularity') {
            ctx2d.fillStyle = 'rgba(157, 136, 196, 0.35)';
            ctx2d.beginPath();
            ctx2d.arc(pos.x, pos.y, orb.itemRadius * 1.2, 0, Math.PI * 2);
            ctx2d.fill();
          }
          if (orb.spriteId) {
            this.drawRotatedSprite(
              ctx2d,
              sprites.projectiles[orb.spriteId],
              pos.x,
              pos.y,
              a * 2,
              orb.visualKind === 'singularity' ? 2.5 : 2.1
            );
          } else {
            ctx2d.fillStyle = orb.color;
            ctx2d.strokeStyle = PALETTE.outline;
            ctx2d.lineWidth = 2;
            ctx2d.beginPath();
            ctx2d.arc(pos.x, pos.y, orb.itemRadius * 0.7, 0, Math.PI * 2);
            ctx2d.fill();
            ctx2d.stroke();
          }
        }
        ctx2d.restore();
      }
    }

    // 5. Falling Meteors, Holy Hammers, Arrow Rain & Erupting Earth Spikes
    for (let i = 0; i < this.strikes.length; i++) {
      const s = this.strikes[i];
      const pos = worldToScreen(s.x, s.y);

      ctx2d.save();
      if (!s.impacted) {
        const progress = Math.min(1, s.elapsed / Math.max(0.01, s.delay));
        if (
          s.visualKind === 'meteor' ||
          s.visualKind === 'cataclysm_meteor' ||
          s.visualKind === 'holy_hammer' ||
          s.visualKind === 'divine_hammer'
        ) {
          const dropHeight = (1 - progress) * 240;
          const dropOffsetX =
            s.visualKind === 'meteor' || s.visualKind === 'cataclysm_meteor'
              ? (1 - progress) * 90
              : 0;
          const scale =
            s.visualKind === 'cataclysm_meteor' || s.visualKind === 'divine_hammer' ? 3.2 : 2.4;
          if (s.spriteId) {
            this.drawRotatedSprite(
              ctx2d,
              sprites.projectiles[s.spriteId],
              pos.x + dropOffsetX,
              pos.y - dropHeight,
              s.visualKind.includes('hammer') ? 0 : Math.PI * 0.65,
              scale
            );
          }
        } else if (s.visualKind === 'arrow_rain') {
          const dropHeight = (1 - progress) * 180;
          for (let k = -1; k <= 1; k++) {
            this.drawRotatedSprite(
              ctx2d,
              sprites.projectiles.arrow,
              pos.x + k * 14 + (1 - progress) * 28,
              pos.y - dropHeight + Math.abs(k) * 10,
              Math.PI * 0.55,
              1.65
            );
          }
        }
      } else if (s.visualKind === 'earth_spike' || s.visualKind === 'ground_slam') {
        const lingerRatio = Math.max(
          0,
          1 - (s.elapsed - s.delay) / Math.max(0.01, s.lingerTime)
        );
        ctx2d.globalAlpha = lingerRatio;
        const h = s.radius * 0.85 * Math.min(1, lingerRatio * 2);
        const w = s.radius * 0.42;
        ctx2d.fillStyle = s.color;
        ctx2d.strokeStyle = PALETTE.outline;
        ctx2d.lineWidth = 2;
        ctx2d.beginPath();
        ctx2d.moveTo(pos.x, pos.y - h);
        ctx2d.lineTo(pos.x + w, pos.y + 6);
        ctx2d.lineTo(pos.x - w, pos.y + 6);
        ctx2d.closePath();
        ctx2d.fill();
        ctx2d.stroke();
      }
      ctx2d.restore();
    }

    // 6. Active Projectiles (Linear, Homing, Boomerang, Ricochet, Dash, Spiral)
    for (let i = 0; i < this.projectiles.length; i++) {
      const proj = this.projectiles[i];
      const pos = worldToScreen(proj.x, proj.y);

      ctx2d.save();

      // Reaper's Pendulum chain tether
      if (proj.tetherToPlayer) {
        ctx2d.strokeStyle = PALETTE.outline;
        ctx2d.lineWidth = 2.5;
        ctx2d.setLineDash([5, 5]);
        ctx2d.beginPath();
        ctx2d.moveTo(pScreen.x, pScreen.y);
        ctx2d.lineTo(pos.x, pos.y);
        ctx2d.stroke();
        ctx2d.setLineDash([]);
      }

      // Firestorm swirling cyclone halo
      if (proj.sourceId === 'firestorm') {
        ctx2d.globalAlpha = 0.32;
        ctx2d.fillStyle = PALETTE.coral;
        ctx2d.beginPath();
        ctx2d.arc(pos.x, pos.y, proj.radius * 1.25, 0, Math.PI * 2);
        ctx2d.fill();
        ctx2d.globalAlpha = 0.85;
        ctx2d.strokeStyle = PALETTE.butter;
        ctx2d.lineWidth = 2.5;
        ctx2d.beginPath();
        ctx2d.arc(pos.x, pos.y, proj.radius, proj.rotation, proj.rotation + Math.PI * 1.4);
        ctx2d.stroke();
        ctx2d.globalAlpha = 1;
      }

      // Wind Blade pastel crescent
      if (proj.sourceId === 'wind_blade') {
        ctx2d.translate(pos.x, pos.y);
        ctx2d.rotate(proj.rotation);
        ctx2d.strokeStyle = PALETTE.outline;
        ctx2d.lineWidth = 6;
        ctx2d.lineCap = 'round';
        ctx2d.beginPath();
        ctx2d.arc(0, 0, proj.radius * 0.78, -1.1, 1.1);
        ctx2d.stroke();

        ctx2d.strokeStyle = PALETTE.mint;
        ctx2d.lineWidth = 3.5;
        ctx2d.stroke();
      } else if (proj.kind === 'dash' && !proj.spriteId) {
        // Blade Dash crescent slash
        ctx2d.translate(pos.x, pos.y);
        ctx2d.rotate(proj.rotation);
        ctx2d.fillStyle = proj.color;
        ctx2d.strokeStyle = PALETTE.outline;
        ctx2d.lineWidth = 2;
        ctx2d.beginPath();
        ctx2d.ellipse(0, 0, proj.radius * 0.9, proj.radius * 0.42, 0, 0, Math.PI * 2);
        ctx2d.fill();
        ctx2d.stroke();
      } else if (proj.spriteId) {
        this.drawRotatedSprite(
          ctx2d,
          sprites.projectiles[proj.spriteId],
          pos.x,
          pos.y,
          proj.rotation,
          proj.scale
        );
      } else {
        ctx2d.fillStyle = proj.color;
        ctx2d.strokeStyle = PALETTE.outline;
        ctx2d.lineWidth = 2;
        ctx2d.beginPath();
        ctx2d.arc(pos.x, pos.y, proj.radius, 0, Math.PI * 2);
        ctx2d.fill();
        ctx2d.stroke();
      }

      ctx2d.restore();
    }
  }

  private drawRotatedSprite(
    ctx2d: CanvasRenderingContext2D,
    sprite: HTMLCanvasElement,
    x: number,
    y: number,
    angle: number,
    scale: number
  ): void {
    const w = sprite.width * scale;
    const h = sprite.height * scale;
    ctx2d.save();
    ctx2d.imageSmoothingEnabled = false;
    ctx2d.translate(Math.round(x), Math.round(y));
    ctx2d.rotate(angle);
    ctx2d.drawImage(sprite, Math.round(-w / 2), Math.round(-h / 2), w, h);
    ctx2d.restore();
  }
}
