import { ABILITIES, getAbilitiesForClass } from '../data/abilities';
import { ASCENDED_RELIC, getAvailableBossArtifacts } from '../data/artifacts';
import { CLASSES, MAX_ABILITY_LEVEL, MAX_ACTIVE_ABILITY_SLOTS } from '../data/classes';
import { PALETTE } from '../data/palette';
import { getSynergiesForClass } from '../data/synergies';
import type {
  AbilityLevelStep,
  ArtifactDef,
  GlobalStatKey,
  SynergyDef,
} from '../data/types';
import type { RngSource } from './rng';
import type {
  ChoiceTier,
  ComputedPlayerStats,
  LevelUpChoice,
  PendingChoiceBatch,
  PlayerState,
} from './types';

/**
 * Pure stat aggregation from hero base stats, Global Passive Ledger,
 * owned artifacts, and active temporary buffs (e.g., Retribution Aegis).
 */
export function buildComputedStats(player: Pick<
  PlayerState,
  'heroId' | 'globalPassives' | 'ownedArtifacts' | 'retributionBuffTimer'
>): ComputedPlayerStats {
  const base = CLASSES[player.heroId].baseStats;
  let maxHpFlat = 0;
  let moveSpeedMult = 0;
  let pickupRadiusMult = 0;
  let armorBonus = 0;
  let critChanceBonus = 0;
  let critMultBonus = 0;
  let hpRegenBonus = 0;
  let damageMultBonus = 0;
  let cooldownReduction = 0;
  let areaMultBonus = 0;
  let xpGainMultBonus = 0;
  let knockbackMultBonus = 0;
  let projectileBonus = 0;
  let pierceBonus = 0;

  for (let i = 0; i < player.globalPassives.length; i++) {
    const m = player.globalPassives[i].modifiers;
    if (m.maxHpFlat) maxHpFlat += m.maxHpFlat;
    if (m.moveSpeedMult) moveSpeedMult += m.moveSpeedMult;
    if (m.pickupRadiusMult) pickupRadiusMult += m.pickupRadiusMult;
    if (m.armor) armorBonus += m.armor;
    if (m.critChance) critChanceBonus += m.critChance;
    if (m.critMultiplier) critMultBonus += m.critMultiplier;
    if (m.hpRegen) hpRegenBonus += m.hpRegen;
    if (m.damageMult) damageMultBonus += m.damageMult;
    if (m.cooldownReduction) cooldownReduction += m.cooldownReduction;
    if (m.areaMult) areaMultBonus += m.areaMult;
    if (m.xpGainMult) xpGainMultBonus += m.xpGainMult;
    if (m.knockbackMult) knockbackMultBonus += m.knockbackMult;
    if (m.projectileBonus) projectileBonus += m.projectileBonus;
    if (m.pierceBonus) pierceBonus += m.pierceBonus;
  }

  const retributionBonus = player.retributionBuffTimer > 0 ? 0.25 : 0;

  return {
    maxHp: Math.round(base.maxHp + maxHpFlat),
    moveSpeed: base.moveSpeed * (1 + moveSpeedMult),
    pickupRadius: base.pickupRadius * (1 + pickupRadiusMult),
    armor: Math.min(0.75, base.armor + armorBonus),
    critChance: Math.min(0.95, base.critChance + critChanceBonus),
    critMultiplier: base.critMultiplier + critMultBonus,
    hpRegen: base.hpRegen + hpRegenBonus,
    damageMult: 1 + damageMultBonus + retributionBonus,
    cooldownMult: Math.max(0.25, 1 - cooldownReduction),
    areaMult: 1 + areaMultBonus,
    xpGainMult: 1 + xpGainMultBonus,
    knockbackMult: 1 + knockbackMultBonus,
    projectileBonus: Math.round(projectileBonus),
    pierceBonus: Math.round(pierceBonus),
    hasDoubleCast: player.ownedArtifacts.includes('aether_chronometer'),
    hasRetributionAegis: player.ownedArtifacts.includes('retribution_aegis'),
  };
}

