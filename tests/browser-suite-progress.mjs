// Run with: npx tsx --test tests/browser-suite-progress.mjs (offline, in-memory only)
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";
import { createSuiteStudioApp } from "../server/app.js";
import { dispatchInputImageUpload } from "../server/multipart.js";
import { parseNormalizedPromptMarkdown } from "../server/prompt-library.js";
import { MemoryCategoryPromptRepository } from "../server/repositories/memory-category-prompt-repository.js";
import { MemoryLibraryRepository } from "../server/repositories/memory-library-repository.js";
import { MemoryPlanRepository } from "../server/repositories/memory-plan-repository.js";
import { MemoryPromptRepository } from "../server/repositories/memory-prompt-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryTaskRepository } from "../server/repositories/memory-task-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";
import { DETAIL_CATEGORIES } from "../shared/suite-categories.js";

const PHOTO_PATH = "public/assets/gan65-product.jpg";
const LAST_SUITE_STORAGE_KEY = "picagent:suite-studio:last-suite-id";

async function offlineProgressFixture(t, { imageGate, copyGate } = {}) {
  const sample = await readFile(PHOTO_PATH);
  const prompts = new MemoryPromptRepository();
  const library = new MemoryLibraryRepository();
  for (const name of [
    "general-listing-copy.md",
    "general-structure-plan-groups.md",
    "general-category-prompt-groups.md",
  ]) {
    const [version] = await prompts.importRecords([
      parseNormalizedPromptMarkdown(await readFile(`prompt/normalized/${name}`, "utf8"), name),
    ]);
    await prompts.publishVersion(version.templateVersionId);
    library.addResource({
      id: version.templateVersionId,
      resourceVersionId: version.templateVersionId,
      templateVersionId: version.templateVersionId,
      title: version.name,
      stage: version.stage,
      summary: "离线测试模板",
      resourceType: "prompt_template",
      status: "published",
      createdAt: "2026-11-23T00:00:00Z",
      updatedAt: "2026-11-23T00:00:00Z",
      source: { versionNo: version.versionNo },
    });
  }
  const platforms = [
    {
      code: "amazon",
      name: "Amazon",
      marketScope: "overseas",
      mainImageBackground: "flexible",
      mainImageStrategy: "",
      galleryStrategy: "",
      textStrategy: "",
      modelStrategy: "",
      sourceNote: "",
      sortOrder: 1,
      listingCopyRules: {
        titleMaxLength: 150,
        maxBulletPoints: 5,
        supportsSearchTerms: true,
        itemHighlightsMaxLength: 125,
        searchTermsMaxBytes: 250,
        forbiddenWords: [],
      },
    },
  ];
  const calls = [];
  const app = createSuiteStudioApp({
    repository: new MemorySuiteRepository(),
    storage: new MemoryStorage(),
    promptRepository: prompts,
    libraryRepository: library,
    taskRepository: new MemoryTaskRepository(),
    planRepository: new MemoryPlanRepository(),
    categoryPromptRepository: new MemoryCategoryPromptRepository(),
    platformRepository: {
      listEnabled: async () => platforms,
      find: async (code) => platforms.find((p) => p.code === code),
    },
    provider: {
      async edit() {
        if (imageGate) await imageGate;
        return { bytes: sample, mimeType: "image/jpeg" };
      },
    },
    llmClient: {
      provider: "fake",
      model: "offline",
      isFake: true,
      async generatePlan(input) {
        if (input.flow === "listing-copy") {
          if (copyGate) await copyGate;
          return {
            schemaVersion: "listing-copy-v1",
            title: "Insulated Travel Bottle",
            bulletPoints: ["Long-lasting insulation", "Leak-proof lid"],
            description: "Compact insulated travel bottle for daily commuting.",
            searchTerms: ["travel bottle", "insulated flask"],
            missingFacts: [],
          };
        }
        const id = input.inputImageIds[0];
        const groups = input.dynamicInput.category_groups
          ? JSON.parse(input.dynamicInput.category_groups)
          : { main: { count: 1 }, selling_points: { count: 1 }, lifestyle: { count: 0 }, other: { count: 0 } };
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
            title: input.categoryCode === "main" ? "便携保温杯主图" : "长效保温卖点图",
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

  const vite = await createServer({
    cacheDir: "node_modules/.vite-browser-suite-progress",
    configFile: false,
    server: { host: "127.0.0.1", port: 0 },
    esbuild: { jsx: "automatic" },
    plugins: [
      {
        name: "offline-suite-progress-api",
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            const path = req.url ?? "/";
            if (!path.startsWith("/api/")) return next();
            try {
              const chunks = [];
              for await (const chunk of req) chunks.push(chunk);
              const buf = Buffer.concat(chunks);
              const upload =
                req.method === "POST" && (await dispatchInputImageUpload(app, path, buf, req.headers));
              const inputPreview = path.match(
                /^\/api\/suites\/([^/]+)\/input-images\/([^/]+)\/preview\/(original|thumbnail)$/,
              );
              const versionPreview = path.match(
                /^\/api\/suite-tasks\/([^/]+)\/versions\/([^/]+)\/preview$/,
              );
              let response;
              if (upload) {
                response = upload;
              } else if (inputPreview) {
                response = await app.preview(inputPreview[1], inputPreview[2], inputPreview[3]);
              } else if (versionPreview) {
                response = await app.previewTaskVersion(versionPreview[1], versionPreview[2]);
              } else {
                const body = buf.length ? JSON.parse(buf.toString()) : undefined;
                calls.push({ method: req.method, path, body });
                response =
                  path === "/api/model-settings"
                    ? { status: 200, body: { data: { channels: [], preferences: { image: null, vision: null } } } }
                    : await app.request(req.method, path, { headers: req.headers, body });
              }
              res.writeHead(
                response.status,
                response.raw ? response.headers : { "Content-Type": "application/json" },
              );
              res.end(response.raw ?? JSON.stringify(response.body));
            } catch (error) {
              res.writeHead(500);
              res.end(String(error));
            }
          });
        },
      },
    ],
  });
  await vite.listen();
  t.after(() => vite.close());
  const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(10000);
  const url = vite.resolvedUrls.local[0];
  await page.route("**/*", (route) =>
    route.request().url().startsWith(url) ? route.continue() : route.abort(),
  );
  return { app, calls, page, url, sample };
}

test("商品套图：切到生图画布再切回自动恢复记录、展示多阶段与并行文案进度、持续轮询至终态并支持新建重置", async (t) => {
  const imageGate = Promise.withResolvers();
  const copyGate = Promise.withResolvers();
  const { calls, page, url } = await offlineProgressFixture(t, {
    imageGate: imageGate.promise,
    copyGate: copyGate.promise,
  });
  try {
    await page.goto(url + "create/suite");
    await page.getByLabel("上传商品原图").setInputFiles(PHOTO_PATH);
    await page.waitForURL(/\/create\/suite\/[^/]+$/);
    const suiteId = new URL(page.url()).pathname.split("/").pop();
    const sellingPoints = "产品名称：便携保温杯\n核心卖点：长效保温";
    await page.getByLabel("商品卖点与生成要求").fill(sellingPoints);
    await page.getByRole("button", { name: "自定义配置", exact: true }).click();
    for (const [group, times] of [
      ["卖点图", 2],
      ["场景图", 2],
      ["其他", 1],
    ]) {
      for (let i = 0; i < times; i++) {
        await page.getByRole("button", { name: new RegExp(`^减少${group}`) }).click();
      }
    }
    await page.getByLabel("商品上架文案生成").check();
    await page.getByRole("button", { name: "一键生成套图与商品上架文案（2张）", exact: true }).click();

    const batch = page.getByRole("region", { name: "生成批次" });
    await batch.locator('[data-status="running"]').waitFor();
    await batch.locator('[data-copy-status="running"]').waitFor({ timeout: 10000 });
    assert.match(await batch.locator('[data-status="running"]').textContent(), /生成图片中/);
    assert.equal(await batch.locator('[data-copy-status="running"]').textContent(), "生成文案中…");

    const progressBar = batch.getByRole("progressbar", { name: "套图生成进度" });
    await progressBar.waitFor();
    const initialPercent = Number(await progressBar.getAttribute("aria-valuenow"));
    assert.ok(initialPercent > 0, `期望进度条非静止 0%，实际为 ${initialPercent}`);
    const steps = batch.getByRole("list", { name: "生成阶段进度" });
    assert.match(await steps.textContent(), /规划结构.*生成提示词.*生成图片.*上架文案 · 生成文案中…/);

    // 切到「生图画布」再切回「商品套图」
    const tools = page.getByRole("navigation", { name: "创作功能" });
    await tools.getByRole("link", { name: "生图画布", exact: true }).click();
    await page.waitForURL("**/create/canvas");
    await page.getByRole("navigation", { name: "创作功能" }).getByRole("link", { name: "商品套图", exact: true }).click();

    // 自动恢复原套图 URL 与左侧配置记录
    await page.waitForURL(`**/create/suite/${suiteId}`);
    assert.equal(await page.getByLabel("商品卖点与生成要求").inputValue(), sellingPoints);
    assert.equal(await page.getByLabel("商品上架文案生成").isChecked(), true);
    await page.getByText("1 / 6", { exact: true }).waitFor();

    // 放行生图，确认轮询持续推进到套图完成，同时文案仍处于运行态
    imageGate.resolve();
    await batch.locator('[data-status="completed"]').waitFor({ timeout: 12000 });
    assert.equal(await batch.locator("[data-result-card] img").count(), 2);
    await batch.locator('[data-copy-status="running"]').waitFor();
    await batch.getByText("套图已生成，正在并行生成商品上架文案…").waitFor();

    // 放行并行文案，确认继续轮询直至文案 succeeded 且进度面板收起
    copyGate.resolve();
    await batch.locator('[data-copy-status="succeeded"]').waitFor({ timeout: 12000 });
    assert.equal(await batch.locator('[data-copy-status="succeeded"]').textContent(), "文案已生成");
    await batch.locator(".ss-progress").waitFor({ state: "detached" });

    // 点击「文案已生成」胶囊可打开文案抽屉
    await batch.locator('[data-copy-status="succeeded"]').click();
    const drawer = page.getByRole("dialog", { name: "商品上架文案" });
    await drawer.getByText("文案生成成功", { exact: true }).waitFor();
    await drawer.getByRole("button", { name: "关闭", exact: true }).click();
    await drawer.waitFor({ state: "hidden" });

    // 终态后不得继续轮询
    const pollCount = () => calls.filter((c) => c.path === `/api/suites/${suiteId}/studio-state`).length;
    const afterTerminal = pollCount();
    await page.waitForTimeout(3200);
    assert.equal(pollCount(), afterTerminal, "套图与文案均终态后不得继续轮询");

    // 点击「＋ 新建套图」清除 sessionStorage 并回到空白 /create/suite
    await page.getByRole("button", { name: "＋ 新建套图", exact: true }).click();
    await page.waitForURL(url + "create/suite");
    assert.equal(
      await page.evaluate((key) => window.sessionStorage.getItem(key), LAST_SUITE_STORAGE_KEY),
      null,
    );
    await page.getByText("0 / 6", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("商品卖点与生成要求").inputValue(), "");
  } finally {
    imageGate.resolve();
    copyGate.resolve();
  }
});

test("干净会话无 sessionStorage 直接访问 /create/suite 时，后端运行中批次仍持续自动轮询至完成", async (t) => {
  const imageGate = Promise.withResolvers();
  const { app, calls, page, url, sample } = await offlineProgressFixture(t, {
    imageGate: imageGate.promise,
  });
  try {
    // 直接通过后端接口创建一个正在运行的套图批次
    const created = await app.request("POST", "/api/suites", { body: { name: "后台运行中批次" } });
    assert.equal(created.status, 201);
    const suiteId = created.body.data.id;
    const uploaded = await app.upload(suiteId, {
      filename: "gan65-product.jpg",
      mimeType: "image/jpeg",
      bytes: sample,
    });
    assert.equal(uploaded.status, 201);
    const started = await app.request("POST", "/api/suites/one-click-generate", {
      headers: { "idempotency-key": "bg-running-suite" },
      body: {
        suiteId,
        config: {
          platform: "amazon",
          targetMarket: "美国",
          outputLanguage: "英文",
          aspectRatio: "1:1",
          size: "1K",
          mode: "custom",
          counts: { main: 1, selling_points: 1, lifestyle: 0, other: 0 },
          sellingPoints: "产品名称：便携保温杯\n核心卖点：长效保温",
          listingCopy: false,
        },
      },
    });
    assert.equal(started.status, 202);

    // 干净会话直接打开无 :suiteId 的 /create/suite
    await page.goto(url + "create/suite");
    assert.equal(new URL(page.url()).pathname, "/create/suite");
    const batch = page.getByRole("region", { name: "生成批次" });
    await batch.locator('[data-status="running"]').waitFor();
    await batch.getByRole("progressbar", { name: "套图生成进度" }).waitFor();

    // 放行生图，无需刷新或切换 URL，结果区应自动轮询推进至 completed
    imageGate.resolve();
    await batch.locator('[data-status="completed"]').waitFor({ timeout: 12000 });
    assert.equal(await batch.locator("[data-result-card] img").count(), 2);
    assert.equal(new URL(page.url()).pathname, "/create/suite");

    const pollCount = () => calls.filter((c) => c.path === `/api/suites/${suiteId}/studio-state`).length;
    const afterCompletion = pollCount();
    await page.waitForTimeout(3200);
    assert.equal(pollCount(), afterCompletion, "无 suiteId 路由下终态后同样不得继续轮询");
  } finally {
    imageGate.resolve();
  }
});

test("sessionStorage 指向已删除的 suiteId 时静默清除并停留在空白 /create/suite", async (t) => {
  const { page, url } = await offlineProgressFixture(t);
  await page.addInitScript((key) => {
    window.sessionStorage.setItem(key, "deleted-or-missing-suite-id");
  }, LAST_SUITE_STORAGE_KEY);
  await page.goto(url + "create/suite");
  await page.getByRole("heading", { name: "AI 商品套图", exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/create/suite");
  assert.equal(await page.getByRole("alert").count(), 0);
  assert.equal(
    await page.evaluate((key) => window.sessionStorage.getItem(key), LAST_SUITE_STORAGE_KEY),
    null,
  );
});
