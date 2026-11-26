import { useRef, useState } from "react";
import { APLUS_MODULES, APLUS_SIZE_PRESETS, type AplusModuleCode, type AplusSizePresetKey } from "../../../shared/aplus";
import { sanitizeDeliveryName } from "../../../shared/workbench-delivery";
import { createGenerationActions } from "../../api/client";
import { ResultCardActions, type ResultCardEditor } from "../../components/suite-studio/ResultCardActions";
import { StudioDialog } from "../../components/suite-studio/StudioDialog";
import {
  JOB_SUCCESS_STATUSES, readImageEditJobStatus, readRetryJobStatus, StudioImageEditorHost, useResultJob,
} from "../../components/suite-studio/StudioResultShared";
import { download, message } from "../../components/suite-studio/studio";
import { Icon } from "../../pages/shared";
import { aplusApi, type AplusDraft, type AplusResultCard } from "./aplus-studio";

type Job = AplusDraft["job"];

function deliveryUrl(card: AplusResultCard) {
  if (!card.previewUrl) return null;
  if (card.deliveryObjectKey) return `${card.previewUrl}/delivery`;
  return APLUS_SIZE_PRESETS[card.sizePreset].deliverySize ? null : card.previewUrl;
}

function canExport(card: AplusResultCard) {
  return card.taskStatus !== "failed" && Boolean(deliveryUrl(card));
}

