import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { createSuiteStudioApp } from "../server/app.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryTaskRepository } from "../server/repositories/memory-task-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";
import { createVectorOverlayPreset } from "../shared/vector-overlay.js";

test("POST /api/suite-tasks/:taskId/vector-overlay/render keeps cleanBaseVersionId across repeated edits and validates errors", async () => {
  const repository = new MemorySuiteRepository();
  const taskRepository = new MemoryTaskRepository();
  const storage = new MemoryStorage();
  const baseBytes = await sharp({
    create: { width: 320, height: 320, channels: 3, background: { r: 250, g: 250, b: 252 } },
  }).png().toBuffer();

  const app = createSuiteStudioApp({
    repository,
    taskRepository,
    storage,
    provider: {
      async edit() {
        return { bytes: baseBytes, mimeType: "image/png" };
      },
    },
  });

  const suiteRes = await app.request("POST", "/api/suites", { body: { name: "矢量排版契约", origin: "canvas" } });
  assert.equal(suiteRes.status, 201);
  const suiteId = (suiteRes.body as any).data.id;

  const uploadRes = await app.upload(suiteId, { filename: "sample.png", mimeType: "image/png", bytes: baseBytes });
  assert.equal(uploadRes.status, 201);
  const inputId = (uploadRes.body as any).data.id;

  const taskRes = await app.request("POST", `/api/suites/${suiteId}/tasks/custom`, {
    body: {
      imageType: "detail",
      title: "氮化镓卖点卡",
      sourceInputImageId: inputId,
      promptDraft: "商业棚拍图",
    },
  });
  assert.equal(taskRes.status, 201);
  const taskId = (taskRes.body as any).data.id;

  // Before any image version exists -> 409 and no failed attempts persisted
  const noVersionRes = await app.request("POST", `/api/suite-tasks/${taskId}/vector-overlay/render`, {
    body: { overlay: createVectorOverlayPreset("hero_color_block", { headline: "无底图测试" }) },
  });
  assert.equal(noVersionRes.status, 409);
  assert.equal((await taskRepository.listTaskVersions(taskId)).attempts.length, 0);

  // Generate v1 clean base
  const genRes = await app.request("POST", `/api/suite-tasks/${taskId}/generation`, {
    headers: { "idempotency-key": "contract-gen-v1" },
  });
  assert.equal(genRes.status, 202);
  const batchId = (genRes.body as any).data.batchId;
  for (let i = 0; i < 40; i += 1) {
    const batch = await taskRepository.getBatch(batchId);
    if (batch?.status === "completed") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  const v1History = await taskRepository.listTaskVersions(taskId);
  assert.equal(v1History.versions.length, 1);
  const v1 = v1History.versions[0];

  // Invalid overlay -> 400 and no failed attempt
  const invalidRes = await app.request("POST", `/api/suite-tasks/${taskId}/vector-overlay/render`, {
    body: { overlay: { version: 1, layoutId: "hero_color_block", themeId: "dark_tech", elements: [] } },
  });
  assert.equal(invalidRes.status, 400);
  assert.equal((await taskRepository.listTaskVersions(taskId)).attempts.length, 1);

  // First vector render: v1 -> v2
  const overlay1 = createVectorOverlayPreset("hero_color_block", {
    headline: "第一次排版标题",
    themeId: "dark_tech",
  });
  const render1 = await app.request("POST", `/api/suite-tasks/${taskId}/vector-overlay/render`, {
    headers: { "idempotency-key": "render-v2" },
    body: { overlay: overlay1 },
  });
  assert.equal(render1.status, 200);
  const v2 = (render1.body as any).data.version;
  assert.equal(v2.versionNumber, 2);
  assert.equal(v2.isCurrent, true);
  assert.equal(v2.promptSnapshot.cleanBaseVersionId, v1.id);
  assert.deepEqual(v2.promptSnapshot.vectorOverlay, overlay1);

  // Second vector render (without explicit baseVersionId): must trace back to v1, NOT v2!
  const overlay2 = createVectorOverlayPreset("left_pills_right_hero", {
    headline: "第二次修改标题",
    points: ["卖点A", "卖点B", "卖点C"],
    themeId: "vibrant_promo",
  });
  const render2 = await app.request("POST", `/api/suite-tasks/${taskId}/vector-overlay/render`, {
    headers: { "idempotency-key": "render-v3" },
    body: { overlay: overlay2 },
  });
  assert.equal(render2.status, 200);
  const v3 = (render2.body as any).data.version;
  assert.equal(v3.versionNumber, 3);
  assert.equal(v3.isCurrent, true);
  assert.equal(v3.promptSnapshot.cleanBaseVersionId, v1.id);
  assert.deepEqual(v3.promptSnapshot.vectorOverlay, overlay2);

  const history = await taskRepository.listTaskVersions(taskId);
  assert.equal(history.versions.length, 3);
  assert.equal(history.versions.filter((v) => v.isCurrent).length, 1);
  assert.equal(history.versions.find((v) => v.isCurrent)?.id, v3.id);
  assert.ok(history.attempts.every((a) => a.status === "succeeded"));

  const v3Object = await storage.get(v3.objectKey);
  assert.ok(v3Object);
  assert.notEqual(Buffer.compare(v3Object.bytes, baseBytes), 0);
});
