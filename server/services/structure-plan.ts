import { planSnapshotView, isStructurePlanV2 } from "../suite-views.js";
import { asRecord } from "../api-response.js";
import { PURE_WHITE_MAIN_IMAGE_REQUIREMENTS } from "../../shared/platform-main-background.js";
import {
  DETAIL_CATEGORY_CODES,
  SUITE_CATEGORY_NAMES as DETAIL_CATEGORY_NAMES,
  SUITE_CATEGORY_GROUPS,
  SUITE_IMAGE_LIMITS,
  type SuiteCategoryGroups,
} from "../../shared/suite-categories.js";
import { allocateSellingPointLayouts, resolveSellingPointLayouts } from "../../shared/selling-point-layouts.js";
import { createHash } from "node:crypto";
import type { PromptTemplateRuntime } from "../prompt-library.js";
import type {
  CategoryPromptItem,
  CategoryPromptLlmInput,
  CategoryPromptRequest,
  CategoryPromptRepository,
  LlmClient,
  PlanAttempt,
  PlanSnapshot,
  PlatformProfile,
  StructureAllocation,
  StructurePlanV2,
} from "../types.js";
import type { StudioDependencies } from "../app-dependencies.js";

export function platformForPlanning(profile: PlatformProfile | null, background: unknown): PlatformProfile | undefined {
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

export function validPlanOutput(value: unknown, outputSchema?: Record<string, unknown>): boolean {
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

export function summarizeOutput(value: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const serialized = JSON.stringify(value) ?? "";
  return { sha256: (awaitableHash(serialized)), byteLength: Buffer.byteLength(serialized), itemCount: value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).items) ? ((value as Record<string, unknown>).items as unknown[]).length : 0, ...extra };
}

export function designerFactsText(input: Record<string, unknown>): string {
  const supplement = typeof input.human_supplement === "string" ? input.human_supplement.trim() : "";
  const emphasis = typeof input.emphasis_requirements === "string" ? input.emphasis_requirements.trim() : "";
  if (!supplement) return emphasis;
  if (!emphasis || supplement === emphasis || supplement.endsWith(`【本次补充说明】\n${emphasis}`)) return supplement;
  return `${supplement}\n${emphasis}`;
}

function awaitableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function planAttemptView(attempt: PlanAttempt, snapshot: PlanSnapshot | null) {
  return { id: attempt.id, suiteId: attempt.suiteId, status: attempt.status, templateVersionId: attempt.templateVersionId, provider: attempt.provider, errorCode: attempt.errorCode, errorMessage: attempt.errorMessage, outputSummary: attempt.outputSummary, snapshot: snapshot ? planSnapshotView(snapshot) : null, createdAt: attempt.createdAt, completedAt: attempt.completedAt };
}

type StructureOutput = StructurePlanV2 & { schemaVersion: "suite-structure-plan-v2" };

export function parseCategoryGroups(value: unknown): SuiteCategoryGroups | null {
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

export function normalizeStructureOutput(value: unknown): StructureOutput | null {
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

export function validateStructureOutput(output: StructureOutput, input: Record<string, unknown>, imageIds: string[], factIds: string[] = []): string | null {
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

export function normalizeCategoryPromptOutput(value: unknown): { schemaVersion: "suite-category-prompt-v1"; category: string; items: CategoryPromptItem[] } | null {
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

export function categoryRequestView(request: CategoryPromptRequest) {
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

export function llmSource(client: LlmClient) {
  return { name: client.provider, model: client.model, isFake: client.isFake, channel: client.channel };
}

export const samePlanItems = (left: PlanSnapshot["items"], right: PlanSnapshot["items"]) => left.length === right.length && left.every((item, index) => {
  const other = right[index];
  return other && item.id === other.id && item.prompt === other.prompt && item.title === other.title && item.purpose === other.purpose;
});

export function createPlanServices(deps: StudioDependencies, categoryPromptRepository: CategoryPromptRepository) {
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

  return {
    resolveCategorySourceSnapshot,
    listCategoryRequestsForSnapshot,
    appendMaterializedSnapshot,
    appendConfirmedSnapshot,
    categoryPlanInput,
    categoryAllocationsForSnapshot,
    loadCategoryVisionImages,
  };
}
