import {
  coopBossHpMultiplier,
  coopEnemyHpMultiplier,
  coopSpawnRateMultiplier,
  enemyHP,
  enemySpawnRate,
  xpNeeded,
} from '../shared/data/enemies';
import { getBossScaledHp } from '../shared/sim/bossAI';
import {
  BOSS_KILL_REVIVE_HP_RATIO,
  GameSimulation,
  MAX_ENEMIES,
  REVIVE_CIRCLE_RADIUS,
  REVIVE_DURATION_SEC,
  REVIVE_HP_RATIO,
} from '../shared/sim/simulation';
import {
  EnemyStateFlag,
  PlayerStateFlag,
  type PlayerInput,
} from '../shared/sim/types';
import { CoopRoom } from './coopRoom';

declare const console: {
  log: (...args: unknown[]) => void;
};

const IDLE_INPUT: PlayerInput = { moveX: 0, moveY: 0, aimMode: 'auto' };

interface AssertHelpers {
  ok: (condition: unknown, message?: string) => asserts condition;
  equal: <T>(actual: T, expected: T, message?: string) => void;
  notEqual: <T>(actual: T, unexpected: T, message?: string) => void;
  deepEqual: (actual: unknown, expected: unknown, message?: string) => void;
}

const assert: AssertHelpers = {
  ok(condition: unknown, message = 'Assertion failed'): asserts condition {
    if (!condition) {
      throw new Error(message);
    }
  },
  equal<T>(actual: T, expected: T, message?: string): void {
    if (!Object.is(actual, expected)) {
      throw new Error(
        `${message ?? 'Expected values to be equal'} (actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)})`
      );
    }
  },
  notEqual<T>(actual: T, unexpected: T, message?: string): void {
    if (Object.is(actual, unexpected)) {
      throw new Error(
        `${message ?? 'Expected values to differ'} (both=${JSON.stringify(actual)})`
      );
    }
  },
  deepEqual(actual: unknown, expected: unknown, message?: string): void {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) {
      throw new Error(`${message ?? 'Expected deep equality'} (actual=${a}, expected=${b})`);
    }
  },
};

function runTest(name: string, fn: () => void): void {
  fn();
  console.log(`  [PASS] ${name}`);
}

console.log('Running Pastel Survivors 4-Player Co-op Server Simulation Tests...\n');

// ============================================================================
// TEST 1: Personal XP Bars + Async Live Level-Ups (NO GLOBAL PAUSE)
// ============================================================================
runTest('Personal XP bars advance independently without pausing the room', () => {
  const room = new CoopRoom({ roomId: 'xp-test', seed: 101 });
  room.addPlayer('p1', 'mage');
  room.addPlayer('p2', 'ranger');
  room.startMatch();

  const p1 = room.sim.getPlayer('p1')!;
  const p2 = room.sim.getPlayer('p2')!;

  // Position players far apart so only P1 collects the spawned XP gems
  p1.x = 0;
  p1.y = 0;
  p2.x = 600;
  p2.y = 0;

  // Place a nearby enemy to confirm NO automatic level-up knockback pulse occurs
  const nearbyEnemy = room.sim.spawnEnemy('slime', 32, 0, 5000);
  nearbyEnemy.kbVx = 0;
  nearbyEnemy.kbVy = 0;

  // Drop exact XP needed for P1 to level from Lv 1 -> Lv 2 directly onto P1
  const lv1XpNeeded = xpNeeded(1);
  assert.equal(p1.xpToNext, lv1XpNeeded, 'Player 1 xpToNext should match xpNeeded(1)');
  assert.equal(p2.xpToNext, lv1XpNeeded, 'Player 2 xpToNext should match xpNeeded(1)');

  room.sim.spawnPickup('xp_large', p1.x, p1.y, lv1XpNeeded + 3);

  const tick1 = room.step(0.05);

  // Room must NOT pause
  assert.equal(room.sim.getState(), 'playing', 'Co-op match must stay playing on level-up');
  assert.equal(tick1.snapshot.state, 'playing');

  // Only P1 leveled up; P2 is completely untouched
  assert.equal(p1.level, 2, 'Player 1 should reach level 2');
  assert.equal(p1.xp, 3, 'Player 1 overflow XP should carry over');
  assert.equal(p1.xpToNext, xpNeeded(2), 'Player 1 xpToNext should update to xpNeeded(2)');
  assert.equal(p2.level, 1, 'Player 2 must remain level 1');
  assert.equal(p2.xp, 0, 'Player 2 must remain at 0 XP');
  assert.equal(p2.pendingChoices.length, 0, 'Player 2 must have no pending choices');

  // Verify P1 received 3 choices with speed-readable metadata
  const p1Payload = room.getPersonalUpgradePayload('p1');
  assert.ok(p1Payload, 'Player 1 should have an active personal upgrade payload');
  assert.equal(p1Payload.choices.length, 3, 'Should roll 3 valid upgrade choices');
  assert.equal(p1Payload.pendingQueueCount, 0, 'Single level-up should have 0 overflow queued');
  for (const ch of p1Payload.choices) {
    assert.ok(
      ch.tier === 'standard' || ch.tier === 'milestone' || ch.tier === 'synergy',
      `Valid tier expected, got ${ch.tier}`
    );
    assert.ok(ch.iconId.length > 0, 'Choice must include iconId');
    assert.ok(ch.shortTitle.length > 0, 'Choice must include shortTitle');
    assert.ok(ch.shortTag.length > 0, 'Choice must include shortTag');
  }

  // Verify stateFlags broadcasts CHOOSING_UPGRADE for P1 only
  const snapP1 = tick1.snapshot.players.find((pl) => pl.id === 'p1')!;
  const snapP2 = tick1.snapshot.players.find((pl) => pl.id === 'p2')!;
  assert.notEqual(
    snapP1.stateFlags & PlayerStateFlag.CHOOSING_UPGRADE,
    0,
    'P1 stateFlags must include CHOOSING_UPGRADE'
  );
  assert.equal(
    snapP2.stateFlags & PlayerStateFlag.CHOOSING_UPGRADE,
    0,
    'P2 stateFlags must NOT include CHOOSING_UPGRADE'
  );

  // Confirm NO automatic level-up knockback pulse was applied
  assert.equal(nearbyEnemy.kbVx, 0, 'Level-up must not apply automatic knockback pulse');
  assert.equal(nearbyEnemy.kbVy, 0, 'Level-up must not apply automatic knockback pulse');

  // Confirm simulation keeps ticking smoothly while P1 has an open choice
  const tBefore = room.sim.getElapsedRunSec();
  room.step(0.1);
  assert.ok(
    room.sim.getElapsedRunSec() > tBefore,
    'Tick loop must continue advancing elapsedRunSec while choices are open'
  );
});

