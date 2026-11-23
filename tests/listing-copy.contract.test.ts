import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { parseNormalizedPromptMarkdown, validatePromptTemplateContract } from "../server/prompt-library.js";
import { createSuiteStudioApp, type AppResponse } from "../server/app.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryPromptRepository } from "../server/repositories/memory-prompt-repository.js";
import type { PlanLlmInput } from "../server/types.js";
import sharp from "sharp";
import { dispatchInputImageUpload } from "../server/multipart.js";
import { MemoryTaskRepository } from "../server/repositories/memory-task-repository.js";
import { MemoryPlanRepository } from "../server/repositories/memory-plan-repository.js";
import { evaluateListingWarnings } from "../shared/listing-config.js";
import type { ListingRules } from "../shared/listing-config.js";
import { DETAIL_CATEGORY_CODES } from "../shared/suite-categories.js";

async function template(name: string) {
  return parseNormalizedPromptMarkdown(
    await readFile(new URL(`../prompt/normalized/${name}.md`, import.meta.url), "utf8"),
    name,
  );
}

test("listing_copy 模板声明视觉输入、平台规则和独立的输出契约", async () => {
  const record = await template("general-listing-copy");
  assert.equal(record.stage, "listing_copy");
  assert.equal(record.code, "general.listing-copy");
  assert.deepEqual(record.outputSchema.required, ["schemaVersion", "title", "bulletPoints", "description", "missingFacts"]);
  assert.deepEqual(Object.keys(record.outputSchema.properties as object), [
    "schemaVersion", "title", "bulletPoints", "description", "missingFacts", "itemHighlights", "searchTerms",
    "tags", "seoTitle", "seoDescription", "subtitle", "hashtags",
  ]);
  assert.match(record.body, /`schemaVersion`：固定字符串 `"listing-copy-v1"`，必填/);
  for (const [key, type] of [
    ["title", "字符串"], ["bulletPoints", "字符串数组"], ["description", "字符串"], ["missingFacts", "字符串数组"],
  ]) {
    assert.ok(record.body.includes(`\`${key}\`：${type}，必填`), key);
  }
  for (const [key, type] of [
    ["itemHighlights", "字符串"], ["searchTerms", "字符串数组"], ["tags", "字符串数组"],
    ["seoTitle", "字符串"], ["seoDescription", "字符串"], ["subtitle", "字符串"], ["hashtags", "字符串数组"],
  ]) {
    assert.ok(record.body.includes(`\`${key}\`：${type}，可选`), key);
  }
  assert.match(record.body, /`searchTerms`：[^\n]+UTF-8 字节数[^\n]+`searchTermsMaxBytes`/);
  assert.match(record.body, /`hashtags`：[^\n]+每项以 `#` 开头/);
  assert.throws(() => validatePromptTemplateContract({ ...record, inputSchema: [] }));
  assert.throws(() => validatePromptTemplateContract({ ...record, executionTarget: "image_model" }));
});

