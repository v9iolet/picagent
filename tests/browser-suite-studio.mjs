// Run with: npx tsx --test tests/browser-suite-studio.mjs (no DB, credentials, or external requests).
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright";
import { createSuiteStudioApp } from "../server/app.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryTaskRepository } from "../server/repositories/memory-task-repository.js";
import { MemoryPlanRepository } from "../server/repositories/memory-plan-repository.js";
import { MemoryCategoryPromptRepository } from "../server/repositories/memory-category-prompt-repository.js";
import { MemoryPromptRepository } from "../server/repositories/memory-prompt-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";
import { parseNormalizedPromptMarkdown } from "../server/prompt-library.js";
import { DETAIL_CATEGORIES } from "../shared/suite-categories.js";
import { ImageEditorService, MemoryImageEditorRepository } from "../server/image-editor.js";
import { createImageEditorApi } from "../server/image-editor-api.js";
import { readZipEntries } from "../server/zip.js";

async function offlineStudio(structureTemplate = "general-structure-plan-groups.md") {
  const sample = await readFile("public/assets/gan65-product.jpg");
  const prompts = new MemoryPromptRepository();
  for (const name of [
    "general-base-refine.md",
    structureTemplate,
    "general-category-prompt-groups.md",
  ]) {
    const [v] = await prompts.importRecords([
      parseNormalizedPromptMarkdown(await readFile(`prompt/normalized/${name}`, "utf8"), name),
    ]);
    await prompts.publishVersion(v.templateVersionId); // memory only
  }
  const platforms = [
    ["amazon", "Amazon", "pure_white_required"],
    ["taobao", "淘宝", "flexible"],
    ["ebay", "eBay", "white_preferred"],
  ].map(([code, name, mainImageBackground]) => ({
    code,
    name,
    mainImageBackground,
    marketScope: code === "taobao" ? "domestic" : "overseas",
    mainImageStrategy: "",
    galleryStrategy: "",
    textStrategy: "",
    modelStrategy: "",
    sourceNote: "",
    sortOrder: 1,
  }));
  const storage = new MemoryStorage(),
    editorRepository = new MemoryImageEditorRepository();
  const source = { bytes: sample, mimeType: "image/jpeg", width: 64, height: 64 };
  const editor = new ImageEditorService(
    editorRepository,
    {
      name: "offline",
      version: "1",
      capabilitiesVersion: "1",
      capabilities: () => ({ imageToImage: true, changeText: true, currentVersionInput: true }),
      edit: async () => source,
    },
    storage,
    async () => source,
    {
      name: "offline OCR",
      version: "1",
      recognize: async () => ({
        blocks: [
          {
            id: "line1",
            text: "折叠插脚",
            confidence: 1,
            bounds: { x: 0.1, y: 0.1, width: 0.5, height: 0.2 },
            rotation: 0,
          },
        ],
      }),
    },
  );
  const app = createSuiteStudioApp({
    imageEditorApi: createImageEditorApi(editor),
    repository: new MemorySuiteRepository(),
    storage,
    promptRepository: prompts,
    taskRepository: new MemoryTaskRepository(),
    planRepository: new MemoryPlanRepository(),
    categoryPromptRepository: new MemoryCategoryPromptRepository(),
    platformRepository: {
      listEnabled: async () => platforms,
      find: async (code) => platforms.find((p) => p.code === code),
    },
    provider: {
      async edit() {
        await new Promise((resolve) => setTimeout(resolve, 180));
        return { bytes: sample, mimeType: "image/jpeg" };
      },
    },
    llmClient: {
      provider: "fake",
      model: "offline",
      isFake: true,
      async generatePlan(input) {
        const id = input.inputImageIds[0],
          groups = JSON.parse(input.dynamicInput.category_groups);
        const counts = {
          feature_benefit: groups.selling_points.count,
          lifestyle_use: groups.lifestyle.count,
          comparison: groups.other.count,
        };
        return {
          schemaVersion: "suite-structure-plan-v2",
          status: "READY_FOR_REVIEW",
          mainAllocation: {
            category: "main",
            count: groups.main.count,
            reason: "商品全貌",
            sourceImageIds: [id],
            factRefs: [],
            missingFacts: [],
          },
          detailImageCount: Object.values(counts).reduce((a, b) => a + b, 0),
          categoryAllocations: DETAIL_CATEGORIES.map(([category]) => ({
            category,
            count: counts[category] ?? 0,
            requirement: "optional",
            reason: "展示商品",
            sourceImageIds: [id],
            factRefs: [],
            missingFacts: [],
          })),
          globalStyleCard: { promptPrefix: "统一棚拍" },
        };
      },
      async generateCategoryPrompt(input) {
        return {
          schemaVersion: "suite-category-prompt-v1",
          category: input.categoryCode,
          items: Array.from({ length: input.requestedCount }, (_, i) => ({
            stableId: `${input.categoryCode}-${i}`,
            category: input.categoryCode,
            title: {
              main: "便携键盘产品全貌与折叠收纳结构的正面展示",
              feature_benefit: "折叠插脚",
              lifestyle_use: "桌面充电",
              comparison: "规格对比",
            }[input.categoryCode],
            purpose: "展示商品",
            prompt: "展示商品实拍",
            sourceImageIds: input.inputImageIds,
            referenceImageIds: input.inputImageIds,
            factRefs: [],
            allowsTextOverlay: "no",
            textContent: [],
            aspectRatio: "1:1",
            suggestedParams: {},
          })),
        };
      },
    },
  });
  const settings = {
    channels: [
      {
        id: "demo",
        name: "离线测试",
        baseUrl: "https://example.invalid/v1",
        protocol: "openai-compatible",
        hasApiKey: true,
        models: [
          {
            id: "offline-image",
            capabilities: ["image", "vision"],
            imageOptions: { sizes: ["1K", "4K"], aspectRatios: ["1:1", "3:2"], sizeMode: "tier" },
          },
        ],
      },
    ],
    preferences: { image: { channelId: "demo", modelId: "offline-image" }, vision: null },
  };
  const calls = [];
  const vite = await createServer({
    cacheDir: "node_modules/.vite-browser-suite-studio",
    configFile: false,
    server: { host: "127.0.0.1", port: 0 },
    esbuild: { jsx: "automatic" },
    plugins: [
      {
        name: "offline-api",
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            const path = req.url ?? "/";
            if (!path.startsWith("/api/")) return next();
            try {
              const data = [];
              for await (const chunk of req) data.push(chunk);
              const buf = Buffer.concat(data);
              const upload = path.match(/^\/api\/suites\/([^/]+)\/input-images$/),
                input = path.match(
                  /^\/api\/suites\/([^/]+)\/input-images\/([^/]+)\/preview\/(original|thumbnail)$/,
                ),
                task = path.match(/^\/api\/suite-tasks\/([^/]+)\/versions\/([^/]+)\/preview$/);
              let r;
              const edited = path.match(/^\/api\/image-editor\/tasks\/([^/]+)\/versions\/([^/]+)\/preview$/);
              if (upload && req.method === "POST") {
                const form = await new Response(buf, {
                  headers: { "content-type": req.headers["content-type"] },
                }).formData();
                const file = form.get("file");
                r = await app.upload(upload[1], {
                  filename: file.name,
                  mimeType: file.type,
                  bytes: Buffer.from(await file.arrayBuffer()),
                  idempotencyKey: req.headers["idempotency-key"],
                });
              } else if (input) r = await app.preview(input[1], input[2], input[3]);
              else if (task) r = await app.previewTaskVersion(task[1], task[2]);
              else if (edited) {
                const version = (await editorRepository.listVersions(edited[1])).find(
                  (v) => v.id === edited[2],
                );
                const obj = await storage.get(version.objectKey);
                r = { status: 200, raw: obj.bytes, headers: { "content-type": obj.contentType } };
              } else {
                const body = buf.length ? JSON.parse(buf.toString()) : undefined;
                calls.push({ path, method: req.method, body });
                r = path.startsWith("/api/model-settings")
                  ? { status: 200, body: { data: settings } }
                  : await app.request(req.method, path, { headers: req.headers, body });
              }
              res.writeHead(r.status, r.raw ? r.headers : { "Content-Type": "application/json" });
              res.end(r.raw ?? JSON.stringify(r.body));
            } catch (e) {
              res.writeHead(500);
              res.end(String(e));
            }
          });
        },
      },
    ],
  });
  await vite.listen();
  return { url: vite.resolvedUrls.local[0], calls, close: () => vite.close() };
}

