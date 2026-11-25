import {
  emptyProductCardFields,
  getMissingRequiredProductCardFields,
  PRODUCT_CARD_ALL_FIELDS,
  PRODUCT_CARD_FIELD_LABELS,
  PRODUCT_CARD_FIELD_LIMITS,
  PRODUCT_CARD_NO_EXTRA_ACCESSORIES_TEXT,
  PRODUCT_CARD_REQUIRED_FIELDS,
  type ProductCardFieldKey,
  type ProductCardFields,
  type ProductCardRequiredField,
} from "../../shared/product-card.js";
import { PRODUCT_ONBOARDING_DEFAULT_TITLE } from "../../shared/product-onboarding.js";
import type { PromptTemplateRuntime } from "../prompt-library.js";
import type {
  LlmClient,
  ProductOnboardingLlmHistoryItem,
  ProductOnboardingLlmImage,
  ProductOnboardingLlmInput,
  PromptRepository,
} from "../types.js";

export const PRODUCT_ONBOARDING_SCHEMA_VERSION = "product-onboarding-v1" as const;
export const PRODUCT_ONBOARDING_TEMPLATE_CODE = "product.onboarding" as const;

export interface ProductOnboardingLlmOutput {
  schemaVersion: typeof PRODUCT_ONBOARDING_SCHEMA_VERSION;
  reply: string;
  draftCard: ProductCardFields;
  missingRequiredFields: ProductCardRequiredField[];
}

export class ProductOnboardingPromptError extends Error {
  readonly code: string;
  readonly details: string[];

  constructor(code: string, details: string[] = []) {
    super(details.length > 0 ? `${code}: ${details.join("；")}` : code);
    this.name = "ProductOnboardingPromptError";
    this.code = code;
    this.details = details;
  }
}

const PLACEHOLDER_VALUES = new Set([
  "暂无",
  "待定",
  "未知",
  "未提供",
  "无信息",
  "待补充",
  "待确认",
  "未填写",
  "n/a",
  "na",
  "none",
  "null",
  "unknown",
  "tbd",
  "-",
  "--",
]);

const NO_ACCESSORIES_PATTERN =
  /(?:无额外配件|没有额外配件|无配件|没有配件|无任何配件|不带配件|不含配件|无赠品配件|没有赠品|仅单品|只有单品|只有本体|仅本体|单品本体\s*[×xX*]\s*1)/i;

const EXPLICIT_NO_ACCESSORIES_VALUE_PATTERN =
  /^(?:无|无配件|没有配件|无额外配件|没有额外配件|无赠品|无赠品配件|仅本体|只有本体|仅单品|单品无配件|单品本体(?:\s*[×xX*]\s*1)?(?:[，,、\s]*(?:无额外配件|无配件|没有配件|无赠品))?)$/i;

const CORRECTION_CUE_PATTERN =
  /(?:改成|改为|修改|更正|纠正|更新|换成|调整|重写|替换|覆盖|其实是|其实|不是|应为|应该是|变更为)/;

const FIELD_KEYWORDS: Record<ProductCardFieldKey, RegExp> = {
  name: /(?:商品名|商品名称|产品名|品名|名称|标题)/,
  sellingPoints: /(?:卖点|核心卖点|特点|亮点)/,
  specifications: /(?:规格|参数|尺寸|重量|容量|功率|大小|尺码|克重|长宽|型号)/,
  materialsCraft: /(?:材质|材料|面料|工艺|做工|表面处理|成分)/,
  audienceScenarios: /(?:人群|受众|场景|用途|适用|场合)/,
  packageContents: /(?:包装|清单|配件|赠品|内含|附件|箱内|单品)/,
  painPointsComparison: /(?:痛点|对比|升级|区别|差异)/,
  usageDemoHighlights: /(?:使用|用法|操作|演示|步骤|保养|维护)/,
  certificationsProhibitions: /(?:认证|资质|禁忌|禁语|合规|fcc|ce|fda|rohs)/i,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function truncateChars(value: string, maxLength: number): string {
  const chars = Array.from(value);
  return chars.length <= maxLength ? value : chars.slice(0, maxLength).join("");
}

function cleanExtractedText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (PLACEHOLDER_VALUES.has(trimmed.toLowerCase())) return "";
  return truncateChars(trimmed, maxLength);
}

function cleanExtractedSellingPoints(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const limit = PRODUCT_CARD_FIELD_LIMITS.sellingPoints;
  const seen = new Set<string>();
  const points: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const cleaned = cleanExtractedText(item, limit.itemMax);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    points.push(cleaned);
    if (points.length >= limit.maxItems) break;
  }
  return points;
}

