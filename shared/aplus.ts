import { SUPPORTED_OUTPUT_LANGUAGES } from "./workbench-delivery.js";

export const APLUS_MODULES = [
  { code: "hero", name: "首屏主视觉", description: "传递核心价值", defaultSelected: true, sortOrder: 1 },
  { code: "selling_points", name: "核心卖点图", description: "突出差异优势", defaultSelected: true, sortOrder: 2 },
  { code: "usage_scene", name: "使用场景图", description: "呈现真实使用场景", defaultSelected: true, sortOrder: 3 },
  { code: "multi_angle", name: "多角度图", description: "单图内排版多视角", defaultSelected: true, sortOrder: 4 },
  { code: "atmosphere", name: "场景氛围图", description: "情绪化场景", defaultSelected: true, sortOrder: 5 },
  { code: "detail_closeup", name: "商品细节图", description: "放大材质与工艺", defaultSelected: true, sortOrder: 6 },
  { code: "brand_story", name: "品牌故事图", description: "传达品牌理念（无 Logo）", defaultSelected: false, sortOrder: 7 },
  { code: "size_spec", name: "尺寸/容量/尺码图", description: "展示规格信息", defaultSelected: false, sortOrder: 8 },
  { code: "comparison", name: "效果对比图", description: "使用前后对比，遵守对比图定义", defaultSelected: false, sortOrder: 9 },
  { code: "spec_table", name: "详细规格/参数表", description: "详细商品数据", defaultSelected: false, sortOrder: 10 },
  { code: "craftsmanship", name: "工艺制作图", description: "工艺制作过程", defaultSelected: false, sortOrder: 11 },
  { code: "accessories", name: "配件/赠品图", description: "收货的所有物品", defaultSelected: false, sortOrder: 12 },
  { code: "series", name: "系列展示图", description: "多色或多 SKU，单图内排版", defaultSelected: false, sortOrder: 13 },
  { code: "ingredients", name: "商品成分图", description: "配方/材质/成分", defaultSelected: false, sortOrder: 14 },
  { code: "after_sales", name: "售后保障图", description: "质保退换政策", defaultSelected: false, sortOrder: 15 },
  { code: "usage_tips", name: "使用建议图", description: "使用步骤与注意事项", defaultSelected: false, sortOrder: 16 },
] as const;

export type AplusModuleCode = (typeof APLUS_MODULES)[number]["code"];
export const APLUS_MODULE_LIMITS = { min: 1, max: 10 } as const;
export const DEFAULT_APLUS_MODULE_CODES = APLUS_MODULES.filter(({ defaultSelected }) => defaultSelected).map(({ code }) => code);
const moduleCodes = new Set<string>(APLUS_MODULES.map(({ code }) => code));

export interface AplusImageSize {
  width: number;
  height: number;
}

export const APLUS_SIZE_PRESETS = {
  aplus_premium_web: { key: "aplus_premium_web", name: "高级 A+（Web 端）", ratio: "1464:600", deliverySize: { width: 1464, height: 600 }, canCombine: true },
  aplus_premium_mobile: { key: "aplus_premium_mobile", name: "高级 A+（移动端）", ratio: "600:450", deliverySize: { width: 600, height: 450 }, canCombine: true },
  aplus_standard: { key: "aplus_standard", name: "普通 A+", ratio: "970:600", deliverySize: { width: 970, height: 600 }, canCombine: false },
  "1:1": { key: "1:1", name: "1:1", ratio: "1:1", deliverySize: null, canCombine: false },
  "3:4": { key: "3:4", name: "3:4", ratio: "3:4", deliverySize: null, canCombine: false },
  "9:16": { key: "9:16", name: "9:16", ratio: "9:16", deliverySize: null, canCombine: false },
  "16:9": { key: "16:9", name: "16:9", ratio: "16:9", deliverySize: null, canCombine: false },
} as const;

