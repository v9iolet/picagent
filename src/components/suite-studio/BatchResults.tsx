import { useEffect, useState } from "react";
import { suiteApi, type ApiPlatformProfile, type ApiWorkbench } from "../../api/client";
import { SUITE_CATEGORY_GROUPS, SUITE_CATEGORY_NAMES } from "../../../shared/suite-categories";
import { pipelineErrorMessages } from "../../../shared/suite-pipeline-errors";
import type { ResolvedDeliverySlot } from "../../../shared/workbench-delivery";
import { DeliveryGalleryView } from "../DeliveryGalleryView";
import { ListingCopyDrawer } from "../listing-copy/ListingCopyDrawer";
import { download, fromRun, message, studioApi, totalImages, type StudioState } from "./studio";
import { EditTextDialog, StudioDialog } from "./StudioDialog";

const phases: Record<string, string> = {
  base_refining: "白底精修",
  structure_planning: "规划结构",
  category_prompting: "生成提示词",
  image_generating: "逐张出图",
  done: "完成",
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
const phaseErrors: Record<string, string> = {
  structure_planning: "STRUCTURE_PLAN_FAILED",
  category_prompting: "CATEGORY_PROMPT_FAILED",
  image_generating: "IMAGE_GENERATION_FAILED",
  done: "IMAGE_GENERATION_FAILED",
};
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
const editStatus = async (job: string) =>
  ((await suiteApi.getImageEditTask(job)).task as { status: string }).status;
const retryStatus = async (job: string) => (await suiteApi.getBatch(job)).batch.status;

// Each invocation owns the timer and completion state of a single job.
function useResultJob(
  job: string, readStatus: (job: string) => Promise<string>, success: readonly string[], suiteId: string,
  refresh: Props["refresh"], setJob: (id: string) => void, notify: (text: string) => void,
) {
  useEffect(() => {
    if (!job) return;
    let live = true;
    async function poll() {
      try {
        const status = await readStatus(job);
        if (!live) return;
        if (status === "running" || status === "generating") {
          timer = setTimeout(poll, 3000);
          return;
        }
        await refresh(suiteId);
        if (live)
          notify(success.includes(status) ? "图片已更新" : "图片生成失败，可在创作板查看详情。");
      } catch (error) {
        if (live) notify(message(error));
      }
      if (live) setJob("");
    }
    let timer = setTimeout(poll, 1000);
    return () => { live = false; clearTimeout(timer); };
  }, [job, readStatus, success, suiteId, refresh, setJob, notify]);
}

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
    slots = s.cards,
    ready = slots.filter((x) => x.previewUrl),
    total = slots.length || totalImages(c);
  const persistedMessage = run?.errorMessage?.trim();
  const errorMessage = persistedMessage && !/^[A-Z][A-Z0-9_]*$/.test(persistedMessage)
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
  const [preview, setPreview] = useState<{ url: string; title: string } | null>(null),
    [edit, setEdit] = useState<ResolvedDeliverySlot | null>(null),
    [gallery, setGallery] = useState<ApiWorkbench | null>(null);
  const [editJob, setEditJob] = useState(""),
    [retryJob, setRetryJob] = useState(""),
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
  useResultJob(editJob, editStatus, ["completed", "succeeded"], id, refresh, setEditJob, setNotice);
  useResultJob(retryJob, retryStatus, ["completed", "succeeded"], id, refresh, setRetryJob, setNotice);
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
        <span data-status={run?.status ?? "historical"} className="ss-status">
          {statuses[run?.status ?? ""] ?? "历史批次"}
        </span>
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
              <button onClick={() => void act(async () => setGallery(await suiteApi.getWorkbench(id)))}>
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
      {running && (
        <div className="ss-progress">
          <strong>
            {phases[run.currentPhase]} · {s.progress.completed}/{total}
          </strong>
          <progress value={s.progress.completed} max={total} />
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
      {run?.errorCode === "PIPELINE_INTERRUPTED" && (
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
        {slots.map((card) => {
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
              <div className="ss-photo">
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
                  <span>{running ? "等待出图" : "未生成"}</span>
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
                      disabled={busy || !!editJob}
                      onClick={() =>
                        void act(async () => {
                          const { capabilities } = await suiteApi.imageEditorCapabilities();
                          if (!capabilities.changeText || !capabilities.ocr)
                            throw Error("当前渠道不支持识字或改字，请先在配置中选择支持的模型。");
                          setEdit(card);
                        })
                      }
                    >
                      编辑文字
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
            <div key={i} className="ss-placeholder">
              等待出图 · {String(i + 1).padStart(2, "0")}
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
      {gallery && (
        <StudioDialog title="货架预览导出" wide close={() => setGallery(null)}>
          <DeliveryGalleryView
            workbench={gallery}
            effectiveStyleGuide={gallery.effectiveStyleGuide ?? gallery.suite.styleOverride ?? ""}
            onPreview={(card) => {
              if (card.previewUrl) setPreview({ title: card.title, url: card.previewUrl });
            }}
            onNotify={setNotice}
          />
        </StudioDialog>
      )}
      {preview && (
        <StudioDialog title={preview.title} close={() => setPreview(null)}>
          <img className="ss-zoom" src={preview.url} alt={preview.title} />
        </StudioDialog>
      )}
      {edit && (
        <EditTextDialog
          card={edit}
          close={() => setEdit(null)}
          submitted={(job) => {
            setEdit(null);
            setEditJob(job);
            setNotice("已提交改字，正在生成图片。");
          }}
        />
      )}
    </section>
  );
}
