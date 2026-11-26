import { BOSS_ORDER, BOSSES, enemyHP } from '../data/enemies';
import { PALETTE } from '../data/palette';
import type { BossAttackSpec, BossDef, BossId, EnemySpriteId } from '../data/types';
import type {
  BossActiveInfo,
  BossAttackData,
  BossPhaseState,
  BossProjectileParams,
  BossRuntime,
  BossVisualState,
  EnemyEntity,
  ParticleBurstOptions,
} from './types';

export type {
  BossActiveInfo,
  BossPhaseState,
  BossProjectileParams,
  BossRuntime,
  BossVisualState,
};

/**
 * Pure simulation state machines for the 3 cycling Bosses:
 *  - King Mochi (10:00, 40:00, ...): Royal Leap Slam, Syrup Nova, Mochi Split
 *  - Lady Wisteria (20:00, 50:00, ...): Petal Spiral, Dusk Ray, Wisteria Waltz
 *  - Aegis the Porcelain Warden (30:00, 60:00, ...): Warden Charge, Porcelain Prism, Aegis Judgment
 */

export interface BossTelegraphInfo {
  enemyId: number;
  bossId: BossId;
  attackId: string;
  attackName: string;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  telegraphSec: number;
  color: string;
}

export interface BossAIContext {
  player: {
    x: number;
    y: number;
    vx: number;
    vy: number;
    radius: number;
  };
  elapsedRunSec: number;
  damagePlayer: (rawDamage: number) => void;
  spawnEnemyProjectile: (opts: BossProjectileParams) => void;
  spawnMinion: (
    archetypeId: EnemySpriteId,
    x: number,
    y: number,
    impulseX?: number,
    impulseY?: number
  ) => void;
  spawnParticles: (
    x: number,
    y: number,
    color: string,
    count: number,
    opts?: ParticleBurstOptions
  ) => void;
  spawnRingParticle: (
    x: number,
    y: number,
    color: string,
    maxRadius: number,
    duration?: number
  ) => void;
  spawnFloatingText: (
    x: number,
    y: number,
    text: string,
    color: string,
    isCrit?: boolean
  ) => void;
  addScreenShake: (intensity: number, durationSec: number) => void;
  getMinionCount: () => number;
  onTelegraph?: (info: BossTelegraphInfo) => void;
}

const DEFAULT_VISUAL: BossVisualState = {
  jumpHeight: 0,
  scaleX: 1,
  scaleY: 1,
  airborne: false,
  telegraphRatio: 0,
  enraged: false,
  accentColor: PALETTE.coral,
};

// ============================================================================
// BOSS SCALING HELPERS
// ============================================================================

/**
 * 0-based cycle index: 0 for 10/20/30m, 1 for 40/50/60m, 2 for 70/80/90m, etc.
 */
export function getBossCycle(encounterIndex: number): number {
  return Math.floor(Math.max(0, Math.floor(encounterIndex)) / BOSS_ORDER.length);
}

/**
 * Scales Boss HP using the exact enemyHP(baseHP, t) curve plus a +35% bonus per full 30-min cycle.
 */
export function getBossScaledHp(
  bossDef: BossDef,
  elapsedMinutes: number,
  encounterIndex: number
): number {
  const cycle = getBossCycle(encounterIndex);
  const baseScaled = enemyHP(bossDef.baseHp, Math.max(0, elapsedMinutes));
  return Math.round(baseScaled * (1 + cycle * 0.35));
}

/**
 * Faster cooldown multiplier as bosses cycle every 10 minutes (and -15% when Enraged <50% HP).
 */
export function getBossCooldownScale(encounterIndex: number, enraged: boolean): number {
  const cycle = getBossCycle(encounterIndex);
  const cycleMult = Math.pow(0.84, cycle);
  const enrageMult = enraged ? 0.85 : 1;
  return Math.max(0.42, cycleMult * enrageMult);
}

/**
 * Slightly tighter telegraph timings on higher cycles, floored so attacks remain dodgeable.
 */
export function getBossTelegraphScale(encounterIndex: number): number {
  const cycle = getBossCycle(encounterIndex);
  return Math.max(0.74, Math.pow(0.94, cycle));
}

/**
 * Gentle damage scaling with elapsed time and cycle count.
 */
export function getBossDamageScale(elapsedMinutes: number, encounterIndex: number): number {
  const cycle = getBossCycle(encounterIndex);
  return 1 + 0.045 * Math.max(0, elapsedMinutes) + cycle * 0.15;
}

// ============================================================================
// GEOMETRY HELPERS
// ============================================================================

function distPointToSegmentSq(
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
    const ex = px - x1;
    const ey = py - y1;
    return ex * ex + ey * ey;
  }
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  const ex = px - cx;
  const ey = py - cy;
  return ex * ex + ey * ey;
}

function createEmptyAttackData(): BossAttackData {
  return {
    startX: 0,
    startY: 0,
    targetX: 0,
    targetY: 0,
    radius: 100,
    halfWidth: 28,
    laneLength: 380,
    baseAngle: 0,
    beamAngles: [],
    beamLength: 520,
    beamHalfWidth: 16,
    rotSpeed: 0,
    rotDir: 1,
    innerDangerRadius: 108,
    outerSafeRadius: 192,
    outerDangerRadius: 305,
    tickTimer: 0,
    stepCount: 0,
    secondWaveFired: false,
    dashesRemaining: 0,
    summonSpots: [],
  };
}

