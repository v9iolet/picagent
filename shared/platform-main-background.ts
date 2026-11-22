type PlatformBackground = { marketScope?: string; mainImageBackground?: string };

export const PURE_WHITE_MAIN_IMAGE_REQUIREMENTS =
  "主图必须使用纯白背景（RGB 255,255,255），商品主体完整清晰，不得添加文字、Logo、水印、边框或装饰。";

export function requiresPureWhiteMainImage(platform?: PlatformBackground | null) {
  return platform?.marketScope === "overseas" || platform?.mainImageBackground === "pure_white_required";
}
