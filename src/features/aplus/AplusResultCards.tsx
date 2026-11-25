import { useState } from "react";
import { APLUS_ADDITIONAL_PROMPT_MAX_LENGTH, APLUS_MODULES, APLUS_SIZE_PRESETS, type AplusModuleCode, type AplusSizePresetKey } from "../../../shared/aplus";
import { sanitizeDeliveryName } from "../../../shared/workbench-delivery";
import { suiteApi } from "../../api/client";
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
  const [editor, setEditor] = useState<{ card: AplusResultCard; initialTool?: "restore_product" } | null>(null);
  const [dragged, setDragged] = useState<AplusModuleCode | null>(null);
  const [preview, setPreview] = useState<AplusSizePresetKey | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [redraw, setRedraw] = useState<AplusResultCard | null>(null);
  const [prompt, setPrompt] = useState("");
  const [deleting, setDeleting] = useState<AplusResultCard | null>(null);
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
      if (redraw || deleting || preview) setDialogError(message(error));
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
                const index = modules.indexOf(card.moduleCode);
                return (
                  <article
                    className={`aplus-result-card${dragged === card.moduleCode ? " is-dragging" : ""}`}
                    key={card.parentTaskId}
                    onDragOver={(event) => { if (dragged && canReorder) event.preventDefault(); }}
                    onDrop={(event) => {
                      if (!dragged || !canReorder) return;
                      event.preventDefault();
                      moveModule(dragged, card.moduleCode);
                      setDragged(null);
                    }}
                  >
                    <div className="aplus-card-image" style={{ aspectRatio: size.ratio.replace(":", " / ") }}>
                      {url || card.previewUrl
                        ? <img src={url ?? card.previewUrl!} alt={title} loading="lazy" />
                        : <span>{pending ? "生成中…" : card.taskStatus === "failed" ? "生成失败" : "等待生成"}</span>}
                    </div>
                    <div className="aplus-card-body">
                      <div className="aplus-section-heading">
                        <strong className="aplus-plan-module-name">
                          <span
                            role="img"
                            aria-label={`拖动排序 ${title}`}
                            className="aplus-drag-handle"
                            draggable={canReorder}
                            onDragStart={(event) => {
                              event.dataTransfer.effectAllowed = "move";
                              event.dataTransfer.setData("text/plain", card.moduleCode);
                              setDragged(card.moduleCode);
                            }}
                            onDragEnd={() => setDragged(null)}
                          ><Icon name="move" /></span>
                          {title}
                        </strong>
                        {modules.length > 1 && (
                          <div className="aplus-plan-actions">
                            <button type="button" aria-label={`上移 ${title}`} disabled={!canReorder || index === 0} onClick={() => moveModule(card.moduleCode, modules[index - 1])}>↑</button>
                            <button type="button" aria-label={`下移 ${title}`} disabled={!canReorder || index === modules.length - 1} onClick={() => moveModule(card.moduleCode, modules[index + 1])}>↓</button>
                          </div>
                        )}
                        {pending && card.previewUrl && <small>更新中…</small>}
                        {card.deliverySize && !pending && <small>{card.deliverySize.width}×{card.deliverySize.height}</small>}
                      </div>
                      {card.errorMessage && !pending && <small role="status">{card.errorMessage}</small>}
                      <div className="aplus-card-actions">
                        <button type="button" disabled={!url || working} onClick={() => downloadCard(card)}>下载</button>
                        <button type="button" disabled={locked} onClick={() => { setDialogError(""); setPrompt(""); setRedraw(card); }}>重绘</button>
                        <button type="button" disabled={locked || !card.previewUrl} onClick={() => setEditor({ card })}>图片编辑</button>
                        <button type="button" disabled={locked || !card.previewUrl} onClick={() => setEditor({ card, initialTool: "restore_product" })}>商品还原</button>
                        <button type="button" disabled={locked} onClick={() => { setDialogError(""); setDeleting(card); }}>删除</button>
                      </div>
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
      {redraw && (
        <StudioDialog title="重绘图片" close={() => { if (!working) setRedraw(null); }}>
          <form className="aplus-action-form" onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              const { batchId } = await aplusApi.redraw(redraw.parentTaskId, prompt.trim());
              onJob({ id: batchId, taskId: redraw.parentTaskId, kind: "redraw" });
              setRedraw(null);
            });
          }}>
            <label>
              附加提示词（选填）
              <textarea
                rows={4}
                maxLength={APLUS_ADDITIONAL_PROMPT_MAX_LENGTH}
                value={prompt}
                disabled={working}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </label>
            {dialogError && <p role="alert">{dialogError}</p>}
            <button className="ss-primary" type="submit" disabled={working}>确认重绘</button>
          </form>
        </StudioDialog>
      )}
      {deleting && (
        <StudioDialog title="删除结果卡" close={() => { if (!working) setDeleting(null); }}>
          <div className="aplus-action-form">
            <p>删除「{deleting.title}」当前结果卡？</p>
            {dialogError && <p role="alert">{dialogError}</p>}
            <button type="button" disabled={working} onClick={() => void act(async () => {
              await suiteApi.updateTask(deleting.parentTaskId, { status: "archived" });
              setDeleting(null);
              await refresh();
            })}>确认删除</button>
          </div>
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
