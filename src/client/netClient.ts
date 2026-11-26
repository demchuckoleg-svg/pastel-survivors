import type { HeroId, PickupSpriteId } from '@shared/data/types';
import {
  BinaryOpcode,
  CLIENT_INPUT_PACKET_BYTES,
  decodeBinaryEvents,
  decodePersonalXp,
  decodeSnapshot,
  encodeClientInput,
  encodePickUpgrade,
  normalizeRoomCode,
  peekBinaryOpcode,
  PICK_UPGRADE_PACKET_BYTES,
  PROTOCOL_VERSION,
  SERVER_TICK_RATE,
  WirePlayerFlag,
  type BinaryCombatEvent,
  type ClientControlMessage,
  type LobbyPlayerInfo,
  type RoomStatePayload,
  type ServerControlMessage,
  type WireBossState,
  type WireEnemyState,
  type WireEnemyTypeName,
  type WirePersonalXpPacket,
  type WirePickupState,
  type WirePlayerState,
  type WireSnapshot,
} from '@shared/protocol';
import type {
  GameState,
  PlayerId,
  RoomPaceMode,
  UpgradeChoiceIndex,
} from '@shared/sim/types';

export type NetConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting';

export interface InterpolatedPlayer {
  id: number;
  x: number;
  y: number;
  aimAngle: number;
  hpPct: number;
  level: number;
  stateFlags: number;
  classId: HeroId;
  revivePct: number;
  walkTime: number;
  isMoving: boolean;
  name: string;
  isLocal: boolean;
  hitFlashTimer: number;
}

export interface InterpolatedEnemy {
  id: number;
  x: number;
  y: number;
  type: WireEnemyTypeName;
  flags: number;
  hpPct: number;
  walkTime: number;
  hitFlashTimer: number;
}

export interface InterpolatedPickup {
  id: number;
  kind: PickupSpriteId;
  x: number;
  y: number;
  age: number;
}

export interface InterpolatedWorldState {
  tick: number;
  elapsedSec: number;
  kills: number;
  bossesDefeated: number;
  nextBossSec: number;
  paceMode: RoomPaceMode;
  state: GameState;
  selfSlotId: number;
  selfXp: number;
  selfXpToNext: number;
  selfPendingUpgrades: number;
  boss: WireBossState | null;
  players: InterpolatedPlayer[];
  enemies: InterpolatedEnemy[];
  pickups: InterpolatedPickup[];
}

export interface NetClientCallbacks {
  onConnectionStateChange?: (state: NetConnectionState) => void;
  onRoomJoined?: (msg: Extract<ServerControlMessage, { type: 'ROOM_JOINED' }>) => void;
  onRoomState?: (roomState: RoomStatePayload) => void;
  onMatchStarted?: (msg: Extract<ServerControlMessage, { type: 'MATCH_STARTED' }>) => void;
  onSnapshot?: (snapshot: WireSnapshot, prevSnapshot: WireSnapshot | null) => void;
  onPersonalXp?: (pkt: WirePersonalXpPacket) => void;
  onBinaryEvents?: (events: BinaryCombatEvent[]) => void;
  onUpgradeChoices?: (msg: Extract<ServerControlMessage, { type: 'UpgradeChoices' }>) => void;
  onUpgradeApplied?: (msg: Extract<ServerControlMessage, { type: 'UpgradeApplied' }>) => void;
  onGameOver?: (msg: Extract<ServerControlMessage, { type: 'GameOver' }>) => void;
  onVictory?: (msg: Extract<ServerControlMessage, { type: 'Victory' }>) => void;
  onReconnected?: (msg: Extract<ServerControlMessage, { type: 'RECONNECTED' }>) => void;
  onError?: (code: string, message: string) => void;
  onReconnectFailed?: (reason: string) => void;
}

const DEFAULT_TICK_INTERVAL_MS = 1000 / SERVER_TICK_RATE; // 50ms
const INPUT_HEARTBEAT_MS = 40; // 25 Hz continuous refresh
const INPUT_MIN_CHANGE_MS = 28; // ~35 Hz burst cap on rapid changes
const HEARTBEAT_INTERVAL_MS = 5_000;
const STALE_CONNECTION_MS = 14_000;
const RECONNECT_MAX_WINDOW_MS = 24_000;
const RECONNECT_DELAYS_MS = [500, 1000, 1600, 2200, 3000];
const TELEPORT_SNAP_DIST = 150;

/**
 * Resolves the default WebSocket server URL:
 * - Served over HTTP/HTTPS: defaults to `ws(s)://${window.location.host}/ws`
 * - Bundled / Capacitor (`https://localhost`, `capacitor://`, `file://`): uses `import.meta.env.VITE_WS_URL`
 */
