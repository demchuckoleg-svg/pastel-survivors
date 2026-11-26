import type { HeroId } from '../shared/data/types';
import {
  GameSimulation,
  MAX_PLAYERS,
  type PlayerInitConfig,
} from '../shared/sim/simulation';
import type { SimEvent } from '../shared/sim/events';
import type {
  ClientMessage,
  PersonalUpgradePayload,
  PlayerId,
  PlayerInput,
  RoomPaceMode,
  RoomSnapshot,
  UpgradeChoiceIndex,
} from '../shared/sim/types';

export interface LobbyMember {
  id: PlayerId;
  heroId: HeroId;
  ready: boolean;
}

export interface CoopRoomOptions {
  roomId: string;
  seed?: number;
  paceMode?: RoomPaceMode;
}

export interface RoomTickResult {
  snapshot: RoomSnapshot;
  events: SimEvent[];
  personalUpgrades: Map<PlayerId, PersonalUpgradePayload>;
}

const DEFAULT_INPUT: PlayerInput = {
  moveX: 0,
  moveY: 0,
  aimMode: 'auto',
};

/**
 * Authoritative 1–4 player Co-op Room controller backed by the headless `GameSimulation`.
 *
 * Responsibilities:
 * - Lobby roster & pace mode (`standard` vs `coop_pace`, default `coop_pace`)
 * - Per-player input buffering & `PICK_UPGRADE (0/1/2)` message handling
 * - Zero-pause live co-op stepping with authoritative `RoomSnapshot` broadcasts
 * - Private per-player `PersonalUpgradePayload` updates (active 3 choices + `pendingQueueCount`)
 */
export class CoopRoom {
  public readonly roomId: string;
  public readonly sim: GameSimulation;

  private readonly seed?: number;
  private readonly lobby = new Map<PlayerId, LobbyMember>();
  private readonly inputs = new Map<PlayerId, PlayerInput>();
  private readonly lastDeliveredBatchId = new Map<PlayerId, number>();
  private readonly lastDeliveredQueueCount = new Map<PlayerId, number>();
  private paceMode: RoomPaceMode;
  private started = false;

  constructor(options: CoopRoomOptions) {
    this.roomId = options.roomId;
    this.seed = options.seed;
    this.paceMode = options.paceMode ?? 'coop_pace';
    this.sim = new GameSimulation(options.seed);
    this.sim.setPaceMode(this.paceMode);
  }

  public getPaceMode(): RoomPaceMode {
    return this.paceMode;
  }

  public setPaceMode(paceMode: RoomPaceMode): void {
    if (this.started) return;
    this.paceMode = paceMode;
    this.sim.setPaceMode(paceMode);
  }

  public isStarted(): boolean {
    return this.started;
  }

  public getLobbyMembers(): LobbyMember[] {
    return Array.from(this.lobby.values());
  }

  public addPlayer(id: PlayerId, heroId: HeroId): boolean {
    if (this.started) return false;
    if (this.lobby.size >= MAX_PLAYERS && !this.lobby.has(id)) return false;
    this.lobby.set(id, { id, heroId, ready: false });
    this.inputs.set(id, { ...DEFAULT_INPUT });
    return true;
  }

  public removePlayer(id: PlayerId): SimEvent[] {
    this.lobby.delete(id);
    this.inputs.delete(id);
    this.lastDeliveredBatchId.delete(id);
    this.lastDeliveredQueueCount.delete(id);
    if (this.started) {
      return this.sim.removePlayer(id);
    }
    return [];
  }

  public startMatch(seedOverride?: number): RoomTickResult {
    const roster: PlayerInitConfig[] = Array.from(this.lobby.values()).map((m) => ({
      id: m.id,
      heroId: m.heroId,
    }));
    if (roster.length === 0) {
      throw new Error('Cannot start a Co-op room with zero players');
    }

    this.lastDeliveredBatchId.clear();
    this.lastDeliveredQueueCount.clear();
    const events = this.sim.startRun(roster, {
      seed: seedOverride ?? this.seed,
      mode: 'coop',
      paceMode: this.paceMode,
      asyncLevelUps: true,
    });
    this.started = true;

    return {
      snapshot: this.sim.getRoomSnapshot(),
      events,
      personalUpgrades: this.collectDirtyPersonalUpgrades(),
    };
  }

  public setPlayerInput(playerId: PlayerId, input: PlayerInput): void {
    this.inputs.set(playerId, input);
  }

  /**
   * Processes a client-to-server protocol message (`INPUT`, `PICK_UPGRADE`, `SET_PACE_MODE`).
   * Returns any immediate simulation events and updated personal upgrade payload if changed.
   */
  public handleClientMessage(
    playerId: PlayerId,
    msg: ClientMessage
  ): { events: SimEvent[]; personalUpgrade: PersonalUpgradePayload | null } {
    switch (msg.type) {
      case 'INPUT': {
        this.inputs.set(playerId, msg.input);
        return { events: [], personalUpgrade: null };
      }

      case 'SET_PACE_MODE': {
        this.setPaceMode(msg.paceMode);
        return { events: [], personalUpgrade: null };
      }

      case 'PICK_UPGRADE': {
        return this.handlePickUpgrade(playerId, msg.choiceIndex);
      }
    }
  }

  public handlePickUpgrade(
    playerId: PlayerId,
    choiceIndex: UpgradeChoiceIndex
  ): { events: SimEvent[]; personalUpgrade: PersonalUpgradePayload | null } {
    if (!this.started) {
      return { events: [], personalUpgrade: null };
    }
    const events = this.sim.pickUpgrade(playerId, choiceIndex);
    const nextPayload = this.sim.getPersonalUpgradePayload(playerId);
    if (nextPayload) {
      this.lastDeliveredBatchId.set(playerId, nextPayload.batchId);
      this.lastDeliveredQueueCount.set(playerId, nextPayload.pendingQueueCount);
    } else {
      this.lastDeliveredBatchId.delete(playerId);
      this.lastDeliveredQueueCount.delete(playerId);
    }
    return { events, personalUpgrade: nextPayload };
  }

  public step(dt: number): RoomTickResult {
    const events = this.sim.step(dt, this.inputs);
    return {
      snapshot: this.sim.getRoomSnapshot(),
      events,
      personalUpgrades: this.collectDirtyPersonalUpgrades(),
    };
  }

  public getSnapshot(): RoomSnapshot {
    return this.sim.getRoomSnapshot();
  }

  public getPersonalUpgradePayload(playerId: PlayerId): PersonalUpgradePayload | null {
    return this.sim.getPersonalUpgradePayload(playerId);
  }

  private collectDirtyPersonalUpgrades(): Map<PlayerId, PersonalUpgradePayload> {
    const out = new Map<PlayerId, PersonalUpgradePayload>();
    for (const p of this.sim.players.values()) {
      const payload = this.sim.getPersonalUpgradePayload(p.id);
      if (!payload) {
        this.lastDeliveredBatchId.delete(p.id);
        this.lastDeliveredQueueCount.delete(p.id);
        continue;
      }
      const prevBatch = this.lastDeliveredBatchId.get(p.id);
      const prevQueue = this.lastDeliveredQueueCount.get(p.id);
      if (prevBatch !== payload.batchId || prevQueue !== payload.pendingQueueCount) {
        this.lastDeliveredBatchId.set(p.id, payload.batchId);
        this.lastDeliveredQueueCount.set(p.id, payload.pendingQueueCount);
        out.set(p.id, payload);
      }
    }
    return out;
  }
}
