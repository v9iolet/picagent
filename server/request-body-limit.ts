import { randomUUID } from "node:crypto";
import type http from "node:http";
import { errorMessages } from "./api-errors.js";

// 普通 JSON 接口默认上限 1 MiB（覆盖提示词模板编辑、画布布局保存、图片编辑蒙版笔触等非图片请求）。
export const DEFAULT_REQUEST_BODY_MAX_BYTES = 1 * 1024 * 1024;
// 单张图片最大 12 MiB，multipart/form-data 封装预留余量至 16 MiB。
export const SINGLE_IMAGE_UPLOAD_BODY_MAX_BYTES = 16 * 1024 * 1024;
// 单张图片最大 12 MiB，Base64 编码后约 16 MiB；复刻接口单次最多携带 6 张参考图 + 6 张产品图 = 12 张（192 MiB），预留 8 MiB JSON 元数据与字段余量，总上限 200 MiB。
export const REPLICA_REQUEST_BODY_MAX_BYTES = (12 * 16 + 8) * 1024 * 1024;

const SUITE_INPUT_IMAGE_UPLOAD_RE = /^\/api\/suites\/[^/]+\/input-images$/;
const LISTING_INPUT_IMAGE_UPLOAD_RE = /^\/api\/listing-copies\/[^/]+\/input-images$/;

export function resolveRequestBodyLimit(method: string | undefined, pathname: string): number {
  const upperMethod = (method ?? "GET").toUpperCase();
  if (upperMethod === "POST") {
    if (pathname === "/api/replicas") return REPLICA_REQUEST_BODY_MAX_BYTES;
    if (SUITE_INPUT_IMAGE_UPLOAD_RE.test(pathname) || LISTING_INPUT_IMAGE_UPLOAD_RE.test(pathname)) {
      return SINGLE_IMAGE_UPLOAD_BODY_MAX_BYTES;
    }
  }
  return DEFAULT_REQUEST_BODY_MAX_BYTES;
}

export async function readRequestBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  const declaredLength = Number(req.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    req.resume();
    return null;
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buf.length;
    if (totalBytes > maxBytes) {
      chunks.length = 0;
      req.resume();
      return null;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export function writePayloadTooLarge(res: http.ServerResponse): void {
  res.statusCode = 413;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(
    JSON.stringify({
      error: { code: "PAYLOAD_TOO_LARGE", message: errorMessages.PAYLOAD_TOO_LARGE },
      requestId: randomUUID(),
    }),
  );
}

export async function readBoundedRequestBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<Buffer | null> {
  const maxBytes = resolveRequestBodyLimit(req.method, pathname);
  const body = await readRequestBody(req, maxBytes);
  if (body === null) {
    writePayloadTooLarge(res);
    return null;
  }
  return body;
}
