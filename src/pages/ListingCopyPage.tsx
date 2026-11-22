import { useEffect, useState } from "react";
import { listingCopyApi, suiteApi, type ApiListingJob, type ApiListingSummary, type ApiPlatformProfile, type ApiSuite, type ListingConfig } from "../api/client";
import { AppShell } from "../components/AppShell";
import { ListingCopyResult, listingMessage, listingStatuses, useListingCopyJob } from "../components/listing-copy/ListingCopyResult";
import { StudioDialog } from "../components/suite-studio/StudioDialog";
import { studioApi } from "../components/suite-studio/studio";
import { createTools } from "../features/create/tool-registry";
import { Icon } from "./shared";
import "../components/suite-studio/studio.css";
import "../components/listing-copy/listing-copy.css";

const route = "/create/listing-copy";
const jobRoute = (id: string) => `${route}/${encodeURIComponent(id)}`;
const maxImages = 6;
const historyPageSize = 20;

function SuitePicker({ choose, close }: { choose: (suite: ApiSuite) => Promise<void>; close: () => void }) {
  const [items, setItems] = useState<ApiSuite[]>([]);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(true);
  const [choosing, setChoosing] = useState(false);
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    studioApi.feed(offset).then((page) => {
      if (!active) return;
      const suites = page.items.map(({ suite }) => suite).filter((suite) => suite.inputImageCount !== 0);
      setItems((prev) => offset ? [...prev.filter((s) => !suites.some((suite) => suite.id === s.id)), ...suites] : suites);
      setTotal(page.total);
    }).catch((error) => { if (active) setNotice(listingMessage(error)); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [offset, reload]);
  return (
    <StudioDialog title="从图片库选择套图批次" close={() => { if (!choosing) close(); }}>
      {notice && <p role="alert" className="lc-error">{notice}</p>}
      {busy && <p role="status">正在读取套图批次…</p>}
      {!busy && !notice && !items.length && <p>暂无可选套图批次。</p>}
      <ul className="lc-list">
        {items.map((suite) => <li key={suite.id}><button disabled={busy || choosing} onClick={() => {
          setChoosing(true);
          setNotice("");
          void choose(suite).catch((error) => setNotice(listingMessage(error))).finally(() => setChoosing(false));
        }}>
          <span>{suite.name}</span>{suite.inputImageCount !== undefined && <small>{suite.inputImageCount} 张原图</small>}
        </button></li>)}
      </ul>
      {!busy && notice && <button disabled={choosing} onClick={() => { setNotice(""); setBusy(true); setReload((n) => n + 1); }}>重试读取</button>}
      {!busy && !notice && offset + 10 < total && <button disabled={choosing} onClick={() => { setBusy(true); setOffset(offset + 10); }}>加载更多批次</button>}
    </StudioDialog>
  );
}

function JobHistory({ job, navigate, platforms }: {
  job?: ApiListingJob;
  navigate: (path: string) => void;
  platforms: ApiPlatformProfile[];
}) {
  const [items, setItems] = useState<ApiListingSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const changed = job?.updatedAt;
  useEffect(() => {
    let active = true;
    listingCopyApi.list(historyPageSize, 0).then((page) => {
      if (!active) return;
      setItems(page.items);
      setMore(page.items.length === historyPageSize);
      setError("");
    }).catch((error) => { if (active) setError(listingMessage(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [changed]);
  const loadMore = async () => {
    setLoading(true);
    setError("");
    try {
      const page = await listingCopyApi.list(historyPageSize, items.length);
      setItems((prev) => [...prev, ...page.items.filter((item) => !prev.some((old) => old.id === item.id))]);
      setMore(page.items.length === historyPageSize);
    } catch (error) {
      setError(listingMessage(error));
    } finally {
      setLoading(false);
    }
  };
  return (
    <section className="lc-history" aria-label="文案任务历史">
      <h3>文案任务历史</h3>
      {error && <p role="alert" className="lc-error">{error}</p>}
      {loading && <p role="status">正在读取历史…</p>}
      {!loading && !error && !items.length && <p className="ss-help">暂无生成记录</p>}
      <ul className="lc-list">
        {items.map((item) => <li key={item.id}>
          <button aria-current={item.id === job?.id ? "page" : undefined} onClick={() => navigate(jobRoute(item.id))}>
            <span>{item.input.sellingPoints.split("\n")[0] || platforms.find((p) => p.code === item.platform)?.name || "上架文案"}</span>
            <small>{listingStatuses[item.status]} · {new Date(item.updatedAt).toLocaleString()}</small>
          </button>
        </li>)}
      </ul>
      {(more || error) && <button disabled={loading} onClick={() => void loadMore()}>{error ? "重试读取历史" : "加载更多历史"}</button>}
    </section>
  );
}

type DraftRoute = { job: ApiListingJob; overrides: Partial<ListingConfig>; notice: string; sourceName?: string };

function Workspace({ jobId, initial, navigate, openDraft }: {
  jobId?: string;
  initial?: DraftRoute;
  navigate: (path: string) => void;
  openDraft: (draft: DraftRoute) => void;
}) {
  const { job, setJob, readError, retry } = useListingCopyJob(jobId, initial?.job);
  const [patch, setPatch] = useState<Partial<ListingConfig>>(initial?.overrides ?? {});
  const [platforms, setPlatforms] = useState<ApiPlatformProfile[]>([]);
  const [platformError, setPlatformError] = useState("");
  const [notice, setNotice] = useState(initial?.notice ?? "");
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState(false);
  useEffect(() => {
    let active = true;
    suiteApi.listPlatforms().then((p) => { if (active) setPlatforms(p); })
      .catch((error) => { if (active) setPlatformError(listingMessage(error)); });
    return () => { active = false; };
  }, []);
  const config: ListingConfig = {
    platform: job?.platform || platforms[0]?.code || "",
    targetMarket: job?.targetMarket ?? "",
    outputLanguage: job?.outputLanguage ?? "中文",
    sellingPoints: job?.input.sellingPoints ?? "",
    ...patch,
  };
  const profile = platforms.find((p) => p.code === config.platform);
  const validConfig = !!profile && !!config.outputLanguage.trim();
  const locked = busy || (!!jobId && !job) || job?.status === "running";
  const images = job?.inputImages ?? [];

  const run = async (action: () => Promise<ApiListingJob>) => {
    setBusy(true);
    setNotice("");
    try { setJob(await action()); }
    catch (error) { setNotice(listingMessage(error)); }
    finally { setBusy(false); }
  };

  const upload = async (files: File[]) => {
    if (!files.length || locked) return;
    if (files.length + images.length > maxImages) { setNotice("最多可上传 6 张商品图。"); return; }
    if (files.some((file) => !["image/jpeg", "image/png", "image/webp"].includes(file.type))) {
      setNotice("请上传 PNG、JPEG 或 WebP 格式的图片。");
      return;
    }
    const origin = window.location.pathname;
    setBusy(true);
    setNotice("");
    let next = job;
    let notice = "";
    try {
      for (const file of files) next = await listingCopyApi.upload(next?.id, file);
    } catch (error) {
      notice = listingMessage(error);
    } finally {
      if (next && !jobId && origin === window.location.pathname) openDraft({ job: next, overrides: patch, notice });
      else { setJob(next); setNotice(notice); }
      setBusy(false);
    }
  };

  const update = (field: keyof ListingConfig, value: string) => setPatch((prev) => ({ ...prev, [field]: value }));
  return (
    <>
      <aside className="ss-panel lc-config">
        <fieldset className="ss-scroll" disabled={locked}>
          <h1>商品上架文案</h1>
          <section>
            <h2>商品图片 <small>{job?.sourceSuiteId ? `${images.length} 张批次原图` : `${images.length} / ${maxImages}`}</small></h2>
            {job?.sourceSuiteId ? <p className="lc-source"><Icon name="image" />{initial?.sourceName ?? "来自套图批次"}</p> : (
              <div className="lc-input-actions">
                <input aria-label="上传商品图" id="lc-photo" type="file" multiple accept="image/jpeg,image/png,image/webp"
                  disabled={images.length >= maxImages} onChange={(e) => { void upload(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
                {!jobId && <button onClick={() => setPick(true)}><Icon name="library" /> 从图片库选套图批次</button>}
              </div>
            )}
            {job && images.length > 0 && <ul className="lc-thumbs">
              {images.map((image) => <li key={image.id}>
                <img src={listingCopyApi.thumbnail(job.id, image.id)} alt={image.originalFilename} />
                {!job.sourceSuiteId && <button aria-label={`移除 ${image.originalFilename}`} title="移除图片" onClick={() => void run(() => listingCopyApi.removeImage(job.id, image.id))}>
                  <Icon name="x" />
                </button>}
              </li>)}
            </ul>}
          </section>
          <section className="lc-brief">
            <h2>上架配置</h2>
            <label>平台<select aria-label="平台" value={config.platform} onChange={(e) => update("platform", e.target.value)}>
              {!profile && <option value={config.platform}>{config.platform || "请选择平台"}</option>}
              {platforms.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
            </select></label>
            {platformError && <p className="lc-error" role="alert">{platformError}</p>}
            <label>目标市场<input value={config.targetMarket} placeholder="例如：中国、美国" onChange={(e) => update("targetMarket", e.target.value)} /></label>
            <label>语言<input value={config.outputLanguage} placeholder="例如：中文、English" onChange={(e) => update("outputLanguage", e.target.value)} /></label>
            <label>商品卖点<textarea rows={5} value={config.sellingPoints} placeholder="例如：折叠插脚、磨砂外壳" onChange={(e) => update("sellingPoints", e.target.value)} /></label>
          </section>
        </fieldset>
        {(!job || job.status === "draft") && <footer>
          <button className="ss-primary" disabled={locked || !images.length || !validConfig} onClick={() => {
            if (job) void run(() => listingCopyApi.generate(job.id, "generate", config));
          }}><Icon name="sparkles" />{busy ? "正在处理…" : "生成文案"}</button>
        </footer>}
      </aside>
      <main className="ss-results lc-main">
        <div className="ss-results-head">
          <div><h2>文案结果</h2></div>
          {jobId && <button onClick={() => navigate(route)} disabled={busy}>＋ 新建文案</button>}
        </div>
        {notice && <p role="alert" className="lc-error">{notice}</p>}
        {readError && <p role="alert" className="lc-error">{readError} <button onClick={retry}>重试读取</button></p>}
        {job ? <ListingCopyResult job={job} blocked={busy} canRegenerate={validConfig} domestic={platforms.find((p) => p.code === job.platform)?.marketScope === "domestic"}
          save={(content) => void run(() => listingCopyApi.save(job.id, content))}
          regenerate={() => void run(() => listingCopyApi.generate(job.id, "regenerate", config))} />
          : <div className="lc-empty"><Icon name="files" /><p>{jobId && !readError ? "正在读取文案…" : "暂无文案结果"}</p></div>}
        <JobHistory job={job} navigate={navigate} platforms={platforms} />
      </main>
      {pick && <SuitePicker close={() => setPick(false)} choose={async (suite) => {
        const origin = window.location.pathname;
        const draft = await listingCopyApi.fromSuite(suite.id);
        if (window.location.pathname === origin) openDraft({ job: draft, overrides: patch, sourceName: suite.name, notice: "" });
        setPick(false);
      }} />}
    </>
  );
}

export function ListingCopyPage({ jobId, navigate }: { jobId?: string; navigate: (path: string) => void }) {
  const [initial, setInitial] = useState<DraftRoute>();
  useEffect(() => { if (initial && initial.job.id !== jobId) setInitial(undefined); }, [initial, jobId]);
  return (
    <AppShell activeNav="create" crumbs={[{ label: "创建" }, { label: "上架文案" }]} navigate={navigate} fullHeight className="ss-shell">
      <div className="ss-layout lc-layout">
        <nav className="ss-tools" aria-label="创作功能">
          {createTools.map((tool) => <a key={tool.id} href={tool.path} aria-current={tool.id === "listing-copy" ? "page" : undefined}
            onClick={(e) => {
              if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) { e.preventDefault(); navigate(tool.path); }
            }}><Icon name={tool.icon} />{tool.label}</a>)}
        </nav>
        <Workspace key={jobId ?? "new"} jobId={jobId} initial={initial?.job.id === jobId ? initial : undefined} navigate={navigate} openDraft={(draft) => {
          setInitial(draft);
          navigate(jobRoute(draft.job.id));
        }} />
      </div>
    </AppShell>
  );
}