// ============================================================================
// BOSS AI MANAGER
// ============================================================================

export class BossAIManager {
  private readonly runtimes = new Map<number, BossRuntime>();

  public reset(): void {
    this.runtimes.clear();
  }

  public registerBoss(enemy: EnemyEntity, bossId: BossId, encounterIndex: number): void {
    const def = BOSSES[bossId];
    const cycle = getBossCycle(encounterIndex);
    const cdScale = getBossCooldownScale(encounterIndex, false);
    const attackCooldowns: Record<string, number> = {};

    for (let i = 0; i < def.attacks.length; i++) {
      const atk = def.attacks[i];
      // Stagger initial attack readiness so the boss opens quickly with an exciting move
      attackCooldowns[atk.id] = (0.7 + i * 0.9) * cdScale;
    }

    this.runtimes.set(enemy.id, {
      enemyId: enemy.id,
      bossId,
      def,
      encounterIndex,
      cycle,
      enraged: false,
      state: 'chase',
      currentAttack: null,
      stateElapsed: 0,
      stateDuration: 0,
      globalCooldown: 1.15 * cdScale,
      attackCooldowns,
      lastAttackId: null,
      jumpHeight: 0,
      scaleX: 1,
      scaleY: 1,
      airborne: false,
      orbitDir: Math.random() < 0.5 ? 1 : -1,
      data: createEmptyAttackData(),
    });
  }

  public onBossRemoved(enemyId: number): void {
    this.runtimes.delete(enemyId);
  }

  public hasActiveBoss(): boolean {
    return this.runtimes.size > 0;
  }

  public isAirborne(enemyId: number): boolean {
    return this.runtimes.get(enemyId)?.airborne ?? false;
  }

  public getVisualState(enemyId: number): BossVisualState {
    const rt = this.runtimes.get(enemyId);
    if (!rt) return DEFAULT_VISUAL;
    const telegraphRatio =
      rt.state === 'telegraph' && rt.stateDuration > 0
        ? Math.max(0, Math.min(1, rt.stateElapsed / rt.stateDuration))
        : 0;
    return {
      jumpHeight: rt.jumpHeight,
      scaleX: rt.scaleX,
      scaleY: rt.scaleY,
      airborne: rt.airborne,
      telegraphRatio,
      enraged: rt.enraged,
      accentColor: rt.def.accentColor,
    };
  }

  public getBossInfo(enemy: EnemyEntity): BossActiveInfo | null {
    const rt = this.runtimes.get(enemy.id);
    if (!rt) return null;
    return {
      enemyId: enemy.id,
      bossId: rt.bossId,
      name: rt.def.name,
      title: rt.def.title,
      hp: Math.max(0, enemy.hp),
      maxHp: enemy.maxHp,
      accentColor: rt.def.accentColor,
      cycle: rt.cycle,
      encounterIndex: rt.encounterIndex,
      enraged: rt.enraged,
      state: rt.state,
      currentAttackName:
        rt.state === 'telegraph' || rt.state === 'execute'
          ? rt.currentAttack?.name ?? null
          : null,
    };
  }

  /**
   * Steps a single boss entity's state machine for the current frame.
   * Returns true if contact damage should be evaluated normally this frame.
   */
  public updateBoss(enemy: EnemyEntity, dt: number, ctx: BossAIContext): boolean {
    const rt = this.runtimes.get(enemy.id);
    if (!rt || !enemy.alive) return true;

    // Trigger Phase 2 / Enrage at 50% HP
    if (!rt.enraged && enemy.hp <= enemy.maxHp * 0.5) {
      rt.enraged = true;
      ctx.spawnRingParticle(enemy.x, enemy.y, rt.def.accentColor, 130, 0.5);
      ctx.spawnParticles(enemy.x, enemy.y, rt.def.accentColor, 20, {
        speedMin: 70,
        speedMax: 210,
        sizeMin: 4,
        sizeMax: 7,
      });
      ctx.spawnFloatingText(enemy.x, enemy.y - enemy.radius - 18, 'ENRAGED!', rt.def.accentColor, true);
      ctx.addScreenShake(4.5, 0.22);
    }

    // Tick individual attack cooldowns & global cooldown
    for (const key of Object.keys(rt.attackCooldowns)) {
      if (rt.attackCooldowns[key] > 0) {
        rt.attackCooldowns[key] = Math.max(0, rt.attackCooldowns[key] - dt);
      }
    }
    if (rt.state === 'chase' && rt.globalCooldown > 0) {
      rt.globalCooldown = Math.max(0, rt.globalCooldown - dt);
    }

    // Smoothly relax squash/stretch toward (1, 1) unless overridden below
    const relax = 1 - Math.exp(-10 * dt);
    rt.scaleX += (1 - rt.scaleX) * relax;
    rt.scaleY += (1 - rt.scaleY) * relax;

    switch (rt.state) {
      case 'chase':
        this.updateChase(enemy, rt, dt, ctx);
        break;
      case 'telegraph':
        this.updateTelegraph(enemy, rt, dt, ctx);
        break;
      case 'execute':
        this.updateExecute(enemy, rt, dt, ctx);
        break;
      case 'recover':
        this.updateRecover(enemy, rt, dt);
        break;
    }

    // Apply minimal damped knockback (bosses have very high resistance)
    const kbDecay = Math.exp(-12 * dt);
    enemy.x += (enemy.vx + enemy.kbVx) * dt;
    enemy.y += (enemy.vy + enemy.kbVy) * dt;
    enemy.kbVx *= kbDecay;
    enemy.kbVy *= kbDecay;

    return !rt.airborne;
  }