// ============================================================================
// TEST 2: Queued +1 Overflow Choices + Back-to-Back PICK_UPGRADE + Tiers
// ============================================================================
runTest('Queued +1 overflow choices resolve back-to-back & include milestone/synergy tiers', () => {
  const room = new CoopRoom({ roomId: 'queue-test', seed: 202 });
  room.addPlayer('p1', 'mage');
  room.addPlayer('p2', 'knight');
  room.startMatch();

  const p1 = room.sim.getPlayer('p1')!;
  p1.x = 0;
  p1.y = 0;
  room.sim.getPlayer('p2')!.x = 800;

  // Give P1 enough XP to level up twice before picking (Lv 1 -> Lv 3)
  const twoLevelsXp = xpNeeded(1) + xpNeeded(2);
  room.sim.spawnPickup('xp_large', p1.x, p1.y, twoLevelsXp);
  const res = room.step(0.05);

  assert.equal(p1.level, 3, 'P1 should reach Lv 3');
  assert.equal(p1.pendingQueueCount, 1, 'P1 should show +1 overflow badge');
  assert.equal(p1.pendingChoiceQueue.length, 2, 'P1 should have 2 queued choice batches');

  const snapP1 = res.snapshot.players.find((pl) => pl.id === 'p1')!;
  assert.equal(snapP1.pendingQueueCount, 1, 'Snapshot must report pendingQueueCount = 1');

  const firstPayload = room.getPersonalUpgradePayload('p1')!;
  assert.equal(firstPayload.choices.length, 3);
  const firstBatchId = firstPayload.batchId;

  // Send PICK_UPGRADE (0) -> applies immediately & deals next queued set of 3 choices
  const pick1 = room.handleClientMessage('p1', { type: 'PICK_UPGRADE', choiceIndex: 0 });
  assert.ok(pick1.personalUpgrade, 'Next queued batch should be dealt immediately after pick 1');
  assert.notEqual(pick1.personalUpgrade.batchId, firstBatchId, 'Batch ID should advance');
  assert.equal(pick1.personalUpgrade.choices.length, 3, 'Next dealt batch must have 3 choices');
  assert.equal(pick1.personalUpgrade.pendingQueueCount, 0, 'Overflow count should drop to 0');
  assert.equal(p1.pendingQueueCount, 0);

  // Send PICK_UPGRADE (1) -> resolves second batch & clears CHOOSING_UPGRADE flag
  const pick2 = room.handleClientMessage('p1', { type: 'PICK_UPGRADE', choiceIndex: 1 });
  assert.equal(pick2.personalUpgrade, null, 'Queue should now be empty');
  assert.equal(p1.pendingChoices.length, 0);
  assert.equal(
    p1.stateFlags & PlayerStateFlag.CHOOSING_UPGRADE,
    0,
    'CHOOSING_UPGRADE flag must clear once queue empties'
  );

  // Verify Lv 5 milestone tier metadata and Synergy evolution tier metadata
  // Push Fireball to Lv 4 so Lv 5 roll produces tier: 'milestone'
  while (room.sim.getAbilityLevel('fireball', 'p1') < 4) {
    room.sim.acquireOrUpgradeAbility('fireball', 'p1');
  }
  // Fill remaining 5 slots to Lv 10? Easier: check generated choices across a few rolls or fill 6 slots
  room.sim.acquireOrUpgradeAbility('wind_blade', 'p1');
  room.sim.acquireOrUpgradeAbility('ice_shard', 'p1');
  room.sim.acquireOrUpgradeAbility('frost_nova', 'p1');
  room.sim.acquireOrUpgradeAbility('chain_lightning', 'p1');
  room.sim.acquireOrUpgradeAbility('plasma_beam', 'p1');
  // Max the other 5 slots so Fireball Lv 5 is guaranteed in the roll
  for (const ab of ['wind_blade', 'ice_shard', 'frost_nova', 'chain_lightning', 'plasma_beam'] as const) {
    while (room.sim.getAbilityLevel(ab, 'p1') < 10) {
      room.sim.acquireOrUpgradeAbility(ab, 'p1');
    }
  }
  const milestoneChoices = room.sim.generateLevelUpChoices(3, 'p1');
  const fbLv5 = milestoneChoices.find((c) => c.abilityId === 'fireball' && c.nextLevel === 5);
  assert.ok(fbLv5, 'Fireball Lv 5 should be rolled');
  assert.equal(fbLv5.tier, 'milestone', 'Lv 5 upgrade must have tier === milestone');
  assert.equal(fbLv5.shortTitle, 'Fireball Lv 5');
  assert.equal(fbLv5.shortTag, 'ALL +8% DMG');

  // Now max Fireball to Lv 10 so Firestorm (Fireball + Wind Blade) is ready
  while (room.sim.getAbilityLevel('fireball', 'p1') < 10) {
    room.sim.acquireOrUpgradeAbility('fireball', 'p1');
  }
  const synChoices = room.sim.generateLevelUpChoices(3, 'p1');
  const firestorm = synChoices.find((c) => c.synergyId === 'firestorm');
  assert.ok(firestorm, 'Firestorm Synergy Evolution should be rolled');
  assert.equal(firestorm.tier, 'synergy', 'Synergy evolution must have tier === synergy');
  assert.equal(firestorm.shortTitle, 'FIRESTORM');
  assert.equal(firestorm.shortTag, 'EVOLVE');
});

