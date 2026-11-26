import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { createSuiteStudioApp } from "../server/app.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryPlanRepository } from "../server/repositories/memory-plan-repository.js";
import { MemoryTaskRepository } from "../server/repositories/memory-task-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";
import { ImageEditorService, MemoryImageEditorRepository } from "../server/image-editor.js";
import { createImageEditorApi } from "../server/image-editor-api.js";
import { MemoryReverseRepository } from "../server/repositories/memory-reverse-repository.js";
import { MemoryListingRepository } from "../server/listing-copy.js";
import { seedDemoShowcase } from "../server/seed-demo.js";
import { readZipEntries } from "../server/zip.js";

async function tinyPng(color: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({ create: { width: 32, height: 32, channels: 4, background: { ...color, alpha: 1 } } }).png().toBuffer();
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 40));
}

test("style override injects forward into new generation attempts without mutating prior snapshots or plan", async () => {
  const repository = new MemorySuiteRepository();
  const planRepository = new MemoryPlanRepository();
  const taskRepository = new MemoryTaskRepository();
  const storage = new MemoryStorage();
  const seenPrompts: string[] = [];
  const pngA = await tinyPng({ r: 220, g: 120, b: 60 });
  const pngB = await tinyPng({ r: 40, g: 140, b: 220 });

  const app = createSuiteStudioApp({
    repository,
    planRepository,
    taskRepository,
    storage,
    provider: {
      async edit(request) {
        seenPrompts.push(request.prompt);
        return { bytes: seenPrompts.length === 1 ? pngA : pngB, mimeType: "image/png" };
      },
    },
  });

  const created = await app.request("POST", "/api/suites", { headers: { "idempotency-key": "s-1" }, body: { name: "氮化镓充电器美国站" } });
  const suiteId = (created.body as { data: { id: string } }).data.id;
  const uploaded = await app.upload(suiteId, { filename: "product.png", mimeType: "image/png", bytes: pngA, ordinal: 1, idempotencyKey: "u-1" });
  assert.equal(uploaded.status, 201);
  const inputImageId = (uploaded.body as { data: { id: string } }).data.id;

  const snapshot = await planRepository.appendRevision({
    id: "snap-1",
    suiteId,
    revisionNumber: 1,
    revisionKind: "human",
    parentSnapshotId: null,
    templateVersionId: "tpl-1",
    dynamicInput: { platform: "amazon" },
    humanInput: {},
    chunks: [],
    inputImageIds: [inputImageId],
    baseVersionIds: [],
    provider: { name: "fake", model: "qwen", isFake: true },
    requestSummary: {},
    rawOutputSummary: {},
    schemaVersion: "suite-structure-plan-v2",
    structure: {
      status: "READY_FOR_REVIEW",
      mainAllocation: { category: "main", count: 1, reason: "主图", sourceImageIds: [inputImageId], factRefs: [], missingFacts: [] },
      detailImageCount: 1,
      categoryAllocations: [{ category: "lifestyle_use", requirement: "required", count: 1, reason: "场景", sourceImageIds: [inputImageId], factRefs: [], missingFacts: [] }],
      globalStyleCard: { promptPrefix: "原始柔和自然光风格" },
    },
    items: [
      { id: "item-main", ordinal: 1, imageType: "main", title: "核心白底主图", purpose: "首屏展示", prompt: "系统安全约束：合规。\n全局风格卡：原始柔和自然光风格\n当前类别提示词：正面主图" },
      { id: "item-detail", ordinal: 2, imageType: "detail", title: "桌面办公场景", purpose: "生活场景", prompt: "系统安全约束：合规。\n全局风格卡：原始柔和自然光风格\n当前类别提示词：桌面场景" },
    ],
    createdAt: new Date().toISOString(),
  });

  const createdTasks = await app.request("POST", `/api/suites/${suiteId}/tasks`, {
    headers: { "idempotency-key": "tasks-1" },
    body: { planSnapshotId: snapshot.id },
  });
  assert.equal(createdTasks.status, 201);
  const tasks = (createdTasks.body as { data: { tasks: Array<{ id: string }> } }).data.tasks;
  const mainTaskId = tasks[0].id;

  // Generate v1 before style override
  const gen1 = await app.request("POST", `/api/suite-tasks/${mainTaskId}/generation`, { headers: { "idempotency-key": "g-1" }, body: {} });
  assert.equal(gen1.status, 202);
  await settle();

  // Missing idempotency key is rejected
  const missingKey = await app.request("PATCH", `/api/suites/${suiteId}/style-override`, {
    body: { styleOverride: "冷色调影棚金属质感打光" },
  });
  assert.equal(missingKey.status, 400);

  // Apply canvas style override (idempotent)
  const patchRes = await app.request("PATCH", `/api/suites/${suiteId}/style-override`, {
    headers: { "idempotency-key": "style-1" },
    body: { styleOverride: "冷色调影棚金属质感打光" },
  });
  assert.equal(patchRes.status, 200);
  const patchReplay = await app.request("PATCH", `/api/suites/${suiteId}/style-override`, {
    headers: { "idempotency-key": "style-1" },
    body: { styleOverride: "冷色调影棚金属质感打光" },
  });
  assert.equal(patchReplay.status, 200);
  assert.deepEqual(patchReplay.body.data, patchRes.body.data);
  const patchData = (patchRes.body as { data: { planStyleGuide: string; styleOverride: string; effectiveStyleGuide: string } }).data;
  assert.equal(patchData.planStyleGuide, "原始柔和自然光风格");
  assert.equal(patchData.styleOverride, "冷色调影棚金属质感打光");
  assert.equal(patchData.effectiveStyleGuide, "冷色调影棚金属质感打光");

  // Generate v2 after style override
  const gen2 = await app.request("POST", `/api/suite-tasks/${mainTaskId}/generation`, { headers: { "idempotency-key": "g-2" }, body: {} });
  assert.equal(gen2.status, 202);
  await settle();

  assert.equal(seenPrompts.length, 2);
  assert.match(seenPrompts[0], /全局风格卡：原始柔和自然光风格/);
  assert.match(seenPrompts[1], /全局风格卡：冷色调影棚金属质感打光/);

  // Verify workbench: v1 snapshot untouched, v2 has override, planSnapshot untouched, task promptDraft untouched
  const wbRes = await app.request("GET", `/api/suites/${suiteId}/workbench`);
  assert.equal(wbRes.status, 200);
  const wb = (wbRes.body as { data: { planStyleGuide: string; styleOverride: string; planSnapshot: { structure: { globalStyleCard: { promptPrefix: string } } }; tasks: Array<{ id: string; promptDraft: string; versions: Array<{ versionNumber: number; promptSnapshot: { finalPrompt: string } }> }> } }).data;
  assert.equal(wb.planSnapshot.structure.globalStyleCard.promptPrefix, "原始柔和自然光风格");
  const mainTask = wb.tasks.find((item) => item.id === mainTaskId)!;
  assert.match(mainTask.promptDraft, /全局风格卡：原始柔和自然光风格/);
  const v1 = mainTask.versions.find((v) => v.versionNumber === 1)!;
  const v2 = mainTask.versions.find((v) => v.versionNumber === 2)!;
  assert.match(v1.promptSnapshot.finalPrompt, /全局风格卡：原始柔和自然光风格/);
  assert.match(v2.promptSnapshot.finalPrompt, /全局风格卡：冷色调影棚金属质感打光/);

  // Suite list returns cover metadata
  const listRes = await app.request("GET", "/api/suites");
  assert.equal(listRes.status, 200);
  const listed = (listRes.body as { data: Array<{ id: string; coverPreviewUrl: string | null; inputImageCount: number; taskCount: number }> }).data;
  assert.equal(listed[0].id, suiteId);
  assert.ok(listed[0].coverPreviewUrl?.includes("/api/suite-tasks/"));
  assert.equal(listed[0].inputImageCount, 1);
  assert.equal(listed[0].taskCount, 2);

  // Clearing style override restores plan default
  const clearRes = await app.request("PATCH", `/api/suites/${suiteId}/style-override`, { headers: { "idempotency-key": "style-clear-1" }, body: { styleOverride: "" } });
  assert.equal(clearRes.status, 200);
  assert.equal((clearRes.body as { data: { styleOverride: string | null; effectiveStyleGuide: string } }).data.styleOverride, null);
  assert.equal((clearRes.body as { data: { effectiveStyleGuide: string } }).data.effectiveStyleGuide, "原始柔和自然光风格");
});

