import { storeAplusDelivery } from "../aplus/aplus-image.js";
import { errorMessages } from "../api-errors.js";
import { asRecord } from "../api-response.js";
import { isStoredProductImageReference } from "../library-reference-policy.js";
import { IMAGE_QUALITIES, resolveClosestImageSize, resolveImageSize, type ImageQuality } from "../../shared/model-settings.js";
import { PURE_WHITE_MAIN_IMAGE_REQUIREMENTS } from "../../shared/platform-main-background.js";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { processGeneratedImage } from "../image.js";
import { buildReplicaRolePrefix, resolveReplicaCloneLevel } from "../replica/replica-pipeline.js";
import { buildProviderImagePrompt } from "../suite-task-prompt.js";
import { applyStyleOverrideToPrompt } from "../../shared/workbench-delivery.js";
import { declareImageEditInputs, imageEditProductInputs } from "../image-editor.js";
import type {
  ImageProvider,
  PlanSnapshot,
  SuiteTask,
  TaskGenerationAttempt,
  TaskGenerationBatch,
  TaskImageVersion,
  TaskResultSlot,
  ReverseRepository,
  PipelineRepository,
  ReplicaRepository,
} from "../types.js";
import type { StudioDependencies } from "../app-dependencies.js";
import type { createModelResolvers } from "./model-resolvers.js";

function extensionForImageMime(mimeType: string): string {
  const lower = mimeType.toLowerCase();
  if (lower.includes("jpeg") || lower.includes("jpg")) return "jpg";
  if (lower.includes("webp")) return "webp";
  return "png";
}

function taskVersionProductInputs(version: TaskImageVersion, versions: TaskImageVersion[]) {
  const products = imageEditProductInputs(version.contextSnapshot.inputImages);
  // Older single-card generations recorded their preceding output as the sole product input.
  if (products.length === 1 && Array.isArray(version.contextSnapshot.inputImages) && version.contextSnapshot.inputImages.length === 1) {
    const preceding = versions.find((item) => item.objectKey === products[0].objectKey && item.versionNumber < version.versionNumber);
    if (preceding) return taskVersionProductInputs(preceding, versions);
  }
  return products;
}

interface TaskGenerationServices {
  resolveImage: ReturnType<typeof createModelResolvers>["resolveImage"];
  clearReplicaCardFinalLocks(task: SuiteTask): Promise<void>;
  pipelineRepository: PipelineRepository;
  reverseRepository: ReverseRepository;
  replicaRepository: ReplicaRepository;
}