  // ==========================================================================
  // STATE MACHINE PHASES
  // ==========================================================================

  private updateChase(
    enemy: EnemyEntity,
    rt: BossRuntime,
    dt: number,
    ctx: BossAIContext
  ): void {
    const dx = ctx.player.x - enemy.x;
    const dy = ctx.player.y - enemy.y;
    const dist = Math.hypot(dx, dy);
    const slowMult = enemy.slowTimer > 0 ? Math.max(0.65, enemy.slowFactor) : 1;
    const enrageSpd = rt.enraged ? 1.14 : 1;
    const cycleSpd = 1 + Math.min(0.35, rt.cycle * 0.08);
    const spd = enemy.speed * slowMult * enrageSpd * cycleSpd;

    if (dist > 0.01) {
      const nx = dx / dist;
      const ny = dy / dist;

      if (rt.bossId === 'lady_wisteria' && dist < 240) {
        // Lady Wisteria weaves gracefully at mid-range
        const approachWeight = dist < 130 ? -0.35 : 0.45;
        const strafeWeight = 0.85 * rt.orbitDir;
        const mvx = nx * approachWeight - ny * strafeWeight;
        const mvy = ny * approachWeight + nx * strafeWeight;
        const mLen = Math.hypot(mvx, mvy) || 1;
        enemy.vx = (mvx / mLen) * spd;
        enemy.vy = (mvy / mLen) * spd;
      } else {
        enemy.vx = nx * spd;
        enemy.vy = ny * spd;
      }

      if (Math.abs(nx) > 0.08) {
        enemy.facingLeft = nx < 0;
      }
    } else {
      enemy.vx = 0;
      enemy.vy = 0;
    }

    enemy.walkTime += dt * (rt.enraged ? 1.25 : 1);

    // Choose next telegraphed attack when ready
    if (rt.globalCooldown <= 0) {
      const chosen = this.pickNextAttack(enemy, rt, dist, ctx);
      if (chosen) {
        this.beginTelegraph(enemy, rt, chosen, ctx);
      }
    }
  }

  private pickNextAttack(
    _enemy: EnemyEntity,
    rt: BossRuntime,
    distToPlayer: number,
    ctx: BossAIContext
  ): BossAttackSpec | null {
    const ready: BossAttackSpec[] = [];
    for (let i = 0; i < rt.def.attacks.length; i++) {
      const atk = rt.def.attacks[i];
      if ((rt.attackCooldowns[atk.id] ?? 0) > 0) continue;
      // Avoid flooding the arena if too many mini-slimes are already active
      if (atk.id === 'mochi_summon_adds' && ctx.getMinionCount() >= 14) continue;
      ready.push(atk);
    }
    if (ready.length === 0) return null;

    // Prefer not repeating the immediately previous attack when alternatives exist
    const nonRepeat = ready.filter((a) => a.id !== rt.lastAttackId);
    const candidates = nonRepeat.length > 0 ? nonRepeat : ready;

    // Contextual weighting based on distance to player
    let totalWeight = 0;
    const weights = candidates.map((atk) => {
      let w = 1;
      if (atk.id === 'mochi_leap_slam') w = distToPlayer > 160 ? 2.2 : 1.1;
      else if (atk.id === 'mochi_syrup_burst') w = distToPlayer < 240 ? 1.8 : 1.0;
      else if (atk.id === 'wisteria_blink_dash') w = distToPlayer > 150 ? 1.9 : 1.0;
      else if (atk.id === 'aegis_lance_charge') w = distToPlayer > 170 ? 2.1 : 1.0;
      else if (atk.id === 'aegis_bastion_nova') w = distToPlayer < 250 ? 1.9 : 1.1;
      totalWeight += w;
      return w;
    });

    let roll = Math.random() * totalWeight;
    for (let i = 0; i < candidates.length; i++) {
      roll -= weights[i];
      if (roll <= 0) return candidates[i];
    }
    return candidates[0];
  }

