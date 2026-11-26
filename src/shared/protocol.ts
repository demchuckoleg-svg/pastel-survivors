import type {
  AbilityId,
  BossId,
  EnemySpriteId,
  HeroId,
  PickupSpriteId,
  ProjectileSpriteId,
  SynergyId,
} from './data/types';
import type {
  BossPhaseState,
  GameState,
  LevelUpChoice,
  PendingChoiceSource,
  PersonalUpgradePayload,
  PlayerId,
  RoomPaceMode,
  UpgradeChoiceIndex,
} from './sim/types';

// ============================================================================
// PROTOCOL CONSTANTS & OPCODES
// ============================================================================

export const PROTOCOL_VERSION = 2;
export const SERVER_TICK_RATE = 20;
export const SERVER_FIXED_DT = 1 / SERVER_TICK_RATE;
export const MAX_ROOM_PLAYERS = 4;
export const MAX_ROOM_ENEMIES = 350;
export const ROOM_CODE_LENGTH = 4;
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Binary frame opcodes (byte 0 of every WebSocket binary message). */
export const BinaryOpcode = {
  // Server -> Client
  SNAPSHOT: 0x01,
  PERSONAL_XP: 0x02,
  EVENTS: 0x03,
  // Client -> Server
  INPUT: 0x10,
  PICK_UPGRADE: 0x11,
} as const;

export type BinaryOpcodeValue = (typeof BinaryOpcode)[keyof typeof BinaryOpcode];

/** Compact bitmask packed into each wire player's `stateFlags (u8)` byte. */
export const WirePlayerFlag = {
  NONE: 0,
  ALIVE: 1 << 0,
  DOWNED: 1 << 1,
  UPGRADING: 1 << 2,
  INVULN: 1 << 3,
  REVIVING_ALLY: 1 << 4,
  BEING_REVIVED: 1 << 5,
  FACING_LEFT: 1 << 6,
  DISCONNECTED: 1 << 7,
} as const;

/** High-nibble flags packed into each wire enemy's `type (u8)` byte (low nibble = type code 0..15). */
export const WireEnemyFlag = {
  TYPE_MASK: 0x0f,
  ELITE: 1 << 4,
  CHILLED: 1 << 5,
  TAUNTED: 1 << 6,
  FACING_LEFT: 1 << 7,
} as const;

/** Snapshot header flags byte. */
export const SnapshotHeaderFlag = {
  NONE: 0,
  HAS_BOSS: 1 << 0,
  COOP_PACE: 1 << 1,
  STATE_SHIFT: 2,
  STATE_MASK: 0b0001_1100,
} as const;

/** Client INPUT flags byte. */
export const ClientInputFlag = {
  NONE: 0,
  MANUAL_AIM: 1 << 0,
} as const;

/** Binary combat event sub-opcodes inside a `BinaryOpcode.EVENTS` batch frame. */
export const BinaryEventType = {
  ABILITY_FIRED: 1,
  DAMAGE_NUMBER: 2,
  ENEMY_KILLED: 3,
  BOSS_TELEGRAPH: 4,
  PLAYER_DOWNED: 5,
  PLAYER_REVIVED: 6,
  BOSS_HAZARD: 7,
  PROJECTILE_SPAWNED: 8,
  PROJECTILE_MOVED: 9,
  PROJECTILE_DESPAWNED: 10,
} as const;

export const DamageNumberFlag = {
  NONE: 0,
  CRIT: 1 << 0,
  SHATTERED: 1 << 1,
  SILENT: 1 << 2,
  PLAYER_ID_SHIFT: 4,
  PLAYER_ID_MASK: 0xf0,
} as const;

export const AbilityFiredFlag = {
  NONE: 0,
  SYNERGY: 1 << 0,
  DOUBLE_CAST: 1 << 1,
} as const;

// Fixed-point scaling constants for compact integer wire encoding
const ANGLE_SCALE = 10000; // [-PI, PI] -> [-31416, 31416], fits in i16
const INPUT_AXIS_SCALE = 10000; // [-1, 1] -> [-10000, 10000], fits in i16
const I16_MIN = -32768;
const I16_MAX = 32767;
const U16_MAX = 65535;
const U8_MAX = 255;

// Byte sizes for fixed-width records
export const SNAPSHOT_HEADER_BYTES = 26;
export const SNAPSHOT_BOSS_BYTES = 16;
export const SNAPSHOT_PLAYER_BYTES = 12;
export const SNAPSHOT_ENEMY_BYTES = 8;
export const SNAPSHOT_PICKUP_BYTES = 7;
export const PERSONAL_XP_PACKET_BYTES = 7;
export const CLIENT_INPUT_PACKET_BYTES = 10;
export const PICK_UPGRADE_PACKET_BYTES = 2;

// Byte offsets inside SNAPSHOT header for zero-reencode per-client XP patching
const SNAPSHOT_SELF_PLAYER_ID_OFFSET = 15;
const SNAPSHOT_SELF_XP_OFFSET = 16;
const SNAPSHOT_SELF_XP_TO_NEXT_OFFSET = 18;
const SNAPSHOT_SELF_PENDING_OFFSET = 20;

// ============================================================================
// DETERMINISTIC ENUM <-> U8 LOOKUP TABLES
// ============================================================================

export const HERO_IDS: readonly HeroId[] = ['mage', 'ranger', 'knight', 'alchemist'] as const;

export function encodeClassId(heroId: HeroId): number {
  const idx = HERO_IDS.indexOf(heroId);
  return idx >= 0 ? idx : 0;
}

export function decodeClassId(code: number): HeroId {
  return HERO_IDS[code] ?? 'mage';
}

export type WireEnemyTypeName = EnemySpriteId | BossId;

export const ENEMY_TYPES: readonly WireEnemyTypeName[] = [
  'slime',
  'golem',
  'wisp',
  'minislime',
  'king_mochi',
  'lady_wisteria',
  'aegis',
  'twin_macaron_mint',
  'twin_macaron_rose',
  'countess_tiramisu',
] as const;

export const BOSS_IDS: readonly BossId[] = [
  'king_mochi',
  'lady_wisteria',
  'aegis',
  'twin_macaron_mint',
  'twin_macaron_rose',
  'countess_tiramisu',
] as const;

export function encodeEnemyType(type: WireEnemyTypeName): number {
  const idx = ENEMY_TYPES.indexOf(type);
  return idx >= 0 ? idx : 0;
}

export function decodeEnemyType(code: number): WireEnemyTypeName {
  return ENEMY_TYPES[code & WireEnemyFlag.TYPE_MASK] ?? 'slime';
}

export function encodeBossId(bossId: BossId): number {
  const idx = BOSS_IDS.indexOf(bossId);
  return idx >= 0 ? idx : 0;
}

export function decodeBossId(code: number): BossId {
  return BOSS_IDS[code] ?? 'king_mochi';
}

export const BOSS_PHASES: readonly BossPhaseState[] = [
  'chase',
  'telegraph',
  'execute',
  'recover',
] as const;

export function encodeBossPhase(phase: BossPhaseState): number {
  const idx = BOSS_PHASES.indexOf(phase);
  return idx >= 0 ? idx : 0;
}

export function decodeBossPhase(code: number): BossPhaseState {
  return BOSS_PHASES[code & 0x03] ?? 'chase';
}

