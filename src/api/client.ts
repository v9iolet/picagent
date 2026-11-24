import type { ListingConfig, ListingContent, ListingRules } from "../../shared/listing-config";
import type { ModelChannelInput, ModelChannelSnapshot, ModelPreferences, ModelSettingsView } from "../../shared/model-settings";
import type {
  ProductCard,
  ProductCardFields,
  ProductCardSnapshot,
  ProductCardStatus,
  ProductCardSummary,
  ProductCardSupplierImage,
} from "../../shared/product-card";

export interface ApiImage {
  id: string; suiteId: string; ordinal: number; originalObjectKey: string; thumbnailObjectKey: string;
  sha256: string; width: number; height: number; mimeType: string; originalFilename: string;
  currentBaseVersionId: string | null; createdAt: string; originalPreviewUrl: string; thumbnailPreviewUrl: string;
}
export interface ApiSuite {
  id: string; name: string; status: "draft" | "in_progress"; origin?: "suite_studio" | "canvas" | "replica";
  styleOverride?: string | null; styleOverrideUpdatedAt?: string | null;
  coverPreviewUrl?: string | null; inputImageCount?: number; taskCount?: number; isDemo?: boolean;
  createdAt: string; updatedAt: string; inputImages: ApiImage[];
}
export interface ApiBaseVersion {
  id: string; attemptId: string; versionNumber: number; width: number; height: number; mimeType: "image/png"; sha256: string; createdAt: string; previewUrl: string;
}
export interface ApiGenerationAttempt {
  id: string; versionNumber: number; status: "running" | "succeeded" | "failed"; model: string; channel?: ModelChannelSnapshot | null;
  templateVersionId: string;
  errorCode: string | null; errorMessage: string | null; createdAt: string; completedAt: string | null;
}
export interface ApiBaseHistory { currentVersionId: string | null; versions: ApiBaseVersion[]; attempts: ApiGenerationAttempt[] }
export interface ApiPromptInputField {
  key: string; label: string; type: "text" | "textarea" | "number" | "select"; required: boolean; order: number;
  defaultValue?: string | number; options?: string[];
}
export interface ApiPromptTemplate {
  templateId: string; templateVersionId: string; versionNo: number; code: string; name: string;
  kind: string; stage: "base_refine" | "plan" | "structure_plan" | "category_prompt" | "task_image" | "reverse_prompt" | "listing_copy" | "replica_prompt"; executionTarget: "llm" | "image_model";
  inputSchema: ApiPromptInputField[]; applicability: Record<string, unknown>;
  usedBy?: string[]; status?: "draft" | "published" | "retired";
}
export interface ApiPromptTemplateCopy extends ApiPromptTemplate { body: string; userPromptTemplate: string; outputSchema?: Record<string, unknown>; status?: "draft" | "published" | "retired" }
export interface ApiPlatformProfile {
  code: string; name: string; marketScope: "overseas" | "domestic";
  mainImageBackground: "pure_white_required" | "white_preferred" | "flexible";
  mainImageStrategy: string; galleryStrategy: string; textStrategy: string; modelStrategy: string;
  sourceNote: string; sortOrder: number;
  listingCopyRules?: ListingRules;
}
export interface ApiRagChunk { id: string; version: string; title: string; summary: string; sourceKind: string; sourceAssetPaths: string[]; contentSha256: string; fieldValues?: Record<string, unknown> }
export interface ApiPlanItem { id: string; ordinal: number; imageType: "main" | "detail"; title: string; purpose: string; prompt: string }
export interface ApiStructureAllocation { category: string; requirement: "required" | "optional"; count: number; reason: string; sourceImageIds: string[]; factRefs: string[]; missingFacts: string[] }
export interface ApiMainAllocation { category: "main"; count: number; reason: string; sourceImageIds: string[]; factRefs: string[]; missingFacts: string[] }
export interface ApiStructurePlan {
  schemaVersion?: "suite-structure-plan-v1" | "suite-structure-plan-v2";
  status?: "READY" | "READY_FOR_REVIEW" | "NEEDS_HUMAN_INPUT";
  mainAllocation?: ApiMainAllocation;
  mainImageCount?: number;
  detailImageCount: number;
  categoryAllocations: ApiStructureAllocation[];
  globalStyleCard: Record<string, unknown>;
  canProceed?: boolean;
}
export interface ApiCategoryPromptItem { stableId: string; category: string; title: string; purpose: string; referenceImageIds: string[]; factRefs: string[]; prompt: string; allowsTextOverlay: "platform_default" | "yes" | "no"; textContent: Array<{ text: string; source: string }>; aspectRatio: string; suggestedParams: Record<string, unknown> }
export interface ApiCategoryPromptRequest { id: string; suiteId: string; planSnapshotId: string; categoryCode: string; requestedCount: number; status: "running" | "succeeded" | "failed"; idempotencyKey: string; retryOfRequestId: string | null; templateVersionId: string; provider: { name: string; model: string; isFake: boolean; channel?: ModelChannelSnapshot }; requestSummary: Record<string, unknown>; responseSummary: Record<string, unknown> | null; items: ApiCategoryPromptItem[]; errorCode: string | null; errorMessage: string | null; createdAt: string; completedAt: string | null }
export interface ApiCategoryPromptState { planSnapshotId: string | null; status: "not_ready" | "pending" | "running" | "partial" | "succeeded"; expectedRequestCount?: number; requests: ApiCategoryPromptRequest[] }
export interface ApiPlanSnapshot { id: string; revisionNumber: number; revisionKind: "llm" | "human"; templateVersionId: string; dynamicInput: Record<string, unknown>; humanInput: Record<string, unknown>; chunks: Array<{ sourceChunkId: string; sourceVersion: string; title: string; fieldValues: Record<string, unknown>; sourceKind: string }>; inputImageIds?: string[]; provider: { name: string; model: string; isFake: boolean; channel?: ModelChannelSnapshot }; items: ApiPlanItem[]; phase?: "legacy_plan" | "structure_plan"; confirmationStatus?: "draft" | "confirmed"; confirmationMode?: "auto" | "human"; confirmedAt?: string | null; structure?: ApiStructurePlan | null; categoryOutputs?: Record<string, { status: string; requestedCount: number; items: ApiCategoryPromptItem[]; errorCode?: string | null; errorMessage?: string | null }>; createdAt: string }
export interface ApiPlanAttempt { id: string; status: "running" | "succeeded" | "failed"; provider: { name: string; model: string; isFake: boolean; channel?: ModelChannelSnapshot }; errorCode: string | null; errorMessage: string | null; snapshot: ApiPlanSnapshot | null }
export interface ApiPlanState { attempt: ApiPlanAttempt | null; snapshot: ApiPlanSnapshot | null }
export type ApiTaskStatus = "incomplete" | "pending" | "generating" | "generated" | "refining" | "failed" | "archived";
export interface ApiTaskVersion { id: string; taskId: string; slotId: string; attemptId: string; versionNumber: number; objectKey: string; processObjectKeys: string[]; sha256: string; width: number; height: number; mimeType: string; promptSnapshot: Record<string, unknown>; contextSnapshot: Record<string, unknown>; isCurrent: boolean; isFinal: boolean; createdAt: string; previewUrl: string }
export interface ApiTaskAttempt { id: string; slotId: string; attemptNo: number; provider: string; model: string; endpoint: string; requestSummary: Record<string, unknown>; promptSnapshot: Record<string, unknown>; promptSha256: string; contextSnapshot: Record<string, unknown>; sourceKind: "base" | "original" | "library"; sourceObjectKey: string; sourceInputImageId: string | null; sourceBaseVersionId: string | null; sourceLibraryReferenceId?: string | null; sourceResourceVersionId?: string | null; status: "running" | "succeeded" | "failed"; errorCode: string | null; errorMessage: string | null; externalRequestId: string | null; startedAt: string; finishedAt: string | null }
export interface ApiTaskSlot { id: string; batchId: string; taskId: string; slotOrdinal: number; retryOfSlotId: string | null; status: "pending" | "generating" | "succeeded" | "failed"; selectedVersionId: string | null; createdAt: string; completedAt: string | null }
export interface ApiProductMaterialRef { libraryReferenceId: string; resourceId: string; resourceVersionId: string; order: number; title?: string; previewUrl?: string }
export interface ApiSuiteTask { id: string; suiteId: string; planSnapshotId: string | null; planItemId: string | null; ordinal: number; imageType: "main" | "detail"; title: string; purpose: string; promptDraft: string; promptRevision: number; sourceInputImageId: string | null; generationParams: Record<string, unknown>; status: ApiTaskStatus; archivedAt: string | null; createdAt: string; updatedAt: string; originKind?: "suite_plan" | "reverse_import" | "replica"; reversePlanId?: string | null; reverseReferenceId?: string | null; reversePromptVersionId?: string | null; reverseTaskGroupId?: string | null; replicaReferenceId?: string | null; replicaReferenceObjectKey?: string | null; sourceLibraryReferenceId?: string | null; sourceResourceVersionId?: string | null; sourceRevision?: number; versions: ApiTaskVersion[]; attempts: ApiTaskAttempt[]; slots: ApiTaskSlot[] }
export interface ApiTaskBatch { id: string; suiteId: string; kind: "batch" | "single" | "retry"; requestedCount: number; taskIds: string[]; status: "running" | "completed" | "partial" | "failed"; idempotencyKey: string; createdAt: string; startedAt: string | null; finishedAt: string | null }
export interface ApiCanvasLayout { id: string; suiteId: string; layoutVersion: number; viewport: { x: number; y: number; zoom: number }; nodes: Array<{ nodeId: string; x: number; y: number; width?: number; height?: number; groupKey?: string; hidden?: boolean }>; groups: Array<{ groupKey: string; x: number; y: number; width: number; height: number; collapsed?: boolean }>; updatedAt: string }
export interface ApiWorkbench { suite: ApiSuite; inputImages: ApiImage[]; planSnapshot: ApiPlanSnapshot | null; tasks: ApiSuiteTask[]; batches: ApiTaskBatch[]; imageEditChildren?: Array<{ task: Record<string, unknown>; snapshot: Record<string, unknown> | null; attempts: Array<Record<string, unknown> & { provider?: { name: string; version: string; channel?: ModelChannelSnapshot } }>; versions: Array<{ id: string; previewUrl?: string; versionNumber: number; width?: number; height?: number; mimeType?: string; objectKey?: string; attemptId?: string; createdAt?: string }> }>; layout: ApiCanvasLayout | null; planStyleGuide?: string; styleOverride?: string | null; effectiveStyleGuide?: string }
export type ApiLibraryResourceType = "prompt_template" | "input_image" | "base_image" | "task_image_version" | "process_image" | "reverse_reference_asset";
export interface ApiLibraryResource { id: string; resourceType: ApiLibraryResourceType; title: string; summary: string; mimeType: string | null; previewUrl: string | null; suiteId: string | null; taskId: string | null; imageVersionId: string | null; baseVersionId: string | null; templateVersionId: string | null; resourceVersionId: string; stage: ApiPromptTemplate["stage"] | null; source: Record<string, unknown>; status?: "draft" | "published" | "archived" | "retired"; usedBy?: string[]; promptSnapshot?: Record<string, unknown> | null; createdAt: string; updatedAt: string }
export interface ApiLibraryReference { id: string; suiteId: string; resourceId: string; resourceType: ApiLibraryResourceType; targetType: "plan" | "task"; targetId: string; resourceVersionId: string; snapshot: Record<string, unknown>; createdAt: string; createdBy: string | null; archivedAt: string | null }

