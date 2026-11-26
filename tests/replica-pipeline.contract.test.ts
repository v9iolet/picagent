import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import sharp from "sharp";
import { createSuiteStudioApp, type AppResponse, type SuiteStudioApp } from "../server/app.js";
import { ImageEditorService, MemoryImageEditorRepository } from "../server/image-editor.js";
import { createImageEditorApi } from "../server/image-editor-api.js";
import { REPLICA_MAX_BASE64_CHARS } from "../server/replica/replica-pipeline.js";
import { parseNormalizedPromptMarkdown } from "../server/prompt-library.js";
import { MemoryLibraryRepository } from "../server/repositories/memory-library-repository.js";
import { MemoryPipelineRepository } from "../server/repositories/memory-pipeline-repository.js";
import { MemoryPromptRepository } from "../server/repositories/memory-prompt-repository.js";
import { MemoryReplicaRepository } from "../server/repositories/memory-replica-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryTaskRepository } from "../server/repositories/memory-task-repository.js";
import { PostgresLibraryRepository } from "../server/repositories/postgres-library-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";
import { readZipEntries } from "../server/zip.js";
import type { ImageEditRequest, LlmClient, ReplicaPromptLlmInput } from "../server/types.js";

async function makePng(width: number, height: number, color: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
}

async function makeJpeg(width: number, height: number, color: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } }).jpeg({ quality: 90 }).toBuffer();
}

interface FixtureOptions {
  llmResponder?: (input: ReplicaPromptLlmInput, call: number) => Promise<unknown> | unknown;
  providerEdit?: (request: ImageEditRequest, call: number, defaultPng: Buffer) => Promise<{ bytes: Buffer; mimeType: string }>;
  imageRetryDelayMs?: number;
}

async function replicaFixture(options: FixtureOptions = {}) {
  const repository = new MemorySuiteRepository();
  const storage = new MemoryStorage();
  const promptRepository = new MemoryPromptRepository();
  const taskRepository = new MemoryTaskRepository();
  const pipelineRepository = new MemoryPipelineRepository();
  const replicaRepository = new MemoryReplicaRepository();
  const libraryRepository = new MemoryLibraryRepository();

  for (const rel of ["prompt/normalized/replica-compose.md", "prompt/normalized/replica-high.md"]) {
    const md = await readFile(rel, "utf8");
    const record = parseNormalizedPromptMarkdown(md, rel);
    const [draft] = await promptRepository.importRecords([record]);
    await promptRepository.publishVersion(draft.templateVersionId);
  }

  const defaultResultPng = await makePng(32, 32, { r: 220, g: 230, b: 240 });
  const defaultEditedPng = await makePng(32, 32, { r: 40, g: 180, b: 120 });
  const editorRepository = new MemoryImageEditorRepository();
  const editorService = new ImageEditorService(
    editorRepository,
    {
      name: "fake-editor",
      version: "1",
      capabilitiesVersion: "1",
      capabilities: () => ({ imageToImage: true, changeText: true, currentVersionInput: true }),
      edit: async () => ({ bytes: defaultEditedPng, mimeType: "image/png", width: 32, height: 32 }),
    },
    storage,
    async () => ({ bytes: defaultResultPng, mimeType: "image/png", width: 32, height: 32 }),
  );
  const llmCalls: ReplicaPromptLlmInput[] = [];
  const providerCalls: ImageEditRequest[] = [];

  const llmClient: LlmClient = {
    provider: "fake-vision",
    model: "qwen-vl-max",
    isFake: true,
    generatePlan: async () => ({}),
    generateReplicaPrompts: async (input) => {
      llmCalls.push(input);
      if (options.llmResponder) {
        return options.llmResponder(input, llmCalls.length);
      }
      return {
        schemaVersion: "replica-prompt-v1",
        taskName: "钛合金保温杯",
        sharedStyle: input.styleUnified ? "清冷高级棚拍调性，银灰石纹台面配柔和侧逆光" : null,
        items: input.references.map((ref) => ({
          referenceId: ref.referenceId,
          visualStructure: {
            composition: `构图-${ref.ordinal}`,
            lighting: "柔和侧逆光",
            palette: "银灰+暖白",
            layout: "上文下图",
            textBlocks: [`顶部标题-${ref.ordinal}`],
          },
          copy: [{ role: "headline", text: `轻盈随行 ${ref.ordinal}`, position: "顶部居中" }],
          prompt: `极简棚拍展示钛合金保温杯（卡 ${ref.ordinal}），柔和侧逆光与石纹台面，顶部清晰排布文案「轻盈随行 ${ref.ordinal}」。`,
        })),
      };
    },
  };

  const app = createSuiteStudioApp({
    imageEditorApi: createImageEditorApi(editorService),
    repository,
    storage,
    promptRepository,
    taskRepository,
    pipelineRepository,
    replicaRepository,
    libraryRepository,
    llmClient,
    imageRetryDelayMs: options.imageRetryDelayMs ?? 0,
    provider: {
      supportsMultipleImages: true,
      edit: async (request) => {
        providerCalls.push(request);
        if (options.providerEdit) {
          return options.providerEdit(request, providerCalls.length, defaultResultPng);
        }
        return { bytes: defaultResultPng, mimeType: "image/png" };
      },
    },
  });

  return {
    app,
    repository,
    storage,
    promptRepository,
    taskRepository,
    pipelineRepository,
    replicaRepository,
    libraryRepository,
    llmCalls,
    providerCalls,
    defaultResultPng,
    defaultEditedPng,
    editorRepository,
  };
}

function expectError(response: AppResponse, status: number, code: string) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.ok("error" in response.body, `expected error envelope, got ${JSON.stringify(response.body)}`);
  assert.equal(response.body.error.code, code);
}

