import { ABILITIES, getAbilitiesForClass, getAbilityDef } from '@shared/data/abilities';
import { getArtifactDef } from '@shared/data/artifacts';
import {
  CLASS_LIST,
  CLASSES,
  MAX_ABILITY_LEVEL,
  MAX_ACTIVE_ABILITY_SLOTS,
} from '@shared/data/classes';
import { getSynergiesForClass, SYNERGIES } from '@shared/data/synergies';
import type { AbilityId, ArtifactDef, BossId, HeroId } from '@shared/data/types';
import {
  MAX_ROOM_PLAYERS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  WirePlayerFlag,
  type RoomStatePayload,
} from '@shared/protocol';
import type { RoomPaceMode, UpgradeChoiceIndex } from '@shared/sim/types';
import type {
  CoopMatchEndSummary,
  CoopUpgradeState,
  GameEngine,
  GameState,
  LevelUpChoice,
  RunStatsSnapshot,
} from '../engine/game';
import {
  getAllBestRuns,
  getBestRun,
  getNickname,
  getServerUrlOverride,
  resetSaveData,
  setNickname,
  setServerUrlOverride,
  type AimMode,
  type TeammateEffectsMode,
} from '../engine/storage';
import { resolveDefaultWsUrl, type NetConnectionState } from '../netClient';

/**
 * Responsive 16x16 pastel pixel-art UI Manager:
 *  - Main Menu (Title -> Solo Offline Class Select, Online Co-op Menu & Lobby, Records, Settings, How to Play)
 *  - In-game HUD (Personal XP bar, Squad HUD, Reconnecting badge, timer, kills, Boss HP, Hero HP, 6-slot strip + Artifacts)
 *  - Live Speed-Readable Upgrade Strip in Co-op (NO center modal) & Classic Level-Up / Artifact Modals in Solo
 *  - Pause Menu (Live stats, Global Passives, Synergy Reference Panel, non-pausing LIVE MATCH badge in Co-op)
 *  - Game Over & Co-op Match Summary Modals
 */

type PauseMobileTab = 'stats' | 'synergies';
type MenuView =
  | 'title'
  | 'class_select'
  | 'coop_menu'
  | 'coop_lobby'
  | 'records'
  | 'settings'
  | 'howto';
type PauseConfirmAction = 'restart' | 'menu' | null;

