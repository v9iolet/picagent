import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import sharp from "sharp";
import { isAplusPlanStale, APLUS_MODULES } from "../shared/aplus.js";
import { emptyProductCardFields } from "../shared/product-card.js";
import { createAplusPlanningApi } from "../server/aplus/aplus-planning-api.js";
import { readAplusRunConfig } from "../server/aplus/aplus-plan.js";
import { createSuiteStudioApp } from "../server/app.js";
import type { AppResponse } from "../server/api-response.js";
import { parseNormalizedPromptMarkdown } from "../server/prompt-library.js";
import { buildPlanUserContent } from "../server/providers/dashscope-llm-client.js";
import { MemoryPipelineRepository } from "../server/repositories/memory-pipeline-repository.js";
import { MemoryPlatformRepository } from "../server/repositories/memory-platform-repository.js";
import { MemoryProductCardRepository } from "../server/repositories/memory-product-card-repository.js";
import { MemoryPromptRepository } from "../server/repositories/memory-prompt-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";
import { waitUntil } from "../server/suite-pipeline.js";
import type { AplusAiWriteLlmInput, PlanLlmInput } from "../server/types.js";

const headers = { "Idempotency-Key": "aplus-create" };
const presets = ["aplus_premium_web", "aplus_premium_mobile"];
const picture = "服务端保留的画面要求";

function modelOutput(modules = ["hero", "selling_points", "usage_scene"], sizePresets = presets) {
  return {
    schemaVersion: "aplus-plan-v1",
    taskName: "随行杯详情",
    globalPlan: "蓝白配色，明亮光线",
    modules: modules.map((moduleCode) => ({
      moduleCode,
      copyRequirements: "随行好握",
      imagePrompts: Object.fromEntries(sizePresets.map((preset) => [preset, picture + preset])),
    })),
  };
}

const promptDir = new URL("../prompt/normalized/", import.meta.url);
const promptFiles = (await readdir(promptDir)).filter((name) => name.startsWith("aplus-"));
const promptRecords = await Promise.all(promptFiles.map(async (name) =>
  parseNormalizedPromptMarkdown(await readFile(new URL(name, promptDir), "utf8"), "prompt/normalized/" + name)));

function data<T>(response: AppResponse): T {
  assert.ok("data" in response.body, JSON.stringify(response.body));
  return response.body.data as T;
}

function error(response: AppResponse, code: string, status: number) {
  assert.equal(response.status, status);
  assert.ok("error" in response.body);
  assert.equal(response.body.error.code, code);
}

