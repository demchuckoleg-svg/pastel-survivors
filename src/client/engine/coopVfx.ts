import { ABILITIES } from '@shared/data/abilities';
import { BOSSES } from '@shared/data/enemies';
import { PALETTE } from '@shared/data/palette';
import { SYNERGIES } from '@shared/data/synergies';
import type {
  AbilityId,
  HeroId,
  ProjectileSpriteId,
  SynergyId,
} from '@shared/data/types';
import type {
  BinaryCombatEvent,
  WireBossState,
} from '@shared/protocol';
import type { BossRuntime } from '@shared/sim/types';
import { drawPixelSprite, type SpriteAtlas } from '../art/sprites';
import type {
  InterpolatedEnemy,
  InterpolatedPlayer,
} from '../netClient';

type WorldToScreenFn = (wx: number, wy: number) => { x: number; y: number };

const TEAMMATE_EFFECT_OPACITY = 0.5;
const MAX_LOCAL_PROJECTILES = 280;

interface VisualProjectile {
  netId?: number;
  ownerSlotId: number;
  sourceId: AbilityId | SynergyId;
  spriteId?: ProjectileSpriteId;
  color: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  rotation: number;
  spinSpeed: number;
  scale: number;
  age: number;
  maxLife: number;
  isBoomerang?: boolean;
  isEnemyOrb?: boolean;
}

interface VisualBeam {
  ownerSlotId: number;
  x: number;
  y: number;
  angle: number;
  length: number;
  width: number;
  color: string;
  coreColor: string;
  spriteId?: ProjectileSpriteId;
  age: number;
  maxLife: number;
}

interface VisualNova {
  ownerSlotId: number;
  x: number;
  y: number;
  maxRadius: number;
  color: string;
  ringColor: string;
  age: number;
  maxLife: number;
  followOwner: boolean;
}

interface VisualMeleeArc {
  ownerSlotId: number;
  visualKind: 'greatsword' | 'shield';
  angle: number;
  arcSpread: number;
  radius: number;
  color: string;
  age: number;
  maxLife: number;
}

interface VisualOrbit {
  ownerSlotId: number;
  sourceId: AbilityId | SynergyId;
  visualKind: 'orb' | 'blade' | 'flail' | 'singularity' | 'greatsword' | 'ward';
  spriteId?: ProjectileSpriteId;
  color: string;
  count: number;
  orbitRadius: number;
  itemRadius: number;
  angularSpeed: number;
  baseAngle: number;
  age: number;
  maxLife: number;
}

interface VisualStrike {
  ownerSlotId: number;
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
  delay: number;
  lingerTime: number;
  elapsed: number;
}

interface VisualChain {
  ownerSlotId: number;
  points: Array<{ x: number; y: number }>;
  color: string;
  lineWidth: number;
  age: number;
  maxLife: number;
}

interface VisualTurret {
  ownerSlotId: number;
  x: number;
  y: number;
  angle: number;
  isArtillery: boolean;
  fireTimer: number;
  age: number;
  maxLife: number;
}

interface VisualTrail {
  ownerSlotId: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  radius: number;
  color: string;
  heroId?: HeroId;
  facingLeft?: boolean;
  age: number;
  maxLife: number;
}

interface VisualZone {
  ownerSlotId: number;
  sourceId: AbilityId | SynergyId;
  x: number;
  y: number;
  radius: number;
  color: string;
  ringColor: string;
  isVortex: boolean;
  age: number;
  maxLife: number;
}

interface VisualTotem {
  ownerSlotId: number;
  x: number;
  y: number;
  radius: number;
  isAegisLantern: boolean;
  age: number;
  maxLife: number;
}

interface VisualBossHazard {
  hazardKind: 'arena_ring' | 'meteor_mark' | 'tether_beam';
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  radius: number;
  age: number;
  maxLife: number;
  active: boolean;
}

/**
 * Client-side visual effects engine for Co-op mode.
 * Consumes compact server `AbilityFired`, `BossTelegraph`, & `BossHazard` events to spawn smooth 60 FPS
 * projectiles, AoEs, beams, orbits, chains, zones, totems, and boss telegraphs, dimming teammates'
 * attacks to 50% opacity so local attacks and boss telegraphs stay crisp and readable.
 */
export class CoopVfxSystem {
  private readonly projectiles: VisualProjectile[] = [];
  private readonly projectilesByNetId = new Map<number, VisualProjectile>();
  private readonly beams: VisualBeam[] = [];
  private readonly novas: VisualNova[] = [];
  private readonly meleeArcs: VisualMeleeArc[] = [];
  private readonly orbits: VisualOrbit[] = [];
  private readonly strikes: VisualStrike[] = [];
  private readonly chains: VisualChain[] = [];
  private readonly turrets: VisualTurret[] = [];
  private readonly trails: VisualTrail[] = [];
  private readonly zones: VisualZone[] = [];
  private readonly totems: VisualTotem[] = [];
  private readonly bossHazards: VisualBossHazard[] = [];

  // Reconstructed BossRuntime for feeding directly into BossRenderer
  private bossRuntime: BossRuntime | null = null;
  private lastBossEnemyId = -1;
  private lastBossPhase: WireBossState['phase'] | null = null;
  private lastBossAttackId: string | null = null;
  private telegraphStartPos = new Map<number, { x: number; y: number }>();

  public reset(): void {
    this.projectiles.length = 0;
    this.projectilesByNetId.clear();
    this.beams.length = 0;
    this.novas.length = 0;
    this.meleeArcs.length = 0;
    this.orbits.length = 0;
    this.strikes.length = 0;
    this.chains.length = 0;
    this.turrets.length = 0;
    this.trails.length = 0;
    this.zones.length = 0;
    this.totems.length = 0;
    this.bossHazards.length = 0;
    this.bossRuntime = null;
    this.lastBossEnemyId = -1;
    this.lastBossPhase = null;
    this.lastBossAttackId = null;
    this.telegraphStartPos.clear();
  }

  public getBossRuntime(enemyId: number): Readonly<BossRuntime> | undefined {
    if (this.bossRuntime && this.bossRuntime.enemyId === enemyId) {
      return this.bossRuntime;
    }
    return undefined;
  }

