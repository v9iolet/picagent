// npx tsx --test tests/browser-listing-copy.mjs (offline, in-memory only)
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";
import { createTicket02App } from "../server/app.js";
import { dispatchInputImageUpload } from "../server/multipart.js";
import { parseNormalizedPromptMarkdown } from "../server/prompt-library.js";
import { MemoryPromptRepository } from "../server/repositories/memory-prompt-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryTaskRepository } from "../server/repositories/memory-task-repository.js";
import { MemoryPlanRepository } from "../server/repositories/memory-plan-repository.js";
import { MemoryCategoryPromptRepository } from "../server/repositories/memory-category-prompt-repository.js";
import { MemoryLibraryRepository } from "../server/repositories/memory-library-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";
import { DETAIL_CATEGORY_CODES } from "../shared/suite-categories.js";

const photo = "public/assets/gan65-product.jpg";
const content = {
  schemaVersion: "listing-copy-v1",
  title: "Compact folding charger",
  bulletPoints: ["Foldable plug", "Compact body"],
  description: "A compact charger with a foldable plug.",
  searchTerms: ["foldable charger"],
  missingFacts: ["额定功率"],
};

async function offlineBrowser(t, pendingCopy) {
  const prompts = new MemoryPromptRepository();
  const library = new MemoryLibraryRepository();
  for (const name of ["general-listing-copy.md", "general-structure-plan-groups.md", "general-category-prompt-groups.md"]) {
    const [template] = await prompts.importRecords([
      parseNormalizedPromptMarkdown(await readFile(`prompt/normalized/${name}`, "utf8"), name),
    ]);
    await prompts.publishVersion(template.templateVersionId); // memory only
    library.addResource({
      id: template.templateVersionId, resourceVersionId: template.templateVersionId, templateVersionId: template.templateVersionId,
      title: template.name, stage: template.stage, summary: "离线模板", resourceType: "prompt_template", status: "published",
      createdAt: "2026-11-22T00:00:00Z", updatedAt: "2026-11-22T00:00:00Z", source: { versionNo: template.versionNo },
    });
  }
  const amazon = {
    code: "amazon", name: "Amazon", marketScope: "overseas", mainImageBackground: "flexible",
    mainImageStrategy: "", galleryStrategy: "", textStrategy: "", modelStrategy: "", sourceNote: "", sortOrder: 1,
    listingCopyRules: { titleMaxLength: 75, maxBulletPoints: 5, supportsSearchTerms: true, forbiddenWords: [] },
  };
  const taobao = {
    ...amazon, code: "taobao", name: "淘宝", marketScope: "domestic",
    listingCopyRules: { ...amazon.listingCopyRules, supportsSearchTerms: false },
  };
  const calls = [];
  const bytes = await readFile(photo);
  const app = createTicket02App({
    repository: new MemorySuiteRepository(),
    storage: new MemoryStorage(),
    promptRepository: prompts,
    libraryRepository: library,
    taskRepository: new MemoryTaskRepository(),
    planRepository: new MemoryPlanRepository(),
    categoryPromptRepository: new MemoryCategoryPromptRepository(),
    provider: { edit: async () => ({ bytes, mimeType: "image/jpeg" }) },
    platformRepository: {
      listEnabled: async () => [amazon, taobao],
      find: async (code) => [amazon, taobao].find((platform) => platform.code === code),
    },
    llmClient: {
      provider: "fake", model: "offline", isFake: true,
      async generatePlan(input) {
        if (input.flow === "listing-copy") {
          calls.push(input);
          await pendingCopy;
          return input.dynamicInput.platform === "taobao" ? { ...content, title: "折叠插脚充电器" } : content;
        }
        return {
          schemaVersion: "suite-structure-plan-v2", status: "READY_FOR_REVIEW",
          mainAllocation: { category: "main", count: 1, reason: "商品全貌", sourceImageIds: input.inputImageIds, factRefs: [], missingFacts: [] },
          detailImageCount: 0,
          categoryAllocations: [...DETAIL_CATEGORY_CODES].map((category) => ({
            category, count: 0, requirement: "optional", reason: "", sourceImageIds: [], factRefs: [], missingFacts: [],
          })),
          globalStyleCard: { promptPrefix: "统一棚拍" },
        };
      },
      async generateCategoryPrompt(input) {
        return {
          schemaVersion: "suite-category-prompt-v1", category: input.categoryCode,
          items: [{
            stableId: "main-one", category: "main", title: "产品全貌", purpose: "展示", prompt: "商品实拍",
            referenceImageIds: input.inputImageIds, factRefs: [], allowsTextOverlay: "no", textContent: [], aspectRatio: "1:1",
          }],
        };
      },
    },
  });
  const vite = await createServer({
    configFile: false,
    server: { host: "127.0.0.1", port: 0 },
    esbuild: { jsx: "automatic" },
    plugins: [{
      name: "offline-listing-copy",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const path = req.url ?? "/";
          if (!path.startsWith("/api/")) return next();
          try {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const bytes = Buffer.concat(chunks);
            const upload = req.method === "POST" && await dispatchInputImageUpload(app, path, bytes, req.headers);
            const preview = path.match(/^\/api\/suites\/([^/]+)\/input-images\/([^/]+)\/preview\/(original|thumbnail)$/);
            const version = path.match(/^\/api\/suite-tasks\/([^/]+)\/versions\/([^/]+)\/preview$/);
            const response = upload || (path === "/api/model-settings"
              ? { status: 200, body: { data: { channels: [], preferences: { image: null, vision: null } } } }
              : preview ? await app.preview(preview[1], preview[2], preview[3])
              : version ? await app.previewTaskVersion(version[1], version[2]) : await app.request(req.method, path, {
              headers: req.headers,
              body: bytes.length ? JSON.parse(bytes.toString()) : undefined,
              }));
            res.writeHead(response.status, response.raw ? response.headers : { "Content-Type": "application/json" });
            res.end(response.raw ?? JSON.stringify(response.body));
          } catch (error) {
            res.writeHead(500);
            res.end(String(error));
          }
        });
      },
    }],
  });
  await vite.listen();
  t.after(() => vite.close());
  const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, permissions: ["clipboard-read", "clipboard-write"] });
  page.setDefaultTimeout(8000);
  const url = vite.resolvedUrls.local[0];
  await page.route("**/*", (route) => route.request().url().startsWith(url) ? route.continue() : route.abort());
  return { app, calls, page, url };
}

