import { listingFieldEnabled, type ListingContent, type ListingRules } from "./listing-config.js";
import type { AplusImageVersionMetadata } from "./aplus.js";

export type DeliverySourceRole = "edit_final" | "parent_final" | "edit_current" | "parent_current" | "pending";

export interface DeliveryVersionLike extends AplusImageVersionMetadata {
  id: string;
  attemptId?: string;
  versionNumber: number;
  objectKey?: string;
  width?: number;
  height?: number;
  mimeType?: string;
  promptSnapshot?: Record<string, unknown>;
  contextSnapshot?: Record<string, unknown>;
  isCurrent?: boolean;
  isFinal?: boolean;
  createdAt?: string;
  previewUrl?: string;
}

export interface DeliveryAttemptLike {
  id: string;
  provider?: string | { name?: string; version?: string; channel?: { channelId?: string; channelName?: string; baseUrl?: string } };
  model?: string;
  status?: string;
  contextSnapshot?: Record<string, unknown>;
  command?: Record<string, unknown>;
}

export interface DeliveryTaskLike {
  id: string;
  ordinal: number;
  imageType: "main" | "detail";
  title: string;
  purpose: string;
  promptDraft: string;
  status: string;
  originKind?: string;
  generationParams?: Record<string, unknown>;
  versions: DeliveryVersionLike[];
  attempts?: DeliveryAttemptLike[];
}

export interface DeliveryEditChildLike {
  task: Record<string, unknown>;
  snapshot?: Record<string, unknown> | null;
  attempts?: Array<Record<string, unknown>>;
  versions: Array<AplusImageVersionMetadata & {
    id: string;
    previewUrl?: string;
    versionNumber: number;
    width?: number;
    height?: number;
    mimeType?: string;
    objectKey?: string;
    attemptId?: string;
    createdAt?: string;
  }>;
}

export interface ResolvedDeliverySlot extends AplusImageVersionMetadata {
  slotIndex: number;
  typeOrdinal: number;
  imageType: "main" | "detail";
  parentTaskId: string;
  title: string;
  purpose: string;
  sourceRole: DeliverySourceRole;
  isEditedDerived: boolean;
  editChildTaskId: string | null;
  sourceVersionId: string | null;
  versionId: string | null;
  versionNumber: number | null;
  previewUrl: string | null;
  objectKey: string | null;
  width: number | null;
  height: number | null;
  mimeType: string;
  model: string | null;
  channelName: string | null;
  templateVersionId: string | null;
  promptText: string;
  promptSnapshot: Record<string, unknown>;
  exportFilename: string | null;
  exportPath: string | null;
}

export function applyStyleOverrideToPrompt(prompt: string, styleOverride?: string | null): string {
  const cleanOverride = styleOverride
    ?.split(/\r?\n/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("；");
  if (!cleanOverride) return prompt;
  const line = `全局风格卡：${cleanOverride}`;
  if (/^全局风格卡：.*$/m.test(prompt)) {
    return prompt.replace(/^全局风格卡：[\s\S]*?(?=\n(?:当前类别提示词|单卡人工补充)：|$)/m, line);
  }
  const trimmed = prompt.trim();
  return trimmed ? `${line}\n${trimmed}` : line;
}

export function extractCardPromptPreview(prompt: string, fallbackPurpose?: string): string {
  const categoryPrefix = "当前类别提示词：";
  const categoryStart = prompt.indexOf(categoryPrefix);
  if (categoryStart >= 0) {
    const description = prompt.slice(categoryStart + categoryPrefix.length)
      .replace(/(?:^|\r?\n)[^\S\r\n]*单卡人工补充：\s*无\s*$/, "")
      .trim();
    return description.replace(/\r\n/g, "\n") || fallbackPurpose?.trim() || prompt;
  }

  const constraint = /^\s*(?:系统安全约束|平台约束|商品事实约束|全局风格卡)：/;
  const lines = prompt.split(/\r?\n/);
  const description = lines.filter((line) => !constraint.test(line));
  if (description.length === lines.length && prompt.trim()) return prompt;
  return description.join("\n").trim() || fallbackPurpose?.trim() || prompt;
}

export function sanitizeDeliveryName(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+|[._]+$/g, "")
    .slice(0, 48);
  return cleaned || fallback;
}

function extensionForMime(mimeType: string): string {
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
  if (mimeType.includes("webp")) return "webp";
  return "png";
}

