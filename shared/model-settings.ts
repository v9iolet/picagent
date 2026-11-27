export const MODEL_CAPABILITIES = ["image", "vision", "video"] as const;
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];
export const IMAGE_QUALITIES = ["low", "medium", "high"] as const;
export type ImageQuality = (typeof IMAGE_QUALITIES)[number];

export interface ImageOptions {
  sizes: string[];
  aspectRatios: string[];
  sizeMode: "tier" | "pixels";
  quality?: ImageQuality;
}

export const GEMINI_IMAGE_ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const;

export function isGeminiImageModel(modelId: string): boolean {
  return /gemini-[\w.-]*image|nano-?banana/i.test(modelId);
}

export function isQwenImageModel(modelId: string): boolean {
  return /\bqwen-image/i.test(modelId);
}

export function defaultImageOptions(modelId: string): ImageOptions {
  if (isGeminiImageModel(modelId)) {
    return { sizes: ["1K", "2K", "4K"], aspectRatios: [...GEMINI_IMAGE_ASPECT_RATIOS], sizeMode: "pixels" };
  }
  if (isQwenImageModel(modelId)) {
    return { sizes: ["1K", "2K"], aspectRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "16:9", "9:16"], sizeMode: "pixels" };
  }
  // omyai 的 flare-special 验证记录见 docs/image-models.md；系列默认值可由渠道显式覆盖。
  return /^gpt-image-2(?:[.-]|$)/i.test(modelId)
    ? { sizes: ["1K", "2K", "4K"], aspectRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "16:9", "9:16"], sizeMode: "pixels" }
    : { sizes: ["1K"], aspectRatios: ["1:1"], sizeMode: "tier" };
}

export function resolveImageSize(size: string, ratio: string, sizeMode: ImageOptions["sizeMode"]): string {
  if (sizeMode === "tier") return size;
  // 短边沿用实测方图档位；长边取最近的 16 像素，3:4 两种请求（1365/1360）实出均为 1360。
  // 这是请求尺寸而非成品保证：1K 9:16 请求 1024x1824，实出 1027x1824。高档位组合未逐一验证。
  const shortEdge = ({ "1K": 1024, "2K": 2048, "4K": 2880 } as Record<string, number>)[size];
  const match = /^(\d+):(\d+)$/.exec(ratio);
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  if (!shortEdge || !width || !height || !Number.isFinite(width / height)) throw new Error("IMAGE_SIZE_UNSUPPORTED");
  const longEdge = 16 * Math.round(shortEdge * Math.max(width, height) / Math.min(width, height) / 16);
  return width >= height ? `${longEdge}x${shortEdge}` : `${shortEdge}x${longEdge}`;
}

export function resolveClosestImageSize(width: number, height: number, options: ImageOptions, targetRatio?: string): string {
  let closest: { size: string; ratio: string; distance: number } | undefined;
  for (const size of options.sizes) {
    for (const ratio of options.aspectRatios) {
      const [candidateWidth, candidateHeight] = resolveImageSize(size, ratio, "pixels").split("x").map(Number);
      const distance = Math.hypot(Math.log(candidateWidth / width), Math.log(candidateHeight / height));
      if (!closest || distance < closest.distance) closest = { size, ratio, distance };
    }
  }
  if (!closest || !Number.isFinite(closest.distance)) throw new Error("IMAGE_SIZE_UNSUPPORTED");
  if (targetRatio && !options.aspectRatios.includes(targetRatio)) throw new Error("IMAGE_SIZE_UNSUPPORTED");
  return resolveImageSize(closest.size, targetRatio ?? closest.ratio, options.sizeMode);
}

export interface ChannelModel {
  id: string;
  capabilities: ModelCapability[];
  imageOptions?: ImageOptions;
}

export interface ModelReference {
  channelId: string;
  modelId: string;
}

export interface ModelChannel {
  id: string;
  name: string;
  protocol: "openai-compatible";
  baseUrl: string;
  models: ChannelModel[];
  hasApiKey: boolean;
}

export type ModelPreferences = Record<ModelCapability, ModelReference | null>;
export interface ModelSettingsView {
  channels: ModelChannel[];
  preferences: ModelPreferences;
}

export interface ModelChannelInput extends Omit<ModelChannel, "id" | "hasApiKey"> {
  apiKey: string;
}

export interface ModelChannelSnapshot {
  channelId: string;
  channelName: string;
  baseUrl: string;
}

export const capabilityLabels = { image: "生图", vision: "多模态", video: "视频" } as const;

export function matchNearestAspectRatio(
  width: number,
  height: number,
  supportedRatios: string[],
): string {
  const candidates = supportedRatios
    .map((label) => {
      const match = /^(\d+):(\d+)$/.exec(label.trim());
      if (!match) return null;
      const w = Number(match[1]);
      const h = Number(match[2]);
      if (!w || !h) return null;
      return { label: label.trim(), value: w / h };
    })
    .filter((item): item is { label: string; value: number } => Boolean(item));
  if (candidates.length === 0) return "1:1";
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return candidates[0].label;
  }
  const targetLog = Math.log(width / height);
  let best = candidates[0];
  let bestDist = Math.abs(targetLog - Math.log(best.value));
  for (let i = 1; i < candidates.length; i += 1) {
    const dist = Math.abs(targetLog - Math.log(candidates[i].value));
    if (dist < bestDist) {
      best = candidates[i];
      bestDist = dist;
    }
  }
  return best.label;
}
