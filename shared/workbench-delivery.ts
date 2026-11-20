export type DeliverySourceRole = "edit_final" | "parent_final" | "edit_current" | "parent_current" | "pending";

export interface DeliveryVersionLike {
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
  versions: Array<{
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

export interface ResolvedDeliverySlot {
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
  if (typeof value !== "string" || !value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function resolveDeliverySlots(
  tasks: DeliveryTaskLike[],
  imageEditChildren: DeliveryEditChildLike[] = [],
  options: { defaultTemplateVersionId?: string | null } = {},
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

    const editCurrentCandidate = children
      .map((child) => {
        const currentId = typeof child.task.currentVersionId === "string" ? child.task.currentVersionId : null;
        const version = (currentId ? child.versions.find((item) => item.id === currentId) : null) ?? child.versions[child.versions.length - 1] ?? null;
        return version ? { child, version } : null;
      })
      .find((entry): entry is { child: DeliveryEditChildLike; version: DeliveryEditChildLike["versions"][number] } => Boolean(entry));

    const parentCurrent = task.versions.find((version) => version.isCurrent) ?? task.versions[0] ?? null;

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

    if (editFinalCandidate || (!parentFinal && editCurrentCandidate)) {
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

const LANE_CARD_SIZES: Record<LaneNodeKind, { width: number; height: number }> = {
  style: { width: 256, height: 210 },
  base: { width: 224, height: 240 },
  "reverse-ref": { width: 224, height: 240 },
  task: { width: 296, height: 390 },
  "edit-child": { width: 296, height: 390 },
};

export function computeWorkbenchLanes(
  items: LaneLayoutItem[],
  savedPositions: ReadonlyMap<string, LanePosition> = new Map(),
  options: { ignoreSavedPositions?: boolean } = {},
): Map<string, LanePosition> {
  const ignoreSaved = Boolean(options.ignoreSavedPositions);
  const positions = new Map<string, LanePosition>();
  const occupied: Array<{ x: number; y: number; width: number; height: number }> = [];

  const collides = (pos: LanePosition, size: { width: number; height: number }) =>
    occupied.some((box) =>
      pos.x < box.x + box.width + 20 &&
      pos.x + size.width + 20 > box.x &&
      pos.y < box.y + box.height + 20 &&
      pos.y + size.height + 20 > box.y);

  const commit = (id: string, kind: LaneNodeKind, preferred: LanePosition): LanePosition => {
    const size = LANE_CARD_SIZES[kind];
    let pos = { ...preferred };
    for (let attempt = 0; attempt < 80 && collides(pos, size); attempt += 1) {
      pos = { x: pos.x, y: pos.y + size.height + 24 };
    }
    occupied.push({ ...pos, ...size });
    positions.set(id, pos);
    return pos;
  };

  const leftItems = items.filter((item) => item.kind === "style" || item.kind === "base" || item.kind === "reverse-ref");
  const taskItems = items.filter((item) => item.kind === "task");
  const childItems = items.filter((item) => item.kind === "edit-child");

  let leftY = 28;
  for (const item of leftItems) {
    const saved = ignoreSaved ? undefined : savedPositions.get(item.id);
    const pos = commit(item.id, item.kind, saved ?? { x: 32, y: leftY });
    if (!saved) leftY = pos.y + LANE_CARD_SIZES[item.kind].height + 24;
  }

  const taskColumns = taskItems.length > 3 ? 2 : 1;
  taskItems.forEach((item, index) => {
    const saved = ignoreSaved ? undefined : savedPositions.get(item.id);
    const col = index % taskColumns;
    const row = Math.floor(index / taskColumns);
    const preferred = saved ?? { x: 348 + col * 336, y: 28 + row * 424 };
    commit(item.id, item.kind, preferred);
  });

  const rightLaneX = 348 + taskColumns * 336 + 44;
  let rightFallbackY = 28;
  for (const item of childItems) {
    const saved = ignoreSaved ? undefined : savedPositions.get(item.id);
    const parentPos = item.parentId ? positions.get(item.parentId) : undefined;
    const preferred = saved ?? { x: rightLaneX, y: parentPos ? parentPos.y : rightFallbackY };
    const placed = commit(item.id, item.kind, preferred);
    if (!saved) rightFallbackY = Math.max(rightFallbackY, placed.y + LANE_CARD_SIZES["edit-child"].height + 24);
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
