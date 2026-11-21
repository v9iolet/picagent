import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { MemoryPipelineRepository } from "../server/repositories/memory-pipeline-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { createTicket02App } from "../server/app.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";
import { MemoryPromptRepository } from "../server/repositories/memory-prompt-repository.js";
import { MemoryPlanRepository } from "../server/repositories/memory-plan-repository.js";
import { MemoryCategoryPromptRepository } from "../server/repositories/memory-category-prompt-repository.js";
import { MemoryTaskRepository } from "../server/repositories/memory-task-repository.js";
import { parseNormalizedPromptMarkdown } from "../server/prompt-library.js";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import pg from "pg";
import { PostgresPipelineRepository } from "../server/repositories/postgres-pipeline-repository.js";
import { readZipEntries } from "../server/zip.js";
import type { AppResponse, Ticket02App } from "../server/app.js";
import type { SuitePipelineRun } from "../server/types.js";

const originalFact = "轻量化铝合金机身";
const addedFact = "支持 IP67 防水";
const oneCard = { platform: "淘宝", counts: { main: 1, selling_points: 0, lifestyle: 0, other: 0 } };
const twoCards = { ...oneCard, counts: { ...oneCard.counts, selling_points: 1 } };


async function pipelineFixture(options: {
  missingFacts?: boolean;
  maxMissingFacts?: boolean;
  providerFails?: boolean;
  beforeImage?: (call: number) => Promise<void>;
  beforeCategory?: (call: number) => Promise<void>;
} = {}) {
  const repository = new MemorySuiteRepository();
  const storage = new MemoryStorage();
  const prompts = new MemoryPromptRepository();
  for (const name of ["general-structure-plan-groups.md", "general-category-prompt-groups.md", "general-base-refine.md"]) {
    const record = parseNormalizedPromptMarkdown(await readFile(new URL(`../prompt/normalized/${name}`, import.meta.url), "utf8"), name);
    const [version] = await prompts.importRecords([record]);
    await prompts.publishVersion(version.templateVersionId);
  }
  const suite = await repository.createSuite("流水线测试");
  const bytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: "white" } }).png().toBuffer();
  const inputId = randomUUID();
  const originalKey = `suites/${suite.id}/inputs/${inputId}/original`;
  const thumbKey = `suites/${suite.id}/inputs/${inputId}/thumbnail`;
  await storage.put({ key: originalKey, bytes, contentType: "image/png" });
  await storage.put({ key: thumbKey, bytes, contentType: "image/png" });
  await storage.put({ key: originalKey.replace(/\/original$/, "/generation-input.jpg"), bytes, contentType: "image/jpeg" });
  await repository.createInputImage({ id: inputId, suiteId: suite.id, ordinal: 1, originalObjectKey: originalKey, thumbnailObjectKey: thumbKey, sha256: randomUUID().replaceAll("-", "").padEnd(64, "0"), width: 16, height: 16, mimeType: "image/png", originalFilename: "商品.png", currentBaseVersionId: null, createdAt: new Date().toISOString() });
  const pipeline = new MemoryPipelineRepository();
  let providerFails = Boolean(options.providerFails);
  let providerCalls = 0;
  const planRepository = new MemoryPlanRepository();
  const categoryPromptRepository = new MemoryCategoryPromptRepository();
  const taskRepository = new MemoryTaskRepository();
  const supplements: string[] = [];
  let categoryCalls = 0;
  const createApp = () => createTicket02App({
    repository, storage, pipelineRepository: pipeline, promptRepository: prompts,
    planRepository, categoryPromptRepository, taskRepository,
    provider: { async edit() {
      providerCalls += 1;
      await options.beforeImage?.(providerCalls);
      if (providerFails) throw new Error("IMAGE_PROVIDER_FAILED");
      return { bytes, mimeType: "image/png" };
    } },
    platformRepository: {
      find: async (value) => ({
        code: value, name: value, marketScope: "domestic", mainImageBackground: value === "Amazon" ? "pure_white_required" : "flexible",
        mainImageStrategy: "", galleryStrategy: "", textStrategy: "", modelStrategy: "", sourceNote: "", sortOrder: 1,
      }),
      listEnabled: async () => [],
    },
    llmClient: {
      provider: "fake", model: "fake", isFake: true,
      async generatePlan(input) {
        const supplement = String(input.dynamicInput.human_supplement ?? "");
        supplements.push(supplement);
        const missing = options.missingFacts && ![originalFact, addedFact].every((fact) => supplement.includes(fact));
        const imageId = input.inputImageIds[0];
        const groups = JSON.parse(String(input.dynamicInput.category_groups));
        const details = groups.selling_points.count;
        return {
          schemaVersion: "suite-structure-plan-v2", status: missing ? "NEEDS_HUMAN_INPUT" : "READY_FOR_REVIEW",
          mainAllocation: { category: "main", count: 1, reason: "主图", sourceImageIds: [imageId], factRefs: [], missingFacts: [] },
          detailImageCount: details,
          categoryAllocations: ["feature_benefit", "material_detail", "lifestyle_use", "comparison", "size_scale", "appearance_angles", "included_items", "compatibility_application", "variant_bundle", "packaging_unboxing", "care_instruction"].map((category) => ({
            category, requirement: "optional", count: category === "feature_benefit" ? details : 0, reason: "", sourceImageIds: [imageId], factRefs: [],
            missingFacts: missing && category === "feature_benefit" ? ["防水等级"] : category === "comparison" && options.maxMissingFacts ? ["缺少对比事实"] : [],
          })),
          globalStyleCard: { promptPrefix: "统一" },
        };
      },
      async generateCategoryPrompt(input) {
        categoryCalls += 1;
        await options.beforeCategory?.(categoryCalls);
        return {
          schemaVersion: "suite-category-prompt-v1", category: input.categoryCode,
          items: Array.from({ length: input.requestedCount }, (_, index) => ({
            stableId: `${input.categoryCode}-${index}`, category: input.categoryCode, title: "图片", purpose: "展示商品",
            referenceImageIds: [input.inputImageIds[0]], factRefs: [], prompt: "生成", allowsTextOverlay: "no", textContent: [], aspectRatio: "1:1", suggestedParams: {},
          })),
        };
      },
    },
  });
  return {
    app: createApp(), newApp: createApp, repository, pipeline, suite, inputId, taskRepository, categoryPromptRepository, planRepository,
    supplements, planCallCount: () => supplements.length, categoryPromptCallCount: () => categoryCalls,
    providerCallCount: () => providerCalls, setProviderFails: (value: boolean) => { providerFails = value; },
  };
}

