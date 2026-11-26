import { PALETTE } from './palette';
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
    baseHp: 29,
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
    baseHp: 94,
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
    baseHp: 42,
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
    baseHp: 16,
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
    baseHp: 2600,
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
    baseHp: 5800,
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
    baseHp: 7200,
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

  twin_macaron_mint: {
    id: 'twin_macaron_mint',
    name: 'The Twin Macarons',
    title: 'Mint & Rose Patisserie Duo',
    spriteId: 'twin_macaron_mint',
    spawnMinute: 15,
    baseHp: 5400,
    baseXp: 230,
    speed: 74,
    contactDamage: 24,
    radius: 30,
    accentColor: PALETTE.mint,
    attacks: [
      {
        id: 'macaron_mint_slam',
        name: 'Mint Crumb Slam',
        telegraphSec: 0.85,
        cooldownSec: 4.4,
        damage: 28,
        description:
          'Telegraphs a mint impact ring around the closest hero before slamming down.',
      },
      {
        id: 'macaron_mint_dash',
        name: 'Frosting Dash',
        telegraphSec: 0.72,
        cooldownSec: 4.8,
        damage: 26,
        description: 'Charges aggressively down a telegraphed lane toward the nearest hero.',
      },
    ],
  },

  twin_macaron_rose: {
    id: 'twin_macaron_rose',
    name: 'Rose Macaron',
    title: 'Mint & Rose Patisserie Duo',
    spriteId: 'twin_macaron_rose',
    spawnMinute: 15,
    baseHp: 5400,
    baseXp: 230,
    speed: 70,
    contactDamage: 20,
    radius: 30,
    accentColor: PALETTE.rose,
    attacks: [
      {
        id: 'macaron_rose_spiral',
        name: 'Rose Petal Spiral',
        telegraphSec: 0.75,
        cooldownSec: 4.2,
        damage: 20,
        description: 'Orbits at range firing spiral volleys of pastel rose projectiles.',
      },
      {
        id: 'macaron_tether_surge',
        name: 'Glaze Laser Tether',
        telegraphSec: 1.1,
        cooldownSec: 5.8,
        damage: 30,
        description:
          'Charges and ignites a damaging pastel laser tether connecting Mint & Rose.',
      },
    ],
  },

  countess_tiramisu: {
    id: 'countess_tiramisu',
    name: 'Countess Tiramisu',
    title: 'Matriarch of Velvet Layers',
    spriteId: 'countess_tiramisu',
    spawnMinute: 25,
    baseHp: 6800,
    baseXp: 310,
    speed: 66,
    contactDamage: 28,
    radius: 34,
    accentColor: PALETTE.peach,
    attacks: [
      {
        id: 'tiramisu_arena_ring',
        name: 'Velvet Enclosure',
        telegraphSec: 1.15,
        cooldownSec: 11.5,
        damage: 16,
        description:
          'Summons a shrinking pastel arena ring; heroes outside take ticking zone damage.',
      },
      {
        id: 'tiramisu_meteor_marks',
        name: 'Cocoa Starfall',
        telegraphSec: 0.65,
        cooldownSec: 5.2,
        damage: 32,
        description:
          'Marks up to 2 random heroes (1 in solo) with delayed pastel meteor circles that lock and detonate.',
      },
      {
        id: 'tiramisu_cone_volley',
        name: 'Espresso Sweep',
        telegraphSec: 0.8,
        cooldownSec: 4.5,
        damage: 22,
        description:
          'Sweeps a wide pastel cone volley before entering a brief vulnerable recovery window.',
      },
    ],
  },
};

export const BOSS_ORDER: readonly BossId[] = [
  'king_mochi',
  'twin_macaron_mint',
  'lady_wisteria',
  'countess_tiramisu',
  'aegis',
];
export const BOSS_LIST: readonly BossDef[] = BOSS_ORDER.map((id) => BOSSES[id]);
export const BOSS_SPAWN_INTERVAL_MIN = 10;
export const COOP_BOSS_SPAWN_INTERVAL_MIN = 5;
export const COOP_PACE_TIME_SCALE = 1.5;

export function getEnemyDef(id: EnemySpriteId): EnemyArchetypeDef {
  return ENEMIES[id];
}

export function getBossDef(id: BossId): BossDef {
  return BOSSES[id];
}

