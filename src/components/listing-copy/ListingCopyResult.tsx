import { useEffect, useId, useState } from "react";
import { listingFieldCounts, listingFieldEnabled, type ListingCount, type ListingRules } from "../../../shared/listing-config";
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

export function useListingCopyJob(id: string, initial?: ApiListingJob) {
  const [job, setJob] = useState(initial);
  const [readError, setReadError] = useState("");
  const [revision, setRevision] = useState(0);
  const needsRead = !job || job.status === "running";
  useEffect(() => {
    if (!needsRead) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await listingCopyApi.get(id);
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

const countUnits: Record<ListingCount["unit"], string> = { characters: "字符", bytes: "字节", items: "条" };

function CopyField({ label, value, rows, readOnly, update, notify, counts, itemLimit }: {
  label: string;
  value: string;
  rows?: number;
  readOnly: boolean;
  update: (value: string) => void;
  notify: (text: string) => void;
  counts: ListingCount[];
  itemLimit?: number;
}) {
  const id = useId();
  const countId = counts.length || itemLimit !== undefined ? `${id}-counts` : undefined;
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
        {countId && <div id={countId} className="lc-counts">
          {counts.map(({ actual, limit, unit, itemIndex }) => (
            <span key={itemIndex ?? unit} className="lc-count" data-over-limit={actual > limit}>
              {itemIndex !== undefined && `第 ${itemIndex + 1} 条 `}{actual} / {limit} {countUnits[unit]}
            </span>
          ))}
          {itemLimit !== undefined && <span className="lc-count">每条 ≤ {itemLimit} 字符</span>}
        </div>}
      </div>
      {rows ? <textarea id={id} aria-describedby={countId} rows={rows} value={value} readOnly={readOnly} onChange={(e) => update(e.target.value)} />
        : <input id={id} aria-describedby={countId} value={value} readOnly={readOnly} onChange={(e) => update(e.target.value)} />}
    </div>
  );
}

const lines = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean);

type TextField = "title" | "description" | "itemHighlights" | "seoTitle" | "seoDescription" | "subtitle";
type ListField = "bulletPoints" | "searchTerms" | "tags" | "hashtags" | "missingFacts";

function VersionEditor({ content, editable, domestic, rules, save }: {
  content: ApiListingContent;
  editable: boolean;
  domestic: boolean;
  rules?: ListingRules;
  save: (content: Partial<ApiListingContent>) => void;
}) {
  const [edits, setEdits] = useState<Partial<Record<TextField | ListField, string>>>({});
  const [notice, setNotice] = useState("");
  const text = (field: TextField, label: string, rows?: number) => ({
    field, label, rows, original: content[field] ?? "", parse: (value: string) => value,
  });
  const list = (field: ListField, label: string, rows: number) => ({
    field, label, rows, original: content[field]?.join("\n") ?? "", parse: lines,
  });
  const fields = [
    { ...text("title", "标题"), enabled: true },
    { ...text("itemHighlights", "商品亮点 (Item Highlights)", 2), enabled: listingFieldEnabled("itemHighlights", rules) },
    { ...text("subtitle", "促销副标题"), enabled: listingFieldEnabled("subtitle", rules) },
    { ...list("bulletPoints", domestic ? "卖点短句" : "五点描述", 4), enabled: true },
    { ...text("description", "商品描述", 4), enabled: true },
    { ...list("searchTerms", "后台搜索词", 2), enabled: listingFieldEnabled("searchTerms", rules) },
    { ...list("tags", "商品标签 (Tags)", 3), enabled: listingFieldEnabled("tags", rules) },
    { ...text("seoTitle", "SEO Meta Title"), enabled: listingFieldEnabled("seoTitle", rules) },
    { ...text("seoDescription", "SEO Meta Description", 3), enabled: listingFieldEnabled("seoDescription", rules) },
    { ...list("hashtags", "话题标签 (#Tag)", 3), enabled: listingFieldEnabled("hashtags", rules) },
    { ...list("missingFacts", "待补充事实", 2), enabled: false },
  ];
  const updates = fields.flatMap(({ field, enabled, original, parse }) => {
    const value = edits[field];
    return enabled && value !== undefined && value !== original ? [[field, parse(value)] as const] : [];
  });
  const patch = Object.fromEntries(updates);
  const counts = listingFieldCounts({ ...content, ...patch }, rules);
  return (
    <div className="lc-fields">
      {fields.filter(({ enabled, original }) => enabled || original).map(({ field, label, rows, enabled, original }) => (
        <CopyField key={field} label={label} rows={rows} readOnly={!editable || !enabled} notify={setNotice}
          value={enabled ? edits[field] ?? original : original}
          update={(value) => setEdits((previous) => ({ ...previous, [field]: value }))}
          counts={counts.filter((count) => count.field === field)}
          itemLimit={field === "tags" && enabled ? rules?.tagMaxLength : undefined} />
      ))}
      <div className="lc-row">
        {editable && <button className="ss-primary" disabled={!updates.length} onClick={() => save(patch)}>保存为新版本</button>}
        <span role="status" className="ss-help">{notice}</span>
      </div>
    </div>
  );
}

export function ListingCopyResult({ job, blocked, domestic, rules, save, regenerate }: {
  job: ApiListingJob;
  blocked: boolean;
  domestic: boolean;
  rules?: ListingRules;
  save: (content: Partial<ApiListingContent>) => void;
  regenerate: () => void;
}) {
  const [selected, setSelected] = useState<string>();
  const latest = job.versions[job.versions.length - 1];
  const version = job.versions.find((v) => v.id === selected) ?? latest;
  const canWrite = !blocked && job.status !== "running";
  return (
    <div className="lc-result">
      <div className="lc-row lc-result-head">
        <span role="status" className="lc-status" data-status={job.status}>{listingStatuses[job.status]}</span>
        {job.status !== "draft" && <button disabled={!canWrite || !job.inputImages.length}
          onClick={() => { setSelected(undefined); regenerate(); }}>重新生成</button>}
      </div>
      {job.status === "failed" && <p role="alert" className="lc-error">{listingMessage(job.errorCode ?? "LISTING_GENERATION_FAILED")}</p>}
      {version && <>
        <VersionEditor key={version.id} content={version.content} domestic={domestic} rules={rules} editable={canWrite && version.id === latest?.id}
          save={save} />
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
