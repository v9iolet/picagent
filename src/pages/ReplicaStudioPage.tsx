import { usePolling } from "../hooks/usePolling";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { defaultImageOptions } from "../../shared/model-settings";
import { productCardsApi } from "../api/client";
import { useModelSettings } from "../context/AppConfigContext";
import { AppShell } from "../components/AppShell";
import {
  GenerationHistoryDrawer,
  type GenerationHistoryFeedItem,
} from "../components/generation-history/GenerationHistoryDrawer";
import { toSelectedProductCardSummary } from "../components/product-card-picker/types";
import { currentImageOptions, message } from "../components/suite-studio/studio";
import { CreateToolsNav } from "../features/create/CreateToolsNav";
import { ReplicaBatchPreview } from "../features/replica/ReplicaBatchPreview";
import { ReplicaConfigPanel } from "../features/replica/ReplicaConfigPanel";
import { ReplicaEmptyState } from "../features/replica/ReplicaEmptyState";
import {
  clearLastReplicaSuiteId,
  readLastReplicaSuiteId,
  replicaDraftStore,
  saveLastReplicaSuiteId,
} from "../features/replica/replica-draft-store";
import {
  allowedReplicaSizes,
  defaultReplicaSize,
  getReplicaSubmitState,
  INITIAL_REPLICA_CONFIG,
  REPLICA_CLONE_LEVEL_LABELS,
  REPLICA_SCENE_LABELS,
  replicaApi,
  type ReplicaCloneLevel,
  type ReplicaConfigDraft,
  type ReplicaSceneType,
  type ReplicaStudioState,
} from "../features/replica/replica-types";
import "../components/suite-studio/studio.css";
import "../features/replica/replica-studio.css";

const POLL_INTERVAL_MS = 2500;

