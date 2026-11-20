import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { createTicket02App } from "../server/app.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryPlanRepository } from "../server/repositories/memory-plan-repository.js";
import { MemoryTaskRepository } from "../server/repositories/memory-task-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";
import { ImageEditorService, MemoryImageEditorRepository } from "../server/image-editor.js";
import { createImageEditorApi } from "../server/image-editor-api.js";
import { MemoryReverseRepository } from "../server/repositories/memory-reverse-repository.js";
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

  const app = createTicket02App({
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

  const app = createTicket02App({
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

  const app = createTicket02App({
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