  private beginTelegraph(
    enemy: EnemyEntity,
    rt: BossRuntime,
    atk: BossAttackSpec,
    ctx: BossAIContext
  ): void {
    const teleScale = getBossTelegraphScale(rt.encounterIndex);
    const data = createEmptyAttackData();
    const dx = ctx.player.x - enemy.x;
    const dy = ctx.player.y - enemy.y;
    const angleToPlayer = Math.atan2(dy, dx);

    rt.state = 'telegraph';
    rt.currentAttack = atk;
    rt.stateElapsed = 0;
    rt.stateDuration = atk.telegraphSec * teleScale;
    rt.lastAttackId = atk.id;
    rt.data = data;

    enemy.vx = 0;
    enemy.vy = 0;
    if (Math.abs(dx) > 4) {
      enemy.facingLeft = dx < 0;
    }

    switch (atk.id) {
      // ---- KING MOCHI ----
      case 'mochi_leap_slam': {
        const leadX = ctx.player.x + ctx.player.vx * 0.22;
        const leadY = ctx.player.y + ctx.player.vy * 0.22;
        const ldx = leadX - enemy.x;
        const ldy = leadY - enemy.y;
        const lDist = Math.hypot(ldx, ldy);
        const maxJump = 330;
        const clampRatio = lDist > maxJump ? maxJump / lDist : 1;
        data.startX = enemy.x;
        data.startY = enemy.y;
        data.targetX = enemy.x + ldx * clampRatio;
        data.targetY = enemy.y + ldy * clampRatio;
        data.radius = 104 + Math.min(20, rt.cycle * 8);
        break;
      }

      case 'mochi_syrup_burst': {
        data.baseAngle = angleToPlayer;
        data.radius = 86;
        break;
      }

      case 'mochi_summon_adds': {
        const count = Math.min(8, 4 + rt.cycle + (rt.enraged ? 1 : 0));
        const ringR = 82;
        for (let i = 0; i < count; i++) {
          const a = angleToPlayer + (Math.PI * 2 * i) / count;
          data.summonSpots.push({
            x: enemy.x + Math.cos(a) * ringR,
            y: enemy.y + Math.sin(a) * ringR,
          });
        }
        break;
      }

      // ---- LADY WISTERIA ----
      case 'wisteria_petal_spiral': {
        data.baseAngle = angleToPlayer;
        data.radius = 74;
        data.rotDir = rt.orbitDir;
        break;
      }

      case 'wisteria_bloom_beam': {
        // Dual crossing pastel beam lines aimed cleanly through the hero's sector
        data.baseAngle = angleToPlayer;
        const spread = 0.34;
        data.beamAngles = [
          angleToPlayer - spread,
          angleToPlayer + spread,
          angleToPlayer - spread + Math.PI,
          angleToPlayer + spread + Math.PI,
        ];
        data.beamLength = 560;
        data.beamHalfWidth = 17;
        break;
      }

      case 'wisteria_blink_dash': {
        this.lockDashLane(enemy, data, angleToPlayer, 370, 26);
        data.dashesRemaining = rt.enraged || rt.cycle >= 1 ? 2 : 1;
        break;
      }

      // ---- AEGIS THE PORCELAIN WARDEN ----
      case 'aegis_lance_charge': {
        this.lockDashLane(enemy, data, angleToPlayer, 440, 34);
        break;
      }

      case 'aegis_prism_cross': {
        // Offset by 45deg from player so the hero begins inside a safe quadrant
        const startA = angleToPlayer + Math.PI / 4;
        data.baseAngle = startA;
        data.beamAngles = [
          startA,
          startA + Math.PI * 0.5,
          startA + Math.PI,
          startA + Math.PI * 1.5,
        ];
        data.beamLength = 540;
        data.beamHalfWidth = 16;
        data.rotDir = Math.random() < 0.5 ? 1 : -1;
        data.rotSpeed = 0.48 + Math.min(0.32, rt.cycle * 0.08) + (rt.enraged ? 0.1 : 0);
        break;
      }

      case 'aegis_bastion_nova': {
        data.innerDangerRadius = 108;
        data.outerSafeRadius = 192;
        data.outerDangerRadius = 305;
        break;
      }
    }

    ctx.onTelegraph?.({
      enemyId: enemy.id,
      bossId: rt.bossId,
      attackId: atk.id,
      attackName: atk.name,
      x: enemy.x,
      y: enemy.y,
      targetX: data.targetX || ctx.player.x,
      targetY: data.targetY || ctx.player.y,
      telegraphSec: rt.stateDuration,
      color: rt.def.accentColor,
    });
  }

  private lockDashLane(
    enemy: EnemyEntity,
    data: BossAttackData,
    angle: number,
    length: number,
    halfWidth: number
  ): void {
    data.baseAngle = angle;
    data.laneLength = length;
    data.halfWidth = halfWidth;
    data.startX = enemy.x;
    data.startY = enemy.y;
    data.targetX = enemy.x + Math.cos(angle) * length;
    data.targetY = enemy.y + Math.sin(angle) * length;
  }

  private updateTelegraph(
    enemy: EnemyEntity,
    rt: BossRuntime,
    dt: number,
    ctx: BossAIContext
  ): void {
    rt.stateElapsed += dt;
    enemy.vx = 0;
    enemy.vy = 0;

    const progress = Math.min(1, rt.stateElapsed / Math.max(0.01, rt.stateDuration));

    // Expressive pixel-art squash/charge animation during telegraph
    if (rt.currentAttack?.id === 'mochi_leap_slam') {
      rt.scaleX = 1 + progress * 0.22;
      rt.scaleY = 1 - progress * 0.2;
    } else if (rt.currentAttack?.id === 'mochi_syrup_burst' || rt.currentAttack?.id === 'aegis_bastion_nova') {
      const pulse = Math.sin(progress * Math.PI * 4) * 0.07;
      rt.scaleX = 1 + pulse + progress * 0.08;
      rt.scaleY = 1 - pulse + progress * 0.08;
    }

    if (rt.stateElapsed >= rt.stateDuration) {
      this.beginExecute(enemy, rt, ctx);
    }
  }