function start(app: Ticket02App, suiteId: string, key: string, config: Record<string, unknown> = oneCard, extra = {}) {
  return app.request("POST", "/api/suites/one-click-generate", { headers: { "Idempotency-Key": key }, body: { suiteId, config, ...extra } });
}

function resume(app: Ticket02App, suiteId: string, action: string, key?: string, extra = {}) {
  return app.request("POST", `/api/suites/${suiteId}/one-click-generate/resume`, {
    headers: key ? { "Idempotency-Key": key } : {}, body: { action, ...extra },
  });
}

function expectError(response: AppResponse, status: number, code: string) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.ok("error" in response.body);
  assert.equal(response.body.error.code, code);
}

async function waitPipeline(app: ReturnType<typeof createTicket02App>, suiteId: string, statuses = ["completed", "failed", "partial_failed", "waiting_human_input", "waiting_base_refine_decision"] as string[]) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const response = await app.request("GET", `/api/suites/${suiteId}/studio-state`);
    assert.equal(response.status, 200);
    const pipeline = (response.body as any).data.pipeline;
    if (pipeline && statuses.includes(pipeline.status)) return pipeline;
    if (pipeline && pipeline.status !== "running") assert.fail(`Expected ${statuses.join(" or ")}, got ${JSON.stringify(pipeline)}`);
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
  assert.fail(`Pipeline ${suiteId} did not reach ${statuses.join(" or ")}`);
}

