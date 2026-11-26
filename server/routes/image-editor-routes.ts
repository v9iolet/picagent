import { previewStorageObject } from "../http/binary-response.js";
import { hasValidUuids } from "../http/validators.js";
import { fail } from "../api-errors.js";
import { ok, asRecord, dataOf } from "../api-response.js";
import type { Router } from "../http/router.js";
import type { StudioServices } from "../services/studio-services.js";

export function registerImageEditorRoutes(router: Router, { deps, resolveVision }: StudioServices) {
  router.post("/api/image-editor/translate-text", async ({ body: requestBody }) => {
    const body = asRecord(requestBody, { allowArrays: true });
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
  });

  router.get(/^\/api\/image-editor\/tasks\/(?<taskId>[^/]+)\/versions\/(?<versionId>[^/]+)\/preview(?<delivery>\/delivery)?$/, async ({ params }) => {
    const { taskId, versionId, delivery } = params;
    if (!hasValidUuids(taskId, versionId)) return fail("INVALID_TASK_VERSION", 404);
    const api = deps.imageEditorApi;
    if (!api) return fail("IMAGE_EDITOR_NOT_CONFIGURED", 503);
    if (api.getVersion) {
      const version = await api.getVersion(taskId, versionId);
      if (!version) return fail("NOT_FOUND", 404);
      const key = delivery ? version.deliveryObjectKey : version.objectKey;
      if (!key) return fail("NOT_FOUND", 404);
      return previewStorageObject(deps.storage, key, delivery ? {} : { contentType: version.mimeType, missingCode: "NOT_FOUND" });
    }
    // Older injected APIs only expose the task detail endpoint.
    const response = await api.request("GET", "/api/image-editor/tasks/" + taskId);
    const task = dataOf(response) as { versions?: Array<{ id: string; objectKey: string; deliveryObjectKey?: string }> } | null;
    const version = response.status === 200 ? task?.versions?.find((item) => item.id === versionId) : null;
    const key = delivery ? version?.deliveryObjectKey : version?.objectKey;
    return key ? previewStorageObject(deps.storage, key) : fail("NOT_FOUND", 404);
  });

  router.post("/api/image-editor/tasks/:taskId/versions/:versionId/select", async ({ params, pathname, body, headers }) => {
    if (!deps.imageEditorApi) return fail("IMAGE_EDITOR_NOT_CONFIGURED", 503);
    const requestHeaders = Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const response = await deps.imageEditorApi.request("POST", pathname, { body, headers: requestHeaders });
    if (response.status >= 200 && response.status < 300 && asRecord(body, { allowArrays: true }).selection === "final") {
      await deps.libraryRepository?.restoreResource("edit-version:" + params.versionId);
    }
    return response;
  });
}
