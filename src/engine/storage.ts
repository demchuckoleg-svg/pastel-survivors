import type { HeroId } from '../art/sprites';

/**
 * localStorage persistence for per-class best runs and user preferences.
 */

export type AimMode = 'auto' | 'mouse';

export interface BestRunRecord {
  bestTimeSec: number;
  bestLevel: number;
  bestKills: number;
  bestBosses: number;
  runsPlayed: number;
}

export interface RunSummaryInput {
  timeSec: number;
  level: number;
  kills: number;
  bosses: number;
}

export interface NewBestFlags {
  time: boolean;
  level: boolean;
  kills: boolean;
  bosses: boolean;
  any: boolean;
}

export interface GameSettings {
  muted: boolean;
  aimMode: AimMode;
}

export interface SaveData {
  version: number;
  settings: GameSettings;
  bestRuns: Record<HeroId, BestRunRecord>;
}

const STORAGE_KEY = 'pastel_survivors_save_v1';
const SAVE_VERSION = 1;
const HERO_IDS: readonly HeroId[] = ['mage', 'ranger', 'knight'];

function createEmptyRecord(): BestRunRecord {
  return {
    bestTimeSec: 0,
    bestLevel: 0,
    bestKills: 0,
    bestBosses: 0,
    runsPlayed: 0,
  };
}

function createDefaultSaveData(): SaveData {
  return {
    version: SAVE_VERSION,
    settings: {
      muted: false,
      aimMode: 'auto',
    },
    bestRuns: {
      mage: createEmptyRecord(),
      ranger: createEmptyRecord(),
      knight: createEmptyRecord(),
    },
  };
}

function sanitizeNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function sanitizeRecord(raw: unknown): BestRunRecord {
  if (!raw || typeof raw !== 'object') return createEmptyRecord();
  const obj = raw as Record<string, unknown>;
  return {
    bestTimeSec: sanitizeNumber(obj.bestTimeSec),
    bestLevel: Math.floor(sanitizeNumber(obj.bestLevel)),
    bestKills: Math.floor(sanitizeNumber(obj.bestKills)),
    bestBosses: Math.floor(sanitizeNumber(obj.bestBosses)),
    runsPlayed: Math.floor(sanitizeNumber(obj.runsPlayed)),
  };
}

function getStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Ignore storage access errors (e.g., restricted iframes or private mode)
  }
  return null;
}

let cachedSave: SaveData | null = null;

export function loadSaveData(): SaveData {
  if (cachedSave) return cachedSave;

  const fallback = createDefaultSaveData();
  const storage = getStorage();
  if (!storage) {
    cachedSave = fallback;
    return cachedSave;
  }

  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) {
      cachedSave = fallback;
      return cachedSave;
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const rawSettings =
      parsed.settings && typeof parsed.settings === 'object'
        ? (parsed.settings as Record<string, unknown>)
        : {};
    const rawRuns =
      parsed.bestRuns && typeof parsed.bestRuns === 'object'
        ? (parsed.bestRuns as Record<string, unknown>)
        : {};

    const bestRuns = {} as Record<HeroId, BestRunRecord>;
    for (const heroId of HERO_IDS) {
      bestRuns[heroId] = sanitizeRecord(rawRuns[heroId]);
    }

    cachedSave = {
      version: SAVE_VERSION,
      settings: {
        muted: Boolean(rawSettings.muted),
        aimMode: rawSettings.aimMode === 'mouse' ? 'mouse' : 'auto',
      },
      bestRuns,
    };
    return cachedSave;
  } catch {
    cachedSave = fallback;
    return cachedSave;
  }
}

export function persistSaveData(data: SaveData): void {
  cachedSave = data;
  const storage = getStorage();
  if (!storage) return;

  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Silently ignore quota or security errors
  }
}

export function getBestRun(heroId: HeroId): BestRunRecord {
  const data = loadSaveData();
  return { ...data.bestRuns[heroId] };
}

export function getAllBestRuns(): Record<HeroId, BestRunRecord> {
  const data = loadSaveData();
  return {
    mage: { ...data.bestRuns.mage },
    ranger: { ...data.bestRuns.ranger },
    knight: { ...data.bestRuns.knight },
  };
}

/**
 * Updates the stored per-class best run records if any metric improved,
 * and returns flags indicating which personal bests were broken.
 */
export function recordRunResult(
  heroId: HeroId,
  summary: RunSummaryInput
): { record: BestRunRecord; newBests: NewBestFlags } {
  const data = loadSaveData();
  const prev = data.bestRuns[heroId];

  const timeSec = Math.max(0, Math.floor(summary.timeSec));
  const level = Math.max(1, Math.floor(summary.level));
  const kills = Math.max(0, Math.floor(summary.kills));
  const bosses = Math.max(0, Math.floor(summary.bosses));

  const newBests: NewBestFlags = {
    time: timeSec > prev.bestTimeSec,
    level: level > prev.bestLevel,
    kills: kills > prev.bestKills,
    bosses: bosses > prev.bestBosses,
    any: false,
  };
  newBests.any = newBests.time || newBests.level || newBests.kills || newBests.bosses;

  const updated: BestRunRecord = {
    bestTimeSec: Math.max(prev.bestTimeSec, timeSec),
    bestLevel: Math.max(prev.bestLevel, level),
    bestKills: Math.max(prev.bestKills, kills),
    bestBosses: Math.max(prev.bestBosses, bosses),
    runsPlayed: prev.runsPlayed + 1,
  };

  data.bestRuns[heroId] = updated;
  persistSaveData(data);

  return { record: { ...updated }, newBests };
}

export function getMutedPreference(): boolean {
  return loadSaveData().settings.muted;
}

export function setMutedPreference(muted: boolean): void {
  const data = loadSaveData();
  if (data.settings.muted === muted) return;
  data.settings.muted = muted;
  persistSaveData(data);
}

export function getAimModePreference(): AimMode {
  return loadSaveData().settings.aimMode;
}

export function setAimModePreference(aimMode: AimMode): void {
  const data = loadSaveData();
  if (data.settings.aimMode === aimMode) return;
  data.settings.aimMode = aimMode;
  persistSaveData(data);
}

export function resetSaveData(): void {
  const fresh = createDefaultSaveData();
  persistSaveData(fresh);
}
