import { parseProviderJson } from "./provider-json.js";
import type { ModelChannelSnapshot } from "../../shared/model-settings.js";
import { randomUUID } from "node:crypto";
import type { CategoryPromptLlmInput, LlmClient, PlanLlmInput, ReplicaPromptLlmInput } from "../types.js";
import { failModelArchive, finishModelArchive, startModelArchive } from "../prompt-archive.js";
import { failObservation, finishObservation, logObservation, recordModelFailure, recordModelSuccess, startGeneration } from "../observability.js";

type VisionContent = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

const DEFAULT_REPLICA_USER_PROMPT_TEMPLATE = [
  "复刻模式：{{cloneLevel}}",
  "复刻类型（sceneType）：{{sceneType}}",
  "输出语言（language）：{{language}}",
  "输出风格保持一致（styleUnified）：{{styleUnified}}",
  "是否提供产品原图（hasProductImages）：{{hasProductImages}}",
  "统一复刻要求（unifiedRequirement）：{{unifiedRequirement}}",
  "商品信息（productInfo）：{{productInfo}}",
  "参考图列表（按 ordinal 排序，对应下方前 N 张图片）：{{references}}",
  "产品原图列表（按 ordinal 排序，对应下方后 M 张图片）：{{productImages}}",
  "",
  "请分析全部输入图片与配置，严格输出符合 replica-prompt-v1 的唯一 JSON 对象。",
].join("\n");

export function buildReplicaPromptUserContent(input: ReplicaPromptLlmInput): VisionContent[] {
  const orderedReferences = [...input.references].sort((a, b) => a.ordinal - b.ordinal);
  const orderedProducts = [...input.productImages].sort((a, b) => a.ordinal - b.ordinal);
  const referencesSummary = orderedReferences.map((ref, index) => ({
    imageIndex: index + 1,
    referenceId: ref.referenceId,
    ordinal: ref.ordinal,
    requirement: ref.requirement?.trim() ?? "",
  }));
  const productSummary = orderedProducts.map((product, index) => ({
    imageIndex: orderedReferences.length + index + 1,
    id: product.id,
    ordinal: product.ordinal,
  }));
  const text = (input.template.userPromptTemplate?.trim() || DEFAULT_REPLICA_USER_PROMPT_TEMPLATE)
    .replaceAll("{{cloneLevel}}", input.cloneLevel)
    .replaceAll("{{sceneType}}", input.sceneType)
    .replaceAll("{{language}}", input.language)
    .replaceAll("{{styleUnified}}", String(input.styleUnified))
    .replaceAll("{{hasProductImages}}", String(orderedProducts.length > 0))
    .replaceAll("{{unifiedRequirement}}", input.unifiedRequirement?.trim() || "无")
    .replaceAll("{{productInfo}}", input.productInfo?.trim() || "无")
    .replaceAll("{{references}}", JSON.stringify(referencesSummary))
    .replaceAll("{{productImages}}", JSON.stringify(productSummary));
  return [
    { type: "text", text },
    ...orderedReferences.map((image) => ({ type: "image_url" as const, image_url: { url: `data:${image.mimeType};base64,${image.bytes.toString("base64")}` } })),
    ...orderedProducts.map((image) => ({ type: "image_url" as const, image_url: { url: `data:${image.mimeType};base64,${image.bytes.toString("base64")}` } })),
  ];
}

const mainImageBackgroundRequirements = {
  pure_white_required: "主图必须使用纯白背景（RGB 255,255,255），不添加文字、Logo、水印或装饰。",
  white_preferred: "主图优先白底或干净浅色背景。",
  flexible: "主图按平台策略选择背景，可用场景背景。",
};

