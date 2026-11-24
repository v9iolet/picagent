import { readProductCardSnapshot } from "../../../shared/product-card";
import { resolveSellingPointLayouts, resolveVisualStyle } from "../../../shared/selling-point-layouts";
import { SUITE_CATEGORY_GROUPS, type SuiteCategoryGroupCode } from "../../../shared/suite-categories";
import type { ApiImage } from "../../api/client";
import { sanitizeSelectedProductCardSummary } from "../product-card-picker/types";
import { initialConfig, type Config, type Counts, type StudioState } from "./studio";

export const LAST_SUITE_STORAGE_KEY = "picagent:suite-studio:last-suite-id";
export const SUITE_WORKSPACE_STORAGE_KEY = "picagent:suite-studio:workspace-v1";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SuiteWorkspaceSnapshot {
  activeSuiteId: string | null;
  config: Config;
  configSuiteId: string | null;
  hasLocalConfigEdits: boolean;
  clone: boolean;
}

export interface SuiteWorkspaceMemoryCache {
  suiteId: string;
  state: StudioState | null;
  images: ApiImage[];
}

interface PersistedWorkspacePayload {
  version: 1;
  activeSuiteId: string | null;
  config: Config;
  configSuiteId: string | null;
  hasLocalConfigEdits: boolean;
  clone: boolean;
}

const CATEGORY_KEYS = Object.keys(SUITE_CATEGORY_GROUPS) as SuiteCategoryGroupCode[];

export function cloneConfig(config: Config): Config {
  return {
    ...config,
    counts: { ...config.counts },
    sellingPointLayouts: [...config.sellingPointLayouts],
    productCardSummary: config.productCardSummary
      ? {
          ...config.productCardSummary,
          ...(config.productCardSummary.sellingPoints
            ? { sellingPoints: [...config.productCardSummary.sellingPoints] }
            : {}),
        }
      : null,
    productCardSnapshot: config.productCardSnapshot
      ? {
          ...config.productCardSnapshot,
          ...(config.productCardSnapshot.sellingPoints
            ? { sellingPoints: [...config.productCardSnapshot.sellingPoints] }
            : {}),
        }
      : null,
  };
}

function sanitizeCounts(raw: unknown): Counts {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const counts: Counts = { ...initialConfig.counts };
  for (const key of CATEGORY_KEYS) {
    const value = source[key];
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
      counts[key] = value;
    }
  }
  return counts;
}

export function sanitizeSuiteConfig(raw: unknown): Config {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return cloneConfig(initialConfig);
  }
  const data = raw as Record<string, unknown>;
  const mode: Config["mode"] = data.mode === "custom" ? "custom" : "smart";
  const counts = sanitizeCounts(data.counts);
  const productCardSnapshot = readProductCardSnapshot(data.productCardSnapshot);
  const rawCardId = typeof data.productCardId === "string" && data.productCardId.trim()
    ? data.productCardId.trim()
    : null;
  const rawSummary = rawCardId ? sanitizeSelectedProductCardSummary(data.productCardSummary) : null;
  const productCardSummary = rawSummary && rawSummary.cardId === rawCardId ? rawSummary : null;

  return {
    platform: typeof data.platform === "string" ? data.platform : initialConfig.platform,
    targetMarket:
      typeof data.targetMarket === "string" && data.targetMarket.trim()
        ? data.targetMarket
        : initialConfig.targetMarket,
    outputLanguage:
      typeof data.outputLanguage === "string" && data.outputLanguage.trim()
        ? data.outputLanguage
        : initialConfig.outputLanguage,
    aspectRatio:
      typeof data.aspectRatio === "string" && data.aspectRatio.trim()
        ? data.aspectRatio
        : initialConfig.aspectRatio,
    size: typeof data.size === "string" && data.size.trim() ? data.size : initialConfig.size,
    sellingPoints: typeof data.sellingPoints === "string" ? data.sellingPoints : initialConfig.sellingPoints,
    mode,
    counts,
    visualStyle: resolveVisualStyle(data.visualStyle).id,
    sellingPointLayouts:
      mode === "smart"
        ? []
        : resolveSellingPointLayouts(data.sellingPointLayouts, counts.selling_points).map(({ id }) => id),
    listingCopy: typeof data.listingCopy === "boolean" ? data.listingCopy : initialConfig.listingCopy,
    productCardId: rawCardId,
    productCardSummary,
    productCardSnapshot,
  };
}

