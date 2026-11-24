import { useState } from "react";
import { suiteApi, type ApiPlatformProfile } from "../../api/client";
import { SUITE_CATEGORY_GROUPS, SUITE_CATEGORY_NAMES } from "../../../shared/suite-categories";
import { pipelineErrorMessages } from "../../../shared/suite-pipeline-errors";
import type { ResolvedDeliverySlot } from "../../../shared/workbench-delivery";
import { ListingCopyDrawer } from "../listing-copy/ListingCopyDrawer";
import { download, fromRun, message, studioApi, totalImages, type StudioState } from "./studio";
import { StudioDialog } from "./StudioDialog";
import {
  JOB_SUCCESS_STATUSES,
  readImageEditJobStatus,
  readRetryJobStatus,
  StudioImageEditorHost,
  useResultJob,
} from "./StudioResultShared";

const phaseOrder: Record<string, number> = {
  base_refining: 0,
  structure_planning: 1,
  category_prompting: 2,
  image_generating: 3,
  done: 4,
};
const auxiliaryCategories = new Set<string>(SUITE_CATEGORY_GROUPS.other.categories);
const statuses: Record<string, string> = {
  running: "生成中",
  completed: "已完成",
  partial_failed: "部分失败",
  failed: "生成失败",
  waiting_human_input: "等待补录",
  waiting_base_refine_decision: "精修暂停",
};
const listingCopyBadgeLabels: Record<"running" | "succeeded" | "failed", string> = {
  running: "生成文案中…",
  succeeded: "文案已生成",
  failed: "文案失败",
};
const phaseErrors: Record<string, string> = {
  structure_planning: "STRUCTURE_PLAN_FAILED",
  category_prompting: "CATEGORY_PROMPT_FAILED",
  image_generating: "IMAGE_GENERATION_FAILED",
  done: "IMAGE_GENERATION_FAILED",
};
type StepState = "done" | "active" | "pending" | "failed";

function runningBadgeText(phase: string, completed: number, total: number): string {
  switch (phase) {
    case "base_refining":
      return "白底精修中…";
    case "structure_planning":
      return "规划结构中…";
    case "category_prompting":
      return "生成提示词中…";
    case "image_generating":
      return total > 0 ? `生成图片中 ${completed}/${total}` : "生成图片中…";
    default:
      return "生成中…";
  }
}

function placeholderPhaseText(phase: string, index: number): string {
  const num = String(index).padStart(2, "0");
  switch (phase) {
    case "base_refining":
      return `白底精修中 · ${num}`;
    case "structure_planning":
      return "规划结构中…";
    case "category_prompting":
      return "编写提示词中…";
    case "image_generating":
      return `生成图片中 · ${num}`;
    default:
      return `等待出图 · ${num}`;
  }
}

