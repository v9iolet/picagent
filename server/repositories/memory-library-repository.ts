import { assertReferenceAllowed } from "../library-reference-policy.js";
import { randomUUID } from "node:crypto";
import type {
  LibraryAssetStatus,
  LibraryReference,
  LibraryRepository,
  LibraryResource,
  LibraryResourceBatchDeleteResult,
  LibraryResourceDeletionResult,
  LibraryResourceQuery,
} from "../types.js";

export class MemoryLibraryRepository implements LibraryRepository {
  private readonly resources = new Map<string, LibraryResource>();
  private readonly references = new Map<string, LibraryReference>();
  private readonly idempotency = new Map<string, string>();
  private readonly deletedAt = new Map<string, string>();

  addResource(resource: LibraryResource): LibraryResource {
    this.resources.set(resource.id, resource);
    this.deletedAt.delete(resource.id);
    return resource;
  }

  async listResources(query: LibraryResourceQuery) {
    const page = Math.max(1, query.page ?? 1); const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 24));
    const needle = query.query?.trim().toLocaleLowerCase();
    const filtered = [...this.resources.values()].filter((resource) =>
      !this.deletedAt.has(resource.id)
      && (query.scope !== "image" || resource.resourceType !== "prompt_template")
      && (!query.resourceType || resource.resourceType === query.resourceType)
      && (!query.stage || resource.stage === query.stage)
      && (!query.suiteId || resource.suiteId === query.suiteId || resource.suiteId === null)
      && (!query.status || resource.status === query.status)
      && (!needle || `${resource.title} ${resource.summary}`.toLocaleLowerCase().includes(needle)),
    ).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { items: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length, page, pageSize };
  }

  async getResource(resourceId: string, options?: { includeDeleted?: boolean }) {
    if (!options?.includeDeleted && this.deletedAt.has(resourceId)) return null;
    return this.resources.get(resourceId) ?? null;
  }

  async getPreviewObject(resourceId: string) {
    const resource = this.resources.get(resourceId);
    const objectKey = typeof resource?.source.objectKey === "string" ? resource.source.objectKey : null;
    return objectKey ? { objectKey } : null;
  }

  async deleteResource(resourceId: string): Promise<LibraryResourceDeletionResult | null> {
    const resource = this.resources.get(resourceId);
    if (!resource) return null;
    if (resource.resourceType === "prompt_template") throw new Error("LIBRARY_RESOURCE_FORBIDDEN");
    const existing = this.deletedAt.get(resourceId);
    if (existing) return { id: resourceId, deletedAt: existing, alreadyDeleted: true };
    const now = new Date().toISOString();
    this.deletedAt.set(resourceId, now);
    return { id: resourceId, deletedAt: now, alreadyDeleted: false };
  }

  async deleteResources(resourceIds: string[]): Promise<LibraryResourceBatchDeleteResult> {
    const uniqueIds = [...new Set(resourceIds)];
    for (const id of uniqueIds) {
      const resource = this.resources.get(id);
      if (resource?.resourceType === "prompt_template") throw new Error("LIBRARY_RESOURCE_FORBIDDEN");
    }
    const deletedIds: string[] = [];
    const alreadyDeletedIds: string[] = [];
    const notFoundIds: string[] = [];
    const now = new Date().toISOString();
    for (const id of uniqueIds) {
      const resource = this.resources.get(id);
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