export async function resolveProductOnboardingTemplate(
  prompts: PromptRepository,
): Promise<PromptTemplateRuntime | null> {
  const published = await prompts.listPublished("product_onboarding");
  const matched =
    published.find((item) => item.code === PRODUCT_ONBOARDING_TEMPLATE_CODE) ??
    published[0];
  if (!matched) return null;
  return prompts.getPublishedVersion(matched.templateVersionId, "product_onboarding");
}

export function normalizeDraftCardFields(input: unknown): ProductCardFields {
  const result = emptyProductCardFields();
  if (!isPlainObject(input)) return result;

  result.name = cleanExtractedText(input.name, PRODUCT_CARD_FIELD_LIMITS.name.max);
  result.sellingPoints = cleanExtractedSellingPoints(input.sellingPoints);
  result.specifications = cleanExtractedText(
    input.specifications,
    PRODUCT_CARD_FIELD_LIMITS.specifications.max,
  );
  result.materialsCraft = cleanExtractedText(
    input.materialsCraft,
    PRODUCT_CARD_FIELD_LIMITS.materialsCraft.max,
  );
  result.audienceScenarios = cleanExtractedText(
    input.audienceScenarios,
    PRODUCT_CARD_FIELD_LIMITS.audienceScenarios.max,
  );
  result.packageContents = cleanExtractedText(
    input.packageContents,
    PRODUCT_CARD_FIELD_LIMITS.packageContents.max,
  );
  result.painPointsComparison = cleanExtractedText(
    input.painPointsComparison,
    PRODUCT_CARD_FIELD_LIMITS.painPointsComparison.max,
  );
  result.usageDemoHighlights = cleanExtractedText(
    input.usageDemoHighlights,
    PRODUCT_CARD_FIELD_LIMITS.usageDemoHighlights.max,
  );
  result.certificationsProhibitions = cleanExtractedText(
    input.certificationsProhibitions,
    PRODUCT_CARD_FIELD_LIMITS.certificationsProhibitions.max,
  );
  return result;
}

export function normalizePackageContentsNoAccessories(
  value: string,
  latestTurnText: string,
): string {
  const trimmed = value.trim();
  if (trimmed && EXPLICIT_NO_ACCESSORIES_VALUE_PATTERN.test(trimmed)) {
    return PRODUCT_CARD_NO_EXTRA_ACCESSORIES_TEXT;
  }
  if (!trimmed && NO_ACCESSORIES_PATTERN.test(latestTurnText)) {
    return PRODUCT_CARD_NO_EXTRA_ACCESSORIES_TEXT;
  }
  return trimmed;
}

function extractSalientTokens(value: string): string[] {
  const matches = value.match(/[a-zA-Z0-9._+-]{2,}|[\u4e00-\u9fff]{2,}/g) ?? [];
  const tokens: string[] = [];
  for (const token of matches) {
    const lower = token.toLowerCase();
    if (lower.length >= 2) tokens.push(lower);
    if (/^[\u4e00-\u9fff]{4,}$/.test(token)) {
      for (let i = 0; i <= token.length - 2; i += 2) {
        tokens.push(token.slice(i, i + 2).toLowerCase());
      }
    }
  }
  return [...new Set(tokens)];
}

function latestTurnSupportsFieldUpdate(
  key: ProductCardFieldKey,
  currentValue: string,
  nextValue: string,
  latestTurnText: string,
): boolean {
  const normalizedTurn = latestTurnText.trim();
  if (!normalizedTurn) return false;
  const lowerTurn = normalizedTurn.toLowerCase();

  if (CORRECTION_CUE_PATTERN.test(normalizedTurn) && FIELD_KEYWORDS[key].test(normalizedTurn)) {
    return true;
  }

  const currentTokens = new Set(extractSalientTokens(currentValue));
  const novelTokens = extractSalientTokens(nextValue).filter((token) => !currentTokens.has(token));
  if (novelTokens.some((token) => lowerTurn.includes(token))) {
    return true;
  }

  if (
    nextValue.includes(currentValue) &&
    FIELD_KEYWORDS[key].test(normalizedTurn)
  ) {
    return true;
  }

  return false;
}

