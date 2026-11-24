import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import sharp from "sharp";
import { createSuiteStudioApp } from "../server/app.js";
import { ImageEditorService, MemoryImageEditorRepository } from "../server/image-editor.js";
import { createImageEditorApi } from "../server/image-editor-api.js";
import { dispatchInputImageUpload } from "../server/multipart.js";
import { parseNormalizedPromptMarkdown } from "../server/prompt-library.js";
import {
  DEFAULT_REQUEST_BODY_MAX_BYTES,
  IMAGE_EDITOR_OPERATION_BODY_MAX_BYTES,
  readBoundedRequestBody,
  REPLICA_REQUEST_BODY_MAX_BYTES,
  resolveRequestBodyLimit,
  SINGLE_IMAGE_UPLOAD_BODY_MAX_BYTES,
} from "../server/request-body-limit.js";
import { MemoryLibraryRepository } from "../server/repositories/memory-library-repository.js";
import { MemoryPipelineRepository } from "../server/repositories/memory-pipeline-repository.js";
import { MemoryPromptRepository } from "../server/repositories/memory-prompt-repository.js";
import { MemoryReplicaRepository } from "../server/repositories/memory-replica-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryTaskRepository } from "../server/repositories/memory-task-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffers: Buffer[]): number {
  let c = 0xffffffff;
  for (const buf of buffers) {
    for (let i = 0; i < buf.length; i += 1) {
      c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Creates a valid PNG with small dimensions (16x16, fast for sharp) padded via an ancillary tEXt chunk
 * to reach targetBytes (each seed yields a unique SHA-256 hash).
 */
async function createPaddedPng(targetBytes: number, seed: number): Promise<Buffer> {
  const basePng = await sharp({
    create: {
      width: 16,
      height: 16,
      channels: 3,
      background: { r: (seed * 37) % 255, g: (seed * 73) % 255, b: (seed * 113) % 255 },
    },
  }).png().toBuffer();

  // Insert an ancillary tEXt chunk right before the trailing 12-byte IEND chunk.
  const iendStart = basePng.length - 12;
  const keyword = Buffer.from(`pad${seed}\0`, "latin1");
  const overhead = 12 + keyword.length; // length(4) + type(4) + data(keyword+fill) + crc(4)
  const fillLen = Math.max(1, targetBytes - basePng.length - overhead);
  const fill = Buffer.alloc(fillLen, 0x41 + (seed % 26));
  const type = Buffer.from("tEXt", "latin1");
  const data = Buffer.concat([keyword, fill]);
  const lengthBuf = Buffer.alloc(4);
  lengthBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32([type, data]), 0);
  return Buffer.concat([basePng.subarray(0, iendStart), lengthBuf, type, data, crcBuf, basePng.subarray(iendStart)]);
}

async function startBoundedHttpServer(t: test.TestContext) {
  const repository = new MemorySuiteRepository();
  const storage = new MemoryStorage();
  const promptRepository = new MemoryPromptRepository();
  const taskRepository = new MemoryTaskRepository();
  const pipelineRepository = new MemoryPipelineRepository();
  const replicaRepository = new MemoryReplicaRepository();
  const libraryRepository = new MemoryLibraryRepository();
  const imageEditorRepository = new MemoryImageEditorRepository();

  for (const rel of ["prompt/normalized/replica-compose.md", "prompt/normalized/replica-high.md"]) {
    const md = await readFile(rel, "utf8");
    const [draft] = await promptRepository.importRecords([parseNormalizedPromptMarkdown(md, rel)]);
    await promptRepository.publishVersion(draft.templateVersionId);
  }

  const tinyResult = await sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 240, g: 240, b: 240 } },
  }).png().toBuffer();

  const imageEditorApi = createImageEditorApi(
    new ImageEditorService(
      imageEditorRepository,
      {
        name: "fake-editor",
        version: "1",
        capabilitiesVersion: "1",
        capabilities: () => ({ imageToImage: true, addText: true, changeText: true, redraw: true, erase: true, outpaint: true, currentVersionInput: true }),
        edit: async () => ({ bytes: tinyResult, mimeType: "image/png", width: 16, height: 16 }),
      },
      storage,
      async () => ({ bytes: tinyResult, mimeType: "image/png", width: 16, height: 16, generationPrompt: "" }),
    ),
  );

  const app = createSuiteStudioApp({
    repository,
    storage,
    promptRepository,
    taskRepository,
    pipelineRepository,
    replicaRepository,
    libraryRepository,
    imageEditorApi,
    imageRetryDelayMs: 0,
    llmClient: {
      provider: "fake-vision",
      model: "qwen-vl-max",
      isFake: true,
      generatePlan: async () => ({}),
      generateReplicaPrompts: async (input) => ({
        schemaVersion: "replica-prompt-v1",
        taskName: "大请求体压测复刻",
        sharedStyle: input.styleUnified ? "统一棚拍风格" : null,
        items: input.references.map((ref) => ({
          referenceId: ref.referenceId,
          visualStructure: { composition: "居中", lighting: "柔光", palette: "浅灰", layout: "常规", textBlocks: [] },
          copy: [],
          prompt: `复刻图 ${ref.ordinal}`,
        })),
      }),
    },
    provider: {
      supportsMultipleImages: true,
      edit: async () => ({ bytes: tinyResult, mimeType: "image/png" }),
    },
  });

  const server = http.createServer((req, res) => {
    void (async () => {
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      const body = await readBoundedRequestBody(req, res, requestUrl.pathname);
      if (body === null) return;
      const path = requestUrl.pathname + requestUrl.search;
      const headers = req.headers as Record<string, string | undefined>;
      const upload = req.method === "POST" ? await dispatchInputImageUpload(app, requestUrl.pathname, body, headers) : null;
      const response = upload ?? await (async () => {
        let parsed: unknown;
        try { parsed = body.length ? JSON.parse(body.toString("utf8")) : undefined; } catch { parsed = undefined; }
        return app.request(req.method ?? "GET", path, { headers: headers as Record<string, string>, body: parsed });
      })();
      res.statusCode = response.status;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(response.body));
    })().catch((error) => {
      if (res.headersSent) { res.destroy(); return; }
      res.statusCode = 500;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: String(error) }, requestId: "" }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    app,
    replicaRepository,
    pipelineRepository,
  };
}