async function fixture(
  generate: (input: PlanLlmInput, call: number) => unknown = () => modelOutput(),
  write: (input: AplusAiWriteLlmInput) => unknown = () => "",
) {
  const repository = new MemorySuiteRepository();
  const pipelineRepository = new MemoryPipelineRepository();
  const storage = new MemoryStorage();
  const productCards = new MemoryProductCardRepository();
  const prompts = new MemoryPromptRepository();
  const imported = await prompts.importRecords(promptRecords);
  for (const prompt of imported) await prompts.publishVersion(prompt.templateVersionId);
  const base = {
    mainImageBackground: "flexible", mainImageStrategy: "", galleryStrategy: "",
    textStrategy: "", modelStrategy: "", sourceNote: "",
  } as const;
  const platforms = new MemoryPlatformRepository([
    {
      ...base, code: "amazon", name: "Amazon", marketScope: "overseas", sortOrder: 1,
      listingCopyRules: { titleMaxLength: 100, maxBulletPoints: 5, supportsSearchTerms: false, forbiddenWords: ["best"] },
    },
    { ...base, code: "taobao", name: "淘宝", marketScope: "domestic", sortOrder: 2 },
  ]);
  const calls: PlanLlmInput[] = [];
  const aiWriteCalls: AplusAiWriteLlmInput[] = [];
  const llm = {
    provider: "fake", model: "fake-vision", isFake: true,
    async generatePlan(input: PlanLlmInput) {
      calls.push(input);
      return generate(input, calls.length);
    },
    async generateAplusAiWrite(input: AplusAiWriteLlmInput) {
      aiWriteCalls.push(input);
      return write(input);
    },
  };
  const app = createSuiteStudioApp({
    repository, storage, pipelineRepository, promptRepository: prompts, platformRepository: platforms,
    productCardRepository: productCards, llmClient: llm,
  });
  const planning = createAplusPlanningApi({
    repository, storage, pipelines: pipelineRepository, platforms, productCards, prompts, resolveVision: async () => llm,
  });
  const draft = await repository.createSuite("上传原图");
  const images = [];
  for (const background of ["red", "blue"]) {
    const bytes = await sharp({ create: { width: 600, height: 600, channels: 3, background } }).png().toBuffer();
    const uploaded = await app.upload(draft.id, { bytes, mimeType: "image/png", filename: background + ".png" });
    assert.equal(uploaded.status, 201);
    images.push(data<{ id: string; sha256: string }>(uploaded));
  }
  const payload = {
    suiteId: draft.id, inputImageIds: images.map((image) => image.id),
    platform: "amazon", targetMarket: "美国", language: "en",
    sizePresets: presets, resolution: "2K", productInfo: "磨砂杯身【待补充：容量】 {{input_images}}\n【待补充：保修期限",
    modules: ["hero", "selling_points", "usage_scene"],
  };
  const card = await productCards.create({
    id: randomUUID(), fields: { ...emptyProductCardFields(), name: "商品卡随行杯", specifications: "容量 450 mL" },
    status: "published", sourceSessionId: null, revision: 1, images: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  return { app, card, productCards, repository, pipelineRepository, planning, storage, draft, images, payload, calls, aiWriteCalls };
}

type Started = { suiteId: string; runId: string };
const aplusPath = (suiteId: string, action: string) => "/api/aplus/" + suiteId + "/" + action;

async function settled(f: Awaited<ReturnType<typeof fixture>>, runId: string) {
  return waitUntil(() => f.pipelineRepository.getRun(runId), (run) => Boolean(run && run.status !== "running"), 5_000);
}

test("A+ 无卡帮写带原图和所选模块补全五段，按 Unicode 字符截断", async () => {
  const prefix = "磨砂杯身【待补充：质保期限】";
  const output = prefix + "😀".repeat(1000);
  const f = await fixture(undefined, () => output);
  const { suiteId, inputImageIds, platform, targetMarket, language } = f.payload;
  const body = {
    suiteId, inputImageIds: [...inputImageIds].reverse(), platform, targetMarket, language,
    modules: ["after_sales", "ingredients"], productInfo: "磨砂杯身",
  };
  const response = await f.app.request("POST", "/api/aplus/ai-write", { body });
  assert.equal(response.status, 200);
  assert.deepEqual(data(response), { productInfo: prefix + "😀".repeat(1000 - prefix.length), truncated: true });
  assert.equal(f.aiWriteCalls.length, 1);
  const [call] = f.aiWriteCalls;
  assert.match(call.userPrompt, /未选商品卡，写五段基本信息并补充模块所需信息/);
  assert.match(call.userPrompt, /当前商品卖点与生成要求：磨砂杯身/);
  assert.match(call.userPrompt, /商品卡事实：无/);
  assert.match(call.userPrompt, /目标平台：amazon\n目标市场：美国\n画面文字语言：en/);
  assert.match(call.templateBody, /产品名称.*核心卖点.*适用人群.*期望场景.*具体参数/);
  assert.match(call.templateBody, /【待补充：质保期限】/);
  assert.deepEqual([...call.templateBody.matchAll(/^模块代码：(.+)$/gm)].map(([, code]) => code), body.modules);
  assert.deepEqual(call.visionImages.map(({ id }) => id), body.inputImageIds);
  for (const image of call.visionImages) {
    const input = await f.repository.getInputImage(suiteId, image.id);
    assert.ok(input);
    const object = await f.storage.get(input.originalObjectKey.replace(/\/original$/, "/generation-input.jpg"));
    assert.deepEqual(image.bytes, object?.bytes);
  }
  assert.equal((await f.repository.listSuites()).length, 1);
  assert.equal(f.calls.length, 0);
});

test("A+ 有卡帮写读取当前已发布版本，仅要求补充缺失事实，允许返回空文本", async () => {
  const f = await fixture();
  await f.productCards.update(f.card.id, {
    fields: { ...f.card, specifications: "容量 520 mL" }, images: [], updatedAt: new Date().toISOString(),
  });
  const published = await f.productCards.get(f.card.id);
  assert.equal(published?.revision, 2);
  const body = { ...f.payload, productCardId: f.card.id, productInfo: "", modules: ["size_spec"] };
  const response = await f.app.request("POST", "/api/aplus/ai-write", { body });
  assert.equal(response.status, 200);
  assert.deepEqual(data(response), { productInfo: "", truncated: false });
  assert.equal(f.aiWriteCalls.length, 1);
  const [call] = f.aiWriteCalls;
  assert.match(call.userPrompt, /已选商品卡，只写补充说明/);
  assert.match(call.userPrompt, /商品卡随行杯/);
  assert.match(call.userPrompt, /容量 520 mL/);
  assert.doesNotMatch(call.userPrompt, /450 mL/);
  assert.match(call.templateBody, /所选模块需要、商品卡未包含的信息/);
  assert.match(call.templateBody, /不要重复商品卡事实/);
  assert.deepEqual([...call.templateBody.matchAll(/^模块代码：(.+)$/gm)].map(([, code]) => code), body.modules);
  assert.deepEqual(await f.productCards.get(f.card.id), published);
});

test("A+ 帮写拒绝无原图、无所选模块、未发布商品卡等无效请求", async () => {
  const f = await fixture();
  await f.productCards.setStatus(f.card.id, "archived", new Date().toISOString());
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ inputImageIds: undefined }, "APLUS_INVALID_INPUT_IMAGES"],
    [{ inputImageIds: [] }, "APLUS_INVALID_INPUT_IMAGES"],
    [{ inputImageIds: [randomUUID()] }, "APLUS_INVALID_INPUT_IMAGES"],
    [{ inputImageIds: [f.images[0].id, f.images[0].id] }, "APLUS_INVALID_INPUT_IMAGES"],
    [{ modules: [] }, "APLUS_INVALID_MODULES"],
    [{ productInfo: "😀".repeat(1001) }, "APLUS_INVALID_PRODUCT_INFO"],
    [{ productCardId: f.card.id }, "PRODUCT_CARD_NOT_AVAILABLE"],
  ];
  for (const [change, code] of cases) {
    error(await f.app.request("POST", "/api/aplus/ai-write", { body: { ...f.payload, ...change } }), code, 400);
  }
  assert.equal(f.aiWriteCalls.length, 0);
});

