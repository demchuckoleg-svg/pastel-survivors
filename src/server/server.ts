import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import {
  BinaryOpcode,
  decodePickUpgrade,
  isValidHeroId,
  isValidPaceMode,
  normalizeRoomCode,
  peekBinaryOpcode,
  type ClientControlMessage,
  type ServerControlMessage,
} from '../shared/protocol';
import type { PlayerId } from '../shared/sim/types';
import { DEFAULT_RECONNECT_GRACE_MS, type GameRoom } from './gameRoom';
import { RoomManager, type RoomManagerOptions } from './roomManager';

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const MAX_WS_PAYLOAD_BYTES = 16 * 1024;
const DEFAULT_CORS_ORIGIN = 'https://localhost';

interface SocketSessionMeta {
  isAlive: boolean;
  room: GameRoom | null;
  playerId: PlayerId | null;
}

export interface GameServerOptions extends RoomManagerOptions {
  port?: number;
  host?: string;
  heartbeatIntervalMs?: number;
}

export interface GameServerHandle {
  readonly httpServer: http.Server;
  readonly wss: WebSocketServer;
  readonly roomManager: RoomManager;
  listen: (port?: number, host?: string) => Promise<number>;
  close: () => Promise<void>;
  getPort: () => number;
}

function rawDataToUint8Array(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (Array.isArray(data)) {
    const merged = Buffer.concat(data);
    return new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength);
  }
  return new Uint8Array(0);
}

function rawDataToUtf8(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return '';
}

function applyCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  // Reflect explicit origins (including Capacitor's https://localhost & capacitor://localhost)
  // and default to https://localhost when no Origin header is sent.
  res.setHeader('Access-Control-Allow-Origin', origin || DEFAULT_CORS_ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function sendJson(ws: WebSocket, msg: ServerControlMessage): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Ignore errors on closing sockets
  }
}

function sendError(ws: WebSocket, code: string, message: string): void {
  sendJson(ws, { type: 'ERROR', code, message });
}

/**
 * Creates the authoritative Pastel Survivors HTTP + WebSocket multiplayer server.
 *
 * - HTTP `GET /health`: returns `200 OK` JSON with active rooms, players, and uptime
 * - HTTP CORS headers supporting Capacitor Android (`https://localhost`) and web origins
 * - WebSocket endpoint on `/ws` allowing cross-origin upgrades
 * - 10-second `ping/pong` heartbeat with 20-second mid-match reconnect grace period
 */
