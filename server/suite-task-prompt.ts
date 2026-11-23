import { createHash } from "node:crypto";
import { PURE_WHITE_MAIN_IMAGE_REQUIREMENTS } from "../shared/platform-main-background.js";
import type { CategoryPromptItem, CategoryPromptRequest, PlanItem, PlanSnapshot } from "./types.js";

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableValue(item)]));
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function promptSha256(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

function styleText(styleCard: Record<string, unknown>): string {
  if (typeof styleCard.promptPrefix === "string" && styleCard.promptPrefix.trim()) return styleCard.promptPrefix.trim();
  return Object.entries(styleCard).length ? stableJson(styleCard) : "未提供额外风格卡";
}

const STRUCTURED_PROMPT_SECTION_RE = /^(系统安全约束|平台约束|商品事实约束|全局风格卡|当前类别提示词|单卡人工补充)：(.*)$/;

function summarizeHumanSupplement(raw: string, textContent: CategoryPromptItem["textContent"], maxChars = 160): string {
  const texts = [...new Set(textContent.map((entry) => entry.text.trim()).filter(Boolean))];
  if (texts.length > 0) return `本卡确认文案：${texts.join("；")}`;
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const compact = [...new Set(lines)].join("；");
  if (!compact) return "";
  return compact.length > maxChars ? `${compact.slice(0, maxChars - 1)}…` : compact;
}

/** Extracts a concise, positive image-generation prompt from a frozen audit finalPrompt. */
export function buildProviderImagePrompt(
  finalPrompt: string,
  options?: { categoryCode?: string | null; pureWhiteMain?: boolean; vectorSellingPointOverlay?: boolean },
): string {
  const normalized = finalPrompt.replace(/\r\n/g, "\n").trim();
  if (!normalized) return "";

  const isSellingPointCategory =
    options?.categoryCode === "feature_benefit" || options?.categoryCode === "material_detail";
  const stripOverlayDirectives = Boolean(options?.vectorSellingPointOverlay && isSellingPointCategory);
  const sanitizeBody = (text: string) => {
    if (!stripOverlayDirectives) return text;
    return text
      .split("\n")
      .filter((line) => !/^\s*上图渲染文案[（(]?/.test(line))
      .join("\n")
      .trim();
  };

  const lines = normalized.split("\n");
  const hasStructuredSection = lines.some((line) => STRUCTURED_PROMPT_SECTION_RE.test(line.trimStart()));
  const isPureWhiteMain =
    options?.pureWhiteMain === true ||
    (options?.pureWhiteMain !== false &&
      options?.categoryCode === "main" &&
      normalized.includes(PURE_WHITE_MAIN_IMAGE_REQUIREMENTS));

  if (!hasStructuredSection) {
    let result = sanitizeBody(normalized);
    if (isPureWhiteMain && !result.includes(PURE_WHITE_MAIN_IMAGE_REQUIREMENTS)) {
      result = `${PURE_WHITE_MAIN_IMAGE_REQUIREMENTS}\n${result}`;
    }
    if (stripOverlayDirectives) {
      result = `${result}\n留出对应版式文案空白区，画面中不直接生成文字或图标`.trim();
    }
    return result;
  }

  const hasCategorySection = lines.some((line) => /^\s*当前类别提示词：/.test(line));
  const sections: Array<{ label: string | null; lines: string[] }> = [];
  let current: { label: string | null; lines: string[] } | null = null;
  for (const rawLine of lines) {
    const match = rawLine.trimStart().match(STRUCTURED_PROMPT_SECTION_RE);
    if (match) {
      current = { label: match[1], lines: match[2].trim() ? [match[2].trim()] : [] };
      sections.push(current);
    } else if (current) {
      // A style-overridden freehand prompt puts plain text directly after "全局风格卡：..." without "当前类别提示词：".
      if (current.label === "全局风格卡" && !hasCategorySection && rawLine.trim()) {
        current = { label: null, lines: [rawLine.trim()] };
        sections.push(current);
      } else if (rawLine.trim()) {
        current.lines.push(rawLine.trim());
      }
    } else if (rawLine.trim()) {
      current = { label: null, lines: [rawLine.trim()] };
      sections.push(current);
    }
  }

  const output: string[] = [];
  if (isPureWhiteMain) {
    output.push(PURE_WHITE_MAIN_IMAGE_REQUIREMENTS);
  }
  for (const section of sections) {
    const body = sanitizeBody(section.lines.join("\n").trim());
    if (!body) continue;
    switch (section.label) {
      case "系统安全约束":
      case "平台约束":
      case "商品事实约束":
        break;
      case "全局风格卡":
        if (body !== "未提供额外风格卡") output.push(`全局风格卡：${body}`);
        break;
      case "当前类别提示词":
        output.push(body);
        break;
      case "单卡人工补充":
        if (body !== "无") output.push(`单卡人工补充：${body}`);
        break;
      default:
        output.push(body);
        break;
    }
  }
  if (stripOverlayDirectives) {
    output.push("留出对应版式文案空白区，画面中不直接生成文字或图标");
  }
  return output.join("\n").trim() || normalized;
}

/** The order here is part of the image-generation contract. */
export function composeSuiteTaskPrompt(input: {
  globalStyleCard?: Record<string, unknown>;
  categoryPrompt: string;
  platformConstraints?: string;
  factConstraints?: string;
  manualAddition?: string;
}): string {
  const platform = input.platformConstraints?.trim() || "遵守目标平台的图片、文字和商品展示规则。";
  const facts = input.factConstraints?.trim() || "只呈现已确认的商品事实；不得编造尺寸、材质、配件、兼容关系、功效或卖点。";
  const manual = input.manualAddition?.trim() || "无";
  return [
    "系统安全约束：不得生成违法、危险或误导性内容。",
    `平台约束：${platform}`,
    `商品事实约束：${facts}`,
    `全局风格卡：${styleText(input.globalStyleCard ?? {})}`,
    `当前类别提示词：${input.categoryPrompt.trim()}`,
    `单卡人工补充：${manual}`,
  ].join("\n");
}

function expectedCategories(snapshot: PlanSnapshot): Array<{ code: string; count: number }> {
  if (!snapshot.structure) return [];
  const result: Array<{ code: string; count: number }> = [];
  const mainCount = "mainAllocation" in snapshot.structure ? snapshot.structure.mainAllocation.count : snapshot.structure.mainImageCount;
  if (mainCount > 0) result.push({ code: "main", count: mainCount });
  for (const raw of snapshot.structure.categoryAllocations) {
    const row = raw as Record<string, unknown>;
    const count = Number(row.count);
    if (typeof row.category === "string" && Number.isInteger(count) && count > 0) result.push({ code: row.category, count });
  }
  return result;
}

function requestItems(request: CategoryPromptRequest): CategoryPromptItem[] {
  return request.status === "succeeded" && request.items.length === request.requestedCount ? request.items : [];
}

function stablePlanItemId(planSnapshotId: string, categoryCode: string, stableId: string): string {
  const hex = createHash("sha256").update(`${planSnapshotId}:${categoryCode}:${stableId}`).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

function itemKey(item: PlanItem): string {
  return item.id || `${item.categoryCode ?? item.imageType}:${item.title}:${item.purpose}`;
}

/** Converts every currently successful category output into immutable plan items. */
export function materializeCategoryPlanItems(snapshot: PlanSnapshot, requests: CategoryPromptRequest[]): PlanItem[] | null {
  if (snapshot.phase !== "structure_plan" || snapshot.confirmationStatus !== "confirmed" || !snapshot.structure) return null;
  if ("status" in snapshot.structure ? snapshot.structure.status !== "READY_FOR_REVIEW" : !snapshot.structure.canProceed) return null;
  const byCategory = new Map<string, CategoryPromptRequest>();
  for (const request of requests) if (requestItems(request).length) byCategory.set(request.categoryCode, request);
  const expected = expectedCategories(snapshot);
  if (!expected.length) return null;

  const style = snapshot.structure.globalStyleCard;
  const platform = typeof snapshot.dynamicInput.platform_text_rule === "string"
    ? snapshot.dynamicInput.platform_text_rule
    : typeof snapshot.dynamicInput.text_strategy === "string" ? snapshot.dynamicInput.text_strategy : undefined;
  const factsById = new Map(snapshot.chunks.map((chunk) => [chunk.sourceChunkId, chunk]));
  const humanSupplement = [snapshot.dynamicInput.human_supplement, snapshot.dynamicInput.emphasis_requirements]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim())
    .filter((value, index, values) => values.indexOf(value) === index)
    .join("\n");
  const items: PlanItem[] = [...snapshot.items];
  const existingKeys = new Set(items.map(itemKey));
  for (const { code } of expected) {
    const request = byCategory.get(code);
    if (!request || request.requestedCount !== expected.find((entry) => entry.code === code)?.count) continue;
    for (const output of requestItems(request)) {
      const id = stablePlanItemId(request.planSnapshotId, code, output.stableId);
      const key = id;
      if (existingKeys.has(key)) continue;
      const factParts: string[] = [];
      const seenFactParts = new Set<string>();
      for (const ref of output.factRefs) {
        const text = ref === "human_supplement"
          ? summarizeHumanSupplement(
            humanSupplement,
            code !== "main" && output.allowsTextOverlay !== "no" ? output.textContent : [],
          )
          : (factsById.get(ref)?.content ?? "").trim();
        if (text && !seenFactParts.has(text)) {
          seenFactParts.add(text);
          factParts.push(text);
        }
      }
      const factText = factParts.join("\n");
      let categoryPrompt = output.prompt.trim();
      if (code !== "main" && output.allowsTextOverlay !== "no" && output.textContent.length > 0) {
        const missingOverlayTexts = [...new Set(
          output.textContent
            .map((entry) => entry.text.trim())
            .filter((text) => text.length > 0 && !categoryPrompt.includes(text)),
        )];
        if (missingOverlayTexts.length > 0) {
          const quoted = missingOverlayTexts.map((text) => `"${text}"`).join("、");
          categoryPrompt = `${categoryPrompt}\n上图渲染文案（准确呈现）：${quoted}`;
        }
      }
      const pureWhiteMain = code === "main" && snapshot.requestSummary.useOriginalImages === true &&
        snapshot.dynamicInput.main_image_background === "pure_white_required";
      const platformConstraints = pureWhiteMain
        ? [PURE_WHITE_MAIN_IMAGE_REQUIREMENTS + "此要求优先于风格与场景要求。", platform].filter(Boolean).join(" ")
        : platform;
      const prompt = composeSuiteTaskPrompt({ globalStyleCard: style, categoryPrompt, platformConstraints, factConstraints: factText || undefined });
      items.push({
        id, ordinal: items.length + 1, imageType: code === "main" ? "main" : "detail", title: output.title, purpose: output.purpose,
        prompt, categoryCode: code, referenceImageIds: output.referenceImageIds, factRefs: output.factRefs, allowsTextOverlay: output.allowsTextOverlay,
        textContent: output.textContent, aspectRatio: output.aspectRatio, suggestedParams: output.suggestedParams, globalStyleCard: style,
        promptSha256: promptSha256(prompt),
      });
    }
  }
  return items.length ? items : null;
}
