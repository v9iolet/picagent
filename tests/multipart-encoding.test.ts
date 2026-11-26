import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createSuiteStudioApp } from "../server/app.js";
import { ok } from "../server/api-response.js";
import { decodeMultipartFilename, dispatchInputImageUpload, parseMultipartFile } from "../server/multipart.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";

test("decodes UTF-8 multipart filenames sent through a latin1 header parser", () => {
  const mojibakeHeader = Buffer.from("耳机1.jpg", "utf8").toString("latin1");
  assert.equal(decodeMultipartFilename(undefined, mojibakeHeader), "耳机1.jpg");
  assert.equal(decodeMultipartFilename(encodeURIComponent("鼠标2.jpg"), "ignored.jpg"), "鼠标2.jpg");
});

test("parses a multipart image without changing its binary bytes", () => {
  const boundary = "----picagent-test";
  const bytes = Buffer.from([0, 255, 1, 128, 42]);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename*=UTF-8''${encodeURIComponent("详情图.png")}\r\nContent-Type: image/png\r\n\r\n`, "latin1"),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`, "latin1"),
  ]);

  const parsed = parseMultipartFile(body, `multipart/form-data; boundary=${boundary}`);

  assert.equal(parsed?.filename, "详情图.png");
  assert.equal(parsed?.mimeType, "image/png");
  assert.deepEqual(parsed?.bytes, bytes);
});

test("suite upload forwards ordinal in either part order without splitting on boundary-like image bytes", async () => {
  const boundary = "image-boundary";
  const contentType = `multipart/form-data; boundary="${boundary}"`;
  const bytes = Buffer.concat([Buffer.from([0, 255]), Buffer.from(`--${boundary}\r\n--${boundary}X\r\n--${boundary}--X`)]);
  const field = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="ordinal"\r\n\r\n4\r\n`);
  const file = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fallback.png"; filename*=UTF-8'zh'${encodeURIComponent("鼠标.png")}\r\nContent-Type: image/png\r\n\r\n`),
    bytes, Buffer.from("\r\n"),
  ]);
  const app = createSuiteStudioApp({ repository: new MemorySuiteRepository(), storage: new MemoryStorage() });
  app.upload = async (suiteId, input) => {
    assert.equal(suiteId, "suite-1");
    assert.deepEqual(input, { filename: "鼠标.png", mimeType: "image/png", bytes, ordinal: 4, idempotencyKey: "retry" });
    return ok(null, 201);
  };
  for (const parts of [[file, field], [field, file]]) {
    const body = Buffer.concat([...parts, Buffer.from(`--${boundary}-- \t\r\n`)]);
    assert.deepEqual(parseMultipartFile(body, contentType)?.bytes, bytes);
    const result = await dispatchInputImageUpload(app, "/api/suites/suite-1/input-images", body, {
      "content-type": contentType, "idempotency-key": "retry",
    });
    assert.equal(result?.status, 201);
  }
});

test("unmatched routes and invalid uploads keep their dispatcher responses", async () => {
  const app = createSuiteStudioApp({ repository: new MemorySuiteRepository(), storage: new MemoryStorage() });
  const empty = Buffer.alloc(0);
  assert.equal(await dispatchInputImageUpload(app, "/api/suites", empty, {}), null);
  for (const [path, contentType, message] of [
    ["/api/suites/s/input-images", "multipart/form-data", "上传请求格式无效"],
    ["/api/suites/s/input-images", "multipart/form-data; boundary=missing", "未找到图片文件"],
    ["/api/listing-copies/l/input-images", "multipart/form-data", "未找到图片文件"],
    ["/api/image-editor/sessions/s/versions/v/restore-inputs", "multipart/form-data", "未找到图片文件"],
  ]) {
    const result = await dispatchInputImageUpload(app, path, empty, { "content-type": contentType });
    assert.deepEqual(result, { status: 400, body: { error: { code: "INVALID_MULTIPART", message }, requestId: "" } });
  }
});