function sendRawHttp(
  port: number,
  options: { method: string; path: string; headers: Record<string, string>; chunks: Buffer[] },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: options.method, path: options.path, headers: options.headers },
      (res) => {
        const parts: Buffer[] = [];
        res.on("data", (chunk) => parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          const text = Buffer.concat(parts).toString("utf8");
          let parsed: unknown = text;
          try { parsed = JSON.parse(text); } catch { /* keep raw */ }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed });
        });
      },
    );
    req.on("error", (error: NodeJS.ErrnoException) => {
      // If server rejects early with 413 and closes, wait for response if already emitted.
      if (error.code === "EPIPE" || error.code === "ECONNRESET") return;
      reject(error);
    });
    for (const chunk of options.chunks) {
      if (!req.destroyed) req.write(chunk);
    }
    if (!req.destroyed) req.end();
  });
}

test("resolveRequestBodyLimit scopes large limits strictly to replica, image-editor operations, and multipart upload routes", () => {
  assert.equal(resolveRequestBodyLimit("POST", "/api/replicas"), REPLICA_REQUEST_BODY_MAX_BYTES);
  assert.equal(resolveRequestBodyLimit("POST", "/api/suites/abc-123/input-images"), SINGLE_IMAGE_UPLOAD_BODY_MAX_BYTES);
  assert.equal(resolveRequestBodyLimit("POST", "/api/listing-copies/draft/input-images"), SINGLE_IMAGE_UPLOAD_BODY_MAX_BYTES);
  assert.equal(resolveRequestBodyLimit("POST", "/api/listing-copies/job-1/input-images"), SINGLE_IMAGE_UPLOAD_BODY_MAX_BYTES);
  assert.equal(resolveRequestBodyLimit("POST", "/api/image-editor/sessions/s1/operations"), IMAGE_EDITOR_OPERATION_BODY_MAX_BYTES);

  // Ordinary JSON routes and non-POST methods fall back to the 1 MiB default.
  assert.equal(resolveRequestBodyLimit("POST", "/api/suites"), DEFAULT_REQUEST_BODY_MAX_BYTES);
  assert.equal(resolveRequestBodyLimit("PATCH", "/api/suites/abc-123/workbench/layout"), DEFAULT_REQUEST_BODY_MAX_BYTES);
  assert.equal(resolveRequestBodyLimit("PATCH", "/api/prompt-templates/tpl-1"), DEFAULT_REQUEST_BODY_MAX_BYTES);
  assert.equal(resolveRequestBodyLimit("POST", "/api/image-editor/sessions/s1/submit"), DEFAULT_REQUEST_BODY_MAX_BYTES);
  assert.equal(resolveRequestBodyLimit("GET", "/api/replicas"), DEFAULT_REQUEST_BODY_MAX_BYTES);
  assert.equal(resolveRequestBodyLimit("POST", "/api/replicas/abc/resume"), DEFAULT_REQUEST_BODY_MAX_BYTES);
});