type CryptoSource = {
  randomUUID?: () => string;
  getRandomValues?: Crypto["getRandomValues"];
};

let fallbackId = 0;

export function createIdempotencyKey(cryptoApi: CryptoSource | undefined = globalThis.crypto) {
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
  }
  fallbackId += 1;
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${fallbackId.toString(36)}`;
}

export class ApiHttpError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "ApiHttpError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, cache: "no-store" });
  const payload = await response.json().catch(() => null) as { data?: T; error?: { code?: string; message?: string } } | null;
  if (!response.ok) throw new ApiHttpError(payload?.error?.message ?? "请求失败", response.status, payload?.error?.code);
  return payload?.data as T;
}

export type { ListingConfig } from "../../shared/listing-config";
export interface ApiListingSummary extends Omit<ListingConfig, "sellingPoints"> {
  id: string;
  sourceSuiteId: string | null;
  input: { sellingPoints: string };
  status: "draft" | "running" | "succeeded" | "failed";
  errorCode: string | null;
  updatedAt: string;
}
export type ApiListingContent = ListingContent;
export interface ApiListingJob extends ApiListingSummary {
  inputImages: { id: string; originalFilename: string }[];
  versions: { id: string; versionNumber: number; createdAt: string; content: ApiListingContent }[];
}

const listingPath = "/api/listing-copies";
const listingJobPath = (id: string) => `${listingPath}/${encodeURIComponent(id)}`;
const listingWrite = (path: string, method: "POST" | "PUT", body: object) =>
  request<ApiListingJob>(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const listingCopyApi = {
  get: (id: string) => request<ApiListingJob>(listingJobPath(id)),
  generateForSuite: (sourceSuiteId: string) => listingWrite(listingPath, "POST", { sourceSuiteId, generate: true }),
  regenerate: (id: string) => listingWrite(`${listingJobPath(id)}/regenerate`, "POST", {}),
  save: (id: string, content: Partial<ApiListingContent>) => listingWrite(listingJobPath(id), "PUT", { content }),
};

const settingsPath = "/api/model-settings";
export const modelSettingsApi = {
  get: () => request<ModelSettingsView>(settingsPath),
  discoverModels: (input: Pick<ModelChannelInput, "baseUrl" | "apiKey"> & { channelId?: string }, signal: AbortSignal) => request<{ modelIds: string[] }>(`${settingsPath}/models`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input), signal,
  }),
  saveChannel: (input: ModelChannelInput, id?: string) => request<ModelSettingsView>(settingsPath + "/channels" + (id ? `/${encodeURIComponent(id)}` : ""), {
    method: id ? "PUT" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  }),
  removeChannel: (id: string) => request<ModelSettingsView>(`${settingsPath}/channels/${encodeURIComponent(id)}`, { method: "DELETE" }),
  savePreferences: (preferences: Partial<ModelPreferences>) => request<ModelSettingsView>(settingsPath + "/preferences", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(preferences),
  }),
};

export const suiteApi = {
  create(name: string, origin?: Exclude<ApiSuite["origin"], "replica">) { return request<ApiSuite>("/api/suites", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() }, body: JSON.stringify({ name, origin }) }); },
  rename(id: string, name: string) { return request<ApiSuite>(`/api/suites/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() }, body: JSON.stringify({ name }) }); },
  delete(id: string) { return request<{ id: string }>(`/api/suites/${encodeURIComponent(id)}`, { method: "DELETE" }); },
  list() { return request<ApiSuite[]>("/api/suites"); },
  listCanvases() { return request<ApiSuite[]>("/api/suites?view=canvas"); },
  get(id: string) { return request<ApiSuite>(`/api/suites/${encodeURIComponent(id)}`); },
  removeInputImage(suiteId: string, inputImageId: string) {
    return request<{ id: string }>(`/api/suites/${encodeURIComponent(suiteId)}/input-images/${encodeURIComponent(inputImageId)}`, { method: "DELETE" });
  },
  upload(id: string, file: File, ordinal: number, onProgress?: (value: number) => void) {
    return new Promise<ApiImage>((resolve, reject) => {
      const xhr = new XMLHttpRequest(); xhr.open("POST", `/api/suites/${encodeURIComponent(id)}/input-images`); xhr.setRequestHeader("idempotency-key", createIdempotencyKey());
      xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress?.(Math.round(event.loaded / event.total * 100)); };
      xhr.onerror = () => reject(new Error("上传失败，请检查网络连接"));
      xhr.onload = () => { try { const payload = JSON.parse(xhr.responseText) as { data?: ApiImage; error?: { message?: string } }; if (xhr.status >= 200 && xhr.status < 300 && payload.data) resolve(payload.data); else reject(new Error(payload.error?.message ?? "上传失败")); } catch { reject(new Error("上传响应无效")); } };
      const form = new FormData(); form.append("ordinal", String(ordinal)); form.append("file", file, file.name); xhr.send(form);
    });
  },
  getBaseVersions(suiteId: string, inputImageId: string) {
    return request<ApiBaseHistory>(`/api/suites/${encodeURIComponent(suiteId)}/input-images/${encodeURIComponent(inputImageId)}/base-versions`);
  },
  listPromptTemplates(stage?: ApiPromptTemplate["stage"], status?: "published" | "draft" | "retired" | "all") {
    const search = new URLSearchParams();
    if (stage) search.set("stage", stage);
    if (status) search.set("status", status);
    const qs = search.toString();
    return request<ApiPromptTemplate[]>(qs ? `/api/prompt-templates?${qs}` : "/api/prompt-templates");
  },
  getPromptTemplateVersion(versionId: string) {
    return request<ApiPromptTemplateCopy>(`/api/prompt-templates/${encodeURIComponent(versionId)}`);
  },
  copyPromptTemplate(templateVersionId: string, stage?: ApiPromptTemplate["stage"]) { return request<ApiPromptTemplateCopy>(`/api/prompt-templates/${encodeURIComponent(templateVersionId)}/copy${stage ? `?stage=${encodeURIComponent(stage)}` : ""}`); },
  listPromptTemplateVersions(templateId: string) { return request<ApiPromptTemplateCopy[]>(`/api/prompt-templates/${encodeURIComponent(templateId)}/versions`); },
  updatePromptTemplate(versionId: string, body: Partial<Pick<ApiPromptTemplateCopy, "name" | "body" | "userPromptTemplate" | "inputSchema" | "outputSchema" | "applicability">>) { return request<ApiPromptTemplateCopy>(`/api/prompt-templates/${encodeURIComponent(versionId)}`, { method: "PATCH", headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() }, body: JSON.stringify(body) }); },
  copyPromptTemplateVersion(versionId: string) { return request<ApiPromptTemplateCopy>(`/api/prompt-templates/${encodeURIComponent(versionId)}/copy`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() } }); },
  publishPromptTemplate(versionId: string) { return request<ApiPromptTemplateCopy>(`/api/prompt-templates/${encodeURIComponent(versionId)}/publish`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() } }); },
  retirePromptTemplate(versionId: string) { return request<ApiPromptTemplateCopy>(`/api/prompt-templates/${encodeURIComponent(versionId)}/retire`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() } }); },
  listPlatforms() { return request<ApiPlatformProfile[]>("/api/platforms"); },
  generateBase(suiteId: string, inputImageId: string, templateVersionId: string, dynamicInput: Record<string, unknown>) {
    return request<{ attempt: ApiGenerationAttempt; version: ApiBaseVersion | null }>(`/api/suites/${encodeURIComponent(suiteId)}/input-images/${encodeURIComponent(inputImageId)}/base-generation`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() },
      body: JSON.stringify({ templateVersionId, dynamicInput }),
    });
  },
  selectBaseVersion(suiteId: string, inputImageId: string, versionId: string) {
    return request<ApiBaseVersion>(`/api/suites/${encodeURIComponent(suiteId)}/input-images/${encodeURIComponent(inputImageId)}/base-versions/${encodeURIComponent(versionId)}/select`, { method: "POST" });
  },
  searchChunks(query: string) { return request<ApiRagChunk[]>("/api/rag/chunks/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) }); },
  getPlan(suiteId: string) { return request<ApiPlanState>(`/api/suites/${encodeURIComponent(suiteId)}/plan`); },
  getPlanAttempt(attemptId: string) { return request<ApiPlanAttempt>(`/api/plan-attempts/${encodeURIComponent(attemptId)}`); },
  getStructurePlan(suiteId: string) { return request<ApiPlanState>(`/api/suites/${encodeURIComponent(suiteId)}/structure-plan`); },
  generateStructurePlan(suiteId: string, templateVersionId: string, dynamicInput: Record<string, unknown>, selectedChunks: ApiRagChunk[] = []) { return request<{ attemptId: string; status: string }>(`/api/suites/${encodeURIComponent(suiteId)}/structure-plan`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() }, body: JSON.stringify({ templateVersionId, dynamicInput, humanInput: {}, selectedChunks: selectedChunks.map(({ id, version }) => ({ id, version })) }) }); },
  confirmStructurePlan(suiteId: string, structure: ApiStructurePlan) { return request<ApiPlanSnapshot>(`/api/suites/${encodeURIComponent(suiteId)}/structure-plan/confirm`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() }, body: JSON.stringify({ structure }) }); },
  getCategoryPrompts(suiteId: string) { return request<ApiCategoryPromptState>(`/api/suites/${encodeURIComponent(suiteId)}/category-prompts`); },
  generateCategoryPrompts(suiteId: string, planSnapshotId: string, templateVersionId?: string) { return request<{ planSnapshotId: string; status: string }>(`/api/suites/${encodeURIComponent(suiteId)}/category-prompts`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() }, body: JSON.stringify({ planSnapshotId, templateVersionId }) }); },
  retryCategoryPrompt(suiteId: string, categoryCode: string, templateVersionId?: string) { return request<ApiCategoryPromptRequest>(`/api/suites/${encodeURIComponent(suiteId)}/category-prompts/${encodeURIComponent(categoryCode)}/retry`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() }, body: JSON.stringify(templateVersionId ? { templateVersionId } : {}) }); },
  savePlan(suiteId: string, items: Array<Pick<ApiPlanItem, "title" | "purpose" | "prompt">>) { return request<ApiPlanSnapshot>(`/api/suites/${encodeURIComponent(suiteId)}/plan`, { method: "PATCH", headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() }, body: JSON.stringify({ items }) }); },
  startCreationCheck(suiteId: string) { return request<{ ready: boolean; planSnapshotId: string; itemCount: number }>(`/api/suites/${encodeURIComponent(suiteId)}/start-creation-check`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() } }); },
  getWorkbench(suiteId: string) { return request<ApiWorkbench>(`/api/suites/${encodeURIComponent(suiteId)}/workbench`); },
  updateStyleOverride(suiteId: string, styleOverride: string | null) { return request<{ suite: ApiSuite; planStyleGuide: string; styleOverride: string | null; effectiveStyleGuide: string }>(`/api/suites/${encodeURIComponent(suiteId)}/style-override`, { method: "PATCH", headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() }, body: JSON.stringify({ styleOverride }) }); },
  deliveryExportUrl(suiteId: string, options?: { preset?: string; format?: string; quality?: number; stitchDetail?: boolean }) {
    const search = new URLSearchParams();
    if (options?.preset && options.preset !== "original") search.set("preset", options.preset);
    if (options?.format && options.format !== "original") search.set("format", options.format);
    if (options?.quality !== undefined) search.set("quality", String(options.quality));
    if (options?.stitchDetail) search.set("stitchDetail", "true");
    const qs = search.toString();
    return `/api/suites/${encodeURIComponent(suiteId)}/delivery/export${qs ? `?${qs}` : ""}`;
  },
  createCustomTask(suiteId: string, body: { imageType: "main" | "detail"; title: string; purpose?: string; promptDraft: string; sourceInputImageId?: string | null; generationParams?: Record<string, unknown> }) {
    return request<ApiSuiteTask>(`/api/suites/${encodeURIComponent(suiteId)}/tasks/custom`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() }, body: JSON.stringify(body) });
  },
  batchUpdateTaskParams(suiteId: string, body: { imageType?: "main" | "detail" | "all"; taskIds?: string[]; generationParams: Record<string, unknown> }) {
    return request<{ updatedCount: number; tasks: ApiSuiteTask[] }>(`/api/suites/${encodeURIComponent(suiteId)}/tasks/batch-params`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() }, body: JSON.stringify(body) });
  },
  translateImageTexts(body: { targetLanguage: string; items: Array<{ id: string; text: string }>; preserveBrandTerms?: boolean }) {
    return request<{ targetLanguage: string; translations: Array<{ id: string; originalText: string; translatedText: string }>; model: string; channelName: string | null }>("/api/image-editor/translate-text", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  },
  createTasks(suiteId: string, planSnapshotId?: string) { return request<{ planSnapshotId: string; tasks: ApiSuiteTask[]; createdTaskIds: string[] }>(`/api/suites/${encodeURIComponent(suiteId)}/tasks`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() }, body: JSON.stringify(planSnapshotId ? { planSnapshotId } : {}) }); },
  updateTask(taskId: string, body: Partial<Pick<ApiSuiteTask, "title" | "purpose" | "promptDraft" | "sourceInputImageId" | "generationParams" | "status">>) { return request<ApiSuiteTask>(`/api/suite-tasks/${encodeURIComponent(taskId)}`, { method: "PATCH", headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() }, body: JSON.stringify(body) }); },
  generateBatch(suiteId: string, taskIds?: string[]) { return request<{ batchId: string; status: string; requestedCount?: number }>(`/api/suites/${encodeURIComponent(suiteId)}/generation`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() }, body: JSON.stringify(taskIds ? { taskIds } : {}) }); },
  generateTask(taskId: string, promptDraft?: string) { return request<{ batchId: string; status: string }>(`/api/suite-tasks/${encodeURIComponent(taskId)}/generation`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() }, body: JSON.stringify(promptDraft === undefined ? {} : { promptDraft }) }); },
  retryTaskAttempt(attemptId: string) {
    return request<{ batchId: string }>(`/api/generation-attempts/${encodeURIComponent(attemptId)}/retry`, { method: "POST", headers: { "idempotency-key": createIdempotencyKey() } });
  },
  getBatch(batchId: string) { return request<{ batch: ApiTaskBatch; slots: ApiTaskSlot[]; attempts: ApiTaskAttempt[] }>(`/api/generation-batches/${encodeURIComponent(batchId)}`); },
  getTaskVersions(taskId: string) { return request<{ versions: ApiTaskVersion[]; attempts: ApiTaskAttempt[] }>(`/api/suite-tasks/${encodeURIComponent(taskId)}/versions`); },
  selectTaskVersion(taskId: string, versionId: string, selection: "current" | "final") { return request<ApiTaskVersion>(`/api/suite-tasks/${encodeURIComponent(taskId)}/versions/${encodeURIComponent(versionId)}/select`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() }, body: JSON.stringify({ selection }) }); },
  retryAttempt(attemptId: string) { return request<{ batchId: string; status: string }>(`/api/generation-attempts/${encodeURIComponent(attemptId)}/retry`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() }, body: JSON.stringify({}) }); },
  imageEditorCapabilities() { return request<{ provider: { name: string; version: string; capabilitiesVersion: string; channel?: ModelChannelSnapshot } | null; capabilities: Record<string, boolean> }>("/api/image-editor/capabilities"); },
  getImageEditDraft(sessionId: string) { return request<{ sessionId: string; operations: Array<Record<string, unknown>>; summary: string }>(`/api/image-editor/sessions/${encodeURIComponent(sessionId)}`); },
  upsertImageEditOperation(sessionId: string, operation: Record<string, unknown>, summary?: string) { return request<Record<string, unknown>>(`/api/image-editor/sessions/${encodeURIComponent(sessionId)}/operations`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() }, body: JSON.stringify({ operation, summary }) }); },
  removeImageEditOperation(sessionId: string, operationId: string) { return request<Record<string, unknown>>(`/api/image-editor/sessions/${encodeURIComponent(sessionId)}/operations/${encodeURIComponent(operationId)}`, { method: "DELETE" }); },
  submitImageEdit(sessionId: string, body: { sourceCardId: string; sourceVersionId: string; parentVersionId?: string; summary?: string }) { return request<Record<string, unknown>>(`/api/image-editor/sessions/${encodeURIComponent(sessionId)}/submit`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() }, body: JSON.stringify(body) }); },
  getImageEditTask(taskId: string) { return request<Record<string, unknown>>(`/api/image-editor/tasks/${encodeURIComponent(taskId)}`); },
  retryImageEdit(attemptId: string) { return request<Record<string, unknown>>(`/api/image-editor/attempts/${encodeURIComponent(attemptId)}/retry`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() }, body: JSON.stringify({}) }); },
  regenerateImageEditTask(taskId: string, summary?: string) { return request<Record<string, unknown>>(`/api/image-editor/tasks/${encodeURIComponent(taskId)}/regenerate`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() }, body: JSON.stringify(summary === undefined ? {} : { summary }) }); },
  recognizeImageEditText(sessionId: string, sourceVersionId: string) { return request<{ sourceVersionId: string; status: "succeeded" | "failed"; blocks: Array<{ id: string; text: string; confidence: number; bounds: { x: number; y: number; width: number; height: number }; rotation: number }>; error?: string }>(`/api/image-editor/sessions/${encodeURIComponent(sessionId)}/ocr`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceVersionId }) }); },
  selectImageEditVersion(taskId: string, versionId: string, selection: "current" | "final") { return request<Record<string, unknown>>(`/api/image-editor/tasks/${encodeURIComponent(taskId)}/versions/${encodeURIComponent(versionId)}/select`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() }, body: JSON.stringify({ selection }) }); },
  getLayout(suiteId: string) { return request<ApiCanvasLayout | null>(`/api/suites/${encodeURIComponent(suiteId)}/workbench/layout`); },
  saveLayout(suiteId: string, layout: Pick<ApiCanvasLayout, "layoutVersion" | "viewport" | "nodes" | "groups">) { return request<ApiCanvasLayout>(`/api/suites/${encodeURIComponent(suiteId)}/workbench/layout`, { method: "PATCH", headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() }, body: JSON.stringify(layout) }); },
  listLibraryResources(params: { resourceType?: ApiLibraryResourceType; scope?: "image"; stage?: ApiPromptTemplate["stage"]; suiteId?: string; query?: string; page?: number; pageSize?: number; status?: "draft" | "published" | "archived" | "retired" } = {}) { const search = new URLSearchParams(); Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== '') search.set(key, String(value)); }); return request<{ items: ApiLibraryResource[]; total: number; page: number; pageSize: number }>(`/api/library/resources?${search.toString()}`); },
  getLibraryResource(resourceId: string) { return request<ApiLibraryResource>(`/api/library/resources/${encodeURIComponent(resourceId)}`); },
  listLibraryReferences(suiteId: string, targetType?: "plan" | "task", targetId?: string) { const search = new URLSearchParams(); if (targetType) search.set("targetType", targetType); if (targetId) search.set("targetId", targetId); return request<ApiLibraryReference[]>(`/api/suites/${encodeURIComponent(suiteId)}/library/references?${search.toString()}`); },
  createLibraryReference(suiteId: string, body: { resourceId: string; targetType: "plan" | "task"; targetId: string }) { return request<ApiLibraryReference>(`/api/suites/${encodeURIComponent(suiteId)}/library/references`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() }, body: JSON.stringify(body) }); },
  archiveLibraryReference(suiteId: string, referenceId: string) { return request<ApiLibraryReference>(`/api/suites/${encodeURIComponent(suiteId)}/library/references/${encodeURIComponent(referenceId)}`, { method: "DELETE" }); },
  setLibraryResourceStatus(resourceId: string, status: "draft" | "published" | "archived") { return request<ApiLibraryResource>(`/api/library/resources/${encodeURIComponent(resourceId)}/status`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() }, body: JSON.stringify({ status }) }); },
  deleteLibraryResource(resourceId: string) { return request<{ id: string; deletedAt: string; alreadyDeleted: boolean }>(`/api/library/resources/${encodeURIComponent(resourceId)}`, { method: "DELETE" }); },
  batchDeleteLibraryResources(ids: string[]) { return request<{ deletedIds: string[]; alreadyDeletedIds: string[]; notFoundIds: string[]; deletedCount: number }>("/api/library/resources/batch-delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) }); },
  createReverseReferenceAsset(body: { suiteId?: string | null; title: string; summary?: string; objectKey: string; mimeType: string; promptSnapshot: Record<string, unknown>; visualStructure?: Record<string, unknown>; source?: Record<string, unknown> }) { return request<ApiLibraryResource>("/api/library/reverse-reference-assets", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() }, body: JSON.stringify(body) }); },
  importReversePlan(planId: string, body: { targetSuiteId?: string; name?: string } = {}) { return request<{ suiteId: string; taskGroupId: string; taskIds: string[]; duplicate: boolean }>(`/api/reverse-plans/${encodeURIComponent(planId)}/canvas-imports`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() }, body: JSON.stringify(body) }); },
  bindWhiteResources(taskId: string, resourceIds: string[]) { return request<{ task: ApiSuiteTask; reference: ApiLibraryReference; references: ApiLibraryReference[]; duplicate: boolean }>(`/api/suite-tasks/${encodeURIComponent(taskId)}/white-resource`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() }, body: JSON.stringify({ resourceIds }) }); },
  bindWhiteResource(taskId: string, resourceId: string) { return this.bindWhiteResources(taskId, [resourceId]); },
};