const root = "/api/listing-copies";
const content = {
  schemaVersion: "listing-copy-v1",
  title: "杯子",
  description: "",
  bulletPoints: [],
  searchTerms: ["杯"],
  missingFacts: ["容量"],
};
const commonRules = { titleMaxLength: 80, maxBulletPoints: 5, supportsSearchTerms: false, forbiddenWords: ["best seller"] };
const domesticRules = { ...commonRules, titleMaxLength: 30, maxBulletPoints: 3 };
const platformRules: Record<string, ListingRules> = {
  amazon: { ...commonRules, titleMaxLength: 75, supportsSearchTerms: true, itemHighlightsMaxLength: 125, searchTermsMaxBytes: 250 },
  etsy: { ...commonRules, titleMaxLength: 140, maxTags: 13, tagMaxLength: 20 },
  shopify: { ...commonRules, titleMaxLength: 70, seoTitleMaxLength: 60, seoDescriptionMaxLength: 160 },
  walmart: { ...commonRules, titleMaxLength: 75 },
  ebay: commonRules,
  temu: commonRules,
  tiktok_shop: { ...commonRules, titleMaxLength: 100 },
  shopee: { ...commonRules, titleMaxLength: 100 },
  lazada: { ...commonRules, titleMaxLength: 100 },
  aliexpress: { ...commonRules, titleMaxLength: 100 },
  taobao: { ...domesticRules, subtitleMaxLength: 40 },
  pinduoduo: { ...domesticRules, subtitleMaxLength: 40 },
  "1688": { ...domesticRules, subtitleMaxLength: 40 },
  jd: { ...domesticRules, titleMaxLength: 60, subtitleMaxLength: 40 },
  douyin: { ...domesticRules, maxHashtags: 10 },
  xiaohongshu: { ...domesticRules, titleMaxLength: 20, maxHashtags: 10 },
};
function data(res: AppResponse, expected: number): any {
  assert.equal(res.status, expected, JSON.stringify(res.body));
  assert.ok("data" in res.body);
  return res.body.data;
}
async function eventual<T>(load: () => Promise<T>, matches: (x: T) => boolean): Promise<T> {
  const end = Date.now() + 3000;
  for (;;) {
    const x = await load();
    if (matches(x)) return x;
    assert.ok(Date.now() < end, `unexpected state: ${JSON.stringify(x)}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
async function fixture(generatePlan: (input: PlanLlmInput) => Promise<unknown>, extra = {}) {
  const repository = new MemorySuiteRepository(),
    storage = new MemoryStorage(),
    prompts = new MemoryPromptRepository();
  for (const name of ["general-listing-copy", "general-structure-plan-groups", "general-category-prompt-groups"]) {
    const [v] = await prompts.importRecords([await template(name)]);
    await prompts.publishVersion(v.templateVersionId);
  }
  const bytes = await sharp({ create: { width: 12, height: 12, channels: 3, background: "white" } })
    .png()
    .toBuffer();
  const app = createSuiteStudioApp({
    repository,
    storage,
    promptRepository: prompts,
    platformRepository: {
      async listEnabled() {
        return [];
      },
      async find(code) {
        return {
          code,
          name: code,
          marketScope: "overseas",
          mainImageBackground: "flexible",
          mainImageStrategy: "",
          galleryStrategy: "",
          textStrategy: "",
          modelStrategy: "",
          sourceNote: "",
          sortOrder: 1,
          listingCopyRules: platformRules[code],
        };
      },
    },
    llmClient: {
      provider: "fake",
      model: "test-vision",
      channel: { channelId: "vision-fixture", channelName: "测试视觉", baseUrl: "https://vision.invalid/" },
      isFake: true,
      generatePlan,
    },
    ...extra,
  });
  const req = async (m: string, path: string, body?: unknown, status = 200) =>
    data(await app.request(m, path, { body }), status);
  const upload = (id: string) =>
    req("POST", `${root}/${id}/input-images`, { filename: "cup.png", bytes, mimeType: "image/png" }, 201);
  return { app, repository, storage, bytes, req, upload };
}

test("Amazon 超限文案照常生成并保存，返回字符、字节与条数警告和原图快照", async () => {
  const calls: PlanLlmInput[] = [];
  const output = {
    ...content,
    title: "😀".repeat(76),
    itemHighlights: "A".repeat(126),
    bulletPoints: Array(6).fill("point"),
    searchTerms: ["杯".repeat(83), "茶"],
  };
  const f = await fixture(async (input) => {
    calls.push(input);
    return output;
  });
  const draft = await f.upload("draft"),
    path = `${root}/${draft.id}`;
  assert.deepEqual((await f.req("GET", root)).items, []);
  await f.req(
    "POST",
    path + "/generate",
    { platform: "amazon", targetMarket: "US", outputLanguage: "English", sellingPoints: "白色杯子" },
    202,
  );
  const job = await eventual(
    () => f.req("GET", path),
    (j) => j.status === "succeeded",
  );
  const first = job.versions[0];
  assert.deepEqual(first.content, output);
  assert.deepEqual(evaluateListingWarnings(first.content, first.promptSnapshot.input.listing_copy_rules), [
    { field: "title", actual: 76, limit: 75, unit: "characters" },
    { field: "bulletPoints", actual: 6, limit: 5, unit: "items" },
    { field: "itemHighlights", actual: 126, limit: 125, unit: "characters" },
    { field: "searchTerms", actual: 253, limit: 250, unit: "bytes" },
  ]);
  const edited = await f.req("PUT", path, { content: { itemHighlights: "B".repeat(127) } });
  assert.equal(edited.versions[1].content.itemHighlights.length, 127);
  assert.deepEqual(edited.versions[0], first);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].visionImages?.[0].bytes, f.bytes);
  assert.equal(calls[0].dynamicInput.selling_points, "白色杯子");
  const snap = first.promptSnapshot;
  assert.equal(snap.templateVersionId, calls[0].templateVersionId);
  assert.equal(snap.model.model, "test-vision");
  assert.equal(snap.model.channel.channelId, "vision-fixture");
  assert.deepEqual(snap.input.image_ids, [draft.inputImages[0].id]);
  assert.equal(snap.input.images[0].sha256, draft.inputImages[0].sha256);
  assert.equal(snap.input.target_market, "US");
  assert.equal(snap.input.output_language, "English");
  assert.equal((await f.req("GET", root + "?limit=1&offset=0")).items[0].id, job.id);
});

test("模型省略版本和描述并返回字符串搜索词时，生成和重生成仍保存文案及超限警告", async () => {
  const legacyOutput = {
    title: "杯子",
    bulletPoints: "- 白色\r\n\n• 折叠手柄\n3. 带杯盖\n（4）易收纳",
    searchTerms: `  ${"杯".repeat(83)} 茶,\n 水杯  `,
    missingFacts: null,
    itemHighlights: null,
    tags: ["无关标签"],
    metadata: { source: "model" },
    ["__proto__"]: { subtitle: "无关副标题" },
  };
  let output: unknown = legacyOutput;
  const f = await fixture(async () => output);
  const draft = await f.upload("draft");
  const path = `${root}/${draft.id}`;
  const expected = {
    schemaVersion: "listing-copy-v1",
    title: "杯子",
    description: "",
    bulletPoints: ["白色", "折叠手柄", "带杯盖", "易收纳"],
    searchTerms: ["杯".repeat(83), "茶", "水杯"],
    missingFacts: [],
  };
  await f.req("POST", `${path}/generate`, { platform: "amazon" }, 202);
  const generated = await eventual(() => f.req("GET", path), (j) => j.status === "succeeded");
  assert.deepEqual(generated.versions[0].content, expected);
  assert.deepEqual(evaluateListingWarnings(generated.versions[0].content, platformRules.amazon), [
    { field: "searchTerms", actual: 260, limit: 250, unit: "bytes" },
  ]);

  output = { ...legacyOutput, type: "listing-copy-v1" };
  await f.req("POST", `${path}/regenerate`, {}, 202);
  const regenerated = await eventual(() => f.req("GET", path), (j) => j.status === "succeeded");
  assert.equal(regenerated.versions.length, 2);
  assert.deepEqual(regenerated.versions[0], generated.versions[0]);
  assert.deepEqual(regenerated.versions[1].content, expected);
});

test("生成文案在拆分和丢弃字段之前仍拦截禁用词，并记录安全的失败摘要", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  let output: unknown = content;
  const f = await fixture(async () => output);
  const draft = await f.upload("draft");
  const path = `${root}/${draft.id}`;
  for (const [platform, fields] of [
    ["amazon", { searchTerms: "cup Ｂｅｓｔ Ｓｅｌｌｅｒ mug" }],
    ["amazon", { searchTerms: "cup best,\n seller mug" }],
    ["taobao", { searchTerms: "cup best seller mug" }],
    ["taobao", { searchTerms: "cup best,\n seller mug" }],
    ["taobao", { seoDescription: "Best Seller" }],
  ] as const) {
    output = { ...content, ...fields };
    await f.req("POST", `${path}/generate`, { platform }, 202);
    const failed = await eventual(() => f.req("GET", path), (j) => j.status === "failed");
    assert.equal(failed.errorCode, "LISTING_FORBIDDEN_WORD");
    assert.deepEqual(failed.versions, []);
  }
  assert.equal(errors.mock.callCount(), 5);
  for (const call of errors.mock.calls) {
    assert.deepEqual(call.arguments, [`[listing-copy] jobId=${draft.id} errorCode=LISTING_FORBIDDEN_WORD reason=校验模型输出失败`]);
  }
});

test("生成文案可修正空值，但拒绝非普通对象和不可修正的字段类型", async () => {
  let output: unknown = {
    title: "杯子", bulletPoints: null, description: null, searchTerms: null, itemHighlights: null,
  };
  const f = await fixture(async () => output);
  const draft = await f.upload("draft");
  const path = `${root}/${draft.id}`;
  await f.req("POST", `${path}/generate`, { platform: "amazon" }, 202);
  const generated = await eventual(() => f.req("GET", path), (j) => j.status === "succeeded");
  assert.deepEqual(generated.versions[0].content, {
    schemaVersion: "listing-copy-v1", title: "杯子", description: "", bulletPoints: [], missingFacts: [],
  });

  for (const bad of [
    null, [content], Object.assign(new Date(), content),
    { ...content, schemaVersion: "listing-copy-v2", type: "listing-copy-v1" },
    { ...content, title: undefined }, { ...content, title: 1 }, { ...content, description: {} },
    { ...content, bulletPoints: undefined }, { ...content, bulletPoints: 1 },
    { ...content, missingFacts: "容量" }, { ...content, searchTerms: [1] },
  ]) {
    output = bad;
    await f.req("POST", `${path}/regenerate`, {}, 202);
    const failed = await eventual(() => f.req("GET", path), (j) => j.status === "failed");
    assert.equal(failed.errorCode, "LISTING_INVALID_CONTENT");
    assert.deepEqual(failed.versions, generated.versions);
  }
});

test("淘宝只保存适用字段，所有文本字段的禁用词和非法字段类型均硬拦截", async () => {
  const f = await fixture(async () => ({ ...content, subtitle: "折叠收纳" })),
    draft = await f.upload("draft"),
    path = `${root}/${draft.id}`;
  await f.req("POST", path + "/generate", { platform: "taobao" }, 202);
  const generated = await eventual(
    () => f.req("GET", path),
    (j) => j.status === "succeeded",
  );
  const first = generated.versions[0];
  assert.equal(first.content.subtitle, "折叠收纳");
  assert.ok(!("searchTerms" in first.content));
  const edited = await f.req("PUT", path, { content: { title: "我的杯子", searchTerms: ["ignored"] } });
  assert.deepEqual(edited.versions[0], first);
  assert.equal(edited.versions[1].content.title, "我的杯子");
  assert.equal(edited.versions[1].promptSnapshot.editedFromVersionId, first.id);
  assert.ok(!("searchTerms" in edited.versions[1].content));
  for (const changes of [
    { title: "Best Seller" }, { description: "Best Seller" }, { bulletPoints: ["best seller"] },
    { searchTerms: ["best seller"] }, { missingFacts: ["best seller"] }, { itemHighlights: "best seller" },
    { tags: ["best seller"] }, { seoTitle: "best seller" }, { seoDescription: "best seller" },
    { subtitle: "Ｂｅｓｔ Ｓｅｌｌｅｒ" }, { hashtags: ["#best seller"] },
  ]) {
    const res = await f.app.request("PUT", path, { body: { content: changes } });
    assert.equal(res.status, 400);
    assert.equal((res.body as any).error.code, "LISTING_FORBIDDEN_WORD");
  }
  for (const changes of [
    { searchTerms: "unused" }, { bulletPoints: "- 白色\n- 折叠" }, { description: null }, { missingFacts: null },
    { subtitle: null }, { tags: [1] }, { unknown: "text" },
  ]) {
    const res = await f.app.request("PUT", path, { body: { content: changes } });
    assert.equal(res.status, 400);
    assert.equal((res.body as any).error.code, "LISTING_INVALID_CONTENT");
  }
  assert.deepEqual((await f.req("GET", path)).versions, [first, edited.versions[1]]);
});

test("16 平台只保存各自专属字段，专属字段超限仍可交付并生成警告", async () => {
  const { searchTerms, ...base } = content;
  const special = {
    searchTerms,
    itemHighlights: "Foldable handle",
    tags: ["陶".repeat(21), ...Array(13).fill("cup")],
    seoTitle: "A".repeat(61),
    seoDescription: "B".repeat(161),
    subtitle: "携".repeat(41),
    hashtags: Array.from({ length: 11 }, (_, i) => `#杯${i}`),
  };
  const f = await fixture(async () => ({
    ...base, ...special,
    tags: ` ${special.tags[0]}、\n${special.tags.slice(1).join(",")} `,
    hashtags: ` ${special.hashtags.slice(0, 2).join(",\n")} ${special.hashtags.slice(2).join(" ")} `,
  }));
  const pairs = [
    [["amazon"], { searchTerms, itemHighlights: special.itemHighlights }, []],
    [["etsy"], { tags: special.tags }, [
      { field: "tags", actual: 14, limit: 13, unit: "items" },
      { field: "tags", actual: 21, limit: 20, unit: "characters", itemIndex: 0 },
    ]],
    [["shopify"], { seoTitle: special.seoTitle, seoDescription: special.seoDescription }, [
      { field: "seoTitle", actual: 61, limit: 60, unit: "characters" },
      { field: "seoDescription", actual: 161, limit: 160, unit: "characters" },
    ]],
    [["taobao", "pinduoduo", "1688", "jd"], { subtitle: special.subtitle }, [
      { field: "subtitle", actual: 41, limit: 40, unit: "characters" },
    ]],
    [["douyin", "xiaohongshu"], { hashtags: special.hashtags }, [
      { field: "hashtags", actual: 11, limit: 10, unit: "items" },
    ]],
    [["walmart", "ebay", "temu", "tiktok_shop", "shopee", "lazada", "aliexpress"], {}, []],
  ] as const;
  for (const [platforms, fields, warnings] of pairs) {
    for (const platform of platforms) {
      const draft = await f.upload("draft");
      const path = `${root}/${draft.id}`;
      await f.req("POST", path + "/generate", { platform }, 202);
      const job = await eventual(() => f.req("GET", path), (j) => j.status === "succeeded");
      const result = job.versions[0].content;
      assert.deepEqual(result, { ...base, ...fields }, platform);
      assert.deepEqual(evaluateListingWarnings(result, platformRules[platform]), warnings, platform);
    }
  }
});

