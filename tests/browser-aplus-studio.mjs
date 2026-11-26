// npx tsx --test tests/browser-aplus-studio.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";
import sharp from "sharp";
import { createServer } from "vite";
import { createSuiteStudioApp } from "../server/app.js";
import { createImageEditorApi } from "../server/image-editor-api.js";
import { ImageEditorService, MemoryImageEditorRepository } from "../server/image-editor.js";
import { dispatchInputImageUpload } from "../server/multipart.js";
import { parseNormalizedPromptMarkdown } from "../server/prompt-library.js";
import { requestImageEditorEdit } from "../server/providers/image-editor-provider.js";
import { MemoryPlatformRepository } from "../server/repositories/memory-platform-repository.js";
import { MemoryProductCardRepository } from "../server/repositories/memory-product-card-repository.js";
import { MemoryPromptRepository } from "../server/repositories/memory-prompt-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryTaskRepository } from "../server/repositories/memory-task-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";
import { readZipEntries } from "../server/zip.js";
import { APLUS_MODULES } from "../shared/aplus.js";
import { defaultImageOptions } from "../shared/model-settings.js";
import { emptyProductCardFields } from "../shared/product-card.js";
import { makeAplusEditorSourceResolver } from "./aplus-editor-fixture.js";

const ocrBounds = { x: 0.16, y: 0.12, width: 0.25, height: 0.1 };