export function mergeOnboardingDraftCard(
  currentDraft: ProductCardFields,
  modelDraft: ProductCardFields,
  context: { latestTurnText: string; hasNewImages: boolean },
): ProductCardFields {
  const merged = emptyProductCardFields();

  for (const key of PRODUCT_CARD_ALL_FIELDS) {
    if (key === "sellingPoints") {
      const currentPoints = currentDraft.sellingPoints.map((item) => item.trim()).filter(Boolean);
      const nextPoints = modelDraft.sellingPoints.map((item) => item.trim()).filter(Boolean);

      if (currentPoints.length === 0) {
        merged.sellingPoints = nextPoints.slice(0, PRODUCT_CARD_FIELD_LIMITS.sellingPoints.maxItems);
        continue;
      }
      if (nextPoints.length === 0) {
        merged.sellingPoints = [...currentPoints];
        continue;
      }

      const lowerTurn = context.latestTurnText.toLowerCase();
      const explicitReplace =
        CORRECTION_CUE_PATTERN.test(context.latestTurnText) &&
        FIELD_KEYWORDS.sellingPoints.test(context.latestTurnText);
      if (explicitReplace) {
        merged.sellingPoints = nextPoints.slice(0, PRODUCT_CARD_FIELD_LIMITS.sellingPoints.maxItems);
        continue;
      }

      const combined = [...currentPoints];
      const existingLower = new Set(currentPoints.map((item) => item.toLowerCase()));
      const currentTokens = new Set(currentPoints.flatMap(extractSalientTokens));
      for (const candidate of nextPoints) {
        if (existingLower.has(candidate.toLowerCase())) continue;
        const novelTokens = extractSalientTokens(candidate).filter((t) => !currentTokens.has(t));
        const mentionedInTurn =
          lowerTurn.length > 0 && novelTokens.some((token) => lowerTurn.includes(token));
        const supersetWithImages =
          context.hasNewImages &&
          currentPoints.every((existing) =>
            nextPoints.some((item) => item.toLowerCase() === existing.toLowerCase()),
          );
        if (mentionedInTurn || supersetWithImages) {
          combined.push(candidate);
          existingLower.add(candidate.toLowerCase());
          if (combined.length >= PRODUCT_CARD_FIELD_LIMITS.sellingPoints.maxItems) break;
        }
      }
      merged.sellingPoints = combined;
      continue;
    }

    const currentValue = currentDraft[key].trim();
    let nextValue = modelDraft[key].trim();
    if (key === "packageContents") {
      nextValue = normalizePackageContentsNoAccessories(nextValue, context.latestTurnText);
    }

    if (!currentValue) {
      merged[key] = nextValue;
    } else if (!nextValue || nextValue === currentValue) {
      merged[key] = currentValue;
    } else if (
      key === "packageContents" &&
      nextValue === PRODUCT_CARD_NO_EXTRA_ACCESSORIES_TEXT &&
      NO_ACCESSORIES_PATTERN.test(context.latestTurnText)
    ) {
      merged[key] = nextValue;
    } else if (latestTurnSupportsFieldUpdate(key, currentValue, nextValue, context.latestTurnText)) {
      merged[key] = nextValue;
    } else {
      merged[key] = currentValue;
    }
  }

  return merged;
}

export function resolveSessionTitle(
  currentTitle: string,
  previousDraftName: string,
  nextDraftName: string,
  explicitTitle?: string,
): string {
  if (typeof explicitTitle === "string") {
    const trimmed = truncateChars(explicitTitle.trim(), 120);
    if (trimmed) return trimmed;
  }
  const cleanNextName = truncateChars(nextDraftName.trim(), 120);
  const cleanCurrentTitle = currentTitle.trim();
  const cleanPrevName = previousDraftName.trim();
  if (
    cleanNextName &&
    (!cleanCurrentTitle ||
      cleanCurrentTitle === PRODUCT_ONBOARDING_DEFAULT_TITLE ||
      (cleanPrevName && cleanCurrentTitle === cleanPrevName))
  ) {
    return cleanNextName;
  }
  return cleanCurrentTitle || cleanNextName || PRODUCT_ONBOARDING_DEFAULT_TITLE;
}

export function ensureReplyCoversMissingFields(
  reply: string,
  modelMissing: ProductCardRequiredField[],
  authoritativeMissing: ProductCardRequiredField[],
): string {
  const trimmedReply = reply.trim();
  if (authoritativeMissing.length === 0) return trimmedReply;

  const missingLabelsNotInReply = authoritativeMissing.filter((key) => {
    const label = PRODUCT_CARD_FIELD_LABELS[key];
    return !trimmedReply.includes(label) && !trimmedReply.includes(key);
  });

  if (missingLabelsNotInReply.length === 0 && modelMissing.length >= authoritativeMissing.length) {
    return trimmedReply;
  }

  const numbered = authoritativeMissing
    .map((key, index) => `${index + 1}. ${PRODUCT_CARD_FIELD_LABELS[key]}`)
    .join("\n");
  if (missingLabelsNotInReply.length === authoritativeMissing.length || modelMissing.length === 0) {
    return `${trimmedReply}\n\n请一次性补充以下剩余必填项：\n${numbered}`;
  }
  return trimmedReply;
}

