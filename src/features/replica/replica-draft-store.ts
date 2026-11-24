import { sanitizeSelectedProductCardSummary } from "../../components/product-card-picker/types";
import {
  replicaDraftBlobStorage,
  type ReplicaDraftBlobStorage,
} from "./replica-draft-idb";
import {
  arrayBufferToBase64,
  computeSha256Hex,
  INITIAL_REPLICA_CONFIG,
  REPLICA_ACCEPTED_MIME_TYPES,
  REPLICA_CLONE_LEVEL_LABELS,
  REPLICA_LANGUAGE_OPTIONS,
  REPLICA_MAX_IMAGE_BYTES,
  REPLICA_MAX_PRODUCTS,
  REPLICA_MAX_REFERENCES,
  REPLICA_SCENE_LABELS,
  validateImageFile,
  type ReplicaCloneLevel,
  type ReplicaConfigDraft,
  type ReplicaLanguage,
  type ReplicaProductDraft,
  type ReplicaReferenceDraft,
  type ReplicaSceneType,
} from "./replica-types";

export const REPLICA_LAST_SUITE_STORAGE_KEY = "picagent:replica-studio:last-suite-id";
export const REPLICA_DRAFT_CONFIG_STORAGE_KEY = "picagent:replica-studio:config-draft";
export const REPLICA_DRAFT_STORAGE_KEY = "picagent:replica-studio:draft-v1";

export interface ReplicaDraftSnapshot {
  references: ReplicaReferenceDraft[];
  products: ReplicaProductDraft[];
  config: ReplicaConfigDraft;
  refNotice: string;
  productNotice: string;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface PersistedReplicaReferenceMeta {
  localId: string;
  blobKey: string;
  filename: string;
  mimeType: string;
  sha256: string;
  remark: string;
}

interface PersistedReplicaProductMeta {
  localId: string;
  sourceKind: "upload";
  blobKey: string;
  filename: string;
  mimeType: string;
  sha256: string;
}

interface PersistedReplicaDraft {
  version: 1;
  config: ReplicaConfigDraft;
  references: PersistedReplicaReferenceMeta[];
  products: PersistedReplicaProductMeta[];
}

export function readLastReplicaSuiteId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.sessionStorage.getItem(REPLICA_LAST_SUITE_STORAGE_KEY)?.trim();
    return value || null;
  } catch {
    return null;
  }
}

export function saveLastReplicaSuiteId(id: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(REPLICA_LAST_SUITE_STORAGE_KEY, id);
  } catch {
    // Ignore storage quota or privacy-mode errors.
  }
}

export function clearLastReplicaSuiteId(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(REPLICA_LAST_SUITE_STORAGE_KEY);
  } catch {
    // Ignore storage errors.
  }
}

const VALID_LANGUAGES = new Set<string>(REPLICA_LANGUAGE_OPTIONS.map((item) => item.value));
const VALID_MIME_TYPES = new Set<string>(REPLICA_ACCEPTED_MIME_TYPES);

function sanitizeConfigDraft(raw: unknown): ReplicaConfigDraft {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...INITIAL_REPLICA_CONFIG };
  }
  const data = raw as Record<string, unknown>;
  const sceneType: ReplicaSceneType =
    typeof data.sceneType === "string" &&
    Object.prototype.hasOwnProperty.call(REPLICA_SCENE_LABELS, data.sceneType)
      ? (data.sceneType as ReplicaSceneType)
      : INITIAL_REPLICA_CONFIG.sceneType;
  const cloneLevel: ReplicaCloneLevel =
    typeof data.cloneLevel === "string" &&
    Object.prototype.hasOwnProperty.call(REPLICA_CLONE_LEVEL_LABELS, data.cloneLevel)
      ? (data.cloneLevel as ReplicaCloneLevel)
      : INITIAL_REPLICA_CONFIG.cloneLevel;
  const language: ReplicaLanguage =
    typeof data.language === "string" && VALID_LANGUAGES.has(data.language)
      ? (data.language as ReplicaLanguage)
      : INITIAL_REPLICA_CONFIG.language;

  const productCardId =
    typeof data.productCardId === "string" && data.productCardId.trim()
      ? data.productCardId.trim()
      : null;
  const rawSummary = productCardId
    ? sanitizeSelectedProductCardSummary(data.productCardSummary)
    : null;
  const productCardSummary =
    rawSummary && rawSummary.cardId === productCardId ? rawSummary : null;

  return {
    sceneType,
    cloneLevel,
    unifiedRequirement:
      typeof data.unifiedRequirement === "string"
        ? data.unifiedRequirement
        : INITIAL_REPLICA_CONFIG.unifiedRequirement,
    productInfo:
      typeof data.productInfo === "string" ? data.productInfo : INITIAL_REPLICA_CONFIG.productInfo,
    productCardId,
    productCardSummary,
    styleUnified:
      typeof data.styleUnified === "boolean"
        ? data.styleUnified
        : INITIAL_REPLICA_CONFIG.styleUnified,
    language,
    ratio:
      typeof data.ratio === "string" && data.ratio.trim()
        ? data.ratio.trim()
        : INITIAL_REPLICA_CONFIG.ratio,
    size:
      typeof data.size === "string" && data.size.trim()
        ? data.size.trim()
        : INITIAL_REPLICA_CONFIG.size,
  };
}