test("Postgres createRun binds one parameter for each of its 15 insert columns", async (t) => {
  const run: SuitePipelineRun = {
    id: randomUUID(), suiteId: randomUUID(), idempotencyKey: "pg-insert", status: "running", currentPhase: "base_refining",
    config: { platform: "淘宝" }, errorCode: null, errorMessage: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null,
  };
  const pool = new pg.Pool();
  let inserts = 0;
  t.mock.method(pool, "query", async (sql: string, args: unknown[]) => {
    if (!sql.trimStart().startsWith("INSERT")) return { rows: [] };
    inserts++;
    const match = sql.match(/INSERT\s+INTO\s+suite_workbench\.suite_pipeline_runs\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
    assert.ok(match);
    const columns = match[1].split(",").map((column) => column.trim());
    assert.equal(columns.length, 15);
    assert.deepEqual(match[2].split(",").map((value) => value.trim()), columns.map((_, i) => `$${i + 1}`));
    assert.equal(args.length, columns.length);
    assert.deepEqual(Object.fromEntries(columns.map((column, index) => [column, args[index]])), {
      id: run.id, suite_id: run.suiteId, idempotency_key: run.idempotencyKey, status: run.status, current_phase: run.currentPhase,
      resume_count: 0, last_resume_key: null, structure_snapshot_id: null, task_ids_json: "[]", config_json: JSON.stringify(run.config),
      error_code: null, error_message: null, created_at: run.createdAt, updated_at: run.updatedAt, completed_at: null,
    });
    return { rows: [run] };
  });
  assert.deepEqual(await new PostgresPipelineRepository(pool).createRun(run), { run, duplicate: false });
  assert.equal(inserts, 1);
  await pool.end();
  const migration = await readFile(new URL("../db/migrations/026_suite_one_click_pipeline.sql", import.meta.url), "utf8");
  assert.match(migration, /ALTER TABLE [^;]+ ADD COLUMN IF NOT EXISTS resume_count [^;]+ CHECK \(resume_count >= 0\)/);
  assert.match(migration, /CREATE UNIQUE INDEX [^;]+ ON suite_workbench\.suite_pipeline_runs\(suite_id\) WHERE status = 'running'/);
});

test("pipeline runs are idempotent and keep resumable state in memory", async () => {
  const pipelines = new MemoryPipelineRepository();
  const suiteId = randomUUID();
  const run = { id: randomUUID(), suiteId, idempotencyKey: "same-key", status: "running" as const, currentPhase: "structure_planning" as const, config: { listingCopy: true }, errorCode: null, errorMessage: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null };
  const first = await pipelines.createRun(run);
  const duplicate = await pipelines.createRun({ ...run, id: randomUUID() });
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  const updated = await pipelines.updateRun(run.id, { status: "waiting_human_input", errorCode: "MISSING_FACTS" });
  assert.equal(updated?.status, "waiting_human_input");
  assert.equal((await pipelines.getLatestRun(suiteId))?.config.listingCopy, true);
});

test("new suites default to suite studio and support canvas origin", async () => {
  const repository = new MemorySuiteRepository();
  const studio = await repository.createSuite("套图");
  const canvas = await repository.createSuite("画布", undefined, "canvas");
  assert.equal(studio.origin, "suite_studio");
  assert.equal(canvas.origin, "canvas");
});

test("custom 1/3/2/1 runs end to end and freezes ratio, size, auto confirmation, and listing copy", async () => {
  const repository = new MemorySuiteRepository();
  const storage = new MemoryStorage();
  const prompts = new MemoryPromptRepository();
  for (const name of ["general-structure-plan-groups.md", "general-category-prompt-groups.md"]) {
    const record = parseNormalizedPromptMarkdown(await readFile(new URL(`../prompt/normalized/${name}`, import.meta.url), "utf8"), name);
    const [version] = await prompts.importRecords([record]);
    await prompts.publishVersion(version.templateVersionId);
  }
  const suite = await repository.createSuite("一键");
  const bytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: "white" } }).png().toBuffer();
  await storage.put({ key: `suites/${suite.id}/input.png`, bytes, contentType: "image/png" });
  const inputId = randomUUID();
  await repository.createInputImage({ id: inputId, suiteId: suite.id, ordinal: 1, originalObjectKey: `suites/${suite.id}/input.png`, thumbnailObjectKey: `suites/${suite.id}/input.png`, sha256: "f".repeat(64), width: 16, height: 16, mimeType: "image/png", originalFilename: "商品.png", currentBaseVersionId: null, createdAt: new Date().toISOString() });
  const app = createTicket02App({ repository, storage, promptRepository: prompts, planRepository: new MemoryPlanRepository(), categoryPromptRepository: new MemoryCategoryPromptRepository(), taskRepository: new MemoryTaskRepository(), provider: { edit: async () => ({ bytes, mimeType: "image/png" }) }, llmClient: { provider: "fake", model: "fake", isFake: true, async generatePlan() { return { schemaVersion: "suite-structure-plan-v2", status: "READY_FOR_REVIEW", mainAllocation: { category: "main", count: 1, reason: "主图", sourceImageIds: [inputId], factRefs: [], missingFacts: [] }, detailImageCount: 6, categoryAllocations: ["feature_benefit", "material_detail", "lifestyle_use", "comparison", "size_scale", "appearance_angles", "included_items", "compatibility_application", "variant_bundle", "packaging_unboxing", "care_instruction"].map((category) => ({ category, requirement: "optional", count: category === "feature_benefit" ? 3 : category === "lifestyle_use" ? 2 : category === "comparison" ? 1 : 0, reason: "事实支持", sourceImageIds: [inputId], factRefs: [], missingFacts: [] })), globalStyleCard: { promptPrefix: "统一" } }; }, async generateCategoryPrompt(input) { return { schemaVersion: "suite-category-prompt-v1", category: input.categoryCode, items: Array.from({ length: input.requestedCount }, (_, index) => ({ stableId: `${input.categoryCode}-${index}`, category: input.categoryCode, title: "图片", purpose: "展示商品", referenceImageIds: [inputId], factRefs: [], prompt: "生成", allowsTextOverlay: "no", textContent: [], aspectRatio: input.categoryCode === "main" ? "1:1" : "3:4", suggestedParams: {} })) }; } } });
  const started = await app.request("POST", "/api/suites/one-click-generate", { headers: { "Idempotency-Key": "pipeline-test" }, body: { suiteId: suite.id, config: { platform: "淘宝", mode: "custom", counts: { main: 1, selling_points: 3, lifestyle: 2, other: 1 }, aspectRatio: "3:4", size: "2K", listingCopy: true } } });
  assert.equal(started.status, 202);
  const duplicate = await app.request("POST", "/api/suites/one-click-generate", { headers: { "idempotency-key": "pipeline-test" }, body: { suiteId: suite.id, config: { listingCopy: false } } });
  assert.equal(duplicate.status, 202);
  assert.equal((duplicate.body as any).data.pipeline.config.listingCopy, true);
  for (let i = 0; i < 100; i += 1) { const state = await app.request("GET", `/api/suites/${suite.id}/studio-state`); const status = (state.body as any).data.pipeline?.status; if (status === "completed") break; await new Promise((resolve) => setTimeout(resolve, 5)); }
  const state = await app.request("GET", `/api/suites/${suite.id}/studio-state`);
  assert.equal((state.body as any).data.pipeline.status, "completed", JSON.stringify((state.body as any).data.pipeline));
  assert.equal((state.body as any).data.planning.snapshot.confirmationMode, "auto");
  assert.equal((state.body as any).data.cards.length, 7);
  assert.ok((state.body as any).data.cards.every((card: any) => card.sourceRole !== "pending"));
  const workbench = await app.request("GET", `/api/suites/${suite.id}/workbench`);
  assert.ok((workbench.body as any).data.tasks.every((task: any) => task.generationParams.ratio === "3:4" && task.generationParams.size === "2K"));
});

