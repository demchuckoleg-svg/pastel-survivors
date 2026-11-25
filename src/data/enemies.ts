import { PALETTE } from '../art/palette';
import type { BossDef, BossId, EnemyArchetypeDef, EnemySpriteId } from './types';

/**
 * Enemy archetypes: 3 standard wave archetypes (Fast Slime, Slow Golem, Ranged Wisp)
 * plus Mini-Slime summoned by King Mochi.
 */
export const ENEMIES: Record<EnemySpriteId, EnemyArchetypeDef> = {
  slime: {
    id: 'slime',
    name: 'Mochi Slime',
    spriteId: 'slime',
    behavior: 'chase_fast',
    baseHp: 22,
    baseXp: 4,
    speed: 74,
    damage: 8,
    radius: 13,
    knockbackResist: 0.05,
    minMinute: 0,
    spawnWeight: 60,
    isStandardWave: true,
  },

  golem: {
    id: 'golem',
    name: 'Porcelain Golem',
    spriteId: 'golem',
    behavior: 'chase_tank',
    baseHp: 72,
    baseXp: 11,
    speed: 44,
    damage: 16,
    radius: 17,
    knockbackResist: 0.65,
    minMinute: 1.5,
    spawnWeight: 22,
    isStandardWave: true,
  },

  wisp: {
    id: 'wisp',
    name: 'Wisteria Wisp',
    spriteId: 'wisp',
    behavior: 'ranged_kiter',
    baseHp: 32,
    baseXp: 8,
    speed: 60,
    damage: 11,
    radius: 13,
    knockbackResist: 0.15,
    minMinute: 3,
    spawnWeight: 18,
    isStandardWave: true,
    rangedRange: 230,
    rangedCooldown: 2.6,
    projectileSpeed: 185,
  },

  minislime: {
    id: 'minislime',
    name: 'Mini Mochi',
    spriteId: 'minislime',
    behavior: 'swarm_mini',
    baseHp: 12,
    baseXp: 2,
    speed: 92,
    damage: 6,
    radius: 10,
    knockbackResist: 0,
    minMinute: 999,
    spawnWeight: 0,
    isStandardWave: false,
  },
};

/** The 3 primary wave enemy archetypes. */
export const STANDARD_ENEMY_ARCHETYPES: readonly EnemyArchetypeDef[] = [
  ENEMIES.slime,
  ENEMIES.golem,
  ENEMIES.wisp,
];

/**
 * All 3 Bosses spawning at 10:00, 20:00, and 30:00 (cycling every 10 minutes thereafter).
 */
export const BOSSES: Record<BossId, BossDef> = {
  king_mochi: {
    id: 'king_mochi',
    name: 'King Mochi',
    title: 'Sovereign of Softness',
    spriteId: 'king_mochi',
    spawnMinute: 10,
    baseHp: 1400,
    baseXp: 180,
    speed: 62,
    contactDamage: 22,
    radius: 34,
    accentColor: PALETTE.coral,
    attacks: [
      {
        id: 'mochi_leap_slam',
        name: 'Royal Leap Slam',
        telegraphSec: 0.9,
        cooldownSec: 4.5,
        damage: 28,
        description:
          'Telegraphs a pastel landing ring around the hero before slamming down with a shockwave.',
      },
      {
        id: 'mochi_syrup_burst',
        name: 'Syrup Nova',
        telegraphSec: 0.7,
        cooldownSec: 5.5,
        damage: 18,
        description: 'Releases an expanding ring of 12 pastel orbs in all directions.',
      },
      {
        id: 'mochi_summon_adds',
        name: 'Mochi Split',
        telegraphSec: 0.6,
        cooldownSec: 8.0,
        damage: 0,
        description: 'Spawns a squad of bouncy Mini Mochi slimes to swarm the arena.',
      },
    ],
  },

  lady_wisteria: {
    id: 'lady_wisteria',
    name: 'Lady Wisteria',
    title: 'Empress of Dusk Petals',
    spriteId: 'lady_wisteria',
    spawnMinute: 20,
    baseHp: 2200,
    baseXp: 260,
    speed: 78,
    contactDamage: 26,
    radius: 32,
    accentColor: PALETTE.lavender,
    attacks: [
      {
        id: 'wisteria_petal_spiral',
        name: 'Petal Spiral',
        telegraphSec: 0.75,
        cooldownSec: 4.0,
        damage: 22,
        description: 'Fires rotating lavender petal spirals that weave across the battlefield.',
      },
      {
        id: 'wisteria_bloom_beam',
        name: 'Dusk Ray',
        telegraphSec: 1.0,
        cooldownSec: 6.0,
        damage: 34,
        description:
          'Telegraphs dual crossing pastel beam lines before igniting them.',
      },
      {
        id: 'wisteria_blink_dash',
        name: 'Wisteria Waltz',
        telegraphSec: 0.65,
        cooldownSec: 5.0,
        damage: 26,
        description: 'Dashes rapidly along a telegraphed lane leaving trailing orbs.',
      },
    ],
  },

  aegis: {
    id: 'aegis',
    name: 'Aegis',
    title: 'The Porcelain Warden',
    spriteId: 'aegis',
    spawnMinute: 30,
    baseHp: 3200,
    baseXp: 360,
    speed: 68,
    contactDamage: 32,
    radius: 36,
    accentColor: PALETTE.babyBlue,
    attacks: [
      {
        id: 'aegis_lance_charge',
        name: 'Warden Charge',
        telegraphSec: 0.85,
        cooldownSec: 4.2,
        damage: 36,
        description: 'Locks onto the hero with a wide warning lane and charges at high speed.',
      },
      {
        id: 'aegis_prism_cross',
        name: 'Porcelain Prism',
        telegraphSec: 1.05,
        cooldownSec: 6.2,
        damage: 38,
        description: 'Projects 4 rotating cross-beams after a clear telegraph countdown.',
      },
      {
        id: 'aegis_bastion_nova',
        name: 'Aegis Judgment',
        telegraphSec: 0.95,
        cooldownSec: 7.0,
        damage: 32,
        description:
          'Triggers concentric safe-zone shockwave rings and a volley of warden orbs.',
      },
    ],
  },
};

