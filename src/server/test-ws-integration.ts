import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket, { type RawData } from 'ws';
import {
  BinaryOpcode,
  decodeBinaryEvents,
  decodeClientInput,
  decodePersonalXp,
  decodePickUpgrade,
  decodeSnapshot,
  encodeBinaryEvents,
  encodeClientInput,
  encodePersonalXp,
  encodePickUpgrade,
  encodeSnapshot,
  patchSnapshotPersonalXp,
  peekBinaryOpcode,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  WireEnemyFlag,
  WirePlayerFlag,
  type BinaryCombatEvent,
  type ClientControlMessage,
  type ServerControlMessage,
  type WireSnapshot,
} from '../shared/protocol';
import { createGameServer } from './server';

interface MockClient {
  ws: WebSocket;
  jsonMessages: ServerControlMessage[];
  snapshots: WireSnapshot[];
  binaryEvents: BinaryCombatEvent[];
  sendJson: (msg: ClientControlMessage) => void;
  sendBinary: (buf: Uint8Array) => void;
  waitForJson: <T extends ServerControlMessage['type']>(
    type: T,
    timeoutMs?: number,
    predicate?: (msg: Extract<ServerControlMessage, { type: T }>) => boolean
  ) => Promise<Extract<ServerControlMessage, { type: T }>>;
  waitForSnapshot: (
    predicate: (snap: WireSnapshot) => boolean,
    timeoutMs?: number
  ) => Promise<WireSnapshot>;
  close: () => Promise<void>;
}

