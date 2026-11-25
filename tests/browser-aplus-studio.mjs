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
import { MemoryPlatformRepository } from "../server/repositories/memory-platform-repository.js";
import { MemoryProductCardRepository } from "../server/repositories/memory-product-card-repository.js";
import { MemoryPromptRepository } from "../server/repositories/memory-prompt-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryTaskRepository } from "../server/repositories/memory-task-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";
import { APLUS_MODULES } from "../shared/aplus.js";
import { emptyProductCardFields } from "../shared/product-card.js";

async function startOfflineAplus(t) {
  const prompts = new MemoryPromptRepository();
  const names = ["aplus-plan", "aplus-image", ...APLUS_MODULES.map(({ code }) => `aplus-module-${code}`)];
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
  const output = await sharp({ create: { width: 120, height: 80, channels: 3, background: "navy" } }).png().toBuffer();
  let planningInput = null;
  let nextPlan = 0;
  const confirmations = [];
  const imageCalls = [];
  const storage = new MemoryStorage();
  const editor = new ImageEditorService(new MemoryImageEditorRepository(), {
    name: "fake-editor", version: "1", capabilitiesVersion: "1",
    capabilities: () => ({ imageToImage: true, addText: true, changeText: true, redraw: true, erase: true, outpaint: true, currentVersionInput: true }),
    edit: async () => ({ bytes: output, mimeType: "image/png", width: 120, height: 80 }),
  }, storage);
  const app = createSuiteStudioApp({
    repository: new MemorySuiteRepository(), storage, productCardRepository: cards,
    imageEditorApi: createImageEditorApi(editor),
    promptRepository: prompts, taskRepository: studioTasks,
    platformRepository: new MemoryPlatformRepository([
      { ...profile, code: "amazon", name: "Amazon", marketScope: "overseas", sortOrder: 1 },
      { ...profile, code: "taobao", name: "淘宝", marketScope: "domestic", sortOrder: 2 },
    ]),
    provider: {
      supportsMultipleImages: true,
      async edit(request) {
        imageCalls.push(request);
        return { bytes: output, mimeType: "image/png" };
      },
    },
    llmClient: {
      provider: "fake", model: "fake-vision", isFake: true,
      async generatePlan() {
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
    server: { host: "127.0.0.1", port: 0, watch: null },
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
  return { baseUrl: vite.resolvedUrls.local[0], card, confirmations, imageCalls };
}

test("A+ 从商品库选卡，调整方案后出图，生成记录可切换批次", async (t) => {
  const { baseUrl, card, confirmations, imageCalls } = await startOfflineAplus(t);
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
  await button("确认出图").waitFor();
  const firstUrl = page.url();

  const platform = config.getByLabel("平台", { exact: true });
  await platform.selectOption("taobao");
  await button("方案已失效，重新规划").waitFor();
  assert.equal(await config.getByRole("checkbox", { name: /普通 A\+/ }).count(), 0);
  assert.equal(await config.getByRole("checkbox", { name: "3:4", exact: true }).isChecked(), true);
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
  await page.getByText("已完成 · 4 张", { exact: true }).waitFor();
  const groups = page.locator(".aplus-results-group");
  assert.equal(await groups.count(), 2);
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
  await page.getByLabel("附加提示词（选填）").fill("增强杯盖细节");
  await button("确认重绘").click();
  await page.getByText("图片已更新", { exact: true }).waitFor();
  assert.match(imageCalls.at(-1).prompt, /单卡人工补充：增强杯盖细节/);
  await groups.first().getByRole("button", { name: "图片编辑", exact: true }).first().click();
  const editor = page.getByRole("dialog", { name: "图片编辑器" });
  await editor.waitFor();
  await editor.getByRole("button", { name: "关闭图片编辑器" }).click();

  await button("改名").click();
  await page.getByLabel("任务名").fill("通勤随行杯 A+");
  await button("保存").click();
  await page.getByRole("heading", { name: "通勤随行杯 A+" }).waitFor();

  await button("＋ 新建").click();
  await config.getByLabel("上传商品原图").setInputFiles("public/assets/gan65-product.jpg");
  await config.getByLabel("商品卖点&生成要求").fill("磨砂杯身");
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

  const feedRequest = page.waitForRequest((request) => request.url().includes("/api/suites/feed?origin=aplus"));
  await button("生成记录").click();
  await feedRequest;
  await page.getByRole("dialog", { name: "生成记录" }).getByText("通勤随行杯 A+", { exact: true }).click();
  await page.waitForURL(firstUrl);
  await page.getByText("已完成 · 4 张", { exact: true }).waitFor();
  await groups.first().getByRole("button", { name: "删除", exact: true }).first().click();
  await button("确认删除").click();
  await page.getByText("已完成 · 3 张", { exact: true }).waitFor();

  await page.goto(url(`/create/canvas/${new URL(firstUrl).searchParams.get("suite")}`));
  await page.getByText("A+详情批次暂不支持在生图画布中打开。").waitFor();
  assert.deepEqual(errors, []);
});
