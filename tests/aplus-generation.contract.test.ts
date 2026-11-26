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
import { requestImageEditorEdit } from "../server/providers/image-editor-provider.js";
import { GptImageProvider } from "../server/providers/gpt-image-provider.js";
import { MemoryLibraryRepository } from "../server/repositories/memory-library-repository.js";
import { MemoryPipelineRepository } from "../server/repositories/memory-pipeline-repository.js";
import { MemoryPlatformRepository } from "../server/repositories/memory-platform-repository.js";
import { MemoryPromptRepository } from "../server/repositories/memory-prompt-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryTaskRepository } from "../server/repositories/memory-task-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";
import { waitUntil } from "../server/suite-pipeline.js";
import type { ImageEditRequest, LibraryResource, TaskImageVersion } from "../server/types.js";
import { readZipEntries } from "../server/zip.js";
import { makeAplusEditorSourceResolver } from "./aplus-editor-fixture.js";

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

async function fixture(sizePresets: readonly AplusSizePresetKey[], beforeImage?: (call: number, request: ImageEditRequest) => Promise<Buffer | void>, language = "en") {
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
  const fakeEditorProvider = { edit: async () => ({ bytes: generated, mimeType: "image/png" }) };
  const editor = new ImageEditorService(editorTasks, {
    name: "fake-editor", version: "1", capabilitiesVersion: "1",
    capabilities: () => ({ imageToImage: true, addText: true, changeText: true, redraw: true, erase: true, outpaint: true, currentVersionInput: true }),
    edit: (command, source) => requestImageEditorEdit(fakeEditorProvider, storage, "fake", defaultImageOptions("gpt-image-2"), command, source),
  }, storage, makeAplusEditorSourceResolver(repository, tasks, editorTasks, storage));
  const app = createSuiteStudioApp({
    repository, storage, taskRepository: tasks, pipelineRepository: pipelines, promptRepository: prompts, platformRepository: platforms,
    libraryRepository: new MemoryLibraryRepository(),
    imageEditorApi: createImageEditorApi(editor), imageGenerationConcurrency: 1, imageRetryDelayMs: 0,
    provider: {
      supportsMultipleImages: true,
      async edit(request) {
        calls.push(request);
        const bytes = await beforeImage?.(calls.length, request);
        return { bytes: bytes ?? generated, mimeType: "image/png" };
      },
    },
    llmClient: {
      provider: "fake", model: "fake-vision", isFake: true,
      async generatePlan() {
        return {
          schemaVersion: "aplus-plan-v1", taskName: "随行杯详情", globalPlan: "深蓝背景",
          modules: modules.map((moduleCode) => ({
            moduleCode, copyRequirements: language === "none" ? "" : "出门随行",
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
    language, sizePresets, modules, resolution: "2K",
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
    ["aplus", "usage_scene", "aplus_premium_web", 1], ["aplus", "usage_scene", "aplus_premium_mobile", 1],
    ["aplus", "hero", "aplus_premium_web", 2], ["aplus", "hero", "aplus_premium_mobile", 2],
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
    const pictureRequirement = `构图：${task.moduleCode}/${task.sizePreset}`;
    assert.ok(task.promptDraft.includes(`"画面要求": "${pictureRequirement}"`));
    assert.match(task.promptDraft, /100% 满幅出血.*中心安全区/);
    assert.doesNotMatch(task.promptDraft, /整体风格：|深蓝背景/);
    const snapshot = task.generationParams.aplusPromptSnapshot as Record<string, unknown>;
    assert.equal(snapshot.globalPlan, "深蓝背景");
    assert.equal(snapshot.pictureRequirement, pictureRequirement);
    assert.ok(f.calls[index].prompt.includes(task.promptDraft));
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
  const libraryPath = "/api/library/resources";
  const assertLibraryImage = async (id: string, objectKey: string, previewUrl: string | null) => {
    const path = `${libraryPath}/${encodeURIComponent(id)}`;
    const resource = data<LibraryResource>(await f.app.request("GET", path));
    assert.equal(resource.stage, "aplus_image");
    assert.equal(resource.source.origin, "aplus");
    assert.equal(resource.source.originKind, "aplus");
    assert.equal(resource.source.objectKey, objectKey);
    assert.equal(resource.previewUrl, previewUrl);
    const listed = data<{ items: LibraryResource[] }>(await f.app.request("GET", `${libraryPath}?scope=image&stage=aplus_image&query=${encodeURIComponent("A+详情")}`));
    assert.deepEqual(listed.items.find((item) => item.id === id), resource);
    const image = await f.storage.get(objectKey);
    assert.ok(image);
    if (previewUrl) {
      const { width, height } = await sharp(image.bytes).metadata();
      assert.ok(resource.summary.endsWith(` · ${width} × ${height}`));
    }
    assert.deepEqual((await f.app.request("GET", `${path}/preview`)).raw, image.bytes);
    if (previewUrl) assert.deepEqual((await f.app.request("GET", previewUrl)).raw, image.bytes);
  };
  await assertLibraryImage(`task-version:${first.id}`, first.deliveryObjectKey!, `${preview}/delivery`);
  const [legacyTask] = (await f.tasks.listTasks(f.suiteId)).slice(1);
  const { versions: [legacy] } = await f.tasks.listTaskVersions(legacyTask.id);
  legacy.deliveryObjectKey = null;
  await assertLibraryImage(`task-version:${legacy.id}`, legacy.objectKey, legacy.previewUrl);
  first.processObjectKeys.push(first.objectKey);
  await assertLibraryImage(`process:${first.id}:0`, first.objectKey, null);
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
  await f.tasks.selectVersion(task.id, first.id, "final");

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
    await assertLibraryImage(`edit-version:${version.id}`, version.deliveryObjectKey!, `${preview}/delivery`);
    sourceCardId = childTask.id;
    sourceVersionId = version.id;
  }
  const state = data<{ cards: Array<{ versionId: string; deliveryObjectKey: string; actions: string[] }> }>(await f.app.request("GET", `${f.path}/studio-state`));
  assert.equal(state.cards[0].versionId, sourceVersionId);
  assert.deepEqual(await dimensions(f.storage, state.cards[0].deliveryObjectKey), expected);
  assert.deepEqual(state.cards[0].actions, ["change_text"]);
});

test("不加文字的 A+ 批次生成后不提供改字操作", async () => {
  const f = await fixture(["aplus_standard"], undefined, "none");
  data(await f.confirm(), 202);
  assert.equal((await f.waitForRun())?.status, "completed");

  const { cards } = data<{ cards: Array<{ previewUrl: string | null; actions: string[] }> }>(
    await f.app.request("GET", `${f.path}/studio-state`),
  );
  assert.equal(cards.length, modules.length);
  for (const card of cards) {
    assert.ok(card.previewUrl);
    assert.deepEqual(card.actions, []);
  }
});

test("A+ 结果顺序持久化到两端，长图和 ZIP 按该顺序使用交付图", async () => {
  const colors = ["red", "blue", "lime"];
  const f = await fixture(premiumPresets, async (call) => sharp({
    create: { ...fakeSize, channels: 3, background: colors[Math.floor((call - 1) / 2)] },
  }).png().toBuffer());
  data(await f.confirm(), 202);
  assert.equal((await f.waitForRun())?.status, "completed");
  const initialTasks = await f.tasks.listTasks(f.suiteId);
  const thumbnail = async (ordinal: number) => {
    const task = initialTasks.find((item) => item.ordinal === ordinal)!;
    return (await f.tasks.listTaskVersions(task.id)).versions[0].previewUrl;
  };
  const thumbnails = async () => data<{ items: Array<{ thumbnails: string[] }> }>(
    await f.app.request("GET", "/api/suites/feed?origin=aplus"),
  ).items[0].thumbnails;
  assert.deepEqual(await thumbnails(), await Promise.all([1, 2, 3, 4].map(thumbnail)));
  const zipPaths = async () => [...readZipEntries((await f.app.request("GET", `${f.path}/export`)).raw!).keys()];
  const initialPaths = [...premiumPresets.flatMap((preset) => [
    ...modules.map((code, index) => `${preset}/0${index + 1}_${code}.png`),
    `${preset}/long-image.png`,
  ]), "manifest.json"];
  assert.deepEqual(await zipPaths(), initialPaths);
  for (const task of initialTasks) task.sortOrder = task.ordinal;
  assert.deepEqual(await zipPaths(), initialPaths, "历史批次的全局排序号也应导出连续编号");
  const order = (next: string[]) => f.app.request("PATCH", `${f.path}/order`, { body: { modules: next } });
  checkError(await order(["hero", "hero"]), 400, "APLUS_INVALID_MODULES");
  checkError(await order(["hero", "usage_scene"]), 409, "APLUS_RESULT_ORDER_CHANGED");
  const sortedModules = ["usage_scene", "hero", "selling_points"];
  assert.deepEqual(data(await order(sortedModules)), { modules: sortedModules });
  assert.deepEqual(await thumbnails(), await Promise.all([5, 6, 1, 2].map(thumbnail)));
  const tasks = await f.tasks.listTasks(f.suiteId);
  for (const key of premiumPresets) {
    assert.deepEqual(tasks.filter(({ sizePreset }) => sizePreset === key).map(({ sortOrder }) => sortOrder), [2, 3, 1]);
  }
  const studio = data<{ cards: Array<{ moduleCode: string; sizePreset: string; sortOrder: number }> }>(
    await f.app.request("GET", `${f.path}/studio-state`),
  );
  for (const key of premiumPresets) {
    assert.deepEqual(studio.cards.filter(({ sizePreset }) => sizePreset === key).map(({ moduleCode }) => moduleCode), sortedModules);
  }

  checkError(await f.app.request("GET", `${f.path}/long-image?preset=1%3A1`), 400, "APLUS_INVALID_SIZE_PRESETS");
  const exportResult = await f.app.request("GET", `${f.path}/export`);
  assert.equal(exportResult.status, 200);
  assert.equal(exportResult.headers?.["content-type"], "application/zip");
  const zip = readZipEntries(exportResult.raw!);
  const manifest = JSON.parse(zip.get("manifest.json")!.toString());
  assert.deepEqual(manifest.groups.map(({ sizePreset }: { sizePreset: string }) => sizePreset), premiumPresets);
  assert.equal(zip.size, 9);
  for (const [index, preset] of premiumPresets.entries()) {
    const { width, height } = APLUS_SIZE_PRESETS[preset].deliverySize;
    const response = await f.app.request("GET", `${f.path}/long-image?preset=${preset}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers?.["cache-control"], "no-store");
    const { data: pixels, info } = await sharp(response.raw!).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([info.width, info.height], [width, height * 3]);
    const firstPixels = [0, 1, 2].map((slice) => {
      const offset = slice * height * width * info.channels;
      return [...pixels.subarray(offset, offset + 3)];
    });
    assert.deepEqual(firstPixels, [[0, 255, 0], [255, 0, 0], [0, 0, 255]]);
    const group = manifest.groups[index];
    assert.deepEqual(group.longImage, { path: `${preset}/long-image.png`, width, height: height * 3 });
    assert.deepEqual(zip.get(group.longImage.path), response.raw);
    assert.deepEqual(group.items.map(({ moduleCode, sortOrder, generatedSize, deliverySize, path }: typeof group.items[number]) =>
      [moduleCode, sortOrder, generatedSize, deliverySize, path]), sortedModules.map((code, itemIndex) =>
      [code, itemIndex + 1, fakeSize, { width, height }, `${preset}/0${itemIndex + 1}_${code}.png`]));
    for (const item of group.items) {
      const { versions: [version] } = await f.tasks.listTaskVersions(item.taskId);
      assert.deepEqual(zip.get(item.path), (await f.storage.get(version.deliveryObjectKey!))?.bytes);
    }
  }

  const [failed] = tasks;
  await f.tasks.updateTask(failed.id, { status: "failed" });
  const partialZip = readZipEntries((await f.app.request("GET", `${f.path}/export`)).raw!);
  const partial = JSON.parse(partialZip.get("manifest.json")!.toString());
  const failedItem = partial.groups[0].items.find(({ taskId }: { taskId: string }) => taskId === failed.id);
  assert.equal(failedItem.skippedReason, "failed");
  assert.equal(failedItem.path, null);
  assert.deepEqual(partial.groups[0].items.flatMap(({ path }: { path: string | null }) => path ? [path] : []), [
    "aplus_premium_web/01_usage_scene.png", "aplus_premium_web/02_selling_points.png",
  ]);
  assert.equal(partial.groups[0].longImage.height, 1200);
  assert.equal(partial.groups[1].longImage.height, 1350);
});

test("通用比例长图按最宽的交付图等比拼接，ZIP 单图保留各自尺寸", async () => {
  const sizes = [{ width: 64, height: 64 }, { width: 96, height: 96 }, { width: 128, height: 128 }];
  const f = await fixture(["1:1"], async (call) => sharp({
    create: { ...sizes[call - 1], channels: 3, background: "navy" },
  }).png().toBuffer());
  data(await f.confirm(), 202);
  assert.equal((await f.waitForRun())?.status, "completed");
  const response = await f.app.request("GET", `${f.path}/long-image?preset=1%3A1`);
  assert.equal(response.status, 200);
  const { width, height } = await sharp(response.raw!).metadata();
  assert.deepEqual({ width, height }, { width: 128, height: 384 });
  const zip = readZipEntries((await f.app.request("GET", `${f.path}/export`)).raw!);
  const manifest = JSON.parse(zip.get("manifest.json")!.toString());
  for (const [index, item] of manifest.groups[0].items.entries()) {
    assert.deepEqual(item.deliverySize, sizes[index]);
    const { width, height } = await sharp(zip.get(item.path)!).metadata();
    assert.deepEqual({ width, height }, sizes[index]);
  }
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
    const partial = readZipEntries((await f.app.request("GET", `${f.path}/export`)).raw!);
    const manifest = JSON.parse(partial.get("manifest.json")!.toString());
    assert.deepEqual(manifest.groups[0].items.map(({ skippedReason }: { skippedReason: string | null }) => skippedReason), [null, "no_version", "no_version"]);
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

test("无效图片按卡记录中文错误，每卡仅请求一次，手动续跑后整批可完成", async () => {
  let repaired = false;
  const f = await fixture(["aplus_standard"], async () => {
    if (!repaired) throw new Error("INVALID_PROVIDER_RESPONSE");
  });
  data(await f.confirm(), 202);
  const run = await f.waitForRun();
  assert.equal(run?.status, "failed");
  assert.equal(run.errorCode, "INVALID_GENERATED_IMAGE");
  assert.equal(f.calls.length, modules.length);
  const studio = data<{ pipeline: { errorMessage: string }; cards: Array<{ parentTaskId: string; errorMessage: string }> }>(
    await f.app.request("GET", `${f.path}/studio-state`),
  );
  assert.equal(studio.pipeline.errorMessage, "图像生成服务返回了无效图片");
  assert.equal(studio.cards.length, modules.length);
  for (const card of studio.cards) {
    const { attempts } = await f.tasks.listTaskVersions(card.parentTaskId);
    assert.deepEqual(attempts.map(({ errorCode }) => errorCode), ["INVALID_GENERATED_IMAGE"]);
    assert.equal(card.errorMessage, studio.pipeline.errorMessage);
  }
  repaired = true;
  data(await f.app.request("POST", `${f.path}/resume`, { headers: { "idempotency-key": "resume" } }), 202);
  assert.equal((await f.waitForRun())?.status, "completed");
  assert.equal(f.calls.length, 2 * modules.length);
});

test("图片 URL 连续返回 503 时每张只重试下载，批次不再请求付费生图", async (t) => {
  const provider = new GptImageProvider("https://provider.example.test/v1", "fake");
  let posts = 0;
  let gets = 0;
  t.mock.method(globalThis, "fetch", async (_url, init: RequestInit) => {
    if (init.method === "POST") {
      posts++;
      return Response.json({ data: [{ url: "https://cdn.example.test/result" }] });
    }
    gets++;
    return new Response(null, { status: 503 });
  });
  const f = await fixture(["aplus_standard"], async (_call, request) => (await provider.edit(request)).bytes);
  data(await f.confirm(), 202);
  const run = await f.waitForRun();
  assert.equal(run?.status, "failed");
  assert.equal(run.errorCode, "TASK_IMAGE_PROVIDER_FAILED");
  assert.equal(posts, modules.length);
  assert.equal(gets, 2 * modules.length);
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
