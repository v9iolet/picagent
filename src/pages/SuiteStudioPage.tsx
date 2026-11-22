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

export function SuiteStudioPage({
  suiteId,
  navigate,
}: {
  suiteId?: string;
  navigate: (path: string) => void;
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
    [active, setActive] = useState(suiteId);
  const hydrated = useRef<string | undefined>(undefined),
    offset = useRef(0),
    feedLock = useRef(false),
    end = useRef<HTMLButtonElement>(null);
  const put = useCallback((s: StudioState) => setStates((prev) => ({ ...prev, [s.suite.id]: s })), []);
  const refresh = useCallback(async (id: string) => put(await studioApi.state(id)), [put]);
  const loadPage = useCallback(async () => {
    if (feedLock.current) return;
    feedLock.current = true;
    setLoadingFeed(true);
    try {
      const page = await studioApi.feed(offset.current);
      const items = await Promise.all(page.items.map((i) => studioApi.state(i.suite.id)));
      setStates((old) => ({ ...Object.fromEntries(items.map((s) => [s.suite.id, s])), ...old }));
      offset.current += page.items.length;
      setMore(offset.current < page.total);
    } catch (e) {
      setNotice(message(e));
    } finally {
      feedLock.current = false;
      setLoadingFeed(false);
    }
  }, []);
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
  useEffect(() => {
    setActive(suiteId);
    if (suiteId === hydrated.current) return;
    let live = true;
    setNotice("");
    setImages([]);
    setConfig(initialConfig);
    setClone(false);
    if (suiteId) {
      setBusy(true);
      studioApi
        .state(suiteId)
        .then((s) => {
          if (live) {
            put(s);
            hydrate(s);
            hydrated.current = suiteId;
          }
        })
        .catch((e) => {
          if (live) setNotice(message(e));
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
  }, [suiteId, put]);
  const activeRunning = active && states[active]?.pipeline?.status === "running";
  useEffect(() => {
    if (!active || !activeRunning) return;
    let live = true,
      timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const s = await studioApi.state(active!);
        if (!live) return;
        put(s);
        if (s.pipeline?.status !== "running") return;
      } catch (e) {
        if (live) setNotice(message(e));
      }
      if (live) timer = setTimeout(() => void poll(), 3000);
    }
    timer = setTimeout(() => void poll(), 3000);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [active, activeRunning, put]);
  const route = (id: string) => {
    hydrated.current = id;
    setActive(id);
    if (id !== suiteId) navigate(`/create/suite/${id}`);
  };
  const upload = async (files: File[]) => {
    if (busy || clone || !files.length) return;
    setBusy(true);
    setNotice("");
    try {
      if (files.length + images.length > 6) throw Error("每个批次最多上传 6 张商品原图。");
      if (files.some((f) => !["image/png", "image/jpeg", "image/webp"].includes(f.type)))
        throw Error("请上传 PNG、JPEG 或 WebP 格式的图片。");
      let id = suiteId;
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
    if (!suiteId || !images.length || busy) return;
    setBusy(true);
    setNotice("");
    try {
      if (!clone) await suiteApi.rename(suiteId, productNameFor(effective.sellingPoints, images[0].originalFilename));
      const result = await studioApi.start(
        clone ? { cloneFrom: { suiteId, imageIds: images.map((i) => i.id) } } : { suiteId },
        effective,
      );
      route(result.suiteId);
      setClone(true);
      const latest = await studioApi.state(result.suiteId);
      put(latest);
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
            if (!suiteId) return;
            setBusy(true);
            try {
              if (!clone) await suiteApi.removeInputImage(suiteId, im.id);
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
            {suiteId && (
              <button disabled={busy} onClick={() => navigate("/create/suite")}>
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
                offset.current = Math.max(0, offset.current - 1);
                if (suiteId === id) navigate("/create/suite");
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