export const BOSS_ATTACK_IDS: readonly string[] = [
  'mochi_leap_slam',
  'mochi_syrup_burst',
  'mochi_summon_adds',
  'wisteria_petal_spiral',
  'wisteria_bloom_beam',
  'wisteria_blink_dash',
  'aegis_lance_charge',
  'aegis_prism_cross',
  'aegis_bastion_nova',
  'macaron_mint_slam',
  'macaron_mint_dash',
  'macaron_rose_spiral',
  'macaron_tether_surge',
  'tiramisu_arena_ring',
  'tiramisu_meteor_marks',
  'tiramisu_cone_volley',
] as const;

export function encodeBossAttackId(attackId: string | null | undefined): number {
  if (!attackId) return 0;
  const idx = BOSS_ATTACK_IDS.indexOf(attackId);
  return idx >= 0 ? idx + 1 : 0;
}

export function decodeBossAttackId(code: number): string | null {
  if (code <= 0) return null;
  return BOSS_ATTACK_IDS[code - 1] ?? null;
}

export const PICKUP_KINDS: readonly PickupSpriteId[] = [
  'xp_small',
  'xp_medium',
  'xp_large',
  'heart',
  'magnet',
  'chest',
] as const;

export function encodePickupKind(kind: PickupSpriteId): number {
  const idx = PICKUP_KINDS.indexOf(kind);
  return idx >= 0 ? idx : 0;
}

export function decodePickupKind(code: number): PickupSpriteId {
  return PICKUP_KINDS[code] ?? 'xp_small';
}

export const GAME_STATES: readonly GameState[] = [
  'menu',
  'playing',
  'paused',
  'levelup',
  'artifact',
  'gameover',
] as const;

export function encodeGameState(state: GameState): number {
  const idx = GAME_STATES.indexOf(state);
  return idx >= 0 ? idx : 0;
}

export function decodeGameState(code: number): GameState {
  return GAME_STATES[code] ?? 'playing';
}

export const ABILITY_AND_SYNERGY_IDS: readonly (AbilityId | SynergyId)[] = [
  // Mage abilities (0..9)
  'fireball',
  'wind_blade',
  'ice_shard',
  'frost_nova',
  'chain_lightning',
  'plasma_beam',
  'arcane_orb',
  'shadow_bolt',
  'earth_spike',
  'meteor_rain',
  // Ranger abilities (10..19)
  'twin_pistols',
  'homing_arrow',
  'magic_longbow',
  'piercing_rail_bow',
  'shotgun_blast',
  'explosive_crossbow',
  'ricochet_revolver',
  'frost_quiver',
  'gatling_turret',
  'rain_of_arrows',
  // Knight abilities (20..29)
  'greatsword_cleave',
  'orbiting_blades',
  'shield_bash',
  'shockwave_stomp',
  'spinning_axe',
  'chain_flail',
  'ground_slam',
  'holy_hammer',
  'spear_thrust',
  'blade_dash',
  // Mage synergies (30..34)
  'firestorm',
  'absolute_zero',
  'tempest_lance',
  'eclipse_singularity',
  'cataclysm',
  // Ranger synergies (35..39)
  'smart_bullets',
  'starlight_railgun',
  'cluster_cannon',
  'glacial_ricochet',
  'artillery_barrage',
  // Knight synergies (40..44)
  'whirlwind_tempest',
  'bastion_quake',
  'reapers_pendulum',
  'divine_judgment',
  'valkyrie_blitz',
  // Alchemist abilities (45..54)
  'healing_mist',
  'acid_flask',
  'haste_aura',
  'protective_ward',
  'venom_nova',
  'frost_tonic',
  'bouncing_vial',
  'revive_totem',
  'gravity_potion',
  'starlight_elixir',
  // Alchemist synergies (55..59)
  'sanctuary_choir',
  'caustic_singularity',
  'aegis_lantern',
  'plague_glacier',
  'celestial_panacea',
] as const;

const ABILITY_TO_CODE = new Map<string, number>(
  ABILITY_AND_SYNERGY_IDS.map((id, i) => [id, i])
);

export function encodeAbilityId(id: AbilityId | SynergyId): number {
  return ABILITY_TO_CODE.get(id) ?? 0;
}

export function decodeAbilityId(code: number): AbilityId | SynergyId {
  return ABILITY_AND_SYNERGY_IDS[code] ?? 'fireball';
}

export const PROJECTILE_SPRITE_IDS: readonly ProjectileSpriteId[] = [
  'fireball',
  'ice',
  'lightning',
  'arcane',
  'shadow',
  'bullet',
  'arrow',
  'axe',
  'hammer',
  'spear',
  'vial',
  'enemy_orb',
] as const;

export function encodeProjectileSprite(spriteId: ProjectileSpriteId | undefined): number {
  if (!spriteId) return 0;
  const idx = PROJECTILE_SPRITE_IDS.indexOf(spriteId);
  return idx >= 0 ? idx + 1 : 0;
}

export function decodeProjectileSprite(code: number): ProjectileSpriteId | undefined {
  if (code <= 0) return undefined;
  return PROJECTILE_SPRITE_IDS[code - 1];
}

// ============================================================================
// WIRE TYPES (BINARY SNAPSHOTS & EVENTS)
// ============================================================================

export interface WirePlayerState {
  /** Compact numeric player slot id (`1..4`). */
  id: number;
  x: number;
  y: number;
  aimAngle: number;
  /** `0..100` percentage. */
  hpPct: number;
  /** `1..255`. */
  level: number;
  /** Bitmask of `WirePlayerFlag`. */
  stateFlags: number;
  classId: HeroId;
  /** `0..100` revive progress percentage. */
  revivePct: number;
}

export interface WireEnemyState {
  id: number;
  x: number;
  y: number;
  type: WireEnemyTypeName;
  /** High-nibble flags (`WireEnemyFlag.ELITE | CHILLED | TAUNTED | FACING_LEFT`). */
  flags: number;
  /** `0..100` percentage. */
  hpPct: number;
}

export interface WireBossState {
  enemyId: number;
  bossId: BossId;
  phase: BossPhaseState;
  enraged: boolean;
  attackId: string | null;
  hpPct: number;
  /** `0..100` telegraph fill percentage. */
  telegraphPct: number;
  cycle: number;
  encounterIndex: number;
  targetX: number;
  targetY: number;
  radius: number;
  baseAngle: number;
}

export interface WirePickupState {
  id: number;
  kind: PickupSpriteId;
  x: number;
  y: number;
}

export interface WireSnapshot {
  tick: number;
  elapsedMs: number;
  kills: number;
  bossesDefeated: number;
  nextBossSec: number;
  paceMode: RoomPaceMode;
  state: GameState;
  /** Personal XP sync for the receiving player. */
  selfPlayerId: number;
  selfXp: number;
  selfXpToNext: number;
  selfPendingUpgrades: number;
  boss: WireBossState | null;
  players: WirePlayerState[];
  enemies: WireEnemyState[];
  pickups: WirePickupState[];
}

export interface WirePersonalXpPacket {
  playerId: number;
  level: number;
  xp: number;
  xpToNext: number;
}

export interface WireClientInput {
  /** Normalized movement X in `[-1, 1]`. */
  dx: number;
  /** Normalized movement Y in `[-1, 1]`. */
  dy: number;
  /** Aim angle in radians (`[-PI, PI]`). */
  aimAngle: number;
  /** When true, server uses `aimAngle` as manual aim; when false, auto-aim follows movement/targets. */
  manualAim: boolean;
  /** Monotonically increasing client input sequence (`u16`). */
  seq: number;
}

