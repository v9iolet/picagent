import assert from "node:assert/strict";
import test from "node:test";
import { createSuiteStudioApp } from "../server/app.js";
import { MemoryPlanRepository } from "../server/repositories/memory-plan-repository.js";
import { MemoryPromptRepository } from "../server/repositories/memory-prompt-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";
import { parsePromptMarkdown } from "../server/prompt-library.js";
import type { LlmClient } from "../server/types.js";

const planMarkdown = `## 验证计划\n\n\`\`\`text\n- 商品名称（必填）：\n请输出套图计划。\n\`\`\``;

test("legacy POST /api/suites/:id/plan returns 410 LEGACY_ENDPOINT_GONE without invoking LLM or mutating plans", async () => {
  const suites = new MemorySuiteRepository();
  const prompts = new MemoryPromptRepository();
  const [template] = await prompts.importRecords(parsePromptMarkdown(planMarkdown, "test.md"));
  await prompts.publishVersion(template.templateVersionId);
  const suite = await suites.createSuite("Ticket 05 legacy plan gone");
  const plans = new MemoryPlanRepository();
  let llmCalls = 0;
  const llm: LlmClient = {
    provider: "deterministic_fake",
    model: "ticket05-fixed",
    isFake: true,
    async generatePlan() {
      llmCalls += 1;
      return { schemaVersion: "suite-plan-v1", items: [{ title: "白底首图", purpose: "展示商品", prompt: "不应执行。" }] };
    },
  };
  const app = createSuiteStudioApp({
    repository: suites,
    storage: new MemoryStorage(),
    promptRepository: prompts,
    planRepository: plans,
    llmClient: llm,
  });

  const response = await app.request("POST", `/api/suites/${suite.id}/plan`, {
    headers: { "idempotency-key": "legacy-plan-1" },
    body: { templateVersionId: template.templateVersionId, dynamicInput: { product_name: "人工商品名" }, selectedChunks: [] },
  });

  assert.equal(response.status, 410);
  assert.equal((response.body as any).error.code, "LEGACY_ENDPOINT_GONE");
  assert.equal(llmCalls, 0);
  assert.equal(await plans.getLatestAttempt(suite.id), null);
  assert.equal(await plans.getLatestSnapshot(suite.id), null);
});

test("a missing historical object returns 404 instead of crashing the API", async () => {
  const suites = new MemorySuiteRepository();
  const suite = await suites.createSuite("missing object");
  const image = await suites.createInputImage({
    id: "00000000-0000-4000-8000-000000000001",
    suiteId: suite.id,
    ordinal: 1,
    originalObjectKey: `suites/${suite.id}/inputs/00000000-0000-4000-8000-000000000001/original`,
    thumbnailObjectKey: `suites/${suite.id}/inputs/00000000-0000-4000-8000-000000000001/thumbnail`,
    sha256: "b".repeat(64),
    width: 1,
    height: 1,
    mimeType: "image/png",
    originalFilename: "missing.png",
    currentBaseVersionId: null,
    createdAt: new Date().toISOString(),
  });
  const storage = {
    ...new MemoryStorage(),
    put: async () => {},
    get: async () => null,
    delete: async () => {},
    previewUrl: async () => { throw new Error("OBJECT_NOT_FOUND"); },
  };
  const app = createSuiteStudioApp({ repository: suites, storage });
  const response = await app.preview(suite.id, image.id, "original");
  assert.equal(response.status, 404);
});
