import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import sharp from "sharp";
import { APLUS_SIZE_PRESETS, isAplusPlanStale, type AplusSizePresetKey } from "../shared/aplus.js";
import { defaultImageOptions } from "../shared/model-settings.js";
import { selectAplusGenerationSize } from "../server/aplus/aplus-image.js";
import type { AppResponse } from "../server/api-response.js";
import { createSuiteStudioApp } from "../server/app.js";
import { createImageEditorApi } from "../server/image-editor-api.js";
import { ImageEditorService, MemoryImageEditorRepository } from "../server/image-editor.js";
import { parseNormalizedPromptMarkdown } from "../server/prompt-library.js";
import { MemoryPipelineRepository } from "../server/repositories/memory-pipeline-repository.js";
import { MemoryPlatformRepository } from "../server/repositories/memory-platform-repository.js";
import { MemoryPromptRepository } from "../server/repositories/memory-prompt-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryTaskRepository } from "../server/repositories/memory-task-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";
import { waitUntil } from "../server/suite-pipeline.js";
import type { ImageEditRequest, TaskImageVersion } from "../server/types.js";

const fakeSize = { width: 120, height: 80 };
const modules = ["hero", "selling_points", "usage_scene"];
const premiumPresets = ["aplus_premium_web", "aplus_premium_mobile"] as const;
const promptNames = ["aplus-plan", "aplus-module-hero", "aplus-module-selling_points", "aplus-module-usage_scene", "aplus-image"];

function data<T>(response: AppResponse, status = 200): T {
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.ok("data" in response.body);
  return response.body.data as T;
}

function checkError(response: AppResponse, status: number, code: string) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.ok("error" in response.body);
  assert.equal(response.body.error.code, code);
}

async function fixture(sizePresets: readonly AplusSizePresetKey[], beforeImage?: (call: number) => Promise<void>) {
  const repository = new MemorySuiteRepository();
  const pipelines = new MemoryPipelineRepository();
  const tasks = new MemoryTaskRepository();
  const editorTasks = new MemoryImageEditorRepository();
  const storage = new MemoryStorage();
  const prompts = new MemoryPromptRepository();
  const versions = await prompts.importRecords(await Promise.all(promptNames.map(async (name) => {
    const path = `prompt/normalized/${name}.md`;
    return parseNormalizedPromptMarkdown(await readFile(path, "utf8"), path);
  })));
  for (const version of versions) await prompts.publishVersion(version.templateVersionId);
  const promptVersionIds = Object.fromEntries(promptNames.map((name, index) => [name, versions[index].templateVersionId]));
  const platforms = new MemoryPlatformRepository([{
    code: "amazon", name: "Amazon", marketScope: "overseas", sortOrder: 1,
    mainImageBackground: "flexible", mainImageStrategy: "", galleryStrategy: "", textStrategy: "", modelStrategy: "", sourceNote: "",
  }]);
  const generated = await sharp({ create: { ...fakeSize, channels: 3, background: "navy" } }).png().toBuffer();
  const calls: ImageEditRequest[] = [];
  const editor = new ImageEditorService(editorTasks, {
    name: "fake-editor", version: "1", capabilitiesVersion: "1",
    capabilities: () => ({ imageToImage: true, addText: true, changeText: true, redraw: true, erase: true, outpaint: true, currentVersionInput: true }),
    edit: async () => ({ bytes: generated, mimeType: "image/png", ...fakeSize }),
  }, storage, async () => ({ bytes: generated, mimeType: "image/png", ...fakeSize }));
  const app = createSuiteStudioApp({
    repository, storage, taskRepository: tasks, pipelineRepository: pipelines, promptRepository: prompts, platformRepository: platforms,
    imageEditorApi: createImageEditorApi(editor), imageGenerationConcurrency: 1, imageRetryDelayMs: 0,
    provider: {
      supportsMultipleImages: true,
      async edit(request) {
        calls.push(request);
        await beforeImage?.(calls.length);
        return { bytes: generated, mimeType: "image/png" };
      },
    },
    llmClient: {
      provider: "fake", model: "fake-vision", isFake: true,
      async generatePlan() {
        return {
          schemaVersion: "aplus-plan-v1", taskName: "随行杯详情", globalPlan: "深蓝背景",
          modules: modules.map((moduleCode) => ({
            moduleCode, copyRequirements: "出门随行",
            imagePrompts: Object.fromEntries(sizePresets.map((preset) => [preset, `构图：${moduleCode}/${preset}`])),
          })),
        };
      },
    },
  });
  const draft = await repository.createSuite("原图上传草稿");
  const originals = await Promise.all(["red", "blue"].map((background) =>
    sharp({ create: { width: 90, height: 60, channels: 3, background } }).png().toBuffer()));
  const inputImageIds = [];
  for (const [index, bytes] of originals.entries()) {
    const response = await app.upload(draft.id, { bytes, mimeType: "image/png", filename: `original-${index}.png` });
    inputImageIds.push(data<{ id: string }>(response, 201).id);
  }
  const payload = {
    suiteId: draft.id, inputImageIds, productInfo: "磨砂杯身", platform: "amazon", targetMarket: "美国",
    language: "en", sizePresets, modules, resolution: "2K",
  };
  const started = await app.request("POST", "/api/aplus", { headers: { "idempotency-key": "plan" }, body: payload });
  const { suiteId, runId } = data<{ suiteId: string; runId: string }>(started, 202);
  const waitForRun = () => waitUntil(() => pipelines.getRun(runId), (run) => Boolean(run && run.status !== "running"), 5000);
  assert.equal((await waitForRun())?.currentPhase, "awaiting_confirmation");
  const path = `/api/aplus/${suiteId}`;
  const confirm = (body: unknown = payload, key = "confirm") => app.request("POST", `${path}/confirm`, {
    headers: { "idempotency-key": key }, body,
  });
  return { app, editor, tasks, storage, pipelines, payload, path, suiteId, runId, confirm, waitForRun, originals, calls, promptVersionIds };
}

