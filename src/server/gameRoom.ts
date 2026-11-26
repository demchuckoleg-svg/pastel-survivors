import crypto from 'node:crypto';
import WebSocket from 'ws';
import {
  decodeClientInput,
  encodeBinaryEvents,
  encodeSnapshot,
  MAX_ROOM_ENEMIES,
  MAX_ROOM_PLAYERS,
  patchSnapshotPersonalXp,
  PROTOCOL_VERSION,
  SERVER_FIXED_DT,
  SERVER_TICK_RATE,
  WireEnemyFlag,
  WirePlayerFlag,
  type BinaryCombatEvent,
  type LobbyPlayerInfo,
  type MatchSummaryPlayer,
  type RoomStatePayload,
  type RoomStatus,
  type ServerControlMessage,
  type WireBossState,
  type WireEnemyState,
  type WirePickupState,
  type WirePlayerState,
  type WireSnapshot,
} from '../shared/protocol';
import type { HeroId } from '../shared/data/types';
import type { SimEvent } from '../shared/sim/events';
import { GameSimulation, type PlayerInitConfig } from '../shared/sim/simulation';
import {
  EnemyStateFlag,
  PlayerStateFlag,
  type PlayerId,
  type PlayerInput,
  type RoomPaceMode,
  type UpgradeChoiceIndex,
} from '../shared/sim/types';

export const DEFAULT_RECONNECT_GRACE_MS = 20_000;
const SNAPSHOT_BUFFER_BYTES = 16 * 1024;
const EVENT_BUFFER_BYTES = 8 * 1024;
const MAX_WS_BUFFERED_BYTES = 64 * 1024;
const MAX_CATCHUP_TICKS = 2;

export interface RoomPlayerSession {
  playerId: PlayerId;
  slotId: number;
  name: string;
  heroId: HeroId;
  ready: boolean;
  reconnectToken: string;
  ws: WebSocket | null;
  connected: boolean;
  disconnectedAt: number | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
  lastInputSeq: number | null;
  lastDeliveredBatchId: number | null;
  lastDeliveredQueueCount: number;
}

export interface GameRoomOptions {
  roomCode: string;
  paceMode?: RoomPaceMode;
  seed?: number;
  reconnectGraceMs?: number;
  onEmpty?: (roomCode: string) => void;
}

function toPct(current: number, max: number): number {
  if (max <= 0 || current <= 0) return 0;
  const pct = Math.ceil((current / max) * 100);
  return pct > 100 ? 100 : pct;
}

function isSeqNewer(seq: number, prevSeq: number | null): boolean {
  if (prevSeq === null) return true;
  if (seq === prevSeq) return false;
  return ((seq - prevSeq) & 0xffff) < 0x8000;
}

function sanitizePlayerName(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim().slice(0, 20);
  return trimmed.length > 0 ? trimmed : fallback;
}

/**
 * Authoritative multiplayer game room running a headless 20 Hz fixed-timestep
 * `GameSimulation` for up to 4 co-op players with compact binary snapshots,
 * personal XP syncing, event streaming, and 20s mobile reconnect grace periods.
 */
export class GameRoom {
  public readonly roomCode: string;
  public readonly sim: GameSimulation;
  public readonly createdAt: number;

  private readonly seed?: number;
  private readonly reconnectGraceMs: number;
  private readonly onEmpty?: (roomCode: string) => void;

  private readonly sessions = new Map<PlayerId, RoomPlayerSession>();
  private readonly tokenToPlayerId = new Map<string, PlayerId>();
  private readonly playerIdToSlot = new Map<PlayerId, number>();
  private readonly inputs = new Map<PlayerId, PlayerInput>();

  // Preallocated reusable buffers to keep VPS memory usage flat and GC pauses minimal
  private readonly snapshotEncodeBuf = new ArrayBuffer(SNAPSHOT_BUFFER_BYTES);
  private readonly eventEncodeBuf = new ArrayBuffer(EVENT_BUFFER_BYTES);
  private readonly wirePlayersBuf: WirePlayerState[] = [];
  private readonly wireEnemiesBuf: WireEnemyState[] = [];
  private readonly wirePickupsBuf: WirePickupState[] = [];
  private readonly binaryEventsBuf: BinaryCombatEvent[] = [];

  private status: RoomStatus = 'lobby';
  private paceMode: RoomPaceMode;
  private hostPlayerId: PlayerId = '';
  private lastActivityAt: number;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private lastStepTimeMs = 0;
  private accumulatorSec = 0;
  private disposed = false;

  constructor(options: GameRoomOptions) {
    this.roomCode = options.roomCode;
    this.seed = options.seed;
    this.paceMode = options.paceMode ?? 'coop_pace';
    this.reconnectGraceMs = options.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS;
    this.onEmpty = options.onEmpty;
    this.createdAt = Date.now();
    this.lastActivityAt = this.createdAt;

    this.sim = new GameSimulation(this.seed);
    this.sim.setPaceMode(this.paceMode);
  }

