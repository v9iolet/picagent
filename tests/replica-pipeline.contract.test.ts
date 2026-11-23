import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import sharp from "sharp";
import { createSuiteStudioApp, type AppResponse, type SuiteStudioApp } from "../server/app.js";
import { parseNormalizedPromptMarkdown } from "../server/prompt-library.js";
import { MemoryLibraryRepository } from "../server/repositories/memory-library-repository.js";
import { MemoryPipelineRepository } from "../server/repositories/memory-pipeline-repository.js";
import { MemoryPromptRepository } from "../server/repositories/memory-prompt-repository.js";
import { MemoryReplicaRepository } from "../server/repositories/memory-replica-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryTaskRepository } from "../server/repositories/memory-task-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";
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
    403,
    "LIBRARY_RESOURCE_FORBIDDEN",
  );

  expectError(
    await f.app.request("POST", "/api/replicas", {
      headers: { "Idempotency-Key": "val-lib-draft" },
      body: { ...basePayload, products: [{ libraryResourceId: "base:draft-1" }] },
    }),
    409,
    "LIBRARY_RESOURCE_NOT_PUBLISHED",
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
  // Product 1: uploaded; Product 2: published library base_image
  const prodUploadBytes = await makePng(80, 80, { r: 210, g: 210, b: 210 });
  const prodLibraryBytes = await makePng(90, 90, { r: 245, g: 245, b: 245 });
  const now = new Date().toISOString();
  await f.storage.put({ key: "library/base-cup.png", bytes: prodLibraryBytes, contentType: "image/png" });
  f.libraryRepository.addResource({
    id: "base:published-cup",
    resourceType: "base_image",
    title: "保温杯白底图",
    summary: "",
    mimeType: "image/png",
    previewUrl: null,
    suiteId: "other-suite",
    taskId: null,
    imageVersionId: null,
    baseVersionId: "base-v1",
    templateVersionId: null,
    resourceVersionId: "base-v1",
    stage: null,
    source: { objectKey: "library/base-cup.png" },
    status: "published",
    createdAt: now,
    updatedAt: now,
  });

  const created = await f.app.request("POST", "/api/replicas", {
    headers: { "Idempotency-Key": "e2e-replica-1" },
    body: {
      references: [
        { filename: "ref-portrait.png", mimeType: "image/png", bytesBase64: ref1Bytes.toString("base64"), remark: "保留顶部标题" },
        { filename: "ref-wide.jpg", mimeType: "image/jpeg", bytesBase64: ref2Bytes.toString("base64"), remark: "横向氛围" },
      ],
      products: [
        { filename: "cup-front.png", mimeType: "image/png", bytesBase64: prodUploadBytes.toString("base64") },
        { libraryResourceId: "base:published-cup" },
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
    assert.equal(Buffer.compare(call.images![1].bytes, prodLibraryBytes), 0);
    assert.match(call.prompt, /^第1–2张图为产品外观唯一依据，第3张图仅作为版式与风格参考，不得复制其中的品牌、文字与人物/);
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
  assert.match(f.providerCalls[0].prompt, /^输入图仅作为版式与风格参考/);
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

test("interrupted image generation resumes via POST /api/replicas/:suiteId/resume and skips cards with current version", async () => {
  let failCard2 = true;
  const generatedCardTitles: string[] = [];
  const f = await replicaFixture({
    providerEdit: async (request, _call, defaultPng) => {
      const isCard2 = request.prompt.includes("卡 2");
      generatedCardTitles.push(isCard2 ? "card-2" : "card-1");
      if (isCard2 && failCard2) {
        throw new Error("IMAGE_PROVIDER_FAILED");
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
