import { GEMINI_IMAGE_ASPECT_RATIOS, isGeminiImageModel, isQwenImageModel, matchNearestAspectRatio, resolveImageSize } from "../../shared/model-settings.js";
import type { ImageEditRequest } from "../types.js";

export type ImageProtocol = "gemini-generate-content" | "dashscope-images" | "openai-images-edits";

export function detectImageProtocol(baseUrl: string, modelId: string): ImageProtocol {
  const host = URL.parse(baseUrl)?.hostname.replace(/\.$/, "");
  // Gemini 的原生协议优先，避免转发多个厂商模型的渠道把 Gemini 发到兼容接口。
  if (isGeminiImageModel(modelId) || host === "generativelanguage.googleapis.com") return "gemini-generate-content";
  // 百炼既可通过官方域名识别，也可在中转域名上按阿里系模型名识别。
  if ((host && /^(?:dashscope[a-z0-9.-]*|.+\.maas)\.aliyuncs\.com$/.test(host))
    || isQwenImageModel(modelId) || /\bwan(?:x|2(?=[.-]|$))/i.test(modelId)) return "dashscope-images";
  // 其余模型沿用 OpenAI 兼容的 multipart edits。
  return "openai-images-edits";
}

type InputImages = NonNullable<ImageEditRequest["images"]>;

export function imageEndpoint(protocol: ImageProtocol, base: URL, model: string): URL {
  if (protocol === "gemini-generate-content") {
    return new URL(`/v1beta/models/${encodeURIComponent(model)}:generateContent`, base.origin);
  }
  if (protocol === "dashscope-images") {
    return new URL("images/generations", base.href.replace(/\/?$/, "/"));
  }
  if (base.pathname === "/") base.pathname = "/v1";
  return new URL("images/edits", base.href.replace(/\/?$/, "/"));
}

const IMAGE_TIERS = ["1K", "2K", "4K"] as const;
type ImageTier = (typeof IMAGE_TIERS)[number];

function isImageTier(size: string): size is ImageTier {
  return IMAGE_TIERS.some((tier) => tier === size);
}

function pixelDimensions(size: string): [number, number] {
  const match = /^(\d+)x(\d+)$/i.exec(size);
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new Error("IMAGE_SIZE_UNSUPPORTED");
  }
  return [width, height];
}

function dashScopeSize(size: string): string {
  if (isImageTier(size)) return size === "1K" ? "1024x1024" : "2048x2048";
  let [width, height] = pixelDimensions(size);
  const maxPixels = 2048 ** 2;
  if (width * height > maxPixels) {
    const scale = Math.sqrt(maxPixels / (width * height));
    width = 16 * Math.floor(width * scale / 16);
    height = 16 * Math.floor(height * scale / 16);
    if (width === 0 || height === 0) throw new Error("IMAGE_SIZE_UNSUPPORTED");
  }
  return `${width}x${height}`;
}

type GeminiAspectRatio = (typeof GEMINI_IMAGE_ASPECT_RATIOS)[number];
// Gemini 原生像素表的 1K 档，2K 和 4K 分别将宽高乘以 2 和 4。
const GEMINI_1K_PIXELS: Record<GeminiAspectRatio, [number, number]> = {
  "1:1": [1024, 1024], "2:3": [848, 1264], "3:2": [1264, 848],
  "3:4": [896, 1200], "4:3": [1200, 896], "4:5": [928, 1152], "5:4": [1152, 928],
  "9:16": [768, 1376], "16:9": [1376, 768], "21:9": [1584, 672],
};

function geminiImageConfig(size: string) {
  if (isImageTier(size)) return { aspectRatio: "1:1", imageSize: size };
  const [width, height] = pixelDimensions(size);
  const aspectRatio = matchNearestAspectRatio(width, height, [...GEMINI_IMAGE_ASPECT_RATIOS]) as GeminiAspectRatio;
  const [nativeWidth, nativeHeight] = GEMINI_1K_PIXELS[aspectRatio];
  const distance = (w: number, h: number) => Math.hypot(Math.log(w / width), Math.log(h / height));
  let imageSize: ImageTier = "1K";
  let closest = Infinity;
  for (const [index, tier] of IMAGE_TIERS.entries()) {
    // 同时识别工作台按通用公式换算的像素，以及该档位在 Gemini 文档里的像素。
    const [w, h] = pixelDimensions(resolveImageSize(tier, aspectRatio, "pixels"));
    const scale = 2 ** index;
    const candidate = Math.min(distance(w, h), distance(nativeWidth * scale, nativeHeight * scale));
    if (candidate < closest) {
      closest = candidate;
      imageSize = tier;
    }
  }
  return { aspectRatio, imageSize };
}