  // ==========================================================================
  // INSPECTORS
  // ==========================================================================

  public getStatus(): RoomStatus {
    return this.status;
  }

  public getPaceMode(): RoomPaceMode {
    return this.paceMode;
  }

  public getHostPlayerId(): PlayerId {
    return this.hostPlayerId;
  }

  public getPlayerCount(): number {
    return this.sessions.size;
  }

  public getConnectedPlayerCount(): number {
    let count = 0;
    for (const s of this.sessions.values()) {
      if (s.connected) count += 1;
    }
    return count;
  }

  public getLastActivityAt(): number {
    return this.lastActivityAt;
  }

  public isEmpty(): boolean {
    return this.sessions.size === 0;
  }

  public getSession(playerId: PlayerId): RoomPlayerSession | undefined {
    return this.sessions.get(playerId);
  }

  public findSessionByToken(reconnectToken: string): RoomPlayerSession | undefined {
    const playerId = this.tokenToPlayerId.get(reconnectToken);
    return playerId ? this.sessions.get(playerId) : undefined;
  }

  public getRoomStatePayload(): RoomStatePayload {
    const players: LobbyPlayerInfo[] = [];
    for (const s of this.sessions.values()) {
      players.push({
        playerId: s.playerId,
        slotId: s.slotId,
        name: s.name,
        heroId: s.heroId,
        ready: s.ready,
        isHost: s.playerId === this.hostPlayerId,
        connected: s.connected,
      });
    }
    players.sort((a, b) => a.slotId - b.slotId);
    return {
      roomCode: this.roomCode,
      status: this.status,
      hostPlayerId: this.hostPlayerId,
      paceMode: this.paceMode,
      maxPlayers: MAX_ROOM_PLAYERS,
      players,
    };
  }

  // ==========================================================================
  // LOBBY & SESSION LIFECYCLE
  // ==========================================================================

  private allocateSlotId(): number | null {
    const used = new Set<number>();
    for (const s of this.sessions.values()) {
      used.add(s.slotId);
    }
    for (let slot = 1; slot <= MAX_ROOM_PLAYERS; slot++) {
      if (!used.has(slot)) return slot;
    }
    return null;
  }

  public addPlayer(
    ws: WebSocket,
    heroId: HeroId = 'mage',
    name?: string
  ): { ok: true; session: RoomPlayerSession } | { ok: false; code: string; message: string } {
    if (this.status !== 'lobby') {
      return { ok: false, code: 'MATCH_IN_PROGRESS', message: 'Match has already started.' };
    }
    if (this.sessions.size >= MAX_ROOM_PLAYERS) {
      return { ok: false, code: 'ROOM_FULL', message: 'Room is full (max 4 players).' };
    }

    const slotId = this.allocateSlotId();
    if (slotId === null) {
      return { ok: false, code: 'ROOM_FULL', message: 'No player slots available.' };
    }

    const playerId: PlayerId = `p${slotId}`;
    const reconnectToken = crypto.randomBytes(16).toString('hex');
    const session: RoomPlayerSession = {
      playerId,
      slotId,
      name: sanitizePlayerName(name, `Player ${slotId}`),
      heroId,
      ready: false,
      reconnectToken,
      ws,
      connected: true,
      disconnectedAt: null,
      graceTimer: null,
      lastInputSeq: null,
      lastDeliveredBatchId: null,
      lastDeliveredQueueCount: 0,
    };

    this.sessions.set(playerId, session);
    this.tokenToPlayerId.set(reconnectToken, playerId);
    this.playerIdToSlot.set(playerId, slotId);
    this.inputs.set(playerId, { moveX: 0, moveY: 0, aimMode: 'auto' });

    if (!this.hostPlayerId || !this.sessions.has(this.hostPlayerId)) {
      this.hostPlayerId = playerId;
    }

    this.touch();

    const roomState = this.getRoomStatePayload();
    this.sendJson(ws, {
      type: 'ROOM_JOINED',
      roomCode: this.roomCode,
      playerId: session.playerId,
      slotId: session.slotId,
      reconnectToken: session.reconnectToken,
      isHost: session.playerId === this.hostPlayerId,
      roomState,
      protocolVersion: PROTOCOL_VERSION,
    });
    this.broadcastJson({ type: 'ROOM_STATE', roomState }, session.playerId);

    return { ok: true, session };
  }

  public selectClass(playerId: PlayerId, heroId: HeroId): boolean {
    if (this.status !== 'lobby') return false;
    const session = this.sessions.get(playerId);
    if (!session) return false;
    session.heroId = heroId;
    this.touch();
    this.broadcastRoomState();
    return true;
  }

  public toggleReady(playerId: PlayerId, explicitReady?: boolean): boolean {
    if (this.status !== 'lobby') return false;
    const session = this.sessions.get(playerId);
    if (!session) return false;
    session.ready = typeof explicitReady === 'boolean' ? explicitReady : !session.ready;
    this.touch();
    this.broadcastRoomState();
    return true;
  }

