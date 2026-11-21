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

async function pipelineFixture(options: { planStatus?: "READY_FOR_REVIEW" | "NEEDS_HUMAN_INPUT"; missingFacts?: boolean; maxMissingFacts?: boolean; providerFails?: boolean; platform?: string } = {}) {
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
  let factsSubmitted = false;
  let planCalls = 0;
  const planOutput = (imageId = inputId) => { const missing = options.missingFacts && !factsSubmitted && planCalls++ === 0; return { schemaVersion: "suite-structure-plan-v2", status: missing ? "NEEDS_HUMAN_INPUT" : options.planStatus ?? "READY_FOR_REVIEW", mainAllocation: { category: "main", count: 1, reason: "主图", sourceImageIds: [imageId], factRefs: [], missingFacts: missing ? ["尺寸"] : [] }, detailImageCount: 0, categoryAllocations: ["feature_benefit", "material_detail", "lifestyle_use", "comparison", "size_scale", "appearance_angles", "included_items", "compatibility_application", "variant_bundle", "packaging_unboxing", "care_instruction"].map((category) => ({ category, requirement: "optional", count: category === "comparison" && options.maxMissingFacts ? 0 : 0, reason: "", sourceImageIds: [imageId], factRefs: [], missingFacts: missing && category === "feature_benefit" ? ["材质"] : category === "comparison" && options.maxMissingFacts ? ["缺少对比事实"] : [] })), globalStyleCard: { promptPrefix: "统一" } }; };
  const createApp = () => createTicket02App({ repository, storage, pipelineRepository: pipeline, promptRepository: prompts, planRepository: new MemoryPlanRepository(), categoryPromptRepository: new MemoryCategoryPromptRepository(), taskRepository: new MemoryTaskRepository(), provider: { edit: async () => { providerCalls += 1; if (providerFails) throw new Error("IMAGE_PROVIDER_FAILED"); return { bytes, mimeType: "image/png" }; } }, platformRepository: { find: async (value: string) => ({ code: value, name: value, marketScope: "domestic", mainImageBackground: value === "Amazon" ? "pure_white_required" : "flexible", mainImageStrategy: "", galleryStrategy: "", textStrategy: "", modelStrategy: "", sourceNote: "", sortOrder: 1 }), listEnabled: async () => [] }, llmClient: { provider: "fake", model: "fake", isFake: true, async generatePlan(input) { return planOutput(input.inputImageIds[0] ?? inputId); }, async generateCategoryPrompt(input) { const imageId = input.inputImageIds[0] ?? inputId; return { schemaVersion: "suite-category-prompt-v1", category: input.categoryCode, items: Array.from({ length: input.requestedCount }, (_, index) => ({ stableId: `${input.categoryCode}-${index}`, category: input.categoryCode, title: "图片", purpose: "展示商品", referenceImageIds: [imageId], factRefs: [], prompt: "生成", allowsTextOverlay: "no", textContent: [], aspectRatio: "1:1", suggestedParams: {} })) }; } } });
  const app = createApp();
  return { app, newApp: createApp, repository, storage, prompts, pipeline, suite, inputId, bytes, planCallCount: () => planCalls, providerCallCount: () => providerCalls, submitFacts: () => { factsSubmitted = true; }, setProviderFails: (value: boolean) => { providerFails = value; } };
}