test("套图上传不截获文案 multipart；首图建立隐藏草稿，可预览、删除且最多六张", async () => {
  const f = await fixture(async () => content);
  const payload = Buffer.concat([
    Buffer.from(
      '--cup\r\nContent-Disposition: form-data; name="file"; filename="cup.png"\r\nContent-Type: image/png\r\n\r\n',
    ),
    f.bytes,
    Buffer.from("\r\n--cup--\r\n"),
  ]);
  const send = async (path: string) =>
    data(
      (await dispatchInputImageUpload(f.app, path, payload, {
        "content-type": "multipart/form-data; boundary=cup",
        "idempotency-key": "suite-input",
      }))!,
      201,
    );
  const job = await send(root + "/draft/input-images"),
    path = `${root}/${job.id}`;
  assert.equal(job.status, "draft");
  assert.deepEqual(await f.repository.listSuites(), []);
  const img = job.inputImages[0];
  assert.ok(img.originalObjectKey.startsWith(`listing-copies/${job.id}/inputs/${img.id}/`));
  const original = await f.app.request("GET", `${path}/input-images/${img.id}/preview/original`);
  assert.deepEqual(original.raw, f.bytes);
  assert.equal(original.headers?.["cache-control"], "private, max-age=60");
  const thumb = await f.app.request("GET", `${path}/input-images/${img.id}/preview/thumbnail`);
  assert.equal(thumb.headers?.["content-type"], "image/jpeg");
  assert.equal(thumb.headers?.["cache-control"], "private, max-age=60");
  for (let i = 1; i < 6; i++) await send(path + "/input-images");
  assert.equal(
    (
      await f.app.request("POST", path + "/input-images", {
        body: { bytes: f.bytes, mimeType: "image/png", filename: "seven.png" },
      })
    ).status,
    409,
  );
  assert.equal((await f.req("DELETE", `${path}/input-images/${img.id}`)).inputImages.length, 5);
  assert.equal(await f.storage.get(img.originalObjectKey), null);
  await f.req("DELETE", path);
  assert.equal((await f.app.request("GET", path)).status, 404);
  const suite = await f.repository.createSuite("套图");
  await send(`/api/suites/${suite.id}/input-images`);
  assert.equal((await f.repository.getInputImages(suite.id)).length, 1);
});

