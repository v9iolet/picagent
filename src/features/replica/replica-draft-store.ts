import type { ProductResourceSelection } from "../../components/resource-picker";
import {
  arrayBufferToBase64,
  computeSha256Hex,
  INITIAL_REPLICA_CONFIG,
  REPLICA_CLONE_LEVEL_LABELS,
  REPLICA_LANGUAGE_OPTIONS,
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

export interface ReplicaDraftSnapshot {
  references: ReplicaReferenceDraft[];
  products: ReplicaProductDraft[];
  config: ReplicaConfigDraft;
  refNotice: string;
  productNotice: string;
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

function sanitizeConfigDraft(raw: unknown): ReplicaConfigDraft {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...INITIAL_REPLICA_CONFIG };
  }
  const data = raw as Record<string, unknown>;
  const sceneType: ReplicaSceneType =
    typeof data.sceneType === "string" && Object.prototype.hasOwnProperty.call(REPLICA_SCENE_LABELS, data.sceneType)
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

  return {
    sceneType,
    cloneLevel,
    unifiedRequirement:
      typeof data.unifiedRequirement === "string"
        ? data.unifiedRequirement
        : INITIAL_REPLICA_CONFIG.unifiedRequirement,
    productInfo:
      typeof data.productInfo === "string" ? data.productInfo : INITIAL_REPLICA_CONFIG.productInfo,
    styleUnified:
      typeof data.styleUnified === "boolean" ? data.styleUnified : INITIAL_REPLICA_CONFIG.styleUnified,
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

function readStoredConfigDraft(): ReplicaConfigDraft {
  if (typeof window === "undefined") return { ...INITIAL_REPLICA_CONFIG };
  try {
    const raw = window.sessionStorage.getItem(REPLICA_DRAFT_CONFIG_STORAGE_KEY);
    if (!raw) return { ...INITIAL_REPLICA_CONFIG };
    return sanitizeConfigDraft(JSON.parse(raw));
  } catch {
    return { ...INITIAL_REPLICA_CONFIG };
  }
}

function saveStoredConfigDraft(config: ReplicaConfigDraft): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(REPLICA_DRAFT_CONFIG_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Ignore storage quota or privacy-mode errors.
  }
}

function clearStoredConfigDraft(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(REPLICA_DRAFT_CONFIG_STORAGE_KEY);
  } catch {
    // Ignore storage errors.
  }
}