async function startOfflineAplus(t, { planningGate, imageGate } = {}) {
  const prompts = new MemoryPromptRepository();
  const names = ["aplus-plan", "aplus-image", "aplus-ai-write", ...APLUS_MODULES.map(({ code }) => `aplus-module-${code}`)];
  const versions = await prompts.importRecords(await Promise.all(names.map(async (name) => {
    const path = `prompt/normalized/${name}.md`;
    return parseNormalizedPromptMarkdown(await readFile(path, "utf8"), path);
  })));
  for (const version of versions) await prompts.publishVersion(version.templateVersionId);

  const cards = new MemoryProductCardRepository();
  const date = new Date().toISOString();
  const card = await cards.create({
    id: randomUUID(),
    fields: {
      ...emptyProductCardFields(),
      name: "磨砂随行杯",
      sellingPoints: ["便携杯盖"],
      specifications: "容量 450mL",
      materialsCraft: "不锈钢杯身",
      audienceScenarios: "通勤与户外",
      packageContents: "随行杯 ×1",
    },
    status: "published", revision: 1, images: [], sourceSessionId: null, createdAt: date, updatedAt: date,
  });

  const studioTasks = new MemoryTaskRepository();
  const profile = {
    mainImageBackground: "flexible", mainImageStrategy: "", galleryStrategy: "",
    textStrategy: "", modelStrategy: "", sourceNote: "",
  };
  const dimensions = { width: 2496, height: 1024 };
  const solid = (background) => sharp({ create: { ...dimensions, channels: 3, background } }).png().toBuffer();
  const [hero, usage, restored, changedText] = await Promise.all(["navy", "red", "lime", "cyan"].map(solid));
  let planningInput = null;
  let nextPlan = 0;
  const confirmations = [];
  const imageCalls = [];
  const editorCalls = [];
  const ocrCalls = [];
  const storage = new MemoryStorage();
  const suites = new MemorySuiteRepository();
  const editorTasks = new MemoryImageEditorRepository();
  const editor = new ImageEditorService(editorTasks, {
    name: "fake-editor", version: "1", capabilitiesVersion: "1",
    capabilities: () => ({ imageToImage: true, addText: true, changeText: true, redraw: true, erase: true, outpaint: true, currentVersionInput: true }),
    edit: (command, source) => requestImageEditorEdit({
      async edit(request) {
        editorCalls.push(request);
        return { bytes: command.type === "change_text" ? changedText : restored, mimeType: "image/png" };
      },
    }, storage, "fake", defaultImageOptions("gpt-image-2"), command, source),
  }, storage, makeAplusEditorSourceResolver(suites, studioTasks, editorTasks, storage), {
    name: "fake-ocr", version: "1",
    async recognize(source) {
      ocrCalls.push(source);
      return { blocks: [{ id: "title", text: "Original headline", confidence: 0.99, bounds: ocrBounds, rotation: 0 }] };
    },
  });
  const app = createSuiteStudioApp({
    repository: suites, storage, productCardRepository: cards,
    imageEditorApi: createImageEditorApi(editor),
    promptRepository: prompts, taskRepository: studioTasks,
    platformRepository: new MemoryPlatformRepository([
      { ...profile, code: "amazon", name: "Amazon", marketScope: "overseas", sortOrder: 1 },
      { ...profile, code: "taobao", name: "淘宝", marketScope: "domestic", sortOrder: 2 },
      { ...profile, code: "shopify", name: "Shopify", marketScope: "overseas", sortOrder: 3 },
    ]),
    provider: {
      supportsMultipleImages: true,
      async edit(request) {
        imageCalls.push(request);
        if (imageCalls.length > 1) await imageGate;
        return { bytes: request.prompt.includes('"moduleCode": "usage_scene"') ? usage : hero, mimeType: "image/png" };
      },
    },
    llmClient: {
      provider: "fake", model: "fake-vision", isFake: true,
      async generateAplusAiWrite() {
        return "用侧光呈现磨砂杯身。\n" + "画面说明".repeat(250);
      },
      async generatePlan() {
        await planningGate;
        const { modules, sizePresets, language } = planningInput;
        return {
          schemaVersion: "aplus-plan-v1", taskName: `随行杯方案 ${++nextPlan}`, globalPlan: "米白背景与柔和侧光",
          modules: modules.map((moduleCode) => ({
            moduleCode, copyRequirements: language === "none" ? "" : "初稿文案",
            imagePrompts: Object.fromEntries(sizePresets.map((key) => [key, "服务端保留画面要求"])),
          })),
        };
      },
    },
  });

  const vite = await createServer({
    cacheDir: "node_modules/.vite-browser-aplus-studio",
    configFile: false,
    server: { host: "127.0.0.1", port: 0, watch: null },
    esbuild: { jsx: "automatic" },
    plugins: [{
      name: "offline-aplus-api",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const path = req.url ?? "/";
          if (!path.startsWith("/api/")) return next();
          try {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const buffer = Buffer.concat(chunks);
            const inputPreview = path.match(/^\/api\/suites\/([^/]+)\/input-images\/([^/]+)\/preview\/(original|thumbnail)$/);
            const uploaded = req.method === "POST"
              ? await dispatchInputImageUpload(app, path, buffer, req.headers) : null;
            let result = uploaded;
            if (inputPreview) result = await app.preview(inputPreview[1], inputPreview[2], inputPreview[3]);
            if (!result) {
              const body = buffer.length ? JSON.parse(buffer.toString("utf8")) : undefined;
              if (req.method === "POST" && (path === "/api/aplus" || path.endsWith("/replan"))) planningInput = body;
              if (req.method === "POST" && path.endsWith("/confirm")) confirmations.push(body);
              result = await app.request(req.method, path, { headers: req.headers, body });
            }
            res.writeHead(result.status, result.raw ? result.headers : { "content-type": "application/json" });
            res.end(result.raw ?? JSON.stringify(result.body));
          } catch (error) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: String(error) } }));
          }
        });
      },
    }],
  });
  await vite.listen();
  t.after(() => vite.close());
  return { baseUrl: vite.resolvedUrls.local[0], app, card, confirmations, imageCalls, editorCalls, ocrCalls };
}

async function firstPixel(bytes) {
  return [...await sharp(bytes).extract({ left: 0, top: 0, width: 1, height: 1 }).removeAlpha().raw().toBuffer()];
}