test("A+ 规划提交校验原图、商品卡、卖点、平台、尺寸、模块、市场、语言和分辨率", async () => {
  const f = await fixture();
  const cases: Array<[Record<string, unknown>, string, number?]> = [
    [{ inputImageIds: [] }, "APLUS_INVALID_INPUT_IMAGES"],
    [{ inputImageIds: null }, "APLUS_INVALID_INPUT_IMAGES"],
    [{ inputImageIds: Array.from({ length: 7 }, () => randomUUID()) }, "APLUS_INVALID_INPUT_IMAGES"],
    [{ inputImageIds: [randomUUID()] }, "APLUS_INVALID_INPUT_IMAGES"],
    [{ inputImageIds: [f.images[0].id, f.images[0].id] }, "APLUS_INVALID_INPUT_IMAGES"],
    [{ suiteId: randomUUID() }, "INVALID_SUITE_ID", 404],
    [{ productCardId: randomUUID() }, "PRODUCT_CARD_NOT_AVAILABLE", 404],
    [{ productCardId: {} }, "PRODUCT_CARD_NOT_AVAILABLE"],
    [{ productInfo: "😀".repeat(1001) }, "APLUS_INVALID_PRODUCT_INFO"],
    [{ productInfo: 123 }, "APLUS_INVALID_PRODUCT_INFO"],
    [{ productInfo: "  " }, "APLUS_PRODUCT_INFO_REQUIRED"],
    [{ modules: [] }, "APLUS_INVALID_MODULES"],
    [{ modules: APLUS_MODULES.slice(0, 11).map(({ code }) => code) }, "APLUS_INVALID_MODULES"],
    [{ modules: ["hero", "hero"] }, "APLUS_INVALID_MODULES"],
    [{ modules: ["unknown"] }, "APLUS_INVALID_MODULES"],
    [{ platform: "unknown" }, "PLATFORM_NOT_FOUND"],
    [{ platform: "taobao" }, "APLUS_INVALID_SIZE_PRESETS"],
    [{ sizePresets: [] }, "APLUS_INVALID_SIZE_PRESETS"],
    [{ sizePresets: ["aplus_standard", "1:1"] }, "APLUS_INVALID_SIZE_PRESETS"],
    [{ sizePresets: ["aplus_premium_web", "1:1"] }, "APLUS_INVALID_SIZE_PRESETS"],
    [{ sizePresets: ["aplus_premium_web", "aplus_premium_web"] }, "APLUS_INVALID_SIZE_PRESETS"],
    [{ targetMarket: "" }, "APLUS_TARGET_MARKET_REQUIRED"],
    [{ language: "unsupported" }, "APLUS_INVALID_LANGUAGE"],
    [{ resolution: "4K" }, "APLUS_INVALID_RESOLUTION"],
  ];
  for (const [change, code, status = 400] of cases) {
    error(await f.app.request("POST", "/api/aplus", { headers, body: { ...f.payload, ...change } }), code, status);
  }
  await f.productCards.setStatus(f.card.id, "archived", new Date().toISOString());
  error(await f.app.request("POST", "/api/aplus", { headers, body: { ...f.payload, productCardId: f.card.id } }), "PRODUCT_CARD_NOT_AVAILABLE", 400);
  error(await f.app.request("POST", "/api/aplus", { body: f.payload }), "MISSING_IDEMPOTENCY_KEY", 400);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.repository.listSuites()).length, 1);
});

