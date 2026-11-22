import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { MemoryPipelineRepository } from "../server/repositories/memory-pipeline-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { createSuiteStudioApp } from "../server/app.js";
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
import type { AppResponse, SuiteStudioApp } from "../server/app.js";
import type { CategoryPromptLlmInput, PlanLlmInput, SuitePipelineRun } from "../server/types.js";

const originalFact = "轻量化铝合金机身";
const addedFact = "支持 IP67 防水";
const oneCard = { platform: "淘宝", counts: { main: 1, selling_points: 0, lifestyle: 0, other: 0 } };
const twoCards = { ...oneCard, counts: { ...oneCard.counts, selling_points: 1 } };


async function pipelineFixture(options: {
  missingFacts?: boolean;
  maxMissingFacts?: boolean;
  providerFails?: boolean;
  beforeImage?: (call: number) => Promise<void>;
  beforeCategory?: (call: number, input: CategoryPromptLlmInput) => Promise<void>;
  structureTemplate?: string;
  beforePlan?: (input: PlanLlmInput) => void;
  publishCategoryTemplate?: boolean;
  imageCount?: number;
  materialCount?: number;
  legacyVisualInputs?: "both" | "structure";
} = {}) {
  const repository = new MemorySuiteRepository();
  const storage = new MemoryStorage();
  const prompts = new MemoryPromptRepository();
  for (const name of [
    options.structureTemplate ?? "general-structure-plan-groups.md",
    ...(options.publishCategoryTemplate === false ? [] : ["general-category-prompt-groups.md"]),
    "general-base-refine.md",
  ]) {
    const record = parseNormalizedPromptMarkdown(await readFile(new URL(`../prompt/normalized/${name}`, import.meta.url), "utf8"), name);
    if (options.legacyVisualInputs === "both" || (options.legacyVisualInputs === "structure" && record.stage === "structure_plan")) {
      record.inputSchema = record.inputSchema.filter(({ key }) => key !== "visual_style" && key !== "selling_point_layouts");
    }
    const [version] = await prompts.importRecords([record]);
    await prompts.publishVersion(version.templateVersionId);
  }
  const suite = await repository.createSuite("流水线测试");
  const bytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: "white" } }).png().toBuffer();
  const imageIds = Array.from({ length: options.imageCount ?? 1 }, () => randomUUID());
  for (const [index, id] of imageIds.entries()) {
    const originalKey = `suites/${suite.id}/inputs/${id}/original`;
    const thumbKey = `suites/${suite.id}/inputs/${id}/thumbnail`;
    await storage.put({ key: originalKey, bytes, contentType: "image/png" });
    await storage.put({ key: thumbKey, bytes, contentType: "image/png" });
    await storage.put({ key: originalKey.replace(/\/original$/, "/generation-input.jpg"), bytes, contentType: "image/jpeg" });
    await repository.createInputImage({ id, suiteId: suite.id, ordinal: index + 1, originalObjectKey: originalKey, thumbnailObjectKey: thumbKey, sha256: randomUUID().replaceAll("-", "").padEnd(64, "0"), width: 16, height: 16, mimeType: "image/png", originalFilename: "商品.png", currentBaseVersionId: null, createdAt: new Date().toISOString() });
  }
  const pipeline = new MemoryPipelineRepository();
  let providerFails = Boolean(options.providerFails);
  let providerCalls = 0;
  const planRepository = new MemoryPlanRepository();
  const categoryPromptRepository = new MemoryCategoryPromptRepository();
  const taskRepository = new MemoryTaskRepository();
  const supplements: string[] = [];
  let categoryCalls = 0;
  const createApp = () => createSuiteStudioApp({
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
        code: value, name: value, marketScope: value === "eBay" ? "overseas" : "domestic",
        mainImageBackground: value === "Amazon" ? "pure_white_required" : "white_preferred",
        mainImageStrategy: "", galleryStrategy: "", textStrategy: "", modelStrategy: "", sourceNote: "", sortOrder: 1,
      }),
      listEnabled: async () => [],
    },
    llmClient: {
      provider: "fake", model: "fake", isFake: true,
      async generatePlan(input) {
        options.beforePlan?.(input);
        const supplement = String(input.dynamicInput.human_supplement ?? "");
        supplements.push(supplement);
        const missing = options.missingFacts && ![originalFact, addedFact].every((fact) => supplement.includes(fact));
        const imageId = input.inputImageIds[0];
        const groups = input.dynamicInput.category_groups ? JSON.parse(String(input.dynamicInput.category_groups)) : null;
        const details = groups?.selling_points.count ?? 0;
        const materialCount = options.materialCount ?? 0;
        return {
          schemaVersion: "suite-structure-plan-v2", status: missing ? "NEEDS_HUMAN_INPUT" : "READY_FOR_REVIEW",
          mainAllocation: { category: "main", count: Number(input.dynamicInput.main_image_count), reason: "主图", sourceImageIds: [imageId], factRefs: [], missingFacts: [] },
          detailImageCount: details,
          categoryAllocations: ["feature_benefit", "material_detail", "lifestyle_use", "comparison", "size_scale", "appearance_angles", "included_items", "compatibility_application", "variant_bundle", "packaging_unboxing", "care_instruction"].map((category) => ({
            category, requirement: "optional", count: category === "feature_benefit" ? details - materialCount : category === "material_detail" ? materialCount : 0, reason: "", sourceImageIds: [imageId], factRefs: [],
            missingFacts: missing && category === "feature_benefit" ? ["防水等级"] : category === "comparison" && options.maxMissingFacts ? ["缺少对比事实"] : [],
          })),
          globalStyleCard: { promptPrefix: "统一" },
        };
      },
      async generateCategoryPrompt(input) {
        categoryCalls += 1;
        await options.beforeCategory?.(categoryCalls, input);
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
    app: createApp(), newApp: createApp, repository, pipeline, suite, inputId: imageIds[0], imageIds, taskRepository, categoryPromptRepository, planRepository, prompts, storage,
    supplements, planCallCount: () => supplements.length, categoryPromptCallCount: () => categoryCalls,
    providerCallCount: () => providerCalls, setProviderFails: (value: boolean) => { providerFails = value; },
  };
}

