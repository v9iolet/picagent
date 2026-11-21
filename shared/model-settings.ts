export type ModelCapability = "image" | "vision";

export interface ImageOptions {
  sizes: string[];
  aspectRatios: string[];
  sizeMode: "tier" | "pixels";
}

export function defaultImageOptions(modelId: string): ImageOptions {
  // 依据 docs/gpt-image-2.md 2026-11-21 omyai gpt-image-2.5-flare-special 实测：
  // 档位均成功，4K 实际为 2880 方图；像素精确生效且省略 size 不跟随参考图。
  // 按产品约定用于 gpt-image-2 系列兜底；其他渠道/分组需自行覆盖能力配置。
  return /^gpt-image-2(?:[.-]|$)/i.test(modelId)
    ? { sizes: ["1K", "2K", "4K"], aspectRatios: ["1:1", "2:3", "3:2"], sizeMode: "pixels" }
    : { sizes: ["1K"], aspectRatios: ["1:1"], sizeMode: "tier" };
}

export function resolveImageSize(size: string, ratio: string, sizeMode: ImageOptions["sizeMode"]): string {
  if (sizeMode === "tier") return size;
  // 1K 2:3 / 3:2 的短边为 1024，4K 基准取实测 2880 而非承诺 4096。
  // 其他比例与高档位像素组合是换算值，尚未经实测，账号是否接受由上游决定。
  const shortEdge = ({ "1K": 1024, "2K": 2048, "4K": 2880 } as Record<string, number>)[size];
  const match = /^(\d+):(\d+)$/.exec(ratio);
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  if (!shortEdge || !width || !height || !Number.isFinite(width / height)) throw new Error("IMAGE_SIZE_UNSUPPORTED");
  return width >= height
    ? String(Math.round(shortEdge * width / height)) + "x" + shortEdge
    : shortEdge + "x" + Math.round(shortEdge * height / width);
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

export const capabilityLabels = { image: "生图", vision: "多模态" } as const;
