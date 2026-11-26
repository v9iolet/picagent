import type { AppResponse } from "../api-response.js";
import type { SuiteStudioApp } from "../app.js";
import type { ConnectionMeta } from "../auth/request-meta.js";

export async function dispatchJsonRequest(
  request: SuiteStudioApp["request"],
  method: string,
  url: URL,
  headers: Record<string, string>,
  bytes: Buffer,
  meta?: ConnectionMeta,
): Promise<AppResponse> {
  const settingsWrite = url.pathname.startsWith("/api/model-settings/") && ["POST", "PUT", "PATCH"].includes(method);
  if (settingsWrite && headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return {
      status: 415,
      headers: { "cache-control": "no-store" },
      body: { error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "配置请求必须使用 application/json" }, requestId: "" },
    };
  }
  let body: unknown;
  if (bytes.length) {
    try { body = JSON.parse(bytes.toString("utf8")); } catch { body = undefined; }
  }
  const response = await request(method, url.pathname + url.search, { headers, body, ...meta });
  if (!url.pathname.startsWith("/api/model-settings")) return response;
  return { ...response, headers: { ...response.headers, "cache-control": "no-store" } };
}