function readPromptText(snapshot: Record<string, unknown>, fallback: string): string {
  const candidates = [snapshot.finalPrompt, snapshot.prompt];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return fallback;
}

function resolveModelInfoFromParent(task: DeliveryTaskLike, version: DeliveryVersionLike): { model: string | null; channelName: string | null; templateVersionId: string | null } {
  const attempt = task.attempts?.find((item) => item.id === version.attemptId) ?? task.attempts?.[task.attempts.length - 1];
  const ctx = (attempt?.contextSnapshot ?? version.contextSnapshot ?? {}) as Record<string, unknown>;
  const channel = ctx.channel as { channelName?: string } | undefined;
  const templateVersionId = typeof version.promptSnapshot?.templateVersionId === "string"
    ? version.promptSnapshot.templateVersionId
    : typeof ctx.templateVersionId === "string" ? ctx.templateVersionId : null;
  return {
    model: typeof attempt?.model === "string" && attempt.model ? attempt.model : null,
    channelName: typeof channel?.channelName === "string" && channel.channelName ? channel.channelName : null,
    templateVersionId,
  };
}

function resolveModelInfoFromEditChild(child: DeliveryEditChildLike, version: DeliveryEditChildLike["versions"][number]): {
  model: string | null;
  channelName: string | null;
  promptText: string;
  promptSnapshot: Record<string, unknown>;
} {
  const attempt = child.attempts?.find((entry) => String(entry.id) === String(version.attemptId)) ?? child.attempts?.[child.attempts.length - 1];
  const provider = attempt?.provider as { name?: string; version?: string; channel?: { channelName?: string } } | undefined;
  const command = attempt?.command as Record<string, unknown> | undefined;
  const prompt = typeof command?.prompt === "string" && command.prompt.trim()
    ? command.prompt.trim()
    : String(child.task.summary ?? "");
  const promptSnapshot: Record<string, unknown> = {
    finalPrompt: prompt,
    prompt,
    editSnapshotId: child.snapshot?.id ?? child.task.snapshotId ?? null,
    sourceVersionId: child.task.sourceVersionId ?? child.snapshot?.sourceVersionId ?? null,
    operations: Array.isArray(child.snapshot?.operations) ? child.snapshot.operations : [],
  };
  return {
    model: typeof provider?.version === "string" && provider.version ? provider.version : (typeof provider?.name === "string" ? provider.name : null),
    channelName: typeof provider?.channel?.channelName === "string" ? provider.channel.channelName : null,
    promptText: prompt,
    promptSnapshot,
  };
}