test("exact missing facts pauses and submit_missing_facts resumes the same run", async () => {
  const fixture = await pipelineFixture({ missingFacts: true });
  const { app, suite } = fixture;
  assert.equal((await start(app, suite.id, "missing-facts", { ...twoCards, sellingPoints: originalFact })).status, 202);
  const waiting = await waitPipeline(app, suite.id, ["waiting_human_input"]);
  expectError(await resume(app, suite.id, "retry_base_refine", "wrong-state"), 409, "PIPELINE_ACTION_NOT_ALLOWED");
  const resumed = await resume(app, suite.id, "submit_missing_facts", "add-facts", { supplementText: addedFact });
  assert.equal(resumed.status, 202);
  const done = await waitPipeline(app, suite.id, ["completed"]);
  assert.equal(done.id, waiting.id);
  assert.equal(done.status, "completed");
  assert.equal(fixture.supplements[0], originalFact);
  assert.equal(fixture.planCallCount(), 2);
  for (const fact of [originalFact, addedFact]) {
    assert.ok(done.config.sellingPoints.includes(fact));
    assert.ok(fixture.supplements[1].includes(fact));
  }
});

test("max group can generate fewer images and studio state reports missing reasons after cards exist", async () => {
  const fixture = await pipelineFixture({ maxMissingFacts: true });
  const started = await fixture.app.request("POST", "/api/suites/one-click-generate", { headers: { "idempotency-key": "max-group" }, body: { suiteId: fixture.suite.id, config: { platform: "淘宝", counts: { main: 1, selling_points: 0, lifestyle: 0, other: 1 } } } });
  assert.equal(started.status, 202);
  await waitPipeline(fixture.app, fixture.suite.id, ["completed"]);
  const state = await fixture.app.request("GET", `/api/suites/${fixture.suite.id}/studio-state`);
  assert.equal(state.status, 200);
  assert.ok(Array.isArray((state.body as any).data.cards));
  assert.ok(Array.isArray((state.body as any).data.planning.notGeneratedReasons));
  assert.ok((state.body as any).data.planning.notGeneratedReasons.some((item: any) => item.category === "comparison" && item.reasons.includes("缺少对比事实")));
});

