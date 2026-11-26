import { decodeParam, type Router } from "../http/router.js";
import { fail } from "../api-errors.js";
import { ok, asRecord } from "../api-response.js";
import { PROMPT_STAGES, withPromptTemplateUsage, type PromptStage, type PromptVersionStatus } from "../prompt-library.js";
import { failObservation, finishObservation, startTool } from "../observability.js";
import type { StudioServices } from "../services/studio-services.js";

export function registerPromptRoutes(router: Router, { deps }: StudioServices) {
  router.get("/api/prompt-templates/:versionId/versions", async ({ params }) => {
    if (!deps.promptRepository) return fail("PROMPT_REPOSITORY_NOT_CONFIGURED", 503);
    const versions = await deps.promptRepository.listVersions(params.versionId);
    return ok(versions.map((version) => withPromptTemplateUsage(version)));
  });

  router.get("/api/prompt-templates/:versionId", async ({ params }) => {
    if (!deps.promptRepository) return fail("PROMPT_REPOSITORY_NOT_CONFIGURED", 503);
    const versionId = decodeParam(params.versionId);
    if (!versionId) return fail("PROMPT_TEMPLATE_NOT_FOUND", 404);
    const version = await deps.promptRepository.getVersion(versionId);
    if (!version) return fail("PROMPT_TEMPLATE_NOT_FOUND", 404);
    return ok(withPromptTemplateUsage(version));
  });

  router.patch("/api/prompt-templates/:versionId", async ({ params, body: requestBody }) => {
    if (!deps.promptRepository) return fail("PROMPT_REPOSITORY_NOT_CONFIGURED", 503);
    const body = asRecord(requestBody, { allowArrays: true });
    const updated = await deps.promptRepository.updateDraft(params.versionId, {
      name: typeof body.name === "string" ? body.name : undefined,
      body: typeof body.body === "string" ? body.body : undefined,
      userPromptTemplate: typeof body.userPromptTemplate === "string" ? body.userPromptTemplate : undefined,
      inputSchema: Array.isArray(body.inputSchema) ? body.inputSchema as never : undefined,
      outputSchema: body.outputSchema && typeof body.outputSchema === "object" ? body.outputSchema as Record<string, unknown> : undefined,
      applicability: body.applicability && typeof body.applicability === "object" ? body.applicability as Record<string, unknown> : undefined,
    });
    return updated ? ok(withPromptTemplateUsage(updated)) : fail("PROMPT_DRAFT_NOT_FOUND", 404);
  });

  router.post("/api/prompt-templates/:versionId/copy", async ({ params }) => {
    if (!deps.promptRepository) return fail("PROMPT_REPOSITORY_NOT_CONFIGURED", 503);
    const copied = await deps.promptRepository.copyVersion(params.versionId);
    return copied ? ok(withPromptTemplateUsage(copied), 201) : fail("PROMPT_TEMPLATE_NOT_FOUND", 404);
  });

  router.post("/api/prompt-templates/:versionId/publish", async ({ params }) => {
    if (!deps.promptRepository) return fail("PROMPT_REPOSITORY_NOT_CONFIGURED", 503);
    const published = await deps.promptRepository.publishVersion(params.versionId);
    return published ? ok(withPromptTemplateUsage(published)) : fail("PROMPT_TEMPLATE_NOT_FOUND", 404);
  });

  router.post("/api/prompt-templates/:versionId/retire", async ({ params }) => {
    if (!deps.promptRepository) return fail("PROMPT_REPOSITORY_NOT_CONFIGURED", 503);
    const retired = await deps.promptRepository.retireVersion(params.versionId);
    return retired ? ok(withPromptTemplateUsage(retired)) : fail("PROMPT_TEMPLATE_NOT_FOUND", 404);
  });

  router.get("/api/prompt-templates/:versionId/copy", async ({ params, query }) => {
    if (!deps.promptRepository) return fail("PROMPT_REPOSITORY_NOT_CONFIGURED", 503);

    const stageValue = query.get("stage") ?? undefined;
    if (stageValue && !PROMPT_STAGES.includes(stageValue as PromptStage)) return fail("INVALID_PROMPT_STAGE");
    const template = await deps.promptRepository.getPublishedVersion(params.versionId, stageValue as PromptStage | undefined);
    if (!template) return fail("PROMPT_TEMPLATE_NOT_FOUND", 404);
    return ok(withPromptTemplateUsage({ templateId: template.templateId, templateVersionId: template.templateVersionId, versionNo: template.versionNo, code: template.code, name: template.name, kind: template.kind, stage: template.stage, executionTarget: template.executionTarget, inputSchema: template.inputSchema, applicability: template.applicability, body: template.body, userPromptTemplate: template.userPromptTemplate }));
  });

  router.get("/api/prompt-templates", async ({ query }) => {
    if (!deps.promptRepository) return ok([]);

    const stageValue = query.get("stage") ?? undefined;
    if (stageValue && !PROMPT_STAGES.includes(stageValue as PromptStage)) return fail("INVALID_PROMPT_STAGE");
    const statusValue = query.get("status") ?? "published";
    if (!["published", "draft", "retired", "all"].includes(statusValue)) return fail("INVALID_PROMPT_STATUS");
    const listed = statusValue === "published"
      ? await deps.promptRepository.listPublished(stageValue as PromptStage | undefined)
      : deps.promptRepository.listTemplates
        ? await deps.promptRepository.listTemplates({ stage: stageValue as PromptStage | undefined, status: statusValue as PromptVersionStatus | "all" })
        : await deps.promptRepository.listPublished(stageValue as PromptStage | undefined);
    return ok(listed.map((item) => withPromptTemplateUsage(item)));
  });

  router.get("/api/platforms", async () => ok(deps.platformRepository ? await deps.platformRepository.listEnabled() : []));

  router.post("/api/rag/chunks/search", async ({ body: requestBody }) => {
    if (!deps.ragClient) return fail("RAG_NOT_CONFIGURED", 503);
    const body = asRecord(requestBody, { allowArrays: true });
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
  });
}