async function dimensions(storage: MemoryStorage, key: string) {
  const object = await storage.get(key);
  assert.ok(object, key);
  const { width, height } = await sharp(object.bytes).metadata();
  return { width, height };
}

test("像素渠道按预设精确比例换算，档位渠道取最接近比例，高级 Web 强制 1K", () => {
  const pixels = defaultImageOptions("gpt-image-2");
  assert.deepEqual(selectAplusGenerationSize("aplus_standard", "2K", pixels), {
    tier: "2K", ratio: "970:600", size: "3312x2048", generatedSize: { width: 3312, height: 2048 },
  });
  assert.deepEqual(selectAplusGenerationSize("aplus_premium_web", "2K", pixels), {
    tier: "1K", ratio: "1464:600", size: "2496x1024", generatedSize: { width: 2496, height: 1024 },
  });
  const tier = { sizes: ["1K", "2K"], aspectRatios: ["1:1", "4:3", "3:2", "16:9"], sizeMode: "tier" } as const;
  const options = { ...tier, sizes: [...tier.sizes], aspectRatios: [...tier.aspectRatios] };
  assert.deepEqual(selectAplusGenerationSize("aplus_premium_web", "2K", options), {
    tier: "1K", ratio: "16:9", size: "1K", generatedSize: { width: 1824, height: 1024 },
  });
  assert.equal(selectAplusGenerationSize("aplus_standard", "2K", options).ratio, "3:2");
  assert.equal(selectAplusGenerationSize("aplus_premium_mobile", "2K", options).ratio, "4:3");
  assert.equal(selectAplusGenerationSize("1:1", "2K", { ...options, sizes: ["1K"] }).size, "1K");
  assert.throws(() => selectAplusGenerationSize("aplus_premium_web", "2K", { ...options, sizes: ["2K"] }), /IMAGE_SIZE_UNSUPPORTED/);
});