test("商品套图：空态、静默草稿、平台联动、七张实图、选中 ZIP 与全屏交付入口", async (t) => {
  const fixture = await offlineStudio();
  t.after(fixture.close);
  const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1500, height: 940 }, acceptDownloads: true });
  page.setDefaultTimeout(8000);
  await page.goto(fixture.url + "suites/new");
  await page.waitForURL("**/create/suite");
  await page.getByRole("heading", { name: "AI 商品套图", exact: true }).waitFor();
  await page.screenshot({ path: "tests/browser/suite-studio-empty.png" });
  await page.getByLabel("上传商品原图").setInputFiles("public/assets/gan65-product.jpg");
  await page.waitForURL(/\/create\/suite\/[^/]+$/);
  const suiteId = new URL(page.url()).pathname.split("/").pop();
  const platform = page.getByLabel("平台", { exact: true });
  const platformTip = page.getByRole("button", { name: "主图背景规范说明" });
  const refine = page.getByRole("checkbox", { name: "白底精修", exact: true });
  const overseasHint = page.getByText("国际站主图将按纯白背景规范生成，数量以主图配置为准。", { exact: true });
  await platform.selectOption({ label: "Amazon" });
  assert.equal(await refine.count(), 0);
  assert.equal(await overseasHint.count(), 0);
  await platformTip.click();
  await overseasHint.waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await overseasHint.waitFor({ state: "hidden" });
  const sellingPoints = page.getByRole("textbox", { name: "商品卖点与生成要求" });
  assert.equal(await sellingPoints.getAttribute("rows"), "6");
  assert.equal(
    await sellingPoints.getAttribute("placeholder"),
    "建议包含以下信息生成更精准：\n1.产品名称\n2.核心卖点\n3.适用人群\n4.期望场景\n5.具体参数",
  );
  const helpButton = page.getByRole("button", { name: "商品卖点填写说明" });
  await helpButton.focus();
  await helpButton.press("Enter");
  const help = page.locator("#" + await helpButton.getAttribute("aria-controls"));
  await help.waitFor({ state: "visible" });
  assert.match(await help.textContent(), /已确认的商品事实/);
  assert.equal(await helpButton.getAttribute("aria-expanded"), "true");
  await helpButton.click();
  await help.waitFor({ state: "hidden" });
  await sellingPoints.fill("1. 产品名称：便携键盘\n2. 核心卖点：轻便");
  await page.getByRole("button", { name: "自定义配置", exact: true }).click();
  assert.equal(await page.getByRole("checkbox", { name: /矢量排版/ }).count(), 0);
  for (const [name, n] of [
    ["白底主图", 1],
    ["卖点图", 3],
    ["场景图", 2],
    ["其他", 1],
  ])
    assert.equal(await page.getByLabel(name + "张数", { exact: true }).textContent(), String(n));
  await page.getByRole("button", { name: "增加场景图" }).click();
  await page.getByRole("button", { name: "减少场景图" }).click();
  assert.deepEqual(await page.getByLabel("分辨率", { exact: true }).locator("option").allTextContents(), [
    "1K",
    "4K",
  ]);
  await page.getByLabel("分辨率", { exact: true }).selectOption("4K");
  await page.getByText("4K 出图更慢，费用更高，实际像素可能低于 4K 标称值。", { exact: true }).waitFor();
  await page.getByLabel("分辨率", { exact: true }).selectOption("1K");
  await page.getByRole("button", { name: "一键生成套图（7张）", exact: true }).click();
  const batch = page.getByRole("region", { name: "生成批次" });
  await batch.locator('[data-status="running"]').waitFor();
  await page.screenshot({ path: "tests/browser/suite-studio-running.png" });
  await batch.locator('[data-status="completed"]').waitFor({ timeout: 25000 });
  await batch.getByText("便携键盘", { exact: true }).waitFor();
  const cards = batch.locator("[data-result-card]");
  assert.equal(await cards.count(), 7);
  assert.equal(await cards.locator("img").count(), 7);
  const badges = await cards.evaluateAll((elements) => elements.map((card) => {
    const badge = card.querySelector("[data-type-badge]");
    return [badge?.textContent, badge?.title];
  }));
  assert.deepEqual(badges.sort(), [
    ["主图", "便携键盘产品全貌与折叠收纳结构的正面展示"],
    ["卖点图 · 功能", "折叠插脚"], ["卖点图 · 功能", "折叠插脚"], ["卖点图 · 功能", "折叠插脚"],
    ["生活场景图", "桌面充电"], ["生活场景图", "桌面充电"],
    ["对比图", "规格对比"],
  ].sort());
  await batch.getByLabel("全选本批次").check();
  assert.equal(await cards.locator("input:checked").count(), 7);
  await batch.getByLabel("全选本批次").uncheck();
  await cards.first().getByRole("checkbox").check();
  await page.screenshot({ path: "tests/browser/suite-studio-results.png" });
  const dl = page.waitForEvent("download");
  await batch.getByRole("button", { name: "下载所选（1）" }).click();
  const entries = readZipEntries(await readFile(await (await dl).path()));
  assert.equal([...entries.keys()].filter((name) => /\.(png|jpe?g|webp)$/i.test(name)).length, 1);
  assert.match(
    fixture.calls.find((x) => x.path.includes("/delivery/export?")).path,
    new RegExp(`/suites/${suiteId}/delivery/export\\?taskIds=`),
  );
  const statePolls = () =>
    fixture.calls.filter((x) => x.path === `/api/suites/${suiteId}/studio-state`).length;
  const afterCompletion = statePolls();
  await page.waitForTimeout(3200);
  assert.equal(statePolls(), afterCompletion, "终态后不得继续轮询");
  const first = cards.first();
  assert.equal(await first.getByRole("button", { name: "编辑文字" }).count(), 0);
  await first.getByRole("button", { name: "编辑图片" }).click();
  const dialog = page.getByRole("dialog", { name: "图片编辑器" });
  await dialog.waitFor();
  assert.equal(new URL(page.url()).pathname, `/create/suite/${suiteId}`);
  assert.equal(await dialog.isVisible(), true);
  await dialog.locator(".wb-editor-tools button", { hasText: "改文字" }).click();
  await dialog.getByRole("button", { name: /折叠插脚/ }).waitFor();
  await dialog.getByLabel("新文字").fill("折叠设计");
  const opReq = page.waitForResponse((res) => res.url().includes("/api/image-editor/sessions/") && res.url().endsWith("/operations"));
  const submitReq = page.waitForResponse((res) => res.url().includes("/api/image-editor/sessions/") && res.url().endsWith("/submit"));
  await dialog.getByRole("button", { name: "开始生成（新建编辑子卡）" }).click();
  await Promise.all([opReq, submitReq]);
  await dialog.waitFor({ state: "hidden" });
  assert.equal(new URL(page.url()).pathname, `/create/suite/${suiteId}`);
  assert.equal(
    fixture.calls.find((x) => x.path.endsWith("/operations")).body.operation.payload.newText,
    "折叠设计",
  );
  assert.ok(fixture.calls.some((x) => x.path.endsWith("/submit")));
  await batch.getByText("图片已更新", { exact: true }).waitFor({ timeout: 10000 });
  await first.getByRole("combobox").selectOption("4K");
  const regenReq = page.waitForResponse(
    (res) => res.request().method() === "POST" && res.url().includes("/api/suite-tasks/") && res.url().endsWith("/generation"),
  );
  await first.getByRole("button", { name: "重新生成" }).click();
  await regenReq;
  await batch.getByText("图片已更新", { exact: true }).waitFor();
  assert.deepEqual(fixture.calls.find((x) => x.path.endsWith("/tasks/batch-params")).body.generationParams, {
    size: "4K",
  });
  assert.match(
    fixture.calls.find(
      (x) => x.method === "POST" && x.path.startsWith("/api/suite-tasks/") && x.path.endsWith("/generation"),
    ).path,
    /\/generation$/,
  );
  await platform.selectOption({ label: "淘宝" });
  assert.equal(await refine.count(), 0);
  await platformTip.click();
  const domesticHint = page.getByText("国内站主图按场景策略生成，不强制白底。", { exact: true });
  await domesticHint.waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await domesticHint.waitFor({ state: "hidden" });
  assert.equal(await page.getByLabel("主图张数", { exact: true }).textContent(), "1");
  await platform.selectOption({ label: "eBay" });
  await platformTip.click();
  await overseasHint.waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await overseasHint.waitFor({ state: "hidden" });
  assert.equal(await page.getByLabel("白底主图张数", { exact: true }).textContent(), "1");
  await batch.getByRole("button", { name: "批次菜单" }).click();
  await batch.getByRole("button", { name: "货架预览导出" }).click();
  await page.waitForURL(`**/create/canvas/${suiteId}?view=gallery`);
  await page.getByRole("tab", { name: "成品展示板", selected: true }).waitFor();
  const gallery = page.getByRole("region", { name: "成品交付视图" });
  await gallery.getByRole("button", { name: "一键打包下载 ZIP (7)", exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page.getByRole("button", { name: "返回套图", exact: true }).click();
  await page.waitForURL(`**/create/suite/${suiteId}`);
  await batch.locator('[data-status="completed"]').waitFor();
  await page.goBack();
  await page.getByRole("tab", { name: "成品展示板", selected: true }).waitFor();
  await page.goto(fixture.url + "settings");
  await page.getByRole("button", { name: "编辑 离线测试", exact: true }).click();
  await page.getByLabel("生图", { exact: true }).uncheck();
  await page.getByRole("button", { name: "保存渠道", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("dialog[open]"));
  assert.equal(
    Object.hasOwn(
      fixture.calls.find((x) => x.method === "PUT" && x.path.includes("/channels/")).body.models[0],
      "imageOptions",
    ),
    false,
  );
});

test("旧版结构计划模板失败时显示中文发布指引", async (t) => {
  const fixture = await offlineStudio("general-structure-plan.md");
  t.after(fixture.close);
  const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  await page.goto(fixture.url + "create/suite");
  await page.getByLabel("上传商品原图").setInputFiles("public/assets/gan65-product.jpg");
  await page.waitForURL(/\/create\/suite\/[^/]+$/);
  await page.getByRole("button", { name: /^一键生成套图/ }).click();
  const batch = page.getByRole("region", { name: "生成批次" });
  const failed = batch.locator('[data-status="failed"]');
  const guidance = batch.getByText("请先在模板库发布最新版结构计划模板，再生成套图。", { exact: true });
  await failed.waitFor();
  await guidance.waitFor();
  assert.doesNotMatch(await batch.innerText(), /PLAN_TEMPLATE_OUTDATED/);

  const suiteId = new URL(page.url()).pathname.split("/").pop();
  await page.route(`**/api/suites/${suiteId}/studio-state`, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.data.pipeline.errorMessage = "PLAN_TEMPLATE_OUTDATED";
    await route.fulfill({ response, json });
  });
  await page.reload();
  await failed.waitFor();
  await guidance.waitFor();
  assert.doesNotMatch(await batch.innerText(), /PLAN_TEMPLATE_OUTDATED/);
});