function isDefaultConfig(config: ReplicaConfigDraft): boolean {
  return (
    config.sceneType === INITIAL_REPLICA_CONFIG.sceneType &&
    config.cloneLevel === INITIAL_REPLICA_CONFIG.cloneLevel &&
    config.unifiedRequirement === INITIAL_REPLICA_CONFIG.unifiedRequirement &&
    config.productInfo === INITIAL_REPLICA_CONFIG.productInfo &&
    config.productCardId === INITIAL_REPLICA_CONFIG.productCardId &&
    config.productCardSummary === INITIAL_REPLICA_CONFIG.productCardSummary &&
    config.styleUnified === INITIAL_REPLICA_CONFIG.styleUnified &&
    config.language === INITIAL_REPLICA_CONFIG.language &&
    config.ratio === INITIAL_REPLICA_CONFIG.ratio &&
    config.size === INITIAL_REPLICA_CONFIG.size
  );
}

function sanitizePersistedReferences(raw: unknown): PersistedReplicaReferenceMeta[] {
  if (!Array.isArray(raw)) return [];
  const items: PersistedReplicaReferenceMeta[] = [];
  const seenIds = new Set<string>();
  for (const entry of raw) {
    if (items.length >= REPLICA_MAX_REFERENCES) break;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const data = entry as Record<string, unknown>;
    const localId = typeof data.localId === "string" ? data.localId.trim() : "";
    const filename = typeof data.filename === "string" ? data.filename.trim() : "";
    const mimeType = typeof data.mimeType === "string" ? data.mimeType.trim() : "";
    if (!localId || !filename || !VALID_MIME_TYPES.has(mimeType) || seenIds.has(localId)) continue;
    seenIds.add(localId);
    const blobKey =
      typeof data.blobKey === "string" && data.blobKey.trim() ? data.blobKey.trim() : localId;
    items.push({
      localId,
      blobKey,
      filename,
      mimeType,
      sha256: typeof data.sha256 === "string" ? data.sha256 : "",
      remark: typeof data.remark === "string" ? data.remark : "",
    });
  }
  return items;
}

function sanitizePersistedProducts(raw: unknown): PersistedReplicaProductMeta[] {
  if (!Array.isArray(raw)) return [];
  const items: PersistedReplicaProductMeta[] = [];
  const seenLocalIds = new Set<string>();
  for (const entry of raw) {
    if (items.length >= REPLICA_MAX_PRODUCTS) break;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const data = entry as Record<string, unknown>;
    if (data.sourceKind !== "upload") continue;
    const localId = typeof data.localId === "string" ? data.localId.trim() : "";
    const filename = typeof data.filename === "string" ? data.filename.trim() : "";
    const mimeType = typeof data.mimeType === "string" ? data.mimeType.trim() : "";
    if (!localId || !filename || !VALID_MIME_TYPES.has(mimeType) || seenLocalIds.has(localId)) {
      continue;
    }
    seenLocalIds.add(localId);
    const blobKey =
      typeof data.blobKey === "string" && data.blobKey.trim() ? data.blobKey.trim() : localId;
    items.push({
      localId,
      sourceKind: "upload",
      blobKey,
      filename,
      mimeType,
      sha256: typeof data.sha256 === "string" ? data.sha256 : "",
    });
  }
  return items;
}

function readPersistedDraft(
  storage: StorageLike | null,
  legacySessionStorage: StorageLike | null,
): PersistedReplicaDraft | null {
  if (storage) {
    try {
      const raw = storage.getItem(REPLICA_DRAFT_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return {
            version: 1,
            config: sanitizeConfigDraft(parsed.config),
            references: sanitizePersistedReferences(parsed.references),
            products: sanitizePersistedProducts(parsed.products),
          };
        }
      }
    } catch {
      // Ignore storage or JSON parse errors.
    }
  }
  if (legacySessionStorage) {
    try {
      const raw = legacySessionStorage.getItem(REPLICA_DRAFT_CONFIG_STORAGE_KEY);
      if (raw) {
        return {
          version: 1,
          config: sanitizeConfigDraft(JSON.parse(raw)),
          references: [],
          products: [],
        };
      }
    } catch {
      // Ignore storage errors.
    }
  }
  return null;
}

