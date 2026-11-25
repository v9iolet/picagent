import { planSnapshotView, isStructurePlanV2, taskView, taskAttemptView, taskSlotView, taskVersionView, taskBatchView } from "./suite-views.js";
import { createSuitePipeline } from "./suite-pipeline.js";
import { fail, errorMessages } from "./api-errors.js";
import { ok, asRecord, dataOf, type AppResponse } from "./api-response.js";
export type { AppResponse } from "./api-response.js";
import { isProductImageResource, isStoredProductImageReference } from "./library-reference-policy.js";
import { createListingCopyApi } from "./listing-copy-api.js";
import { MemoryListingRepository, type ListingRepository } from "./listing-copy.js";
import { defaultImageOptions, IMAGE_QUALITIES, resolveClosestImageSize, resolveImageSize, type ImageQuality, type ModelCapability } from "../shared/model-settings.js";
import { PURE_WHITE_MAIN_IMAGE_REQUIREMENTS } from "../shared/platform-main-background.js";
import { DETAIL_CATEGORY_CODES, SUITE_CATEGORY_NAMES as DETAIL_CATEGORY_NAMES, SUITE_CATEGORY_GROUPS, SUITE_IMAGE_LIMITS, type SuiteCategoryGroups } from "../shared/suite-categories.js";
import { allocateSellingPointLayouts, resolveSellingPointLayouts } from "../shared/selling-point-layouts.js";
import { GptImageProvider } from "./providers/gpt-image-provider.js";
import { DashScopeLlmClient } from "./providers/dashscope-llm-client.js";
import type { ModelSettings } from "./model-settings.js";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { processGeneratedImage, processImage } from "./image.js";
import { PROMPT_STAGES, renderPromptTemplate, resolvePromptTemplateUsedBy, validateDynamicInput, withPromptTemplateUsage, type PromptStage, type PromptTemplateRuntime, type PromptVersionStatus } from "./prompt-library.js";
import { MemoryCategoryPromptRepository } from "./repositories/memory-category-prompt-repository.js";
import { MemoryLibraryRepository } from "./repositories/memory-library-repository.js";
import { MemoryReverseRepository } from "./repositories/memory-reverse-repository.js";
import { MemoryPipelineRepository } from "./repositories/memory-pipeline-repository.js";
import { MemoryProductCardRepository } from "./repositories/memory-product-card-repository.js";
import { MemoryReplicaRepository } from "./repositories/memory-replica-repository.js";
import { createProductCardsApi } from "./product-cards-api.js";
import {
  createProductOnboardingApi,
  MemoryProductOnboardingRepository,
  type ProductOnboardingRepository,
} from "./product-onboarding/index.js";
import { buildReplicaRolePrefix, createReplicaPipeline, resolveReplicaCloneLevel } from "./replica/replica-pipeline.js";
import { buildProviderImagePrompt, materializeCategoryPlanItems } from "./suite-task-prompt.js";
import {
  applyStyleOverrideToPrompt,
  DELIVERY_EXPORT_PRESETS,
  formatListingCopyMarkdown,
  resolveDeliverySlots,
  sanitizeDeliveryName,
  type DeliveryEditChildLike,
  type DeliveryExportFormat,
  type DeliveryExportPresetId,
} from "../shared/workbench-delivery.js";
import { createZipBuffer } from "./zip.js";
import type { ImageEditorApiResponse } from "./image-editor-api.js";
import { declareImageEditInputs, imageEditProductInputs } from "./image-editor.js";
import type {
  BaseImageVersion,
  CategoryPromptItem,
  CategoryPromptLlmInput,
  CategoryPromptRequest,
  CategoryPromptRepository,
  GenerationAttempt,
  ImageProvider,
  InputImage,
  LlmClient,
  PlanAttempt,
  PlanRepository,
  PlanSnapshot,
  PlatformProfile,
  PlatformRepository,
  PromptRepository,
  RagClient,
  StorageAdapter,
  StructureAllocation,
  StructurePlanV2,
  SuiteAggregate,
  SuiteRepository,
  UploadFile,
  TaskRepository,
  SuiteTask,
  TaskGenerationAttempt,
  TaskGenerationBatch,
  TaskImageVersion,
  TaskResultSlot,
  LibraryRepository,
  ReverseRepository, ReverseReference, ReversePromptVersion,
  PipelineRepository,
  ProductCardRepository,
  ReplicaRepository,
} from "./types.js";
import { failObservation, finishObservation, startTool } from "./observability.js";

export interface SuiteStudioApp {
  request(method: string, path: string, options?: { headers?: Record<string, string>; body?: unknown }): Promise<AppResponse>;
  upload(suiteId: string, file: UploadFile): Promise<AppResponse>;
  preview(suiteId: string, imageId: string, kind: "original" | "thumbnail"): Promise<AppResponse>;
  previewBaseVersion(suiteId: string, imageId: string, versionId: string): Promise<AppResponse>;
  previewTaskVersion(taskId: string, versionId: string): Promise<AppResponse>;
  previewLibraryResource(resourceId: string): Promise<AppResponse>;
  previewReverseReference(planId: string, referenceId: string, kind?: "original" | "thumbnail"): Promise<AppResponse>;
  previewReplicaReference(suiteId: string, referenceId: string, kind?: "original" | "thumbnail"): Promise<AppResponse>;
}

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

function platformForPlanning(profile: PlatformProfile | null, background: unknown): PlatformProfile | undefined {
  if (!profile) return undefined;
  if (background === "pure_white_required")
    return { ...profile, mainImageBackground: background, mainImageStrategy: PURE_WHITE_MAIN_IMAGE_REQUIREMENTS };
  if (background === "flexible") return { ...profile, mainImageBackground: background };
  return profile;
}

function savedSellingPointLayoutIds(snapshot: PlanSnapshot): unknown {
  const input = snapshot.dynamicInput.selling_point_layouts;
  if (typeof input !== "string") return snapshot.requestSummary.sellingPointLayoutIds;
  try {
    const layouts: unknown = JSON.parse(input);
    return Array.isArray(layouts) ? layouts.map((layout) => asRecord(layout).id) : [];
  } catch {
    return [];
  }
}

async function observedPromptLoad(repository: PromptRepository, templateVersionId: string, stage?: PromptStage) {
  const observation = startTool("prompt.load", { templateVersionId, stage }, { template_version_id: templateVersionId, stage: stage ?? "any" });
  try {
    const template = await repository.getPublishedVersion(templateVersionId, stage);
    finishObservation(observation, template ? { found: true, stage: template.stage } : { found: false });
    return template;
  } catch (error) {
    failObservation(observation, error);
    throw error;
  }
}

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

function validPlanOutput(value: unknown, outputSchema?: Record<string, unknown>): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const output = value as Record<string, unknown>;
  if (output.schemaVersion !== "suite-plan-v1" || !Array.isArray(output.items) || output.items.length === 0) return false;
  const itemSchema = outputSchema && typeof outputSchema.items === "object" && outputSchema.items !== null ? outputSchema.items as Record<string, unknown> : undefined;
  const itemProperties = itemSchema && typeof itemSchema.properties === "object" && itemSchema.properties !== null ? itemSchema.properties as Record<string, unknown> : {};
  const requiresImageType = "imageType" in itemProperties;
  return output.items.every((item) => item && typeof item === "object" && !Array.isArray(item)
    && ["title", "purpose", "prompt"].every((key) => typeof (item as Record<string, unknown>)[key] === "string" && String((item as Record<string, unknown>)[key]).trim())
    && (!requiresImageType || ((item as Record<string, unknown>).imageType === "main" || (item as Record<string, unknown>).imageType === "detail")));
}

function parseJsonLike(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(text); } catch { return value; }
}

function summarizeOutput(value: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const serialized = JSON.stringify(value) ?? "";
  return { sha256: (awaitableHash(serialized)), byteLength: Buffer.byteLength(serialized), itemCount: value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).items) ? ((value as Record<string, unknown>).items as unknown[]).length : 0, ...extra };
}

function designerFactsText(input: Record<string, unknown>): string {
  const supplement = typeof input.human_supplement === "string" ? input.human_supplement.trim() : "";
  const emphasis = typeof input.emphasis_requirements === "string" ? input.emphasis_requirements.trim() : "";
  if (!supplement) return emphasis;
  if (!emphasis || supplement === emphasis || supplement.endsWith(`【本次补充说明】\n${emphasis}`)) return supplement;
  return `${supplement}\n${emphasis}`;
}

function awaitableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function planAttemptView(attempt: PlanAttempt, snapshot: PlanSnapshot | null) {
  return { id: attempt.id, suiteId: attempt.suiteId, status: attempt.status, templateVersionId: attempt.templateVersionId, provider: attempt.provider, errorCode: attempt.errorCode, errorMessage: attempt.errorMessage, outputSummary: attempt.outputSummary, snapshot: snapshot ? planSnapshotView(snapshot) : null, createdAt: attempt.createdAt, completedAt: attempt.completedAt };
}

type StructureOutput = StructurePlanV2 & { schemaVersion: "suite-structure-plan-v2" };

function parseCategoryGroups(value: unknown): SuiteCategoryGroups | null {
  const parsed = parseStructureJsonValue(value, null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const groups = parsed as Record<string, unknown>;
  if (Object.keys(groups).length !== Object.keys(SUITE_CATEGORY_GROUPS).length) return null;
  for (const [code, definition] of Object.entries(SUITE_CATEGORY_GROUPS)) {
    const raw = groups[code];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const group = raw as Record<string, unknown>;
    if (group.mode !== definition.mode || !Number.isInteger(group.count) || Number(group.count) < 0) return null;
    if (!Array.isArray(group.categories) || group.categories.length !== definition.categories.length || new Set(group.categories).size !== definition.categories.length || !definition.categories.every((category) => (group.categories as unknown[]).includes(category))) return null;
  }
  const result = groups as SuiteCategoryGroups;
  const detailCount = result.selling_points.count + result.lifestyle.count + result.other.count;
  if (result.main.count < SUITE_IMAGE_LIMITS.main.min || result.main.count > SUITE_IMAGE_LIMITS.main.max || detailCount > SUITE_IMAGE_LIMITS.detail.max || detailCount + result.main.count > SUITE_IMAGE_LIMITS.total.max) return null;
  return result;
}

function normalizeStructureAllocation(value: unknown, main = false): StructureAllocation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const category = String(row.category ?? "").trim();
  const requirement = main ? "optional" : row.requirement;
  if ((main && category !== "main") || (!main && requirement !== "required" && requirement !== "optional")) return null;
  if (!Number.isInteger(row.count) || Number(row.count) < 0 || !Array.isArray(row.sourceImageIds) || !Array.isArray(row.factRefs) || !Array.isArray(row.missingFacts)) return null;
  return {
    category,
    requirement: requirement as "required" | "optional",
    count: Number(row.count),
    reason: String(row.reason ?? ""),
    sourceImageIds: row.sourceImageIds.map(String),
    factRefs: row.factRefs.map(String),
    missingFacts: row.missingFacts.map(String),
  };
}

