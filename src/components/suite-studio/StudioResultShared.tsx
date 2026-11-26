import { usePolling } from "../../hooks/usePolling";
import { useState, type ComponentProps } from "react";
import type { ResolvedDeliverySlot } from "../../../shared/workbench-delivery";
import { createGenerationActions, suiteApi } from "../../api/client";
import { LazyImageEditorModal } from "../../features/image-editor/LazyImageEditorModal";
import { message } from "./studio";

export const JOB_SUCCESS_STATUSES = ["completed", "succeeded"] as const;

export const readRetryJobStatus = async (job: string, signal?: AbortSignal) =>
  (await suiteApi.getBatch(job, signal)).batch.status;

export const readImageEditJobStatus = async (job: string, signal?: AbortSignal) =>
  ((await suiteApi.getImageEditTask(job, signal)).task as { status: string }).status;

export function useResultJob(
  job: string,
  readStatus: (job: string, signal?: AbortSignal) => Promise<string>,
  success: readonly string[],
  suiteId: string,
  refresh: (id: string, signal?: AbortSignal) => Promise<void>,
  setJob: (id: string) => void,
  notify: (text: string) => void,
  failureMessage = "图片生成失败，请重试。",
) {
  usePolling(async signal => {
    const status = await readStatus(job, signal);
    if (signal.aborted || status === "running" || status === "generating") return;
    await refresh(suiteId, signal);
    if (signal.aborted) return;
    notify(success.includes(status) ? "图片已更新" : failureMessage);
    setJob("");
  }, {
    enabled: Boolean(job),
    initialDelayMs: 1000,
    intervalMs: 3000,
    onError: error => {
      notify(message(error));
      setJob("");
    },
  }, [job, suiteId]);
}

export function StudioImageEditorHost({
  card,
  initialTool,
  onClose,
  onEditJobStarted,
  onRetryJobStarted,
  onNotify,
}: {
  card: ResolvedDeliverySlot | null;
  initialTool?: ComponentProps<typeof LazyImageEditorModal>["initialTool"];
  onClose: () => void;
  onEditJobStarted: (childTaskId: string, parentTaskId: string) => void;
  onRetryJobStarted: (batchId: string, parentTaskId: string) => void;
  onNotify: (text: string) => void;
}) {
  const [submitGeneration] = useState(createGenerationActions);
  if (!card || !card.versionId || !card.previewUrl) return null;
  const targetTaskId = card.editChildTaskId ?? card.parentTaskId;
  const parentTaskId = card.parentTaskId;
  return (
    <LazyImageEditorModal
      key={card.versionId}
      initialTool={initialTool}
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
      onSubmit={async (selection, instruction, key) => {
        const res = await suiteApi.submitImageEdit(targetTaskId, {
          ...selection,
          sourceCardId: targetTaskId,
          parentVersionId: selection.sourceVersionId,
          summary: instruction,
        }, key);
        onClose();
        onEditJobStarted(String((res.childTask as { id: string }).id), parentTaskId);
        onNotify("已提交图片编辑，正在生成图片…");
      }}
      onRegenerate={async () => {
        if (card.editChildTaskId) {
          await submitGeneration(targetTaskId, card.versionId, (key) => suiteApi.regenerateImageEditTask(targetTaskId, key));
          onClose();
          onEditJobStarted(card.editChildTaskId, parentTaskId);
          onNotify("已提交再次生成，正在更新图片…");
        } else {
          const result = await submitGeneration(parentTaskId, card.versionId,
            (key) => suiteApi.regenerateTaskFromEdit(parentTaskId, card.versionId!, key));
          onClose();
          onRetryJobStarted(result.batchId, parentTaskId);
          onNotify("已提交单张生成。");
        }
      }}
    />
  );
}
