import { useEffect, useState } from "react";
import { suiteApi } from "../../api/client";
import { download, message, studioApi } from "../../components/suite-studio/studio";
import { StudioDialog } from "../../components/suite-studio/StudioDialog";
import {
  JOB_SUCCESS_STATUSES,
  readImageEditJobStatus,
  readRetryJobStatus,
  StudioImageEditorHost,
  useResultJob,
} from "../../components/suite-studio/StudioResultShared";
import {
  REPLICA_CLONE_LEVEL_LABELS,
  REPLICA_SCENE_LABELS,
  replicaApi,
  type ReplicaCloneLevel,
  type ReplicaResultCard,
  type ReplicaSceneType,
  type ReplicaStudioState,
} from "./replica-types";

const STATUS_LABELS: Record<string, string> = {
  running: "生成中",
  completed: "已完成",
  partial_failed: "部分失败",
  failed: "生成失败",
};

function runningStatusText(phase: string, completed: number, total: number): string {
  if (phase === "replica_analyzing") return "分析中…";
  if (phase === "image_generating") {
    return total > 0 ? `生成中 ${completed}/${total}` : "生成中…";
  }
  return "处理中…";
}

function progressSummary(phase: string, completed: number, total: number) {
  if (phase === "replica_analyzing") {
    return {
      percent: 25,
      headline: "正在分析参考图构图、光影与版式，生成复刻提示词…",
      analyzeState: "active" as const,
      generateState: "pending" as const,
    };
  }
  const ratio = total > 0 ? Math.min(1, completed / total) : 0;
  return {
    percent: Math.round(40 + ratio * 58),
    headline: total > 0 ? `正在生成复刻图片（已完成 ${completed}/${total} 张）…` : "正在生成复刻图片…",
    analyzeState: "done" as const,
    generateState: "active" as const,
  };
}

