export const DETAIL_CATEGORIES = [
  ["appearance_angles", "多角度外观图"],
  ["lifestyle_use", "生活场景图"],
  ["feature_benefit", "信息卖点图"],
  ["material_detail", "细节特写图"],
  ["comparison", "对比图"],
  ["size_scale", "尺寸规格图"],
  ["included_items", "配件全家福"],
  ["compatibility_application", "适配与应用图"],
  ["variant_bundle", "组合与变体图"],
  ["packaging_unboxing", "包装与开箱图"],
  ["care_instruction", "使用与维护图"],
] as const;

export const DETAIL_CATEGORY_CODES: ReadonlySet<string> = new Set(DETAIL_CATEGORIES.map(([code]) => code));
export const SUITE_CATEGORY_NAMES: Readonly<Record<string, string>> = { main: "主图", ...Object.fromEntries(DETAIL_CATEGORIES) };
export const SUITE_IMAGE_LIMITS = {
  main: { min: 1, max: 5 },
  detail: { min: 0, max: 10 },
  total: { min: 1, max: 12 },
} as const;

export const SUITE_CATEGORY_GROUPS = {
  main: { name: "主图", whiteName: "白底主图", description: "主图，多角度呈现商品", categories: ["main"], mode: "exact", defaultCount: 1 },
  selling_points: { name: "卖点图", description: "展示核心卖点及细节特写", categories: ["feature_benefit", "material_detail"], mode: "exact", defaultCount: 3 },
  lifestyle: { name: "场景图", description: "生活使用场景和人物搭配", categories: ["lifestyle_use"], mode: "exact", defaultCount: 2 },
  other: { name: "其他（AI 智能匹配）", description: "对比图、尺寸图等，根据商品智能匹配", categories: ["comparison", "size_scale", "appearance_angles", "included_items", "compatibility_application", "variant_bundle", "packaging_unboxing", "care_instruction"], mode: "max", defaultCount: 1 },
} as const;

export type SuiteCategoryGroupCode = keyof typeof SUITE_CATEGORY_GROUPS;
export type SuiteCategoryGroup = { categories: readonly string[]; mode: "exact" | "max"; count: number };
export type SuiteCategoryGroups = Record<SuiteCategoryGroupCode, SuiteCategoryGroup>;

function defaultGroup(group: typeof SUITE_CATEGORY_GROUPS[SuiteCategoryGroupCode]): SuiteCategoryGroup {
  return { categories: group.categories, mode: group.mode, count: group.defaultCount };
}

export const DEFAULT_SUITE_CATEGORY_GROUPS: SuiteCategoryGroups = {
  main: defaultGroup(SUITE_CATEGORY_GROUPS.main),
  selling_points: defaultGroup(SUITE_CATEGORY_GROUPS.selling_points),
  lifestyle: defaultGroup(SUITE_CATEGORY_GROUPS.lifestyle),
  other: defaultGroup(SUITE_CATEGORY_GROUPS.other),
};

// 智能匹配不锁定详情分组；6 张是期望上限，辅助图事实不足时可以少出。
export const SMART_SUITE_STRUCTURE_PRESET = {
  main_image_count: 1,
  detail_image_count_min: 0,
  detail_image_count_max: 6,
  selected_detail_categories: DETAIL_CATEGORIES.map(([code]) => code),
  category_requirements: Object.fromEntries(DETAIL_CATEGORIES.map(([code]) => [code, "optional" as const])),
} as const;