test("ordinary JSON endpoints accept normal payloads and reject payloads over 1 MiB with 413 PAYLOAD_TOO_LARGE and connection: close", async (t) => {
  const { port } = await startBoundedHttpServer(t);

  // Normal JSON payload (< 1 MiB) succeeds
  const normalBody = Buffer.from(JSON.stringify({ name: "正常套图方案" }), "utf8");
  const okRes = await sendRawHttp(port, {
    method: "POST",
    path: "/api/suites",
    headers: { "content-type": "application/json", "content-length": String(normalBody.length) },
    chunks: [normalBody],
  });
  assert.equal(okRes.status, 201);
  assert.equal(okRes.body.data.name, "正常套图方案");

  // Oversized JSON payload (> 1 MiB) with explicit Content-Length returns 413 with connection: close
  const oversized = Buffer.from(JSON.stringify({ name: "x".repeat(DEFAULT_REQUEST_BODY_MAX_BYTES + 1024) }), "utf8");
  assert.ok(oversized.length > DEFAULT_REQUEST_BODY_MAX_BYTES);
  const rejectedLength = await sendRawHttp(port, {
    method: "POST",
    path: "/api/suites",
    headers: { "content-type": "application/json", "content-length": String(oversized.length) },
    chunks: [oversized],
  });
  assert.equal(rejectedLength.status, 413);
  assert.equal(rejectedLength.headers.connection, "close");
  assert.equal(rejectedLength.body.error.code, "PAYLOAD_TOO_LARGE");
  assert.equal(rejectedLength.body.error.message, "请求体超过大小限制");
  assert.equal(typeof rejectedLength.body.requestId, "string");
  assert.ok(rejectedLength.body.requestId.length > 0);

  // Oversized JSON payload (> 1 MiB) streamed with chunked encoding (no Content-Length) also returns 413 with connection: close
  const chunkSize = 256 * 1024;
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < oversized.length; offset += chunkSize) {
    chunks.push(oversized.subarray(offset, offset + chunkSize));
  }
  const rejectedStreamed = await sendRawHttp(port, {
    method: "POST",
    path: "/api/suites",
    headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
    chunks,
  });
  assert.equal(rejectedStreamed.status, 413);
  assert.equal(rejectedStreamed.headers.connection, "close");
  assert.equal(rejectedStreamed.body.error.code, "PAYLOAD_TOO_LARGE");

  // Unterminated oversized chunked stream still gets 413 + connection: close and server closes socket promptly
  const stalledResult = await new Promise<{ status: number; connection?: string; closed: boolean; body: any }>((resolve, reject) => {
    let status = 0;
    let connection: string | undefined;
    let body: any = null;
    let closed = false;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        agent: false,
        method: "POST",
        path: "/api/suites",
        headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
      },
      (res) => {
        status = res.statusCode ?? 0;
        connection = res.headers.connection;
        const parts: Buffer[] = [];
        res.on("data", (chunk) => parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          try { body = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { body = null; }
        });
      },
    );
    req.on("error", () => { /* expected once server destroys socket */ });
    req.on("close", () => {
      closed = true;
      resolve({ status, connection, closed, body });
    });
    const timer = setTimeout(() => reject(new Error("server did not close stalled oversized chunked stream")), 2000);
    req.once("close", () => clearTimeout(timer));
    // Write >1 MiB without calling req.end() to simulate a stalled oversized chunked client
    for (const chunk of chunks) req.write(chunk);
  });
  assert.equal(stalledResult.status, 413);
  assert.equal(stalledResult.connection, "close");
  assert.equal(stalledResult.closed, true);
  assert.equal(stalledResult.body?.error?.code, "PAYLOAD_TOO_LARGE");
});

