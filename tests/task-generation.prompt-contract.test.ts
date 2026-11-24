import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import { createSuiteStudioApp } from "../server/app.js";
import { MemoryPlanRepository } from "../server/repositories/memory-plan-repository.js";
import { MemoryPromptRepository } from "../server/repositories/memory-prompt-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";
import { parsePromptMarkdown } from "../server/prompt-library.js";
import type { LlmClient } from "../server/types.js";

test("retired single-phase POST /api/suites/:id/plan returns 410 without calling LLM", async () => {
  const suites = new MemorySuiteRepository();
  const prompts = new MemoryPromptRepository();
  const plans = new MemoryPlanRepository();
  const storage = new MemoryStorage();
  const [template] = await prompts.importRecords(parsePromptMarkdown(
    "## 验证计划\n\n```text\n- 商品名称（必填）：\n```",
    "ticket08.md",
  ));
  await prompts.publishVersion(template.templateVersionId);
  const suite = await suites.createSuite("Ticket 08 retired legacy plan");
  const imageBytes = await sharp({ create: { width: 12, height: 12, channels: 3, background: "white" } }).png().toBuffer();
  let llmCalls = 0;
  const app = createSuiteStudioApp({
    repository: suites,
    storage,
    promptRepository: prompts,
    planRepository: plans,
    llmClient: {
      provider: "deterministic_fake",
      model: "ticket08-fixed",
      isFake: true,
      async generatePlan() {
        llmCalls += 1;
        return { schemaVersion: "suite-plan-v1", items: [{ title: "主图", purpose: "展示商品", prompt: "纯白背景展示包装。", imageType: "main" }] };
      },
    } satisfies LlmClient,
  });
  const uploaded = await app.upload(suite.id, { filename: "white.png", mimeType: "image/png", bytes: imageBytes });
  const inputId = (uploaded.body as any).data.id as string;
  const response = await app.request("POST", `/api/suites/${suite.id}/plan`, {
    headers: { "idempotency-key": randomUUID() },
    body: {
      templateVersionId: template.templateVersionId,
      dynamicInput: { product_name: "白色包装" },
      humanInput: { style_guide: "干净、克制" },
      selectedChunks: [],
      inputImageIds: [inputId],
    },
  });
  assert.equal(response.status, 410);
  assert.equal((response.body as any).error.code, "LEGACY_ENDPOINT_GONE");
  assert.equal(llmCalls, 0);
});