function normalizeStructureOutput(value: unknown): StructureOutput | null {
  const parsed = parseJsonLike(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const source = parsed as Record<string, unknown>;
  const status = source.status;
  const mainAllocation = normalizeStructureAllocation(source.mainAllocation, true);
  const rawAllocations = Array.isArray(source.categoryAllocations) ? source.categoryAllocations : null;
  const categoryAllocations = rawAllocations?.map((item) => normalizeStructureAllocation(item)) ?? null;
  const globalStyleCard = source.globalStyleCard;
  if (source.schemaVersion !== "suite-structure-plan-v2" || (status !== "READY_FOR_REVIEW" && status !== "NEEDS_HUMAN_INPUT") || !mainAllocation || !Number.isInteger(source.detailImageCount) || !categoryAllocations || categoryAllocations.some((item) => !item) || !globalStyleCard || typeof globalStyleCard !== "object" || Array.isArray(globalStyleCard) || typeof (globalStyleCard as Record<string, unknown>).promptPrefix !== "string") return null;
  return {
    schemaVersion: "suite-structure-plan-v2",
    status,
    mainAllocation: { category: "main", count: mainAllocation.count, reason: mainAllocation.reason, sourceImageIds: mainAllocation.sourceImageIds, factRefs: mainAllocation.factRefs, missingFacts: mainAllocation.missingFacts },
    detailImageCount: Number(source.detailImageCount),
    categoryAllocations: categoryAllocations as StructureAllocation[],
    globalStyleCard: { promptPrefix: String((globalStyleCard as Record<string, unknown>).promptPrefix) },
  };
}

function validateStructureOutput(output: StructureOutput, input: Record<string, unknown>, imageIds: string[], factIds: string[] = []): string | null {
  const groups = input.category_groups ? parseCategoryGroups(input.category_groups) : null;
  if (input.category_groups && !groups) return "category_groups";
  const waitingForFacts = groups !== null && output.status === "NEEDS_HUMAN_INPUT";
  const min = Number(input.detail_image_count_min); const max = Number(input.detail_image_count_max);
  if (!Number.isInteger(output.mainAllocation.count) || (!waitingForFacts && output.mainAllocation.count !== Number(input.main_image_count))) return "main_image_count";
  if (output.mainAllocation.sourceImageIds.some((id) => !imageIds.includes(id))) return "main:sourceImageIds";
  if (output.mainAllocation.factRefs.some((id) => !factIds.includes(id))) return "main:factRefs";
  if (!Number.isInteger(output.detailImageCount) || output.detailImageCount < (waitingForFacts ? 0 : min) || output.detailImageCount > max) return "detail_image_count_range";
  const groupCategories = groups ? Object.values(groups).flatMap((group) => group.categories.filter((code) => code !== "main")) : null;
  const selectedValue = groupCategories ?? (Array.isArray(input.selected_detail_categories) ? input.selected_detail_categories : JSON.parse(String(input.selected_detail_categories ?? "[]")));
  const requirementsValue = groupCategories ? Object.fromEntries(groupCategories.map((code) => [code, "optional"])) : input.category_requirements && typeof input.category_requirements === "object" ? input.category_requirements : JSON.parse(String(input.category_requirements ?? "{}"));
  const selected = new Set((Array.isArray(selectedValue) ? selectedValue : []).map(String));
  const requirements = new Map<string, "required" | "optional">(Object.entries(requirementsValue as Record<string, unknown>).map(([key, value]) => [key, value === "required" ? "required" : "optional"]));
  const seen = new Set<string>(); let total = 0;
  for (const row of output.categoryAllocations) {
    if (!DETAIL_CATEGORY_CODES.has(row.category) || !selected.has(row.category) || seen.has(row.category)) return row.category || "category";
    if (row.requirement !== requirements.get(row.category) || !Number.isInteger(row.count) || row.count < 0) return row.category;
    if (row.requirement === "required" && row.count < 1 && output.status !== "NEEDS_HUMAN_INPUT") return row.category;
    if (row.sourceImageIds.some((id) => !imageIds.includes(id))) return `${row.category}:sourceImageIds`;
    if (row.factRefs.some((id) => !factIds.includes(id))) return `${row.category}:factRefs`;
    total += row.count; seen.add(row.category);
  }
  if (selected.size !== seen.size || (!waitingForFacts && total !== output.detailImageCount)) return "category_total";
  if (groups) {
    if (total > max || total > SUITE_IMAGE_LIMITS.detail.max || output.detailImageCount > SUITE_IMAGE_LIMITS.detail.max || output.mainAllocation.count + Math.max(total, output.detailImageCount) > SUITE_IMAGE_LIMITS.total.max) return "group:total";
    for (const [code, group] of Object.entries(groups)) {
      const allocations = code === "main" ? [output.mainAllocation] : output.categoryAllocations.filter((row) => group.categories.includes(row.category));
      const count = allocations.reduce((sum, row) => sum + row.count, 0);
      if (group.mode === "exact" && count !== group.count && (!waitingForFacts || count > group.count || !allocations.some((row) => row.missingFacts.some((fact) => fact.trim())))) return `group:${code}`;
      if (group.mode === "max" && (count > group.count || allocations.some((row) => row.count > 1))) return `group:${code}`;
    }
  }
  return null;
}

function parseStructureJsonValue(value: unknown, fallback: unknown): unknown {
  if (Array.isArray(value) || (value && typeof value === "object")) return value;
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function normalizeCategoryPromptOutput(value: unknown): { schemaVersion: "suite-category-prompt-v1"; category: string; items: CategoryPromptItem[] } | null {
  const parsed = parseJsonLike(value);
  const root = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!root || typeof root !== "object" || Array.isArray(root)) return null;
  const source = root as Record<string, unknown>;
  const category = String(source.category ?? source.category_code ?? "").trim();
  if ((source.schemaVersion !== undefined && source.schemaVersion !== "suite-category-prompt-v1") || !category || !Array.isArray(source.items)) return null;
  const items: CategoryPromptItem[] = [];
  for (const raw of source.items) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const row = raw as Record<string, unknown>;
    const rawTextContent = Array.isArray(row.textContent) ? row.textContent : Array.isArray(row.text_content) ? row.text_content : [];
    const textContent = rawTextContent.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const text = String((entry as Record<string, unknown>).text ?? "").trim();
      const sourceValue = String((entry as Record<string, unknown>).source ?? "").trim();
      return text && sourceValue ? [{ text, source: sourceValue }] : [];
    });
    const rawOverlay = row.allowsTextOverlay ?? row.allows_text_overlay;
    const allowsTextOverlay = rawOverlay === "yes" || rawOverlay === "no" || rawOverlay === "platform_default" ? rawOverlay : "platform_default";
    const prompt = String(row.prompt ?? [
      row.subject ? `画面主体：${String(row.subject).trim()}` : "",
      row.composition ? `构图：${String(row.composition).trim()}` : "",
      row.camera ? `镜头：${String(row.camera).trim()}` : "",
      row.style ? `视觉风格：${String(row.style).trim()}` : "",
      Array.isArray(row.negative_constraints) && row.negative_constraints.length ? `负面约束：${row.negative_constraints.map(String).join("；")}` : "",
    ].filter(Boolean).join("\n")).trim();
    const item: CategoryPromptItem = {
      stableId: String(row.stableId ?? row.stable_id ?? row.item_id ?? "").trim(),
      category: String(row.category ?? row.category_code ?? category).trim(),
      title: String(row.title ?? row.image_role ?? "").trim(),
      purpose: String(row.purpose ?? row.composition ?? row.image_role ?? "").trim(),
      referenceImageIds: Array.isArray(row.referenceImageIds) ? row.referenceImageIds.map(String) : Array.isArray(row.reference_image_ids) ? row.reference_image_ids.map(String) : [],
      factRefs: Array.isArray(row.factRefs) ? row.factRefs.map(String) : Array.isArray(row.fact_refs) ? row.fact_refs.map(String) : [],
      prompt,
      allowsTextOverlay,
      textContent,
      aspectRatio: String(row.aspectRatio ?? row.aspect_ratio ?? "1:1").trim(),
      suggestedParams: row.suggestedParams && typeof row.suggestedParams === "object" && !Array.isArray(row.suggestedParams) ? row.suggestedParams as Record<string, unknown> : row.suggested_params && typeof row.suggested_params === "object" && !Array.isArray(row.suggested_params) ? row.suggested_params as Record<string, unknown> : {},
    };
    if (!item.stableId || !item.category || !item.title || !item.purpose || !item.prompt || !item.aspectRatio) return null;
    items.push(item);
  }
  return { schemaVersion: "suite-category-prompt-v1", category, items };
}

function categoryRequestView(request: CategoryPromptRequest) {
  return {
    id: request.id,
    suiteId: request.suiteId,
    planSnapshotId: request.planSnapshotId,
    categoryCode: request.categoryCode,
    requestedCount: request.requestedCount,
    status: request.status,
    idempotencyKey: request.idempotencyKey,
    retryOfRequestId: request.retryOfRequestId,
    templateVersionId: request.templateVersionId,
    provider: request.provider,
    requestSummary: request.requestSummary,
    responseSummary: request.responseSummary,
    items: request.items,
    errorCode: request.errorCode,
    errorMessage: request.errorMessage,
    createdAt: request.createdAt,
    completedAt: request.completedAt,
  };
}

function llmSource(client: LlmClient) {
  return { name: client.provider, model: client.model, isFake: client.isFake, channel: client.channel };
}