test("image editor operations route accepts ~2 MiB brush strokes within 4 MiB limit and rejects >4 MiB with 413", async (t) => {
  const { port } = await startBoundedHttpServer(t);
  const sessionId = "session-large-strokes";

  // Build a realistic ~2 MiB normalized stroke payload (> 1 MiB default, < 4 MiB operations limit)
  const points = Array.from({ length: 52_000 }, (_, i) => ({
    x: Number((((i * 13) % 1000) / 1000).toFixed(6)) + 0.000123456789,
    y: Number((((i * 29) % 1000) / 1000).toFixed(6)) + 0.000987654321,
  }));
  const strokesBody = Buffer.from(
    JSON.stringify({
      summary: "长时蒙版涂抹局部重绘",
      operation: {
        operationId: "op-redraw-1",
        type: "redraw",
        order: 1,
        sourceCardId: "card-1",
        sourceVersionId: "ver-1",
        parentVersionId: "ver-1",
        summary: "局部重绘",
        payload: {
          prompt: "替换为浅色大理石台面",
          feather: 0.1,
          strokes: [{ mode: "draw", size: 0.04, points }],
        },
      },
    }),
    "utf8",
  );
  assert.ok(
    strokesBody.length > 1.8 * 1024 * 1024 && strokesBody.length < IMAGE_EDITOR_OPERATION_BODY_MAX_BYTES,
    `expected ~2 MiB strokes payload, got ${(strokesBody.length / (1024 * 1024)).toFixed(2)} MiB`,
  );

  const saved = await sendRawHttp(port, {
    method: "POST",
    path: `/api/image-editor/sessions/${sessionId}/operations`,
    headers: {
      "content-type": "application/json",
      "content-length": String(strokesBody.length),
      "idempotency-key": randomUUID(),
    },
    chunks: [strokesBody],
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.data.sessionId, sessionId);
  assert.equal(saved.body.data.operations.length, 1);
  assert.equal(saved.body.data.operations[0].payload.strokes[0].points.length, points.length);

  // > 4 MiB on operations route returns 413 with connection: close
  const rejected = await sendRawHttp(port, {
    method: "POST",
    path: `/api/image-editor/sessions/${sessionId}/operations`,
    headers: {
      "content-type": "application/json",
      "content-length": String(IMAGE_EDITOR_OPERATION_BODY_MAX_BYTES + 1024),
    },
    chunks: [Buffer.from("{}")],
  });
  assert.equal(rejected.status, 413);
  assert.equal(rejected.headers.connection, "close");
  assert.equal(rejected.body.error.code, "PAYLOAD_TOO_LARGE");
});

test("single-image multipart upload allows >1 MiB images up to 16 MiB and rejects >16 MiB with 413", async (t) => {
  const { port } = await startBoundedHttpServer(t);
  const suiteBody = Buffer.from(JSON.stringify({ name: "单图上传测试" }), "utf8");
  const created = await sendRawHttp(port, {
    method: "POST",
    path: "/api/suites",
    headers: { "content-type": "application/json", "content-length": String(suiteBody.length) },
    chunks: [suiteBody],
  });
  assert.equal(created.status, 201);
  const suiteId = created.body.data.id as string;

  // 2 MiB valid PNG (> 1 MiB default, < 16 MiB upload limit) succeeds
  const png2MiB = await createPaddedPng(2 * 1024 * 1024, 99);
  const boundary = "----PicAgentLimitTestBoundary";
  const multipartBody = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="product.png"\r\nContent-Type: image/png\r\n\r\n`, "latin1"),
    png2MiB,
    Buffer.from(`\r\n--${boundary}--\r\n`, "latin1"),
  ]);
  const uploaded = await sendRawHttp(port, {
    method: "POST",
    path: `/api/suites/${suiteId}/input-images`,
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(multipartBody.length),
      "idempotency-key": randomUUID(),
    },
    chunks: [multipartBody],
  });
  assert.equal(uploaded.status, 201);

  // > 16 MiB declared Content-Length returns 413 with connection: close
  const rejectedUpload = await sendRawHttp(port, {
    method: "POST",
    path: `/api/suites/${suiteId}/input-images`,
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(SINGLE_IMAGE_UPLOAD_BODY_MAX_BYTES + 1024),
    },
    chunks: [Buffer.from("x")],
  });
  assert.equal(rejectedUpload.status, 413);
  assert.equal(rejectedUpload.headers.connection, "close");
  assert.equal(rejectedUpload.body.error.code, "PAYLOAD_TOO_LARGE");
});

test("POST /api/replicas persists all 12 images (6 references + 6 products) approaching 200 MiB and rejects >200 MiB with 413", async (t) => {
  const { port, replicaRepository, pipelineRepository } = await startBoundedHttpServer(t);

  // 12 valid PNGs (6 references + 6 products), each ~11 MiB raw (~14.7 MiB base64) -> ~176 MiB JSON body (< 200 MiB)
  const perImageBytes = 11 * 1024 * 1024;
  const pngs = await Promise.all(Array.from({ length: 12 }, (_, index) => createPaddedPng(perImageBytes, index + 1)));

  const payload = {
    sceneType: "ecommerce_product",
    cloneLevel: "high",
    styleUnified: true,
    language: "zh",
    ratio: "1:1",
    size: "1K",
    references: pngs.slice(0, 6).map((bytes, index) => ({
      filename: `ref-${index + 1}.png`,
      mimeType: "image/png",
      bytesBase64: bytes.toString("base64"),
      remark: `参考要求 ${index + 1}`,
    })),
    products: pngs.slice(6, 12).map((bytes, index) => ({
      filename: `prod-${index + 1}.png`,
      mimeType: "image/png",
      bytesBase64: bytes.toString("base64"),
    })),
  };

  const jsonBuffer = Buffer.from(JSON.stringify(payload), "utf8");
  assert.ok(
    jsonBuffer.length > 150 * 1024 * 1024 && jsonBuffer.length < REPLICA_REQUEST_BODY_MAX_BYTES,
    `expected ~176 MiB payload approaching 200 MiB limit, got ${(jsonBuffer.length / (1024 * 1024)).toFixed(1)} MiB`,
  );

  const submitted = await sendRawHttp(port, {
    method: "POST",
    path: "/api/replicas",
    headers: {
      "content-type": "application/json",
      "content-length": String(jsonBuffer.length),
      "idempotency-key": randomUUID(),
    },
    chunks: [jsonBuffer],
  });
  assert.equal(submitted.status, 201, `expected 201 for 12-image replica submit, got ${submitted.status}: ${JSON.stringify(submitted.body)}`);
  const suiteId = submitted.body.data.suiteId as string;
  const runId = submitted.body.data.runId as string;
  assert.ok(suiteId);
  assert.ok(runId);

  // Verify all 6 references AND all 6 uploaded products were validated and persisted
  const storedRefs = await replicaRepository.listReferences(suiteId);
  const storedProducts = await replicaRepository.listProductImages(suiteId);
  assert.equal(storedRefs.length, 6, "all 6 reference images must be persisted");
  assert.equal(storedProducts.length, 6, "all 6 product images must be persisted");
  assert.ok(storedProducts.every((item) => item.sourceKind === "upload" && item.objectKey.includes(suiteId)));

  // Wait for async executePipeline to finish cleanly before tearing down the HTTP server
  let run = await pipelineRepository.getRun(runId);
  for (let i = 0; i < 100 && run?.status === "running"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    run = await pipelineRepository.getRun(runId);
  }
  assert.equal(run?.status, "completed");
  assert.equal(run?.config.hasProductImages, true);
  assert.equal(run?.config.referenceCount, 6);
  assert.equal(run?.config.productImageCount, 6);

  // Exceeding 200 MiB on POST /api/replicas still returns 413 with connection: close
  const rejectedReplica = await sendRawHttp(port, {
    method: "POST",
    path: "/api/replicas",
    headers: {
      "content-type": "application/json",
      "content-length": String(REPLICA_REQUEST_BODY_MAX_BYTES + 1024),
      "idempotency-key": randomUUID(),
    },
    chunks: [Buffer.from("{}")],
  });
  assert.equal(rejectedReplica.status, 413);
  assert.equal(rejectedReplica.headers.connection, "close");
  assert.equal(rejectedReplica.body.error.code, "PAYLOAD_TOO_LARGE");
});