function buildProgressModel(
  run: StudioState["pipeline"],
  listingCopy: StudioState["listingCopy"],
  listingCopyEnabled: boolean,
  completed: number,
  total: number,
) {
  const running = run?.status === "running";
  const listingCopyRunning = listingCopy?.status === "running";
  const currentPhase = run?.currentPhase ?? "structure_planning";
  const currentOrder = phaseOrder[currentPhase] ?? 1;

  const baseSteps: Array<{ key: string; index: string; label: string; order: number }> = [
    ...(currentPhase === "base_refining" ? [{ key: "base_refining", index: "0", label: "白底精修", order: 0 }] : []),
    { key: "structure_planning", index: "1", label: "规划结构", order: 1 },
    { key: "category_prompting", index: "2", label: "生成提示词", order: 2 },
    {
      key: "image_generating",
      index: "3",
      label: total > 0 ? `生成图片 (${completed}/${total})` : "生成图片",
      order: 3,
    },
  ];

  const steps: Array<{ key: string; index: string; label: string; state: StepState }> = baseSteps.map((step) => {
    let state: StepState = "pending";
    if (running) {
      if (step.order < currentOrder) state = "done";
      else if (step.order === currentOrder) state = "active";
    } else if (run?.status === "completed") {
      state = "done";
    } else if (run?.status === "partial_failed" || run?.status === "failed") {
      const failOrder = currentPhase === "done" ? 3 : currentOrder;
      if (step.order < failOrder) state = "done";
      else if (step.order === failOrder) state = "failed";
    }
    return { key: step.key, index: step.index, label: step.label, state };
  });

  let copyStep: { label: string; state: StepState } | null = null;
  if (listingCopyEnabled || listingCopy) {
    if (listingCopy?.status === "running") copyStep = { label: "生成文案中…", state: "active" };
    else if (listingCopy?.status === "succeeded") copyStep = { label: "文案已生成", state: "done" };
    else if (listingCopy?.status === "failed") copyStep = { label: "文案生成失败", state: "failed" };
    else copyStep = { label: "等待规划", state: "pending" };
  }

  let percent = 15;
  let headline = "正在生成套图…";
  if (running) {
    switch (currentPhase) {
      case "base_refining":
        percent = 10;
        headline = "正在进行商品白底精修，优化主体与背景…";
        break;
      case "structure_planning":
        percent = 18;
        headline = "正在分析商品原图与卖点，规划套图结构…";
        break;
      case "category_prompting":
        percent = 34;
        headline = listingCopyRunning
          ? "正在编写各分类生图提示词，同时并行生成上架文案…"
          : "正在为各分类编写生图提示词与构图指令…";
        break;
      case "image_generating": {
        const ratio = total > 0 ? Math.min(1, completed / total) : 0;
        percent = Math.round(38 + ratio * (listingCopyRunning ? 54 : 60));
        headline = listingCopyRunning
          ? `正在生成商品图片（${completed}/${total}），并行生成上架文案中…`
          : `正在逐张生成商品图片（已完成 ${completed}/${total} 张）…`;
        break;
      }
      default:
        percent = 95;
        headline = "正在整理生成结果…";
        break;
    }
  } else if (listingCopyRunning) {
    percent = 92;
    headline = "套图已生成，正在并行生成商品上架文案…";
  }

  return { steps, copyStep, percent, headline };
}
type Props = {
  state: StudioState;
  profiles: ApiPlatformProfile[];
  sizes: string[];
  refresh: (id: string) => Promise<void>;
  onEdit: (s: StudioState) => void;
  onDelete: (id: string) => void;
  onActivate: (id: string) => void;
  navigate: (path: string) => void;
};

