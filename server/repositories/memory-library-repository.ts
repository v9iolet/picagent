import { assertReferenceAllowed } from "../library-reference-policy.js";
import { randomUUID } from "node:crypto";
import type { ImageEditorRepository, ImageEditAttempt, ImageEditChildTask, ImageEditVersion, EditSnapshot } from "../image-editor.js";
import type {
  LibraryAssetStatus,
  LibraryReference,
  LibraryRepository,
  LibraryResource,
  LibraryResourceBatchDeleteResult,
  LibraryResourceDeletionResult,
  LibraryResourceQuery,
  SuiteTask,
  TaskGenerationAttempt,
  TaskImageVersion,
  TaskRepository,
} from "../types.js";

type MemoryTaskSource = TaskRepository & {
  listAllTasks?: () => SuiteTask[];
  listAllVersions?: () => Array<{ task: SuiteTask; version: TaskImageVersion; attempt?: TaskGenerationAttempt }>;
};

type MemoryImageEditorApiSource = {
  request(method: string, path: string, options?: { headers?: Record<string, string>; body?: unknown }): Promise<{ status: number; body: unknown }>;
};

export interface MemoryLibrarySources {
  taskRepository?: MemoryTaskSource;
  imageEditorRepository?: ImageEditorRepository;
  imageEditorApi?: MemoryImageEditorApiSource;
}

interface EditTaskBundle {
  task: ImageEditChildTask;
  snapshot: EditSnapshot | null;
  attempts: ImageEditAttempt[];
  versions: ImageEditVersion[];
}

interface ResolvedLibraryEntry {
  resource: LibraryResource;
  archivedByTask: boolean;
}

function mapMemoryTaskVersion(task: SuiteTask, version: TaskImageVersion, attempt?: TaskGenerationAttempt): LibraryResource {
  const isReplica = task.originKind === "replica";
  const taskStage = isReplica ? ("replica_prompt" as const) : ("task_image" as const);
  const kindLabel = isReplica ? "爆品图复刻" : task.imageType === "main" ? "主图" : "详情页";
  const originMeta = isReplica ? { origin: "replica", originKind: "replica" } : {};
  const channel = version.contextSnapshot?.channel ?? null;
  return {
    id: `task-version:${version.id}`,
    resourceType: "task_image_version",
    title: `${task.title} · 版本 ${version.versionNumber}`,
    summary: `${kindLabel} · ${version.width} × ${version.height}`,
    mimeType: version.mimeType,
    previewUrl: version.previewUrl || `/api/suite-tasks/${task.id}/versions/${version.id}/preview`,
    suiteId: task.suiteId,
    taskId: task.id,
    imageVersionId: version.id,
    baseVersionId: null,
    templateVersionId: null,
    resourceVersionId: version.id,
    stage: taskStage,
    source: {
      objectKey: version.objectKey,
      versionNumber: version.versionNumber,
      promptSummary: task.promptDraft.slice(0, 180),
      model: attempt?.model ?? null,
      channel,
      ...originMeta,
    },
    promptSnapshot: version.promptSnapshot,
    status: "published",
    createdAt: version.createdAt,
    updatedAt: version.createdAt,
  };
}

function mapMemoryProcessImage(task: SuiteTask, version: TaskImageVersion, objectKey: string, index: number, attempt?: TaskGenerationAttempt): LibraryResource {
  const isReplica = task.originKind === "replica";
  const taskStage = isReplica ? ("replica_prompt" as const) : ("task_image" as const);
  const kindLabel = isReplica ? "爆品图复刻" : task.imageType === "main" ? "主图" : "详情页";
  const originMeta = isReplica ? { origin: "replica", originKind: "replica" } : {};
  const channel = version.contextSnapshot?.channel ?? null;
  return {
    id: `process:${version.id}:${index}`,
    resourceType: "process_image",
    title: `${task.title} · 过程图 ${index + 1}`,
    summary: `${kindLabel} · 版本 ${version.versionNumber}`,
    mimeType: "image/png",
    previewUrl: null,
    suiteId: task.suiteId,
    taskId: task.id,
    imageVersionId: version.id,
    baseVersionId: null,
    templateVersionId: null,
    resourceVersionId: `${version.id}:${index}`,
    stage: taskStage,
    source: {
      objectKey,
      versionId: version.id,
      processIndex: index,
      model: attempt?.model ?? null,
      channel,
      ...originMeta,
    },
    promptSnapshot: version.promptSnapshot,
    status: "published",
    createdAt: version.createdAt,
    updatedAt: version.createdAt,
  };
}