test("delivery ZIP export merges parent and edit-child slots with manifest.json and rejects empty suites", async () => {
  const repository = new MemorySuiteRepository();
  const planRepository = new MemoryPlanRepository();
  const taskRepository = new MemoryTaskRepository();
  const storage = new MemoryStorage();
  const editRepo = new MemoryImageEditorRepository();

  const parentPng = await tinyPng({ r: 100, g: 180, b: 90 });
  const editPng = await tinyPng({ r: 240, g: 60, b: 80 });

  const editService = new ImageEditorService(
    editRepo,
    {
      name: "fake-editor",
      version: "edit-v1",
      capabilitiesVersion: "v1",
      capabilities: () => ({ imageToImage: true, addText: true, changeText: true, redraw: true, erase: true, outpaint: true, currentVersionInput: true }),
      edit: async () => ({ bytes: editPng, mimeType: "image/png", width: 32, height: 32 }),
    },
    storage,
    async () => ({ bytes: parentPng, mimeType: "image/png", width: 32, height: 32, generationPrompt: "主图原提示词" }),
  );

  const app = createSuiteStudioApp({
    repository,
    planRepository,
    taskRepository,
    storage,
    imageEditorApi: createImageEditorApi(editService),
    provider: { async edit() { return { bytes: parentPng, mimeType: "image/png" }; } },
  });

  const created = await app.request("POST", "/api/suites", { body: { name: "出海蓝牙耳机" } });
  const suiteId = (created.body as { data: { id: string } }).data.id;
  const uploaded = await app.upload(suiteId, { filename: "earbud.png", mimeType: "image/png", bytes: parentPng, ordinal: 1 });
  const inputImageId = (uploaded.body as { data: { id: string } }).data.id;

  // Empty delivery rejects with 400 DELIVERY_EMPTY
  const emptyExport = await app.request("GET", `/api/suites/${suiteId}/delivery/export`);
  assert.equal(emptyExport.status, 400);
  assert.equal((emptyExport.body as { error: { code: string } }).error.code, "DELIVERY_EMPTY");

  await planRepository.appendRevision({
    id: "snap-zip",
    suiteId,
    revisionNumber: 1,
    revisionKind: "human",
    parentSnapshotId: null,
    templateVersionId: "tpl-1",
    dynamicInput: {},
    humanInput: {},
    chunks: [],
    inputImageIds: [inputImageId],
    baseVersionIds: [],
    provider: { name: "fake", model: "qwen", isFake: true },
    requestSummary: {},
    rawOutputSummary: {},
    schemaVersion: "suite-structure-plan-v2",
    items: [
      { id: "p-main", ordinal: 1, imageType: "main", title: "正面主图", purpose: "主图", prompt: "正面主图提示词" },
      { id: "p-detail", ordinal: 2, imageType: "detail", title: "降噪卖点图", purpose: "详情", prompt: "详情提示词" },
    ],
    createdAt: new Date().toISOString(),
  });

  const tasksRes = await app.request("POST", `/api/suites/${suiteId}/tasks`, { headers: { "idempotency-key": "tk-zip" }, body: { planSnapshotId: "snap-zip" } });
  const tasks = (tasksRes.body as { data: { tasks: Array<{ id: string }> } }).data.tasks;
  const mainTaskId = tasks[0].id;
  const detailTaskId = tasks[1].id;

  // Generate both parent cards
  await app.request("POST", `/api/suites/${suiteId}/generation`, { headers: { "idempotency-key": "gb-1" }, body: { taskIds: [mainTaskId, detailTaskId] } });
  await settle();

  const wbBefore = (await app.request("GET", `/api/suites/${suiteId}/workbench`)).body as { data: { tasks: Array<{ id: string; versions: Array<{ id: string }> }> } };
  const mainVersionId = wbBefore.data.tasks.find((t) => t.id === mainTaskId)!.versions[0].id;

  // Create edit child for main card and mark it final -> should win over parent in ZIP
  await editService.upsertOperation({
    sessionId: mainTaskId,
    operation: { operationId: "op-text", type: "add_text", order: 1, sourceCardId: mainTaskId, sourceVersionId: mainVersionId, parentVersionId: mainVersionId, summary: "添加 65W 标语", payload: { text: "65W", prompt: "简洁加粗" } },
  });
  const submitted = await editService.submit({ sessionId: mainTaskId, idempotencyKey: "sub-1", sourceCardId: mainTaskId, sourceVersionId: mainVersionId, summary: "添加 65W 标语" });
  await settle();
  const childVersions = await editRepo.listVersions(submitted.childTask.id);
  await editService.selectVersion(submitted.childTask.id, childVersions[0].id, "final");

  const exported = await app.request("GET", `/api/suites/${suiteId}/delivery/export`);
  assert.equal(exported.status, 200);
  assert.equal(exported.headers?.["content-type"], "application/zip");
  assert.ok(exported.raw && exported.raw.length > 0);

  const entries = readZipEntries(exported.raw);
  assert.ok(entries.has("main/01_正面主图.png"));
  assert.ok(entries.has("detail/01_降噪卖点图.png"));
  assert.ok(entries.has("manifest.json"));
  // Main image bytes must come from edited child (editPng), not parentPng
  assert.equal(Buffer.compare(entries.get("main/01_正面主图.png")!, editPng), 0);

  const manifest = JSON.parse(entries.get("manifest.json")!.toString("utf8")) as {
    schemaVersion: string;
    summary: { exportedCount: number; mainCount: number; detailCount: number };
    items: Array<{ exportPath: string; sourceRole: string; isEditedDerived: boolean; editChildTaskId: string | null; templateVersionId: string | null }>;
  };
  assert.equal(manifest.schemaVersion, "picagent-delivery-manifest-v1");
  assert.equal(manifest.summary.exportedCount, 2);
  assert.equal(manifest.summary.mainCount, 1);
  assert.equal(manifest.summary.detailCount, 1);
  const mainItem = manifest.items.find((i) => i.exportPath === "main/01_正面主图.png")!;
  assert.equal(mainItem.sourceRole, "edit_final");
  assert.equal(mainItem.isEditedDerived, true);
  assert.equal(mainItem.editChildTaskId, submitted.childTask.id);
  assert.equal(mainItem.templateVersionId, "tpl-1");
});

