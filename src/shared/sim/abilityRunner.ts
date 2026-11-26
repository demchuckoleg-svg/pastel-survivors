import { ABILITIES, getAbilityStatsAtLevel } from '../data/abilities';
import { PALETTE } from '../data/palette';
import { SYNERGIES } from '../data/synergies';
import type {
  AbilityId,
  AbilityStats,
  ClassId,
  SynergyId,
} from '../data/types';
import { normalizeAngle, pointToSegmentDistSq } from './math';
import type { SpatialHash } from './spatialHash';
import type {
  AbilityRenderState,
  ActiveAbilitySlot,
  ActiveBeam,
  ActiveChainArc,
  ActiveGroundTrail,
  ActiveMeleeArc,
  ActiveNova,
  ActiveOrbitGroup,
  ActiveProjectile,
  ActiveStrikeOrRain,
  ActiveTotem,
  ActiveTurret,
  ActiveZone,
  AimMode,
  ComputedPlayerStats,
  DamageOptions,
  EnemyEntity,
  ParticleBurstOptions,
  PlayerId,
} from './types';

export interface CombatContext {
  player: {
    id: PlayerId;
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
  viewportWidth: number;
  viewportHeight: number;
  damageEnemy: (enemy: EnemyEntity, rawDamage: number, opts?: DamageOptions) => boolean;
  tauntNearbyEnemies?: (x: number, y: number, radius: number, durationSec: number) => number;
  healPlayer: (amount: number) => void;
  healAlliesInRadius?: (
    x: number,
    y: number,
    radius: number,
    amount: number,
    allowOverhealShield?: boolean
  ) => number;
  grantShieldInRadius?: (
    x: number,
    y: number,
    radius: number,
    shieldAmount: number,
    durationSec: number
  ) => number;
  grantHasteInRadius?: (x: number, y: number, radius: number, durationSec: number) => number;
  grantStarlightInRadius?: (x: number, y: number, radius: number, durationSec: number) => number;
  grantTotemRegenInRadius?: (x: number, y: number, radius: number, durationSec: number) => number;
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
  onAbilityFired?: (
    abilityId: AbilityId | SynergyId,
    isSynergy: boolean,
    color: string,
    isDoubleCast: boolean,
    aimAngle: number
  ) => void;
  allocProjectileNetId?: () => number;
  onProjectileSpawned?: (proj: ActiveProjectile, netId: number) => void;
  onProjectileMoved?: (proj: ActiveProjectile, netId: number) => void;
  onProjectileDespawned?: (netId: number, x: number, y: number) => void;
}

interface DelayedCast {
  timer: number;
  action: () => void;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled ability/synergy id: ${String(value)}`);
}

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
  private zones: ActiveZone[] = [];
  private totems: ActiveTotem[] = [];
  private delayedCasts: DelayedCast[] = [];

  private castCounter = 0;
  private readonly queryBuf: EnemyEntity[] = [];
  private readonly replicatedProjectiles = new Map<number, ActiveProjectile>();
  private readonly seenNetIdsBuf = new Set<number>();

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
    this.zones.length = 0;
    this.totems.length = 0;
    this.delayedCasts.length = 0;
    this.castCounter = 0;
    this.replicatedProjectiles.clear();
    this.seenNetIdsBuf.clear();
  }

  /**
   * Returns all currently replicated projectile netIds + last positions and clears the map
   * (used when a player is removed mid-match so clients cleanly despawn their projectiles).
   */
  public drainReplicatedProjectiles(): Array<{ netId: number; x: number; y: number }> {
    const out: Array<{ netId: number; x: number; y: number }> = [];
    for (const [netId, proj] of this.replicatedProjectiles) {
      out.push({ netId, x: proj.x, y: proj.y });
    }
    this.replicatedProjectiles.clear();
    return out;
  }

  public getActiveTotems(): readonly ActiveTotem[] {
    return this.totems;
  }

  /**
   * Removes persistent orbit/turret/totem instances belonging to consumed base abilities
   * upon Synergy Evolution so the evolved effect replaces them cleanly.
   */
  public clearEffectsForAbility(abilityId: AbilityId): void {
    this.orbits = this.orbits.filter((o) => o.sourceId !== abilityId);
    this.turrets = this.turrets.filter((t) => t.sourceId !== abilityId);
    this.totems = this.totems.filter((t) => t.sourceId !== abilityId);
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
   * all active projectiles, beams, novas, orbits, melee arcs, strikes, turrets, trails, zones, and totems.
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
          this.castWithChronometer(ctx, def.id, false, def.color, (aimAngle) =>
            this.executeAbility(def.id, stats, ctx, aimAngle)
          );
        } else {
          const syn = SYNERGIES[slot.id as SynergyId];
          const stats = syn.evolvedSpec.stats;
          const effectiveCd = Math.max(0.14, stats.cooldown * ctx.stats.cooldownMult);
          slot.cooldownTimer = effectiveCd;
          this.castWithChronometer(ctx, syn.id, true, syn.color, (aimAngle) =>
            this.executeSynergy(syn.id, stats, ctx, aimAngle)
          );
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
    this.updateZones(dt, ctx);
    this.updateTotems(dt, ctx);

    // 4. Reconcile authoritative projectile replication events (co-op server only)
    if (ctx.onProjectileSpawned && ctx.allocProjectileNetId) {
      this.reconcileReplicatedProjectiles(ctx);
    }
  }

  private reconcileReplicatedProjectiles(ctx: CombatContext): void {
    const allocNetId = ctx.allocProjectileNetId!;
    const onSpawned = ctx.onProjectileSpawned!;
    const onMoved = ctx.onProjectileMoved;
    const onDespawned = ctx.onProjectileDespawned;

    this.seenNetIdsBuf.clear();

    for (let i = 0; i < this.projectiles.length; i++) {
      const proj = this.projectiles[i];
      if (proj.netId === undefined) {
        const netId = allocNetId();
        proj.netId = netId;
        proj.netX = proj.x;
        proj.netY = proj.y;
        proj.netVx = proj.vx;
        proj.netVy = proj.vy;
        proj.netAge = proj.age;
        this.replicatedProjectiles.set(netId, proj);
        this.seenNetIdsBuf.add(netId);
        onSpawned(proj, netId);
      } else {
        this.seenNetIdsBuf.add(proj.netId);
        if (onMoved) {
          const elapsed = proj.age - (proj.netAge ?? proj.age);
          const expectedX = (proj.netX ?? proj.x) + (proj.netVx ?? proj.vx) * elapsed;
          const expectedY = (proj.netY ?? proj.y) + (proj.netVy ?? proj.vy) * elapsed;
          const posErrSq = (proj.x - expectedX) ** 2 + (proj.y - expectedY) ** 2;
          const velErrSq =
            (proj.vx - (proj.netVx ?? proj.vx)) ** 2 + (proj.vy - (proj.netVy ?? proj.vy)) ** 2;

          // Emit a compact trajectory correction when a homing/boomerang/ricochet/dash projectile
          // deviates by > 8px from linear extrapolation or changes velocity by > 15 px/s.
          if (posErrSq > 64 || velErrSq > 225) {
            proj.netX = proj.x;
            proj.netY = proj.y;
            proj.netVx = proj.vx;
            proj.netVy = proj.vy;
            proj.netAge = proj.age;
            onMoved(proj, proj.netId);
          }
        }
      }
    }

    for (const [netId, proj] of this.replicatedProjectiles) {
      if (!this.seenNetIdsBuf.has(netId)) {
        this.replicatedProjectiles.delete(netId);
        onDespawned?.(netId, proj.x, proj.y);
      }
    }
  }

  private castWithChronometer(
    ctx: CombatContext,
    abilityId: AbilityId | SynergyId,
    isSynergy: boolean,
    color: string,
    castFn: (aimAngle: number) => void
  ): void {
    const aimAngle = this.getAimAngle(ctx);
    castFn(aimAngle);
    ctx.onAbilityFired?.(abilityId, isSynergy, color, false, aimAngle);
    this.castCounter++;
    if (ctx.stats.hasDoubleCast && this.castCounter % 5 === 0) {
      this.delayedCasts.push({
        timer: 0.12,
        action: () => {
          const doubleAimAngle = this.getAimAngle(ctx);
          castFn(doubleAimAngle);
          ctx.onAbilityFired?.(abilityId, isSynergy, color, true, doubleAimAngle);
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

  private executeAbility(
    id: AbilityId,
    stats: AbilityStats,
    ctx: CombatContext,
    baseAngle: number
  ): void {
    const p = ctx.player;
    const damage = stats.damage * ctx.stats.damageMult;
    const area = stats.area * ctx.stats.areaMult;
    const kb = (stats.knockback ?? 0) * ctx.stats.knockbackMult;
    const count = Math.max(1, stats.count + ctx.stats.projectileBonus);
    const pierce = stats.pierce >= 999 ? 999 : stats.pierce + ctx.stats.pierceBonus;

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
        const tauntRadius = Math.max(area * 1.45, 175);
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
              tauntDuration: 2.5,
            });
            ctx.tauntNearbyEnemies?.(ctx.player.x, ctx.player.y, tauntRadius, 2.5);
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

      // ----------------------------------------------------------------------
      // ALCHEMIST (10)
      // ----------------------------------------------------------------------
      case 'healing_mist': {
        const auraBoost = ctx.stats.hasAuraRadiusBoost ? 1.25 : 1;
        const zoneRadius = area * auraBoost;
        for (let i = 0; i < count; i++) {
          const offsetAngle = baseAngle + (i * Math.PI * 2) / Math.max(1, count);
          const dist = i === 0 ? 18 : 54;
          const zx = p.x + Math.cos(offsetAngle) * dist;
          const zy = p.y + Math.sin(offsetAngle) * dist;
          this.zones.push({
            sourceId: 'healing_mist',
            visualKind: 'healing_mist',
            x: zx,
            y: zy,
            radius: zoneRadius,
            color: PALETTE.mint,
            ringColor: PALETTE.mintLight,
            damage,
            knockback: kb,
            age: 0,
            maxLife: stats.duration,
            tickTimer: 0.05,
            tickInterval: 0.5,
            healPerTick: Math.max(2, Math.round(3 + damage * 0.14)),
          });
          ctx.spawnRingParticle(zx, zy, PALETTE.mintLight, zoneRadius * 0.85, 0.35);
        }
        return;
      }

      case 'acid_flask': {
        const targets = this.pickTargetEnemies(ctx, count, 360);
        for (let i = 0; i < count; i++) {
          const t = targets[i];
          const tx = t
            ? t.x + (Math.random() - 0.5) * 18
            : p.x + Math.cos(baseAngle + (i - (count - 1) / 2) * 0.35) * (120 + i * 24);
          const ty = t
            ? t.y + (Math.random() - 0.5) * 18
            : p.y + Math.sin(baseAngle + (i - (count - 1) / 2) * 0.35) * (120 + i * 24);
          this.zones.push({
            sourceId: 'acid_flask',
            visualKind: 'acid_pool',
            x: tx,
            y: ty,
            radius: area,
            color: PALETTE.butterDark,
            ringColor: PALETTE.butter,
            damage,
            knockback: kb,
            age: 0,
            maxLife: stats.duration,
            tickTimer: 0.04,
            tickInterval: 0.45,
            armorShredBonus: 0.3,
            armorShredDuration: 3.5,
          });
          ctx.spawnRingParticle(tx, ty, PALETTE.butter, area, 0.3);
          ctx.spawnParticles(tx, ty, PALETTE.butterDark, 8, { speedMin: 35, speedMax: 110 });
        }
        return;
      }

      case 'haste_aura': {
        const auraRadius = area * (ctx.stats.hasAuraRadiusBoost ? 1.25 : 1);
        ctx.grantHasteInRadius?.(p.x, p.y, auraRadius, 2.8);
        this.novas.push({
          sourceId: 'haste_aura',
          x: p.x,
          y: p.y,
          maxRadius: auraRadius,
          currentRadius: 16,
          color: PALETTE.butterLight,
          ringColor: PALETTE.butter,
          damage,
          knockback: kb,
          age: 0,
          maxLife: stats.duration,
          hitIds: new Set(),
          followPlayer: true,
          killsThisCast: 0,
          lifestealAwarded: false,
        });
        ctx.spawnParticles(p.x, p.y, PALETTE.butter, 12, { speedMin: 55, speedMax: 150 });
        return;
      }

      case 'protective_ward': {
        const auraRadius = 145 * ctx.stats.areaMult * (ctx.stats.hasAuraRadiusBoost ? 1.25 : 1);
        const shieldAmount = Math.max(10, Math.round(12 + damage * 0.45));
        ctx.grantShieldInRadius?.(p.x, p.y, auraRadius, shieldAmount, 5.0);
        const orbitRadius = 68 * Math.sqrt(ctx.stats.areaMult);
        this.orbits = this.orbits.filter((o) => o.sourceId !== 'protective_ward');
        this.orbits.push({
          sourceId: 'protective_ward',
          visualKind: 'ward',
          color: PALETTE.butterLight,
          count,
          orbitRadius,
          itemRadius: Math.max(14, area * 0.8),
          angularSpeed: stats.speed / Math.max(32, orbitRadius),
          baseAngle: Math.random() * Math.PI * 2,
          damage,
          knockback: kb,
          age: 0,
          maxLife: stats.duration,
          hitCooldowns: new Map(),
          shieldPulseTimer: 1.6,
          shieldAmount: Math.max(6, Math.round(shieldAmount * 0.5)),
        });
        ctx.spawnRingParticle(p.x, p.y, PALETTE.butterLight, auraRadius * 0.7, 0.35);
        return;
      }

      case 'venom_nova': {
        this.novas.push({
          sourceId: 'venom_nova',
          x: p.x,
          y: p.y,
          maxRadius: area,
          currentRadius: 12,
          color: PALETTE.sage,
          ringColor: PALETTE.mintDark,
          damage,
          knockback: kb,
          age: 0,
          maxLife: stats.duration,
          hitIds: new Set(),
          burnDps: Math.max(8, damage * 0.55),
          burnDuration: 3.2,
          burnColor: PALETTE.sage,
          followPlayer: true,
          killsThisCast: 0,
          lifestealAwarded: false,
        });
        ctx.spawnParticles(p.x, p.y, PALETTE.sage, 14, { speedMin: 60, speedMax: 165 });
        return;
      }

      case 'frost_tonic': {
        const spread = count > 1 ? Math.min(0.45, (count - 1) * 0.14) : 0;
        for (let i = 0; i < count; i++) {
          const angle =
            count === 1 ? baseAngle : baseAngle - spread / 2 + (spread * i) / (count - 1);
          this.projectiles.push({
            kind: 'linear',
            sourceId: 'frost_tonic',
            spriteId: 'vial',
            color: PALETTE.babyBlue,
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
            spinSpeed: 8,
            scale: 1.9,
            hitIds: new Set(),
            explosiveRadius: area,
            chillDuration: 2.8,
            chillFactor: 0.48,
          });
        }
        return;
      }

      case 'bouncing_vial': {
        const spread = count > 1 ? Math.min(0.55, (count - 1) * 0.16) : 0;
        for (let i = 0; i < count; i++) {
          const angle =
            count === 1 ? baseAngle : baseAngle - spread / 2 + (spread * i) / (count - 1);
          this.projectiles.push({
            kind: 'ricochet',
            sourceId: 'bouncing_vial',
            spriteId: 'vial',
            color: PALETTE.coral,
            x: p.x,
            y: p.y,
            vx: Math.cos(angle) * stats.speed,
            vy: Math.sin(angle) * stats.speed,
            speed: stats.speed,
            radius: Math.max(10, area * 0.72),
            damage,
            knockback: kb,
            pierceLeft: Math.max(1, pierce),
            age: 0,
            maxLife: stats.duration,
            rotation: angle,
            spinSpeed: 10,
            scale: 1.9,
            hitIds: new Set(),
          });
        }
        return;
      }

      case 'revive_totem': {
        const auraBoost = ctx.stats.hasAuraRadiusBoost ? 1.25 : 1;
        const maxTotems = Math.min(3, count);
        const existing = this.totems.filter((t) => t.sourceId === 'revive_totem');
        while (existing.length >= maxTotems) {
          const oldest = existing.shift();
          if (oldest) {
            const idx = this.totems.indexOf(oldest);
            if (idx >= 0) this.totems.splice(idx, 1);
          }
        }
        const tx = p.x + Math.cos(baseAngle) * 34;
        const ty = p.y + Math.sin(baseAngle) * 34;
        this.totems.push({
          sourceId: 'revive_totem',
          x: tx,
          y: ty,
          radius: area * auraBoost,
          damage,
          speed: stats.speed,
          pierce,
          knockback: kb,
          color: PALETTE.mintLight,
          age: 0,
          maxLife: stats.duration,
          pulseTimer: 0.1,
          fireTimer: 0.35,
          isAegisLantern: false,
          reviveBoostMult: 2.0,
          soloReviveRate: 0.45,
        });
        ctx.spawnRingParticle(tx, ty, PALETTE.mintLight, 56, 0.32);
        return;
      }

      case 'gravity_potion': {
        const targets = this.pickTargetEnemies(ctx, count, 380);
        for (let i = 0; i < count; i++) {
          const t = targets[i];
          const tx = t
            ? t.x
            : p.x + Math.cos(baseAngle + (i - (count - 1) / 2) * 0.45) * 140;
          const ty = t
            ? t.y
            : p.y + Math.sin(baseAngle + (i - (count - 1) / 2) * 0.45) * 140;
          this.zones.push({
            sourceId: 'gravity_potion',
            visualKind: 'gravity_vortex',
            x: tx,
            y: ty,
            radius: area,
            color: PALETTE.lavender,
            ringColor: PALETTE.lavenderLight,
            damage,
            knockback: 0,
            age: 0,
            maxLife: stats.duration,
            tickTimer: 0.08,
            tickInterval: 0.45,
            pullStrength: 105,
          });
          ctx.spawnRingParticle(tx, ty, PALETTE.lavenderLight, area, 0.3);
        }
        return;
      }

      case 'starlight_elixir': {
        const spread = count > 1 ? Math.min(1.0, (count - 1) * 0.24) : 0;
        for (let i = 0; i < count; i++) {
          const angle =
            count === 1 ? baseAngle : baseAngle - spread / 2 + (spread * i) / (count - 1);
          this.projectiles.push({
            kind: 'homing',
            sourceId: 'starlight_elixir',
            spriteId: 'vial',
            color: PALETTE.coralLight,
            x: p.x,
            y: p.y,
            vx: Math.cos(angle) * stats.speed,
            vy: Math.sin(angle) * stats.speed,
            speed: stats.speed,
            radius: Math.max(10, area * 0.75),
            damage,
            knockback: kb,
            pierceLeft: pierce,
            age: 0,
            maxLife: stats.duration,
            rotation: angle,
            spinSpeed: 9,
            scale: 1.85,
            hitIds: new Set(),
            turnRate: 7.4,
            retargetOnPierce: true,
            grantStarlightBuffOnHit: true,
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

  private executeSynergy(
    id: SynergyId,
    stats: AbilityStats,
    ctx: CombatContext,
    baseAngle: number
  ): void {
    const p = ctx.player;
    const damage = stats.damage * ctx.stats.damageMult;
    const area = stats.area * ctx.stats.areaMult;
    const kb = (stats.knockback ?? 0) * ctx.stats.knockbackMult;
    const count = Math.max(1, stats.count + ctx.stats.projectileBonus);
    const pierce = stats.pierce >= 999 ? 999 : stats.pierce + ctx.stats.pierceBonus;

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
        // Double-ringed porcelain bastion quake: double_shockwave_ring, massive_knockback, micro_stun, 2.5s aggro peel
        const rings = Math.max(2, stats.count);
        const tauntRadius = Math.max(area * 1.25, 220);
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
              tauntDuration: 2.5,
              followPlayer: true,
              killsThisCast: 0,
              lifestealAwarded: false,
            });
            ctx.tauntNearbyEnemies?.(ctx.player.x, ctx.player.y, tauntRadius, 2.5);
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

      // ----------------------------------------------------------------------
      // ALCHEMIST SYNERGIES (5)
      // ----------------------------------------------------------------------
      case 'sanctuary_choir': {
        const auraBoost = ctx.stats.hasAuraRadiusBoost ? 1.25 : 1;
        const zoneRadius = area * auraBoost;
        for (let i = 0; i < count; i++) {
          const offsetAngle = baseAngle + (i * Math.PI * 2) / Math.max(1, count);
          const dist = i === 0 ? 12 : 68;
          const zx = p.x + Math.cos(offsetAngle) * dist;
          const zy = p.y + Math.sin(offsetAngle) * dist;
          this.zones.push({
            sourceId: 'sanctuary_choir',
            visualKind: 'sanctuary_choir',
            x: zx,
            y: zy,
            radius: zoneRadius,
            color: PALETTE.mint,
            ringColor: PALETTE.butter,
            damage,
            knockback: kb,
            age: 0,
            maxLife: stats.duration,
            tickTimer: 0.04,
            tickInterval: 0.42,
            healPerTick: Math.max(5, Math.round(6 + damage * 0.14)),
            grantHasteSec: 2.8,
          });
          ctx.spawnRingParticle(zx, zy, PALETTE.butter, zoneRadius, 0.4);
        }
        return;
      }

      case 'caustic_singularity': {
        const targets = this.pickTargetEnemies(ctx, count, 400);
        for (let i = 0; i < count; i++) {
          const t = targets[i];
          const tx = t
            ? t.x
            : p.x + Math.cos(baseAngle + (i - (count - 1) / 2) * 0.5) * 145;
          const ty = t
            ? t.y
            : p.y + Math.sin(baseAngle + (i - (count - 1) / 2) * 0.5) * 145;
          this.zones.push({
            sourceId: 'caustic_singularity',
            visualKind: 'caustic_singularity',
            x: tx,
            y: ty,
            radius: area,
            color: PALETTE.butterDark,
            ringColor: PALETTE.lavender,
            damage,
            knockback: 0,
            age: 0,
            maxLife: stats.duration,
            tickTimer: 0.04,
            tickInterval: 0.38,
            armorShredBonus: 0.45,
            armorShredDuration: 4.5,
            pullStrength: 155,
            burnDps: Math.max(14, damage * 0.5),
            burnDuration: 3.0,
          });
          ctx.spawnRingParticle(tx, ty, PALETTE.butterDark, area, 0.38);
          ctx.spawnParticles(tx, ty, PALETTE.butter, 12, { speedMin: 45, speedMax: 140 });
        }
        return;
      }

      case 'aegis_lantern': {
        const auraBoost = ctx.stats.hasAuraRadiusBoost ? 1.25 : 1;
        const maxLanterns = Math.min(3, count);
        const existing = this.totems.filter((t) => t.sourceId === 'aegis_lantern');
        while (existing.length >= maxLanterns) {
          const oldest = existing.shift();
          if (oldest) {
            const idx = this.totems.indexOf(oldest);
            if (idx >= 0) this.totems.splice(idx, 1);
          }
        }
        const tx = p.x + Math.cos(baseAngle) * 38;
        const ty = p.y + Math.sin(baseAngle) * 38;
        const lanternRadius = area * auraBoost;
        this.totems.push({
          sourceId: 'aegis_lantern',
          x: tx,
          y: ty,
          radius: lanternRadius,
          damage,
          speed: stats.speed,
          pierce,
          knockback: kb,
          color: PALETTE.butter,
          age: 0,
          maxLife: stats.duration,
          pulseTimer: 0.08,
          fireTimer: 0.25,
          isAegisLantern: true,
          reviveBoostMult: 2.5,
          soloReviveRate: 0.75,
        });
        ctx.grantShieldInRadius?.(tx, ty, lanternRadius, Math.max(18, Math.round(damage * 0.4)), 6.0);
        ctx.spawnRingParticle(tx, ty, PALETTE.butter, lanternRadius * 0.7, 0.42);
        return;
      }

      case 'plague_glacier': {
        this.novas.push({
          sourceId: 'plague_glacier',
          x: p.x,
          y: p.y,
          maxRadius: area,
          currentRadius: 14,
          color: PALETTE.babyBlue,
          ringColor: PALETTE.mint,
          damage,
          knockback: kb,
          age: 0,
          maxLife: stats.duration,
          hitIds: new Set(),
          chillDuration: 3.6,
          chillFactor: 0.35,
          freezeDuration: 1.4,
          burnDps: Math.max(18, damage * 0.55),
          burnDuration: 4.0,
          burnColor: PALETTE.sage,
          shatterBonus: true,
          followPlayer: true,
          killsThisCast: 0,
          lifestealAwarded: false,
        });
        ctx.spawnParticles(p.x, p.y, PALETTE.babyBlueLight, 18, { speedMin: 70, speedMax: 195 });
        return;
      }

      case 'celestial_panacea': {
        const spread = count > 1 ? Math.min(0.75, (count - 1) * 0.16) : 0;
        for (let i = 0; i < count; i++) {
          const angle =
            count === 1 ? baseAngle : baseAngle - spread / 2 + (spread * i) / (count - 1);
          this.projectiles.push({
            kind: 'ricochet',
            sourceId: 'celestial_panacea',
            spriteId: 'vial',
            color: PALETTE.coral,
            x: p.x,
            y: p.y,
            vx: Math.cos(angle) * stats.speed,
            vy: Math.sin(angle) * stats.speed,
            speed: stats.speed,
            radius: Math.max(13, area * 0.55),
            damage,
            knockback: kb,
            pierceLeft: Math.max(4, pierce),
            age: 0,
            maxLife: stats.duration,
            rotation: angle,
            spinSpeed: 12,
            scale: 2.15,
            hitIds: new Set(),
            grantStarlightBuffOnHit: true,
            bonusCritChance: 0.12,
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
            proj.burnDuration,
            proj.chillDuration,
            proj.chillFactor
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
            armorShredDuration: proj.armorShredDuration,
            armorShredBonus: proj.armorShredBonus,
            shatterBonus: proj.shatterBonus,
            bonusCritChance: proj.bonusCritChance,
          });
          if (proj.grantStarlightBuffOnHit) {
            const auraR = 190 * ctx.stats.areaMult * (ctx.stats.hasAuraRadiusBoost ? 1.25 : 1);
            ctx.grantStarlightInRadius?.(p.x, p.y, auraR, 2.6);
          }
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
    burnDuration?: number,
    chillDuration?: number,
    chillFactor?: number
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
        chillDuration,
        chillFactor,
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
          tauntDuration: n.tauntDuration,
          burnDps: n.burnDps,
          burnDuration: n.burnDuration,
          burnColor: n.burnColor,
          shatterBonus: n.shatterBonus,
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

      // Protective Ward periodic shield pulse to self & nearby teammates
      if (orb.shieldPulseTimer !== undefined && orb.shieldAmount) {
        orb.shieldPulseTimer -= dt;
        if (orb.shieldPulseTimer <= 0) {
          orb.shieldPulseTimer = 1.6;
          const auraRadius = 145 * ctx.stats.areaMult * (ctx.stats.hasAuraRadiusBoost ? 1.25 : 1);
          ctx.grantShieldInRadius?.(p.x, p.y, auraRadius, orb.shieldAmount, 4.5);
          ctx.spawnRingParticle(p.x, p.y, PALETTE.butterLight, auraRadius * 0.55, 0.28);
        }
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
            tauntDuration: arc.tauntDuration,
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


  private updateZones(dt: number, ctx: CombatContext): void {
    for (let i = this.zones.length - 1; i >= 0; i--) {
      const z = this.zones[i];
      z.age += dt;
      if (z.age >= z.maxLife) {
        this.zones.splice(i, 1);
        continue;
      }

      // Continuous gravity vortex pull for Gravity Potion / Caustic Singularity
      if (z.pullStrength && z.pullStrength > 0) {
        const nearby = ctx.spatialHash.queryRadius(z.x, z.y, z.radius, this.queryBuf);
        for (let k = 0; k < nearby.length; k++) {
          const e = nearby[k];
          if (!e.alive) continue;
          const dx = z.x - e.x;
          const dy = z.y - e.y;
          const dist = Math.hypot(dx, dy);
          if (dist > 8) {
            const resist = e.isBoss ? 0.85 : e.knockbackResist * 0.6;
            const pull = z.pullStrength * (1 - resist) * dt;
            e.x += (dx / dist) * pull;
            e.y += (dy / dist) * pull;
          }
        }
      }

      z.tickTimer -= dt;
      if (z.tickTimer <= 0) {
        z.tickTimer = z.tickInterval;

        // Ally support ticks (heal + haste)
        if (z.healPerTick && z.healPerTick > 0) {
          if (ctx.healAlliesInRadius) {
            ctx.healAlliesInRadius(
              z.x,
              z.y,
              z.radius,
              z.healPerTick,
              ctx.stats.hasOverhealToShield
            );
          } else {
            const pd = Math.hypot(ctx.player.x - z.x, ctx.player.y - z.y);
            if (pd <= z.radius) {
              ctx.healPlayer(z.healPerTick);
            }
          }
        }
        if (z.grantHasteSec && z.grantHasteSec > 0) {
          ctx.grantHasteInRadius?.(z.x, z.y, z.radius, z.grantHasteSec);
        }

        // Enemy damage & armor shred ticks
        const victims = ctx.spatialHash.queryRadius(z.x, z.y, z.radius, this.queryBuf);
        for (let v = 0; v < victims.length; v++) {
          const enemy = victims[v];
          if (!enemy.alive) continue;
          ctx.damageEnemy(enemy, z.damage, {
            knockback: z.knockback,
            sourceX: z.x,
            sourceY: z.y,
            color: z.color,
            armorShredBonus: z.armorShredBonus,
            armorShredDuration: z.armorShredDuration,
            burnDps: z.burnDps,
            burnDuration: z.burnDuration,
            burnColor: z.color,
            silent: true,
          });
        }
      }
    }
  }

  private updateTotems(dt: number, ctx: CombatContext): void {
    for (let i = this.totems.length - 1; i >= 0; i--) {
      const t = this.totems[i];
      t.age += dt;
      if (t.age >= t.maxLife) {
        this.totems.splice(i, 1);
        continue;
      }

      // Periodic ally regen & shield pulse
      t.pulseTimer -= dt;
      if (t.pulseTimer <= 0) {
        t.pulseTimer = 1.0;
        ctx.grantTotemRegenInRadius?.(t.x, t.y, t.radius, 1.4);
        if (t.isAegisLantern) {
          ctx.grantShieldInRadius?.(t.x, t.y, t.radius, Math.max(8, Math.round(t.damage * 0.18)), 4.5);
        }
      }

      // Gentle light bolts at nearest threat so Revive Totem is impactful in Solo too
      t.fireTimer -= dt;
      if (t.fireTimer <= 0) {
        const target = ctx.spatialHash.findNearest(t.x, t.y, t.radius * 1.45, (e) => e.alive);
        if (target) {
          t.fireTimer = t.isAegisLantern ? 0.55 : 0.8;
          const angle = Math.atan2(target.y - t.y, target.x - t.x);
          this.projectiles.push({
            kind: 'homing',
            sourceId: t.sourceId,
            spriteId: 'arcane',
            color: t.isAegisLantern ? PALETTE.butter : PALETTE.mintLight,
            x: t.x,
            y: t.y,
            vx: Math.cos(angle) * t.speed,
            vy: Math.sin(angle) * t.speed,
            speed: t.speed,
            radius: t.isAegisLantern ? 12 : 9,
            damage: t.damage,
            knockback: t.knockback,
            pierceLeft: t.pierce,
            age: 0,
            maxLife: 1.5,
            rotation: angle,
            spinSpeed: 6,
            scale: t.isAegisLantern ? 2.0 : 1.7,
            hitIds: new Set(),
            turnRate: 6.5,
          });
        } else {
          t.fireTimer = 0.25;
        }
      }
    }
  }

  /**
   * Exposes read-only combat effect arrays for the client Canvas renderer.
   */
  public getRenderState(): AbilityRenderState {
    return {
      projectiles: this.projectiles,
      beams: this.beams,
      novas: this.novas,
      orbiters: this.orbits,
      meleeArcs: this.meleeArcs,
      strikes: this.strikes,
      chains: this.chainArcs,
      turrets: this.turrets,
      trails: this.trails,
      zones: this.zones,
      totems: this.totems,
    };
  }
}