export function buildPlanUserContent(input: PlanLlmInput): VisionContent[] {
  const user = {
    dynamicInput: input.dynamicInput,
    humanInput: input.humanInput,
    selectedChunks: input.chunks.map((chunk) => ({ id: chunk.id, version: chunk.version, title: chunk.title, content: chunk.content, fieldValues: chunk.fieldValues })),
    inputImages: input.inputImageIds,
    baseImages: input.baseVersionIds,
    visualReferences: (input.visionImages ?? []).map((image) => ({ id: image.id, sourceKind: image.sourceKind, sourceVersionId: image.sourceVersionId, mimeType: image.mimeType })),
  };
  const renderedUserPrompt = (input.userPromptTemplate?.trim() || "{{dynamic_input}}\n{{selected_chunks}}\n{{input_images}}\n{{base_images}}\n{{visual_references}}")
    .replaceAll("{{dynamic_input}}", JSON.stringify(input.dynamicInput))
    .replaceAll("{{human_input}}", JSON.stringify(input.humanInput))
    .replaceAll("{{selected_chunks}}", JSON.stringify(user.selectedChunks))
    .replaceAll("{{input_images}}", JSON.stringify(input.inputImageIds))
    .replaceAll("{{base_images}}", JSON.stringify(input.baseVersionIds))
    .replaceAll("{{visual_references}}", JSON.stringify(user.visualReferences));
  const platformRules = input.platformProfile ? [
    "平台适配规则（来自平台维护表，优先于泛化平台假设）：",
    `- 平台：${input.platformProfile.name}`,
    `- 主图背景要求：${input.platformProfile.mainImageBackground}（${mainImageBackgroundRequirements[input.platformProfile.mainImageBackground]}）`,
    `- 主图策略：${input.platformProfile.mainImageStrategy}`,
    `- 主图组策略：${input.platformProfile.galleryStrategy}`,
    `- 文字策略：${input.platformProfile.textStrategy}`,
    `- 模特策略：${input.platformProfile.modelStrategy}`,
  ].join("\n") : "";
  const text = platformRules ? `${renderedUserPrompt}\n\n${platformRules}` : renderedUserPrompt;
  return [
    { type: "text", text },
    ...(input.visionImages ?? []).map((image) => ({ type: "image_url" as const, image_url: { url: `data:${image.mimeType};base64,${image.bytes.toString("base64")}` } })),
  ];
}

