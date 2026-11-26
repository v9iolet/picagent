import { getJson, postJson, patchJson, deleteJson } from "./http.js";
import type {
  ApiPromptTemplate,
  ApiPromptTemplateCopy,
  ApiSuiteTask,
  ApiLibraryResourceType,
  ApiLibraryResource,
  ApiLibraryReference,
} from "./types.js";

export const libraryApi = {
  listPromptTemplates(stage?: ApiPromptTemplate["stage"], status?: "published" | "draft" | "retired" | "all") {
    const search = new URLSearchParams();
    if (stage) search.set("stage", stage);
    if (status) search.set("status", status);
    const qs = search.toString();
    return getJson<ApiPromptTemplate[]>(qs ? `/api/prompt-templates?${qs}` : "/api/prompt-templates");
  },
  getPromptTemplateVersion(versionId: string) {
    return getJson<ApiPromptTemplateCopy>(`/api/prompt-templates/${encodeURIComponent(versionId)}`);
  },
  copyPromptTemplate(templateVersionId: string, stage?: ApiPromptTemplate["stage"]) {
    return getJson<ApiPromptTemplateCopy>(`/api/prompt-templates/${encodeURIComponent(templateVersionId)}/copy${stage ? `?stage=${encodeURIComponent(stage)}` : ""}`);
  },
  listPromptTemplateVersions(templateId: string) {
    return getJson<ApiPromptTemplateCopy[]>(`/api/prompt-templates/${encodeURIComponent(templateId)}/versions`);
  },
  updatePromptTemplate(versionId: string, body: Partial<Pick<ApiPromptTemplateCopy, "name" | "body" | "userPromptTemplate" | "inputSchema" | "outputSchema" | "applicability">>) {
    return patchJson<ApiPromptTemplateCopy>(`/api/prompt-templates/${encodeURIComponent(versionId)}`, body, { idempotent: true });
  },
  copyPromptTemplateVersion(versionId: string) {
    return postJson<ApiPromptTemplateCopy>(`/api/prompt-templates/${encodeURIComponent(versionId)}/copy`, undefined, { idempotent: true });
  },
  publishPromptTemplate(versionId: string) {
    return postJson<ApiPromptTemplateCopy>(`/api/prompt-templates/${encodeURIComponent(versionId)}/publish`, undefined, { idempotent: true });
  },
  retirePromptTemplate(versionId: string) {
    return postJson<ApiPromptTemplateCopy>(`/api/prompt-templates/${encodeURIComponent(versionId)}/retire`, undefined, { idempotent: true });
  },
  listLibraryResources(params: { resourceType?: ApiLibraryResourceType; scope?: "image"; stage?: ApiPromptTemplate["stage"]; suiteId?: string; query?: string; page?: number; pageSize?: number; status?: "draft" | "published" | "archived" | "retired" } = {}) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") search.set(key, String(value));
    }
    return getJson<{ items: ApiLibraryResource[]; total: number; page: number; pageSize: number }>(`/api/library/resources?${search.toString()}`);
  },
  getLibraryResource(resourceId: string) {
    return getJson<ApiLibraryResource>(`/api/library/resources/${encodeURIComponent(resourceId)}`);
  },
  listLibraryReferences(suiteId: string, targetType?: "plan" | "task", targetId?: string) {
    const search = new URLSearchParams();
    if (targetType) search.set("targetType", targetType);
    if (targetId) search.set("targetId", targetId);
    return getJson<ApiLibraryReference[]>(`/api/suites/${encodeURIComponent(suiteId)}/library/references?${search.toString()}`);
  },
  createLibraryReference(suiteId: string, body: { resourceId: string; targetType: "plan" | "task"; targetId: string }) {
    return postJson<ApiLibraryReference>(`/api/suites/${encodeURIComponent(suiteId)}/library/references`, body, { idempotent: true });
  },
  archiveLibraryReference(suiteId: string, referenceId: string) {
    return deleteJson<ApiLibraryReference>(`/api/suites/${encodeURIComponent(suiteId)}/library/references/${encodeURIComponent(referenceId)}`);
  },
  setLibraryResourceStatus(resourceId: string, status: "draft" | "published" | "archived") {
    return postJson<ApiLibraryResource>(`/api/library/resources/${encodeURIComponent(resourceId)}/status`, { status }, { idempotent: true });
  },
  deleteLibraryResource(resourceId: string) {
    return deleteJson<{ id: string; deletedAt: string; alreadyDeleted: boolean }>(`/api/library/resources/${encodeURIComponent(resourceId)}`);
  },
  batchDeleteLibraryResources(ids: string[]) {
    return postJson<{ deletedIds: string[]; alreadyDeletedIds: string[]; notFoundIds: string[]; deletedCount: number }>("/api/library/resources/batch-delete", { ids });
  },
  createReverseReferenceAsset(body: { suiteId?: string | null; title: string; summary?: string; objectKey: string; mimeType: string; promptSnapshot: Record<string, unknown>; visualStructure?: Record<string, unknown>; source?: Record<string, unknown> }) {
    return postJson<ApiLibraryResource>("/api/library/reverse-reference-assets", body, { idempotent: true });
  },
  importReversePlan(planId: string, body: { targetSuiteId?: string; name?: string } = {}) {
    return postJson<{ suiteId: string; taskGroupId: string; taskIds: string[]; duplicate: boolean }>(`/api/reverse-plans/${encodeURIComponent(planId)}/canvas-imports`, body, { idempotent: true });
  },
  bindWhiteResources(taskId: string, resourceIds: string[]) {
    return postJson<{ task: ApiSuiteTask; reference: ApiLibraryReference; references: ApiLibraryReference[]; duplicate: boolean }>(`/api/suite-tasks/${encodeURIComponent(taskId)}/white-resource`, { resourceIds }, { idempotent: true });
  },
  bindWhiteResource(taskId: string, resourceId: string) {
    return this.bindWhiteResources(taskId, [resourceId]);
  },
};