  /**
   * Synchronizes reconstructed BossRuntime from the latest snapshot `WireBossState`
   * so `BossRenderer` renders accurate telegraphs and active beams in Co-op.
   */
  public syncBossState(
    boss: WireBossState | null,
    bossEnemy: InterpolatedEnemy | undefined,
    dt: number
  ): void {
    if (!boss || !bossEnemy) {
      this.bossRuntime = null;
      this.lastBossEnemyId = -1;
      this.lastBossPhase = null;
      this.lastBossAttackId = null;
      return;
    }

    const def = BOSSES[boss.bossId];
    const attackSpec = boss.attackId
      ? def.attacks.find((a) => a.id === boss.attackId) ?? null
      : null;

    const phaseChanged =
      boss.enemyId !== this.lastBossEnemyId ||
      boss.phase !== this.lastBossPhase ||
      boss.attackId !== this.lastBossAttackId;

    if (phaseChanged && boss.phase === 'telegraph') {
      this.telegraphStartPos.set(boss.enemyId, { x: bossEnemy.x, y: bossEnemy.y });
    }

    // Spawn visual boss projectile volley when transitioning from telegraph -> execute
    if (
      phaseChanged &&
      this.lastBossPhase === 'telegraph' &&
      boss.phase === 'execute' &&
      boss.attackId
    ) {
      this.spawnBossExecuteVisuals(boss, bossEnemy);
    }

    const startPos = this.telegraphStartPos.get(boss.enemyId) ?? {
      x: bossEnemy.x,
      y: bossEnemy.y,
    };

    const telegraphDuration = attackSpec?.telegraphSec ?? 0.9;
    const telegraphElapsed = (boss.telegraphPct / 100) * telegraphDuration;

    const prevElapsed =
      this.bossRuntime &&
      this.bossRuntime.enemyId === boss.enemyId &&
      this.bossRuntime.state === boss.phase &&
      this.bossRuntime.currentAttack?.id === boss.attackId
        ? this.bossRuntime.stateElapsed + dt
        : 0;

    const stateDuration =
      boss.phase === 'telegraph'
        ? telegraphDuration
        : boss.phase === 'execute'
        ? boss.attackId === 'aegis_prism_cross'
          ? 2.2
          : 1.25
        : 0.7;

    const stateElapsed = boss.phase === 'telegraph' ? telegraphElapsed : prevElapsed;

    const beamAngles: number[] = [];
    if (boss.attackId === 'wisteria_bloom_beam') {
      beamAngles.push(boss.baseAngle, boss.baseAngle + Math.PI * 0.5);
    } else if (boss.attackId === 'aegis_prism_cross') {
      const rot = boss.phase === 'execute' ? stateElapsed * 0.65 : 0;
      for (let k = 0; k < 4; k++) {
        beamAngles.push(boss.baseAngle + rot + (k * Math.PI) / 2);
      }
    }

    const summonSpots: Array<{ x: number; y: number }> = [];
    if (boss.attackId === 'mochi_summon_adds') {
      const r = Math.max(58, boss.radius || 72);
      for (let k = 0; k < 4; k++) {
        const a = boss.baseAngle + (k * Math.PI) / 2;
        summonSpots.push({
          x: bossEnemy.x + Math.cos(a) * r,
          y: bossEnemy.y + Math.sin(a) * r,
        });
      }
    }

    const jumpHeight =
      boss.attackId === 'mochi_leap_slam' && boss.phase === 'execute'
        ? Math.sin(Math.min(1, stateElapsed / 0.55) * Math.PI) * 140
        : 0;

    this.bossRuntime = {
      enemyId: boss.enemyId,
      bossId: boss.bossId,
      def,
      encounterIndex: boss.encounterIndex,
      cycle: boss.cycle,
      enraged: boss.enraged,
      state: boss.phase,
      currentAttack: attackSpec,
      stateElapsed,
      stateDuration,
      globalCooldown: 0,
      attackCooldowns: {},
      lastAttackId: boss.attackId,
      jumpHeight,
      scaleX: 1,
      scaleY: 1,
      airborne: jumpHeight > 4,
      orbitDir: 1,
      data: {
        startX: startPos.x,
        startY: startPos.y,
        targetX: boss.targetX,
        targetY: boss.targetY,
        radius: boss.radius || 96,
        halfWidth: boss.attackId === 'aegis_lance_charge' ? 38 : 30,
        laneLength: Math.max(260, boss.radius || 420),
        baseAngle: boss.baseAngle,
        beamAngles,
        beamLength: 620,
        beamHalfWidth: boss.attackId === 'aegis_prism_cross' ? 20 : 22,
        rotSpeed: 0.65,
        rotDir: 1,
        innerDangerRadius: 112,
        outerSafeRadius: 210,
        outerDangerRadius: 340,
        tickTimer: 0,
        stepCount: 0,
        secondWaveFired: false,
        dashesRemaining: 0,
        summonSpots,
        meteors: [],
        tetherHalfWidth: boss.radius || 12,
        coneSpread: 1.05,
      },
    };

    this.lastBossEnemyId = boss.enemyId;
    this.lastBossPhase = boss.phase;
    this.lastBossAttackId = boss.attackId;
  }

  public recordBossTelegraphEvent(ev: Extract<BinaryCombatEvent, { type: 'BossTelegraph' }>): void {
    this.telegraphStartPos.set(ev.enemyId, { x: ev.x, y: ev.y });
  }

  public recordBossHazardEvent(ev: Extract<BinaryCombatEvent, { type: 'BossHazard' }>): void {
    const maxLife = Math.max(0.15, ev.durationMs / 1000);
    if (ev.hazardKind === 'arena_ring' || ev.hazardKind === 'tether_beam') {
      // Update existing hazard of same kind in-place for smooth shrinking / tracking
      const existing = this.bossHazards.find((h) => h.hazardKind === ev.hazardKind);
      if (existing) {
        existing.x = ev.x;
        existing.y = ev.y;
        existing.targetX = ev.targetX;
        existing.targetY = ev.targetY;
        existing.radius = ev.radius;
        existing.active = ev.active;
        existing.age = 0;
        existing.maxLife = maxLife;
        return;
      }
    }
    this.bossHazards.push({
      hazardKind: ev.hazardKind,
      x: ev.x,
      y: ev.y,
      targetX: ev.targetX,
      targetY: ev.targetY,
      radius: ev.radius,
      age: 0,
      maxLife,
      active: ev.active,
    });
  }

  private spawnBossExecuteVisuals(boss: WireBossState, bossEnemy: InterpolatedEnemy): void {
    // Boss projectiles (mochi_syrup_burst, wisteria_petal_spiral, macaron spirals, tiramisu volleys)
    // are replicated authoritatively via `ProjectileSpawned` / `ProjectileDespawned` events.
    if (boss.attackId === 'aegis_bastion_nova') {
      this.novas.push({
        ownerSlotId: 0,
        x: bossEnemy.x,
        y: bossEnemy.y,
        maxRadius: 340,
        color: PALETTE.babyBlue,
        ringColor: PALETTE.cream,
        age: 0,
        maxLife: 0.42,
        followOwner: false,
      });
    }
  }