export const BOSS_ORDER: readonly BossId[] = ['king_mochi', 'lady_wisteria', 'aegis'];
export const BOSS_LIST: readonly BossDef[] = BOSS_ORDER.map((id) => BOSSES[id]);
export const BOSS_SPAWN_INTERVAL_MIN = 10;

export function getEnemyDef(id: EnemySpriteId): EnemyArchetypeDef {
  return ENEMIES[id];
}

export function getBossDef(id: BossId): BossDef {
  return BOSSES[id];
}

/**
 * Returns the BossDef scheduled for a 0-based boss encounter index
 * (0 = 10:00 King Mochi, 1 = 20:00 Lady Wisteria, 2 = 30:00 Aegis, cycling thereafter).
 */
export function getBossForEncounter(encounterIndex: number): BossDef {
  const idx = Math.max(0, Math.floor(encounterIndex)) % BOSS_ORDER.length;
  return BOSSES[BOSS_ORDER[idx]];
}

// ============================================================================
// SCALING FORMULAS
// ============================================================================

/**
 * XP required to advance from `level` to `level + 1`.
 * Exact formula: Math.floor(10 + level * 8 + Math.pow(level, 1.5) * 4)
 */
export function xpNeeded(level: number): number {
  const lv = Math.max(1, Math.floor(level));
  return Math.floor(10 + lv * 8 + Math.pow(lv, 1.5) * 4);
}

/**
 * Scaled enemy HP at elapsed time `t` (in minutes).
 * Exact formula: baseHP * (1 + 0.18 * t + 0.03 * t * t)
 */
export function enemyHP(baseHP: number, t: number): number {
  const minutes = Math.max(0, t);
  return baseHP * (1 + 0.18 * minutes + 0.03 * minutes * minutes);
}

/**
 * Scaled enemy XP drop at elapsed time `t` (in minutes).
 * Exact formula: baseXP * (1 + 0.12 * t)
 */
export function enemyXP(baseXP: number, t: number): number {
  const minutes = Math.max(0, t);
  return baseXP * (1 + 0.12 * minutes);
}

/**
 * Target enemies spawned per second at elapsed time `t` (in minutes).
 */
export function enemySpawnRate(t: number): number {
  const minutes = Math.max(0, t);
  return Math.min(9.5, 1.2 + minutes * 0.28 + Math.pow(minutes, 1.15) * 0.05);
}

/**
 * Picks a weighted standard wave archetype unlocked at elapsed time `t` (in minutes).
 */
export function pickWaveArchetype(t: number, rand = Math.random()): EnemyArchetypeDef {
  const minutes = Math.max(0, t);
  const unlocked = STANDARD_ENEMY_ARCHETYPES.filter((e) => minutes >= e.minMinute);
  const totalWeight = unlocked.reduce((sum, e) => sum + e.spawnWeight, 0);
  let roll = rand * totalWeight;
  for (const enemy of unlocked) {
    roll -= enemy.spawnWeight;
    if (roll <= 0) return enemy;
  }
  return unlocked[0] ?? ENEMIES.slime;
}
