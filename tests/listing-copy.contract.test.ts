import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { parseNormalizedPromptMarkdown, validatePromptTemplateContract } from "../server/prompt-library.js";
import { createTicket02App, type AppResponse } from "../server/app.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryPromptRepository } from "../server/repositories/memory-prompt-repository.js";
import type { PlanLlmInput } from "../server/types.js";
import sharp from "sharp";
import { dispatchInputImageUpload } from "../server/multipart.js";
import { MemoryTaskRepository } from "../server/repositories/memory-task-repository.js";
import { MemoryPlanRepository } from "../server/repositories/memory-plan-repository.js";
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
  const app = createTicket02App({
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
          listingCopyRules: {
            titleMaxLength: code === "amazon" ? 75 : 30,
            maxBulletPoints: 5,
            supportsSearchTerms: code === "amazon",
            forbiddenWords: ["best seller"],
          },
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

test("Amazon 标题超长失败；使用原图和配置重试后生成带渠道及输入快照的版本", async () => {
  const calls: PlanLlmInput[] = [];
  const f = await fixture(async (input) => {
    calls.push(input);
    return calls.length === 1 ? { ...content, title: "A".repeat(76) } : content;
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
  const failed = await eventual(
    () => f.req("GET", path),
    (j) => j.status === "failed",
  );
  assert.equal(failed.errorCode, "LISTING_TITLE_TOO_LONG");
  assert.deepEqual(failed.versions, []);
  await f.req("POST", path + "/regenerate", {}, 202);
  const job = await eventual(
    () => f.req("GET", path),
    (j) => j.status === "succeeded",
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].visionImages?.[0].bytes, f.bytes);
  assert.equal(calls[1].dynamicInput.selling_points, "白色杯子");
  const snap = job.versions[0].promptSnapshot;
  assert.equal(snap.templateVersionId, calls[1].templateVersionId);
  assert.equal(snap.model.model, "test-vision");
  assert.equal(snap.model.channel.channelId, "vision-fixture");
  assert.deepEqual(snap.input.image_ids, [draft.inputImages[0].id]);
  assert.equal(snap.input.images[0].sha256, draft.inputImages[0].sha256);
  assert.equal(snap.input.target_market, "US");
  assert.equal(snap.input.output_language, "English");
  assert.deepEqual(job.versions[0].content.missingFacts, ["容量"]);
  assert.equal((await f.req("GET", root + "?limit=1&offset=0")).items[0].id, job.id);
});

test("淘宝不出搜索词；编辑产生新版本并保留旧内容，禁用词与超量要点不能保存", async () => {
  const f = await fixture(async () => content),
    draft = await f.upload("draft"),
    path = `${root}/${draft.id}`;
  await f.req("POST", path + "/generate", { platform: "taobao" }, 202);
  const generated = await eventual(
    () => f.req("GET", path),
    (j) => j.status === "succeeded",
  );
  const first = generated.versions[0];
  assert.ok(!("searchTerms" in first.content));
  const edited = await f.req("PUT", path, { content: { title: "我的杯子", searchTerms: ["ignored"] } });
  assert.deepEqual(edited.versions[0], first);
  assert.equal(edited.versions[1].content.title, "我的杯子");
  assert.equal(edited.versions[1].promptSnapshot.editedFromVersionId, first.id);
  assert.ok(!("searchTerms" in edited.versions[1].content));
  for (const [changes, code] of [
    [{ bulletPoints: Array(6).fill("point") }, "LISTING_TOO_MANY_BULLETS"],
    [{ description: "Best Seller" }, "LISTING_FORBIDDEN_WORD"],
  ] as const) {
    const res = await f.app.request("PUT", path, { body: { content: { ...first.content, ...changes } } });
    assert.equal(res.status, 400);
    assert.equal((res.body as any).error.code, code);
  }
  assert.deepEqual((await f.req("GET", path)).versions, [first, edited.versions[1]]);
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
  const thumb = await f.app.request("GET", `${path}/input-images/${img.id}/preview/thumbnail`);
  assert.equal(thumb.headers?.["content-type"], "image/jpeg");
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

test("流水线在文案仍运行时完成出图；文案失败不改变批次完成状态，可复用批次独立生成", async () => {
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
          return copyCalls === 1 ? { ...content, title: "A".repeat(90) } : content;
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
  };
  data(
    await f.app.request("POST", "/api/suites/one-click-generate", {
      headers: { "Idempotency-Key": "run-with-copy" },
      body: { suiteId: suite.id, config },
    }),
    202,
  );
  const state = () => f.req("GET", `/api/suites/${suite.id}/studio-state`);
  try {
    const completed = await eventual(state, (s) => s.pipeline.status === "completed");
    assert.equal(imageCalls, 1);
    assert.equal(copyCalls, 1);
    assert.equal(completed.listingCopy.status, "running");
    assert.equal(completed.listingCopy.sourceSuiteId, suite.id);
    assert.equal(completed.progress.completed, 1);
  } finally {
    release();
  }
  const failed = await eventual(state, (s) => s.listingCopy?.status === "failed");
  assert.equal(failed.pipeline.status, "completed");
  assert.equal(failed.listingCopy.errorCode, "LISTING_TITLE_TOO_LONG");
  const independent = await f.req("POST", root, { sourceSuiteId: suite.id, generate: true }, 202);
  const job = await eventual(
    () => f.req("GET", `${root}/${independent.id}`),
    (j) => j.status === "succeeded",
  );
  assert.notEqual(job.id, failed.listingCopy.id);
  assert.equal(job.platform, "taobao");
  assert.equal(job.input.sellingPoints, "白色杯子");
  assert.equal(job.inputImages[0].id, (await f.repository.getInputImages(suite.id))[0].id);
  await f.req("DELETE", `${root}/${job.id}`);
  assert.ok(await f.storage.get(job.inputImages[0].originalObjectKey));
});
