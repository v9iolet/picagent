import { planSnapshotView, isStructurePlanV2 } from "../suite-views.js";
import { fail, errorMessages } from "../api-errors.js";
import { ok, asRecord } from "../api-response.js";
import { SUITE_IMAGE_LIMITS } from "../../shared/suite-categories.js";
import { randomUUID } from "node:crypto";
import { validateDynamicInput } from "../prompt-library.js";
import { materializeCategoryPlanItems } from "../suite-task-prompt.js";
import type { CategoryPromptLlmInput, CategoryPromptRequest, PlanAttempt, PlanSnapshot } from "../types.js";
import {
  validPlanOutput,
  summarizeOutput,
  designerFactsText,
  normalizeStructureOutput,
  validateStructureOutput,
  parseCategoryGroups,
  normalizeCategoryPromptOutput,
  planAttemptView,
  categoryRequestView,
  llmSource,
  platformForPlanning,
} from "../services/structure-plan.js";
import { observedPromptLoad } from "../services/prompt-load.js";
import type { Router } from "../http/router.js";
import type { StudioServices } from "../services/studio-services.js";

export function registerPlanRoutes(router: Router, {
  deps,
  resolveVision,
  categoryPromptRepository,
  resolveCategorySourceSnapshot,
  listCategoryRequestsForSnapshot,
  appendConfirmedSnapshot,
  categoryPlanInput,
  categoryAllocationsForSnapshot,
  loadCategoryVisionImages,
}: StudioServices) {
  router.get("/api/plan-attempts/:attemptId", async ({ params }) => {
    if (!deps.planRepository) return fail("PLAN_REPOSITORY_NOT_CONFIGURED", 503);
    const attempt = await deps.planRepository.getAttempt(params.attemptId);
    if (!attempt) return fail("INVALID_PLAN_ATTEMPT", 404);
    const snapshot = attempt.snapshotId ? await deps.planRepository.getSnapshot(attempt.snapshotId) : null;
    return ok(planAttemptView(attempt, snapshot));
  });

  router.get("/api/suites/:suiteId/structure-plan", async ({ params }) => {
    if (!deps.planRepository) return fail("PLAN_REPOSITORY_NOT_CONFIGURED", 503);
    const snapshot = await deps.planRepository.getLatestSnapshot(params.suiteId);
    const attempt = await deps.planRepository.getLatestAttempt(params.suiteId);
    return ok({ attempt: attempt ? planAttemptView(attempt, attempt.snapshotId === snapshot?.id ? snapshot : null) : null, snapshot: snapshot && snapshot.phase === "structure_plan" ? planSnapshotView(snapshot) : null });
  });

  router.post("/api/suites/:suiteId/structure-plan", async ({ params, idempotencyKey, body: requestBody }) => {
    if (!idempotencyKey) return fail("MISSING_IDEMPOTENCY_KEY");
    if (!deps.planRepository) return fail("PLAN_REPOSITORY_NOT_CONFIGURED", 503);
    if (!deps.promptRepository) return fail("PROMPT_REPOSITORY_NOT_CONFIGURED", 503);
    const llmClient = await resolveVision();
    if (!llmClient) return fail("LLM_NOT_CONFIGURED", 503);
    const suite = await deps.repository.getSuite(params.suiteId);
    if (!suite) return fail("INVALID_SUITE_ID", 404);
    const body = asRecord(requestBody);
    const templateVersionId = typeof body.templateVersionId === "string" ? body.templateVersionId : "";
    const template = await deps.promptRepository.getPublishedVersion(templateVersionId, "structure_plan");
    if (!template) return fail("PLAN_TEMPLATE_NOT_FOUND", 404);
    const dynamicInput = { ...asRecord(body.dynamicInput) };
    if (Array.isArray(dynamicInput.selected_detail_categories))
      dynamicInput.selected_detail_categories = JSON.stringify(dynamicInput.selected_detail_categories);
    if (dynamicInput.category_requirements && typeof dynamicInput.category_requirements === "object")
      dynamicInput.category_requirements = JSON.stringify(dynamicInput.category_requirements);
    const validated = validateDynamicInput(template.inputSchema, dynamicInput);
    if (!validated.ok) return fail("PROMPT_INPUT_INVALID", 400, validated.message);
    if (validated.value.category_groups) {
      const groups = parseCategoryGroups(validated.value.category_groups);
      const min = Number(validated.value.detail_image_count_min);
      const max = Number(validated.value.detail_image_count_max);
      if (!groups || groups.main.count !== Number(validated.value.main_image_count) || !Number.isInteger(min) || !Number.isInteger(max) || min < SUITE_IMAGE_LIMITS.detail.min || min > max || max > SUITE_IMAGE_LIMITS.detail.max) return fail("PROMPT_INPUT_INVALID", 400, "分组数量配置无效");
      const categories = Object.values(groups).flatMap((group) => group.categories.filter((code) => code !== "main"));
      validated.value.selected_detail_categories = JSON.stringify(categories);
      validated.value.category_requirements = JSON.stringify(Object.fromEntries(categories.map((code) => [code, "optional"])));
    }
    const platformValue = typeof validated.value.platform === "string" ? validated.value.platform.trim() : "";
    const platformProfile = platformValue && deps.platformRepository ? await deps.platformRepository.find(platformValue) : null;
    if (platformValue && deps.platformRepository && !platformProfile) return fail("PLATFORM_NOT_FOUND");
    const humanInput = asRecord(body.humanInput);
    const refs = Array.isArray(body.selectedChunks) ? body.selectedChunks.flatMap((item) => item && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string" && typeof (item as Record<string, unknown>).version === "string" ? [{ id: (item as { id: string }).id, version: (item as { version: string }).version }] : []) : [];
    const chunks = refs.length ? await deps.ragClient?.getByIds(refs) : [];
    if (!chunks) return fail("RAG_NOT_CONFIGURED", 503);
    for (const ref of refs) { const chunk = chunks.find((item) => item.id === ref.id); if (!chunk || !chunk.published) return fail("RAG_CHUNK_NOT_FOUND", 409); if (chunk.version !== ref.version) return fail("RAG_CHUNK_VERSION_DRIFT", 409); }
    const images = await deps.repository.getInputImages(suite.id);
    if (images.length < 1 || images.length > 6) return fail("INVALID_INPUT_IMAGE");
    const useOriginalImages = body.useOriginalImages === true;
    const visionImages = [];
    for (const image of images) {
      const base = !useOriginalImages && image.currentBaseVersionId
        ? await deps.repository.getBaseImageVersion(suite.id, image.id, image.currentBaseVersionId)
        : null;
      const source = await deps.storage.get(base?.objectKey ?? image.originalObjectKey);
      if (!source) return fail("PLAN_INPUT_IMAGE_NOT_FOUND", 409);
      visionImages.push({ id: image.id, sourceKind: base ? "base" as const : "original" as const, sourceVersionId: base?.id ?? null, mimeType: source.contentType, bytes: source.bytes });
    }
    const createdAt = new Date().toISOString();
    const attempt: PlanAttempt = { id: randomUUID(), suiteId: suite.id, idempotencyKey, status: "running", templateVersionId, dynamicInput: validated.value, humanInput, selectedChunks: refs, inputImageIds: images.map((item) => item.id), baseVersionIds: visionImages.flatMap((item) => item.sourceVersionId ? [item.sourceVersionId] : []), provider: llmSource(llmClient), errorCode: null, errorMessage: null, outputSummary: null, snapshotId: null, createdAt, completedAt: null };
    const reservation = await deps.planRepository.beginAttempt(attempt);
    if (reservation.duplicate) return ok({ attemptId: reservation.attempt.id, status: reservation.attempt.status }, reservation.attempt.status === "running" ? 202 : 200);
    void (async () => {
      try {
        const raw = await llmClient.generatePlan({ requestId: attempt.id, templateVersionId, templateBody: template.body, userPromptTemplate: template.userPromptTemplate, dynamicInput: validated.value, humanInput, chunks, inputImageIds: attempt.inputImageIds, baseVersionIds: attempt.baseVersionIds, visionImages, platformProfile: platformForPlanning(platformProfile, useOriginalImages ? validated.value.main_image_background : undefined) });
        const output = normalizeStructureOutput(raw);
        if (!output) { await deps.planRepository!.failAttempt(attempt.id, "LLM_OUTPUT_SCHEMA_INVALID", errorMessages.LLM_OUTPUT_SCHEMA_INVALID, summarizeOutput(raw)); return; }
        const supplementRef = designerFactsText(validated.value) ? ["human_supplement"] : [];
        let validationError: string | null = null; try { validationError = validateStructureOutput(output, { ...validated.value, selected_detail_categories: JSON.parse(String(validated.value.selected_detail_categories)), category_requirements: JSON.parse(String(validated.value.category_requirements)) }, attempt.inputImageIds, [...chunks.map((chunk) => chunk.id), ...supplementRef]); } catch { validationError = "input_json"; }
        if (validationError) { await deps.planRepository!.failAttempt(attempt.id, "STRUCTURE_PLAN_INVALID", errorMessages.STRUCTURE_PLAN_INVALID, summarizeOutput(raw, { validationError })); return; }
        const latest = await deps.planRepository!.getLatestSnapshot(suite.id);
        const snapshot: PlanSnapshot = { id: randomUUID(), suiteId: suite.id, revisionNumber: (latest?.revisionNumber ?? 0) + 1, revisionKind: "llm", parentSnapshotId: latest?.id ?? null, templateVersionId, dynamicInput: validated.value, humanInput, chunks: chunks.map((chunk) => ({ sourceChunkId: chunk.id, sourceVersion: chunk.version, title: chunk.title, content: chunk.content, fieldValues: chunk.fieldValues, sourceKind: chunk.sourceKind, sourceAssetPaths: chunk.sourceAssetPaths, contentSha256: chunk.contentSha256 })), inputImageIds: attempt.inputImageIds, baseVersionIds: attempt.baseVersionIds, provider: attempt.provider, requestSummary: { phase: "structure_plan", templateVersionId, ...(useOriginalImages && { useOriginalImages }) }, rawOutputSummary: summarizeOutput(raw), schemaVersion: output.schemaVersion, items: [], phase: "structure_plan", confirmationStatus: "draft", confirmationMode: "human", confirmedAt: null, structure: { status: output.status, mainAllocation: output.mainAllocation, detailImageCount: output.detailImageCount, categoryAllocations: output.categoryAllocations, globalStyleCard: output.globalStyleCard }, createdAt: new Date().toISOString() };
        await deps.planRepository!.completeAttempt(attempt.id, snapshot);
      } catch (error) { await deps.planRepository!.failAttempt(attempt.id, error instanceof Error && error.message === "LLM_TIMEOUT" ? "LLM_TIMEOUT" : "LLM_PROVIDER_FAILED", error instanceof Error && error.message === "LLM_TIMEOUT" ? errorMessages.LLM_TIMEOUT : errorMessages.LLM_PROVIDER_FAILED).catch(() => undefined); }
    })();
    return ok({ attemptId: attempt.id, status: "running" }, 202);
  });

  router.post("/api/suites/:suiteId/structure-plan/confirm", async ({ params, body: requestBody }) => {
    if (!deps.planRepository) return fail("PLAN_REPOSITORY_NOT_CONFIGURED", 503);
    const latest = await deps.planRepository.getLatestSnapshot(params.suiteId);
    if (!latest || latest.phase !== "structure_plan" || latest.schemaVersion !== "suite-structure-plan-v2" || !isStructurePlanV2(latest.structure)) return fail("INVALID_PLAN_SNAPSHOT", 409);
    // Confirmation is terminal for a snapshot. Repeated clicks must reuse the
    // already-confirmed immutable snapshot instead of inserting its plan items again.
    if (latest.confirmationStatus === "confirmed") return ok(planSnapshotView(latest));
    const body = asRecord(requestBody, { allowArrays: true });
    const requestedStructure = asRecord(body.structure);
    const structure = {
      ...latest.structure,
      ...requestedStructure,
      categoryAllocations: Array.isArray(requestedStructure.categoryAllocations) ? requestedStructure.categoryAllocations : latest.structure.categoryAllocations,
      globalStyleCard: requestedStructure.globalStyleCard && typeof requestedStructure.globalStyleCard === "object" && !Array.isArray(requestedStructure.globalStyleCard) ? requestedStructure.globalStyleCard as Record<string, unknown> : latest.structure.globalStyleCard,
    };
    const candidate = normalizeStructureOutput({ ...structure, schemaVersion: "suite-structure-plan-v2" });
    if (!candidate) return fail("STRUCTURE_PLAN_INVALID", 409);
    const allocations = candidate.categoryAllocations;
    const selectedCategories = allocations.map((value) => value.category);
    const categoryRequirements = Object.fromEntries(allocations.map((value) => [value.category, value.requirement]));
    const supplementRef = designerFactsText(latest.dynamicInput) ? ["human_supplement"] : [];
    const validationError = validateStructureOutput(candidate, { ...latest.dynamicInput, selected_detail_categories: selectedCategories, category_requirements: categoryRequirements }, latest.inputImageIds, [...latest.chunks.map((chunk) => chunk.sourceChunkId), ...supplementRef]);
    if (validationError) return fail("STRUCTURE_PLAN_INVALID", 409);
    if (candidate.status !== "READY_FOR_REVIEW" || candidate.mainAllocation.missingFacts.length > 0 || candidate.categoryAllocations.some((row) => row.count > 0 && row.missingFacts.length > 0)) return fail("STRUCTURE_PLAN_NEEDS_INPUT", 409);
    const { schemaVersion: _schemaVersion, ...confirmedStructure } = candidate;
    const next: PlanSnapshot = { ...latest, id: randomUUID(), revisionNumber: latest.revisionNumber + 1, revisionKind: "human", parentSnapshotId: latest.id, confirmationStatus: "confirmed", confirmationMode: "human", confirmedAt: new Date().toISOString(), structure: confirmedStructure, createdAt: new Date().toISOString() };
    return ok(planSnapshotView(await appendConfirmedSnapshot(next)));
  });

  router.get("/api/category-prompt-requests/:requestId", async ({ params }) => {
    const request = await categoryPromptRepository.getRequest(params.requestId);
    return request ? ok(categoryRequestView(request)) : fail("INVALID_CATEGORY_PROMPT_REQUEST", 404);
  });

  router.get(/^\/api\/suites\/(?<suiteId>[^/]+)(?:\/plan)?\/category-prompts$/, async ({ params }) => {
    const suiteId = params.suiteId;
    if (!deps.planRepository) return fail("PLAN_REPOSITORY_NOT_CONFIGURED", 503);
    const snapshot = await deps.planRepository.getLatestSnapshot(suiteId);
    if (!snapshot || snapshot.phase !== "structure_plan" || snapshot.confirmationStatus !== "confirmed") return ok({ planSnapshotId: snapshot?.id ?? null, status: "not_ready", requests: [] });
    const requests = await listCategoryRequestsForSnapshot(snapshot);
    const expectedRequestCount = categoryAllocationsForSnapshot(snapshot).length;
    const current = [...new Map(requests.map((request) => [request.categoryCode, request])).values()];
    const status = !current.length ? "pending"
      : current.length < expectedRequestCount || current.some((request) => request.status === "running") ? "running"
        : current.some((request) => request.status === "failed") ? "partial" : "succeeded";
    return ok({ planSnapshotId: snapshot.id, status, expectedRequestCount, requests: requests.map(categoryRequestView) });
  });

  router.post(/^\/api\/suites\/(?<suiteId>[^/]+)(?:\/plan)?\/category-prompts$/, async ({ params, idempotencyKey, body: requestBody }) => {
    if (!idempotencyKey) return fail("MISSING_IDEMPOTENCY_KEY");
    if (!deps.planRepository) return fail("PLAN_REPOSITORY_NOT_CONFIGURED", 503);
    if (!deps.promptRepository) return fail("PROMPT_REPOSITORY_NOT_CONFIGURED", 503);
    const llmClient = await resolveVision();
    if (!llmClient) return fail("CATEGORY_PROMPT_LLM_NOT_CONFIGURED", 503);
    const suite = await deps.repository.getSuite(params.suiteId);
    if (!suite) return fail("INVALID_SUITE_ID", 404);
    const body = asRecord(requestBody);
    const snapshotId = typeof body.planSnapshotId === "string" ? body.planSnapshotId : undefined;
    const requestedSnapshot = snapshotId ? await deps.planRepository.getSnapshot(snapshotId) : await deps.planRepository.getLatestSnapshot(suite.id);
    const snapshot = requestedSnapshot ? await resolveCategorySourceSnapshot(requestedSnapshot) : null;
    if (!snapshot || snapshot.suiteId !== suite.id || snapshot.phase !== "structure_plan" || snapshot.confirmationStatus !== "confirmed" || !isStructurePlanV2(snapshot.structure) || snapshot.structure.status !== "READY_FOR_REVIEW") return fail("CATEGORY_PROMPT_NOT_CONFIRMED", 409);
    const allocations = categoryAllocationsForSnapshot(snapshot);
    if (!allocations.length) return fail("STRUCTURE_PLAN_INVALID", 409);
    const templateVersionId = typeof body.templateVersionId === "string" ? body.templateVersionId : "";
    let template = templateVersionId ? await deps.promptRepository.getPublishedVersion(templateVersionId, "category_prompt") : null;
    if (!template) {
      const [published] = await deps.promptRepository.listPublished("category_prompt");
      template = published ? await deps.promptRepository.getPublishedVersion(published.templateVersionId, "category_prompt") : null;
    }
    if (!template) return fail("CATEGORY_PROMPT_TEMPLATE_NOT_FOUND", 404);
    const humanInput = snapshot.humanInput;
    const platformValue = typeof snapshot.dynamicInput.platform === "string" ? snapshot.dynamicInput.platform.trim() : "";
    const platformProfile = platformValue && deps.platformRepository ? await deps.platformRepository.find(platformValue) : null;
    if (platformValue && deps.platformRepository && !platformProfile) return fail("PLATFORM_NOT_FOUND");
    const run = async () => {
      for (const entry of allocations) {
        const dynamicInput = categoryPlanInput(snapshot, entry.categoryCode, entry.requestedCount, entry.allocation, template!);
        const approvedFactRefs = entry.allocation && Array.isArray(entry.allocation.factRefs) ? entry.allocation.factRefs.map(String) : [];
        const requestKey = `${idempotencyKey}:${snapshot.id}:${entry.categoryCode}`;
        const request: CategoryPromptRequest = {
          id: randomUUID(), suiteId: suite.id, planSnapshotId: snapshot.id, categoryCode: entry.categoryCode, requestedCount: entry.requestedCount, status: "running", idempotencyKey: requestKey, retryOfRequestId: null,
          templateVersionId: template!.templateVersionId, dynamicInput, humanInput, approvedFactRefs, inputImageIds: snapshot.inputImageIds, baseVersionIds: snapshot.baseVersionIds,
          provider: llmSource(llmClient), requestSummary: { phase: "category_prompt", categoryCode: entry.categoryCode, requestedCount: entry.requestedCount, planSnapshotId: snapshot.id, templateVersionId: template!.templateVersionId }, responseSummary: null, items: [], errorCode: null, errorMessage: null, createdAt: new Date().toISOString(), completedAt: null,
        };
        const reservation = await categoryPromptRepository.beginRequest(request);
        if (reservation.duplicate && reservation.request.status !== "running") continue;
        if (reservation.duplicate) continue;
        try {
          const chunks = snapshot.chunks.filter((chunk) => approvedFactRefs.includes(chunk.sourceChunkId)).map((chunk) => ({ id: chunk.sourceChunkId, version: chunk.sourceVersion, title: chunk.title, summary: chunk.title, content: chunk.content, fieldValues: chunk.fieldValues, sourceKind: chunk.sourceKind, sourceAssetPaths: chunk.sourceAssetPaths, contentSha256: chunk.contentSha256, published: true }));
          const visionImages = await loadCategoryVisionImages(suite.id, snapshot, entry.allocation);
          const llmInput: CategoryPromptLlmInput = { requestId: request.id, templateVersionId: template!.templateVersionId, templateBody: template!.body, userPromptTemplate: template!.userPromptTemplate, dynamicInput, humanInput, chunks, inputImageIds: visionImages.map((image) => image.id), baseVersionIds: snapshot.baseVersionIds, visionImages, platformProfile: platformForPlanning(platformProfile, snapshot.requestSummary.useOriginalImages === true ? snapshot.dynamicInput.main_image_background : undefined), categoryCode: entry.categoryCode, requestedCount: entry.requestedCount, approvedFactRefs };
          if (!llmClient.generateCategoryPrompt) throw new Error("CATEGORY_PROMPT_LLM_NOT_CONFIGURED");
          const raw = await llmClient.generateCategoryPrompt(llmInput);
          const output = normalizeCategoryPromptOutput(raw);
          const summary = summarizeOutput(raw);
          if (!output || output.category !== entry.categoryCode) { await categoryPromptRepository.failRequest(request.id, "CATEGORY_PROMPT_INVALID", errorMessages.CATEGORY_PROMPT_INVALID, summary); continue; }
          if (output.items.length !== entry.requestedCount) { await categoryPromptRepository.failRequest(request.id, "CATEGORY_PROMPT_COUNT_MISMATCH", errorMessages.CATEGORY_PROMPT_COUNT_MISMATCH, summary); continue; }
          const allowedReferenceImageIds = entry.allocation && Array.isArray(entry.allocation.sourceImageIds) ? entry.allocation.sourceImageIds.map(String) : snapshot.inputImageIds;
          const stableIds = new Set<string>();
          const invalid = output.items.some((item) => stableIds.has(item.stableId) || (stableIds.add(item.stableId), item.category !== entry.categoryCode || item.referenceImageIds.some((id) => !allowedReferenceImageIds.includes(id)) || item.factRefs.some((ref) => !approvedFactRefs.includes(ref))));
          if (invalid) { await categoryPromptRepository.failRequest(request.id, "CATEGORY_PROMPT_INVALID", errorMessages.CATEGORY_PROMPT_INVALID, summary); continue; }
          await categoryPromptRepository.completeRequest(request.id, output.items, summary);
        } catch (error) {
          const code = error instanceof Error && error.message === "CATEGORY_PROMPT_LLM_NOT_CONFIGURED" ? "CATEGORY_PROMPT_LLM_NOT_CONFIGURED" : error instanceof Error && error.message === "LLM_TIMEOUT" ? "LLM_TIMEOUT" : error instanceof Error && error.message === "PLAN_INPUT_IMAGE_NOT_FOUND" ? "PLAN_INPUT_IMAGE_NOT_FOUND" : "CATEGORY_PROMPT_FAILED";
          await categoryPromptRepository.failRequest(request.id, code, errorMessages[code] ?? errorMessages.CATEGORY_PROMPT_FAILED).catch(() => undefined);
        }
      }
    };
    void run().catch(() => undefined);
    return ok({ planSnapshotId: snapshot.id, status: "running", categories: allocations.map((entry) => ({ categoryCode: entry.categoryCode, requestedCount: entry.requestedCount })) }, 202);
  });

  router.post(/^\/api\/suites\/(?<suiteId>[^/]+)(?:\/plan)?\/category-prompts\/(?<category>[^/]+)\/retry$/, async ({ params, idempotencyKey, body: requestBody }) => {
    if (!idempotencyKey) return fail("MISSING_IDEMPOTENCY_KEY");
    const llmClient = await resolveVision();
    if (!deps.planRepository || !deps.promptRepository || !llmClient) return fail("CATEGORY_PROMPT_LLM_NOT_CONFIGURED", 503);
    const suite = await deps.repository.getSuite(params.suiteId);
    if (!suite) return fail("INVALID_SUITE_ID", 404);
    const snapshot = await deps.planRepository.getLatestSnapshot(suite.id);
    if (!snapshot || snapshot.confirmationStatus !== "confirmed" || snapshot.phase !== "structure_plan" || !snapshot.structure) return fail("CATEGORY_PROMPT_NOT_CONFIRMED", 409);
    const categoryRequests = await categoryPromptRepository.listRequests(snapshot.id);
    const previous = categoryRequests.find((request) => request.id === params.category) ?? categoryRequests.filter((request) => request.categoryCode === params.category).at(-1);
    if (!previous || previous.status !== "failed") return fail("INVALID_CATEGORY_PROMPT_REQUEST", 404);
    const body = asRecord(requestBody);
    const templateVersionId = typeof body.templateVersionId === "string" ? body.templateVersionId : previous.templateVersionId;
    const template = await observedPromptLoad(deps.promptRepository, templateVersionId, "category_prompt");
    if (!template) return fail("CATEGORY_PROMPT_TEMPLATE_NOT_FOUND", 404);
    const platformValue = typeof snapshot.dynamicInput.platform === "string" ? snapshot.dynamicInput.platform.trim() : "";
    const platformProfile = platformValue && deps.platformRepository ? await deps.platformRepository.find(platformValue) : null;
    if (platformValue && deps.platformRepository && !platformProfile) return fail("PLATFORM_NOT_FOUND");
    const allocation = previous.categoryCode === "main" && isStructurePlanV2(snapshot.structure)
      ? snapshot.structure.mainAllocation as unknown as Record<string, unknown>
      : snapshot.structure.categoryAllocations.map((item) => item as Record<string, unknown>).find((item) => String(item.category) === previous.categoryCode) ?? null;
    const dynamicInput = categoryPlanInput(snapshot, previous.categoryCode, previous.requestedCount, allocation, template);
    const retryRequest: CategoryPromptRequest = { ...previous, id: randomUUID(), status: "running", idempotencyKey: `${idempotencyKey}:${snapshot.id}:${previous.categoryCode}:retry`, retryOfRequestId: previous.id, provider: llmSource(llmClient), templateVersionId: template.templateVersionId, dynamicInput, requestSummary: { ...previous.requestSummary, retryOfRequestId: previous.id }, responseSummary: null, items: [], errorCode: null, errorMessage: null, createdAt: new Date().toISOString(), completedAt: null };
    const reservation = await categoryPromptRepository.beginRequest(retryRequest);
    if (reservation.duplicate) return ok(categoryRequestView(reservation.request), reservation.request.status === "running" ? 202 : 200);
    void (async () => {
      try {
        const approvedFactRefs = retryRequest.approvedFactRefs;
        const chunks = snapshot.chunks.filter((chunk) => approvedFactRefs.includes(chunk.sourceChunkId)).map((chunk) => ({ id: chunk.sourceChunkId, version: chunk.sourceVersion, title: chunk.title, summary: chunk.title, content: chunk.content, fieldValues: chunk.fieldValues, sourceKind: chunk.sourceKind, sourceAssetPaths: chunk.sourceAssetPaths, contentSha256: chunk.contentSha256, published: true }));
        const visionImages = await loadCategoryVisionImages(suite.id, snapshot, allocation);
        if (!llmClient.generateCategoryPrompt) throw new Error("CATEGORY_PROMPT_LLM_NOT_CONFIGURED");
        const raw = await llmClient.generateCategoryPrompt({ requestId: retryRequest.id, templateVersionId: template.templateVersionId, templateBody: template.body, userPromptTemplate: template.userPromptTemplate, dynamicInput, humanInput: retryRequest.humanInput, chunks, inputImageIds: visionImages.map((image) => image.id), baseVersionIds: snapshot.baseVersionIds, visionImages, platformProfile: platformForPlanning(platformProfile, snapshot.requestSummary.useOriginalImages === true ? snapshot.dynamicInput.main_image_background : undefined), categoryCode: retryRequest.categoryCode, requestedCount: retryRequest.requestedCount, approvedFactRefs });
        const output = normalizeCategoryPromptOutput(raw);
        const summary = summarizeOutput(raw);
        if (!output || output.category !== retryRequest.categoryCode) { await categoryPromptRepository.failRequest(retryRequest.id, "CATEGORY_PROMPT_INVALID", errorMessages.CATEGORY_PROMPT_INVALID, summary); return; }
        if (output.items.length !== retryRequest.requestedCount) { await categoryPromptRepository.failRequest(retryRequest.id, "CATEGORY_PROMPT_COUNT_MISMATCH", errorMessages.CATEGORY_PROMPT_COUNT_MISMATCH, summary); return; }
        const allowedReferenceImageIds = allocation && Array.isArray(allocation.sourceImageIds) ? allocation.sourceImageIds.map(String) : snapshot.inputImageIds;
        const stableIds = new Set<string>();
        if (output.items.some((item) => stableIds.has(item.stableId) || (stableIds.add(item.stableId), item.category !== retryRequest.categoryCode || item.referenceImageIds.some((id) => !allowedReferenceImageIds.includes(id)) || item.factRefs.some((ref) => !approvedFactRefs.includes(ref))))) { await categoryPromptRepository.failRequest(retryRequest.id, "CATEGORY_PROMPT_INVALID", errorMessages.CATEGORY_PROMPT_INVALID, summary); return; }
        await categoryPromptRepository.completeRequest(retryRequest.id, output.items, summary);
      } catch (error) { const code = error instanceof Error && error.message === "LLM_TIMEOUT" ? "LLM_TIMEOUT" : "CATEGORY_PROMPT_FAILED"; await categoryPromptRepository.failRequest(retryRequest.id, code, errorMessages[code] ?? errorMessages.CATEGORY_PROMPT_FAILED).catch(() => undefined); }
    })();
    return ok(categoryRequestView(retryRequest), 202);
  });

  router.get("/api/suites/:suiteId/plan", async ({ params }) => {
    if (!deps.planRepository) return fail("PLAN_REPOSITORY_NOT_CONFIGURED", 503);
    const [attempt, snapshot] = await Promise.all([deps.planRepository.getLatestAttempt(params.suiteId), deps.planRepository.getLatestSnapshot(params.suiteId)]);
    return ok({ attempt: attempt ? planAttemptView(attempt, attempt.snapshotId === snapshot?.id ? snapshot : null) : null, snapshot: snapshot ? planSnapshotView(snapshot) : null });
  });

  router.post("/api/suites/:suiteId/plan", () => fail("LEGACY_ENDPOINT_GONE", 410));

  router.patch("/api/suites/:suiteId/plan", async ({ params, body: requestBody }) => {
    if (!deps.planRepository) return fail("PLAN_REPOSITORY_NOT_CONFIGURED", 503);
    const latest = await deps.planRepository.getLatestSnapshot(params.suiteId);
    if (!latest) return fail("INVALID_PLAN_SNAPSHOT", 404);
    const body = asRecord(requestBody, { allowArrays: true });
    if (!Array.isArray(body.items) || !validPlanOutput({ schemaVersion: "suite-plan-v1", items: body.items }, { items: { properties: { imageType: {} } } })) return fail("LLM_OUTPUT_SCHEMA_INVALID");
    const items = body.items as Array<{ imageType?: "main" | "detail"; title: string; purpose: string; prompt: string }>;
    const snapshot: PlanSnapshot = { ...latest, id: randomUUID(), revisionNumber: latest.revisionNumber + 1, revisionKind: "human", parentSnapshotId: latest.id, items: items.map((item, index) => ({ id: randomUUID(), ordinal: index + 1, imageType: item.imageType ?? "main", title: item.title, purpose: item.purpose, prompt: item.prompt })), createdAt: new Date().toISOString() };
    return ok(planSnapshotView(await deps.planRepository.appendRevision(snapshot)));
  });

  router.post("/api/suites/:suiteId/start-creation-check", async ({ params }) => {
    if (!deps.planRepository) return fail("PLAN_REPOSITORY_NOT_CONFIGURED", 503);
    const [images, snapshot] = await Promise.all([deps.repository.getInputImages(params.suiteId), deps.planRepository.getLatestSnapshot(params.suiteId)]);
    if (!images.length) return fail("INVALID_INPUT_IMAGE");
    if (!snapshot) return fail("INVALID_PLAN_SNAPSHOT");
    if (snapshot.phase === "structure_plan" && snapshot.confirmationStatus === "confirmed") {
      const items = materializeCategoryPlanItems(snapshot, await listCategoryRequestsForSnapshot(snapshot));
      if (!items) return fail("CATEGORY_PROMPTS_NOT_READY", 409);
      return ok({ ready: true, planSnapshotId: snapshot.id, itemCount: items.length });
    }
    if (!snapshot.items.length) return fail("INVALID_PLAN_SNAPSHOT");
    return ok({ ready: true, planSnapshotId: snapshot.id, itemCount: snapshot.items.length });
  });
}