function mapMemoryEditVersion(bundle: EditTaskBundle, version: ImageEditVersion, rootTask: SuiteTask | null): LibraryResource {
  const isReplica = rootTask?.originKind === "replica";
  const taskStage = isReplica ? ("replica_prompt" as const) : ("task_image" as const);
  const kindLabel = isReplica ? "爆品图复刻" : rootTask?.imageType === "main" ? "主图" : "详情页";
  const originMeta = isReplica ? { origin: "replica", originKind: "replica" } : {};
  const attempt = bundle.attempts.find((item) => item.id === version.attemptId) ?? bundle.attempts[bundle.attempts.length - 1];
  const command = attempt?.command;
  const provider = attempt?.provider ?? bundle.snapshot?.provider;
  const editPrompt = typeof command?.prompt === "string" && command.prompt.trim()
    ? command.prompt.trim()
    : bundle.task.summary.trim() || bundle.snapshot?.sourcePrompt || "";
  const model = provider?.version || provider?.name || null;
  const channel = provider?.channel ?? null;
  const baseTitle = rootTask?.title?.trim() || bundle.task.summary.trim() || "图片编辑";
  return {
    id: `edit-version:${version.id}`,
    resourceType: "task_image_version",
    title: `${baseTitle} · 编辑版本 ${version.versionNumber}`,
    summary: `编辑生成 · ${kindLabel} · ${version.width} × ${version.height}`,
    mimeType: version.mimeType,
    previewUrl: `/api/image-editor/tasks/${bundle.task.id}/versions/${version.id}/preview`,
    suiteId: rootTask?.suiteId ?? null,
    taskId: rootTask?.id ?? bundle.task.id,
    imageVersionId: version.id,
    baseVersionId: null,
    templateVersionId: null,
    resourceVersionId: version.id,
    stage: taskStage,
    source: {
      objectKey: version.objectKey,
      generatedBy: "image_editor",
      editChildTaskId: bundle.task.id,
      editSnapshotId: bundle.task.snapshotId,
      sourceCardId: bundle.task.sourceCardId,
      sourceVersionId: bundle.task.sourceVersionId,
      parentVersionId: bundle.task.parentVersionId,
      rootTaskId: rootTask?.id ?? null,
      editSummary: bundle.task.summary,
      versionNumber: version.versionNumber,
      promptSummary: editPrompt.slice(0, 180),
      model,
      channel,
      ...originMeta,
    },
    promptSnapshot: {
      finalPrompt: editPrompt,
      prompt: editPrompt,
      sourcePrompt: bundle.snapshot?.sourcePrompt ?? "",
      editSummary: bundle.task.summary,
      editSnapshotId: bundle.task.snapshotId,
      sourceVersionId: bundle.task.sourceVersionId,
      operations: Array.isArray(bundle.snapshot?.operations) ? [...bundle.snapshot.operations] : [],
      ...(model ? { model } : {}),
    },
    status: "published",
    createdAt: version.createdAt,
    updatedAt: version.createdAt,
  };
}

export class MemoryLibraryRepository implements LibraryRepository {
  private readonly resources = new Map<string, LibraryResource>();
  private readonly references = new Map<string, LibraryReference>();
  private readonly idempotency = new Map<string, string>();
  private readonly deletedAt = new Map<string, string>();
  private sources: MemoryLibrarySources;

  constructor(sources: MemoryLibrarySources = {}) {
    this.sources = { ...sources };
  }

  bindSources(sources: MemoryLibrarySources): void {
    this.sources = {
      ...this.sources,
      ...(sources.taskRepository ? { taskRepository: sources.taskRepository } : {}),
      ...(sources.imageEditorRepository ? { imageEditorRepository: sources.imageEditorRepository } : {}),
      ...(sources.imageEditorApi ? { imageEditorApi: sources.imageEditorApi } : {}),
    };
  }

