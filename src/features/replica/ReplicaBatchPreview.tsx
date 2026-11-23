import { useState } from "react";
import { StudioDialog } from "../../components/suite-studio/StudioDialog";
import {
  REPLICA_CLONE_LEVEL_LABELS,
  REPLICA_SCENE_LABELS,
  type ReplicaCloneLevel,
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

export function ReplicaBatchPreview({ state }: { state: ReplicaStudioState }) {
  const [preview, setPreview] = useState<{ url: string; title: string } | null>(null);
  const run = state.pipeline;
  const running = run?.status === "running";
  const currentPhase = run?.currentPhase ?? "replica_analyzing";
  const cards = state.cards;
  const references = state.replicaReferences ?? [];
  const total = state.progress.total || cards.length || references.length || run?.config.referenceCount || 0;
  const completed = state.progress.completed;
  const isStyleSketch = Boolean(state.styleSketch);

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
    : (STATUS_LABELS[run?.status ?? ""] ?? "历史批次");

  return (
    <section className="ss-batch rp-batch" role="region" aria-label="复刻批次">
      <header className="ss-batch-head rp-batch-head">
        <div className="ss-batch-title">
          <h3>{state.suite.name}</h3>
          <small>
            {sceneLabel}
            {levelLabel ? ` · ${levelLabel}` : ""} · {new Date(state.suite.createdAt).toLocaleString()} · 共 {total} 张
          </small>
        </div>
        {isStyleSketch && <span className="rp-sketch-pill">风格示意</span>}
        <span data-status={run?.status ?? "historical"} className="ss-status">
          {running && <span className="ss-status-dot" aria-hidden="true" />}
          {statusText}
        </span>
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

      {!running && (run?.status === "failed" || run?.status === "partial_failed") && run.errorMessage && (
        <p className="ss-note" role="alert">
          {run.errorMessage}
        </p>
      )}

      <div className="ss-grid rp-result-grid">
        {cards.length > 0
          ? cards.map((card, index) => {
              const cardSketch = Boolean(card.styleSketch ?? isStyleSketch);
              return (
                <article key={card.parentTaskId} className="ss-card rp-result-card" data-replica-card>
                  <div className={`ss-photo${!card.previewUrl && running ? " is-pending" : ""}`}>
                    {card.previewUrl ? (
                      <button
                        type="button"
                        aria-label={`放大查看 ${card.title}`}
                        onClick={() => setPreview({ url: card.previewUrl!, title: card.title })}
                      >
                        <img src={card.previewUrl} alt={card.title} />
                      </button>
                    ) : (
                      <span className={running ? "ss-skeleton-label" : undefined}>
                        {running
                          ? `生成中 · ${String(index + 1).padStart(2, "0")}`
                          : "生成失败"}
                      </span>
                    )}
                    {card.replicaReferenceThumbnailUrl && (
                      <div className="rp-ref-overlay" title="对应参考图">
                        <img src={card.replicaReferenceThumbnailUrl} alt={`${card.title} 参考图`} />
                      </div>
                    )}
                    {cardSketch && <div className="rp-card-sketch-tag">风格示意</div>}
                  </div>
                  <div className="rp-card-footer">
                    <span className="rp-card-title" title={card.title}>
                      {card.title}
                    </span>
                    <small className="rp-card-state">
                      {card.previewUrl ? "已生成" : running ? "生成中" : "失败"}
                    </small>
                  </div>
                </article>
              );
            })
          : Array.from({ length: Math.max(total, 1) }, (_, index) => {
              const ref = references[index];
              return (
                <div key={ref?.id ?? index} className="ss-placeholder is-loading rp-skeleton-card" data-replica-skeleton>
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

      {preview && (
        <StudioDialog title={preview.title} close={() => setPreview(null)}>
          <img className="ss-zoom" src={preview.url} alt={preview.title} />
        </StudioDialog>
      )}
    </section>
  );
}