export interface WirePickUpgrade {
  choiceIndex: UpgradeChoiceIndex;
}

// ============================================================================
// COMPACT GAMEPLAY EVENTS (BINARY COMBAT EVENTS + JSON UI/LIFECYCLE EVENTS)
// ============================================================================

export type BinaryCombatEvent =
  | {
      type: 'AbilityFired';
      playerId: number;
      abilityId: AbilityId | SynergyId;
      isSynergy: boolean;
      isDoubleCast: boolean;
      x: number;
      y: number;
      aimAngle: number;
    }
  | {
      type: 'DamageNumber';
      enemyId: number;
      /** Attacking player slot ID (`1..4`), or `0` if unattributed. */
      playerId?: number;
      x: number;
      y: number;
      amount: number;
      isCrit: boolean;
      shattered: boolean;
      silent: boolean;
    }
  | {
      type: 'EnemyKilled';
      enemyId: number;
      enemyType: WireEnemyTypeName;
      isBoss: boolean;
      x: number;
      y: number;
    }
  | {
      type: 'BossTelegraph';
      enemyId: number;
      bossId: BossId;
      attackId: string;
      x: number;
      y: number;
      targetX: number;
      targetY: number;
      telegraphMs: number;
    }
  | {
      type: 'PlayerDowned';
      playerId: number;
      x: number;
      y: number;
    }
  | {
      type: 'PlayerRevived';
      playerId: number;
      reason: 'circle' | 'boss_kill';
      hpPct: number;
      x: number;
      y: number;
      /** Bitmask of reviving player slot IDs (`1 << (slotId - 1)`). */
      reviverMask: number;
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
      type: 'ProjectileSpawned';
      netId: number;
      /** Player slot ID (`1..4`), or `0` for enemy/boss projectiles. */
      playerId: number;
      sourceId: AbilityId | SynergyId;
      spriteId?: ProjectileSpriteId;
      x: number;
      y: number;
      vx: number;
      vy: number;
      radius: number;
      scale: number;
      spinSpeed: number;
      lifeMs: number;
    }
  | {
      type: 'ProjectileMoved';
      netId: number;
      x: number;
      y: number;
      vx: number;
      vy: number;
    }
  | {
      type: 'ProjectileDespawned';
      netId: number;
      x: number;
      y: number;
    };

export interface MatchSummaryPlayer {
  playerId: PlayerId;
  slotId: number;
  name: string;
  heroId: HeroId;
  level: number;
}

export type ServerRichEventMessage =
  | {
      type: 'UpgradeChoices';
      playerId: PlayerId;
      slotId: number;
      batchId: number;
      source: PendingChoiceSource;
      choices: LevelUpChoice[];
      pendingQueueCount: number;
    }
  | {
      type: 'UpgradeApplied';
      playerId: PlayerId;
      slotId: number;
      choiceIndex: UpgradeChoiceIndex;
      kind: LevelUpChoice['kind'];
      title: string;
      shortTitle: string;
      abilityId?: AbilityId;
      synergyId?: SynergyId;
      artifactId?: string;
      nextLevel?: number;
      remainingQueueCount: number;
    }
  | {
      type: 'GameOver';
      elapsedRunSec: number;
      kills: number;
      bossesDefeated: number;
      players: MatchSummaryPlayer[];
    }
  | {
      type: 'Victory';
      elapsedRunSec: number;
      kills: number;
      bossesDefeated: number;
      players: MatchSummaryPlayer[];
    };

export type NetGameEvent = BinaryCombatEvent | ServerRichEventMessage;

// ============================================================================
// JSON CONTROL MESSAGES (LOBBY, RECONNECT, HEARTBEAT)
// ============================================================================

export type RoomStatus = 'lobby' | 'playing' | 'gameover' | 'victory';

export interface LobbyPlayerInfo {
  playerId: PlayerId;
  slotId: number;
  name: string;
  heroId: HeroId;
  ready: boolean;
  isHost: boolean;
  connected: boolean;
}

export interface RoomStatePayload {
  roomCode: string;
  status: RoomStatus;
  hostPlayerId: PlayerId;
  paceMode: RoomPaceMode;
  maxPlayers: number;
  players: LobbyPlayerInfo[];
}

export type ClientControlMessage =
  | { type: 'CREATE_ROOM'; heroId?: HeroId; paceMode?: RoomPaceMode; name?: string }
  | { type: 'JOIN_ROOM'; roomCode: string; heroId?: HeroId; name?: string }
  | { type: 'SELECT_CLASS'; heroId: HeroId }
  | { type: 'TOGGLE_READY'; ready?: boolean }
  | { type: 'SET_PACE'; paceMode: RoomPaceMode }
  | { type: 'START_MATCH' }
  | { type: 'RECONNECT'; roomCode: string; reconnectToken: string }
  | { type: 'PING'; ts?: number }
  | { type: 'PONG'; ts?: number };

export type ServerControlMessage =
  | {
      type: 'ROOM_JOINED';
      roomCode: string;
      playerId: PlayerId;
      slotId: number;
      reconnectToken: string;
      isHost: boolean;
      roomState: RoomStatePayload;
      protocolVersion?: number;
    }
  | {
      type: 'ROOM_STATE';
      roomState: RoomStatePayload;
    }
  | {
      type: 'MATCH_STARTED';
      roomCode: string;
      paceMode: RoomPaceMode;
      tickRate: number;
      roomState: RoomStatePayload;
    }
  | {
      type: 'RECONNECTED';
      roomCode: string;
      playerId: PlayerId;
      slotId: number;
      reconnectToken: string;
      isHost: boolean;
      roomState: RoomStatePayload;
      personalUpgrade: PersonalUpgradePayload | null;
    }
  | {
      type: 'PLAYER_DISCONNECTED';
      playerId: PlayerId;
      slotId: number;
      gracePeriodSec: number;
    }
  | {
      type: 'PLAYER_RECONNECTED';
      playerId: PlayerId;
      slotId: number;
    }
  | {
      type: 'PLAYER_LEFT';
      playerId: PlayerId;
      slotId: number;
      newHostPlayerId?: PlayerId;
    }
  | {
      type: 'ERROR';
      code: string;
      message: string;
    }
  | {
      type: 'PING';
      ts: number;
    }
  | {
      type: 'PONG';
      ts?: number;
      serverTime: number;
    }
  | ServerRichEventMessage;

// ============================================================================
// NUMERIC CLAMPING & FIXED-POINT HELPERS
// ============================================================================

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  const rounded = Math.round(value);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function clampI16(value: number): number {
  return clampInt(value, I16_MIN, I16_MAX);
}

function clampU16(value: number): number {
  return clampInt(value, 0, U16_MAX);
}

function clampU8(value: number): number {
  return clampInt(value, 0, U8_MAX);
}

function clampPct(value: number): number {
  return clampInt(value, 0, 100);
}

