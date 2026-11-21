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

test("one click endpoint accepts an idempotency key and freezes listing copy config", async () => {
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
  const app = createTicket02App({ repository, storage, promptRepository: prompts, planRepository: new MemoryPlanRepository(), categoryPromptRepository: new MemoryCategoryPromptRepository(), taskRepository: new MemoryTaskRepository(), provider: { edit: async () => ({ bytes, mimeType: "image/png" }) }, llmClient: { provider: "fake", model: "fake", isFake: true, async generatePlan() { return { schemaVersion: "suite-structure-plan-v2", status: "READY_FOR_REVIEW", mainAllocation: { category: "main", count: 1, reason: "主图", sourceImageIds: [inputId], factRefs: [], missingFacts: [] }, detailImageCount: 0, categoryAllocations: ["feature_benefit", "material_detail", "lifestyle_use", "comparison", "size_scale", "appearance_angles", "included_items", "compatibility_application", "variant_bundle", "packaging_unboxing", "care_instruction"].map((category) => ({ category, requirement: "optional", count: 0, reason: "", sourceImageIds: [inputId], factRefs: [], missingFacts: [] })), globalStyleCard: { promptPrefix: "统一" } }; }, async generateCategoryPrompt(input) { return { schemaVersion: "suite-category-prompt-v1", category: input.categoryCode, items: Array.from({ length: input.requestedCount }, (_, index) => ({ stableId: `${input.categoryCode}-${index}`, category: input.categoryCode, title: "主图", purpose: "展示商品", referenceImageIds: [inputId], factRefs: [], prompt: "生成", allowsTextOverlay: "no", textContent: [], aspectRatio: "1:1", suggestedParams: {} })) }; } } });
  const started = await app.request("POST", "/api/suites/one-click-generate", { headers: { "Idempotency-Key": "pipeline-test" }, body: { suiteId: suite.id, config: { mode: "custom", counts: { main: 1, selling_points: 0, lifestyle: 0, other: 0 }, listingCopy: true } } });
  assert.equal(started.status, 202);
  const duplicate = await app.request("POST", "/api/suites/one-click-generate", { headers: { "idempotency-key": "pipeline-test" }, body: { suiteId: suite.id, config: { listingCopy: false } } });
  assert.equal(duplicate.status, 202);
  assert.equal((duplicate.body as any).data.pipeline.config.listingCopy, true);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const state = await app.request("GET", `/api/suites/${suite.id}/studio-state`);
  assert.equal(state.status, 200);
});
