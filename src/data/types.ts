import type {
  AbilityIconId,
  ArtifactIconId,
  BossId,
  EnemySpriteId,
  HeroId,
  ProjectileSpriteId,
  SynergyIconId,
} from '../art/sprites';

export type {
  AbilityIconId,
  ArtifactIconId,
  BossId,
  EnemySpriteId,
  HeroId,
  ProjectileSpriteId,
  SynergyIconId,
};

export type ClassId = HeroId;
export type AbilityId = AbilityIconId;
export type SynergyId = SynergyIconId;
export type ArtifactId = ArtifactIconId;

/**
 * Permanent global stat modifier keys accumulated from Lv 5 / Lv 10 ability passives,
 * Synergy bonus passives, and Boss Artifacts.
 */
export type GlobalStatKey =
  | 'damageMult'
  | 'cooldownReduction'
  | 'areaMult'
  | 'moveSpeedMult'
  | 'pickupRadiusMult'
  | 'critChance'
  | 'critMultiplier'
  | 'xpGainMult'
  | 'maxHpFlat'
  | 'hpRegen'
  | 'armor'
  | 'knockbackMult'
  | 'projectileBonus'
  | 'pierceBonus';

export interface GlobalPassive {
  id: string;
  label: string;
  modifiers: Partial<Record<GlobalStatKey, number>>;
}

export interface ClassBaseStats {
  maxHp: number;
  moveSpeed: number;
  pickupRadius: number;
  /** Damage reduction fraction (e.g., 0.15 = 15% Armor). */
  armor: number;
  /** Base critical strike chance fraction (e.g., 0.05 = 5%). */
  critChance: number;
  /** Base critical strike damage multiplier (e.g., 1.5 = 150%). */
  critMultiplier: number;
  /** Base HP regenerated per second. */
  hpRegen: number;
}

export interface ClassDef {
  id: ClassId;
  name: string;
  title: string;
  description: string;
  accentColor: string;
  baseStats: ClassBaseStats;
  startingAbilityId: AbilityId;
}

export type AbilityBehaviorType =
  | 'projectile'
  | 'homing'
  | 'boomerang'
  | 'ricochet'
  | 'beam'
  | 'nova'
  | 'orbit'
  | 'strike'
  | 'melee_arc'
  | 'dash'
  | 'turret'
  | 'rain'
  | 'chain';

export interface AbilityStats {
  damage: number;
  /** Seconds between casts. */
  cooldown: number;
  /** Projectiles, strikes, blades, or turrets spawned per cast. */
  count: number;
  /** Effect / hitbox radius in pixels. */
  area: number;
  /** Additional targets pierced (0 = stops on first hit; 999 = infinite). */
  pierce: number;
  /** Active lifetime in seconds. */
  duration: number;
  /** Movement speed in pixels/second (0 for stationary/instant effects). */
  speed: number;
  /** Optional knockback impulse in pixels/second. */
  knockback?: number;
}

export interface AbilityLevelStep {
  level: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
  description: string;
  deltas: Partial<AbilityStats>;
}

export interface AbilityDef {
  id: AbilityId;
  classId: ClassId;
  name: string;
  iconId: AbilityIconId;
  projectileSprite?: ProjectileSpriteId;
  color: string;
  behavior: AbilityBehaviorType;
  description: string;
  baseStats: AbilityStats;
  /** Upgrade steps for levels 2 through 10 (9 entries). */
  levels: readonly AbilityLevelStep[];
  /** Permanent global passive unlocked upon reaching Lv 5 (preserved even after Synergy evolution). */
  lv5Passive: GlobalPassive;
  /** Permanent global passive unlocked upon reaching Lv 10 (preserved even after Synergy evolution). */
  lv10Passive: GlobalPassive;
}

export interface SynergyBehaviorSpec {
  behavior: AbilityBehaviorType;
  summary: string;
  specialMechanics: readonly string[];
  stats: AbilityStats;
}

export interface SynergyDef {
  id: SynergyId;
  classId: ClassId;
  name: string;
  iconId: SynergyIconId;
  projectileSprite?: ProjectileSpriteId;
  color: string;
  /** Exact pair of Lv 10 component abilities consumed to evolve into this Synergy. */
  requires: readonly [AbilityId, AbilityId];
  description: string;
  evolvedSpec: SynergyBehaviorSpec;
  /** Additional permanent global passive granted on evolution. */
  bonusPassive: GlobalPassive;
}

export type ArtifactSpecialEffect =
  | 'double_cast_every_5th'
  | 'retribution_shockwave'
  | 'full_heal_on_pickup';

export interface ArtifactDef {
  id: ArtifactId;
  classId: ClassId | 'any';
  name: string;
  iconId: ArtifactIconId;
  color: string;
  description: string;
  passive: GlobalPassive;
  specialEffect?: ArtifactSpecialEffect;
  isFallback?: boolean;
}

export type EnemyBehaviorType =
  | 'chase_fast'
  | 'chase_tank'
  | 'ranged_kiter'
  | 'swarm_mini';

export interface EnemyArchetypeDef {
  id: EnemySpriteId;
  name: string;
  spriteId: EnemySpriteId;
  behavior: EnemyBehaviorType;
  baseHp: number;
  baseXp: number;
  speed: number;
  damage: number;
  radius: number;
  /** 0 = full knockback, 1 = immune to knockback. */
  knockbackResist: number;
  /** Elapsed minute when this enemy begins appearing in waves. */
  minMinute: number;
  spawnWeight: number;
  /** True for the 3 primary wave archetypes; false for boss-summoned adds like Mini-Slime. */
  isStandardWave: boolean;
  rangedRange?: number;
  rangedCooldown?: number;
  projectileSpeed?: number;
}

export interface BossAttackSpec {
  id: string;
  name: string;
  telegraphSec: number;
  cooldownSec: number;
  damage: number;
  description: string;
}

export interface BossDef {
  id: BossId;
  name: string;
  title: string;
  spriteId: BossId;
  /** First scheduled spawn time in minutes (10, 20, 30). */
  spawnMinute: number;
  baseHp: number;
  baseXp: number;
  speed: number;
  contactDamage: number;
  radius: number;
  accentColor: string;
  attacks: readonly BossAttackSpec[];
}