  private beginExecute(
    enemy: EnemyEntity,
    rt: BossRuntime,
    ctx: BossAIContext
  ): void {
    const atk = rt.currentAttack;
    if (!atk) {
      this.enterRecover(rt, 0.3);
      return;
    }

    rt.state = 'execute';
    rt.stateElapsed = 0;
    rt.data.tickTimer = 0;
    rt.data.stepCount = 0;
    rt.data.secondWaveFired = false;

    const minutes = ctx.elapsedRunSec / 60;
    const dmgScale = getBossDamageScale(minutes, rt.encounterIndex);
    const dmg = Math.round(atk.damage * dmgScale);

    switch (atk.id) {
      // ---- KING MOCHI ----
      case 'mochi_leap_slam': {
        rt.stateDuration = 0.44;
        rt.airborne = true;
        rt.scaleX = 0.84;
        rt.scaleY = 1.24;
        ctx.spawnParticles(enemy.x, enemy.y + 12, PALETTE.coralLight, 10, {
          speedMin: 40,
          speedMax: 120,
        });
        break;
      }

      case 'mochi_syrup_burst': {
        const doubleWave = rt.enraged || rt.cycle >= 1;
        rt.stateDuration = doubleWave ? 0.44 : 0.16;
        this.fireRadialOrbs(
          enemy.x,
          enemy.y,
          12,
          rt.data.baseAngle,
          195 + rt.cycle * 14,
          dmg,
          8,
          3.4,
          PALETTE.coral,
          ctx
        );
        ctx.spawnRingParticle(enemy.x, enemy.y, PALETTE.coral, 92, 0.32);
        ctx.addScreenShake(3.5, 0.14);
        break;
      }

      case 'mochi_summon_adds': {
        rt.stateDuration = 0.2;
        const spots = rt.data.summonSpots;
        for (let i = 0; i < spots.length; i++) {
          const spot = spots[i];
          const outDx = spot.x - enemy.x;
          const outDy = spot.y - enemy.y;
          const outLen = Math.hypot(outDx, outDy) || 1;
          ctx.spawnMinion(
            'minislime',
            spot.x,
            spot.y,
            (outDx / outLen) * 110,
            (outDy / outLen) * 110
          );
          ctx.spawnParticles(spot.x, spot.y, PALETTE.rose, 8, {
            speedMin: 35,
            speedMax: 110,
          });
        }
        ctx.spawnRingParticle(enemy.x, enemy.y, PALETTE.rose, 100, 0.35);
        break;
      }

      // ---- LADY WISTERIA ----
      case 'wisteria_petal_spiral': {
        rt.stateDuration = 1.65;
        rt.data.tickTimer = 0;
        ctx.spawnRingParticle(enemy.x, enemy.y, PALETTE.lavender, 80, 0.32);
        break;
      }

      case 'wisteria_bloom_beam': {
        rt.stateDuration = 0.68;
        ctx.addScreenShake(5.5, 0.28);
        ctx.spawnRingParticle(enemy.x, enemy.y, PALETTE.lavenderLight, 90, 0.35);
        break;
      }

      case 'wisteria_blink_dash': {
        rt.stateDuration = 0.34;
        rt.data.dashesRemaining = Math.max(0, rt.data.dashesRemaining - 1);
        ctx.spawnParticles(enemy.x, enemy.y, PALETTE.lavender, 12, {
          speedMin: 40,
          speedMax: 140,
        });
        break;
      }

      // ---- AEGIS THE PORCELAIN WARDEN ----
      case 'aegis_lance_charge': {
        rt.stateDuration = 0.62;
        ctx.addScreenShake(4.0, 0.2);
        ctx.spawnParticles(enemy.x, enemy.y, PALETTE.babyBlue, 14, {
          speedMin: 60,
          speedMax: 170,
        });
        break;
      }

      case 'aegis_prism_cross': {
        rt.stateDuration = 2.25;
        ctx.addScreenShake(5.0, 0.25);
        ctx.spawnRingParticle(enemy.x, enemy.y, PALETTE.babyBlue, 110, 0.4);
        break;
      }

      case 'aegis_bastion_nova': {
        rt.stateDuration = 0.24;
        // Detonate concentric safe-zone shockwaves
        const pDist = Math.hypot(ctx.player.x - enemy.x, ctx.player.y - enemy.y);
        const hitInner = pDist <= rt.data.innerDangerRadius + ctx.player.radius * 0.45;
        const hitOuter =
          pDist >= rt.data.outerSafeRadius - ctx.player.radius * 0.45 &&
          pDist <= rt.data.outerDangerRadius + ctx.player.radius * 0.5;
        if (hitInner || hitOuter) {
          ctx.damagePlayer(dmg);
        }

        // Volley of disciplined warden orbs
        const orbCount = 10 + Math.min(8, rt.cycle * 2);
        const angleToPlayer = Math.atan2(ctx.player.y - enemy.y, ctx.player.x - enemy.x);
        this.fireRadialOrbs(
          enemy.x,
          enemy.y,
          orbCount,
          angleToPlayer,
          205 + rt.cycle * 14,
          Math.round(dmg * 0.78),
          8,
          3.4,
          PALETTE.babyBlue,
          ctx
        );

        ctx.spawnRingParticle(enemy.x, enemy.y, PALETTE.babyBlue, rt.data.innerDangerRadius, 0.36);
        ctx.spawnRingParticle(enemy.x, enemy.y, PALETTE.coral, rt.data.outerDangerRadius, 0.46);
        ctx.spawnParticles(enemy.x, enemy.y, PALETTE.babyBlueLight, 26, {
          speedMin: 90,
          speedMax: 260,
          sizeMin: 4,
          sizeMax: 7,
        });
        ctx.addScreenShake(7.5, 0.32);
        break;
      }
    }
  }