test("A+ 只规划一次，冻结商品卡和有序原图，并且各状态入口均隐藏画面要求", async () => {
  let complete!: () => void;
  const gate = new Promise<void>((resolve) => { complete = resolve; });
  const f = await fixture(async () => { await gate; return { ...modelOutput(), taskName: "" }; });
  const body = { ...f.payload, productCardId: f.card.id, inputImageIds: [...f.payload.inputImageIds].reverse() };
  const [first, duplicate] = await Promise.all([
    f.app.request("POST", "/api/aplus", { headers, body }),
    f.app.request("POST", "/api/aplus", { headers, body }),
  ]);
  assert.equal(first.status, 202);
  const batch = data<Started>(first);
  assert.deepEqual(data(duplicate), batch);
  const running = await f.app.request("GET", aplusPath(batch.suiteId, "studio-state"));
  assert.equal(data<{ phase: string }>(running).phase, "aplus_planning");
  error(await f.app.request("PATCH", aplusPath(batch.suiteId, "plan"), { body: { modules: [] } }), "APLUS_PLAN_ACTION_NOT_ALLOWED", 409);

  await f.productCards.update(f.card.id, {
    fields: { ...f.card, name: "后来改名" }, images: [], updatedAt: new Date().toISOString(),
  });
  complete();
  assert.equal((await settled(f, batch.runId))?.currentPhase, "awaiting_confirmation");
  assert.equal(f.calls.length, 1);
  assert.equal((await f.repository.getSuite(batch.suiteId))?.name, f.card.name);
  assert.equal((await f.repository.getSuite(batch.suiteId))?.origin, "aplus");
  assert.deepEqual(data(await f.app.request("POST", "/api/aplus", { headers, body: {} })), batch);
  const [call] = f.calls;
  assert.equal(call.flow, "aplus-plan");
  assert.deepEqual([...call.templateBody.matchAll(/^模块代码：(.+)$/gm)].map(([, code]) => code), f.payload.modules);
  assert.match(call.userPrompt ?? "", /商品卡随行杯/);
  assert.match(call.userPrompt ?? "", /容量 450 mL/);
  assert.match(call.userPrompt ?? "", /"forbiddenWords":\["best"\]/);
  assert.match(call.userPrompt ?? "", /磨砂杯身 \{\{input_images\}\}/);
  assert.deepEqual(buildPlanUserContent(call)[0], { type: "text", text: call.userPrompt });
  assert.doesNotMatch(call.userPrompt ?? "", /待补充|后来改名/);
  assert.equal(call.visionImages?.length, 2);
  const copied = await f.repository.getInputImages(batch.suiteId);
  assert.deepEqual(copied.map((image) => image.sha256), [...f.images].reverse().map((image) => image.sha256));
  assert.deepEqual(call.inputImageIds, copied.map((image) => image.id));
  for (const miniature of call.visionImages ?? []) {
    const dimensions = await sharp(miniature.bytes).metadata();
    assert.ok(dimensions.width <= 420 && dimensions.height <= 280);
  }
  const run = await f.pipelineRepository.getRun(batch.runId);
  assert.ok(run);
  const config = readAplusRunConfig(run);
  assert.equal(config?.productCardSnapshot?.revision, 1);
  assert.equal(config?.planSnapshot?.templateVersionId, call.templateVersionId);
  assert.equal(Object.keys(config?.planSnapshot?.moduleRuleVersionIds ?? {}).length, f.payload.modules.length);
  for (const path of [aplusPath(batch.suiteId, "studio-state"), "/api/suites/" + batch.suiteId + "/studio-state", "/api/suites/feed?origin=aplus"]) {
    const response = await f.app.request("GET", path);
    assert.equal(response.status, 200);
    assert.doesNotMatch(JSON.stringify(response.body), /imagePrompts|服务端保留的画面要求/);
  }
});

