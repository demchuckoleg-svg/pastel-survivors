export type HeroId = 'mage' | 'ranger' | 'knight' | 'alchemist';
export type EnemySpriteId = 'slime' | 'golem' | 'wisp' | 'minislime';
export type BossId =
  | 'king_mochi'
  | 'lady_wisteria'
  | 'aegis'
  | 'twin_macaron_mint'
  | 'twin_macaron_rose'
  | 'countess_tiramisu';
export type PickupSpriteId = 'xp_small' | 'xp_medium' | 'xp_large' | 'heart' | 'magnet' | 'chest';
export type ProjectileSpriteId =
  | 'fireball'
  | 'ice'
  | 'lightning'
  | 'arcane'
  | 'shadow'
  | 'bullet'
  | 'arrow'
  | 'axe'
  | 'hammer'
  | 'spear'
  | 'vial'
  | 'enemy_orb';
export type GroundSpriteId =
  | 'tile'
  | 'flower_pink'
  | 'flower_blue'
  | 'flower_yellow'
  | 'clover'
  | 'pebble'
  | 'tuft';

export type AbilityIconId =
  // Mage (10)
  | 'fireball'
  | 'wind_blade'
  | 'ice_shard'
  | 'frost_nova'
  | 'chain_lightning'
  | 'plasma_beam'
  | 'arcane_orb'
  | 'shadow_bolt'
  | 'earth_spike'
  | 'meteor_rain'
  // Ranger (10)
  | 'twin_pistols'
  | 'homing_arrow'
  | 'magic_longbow'
  | 'piercing_rail_bow'
  | 'shotgun_blast'
  | 'explosive_crossbow'
  | 'ricochet_revolver'
  | 'frost_quiver'
  | 'gatling_turret'
  | 'rain_of_arrows'
  // Knight (10)
  | 'greatsword_cleave'
  | 'orbiting_blades'
  | 'shield_bash'
  | 'shockwave_stomp'
  | 'spinning_axe'
  | 'chain_flail'
  | 'ground_slam'
  | 'holy_hammer'
  | 'spear_thrust'
  | 'blade_dash'
  // Alchemist (10)
  | 'healing_mist'
  | 'acid_flask'
  | 'haste_aura'
  | 'protective_ward'
  | 'venom_nova'
  | 'frost_tonic'
  | 'bouncing_vial'
  | 'revive_totem'
  | 'gravity_potion'
  | 'starlight_elixir';

export type SynergyIconId =
  // Mage (5)
  | 'firestorm'
  | 'absolute_zero'
  | 'tempest_lance'
  | 'eclipse_singularity'
  | 'cataclysm'
  // Ranger (5)
  | 'smart_bullets'
  | 'starlight_railgun'
  | 'cluster_cannon'
  | 'glacial_ricochet'
  | 'artillery_barrage'
  // Knight (5)
  | 'whirlwind_tempest'
  | 'bastion_quake'
  | 'reapers_pendulum'
  | 'divine_judgment'
  | 'valkyrie_blitz'
  // Alchemist (5)
  | 'sanctuary_choir'
  | 'caustic_singularity'
  | 'aegis_lantern'
  | 'plague_glacier'
  | 'celestial_panacea';

export type ArtifactIconId =
  // Mage (3)
  | 'prismatic_focus'
  | 'aether_chronometer'
  | 'mana_conduit'
  // Ranger (3)
  | 'quicksilver_quiver'
  | 'split_fletching_charm'
  | 'hawkeye_monocle'
  // Knight (3)
  | 'valkyrie_crest'
  | 'titans_gauntlet'
  | 'retribution_aegis'
  // Alchemist (3)
  | 'philosophers_censer'
  | 'aether_alembic'
  | 'chrono_distillate'
  // Fallback (1)
  | 'ascended_relic';

export type IconId = AbilityIconId | SynergyIconId | ArtifactIconId;

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
  | 'chain'
  | 'zone'
  | 'totem';

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
  | 'full_heal_on_pickup'
  | 'aura_radius_boost'
  | 'overheal_to_shield'
  | 'shared_cooldown_aura';

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