/**
 * Returns the BossDef scheduled for a 0-based boss encounter index
 * (0 = King Mochi, 1 = Lady Wisteria, 2 = Aegis, cycling thereafter).
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
 * Steepens past Level 30 so 20:00 lands around Lv 45-55 and 32:00 around Lv 70-85.
 */
export function xpNeeded(level: number): number {
  const lv = Math.max(1, Math.floor(level));
  const base = 10 + lv * 8 + Math.pow(lv, 1.5) * 4;
  if (lv <= 30) {
    return Math.floor(base);
  }
  const ex = lv - 30;
  return Math.floor(base + ex * ex * 10 + Math.pow(ex, 2.55) * 1.5);
}

/**
 * Scaled solo enemy HP at elapsed time `t` (in minutes).
 * Accelerates exponentially past minutes 10, 18, and 25.
 */
export function enemyHP(baseHP: number, t: number): number {
  const minutes = Math.max(0, t);
  let mult = 1 + 0.18 * minutes + 0.03 * minutes * minutes;
  if (minutes > 10) {
    mult *= Math.pow(1.065, minutes - 10);
  }
  if (minutes > 18) {
    mult *= Math.pow(1.06, minutes - 18);
  }
  if (minutes > 25) {
    mult *= Math.pow(1.06, minutes - 25);
  }
  return baseHP * mult;
}

/**
 * Scaled solo enemy XP drop at elapsed time `t` (in minutes).
 * Exact formula: baseXP * (1 + 0.12 * t)
 */
export function enemyXP(baseXP: number, t: number): number {
  const minutes = Math.max(0, t);
  return baseXP * (1 + 0.12 * minutes);
}

/**
 * Target solo enemies spawned per second at elapsed time `t` (in minutes).
 */
export function enemySpawnRate(t: number): number {
  const minutes = Math.max(0, t);
  return Math.min(18.0, 1.3 + minutes * 0.42 + Math.pow(minutes, 1.25) * 0.12);
}

// ============================================================================
// CO-OP PLAYER-COUNT SCALING FORMULAS (P = connected player count, 1..4)
// ============================================================================

/** Standard Enemy HP multiplier for `P` players: `1 + 0.65 * (P - 1)`. */
export function coopEnemyHpMultiplier(playerCount: number): number {
  const p = Math.max(1, Math.floor(playerCount));
  return 1 + 0.65 * (p - 1);
}

/** Boss HP multiplier for `P` players: `1 + 1.25 * (P - 1)`. */
export function coopBossHpMultiplier(playerCount: number): number {
  const p = Math.max(1, Math.floor(playerCount));
  return 1 + 1.25 * (p - 1);
}

/** Spawn Rate multiplier for `P` players: `1 + 0.45 * (P - 1)`. */
export function coopSpawnRateMultiplier(playerCount: number): number {
  const p = Math.max(1, Math.floor(playerCount));
  return 1 + 0.45 * (p - 1);
}

/**
 * Generous personal XP gem scaling for `P` players (`1 + 0.25 * (P - 1)`)
 * so that alongside the `1 + 0.45 * (P - 1)` spawn rate, each player's
 * independent XP bar progresses at a steady pace comparable to solo.
 */
export function coopEnemyXpMultiplier(playerCount: number): number {
  const p = Math.max(1, Math.floor(playerCount));
  return 1 + 0.25 * (p - 1);
}

/** Standard Enemy HP scaled by elapsed minutes and player count `P`. */
export function scaledEnemyHP(baseHP: number, t: number, playerCount = 1): number {
  return enemyHP(baseHP, t) * coopEnemyHpMultiplier(playerCount);
}

/** Boss HP scaled from solo boss HP by player count `P`. */
export function scaledBossHP(soloBossHP: number, playerCount = 1): number {
  return Math.round(soloBossHP * coopBossHpMultiplier(playerCount));
}

/** Spawn rate scaled by elapsed minutes and player count `P`. */
export function scaledSpawnRate(t: number, playerCount = 1): number {
  return enemySpawnRate(t) * coopSpawnRateMultiplier(playerCount);
}

/** Enemy XP value scaled by elapsed minutes and player count `P`. */
export function scaledEnemyXP(baseXP: number, t: number, playerCount = 1): number {
  return enemyXP(baseXP, t) * coopEnemyXpMultiplier(playerCount);
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
