import { PALETTE } from './palette';
import type { ArtifactDef, ArtifactId, ClassId } from './types';

/**
 * All 9 class-specific Boss Artifacts (3 per class) plus the Ascended Relic
 * fallback awarded once all 3 class artifacts have been collected.
 */
export const ARTIFACTS: Record<ArtifactId, ArtifactDef> = {
  // ==========================================================================
  // MAGE ARTIFACTS (3)
  // ==========================================================================
  prismatic_focus: {
    id: 'prismatic_focus',
    classId: 'mage',
    name: 'Prismatic Focus',
    iconId: 'prismatic_focus',
    color: PALETTE.lavender,
    description: '+25% All Area and +15% Crit Chance.',
    passive: {
      id: 'artifact_prismatic_focus',
      label: '+25% All Area, +15% Crit Chance',
      modifiers: {
        areaMult: 0.25,
        critChance: 0.15,
      },
    },
  },

  aether_chronometer: {
    id: 'aether_chronometer',
    classId: 'mage',
    name: 'Aether Chronometer',
    iconId: 'aether_chronometer',
    color: PALETTE.babyBlue,
    description: '-18% All Cooldowns. Every 5th ability cast automatically double-casts.',
    passive: {
      id: 'artifact_aether_chronometer',
      label: '-18% All Cooldowns (Every 5th cast double-casts)',
      modifiers: {
        cooldownReduction: 0.18,
      },
    },
    specialEffect: 'double_cast_every_5th',
  },

  mana_conduit: {
    id: 'mana_conduit',
    classId: 'mage',
    name: 'Mana Conduit',
    iconId: 'mana_conduit',
    color: PALETTE.rose,
    description: '+35% XP Gain and +18% All Damage.',
    passive: {
      id: 'artifact_mana_conduit',
      label: '+35% XP Gain, +18% All Damage',
      modifiers: {
        xpGainMult: 0.35,
        damageMult: 0.18,
      },
    },
  },

  // ==========================================================================
  // RANGER ARTIFACTS (3)
  // ==========================================================================
  quicksilver_quiver: {
    id: 'quicksilver_quiver',
    classId: 'ranger',
    name: 'Quicksilver Quiver',
    iconId: 'quicksilver_quiver',
    color: PALETTE.mint,
    description: '-20% All Cooldowns and +15% Move Speed.',
    passive: {
      id: 'artifact_quicksilver_quiver',
      label: '-20% All Cooldowns, +15% Move Speed',
      modifiers: {
        cooldownReduction: 0.2,
        moveSpeedMult: 0.15,
      },
    },
  },

  split_fletching_charm: {
    id: 'split_fletching_charm',
    classId: 'ranger',
    name: 'Split-Fletching Charm',
    iconId: 'split_fletching_charm',
    color: PALETTE.butter,
    description: '+1 Projectile and +1 Pierce to all abilities.',
    passive: {
      id: 'artifact_split_fletching_charm',
      label: '+1 Projectile, +1 Pierce to All Abilities',
      modifiers: {
        projectileBonus: 1,
        pierceBonus: 1,
      },
    },
  },

  hawkeye_monocle: {
    id: 'hawkeye_monocle',
    classId: 'ranger',
    name: 'Hawkeye Monocle',
    iconId: 'hawkeye_monocle',
    color: PALETTE.periwinkle,
    description: '+25% Crit Chance and boosts Critical Multiplier to 2.0x (+0.4x).',
    passive: {
      id: 'artifact_hawkeye_monocle',
      label: '+25% Crit Chance, +0.4x Crit Multiplier (2.0x+)',
      modifiers: {
        critChance: 0.25,
        critMultiplier: 0.4,
      },
    },
  },

  // ==========================================================================
  // KNIGHT ARTIFACTS (3)
  // ==========================================================================
  valkyrie_crest: {
    id: 'valkyrie_crest',
    classId: 'knight',
    name: 'Valkyrie Crest',
    iconId: 'valkyrie_crest',
    color: PALETTE.butterLight,
    description: '+45 Max HP, +2 HP/s Regen, and +10% Armor.',
    passive: {
      id: 'artifact_valkyrie_crest',
      label: '+45 Max HP, +2 HP/s Regen, +10% Armor',
      modifiers: {
        maxHpFlat: 45,
        hpRegen: 2,
        armor: 0.1,
      },
    },
  },

  titans_gauntlet: {
    id: 'titans_gauntlet',
    classId: 'knight',
    name: "Titan's Gauntlet",
    iconId: 'titans_gauntlet',
    color: PALETTE.peach,
    description: '+30% All Damage and +40% Knockback.',
    passive: {
      id: 'artifact_titans_gauntlet',
      label: '+30% All Damage, +40% Knockback',
      modifiers: {
        damageMult: 0.3,
        knockbackMult: 0.4,
      },
    },
  },

  retribution_aegis: {
    id: 'retribution_aegis',
    classId: 'knight',
    name: 'Retribution Aegis',
    iconId: 'retribution_aegis',
    color: PALETTE.coral,
    description:
      'Taking damage unleashes a pastel shockwave and grants +25% All Damage for 4s.',
    passive: {
      id: 'artifact_retribution_aegis',
      label: 'On Hit: Pastel Shockwave & +25% Damage (4s)',
      modifiers: {},
    },
    specialEffect: 'retribution_shockwave',
  },

  // ==========================================================================
  // FALLBACK ARTIFACT (PAST 30:00 / ALL 3 CLASS ARTIFACTS OWNED)
  // ==========================================================================
  ascended_relic: {
    id: 'ascended_relic',
    classId: 'any',
    name: 'Ascended Relic',
    iconId: 'ascended_relic',
    color: PALETTE.cream,
    description: '+15% All Damage, +20 Max HP, and Full Heal.',
    passive: {
      id: 'artifact_ascended_relic',
      label: '+15% All Damage, +20 Max HP, Full Heal',
      modifiers: {
        damageMult: 0.15,
        maxHpFlat: 20,
      },
    },
    specialEffect: 'full_heal_on_pickup',
    isFallback: true,
  },
};

export const CLASS_ARTIFACTS: readonly ArtifactDef[] = Object.values(ARTIFACTS).filter(
  (a) => !a.isFallback
);

export const ASCENDED_RELIC: ArtifactDef = ARTIFACTS.ascended_relic;

export function getArtifactDef(id: ArtifactId): ArtifactDef {
  return ARTIFACTS[id];
}

export function getArtifactsForClass(classId: ClassId): ArtifactDef[] {
  return CLASS_ARTIFACTS.filter((a) => a.classId === classId);
}

/**
 * Returns unowned class-specific artifacts, or falls back to Ascended Relic
 * once the player has collected all 3 artifacts for their class.
 */
export function getAvailableBossArtifacts(
  classId: ClassId,
  ownedIds: ReadonlySet<ArtifactId>
): ArtifactDef[] {
  const unowned = getArtifactsForClass(classId).filter((a) => !ownedIds.has(a.id));
  return unowned.length > 0 ? unowned : [ASCENDED_RELIC];
}