test("seedDemoShowcase creates a complete end-to-end showcase suite and is idempotent on repeat runs", async () => {
  const repository = new MemorySuiteRepository();
  const planRepository = new MemoryPlanRepository();
  const taskRepository = new MemoryTaskRepository();
  const reverseRepository = new MemoryReverseRepository();
  const imageEditorRepository = new MemoryImageEditorRepository();
  const storage = new MemoryStorage();

  const first = await seedDemoShowcase({ repository, planRepository, taskRepository, reverseRepository, imageEditorRepository, storage });
  assert.equal(first.alreadySeeded, false);
  assert.equal(first.taskCount, 4);
  assert.ok(first.editChildTaskId);

  const second = await seedDemoShowcase({ repository, planRepository, taskRepository, reverseRepository, imageEditorRepository, storage });
  assert.equal(second.alreadySeeded, true);
  assert.equal(second.suiteId, first.suiteId);
  assert.equal((await repository.listSuites()).length, 1);

  const app = createSuiteStudioApp({
    repository,
    planRepository,
    taskRepository,
    reverseRepository,
    storage,
    imageEditorApi: createImageEditorApi(new ImageEditorService(imageEditorRepository, async () => null, storage, async () => null)),
  });
  const exported = await app.request("GET", `/api/suites/${first.suiteId}/delivery/export`);
  assert.equal(exported.status, 200);
  const entries = readZipEntries(exported.raw!);
  assert.ok(entries.has("manifest.json"));
  const manifest = JSON.parse(entries.get("manifest.json")!.toString("utf8")) as { summary: { exportedCount: number; mainCount: number; detailCount: number } };
  assert.equal(manifest.summary.exportedCount, 4);
  assert.equal(manifest.summary.mainCount, 2);
  assert.equal(manifest.summary.detailCount, 2);
});

