import { randomUUID } from "node:crypto";
import { downloadImageUrl } from "./download-image-url.js";
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
    .replace(/("(?:api[_-]?key|authorization|token|secret|password)"\s*:\s*")[^"]*/gi, "$1[REDACTED]");
  let result = "";
  let bytes = 0;
  for (const char of redacted) {
    bytes += Buffer.byteLength(char);
    if (bytes > 2048) break;
    result += char;
  }
  return result;
}

export class GptImageProvider implements ImageProvider {
  readonly supportsMultipleImages = true;
  constructor(private readonly baseUrl: string, private readonly apiKey: string, private readonly timeoutMs = 600_000) {}

  async edit(request: ImageEditRequest) {
    const base = new URL(this.baseUrl);
    if (base.pathname === "/") base.pathname = "/v1";
    const endpoint = new URL("images/edits", base.href.replace(/\/?$/, "/"));
    const startedAt = Date.now();
    const observation = startGeneration("image.edit", {
      prompt: request.prompt,
      images: (request.images?.length ? request.images : [{ bytes: request.image, mimeType: request.imageMimeType, filename: request.imageFilename, role: "product" }]).map((item) => ({ mimeType: item.mimeType, filename: item.filename, role: item.role, byteLength: item.bytes.length })),
      mask: request.mask ? { mimeType: request.maskMimeType, byteLength: request.mask.length } : undefined,
    }, { flow: request.flow ?? "image-edit", provider: "openai-compatible-image", model: request.model });
    const requestId = request.requestId ?? randomUUID();
    const images = request.images?.length ? request.images : [{ bytes: request.image, mimeType: request.imageMimeType, filename: request.imageFilename, role: "product" }];
    const archive = await startModelArchive({
      type: "image-generation",
      flow: request.flow ?? "image-edit",
      requestId,
      provider: "openai-compatible-image",
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
    const form = new FormData();
    form.append("model", request.model);
    for (const item of images) form.append("image", new Blob([Uint8Array.from(item.bytes)], { type: item.mimeType }), item.filename);
    if (request.mask) form.append("mask", new Blob([Uint8Array.from(request.mask)], { type: request.maskMimeType ?? "image/png" }), request.maskFilename ?? "mask.png");
    form.append("prompt", request.prompt);
    form.append("size", request.size);
    form.append("quality", request.quality);
    form.append("n", String(request.n));
    form.append("response_format", request.responseFormat);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let responseSummary: unknown;
    let responseFormatUsed: "b64_json" | "url" | undefined;
    try {
      const response = await fetch(endpoint, {
        redirect: "error",
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: controller.signal,
      });
      if (!response.ok) {
        const errorBody = await readErrorBody(response, this.apiKey);
        responseSummary = { httpStatus: response.status, errorBody };
        // 保守启发式，01 未实测到超限错误；仅在 4xx 且响应提到尺寸时识别。
        const sizeUnsupported = response.status >= 400 && response.status < 500 && /\bsize\b|resolution|分辨率|尺寸/i.test(errorBody);
        throw new Error(sizeUnsupported ? "IMAGE_SIZE_UNSUPPORTED" : "IMAGE_PROVIDER_FAILED");
      }
      const payload = await response.json().catch(() => null) as { data?: Array<{ b64_json?: unknown; url?: unknown }> } | null;
      const item = payload?.data?.[0];
      const encoded = item?.b64_json;
      let image;
      if (typeof encoded === "string" && encoded.trim()) {
        responseFormatUsed = "b64_json";
        image = { bytes: Buffer.from(encoded, "base64"), mimeType: "image/png" };
      } else if (typeof item?.url === "string" && item.url.trim()) {
        responseFormatUsed = "url";
        responseSummary = { httpStatus: response.status, responseFormatUsed };
        image = await downloadImageUrl(item.url, controller.signal);
      } else {
        throw new Error("INVALID_PROVIDER_RESPONSE");
      }
      const { bytes, mimeType } = image;
      if (!bytes.length) throw new Error("INVALID_PROVIDER_RESPONSE");
      responseSummary = { httpStatus: response.status, dataCount: payload?.data?.length, responseFormatUsed, mimeType, byteLength: bytes.length };
      await finishModelArchive(archive, responseSummary, [{ label: "generated-image", mimeType, bytes }]);
      finishObservation(observation, { status: "succeeded", outputMimeType: mimeType, outputByteLength: bytes.length }, { http_status: response.status, output_type: "image", responseFormatUsed });
      recordImageSuccess(request.flow ?? "image-edit", "openai-compatible-image", request.model, Date.now() - startedAt);
      logObservation("image.completed", { request_id: requestId, flow: request.flow ?? "image-edit", provider: "openai-compatible-image", model: request.model, duration_ms: Date.now() - startedAt, status: "success", responseFormatUsed });
      return image;
    } catch (error) {
      const normalized = controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")
        ? new Error("IMAGE_PROVIDER_TIMEOUT")
        : error instanceof Error && ["INVALID_PROVIDER_RESPONSE", "IMAGE_SIZE_UNSUPPORTED"].includes(error.message)
          ? error
          : new Error("IMAGE_PROVIDER_FAILED");
      await failModelArchive(archive, normalized, responseSummary);
      failObservation(observation, normalized, responseFormatUsed ? { responseFormatUsed } : undefined);
      recordImageFailure(request.flow ?? "image-edit", "openai-compatible-image", request.model, Date.now() - startedAt, normalized.message);
      logObservation("image.failed", { request_id: requestId, flow: request.flow ?? "image-edit", provider: "openai-compatible-image", model: request.model, duration_ms: Date.now() - startedAt, status: "error", error_code: normalized.message, ...(responseFormatUsed && { responseFormatUsed }) });
      throw normalized;
    } finally {
      clearTimeout(timeout);
    }
  }
}
