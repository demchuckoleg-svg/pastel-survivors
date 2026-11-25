import { ABILITIES, getAbilitiesForClass, getAbilityDef } from '../data/abilities';
import { getArtifactDef } from '../data/artifacts';
import {
  CLASS_LIST,
  CLASSES,
  MAX_ABILITY_LEVEL,
  MAX_ACTIVE_ABILITY_SLOTS,
} from '../data/classes';
import { xpNeeded } from '../data/enemies';
import { getSynergiesForClass, SYNERGIES } from '../data/synergies';
import type { AbilityId, ArtifactDef, BossId, HeroId } from '../data/types';
import type {
  GameEngine,
  GameState,
  LevelUpChoice,
  RunStatsSnapshot,
} from '../engine/game';
import { getAllBestRuns, getBestRun, resetSaveData, type AimMode } from '../engine/storage';

/**
 * Responsive 16x16 pastel pixel-art UI Manager:
 *  - Main Menu (Title -> Class Select, Records, Settings, How to Play)
 *  - In-game HUD (XP bar, timer, kills, tap-friendly buttons, Boss HP, Hero HP, 6-slot strip + Artifacts)
 *  - Level-Up & Boss Artifact Modals
 *  - Pause Menu (Live stats, Global Passives, Synergy Reference Panel, Exit Confirmation, Hidden Debug Tools)
 *  - Game Over Modal (Run summary & personal-best highlights)
 */