test("multi-platform preset ZIP export resizes images, converts format, and stitches detail long image", async () => {
  const repository = new MemorySuiteRepository();
  const planRepository = new MemoryPlanRepository();
  const taskRepository = new MemoryTaskRepository();
  const reverseRepository = new MemoryReverseRepository();
  const imageEditorRepository = new MemoryImageEditorRepository();
  const storage = new MemoryStorage();

  const seeded = await seedDemoShowcase({ repository, planRepository, taskRepository, reverseRepository, imageEditorRepository, storage });
  const app = createSuiteStudioApp({
    repository,
    planRepository,
    taskRepository,
    reverseRepository,
    storage,
    imageEditorApi: createImageEditorApi(new ImageEditorService(imageEditorRepository, async () => null, storage, async () => null)),
  });

  const exported = await app.request("GET", `/api/suites/${seeded.suiteId}/delivery/export?preset=taobao&format=jpeg&quality=85&stitchDetail=true`);
  assert.equal(exported.status, 200);
  const entries = readZipEntries(exported.raw!);
  assert.ok(entries.has("manifest.json"));
  assert.ok(entries.has("detail/00_detail_long_stitched.jpg"));

  const manifest = JSON.parse(entries.get("manifest.json")!.toString("utf8")) as {
    exportOptions: { preset: string; format: string; quality: number; stitchDetail: boolean; stitchedDetailPath: string | null };
    summary: { stitchedDetailIncluded: boolean; mainCount: number; detailCount: number };
    items: Array<{ exportPath: string; imageType: string; width: number; height: number; mimeType: string }>;
  };
  assert.equal(manifest.exportOptions.preset, "taobao");
  assert.equal(manifest.exportOptions.format, "jpeg");
  assert.equal(manifest.exportOptions.quality, 85);
  assert.equal(manifest.exportOptions.stitchDetail, true);
  assert.equal(manifest.summary.stitchedDetailIncluded, true);

  const mainItem = manifest.items.find((item) => item.imageType === "main")!;
  assert.equal(mainItem.width, 800);
  assert.equal(mainItem.height, 800);
  assert.equal(mainItem.mimeType, "image/jpeg");
  assert.ok(mainItem.exportPath.endsWith(".jpg"));

  const detailItem = manifest.items.find((item) => item.imageType === "detail")!;
  assert.equal(detailItem.width, 790);

  const stitchedMeta = await sharp(entries.get("detail/00_detail_long_stitched.jpg")!).metadata();
  assert.equal(stitchedMeta.format, "jpeg");
  assert.equal(stitchedMeta.width, 790);
  assert.ok((stitchedMeta.height ?? 0) > detailItem.height);
});

