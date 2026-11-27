import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { downloadImageUrl } from "./download-image-url.js";
import { buildImageRequest, detectImageProtocol, imageEndpoint, isGoogleAiStudioHost, readImageResult, type ImageProtocol } from "./image-protocol.js";
import type { ImageEditRequest, ImageProvider } from "../types.js";
import { failModelArchive, finishModelArchive, startModelArchive } from "../prompt-archive.js";
import { failObservation, finishObservation, logObservation, recordImageFailure, recordImageSuccess, startGeneration } from "../observability.js";

async function readErrorBody(response: Response, apiKey: string): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length < 2048) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value.subarray(0, 2048 - length);
      chunks.push(chunk);
      length += chunk.byteLength;
    }
  } catch { /* 读取失败仍保留 HTTP 错误，不外泄异常原文。 */ }
  finally { await reader.cancel().catch(() => undefined); }
  let text = Buffer.concat(chunks).toString("utf8");
  if (apiKey) {
    text = text.split(apiKey).join("[REDACTED]");
    // 截断点可能落在反射密钥内部；同样移除末尾的密钥前缀。
    for (let count = Math.min(apiKey.length - 1, text.length); count > 0; count -= 1) {
      if (text.endsWith(apiKey.slice(0, count))) { text = text.slice(0, -count) + "[REDACTED]"; break; }
    }
  }
  const redacted = text.replace(/https?:\/\/[^\s"<>]+/gi, "[REDACTED URL]")
    .replace(/\bBearer\s+[^\s"<>]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[\w-]+/g, "[REDACTED]")
    .replace(/AIza[\w-]{30,}/g, "[REDACTED]")
    .replace(/("(?:api[_-]?key|x-goog-api-key|authorization|token|secret|password)"\s*:\s*")(?:\\.|[^"\\])*/gi, "$1[REDACTED]");
  let result = "";
  let bytes = 0;
  for (const char of redacted) {
    bytes += Buffer.byteLength(char);
    if (bytes > 2048) break;
    result += char;
  }
  return result;
}

// The paid edit already succeeded. Repeating it cannot recover the original download.
export class ImageUrlDownloadError extends Error {}

const PROVIDER_NAMES = {
  "openai-images-edits": "openai-compatible-image",
  "dashscope-images": "dashscope-image",
  "gemini-generate-content": "gemini-image",
} as const;
const GEMINI_404_FALLBACK = { fallbackFromProvider: PROVIDER_NAMES["gemini-generate-content"], fallbackFromHttpStatus: 404 } as const;

export class GptImageProvider implements ImageProvider {
  readonly supportsMultipleImages = true;
  constructor(private readonly baseUrl: string, private readonly apiKey: string, private readonly timeoutMs = 600_000) {}

  async edit(request: ImageEditRequest) {
    const protocol = detectImageProtocol(this.baseUrl, request.model);
    const endpoint = imageEndpoint(protocol, new URL(this.baseUrl), request.model);
    const provider = PROVIDER_NAMES[protocol];
    const flow = request.flow ?? "image-edit";
    const attributes = { flow, provider, model: request.model, endpoint: endpoint.href };
    const startedAt = Date.now();
    const requestId = request.requestId ?? randomUUID();
    const legacyImage = { bytes: request.image, mimeType: request.imageMimeType, filename: request.imageFilename, role: "product" };
    // 非空的旧版单图仍作回退。新协议可用空的旧版 buffer 表示文生图。
    const images = request.images?.length ? request.images
      : protocol === "openai-images-edits" || request.image.length ? [legacyImage] : [];
    const observation = startGeneration("image.edit", {
      prompt: request.prompt,
      images: images.map((item) => ({ mimeType: item.mimeType, filename: item.filename, role: item.role, byteLength: item.bytes.length })),
      mask: request.mask ? { mimeType: request.maskMimeType, byteLength: request.mask.length } : undefined,
    }, attributes);
    const archive = await startModelArchive({
      type: "image-generation",
      flow,
      requestId,
      provider,
      model: request.model,
      request: {
        endpoint: endpoint.href,
        model: request.model,
        prompt: request.prompt,
        size: request.size,
        quality: request.quality,
        n: request.n,
        responseFormat: request.responseFormat,
        images: images.map((item) => ({ filename: item.filename, mimeType: item.mimeType, byteLength: item.bytes.length, role: item.role })),
        mask: request.mask ? { filename: request.maskFilename ?? "mask.png", mimeType: request.maskMimeType ?? "image/png", byteLength: request.mask.length } : undefined,
      },
      inputFiles: images.map((item) => ({ label: item.role ?? "reference", filename: item.filename, mimeType: item.mimeType, bytes: item.bytes })),
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const post = (protocol: ImageProtocol, endpoint: URL) => fetch(endpoint, {
      ...buildImageRequest(protocol, endpoint, request, images, this.apiKey),
      redirect: "error",
      method: "POST",
      signal: controller.signal,
    });
    let fallbackEndpoint: URL | undefined;
    const fallbackMetadata = () => fallbackEndpoint && {
      ...GEMINI_404_FALLBACK,
      provider: PROVIDER_NAMES["openai-images-edits"],
      endpoint: fallbackEndpoint.href,
    };
    let responseSummary: Record<string, unknown> | undefined;
    let httpStatus: number | undefined;
    let responseFormatUsed: "b64_json" | "url" | undefined;
    try {
      let response = await post(protocol, endpoint);
      httpStatus = response.status;
      if (response.status === 404 && protocol === "gemini-generate-content" && !isGoogleAiStudioHost(endpoint.hostname)) {
        // 只在中转渠道明确返回 404 时尝试另一条路径，且不等待被丢弃的响应体。
        void response.body?.cancel().catch(() => undefined);
        controller.signal.throwIfAborted();
        fallbackEndpoint = imageEndpoint("openai-images-edits", new URL(this.baseUrl), request.model);
        httpStatus = undefined;
        response = await post("openai-images-edits", fallbackEndpoint);
        httpStatus = response.status;
      }
      if (!response.ok) {
        const errorBody = await readErrorBody(response, this.apiKey);
        responseSummary = { httpStatus: response.status, errorBody };
        // 保守启发式，01 未实测到超限错误；仅在 4xx 且响应提到尺寸时识别。
        const sizeUnsupported = response.status >= 400 && response.status < 500 && /\bsize\b|resolution|分辨率|尺寸/i.test(errorBody);
        throw new Error(sizeUnsupported ? "IMAGE_SIZE_UNSUPPORTED" : "IMAGE_PROVIDER_FAILED");
      }
      const payload = await response.json().catch(() => null);
      const result = readImageResult(fallbackEndpoint ? "openai-images-edits" : protocol, payload);
      let image;
      if ("base64" in result) {
        responseFormatUsed = "b64_json";
        image = { bytes: Buffer.from(result.base64, "base64"), mimeType: result.mimeType };
      } else {
        responseFormatUsed = "url";
        responseSummary = { httpStatus: response.status, responseFormatUsed };
        try {
          image = await downloadImageUrl(result.url, controller.signal);
        } catch (error) {
          if (controller.signal.aborted || (error instanceof Error && error.message === "INVALID_PROVIDER_RESPONSE")) throw error;
          await delay(300, undefined, { signal: controller.signal });
          image = await downloadImageUrl(result.url, controller.signal);
        }
      }
      const { bytes, mimeType } = image;
      if (!bytes.length) throw new Error("INVALID_PROVIDER_RESPONSE");
      responseSummary = { httpStatus: response.status, dataCount: result.dataCount, responseFormatUsed, mimeType, byteLength: bytes.length };
      const fallback = fallbackMetadata();
      const responseAttributes = { http_status: response.status, responseFormatUsed };
      await finishModelArchive(archive, { ...fallback, ...responseSummary }, [{ label: "generated-image", mimeType, bytes }]);
      finishObservation(observation, { status: "succeeded", outputMimeType: mimeType, outputByteLength: bytes.length }, { output_type: "image", ...responseAttributes, ...fallback });
      recordImageSuccess(flow, fallback?.provider ?? provider, request.model, Date.now() - startedAt, fallback && { ...GEMINI_404_FALLBACK, ...responseAttributes });
      logObservation("image.completed", { request_id: requestId, ...attributes, ...fallback, duration_ms: Date.now() - startedAt, status: "success", responseFormatUsed, ...(fallback && { http_status: response.status }) });
      return image;
    } catch (error) {
      const normalized = controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")
        ? new Error("IMAGE_PROVIDER_TIMEOUT")
        : error instanceof Error && ["INVALID_PROVIDER_RESPONSE", "IMAGE_SIZE_UNSUPPORTED", "IMAGE_MASK_UNSUPPORTED", "IMAGE_REFERENCE_LIMIT_EXCEEDED"].includes(error.message)
          ? error
          : new Error("IMAGE_PROVIDER_FAILED");
      const responseAttributes = { ...(httpStatus !== undefined && { http_status: httpStatus }), ...(responseFormatUsed && { responseFormatUsed }) };
      const fallback = fallbackMetadata();
      await failModelArchive(archive, normalized, fallback ? { ...fallback, httpStatus, ...responseSummary } : responseSummary);
      failObservation(observation, normalized, { ...responseAttributes, ...fallback });
      recordImageFailure(flow, fallback?.provider ?? provider, request.model, Date.now() - startedAt, normalized.message, fallback && { ...GEMINI_404_FALLBACK, ...responseAttributes });
      logObservation("image.failed", { request_id: requestId, ...attributes, ...fallback, duration_ms: Date.now() - startedAt, status: "error", error_code: normalized.message, ...responseAttributes });
      throw responseFormatUsed === "url" ? new ImageUrlDownloadError(normalized.message) : normalized;
    } finally {
      clearTimeout(timeout);
    }
  }
}