export function ReplicaStudioPage({
  suiteId,
  initialProductCardId,
  navigate,
}: {
  suiteId?: string;
  initialProductCardId?: string;
  navigate: (path: string, options?: { replace?: boolean }) => void;
}) {
  const draft = useSyncExternalStore(replicaDraftStore.subscribe, replicaDraftStore.getSnapshot);
  const { references, products, config, refNotice, productNotice } = draft;

  const { modelSettings, error: settingsError } = useModelSettings();
  const imageOptions = modelSettings ? currentImageOptions(modelSettings) : defaultImageOptions("");
  const [submitting, setSubmitting] = useState(false);
  const [pageNotice, setPageNotice] = useState("");

  const [currentState, setCurrentState] = useState<ReplicaStudioState | null>(null);
  const [loadingBatch, setLoadingBatch] = useState(() =>
    Boolean(suiteId || (!initialProductCardId && readLastReplicaSuiteId())),
  );
  const [batchError, setBatchError] = useState("");
  const [reloadTick, setReloadTick] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);

  const requestSeqRef = useRef(0);
  const appliedSeqRef = useRef(0);
  const cardLoadSeqRef = useRef(0);
  const loadedSuiteIdRef = useRef<string | undefined>(undefined);
  const lastReloadTickRef = useRef(reloadTick);
  const currentSuiteIdRef = useRef<string | undefined>(suiteId);
  const mountedRef = useRef(true);

  currentSuiteIdRef.current = suiteId;

  useEffect(() => {
    mountedRef.current = true;
    const previous = document.title;
    document.title = "爆品图复刻 · PicAgent";
    return () => {
      mountedRef.current = false;
      document.title = previous;
    };
  }, []);

  useEffect(() => {
    if (settingsError) setPageNotice(message(settingsError));
  }, [settingsError]);

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

  // Hydrate missing productCardSummary if localStorage only preserved productCardId.
  useEffect(() => {
    if (!config.productCardId || config.productCardSummary) return;
    let live = true;
    const targetCardId = config.productCardId;
    const seq = ++cardLoadSeqRef.current;
    void productCardsApi
      .get(targetCardId)
      .then((card) => {
        if (!live || seq !== cardLoadSeqRef.current) return;
        if (replicaDraftStore.getSnapshot().config.productCardId !== targetCardId) return;
        if (card.status !== "published") {
          replicaDraftStore.updateConfig({ productCardId: null, productCardSummary: null });
          setPageNotice(
            `已选商品信息卡「${card.name}」已归档，已自动清除绑定，请重新选择或手动填写。`,
          );
          return;
        }
        replicaDraftStore.updateConfig({
          productCardId: card.id,
          productCardSummary: toSelectedProductCardSummary(card),
        });
      })
      .catch(() => {
        if (!live || seq !== cardLoadSeqRef.current) return;
        if (replicaDraftStore.getSnapshot().config.productCardId !== targetCardId) return;
        replicaDraftStore.updateConfig({ productCardId: null, productCardSummary: null });
      });
    return () => {
      live = false;
    };
  }, [config.productCardId, config.productCardSummary]);

  useEffect(() => {
    // URL ?productCardId=<id> opens a blank replica view pre-bound to the published product card.
    if (!suiteId && initialProductCardId) {
      let live = true;
      const seq = ++cardLoadSeqRef.current;
      loadedSuiteIdRef.current = undefined;
      applyState(null);
      setLoadingBatch(false);
      setBatchError("");
      setPageNotice("");

      void productCardsApi
        .get(initialProductCardId)
        .then((card) => {
          if (!live || seq !== cardLoadSeqRef.current) return;
          if (card.status !== "published") {
            if (replicaDraftStore.getSnapshot().config.productCardId === initialProductCardId) {
              replicaDraftStore.updateConfig({ productCardId: null, productCardSummary: null });
            }
            setPageNotice(
              `商品信息卡「${card.name}」已归档，无法用于新建复刻，请重新选择或手动填写。`,
            );
            return;
          }
          replicaDraftStore.updateConfig({
            productCardId: card.id,
            productCardSummary: toSelectedProductCardSummary(card),
          });
        })
        .catch(() => {
          if (!live || seq !== cardLoadSeqRef.current) return;
          if (replicaDraftStore.getSnapshot().config.productCardId === initialProductCardId) {
            replicaDraftStore.updateConfig({ productCardId: null, productCardSummary: null });
          }
          setPageNotice("未找到指定的商品信息卡，请重新选择或手动填写。");
        });

      return () => {
        live = false;
      };
    }

    const savedId = suiteId ? null : readLastReplicaSuiteId();
    const targetId = suiteId ?? savedId ?? undefined;
    const isExplicitReload = reloadTick !== lastReloadTickRef.current;
    lastReloadTickRef.current = reloadTick;

    if (!targetId) {
      loadedSuiteIdRef.current = undefined;
      applyState(null);
      setLoadingBatch(false);
      setBatchError("");
      return;
    }

    if (!isExplicitReload && targetId === loadedSuiteIdRef.current) {
      if (!suiteId) {
        navigate(`/create/replica?suite=${encodeURIComponent(targetId)}`, { replace: true });
      }
      setLoadingBatch(false);
      return;
    }

    let live = true;
    setLoadingBatch(true);
    setBatchError("");
    const seq = ++requestSeqRef.current;

    void replicaApi
      .state(targetId)
      .then((state) => {
        if (!live || seq < appliedSeqRef.current) return;
        if (!suiteId && state.suite.origin !== "replica") {
          clearLastReplicaSuiteId();
          loadedSuiteIdRef.current = undefined;
          applyState(null);
          return;
        }
        loadedSuiteIdRef.current = state.suite.id;
        applyState(state, seq);
        if (state.suite.origin === "replica") {
          saveLastReplicaSuiteId(state.suite.id);
        }
        if (!suiteId) {
          navigate(`/create/replica?suite=${encodeURIComponent(state.suite.id)}`, { replace: true });
        }
      })
      .catch((error) => {
        if (!live || seq < appliedSeqRef.current) return;
        loadedSuiteIdRef.current = undefined;
        applyState(null);
        if (!suiteId) {
          clearLastReplicaSuiteId();
          setBatchError("");
        } else {
          if (readLastReplicaSuiteId() === suiteId) {
            clearLastReplicaSuiteId();
          }
          setBatchError(message(error));
        }
      })
      .finally(() => {
        if (live) setLoadingBatch(false);
      });

    return () => {
      live = false;
    };
  }, [suiteId, initialProductCardId, reloadTick, navigate, applyState]);

  const pollingSuiteId =
    currentState &&
    currentState.suite.id === suiteId &&
    currentState.pipeline?.status === "running"
      ? currentState.suite.id
      : undefined;

  usePolling(async signal => {
    if (!pollingSuiteId) return;
    const seq = ++requestSeqRef.current;
    const next = await replicaApi.state(pollingSuiteId, signal);
    if (signal.aborted || currentSuiteIdRef.current !== pollingSuiteId) return;
    applyState(next, seq);
  }, {
    enabled: Boolean(pollingSuiteId),
    intervalMs: POLL_INTERVAL_MS,
    onError: error => {
      if (currentSuiteIdRef.current === pollingSuiteId) setPageNotice(message(error));
    },
  }, [pollingSuiteId]);

  const handleAddReferences = useCallback((files: File[]) => {
    replicaDraftStore.addReferences(files);
  }, []);

  const handleRemoveReference = useCallback((localId: string) => {
    replicaDraftStore.removeReference(localId);
  }, []);

  const handleMoveReference = useCallback((fromIndex: number, toIndex: number) => {
    replicaDraftStore.moveReference(fromIndex, toIndex);
  }, []);

  const handleUpdateReferenceRemark = useCallback((localId: string, remark: string) => {
    replicaDraftStore.updateReferenceRemark(localId, remark);
  }, []);

  const handleAddProductFiles = useCallback((files: File[]) => {
    replicaDraftStore.addProductFiles(files);
  }, []);

  const handleRemoveProduct = useCallback((localId: string) => {
    replicaDraftStore.removeProduct(localId);
  }, []);

  const handleMoveProduct = useCallback((fromIndex: number, toIndex: number) => {
    replicaDraftStore.moveProduct(fromIndex, toIndex);
  }, []);

  const handleUpdateConfig = useCallback((patch: Partial<ReplicaConfigDraft>) => {
    if ("productCardId" in patch) {
      cardLoadSeqRef.current += 1;
    }
    replicaDraftStore.updateConfig(patch);
  }, []);

  const refresh = useCallback(
    async (id: string, signal?: AbortSignal) => {
      const seq = ++requestSeqRef.current;
      const next = await replicaApi.state(id, signal);
      if (signal?.aborted) return;
      if (currentSuiteIdRef.current && currentSuiteIdRef.current !== id) return;
      applyState(next, seq);
    },
    [applyState],
  );

  const handleStartNew = useCallback(() => {
    clearLastReplicaSuiteId();
    cardLoadSeqRef.current += 1;
    replicaDraftStore.clearDraft();
    loadedSuiteIdRef.current = undefined;
    applyState(null);
    setBatchError("");
    setPageNotice("");
    setLoadingBatch(false);
    if (suiteId || initialProductCardId || window.location.search) {
      navigate("/create/replica");
    }
  }, [applyState, initialProductCardId, navigate, suiteId]);

  const handleBatchDeleted = useCallback(
    (deletedId: string) => {
      if (readLastReplicaSuiteId() === deletedId || suiteId === deletedId) {
        clearLastReplicaSuiteId();
      }
      loadedSuiteIdRef.current = undefined;
      applyState(null);
      setBatchError("");
      setLoadingBatch(false);
      setPageNotice("已删除复刻批次。");
      if (suiteId === deletedId || window.location.search) {
        navigate("/create/replica");
      }
    },
    [applyState, navigate, suiteId],
  );

  const handleSelectHistory = useCallback(
    (id: string) => {
      setHistoryOpen(false);
      setBatchError("");
      saveLastReplicaSuiteId(id);
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
    const readyProducts = products.filter((item) => item.status === "ready");

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
        products: readyProducts.map((item) => ({
          filename: item.filename,
          mimeType: item.mimeType,
          bytesBase64: item.bytesBase64,
        })),
        sceneType: effectiveConfig.sceneType,
        cloneLevel: effectiveConfig.cloneLevel,
        unifiedRequirement: effectiveConfig.unifiedRequirement.trim(),
        productInfo: effectiveConfig.productInfo.trim(),
        ...(effectiveConfig.productCardId ? { productCardId: effectiveConfig.productCardId } : {}),
        styleUnified: validRefs.length >= 2 ? effectiveConfig.styleUnified : false,
        language: effectiveConfig.language,
        ratio: effectiveConfig.ratio,
        size: effectiveConfig.size,
      });

      replicaDraftStore.clearDraft();
      saveLastReplicaSuiteId(result.suiteId);
      loadedSuiteIdRef.current = undefined;

      const stillOnReplicaPage =
        mountedRef.current && /^\/create\/replica\/?$/.test(window.location.pathname);
      if (!stillOnReplicaPage) return;

      if (result.suiteId === suiteId) {
        setReloadTick((n) => n + 1);
      } else {
        navigate(`/create/replica?suite=${encodeURIComponent(result.suiteId)}`);
      }
    } catch (error) {
      if (mountedRef.current) setPageNotice(message(error));
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }, [references, products, effectiveConfig, submitting, suiteId, navigate]);

  const renderHistoryMeta = useCallback((item: GenerationHistoryFeedItem) => {
    const cfg = item.pipeline?.config;
    const sceneCode = typeof cfg?.sceneType === "string" ? cfg.sceneType : "";
    const levelCode = typeof cfg?.cloneLevel === "string" ? cfg.cloneLevel : "";
    const sceneLabel =
      sceneCode && Object.prototype.hasOwnProperty.call(REPLICA_SCENE_LABELS, sceneCode)
        ? REPLICA_SCENE_LABELS[sceneCode as ReplicaSceneType]
        : "";
    const levelLabel =
      levelCode && Object.prototype.hasOwnProperty.call(REPLICA_CLONE_LEVEL_LABELS, levelCode)
        ? REPLICA_CLONE_LEVEL_LABELS[levelCode as ReplicaCloneLevel]
        : "";
    const text = [sceneLabel, levelLabel].filter(Boolean).join(" · ");
    return text ? <span className="gh-meta-tag">{text}</span> : null;
  }, []);

  const displayedSuiteId = currentState?.suite.id ?? suiteId;
  const isRunning = submitting || currentState?.pipeline?.status === "running";
  const configDirty =
    references.length > 0 ||
    products.length > 0 ||
    config.sceneType !== INITIAL_REPLICA_CONFIG.sceneType ||
    config.cloneLevel !== INITIAL_REPLICA_CONFIG.cloneLevel ||
    config.unifiedRequirement !== INITIAL_REPLICA_CONFIG.unifiedRequirement ||
    config.productInfo !== INITIAL_REPLICA_CONFIG.productInfo ||
    config.productCardId !== INITIAL_REPLICA_CONFIG.productCardId ||
    config.styleUnified !== INITIAL_REPLICA_CONFIG.styleUnified ||
    config.language !== INITIAL_REPLICA_CONFIG.language ||
    config.ratio !== INITIAL_REPLICA_CONFIG.ratio ||
    config.size !== INITIAL_REPLICA_CONFIG.size;

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
          onRemoveProduct={handleRemoveProduct}
          onMoveProduct={handleMoveProduct}
          onUpdateConfig={handleUpdateConfig}
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
              {(suiteId || currentState || configDirty) && (
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

          {currentState && (
            <ReplicaBatchPreview
              key={currentState.suite.id}
              state={currentState}
              refresh={refresh}
              onDelete={handleBatchDeleted}
              navigate={navigate}
            />
          )}
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