function timestampOf(value: unknown): number {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value !== "string" || !value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function aplusDeliveryMetadata({ generatedSize, deliverySize, deliveryObjectKey }: AplusImageVersionMetadata): AplusImageVersionMetadata {
  return { generatedSize, deliverySize, deliveryObjectKey };
}

export function resolveDeliverySlots(
  tasks: DeliveryTaskLike[],
  imageEditChildren: DeliveryEditChildLike[] = [],
  options: { defaultTemplateVersionId?: string | null; preferLatestByTime?: boolean } = {},
): ResolvedDeliverySlot[] {
  const activeTasks = tasks
    .filter((task) => task.status !== "archived")
    .slice()
    .sort((left, right) => {
      if (left.imageType !== right.imageType) return left.imageType === "main" ? -1 : 1;
      return left.ordinal - right.ordinal;
    });

  const parentTaskIds = new Set(activeTasks.map((task) => task.id));
  const childById = new Map<string, DeliveryEditChildLike>();
  for (const child of imageEditChildren) {
    const id = String(child.task.id ?? "");
    if (id) childById.set(id, child);
  }

  const rootParentOfChild = (child: DeliveryEditChildLike): string | null => {
    const visited = new Set<string>();
    let current: DeliveryEditChildLike | undefined = child;
    while (current) {
      const id = String(current.task.id ?? "");
      if (visited.has(id)) return null;
      visited.add(id);
      const sourceCardId = String(current.task.sourceCardId ?? "");
      if (!sourceCardId) return null;
      if (parentTaskIds.has(sourceCardId)) return sourceCardId;
      current = childById.get(sourceCardId);
    }
    return null;
  };

  const childrenByParent = new Map<string, DeliveryEditChildLike[]>();
  for (const child of imageEditChildren) {
    const rootId = rootParentOfChild(child);
    if (!rootId) continue;
    const list = childrenByParent.get(rootId) ?? [];
    list.push(child);
    childrenByParent.set(rootId, list);
  }

  const typeCounters: Record<"main" | "detail", number> = { main: 0, detail: 0 };
  const usedPaths = new Set<string>();

  return activeTasks.map((task, slotIndex) => {
    typeCounters[task.imageType] += 1;
    const typeOrdinal = typeCounters[task.imageType];
    const children = (childrenByParent.get(task.id) ?? []).slice().sort((a, b) => {
      const timeDiff = timestampOf(b.task.createdAt ?? b.task.updatedAt) - timestampOf(a.task.createdAt ?? a.task.updatedAt);
      if (timeDiff !== 0) return timeDiff;
      return String(b.task.id ?? "").localeCompare(String(a.task.id ?? ""));
    });

    const editFinalCandidate = children
      .map((child) => {
        const finalId = typeof child.task.finalVersionId === "string" ? child.task.finalVersionId : null;
        if (!finalId) return null;
        const version = child.versions.find((item) => item.id === finalId);
        return version ? { child, version } : null;
      })
      .find((entry): entry is { child: DeliveryEditChildLike; version: DeliveryEditChildLike["versions"][number] } => Boolean(entry));

    const parentFinal = task.versions.find((version) => version.isFinal) ?? null;

    const editCurrentCandidates = children
      .map((child) => {
        const currentId = typeof child.task.currentVersionId === "string" ? child.task.currentVersionId : null;
        const version = (currentId ? child.versions.find((item) => item.id === currentId) : null) ?? child.versions[child.versions.length - 1] ?? null;
        return version ? { child, version } : null;
      })
      .filter((entry): entry is { child: DeliveryEditChildLike; version: DeliveryEditChildLike["versions"][number] } => Boolean(entry));

    const isChildDerivedFromChild = (descendant: DeliveryEditChildLike, ancestorId: string): boolean => {
      const visited = new Set<string>();
      let current: DeliveryEditChildLike | undefined = descendant;
      while (current) {
        const id = String(current.task.id ?? "");
        if (visited.has(id)) return false;
        visited.add(id);
        const sourceCardId = String(current.task.sourceCardId ?? "");
        if (!sourceCardId) return false;
        if (sourceCardId === ancestorId) return true;
        current = childById.get(sourceCardId);
      }
      return false;
    };

    const editCurrentCandidate = options.preferLatestByTime
      ? editCurrentCandidates
          .slice()
          .sort((a, b) => {
            const timeDiff =
              timestampOf(b.version.createdAt ?? b.child.task.updatedAt ?? b.child.task.createdAt) -
              timestampOf(a.version.createdAt ?? a.child.task.updatedAt ?? a.child.task.createdAt);
            if (timeDiff !== 0) return timeDiff;
            const aId = String(a.child.task.id ?? "");
            const bId = String(b.child.task.id ?? "");
            if (aId && isChildDerivedFromChild(b.child, aId)) return 1;
            if (bId && isChildDerivedFromChild(a.child, bId)) return -1;
            return bId.localeCompare(aId);
          })[0] ?? undefined
      : editCurrentCandidates[0];

    const parentCurrent = task.versions.find((version) => version.isCurrent) ?? task.versions[0] ?? null;

    const editDerivedFromParentVersion = (
      entry: { child: DeliveryEditChildLike; version: DeliveryEditChildLike["versions"][number] },
      parentVersionId: string,
    ): boolean => {
      const visited = new Set<string>();
      let current: DeliveryEditChildLike | undefined = entry.child;
      while (current) {
        const id = String(current.task.id ?? "");
        if (visited.has(id)) return false;
        visited.add(id);
        const sourceVersionId = typeof current.task.sourceVersionId === "string" ? current.task.sourceVersionId : "";
        const parentVersionRef = typeof current.task.parentVersionId === "string" ? current.task.parentVersionId : "";
        if (sourceVersionId === parentVersionId || parentVersionRef === parentVersionId) return true;
        const sourceCardId: string = String(current.task.sourceCardId ?? "");
        current = sourceCardId ? childById.get(sourceCardId) : undefined;
      }
      return false;
    };

    const preferEditCurrentOverParentCurrent = (() => {
      if (!editCurrentCandidate) return false;
      if (!parentCurrent || !options.preferLatestByTime) return true;
      const editTime = timestampOf(
        editCurrentCandidate.version.createdAt ??
          editCurrentCandidate.child.task.updatedAt ??
          editCurrentCandidate.child.task.createdAt,
      );
      const parentTime = timestampOf(parentCurrent.createdAt);
      if (editTime !== parentTime) return editTime > parentTime;
      return editDerivedFromParentVersion(editCurrentCandidate, parentCurrent.id);
    })();

    const buildExportPath = (mimeType: string) => {
      const ext = extensionForMime(mimeType);
      const prefix = String(typeOrdinal).padStart(2, "0");
      const safeTitle = sanitizeDeliveryName(task.title, `${task.imageType}_${prefix}`);
      let filename = `${prefix}_${safeTitle}.${ext}`;
      let fullPath = `${task.imageType}/${filename}`;
      let suffix = 2;
      while (usedPaths.has(fullPath)) {
        filename = `${prefix}_${safeTitle}_${suffix}.${ext}`;
        fullPath = `${task.imageType}/${filename}`;
        suffix += 1;
      }
      usedPaths.add(fullPath);
      return { exportFilename: filename, exportPath: fullPath };
    };

    if (editFinalCandidate || (!parentFinal && editCurrentCandidate && preferEditCurrentOverParentCurrent)) {
      const chosen = (editFinalCandidate ?? editCurrentCandidate)!;
      const sourceRole: DeliverySourceRole = editFinalCandidate ? "edit_final" : "edit_current";
      const childTaskId = String(chosen.child.task.id);
      const mimeType = chosen.version.mimeType ?? "image/png";
      const info = resolveModelInfoFromEditChild(chosen.child, chosen.version);
      const previewUrl = chosen.version.previewUrl ?? `/api/image-editor/tasks/${encodeURIComponent(childTaskId)}/versions/${encodeURIComponent(chosen.version.id)}/preview`;
      const { exportFilename, exportPath } = buildExportPath(mimeType);
      return {
        slotIndex,
        typeOrdinal,
        imageType: task.imageType,
        parentTaskId: task.id,
        title: task.title,
        purpose: task.purpose,
        sourceRole,
        isEditedDerived: true,
        editChildTaskId: childTaskId,
        sourceVersionId: typeof chosen.child.task.sourceVersionId === "string" ? chosen.child.task.sourceVersionId : null,
        versionId: chosen.version.id,
        versionNumber: chosen.version.versionNumber,
        previewUrl,
        objectKey: chosen.version.objectKey ?? null,
        ...(task.originKind === "aplus" && aplusDeliveryMetadata(chosen.version)),
        width: chosen.version.width ?? null,
        height: chosen.version.height ?? null,
        mimeType,
        model: info.model,
        channelName: info.channelName,
        templateVersionId: options.defaultTemplateVersionId ?? null,
        promptText: info.promptText,
        promptSnapshot: info.promptSnapshot,
        exportFilename,
        exportPath,
      };
    }

    if (parentFinal || parentCurrent) {
      const chosen = (parentFinal ?? parentCurrent)!;
      const sourceRole: DeliverySourceRole = parentFinal ? "parent_final" : "parent_current";
      const mimeType = chosen.mimeType ?? "image/png";
      const info = resolveModelInfoFromParent(task, chosen);
      const snapshot = chosen.promptSnapshot ?? {};
      const { exportFilename, exportPath } = buildExportPath(mimeType);
      return {
        slotIndex,
        typeOrdinal,
        imageType: task.imageType,
        parentTaskId: task.id,
        title: task.title,
        purpose: task.purpose,
        sourceRole,
        isEditedDerived: false,
        editChildTaskId: null,
        sourceVersionId: null,
        versionId: chosen.id,
        versionNumber: chosen.versionNumber,
        previewUrl: chosen.previewUrl ?? null,
        objectKey: chosen.objectKey ?? null,
        ...(task.originKind === "aplus" && aplusDeliveryMetadata(chosen)),
        width: chosen.width ?? null,
        height: chosen.height ?? null,
        mimeType,
        model: info.model,
        channelName: info.channelName,
        templateVersionId: info.templateVersionId ?? options.defaultTemplateVersionId ?? null,
        promptText: readPromptText(snapshot, task.promptDraft),
        promptSnapshot: snapshot,
        exportFilename,
        exportPath,
      };
    }

    return {
      slotIndex,
      typeOrdinal,
      imageType: task.imageType,
      parentTaskId: task.id,
      title: task.title,
      purpose: task.purpose,
      sourceRole: "pending",
      isEditedDerived: false,
      editChildTaskId: null,
      sourceVersionId: null,
      versionId: null,
      versionNumber: null,
      previewUrl: null,
      objectKey: null,
      width: null,
      height: null,
      mimeType: "image/png",
      model: null,
      channelName: null,
      templateVersionId: null,
      promptText: task.promptDraft,
      promptSnapshot: {},
      exportFilename: null,
      exportPath: null,
    };
  });
}

export type LaneNodeKind = "style" | "base" | "reverse-ref" | "task" | "edit-child";

export interface LaneLayoutItem {
  id: string;
  kind: LaneNodeKind;
  parentId?: string;
}

export interface LanePosition {
  x: number;
  y: number;
}

export interface DirectedEdgeLike {
  id: string;
  source: string;
  target: string;
}

export type LaneCardSize = { width: number; height: number };

export interface LaneLayoutOptions {
  ignoreSavedPositions?: boolean;
  measuredSizes?: ReadonlyMap<string, LaneCardSize>;
}

const LANE_CARD_SIZES: Record<LaneNodeKind, LaneCardSize> = {
  style: { width: 256, height: 260 },
  base: { width: 224, height: 280 },
  "reverse-ref": { width: 224, height: 280 },
  task: { width: 320, height: 540 },
  "edit-child": { width: 320, height: 520 },
};

export function computeWorkbenchLanes(
  items: LaneLayoutItem[],
  savedPositions: ReadonlyMap<string, LanePosition> = new Map(),
  { ignoreSavedPositions, measuredSizes }: LaneLayoutOptions = {},
): Map<string, LanePosition> {
  const columnGap = 44;
  const rowGap = 40;
  const top = 28;
  const left = 32;
  const positions = new Map<string, LanePosition>();
  const savedBoxes: Array<LanePosition & LaneCardSize> = [];
  const sizeOf = (item: LaneLayoutItem) => measuredSizes?.get(item.id) ?? LANE_CARD_SIZES[item.kind];

  // Keep manual positions on reload. Place new cards around those existing cards.
  if (!ignoreSavedPositions) {
    for (const item of items) {
      const saved = savedPositions.get(item.id);
      if (!saved) continue;
      positions.set(item.id, { ...saved });
      savedBoxes.push({ ...saved, ...sizeOf(item) });
    }
    savedBoxes.sort((a, b) => a.y - b.y);
  }

  const place = (item: LaneLayoutItem, x: number, startY: number) => {
    if (positions.has(item.id)) return startY;
    const { width, height } = sizeOf(item);
    let y = startY;
    for (const box of savedBoxes) {
      if (x < box.x + box.width + columnGap && x + width + columnGap > box.x &&
        y < box.y + box.height + rowGap && y + height + rowGap > box.y) {
        y = box.y + box.height + rowGap;
      }
    }
    positions.set(item.id, { x, y });
    return y + height + rowGap;
  };

  const leftItems = items.filter((item) => item.kind === "style" || item.kind === "base" || item.kind === "reverse-ref");
  const taskItems = items.filter((item) => item.kind === "task");
  const childItems = items.filter((item) => item.kind === "edit-child");

  let leftY = top;
  for (const item of leftItems) {
    leftY = place(item, left, leftY);
  }

  const taskColumns = taskItems.length > 3 ? 2 : 1;
  const taskX = left + Math.max(LANE_CARD_SIZES.style.width, ...leftItems.map((item) => sizeOf(item).width)) + columnGap;
  const taskWidth = Math.max(LANE_CARD_SIZES.task.width, ...taskItems.map((item) => sizeOf(item).width));
  const colY = Array<number>(taskColumns).fill(top);
  taskItems.forEach((item, index) => {
    const col = index % taskColumns;
    colY[col] = place(item, taskX + col * (taskWidth + columnGap), colY[col]);
  });

  const rightLaneX = taskX + taskColumns * (taskWidth + columnGap);
  let rightY = top;
  for (const item of childItems) {
    const parentY = item.parentId ? positions.get(item.parentId)?.y ?? top : top;
    rightY = place(item, rightLaneX, Math.max(rightY, parentY));
  }

  return positions;
}

export function computeLineageHighlight(
  selectedNodeId: string | null,
  edges: DirectedEdgeLike[],
): { highlightedNodeIds: Set<string>; highlightedEdgeIds: Set<string> } {
  const highlightedNodeIds = new Set<string>();
  const highlightedEdgeIds = new Set<string>();
  if (!selectedNodeId) return { highlightedNodeIds, highlightedEdgeIds };

  highlightedNodeIds.add(selectedNodeId);

  const incoming = new Map<string, DirectedEdgeLike[]>();
  const outgoing = new Map<string, DirectedEdgeLike[]>();
  for (const edge of edges) {
    const inList = incoming.get(edge.target) ?? [];
    inList.push(edge);
    incoming.set(edge.target, inList);
    const outList = outgoing.get(edge.source) ?? [];
    outList.push(edge);
    outgoing.set(edge.source, outList);
  }

  const upQueue = [selectedNodeId];
  const upVisited = new Set<string>([selectedNodeId]);
  while (upQueue.length) {
    const current = upQueue.shift()!;
    for (const edge of incoming.get(current) ?? []) {
      highlightedEdgeIds.add(edge.id);
      highlightedNodeIds.add(edge.source);
      if (!upVisited.has(edge.source)) {
        upVisited.add(edge.source);
        upQueue.push(edge.source);
      }
    }
  }

  const downQueue = [selectedNodeId];
  const downVisited = new Set<string>([selectedNodeId]);
  while (downQueue.length) {
    const current = downQueue.shift()!;
    for (const edge of outgoing.get(current) ?? []) {
      highlightedEdgeIds.add(edge.id);
      highlightedNodeIds.add(edge.target);
      if (!downVisited.has(edge.target)) {
        downVisited.add(edge.target);
        downQueue.push(edge.target);
      }
    }
  }

  return { highlightedNodeIds, highlightedEdgeIds };
}

export const SUPPORTED_OUTPUT_LANGUAGES = [
  { value: "英文", label: "英文 (English · US/UK/AU)", code: "en" },
  { value: "中文", label: "中文 (简体中文 · 国内电商)", code: "zh-CN" },
  { value: "日语", label: "日语 (日本語 · Amazon JP)", code: "ja" },
  { value: "德语", label: "德语 (Deutsch · Amazon DE)", code: "de" },
  { value: "法语", label: "法语 (Français · Amazon FR)", code: "fr" },
  { value: "西班牙语", label: "西班牙语 (Español · ES/MX)", code: "es" },
  { value: "韩语", label: "韩语 (한국어 · Coupang)", code: "ko" },
  { value: "泰语", label: "泰语 (ไทย · Shopee/Lazada TH)", code: "th" },
  { value: "越南语", label: "越南语 (Tiếng Việt · VN)", code: "vi" },
  { value: "俄语", label: "俄语 (Русский · Ozon/WB)", code: "ru" },
  { value: "葡萄牙语", label: "葡萄牙语 (Português · BR)", code: "pt" },
  { value: "阿拉伯语", label: "阿拉伯语 (العربية · Noon/AE)", code: "ar" },
] as const;

export type DeliveryExportPresetId = "original" | "amazon" | "taobao" | "tiktok" | "shopify";
export type DeliveryExportFormat = "original" | "png" | "jpeg" | "webp";

export interface DeliveryExportPreset {
  id: DeliveryExportPresetId;
  label: string;
  description: string;
  defaultFormat: DeliveryExportFormat;
  defaultQuality: number;
  mainBox?: { width: number; height: number; fit: "contain" | "cover" };
  detailWidth?: number;
  minMainSide?: number;
}

export const DELIVERY_EXPORT_PRESETS: Record<DeliveryExportPresetId, DeliveryExportPreset> = {
  original: {
    id: "original",
    label: "原图无损",
    description: "保留模型生成的原始分辨率与格式，适合二次精修与归档。",
    defaultFormat: "original",
    defaultQuality: 92,
    minMainSide: 800,
  },
  amazon: {
    id: "amazon",
    label: "Amazon 跨境规范",
    description: "主图 2000×2000 白底补边 JPG（满足缩放要求），详情图 1600px 宽 JPG。",
    defaultFormat: "jpeg",
    defaultQuality: 90,
    mainBox: { width: 2000, height: 2000, fit: "contain" },
    detailWidth: 1600,
    minMainSide: 1000,
  },
  taobao: {
    id: "taobao",
    label: "淘宝 / 天猫规范",
    description: "主图 800×800 JPG，详情页 790px 宽 JPG（支持一键无缝长图拼接）。",
    defaultFormat: "jpeg",
    defaultQuality: 88,
    mainBox: { width: 800, height: 800, fit: "contain" },
    detailWidth: 790,
    minMainSide: 800,
  },
  tiktok: {
    id: "tiktok",
    label: "TikTok Shop 规范",
    description: "主图 1080×1080 JPG，详情图 1080px 宽适配移动端竖屏浏览。",
    defaultFormat: "jpeg",
    defaultQuality: 90,
    mainBox: { width: 1080, height: 1080, fit: "contain" },
    detailWidth: 1080,
    minMainSide: 800,
  },
  shopify: {
    id: "shopify",
    label: "Shopify 独立站 WebP",
    description: "主图 2048×2048 WebP，详情 1600px 宽 WebP，兼顾高清与秒开加载。",
    defaultFormat: "webp",
    defaultQuality: 88,
    mainBox: { width: 2048, height: 2048, fit: "contain" },
    detailWidth: 1600,
    minMainSide: 1000,
  },
};

export interface DeliveryComplianceCheck {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface DeliveryComplianceReport {
  presetId: DeliveryExportPresetId;
  score: number;
  totalSlots: number;
  deliverableCount: number;
  finalizedCount: number;
  checks: DeliveryComplianceCheck[];
}

export function evaluateDeliveryCompliance(
  slots: ResolvedDeliverySlot[],
  presetId: DeliveryExportPresetId = "original",
): DeliveryComplianceReport {
  const preset = DELIVERY_EXPORT_PRESETS[presetId] ?? DELIVERY_EXPORT_PRESETS.original;
  const totalSlots = slots.length;
  const deliverable = slots.filter((slot) => slot.sourceRole !== "pending");
  const mainDeliverable = deliverable.filter((slot) => slot.imageType === "main");
  const finalized = deliverable.filter((slot) => slot.sourceRole === "edit_final" || slot.sourceRole === "parent_final");
  const minMainSide = preset.minMainSide ?? 800;

  const checks: DeliveryComplianceCheck[] = [];

  if (totalSlots === 0) {
    checks.push({ id: "slots", label: "套图坑位完整性", status: "fail", detail: "尚无任务坑位，请先在规划页或创作板创建任务。" });
  } else if (deliverable.length === totalSlots) {
    checks.push({ id: "slots", label: "套图坑位完整性", status: "pass", detail: `全部 ${totalSlots} 个坑位均已出图，可直接打包交付。` });
  } else {
    checks.push({
      id: "slots",
      label: "套图坑位完整性",
      status: deliverable.length > 0 ? "warn" : "fail",
      detail: `已出图 ${deliverable.length}/${totalSlots}，仍有 ${totalSlots - deliverable.length} 个坑位待生成。`,
    });
  }

  if (!deliverable.length) {
    checks.push({ id: "final", label: "终版人工确认率", status: "fail", detail: "尚无可确认的成品版本。" });
  } else if (finalized.length === deliverable.length) {
    checks.push({ id: "final", label: "终版人工确认率", status: "pass", detail: `全部 ${finalized.length} 张交付图已由设计师显式设为终版。` });
  } else {
    checks.push({
      id: "final",
      label: "终版人工确认率",
      status: "warn",
      detail: `${finalized.length}/${deliverable.length} 已设终版，其余将按规则自动回退当前版导出。`,
    });
  }

  const lowResMains = mainDeliverable.filter((slot) => {
    const longest = Math.max(slot.width ?? 0, slot.height ?? 0);
    return longest > 0 && longest < minMainSide;
  });
  if (!mainDeliverable.length) {
    checks.push({ id: "resolution", label: `主图分辨率达标（≥${minMainSide}px）`, status: "warn", detail: "暂无已生成的主图可供校验。" });
  } else if (!lowResMains.length) {
    checks.push({
      id: "resolution",
      label: `主图分辨率达标（≥${minMainSide}px）`,
      status: "pass",
      detail: `${mainDeliverable.length} 张主图均满足 ${preset.label} 清晰度要求。`,
    });
  } else {
    checks.push({
      id: "resolution",
      label: `主图分辨率达标（≥${minMainSide}px）`,
      status: "warn",
      detail: `${lowResMains.length} 张主图原图最长边不足 ${minMainSide}px（导出平台预设时将自动缩放补齐，建议源图升级 2K）。`,
    });
  }

  const missingTrace = deliverable.filter((slot) => !slot.promptText.trim());
  checks.push({
    id: "trace",
    label: "提示词快照可追溯性",
    status: deliverable.length > 0 && !missingTrace.length ? "pass" : deliverable.length ? "warn" : "fail",
    detail: deliverable.length === 0
      ? "等待出图后生成不可变溯源快照。"
      : !missingTrace.length
        ? "全部交付图均携带完整冻结提示词与模型血缘，自动写入 manifest.json。"
        : `有 ${missingTrace.length} 张图片缺少完整提示词快照。`,
  });

  const weight = checks.reduce((sum, item) => sum + (item.status === "pass" ? 1 : item.status === "warn" ? 0.55 : 0), 0);
  const score = checks.length ? Math.round((weight / checks.length) * 100) : 0;

  return {
    presetId: preset.id,
    score,
    totalSlots,
    deliverableCount: deliverable.length,
    finalizedCount: finalized.length,
    checks,
  };
}

export interface ListingCopyMarkdownInput {
  suiteName: string;
  platformName?: string;
  marketScope?: string;
  job: {
    platform: string;
    targetMarket: string;
    outputLanguage: string;
  };
  version: {
    versionNumber: number;
    createdAt: string;
    content: ListingContent;
  };
  rules?: ListingRules;
  exportedAt: string;
}

/** Formats a listing-copy version into a UTF-8 Markdown document for delivery ZIP export. */
export function formatListingCopyMarkdown(input: ListingCopyMarkdownInput): string {
  const { suiteName, platformName, marketScope, job, version, rules, exportedAt } = input;
  const content = version.content;
  const domestic = marketScope === "domestic";
  const lines: string[] = [
    `# ${suiteName} — 商品上架文案`,
    "",
    `- 目标平台：${platformName ? `${platformName} (${job.platform})` : job.platform}`,
    `- 目标市场：${job.targetMarket}`,
    `- 输出语言：${job.outputLanguage}`,
    `- 版本号：v${version.versionNumber}`,
    `- 导出时间：${exportedAt}`,
    "",
  ];

  const pushTextSection = (heading: string, value?: string) => {
    const trimmed = value?.trim();
    if (!trimmed) return;
    lines.push(`## ${heading}`, "", trimmed, "");
  };

  lines.push("## 标题", "", content.title?.trim() || "（空）", "");

  if (listingFieldEnabled("itemHighlights", rules) || content.itemHighlights?.trim()) {
    pushTextSection("商品亮点 (Item Highlights)", content.itemHighlights);
  }

  if (listingFieldEnabled("subtitle", rules) || content.subtitle?.trim()) {
    pushTextSection("促销副标题", content.subtitle);
  }

  const bullets = (content.bulletPoints ?? []).map((item) => item.trim()).filter(Boolean);
  lines.push(`## ${domestic ? "卖点短句" : "五点描述"}`, "");
  if (bullets.length) {
    bullets.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
  } else {
    lines.push("（空）");
  }
  lines.push("");

  lines.push("## 商品描述", "", content.description?.trim() || "（空）", "");

  const searchTerms = (content.searchTerms ?? []).map((item) => item.trim()).filter(Boolean);
  if ((listingFieldEnabled("searchTerms", rules) || searchTerms.length > 0) && searchTerms.length > 0) {
    lines.push("## 后台搜索词", "", searchTerms.join(" "), "");
    for (const term of searchTerms) lines.push(`- ${term}`);
    lines.push("");
  }

  const tags = (content.tags ?? []).map((item) => item.trim()).filter(Boolean);
  if ((listingFieldEnabled("tags", rules) || tags.length > 0) && tags.length > 0) {
    lines.push("## 商品标签 (Tags)", "", tags.join(", "), "");
    for (const tag of tags) lines.push(`- ${tag}`);
    lines.push("");
  }

  if (listingFieldEnabled("seoTitle", rules) || content.seoTitle?.trim()) {
    pushTextSection("SEO Meta Title", content.seoTitle);
  }

  if (listingFieldEnabled("seoDescription", rules) || content.seoDescription?.trim()) {
    pushTextSection("SEO Meta Description", content.seoDescription);
  }

  const hashtags = (content.hashtags ?? []).map((item) => item.trim()).filter(Boolean);
  if ((listingFieldEnabled("hashtags", rules) || hashtags.length > 0) && hashtags.length > 0) {
    const formatted = hashtags.map((tag) => (tag.startsWith("#") ? tag : `#${tag}`));
    lines.push("## 话题标签 (#Tag)", "", formatted.join(" "), "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
