import { randomUUID } from "node:crypto";
import { ok, type AppResponse } from "./api-response.js";
import { formatOcrErrorMessage, type ImageEditChildTask, type ImageEditorService } from "./image-editor.js";

export type ImageEditorApiResponse = AppResponse;
const restoreInputErrors: Record<string, string> = {
  RESTORE_PRODUCT_REFERENCE_REQUIRED: "请上传一张商品外观依据图",
  RESTORE_PRODUCT_REFERENCE_INVALID: "这张依据图不适用于当前图片，请重新选择或上传",
  RESTORE_PRODUCT_IMAGE_INVALID: "请选择有效的 PNG、JPG 或 WebP 图片",
  RESTORE_PRODUCT_IMAGE_TOO_LARGE: "商品外观依据图不能超过 10 MB",
};
const fail = (code: string, status = 400): ImageEditorApiResponse => {
  if (code === "IMAGE_PROVIDER_NOT_CONFIGURED" || code === "OCR_PROVIDER_UNAVAILABLE") {
    const purpose = code === "OCR_PROVIDER_UNAVAILABLE" ? "多模态" : "生图";
    return { status: 503, body: { error: { code, message: `请前往配置 → 偏好设置，选择默认${purpose}模型` }, requestId: randomUUID() } };
  }
  return { status, body: { error: { code, message: restoreInputErrors[code] ?? code }, requestId: randomUUID() } };
};

