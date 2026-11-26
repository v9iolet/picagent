import { fail } from "../api-errors.js";
import { ok, type AppResponse } from "../api-response.js";
import type { StorageAdapter } from "../types.js";

export function binaryResponse(bytes: Buffer, contentType: string, headers: Record<string, string> = {}, data: unknown = { contentType }): AppResponse {
  return {
    ...ok(data),
    headers: { "cache-control": "private, max-age=60", ...headers, "content-type": contentType },
    raw: bytes,
  };
}

export async function previewStorageObject(
  storage: Pick<StorageAdapter, "get">,
  key: string,
  options: { headers?: Record<string, string>; data?: unknown; missingCode?: string; readFailureCode?: string } = {},
): Promise<AppResponse> {
  try {
    const object = await storage.get(key);
    if (!object) return fail(options.missingCode ?? "OBJECT_NOT_FOUND", 404);
    return binaryResponse(object.bytes, object.contentType, options.headers, options.data);
  } catch (error) {
    if (error instanceof Error && error.message === "OBJECT_NOT_FOUND") return fail(options.missingCode ?? "OBJECT_NOT_FOUND", 404);
    return fail(options.readFailureCode ?? "OBJECT_READ_FAILED", 502);
  }
}

export function attachmentDisposition(filename: string, asciiFallback: string): string {
  const fallback = asciiFallback.replace(/[^\x20-\x7e]|["\\/]/g, "_") || "download";
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