test("A+ 无文字规划拒绝错误模块、尺寸和文案，失败后可用原输入重试", async () => {
  const valid = modelOutput();
  for (const module of valid.modules) module.copyRequirements = "";
  const invalid = [
    { ...valid, schemaVersion: "wrong" },
    { ...valid, taskName: "长".repeat(21) },
    { ...valid, globalPlan: " " },
    { ...valid, modules: [valid.modules[0], valid.modules[0], valid.modules[2]] },
    { ...valid, modules: [valid.modules[0], valid.modules[1], { ...valid.modules[2], moduleCode: "brand_story" }] },
    { ...valid, modules: [valid.modules[0], valid.modules[1], { ...valid.modules[2], imagePrompts: { aplus_premium_web: picture } }] },
    { ...valid, modules: [valid.modules[0], valid.modules[1], { ...valid.modules[2], copyRequirements: "非空文案" }] },
  ];
  const f = await fixture((_input, call) => invalid[call - 1] ?? { ...valid, taskName: "" });
  const first = await f.app.request("POST", "/api/aplus", { headers, body: { ...f.payload, language: "none" } });
  const batch = data<Started>(first);
  assert.equal(first.status, 202);
  for (const [index] of invalid.entries()) {
    const run = await settled(f, batch.runId);
    assert.equal(run?.status, "failed");
    assert.equal(run.errorCode, "APLUS_PLAN_OUTPUT_INVALID");
    assert.equal(run.currentPhase, "aplus_planning");
    if (index === 0) {
      const deleted = await f.app.request("DELETE", "/api/suites/" + f.draft.id + "/input-images/" + f.images[0].id);
      assert.equal(deleted.status, 200);
    }
    const retry = { headers: { "Idempotency-Key": "retry-" + index } };
    const results = await Promise.all([
      f.app.request("POST", aplusPath(batch.suiteId, "resume"), retry),
      f.app.request("POST", aplusPath(batch.suiteId, "resume"), retry),
    ]);
    assert.deepEqual(results.map((result) => data(result)), [batch, batch]);
  }
  assert.equal((await settled(f, batch.runId))?.currentPhase, "awaiting_confirmation");
  assert.equal(f.calls.length, invalid.length + 1);
  assert.match((await f.repository.getSuite(batch.suiteId))?.name ?? "", /^A\+ · \d{2}-\d{2} \d{2}:\d{2}$/);
  error(await f.app.request("PATCH", aplusPath(batch.suiteId, "plan"), {
    body: { modules: [{ moduleCode: "hero", copyRequirements: "不要保存" }] },
  }), "APLUS_INVALID_PLAN_EDIT", 400);
});

