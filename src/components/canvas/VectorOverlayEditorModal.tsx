import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Circle as KonvaCircle, Group, Layer, Line, Rect as KonvaRect, Stage, Text as KonvaText, Transformer } from "react-konva";
import type Konva from "konva";
import { SELLING_POINT_LAYOUTS } from "../../../shared/selling-point-layouts";
import {
  VECTOR_OVERLAY_THEMES,
  VECTOR_OVERLAY_THEME_LIST,
  createVectorOverlayElement,
  createVectorOverlayPreset,
  extractOverlaySeedFromText,
  safeValidateVectorOverlayDocument,
  type VectorOverlayAlign,
  type VectorOverlayDocument,
  type VectorOverlayElement,
  type VectorOverlayElementType,
  type VectorOverlayLayoutId,
  type VectorOverlayThemeId,
} from "../../../shared/vector-overlay";
import { suiteApi, type ApiSuiteTask, type ApiTaskVersion } from "../../api/client";
import { Icon } from "../../pages/shared";
import "./VectorOverlayEditorModal.css";

export interface VectorOverlayEditorModalProps {
  task: ApiSuiteTask;
  version: ApiTaskVersion;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onNotify: (message: string) => void;
}

type FrameRect = { left: number; top: number; width: number; height: number };

const ELEMENT_TYPE_LABELS: Record<VectorOverlayElementType, string> = {
  text: "标题",
  pill: "胶囊",
  callout: "标注",
  card: "信息卡",
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function toColorInputHex(color: string | undefined, fallback = "#0f172a"): string {
  if (!color) return fallback;
  const trimmed = color.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed;
  if (/^#[0-9a-fA-F]{8}$/.test(trimmed)) return trimmed.slice(0, 7);
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const [, r, g, b] = trimmed;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return fallback;
}

function buildInitialDocument(task: ApiSuiteTask, version: ApiTaskVersion): VectorOverlayDocument {
  const existing = version.promptSnapshot?.vectorOverlay;
  const parsed = safeValidateVectorOverlayDocument(existing);
  if (parsed.ok) {
    return structuredClone(parsed.value);
  }
  const seed = extractOverlaySeedFromText({
    title: task.title,
    purpose: task.purpose,
    promptDraft: task.promptDraft,
    themeId: "dark_tech",
  });
  return createVectorOverlayPreset("hero_color_block", seed);
}

function deriveSeedFromElements(
  elements: VectorOverlayElement[],
  task: ApiSuiteTask,
  themeId: VectorOverlayThemeId,
) {
  const fallback = extractOverlaySeedFromText({
    title: task.title,
    purpose: task.purpose,
    promptDraft: task.promptDraft,
    themeId,
  });
  const firstText = elements.find((item) => item.type === "text");
  const pointTexts = elements
    .filter((item) => item.id !== firstText?.id)
    .map((item) => item.text.trim())
    .filter(Boolean);
  return {
    headline: firstText?.text.trim() || fallback.headline,
    subhead: (firstText && "subtext" in firstText ? firstText.subtext?.trim() : undefined) || fallback.subhead,
    points: pointTexts.length ? pointTexts : fallback.points,
    themeId,
  };
}

function applyThemeToElements(elements: VectorOverlayElement[], themeId: VectorOverlayThemeId): VectorOverlayElement[] {
  const theme = VECTOR_OVERLAY_THEMES[themeId];
  return elements.map((el) => {
    if (el.type === "text") {
      return {
        ...el,
        color: theme.textColor,
        ...(el.bgColor && el.bgColor !== "transparent" ? { bgColor: theme.bgColor } : {}),
      };
    }
    if (el.type === "pill") {
      return {
        ...el,
        color: theme.pillTextColor,
        bgColor: theme.pillBgColor,
        borderColor: theme.borderColor,
      };
    }
    if (el.type === "callout") {
      return {
        ...el,
        color: theme.textColor,
        bgColor: theme.cardBgColor,
        lineColor: theme.lineColor,
      };
    }
    return {
      ...el,
      color: theme.textColor,
      bgColor: theme.cardBgColor,
      borderColor: theme.borderColor,
    };
  });
}

export function VectorOverlayEditorModal({
  task,
  version,
  onClose,
  onSaved,
  onNotify,
}: VectorOverlayEditorModalProps) {
  const cleanBaseVersion = useMemo(() => {
    const cleanId = typeof version.promptSnapshot?.cleanBaseVersionId === "string"
      ? version.promptSnapshot.cleanBaseVersionId
      : null;
    return (cleanId ? task.versions.find((item) => item.id === cleanId) : null) ?? version;
  }, [task.versions, version]);

  const [doc, setDoc] = useState<VectorOverlayDocument>(() => buildInitialDocument(task, version));
  const [selectedId, setSelectedId] = useState<string | null>(() => buildInitialDocument(task, version).elements[0]?.id ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [frame, setFrame] = useState<FrameRect>({ left: 0, top: 0, width: 480, height: 480 });
  const stageContainerRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const transformerRef = useRef<Konva.Transformer | null>(null);
  const nodeRefs = useRef<Map<string, Konva.Group>>(new Map());

  const selectedElement = doc.elements.find((item) => item.id === selectedId) ?? null;

  const updateFrame = useCallback(() => {
    const image = imageRef.current;
    const container = stageContainerRef.current;
    if (!image || !container) return;
    const imageRect = image.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    if (!imageRect.width || !imageRect.height) return;
    setFrame({
      left: imageRect.left - containerRect.left,
      top: imageRect.top - containerRect.top,
      width: imageRect.width,
      height: imageRect.height,
    });
  }, []);

  useEffect(() => {
    const observer = new ResizeObserver(updateFrame);
    if (stageContainerRef.current) observer.observe(stageContainerRef.current);
    if (imageRef.current) observer.observe(imageRef.current);
    updateFrame();
    return () => observer.disconnect();
  }, [updateFrame]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  useEffect(() => {
    const transformer = transformerRef.current;
    if (!transformer) return;
    const node = selectedId ? nodeRefs.current.get(selectedId) : null;
    if (!node) {
      transformer.nodes([]);
      transformer.getLayer()?.batchDraw();
      return;
    }
    transformer.nodes([node]);
    transformer.getLayer()?.batchDraw();
  }, [selectedId, doc.elements, frame]);

  const updateElement = (id: string, patch: Partial<VectorOverlayElement>) => {
    setError("");
    setDoc((current) => ({
      ...current,
      elements: current.elements.map((item) => (item.id === id ? ({ ...item, ...patch } as VectorOverlayElement) : item)),
    }));
  };

  const switchLayout = (layoutId: VectorOverlayLayoutId) => {
    setError("");
    if (layoutId === "custom") {
      setDoc((current) => ({ ...current, layoutId: "custom" }));
      return;
    }
    const seed = deriveSeedFromElements(doc.elements, task, doc.themeId);
    const nextDoc = createVectorOverlayPreset(layoutId, seed);
    setDoc(nextDoc);
    setSelectedId(nextDoc.elements[0]?.id ?? null);
  };

  const switchTheme = (themeId: VectorOverlayThemeId) => {
    setError("");
    setDoc((current) => ({
      ...current,
      themeId,
      elements: applyThemeToElements(current.elements, themeId),
    }));
  };

  const addElement = (type: VectorOverlayElementType) => {
    setError("");
    const next = createVectorOverlayElement(type, doc.themeId, doc.elements.length);
    setDoc((current) => ({
      ...current,
      elements: [...current.elements, next],
    }));
    setSelectedId(next.id);
  };

  const removeSelected = () => {
    if (!selectedElement) return;
    setError("");
    setDoc((current) => {
      const remaining = current.elements.filter((item) => item.id !== selectedElement.id);
      setSelectedId(remaining[0]?.id ?? null);
      return { ...current, elements: remaining };
    });
  };

  const clearElements = () => {
    setError("");
    setDoc((current) => ({ ...current, elements: [] }));
    setSelectedId(null);
  };

  const saveOverlay = async () => {
    const checked = safeValidateVectorOverlayDocument(doc);
    if (!checked.ok) {
      setError(doc.elements.length === 0 ? "请先添加至少 1 个图层后再保存" : "存在空文案或无效参数，请补全后再保存");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await suiteApi.renderVectorOverlay(task.id, {
        baseVersionId: cleanBaseVersion.id,
        overlay: checked.value,
      });
      await onSaved();
      onNotify("已保存矢量卖点排版版本");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "矢量合成失败，请重试");
    } finally {
      setSaving(false);
    }
  };

  const handleBoxDragEnd = (el: VectorOverlayElement, node: Konva.Group) => {
    const nextX = clamp(node.x() / Math.max(1, frame.width), 0, 0.98);
    const nextY = clamp(node.y() / Math.max(1, frame.height), 0, 0.98);
    updateElement(el.id, { x: Number(nextX.toFixed(4)), y: Number(nextY.toFixed(4)) });
  };

  const handleBoxTransformEnd = (el: VectorOverlayElement, node: Konva.Group) => {
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();
    const nextW = clamp((el.width * frame.width * scaleX) / Math.max(1, frame.width), 0.06, 1);
    const nextH = clamp((el.height * frame.height * scaleY) / Math.max(1, frame.height), 0.04, 1);
    const nextX = clamp(node.x() / Math.max(1, frame.width), 0, 0.98);
    const nextY = clamp(node.y() / Math.max(1, frame.height), 0, 0.98);
    node.scaleX(1);
    node.scaleY(1);
    updateElement(el.id, {
      x: Number(nextX.toFixed(4)),
      y: Number(nextY.toFixed(4)),
      width: Number(nextW.toFixed(4)),
      height: Number(nextH.toFixed(4)),
    });
  };

  return (
    <div
      className="vo-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <section className="vo-modal" role="dialog" aria-modal="true" aria-label="卖点排版编辑器">
        <header className="vo-modal-head">
          <div>
            <strong>卖点排版编辑器</strong>
            <small>
              {task.title} · 底图基于 v{cleanBaseVersion.versionNumber}（无字底图，支持无限次非破坏性编辑）
            </small>
          </div>
          <button type="button" aria-label="关闭卖点排版编辑器" disabled={saving} onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>

        <div className="vo-toolbar">
          <label className="vo-layout-picker">
            <span>商业版式</span>
            <select
              aria-label="商业版式"
              value={doc.layoutId}
              onChange={(event) => switchLayout(event.target.value as VectorOverlayLayoutId)}
            >
              {SELLING_POINT_LAYOUTS.map((layout) => (
                <option key={layout.id} value={layout.id}>
                  {layout.name}（{layout.tag}）
                </option>
              ))}
              {doc.layoutId === "custom" && <option value="custom">自定义排版</option>}
            </select>
          </label>

          <div className="vo-theme-group" role="group" aria-label="商业配色主题">
            <span>配色主题</span>
            {VECTOR_OVERLAY_THEME_LIST.map((theme) => (
              <button
                key={theme.id}
                type="button"
                aria-pressed={doc.themeId === theme.id}
                className={doc.themeId === theme.id ? "is-active" : ""}
                onClick={() => switchTheme(theme.id)}
              >
                <i style={{ background: theme.accentColor }} aria-hidden="true" />
                {theme.name}
              </button>
            ))}
          </div>
        </div>

        <div className="vo-modal-body">
          <div className="vo-stage-area">
            <div className="vo-stage-canvas" ref={stageContainerRef}>
              <img
                ref={imageRef}
                src={cleanBaseVersion.previewUrl}
                alt={`${task.title} 底图`}
                onLoad={updateFrame}
              />
              <Stage
                width={frame.width}
                height={frame.height}
                style={{ position: "absolute", left: frame.left, top: frame.top }}
                onMouseDown={(event) => {
                  if (event.target === event.target.getStage()) setSelectedId(null);
                }}
              >
                <Layer>
                  {doc.elements.map((el) => {
                    const x = el.x * frame.width;
                    const y = el.y * frame.height;
                    const w = el.width * frame.width;
                    const h = el.height * frame.height;
                    const fontSize = Math.max(11, el.fontSize * frame.height);
                    const subFontSize = Math.max(9.5, fontSize * 0.62);
                    const isSelected = el.id === selectedId;

                    if (el.type === "callout") {
                      const ax = el.anchorX * frame.width;
                      const ay = el.anchorY * frame.height;
                      const attachX = ax < x ? x : ax > x + w ? x + w : x + w / 2;
                      const attachY = Math.abs(ay - (y + h / 2)) > h * 0.42
                        ? (ay < y + h / 2 ? y : y + h)
                        : y + h / 2;
                      const elbowX = ax + (attachX - ax) * 0.55;
                      return (
                        <Group key={el.id}>
                          <Line
                            points={[ax, ay, elbowX, attachY, attachX, attachY]}
                            stroke={el.lineColor}
                            strokeWidth={2}
                            lineCap="round"
                            lineJoin="round"
                            listening={false}
                          />
                          <Group
                            x={ax}
                            y={ay}
                            draggable
                            onDragEnd={(event) => {
                              const nextAx = clamp(event.target.x() / Math.max(1, frame.width), 0, 1);
                              const nextAy = clamp(event.target.y() / Math.max(1, frame.height), 0, 1);
                              updateElement(el.id, {
                                anchorX: Number(nextAx.toFixed(4)),
                                anchorY: Number(nextAy.toFixed(4)),
                              });
                            }}
                          >
                            <KonvaCircle radius={9} fill={el.lineColor} opacity={0.28} stroke="#ffffff" strokeWidth={1.5} />
                            <KonvaCircle radius={4.5} fill={el.lineColor} />
                          </Group>
                          <Group
                            ref={(node) => {
                              if (node) nodeRefs.current.set(el.id, node);
                              else nodeRefs.current.delete(el.id);
                            }}
                            x={x}
                            y={y}
                            width={w}
                            height={h}
                            draggable
                            onClick={() => setSelectedId(el.id)}
                            onTap={() => setSelectedId(el.id)}
                            onDragEnd={(event) => handleBoxDragEnd(el, event.target as Konva.Group)}
                            onTransformEnd={(event) => handleBoxTransformEnd(el, event.target as Konva.Group)}
                          >
                            <KonvaRect
                              width={w}
                              height={h}
                              cornerRadius={Math.min(12, h * 0.18)}
                              fill={el.bgColor}
                              stroke={isSelected ? "#3b82f6" : el.lineColor}
                              strokeWidth={isSelected ? 2 : 1.2}
                            />
                            <KonvaText
                              x={10}
                              y={8}
                              width={Math.max(16, w - 20)}
                              text={el.text}
                              fontSize={fontSize}
                              fontStyle="bold"
                              fill={el.color}
                              align={el.align}
                              ellipsis
                              wrap="word"
                            />
                            {el.subtext && (
                              <KonvaText
                                x={10}
                                y={8 + fontSize * 1.25}
                                width={Math.max(16, w - 20)}
                                text={el.subtext}
                                fontSize={subFontSize}
                                fill={el.color}
                                opacity={0.85}
                                align={el.align}
                                ellipsis
                                wrap="word"
                              />
                            )}
                          </Group>
                        </Group>
                      );
                    }

                    const bgFill = el.type === "text" ? (el.bgColor && el.bgColor !== "transparent" ? el.bgColor : undefined) : el.bgColor;
                    const strokeColor = isSelected
                      ? "#3b82f6"
                      : el.type === "pill" || el.type === "card"
                        ? el.borderColor
                        : undefined;
                    const cornerRadius = el.type === "pill" ? h / 2 : Math.min(14, h * 0.16);
                    const hasSubtext = "subtext" in el && Boolean(el.subtext?.trim());
                    const padX = el.type === "pill" ? Math.max(14, h * 0.35) : 12;

                    return (
                      <Group
                        key={el.id}
                        ref={(node) => {
                          if (node) nodeRefs.current.set(el.id, node);
                          else nodeRefs.current.delete(el.id);
                        }}
                        x={x}
                        y={y}
                        width={w}
                        height={h}
                        draggable
                        onClick={() => setSelectedId(el.id)}
                        onTap={() => setSelectedId(el.id)}
                        onDragEnd={(event) => handleBoxDragEnd(el, event.target as Konva.Group)}
                        onTransformEnd={(event) => handleBoxTransformEnd(el, event.target as Konva.Group)}
                      >
                        <KonvaRect
                          width={w}
                          height={h}
                          cornerRadius={cornerRadius}
                          fill={bgFill}
                          stroke={strokeColor}
                          strokeWidth={isSelected ? 2 : strokeColor ? 1.2 : 0}
                        />
                        {el.type === "pill" && (
                          <KonvaCircle
                            x={padX * 0.65}
                            y={h / 2}
                            radius={Math.max(3.5, Math.min(7, h * 0.16))}
                            fill={el.color}
                            opacity={0.9}
                          />
                        )}
                        <KonvaText
                          x={el.type === "pill" ? padX + 6 : padX}
                          y={hasSubtext ? Math.max(6, h * 0.14) : Math.max(4, (h - fontSize * 1.15) / 2)}
                          width={Math.max(16, w - (el.type === "pill" ? padX + 14 : padX * 2))}
                          text={el.text}
                          fontSize={fontSize}
                          fontStyle="bold"
                          fill={el.color}
                          align={el.align}
                          ellipsis
                          wrap="word"
                        />
                        {hasSubtext && "subtext" in el && el.subtext && (
                          <KonvaText
                            x={padX}
                            y={Math.max(6, h * 0.14) + fontSize * 1.24}
                            width={Math.max(16, w - padX * 2)}
                            text={el.subtext}
                            fontSize={subFontSize}
                            fill={el.color}
                            opacity={0.85}
                            align={el.align}
                            ellipsis
                            wrap="word"
                          />
                        )}
                      </Group>
                    );
                  })}
                  <Transformer
                    ref={transformerRef}
                    rotateEnabled={false}
                    borderStroke="#3b82f6"
                    borderDash={[5, 4]}
                    anchorStroke="#3b82f6"
                    anchorFill="#ffffff"
                    enabledAnchors={["top-left", "top-right", "bottom-left", "bottom-right", "middle-left", "middle-right"]}
                    boundBoxFunc={(oldBox, newBox) => (newBox.width < 28 || newBox.height < 18 ? oldBox : newBox)}
                  />
                </Layer>
              </Stage>
            </div>
            <p className="vo-stage-tip">
              在画布中直接拖拽元素调整位置、拖拽边框缩放宽高；指示线圆点也可独立拖动对准产品细节。
            </p>
          </div>

          <aside className="vo-inspector">
            <div className="vo-quick-add">
              <strong>图层管理 ({doc.elements.length})</strong>
              <div className="vo-quick-add-buttons">
                <button type="button" onClick={() => addElement("text")}>＋ 标题</button>
                <button type="button" onClick={() => addElement("pill")}>＋ 卖点胶囊</button>
                <button type="button" onClick={() => addElement("callout")}>＋ 标注线</button>
                <button type="button" onClick={() => addElement("card")}>＋ 卖点卡</button>
                <button type="button" className="vo-danger-btn" disabled={!doc.elements.length} onClick={clearElements}>
                  清空图层
                </button>
              </div>
            </div>

            <div className="vo-layer-list" role="listbox" aria-label="矢量图层列表">
              {doc.elements.length === 0 ? (
                <p className="vo-empty-tip">当前暂无图层，请添加元素或选择上方商业版式。</p>
              ) : (
                doc.elements.map((el) => (
                  <button
                    key={el.id}
                    type="button"
                    role="option"
                    aria-selected={el.id === selectedId}
                    className={`vo-layer-item ${el.id === selectedId ? "is-selected" : ""}`}
                    onClick={() => setSelectedId(el.id)}
                  >
                    <span className="vo-layer-badge">{ELEMENT_TYPE_LABELS[el.type]}</span>
                    <strong>{el.text}</strong>
                  </button>
                ))
              )}
            </div>

            {selectedElement && (
              <div className="vo-element-props">
                <div className="vo-props-head">
                  <strong>属性编辑 · {ELEMENT_TYPE_LABELS[selectedElement.type]}</strong>
                  <button type="button" className="vo-danger-btn" onClick={removeSelected}>删除元素</button>
                </div>

                <label className="vo-field">
                  <span>元素主文案</span>
                  <input
                    type="text"
                    aria-label="元素主文案"
                    value={selectedElement.text}
                    onChange={(event) => updateElement(selectedElement.id, { text: event.target.value })}
                  />
                </label>

                {selectedElement.type !== "pill" && (
                  <label className="vo-field">
                    <span>元素副文案</span>
                    <input
                      type="text"
                      aria-label="元素副文案"
                      value={selectedElement.subtext ?? ""}
                      placeholder="可选补充说明"
                      onChange={(event) => updateElement(selectedElement.id, { subtext: event.target.value })}
                    />
                  </label>
                )}

                <label className="vo-field">
                  <span>字号大小（{(selectedElement.fontSize * 100).toFixed(1)}%）</span>
                  <input
                    type="range"
                    aria-label="字号大小"
                    min={0.016}
                    max={0.09}
                    step={0.002}
                    value={selectedElement.fontSize}
                    onChange={(event) => updateElement(selectedElement.id, { fontSize: Number(event.target.value) })}
                  />
                </label>

                <div className="vo-color-row">
                  <label className="vo-field">
                    <span>文字颜色</span>
                    <input
                      type="color"
                      aria-label="文字颜色"
                      value={toColorInputHex(selectedElement.color, "#ffffff")}
                      onChange={(event) => updateElement(selectedElement.id, { color: event.target.value })}
                    />
                  </label>
                  <label className="vo-field">
                    <span>背景颜色</span>
                    <input
                      type="color"
                      aria-label="背景颜色"
                      value={toColorInputHex(selectedElement.bgColor, "#0f172a")}
                      onChange={(event) => updateElement(selectedElement.id, { bgColor: `${event.target.value}EB` })}
                    />
                  </label>
                </div>

                <div className="vo-field">
                  <span>对齐方式</span>
                  <div className="vo-align-group" role="group" aria-label="对齐方式">
                    {([["left", "左对齐"], ["center", "居中"], ["right", "右对齐"]] as Array<[VectorOverlayAlign, string]>).map(([align, label]) => (
                      <button
                        key={align}
                        type="button"
                        aria-pressed={selectedElement.align === align}
                        className={selectedElement.align === align ? "is-active" : ""}
                        onClick={() => updateElement(selectedElement.id, { align })}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </aside>
        </div>

        <footer className="vo-modal-footer">
          {error && <strong className="vo-error" role="alert">{error}</strong>}
          <button type="button" disabled={saving} onClick={onClose}>取消</button>
          <button
            type="button"
            className="wb-primary-action vo-save-btn"
            disabled={saving || doc.elements.length === 0}
            onClick={() => void saveOverlay()}
          >
            {saving ? "合成中…" : "保存合成版本"}
          </button>
        </footer>
      </section>
    </div>
  );
}