export function AplusResultCards({
  suiteId, suiteName, cards, sizes, disabled, job, onJob, refresh, onNotice,
}: {
  suiteId: string;
  suiteName: string;
  cards: AplusResultCard[];
  sizes: AplusSizePresetKey[];
  disabled: boolean;
  job: Job;
  onJob: (job: Job) => void;
  refresh: () => Promise<void>;
  onNotice: (notice: string) => void;
}) {
  const [submitGeneration] = useState(createGenerationActions);
  const [editor, setEditor] = useState<ResultCardEditor | null>(null);
  const [dragged, setDragged] = useState<AplusModuleCode | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const pressedControl = useRef(false);
  const [preview, setPreview] = useState<AplusSizePresetKey | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [singlePreview, setSinglePreview] = useState<{ url: string; title: string } | null>(null);
  const draggedControl = useRef(false);
  const [working, setWorking] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const orderedCards = [...cards].sort((a, b) => a.sortOrder - b.sortOrder);
  const modules = [...new Set(orderedCards.map(({ moduleCode }) => moduleCode))];
  const canReorder = modules.length > 1 && !disabled && !working && !job;
  const filename = sanitizeDeliveryName(suiteName, "Aplus");
  const previewRevision = preview && orderedCards
    .filter((card) => card.sizePreset === preview && canExport(card))
    .map((card) => card.versionId).join(",");

  useResultJob(
    job?.id ?? "", job?.kind === "edit" ? readImageEditJobStatus : readRetryJobStatus,
    JOB_SUCCESS_STATUSES, suiteId, refresh, () => onJob(null), onNotice,
  );

  async function act(action: () => Promise<void>) {
    setWorking(true);
    setDialogError("");
    try {
      await action();
    } catch (error) {
      if (preview) setDialogError(message(error));
      else onNotice(message(error));
    } finally {
      setWorking(false);
    }
  }

  function downloadCard(card: AplusResultCard) {
    const url = deliveryUrl(card);
    if (!url) return;
    const name = card.exportFilename ?? `${card.title}.png`;
    const cropped = APLUS_SIZE_PRESETS[card.sizePreset].deliverySize;
    void act(() => download(url, cropped ? name.replace(/\.[^./]+$/, ".png") : name));
  }

  function moveModule(from: AplusModuleCode, target: AplusModuleCode) {
    if (!canReorder || from === target) return;
    const to = modules.indexOf(target);
    const next = modules.filter((code) => code !== from);
    next.splice(to, 0, from);
    void act(async () => {
      await aplusApi.reorder(suiteId, next);
      await refresh();
    });
  }

  function clearDrag() {
    pressedControl.current = false;
    setDragged(null);
    setDragOverId(null);
  }

  function downloadLongImage(preset: AplusSizePresetKey) {
    void act(() => download(aplusApi.longImageUrl(suiteId, preset), `${filename}_${preset.replace(":", "x")}_详情长图.png`));
  }

  return (
    <>
      <div className="aplus-export-actions">
        <button type="button" disabled={working || !cards.some(canExport)} onClick={() => void act(() => download(aplusApi.zipUrl(suiteId), `${filename}.zip`))}>下载 ZIP</button>
      </div>
      {sizes.map((key) => {
        const group = orderedCards.filter((card) => card.sizePreset === key);
        if (!group.length) return null;
        const size = APLUS_SIZE_PRESETS[key];
        return (
          <section className="aplus-results-group" key={key}>
            <div className="aplus-results-group-head">
              <h3>{size.name} <small>{size.deliverySize ? `${size.deliverySize.width}×${size.deliverySize.height}` : ""}</small></h3>
              <div className="aplus-export-actions">
                <button type="button" disabled={working || !group.some(canExport)} onClick={() => { setDialogError(""); setPreviewError(false); setPreview(key); }}>预览详情长图</button>
                <button type="button" disabled={working || !group.some(canExport)} onClick={() => downloadLongImage(key)}>下载详情长图</button>
              </div>
            </div>
            <div className="aplus-result-grid">
              {group.map((card) => {
                const title = APLUS_MODULES.find(({ code }) => code === card.moduleCode)?.name ?? card.title;
                const pending = job?.taskId === card.parentTaskId || card.taskStatus === "generating";
                const locked = disabled || working || Boolean(job) || pending;
                const url = deliveryUrl(card);
                const previewUrl = url ?? card.previewUrl;
                const isDropTarget = canReorder && dragged !== null && dragged !== card.moduleCode;
                return (
                  <article
                    className={`aplus-result-card${dragged === card.moduleCode ? " is-dragging" : ""}${dragOverId === card.parentTaskId ? " is-drag-over" : ""}`}
                    key={card.parentTaskId}
                    draggable={canReorder}
                    onPointerDownCapture={(event) => {
                      // Native dragstart targets the draggable article even when the press started on a button.
                      draggedControl.current = false;
                      pressedControl.current = event.target instanceof Element && Boolean(event.target.closest("button, a, input, select, textarea"));
                    }}
                    onPointerUpCapture={() => { pressedControl.current = false; }}
                    onDragStart={(event) => {
                      if (!canReorder || pressedControl.current) {
                        draggedControl.current = pressedControl.current;
                        event.preventDefault();
                        return;
                      }
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", card.moduleCode);
                      setDragged(card.moduleCode);
                    }}
                    onDragEnter={() => { if (isDropTarget) setDragOverId(card.parentTaskId); }}
                    onDragOver={(event) => { if (isDropTarget) event.preventDefault(); }}
                    onDragLeave={(event) => {
                      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
                      setDragOverId((id) => id === card.parentTaskId ? null : id);
                    }}
                    onDrop={(event) => {
                      if (!isDropTarget) return;
                      event.preventDefault();
                      moveModule(dragged, card.moduleCode);
                      clearDrag();
                    }}
                    onDragEnd={clearDrag}
                  >
                    <div className={`aplus-card-image${pending && !url && !card.previewUrl ? " is-pending" : ""}`} style={{ aspectRatio: size.ratio.replace(":", " / ") }}>
                      {previewUrl ? (
                        <button
                          type="button"
                          className="aplus-card-image-btn"
                          aria-label={`放大 ${title}`}
                          onClick={(event) => {
                            if (!draggedControl.current || event.detail === 0) setSinglePreview({ url: previewUrl, title });
                          }}
                        >
                          <img src={previewUrl} alt={title} loading="lazy" draggable={false} />
                        </button>
                      ) : <span>{pending ? "生成中…" : card.taskStatus === "failed" ? "生成失败" : "等待生成"}</span>}
                    </div>
                    <div className="aplus-card-body">
                      <div className="aplus-section-heading">
                        <strong className="aplus-plan-module-name">
                          {modules.length > 1 && (
                            <span role="img" aria-label={`拖动排序 ${title}`} className="aplus-drag-handle"><Icon name="move" /></span>
                          )}
                          <span className="aplus-result-title" title={title}>{title}</span>
                        </strong>
                        {pending && card.previewUrl && <small>更新中…</small>}
                        {card.deliverySize && !pending && <small>{card.deliverySize.width}×{card.deliverySize.height}</small>}
                      </div>
                      {card.errorMessage && !pending && <small role="status">{card.errorMessage}</small>}
                      <ResultCardActions
                        card={card}
                        disabled={locked}
                        onDownload={url ? () => downloadCard(card) : undefined}
                        onEdit={setEditor}
                        allowChangeText={card.actions.includes("change_text")}
                        submitGeneration={submitGeneration}
                        onRedrawStarted={(id) => onJob({ id, taskId: card.parentTaskId, kind: "redraw" })}
                        onArchived={refresh}
                      />
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        );
      })}
      {preview && (
        <StudioDialog title={`${APLUS_SIZE_PRESETS[preview].name}详情长图`} close={() => setPreview(null)} className="aplus-long-image">
          <div className="aplus-action-form">
            <button type="button" disabled={working} onClick={() => downloadLongImage(preview)}>下载详情长图</button>
            {dialogError && <p role="alert">{dialogError}</p>}
            {previewError
              ? <p role="alert">详情长图加载失败，请重新打开预览。</p>
              : <img src={aplusApi.longImageUrl(suiteId, preview, previewRevision ?? undefined)} alt="详情长图" onError={() => setPreviewError(true)} />}
          </div>
        </StudioDialog>
      )}
      {singlePreview && (
        <StudioDialog title={singlePreview.title} close={() => setSinglePreview(null)}>
          <img className="ss-zoom" src={singlePreview.url} alt={singlePreview.title} />
        </StudioDialog>
      )}
      <StudioImageEditorHost
        card={editor?.card ?? null}
        initialTool={editor?.initialTool}
        onClose={() => setEditor(null)}
        onEditJobStarted={(id, taskId) => onJob({ id, taskId, kind: "edit" })}
        onRetryJobStarted={(id, taskId) => onJob({ id, taskId, kind: "redraw" })}
        onNotify={onNotice}
      />
    </>
  );
}