async function pipelineFixture(overrides: Record<string, unknown> = {}) {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let imageCalls = 0,
    copyCalls = 0;
  const f = await fixture(async () => content, {
    taskRepository: new MemoryTaskRepository(),
    planRepository: new MemoryPlanRepository(),
    provider: {
      async edit() {
        imageCalls++;
        return { bytes: f.bytes, mimeType: "image/png" };
      },
    },
    llmClient: {
      provider: "fake",
      model: "vision",
      isFake: true,
      async generatePlan(input: PlanLlmInput) {
        if (input.flow === "listing-copy") {
          copyCalls++;
          await pending;
          return copyCalls === 1 && overrides.listingCopy !== false ? { ...content, title: "Best Seller" } : content;
        }
        return {
          schemaVersion: "suite-structure-plan-v2",
          status: "READY_FOR_REVIEW",
          mainAllocation: {
            category: "main",
            count: 1,
            reason: "主图",
            sourceImageIds: input.inputImageIds,
            factRefs: [],
            missingFacts: [],
          },
          detailImageCount: 0,
          categoryAllocations: [...DETAIL_CATEGORY_CODES].map((category) => ({
            category,
            requirement: "optional",
            count: 0,
            reason: "",
            sourceImageIds: [],
            factRefs: [],
            missingFacts: [],
          })),
          globalStyleCard: { promptPrefix: "统一" },
        };
      },
      async generateCategoryPrompt(input: any) {
        return {
          schemaVersion: "suite-category-prompt-v1",
          category: input.categoryCode,
          items: [
            {
              stableId: "main-one",
              category: "main",
              title: "杯子",
              purpose: "展示",
              referenceImageIds: input.inputImageIds,
              factRefs: [],
              prompt: "杯子",
              allowsTextOverlay: "no",
              textContent: [],
              aspectRatio: "1:1",
              suggestedParams: {},
            },
          ],
        };
      },
    },
  });
  const suite = await f.repository.createSuite("套图");
  data(
    await f.app.upload(suite.id, { filename: "cup.png", mimeType: "image/png", bytes: f.bytes, idempotencyKey: "cup" }),
    201,
  );
  const config = {
    listingCopy: true,
    platform: "taobao",
    targetMarket: "CN",
    outputLanguage: "中文",
    sellingPoints: "白色杯子",
    counts: { main: 1, selling_points: 0, lifestyle: 0, other: 0 },
    ...overrides,
  };
  data(
    await f.app.request("POST", "/api/suites/one-click-generate", {
      headers: { "Idempotency-Key": "run-with-copy" },
      body: { suiteId: suite.id, config },
    }),
    202,
  );
  const state = () => f.req("GET", `/api/suites/${suite.id}/studio-state`);
  return { f, state, suite, release, imageCalls: () => imageCalls, copyCalls: () => copyCalls };
}

