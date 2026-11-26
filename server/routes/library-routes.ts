import type { LibraryResource, LibraryAssetStatus, LibraryResourceType } from "../types.js";
import { previewStorageObject } from "../http/binary-response.js";
import { decodeParam, type Router } from "../http/router.js";
import { fail } from "../api-errors.js";
import { ok, asRecord } from "../api-response.js";
import { PROMPT_STAGES, resolvePromptTemplateUsedBy, type PromptStage } from "../prompt-library.js";
import type { StudioServices } from "../services/studio-services.js";

const enrichLibraryResource = (resource: LibraryResource): LibraryResource => {
  if (resource.resourceType !== "prompt_template") return resource;
  const source = resource.source && typeof resource.source === "object" ? resource.source : {};
  const usedBy = Array.isArray(resource.usedBy)
    ? resource.usedBy
    : resolvePromptTemplateUsedBy({
      code: typeof source.code === "string" ? source.code : null,
      stage: resource.stage,
      applicability: source.applicability && typeof source.applicability === "object" ? (source.applicability as Record<string, unknown>) : null,
    });
  return { ...resource, usedBy, source: { ...source, usedBy } };
};

export function registerLibraryRoutes(router: Router, { deps }: StudioServices) {
  const previewLibraryResource = async (resourceId: string) => {
    if (!deps.libraryRepository) return fail("LIBRARY_REPOSITORY_NOT_CONFIGURED", 503);
    const decoded = decodeParam(resourceId);
    if (!decoded) return fail("LIBRARY_RESOURCE_NOT_FOUND", 404);
    const resource = await deps.libraryRepository.getResource(decoded, { includeDeleted: true });
    if (!resource) return fail("LIBRARY_RESOURCE_NOT_FOUND", 404);
    const target = await deps.libraryRepository.getPreviewObject(resource.id);
    return target ? previewStorageObject(deps.storage, target.objectKey) : fail("OBJECT_NOT_FOUND", 404);
  };

  router.get("/api/library/resources/:resourceId/preview", ({ params }) => previewLibraryResource(params.resourceId));

  router.post("/api/library/resources/batch-delete", async ({ body: requestBody }) => {
    if (!deps.libraryRepository) return fail("LIBRARY_REPOSITORY_NOT_CONFIGURED", 503);
    const body = asRecord(requestBody, { allowArrays: true });
    const rawIds = body.ids;
    if (!Array.isArray(rawIds) || rawIds.length === 0) return fail("INVALID_LIBRARY_BATCH_DELETE", 400);
    if (rawIds.length > 100) return fail("LIBRARY_BATCH_DELETE_LIMIT", 400);
    const ids: string[] = [];
    for (const item of rawIds) {
      if (typeof item !== "string" || !item.trim()) return fail("INVALID_LIBRARY_BATCH_DELETE", 400);
      ids.push(item.trim());
    }
    try {
      const result = await deps.libraryRepository.deleteResources(ids);
      if (result.deletedIds.length === 0 && result.alreadyDeletedIds.length === 0 && result.notFoundIds.length > 0) {
        return fail("LIBRARY_RESOURCE_NOT_FOUND", 404);
      }
      return ok(result);
    } catch (error) {
      if (error instanceof Error && error.message === "LIBRARY_RESOURCE_FORBIDDEN") {
        return fail("LIBRARY_RESOURCE_FORBIDDEN", 403, "提示词模板不支持在图片资源库中删除");
      }
      throw error;
    }
  });

  router.get("/api/library/resources/:resourceId", async ({ params }) => {
    if (!deps.libraryRepository) return fail("LIBRARY_REPOSITORY_NOT_CONFIGURED", 503);
    const resourceId = decodeParam(params.resourceId);
    if (!resourceId) return fail("LIBRARY_RESOURCE_NOT_FOUND", 404);
    const resource = await deps.libraryRepository.getResource(resourceId);
    return resource ? ok(enrichLibraryResource(resource)) : fail("LIBRARY_RESOURCE_NOT_FOUND", 404);
  });

  router.delete("/api/library/resources/:resourceId", async ({ params }) => {
    if (!deps.libraryRepository) return fail("LIBRARY_REPOSITORY_NOT_CONFIGURED", 503);
    const resourceId = decodeParam(params.resourceId);
    if (!resourceId) return fail("LIBRARY_RESOURCE_NOT_FOUND", 404);
    try {
      const deleted = await deps.libraryRepository.deleteResource(resourceId);
      return deleted ? ok(deleted) : fail("LIBRARY_RESOURCE_NOT_FOUND", 404);
    } catch (error) {
      if (error instanceof Error && error.message === "LIBRARY_RESOURCE_FORBIDDEN") {
        return fail("LIBRARY_RESOURCE_FORBIDDEN", 403, "提示词模板不支持在图片资源库中删除");
      }
      throw error;
    }
  });

  router.get(/^\/api\/library\/resources/, async ({ query }) => {
    if (!deps.libraryRepository) return fail("LIBRARY_REPOSITORY_NOT_CONFIGURED", 503);

    const resourceType = query.get("resourceType") as LibraryResourceType | null;
    const scopeParam = query.get("scope");
    if (scopeParam && scopeParam !== "image") return fail("INVALID_LIBRARY_SCOPE");
    const stage = query.get("stage") as PromptStage | null;
    if (stage && !PROMPT_STAGES.includes(stage)) return fail("INVALID_PROMPT_STAGE");
    const status = query.get("status") as LibraryAssetStatus | null;
    if (status && !["draft", "published", "archived", "retired"].includes(status)) return fail("INVALID_LIBRARY_STATUS");
    const rawPage = Number(query.get("page") ?? 1);
    const rawPageSize = Number(query.get("pageSize") ?? 24);
    const page = Number.isFinite(rawPage) ? Math.floor(rawPage) : 1;
    const pageSize = Number.isFinite(rawPageSize) ? Math.floor(rawPageSize) : 24;
    const listed = await deps.libraryRepository.listResources({ resourceType: resourceType ?? undefined, scope: scopeParam === "image" ? "image" : undefined, stage: stage ?? undefined, suiteId: query.get("suiteId") ?? undefined, query: query.get("query") ?? undefined, status: status ?? undefined, page, pageSize });
    return ok({ ...listed, items: listed.items.map(enrichLibraryResource) });
  });

  router.post("/api/library/resources/:resourceId/status", async ({ params, body: requestBody }) => {
    if (!deps.libraryRepository) return fail("LIBRARY_REPOSITORY_NOT_CONFIGURED", 503);
    const resourceId = decodeParam(params.resourceId);
    if (!resourceId) return fail("LIBRARY_RESOURCE_NOT_FOUND", 404);
    const body = asRecord(requestBody, { allowArrays: true });
    const status = body.status as LibraryAssetStatus;
    if (!["draft", "published", "archived"].includes(status)) return fail("INVALID_LIBRARY_STATUS");
    const resource = await deps.libraryRepository.setResourceStatus(resourceId, status);
    return resource ? ok(resource) : fail("LIBRARY_RESOURCE_NOT_FOUND", 404);
  });

  router.post("/api/library/reverse-reference-assets", async ({ body: requestBody }) => {
    if (!deps.libraryRepository) return fail("LIBRARY_REPOSITORY_NOT_CONFIGURED", 503);
    const body = asRecord(requestBody, { allowArrays: true });
    if (typeof body.title !== "string" || typeof body.objectKey !== "string" || typeof body.mimeType !== "string" || !body.promptSnapshot || typeof body.promptSnapshot !== "object") return fail("INVALID_REVERSE_REFERENCE_ASSET");
    const asset = await deps.libraryRepository.createReverseReferenceAsset({ suiteId: typeof body.suiteId === "string" ? body.suiteId : null, title: body.title, summary: typeof body.summary === "string" ? body.summary : "", objectKey: body.objectKey, mimeType: body.mimeType, promptSnapshot: body.promptSnapshot as Record<string, unknown>, visualStructure: body.visualStructure && typeof body.visualStructure === "object" ? body.visualStructure as Record<string, unknown> : {}, source: body.source && typeof body.source === "object" ? body.source as Record<string, unknown> : {} });
    return ok(asset, 201);
  });

  router.get(/^\/api\/suites\/(?<suiteId>[^/]+)\/library\/references(?:\/[^/]+)?$/, async ({ params, query }) => {
    if (!deps.libraryRepository) return fail("LIBRARY_REPOSITORY_NOT_CONFIGURED", 503);
    const suiteId = decodeParam(params.suiteId);
    if (!suiteId) return fail("INVALID_SUITE_ID", 404);

    return ok(await deps.libraryRepository.listReferences(suiteId, (query.get("targetType") as "plan" | "task" | null) ?? undefined, query.get("targetId") ?? undefined));
  });

  router.post("/api/suites/:suiteId/library/references", async ({ params, idempotencyKey, body: requestBody }) => {
    if (!deps.libraryRepository) return fail("LIBRARY_REPOSITORY_NOT_CONFIGURED", 503);
    if (!idempotencyKey) return fail("MISSING_IDEMPOTENCY_KEY");
    const suiteId = decodeParam(params.suiteId);
    if (!suiteId) return fail("INVALID_SUITE_ID", 404);
    const body = asRecord(requestBody, { allowArrays: true });
    if (typeof body.resourceId !== "string" || (body.targetType !== "plan" && body.targetType !== "task") || typeof body.targetId !== "string") return fail("LIBRARY_RESOURCE_NOT_FOUND");
    try { const result = await deps.libraryRepository.createReference({ suiteId, resourceId: body.resourceId, targetType: body.targetType, targetId: body.targetId, idempotencyKey, createdBy: typeof body.createdBy === "string" ? body.createdBy : null }); return ok(result.reference, result.duplicate ? 200 : 201); }
    catch (error) { const code = error instanceof Error ? error.message : "LIBRARY_RESOURCE_NOT_FOUND"; return fail(code, code === "LIBRARY_RESOURCE_FORBIDDEN" || code === "LIBRARY_TARGET_NOT_FOUND" ? 403 : code === "LIBRARY_RESOURCE_NOT_FOUND" ? 404 : 409); }
  });

  router.delete("/api/suites/:suiteId/library/references/:referenceId", async ({ params }) => {
    if (!deps.libraryRepository) return fail("LIBRARY_REPOSITORY_NOT_CONFIGURED", 503);
    const suiteId = decodeParam(params.suiteId);
    const referenceId = decodeParam(params.referenceId);
    if (!suiteId || !referenceId) return fail("LIBRARY_RESOURCE_NOT_FOUND", 404);
    const archived = await deps.libraryRepository.archiveReference(suiteId, referenceId);
    return archived ? ok(archived) : fail("LIBRARY_RESOURCE_NOT_FOUND", 404);
  });

  return { previewLibraryResource };
}