type PauseMobileTab = 'stats' | 'synergies';
type MenuView = 'title' | 'class_select' | 'records' | 'settings' | 'howto';
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
  private readonly menuLayer: HTMLDivElement;
  private readonly levelUpLayer: HTMLDivElement;
  private readonly artifactLayer: HTMLDivElement;
  private readonly pauseLayer: HTMLDivElement;
  private readonly gameOverLayer: HTMLDivElement;

  // Cached HUD element references for zero-thrash updates
  private hudXpFill!: HTMLDivElement;
  private hudLevelBadge!: HTMLSpanElement;
  private hudXpText!: HTMLSpanElement;
  private hudHeroCanvas!: HTMLCanvasElement;
  private hudHeroName!: HTMLSpanElement;
  private hudHpNumbers!: HTMLSpanElement;
  private hudHpFill!: HTMLDivElement;
  private hudTimer!: HTMLSpanElement;
  private hudKills!: HTMLSpanElement;
  private hudNextBoss!: HTMLDivElement;
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

  // Menu, Pause & Debug UI state
  private menuView: MenuView = 'title';
  private selectedHeroDetail: HeroId | null = null;
  private selectedAbilityDetail: AbilityId | null = null;
  private confirmResetSave = false;
  private pauseTab: PauseMobileTab = 'stats';
  private pauseConfirmAction: PauseConfirmAction = null;
  private debugUnlocked = false;

  // UI animation loop
  private rafId: number | null = null;
  private lastAnimTime = 0;
  private previewAnimSec = 0;

  constructor(root: HTMLElement, game: GameEngine) {
    this.root = root;
    this.game = game;

    this.root.innerHTML = '';

    this.hudLayer = document.createElement('div');
    this.hudLayer.className = 'hud-layer hidden';

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
    window.removeEventListener('keydown', this.handleModalKeyDown);
    this.root.innerHTML = '';
  }

  // ==========================================================================
  // ENGINE CALLBACK HANDLERS
  // ==========================================================================

  public handleStateChange(state: GameState): void {
    if (state === 'menu') {
      this.menuView = 'title';
      this.selectedHeroDetail = null;
      this.selectedAbilityDetail = null;
      this.confirmResetSave = false;
      this.pauseConfirmAction = null;
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
    this.renderLevelUpModal(choices);
    this.syncStateVisibility('levelup');
  }

  public handleBossChestCollected(choices: readonly ArtifactDef[]): void {
    this.renderArtifactModal(choices);
    this.syncStateVisibility('artifact');
  }

  public handleGameOver(summary: RunStatsSnapshot): void {
    this.renderGameOverModal(summary);
    this.syncStateVisibility('gameover');
  }

  // ==========================================================================
  // LAYER VISIBILITY & KEYBOARD SHORTCUTS
  // ==========================================================================

  private syncStateVisibility(state: GameState): void {
    const showHud = state !== 'menu';
    this.hudLayer.classList.toggle('hidden', !showHud);
    this.menuLayer.classList.toggle('hidden', state !== 'menu');
    this.levelUpLayer.classList.toggle('hidden', state !== 'levelup');
    this.artifactLayer.classList.toggle('hidden', state !== 'artifact');
    this.pauseLayer.classList.toggle('hidden', state !== 'paused');
    this.gameOverLayer.classList.toggle('hidden', state !== 'gameover');
  }

  private toggleDebugUnlocked(): void {
    this.debugUnlocked = !this.debugUnlocked;
    const state = this.game.getState();
    if (state === 'paused') {
      this.renderPauseModal();
    } else if (state === 'menu' && this.menuView === 'howto') {
      this.renderMainMenu();
    }
  }

  private readonly handleModalKeyDown = (e: KeyboardEvent): void => {
    const state = this.game.getState();

    // Hidden Debug Menu shortcut: Ctrl + Shift + D (or Cmd + Shift + D)
    if (!e.repeat && (e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyD') {
      e.preventDefault();
      this.game.audio.unlock();
      this.game.audio.playClick();
      this.toggleDebugUnlocked();
      return;
    }

    if (state !== 'levelup' && state !== 'artifact') return;

    const idx = e.key === '1' ? 0 : e.key === '2' ? 1 : e.key === '3' ? 2 : -1;
    if (idx < 0) return;

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
          <p class="menu-subtitle">3 Heroes • 30 Abilities • 15 Synergies • 3 Bosses • 9 Artifacts</p>

          <div class="title-nav-stack">
            <button type="button" class="px-btn px-btn-primary title-nav-btn title-play-btn" data-menu-nav="class_select">
              PLAY
            </button>
            <button type="button" class="px-btn px-btn-lavender title-nav-btn" data-menu-nav="records">
              RECORDS
            </button>
            <button type="button" class="px-btn px-btn-blue title-nav-btn" data-menu-nav="settings">
              SETTINGS
            </button>
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
        this.menuView = target;
        this.renderMainMenu();
      });
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
          </div>

          <div class="hud-center-col">
            <div class="hud-timer-box">
              <span class="hud-timer" data-hud-timer>00:00</span>
              <span class="hud-kills" data-hud-kills>0 KILLS</span>
            </div>
            <div class="hud-next-boss" data-hud-next-boss>BOSS IN 10:00</div>
          </div>

          <div class="hud-right-col">
            <button type="button" class="px-btn hud-icon-btn" data-hud-aim title="Toggle Aim Mode (M)">AUTO</button>
            <button type="button" class="px-btn hud-icon-btn" data-hud-mute title="Toggle Sound">SFX</button>
            <button type="button" class="px-btn px-btn-lavender hud-icon-btn" data-hud-pause title="Pause (ESC / P)">II</button>
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
    this.hudTimer = this.hudLayer.querySelector('[data-hud-timer]')!;
    this.hudKills = this.hudLayer.querySelector('[data-hud-kills]')!;
    this.hudNextBoss = this.hudLayer.querySelector('[data-hud-next-boss]')!;
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

  private updateHud(force = false): void {
    const p = this.game.player;
    const needed = xpNeeded(p.level);
    const xpRatio = Math.max(0, Math.min(1, p.xp / Math.max(1, needed)));
    const xpPctRounded = Math.round(xpRatio * 1000) / 10;

    if (force || p.level !== this.lastLevel || xpPctRounded !== this.lastXpRatio) {
      this.lastLevel = p.level;
      this.lastXpRatio = xpPctRounded;
      this.hudLevelBadge.textContent = `LV ${p.level}`;
      this.hudXpFill.style.width = `${xpPctRounded}%`;
      this.hudXpText.textContent = `${Math.floor(p.xp)} / ${needed} XP`;
    }

    // Hero HP & mini portrait
    const hpCur = Math.max(0, Math.ceil(p.hp));
    const hpMax = Math.max(1, Math.round(p.maxHp));
    const hpKey = `${p.heroId}:${hpCur}/${hpMax}`;
    if (force || hpKey !== this.lastHpKey) {
      this.lastHpKey = hpKey;
      const ratio = Math.max(0, Math.min(1, p.hp / hpMax));
      this.hudHeroName.textContent = CLASSES[p.heroId].name.toUpperCase();
      this.hudHpNumbers.textContent = `${hpCur}/${hpMax}`;
      this.hudHpFill.style.width = `${Math.round(ratio * 100)}%`;
      this.hudHpFill.classList.toggle('low', ratio <= 0.35);
    }

    const walkFrame = p.isMoving ? (Math.floor(p.walkTime * 7) % 2) : 0;
    if (force || walkFrame !== this.lastHudHeroFrame || p.heroId !== this.lastHudHeroId) {
      this.lastHudHeroFrame = walkFrame;
      this.lastHudHeroId = p.heroId;
      const hctx = this.hudHeroCanvas.getContext('2d');
      if (hctx) {
        hctx.imageSmoothingEnabled = false;
        hctx.clearRect(0, 0, 16, 16);
        hctx.drawImage(this.game.sprites.heroes[p.heroId][walkFrame], 0, 0, 16, 16);
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
        this.hudBossHpText.textContent = `${hpInt} / ${maxInt}`;
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
    const heroId = this.game.player.heroId;
    const classDef = CLASSES[heroId];
    const stats = this.game.getComputedStats();
    const passives = this.game.getGlobalPassives();
    const synergies = getSynergiesForClass(heroId);
    const ownedSynergies = this.game.getOwnedSynergies();
    const muted = this.game.audio.isMuted();
    const aimMode = this.game.input.getAimMode();

    const cdrPct = Math.round((1 - stats.cooldownMult) * 100);
    const statRows: Array<[string, string]> = [
      ['Max HP', `${Math.ceil(this.game.player.hp)} / ${Math.round(stats.maxHp)}`],
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

    this.pauseLayer.innerHTML = `
      <div class="modal-card">
        <div class="pause-header">
          <div class="pause-title-group">
            <h2 class="modal-banner">PAUSED</h2>
            <span class="px-pill" style="background:${classDef.accentColor}">
              ${escapeHtml(classDef.name.toUpperCase())} • LV ${this.game.player.level} • ${formatTime(this.game.getElapsedRunSec())}
            </span>
          </div>
          <div class="pause-actions">
            <button type="button" class="px-btn px-btn-primary" data-pause-resume>RESUME</button>
            <button type="button" class="px-btn px-btn-peach" data-pause-restart>RESTART</button>
            <button type="button" class="px-btn" data-pause-menu>MAIN MENU</button>
            <button type="button" class="px-btn ${aimMode === 'mouse' ? 'px-btn-blue' : ''}" data-pause-aim>
              AIM: ${aimMode === 'mouse' ? 'MOUSE' : 'AUTO'}
            </button>
            <button type="button" class="px-btn ${muted ? 'px-btn-coral' : 'px-btn-butter'}" data-pause-mute>
              ${muted ? 'SFX: OFF' : 'SFX: ON'}
            </button>
          </div>
        </div>

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
          this.debugUnlocked
            ? `
        <div class="debug-bar">
          <h3 class="pause-section-title">
            <span>Debug Tools</span>
            <span style="font-size:10px;color:var(--text-muted)">Instant Boss & Progression Testing</span>
          </h3>
          <div class="debug-buttons">
            <button type="button" class="px-btn px-btn-peach" data-debug-boss="king_mochi">Spawn King Mochi</button>
            <button type="button" class="px-btn px-btn-lavender" data-debug-boss="lady_wisteria">Spawn Lady Wisteria</button>
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
              ${this.pauseConfirmAction === 'restart' ? 'RESTART RUN?' : 'EXIT TO MAIN MENU?'}
            </h3>
            <p class="pause-confirm-text">
              Abandon current run? Current progress will be lost.
            </p>
            <div class="pause-confirm-actions">
              <button type="button" class="px-btn" data-pause-confirm-cancel>CANCEL</button>
              <button type="button" class="px-btn px-btn-coral" data-pause-confirm-yes>
                ${this.pauseConfirmAction === 'restart' ? 'CONFIRM RESTART' : 'EXIT TO MENU'}
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
      if (action === 'restart') {
        this.resetHudCaches();
        this.game.startRun(this.game.player.heroId);
      } else if (action === 'menu') {
        this.game.setState('menu');
      }
    });

    this.pauseLayer.querySelector('[data-pause-aim]')?.addEventListener('click', () => {
      this.game.audio.unlock();
      const next = this.game.input.toggleAimMode();
      this.updateAimButtons(next);
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

    // Bind Debug Tools (only present when debugUnlocked === true)
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
  // 5. GAME OVER MODAL
  // ==========================================================================

  private renderGameOverModal(summary: RunStatsSnapshot): void {
    const heroId = this.game.player.heroId;
    const classDef = CLASSES[heroId];
    const heroDataUrl = this.game.sprites.heroes[heroId][0].toDataURL();
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
