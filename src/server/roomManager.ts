import crypto from 'node:crypto';
import {
  normalizeRoomCode,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
} from '../shared/protocol';
import type { RoomPaceMode } from '../shared/sim/types';
import { DEFAULT_RECONNECT_GRACE_MS, GameRoom } from './gameRoom';

const DEFAULT_CLEANUP_INTERVAL_MS = 30_000;
const DEFAULT_STALE_LOBBY_MS = 30 * 60_000; // 30 minutes
const DEFAULT_STALE_FINISHED_MS = 5 * 60_000; // 5 minutes
const DEFAULT_MAX_ROOMS = 200;

export interface RoomManagerOptions {
  reconnectGraceMs?: number;
  cleanupIntervalMs?: number;
  staleLobbyMs?: number;
  staleFinishedMs?: number;
  maxRooms?: number;
}

export interface HealthStats {
  status: 'ok';
  activeRooms: number;
  activeMatches: number;
  activePlayers: number;
  connectedPlayers: number;
  uptimeSec: number;
  timestamp: string;
}

/**
 * Manages active 4-character uppercase room codes, lifecycle cleanup of empty
 * and stale rooms, and runtime health telemetry.
 */
export class RoomManager {
  private readonly rooms = new Map<string, GameRoom>();
  private readonly startedAtMs = Date.now();
  private readonly reconnectGraceMs: number;
  private readonly staleLobbyMs: number;
  private readonly staleFinishedMs: number;
  private readonly maxRooms: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: RoomManagerOptions = {}) {
    this.reconnectGraceMs = options.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS;
    this.staleLobbyMs = options.staleLobbyMs ?? DEFAULT_STALE_LOBBY_MS;
    this.staleFinishedMs = options.staleFinishedMs ?? DEFAULT_STALE_FINISHED_MS;
    this.maxRooms = options.maxRooms ?? DEFAULT_MAX_ROOMS;

    const intervalMs = options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
    if (intervalMs > 0) {
      this.cleanupTimer = setInterval(() => this.pruneStaleRooms(), intervalMs);
      this.cleanupTimer.unref?.();
    }
  }

  public generateRoomCode(): string {
    const alphabetLen = ROOM_CODE_ALPHABET.length;
    for (let attempt = 0; attempt < 128; attempt++) {
      const bytes = crypto.randomBytes(ROOM_CODE_LENGTH);
      let code = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
        code += ROOM_CODE_ALPHABET[bytes[i] % alphabetLen];
      }
      if (!this.rooms.has(code)) {
        return code;
      }
    }
    throw new Error('Unable to allocate unique 4-character room code');
  }

  public createRoom(paceMode: RoomPaceMode = 'coop_pace', seed?: number): GameRoom | null {
    if (this.rooms.size >= this.maxRooms) {
      this.pruneStaleRooms();
      if (this.rooms.size >= this.maxRooms) {
        return null;
      }
    }

    const roomCode = this.generateRoomCode();
    const room = new GameRoom({
      roomCode,
      paceMode,
      seed,
      reconnectGraceMs: this.reconnectGraceMs,
      onEmpty: (emptyCode) => this.deleteRoom(emptyCode),
    });
    this.rooms.set(roomCode, room);
    return room;
  }

  public getRoom(rawCode: unknown): GameRoom | undefined {
    const code = normalizeRoomCode(rawCode);
    if (!code) return undefined;
    return this.rooms.get(code);
  }

  public deleteRoom(roomCode: string): void {
    const room = this.rooms.get(roomCode);
    if (!room) return;
    this.rooms.delete(roomCode);
    room.dispose();
  }

  public pruneStaleRooms(now = Date.now()): number {
    let removed = 0;
    for (const [code, room] of this.rooms.entries()) {
      const idleMs = now - room.getLastActivityAt();
      const status = room.getStatus();
      const shouldRemove =
        room.isEmpty() ||
        (status === 'lobby' && idleMs >= this.staleLobbyMs) ||
        ((status === 'gameover' || status === 'victory') && idleMs >= this.staleFinishedMs);

      if (shouldRemove) {
        this.deleteRoom(code);
        removed += 1;
      }
    }
    return removed;
  }

  public getHealthStats(): HealthStats {
    let activeMatches = 0;
    let activePlayers = 0;
    let connectedPlayers = 0;

    for (const room of this.rooms.values()) {
      if (room.getStatus() === 'playing') {
        activeMatches += 1;
      }
      activePlayers += room.getPlayerCount();
      connectedPlayers += room.getConnectedPlayerCount();
    }

    return {
      status: 'ok',
      activeRooms: this.rooms.size,
      activeMatches,
      activePlayers,
      connectedPlayers,
      uptimeSec: Math.floor((Date.now() - this.startedAtMs) / 1000),
      timestamp: new Date().toISOString(),
    };
  }

  public getRoomCount(): number {
    return this.rooms.size;
  }

  public shutdown(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const room of this.rooms.values()) {
      room.dispose();
    }
    this.rooms.clear();
  }
}