export class DashScopeLlmClient implements LlmClient {
  readonly provider: string;
  readonly isFake = false;
  constructor(private readonly baseUrl: string, private readonly apiKey: string, readonly model: string, private readonly timeoutMs = 600_000, readonly channel?: ModelChannelSnapshot) {
    this.provider = channel ? "openai-compatible" : "dashscope";
  }
  async generatePlan(input: PlanLlmInput): Promise<unknown> {
    const startedAt = Date.now();
    const flow = input.flow ?? "plan";
    const requestId = input.requestId ?? randomUUID();
    const observation = startGeneration(`llm.${flow}`, {
      system: input.templateBody,
      user: buildPlanUserContent(input).filter((item) => item.type === "text"),
    }, { flow, provider: this.provider, model: this.model, template_version_id: input.templateVersionId, request_id: requestId });
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const system = input.templateBody;
    const userContent = buildPlanUserContent(input);
    const userPrompt = userContent[0].type === "text" ? userContent[0].text : "";
    const archive = await startModelArchive({
      type: flow === "listing-copy" ? "multimodal-listing-copy" : input.flow === "category-prompt" ? "multimodal-category-prompt" : "multimodal-plan",
      flow,
      requestId,
      provider: this.provider,
      model: this.model,
      request: {
        endpoint: new URL("chat/completions", this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`).toString(),
        templateVersionId: input.templateVersionId,
        body: { model: this.model, temperature: 0, response_format: { type: "json_object" }, messages: [
          { role: "system", content: system },
          { role: "user", content: [{ type: "text", text: userPrompt }, ...(input.visionImages ?? []).map((image, index) => ({ type: "image_url", image_url: { url: `[archive-input-${index + 1}:${image.id}:${image.sourceKind}]` } }))] },
        ] },
      },
      inputFiles: (input.visionImages ?? []).map((image) => ({ label: `${image.id}-${image.sourceKind}`, mimeType: image.mimeType, bytes: image.bytes })),
    });
    let archived = false;
    try {
      const response = await fetch(new URL("chat/completions", this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`), {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, temperature: 0, response_format: { type: "json_object" }, messages: [
          { role: "system", content: system },
          { role: "user", content: userContent },
        ] }),
      });
      if (!response.ok) {
        const error = new Error(`LLM_HTTP_${response.status}`);
        await failModelArchive(archive, error, { httpStatus: response.status });
        archived = true;
        throw error;
      }
      let payload: { choices?: Array<{ message?: { content?: string } }>; [key: string]: unknown };
      try { payload = parseProviderJson(await response.text(), this.apiKey, "LLM_INVALID_HTTP_RESPONSE") as typeof payload; }
      catch {
        const error = new Error("LLM_INVALID_HTTP_RESPONSE");
        await failModelArchive(archive, error, { httpStatus: response.status });
        archived = true;
        throw error;
      }
      const content = payload.choices?.[0]?.message?.content;
      if (!content) {
        const error = new Error("LLM_EMPTY_RESPONSE");
        await failModelArchive(archive, error, { httpStatus: response.status, payload });
        archived = true;
        throw error;
      }
      let parsed: unknown;
      try { parsed = parseProviderJson(content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""), this.apiKey, "LLM_INVALID_JSON_RESPONSE"); }
      catch {
        const error = new Error("LLM_INVALID_JSON_RESPONSE");
        await failModelArchive(archive, error, { httpStatus: response.status });
        archived = true;
        throw error;
      }
      await finishModelArchive(archive, { httpStatus: response.status, payload, content, parsed });
      const usage = payload.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
      finishObservation(observation, { content: captureText(content), status: "succeeded" }, { http_status: response.status });
      recordModelSuccess(flow, this.provider, this.model, Date.now() - startedAt, { input: usage?.prompt_tokens, output: usage?.completion_tokens });
      logObservation("model.completed", { request_id: requestId, flow, provider: this.provider, model: this.model, duration_ms: Date.now() - startedAt, status: "success" });
      archived = true;
      return parsed;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        const timeoutError = new Error("LLM_TIMEOUT");
        if (!archived) await failModelArchive(archive, timeoutError);
        failObservation(observation, timeoutError);
        recordModelFailure(flow, this.provider, this.model, Date.now() - startedAt, timeoutError.message);
        logObservation("model.failed", { request_id: requestId, flow, provider: this.provider, model: this.model, duration_ms: Date.now() - startedAt, status: "error", error_code: timeoutError.message });
        throw timeoutError;
      }
      if (!archived) await failModelArchive(archive, error);
      failObservation(observation, error);
      recordModelFailure(flow, this.provider, this.model, Date.now() - startedAt, error instanceof Error ? error.message : "LLM_FAILED");
      logObservation("model.failed", { request_id: requestId, flow, provider: this.provider, model: this.model, duration_ms: Date.now() - startedAt, status: "error", error_code: error instanceof Error ? error.message : "LLM_FAILED" });
      throw error;
    } finally { clearTimeout(timer); }
  }

  async generateCategoryPrompt(input: CategoryPromptLlmInput): Promise<unknown> {
    return this.generatePlan({
      ...input,
      flow: "category-prompt",
      dynamicInput: {
        ...input.dynamicInput,
        category_code: input.categoryCode,
        requested_count: input.requestedCount,
        approved_fact_refs: input.approvedFactRefs,
      },
    });
  }

  async generateReplicaPrompts(input: ReplicaPromptLlmInput): Promise<unknown> {
    const startedAt = Date.now();
    const flow = "replica-prompt";
    const requestId = input.requestId ?? randomUUID();
    const orderedReferences = [...input.references].sort((a, b) => a.ordinal - b.ordinal);
    const orderedProducts = [...input.productImages].sort((a, b) => a.ordinal - b.ordinal);
    const orderedImages = [
      ...orderedReferences.map((image) => ({ id: image.referenceId, role: "reference" as const, ordinal: image.ordinal, mimeType: image.mimeType, bytes: image.bytes })),
      ...orderedProducts.map((image) => ({ id: image.id, role: "product" as const, ordinal: image.ordinal, mimeType: image.mimeType, bytes: image.bytes })),
    ];
    const system = input.template.body;
    const userContent = buildReplicaPromptUserContent(input);
    const userPrompt = userContent[0].type === "text" ? userContent[0].text : "";
    const observation = startGeneration(`llm.${flow}`, {
      system,
      user: userPrompt,
      images: orderedImages.map(({ id, role, ordinal, mimeType, bytes }) => ({ id, role, ordinal, mimeType, byteLength: bytes.length })),
    }, { flow, provider: this.provider, model: this.model, template_version_id: input.template.templateVersionId, request_id: requestId });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const endpoint = new URL("chat/completions", this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`).toString();
    const archive = await startModelArchive({
      type: "multimodal-replica-prompt",
      flow,
      requestId,
      provider: this.provider,
      model: this.model,
      request: {
        endpoint,
        templateVersionId: input.template.templateVersionId,
        body: {
          model: this.model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: [{ type: "text", text: userPrompt }, ...orderedImages.map((image, index) => ({ type: "image_url", image_url: { url: `[archive-input-${index + 1}:${image.role}:${image.ordinal}:${image.id}]` } }))] },
          ],
        },
      },
      inputFiles: orderedImages.map((image) => ({ label: `${image.role}-${image.ordinal}-${image.id}`, mimeType: image.mimeType, bytes: image.bytes })),
    });
    let archived = false;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: userContent },
          ],
        }),
      });
      if (!response.ok) {
        const error = new Error(`LLM_HTTP_${response.status}`);
        await failModelArchive(archive, error, { httpStatus: response.status });
        archived = true;
        throw error;
      }
      let payload: { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }; [key: string]: unknown };
      try {
        payload = parseProviderJson(await response.text(), this.apiKey, "LLM_INVALID_HTTP_RESPONSE") as typeof payload;
      } catch {
        const error = new Error("LLM_INVALID_HTTP_RESPONSE");
        await failModelArchive(archive, error, { httpStatus: response.status });
        archived = true;
        throw error;
      }
      const content = payload.choices?.[0]?.message?.content;
      if (!content) {
        const error = new Error("LLM_EMPTY_RESPONSE");
        await failModelArchive(archive, error, { httpStatus: response.status, payload });
        archived = true;
        throw error;
      }
      let parsed: unknown;
      try {
        parsed = parseProviderJson(content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""), this.apiKey, "LLM_INVALID_JSON_RESPONSE");
      } catch {
        const error = new Error("LLM_INVALID_JSON_RESPONSE");
        await failModelArchive(archive, error, { httpStatus: response.status });
        archived = true;
        throw error;
      }
      await finishModelArchive(archive, { httpStatus: response.status, payload, content, parsed });
      finishObservation(observation, { content: captureText(content), status: "succeeded" }, { http_status: response.status });
      recordModelSuccess(flow, this.provider, this.model, Date.now() - startedAt, { input: payload.usage?.prompt_tokens, output: payload.usage?.completion_tokens });
      logObservation("model.completed", { request_id: requestId, flow, provider: this.provider, model: this.model, duration_ms: Date.now() - startedAt, status: "success" });
      archived = true;
      return parsed;
    } catch (error) {
      const normalized = error instanceof DOMException && error.name === "AbortError" ? new Error("LLM_TIMEOUT") : error;
      if (!archived) await failModelArchive(archive, normalized);
      failObservation(observation, normalized);
      recordModelFailure(flow, this.provider, this.model, Date.now() - startedAt, normalized instanceof Error ? normalized.message : "LLM_FAILED");
      logObservation("model.failed", { request_id: requestId, flow, provider: this.provider, model: this.model, duration_ms: Date.now() - startedAt, status: "error", error_code: normalized instanceof Error ? normalized.message : "LLM_FAILED" });
      throw normalized;
    } finally {
      clearTimeout(timer);
    }
  }

  async translateTexts(input: { targetLanguage: string; items: Array<{ id: string; text: string }>; preserveBrandTerms?: boolean }): Promise<Array<{ id: string; originalText: string; translatedText: string }>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 120_000));
    const startedAt = Date.now();
    const systemPrompt = [
      "你是专业跨境电商视觉本地化翻译专家。",
      `请将输入 JSON 数组中的商品图片文案逐条翻译为地道、简洁、符合电商主图/详情页排版习惯的【${input.targetLanguage}】。`,
      "规则：",
      "1. 严格保留数字、尺寸单位（mm/cm/g/W/mAh/V 等）、型号编码与认证缩写。",
      input.preserveBrandTerms !== false ? "2. 专有品牌名与英文商标保持原样不强行意译。" : "2. 可按目标市场习惯本地化表达。",
      "3. 保持精炼短句风格，避免破坏原图排版长度。",
      '4. 仅返回严格 JSON 对象：{"translations":[{"id":"原id","translatedText":"译文"}]}，禁止任何额外说明。',
    ].join("\n");
    const observation = startGeneration("llm.image-translate", { system: systemPrompt, items: input.items, targetLanguage: input.targetLanguage }, { flow: "image-translate", provider: this.provider, model: this.model });
    try {
      const response = await fetch(new URL("chat/completions", this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`), {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.1,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: JSON.stringify({ targetLanguage: input.targetLanguage, items: input.items }) },
          ],
        }),
      });
      const rawBody = await response.text();
      if (!response.ok) throw new Error(`LLM_HTTP_${response.status}`);
      const payload = parseProviderJson(rawBody, this.apiKey, "LLM_INVALID_HTTP_RESPONSE") as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      const content = payload.choices?.[0]?.message?.content;
      if (!content) throw new Error("LLM_EMPTY_RESPONSE");
      const parsed = parseProviderJson(content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""), this.apiKey, "LLM_INVALID_JSON_RESPONSE") as { translations?: Array<{ id?: unknown; translatedText?: unknown }> };
      const byId = new Map((parsed.translations ?? []).map((row) => [String(row.id ?? ""), String(row.translatedText ?? "").trim()]));
      const result = input.items.map((item) => ({
        id: item.id,
        originalText: item.text,
        translatedText: byId.get(item.id) || item.text,
      }));
      finishObservation(observation, { status: "succeeded", count: result.length }, { http_status: response.status });
      recordModelSuccess("image-translate", this.provider, this.model, Date.now() - startedAt, { input: payload.usage?.prompt_tokens, output: payload.usage?.completion_tokens });
      return result;
    } catch (error) {
      const normalized = error instanceof DOMException && error.name === "AbortError" ? new Error("LLM_TIMEOUT") : error;
      failObservation(observation, normalized);
      recordModelFailure("image-translate", this.provider, this.model, Date.now() - startedAt, normalized instanceof Error ? normalized.message : "LLM_FAILED");
      throw normalized;
    } finally {
      clearTimeout(timer);
    }
  }
}

function captureText(content: string): string | { captured: false } {
  return process.env.OBSERVABILITY_CAPTURE_CONTENT?.trim().toLowerCase() === "true" ? content : { captured: false };
}
