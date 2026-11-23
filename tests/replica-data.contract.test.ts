import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createSuiteStudioApp } from "../server/app.js";
import { MemoryPipelineRepository } from "../server/repositories/memory-pipeline-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryTaskRepository } from "../server/repositories/memory-task-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";
import type { SuitePipelinePhase, SuitePipelineRun } from "../server/types.js";

function fixture() {
  const repository = new MemorySuiteRepository();
  const taskRepository = new MemoryTaskRepository();
  const pipelineRepository = new MemoryPipelineRepository();
  const storage = new MemoryStorage();
  const app = createSuiteStudioApp({ repository, taskRepository, pipelineRepository, storage });
  return { app, repository, taskRepository, pipelineRepository, storage };
}

function pipelineRun(
  suiteId: string,
  overrides: Partial<SuitePipelineRun> = {},
): SuitePipelineRun {
  const timestamp = overrides.createdAt ?? new Date().toISOString();
  return {
    id: randomUUID(),
    suiteId,
    idempotencyKey: `key-${randomUUID()}`,
    status: "completed",
    currentPhase: "done",
    config: { platform: "taobao" },
    errorCode: null,
    errorMessage: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: timestamp,
    ...overrides,
  };
}

async function createTimedSuite(
  repository: MemorySuiteRepository,
  name: string,
  origin: "suite_studio" | "canvas" | "replica",
  createdAt: string,
) {
  const suite = await repository.createSuite(name, undefined, origin);
  suite.createdAt = createdAt;
  suite.updatedAt = createdAt;
  return suite;
}

test("POST /api/suites accepts suite_studio and canvas but rejects origin=replica and unknown origins", async () => {
  const { app, repository } = fixture();

  const defaultRes = await app.request("POST", "/api/suites", { body: { name: "默认来源方案" } });
  assert.equal(defaultRes.status, 201);
  assert.equal((defaultRes.body as any).data.origin, "suite_studio");

  const studioRes = await app.request("POST", "/api/suites", { body: { name: "套图来源方案", origin: "suite_studio" } });
  assert.equal(studioRes.status, 201);
  assert.equal((studioRes.body as any).data.origin, "suite_studio");

  const canvasRes = await app.request("POST", "/api/suites", { body: { name: "画布来源方案", origin: "canvas" } });
  assert.equal(canvasRes.status, 201);
  assert.equal((canvasRes.body as any).data.origin, "canvas");

  for (const invalidOrigin of ["replica", "unknown", "", null, 123]) {
    const rejected = await app.request("POST", "/api/suites", {
      body: { name: "非法来源方案", origin: invalidOrigin },
    });
    assert.equal(rejected.status, 400);
    assert.equal((rejected.body as any).error.code, "INVALID_SUITE_ORIGIN");
  }

  const all = await repository.listSuites();
  assert.equal(all.length, 3);
  assert.equal(all.some((suite) => suite.origin === "replica"), false);
});

test("canvas list excludes replica suites even when they have active tasks and pipeline runs", async () => {
  const { app, repository, taskRepository, pipelineRepository } = fixture();

  const blankCanvas = await repository.createSuite("空白画布", undefined, "canvas");
  const emptyStudioDraft = await repository.createSuite("空套图草稿", undefined, "suite_studio");
  const studioWithTask = await repository.createSuite("有卡套图", undefined, "suite_studio");
  await taskRepository.createCustomTask({
    suiteId: studioWithTask.id,
    planSnapshotId: null,
    imageType: "main",
    title: "套图主图",
    purpose: "主图展示",
    promptDraft: "白底主图",
    sourceInputImageId: null,
    generationParams: {},
  });

  const replicaBatch = await repository.createSuite("爆品复刻批次", undefined, "replica");
  await pipelineRepository.createRun(
    pipelineRun(replicaBatch.id, {
      status: "running",
      currentPhase: "replica_analyzing",
      completedAt: null,
      config: { cloneLevel: "high", sceneType: "ecommerce", styleUnified: true },
    }),
  );
  await taskRepository.createCustomTask({
    suiteId: replicaBatch.id,
    planSnapshotId: null,
    imageType: "main",
    title: "复刻结果卡",
    purpose: "复刻出图",
    promptDraft: "参考图风格复刻",
    sourceInputImageId: null,
    generationParams: {},
  });

  const res = await app.request("GET", "/api/suites?view=canvas");
  assert.equal(res.status, 200);
  const ids = (res.body as any).data.map((suite: { id: string }) => suite.id);
  assert.deepEqual(new Set(ids), new Set([blankCanvas.id, studioWithTask.id]));
  assert.equal(ids.includes(replicaBatch.id), false);
  assert.equal(ids.includes(emptyStudioDraft.id), false);
});