test("确认按编辑后的模块与高级 A+ 预设建卡，冻结提示词、全部原图和请求尺寸，输出交付图", async () => {
  const f = await fixture(premiumPresets);
  const edited = await f.app.request("PATCH", `${f.path}/plan`, { body: {
    modules: [{ moduleCode: "usage_scene", copyRequirements: "带去露营" }, { moduleCode: "hero" }],
  } });
  const { inputSnapshot } = data<{ inputSnapshot: Parameters<typeof isAplusPlanStale>[0] }>(edited);
  assert.equal(isAplusPlanStale(inputSnapshot, { ...inputSnapshot, language: "英文", targetMarket: " 美国 " }), false);
  const body = { ...f.payload, language: "英文", targetMarket: " 美国 " };
  const confirmations = await Promise.all([f.confirm(body), f.confirm(body)]);
  assert.deepEqual(confirmations.map((result) => result.status).sort(), [200, 202]);
  assert.equal((await f.waitForRun())?.currentPhase, "done");

  const tasks = await f.tasks.listTasks(f.suiteId);
  assert.equal(tasks.length, 2 * premiumPresets.length);
  assert.deepEqual(tasks.map((task) => [task.originKind, task.moduleCode, task.sizePreset, task.sortOrder]), [
    ["aplus", "usage_scene", "aplus_premium_web", 1], ["aplus", "usage_scene", "aplus_premium_mobile", 2],
    ["aplus", "hero", "aplus_premium_web", 3], ["aplus", "hero", "aplus_premium_mobile", 4],
  ]);
  assert.equal((await f.tasks.listBatches(f.suiteId)).length, 1);
  assert.deepEqual(f.calls.map((call) => call.size), ["2496x1024", "2736x2048", "2496x1024", "2736x2048"]);
  const inputs = await Promise.all(tasks[0].referenceImageIds!.map((id) => f.storage.get(`suites/${f.suiteId}/inputs/${id}/original`)));
  assert.deepEqual(inputs.map((object) => object?.bytes), f.originals);
  for (const [index, task] of tasks.entries()) {
    const { versions: [version], attempts: [attempt] } = await f.tasks.listTaskVersions(task.id);
    assert.equal(attempt.requestSummary.size, f.calls[index].size);
    assert.equal(version.promptSnapshot.templateVersionId, f.promptVersionIds["aplus-image"]);
    assert.equal(version.promptSnapshot.planTemplateVersionId, f.promptVersionIds["aplus-plan"]);
    assert.equal((version.promptSnapshot.moduleRuleVersionIds as Record<string, string>)[task.moduleCode!], f.promptVersionIds[`aplus-module-${task.moduleCode}`]);
    assert.match(f.calls[index].prompt, /中心安全区/);
    assert.ok(f.calls[index].prompt.includes(`构图：${task.moduleCode}/${task.sizePreset}`));
    assert.match(f.calls[index].prompt, task.moduleCode === "usage_scene" ? /带去露营/ : /出门随行/);
    assert.deepEqual(f.calls[index].images?.map((image) => [image.role, image.bytes]), f.originals.map((bytes) => ["product", bytes]));
    assert.deepEqual(version.contextSnapshot.inputImages, inputs.map((object, imageIndex) => ({
      role: "product", objectKey: object?.key, mimeType: "image/png", filename: `product-${imageIndex + 1}.png`,
    })));
    assert.deepEqual(version.generatedSize, fakeSize);
    assert.deepEqual(await dimensions(f.storage, version.objectKey), fakeSize);
    assert.notEqual(version.deliveryObjectKey, version.objectKey);
    const expected = APLUS_SIZE_PRESETS[task.sizePreset!].deliverySize;
    assert.deepEqual(version.deliverySize, expected);
    assert.deepEqual(await dimensions(f.storage, version.deliveryObjectKey!), expected);
  }
  const state = data<{ progress: unknown; cards: Array<{ sizePreset: string; deliverySize: unknown }> }>(await f.app.request("GET", `${f.path}/studio-state`));
  assert.deepEqual(state.progress, { total: 4, completed: 4, percent: 100 });
  assert.equal(state.cards[0].sizePreset, "aplus_premium_web");
  assert.deepEqual(state.cards[0].deliverySize, { width: 1464, height: 600 });

  const { versions: [webSource] } = await f.tasks.listTaskVersions(tasks[0].id);
  data(await f.app.request("POST", `/api/suite-tasks/${tasks[0].id}/generation`, {
    headers: { "idempotency-key": "editor-regenerate-web" }, body: { editSourceVersionId: webSource.id },
  }), 202);
  const regenerated = await waitUntil(() => f.tasks.listTaskVersions(tasks[0].id), ({ versions }) => versions.length === 2, 5000);
  assert.equal(regenerated.attempts.at(-1)?.requestSummary.size, "2496x1024");
  assert.equal(f.calls.at(-1)?.size, "2496x1024");
  assert.deepEqual(f.calls.at(-1)?.images?.map(({ role }) => role), ["source", "product", "product"]);
  assert.deepEqual(f.calls.at(-1)?.images?.slice(1).map(({ bytes }) => bytes), f.originals);
  assert.deepEqual(await dimensions(f.storage, regenerated.versions[0].deliveryObjectKey!), { width: 1464, height: 600 });
});