  /**
   * Spawns an authoritative server projectile on the client so visuals match hitboxes 1:1.
   */
  public spawnReplicatedProjectile(
    ev: Extract<BinaryCombatEvent, { type: 'ProjectileSpawned' }>
  ): void {
    const isEnemyOrb = ev.playerId === 0 || ev.spriteId === 'enemy_orb';
    const syn = SYNERGIES[ev.sourceId as SynergyId];
    const ab = ABILITIES[ev.sourceId as AbilityId];
    const color = isEnemyOrb
      ? PALETTE.lavender
      : syn?.color ?? ab?.color ?? PALETTE.lavender;
    const angle = Math.atan2(ev.vy, ev.vx);
    // Keep a small lifetime cushion (+0.25s) so server `ProjectileDespawned` cleanly removes
    // the projectile on impact/expiry rather than vanishing early due to jitter.
    const maxLife = Math.max(0.15, ev.lifeMs / 1000 + 0.25);

    const existing = this.projectilesByNetId.get(ev.netId);
    if (existing) {
      existing.ownerSlotId = ev.playerId;
      existing.sourceId = ev.sourceId;
      existing.spriteId = ev.spriteId;
      existing.color = color;
      existing.x = ev.x;
      existing.y = ev.y;
      existing.vx = ev.vx;
      existing.vy = ev.vy;
      existing.radius = ev.radius;
      existing.rotation = angle;
      existing.spinSpeed = ev.spinSpeed;
      existing.scale = ev.scale;
      existing.age = 0;
      existing.maxLife = maxLife;
      existing.isEnemyOrb = isEnemyOrb;
      return;
    }

    const proj: VisualProjectile = {
      netId: ev.netId,
      ownerSlotId: ev.playerId,
      sourceId: ev.sourceId,
      spriteId: ev.spriteId,
      color,
      x: ev.x,
      y: ev.y,
      vx: ev.vx,
      vy: ev.vy,
      radius: ev.radius,
      rotation: angle,
      spinSpeed: ev.spinSpeed,
      scale: ev.scale,
      age: 0,
      maxLife,
      isEnemyOrb,
    };
    this.pushProjectile(proj);
    this.projectilesByNetId.set(ev.netId, proj);
  }

  /**
   * Applies an authoritative trajectory update (homing turn, boomerang return, ricochet bounce, dash chain).
   */
  public moveReplicatedProjectile(
    ev: Extract<BinaryCombatEvent, { type: 'ProjectileMoved' }>
  ): void {
    const proj = this.projectilesByNetId.get(ev.netId);
    if (!proj) return;
    proj.x = ev.x;
    proj.y = ev.y;
    proj.vx = ev.vx;
    proj.vy = ev.vy;
    if (proj.spinSpeed === 0 && (ev.vx !== 0 || ev.vy !== 0)) {
      proj.rotation = Math.atan2(ev.vy, ev.vx);
    }
  }

  /**
   * Removes an authoritative projectile immediately when it hits an enemy, expires, or returns.
   */
  public despawnReplicatedProjectile(
    ev: Extract<BinaryCombatEvent, { type: 'ProjectileDespawned' }>
  ): void {
    const proj = this.projectilesByNetId.get(ev.netId);
    if (!proj) return;
    this.projectilesByNetId.delete(ev.netId);
    const idx = this.projectiles.indexOf(proj);
    if (idx >= 0) {
      this.projectiles.splice(idx, 1);
    }
  }

