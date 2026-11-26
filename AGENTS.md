# AGENTS.md — Pastel Survivors

## 1. Project Overview & Architecture
- **Pastel Survivors** (`https://pastelsurvivors.duckdns.org`) is a 4-player online co-op & Solo Offline survivor-like action game.
- **Authoritative Server (`src/server/`):** 20 Hz fixed-timestep Node.js WebSocket server (`ws`) managing 4-letter rooms, lobbies, reconnects, and binary snapshot/event broadcasts.
- **Shared Simulation & Protocol (`src/shared/`):** Pure headless TypeScript simulation (`GameSimulation`, zero DOM/Canvas/Audio deps) plus compact binary wire protocol (`protocol.ts`).
- **Client (`src/client/`):** HTML5 2D Canvas renderer with 60 Hz snapshot interpolation, local prediction, procedural pixel sprites, Web Audio SFX, and responsive desktop/mobile HUD.

## 2. Repository Map (Where Things Live)
- **`src/shared/data/`**
  - `abilities.ts` — All class abilities, base stats, level scaling, Lv 5/10 passives.
  - `synergies.ts` — Evolved synergy recipes (`Lv 10 + Lv 10`) and evolved specs.
  - `classes.ts` — Playable heroes (`mage`, `ranger`, `knight`, `alchemist`), base stats, starting abilities.
  - `enemies.ts` — Regular enemies, bosses (`BOSSES`), XP curve (`xpNeeded`), wave/scaling tables.
  - `artifacts.ts` — Boss chest artifacts and global passive modifiers.
  - `palette.ts`, `types.ts` — Shared pastel palette and core data types.
- **`src/shared/sim/`**
  - `simulation.ts` — Core `GameSimulation` loop, waves, XP/level-ups, revives, magnet, damage, `UPGRADE_INVULN_SEC`.
  - `abilityRunner.ts` — Per-player weapon/ability execution, projectiles, beams, zones, turrets, projectile replication.
  - `bossAI.ts` — Boss state machine (`chase`/`telegraph`/`execute`/`recover`), attacks, hazards.
  - `progression.ts` — Computed stats, level-up/synergy/artifact choice rolling, endless mastery cards.
  - `events.ts`, `types.ts`, `spatialHash.ts`, `math.ts`, `rng.ts` — Typed `SimEvent`s, entity/snapshot types, spatial hash, PRNG.
- **`src/shared/protocol.ts`** — Binary frame opcodes, `WireSnapshot` & `BinaryCombatEvent` encoders/decoders, JSON lobby/control message types.
- **`src/server/`**
  - `gameRoom.ts` — Authoritative 20 Hz room loop, binary snapshot/event serialization, input/upgrade handling, reconnect grace.
  - `roomManager.ts`, `server.ts`, `index.ts` — Room lifecycle, HTTP `/health`, WebSocket server entrypoint.
  - `coopRoom.ts` — Lightweight room wrapper used by headless simulation tests.
- **`src/client/`**
  - `engine/game.ts` — `GameEngine`: Solo & Co-op loops, explicit 6-layer Canvas Z-order, particles, floating numbers, invuln shield cue.
  - `engine/coopVfx.ts` — Co-op client VFX (`CoopVfxSystem`): teammate ability/projectile rendering (`Full`/`Dimmed`/`Off`), boss hazards/projectiles.
  - `engine/renderer/abilityRenderer.ts` — Solo Canvas renderer for player zones, projectiles/beams, companions, orbitals.
  - `engine/renderer/bossRenderer.ts` — Boss telegraphs, AoE rings, beams, and tether rendering (shared by Solo & Co-op).
  - `ui/uiManager.ts`, `style.css` — Main menu, lobby, HUD, live co-op upgrade strip, pause/build menu, mobile controls.
  - `netClient.ts` — WebSocket client, binary decoding, 60 Hz interpolation, input streaming.
  - `engine/input.ts`, `engine/audio.ts`, `engine/storage.ts`, `art/sprites.ts` — Keyboard/mouse/touch joystick, Web Audio, `localStorage` settings, procedural sprites.
- **`.github/workflows/deploy.yml`** — CI/CD pipeline deploying client + server on push to `main`.

## 3. Token-Saving & Scoping Rules for Agents
- **Never read unrelated directories:**
  - Balance/stat tweaks → inspect only `src/shared/data/` and `src/shared/sim/`.
  - Rendering/UI tweaks → inspect only `src/client/`.
  - Only touch `src/shared/protocol.ts` and `src/server/` when network state or events change.
- **Avoid full-file rewrites on large files:** `simulation.ts`, `abilityRunner.ts`, `game.ts`, `uiManager.ts`, `protocol.ts`, and `coopVfx.ts` are multi-thousand-line files — always make targeted, contiguous edits.
- **No integration test loops:** Verify changes strictly with `npx tsc --noEmit`, `npm run build`, and `npm run build:server`.

## 4. Critical Gameplay & Technical Invariants
- **Solo + Co-op Parity:** Changes in `src/shared/` must keep Solo Offline mode working identically alongside Online Co-op.
- **Protocol Sync:** Any new packet, event, flag, or field in `src/shared/protocol.ts` must be encoded/decoded symmetrically in both `src/server/` and `src/client/`.
- **Co-op Mechanics:**
  - Asynchronous personal level-ups (never pause other players in co-op; queue overflow choices).
  - `2.0s` post-level-up/evolution invulnerability (`invulnTimer = Math.max(invulnTimer, 2.0)`) in both Solo and Co-op with visible shield/shimmer cue.
  - Finite Magnet radius (~700 px) awarding personal XP in Co-op; full-map magnet in Solo Offline.
  - Full teammate projectile visibility (`Teammate Effects: Full / Dimmed / Off`, default `Full`), teammate damage numbers suppressed on client.
  - **Strict 6-Layer Canvas Z-Order (bottom → top):** (1) Ground & pickups, (2) Player ground zones/auras, (3) Player projectiles/beams/hit particles, (4) Regular enemies, companions, players, orbitals, (5) Bosses, boss telegraphs/AoE rings, and ALL enemy/boss projectiles (always above player spam), (6) Health bars, revive rings, floating numbers, HUD overlays.

## 5. Build & Deployment
- **Required checks before commit:**
  ```bash
  npx tsc --noEmit && npm run build && npm run build:server
  ```
  Produces `dist/` (single-file static client via Vite) and `dist-server/index.js` (standalone `esbuild` Node 22 bundle).
- **Auto-Deploy:** Pushing to `main` triggers `.github/workflows/deploy.yml`, which `rsync`s artifacts to `/opt/pastel-survivors/` and restarts the `systemd` service `pastel-game` on port `3000` behind Caddy reverse proxy (automatic TLS).
