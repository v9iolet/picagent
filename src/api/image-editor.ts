import { getJson, postJson, deleteJson, request, postGeneration } from "./http.js";
import type {
  ApiImageEditSelection,
  ApiImageEditProductInput,
} from "./types.js";

import type { OutpaintRatio } from "../../shared/image-editor";
import type { ModelChannelSnapshot } from "../../shared/model-settings";

const restoreInputsPath = (sessionId: string, versionId: string) =>
  `/api/image-editor/sessions/${encodeURIComponent(sessionId)}/versions/${encodeURIComponent(versionId)}/restore-inputs`;

export const imageEditorApi = {
  translateImageTexts(body: { targetLanguage: string; items: Array<{ id: string; text: string }>; preserveBrandTerms?: boolean }) {
    return postJson<{ targetLanguage: string; translations: Array<{ id: string; originalText: string; translatedText: string }>; model: string; channelName: string | null }>("/api/image-editor/translate-text", body);
  },
  imageEditorCapabilities() {
    return getJson<{ provider: { name: string; version: string; capabilitiesVersion: string; channel?: ModelChannelSnapshot } | null; capabilities: Record<string, boolean>; outpaintRatios?: OutpaintRatio[] }>("/api/image-editor/capabilities");
  },
  getImageEditDraft(sessionId: string, sourceVersionId: string) {
    return getJson<{ sessionId: string; operations: Array<Record<string, unknown>>; summary: string; productInputs: ApiImageEditProductInput[] }>(`/api/image-editor/sessions/${encodeURIComponent(sessionId)}?sourceVersionId=${encodeURIComponent(sourceVersionId)}`);
  },
  uploadImageEditRestoreInput(sessionId: string, sourceVersionId: string, file: File) {
    const body = new FormData();
    body.append("file", file);
    return request<ApiImageEditProductInput>(restoreInputsPath(sessionId, sourceVersionId), { method: "POST", body });
  },
  imageEditRestoreInputThumbnail(sessionId: string, sourceVersionId: string, objectKey: string) {
    return `${restoreInputsPath(sessionId, sourceVersionId)}/${encodeURIComponent(objectKey)}/thumbnail`;
  },
  upsertImageEditOperation(sessionId: string, operation: Record<string, unknown>, summary?: string) {
    return postJson<Record<string, unknown>>(`/api/image-editor/sessions/${encodeURIComponent(sessionId)}/operations`, { operation, summary }, { idempotent: true });
  },
  removeImageEditOperation(sessionId: string, operationId: string) {
    return deleteJson<Record<string, unknown>>(`/api/image-editor/sessions/${encodeURIComponent(sessionId)}/operations/${encodeURIComponent(operationId)}`);
  },
  submitImageEdit(sessionId: string, body: ApiImageEditSelection & { sourceCardId: string; parentVersionId?: string; summary?: string }, idempotencyKey?: string) {
    return postGeneration<Record<string, unknown>>(`/api/image-editor/sessions/${encodeURIComponent(sessionId)}/submit`, body, idempotencyKey);
  },
  getImageEditTask(taskId: string, signal?: AbortSignal) {
    return getJson<Record<string, unknown>>(`/api/image-editor/tasks/${encodeURIComponent(taskId)}`, { signal });
  },
  retryImageEdit(attemptId: string, idempotencyKey?: string) {
    return postGeneration<Record<string, unknown>>(`/api/image-editor/attempts/${encodeURIComponent(attemptId)}/retry`, {}, idempotencyKey);
  },
  regenerateImageEditTask(taskId: string, idempotencyKey?: string) {
    return postGeneration<Record<string, unknown>>(`/api/image-editor/tasks/${encodeURIComponent(taskId)}/regenerate`, {}, idempotencyKey);
  },
  recognizeImageEditText(sessionId: string, sourceVersionId: string) {
    return postJson<{ sourceVersionId: string; status: "succeeded" | "failed"; blocks: Array<{ id: string; text: string; confidence: number; bounds: { x: number; y: number; width: number; height: number }; rotation: number }>; error?: string }>(`/api/image-editor/sessions/${encodeURIComponent(sessionId)}/ocr`, { sourceVersionId });
  },
  selectImageEditVersion(taskId: string, versionId: string, selection: "current" | "final") {
    return postJson<Record<string, unknown>>(`/api/image-editor/tasks/${encodeURIComponent(taskId)}/versions/${encodeURIComponent(versionId)}/select`, { selection }, { idempotent: true });
  },
};
