export const CHANGE_TEXT_MAX_LENGTH = 500;
export const CHANGE_TEXT_MAX_OPERATIONS = 50;

export function normalizeChangeTextReplacement(text: string): string {
  return text.trim() === "" ? "" : text;
}

export const OUTPAINT_RATIOS = ["1:1", "3:4", "4:3", "9:16", "16:9"] as const;
export type OutpaintRatio = (typeof OUTPAINT_RATIOS)[number];

export function isOutpaintRatio(value: unknown): value is OutpaintRatio {
  return OUTPAINT_RATIOS.some((ratio) => ratio === value);
}

export function computeOutpaintCanvas(sourceWidth: number, sourceHeight: number, targetRatio: OutpaintRatio) {
  const [ratioWidth, ratioHeight] = targetRatio.split(":").map(Number);
  const sourceScale = Math.max(sourceWidth / ratioWidth, sourceHeight / ratioHeight);
  // Generation sizes round to multiples of 16. Give nominally matching ratios room to expand too.
  const matchesRatio = Math.abs((sourceWidth * ratioHeight) / (sourceHeight * ratioWidth) - 1) <= 0.01;
  const scale = Math.ceil(matchesRatio ? sourceScale * 1.25 : sourceScale);
  const targetWidth = scale * ratioWidth;
  const targetHeight = scale * ratioHeight;
  return {
    targetWidth,
    targetHeight,
    sourceOffset: {
      left: Math.floor((targetWidth - sourceWidth) / 2),
      top: Math.floor((targetHeight - sourceHeight) / 2),
    },
  };
}