test("Amazon refinement failure waits for a decision and skip is rejected while flexible platforms may skip", async () => {
  const amazon = await pipelineFixture({ providerFails: true });
  const started = await amazon.app.request("POST", "/api/suites/one-click-generate", { headers: { "idempotency-key": "amazon-refine" }, body: { suiteId: amazon.suite.id, config: { platform: "Amazon", counts: { main: 1, selling_points: 0, lifestyle: 0, other: 0 } } } });
  assert.equal(started.status, 202);
  await waitPipeline(amazon.app, amazon.suite.id, ["waiting_base_refine_decision"]);
  expectError(await resume(amazon.app, amazon.suite.id, "skip_base_refine", "skip-amazon"), 409, "PURE_WHITE_REQUIRED");
  const failedRefineCalls = amazon.providerCallCount();
  amazon.setProviderFails(false);
  assert.equal((await amazon.app.request("POST", `/api/suites/${amazon.suite.id}/one-click-generate/resume`, { headers: { "idempotency-key": "amazon-retry" }, body: { action: "retry_base_refine" } })).status, 202);
  const amazonDone = await waitPipeline(amazon.app, amazon.suite.id, ["completed"]);
  assert.equal(amazonDone.status, "completed", JSON.stringify(amazonDone));
  assert.ok(amazon.providerCallCount() > failedRefineCalls);
  for (const action of ["retry_base_refine", "submit_missing_facts", "resume_after_interrupt"]) {
    expectError(await resume(amazon.app, amazon.suite.id, action, action), 409, "PIPELINE_ACTION_NOT_ALLOWED");
  }
  const taobao = await pipelineFixture({ providerFails: true });
  await taobao.app.request("POST", "/api/suites/one-click-generate", { headers: { "idempotency-key": "taobao-refine" }, body: { suiteId: taobao.suite.id, config: { platform: "淘宝", refineBaseImages: true, counts: { main: 1, selling_points: 0, lifestyle: 0, other: 0 } } } });
  await waitPipeline(taobao.app, taobao.suite.id, ["waiting_base_refine_decision"]);
  taobao.setProviderFails(false);
  assert.equal((await resume(taobao.app, taobao.suite.id, "skip_base_refine", "skip-taobao")).status, 202);
  assert.equal((await waitPipeline(taobao.app, taobao.suite.id, ["completed"])).status, "completed");
});