export function parseAndValidateProductOnboardingOutput(raw: unknown): ProductOnboardingLlmOutput {
  let candidate: unknown = raw;
  if (typeof candidate === "string") {
    const cleaned = candidate.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    try {
      candidate = JSON.parse(cleaned);
    } catch {
      throw new ProductOnboardingPromptError("PRODUCT_ONBOARDING_OUTPUT_INVALID", [
        "模型输出不是合法 JSON",
      ]);
    }
  }
  if (!isPlainObject(candidate)) {
    throw new ProductOnboardingPromptError("PRODUCT_ONBOARDING_OUTPUT_INVALID", [
      "模型输出必须是 JSON 对象",
    ]);
  }

  const errors: string[] = [];
  if (candidate.schemaVersion !== PRODUCT_ONBOARDING_SCHEMA_VERSION) {
    errors.push(
      `schemaVersion 必须为 "${PRODUCT_ONBOARDING_SCHEMA_VERSION}"，实际收到 ${JSON.stringify(candidate.schemaVersion)}`,
    );
  }

  const reply = typeof candidate.reply === "string" ? candidate.reply.trim() : "";
  if (!reply) {
    errors.push("reply 必须是非空字符串");
  }

  if (!isPlainObject(candidate.draftCard)) {
    errors.push("draftCard 必须是对象");
  }

  const requiredSet = new Set<string>(PRODUCT_CARD_REQUIRED_FIELDS);
  let missingRequiredFields: ProductCardRequiredField[] = [];
  if (candidate.missingRequiredFields !== undefined) {
    if (!Array.isArray(candidate.missingRequiredFields)) {
      errors.push("missingRequiredFields 必须是数组");
    } else {
      const seen = new Set<ProductCardRequiredField>();
      for (const item of candidate.missingRequiredFields) {
        if (typeof item === "string" && requiredSet.has(item)) {
          const typed = item as ProductCardRequiredField;
          if (!seen.has(typed)) {
            seen.add(typed);
            missingRequiredFields.push(typed);
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new ProductOnboardingPromptError("PRODUCT_ONBOARDING_OUTPUT_INVALID", errors);
  }

  const draftCard = normalizeDraftCardFields(candidate.draftCard);
  if (candidate.missingRequiredFields === undefined) {
    missingRequiredFields = getMissingRequiredProductCardFields(draftCard);
  }

  return {
    schemaVersion: PRODUCT_ONBOARDING_SCHEMA_VERSION,
    reply,
    draftCard,
    missingRequiredFields,
  };
}

export async function runProductOnboardingExtraction(params: {
  requestId?: string;
  llm: LlmClient;
  template: Pick<PromptTemplateRuntime, "templateVersionId" | "body" | "userPromptTemplate">;
  currentDraftCard: ProductCardFields;
  missingRequiredFields: ProductCardRequiredField[];
  conversationHistory: ProductOnboardingLlmHistoryItem[];
  latestUserMessage: string;
  txtAttachments: Array<{ filename: string; byteLength: number; charCount: number; content: string }>;
  supplierImages: ProductOnboardingLlmImage[];
  hasNewImages: boolean;
}): Promise<{
  input: ProductOnboardingLlmInput;
  rawOutput: unknown;
  reply: string;
  mergedDraftCard: ProductCardFields;
  authoritativeMissingRequiredFields: ProductCardRequiredField[];
}> {
  if (!params.llm.generateProductOnboarding) {
    throw new ProductOnboardingPromptError("PRODUCT_ONBOARDING_LLM_NOT_SUPPORTED", [
      "当前多模态模型客户端不支持商品建档抽取",
    ]);
  }

  const input: ProductOnboardingLlmInput = {
    ...(params.requestId ? { requestId: params.requestId } : {}),
    template: {
      templateVersionId: params.template.templateVersionId,
      body: params.template.body,
      userPromptTemplate: params.template.userPromptTemplate,
    },
    currentDraftCard: params.currentDraftCard,
    missingRequiredFields: params.missingRequiredFields,
    conversationHistory: params.conversationHistory,
    latestUserMessage: params.latestUserMessage,
    txtAttachments: params.txtAttachments,
    supplierImages: params.supplierImages,
  };

  const rawOutput = await params.llm.generateProductOnboarding(input);
  const parsed = parseAndValidateProductOnboardingOutput(rawOutput);

  const latestTurnText = [
    params.latestUserMessage,
    ...params.txtAttachments.map((file) => file.content),
  ]
    .filter((part) => part.trim().length > 0)
    .join("\n");

  const mergedDraftCard = mergeOnboardingDraftCard(params.currentDraftCard, parsed.draftCard, {
    latestTurnText,
    hasNewImages: params.hasNewImages,
  });
  const authoritativeMissingRequiredFields = getMissingRequiredProductCardFields(mergedDraftCard);
  const reply = ensureReplyCoversMissingFields(
    parsed.reply,
    parsed.missingRequiredFields,
    authoritativeMissingRequiredFields,
  );

  return {
    input,
    rawOutput,
    reply,
    mergedDraftCard,
    authoritativeMissingRequiredFields,
  };
}
