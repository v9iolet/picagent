import { useCallback, useEffect, useRef, useState } from "react";
import { modelSettingsApi, suiteApi, type ApiImage, type ApiPlatformProfile } from "../api/client";
import { defaultImageOptions } from "../../shared/model-settings";
import { productNameFor } from "../../shared/product-name";
import { AppShell } from "../components/AppShell";
import {
  GenerationHistoryDrawer,
  type GenerationHistoryFeedItem,
} from "../components/generation-history/GenerationHistoryDrawer";
import { createTools } from "../features/create/tool-registry";
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
import { Icon } from "./shared";
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
  navigate,
}: {
  suiteId?: string;
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
    [loadingBatch, setLoadingBatch] = useState(true),
    [historyOpen, setHistoryOpen] = useState(false),
    [active, setActive] = useState<string | undefined>(() => suiteId ?? readLastSuiteId() ?? undefined);

  const hydrated = useRef<string | undefined>(undefined),
    skipDefaultFeed = useRef(false),
    requestSeq = useRef(0),
    appliedSeq = useRef(0),
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

  const patch = (update: Partial<Config>) => setConfig((c) => ({ ...c, ...update }));
  // Options are model-specific; never submit a stale size/ratio restored from another channel.
  const effective: Config = {
    ...config,
    platform: config.platform || profiles.find((p) => p.name === "Amazon")?.code || profiles[0]?.code || "",
    size: options.sizes.includes(config.size) ? config.size : options.sizes[0],
    aspectRatio: options.aspectRatios.includes(config.aspectRatio)
      ? config.aspectRatio
      : options.aspectRatios[0],
  };

  const hydrate = useCallback((s: StudioState) => {
    setImages(s.inputImages);
    setConfig(fromRun(s.pipeline));
    setClone(!!s.pipeline || s.cards.length > 0);
  }, []);

  const currentSuiteId = suiteId ?? active;

  useEffect(() => {
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
    setNotice("");
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
            setNotice(message(e));
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
  }, [suiteId, navigate, applyState, fetchStudioState, hydrate]);

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
    hydrated.current = undefined;
    setActive(undefined);
    applyState(null);
    setLoadingBatch(false);
    setNotice("");
    setImages([]);
    setConfig(initialConfig);
    setClone(false);
    if (suiteId) {
      skipDefaultFeed.current = true;
      navigate("/create/suite");
    }
  };

  const handleSelectHistory = (id: string) => {
    setHistoryOpen(false);
    skipDefaultFeed.current = false;
    if (id === suiteId) {
      void refresh(id).catch((e) => setNotice(message(e)));
      return;
    }
    hydrated.current = undefined;
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
        id = (await suiteApi.create(productNameFor(undefined, files[0].name))).id;
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
      if (!clone)
        await suiteApi.rename(currentSuiteId, productNameFor(effective.sellingPoints, images[0].originalFilename));
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
        <nav className="ss-tools" aria-label="创作功能">
          {createTools.map((t) => (
            <a
              key={t.id}
              href={t.path}
              aria-current={t.id === "suite" ? "page" : undefined}
              onClick={(e) => {
                if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
                  e.preventDefault();
                  navigate(t.path);
                }
              }}
            >
              <Icon name={t.icon} />
              {t.label}
            </a>
          ))}
        </nav>
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
              {(currentSuiteId || currentBatch) && (
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
          {!currentBatch && (loadingBatch ? <p>正在读取批次…</p> : <EmptyStudio />)}
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
                hydrate(s);
                route(s.suite.id);
                applyState(s);
                setNotice("已载入同款配置，生成后将创建新批次。");
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