export type AplusSizePresetKey = keyof typeof APLUS_SIZE_PRESETS;
export interface DetailSizePresets {
  options: string[];
  default: string;
}

export interface AplusTaskMetadata {
  moduleCode?: AplusModuleCode | null;
  sizePreset?: AplusSizePresetKey | null;
  sortOrder?: number | null;
}

export interface AplusImageVersionMetadata {
  generatedSize?: AplusImageSize | null;
  deliverySize?: AplusImageSize | null;
  deliveryObjectKey?: string | null;
}

const COMMON_DETAIL_SIZE_PRESETS = ["1:1", "3:4", "9:16", "16:9"] as const;

export function defaultDetailSizePresets(code: string, marketScope: "domestic" | "overseas"): DetailSizePresets {
  if (code === "amazon") {
    return { options: ["aplus_premium_web", "aplus_premium_mobile", "aplus_standard", ...COMMON_DETAIL_SIZE_PRESETS], default: "aplus_standard" };
  }
  return { options: [...COMMON_DETAIL_SIZE_PRESETS], default: marketScope === "domestic" ? "3:4" : "1:1" };
}

export function validateAplusModuleCodes(value: unknown): value is AplusModuleCode[] {
  if (!Array.isArray(value) || value.length < APLUS_MODULE_LIMITS.min || value.length > APLUS_MODULE_LIMITS.max) return false;
  const selected = new Set<unknown>(value);
  return selected.size === value.length && [...selected].every((code) => typeof code === "string" && moduleCodes.has(code));
}

function isAplusSizePresetKey(value: unknown): value is AplusSizePresetKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(APLUS_SIZE_PRESETS, value);
}

export function validateAplusSizePresets(value: unknown, platformPresets: DetailSizePresets): value is AplusSizePresetKey[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) return false;
  const selected = new Set<unknown>(value);
  return selected.size === value.length && [...selected].every((key) =>
    isAplusSizePresetKey(key) && platformPresets.options.includes(key) &&
    (value.length === 1 || APLUS_SIZE_PRESETS[key].canCombine),
  );
}

export function normalizeAplusProductInfo(value: string): string {
  return value.trim();
}

export function normalizeAplusLanguage(value: string): string {
  const language = value.trim();
  if (language === "不加文字") return "none";
  return SUPPORTED_OUTPUT_LANGUAGES.find((option) => option.value === language)?.code ?? language;
}

export function normalizeAplusTargetMarket(value: string): string {
  return value.trim();
}

export interface AplusPlanInputSummary {
  imageHashes: string[];
  productInfo: string;
  productCardId: string | null;
  productCardRevision: number | null;
  platform: string;
  targetMarket: string;
  language: string;
  sizePresets: AplusSizePresetKey[];
  modules: AplusModuleCode[];
}

export function isAplusPlanStale(snapshot: AplusPlanInputSummary, current: AplusPlanInputSummary): boolean {
  const sameOrder = (left: readonly string[], right: readonly string[]) =>
    left.length === right.length && left.every((item, index) => item === right[index]);
  const sameSet = (left: readonly string[], right: readonly string[]) =>
    sameOrder([...left].sort(), [...right].sort());

  return !sameOrder(snapshot.imageHashes, current.imageHashes) ||
    normalizeAplusProductInfo(snapshot.productInfo) !== normalizeAplusProductInfo(current.productInfo) ||
    snapshot.productCardId !== current.productCardId ||
    snapshot.productCardRevision !== current.productCardRevision ||
    snapshot.platform !== current.platform ||
    normalizeAplusTargetMarket(snapshot.targetMarket) !== normalizeAplusTargetMarket(current.targetMarket) ||
    normalizeAplusLanguage(snapshot.language) !== normalizeAplusLanguage(current.language) ||
    !sameSet(snapshot.sizePresets, current.sizePresets) ||
    !sameSet(snapshot.modules, current.modules);
}
