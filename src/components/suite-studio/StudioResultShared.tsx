import { useEffect } from "react";
import type { ResolvedDeliverySlot } from "../../../shared/workbench-delivery";
import { suiteApi } from "../../api/client";
import { ImageEditorModal } from "../../pages/WorkbenchBoardPage";
import { message } from "./studio";

export const JOB_SUCCESS_STATUSES = ["completed", "succeeded"] as const;

export const readRetryJobStatus = async (job: string) =>
  (await suiteApi.getBatch(job)).batch.status;

export const readImageEditJobStatus = async (job: string) =>
  ((await suiteApi.getImageEditTask(job)).task as { status: string }).status;

export function useResultJob(
  job: string,
  readStatus: (job: string) => Promise<string>,
  success: readonly string[],
  suiteId: string,
  refresh: (id: string) => Promise<void>,
  setJob: (id: string) => void,
  notify: (text: string) => void,
  failureMessage = "图片生成失败，请重试。",
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
        if (live) notify(success.includes(status) ? "图片已更新" : failureMessage);
      } catch (error) {
        if (live) notify(message(error));
      }
      if (live) setJob("");
    }
    let timer = setTimeout(poll, 1000);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [job, readStatus, success, suiteId, refresh, setJob, notify, failureMessage]);
}

export function StudioImageEditorHost({
  card,
  onClose,
  onEditJobStarted,
  onRetryJobStarted,
  onNotify,
}: {
  card: ResolvedDeliverySlot | null;
  onClose: () => void;
  onEditJobStarted: (childTaskId: string, parentTaskId: string) => void;
  onRetryJobStarted: (batchId: string, parentTaskId: string) => void;
  onNotify: (text: string) => void;
}) {
  if (!card || !card.versionId || !card.previewUrl) return null;
  const targetTaskId = card.editChildTaskId ?? card.parentTaskId;
  const parentTaskId = card.parentTaskId;
  return (
    <ImageEditorModal
      task={{ id: targetTaskId, title: card.title, promptDraft: card.promptText }}
      version={{
        id: card.versionId,
        versionNumber: card.versionNumber ?? 1,
        previewUrl: card.previewUrl,
        width: card.width ?? 1024,
        height: card.height ?? 1024,
        promptSnapshot: card.promptSnapshot,
      }}
      onClose={onClose}
      onOperationAdded={async (op, summary) => {
        await suiteApi.upsertImageEditOperation(
          targetTaskId,
          op as unknown as Record<string, unknown>,
          summary,
        );
      }}
      onSubmit={async (spec, instruction) => {
        const ops = Array.isArray(spec.operations) ? spec.operations : [];
        for (const op of ops) {
          await suiteApi.upsertImageEditOperation(
            targetTaskId,
            op as Record<string, unknown>,
            instruction,
          );
        }
        const res = await suiteApi.submitImageEdit(targetTaskId, {
          sourceCardId: targetTaskId,
          sourceVersionId: String(spec.sourceVersionId ?? card.versionId),
          parentVersionId: String(spec.sourceVersionId ?? card.versionId),
          summary: instruction,
        });
        onClose();
        onEditJobStarted(String((res.childTask as { id: string }).id), parentTaskId);
        onNotify("已提交图片编辑，正在生成图片…");
      }}
      onRegenerate={async () => {
        if (card.editChildTaskId) {
          await suiteApi.regenerateImageEditTask(card.editChildTaskId, card.promptText);
          onClose();
          onEditJobStarted(card.editChildTaskId, parentTaskId);
          onNotify("已提交再次生成，正在更新图片…");
        } else {
          const result = await suiteApi.generateTask(card.parentTaskId);
          onClose();
          onRetryJobStarted(result.batchId, parentTaskId);
          onNotify("已提交单张生成。");
        }
      }}
    />
  );
}