  private updateExecute(
    enemy: EnemyEntity,
    rt: BossRuntime,
    dt: number,
    ctx: BossAIContext
  ): void {
    const atk = rt.currentAttack;
    if (!atk) {
      this.enterRecover(rt, 0.3);
      return;
    }

    rt.stateElapsed += dt;
    const progress = Math.min(1, rt.stateElapsed / Math.max(0.01, rt.stateDuration));
    const minutes = ctx.elapsedRunSec / 60;
    const dmgScale = getBossDamageScale(minutes, rt.encounterIndex);
    const dmg = Math.round(atk.damage * dmgScale);

    switch (atk.id) {
      // ---- KING MOCHI ----
      case 'mochi_leap_slam': {
        enemy.vx = 0;
        enemy.vy = 0;
        // Parabolic interpolation from start to locked landing zone
        const eased = progress < 0.5
          ? 2 * progress * progress
          : 1 - Math.pow(-2 * progress + 2, 2) / 2;
        enemy.x = rt.data.startX + (rt.data.targetX - rt.data.startX) * eased;
        enemy.y = rt.data.startY + (rt.data.targetY - rt.data.startY) * eased;
        rt.jumpHeight = Math.sin(progress * Math.PI) * 118;
        rt.airborne = progress < 0.94;

        if (progress >= 1) {
          enemy.x = rt.data.targetX;
          enemy.y = rt.data.targetY;
          rt.jumpHeight = 0;
          rt.airborne = false;
          rt.scaleX = 1.32;
          rt.scaleY = 0.72;

          // AoE landing slam check
          const pDist = Math.hypot(ctx.player.x - enemy.x, ctx.player.y - enemy.y);
          if (pDist <= rt.data.radius + ctx.player.radius * 0.65) {
            ctx.damagePlayer(dmg);
          }

          ctx.spawnRingParticle(enemy.x, enemy.y, PALETTE.coral, rt.data.radius + 18, 0.42);
          ctx.spawnParticles(enemy.x, enemy.y, PALETTE.coral, 24, {
            speedMin: 70,
            speedMax: 220,
            sizeMin: 4,
            sizeMax: 7,
          });
          ctx.addScreenShake(7.0, 0.28);

          // Enraged or higher-cycle bonus bounce droplets on slam
          if (rt.enraged || rt.cycle >= 1) {
            this.fireRadialOrbs(
              enemy.x,
              enemy.y,
              6,
              Math.random() * Math.PI,
              155 + rt.cycle * 12,
              Math.round(dmg * 0.65),
              7,
              2.8,
              PALETTE.rose,
              ctx
            );
          }

          this.enterRecover(rt, 0.46);
        }
        break;
      }

      case 'mochi_syrup_burst': {
        enemy.vx = 0;
        enemy.vy = 0;
        const doubleWave = rt.enraged || rt.cycle >= 1;
        if (doubleWave && !rt.data.secondWaveFired && rt.stateElapsed >= 0.3) {
          rt.data.secondWaveFired = true;
          this.fireRadialOrbs(
            enemy.x,
            enemy.y,
            12,
            rt.data.baseAngle + Math.PI / 12,
            180 + rt.cycle * 14,
            dmg,
            8,
            3.4,
            PALETTE.rose,
            ctx
          );
          ctx.spawnRingParticle(enemy.x, enemy.y, PALETTE.rose, 84, 0.28);
        }
        if (progress >= 1) {
          this.enterRecover(rt, 0.36);
        }
        break;
      }

      case 'mochi_summon_adds': {
        enemy.vx = 0;
        enemy.vy = 0;
        if (progress >= 1) {
          this.enterRecover(rt, 0.32);
        }
        break;
      }

      // ---- LADY WISTERIA ----
      case 'wisteria_petal_spiral': {
        // Gentle drift while channeling petal spiral
        const dx = ctx.player.x - enemy.x;
        const dy = ctx.player.y - enemy.y;
        const dist = Math.hypot(dx, dy) || 1;
        enemy.vx = (dx / dist) * enemy.speed * 0.32;
        enemy.vy = (dy / dist) * enemy.speed * 0.32;
        enemy.walkTime += dt;

        rt.data.tickTimer -= dt;
        const interval = Math.max(0.095, 0.145 - rt.cycle * 0.012);
        if (rt.data.tickTimer <= 0) {
          rt.data.tickTimer = interval;
          const arms = 3 + Math.min(2, rt.cycle) + (rt.enraged ? 1 : 0);
          const angle = rt.data.baseAngle + rt.data.stepCount * 0.34 * rt.data.rotDir;
          rt.data.stepCount++;
          const spd = 172 + rt.cycle * 14;
          const color = rt.data.stepCount % 2 === 0 ? PALETTE.lavender : PALETTE.rose;
          this.fireRadialOrbs(enemy.x, enemy.y, arms, angle, spd, dmg, 7, 3.3, color, ctx);
        }

        if (progress >= 1) {
          this.enterRecover(rt, 0.42);
        }
        break;
      }

      case 'wisteria_bloom_beam': {
        enemy.vx = 0;
        enemy.vy = 0;
        this.checkBeamHitsPlayer(
          enemy.x,
          enemy.y,
          rt.data.beamAngles,
          rt.data.beamLength,
          rt.data.beamHalfWidth,
          dmg,
          ctx
        );

        rt.data.tickTimer -= dt;
        if (rt.data.tickTimer <= 0) {
          rt.data.tickTimer = 0.08;
          const a = rt.data.beamAngles[Math.floor(Math.random() * rt.data.beamAngles.length)] ?? 0;
          const d = 50 + Math.random() * (rt.data.beamLength * 0.7);
          ctx.spawnParticles(
            enemy.x + Math.cos(a) * d,
            enemy.y + Math.sin(a) * d,
            PALETTE.lavenderLight,
            3,
            { speedMin: 25, speedMax: 80, sizeMin: 3, sizeMax: 5 }
          );
        }

        if (progress >= 1) {
          this.enterRecover(rt, 0.45);
        }
        break;
      }

      case 'wisteria_blink_dash': {
        enemy.vx = 0;
        enemy.vy = 0;
        const eased = 1 - Math.pow(1 - progress, 2);
        enemy.x = rt.data.startX + (rt.data.targetX - rt.data.startX) * eased;
        enemy.y = rt.data.startY + (rt.data.targetY - rt.data.startY) * eased;
        enemy.facingLeft = rt.data.targetX < rt.data.startX;

        // Dash body hit check
        const hitDist = enemy.radius + ctx.player.radius + 4;
        const pdx = ctx.player.x - enemy.x;
        const pdy = ctx.player.y - enemy.y;
        if (pdx * pdx + pdy * pdy <= hitDist * hitDist) {
          ctx.damagePlayer(dmg);
        }

        // Leave trailing dusk orbs & petal afterimages
        rt.data.tickTimer -= dt;
        if (rt.data.tickTimer <= 0) {
          rt.data.tickTimer = 0.075;
          const perp = rt.data.baseAngle + (rt.data.stepCount % 2 === 0 ? Math.PI / 2 : -Math.PI / 2);
          rt.data.stepCount++;
          ctx.spawnEnemyProjectile({
            x: enemy.x,
            y: enemy.y,
            vx: Math.cos(perp) * 52,
            vy: Math.sin(perp) * 52,
            radius: 7,
            damage: Math.round(dmg * 0.75),
            maxLife: 2.3,
            color: PALETTE.lavender,
          });
          ctx.spawnParticles(enemy.x, enemy.y, PALETTE.lavenderLight, 4, {
            speedMin: 20,
            speedMax: 75,
            sizeMin: 3,
            sizeMax: 5,
          });
        }

        if (progress >= 1) {
          enemy.x = rt.data.targetX;
          enemy.y = rt.data.targetY;

          if (rt.data.dashesRemaining > 0) {
            // Chain a swift follow-up waltz dash with a fresh telegraph lane
            const nextAngle = Math.atan2(ctx.player.y - enemy.y, ctx.player.x - enemy.x);
            this.lockDashLane(enemy, rt.data, nextAngle, 320, 26);
            rt.state = 'telegraph';
            rt.stateElapsed = 0;
            rt.stateDuration = 0.45 * getBossTelegraphScale(rt.encounterIndex);
            ctx.onTelegraph?.({
              enemyId: enemy.id,
              bossId: rt.bossId,
              attackId: 'wisteria_blink_dash',
              attackName: rt.currentAttack?.name ?? 'Wisteria Waltz',
              x: enemy.x,
              y: enemy.y,
              targetX: rt.data.targetX,
              targetY: rt.data.targetY,
              telegraphSec: rt.stateDuration,
              color: rt.def.accentColor,
            });
          } else {
            this.enterRecover(rt, 0.38);
          }
        }
        break;
      }

      // ---- AEGIS THE PORCELAIN WARDEN ----
      case 'aegis_lance_charge': {
        enemy.vx = 0;
        enemy.vy = 0;
        // Fast accelerating lance rush
        const eased = progress < 0.7
          ? Math.pow(progress / 0.7, 1.45) * 0.88
          : 0.88 + ((progress - 0.7) / 0.3) * 0.12;
        enemy.x = rt.data.startX + (rt.data.targetX - rt.data.startX) * eased;
        enemy.y = rt.data.startY + (rt.data.targetY - rt.data.startY) * eased;
        enemy.facingLeft = rt.data.targetX < rt.data.startX;

        const hitDist = enemy.radius + ctx.player.radius + 6;
        const pdx = ctx.player.x - enemy.x;
        const pdy = ctx.player.y - enemy.y;
        if (pdx * pdx + pdy * pdy <= hitDist * hitDist) {
          ctx.damagePlayer(dmg);
        }

        rt.data.tickTimer -= dt;
        if (rt.data.tickTimer <= 0) {
          rt.data.tickTimer = 0.055;
          ctx.spawnParticles(enemy.x, enemy.y, PALETTE.babyBlueLight, 4, {
            speedMin: 35,
            speedMax: 120,
            sizeMin: 3,
            sizeMax: 6,
          });
        }

        if (progress >= 1) {
          enemy.x = rt.data.targetX;
          enemy.y = rt.data.targetY;
          ctx.spawnRingParticle(enemy.x, enemy.y, PALETTE.babyBlue, 88, 0.32);
          ctx.addScreenShake(4.5, 0.18);

          if (rt.enraged || rt.cycle >= 1) {
            this.fireRadialOrbs(
              enemy.x,
              enemy.y,
              6,
              rt.data.baseAngle,
              190 + rt.cycle * 14,
              Math.round(dmg * 0.65),
              7,
              2.6,
              PALETTE.babyBlue,
              ctx
            );
          }

          this.enterRecover(rt, 0.5);
        }
        break;
      }

      case 'aegis_prism_cross': {
        enemy.vx = 0;
        enemy.vy = 0;

        // Rotate all 4 porcelain prism cross-beams smoothly
        const deltaAngle = rt.data.rotSpeed * rt.data.rotDir * dt;
        for (let i = 0; i < rt.data.beamAngles.length; i++) {
          rt.data.beamAngles[i] += deltaAngle;
        }

        this.checkBeamHitsPlayer(
          enemy.x,
          enemy.y,
          rt.data.beamAngles,
          rt.data.beamLength,
          rt.data.beamHalfWidth,
          dmg,
          ctx
        );

        rt.data.tickTimer -= dt;
        if (rt.data.tickTimer <= 0) {
          rt.data.tickTimer = 0.1;
          const a = rt.data.beamAngles[Math.floor(Math.random() * rt.data.beamAngles.length)] ?? 0;
          const d = 60 + Math.random() * (rt.data.beamLength * 0.75);
          ctx.spawnParticles(
            enemy.x + Math.cos(a) * d,
            enemy.y + Math.sin(a) * d,
            PALETTE.babyBlueLight,
            3,
            { speedMin: 25, speedMax: 75, sizeMin: 3, sizeMax: 5 }
          );
        }

        if (progress >= 1) {
          this.enterRecover(rt, 0.52);
        }
        break;
      }

      case 'aegis_bastion_nova': {
        enemy.vx = 0;
        enemy.vy = 0;
        if (progress >= 1) {
          this.enterRecover(rt, 0.5);
        }
        break;
      }
    }
  }