export type {
  ProductCard as ApiProductCard,
  ProductCardFields as ApiProductCardFields,
  ProductCardSnapshot as ApiProductCardSnapshot,
  ProductCardStatus as ApiProductCardStatus,
  ProductCardSummary as ApiProductCardSummary,
  ProductCardSupplierImage as ApiProductCardSupplierImage,
};

export interface ApiProductCardListQuery {
  status?: ProductCardStatus | "all";
  keyword?: string;
  limit?: number;
  offset?: number;
}

export interface ApiProductCardListResult {
  items: ProductCardSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface ApiProductCardNewImagePayload {
  filename: string;
  mimeType: string;
  bytesBase64: string;
}

export type ApiProductCardUpdateImagePayload =
  | { imageId: string }
  | ApiProductCardNewImagePayload;

export interface ApiCreateProductCardPayload extends ProductCardFields {
  sourceSessionId?: string | null;
  supplierImages?: ApiProductCardNewImagePayload[];
}

export interface ApiUpdateProductCardPayload extends Partial<ProductCardFields> {
  supplierImages?: ApiProductCardUpdateImagePayload[];
}

const productCardsPath = "/api/product-cards";
const productCardItemPath = (id: string) => `${productCardsPath}/${encodeURIComponent(id)}`;

export const productCardsApi = {
  list(query: ApiProductCardListQuery = {}) {
    const search = new URLSearchParams();
    if (query.status) search.set("status", query.status);
    if (query.keyword?.trim()) search.set("keyword", query.keyword.trim());
    if (query.limit !== undefined) search.set("limit", String(query.limit));
    if (query.offset !== undefined) search.set("offset", String(query.offset));
    const qs = search.toString();
    return request<ApiProductCardListResult>(qs ? `${productCardsPath}?${qs}` : productCardsPath);
  },
  get(id: string) {
    return request<ProductCard>(productCardItemPath(id));
  },
  create(payload: ApiCreateProductCardPayload) {
    return request<ProductCard>(productCardsPath, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() },
      body: JSON.stringify(payload),
    });
  },
  update(id: string, payload: ApiUpdateProductCardPayload) {
    return request<ProductCard>(productCardItemPath(id), {
      method: "PATCH",
      headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() },
      body: JSON.stringify(payload),
    });
  },
  archive(id: string) {
    return request<ProductCard>(`${productCardItemPath(id)}/archive`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() },
      body: JSON.stringify({}),
    });
  },
  restore(id: string) {
    return request<ProductCard>(`${productCardItemPath(id)}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() },
      body: JSON.stringify({}),
    });
  },
  delete(id: string) {
    return request<{ id: string }>(productCardItemPath(id), { method: "DELETE" });
  },
};
