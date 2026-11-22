import { SUITE_CATEGORY_GROUPS } from "./suite-categories.js";

export const VISUAL_STYLES = [
  { id: "auto", name: "AI 智能匹配", promptDirective: "根据商品品类、目标市场与平台，安排富有节奏感的商业视觉风格。" },
  { id: "minimal_luxury", name: "极简高级商业", promptDirective: "采用高质感材质微距、建筑感几何置景、克制的光影对比与高端杂志排版。" },
  { id: "dark_tech", name: "暗调科技光影", promptDirective: "采用深色质感背景、冷暖轮廓光和高对比科技构图，突出有依据的参数。" },
  { id: "natural_lifestyle", name: "自然生活氛围", promptDirective: "使用真实自然日光和温润的居家或户外置景，以亲切的生活视角呈现商品。" },
  { id: "vibrant_promo", name: "活力营销撞色", promptDirective: "使用明快撞色背景、醒目的主副标题层级和易扫读的卖点图标作为视觉锚点。" },
] as const;

export function resolveVisualStyle(code: unknown) {
  return VISUAL_STYLES.find(({ id }) => id === code) ?? VISUAL_STYLES[0];
}

export const SELLING_POINT_LAYOUTS = [
  {
    id: "hero_color_block",
    name: "居中撞色大标题",
    tag: "核心卖点",
    summary: "大标题与居中主体，适合聚焦单一卖点。",
    promptDirective: {
      composition: "用两块鲜明的对比色划分背景，商品正面居中，上下各预留一块文案区。",
      textHierarchy: "顶部放大号主标，底部以较小字号放一句已确认的卖点补充。",
      lighting: "使用柔和定向主光和清晰接触阴影，使主体从撞色背景中凸显。",
    },
  },
  {
    id: "macro_callout_lines",
    name: "微距材质标注",
    tag: "工艺细节",
    summary: "全屏微距配细指示线，突出工艺与纹理。",
    promptDirective: {
      composition: "用全幅斜向微距展示真实纹理，细指示线从留白区连到具体的工艺细节。",
      textHierarchy: "底部排列主副标题，指示线旁仅放简短、可核实的细节标注。",
      lighting: "低角度侧向掠射光凸显纹理，保留暗部细节和材质本色。",
    },
  },
  {
    id: "scene_circle_zoom",
    name: "场景主图＋圆形放大镜",
    tag: "场景细节",
    summary: "在自然场景里展示商品，用圆形视窗放大细节。",
    promptDirective: {
      composition: "在真实使用场景中安排主体，右上角圆形视窗展示同一商品的局部细节。",
      textHierarchy: "左上留白放主标题和简短副标，避免遮挡主体及放大视窗。",
      lighting: "以自然日光串联场景与局部，放大细节保持与主图一致的色温。",
    },
  },
  {
    id: "ambient_three_icons",
    name: "氛围大图＋底部三图标",
    tag: "卖点速览",
    summary: "氛围主图配底部三栏，集中呈现短卖点。",
    promptDirective: {
      composition: "画面中部用大幅氛围主图展示产品，底部划分为三栏圆形图标位。",
      textHierarchy: "顶部以大标题概括主题；底部图标与短标签一一对应，仅使用已确认事实。",
      lighting: "以定向氛围光塑造主体轮廓和明显明暗层次，底栏使用对比明确的底色。",
    },
  },
  {
    id: "top_hero_bottom_trio",
    name: "上主图＋下三宫格细节",
    tag: "多处特写",
    summary: "用上方主图交代外观，用下方三格呈现局部。",
    promptDirective: {
      composition: "上半区展示产品主体，下半区排三格不同的局部特写，保留清晰的分隔线。",
      textHierarchy: "标题放上半区左上留白；下方每格底部以黑底说明条承载极短标签。",
      lighting: "主图使用柔和侧光，特写保留与主图一致的材质与色温，突出细部起伏。",
    },
  },
  {
    id: "left_pills_right_hero",
    name: "左胶囊卖点＋右主体",
    tag: "功能展示",
    summary: "左侧卖点胶囊便于扫读，右侧斜角主体带出动感。",
    promptDirective: {
      composition: "左侧纵排三枚图标胶囊，右侧用倾斜的三分之四视角展示商品。",
      textHierarchy: "左上主标优先，胶囊内由图标和简洁短卖点构成，保持充足间距。",
      lighting: "顺着倾斜方向安排斜射光或轮廓光，用疏密对比强调动势。",
    },
  },
  {
    id: "hero_zoom_spec_box",
    name: "主体＋右侧局部放大框",
    tag: "参数解析",
    summary: "整机与框选局部并列，适合解释一个具体参数。",
    promptDirective: {
      composition: "左侧展示商品全貌，从准确的框选位置引线至右栏矩形放大框，下留解析区。",
      textHierarchy: "顶部主标题概括参数主题，放大框下只标注有依据的参数及简短解释。",
      lighting: "以干净侧光描绘边缘，放大框照明与整机图一致，确保标注可读。",
    },
  },
  {
    id: "top_cards_bottom_hero",
    name: "顶三卖点卡＋下仰拍质感",
    tag: "质感强调",
    summary: "顶部三张信息卡，搭配下方低角度商品大图。",
    promptDirective: {
      composition: "顶部横排三枚圆角信息卡，中下方用低机位仰拍放大商品主体和体积感。",
      textHierarchy: "顶栏使用同级短卖点及小图标，只填入能够确认的文案。",
      lighting: "底部承托面配以渐层光和边缘高光，强调体积与材质质感。",
    },
  },
  {
    id: "split_scene_closeup",
    name: "左右双拼人景与特写",
    tag: "使用与质感",
    summary: "左栏交代实际使用，右栏突出同一商品的特写。",
    promptDirective: {
      composition: "画面左右分屏，左侧呈现人物使用或真实场景，右侧用近景突出同一商品。",
      textHierarchy: "使用低干扰的短标题对应两栏含义，给人物和商品各自留足空间。",
      lighting: "左栏采用环境光，右栏用方向性光突出质感，两栏以相近色温呼应。",
    },
  },
] as const;

export type SellingPointLayout = (typeof SELLING_POINT_LAYOUTS)[number];
export type SellingPointCategory = (typeof SUITE_CATEGORY_GROUPS.selling_points.categories)[number];

export function resolveSellingPointLayouts(ids: unknown, maxCount: number): SellingPointLayout[] {
  if (!Array.isArray(ids) || !Number.isInteger(maxCount) || maxCount <= 0) return [];
  const layouts: SellingPointLayout[] = [];
  for (const id of new Set(ids)) {
    const layout = SELLING_POINT_LAYOUTS.find((entry) => entry.id === id);
    if (layout) layouts.push(layout);
    if (layouts.length === maxCount) break;
  }
  return layouts;
}

export function allocateSellingPointLayouts(
  layouts: readonly SellingPointLayout[],
  { feature_benefit, material_detail }: Record<SellingPointCategory, number>,
): Record<SellingPointCategory, SellingPointLayout[]> {
  return {
    feature_benefit: layouts.slice(0, feature_benefit),
    material_detail: layouts.slice(feature_benefit, feature_benefit + material_detail),
  };
}