function formatTime(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const mins = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatPercent(value: number, signed = false): string {
  const pct = Math.round(value * 100);
  if (signed && pct > 0) return `+${pct}%`;
  return `${pct}%`;
}

export class UIManager {
  private readonly root: HTMLElement;
  private readonly game: GameEngine;

  // Top-level layer containers
  private readonly hudLayer: HTMLDivElement;
  private readonly liveUpgradeLayer: HTMLDivElement;
  private readonly menuLayer: HTMLDivElement;
  private readonly levelUpLayer: HTMLDivElement;
  private readonly artifactLayer: HTMLDivElement;
  private readonly pauseLayer: HTMLDivElement;
  private readonly gameOverLayer: HTMLDivElement;

  // Cached hero icon data URLs for lightweight Squad HUD / Match Summary rendering
  private readonly heroIconUrls: Record<HeroId, string>;

  // Cached HUD element references for zero-thrash updates
  private hudXpFill!: HTMLDivElement;
  private hudLevelBadge!: HTMLSpanElement;
  private hudXpText!: HTMLSpanElement;
  private hudHeroCanvas!: HTMLCanvasElement;
  private hudHeroName!: HTMLSpanElement;
  private hudHpNumbers!: HTMLSpanElement;
  private hudHpFill!: HTMLDivElement;
  private hudSquadList!: HTMLDivElement;
  private hudTimer!: HTMLSpanElement;
  private hudKills!: HTMLSpanElement;
  private hudNextBoss!: HTMLDivElement;
  private hudCoopMeta!: HTMLDivElement;
  private hudReconnectBadge!: HTMLDivElement;
  private hudAimBtn!: HTMLButtonElement;
  private hudMuteBtn!: HTMLButtonElement;
  private hudPauseBtn!: HTMLButtonElement;
  private hudBossBar!: HTMLDivElement;
  private hudBossCanvas!: HTMLCanvasElement;
  private hudBossName!: HTMLSpanElement;
  private hudBossEnraged!: HTMLSpanElement;
  private hudBossAttack!: HTMLSpanElement;
  private hudBossFill!: HTMLDivElement;
  private hudBossHpText!: HTMLDivElement;
  private hudSlotsStrip!: HTMLDivElement;
  private hudArtifactsStrip!: HTMLDivElement;

  // Menu animated preview canvases
  private menuPreviewCanvases: Array<{ heroId: HeroId; canvas: HTMLCanvasElement }> = [];

  // Dirty-checking cache for HUD DOM updates
  private lastSlotsKey = '';
  private lastArtifactsKey = '';
  private lastSquadKey = '';
  private lastCoopMetaText = '';
  private lastTimerText = '';
  private lastKillsCount = -1;
  private lastLevel = -1;
  private lastXpRatio = -1;
  private lastHpKey = '';
  private lastNextBossText = '';
  private lastBossVisible = false;
  private lastBossKey = '';
  private lastHudHeroFrame = -1;
  private lastHudHeroId: HeroId | null = null;
  private lastBossSpriteKey = '';

  // Menu, Co-op, Pause & Debug UI state
  private menuView: MenuView = 'title';
  private selectedHeroDetail: HeroId | null = null;
  private selectedAbilityDetail: AbilityId | null = null;
  private confirmResetSave = false;
  private pauseTab: PauseMobileTab = 'stats';
  private pauseConfirmAction: PauseConfirmAction = null;
  private debugUnlocked = false;

  // Co-op menu & lobby UI state
  private coopNickname = getNickname();
  private coopHeroId: HeroId = 'mage';
  private coopJoinCode = '';
  private coopServerOverride = getServerUrlOverride();
  private coopServerPanelOpen = getServerUrlOverride().length > 0;
  private coopErrorText = '';
  private coopCopyFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  private coopCodeCopied = false;
  private coopRoomState: RoomStatePayload | null = null;
  private coopConnectionState: NetConnectionState = 'disconnected';
  private coopUpgradeState: CoopUpgradeState | null = null;

  // UI animation loop
  private rafId: number | null = null;
  private lastAnimTime = 0;
  private previewAnimSec = 0;

  constructor(root: HTMLElement, game: GameEngine) {
    this.root = root;
    this.game = game;

    this.heroIconUrls = {
      mage: this.game.sprites.heroes.mage[0].toDataURL(),
      ranger: this.game.sprites.heroes.ranger[0].toDataURL(),
      knight: this.game.sprites.heroes.knight[0].toDataURL(),
      alchemist: this.game.sprites.heroes.alchemist[0].toDataURL(),
    };

    this.root.innerHTML = '';

    this.hudLayer = document.createElement('div');
    this.hudLayer.className = 'hud-layer hidden';

    this.liveUpgradeLayer = document.createElement('div');
    this.liveUpgradeLayer.className = 'live-upgrade-layer hidden';

    this.menuLayer = document.createElement('div');
    this.menuLayer.className = 'modal-backdrop menu-backdrop hidden';

    this.levelUpLayer = document.createElement('div');
    this.levelUpLayer.className = 'modal-backdrop hidden';

    this.artifactLayer = document.createElement('div');
    this.artifactLayer.className = 'modal-backdrop hidden';

    this.pauseLayer = document.createElement('div');
    this.pauseLayer.className = 'modal-backdrop hidden';

    this.gameOverLayer = document.createElement('div');
    this.gameOverLayer.className = 'modal-backdrop hidden';

    this.root.append(
      this.hudLayer,
      this.liveUpgradeLayer,
      this.menuLayer,
      this.levelUpLayer,
      this.artifactLayer,
      this.pauseLayer,
      this.gameOverLayer
    );

    this.buildHudDom();
    this.renderMainMenu();
    this.syncStateVisibility(this.game.getState());

    window.addEventListener('keydown', this.handleModalKeyDown);
    this.lastAnimTime = performance.now();
    this.rafId = requestAnimationFrame(this.uiLoop);
  }

  public destroy(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.coopCopyFeedbackTimer) {
      clearTimeout(this.coopCopyFeedbackTimer);
      this.coopCopyFeedbackTimer = null;
    }
    window.removeEventListener('keydown', this.handleModalKeyDown);
    this.root.innerHTML = '';
  }

  // ==========================================================================
  // ENGINE CALLBACK HANDLERS
  // ==========================================================================

  public handleStateChange(state: GameState): void {
    if (state === 'menu') {
      if (!this.game.isCoopMode()) {
        this.menuView = 'title';
      }
      this.selectedHeroDetail = null;
      this.selectedAbilityDetail = null;
      this.confirmResetSave = false;
      this.pauseConfirmAction = null;
      this.coopUpgradeState = null;
      this.renderLiveUpgradeStrip();
      this.renderMainMenu();
    } else if (state === 'paused') {
      this.pauseConfirmAction = null;
      this.renderPauseModal();
    } else if (state === 'playing') {
      this.pauseConfirmAction = null;
      this.resetHudCaches();
      this.updateHud(true);
    }
    this.syncStateVisibility(state);
  }

  public handleAimModeChange(mode: AimMode): void {
    this.updateAimButtons(mode);
  }

  public handleLevelUp(choices: readonly LevelUpChoice[]): void {
    // Solo Offline center modal (never called in Co-op)
    this.renderLevelUpModal(choices);
    this.syncStateVisibility('levelup');
  }

  public handleBossChestCollected(choices: readonly ArtifactDef[]): void {
    // Solo Offline center modal (never called in Co-op)
    this.renderArtifactModal(choices);
    this.syncStateVisibility('artifact');
  }

  public handleGameOver(summary: RunStatsSnapshot): void {
    this.renderGameOverModal(summary);
    this.syncStateVisibility('gameover');
  }

  // Co-op callbacks
  public handleCoopConnectionChange(conn: NetConnectionState): void {
    this.coopConnectionState = conn;
    this.hudReconnectBadge?.classList.toggle(
      'hidden',
      !(this.game.isCoopMode() && conn === 'reconnecting')
    );

    if (this.game.getState() === 'menu' && (this.menuView === 'coop_menu' || this.menuView === 'coop_lobby')) {
      this.renderMainMenu();
    }
  }

  public handleCoopRoomState(roomState: RoomStatePayload): void {
    this.coopRoomState = roomState;
    this.coopErrorText = '';
    if (this.game.getState() === 'menu' && roomState.status === 'lobby') {
      this.menuView = 'coop_lobby';
      this.renderMainMenu();
    }
  }

  public handleCoopUpgradeChoices(upgrade: CoopUpgradeState | null): void {
    this.coopUpgradeState = upgrade;
    this.renderLiveUpgradeStrip();
    this.syncStateVisibility(this.game.getState());
  }

  public handleCoopPauseToggle(open: boolean): void {
    this.pauseConfirmAction = null;
    if (open) {
      this.renderPauseModal();
    }
    this.syncStateVisibility(this.game.getState());
  }

  public handleCoopMatchEnd(summary: CoopMatchEndSummary): void {
    this.coopUpgradeState = null;
    this.renderLiveUpgradeStrip();
    this.renderCoopMatchEndModal(summary);
    this.syncStateVisibility('gameover');
  }

  public handleCoopError(_code: string, message: string): void {
    this.coopErrorText = message;
    if (this.game.getState() === 'menu') {
      this.renderMainMenu();
    }
  }

  public handleCoopReconnectFailed(reason: string): void {
    this.coopErrorText = reason;
    this.coopRoomState = null;
    this.coopUpgradeState = null;
    this.game.leaveCoopRoom();
    this.menuView = 'coop_menu';
    this.renderMainMenu();
  }

  // ==========================================================================
  // LAYER VISIBILITY & KEYBOARD SHORTCUTS
  // ==========================================================================

  private syncStateVisibility(state: GameState): void {
    const isCoop = this.game.isCoopMode();
    const showHud = state !== 'menu';
    const showLiveStrip =
      isCoop &&
      state === 'playing' &&
      this.coopUpgradeState !== null &&
      this.coopUpgradeState.choices.length > 0;
    const showPause =
      (!isCoop && state === 'paused') ||
      (isCoop && state === 'playing' && this.game.isCoopPauseOpen());

    this.hudLayer.classList.toggle('hidden', !showHud);
    this.liveUpgradeLayer.classList.toggle('hidden', !showLiveStrip);
    this.menuLayer.classList.toggle('hidden', state !== 'menu');
    this.levelUpLayer.classList.toggle('hidden', isCoop || state !== 'levelup');
    this.artifactLayer.classList.toggle('hidden', isCoop || state !== 'artifact');
    this.pauseLayer.classList.toggle('hidden', !showPause);
    this.gameOverLayer.classList.toggle('hidden', state !== 'gameover');
  }

  private toggleDebugUnlocked(): void {
    this.debugUnlocked = !this.debugUnlocked;
    const state = this.game.getState();
    if (state === 'paused' || this.game.isCoopPauseOpen()) {
      this.renderPauseModal();
    } else if (state === 'menu' && this.menuView === 'howto') {
      this.renderMainMenu();
    }
  }

  private readonly handleModalKeyDown = (e: KeyboardEvent): void => {
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable)
    ) {
      return;
    }

    const state = this.game.getState();

    // Hidden Debug Menu shortcut: Ctrl + Shift + D (or Cmd + Shift + D)
    if (!e.repeat && (e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyD') {
      e.preventDefault();
      this.game.audio.unlock();
      this.game.audio.playClick();
      this.toggleDebugUnlocked();
      return;
    }

    const idx: UpgradeChoiceIndex | null =
      e.key === '1' ? 0 : e.key === '2' ? 1 : e.key === '3' ? 2 : null;
    if (idx === null) return;

    // Co-op Live Speed-Readable Upgrade Strip hotkeys (1/2/3 without interrupting WASD!)
    if (
      this.game.isCoopMode() &&
      state === 'playing' &&
      !e.repeat &&
      this.coopUpgradeState &&
      this.coopUpgradeState.choices[idx]
    ) {
      e.preventDefault();
      this.game.pickCoopUpgrade(idx);
      this.renderLiveUpgradeStrip();
      return;
    }

    if (state !== 'levelup' && state !== 'artifact') return;

    if (state === 'levelup') {
      const choices = this.game.getPendingLevelUpChoices();
      if (choices[idx]) {
        e.preventDefault();
        this.game.audio.unlock();
        this.game.audio.playClick();
        this.game.applyLevelUpChoice(choices[idx]);
      }
    } else if (state === 'artifact') {
      const choices = this.game.getPendingArtifactChoices();
      if (choices[idx]) {
        e.preventDefault();
        this.game.audio.unlock();
        this.game.audio.playClick();
        this.game.grantArtifact(choices[idx].id);
      }
    }
  };

  // ==========================================================================
  // 1. MAIN MENU (TITLE, CLASS SELECT, RECORDS, SETTINGS, HOW TO PLAY)
  // ==========================================================================

  private renderMainMenu(): void {
    this.menuPreviewCanvases = [];
    switch (this.menuView) {
      case 'title':
        this.renderTitleView();
        break;
      case 'class_select':
        this.renderClassSelectView();
        break;
      case 'coop_menu':
        this.renderCoopMenuView();
        break;
      case 'coop_lobby':
        this.renderCoopLobbyView();
        break;
      case 'records':
        this.renderRecordsView();
        break;
      case 'settings':
        this.renderSettingsView();
        break;
      case 'howto':
        this.renderHowToPlayView();
        break;
    }
  }

  private bindMenuPreviews(): void {
    const previewNodes = this.menuLayer.querySelectorAll<HTMLCanvasElement>('[data-hero-preview]');
    previewNodes.forEach((canvas) => {
      const heroId = canvas.dataset.heroPreview as HeroId;
      this.menuPreviewCanvases.push({ heroId, canvas });
    });
    this.drawMenuHeroPreviews(0);
  }

  private bindBackToTitle(): void {
    this.menuLayer.querySelector('[data-menu-back]')?.addEventListener('click', () => {
      this.game.audio.unlock();
      this.game.audio.playClick();
      this.confirmResetSave = false;
      this.selectedHeroDetail = null;
      this.selectedAbilityDetail = null;
      this.coopErrorText = '';
      if (this.game.isCoopMode()) {
        this.game.leaveCoopRoom();
      }
      this.menuView = 'title';
      this.renderMainMenu();
    });
  }

  private renderTitleView(): void {
    const muted = this.game.audio.isMuted();
    const aimMode = this.game.input.getAimMode();

    this.menuLayer.innerHTML = `
      <div class="modal-card title-modal-card">
        <div class="title-screen">
          <div class="title-badge-pill">16x16 PIXEL-ART ROGUELITE</div>
          <h1 class="menu-title title-main-heading">PASTEL SURVIVORS</h1>
          <p class="menu-subtitle">3 Heroes • 30 Abilities • 15 Synergies • 3 Bosses • 1–4P Co-op</p>

          <div class="title-nav-stack">
            <button type="button" class="px-btn px-btn-primary title-nav-btn title-play-btn" data-menu-nav="class_select">
              SOLO OFFLINE
            </button>
            <button type="button" class="px-btn px-btn-lavender title-nav-btn title-play-btn" data-menu-nav="coop_menu">
              ONLINE CO-OP (1–4P)
            </button>
            <div class="title-secondary-row">
              <button type="button" class="px-btn px-btn-butter title-nav-btn" data-menu-nav="records">
                RECORDS
              </button>
              <button type="button" class="px-btn px-btn-blue title-nav-btn" data-menu-nav="settings">
                SETTINGS
              </button>
            </div>
            <button type="button" class="px-btn px-btn-peach title-nav-btn" data-menu-nav="howto">
              HOW TO PLAY
            </button>
          </div>

          <div class="title-status-strip">
            <span class="px-pill">AIM: ${aimMode === 'mouse' ? 'MOUSE' : 'AUTO'}</span>
            <span class="px-pill">${muted ? 'SFX: OFF' : 'SFX: ON'}</span>
          </div>
        </div>
      </div>
    `;

    const navBtns = this.menuLayer.querySelectorAll<HTMLButtonElement>('[data-menu-nav]');
    navBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.menuNav as MenuView;
        this.game.audio.unlock();
        this.game.audio.playClick();
        this.confirmResetSave = false;
        this.selectedHeroDetail = null;
        this.selectedAbilityDetail = null;
        this.coopErrorText = '';
        this.menuView = target;
        this.renderMainMenu();
      });
    });
  }

  private renderCoopMenuView(): void {
    const isConnecting = this.coopConnectionState === 'connecting';
    const defaultUrl = resolveDefaultWsUrl();

    const heroPillsHtml = CLASS_LIST.map((cls) => {
      const selected = this.coopHeroId === cls.id;
      return `
        <button
          type="button"
          class="coop-hero-pill ${selected ? 'selected' : ''}"
          data-coop-pick-hero="${cls.id}"
          style="--hero-accent:${cls.accentColor}"
        >
          <canvas class="coop-hero-pill-canvas pixel-art" width="16" height="16" data-hero-preview="${cls.id}"></canvas>
          <span>${escapeHtml(cls.name)}</span>
        </button>
      `;
    }).join('');

    this.menuLayer.innerHTML = `
      <div class="modal-card subview-compact-card">
        <div class="menu-header">
          <div class="subview-title-row">
            <button type="button" class="px-btn" data-menu-back>← BACK</button>
            <div class="menu-title-block">
              <h1 class="menu-title">ONLINE CO-OP</h1>
              <p class="menu-subtitle">Team up with up to 4 friends — live personal upgrades, shared bosses & revives</p>
            </div>
          </div>
        </div>

        ${
          this.coopErrorText
            ? `<div class="coop-error-banner" role="alert">${escapeHtml(this.coopErrorText)}</div>`
            : ''
        }

        <div class="coop-form-card">
          <div class="coop-field-row">
            <label class="coop-field-label" for="coop-nickname-input">PLAYER NICKNAME</label>
            <input
              id="coop-nickname-input"
              type="text"
              class="px-input"
              maxlength="20"
              placeholder="e.g. MochiMage"
              value="${escapeHtml(this.coopNickname)}"
              autocomplete="nickname"
              data-coop-nickname
            />
          </div>

          <div class="coop-field-row">
            <span class="coop-field-label">STARTING HERO (CAN CHANGE IN LOBBY)</span>
            <div class="coop-hero-strip">
              ${heroPillsHtml}
            </div>
          </div>
        </div>

        <div class="coop-actions-grid">
          <div class="coop-action-box">
            <h3 class="coop-action-title">HOST A NEW ROOM</h3>
            <p class="coop-action-desc">Generate a 4-character Room Code and pick pace mode in the lobby.</p>
            <button
              type="button"
              class="px-btn px-btn-primary coop-big-btn"
              data-coop-create
              ${isConnecting ? 'disabled' : ''}
            >
              ${isConnecting ? 'CONNECTING...' : 'CREATE ROOM'}
            </button>
          </div>

          <div class="coop-action-box">
            <h3 class="coop-action-title">JOIN BY ROOM CODE</h3>
            <p class="coop-action-desc">Enter your host's 4-letter Room Code to join their squad.</p>
            <div class="coop-join-row">
              <input
                type="text"
                class="px-input coop-code-input"
                maxlength="${ROOM_CODE_LENGTH}"
                placeholder="ABCD"
                value="${escapeHtml(this.coopJoinCode)}"
                spellcheck="false"
                autocapitalize="characters"
                data-coop-code-input
              />
              <button
                type="button"
                class="px-btn px-btn-lavender coop-big-btn"
                data-coop-join
                ${isConnecting ? 'disabled' : ''}
              >
                ${isConnecting ? '...' : 'JOIN ROOM'}
              </button>
            </div>
          </div>
        </div>

        <details class="coop-server-details" ${this.coopServerPanelOpen ? 'open' : ''} data-coop-server-details>
          <summary class="coop-server-summary">
            <span>Server URL Override (Optional / Mobile Testing)</span>
            <span class="px-pill">${this.coopServerOverride ? 'CUSTOM' : 'DEFAULT'}</span>
          </summary>
          <div class="coop-server-body">
            <div class="coop-server-default-hint">Default: <code>${escapeHtml(defaultUrl)}</code></div>
            <div class="coop-server-input-row">
              <input
                type="url"
                class="px-input"
                placeholder="${escapeHtml(defaultUrl)}"
                value="${escapeHtml(this.coopServerOverride)}"
                spellcheck="false"
                data-coop-server-input
              />
              <button type="button" class="px-btn" data-coop-server-reset>RESET</button>
            </div>
          </div>
        </details>
      </div>
    `;

    this.bindMenuPreviews();
    this.bindBackToTitle();

    const nickInput = this.menuLayer.querySelector<HTMLInputElement>('[data-coop-nickname]');
    nickInput?.addEventListener('input', () => {
      this.coopNickname = nickInput.value.slice(0, 20);
      setNickname(this.coopNickname);
    });

    const heroBtns = this.menuLayer.querySelectorAll<HTMLButtonElement>('[data-coop-pick-hero]');
    heroBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        this.game.audio.unlock();
        this.game.audio.playClick();
        this.coopHeroId = btn.dataset.coopPickHero as HeroId;
        heroBtns.forEach((b) =>
          b.classList.toggle('selected', b.dataset.coopPickHero === this.coopHeroId)
        );
      });
    });

    const codeInput = this.menuLayer.querySelector<HTMLInputElement>('[data-coop-code-input]');
    codeInput?.addEventListener('input', () => {
      const cleaned = codeInput.value
        .toUpperCase()
        .split('')
        .filter((ch) => ROOM_CODE_ALPHABET.includes(ch))
        .join('')
        .slice(0, ROOM_CODE_LENGTH);
      codeInput.value = cleaned;
      this.coopJoinCode = cleaned;
    });
    codeInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && this.coopJoinCode.length === ROOM_CODE_LENGTH) {
        this.triggerJoinRoom();
      }
    });

    const detailsEl = this.menuLayer.querySelector<HTMLDetailsElement>('[data-coop-server-details]');
    detailsEl?.addEventListener('toggle', () => {
      this.coopServerPanelOpen = detailsEl.open;
    });

    const serverInput = this.menuLayer.querySelector<HTMLInputElement>('[data-coop-server-input]');
    serverInput?.addEventListener('input', () => {
      this.coopServerOverride = serverInput.value.trim();
      setServerUrlOverride(this.coopServerOverride);
    });

    this.menuLayer.querySelector('[data-coop-server-reset]')?.addEventListener('click', () => {
      this.game.audio.playClick();
      this.coopServerOverride = '';
      setServerUrlOverride('');
      if (serverInput) serverInput.value = '';
      this.renderMainMenu();
    });

    this.menuLayer.querySelector('[data-coop-create]')?.addEventListener('click', () => {
      this.game.audio.unlock();
      this.game.audio.playClick();
      this.coopErrorText = '';
      setNickname(this.coopNickname);
      this.game.createCoopRoom({
        heroId: this.coopHeroId,
        paceMode: 'coop_pace',
        name: this.coopNickname || undefined,
        serverUrl: this.coopServerOverride || undefined,
      });
    });

    this.menuLayer.querySelector('[data-coop-join]')?.addEventListener('click', () => {
      this.triggerJoinRoom();
    });
  }

  private triggerJoinRoom(): void {
    this.game.audio.unlock();
    this.game.audio.playClick();
    this.coopErrorText = '';
    setNickname(this.coopNickname);
    this.game.joinCoopRoom({
      roomCode: this.coopJoinCode,
      heroId: this.coopHeroId,
      name: this.coopNickname || undefined,
      serverUrl: this.coopServerOverride || undefined,
    });
  }

  private renderCoopLobbyView(): void {
    const room = this.coopRoomState ?? this.game.getCoopRoomState();
    if (!room) {
      this.menuView = 'coop_menu';
      this.renderCoopMenuView();
      return;
    }

    const myPlayerId = this.game.net.getPlayerId();
    const isHost = this.game.net.getIsHost();
    const myEntry = room.players.find((p) => p.playerId === myPlayerId);
    const myHeroId: HeroId = myEntry?.heroId ?? this.coopHeroId;
    const myReady = myEntry?.ready ?? false;

    const allOthersReady = room.players.every((p) => p.isHost || p.ready);
    const isSoloTestStart = room.players.length === 1;
    const canStartMatch = isHost && (isSoloTestStart || allOthersReady);

    const slotsHtml: string[] = [];
    for (let slotNum = 1; slotNum <= MAX_ROOM_PLAYERS; slotNum++) {
      const player = room.players.find((p) => p.slotId === slotNum);
      if (player) {
        const cls = CLASSES[player.heroId];
        const isMe = player.playerId === myPlayerId;
        const readyBadge = player.ready
          ? `<span class="lobby-ready-badge ready">✓ READY</span>`
          : player.isHost && isSoloTestStart
          ? `<span class="lobby-ready-badge host-solo">READY TO TEST</span>`
          : `<span class="lobby-ready-badge waiting">NOT READY</span>`;

        slotsHtml.push(`
          <div class="lobby-slot filled ${isMe ? 'is-me' : ''} ${player.ready ? 'is-ready' : ''}">
            <div class="lobby-slot-avatar" style="background:${cls.accentColor}">
              <canvas class="lobby-slot-canvas pixel-art" width="16" height="16" data-hero-preview="${player.heroId}"></canvas>
            </div>
            <div class="lobby-slot-info">
              <div class="lobby-slot-name-row">
                <span class="lobby-slot-name">${escapeHtml(player.name)}</span>
                ${isMe ? '<span class="px-pill lobby-you-pill">YOU</span>' : ''}
                ${player.isHost ? '<span class="px-pill lobby-host-pill">★ HOST</span>' : ''}
              </div>
              <div class="lobby-slot-class">${escapeHtml(cls.name)} — ${escapeHtml(cls.title)}</div>
              <div class="lobby-slot-status-row">
                ${readyBadge}
                ${!player.connected ? '<span class="px-pill" style="background:var(--coral)">DC</span>' : ''}
              </div>
            </div>
          </div>
        `);
      } else {
        slotsHtml.push(`
          <div class="lobby-slot empty">
            <div class="lobby-slot-empty-num">P${slotNum}</div>
            <div class="lobby-slot-empty-text">WAITING FOR PLAYER...</div>
          </div>
        `);
      }
    }

    const classPickerHtml = CLASS_LIST.map((cls) => {
      const selected = myHeroId === cls.id;
      return `
        <button
          type="button"
          class="coop-hero-pill ${selected ? 'selected' : ''}"
          data-lobby-class="${cls.id}"
          style="--hero-accent:${cls.accentColor}"
        >
          <canvas class="coop-hero-pill-canvas pixel-art" width="16" height="16" data-hero-preview="${cls.id}"></canvas>
          <span>${escapeHtml(cls.name)}</span>
        </button>
      `;
    }).join('');

    const paceHtml = isHost
      ? `
        <div class="lobby-pace-toggle">
          <button
            type="button"
            class="px-btn ${room.paceMode === 'coop_pace' ? 'px-btn-primary' : ''}"
            data-lobby-pace="coop_pace"
          >
            CO-OP 20M
          </button>
          <button
            type="button"
            class="px-btn ${room.paceMode === 'standard' ? 'px-btn-blue' : ''}"
            data-lobby-pace="standard"
          >
            STANDARD 30M
          </button>
        </div>
      `
      : `
        <span class="px-pill" style="background:${room.paceMode === 'coop_pace' ? 'var(--mint)' : 'var(--baby-blue)'}">
          PACE: ${room.paceMode === 'coop_pace' ? 'CO-OP 20M' : 'STANDARD 30M'}
        </span>
      `;

    this.menuLayer.innerHTML = `
      <div class="modal-card subview-compact-card">
        <div class="menu-header">
          <div class="subview-title-row">
            <button type="button" class="px-btn px-btn-coral" data-lobby-leave>← LEAVE</button>
            <div class="menu-title-block">
              <h1 class="menu-title">CO-OP LOBBY</h1>
              <p class="menu-subtitle">${room.players.length}/${MAX_ROOM_PLAYERS} Players Joined</p>
            </div>
          </div>

          <div class="lobby-code-card">
            <span class="lobby-code-label">ROOM CODE</span>
            <span class="lobby-code-value">${escapeHtml(room.roomCode)}</span>
            <button type="button" class="px-btn px-btn-butter lobby-copy-btn" data-lobby-copy>
              ${this.coopCodeCopied ? '✓ COPIED!' : 'COPY CODE'}
            </button>
          </div>
        </div>

        ${
          this.coopErrorText
            ? `<div class="coop-error-banner" role="alert">${escapeHtml(this.coopErrorText)}</div>`
            : ''
        }

        <div class="lobby-slots-grid">
          ${slotsHtml.join('')}
        </div>

        <div class="lobby-controls-bar">
          <div class="lobby-control-group">
            <span class="coop-field-label">YOUR HERO</span>
            <div class="coop-hero-strip">
              ${classPickerHtml}
            </div>
          </div>

          <div class="lobby-control-group">
            <span class="coop-field-label">MATCH PACE</span>
            ${paceHtml}
          </div>
        </div>

        <div class="lobby-footer">
          <button
            type="button"
            class="px-btn ${myReady ? 'px-btn-primary' : 'px-btn-butter'} lobby-action-btn"
            data-lobby-ready
          >
            ${myReady ? '✓ READY (TAP TO UNREADY)' : 'READY UP'}
          </button>

          ${
            isHost
              ? `
            <button
              type="button"
              class="px-btn px-btn-lavender lobby-action-btn lobby-start-btn"
              data-lobby-start
              ${canStartMatch ? '' : 'disabled'}
            >
              ${isSoloTestStart ? 'START SOLO CO-OP TEST' : 'START MATCH'}
            </button>
          `
              : `<div class="lobby-wait-note">Waiting for Host to start the match...</div>`
          }
        </div>
        ${
          isHost && !canStartMatch
            ? `<div class="lobby-hint-line">All joined teammates must click Ready before starting.</div>`
            : isHost && isSoloTestStart
            ? `<div class="lobby-hint-line">Share code <strong>${escapeHtml(room.roomCode)}</strong> for up to 4 players, or start now for 1-player online testing.</div>`
            : ''
        }
      </div>
    `;

    this.bindMenuPreviews();

    this.menuLayer.querySelector('[data-lobby-leave]')?.addEventListener('click', () => {
      this.game.audio.unlock();
      this.game.audio.playClick();
      this.coopRoomState = null;
      this.coopErrorText = '';
      this.game.leaveCoopRoom();
      this.menuView = 'coop_menu';
      this.renderMainMenu();
    });

    this.menuLayer.querySelector('[data-lobby-copy]')?.addEventListener('click', () => {
      this.game.audio.unlock();
      this.game.audio.playClick();
      const code = room.roomCode;
      if (navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(code).catch(() => {});
      } else {
        const temp = document.createElement('textarea');
        temp.value = code;
        temp.style.position = 'fixed';
        temp.style.opacity = '0';
        document.body.appendChild(temp);
        temp.select();
        try {
          document.execCommand('copy');
        } catch {
          // Ignore fallback errors
        }
        document.body.removeChild(temp);
      }
      this.coopCodeCopied = true;
      if (this.coopCopyFeedbackTimer) clearTimeout(this.coopCopyFeedbackTimer);
      this.coopCopyFeedbackTimer = setTimeout(() => {
        this.coopCodeCopied = false;
        if (this.menuView === 'coop_lobby' && this.game.getState() === 'menu') {
          this.renderMainMenu();
        }
      }, 1800);
      this.renderMainMenu();
    });

    const classBtns = this.menuLayer.querySelectorAll<HTMLButtonElement>('[data-lobby-class]');
    classBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const heroId = btn.dataset.lobbyClass as HeroId;
        this.coopHeroId = heroId;
        this.game.audio.unlock();
        this.game.audio.playClick();
        this.game.net.selectClass(heroId);
      });
    });

    const paceBtns = this.menuLayer.querySelectorAll<HTMLButtonElement>('[data-lobby-pace]');
    paceBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const pace = btn.dataset.lobbyPace as RoomPaceMode;
        this.game.audio.unlock();
        this.game.audio.playClick();
        this.game.net.setPaceMode(pace);
      });
    });

    this.menuLayer.querySelector('[data-lobby-ready]')?.addEventListener('click', () => {
      this.game.audio.unlock();
      this.game.audio.playClick();
      this.game.net.toggleReady();
    });

    this.menuLayer.querySelector('[data-lobby-start]')?.addEventListener('click', () => {
      if (!canStartMatch) return;
      this.game.audio.unlock();
      this.game.audio.playClick();
      this.coopErrorText = '';
      this.game.net.startMatch();
    });
  }

  private renderAbilityDetailHtml(heroId: HeroId): string {
    const cls = CLASSES[heroId];
    if (!this.selectedAbilityDetail) {
      return `
        <div class="ability-detail-hint">
          Tap any ability icon above to inspect its description, Lv 5 / Lv 10 passives, and synergies.
        </div>
      `;
    }

    const ab = getAbilityDef(this.selectedAbilityDetail);
    const abIcon = this.game.sprites.iconUrls[ab.iconId];
    const classSynergies = getSynergiesForClass(cls.id);
    const matchingSynergies = classSynergies.filter((s) => s.requires.includes(ab.id));

    const synergiesHtml = matchingSynergies
      .map((syn) => {
        const partnerId = syn.requires[0] === ab.id ? syn.requires[1] : syn.requires[0];
        const partner = getAbilityDef(partnerId);
        return `
          <div class="ability-detail-synergy-row">
            <div class="ability-detail-syn-formula">
              <span class="syn-part owned">
                <img class="pixel-art" src="${abIcon}" alt="${escapeHtml(ab.name)}" />
                <span>${escapeHtml(ab.name)}</span>
              </span>
              <span class="syn-op">+</span>
              <span class="syn-part">
                <img class="pixel-art" src="${this.game.sprites.iconUrls[partner.iconId]}" alt="${escapeHtml(partner.name)}" />
                <span>${escapeHtml(partner.name)}</span>
              </span>
              <span class="syn-op">=</span>
              <span class="syn-part result">
                <img class="pixel-art" src="${this.game.sprites.iconUrls[syn.iconId]}" alt="${escapeHtml(syn.name)}" />
                <span>${escapeHtml(syn.name)}</span>
              </span>
            </div>
            <div class="ability-detail-syn-desc">
              ${escapeHtml(syn.evolvedSpec.summary)} • <strong>${escapeHtml(syn.bonusPassive.label)}</strong>
            </div>
          </div>
        `;
      })
      .join('');

    return `
      <div class="ability-detail-panel" data-ability-detail-panel>
        <div class="ability-detail-header">
          <div class="ability-detail-icon-box" style="background:${ab.color}">
            <img class="pixel-art" src="${abIcon}" alt="${escapeHtml(ab.name)}" />
          </div>
          <div class="ability-detail-heading">
            <div class="ability-detail-title-row">
              <h4>${escapeHtml(ab.name)}</h4>
              ${ab.id === cls.startingAbilityId ? '<span class="px-pill" style="background:var(--butter)">SIGNATURE</span>' : ''}
            </div>
            <p class="ability-detail-desc">${escapeHtml(ab.description)}</p>
          </div>
        </div>

        <div class="ability-detail-passives">
          <div class="ability-passive-pill">
            <span class="ability-passive-lv">LV 5 PASSIVE</span>
            <span>${escapeHtml(ab.lv5Passive.label)}</span>
          </div>
          <div class="ability-passive-pill">
            <span class="ability-passive-lv">LV 10 PASSIVE</span>
            <span>${escapeHtml(ab.lv10Passive.label)}</span>
          </div>
        </div>

        <div class="ability-detail-synergies">
          <div class="ability-detail-section-label">Possible Synergies (Lv 10 + Lv 10)</div>
          ${synergiesHtml || '<div class="ability-detail-syn-desc">No synergies available.</div>'}
        </div>
      </div>
    `;
  }

  private renderHeroDetailModalHtml(heroId: HeroId): string {
    const cls = CLASSES[heroId];
    const sig = getAbilityDef(cls.startingAbilityId);
    const sigIcon = this.game.sprites.iconUrls[sig.iconId];
    const best = getBestRun(cls.id);
    const armorPct = Math.round(cls.baseStats.armor * 100);
    const critPct = Math.round(cls.baseStats.critChance * 100);
    const classAbilities = getAbilitiesForClass(cls.id);

    const bestSummary =
      best.runsPlayed > 0
        ? `Best: ${formatTime(best.bestTimeSec)} • LV ${best.bestLevel} • ${best.bestKills} Kills • ${best.bestBosses} Bosses`
        : 'No runs recorded yet';

    const abilityTilesHtml = classAbilities
      .map((ab) => {
        const iconUrl = this.game.sprites.iconUrls[ab.iconId];
        const isSelected = this.selectedAbilityDetail === ab.id;
        const isSig = ab.id === cls.startingAbilityId;
        return `
          <button
            type="button"
            class="hero-ability-tile ${isSelected ? 'selected' : ''} ${isSig ? 'signature' : ''}"
            data-inspect-ability="${ab.id}"
            title="${escapeHtml(ab.name)}"
          >
            ${isSig ? '<span class="hero-ability-sig-dot" title="Signature Ability">★</span>' : ''}
            <img class="pixel-art" src="${iconUrl}" alt="${escapeHtml(ab.name)}" />
            <span class="hero-ability-tile-name">${escapeHtml(ab.name)}</span>
          </button>
        `;
      })
      .join('');

    return `
      <div class="hero-detail-backdrop" data-hero-detail-modal>
        <div class="hero-detail-window">
          <div class="hero-detail-header">
            <div class="class-card-top">
              <div class="class-preview-box" style="background:${cls.accentColor}">
                <canvas class="class-preview-canvas pixel-art" width="16" height="16" data-hero-preview="${cls.id}"></canvas>
              </div>
              <div class="class-name-wrap">
                <h2 class="class-name">${escapeHtml(cls.name)}</h2>
                <div class="class-title">${escapeHtml(cls.title)}</div>
                <div class="hero-detail-best-line">${bestSummary}</div>
              </div>
            </div>
            <button type="button" class="px-btn" data-close-hero-detail>✕ CLOSE</button>
          </div>

          <p class="class-desc">${escapeHtml(cls.description)}</p>

          <div class="class-stats-grid">
            <div class="class-stat-pill"><span>HP</span><span>${cls.baseStats.maxHp}</span></div>
            <div class="class-stat-pill"><span>SPD</span><span>${cls.baseStats.moveSpeed}</span></div>
            <div class="class-stat-pill"><span>PCK</span><span>${cls.baseStats.pickupRadius}</span></div>
            <div class="class-stat-pill"><span>ARM</span><span>${armorPct}%</span></div>
            <div class="class-stat-pill"><span>CRIT</span><span>${critPct}%</span></div>
            <div class="class-stat-pill"><span>REGEN</span><span>${cls.baseStats.hpRegen}/s</span></div>
          </div>

          <div class="class-sig-box">
            <img class="pixel-art" src="${sigIcon}" alt="${escapeHtml(sig.name)}" />
            <div class="class-sig-text">
              <span class="class-sig-label">Signature Starting Ability</span>
              <span class="class-sig-name">${escapeHtml(sig.name)} — <span style="font-weight:600;color:var(--text-muted)">${escapeHtml(sig.description)}</span></span>
            </div>
          </div>

          <div class="hero-abilities-section">
            <div class="hero-abilities-header">
              <span>Class Abilities (5 × 2)</span>
              <span class="px-pill">${classAbilities.length} ABILITIES</span>
            </div>
            <div class="hero-abilities-grid">
              ${abilityTilesHtml}
            </div>
            <div data-ability-detail-container>
              ${this.renderAbilityDetailHtml(cls.id)}
            </div>
          </div>

          <div class="hero-detail-footer">
            <button type="button" class="px-btn" data-close-hero-detail>BACK</button>
            <button type="button" class="px-btn px-btn-primary hero-detail-play-btn" data-start-hero="${cls.id}">
              PLAY ${escapeHtml(cls.name.toUpperCase())}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private renderClassSelectView(): void {
    const muted = this.game.audio.isMuted();
    const aimMode = this.game.input.getAimMode();

    const tilesHtml = CLASS_LIST.map((cls) => {
      const best = getBestRun(cls.id);
      const isSelected = this.selectedHeroDetail === cls.id;
      return `
        <button
          type="button"
          class="hero-select-tile ${isSelected ? 'selected' : ''}"
          data-select-hero="${cls.id}"
        >
          <div class="hero-tile-avatar" style="background:${cls.accentColor}">
            <canvas class="class-preview-canvas pixel-art" width="16" height="16" data-hero-preview="${cls.id}"></canvas>
          </div>
          <div class="hero-tile-name">${escapeHtml(cls.name)}</div>
          <div class="hero-tile-title">${escapeHtml(cls.title)}</div>
          <div class="hero-tile-meta">
            ${best.runsPlayed > 0 ? `Best ${formatTime(best.bestTimeSec)} • LV ${best.bestLevel}` : 'Tap to inspect'}
          </div>
        </button>
      `;
    }).join('');

    const detailModalHtml = this.selectedHeroDetail
      ? this.renderHeroDetailModalHtml(this.selectedHeroDetail)
      : '';

    this.menuLayer.innerHTML = `
      <div class="modal-card subview-compact-card">
        <div class="menu-header">
          <div class="subview-title-row">
            <button type="button" class="px-btn" data-menu-back>← BACK</button>
            <div class="menu-title-block">
              <h1 class="menu-title">CHOOSE YOUR HERO</h1>
              <p class="menu-subtitle">Tap a hero to inspect stats, abilities, and synergies</p>
            </div>
          </div>
          <div class="menu-header-actions">
            <button type="button" class="px-btn ${aimMode === 'mouse' ? 'px-btn-blue' : ''}" data-menu-aim>
              AIM: ${aimMode === 'mouse' ? 'MOUSE' : 'AUTO'}
            </button>
            <button type="button" class="px-btn ${muted ? 'px-btn-coral' : 'px-btn-butter'}" data-menu-mute>
              ${muted ? 'SFX: OFF' : 'SFX: ON'}
            </button>
          </div>
        </div>

        <div class="hero-tile-grid">
          ${tilesHtml}
        </div>

        <div class="menu-footer-hint">
          Desktop: WASD / Arrows to move • M Aim Mode • ESC / P Pause &nbsp;|&nbsp; Mobile: Touch & drag anywhere for floating joystick
        </div>

        ${detailModalHtml}
      </div>
    `;

    this.bindMenuPreviews();
    this.bindBackToTitle();

    // Bind Hero Tile taps to open Hero Detail Window
    const tileBtns = this.menuLayer.querySelectorAll<HTMLButtonElement>('[data-select-hero]');
    tileBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const heroId = btn.dataset.selectHero as HeroId;
        this.game.audio.unlock();
        this.game.audio.playClick();
        this.selectedHeroDetail = heroId;
        this.selectedAbilityDetail = null;
        this.renderMainMenu();
      });
    });

    // Bind Close Hero Detail buttons & backdrop click
    const closeBtns = this.menuLayer.querySelectorAll<HTMLButtonElement>('[data-close-hero-detail]');
    closeBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        this.game.audio.playClick();
        this.selectedHeroDetail = null;
        this.selectedAbilityDetail = null;
        this.renderMainMenu();
      });
    });

    const detailBackdrop = this.menuLayer.querySelector<HTMLDivElement>('[data-hero-detail-modal]');
    detailBackdrop?.addEventListener('click', (e) => {
      if (e.target === detailBackdrop) {
        this.game.audio.playClick();
        this.selectedHeroDetail = null;
        this.selectedAbilityDetail = null;
        this.renderMainMenu();
      }
    });

    // Bind 5x2 Ability icon taps (update in-place so modal scroll position never snaps back)
    const abilityBtns = this.menuLayer.querySelectorAll<HTMLButtonElement>('[data-inspect-ability]');
    const detailContainer = this.menuLayer.querySelector<HTMLDivElement>('[data-ability-detail-container]');
    abilityBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const abId = btn.dataset.inspectAbility as AbilityId;
        this.game.audio.unlock();
        this.game.audio.playClick();
        this.selectedAbilityDetail = this.selectedAbilityDetail === abId ? null : abId;

        abilityBtns.forEach((b) => {
          b.classList.toggle('selected', b.dataset.inspectAbility === this.selectedAbilityDetail);
        });
        if (detailContainer && this.selectedHeroDetail) {
          detailContainer.innerHTML = this.renderAbilityDetailHtml(this.selectedHeroDetail);
        }
      });
    });

    // Bind Start Class button inside Hero Detail Window
    const startBtns = this.menuLayer.querySelectorAll<HTMLButtonElement>('[data-start-hero]');
    startBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const heroId = btn.dataset.startHero as HeroId;
        this.game.audio.unlock();
        this.game.audio.playClick();
        this.selectedHeroDetail = null;
        this.selectedAbilityDetail = null;
        this.resetHudCaches();
        this.game.startRun(heroId);
      });
    });

    // Bind Menu Aim & Mute toggles
    const aimBtn = this.menuLayer.querySelector<HTMLButtonElement>('[data-menu-aim]');
    aimBtn?.addEventListener('click', () => {
      this.game.audio.unlock();
      const next = this.game.input.toggleAimMode();
      this.updateAimButtons(next);
    });

    const muteBtn = this.menuLayer.querySelector<HTMLButtonElement>('[data-menu-mute]');
    muteBtn?.addEventListener('click', () => {
      this.game.audio.toggleMute();
      this.updateMuteButtons(this.game.audio.isMuted());
    });
  }

  private renderRecordsView(): void {
    const allRuns = getAllBestRuns();
    const totalRuns = CLASS_LIST.reduce((acc, cls) => acc + allRuns[cls.id].runsPlayed, 0);

    const rowsHtml = CLASS_LIST.map((cls) => {
      const rec = allRuns[cls.id];
      return `
        <div class="record-card">
          <div class="class-card-top">
            <div class="class-preview-box" style="background:${cls.accentColor}">
              <canvas class="class-preview-canvas pixel-art" width="16" height="16" data-hero-preview="${cls.id}"></canvas>
            </div>
            <div class="class-name-wrap">
              <h2 class="class-name">${escapeHtml(cls.name)}</h2>
              <div class="class-title">${rec.runsPlayed} ${rec.runsPlayed === 1 ? 'Run' : 'Runs'} Played</div>
            </div>
          </div>
          <div class="record-stats-grid">
            <div class="stat-row"><span class="stat-label">Best Time</span><span class="stat-val">${formatTime(rec.bestTimeSec)}</span></div>
            <div class="stat-row"><span class="stat-label">Best Level</span><span class="stat-val">LV ${rec.bestLevel}</span></div>
            <div class="stat-row"><span class="stat-label">Most Kills</span><span class="stat-val">${rec.bestKills}</span></div>
            <div class="stat-row"><span class="stat-label">Bosses Slain</span><span class="stat-val">${rec.bestBosses}</span></div>
          </div>
        </div>
      `;
    }).join('');

    this.menuLayer.innerHTML = `
      <div class="modal-card">
        <div class="menu-header">
          <div class="subview-title-row">
            <button type="button" class="px-btn" data-menu-back>← BACK</button>
            <div class="menu-title-block">
              <h1 class="menu-title">BEST RECORDS</h1>
              <p class="menu-subtitle">Personal bests saved locally (${totalRuns} total ${totalRuns === 1 ? 'run' : 'runs'})</p>
            </div>
          </div>
        </div>

        <div class="records-grid">
          ${rowsHtml}
        </div>
      </div>
    `;

    this.bindMenuPreviews();
    this.bindBackToTitle();
  }

  private renderSettingsView(): void {
    const muted = this.game.audio.isMuted();
    const aimMode = this.game.input.getAimMode();

    const resetSection = this.confirmResetSave
      ? `
        <div class="settings-reset-confirm">
          <span>Erase all saved best runs and preferences?</span>
          <div class="settings-reset-actions">
            <button type="button" class="px-btn" data-settings-reset-cancel>CANCEL</button>
            <button type="button" class="px-btn px-btn-coral" data-settings-reset-confirm>YES, RESET ALL</button>
          </div>
        </div>
      `
      : `
        <button type="button" class="px-btn px-btn-coral" data-settings-reset>RESET SAVE DATA</button>
      `;

    this.menuLayer.innerHTML = `
      <div class="modal-card subview-compact-card">
        <div class="menu-header">
          <div class="subview-title-row">
            <button type="button" class="px-btn" data-menu-back>← BACK</button>
            <div class="menu-title-block">
              <h1 class="menu-title">SETTINGS</h1>
              <p class="menu-subtitle">Preferences are saved automatically</p>
            </div>
          </div>
        </div>

        <div class="settings-list">
          <div class="settings-row">
            <div class="settings-row-text">
              <div class="settings-row-title">Aiming Mode</div>
              <div class="settings-row-desc">Auto-aim targets the nearest enemy; Mouse aims toward your cursor.</div>
            </div>
            <button type="button" class="px-btn ${aimMode === 'mouse' ? 'px-btn-blue' : ''}" data-menu-aim>
              AIM: ${aimMode === 'mouse' ? 'MOUSE' : 'AUTO'}
            </button>
          </div>

          <div class="settings-row">
            <div class="settings-row-text">
              <div class="settings-row-title">Sound Effects</div>
              <div class="settings-row-desc">Procedural Web Audio pastel chiptune SFX for hits, XP, and level-ups.</div>
            </div>
            <button type="button" class="px-btn ${muted ? 'px-btn-coral' : 'px-btn-butter'}" data-menu-mute>
              ${muted ? 'SFX: OFF' : 'SFX: ON'}
            </button>
          </div>

          <div class="settings-row settings-row-danger">
            <div class="settings-row-text">
              <div class="settings-row-title">Reset Save Data</div>
              <div class="settings-row-desc">Clears all per-class personal best records and restores default settings.</div>
            </div>
            ${resetSection}
          </div>
        </div>
      </div>
    `;

    this.bindBackToTitle();

    this.menuLayer.querySelector<HTMLButtonElement>('[data-menu-aim]')?.addEventListener('click', () => {
      this.game.audio.unlock();
      const next = this.game.input.toggleAimMode();
      this.updateAimButtons(next);
    });

    this.menuLayer.querySelector<HTMLButtonElement>('[data-menu-mute]')?.addEventListener('click', () => {
      this.game.audio.toggleMute();
      this.updateMuteButtons(this.game.audio.isMuted());
    });

    this.menuLayer.querySelector('[data-settings-reset]')?.addEventListener('click', () => {
      this.game.audio.unlock();
      this.game.audio.playClick();
      this.confirmResetSave = true;
      this.renderMainMenu();
    });

    this.menuLayer.querySelector('[data-settings-reset-cancel]')?.addEventListener('click', () => {
      this.game.audio.playClick();
      this.confirmResetSave = false;
      this.renderMainMenu();
    });

    this.menuLayer.querySelector('[data-settings-reset-confirm]')?.addEventListener('click', () => {
      this.game.audio.playClick();
      resetSaveData();
      this.game.audio.setMuted(false);
      this.game.input.setAimMode('auto');
      this.updateMuteButtons(false);
      this.updateAimButtons('auto');
      this.confirmResetSave = false;
      this.renderMainMenu();
    });
  }

  private renderHowToPlayView(): void {
    this.menuLayer.innerHTML = `
      <div class="modal-card subview-compact-card">
        <div class="menu-header">
          <div class="subview-title-row">
            <button type="button" class="px-btn" data-menu-back>← BACK</button>
            <div class="menu-title-block">
              <h1 class="menu-title">HOW TO PLAY</h1>
              <p class="menu-subtitle">Survive the pastel swarm, evolve synergies, and claim Boss Artifacts</p>
            </div>
          </div>
        </div>

        <div class="howto-grid">
          <div class="howto-card">
            <h3>Controls</h3>
            <ul>
              <li><strong>Desktop:</strong> <code>WASD</code> or <code>Arrow Keys</code> to move, <code>M</code> to toggle Auto/Mouse aim, <code>ESC</code> / <code>P</code> to pause.</li>
              <li><strong>Mobile:</strong> Touch and drag anywhere on the arena to use the floating pastel joystick.</li>
              <li><strong>Modals:</strong> Press <code>1</code>, <code>2</code>, or <code>3</code> (or tap a card) to pick upgrades.</li>
            </ul>
          </div>

          <div class="howto-card">
            <h3>Abilities & Synergies</h3>
            <ul>
              <li>Carry up to <strong>${MAX_ACTIVE_ABILITY_SLOTS} active abilities</strong>. Every ability levels up to <strong>Lv ${MAX_ABILITY_LEVEL}</strong>.</li>
              <li>Reaching <strong>Lv 5</strong> and <strong>Lv 10</strong> unlocks permanent global passives that last the entire run.</li>
              <li>Maxing a matching pair (<strong>Lv 10 + Lv 10</strong>) unlocks an evolved <strong>Synergy</strong>, freeing 1 active slot while keeping all passives!</li>
            </ul>
          </div>

          <div class="howto-card">
            <h3>Bosses & Artifacts</h3>
            <ul>
              <li>Every <strong>10:00</strong> a Boss arrives (<em>King Mochi</em>, <em>Lady Wisteria</em>, <em>Aegis</em>) with telegraphed attacks.</li>
              <li>Defeating a Boss drops a <strong>Boss Chest</strong> that heals you and grants a powerful class-specific <strong>Boss Artifact</strong>.</li>
              <li>Watch for rare <strong>Pastel Hearts</strong> (healing) and <strong>Magnet Orbs</strong> (pull all XP gems).</li>
            </ul>
          </div>
        </div>

        <div class="howto-debug-footer">
          <button type="button" class="px-btn ${this.debugUnlocked ? 'px-btn-peach' : ''} howto-debug-btn" data-howto-debug-toggle>
            DEBUG MODE: ${this.debugUnlocked ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>
    `;

    this.bindBackToTitle();

    this.menuLayer.querySelector('[data-howto-debug-toggle]')?.addEventListener('click', () => {
      this.game.audio.unlock();
      this.game.audio.playClick();
      this.toggleDebugUnlocked();
    });
  }

  private drawMenuHeroPreviews(frame: 0 | 1): void {
    for (const { heroId, canvas } of this.menuPreviewCanvases) {
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const sprite = this.game.sprites.heroes[heroId][frame];
      ctx.drawImage(sprite, 0, frame === 1 ? -1 : 0, 16, 16);
    }
  }

  // ==========================================================================
  // 2. HUD CONSTRUCTION & LIVE SYNC
  // ==========================================================================

  private buildHudDom(): void {
    this.hudLayer.innerHTML = `
      <div class="hud-top-wrap">
        <div class="hud-xp-bar">
          <div class="hud-xp-fill" data-hud-xp-fill></div>
          <div class="hud-xp-overlay">
            <span class="hud-level-badge" data-hud-lv>LV 1</span>
            <span data-hud-xp-text>0 / 22 XP</span>
          </div>
        </div>

        <div class="hud-top-row">
          <div class="hud-left-col">
            <div class="hud-hero-bar">
              <canvas class="hud-hero-canvas pixel-art" width="16" height="16" data-hud-hero-canvas></canvas>
              <div class="hud-hp-wrap">
                <div class="hud-hp-text">
                  <span data-hud-hero-name>MAGE</span>
                  <span data-hud-hp-num>85/85</span>
                </div>
                <div class="hud-hp-track">
                  <div class="hud-hp-fill" data-hud-hp-fill></div>
                </div>
              </div>
            </div>
            <div class="hud-squad-list hidden" data-hud-squad></div>
          </div>

          <div class="hud-center-col">
            <div class="hud-timer-box">
              <span class="hud-timer" data-hud-timer>00:00</span>
              <span class="hud-kills" data-hud-kills>0 KILLS</span>
            </div>
            <div class="hud-meta-pills">
              <div class="hud-next-boss" data-hud-next-boss>BOSS IN 10:00</div>
              <div class="hud-coop-meta hidden" data-hud-coop-meta></div>
              <div class="hud-reconnect-badge hidden" data-hud-reconnect>RECONNECTING...</div>
            </div>
          </div>

          <div class="hud-right-col">
            <button type="button" class="px-btn hud-icon-btn" data-hud-aim title="Toggle Aim Mode (M)">AUTO</button>
            <button type="button" class="px-btn hud-icon-btn" data-hud-mute title="Toggle Sound">SFX</button>
            <button type="button" class="px-btn px-btn-lavender hud-icon-btn" data-hud-pause title="Pause / Build (ESC / P)">II</button>
          </div>
        </div>

        <div class="hud-boss-bar hidden" data-hud-boss-bar>
          <canvas class="hud-boss-portrait pixel-art" width="32" height="32" data-hud-boss-canvas></canvas>
          <div class="hud-boss-info">
            <div class="hud-boss-header">
              <div class="hud-boss-title-group">
                <span class="hud-boss-name" data-hud-boss-name>King Mochi</span>
                <span class="hud-boss-enraged hidden" data-hud-boss-enraged>ENRAGED</span>
              </div>
              <span class="hud-boss-attack" data-hud-boss-attack></span>
            </div>
            <div class="hud-boss-track">
              <div class="hud-boss-fill" data-hud-boss-fill></div>
              <div class="hud-boss-hp-text" data-hud-boss-hp-text>0 / 0</div>
            </div>
          </div>
        </div>
      </div>

      <div class="hud-bottom-dock">
        <div class="hud-slots-strip" data-hud-slots></div>
        <div class="hud-artifacts-strip hidden" data-hud-artifacts></div>
      </div>
    `;

    this.hudXpFill = this.hudLayer.querySelector('[data-hud-xp-fill]')!;
    this.hudLevelBadge = this.hudLayer.querySelector('[data-hud-lv]')!;
    this.hudXpText = this.hudLayer.querySelector('[data-hud-xp-text]')!;
    this.hudHeroCanvas = this.hudLayer.querySelector('[data-hud-hero-canvas]')!;
    this.hudHeroName = this.hudLayer.querySelector('[data-hud-hero-name]')!;
    this.hudHpNumbers = this.hudLayer.querySelector('[data-hud-hp-num]')!;
    this.hudHpFill = this.hudLayer.querySelector('[data-hud-hp-fill]')!;
    this.hudSquadList = this.hudLayer.querySelector('[data-hud-squad]')!;
    this.hudTimer = this.hudLayer.querySelector('[data-hud-timer]')!;
    this.hudKills = this.hudLayer.querySelector('[data-hud-kills]')!;
    this.hudNextBoss = this.hudLayer.querySelector('[data-hud-next-boss]')!;
    this.hudCoopMeta = this.hudLayer.querySelector('[data-hud-coop-meta]')!;
    this.hudReconnectBadge = this.hudLayer.querySelector('[data-hud-reconnect]')!;
    this.hudAimBtn = this.hudLayer.querySelector('[data-hud-aim]')!;
    this.hudMuteBtn = this.hudLayer.querySelector('[data-hud-mute]')!;
    this.hudPauseBtn = this.hudLayer.querySelector('[data-hud-pause]')!;
    this.hudBossBar = this.hudLayer.querySelector('[data-hud-boss-bar]')!;
    this.hudBossCanvas = this.hudLayer.querySelector('[data-hud-boss-canvas]')!;
    this.hudBossName = this.hudLayer.querySelector('[data-hud-boss-name]')!;
    this.hudBossEnraged = this.hudLayer.querySelector('[data-hud-boss-enraged]')!;
    this.hudBossAttack = this.hudLayer.querySelector('[data-hud-boss-attack]')!;
    this.hudBossFill = this.hudLayer.querySelector('[data-hud-boss-fill]')!;
    this.hudBossHpText = this.hudLayer.querySelector('[data-hud-boss-hp-text]')!;
    this.hudSlotsStrip = this.hudLayer.querySelector('[data-hud-slots]')!;
    this.hudArtifactsStrip = this.hudLayer.querySelector('[data-hud-artifacts]')!;

    this.hudAimBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.game.audio.unlock();
      const next = this.game.input.toggleAimMode();
      this.updateAimButtons(next);
    });

    this.hudMuteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.game.audio.toggleMute();
      this.updateMuteButtons(this.game.audio.isMuted());
    });

    this.hudPauseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.game.audio.unlock();
      this.game.togglePause();
    });

    this.updateAimButtons(this.game.input.getAimMode());
    this.updateMuteButtons(this.game.audio.isMuted());
  }

  private resetHudCaches(): void {
    this.lastSlotsKey = '';
    this.lastArtifactsKey = '';
    this.lastSquadKey = '';
    this.lastCoopMetaText = '';
    this.lastTimerText = '';
    this.lastKillsCount = -1;
    this.lastLevel = -1;
    this.lastXpRatio = -1;
    this.lastHpKey = '';
    this.lastNextBossText = '';
    this.lastBossVisible = false;
    this.lastBossKey = '';
    this.lastHudHeroFrame = -1;
    this.lastHudHeroId = null;
    this.lastBossSpriteKey = '';
  }

  private updateAimButtons(mode: AimMode): void {
    const isMouse = mode === 'mouse';
    this.hudAimBtn.textContent = isMouse ? 'MOUSE' : 'AUTO';
    this.hudAimBtn.classList.toggle('active-mouse', isMouse);

    const menuAim = this.menuLayer.querySelector<HTMLButtonElement>('[data-menu-aim]');
    if (menuAim) {
      menuAim.textContent = `AIM: ${isMouse ? 'MOUSE' : 'AUTO'}`;
      menuAim.classList.toggle('px-btn-blue', isMouse);
    }

    const pauseAim = this.pauseLayer.querySelector<HTMLButtonElement>('[data-pause-aim]');
    if (pauseAim) {
      pauseAim.textContent = `AIM: ${isMouse ? 'MOUSE' : 'AUTO'}`;
      pauseAim.classList.toggle('px-btn-blue', isMouse);
    }
  }

  private updateMuteButtons(muted: boolean): void {
    this.hudMuteBtn.textContent = muted ? 'MUTE' : 'SFX';
    this.hudMuteBtn.classList.toggle('muted', muted);

    const menuMute = this.menuLayer.querySelector<HTMLButtonElement>('[data-menu-mute]');
    if (menuMute) {
      menuMute.textContent = muted ? 'SFX: OFF' : 'SFX: ON';
      menuMute.classList.toggle('px-btn-coral', muted);
      menuMute.classList.toggle('px-btn-butter', !muted);
    }

    const pauseMute = this.pauseLayer.querySelector<HTMLButtonElement>('[data-pause-mute]');
    if (pauseMute) {
      pauseMute.textContent = muted ? 'SFX: OFF' : 'SFX: ON';
      pauseMute.classList.toggle('px-btn-coral', muted);
      pauseMute.classList.toggle('px-btn-butter', !muted);
    }
  }

  private formatTeammateEffectsLabel(mode: TeammateEffectsMode): string {
    return mode === 'full' ? 'FULL' : mode === 'dimmed' ? 'DIMMED' : 'OFF';
  }

  private updateTeammateEffectsButton(mode: TeammateEffectsMode): void {
    const btn = this.pauseLayer.querySelector<HTMLButtonElement>('[data-pause-teammate-fx]');
    if (!btn) return;
    btn.textContent = `TEAMMATE EFFECTS: ${this.formatTeammateEffectsLabel(mode)}`;
    btn.classList.toggle('px-btn-mint', mode === 'full');
    btn.classList.toggle('px-btn-lavender', mode === 'dimmed');
    btn.classList.toggle('px-btn-coral', mode === 'off');
  }

  private updateHud(force = false): void {
    const isCoop = this.game.isCoopMode();
    const heroId = this.game.getLocalHeroId();
    const level = this.game.getLocalLevel();
    const xpState = this.game.getLocalXp();
    const xpRatio = Math.max(0, Math.min(1, xpState.xp / Math.max(1, xpState.xpToNext)));
    const xpPctRounded = Math.round(xpRatio * 1000) / 10;

    if (force || level !== this.lastLevel || xpPctRounded !== this.lastXpRatio) {
      this.lastLevel = level;
      this.lastXpRatio = xpPctRounded;
      this.hudLevelBadge.textContent = `LV ${level}`;
      this.hudXpFill.style.width = `${xpPctRounded}%`;
      this.hudXpText.textContent = `${Math.floor(xpState.xp)} / ${xpState.xpToNext} XP`;
    }

    // Hero HP & mini portrait
    const hpState = this.game.getLocalHp();
    const hpKey = `${heroId}:${hpState.hp}/${hpState.maxHp}:${hpState.downed}:${hpState.revivePct}`;
    if (force || hpKey !== this.lastHpKey) {
      this.lastHpKey = hpKey;
      const ratio = hpState.downed ? 0 : Math.max(0, Math.min(1, hpState.hpPct / 100));
      this.hudHeroName.textContent = CLASSES[heroId].name.toUpperCase();
      this.hudHpNumbers.textContent = hpState.downed
        ? hpState.revivePct > 0
          ? `REV ${hpState.revivePct}%`
          : 'DOWNED'
        : `${hpState.hp}/${hpState.maxHp}`;
      this.hudHpFill.style.width = `${Math.round(ratio * 100)}%`;
      this.hudHpFill.classList.toggle('low', ratio <= 0.35);
    }

    const walk = this.game.getLocalWalkState();
    const walkFrame = walk.isMoving ? Math.floor(walk.walkTime * 7) % 2 : 0;
    if (force || walkFrame !== this.lastHudHeroFrame || heroId !== this.lastHudHeroId) {
      this.lastHudHeroFrame = walkFrame;
      this.lastHudHeroId = heroId;
      const hctx = this.hudHeroCanvas.getContext('2d');
      if (hctx) {
        hctx.imageSmoothingEnabled = false;
        hctx.clearRect(0, 0, 16, 16);
        hctx.drawImage(this.game.sprites.heroes[heroId][walkFrame], 0, 0, 16, 16);
      }
    }

    // Compact Co-op Squad HUD (teammates' class icons, levels, mini HP bars, downed/upgrading status)
    if (isCoop) {
      const teammates = this.game.getCoopPlayers().filter((p) => !p.isLocal);
      const squadKey = teammates
        .map(
          (t) =>
            `${t.id}:${t.classId}:${t.name}:${t.level}:${t.hpPct}:${t.stateFlags}:${t.revivePct}`
        )
        .join('|');
      if (force || squadKey !== this.lastSquadKey) {
        this.lastSquadKey = squadKey;
        this.hudSquadList.classList.toggle('hidden', teammates.length === 0);
        if (teammates.length > 0) {
          this.hudSquadList.innerHTML = teammates
            .map((t) => {
              const isDowned = (t.stateFlags & WirePlayerFlag.DOWNED) !== 0;
              const isUpgrading = (t.stateFlags & WirePlayerFlag.UPGRADING) !== 0;
              const isDc = (t.stateFlags & WirePlayerFlag.DISCONNECTED) !== 0;
              const cls = CLASSES[t.classId];
              const fillPct = isDowned ? t.revivePct : Math.max(0, Math.min(100, t.hpPct));
              const fillClass = isDowned ? 'reviving' : t.hpPct <= 35 ? 'low' : '';
              const statusPill = isDowned
                ? `<span class="squad-status downed">${t.revivePct > 0 ? `${t.revivePct}%` : 'GHOST'}</span>`
                : isUpgrading
                ? `<span class="squad-status upgrading" title="Choosing Upgrade">▲</span>`
                : isDc
                ? `<span class="squad-status dc">DC</span>`
                : '';

              return `
                <div class="hud-squad-row ${isDowned ? 'downed' : ''}">
                  <div class="squad-icon-box" style="background:${cls.accentColor}">
                    <img class="pixel-art" src="${this.heroIconUrls[t.classId]}" alt="${escapeHtml(cls.name)}" />
                  </div>
                  <div class="squad-info">
                    <div class="squad-top">
                      <span class="squad-name">${escapeHtml(t.name.slice(0, 10))}</span>
                      <span class="squad-lv">L${t.level}</span>
                      ${statusPill}
                    </div>
                    <div class="squad-hp-track">
                      <div class="squad-hp-fill ${fillClass}" style="width:${fillPct}%"></div>
                    </div>
                  </div>
                </div>
              `;
            })
            .join('');
        } else {
          this.hudSquadList.innerHTML = '';
        }
      }

      const roomCode = this.game.net.getRoomCode();
      const rtt = this.game.net.getRttMs();
      const metaText = roomCode ? (rtt > 0 ? `${roomCode} · ${rtt}ms` : roomCode) : '';
      if (force || metaText !== this.lastCoopMetaText) {
        this.lastCoopMetaText = metaText;
        this.hudCoopMeta.classList.toggle('hidden', !metaText);
        this.hudCoopMeta.textContent = metaText;
      }

      this.hudReconnectBadge.classList.toggle(
        'hidden',
        this.game.getCoopConnectionState() !== 'reconnecting'
      );
    } else {
      if (force || this.lastSquadKey !== 'SOLO') {
        this.lastSquadKey = 'SOLO';
        this.hudSquadList.classList.add('hidden');
        this.hudSquadList.innerHTML = '';
        this.hudCoopMeta.classList.add('hidden');
        this.hudReconnectBadge.classList.add('hidden');
      }
    }

    // Timer & kills
    const timerText = formatTime(this.game.getElapsedRunSec());
    if (force || timerText !== this.lastTimerText) {
      this.lastTimerText = timerText;
      this.hudTimer.textContent = timerText;
    }

    const kills = this.game.getKills();
    if (force || kills !== this.lastKillsCount) {
      this.lastKillsCount = kills;
      this.hudKills.textContent = `${kills} KILLS`;
    }

    // Boss HP Bar & Next Boss countdown
    const bossInfo = this.game.getActiveBossInfo();
    const bossVisible = bossInfo !== null;
    if (force || bossVisible !== this.lastBossVisible) {
      this.lastBossVisible = bossVisible;
      this.hudBossBar.classList.toggle('hidden', !bossVisible);
    }

    const nextBossText = bossInfo
      ? `BOSS ACTIVE`
      : `NEXT BOSS ${formatTime(this.game.getNextBossCountdownSec())}`;
    if (force || nextBossText !== this.lastNextBossText) {
      this.lastNextBossText = nextBossText;
      this.hudNextBoss.textContent = nextBossText;
    }

    if (bossInfo) {
      const hpInt = Math.max(0, Math.ceil(bossInfo.hp));
      const maxInt = Math.max(1, Math.round(bossInfo.maxHp));
      const bossKey = `${bossInfo.enemyId}:${hpInt}/${maxInt}:${bossInfo.enraged}:${bossInfo.currentAttackName ?? ''}`;
      if (force || bossKey !== this.lastBossKey) {
        this.lastBossKey = bossKey;
        const cycleLabel = bossInfo.cycle > 1 ? ` (Cycle ${bossInfo.cycle})` : '';
        this.hudBossName.textContent = `${bossInfo.name} — ${bossInfo.title}${cycleLabel}`;
        this.hudBossEnraged.classList.toggle('hidden', !bossInfo.enraged);
        this.hudBossAttack.textContent = bossInfo.currentAttackName ?? '';
        const pct = Math.max(0, Math.min(100, (bossInfo.hp / maxInt) * 100));
        this.hudBossFill.style.width = `${pct.toFixed(1)}%`;
        this.hudBossFill.style.backgroundColor = bossInfo.accentColor;
        this.hudBossHpText.textContent = isCoop
          ? `${Math.round(pct)}%`
          : `${hpInt} / ${maxInt}`;
      }

      const bossFrame = Math.floor(this.previewAnimSec * 3) % 2;
      const spriteKey = `${bossInfo.bossId}:${bossFrame}`;
      if (force || spriteKey !== this.lastBossSpriteKey) {
        this.lastBossSpriteKey = spriteKey;
        const bctx = this.hudBossCanvas.getContext('2d');
        if (bctx) {
          bctx.imageSmoothingEnabled = false;
          bctx.clearRect(0, 0, 32, 32);
          bctx.drawImage(this.game.sprites.bosses[bossInfo.bossId][bossFrame], 0, 0, 32, 32);
        }
      }
    }

    // 6-slot Ability Strip
    const slots = this.game.getActiveSlots();
    const slotsKey = slots.map((s) => `${s.kind}:${s.id}:${s.level}`).join('|');
    if (force || slotsKey !== this.lastSlotsKey) {
      this.lastSlotsKey = slotsKey;
      const htmlParts: string[] = [];
      for (let i = 0; i < MAX_ACTIVE_ABILITY_SLOTS; i++) {
        const slot = slots[i];
        if (!slot) {
          htmlParts.push(`<div class="hud-ability-slot empty" title="Empty Ability Slot"></div>`);
          continue;
        }
        if (slot.kind === 'synergy') {
          const syn = SYNERGIES[slot.id as keyof typeof SYNERGIES];
          const iconUrl = this.game.sprites.iconUrls[syn.iconId];
          htmlParts.push(`
            <div class="hud-ability-slot synergy" title="${escapeHtml(syn.name)} (Evolved Synergy)">
              <img class="pixel-art" src="${iconUrl}" alt="${escapeHtml(syn.name)}" />
              <span class="hud-slot-lv syn">★</span>
            </div>
          `);
        } else {
          const ab = ABILITIES[slot.id as keyof typeof ABILITIES];
          const iconUrl = this.game.sprites.iconUrls[ab.iconId];
          const isMax = slot.level >= MAX_ABILITY_LEVEL;
          htmlParts.push(`
            <div class="hud-ability-slot" title="${escapeHtml(ab.name)} (Lv ${slot.level}/${MAX_ABILITY_LEVEL})">
              <img class="pixel-art" src="${iconUrl}" alt="${escapeHtml(ab.name)}" />
              <span class="hud-slot-lv ${isMax ? 'max' : ''}">${isMax ? 'MAX' : `L${slot.level}`}</span>
            </div>
          `);
        }
      }
      this.hudSlotsStrip.innerHTML = htmlParts.join('');
    }

    // Owned Artifacts Strip
    const artifacts = this.game.getOwnedArtifacts();
    const artKey = artifacts.join('|');
    if (force || artKey !== this.lastArtifactsKey) {
      this.lastArtifactsKey = artKey;
      this.hudArtifactsStrip.classList.toggle('hidden', artifacts.length === 0);
      if (artifacts.length > 0) {
        this.hudArtifactsStrip.innerHTML = artifacts
          .map((artId) => {
            const def = getArtifactDef(artId);
            const iconUrl = this.game.sprites.iconUrls[def.iconId];
            return `
              <div class="hud-artifact-chip" style="background:${def.color}" title="${escapeHtml(def.name)}: ${escapeHtml(def.description)}">
                <img class="pixel-art" src="${iconUrl}" alt="${escapeHtml(def.name)}" />
              </div>
            `;
          })
          .join('');
      } else {
        this.hudArtifactsStrip.innerHTML = '';
      }
    }
  }

  // ==========================================================================
  // 2B. LIVE CO-OP SPEED-READABLE UPGRADE STRIP (NO CENTER MODAL!)
  // ==========================================================================

  private renderLiveUpgradeStrip(): void {
    const up = this.coopUpgradeState;
    if (!up || up.choices.length === 0 || !this.game.isCoopMode()) {
      this.liveUpgradeLayer.innerHTML = '';
      this.liveUpgradeLayer.classList.add('hidden');
      return;
    }

    const overflowBadgeHtml =
      up.pendingQueueCount > 0
        ? `<div class="live-upgrade-overflow" title="${up.pendingQueueCount} additional level-up(s) queued">+${up.pendingQueueCount}</div>`
        : '';

    const sourceTag = up.source === 'boss_chest' ? 'BOSS CHEST' : 'LEVEL UP';

    const cardsHtml = up.choices
      .slice(0, 3)
      .map((choice, idx) => {
        const iconUrl =
          this.game.sprites.iconUrls[choice.iconId] ?? this.game.sprites.iconUrls.ascended_relic;
        const tierClass =
          choice.tier === 'synergy' || choice.tier === 'artifact'
            ? 'tier-gold'
            : choice.tier === 'milestone'
            ? 'tier-milestone'
            : 'tier-standard';

        return `
          <button
            type="button"
            class="live-upgrade-card ${tierClass} ${up.pickInFlight ? 'picking' : ''}"
            data-live-pick="${idx}"
            ${up.pickInFlight ? 'disabled' : ''}
          >
            <span class="live-upgrade-hotkey">${idx + 1}</span>
            <span class="live-upgrade-icon" style="background:${choice.color}">
              <img class="pixel-art" src="${iconUrl}" alt="${escapeHtml(choice.shortTitle)}" />
            </span>
            <span class="live-upgrade-copy">
              <span class="live-upgrade-title">${escapeHtml(choice.shortTitle)}</span>
              <span class="live-upgrade-sep">·</span>
              <span class="live-upgrade-tag">${escapeHtml(choice.shortTag)}</span>
            </span>
          </button>
        `;
      })
      .join('');

    this.liveUpgradeLayer.innerHTML = `
      <div class="live-upgrade-dock" data-source="${up.source}">
        <div class="live-upgrade-meta">
          <span class="live-upgrade-source-pill ${up.source === 'boss_chest' ? 'chest' : ''}">${sourceTag}</span>
          ${overflowBadgeHtml}
        </div>
        <div class="live-upgrade-cards">
          ${cardsHtml}
        </div>
      </div>
    `;

    const buttons = this.liveUpgradeLayer.querySelectorAll<HTMLButtonElement>('[data-live-pick]');
    buttons.forEach((btn) => {
      btn.addEventListener('pointerdown', (e) => {
        // Prevent touch taps on upgrade strip from spawning the canvas virtual joystick
        e.stopPropagation();
      });
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = Number(btn.dataset.livePick) as UpgradeChoiceIndex;
        if (idx === 0 || idx === 1 || idx === 2) {
          this.game.pickCoopUpgrade(idx);
          this.renderLiveUpgradeStrip();
        }
      });
    });
  }

  // ==========================================================================
  // 3. LEVEL-UP & BOSS ARTIFACT MODALS
  // ==========================================================================

  private renderLevelUpModal(choices: readonly LevelUpChoice[]): void {
    const queued = this.game.getPendingLevelUps();
    const queuePill =
      queued > 0
        ? `<span class="px-pill" style="background:var(--butter)">+${queued} MORE QUEUED</span>`
        : '';

    const cardsHtml = choices
      .map((choice, idx) => {
        const isSynergy = choice.kind === 'synergy' && choice.synergyId;
        const isMilestone = choice.nextLevel === 5 || choice.nextLevel === 10;

        let iconUrl = '';
        let recipeHtml = '';
        let badgeText = choice.subtitle;
        let badgeBg = 'var(--cream-dark)';

        if (isSynergy && choice.synergyId) {
          const syn = SYNERGIES[choice.synergyId];
          iconUrl = this.game.sprites.iconUrls[syn.iconId];
          const [reqA, reqB] = syn.requires;
          const abA = ABILITIES[reqA];
          const abB = ABILITIES[reqB];
          badgeText = '★ SYNERGY EVOLUTION';
          badgeBg = 'var(--butter)';
          recipeHtml = `
            <div class="choice-synergy-recipe">
              <img class="pixel-art" src="${this.game.sprites.iconUrls[abA.iconId]}" alt="${escapeHtml(abA.name)}" />
              <span>+</span>
              <img class="pixel-art" src="${this.game.sprites.iconUrls[abB.iconId]}" alt="${escapeHtml(abB.name)}" />
              <span>=</span>
              <img class="pixel-art" src="${iconUrl}" alt="${escapeHtml(syn.name)}" />
            </div>
          `;
        } else if (choice.kind === 'ability' && choice.abilityId) {
          const ab = ABILITIES[choice.abilityId];
          iconUrl = this.game.sprites.iconUrls[ab.iconId];
          if (choice.isNew) {
            badgeText = 'NEW • LV 1';
            badgeBg = 'var(--mint)';
          } else if (choice.nextLevel === 10) {
            badgeText = 'MAX • LV 10';
            badgeBg = 'var(--butter)';
          } else if (choice.nextLevel === 5) {
            badgeText = 'MILESTONE • LV 5';
            badgeBg = 'var(--baby-blue)';
          } else {
            badgeText = choice.subtitle;
            badgeBg = 'var(--cream-dark)';
          }
        } else {
          // Endless Mastery fallback
          iconUrl = this.game.sprites.iconUrls.ascended_relic;
          badgeText = 'ENDLESS MASTERY';
          badgeBg = 'var(--peach)';
        }

        const passiveHtml = choice.passivePreview
          ? `<div class="choice-passive-box ${isSynergy ? 'synergy-bonus' : isMilestone ? 'milestone' : ''}">
              ${isMilestone ? '★ ' : ''}${escapeHtml(choice.passivePreview)}
            </div>`
          : '';

        return `
          <button
            type="button"
            class="choice-card ${isSynergy ? 'synergy-card' : ''}"
            data-levelup-idx="${idx}"
          >
            <div class="choice-top-row">
              <span class="px-pill" style="background:${badgeBg}">${escapeHtml(badgeText)}</span>
              <span class="choice-key-hint">[${idx + 1}]</span>
            </div>

            <div class="choice-icon-row">
              <div class="choice-icon-frame" style="background:${choice.color}">
                <img class="pixel-art" src="${iconUrl}" alt="${escapeHtml(choice.title)}" />
              </div>
              <div class="choice-title-wrap">
                <h3 class="choice-title">${escapeHtml(choice.title)}</h3>
                <div class="choice-subtitle">${escapeHtml(choice.subtitle)}</div>
              </div>
            </div>

            ${recipeHtml}

            <p class="choice-desc">${escapeHtml(choice.description)}</p>

            ${passiveHtml}
          </button>
        `;
      })
      .join('');

    const colsClass = choices.length === 1 ? 'cols-1' : choices.length === 2 ? 'cols-2' : '';

    this.levelUpLayer.innerHTML = `
      <div class="modal-card">
        <div class="modal-header-center">
          <h2 class="modal-banner">LEVEL UP! — LV ${this.game.player.level}</h2>
          <p class="modal-sub">Choose 1 upgrade (${this.game.getActiveSlots().length}/${MAX_ACTIVE_ABILITY_SLOTS} active slots used)</p>
          ${queuePill}
        </div>

        <div class="choices-grid ${colsClass}">
          ${cardsHtml}
        </div>
      </div>
    `;

    const buttons = this.levelUpLayer.querySelectorAll<HTMLButtonElement>('[data-levelup-idx]');
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.levelupIdx);
        const choice = choices[idx];
        if (!choice) return;
        this.game.audio.unlock();
        this.game.audio.playClick();
        this.game.applyLevelUpChoice(choice);
      });
    });
  }

  private renderArtifactModal(choices: readonly ArtifactDef[]): void {
    const chestDataUrl = this.game.sprites.pickups.chest.toDataURL();

    const cardsHtml = choices
      .map((art, idx) => {
        const iconUrl = this.game.sprites.iconUrls[art.iconId];
        return `
          <button type="button" class="choice-card artifact-card" data-artifact-idx="${idx}">
            <div class="choice-top-row">
              <span class="px-pill" style="background:var(--butter)">
                ${art.isFallback ? 'ASCENDED RELIC' : 'CLASS ARTIFACT'}
              </span>
              <span class="choice-key-hint">[${idx + 1}]</span>
            </div>

            <div class="choice-icon-row">
              <div class="choice-icon-frame" style="background:${art.color}">
                <img class="pixel-art" src="${iconUrl}" alt="${escapeHtml(art.name)}" />
              </div>
              <div class="choice-title-wrap">
                <h3 class="choice-title">${escapeHtml(art.name)}</h3>
                <div class="choice-subtitle">Boss Chest Reward</div>
              </div>
            </div>

            <p class="choice-desc">${escapeHtml(art.description)}</p>

            <div class="choice-passive-box milestone">
              ★ ${escapeHtml(art.passive.label)}
            </div>
          </button>
        `;
      })
      .join('');

    const colsClass = choices.length === 1 ? 'cols-1' : choices.length === 2 ? 'cols-2' : '';

    this.artifactLayer.innerHTML = `
      <div class="modal-card">
        <div class="modal-header-center">
          <img class="pixel-art" src="${chestDataUrl}" width="44" height="44" alt="Boss Chest" />
          <h2 class="modal-banner">BOSS CHEST OPENED!</h2>
          <p class="modal-sub">Select a permanent Artifact for this run</p>
        </div>

        <div class="choices-grid ${colsClass}">
          ${cardsHtml}
        </div>
      </div>
    `;

    const buttons = this.artifactLayer.querySelectorAll<HTMLButtonElement>('[data-artifact-idx]');
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.artifactIdx);
        const art = choices[idx];
        if (!art) return;
        this.game.audio.unlock();
        this.game.audio.playClick();
        this.game.grantArtifact(art.id);
      });
    });
  }

  // ==========================================================================
  // 4. PAUSE MENU + SYNERGY REFERENCE PANEL + DEBUG TOOLS
  // ==========================================================================

  private renderPauseModal(): void {
    const isCoop = this.game.isCoopMode();
    const heroId = this.game.getLocalHeroId();
    const level = this.game.getLocalLevel();
    const hpState = this.game.getLocalHp();
    const classDef = CLASSES[heroId];
    const stats = this.game.getComputedStats();
    const passives = this.game.getGlobalPassives();
    const synergies = getSynergiesForClass(heroId);
    const ownedSynergies = this.game.getOwnedSynergies();
    const muted = this.game.audio.isMuted();
    const aimMode = this.game.input.getAimMode();
    const teammateFx = this.game.getTeammateEffectsMode();

    const cdrPct = Math.round((1 - stats.cooldownMult) * 100);
    const statRows: Array<[string, string]> = [
      ['Max HP', `${hpState.hp} / ${Math.round(stats.maxHp)}`],
      ['HP Regen', `${stats.hpRegen.toFixed(1)}/s`],
      ['Move Speed', `${Math.round(stats.moveSpeed)}`],
      ['Armor', formatPercent(stats.armor)],
      ['Damage', formatPercent(stats.damageMult)],
      ['Cooldown', `-${cdrPct}%`],
      ['Area', formatPercent(stats.areaMult)],
      ['Crit', `${Math.round(stats.critChance * 100)}% (${stats.critMultiplier.toFixed(1)}x)`],
      ['Pickup', `${Math.round(stats.pickupRadius)}px`],
      ['XP Gain', formatPercent(stats.xpGainMult)],
      ['+Proj / Pierce', `+${stats.projectileBonus} / +${stats.pierceBonus}`],
      [
        'Special',
        [
          stats.hasDoubleCast ? '2x Cast' : '',
          stats.hasRetributionAegis ? 'Aegis' : '',
        ]
          .filter(Boolean)
          .join(', ') || 'None',
      ],
    ];

    const statsHtml = statRows
      .map(
        ([label, val]) =>
          `<div class="stat-row"><span>${escapeHtml(label)}</span><span>${escapeHtml(val)}</span></div>`
      )
      .join('');

    const passivesHtml =
      passives.length > 0
        ? passives
            .map((p) => {
              const tagMap: Record<typeof p.sourceType, { text: string; cls: string }> = {
                ability_lv5: { text: 'LV 5', cls: 'lv5' },
                ability_lv10: { text: 'LV 10', cls: 'lv10' },
                synergy: { text: 'SYN', cls: 'synergy' },
                artifact: { text: 'ART', cls: 'artifact' },
                mastery: { text: 'MST', cls: 'mastery' },
              };
              const tag = tagMap[p.sourceType];
              return `
                <div class="passive-item">
                  <span><strong>${escapeHtml(p.sourceName)}:</strong> ${escapeHtml(p.label)}</span>
                  <span class="passive-tag ${tag.cls}">${tag.text}</span>
                </div>
              `;
            })
            .join('')
        : `<div class="class-best-empty">Reach Ability Lv 5 / Lv 10 or collect Boss Artifacts to accumulate permanent global passives.</div>`;

    const synergyRowsHtml = synergies
      .map((syn) => {
        const [reqA, reqB] = syn.requires;
        const abA = ABILITIES[reqA];
        const abB = ABILITIES[reqB];
        const lvA = this.game.getAbilityLevel(reqA);
        const lvB = this.game.getAbilityLevel(reqB);
        const isUnlocked = ownedSynergies.has(syn.id);
        const isReady = !isUnlocked && lvA >= MAX_ABILITY_LEVEL && lvB >= MAX_ABILITY_LEVEL;
        const inProgress = !isUnlocked && !isReady && (lvA > 0 || lvB > 0);

        const rowClass = isUnlocked ? 'unlocked' : isReady ? 'ready' : '';
        const statusText = isUnlocked
          ? 'EVOLVED ★'
          : isReady
          ? 'READY ON LV UP!'
          : inProgress
          ? 'IN PROGRESS'
          : 'LOCKED';
        const statusClass = isUnlocked
          ? 'unlocked'
          : isReady
          ? 'ready'
          : inProgress
          ? 'progress'
          : '';

        const partAClass = lvA >= MAX_ABILITY_LEVEL ? 'maxed' : lvA > 0 ? 'owned' : '';
        const partBClass = lvB >= MAX_ABILITY_LEVEL ? 'maxed' : lvB > 0 ? 'owned' : '';

        return `
          <div class="synergy-ref-row ${rowClass}">
            <div class="synergy-formula">
              <span class="syn-part ${partAClass}">
                <img class="pixel-art" src="${this.game.sprites.iconUrls[abA.iconId]}" alt="${escapeHtml(abA.name)}" />
                <span>${escapeHtml(abA.name)} (${lvA}/${MAX_ABILITY_LEVEL})</span>
              </span>
              <span class="syn-op">+</span>
              <span class="syn-part ${partBClass}">
                <img class="pixel-art" src="${this.game.sprites.iconUrls[abB.iconId]}" alt="${escapeHtml(abB.name)}" />
                <span>${escapeHtml(abB.name)} (${lvB}/${MAX_ABILITY_LEVEL})</span>
              </span>
              <span class="syn-op">=</span>
              <span class="syn-part result">
                <img class="pixel-art" src="${this.game.sprites.iconUrls[syn.iconId]}" alt="${escapeHtml(syn.name)}" />
                <span>${escapeHtml(syn.name)}</span>
              </span>
            </div>
            <div class="syn-meta-row">
              <span>${escapeHtml(syn.evolvedSpec.summary)} • ${escapeHtml(syn.bonusPassive.label)}</span>
              <span class="syn-status-badge ${statusClass}">${statusText}</span>
            </div>
          </div>
        `;
      })
      .join('');

    const statsHiddenMobile = this.pauseTab !== 'stats' ? 'pause-panel-hidden-mobile' : '';
    const synHiddenMobile = this.pauseTab !== 'synergies' ? 'pause-panel-hidden-mobile' : '';

    this.pauseLayer.classList.toggle('coop-live-pause', isCoop);

    this.pauseLayer.innerHTML = `
      <div class="modal-card ${isCoop ? 'coop-live-pause-card' : ''}">
        <div class="pause-header">
          <div class="pause-title-group">
            <h2 class="modal-banner">${isCoop ? 'BUILD & RECIPES' : 'PAUSED'}</h2>
            ${
              isCoop
                ? `<span class="live-match-badge" title="Co-op matches never pause while viewing recipes">● LIVE MATCH</span>`
                : ''
            }
            <span class="px-pill" style="background:${classDef.accentColor}">
              ${escapeHtml(classDef.name.toUpperCase())} • LV ${level} • ${formatTime(this.game.getElapsedRunSec())}
            </span>
          </div>
          <div class="pause-actions">
            <button type="button" class="px-btn px-btn-primary" data-pause-resume>${isCoop ? 'CLOSE' : 'RESUME'}</button>
            ${
              isCoop
                ? `<button type="button" class="px-btn px-btn-coral" data-pause-menu>LEAVE MATCH</button>`
                : `
                  <button type="button" class="px-btn px-btn-peach" data-pause-restart>RESTART</button>
                  <button type="button" class="px-btn" data-pause-menu>MAIN MENU</button>
                `
            }
            <button type="button" class="px-btn ${aimMode === 'mouse' ? 'px-btn-blue' : ''}" data-pause-aim>
              AIM: ${aimMode === 'mouse' ? 'MOUSE' : 'AUTO'}
            </button>
            <button type="button" class="px-btn ${
              teammateFx === 'full'
                ? 'px-btn-mint'
                : teammateFx === 'dimmed'
                ? 'px-btn-lavender'
                : 'px-btn-coral'
            }" data-pause-teammate-fx title="Toggle Co-op Teammate Projectile & Ability Opacity (Full / Dimmed / Off)">
              TEAMMATE EFFECTS: ${this.formatTeammateEffectsLabel(teammateFx)}
            </button>
            <button type="button" class="px-btn ${muted ? 'px-btn-coral' : 'px-btn-butter'}" data-pause-mute>
              ${muted ? 'SFX: OFF' : 'SFX: ON'}
            </button>
          </div>
        </div>

        ${
          isCoop
            ? `<div class="live-match-warning">Co-op stays LIVE while this menu is open — watch out for bosses & waves! Press ESC / P to close quickly.</div>`
            : ''
        }

        <div class="pause-tabs">
          <button type="button" class="px-btn pause-tab-btn ${this.pauseTab === 'stats' ? 'active' : ''}" data-pause-tab="stats">
            STATS & PASSIVES
          </button>
          <button type="button" class="px-btn pause-tab-btn ${this.pauseTab === 'synergies' ? 'active' : ''}" data-pause-tab="synergies">
            SYNERGIES (${ownedSynergies.size}/${synergies.length})
          </button>
        </div>

        <div class="pause-grid">
          <div class="pause-section ${statsHiddenMobile}" data-pause-panel="stats">
            <h3 class="pause-section-title">
              <span>Live Computed Stats</span>
              <span class="px-pill">${this.game.getActiveSlots().length}/${MAX_ACTIVE_ABILITY_SLOTS} SLOTS</span>
            </h3>
            <div class="stats-table">
              ${statsHtml}
            </div>

            <h3 class="pause-section-title" style="margin-top:4px">
              <span>Global Passives</span>
              <span class="px-pill">${passives.length} ACTIVE</span>
            </h3>
            <div class="passives-list">
              ${passivesHtml}
            </div>
          </div>

          <div class="pause-section ${synHiddenMobile}" data-pause-panel="synergies">
            <h3 class="pause-section-title">
              <span>${escapeHtml(classDef.name)} Synergy Reference (Lv 10 + Lv 10)</span>
              <span class="px-pill">${ownedSynergies.size}/${synergies.length}</span>
            </h3>
            <div class="synergy-ref-list">
              ${synergyRowsHtml}
            </div>
          </div>
        </div>

        ${
          this.debugUnlocked && !isCoop
            ? `
        <div class="debug-bar">
          <h3 class="pause-section-title">
            <span>Debug Tools</span>
            <span style="font-size:10px;color:var(--text-muted)">Instant Boss & Progression Testing</span>
          </h3>
          <div class="debug-buttons">
            <button type="button" class="px-btn px-btn-peach" data-debug-boss="king_mochi">Spawn King Mochi</button>
            <button type="button" class="px-btn px-btn-mint" data-debug-boss="twin_macaron_mint">Spawn Twin Macarons</button>
            <button type="button" class="px-btn px-btn-lavender" data-debug-boss="lady_wisteria">Spawn Lady Wisteria</button>
            <button type="button" class="px-btn px-btn-peach" data-debug-boss="countess_tiramisu">Spawn Countess Tiramisu</button>
            <button type="button" class="px-btn px-btn-blue" data-debug-boss="aegis">Spawn Aegis</button>
            <button type="button" class="px-btn px-btn-butter" data-debug-levels="5">+5 Levels</button>
          </div>
        </div>
        `
            : ''
        }

        ${
          this.pauseConfirmAction
            ? `
        <div class="pause-confirm-overlay" data-pause-confirm-overlay>
          <div class="pause-confirm-card">
            <h3 class="pause-confirm-title">
              ${
                this.pauseConfirmAction === 'restart'
                  ? 'RESTART RUN?'
                  : isCoop
                  ? 'LEAVE CO-OP MATCH?'
                  : 'EXIT TO MAIN MENU?'
              }
            </h3>
            <p class="pause-confirm-text">
              ${
                isCoop
                  ? 'Disconnect from your squad and return to the Main Menu?'
                  : 'Abandon current run? Current progress will be lost.'
              }
            </p>
            <div class="pause-confirm-actions">
              <button type="button" class="px-btn" data-pause-confirm-cancel>CANCEL</button>
              <button type="button" class="px-btn px-btn-coral" data-pause-confirm-yes>
                ${
                  this.pauseConfirmAction === 'restart'
                    ? 'CONFIRM RESTART'
                    : isCoop
                    ? 'LEAVE MATCH'
                    : 'EXIT TO MENU'
                }
              </button>
            </div>
          </div>
        </div>
        `
            : ''
        }
      </div>
    `;

    // Bind Pause Actions
    this.pauseLayer.querySelector('[data-pause-resume]')?.addEventListener('click', () => {
      this.game.audio.unlock();
      this.game.audio.playClick();
      this.pauseConfirmAction = null;
      this.game.resume();
    });

    this.pauseLayer.querySelector('[data-pause-restart]')?.addEventListener('click', () => {
      this.game.audio.unlock();
      this.game.audio.playClick();
      this.pauseConfirmAction = 'restart';
      this.renderPauseModal();
    });

    this.pauseLayer.querySelector('[data-pause-menu]')?.addEventListener('click', () => {
      this.game.audio.unlock();
      this.game.audio.playClick();
      this.pauseConfirmAction = 'menu';
      this.renderPauseModal();
    });

    this.pauseLayer.querySelector('[data-pause-confirm-cancel]')?.addEventListener('click', () => {
      this.game.audio.playClick();
      this.pauseConfirmAction = null;
      this.renderPauseModal();
    });

    this.pauseLayer.querySelector('[data-pause-confirm-yes]')?.addEventListener('click', () => {
      const action = this.pauseConfirmAction;
      this.pauseConfirmAction = null;
      this.game.audio.unlock();
      this.game.audio.playClick();
      if (action === 'restart' && !isCoop) {
        this.resetHudCaches();
        this.game.startRun(this.game.player.heroId);
      } else if (action === 'menu') {
        if (isCoop) {
          this.coopRoomState = null;
          this.game.leaveCoopRoom();
        } else {
          this.game.setState('menu');
        }
      }
    });

    this.pauseLayer.querySelector('[data-pause-aim]')?.addEventListener('click', () => {
      this.game.audio.unlock();
      const next = this.game.input.toggleAimMode();
      this.updateAimButtons(next);
    });

    this.pauseLayer.querySelector('[data-pause-teammate-fx]')?.addEventListener('click', () => {
      this.game.audio.unlock();
      this.game.audio.playClick();
      const next = this.game.cycleTeammateEffectsMode();
      this.updateTeammateEffectsButton(next);
    });

    this.pauseLayer.querySelector('[data-pause-mute]')?.addEventListener('click', () => {
      this.game.audio.toggleMute();
      this.updateMuteButtons(this.game.audio.isMuted());
    });

    // Bind Mobile Pause Tabs
    const tabBtns = this.pauseLayer.querySelectorAll<HTMLButtonElement>('[data-pause-tab]');
    tabBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        this.pauseTab = btn.dataset.pauseTab as PauseMobileTab;
        this.game.audio.playClick();
        this.renderPauseModal();
      });
    });

    // Bind Debug Tools (Solo Offline only)
    const bossBtns = this.pauseLayer.querySelectorAll<HTMLButtonElement>('[data-debug-boss]');
    bossBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const bossId = btn.dataset.debugBoss as BossId;
        this.game.audio.unlock();
        this.game.audio.playClick();
        this.game.spawnBoss(bossId);
        this.game.resume();
      });
    });

    this.pauseLayer.querySelector('[data-debug-levels]')?.addEventListener('click', () => {
      this.game.audio.unlock();
      this.game.grantLevels(5);
      this.game.resume();
    });
  }

  // ==========================================================================
  // 5. GAME OVER & CO-OP MATCH SUMMARY MODALS
  // ==========================================================================

  private renderGameOverModal(summary: RunStatsSnapshot): void {
    const heroId = this.game.player.heroId;
    const classDef = CLASSES[heroId];
    const heroDataUrl = this.heroIconUrls[heroId];
    const nb = summary.newBests;

    const slotsHtml = this.game
      .getActiveSlots()
      .map((slot) => {
        if (slot.kind === 'synergy') {
          const syn = SYNERGIES[slot.id as keyof typeof SYNERGIES];
          return `
            <div class="hud-ability-slot synergy" title="${escapeHtml(syn.name)}">
              <img class="pixel-art" src="${this.game.sprites.iconUrls[syn.iconId]}" alt="${escapeHtml(syn.name)}" />
              <span class="hud-slot-lv syn">★</span>
            </div>
          `;
        }
        const ab = ABILITIES[slot.id as keyof typeof ABILITIES];
        return `
          <div class="hud-ability-slot" title="${escapeHtml(ab.name)} Lv ${slot.level}">
            <img class="pixel-art" src="${this.game.sprites.iconUrls[ab.iconId]}" alt="${escapeHtml(ab.name)}" />
            <span class="hud-slot-lv ${slot.level >= MAX_ABILITY_LEVEL ? 'max' : ''}">
              ${slot.level >= MAX_ABILITY_LEVEL ? 'MAX' : `L${slot.level}`}
            </span>
          </div>
        `;
      })
      .join('');

    const artifactsHtml = this.game
      .getOwnedArtifacts()
      .map((artId) => {
        const art = getArtifactDef(artId);
        return `
          <div class="hud-artifact-chip" style="background:${art.color}" title="${escapeHtml(art.name)}">
            <img class="pixel-art" src="${this.game.sprites.iconUrls[art.iconId]}" alt="${escapeHtml(art.name)}" />
          </div>
        `;
      })
      .join('');

    this.gameOverLayer.innerHTML = `
      <div class="modal-card modal-card-narrow">
        <div class="modal-header-center">
          <div class="gameover-hero-row">
            <div class="class-preview-box" style="background:${classDef.accentColor};width:56px;height:56px">
              <img class="pixel-art" src="${heroDataUrl}" width="42" height="42" alt="${escapeHtml(classDef.name)}" />
            </div>
            <div style="text-align:left">
              <h2 class="modal-banner">RUN COMPLETE</h2>
              <p class="modal-sub">${escapeHtml(classDef.name)} — ${escapeHtml(classDef.title)}</p>
            </div>
          </div>
          ${nb?.any ? `<span class="new-best-badge">★ NEW PERSONAL RECORD! ★</span>` : ''}
        </div>

        <div class="gameover-stats-grid">
          <div class="gameover-stat-tile">
            <span class="gameover-stat-label">Time Survived</span>
            <span class="gameover-stat-value">${formatTime(summary.elapsedRunSec)}</span>
            ${nb?.time ? `<span class="new-best-badge">NEW BEST!</span>` : ''}
          </div>
          <div class="gameover-stat-tile">
            <span class="gameover-stat-label">Level Reached</span>
            <span class="gameover-stat-value">LV ${summary.level}</span>
            ${nb?.level ? `<span class="new-best-badge">NEW BEST!</span>` : ''}
          </div>
          <div class="gameover-stat-tile">
            <span class="gameover-stat-label">Enemies Defeated</span>
            <span class="gameover-stat-value">${summary.kills}</span>
            ${nb?.kills ? `<span class="new-best-badge">NEW BEST!</span>` : ''}
          </div>
          <div class="gameover-stat-tile">
            <span class="gameover-stat-label">Bosses Slain</span>
            <span class="gameover-stat-value">${summary.bossesDefeated}</span>
            ${nb?.bosses ? `<span class="new-best-badge">NEW BEST!</span>` : ''}
          </div>
        </div>

        <div class="gameover-loadout">
          ${slotsHtml}
          ${artifactsHtml}
        </div>

        <div class="gameover-actions">
          <button type="button" class="px-btn px-btn-primary" data-gameover-retry>PLAY AGAIN</button>
          <button type="button" class="px-btn px-btn-lavender" data-gameover-menu>MAIN MENU</button>
        </div>
      </div>
    `;

    this.gameOverLayer.querySelector('[data-gameover-retry]')?.addEventListener('click', () => {
      this.game.audio.unlock();
      this.game.audio.playClick();
      this.resetHudCaches();
      this.game.startRun(this.game.player.heroId);
    });

    this.gameOverLayer.querySelector('[data-gameover-menu]')?.addEventListener('click', () => {
      this.game.audio.unlock();
      this.game.audio.playClick();
      this.game.setState('menu');
    });
  }

  private renderCoopMatchEndModal(summary: CoopMatchEndSummary): void {
    const mySlotId = this.game.net.getSlotId();

    const rosterHtml = summary.players
      .map((pl) => {
        const cls = CLASSES[pl.heroId];
        const isMe = pl.slotId === mySlotId;
        return `
          <div class="coop-summary-player ${isMe ? 'is-me' : ''}">
            <div class="squad-icon-box" style="background:${cls.accentColor}">
              <img class="pixel-art" src="${this.heroIconUrls[pl.heroId]}" alt="${escapeHtml(cls.name)}" />
            </div>
            <div class="coop-summary-player-meta">
              <div class="coop-summary-player-name">
                ${escapeHtml(pl.name)} ${isMe ? '<span class="px-pill lobby-you-pill">YOU</span>' : ''}
              </div>
              <div class="coop-summary-player-sub">${escapeHtml(cls.name)} • LV ${pl.level}</div>
            </div>
          </div>
        `;
      })
      .join('');

    const slotsHtml = this.game
      .getActiveSlots()
      .map((slot) => {
        if (slot.kind === 'synergy') {
          const syn = SYNERGIES[slot.id as keyof typeof SYNERGIES];
          return `
            <div class="hud-ability-slot synergy" title="${escapeHtml(syn.name)}">
              <img class="pixel-art" src="${this.game.sprites.iconUrls[syn.iconId]}" alt="${escapeHtml(syn.name)}" />
              <span class="hud-slot-lv syn">★</span>
            </div>
          `;
        }
        const ab = ABILITIES[slot.id as keyof typeof ABILITIES];
        return `
          <div class="hud-ability-slot" title="${escapeHtml(ab.name)} Lv ${slot.level}">
            <img class="pixel-art" src="${this.game.sprites.iconUrls[ab.iconId]}" alt="${escapeHtml(ab.name)}" />
            <span class="hud-slot-lv ${slot.level >= MAX_ABILITY_LEVEL ? 'max' : ''}">
              ${slot.level >= MAX_ABILITY_LEVEL ? 'MAX' : `L${slot.level}`}
            </span>
          </div>
        `;
      })
      .join('');

    this.gameOverLayer.innerHTML = `
      <div class="modal-card modal-card-narrow">
        <div class="modal-header-center">
          <span class="px-pill" style="background:${summary.victory ? 'var(--mint)' : 'var(--coral)'}">
            ONLINE CO-OP MATCH
          </span>
          <h2 class="modal-banner">${summary.victory ? 'SQUAD VICTORY!' : 'SQUAD DEFEATED'}</h2>
          <p class="modal-sub">
            ${formatTime(summary.elapsedRunSec)} • ${summary.kills} Kills • ${summary.bossesDefeated} Bosses Slain
          </p>
        </div>

        <div class="coop-summary-roster">
          ${rosterHtml}
        </div>

        <div class="gameover-loadout">
          ${slotsHtml}
        </div>

        <div class="gameover-actions">
          <button type="button" class="px-btn px-btn-primary" data-coop-end-menu>MAIN MENU</button>
        </div>
      </div>
    `;

    this.gameOverLayer.querySelector('[data-coop-end-menu]')?.addEventListener('click', () => {
      this.game.audio.unlock();
      this.game.audio.playClick();
      this.coopRoomState = null;
      this.game.leaveCoopRoom();
    });
  }

  // ==========================================================================
  // UI ANIMATION & HUD SYNC LOOP
  // ==========================================================================

  private readonly uiLoop = (now: number): void => {
    const dt = Math.min(Math.max((now - this.lastAnimTime) / 1000, 0), 0.1);
    this.lastAnimTime = now;
    this.previewAnimSec += dt;

    const state = this.game.getState();
    if (state === 'menu') {
      const frame: 0 | 1 = Math.floor(this.previewAnimSec * 3.5) % 2 === 0 ? 0 : 1;
      this.drawMenuHeroPreviews(frame);
    } else {
      this.updateHud(false);
    }

    this.rafId = requestAnimationFrame(this.uiLoop);
  };
}