// ============================================================================
// TEST 3: Player-Count Scaling, 350 Hard Cap + Overflow Pressure, Pace Modes
// ============================================================================
runTest('Player-count scaling (1P vs 4P), 350 enemy cap overflow, and Standard vs Co-op Pace', () => {
  // Verify exact scaling formulas
  assert.ok(Math.abs(coopEnemyHpMultiplier(1) - 1.0) < 1e-9);
  assert.ok(Math.abs(coopEnemyHpMultiplier(4) - 2.95) < 1e-9);
  assert.ok(Math.abs(coopBossHpMultiplier(1) - 1.0) < 1e-9);
  assert.ok(Math.abs(coopBossHpMultiplier(4) - 3.55) < 1e-9);
  assert.ok(Math.abs(coopSpawnRateMultiplier(1) - 1.0) < 1e-9);
  assert.ok(Math.abs(coopSpawnRateMultiplier(4) - 2.35) < 1e-9);

  // Compare live 1P vs 4P spawned enemy HP & boss HP at same effective time
  const soloSim = new GameSimulation(303);
  soloSim.startRun('mage', { seed: 303, mode: 'solo', paceMode: 'standard' });

  const coopSim = new GameSimulation(303);
  coopSim.startRun(
    [
      { id: 'p1', heroId: 'mage' },
      { id: 'p2', heroId: 'ranger' },
      { id: 'p3', heroId: 'knight' },
      { id: 'p4', heroId: 'mage' },
    ],
    { seed: 303, mode: 'coop', paceMode: 'standard' }
  );

  const soloSlime = soloSim.spawnEnemy('slime', 200, 0, undefined, { skipOverflow: true });
  const coopSlime = coopSim.spawnEnemy('slime', 200, 0, undefined, { skipOverflow: true });
  assert.equal(soloSlime.maxHp, Math.round(enemyHP(22, 0)));
  assert.equal(coopSlime.maxHp, Math.round(enemyHP(22, 0) * 2.95));

  const soloBoss = soloSim.spawnBoss('king_mochi', 0);
  const coopBoss = coopSim.spawnBoss('king_mochi', 0);
  const expectedSoloBossHp = getBossScaledHp(
    {
      id: 'king_mochi',
      name: 'King Mochi',
      title: '',
      spriteId: 'king_mochi',
      spawnMinute: 10,
      baseHp: 1400,
      baseXp: 180,
      speed: 62,
      contactDamage: 22,
      radius: 34,
      accentColor: '',
      attacks: [],
    },
    0,
    0
  );
  assert.equal(soloBoss.maxHp, expectedSoloBossHp);
  assert.equal(coopBoss.maxHp, Math.round(expectedSoloBossHp * 3.55));

  // Verify spawn rate scaling in live wave spawner (1P vs 4P over 20s, disabling player abilities by clearing slots)
  const soloSpawnSim = new GameSimulation(404);
  soloSpawnSim.startRun('mage', { seed: 404, mode: 'solo', paceMode: 'standard' });
  soloSpawnSim.getPrimaryPlayer().activeSlots = [];
  soloSpawnSim.getPrimaryPlayer().invulnTimer = 999;

  const coopSpawnSim = new GameSimulation(404);
  coopSpawnSim.startRun(
    [
      { id: 'p1', heroId: 'mage' },
      { id: 'p2', heroId: 'ranger' },
      { id: 'p3', heroId: 'knight' },
      { id: 'p4', heroId: 'mage' },
    ],
    { seed: 404, mode: 'coop', paceMode: 'standard' }
  );
  for (const pl of coopSpawnSim.getPlayers()) {
    pl.activeSlots = [];
    pl.invulnTimer = 999;
  }

  for (let i = 0; i < 200; i++) {
    soloSpawnSim.step(0.1, { local: IDLE_INPUT });
    coopSpawnSim.step(0.1, { p1: IDLE_INPUT, p2: IDLE_INPUT, p3: IDLE_INPUT, p4: IDLE_INPUT });
  }
  const spawnRatio = coopSpawnSim.enemies.length / Math.max(1, soloSpawnSim.enemies.length);
  assert.ok(
    spawnRatio > 2.2 && spawnRatio < 2.5,
    `4P spawn ratio should be ~2.35x (got ${spawnRatio.toFixed(2)}x: ${coopSpawnSim.enemies.length} vs ${soloSpawnSim.enemies.length})`
  );
  assert.ok(enemySpawnRate(0) * 2.35 > enemySpawnRate(0));

  // Verify Hard Active Enemy Cap = 350 and overflow pressure -> higher HP, XP, & elite chance
  assert.equal(MAX_ENEMIES, 350, 'Hard active enemy cap must be 350');
  const capSim = new GameSimulation(505);
  capSim.startRun(
    [
      { id: 'p1', heroId: 'mage' },
      { id: 'p2', heroId: 'ranger' },
      { id: 'p3', heroId: 'knight' },
      { id: 'p4', heroId: 'mage' },
    ],
    { seed: 505, mode: 'coop', paceMode: 'coop_pace' }
  );
  for (const pl of capSim.getPlayers()) {
    pl.activeSlots = [];
    pl.invulnTimer = 999;
  }

  // Baseline enemy before overflow pressure
  const baselineSlime = capSim.spawnEnemy('slime', 500, 0);
  assert.equal(capSim.getOverflowPressure(), 0);

  // Fill to 350 enemies
  while (capSim.enemies.length < MAX_ENEMIES) {
    capSim.spawnEnemy('slime', 500, 500);
  }
  assert.equal(capSim.enemies.length, 350);

  // Step 15 seconds while at cap -> cap never exceeded, overflow pressure builds
  for (let i = 0; i < 150; i++) {
    capSim.step(0.1, { p1: IDLE_INPUT, p2: IDLE_INPUT, p3: IDLE_INPUT, p4: IDLE_INPUT });
    assert.ok(
      capSim.enemies.length <= MAX_ENEMIES,
      `Enemy count must never exceed 350 (got ${capSim.enemies.length})`
    );
  }
  assert.ok(capSim.getOverflowPressure() > 10, 'Overflow spawn pressure must accumulate above cap');

  const overflowMults = capSim.getOverflowMultipliers();
  assert.ok(overflowMults.hpMult > 1.05, 'Overflow pressure must boost enemy HP');
  assert.ok(overflowMults.xpMult > 1.05, 'Overflow pressure must boost XP gem value');
  assert.ok(overflowMults.eliteChance > 0.05, 'Overflow pressure must grant elite spawn chance');

  // Remove 50 enemies so new ones can spawn under overflow pressure -> verify boosted HP/XP & elites
  capSim.enemies.splice(0, 50);
  let eliteCount = 0;
  let boostedCount = 0;
  for (let i = 0; i < 40; i++) {
    const spawned = capSim.spawnEnemy('slime', 400, 0);
    if (spawned.isElite) {
      eliteCount++;
      assert.notEqual(spawned.stateFlags & EnemyStateFlag.ELITE, 0);
    }
    if (spawned.maxHp > baselineSlime.maxHp && spawned.xpValue > baselineSlime.xpValue) {
      boostedCount++;
    }
  }
  assert.ok(boostedCount === 40, 'Newly spawned enemies under overflow must have higher HP & XP');
  assert.ok(eliteCount > 0, 'Overflow pressure must produce elite enemies');

  // Verify Co-op Pace (default for co-op): 1.5x time scaling, bosses at 5:00, 10:00, 15:00, 20:00
  const paceRoom = new CoopRoom({ roomId: 'pace-test', seed: 606 });
  assert.equal(paceRoom.getPaceMode(), 'coop_pace', 'Default lobby pace mode for co-op must be coop_pace');
  paceRoom.addPlayer('p1', 'mage');
  paceRoom.addPlayer('p2', 'knight');
  paceRoom.startMatch();
  for (const pl of paceRoom.sim.getPlayers()) {
    pl.activeSlots = [];
    pl.invulnTimer = 9999;
  }

  const bossSpawnTimes: number[] = [];
  for (let sec = 0; sec < 1205; sec++) {
    // Keep enemy list trimmed so stepping 20 minutes stays instant
    if (paceRoom.sim.enemies.length > 20) {
      paceRoom.sim.enemies = paceRoom.sim.enemies.filter((e) => e.isBoss);
    }
    const tick = paceRoom.step(1.0);
    for (const ev of tick.events) {
      if (ev.type === 'BossSpawned') {
        bossSpawnTimes.push(Math.round(paceRoom.sim.getElapsedRunSec()));
      }
    }
  }
  assert.deepEqual(
    bossSpawnTimes,
    [300, 600, 900, 1200],
    'Co-op Pace must spawn bosses at 5:00 (300s), 10:00 (600s), 15:00 (900s), and 20:00 (1200s)'
  );
  assert.ok(
    Math.abs(paceRoom.sim.getEffectiveMinutes() - (paceRoom.sim.getElapsedRunSec() / 60) * 1.5) < 1e-6,
    'Co-op Pace must apply 1.5x time scaling'
  );

  // Verify Standard pace mode spawns first boss at 10:00 (600s), not 5:00
  const stdRoom = new CoopRoom({ roomId: 'std-test', seed: 607, paceMode: 'standard' });
  stdRoom.addPlayer('p1', 'mage');
  stdRoom.addPlayer('p2', 'knight');
  stdRoom.startMatch();
  assert.equal(stdRoom.sim.getNextBossCountdownSec(), 600, 'Standard mode first boss at 10:00 (600s)');
});

