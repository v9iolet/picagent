import { previewStorageObject } from "../http/binary-response.js";
import { hasValidUuids } from "../http/validators.js";
import {
  planSnapshotView,
  taskView,
  taskAttemptView,
  taskSlotView,
  taskVersionView,
  taskBatchView,
  resolvePlanStyleGuide,
} from "../suite-views.js";
import { fail } from "../api-errors.js";
import { ok, asRecord } from "../api-response.js";
import { isProductImageResource, isStoredProductImageReference } from "../library-reference-policy.js";
import { createHash, randomUUID } from "node:crypto";
import { materializeCategoryPlanItems } from "../suite-task-prompt.js";
import { ADDITIONAL_PROMPT_MAX_LENGTH } from "../../shared/workbench-delivery.js";
import type { PlanSnapshot, TaskRepository, SuiteTask } from "../types.js";
import type { Router } from "../http/router.js";
import type { StudioServices } from "../services/studio-services.js";
import { samePlanItems } from "../services/structure-plan.js";

export function registerTaskRoutes(router: Router, {
  deps,
  loadSuiteImageEditChildren,
  createTaskBatch,
  resolveCategorySourceSnapshot,
  listCategoryRequestsForSnapshot,
  appendMaterializedSnapshot,
}: StudioServices) {
  const previewTaskVersion = async (taskId: string, versionId: string, delivery = false) => {
    if (!hasValidUuids(taskId, versionId)) return fail("INVALID_TASK_VERSION", 404);
    if (!deps.taskRepository) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);
    const history = await deps.taskRepository.listTaskVersions(taskId);
    const version = history.versions.find((item) => item.id === versionId);
    const objectKey = delivery ? version?.deliveryObjectKey : version?.objectKey;
    return objectKey ? previewStorageObject(deps.storage, objectKey) : fail("INVALID_TASK_VERSION", 404);
  };

  router.get("/api/suites/:suiteId/workbench", async ({ params }) => {
    if (!deps.taskRepository) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);
    const suite = await deps.repository.getSuite(params.suiteId);
    if (!suite) return fail("INVALID_SUITE_ID", 404);
    const [inputImages, snapshot, tasks, batches, slots] = await Promise.all([
      deps.repository.getInputImages(suite.id),
      deps.planRepository?.getLatestSnapshot(suite.id) ?? Promise.resolve(null),
      deps.taskRepository.listTasks(suite.id),
      deps.taskRepository.listBatches(suite.id),
      deps.taskRepository.listSlots(suite.id),
    ]);
    const taskAggregates = await Promise.all(tasks.map(async (task) => {
      const history = await deps.taskRepository!.listTaskVersions(task.id);
      return { ...taskView(task), versions: history.versions.map(taskVersionView), attempts: history.attempts.map(taskAttemptView), slots: slots.filter((slot) => slot.taskId === task.id).map(taskSlotView) };
    }));
    const imageEditChildren = await loadSuiteImageEditChildren(tasks);
    const layout = await deps.taskRepository.getLayout(suite.id);
    const planStyleGuide = resolvePlanStyleGuide(snapshot);
    return ok({
      suite,
      inputImages,
      planSnapshot: snapshot ? planSnapshotView(snapshot) : null,
      tasks: taskAggregates,
      batches: batches.map(taskBatchView),
      imageEditChildren,
      layout,
      planStyleGuide,
      styleOverride: suite.styleOverride ?? null,
      effectiveStyleGuide: suite.styleOverride?.trim() || planStyleGuide,
    });
  });

  router.post("/api/suites/:suiteId/tasks/custom", async ({ params, idempotencyKey, body: requestBody }) => {
    if (!deps.taskRepository?.createCustomTask) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);
    const suite = await deps.repository.getSuite(params.suiteId);
    if (!suite) return fail("INVALID_SUITE_ID", 404);
    const body = asRecord(requestBody, { allowArrays: true });
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const promptDraft = typeof body.promptDraft === "string" ? body.promptDraft.trim() : "";
    const imageType = body.imageType === "main" ? "main" : "detail";
    const purpose = typeof body.purpose === "string" && body.purpose.trim() ? body.purpose.trim() : (imageType === "main" ? "自由补充主图" : "自由补充详情图");
    if (!title || !promptDraft) return fail("CUSTOM_TASK_FIELDS_REQUIRED", 400);
    const [snapshot, inputImages] = await Promise.all([
      deps.planRepository?.getLatestSnapshot(suite.id) ?? Promise.resolve(null),
      deps.repository.getInputImages(suite.id),
    ]);
    const sourceInputImageId = body.sourceInputImageId === null ? null : typeof body.sourceInputImageId === "string" && inputImages.some((img) => img.id === body.sourceInputImageId)
      ? body.sourceInputImageId
      : (inputImages[0]?.id ?? null);
    const generationParams = body.generationParams && typeof body.generationParams === "object" && !Array.isArray(body.generationParams)
      ? body.generationParams as Record<string, unknown>
      : { ratio: imageType === "main" ? "1:1" : "3:4", size: "1K", quality: "medium" };
    const result = await deps.taskRepository.createCustomTask({
      suiteId: suite.id,
      planSnapshotId: snapshot?.id ?? null,
      imageType,
      title,
      purpose,
      promptDraft,
      sourceInputImageId,
      generationParams,
      idempotencyKey,
    });
    return ok(result.task, result.duplicate ? 200 : 201);
  });

  router.post("/api/suites/:suiteId/tasks/batch-params", async ({ params, body: requestBody }) => {
    if (!deps.taskRepository) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);
    const suite = await deps.repository.getSuite(params.suiteId);
    if (!suite) return fail("INVALID_SUITE_ID", 404);
    const body = asRecord(requestBody, { allowArrays: true });
    const patch = body.generationParams && typeof body.generationParams === "object" && !Array.isArray(body.generationParams)
      ? body.generationParams as Record<string, unknown>
      : null;
    if (!patch || !Object.keys(patch).length) return fail("INVALID_EXPORT_OPTIONS", 400);
    const scope = body.imageType === "main" || body.imageType === "detail" ? body.imageType : "all";
    const explicitIds = Array.isArray(body.taskIds) ? new Set(body.taskIds.filter((id): id is string => typeof id === "string")) : null;
    const tasks = (await deps.taskRepository.listTasks(suite.id)).filter((task) => {
      if (task.status === "archived") return false;
      if (explicitIds) return explicitIds.has(task.id);
      return scope === "all" ? true : task.imageType === scope;
    });
    const updated: SuiteTask[] = [];
    for (const task of tasks) {
      const next = await deps.taskRepository.updateTask(task.id, { generationParams: { ...task.generationParams, ...patch } });
      if (next) updated.push(next);
    }
    return ok({ updatedCount: updated.length, tasks: updated });
  });

  router.post("/api/suites/:suiteId/tasks", async ({ params, body: requestBody }) => {
    if (!deps.taskRepository || !deps.planRepository) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);
    const suite = await deps.repository.getSuite(params.suiteId);
    if (!suite) return fail("INVALID_SUITE_ID", 404);
    const body = asRecord(requestBody, { allowArrays: true });
    const snapshotId = typeof body.planSnapshotId === "string" ? body.planSnapshotId : undefined;
    let snapshot = snapshotId ? await deps.planRepository.getSnapshot(snapshotId) : await deps.planRepository.getLatestSnapshot(suite.id);
    if (!snapshot || snapshot.suiteId !== suite.id) return fail("INVALID_PLAN_SNAPSHOT", 409);
    if (snapshot.phase === "structure_plan" && snapshot.confirmationStatus === "confirmed") {
      const requests = await listCategoryRequestsForSnapshot(snapshot);
      const items = materializeCategoryPlanItems(snapshot, requests);
      if (!items) return fail("CATEGORY_PROMPTS_NOT_READY", 409);
      if (!samePlanItems(snapshot.items, items)) {
        const sourceSnapshot = await resolveCategorySourceSnapshot(snapshot);
        const next: PlanSnapshot = { ...snapshot, id: randomUUID(), revisionNumber: snapshot.revisionNumber + 1, revisionKind: "human", parentSnapshotId: snapshot.id, items, categoryOutputs: Object.fromEntries(requests.map((request) => [request.categoryCode, { status: request.status, requestedCount: request.requestedCount, items: request.items as unknown as Record<string, unknown>[], errorCode: request.errorCode, errorMessage: request.errorMessage }])), requestSummary: { ...snapshot.requestSummary, phase: "task_materialization", sourceSnapshotId: sourceSnapshot.id }, createdAt: new Date().toISOString() };
        snapshot = await appendMaterializedSnapshot(next, items);
      }
    }
    if (!snapshot.items.length) return fail("INVALID_PLAN_SNAPSHOT", 409);
    const result = await deps.taskRepository.createTasksFromSnapshot(suite.id, snapshot, await deps.repository.getInputImages(suite.id));
    return ok({ planSnapshotId: snapshot.id, tasks: result.tasks, createdTaskIds: result.created.map((task) => task.id) }, result.created.length ? 201 : 200);
  });

  router.patch("/api/suite-tasks/:taskId", async ({ params, body: requestBody }) => {
    if (!deps.taskRepository) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);
    const body = asRecord(requestBody, { allowArrays: true });
    const patch: Parameters<TaskRepository["updateTask"]>[1] = {};
    for (const key of ["title", "purpose", "promptDraft"] as const) if (typeof body[key] === "string") patch[key] = body[key];
    if (typeof body.status === "string") patch.status = body.status as SuiteTask["status"];
    if (body.generationParams && typeof body.generationParams === "object" && !Array.isArray(body.generationParams)) patch.generationParams = body.generationParams as Record<string, unknown>;
    if (typeof body.sourceInputImageId === "string") {
      const current = await deps.taskRepository.getTask(params.taskId);
      if (!current) return fail("INVALID_SUITE_TASK", 404);
      const images = await deps.repository.getInputImages(current.suiteId);
      if (!images.some((image) => image.id === body.sourceInputImageId) || current.status === "generating" || current.status === "archived") return fail("TASK_INVALID_SOURCE", 409);
      patch.sourceInputImageId = body.sourceInputImageId;
      if (current.sourceInputImageId !== patch.sourceInputImageId || current.sourceLibraryReferenceId) {
        patch.sourceRevision = (current.sourceRevision ?? 0) + 1;
        patch.sourceLibraryReferenceId = null;
        patch.sourceResourceVersionId = null;
        const params = { ...current.generationParams, ...patch.generationParams };
        delete params.productMaterialRefs;
        patch.generationParams = params;
      }
      if (current.status === "incomplete" || current.status === "failed") patch.status = "pending";
    }
    const task = await deps.taskRepository.updateTask(params.taskId, patch);
    return task ? ok(task) : fail("INVALID_SUITE_TASK", 404);
  });

  router.post("/api/suite-tasks/:taskId/white-resource", async ({ params, idempotencyKey, body: requestBody }) => {
    if (!idempotencyKey) return fail("MISSING_IDEMPOTENCY_KEY");
    if (!deps.taskRepository || !deps.libraryRepository) return fail("LIBRARY_REPOSITORY_NOT_CONFIGURED", 503);
    const task = await deps.taskRepository.getTask(params.taskId); if (!task) return fail("INVALID_SUITE_TASK", 404);
    if (task.status === "generating" || task.status === "archived") return fail("TASK_INVALID_SOURCE", 409);
    const body = asRecord(requestBody, { allowArrays: true });
    const resourceIds = Array.isArray(body.resourceIds) ? body.resourceIds.filter((item): item is string => typeof item === "string") : typeof body.resourceId === "string" ? [body.resourceId] : [];
    if (!resourceIds.length) return fail("LIBRARY_RESOURCE_NOT_FOUND", 404);
    if (resourceIds.length > 3) return fail("REVERSE_WHITE_RESOURCE_LIMIT", 409);
    const resources = await Promise.all(resourceIds.map((id) => deps.libraryRepository!.getResource(id)));
    if (resources.some((resource) => !resource)) return fail("LIBRARY_RESOURCE_NOT_FOUND", 404);
    if (resources.some((resource) => !isProductImageResource(resource!) || resource!.status !== "published")) return fail("LIBRARY_RESOURCE_FORBIDDEN", 403);
    try {
      const existing = await deps.libraryRepository.listReferences(task.suiteId, "task", task.id);
      const references = [];
      for (const [index, resource] of resources.entries()) {
        const result = await deps.libraryRepository.createReference({ suiteId: task.suiteId, resourceId: resource!.id, targetType: "task", targetId: task.id, idempotencyKey: `${idempotencyKey}:${resource!.id}` });
        references.push(result.reference);
        const source = result.reference.snapshot.source as Record<string, unknown> | undefined;
        if (typeof source?.objectKey !== "string") throw new Error("LIBRARY_RESOURCE_NOT_FOUND");
        (result.reference as typeof result.reference & { order?: number }).order = index + 1;
      }
      for (const stale of existing.filter((reference) => isStoredProductImageReference(reference) && !resourceIds.includes(reference.resourceId))) await deps.libraryRepository.archiveReference(task.suiteId, stale.id);
      const productMaterialRefs = references.map((reference, index) => ({ libraryReferenceId: reference.id, resourceId: reference.resourceId, resourceVersionId: reference.resourceVersionId, order: index + 1, title: String(reference.snapshot.title ?? "商品参考图"), previewUrl: typeof reference.snapshot.previewUrl === "string" ? reference.snapshot.previewUrl : `/api/library/resources/${encodeURIComponent(reference.resourceId)}/preview` }));
      const first = references[0];
      const updated = await deps.taskRepository.updateTask(task.id, { sourceInputImageId: null, sourceLibraryReferenceId: first.id, sourceResourceVersionId: first.resourceVersionId, sourceRevision: (task.sourceRevision ?? 0) + 1, generationParams: { ...task.generationParams, productMaterialRefs }, status: "pending" });
      const duplicate = references.every((reference) => existing.some((item) => item.id === reference.id));
      return ok({ task: updated, references, reference: first, duplicate }, duplicate ? 200 : 201);
    } catch (error) { const code = error instanceof Error ? error.message : "LIBRARY_RESOURCE_FORBIDDEN"; return fail(code, code === "LIBRARY_RESOURCE_NOT_FOUND" ? 404 : 403); }
  });

  router.get("/api/suites/:suiteId/workbench/layout", async ({ params }) => {
    if (!deps.taskRepository) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);
    return ok(await deps.taskRepository.getLayout(params.suiteId));
  });

  router.patch("/api/suites/:suiteId/workbench/layout", async ({ params, body: requestBody }) => {
    if (!deps.taskRepository) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);
    const body = asRecord(requestBody, { allowArrays: true });
    const expectedVersion = Number(body.layoutVersion ?? 0);
    const viewport = body.viewport && typeof body.viewport === "object" ? body.viewport as { x: number; y: number; zoom: number } : { x: 0, y: 0, zoom: 1 };
    const nodes = Array.isArray(body.nodes) ? body.nodes : [];
    const groups = Array.isArray(body.groups) ? body.groups : [];
    try { return ok(await deps.taskRepository.saveLayout(params.suiteId, expectedVersion, { viewport, nodes: nodes as never, groups: groups as never })); }
    catch (error) { return fail(error instanceof Error && error.message === "LAYOUT_VERSION_CONFLICT" ? "LAYOUT_VERSION_CONFLICT" : "GENERATION_PERSIST_FAILED", error instanceof Error && error.message === "LAYOUT_VERSION_CONFLICT" ? 409 : 500); }
  });

  router.post("/api/suites/:suiteId/generation", async ({ params, idempotencyKey, body: requestBody }) => {
    if (!idempotencyKey) return fail("MISSING_IDEMPOTENCY_KEY");
    if (!deps.taskRepository) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);
    const allTasks = await deps.taskRepository.listTasks(params.suiteId);
    const body = asRecord(requestBody, { allowArrays: true });
    const requested = Array.isArray(body.taskIds) ? body.taskIds.filter((id): id is string => typeof id === "string") : allTasks.filter((task) => task.status !== "archived").map((task) => task.id);
    const tasks = allTasks.filter((task) => requested.includes(task.id) && task.status !== "archived");
    if (!tasks.length) return fail("NO_TASKS_TO_GENERATE", 409);
    try { const result = await createTaskBatch(params.suiteId, tasks, "batch", idempotencyKey); return ok({ batchId: result.batch.id, status: result.batch.status, requestedCount: result.batch.requestedCount }, result.duplicate ? 200 : 202); }
    catch (error) { return fail(error instanceof Error ? error.message : "TASK_INVALID_SOURCE", 409); }
  });

  router.post("/api/suite-tasks/:taskId/generation", async ({ params, idempotencyKey, body: requestBody }) => {
    if (!idempotencyKey) return fail("MISSING_IDEMPOTENCY_KEY");
    if (!deps.taskRepository) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);
    const task = await deps.taskRepository.getTask(params.taskId);
    if (!task || task.status === "archived") return fail("INVALID_SUITE_TASK", 404);
    const body = asRecord(requestBody, { allowArrays: true });
    const rawAdditionalPrompt = body.additionalPrompt;
    if (rawAdditionalPrompt !== undefined &&
      (typeof rawAdditionalPrompt !== "string" || rawAdditionalPrompt.length > ADDITIONAL_PROMPT_MAX_LENGTH)) {
      return fail("APLUS_INVALID_ADDITIONAL_PROMPT", 400);
    }
    const additionalPrompt = typeof rawAdditionalPrompt === "string" ? rawAdditionalPrompt.trim() : "";
    const promptSuffix = additionalPrompt ? `\n\n单卡人工补充：${additionalPrompt}` : "";
    if (typeof body.editSourceVersionId === "string") {
      try {
        const { versions } = await deps.taskRepository.listTaskVersions(task.id);
        const version = versions.find((item) => item.id === body.editSourceVersionId);
        if (!version) return fail("TASK_CURRENT_VERSION_NOT_FOUND", 409);
        const result = await createTaskBatch(task.suiteId, [task], "single", idempotencyKey, undefined, {}, { version, versions, promptSuffix });
        return ok({ batchId: result.batch.id, status: result.batch.status }, result.duplicate ? 200 : 202);
      } catch (error) { return fail(error instanceof Error ? error.message : "TASK_INVALID_SOURCE", 409); }
    }
    const singleTaskPrompt = typeof body.promptDraft === "string" ? body.promptDraft : undefined;
    const prompt = (singleTaskPrompt ?? task.promptDraft) + promptSuffix;
    const generationTask = prompt === task.promptDraft ? task
      : { ...task, promptDraft: prompt, promptSha256: createHash("sha256").update(prompt).digest("hex") };
    try {
      const history = await deps.taskRepository.listTaskVersions(task.id);
      const currentVersion = history.versions.find((version) => version.isCurrent);
      const currentAttempt = history.attempts.find((attempt) => attempt.id === currentVersion?.attemptId);
      const sourceUnchanged = (currentAttempt?.contextSnapshot.sourceRevision ?? 0) === (task.sourceRevision ?? 0);
      const useCurrentVersionAsSource = task.originKind !== "replica" && task.originKind !== "aplus" && currentVersion && sourceUnchanged;
      const result = await createTaskBatch(task.suiteId, [generationTask], "single", idempotencyKey, undefined, useCurrentVersionAsSource ? { [task.id]: currentVersion.id } : {}, undefined, singleTaskPrompt);
      return ok({ batchId: result.batch.id, status: result.batch.status }, result.duplicate ? 200 : 202);
    }
    catch (error) { return fail(error instanceof Error ? error.message : "TASK_INVALID_SOURCE", 409); }
  });

  router.post("/api/generation-attempts/:attemptId/retry", async ({ params, idempotencyKey }) => {
    if (!idempotencyKey) return fail("MISSING_IDEMPOTENCY_KEY");
    if (!deps.taskRepository) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);
    const failed = await deps.taskRepository.getAttempt(params.attemptId);
    if (!failed || failed.status !== "failed") return fail("INVALID_TASK_ATTEMPT", 409);
    const slot = await deps.taskRepository.getSlot(failed.slotId); if (!slot) return fail("INVALID_TASK_BATCH", 404);
    const task = await deps.taskRepository.getTask(slot.taskId); if (!task) return fail("INVALID_SUITE_TASK", 404);
    try { const result = await createTaskBatch(task.suiteId, [task], "retry", idempotencyKey, failed); return ok({ batchId: result.batch.id, status: result.batch.status }, result.duplicate ? 200 : 202); }
    catch (error) { return fail(error instanceof Error ? error.message : "TASK_INVALID_SOURCE", 409); }
  });

  router.get("/api/generation-batches/:batchId", async ({ params }) => {
    if (!deps.taskRepository) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);
    const batch = await deps.taskRepository.getBatch(params.batchId);
    if (!batch) return fail("INVALID_TASK_BATCH", 404);
    const slots = (await deps.taskRepository.listSlots(batch.suiteId)).filter((slot) => slot.batchId === batch.id);
    const attempts = await Promise.all(slots.map(async (slot) => deps.taskRepository!.getAttempt((await deps.taskRepository!.listTaskVersions(slot.taskId)).attempts.find((attempt) => attempt.slotId === slot.id)?.id ?? ""))).then((items) => items.filter(Boolean));
    return ok({ batch, slots, attempts });
  });

  router.get("/api/suite-tasks/:taskId/versions", async ({ params }) => {
    if (!deps.taskRepository) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);
    const task = await deps.taskRepository.getTask(params.taskId); if (!task) return fail("INVALID_SUITE_TASK", 404);
    return ok(await deps.taskRepository.listTaskVersions(task.id));
  });

  router.post("/api/suite-tasks/:taskId/versions/:versionId/select", async ({ params, body: requestBody }) => {
    if (!deps.taskRepository) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);
    const selection = asRecord(requestBody, { allowArrays: true }).selection === "final" ? "final" : "current";
    const version = await deps.taskRepository.selectVersion(params.taskId, params.versionId, selection);
    if (version && selection === "final" && deps.libraryRepository) {
      await deps.libraryRepository.restoreResource(`task-version:${version.id}`);
    }
    return version ? ok(version) : fail("INVALID_TASK_VERSION", 404);
  });

  router.get(/^\/api\/suite-tasks\/(?<taskId>[^/]+)\/versions\/(?<versionId>[^/]+)\/preview(?<delivery>\/delivery)?$/, ({ params }) => previewTaskVersion(params.taskId, params.versionId, Boolean(params.delivery)));

  return { previewTaskVersion };
}