test("零张欠配：卖点图和场景图都显示缺失事实并允许置零续跑", async (t) => {
  const fixture = await offlineStudio();
  t.after(fixture.close);
  const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(4000);
  const id = 'paused-review';
  await page.route(`**/api/suites/${id}/studio-state`, route => route.fulfill({json:{data:{
    suite:{id,name:'暂停的批次',createdAt:'2026-11-21T09:00:00Z'},
    pipeline:{status:'waiting_human_input',currentPhase:'structure_planning',config:{mode:'custom'}},
    inputImages:[],cards:[],progress:{completed:0,total:0,percent:0},
    planning:{notGeneratedReasons:[],snapshot:{structure:{categoryAllocations:[
      {category:'feature_benefit',count:0,missingFacts:['缺少材质信息']},
      {category:'lifestyle_use',count:0,missingFacts:['缺少使用场景']},
      {category:'size_scale',count:0,missingFacts:['辅助图尺寸未提供']},
    ]}}},
  }}}));
  await page.goto(fixture.url+`create/suite/${id}`);
  const batch=page.getByRole('region',{name:'生成批次'});
  await batch.getByText('补充商品事实后继续',{exact:true}).waitFor();
  assert.match(await batch.innerText(),/缺少材质信息/);
  assert.match(await batch.innerText(),/缺少使用场景/);
  assert.doesNotMatch(await batch.innerText(),/辅助图尺寸未提供/);
  for (const group of ['卖点图','场景图']) {
    assert.equal(await batch.getByRole('button',{name:`将${group}改为 0 张并继续`}).isVisible(),true);
  }
});