let localSeq = 0;
function nextLocalId(prefix: string): string {
  localSeq += 1;
  return `${prefix}-${Date.now()}-${localSeq}`;
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

const objectUrls = new Set<string>();
const listeners = new Set<() => void>();
let draftGeneration = 0;

let snapshot: ReplicaDraftSnapshot = {
  references: [],
  products: [],
  config: readStoredConfigDraft(),
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

function revokeObjectUrl(url: string): void {
  if (!url || !url.startsWith("blob:")) return;
  if (objectUrls.has(url)) {
    URL.revokeObjectURL(url);
    objectUrls.delete(url);
  }
}

function revokeAllObjectUrls(): void {
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls.clear();
}

export const replicaDraftStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  getSnapshot(): ReplicaDraftSnapshot {
    return snapshot;
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
      const previewUrl = trackObjectUrl(URL.createObjectURL(file));
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
          revokeObjectUrl(pending.previewUrl);
          continue;
        }
        try {
          const buffer = await pending.file.arrayBuffer();
          const [sha256, bytesBase64] = await Promise.all([
            computeSha256Hex(buffer),
            Promise.resolve(arrayBufferToBase64(buffer)),
          ]);
          if (gen !== draftGeneration) {
            revokeObjectUrl(pending.previewUrl);
            continue;
          }
          const stillPresent = snapshot.references.some((item) => item.localId === pending.localId);
          if (!stillPresent) {
            revokeObjectUrl(pending.previewUrl);
            continue;
          }
          const isDuplicate =
            batchHashes.has(sha256) ||
            snapshot.references.some(
              (item) =>
                item.localId !== pending.localId && item.status === "ready" && item.sha256 === sha256,
            );
          if (isDuplicate) {
            revokeObjectUrl(pending.previewUrl);
            duplicateNames.push(pending.file.name);
            updateSnapshot((prev) => ({
              ...prev,
              references: prev.references.filter((item) => item.localId !== pending.localId),
            }));
          } else {
            batchHashes.add(sha256);
            updateSnapshot((prev) => ({
              ...prev,
              references: prev.references.map((item) =>
                item.localId === pending.localId
                  ? { ...item, sha256, bytesBase64, status: "ready" }
                  : item,
              ),
            }));
          }
        } catch {
          if (gen !== draftGeneration) {
            revokeObjectUrl(pending.previewUrl);
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
    if (target?.previewUrl) revokeObjectUrl(target.previewUrl);
    updateSnapshot((prev) => ({
      ...prev,
      refNotice: "",
      references: prev.references.filter((item) => item.localId !== localId),
    }));
  },

  moveReference(fromIndex: number, toIndex: number): void {
    updateSnapshot((prev) => ({
      ...prev,
      references: reorderList(prev.references, fromIndex, toIndex),
    }));
  },

  updateReferenceRemark(localId: string, remark: string): void {
    updateSnapshot((prev) => ({
      ...prev,
      references: prev.references.map((item) =>
        item.localId === localId ? { ...item, remark } : item,
      ),
    }));
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
      const previewUrl = trackObjectUrl(URL.createObjectURL(file));
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
          revokeObjectUrl(pending.previewUrl);
          continue;
        }
        try {
          const buffer = await pending.file.arrayBuffer();
          const [sha256, bytesBase64] = await Promise.all([
            computeSha256Hex(buffer),
            Promise.resolve(arrayBufferToBase64(buffer)),
          ]);
          if (gen !== draftGeneration) {
            revokeObjectUrl(pending.previewUrl);
            continue;
          }
          const stillPresent = snapshot.products.some((item) => item.localId === pending.localId);
          if (!stillPresent) {
            revokeObjectUrl(pending.previewUrl);
            continue;
          }
          const isDuplicate =
            batchHashes.has(sha256) ||
            snapshot.products.some(
              (item) =>
                item.sourceKind === "upload" &&
                item.localId !== pending.localId &&
                item.status === "ready" &&
                item.sha256 === sha256,
            );
          if (isDuplicate) {
            revokeObjectUrl(pending.previewUrl);
            duplicateNames.push(pending.file.name);
            updateSnapshot((prev) => ({
              ...prev,
              products: prev.products.filter((item) => item.localId !== pending.localId),
            }));
          } else {
            batchHashes.add(sha256);
            updateSnapshot((prev) => ({
              ...prev,
              products: prev.products.map((item) =>
                item.localId === pending.localId && item.sourceKind === "upload"
                  ? { ...item, sha256, bytesBase64, status: "ready" }
                  : item,
              ),
            }));
          }
        } catch {
          if (gen !== draftGeneration) {
            revokeObjectUrl(pending.previewUrl);
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

  applyLibraryProducts(selected: ProductResourceSelection[]): void {
    updateSnapshot((prev) => {
      const selectedById = new Map(selected.map((item) => [item.resourceId, item]));
      const toDraft = (item: ProductResourceSelection): ReplicaProductDraft => ({
        localId: `lib-${item.resourceId}`,
        sourceKind: "library",
        libraryResourceId: item.resourceId,
        resourceVersionId: item.resourceVersionId,
        title: item.title ?? item.resourceId.slice(0, 8),
        previewUrl:
          item.previewUrl ?? `/api/library/resources/${encodeURIComponent(item.resourceId)}/preview`,
        resourceType: item.resourceType,
        status: "ready",
      });

      const kept: ReplicaProductDraft[] = [];
      const keptLibraryIds = new Set<string>();
      for (const item of prev.products) {
        if (item.sourceKind === "upload") {
          kept.push(item);
        } else if (selectedById.has(item.libraryResourceId)) {
          kept.push(toDraft(selectedById.get(item.libraryResourceId)!));
          keptLibraryIds.add(item.libraryResourceId);
        }
      }

      const added = selected
        .filter((item) => !keptLibraryIds.has(item.resourceId))
        .slice(0, Math.max(0, REPLICA_MAX_PRODUCTS - kept.length))
        .map(toDraft);

      return {
        ...prev,
        productNotice: "",
        products: [...kept, ...added],
      };
    });
  },

  removeProduct(localId: string): void {
    const target = snapshot.products.find((item) => item.localId === localId);
    if (target?.sourceKind === "upload" && target.previewUrl) {
      revokeObjectUrl(target.previewUrl);
    }
    updateSnapshot((prev) => ({
      ...prev,
      productNotice: "",
      products: prev.products.filter((item) => item.localId !== localId),
    }));
  },

  moveProduct(fromIndex: number, toIndex: number): void {
    updateSnapshot((prev) => ({
      ...prev,
      products: reorderList(prev.products, fromIndex, toIndex),
    }));
  },

  updateConfig(patch: Partial<ReplicaConfigDraft>): void {
    const nextConfig: ReplicaConfigDraft = { ...snapshot.config, ...patch };
    saveStoredConfigDraft(nextConfig);
    updateSnapshot((prev) => ({
      ...prev,
      config: nextConfig,
    }));
  },

  clearDraft(): void {
    draftGeneration += 1;
    revokeAllObjectUrls();
    clearStoredConfigDraft();
    updateSnapshot(() => ({
      references: [],
      products: [],
      config: { ...INITIAL_REPLICA_CONFIG },
      refNotice: "",
      productNotice: "",
    }));
  },
};