test("cross-border image text translation, custom canvas tasks, batch param sync, and suite rename work end-to-end", async () => {
  const repository = new MemorySuiteRepository();
  const planRepository = new MemoryPlanRepository();
  const taskRepository = new MemoryTaskRepository();
  const storage = new MemoryStorage();
  const samplePng = await tinyPng({ r: 80, g: 130, b: 210 });

  const app = createSuiteStudioApp({
    repository,
    planRepository,
    taskRepository,
    storage,
    llmClient: {
      provider: "fake",
      model: "qwen-vl-max",
      isFake: true,
      async generatePlan() { return {}; },
      async translateTexts({ targetLanguage, items }) {
        return items.map((item) => ({
          id: item.id,
          originalText: item.text,
          translatedText: `[${targetLanguage}] ${item.text}`,
        }));
      },
    },
  });

  // 1. Translation endpoint validates input & translates OCR blocks
  const emptyTr = await app.request("POST", "/api/image-editor/translate-text", { body: { targetLanguage: "日语", items: [] } });
  assert.equal(emptyTr.status, 400);

  const trRes = await app.request("POST", "/api/image-editor/translate-text", {
    body: {
      targetLanguage: "日语",
      items: [
        { id: "b1", text: "65W 极速快充" },
        { id: "b2", text: "折叠插脚" },
      ],
    },
  });
  assert.equal(trRes.status, 200);
  const trData = (trRes.body as { data: { targetLanguage: string; translations: Array<{ id: string; translatedText: string }> } }).data;
  assert.equal(trData.targetLanguage, "日语");
  assert.equal(trData.translations.length, 2);
  assert.equal(trData.translations[0].translatedText, "[日语] 65W 极速快充");

  // 2. Create suite, rename suite, upload image, add custom task cards idempotently, and batch sync params
  const created = await app.request("POST", "/api/suites", { body: { name: "旧方案名" } });
  const suiteId = (created.body as { data: { id: string } }).data.id;

  const renamed = await app.request("PATCH", `/api/suites/${suiteId}`, { body: { name: "65W 氮化镓日本站" } });
  assert.equal(renamed.status, 200);
  assert.equal((renamed.body as { data: { name: string } }).data.name, "65W 氮化镓日本站");

  await app.upload(suiteId, { filename: "charger.png", mimeType: "image/png", bytes: samplePng, ordinal: 1 });

  const custom1 = await app.request("POST", `/api/suites/${suiteId}/tasks/custom`, {
    headers: { "idempotency-key": "custom-1" },
    body: { imageType: "detail", title: "黑五促销场景", promptDraft: "黑五暖光极简桌面场景", generationParams: { ratio: "3:4", size: "1K", quality: "medium" } },
  });
  assert.equal(custom1.status, 201);
  const custom1Replay = await app.request("POST", `/api/suites/${suiteId}/tasks/custom`, {
    headers: { "idempotency-key": "custom-1" },
    body: { imageType: "detail", title: "黑五促销场景", promptDraft: "黑五暖光极简桌面场景" },
  });
  assert.equal(custom1Replay.status, 200);
  assert.equal((custom1Replay.body as { data: { id: string } }).data.id, (custom1.body as { data: { id: string } }).data.id);

  const custom2 = await app.request("POST", `/api/suites/${suiteId}/tasks/custom`, {
    headers: { "idempotency-key": "custom-2" },
    body: { imageType: "main", title: "纯白底主图", promptDraft: "纯白背景产品居中" },
  });
  assert.equal(custom2.status, 201);

  const batchSync = await app.request("POST", `/api/suites/${suiteId}/tasks/batch-params`, {
    body: { imageType: "detail", generationParams: { ratio: "9:16", size: "2K", quality: "high" } },
  });
  assert.equal(batchSync.status, 200);
  assert.equal((batchSync.body as { data: { updatedCount: number } }).data.updatedCount, 1);

  const wb = (await app.request("GET", `/api/suites/${suiteId}/workbench`)).body as {
    data: { tasks: Array<{ imageType: string; generationParams: { ratio?: string; size?: string; quality?: string } }> };
  };
  assert.equal(wb.data.tasks.length, 2);
  const detailTask = wb.data.tasks.find((t) => t.imageType === "detail")!;
  const mainTask = wb.data.tasks.find((t) => t.imageType === "main")!;
  assert.equal(detailTask.generationParams.ratio, "9:16");
  assert.equal(detailTask.generationParams.size, "2K");
  assert.equal(detailTask.generationParams.quality, "high");
  assert.notEqual(mainTask.generationParams.ratio, "9:16");

  // 3. Delete suite removes it from list & detail endpoints
  const deleted = await app.request("DELETE", `/api/suites/${suiteId}`);
  assert.equal(deleted.status, 200);
  assert.equal((deleted.body as { data: { id: string } }).data.id, suiteId);

  const listAfterDelete = (await app.request("GET", "/api/suites")).body as { data: Array<{ id: string }> };
  assert.equal(listAfterDelete.data.some((item) => item.id === suiteId), false);
  const getAfterDelete = await app.request("GET", `/api/suites/${suiteId}`);
  assert.equal(getAfterDelete.status, 404);
  const deleteAgain = await app.request("DELETE", `/api/suites/${suiteId}`);
  assert.equal(deleteAgain.status, 404);
});