export function isConfigDirty(config: Config, defaultPlatform = ""): boolean {
  if (config.platform && config.platform !== defaultPlatform) return true;
  if (config.targetMarket !== initialConfig.targetMarket) return true;
  if (config.outputLanguage !== initialConfig.outputLanguage) return true;
  if (config.aspectRatio !== initialConfig.aspectRatio) return true;
  if (config.size !== initialConfig.size) return true;
  if (config.sellingPoints !== initialConfig.sellingPoints) return true;
  if (config.mode !== initialConfig.mode) return true;
  if (config.visualStyle !== initialConfig.visualStyle) return true;
  if (config.sellingPointLayouts.length > 0) return true;
  if (config.listingCopy !== initialConfig.listingCopy) return true;
  if (config.productCardId) return true;
  for (const key of CATEGORY_KEYS) {
    if (config.counts[key] !== initialConfig.counts[key]) return true;
  }
  return false;
}

function emptySnapshot(): SuiteWorkspaceSnapshot {
  return {
    activeSuiteId: null,
    config: cloneConfig(initialConfig),
    configSuiteId: null,
    hasLocalConfigEdits: false,
    clone: false,
  };
}

function cloneSnapshot(snapshot: SuiteWorkspaceSnapshot): SuiteWorkspaceSnapshot {
  return {
    activeSuiteId: snapshot.activeSuiteId,
    config: cloneConfig(snapshot.config),
    configSuiteId: snapshot.configSuiteId,
    hasLocalConfigEdits: snapshot.hasLocalConfigEdits,
    clone: snapshot.clone,
  };
}

function safeGetItem(storage: StorageLike | null, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(storage: StorageLike | null, key: string, value: string): void {
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch {
    // Ignore storage quota or privacy-mode errors.
  }
}

function safeRemoveItem(storage: StorageLike | null, key: string): void {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // Ignore storage errors.
  }
}

function readNormalizedId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function loadPersistedSnapshot(storage: StorageLike | null): SuiteWorkspaceSnapshot {
  const lastSuiteId = readNormalizedId(safeGetItem(storage, LAST_SUITE_STORAGE_KEY));
  const rawWorkspace = safeGetItem(storage, SUITE_WORKSPACE_STORAGE_KEY);

  if (!rawWorkspace) {
    const base = emptySnapshot();
    if (lastSuiteId) {
      base.activeSuiteId = lastSuiteId;
    }
    return base;
  }

  try {
    const parsed = JSON.parse(rawWorkspace) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.version !== 1) {
      const base = emptySnapshot();
      if (lastSuiteId) base.activeSuiteId = lastSuiteId;
      return base;
    }

    const storedActiveId = readNormalizedId(parsed.activeSuiteId);
    const storedConfigSuiteId = readNormalizedId(parsed.configSuiteId);
    const config = sanitizeSuiteConfig(parsed.config);
    const hasLocalConfigEdits = Boolean(parsed.hasLocalConfigEdits);
    const clone = Boolean(parsed.clone);

    // Keep workspace activeSuiteId strictly synchronized with LAST_SUITE_STORAGE_KEY.
    // If LAST_SUITE_STORAGE_KEY was externally cleared while a suite was active, drop the stale active suite.
    if (storedActiveId && !lastSuiteId) {
      return emptySnapshot();
    }

    // If LAST_SUITE_STORAGE_KEY was externally overridden to a different suiteId, honor it cleanly.
    if (lastSuiteId && lastSuiteId !== storedActiveId) {
      return {
        activeSuiteId: lastSuiteId,
        config: cloneConfig(initialConfig),
        configSuiteId: null,
        hasLocalConfigEdits: false,
        clone: false,
      };
    }

    const activeSuiteId = storedActiveId ?? lastSuiteId;
    return {
      activeSuiteId,
      config,
      configSuiteId: activeSuiteId ? storedConfigSuiteId : null,
      hasLocalConfigEdits,
      clone: activeSuiteId ? clone : false,
    };
  } catch {
    const base = emptySnapshot();
    if (lastSuiteId) base.activeSuiteId = lastSuiteId;
    return base;
  }
}