function readSnapshotString(snapshot: Record<string, unknown>, key: string): string | null {
  const value = snapshot[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readSnapshotRecord(snapshot: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = snapshot[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readSnapshotCopy(snapshot: Record<string, unknown>): Array<{ role?: string; text: string; position?: string }> {
  const value = snapshot.copy;
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      role: typeof item.role === "string" ? item.role : undefined,
      text: typeof item.text === "string" ? item.text : "",
      position: typeof item.position === "string" ? item.position : undefined,
    }))
    .filter((item) => Boolean(item.text));
}

export interface ReplicaBatchPreviewProps {
  state: ReplicaStudioState;
  refresh: (id: string) => Promise<void>;
  onDelete: (id: string) => void;
  navigate: (path: string) => void;
}

interface BatchNotice {
  text: string;
  linkLabel?: string;
  linkTo?: string;
}

export function ReplicaBatchPreview({
  state,
  refresh,
  onDelete,
  navigate,
}: ReplicaBatchPreviewProps) {
  const id = state.suite.id;
  const run = state.pipeline;
  const running = run?.status === "running";
  const currentPhase = run?.currentPhase ?? "replica_analyzing";
  const cards = state.cards;
  const ready = cards.filter((card) => Boolean(card.previewUrl));
  const references = state.replicaReferences ?? [];
  const total = state.progress.total;
  const completed = state.progress.completed;
  const isStyleSketch = Boolean(state.styleSketch);
  const convergedComplete =
    !running &&
    cards.length > 0 &&
    ready.length === cards.length &&
    (run?.status === "partial_failed" || run?.status === "failed");
  const effectiveStatus = convergedComplete ? "completed" : run?.status;

  const sceneLabel =
    run?.config.sceneType && run.config.sceneType in REPLICA_SCENE_LABELS
      ? REPLICA_SCENE_LABELS[run.config.sceneType as ReplicaSceneType]
      : "爆品图复刻";
  const levelLabel =
    run?.config.cloneLevel && run.config.cloneLevel in REPLICA_CLONE_LEVEL_LABELS
      ? REPLICA_CLONE_LEVEL_LABELS[run.config.cloneLevel as ReplicaCloneLevel]
      : null;

  const progress = running ? progressSummary(currentPhase, completed, total) : null;
  const statusText = running
    ? runningStatusText(currentPhase, completed, total)
    : (STATUS_LABELS[effectiveStatus ?? ""] ?? "历史批次");

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<BatchNotice | null>(null);
  const [preview, setPreview] = useState<{ url: string; title: string } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(state.suite.name);
  const [openMenuTaskId, setOpenMenuTaskId] = useState<string | null>(null);

  const [promptCard, setPromptCard] = useState<ReplicaResultCard | null>(null);
  const [promptDraftInput, setPromptDraftInput] = useState("");
  const [editCard, setEditCard] = useState<ReplicaResultCard | null>(null);
  const [confirmDeleteBatch, setConfirmDeleteBatch] = useState(false);
  const [confirmDeleteCard, setConfirmDeleteCard] = useState<ReplicaResultCard | null>(null);

  const [retryJob, setRetryJob] = useState("");
  const [retryingTaskId, setRetryingTaskId] = useState<string | null>(null);
  const [editJob, setEditJob] = useState("");
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);

  useEffect(() => {
    setNameDraft(state.suite.name);
  }, [state.suite.name]);

  useEffect(() => {
    if (!openMenuTaskId) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest("[data-card-menu]")) setOpenMenuTaskId(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenuTaskId(null);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenuTaskId]);

  const setNoticeText = (text: string) => setNotice(text ? { text } : null);

  useResultJob(
    retryJob,
    readRetryJobStatus,
    JOB_SUCCESS_STATUSES,
    id,
    refresh,
    (nextJob) => {
      setRetryJob(nextJob);
      if (!nextJob) setRetryingTaskId(null);
    },
    setNoticeText,
    "图片生成失败，请检查提示词或稍后重试。",
  );

  useResultJob(
    editJob,
    readImageEditJobStatus,
    JOB_SUCCESS_STATUSES,
    id,
    refresh,
    (nextJob) => {
      setEditJob(nextJob);
      if (!nextJob) setEditingTaskId(null);
    },
    setNoticeText,
    "图片编辑生成失败，请重试。",
  );

  const act = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setOpenMenuTaskId(null);
    setNotice(null);
    try {
      await fn();
    } catch (error) {
      setNotice({ text: message(error) });
    } finally {
      setBusy(false);
    }
  };

  const handleRenameSubmit = () => {
    const trimmed = nameDraft.trim();
    if (!trimmed) {
      setNotice({ text: "任务名不能为空。" });
      return;
    }
    if (trimmed === state.suite.name) {
      setRenaming(false);
      return;
    }
    void act(async () => {
      await suiteApi.rename(id, trimmed);
      await refresh(id);
      setRenaming(false);
      setNotice({ text: "任务名已更新。" });
    });
  };

  const handleResumeBatch = () =>
    void act(async () => {
      await replicaApi.resume(id);
      await refresh(id);
      setNotice({ text: "已重新启动复刻流程。" });
    });

  const handleDownloadZip = () =>
    void act(async () => {
      const taskIds = ready.map((card) => card.parentTaskId);
      if (!taskIds.length) return;
      await download(studioApi.exportUrl(id, taskIds), `${state.suite.name}.zip`);
    });

  const handleConfirmDeleteBatch = () =>
    void act(async () => {
      await suiteApi.delete(id);
      setConfirmDeleteBatch(false);
      onDelete(id);
    });

  const handleRegenerateCard = (card: ReplicaResultCard, nextPrompt?: string) =>
    void act(async () => {
      const result = await suiteApi.generateTask(card.parentTaskId, nextPrompt);
      setPromptCard(null);
      setRetryingTaskId(card.parentTaskId);
      setRetryJob(result.batchId);
      setNotice({
        text: nextPrompt !== undefined ? "已提交新提示词重新生成…" : "已提交重新生成…",
      });
    });

  const handleOpenPromptDialog = (card: ReplicaResultCard) => {
    setOpenMenuTaskId(null);
    setPromptCard(card);
    setPromptDraftInput(card.promptDraft ?? card.promptText ?? "");
  };

  const handleSaveToLibrary = (card: ReplicaResultCard) =>
    void act(async () => {
      if (!card.versionId) return;
      if (card.editChildTaskId) {
        await suiteApi.selectImageEditVersion(card.editChildTaskId, card.versionId, "final");
        await refresh(id);
        setNotice({
          text: "已将当前编辑版本设为终版；图片资源库当前仅自动收录原任务生成图（AI 生成结果），编辑派生图保留在本批次中。",
          linkLabel: "前往图片库",
          linkTo: "/assets",
        });
      } else {
        await suiteApi.selectTaskVersion(card.parentTaskId, card.versionId, "final");
        await refresh(id);
        setNotice({
          text: "已设为终版并确认归档到图片资源库（AI 生成结果）。",
          linkLabel: "前往图片库",
          linkTo: "/assets",
        });
      }
    });

  const handleSaveReverseAsset = (card: ReplicaResultCard) =>
    void act(async () => {
      await replicaApi.saveReverseAsset(id, card.parentTaskId);
      setNotice({
        text: "已存为爆品图反推资产（草稿），可在图片资源库查看和发布。",
        linkLabel: "前往图片库",
        linkTo: "/assets",
      });
    });

  const handleConfirmDeleteCard = () => {
    if (!confirmDeleteCard) return;
    const target = confirmDeleteCard;
    void act(async () => {
      await suiteApi.updateTask(target.parentTaskId, { status: "archived" });
      setConfirmDeleteCard(null);
      await refresh(id);
      setNotice({ text: `已删除「${target.title}」。` });
    });
  };

  const canResume =
    !running &&
    !convergedComplete &&
    (run?.status === "failed" || run?.status === "partial_failed");
  const resumeLabel =
    run?.currentPhase === "replica_analyzing" || cards.length < references.length
      ? "重试分析"
      : "继续生成";

  const promptSnapshot = promptCard?.promptSnapshot ?? {};
  const snapshotSharedStyle = promptCard ? readSnapshotString(promptSnapshot, "sharedStyle") : null;
  const snapshotVisualStructure = promptCard ? readSnapshotRecord(promptSnapshot, "visualStructure") : null;
  const snapshotCopy = promptCard ? readSnapshotCopy(promptSnapshot) : [];

  return (
    <section className="ss-batch rp-batch" role="region" aria-label="复刻批次">
      <header className="ss-batch-head rp-batch-head">
        <div className="ss-batch-title">
          {renaming ? (
            <form
              className="rp-rename-form"
              onSubmit={(event) => {
                event.preventDefault();
                handleRenameSubmit();
              }}
            >
              <input
                type="text"
                aria-label="任务名称"
                value={nameDraft}
                onChange={(event) => setNameDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setRenaming(false);
                    setNameDraft(state.suite.name);
                  }
                }}
                autoFocus
              />
              <button type="submit" disabled={busy || !nameDraft.trim()}>
                保存
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setRenaming(false);
                  setNameDraft(state.suite.name);
                }}
              >
                取消
              </button>
            </form>
          ) : (
            <div className="rp-batch-name-row">
              <h3>{state.suite.name}</h3>
              <button
                type="button"
                className="rp-rename-trigger"
                aria-label="重命名任务"
                disabled={busy}
                onClick={() => {
                  setNameDraft(state.suite.name);
                  setRenaming(true);
                }}
              >
                重命名
              </button>
            </div>
          )}
          <small>
            {sceneLabel}
            {levelLabel ? ` · ${levelLabel}` : ""} · {new Date(state.suite.createdAt).toLocaleString()} · 共 {total} 张
          </small>
        </div>

        <div className="rp-batch-controls">
          {isStyleSketch && <span className="rp-sketch-pill">风格示意</span>}
          <span data-status={effectiveStatus ?? "historical"} className="ss-status">
            {running && <span className="ss-status-dot" aria-hidden="true" />}
            {statusText}
          </span>
          <button
            type="button"
            disabled={!ready.length || busy}
            onClick={handleDownloadZip}
          >
            ZIP 下载（{ready.length}）
          </button>
          <button
            type="button"
            className="rp-danger-btn"
            disabled={running || busy}
            onClick={() => setConfirmDeleteBatch(true)}
          >
            删除批次
          </button>
        </div>
      </header>

      {progress && (
        <div className="ss-progress">
          <div className="ss-progress-head">
            <strong>{progress.headline}</strong>
            <span className="ss-progress-pct">{progress.percent}%</span>
          </div>
          <div
            className="ss-progress-track"
            role="progressbar"
            aria-label="复刻生成进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.percent}
            aria-valuetext={`${progress.percent}% · ${progress.headline}`}
          >
            <div className="ss-progress-fill" style={{ width: `${progress.percent}%` }} />
          </div>
          <ol className="ss-progress-steps" aria-label="复刻阶段进度">
            <li className="ss-step" data-step-state={progress.analyzeState}>
              <span className="ss-step-badge" aria-hidden="true">
                {progress.analyzeState === "done" ? "✓" : "1"}
              </span>
              <span>分析参考图</span>
            </li>
            <li className="ss-step" data-step-state={progress.generateState}>
              <span className="ss-step-badge" aria-hidden="true">2</span>
              <span>{total > 0 ? `生成复刻图 (${completed}/${total})` : "生成复刻图"}</span>
            </li>
          </ol>
        </div>
      )}

      {canResume && (
        <div className="ss-pause rp-resume-bar" role="alert">
          <span>{run?.errorMessage || "复刻批次未完成，可继续执行。"}</span>
          <button type="button" disabled={busy} onClick={handleResumeBatch}>
            {resumeLabel}
          </button>
        </div>
      )}

      {notice && (
        <div className="ss-note rp-batch-notice" role="status">
          <span>{notice.text}</span>
          <div className="rp-batch-notice-actions">
            {notice.linkLabel && notice.linkTo && (
              <button type="button" onClick={() => navigate(notice.linkTo!)}>
                {notice.linkLabel}
              </button>
            )}
            <button type="button" onClick={() => setNotice(null)} aria-label="关闭提示">
              ×
            </button>
          </div>
        </div>
      )}

      {cards.length > 0 ? (
        <div className="ss-grid rp-result-grid">
          {cards.map((card, index) => {
            const cardSketch = Boolean(card.styleSketch ?? isStyleSketch);
            const cardGenerating =
              (running && !card.previewUrl) ||
              card.taskStatus === "generating" ||
              retryingTaskId === card.parentTaskId ||
              editingTaskId === card.parentTaskId;
            const cardFailed = !cardGenerating && (!card.previewUrl || card.taskStatus === "failed");
            const isFinal = card.sourceRole === "parent_final" || card.sourceRole === "edit_final";
            const menuOpen = openMenuTaskId === card.parentTaskId;

            return (
              <article
                key={card.parentTaskId}
                className="ss-card rp-result-card"
                data-replica-card
                data-task-id={card.parentTaskId}
              >
                <div className={`ss-photo${!card.previewUrl && cardGenerating ? " is-pending" : ""}`}>
                  {card.previewUrl ? (
                    <button
                      type="button"
                      aria-label={`放大查看 ${card.title}`}
                      onClick={() => setPreview({ url: card.previewUrl!, title: card.title })}
                    >
                      <img src={card.previewUrl} alt={card.title} />
                    </button>
                  ) : cardGenerating ? (
                    <span className="ss-skeleton-label">
                      生成中 · {String(index + 1).padStart(2, "0")}
                    </span>
                  ) : (
                    <div className="rp-card-failed">
                      <strong>生成失败</strong>
                      <p>{card.errorMessage || "图片生成失败，请重试"}</p>
                    </div>
                  )}
                  {card.replicaReferenceThumbnailUrl && (
                    <div className="rp-ref-overlay" title="对应参考图">
                      <img src={card.replicaReferenceThumbnailUrl} alt={`${card.title} 参考图`} />
                    </div>
                  )}
                  {cardSketch && <div className="rp-card-sketch-tag">风格示意</div>}
                  {card.previewUrl && cardGenerating && (
                    <div className="rp-card-busy-tag">生成中…</div>
                  )}
                </div>

                <div className="rp-card-footer">
                  <span className="rp-card-title" title={card.title}>
                    {card.title}
                  </span>
                  <small className="rp-card-state" data-card-state={cardGenerating ? "generating" : cardFailed ? "failed" : "succeeded"}>
                    {cardGenerating
                      ? "生成中"
                      : cardFailed
                        ? "失败"
                        : isFinal
                          ? `终版 · v${card.versionNumber ?? 1}`
                          : `v${card.versionNumber ?? 1}`}
                  </small>
                </div>

                {cardFailed && card.previewUrl && card.errorMessage && (
                  <p className="rp-card-error-inline" role="alert">
                    {card.errorMessage}
                  </p>
                )}

                <div className="ss-actions rp-card-actions">
                  {card.previewUrl ? (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void act(() =>
                            download(card.previewUrl!, card.exportFilename ?? `${card.title}.png`),
                          )
                        }
                      >
                        下载
                      </button>
                      <button
                        type="button"
                        disabled={busy || cardGenerating || !!editJob || !card.versionId}
                        onClick={() => {
                          setOpenMenuTaskId(null);
                          setEditCard(card);
                        }}
                      >
                        编辑图片
                      </button>
                      <button
                        type="button"
                        disabled={busy || cardGenerating}
                        onClick={() => handleOpenPromptDialog(card)}
                      >
                        提示词
                      </button>
                      <button
                        type="button"
                        disabled={busy || cardGenerating || !!retryJob || running}
                        onClick={() => handleRegenerateCard(card)}
                      >
                        重新生成
                      </button>
                      <div className="ss-menu rp-card-menu" data-card-menu>
                        <button
                          type="button"
                          aria-label={`更多操作 ${card.title}`}
                          aria-expanded={menuOpen}
                          disabled={busy}
                          onClick={() =>
                            setOpenMenuTaskId((current) =>
                              current === card.parentTaskId ? null : card.parentTaskId,
                            )
                          }
                        >
                          ···
                        </button>
                        {menuOpen && (
                          <div className="ss-menu-list rp-card-menu-list" role="menu">
                            <button
                              type="button"
                              role="menuitem"
                              disabled={busy || !card.versionId}
                              onClick={() => handleSaveToLibrary(card)}
                            >
                              保存到图片资源库
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              disabled={busy}
                              onClick={() => handleSaveReverseAsset(card)}
                            >
                              存为爆品图反推资产
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              className="rp-danger-menuitem"
                              disabled={busy || cardGenerating || running}
                              onClick={() => {
                                setOpenMenuTaskId(null);
                                setConfirmDeleteCard(card);
                              }}
                            >
                              删除
                            </button>
                          </div>
                        )}
                      </div>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        disabled={busy || cardGenerating || !!retryJob || running}
                        onClick={() => handleRegenerateCard(card)}
                      >
                        重新生成
                      </button>
                      <button
                        type="button"
                        disabled={busy || cardGenerating}
                        onClick={() => handleOpenPromptDialog(card)}
                      >
                        提示词
                      </button>
                      <button
                        type="button"
                        className="rp-danger-btn"
                        disabled={busy || cardGenerating || running}
                        onClick={() => setConfirmDeleteCard(card)}
                      >
                        删除
                      </button>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      ) : running || total > 0 ? (
        <div className="ss-grid rp-result-grid">
          {Array.from({ length: Math.max(total, 1) }, (_, index) => {
            const ref = references[index];
            return (
              <div
                key={ref?.id ?? index}
                className="ss-placeholder is-loading rp-skeleton-card"
                data-replica-skeleton
              >
                {ref?.thumbnailPreviewUrl && (
                  <div className="rp-ref-overlay" title="对应参考图">
                    <img src={ref.thumbnailPreviewUrl} alt={ref.filename} />
                  </div>
                )}
                <span className="ss-skeleton-label">
                  {running
                    ? currentPhase === "replica_analyzing"
                      ? `分析中 · ${String(index + 1).padStart(2, "0")}`
                      : `生成中 · ${String(index + 1).padStart(2, "0")}`
                    : "暂无结果"}
                </span>
                <small className="ss-placeholder-num">{String(index + 1).padStart(2, "0")}</small>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="rp-batch-empty" role="status">
          当前批次结果卡片已全部删除。
        </div>
      )}

      {promptCard && (
        <StudioDialog
          title={`提示词 · ${promptCard.title}`}
          close={() => setPromptCard(null)}
          className="rp-prompt-dialog"
        >
          <div className="rp-prompt-meta">
            <span>提示词修订 v{promptCard.promptRevision ?? 1}</span>
            {promptCard.versionNumber && <span>当前图片 v{promptCard.versionNumber}</span>}
            {promptCard.templateVersionId && <span>模板 {promptCard.templateVersionId.slice(0, 8)}</span>}
          </div>

          <label className="rp-prompt-editor-label">
            <span>生图提示词（修改后重新生成会创建新图片版本，历史快照保持冻结）</span>
            <textarea
              aria-label="复刻提示词"
              rows={6}
              value={promptDraftInput}
              onChange={(event) => setPromptDraftInput(event.target.value)}
            />
          </label>

          {(snapshotSharedStyle || snapshotVisualStructure || snapshotCopy.length > 0) && (
            <details className="rp-prompt-snapshot-details">
              <summary>查看分析快照信息（只读）</summary>
              <div className="rp-prompt-snapshot-body">
                {snapshotSharedStyle && (
                  <div>
                    <strong>共享风格</strong>
                    <p>{snapshotSharedStyle}</p>
                  </div>
                )}
                {snapshotCopy.length > 0 && (
                  <div>
                    <strong>新文案区块</strong>
                    <ul>
                      {snapshotCopy.map((item, idx) => (
                        <li key={idx}>
                          {item.role ? `[${item.role}] ` : ""}
                          {item.text}
                          {item.position ? `（${item.position}）` : ""}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {snapshotVisualStructure && Object.keys(snapshotVisualStructure).length > 0 && (
                  <div>
                    <strong>视觉结构</strong>
                    <dl className="rp-structure-kv">
                      {Object.entries(snapshotVisualStructure).map(([key, value]) => (
                        <div key={key}>
                          <dt>{key}</dt>
                          <dd>{Array.isArray(value) ? value.join("、") : String(value ?? "")}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                )}
              </div>
            </details>
          )}

          <div className="rp-dialog-actions">
            <button
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(promptDraftInput).catch(() => undefined);
                setNotice({ text: "提示词已复制。" });
              }}
            >
              复制提示词
            </button>
            <div className="rp-dialog-actions-right">
              <button type="button" onClick={() => setPromptCard(null)}>
                取消
              </button>
              <button
                type="button"
                className="ss-primary"
                disabled={busy || !!retryJob || running || !promptDraftInput.trim()}
                onClick={() => handleRegenerateCard(promptCard, promptDraftInput.trim())}
              >
                保存并重新生成
              </button>
            </div>
          </div>
        </StudioDialog>
      )}

      <StudioImageEditorHost
        card={editCard}
        onClose={() => setEditCard(null)}
        onEditJobStarted={(childTaskId, parentTaskId) => {
          setEditingTaskId(parentTaskId);
          setEditJob(childTaskId);
        }}
        onRetryJobStarted={(batchId, parentTaskId) => {
          setRetryingTaskId(parentTaskId);
          setRetryJob(batchId);
        }}
        onNotify={setNoticeText}
      />

      {confirmDeleteBatch && (
        <StudioDialog title="删除复刻批次" close={() => setConfirmDeleteBatch(false)}>
          <p>确定删除批次「{state.suite.name}」吗？删除后将从生成记录中移除。</p>
          <div className="rp-dialog-actions">
            <span />
            <div className="rp-dialog-actions-right">
              <button type="button" onClick={() => setConfirmDeleteBatch(false)}>
                取消
              </button>
              <button
                type="button"
                className="rp-danger-solid-btn"
                disabled={busy}
                onClick={handleConfirmDeleteBatch}
              >
                确认删除
              </button>
            </div>
          </div>
        </StudioDialog>
      )}

      {confirmDeleteCard && (
        <StudioDialog title="删除复刻卡片" close={() => setConfirmDeleteCard(null)}>
          <p>确定删除「{confirmDeleteCard.title}」吗？删除后该卡片将从本批次结果区和批量导出中移除。</p>
          <div className="rp-dialog-actions">
            <span />
            <div className="rp-dialog-actions-right">
              <button type="button" onClick={() => setConfirmDeleteCard(null)}>
                取消
              </button>
              <button
                type="button"
                className="rp-danger-solid-btn"
                disabled={busy}
                onClick={handleConfirmDeleteCard}
              >
                确认删除
              </button>
            </div>
          </div>
        </StudioDialog>
      )}

      {preview && (
        <StudioDialog title={preview.title} close={() => setPreview(null)}>
          <img className="ss-zoom" src={preview.url} alt={preview.title} />
        </StudioDialog>
      )}
    </section>
  );
}

export { ReplicaBatchPreview as ReplicaBatchResults };