test("普通 A+ 精确交付 970×600，重绘、子卡和多代编辑版本沿用交付裁切", async () => {
  const f = await fixture(["aplus_standard"]);
  data(await f.confirm({ ...f.payload, resolution: "1K" }), 202);
  assert.equal((await f.waitForRun())?.status, "completed");
  const [task] = await f.tasks.listTasks(f.suiteId);
  const expected = { width: 970, height: 600 };
  const assertDelivery = async (version: Pick<TaskImageVersion, "objectKey" | "generatedSize" | "deliverySize" | "deliveryObjectKey">) => {
    assert.deepEqual(await dimensions(f.storage, version.objectKey), fakeSize);
    assert.deepEqual(version.generatedSize, fakeSize);
    assert.deepEqual(version.deliverySize, expected);
    assert.deepEqual(await dimensions(f.storage, version.deliveryObjectKey!), expected);
  };
  const { versions: [first] } = await f.tasks.listTaskVersions(task.id);
  await assertDelivery(first);
  const preview = `/api/suite-tasks/${task.id}/versions/${first.id}/preview`;
  const generatedResponse = await f.app.request("GET", preview);
  const deliveryResponse = await f.app.request("GET", `${preview}/delivery`);
  assert.deepEqual(generatedResponse.raw, (await f.storage.get(first.objectKey))?.bytes);
  assert.deepEqual(deliveryResponse.raw, (await f.storage.get(first.deliveryObjectKey!))?.bytes);
  checkError(await f.app.request("GET", `/api/suite-tasks/unknown/versions/${first.id}/preview/delivery`), 404, "INVALID_TASK_VERSION");
  const redrawn = await f.app.request("POST", `/api/suite-tasks/${task.id}/generation`, {
    headers: { "idempotency-key": "redraw" }, body: { additionalPrompt: "保留磨砂纹理" },
  });
  data(redrawn, 202);
  const history = await waitUntil(() => f.tasks.listTaskVersions(task.id), ({ versions }) => versions.length === 2, 5000);
  const current = history.versions[0];
  assert.equal(current.isCurrent, true);
  assert.match(f.calls.at(-1)!.prompt, /单卡人工补充：保留磨砂纹理/);
  assert.equal((await f.tasks.getTask(task.id))?.promptDraft, task.promptDraft);
  await assertDelivery(current);

  let sourceCardId = task.id;
  let sourceVersionId = current.id;
  const edits = [
    { type: "re_edit", summary: "调整背景", payload: { prompt: "调整背景" } },
    { type: "change_text", summary: "修改文字", payload: {
      originalText: "旧文案", newText: "新文案", region: { x: 0.1, y: 0.1, width: 0.4, height: 0.2 },
    } },
  ] as const;
  for (const edit of edits) {
    const sessionId = `edit-${edit.type}`;
    await f.editor.upsertOperation({ sessionId, operation: {
      ...edit, operationId: "edit", order: 1, sourceCardId, sourceVersionId, parentVersionId: sourceVersionId,
    } });
    const { childTask } = await f.editor.submit({ sessionId, idempotencyKey: sessionId, sourceCardId, sourceVersionId, tool: edit.type });
    const result = await waitUntil(() => f.editor.getTask(childTask.id), (value) => Boolean(value && value.task.status !== "generating"), 5000);
    assert.equal(result?.task.status, "succeeded");
    const [version] = result!.versions;
    await assertDelivery(version);
    const preview = `/api/image-editor/tasks/${childTask.id}/versions/${version.id}/preview`;
    assert.deepEqual((await f.app.request("GET", preview)).raw, (await f.storage.get(version.objectKey))?.bytes);
    assert.deepEqual((await f.app.request("GET", `${preview}/delivery`)).raw, (await f.storage.get(version.deliveryObjectKey!))?.bytes);
    sourceCardId = childTask.id;
    sourceVersionId = version.id;
  }
  const state = data<{ cards: Array<{ versionId: string; deliveryObjectKey: string; deliverySize: unknown }> }>(await f.app.request("GET", `${f.path}/studio-state`));
  assert.equal(state.cards[0].versionId, sourceVersionId);
  assert.deepEqual(await dimensions(f.storage, state.cards[0].deliveryObjectKey), expected);
});

