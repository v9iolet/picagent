import type { Ticket02App, AppResponse } from "./app.js";

export function decodeMultipartFilename(filenameStar: string | undefined, filenameHeader: string | undefined): string {
  if (filenameStar) return decodeURIComponent(filenameStar);
  if (!filenameHeader) return "upload";
  return Buffer.from(filenameHeader, "latin1").toString("utf8");
}

export function parseMultipartFile(body: Buffer, contentType: string): { filename: string; mimeType: string; bytes: Buffer } | null {
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[1] ?? contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[2];
  if (!boundary) return null;
  const marker = Buffer.from(`--${boundary}`, "latin1");
  const start = body.indexOf(marker);
  if (start < 0) return null;
  const headerStart = start + marker.length + 2;
  const headerEnd = body.indexOf(Buffer.from("\r\n\r\n", "latin1"), headerStart);
  if (headerEnd < 0) return null;
  const headers = body.subarray(headerStart, headerEnd).toString("latin1");
  const disposition = headers.match(/content-disposition:[^\r\n]*filename\*=[^']*''([^;\r\n]+)|content-disposition:[^\r\n]*filename="([^"]+)"/i);
  const mimeType = headers.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim();
  if (!disposition || !mimeType) return null;
  const dataStart = headerEnd + 4;
  const nextBoundary = body.indexOf(Buffer.from(`\r\n--${boundary}`, "latin1"), dataStart);
  if (nextBoundary < 0) return null;
  return { filename: decodeMultipartFilename(disposition[1], disposition[2]), mimeType, bytes: body.subarray(dataStart, nextBoundary) };
}

// Kept outside index.ts so the actual HTTP dispatcher can run without PostgreSQL or MinIO.
export async function dispatchInputImageUpload(app: Ticket02App, path: string, body: Buffer, headers: Record<string, string | undefined>): Promise<AppResponse | null> {
  if (/^\/api\/listing-copies\/[^/]+\/input-images$/.test(path)) {
    const file = parseMultipartFile(body, headers["content-type"] ?? "");
    if (!file) return { status: 400, body: { error: { code: "INVALID_MULTIPART", message: "未找到图片文件" }, requestId: "" } };
    return app.request("POST", path, { body: file });
  }
  const suiteUpload = path.match(/^\/api\/suites\/([^/]+)\/input-images$/);
  if (!suiteUpload) return null;
  const suiteId = suiteUpload[1];
  const contentType = headers["content-type"] ?? "";
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[1] ?? contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[2];
  if (!boundary) return { status: 400, body: { error: { code: "INVALID_MULTIPART", message: "上传请求格式无效" }, requestId: "" } };
  else {
    const raw = body.toString("latin1"); const part = raw.split(`--${boundary}`).find((value) => value.includes("filename="));
    const match = part?.match(/(?:filename\*=[^']*''([^;\r\n]+)|filename="([^"]+)")[\s\S]*?Content-Type:\s*([^\r\n]+)[\r\n]+\r\n([\s\S]*?)\r\n$/i);
    if (!match) return { status: 400, body: { error: { code: "INVALID_MULTIPART", message: "未找到图片文件" }, requestId: "" } };
    else {
      const encodedFilename = match[1];
      const filename = decodeMultipartFilename(encodedFilename, match[2]);
      return app.upload(suiteId, { filename, mimeType: match[3], bytes: Buffer.from(match[4], "latin1"), idempotencyKey: headers["idempotency-key"] });
    }
  }
}
