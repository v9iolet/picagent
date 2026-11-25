import { randomUUID } from "node:crypto";
import {
  isAplusPlanStale,
  normalizeAplusLanguage,
  normalizeAplusProductInfo,
  normalizeAplusTargetMarket,
  validateAplusModuleCodes,
  validateAplusSizePresets,
} from "../../shared/aplus.js";
import { SUPPORTED_OUTPUT_LANGUAGES } from "../../shared/workbench-delivery.js";
import { errorMessages, fail } from "../api-errors.js";
import { asRecord, now, ok, type AppResponse } from "../api-response.js";
import { resolvePublishedProductCardSnapshot } from "../product-cards-api.js";
import type {
  InputImage,
  LlmClient,
  PipelineRepository,
  PlatformRepository,
  ProductCardRepository,
  PromptRepository,
  StorageAdapter,
  SuitePipelineRun,
  SuiteRepository,
} from "../types.js";
import { aplusPlanningView, readAplusRunConfig, validateAplusPlanOutput, type AplusRunConfig } from "./aplus-plan.js";
import { renderAplusPlanPrompt, resolveAplusPromptTemplate } from "./aplus-prompt.js";

interface AplusPlanningDependencies {
  repository: SuiteRepository;
  storage: StorageAdapter;
  pipelines: PipelineRepository;
  platforms?: PlatformRepository;
  productCards: ProductCardRepository;
  prompts?: Pick<PromptRepository, "listPublished" | "getPublishedVersion">;
  resolveVision(): Promise<LlmClient | undefined>;
}

