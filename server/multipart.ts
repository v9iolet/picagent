import type { SuiteStudioApp, AppResponse } from "./app.js";

export function decodeMultipartFilename(filenameStar: string | undefined, filenameHeader: string | undefined): string {
  if (filenameStar) return decodeURIComponent(filenameStar);
  if (!filenameHeader) return "upload";
  return Buffer.from(filenameHeader, "latin1").toString("utf8");
}

type MultipartFile = { filename: string; mimeType: string; bytes: Buffer };
type MultipartForm = { file?: MultipartFile; ordinal?: number };

const crlf = Buffer.from("\r\n");
const headerSeparator = Buffer.from("\r\n\r\n");

function parseMultipart(body: Buffer, contentType: string): MultipartForm | null {
  const match = /(?:^|;)\s*boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary) return null;
  const marker = Buffer.from("--" + boundary, "latin1");
  const form: MultipartForm = {};

  // Only a complete delimiter line ends a part. A marker prefix may occur in image bytes.
  function nextBoundary(from: number) {
    for (let pos = body.indexOf(marker, from); pos >= 0; pos = body.indexOf(marker, pos + 1)) {
      if (pos !== 0 && !body.subarray(pos - 2, pos).equals(crlf)) continue;
      let end = pos + marker.length;
      const closing = body[end] === 0x2d && body[end + 1] === 0x2d;
      if (closing) end += 2;
      // MIME permits spaces and tabs between the delimiter and the line ending.
      while (body[end] === 0x20 || body[end] === 0x09) end++;
      if (body.subarray(end, end + 2).equals(crlf) || (closing && end === body.length)) {
        return { pos, next: end + 2, closing };
      }
    }
    return null;
  }

  let delimiter = nextBoundary(0);
  while (delimiter && !delimiter.closing) {
    const headerStart = delimiter.next;
    delimiter = nextBoundary(headerStart);
    if (!delimiter) break;
    const part = body.subarray(headerStart, delimiter.pos - 2);
    const headerEnd = part.indexOf(headerSeparator);
    if (headerEnd < 0) continue;
    const headers = part.subarray(0, headerEnd).toString("latin1");
    const disposition = /^content-disposition:[^\r\n]+/im.exec(headers)?.[0];
    if (!disposition) continue;
    const bytes = part.subarray(headerEnd + headerSeparator.length);
    const filenameStar = /;\s*filename\*=[^';]*'[^';]*'([^;\s]+)/i.exec(disposition)?.[1];
    const filenameHeader = /;\s*filename="([^"]+)"/i.exec(disposition)?.[1];
    if (filenameStar || filenameHeader) {
      const mimeType = /^content-type:[ \t]*([^\r\n]+)/im.exec(headers)?.[1].trim();
      if (!form.file && mimeType) {
        form.file = { filename: decodeMultipartFilename(filenameStar, filenameHeader), mimeType, bytes };
      }
    } else if (form.ordinal === undefined && /;\s*name=(?:"ordinal"|ordinal)\s*(?:;|$)/i.test(disposition)) {
      form.ordinal = Number(bytes.toString("utf8").trim());
    }
  }
  return form;
}

export function parseMultipartFile(body: Buffer, contentType: string): MultipartFile | null {
  return parseMultipart(body, contentType)?.file ?? null;
}

// Kept outside index.ts so the actual HTTP dispatcher can run without PostgreSQL or MinIO.
export async function dispatchInputImageUpload(app: SuiteStudioApp, path: string, body: Buffer, headers: Record<string, string | undefined>): Promise<AppResponse | null> {
  const suiteUpload = path.match(/^\/api\/suites\/([^/]+)\/input-images$/);
  if (!suiteUpload && !/^\/api\/listing-copies\/[^/]+\/input-images$/.test(path) &&
      !/^\/api\/image-editor\/sessions\/[^/]+\/versions\/[^/]+\/restore-inputs$/.test(path)) return null;
  if (app.authorize) {
    const denied = await app.authorize(headers);
    if (denied) return denied;
  }
  const form = parseMultipart(body, headers["content-type"] ?? "");
  if (!form?.file) {
    const message = suiteUpload && !form ? "上传请求格式无效" : "未找到图片文件";
    return { status: 400, body: { error: { code: "INVALID_MULTIPART", message }, requestId: "" } };
  }
  if (!suiteUpload) return app.request("POST", path, { headers, body: form.file });
  return app.upload(suiteUpload[1], { ...form.file, ordinal: form.ordinal, idempotencyKey: headers["idempotency-key"] }, headers);
}