function rawToUint8(data: RawData): Uint8Array {
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

async function connectClient(url: string, origin = 'https://localhost'): Promise<MockClient> {
  const ws = new WebSocket(url, { headers: { Origin: origin } });
  const jsonMessages: ServerControlMessage[] = [];
  const snapshots: WireSnapshot[] = [];
  const binaryEvents: BinaryCombatEvent[] = [];

  const jsonWaiters: Array<(msg: ServerControlMessage) => boolean> = [];
  const snapshotWaiters: Array<(snap: WireSnapshot) => boolean> = [];

  ws.on('message', (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      const bytes = rawToUint8(data);
      const opcode = peekBinaryOpcode(bytes);
      if (opcode === BinaryOpcode.SNAPSHOT) {
        const snap = decodeSnapshot(bytes);
        snapshots.push(snap);
        for (let i = snapshotWaiters.length - 1; i >= 0; i--) {
          if (snapshotWaiters[i](snap)) {
            snapshotWaiters.splice(i, 1);
          }
        }
      } else if (opcode === BinaryOpcode.EVENTS) {
        const events = decodeBinaryEvents(bytes);
        binaryEvents.push(...events);
      }
      return;
    }

    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    const parsed = JSON.parse(text) as ServerControlMessage;
    jsonMessages.push(parsed);
    for (let i = jsonWaiters.length - 1; i >= 0; i--) {
      if (jsonWaiters[i](parsed)) {
        jsonWaiters.splice(i, 1);
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (err) => reject(err));
  });

  function waitForJson<T extends ServerControlMessage['type']>(
    type: T,
    timeoutMs = 5000,
    predicate?: (msg: Extract<ServerControlMessage, { type: T }>) => boolean
  ): Promise<Extract<ServerControlMessage, { type: T }>> {
    // Check already-buffered messages first
    for (let i = 0; i < jsonMessages.length; i++) {
      const m = jsonMessages[i];
      if (m.type === type) {
        const typed = m as Extract<ServerControlMessage, { type: T }>;
        if (!predicate || predicate(typed)) {
          jsonMessages.splice(i, 1);
          return Promise.resolve(typed);
        }
      }
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for JSON message "${type}"`));
      }, timeoutMs);

      const matcher = (m: ServerControlMessage): boolean => {
        if (m.type !== type) return false;
        const typed = m as Extract<ServerControlMessage, { type: T }>;
        if (predicate && !predicate(typed)) return false;
        clearTimeout(timer);
        const idx = jsonMessages.indexOf(m);
        if (idx >= 0) jsonMessages.splice(idx, 1);
        resolve(typed);
        return true;
      };
      jsonWaiters.push(matcher);
    });
  }

  function waitForSnapshot(
    predicate: (snap: WireSnapshot) => boolean,
    timeoutMs = 5000
  ): Promise<WireSnapshot> {
    for (let i = snapshots.length - 1; i >= 0; i--) {
      if (predicate(snapshots[i])) {
        return Promise.resolve(snapshots[i]);
      }
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Timed out waiting for matching binary snapshot'));
      }, timeoutMs);

      const matcher = (snap: WireSnapshot): boolean => {
        if (!predicate(snap)) return false;
        clearTimeout(timer);
        resolve(snap);
        return true;
      };
      snapshotWaiters.push(matcher);
    });
  }

  function close(): Promise<void> {
    if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      ws.once('close', () => resolve());
      ws.close();
    });
  }

  return {
    ws,
    jsonMessages,
    snapshots,
    binaryEvents,
    sendJson: (msg) => ws.send(JSON.stringify(msg)),
    sendBinary: (buf) => ws.send(buf, { binary: true }),
    waitForJson,
    waitForSnapshot,
    close,
  };
}

function httpGet(
  url: string,
  headers: Record<string, string> = {}
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
  });
}

function testProtocolBinaryRoundTrips(): void {
  const sampleSnapshot: WireSnapshot = {
    tick: 42,
    elapsedMs: 2100,
    kills: 15,
    bossesDefeated: 1,
    nextBossSec: 280,
    paceMode: 'coop_pace',
    state: 'playing',
    selfPlayerId: 1,
    selfXp: 120,
    selfXpToNext: 240,
    selfPendingUpgrades: 2,
    boss: {
      enemyId: 99,
      bossId: 'king_mochi',
      phase: 'telegraph',
      enraged: true,
      attackId: 'mochi_leap_slam',
      hpPct: 68,
      telegraphPct: 75,
      cycle: 0,
      encounterIndex: 0,
      targetX: 150,
      targetY: -80,
      radius: 96,
      baseAngle: 1.25,
    },
    players: [
      {
        id: 1,
        x: 120,
        y: -45,
        aimAngle: 0.7854,
        hpPct: 92,
        level: 4,
        stateFlags: WirePlayerFlag.ALIVE | WirePlayerFlag.UPGRADING,
        classId: 'knight',
        revivePct: 0,
      },
      {
        id: 2,
        x: -30,
        y: 88,
        aimAngle: -1.5,
        hpPct: 0,
        level: 3,
        stateFlags: WirePlayerFlag.DOWNED | WirePlayerFlag.BEING_REVIVED,
        classId: 'ranger',
        revivePct: 45,
      },
    ],
    enemies: [
      {
        id: 7,
        x: 320,
        y: 110,
        type: 'golem',
        flags: WireEnemyFlag.ELITE | WireEnemyFlag.CHILLED,
        hpPct: 80,
      },
      {
        id: 99,
        x: 140,
        y: -70,
        type: 'king_mochi',
        flags: WireEnemyFlag.TAUNTED,
        hpPct: 68,
      },
    ],
    pickups: [
      { id: 1, kind: 'xp_medium', x: 50, y: 60 },
      { id: 2, kind: 'chest', x: 140, y: -60 },
    ],
  };

  const reusableBuf = new ArrayBuffer(16384);
  const encoded = encodeSnapshot(sampleSnapshot, reusableBuf);
  const decoded = decodeSnapshot(encoded);

  assert.equal(decoded.tick, 42);
  assert.equal(decoded.elapsedMs, 2100);
  assert.equal(decoded.kills, 15);
  assert.equal(decoded.paceMode, 'coop_pace');
  assert.equal(decoded.selfPlayerId, 1);
  assert.equal(decoded.selfXp, 120);
  assert.equal(decoded.selfXpToNext, 240);
  assert.equal(decoded.selfPendingUpgrades, 2);
  assert.equal(decoded.players.length, 2);
  assert.equal(decoded.players[0].classId, 'knight');
  assert.equal(decoded.players[1].revivePct, 45);
  assert.equal(decoded.enemies.length, 2);
  assert.equal(decoded.enemies[0].type, 'golem');
  assert.equal(decoded.enemies[0].flags, WireEnemyFlag.ELITE | WireEnemyFlag.CHILLED);
  assert.equal(decoded.pickups.length, 2);
  assert.equal(decoded.pickups[1].kind, 'chest');
  assert.ok(decoded.boss);
  assert.equal(decoded.boss.bossId, 'king_mochi');
  assert.equal(decoded.boss.phase, 'telegraph');
  assert.equal(decoded.boss.attackId, 'mochi_leap_slam');
  assert.equal(decoded.boss.enraged, true);

  // Verify O(1) personal XP header patching for client #2
  const copy = new Uint8Array(encoded.byteLength);
  copy.set(encoded);
  patchSnapshotPersonalXp(copy, 2, 35, 90, 0);
  const decodedP2 = decodeSnapshot(copy);
  assert.equal(decodedP2.selfPlayerId, 2);
  assert.equal(decodedP2.selfXp, 35);
  assert.equal(decodedP2.selfXpToNext, 90);
  assert.equal(decodedP2.selfPendingUpgrades, 0);

  // Standalone personal XP packet
  const xpPacket = decodePersonalXp(encodePersonalXp({ playerId: 3, level: 7, xp: 45, xpToNext: 180 }));
  assert.deepEqual(xpPacket, { playerId: 3, level: 7, xp: 45, xpToNext: 180 });

  // Binary combat events round-trip
  const combatEvents: BinaryCombatEvent[] = [
    {
      type: 'AbilityFired',
      playerId: 1,
      abilityId: 'firestorm',
      isSynergy: true,
      isDoubleCast: true,
      x: 10,
      y: 20,
      aimAngle: 0.5,
    },
    {
      type: 'DamageNumber',
      enemyId: 7,
      x: 320,
      y: 110,
      amount: 145,
      isCrit: true,
      shattered: true,
      silent: false,
    },
    { type: 'EnemyKilled', enemyId: 7, enemyType: 'golem', isBoss: false, x: 320, y: 110 },
    {
      type: 'BossTelegraph',
      enemyId: 99,
      bossId: 'lady_wisteria',
      attackId: 'wisteria_bloom_beam',
      x: 100,
      y: 100,
      targetX: 200,
      targetY: 50,
      telegraphMs: 1000,
    },
    { type: 'PlayerDowned', playerId: 2, x: -30, y: 88 },
    { type: 'PlayerRevived', playerId: 2, reason: 'circle', hpPct: 20, x: -30, y: 88, reviverMask: 1 },
    {
      type: 'BossHazard',
      hazardKind: 'arena_ring',
      x: 40,
      y: -60,
      targetX: 0,
      targetY: 0,
      radius: 310,
      durationMs: 1200,
      active: true,
    },
  ];
  const decodedEvents = decodeBinaryEvents(encodeBinaryEvents(combatEvents));
  assert.equal(decodedEvents.length, combatEvents.length);
  assert.equal(decodedEvents[0].type, 'AbilityFired');
  if (decodedEvents[0].type === 'AbilityFired') {
    assert.equal(decodedEvents[0].abilityId, 'firestorm');
    assert.equal(decodedEvents[0].isSynergy, true);
  }
  assert.equal(decodedEvents[3].type, 'BossTelegraph');
  if (decodedEvents[3].type === 'BossTelegraph') {
    assert.equal(decodedEvents[3].attackId, 'wisteria_bloom_beam');
  }
  assert.equal(decodedEvents[6].type, 'BossHazard');
  if (decodedEvents[6].type === 'BossHazard') {
    assert.equal(decodedEvents[6].hazardKind, 'arena_ring');
    assert.equal(decodedEvents[6].radius, 310);
    assert.equal(decodedEvents[6].active, true);
  }

  // Client binary INPUT & PICK_UPGRADE round-trip
  const decodedInput = decodeClientInput(
    encodeClientInput({ dx: 0.75, dy: -0.5, aimAngle: 1.2345, manualAim: true, seq: 19 })
  );
  assert.ok(Math.abs(decodedInput.dx - 0.75) < 0.001);
  assert.ok(Math.abs(decodedInput.dy - -0.5) < 0.001);
  assert.ok(Math.abs(decodedInput.aimAngle - 1.2345) < 0.001);
  assert.equal(decodedInput.manualAim, true);
  assert.equal(decodedInput.seq, 19);

  const decodedPick = decodePickUpgrade(encodePickUpgrade(2));
  assert.equal(decodedPick.choiceIndex, 2);

  console.log('  [PASS] Compact binary protocol round-trip (snapshots, personal XP, combat events, input, upgrade pick)');
}

async function runIntegrationTests(): Promise<void> {
  console.log('Running Pastel Survivors WebSocket Server Integration Tests...\n');

  testProtocolBinaryRoundTrips();

  const server = createGameServer({
    port: 0,
    host: '127.0.0.1',
    heartbeatIntervalMs: 10_000,
    reconnectGraceMs: 20_000,
  });

  const port = await server.listen(0, '127.0.0.1');
  const httpBase = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  try {
    // 1. Verify /health HTTP endpoint + Capacitor Android CORS header
    const healthRes = await httpGet(`${httpBase}/health`, { Origin: 'https://localhost' });
    assert.equal(healthRes.statusCode, 200);
    assert.equal(healthRes.headers['access-control-allow-origin'], 'https://localhost');
    const healthBody = JSON.parse(healthRes.body) as {
      status: string;
      activeRooms: number;
      activePlayers: number;
      uptimeSec: number;
    };
    assert.equal(healthBody.status, 'ok');
    assert.equal(healthBody.activeRooms, 0);
    assert.equal(healthBody.activePlayers, 0);
    assert.equal(typeof healthBody.uptimeSec, 'number');
    console.log('  [PASS] GET /health returns 200 OK JSON with https://localhost CORS header');

    // 2. Connect 2 mock clients into the same 4-char uppercase room
    const c1 = await connectClient(wsUrl, 'https://localhost');
    const c2 = await connectClient(wsUrl, 'https://localhost');

    // Verify application-level PING / PONG
    c1.sendJson({ type: 'PING', ts: 12345 });
    const pong = await c1.waitForJson('PONG');
    assert.equal(pong.ts, 12345);
    assert.equal(typeof pong.serverTime, 'number');

    // Client 1 creates room
    c1.sendJson({ type: 'CREATE_ROOM', heroId: 'mage', name: 'Alice' });
    const c1Joined = await c1.waitForJson('ROOM_JOINED');
    const roomCode = c1Joined.roomCode;
    assert.equal(roomCode.length, ROOM_CODE_LENGTH);
    for (const ch of roomCode) {
      assert.ok(ROOM_CODE_ALPHABET.includes(ch), `Room code char "${ch}" must be unambiguous`);
    }
    assert.equal(c1Joined.isHost, true);
    assert.ok(c1Joined.reconnectToken.length >= 16);

    // Client 2 joins room
    c2.sendJson({ type: 'JOIN_ROOM', roomCode, heroId: 'mage', name: 'Bob' });
    const c2Joined = await c2.waitForJson('ROOM_JOINED');
    assert.equal(c2Joined.roomCode, roomCode);
    assert.equal(c2Joined.isHost, false);
    assert.notEqual(c2Joined.playerId, c1Joined.playerId);
    assert.ok(c2Joined.reconnectToken.length >= 16);

    // Select classes, set pace, toggle ready
    c1.sendJson({ type: 'SELECT_CLASS', heroId: 'knight' });
    c2.sendJson({ type: 'SELECT_CLASS', heroId: 'ranger' });
    c1.sendJson({ type: 'SET_PACE', paceMode: 'coop_pace' });
    c1.sendJson({ type: 'TOGGLE_READY', ready: true });
    c2.sendJson({ type: 'TOGGLE_READY', ready: true });

    await c1.waitForJson('ROOM_STATE', 3000, (m) => {
      const p1 = m.roomState.players.find((p) => p.playerId === c1Joined.playerId);
      const p2 = m.roomState.players.find((p) => p.playerId === c2Joined.playerId);
      return Boolean(
        p1?.heroId === 'knight' &&
          p1?.ready &&
          p2?.heroId === 'ranger' &&
          p2?.ready
      );
    });
    console.log(`  [PASS] 2 clients created & joined room ${roomCode}, selected classes, and readied up`);

    // 3. Start match & stream binary inputs / snapshots
    c1.sendJson({ type: 'START_MATCH' });
    const [m1, m2] = await Promise.all([
      c1.waitForJson('MATCH_STARTED'),
      c2.waitForJson('MATCH_STARTED'),
    ]);
    assert.equal(m1.tickRate, 20);
    assert.equal(m2.roomCode, roomCode);

    // Capture initial positions from tick 0 snapshot
    const initSnap1 = await c1.waitForSnapshot((s) => s.players.length === 2);
    const initSnap2 = await c2.waitForSnapshot((s) => s.players.length === 2);
    assert.equal(initSnap1.selfPlayerId, c1Joined.slotId);
    assert.equal(initSnap2.selfPlayerId, c2Joined.slotId);
    assert.ok(initSnap1.selfXpToNext > 0);
    assert.ok(initSnap2.selfXpToNext > 0);

    const startP1 = initSnap1.players.find((p) => p.id === c1Joined.slotId)!;
    const startP2 = initSnap2.players.find((p) => p.id === c2Joined.slotId)!;
    assert.equal(startP1.classId, 'knight');
    assert.equal(startP2.classId, 'ranger');

    // Send continuous binary INPUT packets: P1 moves right (+x), P2 moves down (+y)
    c1.sendBinary(encodeClientInput({ dx: 1, dy: 0, aimAngle: 0, manualAim: true, seq: 1 }));
    c2.sendBinary(
      encodeClientInput({ dx: 0, dy: 1, aimAngle: Math.PI / 2, manualAim: true, seq: 1 })
    );

    const movedSnap1 = await c1.waitForSnapshot((s) => {
      const p1 = s.players.find((p) => p.id === c1Joined.slotId);
      const p2 = s.players.find((p) => p.id === c2Joined.slotId);
      return Boolean(p1 && p2 && p1.x > startP1.x + 15 && p2.y > startP2.y + 15);
    }, 3000);

    const movedP1 = movedSnap1.players.find((p) => p.id === c1Joined.slotId)!;
    const movedP2 = movedSnap1.players.find((p) => p.id === c2Joined.slotId)!;
    assert.ok(movedP1.x > startP1.x + 15, 'P1 should have moved right');
    assert.ok(movedP2.y > startP2.y + 15, 'P2 should have moved down');
    assert.ok((movedP1.stateFlags & WirePlayerFlag.ALIVE) !== 0);
    assert.ok((movedP2.stateFlags & WirePlayerFlag.ALIVE) !== 0);

    // Check /health reflects active match & 2 players
    const midHealth = JSON.parse((await httpGet(`${httpBase}/health`)).body) as {
      activeRooms: number;
      activeMatches: number;
      activePlayers: number;
    };
    assert.equal(midHealth.activeRooms, 1);
    assert.equal(midHealth.activeMatches, 1);
    assert.equal(midHealth.activePlayers, 2);
    console.log('  [PASS] 20 Hz simulation streamed compact binary snapshots & applied movement inputs');

    // 4. Test mid-match disconnect + reconnect using reconnectToken
    await c2.close();

    const discNotice = await c1.waitForJson('PLAYER_DISCONNECTED');
    assert.equal(discNotice.playerId, c2Joined.playerId);
    assert.equal(discNotice.gracePeriodSec, 20);

    // Confirm P2's hero remains alive in snapshots with DISCONNECTED flag during grace period
    const snapDuringGrace = await c1.waitForSnapshot((s) => {
      const p2 = s.players.find((p) => p.id === c2Joined.slotId);
      return Boolean(
        p2 &&
          (p2.stateFlags & WirePlayerFlag.ALIVE) !== 0 &&
          (p2.stateFlags & WirePlayerFlag.DISCONNECTED) !== 0
      );
    }, 2000);
    const p2DuringGrace = snapDuringGrace.players.find((p) => p.id === c2Joined.slotId)!;
    assert.ok(p2DuringGrace, 'Disconnected player hero must stay alive during 20s grace window');

    // Reconnect Client 2 on a fresh socket with its reconnectToken
    const c2Reconnected = await connectClient(wsUrl, 'https://localhost');
    c2Reconnected.sendJson({
      type: 'RECONNECT',
      roomCode,
      reconnectToken: c2Joined.reconnectToken,
    });

    const [reconnMsg, peerNotice] = await Promise.all([
      c2Reconnected.waitForJson('RECONNECTED'),
      c1.waitForJson('PLAYER_RECONNECTED'),
    ]);
    assert.equal(reconnMsg.playerId, c2Joined.playerId);
    assert.equal(reconnMsg.slotId, c2Joined.slotId);
    assert.equal(peerNotice.playerId, c2Joined.playerId);

    // Verify reconnected client resumes receiving binary snapshots & can move again
    c2Reconnected.sendBinary(
      encodeClientInput({ dx: -1, dy: 0, aimAngle: Math.PI, manualAim: true, seq: 1 })
    );
    const resumedSnap = await c2Reconnected.waitForSnapshot((s) => {
      const p2 = s.players.find((p) => p.id === c2Joined.slotId);
      return Boolean(
        p2 &&
          (p2.stateFlags & WirePlayerFlag.DISCONNECTED) === 0 &&
          p2.x < p2DuringGrace.x - 10
      );
    }, 3000);
    assert.equal(resumedSnap.selfPlayerId, c2Joined.slotId);
    console.log('  [PASS] Mid-match disconnect kept hero alive & reconnectToken resumed session cleanly');

    // 5. Verify lobby host reassignment & empty room cleanup
    const h1 = await connectClient(wsUrl);
    const h2 = await connectClient(wsUrl);
    h1.sendJson({ type: 'CREATE_ROOM', heroId: 'mage', name: 'Host1' });
    const h1Join = await h1.waitForJson('ROOM_JOINED');
    h2.sendJson({ type: 'JOIN_ROOM', roomCode: h1Join.roomCode, heroId: 'knight', name: 'Host2' });
    const h2Join = await h2.waitForJson('ROOM_JOINED');

    await h1.close();
    const hostLeft = await h2.waitForJson('PLAYER_LEFT');
    assert.equal(hostLeft.newHostPlayerId, h2Join.playerId);

    await h2.close();
    // Allow socket close cleanup tick
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      server.roomManager.getRoom(h1Join.roomCode),
      undefined,
      'Empty lobby room should be auto-cleaned'
    );
    console.log('  [PASS] Host reassignment on disconnect & empty room auto-cleanup verified');

    await Promise.all([c1.close(), c2Reconnected.close()]);
  } finally {
    await server.close();
  }

  console.log('\nAll WebSocket multiplayer integration tests passed!');
}

runIntegrationTests().catch((err) => {
  console.error('Integration test failed:', err);
  process.exit(1);
});