  /**
   * Spawns local visual combat effects from a server `AbilityFired` binary event.
   */
  public spawnFromAbilityFired(
    ev: Extract<BinaryCombatEvent, { type: 'AbilityFired' }>,
    players: readonly InterpolatedPlayer[],
    enemies: readonly InterpolatedEnemy[]
  ): void {
    const ownerSlotId = ev.playerId;
    const owner = players.find((p) => p.id === ownerSlotId);
    const originX = owner ? owner.x : ev.x;
    const originY = owner ? owner.y : ev.y;

    const syn = ev.isSynergy ? SYNERGIES[ev.abilityId as SynergyId] : undefined;
    const ab = !ev.isSynergy ? ABILITIES[ev.abilityId as AbilityId] : undefined;

    const behavior = syn ? syn.evolvedSpec.behavior : ab?.behavior ?? 'projectile';
    const color = syn ? syn.color : ab?.color ?? PALETTE.lavender;
    const spriteId = syn ? syn.projectileSprite : ab?.projectileSprite;
    const stats = syn ? syn.evolvedSpec.stats : ab?.baseStats;

    // Authoritative cast aim angle computed by the server's AbilityRunner
    const aimAngle = ev.aimAngle;

    switch (behavior) {
      case 'projectile':
      case 'homing':
      case 'boomerang':
      case 'ricochet': {
        // Authoritative projectiles arrive via `ProjectileSpawned` / `ProjectileMoved` / `ProjectileDespawned`
        // so visual trajectories and impacts match server damage 1:1.
        break;
      }

      case 'beam': {
        const isSpear = ev.abilityId === 'spear_thrust';
        const count = Math.min(isSpear ? 2 : 4, Math.max(1, stats?.count ?? 1));
        const width = Math.max(12, Math.min(34, (stats?.area ?? 20) * 0.75));
        const length = isSpear
          ? 175
          : ev.abilityId === 'starlight_railgun'
          ? 1620
          : ev.abilityId === 'tempest_lance'
          ? 1540
          : ev.abilityId === 'piercing_rail_bow'
          ? 1400
          : 1250;
        const spreadStep =
          ev.abilityId === 'tempest_lance'
            ? 0.24
            : ev.abilityId === 'starlight_railgun'
            ? 0.13
            : ev.abilityId === 'piercing_rail_bow'
            ? 0.14
            : 0.18;

        for (let i = 0; i < count; i++) {
          const offset = count === 1 ? 0 : (i - (count - 1) / 2) * spreadStep;
          this.beams.push({
            ownerSlotId,
            x: originX,
            y: originY,
            angle: aimAngle + offset,
            length,
            width,
            color,
            coreColor: PALETTE.white,
            spriteId: isSpear ? 'spear' : undefined,
            age: 0,
            maxLife: isSpear ? 0.22 : 0.34,
          });
        }
        break;
      }

      case 'nova': {
        this.novas.push({
          ownerSlotId,
          x: originX,
          y: originY,
          maxRadius: Math.min(220, Math.max(90, stats?.area ?? 125)),
          color,
          ringColor: PALETTE.cream,
          age: 0,
          maxLife: 0.38,
          followOwner: true,
        });
        // Note: `absolute_zero` ice shards are replicated via `ProjectileSpawned`
        break;
      }

      case 'melee_arc': {
        this.meleeArcs.push({
          ownerSlotId,
          visualKind: ev.abilityId === 'shield_bash' ? 'shield' : 'greatsword',
          angle: aimAngle,
          arcSpread: ev.abilityId === 'shield_bash' ? 1.85 : 2.15,
          radius: Math.max(66, Math.min(125, stats?.area ?? 82)),
          color,
          age: 0,
          maxLife: 0.24,
        });
        break;
      }

      case 'orbit': {
        const existing = this.orbits.find(
          (o) => o.ownerSlotId === ownerSlotId && o.sourceId === ev.abilityId
        );
        if (existing) {
          existing.age = 0;
          existing.maxLife = Math.max(2.0, Math.min(4.2, stats?.duration ?? 3.0));
        } else {
          const visualKind: VisualOrbit['visualKind'] =
            ev.abilityId === 'chain_flail'
              ? 'flail'
              : ev.abilityId === 'orbiting_blades'
              ? 'blade'
              : ev.abilityId === 'whirlwind_tempest'
              ? 'greatsword'
              : ev.abilityId === 'eclipse_singularity'
              ? 'singularity'
              : 'orb';
          this.orbits.push({
            ownerSlotId,
            sourceId: ev.abilityId,
            visualKind,
            spriteId,
            color,
            count: Math.min(5, Math.max(2, stats?.count ?? 2)),
            orbitRadius: Math.max(62, Math.min(115, stats?.area ?? 78)),
            itemRadius: ev.isSynergy ? 17 : 13,
            angularSpeed: visualKind === 'flail' ? 4.2 : 3.4,
            baseAngle: aimAngle,
            age: 0,
            maxLife: Math.max(2.0, Math.min(4.2, stats?.duration ?? 3.0)),
          });
        }
        break;
      }

      case 'strike':
      case 'rain': {
        const count = Math.min(3, Math.max(1, stats?.count ?? 1));
        const visualKind: VisualStrike['visualKind'] =
          ev.abilityId === 'earth_spike'
            ? 'earth_spike'
            : ev.abilityId === 'ground_slam'
            ? 'ground_slam'
            : ev.abilityId === 'holy_hammer'
            ? 'holy_hammer'
            : ev.abilityId === 'divine_judgment'
            ? 'divine_hammer'
            : ev.abilityId === 'rain_of_arrows'
            ? 'arrow_rain'
            : ev.abilityId === 'cataclysm'
            ? 'cataclysm_meteor'
            : 'meteor';

        const nearby = this.findNearestEnemies(originX, originY, enemies, count, 340);
        for (let i = 0; i < count; i++) {
          const target = nearby[i];
          const tx = target
            ? target.x
            : originX + Math.cos(aimAngle + (i - 0.5) * 0.5) * (95 + i * 35);
          const ty = target
            ? target.y
            : originY + Math.sin(aimAngle + (i - 0.5) * 0.5) * (95 + i * 35);
          this.strikes.push({
            ownerSlotId,
            visualKind,
            spriteId:
              visualKind === 'holy_hammer' || visualKind === 'divine_hammer'
                ? 'hammer'
                : visualKind === 'arrow_rain'
                ? 'arrow'
                : spriteId,
            x: tx,
            y: ty,
            radius: Math.max(30, Math.min(82, stats?.area ?? 44)),
            color,
            delay: visualKind === 'earth_spike' ? 0.18 : 0.34,
            lingerTime: 0.34,
            elapsed: 0,
          });
        }
        break;
      }

      case 'chain': {
        const targets = this.findNearestEnemies(originX, originY, enemies, 4, 340);
        const points: Array<{ x: number; y: number }> = [{ x: originX, y: originY }];
        if (targets.length > 0) {
          for (const t of targets) {
            points.push({ x: t.x, y: t.y });
          }
        } else {
          points.push({
            x: originX + Math.cos(aimAngle) * 165,
            y: originY + Math.sin(aimAngle) * 165,
          });
        }
        this.chains.push({
          ownerSlotId,
          points,
          color,
          lineWidth: ev.isSynergy ? 4.5 : 3.2,
          age: 0,
          maxLife: 0.24,
        });
        break;
      }

      case 'turret': {
        // Keep at most 2 visual turrets per player
        const sameOwner = this.turrets.filter((t) => t.ownerSlotId === ownerSlotId);
        if (sameOwner.length >= 2) {
          const idx = this.turrets.indexOf(sameOwner[0]);
          if (idx >= 0) this.turrets.splice(idx, 1);
        }
        this.turrets.push({
          ownerSlotId,
          x: originX + Math.cos(aimAngle) * 24,
          y: originY + Math.sin(aimAngle) * 24,
          angle: aimAngle,
          isArtillery: ev.abilityId === 'artillery_barrage',
          fireTimer: 0.2,
          age: 0,
          maxLife: Math.min(7, stats?.duration ?? 6),
        });
        break;
      }

      case 'dash': {
        const len = Math.max(120, stats?.area ? stats.area * 3.5 : 170);
        this.trails.push({
          ownerSlotId,
          x1: originX,
          y1: originY,
          x2: originX + Math.cos(aimAngle) * len,
          y2: originY + Math.sin(aimAngle) * len,
          radius: 16,
          color,
          heroId: owner?.classId,
          facingLeft: Math.cos(aimAngle) < 0,
          age: 0,
          maxLife: 0.36,
        });
        break;
      }

      case 'zone': {
        const isVortex =
          ev.abilityId === 'gravity_potion' || ev.abilityId === 'caustic_singularity';
        const isSelfCentered =
          ev.abilityId === 'healing_mist' || ev.abilityId === 'sanctuary_choir';
        const nearby = isSelfCentered
          ? []
          : this.findNearestEnemies(originX, originY, enemies, 1, 340);
        const zx = isSelfCentered
          ? originX
          : nearby[0]?.x ?? originX + Math.cos(aimAngle) * 125;
        const zy = isSelfCentered
          ? originY
          : nearby[0]?.y ?? originY + Math.sin(aimAngle) * 125;
        this.zones.push({
          ownerSlotId,
          sourceId: ev.abilityId,
          x: zx,
          y: zy,
          radius: Math.max(56, Math.min(160, stats?.area ?? 84)),
          color,
          ringColor:
            ev.abilityId === 'sanctuary_choir'
              ? PALETTE.butter
              : ev.abilityId === 'caustic_singularity'
              ? PALETTE.lavender
              : PALETTE.cream,
          isVortex,
          age: 0,
          maxLife: Math.min(5.2, stats?.duration ?? 3.4),
        });
        break;
      }

      case 'totem': {
        const sameOwner = this.totems.filter((t) => t.ownerSlotId === ownerSlotId);
        if (sameOwner.length >= 2) {
          const idx = this.totems.indexOf(sameOwner[0]);
          if (idx >= 0) this.totems.splice(idx, 1);
        }
        this.totems.push({
          ownerSlotId,
          x: originX + Math.cos(aimAngle) * 32,
          y: originY + Math.sin(aimAngle) * 32,
          radius: Math.max(105, Math.min(185, stats?.area ?? 135)),
          isAegisLantern: ev.abilityId === 'aegis_lantern',
          age: 0,
          maxLife: Math.min(11, stats?.duration ?? 7.5),
        });
        break;
      }
    }
  }

  public update(
    dt: number,
    players: readonly InterpolatedPlayer[],
    enemies: readonly InterpolatedEnemy[]
  ): void {
    const playerBySlot = new Map<number, InterpolatedPlayer>();
    for (let i = 0; i < players.length; i++) {
      playerBySlot.set(players[i].id, players[i]);
    }

    // 1. Projectiles
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.age += dt;
      if (p.age >= p.maxLife) {
        if (p.netId !== undefined) {
          this.projectilesByNetId.delete(p.netId);
        }
        this.projectiles.splice(i, 1);
        continue;
      }
      if (p.netId === undefined && p.isBoomerang && p.age > p.maxLife * 0.45) {
        const owner = playerBySlot.get(p.ownerSlotId);
        if (owner) {
          const dx = owner.x - p.x;
          const dy = owner.y - p.y;
          const dist = Math.hypot(dx, dy);
          if (dist > 6) {
            const spd = Math.hypot(p.vx, p.vy);
            p.vx = (dx / dist) * spd;
            p.vy = (dy / dist) * spd;
          }
        }
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.spinSpeed !== 0) {
        p.rotation += p.spinSpeed * dt;
      }
    }

