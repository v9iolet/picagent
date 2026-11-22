import { useCallback, useEffect, useRef, useState } from "react";
import { modelSettingsApi, suiteApi, type ApiImage, type ApiPlatformProfile } from "../api/client";
import { defaultImageOptions } from "../../shared/model-settings";
import { productNameFor } from "../../shared/product-name";
import { AppShell } from "../components/AppShell";
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
const FEED_STATE_CONCURRENCY = 3;

async function loadStatesWithConcurrency(
  ids: readonly string[],
  concurrency: number,
  load: (id: string) => Promise<StudioState>,
): Promise<PromiseSettledResult<StudioState>[]> {
  const results: PromiseSettledResult<StudioState>[] = new Array(ids.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), ids.length);
  await Promise.allSettled(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < ids.length) {
        const current = nextIndex++;
        const [settled] = await Promise.allSettled([load(ids[current])]);
        results[current] = settled;
      }
    }),
  );
  return results;
}

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
  const [states, setStates] = useState<Record<string, StudioState>>({}),
    [hasMore, setMore] = useState(false),
    [loadingFeed, setLoadingFeed] = useState(true),
    [active, setActive] = useState<string | undefined>(() => suiteId ?? readLastSuiteId() ?? undefined);
  const hydrated = useRef<string | undefined>(undefined),
    offset = useRef(0),
    feedLock = useRef(false),
    requestSeq = useRef(0),
    appliedSeq = useRef<Record<string, number>>({}),
    inFlightStates = useRef<Map<string, Promise<StudioState>>>(new Map()),
    end = useRef<HTMLButtonElement>(null);
  const fetchStudioState = useCallback((id: string) => {
    const existing = inFlightStates.current.get(id);
    if (existing) return existing;
    const pending = studioApi.state(id).finally(() => {
      if (inFlightStates.current.get(id) === pending) inFlightStates.current.delete(id);
    });
    inFlightStates.current.set(id, pending);
    return pending;
  }, []);
  const putMany = useCallback((items: StudioState[], seq: number) => {
    setStates((prev) => {
      let next: Record<string, StudioState> | null = null;
      for (const s of items) {
        const id = s.suite.id;
        const last = appliedSeq.current[id] ?? 0;
        if (seq < last) continue;
        appliedSeq.current[id] = seq;
        if (!next) next = { ...prev };
        next[id] = s;
      }
      return next ?? prev;
    });
  }, []);
  const put = useCallback((s: StudioState, seq?: number) => {
    putMany([s], seq ?? ++requestSeq.current);
  }, [putMany]);
  const refresh = useCallback(async (id: string) => {
    const seq = ++requestSeq.current;
    put(await studioApi.state(id), seq);
  }, [put]);
  const loadPage = useCallback(async () => {
    if (feedLock.current) return;
    feedLock.current = true;
    setLoadingFeed(true);
    const seq = ++requestSeq.current;
    try {
      const page = await studioApi.feed(offset.current);
      const ids = page.items.map((i) => i.suite.id);
      const toFetch = ids.filter((id) => !(id === hydrated.current && appliedSeq.current[id]));
      const settled = await loadStatesWithConcurrency(toFetch, FEED_STATE_CONCURRENCY, fetchStudioState);
      const items: StudioState[] = [];
      let firstError: unknown;
      for (const result of settled) {
        if (result.status === "fulfilled") items.push(result.value);
        else if (firstError === undefined) firstError = result.reason;
      }
      if (items.length) putMany(items, seq);
      const alreadyHydratedCount = ids.length - toFetch.length;
      if (page.items.length > 0 && items.length + alreadyHydratedCount === 0 && firstError !== undefined) {
        setNotice(message(firstError));
      }
      offset.current += page.items.length;
      setMore(offset.current < page.total);
    } catch (e) {
      setNotice(message(e));
    } finally {
      feedLock.current = false;
      setLoadingFeed(false);
    }
  }, [fetchStudioState, putMany]);
  useEffect(() => {
    void loadPage();
  }, [loadPage]);
  useEffect(() => {
    if (!hasMore || !end.current) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) void loadPage();
    });
    observer.observe(end.current);
    return () => observer.disconnect();
  }, [hasMore, loadPage, loadingFeed]);
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
  const hydrate = (s: StudioState) => {
    setImages(s.inputImages);
    setConfig(fromRun(s.pipeline));
    setClone(!!s.pipeline || s.cards.length > 0);
  };
  const currentSuiteId = suiteId ?? active;
  useEffect(() => {
    const savedId = suiteId ? null : readLastSuiteId();
    const targetId = suiteId ?? savedId ?? undefined;
    setActive(targetId);
    if (targetId === hydrated.current) {
      if (targetId) saveLastSuiteId(targetId);
      if (!suiteId && targetId) navigate(`/create/suite/${targetId}`, { replace: true });
      return;
    }
    let live = true;
    setNotice("");
    setImages([]);
    setConfig(initialConfig);
    setClone(false);
    if (targetId) {
      setBusy(true);
      const seq = ++requestSeq.current;
      fetchStudioState(targetId)
        .then((s) => {
          if (!live) return;
          put(s, seq);
          hydrate(s);
          hydrated.current = s.suite.id;
          setActive(s.suite.id);
          saveLastSuiteId(s.suite.id);
          if (!suiteId) navigate(`/create/suite/${s.suite.id}`, { replace: true });
        })
        .catch((e) => {
          if (!live) return;
          if (!suiteId) {
            clearLastSuiteId();
            hydrated.current = undefined;
            setActive(undefined);
          } else {
            if (readLastSuiteId() === suiteId) clearLastSuiteId();
            setNotice(message(e));
          }
        })
        .finally(() => {
          if (live) setBusy(false);
        });
    } else {
      hydrated.current = undefined;
      setBusy(false);
    }
    return () => {
      live = false;
    };
  }, [suiteId, navigate, put, fetchStudioState]);
  const runningIdsKey = Object.values(states)
    .filter(isBatchPolling)
    .map((s) => s.suite.id)
    .sort()
    .join(",");
  useEffect(() => {
    if (!runningIdsKey) return;
    const ids = runningIdsKey.split(",");
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      const seq = ++requestSeq.current;
      const settled = await Promise.allSettled(ids.map((id) => studioApi.state(id)));
      if (!live) return;
      const updates: StudioState[] = [];
      let firstError: unknown;
      for (const result of settled) {
        if (result.status === "fulfilled") updates.push(result.value);
        else if (firstError === undefined) firstError = result.reason;
      }
      if (updates.length) putMany(updates, seq);
      if (firstError !== undefined) setNotice(message(firstError));
      const updatedById = new Map(updates.map((s) => [s.suite.id, s]));
      const stillRunning = ids.some((id) => {
        const next = updatedById.get(id);
        return next ? isBatchPolling(next) : true;
      });
      if (live && stillRunning) timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    }
    timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [runningIdsKey, putMany]);
  const route = (id: string) => {
    hydrated.current = id;
    setActive(id);
    saveLastSuiteId(id);
    if (id !== suiteId) navigate(`/create/suite/${id}`);
  };
  const startNewSuite = () => {
    clearLastSuiteId();
    if (suiteId) {
      navigate("/create/suite");
    } else {
      hydrated.current = undefined;
      setActive(undefined);
      setNotice("");
      setImages([]);
      setConfig(initialConfig);
      setClone(false);
    }
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
      put(latest, seq);
      setImages(latest.inputImages);
    } catch (e) {
      setNotice(message(e));
    } finally {
      setBusy(false);
    }
  };
  const batches = Object.values(states)
    .filter((s) => s.cards.length || s.pipeline)
    .sort((a, b) => b.suite.createdAt.localeCompare(a.suite.createdAt));
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
            {currentSuiteId && (
              <button disabled={busy} onClick={startNewSuite}>
                ＋ 新建套图
              </button>
            )}
          </div>
          {notice && (
            <div className="ss-note" role="alert">
              {notice}
              <button onClick={() => setNotice("")} aria-label="关闭提示">
                ×
              </button>
            </div>
          )}
          {!batches.length && (loadingFeed ? <p>正在读取批次…</p> : <EmptyStudio />)}
          {batches.map((s) => (
            <BatchResults
              key={s.suite.id}
              state={s}
              profiles={profiles}
              sizes={options.sizes}
              refresh={refresh}
              navigate={navigate}
              onActivate={setActive}
              onEdit={(s) => {
                hydrate(s);
                route(s.suite.id);
                setNotice("已载入同款配置，生成后将创建新批次。");
              }}
              onDelete={(id) => {
                setStates((prev) => {
                  const next = { ...prev };
                  delete next[id];
                  return next;
                });
                delete appliedSeq.current[id];
                offset.current = Math.max(0, offset.current - 1);
                if (readLastSuiteId() === id) clearLastSuiteId();
                if (currentSuiteId === id) startNewSuite();
              }}
            />
          ))}
          {hasMore && (
            <button ref={end} onClick={() => void loadPage()} disabled={loadingFeed}>
              加载更多历史批次
            </button>
          )}
        </main>
      </div>
    </AppShell>
  );
}