function safeDecodePathParam(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function createSuiteStudioApp(deps: { listingRepository?: ListingRepository; repository: SuiteRepository; storage: StorageAdapter; modelSettings?: ModelSettings; provider?: ImageProvider; promptRepository?: PromptRepository; platformRepository?: PlatformRepository; planRepository?: PlanRepository; categoryPromptRepository?: CategoryPromptRepository; taskRepository?: TaskRepository; pipelineRepository?: PipelineRepository; productCardRepository?: ProductCardRepository; productOnboardingRepository?: ProductOnboardingRepository; replicaRepository?: ReplicaRepository; ragClient?: RagClient; llmClient?: LlmClient; libraryRepository?: LibraryRepository; reverseRepository?: ReverseRepository; imageEditorApi?: { request(method: string, path: string, options?: { headers?: Record<string, string>; body?: unknown }): Promise<ImageEditorApiResponse>; clearFinalVersions?(childTaskIds: string[]): Promise<void>; setOnVersionCompleted?(listener: (childTask: { id: string; sourceCardId: string }) => Promise<void>): void }; imageGenerationConcurrency?: number; imageRetryDelayMs?: number }): SuiteStudioApp {
  const imageGenerationConcurrency = Math.max(1, Math.floor(Number.isFinite(deps.imageGenerationConcurrency) ? deps.imageGenerationConcurrency! : 3));
  const imageRetryDelayMs = Math.max(0, Math.floor(Number.isFinite(deps.imageRetryDelayMs) ? deps.imageRetryDelayMs! : 1500));
  const resolveModel = (capability: ModelCapability) => deps.modelSettings?.resolve(capability);
  const resolveImage = async () => {
    const selected = await resolveModel("image");
    return {
      provider: selected ? new GptImageProvider(selected.baseUrl, selected.apiKey) : deps.provider,
      model: selected?.model ?? "gpt-image-2",
      channel: selected?.source,
      imageOptions: selected?.imageOptions ?? defaultImageOptions(selected?.model ?? "gpt-image-2"),
    };
  };
  const resolveVision = async () => {
    const selected = await resolveModel("vision");
    return selected ? new DashScopeLlmClient(selected.baseUrl, selected.apiKey, selected.model, 300_000, selected.source) : deps.llmClient;
  };

  const uploadIdempotency = new Map<string, InputImage>();
  const styleOverrideIdempotency = new Map<string, { suite: import("./types.js").Suite; planStyleGuide: string; styleOverride: string | null; effectiveStyleGuide: string }>();
  const categoryPromptRepository = deps.categoryPromptRepository ?? new MemoryCategoryPromptRepository();
  const pipelineRepository = deps.pipelineRepository ?? new MemoryPipelineRepository();
  const replicaRepository = deps.replicaRepository ?? new MemoryReplicaRepository();
  const productCardRepository = deps.productCardRepository ?? new MemoryProductCardRepository();
  const productCards = createProductCardsApi({ productCards: productCardRepository, storage: deps.storage });
  const productOnboardingRepository =
    deps.productOnboardingRepository ?? new MemoryProductOnboardingRepository();
  const productOnboarding = createProductOnboardingApi({
    sessions: productOnboardingRepository,
    productCards: productCardRepository,
    storage: deps.storage,
    prompts: deps.promptRepository,
    resolveVision,
  });
  const listingRepository = deps.listingRepository ?? new MemoryListingRepository();
  const listing = createListingCopyApi({ jobs: listingRepository, suites: deps.repository, storage: deps.storage, pipelines: pipelineRepository, plans: deps.planRepository, platforms: deps.platformRepository, prompts: deps.promptRepository, vision: resolveVision });
  const reverseRepository = deps.reverseRepository ?? new MemoryReverseRepository();
  if (deps.libraryRepository instanceof MemoryLibraryRepository) {
    deps.libraryRepository.bindSources({
      taskRepository: deps.taskRepository,
      imageEditorApi: deps.imageEditorApi,
    });
  }

  const resolveCategorySourceSnapshot = async (snapshot: PlanSnapshot): Promise<PlanSnapshot> => {
    if (!deps.planRepository) return snapshot;
    let current = snapshot;
    const visited = new Set<string>();
    while (typeof current.requestSummary.sourceSnapshotId === "string" && !visited.has(current.id)) {
      visited.add(current.id);
      const parent = await deps.planRepository.getSnapshot(current.requestSummary.sourceSnapshotId);
      if (!parent) break;
      current = parent;
    }
    return current;
  };

  const listCategoryRequestsForSnapshot = async (snapshot: PlanSnapshot) => {
    const source = await resolveCategorySourceSnapshot(snapshot);
    return categoryPromptRepository.listRequests(source.id);
  };

  const samePlanItems = (left: PlanSnapshot["items"], right: PlanSnapshot["items"]) => left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return other && item.id === other.id && item.prompt === other.prompt && item.title === other.title && item.purpose === other.purpose;
  });

  const appendMaterializedSnapshot = async (candidate: PlanSnapshot, items: PlanSnapshot["items"]) => {
    try {
      return await deps.planRepository!.appendRevision(candidate);
    } catch (error) {
      const conflict = error && typeof error === "object" && (error as { code?: string }).code === "23505" && (error as { constraint?: string }).constraint === "plan_snapshots_suite_id_revision_number_key";
      if (!conflict) throw error;
      const latest = await deps.planRepository!.getLatestSnapshot(candidate.suiteId);
      if (!latest || latest.phase !== "structure_plan" || latest.confirmationStatus !== "confirmed" || !samePlanItems(latest.items, items)) throw error;
      return latest;
    }
  };

  const appendConfirmedSnapshot = async (candidate: PlanSnapshot) => {
    try {
      return await deps.planRepository!.appendRevision(candidate);
    } catch (error) {
      const conflict = error && typeof error === "object" && (error as { code?: string }).code === "23505" && (error as { constraint?: string }).constraint === "plan_snapshots_suite_id_revision_number_key";
      if (!conflict) throw error;
      const latest = await deps.planRepository!.getLatestSnapshot(candidate.suiteId);
      if (!latest || latest.phase !== "structure_plan" || latest.confirmationStatus !== "confirmed" || JSON.stringify(latest.structure) !== JSON.stringify(candidate.structure)) throw error;
      return latest;
    }
  };

  const categoryPlanInput = (
    snapshot: PlanSnapshot,
    categoryCode: string,
    requestedCount: number,
    allocation: Record<string, unknown> | null,
    template: PromptTemplateRuntime,
  ) => {
    const styleCard = snapshot.structure?.globalStyleCard ?? {};
    const factRefs = allocation && Array.isArray(allocation.factRefs) ? allocation.factRefs.map(String) : [];
    const sourceImageIds = allocation && Array.isArray(allocation.sourceImageIds) ? allocation.sourceImageIds.map(String) : snapshot.inputImageIds;
    const categoryName = DETAIL_CATEGORY_NAMES[categoryCode] ?? categoryCode;
    const universalInput: Record<string, unknown> = {};
    for (const key of ["platform", "output_language", "product_name", "product_category", "brand", "target_market_country", "aspect_ratio", "main_image_background", "platform_text_rule", "text_strategy", "emphasis_requirements", "design_constraints"]) {
      if (snapshot.dynamicInput[key] !== undefined) universalInput[key] = snapshot.dynamicInput[key];
    }
    const allowed = new Set(template.inputSchema.map(({ key }) => key));
    const visualStyle = snapshot.dynamicInput.visual_style ?? snapshot.requestSummary.visualStyle;
    if (allowed.has("visual_style") && typeof visualStyle === "string" && visualStyle.trim()) {
      universalInput.visual_style = visualStyle;
    }
    if (allowed.has("selling_point_layouts") && isStructurePlanV2(snapshot.structure) &&
        (categoryCode === "feature_benefit" || categoryCode === "material_detail")) {
      const categories = snapshot.structure.categoryAllocations;
      const featureCount = categories.find(({ category }) => category === "feature_benefit")?.count ?? 0;
      const materialCount = categories.find(({ category }) => category === "material_detail")?.count ?? 0;
      const layouts = resolveSellingPointLayouts(savedSellingPointLayoutIds(snapshot), featureCount + materialCount);
      const slice = allocateSellingPointLayouts(layouts, { feature_benefit: featureCount, material_detail: materialCount })[categoryCode];
      if (slice.length) universalInput.selling_point_layouts = JSON.stringify(slice);
    }
    const facts = designerFactsText(snapshot.dynamicInput);
    if (facts) universalInput.human_supplement = facts;
    const isSellingPointCategory = categoryCode === "feature_benefit" || categoryCode === "material_detail";
    const platformTextRule = isSellingPointCategory
      ? "卖点图与细节图允许并应呈现清晰、克制、基于已确认事实的商业卖点标题、图标与标注（不得套用首图禁字规则）。"
      : (snapshot.dynamicInput.platform_text_rule ?? snapshot.dynamicInput.text_strategy ?? "platform rules from confirmed planning input");
    if (isSellingPointCategory && "text_strategy" in universalInput) {
      universalInput.text_strategy = platformTextRule;
    }
    return {
      ...universalInput,
      category_code: categoryCode,
      category_name: categoryName,
      requested_count: requestedCount,
      global_style_card: styleCard,
      approved_fact_refs: factRefs,
      approved_facts: snapshot.chunks.filter((chunk) => factRefs.includes(chunk.sourceChunkId)).map((chunk) => ({ id: chunk.sourceChunkId, version: chunk.sourceVersion, title: chunk.title, content: chunk.content, fieldValues: chunk.fieldValues })),
      reference_image_ids: sourceImageIds,
      platform_text_rule: platformTextRule,
    };
  };

  const categoryAllocationsForSnapshot = (snapshot: PlanSnapshot) => {
    if (!isStructurePlanV2(snapshot.structure) || snapshot.phase !== "structure_plan" || snapshot.confirmationStatus !== "confirmed" || snapshot.structure.status !== "READY_FOR_REVIEW") return [];
    const result: Array<{ categoryCode: string; requestedCount: number; allocation: Record<string, unknown> | null }> = [];
    if (snapshot.structure.mainAllocation.count > 0) result.push({ categoryCode: "main", requestedCount: snapshot.structure.mainAllocation.count, allocation: snapshot.structure.mainAllocation as unknown as Record<string, unknown> });
    for (const raw of snapshot.structure.categoryAllocations) {
      const allocation = raw as unknown as Record<string, unknown>;
      const code = String(allocation.category);
      if (!DETAIL_CATEGORY_CODES.has(code)) continue;
      const count = Number(allocation.count);
      if (Number.isInteger(count) && count > 0) result.push({ categoryCode: code, requestedCount: count, allocation });
    }
    return result;
  };

  const loadCategoryVisionImages = async (suiteId: string, snapshot: PlanSnapshot, allocation: Record<string, unknown> | null) => {
    const requestedIds = allocation && Array.isArray(allocation.sourceImageIds) ? allocation.sourceImageIds.map(String) : snapshot.inputImageIds;
    const images = await deps.repository.getInputImages(suiteId);
    const selected = images.filter((image) => requestedIds.includes(image.id));
    if (!selected.length) throw new Error("PLAN_INPUT_IMAGE_NOT_FOUND");
    const visionImages: NonNullable<CategoryPromptLlmInput["visionImages"]> = [];
    for (const image of selected) {
      let sourceKind: "base" | "original" = "original";
      let sourceVersionId: string | null = null;
      let sourceObjectKey = image.originalObjectKey;
      if (snapshot.requestSummary.useOriginalImages !== true && image.currentBaseVersionId) {
        const base = await deps.repository.getBaseImageVersion(suiteId, image.id, image.currentBaseVersionId);
        if (base) { sourceKind = "base"; sourceVersionId = base.id; sourceObjectKey = base.objectKey; }
      }
      if (sourceKind === "original") {
        const generationInputKey = image.originalObjectKey.replace(/\/original$/, "/generation-input.jpg");
        const generationInput = generationInputKey !== image.originalObjectKey ? await deps.storage.get(generationInputKey) : null;
        if (generationInput) { sourceObjectKey = generationInputKey; }
      }
      const source = await deps.storage.get(sourceObjectKey);
      if (!source) throw new Error("PLAN_INPUT_IMAGE_NOT_FOUND");
      visionImages.push({ id: image.id, sourceKind, sourceVersionId, mimeType: source.contentType, bytes: source.bytes });
    }
    return visionImages;
  };

  const createTaskBatch = async (suiteId: string, tasks: SuiteTask[], kind: "batch" | "single" | "retry", idempotencyKey: string, failedAttempt?: TaskGenerationAttempt, sourceVersionIds: Record<string, string> = {}, editSource?: { version: TaskImageVersion; versions: TaskImageVersion[] }) => {
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
        const finalPrompt = declareImageEditInputs(frozenPrompt, attachedInputs);
        const providerPrompt = declareImageEditInputs(String(version.promptSnapshot.providerPrompt ?? frozenPrompt), attachedInputs);
        const stored = await deps.storage.get(version.objectKey);
        if (!stored) throw new Error("TASK_INVALID_SOURCE");
        const { width, height } = await sharp(stored.bytes).metadata();
        attempts.push({
          id: randomUUID(), slotId: slots[index].id, attemptNo: 1, provider: providerName, model, endpoint: "/v1/images/edits",
          requestSummary: {
            n: 1, imageCount: inputImages.length, inputRoles: inputImages.map((image) => image.role),
            size: resolveClosestImageSize(width, height, imageOptions), quality: imageOptions.quality ?? "high",
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
      const generationParams = task.generationParams ?? {};
      const materialRefs = Array.isArray(generationParams.productMaterialRefs) ? generationParams.productMaterialRefs.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object").slice(0, 3) : [];
      const inputImages: Array<{ bytes: Buffer; mimeType: string; filename: string; role: string; objectKey: string; resourceId?: string; resourceVersionId?: string; libraryReferenceId?: string }> = [];
      const currentTaskVersionId = sourceVersionIds[task.id];
      const isReplicaTask = task.originKind === "replica";
      const replicaPromptMeta = isReplicaTask ? asRecord(generationParams.replicaPromptSnapshot) : null;
      const replicaCloneLevel = isReplicaTask ? resolveReplicaCloneLevel(generationParams) : "high";
      let replicaProductCount = 0;

      if (isReplicaTask) {
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
      const shouldApplyStyleOverride = Boolean(activeStyleOverride) && task.originKind !== "reverse_import" && task.originKind !== "replica";
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
        (isReplicaTask && typeof replicaPromptMeta?.templateVersionId === "string"
          ? replicaPromptMeta.templateVersionId
          : null) ?? planTemplateVersionId;
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
      attempts.push({ id: randomUUID(), slotId: slots[index].id, attemptNo: 1, provider: providerName, model, endpoint: "/v1/images/edits", requestSummary: { n: 1, imageCount: inputImages.length, inputRoles: inputImages.map((item) => item.role), size: resolveImageSize(typeof generationParams.size === "string" ? generationParams.size : "1K", typeof generationParams.ratio === "string" ? generationParams.ratio : task.imageType === "main" ? "1:1" : "3:4", imageOptions.sizeMode), quality: generationParams.quality ?? "medium" }, promptSnapshot: { prompt: task.promptDraft, promptRevision: task.promptRevision, planSnapshotId: task.planSnapshotId, planItemId: task.planItemId, templateVersionId: effectiveTemplateVersionId, reversePromptVersionId: task.reversePromptVersionId ?? null, categoryCode: task.categoryCode ?? null, referenceImageIds: task.referenceImageIds ?? [], factRefs: task.factRefs ?? [], globalStyleCard: effectiveGlobalStyleCard, styleOverride: shouldApplyStyleOverride ? activeStyleOverride : null, ...replicaFrozenFields, finalPrompt, providerPrompt, generationParams, productMaterialRefs: materialRefs, explosiveReferenceEnabled: generationParams.explosiveReferenceEnabled !== false, inputImages: inputSnapshot }, promptSha256: effectivePromptSha256, contextSnapshot: { channel, model, suiteTaskId: task.id, planSnapshotId: task.planSnapshotId, planItemId: task.planItemId, templateVersionId: effectiveTemplateVersionId, reversePlanId: task.reversePlanId ?? null, reverseReferenceId: task.reverseReferenceId ?? null, replicaReferenceId: task.replicaReferenceId ?? null, sourceRevision: task.sourceRevision ?? 0, imageType: task.imageType, categoryCode: task.categoryCode ?? null, globalStyleCard: effectiveGlobalStyleCard, styleOverride: shouldApplyStyleOverride ? activeStyleOverride : null, inputImages: inputImages.map((item) => ({ objectKey: item.objectKey, mimeType: item.mimeType, filename: item.filename, role: item.role })) }, sourceKind, sourceObjectKey, sourceInputImageId, sourceBaseVersionId, sourceLibraryReferenceId, sourceResourceVersionId, status: "running", errorCode: null, errorMessage: null, externalRequestId: null, startedAt: now, finishedAt: null });
    }
    const reservation = await deps.taskRepository.beginBatch({ batch, slots, attempts });
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
    if (error instanceof Error && error.message === "IMAGE_SIZE_UNSUPPORTED") return "IMAGE_SIZE_UNSUPPORTED";
    if (error instanceof Error && error.message.includes("TIMEOUT")) return "TASK_IMAGE_PROVIDER_TIMEOUT";
    return "TASK_IMAGE_PROVIDER_FAILED";
  };

  const executeTaskAttempt = async (attempt: TaskGenerationAttempt, task: SuiteTask, slot: TaskResultSlot, provider: ImageProvider | undefined) => {
    if (!deps.taskRepository) return;
    const finish = new Date().toISOString();
    if (!provider) { await deps.taskRepository.failAttempt(attempt.id, "TASK_IMAGE_PROVIDER_NOT_CONFIGURED", errorMessages.TASK_IMAGE_PROVIDER_NOT_CONFIGURED, finish); return; }
    try {
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
      let generated: Awaited<ReturnType<ImageProvider["edit"]>>;
      try {
        generated = await provider.edit(editRequest);
      } catch (firstError) {
        const firstCode = classifyTaskImageError(firstError);
        if (firstCode !== "TASK_IMAGE_PROVIDER_FAILED" && firstCode !== "TASK_IMAGE_PROVIDER_TIMEOUT") {
          throw firstError;
        }
        if (imageRetryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, imageRetryDelayMs));
        }
        generated = await provider.edit(editRequest);
      }
      const processed = await processGeneratedImage(generated.bytes);
      const objectKey = `suites/${task.suiteId}/tasks/${task.id}/versions/${randomUUID()}/final.png`;
      await deps.storage.put({ key: objectKey, bytes: processed.bytes, contentType: processed.mimeType });
      if (task.originKind === "replica") {
        await clearReplicaCardFinalLocks(task);
      }
      await deps.taskRepository.completeAttempt({ attemptId: attempt.id, slotId: slot.id, taskId: task.id, objectKey, processObjectKeys: [], sha256: processed.sha256, width: processed.width, height: processed.height, mimeType: processed.mimeType, completedAt: new Date().toISOString() });
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
      const errorMessage = errorMessages[code] ?? (code === "TASK_IMAGE_PROVIDER_TIMEOUT" ? errorMessages.IMAGE_PROVIDER_TIMEOUT : errorMessages.TASK_IMAGE_PROVIDER_FAILED);
      await deps.taskRepository.failAttempt(attempt.id, code, errorMessage, new Date().toISOString()).catch(() => undefined);
    }
  };

  const loadSuiteImageEditChildren = async (tasks: SuiteTask[]): Promise<DeliveryEditChildLike[]> => {
    if (!deps.imageEditorApi) return [];
    const response = await deps.imageEditorApi.request("GET", "/api/image-editor/tasks");
    const data = dataOf(response);
    if (response.status !== 200 || !Array.isArray(data)) return [];
    const all = data as DeliveryEditChildLike[];
    const allowed = new Set(tasks.map((task) => task.id));
    let changed = true;
    while (changed) {
      changed = false;
      for (const child of all) {
        const taskId = typeof child.task?.id === "string" ? child.task.id : "";
        const sourceCardId = typeof child.task?.sourceCardId === "string" ? child.task.sourceCardId : "";
        if (taskId && sourceCardId && allowed.has(sourceCardId) && !allowed.has(taskId)) { allowed.add(taskId); changed = true; }
      }
    }
    return all.filter((child) => typeof child.task?.id === "string" && allowed.has(child.task.id));
  };

  const clearReplicaCardFinalLocks = async (task: SuiteTask) => {
    if (!deps.taskRepository || task.originKind !== "replica") return;
    await deps.taskRepository.clearFinalVersion?.(task.id);
    if (!deps.imageEditorApi?.clearFinalVersions) return;
    const children = await loadSuiteImageEditChildren([task]);
    const childIds = children
      .map((child) => (typeof child.task?.id === "string" ? child.task.id : ""))
      .filter(Boolean);
    if (childIds.length) {
      await deps.imageEditorApi.clearFinalVersions(childIds);
    }
  };

  const resolveRootTaskForEditCard = async (sourceCardId: string): Promise<SuiteTask | null> => {
    if (!deps.taskRepository || !sourceCardId) return null;
    const direct = await deps.taskRepository.getTask(sourceCardId);
    if (direct) return direct;
    if (!deps.imageEditorApi) return null;
    const response = await deps.imageEditorApi.request("GET", "/api/image-editor/tasks");
    const data = dataOf(response);
    if (response.status !== 200 || !Array.isArray(data)) return null;
    const childById = new Map<string, string>();
    for (const entry of data as DeliveryEditChildLike[]) {
      const id = typeof entry.task?.id === "string" ? entry.task.id : "";
      const parent = typeof entry.task?.sourceCardId === "string" ? entry.task.sourceCardId : "";
      if (id && parent) childById.set(id, parent);
    }
    const visited = new Set<string>();
    let current = sourceCardId;
    while (current && !visited.has(current)) {
      visited.add(current);
      const next = childById.get(current);
      if (!next) break;
      const root = await deps.taskRepository.getTask(next);
      if (root) return root;
      current = next;
    }
    return null;
  };

  deps.imageEditorApi?.setOnVersionCompleted?.(async (childTask) => {
    const rootTask = await resolveRootTaskForEditCard(childTask.sourceCardId);
    if (rootTask?.originKind === "replica") {
      await clearReplicaCardFinalLocks(rootTask);
    }
  });
  const pipeline = createSuitePipeline({
    repository: deps.repository, storage: deps.storage, platformRepository: deps.platformRepository,
    promptRepository: deps.promptRepository, planRepository: deps.planRepository, taskRepository: deps.taskRepository,
    replicaRepository, productCardRepository,
    hasPlanningModel: () => Boolean(deps.llmClient || deps.modelSettings), pipelineRepository, listingRepository,
    startListingCopy: listing.startPipeline, appendConfirmedSnapshot, loadSuiteImageEditChildren, request,
  });
  const replicaPipeline = createReplicaPipeline({
    repository: deps.repository,
    storage: deps.storage,
    replicaRepository,
    pipelineRepository,
    productCardRepository,
    taskRepository: deps.taskRepository,
    promptRepository: deps.promptRepository,
    libraryRepository: deps.libraryRepository,
    resolveVision,
    resolveImageOptions: async () => (await resolveImage()).imageOptions,
    request,
  });

  async function request(method: string, path: string, options: { headers?: Record<string, string>; body?: unknown } = {}): Promise<AppResponse> {
    if (/^\/api\/listing-copies(?:[/?]|$)/.test(path)) return listing.request(method, path, options.body);
    if (/^\/api\/product-cards(?:[/?]|$)/.test(path)) return productCards.request(method, path, options.body);
    if (/^\/api\/product-onboarding\/sessions(?:[/?]|$)/.test(path)) return productOnboarding.request(method, path, options.body);
    if (path === "/api/model-settings" || path.startsWith("/api/model-settings/")) return deps.modelSettings ? deps.modelSettings.request(method, path, options.body) : fail("NOT_FOUND", 404);
    if (method === "POST" && path === "/api/image-editor/translate-text") {
      const body = asRecord(options.body, { allowArrays: true });
      const targetLanguage = typeof body.targetLanguage === "string" && body.targetLanguage.trim() ? body.targetLanguage.trim() : "英文";
      const rawItems = Array.isArray(body.items) ? body.items : [];
      const items = rawItems
        .map((item, index) => {
          const row = asRecord(item, { allowArrays: true });
          return { id: String(row.id ?? `block-${index + 1}`), text: String(row.text ?? "").trim() };
        })
        .filter((item) => item.text.length > 0);
      if (!items.length) return fail("TRANSLATE_ITEMS_REQUIRED", 400);
      const llmClient = await resolveVision();
      if (!llmClient?.translateTexts) return fail("TRANSLATE_LLM_NOT_CONFIGURED", 503);
      try {
        const translations = await llmClient.translateTexts({
          targetLanguage,
          items,
          preserveBrandTerms: body.preserveBrandTerms !== false,
        });
        return ok({
          targetLanguage,
          translations,
          model: llmClient.model,
          channelName: llmClient.channel?.channelName ?? null,
        });
      } catch (error) {
        return fail(error instanceof Error ? error.message : "LLM_FAILED", 502);
      }
    }
    const editVersionPreviewMatch = path.match(/^\/api\/image-editor\/tasks\/([^/]+)\/versions\/([^/]+)\/preview$/);
    if (method === "GET" && editVersionPreviewMatch) {
      if (!deps.imageEditorApi) return fail("IMAGE_EDITOR_NOT_CONFIGURED", 503);
      const taskRes = await deps.imageEditorApi.request("GET", `/api/image-editor/tasks/${editVersionPreviewMatch[1]}`);
      const taskData = dataOf(taskRes) as { versions?: Array<{ id?: string; objectKey?: string }> } | null;
      const version = taskRes.status === 200 ? taskData?.versions?.find((item) => item.id === editVersionPreviewMatch[2]) : null;
      return version?.objectKey ? previewObject(version.objectKey, deps.storage) : fail("NOT_FOUND", 404);
    }
    const selectEditVersionMatch = path.match(/^\/api\/image-editor\/tasks\/([^/]+)\/versions\/([^/]+)\/select$/);
    if (path.startsWith("/api/image-editor/")) {
      if (!deps.imageEditorApi) return fail("IMAGE_EDITOR_NOT_CONFIGURED", 503);
      const res = await deps.imageEditorApi.request(method, path, options);
      if (
        method === "POST" &&
        selectEditVersionMatch &&
        res.status >= 200 &&
        res.status < 300 &&
        asRecord(options.body, { allowArrays: true }).selection === "final" &&
        deps.libraryRepository
      ) {
        await deps.libraryRepository.restoreResource(`edit-version:${selectEditVersionMatch[2]}`);
      }
      return res;
    }
    const idempotencyKey = options.headers?.["idempotency-key"] ?? options.headers?.["Idempotency-Key"];

    if (method === "POST" && path === "/api/replicas") return replicaPipeline.createReplica(idempotencyKey, options.body);
    const replicaStudioStateMatch = path.match(/^\/api\/replicas\/([^/]+)\/studio-state$/);
    if (method === "GET" && replicaStudioStateMatch) {
      const suite = await deps.repository.getSuite(replicaStudioStateMatch[1]);
      if (!suite) return fail("INVALID_SUITE_ID", 404);
      if (suite.origin !== "replica") return fail("INVALID_SUITE_ORIGIN", 400);
      return pipeline.getStudioState(replicaStudioStateMatch[1]);
    }
    const replicaResumeMatch = path.match(/^\/api\/replicas\/([^/]+)\/resume$/);
    if (method === "POST" && replicaResumeMatch) return replicaPipeline.resumeReplica(replicaResumeMatch[1], idempotencyKey);
    const replicaReverseAssetMatch = path.match(/^\/api\/replicas\/([^/]+)\/tasks\/([^/]+)\/reverse-asset$/);
    if (method === "POST" && replicaReverseAssetMatch) return replicaPipeline.saveReverseAsset(replicaReverseAssetMatch[1], replicaReverseAssetMatch[2], options.body);
    const replicaPreviewMatch = path.match(/^\/api\/replicas\/([^/]+)\/references\/([^/]+)\/preview(?:\/(original|thumbnail))?(?:\?(.*))?$/);
    if (method === "GET" && replicaPreviewMatch) {
      const queryKind = new URLSearchParams(replicaPreviewMatch[4] ?? "").get("kind");
      const kind = (replicaPreviewMatch[3] ?? queryKind) === "original" ? "original" : "thumbnail";
      return replicaPipeline.previewReference(replicaPreviewMatch[1], replicaPreviewMatch[2], kind);
    }

    if (method === "POST" && path === "/api/suites/one-click-generate") return pipeline.startRun(idempotencyKey, options.body);
    const suitePipelineMatch = path.match(/^\/api\/suites\/([^/]+)\/pipeline$/);
    if (method === "POST" && suitePipelineMatch) {
      return pipeline.startRun(idempotencyKey, {
        ...asRecord(options.body),
        suiteId: suitePipelineMatch[1],
      });
    }
    const resumeMatch = path.match(/^\/api\/suites\/([^/]+)\/one-click-generate\/resume$/);
    if (method === "POST" && resumeMatch) return pipeline.resumeRun(resumeMatch[1], idempotencyKey, options.body);
    const studioStateMatch = path.match(/^\/api\/suites\/([^/]+)\/studio-state$/);
    if (method === "GET" && studioStateMatch) return pipeline.getStudioState(studioStateMatch[1]);
    const feedMatch = path.match(/^\/api\/suites\/feed(?:\?(.*))?$/);
    if (method === "GET" && feedMatch) return pipeline.getFeed(feedMatch[1]);
    const reversePlanMatch = path.match(/^\/api\/reverse-plans\/([^/]+)$/);
    if (method === "POST" && path === "/api/reverse-plans") return fail("REVERSE_PLAN_READ_ONLY", 410);
    if (method === "GET" && path === "/api/reverse-plans") return ok(await reverseRepository.listPlans());
    if (reversePlanMatch && method === "GET") { const plan = await reverseRepository.getPlan(reversePlanMatch[1]); return plan ? ok(plan) : fail("INVALID_REVERSE_PLAN", 404); }
    if (reversePlanMatch && method === "PATCH") return fail("REVERSE_PLAN_READ_ONLY", 410);
    const reverseRefsMatch = path.match(/^\/api\/reverse-plans\/([^/]+)\/references$/);
    if (reverseRefsMatch && method === "POST") return fail("REVERSE_PLAN_READ_ONLY", 410);
    const reverseRefMatch = path.match(/^\/api\/reverse-plans\/([^/]+)\/references\/([^/]+)$/);
    if (reverseRefMatch && (method === "PATCH" || method === "DELETE")) return fail("REVERSE_PLAN_READ_ONLY", 410);
    const reverseRunMatch = path.match(/^\/api\/reverse-plans\/([^/]+)\/references\/([^/]+)\/(run|retry)$/);
    if (reverseRunMatch && method === "POST") return fail("REVERSE_PLAN_READ_ONLY", 410);
    const reverseBatchMatch = path.match(/^\/api\/reverse-plans\/([^/]+)\/attempts$/);
    if (reverseBatchMatch && method === "POST") return fail("REVERSE_PLAN_READ_ONLY", 410);
    const reverseAttemptMatch = path.match(/^\/api\/reverse-plans\/([^/]+)\/attempts\/([^/]+)$/);
    if (reverseAttemptMatch && method === "GET") { const plan = await reverseRepository.getPlan(reverseAttemptMatch[1]); if (!plan) return fail("INVALID_REVERSE_PLAN", 404); const found = plan.references.flatMap((item) => item.attempts).find((item) => item.id === reverseAttemptMatch[2]); return found ? ok(found) : fail("REVERSE_REFERENCE_NOT_FOUND", 404); }
    const reversePromptMatch = path.match(/^\/api\/reverse-plans\/([^/]+)\/references\/([^/]+)\/prompt$/);
    if (reversePromptMatch && method === "PATCH") return fail("REVERSE_PLAN_READ_ONLY", 410);
    const reverseAssetMatch = path.match(/^\/api\/reverse-plans\/([^/]+)\/references\/([^/]+)\/asset$/);
    if (reverseAssetMatch && method === "POST") {
      if (!deps.libraryRepository) return fail("LIBRARY_REPOSITORY_NOT_CONFIGURED", 503); const plan = await reverseRepository.getPlan(reverseAssetMatch[1]); if (!plan) return fail("INVALID_REVERSE_PLAN", 404); const ref = plan.references.find((item) => item.id === reverseAssetMatch[2]); if (!ref) return fail("REVERSE_REFERENCE_NOT_FOUND", 404); const prompt = ref.promptVersions.find((item) => item.id === ref.effectivePromptVersionId); if (!prompt) return fail("REVERSE_OUTPUT_INVALID");
      const result = await deps.libraryRepository.createReverseReferenceAsset({ title: ref.filename, summary: `${plan.mode === "main" ? "主图" : "详情图"}反推资产，不作为商品事实`, objectKey: ref.objectKey, mimeType: ref.mimeType, promptSnapshot: { prompt: prompt.prompt, promptVersionId: prompt.id }, visualStructure: { mode: plan.mode }, source: { reversePlanId: plan.id, referenceId: ref.id, sha256: ref.sha256, templateVersionId: prompt.templateVersionId, provider: prompt.provider } }); return ok(result, 201);
    }
    const reverseCanvasMatch = path.match(/^\/api\/reverse-plans\/([^/]+)\/canvas-imports$/);
    if (reverseCanvasMatch && method === "POST") {
      if (!idempotencyKey) return fail("MISSING_IDEMPOTENCY_KEY");
      if (!deps.taskRepository) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);
      const plan = await reverseRepository.getPlan(reverseCanvasMatch[1]); if (!plan) return fail("INVALID_REVERSE_PLAN", 404);
      const items = plan.references.map((reference) => ({ reference, prompt: reference.promptVersions.find((version) => version.id === reference.effectivePromptVersionId) })).filter((item): item is { reference: ReverseReference; prompt: ReversePromptVersion } => Boolean(item.prompt && item.reference.attempts.some((attempt) => attempt.status === "succeeded")));
      if (!items.length) return fail("REVERSE_CANVAS_NO_RESULTS", 409);
      const body = asRecord(options.body, { allowArrays: true });
      let suite = typeof body.targetSuiteId === "string" ? await deps.repository.getSuite(body.targetSuiteId) : null;
      if (typeof body.targetSuiteId === "string" && !suite) return fail("INVALID_SUITE_ID", 404);
      if (suite?.origin === "replica") return fail("INVALID_SUITE_ORIGIN", 400, "复刻批次不支持导入画布任务");
      if (!suite) suite = await deps.repository.createSuite(typeof body.name === "string" && body.name.trim() ? body.name.trim() : `爆品图反推 ${new Date().toISOString().slice(0, 10)}`, `${idempotencyKey}:suite`, "canvas");
      const taskGroupId = typeof body.taskGroupId === "string" ? body.taskGroupId : randomUUID();
      const result = await deps.taskRepository.createReverseTasks({ suiteId: suite.id, reversePlanId: plan.id, taskGroupId, mode: plan.mode, idempotencyKey, items: items.map(({ reference, prompt }) => ({ referenceId: reference.id, ordinal: reference.ordinal, filename: reference.filename, promptVersionId: prompt.id, prompt: prompt.prompt })) });
      return ok({ suiteId: suite.id, taskGroupId: result.created[0]?.reverseTaskGroupId ?? taskGroupId, taskIds: result.created.map((task) => task.id), duplicate: result.duplicate }, result.duplicate ? 200 : 201);
    }
    if (method === "POST" && path === "/api/suites") {
      const body = asRecord(options.body, { allowArrays: true });
      const name = "name" in body ? String(body.name).trim() : "";
      if (!name) return fail("EMPTY_NAME");
      if (body.origin !== undefined && body.origin !== "suite_studio" && body.origin !== "canvas") {
        return fail("INVALID_SUITE_ORIGIN", 400);
      }
      const origin = body.origin === "canvas" ? "canvas" : "suite_studio";
      return ok(await deps.repository.createSuite(name, idempotencyKey, origin), 201);
    }
    const suiteListMatch = path.match(/^\/api\/suites(?:\?(.*))?$/);
    if (method === "GET" && suiteListMatch) {
      const canvasOnly = new URLSearchParams(suiteListMatch[1]).get("view") === "canvas";
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
    }
    const enrichLibraryResource = (resource: import("./types.js").LibraryResource): import("./types.js").LibraryResource => {
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
    if (method === "POST" && path === "/api/library/resources/batch-delete") {
      if (!deps.libraryRepository) return fail("LIBRARY_REPOSITORY_NOT_CONFIGURED", 503);
      const body = asRecord(options.body, { allowArrays: true });
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
    }
    const libraryResourceMatch = path.match(/^\/api\/library\/resources\/([^/]+)$/);
    if (method === "GET" && libraryResourceMatch) {
      if (!deps.libraryRepository) return fail("LIBRARY_REPOSITORY_NOT_CONFIGURED", 503);
      const resourceId = safeDecodePathParam(libraryResourceMatch[1]);
      if (!resourceId) return fail("LIBRARY_RESOURCE_NOT_FOUND", 404);
      const resource = await deps.libraryRepository.getResource(resourceId);
      return resource ? ok(enrichLibraryResource(resource)) : fail("LIBRARY_RESOURCE_NOT_FOUND", 404);
    }
    if (method === "DELETE" && libraryResourceMatch) {
      if (!deps.libraryRepository) return fail("LIBRARY_REPOSITORY_NOT_CONFIGURED", 503);
      const resourceId = safeDecodePathParam(libraryResourceMatch[1]);
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
    }
    const libraryPreviewMatch = path.match(/^\/api\/library\/resources\/([^/]+)\/preview$/);
    if (method === "GET" && libraryPreviewMatch) return await (async () => {
      if (!deps.libraryRepository) return fail("LIBRARY_REPOSITORY_NOT_CONFIGURED", 503);
      const resourceId = safeDecodePathParam(libraryPreviewMatch[1]);
      if (!resourceId) return fail("LIBRARY_RESOURCE_NOT_FOUND", 404);
      const resource = await deps.libraryRepository.getResource(resourceId, { includeDeleted: true });
      if (!resource) return fail("LIBRARY_RESOURCE_NOT_FOUND", 404);
      const target = await deps.libraryRepository.getPreviewObject(resource.id);
      return target ? previewObject(target.objectKey, deps.storage) : fail("OBJECT_NOT_FOUND", 404);
    })();
    if (method === "GET" && path.startsWith("/api/library/resources")) {
      if (!deps.libraryRepository) return fail("LIBRARY_REPOSITORY_NOT_CONFIGURED", 503);
      const params = new URLSearchParams(path.split("?")[1] ?? "");
      const resourceType = params.get("resourceType") as import("./types.js").LibraryResourceType | null;
      const scopeParam = params.get("scope");
      if (scopeParam && scopeParam !== "image") return fail("INVALID_LIBRARY_SCOPE");
      const stage = params.get("stage") as PromptStage | null;
      if (stage && !PROMPT_STAGES.includes(stage)) return fail("INVALID_PROMPT_STAGE");
      const status = params.get("status") as import("./types.js").LibraryAssetStatus | null;
      if (status && !["draft", "published", "archived", "retired"].includes(status)) return fail("INVALID_LIBRARY_STATUS");
      const rawPage = Number(params.get("page") ?? 1);
      const rawPageSize = Number(params.get("pageSize") ?? 24);
      const page = Number.isFinite(rawPage) ? Math.floor(rawPage) : 1;
      const pageSize = Number.isFinite(rawPageSize) ? Math.floor(rawPageSize) : 24;
      const listed = await deps.libraryRepository.listResources({ resourceType: resourceType ?? undefined, scope: scopeParam === "image" ? "image" : undefined, stage: stage ?? undefined, suiteId: params.get("suiteId") ?? undefined, query: params.get("query") ?? undefined, status: status ?? undefined, page, pageSize });
      return ok({ ...listed, items: listed.items.map(enrichLibraryResource) });
    }
    const reverseAssetStatusMatch = path.match(/^\/api\/library\/resources\/([^/]+)\/status$/);
    if (method === "POST" && reverseAssetStatusMatch) {
      if (!deps.libraryRepository) return fail("LIBRARY_REPOSITORY_NOT_CONFIGURED", 503);
      const resourceId = safeDecodePathParam(reverseAssetStatusMatch[1]);
      if (!resourceId) return fail("LIBRARY_RESOURCE_NOT_FOUND", 404);
      const body = asRecord(options.body, { allowArrays: true });
      const status = body.status as import("./types.js").LibraryAssetStatus;
      if (!["draft", "published", "archived"].includes(status)) return fail("INVALID_LIBRARY_STATUS");
      const resource = await deps.libraryRepository.setResourceStatus(resourceId, status);
      return resource ? ok(resource) : fail("LIBRARY_RESOURCE_NOT_FOUND", 404);
    }
    if (method === "POST" && path === "/api/library/reverse-reference-assets") {
      if (!deps.libraryRepository) return fail("LIBRARY_REPOSITORY_NOT_CONFIGURED", 503);
      const body = asRecord(options.body, { allowArrays: true });
      if (typeof body.title !== "string" || typeof body.objectKey !== "string" || typeof body.mimeType !== "string" || !body.promptSnapshot || typeof body.promptSnapshot !== "object") return fail("INVALID_REVERSE_REFERENCE_ASSET");
      const asset = await deps.libraryRepository.createReverseReferenceAsset({ suiteId: typeof body.suiteId === "string" ? body.suiteId : null, title: body.title, summary: typeof body.summary === "string" ? body.summary : "", objectKey: body.objectKey, mimeType: body.mimeType, promptSnapshot: body.promptSnapshot as Record<string, unknown>, visualStructure: body.visualStructure && typeof body.visualStructure === "object" ? body.visualStructure as Record<string, unknown> : {}, source: body.source && typeof body.source === "object" ? body.source as Record<string, unknown> : {} });
      return ok(asset, 201);
    }
    const libraryReferencesMatch = path.match(/^\/api\/suites\/([^/]+)\/library\/references(?:\/([^/?]+))?(?:\?.*)?$/);
    if (libraryReferencesMatch && method === "GET") {
      if (!deps.libraryRepository) return fail("LIBRARY_REPOSITORY_NOT_CONFIGURED", 503);
      const suiteId = safeDecodePathParam(libraryReferencesMatch[1]);
      if (!suiteId) return fail("INVALID_SUITE_ID", 404);
      const params = new URLSearchParams(path.split("?")[1] ?? "");
      return ok(await deps.libraryRepository.listReferences(suiteId, (params.get("targetType") as "plan" | "task" | null) ?? undefined, params.get("targetId") ?? undefined));
    }
    if (libraryReferencesMatch && method === "POST" && !libraryReferencesMatch[2]) {
      if (!deps.libraryRepository) return fail("LIBRARY_REPOSITORY_NOT_CONFIGURED", 503);
      if (!idempotencyKey) return fail("MISSING_IDEMPOTENCY_KEY");
      const suiteId = safeDecodePathParam(libraryReferencesMatch[1]);
      if (!suiteId) return fail("INVALID_SUITE_ID", 404);
      const body = asRecord(options.body, { allowArrays: true });
      if (typeof body.resourceId !== "string" || (body.targetType !== "plan" && body.targetType !== "task") || typeof body.targetId !== "string") return fail("LIBRARY_RESOURCE_NOT_FOUND");
      try { const result = await deps.libraryRepository.createReference({ suiteId, resourceId: body.resourceId, targetType: body.targetType, targetId: body.targetId, idempotencyKey, createdBy: typeof body.createdBy === "string" ? body.createdBy : null }); return ok(result.reference, result.duplicate ? 200 : 201); }
      catch (error) { const code = error instanceof Error ? error.message : "LIBRARY_RESOURCE_NOT_FOUND"; return fail(code, code === "LIBRARY_RESOURCE_FORBIDDEN" || code === "LIBRARY_TARGET_NOT_FOUND" ? 403 : code === "LIBRARY_RESOURCE_NOT_FOUND" ? 404 : 409); }
    }
    if (libraryReferencesMatch && method === "DELETE" && libraryReferencesMatch[2]) {
      if (!deps.libraryRepository) return fail("LIBRARY_REPOSITORY_NOT_CONFIGURED", 503);
      const suiteId = safeDecodePathParam(libraryReferencesMatch[1]);
      const referenceId = safeDecodePathParam(libraryReferencesMatch[2]);
      if (!suiteId || !referenceId) return fail("LIBRARY_RESOURCE_NOT_FOUND", 404);
      const archived = await deps.libraryRepository.archiveReference(suiteId, referenceId);
      return archived ? ok(archived) : fail("LIBRARY_RESOURCE_NOT_FOUND", 404);
    }
    const promptCopyMatch = path.match(/^\/api\/prompt-templates\/([^/]+)\/copy(?:\?.*)?$/);
    const promptVersionMatch = path.match(/^\/api\/prompt-templates\/([^/]+)\/versions$/);
    if (method === "GET" && promptVersionMatch) {
      if (!deps.promptRepository) return fail("PROMPT_REPOSITORY_NOT_CONFIGURED", 503);
      const versions = await deps.promptRepository.listVersions(promptVersionMatch[1]);
      return ok(versions.map((version) => withPromptTemplateUsage(version)));
    }
    const promptLifecycleMatch = path.match(/^\/api\/prompt-templates\/([^/?]+)$/);
    if (method === "GET" && promptLifecycleMatch) {
      if (!deps.promptRepository) return fail("PROMPT_REPOSITORY_NOT_CONFIGURED", 503);
      const versionId = safeDecodePathParam(promptLifecycleMatch[1]);
      if (!versionId) return fail("PROMPT_TEMPLATE_NOT_FOUND", 404);
      const version = await deps.promptRepository.getVersion(versionId);
      if (!version) return fail("PROMPT_TEMPLATE_NOT_FOUND", 404);
      return ok(withPromptTemplateUsage(version));
    }
    if (method === "PATCH" && promptLifecycleMatch) {
      if (!deps.promptRepository) return fail("PROMPT_REPOSITORY_NOT_CONFIGURED", 503);
      const body = asRecord(options.body, { allowArrays: true });
      const updated = await deps.promptRepository.updateDraft(promptLifecycleMatch[1], {
        name: typeof body.name === "string" ? body.name : undefined,
        body: typeof body.body === "string" ? body.body : undefined,
        userPromptTemplate: typeof body.userPromptTemplate === "string" ? body.userPromptTemplate : undefined,
        inputSchema: Array.isArray(body.inputSchema) ? body.inputSchema as never : undefined,
        outputSchema: body.outputSchema && typeof body.outputSchema === "object" ? body.outputSchema as Record<string, unknown> : undefined,
        applicability: body.applicability && typeof body.applicability === "object" ? body.applicability as Record<string, unknown> : undefined,
      });
      return updated ? ok(withPromptTemplateUsage(updated)) : fail("PROMPT_DRAFT_NOT_FOUND", 404);
    }
    const promptCopyPostMatch = path.match(/^\/api\/prompt-templates\/([^/]+)\/copy$/);
    if (method === "POST" && promptCopyPostMatch) {
      if (!deps.promptRepository) return fail("PROMPT_REPOSITORY_NOT_CONFIGURED", 503);
      const copied = await deps.promptRepository.copyVersion(promptCopyPostMatch[1]);
      return copied ? ok(withPromptTemplateUsage(copied), 201) : fail("PROMPT_TEMPLATE_NOT_FOUND", 404);
    }
    const promptPublishMatch = path.match(/^\/api\/prompt-templates\/([^/]+)\/publish$/);
    if (method === "POST" && promptPublishMatch) {
      if (!deps.promptRepository) return fail("PROMPT_REPOSITORY_NOT_CONFIGURED", 503);
      const published = await deps.promptRepository.publishVersion(promptPublishMatch[1]);
      return published ? ok(withPromptTemplateUsage(published)) : fail("PROMPT_TEMPLATE_NOT_FOUND", 404);
    }
    const promptRetireMatch = path.match(/^\/api\/prompt-templates\/([^/]+)\/retire$/);
    if (method === "POST" && promptRetireMatch) {
      if (!deps.promptRepository) return fail("PROMPT_REPOSITORY_NOT_CONFIGURED", 503);
      const retired = await deps.promptRepository.retireVersion(promptRetireMatch[1]);
      return retired ? ok(withPromptTemplateUsage(retired)) : fail("PROMPT_TEMPLATE_NOT_FOUND", 404);
    }
    if (method === "GET" && promptCopyMatch) {
      if (!deps.promptRepository) return fail("PROMPT_REPOSITORY_NOT_CONFIGURED", 503);
      const params = new URLSearchParams(path.split("?")[1] ?? "");
      const stageValue = params.get("stage") ?? undefined;
      if (stageValue && !PROMPT_STAGES.includes(stageValue as PromptStage)) return fail("INVALID_PROMPT_STAGE");
      const template = await deps.promptRepository.getPublishedVersion(promptCopyMatch[1], stageValue as PromptStage | undefined);
      if (!template) return fail("PROMPT_TEMPLATE_NOT_FOUND", 404);
      return ok(withPromptTemplateUsage({ templateId: template.templateId, templateVersionId: template.templateVersionId, versionNo: template.versionNo, code: template.code, name: template.name, kind: template.kind, stage: template.stage, executionTarget: template.executionTarget, inputSchema: template.inputSchema, applicability: template.applicability, body: template.body, userPromptTemplate: template.userPromptTemplate }));
    }
    const promptListMatch = path.match(/^\/api\/prompt-templates(?:\?(.*))?$/);
    if (method === "GET" && promptListMatch) {
      if (!deps.promptRepository) return ok([]);
      const params = new URLSearchParams(promptListMatch[1] ?? "");
      const stageValue = params.get("stage") ?? undefined;
      if (stageValue && !PROMPT_STAGES.includes(stageValue as PromptStage)) return fail("INVALID_PROMPT_STAGE");
      const statusValue = params.get("status") ?? "published";
      if (!["published", "draft", "retired", "all"].includes(statusValue)) return fail("INVALID_PROMPT_STATUS");
      const listed = statusValue === "published"
        ? await deps.promptRepository.listPublished(stageValue as PromptStage | undefined)
        : deps.promptRepository.listTemplates
          ? await deps.promptRepository.listTemplates({ stage: stageValue as PromptStage | undefined, status: statusValue as PromptVersionStatus | "all" })
          : await deps.promptRepository.listPublished(stageValue as PromptStage | undefined);
      return ok(listed.map((item) => withPromptTemplateUsage(item)));
    }
    if (method === "GET" && path === "/api/platforms") {
      return ok(deps.platformRepository ? await deps.platformRepository.listEnabled() : []);
    }
    if (method === "GET" && path === "/api/health") return ok({ ready: true });

    if (method === "POST" && path === "/api/rag/chunks/search") {
      if (!deps.ragClient) return fail("RAG_NOT_CONFIGURED", 503);
      const body = asRecord(options.body, { allowArrays: true });
      const query = "query" in body ? String(body.query) : "";
      const observation = startTool("rag.query", { query }, { query_length: query.length });
      try {
        const result = await deps.ragClient.search(query);
        finishObservation(observation, { result_count: Array.isArray(result) ? result.length : undefined });
        return ok(result);
      } catch (error) {
        failObservation(observation, error);
        throw error;
      }
    }

    const planAttemptMatch = path.match(/^\/api\/plan-attempts\/([^/]+)$/);
    if (method === "GET" && planAttemptMatch) {
      if (!deps.planRepository) return fail("PLAN_REPOSITORY_NOT_CONFIGURED", 503);
      const attempt = await deps.planRepository.getAttempt(planAttemptMatch[1]);
      if (!attempt) return fail("INVALID_PLAN_ATTEMPT", 404);
      const snapshot = attempt.snapshotId ? await deps.planRepository.getSnapshot(attempt.snapshotId) : null;
      return ok(planAttemptView(attempt, snapshot));
    }

    const structureMatch = path.match(/^\/api\/suites\/([^/]+)\/structure-plan$/);
    if (method === "GET" && structureMatch) {
      if (!deps.planRepository) return fail("PLAN_REPOSITORY_NOT_CONFIGURED", 503);
      const snapshot = await deps.planRepository.getLatestSnapshot(structureMatch[1]);
      const attempt = await deps.planRepository.getLatestAttempt(structureMatch[1]);
      return ok({ attempt: attempt ? planAttemptView(attempt, attempt.snapshotId === snapshot?.id ? snapshot : null) : null, snapshot: snapshot && snapshot.phase === "structure_plan" ? planSnapshotView(snapshot) : null });
    }
    if (method === "POST" && structureMatch) {
      if (!idempotencyKey) return fail("MISSING_IDEMPOTENCY_KEY");
      if (!deps.planRepository) return fail("PLAN_REPOSITORY_NOT_CONFIGURED", 503);
      if (!deps.promptRepository) return fail("PROMPT_REPOSITORY_NOT_CONFIGURED", 503);
      const llmClient = await resolveVision();
      if (!llmClient) return fail("LLM_NOT_CONFIGURED", 503);
      const suite = await deps.repository.getSuite(structureMatch[1]);
      if (!suite) return fail("INVALID_SUITE_ID", 404);
      const body = asRecord(options.body);
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
    }
    const structureConfirmMatch = path.match(/^\/api\/suites\/([^/]+)\/structure-plan\/confirm$/);
    if (method === "POST" && structureConfirmMatch) {
      if (!deps.planRepository) return fail("PLAN_REPOSITORY_NOT_CONFIGURED", 503);
      const latest = await deps.planRepository.getLatestSnapshot(structureConfirmMatch[1]);
      if (!latest || latest.phase !== "structure_plan" || latest.schemaVersion !== "suite-structure-plan-v2" || !isStructurePlanV2(latest.structure)) return fail("INVALID_PLAN_SNAPSHOT", 409);
      // Confirmation is terminal for a snapshot. Repeated clicks must reuse the
      // already-confirmed immutable snapshot instead of inserting its plan items again.
      if (latest.confirmationStatus === "confirmed") return ok(planSnapshotView(latest));
      const body = asRecord(options.body, { allowArrays: true });
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
    }

    const categoryRequestMatch = path.match(/^\/api\/category-prompt-requests\/([^/]+)$/);
    if (method === "GET" && categoryRequestMatch) {
      const request = await categoryPromptRepository.getRequest(categoryRequestMatch[1]);
      return request ? ok(categoryRequestView(request)) : fail("INVALID_CATEGORY_PROMPT_REQUEST", 404);
    }

    const categoryPromptsMatch = path.match(/^\/api\/suites\/([^/]+)(?:\/plan)?\/category-prompts$/);
    if (method === "GET" && categoryPromptsMatch) {
      const suiteId = categoryPromptsMatch[1];
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
    }
    if (method === "POST" && categoryPromptsMatch) {
      if (!idempotencyKey) return fail("MISSING_IDEMPOTENCY_KEY");
      if (!deps.planRepository) return fail("PLAN_REPOSITORY_NOT_CONFIGURED", 503);
      if (!deps.promptRepository) return fail("PROMPT_REPOSITORY_NOT_CONFIGURED", 503);
      const llmClient = await resolveVision();
      if (!llmClient) return fail("CATEGORY_PROMPT_LLM_NOT_CONFIGURED", 503);
      const suite = await deps.repository.getSuite(categoryPromptsMatch[1]);
      if (!suite) return fail("INVALID_SUITE_ID", 404);
      const body = asRecord(options.body);
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
    }

    const categoryRetryMatch = path.match(/^\/api\/suites\/([^/]+)(?:\/plan)?\/category-prompts\/([^/]+)\/retry$/);
    if (method === "POST" && categoryRetryMatch) {
      if (!idempotencyKey) return fail("MISSING_IDEMPOTENCY_KEY");
      const llmClient = await resolveVision();
      if (!deps.planRepository || !deps.promptRepository || !llmClient) return fail("CATEGORY_PROMPT_LLM_NOT_CONFIGURED", 503);
      const suite = await deps.repository.getSuite(categoryRetryMatch[1]);
      if (!suite) return fail("INVALID_SUITE_ID", 404);
      const snapshot = await deps.planRepository.getLatestSnapshot(suite.id);
      if (!snapshot || snapshot.confirmationStatus !== "confirmed" || snapshot.phase !== "structure_plan" || !snapshot.structure) return fail("CATEGORY_PROMPT_NOT_CONFIRMED", 409);
      const categoryRequests = await categoryPromptRepository.listRequests(snapshot.id);
      const previous = categoryRequests.find((request) => request.id === categoryRetryMatch[2]) ?? categoryRequests.filter((request) => request.categoryCode === categoryRetryMatch[2]).at(-1);
      if (!previous || previous.status !== "failed") return fail("INVALID_CATEGORY_PROMPT_REQUEST", 404);
      const body = asRecord(options.body);
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
    }

    const planMatch = path.match(/^\/api\/suites\/([^/]+)\/plan$/);
    if (method === "GET" && planMatch) {
      if (!deps.planRepository) return fail("PLAN_REPOSITORY_NOT_CONFIGURED", 503);
      const [attempt, snapshot] = await Promise.all([deps.planRepository.getLatestAttempt(planMatch[1]), deps.planRepository.getLatestSnapshot(planMatch[1])]);
      return ok({ attempt: attempt ? planAttemptView(attempt, attempt.snapshotId === snapshot?.id ? snapshot : null) : null, snapshot: snapshot ? planSnapshotView(snapshot) : null });
    }
    if (method === "POST" && planMatch) return fail("LEGACY_ENDPOINT_GONE", 410);
    if (method === "PATCH" && planMatch) {
      if (!deps.planRepository) return fail("PLAN_REPOSITORY_NOT_CONFIGURED", 503);
      const latest = await deps.planRepository.getLatestSnapshot(planMatch[1]);
      if (!latest) return fail("INVALID_PLAN_SNAPSHOT", 404);
      const body = asRecord(options.body, { allowArrays: true });
      if (!Array.isArray(body.items) || !validPlanOutput({ schemaVersion: "suite-plan-v1", items: body.items }, { items: { properties: { imageType: {} } } })) return fail("LLM_OUTPUT_SCHEMA_INVALID");
      const items = body.items as Array<{ imageType?: "main" | "detail"; title: string; purpose: string; prompt: string }>;
      const snapshot: PlanSnapshot = { ...latest, id: randomUUID(), revisionNumber: latest.revisionNumber + 1, revisionKind: "human", parentSnapshotId: latest.id, items: items.map((item, index) => ({ id: randomUUID(), ordinal: index + 1, imageType: item.imageType ?? "main", title: item.title, purpose: item.purpose, prompt: item.prompt })), createdAt: new Date().toISOString() };
      return ok(planSnapshotView(await deps.planRepository.appendRevision(snapshot)));
    }
    const startCheckMatch = path.match(/^\/api\/suites\/([^/]+)\/start-creation-check$/);
    if (method === "POST" && startCheckMatch) {
      if (!deps.planRepository) return fail("PLAN_REPOSITORY_NOT_CONFIGURED", 503);
      const [images, snapshot] = await Promise.all([deps.repository.getInputImages(startCheckMatch[1]), deps.planRepository.getLatestSnapshot(startCheckMatch[1])]);
      if (!images.length) return fail("INVALID_INPUT_IMAGE");
      if (!snapshot) return fail("INVALID_PLAN_SNAPSHOT");
      if (snapshot.phase === "structure_plan" && snapshot.confirmationStatus === "confirmed") {
        const items = materializeCategoryPlanItems(snapshot, await listCategoryRequestsForSnapshot(snapshot));
        if (!items) return fail("CATEGORY_PROMPTS_NOT_READY", 409);
        return ok({ ready: true, planSnapshotId: snapshot.id, itemCount: items.length });
      }
      if (!snapshot.items.length) return fail("INVALID_PLAN_SNAPSHOT");
      return ok({ ready: true, planSnapshotId: snapshot.id, itemCount: snapshot.items.length });
    }

    const resolvePlanStyleGuide = (snapshot: PlanSnapshot | null): string => {
      if (!snapshot) return "未设置";
      const card = snapshot?.structure?.globalStyleCard;
      if (card && typeof card === "object" && typeof (card as Record<string, unknown>).promptPrefix === "string" && String((card as Record<string, unknown>).promptPrefix).trim()) {
        return String((card as Record<string, unknown>).promptPrefix).trim();
      }
      const values = { ...(snapshot?.dynamicInput ?? {}), ...(snapshot?.humanInput ?? {}) } as Record<string, unknown>;
      for (const key of ["design_style", "style_guide", "styleGuide", "visual_style"]) {
        if (typeof values[key] === "string" && values[key].trim()) return values[key].trim();
      }
      return "沿用计划模板默认风格，保持商品真实外观、光影和品牌一致性。";
    };

    const styleOverrideMatch = path.match(/^\/api\/suites\/([^/]+)\/style-override$/);
    if (method === "PATCH" && styleOverrideMatch) {
      if (!idempotencyKey) return fail("MISSING_IDEMPOTENCY_KEY");
      const scopeKey = `${styleOverrideMatch[1]}:${idempotencyKey}`;
      const cached = styleOverrideIdempotency.get(scopeKey);
      if (cached) return ok(cached);
      const suite = await deps.repository.getSuite(styleOverrideMatch[1]);
      if (!suite) return fail("INVALID_SUITE_ID", 404);
      const body = asRecord(options.body, { allowArrays: true });
      const rawValue = body.styleOverride;
      if (rawValue !== null && rawValue !== undefined && typeof rawValue !== "string") return fail("INVALID_STYLE_OVERRIDE");
      const nextValue = typeof rawValue === "string" && rawValue.trim() ? rawValue.trim() : null;
      const updated = await deps.repository.updateSuiteStyleOverride(suite.id, nextValue);
      if (!updated) return fail("INVALID_SUITE_ID", 404);
      const snapshot = deps.planRepository ? await deps.planRepository.getLatestSnapshot(suite.id) : null;
      const planStyleGuide = resolvePlanStyleGuide(snapshot);
      const payload = {
        suite: updated,
        planStyleGuide,
        styleOverride: updated.styleOverride ?? null,
        effectiveStyleGuide: updated.styleOverride?.trim() || planStyleGuide,
      };
      styleOverrideIdempotency.set(scopeKey, payload);
      return ok(payload);
    }

    const deliveryExportMatch = path.match(/^\/api\/suites\/([^/]+)\/delivery\/export(?:\?(.*))?$/);
    if (method === "GET" && deliveryExportMatch) {
      if (!deps.taskRepository) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);
      const suite = await deps.repository.getSuite(deliveryExportMatch[1]);
      if (!suite) return fail("INVALID_SUITE_ID", 404);

      const query = new URLSearchParams(deliveryExportMatch[2] ?? "");
      const presetRaw = (query.get("preset") ?? "original").trim() as DeliveryExportPresetId;
      if (!Object.prototype.hasOwnProperty.call(DELIVERY_EXPORT_PRESETS, presetRaw)) return fail("INVALID_EXPORT_OPTIONS", 400);
      const preset = DELIVERY_EXPORT_PRESETS[presetRaw];
      const formatRaw = (query.get("format") ?? preset.defaultFormat).trim() as DeliveryExportFormat;
      if (!["original", "png", "jpeg", "webp"].includes(formatRaw)) return fail("INVALID_EXPORT_OPTIONS", 400);
      const qualityRaw = query.get("quality") ? Number(query.get("quality")) : preset.defaultQuality;
      if (!Number.isFinite(qualityRaw) || qualityRaw < 60 || qualityRaw > 100) return fail("INVALID_EXPORT_OPTIONS", 400);
      const quality = Math.round(qualityRaw);
      const stitchDetail = query.get("stitchDetail") === "true" || query.get("stitchDetail") === "1";
      const selectedTaskIds = new Set((query.get("taskIds") ?? "").split(",").map((id) => id.trim()).filter(Boolean));

      const [snapshot, tasks] = await Promise.all([
        deps.planRepository?.getLatestSnapshot(suite.id) ?? Promise.resolve(null),
        deps.taskRepository.listTasks(suite.id),
      ]);
      const taskAggregates = await Promise.all(tasks.map(async (task) => {
        const history = await deps.taskRepository!.listTaskVersions(task.id);
        return { ...taskView(task), versions: history.versions.map(taskVersionView), attempts: history.attempts.map(taskAttemptView), slots: [] };
      }));
      const imageEditChildren = await loadSuiteImageEditChildren(tasks);
      const slots = resolveDeliverySlots(taskAggregates, imageEditChildren, {
        defaultTemplateVersionId: snapshot?.templateVersionId ?? null,
        preferLatestByTime: suite.origin === "replica",
      });
      const deliverable = slots.filter((slot) => slot.sourceRole !== "pending" && slot.exportPath && (!selectedTaskIds.size || selectedTaskIds.has(slot.parentTaskId)));
      if (!deliverable.length) return fail("DELIVERY_EMPTY", 400);

      const extForFormat = (fmt: DeliveryExportFormat, fallbackPath: string) => {
        if (fmt === "jpeg") return "jpg";
        if (fmt === "webp") return "webp";
        if (fmt === "png") return "png";
        return fallbackPath.split(".").pop() || "png";
      };
      const mimeForFormat = (fmt: DeliveryExportFormat, fallbackMime: string) => {
        if (fmt === "jpeg") return "image/jpeg";
        if (fmt === "webp") return "image/webp";
        if (fmt === "png") return "image/png";
        return fallbackMime;
      };
      const replaceExt = (filePath: string, ext: string) => filePath.replace(/\.[^./]+$/, `.${ext}`);

      const needsTransform = preset.id !== "original" || formatRaw !== "original";
      const entries: Array<{ name: string; data: Buffer }> = [];
      const manifestItems: Array<Record<string, unknown>> = [];
      const detailForStitch: Buffer[] = [];

      for (const slot of deliverable) {
        let bytes: Buffer | null = null;
        if (slot.objectKey) {
          const stored = await deps.storage.get(slot.objectKey);
          if (stored) bytes = stored.bytes;
        }
        if (!bytes) return fail("OBJECT_NOT_FOUND", 404);

        let outBytes = bytes;
        let outWidth = slot.width;
        let outHeight = slot.height;
        let outMime = slot.mimeType;
        let outPath = slot.exportPath!;

        if (needsTransform) {
          let pipeline = sharp(bytes);
          if (slot.imageType === "main" && preset.mainBox) {
            pipeline = pipeline.resize({
              width: preset.mainBox.width,
              height: preset.mainBox.height,
              fit: preset.mainBox.fit,
              background: { r: 255, g: 255, b: 255, alpha: 1 },
            });
          } else if (slot.imageType === "detail" && preset.detailWidth) {
            pipeline = pipeline.resize({ width: preset.detailWidth, withoutEnlargement: false });
          }
          if (formatRaw === "jpeg") {
            pipeline = pipeline.flatten({ background: { r: 255, g: 255, b: 255 } }).jpeg({ quality, mozjpeg: true });
          } else if (formatRaw === "webp") {
            pipeline = pipeline.webp({ quality });
          } else if (formatRaw === "png") {
            pipeline = pipeline.png({ compressionLevel: 8 });
          }
          const rendered = await pipeline.toBuffer({ resolveWithObject: true });
          outBytes = rendered.data;
          outWidth = rendered.info.width;
          outHeight = rendered.info.height;
          outMime = mimeForFormat(formatRaw, slot.mimeType);
          outPath = replaceExt(slot.exportPath!, extForFormat(formatRaw, slot.exportPath!));
        }

        if (stitchDetail && slot.imageType === "detail") {
          detailForStitch.push(outBytes);
        }

        entries.push({ name: outPath, data: outBytes });
        manifestItems.push({
          exportPath: outPath,
          imageType: slot.imageType,
          ordinal: slot.typeOrdinal,
          title: slot.title,
          purpose: slot.purpose,
          sourceRole: slot.sourceRole,
          isEditedDerived: slot.isEditedDerived,
          parentTaskId: slot.parentTaskId,
          editChildTaskId: slot.editChildTaskId,
          sourceVersionId: slot.sourceVersionId,
          versionId: slot.versionId,
          versionNumber: slot.versionNumber,
          width: outWidth,
          height: outHeight,
          byteLength: outBytes.length,
          mimeType: outMime,
          model: slot.model,
          channelName: slot.channelName,
          templateVersionId: slot.templateVersionId,
          promptText: slot.promptText,
          promptSnapshot: slot.promptSnapshot,
        });
      }

      let stitchedDetailPath: string | null = null;
      if (stitchDetail && detailForStitch.length > 0) {
        const targetWidth = preset.detailWidth ?? 1200;
        const resizedSlices = await Promise.all(
          detailForStitch.map((sliceBytes) =>
            sharp(sliceBytes)
              .resize({ width: targetWidth, withoutEnlargement: false })
              .png()
              .toBuffer({ resolveWithObject: true }),
          ),
        );
        const totalHeight = resizedSlices.reduce((sum, slice) => sum + slice.info.height, 0);
        let top = 0;
        const composites = resizedSlices.map((slice) => {
          const entry = { input: slice.data, top, left: 0 };
          top += slice.info.height;
          return entry;
        });
        let stitched = sharp({
          create: {
            width: targetWidth,
            height: Math.max(1, totalHeight),
            channels: 4,
            background: { r: 255, g: 255, b: 255, alpha: 1 },
          },
        }).composite(composites);
        const stitchFmt: DeliveryExportFormat = formatRaw === "original" ? "png" : formatRaw;
        if (stitchFmt === "jpeg") stitched = stitched.flatten({ background: { r: 255, g: 255, b: 255 } }).jpeg({ quality, mozjpeg: true });
        else if (stitchFmt === "webp") stitched = stitched.webp({ quality });
        else stitched = stitched.png({ compressionLevel: 8 });
        const stitchedBytes = await stitched.toBuffer();
        const ext = extForFormat(stitchFmt, "detail.png");
        stitchedDetailPath = `detail/00_detail_long_stitched.${ext}`;
        entries.push({ name: stitchedDetailPath, data: stitchedBytes });
      }

      const latestPipeline = await pipelineRepository.getLatestRun(suite.id);
      const listingSummary =
        (latestPipeline && (await listingRepository.summary(latestPipeline.id))) ??
        (await listingRepository.findLatestBySuiteId(suite.id));
      const listingJob = listingSummary ? await listingRepository.get(listingSummary.id) : null;
      const latestListingVersion =
        listingJob && listingJob.versions.length > 0
          ? listingJob.versions[listingJob.versions.length - 1]
          : null;
      const exportedAt = new Date().toISOString();
      let listingCopyPath: string | null = null;
      let listingCopyManifest: Record<string, unknown> | null = null;

      if (listingJob && latestListingVersion) {
        const platformProfile = deps.platformRepository
          ? await deps.platformRepository.find(listingJob.platform)
          : null;
        const markdown = formatListingCopyMarkdown({
          suiteName: suite.name,
          platformName: platformProfile?.name,
          marketScope: platformProfile?.marketScope,
          job: listingJob,
          version: latestListingVersion,
          rules: platformProfile?.listingCopyRules,
          exportedAt,
        });
        listingCopyPath = "listing-copy.md";
        entries.push({ name: listingCopyPath, data: Buffer.from(markdown, "utf8") });
        listingCopyManifest = {
          jobId: listingJob.id,
          status: listingJob.status,
          platform: listingJob.platform,
          targetMarket: listingJob.targetMarket,
          outputLanguage: listingJob.outputLanguage,
          versionId: latestListingVersion.id,
          versionNumber: latestListingVersion.versionNumber,
          createdAt: latestListingVersion.createdAt,
          content: latestListingVersion.content,
        };
      }

      const planStyleGuide = resolvePlanStyleGuide(snapshot);
      const manifest = {
        schemaVersion: "picagent-delivery-manifest-v1",
        exportedAt,
        exportOptions: {
          preset: preset.id,
          presetLabel: preset.label,
          format: formatRaw,
          quality,
          stitchDetail,
          stitchedDetailPath,
        },
        suite: {
          id: suite.id,
          name: suite.name,
          status: suite.status,
          planSnapshotId: snapshot?.id ?? null,
          planStyleGuide,
          styleOverride: suite.styleOverride ?? null,
          effectiveStyleGuide: suite.styleOverride?.trim() || planStyleGuide,
        },
        summary: {
          totalSlots: slots.length,
          exportedCount: manifestItems.length,
          mainCount: manifestItems.filter((item) => item.imageType === "main").length,
          detailCount: manifestItems.filter((item) => item.imageType === "detail").length,
          stitchedDetailIncluded: Boolean(stitchedDetailPath),
          listingCopyIncluded: Boolean(listingCopyPath),
          listingCopyPath,
        },
        listingCopy: listingCopyManifest,
        items: manifestItems,
      };
      entries.push({ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2), "utf8") });
      const zipBuffer = createZipBuffer(entries);
      const safeSuiteName = sanitizeDeliveryName(suite.name, `suite_${suite.id.slice(0, 8)}`);
      const asciiFallback = safeSuiteName.replace(/[^\x20-\x7e]/g, "") || `suite_${suite.id.slice(0, 8)}`;
      const suffix = preset.id === "original" ? "delivery" : `delivery_${preset.id}`;
      const encodedName = encodeURIComponent(`${safeSuiteName}_${suffix}.zip`);
      return {
        status: 200,
        body: { data: { exportedCount: manifestItems.length, preset: preset.id, stitchedDetailPath }, requestId: randomUUID() },
        headers: {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="${asciiFallback}_${suffix}.zip"; filename*=UTF-8''${encodedName}`,
          "cache-control": "no-store",
        },
        raw: zipBuffer,
      };
    }

    const workbenchMatch = path.match(/^\/api\/suites\/([^/]+)\/workbench$/);
    if (method === "GET" && workbenchMatch) {
      if (!deps.taskRepository) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);
      const suite = await deps.repository.getSuite(workbenchMatch[1]);
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
    }

    const customTaskMatch = path.match(/^\/api\/suites\/([^/]+)\/tasks\/custom$/);
    if (method === "POST" && customTaskMatch) {
      if (!deps.taskRepository?.createCustomTask) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);
      const suite = await deps.repository.getSuite(customTaskMatch[1]);
      if (!suite) return fail("INVALID_SUITE_ID", 404);
      const body = asRecord(options.body, { allowArrays: true });
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
    }

    const batchParamsMatch = path.match(/^\/api\/suites\/([^/]+)\/tasks\/batch-params$/);
    if (method === "POST" && batchParamsMatch) {
      if (!deps.taskRepository) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);
      const suite = await deps.repository.getSuite(batchParamsMatch[1]);
      if (!suite) return fail("INVALID_SUITE_ID", 404);
      const body = asRecord(options.body, { allowArrays: true });
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
    }

    const createTasksMatch = path.match(/^\/api\/suites\/([^/]+)\/tasks$/);
    if (method === "POST" && createTasksMatch) {
      if (!deps.taskRepository || !deps.planRepository) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);
      const suite = await deps.repository.getSuite(createTasksMatch[1]);
      if (!suite) return fail("INVALID_SUITE_ID", 404);
      const body = asRecord(options.body, { allowArrays: true });
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
    }

    const updateTaskMatch = path.match(/^\/api\/suite-tasks\/([^/]+)$/);
    if (method === "PATCH" && updateTaskMatch) {
      if (!deps.taskRepository) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);
      const body = asRecord(options.body, { allowArrays: true });
      const patch: Parameters<TaskRepository["updateTask"]>[1] = {};
      for (const key of ["title", "purpose", "promptDraft"] as const) if (typeof body[key] === "string") patch[key] = body[key];
      if (typeof body.status === "string") patch.status = body.status as SuiteTask["status"];
      if (body.generationParams && typeof body.generationParams === "object" && !Array.isArray(body.generationParams)) patch.generationParams = body.generationParams as Record<string, unknown>;
      if (typeof body.sourceInputImageId === "string") {
        const current = await deps.taskRepository.getTask(updateTaskMatch[1]);
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
      const task = await deps.taskRepository.updateTask(updateTaskMatch[1], patch);
      return task ? ok(task) : fail("INVALID_SUITE_TASK", 404);
    }

    const whiteResourceMatch = path.match(/^\/api\/suite-tasks\/([^/]+)\/white-resource$/);
    if (method === "POST" && whiteResourceMatch) {
      if (!idempotencyKey) return fail("MISSING_IDEMPOTENCY_KEY");
      if (!deps.taskRepository || !deps.libraryRepository) return fail("LIBRARY_REPOSITORY_NOT_CONFIGURED", 503);
      const task = await deps.taskRepository.getTask(whiteResourceMatch[1]); if (!task) return fail("INVALID_SUITE_TASK", 404);
      if (task.status === "generating" || task.status === "archived") return fail("TASK_INVALID_SOURCE", 409);
      const body = asRecord(options.body, { allowArrays: true });
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
    }

    const layoutMatch = path.match(/^\/api\/suites\/([^/]+)\/workbench\/layout$/);
    if (method === "GET" && layoutMatch) {
      if (!deps.taskRepository) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);
      return ok(await deps.taskRepository.getLayout(layoutMatch[1]));
    }
    if (method === "PATCH" && layoutMatch) {
      if (!deps.taskRepository) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);
      const body = asRecord(options.body, { allowArrays: true });
      const expectedVersion = Number(body.layoutVersion ?? 0);
      const viewport = body.viewport && typeof body.viewport === "object" ? body.viewport as { x: number; y: number; zoom: number } : { x: 0, y: 0, zoom: 1 };
      const nodes = Array.isArray(body.nodes) ? body.nodes : [];
      const groups = Array.isArray(body.groups) ? body.groups : [];
      try { return ok(await deps.taskRepository.saveLayout(layoutMatch[1], expectedVersion, { viewport, nodes: nodes as never, groups: groups as never })); }
      catch (error) { return fail(error instanceof Error && error.message === "LAYOUT_VERSION_CONFLICT" ? "LAYOUT_VERSION_CONFLICT" : "GENERATION_PERSIST_FAILED", error instanceof Error && error.message === "LAYOUT_VERSION_CONFLICT" ? 409 : 500); }
    }

    const suiteGenerationMatch = path.match(/^\/api\/suites\/([^/]+)\/generation$/);
    if (method === "POST" && suiteGenerationMatch) {
      if (!idempotencyKey) return fail("MISSING_IDEMPOTENCY_KEY");
      if (!deps.taskRepository) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);
      const allTasks = await deps.taskRepository.listTasks(suiteGenerationMatch[1]);
      const body = asRecord(options.body, { allowArrays: true });
      const requested = Array.isArray(body.taskIds) ? body.taskIds.filter((id): id is string => typeof id === "string") : allTasks.filter((task) => task.status !== "archived").map((task) => task.id);
      const tasks = allTasks.filter((task) => requested.includes(task.id) && task.status !== "archived");
      if (!tasks.length) return fail("NO_TASKS_TO_GENERATE", 409);
      try { const result = await createTaskBatch(suiteGenerationMatch[1], tasks, "batch", idempotencyKey); return ok({ batchId: result.batch.id, status: result.batch.status, requestedCount: result.batch.requestedCount }, result.duplicate ? 200 : 202); }
      catch (error) { return fail(error instanceof Error ? error.message : "TASK_INVALID_SOURCE", 409); }
    }

    const taskGenerationMatch = path.match(/^\/api\/suite-tasks\/([^/]+)\/generation$/);
    if (method === "POST" && taskGenerationMatch) {
      if (!idempotencyKey) return fail("MISSING_IDEMPOTENCY_KEY");
      if (!deps.taskRepository) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);
      const task = await deps.taskRepository.getTask(taskGenerationMatch[1]);
      if (!task || task.status === "archived") return fail("INVALID_SUITE_TASK", 404);
      const body = asRecord(options.body, { allowArrays: true });
      if (typeof body.editSourceVersionId === "string") {
        try {
          const { versions } = await deps.taskRepository.listTaskVersions(task.id);
          const version = versions.find((item) => item.id === body.editSourceVersionId);
          if (!version) return fail("TASK_CURRENT_VERSION_NOT_FOUND", 409);
          const result = await createTaskBatch(task.suiteId, [task], "single", idempotencyKey, undefined, {}, { version, versions });
          return ok({ batchId: result.batch.id, status: result.batch.status }, result.duplicate ? 200 : 202);
        } catch (error) { return fail(error instanceof Error ? error.message : "TASK_INVALID_SOURCE", 409); }
      }
      if (typeof body.promptDraft === "string") await deps.taskRepository.updateTask(task.id, { promptDraft: body.promptDraft });
      const current = await deps.taskRepository.getTask(task.id);
      try {
        const history = await deps.taskRepository.listTaskVersions(task.id);
        const currentVersion = history.versions.find((version) => version.isCurrent);
        const currentAttempt = history.attempts.find((attempt) => attempt.id === currentVersion?.attemptId);
        const sourceUnchanged = (currentAttempt?.contextSnapshot.sourceRevision ?? 0) === (current?.sourceRevision ?? 0);
        const useCurrentVersionAsSource = current?.originKind !== "replica" && currentVersion && sourceUnchanged;
        const result = await createTaskBatch(task.suiteId, [current!], "single", idempotencyKey, undefined, useCurrentVersionAsSource ? { [task.id]: currentVersion.id } : {});
        return ok({ batchId: result.batch.id, status: result.batch.status }, result.duplicate ? 200 : 202);
      }
      catch (error) { return fail(error instanceof Error ? error.message : "TASK_INVALID_SOURCE", 409); }
    }

    const retryMatch = path.match(/^\/api\/generation-attempts\/([^/]+)\/retry$/);
    if (method === "POST" && retryMatch) {
      if (!idempotencyKey) return fail("MISSING_IDEMPOTENCY_KEY");
      if (!deps.taskRepository) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);
      const failed = await deps.taskRepository.getAttempt(retryMatch[1]);
      if (!failed || failed.status !== "failed") return fail("INVALID_TASK_ATTEMPT", 409);
      const slot = await deps.taskRepository.getSlot(failed.slotId); if (!slot) return fail("INVALID_TASK_BATCH", 404);
      const task = await deps.taskRepository.getTask(slot.taskId); if (!task) return fail("INVALID_SUITE_TASK", 404);
      try { const result = await createTaskBatch(task.suiteId, [task], "retry", idempotencyKey, failed); return ok({ batchId: result.batch.id, status: result.batch.status }, result.duplicate ? 200 : 202); }
      catch (error) { return fail(error instanceof Error ? error.message : "TASK_INVALID_SOURCE", 409); }
    }

    const batchStatusMatch = path.match(/^\/api\/generation-batches\/([^/]+)$/);
    if (method === "GET" && batchStatusMatch) {
      if (!deps.taskRepository) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);
      const batch = await deps.taskRepository.getBatch(batchStatusMatch[1]);
      if (!batch) return fail("INVALID_TASK_BATCH", 404);
      const slots = (await deps.taskRepository.listSlots(batch.suiteId)).filter((slot) => slot.batchId === batch.id);
      const attempts = await Promise.all(slots.map(async (slot) => deps.taskRepository!.getAttempt((await deps.taskRepository!.listTaskVersions(slot.taskId)).attempts.find((attempt) => attempt.slotId === slot.id)?.id ?? ""))).then((items) => items.filter(Boolean));
      return ok({ batch, slots, attempts });
    }

    const taskVersionsMatch = path.match(/^\/api\/suite-tasks\/([^/]+)\/versions$/);
    if (method === "GET" && taskVersionsMatch) {
      if (!deps.taskRepository) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);
      const task = await deps.taskRepository.getTask(taskVersionsMatch[1]); if (!task) return fail("INVALID_SUITE_TASK", 404);
      return ok(await deps.taskRepository.listTaskVersions(task.id));
    }
    const selectTaskVersionMatch = path.match(/^\/api\/suite-tasks\/([^/]+)\/versions\/([^/]+)\/select$/);
    if (method === "POST" && selectTaskVersionMatch) {
      if (!deps.taskRepository) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);
      const selection = asRecord(options.body, { allowArrays: true }).selection === "final" ? "final" : "current";
      const version = await deps.taskRepository.selectVersion(selectTaskVersionMatch[1], selectTaskVersionMatch[2], selection);
      if (version && selection === "final" && deps.libraryRepository) {
        await deps.libraryRepository.restoreResource(`task-version:${version.id}`);
      }
      return version ? ok(version) : fail("INVALID_TASK_VERSION", 404);
    }
    const taskPreviewMatch = path.match(/^\/api\/suite-tasks\/([^/]+)\/versions\/([^/]+)\/preview$/);
    if (method === "GET" && taskPreviewMatch) return await previewTaskVersion(taskPreviewMatch[1], taskPreviewMatch[2]);

    const removeImageMatch = path.match(/^\/api\/suites\/([^/]+)\/input-images\/([^/]+)$/);
    if (method === "DELETE" && removeImageMatch) {
      const [suiteId, inputImageId] = removeImageMatch.slice(1);
      const image = await deps.repository.getInputImage(suiteId, inputImageId);
      if (!image) return fail("INVALID_INPUT_IMAGE", 404);
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
    }

    const generationMatch = path.match(/^\/api\/suites\/([^/]+)\/input-images\/([^/]+)\/base-generation$/);
    if (method === "POST" && generationMatch) {
      const [suiteId, inputImageId] = generationMatch.slice(1);
      if (!idempotencyKey) return fail("MISSING_IDEMPOTENCY_KEY");
      if (!deps.promptRepository) return fail("PROMPT_REPOSITORY_NOT_CONFIGURED", 503);
      const body = asRecord(options.body);
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
      const reservation = await deps.repository.beginBaseGeneration({
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
    }

    const versionsMatch = path.match(/^\/api\/suites\/([^/]+)\/input-images\/([^/]+)\/base-versions$/);
    if (method === "GET" && versionsMatch) {
      const [suiteId, inputImageId] = versionsMatch.slice(1);
      const image = await deps.repository.getInputImage(suiteId, inputImageId);
      if (!image) return fail("INVALID_INPUT_IMAGE", 404);
      const [versions, attempts] = await Promise.all([
        deps.repository.listBaseImageVersions(suiteId, inputImageId),
        deps.repository.listGenerationAttempts(suiteId, inputImageId),
      ]);
      return ok({ currentVersionId: image.currentBaseVersionId, versions: versions.map(versionView), attempts: attempts.map(attemptView) });
    }

    const selectMatch = path.match(/^\/api\/suites\/([^/]+)\/input-images\/([^/]+)\/base-versions\/([^/]+)\/select$/);
    if (method === "POST" && selectMatch) {
      const selected = await deps.repository.selectBaseImageVersion(selectMatch[1], selectMatch[2], selectMatch[3]);
      return selected ? ok(versionView(selected)) : fail("INVALID_BASE_VERSION", 404);
    }

    const suiteMatch = path.match(/^\/api\/suites\/([^/]+)$/);
    if (method === "GET" && suiteMatch) {
      const suite = await deps.repository.getSuite(suiteMatch[1]);
      if (!suite) return fail("INVALID_SUITE_ID", 404);
      const inputImages = await deps.repository.getInputImages(suite.id);
      return ok({ ...suite, inputImages } satisfies SuiteAggregate);
    }
    if (method === "PATCH" && suiteMatch) {
      const body = asRecord(options.body, { allowArrays: true });
      const name = "name" in body ? String(body.name).trim() : "";
      if (!name) return fail("EMPTY_NAME");
      if (!deps.repository.renameSuite) return fail("NOT_FOUND", 404);
      const updated = await deps.repository.renameSuite(suiteMatch[1], name);
      return updated ? ok(updated) : fail("INVALID_SUITE_ID", 404);
    }
    if (method === "DELETE" && suiteMatch) {
      if (!deps.repository.deleteSuite) return fail("NOT_FOUND", 404);
      const deleted = await deps.repository.deleteSuite(suiteMatch[1]);
      return deleted ? ok(deleted) : fail("INVALID_SUITE_ID", 404);
    }
    return fail("NOT_FOUND", 404);
  }

  const upload = async (suiteId: string, file: UploadFile): Promise<AppResponse> => {
    const suite = await deps.repository.getSuite(suiteId);
    if (!suite) return fail("INVALID_SUITE_ID", 404);
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
    return previewObject(kind === "original" ? image.originalObjectKey : image.thumbnailObjectKey, deps.storage);
  };

  const previewBaseVersion = async (suiteId: string, imageId: string, versionId: string) => {
    const version = await deps.repository.getBaseImageVersion(suiteId, imageId, versionId);
    if (!version) return fail("INVALID_BASE_VERSION", 404);
    return previewObject(version.objectKey, deps.storage);
  };

  const previewTaskVersion = async (taskId: string, versionId: string) => {
    if (!deps.taskRepository) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);
    const history = await deps.taskRepository.listTaskVersions(taskId);
    const version = history.versions.find((item) => item.id === versionId);
    return version ? previewObject(version.objectKey, deps.storage) : fail("INVALID_TASK_VERSION", 404);
  };

  const previewLibraryResource = async (resourceId: string) => {
    if (!deps.libraryRepository) return fail("LIBRARY_REPOSITORY_NOT_CONFIGURED", 503);
    const decoded = safeDecodePathParam(resourceId);
    if (!decoded) return fail("LIBRARY_RESOURCE_NOT_FOUND", 404);
    const resource = await deps.libraryRepository.getResource(decoded, { includeDeleted: true });
    if (!resource) return fail("LIBRARY_RESOURCE_NOT_FOUND", 404);
    const target = await deps.libraryRepository.getPreviewObject(resource.id);
    return target ? previewObject(target.objectKey, deps.storage) : fail("OBJECT_NOT_FOUND", 404);
  };

  const previewReverseReference = async (planId: string, referenceId: string, kind: "original" | "thumbnail" = "thumbnail"): Promise<AppResponse> => { const plan = await reverseRepository.getPlan(planId); const ref = plan?.references.find((item) => item.id === referenceId); if (!ref) return fail("REVERSE_REFERENCE_NOT_FOUND", 404); const object = await deps.storage.get(kind === "original" ? ref.objectKey : ref.thumbnailObjectKey); return object ? { status: 200, body: { data: { contentType: object.contentType }, requestId: randomUUID() }, headers: { "content-type": object.contentType }, raw: object.bytes } : fail("OBJECT_NOT_FOUND", 404); };
  const previewReplicaReference = (suiteId: string, referenceId: string, kind: "original" | "thumbnail" = "thumbnail") =>
    replicaPipeline.previewReference(suiteId, referenceId, kind);
  return { request, upload, preview, previewBaseVersion, previewTaskVersion, previewLibraryResource, previewReverseReference, previewReplicaReference };
}

async function previewObject(key: string, storage: StorageAdapter): Promise<AppResponse> {
  try {
    const object = await storage.get(key);
    if (!object) return fail("OBJECT_NOT_FOUND", 404);
    return { status: 200, body: { data: { contentType: object.contentType }, requestId: randomUUID() }, headers: { "content-type": object.contentType, "cache-control": "private, max-age=60" }, raw: object.bytes };
  } catch (error) {
    return fail(error instanceof Error && error.message === "OBJECT_NOT_FOUND" ? "OBJECT_NOT_FOUND" : "OBJECT_READ_FAILED", error instanceof Error && error.message === "OBJECT_NOT_FOUND" ? 404 : 502);
  }
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
