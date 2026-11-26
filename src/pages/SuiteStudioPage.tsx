import { usePolling } from "../hooks/usePolling";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  modelSettingsApi,
  productCardsApi,
  suiteApi,
  type ApiImage,
  type ApiPlatformProfile,
} from "../api/client";
import { defaultImageOptions } from "../../shared/model-settings";
import { productNameFor } from "../../shared/product-name";
import { AppShell } from "../components/AppShell";
import {
  GenerationHistoryDrawer,
  type GenerationHistoryFeedItem,
} from "../components/generation-history/GenerationHistoryDrawer";
import { toSelectedProductCardSummary } from "../components/product-card-picker/types";
import { CreateToolsNav } from "../features/create/CreateToolsNav";
import { ConfigPanel } from "../components/suite-studio/ConfigPanel";
import { BatchResults } from "../components/suite-studio/BatchResults";
import { SuiteEmptyState } from "../components/suite-studio/SuiteEmptyState";
import {
  isConfigDirty,
  saveLastSuiteId,
  suiteWorkspaceStore,
} from "../components/suite-studio/suite-draft-store";
import {
  currentImageOptions,
  fromRun,
  initialConfig,
  message,
  studioApi,
  type Config,
  type StudioState,
} from "../components/suite-studio/studio";
import "../components/suite-studio/studio.css";

const POLL_INTERVAL_MS = 2500;

function isBatchPolling(state: StudioState): boolean {
  return state.pipeline?.status === "running" || state.listingCopy?.status === "running" ||
    state.cards.some((card) => card.taskStatus === "generating");
}

function isActiveNonTerminalFeedItem(
  item: (GenerationHistoryFeedItem & { listingCopy?: { status?: string } | null }) | undefined,
): boolean {
  if (!item) return false;
  const status = item.pipeline?.status;
  return (
    status === "running" ||
    status === "waiting_base_refine_decision" ||
    status === "waiting_human_input" ||
    item.listingCopy?.status === "running"
  );
}

function readInitialWorkspace(suiteId?: string, initialProductCardId?: string) {
  if (!suiteId && initialProductCardId) {
    return {
      active: undefined as string | undefined,
      config: initialConfig,
      configDirty: false,
      images: [] as ApiImage[],
      clone: false,
      state: null as StudioState | null,
      loadingBatch: false,
    };
  }
  const snap = suiteWorkspaceStore.getSnapshot();
  const targetId = suiteId ?? snap.activeSuiteId ?? undefined;
  if (targetId) {
    const cached = suiteWorkspaceStore.getMemoryCache(targetId);
    const canReusePersistedConfig = Boolean(cached) || !snap.clone;
    const hasDraftForTarget =
      canReusePersistedConfig && snap.configSuiteId === targetId && snap.hasLocalConfigEdits;
    const restoredConfig = hasDraftForTarget
      ? snap.config
      : cached?.state
        ? fromRun(cached.state.pipeline)
        : canReusePersistedConfig && snap.configSuiteId === targetId
          ? snap.config
          : initialConfig;
    const restoredClone = cached?.state
      ? Boolean(cached.state.pipeline || cached.state.cards.length > 0)
      : snap.activeSuiteId === targetId
        ? snap.clone
        : false;
    return {
      active: targetId,
      config: restoredConfig,
      configDirty: hasDraftForTarget,
      images: cached?.images ?? [],
      clone: restoredClone,
      state: cached?.state ?? null,
      loadingBatch: !cached,
    };
  }
  const hasUnuploadedDraft =
    snap.activeSuiteId === null && (snap.hasLocalConfigEdits || isConfigDirty(snap.config));
  if (hasUnuploadedDraft) {
    return {
      active: undefined as string | undefined,
      config: snap.config,
      configDirty: true,
      images: [] as ApiImage[],
      clone: false,
      state: null as StudioState | null,
      loadingBatch: false,
    };
  }
  return {
    active: undefined as string | undefined,
    config: initialConfig,
    configDirty: false,
    images: [] as ApiImage[],
    clone: false,
    state: null as StudioState | null,
    loadingBatch: true,
  };
}