/**
 * Returns all Synergy Evolutions currently ready for a player
 * (both component abilities active at Lv 10 and Synergy not yet owned).
 */
export function getAvailableSynergyEvolutionsForPlayer(player: PlayerState): SynergyDef[] {
  const classSynergies = getSynergiesForClass(player.heroId);
  return classSynergies.filter((syn) => {
    if (player.ownedSynergies.has(syn.id)) return false;
    const [reqA, reqB] = syn.requires;
    const slotA = player.activeSlots.find(
      (s) => s.kind === 'ability' && s.id === reqA && s.level >= MAX_ABILITY_LEVEL
    );
    const slotB = player.activeSlots.find(
      (s) => s.kind === 'ability' && s.id === reqB && s.level >= MAX_ABILITY_LEVEL
    );
    return Boolean(slotA && slotB);
  });
}

// ============================================================================
// SPEED-READABLE METADATA FORMATTERS (LIVE CO-OP DRAFTING)
// ============================================================================

export function formatGlobalPassiveShortTag(
  modifiers: Partial<Record<GlobalStatKey, number>>
): string {
  if (modifiers.cooldownReduction) {
    return `ALL -${Math.round(modifiers.cooldownReduction * 100)}% CD`;
  }
  if (modifiers.projectileBonus) {
    return `ALL +${Math.round(modifiers.projectileBonus)} PROJ`;
  }
  if (modifiers.pierceBonus) {
    return `ALL +${Math.round(modifiers.pierceBonus)} PRC`;
  }
  if (modifiers.damageMult) {
    return `ALL +${Math.round(modifiers.damageMult * 100)}% DMG`;
  }
  if (modifiers.areaMult) {
    return `ALL +${Math.round(modifiers.areaMult * 100)}% AREA`;
  }
  if (modifiers.critChance) {
    return `ALL +${Math.round(modifiers.critChance * 100)}% CRIT`;
  }
  if (modifiers.critMultiplier) {
    return `ALL +${Math.round(modifiers.critMultiplier * 100)}% CDMG`;
  }
  if (modifiers.moveSpeedMult) {
    return `ALL +${Math.round(modifiers.moveSpeedMult * 100)}% SPD`;
  }
  if (modifiers.armor) {
    return `ALL +${Math.round(modifiers.armor * 100)}% ARM`;
  }
  if (modifiers.maxHpFlat) {
    return `ALL +${Math.round(modifiers.maxHpFlat)} HP`;
  }
  if (modifiers.hpRegen) {
    return `ALL +${modifiers.hpRegen} REGEN`;
  }
  if (modifiers.xpGainMult) {
    return `ALL +${Math.round(modifiers.xpGainMult * 100)}% XP`;
  }
  if (modifiers.pickupRadiusMult) {
    return `ALL +${Math.round(modifiers.pickupRadiusMult * 100)}% MAG`;
  }
  if (modifiers.knockbackMult) {
    return `ALL +${Math.round(modifiers.knockbackMult * 100)}% KB`;
  }
  return 'GLOBAL BUFF';
}

export function formatAbilityStepShortTag(step?: AbilityLevelStep): string {
  if (!step) return 'UPGRADE';
  const d = step.deltas;
  if (d.count && d.count > 0) return `+${d.count} Proj`;
  if (d.pierce && d.pierce > 0) return `+${d.pierce} Pierce`;
  if (d.cooldown && d.cooldown < 0) return `${d.cooldown}s CD`;
  if (d.damage && d.damage > 0) return `+${d.damage} DMG`;
  if (d.area && d.area > 0) return `+${d.area} Area`;
  if (d.duration && d.duration > 0) return `+${d.duration}s Dur`;
  if (d.speed && d.speed > 0) return `+${d.speed} Spd`;
  if (d.knockback && d.knockback > 0) return `+${d.knockback} KB`;
  return 'UPGRADE';
}

