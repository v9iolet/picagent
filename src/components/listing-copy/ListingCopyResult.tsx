import { useEffect, useId, useState } from "react";
import { listingCopyApi, type ApiListingContent, type ApiListingJob, type ApiListingSummary } from "../../api/client";
import { Icon } from "../../pages/shared";

export const listingStatuses: Record<ApiListingSummary["status"], string> = {
  draft: "文案草稿",
  running: "正在生成文案…",
  succeeded: "文案生成成功",
  failed: "文案生成失败",
};

export function listingMessage(error: unknown) {
  const code = error instanceof Error ? error.message : String(error);
  const hints: Record<string, string> = {
    LISTING_TITLE_TOO_LONG: "标题超过平台字数上限。",
    LISTING_TOO_MANY_BULLETS: "卖点条数超过平台上限。",
    LISTING_FORBIDDEN_WORD: "文案含有平台禁用词。",
    LISTING_INVALID_CONTENT: "文案格式不符合平台要求。",
    LISTING_RULES_NOT_CONFIGURED: "此平台尚未配置上架文案规则。",
    LISTING_TEMPLATE_NOT_PUBLISHED: "上架文案模板尚未发布。",
    LLM_NOT_CONFIGURED: "请在配置中设置视觉模型。",
    LISTING_GENERATION_FAILED: "文案生成未完成，请重试。",
    INPUT_IMAGES_REQUIRED: "至少需要一张商品图。",
    INPUT_IMAGE_LIMIT: "最多可上传 6 张商品图。",
    INPUT_OBJECT_NOT_FOUND: "商品图已不可用，请重新选择图片。",
    LISTING_JOB_NOT_FOUND: "找不到此文案任务。",
    LISTING_JOB_RUNNING: "文案正在生成，请等待完成。",
    LISTING_JOB_CHANGED: "文案已在其他页面更新，请刷新后重试。",
  };
  return hints[code] ?? code;
}

// The job may outlive either view. Only poll active generation; stop on unmount or a terminal state.
export function useListingCopyJob(id?: string, initial?: ApiListingJob) {
  const [job, setJob] = useState(initial);
  const [readError, setReadError] = useState("");
  const [revision, setRevision] = useState(0);
  const needsRead = !job || job.status === "running";
  useEffect(() => {
    if (!id || !needsRead) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await listingCopyApi.get(id!);
        if (!active) return;
        setJob(next);
        if (next.status === "running") timer = setTimeout(poll, 1000);
      } catch (error) {
        if (active) setReadError(listingMessage(error));
      }
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [id, needsRead, revision]);
  return {
    job, setJob, readError,
    retry: () => { setReadError(""); setRevision((n) => n + 1); },
  };
}

function CopyField({ label, value, rows, readOnly, update, notify }: {
  label: string;
  value: string;
  rows?: number;
  readOnly: boolean;
  update: (value: string) => void;
  notify: (text: string) => void;
}) {
  const id = useId();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      notify(`已复制${label}`);
    } catch {
      notify("无法访问剪贴板，请选中文案后手动复制。");
    }
  };
  return (
    <div className="lc-field">
      <div className="lc-field-head">
        <label htmlFor={id}>{label}</label>
        <button aria-label={`复制${label}`} title={`复制${label}`} disabled={!value.trim()} onClick={() => void copy()}>
          <Icon name="copy" />
        </button>
      </div>
      {rows ? <textarea id={id} rows={rows} value={value} readOnly={readOnly} onChange={(e) => update(e.target.value)} />
        : <input id={id} value={value} readOnly={readOnly} onChange={(e) => update(e.target.value)} />}
    </div>
  );
}

const lines = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean);

function VersionEditor({ content, editable, domestic, save }: {
  content: ApiListingContent;
  editable: boolean;
  domestic: boolean;
  save: (content: ApiListingContent) => void;
}) {
  const [title, setTitle] = useState(content.title);
  const [bullets, setBullets] = useState(content.bulletPoints.join("\n"));
  const [description, setDescription] = useState(content.description);
  const [terms, setTerms] = useState(content.searchTerms?.join("\n") ?? "");
  const [notice, setNotice] = useState("");
  const changed = title !== content.title || bullets !== content.bulletPoints.join("\n") ||
    description !== content.description || terms !== (content.searchTerms?.join("\n") ?? "");
  const common = { readOnly: !editable, notify: setNotice };
  return (
    <div className="lc-fields">
      <CopyField {...common} label="标题" value={title} update={setTitle} />
      <CopyField {...common} label={domestic ? "卖点短句" : "五点描述"} rows={4} value={bullets} update={setBullets} />
      <CopyField {...common} label="商品描述" rows={4} value={description} update={setDescription} />
      {content.searchTerms !== undefined && <CopyField {...common} label="搜索词" rows={2} value={terms} update={setTerms} />}
      {content.missingFacts.length > 0 && <div className="lc-missing">待补充事实：{content.missingFacts.join("、")}</div>}
      <div className="lc-row">
        {editable && <button className="ss-primary" disabled={!changed} onClick={() => save({
          title, bulletPoints: lines(bullets), description,
          ...(content.searchTerms !== undefined ? { searchTerms: lines(terms) } : {}),
          missingFacts: content.missingFacts,
        })}>保存为新版本</button>}
        <span role="status" className="ss-help">{notice}</span>
      </div>
    </div>
  );
}

export function ListingCopyResult({ job, blocked, domestic, save, regenerate, canRegenerate = true }: {
  job: ApiListingJob;
  blocked: boolean;
  domestic: boolean;
  save: (content: ApiListingContent) => void;
  regenerate: () => void;
  canRegenerate?: boolean;
}) {
  const [selected, setSelected] = useState<string>();
  const latest = job.versions[job.versions.length - 1];
  const version = job.versions.find((v) => v.id === selected) ?? latest;
  const canWrite = !blocked && job.status !== "running";
  return (
    <div className="lc-result">
      <div className="lc-row lc-result-head">
        <span role="status" className="lc-status" data-status={job.status}>{listingStatuses[job.status]}</span>
        {job.status !== "draft" && <button disabled={!canRegenerate || !canWrite || !job.inputImages.length} onClick={regenerate}>重新生成</button>}
      </div>
      {job.status === "failed" && <p role="alert" className="lc-error">{listingMessage(job.errorCode ?? "LISTING_GENERATION_FAILED")}</p>}
      {version && <>
        <VersionEditor key={version.id} content={version.content} domestic={domestic} editable={canWrite && version.id === latest?.id}
          save={(content) => { setSelected(undefined); save(content); }} />
        <section className="lc-versions" aria-label="版本历史">
          <h3>版本历史</h3>
          <ul className="lc-list">
            {[...job.versions].reverse().map((v) => (
              <li key={v.id}><button aria-pressed={v.id === version.id} onClick={() => setSelected(v.id === latest?.id ? undefined : v.id)}>
                <span>版本 {v.versionNumber}{v.id === latest?.id ? " · 最新" : ""}</span>
                <time dateTime={v.createdAt}>{new Date(v.createdAt).toLocaleString()}</time>
              </button></li>
            ))}
          </ul>
        </section>
      </>}
    </div>
  );
}
