import { useEffect, useState } from "react";
import type { ApiSuiteTask, ApiTaskVersion } from "../api/client";
import type { LightboxPreview } from "./BeforeAfterLightbox";
import { Icon, ImageWithState } from "../pages/shared";
import "./VersionCompareModal.css";

function promptExcerpt(version: ApiTaskVersion): string {
  const snapshot = version.promptSnapshot ?? {};
  const text = snapshot.finalPrompt ?? snapshot.prompt;
  return typeof text === "string" && text.trim() ? text.trim() : "未记录冻结提示词快照";
}

function modelLabel(task: ApiSuiteTask, version: ApiTaskVersion): string {
  const attempt = task.attempts.find((item) => item.id === version.attemptId);
  const channel = attempt?.contextSnapshot?.channel as { channelName?: string } | undefined;
  return attempt?.model ? [channel?.channelName, attempt.model].filter(Boolean).join(" · ") : "默认生图模型";
}

export function VersionCompareModal({
  task,
  onClose,
  onSelectVersion,
  onComparePreview,
}: {
  task: ApiSuiteTask;
  onClose: () => void;
  onSelectVersion: (task: ApiSuiteTask, versionId: string, selection: "current" | "final") => Promise<void>;
  onComparePreview: (preview: LightboxPreview) => void;
}) {
  const ordered = task.versions.slice().sort((a, b) => b.versionNumber - a.versionNumber);
  const [selectedIds, setSelectedIds] = useState<string[]>(() => ordered.slice(0, 2).map((item) => item.id));
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const togglePick = (id: string) => {
    setSelectedIds((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length >= 2) return [current[1], id];
      return [...current, id];
    });
  };

  const openSliderCompare = () => {
    if (selectedIds.length < 2) return;
    const picked = selectedIds
      .map((id) => ordered.find((item) => item.id === id))
      .filter((item): item is ApiTaskVersion => Boolean(item))
      .sort((a, b) => a.versionNumber - b.versionNumber);
    if (picked.length < 2) return;
    const [older, newer] = picked;
    onComparePreview({
      url: newer.previewUrl,
      title: `${task.title} · 版本对比`,
      subtitle: `v${older.versionNumber} vs v${newer.versionNumber}`,
      beforeUrl: older.previewUrl,
      beforeLabel: `旧版 · v${older.versionNumber}`,
      afterLabel: `新版 · v${newer.versionNumber}`,
    });
  };

  const handleSelect = async (versionId: string, selection: "current" | "final") => {
    setBusyId(`${versionId}:${selection}`);
    try {
      await onSelectVersion(task, versionId, selection);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="vc-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="vc-modal" role="dialog" aria-modal="true" aria-labelledby="vc-title">
        <header className="vc-header">
          <div>
            <span>VERSION COMPARE GALLERY</span>
            <h2 id="vc-title">{task.title} · 多版本横向对比（共 {ordered.length} 版）</h2>
          </div>
          <div className="vc-header-actions">
            <button
              type="button"
              className="vc-compare-btn"
              disabled={selectedIds.length < 2}
              onClick={openSliderCompare}
            >
              卷帘对比已选 2 版 ({selectedIds.length}/2)
            </button>
            <button type="button" className="vc-close" aria-label="关闭版本对比" onClick={onClose}>
              <Icon name="x" />
            </button>
          </div>
        </header>

        <div className="vc-grid">
          {ordered.map((version) => {
            const picked = selectedIds.includes(version.id);
            return (
              <article key={version.id} className={`vc-card ${picked ? "is-picked" : ""}`}>
                <div className="vc-card-head">
                  <label className="vc-pick">
                    <input type="checkbox" checked={picked} onChange={() => togglePick(version.id)} />
                    <strong>v{version.versionNumber}</strong>
                  </label>
                  <div className="vc-badges">
                    {version.isCurrent && <span className="vc-badge is-current">当前版</span>}
                    {version.isFinal && <span className="vc-badge is-final">终版</span>}
                  </div>
                </div>
                <button
                  type="button"
                  className="vc-thumb"
                  onClick={() => onComparePreview({ url: version.previewUrl, title: `${task.title} · v${version.versionNumber}`, subtitle: `${version.width} × ${version.height}` })}
                >
                  <ImageWithState src={version.previewUrl} alt={`${task.title} v${version.versionNumber}`} loading="lazy" retryable={false} />
                </button>
                <div className="vc-meta">
                  <span>{version.width} × {version.height}</span>
                  <span>{modelLabel(task, version)}</span>
                  {version.createdAt && <span>{new Date(version.createdAt).toLocaleString("zh-CN")}</span>}
                </div>
                <p className="vc-prompt" title={promptExcerpt(version)}>{promptExcerpt(version)}</p>
                <div className="vc-actions">
                  <button
                    type="button"
                    disabled={version.isCurrent || busyId !== null}
                    onClick={() => void handleSelect(version.id, "current")}
                  >
                    {version.isCurrent ? "已是当前" : "设为当前"}
                  </button>
                  <button
                    type="button"
                    className="is-final"
                    disabled={version.isFinal || busyId !== null}
                    onClick={() => void handleSelect(version.id, "final")}
                  >
                    {version.isFinal ? "已是终版" : "设为终版"}
                  </button>
                  <a className="vc-download" href={version.previewUrl} download={`${task.title}_v${version.versionNumber}.png`}>下载</a>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
