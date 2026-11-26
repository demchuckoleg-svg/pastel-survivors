import { ABILITIES, getAbilitiesForClass } from '../data/abilities';
import { CLASSES, MAX_ABILITY_LEVEL, MAX_ACTIVE_ABILITY_SLOTS } from '../data/classes';
import { PALETTE } from '../data/palette';
import { getSynergiesForClass } from '../data/synergies';
import type { SynergyDef } from '../data/types';
import type { RngSource } from './rng';
import type { ComputedPlayerStats, LevelUpChoice, PlayerState } from './types';

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

export const ENDLESS_MASTERY_CARDS: readonly LevelUpChoice[] = [
  {
    kind: 'mastery',
    masteryId: 'mastery_power',
    title: 'Pastel Might',
    subtitle: 'ENDLESS MASTERY',
    description: '+10% All Damage permanently.',
    color: PALETTE.coral,
    masteryModifiers: { damageMult: 0.1 },
  },
  {
    kind: 'mastery',
    masteryId: 'mastery_haste',
    title: 'Pastel Haste',
    subtitle: 'ENDLESS MASTERY',
    description: '-6% All Cooldowns & +5% Move Speed permanently.',
    color: PALETTE.babyBlue,
    masteryModifiers: { cooldownReduction: 0.06, moveSpeedMult: 0.05 },
  },
  {
    kind: 'mastery',
    masteryId: 'mastery_vitality',
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
      if (nextLv === 5) passivePreview = `Lv 5 Global Passive: ${ab.lv5Passive.label}`;
      else if (nextLv === 10) passivePreview = `Lv 10 Global Passive: ${ab.lv10Passive.label}`;

      pool.push({
        kind: 'ability',
        abilityId: ab.id,
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
