import {
  APLUS_SIZE_PRESETS,
  type AplusImageSize,
  type AplusModuleCode,
  type AplusSizePresetKey,
} from "../../shared/aplus.js";
import type { ListingRules } from "../../shared/listing-config.js";
import { formatProductCardFacts, type ProductCardFields } from "../../shared/product-card.js";
import type { PromptTemplateRuntime } from "../prompt-library.js";
import type { PromptRepository } from "../types.js";

type AplusPromptStage = "aplus_plan" | "aplus_image" | "aplus_ai_write";
const APLUS_PROMPT_CODES: Record<AplusPromptStage, string> = {
  aplus_plan: "aplus.plan",
  aplus_image: "aplus.image",
  aplus_ai_write: "aplus.ai-write",
};

type PromptText = Pick<PromptTemplateRuntime, "body" | "userPromptTemplate">;
type ModuleRuleTemplate = PromptText & Pick<PromptTemplateRuntime, "applicability">;

interface AplusPromptInput {
  /** 图片 ID 按视觉模型请求所附图片的顺序传入。 */
  inputImageIds: readonly string[];
  productInfo?: string | null;
  productCardSnapshot?: ProductCardFields | null;
  platform: string;
  targetMarket: string;
  language: string;
  selectedModules: readonly AplusModuleCode[];
  moduleRuleTemplates: readonly ModuleRuleTemplate[];
}

export async function resolveAplusPromptTemplate(
  prompts: Pick<PromptRepository, "listPublished" | "getPublishedVersion">,
  ...selection: [stage: AplusPromptStage] | [stage: "aplus_module_rule", moduleCode: AplusModuleCode]
): Promise<PromptTemplateRuntime | null> {
  const [stage, moduleCode] = selection;
  const published = await prompts.listPublished(stage);
  const matched = stage === "aplus_module_rule"
    ? published.find((item) => item.applicability?.moduleCode === moduleCode) ??
      published.find((item) => item.code === `aplus.module.${moduleCode}`)
    : published.find((item) => item.code === APLUS_PROMPT_CODES[stage]) ?? published[0];
  return matched ? prompts.getPublishedVersion(matched.templateVersionId, stage) : null;
}

function render(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    if (!Object.hasOwn(values, key)) throw new Error(`Unknown A+ prompt field: ${key}`);
    return values[key];
  });
}

function renderSelectedModuleRules(input: AplusPromptInput): string {
  const templatesByCode = new Map(input.moduleRuleTemplates.map((template) => [template.applicability.moduleCode, template]));
  return input.selectedModules.map((moduleCode) => {
    const template = templatesByCode.get(moduleCode);
    if (!template) throw new Error(`No published A+ module rule for ${moduleCode}`);
    const values = { moduleCode };
    return [render(template.userPromptTemplate, values), render(template.body, values)].join("\n");
  }).join("\n\n");
}

function renderVisionPrompt(template: PromptText, input: AplusPromptInput, fields: Record<string, string>) {
  return {
    systemPrompt: render(template.body, { moduleRules: renderSelectedModuleRules(input) }),
    userPrompt: render(template.userPromptTemplate, {
      inputImageIds: JSON.stringify(input.inputImageIds),
      productInfo: input.productInfo?.trim() || "无",
      productCardFacts: input.productCardSnapshot ? formatProductCardFacts(input.productCardSnapshot) || "无" : "无",
      platform: input.platform,
      targetMarket: input.targetMarket,
      language: input.language,
      selectedModules: JSON.stringify(input.selectedModules),
      ...fields,
    }),
  };
}

export function renderAplusPlanPrompt(template: PromptText, input: AplusPromptInput & {
  sizePresets: readonly AplusSizePresetKey[];
  listingCopyRules?: ListingRules | null;
}) {
  const dualPremium = input.sizePresets.includes("aplus_premium_web") && input.sizePresets.includes("aplus_premium_mobile");
  return renderVisionPrompt(template, input, {
    listingCopyRules: input.listingCopyRules ? JSON.stringify(input.listingCopyRules) : "无",
    sizePresets: JSON.stringify(input.sizePresets.map((key) => APLUS_SIZE_PRESETS[key])),
    copyMode: input.language === "none" ? '不加文字，copyRequirements 必须是空字符串 ""' : "按指定语言编写画面文案",
    layoutMode: dualPremium ? "高级 A+ 两端分别规划构图，共用一份文案" : "按所选尺寸规划构图",
  });
}

export function renderAplusAiWritePrompt(template: PromptText, input: AplusPromptInput) {
  return renderVisionPrompt(template, input, {
    cardMode: input.productCardSnapshot ? "已选商品卡，只写补充说明" : "未选商品卡，写五段基本信息并补充模块所需信息",
  });
}

export function renderAplusImagePrompt(template: PromptText, input: {
  moduleCode: AplusModuleCode;
  pictureRequirement: string;
  copyRequirements: string;
  language: string;
  sizePreset: AplusSizePresetKey;
  generatedSize: AplusImageSize;
}): string {
  const preset = APLUS_SIZE_PRESETS[input.sizePreset];
  const noText = input.language === "none";
  const sizeAndSafeArea = {
    预设: preset.key,
    交付比例: preset.ratio,
    生成尺寸: input.generatedSize,
    交付尺寸: preset.deliverySize ?? input.generatedSize,
    安全区: "商品主体、关键部位及文字放在中心安全区，边缘只保留可裁切的背景或非关键装饰。",
  };
  const userPrompt = render(template.userPromptTemplate, {
    moduleCode: JSON.stringify(input.moduleCode),
    pictureRequirement: JSON.stringify(input.pictureRequirement),
    copyRequirements: JSON.stringify(noText ? "" : input.copyRequirements),
    sizeAndSafeArea: JSON.stringify(sizeAndSafeArea),
    copyMode: noText ? "不加文字，整张图禁止出现文字" : `按指定语言渲染：${input.language}`,
  });
  return `${template.body}\n\n${userPrompt}`;
}