type Result<T> = { ok: true; value: T } | { ok: false; response: AppResponse };
const allowedLanguages = new Set<string>(["none", ...SUPPORTED_OUTPUT_LANGUAGES.map(({ code }) => code)]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function rejected(code: string, status = 400): Result<never> {
  return { ok: false, response: fail(code, status) };
}

function fallbackTaskName(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return "A+ · " + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " +
    pad(date.getHours()) + ":" + pad(date.getMinutes());
}

export function createAplusPlanningApi(deps: AplusPlanningDependencies) {
  async function readInputs(body: Record<string, unknown>, defaultSourceId?: string): Promise<Result<AplusRunConfig>> {
    const sourceId = body.suiteId ?? defaultSourceId;
    const { modules, sizePresets, resolution } = body;
    const platform = typeof body.platform === "string" ? body.platform.trim() : "";
    const targetMarket = typeof body.targetMarket === "string" ? normalizeAplusTargetMarket(body.targetMarket) : "";
    const language = typeof body.language === "string" ? normalizeAplusLanguage(body.language) : "";
    if (resolution !== "1K" && resolution !== "2K") return rejected("APLUS_INVALID_RESOLUTION");
    if (typeof language !== "string" || !allowedLanguages.has(language)) return rejected("APLUS_INVALID_LANGUAGE");
    if (!targetMarket) return rejected("APLUS_TARGET_MARKET_REQUIRED");
    if (!validateAplusModuleCodes(modules)) return rejected("APLUS_INVALID_MODULES");
    const rawInfo = body.productInfo === undefined ? "" : body.productInfo;
    if (typeof rawInfo !== "string" || Array.from(rawInfo).length > 1000) return rejected("APLUS_INVALID_PRODUCT_INFO");
    const productInfo = normalizeAplusProductInfo(rawInfo);
    if (typeof sourceId !== "string" || !uuid.test(sourceId)) return rejected("APLUS_INVALID_INPUT_IMAGES");

    const [profile, card, source] = await Promise.all([
      platform ? deps.platforms?.find(platform) : null,
      resolvePublishedProductCardSnapshot(body.productCardId, deps.productCards),
      deps.repository.getSuite(sourceId),
    ]);
    if (!profile) return rejected("PLATFORM_NOT_FOUND");
    if (!validateAplusSizePresets(sizePresets, profile.detailSizePresets)) return rejected("APLUS_INVALID_SIZE_PRESETS");
    if (!card.ok) return card;
    if (!card.snapshot && !productInfo) return rejected("APLUS_PRODUCT_INFO_REQUIRED");
    if (!source) return rejected("INVALID_SUITE_ID", 404);

    const images = await deps.repository.getInputImages(source.id);
    const imageIds = body.inputImageIds === undefined ? images.map((item) => item.id) : body.inputImageIds;
    if (
      !Array.isArray(imageIds) || imageIds.length < 1 || imageIds.length > 6 ||
      new Set(imageIds).size !== imageIds.length
    ) return rejected("APLUS_INVALID_INPUT_IMAGES");
    const imagesById = new Map(images.map((image) => [image.id, image]));
    const sourceImages: InputImage[] = [];
    for (const id of imageIds) {
      const image = typeof id === "string" && imagesById.get(id);
      if (!image) return rejected("APLUS_INVALID_INPUT_IMAGES");
      sourceImages.push(image);
    }
    const inputSnapshot = {
      imageHashes: sourceImages.map((image) => image.sha256),
      productInfo,
      productCardId: card.snapshot?.cardId ?? null,
      productCardRevision: card.snapshot?.revision ?? null,
      platform: profile.code,
      targetMarket,
      language,
      sizePresets: [...sizePresets],
      modules: [...modules],
    };
    return {
      ok: true,
      value: {
        platform: inputSnapshot.platform,
        targetMarket,
        outputLanguage: language,
        inputSnapshot,
        sourceImages,
        productCardSnapshot: card.snapshot,
        resolution,
        listingCopyRules: profile.listingCopyRules ?? null,
      },
    };
  }

  async function readObject(key: string) {
    try {
      return await deps.storage.get(key);
    } catch (error) {
      if (error instanceof Error && error.message === "OBJECT_NOT_FOUND") return null;
      throw new Error("INPUT_OBJECT_READ_FAILED");
    }
  }

  async function copyInputs(suiteId: string, sourceImages: InputImage[]): Promise<InputImage[]> {
    const saved = await deps.repository.getInputImages(suiteId);
    const inputs: InputImage[] = [];
    for (const [index, source] of sourceImages.entries()) {
      const ordinal = index + 1;
      const existing = saved.find((image) => image.ordinal === ordinal);
      if (existing?.sha256 === source.sha256) {
        inputs.push(existing);
        continue;
      }
      if (existing) throw new Error("APLUS_INPUT_IMAGE_CONFLICT");

      const id = randomUUID();
      const prefix = "suites/" + suiteId + "/inputs/" + id;
      const originalObjectKey = prefix + "/original";
      const thumbnailObjectKey = prefix + "/thumbnail";
      const generationObjectKey = prefix + "/generation-input.jpg";
      const [original, thumbnail, generation] = await Promise.all([
        readObject(source.originalObjectKey),
        readObject(source.thumbnailObjectKey),
        readObject(source.originalObjectKey.replace(/\/original$/, "/generation-input.jpg")),
      ]);
      if (!original || !thumbnail) throw new Error("INPUT_OBJECT_NOT_FOUND");
      try {
        await deps.storage.put({ ...original, key: originalObjectKey });
        await deps.storage.put({ ...thumbnail, key: thumbnailObjectKey });
        if (generation) await deps.storage.put({ ...generation, key: generationObjectKey });
        inputs.push(await deps.repository.createInputImage({
          id, suiteId, ordinal, originalObjectKey, thumbnailObjectKey,
          sha256: source.sha256, width: source.width, height: source.height,
          mimeType: source.mimeType, originalFilename: source.originalFilename,
          currentBaseVersionId: null, createdAt: now(),
        }));
      } catch (error) {
        await Promise.allSettled([originalObjectKey, thumbnailObjectKey, generationObjectKey].map((key) => deps.storage.delete(key)));
        throw error;
      }
    }
    return inputs;
  }

  async function plan(run: SuitePipelineRun, config: AplusRunConfig, images: InputImage[]) {
    const input = config.inputSnapshot;
    if (!deps.prompts) throw new Error("PROMPT_REPOSITORY_NOT_CONFIGURED");
    const prompts = deps.prompts;
    const [llm, template, rules] = await Promise.all([
      deps.resolveVision(),
      resolveAplusPromptTemplate(prompts, "aplus_plan"),
      Promise.all(input.modules.map((code) => resolveAplusPromptTemplate(prompts, "aplus_module_rule", code))),
    ]);
    if (!llm) throw new Error("LLM_NOT_CONFIGURED");
    if (!template || !rules.every((rule) => rule !== null)) throw new Error("PROMPT_TEMPLATE_NOT_FOUND");
    const inputImageIds = images.map((image) => image.id);
    const prompt = renderAplusPlanPrompt(template, {
      ...input,
      inputImageIds,
      productInfo: input.productInfo.replace(/【待补充[^】]*】/gu, "").trim(),
      productCardSnapshot: config.productCardSnapshot,
      selectedModules: input.modules,
      moduleRuleTemplates: rules,
      listingCopyRules: config.listingCopyRules,
    });
    const visionImages = await Promise.all(images.map(async (image) => {
      const thumbnail = await readObject(image.thumbnailObjectKey);
      if (!thumbnail) throw new Error("INPUT_OBJECT_NOT_FOUND");
      return { id: image.id, sourceKind: "original" as const, sourceVersionId: null, mimeType: thumbnail.contentType, bytes: thumbnail.bytes };
    }));
    const result = await llm.generatePlan({
      requestId: run.id,
      flow: "aplus-plan",
      templateVersionId: template.templateVersionId,
      templateBody: prompt.systemPrompt,
      userPrompt: prompt.userPrompt,
      inputImageIds, visionImages, baseVersionIds: [], chunks: [], dynamicInput: {}, humanInput: {},
    });
    const validated = validateAplusPlanOutput(result, input);
    if (!validated) throw new Error("APLUS_PLAN_OUTPUT_INVALID");
    const taskName = validated.taskName || config.productCardSnapshot?.name || fallbackTaskName(new Date(run.createdAt));
    await deps.repository.renameSuite?.(run.suiteId, taskName);
    await deps.pipelines.updateRun(run.id, {
      status: "waiting_human_input",
      currentPhase: "awaiting_confirmation",
      config: {
        ...config,
        planSnapshot: {
          ...validated,
          taskName,
          templateVersionId: template.templateVersionId,
          moduleRuleVersionIds: Object.fromEntries(rules.map((rule, index) => [input.modules[index], rule.templateVersionId])),
          provider: { name: llm.provider, model: llm.model, isFake: llm.isFake, ...(llm.channel ? { channel: llm.channel } : {}) },
        },
      } satisfies AplusRunConfig,
    }, run);
  }

  function markFailed(run: SuitePipelineRun, error: unknown) {
    const code = error instanceof Error && Object.hasOwn(errorMessages, error.message) ? error.message : "APLUS_PLANNING_FAILED";
    return deps.pipelines.updateRun(run.id, {
      status: "failed",
      errorCode: code,
      errorMessage: errorMessages[code],
      completedAt: now(),
    }, run);
  }

  async function startPlanning(run: SuitePipelineRun, config: AplusRunConfig): Promise<SuitePipelineRun> {
    let images: InputImage[];
    try {
      images = await copyInputs(run.suiteId, config.sourceImages);
    } catch (error) {
      return await markFailed(run, error) ?? run;
    }
    void plan(run, config, images).catch((error) => markFailed(run, error))
      .catch((error) => console.error("A+ 规划状态保存失败", run.id, error));
    return run;
  }

  function runResponse(run: SuitePipelineRun) {
    return ok({ suiteId: run.suiteId, runId: run.id }, run.status === "running" ? 202 : 200);
  }

  async function start(key: string | undefined, payload: unknown, previousSuiteId?: string): Promise<AppResponse> {
    if (!key?.trim()) return fail("MISSING_IDEMPOTENCY_KEY");
    const suiteKey = JSON.stringify([previousSuiteId ?? null, key]);
    const existingSuite = await deps.repository.findAplusSuiteByIdempotencyKey(suiteKey);
    const existingRun = existingSuite && await deps.pipelines.getLatestRun(existingSuite.id);
    if (existingRun) return runResponse(existingRun);

    if (previousSuiteId) {
      const previous = await loadRun(previousSuiteId);
      if (!previous.ok) return previous.response;
      const { run } = previous.value;
      if (!awaitingConfirmation(run) && !(run.currentPhase === "aplus_planning" && run.status === "failed")) {
        return fail("APLUS_PLAN_ACTION_NOT_ALLOWED", 409);
      }
    }
    const parsed = await readInputs(asRecord(payload), previousSuiteId);
    if (!parsed.ok) return parsed.response;
    const config = parsed.value;
    const createdAt = now();
    const suite = existingSuite ?? await deps.repository.createSuite(
      config.productCardSnapshot?.name || fallbackTaskName(new Date(createdAt)),
      suiteKey,
      "aplus",
    );
    const { run, duplicate } = await deps.pipelines.createRun({
      id: randomUUID(), suiteId: suite.id, idempotencyKey: key,
      status: "running", currentPhase: "aplus_planning", config,
      errorCode: null, errorMessage: null, completedAt: null, createdAt, updatedAt: createdAt,
    });
    return runResponse(duplicate ? run : await startPlanning(run, config));
  }

  async function loadRun(suiteId: string): Promise<Result<{ run: SuitePipelineRun; config: AplusRunConfig }>> {
    const suite = uuid.test(suiteId) ? await deps.repository.getSuite(suiteId) : null;
    if (!suite) return rejected("INVALID_SUITE_ID", 404);
    if (suite.origin !== "aplus") return rejected("INVALID_SUITE_ORIGIN");
    const run = await deps.pipelines.getLatestRun(suite.id);
    const config = run && readAplusRunConfig(run);
    return run && config ? { ok: true, value: { run, config } } : rejected("PIPELINE_NOT_FOUND", 404);
  }

  function awaitingConfirmation(run: SuitePipelineRun) {
    return run.status === "waiting_human_input" && run.currentPhase === "awaiting_confirmation";
  }

  async function editPlan(suiteId: string, payload: unknown): Promise<AppResponse> {
    const loaded = await loadRun(suiteId);
    if (!loaded.ok) return loaded.response;
    const { run, config } = loaded.value;
    const planSnapshot = config.planSnapshot;
    if (!awaitingConfirmation(run) || !planSnapshot) return fail("APLUS_PLAN_ACTION_NOT_ALLOWED", 409);
    const body = asRecord(payload);
    if (Object.keys(body).length !== 1 || !Array.isArray(body.modules) || body.modules.length < 1) return fail("APLUS_INVALID_PLAN_EDIT");

    const available = new Map<string, typeof planSnapshot.modules[number]>(planSnapshot.modules.map((module) => [module.moduleCode, module]));
    const modules: typeof planSnapshot.modules = [];
    for (const item of body.modules) {
      const { moduleCode, copyRequirements, ...other } = asRecord(item);
      const existing = typeof moduleCode === "string" ? available.get(moduleCode) : undefined;
      if (
        !existing || Object.keys(other).length ||
        (copyRequirements !== undefined && typeof copyRequirements !== "string") ||
        (config.inputSnapshot.language === "none" && copyRequirements !== undefined && copyRequirements !== "")
      ) return fail("APLUS_INVALID_PLAN_EDIT");
      available.delete(existing.moduleCode);
      modules.push({ ...existing, copyRequirements: copyRequirements ?? existing.copyRequirements });
    }
    const updated = await deps.pipelines.updateRun(run.id, {
      config: { ...config, planSnapshot: { ...planSnapshot, modules } },
    }, run);
    return updated ? ok(aplusPlanningView(updated)) : fail("APLUS_PLAN_CHANGED", 409);
  }

  async function resume(suiteId: string, key?: string): Promise<AppResponse> {
    if (!key?.trim()) return fail("MISSING_IDEMPOTENCY_KEY");
    const loaded = await loadRun(suiteId);
    if (!loaded.ok) return loaded.response;
    const { run, config } = loaded.value;
    const usedKey = (value: SuitePipelineRun) => value.resumeKeys?.includes(key) || value.lastResumeKey === key;
    if (usedKey(run)) return runResponse(run);
    if (run.currentPhase !== "aplus_planning" || run.status !== "failed") return fail("APLUS_PLAN_ACTION_NOT_ALLOWED", 409);
    const next = await deps.pipelines.resumeRun(run, key, "aplus_planning", config);
    if (!next) {
      const current = await deps.pipelines.getRun(run.id);
      return current && usedKey(current) ? runResponse(current) : fail("APLUS_PLAN_ACTION_NOT_ALLOWED", 409);
    }
    return runResponse(await startPlanning(next, config));
  }

  // The generation endpoint uses the returned run as its compare-and-set guard.
  async function prepareConfirmation(suiteId: string, payload: unknown) {
    const loaded = await loadRun(suiteId);
    if (!loaded.ok) return loaded;
    const { run, config } = loaded.value;
    if (!awaitingConfirmation(run) || !config.planSnapshot) return rejected("APLUS_PLAN_ACTION_NOT_ALLOWED", 409);
    const body = asRecord(payload);
    if (body.resolution !== "1K" && body.resolution !== "2K") return rejected("APLUS_INVALID_RESOLUTION");
    if (typeof body.platform !== "string" || !body.platform.trim()) return rejected("PLATFORM_NOT_FOUND");
    if (typeof body.targetMarket !== "string" || !body.targetMarket.trim()) return rejected("APLUS_TARGET_MARKET_REQUIRED");
    if (typeof body.language !== "string" || !allowedLanguages.has(normalizeAplusLanguage(body.language))) return rejected("APLUS_INVALID_LANGUAGE");
    if (!validateAplusModuleCodes(body.modules)) return rejected("APLUS_INVALID_MODULES");
    if (!Array.isArray(body.sizePresets) || !body.sizePresets.length || !body.sizePresets.every((preset) => typeof preset === "string")) {
      return rejected("APLUS_INVALID_SIZE_PRESETS");
    }
    if (typeof body.productInfo !== "string" || Array.from(body.productInfo).length > 1000) return rejected("APLUS_INVALID_PRODUCT_INFO");
    if (body.productCardId != null && typeof body.productCardId !== "string") return rejected("PRODUCT_CARD_NOT_AVAILABLE");
    if (body.productCardRevision != null && (!Number.isSafeInteger(body.productCardRevision) || Number(body.productCardRevision) < 1)) {
      return rejected("PRODUCT_CARD_NOT_AVAILABLE");
    }
    if (
      (body.suiteId !== undefined && (typeof body.suiteId !== "string" || !uuid.test(body.suiteId))) ||
      !Array.isArray(body.inputImageIds) || body.inputImageIds.length < 1 || body.inputImageIds.length > 6 ||
      !body.inputImageIds.every((id) => typeof id === "string" && uuid.test(id)) ||
      new Set(body.inputImageIds).size !== body.inputImageIds.length
    ) return rejected("APLUS_INVALID_INPUT_IMAGES");
    const parsed = await readInputs(body, suiteId);
    if (
      !parsed.ok || isAplusPlanStale(config.inputSnapshot, parsed.value.inputSnapshot) ||
      (body.productCardRevision !== undefined && body.productCardRevision !== config.inputSnapshot.productCardRevision)
    ) return rejected("APLUS_PLAN_STALE", 409);
    return { ok: true as const, value: { run, config, planSnapshot: config.planSnapshot, resolution: parsed.value.resolution } };
  }

  return { start, editPlan, resume, prepareConfirmation, loadRun };
}