    // 2. Beams
    for (let i = this.beams.length - 1; i >= 0; i--) {
      this.beams[i].age += dt;
      if (this.beams[i].age >= this.beams[i].maxLife) {
        this.beams.splice(i, 1);
      }
    }

    // 3. Novas
    for (let i = this.novas.length - 1; i >= 0; i--) {
      const n = this.novas[i];
      n.age += dt;
      if (n.age >= n.maxLife) {
        this.novas.splice(i, 1);
        continue;
      }
      if (n.followOwner) {
        const owner = playerBySlot.get(n.ownerSlotId);
        if (owner) {
          n.x = owner.x;
          n.y = owner.y;
        }
      }
    }

    // 4. Melee arcs
    for (let i = this.meleeArcs.length - 1; i >= 0; i--) {
      this.meleeArcs[i].age += dt;
      if (this.meleeArcs[i].age >= this.meleeArcs[i].maxLife) {
        this.meleeArcs.splice(i, 1);
      }
    }

    // 5. Orbits
    for (let i = this.orbits.length - 1; i >= 0; i--) {
      const o = this.orbits[i];
      o.age += dt;
      if (o.age >= o.maxLife) {
        this.orbits.splice(i, 1);
        continue;
      }
      o.baseAngle += o.angularSpeed * dt;
    }

    // 6. Strikes
    for (let i = this.strikes.length - 1; i >= 0; i--) {
      const s = this.strikes[i];
      s.elapsed += dt;
      if (s.elapsed >= s.delay + s.lingerTime) {
        this.strikes.splice(i, 1);
      }
    }

    // 7. Chains
    for (let i = this.chains.length - 1; i >= 0; i--) {
      this.chains[i].age += dt;
      if (this.chains[i].age >= this.chains[i].maxLife) {
        this.chains.splice(i, 1);
      }
    }

    // 8. Turrets (visual orientation only; authoritative turret shots arrive via ProjectileSpawned)
    for (let i = this.turrets.length - 1; i >= 0; i--) {
      const t = this.turrets[i];
      t.age += dt;
      if (t.age >= t.maxLife) {
        this.turrets.splice(i, 1);
        continue;
      }
      const target = this.findNearestEnemies(t.x, t.y, enemies, 1, 340)[0];
      if (target) {
        t.angle = Math.atan2(target.y - t.y, target.x - t.x);
      }
    }

    // 9. Trails
    for (let i = this.trails.length - 1; i >= 0; i--) {
      this.trails[i].age += dt;
      if (this.trails[i].age >= this.trails[i].maxLife) {
        this.trails.splice(i, 1);
      }
    }

    // 10. Alchemist Zones
    for (let i = this.zones.length - 1; i >= 0; i--) {
      this.zones[i].age += dt;
      if (this.zones[i].age >= this.zones[i].maxLife) {
        this.zones.splice(i, 1);
      }
    }

    // 11. Alchemist Totems
    for (let i = this.totems.length - 1; i >= 0; i--) {
      this.totems[i].age += dt;
      if (this.totems[i].age >= this.totems[i].maxLife) {
        this.totems.splice(i, 1);
      }
    }