test("cloneFrom object creates an isolated suite and repeated idempotency does not duplicate it", async () => {
  const fixture = await pipelineFixture();
  const started = await fixture.app.request("POST", "/api/suites/one-click-generate", { headers: { "idempotency-key": "clone-object" }, body: { cloneFrom: { suiteId: fixture.suite.id, imageIds: [fixture.inputId] }, config: { platform: "淘宝", mode: "custom", counts: { main: 1, selling_points: 0, lifestyle: 0, other: 0 } } } });
  assert.equal(started.status, 202);
  const cloneId = (started.body as any).data.suiteId;
  assert.notEqual(cloneId, fixture.suite.id);
  const clonedImages = await fixture.repository.getInputImages(cloneId);
  const sourceImages = await fixture.repository.getInputImages(fixture.suite.id);
  assert.equal(clonedImages.length, 1);
  assert.match(clonedImages[0].originalObjectKey, new RegExp(`suites/${cloneId}/`));
  assert.equal(clonedImages[0].sha256, sourceImages[0].sha256);
  assert.equal(clonedImages[0].width, sourceImages[0].width);
  assert.equal(clonedImages[0].height, sourceImages[0].height);
  const cloneDone = await waitPipeline(fixture.app, cloneId, ["completed"]);
  assert.equal(cloneDone.status, "completed");
  const oldRunCount = (await fixture.pipeline.listRuns(fixture.suite.id)).length;
  assert.equal((await fixture.app.request("GET", `/api/suites/${fixture.suite.id}/studio-state`)).status, 200);
  const duplicate = await fixture.app.request("POST", "/api/suites/one-click-generate", { headers: { "idempotency-key": "clone-object" }, body: { cloneFrom: { suiteId: fixture.suite.id, imageIds: [fixture.inputId] }, config: {} } });
  assert.equal((duplicate.body as any).data.suiteId, cloneId);
  assert.equal((await fixture.pipeline.listRuns(fixture.suite.id)).length, oldRunCount);
});

// An unresolved read parks only the old executor. Restoring the method lets a fresh
// app see the same durable records, just as it would after the old process exited.
const stopped = () => new Promise<never>(() => {});

async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("expected pipeline checkpoint was not reached");
}

async function markInterrupted(fixture: Awaited<ReturnType<typeof pipelineFixture>>, phase: string) {
  const run = await fixture.pipeline.getLatestRun(fixture.suite.id);
  assert.ok(run);
  assert.equal(run.status, "running");
  assert.equal(run.currentPhase, phase);
  // Mirror the status-only pipeline recovery in recoverStaleAttempts.
  await fixture.pipeline.updateRun(run.id, { status: "failed", errorCode: "PIPELINE_INTERRUPTED" });
  return run;
}

test("category_prompting restart reuses the confirmed snapshot after an in-flight category request", async (t) => {
  const fixture = await pipelineFixture({ beforeCategory: async (call) => { if (call === 1) await stopped(); } });
  const { app, suite, categoryPromptRepository } = fixture;
  const readRequests = categoryPromptRepository.listRequests.bind(categoryPromptRepository);
  const oldPoll = t.mock.method(categoryPromptRepository, "listRequests", stopped);
  assert.equal((await start(app, suite.id, "category-interrupt")).status, 202);
  await eventually(async () => fixture.categoryPromptCallCount() === 1 && oldPoll.mock.callCount() > 0);
  const run = await markInterrupted(fixture, "category_prompting");
  assert.ok(run.structureSnapshotId);
  assert.equal((await fixture.planRepository.getSnapshot(run.structureSnapshotId))?.confirmationStatus, "confirmed");
  assert.deepEqual(run.taskIds, []);
  const [pending] = await readRequests(run.structureSnapshotId);
  assert.equal(pending.status, "running");
  await categoryPromptRepository.failRequest(pending.id, "GENERATION_INTERRUPTED", "模拟重启");
  oldPoll.mock.restore();
  const plans = fixture.planCallCount();
  assert.equal(plans, 1);
  const restarted = fixture.newApp();
  assert.equal((await resume(restarted, suite.id, "resume_after_interrupt", "recover-category")).status, 202);
  const done = await waitPipeline(restarted, suite.id, ["completed"]);
  assert.equal(done.id, run.id);
  assert.equal(done.structureSnapshotId, run.structureSnapshotId);
  assert.equal(done.resumeCount, 1);
  assert.equal(fixture.planCallCount(), plans);
  assert.equal(fixture.categoryPromptCallCount(), 2);
});

