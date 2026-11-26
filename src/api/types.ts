import type { AplusImageVersionMetadata, AplusTaskMetadata, DetailSizePresets } from "../../shared/aplus";
import type { ListingRules } from "../../shared/listing-config";
import type { ModelChannelSnapshot } from "../../shared/model-settings";

export interface ApiImage {
  id: string; suiteId: string; ordinal: number; originalObjectKey: string; thumbnailObjectKey: string;
  sha256: string; width: number; height: number; mimeType: string; originalFilename: string;
  currentBaseVersionId: string | null; createdAt: string; originalPreviewUrl: string; thumbnailPreviewUrl: string;
}
export interface ApiSuite {
  id: string; name: string; status: "draft" | "in_progress"; origin?: "suite_studio" | "canvas" | "replica" | "aplus";
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
  kind: string; stage: "base_refine" | "plan" | "structure_plan" | "category_prompt" | "task_image" | "reverse_prompt" | "listing_copy" | "replica_prompt" | "product_onboarding" | "aplus_plan" | "aplus_module_rule" | "aplus_image" | "aplus_ai_write"; executionTarget: "llm" | "image_model";
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
  detailSizePresets: DetailSizePresets;
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
export interface ApiTaskVersion extends AplusImageVersionMetadata { id: string; taskId: string; slotId: string; attemptId: string; versionNumber: number; objectKey: string; processObjectKeys: string[]; sha256: string; width: number; height: number; mimeType: string; promptSnapshot: Record<string, unknown>; contextSnapshot: Record<string, unknown>; isCurrent: boolean; isFinal: boolean; createdAt: string; previewUrl: string }
export interface ApiTaskAttempt { id: string; slotId: string; attemptNo: number; provider: string; model: string; endpoint: string; requestSummary: Record<string, unknown>; promptSnapshot: Record<string, unknown>; promptSha256: string; contextSnapshot: Record<string, unknown>; sourceKind: "base" | "original" | "library"; sourceObjectKey: string; sourceInputImageId: string | null; sourceBaseVersionId: string | null; sourceLibraryReferenceId?: string | null; sourceResourceVersionId?: string | null; status: "running" | "succeeded" | "failed"; errorCode: string | null; errorMessage: string | null; externalRequestId: string | null; startedAt: string; finishedAt: string | null }
export interface ApiTaskSlot { id: string; batchId: string; taskId: string; slotOrdinal: number; retryOfSlotId: string | null; status: "pending" | "generating" | "succeeded" | "failed"; selectedVersionId: string | null; createdAt: string; completedAt: string | null }
export interface ApiProductMaterialRef { libraryReferenceId: string; resourceId: string; resourceVersionId: string; order: number; title?: string; previewUrl?: string }
export interface ApiSuiteTask extends AplusTaskMetadata { id: string; suiteId: string; planSnapshotId: string | null; planItemId: string | null; ordinal: number; imageType: "main" | "detail"; title: string; purpose: string; promptDraft: string; promptRevision: number; sourceInputImageId: string | null; generationParams: Record<string, unknown>; status: ApiTaskStatus; archivedAt: string | null; createdAt: string; updatedAt: string; originKind?: "suite_plan" | "reverse_import" | "replica" | "aplus"; reversePlanId?: string | null; reverseReferenceId?: string | null; reversePromptVersionId?: string | null; reverseTaskGroupId?: string | null; replicaReferenceId?: string | null; replicaReferenceObjectKey?: string | null; sourceLibraryReferenceId?: string | null; sourceResourceVersionId?: string | null; sourceRevision?: number; versions: ApiTaskVersion[]; attempts: ApiTaskAttempt[]; slots: ApiTaskSlot[] }
export interface ApiTaskBatch { id: string; suiteId: string; kind: "batch" | "single" | "retry"; requestedCount: number; taskIds: string[]; status: "running" | "completed" | "partial" | "failed"; idempotencyKey: string; createdAt: string; startedAt: string | null; finishedAt: string | null }
export interface ApiCanvasLayout { id: string; suiteId: string; layoutVersion: number; viewport: { x: number; y: number; zoom: number }; nodes: Array<{ nodeId: string; x: number; y: number; width?: number; height?: number; groupKey?: string; hidden?: boolean }>; groups: Array<{ groupKey: string; x: number; y: number; width: number; height: number; collapsed?: boolean }>; updatedAt: string }
export interface ApiWorkbench { suite: ApiSuite; inputImages: ApiImage[]; planSnapshot: ApiPlanSnapshot | null; tasks: ApiSuiteTask[]; batches: ApiTaskBatch[]; imageEditChildren?: Array<{ task: Record<string, unknown>; snapshot: Record<string, unknown> | null; attempts: Array<Record<string, unknown> & { provider?: { name: string; version: string; channel?: ModelChannelSnapshot } }>; versions: Array<{ id: string; previewUrl?: string; versionNumber: number; width?: number; height?: number; mimeType?: string; objectKey?: string; attemptId?: string; createdAt?: string }> }>; layout: ApiCanvasLayout | null; planStyleGuide?: string; styleOverride?: string | null; effectiveStyleGuide?: string }
export type ApiLibraryResourceType = "prompt_template" | "input_image" | "base_image" | "task_image_version" | "process_image" | "reverse_reference_asset";
export interface ApiLibraryResource { id: string; resourceType: ApiLibraryResourceType; title: string; summary: string; mimeType: string | null; previewUrl: string | null; suiteId: string | null; taskId: string | null; imageVersionId: string | null; baseVersionId: string | null; templateVersionId: string | null; resourceVersionId: string; stage: ApiPromptTemplate["stage"] | null; source: Record<string, unknown>; status?: "draft" | "published" | "archived" | "retired"; usedBy?: string[]; promptSnapshot?: Record<string, unknown> | null; createdAt: string; updatedAt: string }
export interface ApiLibraryReference { id: string; suiteId: string; resourceId: string; resourceType: ApiLibraryResourceType; targetType: "plan" | "task"; targetId: string; resourceVersionId: string; snapshot: Record<string, unknown>; createdAt: string; createdBy: string | null; archivedAt: string | null }

export type ApiImageEditTool = "re_edit" | "add_text" | "change_text" | "redraw" | "erase" | "outpaint" | "restore_product";
export type ApiImageEditSelection = { sourceVersionId: string; tool: ApiImageEditTool; operationIds: string[] };
export type ApiImageEditProductInput = { objectKey: string; thumbnailUrl: string };
