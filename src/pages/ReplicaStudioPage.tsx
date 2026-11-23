import { useCallback, useEffect, useRef, useState } from "react";
import { defaultImageOptions } from "../../shared/model-settings";
import { modelSettingsApi } from "../api/client";
import { AppShell } from "../components/AppShell";
import {
  GenerationHistoryDrawer,
  type GenerationHistoryFeedItem,
} from "../components/generation-history/GenerationHistoryDrawer";
import type { ProductResourceSelection } from "../components/resource-picker";
import { currentImageOptions, message } from "../components/suite-studio/studio";
import { CreateToolsNav } from "../features/create/CreateToolsNav";
import { ReplicaBatchPreview } from "../features/replica/ReplicaBatchPreview";
import { ReplicaConfigPanel } from "../features/replica/ReplicaConfigPanel";
import { ReplicaEmptyState } from "../features/replica/ReplicaEmptyState";
import {
  allowedReplicaSizes,
  arrayBufferToBase64,
  computeSha256Hex,
  defaultReplicaSize,
  getReplicaSubmitState,
  INITIAL_REPLICA_CONFIG,
  REPLICA_CLONE_LEVEL_LABELS,
  REPLICA_MAX_PRODUCTS,
  REPLICA_MAX_REFERENCES,
  REPLICA_SCENE_LABELS,
  replicaApi,
  validateImageFile,
  type ReplicaCloneLevel,
  type ReplicaConfigDraft,
  type ReplicaProductDraft,
  type ReplicaReferenceDraft,
  type ReplicaSceneType,
  type ReplicaStudioState,
} from "../features/replica/replica-types";
import "../components/suite-studio/studio.css";
import "../features/replica/replica-studio.css";

const POLL_INTERVAL_MS = 2500;

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