export function formatArtifactShortTag(artifact: ArtifactDef): string {
  if (artifact.specialEffect === 'double_cast_every_5th') return '2x CAST';
  if (artifact.specialEffect === 'retribution_shockwave') return 'SHOCKWAVE';
  if (artifact.specialEffect === 'full_heal_on_pickup') return 'FULL HEAL';
  return formatGlobalPassiveShortTag(artifact.passive.modifiers);
}

export function artifactToLevelUpChoice(artifact: ArtifactDef): LevelUpChoice {
  return {
    kind: 'artifact',
    artifactId: artifact.id,
    tier: 'artifact',
    iconId: artifact.iconId,
    shortTitle: artifact.name,
    shortTag: formatArtifactShortTag(artifact),
    title: artifact.name,
    subtitle: artifact.isFallback ? 'ASCENDED RELIC' : 'BOSS ARTIFACT',
    description: artifact.description,
    passivePreview: artifact.passive.label,
    color: artifact.color,
  };
}

/**
 * Generates `count` (default 3) Boss Artifact choices for a player's personal queue.
 * Uses unowned class artifacts first, padding with Ascended Relic if fewer than 3 remain.
 */
export function generateBossArtifactChoicesForPlayer(
  player: PlayerState,
  count = 3
): LevelUpChoice[] {
  const ownedSet = new Set(player.ownedArtifacts);
  const available = getAvailableBossArtifacts(player.heroId, ownedSet);
  const defs: ArtifactDef[] = [...available];
  while (defs.length < count) {
    defs.push(ASCENDED_RELIC);
  }
  return defs.slice(0, count).map(artifactToLevelUpChoice);
}

export const ENDLESS_MASTERY_CARDS: readonly LevelUpChoice[] = [
  {
    kind: 'mastery',
    masteryId: 'mastery_power',
    tier: 'standard',
    iconId: 'ascended_relic',
    shortTitle: 'Pastel Might',
    shortTag: 'ALL +10% DMG',
    title: 'Pastel Might',
    subtitle: 'ENDLESS MASTERY',
    description: '+10% All Damage permanently.',
    color: PALETTE.coral,
    masteryModifiers: { damageMult: 0.1 },
  },
  {
    kind: 'mastery',
    masteryId: 'mastery_haste',
    tier: 'standard',
    iconId: 'ascended_relic',
    shortTitle: 'Pastel Haste',
    shortTag: 'ALL -6% CD',
    title: 'Pastel Haste',
    subtitle: 'ENDLESS MASTERY',
    description: '-6% All Cooldowns & +5% Move Speed permanently.',
    color: PALETTE.babyBlue,
    masteryModifiers: { cooldownReduction: 0.06, moveSpeedMult: 0.05 },
  },
  {
    kind: 'mastery',
    masteryId: 'mastery_vitality',
    tier: 'standard',
    iconId: 'ascended_relic',
    shortTitle: 'Pastel Vitality',
    shortTag: '+25 HP +HEAL',
    title: 'Pastel Vitality',
    subtitle: 'ENDLESS MASTERY',
    description: '+25 Max HP, +0.5 HP/s Regen, and heal 35 HP.',
    color: PALETTE.mint,
    masteryModifiers: { maxHpFlat: 25, hpRegen: 0.5 },
    masteryHeal: 35,
  },
];

/**
 * Pure upgrade-roll logic: generates up to `count` level-up choice cards for a player,
 * prioritizing Synergy Evolutions, then active upgrades and new class abilities
 * (respecting the 6-slot cap), with endless mastery fallback cards once maxed.
 */
