import { PALETTE } from './palette';
import type { AbilityId, ClassId, SynergyDef, SynergyId } from './types';

/**
 * All 15 evolved Synergies (5 per class).
 * Each Synergy requires both component abilities at Lv 10, replaces them in
 * the active ability strip (freeing 1 active slot), preserves all Lv 5 and Lv 10
 * global passives from both components, and grants an additional bonus global passive.
 */
export const SYNERGIES: Record<SynergyId, SynergyDef> = {
  // ==========================================================================
  // MAGE SYNERGIES (5)
  // ==========================================================================
  firestorm: {
    id: 'firestorm',
    classId: 'mage',
    name: 'Firestorm',
    iconId: 'firestorm',
    projectileSprite: 'fireball',
    color: PALETTE.coral,
    requires: ['fireball', 'wind_blade'],
    description:
      'Unleashes blazing tornado fireballs that pull enemies inward and scorch them.',
    evolvedSpec: {
      behavior: 'boomerang',
      summary:
        'Launches 4 spiraling flame cyclones that pierce infinitely, pull nearby foes toward their core, and leave scorching ember ticks.',
      specialMechanics: ['pull_vortex', 'burn_dot', 'explosive_finish'],
      stats: {
        damage: 78,
        cooldown: 1.18,
        count: 4,
        area: 68,
        pierce: 999,
        duration: 2.6,
        speed: 290,
        knockback: 45,
      },
    },
    bonusPassive: {
      id: 'synergy_firestorm',
      label: '+15% All Damage, +10% All Area',
      modifiers: { damageMult: 0.15, areaMult: 0.1 },
    },
  },

  absolute_zero: {
    id: 'absolute_zero',
    classId: 'mage',
    name: 'Absolute Zero',
    iconId: 'absolute_zero',
    projectileSprite: 'ice',
    color: PALETTE.babyBlue,
    requires: ['ice_shard', 'frost_nova'],
    description:
      'Erupts shattering glacial rings while firing piercing freezing lances in all directions.',
    evolvedSpec: {
      behavior: 'nova',
      summary:
        'Triggers a massive frost nova that freezes foes solid and simultaneously releases 10 piercing glacial lances that shatter frozen targets.',
      specialMechanics: ['freeze_slow', 'radial_ice_lances', 'shatter_bonus'],
      stats: {
        damage: 75,
        cooldown: 1.82,
        count: 10,
        area: 175,
        pierce: 999,
        duration: 0.9,
        speed: 440,
        knockback: 110,
      },
    },
    bonusPassive: {
      id: 'synergy_absolute_zero',
      label: '-10% All Cooldowns, +15% All Area',
      modifiers: { cooldownReduction: 0.1, areaMult: 0.15 },
    },
  },

  tempest_lance: {
    id: 'tempest_lance',
    classId: 'mage',
    name: 'Tempest Lance',
    iconId: 'tempest_lance',
    projectileSprite: 'lightning',
    color: PALETTE.butter,
    requires: ['chain_lightning', 'plasma_beam'],
    description:
      'Fires a wide piercing lightning laser that continuously arcs bolts to nearby enemies.',
    evolvedSpec: {
      behavior: 'beam',
      summary:
        'Projects dual high-voltage plasma lances across the screen; every enemy seared discharges chain-lightning arcs to 4 surrounding targets.',
      specialMechanics: ['chain_arc_on_hit', 'screen_wide_beam', 'crit_surge'],
      stats: {
        damage: 90,
        cooldown: 1.62,
        count: 2,
        area: 44,
        pierce: 999,
        duration: 0.75,
        speed: 0,
        knockback: 65,
      },
    },
    bonusPassive: {
      id: 'synergy_tempest_lance',
      label: '+12% Crit Chance, +12% All Damage',
      modifiers: { critChance: 0.12, damageMult: 0.12 },
    },
  },

  eclipse_singularity: {
    id: 'eclipse_singularity',
    classId: 'mage',
    name: 'Eclipse Singularity',
    iconId: 'eclipse_singularity',
    projectileSprite: 'shadow',
    color: PALETTE.lavenderDark,
    requires: ['arcane_orb', 'shadow_bolt'],
    description:
      'Orbiting dark-arcane singularities crush nearby foes while firing homing void bolts.',
    evolvedSpec: {
      behavior: 'orbit',
      summary:
        'Maintains 6 perpetual dusk-arcane orbs orbiting the Mage; each orb periodically fires seeking void bolts at distant targets.',
      specialMechanics: ['perpetual_orbit', 'emit_homing_bolts', 'gravity_drag'],
      stats: {
        damage: 54,
        cooldown: 2.4,
        count: 6,
        area: 30,
        pierce: 999,
        duration: 3.2,
        speed: 260,
        knockback: 80,
      },
    },
    bonusPassive: {
      id: 'synergy_eclipse_singularity',
      label: '-10% All Cooldowns, +20% Pickup Radius',
      modifiers: { cooldownReduction: 0.1, pickupRadiusMult: 0.2 },
    },
  },

  cataclysm: {
    id: 'cataclysm',
    classId: 'mage',
    name: 'Cataclysm',
    iconId: 'cataclysm',
    projectileSprite: 'fireball',
    color: PALETTE.peachDark,
    requires: ['earth_spike', 'meteor_rain'],
    description:
      'Drops giant meteors that erupt into radial earth-spike shockwaves on impact.',
    evolvedSpec: {
      behavior: 'rain',
      summary:
        'Calls down 6 colossal pastel meteors; each impact shatters the ground and triggers a radial burst of earth spikes around the crater.',
      specialMechanics: ['radial_earth_spikes', 'heavy_screen_shake', 'seismic_knockback'],
      stats: {
        damage: 114,
        cooldown: 2.2,
        count: 6,
        area: 105,
        pierce: 999,
        duration: 0.85,
        speed: 0,
        knockback: 180,
      },
    },
    bonusPassive: {
      id: 'synergy_cataclysm',
      label: '+18% All Area, +25 Max HP',
      modifiers: { areaMult: 0.18, maxHpFlat: 25 },
    },
  },

  // ==========================================================================
  // RANGER SYNERGIES (5)
  // ==========================================================================
  smart_bullets: {
    id: 'smart_bullets',
    classId: 'ranger',
    name: 'Smart Bullets',
    iconId: 'smart_bullets',
    projectileSprite: 'bullet',
    color: PALETTE.mint,
    requires: ['twin_pistols', 'homing_arrow'],
    description:
      'Unleashes rapid-fire curving auto-lock rounds that relentlessly hunt down enemies.',
    evolvedSpec: {
      behavior: 'homing',
      summary:
        'Streams 6 high-velocity smart rounds per burst that aggressively curve toward targets and retarget after piercing.',
      specialMechanics: ['rapid_homing', 'retarget_on_pierce', 'crit_precision'],
      stats: {
        damage: 40,
        cooldown: 0.48,
        count: 6,
        area: 16,
        pierce: 3,
        duration: 2.2,
        speed: 520,
        knockback: 45,
      },
    },
    bonusPassive: {
      id: 'synergy_smart_bullets',
      label: '-10% All Cooldowns, +10% Move Speed',
      modifiers: { cooldownReduction: 0.1, moveSpeedMult: 0.1 },
    },
  },

  starlight_railgun: {
    id: 'starlight_railgun',
    classId: 'ranger',
    name: 'Starlight Railgun',
    iconId: 'starlight_railgun',
    projectileSprite: 'arrow',
    color: PALETTE.periwinkle,
    requires: ['magic_longbow', 'piercing_rail_bow'],
    description:
      'Fires hyper-velocity screen-wide starlight beam arrows with devastating crit power.',
    evolvedSpec: {
      behavior: 'beam',
      summary:
        'Discharges 3 synchronized starlight rail beams spanning the entire viewport with guaranteed bonus critical scaling and star-burst afterglow.',
      specialMechanics: ['screen_wide_beam', 'bonus_crit_mult', 'starlight_afterglow'],
      stats: {
        damage: 124,
        cooldown: 1.52,
        count: 3,
        area: 36,
        pierce: 999,
        duration: 0.45,
        speed: 0,
        knockback: 140,
      },
    },
    bonusPassive: {
      id: 'synergy_starlight_railgun',
      label: '+15% Crit Chance, +0.35x Crit Mult',
      modifiers: { critChance: 0.15, critMultiplier: 0.35 },
    },
  },

  cluster_cannon: {
    id: 'cluster_cannon',
    classId: 'ranger',
    name: 'Cluster Cannon',
    iconId: 'cluster_cannon',
    projectileSprite: 'fireball',
    color: PALETTE.coral,
    requires: ['shotgun_blast', 'explosive_crossbow'],
    description:
      'Blasts a wide cone of explosive shrapnel shells that detonate into secondary blasts.',
    evolvedSpec: {
      behavior: 'projectile',
      summary:
        'Fires 7 heavy blast shells in a spread; each shell detonates in a wide coral explosion and scatters piercing shrapnel.',
      specialMechanics: ['explosive_cone', 'cluster_shrapnel', 'heavy_knockback'],
      stats: {
        damage: 62,
        cooldown: 1.28,
        count: 7,
        area: 68,
        pierce: 2,
        duration: 1.1,
        speed: 440,
        knockback: 165,
      },
    },
    bonusPassive: {
      id: 'synergy_cluster_cannon',
      label: '+16% All Damage, +12% All Area',
      modifiers: { damageMult: 0.16, areaMult: 0.12 },
    },
  },

  glacial_ricochet: {
    id: 'glacial_ricochet',
    classId: 'ranger',
    name: 'Glacial Ricochet',
    iconId: 'glacial_ricochet',
    projectileSprite: 'ice',
    color: PALETTE.babyBlue,
    requires: ['ricochet_revolver', 'frost_quiver'],
    description:
      'Fires chilling bouncing bullets that slow targets and splinter into frost shards.',
    evolvedSpec: {
      behavior: 'ricochet',
      summary:
        'Unleashes 5 hyper-bouncing frost slugs that ricochet up to 8 times, chilling every target and shedding frost splinters on each bounce.',
      specialMechanics: ['freeze_slow', 'splinter_on_bounce', 'high_ricochet'],
      stats: {
        damage: 52,
        cooldown: 0.95,
        count: 5,
        area: 20,
        pierce: 8,
        duration: 2.8,
        speed: 500,
        knockback: 60,
      },
    },
    bonusPassive: {
      id: 'synergy_glacial_ricochet',
      label: '+10% Move Speed, +1 Pierce to All',
      modifiers: { moveSpeedMult: 0.1, pierceBonus: 1 },
    },
  },

  artillery_barrage: {
    id: 'artillery_barrage',
    classId: 'ranger',
    name: 'Artillery Barrage',
    iconId: 'artillery_barrage',
    projectileSprite: 'arrow',
    color: PALETTE.sage,
    requires: ['gatling_turret', 'rain_of_arrows'],
    description:
      'Deploys fortified auto-turrets that call down continuous overhead arrow volleys.',
    evolvedSpec: {
      behavior: 'turret',
      summary:
        'Maintains up to 3 twin-barrel pastel artillery turrets that fire rapid piercing rounds while periodically calling down wide arrow barrages.',
      specialMechanics: ['turret_calls_arrow_rain', 'rapid_turret_fire', 'extended_range'],
      stats: {
        damage: 46,
        cooldown: 3.7,
        count: 3,
        area: 260,
        pierce: 3,
        duration: 8.5,
        speed: 520,
        knockback: 45,
      },
    },
    bonusPassive: {
      id: 'synergy_artillery_barrage',
      label: '+20% XP Gain, +12% All Damage',
      modifiers: { xpGainMult: 0.2, damageMult: 0.12 },
    },
  },

  // ==========================================================================
  // KNIGHT SYNERGIES (5)
  // ==========================================================================
  whirlwind_tempest: {
    id: 'whirlwind_tempest',
    classId: 'knight',
    name: 'Whirlwind Tempest',
    iconId: 'whirlwind_tempest',
    color: PALETTE.peach,
    requires: ['greatsword_cleave', 'orbiting_blades'],
    description:
      'Surrounds the Knight in a 360° rapid blade cyclone and giant orbiting greatswords.',
    evolvedSpec: {
      behavior: 'orbit',
      summary:
        'Spins 6 giant porcelain greatswords in a relentless 360° cyclone around the Knight while pulsing rapid melee cleave waves.',
      specialMechanics: ['360_cleave_pulse', 'perpetual_orbit', 'high_knockback'],
      stats: {
        damage: 66,
        cooldown: 1.65,
        count: 6,
        area: 112,
        pierce: 999,
        duration: 2.8,
        speed: 320,
        knockback: 145,
      },
    },
    bonusPassive: {
      id: 'synergy_whirlwind_tempest',
      label: '+16% All Damage, +10% Move Speed',
      modifiers: { damageMult: 0.16, moveSpeedMult: 0.1 },
    },
  },

  bastion_quake: {
    id: 'bastion_quake',
    classId: 'knight',
    name: 'Bastion Quake',
    iconId: 'bastion_quake',
    color: PALETTE.babyBlue,
    requires: ['shield_bash', 'shockwave_stomp'],
    description:
      'Delivers massive knockback shield slams followed by double seismic shockwave rings.',
    evolvedSpec: {
      behavior: 'nova',
      summary:
        'Emits a double-ringed porcelain bastion quake that hurls entire packs backward and briefly stuns enemies caught in the epicenter.',
      specialMechanics: ['double_shockwave_ring', 'massive_knockback', 'micro_stun'],
      stats: {
        damage: 86,
        cooldown: 1.72,
        count: 2,
        area: 175,
        pierce: 999,
        duration: 0.65,
        speed: 0,
        knockback: 310,
      },
    },
    bonusPassive: {
      id: 'synergy_bastion_quake',
      label: '+10% Armor, +35 Max HP',
      modifiers: { armor: 0.1, maxHpFlat: 35 },
    },
  },

  reapers_pendulum: {
    id: 'reapers_pendulum',
    classId: 'knight',
    name: "Reaper's Pendulum",
    iconId: 'reapers_pendulum',
    projectileSprite: 'axe',
    color: PALETTE.coralDark,
    requires: ['spinning_axe', 'chain_flail'],
    description:
      'Hurls heavy spiraling boomerang flail-axes that sweep wide arcs across the battlefield.',
    evolvedSpec: {
      behavior: 'boomerang',
      summary:
        'Launches 5 chained reaper flail-axes in spiraling boomerang orbits that shred enemies on both outbound and return arcs.',
      specialMechanics: ['spiral_boomerang', 'bleed_bonus_crit', 'infinite_pierce'],
      stats: {
        damage: 82,
        cooldown: 1.22,
        count: 5,
        area: 42,
        pierce: 999,
        duration: 2.3,
        speed: 370,
        knockback: 125,
      },
    },
    bonusPassive: {
      id: 'synergy_reapers_pendulum',
      label: '+15% All Damage, +10% Crit Chance',
      modifiers: { damageMult: 0.15, critChance: 0.1 },
    },
  },

  divine_judgment: {
    id: 'divine_judgment',
    classId: 'knight',
    name: 'Divine Judgment',
    iconId: 'divine_judgment',
    projectileSprite: 'hammer',
    color: PALETTE.butter,
    requires: ['ground_slam', 'holy_hammer'],
    description:
      'Calls down colossal sacred hammers that trigger golden seismic craters.',
    evolvedSpec: {
      behavior: 'rain',
      summary:
        'Drops 5 towering holy hammers onto enemy clusters; every impact unleashes a golden seismic aftershock that heals the Knight slightly on multi-kills.',
      specialMechanics: ['seismic_aftershock', 'holy_crater', 'minor_lifesteal'],
      stats: {
        damage: 118,
        cooldown: 1.88,
        count: 5,
        area: 108,
        pierce: 999,
        duration: 0.75,
        speed: 0,
        knockback: 195,
      },
    },
    bonusPassive: {
      id: 'synergy_divine_judgment',
      label: '+1.5 HP/s Regen, +15% All Area',
      modifiers: { hpRegen: 1.5, areaMult: 0.15 },
    },
  },

  valkyrie_blitz: {
    id: 'valkyrie_blitz',
    classId: 'knight',
    name: 'Valkyrie Blitz',
    iconId: 'valkyrie_blitz',
    projectileSprite: 'spear',
    color: PALETTE.rose,
    requires: ['spear_thrust', 'blade_dash'],
    description:
      'Unleashes rapid phantom spear-dashes that slice cleanly through enemy packs.',
    evolvedSpec: {
      behavior: 'dash',
      summary:
        'Dispatches 4 high-speed valkyrie spear phantoms that chain-dash through dense enemy lines with glowing rose trails.',
      specialMechanics: ['multi_phantom_dash', 'piercing_trail', 'high_speed_blitz'],
      stats: {
        damage: 80,
        cooldown: 1.0,
        count: 4,
        area: 48,
        pierce: 999,
        duration: 0.55,
        speed: 680,
        knockback: 115,
      },
    },
    bonusPassive: {
      id: 'synergy_valkyrie_blitz',
      label: '-10% All Cooldowns, +12% Move Speed',
      modifiers: { cooldownReduction: 0.1, moveSpeedMult: 0.12 },
    },
  },

  // ==========================================================================
  // ALCHEMIST SYNERGIES (5)
  // ==========================================================================
  sanctuary_choir: {
    id: 'sanctuary_choir',
    classId: 'alchemist',
    name: 'Sanctuary Choir',
    iconId: 'sanctuary_choir',
    color: PALETTE.mint,
    requires: ['healing_mist', 'haste_aura'],
    description:
      'Unfolds a radiant mint-butter sanctuary that continuously heals allies, grants haste, and sears enemies.',
    evolvedSpec: {
      behavior: 'zone',
      summary:
        'Deploys expansive radiant clouds that rapidly heal all allies inside, grant +25% move speed and cooldown haste, and pulse harmonic damage to foes.',
      specialMechanics: ['ally_heal_field', 'ally_haste_buff', 'harmonic_damage_pulse'],
      stats: {
        damage: 33,
        cooldown: 4.3,
        count: 2,
        area: 132,
        pierce: 999,
        duration: 3.6,
        speed: 0,
        knockback: 40,
      },
    },
    bonusPassive: {
      id: 'synergy_sanctuary_choir',
      label: '+2.0 HP/s Regen, -10% All Cooldowns',
      modifiers: { hpRegen: 2.0, cooldownReduction: 0.1 },
    },
  },

  caustic_singularity: {
    id: 'caustic_singularity',
    classId: 'alchemist',
    name: 'Caustic Singularity',
    iconId: 'caustic_singularity',
    projectileSprite: 'vial',
    color: PALETTE.butterDark,
    requires: ['acid_flask', 'gravity_potion'],
    description:
      'Summons a swirling corrosive vortex that drags hordes inward and shreds their armor for the whole squad.',
    evolvedSpec: {
      behavior: 'zone',
      summary:
        'Creates 2 intense acid-gravity wells that cluster enemies tightly, inflict +45% damage vulnerability from all players, and dissolve foes with acid ticks.',
      specialMechanics: ['gravity_vortex', 'armor_shred_45', 'acid_dot_pool'],
      stats: {
        damage: 50,
        cooldown: 2.3,
        count: 2,
        area: 142,
        pierce: 999,
        duration: 4.5,
        speed: 0,
        knockback: 0,
      },
    },
    bonusPassive: {
      id: 'synergy_caustic_singularity',
      label: '+16% All Damage, +16% All Area',
      modifiers: { damageMult: 0.16, areaMult: 0.16 },
    },
  },

  aegis_lantern: {
    id: 'aegis_lantern',
    classId: 'alchemist',
    name: 'Aegis Lantern',
    iconId: 'aegis_lantern',
    color: PALETTE.butter,
    requires: ['protective_ward', 'revive_totem'],
    description:
      'Deploys radiant bastion lanterns ringed with ward barriers that shield allies and rapidly revive downed teammates.',
    evolvedSpec: {
      behavior: 'totem',
      summary:
        'Places up to 2 fortified sanctuary lanterns that pulse pastel shields, boost ally regen, fire light bolts, and accelerate revives by 2.5x (or solo-revive at 0.75x).',
      specialMechanics: ['shield_pulse', 'rapid_revive_totem', 'orbiting_ward_bolts'],
      stats: {
        damage: 55,
        cooldown: 4.3,
        count: 2,
        area: 175,
        pierce: 3,
        duration: 11.0,
        speed: 420,
        knockback: 90,
      },
    },
    bonusPassive: {
      id: 'synergy_aegis_lantern',
      label: '+35 Max HP, +10% Armor',
      modifiers: { maxHpFlat: 35, armor: 0.1 },
    },
  },

  plague_glacier: {
    id: 'plague_glacier',
    classId: 'alchemist',
    name: 'Plague Glacier',
    iconId: 'plague_glacier',
    projectileSprite: 'vial',
    color: PALETTE.babyBlue,
    requires: ['venom_nova', 'frost_tonic'],
    description:
      'Erupts a venomous frost nova that chills, freezes, and dissolves hordes with shattering poison waves.',
    evolvedSpec: {
      behavior: 'nova',
      summary:
        'Unleashes a wide frost-venom ring that chills and freezes enemies, applies potent venom DoT, and shatters chilled foes for bonus burst damage.',
      specialMechanics: ['freeze_slow', 'venom_dot', 'shatter_bonus'],
      stats: {
        damage: 80,
        cooldown: 1.82,
        count: 2,
        area: 172,
        pierce: 999,
        duration: 0.75,
        speed: 0,
        knockback: 110,
      },
    },
    bonusPassive: {
      id: 'synergy_plague_glacier',
      label: '+14% All Area, +14% All Damage',
      modifiers: { areaMult: 0.14, damageMult: 0.14 },
    },
  },

  celestial_panacea: {
    id: 'celestial_panacea',
    classId: 'alchemist',
    name: 'Celestial Panacea',
    iconId: 'celestial_panacea',
    projectileSprite: 'vial',
    color: PALETTE.coral,
    requires: ['bouncing_vial', 'starlight_elixir'],
    description:
      'Unleashes starlight-charged ricochet vials that chain between foes and bathe nearby allies in crit & haste buffs.',
    evolvedSpec: {
      behavior: 'ricochet',
      summary:
        'Hurls 5 homing starlight vials that ricochet up to 8 times between targets, exploding in pastel sparks and granting nearby allies +15% Crit & Haste on hit.',
      specialMechanics: ['high_ricochet', 'ally_starlight_buff', 'spark_burst'],
      stats: {
        damage: 56,
        cooldown: 0.92,
        count: 5,
        area: 28,
        pierce: 8,
        duration: 2.8,
        speed: 490,
        knockback: 55,
      },
    },
    bonusPassive: {
      id: 'synergy_celestial_panacea',
      label: '+14% Crit Chance, -10% All Cooldowns',
      modifiers: { critChance: 0.14, cooldownReduction: 0.1 },
    },
  },
};

export const SYNERGY_LIST: readonly SynergyDef[] = Object.values(SYNERGIES);

export function getSynergyDef(id: SynergyId): SynergyDef {
  return SYNERGIES[id];
}

export function getSynergiesForClass(classId: ClassId): SynergyDef[] {
  return SYNERGY_LIST.filter((s) => s.classId === classId);
}

/**
 * Finds the synergy that uses a given ability, if any.
 */
export function findSynergyForAbility(abilityId: AbilityId): SynergyDef | undefined {
  return SYNERGY_LIST.find(
    (s) => s.requires[0] === abilityId || s.requires[1] === abilityId
  );
}