test("A+ 方案可编辑文案、顺序及模块取舍，重新规划使用新批次和新输入", async () => {
  const f = await fixture((_input, call) => call === 1 ? modelOutput() : modelOutput(["hero"], ["1:1"]));
  const first = data<Started>(await f.app.request("POST", "/api/aplus", { headers, body: { ...f.payload, productCardId: f.card.id, productInfo: "" } }));
  await settled(f, first.runId);
  const planPath = aplusPath(first.suiteId, "plan");
  for (const edit of [
    [],
    [{ moduleCode: "brand_story" }],
    [{ moduleCode: "hero" }, { moduleCode: "hero" }],
    [{ moduleCode: "hero", imagePrompts: {} }],
    [{ moduleCode: "hero", copyRequirements: null }],
  ]) {
    error(await f.app.request("PATCH", planPath, { body: { modules: edit } }), "APLUS_INVALID_PLAN_EDIT", 400);
  }
  const edited = await f.app.request("PATCH", planPath, {
    body: { modules: [{ moduleCode: "usage_scene", copyRequirements: "日常通勤" }, { moduleCode: "hero" }] },
  });
  assert.equal(edited.status, 200);
  assert.deepEqual(data<{ modules: unknown }>(edited).modules, [
    { moduleCode: "usage_scene", copyRequirements: "日常通勤" },
    { moduleCode: "hero", copyRequirements: "随行好握" },
  ]);
  error(await f.app.request("PATCH", planPath, { body: { modules: [{ moduleCode: "selling_points" }] } }), "APLUS_INVALID_PLAN_EDIT", 400);
  const editedRun = await f.pipelineRepository.getRun(first.runId);
  assert.ok(editedRun);
  assert.equal(readAplusRunConfig(editedRun)?.planSnapshot?.modules[0].imagePrompts.aplus_premium_web, picture + "aplus_premium_web");
  const confirmable = await f.planning.prepareConfirmation(first.suiteId, { ...f.payload, productCardId: f.card.id, productInfo: "", resolution: "1K" });
  assert.equal(confirmable.ok, true);

  const replanPath = aplusPath(first.suiteId, "replan");
  const { suiteId: _draftId, inputImageIds: _imageIds, ...settings } = f.payload;
  const input = { ...settings, platform: "taobao", targetMarket: "中国", modules: ["hero"], sizePresets: ["1:1"] };
  const next = data<Started>(await f.app.request("POST", replanPath, { headers, body: input }));
  assert.notEqual(next.suiteId, first.suiteId);
  assert.notEqual(next.runId, first.runId);
  await settled(f, next.runId);
  assert.deepEqual(data(await f.app.request("POST", replanPath, { headers, body: {} })), next);
  assert.deepEqual((await f.repository.getInputImages(next.suiteId)).map((image) => image.sha256), f.images.map((image) => image.sha256));
  assert.deepEqual(data<{ inputSnapshot: { modules: string[] } }>(await f.app.request("GET", aplusPath(next.suiteId, "studio-state"))).inputSnapshot.modules, ["hero"]);
  assert.deepEqual(data<{ modules: unknown }>(await f.app.request("GET", aplusPath(first.suiteId, "studio-state"))).modules, data<{ modules: unknown }>(edited).modules);
});

test("A+ 确认前重新读取原图和商品卡版本，比较所有失效字段并允许改分辨率", async () => {
  const f = await fixture();
  const body = { ...f.payload, productCardId: f.card.id };
  const batch = data<Started>(await f.app.request("POST", "/api/aplus", { headers, body }));
  await settled(f, batch.runId);
  const compare = (change: Record<string, unknown>) => f.planning.prepareConfirmation(batch.suiteId, { ...body, ...change });
  const prepared = await compare({ resolution: "1K", modules: [...body.modules].reverse(), sizePresets: [...body.sizePresets].reverse() });
  assert.ok(prepared.ok);
  assert.equal(prepared.value.resolution, "1K");
  const summary = prepared.value.config.inputSnapshot;
  const current = { ...summary, resolution: "1K" };
  assert.equal(isAplusPlanStale(summary, current), false);
  const changes = [
    [{ inputImageIds: [...body.inputImageIds].reverse() }, { imageHashes: [...summary.imageHashes].reverse() }],
    [{ productInfo: "替换卖点" }, { productInfo: "替换卖点" }],
    [{ productCardId: null }, { productCardId: null, productCardRevision: null }],
    [{ productCardRevision: 3 }, { productCardRevision: 3 }],
    [{ platform: "taobao", sizePresets: ["1:1"] }, { platform: "taobao" }],
    [{ targetMarket: "日本" }, { targetMarket: "日本" }],
    [{ language: "none" }, { language: "none" }],
    [{ sizePresets: ["aplus_premium_web"] }, { sizePresets: ["aplus_premium_web"] }],
    [{ modules: ["hero"] }, { modules: ["hero"] }],
  ] as const;
  for (const [change, summaryChange] of changes) {
    const attempt = await compare(change);
    assert.equal(attempt.ok, false);
    if (!attempt.ok) error(attempt.response, "APLUS_PLAN_STALE", 409);
    assert.equal(isAplusPlanStale(summary, {
      ...summary, ...summaryChange,
      modules: "modules" in summaryChange ? [...summaryChange.modules] : summary.modules,
      sizePresets: "sizePresets" in summaryChange ? [...summaryChange.sizePresets] : summary.sizePresets,
    }), true);
  }
  await f.productCards.update(f.card.id, { fields: { ...f.card, name: "更新后名称" }, images: [], updatedAt: new Date().toISOString() });
  const stale = await compare({});
  assert.ok(!stale.ok);
  error(stale.response, "APLUS_PLAN_STALE", 409);
});