  addResource(resource: LibraryResource): LibraryResource {
    this.resources.set(resource.id, resource);
    this.deletedAt.delete(resource.id);
    return resource;
  }

  private async loadEditBundles(): Promise<EditTaskBundle[]> {
    if (this.sources.imageEditorRepository) {
      const repo = this.sources.imageEditorRepository;
      const tasks = await repo.listChildTasks();
      return Promise.all(
        tasks.map(async (task) => ({
          task,
          snapshot: await repo.getSnapshot(task.snapshotId),
          attempts: await repo.listAttempts(task.id),
          versions: await repo.listVersions(task.id),
        })),
      );
    }
    if (this.sources.imageEditorApi) {
      const response = await this.sources.imageEditorApi.request("GET", "/api/image-editor/tasks");
      if (response.status === 200 && response.body && typeof response.body === "object" && "data" in response.body) {
        const data = (response.body as { data?: unknown }).data;
        if (Array.isArray(data)) return data as EditTaskBundle[];
      }
    }
    return [];
  }

  private async collectEntries(): Promise<Map<string, ResolvedLibraryEntry>> {
    const entries = new Map<string, ResolvedLibraryEntry>();
    const taskRepo = this.sources.taskRepository;
    const tasksById = new Map<string, SuiteTask>();
    if (taskRepo?.listAllTasks) {
      for (const task of taskRepo.listAllTasks()) {
        tasksById.set(task.id, task);
      }
    }
    const getTaskById = async (taskId: string): Promise<SuiteTask | null> => {
      const cached = tasksById.get(taskId);
      if (cached) return cached;
      if (!taskRepo) return null;
      const fetched = await taskRepo.getTask(taskId);
      if (fetched) tasksById.set(fetched.id, fetched);
      return fetched;
    };

    for (const resource of this.resources.values()) {
      let archivedByTask = false;
      if (resource.taskId) {
        const task = await getTaskById(resource.taskId);
        if (task?.status === "archived") archivedByTask = true;
      }
      if (!archivedByTask && typeof resource.source?.rootTaskId === "string") {
        const rootTask = await getTaskById(resource.source.rootTaskId);
        if (rootTask?.status === "archived") archivedByTask = true;
      }
      entries.set(resource.id, { resource, archivedByTask });
    }

    if (taskRepo?.listAllVersions) {
      for (const { task, version, attempt } of taskRepo.listAllVersions()) {
        const archivedByTask = task.status === "archived";
        const tvResource = mapMemoryTaskVersion(task, version, attempt);
        const existingTv = entries.get(tvResource.id);
        if (existingTv) {
          existingTv.archivedByTask = existingTv.archivedByTask || archivedByTask;
        } else {
          entries.set(tvResource.id, { resource: tvResource, archivedByTask });
        }
        version.processObjectKeys.forEach((objectKey, index) => {
          const procResource = mapMemoryProcessImage(task, version, objectKey, index, attempt);
          const existingProc = entries.get(procResource.id);
          if (existingProc) {
            existingProc.archivedByTask = existingProc.archivedByTask || archivedByTask;
          } else {
            entries.set(procResource.id, { resource: procResource, archivedByTask });
          }
        });
      }
    }

    const editBundles = await this.loadEditBundles();
    if (editBundles.length > 0) {
      const childById = new Map<string, EditTaskBundle>(editBundles.map((bundle) => [bundle.task.id, bundle]));
      for (const bundle of editBundles) {
        let rootTask: SuiteTask | null = null;
        let anyChildArchived = (bundle.task.status as string) === "archived";
        const visited = new Set<string>();
        let current: ImageEditChildTask | undefined = bundle.task;
        while (current) {
          if (visited.has(current.id)) break;
          visited.add(current.id);
          if ((current.status as string) === "archived") anyChildArchived = true;
          const parentId: string = current.sourceCardId;
          if (!parentId) break;
          const maybeRoot = await getTaskById(parentId);
          if (maybeRoot) {
            rootTask = maybeRoot;
            break;
          }
          current = childById.get(parentId)?.task;
        }
        const archivedByTask = anyChildArchived || rootTask?.status === "archived";
        for (const version of bundle.versions) {
          const editResource = mapMemoryEditVersion(bundle, version, rootTask);
          const existingEdit = entries.get(editResource.id);
          if (existingEdit) {
            existingEdit.archivedByTask = existingEdit.archivedByTask || archivedByTask;
          } else {
            entries.set(editResource.id, { resource: editResource, archivedByTask });
          }
        }
      }
    }

    return entries;
  }

