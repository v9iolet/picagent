import assert from "node:assert/strict";
import test from "node:test";
import { attachmentDisposition, binaryResponse, previewStorageObject } from "../server/http/binary-response.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";

test("preview returns the stored bytes, content type, cache header and response envelope", async () => {
  const storage = new MemoryStorage();
  const bytes = Buffer.from([255, 0, 9]);
  await storage.put({ key: "original", bytes, contentType: "image/png" });
  const result = await previewStorageObject(storage, "original");
  assert.equal(result.status, 200);
  assert.equal(result.raw, bytes);
  assert.deepEqual(result.headers, { "content-type": "image/png", "cache-control": "private, max-age=60" });
  assert.ok("data" in result.body);
  assert.deepEqual(result.body.data, { contentType: "image/png" });
  assert.ok(result.body.requestId);
});

test("preview maps missing objects from both storage adapters and failed reads", async () => {
  for (const [error, code, status] of [
    [null, "OBJECT_NOT_FOUND", 404], [new Error("OBJECT_NOT_FOUND"), "OBJECT_NOT_FOUND", 404],
    [new Error("OBJECT_READ_TIMEOUT"), "OBJECT_READ_FAILED", 502],
  ] as const) {
    const result = await previewStorageObject({ get: async () => { if (error) throw error; return null; } }, "missing");
    assert.equal(result.status, status);
    assert.ok("error" in result.body);
    assert.equal(result.body.error.code, code);
  }
});

test("download headers carry both an ASCII fallback and a UTF-8 filename", () => {
  const disposition = attachmentDisposition("耳机 (A').zip", "delivery.zip");
  assert.equal(disposition, "attachment; filename=\"delivery.zip\"; filename*=UTF-8''%E8%80%B3%E6%9C%BA%20%28A%27%29.zip");
  assert.doesNotMatch(attachmentDisposition("a", 'bad"\r\n.zip'), /[\r\n]/);
  const result = binaryResponse(Buffer.alloc(0), "application/zip", { "content-disposition": disposition, "cache-control": "no-store" });
  assert.equal(result.headers?.["content-disposition"], disposition);
  assert.equal(result.headers?.["cache-control"], "no-store");
});