export interface SuiteWorkspaceStore {
  getSnapshot(): SuiteWorkspaceSnapshot;
  setActiveSuite(
    suiteId: string | null,
    options?: { clone?: boolean; resetLocalConfig?: boolean },
  ): SuiteWorkspaceSnapshot;
  updateConfig(
    config: Config,
    options?: { suiteId?: string | null; markDirty?: boolean; clone?: boolean },
  ): SuiteWorkspaceSnapshot;
  hydrateFromServer(suiteId: string, config: Config, clone: boolean): SuiteWorkspaceSnapshot;
  setClone(clone: boolean): SuiteWorkspaceSnapshot;
  getMemoryCache(suiteId: string): SuiteWorkspaceMemoryCache | null;
  setMemoryCache(entry: SuiteWorkspaceMemoryCache | null): void;
  clear(): SuiteWorkspaceSnapshot;
}

export function createSuiteWorkspaceStore(storage: StorageLike | null): SuiteWorkspaceStore {
  let snapshot = loadPersistedSnapshot(storage);
  let memoryCache: SuiteWorkspaceMemoryCache | null = null;

  function persist(next: SuiteWorkspaceSnapshot) {
    snapshot = cloneSnapshot(next);
    if (snapshot.activeSuiteId) {
      safeSetItem(storage, LAST_SUITE_STORAGE_KEY, snapshot.activeSuiteId);
    } else {
      safeRemoveItem(storage, LAST_SUITE_STORAGE_KEY);
    }

    const hasAnythingToPersist =
      snapshot.activeSuiteId !== null ||
      snapshot.hasLocalConfigEdits ||
      snapshot.clone ||
      isConfigDirty(snapshot.config);

    if (!hasAnythingToPersist) {
      safeRemoveItem(storage, SUITE_WORKSPACE_STORAGE_KEY);
      return;
    }

    const payload: PersistedWorkspacePayload = {
      version: 1,
      activeSuiteId: snapshot.activeSuiteId,
      config: snapshot.config,
      configSuiteId: snapshot.configSuiteId,
      hasLocalConfigEdits: snapshot.hasLocalConfigEdits,
      clone: snapshot.clone,
    };
    safeSetItem(storage, SUITE_WORKSPACE_STORAGE_KEY, JSON.stringify(payload));
  }

  return {
    getSnapshot() {
      // Reconcile if LAST_SUITE_STORAGE_KEY was externally mutated or cleared in the same tab.
      const externalLastId = readNormalizedId(safeGetItem(storage, LAST_SUITE_STORAGE_KEY));
      if (externalLastId !== snapshot.activeSuiteId) {
        snapshot = loadPersistedSnapshot(storage);
        if (memoryCache && memoryCache.suiteId !== snapshot.activeSuiteId) {
          memoryCache = null;
        }
      }
      return cloneSnapshot(snapshot);
    },

    setActiveSuite(suiteId, options = {}) {
      const normalized = readNormalizedId(suiteId);
      const switchingSuite = normalized !== snapshot.activeSuiteId;
      if (memoryCache && memoryCache.suiteId !== normalized) {
        memoryCache = null;
      }

      const next: SuiteWorkspaceSnapshot = {
        ...snapshot,
        activeSuiteId: normalized,
        clone:
          options.clone !== undefined
            ? Boolean(normalized && options.clone)
            : normalized
              ? switchingSuite
                ? false
                : snapshot.clone
              : false,
      };

      if (options.resetLocalConfig) {
        next.config = cloneConfig(initialConfig);
        next.configSuiteId = normalized;
        next.hasLocalConfigEdits = false;
      } else if (normalized && snapshot.configSuiteId === null && snapshot.hasLocalConfigEdits) {
        // Carry pre-upload draft config forward onto the newly created draft suiteId.
        next.configSuiteId = normalized;
      } else if (switchingSuite) {
        if (next.configSuiteId !== normalized) {
          next.config = cloneConfig(initialConfig);
          next.configSuiteId = normalized;
          next.hasLocalConfigEdits = false;
        }
      }

      persist(next);
      return cloneSnapshot(snapshot);
    },

    updateConfig(config, options = {}) {
      const sanitized = sanitizeSuiteConfig(config);
      const nextSuiteId =
        options.suiteId !== undefined ? readNormalizedId(options.suiteId) : snapshot.activeSuiteId;
      const markDirty = options.markDirty ?? true;
      const next: SuiteWorkspaceSnapshot = {
        activeSuiteId: nextSuiteId,
        config: sanitized,
        configSuiteId: nextSuiteId,
        hasLocalConfigEdits: markDirty ? true : snapshot.hasLocalConfigEdits,
        clone:
          options.clone !== undefined
            ? Boolean(nextSuiteId && options.clone)
            : nextSuiteId
              ? snapshot.clone
              : false,
      };
      if (memoryCache && memoryCache.suiteId !== nextSuiteId) {
        memoryCache = null;
      }
      persist(next);
      return cloneSnapshot(snapshot);
    },

    hydrateFromServer(suiteId, config, clone) {
      const normalized = readNormalizedId(suiteId);
      if (!normalized) return cloneSnapshot(snapshot);
      const next: SuiteWorkspaceSnapshot = {
        activeSuiteId: normalized,
        config: sanitizeSuiteConfig(config),
        configSuiteId: normalized,
        hasLocalConfigEdits: false,
        clone: Boolean(clone),
      };
      persist(next);
      return cloneSnapshot(snapshot);
    },

    setClone(clone) {
      const next: SuiteWorkspaceSnapshot = {
        ...snapshot,
        clone: Boolean(snapshot.activeSuiteId && clone),
      };
      persist(next);
      return cloneSnapshot(snapshot);
    },

    getMemoryCache(suiteId) {
      if (!memoryCache || memoryCache.suiteId !== suiteId) return null;
      return {
        suiteId: memoryCache.suiteId,
        state: memoryCache.state,
        images: [...memoryCache.images],
      };
    },

    setMemoryCache(entry) {
      memoryCache = entry
        ? {
            suiteId: entry.suiteId,
            state: entry.state,
            images: [...entry.images],
          }
        : null;
    },

    clear() {
      memoryCache = null;
      snapshot = emptySnapshot();
      safeRemoveItem(storage, LAST_SUITE_STORAGE_KEY);
      safeRemoveItem(storage, SUITE_WORKSPACE_STORAGE_KEY);
      return cloneSnapshot(snapshot);
    },
  };
}

function browserSessionStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function readLastSuiteId(): string | null {
  return readNormalizedId(safeGetItem(browserSessionStorage(), LAST_SUITE_STORAGE_KEY));
}

export function saveLastSuiteId(id: string): void {
  const normalized = readNormalizedId(id);
  if (!normalized) return;
  safeSetItem(browserSessionStorage(), LAST_SUITE_STORAGE_KEY, normalized);
}

export function clearLastSuiteId(): void {
  safeRemoveItem(browserSessionStorage(), LAST_SUITE_STORAGE_KEY);
}

export const suiteWorkspaceStore = createSuiteWorkspaceStore(browserSessionStorage());
