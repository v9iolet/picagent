import { randomUUID } from "node:crypto";
import { requiresPureWhiteMainImage } from "../shared/platform-main-background.js";
import { productNameFor } from "../shared/product-name.js";
import { SUITE_CATEGORY_GROUPS, SMART_SUITE_STRUCTURE_PRESET } from "../shared/suite-categories.js";
import { resolveDeliverySlots, type DeliveryEditChildLike } from "../shared/workbench-delivery.js";
import { errorMessages, fail } from "./api-errors.js";
import { ok, asRecord, dataOf, now, type AppResponse } from "./api-response.js";
import type { ListingRepository } from "./listing-copy.js";
import type {
  InputImage,
  PipelineRepository,
  PlanRepository,
  PlanSnapshot,
  PlatformRepository,
  PromptRepository,
  StorageAdapter,
  StructurePlanV2,
  SuitePipelineRun,
  SuiteRepository,
  SuiteTask,
  TaskRepository,
} from "./types.js";
import {
  planSnapshotView,
  isStructurePlanV2,
  taskView,
  taskAttemptView,
  taskSlotView,
  taskVersionView,
} from "./suite-views.js";

interface SuitePipelineDependencies {
  repository: SuiteRepository;
  storage: StorageAdapter;
  platformRepository?: PlatformRepository;
  promptRepository?: PromptRepository;
  planRepository?: PlanRepository;
  taskRepository?: TaskRepository;
  pipelineRepository: PipelineRepository;
  listingRepository: ListingRepository;
  hasPlanningModel(): boolean;
  request(
    method: string,
    path: string,
    options?: { headers?: Record<string, string>; body?: unknown },
  ): Promise<AppResponse>;
  startListingCopy(
    runId: string,
    suiteId: string,
    config: SuitePipelineRun["config"],
    images: InputImage[],
  ): Promise<void>;
  appendConfirmedSnapshot(candidate: PlanSnapshot): Promise<PlanSnapshot>;
  loadSuiteImageEditChildren(tasks: SuiteTask[]): Promise<DeliveryEditChildLike[]>;
}

const waitUntil = async <T>(load: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 120_000): Promise<T> => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await load();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("PIPELINE_TIMEOUT");
};

class PipelineError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message || errorMessages[code] || errorMessages.PIPELINE_FAILED);
  }
}

function stageError(fallback: string, code: unknown, message: unknown) {
  const resolvedCode = typeof code === "string" && code.trim() ? code : fallback;
  return new PipelineError(
    resolvedCode,
    typeof message === "string" && message.trim()
      ? message
      : errorMessages[resolvedCode] ?? errorMessages[fallback],
  );
}

function checkResponse(response: AppResponse, fallback: string) {
  if (response.status < 400) return;
  const error = "error" in response.body ? response.body.error : null;
  throw stageError(fallback, error?.code, error?.message);
}

const buildCategoryGroups = (config: SuitePipelineRun["config"]) => {
  const raw = asRecord(config.counts);
  const value = (key: string, fallback: number) =>
    Number.isInteger(Number(raw[key])) ? Math.max(0, Number(raw[key])) : fallback;
  const { main, selling_points, lifestyle, other } = SUITE_CATEGORY_GROUPS;
  const sellingPointCount =
    raw.selling_points !== undefined
      ? value("selling_points", selling_points.defaultCount)
      : raw.sellingPoint !== undefined
        ? value("sellingPoint", selling_points.defaultCount)
        : raw.feature_benefit !== undefined || raw.material_detail !== undefined
          ? value("feature_benefit", 0) + value("material_detail", 0)
          : selling_points.defaultCount;
  const group = (definition: (typeof SUITE_CATEGORY_GROUPS)[keyof typeof SUITE_CATEGORY_GROUPS], count: number) => ({
    categories: definition.categories,
    mode: definition.mode,
    count,
  });
  return {
    main: group(main, value("main", value("main_image_count", main.defaultCount))),
    selling_points: group(selling_points, sellingPointCount),
    lifestyle: group(lifestyle, value("lifestyle", value("lifestyle_use", lifestyle.defaultCount))),
    other: group(other, value("other", other.defaultCount)),
  };
};

