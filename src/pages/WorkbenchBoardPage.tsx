import { ResolutionCostNote } from "../components/ResolutionCostNote";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { applyNodeChanges, Background, Controls, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider, type Edge, type Node, type NodeProps, type Viewport, useNodesState, useReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { defaultImageOptions } from "../../shared/model-settings";
import {
  applyStyleOverrideToPrompt,
  computeLineageHighlight,
  computeOutpaintPreviewBox,
  computeWorkbenchLanes,
  extractCardPromptPreview,
  SUPPORTED_OUTPUT_LANGUAGES,
  type LaneCardSize,
  type LaneLayoutItem,
  type LaneLayoutOptions,
  type ResolvedDeliverySlot,
} from "../../shared/workbench-delivery";
import { modelSettingsApi, suiteApi, type ApiCanvasLayout, type ApiLibraryResource, type ApiPromptTemplateCopy, type ApiProductMaterialRef, type ApiSuiteTask, type ApiTaskVersion, type ApiWorkbench } from "../api/client";
import { AppShell } from "../components/AppShell";
import { BeforeAfterLightbox, type LightboxPreview } from "../components/BeforeAfterLightbox";
import { CustomTaskModal } from "../components/CustomTaskModal";
import { DeliveryGalleryView } from "../components/DeliveryGalleryView";
import { VersionCompareModal } from "../components/VersionCompareModal";
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
type EditTool = "re_edit" | "regenerate" | "add_text" | "change_text" | "inpaint" | "erase" | "expand";
type MaskStroke = { mode: "draw" | "erase"; points: Array<{ x: number; y: number }>; size: number };
type DraftOperation = { operationId: string; type: "re_edit" | "add_text" | "change_text" | "redraw" | "erase" | "outpaint"; summary: string; sourceVersionId: string; payload: Record<string, unknown> };
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
    .filter((task) => task.status !== "archived" && (task.originKind === "reverse_import" || !workbench.planSnapshot || task.planSnapshotId === workbench.planSnapshot.id))
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
              <option value="base_refine">底图精修</option>
              <option value="plan">计划生成</option>
              <option value="task_image">单卡创作</option>
            </select>
            <div className="wb-prompt-list">
              {templates.map((template) => (
                <button type="button" key={template.templateVersionId} className={selected?.templateVersionId === template.templateVersionId ? "is-selected" : ""} onClick={() => setSelected(template)}>
                  <strong>{template.name}</strong>
                  <span>{template.stage} · v{template.versionNo}</span>
                </button>
              ))}
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
  const [items, setItems] = useState<ApiLibraryResource[] | null>(null);
  const [selected, setSelected] = useState<ApiProductMaterialRef[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const bound = Array.isArray(task.generationParams?.productMaterialRefs) ? task.generationParams.productMaterialRefs as ApiProductMaterialRef[] : [];

  useEffect(() => {
    if (!open) return;
    let active = true;
    Promise.all((["base_image", "input_image"] as const).map((resourceType) => suiteApi.listLibraryResources({ resourceType, status: "published", pageSize: 100 })))
      .then((results) => { if (active) setItems(results.flatMap((result) => result.items)); })
      .catch(() => { if (active) setLoadError(true); });
    return () => { active = false; };
  }, [open]);

  const show = () => {
    setSelected(bound.slice().sort((a, b) => a.order - b.order));
    setItems(null);
    setLoadError(false);
    setOpen(true);
  };
  const toggle = (item: ApiLibraryResource) => setSelected((current) => current.some((ref) => ref.resourceId === item.id) ? current.filter((ref) => ref.resourceId !== item.id) : current.length >= 3 ? current : [...current, { libraryReferenceId: "", resourceId: item.id, resourceVersionId: item.resourceVersionId, order: current.length + 1, title: item.title, previewUrl: item.previewUrl ?? `/api/library/resources/${encodeURIComponent(item.id)}/preview` }]);
  const move = (index: number, delta: number) => setSelected((current) => {
    const next = current.slice();
    const target = index + delta;
    if (target < 0 || target >= next.length) return current;
    [next[index], next[target]] = [next[target], next[index]];
    return next.map((item, order) => ({ ...item, order: order + 1 }));
  });
  const save = async () => {
    if (!selected.length) return;
    setLoading(true);
    try {
      await suiteApi.bindWhiteResources(task.id, selected.map((item) => item.resourceId));
      await onBound();
      setOpen(false);
      onNotify("已绑定图片库参考图");
    } catch {
      onNotify("参考图绑定失败");
    } finally {
      setLoading(false);
    }
  };
  return (
    <>
      <div className="wb-inspector-field">
        <span>图片库参考图</span>
        {bound.length > 0 && <div className="wb-material-summary">{bound.map((item, index) => <span key={item.resourceId}>{index + 1}. {item.title ?? item.resourceId.slice(0, 8)}</span>)}</div>}
        <button type="button" className="wb-link-button" disabled={task.status === "generating"} onClick={show}>从图片库选择</button>
      </div>
      {open && (
        <div className="wb-prompt-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
          <section className="wb-prompt-modal wb-white-picker" role="dialog" aria-modal="true" aria-label="选择图片库参考图">
            <div className="wb-prompt-popover-head">
              <div><span className="wb-modal-eyebrow">PRODUCT MATERIALS</span><strong>选择图片库参考图</strong><small>最多 3 张，按顺序作为主图和补充角度</small></div>
              <button type="button" aria-label="关闭图片库选择器" onClick={() => setOpen(false)}><Icon name="x" /></button>
            </div>
            {loadError ? <p role="alert">图片库加载失败</p> : !items ? <p role="status">正在加载图片库…</p> : !items.length && <p>暂无已发布的原图或白底图</p>}
            <div className="wb-white-picker-grid">
              {items?.map((item) => {
                const active = selected.some((ref) => ref.resourceId === item.id);
                return (
                  <button type="button" key={item.id} aria-pressed={active} disabled={loading || (!active && selected.length >= 3)} className={`wb-white-picker-item ${active ? "is-selected" : ""}`} onClick={() => toggle(item)}>
                    <span className="wb-picker-check">{active ? "✓" : ""}</span>
                    {item.previewUrl && <img src={item.previewUrl} alt={item.title} />}
                    <strong>{item.title}</strong>
                    <small>{item.resourceType === "base_image" ? "白底图" : "原图"} · {item.resourceVersionId.slice(0, 8)}</small>
                  </button>
                );
              })}
            </div>
            {selected.length > 0 && (
              <div className="wb-white-picker-order">
                <strong>已选顺序</strong>
                {selected.map((item, index) => (
                  <div key={item.resourceId}>
                    <span>{index + 1}. {item.title}</span>
                    <button type="button" disabled={index === 0} onClick={() => move(index, -1)}>上移</button>
                    <button type="button" disabled={index === selected.length - 1} onClick={() => move(index, 1)}>下移</button>
                  </div>
                ))}
              </div>
            )}
            <div className="wb-prompt-modal-actions">
              <button type="button" onClick={() => setOpen(false)}>取消</button>
              <button type="button" className="wb-primary-action" disabled={!selected.length || loading} onClick={() => void save()}>{loading ? "保存中…" : "确认绑定"}</button>
            </div>
          </section>
        </div>
      )}
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
  onSubmit: (spec: Record<string, unknown>, instruction: string) => Promise<void>;
  onOperationAdded?: (operation: DraftOperation, instruction: string) => Promise<void>;
  onRegenerate?: () => Promise<void>;
}) {
  const freshOperationId = (type: DraftOperation["type"]) => `${type}-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
  const [tool, setTool] = useState<EditTool>("re_edit");
  const [strokes, setStrokes] = useState<MaskStroke[]>([]);
  const [activeStroke, setActiveStroke] = useState<MaskStroke | null>(null);
  const [maskMode, setMaskMode] = useState<"draw" | "erase">("draw");
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [text, setText] = useState("新品主视觉");
  const [originalText, setOriginalText] = useState("");
  const [newText, setNewText] = useState("");
  // Local-only canvas contrast preview toggle (never persisted into EditSnapshot)
  const [previewTone, setPreviewTone] = useState<"dark" | "light">("dark");
  const [textOperationId, setTextOperationId] = useState(() => freshOperationId("add_text"));
  const [brush, setBrush] = useState(42);
  const [expand, setExpand] = useState("all");
  const [ratio, setRatio] = useState("original");
  const [instruction, setInstruction] = useState(() => versionGenerationPrompt(version, task.promptDraft));
  const [addTextPrompt, setAddTextPrompt] = useState("");
  const [changeTextPrompt, setChangeTextPrompt] = useState("保持原有排版、字体感觉、颜色、透视和光影，只替换文字内容");
  const [redrawPrompt, setRedrawPrompt] = useState("");
  const [erasePrompt, setErasePrompt] = useState("移除选区中的目标，并根据周围画面自然补全背景，保持原有光线、纹理和透视关系");
  const [operations, setOperations] = useState<DraftOperation[]>([]);
  const committedOperationIds = useRef<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [editorError, setEditorError] = useState("");
  const [ocrBlocks, setOcrBlocks] = useState<Array<{ id: string; text: string; confidence: number; bounds: { x: number; y: number; width: number; height: number }; rotation: number }>>([]);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrError, setOcrError] = useState("");
  const ocrAutoTriggeredRef = useRef(false);
  const [translateLang, setTranslateLang] = useState("英文");
  const [translating, setTranslating] = useState(false);
  const [translatedMap, setTranslatedMap] = useState<Record<string, string>>({});
  const [zoom, setZoom] = useState(1);
  const [holdCompareOriginal, setHoldCompareOriginal] = useState(false);
  const [textRegion, setTextRegion] = useState({ x: 0.36, y: 0.42, width: 0.28, height: 0.1, rotation: 0 });
  const [capabilities, setCapabilities] = useState<ImageEditCapabilities | null>(null);
  const [capabilityError, setCapabilityError] = useState("");
  const [feather, setFeather] = useState(0.08);
  const [redoStrokes, setRedoStrokes] = useState<MaskStroke[]>([]);
  const [regionStart, setRegionStart] = useState<{ x: number; y: number } | null>(null);
  const [activeRegion, setActiveRegion] = useState<typeof textRegion | null>(null);
  const [frame, setFrame] = useState<ImageFrame>({ left: 0, top: 0, width: 1, height: 1 });
  const imageRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const textNodeRef = useRef<Konva.Text | null>(null);
  const transformerRef = useRef<Konva.Transformer | null>(null);

  const runOcr = useCallback(async () => {
    setOcrLoading(true);
    setOcrError("");
    try {
      const result = await suiteApi.recognizeImageEditText(task.id, version.id);
      if (result.status === "failed") {
        setOcrBlocks([]);
        setOcrError(formatClientOcrError(result.error));
        return;
      }
      const blocks = result.blocks ?? [];
      setOcrBlocks(blocks);
      setTranslatedMap({});
      if (blocks[0]) {
        setOriginalText(blocks[0].text);
        setTextRegion({ ...blocks[0].bounds, rotation: blocks[0].rotation });
      }
    } catch (error) {
      setOcrBlocks([]);
      setOcrError(formatClientOcrError(error));
    } finally {
      setOcrLoading(false);
    }
  }, [task.id, version.id]);

  const runBatchTranslate = async () => {
    if (!ocrBlocks.length || translating) return;
    setTranslating(true);
    setEditorError("");
    try {
      const result = await suiteApi.translateImageTexts({
        targetLanguage: translateLang,
        items: ocrBlocks.map((block) => ({ id: block.id, text: block.text })),
        preserveBrandTerms: true,
      });
      const nextMap: Record<string, string> = {};
      for (const row of result.translations) nextMap[row.id] = row.translatedText;
      setTranslatedMap(nextMap);
      if (ocrBlocks[0] && nextMap[ocrBlocks[0].id]) {
        setOriginalText(ocrBlocks[0].text);
        setNewText(nextMap[ocrBlocks[0].id]);
        setTextRegion({ ...ocrBlocks[0].bounds, rotation: ocrBlocks[0].rotation });
      }
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : "图片文字翻译失败");
    } finally {
      setTranslating(false);
    }
  };

  const applyAllTranslationsToDraft = async () => {
    const pairs = ocrBlocks
      .map((block) => ({ block, translated: (translatedMap[block.id] ?? "").trim() }))
      .filter((entry) => entry.translated.length > 0 && entry.translated !== entry.block.text.trim());
    if (!pairs.length) {
      setEditorError("请先点击一键翻译或填写需要替换的译文");
      return;
    }
    setSaving(true);
    setEditorError("");
    try {
      const created: DraftOperation[] = [];
      for (const { block, translated } of pairs) {
        const opId = `change_text-tr-${block.id}`;
        const op: DraftOperation = {
          operationId: opId,
          type: "change_text",
          summary: `翻译替换(${translateLang})：${block.text} → ${translated}`,
          sourceVersionId: version.id,
          payload: {
            originalText: block.text,
            newText: translated,
            region: { ...block.bounds, rotation: block.rotation },
            prompt: `${changeTextPrompt}；目标语言：${translateLang}`,
          },
        };
        await onOperationAdded?.(op, op.summary);
        committedOperationIds.current.add(op.operationId);
        created.push(op);
      }
      setOperations((current) => {
        const createdIds = new Set(created.map((item) => item.operationId));
        return [...current.filter((item) => !createdIds.has(item.operationId)), ...created];
      });
      setOriginalText("");
      setNewText("");
    } catch (errorValue) {
      setEditorError(errorValue instanceof Error ? errorValue.message : "批量写入翻译操作失败");
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => { suiteApi.imageEditorCapabilities().then((result) => setCapabilities(result.capabilities)).catch(() => setCapabilityError("能力状态暂时不可用")); }, []);
  useEffect(() => {
    suiteApi.getImageEditDraft(task.id).then((draft) => {
      const restored = (draft.operations as unknown as DraftOperation[]).filter((item) => item.sourceVersionId === version.id);
      committedOperationIds.current = new Set(restored.map((item) => item.operationId));
      setOperations(restored);
      const firstText = restored.find((item) => item.type === "add_text");
      if (firstText) {
        const payload = firstText.payload;
        setTextOperationId(firstText.operationId);
        setText(String(payload.text ?? ""));
        setAddTextPrompt(String(payload.prompt ?? ""));
        if (payload.region && typeof payload.region === "object") setTextRegion(payload.region as typeof textRegion);
      }
    }).catch(() => undefined);
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
    if (!capabilities || capabilities.ocr === false) return;
    if (ocrBlocks.length > 0 || ocrAutoTriggeredRef.current) return;
    ocrAutoTriggeredRef.current = true;
    void runOcr();
  }, [capabilities, tool, ocrBlocks.length, runOcr]);
  useEffect(() => {
    const transformer = transformerRef.current;
    if (!transformer) return;
    const node = textNodeRef.current;
    if (!node || !["add_text", "change_text"].includes(tool)) {
      transformer.nodes([]);
      transformer.getLayer()?.batchDraw();
      return;
    }
    transformer.nodes([node]);
    transformer.getLayer()?.batchDraw();
  }, [tool, textOperationId, text, newText, textRegion]);

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
  const startStroke = (event: { target: { getStage(): Konva.Stage | null } }) => {
    const point = pointFromEvent(event);
    if (["inpaint", "erase"].includes(tool)) {
      setActiveStroke({ mode: maskMode, points: [point], size: brush / Math.max(1, Math.min(frame.width, frame.height)) });
      setRedoStrokes([]);
      return;
    }
    if (tool === "change_text" && event.target === event.target.getStage()) {
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
    if (activeRegion && activeRegion.width > 0 && activeRegion.height > 0) setTextRegion(activeRegion);
    setRegionStart(null);
    setActiveRegion(null);
  };

  const operationFor = (selectedTool = tool): DraftOperation => {
    const type = selectedTool === "inpaint" ? "redraw" : selectedTool === "expand" ? "outpaint" : selectedTool as DraftOperation["type"];
    const prompt = selectedTool === "re_edit" ? instruction : selectedTool === "add_text" ? addTextPrompt : selectedTool === "change_text" ? changeTextPrompt : selectedTool === "inpaint" ? redrawPrompt : selectedTool === "erase" ? erasePrompt : "";
    const summary = selectedTool === "add_text" ? `添加文本：${text}` : selectedTool === "change_text" ? `改文字：${originalText || "原文字"} → ${newText}` : selectedTool === "inpaint" ? "局部重绘选区" : selectedTool === "erase" ? "消除笔移除选区" : selectedTool === "expand" ? `扩图：${expand} · ${ratio}` : "重新编辑提示词";
    const existing = selectedTool === "add_text" ? textOperationId : operations.find((item) => item.type === type)?.operationId;
    return { operationId: existing ?? freshOperationId(type), type, summary, sourceVersionId: version.id, payload: { text, originalText, newText, region: textRegion, strokes: strokes.map((stroke) => ({ mode: stroke.mode, points: stroke.points, width: stroke.size })), feather, direction: expand, targetRatio: ratio, prompt } };
  };

  const validationError = () => {
    if (tool === "re_edit" && !instruction.trim()) return "请填写编辑提示词";
    if (tool === "add_text" && (!text.trim() || !addTextPrompt.trim())) return "请填写精确文字和添加文字要求";
    if (tool === "change_text" && (!originalText.trim() || !newText.trim() || !changeTextPrompt.trim())) return "请确认原文字、新文字和替换要求";
    if (tool === "inpaint" && (!strokes.length || !redrawPrompt.trim())) return "请绘制选区并填写重绘要求";
    if (tool === "erase" && !strokes.length) return "请先绘制要清除的选区";
    return "";
  };

  const addOperation = async () => {
    const error = validationError();
    if (error) { setEditorError(error); return; }
    const next = operationFor();
    setSaving(true);
    setEditorError("");
    try {
      await onOperationAdded?.(next, next.summary);
      committedOperationIds.current.add(next.operationId);
      setOperations((current) => [...current.filter((item) => item.operationId !== next.operationId), next]);
    } catch (errorValue) {
      setEditorError(errorValue instanceof Error ? errorValue.message : "操作保存失败");
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (tool === "regenerate") return;
    const next = operationFor();
    const current = operations.find((item) => item.operationId === next.operationId);
    if (!current || !committedOperationIds.current.has(next.operationId) || (current.summary === next.summary && JSON.stringify(current.payload) === JSON.stringify(next.payload))) return;
    const timer = window.setTimeout(() => {
      setOperations((items) => items.map((item) => item.operationId === next.operationId ? next : item));
      void onOperationAdded?.(next, next.summary).catch(() => setEditorError("对话操作同步失败，请重试"));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [tool, text, originalText, newText, textRegion, strokes, feather, expand, ratio, instruction, addTextPrompt, changeTextPrompt, redrawPrompt, erasePrompt, textOperationId, operations]);

  const submit = async () => {
    let finalOperations = operations;
    const currentError = tool === "regenerate" ? "" : validationError();
    if (!currentError && tool !== "regenerate") {
      const next = operationFor();
      const existing = operations.find((item) => item.operationId === next.operationId);
      const needsSync =
        !existing ||
        !committedOperationIds.current.has(next.operationId) ||
        existing.summary !== next.summary ||
        JSON.stringify(existing.payload) !== JSON.stringify(next.payload);
      if (needsSync) {
        setSaving(true);
        setEditorError("");
        try {
          await onOperationAdded?.(next, next.summary);
          committedOperationIds.current.add(next.operationId);
          finalOperations = [...operations.filter((item) => item.operationId !== next.operationId), next];
          setOperations(finalOperations);
        } catch (errorValue) {
          setEditorError(errorValue instanceof Error ? errorValue.message : "操作保存失败");
          setSaving(false);
          return;
        }
      }
    } else if (currentError && operations.length === 0) {
      setEditorError(currentError);
      return;
    }

    if (finalOperations.length === 0) {
      setEditorError("请先添加或填写至少一项编辑操作");
      return;
    }

    setSaving(true);
    setEditorError("");
    try {
      await onSubmit(
        { schemaVersion: "image-edit-v1", sourceVersionId: version.id, operations: finalOperations },
        finalOperations.map((item) => item.summary).join("；"),
      );
    } catch (errorValue) {
      setEditorError(errorValue instanceof Error ? errorValue.message : "生成提交失败");
    } finally {
      setSaving(false);
    }
  };

  const selectOperation = (item: DraftOperation) => {
    const payload = item.payload;
    setEditorError("");
    if (item.type === "add_text") { setTool("add_text"); setTextOperationId(item.operationId); setText(String(payload.text ?? "")); setAddTextPrompt(String(payload.prompt ?? "")); }
    else if (item.type === "change_text") { setTool("change_text"); setOriginalText(String(payload.originalText ?? "")); setNewText(String(payload.newText ?? "")); setChangeTextPrompt(String(payload.prompt ?? "")); }
    else if (item.type === "redraw") { setTool("inpaint"); setRedrawPrompt(String(payload.prompt ?? "")); }
    else if (item.type === "erase") { setTool("erase"); setErasePrompt(String(payload.prompt ?? "")); }
    else if (item.type === "outpaint") setTool("expand");
    else setTool("re_edit");
    if (payload.region && typeof payload.region === "object") setTextRegion(payload.region as typeof textRegion);
    if (Array.isArray(payload.strokes)) setStrokes((payload.strokes as Array<{ mode?: "draw" | "erase"; points: MaskStroke["points"]; width: number }>).map((stroke) => ({ mode: stroke.mode ?? "draw", points: stroke.points, size: stroke.width })));
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
    ["re_edit", "重新编辑", "imageToImage"],
    ["regenerate", "再次生成", "currentVersionInput"],
    ["add_text", "添加文本", "addText"],
    ["change_text", "改文字", "changeText"],
    ["inpaint", "局部重绘", "redraw"],
    ["erase", "消除笔", "erase"],
    ["expand", "扩图", "outpaint"],
  ];
  const activeCapability = toolList.find(([value]) => value === tool)?.[2];
  const capabilityAvailable = (_value: EditTool, capability: string) => capabilities?.[capability] !== false;
  const capabilityReady = tool === "regenerate" ? capabilities?.currentVersionInput !== false : !capabilities || capabilityAvailable(tool, activeCapability ?? "");
  const outpaintBox = useMemo(
    () => computeOutpaintPreviewBox(version.width || 1024, version.height || 1024, expand as "all" | "horizontal" | "vertical" | "left" | "right", ratio as "original" | "1:1" | "3:4" | "4:3" | "9:16" | "16:9"),
    [version.width, version.height, expand, ratio],
  );
  const targetSize = { width: outpaintBox.targetWidth, height: outpaintBox.targetHeight };
  const quickDirectives: Record<string, string[]> = {
    inpaint: ["保持商品本体轮廓与颜色严格不变", "替换为极简柔和影棚光影", "增强材质高光与真实质感", "补充柔和自然桌面接触阴影"],
    erase: ["无痕移除杂物与水印，自然延续周围纹理", "清除多余瑕疵与反光斑点，保持原光影"],
    add_text: ["现代无衬线商业排版，清晰高对比，与画面光影融合", "极简高端品牌副标题排版，居中对齐"],
    re_edit: ["严格保持商品外观与比例不变，仅优化整体商业光影质感", "提升画面明暗层次与电商点击吸引力"],
  };
  const appendQuickDirective = (phrase: string) => {
    const append = (prev: string) => (prev.trim() ? `${prev.trim()}；${phrase}` : phrase);
    if (tool === "inpaint") setRedrawPrompt(append);
    else if (tool === "erase") setErasePrompt(append);
    else if (tool === "add_text") setAddTextPrompt(append);
    else if (tool === "re_edit") setInstruction(append);
  };
  const textVisible = tool === "add_text" || tool === "change_text";
  const textOperations = operations.filter((item) => item.type === "add_text");
  const hasActiveTextOperation = textOperations.some((item) => item.operationId === textOperationId);

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
          {tool === "change_text" && (
            <div className="wb-ocr-blocks" role="status">
              <strong>识别文字</strong>
              {capabilities?.ocr === false ? (
                <span>当前未配置多模态识字模型，请在图片上拖拽框选原文字区域并手动填写原文字与新文字</span>
              ) : ocrLoading ? <span>识别中…</span> : (
                <>
                  <button type="button" onClick={() => void runOcr()}>重新识别</button>
                  {ocrBlocks.length ? ocrBlocks.map((block) => (
                    <button type="button" key={block.id} onClick={() => { setOriginalText(block.text); setTextRegion({ ...block.bounds, rotation: block.rotation }); }}>
                      {block.text} · {Math.round(block.confidence * 100)}%
                    </button>
                  )) : ocrError ? (
                    <span>{ocrError}</span>
                  ) : (
                    <span>未识别到文字，请在图片上拖拽框选原文字区域</span>
                  )}
                </>
              )}
            </div>
          )}
          <aside className="wb-editor-tools">
            <strong>编辑工具</strong>
            {toolList.map(([value, label, capability]) => (
              <button key={value} type="button" className={tool === value ? "is-active" : ""} disabled={!capabilityAvailable(value, capability)} onClick={() => { setTool(value); setEditorError(""); }}>
                {label}
                <small>{!capabilityAvailable(value, capability) ? "不可用" : capabilities ? "可用" : "检查中"}</small>
              </button>
            ))}
            <p>{["inpaint", "erase"].includes(tool) ? "快捷键：Ctrl+Z 撤销 · [ / ] 调整笔刷大小" : tool === "change_text" ? "先 OCR 识别；失败时手工框选原文字" : "调整操作后添加到对话，生成时才冻结"}</p>
            {capabilityError && <p className="wb-editor-error">{capabilityError}</p>}
          </aside>
          <div className="wb-editor-stage">
            <div className="wb-editor-canvas-scroll">
              <div className="wb-editor-canvas" ref={canvasRef} style={{ width: `${Math.round(zoom * 100)}%`, height: `${Math.round(zoom * 100)}%` }}>
                <img ref={imageRef} onLoad={updateFrame} src={version.previewUrl} alt={task.title} />
                <Stage width={frame.width} height={frame.height} style={{ position: "absolute", left: frame.left, top: frame.top }} onMouseDown={startStroke} onMousemove={movePointer} onMouseup={finishStroke} onMouseleave={() => { setPointer(null); finishStroke(); }}>
                  <Layer visible={!holdCompareOriginal}>
                    {ocrBlocks.map((block) => <KonvaRect key={`ocr-${block.id}`} x={block.bounds.x * frame.width} y={block.bounds.y * frame.height} width={block.bounds.width * frame.width} height={block.bounds.height * frame.height} stroke="#c39416" dash={[7, 5]} strokeWidth={1.5} listening={false} />)}
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
                          onClick={() => selectOperation(item)}
                          onTap={() => selectOperation(item)}
                          onDragEnd={selected ? (event) => updateTextRegion(event.target as Konva.Text) : undefined}
                          onTransformEnd={selected ? (event) => updateTextRegion(event.target as Konva.Text, true) : undefined}
                        />
                      );
                    })}
                    {textVisible && ((tool === "change_text") || (tool === "add_text" && !hasActiveTextOperation)) && (
                      <KonvaText
                        ref={textNodeRef}
                        text={tool === "change_text" ? newText || originalText : text}
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
                          left: `${outpaintBox.innerX * 100}%`,
                          top: `${outpaintBox.innerY * 100}%`,
                          width: `${outpaintBox.innerWidth * 100}%`,
                          height: `${outpaintBox.innerHeight * 100}%`,
                        }}
                      >
                        <img src={version.previewUrl} alt="原图锚点" />
                      </div>
                    </div>
                    <div className="wb-outpaint-caption">
                      <span>待扩展画幅预览</span>
                      <strong>{targetSize.width} × {targetSize.height}</strong>
                      <small>原图锚点：{outpaintBox.anchor === "left" ? "左侧" : outpaintBox.anchor === "right" ? "右侧" : "居中"}</small>
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="wb-editor-bottom">
              <span>{strokes.length ? `已记录 ${strokes.length} 条蒙版笔画` : textVisible ? "拖动或缩放虚线框定位文字区域" : "未绘制选区"}</span>
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
            {tool === "re_edit" && <label>版本详细提示词<textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} /></label>}
            {tool === "add_text" && (
              <>
                <div className="wb-editor-option-head">
                  <strong>文字区域</strong>
                  <button type="button" onClick={() => { setTextOperationId(freshOperationId("add_text")); setText(""); setAddTextPrompt(""); setTextRegion({ x: 0.36, y: 0.42, width: 0.28, height: 0.1, rotation: 0 }); }}>新建文字框</button>
                </div>
                <label>精确文字<input value={text} onChange={(event) => setText(event.target.value)} /></label>
                <label>添加文字要求<textarea value={addTextPrompt} onChange={(event) => setAddTextPrompt(event.target.value)} placeholder="描述文字的视觉感觉，以及与画面光线、透视的关系" /></label>
                <small>上方浅/深切换仅用于画布定位清晰度，实际视觉风格由“添加文字要求”控制。</small>
                <button type="button" className="wb-danger-link" onClick={() => { const id = textOperationId; setOperations((current) => current.filter((item) => item.operationId !== id)); void suiteApi.removeImageEditOperation(task.id, id); setTextOperationId(freshOperationId("add_text")); setText(""); }}>删除当前文字框</button>
              </>
            )}
            {tool === "change_text" && (
              <>
                <div className="wb-translate-box" aria-label="跨境图片一键翻译">
                  <div className="wb-translate-head">
                    <strong>跨境图片一键翻译</strong>
                    <span>图文分离 · 保留原排版</span>
                  </div>
                  <div className="wb-translate-controls">
                    <select aria-label="翻译目标语言" value={translateLang} onChange={(event) => setTranslateLang(event.target.value)}>
                      {SUPPORTED_OUTPUT_LANGUAGES.map((lang) => (
                        <option key={lang.code} value={lang.value}>{lang.value}</option>
                      ))}
                    </select>
                    <button type="button" disabled={translating || !ocrBlocks.length} onClick={() => void runBatchTranslate()}>
                      {translating ? "翻译中…" : `一键翻译全部 (${ocrBlocks.length})`}
                    </button>
                  </div>
                  {ocrBlocks.length > 0 && (
                    <div className="wb-translate-rows">
                      {ocrBlocks.map((block) => (
                        <div className="wb-translate-row" key={block.id}>
                          <small title={block.text}>{block.text}</small>
                          <input
                            aria-label={`译文 ${block.text}`}
                            placeholder={`输入${translateLang}译文…`}
                            value={translatedMap[block.id] ?? ""}
                            onFocus={() => { setOriginalText(block.text); setNewText(translatedMap[block.id] ?? ""); setTextRegion({ ...block.bounds, rotation: block.rotation }); }}
                            onChange={(event) => {
                              const nextVal = event.target.value;
                              setTranslatedMap((current) => ({ ...current, [block.id]: nextVal }));
                              if (originalText === block.text) setNewText(nextVal);
                            }}
                          />
                        </div>
                      ))}
                      <button type="button" className="wb-translate-apply" disabled={saving || !Object.values(translatedMap).some((v) => v.trim())} onClick={() => void applyAllTranslationsToDraft()}>
                        将全部译文批量加入对话
                      </button>
                    </div>
                  )}
                </div>
                <label>原文字<input value={originalText} onChange={(event) => setOriginalText(event.target.value)} placeholder="OCR 失败时手工确认" /></label>
                <label>新文字<input value={newText} onChange={(event) => setNewText(event.target.value)} /></label>
                <label>替换要求<textarea value={changeTextPrompt} onChange={(event) => setChangeTextPrompt(event.target.value)} /></label>
                <small>可拖拽虚线框校正识别区域</small>
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
                <label>扩图方向<select value={expand} onChange={(event) => setExpand(event.target.value)}><option value="all">四周</option><option value="horizontal">左右</option><option value="vertical">上下</option><option value="left">向左</option><option value="right">向右</option></select></label>
                <label>目标比例<select value={ratio} onChange={(event) => setRatio(event.target.value)}><option value="original">原比例</option><option value="1:1">1:1</option><option value="3:4">3:4</option><option value="4:3">4:3</option><option value="9:16">9:16</option><option value="16:9">16:9</option></select></label>
                <output>目标尺寸 {targetSize.width} × {targetSize.height}</output>
              </>
            )}
            {tool === "regenerate" && <p>再次生成只在当前卡片下新增版本，不创建子卡片。</p>}
            <div className="wb-editor-operations">
              {operations.map((item) => (
                <div key={item.operationId}>
                  <button type="button" className="wb-operation-edit" onClick={() => selectOperation(item)}>{item.summary}</button>
                  <button type="button" onClick={() => { setOperations((current) => current.filter((entry) => entry.operationId !== item.operationId)); void suiteApi.removeImageEditOperation(task.id, item.operationId); }}>移除</button>
                </div>
              ))}
            </div>
          </aside>
          <footer className="wb-editor-footer">
            <span>已加入对话 {operations.length} 项</span>
            {editorError && <strong role="alert"><ModelSettingsMessage message={editorError} /></strong>}
            <button type="button" onClick={onClose}>取消</button>
            {tool !== "regenerate" && <button type="button" disabled={saving || !capabilityReady} onClick={() => void addOperation()}>{saving ? "保存中…" : operations.some((item) => item.operationId === operationFor().operationId) ? "更新对话操作" : "添加到对话"}</button>}
            {tool === "regenerate" ? (
              <button type="button" className="wb-primary-action" disabled={saving || !capabilityReady} onClick={() => { setSaving(true); onRegenerate().then(onClose).catch((errorValue) => setEditorError(errorValue instanceof Error ? errorValue.message : "再次生成失败")).finally(() => setSaving(false)); }}>{saving ? "提交中…" : "再次生成当前版本"}</button>
            ) : (
              <button type="button" className="wb-primary-action" disabled={saving || !capabilityReady} onClick={() => void submit()}>{saving ? "提交中…" : "开始生成（新建编辑子卡）"}</button>
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

  const submitEdit = async (task: ApiSuiteTask, spec: Record<string, unknown>, instruction: string) => {
    const operations = Array.isArray(spec.operations) ? spec.operations : [];
    for (const operation of operations) await suiteApi.upsertImageEditOperation(task.id, operation as Record<string, unknown>, instruction);
    await suiteApi.submitImageEdit(task.id, { sourceCardId: task.id, sourceVersionId: String(spec.sourceVersionId ?? ""), parentVersionId: String(spec.sourceVersionId ?? ""), summary: instruction });
    setEditor(null);
    await reload();
    notify("编辑已加入对话，正在生成子卡片");
  };

  const persistEditOperation = async (task: ApiSuiteTask, operation: DraftOperation, instruction: string) => {
    await suiteApi.upsertImageEditOperation(task.id, operation as unknown as Record<string, unknown>, instruction);
  };

  const regenerateTask = async (task: ApiSuiteTask) => {
    const child = latestWorkbench.current?.imageEditChildren?.find((item) => String(item.task.id) === task.id);
    if (child) {
      const latest = child.attempts[child.attempts.length - 1];
      if (latest && String(latest.status) === "failed") await suiteApi.retryImageEdit(String(latest.id));
      else await suiteApi.regenerateImageEditTask(task.id, task.promptDraft);
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

  const currentVersion = selectedTask?.versions.find((version) => version.isCurrent) ?? selectedTask?.versions[0];
  const isFreeCanvas = workbench.suite.origin === "canvas";
  const returnPath = isFreeCanvas ? "/create/canvas" : `/create/suite/${suiteId}`;
  const missingReference = Boolean(selectedTask && !selectedIsImageEditChild && !hasTaskReference(selectedTask));
  const appliesStyleOverride = Boolean(styleOverride && selectedTask && !selectedIsImageEditChild && selectedTask.originKind !== "reverse_import");
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
          task={editor.task}
          version={editor.version}
          onClose={() => setEditor(null)}
          onOperationAdded={(operation, instruction) => persistEditOperation(editor.task, operation, instruction)}
          onRegenerate={() => regenerateTask(editor.task)}
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