  public setPaceMode(playerId: PlayerId, paceMode: RoomPaceMode): boolean {
    if (this.status !== 'lobby') return false;
    if (playerId !== this.hostPlayerId) return false;
    this.paceMode = paceMode;
    this.sim.setPaceMode(paceMode);
    this.touch();
    this.broadcastRoomState();
    return true;
  }

  public startMatch(
    requesterPlayerId: PlayerId
  ): { ok: true } | { ok: false; code: string; message: string } {
    if (this.status !== 'lobby') {
      return { ok: false, code: 'ALREADY_STARTED', message: 'Match has already started.' };
    }
    if (requesterPlayerId !== this.hostPlayerId) {
      return { ok: false, code: 'NOT_HOST', message: 'Only the room host can start the match.' };
    }
    if (this.sessions.size === 0) {
      return { ok: false, code: 'EMPTY_ROOM', message: 'Cannot start with zero players.' };
    }

    // Require non-host players to be ready (host implicitly triggers start)
    for (const s of this.sessions.values()) {
      if (s.playerId !== this.hostPlayerId && !s.ready) {
        return {
          ok: false,
          code: 'PLAYERS_NOT_READY',
          message: 'All players must be ready before starting.',
        };
      }
    }

    const roster: PlayerInitConfig[] = [];
    for (const s of this.sessions.values()) {
      s.lastInputSeq = null;
      s.lastDeliveredBatchId = null;
      s.lastDeliveredQueueCount = 0;
      roster.push({ id: s.playerId, heroId: s.heroId });
    }
    roster.sort((a, b) => (this.playerIdToSlot.get(a.id) ?? 0) - (this.playerIdToSlot.get(b.id) ?? 0));

    const startEvents = this.sim.startRun(roster, {
      seed: this.seed,
      mode: 'coop',
      paceMode: this.paceMode,
      asyncLevelUps: true,
    });

    this.status = 'playing';
    this.touch();

    const roomState = this.getRoomStatePayload();
    this.broadcastJson({
      type: 'MATCH_STARTED',
      roomCode: this.roomCode,
      paceMode: this.paceMode,
      tickRate: SERVER_TICK_RATE,
      roomState,
    });

    // Deliver initial tick-0 snapshot & any start events immediately
    this.dispatchEventsAndUpgrades(startEvents);
    this.broadcastSnapshot();
    this.startLoop();

    return { ok: true };
  }

  // ==========================================================================
  // DISCONNECT GRACE PERIOD & RECONNECT
  // ==========================================================================

  public handleSocketClose(playerId: PlayerId, closedWs: WebSocket): void {
    const session = this.sessions.get(playerId);
    if (!session) return;
    // Ignore stale close events from a socket that was already replaced by reconnect
    if (session.ws !== closedWs) return;

    session.ws = null;
    session.connected = false;
    session.disconnectedAt = Date.now();
    this.touch();

    // Outside active matches, remove immediately and reassign host
    if (this.status !== 'playing') {
      this.removePlayerPermanently(playerId);
      return;
    }

    // Mid-match: keep hero alive in simulation for `reconnectGraceMs` (20s)
    const input = this.inputs.get(playerId);
    if (input) {
      input.moveX = 0;
      input.moveY = 0;
      input.aimMode = 'auto';
      input.aimAngle = undefined;
    }

    this.broadcastJson({
      type: 'PLAYER_DISCONNECTED',
      playerId: session.playerId,
      slotId: session.slotId,
      gracePeriodSec: Math.ceil(this.reconnectGraceMs / 1000),
    });
    this.broadcastRoomState();

    if (session.graceTimer) {
      clearTimeout(session.graceTimer);
    }
    session.graceTimer = setTimeout(() => {
      session.graceTimer = null;
      if (!this.disposed && !session.connected && this.sessions.has(playerId)) {
        this.removePlayerPermanently(playerId);
      }
    }, this.reconnectGraceMs);
    session.graceTimer.unref?.();
  }

  public reconnectPlayer(
    reconnectToken: string,
    newWs: WebSocket
  ): { ok: true; session: RoomPlayerSession } | { ok: false; code: string; message: string } {
    const session = this.findSessionByToken(reconnectToken);
    if (!session) {
      return {
        ok: false,
        code: 'INVALID_TOKEN',
        message: 'Reconnect token is invalid or grace period expired.',
      };
    }

    if (session.graceTimer) {
      clearTimeout(session.graceTimer);
      session.graceTimer = null;
    }

    const oldWs = session.ws;
    session.ws = newWs;
    session.connected = true;
    session.disconnectedAt = null;
    session.lastInputSeq = null;
    this.touch();

    if (oldWs && oldWs !== newWs && oldWs.readyState === WebSocket.OPEN) {
      try {
        oldWs.close(4001, 'Replaced by reconnected session');
      } catch {
        // Ignore close errors on stale socket
      }
    }

    const roomState = this.getRoomStatePayload();
    const personalUpgrade =
      this.status === 'playing' ? this.sim.getPersonalUpgradePayload(session.playerId) : null;

    this.sendJson(newWs, {
      type: 'RECONNECTED',
      roomCode: this.roomCode,
      playerId: session.playerId,
      slotId: session.slotId,
      reconnectToken: session.reconnectToken,
      isHost: session.playerId === this.hostPlayerId,
      roomState,
      personalUpgrade,
    });

    this.broadcastJson(
      {
        type: 'PLAYER_RECONNECTED',
        playerId: session.playerId,
        slotId: session.slotId,
      },
      session.playerId
    );
    this.broadcastRoomState();

    // Push an immediate binary snapshot so the reconnected client resumes smoothly
    if (this.status === 'playing') {
      this.sendSnapshotToSinglePlayer(session);
    }

    return { ok: true, session };
  }

