// Run with: npx tsx --test tests/browser-product-card-downstream.mjs (offline, no DB or external API calls).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";
import { createSuiteStudioApp } from "../server/app.js";
import { MemoryProductOnboardingRepository } from "../server/product-onboarding/index.js";
import { parseNormalizedPromptMarkdown } from "../server/prompt-library.js";
import { MemoryCategoryPromptRepository } from "../server/repositories/memory-category-prompt-repository.js";
import { MemoryLibraryRepository } from "../server/repositories/memory-library-repository.js";
import { MemoryPipelineRepository } from "../server/repositories/memory-pipeline-repository.js";
import { MemoryPlanRepository } from "../server/repositories/memory-plan-repository.js";
import { MemoryProductCardRepository } from "../server/repositories/memory-product-card-repository.js";
import { MemoryPromptRepository } from "../server/repositories/memory-prompt-repository.js";
import { MemoryReplicaRepository } from "../server/repositories/memory-replica-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryTaskRepository } from "../server/repositories/memory-task-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";
import { DETAIL_CATEGORIES } from "../shared/suite-categories.js";

async function startOfflineDownstreamApp(t) {
  const sampleProduct = await readFile("public/assets/gan65-product.jpg");
  const sampleRef = await readFile("public/assets/tokyo-desk-v3.jpg");
  const sampleTight = await readFile("public/assets/gan65-product-tight.jpg");

  const promptRepository = new MemoryPromptRepository();
  for (const name of [
    "general-base-refine.md",
    "general-structure-plan-groups.md",
    "general-category-prompt-groups.md",
    "general-listing-copy.md",
    "replica-compose.md",
    "replica-high.md",
    "product-onboarding.md",
  ]) {
    const [version] = await promptRepository.importRecords([
      parseNormalizedPromptMarkdown(await readFile(`prompt/normalized/${name}`, "utf8"), name),
    ]);
    await promptRepository.publishVersion(version.templateVersionId);
  }

  const listingRules = {
    titleMaxLength: 120,
    maxBulletPoints: 5,
    supportsSearchTerms: true,
    searchTermsMaxBytes: 250,
    forbiddenWords: ["best seller"],
  };

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
      listingCopyRules: listingRules,
    },
    {
      code: "taobao",
      name: "淘宝",
      marketScope: "domestic",
      mainImageBackground: "flexible",
      mainImageStrategy: "",
      galleryStrategy: "",
      textStrategy: "",
      modelStrategy: "",
      sourceNote: "",
      sortOrder: 2,
      listingCopyRules: listingRules,
    },
  ];

  const storage = new MemoryStorage();
  const productCardRepository = new MemoryProductCardRepository();
  const structurePlanCalls = [];
  const listingCopyCalls = [];
  const replicaPromptCalls = [];

  const api = createSuiteStudioApp({
    repository: new MemorySuiteRepository(),
    storage,
    promptRepository,
    taskRepository: new MemoryTaskRepository(),
    planRepository: new MemoryPlanRepository(),
    categoryPromptRepository: new MemoryCategoryPromptRepository(),
    pipelineRepository: new MemoryPipelineRepository(),
    replicaRepository: new MemoryReplicaRepository(),
    libraryRepository: new MemoryLibraryRepository(),
    productCardRepository,
    productOnboardingRepository: new MemoryProductOnboardingRepository(),
    imageRetryDelayMs: 0,
    platformRepository: {
      listEnabled: async () => platforms,
      find: async (code) => platforms.find((p) => p.code === code) ?? null,
    },
    provider: {
      supportsMultipleImages: true,
      async edit() {
        return { bytes: sampleProduct, mimeType: "image/jpeg" };
      },
    },
    llmClient: {
      provider: "fake-vision",
      model: "fake-vision-v1",
      isFake: true,
      async generatePlan(input) {
        if (input.flow === "listing-copy") {
          listingCopyCalls.push(input);
          return {
            schemaVersion: "listing-copy-v1",
            title: "316L Stainless Insulated Tumbler 500ml",
            bulletPoints: ["316L food-grade stainless steel", "12-hour vacuum insulation"],
            description: "Leak-proof travel tumbler crafted for daily commute and outdoor trips.",
            searchTerms: ["insulated tumbler", "316L travel mug"],
            missingFacts: [],
          };
        }

        structurePlanCalls.push(input);
        const supplement = String(input.dynamicInput.human_supplement ?? "");
        const hasAnyFacts = supplement.trim().length > 0;
        const shouldPause = !hasAnyFacts;
        const imageId = input.inputImageIds[0];
        const rawGroups = input.dynamicInput.category_groups
          ? JSON.parse(String(input.dynamicInput.category_groups))
          : null;
        const mainCount = rawGroups?.main?.count ?? Number(input.dynamicInput.main_image_count ?? 1);
        const sellingCount = rawGroups?.selling_points?.count ?? 2;
        const lifestyleCount = rawGroups?.lifestyle?.count ?? 2;
        const otherCount = rawGroups?.other?.count ?? 2;
        const counts = {
          feature_benefit: shouldPause ? 0 : sellingCount,
          lifestyle_use: shouldPause ? 0 : lifestyleCount,
          comparison: shouldPause ? 0 : otherCount,
        };
        return {
          schemaVersion: "suite-structure-plan-v2",
          status: shouldPause ? "NEEDS_HUMAN_INPUT" : "READY_FOR_REVIEW",
          mainAllocation: {
            category: "main",
            count: mainCount,
            reason: "展示商品主体",
            sourceImageIds: [imageId],
            factRefs: hasAnyFacts ? ["human_supplement"] : [],
            missingFacts: [],
          },
          detailImageCount: Object.values(counts).reduce((a, b) => a + b, 0),
          categoryAllocations: DETAIL_CATEGORIES.map(([category]) => ({
            category,
            count: counts[category] ?? 0,
            requirement: "optional",
            reason: "基于商品事实生成",
            sourceImageIds: [imageId],
            factRefs: hasAnyFacts ? ["human_supplement"] : [],
            missingFacts: shouldPause && category === "feature_benefit" ? ["缺少核心卖点"] : [],
          })),
          globalStyleCard: { promptPrefix: "简洁高端商业棚拍" },
        };
      },
      async generateCategoryPrompt(input) {
        return {
          schemaVersion: "suite-category-prompt-v1",
          category: input.categoryCode,
          items: Array.from({ length: input.requestedCount }, (_, i) => ({
            stableId: `${input.categoryCode}-${i + 1}`,
            category: input.categoryCode,
            title: `${input.categoryCode} 图 ${i + 1}`,
            purpose: "展示商品核心信息",
            prompt: `棚拍展示 ${input.categoryCode} ${i + 1}`,
            sourceImageIds: input.inputImageIds,
            referenceImageIds: input.inputImageIds,
            factRefs: ["human_supplement"],
            allowsTextOverlay: "no",
            textContent: [],
            aspectRatio: "1:1",
            suggestedParams: {},
          })),
        };
      },
      async generateReplicaPrompts(input) {
        replicaPromptCalls.push(input);
        return {
          schemaVersion: "replica-prompt-v1",
          taskName: "",
          sharedStyle: "明亮极简桌面棚拍",
          items: input.references.map((ref) => ({
            referenceId: ref.referenceId,
            title: `复刻图 ${ref.ordinal}`,
            visualStructure: { layout: "居中构图", textBlocks: ["主标"] },
            copy: [{ role: "headline", text: "高能快充", position: "顶部" }],
            prompt: `按参考图 ${ref.ordinal} 构图复刻产品实拍`,
          })),
        };
      },
    },
  });

  // Seed 3 product cards: 2 published (1 with supplier image, 1 searchable by selling point) + 1 archived.
  const createCard = async (payload) => {
    const res = await api.request("POST", "/api/product-cards", {
      headers: { "idempotency-key": `seed-${payload.name}` },
      body: payload,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data;
  };

  const tumblerCard = await createCard({
    name: "真空保温随行杯 500ml",
    sellingPoints: ["316L 食品级不锈钢内胆", "12 小时真空长效保温保冷", "一键弹盖防漏安全锁"],
    specifications: "容量 500ml，高度 215mm，杯底直径 68mm，净重 265g",
    materialsCraft: "316L 不锈钢内胆 + 304 拉丝外壳 + 食品级硅胶密封圈",
    audienceScenarios: "通勤办公、车载自驾、户外徒步人群",
    packageContents: "保温杯本体 ×1、替换硅胶密封圈 ×1、说明书 ×1",
    painPointsComparison: "较旧款轻 18%，单手开盖更省力",
    usageDemoHighlights: "按压安全锁即可单手弹盖直饮",
    certificationsProhibitions: "通过 FDA 与 LFGB 接触材质检测；禁止宣称医疗功效",
    supplierImages: [
      {
        filename: "supplier-tumbler.jpg",
        mimeType: "image/jpeg",
        bytesBase64: sampleTight.toString("base64"),
      },
    ],
  });

  const chargerCard = await createCard({
    name: "氮化镓 65W 三口折叠快充头",
    sellingPoints: ["65W 双 Type-C + USB-A 三口同时快充", "90° 折叠插脚随身收纳不刮包"],
    specifications: "总输出 65W Max，尺寸 52×36×36mm，重量 112g",
    materialsCraft: "V0 级阻燃 PC 磨砂壳体 + 激光镭雕丝印",
    audienceScenarios: "笔记本与手机双持通勤、商旅出差人群",
    packageContents: "单品本体 ×1，无额外配件",
    painPointsComparison: "体积较传统 65W 适配器缩小 45%",
    usageDemoHighlights: "插脚可折叠平齐收纳",
    certificationsProhibitions: "通过 3C / FCC / UL 认证；禁止夸大兼容全部专有协议",
  });

  const archivedCard = await createCard({
    name: "已下架旧款蓝牙音箱",
    sellingPoints: ["旧款清仓测试卖点"],
    specifications: "功率 10W，重量 420g",
    materialsCraft: "织布网罩 + ABS 机身",
    audienceScenarios: "居家听歌",
    packageContents: "音箱 ×1",
    painPointsComparison: "",
    usageDemoHighlights: "",
    certificationsProhibitions: "",
  });
  const archiveRes = await api.request("POST", `/api/product-cards/${archivedCard.id}/archive`, {
    headers: { "idempotency-key": "seed-archive-1" },
    body: {},
  });
  assert.equal(archiveRes.status, 200, JSON.stringify(archiveRes.body));

  const settings = {
    channels: [
      {
        id: "offline",
        name: "离线渠道",
        baseUrl: "https://example.invalid/v1",
        protocol: "openai-compatible",
        hasApiKey: true,
        models: [
          {
            id: "offline-image",
            capabilities: ["image", "vision"],
            imageOptions: { sizes: ["1K", "2K", "4K"], aspectRatios: ["1:1", "3:4", "4:3"], sizeMode: "tier" },
          },
        ],
      },
    ],
    preferences: {
      image: { channelId: "offline", modelId: "offline-image" },
      vision: { channelId: "offline", modelId: "offline-image" },
    },
  };

  const apiCalls = [];
  const vite = await createServer({
    cacheDir: "node_modules/.vite-browser-product-card-downstream",
    configFile: false,
    server: { host: "127.0.0.1", port: 0 },
    esbuild: { jsx: "automatic" },
    plugins: [
      {
        name: "offline-downstream-api",
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            const reqPath = req.url ?? "/";
            if (!reqPath.startsWith("/api/")) return next();
            try {
              const chunks = [];
              for await (const chunk of req) chunks.push(chunk);
              const buf = Buffer.concat(chunks);

              const uploadMatch = reqPath.match(/^\/api\/suites\/([^/]+)\/input-images$/);
              const inputPreviewMatch = reqPath.match(
                /^\/api\/suites\/([^/]+)\/input-images\/([^/]+)\/preview\/(original|thumbnail)$/,
              );
              const taskPreviewMatch = reqPath.match(
                /^\/api\/suite-tasks\/([^/]+)\/versions\/([^/]+)\/preview$/,
              );

              let result;
              if (uploadMatch && req.method === "POST") {
                const form = await new Response(buf, {
                  headers: { "content-type": req.headers["content-type"] },
                }).formData();
                const file = form.get("file");
                result = await api.upload(uploadMatch[1], {
                  filename: file.name,
                  mimeType: file.type,
                  bytes: Buffer.from(await file.arrayBuffer()),
                  idempotencyKey: req.headers["idempotency-key"],
                });
              } else if (inputPreviewMatch) {
                result = await api.preview(
                  inputPreviewMatch[1],
                  inputPreviewMatch[2],
                  inputPreviewMatch[3],
                );
              } else if (taskPreviewMatch) {
                result = await api.previewTaskVersion(taskPreviewMatch[1], taskPreviewMatch[2]);
              } else if (reqPath === "/api/model-settings") {
                result = { status: 200, body: { data: settings } };
              } else {
                const body = buf.length ? JSON.parse(buf.toString("utf8")) : undefined;
                apiCalls.push({ method: req.method, path: reqPath, body });
                result = await api.request(req.method, reqPath, { headers: req.headers, body });
              }

              res.writeHead(
                result.status,
                result.raw
                  ? result.headers
                  : { "content-type": "application/json; charset=utf-8" },
              );
              res.end(result.raw ?? JSON.stringify(result.body));
            } catch (error) {
              res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ error: { message: String(error) } }));
            }
          });
        },
      },
    ],
  });

  await vite.listen();
  const baseUrl = vite.resolvedUrls.local[0].replace(/\/$/, "");
  const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
  t.after(async () => {
    await browser.close();
    await vite.close();
  });

  return {
    baseUrl,
    browser,
    api,
    apiCalls,
    structurePlanCalls,
    listingCopyCalls,
    replicaPromptCalls,
    tumblerCard,
    chargerCard,
    archivedCard,
    sampleRef,
  };
}