export function ReplicaStudioPage({
  suiteId,
  navigate,
}: {
  suiteId?: string;
  navigate: (path: string, options?: { replace?: boolean }) => void;
}) {
  const [imageOptions, setImageOptions] = useState(() => defaultImageOptions(""));
  const [references, setReferences] = useState<ReplicaReferenceDraft[]>([]);
  const [products, setProducts] = useState<ReplicaProductDraft[]>([]);
  const [config, setConfig] = useState<ReplicaConfigDraft>(INITIAL_REPLICA_CONFIG);
  const [refNotice, setRefNotice] = useState("");
  const [productNotice, setProductNotice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [pageNotice, setPageNotice] = useState("");

  const [currentState, setCurrentState] = useState<ReplicaStudioState | null>(null);
  const [loadingBatch, setLoadingBatch] = useState(Boolean(suiteId));
  const [batchError, setBatchError] = useState("");
  const [reloadTick, setReloadTick] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);

  const objectUrlsRef = useRef<Set<string>>(new Set());
  const requestSeqRef = useRef(0);
  const appliedSeqRef = useRef(0);
  const currentSuiteIdRef = useRef<string | undefined>(suiteId);
  const referencesRef = useRef(references);
  const productsRef = useRef(products);

  referencesRef.current = references;
  productsRef.current = products;
  currentSuiteIdRef.current = suiteId;

  const trackObjectUrl = useCallback((url: string) => {
    if (url.startsWith("blob:")) objectUrlsRef.current.add(url);
    return url;
  }, []);

  const revokeObjectUrl = useCallback((url: string) => {
    if (!url || !url.startsWith("blob:")) return;
    if (objectUrlsRef.current.has(url)) {
      URL.revokeObjectURL(url);
      objectUrlsRef.current.delete(url);
    }
  }, []);

  useEffect(() => {
    const previous = document.title;
    document.title = "爆品图复刻 · PicAgent";
    return () => {
      document.title = previous;
      for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
      objectUrlsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    let live = true;
    modelSettingsApi
      .get()
      .then((settings) => {
        if (live) setImageOptions(currentImageOptions(settings));
      })
      .catch((error) => {
        if (live) setPageNotice(message(error));
      });
    return () => {
      live = false;
    };
  }, []);

  const sizes = allowedReplicaSizes(imageOptions);
  const effectiveConfig: ReplicaConfigDraft = {
    ...config,
    size: sizes.includes(config.size) ? config.size : defaultReplicaSize(sizes),
    ratio:
      config.ratio === "reference" || imageOptions.aspectRatios.includes(config.ratio)
        ? config.ratio
        : "reference",
  };

  const applyState = useCallback((state: ReplicaStudioState | null, seq?: number) => {
    if (state === null) {
      const nextSeq = ++requestSeqRef.current;
      appliedSeqRef.current = nextSeq;
      setCurrentState(null);
      return;
    }
    const nextSeq = seq ?? ++requestSeqRef.current;
    if (nextSeq < appliedSeqRef.current) return;
    appliedSeqRef.current = nextSeq;
    setCurrentState(state);
  }, []);

  useEffect(() => {
    if (!suiteId) {
      applyState(null);
      setLoadingBatch(false);
      setBatchError("");
      return;
    }

    let live = true;
    setLoadingBatch(true);
    setBatchError("");
    const seq = ++requestSeqRef.current;

    void replicaApi
      .state(suiteId)
      .then((state) => {
        if (!live) return;
        applyState(state, seq);
      })
      .catch((error) => {
        if (!live) return;
        applyState(null);
        setBatchError(message(error));
      })
      .finally(() => {
        if (live) setLoadingBatch(false);
      });

    return () => {
      live = false;
    };
  }, [suiteId, reloadTick, applyState]);

  const pollingSuiteId =
    currentState &&
    currentState.suite.id === suiteId &&
    currentState.pipeline?.status === "running"
      ? currentState.suite.id
      : undefined;

  useEffect(() => {
    if (!pollingSuiteId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      const seq = ++requestSeqRef.current;
      try {
        const next = await replicaApi.state(pollingSuiteId!);
        if (!live || currentSuiteIdRef.current !== pollingSuiteId) return;
        applyState(next, seq);
        if (next.pipeline?.status === "running") {
          timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
        }
      } catch (error) {
        if (!live || currentSuiteIdRef.current !== pollingSuiteId) return;
        setPageNotice(message(error));
        timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      }
    }

    timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [pollingSuiteId, applyState]);

  const handleAddReferences = useCallback(
    (files: File[]) => {
      if (!files.length) return;
      setRefNotice("");

      const currentCount = referencesRef.current.length;
      const remaining = REPLICA_MAX_REFERENCES - currentCount;
      if (remaining <= 0) {
        setRefNotice(`最多上传 ${REPLICA_MAX_REFERENCES} 张参考图。`);
        return;
      }

      const acceptedFiles = files.slice(0, remaining);
      if (files.length > remaining) {
        setRefNotice(`最多上传 ${REPLICA_MAX_REFERENCES} 张参考图，超出部分已忽略。`);
      }

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

      setReferences((prev) => [...prev, ...newDrafts]);

      void (async () => {
        const duplicateNames: string[] = [];
        const batchHashes = new Set<string>();
        for (const pending of pendingItems) {
          try {
            const buffer = await pending.file.arrayBuffer();
            const [sha256, bytesBase64] = await Promise.all([
              computeSha256Hex(buffer),
              Promise.resolve(arrayBufferToBase64(buffer)),
            ]);
            const isDuplicate =
              batchHashes.has(sha256) ||
              referencesRef.current.some(
                (item) => item.localId !== pending.localId && item.status === "ready" && item.sha256 === sha256,
              );
            if (isDuplicate) {
              revokeObjectUrl(pending.previewUrl);
              duplicateNames.push(pending.file.name);
              setReferences((prev) => prev.filter((item) => item.localId !== pending.localId));
            } else {
              batchHashes.add(sha256);
              setReferences((prev) =>
                prev.map((item) =>
                  item.localId === pending.localId
                    ? { ...item, sha256, bytesBase64, status: "ready" }
                    : item,
                ),
              );
            }
          } catch {
            setReferences((prev) =>
              prev.map((item) =>
                item.localId === pending.localId
                  ? { ...item, status: "error", error: "图片读取失败，请重新上传" }
                  : item,
              ),
            );
          }
        }
        if (duplicateNames.length > 0) {
          setRefNotice(`已去重忽略重复参考图：${duplicateNames.join("、")}`);
        }
      })();
    },
    [trackObjectUrl, revokeObjectUrl],
  );

  const handleRemoveReference = useCallback(
    (localId: string) => {
      setReferences((prev) => {
        const target = prev.find((item) => item.localId === localId);
        if (target?.previewUrl) revokeObjectUrl(target.previewUrl);
        return prev.filter((item) => item.localId !== localId);
      });
      setRefNotice("");
    },
    [revokeObjectUrl],
  );

  const handleMoveReference = useCallback((fromIndex: number, toIndex: number) => {
    setReferences((prev) => reorderList(prev, fromIndex, toIndex));
  }, []);

  const handleUpdateReferenceRemark = useCallback((localId: string, remark: string) => {
    setReferences((prev) =>
      prev.map((item) => (item.localId === localId ? { ...item, remark } : item)),
    );
  }, []);

  const handleAddProductFiles = useCallback(
    (files: File[]) => {
      if (!files.length) return;
      setProductNotice("");

      const remaining = REPLICA_MAX_PRODUCTS - productsRef.current.length;
      if (remaining <= 0) {
        setProductNotice(`最多添加 ${REPLICA_MAX_PRODUCTS} 张产品原图。`);
        return;
      }

      const acceptedFiles = files.slice(0, remaining);
      if (files.length > remaining) {
        setProductNotice(`最多添加 ${REPLICA_MAX_PRODUCTS} 张产品原图，超出部分已忽略。`);
      }

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

      setProducts((prev) => [...prev, ...newDrafts]);

      void (async () => {
        const duplicateNames: string[] = [];
        const batchHashes = new Set<string>();
        for (const pending of pendingItems) {
          try {
            const buffer = await pending.file.arrayBuffer();
            const [sha256, bytesBase64] = await Promise.all([
              computeSha256Hex(buffer),
              Promise.resolve(arrayBufferToBase64(buffer)),
            ]);
            const isDuplicate =
              batchHashes.has(sha256) ||
              productsRef.current.some(
                (item) =>
                  item.sourceKind === "upload" &&
                  item.localId !== pending.localId &&
                  item.status === "ready" &&
                  item.sha256 === sha256,
              );
            if (isDuplicate) {
              revokeObjectUrl(pending.previewUrl);
              duplicateNames.push(pending.file.name);
              setProducts((prev) => prev.filter((item) => item.localId !== pending.localId));
            } else {
              batchHashes.add(sha256);
              setProducts((prev) =>
                prev.map((item) =>
                  item.localId === pending.localId && item.sourceKind === "upload"
                    ? { ...item, sha256, bytesBase64, status: "ready" }
                    : item,
                ),
              );
            }
          } catch {
            setProducts((prev) =>
              prev.map((item) =>
                item.localId === pending.localId && item.sourceKind === "upload"
                  ? { ...item, status: "error", error: "图片读取失败" }
                  : item,
              ),
            );
          }
        }
        if (duplicateNames.length > 0) {
          setProductNotice(`已忽略重复上传的产品图：${duplicateNames.join("、")}`);
        }
      })();
    },
    [trackObjectUrl, revokeObjectUrl],
  );

  const handleApplyLibraryProducts = useCallback((selected: ProductResourceSelection[]) => {
    setProductNotice("");
    setProducts((prev) => {
      const localItems = prev.filter((item) => item.sourceKind === "upload");
      const maxLibrary = Math.max(0, REPLICA_MAX_PRODUCTS - localItems.length);
      const libraryItems: ReplicaProductDraft[] = selected.slice(0, maxLibrary).map((item) => ({
        localId: `lib-${item.resourceId}`,
        sourceKind: "library",
        libraryResourceId: item.resourceId,
        resourceVersionId: item.resourceVersionId,
        title: item.title ?? item.resourceId.slice(0, 8),
        previewUrl: item.previewUrl ?? `/api/library/resources/${encodeURIComponent(item.resourceId)}/preview`,
        resourceType: item.resourceType,
        status: "ready",
      }));
      return [...localItems, ...libraryItems];
    });
  }, []);

  const handleRemoveProduct = useCallback(
    (localId: string) => {
      setProducts((prev) => {
        const target = prev.find((item) => item.localId === localId);
        if (target?.sourceKind === "upload" && target.previewUrl) {
          revokeObjectUrl(target.previewUrl);
        }
        return prev.filter((item) => item.localId !== localId);
      });
      setProductNotice("");
    },
    [revokeObjectUrl],
  );

  const handleMoveProduct = useCallback((fromIndex: number, toIndex: number) => {
    setProducts((prev) => reorderList(prev, fromIndex, toIndex));
  }, []);

  const handleStartNew = useCallback(() => {
    applyState(null);
    setBatchError("");
    setPageNotice("");
    setLoadingBatch(false);
    if (suiteId || window.location.search) {
      navigate("/create/replica");
    }
  }, [applyState, navigate, suiteId]);

  const handleSelectHistory = useCallback(
    (id: string) => {
      setHistoryOpen(false);
      setBatchError("");
      if (id === suiteId) {
        setReloadTick((n) => n + 1);
        return;
      }
      navigate(`/create/replica?suite=${encodeURIComponent(id)}`);
    },
    [navigate, suiteId],
  );

  const handleSubmit = useCallback(async () => {
    const submitState = getReplicaSubmitState(references, products, effectiveConfig, submitting);
    if (!submitState.canSubmit) return;

    const validRefs = references.filter((item) => item.status === "ready");
    const validProducts = products.filter((item) => item.status === "ready");

    setSubmitting(true);
    setPageNotice("");
    setBatchError("");
    try {
      const result = await replicaApi.create({
        references: validRefs.map((item) => ({
          filename: item.filename,
          mimeType: item.mimeType,
          bytesBase64: item.bytesBase64,
          remark: item.remark.trim(),
        })),
        products: validProducts.map((item) =>
          item.sourceKind === "library"
            ? { libraryResourceId: item.libraryResourceId }
            : {
                filename: item.filename,
                mimeType: item.mimeType,
                bytesBase64: item.bytesBase64,
              },
        ),
        sceneType: effectiveConfig.sceneType,
        cloneLevel: effectiveConfig.cloneLevel,
        unifiedRequirement: effectiveConfig.unifiedRequirement.trim(),
        productInfo: effectiveConfig.productInfo.trim(),
        styleUnified: validRefs.length >= 2 ? effectiveConfig.styleUnified : false,
        language: effectiveConfig.language,
        ratio: effectiveConfig.ratio,
        size: effectiveConfig.size,
      });

      navigate(`/create/replica?suite=${encodeURIComponent(result.suiteId)}`);
      const seq = ++requestSeqRef.current;
      const latest = await replicaApi.state(result.suiteId);
      applyState(latest, seq);
    } catch (error) {
      setPageNotice(message(error));
    } finally {
      setSubmitting(false);
    }
  }, [references, products, effectiveConfig, submitting, navigate, applyState]);

  const renderHistoryMeta = useCallback((item: GenerationHistoryFeedItem) => {
    const cfg = item.pipeline?.config;
    const sceneCode = typeof cfg?.sceneType === "string" ? cfg.sceneType : "";
    const levelCode = typeof cfg?.cloneLevel === "string" ? cfg.cloneLevel : "";
    const sceneLabel =
      sceneCode && sceneCode in REPLICA_SCENE_LABELS
        ? REPLICA_SCENE_LABELS[sceneCode as ReplicaSceneType]
        : "";
    const levelLabel =
      levelCode && levelCode in REPLICA_CLONE_LEVEL_LABELS
        ? REPLICA_CLONE_LEVEL_LABELS[levelCode as ReplicaCloneLevel]
        : "";
    const text = [sceneLabel, levelLabel].filter(Boolean).join(" · ");
    return text ? <span className="gh-meta-tag">{text}</span> : null;
  }, []);

  const displayedSuiteId = currentState?.suite.id ?? suiteId;
  const isRunning = submitting || currentState?.pipeline?.status === "running";

  return (
    <AppShell
      activeNav="create"
      crumbs={[{ label: "创建", to: "/create/suite" }, { label: "爆品图复刻" }]}
      navigate={navigate}
      fullHeight
      className="ss-shell"
      statusText={isRunning ? "复刻进行中" : "工作台就绪"}
      statusTone={isRunning ? "running" : "pass"}
    >
      <div className="ss-layout">
        <CreateToolsNav activeTool="replica" navigate={navigate} />
        <ReplicaConfigPanel
          references={references}
          products={products}
          config={effectiveConfig}
          imageOptions={imageOptions}
          submitting={submitting}
          refNotice={refNotice}
          productNotice={productNotice}
          onAddReferences={handleAddReferences}
          onRemoveReference={handleRemoveReference}
          onMoveReference={handleMoveReference}
          onUpdateReferenceRemark={handleUpdateReferenceRemark}
          onAddProductFiles={handleAddProductFiles}
          onApplyLibraryProducts={handleApplyLibraryProducts}
          onRemoveProduct={handleRemoveProduct}
          onMoveProduct={handleMoveProduct}
          onUpdateConfig={(patch) => setConfig((prev) => ({ ...prev, ...patch }))}
          onSubmit={() => void handleSubmit()}
        />
        <main className="ss-results">
          <div className="ss-results-head">
            <div>
              <div className="ss-eyebrow">WORKSPACE / REPLICA RESULTS</div>
              <h2>复刻结果</h2>
            </div>
            <div className="ss-results-actions">
              <button type="button" onClick={() => setHistoryOpen(true)}>
                生成记录
              </button>
              {(suiteId || currentState) && (
                <button type="button" disabled={submitting} onClick={handleStartNew}>
                  ＋ 新建复刻
                </button>
              )}
            </div>
          </div>

          {pageNotice && (
            <div className="ss-note" role="alert">
              {pageNotice}
              <button type="button" onClick={() => setPageNotice("")} aria-label="关闭提示">
                ×
              </button>
            </div>
          )}

          {!currentState &&
            (loadingBatch ? (
              <p role="status">正在读取复刻批次…</p>
            ) : batchError ? (
              <div className="ss-batch-error" data-batch-error>
                <p>{batchError}</p>
                <button
                  type="button"
                  onClick={() => {
                    setBatchError("");
                    setReloadTick((n) => n + 1);
                  }}
                >
                  重试加载
                </button>
              </div>
            ) : (
              <ReplicaEmptyState />
            ))}

          {currentState && <ReplicaBatchPreview state={currentState} />}
        </main>
      </div>

      <GenerationHistoryDrawer
        origin="replica"
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onSelect={handleSelectHistory}
        currentSuiteId={displayedSuiteId}
        renderMeta={renderHistoryMeta}
      />
    </AppShell>
  );
}