test("未开启直出的批次可按需生成，studio-state 关联补生成任务并沿用批次输入", async () => {
  const { f, state, suite, release, copyCalls } = await pipelineFixture({ listingCopy: false });
  try {
    const before = await eventual(state, (s) => s.pipeline.status === "completed");
    assert.equal(before.listingCopy, null);
    assert.equal(copyCalls(), 0);
    const started = await f.req("POST", root, { sourceSuiteId: suite.id, generate: true }, 202);
    const pending = await state();
    assert.equal(pending.listingCopy.id, started.id);
    assert.equal(pending.listingCopy.status, "running");
    assert.equal(pending.listingCopy.sourceSuiteId, suite.id);
    assert.equal(started.platform, "taobao");
    assert.equal(started.targetMarket, "CN");
    assert.equal(started.outputLanguage, "中文");
    assert.equal(started.input.sellingPoints, "白色杯子");
    assert.equal(started.inputImages[0].id, (await f.repository.getInputImages(suite.id))[0].id);
    release();
    const completed = await eventual(state, (s) => s.listingCopy?.status === "succeeded");
    assert.equal(completed.listingCopy.id, started.id);
    assert.equal(completed.pipeline.status, "completed");
    assert.equal(copyCalls(), 1);
  } finally {
    release();
  }
});