export function createTaskGeneration(deps: StudioDependencies, {
  resolveImage, clearReplicaCardFinalLocks, pipelineRepository, reverseRepository, replicaRepository,
}: TaskGenerationServices) {
  const imageGenerationConcurrency = Math.max(1, Math.floor(Number.isFinite(deps.imageGenerationConcurrency) ? deps.imageGenerationConcurrency! : 3));
  const createTaskBatch = async (suiteId: string, tasks: SuiteTask[], kind: "batch" | "single" | "retry", idempotencyKey: string, failedAttempt?: TaskGenerationAttempt, sourceVersionIds: Record<string, string> = {}, editSource?: { version: TaskImageVersion; versions: TaskImageVersion[]; promptSuffix: string }, singleTaskPrompt?: string) => {
    if (!deps.taskRepository) throw new Error("TASK_REPOSITORY_NOT_CONFIGURED");
    const existing = (await deps.taskRepository.listBatches(suiteId)).find((batch) => batch.idempotencyKey === idempotencyKey);
    if (existing) return { batch: existing, duplicate: true };
    if (failedAttempt && (failedAttempt.contextSnapshot.sourceRevision ?? 0) !== (tasks[0].sourceRevision ?? 0)) {
      throw new Error("TASK_RETRY_INPUT_CHANGED");
    }
    const { provider, model, channel, imageOptions } = await resolveImage();
    if (deps.modelSettings && !provider) throw new Error("TASK_IMAGE_PROVIDER_NOT_CONFIGURED");
    const now = new Date().toISOString();
    const [suiteForStyle, latestPlanSnapshot] = await Promise.all([
      deps.repository.getSuite(suiteId),
      deps.planRepository ? deps.planRepository.getLatestSnapshot(suiteId) : Promise.resolve(null),
    ]);
    const activeStyleOverride = suiteForStyle?.styleOverride?.trim() || null;
    const planTemplateVersionId = latestPlanSnapshot?.templateVersionId ?? null;
    const batch: TaskGenerationBatch = { id: randomUUID(), suiteId, kind, requestedCount: tasks.length, taskIds: tasks.map((task) => task.id), status: "running", idempotencyKey, createdAt: now, startedAt: now, finishedAt: null };
    const slots: TaskResultSlot[] = tasks.map((task, index) => ({ id: randomUUID(), batchId: batch.id, taskId: task.id, slotOrdinal: index + 1, retryOfSlotId: failedAttempt?.slotId ?? null, status: "generating", selectedVersionId: null, createdAt: now, completedAt: null }));
    const attempts: TaskGenerationAttempt[] = [];
    const taskPlans = new Map<string, PlanSnapshot | null>();
    if (latestPlanSnapshot) taskPlans.set(latestPlanSnapshot.id, latestPlanSnapshot);
    for (const [index, task] of tasks.entries()) {
      const providerName = channel ? "openai-compatible-image" : provider ? "image-provider" : "unconfigured";
      const generationParams = task.generationParams ?? {};
      const isAplusTask = task.originKind === "aplus";
      const aplusRequestSize = isAplusTask && typeof generationParams.requestSize === "string" ? generationParams.requestSize : null;
      const aplusSizeFields = isAplusTask ? {
        ratio: generationParams.ratio,
        generatedSize: generationParams.generatedSize,
      } : {};
      if (failedAttempt) {
        attempts.push({
          ...failedAttempt, id: randomUUID(), slotId: slots[index].id, attemptNo: 1,
          provider: providerName, model, contextSnapshot: { ...failedAttempt.contextSnapshot, channel, model },
          status: "running", errorCode: null, errorMessage: null, externalRequestId: null, startedAt: now, finishedAt: null,
        });
        continue;
      }
      if (editSource?.version.taskId === task.id) {
        const { version, versions } = editSource;
        const attachedInputs = taskVersionProductInputs(version, versions);
        const inputImages = [
          { objectKey: version.objectKey, role: "source", filename: `source.${extensionForImageMime(version.mimeType)}` },
          ...attachedInputs.map((input, i) => ({ ...input, filename: `product-${i + 1}` })),
        ];
        const frozenPrompt = String(version.promptSnapshot.finalPrompt ?? version.promptSnapshot.prompt ?? "");
        const finalPrompt = declareImageEditInputs(frozenPrompt + editSource.promptSuffix, attachedInputs);
        const providerPrompt = declareImageEditInputs(String(version.promptSnapshot.providerPrompt ?? frozenPrompt) + editSource.promptSuffix, attachedInputs);
        const stored = await deps.storage.get(version.objectKey);
        if (!stored) throw new Error("TASK_INVALID_SOURCE");
        const { width, height } = await sharp(stored.bytes).metadata();
        attempts.push({
          id: randomUUID(), slotId: slots[index].id, attemptNo: 1, provider: providerName, model, endpoint: "/v1/images/edits",
          requestSummary: {
            n: 1, imageCount: inputImages.length, inputRoles: inputImages.map((image) => image.role),
            size: aplusRequestSize ?? resolveClosestImageSize(width, height, imageOptions), quality: imageOptions.quality ?? "high",
            ...aplusSizeFields,
          },
          promptSnapshot: { ...version.promptSnapshot, finalPrompt, providerPrompt, inputImages },
          promptSha256: createHash("sha256").update(finalPrompt).digest("hex"),
          contextSnapshot: {
            ...version.contextSnapshot, channel, model, suiteTaskId: task.id, sourceRevision: task.sourceRevision ?? 0,
            tool: "regenerate", sourceVersionId: version.id, inputImages, attachedInputs,
          },
          sourceKind: "original", sourceObjectKey: version.objectKey, sourceInputImageId: null,
          sourceBaseVersionId: null, sourceLibraryReferenceId: null, sourceResourceVersionId: null,
          status: "running", errorCode: null, errorMessage: null, externalRequestId: null, startedAt: now, finishedAt: null,
        });
        continue;
      }
      if (task.planSnapshotId && deps.planRepository && !taskPlans.has(task.planSnapshotId))
        taskPlans.set(task.planSnapshotId, await deps.planRepository.getSnapshot(task.planSnapshotId));
      const taskPlan = task.planSnapshotId ? taskPlans.get(task.planSnapshotId) : null;
      const useOriginalImages = taskPlan?.requestSummary.useOriginalImages === true;
      let sourceKind: "base" | "original" | "library" = "original"; let sourceObjectKey = ""; let sourceBaseVersionId: string | null = null; let sourceInputImageId: string | null = null; let sourceLibraryReferenceId: string | null = null; let sourceResourceVersionId: string | null = null;
      const materialRefs = Array.isArray(generationParams.productMaterialRefs) ? generationParams.productMaterialRefs.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object").slice(0, 3) : [];
      const inputImages: Array<{ bytes: Buffer; mimeType: string; filename: string; role: string; objectKey: string; resourceId?: string; resourceVersionId?: string; libraryReferenceId?: string }> = [];
      const currentTaskVersionId = sourceVersionIds[task.id];
      const isReplicaTask = task.originKind === "replica";
      const aplusPromptMeta = isAplusTask ? asRecord(generationParams.aplusPromptSnapshot) : null;
      const replicaPromptMeta = isReplicaTask ? asRecord(generationParams.replicaPromptSnapshot) : null;
      const replicaCloneLevel = isReplicaTask ? resolveReplicaCloneLevel(generationParams) : "high";
      let replicaProductCount = 0;

      if (isAplusTask) {
        for (const imageId of task.referenceImageIds ?? []) {
          const original = await deps.repository.getInputImage(suiteId, imageId);
          if (!original) throw new Error("TASK_INVALID_SOURCE");
          const stored = await deps.storage.get(original.originalObjectKey);
          if (!stored) throw new Error("TASK_INVALID_SOURCE");
          inputImages.push({
            bytes: stored.bytes,
            mimeType: stored.contentType,
            filename: `product-${inputImages.length + 1}.${extensionForImageMime(stored.contentType)}`,
            role: "product",
            objectKey: original.originalObjectKey,
          });
        }
        if (!inputImages.length) throw new Error("TASK_INVALID_SOURCE");
        sourceObjectKey = inputImages[0].objectKey;
        sourceInputImageId = task.sourceInputImageId;
      } else if (isReplicaTask) {
        const replicaProducts = await replicaRepository.listProductImages(suiteId);
        replicaProductCount = replicaProducts.length;
        for (const [productIndex, product] of replicaProducts.entries()) {
          const stored = await deps.storage.get(product.objectKey);
          if (!stored) throw new Error("TASK_INVALID_SOURCE");
          const fallbackFilename = `product-${productIndex + 1}.${extensionForImageMime(stored.contentType)}`;
          const resolvedFilename =
            product.sourceKind === "upload" && product.filename && /\.(png|jpe?g|webp)$/i.test(product.filename)
              ? product.filename
              : fallbackFilename;
          inputImages.push({
            bytes: stored.bytes,
            mimeType: stored.contentType,
            filename: resolvedFilename,
            role: productIndex === 0 ? "product_primary" : "product_detail",
            objectKey: product.objectKey,
            resourceId: product.libraryResourceId ?? undefined,
            resourceVersionId: product.resourceVersionId ?? undefined,
          });
        }
        const firstProduct = replicaProducts[0];
        if (firstProduct) {
          sourceKind = firstProduct.sourceKind === "library" ? "library" : "original";
          sourceObjectKey = firstProduct.objectKey;
          sourceResourceVersionId = firstProduct.resourceVersionId ?? null;
        }
      } else {
        if (!currentTaskVersionId && materialRefs.length && deps.libraryRepository) {
          const references = await deps.libraryRepository.listReferences(suiteId, "task", task.id);
          for (const [materialIndex, material] of materialRefs.entries()) {
            const referenceId = typeof material.libraryReferenceId === "string" ? material.libraryReferenceId : "";
            const reference = references.find((item) => item.id === referenceId);
            const source = reference?.snapshot.source as Record<string, unknown> | undefined;
            if (!reference || !isStoredProductImageReference(reference) || typeof source?.objectKey !== "string") throw new Error("TASK_INVALID_SOURCE");
            const stored = await deps.storage.get(source.objectKey);
            if (!stored) throw new Error("TASK_INVALID_SOURCE");
            inputImages.push({ bytes: stored.bytes, mimeType: stored.contentType, filename: `product-${materialIndex + 1}.png`, role: materialIndex === 0 ? "product_primary" : "product_detail", objectKey: source.objectKey, resourceId: reference.resourceId, resourceVersionId: reference.resourceVersionId, libraryReferenceId: reference.id });
          }
          const first = inputImages[0];
          if (first) {
            const reference = references.find((item) => item.id === first.libraryReferenceId);
            sourceKind = "library"; sourceObjectKey = first.objectKey; sourceLibraryReferenceId = first.libraryReferenceId ?? null; sourceResourceVersionId = first.resourceVersionId ?? null;
            sourceBaseVersionId = typeof reference?.snapshot.baseVersionId === "string" ? reference.snapshot.baseVersionId : null;
          }
        }
        if (currentTaskVersionId) {
          const history = await deps.taskRepository.listTaskVersions(task.id);
          const current = history.versions.find((version) => version.id === currentTaskVersionId && version.isCurrent);
          if (!current) throw new Error("TASK_CURRENT_VERSION_NOT_FOUND");
          sourceKind = "original";
          sourceObjectKey = current.objectKey;
          sourceBaseVersionId = null;
          sourceInputImageId = task.sourceInputImageId;
        } else if (!inputImages.length && task.sourceLibraryReferenceId && deps.libraryRepository) {
          const reference = (await deps.libraryRepository.listReferences(suiteId, "task", task.id)).find((item) => item.id === task.sourceLibraryReferenceId);
          const source = reference?.snapshot.source as Record<string, unknown> | undefined;
          if (!reference || !isStoredProductImageReference(reference) || typeof source?.objectKey !== "string") throw new Error("TASK_INVALID_SOURCE");
          sourceKind = "library"; sourceObjectKey = source.objectKey; sourceLibraryReferenceId = reference.id; sourceResourceVersionId = reference.resourceVersionId;
          sourceBaseVersionId = typeof reference.snapshot.baseVersionId === "string" ? reference.snapshot.baseVersionId : null;
        } else if (!inputImages.length) {
          if (!task.sourceInputImageId) throw new Error("TASK_INVALID_SOURCE");
          const image = await deps.repository.getInputImage(suiteId, task.sourceInputImageId);
          if (!image) throw new Error("TASK_INVALID_SOURCE");
          sourceKind = "original"; sourceObjectKey = image.originalObjectKey; sourceInputImageId = image.id;
          if (!useOriginalImages && image.currentBaseVersionId) { const base = await deps.repository.getBaseImageVersion(suiteId, image.id, image.currentBaseVersionId); if (base) { sourceKind = "base"; sourceObjectKey = base.objectKey; sourceBaseVersionId = base.id; } }
        }
        if (!inputImages.length) {
          const stored = await deps.storage.get(sourceObjectKey);
          inputImages.push({ bytes: stored?.bytes ?? Buffer.alloc(0), mimeType: stored?.contentType ?? "image/png", filename: task.title.replace(/[^\w.-]+/g, "_") + ".png", role: "product", objectKey: sourceObjectKey });
        }
      }

      // Generalized reference image injection for both replica and reverse_import tasks.
      // For replica compose with product images, omit the reference image so the image model
      // redesigns the scene from text while anchoring strictly to the product images.
      let referenceInjection: { objectKey: string; filename: string; role: string; required: boolean } | null = null;
      if (isReplicaTask && (replicaCloneLevel !== "compose" || replicaProductCount === 0)) {
        const refObjectKey =
          task.replicaReferenceObjectKey ||
          (task.replicaReferenceId
            ? (await replicaRepository.getReference(suiteId, task.replicaReferenceId))?.objectKey ?? null
            : null);
        if (!refObjectKey) throw new Error("TASK_INVALID_SOURCE");
        referenceInjection = {
          objectKey: refObjectKey,
          filename: "replica-reference.png",
          role: "replica_reference",
          required: true,
        };
      } else if (task.originKind === "reverse_import" && generationParams.explosiveReferenceEnabled !== false && task.reversePlanId && task.reverseReferenceId) {
        const ref = await reverseRepository.getPlan(task.reversePlanId).then((plan) => plan?.references.find((item) => item.id === task.reverseReferenceId));
        if (ref?.objectKey) {
          referenceInjection = {
            objectKey: ref.objectKey,
            filename: "explosive-reference.png",
            role: "explosive_reference",
            required: false,
          };
        }
      }
      if (referenceInjection) {
        const stored = await deps.storage.get(referenceInjection.objectKey);
        if (!stored) {
          if (referenceInjection.required) throw new Error("TASK_INVALID_SOURCE");
        } else {
          inputImages.push({
            bytes: stored.bytes,
            mimeType: stored.contentType,
            filename: referenceInjection.filename,
            role: referenceInjection.role,
            objectKey: referenceInjection.objectKey,
          });
          if (!sourceObjectKey) {
            sourceKind = "original";
            sourceObjectKey = referenceInjection.objectKey;
          }
        }
      }

      const inputSnapshot = inputImages.map((item) => ({ role: item.role, filename: item.filename, mimeType: item.mimeType, resourceId: item.resourceId ?? null, resourceVersionId: item.resourceVersionId ?? null, libraryReferenceId: item.libraryReferenceId ?? null, objectKey: item.objectKey }));
      const shouldApplyStyleOverride = Boolean(activeStyleOverride) && task.originKind !== "reverse_import" && !isReplicaTask && !isAplusTask;
      const replicaRolePrefix = isReplicaTask ? buildReplicaRolePrefix(replicaProductCount, replicaCloneLevel) : null;
      const finalPrompt = isReplicaTask
        ? (task.promptDraft.startsWith(replicaRolePrefix!) ? task.promptDraft : `${replicaRolePrefix}\n${task.promptDraft}`)
        : (shouldApplyStyleOverride ? applyStyleOverrideToPrompt(task.promptDraft, activeStyleOverride) : task.promptDraft);
      const pureWhiteMain =
        !isReplicaTask &&
        task.categoryCode === "main" &&
        (taskPlan?.dynamicInput.main_image_background === "pure_white_required" ||
          finalPrompt.includes(PURE_WHITE_MAIN_IMAGE_REQUIREMENTS));
      const providerPrompt = buildProviderImagePrompt(finalPrompt, {
        categoryCode: isReplicaTask ? null : (task.categoryCode ?? null),
        pureWhiteMain,
      });
      const effectiveGlobalStyleCard = shouldApplyStyleOverride
        ? { ...(task.globalStyleCard ?? {}), promptPrefix: activeStyleOverride, overridden: true }
        : (task.globalStyleCard ?? {});
      const effectiveTemplateVersionId =
        (typeof aplusPromptMeta?.templateVersionId === "string" ? aplusPromptMeta.templateVersionId : null) ??
        (typeof replicaPromptMeta?.templateVersionId === "string" ? replicaPromptMeta.templateVersionId : null) ??
        planTemplateVersionId;
      const effectivePromptSha256 =
        isReplicaTask || shouldApplyStyleOverride
          ? createHash("sha256").update(finalPrompt).digest("hex")
          : (task.promptSha256 ?? createHash("sha256").update(finalPrompt).digest("hex"));
      const replicaFrozenFields = isReplicaTask
        ? {
            sharedStyle: replicaPromptMeta?.sharedStyle ?? null,
            copy: Array.isArray(replicaPromptMeta?.copy) ? replicaPromptMeta.copy : [],
            visualStructure:
              replicaPromptMeta?.visualStructure && typeof replicaPromptMeta.visualStructure === "object"
                ? replicaPromptMeta.visualStructure
                : {},
            cloneLevel: replicaPromptMeta?.cloneLevel ?? generationParams.cloneLevel ?? replicaCloneLevel,
            sceneType: replicaPromptMeta?.sceneType ?? generationParams.sceneType ?? null,
            language: replicaPromptMeta?.language ?? generationParams.language ?? null,
            replicaReferenceId: task.replicaReferenceId ?? null,
            styleSketch: replicaProductCount === 0,
          }
        : {};
      const aplusFrozenFields = isAplusTask ? {
        ...aplusPromptMeta, moduleCode: task.moduleCode, sizePreset: task.sizePreset, sortOrder: task.sortOrder,
      } : {};
      const size = aplusRequestSize ?? resolveImageSize(
        typeof generationParams.size === "string" ? generationParams.size : "1K",
        typeof generationParams.ratio === "string" ? generationParams.ratio : task.imageType === "main" ? "1:1" : "3:4",
        imageOptions.sizeMode,
      );
      const styleOverride = shouldApplyStyleOverride ? activeStyleOverride : null;
      attempts.push({
        id: randomUUID(), slotId: slots[index].id, attemptNo: 1, provider: providerName, model, endpoint: "/v1/images/edits",
        requestSummary: {
          n: 1, imageCount: inputImages.length, inputRoles: inputImages.map((item) => item.role),
          size, quality: generationParams.quality ?? "medium", ...aplusSizeFields,
        },
        promptSnapshot: {
          prompt: task.promptDraft, promptRevision: task.promptRevision, planSnapshotId: task.planSnapshotId,
          planItemId: task.planItemId, templateVersionId: effectiveTemplateVersionId,
          reversePromptVersionId: task.reversePromptVersionId ?? null, categoryCode: task.categoryCode ?? null,
          referenceImageIds: task.referenceImageIds ?? [], factRefs: task.factRefs ?? [],
          globalStyleCard: effectiveGlobalStyleCard, styleOverride, ...replicaFrozenFields, ...aplusFrozenFields,
          finalPrompt, providerPrompt, generationParams, productMaterialRefs: materialRefs,
          explosiveReferenceEnabled: generationParams.explosiveReferenceEnabled !== false, inputImages: inputSnapshot,
        },
        promptSha256: effectivePromptSha256,
        contextSnapshot: {
          channel, model, suiteTaskId: task.id, planSnapshotId: task.planSnapshotId, planItemId: task.planItemId,
          templateVersionId: effectiveTemplateVersionId, reversePlanId: task.reversePlanId ?? null,
          reverseReferenceId: task.reverseReferenceId ?? null, replicaReferenceId: task.replicaReferenceId ?? null,
          sourceRevision: task.sourceRevision ?? 0, imageType: task.imageType, categoryCode: task.categoryCode ?? null,
          globalStyleCard: effectiveGlobalStyleCard, styleOverride,
          inputImages: inputImages.map(({ objectKey, mimeType, filename, role }) => ({ objectKey, mimeType, filename, role })),
        },
        sourceKind, sourceObjectKey, sourceInputImageId, sourceBaseVersionId, sourceLibraryReferenceId, sourceResourceVersionId,
        status: "running", errorCode: null, errorMessage: null, externalRequestId: null, startedAt: now, finishedAt: null,
      });
    }
    const reservation = await deps.taskRepository.beginBatch({ batch, slots, attempts }, singleTaskPrompt);
    if (!reservation.duplicate) {
      const jobs = attempts.map((attempt, index) => ({
        attempt,
        task: tasks.find((task) => task.id === attempt.contextSnapshot.suiteTaskId) ?? tasks[index],
        slot: slots.find((slot) => slot.id === attempt.slotId)!,
      }));
      let cursor = 0;
      const workerCount = Math.min(imageGenerationConcurrency, jobs.length);
      for (let worker = 0; worker < workerCount; worker += 1) {
        void (async () => {
          while (cursor < jobs.length) {
            const job = jobs[cursor++];
            await executeTaskAttempt(job.attempt, job.task, job.slot, provider);
          }
        })();
      }
    }
    return reservation;
  };

  const classifyTaskImageError = (error: unknown) => {
    if (!(error instanceof Error)) return "TASK_IMAGE_PROVIDER_FAILED";
    switch (error.message) {
      case "INVALID_PROVIDER_RESPONSE":
      case "INVALID_GENERATED_IMAGE":
        return "INVALID_GENERATED_IMAGE";
      case "IMAGE_SIZE_UNSUPPORTED":
      case "IMAGE_MASK_UNSUPPORTED":
      case "IMAGE_REFERENCE_LIMIT_EXCEEDED":
        return error.message;
      default:
        return error.message.includes("TIMEOUT") ? "TASK_IMAGE_PROVIDER_TIMEOUT" : "TASK_IMAGE_PROVIDER_FAILED";
    }
  };

  const executeTaskAttempt = async (attempt: TaskGenerationAttempt, task: SuiteTask, slot: TaskResultSlot, provider: ImageProvider | undefined) => {
    if (!deps.taskRepository) return;
    const finish = new Date().toISOString();
    try {
      if (task.originKind === "aplus" && (await deps.taskRepository.getAttempt(attempt.id))?.status !== "running") return;
      if (!provider) { await deps.taskRepository.failAttempt(attempt.id, "TASK_IMAGE_PROVIDER_NOT_CONFIGURED", errorMessages.TASK_IMAGE_PROVIDER_NOT_CONFIGURED, finish); return; }
      const source = await deps.storage.get(attempt.sourceObjectKey);
      if (!source) { await deps.taskRepository.failAttempt(attempt.id, "TASK_INVALID_SOURCE", errorMessages.TASK_INVALID_SOURCE, finish); return; }
      const snapshotInputs = Array.isArray(attempt.contextSnapshot.inputImages) ? attempt.contextSnapshot.inputImages as Array<Record<string, unknown>> : [];
      const images = snapshotInputs.length ? (await Promise.all(snapshotInputs.map(async (item) => { const objectKey = typeof item.objectKey === "string" ? item.objectKey : ""; const stored = objectKey ? await deps.storage.get(objectKey) : null; return stored ? { bytes: stored.bytes, mimeType: stored.contentType, filename: String(item.filename ?? "reference.png"), role: String(item.role ?? "reference") } : null; }))).filter((item): item is { bytes: Buffer; mimeType: string; filename: string; role: string } => Boolean(item)) : [{ bytes: source.bytes, mimeType: source.contentType, filename: task.title.replace(/[^\w.-]+/g, "_") + ".png", role: "product" }];
      if (snapshotInputs.length && images.length !== snapshotInputs.length) {
        await deps.taskRepository.failAttempt(attempt.id, "TASK_INVALID_SOURCE", errorMessages.TASK_INVALID_SOURCE, finish);
        return;
      }
      if (images.length > 1 && provider.supportsMultipleImages === false) { await deps.taskRepository.failAttempt(attempt.id, "TASK_PROVIDER_MULTI_IMAGE_UNSUPPORTED", "当前图片模型不支持多图输入", finish); return; }
      const frozenQuality = IMAGE_QUALITIES.find((quality) => quality === attempt.requestSummary.quality);
      const quality: ImageQuality = attempt.contextSnapshot.tool === "regenerate" ? frozenQuality ?? "high" : "medium";
      const editRequest: Parameters<ImageProvider["edit"]>[0] = { requestId: attempt.id, flow: "suite-task-generation", endpoint: "/v1/images/edits", image: images[0].bytes, imageMimeType: images[0].mimeType, imageFilename: images[0].filename, images, model: attempt.model, prompt: String(attempt.promptSnapshot.providerPrompt ?? attempt.promptSnapshot.finalPrompt), size: String(attempt.requestSummary.size ?? "1K"), quality, n: 1, responseFormat: "b64_json" };
      const generated = await provider.edit(editRequest);
      if (task.originKind === "aplus" && (await deps.taskRepository.getAttempt(attempt.id))?.status !== "running") return;
      const processed = await processGeneratedImage(generated.bytes);
      const objectKey = `suites/${task.suiteId}/tasks/${task.id}/versions/${randomUUID()}/final.png`;
      await deps.storage.put({ key: objectKey, bytes: processed.bytes, contentType: processed.mimeType });
      if (task.originKind === "replica") {
        await clearReplicaCardFinalLocks(task);
      }
      const delivery = task.originKind === "aplus" && task.sizePreset
        ? await storeAplusDelivery(deps.storage, task.sizePreset, processed, objectKey)
        : {};
      await deps.taskRepository.completeAttempt({ attemptId: attempt.id, slotId: slot.id, taskId: task.id, objectKey, processObjectKeys: [], sha256: processed.sha256, width: processed.width, height: processed.height, mimeType: processed.mimeType, completedAt: new Date().toISOString(), ...delivery });
      const latestRun = await pipelineRepository.getLatestRun(task.suiteId);
      if (latestRun && (latestRun.status === "partial_failed" || latestRun.status === "failed")) {
        const activeTasks = (await deps.taskRepository.listTasks(task.suiteId)).filter((item) => item.status !== "archived");
        if (activeTasks.length > 0) {
          const histories = await Promise.all(activeTasks.map((item) => deps.taskRepository!.listTaskVersions(item.id)));
          if (histories.every((history) => history.versions.some((version) => version.isCurrent))) {
            const convergedAt = new Date().toISOString();
            await pipelineRepository.updateRun(latestRun.id, {
              status: "completed",
              currentPhase: "done",
              errorCode: null,
              errorMessage: null,
              updatedAt: convergedAt,
              completedAt: latestRun.completedAt ?? convergedAt,
            });
          }
        }
      }
    } catch (error) {
      const code = classifyTaskImageError(error);
      await deps.taskRepository.failAttempt(attempt.id, code, errorMessages[code], new Date().toISOString()).catch(() => undefined);
    }
  };

  return createTaskBatch;
}
