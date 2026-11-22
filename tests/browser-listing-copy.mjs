// npx tsx --test tests/browser-listing-copy.mjs (offline, in-memory only)
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";
import { createSuiteStudioApp } from "../server/app.js";
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

async function offlineBrowser(t, { pendingCopy, legacyEtsy = false } = {}) {
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
    listingCopyRules: { titleMaxLength: 75, maxBulletPoints: 5, supportsSearchTerms: true, itemHighlightsMaxLength: 125, searchTermsMaxBytes: 250, forbiddenWords: [] },
  };
  const taobao = {
    ...amazon, code: "taobao", name: "淘宝", marketScope: "domestic",
    listingCopyRules: { titleMaxLength: 30, maxBulletPoints: 3, supportsSearchTerms: false, subtitleMaxLength: 40, forbiddenWords: [] },
  };
  const etsyRules = { titleMaxLength: 140, maxBulletPoints: 5, supportsSearchTerms: false, maxTags: 13, tagMaxLength: 20, forbiddenWords: [] };
  const etsy = { ...amazon, code: "etsy", name: "Etsy", listingCopyRules: legacyEtsy ? {
    titleMaxLength: 120, maxBulletPoints: 5, supportsSearchTerms: true, forbiddenWords: [],
  } : etsyRules };
  const profiles = [amazon, taobao, etsy];
  const calls = [];
  const bytes = await readFile(photo);
  const app = createSuiteStudioApp({
    repository: new MemorySuiteRepository(),
    storage: new MemoryStorage(),
    promptRepository: prompts,
    libraryRepository: library,
    taskRepository: new MemoryTaskRepository(),
    planRepository: new MemoryPlanRepository(),
    categoryPromptRepository: new MemoryCategoryPromptRepository(),
    provider: { edit: async () => ({ bytes, mimeType: "image/jpeg" }) },
    platformRepository: {
      listEnabled: async () => profiles,
      find: async (code) => profiles.find((platform) => platform.code === code),
    },
    llmClient: {
      provider: "fake", model: "offline", isFake: true,
      async generatePlan(input) {
        if (input.flow === "listing-copy") {
          calls.push(input);
          await pendingCopy;
          switch (input.dynamicInput.platform) {
            case "taobao": return { ...content, title: "折叠插脚充电器", subtitle: "随身携带，收纳方便" };
            case "etsy": return etsy.listingCopyRules.supportsSearchTerms ? content : { ...content, tags: ["charger", "x".repeat(21)] };
            default: return { ...content, title: "A".repeat(76), itemHighlights: "Foldable plug", searchTerms: ["杯".repeat(83), "茶"] };
          }
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
    cacheDir: "node_modules/.vite-browser-listing-copy",
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
  return { app, calls, page, url, migrateEtsy: () => { etsy.listingCopyRules = etsyRules; } };
}

const facts = "产品名称：折叠插脚充电器\n核心卖点：插脚可折叠";

async function createBatch(page, url, platform, generateCopy) {
  await page.goto(url + "create/suite");
  await page.locator('input[type="file"]').setInputFiles(photo);
  await page.getByLabel("平台", { exact: true }).selectOption(platform);
  await page.getByLabel("商品卖点与生成要求").fill(facts);
  if (platform === "taobao") await page.getByLabel("目标市场", { exact: true }).selectOption("中国");
  await page.getByRole("button", { name: "自定义配置", exact: true }).click();
  for (const [group, n] of [["卖点图", 3], ["场景图", 2], ["其他", 1]]) {
    for (let i = 0; i < n; i++) await page.getByRole("button", { name: new RegExp(`^减少${group}`) }).click();
  }
  const toggle = page.getByLabel("商品上架文案生成");
  assert.equal(await toggle.isChecked(), false);
  if (generateCopy) await toggle.check();
  const name = generateCopy ? "一键生成套图与商品上架文案（1张）" : "一键生成套图（1张）";
  await page.getByRole("button", { name, exact: true }).click();
  const batch = page.getByRole("region", { name: "生成批次" });
  await batch.locator('[data-status="completed"]').waitFor({ timeout: 25000 });
  const suiteId = new URL(page.url()).pathname.split("/").at(-1);
  const openDrawer = async () => {
    await batch.getByRole("button", { name: "上架文案", exact: true }).click();
    return page.getByRole("dialog", { name: "商品上架文案" });
  };
  return { suiteId, openDrawer };
}

test("创作栏仅显示三个入口，两个旧文案路由都重定向到商品套图", async (t) => {
  const { page, url } = await offlineBrowser(t);
  for (const path of ["create/listing-copy", "create/listing-copy/00000000-0000-4000-8000-000000000001"]) {
    await page.goto(url + path);
    await page.waitForURL(url + "create/suite");
    const tools = page.getByRole("navigation", { name: "创作功能" });
    assert.deepEqual(await tools.getByRole("link").allTextContents(), ["商品套图", "生图画布", "爆品图反推"]);
  }
});

test("Amazon 随套图并行直出商品亮点和后台搜索词，超长字段实时标黄", async (t) => {
  const pendingCopy = Promise.withResolvers();
  const { app, calls, page, url } = await offlineBrowser(t, { pendingCopy: pendingCopy.promise });
  try {
    const { suiteId, openDrawer } = await createBatch(page, url, "amazon", true);
    const drawer = await openDrawer();
    await drawer.getByText("正在生成文案…", { exact: true }).waitFor();
    pendingCopy.resolve();
    await drawer.getByText("文案生成成功", { exact: true }).waitFor();
    assert.equal(await drawer.getByLabel("商品亮点 (Item Highlights)", { exact: true }).inputValue(), "Foldable plug");
    assert.equal(await drawer.getByLabel("后台搜索词", { exact: true }).inputValue(), "杯".repeat(83) + "\n茶");
    const charWarning = drawer.getByText("76 / 75 字符", { exact: true });
    const byteWarning = drawer.getByText("253 / 250 字节", { exact: true });
    assert.equal(await charWarning.getAttribute("data-over-limit"), "true");
    assert.equal(await byteWarning.getAttribute("data-over-limit"), "true");
    assert.equal(await charWarning.evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(255, 236, 169)");
    await drawer.getByLabel("后台搜索词", { exact: true }).fill("充电器\ncharger");
    assert.equal(await drawer.getByText("17 / 250 字节", { exact: true }).getAttribute("data-over-limit"), "false");
    assert.equal(await drawer.getByLabel("促销副标题", { exact: true }).count(), 0);
    const state = (await app.request("GET", `/api/suites/${suiteId}/studio-state`)).body.data;
    assert.equal(state.pipeline.status, "completed");
    assert.equal(state.listingCopy.id, state.pipeline.id);
    assert.equal(state.listingCopy.status, "succeeded");
    assert.equal(calls.length, 1);
  } finally {
    pendingCopy.resolve();
  }
});

test("未开启直出的淘宝批次在抽屉按需补生成，保存、复制、切换历史并重新生成", async (t) => {
  const pendingCopy = Promise.withResolvers();
  const { app, calls, page, url } = await offlineBrowser(t, { pendingCopy: pendingCopy.promise });
  try {
    const { suiteId, openDrawer } = await createBatch(page, url, "taobao", false);
    assert.equal(calls.length, 0);
    const drawer = await openDrawer();
    const created = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/listing-copies" && r.request().method() === "POST");
    await drawer.getByRole("button", { name: "一键生成上架文案", exact: true }).click();
    const response = await created;
    assert.equal(response.status(), 202);
    assert.deepEqual(response.request().postDataJSON(), { sourceSuiteId: suiteId, generate: true });
    const { data: initial } = await response.json();
    await drawer.getByText("正在生成文案…", { exact: true }).waitFor();
    pendingCopy.resolve();
    await drawer.getByText("文案生成成功", { exact: true }).waitFor();
    const subtitle = drawer.getByLabel("促销副标题", { exact: true });
    assert.equal(await subtitle.inputValue(), "随身携带，收纳方便");
    assert.equal(await drawer.getByLabel("卖点短句", { exact: true }).inputValue(), "Foldable plug\nCompact body");
    assert.equal(await drawer.getByLabel("后台搜索词", { exact: true }).count(), 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].dynamicInput.selling_points, facts);
    assert.equal(calls[0].dynamicInput.platform, "taobao");
    assert.equal(calls[0].dynamicInput.target_market, "中国");
    assert.deepEqual(calls[0].visionImages[0].bytes, await readFile(photo));
    await subtitle.fill("可折叠插脚");
    await drawer.getByRole("button", { name: "保存为新版本", exact: true }).click();
    await drawer.getByRole("button", { name: /版本 2 · 最新/ }).waitFor();
    await drawer.getByRole("button", { name: /版本 1/ }).click();
    assert.equal(await subtitle.inputValue(), "随身携带，收纳方便");
    assert.equal(await subtitle.evaluate((field) => field.readOnly), true);
    await drawer.getByRole("button", { name: "复制促销副标题", exact: true }).click();
    await drawer.getByText("已复制促销副标题", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "随身携带，收纳方便");
    await drawer.getByRole("button", { name: "关闭", exact: true }).click();
    await openDrawer();
    await drawer.getByRole("button", { name: /版本 2 · 最新/ }).waitFor();
    assert.equal(await subtitle.inputValue(), "可折叠插脚");
    await drawer.getByRole("button", { name: "重新生成", exact: true }).click();
    await drawer.getByRole("button", { name: /版本 3 · 最新/ }).waitFor();
    const state = (await app.request("GET", `/api/suites/${suiteId}/studio-state`)).body.data;
    assert.equal(state.listingCopy.id, initial.id);
    assert.equal(state.listingCopy.status, "succeeded");
    assert.equal(calls.length, 2);
  } finally {
    pendingCopy.resolve();
  }
});

test("Etsy 规则升级后仍可查看与复制旧版本的后台搜索词", async (t) => {
  const { page, url, migrateEtsy } = await offlineBrowser(t, { legacyEtsy: true });
  const { openDrawer } = await createBatch(page, url, "etsy", true);
  const drawer = await openDrawer();
  await drawer.getByText("文案生成成功", { exact: true }).waitFor();
  migrateEtsy();
  const batchUrl = page.url();
  await page.goto(batchUrl);
  await openDrawer();
  await drawer.getByRole("button", { name: "重新生成", exact: true }).click();
  await drawer.getByRole("button", { name: /版本 2 · 最新/ }).waitFor();
  assert.equal(await drawer.getByLabel("后台搜索词", { exact: true }).count(), 0);
  assert.equal(await drawer.getByLabel("商品标签 (Tags)", { exact: true }).inputValue(), "charger\n" + "x".repeat(21));
  assert.equal(await drawer.getByText("第 2 条 21 / 20 字符", { exact: true }).getAttribute("data-over-limit"), "true");
  await drawer.getByRole("button", { name: /版本 1/ }).click();
  const terms = drawer.getByLabel("后台搜索词", { exact: true });
  assert.equal(await terms.inputValue(), "foldable charger");
  assert.equal(await terms.evaluate((field) => field.readOnly), true);
  await drawer.getByRole("button", { name: "复制后台搜索词", exact: true }).click();
  await drawer.getByText("已复制后台搜索词", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "foldable charger");
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