test("流水线在文案仍运行时完成出图；文案失败不改变批次完成状态，可复用批次独立生成", async () => {
  const { f, state, suite, release, imageCalls, copyCalls } = await pipelineFixture();
  try {
    const completed = await eventual(state, (s) => s.pipeline.status === "completed");
    assert.equal(imageCalls(), 1);
    assert.equal(copyCalls(), 1);
    assert.equal(completed.listingCopy.status, "running");
    assert.equal(completed.listingCopy.sourceSuiteId, suite.id);
    assert.equal(completed.progress.completed, 1);
  } finally {
    release();
  }
  const failed = await eventual(state, (s) => s.listingCopy?.status === "failed");
  // studio-state reads pipeline before listingCopy. Inspect a fresh snapshot after the failure settles.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await state()).pipeline.status, "completed");
  assert.equal(failed.listingCopy.errorCode, "LISTING_FORBIDDEN_WORD");
  const independent = await f.req("POST", root, { sourceSuiteId: suite.id, generate: true }, 202);
  const job = await eventual(
    () => f.req("GET", `${root}/${independent.id}`),
    (j) => j.status === "succeeded",
  );
  assert.notEqual(job.id, failed.listingCopy.id);
  assert.equal((await state()).listingCopy.id, failed.listingCopy.id);
  assert.equal(job.platform, "taobao");
  assert.equal(job.input.sellingPoints, "白色杯子");
  assert.equal(job.inputImages[0].id, (await f.repository.getInputImages(suite.id))[0].id);
  await f.req("DELETE", `${root}/${job.id}`);
  assert.ok(await f.storage.get(job.inputImages[0].originalObjectKey));
});

