import { useEffect, useRef } from "react";
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
  const handlersRef = useRef({
    readStatus,
    success,
    refresh,
    setJob,
    notify,
    failureMessage,
  });
  handlersRef.current = {
    readStatus,
    success,
    refresh,
    setJob,
    notify,
    failureMessage,
  };

  useEffect(() => {
    if (!job) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const status = await handlersRef.current.readStatus(job);
        if (!live) return;
        if (status === "running" || status === "generating") {
          timer = setTimeout(poll, 3000);
          return;
        }
        await handlersRef.current.refresh(suiteId);
        if (live) {
          handlersRef.current.notify(
            handlersRef.current.success.includes(status)
              ? "图片已更新"
              : handlersRef.current.failureMessage,
          );
        }
      } catch (error) {
        if (live) handlersRef.current.notify(message(error));
      }
      if (live) handlersRef.current.setJob("");
    }
    timer = setTimeout(poll, 1000);
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [job, suiteId]);
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
      key={card.versionId}
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
      onSubmit={async (selection, instruction) => {
        const res = await suiteApi.submitImageEdit(targetTaskId, {
          ...selection,
          sourceCardId: targetTaskId,
          parentVersionId: selection.sourceVersionId,
          summary: instruction,
        });
        onClose();
        onEditJobStarted(String((res.childTask as { id: string }).id), parentTaskId);
        onNotify("已提交图片编辑，正在生成图片…");
      }}
      onRegenerate={async () => {
        if (card.editChildTaskId) {
          await suiteApi.regenerateImageEditTask(card.editChildTaskId);
          onClose();
          onEditJobStarted(card.editChildTaskId, parentTaskId);
          onNotify("已提交再次生成，正在更新图片…");
        } else {
          const result = await suiteApi.regenerateTaskFromEdit(card.parentTaskId, card.versionId!);
          onClose();
          onRetryJobStarted(result.batchId, parentTaskId);
          onNotify("已提交单张生成。");
        }
      }}
    />
  );
}