function start(app: SuiteStudioApp, suiteId: string, key: string, config: Record<string, unknown> = oneCard, extra = {}) {
  return app.request("POST", "/api/suites/one-click-generate", { headers: { "Idempotency-Key": key }, body: { suiteId, config, ...extra } });
}

function resume(app: SuiteStudioApp, suiteId: string, action: string, key?: string, extra = {}) {
  return app.request("POST", `/api/suites/${suiteId}/one-click-generate/resume`, {
    headers: key ? { "Idempotency-Key": key } : {}, body: { action, ...extra },
  });
}

function expectError(response: AppResponse, status: number, code: string) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.ok("error" in response.body);
  assert.equal(response.body.error.code, code);
}

async function waitPipeline(app: ReturnType<typeof createSuiteStudioApp>, suiteId: string, statuses: string[]) {
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

async function seedLegacyRefinePause(fixture: Awaited<ReturnType<typeof pipelineFixture>>, platform: string) {
  const timestamp = new Date().toISOString();
  await fixture.pipeline.createRun({
    id: randomUUID(), suiteId: fixture.suite.id, idempotencyKey: "legacy-refine",
    status: "waiting_base_refine_decision", currentPhase: "base_refining",
    config: { ...oneCard, platform, refineBaseImages: true },
    errorCode: "BASE_REFINE_FAILED", errorMessage: "白底精修失败",
    createdAt: timestamp, updatedAt: timestamp, completedAt: null,
  });
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

const visualChoices = {
  ...oneCard,
  mode: "custom",
  counts: { ...oneCard.counts, selling_points: 3 },
  visualStyle: "dark_tech",
  sellingPointLayouts: [
    "left_pills_right_hero", "fake-layout", "hero_color_block", "hero_color_block",
    "macro_callout_lines", "scene_circle_zoom",
  ],
};
const expectedLayouts = ["left_pills_right_hero", "hero_color_block", "macro_callout_lines"];

function layoutIds(input: unknown): string[] | undefined {
  if (input === undefined) return undefined;
  assert.equal(typeof input, "string");
  const layouts = JSON.parse(input as string) as Array<{ id: string; promptDirective: { composition: string } }>;
  assert.ok(layouts.every(({ promptDirective }) => promptDirective.composition.length > 0));
  return layouts.map(({ id }) => id);
}

for (const legacyVisualInputs of [undefined, "both", "structure"] as const) {
  const title = legacyVisualInputs === "both"
    ? "one-click generation completes with legacy templates that omit visual preferences"
    : legacyVisualInputs === "structure"
      ? "a legacy structure template still lets a current category template use the frozen visual preferences"
      : "one-click planning forwards the visual style and splits the first three valid layouts between two selling-point categories";
  test(title, async () => {
    const planCalls: PlanLlmInput[] = [];
    const categoryCalls = new Map<string, CategoryPromptLlmInput>();
    const { app, suite } = await pipelineFixture({
      materialCount: 1,
      legacyVisualInputs,
      beforePlan: (input) => { planCalls.push(input); },
      beforeCategory: async (_call, input) => { categoryCalls.set(input.categoryCode, input); },
    });
    const response = await start(app, suite.id, "visual-preferences", visualChoices);
    assert.equal(response.status, 202);
    const pipeline = await waitPipeline(app, suite.id, ["completed"]);
    assert.equal(pipeline.config.visualStyle, "dark_tech");
    assert.deepEqual(pipeline.config.sellingPointLayouts, expectedLayouts);
    assert.equal(planCalls.length, 1);
    const [plan] = planCalls;
    const feature = categoryCalls.get("feature_benefit");
    const material = categoryCalls.get("material_detail");
    const main = categoryCalls.get("main");
    assert.ok(main && feature && material);
    assert.equal(feature.requestedCount, 2);
    assert.equal(material.requestedCount, 1);
    assert.equal(Object.hasOwn(main.dynamicInput, "selling_point_layouts"), false);

    const expectedStyle = "暗调科技光影：采用深色质感背景、冷暖轮廓光和高对比科技构图，突出有依据的参数。";
    const expectPlanInputs = !legacyVisualInputs;
    const expectCategoryInputs = legacyVisualInputs !== "both";
    assert.equal(plan.dynamicInput.visual_style, expectPlanInputs ? expectedStyle : undefined);
    assert.deepEqual(layoutIds(plan.dynamicInput.selling_point_layouts), expectPlanInputs ? expectedLayouts : undefined);
    for (const input of [main, feature, material]) {
      assert.equal(input.dynamicInput.visual_style, expectCategoryInputs ? expectedStyle : undefined);
    }
    assert.deepEqual(layoutIds(feature.dynamicInput.selling_point_layouts), expectCategoryInputs ? ["left_pills_right_hero", "hero_color_block"] : undefined);
    assert.deepEqual(layoutIds(material.dynamicInput.selling_point_layouts), expectCategoryInputs ? ["macro_callout_lines"] : undefined);
  });
}

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
  const app = createSuiteStudioApp({ repository, storage, promptRepository: prompts, planRepository: new MemoryPlanRepository(), categoryPromptRepository: new MemoryCategoryPromptRepository(), taskRepository: new MemoryTaskRepository(), provider: { edit: async () => ({ bytes, mimeType: "image/png" }) }, llmClient: { provider: "fake", model: "fake", isFake: true, async generatePlan() { return { schemaVersion: "suite-structure-plan-v2", status: "READY_FOR_REVIEW", mainAllocation: { category: "main", count: 1, reason: "主图", sourceImageIds: [inputId], factRefs: [], missingFacts: [] }, detailImageCount: 6, categoryAllocations: ["feature_benefit", "material_detail", "lifestyle_use", "comparison", "size_scale", "appearance_angles", "included_items", "compatibility_application", "variant_bundle", "packaging_unboxing", "care_instruction"].map((category) => ({ category, requirement: "optional", count: category === "feature_benefit" ? 3 : category === "lifestyle_use" ? 2 : category === "comparison" ? 1 : 0, reason: "事实支持", sourceImageIds: [inputId], factRefs: [], missingFacts: [] })), globalStyleCard: { promptPrefix: "统一" } }; }, async generateCategoryPrompt(input) { return { schemaVersion: "suite-category-prompt-v1", category: input.categoryCode, items: Array.from({ length: input.requestedCount }, (_, index) => ({ stableId: `${input.categoryCode}-${index}`, category: input.categoryCode, title: "图片", purpose: "展示商品", referenceImageIds: [inputId], factRefs: [], prompt: "生成", allowsTextOverlay: "no", textContent: [], aspectRatio: input.categoryCode === "main" ? "1:1" : "3:4", suggestedParams: {} })) }; } } });
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

test("outdated published structure templates fail before creating a planning attempt", async () => {
  for (const mode of ["smart", "custom"]) {
    const { app, suite, planRepository } = await pipelineFixture({ structureTemplate: "general-structure-plan.md" });
    assert.equal((await start(app, suite.id, "old-template", { ...oneCard, mode })).status, 202);
    const run = await waitPipeline(app, suite.id, ["failed"]);
    assert.equal(run.currentPhase, "structure_planning");
    assert.equal(run.errorCode, "PLAN_TEMPLATE_OUTDATED");
    assert.match(run.errorMessage, /模板库.*发布.*最新版结构计划模板/);
    assert.equal(await planRepository.getLatestAttempt(suite.id), null);
  }
});

test("pipeline preserves the structure attempt and category request errors", async () => {
  const timeout = () => { throw new Error("LLM_TIMEOUT"); };
  for (const [phase, options] of [
    ["structure_planning", { beforePlan: timeout }],
    ["category_prompting", { beforeCategory: async () => timeout() }],
  ] as const) {
    const { app, suite } = await pipelineFixture(options);
    assert.equal((await start(app, suite.id, "llm-timeout")).status, 202);
    const run = await waitPipeline(app, suite.id, ["failed"]);
    assert.equal(run.currentPhase, phase);
    assert.equal(run.errorCode, "LLM_TIMEOUT");
    assert.equal(run.errorMessage, "计划生成超时，请重试");
  }
});

test("pipeline preserves the category prompt API error envelope", async () => {
  const { app, suite } = await pipelineFixture({ publishCategoryTemplate: false });
  assert.equal((await start(app, suite.id, "no-category-template")).status, 202);
  const run = await waitPipeline(app, suite.id, ["failed"]);
  assert.equal(run.errorCode, "CATEGORY_PROMPT_TEMPLATE_NOT_FOUND");
  assert.equal(run.errorMessage, "类别提示词模板未发布或阶段不匹配");
});

test("pipeline preserves the structure, task materialization, and generation API error envelopes", async (t) => {
  const structure = await pipelineFixture();
  await structure.storage.delete((await structure.repository.getInputImages(structure.suite.id))[0].originalObjectKey);
  assert.equal((await start(structure.app, structure.suite.id, "missing-original")).status, 202);
  const structureRun = await waitPipeline(structure.app, structure.suite.id, ["failed"]);
  assert.equal(structureRun.errorCode, "PLAN_INPUT_IMAGE_NOT_FOUND");
  assert.equal(structureRun.errorMessage, "找不到用于规划的商品原图，请重新上传。");

  const materialization = await pipelineFixture();
  const { categoryPromptRepository } = materialization;
  const list = categoryPromptRepository.listRequests.bind(categoryPromptRepository);
  let successfulPoll = false;
  t.mock.method(categoryPromptRepository, "listRequests", async (id: string) => {
    if (successfulPoll) return [];
    const requests = await list(id);
    successfulPoll = requests.some((row) => row.status === "succeeded");
    return requests;
  });
  assert.equal((await start(materialization.app, materialization.suite.id, "missing-category-results")).status, 202);
  const tasksRun = await waitPipeline(materialization.app, materialization.suite.id, ["failed"]);
  assert.equal(tasksRun.errorCode, "CATEGORY_PROMPTS_NOT_READY");
  assert.equal(tasksRun.errorMessage, "类别提示词尚未全部成功，请重试失败类别");

  const generation = await pipelineFixture();
  t.mock.method(generation.repository, "getInputImage", async () => null);
  assert.equal((await start(generation.app, generation.suite.id, "missing-task-source")).status, 202);
  const imageRun = await waitPipeline(generation.app, generation.suite.id, ["failed"]);
  assert.equal(imageRun.errorCode, "TASK_INVALID_SOURCE");
  assert.equal(imageRun.errorMessage, "套图任务没有可用输入图");
});

test("structure planning omits dynamic inputs outside the published schema", async (t) => {
  const { app, suite, planRepository, prompts } = await pipelineFixture();
  const [published] = await prompts.listPublished("structure_plan");
  const runtime = await prompts.getPublishedVersion(published.templateVersionId, "structure_plan");
  assert.ok(runtime);
  const inputSchema = runtime.inputSchema.filter((field) => field.key !== "emphasis_requirements");
  const list = prompts.listPublished.bind(prompts);
  const get = prompts.getPublishedVersion.bind(prompts);
  t.mock.method(prompts, "listPublished", async (stage?: Parameters<typeof list>[0]) =>
    stage === "structure_plan" ? [{ ...published, inputSchema }] : list(stage));
  t.mock.method(prompts, "getPublishedVersion", async (id: string, stage?: Parameters<typeof get>[1]) =>
    id === runtime.templateVersionId ? { ...runtime, inputSchema } : get(id, stage));
  assert.equal((await start(app, suite.id, "subset-schema")).status, 202);
  await waitPipeline(app, suite.id, ["completed"]);
  const attempt = await planRepository.getLatestAttempt(suite.id);
  assert.ok(attempt);
  assert.equal(Object.hasOwn(attempt.dynamicInput, "emphasis_requirements"), false);
});

test("three originals yield one overseas white-background main card without base refinement", async () => {
  const fixture = await pipelineFixture({
    imageCount: 3,
    beforePlan: (input) => {
      assert.equal(input.platformProfile?.mainImageBackground, "pure_white_required");
      assert.match(input.platformProfile.mainImageStrategy, /RGB 255,255,255/);
    },
  });
  const { app, suite, repository, planRepository, imageIds, taskRepository } = fixture;
  const started = await start(app, suite.id, "overseas-main", { ...oneCard, platform: "eBay", refineBaseImages: true });
  assert.equal(started.status, 202);
  assert.ok("data" in started.body);
  assert.equal((started.body.data as { pipeline: SuitePipelineRun }).pipeline.currentPhase, "structure_planning");
  await waitPipeline(app, suite.id, ["completed"]);
  const attempt = await planRepository.getLatestAttempt(suite.id);
  assert.deepEqual(attempt?.inputImageIds, imageIds);
  assert.equal(attempt?.dynamicInput.main_image_background, "pure_white_required");
  const tasks = await taskRepository.listTasks(suite.id);
  assert.deepEqual(tasks.map((task) => task.categoryCode), ["main"]);
  assert.match(tasks[0].promptDraft, /纯白背景.*RGB 255,255,255/);
  const history = await taskRepository.listTaskVersions(tasks[0].id);
  assert.equal(history.versions.length, 1);
  assert.match(String(history.attempts[0].promptSnapshot.finalPrompt), /纯白背景.*RGB 255,255,255/);
  for (const id of imageIds) assert.deepEqual(await repository.listGenerationAttempts(suite.id, id), []);
  assert.equal(fixture.providerCallCount(), 1);
});

test("smart mode uses one main card even after retaining a larger custom count", async () => {
  const { app, suite, taskRepository } = await pipelineFixture();
  assert.equal((await start(app, suite.id, "smart-main", {
    ...oneCard, platform: "eBay", mode: "smart", counts: { ...oneCard.counts, main: 3 },
  })).status, 202);
  await waitPipeline(app, suite.id, ["completed"]);
  assert.deepEqual((await taskRepository.listTasks(suite.id)).map((task) => task.categoryCode), ["main"]);
});

test("domestic planning sends flexible and skips a legacy request to refine all originals", async () => {
  const fixture = await pipelineFixture();
  const { app, suite, planRepository } = fixture;
  assert.equal((await start(app, suite.id, "domestic-main", { ...twoCards, refineBaseImages: true })).status, 202);
  await waitPipeline(app, suite.id, ["completed"]);
  assert.equal((await planRepository.getLatestAttempt(suite.id))?.dynamicInput.main_image_background, "flexible");
  assert.equal(fixture.providerCallCount(), 2);
});

test("one-click detail cards still use the original when a single-image base refinement already exists", async () => {
  const fixture = await pipelineFixture({
    beforeCategory: async (_call, input) => {
      assert.deepEqual(input.visionImages?.map((image) => image.sourceKind), ["original"]);
    },
  });
  const { app, suite, inputId, prompts, repository, taskRepository } = fixture;
  const [baseTemplate] = await prompts.listPublished("base_refine");
  const refined = await app.request("POST", `/api/suites/${suite.id}/input-images/${inputId}/base-generation`, {
    headers: { "idempotency-key": "one-image-refine" },
    body: {
      templateVersionId: baseTemplate.templateVersionId,
      dynamicInput: { source_image_ids: inputId, background_target: "白底" },
    },
  });
  assert.equal(refined.status, 202);
  await eventually(async () => (await repository.listGenerationAttempts(suite.id, inputId))[0]?.status === "succeeded");
  assert.ok((await repository.getInputImage(suite.id, inputId))?.currentBaseVersionId);

  assert.equal((await start(app, suite.id, "original-detail", { ...twoCards, platform: "eBay" })).status, 202);
  await waitPipeline(app, suite.id, ["completed"]);
  const detail = (await taskRepository.listTasks(suite.id)).find((task) => task.categoryCode === "feature_benefit");
  assert.ok(detail);
  assert.doesNotMatch(detail.promptDraft, /主图必须使用纯白背景/);
  const { attempts } = await taskRepository.listTaskVersions(detail.id);
  assert.equal(attempts[0].sourceKind, "original");
  assert.equal(attempts[0].sourceInputImageId, inputId);
  assert.equal((await repository.listGenerationAttempts(suite.id, inputId)).length, 1);
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

test("legacy refinement pauses still allow retries and flexible platforms may skip", async () => {
  const amazon = await pipelineFixture();
  await seedLegacyRefinePause(amazon, "Amazon");
  expectError(await resume(amazon.app, amazon.suite.id, "skip_base_refine", "skip-amazon"), 409, "PURE_WHITE_REQUIRED");
  assert.equal((await amazon.app.request("POST", `/api/suites/${amazon.suite.id}/one-click-generate/resume`, { headers: { "idempotency-key": "amazon-retry" }, body: { action: "retry_base_refine" } })).status, 202);
  const amazonDone = await waitPipeline(amazon.app, amazon.suite.id, ["completed"]);
  assert.equal(amazonDone.status, "completed", JSON.stringify(amazonDone));
  assert.equal(amazon.providerCallCount(), 2);
  for (const action of ["retry_base_refine", "submit_missing_facts", "resume_after_interrupt"]) {
    expectError(await resume(amazon.app, amazon.suite.id, action, action), 409, "PIPELINE_ACTION_NOT_ALLOWED");
  }
  const taobao = await pipelineFixture();
  await seedLegacyRefinePause(taobao, "淘宝");
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

test("current task versions distinguish partial from complete image failure and preserve attempt errors", async () => {
  for (const expected of ["partial_failed", "failed"]) {
    const fixture = await pipelineFixture({ beforeImage: async (call) => {
      if (call === 2 || expected === "failed") throw new Error("image failure");
    } });
    assert.equal((await start(fixture.app, fixture.suite.id, "failed-images", twoCards)).status, 202);
    const done = await waitPipeline(fixture.app, fixture.suite.id, [expected]);
    assert.equal(done.errorCode, "TASK_IMAGE_PROVIDER_FAILED");
    assert.equal(done.errorMessage, "套图图片生成失败");
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
  await seedLegacyRefinePause(fixture, "Amazon");
  expectError(await resume(app, suite.id, action, undefined, { idempotencyKey: "body-key" }), 400, "MISSING_IDEMPOTENCY_KEY");
  const duplicates = await Promise.all([resume(app, suite.id, action, "k1"), resume(app, suite.id, action, "k1")]);
  assert.deepEqual(duplicates.map((result) => result.status), [202, 202]);
  assert.equal((await waitPipeline(app, suite.id, ["waiting_base_refine_decision"])).resumeCount, 1);
  assert.equal(fixture.providerCallCount(), 1);
  assert.equal((await resume(app, suite.id, action, "k2")).status, 202);
  assert.equal((await waitPipeline(app, suite.id, ["waiting_base_refine_decision"])).resumeCount, 2);
  const restarted = fixture.newApp();
  const replay = await resume(restarted, suite.id, action, "k1");
  assert.equal(replay.status, 202);
  assert.equal((replay.body as any).data.pipeline.status, "waiting_base_refine_decision");
  assert.equal((replay.body as any).data.pipeline.resumeCount, 2);
  assert.equal(fixture.providerCallCount(), 2);
  fixture.setProviderFails(false);
  assert.equal((await resume(restarted, suite.id, action, "k3")).status, 202);
  assert.equal((await waitPipeline(restarted, suite.id, ["completed"])).resumeCount, 3);
  assert.equal(fixture.providerCallCount(), 4);
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
