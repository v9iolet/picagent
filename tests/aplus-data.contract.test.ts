import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createSuiteStudioApp } from "../server/app.js";
import { MemoryPipelineRepository } from "../server/repositories/memory-pipeline-repository.js";
import { MemoryPlatformRepository } from "../server/repositories/memory-platform-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryTaskRepository } from "../server/repositories/memory-task-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";
import type { PlatformProfile } from "../server/types.js";

test("内存平台仓储与平台 API 返回详情尺寸预设，并保留自定义选项", async () => {
  const profile = {
    mainImageBackground: "flexible", mainImageStrategy: "", galleryStrategy: "",
    textStrategy: "", modelStrategy: "", sourceNote: "",
  } as const;
  const configured = { options: ["9:16", "16:9"], default: "9:16" };
  const platformRepository = new MemoryPlatformRepository([
    { ...profile, code: "amazon", name: "Amazon", marketScope: "overseas", sortOrder: 10 },
    { ...profile, code: "taobao", name: "淘宝 / 天猫", marketScope: "domestic", sortOrder: 200 },
    { ...profile, code: "ebay", name: "eBay", marketScope: "overseas", sortOrder: 40 },
    { ...profile, code: "custom", name: "Custom", marketScope: "domestic", sortOrder: 300, detailSizePresets: configured },
  ]);
  const app = createSuiteStudioApp({ repository: new MemorySuiteRepository(), storage: new MemoryStorage(), platformRepository });
  const response = await app.request("GET", "/api/platforms");
  assert.equal(response.status, 200);
  const common = ["1:1", "3:4", "9:16", "16:9"];
  const expected = {
    amazon: { options: ["aplus_premium_web", "aplus_premium_mobile", "aplus_standard", ...common], default: "aplus_standard" },
    taobao: { options: common, default: "3:4" },
    ebay: { options: common, default: "1:1" },
    custom: configured,
  };
  assert.deepEqual(Object.fromEntries(response.body.data.map(({ code, detailSizePresets }: PlatformProfile) => [code, detailSizePresets])), expected);
  assert.deepEqual((await platformRepository.find("Amazon US"))?.detailSizePresets, expected.amazon);
});

test("A+ 批次可按来源查询生成记录，有任务卡也不会出现在画布列表", async () => {
  const repository = new MemorySuiteRepository();
  const pipelineRepository = new MemoryPipelineRepository();
  const taskRepository = new MemoryTaskRepository();
  const app = createSuiteStudioApp({ repository, storage: new MemoryStorage(), pipelineRepository, taskRepository });
  const aplus = await repository.createSuite("耳机 A+", undefined, "aplus");
  const studio = await repository.createSuite("耳机套图", undefined, "suite_studio");
  const canvas = await repository.createSuite("空白画布", undefined, "canvas");
  await repository.createSuite("空 A+ 草稿", undefined, "aplus");

  for (const suite of [aplus, studio]) {
    await taskRepository.createCustomTask({
      suiteId: suite.id, planSnapshotId: null, imageType: "detail", title: "详情卡",
      purpose: "展示材质", promptDraft: "展示耳机", sourceInputImageId: null, generationParams: {},
    });
  }
  const awaiting = await repository.createSuite("等待方案确认", undefined, "aplus");
  const now = new Date().toISOString();
  await pipelineRepository.createRun({
    id: randomUUID(), suiteId: awaiting.id, idempotencyKey: "plan",
    status: "waiting_human_input", currentPhase: "awaiting_confirmation",
    config: { platform: "amazon" }, errorCode: null, errorMessage: null,
    createdAt: now, updatedAt: now, completedAt: null,
  });

  const feed = await app.request("GET", "/api/suites/feed?origin=aplus");
  assert.equal(feed.status, 200);
  assert.equal(feed.body.data.total, 2);
  assert.deepEqual(new Set(feed.body.data.items.map(({ suite }: { suite: { id: string } }) => suite.id)), new Set([aplus.id, awaiting.id]));
  const filtered = await app.request("GET", "/api/suites/feed?origin=aplus&keyword=耳机");
  assert.equal(filtered.status, 200);
  assert.deepEqual(filtered.body.data.items.map(({ suite }: { suite: { id: string } }) => suite.id), [aplus.id]);
  const defaultFeed = await app.request("GET", "/api/suites/feed");
  assert.deepEqual(defaultFeed.body.data.items.map(({ suite }: { suite: { id: string } }) => suite.id), [studio.id]);
  const canvases = await app.request("GET", "/api/suites?view=canvas");
  assert.equal(canvases.status, 200);
  assert.deepEqual(new Set(canvases.body.data.map(({ id }: { id: string }) => id)), new Set([studio.id, canvas.id]));
});
