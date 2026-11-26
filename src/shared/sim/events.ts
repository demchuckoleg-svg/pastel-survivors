import type {
  AbilityId,
  ArtifactDef,
  ArtifactId,
  BossId,
  EnemySpriteId,
  PickupSpriteId,
  ProjectileSpriteId,
  SynergyId,
} from '../data/types';
import type {
  ActiveProjectile,
  BossActiveInfo,
  LevelUpChoice,
  ParticleBurstOptions,
  PendingChoiceSource,
  PlayerId,
  RunStatsSnapshot,
} from './types';

/**
 * Lightweight typed simulation events emitted during simulation ticks and actions.
 * The client renderer / audio layer consumes these to drive particles, floating
 * damage numbers, screen shake, sound effects, and UI modals — keeping simulation
 * logic 100% decoupled from browser/DOM/Canvas/Audio APIs.
 */
export type SimEvent =
  | {
      type: 'AbilityFired';
      playerId: PlayerId;
      abilityId: AbilityId | SynergyId;
      isSynergy: boolean;
      x: number;
      y: number;
      color: string;
      isDoubleCast?: boolean;
      /**
       * The actual angle the cast was aimed at (auto-target toward nearest enemy or manual aim),
       * NOT the hero's facing/movement direction.
       */
      aimAngle: number;
    }
  | {
      /** Authoritative projectile entered the world (co-op replication only). */
      type: 'ProjectileSpawned';
      netId: number;
      playerId: PlayerId;
      sourceId: AbilityId | SynergyId;
      spriteId?: ProjectileSpriteId;
      kind: ActiveProjectile['kind'];
      x: number;
      y: number;
      vx: number;
      vy: number;
      radius: number;
      scale: number;
      spinSpeed: number;
      remainingLifeSec: number;
    }
  | {
      /** Authoritative projectile changed course / drifted from its last replicated path. */
      type: 'ProjectileMoved';
      netId: number;
      x: number;
      y: number;
      vx: number;
      vy: number;
    }
  | {
      /** Authoritative projectile was removed (hit, expired, or returned). */
      type: 'ProjectileDespawned';
      netId: number;
      x: number;
      y: number;
    }
  | {
      type: 'DamageDealt';
      enemyId: number;
      playerId?: PlayerId;
      x: number;
      y: number;
      radius: number;
      amount: number;
      isCrit: boolean;
      shattered: boolean;
      color: string;
      silent?: boolean;
    }
  | {
      type: 'EnemyKilled';
      enemyId: number;
      archetypeId: EnemySpriteId;
      isBoss: boolean;
      bossId?: BossId;
      x: number;
      y: number;
      radius: number;
      accentColor: string;
    }
  | {
      type: 'EnemyTaunted';
      enemyId: number;
      targetPlayerId: PlayerId;
      durationSec: number;
      x: number;
      y: number;
    }
  | {
      type: 'PlayerDamaged';
      playerId: PlayerId;
      x: number;
      y: number;
      amount: number;
      remainingHp: number;
    }
  | {
      type: 'PlayerHealed';
      playerId: PlayerId;
      x: number;
      y: number;
      amount: number;
    }
  | {
      type: 'PlayerDowned';
      playerId: PlayerId;
      x: number;
      y: number;
    }
  | {
      type: 'PlayerRevived';
      playerId: PlayerId;
      reason: 'circle' | 'boss_kill';
      reviverIds: PlayerId[];
      x: number;
      y: number;
      hp: number;
    }
  | {
      type: 'PickupCollected';
      playerId: PlayerId;
      kind: PickupSpriteId;
      x: number;
      y: number;
      value: number;
      xpTier?: 1 | 2 | 3;
    }
  | {
      type: 'LevelUpTriggered';
      playerId: PlayerId;
      newLevel: number;
      x: number;
      y: number;
      choices: LevelUpChoice[];
      batchId?: number;
      pendingQueueCount?: number;
    }
  | {
      type: 'UpgradeChoicesQueued';
      playerId: PlayerId;
      batchId: number;
      source: PendingChoiceSource;
      choices: LevelUpChoice[];
      pendingQueueCount: number;
      isActive: boolean;
    }
  | {
      type: 'UpgradePicked';
      playerId: PlayerId;
      choice: LevelUpChoice;
      remainingQueueCount: number;
      nextBatchId?: number;
      nextChoices: LevelUpChoice[];
    }
  | {
      type: 'SynergyEvolved';
      playerId: PlayerId;
      synergyId: SynergyId;
      name: string;
      color: string;
      x: number;
      y: number;
    }
  | {
      type: 'ArtifactGranted';
      playerId: PlayerId;
      artifactId: ArtifactId;
      name: string;
      color: string;
      x: number;
      y: number;
      fullHeal: boolean;
    }
  | {
      type: 'BossSpawned';
      boss: BossActiveInfo;
      x: number;
      y: number;
    }
  | {
      type: 'BossDefeated';
      boss: BossActiveInfo;
      x: number;
      y: number;
    }
  | {
      type: 'BossTelegraph';
      enemyId: number;
      bossId: BossId;
      attackId: string;
      attackName: string;
      x: number;
      y: number;
      targetX: number;
      targetY: number;
      telegraphSec: number;
      color: string;
    }
  | {
      type: 'BossHazard';
      hazardKind: 'arena_ring' | 'meteor_mark' | 'tether_beam';
      x: number;
      y: number;
      targetX: number;
      targetY: number;
      radius: number;
      durationMs: number;
      active: boolean;
    }
  | {
      type: 'ChestSpawned';
      x: number;
      y: number;
      sourceBossId?: BossId;
    }
  | {
      type: 'BossChestOpened';
      playerId: PlayerId;
      openedByPlayerId?: PlayerId;
      x: number;
      y: number;
      choices: ArtifactDef[];
      upgradeChoices?: LevelUpChoice[];
      batchId?: number;
      pendingQueueCount?: number;
    }
  | {
      type: 'VfxBurst';
      x: number;
      y: number;
      color: string;
      count: number;
      opts?: ParticleBurstOptions;
    }
  | {
      type: 'VfxRing';
      x: number;
      y: number;
      color: string;
      maxRadius: number;
      duration?: number;
    }
  | {
      type: 'VfxText';
      x: number;
      y: number;
      text: string;
      color: string;
      isCrit?: boolean;
    }
  | {
      type: 'ScreenShake';
      intensity: number;
      durationSec: number;
    }
  | {
      type: 'GameOverTriggered';
      snapshot: RunStatsSnapshot;
    };