test("task generation sends selected pixel size, freezes retries, and applies changed params only to new attempts", async () => {
  const taskRepository = new MemoryTaskRepository();
  const png = await tinyPng({ r: 50, g: 90, b: 130 });
  const sizes: string[] = [];
  const app = createSuiteStudioApp({
    repository: new MemorySuiteRepository(), taskRepository, storage: new MemoryStorage(),
    provider: { async edit(request) { sizes.push(request.size); throw new Error("IMAGE_SIZE_UNSUPPORTED"); } },
  });
  const suiteId = (await app.request("POST", "/api/suites", { body: { name: "尺寸冻结" } })).body.data.id;
  await app.upload(suiteId, { filename: "product.png", mimeType: "image/png", bytes: png });
  const task = (await app.request("POST", "/api/suites/" + suiteId + "/tasks/custom", {
    headers: { "idempotency-key": "size-task" },
    body: { title: "细节图", promptDraft: "展示细节", imageType: "detail", generationParams: { size: "2K", ratio: "2:3" } },
  })).body.data;
  const generate = (key: string) => app.request("POST", "/api/suite-tasks/" + task.id + "/generation", { headers: { "idempotency-key": key } });
  assert.equal((await generate("size-first")).status, 202);
  await settle();
  const first = (await taskRepository.listTaskVersions(task.id)).attempts[0];
  assert.equal(first.requestSummary.size, "2048x3072");
  assert.deepEqual(sizes, ["2048x3072"]);
  assert.equal(first.errorCode, "IMAGE_SIZE_UNSUPPORTED");
  assert.equal(first.errorMessage, "当前账号分组不支持该分辨率");
  await app.request("PATCH", "/api/suite-tasks/" + task.id, { body: { generationParams: { size: "1K", ratio: "3:2" } } });
  assert.equal((await app.request("POST", "/api/generation-attempts/" + first.id + "/retry", { headers: { "idempotency-key": "size-retry" } })).status, 202);
  await settle();
  assert.deepEqual(sizes, ["2048x3072", "2048x3072"]);
  assert.equal((await generate("size-new")).status, 202);
  await settle();
  assert.deepEqual(sizes, ["2048x3072", "2048x3072", "1536x1024"]);
  assert.equal((await taskRepository.getAttempt(first.id))?.requestSummary.size, "2048x3072");
});

test("changing task params while an attempt is reserved cannot change the dispatched size", async () => {
  const taskRepository = new MemoryTaskRepository();
  const beginBatch = taskRepository.beginBatch.bind(taskRepository);
  let reservedTaskId = "";
  taskRepository.beginBatch = async (input) => {
    const result = await beginBatch(input);
    await taskRepository.updateTask(reservedTaskId, { generationParams: { size: "4K", ratio: "1:1" } });
    return result;
  };
  const png = await tinyPng({ r: 10, g: 30, b: 70 });
  const sizes: string[] = [];
  const app = createSuiteStudioApp({
    repository: new MemorySuiteRepository(), taskRepository, storage: new MemoryStorage(),
    provider: { async edit(request) { sizes.push(request.size); return { bytes: png, mimeType: "image/png" }; } },
  });
  const suiteId = (await app.request("POST", "/api/suites", { body: { name: "保留已提交尺寸" } })).body.data.id;
  await app.upload(suiteId, { filename: "product.png", mimeType: "image/png", bytes: png });
  const task = (await app.request("POST", "/api/suites/" + suiteId + "/tasks/custom", {
    headers: { "idempotency-key": "reserved-size-task" }, body: { title: "商品图", promptDraft: "保持商品", generationParams: { size: "1K", ratio: "2:3" } },
  })).body.data;
  reservedTaskId = task.id;
  assert.equal((await app.request("POST", "/api/suite-tasks/" + task.id + "/generation", { headers: { "idempotency-key": "reserved-size" } })).status, 202);
  await settle();
  assert.deepEqual(sizes, ["1024x1536"]);
  assert.equal((await taskRepository.getTask(task.id))?.generationParams.size, "4K");
  assert.equal((await taskRepository.listTaskVersions(task.id)).attempts[0].requestSummary.size, "1024x1536");
});