export function generateLevelUpChoicesForPlayer(
  player: PlayerState,
  rng: RngSource,
  count = 3
): LevelUpChoice[] {
  const choices: LevelUpChoice[] = [];

  // 1. High-priority Synergy Evolution cards
  const readySynergies = getAvailableSynergyEvolutionsForPlayer(player);
  for (const syn of readySynergies) {
    if (choices.length >= count) break;
    const [reqA, reqB] = syn.requires;
    choices.push({
      kind: 'synergy',
      synergyId: syn.id,
      tier: 'synergy',
      iconId: syn.iconId,
      shortTitle: syn.name.toUpperCase(),
      shortTag: 'EVOLVE',
      title: syn.name,
      subtitle: `SYNERGY EVOLUTION (${ABILITIES[reqA].name} + ${ABILITIES[reqB].name})`,
      description: syn.description,
      passivePreview: `Frees 1 slot + keeps Lv5/Lv10 passives + ${syn.bonusPassive.label}`,
      color: syn.color,
    });
  }

  // 2. Pool of eligible upgrades and new abilities
  const pool: LevelUpChoice[] = [];
  const classAbilities = getAbilitiesForClass(player.heroId);
  const hasFreeSlot = player.activeSlots.length < MAX_ACTIVE_ABILITY_SLOTS;

  for (const ab of classAbilities) {
    if (player.consumedAbilities.has(ab.id)) continue;

    const active = player.activeSlots.find(
      (s) => s.kind === 'ability' && s.id === ab.id
    );

    if (active) {
      if (active.level >= MAX_ABILITY_LEVEL) continue;
      const nextLv = active.level + 1;
      const step = ab.levels.find((l) => l.level === nextLv);
      let passivePreview: string | undefined;
      let tier: ChoiceTier = 'standard';
      let shortTag = formatAbilityStepShortTag(step);

      if (nextLv === 5) {
        tier = 'milestone';
        passivePreview = `Lv 5 Global Passive: ${ab.lv5Passive.label}`;
        shortTag = formatGlobalPassiveShortTag(ab.lv5Passive.modifiers);
      } else if (nextLv === 10) {
        tier = 'milestone';
        passivePreview = `Lv 10 Global Passive: ${ab.lv10Passive.label}`;
        shortTag = formatGlobalPassiveShortTag(ab.lv10Passive.modifiers);
      }

      pool.push({
        kind: 'ability',
        abilityId: ab.id,
        tier,
        iconId: ab.iconId,
        shortTitle: `${ab.name} Lv ${nextLv}`,
        shortTag,
        title: ab.name,
        subtitle: `Lv ${active.level} -> Lv ${nextLv}`,
        description: step ? step.description : ab.description,
        passivePreview,
        nextLevel: nextLv,
        isNew: false,
        color: ab.color,
      });
    } else if (hasFreeSlot) {
      pool.push({
        kind: 'ability',
        abilityId: ab.id,
        tier: 'standard',
        iconId: ab.iconId,
        shortTitle: `${ab.name} Lv 1`,
        shortTag: 'NEW',
        title: ab.name,
        subtitle: 'NEW ABILITY (Lv 1)',
        description: ab.description,
        passivePreview: `Lv 5: ${ab.lv5Passive.label} | Lv 10: ${ab.lv10Passive.label}`,
        nextLevel: 1,
        isNew: true,
        color: ab.color,
      });
    }
  }

  // Shuffle eligible ability pool using RNG source
  rng.shuffle(pool);

  while (choices.length < count && pool.length > 0) {
    const next = pool.shift();
    if (next) choices.push(next);
  }

  // 3. Endless Mastery fallback cards when all 6 slots are maxed
  let mIdx = 0;
  while (choices.length < count && mIdx < ENDLESS_MASTERY_CARDS.length) {
    choices.push(ENDLESS_MASTERY_CARDS[mIdx++]);
  }

  return choices;
}

/**
 * Re-validates a queued choice batch against the player's latest progression state
 * when it becomes the active batch after an earlier queued pick was applied.
 */
export function refreshPendingChoiceBatch(
  player: PlayerState,
  batch: PendingChoiceBatch,
  rng: RngSource
): PendingChoiceBatch {
  if (batch.source === 'boss_chest') {
    return {
      ...batch,
      choices: generateBossArtifactChoicesForPlayer(player, 3),
    };
  }
  return {
    ...batch,
    choices: generateLevelUpChoicesForPlayer(player, rng, 3),
  };
}