export function SuiteStudioPage({
  suiteId,
  initialProductCardId,
  navigate,
}: {
  suiteId?: string;
  initialProductCardId?: string;
  navigate: (path: string, options?: { replace?: boolean }) => void;
}) {
  const boot = useRef(readInitialWorkspace(suiteId, initialProductCardId));
  const [config, setConfig] = useState<Config>(() => boot.current.config),
    [configDirty, setConfigDirty] = useState<boolean>(() => boot.current.configDirty),
    [profiles, setProfiles] = useState<ApiPlatformProfile[]>([]),
    [options, setOptions] = useState(defaultImageOptions(""));
  const [images, setImages] = useState<ApiImage[]>(() => boot.current.images),
    [clone, setClone] = useState<boolean>(() => boot.current.clone),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const [currentState, setCurrentState] = useState<StudioState | null>(() => boot.current.state),
    [loadingBatch, setLoadingBatch] = useState<boolean>(() => boot.current.loadingBatch),
    [batchError, setBatchError] = useState(""),
    [reloadTick, setReloadTick] = useState(0),
    [historyOpen, setHistoryOpen] = useState(false),
    [active, setActive] = useState<string | undefined>(() => boot.current.active);

  const mountedRef = useRef(true),
    hydrated = useRef<string | undefined>(undefined),
    skipDefaultFeed = useRef(false),
    requestSeq = useRef(0),
    appliedSeq = useRef(0),
    cardCheckSeq = useRef(0),
    currentBatchIdRef = useRef<string | undefined>(boot.current.state?.suite.id),
    inFlightStates = useRef<Map<string, Promise<StudioState>>>(new Map());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchStudioState = useCallback((id: string) => {
    const existing = inFlightStates.current.get(id);
    if (existing) return existing;
    const pending = studioApi.state(id).finally(() => {
      if (inFlightStates.current.get(id) === pending) inFlightStates.current.delete(id);
    });
    inFlightStates.current.set(id, pending);
    return pending;
  }, []);

  const applyState = useCallback((state: StudioState | null, seq?: number) => {
    if (state === null) {
      const nextSeq = ++requestSeq.current;
      appliedSeq.current = nextSeq;
      currentBatchIdRef.current = undefined;
      setCurrentState(null);
      return;
    }
    const nextSeq = seq ?? ++requestSeq.current;
    if (nextSeq < appliedSeq.current) return;
    appliedSeq.current = nextSeq;
    currentBatchIdRef.current = state.suite.id;
    setCurrentState(state);
  }, []);

  const refresh = useCallback(
    async (id: string, signal?: AbortSignal) => {
      const seq = ++requestSeq.current;
      const next = await studioApi.state(id, signal);
      if (signal?.aborted) return;
      suiteWorkspaceStore.setMemoryCache({
        suiteId: next.suite.id,
        state: next,
        images: next.inputImages,
      });
      if (mountedRef.current) {
        applyState(next, seq);
      }
    },
    [applyState],
  );

  useEffect(() => {
    let live = true;
    Promise.all([suiteApi.listPlatforms(), modelSettingsApi.get()])
      .then(([p, m]) => {
        if (live) {
          setProfiles(p);
          setOptions(currentImageOptions(m));
        }
      })
      .catch((e) => {
        if (live) setNotice(message(e));
      });
    return () => {
      live = false;
    };
  }, []);

  const currentSuiteId = suiteId ?? active;

  const patch = (update: Partial<Config>) => {
    if ("productCardId" in update) {
      cardCheckSeq.current += 1;
    }
    setConfig((prev) => {
      const next = { ...prev, ...update };
      const targetSuiteId = currentSuiteId ?? null;
      suiteWorkspaceStore.updateConfig(next, {
        suiteId: targetSuiteId,
        markDirty: true,
        clone: targetSuiteId ? clone : false,
      });
      return next;
    });
    setConfigDirty(true);
  };

  // Options are model-specific; never submit a stale size/ratio restored from another channel.
  const effective: Config = {
    ...config,
    platform: config.platform || profiles.find((p) => p.name === "Amazon")?.code || profiles[0]?.code || "",
    size: options.sizes.includes(config.size) ? config.size : options.sizes[0],
    aspectRatio: options.aspectRatios.includes(config.aspectRatio)
      ? config.aspectRatio
      : options.aspectRatios[0],
  };

  const verifyBoundCardForEditing = useCallback(
    (cardId: string, fallbackName: string, mode: "hydrate" | "edit") => {
      const checkSeq = ++cardCheckSeq.current;
      void productCardsApi
        .get(cardId)
        .then((card) => {
          if (!mountedRef.current || checkSeq !== cardCheckSeq.current) return;
          if (card.status === "published") {
            const summary = toSelectedProductCardSummary(card);
            setConfig((prev) => {
              if (prev.productCardId !== cardId) return prev;
              const next = { ...prev, productCardSummary: summary };
              const snap = suiteWorkspaceStore.getSnapshot();
              if (snap.config.productCardId === cardId) {
                suiteWorkspaceStore.updateConfig(next, {
                  suiteId: snap.activeSuiteId,
                  markDirty: false,
                  clone: snap.clone,
                });
              }
              return next;
            });
            if (mode === "edit") {
              setNotice("已载入同款配置，生成后将创建新批次。");
            }
            return;
          }
          setConfig((prev) => {
            if (prev.productCardId !== cardId) return prev;
            const next = { ...prev, productCardId: null, productCardSummary: null };
            const snap = suiteWorkspaceStore.getSnapshot();
            if (snap.config.productCardId === cardId) {
              suiteWorkspaceStore.updateConfig(next, {
                suiteId: snap.activeSuiteId,
                markDirty: false,
                clone: snap.clone,
              });
            }
            return next;
          });
          setNotice(
            `原关联商品信息卡「${card.name || fallbackName || cardId}」已归档，已自动清空左侧绑定，请重新选择在用商品卡或手动填写。`,
          );
        })
        .catch(() => {
          if (!mountedRef.current || checkSeq !== cardCheckSeq.current) return;
          setConfig((prev) => {
            if (prev.productCardId !== cardId) return prev;
            const next = { ...prev, productCardId: null, productCardSummary: null };
            const snap = suiteWorkspaceStore.getSnapshot();
            if (snap.config.productCardId === cardId) {
              suiteWorkspaceStore.updateConfig(next, {
                suiteId: snap.activeSuiteId,
                markDirty: false,
                clone: snap.clone,
              });
            }
            return next;
          });
          setNotice(
            `原关联商品信息卡${fallbackName ? `「${fallbackName}」` : ""}已删除或不可用，已自动清空左侧绑定，请重新选择在用商品卡或手动填写。`,
          );
        });
    },
    [],
  );

  const hydrate = useCallback(
    (s: StudioState, mode: "hydrate" | "edit" = "hydrate") => {
      cardCheckSeq.current += 1;
      const nextClone = Boolean(s.pipeline || s.cards.length > 0);
      const nextConfig = fromRun(s.pipeline);
      setImages(s.inputImages);
      setConfig(nextConfig);
      setConfigDirty(false);
      setClone(nextClone);
      suiteWorkspaceStore.hydrateFromServer(s.suite.id, nextConfig, nextClone);
      suiteWorkspaceStore.setMemoryCache({
        suiteId: s.suite.id,
        state: s,
        images: s.inputImages,
      });
      if (nextConfig.productCardId) {
        verifyBoundCardForEditing(
          nextConfig.productCardId,
          nextConfig.productCardSnapshot?.name ?? nextConfig.productCardSummary?.name ?? "",
          mode,
        );
      } else if (mode === "edit") {
        setNotice("已载入同款配置，生成后将创建新批次。");
      }
    },
    [verifyBoundCardForEditing],
  );

  useEffect(() => {
    // URL ?productCardId=<id> opens a blank new suite pre-bound to the published product card.
    if (!suiteId && initialProductCardId) {
      let live = true;
      const checkSeq = ++cardCheckSeq.current;
      hydrated.current = undefined;
      skipDefaultFeed.current = false;
      setActive(undefined);
      applyState(null);
      setLoadingBatch(false);
      setBusy(false);
      setBatchError("");
      setNotice("");
      setImages([]);
      setClone(false);
      setConfig(initialConfig);
      setConfigDirty(false);

      void productCardsApi
        .get(initialProductCardId)
        .then((card) => {
          if (!live || checkSeq !== cardCheckSeq.current) return;
          if (card.status !== "published") {
            setNotice(
              `商品信息卡「${card.name}」已归档，无法用于新建批次，请重新选择或手动填写。`,
            );
            return;
          }
          const boundConfig: Config = {
            ...initialConfig,
            productCardId: card.id,
            productCardSummary: toSelectedProductCardSummary(card),
            productCardSnapshot: null,
          };
          suiteWorkspaceStore.clear();
          suiteWorkspaceStore.updateConfig(boundConfig, {
            suiteId: null,
            markDirty: true,
            clone: false,
          });
          setConfig(boundConfig);
          setConfigDirty(true);
        })
        .catch(() => {
          if (!live || checkSeq !== cardCheckSeq.current) return;
          setNotice("未找到指定的商品信息卡，请重新选择或手动填写。");
        });

      return () => {
        live = false;
      };
    }

    const snap = suiteWorkspaceStore.getSnapshot();
    const targetId = suiteId ?? snap.activeSuiteId ?? undefined;
    setActive(targetId);

    if (targetId && targetId === hydrated.current) {
      suiteWorkspaceStore.setActiveSuite(targetId);
      if (!suiteId) navigate(`/create/suite/${targetId}`, { replace: true });
      setLoadingBatch(false);
      return;
    }

    if (!targetId && skipDefaultFeed.current) {
      skipDefaultFeed.current = false;
      hydrated.current = undefined;
      applyState(null);
      setLoadingBatch(false);
      setBusy(false);
      return;
    }

    // Restore an unuploaded local config draft (e.g. sellingPoints, counts, pre-bound productCard)
    // without fetching historical feed batches.
    if (!targetId && snap.activeSuiteId === null && (snap.hasLocalConfigEdits || isConfigDirty(snap.config))) {
      hydrated.current = undefined;
      setNotice("");
      setBatchError("");
      setImages([]);
      setClone(false);
      setConfig(snap.config);
      setConfigDirty(true);
      applyState(null);
      setBusy(false);
      setLoadingBatch(false);
      if (snap.config.productCardId) {
        verifyBoundCardForEditing(
          snap.config.productCardId,
          snap.config.productCardSummary?.name ?? snap.config.productCardSnapshot?.name ?? "",
          "hydrate",
        );
      }
      return;
    }

    let live = true;
    cardCheckSeq.current += 1;
    setNotice("");
    setBatchError("");

    async function loadDefaultActive(seq: number) {
      try {
        const page = await studioApi.feed({ origin: "suite_studio", limit: 1, offset: 0 });
        if (!live) return;
        const latest = page.items[0];
        if (!isActiveNonTerminalFeedItem(latest)) {
          applyState(null);
          return;
        }
        try {
          const state = await fetchStudioState(latest.suite.id);
          if (!live) return;
          applyState(state, seq);
          hydrate(state);
          hydrated.current = state.suite.id;
          setActive(state.suite.id);
        } catch {
          if (live) applyState(null);
        }
      } catch (e) {
        if (live) {
          applyState(null);
          setNotice(message(e));
        }
      }
    }

    if (targetId) {
      const cached = suiteWorkspaceStore.getMemoryCache(targetId);
      const isInSpaRestore = Boolean(cached);
      const canReusePersistedConfig = isInSpaRestore || !snap.clone;
      const hasSavedConfigForTarget =
        canReusePersistedConfig &&
        snap.configSuiteId === targetId &&
        (snap.hasLocalConfigEdits || !cached?.state?.pipeline);

      if (cached) {
        applyState(cached.state);
        setImages(cached.images);
        setLoadingBatch(false);
      } else {
        setImages([]);
        setLoadingBatch(true);
      }

      if (hasSavedConfigForTarget) {
        setConfig(snap.config);
        setConfigDirty(snap.hasLocalConfigEdits);
        setClone(snap.clone);
      } else if (!cached) {
        setConfig(initialConfig);
        setConfigDirty(false);
        setClone(false);
      }

      setBusy(!cached);
      const seq = ++requestSeq.current;
      void fetchStudioState(targetId)
        .then((s) => {
          if (!live) return;
          const isDraftSuite = !s.pipeline && s.cards.length === 0;
          const nextClone = Boolean(s.pipeline || s.cards.length > 0);
          applyState(s, seq);
          suiteWorkspaceStore.setMemoryCache({
            suiteId: s.suite.id,
            state: s,
            images: s.inputImages,
          });
          setImages(s.inputImages);
          setClone(nextClone);

          const latestSnap = suiteWorkspaceStore.getSnapshot();
          const shouldPreserveDraftConfig =
            (isDraftSuite &&
              (latestSnap.configSuiteId === s.suite.id ||
                (latestSnap.configSuiteId === null && latestSnap.hasLocalConfigEdits))) ||
            (!isDraftSuite &&
              isInSpaRestore &&
              latestSnap.configSuiteId === s.suite.id &&
              latestSnap.hasLocalConfigEdits);

          if (shouldPreserveDraftConfig) {
            const preserved = latestSnap.config;
            setConfig(preserved);
            setConfigDirty(latestSnap.hasLocalConfigEdits);
            suiteWorkspaceStore.updateConfig(preserved, {
              suiteId: s.suite.id,
              markDirty: latestSnap.hasLocalConfigEdits,
              clone: nextClone,
            });
            if (preserved.productCardId) {
              verifyBoundCardForEditing(
                preserved.productCardId,
                preserved.productCardSummary?.name ?? preserved.productCardSnapshot?.name ?? "",
                "hydrate",
              );
            }
          } else {
            hydrate(s);
          }

          hydrated.current = s.suite.id;
          setActive(s.suite.id);
          if (!suiteId) navigate(`/create/suite/${s.suite.id}`, { replace: true });
        })
        .catch(async (e) => {
          if (!live) return;
          if (!suiteId) {
            suiteWorkspaceStore.clear();
            hydrated.current = undefined;
            setActive(undefined);
            setImages([]);
            setConfig(initialConfig);
            setConfigDirty(false);
            setClone(false);
            applyState(null);
            await loadDefaultActive(++requestSeq.current);
          } else {
            if (suiteWorkspaceStore.getSnapshot().activeSuiteId === suiteId) {
              suiteWorkspaceStore.clear();
            }
            hydrated.current = undefined;
            setImages([]);
            setConfig(initialConfig);
            setConfigDirty(false);
            setClone(false);
            applyState(null);
            setBatchError(message(e));
          }
        })
        .finally(() => {
          if (live) {
            setBusy(false);
            setLoadingBatch(false);
          }
        });
    } else {
      setImages([]);
      setConfig(initialConfig);
      setConfigDirty(false);
      setClone(false);
      hydrated.current = undefined;
      setBusy(false);
      setLoadingBatch(true);
      const seq = ++requestSeq.current;
      void loadDefaultActive(seq).finally(() => {
        if (live) setLoadingBatch(false);
      });
    }

    return () => {
      live = false;
    };
  }, [
    suiteId,
    initialProductCardId,
    reloadTick,
    navigate,
    applyState,
    fetchStudioState,
    hydrate,
    verifyBoundCardForEditing,
  ]);

  const currentBatch = currentState && (currentState.cards.length || currentState.pipeline) ? currentState : null;
  const pollingSuiteId = currentBatch && isBatchPolling(currentBatch) ? currentBatch.suite.id : undefined;

  usePolling(async signal => {
    if (!pollingSuiteId) return;
    const seq = ++requestSeq.current;
    const next = await studioApi.state(pollingSuiteId, signal);
    if (signal.aborted || currentBatchIdRef.current !== pollingSuiteId) return;
    suiteWorkspaceStore.setMemoryCache({ suiteId: next.suite.id, state: next, images: next.inputImages });
    applyState(next, seq);
  }, {
    enabled: Boolean(pollingSuiteId),
    intervalMs: POLL_INTERVAL_MS,
    onError: error => {
      if (currentBatchIdRef.current === pollingSuiteId) setNotice(message(error));
    },
  }, [pollingSuiteId]);

  const route = (id: string) => {
    hydrated.current = id;
    setActive(id);
    suiteWorkspaceStore.setActiveSuite(id);
    if (id !== suiteId) navigate(`/create/suite/${id}`);
  };

  const startNewSuite = () => {
    suiteWorkspaceStore.clear();
    cardCheckSeq.current += 1;
    hydrated.current = undefined;
    setActive(undefined);
    applyState(null);
    setLoadingBatch(false);
    setBatchError("");
    setNotice("");
    setImages([]);
    setConfig(initialConfig);
    setConfigDirty(false);
    setClone(false);
    if (suiteId || initialProductCardId || window.location.pathname !== "/create/suite" || window.location.search) {
      if (suiteId || initialProductCardId) skipDefaultFeed.current = true;
      navigate("/create/suite");
    }
  };

  const handleSelectHistory = (id: string) => {
    setHistoryOpen(false);
    setBatchError("");
    skipDefaultFeed.current = false;
    hydrated.current = undefined;
    suiteWorkspaceStore.setActiveSuite(id, { resetLocalConfig: true });
    if (id === suiteId) {
      setReloadTick((n) => n + 1);
      return;
    }
    navigate(`/create/suite/${id}`);
  };

  const upload = async (files: File[]) => {
    if (busy || clone || !files.length) return;
    setBusy(true);
    setNotice("");
    try {
      if (files.length + images.length > 6) throw Error("每个批次最多上传 6 张商品原图。");
      if (files.some((f) => !["image/png", "image/jpeg", "image/webp"].includes(f.type)))
        throw Error("请上传 PNG、JPEG 或 WebP 格式的图片。");
      let id = currentSuiteId;
      let nextImages = [...images];
      if (!id) {
        const initialName =
          config.productCardId && config.productCardSummary?.name
            ? config.productCardSummary.name
            : productNameFor(undefined, files[0].name);
        id = (await suiteApi.create(initialName)).id;
        suiteWorkspaceStore.updateConfig(config, {
          suiteId: id,
          markDirty: configDirty || isConfigDirty(config),
          clone: false,
        });
        suiteWorkspaceStore.setMemoryCache({ suiteId: id, state: null, images: nextImages });
        if (mountedRef.current) {
          applyState(null);
          route(id);
        }
      }
      for (const [i, file] of files.entries()) {
        const image = await suiteApi.upload(id, file, images.length + i + 1);
        nextImages = [...nextImages, image];
        suiteWorkspaceStore.setMemoryCache({
          suiteId: id,
          state: currentState,
          images: nextImages,
        });
        if (mountedRef.current) {
          setImages(nextImages);
        }
      }
    } catch (e) {
      if (mountedRef.current) setNotice(message(e));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const generate = async () => {
    if (!currentSuiteId || !images.length || busy) return;
    const sourceSuiteId = currentSuiteId;
    const sourceImages = [...images];
    const submitConfig = { ...effective };
    const isCloneRun = clone;
    setBusy(true);
    setNotice("");
    try {
      if (!isCloneRun) {
        const nextName =
          submitConfig.productCardId && submitConfig.productCardSummary?.name
            ? submitConfig.productCardSummary.name
            : productNameFor(submitConfig.sellingPoints, sourceImages[0].originalFilename);
        await suiteApi.rename(sourceSuiteId, nextName);
      }
      const result = await studioApi.start(
        isCloneRun
          ? { cloneFrom: { suiteId: sourceSuiteId, imageIds: sourceImages.map((i) => i.id) } }
          : { suiteId: sourceSuiteId },
        submitConfig,
      );
      suiteWorkspaceStore.hydrateFromServer(result.suiteId, submitConfig, true);
      saveLastSuiteId(result.suiteId);

      const canUpdateUi = () =>
        mountedRef.current && window.location.pathname.startsWith("/create/suite");

      if (canUpdateUi()) {
        route(result.suiteId);
        setClone(true);
        setConfigDirty(false);
      }

      const seq = ++requestSeq.current;
      const latest = await studioApi.state(result.suiteId);
      suiteWorkspaceStore.setMemoryCache({
        suiteId: latest.suite.id,
        state: latest,
        images: latest.inputImages,
      });
      suiteWorkspaceStore.hydrateFromServer(latest.suite.id, fromRun(latest.pipeline), true);
      saveLastSuiteId(latest.suite.id);

      if (canUpdateUi()) {
        applyState(latest, seq);
        setImages(latest.inputImages);
      }
    } catch (e) {
      if (mountedRef.current) setNotice(message(e));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const renderHistoryMeta = useCallback(
    (item: GenerationHistoryFeedItem) => {
      const platformCode = typeof item.pipeline?.config?.platform === "string" ? item.pipeline.config.platform : "";
      if (!platformCode) return null;
      const label = profiles.find((p) => p.code === platformCode)?.name ?? platformCode;
      return <span className="gh-meta-tag">{label}</span>;
    },
    [profiles],
  );

  const displayedSuiteId = currentBatch?.suite.id ?? currentSuiteId;

  return (
    <AppShell
      activeNav="create"
      crumbs={[{ label: "创建" }, { label: "商品套图" }]}
      navigate={navigate}
      fullHeight
      className="ss-shell"
      statusText={busy ? "正在处理" : "工作台就绪"}
      statusTone={busy ? "running" : "pass"}
    >
      <div className="ss-layout">
        <CreateToolsNav activeTool="suite" navigate={navigate} />
        <ConfigPanel
          config={effective}
          update={patch}
          platforms={profiles}
          options={options}
          images={images}
          busy={busy}
          canUpload={!clone}
          upload={(files) => void upload(files)}
          generate={() => void generate()}
          remove={async (im) => {
            if (!currentSuiteId) return;
            setBusy(true);
            try {
              if (!clone) await suiteApi.removeInputImage(currentSuiteId, im.id);
              const nextImages = images.filter((x) => x.id !== im.id);
              suiteWorkspaceStore.setMemoryCache({
                suiteId: currentSuiteId,
                state: currentState,
                images: nextImages,
              });
              setImages(nextImages);
            } catch (e) {
              setNotice(message(e));
            } finally {
              setBusy(false);
            }
          }}
        />
        <main className="ss-results">
          <div className="ss-results-head">
            <div>
              <div className="ss-eyebrow">WORKSPACE / RESULTS</div>
              <h2>生成结果</h2>
            </div>
            <div className="ss-results-actions">
              <button type="button" onClick={() => setHistoryOpen(true)}>
                生成记录
              </button>
              {(currentSuiteId || currentBatch || config.productCardId || configDirty) && (
                <button type="button" disabled={busy} onClick={startNewSuite}>
                  ＋ 新建套图
                </button>
              )}
            </div>
          </div>
          {notice && (
            <div className="ss-note" role="alert">
              {notice}
              <button onClick={() => setNotice("")} aria-label="关闭提示">
                ×
              </button>
            </div>
          )}
          {!currentBatch &&
            (loadingBatch ? (
              <p>正在读取批次…</p>
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
              <SuiteEmptyState />
            ))}
          {currentBatch && (
            <BatchResults
              key={currentBatch.suite.id}
              state={currentBatch}
              profiles={profiles}
              sizes={options.sizes}
              refresh={refresh}
              navigate={navigate}
              onActivate={setActive}
              onEdit={(s) => {
                hydrate(s, "edit");
                route(s.suite.id);
                applyState(s);
              }}
              onDelete={(id) => {
                if (suiteWorkspaceStore.getSnapshot().activeSuiteId === id) {
                  suiteWorkspaceStore.clear();
                }
                if (currentBatch.suite.id === id || currentSuiteId === id) {
                  startNewSuite();
                }
              }}
            />
          )}
        </main>
      </div>
      <GenerationHistoryDrawer
        origin="suite_studio"
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onSelect={handleSelectHistory}
        currentSuiteId={displayedSuiteId}
        renderMeta={renderHistoryMeta}
      />
    </AppShell>
  );
}
