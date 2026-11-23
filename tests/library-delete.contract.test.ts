import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { createSuiteStudioApp } from "../server/app.js";
import { parseNormalizedPromptMarkdown } from "../server/prompt-library.js";
import { MemoryLibraryRepository } from "../server/repositories/memory-library-repository.js";
import { MemoryPipelineRepository } from "../server/repositories/memory-pipeline-repository.js";
import { MemoryPromptRepository } from "../server/repositories/memory-prompt-repository.js";
import { MemoryReplicaRepository } from "../server/repositories/memory-replica-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryTaskRepository } from "../server/repositories/memory-task-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";
import type { LibraryResource } from "../server/types.js";
import { readFile } from "node:fs/promises";

const now = "2026-11-23T10:00:00.000Z";

async function makePng(r: number, g: number, b: number) {
  return sharp({ create: { width: 32, height: 32, channels: 4, background: { r, g, b, alpha: 1 } } })
    .png()
    .toBuffer();
}

function makeResource(overrides: Partial<LibraryResource> & { id: string }): LibraryResource {
  return {
    resourceType: "input_image",
    title: "示例商品图.png",
    summary: "32 × 32 · image/png",
    mimeType: "image/png",
    previewUrl: `/api/library/resources/${encodeURIComponent(overrides.id)}/preview`,
    suiteId: null,
    taskId: null,
    imageVersionId: null,
    baseVersionId: null,
    templateVersionId: null,
    resourceVersionId: overrides.id,
    stage: null,
    source: { objectKey: `objects/${overrides.id}.png` },
    status: "published",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function createFixture() {
  const suites = new MemorySuiteRepository();
  const tasks = new MemoryTaskRepository();
  const library = new MemoryLibraryRepository();
  const prompts = new MemoryPromptRepository();
  const pipelines = new MemoryPipelineRepository();
  const replicas = new MemoryReplicaRepository();
  const storage = new MemoryStorage();
  const pngA = await makePng(220, 40, 40);
  const pngB = await makePng(40, 180, 90);
  const pngC = await makePng(40, 90, 220);

  const sourceSuite = await suites.createSuite("来源方案");
  const canvasSuite = await suites.createSuite("画布方案", undefined, "canvas");

  const inputRes = makeResource({
    id: "input:img-1",
    resourceType: "input_image",
    title: "产品原图 1",
    suiteId: sourceSuite.id,
    resourceVersionId: "img-1",
    source: { objectKey: "inputs/img-1.png" },
  });
  const baseRes = makeResource({
    id: "base:base-1",
    resourceType: "base_image",
    title: "白底底图 1",
    suiteId: sourceSuite.id,
    baseVersionId: "base-1",
    resourceVersionId: "base-1",
    source: { objectKey: "bases/base-1.png" },
  });
  const taskVerRes = makeResource({
    id: "task-version:ver-1",
    resourceType: "task_image_version",
    title: "主图 · 版本 1",
    suiteId: sourceSuite.id,
    taskId: "task-ext-1",
    imageVersionId: "ver-1",
    resourceVersionId: "ver-1",
    stage: "task_image",
    source: { objectKey: "tasks/ver-1.png" },
  });
  const processRes = makeResource({
    id: "process:ver-1:0",
    resourceType: "process_image",
    title: "主图 · 过程图 1",
    suiteId: sourceSuite.id,
    taskId: "task-ext-1",
    imageVersionId: "ver-1",
    resourceVersionId: "ver-1:0",
    stage: "task_image",
    previewUrl: null,
    source: { objectKey: "tasks/proc-0.png" },
  });
  const promptRes = makeResource({
    id: "prompt:tpl-1",
    resourceType: "prompt_template",
    title: "系统计划模板",
    mimeType: null,
    previewUrl: null,
    templateVersionId: "tpl-1",
    resourceVersionId: "tpl-1",
    stage: "plan",
    source: { code: "sys.plan", versionNo: 1, body: "模板正文" },
  });

  await storage.put({ key: "inputs/img-1.png", bytes: pngA, contentType: "image/png" });
  await storage.put({ key: "bases/base-1.png", bytes: pngB, contentType: "image/png" });
  await storage.put({ key: "tasks/ver-1.png", bytes: pngC, contentType: "image/png" });
  await storage.put({ key: "tasks/proc-0.png", bytes: pngC, contentType: "image/png" });

  library.addResource(inputRes);
  library.addResource(baseRes);
  library.addResource(taskVerRes);
  library.addResource(processRes);
  library.addResource(promptRes);

  const reverseRes = await library.createReverseReferenceAsset({
    suiteId: sourceSuite.id,
    title: "爆品参考图 1",
    summary: "复刻反推",
    objectKey: "reverse/ref-1.png",
    mimeType: "image/png",
    promptSnapshot: { prompt: "复刻提示词" },
    source: { origin: "replica" },
  });
  await storage.put({ key: "reverse/ref-1.png", bytes: pngA, contentType: "image/png" });

  for (const rel of ["prompt/normalized/replica-compose.md", "prompt/normalized/replica-high.md"]) {
    const md = await readFile(rel, "utf8");
    const [draft] = await prompts.importRecords([parseNormalizedPromptMarkdown(md, rel)]);
    await prompts.publishVersion(draft.templateVersionId);
  }

  const app = createSuiteStudioApp({
    repository: suites,
    taskRepository: tasks,
    libraryRepository: library,
    promptRepository: prompts,
    pipelineRepository: pipelines,
    replicaRepository: replicas,
    storage,
    provider: {
      supportsMultipleImages: true,
      async edit() {
        return { bytes: pngC, mimeType: "image/png" };
      },
    },
  });

  return { app, suites, tasks, library, storage, sourceSuite, canvasSuite, inputRes, baseRes, taskVerRes, processRes, reverseRes, promptRes, pngA, pngB, pngC };
}

test("DELETE /api/library/resources/:id supports single delete, URL-encoded IDs, idempotency, 404 on invalid/unknown, and forbids prompt_template", async () => {
  const { app, reverseRes, promptRes } = await createFixture();

  // Malformed percent-encoding & nonexistent IDs -> 404
  const badEncoding = await app.request("DELETE", "/api/library/resources/%E0%A4%A");
  assert.equal(badEncoding.status, 404);
  assert.equal((badEncoding.body as any).error.code, "LIBRARY_RESOURCE_NOT_FOUND");

  const unknown = await app.request("DELETE", "/api/library/resources/input%3Anonexistent");
  assert.equal(unknown.status, 404);
  assert.equal((unknown.body as any).error.code, "LIBRARY_RESOURCE_NOT_FOUND");

  // Prompt template cannot be deleted via image library endpoint -> 403
  const promptDel = await app.request("DELETE", `/api/library/resources/${encodeURIComponent(promptRes.id)}`);
  assert.equal(promptDel.status, 403);
  assert.equal((promptDel.body as any).error.code, "LIBRARY_RESOURCE_FORBIDDEN");

  // Delete URL-encoded reverse asset -> 200 alreadyDeleted=false
  const encodedReverse = encodeURIComponent(reverseRes.id);
  const first = await app.request("DELETE", `/api/library/resources/${encodedReverse}`);
  assert.equal(first.status, 200);
  assert.equal((first.body as any).data.id, reverseRes.id);
  assert.equal((first.body as any).data.alreadyDeleted, false);
  assert.ok((first.body as any).data.deletedAt);

  // Repeat delete is idempotent -> 200 alreadyDeleted=true with same deletedAt
  const second = await app.request("DELETE", `/api/library/resources/${encodedReverse}`);
  assert.equal(second.status, 200);
  assert.equal((second.body as any).data.id, reverseRes.id);
  assert.equal((second.body as any).data.alreadyDeleted, true);
  assert.equal((second.body as any).data.deletedAt, (first.body as any).data.deletedAt);

  // Deleted resource no longer appears in list, detail, or status update
  const detail = await app.request("GET", `/api/library/resources/${encodedReverse}`);
  assert.equal(detail.status, 404);
  const statusUpdate = await app.request("POST", `/api/library/resources/${encodedReverse}/status`, {
    body: { status: "published" },
  });
  assert.equal(statusUpdate.status, 404);
  const list = await app.request("GET", "/api/library/resources?resourceType=reverse_reference_asset");
  assert.equal(list.status, 200);
  assert.equal((list.body as any).data.items.length, 0);
});

test("POST /api/library/resources/batch-delete validates payload, enforces 100 limit, is idempotent, and handles mixed/missing/forbidden IDs", async () => {
  const { app, inputRes, baseRes, processRes, promptRes } = await createFixture();

  // Empty / invalid body -> 400
  const empty = await app.request("POST", "/api/library/resources/batch-delete", { body: { ids: [] } });
  assert.equal(empty.status, 400);
  assert.equal((empty.body as any).error.code, "INVALID_LIBRARY_BATCH_DELETE");

  const nonString = await app.request("POST", "/api/library/resources/batch-delete", { body: { ids: [123] } });
  assert.equal(nonString.status, 400);
  assert.equal((nonString.body as any).error.code, "INVALID_LIBRARY_BATCH_DELETE");

  // > 100 items -> 400 LIBRARY_BATCH_DELETE_LIMIT
  const tooMany = await app.request("POST", "/api/library/resources/batch-delete", {
    body: { ids: Array.from({ length: 101 }, (_, i) => `input:id-${i}`) },
  });
  assert.equal(tooMany.status, 400);
  assert.equal((tooMany.body as any).error.code, "LIBRARY_BATCH_DELETE_LIMIT");

  // All nonexistent -> 404
  const allMissing = await app.request("POST", "/api/library/resources/batch-delete", {
    body: { ids: ["input:missing-1", "base:missing-2"] },
  });
  assert.equal(allMissing.status, 404);
  assert.equal((allMissing.body as any).error.code, "LIBRARY_RESOURCE_NOT_FOUND");

  // Contains prompt_template -> 403 and does not delete any other ID
  const withPrompt = await app.request("POST", "/api/library/resources/batch-delete", {
    body: { ids: [inputRes.id, promptRes.id] },
  });
  assert.equal(withPrompt.status, 403);
  assert.equal((await app.request("GET", `/api/library/resources/${encodeURIComponent(inputRes.id)}`)).status, 200);

  // Batch delete with duplicates and one missing ID
  const batch1 = await app.request("POST", "/api/library/resources/batch-delete", {
    body: { ids: [inputRes.id, baseRes.id, inputRes.id, processRes.id, "input:does-not-exist"] },
  });
  assert.equal(batch1.status, 200);
  assert.deepEqual((batch1.body as any).data.deletedIds, [inputRes.id, baseRes.id, processRes.id]);
  assert.deepEqual((batch1.body as any).data.alreadyDeletedIds, []);
  assert.deepEqual((batch1.body as any).data.notFoundIds, ["input:does-not-exist"]);
  assert.equal((batch1.body as any).data.deletedCount, 3);

  // Repeat batch delete is idempotent
  const batch2 = await app.request("POST", "/api/library/resources/batch-delete", {
    body: { ids: [inputRes.id, baseRes.id] },
  });
  assert.equal(batch2.status, 200);
  assert.deepEqual((batch2.body as any).data.deletedIds, []);
  assert.deepEqual((batch2.body as any).data.alreadyDeletedIds, [inputRes.id, baseRes.id]);
  assert.equal((batch2.body as any).data.deletedCount, 0);

  // Picker queries (base_image & input_image published) no longer return deleted items
  const pickerInputs = await app.request("GET", "/api/library/resources?resourceType=input_image&status=published&pageSize=100");
  const pickerBases = await app.request("GET", "/api/library/resources?resourceType=base_image&status=published&pageSize=100");
  assert.equal((pickerInputs.body as any).data.items.length, 0);
  assert.equal((pickerBases.body as any).data.items.length, 0);
});

test("deleting a library image referenced by a task keeps task card, frozen references, task generation, and previews working", async () => {
  const { app, tasks, canvasSuite, baseRes, inputRes, pngA, pngB } = await createFixture();

  // Create a canvas task and bind baseRes to it
  const { task } = await tasks.createCustomTask!({
    suiteId: canvasSuite.id,
    planSnapshotId: null,
    imageType: "main",
    title: "绑定白底图任务",
    purpose: "主图",
    promptDraft: "展示商品主体",
    sourceInputImageId: null,
    generationParams: { size: "1K", ratio: "1:1" },
  });

  const bindRes = await app.request("POST", `/api/suite-tasks/${task.id}/white-resource`, {
    headers: { "idempotency-key": "bind-before-delete" },
    body: { resourceIds: [baseRes.id] },
  });
  assert.equal(bindRes.status, 201);

  // Generate a version before deleting the resource
  const genRes = await app.request("POST", `/api/suite-tasks/${task.id}/generation`, {
    headers: { "idempotency-key": "gen-before-delete" },
    body: {},
  });
  assert.equal(genRes.status, 202);
  const batchId = (genRes.body as any).data.batchId as string;
  for (let i = 0; i < 40; i++) {
    const statusRes = await app.request("GET", `/api/generation-batches/${batchId}`);
    if ((statusRes.body as any).data.batch.status !== "running") break;
    await new Promise((r) => setTimeout(r, 15));
  }
  const versionsBefore = await app.request("GET", `/api/suite-tasks/${task.id}/versions`);
  assert.equal((versionsBefore.body as any).data.versions.length, 1);
  const versionId = (versionsBefore.body as any).data.versions[0].id as string;

  // Delete baseRes and inputRes from image library
  const delRes = await app.request("POST", "/api/library/resources/batch-delete", {
    body: { ids: [baseRes.id, inputRes.id] },
  });
  assert.equal(delRes.status, 200);
  assert.equal((delRes.body as any).data.deletedCount, 2);

  // 1. Deleted resources cannot be bound to new tasks or used in new replicas
  const rebind = await app.request("POST", `/api/suite-tasks/${task.id}/white-resource`, {
    headers: { "idempotency-key": "rebind-after-delete" },
    body: { resourceIds: [baseRes.id] },
  });
  assert.equal(rebind.status, 404);
  assert.equal((rebind.body as any).error.code, "LIBRARY_RESOURCE_NOT_FOUND");

  const replicaWithDeleted = await app.request("POST", "/api/replicas", {
    headers: { "idempotency-key": "replica-deleted-product" },
    body: {
      references: [{ filename: "ref.png", mimeType: "image/png", bytesBase64: pngA.toString("base64") }],
      products: [{ libraryResourceId: baseRes.id }],
      sceneType: "ecommerce_product",
      cloneLevel: "high",
      styleUnified: true,
      language: "zh",
      ratio: "1:1",
      size: "1K",
    },
  });
  assert.equal(replicaWithDeleted.status, 404);
  assert.equal((replicaWithDeleted.body as any).error.code, "LIBRARY_RESOURCE_NOT_FOUND");

  // 2. Existing task card, frozen references, task version preview, and library resource preview still work!
  const wbRes = await app.request("GET", `/api/suites/${canvasSuite.id}/workbench`);
  assert.equal(wbRes.status, 200);
  assert.equal((wbRes.body as any).data.tasks.length, 1);

  const refsRes = await app.request("GET", `/api/suites/${canvasSuite.id}/library/references?targetType=task&targetId=${task.id}`);
  assert.equal(refsRes.status, 200);
  assert.equal((refsRes.body as any).data.length, 1);
  assert.equal((refsRes.body as any).data[0].resourceId, baseRes.id);

  const versionPreview = await app.previewTaskVersion(task.id, versionId);
  assert.equal(versionPreview.status, 200);
  assert.ok(versionPreview.raw && versionPreview.raw.length > 0);

  // Both HTTP route and direct previewLibraryResource continue serving deleted resource preview for frozen references
  const routePreview = await app.request("GET", `/api/library/resources/${encodeURIComponent(baseRes.id)}/preview`);
  assert.equal(routePreview.status, 200);
  assert.deepEqual(routePreview.raw, pngB);

  const directPreview = await app.previewLibraryResource(baseRes.id);
  assert.equal(directPreview.status, 200);
  assert.deepEqual(directPreview.raw, pngB);

  // 3. Re-generating the existing task using its frozen library reference still succeeds
  const regen = await app.request("POST", `/api/suite-tasks/${task.id}/generation`, {
    headers: { "idempotency-key": "gen-after-delete" },
    body: {},
  });
  assert.equal(regen.status, 202);
  const batchId2 = (regen.body as any).data.batchId as string;
  let finalStatus = "running";
  for (let i = 0; i < 40; i++) {
    const statusRes = await app.request("GET", `/api/generation-batches/${batchId2}`);
    finalStatus = (statusRes.body as any).data.batch.status;
    if (finalStatus !== "running") break;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.equal(finalStatus, "completed");
});

test("GET /api/library/resources supports scope=image pagination & resourceType filtering, reverse re-save resets draft, and selecting final restores deleted task-version", async () => {
  const { app, tasks, library, canvasSuite, sourceSuite, reverseRes, baseRes, pngA } = await createFixture();

  // Invalid scope -> 400
  const badScope = await app.request("GET", "/api/library/resources?scope=invalid");
  assert.equal(badScope.status, 400);
  assert.equal((badScope.body as any).error.code, "INVALID_LIBRARY_SCOPE");

  // Seed 26 published input images + keep prompt_template in library
  for (let i = 1; i <= 26; i++) {
    library.addResource(
      makeResource({
        id: `input:page-img-${String(i).padStart(2, "0")}`,
        resourceType: "input_image",
        title: `分页测试原图 ${String(i).padStart(2, "0")}`,
        suiteId: sourceSuite.id,
        resourceVersionId: `page-img-${i}`,
        updatedAt: `2026-11-23T11:${String(i).padStart(2, "0")}:00.000Z`,
      }),
    );
  }

  // scope=image excludes prompt_template and returns true total across pages
  const page1 = await app.request("GET", "/api/library/resources?scope=image&status=published&page=1&pageSize=24");
  assert.equal(page1.status, 200);
  const p1Data = (page1.body as any).data;
  assert.equal(p1Data.items.some((item: any) => item.resourceType === "prompt_template"), false);
  // 26 seeded + inputRes + baseRes + taskVerRes + processRes = 30 published image assets (reverseRes is draft)
  assert.equal(p1Data.total, 30);
  assert.equal(p1Data.items.length, 24);

  const page2 = await app.request("GET", "/api/library/resources?scope=image&status=published&page=2&pageSize=24");
  assert.equal(page2.status, 200);
  const p2Data = (page2.body as any).data;
  assert.equal(p2Data.total, 30);
  assert.equal(p2Data.items.length, 6);

  // scope=image with resourceType=input_image filters cleanly on server
  const onlyInputs = await app.request("GET", "/api/library/resources?scope=image&resourceType=input_image&status=published&page=2&pageSize=24");
  assert.equal(onlyInputs.status, 200);
  assert.equal((onlyInputs.body as any).data.total, 27);
  assert.equal((onlyInputs.body as any).data.items.length, 3);
  assert.equal((onlyInputs.body as any).data.items.every((item: any) => item.resourceType === "input_image"), true);

  // Reverse asset: archive -> soft-delete -> re-save resets status back to draft
  const archived = await app.request("POST", `/api/library/resources/${encodeURIComponent(reverseRes.id)}/status`, {
    body: { status: "archived" },
  });
  assert.equal(archived.status, 200);
  assert.equal((archived.body as any).data.status, "archived");
  const delRev = await app.request("DELETE", `/api/library/resources/${encodeURIComponent(reverseRes.id)}`);
  assert.equal(delRev.status, 200);
  assert.equal((await app.request("GET", `/api/library/resources/${encodeURIComponent(reverseRes.id)}`)).status, 404);

  const resaved = await library.createReverseReferenceAsset({
    suiteId: sourceSuite.id,
    title: "爆品参考图 1 重存",
    summary: "重新保存",
    objectKey: "reverse/ref-1.png",
    mimeType: "image/png",
    promptSnapshot: { prompt: "新提示词" },
    source: { origin: "replica" },
  });
  assert.equal(resaved.id, reverseRes.id);
  assert.equal(resaved.status, "draft");
  const visibleAgain = await app.request("GET", `/api/library/resources/${encodeURIComponent(reverseRes.id)}`);
  assert.equal(visibleAgain.status, 200);
  assert.equal((visibleAgain.body as any).data.status, "draft");

  // Task version: generate -> register in library -> soft-delete -> select as final restores visibility in library
  const { task } = await tasks.createCustomTask!({
    suiteId: canvasSuite.id,
    planSnapshotId: null,
    imageType: "main",
    title: "终版恢复测试",
    purpose: "主图",
    promptDraft: "展示商品",
    sourceInputImageId: null,
    generationParams: { size: "1K", ratio: "1:1" },
  });
  await app.request("POST", `/api/suite-tasks/${task.id}/white-resource`, {
    headers: { "idempotency-key": "bind-final-restore" },
    body: { resourceIds: [baseRes.id] },
  });
  const gen = await app.request("POST", `/api/suite-tasks/${task.id}/generation`, {
    headers: { "idempotency-key": "gen-final-restore" },
    body: {},
  });
  assert.equal(gen.status, 202);
  const batchId = (gen.body as any).data.batchId as string;
  for (let i = 0; i < 40; i++) {
    const st = await app.request("GET", `/api/generation-batches/${batchId}`);
    if ((st.body as any).data.batch.status !== "running") break;
    await new Promise((r) => setTimeout(r, 15));
  }
  const versionsRes = await app.request("GET", `/api/suite-tasks/${task.id}/versions`);
  const versionId = (versionsRes.body as any).data.versions[0].id as string;
  const tvResourceId = `task-version:${versionId}`;
  library.addResource(
    makeResource({
      id: tvResourceId,
      resourceType: "task_image_version",
      title: "终版恢复测试 · 版本 1",
      suiteId: canvasSuite.id,
      taskId: task.id,
      imageVersionId: versionId,
      resourceVersionId: versionId,
      stage: "replica_prompt",
      source: { objectKey: "tasks/final-restore.png" },
    }),
  );
  assert.ok(pngA.length > 0);
  const delTv = await app.request("DELETE", `/api/library/resources/${encodeURIComponent(tvResourceId)}`);
  assert.equal(delTv.status, 200);
  assert.equal((await app.request("GET", `/api/library/resources/${encodeURIComponent(tvResourceId)}`)).status, 404);

  // Selecting as current does NOT clear deletion; selecting as final DOES restore visibility
  const selectCurrent = await app.request("POST", `/api/suite-tasks/${task.id}/versions/${versionId}/select`, {
    headers: { "idempotency-key": "select-current-1" },
    body: { selection: "current" },
  });
  assert.equal(selectCurrent.status, 200);
  assert.equal((await app.request("GET", `/api/library/resources/${encodeURIComponent(tvResourceId)}`)).status, 404);

  const selectFinal = await app.request("POST", `/api/suite-tasks/${task.id}/versions/${versionId}/select`, {
    headers: { "idempotency-key": "select-final-1" },
    body: { selection: "final" },
  });
  assert.equal(selectFinal.status, 200);
  const restoredTv = await app.request("GET", `/api/library/resources/${encodeURIComponent(tvResourceId)}`);
  assert.equal(restoredTv.status, 200);
  assert.equal((restoredTv.body as any).data.id, tvResourceId);
});