// ============================================================================
// TEST 4: Downed State, 10.0s Cumulative Revive Circle, Boss Auto-Revive, Game Over
// ============================================================================
runTest('Downed state -> 10.0s cumulative revive circle, boss kill auto-revive, and all-downed Game Over', () => {
  assert.equal(REVIVE_DURATION_SEC, 10.0, 'Revive circle duration must be 10.0s');
  assert.equal(REVIVE_HP_RATIO, 0.2, 'Revive circle must restore 20% HP');

  const room = new CoopRoom({ roomId: 'revive-test', seed: 707 });
  room.addPlayer('p1', 'mage');
  room.addPlayer('p2', 'knight');
  room.startMatch();

  const p1 = room.sim.getPlayer('p1')!;
  const p2 = room.sim.getPlayer('p2')!;
  p1.activeSlots = [];
  p2.activeSlots = [];
  p1.x = 0;
  p1.y = 0;
  p2.x = 300;
  p2.y = 0;
  p2.invulnTimer = 999; // keep P2 safe from random wave enemies during revive test

  // Down P1 -> becomes Pastel Ghost, game does NOT end while P2 lives
  room.sim.damagePlayer(9999, 'p1');
  assert.equal(p1.downed, true, 'P1 should be downed');
  assert.equal(p1.alive, false, 'P1 alive should be false while downed');
  assert.equal(room.sim.getState(), 'playing', 'Game must NOT end while P2 is still alive');
  assert.notEqual(p1.stateFlags & PlayerStateFlag.DOWNED, 0);

  // Downed P1 cannot collect XP gems placed directly on them
  room.sim.spawnPickup('xp_large', p1.x, p1.y, 100);
  room.setPlayerInput('p1', { moveX: 1, moveY: 0, aimMode: 'auto' }); // slow ghost drift
  room.step(0.1);
  assert.equal(p1.xp, 0, 'Downed player must NOT collect XP gems');
  assert.ok(p1.x > 0 && p1.x < p1.speed * 0.1, 'Downed Pastel Ghost should drift slowly');
  room.setPlayerInput('p1', IDLE_INPUT);

  // Move P2 inside P1's revive circle for 4.0 seconds (40% of 10.0s)
  p2.x = p1.x + REVIVE_CIRCLE_RADIUS * 0.5;
  p2.y = p1.y;
  let lastSnap = room.getSnapshot();
  for (let i = 0; i < 40; i++) {
    lastSnap = room.step(0.1).snapshot;
  }
  const midP1 = lastSnap.players.find((pl) => pl.id === 'p1')!;
  assert.equal(p1.downed, true, 'P1 should still be downed at 4.0s');
  assert.ok(
    Math.abs(midP1.revivePct - 0.4) < 0.02,
    `Snapshot revivePct should be ~0.40 after 4.0s (got ${midP1.revivePct})`
  );

  // Step P2 OUTSIDE circle for 2.0 seconds -> cumulative progress MUST be preserved
  p2.x = p1.x + REVIVE_CIRCLE_RADIUS + 80;
  for (let i = 0; i < 20; i++) {
    lastSnap = room.step(0.1).snapshot;
  }
  const pausedP1 = lastSnap.players.find((pl) => pl.id === 'p1')!;
  assert.ok(
    Math.abs(pausedP1.revivePct - 0.4) < 0.02,
    `Cumulative revivePct must not decay when ally steps out (got ${pausedP1.revivePct})`
  );

  // Step P2 back INSIDE circle for 6.0 more seconds -> revives at 10.0s cumulative!
  p2.x = p1.x + 10;
  p2.y = p1.y;
  let revivedEventFound = false;
  for (let i = 0; i < 60; i++) {
    const tick = room.step(0.1);
    if (tick.events.some((e) => e.type === 'PlayerRevived' && e.playerId === 'p1' && e.reason === 'circle')) {
      revivedEventFound = true;
    }
  }
  assert.ok(revivedEventFound, 'PlayerRevived (circle) event must fire at 10.0s');
  assert.equal(p1.downed, false, 'P1 must be revived');
  assert.equal(p1.alive, true, 'P1 must be alive again');
  assert.equal(
    Math.round(p1.hp),
    Math.max(1, Math.round(p1.maxHp * REVIVE_HP_RATIO)),
    'Revived player should restore to 20% HP'
  );
  assert.ok(p1.invulnTimer >= 1.8, `Revived player must have 2s invulnerability (got ${p1.invulnTimer})`);
  assert.equal(p1.revivePct, 0, 'revivePct resets to 0 after revive');

  // Boss Kill Auto-Revive: down P1, kill a Boss -> P1 auto-revives at 50% HP
  p1.invulnTimer = 0;
  room.sim.damagePlayer(9999, 'p1');
  assert.equal(p1.downed, true);

  const boss = room.sim.spawnBoss('king_mochi', 0);
  room.sim.damageEnemy(boss, boss.maxHp + 100, { playerId: 'p2' });
  const bossEvents = room.sim.drainEvents();
  assert.ok(
    bossEvents.some((e) => e.type === 'PlayerRevived' && e.playerId === 'p1' && e.reason === 'boss_kill'),
    'Killing a Boss must auto-revive downed players'
  );
  assert.equal(p1.downed, false);
  assert.equal(p1.alive, true);
  assert.equal(
    Math.round(p1.hp),
    Math.max(1, Math.round(p1.maxHp * BOSS_KILL_REVIVE_HP_RATIO)),
    'Boss kill auto-revive must restore player to 50% HP'
  );

  // All connected players downed simultaneously -> Game Over
  p1.invulnTimer = 0;
  p2.invulnTimer = 0;
  room.sim.damagePlayer(9999, 'p1');
  assert.equal(room.sim.getState(), 'playing', 'Still playing with P2 alive');
  room.sim.damagePlayer(9999, 'p2');
  const goEvents = room.sim.drainEvents();
  assert.equal(room.sim.getState(), 'gameover', 'Game Over must trigger when all players are downed');
  assert.ok(goEvents.some((e) => e.type === 'GameOverTriggered'));
});