test("a tier-only image model dispatches the selected tier without pixel conversion", async (t) => {
  const { ModelSettings } = await import("../server/model-settings.js");
  const settings = new ModelSettings({
    read: async () => ({ channels: [{ id: "tier-channel", name: "档位渠道", protocol: "openai-compatible", baseUrl: "https://example.test/v1", apiKey: "dummy-tier-key", models: [{ id: "custom-image", capabilities: ["image"], imageOptions: { sizes: ["1K", "2K"], aspectRatios: ["1:1", "3:4"], sizeMode: "tier" } }] }], preferences: { image: { channelId: "tier-channel", modelId: "custom-image" }, vision: null, video: null } }),
    update: async () => { throw new Error("not used"); },
  });
  const taskRepository = new MemoryTaskRepository();
  const png = await tinyPng({ r: 20, g: 60, b: 100 });
  const sizes: FormDataEntryValue[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    sizes.push((init.body as FormData).get("size")!);
    return new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }));
  });
  const app = createSuiteStudioApp({ repository: new MemorySuiteRepository(), taskRepository, storage: new MemoryStorage(), modelSettings: settings });
  const suiteId = (await app.request("POST", "/api/suites", { body: { name: "档位透传" } })).body.data.id;
  await app.upload(suiteId, { filename: "product.png", mimeType: "image/png", bytes: png });
  const task = (await app.request("POST", "/api/suites/" + suiteId + "/tasks/custom", {
    headers: { "idempotency-key": "tier-task" }, body: { title: "商品图", promptDraft: "保持商品", generationParams: { size: "2K", ratio: "3:4" } },
  })).body.data;
  assert.equal((await app.request("POST", "/api/suite-tasks/" + task.id + "/generation", { headers: { "idempotency-key": "tier-generate" } })).status, 202);
  await settle();
  assert.deepEqual(sizes, ["2K"]);
  assert.equal((await taskRepository.listTaskVersions(task.id)).attempts[0].requestSummary.size, "2K");
});