export function resolveDefaultWsUrl(): string {
  const envUrl = import.meta.env?.VITE_WS_URL?.trim() ?? '';

  if (typeof window === 'undefined' || !window.location) {
    return envUrl || 'ws://localhost:3000/ws';
  }

  const { protocol, host, hostname } = window.location;
  const isBundled =
    protocol === 'capacitor:' ||
    protocol === 'file:' ||
    !host ||
    (protocol === 'https:' && hostname === 'localhost');

  if (isBundled) {
    return envUrl || 'ws://localhost:3000/ws';
  }

  if (protocol === 'http:' || protocol === 'https:') {
    if (envUrl) {
      return normalizeWsUrl(envUrl);
    }
    const wsProto = protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsProto}//${host}/ws`;
  }

  return envUrl ? normalizeWsUrl(envUrl) : 'ws://localhost:3000/ws';
}

/**
 * Normalizes a user-supplied server URL override into a valid `ws://` or `wss://` endpoint.
 */
export function normalizeWsUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return resolveDefaultWsUrl();

  let candidate = trimmed;
  if (/^http:\/\//i.test(candidate)) {
    candidate = candidate.replace(/^http:\/\//i, 'ws://');
  } else if (/^https:\/\//i.test(candidate)) {
    candidate = candidate.replace(/^https:\/\//i, 'wss://');
  } else if (!/^wss?:\/\//i.test(candidate)) {
    const useSecure =
      typeof window !== 'undefined' &&
      window.location?.protocol === 'https:' &&
      window.location?.hostname !== 'localhost';
    candidate = `${useSecure ? 'wss://' : 'ws://'}${candidate}`;
  }

  try {
    const parsed = new URL(candidate);
    if (!parsed.pathname || parsed.pathname === '/') {
      parsed.pathname = '/ws';
    }
    return parsed.toString();
  } catch {
    return candidate.endsWith('/ws') ? candidate : `${candidate.replace(/\/+$/, '')}/ws`;
  }
}

export function getEffectiveWsUrl(override?: string): string {
  if (override && override.trim().length > 0) {
    return normalizeWsUrl(override);
  }
  return resolveDefaultWsUrl();
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpAngle(a: number, b: number, t: number): number {
  let diff = (b - a) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

interface SnapshotFrame {
  snapshot: WireSnapshot;
  receivedAtMs: number;
  playersById: Map<number, WirePlayerState>;
  enemiesById: Map<number, WireEnemyState>;
  pickupsById: Map<number, WirePickupState>;
}

/**
 * Browser & mobile WebSocket multiplayer client for 4-player online co-op.
 * Handles compact binary frames, 20-30 Hz input streaming, 60 FPS entity interpolation
 * with gentle local movement prediction/reconciliation, ping/pong heartbeats,
 * and automatic silent reconnect with stored `reconnectToken`.
 */
export class NetClient {
  private readonly callbacks: NetClientCallbacks;

  private ws: WebSocket | null = null;
  private serverUrl = '';
  private connectionState: NetConnectionState = 'disconnected';
  private intentionalClose = false;

  // Session state
  private roomCode: string | null = null;
  private playerId: PlayerId | null = null;
  private slotId = 0;
  private reconnectToken: string | null = null;
  private isHost = false;
  private roomState: RoomStatePayload | null = null;
  private inActiveMatch = false;

  // Pending initial command sent on socket open
  private pendingInitialCommand: ClientControlMessage | null = null;

  // Heartbeat & Reconnect timers
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastServerMessageMs = 0;
  private lastPingSentMs = 0;
  private rttMs = 0;
  private reconnectStartedAtMs = 0;
  private reconnectAttempt = 0;

  // Input sending throttle & preallocated binary buffers
  private readonly inputEncodeBuf = new ArrayBuffer(CLIENT_INPUT_PACKET_BYTES);
  private readonly pickUpgradeEncodeBuf = new ArrayBuffer(PICK_UPGRADE_PACKET_BYTES);
  private inputSeq = 0;
  private lastInputSentAtMs = 0;
  private lastSentDx = 0;
  private lastSentDy = 0;
  private lastSentAimAngle = 0;
  private lastSentManualAim = false;

  // Snapshot pair for 60 FPS entity interpolation
  private prevFrame: SnapshotFrame | null = null;
  private currFrame: SnapshotFrame | null = null;
  private smoothedTickIntervalMs = DEFAULT_TICK_INTERVAL_MS;

  // Local prediction & reconciliation state for self hero
  private hasPredictedSelf = false;
  private predictedSelfX = 0;
  private predictedSelfY = 0;
  private latestServerSelfX = 0;
  private latestServerSelfY = 0;

  // Client visual animation & hit flash caches keyed by entity id
  private readonly playerWalkTimes = new Map<number, number>();
  private readonly playerPrevPos = new Map<number, { x: number; y: number }>();
  private readonly playerHitFlashes = new Map<number, number>();
  private readonly enemyWalkTimes = new Map<number, number>();
  private readonly enemyHitFlashes = new Map<number, number>();
  private readonly pickupAges = new Map<number, number>();

  // Standalone personal XP override when BinaryOpcode.PERSONAL_XP arrives
  private latestPersonalXp: WirePersonalXpPacket | null = null;

  constructor(callbacks: NetClientCallbacks = {}) {
    this.callbacks = callbacks;
  }

  // ==========================================================================
  // PUBLIC INSPECTORS
  // ==========================================================================

  public getConnectionState(): NetConnectionState {
    return this.connectionState;
  }

  public isConnected(): boolean {
    return this.connectionState === 'connected' && this.ws?.readyState === WebSocket.OPEN;
  }

  public isReconnecting(): boolean {
    return this.connectionState === 'reconnecting';
  }

  public getRoomCode(): string | null {
    return this.roomCode;
  }

  public getPlayerId(): PlayerId | null {
    return this.playerId;
  }

  public getSlotId(): number {
    return this.slotId;
  }

  public getIsHost(): boolean {
    return this.isHost;
  }

  public getRoomState(): RoomStatePayload | null {
    return this.roomState;
  }

  public getRttMs(): number {
    return this.rttMs;
  }

  public getServerUrl(): string {
    return this.serverUrl;
  }

  public getLatestSnapshot(): WireSnapshot | null {
    return this.currFrame?.snapshot ?? null;
  }

  public getLobbyPlayerBySlot(slotId: number): LobbyPlayerInfo | undefined {
    return this.roomState?.players.find((p) => p.slotId === slotId);
  }

  // ==========================================================================
  // LOBBY & CONNECTION FLOW
  // ==========================================================================

  public createRoom(opts: {
    heroId: HeroId;
    paceMode?: RoomPaceMode;
    name?: string;
    serverUrl?: string;
  }): void {
    this.resetSessionState();
    this.serverUrl = getEffectiveWsUrl(opts.serverUrl);
    this.pendingInitialCommand = {
      type: 'CREATE_ROOM',
      heroId: opts.heroId,
      paceMode: opts.paceMode ?? 'coop_pace',
      name: opts.name?.trim().slice(0, 20) || undefined,
    };
    this.openSocket(false);
  }

  public joinRoom(opts: {
    roomCode: string;
    heroId: HeroId;
    name?: string;
    serverUrl?: string;
  }): boolean {
    const normalized = normalizeRoomCode(opts.roomCode);
    if (!normalized) {
      this.callbacks.onError?.('INVALID_ROOM_CODE', 'Enter a valid 4-character Room Code.');
      return false;
    }
    this.resetSessionState();
    this.serverUrl = getEffectiveWsUrl(opts.serverUrl);
    this.pendingInitialCommand = {
      type: 'JOIN_ROOM',
      roomCode: normalized,
      heroId: opts.heroId,
      name: opts.name?.trim().slice(0, 20) || undefined,
    };
    this.openSocket(false);
    return true;
  }

  public selectClass(heroId: HeroId): void {
    this.sendJson({ type: 'SELECT_CLASS', heroId });
  }

  public toggleReady(ready?: boolean): void {
    this.sendJson({ type: 'TOGGLE_READY', ...(typeof ready === 'boolean' ? { ready } : {}) });
  }

  public setPaceMode(paceMode: RoomPaceMode): void {
    this.sendJson({ type: 'SET_PACE', paceMode });
  }

  public startMatch(): void {
    this.sendJson({ type: 'START_MATCH' });
  }

  public disconnect(): void {
    this.intentionalClose = true;
    this.clearTimers();
    this.pendingInitialCommand = null;

    if (this.ws) {
      try {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onerror = null;
        this.ws.onclose = null;
        if (
          this.ws.readyState === WebSocket.OPEN ||
          this.ws.readyState === WebSocket.CONNECTING
        ) {
          this.ws.close(1000, 'Client disconnected');
        }
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }

    this.resetSessionState();
    this.setConnectionState('disconnected');
  }

  // ==========================================================================
  // REAL-TIME BINARY INPUT & UPGRADE PACKETS
  // ==========================================================================

  /**
   * Streams compact binary player input at ~25 Hz or immediately on input change.
   */
  public sendInput(
    dx: number,
    dy: number,
    aimAngle: number,
    manualAim: boolean,
    nowMs = performance.now()
  ): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.inActiveMatch) {
      return;
    }

    const elapsed = nowMs - this.lastInputSentAtMs;
    const angleDelta = Math.abs(lerpAngle(this.lastSentAimAngle, aimAngle, 1) - this.lastSentAimAngle);
    const changed =
      Math.abs(dx - this.lastSentDx) > 0.02 ||
      Math.abs(dy - this.lastSentDy) > 0.02 ||
      manualAim !== this.lastSentManualAim ||
      (manualAim && angleDelta > 0.045);

    const shouldSend =
      (changed && elapsed >= INPUT_MIN_CHANGE_MS) || elapsed >= INPUT_HEARTBEAT_MS;
    if (!shouldSend) return;

    this.inputSeq = (this.inputSeq + 1) & 0xffff;
    this.lastInputSentAtMs = nowMs;
    this.lastSentDx = dx;
    this.lastSentDy = dy;
    this.lastSentAimAngle = aimAngle;
    this.lastSentManualAim = manualAim;

    const encoded = encodeClientInput(
      { dx, dy, aimAngle, manualAim, seq: this.inputSeq },
      this.inputEncodeBuf
    );
    try {
      this.ws.send(encoded);
    } catch {
      // Socket close handler will manage reconnect
    }
  }

  /**
   * Sends an immediate 2-byte binary `PICK_UPGRADE` choice (`0 | 1 | 2`).
   */
  public sendPickUpgrade(choiceIndex: UpgradeChoiceIndex): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.inActiveMatch) {
      return false;
    }
    const encoded = encodePickUpgrade(choiceIndex, this.pickUpgradeEncodeBuf);
    try {
      this.ws.send(encoded);
      return true;
    } catch {
      return false;
    }
  }

  // ==========================================================================
  // 60 FPS INTERPOLATION & GENTLE LOCAL PREDICTION / RECONCILIATION
  // ==========================================================================

  public triggerEnemyHitFlash(enemyId: number, durationSec = 0.11): void {
    this.enemyHitFlashes.set(enemyId, durationSec);
  }

  public triggerPlayerHitFlash(slotId: number, durationSec = 0.16): void {
    this.playerHitFlashes.set(slotId, durationSec);
  }

  /**
   * Produces a smooth 60 FPS interpolated world view between the latest two
   * authoritative server snapshots, applying gentle local prediction and smooth
   * reconciliation for the local player's own hero movement.
   */
  public sampleInterpolatedWorld(
    nowMs: number,
    dt: number,
    localMoveX: number,
    localMoveY: number,
    localMoveSpeed: number
  ): InterpolatedWorldState | null {
    const curr = this.currFrame;
    if (!curr) return null;
    const prev = this.prevFrame;

    // Decay transient hit flashes
    for (const [id, timer] of this.enemyHitFlashes) {
      const next = timer - dt;
      if (next <= 0) this.enemyHitFlashes.delete(id);
      else this.enemyHitFlashes.set(id, next);
    }
    for (const [id, timer] of this.playerHitFlashes) {
      const next = timer - dt;
      if (next <= 0) this.playerHitFlashes.delete(id);
      else this.playerHitFlashes.set(id, next);
    }

    // Interpolation factor between prev snapshot (0) and curr snapshot (1)
    const interval = Math.max(25, Math.min(120, this.smoothedTickIntervalMs));
    const rawAlpha = (nowMs - curr.receivedAtMs) / interval;
    const alpha = prev ? Math.max(0, Math.min(1.05, rawAlpha)) : 1;
    const clampedAlpha = Math.max(0, Math.min(1, alpha));

    const snap = curr.snapshot;
    const selfSlotId = this.slotId || snap.selfPlayerId;

    // 1. Interpolate players + gentle local prediction for self
    const players: InterpolatedPlayer[] = [];
    for (let i = 0; i < snap.players.length; i++) {
      const cp = snap.players[i];
      const pp = prev?.playersById.get(cp.id);
      const isLocal = cp.id === selfSlotId;
      const isDowned = (cp.stateFlags & WirePlayerFlag.DOWNED) !== 0;

      let x = pp ? lerp(pp.x, cp.x, clampedAlpha) : cp.x;
      let y = pp ? lerp(pp.y, cp.y, clampedAlpha) : cp.y;
      const aimAngle = pp ? lerpAngle(pp.aimAngle, cp.aimAngle, clampedAlpha) : cp.aimAngle;

      if (isLocal) {
        if (!this.hasPredictedSelf) {
          this.predictedSelfX = x;
          this.predictedSelfY = y;
          this.hasPredictedSelf = true;
        } else {
          // Gentle local prediction while alive & moving
          if (!isDowned && (localMoveX !== 0 || localMoveY !== 0)) {
            this.predictedSelfX += localMoveX * localMoveSpeed * dt;
            this.predictedSelfY += localMoveY * localMoveSpeed * dt;
          }

          // Smooth reconciliation toward authoritative server position
          const targetX = this.latestServerSelfX;
          const targetY = this.latestServerSelfY;
          const errDist = Math.hypot(targetX - this.predictedSelfX, targetY - this.predictedSelfY);
          if (errDist > TELEPORT_SNAP_DIST) {
            this.predictedSelfX = targetX;
            this.predictedSelfY = targetY;
          } else {
            // Pull gently when moving, slightly faster when stationary so hero settles cleanly
            const pullRate = localMoveX === 0 && localMoveY === 0 ? 14 : 8.5;
            const reconcileAlpha = 1 - Math.exp(-pullRate * dt);
            this.predictedSelfX += (targetX - this.predictedSelfX) * reconcileAlpha;
            this.predictedSelfY += (targetY - this.predictedSelfY) * reconcileAlpha;
          }
        }
        x = this.predictedSelfX;
        y = this.predictedSelfY;
      }

      // Compute smooth walk cycle from positional movement
      const lastPos = this.playerPrevPos.get(cp.id);
      const movedDist = lastPos ? Math.hypot(x - lastPos.x, y - lastPos.y) : 0;
      const isMoving =
        !isDowned && (movedDist > 0.35 || (isLocal && (localMoveX !== 0 || localMoveY !== 0)));
      this.playerPrevPos.set(cp.id, { x, y });

      let walkTime = this.playerWalkTimes.get(cp.id) ?? 0;
      if (isMoving) {
        walkTime += dt;
      } else {
        walkTime = 0;
      }
      this.playerWalkTimes.set(cp.id, walkTime);

      const lobbyInfo = this.getLobbyPlayerBySlot(cp.id);
      players.push({
        id: cp.id,
        x,
        y,
        aimAngle,
        hpPct: cp.hpPct,
        level: cp.level,
        stateFlags: cp.stateFlags,
        classId: cp.classId,
        revivePct: cp.revivePct,
        walkTime,
        isMoving,
        name: lobbyInfo?.name ?? `P${cp.id}`,
        isLocal,
        hitFlashTimer: this.playerHitFlashes.get(cp.id) ?? 0,
      });
    }

    // 2. Interpolate enemies
    const enemies: InterpolatedEnemy[] = [];
    const aliveEnemyIds = new Set<number>();
    for (let i = 0; i < snap.enemies.length; i++) {
      const ce = snap.enemies[i];
      aliveEnemyIds.add(ce.id);
      const pe = prev?.enemiesById.get(ce.id);
      const x = pe ? lerp(pe.x, ce.x, clampedAlpha) : ce.x;
      const y = pe ? lerp(pe.y, ce.y, clampedAlpha) : ce.y;
      const walkTime = (this.enemyWalkTimes.get(ce.id) ?? (ce.id % 11) * 0.13) + dt;
      this.enemyWalkTimes.set(ce.id, walkTime);

      enemies.push({
        id: ce.id,
        x,
        y,
        type: ce.type,
        flags: ce.flags,
        hpPct: ce.hpPct,
        walkTime,
        hitFlashTimer: this.enemyHitFlashes.get(ce.id) ?? 0,
      });
    }
    // Prune walk timers of despawned enemies periodically
    if (this.enemyWalkTimes.size > enemies.length + 120) {
      for (const id of this.enemyWalkTimes.keys()) {
        if (!aliveEnemyIds.has(id)) {
          this.enemyWalkTimes.delete(id);
        }
      }
    }

    // 3. Interpolate pickups
    const pickups: InterpolatedPickup[] = [];
    const activePickupIds = new Set<number>();
    for (let i = 0; i < snap.pickups.length; i++) {
      const ci = snap.pickups[i];
      activePickupIds.add(ci.id);
      const pi = prev?.pickupsById.get(ci.id);
      const x = pi ? lerp(pi.x, ci.x, clampedAlpha) : ci.x;
      const y = pi ? lerp(pi.y, ci.y, clampedAlpha) : ci.y;
      const age = (this.pickupAges.get(ci.id) ?? (ci.id % 7) * 0.3) + dt;
      this.pickupAges.set(ci.id, age);

      pickups.push({
        id: ci.id,
        kind: ci.kind,
        x,
        y,
        age,
      });
    }
    if (this.pickupAges.size > pickups.length + 120) {
      for (const id of this.pickupAges.keys()) {
        if (!activePickupIds.has(id)) {
          this.pickupAges.delete(id);
        }
      }
    }

    // 4. Interpolate elapsed time gently between snapshots
    const prevElapsed = prev ? prev.snapshot.elapsedMs : snap.elapsedMs;
    const elapsedMs = prev ? lerp(prevElapsed, snap.elapsedMs, clampedAlpha) : snap.elapsedMs;

    // Combine snapshot personal XP with any standalone PERSONAL_XP packet
    const selfXp = this.latestPersonalXp ? this.latestPersonalXp.xp : snap.selfXp;
    const selfXpToNext = this.latestPersonalXp
      ? this.latestPersonalXp.xpToNext
      : snap.selfXpToNext;

    return {
      tick: snap.tick,
      elapsedSec: elapsedMs / 1000,
      kills: snap.kills,
      bossesDefeated: snap.bossesDefeated,
      nextBossSec: snap.nextBossSec,
      paceMode: snap.paceMode,
      state: snap.state,
      selfSlotId,
      selfXp,
      selfXpToNext: Math.max(1, selfXpToNext),
      selfPendingUpgrades: snap.selfPendingUpgrades,
      boss: snap.boss,
      players,
      enemies,
      pickups,
    };
  }

  // ==========================================================================
  // INTERNAL WEBSOCKET LIFECYCLE, HEARTBEAT & AUTO-RECONNECT
  // ==========================================================================

  private openSocket(isReconnectAttempt: boolean): void {
    this.clearTimers();
    this.intentionalClose = false;
    this.setConnectionState(isReconnectAttempt ? 'reconnecting' : 'connecting');

    if (this.ws) {
      try {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onerror = null;
        this.ws.onclose = null;
        this.ws.close();
      } catch {
        // Ignore stale close
      }
      this.ws = null;
    }

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.serverUrl);
    } catch {
      if (isReconnectAttempt) {
        this.scheduleReconnect();
      } else {
        this.setConnectionState('disconnected');
        this.callbacks.onError?.(
          'CONNECTION_FAILED',
          `Invalid or unreachable server URL: ${this.serverUrl}`
        );
      }
      return;
    }

    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.lastServerMessageMs = performance.now();
      this.startHeartbeat();

      if (isReconnectAttempt && this.roomCode && this.reconnectToken) {
        this.sendJson({
          type: 'RECONNECT',
          roomCode: this.roomCode,
          reconnectToken: this.reconnectToken,
        });
      } else {
        this.setConnectionState('connected');
        if (this.pendingInitialCommand) {
          const cmd = this.pendingInitialCommand;
          this.pendingInitialCommand = null;
          this.sendJson(cmd);
        }
      }
    };

    ws.onmessage = (event: MessageEvent) => {
      if (this.ws !== ws) return;
      this.lastServerMessageMs = performance.now();

      if (event.data instanceof ArrayBuffer) {
        this.handleBinaryMessage(event.data);
      } else if (typeof event.data === 'string') {
        this.handleTextMessage(event.data);
      } else if (event.data instanceof Blob) {
        void event.data.arrayBuffer().then((buf) => {
          if (this.ws === ws) {
            this.handleBinaryMessage(buf);
          }
        });
      }
    };

    ws.onerror = () => {
      // Browser always fires 'close' after 'error'; handle transition in onclose.
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopHeartbeat();

      if (this.intentionalClose) {
        this.setConnectionState('disconnected');
        return;
      }

      // Attempt automatic silent reconnect if we have an active room session & token
      if (this.roomCode && this.reconnectToken && this.inActiveMatch) {
        this.scheduleReconnect();
        return;
      }

      const wasConnecting = this.connectionState === 'connecting';
      this.setConnectionState('disconnected');
      if (wasConnecting) {
        this.callbacks.onError?.(
          'CONNECTION_FAILED',
          `Could not connect to server (${this.serverUrl}).`
        );
      } else if (this.roomCode) {
        this.callbacks.onError?.('DISCONNECTED', 'Disconnected from room server.');
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose || !this.roomCode || !this.reconnectToken) {
      this.setConnectionState('disconnected');
      return;
    }

    const now = performance.now();
    if (this.reconnectStartedAtMs === 0) {
      this.reconnectStartedAtMs = now;
      this.reconnectAttempt = 0;
    }

    if (now - this.reconnectStartedAtMs >= RECONNECT_MAX_WINDOW_MS) {
      this.reconnectStartedAtMs = 0;
      this.reconnectAttempt = 0;
      this.inActiveMatch = false;
      this.setConnectionState('disconnected');
      this.callbacks.onReconnectFailed?.('Connection lost — reconnect grace period expired.');
      return;
    }

    this.setConnectionState('reconnecting');
    const delayMs =
      RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempt += 1;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.intentionalClose && this.roomCode && this.reconnectToken) {
        this.openSocket(true);
      }
    }, delayMs);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

      const now = performance.now();
      if (now - this.lastServerMessageMs > STALE_CONNECTION_MS) {
        // Force-close dead mobile socket so silent reconnect triggers promptly
        try {
          this.ws.close(4000, 'Heartbeat timeout');
        } catch {
          // Ignore
        }
        return;
      }

      this.lastPingSentMs = now;
      this.sendJson({ type: 'PING', ts: Date.now() });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearTimers(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private sendJson(msg: ClientControlMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      // Ignore send errors on closing sockets
    }
  }

  private setConnectionState(next: NetConnectionState): void {
    if (this.connectionState === next) return;
    this.connectionState = next;
    this.callbacks.onConnectionStateChange?.(next);
  }

  private resetSessionState(): void {
    this.roomCode = null;
    this.playerId = null;
    this.slotId = 0;
    this.reconnectToken = null;
    this.isHost = false;
    this.roomState = null;
    this.inActiveMatch = false;
    this.reconnectStartedAtMs = 0;
    this.reconnectAttempt = 0;
    this.inputSeq = 0;
    this.lastInputSentAtMs = 0;
    this.resetInterpolationState();
  }

  private resetInterpolationState(): void {
    this.prevFrame = null;
    this.currFrame = null;
    this.smoothedTickIntervalMs = DEFAULT_TICK_INTERVAL_MS;
    this.hasPredictedSelf = false;
    this.predictedSelfX = 0;
    this.predictedSelfY = 0;
    this.latestServerSelfX = 0;
    this.latestServerSelfY = 0;
    this.latestPersonalXp = null;
    this.playerWalkTimes.clear();
    this.playerPrevPos.clear();
    this.playerHitFlashes.clear();
    this.enemyWalkTimes.clear();
    this.enemyHitFlashes.clear();
    this.pickupAges.clear();
  }

  // ==========================================================================
  // INCOMING MESSAGE HANDLERS
  // ==========================================================================

  private handleBinaryMessage(buffer: ArrayBuffer): void {
    const opcode = peekBinaryOpcode(buffer);
    if (opcode === null) return;

    try {
      switch (opcode) {
        case BinaryOpcode.SNAPSHOT: {
          const snap = decodeSnapshot(buffer);
          this.ingestSnapshot(snap);
          break;
        }
        case BinaryOpcode.PERSONAL_XP: {
          const pkt = decodePersonalXp(buffer);
          this.latestPersonalXp = pkt;
          this.callbacks.onPersonalXp?.(pkt);
          break;
        }
        case BinaryOpcode.EVENTS: {
          const events = decodeBinaryEvents(buffer);
          if (events.length > 0) {
            this.callbacks.onBinaryEvents?.(events);
          }
          break;
        }
        default:
          break;
      }
    } catch (err) {
      // Log malformed/mismatched binary frames so protocol drift is visible
      console.warn('[NetClient] Failed to decode binary frame:', err);
    }
  }

  private ingestSnapshot(snapshot: WireSnapshot): void {
    const now = performance.now();
    const prevSnapshot = this.currFrame?.snapshot ?? null;

    if (this.currFrame) {
      const deltaMs = now - this.currFrame.receivedAtMs;
      if (deltaMs >= 16 && deltaMs <= 160) {
        this.smoothedTickIntervalMs = lerp(this.smoothedTickIntervalMs, deltaMs, 0.2);
      }
    }

    const playersById = new Map<number, WirePlayerState>();
    for (let i = 0; i < snapshot.players.length; i++) {
      const p = snapshot.players[i];
      playersById.set(p.id, p);
    }

    const enemiesById = new Map<number, WireEnemyState>();
    for (let i = 0; i < snapshot.enemies.length; i++) {
      const e = snapshot.enemies[i];
      enemiesById.set(e.id, e);
    }

    const pickupsById = new Map<number, WirePickupState>();
    for (let i = 0; i < snapshot.pickups.length; i++) {
      const item = snapshot.pickups[i];
      pickupsById.set(item.id, item);
    }

    this.prevFrame = this.currFrame;
    this.currFrame = {
      snapshot,
      receivedAtMs: now,
      playersById,
      enemiesById,
      pickupsById,
    };

    // Snapshot carries authoritative personal XP; clear any older standalone XP override
    this.latestPersonalXp = null;

    const selfSlotId = this.slotId || snapshot.selfPlayerId;
    const selfPlayer = playersById.get(selfSlotId);
    if (selfPlayer) {
      this.latestServerSelfX = selfPlayer.x;
      this.latestServerSelfY = selfPlayer.y;
      if (!this.hasPredictedSelf) {
        this.predictedSelfX = selfPlayer.x;
        this.predictedSelfY = selfPlayer.y;
        this.hasPredictedSelf = true;
      }
    }

    this.callbacks.onSnapshot?.(snapshot, prevSnapshot);
  }

  private handleTextMessage(raw: string): void {
    let msg: ServerControlMessage;
    try {
      msg = JSON.parse(raw) as ServerControlMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case 'PING': {
        this.sendJson({ type: 'PONG', ts: msg.ts });
        break;
      }

      case 'PONG': {
        if (this.lastPingSentMs > 0) {
          const rtt = Math.round(performance.now() - this.lastPingSentMs);
          if (rtt >= 0 && rtt < 5000) {
            this.rttMs = rtt;
          }
        }
        break;
      }

      case 'ROOM_JOINED': {
        if (
          typeof msg.protocolVersion === 'number' &&
          msg.protocolVersion !== PROTOCOL_VERSION
        ) {
          this.callbacks.onError?.(
            'VERSION_MISMATCH',
            'A newer game update is live — please hard-refresh the page.'
          );
        }
        this.roomCode = msg.roomCode;
        this.playerId = msg.playerId;
        this.slotId = msg.slotId;
        this.reconnectToken = msg.reconnectToken;
        this.isHost = msg.isHost;
        this.roomState = msg.roomState;
        this.inActiveMatch = msg.roomState.status === 'playing';
        this.setConnectionState('connected');
        this.callbacks.onRoomJoined?.(msg);
        this.callbacks.onRoomState?.(msg.roomState);
        break;
      }

      case 'ROOM_STATE': {
        this.roomState = msg.roomState;
        if (this.playerId) {
          this.isHost = msg.roomState.hostPlayerId === this.playerId;
        }
        this.callbacks.onRoomState?.(msg.roomState);
        break;
      }

      case 'MATCH_STARTED': {
        this.roomState = msg.roomState;
        this.inActiveMatch = true;
        this.resetInterpolationState();
        this.callbacks.onMatchStarted?.(msg);
        break;
      }

      case 'RECONNECTED': {
        this.roomCode = msg.roomCode;
        this.playerId = msg.playerId;
        this.slotId = msg.slotId;
        this.reconnectToken = msg.reconnectToken;
        this.isHost = msg.isHost;
        this.roomState = msg.roomState;
        this.inActiveMatch = msg.roomState.status === 'playing';
        this.reconnectStartedAtMs = 0;
        this.reconnectAttempt = 0;
        this.prevFrame = null;
        this.hasPredictedSelf = false;
        this.setConnectionState('connected');
        this.callbacks.onReconnected?.(msg);
        this.callbacks.onRoomState?.(msg.roomState);
        break;
      }

      case 'PLAYER_DISCONNECTED':
      case 'PLAYER_RECONNECTED':
      case 'PLAYER_LEFT': {
        if (msg.type === 'PLAYER_LEFT' && msg.newHostPlayerId && this.playerId) {
          this.isHost = msg.newHostPlayerId === this.playerId;
        }
        break;
      }

      case 'UpgradeChoices': {
        this.callbacks.onUpgradeChoices?.(msg);
        break;
      }

      case 'UpgradeApplied': {
        this.callbacks.onUpgradeApplied?.(msg);
        break;
      }

      case 'GameOver': {
        this.inActiveMatch = false;
        this.callbacks.onGameOver?.(msg);
        break;
      }

      case 'Victory': {
        this.inActiveMatch = false;
        this.callbacks.onVictory?.(msg);
        break;
      }

      case 'ERROR': {
        // If a reconnect attempt failed permanently (room gone / token expired), stop reconnecting
        if (
          this.connectionState === 'reconnecting' &&
          (msg.code === 'ROOM_NOT_FOUND' || msg.code === 'INVALID_TOKEN')
        ) {
          this.inActiveMatch = false;
          this.reconnectToken = null;
          this.clearTimers();
          this.setConnectionState('disconnected');
          this.callbacks.onReconnectFailed?.(msg.message);
          return;
        }
        this.callbacks.onError?.(msg.code, msg.message);
        break;
      }
    }
  }
}