  async listResources(query: LibraryResourceQuery) {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 24));
    const needle = query.query?.trim().toLocaleLowerCase();
    const entries = await this.collectEntries();
    const filtered = [...entries.values()]
      .filter(({ resource, archivedByTask }) => {
        if (this.deletedAt.has(resource.id) || archivedByTask) return false;
        if (query.scope === "image" && resource.resourceType === "prompt_template") return false;
        if (query.resourceType && resource.resourceType !== query.resourceType) return false;
        if (query.stage && resource.stage !== query.stage) return false;
        if (query.suiteId && resource.suiteId !== query.suiteId && resource.suiteId !== null) return false;
        if (query.status && resource.status !== query.status) return false;
        if (needle) {
          const editSummary = typeof resource.source.editSummary === "string" ? resource.source.editSummary : "";
          const promptSummary = typeof resource.source.promptSummary === "string" ? resource.source.promptSummary : "";
          const haystack = `${resource.title} ${resource.summary} ${editSummary} ${promptSummary}`.toLocaleLowerCase();
          if (!haystack.includes(needle)) return false;
        }
        return true;
      })
      .map(({ resource }) => resource)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { items: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length, page, pageSize };
  }

  async getResource(resourceId: string, options?: { includeDeleted?: boolean }) {
    const entries = await this.collectEntries();
    const entry = entries.get(resourceId);
    if (!entry) return null;
    if (!options?.includeDeleted && (this.deletedAt.has(resourceId) || entry.archivedByTask)) return null;
    return entry.resource;
  }

  async getPreviewObject(resourceId: string) {
    const resource = await this.getResource(resourceId, { includeDeleted: true });
    const objectKey = typeof resource?.source.objectKey === "string" ? resource.source.objectKey : null;
    return objectKey ? { objectKey } : null;
  }

  async deleteResource(resourceId: string): Promise<LibraryResourceDeletionResult | null> {
    const entries = await this.collectEntries();
    const resource = entries.get(resourceId)?.resource;
    if (!resource) return null;
    if (resource.resourceType === "prompt_template") throw new Error("LIBRARY_RESOURCE_FORBIDDEN");
    const existing = this.deletedAt.get(resourceId);
    if (existing) return { id: resourceId, deletedAt: existing, alreadyDeleted: true };
    const now = new Date().toISOString();
    this.deletedAt.set(resourceId, now);
    return { id: resourceId, deletedAt: now, alreadyDeleted: false };
  }

  async deleteResources(resourceIds: string[]): Promise<LibraryResourceBatchDeleteResult> {
    const entries = await this.collectEntries();
    const uniqueIds = [...new Set(resourceIds)];
    for (const id of uniqueIds) {
      const resource = entries.get(id)?.resource;
      if (resource?.resourceType === "prompt_template") throw new Error("LIBRARY_RESOURCE_FORBIDDEN");
    }
    const deletedIds: string[] = [];
    const alreadyDeletedIds: string[] = [];
    const notFoundIds: string[] = [];
    const now = new Date().toISOString();
    for (const id of uniqueIds) {
      const resource = entries.get(id)?.resource;
      if (!resource) {
        notFoundIds.push(id);
      } else if (this.deletedAt.has(id)) {
        alreadyDeletedIds.push(id);
      } else {
        this.deletedAt.set(id, now);
        deletedIds.push(id);
      }
    }
    return { deletedIds, alreadyDeletedIds, notFoundIds, deletedCount: deletedIds.length };
  }

  async restoreResource(resourceId: string): Promise<void> {
    this.deletedAt.delete(resourceId);
  }

  async createReference(input: { suiteId: string; resourceId: string; targetType: "plan" | "task"; targetId: string; idempotencyKey: string; createdBy?: string | null }) {
    const resource = await this.getResource(input.resourceId);
    if (!resource) throw new Error("LIBRARY_RESOURCE_NOT_FOUND");
    assertReferenceAllowed(resource, input.suiteId, input.targetType);
    const existingId = this.idempotency.get(`${input.suiteId}:${input.idempotencyKey}`);
    if (existingId) return { reference: this.references.get(existingId)!, duplicate: true };
    const duplicate = [...this.references.values()].find((reference) => reference.suiteId === input.suiteId && reference.resourceId === input.resourceId && reference.targetType === input.targetType && reference.targetId === input.targetId && !reference.archivedAt);
    if (duplicate) { this.idempotency.set(`${input.suiteId}:${input.idempotencyKey}`, duplicate.id); return { reference: duplicate, duplicate: true }; }
    const now = new Date().toISOString();
    const reference: LibraryReference = { id: randomUUID(), suiteId: input.suiteId, resourceId: resource.id, resourceType: resource.resourceType, targetType: input.targetType, targetId: input.targetId, resourceVersionId: resource.resourceVersionId, snapshot: { ...resource, previewUrl: undefined }, createdAt: now, createdBy: input.createdBy ?? null, archivedAt: null };
    this.references.set(reference.id, reference); this.idempotency.set(`${input.suiteId}:${input.idempotencyKey}`, reference.id);
    return { reference, duplicate: false };
  }

  async listReferences(suiteId: string, targetType?: "plan" | "task", targetId?: string) {
    return [...this.references.values()].filter((reference) => reference.suiteId === suiteId && !reference.archivedAt && (!targetType || reference.targetType === targetType) && (!targetId || reference.targetId === targetId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async archiveReference(suiteId: string, referenceId: string) {
    const reference = this.references.get(referenceId);
    if (!reference || reference.suiteId !== suiteId) return null;
    const archived = { ...reference, archivedAt: new Date().toISOString() };
    this.references.set(reference.id, archived); return archived;
  }

  async createReverseReferenceAsset(input: { suiteId?: string | null; title: string; summary?: string; objectKey: string; mimeType: string; promptSnapshot: Record<string, unknown>; visualStructure?: Record<string, unknown>; source?: Record<string, unknown> }): Promise<LibraryResource> {
    const now = new Date().toISOString();
    const existing = [...this.resources.values()].find(
      (item) => item.resourceType === "reverse_reference_asset" && item.source.objectKey === input.objectKey,
    );
    const wasDeleted = existing ? this.deletedAt.has(existing.id) : false;
    const id = existing?.id ?? `reverse:${randomUUID()}`;
    const stage = input.source?.origin === "replica" ? "replica_prompt" : "task_image";
    const resource: LibraryResource = {
      id,
      resourceType: "reverse_reference_asset",
      title: input.title,
      summary: input.summary ?? "",
      mimeType: input.mimeType,
      previewUrl: `/api/library/resources/${id}/preview`,
      suiteId: input.suiteId ?? null,
      taskId: null,
      imageVersionId: null,
      baseVersionId: null,
      templateVersionId: typeof input.source?.templateVersionId === "string" ? input.source.templateVersionId : null,
      resourceVersionId: existing?.resourceVersionId ?? randomUUID(),
      stage,
      source: { objectKey: input.objectKey, ...(input.source ?? {}), visualStructure: input.visualStructure ?? {} },
      status: wasDeleted ? "draft" : (existing?.status ?? "draft"),
      promptSnapshot: input.promptSnapshot,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.resources.set(resource.id, resource);
    this.deletedAt.delete(resource.id);
    return resource;
  }

  async setResourceStatus(resourceId: string, status: LibraryAssetStatus) {
    if (this.deletedAt.has(resourceId)) return null;
    const resource = this.resources.get(resourceId); if (!resource) return null;
    const next = { ...resource, status, updatedAt: new Date().toISOString() }; this.resources.set(resourceId, next); return next;
  }
}