test("image_generating restart completes a partial batch by rendering only the missing card", async (t) => {
  const secondImage = Promise.withResolvers<void>();
  const fixture = await pipelineFixture({ beforeImage: async (call) => { if (call === 2) await secondImage.promise; } });
  const { app, suite, taskRepository } = fixture;
  const oldPoll = t.mock.method(taskRepository, "getBatch", stopped);
  assert.equal((await start(app, suite.id, "image-interrupt", twoCards)).status, 202);
  await eventually(async () => {
    const rows = await taskRepository.listTasks(suite.id);
    return oldPoll.mock.callCount() > 0 && fixture.providerCallCount() === 2 &&
      rows.length === 2 && rows[0].status === "generated" && rows[1].status === "generating";
  });
  const run = await markInterrupted(fixture, "image_generating");
  assert.ok(run.structureSnapshotId);
  const rows = await taskRepository.listTasks(suite.id);
  assert.deepEqual(run.taskIds, rows.map((task) => task.id));
  const [first, second] = rows;
  const [saved] = (await taskRepository.listTaskVersions(first.id)).versions;
  assert.ok(saved.isCurrent);
  assert.deepEqual((await taskRepository.listTaskVersions(second.id)).versions, []);
  secondImage.reject(new Error("provider disconnected"));
  await eventually(async () => (await taskRepository.listBatches(suite.id))[0].status === "partial");
  oldPoll.mock.restore();
  const plans = fixture.planCallCount(), categories = fixture.categoryPromptCallCount(), images = fixture.providerCallCount();
  assert.equal(plans, 1);
  assert.equal(categories, 2);

  const restarted = fixture.newApp();
  assert.equal((await resume(restarted, suite.id, "resume_after_interrupt", "recover-images")).status, 202);
  const done = await waitPipeline(restarted, suite.id, ["completed"]);
  assert.equal(done.id, run.id);
  assert.equal(done.structureSnapshotId, run.structureSnapshotId);
  assert.deepEqual(done.taskIds, run.taskIds);
  assert.equal(fixture.planCallCount(), plans);
  assert.equal(fixture.categoryPromptCallCount(), categories);
  assert.equal(fixture.providerCallCount(), images + 1);
  assert.deepEqual((await taskRepository.listTaskVersions(first.id)).versions.map((v) => v.id), [saved.id]);
  assert.ok((await taskRepository.listTaskVersions(second.id)).versions.some((v) => v.isCurrent));
  const batches = await taskRepository.listBatches(suite.id);
  assert.deepEqual(batches.map((batch) => batch.status), ["completed", "partial"]);
  assert.deepEqual(batches[0].taskIds, [second.id]);
});

test("current task versions distinguish partial image failure from complete failure", async () => {
  for (const expected of ["partial_failed", "failed"]) {
    const fixture = await pipelineFixture({ beforeImage: async (call) => {
      if (call === 2 || expected === "failed") throw new Error("image failure");
    } });
    assert.equal((await start(fixture.app, fixture.suite.id, "failed-images", twoCards)).status, 202);
    const done = await waitPipeline(fixture.app, fixture.suite.id);
    assert.equal(done.status, expected);
    assert.equal(done.taskIds.length, 2);
    assert.equal(fixture.providerCallCount(), 2);
  }
});

test("only one concurrent start claims a suite and a public runId cannot start a second executor", async () => {
  const gate = Promise.withResolvers<void>();
  const fixture = await pipelineFixture({ beforeCategory: () => gate.promise });
  const { app, suite } = fixture;
  try {
    const starts = await Promise.all(["first", "second"].map((key) => start(app, suite.id, key)));
    assert.deepEqual(starts.map((r) => r.status).sort(), [202, 409]);
    expectError(starts.find((r) => r.status === 409)!, 409, "PIPELINE_ALREADY_RUNNING");
    const [active] = await fixture.pipeline.listRuns(suite.id);
    assert.equal(active.lastResumeKey, null);
    assert.equal(active.status, "running");
    expectError(await start(app, suite.id, "another"), 409, "PIPELINE_ALREADY_RUNNING");
    expectError(await start(app, suite.id, "bypass", oneCard, { runId: active.id }), 409, "PIPELINE_ALREADY_RUNNING");
    expectError(await resume(app, suite.id, "resume_after_interrupt", "wrong-state"), 409, "PIPELINE_ACTION_NOT_ALLOWED");
  } finally {
    gate.resolve();
  }
  const done = await waitPipeline(app, suite.id, ["completed"]);
  expectError(await start(app, suite.id, "public-run-id", oneCard, { runId: done.id }), 400, "INVALID_PIPELINE_START");
  assert.equal(done.resumeCount, 0);
  assert.equal((await fixture.pipeline.listRuns(suite.id)).length, 1);
  assert.equal(fixture.planCallCount(), 1);
  assert.equal(fixture.categoryPromptCallCount(), 1);
  assert.equal(fixture.providerCallCount(), 1);
});