// ============================================================================
// TEST 5: Shared Boss Chest (Zero Loot Stealing)
// ============================================================================
runTest('Shared Boss Chest grants 3 Boss Artifact choices to EVERY player simultaneously', () => {
  const room = new CoopRoom({ roomId: 'chest-test', seed: 808 });
  room.addPlayer('p1', 'mage');
  room.addPlayer('p2', 'ranger');
  room.addPlayer('p3', 'knight');
  room.addPlayer('p4', 'mage');
  room.startMatch();

  for (const pl of room.sim.getPlayers()) {
    pl.activeSlots = [];
    pl.invulnTimer = 999;
  }

  // Spread players far apart
  room.sim.getPlayer('p1')!.x = 0;
  room.sim.getPlayer('p1')!.y = 0;
  room.sim.getPlayer('p2')!.x = 400;
  room.sim.getPlayer('p3')!.x = -400;
  room.sim.getPlayer('p4')!.x = 0;
  room.sim.getPlayer('p4')!.y = 400;

  // Spawn and defeat a Boss away from P1 so only the Boss Chest is touched (not the scattered XP gems)
  const boss = room.sim.spawnBoss('king_mochi', 0);
  boss.x = 1200;
  boss.y = 1200;
  room.sim.damageEnemy(boss, boss.maxHp + 100, { playerId: 'p1' });

  const chests = room.sim.pickups.filter((pk) => pk.kind === 'chest');
  assert.equal(chests.length, 1, 'Defeating a Boss must spawn exactly 1 Boss Chest');

  // Move ONLY the Boss Chest onto P1 and step
  chests[0].x = room.sim.getPlayer('p1')!.x;
  chests[0].y = room.sim.getPlayer('p1')!.y;
  const tick = room.step(0.05);

  assert.equal(room.sim.getState(), 'playing', 'Opening Boss Chest in co-op must NOT pause');
  assert.equal(
    room.sim.pickups.filter((pk) => pk.kind === 'chest').length,
    0,
    'Boss Chest should be consumed once touched'
  );

  // EVERY player (all 4!) must simultaneously have a 3-choice Boss Artifact batch in their queue
  for (const pid of ['p1', 'p2', 'p3', 'p4'] as const) {
    const payload = room.getPersonalUpgradePayload(pid);
    assert.ok(payload, `Player ${pid} must receive Boss Artifact choices`);
    assert.equal(payload.source, 'boss_chest');
    assert.equal(payload.choices.length, 3, `Player ${pid} must get 3 artifact options`);
    assert.ok(
      payload.choices.every((c) => c.kind === 'artifact' && Boolean(c.artifactId)),
      `All 3 choices for ${pid} must be artifacts`
    );
    const snapPl = tick.snapshot.players.find((pl) => pl.id === pid)!;
    assert.notEqual(
      snapPl.stateFlags & PlayerStateFlag.CHOOSING_UPGRADE,
      0,
      `Player ${pid} must be flagged CHOOSING_UPGRADE`
    );
  }

  // Each player independently picks their own artifact via PICK_UPGRADE (0/1/2)
  room.handleClientMessage('p1', { type: 'PICK_UPGRADE', choiceIndex: 0 });
  room.handleClientMessage('p2', { type: 'PICK_UPGRADE', choiceIndex: 1 });
  room.handleClientMessage('p3', { type: 'PICK_UPGRADE', choiceIndex: 2 });
  room.handleClientMessage('p4', { type: 'PICK_UPGRADE', choiceIndex: 0 });

  for (const pid of ['p1', 'p2', 'p3', 'p4'] as const) {
    const pl = room.sim.getPlayer(pid)!;
    assert.equal(pl.ownedArtifacts.length, 1, `Player ${pid} should now own 1 Boss Artifact`);
    assert.equal(pl.pendingChoices.length, 0);
  }
});