    // 12. Co-op Boss Hazards (arena ring, meteor marks, twin macaron laser tether)
    const mintTwin = enemies.find((e) => e.type === 'twin_macaron_mint');
    const roseTwin = enemies.find((e) => e.type === 'twin_macaron_rose');
    for (let i = this.bossHazards.length - 1; i >= 0; i--) {
      const h = this.bossHazards[i];
      h.age += dt;
      if (h.age >= h.maxLife) {
        this.bossHazards.splice(i, 1);
        continue;
      }
      // Keep Twin Macarons' tether endpoints locked smoothly to interpolated twin positions!
      if (h.hazardKind === 'tether_beam' && mintTwin && roseTwin) {
        h.x = mintTwin.x;
        h.y = mintTwin.y;
        h.targetX = roseTwin.x;
        h.targetY = roseTwin.y;
      }
    }
  }

  // ==========================================================================
  // RENDERING (SELF = 100%, TEAMMATES = 50% OPACITY)
  // ==========================================================================

  private getOpacityForOwner(ownerSlotId: number, selfSlotId: number): number {
    if (ownerSlotId === 0 || ownerSlotId === selfSlotId) return 1;
    return TEAMMATE_EFFECT_OPACITY;
  }

  public renderGroundLayer(
    ctx: CanvasRenderingContext2D,
    selfSlotId: number,
    toScreen: WorldToScreenFn
  ): void {
    // 0. Co-op Boss Hazards (shrinking arena ring, meteor circles, laser tether — always 100% opacity)
    for (let i = 0; i < this.bossHazards.length; i++) {
      const h = this.bossHazards[i];
      const prog = Math.min(1, h.age / Math.max(0.01, h.maxLife));
      ctx.save();
      if (h.hazardKind === 'arena_ring') {
        const s = toScreen(h.x, h.y);
        const outerR = h.radius + 900;
        ctx.globalAlpha = h.active ? 0.2 : 0.12 + prog * 0.12;
        ctx.fillStyle = h.active ? PALETTE.coral : PALETTE.peach;
        ctx.beginPath();
        ctx.arc(s.x, s.y, outerR, 0, Math.PI * 2);
        ctx.arc(s.x, s.y, Math.max(10, h.radius), 0, Math.PI * 2, true);
        ctx.fill('evenodd');

        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = PALETTE.outline;
        ctx.lineWidth = h.active ? 5 : 3;
        if (!h.active) ctx.setLineDash([12, 8]);
        ctx.beginPath();
        ctx.arc(s.x, s.y, h.radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        if (h.active) {
          ctx.strokeStyle = PALETTE.peach;
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.arc(s.x, s.y, h.radius, 0, Math.PI * 2);
          ctx.stroke();
        }
      } else if (h.hazardKind === 'meteor_mark') {
        const s = toScreen(h.x, h.y);
        ctx.globalAlpha = 0.2 + prog * 0.22;
        ctx.fillStyle = PALETTE.coral;
        ctx.beginPath();
        ctx.arc(s.x, s.y, h.radius, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalAlpha = 0.32 + prog * 0.28;
        ctx.fillStyle = PALETTE.peach;
        ctx.beginPath();
        ctx.arc(s.x, s.y, Math.max(4, h.radius * prog), 0, Math.PI * 2);
        ctx.fill();

        ctx.globalAlpha = 0.88;
        ctx.strokeStyle = PALETTE.outline;
        ctx.lineWidth = 2.5;
        ctx.setLineDash([8, 5]);
        ctx.beginPath();
        ctx.arc(s.x, s.y, h.radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (h.hazardKind === 'tether_beam') {
        const s1 = toScreen(h.x, h.y);
        const s2 = toScreen(h.targetX, h.targetY);
        ctx.lineCap = 'round';
        if (!h.active) {
          ctx.globalAlpha = 0.28 + prog * 0.24;
          ctx.strokeStyle = PALETTE.rose;
          ctx.lineWidth = h.radius * 2;
          ctx.beginPath();
          ctx.moveTo(s1.x, s1.y);
          ctx.lineTo(s2.x, s2.y);
          ctx.stroke();

          ctx.globalAlpha = 0.85;
          ctx.strokeStyle = PALETTE.outline;
          ctx.lineWidth = 2.5;
          ctx.setLineDash([8, 6]);
          ctx.beginPath();
          ctx.moveTo(s1.x, s1.y);
          ctx.lineTo(s2.x, s2.y);
          ctx.stroke();
          ctx.setLineDash([]);
        } else {
          const fade = prog > 0.88 ? (1 - prog) / 0.12 : 1;
          const grad = ctx.createLinearGradient(s1.x, s1.y, s2.x, s2.y);
          grad.addColorStop(0, PALETTE.mint);
          grad.addColorStop(0.5, PALETTE.cream);
          grad.addColorStop(1, PALETTE.rose);

          ctx.globalAlpha = 0.82 * fade;
          ctx.strokeStyle = PALETTE.outline;
          ctx.lineWidth = (h.radius + 3) * 2;
          ctx.beginPath();
          ctx.moveTo(s1.x, s1.y);
          ctx.lineTo(s2.x, s2.y);
          ctx.stroke();

          ctx.globalAlpha = 0.94 * fade;
          ctx.strokeStyle = grad;
          ctx.lineWidth = h.radius * 2;
          ctx.beginPath();
          ctx.moveTo(s1.x, s1.y);
          ctx.lineTo(s2.x, s2.y);
          ctx.stroke();

          ctx.strokeStyle = PALETTE.white;
          ctx.lineWidth = Math.max(2, h.radius * 0.55);
          ctx.beginPath();
          ctx.moveTo(s1.x, s1.y);
          ctx.lineTo(s2.x, s2.y);
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    // 0b. Alchemist Zones (with teammate opacity dimming applied!)
    for (let i = 0; i < this.zones.length; i++) {
      const z = this.zones[i];
      const op = this.getOpacityForOwner(z.ownerSlotId, selfSlotId);
      const pos = toScreen(z.x, z.y);
      const fadeIn = Math.min(1, z.age / 0.2);
      const fadeOut = Math.min(1, (z.maxLife - z.age) / 0.35);
      const alpha = Math.max(0, Math.min(fadeIn, fadeOut)) * op;
      const r = z.radius * (1 + Math.sin(z.age * 5 + i) * 0.04);

      ctx.save();
      ctx.globalAlpha = alpha * 0.26;
      ctx.fillStyle = z.color;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      ctx.fill();

      if (z.isVortex) {
        ctx.globalAlpha = alpha * 0.65;
        ctx.strokeStyle = z.ringColor;
        ctx.lineWidth = 2.5;
        const spin = z.age * 3.8;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r * 0.6, spin, spin + Math.PI * 1.2);
        ctx.stroke();
      }

      ctx.globalAlpha = alpha * 0.8;
      ctx.strokeStyle = z.ringColor;
      ctx.lineWidth = 2;
      ctx.setLineDash([7, 5]);
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // 0c. Alchemist Totems (with teammate opacity dimming applied!)
    for (let i = 0; i < this.totems.length; i++) {
      const t = this.totems[i];
      const op = this.getOpacityForOwner(t.ownerSlotId, selfSlotId);
      const pos = toScreen(t.x, t.y);
      ctx.save();
      ctx.globalAlpha = 0.14 * op;
      ctx.fillStyle = t.isAegisLantern ? PALETTE.butter : PALETTE.mintLight;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, t.radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = 0.72 * op;
      ctx.strokeStyle = t.isAegisLantern ? PALETTE.butter : PALETTE.mint;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, t.radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.globalAlpha = op;
      ctx.fillStyle = t.isAegisLantern ? PALETTE.butter : PALETTE.mint;
      ctx.strokeStyle = PALETTE.outline;
      ctx.lineWidth = 2;
      ctx.fillRect(pos.x - 7, pos.y - 10, 14, 18);
      ctx.strokeRect(pos.x - 7, pos.y - 10, 14, 18);
      ctx.fillStyle = PALETTE.white;
      ctx.fillRect(pos.x - 3, pos.y - 6, 6, 10);
      ctx.restore();
    }

    // 1. Expanding Novas
    for (let i = 0; i < this.novas.length; i++) {
      const n = this.novas[i];
      const op = this.getOpacityForOwner(n.ownerSlotId, selfSlotId);
      const pos = toScreen(n.x, n.y);
      const prog = Math.min(1, n.age / n.maxLife);
      const radius = n.maxRadius * (0.2 + 0.8 * (1 - (1 - prog) * (1 - prog)));
      const alpha = Math.max(0, 1 - prog);

      ctx.save();
      ctx.globalAlpha = alpha * 0.34 * op;
      ctx.fillStyle = n.color;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = alpha * 0.9 * op;
      ctx.strokeStyle = n.ringColor;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = PALETTE.outline;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, radius + 2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // 2. Ground Trails
    for (let i = 0; i < this.trails.length; i++) {
      const tr = this.trails[i];
      const op = this.getOpacityForOwner(tr.ownerSlotId, selfSlotId);
      const alpha = Math.max(0, 1 - tr.age / tr.maxLife);
      const s1 = toScreen(tr.x1, tr.y1);
      const s2 = toScreen(tr.x2, tr.y2);

      ctx.save();
      ctx.globalAlpha = alpha * 0.65 * op;
      ctx.strokeStyle = tr.color;
      ctx.lineCap = 'round';
      ctx.lineWidth = tr.radius * 1.3;
      ctx.beginPath();
      ctx.moveTo(s1.x, s1.y);
      ctx.lineTo(s2.x, s2.y);
      ctx.stroke();

      ctx.globalAlpha = alpha * 0.85 * op;
      ctx.strokeStyle = PALETTE.white;
      ctx.lineWidth = Math.max(2, tr.radius * 0.4);
      ctx.stroke();
      ctx.restore();
    }

    // 3. Strike Telegraphs & Craters
    for (let i = 0; i < this.strikes.length; i++) {
      const s = this.strikes[i];
      const op = this.getOpacityForOwner(s.ownerSlotId, selfSlotId);
      const pos = toScreen(s.x, s.y);

      ctx.save();
      if (s.elapsed < s.delay) {
        const progress = Math.min(1, s.elapsed / Math.max(0.01, s.delay));
        ctx.globalAlpha = (0.24 + progress * 0.24) * op;
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, s.radius * progress, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalAlpha = 0.78 * op;
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, s.radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        const lingerAlpha = Math.max(
          0,
          1 - (s.elapsed - s.delay) / Math.max(0.01, s.lingerTime)
        );
        ctx.globalAlpha = lingerAlpha * 0.42 * op;
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, s.radius, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalAlpha = lingerAlpha * 0.85 * op;
        ctx.strokeStyle = PALETTE.outline;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, s.radius, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    // 4. Turrets
    for (let i = 0; i < this.turrets.length; i++) {
      const t = this.turrets[i];
      const op = this.getOpacityForOwner(t.ownerSlotId, selfSlotId);
      const pos = toScreen(t.x, t.y);
      const lifeRatio = Math.max(0, 1 - t.age / t.maxLife);

      ctx.save();
      ctx.globalAlpha = op;
      ctx.fillStyle = PALETTE.shadow;
      ctx.beginPath();
      ctx.ellipse(pos.x, pos.y + 11, 13, 5, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = t.isArtillery ? PALETTE.mintDark : PALETTE.sage;
      ctx.strokeStyle = PALETTE.outline;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, t.isArtillery ? 12 : 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.save();
      ctx.translate(pos.x, pos.y);
      ctx.rotate(t.angle);
      ctx.fillStyle = PALETTE.cream;
      if (t.isArtillery) {
        ctx.fillRect(2, -6, 15, 4);
        ctx.strokeRect(2, -6, 15, 4);
        ctx.fillRect(2, 2, 15, 4);
        ctx.strokeRect(2, 2, 15, 4);
      } else {
        ctx.fillRect(2, -3, 14, 6);
        ctx.strokeRect(2, -3, 14, 6);
      }
      ctx.restore();

      const bw = 24;
      const bx = Math.round(pos.x - bw / 2);
      const by = Math.round(pos.y + 15);
      ctx.fillStyle = PALETTE.outline;
      ctx.fillRect(bx - 1, by - 1, bw + 2, 5);
      ctx.fillStyle = PALETTE.creamDark;
      ctx.fillRect(bx, by, bw, 3);
      ctx.fillStyle = t.isArtillery ? PALETTE.mint : PALETTE.butter;
      ctx.fillRect(bx, by, Math.round(bw * lifeRatio), 3);
      ctx.restore();
    }
  }

  public renderForegroundLayer(
    ctx: CanvasRenderingContext2D,
    selfSlotId: number,
    players: readonly InterpolatedPlayer[],
    toScreen: WorldToScreenFn,
    sprites: SpriteAtlas
  ): void {
    const playerBySlot = new Map<number, InterpolatedPlayer>();
    for (let i = 0; i < players.length; i++) {
      playerBySlot.set(players[i].id, players[i]);
    }

    // 1. Melee Arcs
    for (let i = 0; i < this.meleeArcs.length; i++) {
      const arc = this.meleeArcs[i];
      const owner = playerBySlot.get(arc.ownerSlotId);
      if (!owner) continue;
      const op = this.getOpacityForOwner(arc.ownerSlotId, selfSlotId);
      const pScreen = toScreen(owner.x, owner.y);
      const progress = Math.min(1, arc.age / arc.maxLife);
      const alpha = Math.max(0, 1 - progress * 0.85);
      const half = arc.arcSpread * 0.5;

      ctx.save();
      ctx.translate(pScreen.x, pScreen.y);
      ctx.globalAlpha = alpha * 0.45 * op;
      ctx.fillStyle = arc.color;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, arc.radius, arc.angle - half, arc.angle + half);
      ctx.closePath();
      ctx.fill();

      ctx.globalAlpha = alpha * op;
      ctx.strokeStyle = PALETTE.cream;
      ctx.lineWidth = arc.visualKind === 'shield' ? 9 : 6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(0, 0, arc.radius - 3, arc.angle - half, arc.angle + half);
      ctx.stroke();

      ctx.strokeStyle = PALETTE.outline;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, arc.radius + 1, arc.angle - half, arc.angle + half);
      ctx.stroke();
      ctx.restore();
    }

    // 2. Beams
    for (let i = 0; i < this.beams.length; i++) {
      const b = this.beams[i];
      const op = this.getOpacityForOwner(b.ownerSlotId, selfSlotId);
      const alpha = Math.max(0, 1 - (b.age / b.maxLife) * 0.75);
      const s1 = toScreen(b.x, b.y);
      const s2 = toScreen(
        b.x + Math.cos(b.angle) * b.length,
        b.y + Math.sin(b.angle) * b.length
      );
      const pulseW = b.width * (0.82 + 0.22 * Math.sin(b.age * 40));

      ctx.save();
      ctx.lineCap = 'round';
      ctx.globalAlpha = alpha * 0.6 * op;
      ctx.strokeStyle = PALETTE.outline;
      ctx.lineWidth = pulseW + 4;
      ctx.beginPath();
      ctx.moveTo(s1.x, s1.y);
      ctx.lineTo(s2.x, s2.y);
      ctx.stroke();

      ctx.globalAlpha = alpha * 0.88 * op;
      ctx.strokeStyle = b.color;
      ctx.lineWidth = pulseW;
      ctx.stroke();

      ctx.globalAlpha = alpha * op;
      ctx.strokeStyle = b.coreColor;
      ctx.lineWidth = Math.max(3, pulseW * 0.36);
      ctx.stroke();

      if (b.spriteId) {
        const tipFrac = Math.min(1, 0.4 + (b.age / b.maxLife) * 0.6);
        const tx = s1.x + (s2.x - s1.x) * tipFrac;
        const ty = s1.y + (s2.y - s1.y) * tipFrac;
        this.drawRotatedSprite(ctx, sprites.projectiles[b.spriteId], tx, ty, b.angle, 2.3);
      }
      ctx.restore();
    }

    // 3. Chain Lightning Arcs
    for (let i = 0; i < this.chains.length; i++) {
      const arc = this.chains[i];
      const op = this.getOpacityForOwner(arc.ownerSlotId, selfSlotId);
      const alpha = Math.max(0, 1 - arc.age / arc.maxLife);

      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.globalAlpha = alpha * op;
      for (let pIdx = 0; pIdx < arc.points.length - 1; pIdx++) {
        const a = toScreen(arc.points[pIdx].x, arc.points[pIdx].y);
        const b = toScreen(arc.points[pIdx + 1].x, arc.points[pIdx + 1].y);
        const midX = (a.x + b.x) * 0.5 + (Math.random() - 0.5) * 16;
        const midY = (a.y + b.y) * 0.5 + (Math.random() - 0.5) * 16;

        ctx.strokeStyle = PALETTE.outline;
        ctx.lineWidth = arc.lineWidth + 3;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(midX, midY);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();

        ctx.strokeStyle = arc.color;
        ctx.lineWidth = arc.lineWidth;
        ctx.stroke();

        ctx.strokeStyle = PALETTE.white;
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }
      ctx.restore();
    }

    // 4. Orbits
    for (let i = 0; i < this.orbits.length; i++) {
      const orb = this.orbits[i];
      const owner = playerBySlot.get(orb.ownerSlotId);
      if (!owner) continue;
      const op = this.getOpacityForOwner(orb.ownerSlotId, selfSlotId);
      const pScreen = toScreen(owner.x, owner.y);

      for (let k = 0; k < orb.count; k++) {
        const a = orb.baseAngle + (k * Math.PI * 2) / orb.count;
        const ix = owner.x + Math.cos(a) * orb.orbitRadius;
        const iy = owner.y + Math.sin(a) * orb.orbitRadius;
        const pos = toScreen(ix, iy);

        ctx.save();
        ctx.globalAlpha = op;
        if (orb.visualKind === 'flail') {
          ctx.strokeStyle = PALETTE.outline;
          ctx.lineWidth = 2.5;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(pScreen.x, pScreen.y);
          ctx.lineTo(pos.x, pos.y);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.fillStyle = PALETTE.slateLight;
          ctx.strokeStyle = PALETTE.outline;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, orb.itemRadius * 0.72, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        } else if (orb.visualKind === 'blade' || orb.visualKind === 'greatsword') {
          const isGreat = orb.visualKind === 'greatsword';
          const len = isGreat ? 30 : 21;
          const wid = isGreat ? 9 : 7;
          ctx.translate(pos.x, pos.y);
          ctx.rotate(a + Math.PI / 2);
          ctx.fillStyle = orb.color;
          ctx.strokeStyle = PALETTE.outline;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(len * 0.65, 0);
          ctx.lineTo(-len * 0.35, -wid * 0.5);
          ctx.lineTo(-len * 0.55, 0);
          ctx.lineTo(-len * 0.35, wid * 0.5);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        } else if (orb.spriteId) {
          this.drawRotatedSprite(
            ctx,
            sprites.projectiles[orb.spriteId],
            pos.x,
            pos.y,
            a * 2,
            orb.visualKind === 'singularity' ? 2.4 : 2.0
          );
        } else {
          ctx.fillStyle = orb.color;
          ctx.strokeStyle = PALETTE.outline;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, orb.itemRadius * 0.7, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    // 5. Falling Meteors / Hammers / Arrows / Erupting Spikes
    for (let i = 0; i < this.strikes.length; i++) {
      const s = this.strikes[i];
      const op = this.getOpacityForOwner(s.ownerSlotId, selfSlotId);
      const pos = toScreen(s.x, s.y);

      ctx.save();
      ctx.globalAlpha = op;
      if (s.elapsed < s.delay) {
        const progress = Math.min(1, s.elapsed / Math.max(0.01, s.delay));
        if (
          s.visualKind === 'meteor' ||
          s.visualKind === 'cataclysm_meteor' ||
          s.visualKind === 'holy_hammer' ||
          s.visualKind === 'divine_hammer'
        ) {
          const dropHeight = (1 - progress) * 220;
          const dropOffsetX =
            s.visualKind === 'meteor' || s.visualKind === 'cataclysm_meteor'
              ? (1 - progress) * 80
              : 0;
          const scale =
            s.visualKind === 'cataclysm_meteor' || s.visualKind === 'divine_hammer' ? 3.0 : 2.3;
          if (s.spriteId) {
            this.drawRotatedSprite(
              ctx,
              sprites.projectiles[s.spriteId],
              pos.x + dropOffsetX,
              pos.y - dropHeight,
              s.visualKind.includes('hammer') ? 0 : Math.PI * 0.65,
              scale
            );
          }
        } else if (s.visualKind === 'arrow_rain') {
          const dropHeight = (1 - progress) * 165;
          for (let k = -1; k <= 1; k++) {
            this.drawRotatedSprite(
              ctx,
              sprites.projectiles.arrow,
              pos.x + k * 14 + (1 - progress) * 24,
              pos.y - dropHeight + Math.abs(k) * 9,
              Math.PI * 0.55,
              1.6
            );
          }
        }
      } else if (s.visualKind === 'earth_spike' || s.visualKind === 'ground_slam') {
        const lingerRatio = Math.max(
          0,
          1 - (s.elapsed - s.delay) / Math.max(0.01, s.lingerTime)
        );
        ctx.globalAlpha = lingerRatio * op;
        const h = s.radius * 0.82 * Math.min(1, lingerRatio * 2);
        const w = s.radius * 0.4;
        ctx.fillStyle = s.color;
        ctx.strokeStyle = PALETTE.outline;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(pos.x, pos.y - h);
        ctx.lineTo(pos.x + w, pos.y + 6);
        ctx.lineTo(pos.x - w, pos.y + 6);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }

    // 6. Active Projectiles (Self 100%, Teammates 50%, Boss Orbs 100%)
    for (let i = 0; i < this.projectiles.length; i++) {
      const proj = this.projectiles[i];
      const op = proj.isEnemyOrb
        ? 1
        : this.getOpacityForOwner(proj.ownerSlotId, selfSlotId);
      const pos = toScreen(proj.x, proj.y);
      const fade = proj.age > proj.maxLife * 0.8 ? (proj.maxLife - proj.age) / (proj.maxLife * 0.2) : 1;

      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, fade)) * op;

      if (proj.isEnemyOrb) {
        ctx.save();
        ctx.globalAlpha = 0.42 * fade;
        ctx.fillStyle = proj.color;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, proj.radius + 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        drawPixelSprite(ctx, sprites.projectiles.enemy_orb, pos.x, pos.y, proj.scale, false, false);
        ctx.restore();
        continue;
      }

      if (proj.sourceId === 'firestorm') {
        ctx.save();
        ctx.globalAlpha = 0.32 * op;
        ctx.fillStyle = PALETTE.coral;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, proj.radius * 1.25, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      if (proj.sourceId === 'wind_blade') {
        ctx.translate(pos.x, pos.y);
        ctx.rotate(proj.rotation);
        ctx.strokeStyle = PALETTE.outline;
        ctx.lineWidth = 6;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(0, 0, proj.radius * 0.78, -1.1, 1.1);
        ctx.stroke();

        ctx.strokeStyle = PALETTE.mint;
        ctx.lineWidth = 3.5;
        ctx.stroke();
      } else if (proj.spriteId) {
        this.drawRotatedSprite(
          ctx,
          sprites.projectiles[proj.spriteId],
          pos.x,
          pos.y,
          proj.rotation,
          proj.scale
        );
      } else {
        ctx.fillStyle = proj.color;
        ctx.strokeStyle = PALETTE.outline;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, proj.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }

      ctx.restore();
    }
  }

  private pushProjectile(p: VisualProjectile): void {
    if (this.projectiles.length >= MAX_LOCAL_PROJECTILES) {
      const evicted = this.projectiles.shift();
      if (evicted?.netId !== undefined) {
        this.projectilesByNetId.delete(evicted.netId);
      }
    }
    this.projectiles.push(p);
  }

  private findNearestEnemies(
    x: number,
    y: number,
    enemies: readonly InterpolatedEnemy[],
    limit: number,
    maxDist: number
  ): InterpolatedEnemy[] {
    const maxDistSq = maxDist * maxDist;
    const scored: Array<{ enemy: InterpolatedEnemy; dSq: number }> = [];
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      const dx = e.x - x;
      const dy = e.y - y;
      const dSq = dx * dx + dy * dy;
      if (dSq <= maxDistSq) {
        scored.push({ enemy: e, dSq });
      }
    }
    scored.sort((a, b) => a.dSq - b.dSq);
    return scored.slice(0, limit).map((s) => s.enemy);
  }

  private drawRotatedSprite(
    ctx: CanvasRenderingContext2D,
    sprite: HTMLCanvasElement,
    x: number,
    y: number,
    angle: number,
    scale: number
  ): void {
    const w = sprite.width * scale;
    const h = sprite.height * scale;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.translate(Math.round(x), Math.round(y));
    ctx.rotate(angle);
    ctx.drawImage(sprite, Math.round(-w / 2), Math.round(-h / 2), w, h);
    ctx.restore();
  }
}