export function buildImageRequest(protocol: ImageProtocol, request: ImageEditRequest, images: InputImages, apiKey: string) {
  const authorization = `Bearer ${apiKey}`;
  if (protocol === "openai-images-edits") {
    const form = new FormData();
    form.append("model", request.model);
    for (const item of images) form.append("image", new Blob([Uint8Array.from(item.bytes)], { type: item.mimeType }), item.filename);
    if (request.mask) form.append("mask", new Blob([Uint8Array.from(request.mask)], { type: request.maskMimeType ?? "image/png" }), request.maskFilename ?? "mask.png");
    form.append("prompt", request.prompt);
    form.append("size", request.size);
    form.append("quality", request.quality);
    form.append("n", String(request.n));
    form.append("response_format", request.responseFormat);
    return { headers: { authorization }, body: form };
  }

  if (request.mask) throw new Error("IMAGE_MASK_UNSUPPORTED");
  const headers = { authorization, "content-type": "application/json" };
  if (protocol === "dashscope-images") {
    if (images.length > 10) throw new Error("IMAGE_REFERENCE_LIMIT_EXCEEDED");
    const body = JSON.stringify({
      model: request.model,
      prompt: request.prompt,
      n: 1,
      size: dashScopeSize(request.size),
      ...(images.length && { image: images.map(({ bytes, mimeType }) => `data:${mimeType};base64,${bytes.toString("base64")}`) }),
    });
    return { headers, body };
  }
  const body = JSON.stringify({
    contents: [{
      parts: [
        { text: request.prompt },
        ...images.map(({ bytes, mimeType }) => ({ inline_data: { mime_type: mimeType, data: bytes.toString("base64") } })),
      ],
    }],
    generationConfig: { responseModalities: ["IMAGE"], imageConfig: geminiImageConfig(request.size) },
  });
  return { headers: { ...headers, "x-goog-api-key": apiKey }, body };
}

type GeminiInlineData = { data?: string; mime_type?: string; mimeType?: string };
type GeminiFileData = { file_uri?: string; fileUri?: string };
interface GeminiImagePart {
  inline_data?: GeminiInlineData;
  inlineData?: GeminiInlineData;
  file_data?: GeminiFileData;
  fileData?: GeminiFileData;
}

interface ImagePayload {
  data?: Array<{ b64_json?: string; url?: string }>;
  candidates?: Array<{ content?: { parts?: GeminiImagePart[] } }>;
}

type ImageResponse = { base64: string; mimeType: string; dataCount?: number } | { url: string; dataCount?: number };

export function readImageResult(protocol: ImageProtocol, payload: ImagePayload): ImageResponse {
  if (protocol === "gemini-generate-content") {
    const parts = payload?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        const inline = part?.inline_data ?? part?.inlineData;
        const base64 = inline?.data;
        if (typeof base64 === "string" && base64.trim()) {
          const mimeType = inline?.mime_type ?? inline?.mimeType;
          return { base64, mimeType: typeof mimeType === "string" && mimeType.trim() ? mimeType : "image/png" };
        }
        const file = part?.file_data ?? part?.fileData;
        const url = file?.file_uri ?? file?.fileUri;
        if (typeof url === "string" && url.trim()) return { url };
      }
    }
  } else {
    const item = payload?.data?.[0];
    if (typeof item?.b64_json === "string" && item.b64_json.trim()) {
      return { base64: item.b64_json, mimeType: "image/png", dataCount: payload.data?.length };
    }
    if (typeof item?.url === "string" && item.url.trim()) return { url: item.url, dataCount: payload.data?.length };
  }
  throw new Error("INVALID_PROVIDER_RESPONSE");
}