test("GET /api/suites/feed filters by exact origin, defaults to suite_studio, and rejects invalid origin", async () => {
  const { app, repository, taskRepository, pipelineRepository } = fixture();

  await createTimedSuite(repository, "空套图草稿", "suite_studio", "2026-01-01T00:00:00.000Z");
  const studioOld = await createTimedSuite(repository, "套图批次 A", "suite_studio", "2026-01-02T00:00:00.000Z");
  await pipelineRepository.createRun(pipelineRun(studioOld.id));

  const studioNew = await createTimedSuite(repository, "套图批次 B", "suite_studio", "2026-01-03T00:00:00.000Z");
  await taskRepository.createCustomTask({
    suiteId: studioNew.id,
    planSnapshotId: null,
    imageType: "main",
    title: "蓝牙耳机主图",
    purpose: "主图",
    promptDraft: "展示耳机",
    sourceInputImageId: null,
    generationParams: {},
  });

  const canvasActive = await createTimedSuite(repository, "自由画布批次", "canvas", "2026-01-04T00:00:00.000Z");
  await taskRepository.createCustomTask({
    suiteId: canvasActive.id,
    planSnapshotId: null,
    imageType: "detail",
    title: "画布细节卡",
    purpose: "细节",
    promptDraft: "展示材质",
    sourceInputImageId: null,
    generationParams: {},
  });

  await createTimedSuite(repository, "空复刻草稿", "replica", "2026-01-05T00:00:00.000Z");
  const replicaOld = await createTimedSuite(repository, "复刻批次 1", "replica", "2026-01-06T00:00:00.000Z");
  const analyzingPhase: SuitePipelinePhase = "replica_analyzing";
  await pipelineRepository.createRun(
    pipelineRun(replicaOld.id, {
      status: "running",
      currentPhase: analyzingPhase,
      completedAt: null,
      config: { cloneLevel: "high", sceneType: "ecommerce", styleUnified: true },
    }),
  );

  const replicaNew = await createTimedSuite(repository, "复刻批次 2", "replica", "2026-01-07T00:00:00.000Z");
  await pipelineRepository.createRun(
    pipelineRun(replicaNew.id, {
      status: "completed",
      currentPhase: "done",
      config: { cloneLevel: "compose", sceneType: "fashion", styleUnified: false },
    }),
  );

  const defaultFeed = await app.request("GET", "/api/suites/feed");
  assert.equal(defaultFeed.status, 200);
  assert.equal((defaultFeed.body as any).data.total, 2);
  assert.deepEqual(
    (defaultFeed.body as any).data.items.map((item: { suite: { id: string } }) => item.suite.id),
    [studioNew.id, studioOld.id],
  );

  const studioFeed = await app.request("GET", "/api/suites/feed?origin=suite_studio");
  assert.equal(studioFeed.status, 200);
  assert.equal((studioFeed.body as any).data.total, 2);
  assert.deepEqual(
    (studioFeed.body as any).data.items.map((item: { suite: { id: string } }) => item.suite.id),
    [studioNew.id, studioOld.id],
  );

  const replicaFeed = await app.request("GET", "/api/suites/feed?origin=replica");
  assert.equal(replicaFeed.status, 200);
  assert.equal((replicaFeed.body as any).data.total, 2);
  assert.deepEqual(
    (replicaFeed.body as any).data.items.map((item: { suite: { id: string } }) => item.suite.id),
    [replicaNew.id, replicaOld.id],
  );
  assert.equal((replicaFeed.body as any).data.items[1].pipeline.currentPhase, "replica_analyzing");

  const canvasFeed = await app.request("GET", "/api/suites/feed?origin=canvas");
  assert.equal(canvasFeed.status, 200);
  assert.equal((canvasFeed.body as any).data.total, 1);
  assert.deepEqual(
    (canvasFeed.body as any).data.items.map((item: { suite: { id: string } }) => item.suite.id),
    [canvasActive.id],
  );

  const invalidFeed = await app.request("GET", "/api/suites/feed?origin=invalid_origin");
  assert.equal(invalidFeed.status, 400);
  assert.equal((invalidFeed.body as any).error.code, "INVALID_SUITE_ORIGIN");
});

