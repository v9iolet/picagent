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

function EmptyStudio() {
  return (
    <div className="ss-empty">
      <div className="ss-eyebrow">PRODUCT PHOTOGRAPHY</div>
      <h2>AI 商品套图</h2>
      <p>上传商品原图，按平台规范生成主图、卖点图和场景图。</p>
      <div className="ss-examples">
        {[
          ["gan65-product.jpg", "产品全貌", "01"],
          ["gan65-product-tight.jpg", "商品细节", "02"],
          ["tokyo-desk-v3.jpg", "生活场景", "03"],
        ].map(([file, title, n]) => (
          <figure key={n}>
            <img src={"/assets/" + file} alt={title + "示例"} />
            <figcaption>
              <b>{n}</b> {title}
            </figcaption>
          </figure>
        ))}
      </div>
      <small>示例套图 · 点击左侧「上传原图」开始创作</small>
    </div>
  );
}

const LAST_SUITE_STORAGE_KEY = "picagent:suite-studio:last-suite-id";
const POLL_INTERVAL_MS = 2500;

function readLastSuiteId(): string | null {
  try {
    return window.sessionStorage.getItem(LAST_SUITE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveLastSuiteId(id: string) {
  try {
    window.sessionStorage.setItem(LAST_SUITE_STORAGE_KEY, id);
  } catch {
    // Ignore storage quota or privacy-mode errors.
  }
}

function clearLastSuiteId() {
  try {
    window.sessionStorage.removeItem(LAST_SUITE_STORAGE_KEY);
  } catch {
    // Ignore storage errors.
  }
}

function isBatchPolling(state: StudioState): boolean {
  return state.pipeline?.status === "running" || state.listingCopy?.status === "running";
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
  const [config, setConfig] = useState<Config>(initialConfig),
    [profiles, setProfiles] = useState<ApiPlatformProfile[]>([]),
    [options, setOptions] = useState(defaultImageOptions(""));
  const [images, setImages] = useState<ApiImage[]>([]),
    [clone, setClone] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const [currentState, setCurrentState] = useState<StudioState | null>(null),
    [loadingBatch, setLoadingBatch] = useState(() => !(initialProductCardId && !suiteId)),
    [batchError, setBatchError] = useState(""),
    [reloadTick, setReloadTick] = useState(0),
    [historyOpen, setHistoryOpen] = useState(false),
    [active, setActive] = useState<string | undefined>(() =>
      initialProductCardId && !suiteId ? undefined : (suiteId ?? readLastSuiteId() ?? undefined),
    );

  const hydrated = useRef<string | undefined>(undefined),
    skipDefaultFeed = useRef(false),
    requestSeq = useRef(0),
    appliedSeq = useRef(0),
    cardCheckSeq = useRef(0),
    currentBatchIdRef = useRef<string | undefined>(undefined),
    inFlightStates = useRef<Map<string, Promise<StudioState>>>(new Map());

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
    async (id: string) => {
      const seq = ++requestSeq.current;
      const next = await studioApi.state(id);
      applyState(next, seq);
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

  const patch = (update: Partial<Config>) => {
    if ("productCardId" in update) {
      cardCheckSeq.current += 1;
    }
    setConfig((c) => ({ ...c, ...update }));
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
          if (checkSeq !== cardCheckSeq.current) return;
          if (card.status === "published") {
            setConfig((prev) =>
              prev.productCardId === cardId
                ? { ...prev, productCardSummary: toSelectedProductCardSummary(card) }
                : prev,
            );
            if (mode === "edit") {
              setNotice("已载入同款配置，生成后将创建新批次。");
            }
            return;
          }
          setConfig((prev) =>
            prev.productCardId === cardId
              ? { ...prev, productCardId: null, productCardSummary: null }
              : prev,
          );
          setNotice(
            `原关联商品信息卡「${card.name || fallbackName || cardId}」已归档，已自动清空左侧绑定，请重新选择在用商品卡或手动填写。`,
          );
        })
        .catch(() => {
          if (checkSeq !== cardCheckSeq.current) return;
          setConfig((prev) =>
            prev.productCardId === cardId
              ? { ...prev, productCardId: null, productCardSummary: null }
              : prev,
          );
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
      setImages(s.inputImages);
      const nextConfig = fromRun(s.pipeline);
      setConfig(nextConfig);
      setClone(!!s.pipeline || s.cards.length > 0);
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

  const currentSuiteId = suiteId ?? active;

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
          setConfig((prev) => ({
            ...prev,
            productCardId: card.id,
            productCardSummary: toSelectedProductCardSummary(card),
            productCardSnapshot: null,
          }));
        })
        .catch(() => {
          if (!live || checkSeq !== cardCheckSeq.current) return;
          setNotice("未找到指定的商品信息卡，请重新选择或手动填写。");
        });

      return () => {
        live = false;
      };
    }

    const savedId = suiteId ? null : readLastSuiteId();
    const targetId = suiteId ?? savedId ?? undefined;
    setActive(targetId);

    if (targetId && targetId === hydrated.current) {
      saveLastSuiteId(targetId);
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

    let live = true;
    cardCheckSeq.current += 1;
    setNotice("");
    setBatchError("");
    setImages([]);
    setConfig(initialConfig);
    setClone(false);

    async function loadDefaultLatest(seq: number) {
      try {
        const page = await studioApi.feed({ origin: "suite_studio", limit: 1, offset: 0 });
        if (!live) return;
        const latest = page.items[0];
        if (!latest) {
          applyState(null);
          return;
        }
        try {
          const state = await fetchStudioState(latest.suite.id);
          if (!live) return;
          applyState(state, seq);
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
      setBusy(true);
      setLoadingBatch(true);
      const seq = ++requestSeq.current;
      void fetchStudioState(targetId)
        .then((s) => {
          if (!live) return;
          applyState(s, seq);
          hydrate(s);
          hydrated.current = s.suite.id;
          setActive(s.suite.id);
          saveLastSuiteId(s.suite.id);
          if (!suiteId) navigate(`/create/suite/${s.suite.id}`, { replace: true });
        })
        .catch(async (e) => {
          if (!live) return;
          if (!suiteId) {
            clearLastSuiteId();
            hydrated.current = undefined;
            setActive(undefined);
            applyState(null);
            await loadDefaultLatest(++requestSeq.current);
          } else {
            if (readLastSuiteId() === suiteId) clearLastSuiteId();
            hydrated.current = undefined;
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
      hydrated.current = undefined;
      setBusy(false);
      setLoadingBatch(true);
      const seq = ++requestSeq.current;
      void loadDefaultLatest(seq).finally(() => {
        if (live) setLoadingBatch(false);
      });
    }

    return () => {
      live = false;
    };
  }, [suiteId, initialProductCardId, reloadTick, navigate, applyState, fetchStudioState, hydrate]);

  const currentBatch = currentState && (currentState.cards.length || currentState.pipeline) ? currentState : null;
  const pollingSuiteId = currentBatch && isBatchPolling(currentBatch) ? currentBatch.suite.id : undefined;

  useEffect(() => {
    if (!pollingSuiteId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      const seq = ++requestSeq.current;
      try {
        const next = await studioApi.state(pollingSuiteId!);
        if (!live || currentBatchIdRef.current !== pollingSuiteId) return;
        applyState(next, seq);
        if (isBatchPolling(next)) {
          timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
        }
      } catch (e) {
        if (!live || currentBatchIdRef.current !== pollingSuiteId) return;
        setNotice(message(e));
        timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      }
    }
    timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [pollingSuiteId, applyState]);

  const route = (id: string) => {
    hydrated.current = id;
    setActive(id);
    saveLastSuiteId(id);
    if (id !== suiteId) navigate(`/create/suite/${id}`);
  };

  const startNewSuite = () => {
    clearLastSuiteId();
    cardCheckSeq.current += 1;
    hydrated.current = undefined;
    setActive(undefined);
    applyState(null);
    setLoadingBatch(false);
    setBatchError("");
    setNotice("");
    setImages([]);
    setConfig(initialConfig);
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
    if (id === suiteId) {
      setReloadTick((n) => n + 1);
      return;
    }
    saveLastSuiteId(id);
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
      if (!id) {
        const initialName =
          config.productCardId && config.productCardSummary?.name
            ? config.productCardSummary.name
            : productNameFor(undefined, files[0].name);
        id = (await suiteApi.create(initialName)).id;
        applyState(null);
        route(id);
      }
      for (const [i, file] of files.entries()) {
        const image = await suiteApi.upload(id, file, images.length + i + 1);
        setImages((prev) => [...prev, image]);
      }
    } catch (e) {
      setNotice(message(e));
    } finally {
      setBusy(false);
    }
  };

  const generate = async () => {
    if (!currentSuiteId || !images.length || busy) return;
    setBusy(true);
    setNotice("");
    try {
      if (!clone) {
        const nextName =
          effective.productCardId && effective.productCardSummary?.name
            ? effective.productCardSummary.name
            : productNameFor(effective.sellingPoints, images[0].originalFilename);
        await suiteApi.rename(currentSuiteId, nextName);
      }
      const result = await studioApi.start(
        clone ? { cloneFrom: { suiteId: currentSuiteId, imageIds: images.map((i) => i.id) } } : { suiteId: currentSuiteId },
        effective,
      );
      route(result.suiteId);
      setClone(true);
      const seq = ++requestSeq.current;
      const latest = await studioApi.state(result.suiteId);
      applyState(latest, seq);
      setImages(latest.inputImages);
    } catch (e) {
      setNotice(message(e));
    } finally {
      setBusy(false);
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
              setImages((a) => a.filter((x) => x.id !== im.id));
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
              {(currentSuiteId || currentBatch || config.productCardId) && (
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
              <EmptyStudio />
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
                if (readLastSuiteId() === id) clearLastSuiteId();
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