async function waitPipeline(app: ReturnType<typeof createTicket02App>, suiteId: string, statuses = ["completed", "failed", "partial_failed", "waiting_human_input", "waiting_base_refine_decision"] as string[]) {
  for (let i = 0; i < 150; i += 1) {
    const response = await app.request("GET", `/api/suites/${suiteId}/studio-state`);
    const pipeline = (response.body as any).data.pipeline;
    if (pipeline && statuses.includes(pipeline.status)) return pipeline;
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
  throw new Error("pipeline timeout");
}

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
  const started = await fixture.app.request("POST", "/api/suites/one-click-generate", { headers: { "idempotency-key": "missing-facts" }, body: { suiteId: fixture.suite.id, config: { platform: "淘宝", counts: { main: 1, selling_points: 3, lifestyle: 0, other: 0 } } } });
  assert.equal(started.status, 202);
  const waiting = await waitPipeline(fixture.app, fixture.suite.id, ["waiting_human_input"]);
  fixture.submitFacts();
  const resumed = await fixture.app.request("POST", `/api/suites/${fixture.suite.id}/one-click-generate/resume`, { body: { action: "submit_missing_facts", supplementText: "材质为铝合金", counts: { selling_points: 0 } } });
  assert.equal(resumed.status, 202);
  const done = await waitPipeline(fixture.app, fixture.suite.id, ["completed"]);
  assert.equal(done.id, waiting.id);
  assert.notEqual(done.status, "failed");
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
  const amazon = await pipelineFixture({ providerFails: true, platform: "Amazon" });
  const started = await amazon.app.request("POST", "/api/suites/one-click-generate", { headers: { "idempotency-key": "amazon-refine" }, body: { suiteId: amazon.suite.id, config: { platform: "Amazon", counts: { main: 1, selling_points: 0, lifestyle: 0, other: 0 } } } });
  assert.equal(started.status, 202);
  await waitPipeline(amazon.app, amazon.suite.id, ["waiting_base_refine_decision"]);
  const failedRefineCalls = amazon.providerCallCount();
  amazon.setProviderFails(false);
  assert.equal((await amazon.app.request("POST", `/api/suites/${amazon.suite.id}/one-click-generate/resume`, { headers: { "idempotency-key": "amazon-retry" }, body: { action: "retry_base_refine" } })).status, 202);
  const amazonDone = await waitPipeline(amazon.app, amazon.suite.id, ["completed"]);
  assert.equal(amazonDone.status, "completed", JSON.stringify(amazonDone));
  assert.ok(amazon.providerCallCount() > failedRefineCalls);
  const rejected = await amazon.app.request("POST", `/api/suites/${amazon.suite.id}/one-click-generate/resume`, { body: { action: "skip_base_refine" } });
  assert.equal(rejected.status, 409);
  const taobao = await pipelineFixture({ providerFails: true });
  await taobao.app.request("POST", "/api/suites/one-click-generate", { headers: { "idempotency-key": "taobao-refine" }, body: { suiteId: taobao.suite.id, config: { platform: "淘宝", refineBaseImages: true, counts: { main: 1, selling_points: 0, lifestyle: 0, other: 0 } } } });
  await waitPipeline(taobao.app, taobao.suite.id, ["waiting_base_refine_decision"]);
  taobao.setProviderFails(false);
  assert.equal((await taobao.app.request("POST", `/api/suites/${taobao.suite.id}/one-click-generate/resume`, { body: { action: "skip_base_refine" } })).status, 202);
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

test("interrupted pipeline resumes on the original run and repeated resume is not blocked by idempotency", async () => {
  const fixture = await pipelineFixture();
  const started = await fixture.app.request("POST", "/api/suites/one-click-generate", { headers: { "idempotency-key": "interrupt" }, body: { suiteId: fixture.suite.id, config: { platform: "淘宝", counts: { main: 1, selling_points: 0, lifestyle: 0, other: 0 } } } });
  const runId = (started.body as any).data.pipeline.id;
  await waitPipeline(fixture.app, fixture.suite.id, ["completed"]);
  const callsBeforeRestart = fixture.planCallCount();
  await fixture.pipeline.updateRun(runId, { status: "failed", errorCode: "PIPELINE_INTERRUPTED", currentPhase: "structure_planning" });
  const restartedApp = fixture.newApp();
  const resumed = await restartedApp.request("POST", `/api/suites/${fixture.suite.id}/one-click-generate/resume`, { headers: { "idempotency-key": "interrupt-resume" }, body: { action: "resume_after_interrupt" } });
  assert.equal(resumed.status, 202);
  assert.equal((resumed.body as any).data.pipeline.id, runId);
  const duplicateResume = await restartedApp.request("POST", `/api/suites/${fixture.suite.id}/one-click-generate/resume`, { headers: { "idempotency-key": "interrupt-resume" }, body: { action: "resume_after_interrupt" } });
  assert.equal(duplicateResume.status, 202);
  assert.equal((duplicateResume.body as any).data.pipeline.resumeCount, (resumed.body as any).data.pipeline.resumeCount);
  const done = await waitPipeline(restartedApp, fixture.suite.id, ["completed"]);
  assert.equal(done.status, "completed");
  assert.equal(fixture.planCallCount(), callsBeforeRestart);
});

test("feed excludes empty drafts, paginates by created time, and export honors taskIds", async () => {
  const fixture = await pipelineFixture();
  await fixture.repository.createSuite("空草稿");
  await fixture.app.request("POST", "/api/suites/one-click-generate", { headers: { "idempotency-key": "feed-run" }, body: { suiteId: fixture.suite.id, config: { platform: "淘宝", counts: { main: 1, selling_points: 0, lifestyle: 0, other: 0 } } } });
  await waitPipeline(fixture.app, fixture.suite.id, ["completed"]);
  await fixture.app.request("POST", "/api/suites/one-click-generate", { headers: { "idempotency-key": "feed-clone" }, body: { cloneFrom: { suiteId: fixture.suite.id, imageIds: [fixture.inputId] }, config: { platform: "淘宝", mode: "custom", counts: { main: 1, selling_points: 0, lifestyle: 0, other: 0 } } } });
  const feed0 = await fixture.app.request("GET", "/api/suites/feed?limit=1&offset=0");
  const feed1 = await fixture.app.request("GET", "/api/suites/feed?limit=1&offset=1");
  assert.equal(feed0.status, 200);
  assert.equal(feed1.status, 200);
  assert.equal((feed0.body as any).data.items.length, 1);
  assert.equal((feed1.body as any).data.items.length, 1);
  assert.notEqual((feed0.body as any).data.items[0].suite.id, (feed1.body as any).data.items[0].suite.id);
  const state = await fixture.app.request("GET", `/api/suites/${fixture.suite.id}/studio-state`);
  const taskId = (state.body as any).data.cards[0]?.parentTaskId;
  assert.ok(taskId);
  const exported = await fixture.app.request("GET", `/api/suites/${fixture.suite.id}/delivery/export?taskIds=${taskId}`);
  assert.equal(exported.status, 200);
  assert.ok(exported.raw);
  const zipText = exported.raw!.toString("latin1");
  assert.equal((zipText.match(/PK\x01\x02/g) ?? []).length, 2);
});