test("resume requires a header and deduplicates concurrent and delayed retries across restarts", async () => {
  const fixture = await pipelineFixture({ providerFails: true });
  const { app, suite } = fixture;
  const action = "retry_base_refine";
  assert.equal((await start(app, suite.id, "base", { ...oneCard, platform: "Amazon" })).status, 202);
  await waitPipeline(app, suite.id, ["waiting_base_refine_decision"]);
  expectError(await resume(app, suite.id, action, undefined, { idempotencyKey: "body-key" }), 400, "MISSING_IDEMPOTENCY_KEY");
  const duplicates = await Promise.all([resume(app, suite.id, action, "k1"), resume(app, suite.id, action, "k1")]);
  assert.deepEqual(duplicates.map((result) => result.status), [202, 202]);
  assert.equal((await waitPipeline(app, suite.id, ["waiting_base_refine_decision"])).resumeCount, 1);
  assert.equal(fixture.providerCallCount(), 2);
  assert.equal((await resume(app, suite.id, action, "k2")).status, 202);
  assert.equal((await waitPipeline(app, suite.id, ["waiting_base_refine_decision"])).resumeCount, 2);
  const restarted = fixture.newApp();
  const replay = await resume(restarted, suite.id, action, "k1");
  assert.equal(replay.status, 202);
  assert.equal((replay.body as any).data.pipeline.status, "waiting_base_refine_decision");
  assert.equal((replay.body as any).data.pipeline.resumeCount, 2);
  assert.equal(fixture.providerCallCount(), 3);
  fixture.setProviderFails(false);
  assert.equal((await resume(restarted, suite.id, action, "k3")).status, 202);
  assert.equal((await waitPipeline(restarted, suite.id, ["completed"])).resumeCount, 3);
  assert.equal(fixture.providerCallCount(), 5);
});

test("feed excludes empty drafts, paginates by created time, and export honors taskIds", async () => {
  const fixture = await pipelineFixture();
  const { app, suite, repository } = fixture;
  const draft = await repository.createSuite("空草稿");
  assert.equal((await start(app, suite.id, "feed-run", twoCards)).status, 202);
  await waitPipeline(app, suite.id, ["completed"]);
  const clone = await start(app, suite.id, "feed-clone", oneCard, { cloneFrom: { suiteId: suite.id, imageIds: [fixture.inputId] } });
  assert.equal(clone.status, 202);
  const newerId = (clone.body as any).data.suiteId;
  await waitPipeline(app, newerId, ["completed"]);
  await repository.renameSuite(suite.id, "最近更新的旧批次");
  const ids: string[] = [];
  for (const offset of [0, 1]) {
    const page = await app.request("GET", `/api/suites/feed?limit=1&offset=${offset}`);
    assert.equal(page.status, 200);
    const { items, total } = (page.body as any).data;
    assert.equal(total, 2);
    assert.equal(items.length, 1);
    ids.push(items[0].suite.id);
  }
  assert.deepEqual(ids, [newerId, suite.id]);
  assert.ok(!ids.includes(draft.id));

  const state = await app.request("GET", `/api/suites/${suite.id}/studio-state`);
  const cards = (state.body as any).data.cards;
  assert.equal(cards.length, 2);
  const [omitted, selected] = cards;
  assert.notEqual(selected.parentTaskId, omitted.parentTaskId);
  const exported = await app.request("GET", `/api/suites/${suite.id}/delivery/export?taskIds=${selected.parentTaskId}`);
  assert.equal(exported.status, 200);
  assert.ok(exported.raw);
  assert.equal(exported.raw.readUInt16LE(exported.raw.length - 12), 2); // ZIP end record: total central directory entries.
  const entries = readZipEntries(exported.raw);
  const manifest = JSON.parse(entries.get("manifest.json")!.toString("utf8"));
  assert.deepEqual([...entries.keys()].sort(), ["manifest.json", selected.exportPath].sort());
  assert.equal(entries.has(omitted.exportPath), false);
  assert.deepEqual(manifest.items.map((item: { parentTaskId: string }) => item.parentTaskId), [selected.parentTaskId]);
  assert.equal(manifest.items[0].exportPath, selected.exportPath);
});