// ============================================================================
// TEST 6: 3-Class Co-op Ability Tweaks (Knight Taunt & Shared Chilled Debuff)
// ============================================================================
runTest('Knight Shield Bash & Bastion Quake 2.5s taunt peel + shared Chilled debuff (Frost Nova / Frost Quiver)', () => {
  // Part A: Knight Shield Bash & Bastion Quake 2.5s taunt peels non-boss enemies off Ranger, does NOT taunt Boss
  const tauntRoom = new CoopRoom({ roomId: 'taunt-test', seed: 909 });
  tauntRoom.addPlayer('knight', 'knight');
  tauntRoom.addPlayer('ranger', 'ranger');
  tauntRoom.startMatch();

  const knight = tauntRoom.sim.getPlayer('knight')!;
  const ranger = tauntRoom.sim.getPlayer('ranger')!;
  ranger.activeSlots = [];
  knight.invulnTimer = 999;
  ranger.invulnTimer = 999;

  // Position Ranger at x = 140, Knight at x = 0, and Slime at x = 100 (closer to Ranger: dist 40 vs dist 100 to Knight!)
  knight.x = 0;
  knight.y = 0;
  ranger.x = 140;
  ranger.y = 0;

  // Equip Knight with only Shield Bash ready to fire immediately
  knight.activeSlots = [{ kind: 'ability', id: 'shield_bash', level: 1, cooldownTimer: 0 }];

  const slime = tauntRoom.sim.spawnEnemy('slime', 100, 0, 5000);
  const boss = tauntRoom.sim.spawnBoss('king_mochi', 0);
  boss.x = 0;
  boss.y = 95;

  // Step 1 tick so Shield Bash fires
  tauntRoom.step(0.05);

  assert.equal(slime.tauntTargetId, 'knight', 'Shield Bash must taunt nearby non-boss enemy onto Knight');
  assert.ok(slime.tauntTimer >= 2.4 && slime.tauntTimer <= 2.5, `Taunt duration should be 2.5s (got ${slime.tauntTimer})`);
  assert.notEqual(slime.stateFlags & EnemyStateFlag.TAUNTED, 0, 'Slime must carry TAUNTED flag');
  assert.equal(boss.tauntTargetId, null, 'Boss must NOT be taunted');
  assert.equal(boss.tauntTimer, 0, 'Boss tauntTimer must stay 0');

  // Let Shield Bash knockback decay, then verify Slime's AI actively moves LEFT (toward Knight at x=0)
  // instead of RIGHT (toward the closer Ranger at x=140)
  knight.activeSlots = [];
  for (let i = 0; i < 6; i++) tauntRoom.step(0.05);
  const slimeXAfterKb = slime.x;
  assert.ok(slime.vx < 0, `Taunted Slime AI velocity must point toward Knight (vx=${slime.vx})`);
  for (let i = 0; i < 6; i++) tauntRoom.step(0.05);
  assert.ok(
    slime.x < slimeXAfterKb,
    `Taunted Slime must peel toward Knight (x=${slime.x} should be < ${slimeXAfterKb})`
  );

  // Also test Bastion Quake taunt peel
  const slime2 = tauntRoom.sim.spawnEnemy('slime', 120, 0, 5000);
  knight.activeSlots = [{ kind: 'synergy', id: 'bastion_quake', level: 1, cooldownTimer: 0 }];
  tauntRoom.step(0.05);
  assert.equal(slime2.tauntTargetId, 'knight', 'Bastion Quake must taunt nearby non-boss enemies');
  assert.ok(slime2.tauntTimer >= 2.4, 'Bastion Quake taunt must last 2.5s');

  // Part B: Mage Frost Nova & Ranger Frost Quiver apply visible shared `chilled` debuff
  const chillRoom = new CoopRoom({ roomId: 'chill-test', seed: 910 });
  chillRoom.addPlayer('mage', 'mage');
  chillRoom.addPlayer('ranger', 'ranger');
  chillRoom.startMatch();

  const mage = chillRoom.sim.getPlayer('mage')!;
  const ranger2 = chillRoom.sim.getPlayer('ranger')!;
  mage.invulnTimer = 999;
  ranger2.invulnTimer = 999;
  mage.x = 0;
  mage.y = 0;
  ranger2.x = 400;
  ranger2.y = 0;

  // Test Mage Frost Nova
  mage.activeSlots = [{ kind: 'ability', id: 'frost_nova', level: 1, cooldownTimer: 0 }];
  ranger2.activeSlots = [];
  const novaTarget = chillRoom.sim.spawnEnemy('golem', 50, 0, 5000);
  for (let i = 0; i < 6; i++) chillRoom.step(0.05);

  assert.equal(novaTarget.chilled, true, 'Frost Nova must apply chilled debuff');
  assert.ok(novaTarget.slowTimer > 0 && novaTarget.slowFactor < 1, 'Frost Nova must slow enemy');
  assert.notEqual(
    novaTarget.stateFlags & EnemyStateFlag.CHILLED,
    0,
    'Snapshot stateFlags must expose CHILLED'
  );

  // Test Ranger Frost Quiver
  mage.activeSlots = [];
  ranger2.activeSlots = [{ kind: 'ability', id: 'frost_quiver', level: 1, cooldownTimer: 0 }];
  const quiverTarget = chillRoom.sim.spawnEnemy('golem', 445, 0, 5000);
  for (let i = 0; i < 8; i++) chillRoom.step(0.05);

  assert.equal(quiverTarget.chilled, true, 'Frost Quiver must apply chilled debuff');
  assert.ok(quiverTarget.slowTimer > 0 && quiverTarget.slowFactor < 1, 'Frost Quiver must slow enemy');
  assert.notEqual(quiverTarget.stateFlags & EnemyStateFlag.CHILLED, 0);

  // Verify shared benefit: Mage hitting Ranger's chilled enemy gets shatterBonus (+50% damage)
  // Zero out crit chance for deterministic damage comparison
  const hpBefore = quiverTarget.hp;
  const unchilledTarget = chillRoom.sim.spawnEnemy('golem', 700, 0, 5000);
  mage.computedStats.critChance = 0;
  chillRoom.sim.damageEnemy(quiverTarget, 100, { playerId: 'mage', shatterBonus: true });
  chillRoom.sim.damageEnemy(unchilledTarget, 100, { playerId: 'mage', shatterBonus: true });
  const dmgChilled = hpBefore - quiverTarget.hp;
  const dmgUnchilled = 5000 - unchilledTarget.hp;
  assert.equal(dmgChilled, 150, 'Teammate shatter attack should deal 1.5x against Ranger-chilled target');
  assert.equal(dmgUnchilled, 100, 'Control attack against unchilled target should deal 1.0x');
});

