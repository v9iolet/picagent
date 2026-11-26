import { fail } from "../api-errors.js";
import { ok, asRecord, type AppResponse } from "../api-response.js";
import { randomUUID } from "node:crypto";
import type { ReverseReference, ReversePromptVersion } from "../types.js";
import type { Router } from "../http/router.js";
import type { StudioServices } from "../services/studio-services.js";

export function registerReverseRoutes(router: Router, { deps, reverseRepository }: StudioServices) {
  const previewReverseReference = async (
    planId: string, referenceId: string, kind: "original" | "thumbnail" = "thumbnail",
  ): Promise<AppResponse> => {
    const plan = await reverseRepository.getPlan(planId);
    const ref = plan?.references.find((item) => item.id === referenceId);
    if (!ref) return fail("REVERSE_REFERENCE_NOT_FOUND", 404);
    const object = await deps.storage.get(kind === "original" ? ref.objectKey : ref.thumbnailObjectKey);
    if (!object) return fail("OBJECT_NOT_FOUND", 404);
    return { ...ok({ contentType: object.contentType }), headers: { "content-type": object.contentType }, raw: object.bytes };
  };

  const readOnly = () => fail("REVERSE_PLAN_READ_ONLY", 410);
  router.post("/api/reverse-plans", readOnly);
  router.patch("/api/reverse-plans/:planId", readOnly);
  router.post("/api/reverse-plans/:planId/references", readOnly);
  router.patch("/api/reverse-plans/:planId/references/:referenceId", readOnly);
  router.delete("/api/reverse-plans/:planId/references/:referenceId", readOnly);
  router.post(/^\/api\/reverse-plans\/[^/]+\/references\/[^/]+\/(?:run|retry)$/, readOnly);
  router.post("/api/reverse-plans/:planId/attempts", readOnly);
  router.patch("/api/reverse-plans/:planId/references/:referenceId/prompt", readOnly);

  router.get("/api/reverse-plans", async () => ok(await reverseRepository.listPlans()));

  router.get("/api/reverse-plans/:planId", async ({ params }) => {
    const plan = await reverseRepository.getPlan(params.planId);
    return plan ? ok(plan) : fail("INVALID_REVERSE_PLAN", 404);
  });

  router.get("/api/reverse-plans/:planId/attempts/:attemptId", async ({ params }) => {
    const plan = await reverseRepository.getPlan(params.planId);
    if (!plan) return fail("INVALID_REVERSE_PLAN", 404);
    const found = plan.references.flatMap((item) => item.attempts).find((item) => item.id === params.attemptId);
    return found ? ok(found) : fail("REVERSE_REFERENCE_NOT_FOUND", 404);
  });

  router.post("/api/reverse-plans/:planId/references/:referenceId/asset", async ({ params }) => {
    if (!deps.libraryRepository) return fail("LIBRARY_REPOSITORY_NOT_CONFIGURED", 503);
    const plan = await reverseRepository.getPlan(params.planId);
    if (!plan) return fail("INVALID_REVERSE_PLAN", 404);
    const ref = plan.references.find((item) => item.id === params.referenceId);
    if (!ref) return fail("REVERSE_REFERENCE_NOT_FOUND", 404);
    const prompt = ref.promptVersions.find((item) => item.id === ref.effectivePromptVersionId);
    if (!prompt) return fail("REVERSE_OUTPUT_INVALID");
    const result = await deps.libraryRepository.createReverseReferenceAsset({ title: ref.filename, summary: `${plan.mode === "main" ? "主图" : "详情图"}反推资产，不作为商品事实`, objectKey: ref.objectKey, mimeType: ref.mimeType, promptSnapshot: { prompt: prompt.prompt, promptVersionId: prompt.id }, visualStructure: { mode: plan.mode }, source: { reversePlanId: plan.id, referenceId: ref.id, sha256: ref.sha256, templateVersionId: prompt.templateVersionId, provider: prompt.provider } });
    return ok(result, 201);
  });

  router.post("/api/reverse-plans/:planId/canvas-imports", async ({ params, idempotencyKey, body: requestBody }) => {
    if (!idempotencyKey) return fail("MISSING_IDEMPOTENCY_KEY");
    if (!deps.taskRepository) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);
    const plan = await reverseRepository.getPlan(params.planId);
    if (!plan) return fail("INVALID_REVERSE_PLAN", 404);
    const items = plan.references.map((reference) => ({ reference, prompt: reference.promptVersions.find((version) => version.id === reference.effectivePromptVersionId) })).filter((item): item is { reference: ReverseReference; prompt: ReversePromptVersion } => Boolean(item.prompt && item.reference.attempts.some((attempt) => attempt.status === "succeeded")));
    if (!items.length) return fail("REVERSE_CANVAS_NO_RESULTS", 409);
    const body = asRecord(requestBody, { allowArrays: true });
    let suite = typeof body.targetSuiteId === "string" ? await deps.repository.getSuite(body.targetSuiteId) : null;
    if (typeof body.targetSuiteId === "string" && !suite) return fail("INVALID_SUITE_ID", 404);
    if (suite?.origin === "replica" || suite?.origin === "aplus") {
      const label = suite.origin === "aplus" ? "A+详情批次" : "复刻批次";
      return fail("INVALID_SUITE_ORIGIN", 400, `${label}不支持导入画布任务`);
    }
    if (!suite) suite = await deps.repository.createSuite(typeof body.name === "string" && body.name.trim() ? body.name.trim() : `爆品图反推 ${new Date().toISOString().slice(0, 10)}`, `${idempotencyKey}:suite`, "canvas");
    const taskGroupId = typeof body.taskGroupId === "string" ? body.taskGroupId : randomUUID();
    const result = await deps.taskRepository.createReverseTasks({ suiteId: suite.id, reversePlanId: plan.id, taskGroupId, mode: plan.mode, idempotencyKey, items: items.map(({ reference, prompt }) => ({ referenceId: reference.id, ordinal: reference.ordinal, filename: reference.filename, promptVersionId: prompt.id, prompt: prompt.prompt })) });
    return ok({ suiteId: suite.id, taskGroupId: result.created[0]?.reverseTaskGroupId ?? taskGroupId, taskIds: result.created.map((task) => task.id), duplicate: result.duplicate }, result.duplicate ? 200 : 201);
  });

  router.get(/^\/api\/reverse-plans\/(?<planId>[^/]+)\/references\/(?<referenceId>[^/]+)\/preview(?:\/(?<kind>original|thumbnail))?$/, ({ params }) => previewReverseReference(params.planId, params.referenceId, params.kind === "original" ? "original" : "thumbnail"));

  return { previewReverseReference };
}