async function waitStudioState(
  app: SuiteStudioApp,
  suiteId: string,
  predicate: (data: any) => boolean,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  let last: any;
  while (Date.now() < deadline) {
    const response = await app.request("GET", `/api/suites/${suiteId}/studio-state`);
    assert.equal(response.status, 200);
    last = (response.body as any).data;
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for studio-state; last=${JSON.stringify(last?.pipeline)}`);
}

test("POST /api/replicas validates parameters, duplicates, and library product resource policy", async () => {
  const f = await replicaFixture();
  const ref1 = await makePng(64, 64, { r: 20, g: 30, b: 40 });
  const ref2 = await makePng(64, 64, { r: 40, g: 50, b: 60 });
  const prod1 = await makePng(48, 48, { r: 200, g: 200, b: 200 });

  const basePayload = {
    references: [{ filename: "ref1.png", mimeType: "image/png", bytesBase64: ref1.toString("base64"), remark: "留白多些" }],
    products: [{ filename: "prod1.png", mimeType: "image/png", bytesBase64: prod1.toString("base64") }],
    sceneType: "ecommerce_product",
    cloneLevel: "high",
    unifiedRequirement: "保持清爽电商风格",
    productInfo: "500ml 食品级材质",
    styleUnified: false,
    language: "zh",
    ratio: "reference",
    size: "1K",
  };

  // Missing Idempotency-Key
  expectError(await f.app.request("POST", "/api/replicas", { body: basePayload }), 400, "MISSING_IDEMPOTENCY_KEY");

  // 0 references
  expectError(
    await f.app.request("POST", "/api/replicas", {
      headers: { "Idempotency-Key": "val-empty-refs" },
      body: { ...basePayload, references: [] },
    }),
    400,
    "REPLICA_REFERENCES_REQUIRED",
  );

  // 7 references (>6)
  const sevenRefs = await Promise.all(
    Array.from({ length: 7 }, async (_, i) => ({
      filename: `r${i}.png`,
      mimeType: "image/png",
      bytesBase64: (await makePng(32, 32, { r: i * 30, g: 10, b: 20 })).toString("base64"),
    })),
  );
  expectError(
    await f.app.request("POST", "/api/replicas", {
      headers: { "Idempotency-Key": "val-too-many-refs" },
      body: { ...basePayload, references: sevenRefs },
    }),
    400,
    "REPLICA_TOO_MANY_REFERENCES",
  );

  // Duplicate reference sha256
  expectError(
    await f.app.request("POST", "/api/replicas", {
      headers: { "Idempotency-Key": "val-dup-ref" },
      body: {
        ...basePayload,
        references: [
          { filename: "a.png", mimeType: "image/png", bytesBase64: ref1.toString("base64") },
          { filename: "b.png", mimeType: "image/png", bytesBase64: ref1.toString("base64") },
        ],
      },
    }),
    409,
    "DUPLICATE_IMAGE",
  );

  // Remark > 200 chars
  expectError(
    await f.app.request("POST", "/api/replicas", {
      headers: { "Idempotency-Key": "val-remark-long" },
      body: {
        ...basePayload,
        references: [{ filename: "a.png", mimeType: "image/png", bytesBase64: ref1.toString("base64"), remark: "字".repeat(201) }],
      },
    }),
    400,
    "REPLICA_REMARK_TOO_LONG",
  );

  // 7 products (>6)
  expectError(
    await f.app.request("POST", "/api/replicas", {
      headers: { "Idempotency-Key": "val-too-many-prods" },
      body: {
        ...basePayload,
        products: Array.from({ length: 7 }, (_, i) => ({
          filename: `p${i}.png`,
          mimeType: "image/png",
          bytesBase64: prod1.toString("base64"),
        })),
      },
    }),
    400,
    "REPLICA_TOO_MANY_PRODUCTS",
  );

  // Invalid sceneType / cloneLevel / language / ratio / size / unifiedRequirement
  expectError(
    await f.app.request("POST", "/api/replicas", {
      headers: { "Idempotency-Key": "val-scene" },
      body: { ...basePayload, sceneType: "creative_poster" },
    }),
    400,
    "REPLICA_INVALID_SCENE_TYPE",
  );
  expectError(
    await f.app.request("POST", "/api/replicas", {
      headers: { "Idempotency-Key": "val-clone" },
      body: { ...basePayload, cloneLevel: "exact" },
    }),
    400,
    "REPLICA_INVALID_CLONE_LEVEL",
  );
  expectError(
    await f.app.request("POST", "/api/replicas", {
      headers: { "Idempotency-Key": "val-lang" },
      body: { ...basePayload, language: "ja" },
    }),
    400,
    "REPLICA_INVALID_LANGUAGE",
  );
  expectError(
    await f.app.request("POST", "/api/replicas", {
      headers: { "Idempotency-Key": "val-ratio" },
      body: { ...basePayload, ratio: "5:7" },
    }),
    400,
    "REPLICA_INVALID_RATIO",
  );
  expectError(
    await f.app.request("POST", "/api/replicas", {
      headers: { "Idempotency-Key": "val-size" },
      body: { ...basePayload, size: "8K" },
    }),
    400,
    "IMAGE_SIZE_UNSUPPORTED",
  );
  // 4K is explicitly rejected in phase 1 even when model imageOptions includes 4K
  expectError(
    await f.app.request("POST", "/api/replicas", {
      headers: { "Idempotency-Key": "val-size-4k" },
      body: { ...basePayload, size: "4K" },
    }),
    400,
    "IMAGE_SIZE_UNSUPPORTED",
  );
  // Oversized base64 rejected before Buffer.from decoding for both reference and product uploads
  const oversizedBase64 = "A".repeat(REPLICA_MAX_BASE64_CHARS + 4);
  expectError(
    await f.app.request("POST", "/api/replicas", {
      headers: { "Idempotency-Key": "val-oversized-ref-b64" },
      body: {
        ...basePayload,
        references: [{ filename: "huge.png", mimeType: "image/png", bytesBase64: oversizedBase64 }],
      },
    }),
    400,
    "IMAGE_TOO_LARGE",
  );
  expectError(
    await f.app.request("POST", "/api/replicas", {
      headers: { "Idempotency-Key": "val-oversized-prod-b64" },
      body: {
        ...basePayload,
        products: [{ filename: "huge-prod.png", mimeType: "image/png", bytesBase64: oversizedBase64 }],
      },
    }),
    400,
    "IMAGE_TOO_LARGE",
  );
  expectError(
    await f.app.request("POST", "/api/replicas", {
      headers: { "Idempotency-Key": "val-req-long" },
      body: { ...basePayload, unifiedRequirement: "要".repeat(1001) },
    }),
    400,
    "REPLICA_REQUIREMENT_TOO_LONG",
  );

  // Library resource policy: non-product image rejected, draft product image rejected
  const now = new Date().toISOString();
  await f.storage.put({ key: "lib/task-ver.png", bytes: prod1, contentType: "image/png" });
  await f.storage.put({ key: "lib/draft-base.png", bytes: prod1, contentType: "image/png" });
  f.libraryRepository.addResource({
    id: "task-version:1",
    resourceType: "task_image_version",
    title: "生成图",
    summary: "",
    mimeType: "image/png",
    previewUrl: null,
    suiteId: null,
    taskId: null,
    imageVersionId: "v1",
    baseVersionId: null,
    templateVersionId: null,
    resourceVersionId: "v1",
    stage: "task_image",
    source: { objectKey: "lib/task-ver.png" },
    status: "published",
    createdAt: now,
    updatedAt: now,
  });
  f.libraryRepository.addResource({
    id: "base:draft-1",
    resourceType: "base_image",
    title: "未发布白底图",
    summary: "",
    mimeType: "image/png",
    previewUrl: null,
    suiteId: null,
    taskId: null,
    imageVersionId: null,
    baseVersionId: "b1",
    templateVersionId: null,
    resourceVersionId: "b1",
    stage: null,
    source: { objectKey: "lib/draft-base.png" },
    status: "draft",
    createdAt: now,
    updatedAt: now,
  });

  expectError(
    await f.app.request("POST", "/api/replicas", {
      headers: { "Idempotency-Key": "val-lib-non-product" },
      body: { ...basePayload, products: [{ libraryResourceId: "task-version:1" }] },
    }),
    400,
    "REPLICA_LIBRARY_PRODUCTS_UNSUPPORTED",
  );

  expectError(
    await f.app.request("POST", "/api/replicas", {
      headers: { "Idempotency-Key": "val-lib-draft" },
      body: { ...basePayload, products: [{ libraryResourceId: "base:draft-1" }] },
    }),
    400,
    "REPLICA_LIBRARY_PRODUCTS_UNSUPPORTED",
  );

  expectError(
    await f.app.request("POST", "/api/replicas", {
      headers: { "Idempotency-Key": "val-lib-source-kind" },
      body: {
        ...basePayload,
        products: [{ sourceKind: "library", filename: "a.png", mimeType: "image/png", bytesBase64: ref1.toString("base64") }],
      },
    }),
    400,
    "REPLICA_LIBRARY_PRODUCTS_UNSUPPORTED",
  );

  // Confirm validation failures did not create any suite
  assert.equal((await f.repository.listSuites()).length, 0);

  // Idempotency: duplicate Idempotency-Key returns same { suiteId, runId } without re-running LLM
  const validPayload = {
    ...basePayload,
    references: [{ filename: "ref2.png", mimeType: "image/png", bytesBase64: ref2.toString("base64") }],
  };
  const first = await f.app.request("POST", "/api/replicas", {
    headers: { "Idempotency-Key": "idem-key-1" },
    body: validPayload,
  });
  assert.equal(first.status, 201);
  const firstData = (first.body as any).data;
  assert.ok(firstData.suiteId);
  assert.ok(firstData.runId);

  const second = await f.app.request("POST", "/api/replicas", {
    headers: { "Idempotency-Key": "idem-key-1" },
    body: validPayload,
  });
  assert.equal(second.status, 200);
  assert.deepEqual((second.body as any).data, firstData);

  await waitStudioState(f.app, firstData.suiteId, (state) => state.pipeline?.status === "completed");
  assert.equal(f.llmCalls.length, 1);
  assert.equal(f.providerCalls.length, 1);
});

test("replica end-to-end flow: card count, input order, role prefix, ratio=reference size freezing, preview, rename, feed & canvas isolation", async () => {
  const f = await replicaFixture();
  // Reference 1: 3:4 portrait (120x160); Reference 2: 16:9 landscape (160x90)
  const ref1Bytes = await makePng(120, 160, { r: 10, g: 20, b: 30 });
  const ref2Bytes = await makeJpeg(160, 90, { r: 80, g: 40, b: 10 });
  // Product 1 & Product 2: locally uploaded product images
  const prodUploadBytes = await makePng(80, 80, { r: 210, g: 210, b: 210 });
  const prodUpload2Bytes = await makePng(90, 90, { r: 245, g: 245, b: 245 });

  const created = await f.app.request("POST", "/api/replicas", {
    headers: { "Idempotency-Key": "e2e-replica-1" },
    body: {
      references: [
        { filename: "ref-portrait.png", mimeType: "image/png", bytesBase64: ref1Bytes.toString("base64"), remark: "保留顶部标题" },
        { filename: "ref-wide.jpg", mimeType: "image/jpeg", bytesBase64: ref2Bytes.toString("base64"), remark: "横向氛围" },
      ],
      products: [
        { filename: "cup-front.png", mimeType: "image/png", bytesBase64: prodUploadBytes.toString("base64") },
        { filename: "cup-side.png", mimeType: "image/png", bytesBase64: prodUpload2Bytes.toString("base64") },
      ],
      sceneType: "ecommerce_product",
      cloneLevel: "high",
      unifiedRequirement: "干净高端金属质感",
      productInfo: "316不锈钢内胆，500ml",
      styleUnified: true,
      language: "zh",
      ratio: "reference",
      size: "1K",
    },
  });
  assert.equal(created.status, 201);
  const { suiteId, runId } = (created.body as any).data;
  assert.ok(suiteId);
  assert.ok(runId);

  const state = await waitStudioState(f.app, suiteId, (data) => data.pipeline?.status === "completed");
  assert.equal(state.suite.origin, "replica");
  assert.equal(state.suite.name, "钛合金保温杯");
  assert.equal(state.pipeline.currentPhase, "done");
  assert.equal(state.styleSketch, false);
  assert.equal(state.cards.length, 2);
  assert.equal(state.progress.total, 2);
  assert.equal(state.progress.completed, 2);

  // Verify studio-state cards & reference previews
  for (const card of state.cards) {
    assert.ok(card.replicaReferenceId);
    assert.equal(card.replicaReferenceThumbnailUrl, `/api/replicas/${suiteId}/references/${card.replicaReferenceId}/preview`);
    assert.equal(card.styleSketch, false);
    assert.ok(card.templateVersionId);
    assert.equal(card.promptSnapshot.cloneLevel, "high");
    assert.equal(card.promptSnapshot.sceneType, "ecommerce_product");
    assert.equal(card.promptSnapshot.language, "zh");
    assert.ok(typeof card.promptSnapshot.sharedStyle === "string" && card.promptSnapshot.sharedStyle.length > 0);
    assert.ok(Array.isArray(card.promptSnapshot.copy) && card.promptSnapshot.copy.length > 0);
    assert.ok(card.promptSnapshot.visualStructure && typeof card.promptSnapshot.visualStructure === "object");

    const previewRes = await f.app.request("GET", card.replicaReferenceThumbnailUrl);
    assert.equal(previewRes.status, 200);
    assert.ok(previewRes.raw && previewRes.raw.length > 0);
    const originalRes = await f.app.request("GET", `${card.replicaReferenceThumbnailUrl}?kind=original`);
    assert.equal(originalRes.status, 200);
    assert.ok(originalRes.raw && originalRes.raw.length > 0);
  }
  expectError(await f.app.request("GET", `/api/replicas/${suiteId}/references/missing-ref/preview`), 404, "REPLICA_REFERENCE_NOT_FOUND");

  // Verify provider calls: 2 calls, each with 3 images [product1, product2, reference], role prefix, and frozen size
  assert.equal(f.providerCalls.length, 2);
  const sizesReceived = new Set(f.providerCalls.map((call) => call.size));
  assert.deepEqual(sizesReceived, new Set(["1024x1360", "1824x1024"]));
  for (const call of f.providerCalls) {
    assert.equal(call.images?.length, 3);
    assert.deepEqual(
      call.images?.map((img) => img.role),
      ["product_primary", "product_detail", "replica_reference"],
    );
    assert.equal(Buffer.compare(call.images![0].bytes, prodUploadBytes), 0);
    assert.equal(Buffer.compare(call.images![1].bytes, prodUpload2Bytes), 0);
    assert.equal(call.images![0].filename, "cup-front.png");
    assert.equal(call.images![1].filename, "cup-side.png");
    assert.match(
      call.prompt,
      /^第1–2张图为产品外观唯一依据；第3张图为构图与版式基准：保持其构图、元素位置、镜头与光影，只替换为目标商品和新文案，不得复制其中的品牌、Logo、文字与真人肖像。/,
    );
  }

  // Verify frozen size in attempts
  const tasks = await f.taskRepository.listTasks(suiteId);
  assert.equal(tasks.length, 2);
  const task1History = await f.taskRepository.listTaskVersions(tasks[0].id);
  const task2History = await f.taskRepository.listTaskVersions(tasks[1].id);
  assert.equal(task1History.attempts[0].requestSummary.size, "1024x1360");
  assert.equal(task2History.attempts[0].requestSummary.size, "1824x1024");

  // Verify canvas styleOverride does NOT affect replica single-card regeneration, and input order stays [prod1, prod2, ref]
  await f.repository.updateSuiteStyleOverride(suiteId, "暗黑赛博朋克覆盖风格");
  const regen = await f.app.request("POST", `/api/suite-tasks/${tasks[0].id}/generation`, {
    headers: { "Idempotency-Key": "regen-replica-card-1" },
    body: { promptDraft: "编辑后的纯净棚拍提示词" },
  });
  assert.equal(regen.status, 202);
  const regenBatchId = (regen.body as any).data.batchId;
  for (let i = 0; i < 100; i += 1) {
    const batch = await f.taskRepository.getBatch(regenBatchId);
    if (batch && batch.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const regenCall = f.providerCalls[2];
  assert.ok(regenCall);
  assert.equal(regenCall.images?.length, 3);
  assert.deepEqual(
    regenCall.images?.map((img) => img.role),
    ["product_primary", "product_detail", "replica_reference"],
  );
  assert.match(
    regenCall.prompt,
    /^第1–2张图为产品外观唯一依据；第3张图为构图与版式基准：保持其构图、元素位置、镜头与光影，只替换为目标商品和新文案，不得复制其中的品牌、Logo、文字与真人肖像。/,
  );
  assert.match(regenCall.prompt, /编辑后的纯净棚拍提示词/);
  assert.doesNotMatch(regenCall.prompt, /暗黑赛博朋克覆盖风格/);

  // Rename replica batch via PATCH /api/suites/:id
  const renamed = await f.app.request("PATCH", `/api/suites/${suiteId}`, { body: { name: "夏季保温杯复刻" } });
  assert.equal(renamed.status, 200);
  assert.equal((renamed.body as any).data.name, "夏季保温杯复刻");

  // Canvas list excludes replica batch; feed?origin=replica includes it
  const canvasList = await f.app.request("GET", "/api/suites?view=canvas");
  assert.equal(canvasList.status, 200);
  assert.equal((canvasList.body as any).data.some((item: { id: string }) => item.id === suiteId), false);

  const replicaFeed = await f.app.request("GET", "/api/suites/feed?origin=replica");
  assert.equal(replicaFeed.status, 200);
  assert.equal((replicaFeed.body as any).data.total, 1);
  assert.equal((replicaFeed.body as any).data.items[0].suite.id, suiteId);
  assert.equal((replicaFeed.body as any).data.items[0].suite.name, "夏季保温杯复刻");
});

test("replica without product images ignores LLM taskName, falls back to scene · timestamp, sets styleSketch=true, and uses style-only role prefix", async () => {
  const f = await replicaFixture({
    llmResponder: async (input) => ({
      schemaVersion: "replica-prompt-v1",
      taskName: "模型擅自编造的商品名",
      sharedStyle: null,
      items: input.references.map((ref) => ({
        referenceId: ref.referenceId,
        visualStructure: { composition: "居中构图", textBlocks: ["主标题"] },
        copy: [{ role: "title", text: "春日穿搭灵感" }],
        prompt: "极简浅灰棚拍背景，通用示意针织开衫平铺展示，柔和漫射光。",
      })),
    }),
  });
  const refBytes = await makePng(100, 100, { r: 90, g: 120, b: 150 });
  const created = await f.app.request("POST", "/api/replicas", {
    headers: { "Idempotency-Key": "style-sketch-1" },
    body: {
      references: [{ filename: "look.png", mimeType: "image/png", bytesBase64: refBytes.toString("base64") }],
      products: [],
      sceneType: "apparel",
      cloneLevel: "compose",
      styleUnified: false,
      language: "zh",
      ratio: "3:4",
      size: "2K",
    },
  });
  assert.equal(created.status, 201);
  const { suiteId } = (created.body as any).data;

  const state = await waitStudioState(f.app, suiteId, (data) => data.pipeline?.status === "completed");
  assert.match(state.suite.name, /^服饰电商图 · \d{2}-\d{2} \d{2}:\d{2}$/);
  assert.notEqual(state.suite.name, "模型擅自编造的商品名");
  assert.equal(state.styleSketch, true);
  assert.equal(state.cards.length, 1);
  assert.equal(state.cards[0].styleSketch, true);

  assert.equal(f.providerCalls.length, 1);
  assert.equal(f.providerCalls[0].images?.length, 1);
  assert.equal(f.providerCalls[0].images?.[0].role, "replica_reference");
  assert.equal(f.providerCalls[0].size, "2048x2736");
  assert.match(
    f.providerCalls[0].prompt,
    /^输入图仅用于理解姿势与构图类型，不得沿用其中的人物、服装、陈设、配色、光线、品牌与文字，按下方描述重新设计画面，生成同风格的通用示意商品，不得出现可识别品牌。/,
  );
  const composeNoProdTasks = await f.taskRepository.listTasks(suiteId);
  const composeNoProdHistory = await f.taskRepository.listTaskVersions(composeNoProdTasks[0].id);
  assert.deepEqual(composeNoProdHistory.attempts[0].requestSummary.inputRoles, ["replica_reference"]);
  assert.equal((composeNoProdHistory.attempts[0].promptSnapshot.inputImages as Array<{ role: string }>).length, 1);
  assert.equal((composeNoProdHistory.attempts[0].promptSnapshot.inputImages as Array<{ role: string }>)[0].role, "replica_reference");
});

test("replica compose with product images omits reference image on initial, single-card regen, edited regen, and retry; high zero-product keeps high sketch prefix", async () => {
  const f = await replicaFixture();

  const waitBatchDone = async (batchId: string) => {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const res = await f.app.request("GET", `/api/generation-batches/${batchId}`);
      if ((res.body as any).data.batch.status !== "running") return (res.body as any).data;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("batch timeout");
  };

  const refBytes = await makePng(100, 120, { r: 20, g: 40, b: 60 });
  const prod1Bytes = await makePng(80, 80, { r: 210, g: 215, b: 220 });
  const prod2Bytes = await makePng(80, 80, { r: 190, g: 195, b: 200 });

  // 1. compose + 2 products: provider receives ONLY product images, no replica_reference, with compose prefix
  const createdCompose = await f.app.request("POST", "/api/replicas", {
    headers: { "Idempotency-Key": "compose-with-products-1" },
    body: {
      references: [{ filename: "ref-compose.png", mimeType: "image/png", bytesBase64: refBytes.toString("base64") }],
      products: [
        { filename: "prod-1.png", mimeType: "image/png", bytesBase64: prod1Bytes.toString("base64") },
        { filename: "prod-2.png", mimeType: "image/png", bytesBase64: prod2Bytes.toString("base64") },
      ],
      sceneType: "ecommerce_product",
      cloneLevel: "compose",
      styleUnified: false,
      language: "zh",
      ratio: "1:1",
      size: "1K",
    },
  });
  assert.equal(createdCompose.status, 201);
  const { suiteId: composeSuiteId } = (createdCompose.body as any).data;

  const composeState = await waitStudioState(f.app, composeSuiteId, (data) => data.pipeline?.status === "completed");
  assert.equal(composeState.cards.length, 1);
  const composeTaskId = composeState.cards[0].parentTaskId;
  // Reference thumbnail remains available on card metadata even though reference image is omitted from image-edit input
  assert.ok(composeState.cards[0].replicaReferenceId);

  const initialCall = f.providerCalls[0];
  assert.equal(initialCall.images?.length, 2);
  assert.deepEqual(
    initialCall.images?.map((img) => img.role),
    ["product_primary", "product_detail"],
  );
  assert.equal(Buffer.compare(initialCall.images![0].bytes, prod1Bytes), 0);
  assert.equal(Buffer.compare(initialCall.images![1].bytes, prod2Bytes), 0);
  assert.match(initialCall.prompt, /^第1–2张图为产品外观唯一依据，按下方描述重新设计画面。/);

  const history1 = await f.taskRepository.listTaskVersions(composeTaskId);
  assert.equal(history1.attempts[0].requestSummary.imageCount, 2);
  assert.deepEqual(history1.attempts[0].requestSummary.inputRoles, ["product_primary", "product_detail"]);
  assert.deepEqual(
    (history1.attempts[0].promptSnapshot.inputImages as Array<{ role: string }>).map((item) => item.role),
    ["product_primary", "product_detail"],
  );
  assert.deepEqual(
    (history1.attempts[0].contextSnapshot.inputImages as Array<{ role: string }>).map((item) => item.role),
    ["product_primary", "product_detail"],
  );
  assert.equal(history1.attempts[0].promptSnapshot.cloneLevel, "compose");
  assert.ok(history1.attempts[0].sourceObjectKey.includes("/products/"));

  // 2. Single-card regenerate (original prompt) follows the same compose rule
  const regenOrig = await f.app.request("POST", `/api/suite-tasks/${composeTaskId}/generation`, {
    headers: { "Idempotency-Key": "compose-regen-orig-1" },
    body: {},
  });
  assert.equal(regenOrig.status, 202);
  const regenOrigBatch = await waitBatchDone((regenOrig.body as any).data.batchId);
  assert.equal(regenOrigBatch.batch.status, "completed");
  const regenOrigCall = f.providerCalls[1];
  assert.equal(regenOrigCall.images?.length, 2);
  assert.deepEqual(
    regenOrigCall.images?.map((img) => img.role),
    ["product_primary", "product_detail"],
  );
  assert.match(regenOrigCall.prompt, /^第1–2张图为产品外观唯一依据，按下方描述重新设计画面。/);

  // 3. Single-card regenerate with edited prompt follows the same compose rule & freezes actual inputs
  const editedComposePrompt = "暖橡木桌面重新设计的自然光棚拍场景，主体居中展示，浅米色极简背景。";
  const regenEdited = await f.app.request("POST", `/api/suite-tasks/${composeTaskId}/generation`, {
    headers: { "Idempotency-Key": "compose-regen-edited-1" },
    body: { promptDraft: editedComposePrompt },
  });
  assert.equal(regenEdited.status, 202);
  const regenEditedBatch = await waitBatchDone((regenEdited.body as any).data.batchId);
  assert.equal(regenEditedBatch.batch.status, "completed");
  const regenEditedCall = f.providerCalls[2];
  assert.equal(regenEditedCall.images?.length, 2);
  assert.deepEqual(
    regenEditedCall.images?.map((img) => img.role),
    ["product_primary", "product_detail"],
  );
  assert.match(regenEditedCall.prompt, /^第1–2张图为产品外观唯一依据，按下方描述重新设计画面。/);
  assert.ok(regenEditedCall.prompt.includes(editedComposePrompt));
  assert.deepEqual(regenEditedBatch.attempts[0].requestSummary.inputRoles, ["product_primary", "product_detail"]);
  assert.deepEqual(
    (regenEditedBatch.attempts[0].promptSnapshot.inputImages as Array<{ role: string }>).map((item) => item.role),
    ["product_primary", "product_detail"],
  );

  // 4. Failed attempt retry follows the same compose rule (both failed attempt and retried attempt omit reference image)
  let failAllRetries = true;
  const retryFixture = await replicaFixture({
    providerEdit: async (_request, _call, defaultPng) => {
      if (failAllRetries) throw new Error("IMAGE_PROVIDER_FAILED");
      return { bytes: defaultPng, mimeType: "image/png" };
    },
  });
  const createdFail = await retryFixture.app.request("POST", "/api/replicas", {
    headers: { "Idempotency-Key": "compose-retry-1" },
    body: {
      references: [{ filename: "ref-retry.png", mimeType: "image/png", bytesBase64: refBytes.toString("base64") }],
      products: [{ filename: "prod-only.png", mimeType: "image/png", bytesBase64: prod1Bytes.toString("base64") }],
      sceneType: "ecommerce_product",
      cloneLevel: "compose",
      styleUnified: false,
      language: "zh",
      ratio: "1:1",
      size: "1K",
    },
  });
  assert.equal(createdFail.status, 201);
  const { suiteId: retrySuiteId } = (createdFail.body as any).data;
  await waitStudioState(retryFixture.app, retrySuiteId, (data) => data.pipeline?.status === "failed");

  const retryTasks = await retryFixture.taskRepository.listTasks(retrySuiteId);
  const failedHistory = await retryFixture.taskRepository.listTaskVersions(retryTasks[0].id);
  const failedAttempt = failedHistory.attempts[0];
  assert.equal(failedAttempt.status, "failed");
  assert.deepEqual(failedAttempt.requestSummary.inputRoles, ["product_primary"]);
  assert.deepEqual(
    (failedAttempt.promptSnapshot.inputImages as Array<{ role: string }>).map((item) => item.role),
    ["product_primary"],
  );
  assert.match(String(failedAttempt.promptSnapshot.finalPrompt), /^第1张图为产品外观唯一依据，按下方描述重新设计画面。/);

  failAllRetries = false;
  const callsBeforeRetry = retryFixture.providerCalls.length;
  const retryRes = await retryFixture.app.request("POST", `/api/generation-attempts/${failedAttempt.id}/retry`, {
    headers: { "Idempotency-Key": "retry-compose-attempt-1" },
  });
  assert.equal(retryRes.status, 202);
  const retryBatchId = (retryRes.body as any).data.batchId;
  const retryDeadline = Date.now() + 3_000;
  let retryBatchData: any;
  while (Date.now() < retryDeadline) {
    const res = await retryFixture.app.request("GET", `/api/generation-batches/${retryBatchId}`);
    retryBatchData = (res.body as any).data;
    if (retryBatchData.batch.status !== "running") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(retryBatchData.batch.status, "completed");
  const retryProviderCall = retryFixture.providerCalls[callsBeforeRetry];
  assert.ok(retryProviderCall);
  assert.equal(retryProviderCall.images?.length, 1);
  assert.deepEqual(
    retryProviderCall.images?.map((img) => img.role),
    ["product_primary"],
  );
  assert.match(retryProviderCall.prompt, /^第1张图为产品外观唯一依据，按下方描述重新设计画面。/);
  assert.deepEqual(retryBatchData.attempts[0].requestSummary.inputRoles, ["product_primary"]);

  // 5. Fallback cloneLevel from frozen replicaPromptSnapshot when top-level generationParams.cloneLevel is absent
  const taskRecord = await retryFixture.taskRepository.getTask(retryTasks[0].id);
  assert.ok(taskRecord);
  delete taskRecord.generationParams.cloneLevel;
  const callsBeforeSnapshotFallback = retryFixture.providerCalls.length;
  const fallbackRegen = await retryFixture.app.request("POST", `/api/suite-tasks/${retryTasks[0].id}/generation`, {
    headers: { "Idempotency-Key": "compose-snapshot-fallback-1" },
    body: {},
  });
  assert.equal(fallbackRegen.status, 202);
  const fbBatchId = (fallbackRegen.body as any).data.batchId;
  const fbDeadline = Date.now() + 3_000;
  while (Date.now() < fbDeadline) {
    const res = await retryFixture.app.request("GET", `/api/generation-batches/${fbBatchId}`);
    if ((res.body as any).data.batch.status !== "running") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  const fbCall = retryFixture.providerCalls[callsBeforeSnapshotFallback];
  assert.equal(fbCall.images?.length, 1);
  assert.deepEqual(
    fbCall.images?.map((img) => img.role),
    ["product_primary"],
  );
  assert.match(fbCall.prompt, /^第1张图为产品外观唯一依据，按下方描述重新设计画面。/);

  // 6. high + zero product images retains reference image and uses high zero-product prefix
  const highNoProdCreated = await f.app.request("POST", "/api/replicas", {
    headers: { "Idempotency-Key": "high-zero-products-1" },
    body: {
      references: [{ filename: "ref-high-sketch.png", mimeType: "image/png", bytesBase64: refBytes.toString("base64") }],
      products: [],
      sceneType: "marketing_poster",
      cloneLevel: "high",
      styleUnified: false,
      language: "zh",
      ratio: "1:1",
      size: "1K",
    },
  });
  assert.equal(highNoProdCreated.status, 201);
  const { suiteId: highSketchSuiteId } = (highNoProdCreated.body as any).data;
  await waitStudioState(f.app, highSketchSuiteId, (data) => data.pipeline?.status === "completed");
  const highSketchCall = f.providerCalls[3];
  assert.equal(highSketchCall.images?.length, 1);
  assert.deepEqual(
    highSketchCall.images?.map((img) => img.role),
    ["replica_reference"],
  );
  assert.match(
    highSketchCall.prompt,
    /^输入图仅作为版式与风格参考，保持构图与元素位置，不得复制其中的品牌、文字与人物，请生成同风格的通用示意商品，不得出现可识别品牌。/,
  );
});

test("analysis failure can be resumed via POST /api/replicas/:suiteId/resume and succeeds", async () => {
  let failAnalysis = true;
  const f = await replicaFixture({
    llmResponder: async (input) => {
      if (failAnalysis) {
        // Invalid output missing items triggers REPLICA_OUTPUT_INVALID
        return { schemaVersion: "replica-prompt-v1", taskName: "", sharedStyle: null, items: [] };
      }
      return {
        schemaVersion: "replica-prompt-v1",
        taskName: "陶瓷马克杯",
        sharedStyle: null,
        items: input.references.map((ref) => ({
          referenceId: ref.referenceId,
          visualStructure: { composition: "桌面特写" },
          copy: [],
          prompt: "米白色陶瓷马克杯置于木质餐桌，暖阳斜照。",
        })),
      };
    },
  });

  const refBytes = await makePng(100, 100, { r: 60, g: 70, b: 80 });
  const prodBytes = await makePng(80, 80, { r: 230, g: 220, b: 210 });
  const created = await f.app.request("POST", "/api/replicas", {
    headers: { "Idempotency-Key": "analysis-fail-resume-1" },
    body: {
      references: [{ filename: "mug-ref.png", mimeType: "image/png", bytesBase64: refBytes.toString("base64") }],
      products: [{ filename: "mug.png", mimeType: "image/png", bytesBase64: prodBytes.toString("base64") }],
      sceneType: "ecommerce_product",
      cloneLevel: "high",
      language: "zh",
      ratio: "1:1",
      size: "1K",
    },
  });
  assert.equal(created.status, 201);
  const { suiteId } = (created.body as any).data;

  const failedState = await waitStudioState(f.app, suiteId, (data) => data.pipeline?.status === "failed");
  assert.equal(failedState.pipeline.currentPhase, "replica_analyzing");
  assert.equal(failedState.pipeline.errorCode, "REPLICA_OUTPUT_INVALID");
  assert.equal(failedState.cards.length, 0);

  // Feed taskCount falls back to configured referenceCount before tasks are materialized
  const preTaskFeed = await f.app.request("GET", "/api/suites/feed?origin=replica");
  assert.equal(preTaskFeed.status, 200);
  const feedEntry = (preTaskFeed.body as any).data.items.find((item: { suite: { id: string } }) => item.suite.id === suiteId);
  assert.ok(feedEntry);
  assert.equal(feedEntry.taskCount, 1);

  failAnalysis = false;
  const resumed = await f.app.request("POST", `/api/replicas/${suiteId}/resume`, {
    headers: { "Idempotency-Key": "resume-analysis-1" },
  });
  assert.equal(resumed.status, 202);

  const completedState = await waitStudioState(f.app, suiteId, (data) => data.pipeline?.status === "completed");
  assert.equal(completedState.pipeline.currentPhase, "done");
  assert.equal(completedState.suite.name, "陶瓷马克杯");
  assert.equal(completedState.cards.length, 1);
  assert.equal(f.llmCalls.length, 2);
  assert.equal(f.providerCalls.length, 1);
});

for (const error of ["IMAGE_PROVIDER_FAILED", "IMAGE_PROVIDER_TIMEOUT", "INVALID_PROVIDER_RESPONSE"]) {
  test(`复刻遇到 ${error} 停止出图，手动继续时跳过已有版本`, async () => {
    let failCard2 = true;
    const generatedCardTitles: string[] = [];
    const f = await replicaFixture({
      providerEdit: async (request, _call, defaultPng) => {
        const isCard2 = request.prompt.includes("卡 2");
        generatedCardTitles.push(isCard2 ? "card-2" : "card-1");
        if (isCard2 && failCard2) {
          throw new Error(error);
        }
        return { bytes: defaultPng, mimeType: "image/png" };
      },
    });

    const ref1 = await makePng(80, 80, { r: 15, g: 25, b: 35 });
    const ref2 = await makePng(80, 80, { r: 35, g: 45, b: 55 });
    const prod = await makePng(64, 64, { r: 220, g: 210, b: 200 });

    const created = await f.app.request("POST", "/api/replicas", {
      headers: { "Idempotency-Key": "interrupt-resume-1" },
      body: {
        references: [
          { filename: "ref1.png", mimeType: "image/png", bytesBase64: ref1.toString("base64") },
          { filename: "ref2.png", mimeType: "image/png", bytesBase64: ref2.toString("base64") },
        ],
        products: [{ filename: "prod.png", mimeType: "image/png", bytesBase64: prod.toString("base64") }],
        sceneType: "social_post",
        cloneLevel: "compose",
        styleUnified: true,
        language: "zh",
        ratio: "1:1",
        size: "1K",
      },
    });
    assert.equal(created.status, 201);
    const { suiteId, runId } = (created.body as any).data;

    // Wait for partial_failed (card 1 succeeded, card 2 failed)
    const partialState = await waitStudioState(f.app, suiteId, (data) => data.pipeline?.status === "partial_failed");
    assert.equal(partialState.cards.length, 2);
    assert.equal(partialState.progress.completed, 1);

    // Simulate server restart interrupt state in image_generating phase
    await f.pipelineRepository.updateRun(runId, {
      status: "failed",
      currentPhase: "image_generating",
      errorCode: "PIPELINE_INTERRUPTED",
      errorMessage: "生成服务中断，请继续流水线",
    });

    const callsBeforeResume = generatedCardTitles.length;
    assert.deepEqual(generatedCardTitles.filter((title) => title === "card-2"), ["card-2"]);
    failCard2 = false;
    const resumed = await f.app.request("POST", `/api/replicas/${suiteId}/resume`, {
      headers: { "Idempotency-Key": "resume-images-1" },
    });
    assert.equal(resumed.status, 202);

    const completedState = await waitStudioState(f.app, suiteId, (data) => data.pipeline?.status === "completed");
    assert.equal(completedState.pipeline.currentPhase, "done");
    assert.equal(completedState.progress.completed, 2);
    // LLM was NOT re-called during image resume
    assert.equal(f.llmCalls.length, 1);
    // Only card 2 was generated after resume; card 1 was skipped
    const callsAfterResume = generatedCardTitles.slice(callsBeforeResume);
    assert.deepEqual(callsAfterResume, ["card-2"]);
  });
}

test("editing replica card prompt and regenerating creates a new version with frozen snapshots", async () => {
  const f = await replicaFixture();
  const ref1 = await makePng(80, 80, { r: 25, g: 45, b: 65 });
  const prod1 = await makePng(64, 64, { r: 210, g: 215, b: 220 });

  const created = await f.app.request("POST", "/api/replicas", {
    headers: { "Idempotency-Key": "edit-prompt-regen-1" },
    body: {
      references: [{ filename: "ref-edit.png", mimeType: "image/png", bytesBase64: ref1.toString("base64") }],
      products: [{ filename: "prod-edit.png", mimeType: "image/png", bytesBase64: prod1.toString("base64") }],
      sceneType: "ecommerce_product",
      cloneLevel: "high",
      language: "zh",
      ratio: "1:1",
      size: "1K",
    },
  });
  assert.equal(created.status, 201);
  const { suiteId } = (created.body as any).data;

  const initialState = await waitStudioState(f.app, suiteId, (data) => data.pipeline?.status === "completed");
  assert.equal(initialState.cards.length, 1);
  const card = initialState.cards[0];
  assert.equal(card.versionNumber, 1);
  assert.equal(card.promptRevision, 1);
  const originalDraft = card.promptDraft;
  assert.ok(typeof originalDraft === "string" && originalDraft.includes("钛合金保温杯"));

  // Regenerate with edited promptDraft
  const editedPrompt = "暖木桌面近景特写钛合金保温杯，柔和晨光勾勒金属拉丝质感，顶部简洁留白。";
  const regen = await f.app.request("POST", `/api/suite-tasks/${card.parentTaskId}/generation`, {
    headers: { "Idempotency-Key": "regen-edited-prompt-1" },
    body: { promptDraft: editedPrompt },
  });
  assert.equal(regen.status, 202);
  const { batchId } = (regen.body as any).data;

  // Wait for batch completion
  const deadline = Date.now() + 3_000;
  let batchStatus = "running";
  while (Date.now() < deadline && batchStatus === "running") {
    const res = await f.app.request("GET", `/api/generation-batches/${batchId}`);
    batchStatus = (res.body as any).data.batch.status;
    if (batchStatus === "running") await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(batchStatus, "completed");

  const versionsRes = await f.app.request("GET", `/api/suite-tasks/${card.parentTaskId}/versions`);
  assert.equal(versionsRes.status, 200);
  const versions = (versionsRes.body as any).data.versions;
  assert.equal(versions.length, 2);

  const v2 = versions.find((v: any) => v.versionNumber === 2);
  const v1 = versions.find((v: any) => v.versionNumber === 1);
  assert.ok(v1 && v2);
  assert.equal(v2.isCurrent, true);
  assert.equal(v1.isCurrent, false);

  // Historical v1 snapshot MUST remain frozen with revision 1 & original prompt
  assert.equal(v1.promptSnapshot.prompt, originalDraft);
  assert.equal(v1.promptSnapshot.promptRevision, 1);
  assert.match(v1.promptSnapshot.finalPrompt, /第1张图为产品外观唯一依据/);
  assert.ok(v1.promptSnapshot.finalPrompt.includes(originalDraft));

  // New v2 snapshot records revision 2 & edited prompt with role prefix
  assert.equal(v2.promptSnapshot.prompt, editedPrompt);
  assert.equal(v2.promptSnapshot.promptRevision, 2);
  assert.match(v2.promptSnapshot.finalPrompt, /第1张图为产品外观唯一依据/);
  assert.ok(v2.promptSnapshot.finalPrompt.includes(editedPrompt));
  assert.equal(v2.promptSnapshot.cloneLevel, "high");
  assert.equal(v2.promptSnapshot.sceneType, "ecommerce_product");
  assert.equal(v2.promptSnapshot.replicaReferenceId, card.replicaReferenceId);

  // studio-state reflects the new current version & promptRevision
  const updatedState = await waitStudioState(f.app, suiteId, (data) => data.cards[0]?.versionNumber === 2);
  assert.equal(updatedState.cards[0].promptRevision, 2);
  assert.equal(updatedState.cards[0].promptDraft, editedPrompt);
  assert.equal(updatedState.cards[0].versionId, v2.id);
});

test("saving replica card as reverse reference asset records replica source provenance and updates on re-save", async () => {
  const f = await replicaFixture();
  const refBytes = await makePng(90, 90, { r: 70, g: 80, b: 90 });
  const prodBytes = await makePng(64, 64, { r: 220, g: 220, b: 220 });

  const created = await f.app.request("POST", "/api/replicas", {
    headers: { "Idempotency-Key": "save-reverse-asset-1" },
    body: {
      references: [{ filename: "hero-ref.png", mimeType: "image/png", bytesBase64: refBytes.toString("base64") }],
      products: [{ filename: "prod.png", mimeType: "image/png", bytesBase64: prodBytes.toString("base64") }],
      sceneType: "apparel",
      cloneLevel: "compose",
      language: "zh",
      ratio: "3:4",
      size: "1K",
    },
  });
  assert.equal(created.status, 201);
  const { suiteId } = (created.body as any).data;

  const state = await waitStudioState(f.app, suiteId, (data) => data.pipeline?.status === "completed");
  const card = state.cards[0];
  const ref = state.replicaReferences[0];

  const saved = await f.app.request("POST", `/api/replicas/${suiteId}/tasks/${card.parentTaskId}/reverse-asset`, {
    headers: { "Idempotency-Key": "replica-reverse-1" },
    body: {},
  });
  assert.equal(saved.status, 201);
  const asset = (saved.body as any).data;
  assert.equal(asset.resourceType, "reverse_reference_asset");
  assert.equal(asset.status, "draft");
  assert.equal(asset.stage, "replica_prompt");
  assert.equal(asset.suiteId, suiteId);
  assert.equal(asset.source.origin, "replica");
  assert.equal(asset.source.replicaSuiteId, suiteId);
  assert.equal(asset.source.suiteId, suiteId);
  assert.equal(asset.source.taskId, card.parentTaskId);
  assert.equal(asset.source.replicaReferenceId, ref.id);
  assert.equal(asset.source.objectKey, ref.objectKey);
  assert.equal(asset.promptSnapshot.prompt, card.promptDraft);
  assert.equal(asset.promptSnapshot.promptRevision, 1);

  // Preview resolves reference image bytes through library proxy
  const preview = await f.app.previewLibraryResource(asset.id);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers?.["content-type"], "image/png");
  assert.ok(preview.raw && preview.raw.length > 0);

  // Updating prompt and saving again upserts the same reference objectKey asset cleanly
  await f.app.request("PATCH", `/api/suite-tasks/${card.parentTaskId}`, {
    body: { promptDraft: "修订后的服饰复刻反推提示词" },
  });
  const resaved = await f.app.request("POST", `/api/replicas/${suiteId}/tasks/${card.parentTaskId}/reverse-asset`, {
    headers: { "Idempotency-Key": "replica-reverse-2" },
    body: {},
  });
  assert.equal(resaved.status, 201);
  const updatedAsset = (resaved.body as any).data;
  assert.equal(updatedAsset.id, asset.id);
  assert.equal(updatedAsset.promptSnapshot.prompt, "修订后的服饰复刻反推提示词");
  assert.equal(updatedAsset.promptSnapshot.promptRevision, 2);

  // Rejects non-replica suite
  const studioSuite = await f.repository.createSuite("普通套图", undefined, "suite_studio");
  expectError(
    await f.app.request("POST", `/api/replicas/${studioSuite.id}/tasks/${card.parentTaskId}/reverse-asset`, {
      body: {},
    }),
    400,
    "INVALID_SUITE_ORIGIN",
  );
});

test("replica single-card final selection, archive soft-delete, ZIP export, and failed card error reporting", async () => {
  let failCard2 = true;
  const f = await replicaFixture({
    providerEdit: async (request, _call, defaultPng) => {
      if (failCard2 && request.prompt.includes("卡 2")) {
        throw new Error("IMAGE_PROVIDER_FAILED");
      }
      return { bytes: defaultPng, mimeType: "image/png" };
    },
  });

  const ref1 = await makePng(64, 64, { r: 10, g: 20, b: 30 });
  const ref2 = await makePng(64, 64, { r: 30, g: 40, b: 50 });
  const prod = await makePng(64, 64, { r: 230, g: 230, b: 230 });

  const created = await f.app.request("POST", "/api/replicas", {
    headers: { "Idempotency-Key": "replica-ops-1" },
    body: {
      references: [
        { filename: "r1.png", mimeType: "image/png", bytesBase64: ref1.toString("base64") },
        { filename: "r2.png", mimeType: "image/png", bytesBase64: ref2.toString("base64") },
      ],
      products: [{ filename: "p.png", mimeType: "image/png", bytesBase64: prod.toString("base64") }],
      sceneType: "ecommerce_product",
      cloneLevel: "high",
      language: "zh",
      ratio: "1:1",
      size: "1K",
    },
  });
  assert.equal(created.status, 201);
  const { suiteId } = (created.body as any).data;

  const partial = await waitStudioState(f.app, suiteId, (data) => data.pipeline?.status === "partial_failed");
  assert.equal(partial.cards.length, 2);
  const card1 = partial.cards[0];
  const card2 = partial.cards[1];
  assert.equal(card1.taskStatus, "generated");
  assert.equal(card2.taskStatus, "failed");
  assert.equal(card2.errorCode, "TASK_IMAGE_PROVIDER_FAILED");
  assert.ok(typeof card2.errorMessage === "string" && card2.errorMessage.length > 0);

  // Mark card1 current version as final (save to library action)
  const finalRes = await f.app.request(
    "POST",
    `/api/suite-tasks/${card1.parentTaskId}/versions/${card1.versionId}/select`,
    {
      headers: { "Idempotency-Key": "select-final-1" },
      body: { selection: "final" },
    },
  );
  assert.equal(finalRes.status, 200);
  assert.equal((finalRes.body as any).data.isFinal, true);

  // Soft-archive card2 via PATCH /api/suite-tasks/:id { status: "archived" }
  const archivedRes = await f.app.request("PATCH", `/api/suite-tasks/${card2.parentTaskId}`, {
    body: { status: "archived" },
  });
  assert.equal(archivedRes.status, 200);
  assert.equal((archivedRes.body as any).data.status, "archived");
  assert.ok((archivedRes.body as any).data.archivedAt, "archivedAt must be populated on soft-archive");

  const afterArchive = await waitStudioState(f.app, suiteId, (data) => data.cards.length === 1);
  assert.equal(afterArchive.cards[0].parentTaskId, card1.parentTaskId);
  assert.equal(afterArchive.cards[0].sourceRole, "parent_final");
  assert.equal(afterArchive.progress.total, 1);

  // ZIP export succeeds for replica batch and includes only the remaining card + manifest.json
  const zipRes = await f.app.request(
    "GET",
    `/api/suites/${suiteId}/delivery/export?taskIds=${encodeURIComponent(card1.parentTaskId)}`,
  );
  assert.equal(zipRes.status, 200);
  assert.ok(zipRes.raw);
  const entries = readZipEntries(zipRes.raw);
  assert.equal([...entries.keys()].filter((name) => /\.(png|jpe?g|webp)$/i.test(name)).length, 1);
  assert.ok(entries.has("manifest.json"));
});

test("PostgresLibraryRepository includes replica task_image_version without filtering by origin and tags origin as replica_prompt", async () => {
  const executedSql: string[] = [];
  const fakePool = {
    query: async (sql: string) => {
      executedSql.push(sql);
      if (sql.includes("FROM suite_workbench.task_image_versions")) {
        return {
          rows: [
            {
              version_id: "ver-replica-1",
              task_id: "task-replica-1",
              object_key: "suites/s1/tasks/task-replica-1/versions/v1/final.png",
              process_object_keys_json: [],
              prompt_snapshot_json: { prompt: "复刻提示词", cloneLevel: "high" },
              model: "gpt-image-2",
              channel: null,
              mime_type: "image/png",
              width: 1024,
              height: 1024,
              version_number: 1,
              created_at: "2026-11-23T08:00:00.000Z",
              suite_id: "suite-replica-1",
              task_title: "复刻图 1",
              image_type: "main",
              prompt_draft: "复刻提示词",
              origin_kind: "replica",
            },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const repo = new PostgresLibraryRepository(fakePool as never);
  const listed = await repo.listResources({ resourceType: "task_image_version", status: "published" });
  assert.equal(listed.total, 1);
  const item = listed.items[0];
  assert.equal(item.id, "task-version:ver-replica-1");
  assert.equal(item.stage, "replica_prompt");
  assert.equal(item.status, "published");
  assert.equal(item.source.origin, "replica");
  assert.equal(item.source.originKind, "replica");
  assert.match(item.summary, /爆品图复刻/);
  assert.equal(
    executedSql.some((sql) => /origin\s*(=|<>|!=|IN)/i.test(sql)),
    false,
    "listResources must not filter out suites by origin",
  );
});

test("replica card image edit and final lock never swallow subsequent regeneration or edits, and edited cards keep replica analysis snapshot", async () => {
  let genCount = 0;
  let failNextGen = false;
  const v1Png = await makePng(32, 32, { r: 10, g: 20, b: 30 });
  const v2Png = await makePng(32, 32, { r: 200, g: 50, b: 50 });
  const v3Png = await makePng(32, 32, { r: 50, g: 50, b: 200 });
  const f = await replicaFixture({
    providerEdit: async () => {
      if (failNextGen) throw new Error("IMAGE_PROVIDER_FAILED");
      genCount += 1;
      return { bytes: genCount === 1 ? v1Png : genCount === 2 ? v2Png : v3Png, mimeType: "image/png" };
    },
  });

  const refBytes = await makePng(64, 64, { r: 80, g: 90, b: 100 });
  const prodBytes = await makePng(64, 64, { r: 220, g: 220, b: 220 });
  const created = await f.app.request("POST", "/api/replicas", {
    headers: { "Idempotency-Key": "replica-edit-regen-flow-1" },
    body: {
      references: [{ filename: "r1.png", mimeType: "image/png", bytesBase64: refBytes.toString("base64") }],
      products: [{ filename: "p1.png", mimeType: "image/png", bytesBase64: prodBytes.toString("base64") }],
      sceneType: "ecommerce_product",
      cloneLevel: "high",
      styleUnified: true,
      language: "zh",
      ratio: "1:1",
      size: "1K",
    },
  });
  assert.equal(created.status, 201);
  const { suiteId } = (created.body as any).data;

  const waitBatchDone = async (batchId: string) => {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const res = await f.app.request("GET", `/api/generation-batches/${batchId}`);
      if ((res.body as any).data.batch.status !== "running") return (res.body as any).data.batch.status;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("batch timeout");
  };

  const waitEditDone = async (childTaskId: string) => {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const res = await f.app.request("GET", `/api/image-editor/tasks/${childTaskId}`);
      if ((res.body as any).data.task.status !== "generating") return (res.body as any).data;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("edit timeout");
  };

  const s1 = await waitStudioState(f.app, suiteId, (data) => data.pipeline?.status === "completed");
  const taskId = s1.cards[0].parentTaskId;
  const v1Id = s1.cards[0].versionId;
  assert.equal(s1.cards[0].isEditedDerived, false);
  assert.equal(s1.cards[0].versionNumber, 1);

  // 1. Mark v1 as final (save to image library), then submit image edit on v1
  const markV1Final = await f.app.request("POST", `/api/suite-tasks/${taskId}/versions/${v1Id}/select`, {
    headers: { "Idempotency-Key": "mark-v1-final" },
    body: { selection: "final" },
  });
  assert.equal(markV1Final.status, 200);

  await f.app.request("POST", `/api/image-editor/sessions/${taskId}/operations`, {
    headers: { "Idempotency-Key": "edit-op-1" },
    body: {
      operation: {
        operationId: "op-1",
        type: "re_edit",
        order: 1,
        sourceCardId: taskId,
        sourceVersionId: v1Id,
        parentVersionId: v1Id,
        payload: { prompt: "提亮主体质感" },
      },
      summary: "提亮主体质感",
    },
  });
  const editSubmit1 = await f.app.request("POST", `/api/image-editor/sessions/${taskId}/submit`, {
    headers: { "Idempotency-Key": "edit-submit-1" },
    body: { sourceCardId: taskId, sourceVersionId: v1Id, parentVersionId: v1Id, summary: "提亮主体质感" },
  });
  assert.equal(editSubmit1.status, 202);
  const child1Id = (editSubmit1.body as any).data.childTask.id;
  await waitEditDone(child1Id);

  // After edit succeeds: v1 final lock cleared, studio-state & ZIP show edited child1, AND replica snapshot metadata preserved
  const sAfterEdit1 = await waitStudioState(f.app, suiteId, (data) => data.cards[0]?.isEditedDerived === true);
  assert.equal(sAfterEdit1.cards[0].editChildTaskId, child1Id);
  assert.equal(sAfterEdit1.cards[0].sourceRole, "edit_current");
  assert.equal(sAfterEdit1.cards[0].promptSnapshot.sharedStyle, "清冷高级棚拍调性，银灰石纹台面配柔和侧逆光");
  assert.ok(Array.isArray(sAfterEdit1.cards[0].promptSnapshot.copy) && sAfterEdit1.cards[0].promptSnapshot.copy.length > 0);
  assert.ok(sAfterEdit1.cards[0].promptSnapshot.visualStructure?.composition);

  const zipAfterEdit1 = await f.app.request("GET", `/api/suites/${suiteId}/delivery/export?taskIds=${encodeURIComponent(taskId)}`);
  assert.equal(zipAfterEdit1.status, 200);
  const manifestAfterEdit1 = JSON.parse(readZipEntries(zipAfterEdit1.raw!).get("manifest.json")!.toString("utf8"));
  assert.equal(manifestAfterEdit1.items[0].isEditedDerived, true);
  assert.equal(manifestAfterEdit1.items[0].editChildTaskId, child1Id);

  // 2. Mark edited child1 as final, then regenerate parent with edited prompt -> must show parent v2 (NOT swallowed by edit child1!)
  const markEditFinal = await f.app.request(
    "POST",
    `/api/image-editor/tasks/${child1Id}/versions/${sAfterEdit1.cards[0].versionId}/select`,
    { headers: { "Idempotency-Key": "mark-edit-final" }, body: { selection: "final" } },
  );
  assert.equal(markEditFinal.status, 200);

  const regenV2 = await f.app.request("POST", `/api/suite-tasks/${taskId}/generation`, {
    headers: { "Idempotency-Key": "regen-after-edit-v2" },
    body: { promptDraft: "编辑后再改提示词重生成 v2" },
  });
  assert.equal(regenV2.status, 202);
  assert.equal(await waitBatchDone((regenV2.body as any).data.batchId), "completed");

  const sAfterV2 = await waitStudioState(f.app, suiteId, (data) => data.cards[0]?.isEditedDerived === false && data.cards[0]?.versionNumber === 2);
  assert.equal(sAfterV2.cards[0].sourceRole, "parent_current");
  assert.equal(sAfterV2.cards[0].promptRevision, 2);
  assert.equal(sAfterV2.cards[0].promptDraft, "编辑后再改提示词重生成 v2");

  const zipAfterV2 = await f.app.request("GET", `/api/suites/${suiteId}/delivery/export?taskIds=${encodeURIComponent(taskId)}`);
  assert.equal(zipAfterV2.status, 200);
  const manifestAfterV2 = JSON.parse(readZipEntries(zipAfterV2.raw!).get("manifest.json")!.toString("utf8"));
  assert.equal(manifestAfterV2.items[0].isEditedDerived, false);
  assert.equal(manifestAfterV2.items[0].versionNumber, 2);

  // 3. Mark v2 as final; if a subsequent regeneration fails, v2 final lock is preserved; once regeneration succeeds, v2 final lock is cleared and v3 is shown
  const v2Id = sAfterV2.cards[0].versionId;
  await f.app.request("POST", `/api/suite-tasks/${taskId}/versions/${v2Id}/select`, {
    headers: { "Idempotency-Key": "mark-v2-final" },
    body: { selection: "final" },
  });

  failNextGen = true;
  const failedRegen = await f.app.request("POST", `/api/suite-tasks/${taskId}/generation`, {
    headers: { "Idempotency-Key": "regen-after-final-fail" },
    body: {},
  });
  assert.equal(failedRegen.status, 202);
  assert.equal(await waitBatchDone((failedRegen.body as any).data.batchId), "failed");
  const versionsAfterFail = await f.app.request("GET", `/api/suite-tasks/${taskId}/versions`);
  assert.equal(
    (versionsAfterFail.body as any).data.versions.find((v: any) => v.id === v2Id)?.isFinal,
    true,
    "failed regeneration must preserve existing final lock",
  );

  failNextGen = false;
  const regenV3 = await f.app.request("POST", `/api/suite-tasks/${taskId}/generation`, {
    headers: { "Idempotency-Key": "regen-after-final-v3" },
    body: {},
  });
  assert.equal(regenV3.status, 202);
  assert.equal(await waitBatchDone((regenV3.body as any).data.batchId), "completed");

  const sAfterV3 = await waitStudioState(f.app, suiteId, (data) => data.cards[0]?.versionNumber === 3);
  assert.equal(sAfterV3.cards[0].isEditedDerived, false);
  assert.equal(sAfterV3.cards[0].sourceRole, "parent_current");

  const versionsRes = await f.app.request("GET", `/api/suite-tasks/${taskId}/versions`);
  assert.equal((versionsRes.body as any).data.versions.length, 3);
  assert.equal((versionsRes.body as any).data.versions.some((v: any) => v.id === v2Id), true);
  assert.equal((versionsRes.body as any).data.versions.some((v: any) => v.isFinal), false);
});

test("encoded library resourceId paths (reverse%3A<id>) decode safely on detail, preview, and status endpoints, and archived replica batch reports taskCount=0 in feed", async () => {
  const f = await replicaFixture();
  const refBytes = await makePng(64, 64, { r: 60, g: 100, b: 140 });
  const created = await f.app.request("POST", "/api/replicas", {
    headers: { "Idempotency-Key": "encoded-lib-and-feed-1" },
    body: {
      references: [{ filename: "enc-ref.png", mimeType: "image/png", bytesBase64: refBytes.toString("base64") }],
      products: [],
      sceneType: "marketing_poster",
      cloneLevel: "compose",
      language: "zh",
      ratio: "1:1",
      size: "1K",
    },
  });
  assert.equal(created.status, 201);
  const { suiteId } = (created.body as any).data;
  const state = await waitStudioState(f.app, suiteId, (data) => data.pipeline?.status === "completed");
  const taskId = state.cards[0].parentTaskId;

  const saved = await f.app.request("POST", `/api/replicas/${suiteId}/tasks/${taskId}/reverse-asset`, {
    headers: { "Idempotency-Key": "save-enc-reverse-1" },
    body: {},
  });
  assert.equal(saved.status, 201);
  const assetId = (saved.body as any).data.id as string;
  assert.match(assetId, /^reverse:/);
  const encodedId = encodeURIComponent(assetId);
  assert.ok(encodedId.includes("%3A"));

  const detail = await f.app.request("GET", `/api/library/resources/${encodedId}`);
  assert.equal(detail.status, 200);
  assert.equal((detail.body as any).data.id, assetId);

  const preview = await f.app.request("GET", `/api/library/resources/${encodedId}/preview`);
  assert.equal(preview.status, 200);
  assert.ok(preview.raw && preview.raw.length > 0);

  const published = await f.app.request("POST", `/api/library/resources/${encodedId}/status`, {
    headers: { "Idempotency-Key": "publish-enc-1" },
    body: { status: "published" },
  });
  assert.equal(published.status, 200);
  assert.equal((published.body as any).data.status, "published");

  const archivedAsset = await f.app.request("POST", `/api/library/resources/${encodedId}/status`, {
    headers: { "Idempotency-Key": "archive-enc-1" },
    body: { status: "archived" },
  });
  assert.equal(archivedAsset.status, 200);
  assert.equal((archivedAsset.body as any).data.status, "archived");

  // Malformed URI encoding returns 404 safely without throwing
  expectError(await f.app.request("GET", "/api/library/resources/%E0%A4%A"), 404, "LIBRARY_RESOURCE_NOT_FOUND");
  expectError(
    await f.app.request("POST", "/api/library/resources/%E0%A4%A/status", { body: { status: "published" } }),
    404,
    "LIBRARY_RESOURCE_NOT_FOUND",
  );

  // Soft-archiving all tasks in a replica batch makes feed taskCount = 0 (not referenceCount = 1)
  const archTask = await f.app.request("PATCH", `/api/suite-tasks/${taskId}`, { body: { status: "archived" } });
  assert.equal(archTask.status, 200);
  const feedRes = await f.app.request("GET", "/api/suites/feed?origin=replica");
  assert.equal(feedRes.status, 200);
  const item = (feedRes.body as any).data.items.find((entry: any) => entry.suite.id === suiteId);
  assert.ok(item);
  assert.equal(item.taskCount, 0);
});

test("studio-state keeps read-only compatibility for historical replica batches with library product images", async () => {
  const f = await replicaFixture();
  const suite = await f.repository.createSuite("历史复刻批次", "legacy-lib-suite", "replica");
  const createdAt = new Date().toISOString();
  await f.replicaRepository.saveProductImages(suite.id, [
    {
      id: "legacy-prod-1",
      suiteId: suite.id,
      ordinal: 1,
      sourceKind: "library",
      objectKey: "library/legacy-cup.png",
      thumbnailObjectKey: null,
      filename: "历史保温杯白底图",
      mimeType: "image/png",
      sha256: null,
      width: null,
      height: null,
      libraryResourceId: "base:legacy-cup",
      resourceVersionId: "legacy-ver-1",
      createdAt,
    },
  ]);

  const stateRes = await f.app.request("GET", `/api/suites/${suite.id}/studio-state`);
  assert.equal(stateRes.status, 200);
  const data = (stateRes.body as any).data;
  assert.equal(data.styleSketch, false);
  assert.equal(data.replicaProducts.length, 1);
  assert.equal(data.replicaProducts[0].sourceKind, "library");
  assert.equal(data.replicaProducts[0].libraryResourceId, "base:legacy-cup");
});