test("A+ 单卡重绘拒绝非文本及超过 500 字的附加提示词", async () => {
  const f = await fixture(["aplus_standard"]);
  data(await f.confirm(), 202);
  assert.equal((await f.waitForRun())?.status, "completed");
  const [task] = await f.tasks.listTasks(f.suiteId);
  const path = `/api/suite-tasks/${task.id}/generation`;
  const generate = (additionalPrompt: unknown) => f.app.request("POST", path, {
    headers: { "idempotency-key": "redraw-prompt-length" }, body: { additionalPrompt },
  });

  for (const invalid of [null, 7, {}, "细".repeat(501), " ".repeat(501)]) {
    checkError(await generate(invalid), 400, "APLUS_INVALID_ADDITIONAL_PROMPT");
  }
  assert.equal(f.calls.length, modules.length);
  assert.equal((await f.tasks.listBatches(f.suiteId)).length, 1);

  const boundary = "细".repeat(500);
  data(await generate(boundary), 202);
  await waitUntil(() => f.tasks.listTaskVersions(task.id), ({ versions }) => versions.length === 2, 5000);
  assert.ok(f.calls.at(-1)?.prompt.includes(`单卡人工补充：${boundary}`));
  assert.equal((await f.tasks.getTask(task.id))?.promptDraft, task.promptDraft);
});

test("通用比例沿用生成图，续跑跳过当前版本及原样保留请求尺寸", async () => {
  let releaseInterruptedCall!: () => void;
  const interruptedCall = new Promise<void>((resolve) => { releaseInterruptedCall = resolve; });
  const f = await fixture(["3:4"], async (call) => { if (call === 2) await interruptedCall; });
  data(await f.confirm(), 202);
  try {
    await waitUntil(async () => f.calls.length, (count) => count === 2, 5000);
    const [first, ...pending] = await f.tasks.listTasks(f.suiteId);
    const { versions: [completed] } = await f.tasks.listTaskVersions(first.id);
    assert.deepEqual(completed.deliverySize, fakeSize);
    assert.equal(completed.deliveryObjectKey, completed.objectKey);
    const [originalBatch] = await f.tasks.listBatches(f.suiteId);
    assert.equal(originalBatch.status, "running");
    await f.pipelines.updateRun(f.runId, { status: "failed", errorCode: "PIPELINE_INTERRUPTED" });
    const resume = () => f.app.request("POST", `${f.path}/resume`, { headers: { "idempotency-key": "resume" } });
    data(await resume(), 202);
    assert.equal((await f.waitForRun())?.status, "completed");
    data(await resume());
    assert.equal(f.calls.length, 2 + pending.length);
    assert.deepEqual((await f.tasks.listTaskVersions(first.id)).versions.map(({ id }) => id), [completed.id]);
    assert.deepEqual((await f.tasks.listBatches(f.suiteId)).map((batch) => [batch.status, batch.requestedCount]), [
      ["completed", pending.length], ["partial", modules.length],
    ]);
    for (const task of pending) {
      const history = await f.tasks.listTaskVersions(task.id);
      assert.deepEqual(history.attempts.map((attempt) => [attempt.status, attempt.errorCode]), [
        ["failed", "PIPELINE_INTERRUPTED"], ["succeeded", null],
      ]);
    }
    assert.ok(f.calls.every((call) => call.size === "2048x2736"));
  } finally {
    releaseInterruptedCall();
  }
});

test("确认缺参或类型错误返回 400，配置已变则返回 409 且不建卡", async () => {
  const f = await fixture(premiumPresets);
  checkError(await f.confirm({ ...f.payload, resolution: undefined }), 400, "APLUS_INVALID_RESOLUTION");
  checkError(await f.confirm({ ...f.payload, inputImageIds: undefined }), 400, "APLUS_INVALID_INPUT_IMAGES");
  checkError(await f.confirm({ ...f.payload, productCardRevision: "1" }), 400, "PRODUCT_CARD_NOT_AVAILABLE");
  checkError(await f.confirm({ ...f.payload, sizePresets: [42] }), 400, "APLUS_INVALID_SIZE_PRESETS");
  checkError(await f.confirm({ ...f.payload, productInfo: "改了卖点" }), 409, "APLUS_PLAN_STALE");
  checkError(await f.confirm({ ...f.payload, inputImageIds: [...f.payload.inputImageIds].reverse() }), 409, "APLUS_PLAN_STALE");
  assert.equal((await f.tasks.listTasks(f.suiteId)).length, 0);
  assert.equal(f.calls.length, 0);
});