// ============================================================================
// TEST 7: Alchemist Class (Solo & Co-op) + Twin Macarons & Countess Tiramisu
// ============================================================================
runTest('Alchemist abilities/synergies/artifacts & Twin Macarons / Countess Tiramisu bosses initialize cleanly', () => {
  // 1. Solo Alchemist sanity check (healing mist, acid flask armor shred, protective ward shield, synergies)
  const soloAlch = new GameSimulation(707);
  soloAlch.startRun('alchemist', { mode: 'solo' });
  const alch = soloAlch.getPrimaryPlayer();
  assert.equal(alch.heroId, 'alchemist');
  assert.equal(alch.activeSlots[0]?.id, 'healing_mist');

  // Test all 10 Alchemist abilities & 5 synergies can be leveled and evolved cleanly
  alch.activeSlots = [
    { kind: 'ability', id: 'healing_mist', level: 10, cooldownTimer: 0 },
    { kind: 'ability', id: 'haste_aura', level: 10, cooldownTimer: 0 },
    { kind: 'ability', id: 'acid_flask', level: 10, cooldownTimer: 0 },
    { kind: 'ability', id: 'gravity_potion', level: 10, cooldownTimer: 0 },
    { kind: 'ability', id: 'protective_ward', level: 5, cooldownTimer: 0 },
    { kind: 'ability', id: 'revive_totem', level: 5, cooldownTimer: 0 },
  ];
  const dummy = soloAlch.spawnEnemy('golem', 50, 0, 5000);
  for (let i = 0; i < 12; i++) {
    soloAlch.step(0.05, { [alch.id]: IDLE_INPUT });
  }
  assert.ok(alch.shieldHp > 0, 'Protective Ward must grant temporary shield HP to Alchemist in solo');
  assert.ok(alch.hasteBuffTimer > 0, 'Haste Aura must buff Alchemist in solo');
  assert.ok(dummy.armorShredTimer > 0, 'Acid Flask must apply corrosive armor shred');

  // Evolve Sanctuary Choir & Caustic Singularity
  assert.equal(soloAlch.evolveSynergy('sanctuary_choir', alch.id), true, 'Sanctuary Choir should evolve');
  assert.equal(soloAlch.evolveSynergy('caustic_singularity', alch.id), true, 'Caustic Singularity should evolve');

  // Grant all 3 Alchemist Boss Artifacts
  soloAlch.grantArtifact('philosophers_censer', alch.id);
  soloAlch.grantArtifact('aether_alembic', alch.id);
  soloAlch.grantArtifact('chrono_distillate', alch.id);
  assert.equal(alch.computedStats.hasAuraRadiusBoost, true);
  assert.equal(alch.computedStats.hasOverhealToShield, true);
  assert.equal(alch.computedStats.hasSharedCooldownAura, true);

  // 2. Co-op Revive Totem solo-revive + Twin Macarons Duo Boss + Countess Tiramisu
  const coopRoom = new CoopRoom({ roomId: 'alch-boss-test', seed: 808 });
  coopRoom.addPlayer('alch', 'alchemist');
  coopRoom.addPlayer('ally', 'knight');
  coopRoom.startMatch();

  const pAlch = coopRoom.sim.getPlayer('alch')!;
  const pAlly = coopRoom.sim.getPlayer('ally')!;
  pAlch.x = 0;
  pAlch.y = 0;
  pAlly.x = 20;
  pAlly.y = 0;

  // Deploy Revive Totem near downed ally, then move Alchemist away so totem solo-revives
  pAlch.activeSlots = [{ kind: 'ability', id: 'revive_totem', level: 1, cooldownTimer: 0 }];
  pAlly.activeSlots = [];
  coopRoom.step(0.05);
  pAlch.x = 500; // step out of revive circle
  pAlly.hp = 1;
  coopRoom.sim.damagePlayer(999, 'ally');
  assert.equal(pAlly.downed, true, 'Ally should be downed');
  for (let i = 0; i < 10; i++) coopRoom.step(0.1);
  assert.ok(pAlly.reviveProgressSec > 0, 'Revive Totem must solo-revive downed allies in range');

  // Spawn The Twin Macarons (Duo Boss: Mint & Rose)
  const mint = coopRoom.sim.spawnBoss('twin_macaron_mint', 1);
  const activeBosses = coopRoom.sim.getActiveBosses();
  assert.equal(activeBosses.length, 2, 'Twin Macarons must spawn both Mint and Rose linked');
  const rose = activeBosses.find((b) => b.bossId === 'twin_macaron_rose')!;
  assert.ok(rose && mint.linkedBossId === rose.id && rose.linkedBossId === mint.id);
  const sharedInfo = coopRoom.sim.getActiveBossInfo();
  assert.equal(sharedInfo?.name, 'The Twin Macarons', 'Shared boss bar should display The Twin Macarons');
  for (let i = 0; i < 30; i++) coopRoom.step(0.1);

  // Killing one twin enrages the other without dropping the chest yet
  const chestsBefore = coopRoom.sim.pickups.filter((pk) => pk.kind === 'chest').length;
  coopRoom.sim.damageEnemy(mint, mint.hp + 9999, { playerId: 'alch' });
  assert.equal(coopRoom.sim.getBossesDefeated(), 0, 'Defeating only one twin must not complete encounter');
  assert.equal(
    coopRoom.sim.pickups.filter((pk) => pk.kind === 'chest').length,
    chestsBefore,
    'Chest must not drop until both twins fall'
  );
  coopRoom.sim.damageEnemy(rose, rose.hp + 9999, { playerId: 'alch' });
  assert.equal(coopRoom.sim.getBossesDefeated(), 1, 'Defeating both twins completes encounter');

  // Spawn Countess Tiramisu and step through attacks cleanly
  const countess = coopRoom.sim.spawnBoss('countess_tiramisu', 3);
  assert.equal(countess.bossId, 'countess_tiramisu');
  for (let i = 0; i < 60; i++) coopRoom.step(0.1);
  assert.ok(countess.alive, 'Countess Tiramisu should step cleanly without runtime errors');
});