test("下游接入商品信息卡：首页跳套图+归档快照可读、复刻按卖点选卡刷新保留、纯手填兼容与异常卡提示", async (t) => {
  const ctx = await startOfflineDownstreamApp(t);
  const page = await ctx.browser.newPage({ viewport: { width: 1500, height: 960 } });
  page.setDefaultTimeout(12000);

  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error));

  // =========================================================================
  // 链路 1：首页已发布卡「去套图」→ 空白套图预绑定 → 生成套图含上架文案 → 归档后仍可读快照
  // =========================================================================
  await page.goto(`${ctx.baseUrl}/`);
  const recentCard = page.locator(`[data-recent-card-id="${ctx.tumblerCard.id}"]`);
  await recentCard.waitFor();
  await recentCard.getByRole("button", { name: "去套图", exact: true }).click();

  await page.waitForURL(new RegExp(`/create/suite\\?productCardId=${ctx.tumblerCard.id}`));
  // Empty new suite state
  await page.getByRole("heading", { name: "AI 商品套图", exact: true }).waitFor();

  const configPanel = page.getByRole("complementary", { name: "套图配置" });
  const selectedBar = configPanel.locator("[data-selected-product-card-bar]");
  await selectedBar.waitFor();
  assert.ok((await selectedBar.textContent())?.includes(ctx.tumblerCard.name));
  assert.ok((await selectedBar.textContent())?.includes("316L 食品级不锈钢内胆"));

  // Heading switched to supplemental mode & supplier image did NOT populate suite input images
  await configPanel
    .getByRole("heading", { name: "补充卖点 & 本次生成要求（选填）", exact: true })
    .waitFor();
  assert.equal(await configPanel.locator(".ss-thumb").count(), 0, "Supplier image must not enter suite input images");
  assert.ok((await configPanel.locator("section").first().textContent())?.includes("0 / 6"));

  // Open detail dialog from SelectedProductCardBar and verify 7+4 facts
  await selectedBar.getByRole("button", { name: "查看详情", exact: true }).click();
  const detailDialog = page.getByRole("dialog", { name: "商品信息卡详情" });
  await detailDialog.waitFor();
  const detailText = await detailDialog.textContent();
  assert.ok(detailText?.includes("316L 食品级不锈钢内胆"));
  assert.ok(detailText?.includes("保温杯本体 ×1、替换硅胶密封圈 ×1、说明书 ×1"));
  assert.ok(detailText?.includes("通过 FDA 与 LFGB 接触材质检测"));
  await detailDialog.getByRole("button", { name: "关闭", exact: true }).click();
  await detailDialog.waitFor({ state: "detached" });

  // Locally upload 1 product photo, fill 1 supplemental sentence, enable listing copy, and generate
  await configPanel.getByLabel("上传商品原图").setInputFiles("public/assets/gan65-product.jpg");
  await configPanel.locator(".ss-thumb").first().waitFor();
  await configPanel
    .getByRole("textbox", { name: "商品卖点与生成要求" })
    .fill("主图突出不锈钢金属拉丝质感，整体光线清透明亮");
  await configPanel.getByRole("checkbox", { name: "商品上架文案生成" }).check();
  await configPanel.getByRole("button", { name: /^一键生成套图与商品上架文案/ }).click();

  const batch = page.getByRole("region", { name: "生成批次" });
  await batch.getByText("已完成", { exact: true }).waitFor({ timeout: 15000 });
  await batch.getByRole("button", { name: "文案已生成", exact: true }).waitFor({ timeout: 15000 });

  // Must NOT trigger waiting_human_input
  assert.equal(await batch.getByText("补充商品事实后继续").count(), 0);
  // Batch title must be the product card's name (not the supplemental sentence)
  await batch.getByRole("heading", { name: ctx.tumblerCard.name, exact: true }).waitFor();

  // Verify backend received productCardId and split facts vs emphasis
  const suiteStartCall = ctx.apiCalls.find(
    (c) => c.method === "POST" && c.path === "/api/suites/one-click-generate",
  );
  assert.equal(suiteStartCall?.body?.config?.productCardId, ctx.tumblerCard.id);
  assert.equal(ctx.structurePlanCalls.length, 1);
  assert.ok(
    String(ctx.structurePlanCalls[0].dynamicInput.human_supplement).includes("316L 食品级不锈钢内胆"),
  );
  assert.equal(
    ctx.structurePlanCalls[0].dynamicInput.emphasis_requirements,
    "主图突出不锈钢金属拉丝质感，整体光线清透明亮",
  );
  assert.equal(ctx.listingCopyCalls.length, 1);
  assert.ok(
    String(ctx.listingCopyCalls[0].dynamicInput.selling_points).includes("通过 FDA 与 LFGB 接触材质检测"),
  );

  // Batch result area shows read-only snapshot bar with "快照 v1" and no "移除"/"更换"
  const batchSnapshotBar = batch.locator("[data-selected-product-card-bar]");
  await batchSnapshotBar.waitFor();
  assert.equal(await batchSnapshotBar.getAttribute("data-readonly"), "true");
  assert.ok((await batchSnapshotBar.textContent())?.includes("快照 v1"));
  assert.equal(await batchSnapshotBar.getByRole("button", { name: "移除" }).count(), 0);
  assert.equal(await batchSnapshotBar.getByRole("button", { name: "更换" }).count(), 0);

  const suiteBatchUrl = page.url();
  assert.match(suiteBatchUrl, /\/create\/suite\/[^/?]+$/);

  // Archive the product card in /products, then return to the historical suite batch
  await page.goto(`${ctx.baseUrl}/products?selected=${encodeURIComponent(ctx.tumblerCard.id)}`);
  await page.getByRole("button", { name: "归档", exact: true }).click();
  await page.getByText(/已归档/).first().waitFor();

  await page.goto(suiteBatchUrl);
  const historicalBatch = page.getByRole("region", { name: "生成批次" });
  const historicalSnapshotBar = historicalBatch.locator("[data-selected-product-card-bar]");
  await historicalSnapshotBar.waitFor();
  assert.ok((await historicalSnapshotBar.textContent())?.includes(ctx.tumblerCard.name));
  assert.ok((await historicalSnapshotBar.textContent())?.includes("快照 v1"));

  // Left editable ConfigPanel cleared archived binding & showed notice
  await page.getByRole("alert").filter({ hasText: /已归档/ }).waitFor();
  assert.equal(await configPanel.locator("[data-selected-product-card-bar]").count(), 0);

  // Clicking "查看详情" on historical snapshot bar still shows full frozen 7+4 facts
  await historicalSnapshotBar.getByRole("button", { name: "查看详情", exact: true }).click();
  const snapshotDialog = page.getByRole("dialog", { name: "商品信息卡快照详情" });
  await snapshotDialog.waitFor();
  const snapText = await snapshotDialog.textContent();
  assert.ok(snapText?.includes("快照 v1"));
  assert.ok(snapText?.includes("316L 食品级不锈钢内胆"));
  assert.ok(snapText?.includes("较旧款轻 18%，单手开盖更省力"));
  await snapshotDialog.getByRole("button", { name: "关闭", exact: true }).click();
  await snapshotDialog.waitFor({ state: "detached" });

  // Visiting /create/suite?productCardId=<archivedId> shows light notice and does not bind
  await page.goto(`${ctx.baseUrl}/create/suite?productCardId=${encodeURIComponent(ctx.archivedCard.id)}`);
  await page.getByRole("alert").filter({ hasText: /已归档/ }).waitFor();
  assert.equal(await configPanel.locator("[data-selected-product-card-bar]").count(), 0);

  // Visiting /create/replica?productCardId=<publishedId> pre-binds card and allows removing it
  await page.goto(`${ctx.baseUrl}/create/replica?productCardId=${encodeURIComponent(ctx.chargerCard.id)}`);
  const replicaPanel = page.getByRole("complementary", { name: "复刻配置" });
  const preboundReplicaBar = replicaPanel.locator("[data-selected-product-card-bar]");
  await preboundReplicaBar.waitFor();
  assert.ok((await preboundReplicaBar.textContent())?.includes(ctx.chargerCard.name));
  await preboundReplicaBar.getByRole("button", { name: "移除", exact: true }).click();
  assert.equal(await replicaPanel.locator("[data-selected-product-card-bar]").count(), 0);

  // Visiting /create/replica?productCardId=<archivedId> shows light notice and does not bind
  await page.goto(`${ctx.baseUrl}/create/replica?productCardId=${encodeURIComponent(ctx.archivedCard.id)}`);
  await page.getByRole("alert").filter({ hasText: /已归档/ }).waitFor();
  assert.equal(await replicaPanel.locator("[data-selected-product-card-bar]").count(), 0);

  // =========================================================================
  // 链路 2：/create/replica 弹窗按核心卖点搜索选卡 → 刷新不丢 → 本地上传参考图与产品原图提交成功
  // =========================================================================
  await page.goto(`${ctx.baseUrl}/create/replica`);
  await replicaPanel.getByRole("heading", { name: "商品信息（选填）", exact: true }).waitFor();

  await replicaPanel.getByRole("button", { name: /选择商品信息卡/ }).click();
  const pickerModal = page.getByRole("dialog", { name: "选择商品信息卡" });
  await pickerModal.waitFor();

  // Verify InfoTip inside React modal is visible and Escape closes only InfoTip (not parent modal)
  const pickerTipBtn = pickerModal.getByRole("button", { name: "商品信息卡选择说明" });
  await pickerTipBtn.click();
  const pickerTip = page.locator("#" + await pickerTipBtn.getAttribute("aria-controls"));
  await pickerTip.waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await pickerTip.waitFor({ state: "hidden" });
  assert.equal(await pickerModal.isVisible(), true, "First Escape must close only InfoTip, leaving ProductCardPickerModal open");

  // Archived cards must not appear in picker
  assert.equal(await pickerModal.getByText(ctx.archivedCard.name).count(), 0);
  assert.equal(await pickerModal.getByText(ctx.tumblerCard.name).count(), 0);

  // Search by selling point (case-insensitive)
  await pickerModal.getByLabel("搜索商品信息卡").fill("type-c");
  const chargerOption = pickerModal.locator(`[data-picker-card-id="${ctx.chargerCard.id}"]`);
  await chargerOption.waitFor();
  await chargerOption.click();

  // Preview pane displays full 6+3 facts
  const previewPane = pickerModal.locator(".pcp-preview-col");
  await previewPane.getByText("65W 双 Type-C + USB-A 三口同时快充").waitFor();
  await previewPane.getByText("单品本体 ×1，无额外配件").waitFor();
  await previewPane.getByText(/3C \/ FCC \/ UL/).waitFor();

  await pickerModal.getByRole("button", { name: "确认选择", exact: true }).click();
  await pickerModal.waitFor({ state: "detached" });

  const replicaSelectedBar = replicaPanel.locator("[data-selected-product-card-bar]");
  await replicaSelectedBar.waitFor();
  assert.ok((await replicaSelectedBar.textContent())?.includes(ctx.chargerCard.name));
  assert.ok((await replicaSelectedBar.textContent())?.includes("65W 双 Type-C + USB-A 三口同时快充"));
  await replicaPanel.getByRole("heading", { name: "补充商品信息（选填）", exact: true }).waitFor();

  // Reload page and confirm selected product card persists from replicaDraftStore
  await page.reload();
  await replicaPanel.locator("[data-selected-product-card-bar]").waitFor();
  assert.ok(
    (await replicaPanel.locator("[data-selected-product-card-bar]").textContent())?.includes(
      ctx.chargerCard.name,
    ),
  );
  await replicaPanel.getByRole("heading", { name: "补充商品信息（选填）", exact: true }).waitFor();

  // Reference & product upload areas remain untouched and strictly local upload
  assert.equal(await replicaPanel.getByRole("button", { name: "从资源库选择" }).count(), 0);
  await replicaPanel.getByLabel("上传参考图", { exact: true }).setInputFiles("public/assets/tokyo-desk-v3.jpg");
  await replicaPanel.getByLabel("上传产品原图", { exact: true }).setInputFiles("public/assets/gan65-product.jpg");
  await replicaPanel.getByLabel("商品信息").fill("主打黑金商务桌面配色");
  await replicaPanel.getByRole("button", { name: "一键复刻（1张）", exact: true }).click();

  const replicaBatch = page.getByRole("region", { name: "复刻批次" });
  await replicaBatch.getByText("已完成", { exact: true }).waitFor({ timeout: 15000 });
  await replicaBatch.getByRole("heading", { name: ctx.chargerCard.name, exact: true }).waitFor();

  // Verify backend received productCardId and injected facts into replica prompt
  const replicaCreateCall = ctx.apiCalls.find(
    (c) => c.method === "POST" && c.path === "/api/replicas",
  );
  assert.equal(replicaCreateCall?.body?.productCardId, ctx.chargerCard.id);
  assert.equal(ctx.replicaPromptCalls.length, 1);
  assert.ok(String(ctx.replicaPromptCalls[0].productInfo).includes("65W 双 Type-C + USB-A 三口同时快充"));
  assert.ok(String(ctx.replicaPromptCalls[0].productInfo).includes("主打黑金商务桌面配色"));

  // ReplicaBatchPreview renders read-only snapshot bar and opens snapshot detail dialog
  const replicaSnapshotBar = replicaBatch.locator("[data-selected-product-card-bar]");
  await replicaSnapshotBar.waitFor();
  assert.equal(await replicaSnapshotBar.getAttribute("data-readonly"), "true");
  assert.ok((await replicaSnapshotBar.textContent())?.includes("快照 v1"));
  await replicaSnapshotBar.getByRole("button", { name: "查看详情", exact: true }).click();
  const replicaSnapDialog = page.getByRole("dialog", { name: "商品信息卡快照详情" });
  await replicaSnapDialog.waitFor();
  assert.ok((await replicaSnapDialog.textContent())?.includes("体积较传统 65W 适配器缩小 45%"));
  await replicaSnapDialog.getByRole("button", { name: "关闭", exact: true }).click();

  // =========================================================================
  // 链路 3：不选商品卡直接手填生成套图与复刻，行为与改造前一致
  // =========================================================================
  // 3a. Manual Suite Studio
  await page.goto(`${ctx.baseUrl}/create/suite`);
  await page.getByRole("button", { name: "＋ 新建套图", exact: true }).click();
  await configPanel.getByRole("heading", { name: "商品卖点 & 生成要求", exact: true }).waitFor();
  await configPanel.getByRole("button", { name: /选择商品信息卡/ }).waitFor();
  assert.equal(await configPanel.locator("[data-selected-product-card-bar]").count(), 0);

  await configPanel.getByLabel("上传商品原图").setInputFiles("public/assets/gan65-product.jpg");
  await configPanel.locator(".ss-thumb").first().waitFor();
  await configPanel
    .getByRole("textbox", { name: "商品卖点与生成要求" })
    .fill("手工便携咖啡磨豆机\n陶瓷磨芯可水洗，30 档研磨刻度");
  await configPanel.getByRole("button", { name: /^一键生成套图（/ }).click();

  const manualSuiteBatch = page.getByRole("region", { name: "生成批次" });
  await manualSuiteBatch.getByText("已完成", { exact: true }).waitFor({ timeout: 15000 });
  await manualSuiteBatch.getByRole("heading", { name: "手工便携咖啡磨豆机", exact: true }).waitFor();
  assert.equal(await manualSuiteBatch.locator("[data-selected-product-card-bar]").count(), 0);

  const manualSuiteCall = ctx.apiCalls
    .filter((c) => c.method === "POST" && c.path === "/api/suites/one-click-generate")
    .at(-1);
  assert.equal(manualSuiteCall?.body?.config?.productCardId, undefined);

  // 3b. Manual Replica Studio
  await page.goto(`${ctx.baseUrl}/create/replica`);
  await page.getByRole("button", { name: "＋ 新建复刻", exact: true }).click();
  await replicaPanel.getByRole("heading", { name: "商品信息（选填）", exact: true }).waitFor();
  assert.equal(await replicaPanel.locator("[data-selected-product-card-bar]").count(), 0);

  await replicaPanel.getByLabel("上传参考图", { exact: true }).setInputFiles("public/assets/tokyo-desk-v3.jpg");
  await replicaPanel.getByLabel("上传产品原图", { exact: true }).setInputFiles("public/assets/gan65-product.jpg");
  await replicaPanel.getByLabel("商品信息").fill("纯手填测试商品：不锈钢手冲壶 600ml");
  await replicaPanel.getByRole("button", { name: "一键复刻（1张）", exact: true }).click();

  const manualReplicaBatch = page.getByRole("region", { name: "复刻批次" });
  await manualReplicaBatch.getByText("已完成", { exact: true }).waitFor({ timeout: 15000 });
  assert.equal(await manualReplicaBatch.locator("[data-selected-product-card-bar]").count(), 0);

  const manualReplicaCall = ctx.apiCalls
    .filter((c) => c.method === "POST" && c.path === "/api/replicas")
    .at(-1);
  assert.equal(manualReplicaCall?.body?.productCardId, undefined);

  assert.deepEqual(pageErrors, []);
});
