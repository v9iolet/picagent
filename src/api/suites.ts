import { getJson, postJson, patchJson, deleteJson, postGeneration, uploadWithProgress } from "./http.js";
import type {
  ApiImage,
  ApiSuite,
  ApiBaseVersion,
  ApiGenerationAttempt,
  ApiBaseHistory,
  ApiPlatformProfile,
  ApiRagChunk,
  ApiPlanItem,
  ApiStructurePlan,
  ApiCategoryPromptRequest,
  ApiCategoryPromptState,
  ApiPlanSnapshot,
  ApiPlanAttempt,
  ApiPlanState,
  ApiTaskVersion,
  ApiTaskAttempt,
  ApiTaskSlot,
  ApiSuiteTask,
  ApiTaskBatch,
  ApiCanvasLayout,
  ApiWorkbench,
} from "./types.js";

import { libraryApi } from "./library.js";
import { imageEditorApi } from "./image-editor.js";

export const suiteApi = {
  create(name: string, origin?: "suite_studio" | "canvas") {
    return postJson<ApiSuite>("/api/suites", { name, origin }, { idempotent: true });
  },
  rename(id: string, name: string) {
    return patchJson<ApiSuite>(`/api/suites/${encodeURIComponent(id)}`, { name }, { idempotent: true });
  },
  delete(id: string) {
    return deleteJson<{ id: string }>(`/api/suites/${encodeURIComponent(id)}`);
  },
  list() {
    return getJson<ApiSuite[]>("/api/suites");
  },
  listCanvases() {
    return getJson<ApiSuite[]>("/api/suites?view=canvas");
  },
  get(id: string) {
    return getJson<ApiSuite>(`/api/suites/${encodeURIComponent(id)}`);
  },
  removeInputImage(suiteId: string, inputImageId: string) {
    return deleteJson<{ id: string }>(`/api/suites/${encodeURIComponent(suiteId)}/input-images/${encodeURIComponent(inputImageId)}`);
  },
  upload(id: string, file: File, ordinal: number, onProgress?: (value: number) => void) {
    const form = new FormData();
    form.append("ordinal", String(ordinal));
    form.append("file", file, file.name);
    return uploadWithProgress<ApiImage>(`/api/suites/${encodeURIComponent(id)}/input-images`, form, { idempotent: true, onProgress });
  },
  getBaseVersions(suiteId: string, inputImageId: string) {
    return getJson<ApiBaseHistory>(`/api/suites/${encodeURIComponent(suiteId)}/input-images/${encodeURIComponent(inputImageId)}/base-versions`);
  },
  listPlatforms() {
    return getJson<ApiPlatformProfile[]>("/api/platforms");
  },
  generateBase(suiteId: string, inputImageId: string, templateVersionId: string, dynamicInput: Record<string, unknown>, idempotencyKey?: string) {
    return postGeneration<{ attempt: ApiGenerationAttempt; version: ApiBaseVersion | null }>(`/api/suites/${encodeURIComponent(suiteId)}/input-images/${encodeURIComponent(inputImageId)}/base-generation`, { templateVersionId, dynamicInput }, idempotencyKey);
  },
  selectBaseVersion(suiteId: string, inputImageId: string, versionId: string) {
    return postJson<ApiBaseVersion>(`/api/suites/${encodeURIComponent(suiteId)}/input-images/${encodeURIComponent(inputImageId)}/base-versions/${encodeURIComponent(versionId)}/select`);
  },
  searchChunks(query: string) {
    return postJson<ApiRagChunk[]>("/api/rag/chunks/search", { query });
  },
  getPlan(suiteId: string) {
    return getJson<ApiPlanState>(`/api/suites/${encodeURIComponent(suiteId)}/plan`);
  },
  getPlanAttempt(attemptId: string) {
    return getJson<ApiPlanAttempt>(`/api/plan-attempts/${encodeURIComponent(attemptId)}`);
  },
  getStructurePlan(suiteId: string) {
    return getJson<ApiPlanState>(`/api/suites/${encodeURIComponent(suiteId)}/structure-plan`);
  },
  generateStructurePlan(suiteId: string, templateVersionId: string, dynamicInput: Record<string, unknown>, selectedChunks: ApiRagChunk[] = []) {
    return postJson<{ attemptId: string; status: string }>(`/api/suites/${encodeURIComponent(suiteId)}/structure-plan`, { templateVersionId, dynamicInput, humanInput: {}, selectedChunks: selectedChunks.map(({ id, version }) => ({ id, version })) }, { idempotent: true });
  },
  confirmStructurePlan(suiteId: string, structure: ApiStructurePlan) {
    return postJson<ApiPlanSnapshot>(`/api/suites/${encodeURIComponent(suiteId)}/structure-plan/confirm`, { structure }, { idempotent: true });
  },
  getCategoryPrompts(suiteId: string) {
    return getJson<ApiCategoryPromptState>(`/api/suites/${encodeURIComponent(suiteId)}/category-prompts`);
  },
  generateCategoryPrompts(suiteId: string, planSnapshotId: string, templateVersionId?: string) {
    return postJson<{ planSnapshotId: string; status: string }>(`/api/suites/${encodeURIComponent(suiteId)}/category-prompts`, { planSnapshotId, templateVersionId }, { idempotent: true });
  },
  retryCategoryPrompt(suiteId: string, categoryCode: string, templateVersionId?: string) {
    return postJson<ApiCategoryPromptRequest>(`/api/suites/${encodeURIComponent(suiteId)}/category-prompts/${encodeURIComponent(categoryCode)}/retry`, templateVersionId ? { templateVersionId } : {}, { idempotent: true });
  },
  savePlan(suiteId: string, items: Array<Pick<ApiPlanItem, "title" | "purpose" | "prompt">>) {
    return patchJson<ApiPlanSnapshot>(`/api/suites/${encodeURIComponent(suiteId)}/plan`, { items }, { idempotent: true });
  },
  startCreationCheck(suiteId: string) {
    return postJson<{ ready: boolean; planSnapshotId: string; itemCount: number }>(`/api/suites/${encodeURIComponent(suiteId)}/start-creation-check`, undefined, { idempotent: true });
  },
  getWorkbench(suiteId: string, signal?: AbortSignal) {
    return getJson<ApiWorkbench>(`/api/suites/${encodeURIComponent(suiteId)}/workbench`, { signal });
  },
  updateStyleOverride(suiteId: string, styleOverride: string | null) {
    return patchJson<{ suite: ApiSuite; planStyleGuide: string; styleOverride: string | null; effectiveStyleGuide: string }>(`/api/suites/${encodeURIComponent(suiteId)}/style-override`, { styleOverride }, { idempotent: true });
  },
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
    return postJson<ApiSuiteTask>(`/api/suites/${encodeURIComponent(suiteId)}/tasks/custom`, body, { idempotent: true });
  },
  batchUpdateTaskParams(suiteId: string, body: { imageType?: "main" | "detail" | "all"; taskIds?: string[]; generationParams: Record<string, unknown> }) {
    return postJson<{ updatedCount: number; tasks: ApiSuiteTask[] }>(`/api/suites/${encodeURIComponent(suiteId)}/tasks/batch-params`, body, { idempotent: true });
  },
  createTasks(suiteId: string, planSnapshotId?: string) {
    return postJson<{ planSnapshotId: string; tasks: ApiSuiteTask[]; createdTaskIds: string[] }>(`/api/suites/${encodeURIComponent(suiteId)}/tasks`, planSnapshotId ? { planSnapshotId } : {}, { idempotent: true });
  },
  updateTask(taskId: string, body: Partial<Pick<ApiSuiteTask, "title" | "purpose" | "promptDraft" | "sourceInputImageId" | "generationParams" | "status">>) {
    return patchJson<ApiSuiteTask>(`/api/suite-tasks/${encodeURIComponent(taskId)}`, body, { idempotent: true });
  },
  generateBatch(suiteId: string, taskIds?: string[], idempotencyKey?: string) {
    return postGeneration<{ batchId: string; status: string; requestedCount?: number }>(`/api/suites/${encodeURIComponent(suiteId)}/generation`, taskIds ? { taskIds } : {}, idempotencyKey);
  },
  generateTask(taskId: string, options?: string | { promptDraft?: string; additionalPrompt?: string }, idempotencyKey?: string) {
    const body = typeof options === "string" ? { promptDraft: options } : options ?? {};
    return postGeneration<{ batchId: string; status: string }>(`/api/suite-tasks/${encodeURIComponent(taskId)}/generation`, body, idempotencyKey);
  },
  regenerateTaskFromEdit(taskId: string, editSourceVersionId: string, idempotencyKey?: string) {
    return postGeneration<{ batchId: string; status: string }>(`/api/suite-tasks/${encodeURIComponent(taskId)}/generation`, { editSourceVersionId }, idempotencyKey);
  },
  retryTaskAttempt(attemptId: string, idempotencyKey?: string) {
    return postGeneration<{ batchId: string }>(`/api/generation-attempts/${encodeURIComponent(attemptId)}/retry`, {}, idempotencyKey);
  },
  getBatch(batchId: string, signal?: AbortSignal) {
    return getJson<{ batch: ApiTaskBatch; slots: ApiTaskSlot[]; attempts: ApiTaskAttempt[] }>(`/api/generation-batches/${encodeURIComponent(batchId)}`, { signal });
  },
  getTaskVersions(taskId: string) {
    return getJson<{ versions: ApiTaskVersion[]; attempts: ApiTaskAttempt[] }>(`/api/suite-tasks/${encodeURIComponent(taskId)}/versions`);
  },
  selectTaskVersion(taskId: string, versionId: string, selection: "current" | "final") {
    return postJson<ApiTaskVersion>(`/api/suite-tasks/${encodeURIComponent(taskId)}/versions/${encodeURIComponent(versionId)}/select`, { selection }, { idempotent: true });
  },
  retryAttempt(attemptId: string, idempotencyKey?: string) {
    return postGeneration<{ batchId: string; status: string }>(`/api/generation-attempts/${encodeURIComponent(attemptId)}/retry`, {}, idempotencyKey);
  },
  getLayout(suiteId: string) {
    return getJson<ApiCanvasLayout | null>(`/api/suites/${encodeURIComponent(suiteId)}/workbench/layout`);
  },
  saveLayout(suiteId: string, layout: Pick<ApiCanvasLayout, "layoutVersion" | "viewport" | "nodes" | "groups">) {
    return patchJson<ApiCanvasLayout>(`/api/suites/${encodeURIComponent(suiteId)}/workbench/layout`, layout, { idempotent: true });
  },
  ...libraryApi,
  ...imageEditorApi,
};
