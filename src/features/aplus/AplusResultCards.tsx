import { useState } from "react";
import { APLUS_ADDITIONAL_PROMPT_MAX_LENGTH, APLUS_MODULES, APLUS_SIZE_PRESETS, type AplusSizePresetKey } from "../../../shared/aplus";
import { suiteApi } from "../../api/client";
import { StudioDialog } from "../../components/suite-studio/StudioDialog";
import {
  JOB_SUCCESS_STATUSES, readImageEditJobStatus, readRetryJobStatus, StudioImageEditorHost, useResultJob,
} from "../../components/suite-studio/StudioResultShared";
import { download, message } from "../../components/suite-studio/studio";
import { aplusApi, type AplusDraft, type AplusResultCard } from "./aplus-studio";

type Job = AplusDraft["job"];

export function AplusResultCards({
  suiteId, cards, sizes, disabled, job, onJob, refresh, onNotice,
}: {
  suiteId: string;
  cards: AplusResultCard[];
  sizes: AplusSizePresetKey[];
  disabled: boolean;
  job: Job;
  onJob: (job: Job) => void;
  refresh: () => Promise<void>;
  onNotice: (notice: string) => void;
}) {
  const [editor, setEditor] = useState<AplusResultCard | null>(null);
  const [redraw, setRedraw] = useState<AplusResultCard | null>(null);
  const [prompt, setPrompt] = useState("");
  const [deleting, setDeleting] = useState<AplusResultCard | null>(null);
  const [working, setWorking] = useState(false);
  const [dialogError, setDialogError] = useState("");

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
      if (redraw || deleting) setDialogError(message(error));
      else onNotice(message(error));
    } finally {
      setWorking(false);
    }
  }

  function downloadCard(card: AplusResultCard) {
    if (!card.previewUrl) return;
    const url = card.deliveryObjectKey ? `${card.previewUrl}/delivery` : card.previewUrl;
    void act(() => download(url, card.exportFilename ?? `${card.title}.png`));
  }

  return (
    <>
      {sizes.map((key) => {
        const group = cards.filter((card) => card.sizePreset === key).sort((a, b) => a.sortOrder - b.sortOrder);
        if (!group.length) return null;
        const size = APLUS_SIZE_PRESETS[key];
        return (
          <section className="aplus-results-group" key={key}>
            <h3>{size.name} <small>{size.deliverySize ? `${size.deliverySize.width}×${size.deliverySize.height}` : ""}</small></h3>
            <div className="aplus-result-grid">
              {group.map((card) => {
                const title = APLUS_MODULES.find(({ code }) => code === card.moduleCode)?.name ?? card.title;
                const pending = job?.taskId === card.parentTaskId || card.taskStatus === "generating";
                const locked = disabled || working || Boolean(job) || pending;
                return (
                  <article className="aplus-result-card" key={card.parentTaskId}>
                    <div className="aplus-card-image" style={{ aspectRatio: size.ratio.replace(":", " / ") }}>
                      {card.previewUrl
                        ? <img src={card.previewUrl} alt={title} loading="lazy" />
                        : <span>{pending ? "生成中…" : card.taskStatus === "failed" ? "生成失败" : "等待生成"}</span>}
                    </div>
                    <div className="aplus-card-body">
                      <div className="aplus-section-heading">
                        <strong>{title}</strong>
                        {pending && card.previewUrl && <small>更新中…</small>}
                        {card.deliverySize && !pending && <small>{card.deliverySize.width}×{card.deliverySize.height}</small>}
                      </div>
                      {card.errorMessage && !pending && <small role="status">{card.errorMessage}</small>}
                      <div className="aplus-card-actions">
                        <button type="button" disabled={!card.previewUrl || working} onClick={() => downloadCard(card)}>下载</button>
                        <button type="button" disabled={locked} onClick={() => { setDialogError(""); setPrompt(""); setRedraw(card); }}>重绘</button>
                        <button type="button" disabled={locked || !card.previewUrl} onClick={() => setEditor(card)}>图片编辑</button>
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
        card={editor}
        onClose={() => setEditor(null)}
        onEditJobStarted={(id, taskId) => onJob({ id, taskId, kind: "edit" })}
        onRetryJobStarted={(id, taskId) => onJob({ id, taskId, kind: "redraw" })}
        onNotify={onNotice}
      />
    </>
  );
}