test("A+ 选卡出图后可改字并更新交付图和长图，生成记录可切换批次", async (t) => {
  const planningGate = Promise.withResolvers();
  const imageGate = Promise.withResolvers();
  t.after(() => { planningGate.resolve(); imageGate.resolve(); });
  const { baseUrl, card, confirmations, imageCalls, editorCalls, ocrCalls } = await startOfflineAplus(t, {
    planningGate: planningGate.promise, imageGate: imageGate.promise,
  });
  const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error));
  const url = (path) => new URL(path, baseUrl).href;
  const button = (name) => page.getByRole("button", { name, exact: true });
  const config = page.getByRole("complementary", { name: "A+详情配置" });

  await page.goto(url("/products"));
  await page.locator(`[data-product-card-id="${card.id}"]`).getByRole("button", { name: "生成 A+" }).click();
  await page.waitForURL(url(`/create/aplus?productCardId=${card.id}`));
  const selected = config.locator("[data-selected-product-card-bar]");
  await selected.getByText(card.name, { exact: true }).waitFor();
  assert.ok(await button("生成策划方案").isDisabled());
  assert.equal(await config.getByRole("checkbox", { name: /普通 A\+/ }).isChecked(), true);

  await config.getByLabel("上传商品原图").setInputFiles("public/assets/gan65-product.jpg");
  await config.locator(".ss-thumb").waitFor();
  const extraModules = APLUS_MODULES.slice(6, 10).map(({ name }) => config.getByRole("checkbox", { name, exact: true }));
  for (const checkbox of extraModules) await checkbox.check();
  await config.getByRole("checkbox", { name: "工艺制作图", exact: true }).click();
  await config.getByText("最多可选 10 个模块，请先取消一个已选模块。").waitFor();
  assert.equal(await config.getByRole("checkbox", { name: "工艺制作图", exact: true }).isChecked(), false);
  for (const checkbox of extraModules) await checkbox.uncheck();
  for (const name of ["多角度图", "场景氛围图", "商品细节图"]) {
    await config.getByRole("checkbox", { name, exact: true }).uncheck();
  }
  await config.getByRole("checkbox", { name: /高级 A\+（Web 端）/ }).check();
  await config.getByRole("checkbox", { name: /高级 A\+（移动端）/ }).check();
  await button("生成策划方案").click();
  const progress = page.getByRole("progressbar", { name: "A+详情生成进度" });
  const steps = page.getByRole("list", { name: "A+详情阶段进度" }).getByRole("listitem");
  const stepStates = () => steps.evaluateAll((items) => items.map((item) => item.dataset.stepState));
  await page.locator(".ss-status").filter({ hasText: "策划中…" }).waitFor();
  assert.equal(await progress.getAttribute("aria-valuenow"), "25");
  assert.match(await progress.getAttribute("aria-valuetext"), /正在分析商品原图与卖点/);
  assert.deepEqual(await steps.allTextContents(), ["1策划方案", "2确认方案", "3生成图片 (0/6)"]);
  assert.deepEqual(await stepStates(), ["active", "pending", "pending"]);
  planningGate.resolve();
  await button("确认出图").waitFor();
  await page.locator(".ss-status").filter({ hasText: "等待确认" }).waitFor();
  const firstUrl = page.url();

  const style = config.getByLabel("视觉风格");
  assert.equal(await style.inputValue(), "auto");
  await style.selectOption("dark_tech");
  await button("方案已失效，重新规划").waitFor();
  await style.selectOption("auto");
  await button("确认出图").waitFor();

  const platform = config.getByLabel("平台", { exact: true });
  await platform.selectOption("taobao");
  await button("方案已失效，重新规划").waitFor();
  assert.equal(await config.getByRole("checkbox", { name: /普通 A\+/ }).count(), 0);
  assert.equal(await config.getByRole("checkbox", { name: "3:4", exact: true }).isChecked(), true);
  await platform.selectOption("shopify");
  assert.equal(await config.getByRole("checkbox", { name: "1:1", exact: true }).isChecked(), true);
  assert.equal(await config.getByRole("checkbox", { name: "3:4", exact: true }).isChecked(), false);
  await platform.selectOption("amazon");
  assert.equal(await config.getByRole("checkbox", { name: /普通 A\+/ }).isChecked(), true);
  await config.getByRole("checkbox", { name: /高级 A\+（Web 端）/ }).check();
  await config.getByRole("checkbox", { name: /高级 A\+（移动端）/ }).check();
  await button("确认出图").waitFor();

  await config.getByText("分辨率 · 2K", { exact: true }).click();
  await config.getByLabel("出图分辨率").selectOption("1K");
  await page.getByText("策划思路", { exact: true }).click();
  assert.equal(await page.getByText("米白背景与柔和侧光").isVisible(), false);
  const copy = page.getByLabel("使用场景图文案要求");
  await copy.fill("通勤途中随手取用");
  const plan = page.getByRole("region", { name: "方案确认" });
  await plan.getByRole("img", { name: "拖动排序 使用场景图" }).dragTo(plan.locator("li").first());
  assert.match(await plan.locator("li").first().innerText(), /使用场景图/);
  await plan.getByRole("button", { name: "删除 核心卖点图" }).click();
  assert.equal(await page.getByText("服务端保留画面要求").count(), 0);

  await page.getByRole("link", { name: "生图画布" }).click();
  await page.getByRole("link", { name: "A+详情" }).click();
  await button("确认出图").waitFor();
  assert.equal(await copy.inputValue(), "通勤途中随手取用");
  assert.match(await plan.locator("li").first().innerText(), /使用场景图/);
  await button("保存方案").click();
  await button("保存方案").waitFor({ state: "detached" });

  await button("确认出图").click();
  await page.locator(".ss-status").filter({ hasText: "生成中 1/4" }).waitFor();
  assert.equal(await progress.getAttribute("aria-valuenow"), "53");
  assert.match(await progress.getAttribute("aria-valuetext"), /已完成 1\/4 张/);
  assert.deepEqual(await stepStates(), ["done", "done", "active"]);
  assert.match(await steps.last().textContent(), /生成图片 \(1\/4\)/);
  await page.locator(".aplus-card-image.is-pending").first().waitFor();
  imageGate.resolve();
  await page.getByText("已完成 · 4 张", { exact: true }).waitFor();
  const groups = page.locator(".aplus-results-group");
  assert.equal(await groups.count(), 2);
  assert.equal(await groups.locator("article").getByRole("button", { name: /上移|下移/ }).count(), 0);
  assert.deepEqual(await groups.first().locator(".aplus-card-body strong").allTextContents(), ["使用场景图", "首屏主视觉"]);
  assert.equal(confirmations[0].resolution, "1K");
  assert.equal(confirmations[0].productCardId, card.id);
  assert.equal(confirmations[0].productCardRevision, 1);
  assert.deepEqual(confirmations[0].modules, ["hero", "selling_points", "usage_scene"]);
  assert.match(imageCalls[0].prompt, /通勤途中随手取用/);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    groups.first().getByRole("button", { name: "下载", exact: true }).first().click(),
  ]);
  const delivery = await sharp(await download.path()).metadata();
  assert.deepEqual([delivery.width, delivery.height], [1464, 600]);
  await groups.first().getByRole("button", { name: "重绘", exact: true }).first().click();
  const redrawPrompt = page.getByLabel("附加提示词（选填）");
  assert.equal(await redrawPrompt.getAttribute("maxlength"), "500");
  await redrawPrompt.fill("增强杯盖细节");
  await button("确认重绘").click();
  await page.getByText("图片已更新", { exact: true }).waitFor();
  assert.match(imageCalls.at(-1).prompt, /单卡人工补充：增强杯盖细节/);
  await groups.first().getByRole("button", { name: "图片编辑", exact: true }).first().click();
  const editor = page.getByRole("dialog", { name: "图片编辑器" });
  await editor.waitFor();
  await editor.getByRole("button", { name: "关闭图片编辑器" }).click();

  const web = groups.first();
  const mobile = groups.nth(1);
  const batchId = new URL(firstUrl).searchParams.get("suite");
  async function readLongPreview() {
    const imageResponse = page.waitForResponse((response) => response.url().includes("/long-image?preset=aplus_premium_web"));
    await web.getByRole("button", { name: "预览详情长图" }).click();
    const dialog = page.getByRole("dialog", { name: /Web 端.*详情长图/ });
    await dialog.getByRole("img", { name: "详情长图" }).waitFor();
    const response = await imageResponse;
    assert.equal(response.status(), 200);
    const bytes = await response.body();
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    return bytes;
  }

  const photo = web.getByRole("button", { name: "放大 使用场景图", exact: true });
  const photoUrl = await photo.locator("img").getAttribute("src");
  await photo.click();
  const singleDialog = page.getByRole("dialog", { name: "使用场景图", exact: true });
  const singleImage = singleDialog.getByRole("img", { name: "使用场景图" });
  await singleImage.evaluate((img) => img.decode());
  assert.equal(await singleImage.getAttribute("src"), photoUrl);
  await singleDialog.getByRole("button", { name: "关闭" }).click();
  await singleDialog.waitFor({ state: "hidden" });
  await photo.dragTo(web.locator("article").last());
  assert.equal(await page.getByRole("dialog").count(), 0);
  await web.locator("article").last().getByRole("button", { name: "重绘" }).dragTo(web.locator("article").first());
  assert.deepEqual(await firstPixel(await readLongPreview()), [255, 0, 0]);
  await web.getByRole("img", { name: "拖动排序 首屏主视觉" }).dragTo(web.locator("article").first());
  await web.locator("article").first().getByText("首屏主视觉", { exact: true }).waitFor();
  assert.deepEqual(await web.locator(".aplus-card-body strong").allTextContents(), ["首屏主视觉", "使用场景图"]);
  assert.deepEqual(await mobile.locator(".aplus-card-body strong").allTextContents(), ["首屏主视觉", "使用场景图"]);
  assert.deepEqual(await firstPixel(await readLongPreview()), [0, 0, 128]);
  const [longDownload] = await Promise.all([
    page.waitForEvent("download"), web.getByRole("button", { name: "下载详情长图" }).click(),
  ]);
  const longMetadata = await sharp(await longDownload.path()).metadata();
  assert.deepEqual([longMetadata.width, longMetadata.height], [1464, 1200]);

  const heroCard = web.locator("article").first();
  const oldDeliveryUrl = await heroCard.locator(".aplus-card-image img").getAttribute("src");
  assert.ok(oldDeliveryUrl.endsWith("/preview/delivery"));
  const sourceUrl = oldDeliveryUrl.slice(0, -"/delivery".length);
  await heroCard.getByRole("button", { name: "AI 改字", exact: true }).click();
  const replacement = editor.getByLabel("新文字：Original headline", { exact: true });
  await replacement.waitFor();
  assert.equal(await editor.locator(".wb-editor-canvas img").getAttribute("src"), sourceUrl);
  const sourceBytes = await (await page.request.get(url(sourceUrl))).body();
  assert.equal(ocrCalls.length, 1);
  assert.deepEqual(ocrCalls[0].bytes, sourceBytes);
  assert.deepEqual([ocrCalls[0].width, ocrCalls[0].height], [2496, 1024]);

  await replacement.fill("New headline");
  const submitEdit = page.waitForResponse((response) => response.url().endsWith("/submit"));
  await editor.getByRole("button", { name: "开始生成（新建编辑子卡）", exact: true }).click();
  const submitted = await submitEdit;
  assert.equal(submitted.status(), 202);
  const { snapshot } = (await submitted.json()).data;
  assert.equal(snapshot.tool, "change_text");
  assert.equal(snapshot.operations.length, 1);
  const { originalText, newText, region, ocrSnapshot } = snapshot.operations[0].payload;
  assert.equal(originalText, "Original headline");
  assert.equal(newText, "New headline");
  assert.deepEqual(region, { ...ocrBounds, rotation: 0 });
  assert.equal(sourceUrl, `/api/suite-tasks/${snapshot.sourceCardId}/versions/${ocrSnapshot.sourceVersionId}/preview`);
  await editor.waitFor({ state: "hidden" });
  const editedImage = heroCard.locator('img[src^="/api/image-editor/tasks/"][src$="/preview/delivery"]');
  await editedImage.waitFor();
  const editedDeliveryUrl = await editedImage.getAttribute("src");
  const editedDelivery = await (await page.request.get(url(editedDeliveryUrl))).body();
  const editedMetadata = await sharp(editedDelivery).metadata();
  assert.deepEqual([editedMetadata.width, editedMetadata.height], [1464, 600]);
  assert.deepEqual(await firstPixel(editedDelivery), [0, 255, 255]);
  assert.equal(editorCalls[0].size, "2496x1024");
  assert.deepEqual(editorCalls[0].image, sourceBytes);
  assert.deepEqual(editorCalls[0].images.map(({ role }) => role), ["source"]);
  assert.deepEqual(await firstPixel(await readLongPreview()), [0, 255, 255]);

  await web.getByRole("button", { name: "商品还原", exact: true }).first().click();
  await editor.getByRole("group", { name: "商品外观依据" }).waitFor();
  assert.equal(await editor.getByRole("radio", { name: "使用全部商品原图" }).isChecked(), true);
  await editor.getByRole("radio", { name: "原图 1" }).waitFor();
  await editor.getByRole("button", { name: "还原商品", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  await heroCard.locator(`img[src$="/preview/delivery"]:not([src="${editedDeliveryUrl}"])`).waitFor();
  assert.match(editorCalls[1].prompt, /其余为商品外观依据/);
  assert.deepEqual(editorCalls[1].images.map(({ role }) => role), ["source", "product"]);
  assert.deepEqual(await firstPixel(await readLongPreview()), [0, 255, 0]);

  const [zipDownload] = await Promise.all([page.waitForEvent("download"), button("下载 ZIP").click()]);
  const zip = readZipEntries(await readFile(await zipDownload.path()));
  assert.equal(zip.size, 7);
  assert.deepEqual(await firstPixel(zip.get("aplus_premium_web/01_hero.png")), [0, 255, 0]);
  assert.deepEqual(await firstPixel(zip.get("aplus_premium_mobile/01_hero.png")), [0, 0, 128]);

  await mobile.locator("article").last().locator(".aplus-card-body").dragTo(mobile.locator("article").first(), { sourcePosition: { x: 5, y: 5 } });
  await mobile.locator("article").first().getByText("使用场景图", { exact: true }).waitFor();
  for (const group of [web, mobile]) {
    assert.deepEqual(await group.locator(".aplus-card-body strong").allTextContents(), ["使用场景图", "首屏主视觉"]);
  }
  assert.deepEqual(await firstPixel(await readLongPreview()), [255, 0, 0]);

  await button("改名").click();
  await page.getByLabel("任务名").fill("通勤随行杯 A+");
  await button("保存").click();
  await page.getByRole("heading", { name: "通勤随行杯 A+" }).waitFor();

  await button("＋ 新建").click();
  await config.getByLabel("上传商品原图").setInputFiles("public/assets/gan65-product.jpg");
  await config.getByLabel("商品卖点与生成要求").fill("磨砂杯身");
  await config.getByLabel("平台", { exact: true }).selectOption("taobao");
  await config.getByLabel("输出语言").selectOption("none");
  await button("生成策划方案").click();
  await button("确认出图").waitFor();
  const secondUrl = page.url();
  assert.notEqual(secondUrl, firstUrl);
  assert.equal(await plan.locator("textarea").count(), 0);
  await config.getByLabel("平台", { exact: true }).selectOption("amazon");
  await button("方案已失效，重新规划").click();
  await button("确认出图").waitFor();
  assert.notEqual(page.url(), secondUrl);
  await button("确认出图").click();
  await page.getByText("已完成 · 6 张", { exact: true }).waitFor();
  assert.equal(await button("AI 改字").count(), 0);

  const feedRequest = page.waitForRequest((request) => request.url().includes("/api/suites/feed?origin=aplus"));
  await button("生成记录").click();
  await feedRequest;
  await page.getByRole("dialog", { name: "生成记录" }).getByText("通勤随行杯 A+", { exact: true }).click();
  await page.waitForURL(firstUrl);
  await page.getByText("已完成 · 4 张", { exact: true }).waitFor();
  await groups.first().getByRole("button", { name: "删除", exact: true }).first().click();
  await button("确认删除").click();
  await page.getByText("已完成 · 3 张", { exact: true }).waitFor();
  await mobile.locator("article").filter({ hasText: "使用场景图" }).getByRole("button", { name: "删除", exact: true }).click();
  await button("确认删除").click();
  await page.getByText("已完成 · 2 张", { exact: true }).waitFor();
  assert.equal(await groups.getByRole("img", { name: /^拖动排序/ }).count(), 0);
  assert.equal(await groups.locator('article[draggable="true"]').count(), 0);

  await page.goto(url(`/create/canvas/${batchId}`));
  await page.getByText("A+详情批次暂不支持在生图画布中打开。").waitFor();

  await page.goto(firstUrl);
  await page.getByRole("heading", { name: "通勤随行杯 A+" }).waitFor();
  const confirmation = page.waitForEvent("dialog");
  page.once("dialog", (dialog) => dialog.dismiss());
  await button("删除批次").click();
  assert.match((await confirmation).message(), /通勤随行杯 A\+.*从生成记录中移除/);
  assert.equal(page.url(), firstUrl);
  page.once("dialog", (dialog) => dialog.accept());
  const deleted = page.waitForResponse((response) => response.request().method() === "DELETE" && response.url() === url(`/api/suites/${batchId}`));
  await button("删除批次").click();
  assert.equal((await deleted).status(), 200);
  await page.waitForURL(url("/create/aplus"));
  assert.equal(await config.locator(".ss-thumb").count(), 0);
  const refreshedFeed = page.waitForResponse((response) => response.url().includes("/api/suites/feed?origin=aplus"));
  await button("生成记录").click();
  const { items } = (await (await refreshedFeed).json()).data;
  assert.equal(items.some(({ suite }) => suite.id === batchId), false);
  assert.equal(await page.getByRole("dialog", { name: "生成记录" }).getByText("通勤随行杯 A+", { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
});

test("A+ 有缓存草稿时仍更新 URL 预选卡，375px 创作栏可完整显示", async (t) => {
  const { baseUrl, app, card } = await startOfflineAplus(t);
  const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 375, height: 844 } });
  const config = page.getByRole("complementary", { name: "A+详情配置" });
  const selected = config.locator("[data-selected-product-card-bar]");
  await page.goto(new URL(`/create/aplus?productCardId=${card.id}`, baseUrl).href);
  await selected.getByText(card.name, { exact: true }).waitFor();
  const tools = page.getByRole("navigation", { name: "创作功能" });
  assert.ok(await tools.evaluate((nav) => nav.scrollWidth <= nav.clientWidth), "创作栏不能横向溢出");

  const sellingPoints = config.getByLabel("商品卖点与生成要求");
  await sellingPoints.fill("保留本地生成要求");
  const cardPath = `/api/product-cards/${card.id}`;
  const revisedName = "更新后的磨砂随行杯";
  const revised = await app.request("PATCH", cardPath, { body: { name: revisedName } });
  assert.equal(revised.status, 200, JSON.stringify(revised.body));
  await page.reload();
  await selected.getByText(revisedName, { exact: true }).waitFor();
  assert.equal(await sellingPoints.inputValue(), "保留本地生成要求");

  const archived = await app.request("POST", `${cardPath}/archive`);
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  await page.reload();
  const picker = config.getByRole("button", { name: "选择商品信息卡（选填）", exact: true });
  await picker.waitFor();
  await page.getByText("指定商品信息卡已归档，请重新选择。", { exact: true }).waitFor();
  assert.equal(await selected.count(), 0);
  assert.equal(await sellingPoints.inputValue(), "保留本地生成要求");
});

