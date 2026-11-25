import { createHash, randomUUID } from "node:crypto";
import { APLUS_MODULES } from "../../shared/aplus.js";
import type { ImageOptions } from "../../shared/model-settings.js";
import { errorMessages, fail } from "../api-errors.js";
import { now, ok } from "../api-response.js";
import { waitUntil } from "../suite-pipeline.js";
import type { PipelineRepository, PromptRepository, SuitePipelineRun, SuiteRepository, SuiteTask, TaskGenerationBatch, TaskRepository } from "../types.js";
import { selectAplusGenerationSize } from "./aplus-image.js";
import type { AplusRunConfig } from "./aplus-plan.js";
import type { createAplusPlanningApi } from "./aplus-planning-api.js";
import { renderAplusImagePrompt, resolveAplusPromptTemplate } from "./aplus-prompt.js";

interface AplusGenerationDependencies {
  planning: ReturnType<typeof createAplusPlanningApi>;
  repository: SuiteRepository;
  tasks?: TaskRepository;
  pipelines: PipelineRepository;
  prompts?: Pick<PromptRepository, "listPublished" | "getPublishedVersion">;
  resolveImageOptions(): Promise<ImageOptions>;
  createBatch(suiteId: string, tasks: SuiteTask[], key: string): Promise<{ batch: TaskGenerationBatch }>;
}