test("独立文案：上传不产生套图批次，生成后编辑并保留两个版本", async (t) => {
  const { app, calls, page, url } = await offlineBrowser(t);
  await page.goto(url + "create/suite");
  await page.getByRole("navigation", { name: "创作功能" }).getByRole("link", { name: "上架文案" }).click();
  await page.waitForURL("**/create/listing-copy");
  await page.getByLabel("目标市场").fill("美国");
  const buffer = await readFile(photo);
  await page.getByLabel("上传商品图").setInputFiles(Array.from({ length: 7 }, (_, index) => ({
    name: `product-${index}.jpg`, mimeType: "image/jpeg", buffer,
  })));
  await page.getByRole("alert").getByText("最多可上传 6 张商品图。", { exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/create/listing-copy");
  await page.getByLabel("上传商品图").setInputFiles(photo);
  await page.waitForURL(/\/create\/listing-copy\/[0-9a-f-]+$/);
  const jobPath = `/api/listing-copies/${new URL(page.url()).pathname.split("/").at(-1)}`;
  assert.deepEqual((await app.request("GET", "/api/listing-copies")).body.data.items, []);
  assert.deepEqual((await app.request("GET", "/api/suites/feed")).body.data.items, []);
  assert.equal(await page.getByLabel("目标市场").inputValue(), "美国");
  await page.getByLabel("平台", { exact: true }).selectOption("amazon");
  await page.getByLabel("语言", { exact: true }).fill("English");
  await page.getByLabel("商品卖点").fill("折叠插脚");
  await page.getByRole("button", { name: "生成文案", exact: true }).click();
  await page.getByText("文案生成成功", { exact: true }).waitFor();
  assert.equal(calls[0].dynamicInput.target_market, "美国");
  assert.equal(calls[0].dynamicInput.output_language, "English");
  assert.equal(calls[0].dynamicInput.selling_points, "折叠插脚");
  assert.equal(calls[0].visionImages.length, 1);
  assert.equal(await page.getByLabel("标题", { exact: true }).inputValue(), content.title);
  await page.getByRole("button", { name: "复制标题" }).click();
  await page.getByText("已复制标题", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), content.title);
  await page.getByLabel("标题", { exact: true }).fill("Travel charger with foldable plug");
  await page.getByLabel("五点描述", { exact: true }).fill("Folds flat\nFits small bags");
  await page.getByLabel("商品描述", { exact: true }).fill("A charger sized for travel.");
  await page.getByLabel("搜索词", { exact: true }).fill("travel charger\nfolding plug");
  await page.getByRole("button", { name: "保存为新版本" }).click();
  const versions = page.getByRole("region", { name: "版本历史" });
  await versions.getByRole("button", { name: /版本 2/ }).waitFor();
  await page.reload();
  await versions.getByRole("button", { name: /版本 2/ }).waitFor();
  assert.equal(await versions.getByRole("button").count(), 2);
  assert.equal(await page.getByLabel("标题", { exact: true }).inputValue(), "Travel charger with foldable plug");
  await versions.getByRole("button", { name: /版本 1/ }).click();
  assert.equal(await page.getByLabel("标题", { exact: true }).inputValue(), content.title);
  const job = (await app.request("GET", jobPath)).body.data;
  assert.equal(job.status, "succeeded");
  assert.deepEqual(job.versions.map((v) => v.content), [content, {
    ...content, title: "Travel charger with foldable plug", bulletPoints: ["Folds flat", "Fits small bags"],
    description: "A charger sized for travel.", searchTerms: ["travel charger", "folding plug"],
  }]);
  await page.screenshot({ path: "tests/browser/listing-copy-standalone.png", fullPage: true });
  await page.getByLabel("目标市场").fill("英国");
  await page.getByRole("button", { name: "重新生成", exact: true }).click();
  await versions.getByRole("button", { name: /版本 3/ }).waitFor();
  assert.equal(calls[1].dynamicInput.target_market, "英国");
  assert.equal((await app.request("GET", jobPath)).body.data.status, "succeeded");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  await page.screenshot({ path: "tests/browser/listing-copy-mobile.png", fullPage: true });
});

test("套图附加文案：开启开关后抽屉显示关联结果，原批次可用作独立文案输入", async (t) => {
  const pendingCopy = Promise.withResolvers();
  const { app, page, url } = await offlineBrowser(t, pendingCopy.promise);
  try {
    await page.goto(url + "create/suite");
    await page.locator('input[type="file"]').setInputFiles(photo);
    await page.getByLabel("平台", { exact: true }).selectOption("taobao");
    await page.getByRole("button", { name: "自定义配置", exact: true }).click();
    for (const [group, n] of [["卖点图", 3], ["场景图", 2], ["其他", 1]]) {
      for (let i = 0; i < n; i++) await page.getByRole("button", { name: new RegExp(`^减少${group}`) }).click();
    }
    await page.getByLabel("商品上架文案生成").check();
    await page.getByRole("button", { name: "一键生成套图与商品上架文案（1张）", exact: true }).click();
    const batch = page.getByRole("region", { name: "生成批次" });
    await batch.locator('[data-status="completed"]').waitFor({ timeout: 25000 }).catch(async (error) => {
      const id = new URL(page.url()).pathname.split("/").at(-1);
      const state = (await app.request("GET", `/api/suites/${id}/studio-state`)).body.data;
      throw new Error(`套图未完成：${JSON.stringify(state?.pipeline ?? await page.locator('main').innerText())}`, { cause: error });
    });
    await batch.getByRole("button", { name: "上架文案", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "商品上架文案" });
    await drawer.getByText("正在生成文案…", { exact: true }).waitFor();
    pendingCopy.resolve();
    await drawer.getByText("文案生成成功", { exact: true }).waitFor();
    assert.equal(await drawer.getByLabel("标题", { exact: true }).inputValue(), "折叠插脚充电器");
    assert.equal(await drawer.getByLabel("卖点短句", { exact: true }).inputValue(), "Foldable plug\nCompact body");
    assert.equal(await drawer.getByLabel("搜索词", { exact: true }).count(), 0);
    assert.equal(await drawer.getByRole("button", { name: /版本 1/ }).count(), 1);
    const suiteId = new URL(page.url()).pathname.split("/").at(-1);
    const { listingCopy } = (await app.request("GET", `/api/suites/${suiteId}/studio-state`)).body.data;
    assert.equal(listingCopy.sourceSuiteId, suiteId);
    assert.equal(listingCopy.status, "succeeded");
    await page.screenshot({ path: "tests/browser/listing-copy-drawer.png" });
    await drawer.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("navigation", { name: "创作功能" }).getByRole("link", { name: "上架文案" }).click();
    await page.getByRole("button", { name: "从图片库选套图批次" }).click();
    const picker = page.getByRole("dialog", { name: "从图片库选择套图批次" });
    await picker.getByRole("button", { name: "gan65-product", exact: true }).click();
    await page.waitForURL(/\/create\/listing-copy\/[0-9a-f-]+$/);
    const independentId = new URL(page.url()).pathname.split("/").at(-1);
    assert.notEqual(independentId, listingCopy.id);
    await page.getByRole("button", { name: "生成文案", exact: true }).click();
    await page.getByRole("main").getByText("文案生成成功", { exact: true }).first().waitFor();
    const independent = (await app.request("GET", `/api/listing-copies/${independentId}`)).body.data;
    assert.equal(independent.sourceSuiteId, suiteId);
    assert.equal(independent.platform, "taobao");
    assert.equal(independent.inputImages.length, 1);
    assert.equal(independent.versions[0].content.title, "折叠插脚充电器");
  } finally {
    pendingCopy.resolve();
  }
});

test("模板库：上架文案阶段显示名称并筛除其他模板", async (t) => {
  const { page, url } = await offlineBrowser(t);
  await page.goto(url + "templates");
  await page.getByText("商品套图分组结构计划", { exact: true }).first().waitFor();
  const listing = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "商品上架文案", exact: true }) });
  await listing.waitFor();
  assert.equal(await listing.getByText("上架文案", { exact: true }).isVisible(), true);
  const response = page.waitForResponse((r) => new URL(r.url()).searchParams.get("stage") === "listing_copy");
  await page.getByRole("radio", { name: "上架文案", exact: true }).check();
  assert.equal((await response).status(), 200);
  await page.getByText("商品套图分组结构计划", { exact: true }).first().waitFor({ state: "detached" });
  assert.equal(await listing.isVisible(), true);
});