  private enterRecover(rt: BossRuntime, baseRecoverSec: number): void {
    const cdScale = getBossCooldownScale(rt.encounterIndex, rt.enraged);
    if (rt.currentAttack) {
      rt.attackCooldowns[rt.currentAttack.id] = rt.currentAttack.cooldownSec * cdScale;
    }
    rt.state = 'recover';
    rt.stateElapsed = 0;
    rt.stateDuration = baseRecoverSec * cdScale;
    rt.globalCooldown = 1.05 * cdScale;
    rt.airborne = false;
    rt.jumpHeight = 0;
  }

  private updateRecover(enemy: EnemyEntity, rt: BossRuntime, dt: number): void {
    rt.stateElapsed += dt;
    enemy.vx = 0;
    enemy.vy = 0;
    if (rt.stateElapsed >= rt.stateDuration) {
      rt.state = 'chase';
      rt.currentAttack = null;
      rt.stateElapsed = 0;
      rt.stateDuration = 0;
    }
  }

  // ==========================================================================
  // COMBAT HELPERS
  // ==========================================================================

  private fireRadialOrbs(
    x: number,
    y: number,
    count: number,
    startAngle: number,
    speed: number,
    damage: number,
    radius: number,
    maxLife: number,
    color: string,
    ctx: BossAIContext
  ): void {
    for (let i = 0; i < count; i++) {
      const a = startAngle + (Math.PI * 2 * i) / count;
      ctx.spawnEnemyProjectile({
        x,
        y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        radius,
        damage,
        maxLife,
        color,
      });
    }
  }

  private checkBeamHitsPlayer(
    originX: number,
    originY: number,
    angles: readonly number[],
    length: number,
    halfWidth: number,
    damage: number,
    ctx: BossAIContext
  ): void {
    const hitR = halfWidth + ctx.player.radius * 0.72;
    const hitRSq = hitR * hitR;
    for (let i = 0; i < angles.length; i++) {
      const a = angles[i];
      const ex = originX + Math.cos(a) * length;
      const ey = originY + Math.sin(a) * length;
      const dSq = distPointToSegmentSq(
        ctx.player.x,
        ctx.player.y,
        originX,
        originY,
        ex,
        ey
      );
      if (dSq <= hitRSq) {
        ctx.damagePlayer(damage);
        return;
      }
    }
  }


  /**
   * Exposes read-only boss runtime state for client Canvas telegraph/beam rendering.
   */
  public getRuntime(enemyId: number): Readonly<BossRuntime> | undefined {
    return this.runtimes.get(enemyId);
  }
}
