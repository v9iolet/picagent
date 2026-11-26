import { useState, type ReactNode } from "react";
import { ADDITIONAL_PROMPT_MAX_LENGTH, type ResolvedDeliverySlot } from "../../../shared/workbench-delivery";
import { suiteApi, type createGenerationActions } from "../../api/client";
import { StudioDialog } from "./StudioDialog";
import { message } from "./studio";

type InitialTool = "restore_product" | "change_text";
export type ResultCardEditor = { card: ResolvedDeliverySlot; initialTool?: InitialTool };

export function ResultCardActions({
  card, disabled, onDownload, onEdit, submitGeneration, onRedrawStarted, onArchived, resolution,
  allowChangeText = true, children,
}: {
  card: ResolvedDeliverySlot;
  disabled: boolean;
  onDownload?: () => void;
  onEdit: (editor: ResultCardEditor) => void;
  submitGeneration: ReturnType<typeof createGenerationActions>;
  onRedrawStarted: (batchId: string) => void;
  onArchived: () => Promise<void>;
  resolution?: { suiteId: string; sizes: string[] };
  allowChangeText?: boolean;
  children?: ReactNode;
}) {
  const [dialog, setDialog] = useState<"redraw" | "delete" | null>(null);
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const locked = disabled || submitting;
  const cannotEdit = locked || !card.previewUrl || !card.versionId;
  const taskId = card.parentTaskId;

  function open(next: "redraw" | "delete") {
    setError("");
    setPrompt("");
    setSize("");
    setDialog(next);
  }

  async function confirm() {
    if (locked) return;
    setSubmitting(true);
    setError("");
    try {
      if (dialog === "redraw") {
        const additionalPrompt = prompt.trim();
        const { batchId } = await submitGeneration(taskId, { size, additionalPrompt }, async (key) => {
          if (resolution && size) {
            await suiteApi.batchUpdateTaskParams(resolution.suiteId, { taskIds: [taskId], generationParams: { size } });
          }
          return suiteApi.generateTask(taskId, { additionalPrompt }, key);
        });
        onRedrawStarted(batchId);
      } else {
        await suiteApi.updateTask(taskId, { status: "archived" });
        await onArchived();
      }
      setDialog(null);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="ss-actions">
        <button type="button" disabled={locked || !onDownload} onClick={onDownload}>下载</button>
        <button type="button" disabled={locked} onClick={() => open("redraw")}>重绘</button>
        <button type="button" disabled={cannotEdit} onClick={() => onEdit({ card })}>图片编辑</button>
        <button type="button" disabled={cannotEdit} onClick={() => onEdit({ card, initialTool: "restore_product" })}>商品还原</button>
        {allowChangeText && (
          <button type="button" disabled={cannotEdit} onClick={() => onEdit({ card, initialTool: "change_text" })}>AI 改字</button>
        )}
        <button type="button" disabled={locked} onClick={() => open("delete")}>删除</button>
        {children}
      </div>
      {dialog && (
        <StudioDialog title={dialog === "redraw" ? "重绘图片" : "删除结果卡"} close={() => { if (!submitting) setDialog(null); }}>
          <form className="ss-card-action-form" onSubmit={(event) => { event.preventDefault(); void confirm(); }}>
            {dialog === "redraw" ? (
              <>
                {resolution && (
                  <label>
                    输出分辨率
                    <select value={size} disabled={locked} onChange={(event) => setSize(event.target.value)}>
                      <option value="">原分辨率</option>
                      {resolution.sizes.map((option) => <option key={option}>{option}</option>)}
                    </select>
                  </label>
                )}
                <label>
                  附加提示词（选填）
                  <textarea rows={4} maxLength={ADDITIONAL_PROMPT_MAX_LENGTH} value={prompt} disabled={locked} onChange={(event) => setPrompt(event.target.value)} />
                </label>
              </>
            ) : <p>删除「{card.title}」当前结果卡？</p>}
            {error && <p role="alert">{error}</p>}
            <button type="submit" className={dialog === "redraw" ? "ss-primary" : undefined} disabled={locked}>
              {dialog === "redraw" ? "确认重绘" : "确认删除"}
            </button>
          </form>
        </StudioDialog>
      )}
    </>
  );
}