test("A+ 卖点输入随选卡切换，帮写支持编辑与撤销，移除商品卡后清除撤销记录", async (t) => {
  const { baseUrl, card } = await startOfflineAplus(t);
  const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const config = page.getByRole("complementary", { name: "A+详情配置" });
  const aiWrite = config.getByRole("button", { name: "AI 帮写", exact: true });
  const undo = config.getByRole("button", { name: "撤销帮写", exact: true });
  const info = config.getByLabel("商品卖点与生成要求");
  const plan = config.getByRole("button", { name: "生成策划方案", exact: true });
  const picker = config.getByRole("button", { name: "选择商品信息卡（选填）", exact: true });
  const heading = (name) => config.getByRole("heading", { name, exact: true });
  async function selectCard() {
    await picker.click();
    const dialog = page.getByRole("dialog", { name: "选择商品信息卡" });
    await dialog.locator(`[data-picker-card-id="${card.id}"]`).click();
    await dialog.getByRole("button", { name: "确认选择" }).click();
  }
  let releaseWrite;
  const waiting = new Promise((resolve) => { releaseWrite = resolve; });
  await page.route("**/api/aplus/ai-write", async (route) => {
    await waiting;
    await route.continue();
  });
  t.after(releaseWrite);

  const startUrl = new URL("/create/aplus", baseUrl).href;
  await page.goto(startUrl);
  await heading("商品卖点 & 生成要求").waitFor();
  assert.equal(await aiWrite.count(), 0);
  assert.match(await info.getAttribute("placeholder"), /1. 产品名称[\s\S]*5. 具体参数/);
  assert.ok(await picker.evaluate((button) => {
    const textarea = button.closest("section")?.querySelector("textarea");
    return textarea && Boolean(button.compareDocumentPosition(textarea) & Node.DOCUMENT_POSITION_FOLLOWING);
  }));
  const tip = config.getByRole("button", { name: "商品卖点填写说明" });
  await tip.click();
  await page.getByRole("tooltip").getByText(/请填写已确认的商品事实/).waitFor();
  await page.keyboard.press("Escape");
  await selectCard();
  await tip.click();
  await page.getByRole("tooltip").getByText(/客观商品事实已由所选商品信息卡自动注入/).waitFor();
  await page.keyboard.press("Escape");
  await heading("补充卖点 & 本次生成要求（选填）").waitFor();
  assert.match(await info.getAttribute("placeholder"), /所选商品信息卡自动注入/);
  assert.equal(await aiWrite.isDisabled(), true);
  await config.getByText("请先上传商品原图，再使用 AI 帮写。").waitFor();
  await config.getByLabel("上传商品原图").setInputFiles("public/assets/gan65-product.jpg");
  await config.locator(".ss-thumb").waitFor();
  await info.fill("原有卖点：磨砂杯身");
  await aiWrite.click();
  const pending = config.getByRole("button", { name: "AI 帮写中…", exact: true });
  await pending.waitFor();
  assert.equal(await pending.isDisabled(), true);
  assert.equal(await pending.getAttribute("aria-busy"), "true");
  releaseWrite();
  await config.getByText("AI 帮写结果超过 1000 字，已截断。").waitFor();
  assert.match(await info.inputValue(), /用侧光呈现磨砂杯身/);
  assert.equal(Array.from(await info.inputValue()).length, 1000);
  await info.fill("手动调整构图");
  await config.getByText("AI 帮写结果超过 1000 字，已截断。").waitFor({ state: "detached" });
  await undo.click();
  assert.equal(await info.inputValue(), "原有卖点：磨砂杯身");
  await undo.waitFor({ state: "detached" });

  await aiWrite.click();
  await undo.waitFor();
  await config.getByRole("button", { name: "移除", exact: true }).click();
  await heading("商品卖点 & 生成要求").waitFor();
  assert.equal(await aiWrite.count(), 0);
  assert.equal(await undo.count(), 0);
  await selectCard();
  assert.equal(await undo.count(), 0);
  await plan.click();
  await page.getByRole("button", { name: "确认出图", exact: true }).waitFor();
  assert.notEqual(page.url(), startUrl);
});
