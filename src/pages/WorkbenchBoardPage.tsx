import { ResolutionCostNote } from "../components/ResolutionCostNote";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { applyNodeChanges, Background, Controls, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider, type Edge, type Node, type NodeProps, type Viewport, useNodesState, useReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { defaultImageOptions } from "../../shared/model-settings";
import { CHANGE_TEXT_MAX_LENGTH, CHANGE_TEXT_MAX_OPERATIONS, computeOutpaintCanvas, isOutpaintRatio, normalizeChangeTextReplacement, OUTPAINT_RATIOS, type OutpaintRatio } from "../../shared/image-editor";
import {
  applyStyleOverrideToPrompt,
  computeLineageHighlight,
  computeWorkbenchLanes,
  extractCardPromptPreview,
  SUPPORTED_OUTPUT_LANGUAGES,
  type LaneCardSize,
  type LaneLayoutItem,
  type LaneLayoutOptions,
  type ResolvedDeliverySlot,
} from "../../shared/workbench-delivery";
import { modelSettingsApi, suiteApi, type ApiCanvasLayout, type ApiImageEditProductInput, type ApiImageEditSelection, type ApiImageEditTool, type ApiLibraryResource, type ApiPromptTemplateCopy, type ApiProductMaterialRef, type ApiSuiteTask, type ApiTaskVersion, type ApiWorkbench } from "../api/client";
import { AppShell } from "../components/AppShell";
import { BeforeAfterLightbox, type LightboxPreview } from "../components/BeforeAfterLightbox";
import { CustomTaskModal } from "../components/CustomTaskModal";
import { DeliveryGalleryView } from "../components/DeliveryGalleryView";
import { ProductResourcePickerModal } from "../components/resource-picker";
import { VersionCompareModal } from "../components/VersionCompareModal";
import { stageLabel } from "../features/library/library-helpers";
import { Icon, ImageWithState, ModelSettingsMessage } from "./shared";
import { Circle as KonvaCircle, Layer, Line, Rect as KonvaRect, Stage, Text as KonvaText, Transformer } from "react-konva";
import type Konva from "konva";
import "./WorkbenchBoardPage.css";

type BoardMode = "compose" | "gallery";
type CanvasFilter = "all" | "main" | "detail" | "edit" | "failed";
type CardKind = "style" | "base" | "reverse-ref" | "task";
type BoardData = {
  kind: CardKind;
  title: string;
  subtitle?: string;
  task?: ApiSuiteTask;
  version?: ApiTaskVersion;
  imageUrl?: string;
  beforeImageUrl?: string | null;
  beforeLabel?: string;
  styleGuide?: string;
  styleOverridden?: boolean;
  freeStyle?: boolean;
  originalImage?: boolean;
  referenceCount?: number;
  lineage?: string;
  isEditChild?: boolean;
  isHighlighted?: boolean;
  isDimmed?: boolean;
  onPreview?: (preview: LightboxPreview) => void;
  onSelect?: (task: ApiSuiteTask, nodeId: string) => void;
  onGenerate?: (task: ApiSuiteTask) => void;
  onCopy?: (task: ApiSuiteTask) => void;
  onRegenerate?: (task: ApiSuiteTask) => void;
  onEdit?: (task: ApiSuiteTask, version?: ApiTaskVersion) => void;
  onCompareVersions?: (task: ApiSuiteTask) => void;
  onEditStyle?: () => void;
  onSelectVersion?: (task: ApiSuiteTask, versionId: string, selection: "current" | "final") => void;
};
type BoardNode = Node<BoardData>;
type EditTool = "re_edit" | "regenerate" | "add_text" | "change_text" | "inpaint" | "erase" | "expand" | "restore_product";
type MaskStroke = { mode: "draw" | "erase"; points: Array<{ x: number; y: number }>; size: number };
type DraftOperation = { operationId: string; type: ApiImageEditTool; summary: string; sourceVersionId: string; payload: Record<string, unknown> };
const freshOperationId = (type: DraftOperation["type"]) => `${type}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
const editOperationType = (tool: Exclude<EditTool, "regenerate">): ApiImageEditTool => tool === "inpaint" ? "redraw" : tool === "expand" ? "outpaint" : tool;
const editorToolFor = (type: ApiImageEditTool): Exclude<EditTool, "regenerate"> => type === "redraw" ? "inpaint" : type === "outpaint" ? "expand" : type;
const DEFAULT_EDIT_TEXT_REGION = { x: 0.36, y: 0.42, width: 0.28, height: 0.1, rotation: 0 };
type TextEditRow = {
  operationId: string;
  originalText: string;
  newText: string;
  region: typeof DEFAULT_EDIT_TEXT_REGION;
  manual: boolean;
  prompt?: string;
};
type ImageEditCapabilities = Record<string, boolean>;
type ImageFrame = { left: number; top: number; width: number; height: number };

const statusText = (value?: string) => ({ pending: "草稿", generating: "生成中", generated: "已生成", succeeded: "已生成", failed: "失败", archived: "已归档", incomplete: "待补全" } as Record<string, string>)[value ?? ""] ?? value ?? "草稿";
const readParam = (task: ApiSuiteTask, key: string, fallback: string) => {
  const value = task.generationParams?.[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
};
const ratioFor = (task: ApiSuiteTask) => readParam(task, "ratio", task.imageType === "detail" ? "3:4" : "1:1");
const sizeFor = (task: ApiSuiteTask) => readParam(task, "size", "1K");
const qualityFor = (task: ApiSuiteTask) => readParam(task, "quality", "medium");
const missingReferenceHint = "请先绑定商品参考图";
const hasTaskReference = (task: ApiSuiteTask) => Boolean(task.sourceInputImageId || task.sourceLibraryReferenceId);
const parameterOptions = (options: string[], value: string) => <>
  {!options.includes(value) && <option value={value} disabled>{value}（当前值）</option>}
  {options.map((option) => <option key={option}>{option}</option>)}
</>;
const versionGenerationPrompt = (version: Pick<ApiTaskVersion, "promptSnapshot">, fallback = "") => {
  const snapshot = version.promptSnapshot ?? {};
  const value = snapshot.finalPrompt ?? snapshot.prompt;
  return typeof value === "string" && value.trim() ? value : fallback;
};

function modelFor(task: ApiSuiteTask, version?: ApiTaskVersion) {
  const attempt = version ? task.attempts.find((item) => item.id === version.attemptId) : task.attempts[task.attempts.length - 1];
  const channel = attempt?.contextSnapshot.channel as { channelName?: string } | undefined;
  return attempt?.model ? [channel?.channelName, attempt.model].filter(Boolean).join(" · ") : undefined;
}

const fallbackPlanStyle = (workbench: ApiWorkbench) => {
  if (!workbench.planSnapshot) return "未设置";
  if (workbench.planStyleGuide?.trim()) return workbench.planStyleGuide.trim();
  const card = workbench.planSnapshot?.structure?.globalStyleCard;
  if (card && typeof card.promptPrefix === "string" && card.promptPrefix.trim()) return card.promptPrefix.trim();
  const values = { ...(workbench.planSnapshot?.dynamicInput ?? {}), ...(workbench.planSnapshot?.humanInput ?? {}) } as Record<string, unknown>;
  for (const key of ["design_style", "style_guide", "styleGuide", "visual_style"]) {
    if (typeof values[key] === "string" && values[key].trim()) return values[key].trim();
  }
  return "沿用计划模板默认风格，保持商品真实外观、光影和品牌一致性。";
};

function BoardCard({ id, data }: NodeProps<BoardNode>) {
  const onPreview = data.onPreview ?? (() => undefined);
  const onSelect = data.onSelect ?? (() => undefined);
  const onGenerate = data.onGenerate ?? (() => undefined);
  const onRegenerate = data.onRegenerate ?? (() => undefined);
  const onEdit = data.onEdit ?? (() => undefined);
  const onCompareVersions = data.onCompareVersions ?? (() => undefined);
  const onEditStyle = data.onEditStyle ?? (() => undefined);
  const onSelectVersion = data.onSelectVersion ?? (() => undefined);
  const [simulatedProgress, setSimulatedProgress] = useState(0);
  const availableVersions = data.task?.versions ?? [];
  const versionIds = availableVersions.map((version) => version.id).join("|");
  const [selectedVersionId, setSelectedVersionId] = useState(data.version?.id ?? "");
  const previousCurrentVersionId = useRef(data.version?.id ?? "");

  useEffect(() => {
    if (data.task?.status !== "generating") { setSimulatedProgress(0); return; }
    setSimulatedProgress((value) => value || 4);
    const timer = window.setInterval(() => setSimulatedProgress((value) => Math.min(96, value + Math.max(1, Math.ceil((96 - value) / 10)))), 450);
    return () => window.clearInterval(timer);
  }, [data.task?.status]);

  useEffect(() => {
    const currentId = data.version?.id ?? "";
    if (currentId && currentId !== previousCurrentVersionId.current) {
      previousCurrentVersionId.current = currentId;
      setSelectedVersionId(currentId);
      return;
    }
    if (!availableVersions.some((version) => version.id === selectedVersionId)) {
      setSelectedVersionId(currentId || availableVersions[0]?.id || "");
    }
  }, [data.version?.id, selectedVersionId, versionIds]);

  const highlightClass = data.isHighlighted ? "is-lineage-active" : data.isDimmed ? "is-lineage-dim" : "";

  if (data.kind === "style") {
    return (
      <article className={`wb-card wb-style-card ${highlightClass}`}>
        <Handle type="source" position={Position.Right} />
        <div className="wb-card-topline">
          <span className="wb-card-kicker">STYLE GUIDE</span>
          <span className={`wb-card-state ${data.styleOverridden ? "is-override" : "is-active"}`}>
            {data.freeStyle ? "自由风格" : data.styleOverridden ? "已覆盖原计划" : "原计划风格"}
          </span>
        </div>
        <h3>全局风格卡</h3>
        <p>{data.styleGuide}</p>
        <div className="wb-card-note">
          <Icon name="check" />
          {data.styleOverridden ? "仅作用于后续新提交生图，不篡改历史快照" : data.freeStyle ? "风格可编辑" : "已按计划冻结；点击编辑可前向微调"}
        </div>
        <button type="button" className="wb-link-button nodrag nopan" onClick={(event) => { event.stopPropagation(); onEditStyle(); }}>编辑</button>
      </article>
    );
  }

  if (data.kind === "base" || data.kind === "reverse-ref") {
    return (
      <article className={`wb-card wb-base-card ${highlightClass}`}>
        <Handle type="source" position={Position.Right} />
        <span className="wb-card-kicker">{data.kind === "reverse-ref" ? "REFERENCE IMAGE" : data.originalImage ? "ORIGINAL IMAGE" : "BASE IMAGE"}</span>
        <button className="wb-image-button nodrag nopan" type="button" onClick={(event) => { event.stopPropagation(); if (data.imageUrl) onPreview({ url: data.imageUrl, title: data.title, subtitle: data.subtitle }); }}>
          <ImageWithState src={data.imageUrl} alt={data.title} loading="lazy" retryable={false} />
        </button>
        <h3>{data.title}</h3>
        <p>{data.subtitle}</p>
      </article>
    );
  }

  const task = data.task;
  if (!task) return null;
  const version = availableVersions.find((item) => item.id === selectedVersionId) ?? data.version;
  const model = modelFor(task, version);
  const promptPreview = extractCardPromptPreview(task.promptDraft, task.purpose);
  const missingReference = !data.isEditChild && !hasTaskReference(task);

  return (
    <article className={`wb-card wb-task-card ${data.isEditChild ? "wb-edit-child-card" : ""} ${highlightClass}`} onClick={() => onSelect(task, id)}>
      <Handle type="target" position={Position.Left} />
      <div className="wb-card-topline">
        <span className="wb-card-kicker">{data.isEditChild ? "EDIT DERIVED" : task.imageType === "main" ? "MAIN IMAGE" : "DETAIL IMAGE"}</span>
        <span className={`wb-card-state state-${task.status}`}>{statusText(task.status)}</span>
      </div>
      {task.status === "generating" && (
        <div className="wb-simulated-progress" role="status" aria-label={`模型生成进度 ${simulatedProgress}%`}>
          <span><i style={{ transform: `scaleX(${simulatedProgress / 100})` }} /></span>
          <b>{simulatedProgress}%</b>
        </div>
      )}
      {version?.previewUrl && (
        <button
          className="wb-output-image nodrag nopan"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onPreview({
              url: version.previewUrl,
              title: task.title,
              subtitle: `${data.isEditChild ? "编辑子卡片" : task.imageType === "main" ? "主图" : "详情页"} · 版本 v${version.versionNumber}`,
              beforeUrl: data.beforeImageUrl,
              beforeLabel: data.beforeLabel,
              afterLabel: `编辑后 · 子卡 v${version.versionNumber}`,
            });
          }}
        >
          <ImageWithState src={version.previewUrl} alt={task.title} loading="lazy" retryable={false} />
          {data.beforeImageUrl && <span className="wb-compare-pill">点击对比前后</span>}
        </button>
      )}
      <h3>{task.title}</h3>
      {data.lineage && <p className="wb-card-lineage">{data.lineage}</p>}
      <div className="wb-task-stats">
        <span><b>图片</b><strong>{version ? 1 : 0} 张</strong></span>
        <span><b>参考图</b><strong>{data.referenceCount ?? 0} 张</strong></span>
        <span><b>提示词摘要</b><strong>{promptPreview.length} 字</strong></span>
        <span><b>状态</b><strong>{statusText(task.status)}</strong></span>
      </div>
      <p className="wb-task-prompt">{promptPreview}</p>
      <div className="wb-card-footer">
        {model && <span title={model}>{model}</span>}
        <span>{ratioFor(task)}</span>
        <span>{sizeFor(task)}</span>
        <span>{qualityFor(task)}</span>
      </div>
      <div className="wb-task-actions nodrag nopan">
        <button type="button" className="wb-card-generate" disabled={missingReference || task.status === "generating"} title={missingReference ? missingReferenceHint : undefined} onClick={(event) => { event.stopPropagation(); onGenerate(task); }}>
          <Icon name="sparkles" />生成
        </button>
        <button type="button" disabled={task.status === "generating" || (!version && task.status !== "failed")} onClick={(event) => { event.stopPropagation(); onRegenerate(task); }}>
          <Icon name="history" />{task.status === "failed" ? "重试" : "再次生成"}
        </button>
        <button type="button" className="wb-card-edit" disabled={!version} onClick={(event) => { event.stopPropagation(); onEdit(task, version); }}>
          <Icon name="edit" />编辑图片
        </button>
      </div>
      {missingReference && <small>{missingReferenceHint}</small>}
      {version && (
        <div className="wb-card-version-actions nodrag nopan">
          <select aria-label={`选择${task.title}版本`} value={version.id} onClick={(event) => event.stopPropagation()} onChange={(event) => setSelectedVersionId(event.target.value)}>
            {availableVersions.slice().sort((left, right) => right.versionNumber - left.versionNumber).map((item) => (
              <option value={item.id} key={item.id}>v{item.versionNumber}{item.isCurrent ? " · 当前" : ""}{item.isFinal ? " · 终版" : ""}</option>
            ))}
          </select>
          {version.isCurrent ? <span className="wb-version-status"><Icon name="check" />当前版本</span> : <button type="button" onClick={(event) => { event.stopPropagation(); onSelectVersion(task, version.id, "current"); }}>设为当前</button>}
          {version.isFinal ? <span className="wb-version-status is-final"><Icon name="check" />已是终版</span> : <button type="button" className="wb-version-final" onClick={(event) => { event.stopPropagation(); onSelectVersion(task, version.id, "final"); }}>设为终版</button>}
          {availableVersions.length >= 2 && (
            <button type="button" className="wb-version-compare-btn" onClick={(event) => { event.stopPropagation(); onCompareVersions(task); }}>
              对比 {availableVersions.length} 版
            </button>
          )}
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </article>
  );
}

const nodeTypes = { boardCard: BoardCard };

function imageEditChildTask(workbench: ApiWorkbench, child: NonNullable<ApiWorkbench["imageEditChildren"]>[number], index: number): ApiSuiteTask {
  const raw = child.task;
  return {
    id: String(raw.id),
    suiteId: workbench.suite.id,
    planSnapshotId: null,
    planItemId: null,
    ordinal: 10000 + index,
    imageType: "detail",
    title: `编辑子卡片 · ${String(raw.summary ?? "图片编辑")}`,
    purpose: "图片编辑结果",
    promptDraft: String(raw.summary ?? ""),
    promptRevision: 0,
    sourceInputImageId: null,
    generationParams: {},
    status: String(raw.status ?? "generating") as ApiSuiteTask["status"],
    archivedAt: null,
    createdAt: String(raw.createdAt ?? ""),
    updatedAt: String(raw.updatedAt ?? ""),
    versions: child.versions.map((item) => {
      const attempt = child.attempts.find((entry) => String(entry.id) === String(item.attemptId)) as Record<string, unknown> | undefined;
      const command = attempt?.command as Record<string, unknown> | undefined;
      return {
        id: item.id,
        taskId: String(raw.id),
        slotId: "",
        attemptId: String(item.attemptId ?? ""),
        versionNumber: item.versionNumber,
        objectKey: item.objectKey ?? "",
        processObjectKeys: [],
        sha256: "",
        width: Number(item.width ?? 1),
        height: Number(item.height ?? 1),
        mimeType: item.mimeType ?? "image/png",
        promptSnapshot: typeof command?.prompt === "string" ? { finalPrompt: command.prompt } : {},
        contextSnapshot: {},
        isCurrent: item.id === raw.currentVersionId,
        isFinal: item.id === raw.finalVersionId,
        createdAt: item.createdAt ?? "",
        previewUrl: item.previewUrl ?? `/api/image-editor/tasks/${String(raw.id)}/versions/${item.id}/preview`,
      };
    }),
    attempts: child.attempts.map((attempt) => ({
      id: String(attempt.id),
      slotId: "",
      attemptNo: Number(attempt.attemptNo ?? 1),
      provider: attempt.provider?.name ?? "image-editor",
      model: attempt.provider?.version ?? "",
      endpoint: "/v1/images/edits",
      requestSummary: {},
      promptSnapshot: {},
      promptSha256: "",
      contextSnapshot: { channel: attempt.provider?.channel },
      sourceKind: "original",
      sourceObjectKey: "",
      sourceInputImageId: null,
      sourceBaseVersionId: null,
      status: String(attempt.status ?? "failed") === "succeeded" ? "succeeded" : String(attempt.status ?? "failed") === "generating" ? "running" : "failed",
      errorCode: typeof attempt.errorCode === "string" ? attempt.errorCode : null,
      errorMessage: typeof attempt.errorMessage === "string" ? attempt.errorMessage : null,
      externalRequestId: null,
      startedAt: String(attempt.createdAt ?? ""),
      finishedAt: typeof attempt.completedAt === "string" ? attempt.completedAt : null,
    }) as ApiSuiteTask["attempts"][number]),
    slots: [],
  };
}

function buildVersionLookup(workbench: ApiWorkbench): Map<string, { url: string; label: string }> {
  const map = new Map<string, { url: string; label: string }>();
  for (const task of workbench.tasks) {
    for (const version of task.versions) {
      if (version.previewUrl) {
        map.set(version.id, { url: version.previewUrl, label: `编辑前 · ${task.title} v${version.versionNumber}` });
      }
    }
  }
  for (const child of workbench.imageEditChildren ?? []) {
    const childId = String(child.task.id ?? "");
    const title = String(child.task.summary ?? "编辑子卡");
    for (const version of child.versions) {
      const url = version.previewUrl ?? `/api/image-editor/tasks/${encodeURIComponent(childId)}/versions/${encodeURIComponent(version.id)}/preview`;
      map.set(version.id, { url, label: `编辑前 · ${title} v${version.versionNumber}` });
    }
  }
  return map;
}

function projectComposeGraph(
  workbench: ApiWorkbench,
  layout: ApiCanvasLayout | null,
  effectiveStyleGuide: string,
  styleOverride: string | null,
  selectedNodeId: string | null,
  canvasFilter: CanvasFilter,
  layoutOptions: LaneLayoutOptions,
  handlers: Pick<BoardData, "onPreview" | "onSelect" | "onGenerate" | "onCopy" | "onRegenerate" | "onEdit" | "onCompareVersions" | "onEditStyle" | "onSelectVersion">,
) {
  const saved = new Map((layout?.nodes ?? []).map((node) => [node.nodeId, { x: node.x, y: node.y }]));
  const active = workbench.tasks
    .filter((task) => task.status !== "archived" && task.originKind !== "replica" && (task.originKind === "reverse_import" || !workbench.planSnapshot || task.planSnapshotId === workbench.planSnapshot.id))
    .slice()
    .sort((left, right) => (left.imageType !== right.imageType ? (left.imageType === "main" ? -1 : 1) : left.ordinal - right.ordinal));
  const materialsByInputId = new Map(workbench.inputImages.map((image) => [image.id, {
    image,
    id: image.currentBaseVersionId ? `base:${image.currentBaseVersionId}` : `input:${image.id}`,
  }]));
  const reverseMaterials = new Map<string, { resourceId: string; resourceVersionId: string; title: string; previewUrl: string }>();
  active.forEach((task) => {
    const refs = Array.isArray(task.generationParams?.productMaterialRefs) ? task.generationParams.productMaterialRefs as ApiProductMaterialRef[] : [];
    refs.forEach((ref) => reverseMaterials.set(ref.resourceVersionId, { resourceId: ref.resourceId, resourceVersionId: ref.resourceVersionId, title: ref.title ?? "商品参考图", previewUrl: ref.previewUrl ?? `/api/library/resources/${encodeURIComponent(ref.resourceId)}/preview` }));
  });

  const versionLookup = buildVersionLookup(workbench);
  const styleId = "style:global";

  // 1. Collect lane items
  const laneItems: LaneLayoutItem[] = [{ id: styleId, kind: "style" }];
  materialsByInputId.forEach(({ id }) => laneItems.push({ id, kind: "base" }));
  [...reverseMaterials.values()].forEach((material) => laneItems.push({ id: `library-base:${material.resourceVersionId}`, kind: "base" }));
  const reverseRefSeen = new Set<string>();
  active.forEach((task) => {
    if (task.originKind === "reverse_import" && task.reversePlanId && task.reverseReferenceId) {
      const refId = `reverse-ref:${task.reverseReferenceId}`;
      if (!reverseRefSeen.has(refId)) {
        reverseRefSeen.add(refId);
        laneItems.push({ id: refId, kind: "reverse-ref" });
      }
    }
  });
  active.forEach((task) => laneItems.push({ id: `task:${task.id}`, kind: "task" }));

  const taskIdSet = new Set(active.map((t) => t.id));
  const syntheticChildren = (workbench.imageEditChildren ?? []).map((child, index) => {
    const raw = child.task as Record<string, unknown>;
    const synthetic = imageEditChildTask(workbench, child, index);
    const parentTaskId = String(raw.sourceCardId ?? "");
    const parentNodeId = taskIdSet.has(parentTaskId) ? `task:${parentTaskId}` : `edit-child:${parentTaskId}`;
    return { child, raw, synthetic, nodeId: `edit-child:${synthetic.id}`, parentNodeId };
  });
  syntheticChildren.forEach(({ nodeId, parentNodeId }) => laneItems.push({ id: nodeId, kind: "edit-child", parentId: parentNodeId }));

  const positions = computeWorkbenchLanes(laneItems, saved, layoutOptions);

  // 2. Build edges (suppress noisy style-to-all dashed lines unless style card is explicitly selected)
  const rawEdges: Edge[] = [];
  active.forEach((task) => {
    const id = `task:${task.id}`;
    if (task.originKind === "reverse_import" && task.reversePlanId && task.reverseReferenceId) {
      rawEdges.push({ id: `reverse-ref:${task.reverseReferenceId}->${id}`, source: `reverse-ref:${task.reverseReferenceId}`, target: id, type: "default" });
    }
    const sourceId = task.sourceInputImageId ? materialsByInputId.get(task.sourceInputImageId)?.id : undefined;
    if (sourceId && !task.sourceLibraryReferenceId) rawEdges.push({ id: `${sourceId}->${id}`, source: sourceId, target: id, type: "default", animated: task.status === "generating" });
    const materialRefs = Array.isArray(task.generationParams?.productMaterialRefs) ? task.generationParams.productMaterialRefs as ApiProductMaterialRef[] : [];
    materialRefs.forEach((ref) => rawEdges.push({ id: `library-base:${ref.resourceVersionId}->${id}`, source: `library-base:${ref.resourceVersionId}`, target: id, type: "default", animated: task.status === "generating" }));
    if (selectedNodeId === styleId) {
      rawEdges.push({ id: `${styleId}->${id}`, source: styleId, target: id, type: "smoothstep", style: { strokeDasharray: "5 5" } });
    }
  });
  const knownNodeIds = new Set(laneItems.map((item) => item.id));
  syntheticChildren.forEach(({ nodeId, parentNodeId }) => {
    if (knownNodeIds.has(parentNodeId)) {
      rawEdges.push({ id: `${parentNodeId}->${nodeId}`, source: parentNodeId, target: nodeId, type: "smoothstep" });
    }
  });

  // 3. Compute lineage highlight
  const hasSelection = Boolean(selectedNodeId && knownNodeIds.has(selectedNodeId));
  const { highlightedNodeIds, highlightedEdgeIds } = computeLineageHighlight(hasSelection ? selectedNodeId : null, rawEdges);

  const styledEdges: Edge[] = rawEdges.map((edge) => {
    const isLit = highlightedEdgeIds.has(edge.id);
    return {
      ...edge,
      zIndex: isLit ? 5 : 0,
      style: {
        ...(edge.style ?? {}),
        stroke: isLit ? "#2563eb" : "#64748b",
        strokeWidth: isLit ? 2.6 : 1.8,
        opacity: hasSelection ? (isLit ? 1 : 0.28) : 0.85,
      },
    };
  });

  const filterMatches = (kind: CardKind, task?: ApiSuiteTask, isEditChild?: boolean) => {
    if (canvasFilter === "all") return true;
    if (canvasFilter === "main") return kind === "task" && !isEditChild && task?.imageType === "main";
    if (canvasFilter === "detail") return kind === "task" && !isEditChild && task?.imageType === "detail";
    if (canvasFilter === "edit") return Boolean(isEditChild);
    if (canvasFilter === "failed") return kind === "task" && (task?.status === "failed" || task?.status === "pending" || task?.status === "incomplete");
    return true;
  };

  const nodeHighlightProps = (id: string, kind: CardKind, task?: ApiSuiteTask, isEditChild?: boolean) => {
    if (hasSelection) {
      return {
        isHighlighted: highlightedNodeIds.has(id),
        isDimmed: !highlightedNodeIds.has(id),
      };
    }
    if (canvasFilter !== "all") {
      const matched = filterMatches(kind, task, isEditChild);
      return { isHighlighted: matched, isDimmed: !matched };
    }
    return { isHighlighted: false, isDimmed: false };
  };

  // 4. Build nodes
  const nodes: BoardNode[] = [];
  nodes.push({
    id: styleId,
    type: "boardCard",
    position: positions.get(styleId) ?? { x: 32, y: 28 },
    data: {
      kind: "style",
      title: "全局风格卡",
      styleGuide: effectiveStyleGuide,
      styleOverridden: Boolean(styleOverride),
      freeStyle: !workbench.planSnapshot,
      ...nodeHighlightProps(styleId, "style"),
      ...handlers,
    },
    draggable: true,
  });

  materialsByInputId.forEach(({ id, image }) => {
    nodes.push({
      id,
      type: "boardCard",
      position: positions.get(id) ?? { x: 32, y: 260 },
      data: {
        kind: "base",
        title: `${image.currentBaseVersionId ? "白底图" : "原图"} ${image.ordinal}`,
        subtitle: image.currentBaseVersionId ? `${image.width} × ${image.height}` : image.originalFilename,
        imageUrl: image.currentBaseVersionId ? `/api/suites/${workbench.suite.id}/input-images/${image.id}/base-versions/${image.currentBaseVersionId}/preview` : image.originalPreviewUrl,
        originalImage: !image.currentBaseVersionId,
        ...nodeHighlightProps(id, "base"),
        ...handlers,
      },
      draggable: true,
    });
  });

  [...reverseMaterials.values()].forEach((material) => {
    const id = `library-base:${material.resourceVersionId}`;
    nodes.push({
      id,
      type: "boardCard",
      position: positions.get(id) ?? { x: 32, y: 260 },
      data: {
        kind: "base",
        title: material.title,
        subtitle: `图片库 · ${material.resourceVersionId.slice(0, 8)}`,
        originalImage: material.resourceId.startsWith("input:"),
        imageUrl: material.previewUrl,
        ...nodeHighlightProps(id, "base"),
        ...handlers,
      },
      draggable: true,
    });
  });

  const addedRefNodes = new Set<string>();
  active.forEach((task) => {
    const id = `task:${task.id}`;
    const currentVersion = task.versions.find((version) => version.isCurrent) ?? task.versions[0];
    nodes.push({
      id,
      type: "boardCard",
      position: positions.get(id) ?? { x: 348, y: 28 },
      data: {
        kind: "task",
        title: task.title,
        task,
        version: currentVersion,
        imageUrl: currentVersion?.previewUrl,
        referenceCount: Array.isArray(task.generationParams?.productMaterialRefs) && task.generationParams.productMaterialRefs.length > 0
          ? task.generationParams.productMaterialRefs.length : hasTaskReference(task) ? 1 : 0,
        ...nodeHighlightProps(id, "task", task, false),
        ...handlers,
      },
      draggable: true,
    });
    if (task.originKind === "reverse_import" && task.reversePlanId && task.reverseReferenceId) {
      const refId = `reverse-ref:${task.reverseReferenceId}`;
      if (!addedRefNodes.has(refId)) {
        addedRefNodes.add(refId);
        nodes.push({
          id: refId,
          type: "boardCard",
          position: positions.get(refId) ?? { x: 32, y: 260 },
          data: {
            kind: "reverse-ref",
            title: task.title,
            subtitle: "爆品参考图，仅用于视觉结构",
            imageUrl: `/api/reverse-plans/${task.reversePlanId}/references/${task.reverseReferenceId}/preview`,
            ...nodeHighlightProps(refId, "reverse-ref"),
            ...handlers,
          },
          draggable: true,
        });
      }
    }
  });

  syntheticChildren.forEach(({ child, raw, synthetic, nodeId }) => {
    const childVersion = synthetic.versions.find((version) => version.isCurrent) ?? synthetic.versions[0];
    const childAttempts = Array.isArray(child.attempts) ? child.attempts : [];
    const snapshot = child.snapshot as Record<string, unknown> | null;
    const sourceVersionId = String(raw.sourceVersionId ?? snapshot?.sourceVersionId ?? "");
    const operationCount = Array.isArray(snapshot?.operations) ? snapshot.operations.length : 0;
    const latestAttempt = childAttempts[childAttempts.length - 1] as Record<string, unknown> | undefined;
    const lineage = `来源版本 ${sourceVersionId ? sourceVersionId.slice(0, 8) : "未知"} · ${operationCount || 1} 个操作 · ${statusText(String(latestAttempt?.status ?? raw.status ?? "pending"))}`;
    const beforeSource = sourceVersionId ? versionLookup.get(sourceVersionId) : undefined;
    nodes.push({
      id: nodeId,
      type: "boardCard",
      position: positions.get(nodeId) ?? { x: 1040, y: 28 },
      data: {
        kind: "task",
        title: synthetic.title,
        task: synthetic,
        version: childVersion,
        imageUrl: childVersion?.previewUrl,
        beforeImageUrl: beforeSource?.url ?? null,
        beforeLabel: beforeSource?.label,
        lineage,
        isEditChild: true,
        ...nodeHighlightProps(nodeId, "task", synthetic, true),
        ...handlers,
      },
      draggable: true,
    });
  });

  return { nodes, edges: styledEdges };
}

function PromptLibraryButton({ onNotify }: { onNotify: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<ApiPromptTemplateCopy["stage"] | "">("");
  const [templates, setTemplates] = useState<ApiPromptTemplateCopy[]>([]);
  const [selected, setSelected] = useState<ApiPromptTemplateCopy | null>(null);
  const load = async () => {
    const listed = await suiteApi.listPromptTemplates(stage || undefined);
    const full = await Promise.all(listed.map((item) => suiteApi.copyPromptTemplate(item.templateVersionId, item.stage)));
    setTemplates(full);
    setSelected(full[0] ?? null);
  };
  return (
    <>
      <div className="wb-prompt-library">
        <button type="button" className="wb-prompt-library-toggle" onClick={() => { setOpen((value) => !value); if (!open) load().catch(() => onNotify("提示词库加载失败，请重试")); }}>
          <Icon name="library" />提示词库
        </button>
      </div>
      {open && (
        <div className="wb-prompt-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
          <section className="wb-prompt-modal" role="dialog" aria-modal="true" aria-label="提示词库">
            <div className="wb-prompt-popover-head">
              <div><span className="wb-modal-eyebrow">PROMPT LIBRARY</span><strong>提示词库</strong></div>
              <button type="button" aria-label="关闭提示词库" onClick={() => setOpen(false)}><Icon name="x" /></button>
            </div>
            <select value={stage} onChange={(event) => {
              const next = event.target.value as typeof stage;
              setStage(next);
              suiteApi.listPromptTemplates(next || undefined).then(async (items) => {
                const full = await Promise.all(items.map((item) => suiteApi.copyPromptTemplate(item.templateVersionId, item.stage)));
                setTemplates(full);
                setSelected(full[0] ?? null);
              }).catch(() => onNotify("阶段模板加载失败"));
            }}>
              <option value="">全部阶段</option>
              <option value="structure_plan">结构规划</option>
              <option value="category_prompt">类别提示词</option>
              <option value="base_refine">底图精修</option>
              <option value="listing_copy">上架文案</option>
              <option value="replica_prompt">爆品图复刻</option>
              <option value="product_onboarding">商品建档</option>
            </select>
            <div className="wb-prompt-list">
              {templates.length > 0 ? templates.map((template) => (
                <button type="button" key={template.templateVersionId} className={selected?.templateVersionId === template.templateVersionId ? "is-selected" : ""} onClick={() => setSelected(template)}>
                  <strong>{template.name}</strong>
                  <span>{template.usedBy?.length ? template.usedBy.join(" / ") : stageLabel(template.stage)} · v{template.versionNo}</span>
                </button>
              )) : (
                <div className="wb-prompt-empty">当前阶段暂无在用提示词模板</div>
              )}
            </div>
            {selected && (
              <div className="wb-prompt-detail">
                <strong>{selected.name}</strong>
                <pre>{selected.body}</pre>
                <button type="button" onClick={() => navigator.clipboard.writeText(selected.body).then(() => onNotify("提示词已复制")).catch(() => onNotify("复制失败，请重试"))}>
                  <Icon name="copy" />复制提示词
                </button>
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}

function WhiteResourcePicker({ task, onBound, onNotify }: { task: ApiSuiteTask; onBound: () => Promise<void>; onNotify: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const bound = Array.isArray(task.generationParams?.productMaterialRefs) ? task.generationParams.productMaterialRefs as ApiProductMaterialRef[] : [];

  return (
    <>
      <div className="wb-inspector-field">
        <span>图片库参考图</span>
        {bound.length > 0 && <div className="wb-material-summary">{bound.map((item, index) => <span key={item.resourceId}>{index + 1}. {item.title ?? item.resourceId.slice(0, 8)}</span>)}</div>}
        <button type="button" className="wb-link-button" disabled={task.status === "generating"} onClick={() => setOpen(true)}>从图片库选择</button>
      </div>
      <ProductResourcePickerModal
        open={open}
        onClose={() => setOpen(false)}
        max={3}
        initialSelected={bound}
        title="选择图片库参考图"
        subtitle="最多 3 张已发布白底底图，按顺序作为主图和补充角度"
        confirmLabel="确认绑定"
        onConfirm={async (selected) => {
          await suiteApi.bindWhiteResources(task.id, selected.map((item) => item.resourceId));
          await onBound();
          onNotify("已绑定图片库参考图");
        }}
        onError={() => onNotify("参考图绑定失败")}
      />
    </>
  );
}

function formatClientOcrError(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const trimmed = raw.trim();
  if (!trimmed) return "文字识别失败，可点击重新识别，或直接在图片上框选并手动输入原文字与新文字";
  if (/timeout|timed out|abort|OCR_TIMEOUT/i.test(trimmed)) {
    return "文字识别请求超时，可点击重新识别，或直接在图片上框选并手动输入原文字与新文字";
  }
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|network|socket/i.test(trimmed)) {
    return "文字识别服务连接失败，可点击重新识别，或直接在图片上框选并手动输入原文字与新文字";
  }
  if (/^OCR_HTTP_\d+$/.test(trimmed) || trimmed.startsWith("OCR_")) {
    return "文字识别服务返回异常，可点击重新识别，或直接在图片上框选并手动输入原文字与新文字";
  }
  if (/[\u4e00-\u9fa5]/.test(trimmed)) return trimmed;
  return "文字识别失败，可点击重新识别，或直接在图片上框选并手动输入原文字与新文字";
}

export type ImageEditorTaskInput = Pick<ApiSuiteTask, "id" | "title" | "promptDraft">;
export type ImageEditorVersionInput = Pick<
  ApiTaskVersion,
  "id" | "versionNumber" | "previewUrl" | "width" | "height" | "promptSnapshot"
>;

export function ImageEditorModal({
  task,
  version,
  onClose,
  onSubmit,
  onOperationAdded,
  onRegenerate = async () => undefined,
}: {
  task: ImageEditorTaskInput;
  version: ImageEditorVersionInput;
  onClose: () => void;
  onSubmit: (selection: ApiImageEditSelection, instruction: string) => Promise<void>;
  onOperationAdded?: (operation: DraftOperation, instruction: string) => Promise<void>;
  onRegenerate?: () => Promise<void>;
}) {
  const [tool, setTool] = useState<EditTool>("re_edit");
  const [strokes, setStrokes] = useState<MaskStroke[]>([]);
  const [activeStroke, setActiveStroke] = useState<MaskStroke | null>(null);
  const [maskMode, setMaskMode] = useState<"draw" | "erase">("draw");
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [text, setText] = useState("新品主视觉");
  // Local-only canvas contrast preview toggle (never persisted into EditSnapshot)
  const [previewTone, setPreviewTone] = useState<"dark" | "light">("dark");
  const [textOperationId, setTextOperationId] = useState(() => freshOperationId("add_text"));
  const [brush, setBrush] = useState(42);
  const [expand, setExpand] = useState("all");
  const [ratio, setRatio] = useState<OutpaintRatio>("1:1");
  const [instruction, setInstruction] = useState("");
  const [addTextPrompt, setAddTextPrompt] = useState("");
  const [redrawPrompt, setRedrawPrompt] = useState("");
  const [erasePrompt, setErasePrompt] = useState("移除选区中的目标，并根据周围画面自然补全背景，保持原有光线、纹理和透视关系");
  const [operations, setOperations] = useState<DraftOperation[]>([]);
  const [productInputs, setProductInputs] = useState<ApiImageEditProductInput[]>([]);
  const [restoreInput, setRestoreInput] = useState<string | null>(null);
  const [uploadingRestoreInput, setUploadingRestoreInput] = useState(false);
  const [productInputsError, setProductInputsError] = useState(false);
  const workingDrafts = useRef<Partial<Record<ApiImageEditTool, DraftOperation>>>({});
  const pendingDraftWrite = useRef(Promise.resolve());
  const [loadingDraft, setLoadingDraft] = useState(true);
  const [toolNotice, setToolNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [editorError, setEditorError] = useState("");
  const [textEdits, setTextEdits] = useState<TextEditRow[]>([]);
  const [selectedTextId, setSelectedTextId] = useState<string | null>(null);
  const [selectingTextRegion, setSelectingTextRegion] = useState(false);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrError, setOcrError] = useState("");
  const ocrAutoTriggeredRef = useRef(false);
  const [translateLang, setTranslateLang] = useState("英文");
  const [translating, setTranslating] = useState(false);
  const editorMounted = useRef(false);
  const [zoom, setZoom] = useState(1);
  const [holdCompareOriginal, setHoldCompareOriginal] = useState(false);
  const [textRegion, setTextRegion] = useState(DEFAULT_EDIT_TEXT_REGION);
  const [capabilities, setCapabilities] = useState<ImageEditCapabilities | null>(null);
  const [capabilityError, setCapabilityError] = useState("");
  const [feather, setFeather] = useState(0.08);
  const [redoStrokes, setRedoStrokes] = useState<MaskStroke[]>([]);
  const [regionStart, setRegionStart] = useState<{ x: number; y: number } | null>(null);
  const [activeRegion, setActiveRegion] = useState<typeof textRegion | null>(null);
  const [frame, setFrame] = useState<ImageFrame>({ left: 0, top: 0, width: 1, height: 1 });
  const imageRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const canvasScrollRef = useRef<HTMLDivElement | null>(null);
  const textEditsListRef = useRef<HTMLDivElement | null>(null);
  const textNodeRef = useRef<Konva.Text | null>(null);
  const transformerRef = useRef<Konva.Transformer | null>(null);
  const activeOperationType = tool === "regenerate" ? null : editOperationType(tool);
  const activeOperations = operations.filter((item) => item.type === activeOperationType);
  const textChanges = textEdits.filter((item) => item.originalText.trim() && item.originalText !== item.newText);
  const translatableText = textEdits.filter((item) => item.originalText.trim());
  const textEditLimitError = textChanges.length > CHANGE_TEXT_MAX_OPERATIONS
    ? `每次最多修改 ${CHANGE_TEXT_MAX_OPERATIONS} 条文字`
    : textChanges.some(({ originalText, newText }) => originalText.length > CHANGE_TEXT_MAX_LENGTH || newText.length > CHANGE_TEXT_MAX_LENGTH)
      ? `原文字和新文字每条最多 ${CHANGE_TEXT_MAX_LENGTH} 个字符`
      : "";
  const checkingCapabilities = !capabilities && !capabilityError;

  const writeDraft = (write: () => Promise<unknown> | undefined) => {
    const pending = pendingDraftWrite.current.then(write).then(() => undefined);
    pendingDraftWrite.current = pending.catch(() => undefined);
    return pending;
  };

  const runOcr = useCallback(async () => {
    setOcrLoading(true);
    setOcrError("");
    try {
      const result = await suiteApi.recognizeImageEditText(task.id, version.id);
      if (result.status === "failed") {
        setOcrError(formatClientOcrError(result.error));
        return;
      }
      const recognized: TextEditRow[] = (result.blocks ?? [])
        .filter(({ text, bounds }) => text.trim() && bounds.width > 0 && bounds.height > 0)
        .map((block) => ({
          operationId: freshOperationId("change_text"),
          originalText: block.text,
          newText: block.text,
          region: { ...block.bounds, rotation: block.rotation },
          manual: false,
        }));
      setTextEdits((current) => {
        const unmatched = [...current];
        const merged = recognized.map((row) => {
          const { x, y, width, height, rotation } = row.region;
          const index = unmatched.findIndex(({ originalText, region }) => originalText === row.originalText
            && region.x === x && region.y === y && region.width === width && region.height === height && region.rotation === rotation);
          if (index < 0) return row;
          return { ...unmatched.splice(index, 1)[0], manual: false };
        });
        return [...merged, ...unmatched];
      });
    } catch (error) {
      setOcrError(formatClientOcrError(error));
    } finally {
      setOcrLoading(false);
    }
  }, [task.id, version.id]);

  const runBatchTranslate = async () => {
    if (!translatableText.length || translating) return;
    setTranslating(true);
    setEditorError("");
    try {
      const result = await suiteApi.translateImageTexts({
        targetLanguage: translateLang,
        items: translatableText.map((row) => ({ id: row.operationId, text: row.originalText })),
        preserveBrandTerms: true,
      });
      if (!editorMounted.current) return;
      const translations = new Map(result.translations.filter((row) => row.translatedText.trim()).map((row) => [row.id, row.translatedText]));
      setTextEdits((current) => current.map((row) => ({
        ...row, newText: translations.get(row.operationId) ?? row.newText,
      })));
      for (const { operationId, originalText } of translatableText) {
        if (translations.get(operationId) === originalText) removeSavedTextEdit(operationId);
      }
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : "图片文字翻译失败");
    } finally {
      setTranslating(false);
    }
  };

  useEffect(() => {
    editorMounted.current = true;
    suiteApi.imageEditorCapabilities().then((result) => setCapabilities(result.capabilities)).catch(() => setCapabilityError("能力状态暂时不可用"));
    return () => { editorMounted.current = false; };
  }, []);
  useEffect(() => {
    let mounted = true;
    suiteApi.getImageEditDraft(task.id, version.id).then((draft) => {
      if (!mounted) return;
      const restored = (draft.operations as unknown as DraftOperation[]).filter((item) => item.sourceVersionId === version.id);
      setOperations(restored);
      setTextEdits(restored.flatMap(({ type, operationId, payload }) => {
        const { originalText, newText, region, prompt } = payload;
        if (type !== "change_text" || typeof originalText !== "string" || typeof newText !== "string" || !region || typeof region !== "object") return [];
        const bounds = region as TextEditRow["region"];
        return [{ operationId, originalText, newText, region: { ...bounds, rotation: bounds.rotation ?? 0 }, manual: true,
          prompt: typeof prompt === "string" ? prompt : undefined }];
      }));
      setProductInputs(draft.productInputs ?? []);
      setProductInputsError(false);
      const reEdit = restored.find((item) => item.type === "re_edit");
      if (reEdit) setInstruction(String(reEdit.payload.prompt ?? ""));
    }).catch(() => { if (mounted) setProductInputsError(true); }).finally(() => { if (mounted) setLoadingDraft(false); });
    return () => { mounted = false; };
  }, [task.id, version.id]);

  const updateFrame = useCallback(() => {
    const image = imageRef.current;
    const canvas = canvasRef.current;
    if (!image || !canvas) return;
    const imageRect = image.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    if (!imageRect.width || !imageRect.height) return;
    setFrame({ left: imageRect.left - canvasRect.left, top: imageRect.top - canvasRect.top, width: imageRect.width, height: imageRect.height });
  }, []);

  useEffect(() => {
    const observer = new ResizeObserver(updateFrame);
    if (canvasRef.current) observer.observe(canvasRef.current);
    if (imageRef.current) observer.observe(imageRef.current);
    updateFrame();
    return () => observer.disconnect();
  }, [updateFrame, zoom]);

  useEffect(() => {
    ocrAutoTriggeredRef.current = false;
  }, [version.id]);

  useEffect(() => {
    if (tool !== "change_text") return;
    if (checkingCapabilities || capabilities?.ocr === false || ocrAutoTriggeredRef.current) return;
    ocrAutoTriggeredRef.current = true;
    void runOcr();
  }, [capabilities, checkingCapabilities, tool, runOcr]);
  useEffect(() => {
    const transformer = transformerRef.current;
    if (!transformer) return;
    const node = textNodeRef.current;
    if (!node || tool !== "add_text") {
      transformer.nodes([]);
      transformer.getLayer()?.batchDraw();
      return;
    }
    transformer.nodes([node]);
    transformer.getLayer()?.batchDraw();
  }, [tool, textOperationId, text, textRegion]);

  const undo = useCallback(() => {
    setStrokes((current) => {
      if (current.length) setRedoStrokes((redo) => [...redo, current[current.length - 1]]);
      return current.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setRedoStrokes((current) => {
      const item = current[current.length - 1];
      if (!item) return current;
      setStrokes((value) => [...value, item]);
      return current.slice(0, -1);
    });
  }, []);

  // Keyboard shortcuts for mask editing (skipped when typing in inputs)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (event.key === "Escape") { onClose(); return; }
      if (!["inpaint", "erase"].includes(tool)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
      } else if (event.key === "[") {
        event.preventDefault();
        setBrush((value) => Math.max(12, value - 6));
      } else if (event.key === "]") {
        event.preventDefault();
        setBrush((value) => Math.min(120, value + 6));
      } else if (event.code === "Space") {
        event.preventDefault();
        setHoldCompareOriginal(true);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") setHoldCompareOriginal(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [tool, undo, redo, onClose]);

  const pointFromEvent = (event: { target: { getStage(): Konva.Stage | null } }) => {
    const point = event.target.getStage()?.getPointerPosition() ?? { x: 0, y: 0 };
    return { x: Math.max(0, Math.min(1, point.x / Math.max(1, frame.width))), y: Math.max(0, Math.min(1, point.y / Math.max(1, frame.height))) };
  };
  const selectTextEdit = ({ operationId, region }: TextEditRow, center = false) => {
    setSelectedTextId(operationId);
    const scroll = canvasScrollRef.current;
    const canvas = canvasRef.current;
    if (!center || !scroll || !canvas) return;
    const viewport = scroll.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    scroll.scrollTo({
      left: scroll.scrollLeft + canvasRect.left - viewport.left + frame.left + (region.x + region.width / 2) * frame.width - scroll.clientWidth / 2,
      top: scroll.scrollTop + canvasRect.top - viewport.top + frame.top + (region.y + region.height / 2) * frame.height - scroll.clientHeight / 2,
    });
  };

  useEffect(() => {
    if (selectedTextId && tool === "change_text") {
      textEditsListRef.current?.querySelector(".wb-text-edit-row.is-active")?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedTextId, tool]);

  const startStroke = (event: { target: { getStage(): Konva.Stage | null } }) => {
    if (saving) return;
    const point = pointFromEvent(event);
    if (["inpaint", "erase"].includes(tool)) {
      setActiveStroke({ mode: maskMode, points: [point], size: brush / Math.max(1, Math.min(frame.width, frame.height)) });
      setRedoStrokes([]);
      return;
    }
    if (tool === "change_text" && selectingTextRegion && !translating) {
      setRegionStart(point);
      setActiveRegion({ x: point.x, y: point.y, width: 0, height: 0, rotation: 0 });
    }
  };
  const movePointer = (event: { target: { getStage(): Konva.Stage | null } }) => {
    const point = pointFromEvent(event);
    setPointer({ x: point.x * frame.width, y: point.y * frame.height });
    if (activeStroke) setActiveStroke((stroke) => stroke ? { ...stroke, points: [...stroke.points, point] } : stroke);
    if (regionStart) setActiveRegion({ x: Math.min(regionStart.x, point.x), y: Math.min(regionStart.y, point.y), width: Math.abs(point.x - regionStart.x), height: Math.abs(point.y - regionStart.y), rotation: 0 });
  };
  const finishStroke = () => {
    if (activeStroke) { setStrokes((current) => [...current, activeStroke]); setActiveStroke(null); return; }
    if (activeRegion && activeRegion.width * frame.width >= 4 && activeRegion.height * frame.height >= 4) {
      const row = { operationId: freshOperationId("change_text"), originalText: "", newText: "", region: activeRegion, manual: true };
      setTextEdits((current) => [...current, row]);
      selectTextEdit(row);
      setSelectingTextRegion(false);
    }
    setRegionStart(null);
    setActiveRegion(null);
  };

  const operationFor = (type: Exclude<ApiImageEditTool, "change_text">): DraftOperation => {
    const operation = (summary: string, payload: DraftOperation["payload"]): DraftOperation => {
      const existing = workingDrafts.current[type]?.operationId ?? operations.find((item) => item.type === type)?.operationId;
      const operationId = type === "add_text" ? textOperationId : existing ?? freshOperationId(type);
      return { operationId, type, summary, sourceVersionId: version.id, payload };
    };
    switch (type) {
      case "re_edit":
        return operation("AI 改图", { prompt: instruction });
      case "add_text":
        return operation(`添加文本：${text}`, { text, region: textRegion, prompt: addTextPrompt });
      case "redraw":
      case "erase":
        return operation(type === "redraw" ? "局部重绘选区" : "消除笔移除选区", {
          strokes: strokes.map((stroke) => ({ mode: stroke.mode, points: stroke.points, width: stroke.size })),
          feather, prompt: type === "redraw" ? redrawPrompt : erasePrompt,
        });
      case "outpaint":
        return operation(`扩图：${expand} · ${ratio}`, { direction: expand, targetRatio: ratio });
      case "restore_product":
        return operation("商品还原", restoreInput ? { referenceObjectKeys: [restoreInput] } : {});
    }
  };

  const validationError = () => {
    if (tool === "add_text" && (!text.trim() || !addTextPrompt.trim())) return "请填写精确文字和添加文字要求";
    if (tool === "inpaint" && (!strokes.length || !redrawPrompt.trim())) return "请绘制选区并填写重绘要求";
    if (tool === "erase" && !strokes.length) return "请先绘制要清除的选区";
    if (tool === "restore_product" && !restoreInput && !productInputs.length) return "请上传一张商品外观依据图";
    return "";
  };

  const uploadRestoreInput = async (file: File) => {
    setUploadingRestoreInput(true);
    setEditorError("");
    try {
      const uploaded = await suiteApi.uploadImageEditRestoreInput(task.id, version.id, file);
      setRestoreInput(uploaded.objectKey);
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : "依据图上传失败");
    } finally {
      setUploadingRestoreInput(false);
    }
  };

  const addOperation = async () => {
    if (!activeOperationType || activeOperationType === "change_text") return;
    const error = validationError();
    if (error) { setEditorError(error); return; }
    const next = operationFor(activeOperationType);
    setSaving(true);
    setEditorError("");
    try {
      await writeDraft(() => onOperationAdded?.(next, next.summary));
      setOperations((current) => [...current.filter((item) => item.operationId !== next.operationId), next]);
    } catch (errorValue) {
      setEditorError(errorValue instanceof Error ? errorValue.message : "操作保存失败");
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (!activeOperationType || activeOperationType === "change_text" || saving || loadingDraft) return;
    const next = operationFor(activeOperationType);
    const current = operations.find((item) => item.operationId === next.operationId);
    if (!current || (current.summary === next.summary && JSON.stringify(current.payload) === JSON.stringify(next.payload))) return;
    const timer = window.setTimeout(() => {
      setOperations((items) => items.map((item) => item.operationId === next.operationId ? next : item));
      void writeDraft(() => onOperationAdded?.(next, next.summary)).catch(() => setEditorError("对话操作同步失败，请重试"));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [activeOperationType, saving, loadingDraft, text, textRegion, strokes, feather, expand, ratio, instruction, addTextPrompt, redrawPrompt, erasePrompt, textOperationId, restoreInput, operations]);

  const submit = async () => {
    if (!activeOperationType) return;
    let finalOperations: DraftOperation[];
    if (activeOperationType === "change_text") {
      if (!textChanges.length || translating || textEditLimitError) return;
      finalOperations = textChanges.map(({ operationId, originalText, newText, region, prompt }) => {
        const replacement = normalizeChangeTextReplacement(newText);
        return {
          operationId,
          type: "change_text",
          summary: replacement === "" ? `删除文字：${originalText}` : `编辑文字：${originalText} → ${replacement}`,
          sourceVersionId: version.id,
          payload: { originalText, newText: replacement, region, ...(prompt ? { prompt } : {}) },
        };
      });
    } else {
      const next = operationFor(activeOperationType);
      const multiple = activeOperationType === "add_text";
      const currentError = validationError();
      if (currentError && (!multiple || !activeOperations.length || activeOperations.some((item) => item.operationId === next.operationId))) {
        setEditorError(currentError);
        return;
      }
      finalOperations = currentError ? activeOperations
        : multiple ? [...activeOperations.filter((item) => item.operationId !== next.operationId), next] : [next];
    }
    setSaving(true);
    setEditorError("");
    try {
      await writeDraft(async () => {
        for (const operation of finalOperations) {
          await onOperationAdded?.(operation, operation.summary);
          if (activeOperationType === "change_text") {
            setOperations((current) => [...current.filter((item) => item.operationId !== operation.operationId), operation]);
          }
        }
      });
      setOperations((current) => [
        ...current.filter((item) => !finalOperations.some((submitted) => submitted.operationId === item.operationId)),
        ...finalOperations,
      ]);
      await onSubmit(
        { tool: activeOperationType, sourceVersionId: version.id, operationIds: finalOperations.map((item) => item.operationId) },
        finalOperations.map((item) => item.summary).join("；"),
      );
      setOperations((current) => current.filter((item) => !finalOperations.some((submitted) => submitted.operationId === item.operationId)));
      if (activeOperationType === "change_text") {
        setTextEdits((current) => current.map((row) => ({ ...row, newText: row.originalText })));
      }
    } catch (errorValue) {
      setEditorError(errorValue instanceof Error ? errorValue.message : "生成提交失败");
    } finally {
      setSaving(false);
    }
  };

  const restoreOperation = (item: DraftOperation) => {
    const { payload } = item;
    switch (item.type) {
      case "add_text":
        setTextOperationId(item.operationId);
        setText(String(payload.text ?? ""));
        setAddTextPrompt(String(payload.prompt ?? ""));
        break;
      case "redraw":
        setRedrawPrompt(String(payload.prompt ?? ""));
        break;
      case "erase":
        setErasePrompt(String(payload.prompt ?? ""));
        break;
      case "outpaint":
        setExpand(String(payload.direction ?? "all"));
        setRatio(isOutpaintRatio(payload.targetRatio) ? payload.targetRatio : "1:1");
        break;
      case "re_edit":
        setInstruction(String(payload.prompt ?? ""));
        break;
      case "restore_product":
        setRestoreInput(Array.isArray(payload.referenceObjectKeys) ? String(payload.referenceObjectKeys[0] ?? "") || null : null);
        break;
    }
    if (item.type === "add_text" && payload.region && typeof payload.region === "object") {
      setTextRegion(payload.region as typeof textRegion);
    }
    if (item.type === "redraw" || item.type === "erase") {
      if (Array.isArray(payload.strokes)) setStrokes((payload.strokes as Array<{ mode?: "draw" | "erase"; points: MaskStroke["points"]; width: number }>).map((stroke) => ({ mode: stroke.mode ?? "draw", points: stroke.points, size: stroke.width })));
      if (typeof payload.feather === "number") setFeather(payload.feather);
    }
  };

  const switchTool = (next: EditTool, selected?: DraftOperation) => {
    if (tool === next && !selected) return;
    if (activeOperationType && activeOperationType !== "change_text") workingDrafts.current[activeOperationType] = operationFor(activeOperationType);
    setEditorError("");
    if (tool !== next) {
      setToolNotice("切换前的草稿会保留，提交时只使用当前工具的草稿。");
      setTool(next);
    }
    setTextRegion(DEFAULT_EDIT_TEXT_REGION);
    setStrokes([]);
    setRedoStrokes([]);
    setActiveStroke(null);
    setFeather(0.08);
    setRegionStart(null);
    setActiveRegion(null);
    setSelectingTextRegion(false);
    if (next !== "regenerate" && next !== "change_text") {
      const nextType = editOperationType(next);
      const draft = selected ?? workingDrafts.current[nextType] ?? operations.find((item) => item.type === nextType);
      if (draft) {
        workingDrafts.current[nextType] = draft;
        restoreOperation(draft);
      }
    }
  };

  const removeOperation = async (operationId: string) => {
    const item = operations.find((operation) => operation.operationId === operationId);
    if (item && workingDrafts.current[item.type]?.operationId === operationId) delete workingDrafts.current[item.type];
    setOperations((current) => current.filter((operation) => operation.operationId !== operationId));
    try {
      await writeDraft(() => suiteApi.removeImageEditOperation(task.id, operationId));
    } catch (errorValue) {
      if (item) setOperations((current) => [...current, item]);
      setEditorError(errorValue instanceof Error ? errorValue.message : "移除草稿失败");
    }
  };

  const removeSavedTextEdit = (id: string) => {
    if (activeOperations.some((item) => item.operationId === id)) void removeOperation(id);
  };

  const updateTextEdit = (row: TextEditRow, update: Partial<Pick<TextEditRow, "originalText" | "newText">>) => {
    const next = { ...row, ...update };
    setTextEdits((current) => current.map((item) => item.operationId === row.operationId ? { ...item, ...update } : item));
    if (next.newText === next.originalText) removeSavedTextEdit(row.operationId);
  };

  const updateTextRegion = (node: Konva.Text, transformed = false) => {
    const scaleX = transformed ? node.scaleX() : 1;
    const scaleY = transformed ? node.scaleY() : 1;
    const width = Math.max(24 / frame.width, node.width() * scaleX / frame.width);
    const height = Math.max(18 / frame.height, node.height() * scaleY / frame.height);
    if (transformed) { node.scaleX(1); node.scaleY(1); }
    setTextRegion({
      x: Math.max(0, Math.min(1 - width, (node.x() - width * frame.width / 2) / frame.width)),
      y: Math.max(0, Math.min(1 - height, (node.y() - height * frame.height / 2) / frame.height)),
      width: Math.min(1, width),
      height: Math.min(1, height),
      rotation: node.rotation(),
    });
  };

  const toolList: Array<[EditTool, string, string]> = [
    ["re_edit", "AI 改图", "imageToImage"],
    ["regenerate", "再次生成", "currentVersionInput"],
    ["add_text", "添加文本", "addText"],
    ["change_text", "编辑文字", "changeText"],
    ["inpaint", "局部重绘", "redraw"],
    ["erase", "消除笔", "erase"],
    ["expand", "扩图", "outpaint"],
    ["restore_product", "商品还原", "imageToImage"],
  ];
  const activeCapability = toolList.find(([value]) => value === tool)?.[2];
  const capabilityAvailable = (_value: EditTool, capability: string) => capabilities?.[capability] !== false;
  const capabilityReady = tool === "regenerate" ? capabilities?.currentVersionInput !== false : !capabilities || capabilityAvailable(tool, activeCapability ?? "");
  const outpaintBox = useMemo(
    () => computeOutpaintCanvas(version.width || 1024, version.height || 1024, ratio),
    [version.width, version.height, ratio],
  );
  const targetSize = { width: outpaintBox.targetWidth, height: outpaintBox.targetHeight };
  const quickDirectives: Record<string, string[]> = {
    inpaint: ["保持商品本体轮廓与颜色严格不变", "替换为极简柔和影棚光影", "增强材质高光与真实质感", "补充柔和自然桌面接触阴影"],
    erase: ["无痕移除杂物与水印，自然延续周围纹理", "清除多余瑕疵与反光斑点，保持原光影"],
    add_text: ["现代无衬线商业排版，清晰高对比，与画面光影融合", "极简高端品牌副标题排版，居中对齐"],
    re_edit: ["优化整体商业光影质感", "提升画面明暗层次与电商点击吸引力"],
  };
  const appendQuickDirective = (phrase: string) => {
    const append = (prev: string) => (prev.trim() ? `${prev.trim()}；${phrase}` : phrase);
    if (tool === "inpaint") setRedrawPrompt(append);
    else if (tool === "erase") setErasePrompt(append);
    else if (tool === "add_text") setAddTextPrompt(append);
    else if (tool === "re_edit") setInstruction(append);
  };
  const textVisible = tool === "add_text";
  const textOperations = tool === "change_text" ? [] : operations.filter((item) => item.type === "add_text");
  const hasActiveTextOperation = textOperations.some((item) => item.operationId === textOperationId);
  const hasRecognizedText = textEdits.some((row) => !row.manual);
  const selectingText = tool === "change_text" && selectingTextRegion;

  const previewFill = previewTone === "dark" ? "#0f172a" : "#ffffff";
  const previewShadow = previewTone === "dark" ? "#ffffff" : "#0f172a";

  return (
    <div className="wb-editor-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="wb-editor-modal" role="dialog" aria-modal="true" aria-label="图片编辑器">
        <header className="wb-editor-head">
          <div>
            <strong>{task.title}</strong>
            <small>基于版本 v{version.versionNumber}，原版本与提示词快照不会被覆盖</small>
          </div>
          <button type="button" aria-label="关闭图片编辑器" onClick={onClose}><Icon name="x" /></button>
        </header>
        <div className="wb-editor-body">
          <aside className="wb-editor-tools">
            <strong>编辑工具</strong>
            {toolList.map(([value, label, capability]) => (
              <button key={value} type="button" className={tool === value ? "is-active" : ""} disabled={saving || loadingDraft || !capabilityAvailable(value, capability)} onClick={() => switchTool(value)}>
                {label}
                <small>{!capabilityAvailable(value, capability) ? "不可用" : capabilities ? "可用" : "检查中"}</small>
              </button>
            ))}
            {tool !== "change_text" && <p>{["inpaint", "erase"].includes(tool) ? "快捷键：Ctrl+Z 撤销 · [ / ] 调整笔刷大小" : "调整操作后添加到对话，生成时才冻结"}</p>}
            {toolNotice && <p role="status">{toolNotice}</p>}
            {capabilityError && <p className="wb-editor-error">{capabilityError}</p>}
          </aside>
          <div className="wb-editor-stage">
            <div className={`wb-editor-canvas-scroll${tool === "change_text" ? " wb-text-edit-canvas-scroll" : ""}`} ref={canvasScrollRef}>
              <div className="wb-editor-canvas" ref={canvasRef} style={{ width: `${Math.round(zoom * 100)}%`, height: `${Math.round(zoom * 100)}%` }}>
                <img ref={imageRef} onLoad={updateFrame} src={version.previewUrl} alt={task.title} />
                <Stage
                  width={frame.width} height={frame.height}
                  style={{ position: "absolute", left: frame.left, top: frame.top, cursor: selectingText ? "crosshair" : undefined, touchAction: selectingText ? "none" : undefined }}
                  onMouseDown={startStroke} onMousemove={movePointer} onMouseup={finishStroke}
                  onMouseleave={() => { setPointer(null); finishStroke(); }}
                  onTouchStart={selectingText ? startStroke : undefined}
                  onTouchMove={selectingText ? movePointer : undefined}
                  onTouchEnd={selectingText ? finishStroke : undefined}
                >
                  <Layer visible={!holdCompareOriginal}>
                    {tool === "change_text" && textEdits.map((row) => {
                      const { x, y, width, height } = row.region;
                      const selected = row.operationId === selectedTextId;
                      return <KonvaRect key={row.operationId} x={x * frame.width} y={y * frame.height} width={width * frame.width} height={height * frame.height}
                        fill={selected ? "rgba(61, 139, 253, 0.22)" : "rgba(195, 148, 22, 0.12)"}
                        stroke={selected ? "#3d8bfd" : "#c39416"} dash={selected ? undefined : [7, 5]} strokeWidth={selected ? 3 : 1.5}
                        listening={!selectingText} onClick={() => selectTextEdit(row)} onTap={() => selectTextEdit(row)} />;
                    })}
                    {strokes.map((stroke, index) => <Line key={index} points={stroke.points.flatMap((point) => [point.x * frame.width, point.y * frame.height])} stroke={stroke.mode === "erase" ? "#64748b" : "#e45757"} opacity={stroke.mode === "erase" ? 0.46 : 0.62} strokeWidth={stroke.size * Math.min(frame.width, frame.height)} lineCap="round" lineJoin="round" globalCompositeOperation={stroke.mode === "erase" ? "destination-out" : "source-over"} />)}
                    {activeStroke && <Line points={activeStroke.points.flatMap((point) => [point.x * frame.width, point.y * frame.height])} stroke="#e45757" opacity={0.62} strokeWidth={activeStroke.size * Math.min(frame.width, frame.height)} lineCap="round" lineJoin="round" />}
                    {activeRegion && <KonvaRect x={activeRegion.x * frame.width} y={activeRegion.y * frame.height} width={activeRegion.width * frame.width} height={activeRegion.height * frame.height} stroke="#3d8bfd" dash={[6, 4]} strokeWidth={1.5} />}
                    {textOperations.map((item) => {
                      const payload = item.payload;
                      const selected = tool === "add_text" && item.operationId === textOperationId;
                      const region = selected || !payload.region || typeof payload.region !== "object" ? textRegion : payload.region as typeof textRegion;
                      return (
                        <KonvaText
                          key={item.operationId}
                          ref={selected ? textNodeRef : undefined}
                          text={selected ? text : String(payload.text ?? "")}
                          x={(region.x + region.width / 2) * frame.width}
                          y={(region.y + region.height / 2) * frame.height}
                          offsetX={region.width * frame.width / 2}
                          offsetY={region.height * frame.height / 2}
                          width={region.width * frame.width}
                          height={region.height * frame.height}
                          fill={previewFill}
                          fontSize={Math.max(14, region.height * frame.height * 0.55)}
                          rotation={region.rotation}
                          draggable={selected}
                          shadowColor={previewShadow}
                          shadowBlur={6}
                          onClick={() => { if (!saving && !selected) switchTool("add_text", item); }}
                          onTap={() => { if (!saving && !selected) switchTool("add_text", item); }}
                          onDragEnd={selected ? (event) => updateTextRegion(event.target as Konva.Text) : undefined}
                          onTransformEnd={selected ? (event) => updateTextRegion(event.target as Konva.Text, true) : undefined}
                        />
                      );
                    })}
                    {textVisible && !hasActiveTextOperation && (
                      <KonvaText
                        ref={textNodeRef}
                        text={text}
                        x={(textRegion.x + textRegion.width / 2) * frame.width}
                        y={(textRegion.y + textRegion.height / 2) * frame.height}
                        offsetX={textRegion.width * frame.width / 2}
                        offsetY={textRegion.height * frame.height / 2}
                        width={textRegion.width * frame.width}
                        height={textRegion.height * frame.height}
                        fill={previewFill}
                        fontSize={Math.max(14, textRegion.height * frame.height * 0.55)}
                        rotation={textRegion.rotation}
                        draggable
                        shadowColor={previewShadow}
                        shadowBlur={6}
                        onDragEnd={(event) => updateTextRegion(event.target as Konva.Text)}
                        onTransformEnd={(event) => updateTextRegion(event.target as Konva.Text, true)}
                      />
                    )}
                    {textVisible && <Transformer ref={transformerRef} borderDash={[6, 4]} borderStroke="#3d8bfd" anchorStroke="#3d8bfd" anchorFill="#ffffff" rotateAnchorOffset={22} enabledAnchors={["top-left", "top-right", "bottom-left", "bottom-right"]} boundBoxFunc={(oldBox, newBox) => newBox.width < 24 || newBox.height < 18 ? oldBox : newBox} />}
                    {["inpaint", "erase"].includes(tool) && pointer && <KonvaCircle x={pointer.x} y={pointer.y} radius={brush / 2} stroke={maskMode === "erase" ? "#475569" : "#dc3f3f"} dash={maskMode === "erase" ? [4, 3] : undefined} strokeWidth={1.5} listening={false} />}
                  </Layer>
                </Stage>
                {tool === "expand" && (
                  <div className="wb-outpaint-overlay">
                    <div className="wb-outpaint-frame" style={{ aspectRatio: `${outpaintBox.targetWidth} / ${outpaintBox.targetHeight}` }}>
                      <div
                        className="wb-outpaint-origin"
                        style={{
                          left: `${outpaintBox.sourceOffset.left / targetSize.width * 100}%`,
                          top: `${outpaintBox.sourceOffset.top / targetSize.height * 100}%`,
                          width: `${(version.width || 1024) / targetSize.width * 100}%`,
                          height: `${(version.height || 1024) / targetSize.height * 100}%`,
                        }}
                      >
                        <img src={version.previewUrl} alt="原图锚点" />
                      </div>
                    </div>
                    <div className="wb-outpaint-caption">
                      <span>待扩展画幅预览</span>
                      <strong>{targetSize.width} × {targetSize.height}</strong>
                      <small>原图居中</small>
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="wb-editor-bottom">
              <span>{strokes.length ? `已记录 ${strokes.length} 条蒙版笔画` : selectingText ? "在图上拖动，框住要编辑的文字" : tool === "change_text" ? "点击文字框或列表条目定位" : textVisible ? "拖动或缩放虚线框定位文字区域" : "未绘制选区"}</span>
              <div className="wb-zoom-controls" role="group" aria-label="画布缩放控制">
                <button type="button" onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))))} aria-label="缩小画布">−</button>
                <button type="button" onClick={() => setZoom(1)} title="重置为 100%">{Math.round(zoom * 100)}%</button>
                <button type="button" onClick={() => setZoom((z) => Math.min(2.5, Number((z + 0.25).toFixed(2))))} aria-label="放大画布">+</button>
              </div>
              {["inpaint", "erase"].includes(tool) && (
                <button
                  type="button"
                  className={holdCompareOriginal ? "is-active" : ""}
                  onPointerDown={() => setHoldCompareOriginal(true)}
                  onPointerUp={() => setHoldCompareOriginal(false)}
                  onPointerLeave={() => setHoldCompareOriginal(false)}
                  title="按住按钮或空格键临时隐藏蒙版查看原图"
                >
                  按住看原图
                </button>
              )}
              {textVisible && (
                <div className="wb-mask-mode" role="group" aria-label="画布文字预览对比度">
                  <button type="button" className={previewTone === "dark" ? "is-active" : ""} onClick={() => setPreviewTone("dark")}>深色预览</button>
                  <button type="button" className={previewTone === "light" ? "is-active" : ""} onClick={() => setPreviewTone("light")}>浅色预览</button>
                </div>
              )}
              {["inpaint", "erase"].includes(tool) && (
                <div className="wb-mask-mode" role="group" aria-label="蒙版修正模式">
                  <button type="button" className={maskMode === "draw" ? "is-active" : ""} onClick={() => setMaskMode("draw")}>绘制选区</button>
                  <button type="button" className={maskMode === "erase" ? "is-active" : ""} onClick={() => setMaskMode("erase")}>擦除选区</button>
                </div>
              )}
              <button type="button" disabled={!strokes.length} onClick={undo}>撤销</button>
              <button type="button" disabled={!redoStrokes.length} onClick={redo}>重做</button>
              <button type="button" disabled={!strokes.length} onClick={() => { setStrokes([]); setRedoStrokes([]); }}>清空</button>
            </div>
          </div>
          <aside className="wb-editor-options">
            {["inpaint", "erase", "expand"].includes(tool) && <p role="status">当前模型对选区控制有限</p>}
            {tool === "re_edit" && (
              <>
                <label>
                  调整要求
                  <textarea
                    value={instruction}
                    disabled={loadingDraft || saving}
                    onChange={(event) => setInstruction(event.target.value)}
                    placeholder="输入调整要求（选填，空着将按原提示词重绘）。如：商品向左移动一点，换成浅灰色背景…"
                  />
                </label>
                <details className="wb-editor-source-prompt">
                  <summary>原提示词</summary>
                  <p>{versionGenerationPrompt(version) || "暂无原提示词"}</p>
                </details>
              </>
            )}
            {tool === "add_text" && (
              <>
                <div className="wb-editor-option-head">
                  <strong>文字区域</strong>
                  <button type="button" onClick={() => { setTextOperationId(freshOperationId("add_text")); setText(""); setAddTextPrompt(""); setTextRegion(DEFAULT_EDIT_TEXT_REGION); }}>新建文字框</button>
                </div>
                <label>精确文字<input value={text} onChange={(event) => setText(event.target.value)} /></label>
                <label>添加文字要求<textarea value={addTextPrompt} onChange={(event) => setAddTextPrompt(event.target.value)} placeholder="描述文字的视觉感觉，以及与画面光线、透视的关系" /></label>
                <small>上方浅/深切换仅用于画布定位清晰度，实际视觉风格由“添加文字要求”控制。</small>
                <button type="button" className="wb-danger-link" disabled={saving} onClick={() => { if (operations.some((item) => item.operationId === textOperationId)) void removeOperation(textOperationId); setTextOperationId(freshOperationId("add_text")); setText(""); }}>删除当前文字框</button>
              </>
            )}
            {tool === "change_text" && (
              <>
                <div className="wb-editor-option-head">
                  <strong>文字列表</strong>
                  <button type="button" aria-pressed={selectingText} disabled={saving || translating} onClick={() => setSelectingTextRegion((value) => !value)}>
                    {selectingText ? "取消框选" : "框选补充"}
                  </button>
                </div>
                <div className="wb-text-edit-status" role="status">
                  {capabilities?.ocr === false ? <span>当前未配置多模态识字模型。可以框选补充文字。</span>
                    : checkingCapabilities ? <span>正在检查文字识别能力…</span>
                    : ocrLoading ? <span>正在识别整张图的文字…</span>
                    : !hasRecognizedText && (
                      <>
                        <span>{ocrError || "未识别到文字，可以框选补充。"}</span>
                        <button type="button" disabled={saving || translating} onClick={() => void runOcr()}>重新识别</button>
                      </>
                    )}
                </div>
                {textEdits.length > 0 && (
                  <div className="wb-translate-controls" aria-label="一键翻译">
                    <select aria-label="翻译目标语言" value={translateLang} disabled={saving || translating} onChange={(event) => setTranslateLang(event.target.value)}>
                      {SUPPORTED_OUTPUT_LANGUAGES.map((lang) => (
                        <option key={lang.code} value={lang.value}>{lang.value}</option>
                      ))}
                    </select>
                    <button type="button" disabled={saving || translating || ocrLoading || !translatableText.length} onClick={() => void runBatchTranslate()}>
                      {translating ? "翻译中…" : "一键翻译"}
                    </button>
                  </div>
                )}
                <div className="wb-text-edit-list" ref={textEditsListRef}>
                  {textEdits.map((row) => {
                    const { operationId, originalText, newText, manual } = row;
                    const selected = selectedTextId === operationId;
                    const deleted = Boolean(originalText.trim()) && newText.trim() === "";
                    const disabled = saving || translating;
                    return (
                      <div className={`wb-text-edit-row${selected ? " is-active" : ""}`} key={operationId}>
                        <button type="button" className="wb-text-edit-locate" aria-pressed={selected} onClick={() => selectTextEdit(row, true)}>
                          {manual ? "手工框选文字" : originalText}
                        </button>
                        {manual && <label>原文字<input disabled={disabled} maxLength={CHANGE_TEXT_MAX_LENGTH} value={originalText} onFocus={() => selectTextEdit(row, true)} onChange={(event) => {
                          const value = event.target.value;
                          updateTextEdit(row, { originalText: value, ...(newText === originalText ? { newText: value } : {}) });
                        }} /></label>}
                        <label>新文字<textarea disabled={disabled} maxLength={CHANGE_TEXT_MAX_LENGTH} rows={1} aria-label={originalText ? `新文字：${originalText}` : "新文字"} value={newText}
                          placeholder={deleted ? "生成时删除这条文字" : undefined}
                          onFocus={() => selectTextEdit(row, true)} onChange={(event) => updateTextEdit(row, { newText: event.target.value })} /></label>
                        <div className="wb-text-edit-actions">
                          <button type="button" className="wb-danger-link" disabled={disabled || !originalText.trim() || deleted} onClick={() => updateTextEdit(row, { newText: "" })}>删除</button>
                          <button type="button" disabled={disabled || newText === originalText} onClick={() => updateTextEdit(row, { newText: originalText })}>重置</button>
                          {manual && <button type="button" disabled={disabled} onClick={() => {
                            setTextEdits((current) => current.filter((item) => item.operationId !== operationId));
                            if (selected) setSelectedTextId(null);
                            removeSavedTextEdit(operationId);
                          }}>移除框选</button>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
            {["inpaint", "erase"].includes(tool) && (
              <>
                <label>笔刷大小<input type="range" min="12" max="120" value={brush} onChange={(event) => setBrush(Number(event.target.value))} /><output>{brush}px</output></label>
                <label>边缘羽化<input type="range" min="0" max="40" value={Math.round(feather * 100)} onChange={(event) => setFeather(Number(event.target.value) / 100)} /><output>{Math.round(feather * 100)}%</output></label>
                {tool === "inpaint" ? <label>重绘要求<textarea value={redrawPrompt} onChange={(event) => setRedrawPrompt(event.target.value)} placeholder="描述选区中要重绘成什么，以及需要保留的画面关系" /></label> : <label>清除要求<textarea value={erasePrompt} onChange={(event) => setErasePrompt(event.target.value)} /></label>}
              </>
            )}
            {quickDirectives[tool] && (
              <div className="wb-quick-chips-block">
                <span>电商高频精修指令</span>
                <div className="wb-quick-chips">
                  {quickDirectives[tool].map((phrase) => (
                    <button type="button" key={phrase} onClick={() => appendQuickDirective(phrase)}>+ {phrase}</button>
                  ))}
                </div>
              </div>
            )}
            {tool === "expand" && (
              <>
                <label>扩图重点<select value={expand} onChange={(event) => setExpand(event.target.value)}><option value="all">四周</option><option value="horizontal">左右</option><option value="vertical">上下</option><option value="left">左侧</option><option value="right">右侧</option></select></label>
                <label>目标比例<select value={ratio} onChange={(event) => { if (isOutpaintRatio(event.target.value)) setRatio(event.target.value); }}>{OUTPAINT_RATIOS.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
                <output>扩边画布 {targetSize.width} × {targetSize.height}</output>
              </>
            )}
            {tool === "regenerate" && <p>再次生成只在当前卡片下新增版本，不创建子卡片。</p>}
            {tool === "restore_product" && (
              <fieldset className="wb-restore-inputs" disabled={saving || loadingDraft || uploadingRestoreInput}>
                <legend>商品外观依据</legend>
                {loadingDraft && <small>正在读取商品原图…</small>}
                {productInputsError && <small>商品原图读取失败，可以上传依据图。</small>}
                {!loadingDraft && !productInputsError && !productInputs.length && <small>当前图片没有商品原图，请上传一张依据图。</small>}
                {productInputs.length > 0 && (
                  <>
                    <label className="wb-restore-choice">
                      <input type="radio" name="restore-input" checked={restoreInput === null} onChange={() => { setRestoreInput(null); setEditorError(""); }} />
                      使用全部商品原图
                    </label>
                    <div className="wb-restore-grid">
                      {productInputs.map(({ objectKey, thumbnailUrl }, index) => (
                        <label className="wb-restore-choice" key={objectKey}>
                          <img src={thumbnailUrl} alt="" />
                          <input type="radio" name="restore-input" checked={restoreInput === objectKey} onChange={() => { setRestoreInput(objectKey); setEditorError(""); }} />
                          原图 {index + 1}
                        </label>
                      ))}
                    </div>
                  </>
                )}
                {restoreInput && !productInputs.some((input) => input.objectKey === restoreInput) && (
                  <div className="wb-restore-uploaded">
                    <img src={suiteApi.imageEditRestoreInputThumbnail(task.id, version.id, restoreInput)} alt="已上传的商品外观依据图" />
                    <span>已选上传图</span>
                  </div>
                )}
                <label>
                  {uploadingRestoreInput ? "上传中…" : "上传"}
                  <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    if (file) void uploadRestoreInput(file);
                  }} />
                </label>
                <small>PNG、JPG 或 WebP，最大 10 MB</small>
              </fieldset>
            )}
            {tool !== "change_text" && <div className="wb-editor-operations">
              {activeOperations.map((item) => (
                <div key={item.operationId}>
                  <button type="button" className="wb-operation-edit" disabled={saving} onClick={() => switchTool(editorToolFor(item.type), item)}>{item.summary}</button>
                  <button type="button" disabled={saving} onClick={() => void removeOperation(item.operationId)}>移除</button>
                </div>
              ))}
            </div>}
          </aside>
          <footer className="wb-editor-footer">
            <span>{tool === "change_text" ? `已修改 ${textChanges.length} 条` : `已加入对话 ${activeOperations.length} 项`}</span>
            {tool === "change_text" && textEditLimitError && <strong role="alert">{textEditLimitError}</strong>}
            {editorError && <strong role="alert"><ModelSettingsMessage message={editorError} /></strong>}
            <button type="button" onClick={onClose}>取消</button>
            {activeOperationType && activeOperationType !== "change_text" && activeOperationType !== "restore_product" && <button type="button" disabled={saving || loadingDraft || !capabilityReady} onClick={() => void addOperation()}>{saving ? "保存中…" : activeOperations.some((item) => item.operationId === operationFor(activeOperationType).operationId) ? "更新对话操作" : "添加到对话"}</button>}
            {tool === "regenerate" ? (
              <button type="button" className="wb-primary-action" disabled={saving || !capabilityReady} onClick={() => { setSaving(true); onRegenerate().then(onClose).catch((errorValue) => setEditorError(errorValue instanceof Error ? errorValue.message : "再次生成失败")).finally(() => setSaving(false)); }}>{saving ? "提交中…" : "再次生成当前版本"}</button>
            ) : (
              <button
                type="button"
                className="wb-primary-action"
                disabled={saving || loadingDraft || !capabilityReady
                  || (tool === "change_text" && (!textChanges.length || translating || Boolean(textEditLimitError)))
                  || (tool === "restore_product" && (uploadingRestoreInput || (!restoreInput && !productInputs.length)))}
                onClick={() => void submit()}
              >
                {saving ? "提交中…" : tool === "re_edit" ? "生成" : tool === "restore_product" ? "还原商品" : "开始生成（新建编辑子卡）"}
              </button>
            )}
          </footer>
        </div>
      </section>
    </div>
  );
}

export type WorkbenchBoardPageProps = { suiteId: string; search?: string; navigate: (to: string) => void };

export function WorkbenchBoardPage(props: WorkbenchBoardPageProps) {
  return <ReactFlowProvider><WorkbenchBoardInner {...props} /></ReactFlowProvider>;
}

function WorkbenchBoardInner({ suiteId, search, navigate }: WorkbenchBoardPageProps) {
  const [workbench, setWorkbench] = useState<ApiWorkbench | null>(null);
  const [mode, setMode] = useState<BoardMode>(() => new URLSearchParams(search).get("view") === "gallery" ? "gallery" : "compose");
  const [canvasFilter, setCanvasFilter] = useState<CanvasFilter>("all");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<BoardNode>([]);
  const nodesRef = useRef<BoardNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [preview, setPreview] = useState<LightboxPreview | null>(null);
  const [editor, setEditor] = useState<{ task: ApiSuiteTask; version: ApiTaskVersion } | null>(null);
  const [compareTaskId, setCompareTaskId] = useState<string | null>(null);
  const [customTaskOpen, setCustomTaskOpen] = useState(false);
  const uploadInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [savingTaskInput, setSavingTaskInput] = useState(false);
  const [styleDrawerOpen, setStyleDrawerOpen] = useState(false);
  const [styleDraft, setStyleDraft] = useState("");
  const [savingStyle, setSavingStyle] = useState(false);
  const [toast, setToast] = useState("");
  const [defaultImageModel, setDefaultImageModel] = useState<string | null | undefined>(undefined);
  const [imageOptions, setImageOptions] = useState(() => defaultImageOptions("gpt-image-2"));
  const [promptDraft, setPromptDraft] = useState("");
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const latestWorkbench = useRef<ApiWorkbench | null>(null);
  const layoutVersionRef = useRef(0);
  const layoutSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const { fitView, getInternalNode } = useReactFlow<BoardNode>();

  const planStyleGuide = useMemo(() => workbench ? fallbackPlanStyle(workbench) : "", [workbench]);
  const styleOverride = workbench?.styleOverride ?? workbench?.suite.styleOverride ?? null;
  const effectiveStyleGuide = workbench?.effectiveStyleGuide?.trim() || styleOverride?.trim() || planStyleGuide;

  const selectedTask = workbench?.tasks.find((task) => task.id === selectedTaskId) ?? (() => {
    if (!workbench || !selectedTaskId) return null;
    const index = (workbench.imageEditChildren ?? []).findIndex((child) => String(child.task.id) === selectedTaskId);
    return index >= 0 ? imageEditChildTask(workbench, workbench.imageEditChildren![index], index) : null;
  })();
  const selectedIsImageEditChild = Boolean(workbench?.imageEditChildren?.some((child) => String(child.task.id) === selectedTask?.id));

  useEffect(() => { setPromptDraft(selectedTask?.promptDraft ?? ""); }, [selectedTask?.id, selectedTask?.promptDraft]);

  const notify = useCallback((message: string) => {
    setToast(message);
    if (!message.includes("配置 → 偏好设置")) window.setTimeout(() => setToast((current) => current === message ? "" : current), 2400);
  }, []);

  useEffect(() => {
    const loadDefault = () => {
      modelSettingsApi.get().then(({ channels, preferences }) => {
        const channel = channels.find((item) => item.id === preferences.image?.channelId);
        setDefaultImageModel(channel && preferences.image ? `${channel.name} · ${preferences.image.modelId}` : null);
        const model = channel?.models.find((item) => item.id === preferences.image?.modelId && item.capabilities.includes("image"));
        setImageOptions(model?.imageOptions ?? defaultImageOptions(model?.id ?? "gpt-image-2"));
      }).catch(() => setDefaultImageModel(undefined));
    };
    loadDefault();
    window.addEventListener("focus", loadDefault);
    return () => window.removeEventListener("focus", loadDefault);
  }, []);

  const persistLayout = useCallback((nextNodes: BoardNode[], nextViewport = viewport) => {
    const nodesToSave = nextNodes.map((node) => ({ nodeId: node.id, x: node.position.x, y: node.position.y }));
    if (latestWorkbench.current) {
      latestWorkbench.current = {
        ...latestWorkbench.current,
        layout: {
          id: latestWorkbench.current.layout?.id ?? "",
          suiteId,
          layoutVersion: layoutVersionRef.current,
          viewport: nextViewport,
          nodes: nodesToSave,
          groups: [],
          updatedAt: new Date().toISOString(),
        },
      };
    }
    layoutSaveQueue.current = layoutSaveQueue.current.catch(() => undefined).then(async () => {
      try {
        const saved = await suiteApi.saveLayout(suiteId, { layoutVersion: layoutVersionRef.current, viewport: nextViewport, nodes: nodesToSave, groups: [] });
        layoutVersionRef.current = saved.layoutVersion;
        if (latestWorkbench.current) {
          latestWorkbench.current = { ...latestWorkbench.current, layout: saved };
        }
      } catch {
        notify("画布布局保存失败，请重试");
      }
    });
    return layoutSaveQueue.current;
  }, [suiteId, viewport, notify]);

  const openStyleDrawer = useCallback(() => {
    const currentWb = latestWorkbench.current;
    const override = currentWb?.styleOverride ?? currentWb?.suite.styleOverride ?? "";
    const plan = currentWb?.planSnapshot ? fallbackPlanStyle(currentWb) : "";
    setStyleDraft(override || plan);
    setStyleDrawerOpen(true);
  }, []);

  const rebuildGraph = useCallback((nextWb: ApiWorkbench, focusNodeId: string | null, activeFilter: CanvasFilter = "all", ignoreSavedPositions = false) => {
    const nextPlanStyle = fallbackPlanStyle(nextWb);
    const nextOverride = nextWb.styleOverride ?? nextWb.suite.styleOverride ?? null;
    const nextEffective = nextWb.effectiveStyleGuide?.trim() || nextOverride?.trim() || nextPlanStyle;
    const measuredSizes = new Map<string, LaneCardSize>();
    for (const node of nodesRef.current) {
      const { width, height } = getInternalNode(node.id)?.measured ?? {};
      if (width && height) measuredSizes.set(node.id, { width, height });
    }
    const projected = projectComposeGraph(nextWb, nextWb.layout, nextEffective, nextOverride, focusNodeId, activeFilter, { ignoreSavedPositions, measuredSizes }, {
      onPreview: setPreview,
      onSelect: (task, nodeId) => { setSelectedTaskId(task.id); setSelectedNodeId(nodeId); },
      onGenerate: (task) => generateOne(task).catch((error) => notify(error instanceof Error ? error.message : "生成提交失败")),
      onCopy: (task) => copyPrompt(task).catch(() => notify("复制失败")),
      onRegenerate: (task) => regenerateTask(task).catch((error) => notify(error instanceof Error ? error.message : "重新生成提交失败")),
      onEdit: (task, version) => { if (version) setEditor({ task, version }); },
      onCompareVersions: (task) => setCompareTaskId(task.id),
      onEditStyle: openStyleDrawer,
      onSelectVersion: (task, versionId, selection) => selectVersion(task, versionId, selection).catch(() => notify("版本选择失败")),
    });
    const nextNodes = projected.nodes.map((node) => ({ ...node, measured: measuredSizes.get(node.id) }));
    nodesRef.current = nextNodes;
    setNodes(nextNodes);
    setEdges(projected.edges);
    return nextNodes;
  }, [setNodes, openStyleDrawer, notify, getInternalNode]);

  const reload = useCallback(async () => {
    const next = await suiteApi.getWorkbench(suiteId);
    latestWorkbench.current = next;
    setWorkbench(next);
    layoutVersionRef.current = next.layout?.layoutVersion ?? 0;
    setViewport(next.layout?.viewport ?? { x: 0, y: 0, zoom: 1 });
    const nextNodes = rebuildGraph(next, selectedNodeId, canvasFilter);
    const savedIds = new Set((next.layout?.nodes ?? []).map((node) => node.nodeId));
    const needsFit = !next.layout || nextNodes.some((node) => !savedIds.has(node.id));
    if (needsFit) window.setTimeout(() => fitView({ padding: 0.14, duration: 0 }), 0);
    setSelectedTaskId((current) => current && (next.tasks.some((task) => task.id === current) || next.imageEditChildren?.some((child) => String(child.task.id) === current)) ? current : next.tasks.find((task) => task.status !== "archived")?.id ?? null);
  }, [fitView, rebuildGraph, selectedNodeId, canvasFilter, suiteId]);

  useEffect(() => { reload().catch(() => notify("工作台加载失败，请重试")); }, [suiteId]);

  useEffect(() => {
    setMode(new URLSearchParams(search).get("view") === "gallery" ? "gallery" : "compose");
  }, [search]);

  const consumedEditQueryRef = useRef("");
  useEffect(() => {
    if (!workbench || workbench.suite.id !== suiteId) return;
    const params = new URLSearchParams(search ?? "");
    const editTaskId = params.get("editTask")?.trim() || "";
    if (!editTaskId) return;
    const editVersionId = params.get("editVersion")?.trim() || "";
    const signature = `${suiteId}:${editTaskId}:${editVersionId}`;
    if (consumedEditQueryRef.current === signature) return;
    consumedEditQueryRef.current = signature;

    let targetTask = workbench.tasks.find((task) => task.id === editTaskId) ?? null;
    let targetNodeId = targetTask ? `task:${targetTask.id}` : "";
    if (!targetTask) {
      const childIndex = (workbench.imageEditChildren ?? []).findIndex((child) => String(child.task.id) === editTaskId);
      if (childIndex >= 0) {
        targetTask = imageEditChildTask(workbench, workbench.imageEditChildren![childIndex], childIndex);
        targetNodeId = `edit-child:${targetTask.id}`;
      }
    }
    if (!targetTask && editVersionId) {
      const fallbackParent = workbench.tasks.find((task) => task.versions.some((v) => v.id === editVersionId)) ?? null;
      if (fallbackParent) {
        targetTask = fallbackParent;
        targetNodeId = `task:${fallbackParent.id}`;
      }
    }
    if (targetTask) {
      setSelectedTaskId(targetTask.id);
      if (targetNodeId) setSelectedNodeId(targetNodeId);
      const targetVersion =
        (editVersionId ? targetTask.versions.find((v) => v.id === editVersionId) : undefined) ??
        targetTask.versions.find((v) => v.isCurrent) ??
        targetTask.versions[0];
      if (targetVersion) {
        setEditor({ task: targetTask, version: targetVersion });
      }
    }

    params.delete("editTask");
    params.delete("editVersion");
    const remaining = params.toString();
    const nextUrl = `${window.location.pathname}${remaining ? `?${remaining}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", nextUrl);
  }, [workbench, suiteId, search]);

  // Re-highlight lineage immediately when selectedNodeId or filter changes without refetching
  useEffect(() => {
    if (!latestWorkbench.current || mode !== "compose") return;
    rebuildGraph(latestWorkbench.current, selectedNodeId, canvasFilter, false);
  }, [selectedNodeId, canvasFilter, mode, rebuildGraph]);

  useEffect(() => {
    if (workbench?.suite.origin === "replica" || workbench?.suite.origin === "aplus") return;
    const ordinaryTaskRunning = workbench?.tasks.some((task) => task.status === "generating");
    const editChildRunning = workbench?.imageEditChildren?.some((child) => String(child.task.status) === "generating");
    if (!ordinaryTaskRunning && !editChildRunning) return;
    const timer = window.setInterval(() => { reload().catch(() => undefined); }, 1800);
    return () => window.clearInterval(timer);
  }, [reload, workbench]);

  const handleNodesChange = useCallback((changes: Parameters<typeof onNodesChange>[0]) => {
    const next = applyNodeChanges(changes, nodesRef.current);
    nodesRef.current = next;
    onNodesChange(changes);
    if (changes.some((change) => change.type === "position" && change.dragging === false)) persistLayout(next).catch(() => undefined);
  }, [onNodesChange, persistLayout]);

  const tidyLayout = async () => {
    if (!latestWorkbench.current) return;
    const nextNodes = rebuildGraph(latestWorkbench.current, selectedNodeId, canvasFilter, true);
    await persistLayout(nextNodes);
    window.setTimeout(() => fitView({ padding: 0.14, duration: 260 }), 20);
    notify("已按三泳道自动整理画布布局");
  };

  const saveStyleOverride = async (nextValue: string | null) => {
    setSavingStyle(true);
    try {
      await suiteApi.updateStyleOverride(suiteId, nextValue);
      setStyleDrawerOpen(false);
      await reload();
      notify(nextValue ? "已保存画布风格覆盖，仅作用于后续新提交生成" : workbench?.planSnapshot ? "已恢复为原计划冻结风格" : "已清除画布风格");
    } catch (error) {
      notify(error instanceof Error ? error.message : "风格覆盖保存失败");
    } finally {
      setSavingStyle(false);
    }
  };

  const saveTaskInput = async (patch: Parameters<typeof suiteApi.updateTask>[1], success: string) => {
    if (!selectedTask || selectedIsImageEditChild) return;
    setSavingTaskInput(true);
    try {
      await suiteApi.updateTask(selectedTask.id, patch);
      await reload();
      notify(success);
    } finally {
      setSavingTaskInput(false);
    }
  };

  const updateTaskParams = (patch: Record<string, unknown>) => saveTaskInput({ generationParams: { ...selectedTask?.generationParams, ...patch } }, "已保存当前卡片参数");

  const uploadProductImages = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!files.length) return;
    setUploading(true);
    let uploaded = 0;
    try {
      const firstOrdinal = Math.max(0, ...(latestWorkbench.current?.inputImages ?? []).map((image) => image.ordinal)) + 1;
      for (const file of files) {
        await suiteApi.upload(suiteId, file, firstOrdinal + uploaded);
        uploaded += 1;
      }
      notify(`已上传 ${uploaded} 张商品图`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "商品图上传失败");
    } finally {
      if (uploaded) await reload().catch(() => notify("商品图已上传，画布刷新失败"));
      setUploading(false);
    }
  };

  const savePrompt = async () => {
    if (!selectedTask || selectedIsImageEditChild) return;
    await suiteApi.updateTask(selectedTask.id, { promptDraft });
    await reload();
    notify("提示词已保存");
  };

  const generateOne = async (task: ApiSuiteTask, promptOverride?: string) => {
    if (latestWorkbench.current?.imageEditChildren?.some((child) => String(child.task.id) === task.id)) return regenerateTask(task);
    await suiteApi.generateTask(task.id, promptOverride ?? task.promptDraft);
    await reload();
    notify("已提交单卡生成");
  };

  const submitEdit = async (task: ApiSuiteTask, selection: ApiImageEditSelection, instruction: string) => {
    await suiteApi.submitImageEdit(task.id, { ...selection, sourceCardId: task.id, parentVersionId: selection.sourceVersionId, summary: instruction });
    setEditor(null);
    await reload();
    notify("编辑已加入对话，正在生成子卡片");
  };

  const persistEditOperation = async (task: ApiSuiteTask, operation: DraftOperation, instruction: string) => {
    await suiteApi.upsertImageEditOperation(task.id, operation as unknown as Record<string, unknown>, instruction);
  };

  const regenerateTask = async (task: ApiSuiteTask, editSourceVersionId?: string) => {
    const child = latestWorkbench.current?.imageEditChildren?.find((item) => String(item.task.id) === task.id);
    if (child) {
      const latest = child.attempts[child.attempts.length - 1];
      if (latest && String(latest.status) === "failed") await suiteApi.retryImageEdit(String(latest.id));
      else await suiteApi.regenerateImageEditTask(task.id);
    } else if (editSourceVersionId) {
      await suiteApi.regenerateTaskFromEdit(task.id, editSourceVersionId);
    } else {
      const failed = [...task.attempts].reverse().find((attempt) => attempt.status === "failed");
      if (task.status === "failed" && failed) await suiteApi.retryTaskAttempt(failed.id);
      else await suiteApi.generateTask(task.id, task.promptDraft);
    }
    await reload();
    notify("已提交再次生成");
  };

  const selectVersion = async (task: ApiSuiteTask, versionId: string, selection: "current" | "final") => {
    const isImageEditChild = Boolean(latestWorkbench.current?.imageEditChildren?.some((child) => String(child.task.id) === task.id));
    if (isImageEditChild) await suiteApi.selectImageEditVersion(task.id, versionId, selection);
    else await suiteApi.selectTaskVersion(task.id, versionId, selection);
    await reload();
    notify(selection === "final" ? "已设为终版" : "已切换当前版本");
  };

  const generateAll = async (onlyUnfinished = false) => {
    if (!workbench) return;
    const tasks = workbench.tasks.filter((task) => {
      if (task.status === "archived") return false;
      if (!hasTaskReference(task)) return false;
      if (onlyUnfinished) return task.status === "pending" || task.status === "failed";
      return true;
    });
    if (!tasks.length) {
      notify(onlyUnfinished ? "所有任务均已生成完成" : "当前没有可提交的任务");
      return;
    }
    await suiteApi.generateBatch(suiteId, tasks.map((task) => task.id));
    await reload();
    notify(`已提交 ${tasks.length} 个任务`);
  };

  const retryFailedTasks = async () => {
    if (!workbench) return;
    const failedTasks = workbench.tasks.filter((task) => task.status === "failed");
    if (!failedTasks.length) return;
    let submitted = 0;
    for (const task of failedTasks) {
      const failedAttempt = [...task.attempts].reverse().find((attempt) => attempt.status === "failed");
      if (failedAttempt) {
        await suiteApi.retryTaskAttempt(failedAttempt.id);
        submitted += 1;
      }
    }
    await reload();
    notify(`已重新提交 ${submitted} 个失败任务`);
  };

  const batchSyncParams = async (imageType: "main" | "detail" | "all") => {
    if (!selectedTask || selectedIsImageEditChild) return;
    const patch = { ratio: ratioFor(selectedTask), size: sizeFor(selectedTask), quality: qualityFor(selectedTask) };
    const result = await suiteApi.batchUpdateTaskParams(suiteId, { imageType, generationParams: patch });
    await reload();
    const label = imageType === "main" ? "全部主图" : imageType === "detail" ? "全部详情图" : "全部任务卡";
    notify(`已将比例/尺寸/清晰度同步至${label}（共 ${result.updatedCount} 张）`);
  };

  const createCustomTask = async (input: { imageType: "main" | "detail"; title: string; purpose: string; promptDraft: string; sourceInputImageId: string | null; generationParams: Record<string, unknown> }) => {
    const created = await suiteApi.createCustomTask(suiteId, input);
    setCustomTaskOpen(false);
    await reload();
    setSelectedTaskId(created.id);
    setSelectedNodeId(`task:${created.id}`);
    notify(`已新增画布任务卡「${created.title}」`);
  };

  const copyPrompt = async (task: ApiSuiteTask) => {
    const textToCopy = styleOverride ? applyStyleOverrideToPrompt(task.promptDraft, styleOverride) : task.promptDraft;
    await navigator.clipboard.writeText(textToCopy);
    notify("提示词已复制");
  };

  const openDeliveryPreview = (slot: ResolvedDeliverySlot) => {
    if (!slot.previewUrl || !workbench) return;
    const versionLookup = buildVersionLookup(workbench);
    const beforeSource = slot.sourceVersionId ? versionLookup.get(slot.sourceVersionId) : undefined;
    setPreview({
      url: slot.previewUrl,
      title: slot.title,
      subtitle: `${slot.imageType === "main" ? "主图" : "详情页"} · ${slot.versionNumber ? `v${slot.versionNumber}` : ""}`,
      beforeUrl: slot.isEditedDerived ? (beforeSource?.url ?? null) : null,
      beforeLabel: beforeSource?.label,
      afterLabel: slot.isEditedDerived ? `编辑后 · ${slot.title}` : undefined,
    });
  };

  const activeTasks = workbench?.tasks.filter((task) => task.status !== "archived") ?? [];
  const mainTaskCount = activeTasks.filter((task) => task.imageType === "main").length;
  const detailTaskCount = activeTasks.filter((task) => task.imageType === "detail").length;
  const unfinishedTasks = activeTasks.filter((task) => (task.status === "pending" || task.status === "failed") && hasTaskReference(task));
  const failedTaskCount = activeTasks.filter((task) => task.status === "failed").length;
  const editChildCount = workbench?.imageEditChildren?.length ?? 0;
  const isGenerating = activeTasks.some((task) => task.status === "generating") || Boolean(workbench?.imageEditChildren?.some((child) => String(child.task.status) === "generating"));
  const compareTask = workbench && compareTaskId
    ? (workbench.tasks.find((task) => task.id === compareTaskId) ?? (() => {
      const idx = (workbench.imageEditChildren ?? []).findIndex((child) => String(child.task.id) === compareTaskId);
      return idx >= 0 ? imageEditChildTask(workbench, workbench.imageEditChildren![idx], idx) : null;
    })())
    : null;

  if (!workbench) {
    return (
      <AppShell activeNav="create" navigate={navigate} fullHeight crumbs={[{ label: "生图画布", to: "/create/canvas" }]} statusText={toast || "正在加载画布…"} statusTone={toast ? "error" : "running"}>
        <div className="flow-loading">{toast || "正在加载画布…"}</div>
      </AppShell>
    );
  }

  if (workbench.suite.origin === "replica" || workbench.suite.origin === "aplus") {
    const batchLabel = workbench.suite.origin === "aplus" ? "A+详情批次" : "复刻批次";
    return (
      <AppShell activeNav="create" navigate={navigate} fullHeight crumbs={[{ label: "生图画布", to: "/create/canvas" }]} statusText={`${batchLabel}暂不支持画布模式`} statusTone="error">
        <div className="flow-loading">{batchLabel}暂不支持在生图画布中打开。<button type="button" className="pa-topbar-btn" onClick={() => navigate("/create/canvas")}>返回画布列表</button></div>
      </AppShell>
    );
  }

  const currentVersion = selectedTask?.versions.find((version) => version.isCurrent) ?? selectedTask?.versions[0];
  const isFreeCanvas = workbench.suite.origin === "canvas";
  const returnPath = isFreeCanvas ? "/create/canvas" : `/create/suite/${suiteId}`;
  const missingReference = Boolean(selectedTask && !selectedIsImageEditChild && !hasTaskReference(selectedTask));
  const appliesStyleOverride = Boolean(styleOverride && selectedTask && !selectedIsImageEditChild && selectedTask.originKind !== "reverse_import" && selectedTask.originKind !== "replica");
  const effectiveInspectorPrompt = selectedTask
    ? (selectedIsImageEditChild
      ? (currentVersion ? versionGenerationPrompt(currentVersion, promptDraft) : promptDraft)
      : (appliesStyleOverride ? applyStyleOverrideToPrompt(promptDraft, styleOverride) : promptDraft))
    : "";
  const frozenVersionPrompt = currentVersion ? versionGenerationPrompt(currentVersion, "") : "";

  return (
    <AppShell
      activeNav="create"
      navigate={navigate}
      fullHeight
      crumbs={[{ label: isFreeCanvas ? "生图画布" : "商品套图", to: returnPath }, { label: workbench.suite.name }, { label: mode === "compose" ? "创作板" : "成品展示板" }]}
      statusText={isGenerating ? "模型生成中…" : "已保存"}
      statusTone={isGenerating ? "running" : "pass"}
      centerSlot={
        <div className="pa-view-switch" role="tablist" aria-label="工作台视图">
          <button className={mode === "compose" ? "is-active" : ""} type="button" role="tab" aria-selected={mode === "compose"} onClick={() => setMode("compose")}>创作板</button>
          <button className={mode === "gallery" ? "is-active" : ""} type="button" role="tab" aria-selected={mode === "gallery"} onClick={() => setMode("gallery")}>成品展示板</button>
        </div>
      }
      rightSlot={
        <button type="button" className="pa-topbar-btn" onClick={() => navigate(returnPath)}>
          {isFreeCanvas ? "返回画布列表" : "返回套图"}
        </button>
      }
    >
      {mode === "gallery" ? (
        <DeliveryGalleryView
          workbench={workbench}
          effectiveStyleGuide={workbench.planSnapshot || styleOverride?.trim() ? effectiveStyleGuide : ""}
          onPreview={openDeliveryPreview}
          onNotify={notify}
        />
      ) : (
        <main className="wb-main pa-wb-main">
          <section className="wb-workspace">
            <div className="wb-canvas-panel">
              <div className="wb-canvas-toolbar">
                <div>
                  <strong>创作画布（三泳道）</strong>
                  <span>
                    {selectedNodeId ? "已高亮选中节点上下游血缘 · 点击画布空白取消高亮" : "左侧输入素材 → 中间主图/详情任务 → 右侧编辑子卡"}
                  </span>
                </div>
                <div className="wb-canvas-actions">
                  <input ref={uploadInput} type="file" aria-label="上传商品图" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(event) => void uploadProductImages(event)} />
                  <button type="button" className="wb-upload-product" disabled={uploading} onClick={() => uploadInput.current?.click()}><Icon name="image" />{uploading ? "上传中…" : "上传商品图"}</button>
                  <button type="button" onClick={() => setCustomTaskOpen(true)}>+ 新建任务卡</button>
                  {unfinishedTasks.length > 0 ? (
                    <button type="button" className="wb-primary-action" disabled={isGenerating} onClick={() => generateAll(true).catch((error) => notify(error instanceof Error ? error.message : "批量生成提交失败"))}>
                      {isGenerating ? "生成中…" : `生成待完成 (${unfinishedTasks.length})`}
                    </button>
                  ) : (
                    <button type="button" className="wb-primary-action" disabled={isGenerating || !activeTasks.some(hasTaskReference)} onClick={() => generateAll(false).catch((error) => notify(error instanceof Error ? error.message : "批量生成提交失败"))}>
                      {isGenerating ? "生成中…" : "重新生成全部"}
                    </button>
                  )}
                  {failedTaskCount > 0 && (
                    <button type="button" className="wb-retry-failed-btn" disabled={isGenerating} onClick={() => retryFailedTasks().catch((error) => notify(error instanceof Error ? error.message : "批量重试失败"))}>
                      重试失败 ({failedTaskCount})
                    </button>
                  )}
                  <button type="button" onClick={() => void tidyLayout()} title="按三泳道一键整理画布节点">一键整理布局</button>
                  <button type="button" onClick={() => fitView({ padding: 0.14, duration: 250 })} title="适应视图"><Icon name="fit" /></button>
                  <button type="button" onClick={openStyleDrawer}>{styleOverride ? "风格覆盖（已生效）" : "全局风格"}</button>
                </div>
              </div>
              <div className="wb-filter-strip" role="group" aria-label="画布卡片筛选">
                {([
                  ["all", `全部 (${activeTasks.length + editChildCount})`],
                  ["main", `主图 (${mainTaskCount})`],
                  ["detail", `详情页 (${detailTaskCount})`],
                  ["edit", `编辑子卡 (${editChildCount})`],
                  ["failed", `待处理 (${unfinishedTasks.length})`],
                ] as Array<[CanvasFilter, string]>).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    className={canvasFilter === key ? "is-active" : ""}
                    onClick={() => { setSelectedNodeId(null); setCanvasFilter(key); }}
                  >
                    {label}
                  </button>
                ))}
                {unfinishedTasks.length > 0 && unfinishedTasks.length < activeTasks.length && (
                  <button type="button" className="wb-filter-extra" disabled={isGenerating} onClick={() => generateAll(false).catch((error) => notify(error instanceof Error ? error.message : "批量生成提交失败"))}>
                    全部重生成 ({activeTasks.length})
                  </button>
                )}
              </div>
              <div className="wb-canvas wb-canvas-compose">
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  nodeTypes={nodeTypes}
                  onNodesChange={handleNodesChange}
                  onMoveEnd={(_, next) => { setViewport(next); persistLayout(nodesRef.current, next).catch(() => undefined); }}
                  defaultViewport={viewport}
                  onPaneClick={() => setSelectedNodeId(null)}
                  onNodeClick={(_, node) => {
                    setSelectedNodeId(node.id);
                    if (node.data.task) setSelectedTaskId(node.data.task.id);
                  }}
                  nodesDraggable
                  nodesConnectable={false}
                  minZoom={0.1}
                  fitView={false}
                >
                  <Background gap={20} size={1} color="#e4e7eb" />
                  <Controls showInteractive={false} />
                  <MiniMap
                    pannable
                    zoomable
                    nodeColor={(node) => {
                      const d = node.data as BoardData | undefined;
                      if (d?.kind === "style") return "#f59e0b";
                      if (d?.kind === "base" || d?.kind === "reverse-ref") return "#94a3b8";
                      if (d?.isEditChild) return "#6366f1";
                      if (d?.task?.status === "failed") return "#ef4444";
                      if (d?.task?.status === "generated") return "#10b981";
                      return "#3b82f6";
                    }}
                  />
                </ReactFlow>
              </div>
            </div>

            <aside className="wb-rail">
              <div className="wb-rail-head">
                <div>
                  <span>当前参数</span>
                  <strong>{selectedTask ? selectedTask.title : "选择一张任务卡"}</strong>
                </div>
                <div className="wb-parameter-pills">
                  <a href="/settings/preferences" onClick={(event) => { event.preventDefault(); navigate("/settings/preferences"); }}>
                    {defaultImageModel ?? (defaultImageModel === null ? "设置默认生图模型" : "偏好设置")}
                  </a>
                  <span>{selectedTask ? ratioFor(selectedTask) : "1:1"}</span>
                  <span>{selectedTask ? sizeFor(selectedTask) : "1K"}</span>
                </div>
              </div>
              <div className="wb-mode-explainer">
                <span>当前模式</span>
                <strong>{isFreeCanvas ? "自由画布" : "套图模式"}</strong>
                <p>同一画布中统一管理参考图、白底图、任务提示词、编辑血缘子卡和版本快照。</p>
              </div>
              <div className="wb-reference-strip">
                <div><strong>{workbench.inputImages.length}</strong><span>输入图</span></div>
                <div><strong>{activeTasks.length}</strong><span>任务卡</span></div>
                <div><strong>{workbench.imageEditChildren?.length ?? 0}</strong><span>编辑子卡</span></div>
              </div>
              {selectedTask ? (
                <div className="wb-inspector-body">
                  <div className="wb-selected-title">
                    <span>{selectedIsImageEditChild ? "编辑派生子卡" : selectedTask.imageType === "main" ? "主图任务" : "详情页任务"}</span>
                    <strong>{selectedTask.title}</strong>
                  </div>
                  <div className="wb-inspector-prompt">
                    <span>{selectedIsImageEditChild ? "子卡版本冻结提示词" : appliesStyleOverride ? "生效提示词预览（已应用画布风格覆盖）" : "生效提示词预览"}</span>
                    <pre>{effectiveInspectorPrompt}</pre>
                  </div>
                  {!selectedIsImageEditChild && currentVersion && frozenVersionPrompt && frozenVersionPrompt !== effectiveInspectorPrompt && (
                    <div className="wb-inspector-prompt">
                      <span>当前版本 v{currentVersion.versionNumber} 已冻结历史快照</span>
                      <pre>{frozenVersionPrompt}</pre>
                    </div>
                  )}
                  {!selectedIsImageEditChild && (
                    <label className="wb-inspector-field">
                      <span>提示词草稿</span>
                      <textarea value={promptDraft} onChange={(event) => setPromptDraft(event.target.value)} />
                    </label>
                  )}
                  {!selectedIsImageEditChild && (
                    <>
                      <label className="wb-inspector-field">
                        <span>商品参考图</span>
                        <select value={selectedTask.sourceInputImageId ?? ""} disabled={!workbench.inputImages.length || savingTaskInput || selectedTask.status === "generating"} onChange={(event) => saveTaskInput({ sourceInputImageId: event.target.value }, "已绑定商品参考图").catch(() => notify("商品图绑定失败"))}>
                          <option value="" disabled>{selectedTask.sourceLibraryReferenceId ? "已绑定图片库参考图" : "未绑定商品图"}</option>
                          {workbench.inputImages.map((image) => <option key={image.id} value={image.id}>{image.currentBaseVersionId ? "白底图" : "原图"} {image.ordinal} · {image.originalFilename}</option>)}
                        </select>
                      </label>
                      <WhiteResourcePicker key={selectedTask.id} task={selectedTask} onBound={reload} onNotify={notify} />
                    </>
                  )}
                  {selectedTask.originKind === "reverse_import" && (
                    <label className="wb-inspector-field wb-checkbox-field">
                      <span>爆品图参考</span>
                      <input type="checkbox" checked={selectedTask.generationParams?.explosiveReferenceEnabled !== false} onChange={(event) => updateTaskParams({ explosiveReferenceEnabled: event.target.checked }).catch(() => notify("参考图开关保存失败"))} />
                      <small>默认携带爆品图，仅参考构图、光影和版式</small>
                    </label>
                  )}
                  {!selectedIsImageEditChild && (
                    <>
                      <label className="wb-inspector-field"><span>比例</span><select value={ratioFor(selectedTask)} disabled={savingTaskInput} onChange={(event) => updateTaskParams({ ratio: event.target.value }).catch(() => notify("比例保存失败"))}>{parameterOptions(imageOptions.aspectRatios, ratioFor(selectedTask))}</select></label>
                      <label className="wb-inspector-field"><span>分辨率</span><select value={sizeFor(selectedTask)} disabled={savingTaskInput} onChange={(event) => updateTaskParams({ size: event.target.value }).catch(() => notify("分辨率保存失败"))}>{parameterOptions(imageOptions.sizes, sizeFor(selectedTask))}</select></label>
                      <ResolutionCostNote size={sizeFor(selectedTask)} className="wb-resolution-note" />
                      <label className="wb-inspector-field"><span>清晰度</span><select value={qualityFor(selectedTask)} onChange={(event) => updateTaskParams({ quality: event.target.value }).catch(() => notify("清晰度保存失败"))}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
                      <div className="wb-batch-sync-row">
                        <button type="button" onClick={() => batchSyncParams(selectedTask.imageType).catch(() => notify("批量同步失败"))}>
                          同步参数到全部{selectedTask.imageType === "main" ? "主图" : "详情图"}
                        </button>
                      </div>
                    </>
                  )}
                  {missingReference && <p className="wb-inspector-field">{missingReferenceHint}</p>}
                  <div className="wb-inspector-actions">
                    {!selectedIsImageEditChild && <button type="button" className="wb-primary-action" onClick={() => savePrompt().catch(() => notify("提示词保存失败"))}>保存提示词</button>}
                    <button type="button" className="wb-primary-action" disabled={missingReference || savingTaskInput || selectedTask.status === "generating"} title={missingReference ? missingReferenceHint : undefined} onClick={() => generateOne(selectedTask, promptDraft).catch((error) => notify(error instanceof Error ? error.message : "生成提交失败"))}>
                      {selectedIsImageEditChild ? "再次生成" : "创作"}
                    </button>
                    <button type="button" onClick={() => copyPrompt({ ...selectedTask, promptDraft }).catch(() => notify("复制失败"))}><Icon name="copy" />复制提示词</button>
                    {currentVersion && <button type="button" onClick={() => setEditor({ task: selectedTask, version: currentVersion })}><Icon name="edit" />编辑图片</button>}
                    {selectedTask.versions.length > 0 && (
                      <button type="button" onClick={() => setCompareTaskId(selectedTask.id)}>
                        <Icon name="columns" />版本对比 ({selectedTask.versions.length})
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="wb-inspector-empty">从画布选择任务卡，查看提示词、血缘与输出参数。</div>
              )}
              <PromptLibraryButton onNotify={notify} />
            </aside>
          </section>
        </main>
      )}

      {/* 画布风格覆盖抽屉 */}
      {styleDrawerOpen && (
        <div className="wb-style-drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !savingStyle) setStyleDrawerOpen(false); }}>
          <aside className="wb-style-drawer" role="dialog" aria-modal="true" aria-labelledby="wb-style-drawer-title">
            <header>
              <div>
                <span>CANVAS STYLE OVERRIDE</span>
                <h2 id="wb-style-drawer-title">画布风格覆盖</h2>
              </div>
              <button type="button" aria-label="关闭风格覆盖抽屉" disabled={savingStyle} onClick={() => setStyleDrawerOpen(false)}><Icon name="x" /></button>
            </header>
            <div className="wb-style-drawer-body">
              <div className="wb-style-origin">
                <strong>{workbench.planSnapshot ? "原计划冻结全局风格（只读）" : "自由风格"}</strong>
                <p>{planStyleGuide}</p>
              </div>
              <label className="wb-style-field">
                <span>工作台前向覆盖风格</span>
                <textarea
                  rows={6}
                  disabled={savingStyle}
                  value={styleDraft}
                  onChange={(event) => setStyleDraft(event.target.value)}
                  placeholder="输入新的全局光影、色调、质感或构图氛围要求……"
                />
                <small>保存后仅影响此后新提交的单卡或批量生图（写入新快照），绝不改写已确认结构计划快照、单卡草稿原文或任何历史版本。</small>
              </label>
            </div>
            <footer>
              {styleOverride && (
                <button type="button" className="wb-style-reset" disabled={savingStyle} onClick={() => void saveStyleOverride(null)}>
                  {workbench.planSnapshot ? "恢复原计划风格" : "清除画布风格"}
                </button>
              )}
              <button type="button" disabled={savingStyle} onClick={() => setStyleDrawerOpen(false)}>取消</button>
              <button type="button" className="wb-primary-action" disabled={savingStyle || !styleDraft.trim()} onClick={() => void saveStyleOverride(styleDraft.trim())}>
                {savingStyle ? "保存中…" : "保存画布风格覆盖"}
              </button>
            </footer>
          </aside>
        </div>
      )}

      {editor && (
        <ImageEditorModal
          key={editor.version.id}
          task={editor.task}
          version={editor.version}
          onClose={() => setEditor(null)}
          onOperationAdded={(operation, instruction) => persistEditOperation(editor.task, operation, instruction)}
          onRegenerate={() => regenerateTask(editor.task, editor.version.id)}
          onSubmit={(spec, instruction) => submitEdit(editor.task, spec, instruction)}
        />
      )}

      {customTaskOpen && (
        <CustomTaskModal
          inputImages={workbench.inputImages}
          imageOptions={imageOptions}
          onClose={() => setCustomTaskOpen(false)}
          onCreate={createCustomTask}
        />
      )}

      {compareTask && (
        <VersionCompareModal
          task={compareTask}
          onClose={() => setCompareTaskId(null)}
          onSelectVersion={selectVersion}
          onComparePreview={(nextPreview) => setPreview(nextPreview)}
        />
      )}

      {preview && <BeforeAfterLightbox preview={preview} onClose={() => setPreview(null)} />}
      {toast && <div className="suite-toast show" role="status"><ModelSettingsMessage message={toast} /></div>}
    </AppShell>
  );
}