function readLiveStorageBlobKeys(storage: StorageLike | null): Set<string> | null {
  if (!storage) return new Set<string>();
  try {
    const raw = storage.getItem(REPLICA_DRAFT_STORAGE_KEY);
    if (!raw) return new Set<string>();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const keys = new Set<string>();
    for (const ref of sanitizePersistedReferences(parsed.references)) {
      keys.add(ref.blobKey);
    }
    for (const product of sanitizePersistedProducts(parsed.products)) {
      if (product.sourceKind === "upload") keys.add(product.blobKey);
    }
    return keys;
  } catch {
    // Prefer skipping orphan deletion over deleting active blobs if storage cannot be read safely.
    return null;
  }
}

function reorderList<T>(items: readonly T[], fromIndex: number, toIndex: number): T[] {
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= items.length ||
    toIndex >= items.length ||
    fromIndex === toIndex
  ) {
    return items.slice();
  }
  const next = items.slice();
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

function getDefaultLocalStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function getDefaultSessionStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export interface ReplicaDraftStoreDeps {
  storage?: StorageLike | null;
  legacySessionStorage?: StorageLike | null;
  blobStorage?: ReplicaDraftBlobStorage | null;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
}

export interface ReplicaDraftStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ReplicaDraftSnapshot;
  waitForHydration(): Promise<void>;
  addReferences(files: File[]): void;
  removeReference(localId: string): void;
  moveReference(fromIndex: number, toIndex: number): void;
  updateReferenceRemark(localId: string, remark: string): void;
  addProductFiles(files: File[]): void;
  removeProduct(localId: string): void;
  moveProduct(fromIndex: number, toIndex: number): void;
  updateConfig(patch: Partial<ReplicaConfigDraft>): void;
  clearDraft(): void;
}