test("套图配置含 null 时可见文案失败，出图完成且不调用文案模型", async () => {
  const { state, suite, release, imageCalls, copyCalls } = await pipelineFixture({ targetMarket: null });
  release();
  await eventual(state, (s) => s.pipeline.status === "completed");
  const { listingCopy } = await eventual(state, (s) => s.listingCopy?.status === "failed");
  assert.equal(listingCopy.sourceSuiteId, suite.id);
  assert.equal(listingCopy.errorCode, "INVALID_LISTING_CONFIG");
  assert.equal((await state()).pipeline.status, "completed");
  assert.equal(copyCalls(), 0);
  assert.equal(imageCalls(), 1);
});

test("复用历史计划时非法 dynamicInput 留下可修正并重试的失败任务", async () => {
  const f = await fixture(async () => content, {
    planRepository: {
      async getLatestSnapshot() {
        return { dynamicInput: { platform: "amazon", human_supplement: null } };
      },
    },
  });
  const suite = await f.repository.createSuite("历史套图");
  data(
    await f.app.upload(suite.id, { filename: "cup.png", mimeType: "image/png", bytes: f.bytes, idempotencyKey: "old" }),
    201,
  );
  const started = await f.req("POST", root, { sourceSuiteId: suite.id, generate: true }, 202);
  const path = `${root}/${started.id}`;
  const failed = await eventual(
    () => f.req("GET", path),
    (j) => j.status === "failed",
  );
  assert.equal(failed.errorCode, "INVALID_LISTING_CONFIG");
  assert.equal(failed.sourceSuiteId, suite.id);
  await f.req("POST", path + "/regenerate", { sellingPoints: "白色" }, 202);
  assert.equal(
    (
      await eventual(
        () => f.req("GET", path),
        (j) => j.status === "succeeded",
      )
    ).versions.length,
    1,
  );
});

test("空分页参数使用默认值，显式零上限仍无效", async () => {
  const f = await fixture(async () => content);
  assert.deepEqual(await f.req("GET", root + "?limit=&offset="), { items: [], limit: 20, offset: 0 });
  assert.equal((await f.app.request("GET", root + "?limit=0&offset=0")).status, 400);
});

test("运行中文案的未知子路径返回 404，合法冲突写入仍返回 409", async () => {
  let release!: () => void;
  const pending = new Promise<void>((r) => {
    release = r;
  });
  const f = await fixture(async () => {
    await pending;
    return content;
  });
  const job = await f.upload("draft"),
    path = `${root}/${job.id}`;
  await f.req("POST", path + "/generate", { platform: "amazon" }, 202);
  try {
    for (const [method, suffix] of [
      ["GET", "/unknown"],
      ["POST", "/generate/extra"],
      ["DELETE", "//wrong"],
    ]) {
      assert.equal((await f.app.request(method, path + suffix)).status, 404);
    }
    assert.equal((await f.app.request("DELETE", path)).status, 409);
  } finally {
    release();
  }
  await eventual(
    () => f.req("GET", path),
    (j) => j.status === "succeeded",
  );
});