export function createSuitePipeline(deps: SuitePipelineDependencies) {
  const { pipelineRepository, listingRepository, request, appendConfirmedSnapshot, loadSuiteImageEditChildren } = deps;
  const executePipeline = async (run: SuitePipelineRun) => {
    const { suiteId, config } = run;
    try {
      const resumePhase = run.currentPhase;
      const executionKey = `${run.idempotencyKey}:r${run.resumeCount ?? 0}`;
      const images = await deps.repository.getInputImages(suiteId);
      const platform =
        typeof config.platform === "string" && deps.platformRepository
          ? await deps.platformRepository.find(config.platform)
          : null;
      if (typeof config.platform === "string" && deps.platformRepository && !platform)
        throw new Error("PLATFORM_NOT_FOUND");
      const refineRequired =
        platform?.mainImageBackground === "pure_white_required" ||
        config.refineBaseImages === true ||
        (platform?.mainImageBackground === "white_preferred" && config.refineBaseImages !== false);
      if (resumePhase === "base_refining" && refineRequired && deps.promptRepository) {
        const [baseTemplate] = await deps.promptRepository.listPublished("base_refine");
        if (baseTemplate) {
          const pending = images.filter((image) => !image.currentBaseVersionId);
          const queue = [...pending];
          const refineOne = async () => {
            while (queue.length) {
              const image = queue.shift()!;
              const response = await request(
                "POST",
                `/api/suites/${suiteId}/input-images/${image.id}/base-generation`,
                {
                  headers: { "idempotency-key": `${executionKey}:base:${image.id}` },
                  body: {
                    templateVersionId: baseTemplate.templateVersionId,
                    dynamicInput: {
                      source_image_ids: image.id,
                      background_target:
                        platform?.mainImageBackground === "pure_white_required"
                          ? "纯白背景 RGB 255，无文字、Logo、水印或装饰"
                          : "干净白底或浅色背景",
                    },
                  },
                },
              );
              if (response.status >= 400) throw new Error("BASE_REFINE_FAILED");
              const attemptId = String(asRecord(asRecord(dataOf(response)).attempt).id ?? "");
              if (attemptId)
                await waitUntil(
                  () => deps.repository.listGenerationAttempts(suiteId, image.id),
                  (attempts) => attempts.some((attempt) => attempt.id === attemptId && attempt.status !== "running"),
                );
            }
          };
          await Promise.all([refineOne(), refineOne()]);
          const failed = (
            await Promise.all(
              images.map(async (image) => {
                const attempts = await deps.repository.listGenerationAttempts(suiteId, image.id);
                return attempts.find((attempt) => attempt.idempotencyKey === `${executionKey}:base:${image.id}`);
              }),
            )
          ).find((attempt) => attempt?.status === "failed");
          if (failed) {
            await pipelineRepository.updateRun(run.id, {
              status: "waiting_base_refine_decision",
              currentPhase: "base_refining",
              errorCode: failed.errorCode ?? "BASE_REFINE_FAILED",
              errorMessage: failed.errorMessage ?? "白底精修失败",
              updatedAt: now(),
            });
            return;
          }
        }
      }
      let rawSnapshot: PlanSnapshot | null =
        run.structureSnapshotId && deps.planRepository
          ? await deps.planRepository.getSnapshot(run.structureSnapshotId)
          : null;
      if (!rawSnapshot) {
        if (["category_prompting", "image_generating", "done"].includes(resumePhase))
          throw new PipelineError("STRUCTURE_PLAN_FAILED");
        await pipelineRepository.updateRun(run.id, { currentPhase: "structure_planning", updatedAt: now() });
        if (!deps.promptRepository || !deps.planRepository || !deps.hasPlanningModel())
          throw new Error("LLM_NOT_CONFIGURED");
        const structureTemplates = await deps.promptRepository.listPublished("structure_plan");
        const structureTemplate =
          structureTemplates.find((item) => item.inputSchema.some((field) => field.key === "category_groups")) ??
          structureTemplates[0];
        if (!structureTemplate) throw new PipelineError("PLAN_TEMPLATE_NOT_FOUND");
        const smart = config.mode === "smart";
        const allowed = new Set(structureTemplate.inputSchema.map((field) => field.key));
        const required = ["target_market_country", "aspect_ratio", "main_image_background"];
        if (!smart) required.push("category_groups");
        if (required.some((key) => !allowed.has(key))) throw new PipelineError("PLAN_TEMPLATE_OUTDATED");
        const groups = buildCategoryGroups(config);
        const details = Object.values(groups)
          .filter((group) => group.categories[0] !== "main")
          .reduce((sum, group) => sum + group.count, 0);
        const dynamicInput: Record<string, unknown> = {
          platform: config.platform ?? "",
          target_market_country: config.targetMarket ?? "",
          output_language: config.outputLanguage ?? "中文",
          product_name: productNameFor(config.sellingPoints, images[0]?.originalFilename),
          human_supplement: typeof config.sellingPoints === "string" ? config.sellingPoints : "",
          emphasis_requirements: typeof config.sellingPoints === "string" ? config.sellingPoints : "",
          aspect_ratio: config.aspectRatio ?? "1:1",
          main_image_background: requiresPureWhiteMainImage(platform) ? "pure_white_required" : "flexible",
          main_image_count: smart ? SMART_SUITE_STRUCTURE_PRESET.main_image_count : groups.main.count,
          detail_image_count_min: 0,
          detail_image_count_max: smart ? SMART_SUITE_STRUCTURE_PRESET.detail_image_count_max : details,
          ...(!smart && { category_groups: JSON.stringify(groups) }),
          selected_detail_categories: JSON.stringify(SMART_SUITE_STRUCTURE_PRESET.selected_detail_categories),
          category_requirements: JSON.stringify(SMART_SUITE_STRUCTURE_PRESET.category_requirements),
        };
        const planResponse = await request("POST", `/api/suites/${suiteId}/structure-plan`, {
          headers: { "idempotency-key": `${executionKey}:structure` },
          body: {
            templateVersionId: structureTemplate.templateVersionId,
            dynamicInput: Object.fromEntries(Object.entries(dynamicInput).filter(([key]) => allowed.has(key))),
            humanInput: {},
            useOriginalImages: resumePhase !== "base_refining",
          },
        });
        checkResponse(planResponse, "STRUCTURE_PLAN_FAILED");
        const planAttemptId = String(asRecord(dataOf(planResponse)).attemptId ?? "");
        if (!planAttemptId) throw new PipelineError("STRUCTURE_PLAN_FAILED");
        const terminal = await waitUntil(
          () => request("GET", `/api/plan-attempts/${planAttemptId}`),
          (response) =>
            response.status >= 400 || ["succeeded", "failed"].includes(String(asRecord(dataOf(response)).status)),
        );
        checkResponse(terminal, "STRUCTURE_PLAN_FAILED");
        const attempt = asRecord(dataOf(terminal));
        if (attempt.status === "failed")
          throw stageError("STRUCTURE_PLAN_FAILED", attempt.errorCode, attempt.errorMessage);
        const rawView = attempt.snapshot as PlanSnapshot | undefined;
        if (!rawView) throw new PipelineError("STRUCTURE_PLAN_FAILED");
        rawSnapshot = await deps.planRepository.getSnapshot(rawView.id);
        if (!rawSnapshot) throw new PipelineError("STRUCTURE_PLAN_FAILED");
        if (rawSnapshot.confirmationStatus !== "confirmed") {
          const structure = rawSnapshot.structure as StructurePlanV2 | null;
          const missing = Boolean(
            structure &&
              (structure.status !== "READY_FOR_REVIEW" ||
                structure.mainAllocation.missingFacts.length ||
                structure.categoryAllocations.some((item) => item.count > 0 && item.missingFacts.length)),
          );
          if (missing) {
            await pipelineRepository.updateRun(run.id, {
              status: "waiting_human_input",
              currentPhase: "structure_planning",
              errorCode: "MISSING_FACTS",
              errorMessage: "请补充卖点或调整分组数量",
              updatedAt: now(),
            });
            return;
          }
          const confirmed: PlanSnapshot = {
            ...rawSnapshot,
            id: randomUUID(),
            revisionNumber: rawSnapshot.revisionNumber + 1,
            revisionKind: "human",
            parentSnapshotId: rawSnapshot.id,
            confirmationStatus: "confirmed",
            confirmationMode: "auto",
            confirmedAt: now(),
            createdAt: now(),
          };
          rawSnapshot = await appendConfirmedSnapshot(confirmed);
        }
      }
      if (!rawSnapshot || rawSnapshot.confirmationStatus !== "confirmed") throw new PipelineError("STRUCTURE_PLAN_FAILED");
      await pipelineRepository.updateRun(run.id, { structureSnapshotId: rawSnapshot.id, updatedAt: now() });

      if (config.listingCopy === true) {
        void deps
          .startListingCopy(run.id, suiteId, config, images)
          .catch(() => console.error("Could not start listing copy for pipeline", run.id));
      }

      let taskRows: SuiteTask[] = [];
      const canReuseTasks = Boolean(run.taskIds?.length) && !["base_refining"].includes(resumePhase);
      if (canReuseTasks && deps.taskRepository) {
        const allTasks = await deps.taskRepository.listTasks(suiteId);
        const ids = new Set(run.taskIds ?? []);
        taskRows = ids.size ? allTasks.filter((task) => ids.has(task.id)) : allTasks;
      }
      if (!taskRows.length) {
        await pipelineRepository.updateRun(run.id, { currentPhase: "category_prompting", updatedAt: now() });
        const categoryKey = `${executionKey}:categories`;
        const categoryResponse = await request("POST", `/api/suites/${suiteId}/category-prompts`, {
          headers: { "idempotency-key": categoryKey },
          body: { planSnapshotId: rawSnapshot.id },
        });
        checkResponse(categoryResponse, "CATEGORY_PROMPT_FAILED");
        const categories = asRecord(dataOf(categoryResponse)).categories;
        if (!Array.isArray(categories) || !categories.length) throw new PipelineError("CATEGORY_PROMPT_FAILED");
        const categoryRequests = await waitUntil(
          async () => {
            const response = await request("GET", `/api/suites/${suiteId}/category-prompts`);
            checkResponse(response, "CATEGORY_PROMPT_FAILED");
            const { requests } = asRecord(dataOf(response));
            if (!Array.isArray(requests)) return [];
            return requests.map((row) => asRecord(row)).filter((row) =>
              typeof row.idempotencyKey === "string" && row.idempotencyKey.startsWith(`${categoryKey}:`),
            );
          },
          (requests) => requests.length === categories.length &&
            requests.every((row) => row.status === "succeeded" || row.status === "failed"),
        );
        const failedCategory = categoryRequests.find((row) => row.status === "failed");
        if (failedCategory)
          throw stageError("CATEGORY_PROMPT_FAILED", failedCategory.errorCode, failedCategory.errorMessage);
        const tasksResponse = await request("POST", `/api/suites/${suiteId}/tasks`, {
          body: { planSnapshotId: rawSnapshot.id },
        });
        checkResponse(tasksResponse, "TASK_MATERIALIZATION_FAILED");
        const taskData = dataOf(tasksResponse);
        if (taskData && typeof taskData === "object" && deps.taskRepository) {
          const { tasks } = asRecord(taskData);
          const rows = Array.isArray(tasks) ? (tasks as Array<Record<string, unknown>>) : [];
          const ids = rows.flatMap((row) => (typeof row.id === "string" ? [row.id] : []));
          await pipelineRepository.updateRun(run.id, { taskIds: ids, updatedAt: now() });
          taskRows = (await deps.taskRepository.listTasks(suiteId)).filter((task) => ids.includes(task.id));
          for (const task of taskRows)
            await deps.taskRepository.updateTask(task.id, {
              generationParams: {
                ...task.generationParams,
                ratio: config.aspectRatio ?? task.generationParams.ratio ?? (task.imageType === "main" ? "1:1" : "3:4"),
                size: config.size ?? task.generationParams.size ?? "1K",
              },
            });
        }
      }
      if (!deps.taskRepository || !taskRows.length) throw new PipelineError("TASK_MATERIALIZATION_FAILED");
      const taskRepository = deps.taskRepository;
      let batchId: string | undefined;
      if (resumePhase !== "done") {
        await pipelineRepository.updateRun(run.id, { currentPhase: "image_generating", updatedAt: now() });
        const pendingTasks: SuiteTask[] = [];
        for (const task of taskRows) {
          const history = await deps.taskRepository.listTaskVersions(task.id);
          if (!history.versions.some((version) => version.isCurrent)) pendingTasks.push(task);
        }
        if (pendingTasks.length) {
          const generationResponse = await request("POST", `/api/suites/${suiteId}/generation`, {
            headers: { "idempotency-key": `${executionKey}:images` },
            body: { taskIds: pendingTasks.map((task) => task.id) },
          });
          checkResponse(generationResponse, "IMAGE_GENERATION_FAILED");
          const data = dataOf(generationResponse);
          if (!data || typeof data !== "object" || !("batchId" in data) || typeof data.batchId !== "string")
            throw new PipelineError("IMAGE_GENERATION_FAILED");
          const id = data.batchId;
          batchId = id;
          await waitUntil(
            () => taskRepository.getBatch(id),
            (batch) => batch !== null && batch.status !== "running",
          );
        }
      }
      const histories = await Promise.all(taskRows.map((task) => taskRepository.listTaskVersions(task.id)));
      const missing = histories.filter((history) => !history.versions.some((version) => version.isCurrent));
      const generated = taskRows.length - missing.length;
      const status = generated === taskRows.length ? "completed" : generated > 0 ? "partial_failed" : "failed";
      let failure: PipelineError | undefined;
      if (missing.length) {
        const batchSlots = batchId
          ? new Set((await taskRepository.listSlots(suiteId)).filter((slot) => slot.batchId === batchId).map((slot) => slot.id))
          : null;
        const failed = missing
          .map(({ attempts }) => attempts.filter((attempt) =>
            attempt.status === "failed" && (!batchSlots || batchSlots.has(attempt.slotId)),
          ).at(-1))
          .find(Boolean);
        failure = stageError("IMAGE_GENERATION_FAILED", failed?.errorCode, failed?.errorMessage);
      }
      const completedAt = now();
      await pipelineRepository.updateRun(run.id, {
        status, currentPhase: "done", errorCode: failure?.code ?? null, errorMessage: failure?.message ?? null,
        updatedAt: completedAt, completedAt,
      });
    } catch (error) {
      const failure = error instanceof PipelineError
        ? error
        : stageError("PIPELINE_FAILED", error instanceof Error ? error.message : undefined, undefined);
      await pipelineRepository.updateRun(run.id, {
        status: "failed",
        errorCode: failure.code,
        errorMessage: failure.message,
        updatedAt: now(),
        completedAt: now(),
      });
    }
  };

  const cloneSuiteInputs = async (images: InputImage[], targetSuiteId: string) => {
    for (const image of images) {
      const id = randomUUID();
      const originalKey = `suites/${targetSuiteId}/inputs/${id}/original`;
      const thumbnailKey = `suites/${targetSuiteId}/inputs/${id}/thumbnail`;
      const generationKey = `suites/${targetSuiteId}/inputs/${id}/generation-input.jpg`;
      const [original, thumbnail, generation] = await Promise.all([
        deps.storage.get(image.originalObjectKey),
        deps.storage.get(image.thumbnailObjectKey),
        deps.storage.get(image.originalObjectKey.replace(/\/original$/, "/generation-input.jpg")),
      ]);
      if (!original || !thumbnail) throw new Error("INPUT_OBJECT_NOT_FOUND");
      await deps.storage.put({ key: originalKey, bytes: original.bytes, contentType: original.contentType });
      await deps.storage.put({ key: thumbnailKey, bytes: thumbnail.bytes, contentType: thumbnail.contentType });
      if (generation)
        await deps.storage.put({ key: generationKey, bytes: generation.bytes, contentType: generation.contentType });
      await deps.repository.createInputImage({
        id,
        suiteId: targetSuiteId,
        ordinal: image.ordinal,
        originalObjectKey: originalKey,
        thumbnailObjectKey: thumbnailKey,
        sha256: image.sha256,
        width: image.width,
        height: image.height,
        mimeType: image.mimeType,
        originalFilename: image.originalFilename,
        currentBaseVersionId: null,
        createdAt: now(),
      });
    }
  };

  async function startRun(idempotencyKey: string | undefined, payload: unknown) {
    if (!idempotencyKey) return fail("MISSING_IDEMPOTENCY_KEY");
    const body = asRecord(payload);
    const config: SuitePipelineRun["config"] = { ...asRecord(body.config) };
    const cloneSpec =
      body.cloneFrom && typeof body.cloneFrom === "object" && !Array.isArray(body.cloneFrom)
        ? (body.cloneFrom as Record<string, unknown>)
        : null;
    const sourceId =
      typeof body.cloneFrom === "string"
        ? body.cloneFrom
        : typeof cloneSpec?.suiteId === "string"
          ? cloneSpec.suiteId
          : typeof body.suiteId === "string"
            ? body.suiteId
            : null;
    let suite = sourceId ? await deps.repository.getSuite(sourceId) : null;
    if (sourceId && !suite) return fail("INVALID_SUITE_ID", 404);
    if ("runId" in body) {
      const latest = suite && (await pipelineRepository.getLatestRun(suite.id));
      return latest?.status === "running" ? fail("PIPELINE_ALREADY_RUNNING", 409) : fail("INVALID_PIPELINE_START");
    }
    if (typeof body.cloneFrom === "string" || cloneSpec) {
      const source = suite!;
      const imageIds =
        cloneSpec && Array.isArray(cloneSpec.imageIds)
          ? new Set(cloneSpec.imageIds.filter((id): id is string => typeof id === "string"))
          : undefined;
      const originals = (await deps.repository.getInputImages(source.id)).filter((image) => !imageIds || imageIds.has(image.id));
      suite = await deps.repository.createSuite(
        productNameFor(config.sellingPoints, originals[0]?.originalFilename),
        `${idempotencyKey}:suite`,
        "suite_studio",
      );
      if (!(await deps.repository.getInputImages(suite.id)).length)
        await cloneSuiteInputs(originals, suite.id);
    }
    if (!suite)
      suite = await deps.repository.createSuite(productNameFor(config.sellingPoints), `${idempotencyKey}:suite`, "suite_studio");
    const createdAt = now();
    try {
      const { run, duplicate } = await pipelineRepository.createRun({
        id: randomUUID(),
        suiteId: suite.id,
        idempotencyKey,
        status: "running",
        currentPhase: "structure_planning",
        resumeCount: 0,
        lastResumeKey: null,
        resumeKeys: [],
        structureSnapshotId: null,
        taskIds: [],
        config,
        errorCode: null,
        errorMessage: null,
        createdAt,
        updatedAt: createdAt,
        completedAt: null,
      });
      if (!duplicate) void executePipeline(run);
      return ok({ suiteId: suite.id, pipeline: run }, run.status === "running" ? 202 : 200);
    } catch (error) {
      if (error instanceof Error && error.message === "PIPELINE_ALREADY_RUNNING") return fail(error.message, 409);
      throw error;
    }
  }

  async function resumeRun(suiteId: string, idempotencyKey: string | undefined, payload: unknown) {
    if (!idempotencyKey?.trim()) return fail("MISSING_IDEMPOTENCY_KEY");
    const suite = await deps.repository.getSuite(suiteId);
    if (!suite) return fail("INVALID_SUITE_ID", 404);
    const current = await pipelineRepository.getLatestRun(suite.id);
    if (!current) return fail("PIPELINE_NOT_FOUND", 404);
    const body = asRecord(payload, { allowArrays: true });
    const action = String(body.action ?? "");
    const usedKey = (run: SuitePipelineRun) =>
      run.lastResumeKey === idempotencyKey || run.resumeKeys?.includes(idempotencyKey);
    if (usedKey(current)) return ok({ suiteId: suite.id, pipeline: current }, 202);
    let config = current.config;
    if (action === "retry_base_refine" || action === "skip_base_refine") {
      if (current.status !== "waiting_base_refine_decision") return fail("PIPELINE_ACTION_NOT_ALLOWED", 409);
    } else if (action === "submit_missing_facts") {
      if (current.status !== "waiting_human_input") return fail("PIPELINE_ACTION_NOT_ALLOWED", 409);
    } else if (action === "resume_after_interrupt") {
      if (current.status !== "failed" || current.errorCode !== "PIPELINE_INTERRUPTED")
        return fail("PIPELINE_ACTION_NOT_ALLOWED", 409);
    }
    if (action === "skip_base_refine") {
      const platform =
        typeof config.platform === "string" && deps.platformRepository
          ? await deps.platformRepository.find(config.platform)
          : null;
      if (platform?.mainImageBackground === "pure_white_required") return fail("PURE_WHITE_REQUIRED", 409);
      config = { ...config, refineBaseImages: false };
    }
    if (action === "retry_base_refine") config = { ...config, refineBaseImages: true };
    if (action === "submit_missing_facts") {
      const supplement =
        typeof body.supplementText === "string"
          ? body.supplementText
          : typeof body.sellingPoints === "string"
            ? body.sellingPoints
            : typeof body.humanSupplement === "string"
              ? body.humanSupplement
              : undefined;
      const previousSellingPoints = typeof config.sellingPoints === "string" ? config.sellingPoints : "";
      const mergedSellingPoints =
        supplement === undefined
          ? previousSellingPoints
          : [previousSellingPoints, supplement].filter(Boolean).join("\n");
      const previousCounts = asRecord(config.counts);
      const nextCounts = { ...previousCounts, ...asRecord(body.counts) };
      if (Array.isArray(body.removedCategories))
        for (const category of body.removedCategories.filter((value): value is string => typeof value === "string")) {
          if (category === "feature_benefit" || category === "material_detail") nextCounts.selling_points = 0;
          else if (category === "lifestyle_use") nextCounts.lifestyle = 0;
        }
      config = { ...config, sellingPoints: mergedSellingPoints, counts: nextCounts };
    }
    if (!["retry_base_refine", "skip_base_refine", "submit_missing_facts", "resume_after_interrupt"].includes(action))
      return fail("INVALID_PIPELINE_ACTION", 400);
    const phase =
      action === "resume_after_interrupt"
        ? current.currentPhase
        : action === "submit_missing_facts"
          ? "structure_planning"
          : "base_refining";
    const updated = await pipelineRepository.resumeRun(current, idempotencyKey, phase, config);
    if (!updated) {
      const latest = await pipelineRepository.getRun(current.id);
      if (latest && usedKey(latest)) return ok({ suiteId: suite.id, pipeline: latest }, 202);
      return fail("PIPELINE_ACTION_NOT_ALLOWED", 409);
    }
    void executePipeline(updated);
    return ok({ suiteId: suite.id, pipeline: updated }, 202);
  }

  async function getStudioState(suiteId: string) {
    if (!deps.taskRepository) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);
    const suite = await deps.repository.getSuite(suiteId);
    if (!suite) return fail("INVALID_SUITE_ID", 404);
    const [inputImages, pipeline, snapshot, tasks, batches, slots] = await Promise.all([
      deps.repository.getInputImages(suite.id),
      pipelineRepository.getLatestRun(suite.id),
      deps.planRepository?.getLatestSnapshot(suite.id) ?? Promise.resolve(null),
      deps.taskRepository.listTasks(suite.id),
      deps.taskRepository.listBatches(suite.id),
      deps.taskRepository.listSlots(suite.id),
    ]);
    const activeTasks = tasks.filter((task) => task.status !== "archived");
    const taskAggregates = await Promise.all(
      activeTasks.map(async (task) => {
        const history = await deps.taskRepository!.listTaskVersions(task.id);
        return {
          ...taskView(task),
          versions: history.versions.map(taskVersionView),
          attempts: history.attempts.map(taskAttemptView),
          slots: slots.filter((slot) => slot.taskId === task.id).map(taskSlotView),
        };
      }),
    );
    const imageEditChildren = await loadSuiteImageEditChildren(activeTasks);
    const cards = resolveDeliverySlots(taskAggregates, imageEditChildren, {
      defaultTemplateVersionId: snapshot?.templateVersionId ?? null,
    });
    const otherLimit =
      pipeline?.config && typeof pipeline.config === "object"
        ? pipeline.config.mode === "smart"
          ? SMART_SUITE_STRUCTURE_PRESET.detail_image_count_max
          : pipeline.config.counts && typeof pipeline.config.counts === "object"
            ? Number((pipeline.config.counts as Record<string, unknown>).other ?? 0)
            : 0
        : 0;
    const otherCodes = new Set<string>(SUITE_CATEGORY_GROUPS.other.categories as readonly string[]);
    const actualOther =
      snapshot?.structure && isStructurePlanV2(snapshot.structure)
        ? snapshot.structure.categoryAllocations
            .filter((item) => otherCodes.has(item.category) && item.count > 0)
            .reduce((sum, item) => sum + item.count, 0)
        : 0;
    const planning =
      snapshot?.structure && isStructurePlanV2(snapshot.structure)
        ? {
            snapshot: planSnapshotView(snapshot),
            notGeneratedReasons:
              cards.length > 0 && actualOther < otherLimit
                ? snapshot.structure.categoryAllocations
                    .filter((item) => otherCodes.has(item.category) && item.count === 0 && item.missingFacts.length > 0)
                    .map((item) => ({ category: item.category, reasons: item.missingFacts }))
                : [],
          }
        : { snapshot: snapshot ? planSnapshotView(snapshot) : null, notGeneratedReasons: [] };
    const total = cards.length;
    const done = cards.filter((card) => card.sourceRole !== "pending").length;
    const listingCopy = pipeline?.config.listingCopy === true ? await listingRepository.summary(pipeline.id) : null;
    return ok({
      suite,
      pipeline,
      listingCopy,
      inputImages,
      planning,
      cards,
      progress: { total, completed: done, percent: total ? Math.round((done / total) * 100) : 0 },
      batches,
    });
  }

  async function getFeed(queryString?: string) {
    const query = new URLSearchParams(queryString ?? "");
    const limit = Math.min(100, Math.max(1, Number(query.get("limit") ?? 10)));
    const offset = Math.max(0, Number(query.get("offset") ?? 0));
    const suites = await deps.repository.listSuites();
    const eligible = [];
    for (const suite of suites) {
      if (suite.origin === "canvas") continue;
      const [pipeline, tasks] = await Promise.all([
        pipelineRepository.getLatestRun(suite.id),
        deps.taskRepository?.listTasks(suite.id) ?? Promise.resolve([]),
      ]);
      const active = tasks.filter((task) => task.status !== "archived");
      if (!pipeline && !active.length) continue;
      const first = active.sort((a, b) => a.ordinal - b.ordinal)[0];
      let thumbnail = null;
      if (first && deps.taskRepository)
        thumbnail =
          (await deps.taskRepository.listTaskVersions(first.id)).versions.find((version) => version.isFinal) ??
          (await deps.taskRepository.listTaskVersions(first.id)).versions[0] ??
          null;
      eligible.push({
        suite,
        pipeline,
        card: thumbnail ? { taskId: first!.id, previewUrl: thumbnail.previewUrl, title: first!.title } : null,
      });
    }
    eligible.sort((a, b) => b.suite.createdAt.localeCompare(a.suite.createdAt));
    return ok({ items: eligible.slice(offset, offset + limit), total: eligible.length, limit, offset });
  }

  return { startRun, resumeRun, getStudioState, getFeed };
}
