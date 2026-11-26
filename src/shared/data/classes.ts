import { PALETTE } from './palette';
import type { ClassDef, ClassId } from './types';

/**
 * Playable hero classes with base stats and signature starting abilities.
 */
export const CLASSES: Record<ClassId, ClassDef> = {
  mage: {
    id: 'mage',
    name: 'Mage',
    title: 'Pastel Arcanist',
    description:
      'Commands elemental storms, freezing rings, and arcane singularities with wide area coverage.',
    accentColor: PALETTE.lavender,
    baseStats: {
      maxHp: 85,
      moveSpeed: 118,
      pickupRadius: 72,
      armor: 0,
      critChance: 0.06,
      critMultiplier: 1.5,
      hpRegen: 0,
    },
    startingAbilityId: 'fireball',
  },
  ranger: {
    id: 'ranger',
    name: 'Ranger',
    title: 'Starlight Marksman',
    description:
      'Agile skirmisher wielding rapid firearms, piercing bows, and automated artillery turrets.',
    accentColor: PALETTE.mint,
    baseStats: {
      maxHp: 95,
      moveSpeed: 138,
      pickupRadius: 80,
      armor: 0,
      critChance: 0.1,
      critMultiplier: 1.6,
      hpRegen: 0,
    },
    startingAbilityId: 'twin_pistols',
  },
  knight: {
    id: 'knight',
    name: 'Knight',
    title: 'Porcelain Vanguard',
    description:
      'Armored frontline juggernaut crushing hordes with sweeping blades, shields, and sacred slams.',
    accentColor: PALETTE.peach,
    baseStats: {
      maxHp: 135,
      moveSpeed: 112,
      pickupRadius: 68,
      armor: 0.15,
      critChance: 0.05,
      critMultiplier: 1.5,
      hpRegen: 0.3,
    },
    startingAbilityId: 'greatsword_cleave',
  },
  alchemist: {
    id: 'alchemist',
    name: 'Alchemist',
    title: 'Pastel Apothecary',
    description:
      'Support & debuff brewer sustaining squads with healing mists, shields, armor-shredding flasks, and revive lanterns.',
    accentColor: PALETTE.butter,
    baseStats: {
      maxHp: 85,
      moveSpeed: 124,
      pickupRadius: 76,
      armor: 0,
      critChance: 0.06,
      critMultiplier: 1.5,
      hpRegen: 0.1,
    },
    startingAbilityId: 'healing_mist',
  },
};

export const CLASS_LIST: readonly ClassDef[] = [
  CLASSES.mage,
  CLASSES.ranger,
  CLASSES.knight,
  CLASSES.alchemist,
];

export const MAX_ACTIVE_ABILITY_SLOTS = 6;
export const MAX_ABILITY_LEVEL = 10;

export function getClassDef(id: ClassId): ClassDef {
  return CLASSES[id];
}