export function createReplicaDraftStore(deps: ReplicaDraftStoreDeps = {}): ReplicaDraftStore {
  const storage = deps.storage !== undefined ? deps.storage : getDefaultLocalStorage();
  const legacySessionStorage =
    deps.legacySessionStorage !== undefined
      ? deps.legacySessionStorage
      : getDefaultSessionStorage();
  const blobStorage = deps.blobStorage !== undefined ? deps.blobStorage : replicaDraftBlobStorage;
  const createUrl = deps.createObjectUrl ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revokeUrl = deps.revokeObjectUrl ?? ((url: string) => URL.revokeObjectURL(url));

  let localSeq = 0;
  function nextLocalId(prefix: string): string {
    localSeq += 1;
    return `${prefix}-${Date.now()}-${localSeq}`;
  }

  const objectUrls = new Set<string>();
  const listeners = new Set<() => void>();
  let draftGeneration = 0;

  // Map from draft localId -> IndexedDB blob key for upload items persisted to IDB.
  const persistedBlobKeys = new Map<string, string>();
  const hydratingRefBlobKeys = new Map<string, string>();
  const hydratingProductBlobKeys = new Map<string, string>();
  const inFlightBlobKeys = new Set<string>();

  const initialPersisted = readPersistedDraft(storage, legacySessionStorage);
  const initialReferences: ReplicaReferenceDraft[] = [];
  const initialProducts: ReplicaProductDraft[] = [];

  if (initialPersisted) {
    for (const ref of initialPersisted.references) {
      hydratingRefBlobKeys.set(ref.localId, ref.blobKey);
      persistedBlobKeys.set(ref.localId, ref.blobKey);
      initialReferences.push({
        localId: ref.localId,
        filename: ref.filename,
        mimeType: ref.mimeType,
        previewUrl: "",
        bytesBase64: "",
        sha256: ref.sha256,
        remark: ref.remark,
        status: "reading",
      });
    }
    for (const product of initialPersisted.products) {
      hydratingProductBlobKeys.set(product.localId, product.blobKey);
      persistedBlobKeys.set(product.localId, product.blobKey);
      initialProducts.push({
        localId: product.localId,
        sourceKind: "upload",
        filename: product.filename,
        mimeType: product.mimeType,
        previewUrl: "",
        bytesBase64: "",
        sha256: product.sha256,
        status: "reading",
      });
    }
  }

  let snapshot: ReplicaDraftSnapshot = {
    references: initialReferences,
    products: initialProducts,
    config: initialPersisted ? initialPersisted.config : { ...INITIAL_REPLICA_CONFIG },
    refNotice: "",
    productNotice: "",
  };

  function emit(): void {
    for (const listener of listeners) listener();
  }

  function updateSnapshot(updater: (prev: ReplicaDraftSnapshot) => ReplicaDraftSnapshot): void {
    const next = updater(snapshot);
    if (next === snapshot) return;
    snapshot = next;
    emit();
  }

  function trackObjectUrl(url: string): string {
    if (url.startsWith("blob:")) objectUrls.add(url);
    return url;
  }

  function releaseObjectUrl(url: string): void {
    if (!url || !url.startsWith("blob:")) return;
    if (objectUrls.has(url)) {
      revokeUrl(url);
      objectUrls.delete(url);
    }
  }

  function revokeAllObjectUrls(): void {
    for (const url of objectUrls) revokeUrl(url);
    objectUrls.clear();
  }

  function clearLegacySessionConfig(): void {
    if (!legacySessionStorage) return;
    try {
      legacySessionStorage.removeItem(REPLICA_DRAFT_CONFIG_STORAGE_KEY);
    } catch {
      // Ignore storage errors.
    }
  }

  function persistDraftMetadata(): void {
    clearLegacySessionConfig();
    if (!storage) return;
    const references: PersistedReplicaReferenceMeta[] = [];
    for (const item of snapshot.references) {
      const blobKey = persistedBlobKeys.get(item.localId);
      if (!blobKey) continue;
      if (item.status !== "ready" && !hydratingRefBlobKeys.has(item.localId)) continue;
      references.push({
        localId: item.localId,
        blobKey,
        filename: item.filename,
        mimeType: item.mimeType,
        sha256: item.sha256,
        remark: item.remark,
      });
    }

    const products: PersistedReplicaProductMeta[] = [];
    for (const item of snapshot.products) {
      const blobKey = persistedBlobKeys.get(item.localId);
      if (!blobKey) continue;
      if (item.status !== "ready" && !hydratingProductBlobKeys.has(item.localId)) continue;
      products.push({
        localId: item.localId,
        sourceKind: "upload",
        blobKey,
        filename: item.filename,
        mimeType: item.mimeType,
        sha256: item.sha256,
      });
    }

    try {
      if (references.length === 0 && products.length === 0 && isDefaultConfig(snapshot.config)) {
        storage.removeItem(REPLICA_DRAFT_STORAGE_KEY);
      } else {
        const payload: PersistedReplicaDraft = {
          version: 1,
          config: snapshot.config,
          references,
          products,
        };
        storage.setItem(REPLICA_DRAFT_STORAGE_KEY, JSON.stringify(payload));
      }
    } catch {
      // Ignore storage quota or privacy-mode errors.
    }
  }

  function clearPersistedDraftMetadata(): void {
    if (storage) {
      try {
        storage.removeItem(REPLICA_DRAFT_STORAGE_KEY);
      } catch {
        // Ignore storage errors.
      }
    }
    clearLegacySessionConfig();
  }

  function collectActiveBlobKeys(): Set<string> | null {
    const liveStorageKeys = readLiveStorageBlobKeys(storage);
    if (!liveStorageKeys) return null;
    const keys = new Set<string>(liveStorageKeys);
    for (const key of persistedBlobKeys.values()) keys.add(key);
    for (const key of inFlightBlobKeys) keys.add(key);
    return keys;
  }

  async function hydrateFromStorage(): Promise<void> {
    const gen = draftGeneration;
    const keysToFetch = [
      ...new Set([...hydratingRefBlobKeys.values(), ...hydratingProductBlobKeys.values()]),
    ];

    if (keysToFetch.length === 0) {
      if (blobStorage && gen === draftGeneration) {
        await blobStorage.pruneBlobs(() => collectActiveBlobKeys());
      }
      return;
    }

    let blobs = new Map<string, Blob>();
    if (blobStorage) {
      try {
        blobs = await blobStorage.getBlobs(keysToFetch);
      } catch {
        blobs = new Map();
      }
    }

    if (gen !== draftGeneration) return;

    const restoredRefs = new Map<
      string,
      { previewUrl: string; bytesBase64: string; sha256: string }
    >();
    const restoredProducts = new Map<
      string,
      { previewUrl: string; bytesBase64: string; sha256: string }
    >();
    const createdUrls: string[] = [];

    const decodeBlob = async (blob: Blob, fallbackMimeType: string, existingSha256: string) => {
      if (typeof blob.size === "number" && (blob.size <= 0 || blob.size > REPLICA_MAX_IMAGE_BYTES)) {
        return null;
      }
      const buffer = await blob.arrayBuffer();
      if (buffer.byteLength <= 0 || buffer.byteLength > REPLICA_MAX_IMAGE_BYTES) {
        return null;
      }
      const [bytesBase64, sha256] = await Promise.all([
        Promise.resolve(arrayBufferToBase64(buffer)),
        existingSha256 ? Promise.resolve(existingSha256) : computeSha256Hex(buffer),
      ]);
      const typedBlob = blob.type ? blob : new Blob([buffer], { type: fallbackMimeType });
      const previewUrl = trackObjectUrl(createUrl(typedBlob));
      createdUrls.push(previewUrl);
      return { previewUrl, bytesBase64, sha256 };
    };

    for (const [localId, blobKey] of hydratingRefBlobKeys.entries()) {
      const blob = blobs.get(blobKey);
      const current = snapshot.references.find((item) => item.localId === localId);
      if (!blob || !current) continue;
      try {
        const decoded = await decodeBlob(blob, current.mimeType, current.sha256);
        if (decoded) restoredRefs.set(localId, decoded);
      } catch {
        // Ignore corrupted blob; drop item gracefully below.
      }
      if (gen !== draftGeneration) {
        for (const url of createdUrls) releaseObjectUrl(url);
        return;
      }
    }

    for (const [localId, blobKey] of hydratingProductBlobKeys.entries()) {
      const blob = blobs.get(blobKey);
      const current = snapshot.products.find(
        (item): item is Extract<ReplicaProductDraft, { sourceKind: "upload" }> =>
          item.sourceKind === "upload" && item.localId === localId,
      );
      if (!blob || !current) continue;
      try {
        const decoded = await decodeBlob(blob, current.mimeType, current.sha256);
        if (decoded) restoredProducts.set(localId, decoded);
      } catch {
        // Ignore corrupted blob; drop item gracefully below.
      }
      if (gen !== draftGeneration) {
        for (const url of createdUrls) releaseObjectUrl(url);
        return;
      }
    }

    const usedUrls = new Set<string>();
    let droppedAny = false;

    const currentRefIds = new Set(snapshot.references.map((item) => item.localId));
    const currentProductIds = new Set(snapshot.products.map((item) => item.localId));

    const nextReferences: ReplicaReferenceDraft[] = [];
    for (const item of snapshot.references) {
      if (!hydratingRefBlobKeys.has(item.localId)) {
        nextReferences.push(item);
        continue;
      }
      const restored = restoredRefs.get(item.localId);
      if (restored) {
        usedUrls.add(restored.previewUrl);
        nextReferences.push({
          ...item,
          previewUrl: restored.previewUrl,
          bytesBase64: restored.bytesBase64,
          sha256: item.sha256 || restored.sha256,
          status: "ready",
        });
      } else {
        persistedBlobKeys.delete(item.localId);
        droppedAny = true;
      }
    }

    const nextProducts: ReplicaProductDraft[] = [];
    for (const item of snapshot.products) {
      if (item.sourceKind !== "upload" || !hydratingProductBlobKeys.has(item.localId)) {
        nextProducts.push(item);
        continue;
      }
      const restored = restoredProducts.get(item.localId);
      if (restored) {
        usedUrls.add(restored.previewUrl);
        nextProducts.push({
          ...item,
          previewUrl: restored.previewUrl,
          bytesBase64: restored.bytesBase64,
          sha256: item.sha256 || restored.sha256,
          status: "ready",
        });
      } else {
        persistedBlobKeys.delete(item.localId);
        droppedAny = true;
      }
    }

    // Revoke any URLs whose items were removed while hydration was decoding blobs.
    for (const [localId, restored] of restoredRefs.entries()) {
      if (!currentRefIds.has(localId) || !usedUrls.has(restored.previewUrl)) {
        releaseObjectUrl(restored.previewUrl);
      }
    }
    for (const [localId, restored] of restoredProducts.entries()) {
      if (!currentProductIds.has(localId) || !usedUrls.has(restored.previewUrl)) {
        releaseObjectUrl(restored.previewUrl);
      }
    }

    hydratingRefBlobKeys.clear();
    hydratingProductBlobKeys.clear();

    updateSnapshot((prev) => ({
      ...prev,
      references: nextReferences,
      products: nextProducts,
    }));

    if (droppedAny) {
      persistDraftMetadata();
    }

    if (blobStorage && gen === draftGeneration) {
      await blobStorage.pruneBlobs(() => collectActiveBlobKeys());
    }
  }

  // Defer IndexedDB hydration & orphan pruning until ReplicaStudioPage subscribes (or waitForHydration is called)
  // so visiting unrelated routes (/assets, /templates, /create/suite) neither decodes blobs nor prunes shared IDB.
  let hydrationPromise: Promise<void> | null = null;
  function ensureHydrated(): Promise<void> {
    if (!hydrationPromise) {
      hydrationPromise = hydrateFromStorage().catch(() => {
        // Hydration is strictly best-effort and must never surface unhandled rejections.
      });
    }
    return hydrationPromise;
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      void ensureHydrated();
      return () => {
        listeners.delete(listener);
      };
    },

    getSnapshot(): ReplicaDraftSnapshot {
      return snapshot;
    },

    waitForHydration(): Promise<void> {
      return ensureHydrated();
    },

    addReferences(files: File[]): void {
      if (!files.length) return;
      const currentCount = snapshot.references.length;
      const remaining = REPLICA_MAX_REFERENCES - currentCount;
      if (remaining <= 0) {
        updateSnapshot((prev) => ({
          ...prev,
          refNotice: `最多上传 ${REPLICA_MAX_REFERENCES} 张参考图。`,
        }));
        return;
      }

      const acceptedFiles = files.slice(0, remaining);
      const overflowNotice =
        files.length > remaining
          ? `最多上传 ${REPLICA_MAX_REFERENCES} 张参考图，超出部分已忽略。`
          : "";

      const pendingItems: Array<{ localId: string; file: File; previewUrl: string }> = [];
      const newDrafts: ReplicaReferenceDraft[] = [];

      for (const file of acceptedFiles) {
        const localId = nextLocalId("ref");
        const error = validateImageFile(file);
        if (error) {
          newDrafts.push({
            localId,
            filename: file.name,
            mimeType: file.type,
            previewUrl: "",
            bytesBase64: "",
            sha256: "",
            remark: "",
            status: "error",
            error,
          });
          continue;
        }
        const previewUrl = trackObjectUrl(createUrl(file));
        newDrafts.push({
          localId,
          filename: file.name,
          mimeType: file.type,
          previewUrl,
          bytesBase64: "",
          sha256: "",
          remark: "",
          status: "reading",
        });
        pendingItems.push({ localId, file, previewUrl });
      }

      const gen = draftGeneration;
      updateSnapshot((prev) => ({
        ...prev,
        refNotice: overflowNotice,
        references: [...prev.references, ...newDrafts],
      }));

      void (async () => {
        const duplicateNames: string[] = [];
        const batchHashes = new Set<string>();
        for (const pending of pendingItems) {
          if (gen !== draftGeneration) {
            releaseObjectUrl(pending.previewUrl);
            continue;
          }
          try {
            const buffer = await pending.file.arrayBuffer();
            const [sha256, bytesBase64] = await Promise.all([
              computeSha256Hex(buffer),
              Promise.resolve(arrayBufferToBase64(buffer)),
            ]);
            if (gen !== draftGeneration) {
              releaseObjectUrl(pending.previewUrl);
              continue;
            }
            const stillPresent = snapshot.references.some(
              (item) => item.localId === pending.localId,
            );
            if (!stillPresent) {
              releaseObjectUrl(pending.previewUrl);
              continue;
            }
            const isDuplicateNow = () =>
              batchHashes.has(sha256) ||
              snapshot.references.some(
                (item) =>
                  item.localId !== pending.localId &&
                  (item.status === "ready" || hydratingRefBlobKeys.has(item.localId)) &&
                  item.sha256 === sha256,
              );

            if (isDuplicateNow()) {
              releaseObjectUrl(pending.previewUrl);
              duplicateNames.push(pending.file.name);
              updateSnapshot((prev) => ({
                ...prev,
                references: prev.references.filter((item) => item.localId !== pending.localId),
              }));
              continue;
            }

            let blobPersisted = false;
            if (blobStorage) {
              inFlightBlobKeys.add(pending.localId);
              try {
                const blob = new Blob([buffer], { type: pending.file.type });
                blobPersisted = await blobStorage.putBlob(pending.localId, blob);
              } catch {
                blobPersisted = false;
              } finally {
                inFlightBlobKeys.delete(pending.localId);
              }
            }

            const stillPresentAfterWrite = snapshot.references.some(
              (item) => item.localId === pending.localId,
            );
            if (gen !== draftGeneration || !stillPresentAfterWrite) {
              releaseObjectUrl(pending.previewUrl);
              if (blobPersisted && blobStorage) void blobStorage.deleteBlob(pending.localId);
              continue;
            }
            if (isDuplicateNow()) {
              releaseObjectUrl(pending.previewUrl);
              if (blobPersisted && blobStorage) void blobStorage.deleteBlob(pending.localId);
              duplicateNames.push(pending.file.name);
              updateSnapshot((prev) => ({
                ...prev,
                references: prev.references.filter((item) => item.localId !== pending.localId),
              }));
              continue;
            }

            batchHashes.add(sha256);
            if (blobPersisted) {
              persistedBlobKeys.set(pending.localId, pending.localId);
            }
            updateSnapshot((prev) => ({
              ...prev,
              references: prev.references.map((item) =>
                item.localId === pending.localId
                  ? { ...item, sha256, bytesBase64, status: "ready" }
                  : item,
              ),
            }));
            persistDraftMetadata();
          } catch {
            if (gen !== draftGeneration) {
              releaseObjectUrl(pending.previewUrl);
              continue;
            }
            updateSnapshot((prev) => ({
              ...prev,
              references: prev.references.map((item) =>
                item.localId === pending.localId
                  ? { ...item, status: "error", error: "图片读取失败，请重新上传" }
                  : item,
              ),
            }));
          }
        }
        if (gen === draftGeneration && duplicateNames.length > 0) {
          updateSnapshot((prev) => ({
            ...prev,
            refNotice: `已去重忽略重复参考图：${duplicateNames.join("、")}`,
          }));
        }
      })();
    },

    removeReference(localId: string): void {
      const target = snapshot.references.find((item) => item.localId === localId);
      if (target?.previewUrl) releaseObjectUrl(target.previewUrl);
      const blobKey = persistedBlobKeys.get(localId);
      hydratingRefBlobKeys.delete(localId);
      persistedBlobKeys.delete(localId);
      updateSnapshot((prev) => ({
        ...prev,
        refNotice: "",
        references: prev.references.filter((item) => item.localId !== localId),
      }));
      persistDraftMetadata();
      if (blobKey && blobStorage) {
        void blobStorage.deleteBlob(blobKey);
      }
    },

    moveReference(fromIndex: number, toIndex: number): void {
      updateSnapshot((prev) => ({
        ...prev,
        references: reorderList(prev.references, fromIndex, toIndex),
      }));
      persistDraftMetadata();
    },

    updateReferenceRemark(localId: string, remark: string): void {
      updateSnapshot((prev) => ({
        ...prev,
        references: prev.references.map((item) =>
          item.localId === localId ? { ...item, remark } : item,
        ),
      }));
      persistDraftMetadata();
    },

    addProductFiles(files: File[]): void {
      if (!files.length) return;
      const remaining = REPLICA_MAX_PRODUCTS - snapshot.products.length;
      if (remaining <= 0) {
        updateSnapshot((prev) => ({
          ...prev,
          productNotice: `最多添加 ${REPLICA_MAX_PRODUCTS} 张产品原图。`,
        }));
        return;
      }

      const acceptedFiles = files.slice(0, remaining);
      const overflowNotice =
        files.length > remaining
          ? `最多添加 ${REPLICA_MAX_PRODUCTS} 张产品原图，超出部分已忽略。`
          : "";

      const pendingItems: Array<{ localId: string; file: File; previewUrl: string }> = [];
      const newDrafts: ReplicaProductDraft[] = [];

      for (const file of acceptedFiles) {
        const localId = nextLocalId("prod");
        const error = validateImageFile(file);
        if (error) {
          newDrafts.push({
            localId,
            sourceKind: "upload",
            filename: file.name,
            mimeType: file.type,
            previewUrl: "",
            bytesBase64: "",
            sha256: "",
            status: "error",
            error,
          });
          continue;
        }
        const previewUrl = trackObjectUrl(createUrl(file));
        newDrafts.push({
          localId,
          sourceKind: "upload",
          filename: file.name,
          mimeType: file.type,
          previewUrl,
          bytesBase64: "",
          sha256: "",
          status: "reading",
        });
        pendingItems.push({ localId, file, previewUrl });
      }

      const gen = draftGeneration;
      updateSnapshot((prev) => ({
        ...prev,
        productNotice: overflowNotice,
        products: [...prev.products, ...newDrafts],
      }));

      void (async () => {
        const duplicateNames: string[] = [];
        const batchHashes = new Set<string>();
        for (const pending of pendingItems) {
          if (gen !== draftGeneration) {
            releaseObjectUrl(pending.previewUrl);
            continue;
          }
          try {
            const buffer = await pending.file.arrayBuffer();
            const [sha256, bytesBase64] = await Promise.all([
              computeSha256Hex(buffer),
              Promise.resolve(arrayBufferToBase64(buffer)),
            ]);
            if (gen !== draftGeneration) {
              releaseObjectUrl(pending.previewUrl);
              continue;
            }
            const stillPresent = snapshot.products.some(
              (item) => item.localId === pending.localId,
            );
            if (!stillPresent) {
              releaseObjectUrl(pending.previewUrl);
              continue;
            }
            const isDuplicateNow = () =>
              batchHashes.has(sha256) ||
              snapshot.products.some(
                (item) =>
                  item.sourceKind === "upload" &&
                  item.localId !== pending.localId &&
                  (item.status === "ready" || hydratingProductBlobKeys.has(item.localId)) &&
                  item.sha256 === sha256,
              );

            if (isDuplicateNow()) {
              releaseObjectUrl(pending.previewUrl);
              duplicateNames.push(pending.file.name);
              updateSnapshot((prev) => ({
                ...prev,
                products: prev.products.filter((item) => item.localId !== pending.localId),
              }));
              continue;
            }

            let blobPersisted = false;
            if (blobStorage) {
              inFlightBlobKeys.add(pending.localId);
              try {
                const blob = new Blob([buffer], { type: pending.file.type });
                blobPersisted = await blobStorage.putBlob(pending.localId, blob);
              } catch {
                blobPersisted = false;
              } finally {
                inFlightBlobKeys.delete(pending.localId);
              }
            }

            const stillPresentAfterWrite = snapshot.products.some(
              (item) => item.localId === pending.localId,
            );
            if (gen !== draftGeneration || !stillPresentAfterWrite) {
              releaseObjectUrl(pending.previewUrl);
              if (blobPersisted && blobStorage) void blobStorage.deleteBlob(pending.localId);
              continue;
            }
            if (isDuplicateNow()) {
              releaseObjectUrl(pending.previewUrl);
              if (blobPersisted && blobStorage) void blobStorage.deleteBlob(pending.localId);
              duplicateNames.push(pending.file.name);
              updateSnapshot((prev) => ({
                ...prev,
                products: prev.products.filter((item) => item.localId !== pending.localId),
              }));
              continue;
            }

            batchHashes.add(sha256);
            if (blobPersisted) {
              persistedBlobKeys.set(pending.localId, pending.localId);
            }
            updateSnapshot((prev) => ({
              ...prev,
              products: prev.products.map((item) =>
                item.localId === pending.localId && item.sourceKind === "upload"
                  ? { ...item, sha256, bytesBase64, status: "ready" }
                  : item,
              ),
            }));
            persistDraftMetadata();
          } catch {
            if (gen !== draftGeneration) {
              releaseObjectUrl(pending.previewUrl);
              continue;
            }
            updateSnapshot((prev) => ({
              ...prev,
              products: prev.products.map((item) =>
                item.localId === pending.localId && item.sourceKind === "upload"
                  ? { ...item, status: "error", error: "图片读取失败" }
                  : item,
              ),
            }));
          }
        }
        if (gen === draftGeneration && duplicateNames.length > 0) {
          updateSnapshot((prev) => ({
            ...prev,
            productNotice: `已忽略重复上传的产品图：${duplicateNames.join("、")}`,
          }));
        }
      })();
    },

    removeProduct(localId: string): void {
      const target = snapshot.products.find((item) => item.localId === localId);
      if (target?.previewUrl) {
        releaseObjectUrl(target.previewUrl);
      }
      const blobKey = persistedBlobKeys.get(localId);
      hydratingProductBlobKeys.delete(localId);
      persistedBlobKeys.delete(localId);
      updateSnapshot((prev) => ({
        ...prev,
        productNotice: "",
        products: prev.products.filter((item) => item.localId !== localId),
      }));
      persistDraftMetadata();
      if (blobKey && blobStorage) {
        void blobStorage.deleteBlob(blobKey);
      }
    },

    moveProduct(fromIndex: number, toIndex: number): void {
      updateSnapshot((prev) => ({
        ...prev,
        products: reorderList(prev.products, fromIndex, toIndex),
      }));
      persistDraftMetadata();
    },

    updateConfig(patch: Partial<ReplicaConfigDraft>): void {
      const nextConfig: ReplicaConfigDraft = { ...snapshot.config, ...patch };
      updateSnapshot((prev) => ({
        ...prev,
        config: nextConfig,
      }));
      persistDraftMetadata();
    },

    clearDraft(): void {
      draftGeneration += 1;
      hydratingRefBlobKeys.clear();
      hydratingProductBlobKeys.clear();
      persistedBlobKeys.clear();
      revokeAllObjectUrls();
      clearPersistedDraftMetadata();
      if (blobStorage) {
        void blobStorage.clearBlobs();
      }
      updateSnapshot(() => ({
        references: [],
        products: [],
        config: { ...INITIAL_REPLICA_CONFIG },
        refNotice: "",
        productNotice: "",
      }));
    },
  };
}

export const replicaDraftStore = createReplicaDraftStore();
