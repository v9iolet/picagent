import { useEffect, useRef, useState } from "react";
import { Icon } from "../pages/shared";
import "./BeforeAfterLightbox.css";

export interface LightboxPreview {
  url: string;
  title: string;
  subtitle?: string;
  beforeUrl?: string | null;
  beforeLabel?: string;
  afterLabel?: string;
}

export function BeforeAfterLightbox({ preview, onClose }: { preview: LightboxPreview; onClose: () => void }) {
  const hasCompare = Boolean(preview.beforeUrl && preview.beforeUrl !== preview.url);
  const [viewMode, setViewMode] = useState<"compare" | "single">(hasCompare ? "compare" : "single");
  const [split, setSplit] = useState(50);
  const [dragging, setDragging] = useState(false);
  const stageRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setViewMode(hasCompare ? "compare" : "single");
    setSplit(50);
  }, [preview.url, preview.beforeUrl, hasCompare]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      } else if (viewMode === "compare" && event.key === "ArrowLeft") {
        event.preventDefault();
        setSplit((value) => Math.max(0, value - 4));
      } else if (viewMode === "compare" && event.key === "ArrowRight") {
        event.preventDefault();
        setSplit((value) => Math.min(100, value + 4));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, viewMode]);

  const updateSplitFromClientX = (clientX: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const percent = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
    setSplit(percent);
  };

  return (
    <div className="ba-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="ba-modal" role="dialog" aria-modal="true" aria-labelledby="ba-preview-title">
        <header className="ba-header">
          <div className="ba-title">
            <p>{hasCompare ? "BEFORE / AFTER COMPARE" : "IMAGE PREVIEW"}</p>
            <h2 id="ba-preview-title">{preview.title}</h2>
            {preview.subtitle && <span>{preview.subtitle}</span>}
          </div>
          <div className="ba-controls">
            {hasCompare && (
              <div className="ba-mode-tabs" role="tablist" aria-label="预览模式">
                <button type="button" role="tab" aria-selected={viewMode === "compare"} className={viewMode === "compare" ? "is-active" : ""} onClick={() => setViewMode("compare")}>卷帘对比</button>
                <button type="button" role="tab" aria-selected={viewMode === "single"} className={viewMode === "single" ? "is-active" : ""} onClick={() => setViewMode("single")}>单图查看</button>
              </div>
            )}
            <button type="button" className="ba-close" aria-label="关闭图片预览" onClick={onClose}>
              <Icon name="x" />
            </button>
          </div>
        </header>

        <div className="ba-body">
          {hasCompare && viewMode === "compare" ? (
            <div
              ref={stageRef}
              className={`ba-compare-stage ${dragging ? "is-dragging" : ""}`}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                setDragging(true);
                updateSplitFromClientX(event.clientX);
              }}
              onPointerMove={(event) => {
                if (dragging) updateSplitFromClientX(event.clientX);
              }}
              onPointerUp={() => setDragging(false)}
              onPointerCancel={() => setDragging(false)}
            >
              <img className="ba-img ba-img-after" src={preview.url} alt={`${preview.title} 编辑后`} draggable={false} />
              <div className="ba-before-layer" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}>
                <img className="ba-img ba-img-before" src={preview.beforeUrl!} alt={`${preview.title} 编辑前`} draggable={false} />
              </div>
              <span className="ba-tag is-before">{preview.beforeLabel ?? "编辑前 · 来源版本"}</span>
              <span className="ba-tag is-after">{preview.afterLabel ?? "编辑后 · 子卡结果"}</span>
              <div className="ba-divider" style={{ left: `${split}%` }}>
                <span
                  className="ba-handle"
                  role="slider"
                  tabIndex={0}
                  aria-label="编辑前后对比滑块"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(split)}
                >
                  ⇆
                </span>
              </div>
            </div>
          ) : (
            <div className="ba-single-stage">
              <img src={preview.url} alt={preview.title} />
            </div>
          )}
        </div>
        {hasCompare && viewMode === "compare" && (
          <footer className="ba-footer">
            <span>左右拖动分割线或按键盘 ← / → 键微调对比位置</span>
            <strong>{Math.round(split)}% / {100 - Math.round(split)}%</strong>
          </footer>
        )}
      </section>
    </div>
  );
}
