import { previewStorageObject } from "../http/binary-response.js";
import { taskVersionView } from "../suite-views.js";
import { fail, errorMessages } from "../api-errors.js";
import { ok, asRecord, type AppResponse } from "../api-response.js";
import { randomUUID } from "node:crypto";
import { processGeneratedImage, processImage } from "../image.js";
import { renderPromptTemplate, validateDynamicInput } from "../prompt-library.js";
import type { BaseImageVersion, GenerationAttempt, InputImage, SuiteAggregate, SuiteRepository, UploadFile } from "../types.js";
import { observedPromptLoad } from "../services/prompt-load.js";
import type { Router } from "../http/router.js";
import type { StudioServices } from "../services/studio-services.js";

function versionView(version: BaseImageVersion) {
  return {
    id: version.id,
    attemptId: version.attemptId,
    versionNumber: version.versionNumber,
    width: version.width,
    height: version.height,
    mimeType: version.mimeType,
    sha256: version.sha256,
    createdAt: version.createdAt,
    previewUrl: `/api/suites/${version.suiteId}/input-images/${version.inputImageId}/base-versions/${version.id}/preview`,
  };
}
function attemptView(attempt: GenerationAttempt) {
  return {
    id: attempt.id,
    versionNumber: attempt.versionNumber,
    status: attempt.status,
    model: attempt.model,
    channel: attempt.channel,
    templateVersionId: attempt.promptTemplateVersionId,
    errorCode: attempt.errorCode,
    errorMessage: attempt.errorMessage,
    createdAt: attempt.createdAt,
    completedAt: attempt.completedAt,
  };
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(code)), milliseconds); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function registerSuiteRoutes(router: Router, { deps, pipeline, resolveImage }: StudioServices) {
  const uploadIdempotency = new Map<string, InputImage>();
  const upload = async (suiteId: string, file: UploadFile): Promise<AppResponse> => {
    const suite = await deps.repository.getSuite(suiteId);
    if (!suite) return fail("INVALID_SUITE_ID", 404);
    if (suite.origin === "aplus") return fail("INPUT_IMAGE_HAS_HISTORY", 409);
    if (file.idempotencyKey && uploadIdempotency.has(`${suiteId}:${file.idempotencyKey}`)) return ok(uploadIdempotency.get(`${suiteId}:${file.idempotencyKey}`)!, 201);
    const images = await deps.repository.getInputImages(suiteId);
    if (images.length >= 6 && !file.idempotencyKey) return fail("TOO_MANY_IMAGES", 400);
    const ordinal = file.ordinal ?? (images.length ? Math.max(...images.map((image) => image.ordinal)) + 1 : 1);
    if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 6) return fail("INVALID_ORDINAL");
    let processed;
    try { processed = await processImage(file.bytes, file.mimeType); } catch (error) { return fail(error instanceof Error ? error.message : "INVALID_IMAGE"); }
    if (await deps.repository.hasInputImageHash(suiteId, processed.sha256)) return fail("DUPLICATE_IMAGE", 409);
    const inputId = randomUUID();
    const originalObjectKey = `suites/${suiteId}/inputs/${inputId}/original`;
    const thumbnailObjectKey = `suites/${suiteId}/inputs/${inputId}/thumbnail`;
    const generationInputObjectKey = `suites/${suiteId}/inputs/${inputId}/generation-input.jpg`;
    try {
      await deps.storage.put({ key: originalObjectKey, bytes: file.bytes, contentType: processed.mimeType });
      await deps.storage.put({ key: thumbnailObjectKey, bytes: processed.thumbnail, contentType: "image/jpeg" });
      await deps.storage.put({ key: generationInputObjectKey, bytes: processed.generationInput, contentType: "image/jpeg" });
      const createdAt = new Date().toISOString();
      const image = await deps.repository.createInputImage({ id: inputId, suiteId, ordinal, originalObjectKey, thumbnailObjectKey, sha256: processed.sha256, width: processed.width, height: processed.height, mimeType: processed.mimeType, originalFilename: file.filename, currentBaseVersionId: null, createdAt }, file.idempotencyKey);
      if (file.idempotencyKey) uploadIdempotency.set(`${suiteId}:${file.idempotencyKey}`, image);
      return ok(image, 201);
    } catch (error) {
      await deps.storage.delete(originalObjectKey).catch(() => undefined);
      await deps.storage.delete(thumbnailObjectKey).catch(() => undefined);
      await deps.storage.delete(generationInputObjectKey).catch(() => undefined);
      const code = error instanceof Error ? error.message : "UPLOAD_FAILED";
      return fail(code, code === "DUPLICATE_ORDINAL" || code === "DUPLICATE_IMAGE" ? 409 : 500);
    }
  };

  const preview = async (suiteId: string, imageId: string, kind: "original" | "thumbnail") => {
    const image = await deps.repository.getInputImage(suiteId, imageId);
    if (!image) return fail("INVALID_INPUT_IMAGE", 404);
    return previewStorageObject(deps.storage, kind === "original" ? image.originalObjectKey : image.thumbnailObjectKey);
  };

  const previewBaseVersion = async (suiteId: string, imageId: string, versionId: string) => {
    const version = await deps.repository.getBaseImageVersion(suiteId, imageId, versionId);
    if (!version) return fail("INVALID_BASE_VERSION", 404);
    return previewStorageObject(deps.storage, version.objectKey);
  };

  router.post("/api/suites/one-click-generate", ({ idempotencyKey, body: requestBody }) => pipeline.startRun(idempotencyKey, requestBody));

  router.post("/api/suites/:suiteId/pipeline", async ({ params, idempotencyKey, body: requestBody }) => {
    return pipeline.startRun(idempotencyKey, {
      ...asRecord(requestBody),
      suiteId: params.suiteId,
    });
  });

  router.post("/api/suites/:suiteId/one-click-generate/resume", ({ params, idempotencyKey, body: requestBody }) => pipeline.resumeRun(params.suiteId, idempotencyKey, requestBody));

  router.get("/api/suites/:suiteId/studio-state", ({ params }) => pipeline.getStudioState(params.suiteId));

  router.get("/api/suites/feed", ({ query }) => pipeline.getFeed(query.toString()));

  router.post("/api/suites", async ({ idempotencyKey, body: requestBody }) => {
    const body = asRecord(requestBody, { allowArrays: true });
    const name = "name" in body ? String(body.name).trim() : "";
    if (!name) return fail("EMPTY_NAME");
    if (body.origin !== undefined && body.origin !== "suite_studio" && body.origin !== "canvas") {
      return fail("INVALID_SUITE_ORIGIN", 400);
    }
    const origin = body.origin === "canvas" ? "canvas" : "suite_studio";
    return ok(await deps.repository.createSuite(name, idempotencyKey, origin), 201);
  });

  router.get("/api/suites", async ({ query }) => {
    const canvasOnly = query.get("view") === "canvas";
    const suites = await deps.repository.listSuites();
    const visibleSuites = canvasOnly ? suites.filter(({ origin }) => origin !== "replica" && origin !== "aplus") : suites;
    const enriched = await Promise.all(visibleSuites.map(async (suite) => {
      const [inputImages, tasks] = await Promise.all([
        deps.repository.getInputImages(suite.id),
        deps.taskRepository ? deps.taskRepository.listTasks(suite.id) : Promise.resolve([]),
      ]);
      const activeTasks = tasks.filter((task) => task.status !== "archived");
      let coverPreviewUrl: string | null = null;
      if (deps.taskRepository && activeTasks.length) {
        const ordered = [...activeTasks].sort((a, b) => (a.imageType === b.imageType ? a.ordinal - b.ordinal : a.imageType === "main" ? -1 : 1));
        for (const task of ordered) {
          const history = await deps.taskRepository.listTaskVersions(task.id);
          const chosen = history.versions.find((v) => v.isFinal) ?? history.versions.find((v) => v.isCurrent) ?? history.versions[0];
          if (chosen) {
            coverPreviewUrl = taskVersionView(chosen).previewUrl;
            break;
          }
        }
      }
      if (!coverPreviewUrl && inputImages.length) {
        const firstWithBase = inputImages.find((img) => img.currentBaseVersionId);
        coverPreviewUrl = firstWithBase
          ? `/api/suites/${suite.id}/input-images/${firstWithBase.id}/base-versions/${firstWithBase.currentBaseVersionId}/preview`
          : inputImages[0].thumbnailPreviewUrl;
      }
      return {
        ...suite,
        coverPreviewUrl,
        inputImageCount: inputImages.length,
        taskCount: activeTasks.length,
        isDemo: suite.name.includes("演示") || suite.name.includes("Demo"),
      };
    }));
    return ok(canvasOnly ? enriched.filter((suite) => suite.origin === "canvas" || suite.taskCount > 0) : enriched);
  });

  router.get("/api/health", () => ok({ ready: true }));

  router.delete("/api/suites/:suiteId/input-images/:inputImageId", async ({ params }) => {
    const { suiteId, inputImageId } = params;
    const image = await deps.repository.getInputImage(suiteId, inputImageId);
    if (!image) return fail("INVALID_INPUT_IMAGE", 404);
    if ((await deps.repository.getSuite(suiteId))?.origin === "aplus") return fail("INPUT_IMAGE_HAS_HISTORY", 409);
    try {
      const removed = await deps.repository.removeInputImage(suiteId, inputImageId);
      if (!removed) return fail("INVALID_INPUT_IMAGE", 404);
      await deps.storage.delete(removed.originalObjectKey).catch(() => undefined);
      await deps.storage.delete(removed.thumbnailObjectKey).catch(() => undefined);
      await deps.storage.delete(`suites/${suiteId}/inputs/${inputImageId}/generation-input.jpg`).catch(() => undefined);
      return ok({ id: inputImageId });
    } catch (error) {
      const code = error instanceof Error ? error.message : "INPUT_IMAGE_HAS_HISTORY";
      return fail(code, code === "INPUT_IMAGE_HAS_HISTORY" ? 409 : 500);
    }
  });

  router.post("/api/suites/:suiteId/input-images/:inputImageId/base-generation", async ({ params, idempotencyKey, body: requestBody }) => {
    const { suiteId, inputImageId } = params;
    if (!idempotencyKey) return fail("MISSING_IDEMPOTENCY_KEY");
    if (!deps.promptRepository) return fail("PROMPT_REPOSITORY_NOT_CONFIGURED", 503);
    const body = asRecord(requestBody);
    const templateVersionId = typeof body.templateVersionId === "string" ? body.templateVersionId : "";
    if (!templateVersionId) return fail("PROMPT_TEMPLATE_REQUIRED");
    const template = await observedPromptLoad(deps.promptRepository, templateVersionId, "base_refine");
    if (!template) return fail("PROMPT_TEMPLATE_NOT_FOUND", 404);
    const validatedInput = validateDynamicInput(template.inputSchema, body.dynamicInput);
    if (!validatedInput.ok) return fail("PROMPT_INPUT_INVALID", 400, validatedInput.message);
    const prompt = renderPromptTemplate(template, validatedInput.value);
    const image = await deps.repository.getInputImage(suiteId, inputImageId);
    if (!image) return fail("INVALID_INPUT_IMAGE", 404);
    const { provider, model, channel } = await resolveImage();
    if (deps.modelSettings && !provider) {
      const previous = (await deps.repository.listGenerationAttempts(suiteId, inputImageId)).find((attempt) => attempt.idempotencyKey === idempotencyKey);
      if (!previous) return fail("IMAGE_PROVIDER_NOT_CONFIGURED", 503);
      const version = await deps.repository.getBaseImageVersion(suiteId, inputImageId, previous.baseVersionId);
      return ok({ attempt: attemptView(previous), version: version ? versionView(version) : null }, previous.status === "running" ? 202 : 200);
    }
    const createdAt = new Date().toISOString();
    let reservation: Awaited<ReturnType<SuiteRepository["beginBaseGeneration"]>>;
    try {
      reservation = await deps.repository.beginBaseGeneration({
        id: randomUUID(),
        suiteId,
        inputImageId,
        baseVersionId: randomUUID(),
        idempotencyKey,
        model,
        channel,
        endpoint: "/v1/images/edits",
        prompt,
        promptTemplateVersionId: templateVersionId,
        dynamicInput: validatedInput.value,
        size: "1K",
        quality: "medium",
        n: 1,
        responseFormat: "b64_json",
        createdAt,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "BASE_GENERATION_IN_PROGRESS") return fail(error.message, 409);
      throw error;
    }
    if (reservation.duplicate) {
      return ok({ attempt: attemptView(reservation.attempt), version: reservation.existingVersion ? versionView(reservation.existingVersion) : null }, reservation.attempt.status === "running" ? 202 : 200);
    }
    if (!provider) {
      await deps.repository.failBaseGeneration(reservation.attempt.id, "IMAGE_PROVIDER_NOT_CONFIGURED", errorMessages.IMAGE_PROVIDER_NOT_CONFIGURED, new Date().toISOString());
      return fail("IMAGE_PROVIDER_NOT_CONFIGURED", 503);
    }
    const executeGeneration = async () => {
      let source;
      try {
        const generationInputKey = `suites/${suiteId}/inputs/${inputImageId}/generation-input.jpg`;
        source = await withTimeout(deps.storage.get(generationInputKey), 60_000, "OBJECT_READ_TIMEOUT");
        if (!source) source = await withTimeout(deps.storage.get(image.originalObjectKey), 60_000, "OBJECT_READ_TIMEOUT");
      } catch (error) {
        if (error instanceof Error && error.message === "OBJECT_NOT_FOUND") {
          try { source = await withTimeout(deps.storage.get(image.originalObjectKey), 60_000, "OBJECT_READ_TIMEOUT"); }
          catch (fallbackError) {
            const code = fallbackError instanceof Error && fallbackError.message === "OBJECT_NOT_FOUND" ? "INPUT_OBJECT_NOT_FOUND" : "INPUT_OBJECT_READ_FAILED";
            await deps.repository.failBaseGeneration(reservation.attempt.id, code, errorMessages[code], new Date().toISOString());
            return;
          }
        } else {
          const code = "INPUT_OBJECT_READ_FAILED";
          await deps.repository.failBaseGeneration(reservation.attempt.id, code, errorMessages[code], new Date().toISOString());
          return;
        }
      }
      if (!source) {
        await deps.repository.failBaseGeneration(reservation.attempt.id, "INPUT_OBJECT_NOT_FOUND", errorMessages.INPUT_OBJECT_NOT_FOUND, new Date().toISOString());
        return;
      }
      let generated;
      try {
        generated = await provider.edit({
          requestId: reservation.attempt.id,
          flow: "base-image-refinement",
          endpoint: "/v1/images/edits",
          image: source.bytes,
          imageMimeType: source.contentType,
          imageFilename: source.key.endsWith("generation-input.jpg") ? "generation-input.jpg" : image.originalFilename,
          model: reservation.attempt.model,
          prompt,
          size: "1K",
          quality: "medium",
          n: 1,
          responseFormat: "b64_json",
        });
      } catch (error) {
        const code = error instanceof Error && error.message === "IMAGE_PROVIDER_TIMEOUT" ? "IMAGE_PROVIDER_TIMEOUT" : "IMAGE_PROVIDER_FAILED";
        await deps.repository.failBaseGeneration(reservation.attempt.id, code, errorMessages[code], new Date().toISOString());
        return;
      }
      let processed;
      try {
        processed = await processGeneratedImage(generated.bytes);
      } catch {
        await deps.repository.failBaseGeneration(reservation.attempt.id, "INVALID_GENERATED_IMAGE", errorMessages.INVALID_GENERATED_IMAGE, new Date().toISOString());
        return;
      }
      const objectKey = `suites/${suiteId}/inputs/${inputImageId}/base/${reservation.attempt.baseVersionId}/final.png`;
      try {
        await deps.storage.put({ key: objectKey, bytes: processed.bytes, contentType: processed.mimeType });
      } catch {
        await deps.repository.failBaseGeneration(reservation.attempt.id, "STORAGE_WRITE_FAILED", errorMessages.STORAGE_WRITE_FAILED, new Date().toISOString());
        return;
      }
      try {
        await deps.repository.completeBaseGeneration({
          attemptId: reservation.attempt.id,
          objectKey,
          sha256: processed.sha256,
          width: processed.width,
          height: processed.height,
          mimeType: processed.mimeType,
          completedAt: new Date().toISOString(),
        });
      } catch {
        await deps.storage.delete(objectKey).catch(() => undefined);
        await deps.repository.failBaseGeneration(reservation.attempt.id, "GENERATION_PERSIST_FAILED", errorMessages.GENERATION_PERSIST_FAILED, new Date().toISOString()).catch(() => undefined);
      }
    };
    void executeGeneration().catch(async () => {
      await deps.repository.failBaseGeneration(reservation.attempt.id, "GENERATION_PERSIST_FAILED", errorMessages.GENERATION_PERSIST_FAILED, new Date().toISOString()).catch(() => undefined);
    });
    return ok({ attempt: attemptView(reservation.attempt), version: null }, 202);
  });

  router.get("/api/suites/:suiteId/input-images/:inputImageId/base-versions", async ({ params }) => {
    const { suiteId, inputImageId } = params;
    const image = await deps.repository.getInputImage(suiteId, inputImageId);
    if (!image) return fail("INVALID_INPUT_IMAGE", 404);
    const [versions, attempts] = await Promise.all([
      deps.repository.listBaseImageVersions(suiteId, inputImageId),
      deps.repository.listGenerationAttempts(suiteId, inputImageId),
    ]);
    return ok({ currentVersionId: image.currentBaseVersionId, versions: versions.map(versionView), attempts: attempts.map(attemptView) });
  });

  router.post("/api/suites/:suiteId/input-images/:inputImageId/base-versions/:versionId/select", async ({ params }) => {
    const selected = await deps.repository.selectBaseImageVersion(params.suiteId, params.inputImageId, params.versionId);
    return selected ? ok(versionView(selected)) : fail("INVALID_BASE_VERSION", 404);
  });

  router.get("/api/suites/:suiteId", async ({ params }) => {
    const suite = await deps.repository.getSuite(params.suiteId);
    if (!suite) return fail("INVALID_SUITE_ID", 404);
    const inputImages = await deps.repository.getInputImages(suite.id);
    return ok({ ...suite, inputImages } satisfies SuiteAggregate);
  });

  router.patch("/api/suites/:suiteId", async ({ params, body: requestBody }) => {
    const body = asRecord(requestBody, { allowArrays: true });
    const name = "name" in body ? String(body.name).trim() : "";
    if (!name) return fail("EMPTY_NAME");
    if (!deps.repository.renameSuite) return fail("NOT_FOUND", 404);
    const updated = await deps.repository.renameSuite(params.suiteId, name);
    return updated ? ok(updated) : fail("INVALID_SUITE_ID", 404);
  });

  router.delete("/api/suites/:suiteId", async ({ params }) => {
    if (!deps.repository.deleteSuite) return fail("NOT_FOUND", 404);
    const deleted = await deps.repository.deleteSuite(params.suiteId);
    return deleted ? ok(deleted) : fail("INVALID_SUITE_ID", 404);
  });

  router.get(/^\/api\/suites\/(?<suiteId>[^/]+)\/input-images\/(?<imageId>[^/]+)\/preview\/(?<kind>original|thumbnail)$/, ({ params }) => preview(params.suiteId, params.imageId, params.kind === "original" ? "original" : "thumbnail"));

  router.get("/api/suites/:suiteId/input-images/:imageId/base-versions/:versionId/preview", ({ params }) => previewBaseVersion(params.suiteId, params.imageId, params.versionId));

  return { upload, preview, previewBaseVersion };
}