export function createImageEditorApi(service: ImageEditorService) {
  return {
    async request(method: string, path: string, options: { headers?: Record<string, string>; body?: unknown } = {}): Promise<ImageEditorApiResponse> {
      const body = options.body && typeof options.body === "object" ? options.body as Record<string, unknown> : {};
      const idempotencyKey = options.headers?.["idempotency-key"] ?? options.headers?.["Idempotency-Key"];
      if (method === "GET" && path === "/api/image-editor/capabilities") return ok(await service.capabilities());
      const sessionMatch = path.match(/^\/api\/image-editor\/sessions\/([^/?]+)(?:\?(.*))?$/);
      if (method === "GET" && sessionMatch) {
        const sourceVersionId = new URLSearchParams(sessionMatch[2]).get("sourceVersionId");
        if (sourceVersionId) {
          try {
            return ok(await service.getSession(sessionMatch[1], sourceVersionId));
          } catch (error) {
            return fail(error instanceof Error ? error.message : "EDIT_SESSION_NOT_FOUND", 404);
          }
        }
        const draft = await service.getDraft(sessionMatch[1]);
        return draft ? ok(draft) : fail("EDIT_SESSION_NOT_FOUND", 404);
      }
      const restoreInputsMatch = path.match(/^\/api\/image-editor\/sessions\/([^/]+)\/versions\/([^/]+)\/restore-inputs(?:\/([^/]+)\/thumbnail)?$/);
      if (restoreInputsMatch) {
        const [, sessionId, sourceVersionId, encodedKey] = restoreInputsMatch;
        try {
          if (method === "POST" && !encodedKey) {
            if (!Buffer.isBuffer(body.bytes) || typeof body.mimeType !== "string") return fail("RESTORE_PRODUCT_IMAGE_INVALID");
            return ok(await service.uploadRestoreInput(sessionId, sourceVersionId, body.bytes, body.mimeType), 201);
          }
          if (method === "GET" && encodedKey) {
            const raw = await service.restoreInputThumbnail(sessionId, sourceVersionId, decodeURIComponent(encodedKey));
            return { ...ok(null), raw, headers: { "content-type": "image/webp", "cache-control": "private, max-age=300" } };
          }
        } catch (error) {
          const code = error instanceof Error ? error.message : "RESTORE_PRODUCT_IMAGE_INVALID";
          return fail(code, method === "GET" ? 404 : code === "RESTORE_PRODUCT_IMAGE_TOO_LARGE" ? 413 : 400);
        }
      }
      const taskMatch = path.match(/^\/api\/image-editor\/tasks\/([^/]+)$/);
      if (method === "GET" && taskMatch) { const result = await service.getTask(taskMatch[1]); return result ? ok(result) : fail("INVALID_IMAGE_EDIT_TASK", 404); }
      if (method === "GET" && path === "/api/image-editor/tasks") return ok(await service.listAllTasks());
      const sourceCardMatch = path.match(/^\/api\/image-editor\/source-cards\/([^/]+)\/tasks$/);
      if (method === "GET" && sourceCardMatch) return ok(await service.listTasksBySourceCard(sourceCardMatch[1]));
      const operationMatch = path.match(/^\/api\/image-editor\/sessions\/([^/]+)\/operations$/);
      if (method === "POST" && operationMatch) {
        if (!body.operation || typeof body.operation !== "object") return fail("EDIT_OPERATION_REQUIRED");
        return ok(await service.upsertOperation({ sessionId: operationMatch[1], operation: body.operation as never, summary: typeof body.summary === "string" ? body.summary : undefined }), 200);
      }
      const ocrMatch = path.match(/^\/api\/image-editor\/sessions\/([^/]+)\/ocr$/);
      if (method === "GET" && ocrMatch) { const sourceVersionId = typeof body.sourceVersionId === "string" ? body.sourceVersionId : ""; return sourceVersionId ? ok(await service.getOcrSnapshot(ocrMatch[1], sourceVersionId)) : fail("SOURCE_VERSION_REQUIRED"); }
      if (method === "POST" && ocrMatch) {
        const sourceVersionId = typeof body.sourceVersionId === "string" ? body.sourceVersionId : "";
        if (!sourceVersionId) return fail("SOURCE_VERSION_REQUIRED");
        try {
          return ok(await service.recognize(ocrMatch[1], sourceVersionId), 202);
        } catch (error) {
          const rawCode = error instanceof Error ? error.message : "OCR_FAILED";
          if (rawCode === "OCR_PROVIDER_UNAVAILABLE") return fail(rawCode, 503);
          return {
            status: 409,
            body: { error: { code: rawCode, message: formatOcrErrorMessage(error) }, requestId: randomUUID() },
          };
        }
      }
      const removeMatch = path.match(/^\/api\/image-editor\/sessions\/([^/]+)\/operations\/([^/]+)$/);
      if (method === "DELETE" && removeMatch) { const draft = await service.removeOperation(removeMatch[1], removeMatch[2]); return draft ? ok(draft) : fail("EDIT_OPERATION_NOT_FOUND", 404); }
      const submitMatch = path.match(/^\/api\/image-editor\/sessions\/([^/]+)\/submit$/);
      if (method === "POST" && submitMatch) {
        if (!idempotencyKey) return fail("MISSING_IDEMPOTENCY_KEY");
        if (body.tool !== undefined && typeof body.tool !== "string") return fail("INVALID_IMAGE_EDIT_TOOL");
        const { operationIds } = body;
        if (operationIds !== undefined && (!Array.isArray(operationIds) || !operationIds.every((id) => typeof id === "string" && id))) {
          return fail("INVALID_IMAGE_EDIT_OPERATION_IDS");
        }
        try {
          const result = await service.submit({
            sessionId: submitMatch[1], idempotencyKey,
            sourceCardId: String(body.sourceCardId ?? ""), sourceVersionId: String(body.sourceVersionId ?? ""),
            parentVersionId: typeof body.parentVersionId === "string" ? body.parentVersionId : undefined,
            summary: typeof body.summary === "string" ? body.summary : undefined,
            tool: typeof body.tool === "string" ? body.tool : undefined, operationIds,
          });
          return ok(result, result.duplicate ? 200 : 202);
        } catch (error) { return fail(error instanceof Error ? error.message : "IMAGE_EDIT_SUBMIT_FAILED", 409); }
      }
      const retryMatch = path.match(/^\/api\/image-editor\/attempts\/([^/]+)\/retry$/);
      if (method === "POST" && retryMatch) { if (!idempotencyKey) return fail("MISSING_IDEMPOTENCY_KEY"); try { const result = await service.retry(retryMatch[1], idempotencyKey); return ok(result, result.duplicate ? 200 : 202); } catch (error) { return fail(error instanceof Error ? error.message : "IMAGE_EDIT_RETRY_FAILED", 409); } }
      const regenerateMatch = path.match(/^\/api\/image-editor\/tasks\/([^/]+)\/regenerate$/);
      if (method === "POST" && regenerateMatch) {
        if (!idempotencyKey) return fail("MISSING_IDEMPOTENCY_KEY");
        try {
          const result = await service.regenerate({ childTaskId: regenerateMatch[1], idempotencyKey });
          return ok(result, result.duplicate ? 200 : 202);
        } catch (error) { return fail(error instanceof Error ? error.message : "IMAGE_EDIT_REGENERATE_FAILED", 409); }
      }
      const selectMatch = path.match(/^\/api\/image-editor\/tasks\/([^/]+)\/versions\/([^/]+)\/select$/);
      if (method === "POST" && selectMatch) { const selection = body.selection === "final" ? "final" : body.selection === "current" ? "current" : null; if (!selection) return fail("INVALID_VERSION_SELECTION"); try { const version = await service.selectVersion(selectMatch[1], selectMatch[2], selection); return version ? ok(version) : fail("INVALID_IMAGE_EDIT_VERSION", 404); } catch (error) { return fail(error instanceof Error ? error.message : "VERSION_NOT_ELIGIBLE_FOR_FINAL", 409); } }
      return fail("NOT_FOUND", 404);
    },
    clearFinalVersions(childTaskIds: string[]) {
      return service.clearFinalVersions(childTaskIds);
    },
    setOnVersionCompleted(listener: (childTask: ImageEditChildTask) => Promise<void>) {
      service.setOnVersionCompleted(listener);
    },
  };
}