  public removePlayerPermanently(playerId: PlayerId): void {
    const session = this.sessions.get(playerId);
    if (!session) return;

    if (session.graceTimer) {
      clearTimeout(session.graceTimer);
      session.graceTimer = null;
    }

    this.sessions.delete(playerId);
    this.tokenToPlayerId.delete(session.reconnectToken);
    this.playerIdToSlot.delete(playerId);
    this.inputs.delete(playerId);
    this.touch();

    let simEvents: SimEvent[] = [];
    if (this.status === 'playing') {
      simEvents = this.sim.removePlayer(playerId);
    }

    let newHostPlayerId: PlayerId | undefined;
    if (this.hostPlayerId === playerId) {
      newHostPlayerId = this.pickNextHost();
      this.hostPlayerId = newHostPlayerId ?? '';
    }

    this.broadcastJson({
      type: 'PLAYER_LEFT',
      playerId: session.playerId,
      slotId: session.slotId,
      ...(newHostPlayerId ? { newHostPlayerId } : {}),
    });

    if (simEvents.length > 0) {
      this.dispatchEventsAndUpgrades(simEvents);
    }

    if (this.sessions.size === 0) {
      this.stopLoop();
      this.onEmpty?.(this.roomCode);
      return;
    }

    this.broadcastRoomState();
  }

  private pickNextHost(): PlayerId | undefined {
    // Prefer a currently connected player with lowest slotId
    const sorted = Array.from(this.sessions.values()).sort((a, b) => a.slotId - b.slotId);
    const connected = sorted.find((s) => s.connected);
    return (connected ?? sorted[0])?.playerId;
  }

  // ==========================================================================
  // REAL-TIME INPUT & UPGRADE HANDLING
  // ==========================================================================

  public handleBinaryInput(playerId: PlayerId, data: Uint8Array): void {
    if (this.status !== 'playing') return;
    const session = this.sessions.get(playerId);
    if (!session) return;

    let decoded;
    try {
      decoded = decodeClientInput(data);
    } catch {
      return;
    }

    if (!isSeqNewer(decoded.seq, session.lastInputSeq)) {
      return;
    }
    session.lastInputSeq = decoded.seq;

    let dx = decoded.dx;
    let dy = decoded.dy;
    const lenSq = dx * dx + dy * dy;
    if (lenSq > 1) {
      const invLen = 1 / Math.sqrt(lenSq);
      dx *= invLen;
      dy *= invLen;
    }

    let input = this.inputs.get(playerId);
    if (!input) {
      input = { moveX: 0, moveY: 0, aimMode: 'auto' };
      this.inputs.set(playerId, input);
    }
    input.moveX = dx;
    input.moveY = dy;
    if (decoded.manualAim) {
      input.aimMode = 'mouse';
      input.aimAngle = decoded.aimAngle;
      input.hasAimTarget = false;
    } else {
      input.aimMode = 'auto';
      input.aimAngle = undefined;
      input.hasAimTarget = false;
    }
    this.touch();
  }

  public handlePickUpgrade(playerId: PlayerId, choiceIndex: UpgradeChoiceIndex): void {
    if (this.status !== 'playing') return;
    const session = this.sessions.get(playerId);
    if (!session) return;

    const events = this.sim.pickUpgrade(playerId, choiceIndex);
    this.touch();

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (ev.type === 'UpgradePicked') {
        this.broadcastJson({
          type: 'UpgradeApplied',
          playerId: session.playerId,
          slotId: session.slotId,
          choiceIndex,
          kind: ev.choice.kind,
          title: ev.choice.title,
          shortTitle: ev.choice.shortTitle,
          abilityId: ev.choice.abilityId,
          synergyId: ev.choice.synergyId,
          artifactId: ev.choice.artifactId,
          nextLevel: ev.choice.nextLevel,
          remainingQueueCount: ev.remainingQueueCount,
        });
      }
    }

