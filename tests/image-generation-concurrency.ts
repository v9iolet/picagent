import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { createSuiteStudioApp } from "../server/app.js";
import { ImageEditorService, type ImageEditorRepository } from "../server/image-editor.js";
import { createImageEditorApi } from "../server/image-editor-api.js";
import { parseNormalizedPromptMarkdown, parsePromptMarkdown } from "../server/prompt-library.js";
import { MemoryLibraryRepository } from "../server/repositories/memory-library-repository.js";
import { MemoryPlatformRepository } from "../server/repositories/memory-platform-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";
import { waitUntil } from "../server/suite-pipeline.js";
import type { PipelineRepository, PromptRepository, SuiteRepository, TaskRepository } from "../server/types.js";

export async function verifyGenerationConcurrency(repository: SuiteRepository, tasks: TaskRepository,
  pipelines: PipelineRepository, prompts: PromptRepository, editorRepository: ImageEditorRepository) {
  const storage = new MemoryStorage();
  const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: "navy" } }).png().toBuffer();
  const source = { bytes, mimeType: "image/png", width: 32, height: 32 };
  let calls = 0;
  let gate = Promise.withResolvers<void>();
  async function edit() { calls++; await gate.promise; return source; }
  const editor = new ImageEditorService(editorRepository, {
    name: "mock", version: "1", capabilitiesVersion: "1", edit,
    capabilities: () => ({ imageToImage: true, addText: true, changeText: true, redraw: true, erase: true, outpaint: true, currentVersionInput: true }),
  }, storage, async () => source);
  for (const name of ["aplus-plan", "aplus-module-hero", "aplus-image"]) {
    const file = `prompt/normalized/${name}.md`;
    const [version] = await prompts.importRecords([parseNormalizedPromptMarkdown(await readFile(file, "utf8"), file)]);
    await prompts.publishVersion(version.templateVersionId);
  }
  const [base] = await prompts.importRecords(parsePromptMarkdown("### 产品图转干净产品底图返修提示词\n\n```plain\n白底精修\n```", "prompt.md"));
  await prompts.publishVersion(base.templateVersionId);
  const app = createSuiteStudioApp({
    repository, storage, taskRepository: tasks, pipelineRepository: pipelines, promptRepository: prompts,
    libraryRepository: new MemoryLibraryRepository(), imageEditorApi: createImageEditorApi(editor),
    platformRepository: new MemoryPlatformRepository([{ code: "amazon", name: "Amazon", marketScope: "overseas", sortOrder: 1,
      mainImageBackground: "flexible", mainImageStrategy: "", galleryStrategy: "", textStrategy: "", modelStrategy: "", sourceNote: "" }]),
    provider: { edit }, llmClient: { provider: "fake", model: "fake", isFake: true, async generatePlan() {
      return { schemaVersion: "aplus-plan-v1", taskName: "水杯", globalPlan: "展示水杯",
        modules: [{ moduleCode: "hero", copyRequirements: "随行", imagePrompts: { "1:1": "展示商品" } }] };
    } },
  });
  const draft = await repository.createSuite("原图");
  const upload = await app.upload(draft.id, { bytes, mimeType: "image/png", filename: "product.png" });
  assert.equal(upload.status, 201);
  const imageId = upload.body.data.id;
  const post = (path: string, key: string, body: object = {}) => app.request("POST", path, { headers: { "idempotency-key": key }, body });

  // Block the mock provider until both callers have a receipt and a competing action has been rejected.
  async function concurrent(path: string, body: object, id: "attempt" | "batchId" | "runId", conflict?: string) {
    const before = calls;
    gate = Promise.withResolvers<void>();
    try {
      const results = await Promise.all([post(path, path, body), post(path, path, body)]);
      for (const result of results) assert.ok([200, 202].includes(result.status), JSON.stringify(result.body));
      const ids = results.map(({ body }) => id === "attempt" ? body.data.attempt.id : body.data[id]);
      assert.ok(ids[0]);
      assert.equal(ids[0], ids[1]);
      if (conflict) {
        const other = await post(path, "different-" + path, "promptDraft" in body ? { promptDraft: "冲突的提示词" } : body);
        assert.equal(other.status, 409, JSON.stringify(other.body));
        assert.equal(other.body.error.code, conflict);
      }
      await waitUntil(async () => calls, (n) => n > before, 5000);
      assert.equal(calls, before + 1);
      return results[0].body.data;
    } finally {
      gate.resolve();
    }
  }

  await concurrent(`/api/suites/${draft.id}/input-images/${imageId}/base-generation`,
    { templateVersionId: base.templateVersionId }, "attempt", "BASE_GENERATION_IN_PROGRESS");
  const baseAttempts = await waitUntil(() => repository.listGenerationAttempts(draft.id, imageId),
    (rows) => rows.some((a) => a.status === "succeeded"), 5000);
  assert.equal(baseAttempts.length, 1);
  const payload = { suiteId: draft.id, inputImageIds: [imageId], productInfo: "水杯", platform: "amazon",
    targetMarket: "美国", language: "en", sizePresets: ["1:1"], modules: ["hero"], resolution: "1K" };
  const plan = await post("/api/aplus", "plan", payload);
  assert.equal(plan.status, 202, JSON.stringify(plan.body));
  const { suiteId, runId } = plan.body.data;
  await waitUntil(() => pipelines.getRun(runId), (run) => run?.currentPhase === "awaiting_confirmation", 5000);
  await concurrent(`/api/aplus/${suiteId}/confirm`, payload, "runId");
  await waitUntil(() => pipelines.getRun(runId), (run) => run?.status === "completed", 5000);
  const cards = await tasks.listTasks(suiteId);
  assert.equal(cards.length, 1);
  const [{ id: taskId }] = cards;
  for (const path of [`/api/suites/${suiteId}/generation`, `/api/suite-tasks/${taskId}/generation`]) {
    const body = path.startsWith("/api/suite-tasks/") ? { promptDraft: "确认的提示词" } : {};
    const { batchId } = await concurrent(path, body, "batchId", "TASK_GENERATION_IN_PROGRESS");
    await waitUntil(() => tasks.getBatch(batchId), (batch) => batch?.status === "completed", 5000);
  }
  assert.equal((await tasks.getTask(taskId))?.promptDraft, "确认的提示词");
  const redrawPath = `/api/suite-tasks/${taskId}/generation`;
  gate = Promise.withResolvers<void>();
  const beforeRace = calls;
  let winningBatchId: string;
  try {
    const raced = await Promise.all(["新提示词一", "新提示词二"].map((promptDraft) => post(redrawPath, promptDraft, { promptDraft })));
    assert.deepEqual(raced.map((r) => r.status).sort(), [202, 409]);
    const winner = raced.findIndex((r) => r.status === 202);
    winningBatchId = raced[winner].body.data.batchId;
    assert.equal(raced[1 - winner].body.error.code, "TASK_GENERATION_IN_PROGRESS");
    // Replaying an older receipt must not overwrite the accepted prompt.
    assert.equal((await post(redrawPath, redrawPath, { promptDraft: "确认的提示词" })).status, 200);
    assert.equal((await tasks.getTask(taskId))?.promptDraft, winner === 0 ? "新提示词一" : "新提示词二");
  } finally {
    gate.resolve();
  }
  await waitUntil(() => tasks.getBatch(winningBatchId), (batch) => batch?.status === "completed", 5000);
  assert.equal(calls, beforeRace + 1);
  const history = await tasks.listTaskVersions(taskId);
  assert.equal(history.attempts.length, 4);
  const sourceVersionId = history.versions[0].id;
  const selection = { sourceCardId: taskId, sourceVersionId, tool: "re_edit" };
  await editor.upsertOperation({ sessionId: taskId, operation: { ...selection, type: "re_edit", operationId: "edit",
    parentVersionId: sourceVersionId, order: 1, summary: "改背景", payload: { prompt: "改为蓝色" } } });
  const submitted = await concurrent(`/api/image-editor/sessions/${taskId}/submit`, selection, "attempt", "IMAGE_EDIT_IN_PROGRESS");
  const childId = submitted.childTask.id;
  await waitUntil(() => editorRepository.getChildTask(childId), (child) => child?.status === "succeeded", 5000);
  await concurrent(`/api/image-editor/tasks/${childId}/regenerate`, {}, "attempt", "IMAGE_EDIT_IN_PROGRESS");
  await waitUntil(() => editorRepository.getChildTask(childId), (child) => child?.status === "succeeded", 5000);
  assert.equal((await editorRepository.listChildTasks()).length, 1);
  assert.equal((await editorRepository.listAttempts(childId)).length, 2);
  assert.equal(calls, 7);
}