export function createGameServer(options: GameServerOptions = {}): GameServerHandle {
  const configuredPort = options.port ?? Number(process.env.PORT || 3000);
  const configuredHost = options.host ?? '0.0.0.0';
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

  const roomManager = new RoomManager({
    reconnectGraceMs: options.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS,
    cleanupIntervalMs: options.cleanupIntervalMs,
    staleLobbyMs: options.staleLobbyMs,
    staleFinishedMs: options.staleFinishedMs,
    maxRooms: options.maxRooms,
  });

  const socketMeta = new WeakMap<WebSocket, SocketSessionMeta>();

  const httpServer = http.createServer((req, res) => {
    applyCorsHeaders(req, res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') {
      const stats = roomManager.getHealthStats();
      const body = JSON.stringify(stats);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WS_PAYLOAD_BYTES,
  });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    // Cross-origin WebSocket upgrades (including Capacitor https://localhost) are explicitly allowed.
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    const meta: SocketSessionMeta = {
      isAlive: true,
      room: null,
      playerId: null,
    };
    socketMeta.set(ws, meta);

    ws.on('pong', () => {
      meta.isAlive = true;
    });

    ws.on('message', (data: RawData, isBinary: boolean) => {
      meta.isAlive = true;

      if (isBinary) {
        handleBinaryMessage(ws, meta, data);
      } else {
        handleTextMessage(ws, meta, data);
      }
    });

    ws.on('close', () => {
      if (meta.room && meta.playerId) {
        const room = meta.room;
        const playerId = meta.playerId;
        meta.room = null;
        meta.playerId = null;
        room.handleSocketClose(playerId, ws);
      }
    });

    ws.on('error', () => {
      // 'close' event will follow and invoke cleanup
    });
  });

  function leaveCurrentRoomIfAny(ws: WebSocket, meta: SocketSessionMeta): void {
    if (meta.room && meta.playerId) {
      const prevRoom = meta.room;
      const prevPlayerId = meta.playerId;
      meta.room = null;
      meta.playerId = null;
      prevRoom.handleSocketClose(prevPlayerId, ws);
    }
  }

  function handleBinaryMessage(
    ws: WebSocket,
    meta: SocketSessionMeta,
    data: RawData
  ): void {
    if (!meta.room || !meta.playerId) return;

    const bytes = rawDataToUint8Array(data);
    const opcode = peekBinaryOpcode(bytes);
    if (opcode === null) return;

    switch (opcode) {
      case BinaryOpcode.INPUT:
        meta.room.handleBinaryInput(meta.playerId, bytes);
        break;

      case BinaryOpcode.PICK_UPGRADE: {
        try {
          const { choiceIndex } = decodePickUpgrade(bytes);
          meta.room.handlePickUpgrade(meta.playerId, choiceIndex);
        } catch {
          sendError(ws, 'INVALID_UPGRADE_PICK', 'Invalid PICK_UPGRADE payload.');
        }
        break;
      }

      default:
        break;
    }
  }

  function handleTextMessage(
    ws: WebSocket,
    meta: SocketSessionMeta,
    data: RawData
  ): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawDataToUtf8(data));
    } catch {
      sendError(ws, 'INVALID_JSON', 'Malformed JSON control message.');
      return;
    }

    if (!parsed || typeof parsed !== 'object' || typeof (parsed as { type?: unknown }).type !== 'string') {
      sendError(ws, 'INVALID_MESSAGE', 'Missing control message type.');
      return;
    }

    const msg = parsed as ClientControlMessage;

    switch (msg.type) {
      case 'PING': {
        sendJson(ws, { type: 'PONG', ts: msg.ts, serverTime: Date.now() });
        break;
      }

      case 'PONG': {
        meta.isAlive = true;
        break;
      }

      case 'CREATE_ROOM': {
        leaveCurrentRoomIfAny(ws, meta);
        const heroId = isValidHeroId(msg.heroId) ? msg.heroId : 'mage';
        const paceMode = isValidPaceMode(msg.paceMode) ? msg.paceMode : 'coop_pace';
        const room = roomManager.createRoom(paceMode);
        if (!room) {
          sendError(ws, 'SERVER_FULL', 'Server has reached maximum active rooms.');
          return;
        }
        const added = room.addPlayer(ws, heroId, msg.name);
        if (!added.ok) {
          roomManager.deleteRoom(room.roomCode);
          sendError(ws, added.code, added.message);
          return;
        }
        meta.room = room;
        meta.playerId = added.session.playerId;
        break;
      }

      case 'JOIN_ROOM': {
        const roomCode = normalizeRoomCode(msg.roomCode);
        if (!roomCode) {
          sendError(ws, 'INVALID_ROOM_CODE', 'Room code must be 4 valid uppercase characters.');
          return;
        }
        const room = roomManager.getRoom(roomCode);
        if (!room) {
          sendError(ws, 'ROOM_NOT_FOUND', `Room ${roomCode} does not exist.`);
          return;
        }
        leaveCurrentRoomIfAny(ws, meta);
        const heroId = isValidHeroId(msg.heroId) ? msg.heroId : 'mage';
        const added = room.addPlayer(ws, heroId, msg.name);
        if (!added.ok) {
          sendError(ws, added.code, added.message);
          return;
        }
        meta.room = room;
        meta.playerId = added.session.playerId;
        break;
      }

      case 'SELECT_CLASS': {
        if (!meta.room || !meta.playerId) {
          sendError(ws, 'NOT_IN_ROOM', 'Join a room before selecting a class.');
          return;
        }
        if (!isValidHeroId(msg.heroId)) {
          sendError(ws, 'INVALID_CLASS', 'Invalid hero class id.');
          return;
        }
        meta.room.selectClass(meta.playerId, msg.heroId);
        break;
      }

      case 'TOGGLE_READY': {
        if (!meta.room || !meta.playerId) {
          sendError(ws, 'NOT_IN_ROOM', 'Join a room before toggling ready.');
          return;
        }
        meta.room.toggleReady(meta.playerId, msg.ready);
        break;
      }

      case 'SET_PACE': {
        if (!meta.room || !meta.playerId) {
          sendError(ws, 'NOT_IN_ROOM', 'Join a room before setting pace.');
          return;
        }
        if (!isValidPaceMode(msg.paceMode)) {
          sendError(ws, 'INVALID_PACE', 'Pace mode must be standard or coop_pace.');
          return;
        }
        if (!meta.room.setPaceMode(meta.playerId, msg.paceMode)) {
          sendError(ws, 'NOT_HOST', 'Only the room host can change pace mode in lobby.');
        }
        break;
      }

      case 'START_MATCH': {
        if (!meta.room || !meta.playerId) {
          sendError(ws, 'NOT_IN_ROOM', 'Join a room before starting a match.');
          return;
        }
        const started = meta.room.startMatch(meta.playerId);
        if (!started.ok) {
          sendError(ws, started.code, started.message);
        }
        break;
      }

      case 'RECONNECT': {
        const roomCode = normalizeRoomCode(msg.roomCode);
        if (!roomCode || typeof msg.reconnectToken !== 'string' || msg.reconnectToken.length === 0) {
          sendError(ws, 'INVALID_RECONNECT', 'Valid roomCode and reconnectToken are required.');
          return;
        }
        const room = roomManager.getRoom(roomCode);
        if (!room) {
          sendError(ws, 'ROOM_NOT_FOUND', `Room ${roomCode} no longer exists.`);
          return;
        }
        leaveCurrentRoomIfAny(ws, meta);
        const reconnected = room.reconnectPlayer(msg.reconnectToken, ws);
        if (!reconnected.ok) {
          sendError(ws, reconnected.code, reconnected.message);
          return;
        }
        meta.room = room;
        meta.playerId = reconnected.session.playerId;
        break;
      }

      default: {
        sendError(ws, 'UNKNOWN_MESSAGE', 'Unsupported control message type.');
        break;
      }
    }
  }

  // 10-second mobile heartbeat loop (native WS ping + JSON PING resilience)
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  if (heartbeatIntervalMs > 0) {
    heartbeatTimer = setInterval(() => {
      for (const ws of wss.clients) {
        const meta = socketMeta.get(ws);
        if (!meta) continue;
        if (!meta.isAlive) {
          ws.terminate();
          continue;
        }
        meta.isAlive = false;
        try {
          ws.ping();
        } catch {
          ws.terminate();
        }
      }
    }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
  }

  let actualPort = configuredPort;

  async function listen(port = configuredPort, host = configuredHost): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        httpServer.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        httpServer.off('error', onError);
        const addr = httpServer.address();
        if (addr && typeof addr === 'object') {
          actualPort = (addr as AddressInfo).port;
        } else {
          actualPort = port;
        }
        resolve(actualPort);
      };
      httpServer.once('error', onError);
      httpServer.once('listening', onListening);
      httpServer.listen(port, host);
    });
  }

  async function close(): Promise<void> {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    roomManager.shutdown();
    for (const ws of wss.clients) {
      try {
        ws.terminate();
      } catch {
        // Ignore
      }
    }
    await new Promise<void>((resolve) => {
      wss.close(() => {
        if (httpServer.listening) {
          httpServer.close(() => resolve());
        } else {
          resolve();
        }
      });
    });
  }

  return {
    httpServer,
    wss,
    roomManager,
    listen,
    close,
    getPort: () => actualPort,
  };
}