    // Sync the player's next personal upgrade batch (if queued) or clear delivery tracking
    const nextPayload = this.sim.getPersonalUpgradePayload(playerId);
    if (nextPayload) {
      session.lastDeliveredBatchId = nextPayload.batchId;
      session.lastDeliveredQueueCount = nextPayload.pendingQueueCount;
      if (session.ws) {
        this.sendJson(session.ws, {
          type: 'UpgradeChoices',
          playerId: session.playerId,
          slotId: session.slotId,
          batchId: nextPayload.batchId,
          source: nextPayload.source,
          choices: nextPayload.choices,
          pendingQueueCount: nextPayload.pendingQueueCount,
        });
      }
    } else {
      session.lastDeliveredBatchId = null;
      session.lastDeliveredQueueCount = 0;
    }

    this.dispatchCombatAndLifecycleEvents(events);
  }

  public triggerVictory(): void {
    if (this.status !== 'playing') return;
    this.status = 'victory';
    this.stopLoop();
    this.broadcastJson({
      type: 'Victory',
      elapsedRunSec: this.sim.getElapsedRunSec(),
      kills: this.sim.getKills(),
      bossesDefeated: this.sim.getBossesDefeated(),
      players: this.buildMatchSummaryPlayers(),
    });
    this.broadcastRoomState();
  }

  // ==========================================================================
  // AUTHORITATIVE 20 HZ SIMULATION LOOP
  // ==========================================================================

  private startLoop(): void {
    this.stopLoop();
    this.lastStepTimeMs = Date.now();
    this.accumulatorSec = 0;

    const tickMs = Math.round(1000 / SERVER_TICK_RATE);
    this.tickTimer = setInterval(() => {
      if (this.disposed || this.status !== 'playing') {
        this.stopLoop();
        return;
      }

      const now = Date.now();
      const dtSec = Math.min(0.25, Math.max(0, (now - this.lastStepTimeMs) / 1000));
      this.lastStepTimeMs = now;
      this.accumulatorSec += dtSec;

      let steps = 0;
      while (this.accumulatorSec >= SERVER_FIXED_DT && steps < MAX_CATCHUP_TICKS) {
        this.accumulatorSec -= SERVER_FIXED_DT;
        this.stepOnce();
        steps += 1;
        if (this.status !== 'playing') break;
      }

      // Drop excessive lag buildup so a slow VPS never spirals
      if (this.accumulatorSec > SERVER_FIXED_DT * 2) {
        this.accumulatorSec = 0;
      }
    }, tickMs);
    this.tickTimer.unref?.();
  }

  private stopLoop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private stepOnce(): void {
    const events = this.sim.step(SERVER_FIXED_DT, this.inputs);

    // Defensive hard active enemy cap enforcement (350 per room)
    if (this.sim.enemies.length > MAX_ROOM_ENEMIES) {
      let writeIdx = 0;
      for (let i = 0; i < this.sim.enemies.length && writeIdx < MAX_ROOM_ENEMIES; i++) {
        const e = this.sim.enemies[i];
        if (e.alive) {
          this.sim.enemies[writeIdx++] = e;
        }
      }
      this.sim.enemies.length = writeIdx;
    }

    this.dispatchEventsAndUpgrades(events);
    this.broadcastSnapshot();
  }

  // ==========================================================================
  // SNAPSHOT & EVENT SERIALIZATION (REUSING TYPED ARRAY BUFFERS)
  // ==========================================================================

  private buildWireSnapshot(selfPlayerId = 0, selfXp = 0, selfXpToNext = 1, selfPending = 0): WireSnapshot {
    // 1. Players
    this.wirePlayersBuf.length = 0;
    for (const p of this.sim.players.values()) {
      const session = this.sessions.get(p.id);
      const slotId = session?.slotId ?? this.playerIdToSlot.get(p.id) ?? 0;

      let wireFlags = WirePlayerFlag.NONE;
      if (p.alive && !p.downed) wireFlags |= WirePlayerFlag.ALIVE;
      if (p.downed || !p.alive) wireFlags |= WirePlayerFlag.DOWNED;
      if ((p.stateFlags & PlayerStateFlag.CHOOSING_UPGRADE) !== 0) {
        wireFlags |= WirePlayerFlag.UPGRADING;
      }
      if ((p.stateFlags & PlayerStateFlag.INVULNERABLE) !== 0 || p.invulnTimer > 0) {
        wireFlags |= WirePlayerFlag.INVULN;
      }
      if ((p.stateFlags & PlayerStateFlag.REVIVING_ALLY) !== 0) {
        wireFlags |= WirePlayerFlag.REVIVING_ALLY;
      }
      if ((p.stateFlags & PlayerStateFlag.BEING_REVIVED) !== 0) {
        wireFlags |= WirePlayerFlag.BEING_REVIVED;
      }
      if (p.facingLeft) wireFlags |= WirePlayerFlag.FACING_LEFT;
      if (session && !session.connected) wireFlags |= WirePlayerFlag.DISCONNECTED;

      this.wirePlayersBuf.push({
        id: slotId,
        x: p.x,
        y: p.y,
        aimAngle: p.aimAngle,
        hpPct: toPct(p.hp, p.maxHp),
        level: p.level,
        stateFlags: wireFlags,
        classId: p.heroId,
        revivePct: Math.round(p.revivePct * 100),
      });
    }

    // 2. Enemies & Bosses (hard capped at 350)
    this.wireEnemiesBuf.length = 0;
    for (let i = 0; i < this.sim.enemies.length && this.wireEnemiesBuf.length < MAX_ROOM_ENEMIES; i++) {
      const e = this.sim.enemies[i];
      if (!e.alive) continue;

      let flags = 0;
      if (e.isElite || (e.stateFlags & EnemyStateFlag.ELITE) !== 0) {
        flags |= WireEnemyFlag.ELITE;
      }
      if (e.chilled || (e.stateFlags & (EnemyStateFlag.CHILLED | EnemyStateFlag.FROZEN)) !== 0) {
        flags |= WireEnemyFlag.CHILLED;
      }
      if (e.tauntTargetId !== null || (e.stateFlags & EnemyStateFlag.TAUNTED) !== 0) {
        flags |= WireEnemyFlag.TAUNTED;
      }
      if (e.facingLeft) {
        flags |= WireEnemyFlag.FACING_LEFT;
      }

      this.wireEnemiesBuf.push({
        id: e.id,
        x: e.x,
        y: e.y,
        type: e.isBoss && e.bossId ? e.bossId : e.archetypeId,
        flags,
        hpPct: toPct(e.hp, e.maxHp),
      });
    }

    // 3. Pickups (XP gems, hearts, magnets, boss chests)
    this.wirePickupsBuf.length = 0;
    for (let i = 0; i < this.sim.pickups.length; i++) {
      const item = this.sim.pickups[i];
      this.wirePickupsBuf.push({
        id: item.id,
        kind: item.kind,
        x: item.x,
        y: item.y,
      });
    }

    // 4. Compact active Boss phase/telegraph block
    let wireBoss: WireBossState | null = null;
    const bossEntity = this.sim.getActiveBoss();
    if (bossEntity && bossEntity.bossId) {
      const runtime = this.sim.bossAI.getRuntime(bossEntity.id);
      const visual = this.sim.bossAI.getVisualState(bossEntity.id);
      const combinedInfo = this.sim.getActiveBossInfo();
      const hpPct = combinedInfo
        ? toPct(combinedInfo.hp, combinedInfo.maxHp)
        : toPct(bossEntity.hp, bossEntity.maxHp);
      wireBoss = {
        enemyId: bossEntity.id,
        bossId: bossEntity.bossId,
        phase: runtime?.state ?? 'chase',
        enraged: runtime?.enraged ?? visual.enraged,
        attackId: runtime?.currentAttack?.id ?? null,
        hpPct,
        telegraphPct: Math.round(visual.telegraphRatio * 100),
        cycle: runtime?.cycle ?? 0,
        encounterIndex: runtime?.encounterIndex ?? bossEntity.bossEncounterIndex ?? 0,
        targetX: runtime?.data.targetX ?? bossEntity.x,
        targetY: runtime?.data.targetY ?? bossEntity.y,
        radius: runtime?.data.radius ?? bossEntity.radius,
        baseAngle: runtime?.data.baseAngle ?? 0,
      };
    }

    return {
      tick: this.sim.getTickCount(),
      elapsedMs: Math.round(this.sim.getElapsedRunSec() * 1000),
      kills: this.sim.getKills(),
      bossesDefeated: this.sim.getBossesDefeated(),
      nextBossSec: Math.ceil(this.sim.getNextBossCountdownSec()),
      paceMode: this.sim.getPaceMode(),
      state: this.sim.getState(),
      selfPlayerId,
      selfXp,
      selfXpToNext,
      selfPendingUpgrades: selfPending,
      boss: wireBoss,
      players: this.wirePlayersBuf,
      enemies: this.wireEnemiesBuf,
      pickups: this.wirePickupsBuf,
    };
  }

  private broadcastSnapshot(): void {
    if (this.getConnectedPlayerCount() === 0) return;

    // Encode shared world ONCE into reusable ArrayBuffer
    const sharedSnapshot = this.buildWireSnapshot();
    const encoded = encodeSnapshot(sharedSnapshot, this.snapshotEncodeBuf);

    for (const session of this.sessions.values()) {
      const ws = session.ws;
      if (!session.connected || !ws || ws.readyState !== WebSocket.OPEN) continue;
      if (ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) continue;

      const simPlayer = this.sim.getPlayer(session.playerId);
      const clientCopy = new Uint8Array(encoded.byteLength);
      clientCopy.set(encoded);

      if (simPlayer) {
        patchSnapshotPersonalXp(
          clientCopy,
          session.slotId,
          simPlayer.xp,
          simPlayer.xpToNext,
          simPlayer.pendingQueueCount
        );
      } else {
        patchSnapshotPersonalXp(clientCopy, session.slotId, 0, 1, 0);
      }

      try {
        ws.send(clientCopy, { binary: true });
      } catch {
        // Socket close handler will clean up
      }
    }
  }

  private sendSnapshotToSinglePlayer(session: RoomPlayerSession): void {
    const ws = session.ws;
    if (!session.connected || !ws || ws.readyState !== WebSocket.OPEN) return;

    const simPlayer = this.sim.getPlayer(session.playerId);
    const snapshot = this.buildWireSnapshot(
      session.slotId,
      simPlayer?.xp ?? 0,
      simPlayer?.xpToNext ?? 1,
      simPlayer?.pendingQueueCount ?? 0
    );
    const encoded = encodeSnapshot(snapshot, this.snapshotEncodeBuf);
    const copy = new Uint8Array(encoded.byteLength);
    copy.set(encoded);
    try {
      ws.send(copy, { binary: true });
    } catch {
      // Ignore send errors
    }
  }

  private dispatchEventsAndUpgrades(events: readonly SimEvent[]): void {
    this.dispatchCombatAndLifecycleEvents(events);
    this.dispatchDirtyPersonalUpgrades();
  }

  private dispatchCombatAndLifecycleEvents(events: readonly SimEvent[]): void {
    this.binaryEventsBuf.length = 0;

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      switch (ev.type) {
        case 'AbilityFired': {
          const slotId = this.playerIdToSlot.get(ev.playerId) ?? 0;
          this.binaryEventsBuf.push({
            type: 'AbilityFired',
            playerId: slotId,
            abilityId: ev.abilityId,
            isSynergy: ev.isSynergy,
            isDoubleCast: Boolean(ev.isDoubleCast),
            x: ev.x,
            y: ev.y,
            aimAngle: ev.aimAngle,
          });
          break;
        }

        case 'ProjectileSpawned': {
          const slotId = ev.playerId ? this.playerIdToSlot.get(ev.playerId) ?? 0 : 0;
          this.binaryEventsBuf.push({
            type: 'ProjectileSpawned',
            netId: ev.netId,
            playerId: slotId,
            sourceId: ev.sourceId,
            spriteId: ev.spriteId,
            x: ev.x,
            y: ev.y,
            vx: ev.vx,
            vy: ev.vy,
            radius: ev.radius,
            scale: ev.scale,
            spinSpeed: ev.spinSpeed,
            lifeMs: Math.max(50, Math.round(ev.remainingLifeSec * 1000)),
          });
          break;
        }

        case 'ProjectileMoved': {
          this.binaryEventsBuf.push({
            type: 'ProjectileMoved',
            netId: ev.netId,
            x: ev.x,
            y: ev.y,
            vx: ev.vx,
            vy: ev.vy,
          });
          break;
        }

        case 'ProjectileDespawned': {
          this.binaryEventsBuf.push({
            type: 'ProjectileDespawned',
            netId: ev.netId,
            x: ev.x,
            y: ev.y,
          });
          break;
        }

        case 'DamageDealt': {
          const slotId = ev.playerId ? this.playerIdToSlot.get(ev.playerId) ?? 0 : 0;
          this.binaryEventsBuf.push({
            type: 'DamageNumber',
            enemyId: ev.enemyId,
            playerId: slotId,
            x: ev.x,
            y: ev.y,
            amount: Math.max(1, Math.round(ev.amount)),
            isCrit: ev.isCrit,
            shattered: ev.shattered,
            silent: Boolean(ev.silent),
          });
          break;
        }

        case 'EnemyKilled': {
          this.binaryEventsBuf.push({
            type: 'EnemyKilled',
            enemyId: ev.enemyId,
            enemyType: ev.isBoss && ev.bossId ? ev.bossId : ev.archetypeId,
            isBoss: ev.isBoss,
            x: ev.x,
            y: ev.y,
          });
          break;
        }

        case 'BossTelegraph': {
          this.binaryEventsBuf.push({
            type: 'BossTelegraph',
            enemyId: ev.enemyId,
            bossId: ev.bossId,
            attackId: ev.attackId,
            x: ev.x,
            y: ev.y,
            targetX: ev.targetX,
            targetY: ev.targetY,
            telegraphMs: Math.round(ev.telegraphSec * 1000),
          });
          break;
        }

        case 'BossHazard': {
          this.binaryEventsBuf.push({
            type: 'BossHazard',
            hazardKind: ev.hazardKind,
            x: ev.x,
            y: ev.y,
            targetX: ev.targetX,
            targetY: ev.targetY,
            radius: ev.radius,
            durationMs: ev.durationMs,
            active: ev.active,
          });
          break;
        }

        case 'PlayerDowned': {
          const slotId = this.playerIdToSlot.get(ev.playerId) ?? 0;
          this.binaryEventsBuf.push({
            type: 'PlayerDowned',
            playerId: slotId,
            x: ev.x,
            y: ev.y,
          });
          break;
        }

        case 'PlayerRevived': {
          const slotId = this.playerIdToSlot.get(ev.playerId) ?? 0;
          const simPlayer = this.sim.getPlayer(ev.playerId);
          let reviverMask = 0;
          for (let r = 0; r < ev.reviverIds.length; r++) {
            const rSlot = this.playerIdToSlot.get(ev.reviverIds[r]);
            if (rSlot && rSlot >= 1 && rSlot <= 8) {
              reviverMask |= 1 << (rSlot - 1);
            }
          }
          this.binaryEventsBuf.push({
            type: 'PlayerRevived',
            playerId: slotId,
            reason: ev.reason,
            hpPct: simPlayer ? toPct(ev.hp, simPlayer.maxHp) : 20,
            x: ev.x,
            y: ev.y,
            reviverMask,
          });
          break;
        }

        case 'GameOverTriggered': {
          if (this.status === 'playing') {
            this.status = 'gameover';
            this.stopLoop();
            this.broadcastJson({
              type: 'GameOver',
              elapsedRunSec: ev.snapshot.elapsedRunSec,
              kills: ev.snapshot.kills,
              bossesDefeated: ev.snapshot.bossesDefeated,
              players: this.buildMatchSummaryPlayers(),
            });
            this.broadcastRoomState();
          }
          break;
        }

        // Particles/projectiles/floating VFX text are driven locally on clients
        default:
          break;
      }
    }

    if (this.binaryEventsBuf.length > 0 && this.getConnectedPlayerCount() > 0) {
      // Send in chunks of up to 255 events if ever exceeded
      const total = this.binaryEventsBuf.length;
      for (let start = 0; start < total; start += 255) {
        const chunk =
          start === 0 && total <= 255
            ? this.binaryEventsBuf
            : this.binaryEventsBuf.slice(start, start + 255);
        const encoded = encodeBinaryEvents(chunk, this.eventEncodeBuf);
        const payload = new Uint8Array(encoded.byteLength);
        payload.set(encoded);
        this.broadcastBinary(payload);
      }
    }
  }

  private dispatchDirtyPersonalUpgrades(): void {
    for (const session of this.sessions.values()) {
      const payload = this.sim.getPersonalUpgradePayload(session.playerId);
      if (!payload) {
        session.lastDeliveredBatchId = null;
        session.lastDeliveredQueueCount = 0;
        continue;
      }

      if (
        session.lastDeliveredBatchId !== payload.batchId ||
        session.lastDeliveredQueueCount !== payload.pendingQueueCount
      ) {
        session.lastDeliveredBatchId = payload.batchId;
        session.lastDeliveredQueueCount = payload.pendingQueueCount;
        if (session.connected && session.ws) {
          this.sendJson(session.ws, {
            type: 'UpgradeChoices',
            playerId: session.playerId,
            slotId: session.slotId,
            batchId: payload.batchId,
            source: payload.source,
            choices: payload.choices,
            pendingQueueCount: payload.pendingQueueCount,
          });
        }
      }
    }
  }

  private buildMatchSummaryPlayers(): MatchSummaryPlayer[] {
    const out: MatchSummaryPlayer[] = [];
    for (const s of this.sessions.values()) {
      const simP = this.sim.getPlayer(s.playerId);
      out.push({
        playerId: s.playerId,
        slotId: s.slotId,
        name: s.name,
        heroId: s.heroId,
        level: simP?.level ?? 1,
      });
    }
    out.sort((a, b) => a.slotId - b.slotId);
    return out;
  }

  // ==========================================================================
  // TRANSPORT HELPERS & CLEANUP
  // ==========================================================================

  private touch(): void {
    this.lastActivityAt = Date.now();
  }

  private sendJson(ws: WebSocket, msg: ServerControlMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Ignore send errors on closing sockets
    }
  }

  private broadcastJson(msg: ServerControlMessage, excludePlayerId?: PlayerId): void {
    const serialized = JSON.stringify(msg);
    for (const s of this.sessions.values()) {
      if (excludePlayerId && s.playerId === excludePlayerId) continue;
      if (!s.connected || !s.ws || s.ws.readyState !== WebSocket.OPEN) continue;
      try {
        s.ws.send(serialized);
      } catch {
        // Ignore send errors
      }
    }
  }

  private broadcastBinary(payload: Uint8Array): void {
    for (const s of this.sessions.values()) {
      if (!s.connected || !s.ws || s.ws.readyState !== WebSocket.OPEN) continue;
      if (s.ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) continue;
      try {
        s.ws.send(payload, { binary: true });
      } catch {
        // Ignore send errors
      }
    }
  }

  private broadcastRoomState(): void {
    this.broadcastJson({
      type: 'ROOM_STATE',
      roomState: this.getRoomStatePayload(),
    });
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopLoop();
    for (const s of this.sessions.values()) {
      if (s.graceTimer) {
        clearTimeout(s.graceTimer);
        s.graceTimer = null;
      }
      if (s.ws && s.ws.readyState === WebSocket.OPEN) {
        try {
          s.ws.close(1001, 'Room closed');
        } catch {
          // Ignore
        }
      }
    }
    this.sessions.clear();
    this.tokenToPlayerId.clear();
    this.playerIdToSlot.clear();
    this.inputs.clear();
  }
}