export function BatchResults({
  state: s,
  profiles,
  sizes,
  refresh,
  onEdit,
  onDelete,
  onActivate,
  navigate,
}: Props) {
  const id = s.suite.id,
    run = s.pipeline,
    c = fromRun(run),
    running = run?.status === "running",
    listingCopyStatus = s.listingCopy?.status,
    listingCopyRunning = listingCopyStatus === "running",
    showProgress = running || listingCopyRunning,
    slots = s.cards,
    ready = slots.filter((x) => x.previewUrl),
    total = slots.length || totalImages(c);
  const convergedComplete =
    !running &&
    slots.length > 0 &&
    ready.length === slots.length &&
    (run?.status === "partial_failed" || run?.status === "failed");
  const effectiveStatus = convergedComplete ? "completed" : run?.status;
  const effectiveRun = convergedComplete && run
    ? { ...run, status: "completed" as const, errorCode: null, errorMessage: null }
    : run;
  const progressModel = showProgress
    ? buildProgressModel(effectiveRun, s.listingCopy, c.listingCopy, s.progress.completed, total)
    : null;
  const persistedMessage = convergedComplete ? "" : run?.errorMessage?.trim();
  const errorMessage = convergedComplete
    ? null
    : persistedMessage && !/^[A-Z][A-Z0-9_]*$/.test(persistedMessage)
      ? persistedMessage
      : run && (run.errorCode || persistedMessage)
        ? pipelineErrorMessages[run.errorCode ?? persistedMessage ?? ""] ??
          pipelineErrorMessages[phaseErrors[run.currentPhase]] ?? pipelineErrorMessages.PIPELINE_FAILED
        : null;
  const [picked, setPicked] = useState<string[]>([]),
    [menu, setMenu] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [supplement, setSupplement] = useState("");
  const [preview, setPreview] = useState<{ url: string; title: string } | null>(null);
  const [editCard, setEditCard] = useState<ResolvedDeliverySlot | null>(null);
  const [editJob, setEditJob] = useState("");
  const [retryJob, setRetryJob] = useState(""),
    [retrySize, setRetrySize] = useState<Record<string, string>>({});
  const [showListingCopy, setShowListingCopy] = useState(false);
  const act = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setMenu(false);
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setNotice(message(e));
    } finally {
      setBusy(false);
    }
  };
  useResultJob(
    retryJob,
    readRetryJobStatus,
    JOB_SUCCESS_STATUSES,
    id,
    refresh,
    setRetryJob,
    setNotice,
    "图片生成失败，可在创作板查看详情。",
  );
  useResultJob(
    editJob,
    readImageEditJobStatus,
    JOB_SUCCESS_STATUSES,
    id,
    refresh,
    setEditJob,
    setNotice,
    "图片生成失败，可在创作板查看详情。",
  );
  const resume = (action: string, fields?: object) =>
    void act(async () => {
      await studioApi.resume(id, action, fields);
      onActivate(id);
      await refresh(id);
    });
  const retry = (card: ResolvedDeliverySlot) =>
    void act(async () => {
      const size = retrySize[card.parentTaskId];
      if (size)
        await suiteApi.batchUpdateTaskParams(id, {
          taskIds: [card.parentTaskId],
          generationParams: { size },
        });
      const result = await suiteApi.generateTask(card.parentTaskId);
      setRetryJob(result.batchId);
      setNotice("已提交单张生成。");
    });
  const selected = ready.map((card) => card.parentTaskId).filter((task) => picked.includes(task));
  const structure = s.planning.snapshot?.structure,
    missing = structure?.categoryAllocations.filter((a) => a.missingFacts.some((fact) => fact.trim())) ?? [];
  const originals = s.inputImages[0];
  return (
    <section className="ss-batch" role="region" aria-label="生成批次">
      <header className="ss-batch-head">
        <label>
          <input
            aria-label="全选本批次"
            type="checkbox"
            disabled={!ready.length}
            checked={!!ready.length && selected.length === ready.length}
            onChange={(e) => setPicked(e.target.checked ? ready.map((x) => x.parentTaskId) : [])}
          />
        </label>
        <div className="ss-batch-title">
          <h3>{s.suite.name}</h3>
          <small>
            {new Date(s.suite.createdAt).toLocaleString()} · {slots.length} 张结果
          </small>
        </div>
        <span data-status={effectiveStatus ?? "historical"} className="ss-status">
          {running && <span className="ss-status-dot" aria-hidden="true" />}
          {running
            ? runningBadgeText(run.currentPhase, s.progress.completed, total)
            : (statuses[effectiveStatus ?? ""] ?? "历史批次")}
        </span>
        {(listingCopyStatus === "running" ||
          listingCopyStatus === "succeeded" ||
          listingCopyStatus === "failed") && (
          <button
            type="button"
            className="ss-copy-status"
            data-copy-status={listingCopyStatus}
            onClick={() => setShowListingCopy(true)}
          >
            {listingCopyStatus === "running" && <span className="ss-status-dot" aria-hidden="true" />}
            {listingCopyBadgeLabels[listingCopyStatus]}
          </button>
        )}
        <button onClick={() => setShowListingCopy(true)}>上架文案</button>
        <button
          disabled={!selected.length || busy}
          onClick={() => void act(() => download(studioApi.exportUrl(id, selected), `${s.suite.name}.zip`))}
        >
          下载所选（{selected.length}）
        </button>
        <div className="ss-menu">
          <button aria-label="批次菜单" aria-expanded={menu} onClick={() => setMenu(!menu)}>
            ···
          </button>
          {menu && (
            <div className="ss-menu-list">
              <button
                onClick={() => {
                  setMenu(false);
                  onEdit(s);
                }}
              >
                编辑同款配置
              </button>
              <button
                onClick={() =>
                  void act(async () => {
                    const name = window.prompt("新的批次名称", s.suite.name)?.trim();
                    if (name) {
                      await suiteApi.rename(id, name);
                      await refresh(id);
                    }
                  })
                }
              >
                重命名
              </button>
              <button onClick={() => navigate(`/create/canvas/${id}`)}>进入创作板精修</button>
              <button onClick={() => navigate(`/create/canvas/${id}?view=gallery`)}>
                货架预览导出
              </button>
              <button
                disabled={running}
                onClick={() =>
                  void act(async () => {
                    if (window.confirm(`删除批次「${s.suite.name}」及其图片？`)) {
                      await suiteApi.delete(id);
                      onDelete(id);
                    }
                  })
                }
              >
                删除
              </button>
            </div>
          )}
        </div>
      </header>
      {progressModel && (
        <div className="ss-progress">
          <div className="ss-progress-head">
            <strong>{progressModel.headline}</strong>
            <span className="ss-progress-pct">{progressModel.percent}%</span>
          </div>
          <div
            className="ss-progress-track"
            role="progressbar"
            aria-label="套图生成进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progressModel.percent}
            aria-valuetext={`${progressModel.percent}% · ${progressModel.headline}`}
          >
            <div className="ss-progress-fill" style={{ width: `${progressModel.percent}%` }} />
          </div>
          <ol className="ss-progress-steps" aria-label="生成阶段进度">
            {progressModel.steps.map((step) => (
              <li key={step.key} className="ss-step" data-step-state={step.state}>
                <span className="ss-step-badge" aria-hidden="true">
                  {step.state === "done" ? "✓" : step.index}
                </span>
                <span>{step.label}</span>
              </li>
            ))}
            {progressModel.copyStep && (
              <li className="ss-step ss-step-copy" data-step-state={progressModel.copyStep.state}>
                <span className="ss-step-badge" aria-hidden="true">
                  {progressModel.copyStep.state === "done" ? "✓" : "文"}
                </span>
                <span>上架文案 · {progressModel.copyStep.label}</span>
              </li>
            )}
          </ol>
        </div>
      )}
      {errorMessage && !running && <p className="ss-note">{errorMessage}</p>}
      {run?.status === "waiting_base_refine_decision" && (
        <div className="ss-pause">
          <b>白底精修失败</b>
          <button disabled={busy} onClick={() => resume("retry_base_refine")}>
            重试精修
          </button>
          {profiles.some((p) => p.code === c.platform && p.mainImageBackground !== "pure_white_required") && (
            <button disabled={busy} onClick={() => resume("skip_base_refine")}>
              用原图继续
            </button>
          )}
        </div>
      )}
      {run?.status === "waiting_human_input" && (
        <div className="ss-pause">
          <strong>补充商品事实后继续</strong>
          <small>
            {[
              ...(structure?.mainAllocation?.missingFacts ?? []),
              ...missing.filter((a) => a.count !== 0 || !auxiliaryCategories.has(a.category))
                .flatMap((a) => a.missingFacts.filter((fact) => fact.trim())),
            ].join("；")}
          </small>
          <textarea
            aria-label="补充商品事实"
            value={supplement}
            onChange={(e) => setSupplement(e.target.value)}
          />
          <button
            disabled={busy || !supplement.trim()}
            onClick={() => resume("submit_missing_facts", { supplementText: supplement })}
          >
            提交补录并继续
          </button>
          {[
            ["selling_points", "卖点图", ["feature_benefit", "material_detail"]],
            ["lifestyle", "场景图", ["lifestyle_use"]],
          ].map(
            ([key, label, codes]) =>
              missing.some((a) => (codes as string[]).includes(a.category)) && (
                <button
                  key={String(key)}
                  disabled={busy}
                  onClick={() => resume("submit_missing_facts", { counts: { [String(key)]: 0 } })}
                >
                  将{label}改为 0 张并继续
                </button>
              ),
          )}
        </div>
      )}
      {!convergedComplete && run?.errorCode === "PIPELINE_INTERRUPTED" && (
        <button disabled={busy} onClick={() => resume("resume_after_interrupt")}>
          继续中断的批次
        </button>
      )}
      <div className="ss-grid">
        {originals && (
          <figure className="ss-original">
            <button onClick={() => setPreview({ url: originals.originalPreviewUrl, title: "商品原图" })}>
              <img src={originals.thumbnailPreviewUrl} alt="商品原图" />
            </button>
            <figcaption>原图</figcaption>
          </figure>
        )}
        {slots.map((card, index) => {
          const task = card.parentTaskId,
            type =
              SUITE_CATEGORY_NAMES[String(card.promptSnapshot.categoryCode)] ??
              (card.imageType === "main" ? "主图" : "详情图");
          return (
            <article
              key={task}
              data-result-card
              className={"ss-card" + (picked.includes(task) ? " selected" : "")}
            >
              <div className={"ss-photo" + (!card.previewUrl && running ? " is-pending" : "")}>
                {card.previewUrl ? (
                  <>
                    <button
                      aria-label={"放大 " + card.title}
                      onClick={() => setPreview({ url: card.previewUrl!, title: card.title })}
                    >
                      <img src={card.previewUrl} alt={card.title} />
                    </button>
                    <input
                      type="checkbox"
                      aria-label={"选择 " + card.title}
                      checked={picked.includes(task)}
                      onChange={(e) =>
                        setPicked((p) => (e.target.checked ? [...p, task] : p.filter((x) => x !== task)))
                      }
                    />
                  </>
                ) : (
                  <span className={running ? "ss-skeleton-label" : undefined}>
                    {running ? placeholderPhaseText(run.currentPhase, index + 1) : "未生成"}
                  </span>
                )}
                <strong data-type-badge title={card.title}>
                  {type}
                </strong>
              </div>
              <div className="ss-actions">
                {card.previewUrl && (
                  <>
                    <button
                      onClick={() =>
                        void act(() => download(card.previewUrl!, card.exportFilename ?? `${card.title}.png`))
                      }
                    >
                      下载
                    </button>
                    <button
                      disabled={busy || !!editJob || !card.versionId}
                      onClick={() => setEditCard(card)}
                    >
                      编辑图片
                    </button>
                  </>
                )}
                {!running && (
                  <>
                    <select
                      aria-label={"重试分辨率 " + card.title}
                      value={retrySize[task] ?? ""}
                      onChange={(e) => setRetrySize({ ...retrySize, [task]: e.target.value })}
                    >
                      <option value="">原分辨率</option>
                      {sizes.map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                    <button disabled={busy || !!retryJob} onClick={() => retry(card)}>
                      {card.previewUrl ? "重新生成" : "失败重试"}
                    </button>
                  </>
                )}
              </div>
            </article>
          );
        })}
        {running &&
          !slots.length &&
          Array.from({ length: total }, (_, i) => (
            <div key={i} className="ss-placeholder is-loading">
              <span className="ss-skeleton-label">{placeholderPhaseText(run.currentPhase, i + 1)}</span>
              <small className="ss-placeholder-num">{String(i + 1).padStart(2, "0")}</small>
            </div>
          ))}
      </div>
      {s.planning.notGeneratedReasons.map((r) => (
        <small key={r.category}>
          {SUITE_CATEGORY_NAMES[r.category]}：{r.reasons.join("；")}
        </small>
      ))}
      {notice && (
        <p role="status" className="ss-note">
          {notice}
        </p>
      )}
      {showListingCopy && <ListingCopyDrawer state={s} profiles={profiles} close={() => setShowListingCopy(false)} />}
      <StudioImageEditorHost
        card={editCard}
        onClose={() => setEditCard(null)}
        onEditJobStarted={setEditJob}
        onRetryJobStarted={setRetryJob}
        onNotify={setNotice}
      />
      {preview && (
        <StudioDialog title={preview.title} close={() => setPreview(null)}>
          <img className="ss-zoom" src={preview.url} alt={preview.title} />
        </StudioDialog>
      )}
    </section>
  );
}