export function createAplusGenerationApi(deps: AplusGenerationDependencies) {
  const response = (run: SuitePipelineRun, status = 200) => ok({ suiteId: run.suiteId, runId: run.id }, status);

  function generate(run: SuitePipelineRun, generation: NonNullable<AplusRunConfig["generation"]>, taskRepository: TaskRepository) {
    const execute = async () => {
      await taskRepository.createAplusTasks(generation.tasks);
      const taskIds = new Set(generation.tasks.map((task) => task.id));
      const savedTasks = (await taskRepository.listTasks(run.suiteId)).filter((task) => taskIds.has(task.id));
      const generationKeyPrefix = `aplus:${run.id}:`;
      if (run.resumeCount) {
        const batches = await taskRepository.listBatches(run.suiteId);
        const interrupted = new Set(batches.filter((batch) => batch.status === "running" && batch.idempotencyKey.startsWith(generationKeyPrefix)).map((batch) => batch.id));
        if (interrupted.size) {
          const slots = await taskRepository.listSlots(run.suiteId);
          const interruptedSlots = new Set(slots.filter((slot) => interrupted.has(slot.batchId)).map((slot) => slot.id));
          for (const task of savedTasks) {
            const { attempts } = await taskRepository.listTaskVersions(task.id);
            for (const attempt of attempts) {
              if (attempt.status !== "running" || !interruptedSlots.has(attempt.slotId)) continue;
              try {
                await taskRepository.failAttempt(attempt.id, "PIPELINE_INTERRUPTED", errorMessages.PIPELINE_INTERRUPTED, now());
              } catch (error) {
                if (!(error instanceof Error) || error.message !== "INVALID_TASK_ATTEMPT") throw error;
              }
            }
          }
        }
      }
      const tasks = savedTasks.filter((task) => task.status !== "archived");
      const histories = () => Promise.all(tasks.map((task) => taskRepository.listTaskVersions(task.id)));
      const pending = (await histories()).flatMap((history, index) => history.versions.some((version) => version.isCurrent) ? [] : [tasks[index]]);

      let batchId: string | undefined;
      if (pending.length) {
        const { batch } = await deps.createBatch(run.suiteId, pending, `${generationKeyPrefix}r${run.resumeCount ?? 0}:images`);
        batchId = batch.id;
        await waitUntil(() => taskRepository.getBatch(batch.id), (current) => current !== null && current.status !== "running", 600_000);
      }

      const missing = (await histories()).filter((history) => !history.versions.some((version) => version.isCurrent));
      const batchSlots = missing.length && batchId
        ? new Set((await taskRepository.listSlots(run.suiteId)).filter((slot) => slot.batchId === batchId).map((slot) => slot.id))
        : null;
      const failure = missing.flatMap(({ attempts }) => attempts.filter((attempt) => attempt.status === "failed" && batchSlots?.has(attempt.slotId)))[0];
      await deps.pipelines.updateRun(run.id, {
        status: !missing.length ? "completed" : missing.length < tasks.length ? "partial_failed" : "failed",
        currentPhase: missing.length ? "image_generating" : "done",
        errorCode: missing.length ? failure?.errorCode ?? "IMAGE_GENERATION_FAILED" : null,
        errorMessage: missing.length ? failure?.errorMessage ?? errorMessages.IMAGE_GENERATION_FAILED : null,
        completedAt: now(),
      }, run);
    };

    void execute().catch((error) => {
      const code = error instanceof Error && Object.hasOwn(errorMessages, error.message) ? error.message : "IMAGE_GENERATION_FAILED";
      return deps.pipelines.updateRun(run.id, { status: "failed", errorCode: code, errorMessage: errorMessages[code], completedAt: now() }, run);
    }).catch((error) => console.error("A+ 出图状态保存失败", run.id, error));
  }

  async function confirm(suiteId: string, payload: unknown, key?: string) {
    const confirmationKey = key?.trim() || null;
    if (confirmationKey) {
      const loaded = await deps.planning.loadRun(suiteId);
      if (!loaded.ok) return loaded.response;
      if (loaded.value.config.generation?.confirmationKey === confirmationKey) return response(loaded.value.run);
    }

    const prepared = await deps.planning.prepareConfirmation(suiteId, payload);
    if (!prepared.ok) {
      if (confirmationKey && prepared.response.status === 409) {
        const current = await deps.planning.loadRun(suiteId);
        if (current.ok && current.value.config.generation?.confirmationKey === confirmationKey) return response(current.value.run);
      }
      return prepared.response;
    }
    const { run, config, planSnapshot, resolution } = prepared.value;
    if (!deps.tasks) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);
    if (!deps.prompts) return fail("PROMPT_REPOSITORY_NOT_CONFIGURED", 503);

    const [template, options, images] = await Promise.all([
      resolveAplusPromptTemplate(deps.prompts, "aplus_image"),
      deps.resolveImageOptions(),
      deps.repository.getInputImages(suiteId),
    ]);
    if (!template) return fail("PROMPT_TEMPLATE_NOT_FOUND", 409);
    const referenceImageIds = images.map((image) => image.id);
    if (!referenceImageIds.length) return fail("TASK_INVALID_SOURCE", 409);
    const createdAt = now();
    const { sizePresets, language } = config.inputSnapshot;
    let tasks: SuiteTask[];
    try {
      const sizes = sizePresets.map((preset) => selectAplusGenerationSize(preset, resolution, options));
      tasks = planSnapshot.modules.flatMap((module, moduleIndex) => sizePresets.map((sizePreset, presetIndex) => {
        const { moduleCode, copyRequirements } = module;
        const definition = APLUS_MODULES.find((item) => item.code === moduleCode)!;
        const { tier, ratio, size, generatedSize } = sizes[presetIndex];
        const pictureRequirement = module.imagePrompts[sizePreset]!;
        const promptDraft = renderAplusImagePrompt(template, {
          moduleCode, copyRequirements, language, sizePreset, generatedSize, generatedRatio: ratio,
          pictureRequirement: `整体风格：${planSnapshot.globalPlan}\n模块画面：${pictureRequirement}`,
        });
        const ordinal = moduleIndex * sizePresets.length + presetIndex + 1;
        return {
          id: randomUUID(), suiteId, planSnapshotId: null, planItemId: null, ordinal, imageType: "detail",
          title: definition.name, purpose: definition.description, promptDraft, promptRevision: 1,
          sourceInputImageId: referenceImageIds[0], referenceImageIds, status: "pending", archivedAt: null,
          createdAt, updatedAt: createdAt, originKind: "aplus", moduleCode, sizePreset, sortOrder: moduleIndex + 1,
          promptSha256: createHash("sha256").update(promptDraft).digest("hex"),
          generationParams: {
            size: tier, ratio, quality: "medium", requestSize: size, generatedSize,
            aplusPromptSnapshot: {
              templateVersionId: template.templateVersionId,
              planTemplateVersionId: planSnapshot.templateVersionId,
              moduleRuleVersionIds: planSnapshot.moduleRuleVersionIds,
              globalPlan: planSnapshot.globalPlan, pictureRequirement, copyRequirements, language,
            },
          },
        };
      }));
    } catch (error) {
      return fail(error instanceof Error && error.message === "IMAGE_SIZE_UNSUPPORTED" ? error.message : "IMAGE_GENERATION_FAILED", 409);
    }

    // Keep task IDs and frozen prompts with the phase change so resume can recreate any missing rows.
    const generation = { confirmationKey, tasks };
    const next = await deps.pipelines.updateRun(run.id, {
      status: "running", currentPhase: "image_generating", taskIds: tasks.map((task) => task.id),
      config: { ...config, generation, resolution }, errorCode: null, errorMessage: null, completedAt: null,
    }, run);
    if (!next) {
      const current = await deps.planning.loadRun(suiteId);
      return confirmationKey && current.ok && current.value.config.generation?.confirmationKey === confirmationKey
        ? response(current.value.run)
        : fail("APLUS_PLAN_CHANGED", 409);
    }
    generate(next, generation, deps.tasks);
    return response(next, 202);
  }

  async function resume(suiteId: string, key?: string) {
    if (!key?.trim()) return fail("MISSING_IDEMPOTENCY_KEY");
    const loaded = await deps.planning.loadRun(suiteId);
    if (!loaded.ok) return loaded.response;
    const { run, config } = loaded.value;
    const generation = config.generation;
    if (!generation) return deps.planning.resume(suiteId, key);
    const usedKey = (value: SuitePipelineRun) => value.resumeKeys?.includes(key) || value.lastResumeKey === key;
    if (usedKey(run)) return response(run, run.status === "running" ? 202 : 200);
    if (run.currentPhase !== "image_generating" || (run.status !== "failed" && run.status !== "partial_failed")) {
      return fail("APLUS_PLAN_ACTION_NOT_ALLOWED", 409);
    }
    if (!deps.tasks) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);

    const next = await deps.pipelines.resumeRun(run, key, "image_generating", config);
    if (!next) {
      const current = await deps.pipelines.getRun(run.id);
      return current && usedKey(current) ? response(current, current.status === "running" ? 202 : 200) : fail("APLUS_PLAN_ACTION_NOT_ALLOWED", 409);
    }
    generate(next, generation, deps.tasks);
    return response(next, 202);
  }

  return { confirm, resume };
}