test("GET /api/suites/feed supports case-insensitive keyword matching across suite name and active task titles with pagination", async () => {
  const { app, repository, taskRepository, pipelineRepository } = fixture();

  const r1 = await createTimedSuite(repository, "Summer Sneaker Campaign", "replica", "2026-02-01T00:00:00.000Z");
  await pipelineRepository.createRun(pipelineRun(r1.id));

  const r2 = await createTimedSuite(repository, "冬季羽绒服复刻", "replica", "2026-02-02T00:00:00.000Z");
  await pipelineRepository.createRun(pipelineRun(r2.id));
  await taskRepository.createCustomTask({
    suiteId: r2.id,
    planSnapshotId: null,
    imageType: "main",
    title: "Sneaker Style Hero Shot",
    purpose: "主图",
    promptDraft: "复刻主图",
    sourceInputImageId: null,
    generationParams: {},
  });

  const r3 = await createTimedSuite(repository, "保温杯参考复刻", "replica", "2026-02-03T00:00:00.000Z");
  await pipelineRepository.createRun(pipelineRun(r3.id));
  const archivedTask = await taskRepository.createCustomTask({
    suiteId: r3.id,
    planSnapshotId: null,
    imageType: "main",
    title: "Archived Sneaker Task",
    purpose: "旧任务",
    promptDraft: "旧提示词",
    sourceInputImageId: null,
    generationParams: {},
  });
  await taskRepository.updateTask(archivedTask.task.id, { status: "archived" });

  // Also add a suite_studio suite containing the same keyword to prove origin isolation.
  const studioSameKeyword = await createTimedSuite(repository, "Sneaker Studio Batch", "suite_studio", "2026-02-04T00:00:00.000Z");
  await pipelineRepository.createRun(pipelineRun(studioSameKeyword.id));

  const page1 = await app.request("GET", "/api/suites/feed?origin=replica&keyword=SNEAKER&limit=1&offset=0");
  assert.equal(page1.status, 200);
  assert.equal((page1.body as any).data.total, 2);
  assert.equal((page1.body as any).data.limit, 1);
  assert.equal((page1.body as any).data.offset, 0);
  assert.deepEqual(
    (page1.body as any).data.items.map((item: { suite: { id: string } }) => item.suite.id),
    [r2.id],
  );

  const page2 = await app.request("GET", "/api/suites/feed?origin=replica&keyword=sneaker&limit=1&offset=1");
  assert.equal(page2.status, 200);
  assert.equal((page2.body as any).data.total, 2);
  assert.deepEqual(
    (page2.body as any).data.items.map((item: { suite: { id: string } }) => item.suite.id),
    [r1.id],
  );

  const chineseSearch = await app.request("GET", `/api/suites/feed?origin=replica&keyword=${encodeURIComponent("羽绒服")}`);
  assert.equal(chineseSearch.status, 200);
  assert.equal((chineseSearch.body as any).data.total, 1);
  assert.deepEqual(
    (chineseSearch.body as any).data.items.map((item: { suite: { id: string } }) => item.suite.id),
    [r2.id],
  );

  const blankKeyword = await app.request("GET", "/api/suites/feed?origin=replica&keyword=%20%20");
  assert.equal(blankKeyword.status, 200);
  assert.equal((blankKeyword.body as any).data.total, 3);
  assert.deepEqual(
    (blankKeyword.body as any).data.items.map((item: { suite: { id: string } }) => item.suite.id),
    [r3.id, r2.id, r1.id],
  );
});

test("031 migration SQL defines replica tables, columns, and extended CHECK constraints safely", async () => {
  const sql = await readFile("db/migrations/031_product_replica.sql", "utf8");
  assert.doesNotMatch(
    sql,
    /\bpublic\b"?\s*\.|\b(?:COMMIT|ROLLBACK|ABORT|END\s+(?:TRANSACTION|WORK)|SET\s+(?:LOCAL\s+|SESSION\s+)?search_path)\b|(?:^|;)\s*END\s*;/i,
  );
  assert.match(sql, /suites_origin_check\s+CHECK\s*\(origin\s+IN\s*\('suite_studio',\s*'canvas',\s*'replica'\)\)/i);
  assert.match(sql, /suite_tasks_origin_kind_check\s+CHECK\s*\(origin_kind\s+IN\s*\('suite_plan',\s*'reverse_import',\s*'replica'\)\)/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS replica_reference_id uuid REFERENCES suite_workbench\.replica_references\(id\)/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS replica_reference_object_key text/i);
  assert.match(sql, /suite_pipeline_runs_current_phase_check[\s\S]*'replica_analyzing'/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS suite_workbench\.replica_references/i);
  assert.match(sql, /char_length\(remark\)\s*<=\s*200/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS suite_workbench\.replica_product_images/i);
  assert.match(sql, /source_kind\s+text\s+NOT NULL\s+CHECK\s*\(source_kind\s+IN\s*\('upload',\s*'library'\)\)/i);
});