function normalizeAngleRad(rad: number): number {
  if (!Number.isFinite(rad)) return 0;
  let a = rad % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function encodeAngleI16(rad: number): number {
  return clampI16(normalizeAngleRad(rad) * ANGLE_SCALE);
}

function decodeAngleI16(raw: number): number {
  return raw / ANGLE_SCALE;
}

function toDataView(input: ArrayBuffer | Uint8Array): DataView {
  if (input instanceof Uint8Array) {
    return new DataView(input.buffer, input.byteOffset, input.byteLength);
  }
  return new DataView(input);
}

// ============================================================================
// BINARY SNAPSHOT ENCODER / DECODER (SERVER -> CLIENT, 20 HZ)
// ============================================================================

export function calculateSnapshotByteLength(
  playerCount: number,
  enemyCount: number,
  pickupCount: number,
  hasBoss: boolean
): number {
  return (
    SNAPSHOT_HEADER_BYTES +
    (hasBoss ? SNAPSHOT_BOSS_BYTES : 0) +
    playerCount * SNAPSHOT_PLAYER_BYTES +
    enemyCount * SNAPSHOT_ENEMY_BYTES +
    pickupCount * SNAPSHOT_PICKUP_BYTES
  );
}

/**
 * Encodes a `WireSnapshot` into compact binary form (`BinaryOpcode.SNAPSHOT`).
 * Pass a preallocated `targetBuffer` to avoid per-tick allocations on the server.
 */
export function encodeSnapshot(
  snapshot: WireSnapshot,
  targetBuffer?: ArrayBuffer
): Uint8Array {
  const playerCount = Math.min(snapshot.players.length, MAX_ROOM_PLAYERS);
  const enemyCount = Math.min(snapshot.enemies.length, MAX_ROOM_ENEMIES);
  const pickupCount = Math.min(snapshot.pickups.length, U16_MAX);
  const hasBoss = snapshot.boss !== null;

  const totalBytes = calculateSnapshotByteLength(
    playerCount,
    enemyCount,
    pickupCount,
    hasBoss
  );

  const buffer =
    targetBuffer && targetBuffer.byteLength >= totalBytes
      ? targetBuffer
      : new ArrayBuffer(totalBytes);
  const view = new DataView(buffer, 0, totalBytes);

  let offset = 0;
  view.setUint8(offset, BinaryOpcode.SNAPSHOT);
  offset += 1;
  view.setUint32(offset, snapshot.tick >>> 0, true);
  offset += 4;
  view.setUint32(offset, Math.max(0, Math.round(snapshot.elapsedMs)) >>> 0, true);
  offset += 4;
  view.setUint16(offset, clampU16(snapshot.kills), true);
  offset += 2;
  view.setUint8(offset, clampU8(snapshot.bossesDefeated));
  offset += 1;
  view.setUint16(offset, clampU16(snapshot.nextBossSec), true);
  offset += 2;

  let headerFlags = 0;
  if (hasBoss) headerFlags |= SnapshotHeaderFlag.HAS_BOSS;
  if (snapshot.paceMode === 'coop_pace') headerFlags |= SnapshotHeaderFlag.COOP_PACE;
  headerFlags |= (encodeGameState(snapshot.state) << SnapshotHeaderFlag.STATE_SHIFT) & SnapshotHeaderFlag.STATE_MASK;
  view.setUint8(offset, headerFlags);
  offset += 1;

  // Per-client personal XP fields (offsets 15..20)
  view.setUint8(offset, clampU8(snapshot.selfPlayerId));
  offset += 1;
  view.setUint16(offset, clampU16(snapshot.selfXp), true);
  offset += 2;
  view.setUint16(offset, clampU16(snapshot.selfXpToNext), true);
  offset += 2;
  view.setUint8(offset, clampU8(snapshot.selfPendingUpgrades));
  offset += 1;

  // Entity counts (offsets 21..25)
  view.setUint8(offset, playerCount);
  offset += 1;
  view.setUint16(offset, enemyCount, true);
  offset += 2;
  view.setUint16(offset, pickupCount, true);
  offset += 2;

  // Optional compact Boss phase/telegraph block (16 bytes)
  if (snapshot.boss) {
    const b = snapshot.boss;
    view.setUint16(offset, clampU16(b.enemyId), true);
    offset += 2;
    view.setUint8(offset, encodeBossId(b.bossId));
    offset += 1;
    const attackCode = encodeBossAttackId(b.attackId) & 0x1f;
    const phaseMeta =
      (encodeBossPhase(b.phase) & 0x03) |
      (b.enraged ? 0x04 : 0) |
      (attackCode << 3);
    view.setUint8(offset, phaseMeta);
    offset += 1;
    view.setUint8(offset, clampPct(b.hpPct));
    offset += 1;
    view.setUint8(offset, clampPct(b.telegraphPct));
    offset += 1;
    view.setUint8(offset, clampU8(b.cycle));
    offset += 1;
    view.setUint8(offset, clampU8(b.encounterIndex));
    offset += 1;
    view.setInt16(offset, clampI16(b.targetX), true);
    offset += 2;
    view.setInt16(offset, clampI16(b.targetY), true);
    offset += 2;
    view.setUint16(offset, clampU16(b.radius), true);
    offset += 2;
    view.setInt16(offset, encodeAngleI16(b.baseAngle), true);
    offset += 2;
  }

  // Players (12 bytes each)
  for (let i = 0; i < playerCount; i++) {
    const p = snapshot.players[i];
    view.setUint8(offset, clampU8(p.id));
    offset += 1;
    view.setInt16(offset, clampI16(p.x), true);
    offset += 2;
    view.setInt16(offset, clampI16(p.y), true);
    offset += 2;
    view.setInt16(offset, encodeAngleI16(p.aimAngle), true);
    offset += 2;
    view.setUint8(offset, clampPct(p.hpPct));
    offset += 1;
    view.setUint8(offset, clampU8(p.level));
    offset += 1;
    view.setUint8(offset, p.stateFlags & 0xff);
    offset += 1;
    view.setUint8(offset, encodeClassId(p.classId));
    offset += 1;
    view.setUint8(offset, clampPct(p.revivePct));
    offset += 1;
  }

  // Enemies & Bosses (strictly 8 bytes each)
  for (let i = 0; i < enemyCount; i++) {
    const e = snapshot.enemies[i];
    view.setUint16(offset, clampU16(e.id), true);
    offset += 2;
    view.setInt16(offset, clampI16(e.x), true);
    offset += 2;
    view.setInt16(offset, clampI16(e.y), true);
    offset += 2;
    const typeByte = (encodeEnemyType(e.type) & WireEnemyFlag.TYPE_MASK) | (e.flags & 0xf0);
    view.setUint8(offset, typeByte);
    offset += 1;
    view.setUint8(offset, clampPct(e.hpPct));
    offset += 1;
  }

  // Pickups: XP Gems, Hearts, Magnets, Boss Chests (7 bytes each)
  for (let i = 0; i < pickupCount; i++) {
    const item = snapshot.pickups[i];
    view.setUint16(offset, clampU16(item.id), true);
    offset += 2;
    view.setUint8(offset, encodePickupKind(item.kind));
    offset += 1;
    view.setInt16(offset, clampI16(item.x), true);
    offset += 2;
    view.setInt16(offset, clampI16(item.y), true);
    offset += 2;
  }

  return new Uint8Array(buffer, 0, totalBytes);
}

/**
 * Patches the 6 personal XP header bytes inside an already-encoded snapshot
 * so the server encodes the shared world once per tick and customizes personal
 * XP per connected client in O(1).
 */
export function patchSnapshotPersonalXp(
  encodedSnapshot: Uint8Array,
  selfPlayerId: number,
  selfXp: number,
  selfXpToNext: number,
  selfPendingUpgrades: number
): void {
  if (encodedSnapshot.byteLength < SNAPSHOT_HEADER_BYTES) return;
  const view = toDataView(encodedSnapshot);
  view.setUint8(SNAPSHOT_SELF_PLAYER_ID_OFFSET, clampU8(selfPlayerId));
  view.setUint16(SNAPSHOT_SELF_XP_OFFSET, clampU16(selfXp), true);
  view.setUint16(SNAPSHOT_SELF_XP_TO_NEXT_OFFSET, clampU16(selfXpToNext), true);
  view.setUint8(SNAPSHOT_SELF_PENDING_OFFSET, clampU8(selfPendingUpgrades));
}

export function decodeSnapshot(input: ArrayBuffer | Uint8Array): WireSnapshot {
  const view = toDataView(input);
  if (view.byteLength < SNAPSHOT_HEADER_BYTES) {
    throw new Error(`Snapshot buffer too small: ${view.byteLength} bytes`);
  }
  const opcode = view.getUint8(0);
  if (opcode !== BinaryOpcode.SNAPSHOT) {
    throw new Error(`Unexpected opcode for snapshot: 0x${opcode.toString(16)}`);
  }

  let offset = 1;
  const tick = view.getUint32(offset, true);
  offset += 4;
  const elapsedMs = view.getUint32(offset, true);
  offset += 4;
  const kills = view.getUint16(offset, true);
  offset += 2;
  const bossesDefeated = view.getUint8(offset);
  offset += 1;
  const nextBossSec = view.getUint16(offset, true);
  offset += 2;

  const headerFlags = view.getUint8(offset);
  offset += 1;
  const hasBoss = (headerFlags & SnapshotHeaderFlag.HAS_BOSS) !== 0;
  const paceMode: RoomPaceMode =
    (headerFlags & SnapshotHeaderFlag.COOP_PACE) !== 0 ? 'coop_pace' : 'standard';
  const state = decodeGameState(
    (headerFlags & SnapshotHeaderFlag.STATE_MASK) >> SnapshotHeaderFlag.STATE_SHIFT
  );

  const selfPlayerId = view.getUint8(offset);
  offset += 1;
  const selfXp = view.getUint16(offset, true);
  offset += 2;
  const selfXpToNext = view.getUint16(offset, true);
  offset += 2;
  const selfPendingUpgrades = view.getUint8(offset);
  offset += 1;

  const playerCount = view.getUint8(offset);
  offset += 1;
  const enemyCount = view.getUint16(offset, true);
  offset += 2;
  const pickupCount = view.getUint16(offset, true);
  offset += 2;

  const expectedBytes = calculateSnapshotByteLength(
    playerCount,
    enemyCount,
    pickupCount,
    hasBoss
  );
  if (view.byteLength < expectedBytes) {
    throw new Error(
      `Truncated snapshot: expected ${expectedBytes} bytes, got ${view.byteLength}`
    );
  }

  let boss: WireBossState | null = null;
  if (hasBoss) {
    const enemyId = view.getUint16(offset, true);
    offset += 2;
    const bossId = decodeBossId(view.getUint8(offset));
    offset += 1;
    const phaseMeta = view.getUint8(offset);
    offset += 1;
    const phase = decodeBossPhase(phaseMeta & 0x03);
    const enraged = (phaseMeta & 0x04) !== 0;
    const attackId = decodeBossAttackId((phaseMeta >> 3) & 0x1f);
    const hpPct = view.getUint8(offset);
    offset += 1;
    const telegraphPct = view.getUint8(offset);
    offset += 1;
    const cycle = view.getUint8(offset);
    offset += 1;
    const encounterIndex = view.getUint8(offset);
    offset += 1;
    const targetX = view.getInt16(offset, true);
    offset += 2;
    const targetY = view.getInt16(offset, true);
    offset += 2;
    const radius = view.getUint16(offset, true);
    offset += 2;
    const baseAngle = decodeAngleI16(view.getInt16(offset, true));
    offset += 2;

    boss = {
      enemyId,
      bossId,
      phase,
      enraged,
      attackId,
      hpPct,
      telegraphPct,
      cycle,
      encounterIndex,
      targetX,
      targetY,
      radius,
      baseAngle,
    };
  }

  const players: WirePlayerState[] = new Array(playerCount);
  for (let i = 0; i < playerCount; i++) {
    const id = view.getUint8(offset);
    offset += 1;
    const x = view.getInt16(offset, true);
    offset += 2;
    const y = view.getInt16(offset, true);
    offset += 2;
    const aimAngle = decodeAngleI16(view.getInt16(offset, true));
    offset += 2;
    const hpPct = view.getUint8(offset);
    offset += 1;
    const level = view.getUint8(offset);
    offset += 1;
    const stateFlags = view.getUint8(offset);
    offset += 1;
    const classId = decodeClassId(view.getUint8(offset));
    offset += 1;
    const revivePct = view.getUint8(offset);
    offset += 1;

    players[i] = {
      id,
      x,
      y,
      aimAngle,
      hpPct,
      level,
      stateFlags,
      classId,
      revivePct,
    };
  }

  const enemies: WireEnemyState[] = new Array(enemyCount);
  for (let i = 0; i < enemyCount; i++) {
    const id = view.getUint16(offset, true);
    offset += 2;
    const x = view.getInt16(offset, true);
    offset += 2;
    const y = view.getInt16(offset, true);
    offset += 2;
    const typeByte = view.getUint8(offset);
    offset += 1;
    const hpPct = view.getUint8(offset);
    offset += 1;

    enemies[i] = {
      id,
      x,
      y,
      type: decodeEnemyType(typeByte),
      flags: typeByte & 0xf0,
      hpPct,
    };
  }

  const pickups: WirePickupState[] = new Array(pickupCount);
  for (let i = 0; i < pickupCount; i++) {
    const id = view.getUint16(offset, true);
    offset += 2;
    const kind = decodePickupKind(view.getUint8(offset));
    offset += 1;
    const x = view.getInt16(offset, true);
    offset += 2;
    const y = view.getInt16(offset, true);
    offset += 2;

    pickups[i] = { id, kind, x, y };
  }

  return {
    tick,
    elapsedMs,
    kills,
    bossesDefeated,
    nextBossSec,
    paceMode,
    state,
    selfPlayerId,
    selfXp,
    selfXpToNext,
    selfPendingUpgrades,
    boss,
    players,
    enemies,
    pickups,
  };
}

// ============================================================================
// STANDALONE PERSONAL XP PACKET (SERVER -> CLIENT, 7 BYTES)
// ============================================================================

export function encodePersonalXp(
  packet: WirePersonalXpPacket,
  targetBuffer?: ArrayBuffer
): Uint8Array {
  const buffer =
    targetBuffer && targetBuffer.byteLength >= PERSONAL_XP_PACKET_BYTES
      ? targetBuffer
      : new ArrayBuffer(PERSONAL_XP_PACKET_BYTES);
  const view = new DataView(buffer, 0, PERSONAL_XP_PACKET_BYTES);
  view.setUint8(0, BinaryOpcode.PERSONAL_XP);
  view.setUint8(1, clampU8(packet.playerId));
  view.setUint8(2, clampU8(packet.level));
  view.setUint16(3, clampU16(packet.xp), true);
  view.setUint16(5, clampU16(packet.xpToNext), true);
  return new Uint8Array(buffer, 0, PERSONAL_XP_PACKET_BYTES);
}

export function decodePersonalXp(input: ArrayBuffer | Uint8Array): WirePersonalXpPacket {
  const view = toDataView(input);
  if (view.byteLength < PERSONAL_XP_PACKET_BYTES) {
    throw new Error(`PersonalXP packet too small: ${view.byteLength}`);
  }
  if (view.getUint8(0) !== BinaryOpcode.PERSONAL_XP) {
    throw new Error(`Unexpected opcode for PersonalXP: 0x${view.getUint8(0).toString(16)}`);
  }
  return {
    playerId: view.getUint8(1),
    level: view.getUint8(2),
    xp: view.getUint16(3, true),
    xpToNext: view.getUint16(5, true),
  };
}

// ============================================================================
// COMPACT BINARY COMBAT EVENTS BATCH (SERVER -> CLIENT)
// ============================================================================

function getBinaryEventByteSize(ev: BinaryCombatEvent): number {
  switch (ev.type) {
    case 'AbilityFired':
      return 10;
    case 'DamageNumber':
      return 10;
    case 'EnemyKilled':
      return 9;
    case 'BossTelegraph':
      return 15;
    case 'PlayerDowned':
      return 6;
    case 'PlayerRevived':
      return 9;
    case 'BossHazard':
      return 14;
    case 'ProjectileSpawned':
      return 18;
    case 'ProjectileMoved':
      return 11;
    case 'ProjectileDespawned':
      return 7;
  }
}

export function encodeBinaryEvents(
  events: readonly BinaryCombatEvent[],
  targetBuffer?: ArrayBuffer
): Uint8Array {
  const count = Math.min(events.length, U8_MAX);
  let totalBytes = 2; // opcode (u8) + count (u8)
  for (let i = 0; i < count; i++) {
    totalBytes += getBinaryEventByteSize(events[i]);
  }

  const buffer =
    targetBuffer && targetBuffer.byteLength >= totalBytes
      ? targetBuffer
      : new ArrayBuffer(totalBytes);
  const view = new DataView(buffer, 0, totalBytes);

  let offset = 0;
  view.setUint8(offset, BinaryOpcode.EVENTS);
  offset += 1;
  view.setUint8(offset, count);
  offset += 1;

  for (let i = 0; i < count; i++) {
    const ev = events[i];
    switch (ev.type) {
      case 'AbilityFired': {
        view.setUint8(offset, BinaryEventType.ABILITY_FIRED);
        offset += 1;
        view.setUint8(offset, clampU8(ev.playerId));
        offset += 1;
        view.setUint8(offset, encodeAbilityId(ev.abilityId));
        offset += 1;
        let flags = 0;
        if (ev.isSynergy) flags |= AbilityFiredFlag.SYNERGY;
        if (ev.isDoubleCast) flags |= AbilityFiredFlag.DOUBLE_CAST;
        view.setUint8(offset, flags);
        offset += 1;
        view.setInt16(offset, clampI16(ev.x), true);
        offset += 2;
        view.setInt16(offset, clampI16(ev.y), true);
        offset += 2;
        view.setInt16(offset, encodeAngleI16(ev.aimAngle), true);
        offset += 2;
        break;
      }

      case 'DamageNumber': {
        view.setUint8(offset, BinaryEventType.DAMAGE_NUMBER);
        offset += 1;
        view.setUint16(offset, clampU16(ev.enemyId), true);
        offset += 2;
        view.setInt16(offset, clampI16(ev.x), true);
        offset += 2;
        view.setInt16(offset, clampI16(ev.y), true);
        offset += 2;
        view.setUint16(offset, clampU16(ev.amount), true);
        offset += 2;
        let flags = 0;
        if (ev.isCrit) flags |= DamageNumberFlag.CRIT;
        if (ev.shattered) flags |= DamageNumberFlag.SHATTERED;
        if (ev.silent) flags |= DamageNumberFlag.SILENT;
        if (ev.playerId) {
          flags |= (clampU8(ev.playerId) & 0x0f) << DamageNumberFlag.PLAYER_ID_SHIFT;
        }
        view.setUint8(offset, flags);
        offset += 1;
        break;
      }

      case 'EnemyKilled': {
        view.setUint8(offset, BinaryEventType.ENEMY_KILLED);
        offset += 1;
        view.setUint16(offset, clampU16(ev.enemyId), true);
        offset += 2;
        view.setUint8(offset, encodeEnemyType(ev.enemyType));
        offset += 1;
        view.setUint8(offset, ev.isBoss ? 1 : 0);
        offset += 1;
        view.setInt16(offset, clampI16(ev.x), true);
        offset += 2;
        view.setInt16(offset, clampI16(ev.y), true);
        offset += 2;
        break;
      }

      case 'BossTelegraph': {
        view.setUint8(offset, BinaryEventType.BOSS_TELEGRAPH);
        offset += 1;
        view.setUint16(offset, clampU16(ev.enemyId), true);
        offset += 2;
        view.setUint8(offset, encodeBossId(ev.bossId));
        offset += 1;
        view.setUint8(offset, encodeBossAttackId(ev.attackId));
        offset += 1;
        view.setInt16(offset, clampI16(ev.x), true);
        offset += 2;
        view.setInt16(offset, clampI16(ev.y), true);
        offset += 2;
        view.setInt16(offset, clampI16(ev.targetX), true);
        offset += 2;
        view.setInt16(offset, clampI16(ev.targetY), true);
        offset += 2;
        view.setUint16(offset, clampU16(ev.telegraphMs), true);
        offset += 2;
        break;
      }

      case 'PlayerDowned': {
        view.setUint8(offset, BinaryEventType.PLAYER_DOWNED);
        offset += 1;
        view.setUint8(offset, clampU8(ev.playerId));
        offset += 1;
        view.setInt16(offset, clampI16(ev.x), true);
        offset += 2;
        view.setInt16(offset, clampI16(ev.y), true);
        offset += 2;
        break;
      }

      case 'PlayerRevived': {
        view.setUint8(offset, BinaryEventType.PLAYER_REVIVED);
        offset += 1;
        view.setUint8(offset, clampU8(ev.playerId));
        offset += 1;
        view.setUint8(offset, ev.reason === 'boss_kill' ? 1 : 0);
        offset += 1;
        view.setUint8(offset, clampPct(ev.hpPct));
        offset += 1;
        view.setInt16(offset, clampI16(ev.x), true);
        offset += 2;
        view.setInt16(offset, clampI16(ev.y), true);
        offset += 2;
        view.setUint8(offset, ev.reviverMask & 0xff);
        offset += 1;
        break;
      }

      case 'BossHazard': {
        view.setUint8(offset, BinaryEventType.BOSS_HAZARD);
        offset += 1;
        const kindCode =
          ev.hazardKind === 'arena_ring' ? 0 : ev.hazardKind === 'meteor_mark' ? 1 : 2;
        view.setUint8(offset, (kindCode & 0x03) | (ev.active ? 0x04 : 0));
        offset += 1;
        view.setInt16(offset, clampI16(ev.x), true);
        offset += 2;
        view.setInt16(offset, clampI16(ev.y), true);
        offset += 2;
        view.setInt16(offset, clampI16(ev.targetX), true);
        offset += 2;
        view.setInt16(offset, clampI16(ev.targetY), true);
        offset += 2;
        view.setUint16(offset, clampU16(ev.radius), true);
        offset += 2;
        view.setUint16(offset, clampU16(ev.durationMs), true);
        offset += 2;
        break;
      }

      case 'ProjectileSpawned': {
        view.setUint8(offset, BinaryEventType.PROJECTILE_SPAWNED);
        offset += 1;
        view.setUint16(offset, clampU16(ev.netId), true);
        offset += 2;
        view.setUint8(offset, clampU8(ev.playerId));
        offset += 1;
        view.setUint8(offset, encodeAbilityId(ev.sourceId));
        offset += 1;
        view.setUint8(offset, encodeProjectileSprite(ev.spriteId) & 0x0f);
        offset += 1;
        view.setInt16(offset, clampI16(ev.x), true);
        offset += 2;
        view.setInt16(offset, clampI16(ev.y), true);
        offset += 2;
        view.setInt16(offset, clampI16(ev.vx), true);
        offset += 2;
        view.setInt16(offset, clampI16(ev.vy), true);
        offset += 2;
        view.setUint8(offset, clampInt(ev.radius, 1, U8_MAX));
        offset += 1;
        view.setUint8(offset, clampU8(ev.scale * 50));
        offset += 1;
        view.setInt8(offset, clampInt(ev.spinSpeed * 5, -127, 127));
        offset += 1;
        view.setUint8(offset, clampInt(ev.lifeMs / 50, 1, U8_MAX));
        offset += 1;
        break;
      }

      case 'ProjectileMoved': {
        view.setUint8(offset, BinaryEventType.PROJECTILE_MOVED);
        offset += 1;
        view.setUint16(offset, clampU16(ev.netId), true);
        offset += 2;
        view.setInt16(offset, clampI16(ev.x), true);
        offset += 2;
        view.setInt16(offset, clampI16(ev.y), true);
        offset += 2;
        view.setInt16(offset, clampI16(ev.vx), true);
        offset += 2;
        view.setInt16(offset, clampI16(ev.vy), true);
        offset += 2;
        break;
      }

      case 'ProjectileDespawned': {
        view.setUint8(offset, BinaryEventType.PROJECTILE_DESPAWNED);
        offset += 1;
        view.setUint16(offset, clampU16(ev.netId), true);
        offset += 2;
        view.setInt16(offset, clampI16(ev.x), true);
        offset += 2;
        view.setInt16(offset, clampI16(ev.y), true);
        offset += 2;
        break;
      }
    }
  }

  return new Uint8Array(buffer, 0, totalBytes);
}

export function decodeBinaryEvents(input: ArrayBuffer | Uint8Array): BinaryCombatEvent[] {
  const view = toDataView(input);
  if (view.byteLength < 2) {
    throw new Error(`Binary events buffer too small: ${view.byteLength}`);
  }
  if (view.getUint8(0) !== BinaryOpcode.EVENTS) {
    throw new Error(`Unexpected opcode for events: 0x${view.getUint8(0).toString(16)}`);
  }

  const count = view.getUint8(1);
  const out: BinaryCombatEvent[] = [];
  let offset = 2;

  for (let i = 0; i < count; i++) {
    if (offset >= view.byteLength) break;
    const subType = view.getUint8(offset);
    offset += 1;

    switch (subType) {
      case BinaryEventType.ABILITY_FIRED: {
        const playerId = view.getUint8(offset);
        offset += 1;
        const abilityId = decodeAbilityId(view.getUint8(offset));
        offset += 1;
        const flags = view.getUint8(offset);
        offset += 1;
        const x = view.getInt16(offset, true);
        offset += 2;
        const y = view.getInt16(offset, true);
        offset += 2;
        const aimAngle = decodeAngleI16(view.getInt16(offset, true));
        offset += 2;
        out.push({
          type: 'AbilityFired',
          playerId,
          abilityId,
          isSynergy: (flags & AbilityFiredFlag.SYNERGY) !== 0,
          isDoubleCast: (flags & AbilityFiredFlag.DOUBLE_CAST) !== 0,
          x,
          y,
          aimAngle,
        });
        break;
      }

      case BinaryEventType.DAMAGE_NUMBER: {
        const enemyId = view.getUint16(offset, true);
        offset += 2;
        const x = view.getInt16(offset, true);
        offset += 2;
        const y = view.getInt16(offset, true);
        offset += 2;
        const amount = view.getUint16(offset, true);
        offset += 2;
        const flags = view.getUint8(offset);
        offset += 1;
        const playerId = (flags & DamageNumberFlag.PLAYER_ID_MASK) >>> DamageNumberFlag.PLAYER_ID_SHIFT;
        out.push({
          type: 'DamageNumber',
          enemyId,
          playerId,
          x,
          y,
          amount,
          isCrit: (flags & DamageNumberFlag.CRIT) !== 0,
          shattered: (flags & DamageNumberFlag.SHATTERED) !== 0,
          silent: (flags & DamageNumberFlag.SILENT) !== 0,
        });
        break;
      }

      case BinaryEventType.ENEMY_KILLED: {
        const enemyId = view.getUint16(offset, true);
        offset += 2;
        const enemyType = decodeEnemyType(view.getUint8(offset));
        offset += 1;
        const isBoss = view.getUint8(offset) !== 0;
        offset += 1;
        const x = view.getInt16(offset, true);
        offset += 2;
        const y = view.getInt16(offset, true);
        offset += 2;
        out.push({
          type: 'EnemyKilled',
          enemyId,
          enemyType,
          isBoss,
          x,
          y,
        });
        break;
      }

      case BinaryEventType.BOSS_TELEGRAPH: {
        const enemyId = view.getUint16(offset, true);
        offset += 2;
        const bossId = decodeBossId(view.getUint8(offset));
        offset += 1;
        const attackId = decodeBossAttackId(view.getUint8(offset)) ?? '';
        offset += 1;
        const x = view.getInt16(offset, true);
        offset += 2;
        const y = view.getInt16(offset, true);
        offset += 2;
        const targetX = view.getInt16(offset, true);
        offset += 2;
        const targetY = view.getInt16(offset, true);
        offset += 2;
        const telegraphMs = view.getUint16(offset, true);
        offset += 2;
        out.push({
          type: 'BossTelegraph',
          enemyId,
          bossId,
          attackId,
          x,
          y,
          targetX,
          targetY,
          telegraphMs,
        });
        break;
      }

      case BinaryEventType.PLAYER_DOWNED: {
        const playerId = view.getUint8(offset);
        offset += 1;
        const x = view.getInt16(offset, true);
        offset += 2;
        const y = view.getInt16(offset, true);
        offset += 2;
        out.push({ type: 'PlayerDowned', playerId, x, y });
        break;
      }

      case BinaryEventType.PLAYER_REVIVED: {
        const playerId = view.getUint8(offset);
        offset += 1;
        const reason = view.getUint8(offset) === 1 ? 'boss_kill' : 'circle';
        offset += 1;
        const hpPct = view.getUint8(offset);
        offset += 1;
        const x = view.getInt16(offset, true);
        offset += 2;
        const y = view.getInt16(offset, true);
        offset += 2;
        const reviverMask = view.getUint8(offset);
        offset += 1;
        out.push({
          type: 'PlayerRevived',
          playerId,
          reason,
          hpPct,
          x,
          y,
          reviverMask,
        });
        break;
      }

      case BinaryEventType.BOSS_HAZARD: {
        const meta = view.getUint8(offset);
        offset += 1;
        const kindCode = meta & 0x03;
        const hazardKind: 'arena_ring' | 'meteor_mark' | 'tether_beam' =
          kindCode === 0 ? 'arena_ring' : kindCode === 1 ? 'meteor_mark' : 'tether_beam';
        const active = (meta & 0x04) !== 0;
        const x = view.getInt16(offset, true);
        offset += 2;
        const y = view.getInt16(offset, true);
        offset += 2;
        const targetX = view.getInt16(offset, true);
        offset += 2;
        const targetY = view.getInt16(offset, true);
        offset += 2;
        const radius = view.getUint16(offset, true);
        offset += 2;
        const durationMs = view.getUint16(offset, true);
        offset += 2;
        out.push({
          type: 'BossHazard',
          hazardKind,
          x,
          y,
          targetX,
          targetY,
          radius,
          durationMs,
          active,
        });
        break;
      }

      case BinaryEventType.PROJECTILE_SPAWNED: {
        const netId = view.getUint16(offset, true);
        offset += 2;
        const playerId = view.getUint8(offset);
        offset += 1;
        const sourceId = decodeAbilityId(view.getUint8(offset));
        offset += 1;
        const spriteId = decodeProjectileSprite(view.getUint8(offset) & 0x0f);
        offset += 1;
        const x = view.getInt16(offset, true);
        offset += 2;
        const y = view.getInt16(offset, true);
        offset += 2;
        const vx = view.getInt16(offset, true);
        offset += 2;
        const vy = view.getInt16(offset, true);
        offset += 2;
        const radius = view.getUint8(offset);
        offset += 1;
        const scale = view.getUint8(offset) / 50;
        offset += 1;
        const spinSpeed = view.getInt8(offset) / 5;
        offset += 1;
        const lifeMs = view.getUint8(offset) * 50;
        offset += 1;
        out.push({
          type: 'ProjectileSpawned',
          netId,
          playerId,
          sourceId,
          spriteId,
          x,
          y,
          vx,
          vy,
          radius,
          scale,
          spinSpeed,
          lifeMs,
        });
        break;
      }

      case BinaryEventType.PROJECTILE_MOVED: {
        const netId = view.getUint16(offset, true);
        offset += 2;
        const x = view.getInt16(offset, true);
        offset += 2;
        const y = view.getInt16(offset, true);
        offset += 2;
        const vx = view.getInt16(offset, true);
        offset += 2;
        const vy = view.getInt16(offset, true);
        offset += 2;
        out.push({
          type: 'ProjectileMoved',
          netId,
          x,
          y,
          vx,
          vy,
        });
        break;
      }

      case BinaryEventType.PROJECTILE_DESPAWNED: {
        const netId = view.getUint16(offset, true);
        offset += 2;
        const x = view.getInt16(offset, true);
        offset += 2;
        const y = view.getInt16(offset, true);
        offset += 2;
        out.push({
          type: 'ProjectileDespawned',
          netId,
          x,
          y,
        });
        break;
      }

      default:
        throw new Error(`Unknown binary event type: ${subType}`);
    }
  }

  return out;
}

// ============================================================================
// CLIENT -> SERVER BINARY PACKETS (INPUT & PICK_UPGRADE)
// ============================================================================

export function encodeClientInput(
  input: WireClientInput,
  targetBuffer?: ArrayBuffer
): Uint8Array {
  const buffer =
    targetBuffer && targetBuffer.byteLength >= CLIENT_INPUT_PACKET_BYTES
      ? targetBuffer
      : new ArrayBuffer(CLIENT_INPUT_PACKET_BYTES);
  const view = new DataView(buffer, 0, CLIENT_INPUT_PACKET_BYTES);

  const dx = Math.max(-1, Math.min(1, Number.isFinite(input.dx) ? input.dx : 0));
  const dy = Math.max(-1, Math.min(1, Number.isFinite(input.dy) ? input.dy : 0));

  view.setUint8(0, BinaryOpcode.INPUT);
  view.setInt16(1, clampI16(dx * INPUT_AXIS_SCALE), true);
  view.setInt16(3, clampI16(dy * INPUT_AXIS_SCALE), true);
  view.setInt16(5, encodeAngleI16(input.aimAngle), true);
  view.setUint8(7, input.manualAim ? ClientInputFlag.MANUAL_AIM : ClientInputFlag.NONE);
  view.setUint16(8, clampU16(input.seq), true);

  return new Uint8Array(buffer, 0, CLIENT_INPUT_PACKET_BYTES);
}

export function decodeClientInput(input: ArrayBuffer | Uint8Array): WireClientInput {
  const view = toDataView(input);
  if (view.byteLength < CLIENT_INPUT_PACKET_BYTES) {
    throw new Error(`Client INPUT packet too small: ${view.byteLength}`);
  }
  if (view.getUint8(0) !== BinaryOpcode.INPUT) {
    throw new Error(`Unexpected opcode for INPUT: 0x${view.getUint8(0).toString(16)}`);
  }

  const rawDx = view.getInt16(1, true) / INPUT_AXIS_SCALE;
  const rawDy = view.getInt16(3, true) / INPUT_AXIS_SCALE;
  const dx = Math.max(-1, Math.min(1, rawDx));
  const dy = Math.max(-1, Math.min(1, rawDy));
  const aimAngle = decodeAngleI16(view.getInt16(5, true));
  const flags = view.getUint8(7);
  const seq = view.getUint16(8, true);

  return {
    dx,
    dy,
    aimAngle,
    manualAim: (flags & ClientInputFlag.MANUAL_AIM) !== 0,
    seq,
  };
}

export function encodePickUpgrade(
  choiceIndex: UpgradeChoiceIndex,
  targetBuffer?: ArrayBuffer
): Uint8Array {
  const buffer =
    targetBuffer && targetBuffer.byteLength >= PICK_UPGRADE_PACKET_BYTES
      ? targetBuffer
      : new ArrayBuffer(PICK_UPGRADE_PACKET_BYTES);
  const view = new DataView(buffer, 0, PICK_UPGRADE_PACKET_BYTES);
  view.setUint8(0, BinaryOpcode.PICK_UPGRADE);
  view.setUint8(1, choiceIndex & 0x03);
  return new Uint8Array(buffer, 0, PICK_UPGRADE_PACKET_BYTES);
}

export function decodePickUpgrade(input: ArrayBuffer | Uint8Array): WirePickUpgrade {
  const view = toDataView(input);
  if (view.byteLength < PICK_UPGRADE_PACKET_BYTES) {
    throw new Error(`PICK_UPGRADE packet too small: ${view.byteLength}`);
  }
  if (view.getUint8(0) !== BinaryOpcode.PICK_UPGRADE) {
    throw new Error(`Unexpected opcode for PICK_UPGRADE: 0x${view.getUint8(0).toString(16)}`);
  }
  const idx = view.getUint8(1);
  if (idx !== 0 && idx !== 1 && idx !== 2) {
    throw new Error(`Invalid upgrade choice index: ${idx}`);
  }
  return { choiceIndex: idx };
}

export function peekBinaryOpcode(input: ArrayBuffer | Uint8Array): number | null {
  const view = toDataView(input);
  if (view.byteLength < 1) return null;
  return view.getUint8(0);
}

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

export function isValidHeroId(value: unknown): value is HeroId {
  return value === 'mage' || value === 'ranger' || value === 'knight' || value === 'alchemist';
}

export function isValidPaceMode(value: unknown): value is RoomPaceMode {
  return value === 'standard' || value === 'coop_pace';
}

export function normalizeRoomCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().toUpperCase();
  if (cleaned.length !== ROOM_CODE_LENGTH) return null;
  for (let i = 0; i < cleaned.length; i++) {
    if (!ROOM_CODE_ALPHABET.includes(cleaned[i])) return null;
  }
  return cleaned;
}