test("delivery ZIP export includes listing-copy.md with latest edited version when present and omits it otherwise", async () => {
  const repository = new MemorySuiteRepository();
  const planRepository = new MemoryPlanRepository();
  const taskRepository = new MemoryTaskRepository();
  const listingRepository = new MemoryListingRepository();
  const storage = new MemoryStorage();
  const png = await tinyPng({ r: 60, g: 120, b: 180 });

  const amazonProfile = {
    code: "amazon",
    name: "Amazon",
    marketScope: "overseas" as const,
    mainImageBackground: "pure_white_required" as const,
    mainImageStrategy: "",
    galleryStrategy: "",
    textStrategy: "",
    modelStrategy: "",
    sourceNote: "",
    sortOrder: 1,
    listingCopyRules: {
      titleMaxLength: 75,
      maxBulletPoints: 5,
      supportsSearchTerms: true,
      itemHighlightsMaxLength: 125,
      searchTermsMaxBytes: 250,
      forbiddenWords: [],
    },
  };

  const app = createSuiteStudioApp({
    repository,
    planRepository,
    taskRepository,
    listingRepository,
    storage,
    platformRepository: {
      listEnabled: async () => [amazonProfile],
      find: async (code) => (code === "amazon" ? amazonProfile : undefined),
    },
    provider: { async edit() { return { bytes: png, mimeType: "image/png" }; } },
  });

  // 1. Suite with listing copy v1 -> v2 (edited)
  const createdWithCopy = await app.request("POST", "/api/suites", { body: { name: "65W 氮化镓充电器" } });
  const suiteWithCopyId = (createdWithCopy.body as { data: { id: string } }).data.id;
  await app.upload(suiteWithCopyId, { filename: "charger.png", mimeType: "image/png", bytes: png });
  const taskWithCopy = (await app.request("POST", `/api/suites/${suiteWithCopyId}/tasks/custom`, {
    headers: { "idempotency-key": "lc-task-1" },
    body: { imageType: "main", title: "白底主图", promptDraft: "白底主图" },
  })).body.data as { id: string };
  await app.request("POST", `/api/suite-tasks/${taskWithCopy.id}/generation`, { headers: { "idempotency-key": "lc-gen-1" } });
  await settle();

  const listingJobId = "job-with-v2";
  await listingRepository.save({
    id: listingJobId,
    sourceSuiteId: suiteWithCopyId,
    platform: "amazon",
    targetMarket: "美国",
    outputLanguage: "英文",
    input: { sellingPoints: "65W GaN fast charger" },
    status: "succeeded",
    errorCode: null,
    revision: 2,
    createdAt: "2026-11-23T00:00:00.000Z",
    updatedAt: "2026-11-23T00:01:00.000Z",
    inputImages: [],
    versions: [
      {
        id: "ver-1",
        versionNumber: 1,
        createdAt: "2026-11-23T00:00:10.000Z",
        content: {
          schemaVersion: "listing-copy-v1",
          title: "Old v1 Title",
          itemHighlights: "Old highlight",
          bulletPoints: ["Old bullet"],
          description: "Old description",
          searchTerms: ["old term"],
          missingFacts: [],
        },
        promptSnapshot: {
          templateVersionId: "tpl-lc",
          templateCode: "general.listing-copy",
          templateVersionNo: 1,
          input: {},
          model: { name: "fake", model: "fake", isFake: true },
        },
      },
      {
        id: "ver-2",
        versionNumber: 2,
        createdAt: "2026-11-23T00:01:00.000Z",
        content: {
          schemaVersion: "listing-copy-v1",
          title: "65W GaN Foldable USB-C Charger v2",
          itemHighlights: "Compact GaN power with foldable plug",
          bulletPoints: ["65W PD fast charging", "Foldable prongs for travel"],
          description: "Updated v2 product description for Amazon.",
          searchTerms: ["gan charger", "65w usb c"],
          missingFacts: [],
        },
        promptSnapshot: {
          templateVersionId: "tpl-lc",
          templateCode: "general.listing-copy",
          templateVersionNo: 1,
          input: {},
          model: { name: "fake", model: "fake", isFake: true },
          editedFromVersionId: "ver-1",
        },
      },
    ],
  }, null);

  const exportWithCopy = await app.request("GET", `/api/suites/${suiteWithCopyId}/delivery/export`);
  assert.equal(exportWithCopy.status, 200);
  const entriesWithCopy = readZipEntries(exportWithCopy.raw!);
  assert.ok(entriesWithCopy.has("main/01_白底主图.png"));
  assert.ok(entriesWithCopy.has("listing-copy.md"));
  assert.ok(entriesWithCopy.has("manifest.json"));

  const markdown = entriesWithCopy.get("listing-copy.md")!.toString("utf8");
  assert.match(markdown, /# 65W 氮化镓充电器 — 商品上架文案/);
  assert.match(markdown, /版本号：v2/);
  assert.match(markdown, /## 标题[\s\S]*65W GaN Foldable USB-C Charger v2/);
  assert.match(markdown, /## 商品亮点 \(Item Highlights\)[\s\S]*Compact GaN power with foldable plug/);
  assert.match(markdown, /## 五点描述[\s\S]*1\. 65W PD fast charging[\s\S]*2\. Foldable prongs for travel/);
  assert.match(markdown, /## 后台搜索词[\s\S]*gan charger 65w usb c/);
  assert.doesNotMatch(markdown, /Old v1 Title/);

  const manifestWithCopy = JSON.parse(entriesWithCopy.get("manifest.json")!.toString("utf8")) as {
    summary: { listingCopyIncluded: boolean; listingCopyPath: string | null };
    listingCopy: { versionNumber: number; content: { title: string } } | null;
  };
  assert.equal(manifestWithCopy.summary.listingCopyIncluded, true);
  assert.equal(manifestWithCopy.summary.listingCopyPath, "listing-copy.md");
  assert.equal(manifestWithCopy.listingCopy?.versionNumber, 2);
  assert.equal(manifestWithCopy.listingCopy?.content.title, "65W GaN Foldable USB-C Charger v2");

  // 2. Suite without listing copy omits listing-copy.md
  const createdWithoutCopy = await app.request("POST", "/api/suites", { body: { name: "无文案套图" } });
  const suiteWithoutCopyId = (createdWithoutCopy.body as { data: { id: string } }).data.id;
  await app.upload(suiteWithoutCopyId, { filename: "plain.png", mimeType: "image/png", bytes: png });
  const taskWithoutCopy = (await app.request("POST", `/api/suites/${suiteWithoutCopyId}/tasks/custom`, {
    headers: { "idempotency-key": "lc-task-2" },
    body: { imageType: "main", title: "纯图主图", promptDraft: "白底主图" },
  })).body.data as { id: string };
  await app.request("POST", `/api/suite-tasks/${taskWithoutCopy.id}/generation`, { headers: { "idempotency-key": "lc-gen-2" } });
  await settle();

  const exportWithoutCopy = await app.request("GET", `/api/suites/${suiteWithoutCopyId}/delivery/export`);
  assert.equal(exportWithoutCopy.status, 200);
  const entriesWithoutCopy = readZipEntries(exportWithoutCopy.raw!);
  assert.equal(entriesWithoutCopy.has("listing-copy.md"), false);
  const manifestWithoutCopy = JSON.parse(entriesWithoutCopy.get("manifest.json")!.toString("utf8")) as {
    summary: { listingCopyIncluded: boolean; listingCopyPath: string | null };
    listingCopy: unknown;
  };
  assert.equal(manifestWithoutCopy.summary.listingCopyIncluded, false);
  assert.equal(manifestWithoutCopy.summary.listingCopyPath, null);
  assert.equal(manifestWithoutCopy.listingCopy, null);
});