// ============================================================================
// TEST 8: Authoritative Co-op Projectile Replication & Real AimAngle Sync
// ============================================================================
runTest('Co-op AbilityFired aimAngle and ProjectileSpawned/Despawned sync with server hits', () => {
  const room = new CoopRoom({ roomId: 'proj-sync-test', seed: 909 });
  room.addPlayer('p1', 'ranger');
  room.addPlayer('p2', 'mage');
  room.startMatch();

  const p1 = room.sim.getPlayer('p1')!;
  const p2 = room.sim.getPlayer('p2')!;
  p1.x = 0;
  p1.y = 0;
  p2.x = 2000;
  p2.y = 2000;
  p1.activeSlots = [{ kind: 'ability', id: 'twin_pistols', level: 1, cooldownTimer: 0 }];
  p2.activeSlots = [];

  // Place enemy UP-LEFT (-140, -140) while player walks RIGHT (+1, 0) in auto-aim mode
  const target = room.sim.spawnEnemy('golem', -140, -140, 2000);
  target.speed = 0;
  room.setPlayerInput('p1', { moveX: 1, moveY: 0, aimMode: 'auto' });

  const expectedAngle = Math.atan2(-140, -140); // -2.356 rad (NOT 0 rad movement direction)
  const spawnedNetIds = new Set<number>();
  const despawnedNetIds = new Set<number>();
  let firedAngle: number | null = null;
  let damagedTarget = false;

  for (let tick = 0; tick < 20; tick++) {
    const { events } = room.step(0.05);
    for (const ev of events) {
      if (ev.type === 'AbilityFired' && ev.playerId === 'p1' && firedAngle === null) {
        firedAngle = ev.aimAngle;
      }
      if (ev.type === 'ProjectileSpawned' && ev.playerId === 'p1') {
        spawnedNetIds.add(ev.netId);
        const projAngle = Math.atan2(ev.vy, ev.vx);
        const diff = Math.abs(Math.atan2(Math.sin(projAngle - expectedAngle), Math.cos(projAngle - expectedAngle)));
        assert.ok(
          diff < 0.25,
          `Replicated projectile must fly toward enemy (${expectedAngle.toFixed(2)}), got ${projAngle.toFixed(2)}`
        );
      }
      if (ev.type === 'ProjectileDespawned' && spawnedNetIds.has(ev.netId)) {
        despawnedNetIds.add(ev.netId);
      }
      if (ev.type === 'DamageDealt' && ev.enemyId === target.id) {
        damagedTarget = true;
      }
    }
    if (damagedTarget && despawnedNetIds.size > 0) break;
  }

  assert.ok(firedAngle !== null, 'AbilityFired must be emitted');
  const aimDiff = Math.abs(Math.atan2(Math.sin(firedAngle! - expectedAngle), Math.cos(firedAngle! - expectedAngle)));
  assert.ok(
    aimDiff < 0.2,
    `AbilityFired.aimAngle must reflect real target angle (${expectedAngle.toFixed(2)}), got ${firedAngle!.toFixed(2)}`
  );
  assert.ok(spawnedNetIds.size > 0, 'ProjectileSpawned must be emitted for co-op projectiles');
  assert.equal(damagedTarget, true, 'Server projectile must hit the target enemy');
  assert.ok(despawnedNetIds.size > 0, 'ProjectileDespawned must be emitted when projectile hits target');

  // Verify co-op magnet only attracts XP gems within 420px radius
  room.sim.pickups.length = 0;
  p1.x = 0;
  p1.y = 0;
  room.sim.spawnPickup('xp_small', 200, 0, 10);
  room.sim.spawnPickup('xp_small', 800, 0, 10);
  room.sim.spawnPickup('magnet', 0, 0, 0);
  room.step(0.05);
  const nearGem = room.sim.pickups.find((pk) => pk.kind === 'xp_small' && Math.abs(pk.x) < 300);
  const farGem = room.sim.pickups.find((pk) => pk.kind === 'xp_small' && pk.x > 600);
  assert.ok(nearGem?.magnetized === true, 'Nearby XP gem (200px) must be pulled by co-op magnet');
  assert.ok(farGem && farGem.magnetized === false, 'Faraway XP gem (800px) must NOT be stolen by co-op magnet');
});

console.log('\nAll 8 co-op simulation test suites passed!');
