import type {
  AbilityId,
  ArtifactDef,
  ArtifactId,
  BossAttackSpec,
  BossDef,
  BossId,
  ClassId,
  EnemySpriteId,
  GlobalStatKey,
  HeroId,
  PickupSpriteId,
  ProjectileSpriteId,
  SynergyId,
} from '../data/types';
import type { SpatialEntity } from './spatialHash';

export type AimMode = 'auto' | 'mouse';

export type GameState =
  | 'menu'
  | 'playing'
  | 'paused'
  | 'levelup'
  | 'artifact'
  | 'gameover';

export type PlayerId = string;

export interface PlayerInput {
  moveX: number;
  moveY: number;
  aimMode: AimMode;
  /** Optional world-space aim target when aimMode === 'mouse'. */
  aimTargetX?: number;
  aimTargetY?: number;
  hasAimTarget?: boolean;
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

export interface PlayerState {
  id: PlayerId;
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
  aimMode: AimMode;
  walkTime: number;
  isMoving: boolean;
  invulnTimer: number;
  hitFlashTimer: number;
  retributionBuffTimer: number;
  alive: boolean;

  // Per-player progression state (ready for 4-player co-op)
  activeSlots: ActiveAbilitySlot[];
  consumedAbilities: Set<AbilityId>;
  ownedSynergies: Set<SynergyId>;
  ownedArtifacts: ArtifactId[];
  globalPassives: GlobalPassiveEntry[];
  computedStats: ComputedPlayerStats;
  masteryCount: number;
  pendingLevelUps: number;
  pendingChoices: LevelUpChoice[];
  pendingArtifactChoices: ArtifactDef[];
}

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
  aiState?: 'normal' | 'windup' | 'lunge';
  aiTimer?: number;
  aiCooldown?: number;
  lungeDirX?: number;
  lungeDirY?: number;
  bossEncounterIndex?: number;
  alive: boolean;
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
  magnetTargetId?: PlayerId;
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

export interface DamageOptions {
  playerId?: PlayerId;
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

export interface NewBestFlags {
  time: boolean;
  level: boolean;
  kills: boolean;
  bosses: boolean;
  any: boolean;
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

// ============================================================================
// BOSS RUNTIME TYPES (SHARED BETWEEN SIM & CLIENT RENDERER)
// ============================================================================

export type BossPhaseState = 'chase' | 'telegraph' | 'execute' | 'recover';

export interface BossActiveInfo {
  enemyId: number;
  bossId: BossId;
  name: string;
  title: string;
  hp: number;
  maxHp: number;
  accentColor: string;
  cycle: number;
  encounterIndex: number;
  enraged: boolean;
  state: BossPhaseState;
  currentAttackName: string | null;
}

export interface BossVisualState {
  jumpHeight: number;
  scaleX: number;
  scaleY: number;
  airborne: boolean;
  telegraphRatio: number;
  enraged: boolean;
  accentColor: string;
}

export interface BossProjectileParams {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  damage: number;
  maxLife: number;
  color: string;
}

export interface BossSummonSpot {
  x: number;
  y: number;
}

export interface BossAttackData {
  startX: number;
  startY: number;
  targetX: number;
  targetY: number;
  radius: number;
  halfWidth: number;
  laneLength: number;
  baseAngle: number;
  beamAngles: number[];
  beamLength: number;
  beamHalfWidth: number;
  rotSpeed: number;
  rotDir: number;
  innerDangerRadius: number;
  outerSafeRadius: number;
  outerDangerRadius: number;
  tickTimer: number;
  stepCount: number;
  secondWaveFired: boolean;
  dashesRemaining: number;
  summonSpots: BossSummonSpot[];
}

export interface BossRuntime {
  enemyId: number;
  bossId: BossId;
  def: BossDef;
  encounterIndex: number;
  cycle: number;
  enraged: boolean;
  state: BossPhaseState;
  currentAttack: BossAttackSpec | null;
  stateElapsed: number;
  stateDuration: number;
  globalCooldown: number;
  attackCooldowns: Record<string, number>;
  lastAttackId: string | null;
  jumpHeight: number;
  scaleX: number;
  scaleY: number;
  airborne: boolean;
  orbitDir: number;
  data: BossAttackData;
}

// ============================================================================
// ABILITY RUNTIME EFFECT TYPES (SHARED BETWEEN SIM & CLIENT RENDERER)
// ============================================================================

export interface ActiveProjectile {
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

export interface ActiveBeam {
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

export interface ActiveNova {
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

export interface ActiveOrbitGroup {
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

export interface ActiveMeleeArc {
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

export interface ActiveStrikeOrRain {
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

export interface ActiveChainArc {
  points: Array<{ x: number; y: number }>;
  color: string;
  age: number;
  maxLife: number;
  lineWidth: number;
}

export interface ActiveTurret {
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

export interface ActiveGroundTrail {
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

export interface AbilityRenderState {
  readonly projectiles: readonly ActiveProjectile[];
  readonly beams: readonly ActiveBeam[];
  readonly novas: readonly ActiveNova[];
  readonly orbiters: readonly ActiveOrbitGroup[];
  readonly meleeArcs: readonly ActiveMeleeArc[];
  readonly strikes: readonly ActiveStrikeOrRain[];
  readonly chains: readonly ActiveChainArc[];
  readonly turrets: readonly ActiveTurret[];
  readonly trails: readonly ActiveGroundTrail[];
}
