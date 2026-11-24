import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import sharp from "sharp";
import { createSuiteStudioApp, type AppResponse, type SuiteStudioApp } from "../server/app.js";
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
import type {
  CategoryPromptLlmInput,
  ImageEditRequest,
  PlanLlmInput,
  ReplicaPromptLlmInput,
} from "../server/types.js";
import type { ListingRules } from "../shared/listing-config.js";
import { formatProductCardFacts, type ProductCard } from "../shared/product-card.js";

async function makePng(
  width: number,
  height: number,
  color: { r: number; g: number; b: number },
): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
}

const listingRules: ListingRules = {
  titleMaxLength: 80,
  maxBulletPoints: 5,
  supportsSearchTerms: true,
  searchTermsMaxBytes: 250,
  forbiddenWords: ["best seller"],
};

function expectOk<T = any>(response: AppResponse, status?: number): T {
  if (status !== undefined) {
    assert.equal(response.status, status, JSON.stringify(response.body));
  } else {
    assert.ok(response.status >= 200 && response.status < 300, JSON.stringify(response.body));
  }
  assert.ok("data" in response.body, JSON.stringify(response.body));
  return response.body.data as T;
}

function expectError(response: AppResponse, allowedStatuses: number[], code: string) {
  assert.ok(
    allowedStatuses.includes(response.status),
    `Expected status in ${allowedStatuses.join("/")}, got ${response.status}: ${JSON.stringify(response.body)}`,
  );
  assert.ok("error" in response.body, JSON.stringify(response.body));
  assert.equal(response.body.error.code, code);
}

async function waitUntilState(
  app: SuiteStudioApp,
  path: string,
  predicate: (data: any) => boolean,
  timeoutMs = 4_000,
) {
  const deadline = Date.now() + timeoutMs;
  let last: any;
  while (Date.now() < deadline) {
    const res = await app.request("GET", path);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    last = (res.body as any).data;
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 8));
  }
  assert.fail(`Timed out waiting for ${path}; last=${JSON.stringify(last)}`);
}

async function createDownstreamFixture(options: {
  forceMissingFactsOnce?: boolean;
  failReplicaOnce?: boolean;
  replicaTaskName?: string;
} = {}) {
  const repository = new MemorySuiteRepository();
  const storage = new MemoryStorage();
  const promptRepository = new MemoryPromptRepository();
  const planRepository = new MemoryPlanRepository();
  const categoryPromptRepository = new MemoryCategoryPromptRepository();
  const taskRepository = new MemoryTaskRepository();
  const pipelineRepository = new MemoryPipelineRepository();
  const replicaRepository = new MemoryReplicaRepository();
  const libraryRepository = new MemoryLibraryRepository();
  const productCardRepository = new MemoryProductCardRepository();

  for (const name of [
    "general-structure-plan-groups.md",
    "general-category-prompt-groups.md",
    "general-base-refine.md",
    "general-listing-copy.md",
    "replica-compose.md",
    "replica-high.md",
  ]) {
    const md = await readFile(new URL(`../prompt/normalized/${name}`, import.meta.url), "utf8");
    const record = parseNormalizedPromptMarkdown(md, name);
    const [version] = await promptRepository.importRecords([record]);
    await promptRepository.publishVersion(version.templateVersionId);
  }

  const defaultResultPng = await makePng(24, 24, { r: 230, g: 235, b: 245 });
  const structurePlanCalls: PlanLlmInput[] = [];
  const listingCopyCalls: PlanLlmInput[] = [];
  const categoryPromptCalls: CategoryPromptLlmInput[] = [];
  const replicaCalls: ReplicaPromptLlmInput[] = [];
  const providerCalls: ImageEditRequest[] = [];
  let missingTriggered = false;
  let replicaFailedOnce = false;

  const app = createSuiteStudioApp({
    repository,
    storage,
    promptRepository,
    planRepository,
    categoryPromptRepository,
    taskRepository,
    pipelineRepository,
    replicaRepository,
    libraryRepository,
    productCardRepository,
    imageRetryDelayMs: 0,
    platformRepository: {
      listEnabled: async () => [],
      find: async (code) => ({
        code,
        name: code,
        marketScope: code === "amazon" ? "overseas" : "domestic",
        mainImageBackground: "flexible",
        mainImageStrategy: "",
        galleryStrategy: "",
        textStrategy: "",
        modelStrategy: "",
        sourceNote: "",
        sortOrder: 1,
        listingCopyRules: listingRules,
      }),
    },
    provider: {
      supportsMultipleImages: true,
      async edit(request) {
        providerCalls.push(request);
        return { bytes: defaultResultPng, mimeType: "image/png" };
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
            title: "316L Stainless Vacuum Tumbler 500ml",
            bulletPoints: ["316L liner", "12h thermal insulation"],
            description: "Durable insulated tumbler for commute and outdoor use.",
            searchTerms: ["insulated tumbler", "316L bottle"],
            missingFacts: [],
          };
        }

        structurePlanCalls.push(input);
        const supplement = String(input.dynamicInput.human_supplement ?? "");
        const hasCoreFacts =
          supplement.includes("核心卖点") &&
          supplement.includes("规格参数与尺寸重量") &&
          supplement.includes("材质与工艺细节") &&
          supplement.includes("适用人群与使用场景") &&
          supplement.includes("包装清单 / 配件说明");

        const shouldPause =
          (options.forceMissingFactsOnce && !missingTriggered) ||
          (!hasCoreFacts && !supplement.trim());
        if (options.forceMissingFactsOnce && !missingTriggered) {
          missingTriggered = true;
        }

        const imageId = input.inputImageIds[0];
        const groups = input.dynamicInput.category_groups
          ? JSON.parse(String(input.dynamicInput.category_groups))
          : null;
        const mainCount = Number(input.dynamicInput.main_image_count ?? 1);
        const sellingCount = groups?.selling_points?.count ?? 1;
        const lifestyleCount = groups?.lifestyle?.count ?? 1;
        const detailTotal = sellingCount + lifestyleCount;
        const factRefs = supplement.trim() || String(input.dynamicInput.emphasis_requirements ?? "").trim()
          ? ["human_supplement"]
          : [];

        return {
          schemaVersion: "suite-structure-plan-v2",
          status: shouldPause ? "NEEDS_HUMAN_INPUT" : "READY_FOR_REVIEW",
          mainAllocation: {
            category: "main",
            count: mainCount,
            reason: "主图展示",
            sourceImageIds: [imageId],
            factRefs,
            missingFacts: [],
          },
          detailImageCount: shouldPause ? 0 : detailTotal,
          categoryAllocations: [
            "feature_benefit",
            "material_detail",
            "lifestyle_use",
            "comparison",
            "size_scale",
            "appearance_angles",
            "included_items",
            "compatibility_application",
            "variant_bundle",
            "packaging_unboxing",
            "care_instruction",
          ].map((category) => ({
            category,
            requirement: "optional",
            count: shouldPause
              ? 0
              : category === "feature_benefit"
                ? sellingCount
                : category === "lifestyle_use"
                  ? lifestyleCount
                  : 0,
            reason: "基于商品卡事实分配",
            sourceImageIds: [imageId],
            factRefs,
            missingFacts: shouldPause && category === "feature_benefit" ? ["请补充卖点细节"] : [],
          })),
          globalStyleCard: { promptPrefix: "简洁高级商业棚拍光线" },
        };
      },
      async generateCategoryPrompt(input) {
        categoryPromptCalls.push(input);
        return {
          schemaVersion: "suite-category-prompt-v1",
          category: input.categoryCode,
          items: Array.from({ length: input.requestedCount }, (_, index) => ({
            stableId: `${input.categoryCode}-${index + 1}`,
            category: input.categoryCode,
            title: `${input.categoryCode} 图 ${index + 1}`,
            purpose: "展示商品信息",
            referenceImageIds: [input.inputImageIds[0]],
            factRefs: input.approvedFactRefs,
            prompt: `生成 ${input.categoryCode} 商品图 ${index + 1}`,
            allowsTextOverlay: input.categoryCode === "main" ? "no" : "yes",
            textContent:
              input.categoryCode === "main"
                ? []
                : [{ text: "316L 不锈钢内胆", source: "human_supplement" }],
            aspectRatio: String(input.dynamicInput.aspect_ratio ?? "1:1"),
            suggestedParams: {},
          })),
        };
      },
      async generateReplicaPrompts(input) {
        replicaCalls.push(input);
        if (options.failReplicaOnce && !replicaFailedOnce) {
          replicaFailedOnce = true;
          throw new Error("LLM_TIMEOUT");
        }
        return {
          schemaVersion: "replica-prompt-v1",
          taskName: options.replicaTaskName ?? "",
          sharedStyle: input.styleUnified ? "统一清冷高级棚拍光影" : null,
          items: input.references.map((ref) => ({
            referenceId: ref.referenceId,
            visualStructure: {
              composition: `构图-${ref.ordinal}`,
              lighting: "柔和侧逆光",
              palette: "银灰+暖白",
              layout: "上文下图",
              textBlocks: ["主标题"],
            },
            copy: [{ role: "headline", text: `品质随行 ${ref.ordinal}`, position: "顶部居中" }],
            prompt: `商业复刻画面 ${ref.ordinal}`,
          })),
        };
      },
    },
  });

  async function createPublishedCard(overrides: Record<string, unknown> = {}): Promise<ProductCard> {
    const supplierImg1 = await makePng(36, 36, { r: 240, g: 100, b: 80 });
    const supplierImg2 = await makePng(40, 32, { r: 80, g: 140, b: 240 });
    const res = await app.request("POST", "/api/product-cards", {
      body: {
        name: "极光双层真空保温杯 500ml",
        category: "水杯水具",
        skuCode: "JG-CUP-500",
        sellingPoints: [
          "316L 医用级不锈钢内胆，装咖啡果汁不易串味",
          "12 小时真空长效保温保冷",
        ],
        specifications: "容量 500ml，高 215mm，底径 68mm，净重 265g",
        materialsCraft: "316L 内胆 + 304 哑光静电喷塑外壳 + 食品级硅胶密封圈",
        audienceScenarios: "上班通勤、自驾出行、露营徒步与办公桌面饮水",
        packageContents: "保温杯本体 ×1、防滑硅胶杯垫 ×1、说明书 ×1",
        painPointsComparison: "较旧款 304 单层杯保温时长提升 6 小时，杯身减重 18%",
        usageDemoHighlights: "单手弹盖开合顺畅，倒置 360° 摇晃不漏水",
        certificationsProhibitions: "已通过 FDA 食品接触检测；严禁宣称医疗功效或永不生锈",
        supplierImages: [
          { filename: "supplier-cover.png", mimeType: "image/png", bytesBase64: supplierImg1.toString("base64") },
          { filename: "supplier-detail.png", mimeType: "image/png", bytesBase64: supplierImg2.toString("base64") },
        ],
        ...overrides,
      },
    });
    return expectOk<ProductCard>(res, 201);
  }

  async function createSuiteWithInputImage(suiteName: string, filename = "cup.png") {
    const suite = await repository.createSuite(suiteName, undefined, "suite_studio");
    const imgBytes = await makePng(28, 28, { r: 210, g: 210, b: 210 });
    const imageId = randomUUID();
    const originalKey = `suites/${suite.id}/inputs/${imageId}/original`;
    const thumbKey = `suites/${suite.id}/inputs/${imageId}/thumbnail`;
    await storage.put({ key: originalKey, bytes: imgBytes, contentType: "image/png" });
    await storage.put({ key: thumbKey, bytes: imgBytes, contentType: "image/png" });
    await storage.put({
      key: originalKey.replace(/\/original$/, "/generation-input.jpg"),
      bytes: imgBytes,
      contentType: "image/jpeg",
    });
    await repository.createInputImage({
      id: imageId,
      suiteId: suite.id,
      ordinal: 1,
      originalObjectKey: originalKey,
      thumbnailObjectKey: thumbKey,
      sha256: randomUUID().replaceAll("-", "").padEnd(64, "0"),
      width: 28,
      height: 28,
      mimeType: "image/png",
      originalFilename: filename,
      currentBaseVersionId: null,
      createdAt: new Date().toISOString(),
    });
    return { suite, imageId };
  }

  return {
    app,
    repository,
    storage,
    pipelineRepository,
    productCardRepository,
    structurePlanCalls,
    listingCopyCalls,
    categoryPromptCalls,
    replicaCalls,
    providerCalls,
    createPublishedCard,
    createSuiteWithInputImage,
  };
}

test("套图绑定 published 商品卡 + 空 sellingPoints：自动命名、仅注事实不误触发补录、并联动上架文案", async () => {
  const f = await createDownstreamFixture();
  const card = await f.createPublishedCard();
  const { suite } = await f.createSuiteWithInputImage("未命名套图", "real-shot.png");

  const startedRes = await f.app.request("POST", `/api/suites/${suite.id}/pipeline`, {
    headers: { "Idempotency-Key": "suite-card-empty-sp" },
    body: {
      config: {
        platform: "amazon",
        targetMarket: "US",
        outputLanguage: "英文",
        mode: "custom",
        counts: { main: 1, selling_points: 1, lifestyle: 1, other: 0 },
        aspectRatio: "1:1",
        size: "1K",
        sellingPoints: "",
        listingCopy: true,
        productCardId: card.id,
      },
    },
  });
  const started = expectOk<{ suiteId: string; pipeline: any }>(startedRes, 202);
  assert.equal(started.suiteId, suite.id);
  const frozenSnapshot = started.pipeline.config.productCardSnapshot;
  assert.ok(frozenSnapshot);
  assert.equal(frozenSnapshot.cardId, card.id);
  assert.equal(frozenSnapshot.revision, 1);
  assert.equal(frozenSnapshot.name, card.name);
  assert.equal(frozenSnapshot.coverThumbnailUrl, card.coverThumbnailUrl);

  // Suite placeholder name updated to productCardSnapshot.name
  const state = await waitUntilState(
    f.app,
    `/api/suites/${suite.id}/studio-state`,
    (data) => data.pipeline?.status === "completed" && data.listingCopy?.status === "succeeded",
  );
  assert.equal(state.suite.name, card.name);
  assert.deepEqual(state.pipeline.config.productCardSnapshot, frozenSnapshot);

  // structure_plan received full card facts in human_supplement and empty emphasis_requirements
  assert.equal(f.structurePlanCalls.length, 1);
  const expectedFacts = formatProductCardFacts(frozenSnapshot);
  assert.equal(f.structurePlanCalls[0].dynamicInput.product_name, card.name);
  assert.equal(f.structurePlanCalls[0].dynamicInput.human_supplement, expectedFacts);
  assert.equal(f.structurePlanCalls[0].dynamicInput.emphasis_requirements, "");
  assert.notEqual(state.pipeline.status, "waiting_human_input");

  // Parallel listing copy received full product card facts including certifications & prohibitions
  assert.equal(f.listingCopyCalls.length, 1);
  const listingSellingPoints = String(f.listingCopyCalls[0].dynamicInput.selling_points ?? "");
  assert.equal(listingSellingPoints, expectedFacts);
  assert.ok(listingSellingPoints.includes(card.certificationsProhibitions));

  const listingJobRes = await f.app.request("GET", `/api/listing-copies/${state.listingCopy.id}`);
  const listingJob = expectOk<any>(listingJobRes, 200);
  assert.equal(listingJob.input.sellingPoints, expectedFacts);
  assert.equal(listingJob.versions[0].promptSnapshot.input.selling_points, expectedFacts);
});

test("套图绑定商品卡 + 填写本次要求：human_supplement 与 emphasis_requirements 分离，不覆写自定义方案名", async () => {
  const f = await createDownstreamFixture();
  const card = await f.createPublishedCard();
  const { suite } = await f.createSuiteWithInputImage("双十一礼盒专项套图", "shot.png");
  const extraRequirement = "突出深蓝科技光感与秋冬礼盒氛围，主图保留大面积留白";

  const startedRes = await f.app.request("POST", "/api/suites/one-click-generate", {
    headers: { "Idempotency-Key": "suite-card-with-extra" },
    body: {
      suiteId: suite.id,
      config: {
        platform: "amazon",
        targetMarket: "US",
        outputLanguage: "中文",
        mode: "custom",
        counts: { main: 1, selling_points: 1, lifestyle: 0, other: 0 },
        sellingPoints: extraRequirement,
        listingCopy: true,
        productCardId: card.id,
      },
    },
  });
  const started = expectOk<{ suiteId: string; pipeline: any }>(startedRes, 202);
  const frozenSnapshot = started.pipeline.config.productCardSnapshot;
  const expectedFacts = formatProductCardFacts(frozenSnapshot);
  const expectedMerged = `${expectedFacts}\n\n【本次补充说明】\n${extraRequirement}`;

  const state = await waitUntilState(
    f.app,
    `/api/suites/${suite.id}/studio-state`,
    (data) => data.pipeline?.status === "completed" && data.listingCopy?.status === "succeeded",
  );
  // Custom suite name preserved
  assert.equal(state.suite.name, "双十一礼盒专项套图");

  // structure_plan splits facts + extra vs pure emphasis_requirements
  assert.equal(f.structurePlanCalls.length, 1);
  assert.equal(f.structurePlanCalls[0].dynamicInput.product_name, card.name);
  assert.equal(f.structurePlanCalls[0].dynamicInput.human_supplement, expectedMerged);
  assert.equal(f.structurePlanCalls[0].dynamicInput.emphasis_requirements, extraRequirement);

  // category_prompt keeps emphasis_requirements separate and does not duplicate extraRequirement
  assert.ok(f.categoryPromptCalls.length >= 1);
  assert.equal(f.categoryPromptCalls[0].dynamicInput.human_supplement, expectedMerged);
  assert.equal(f.categoryPromptCalls[0].dynamicInput.emphasis_requirements, extraRequirement);

  // Listing copy merges card facts and extra requirement
  assert.equal(f.listingCopyCalls.length, 1);
  assert.equal(f.listingCopyCalls[0].dynamicInput.selling_points, expectedMerged);

  // Regenerating listing copy with new extra text automatically re-merges frozen card facts without duplication
  const regenExtra = "侧重圣诞送礼卖点";
  const regenRes = await f.app.request("POST", `/api/listing-copies/${state.listingCopy.id}/regenerate`, {
    body: { sellingPoints: regenExtra },
  });
  expectOk(regenRes, 202);
  await waitUntilState(
    f.app,
    `/api/listing-copies/${state.listingCopy.id}`,
    (job) => job.status === "succeeded" && job.versions.length === 2,
  );
  assert.equal(f.listingCopyCalls.length, 2);
  assert.equal(
    f.listingCopyCalls[1].dynamicInput.selling_points,
    `${expectedFacts}\n\n【本次补充说明】\n${regenExtra}`,
  );
});

test("套图未传 productCardId 时保持原有逻辑，且忽略客户端伪造的 productCardSnapshot", async () => {
  const f = await createDownstreamFixture();
  const { suite } = await f.createSuiteWithInputImage("散单套图", "bottle.png");
  const manualText = "手填卖点：304 不锈钢 500ml 轻便防漏，强调极简白底";

  const startedRes = await f.app.request("POST", "/api/suites/one-click-generate", {
    headers: { "Idempotency-Key": "suite-no-card" },
    body: {
      suiteId: suite.id,
      config: {
        platform: "amazon",
        targetMarket: "US",
        outputLanguage: "中文",
        mode: "custom",
        counts: { main: 1, selling_points: 1, lifestyle: 0, other: 0 },
        sellingPoints: manualText,
        productCardSnapshot: {
          cardId: randomUUID(),
          revision: 99,
          name: "伪造商品名",
        },
      },
    },
  });
  const started = expectOk<{ suiteId: string; pipeline: any }>(startedRes, 202);
  assert.equal(started.pipeline.config.productCardSnapshot, undefined);

  await waitUntilState(
    f.app,
    `/api/suites/${suite.id}/studio-state`,
    (data) => data.pipeline?.status === "completed",
  );
  assert.equal(f.structurePlanCalls.length, 1);
  assert.equal(f.structurePlanCalls[0].dynamicInput.human_supplement, manualText);
  assert.equal(f.structurePlanCalls[0].dynamicInput.emphasis_requirements, manualText);
});

test("复刻绑定商品卡（含本地产品原图与无产品原图）：注入商品卡事实、绝不混入供应商参考图、标题优先商品卡名", async () => {
  const f = await createDownstreamFixture({ replicaTaskName: "" });
  const card = await f.createPublishedCard();
  assert.equal(card.supplierImages.length, 2);

  const refPng = await makePng(64, 64, { r: 20, g: 30, b: 40 });
  const localProductPng = await makePng(48, 48, { r: 190, g: 195, b: 205 });

  // Case 1: With 1 local uploaded product image + extra productInfo + independent unifiedRequirement
  const withProdRes = await f.app.request("POST", "/api/replicas", {
    headers: { "Idempotency-Key": "replica-card-with-prod" },
    body: {
      references: [
        { filename: "ref1.png", mimeType: "image/png", bytesBase64: refPng.toString("base64"), remark: "保留居中构图" },
      ],
      products: [
        { sourceKind: "upload", filename: "local-prod.png", mimeType: "image/png", bytesBase64: localProductPng.toString("base64") },
      ],
      sceneType: "ecommerce_product",
      cloneLevel: "high",
      unifiedRequirement: "保持冷色高级金属光影，字号克制",
      productInfo: "本次主推午夜蓝配色",
      productCardId: card.id,
      styleUnified: false,
      language: "zh",
      ratio: "1:1",
      size: "1K",
    },
  });
  const withProd = expectOk<{ suiteId: string; runId: string }>(withProdRes, 201);
  const withProdState = await waitUntilState(
    f.app,
    `/api/replicas/${withProd.suiteId}/studio-state`,
    (data) => data.pipeline?.status === "completed",
  );

  // Batch title falls back to productCardSnapshot.name when model taskName is empty
  assert.equal(withProdState.suite.name, card.name);
  assert.equal(withProdState.productCardSnapshot.cardId, card.id);
  assert.equal(withProdState.pipeline.config.productCardSnapshot.cardId, card.id);
  assert.equal(withProdState.replicaProducts.length, 1);

  // replica_prompt received merged productInfo & independent unifiedRequirement, and ONLY 1 local product image
  assert.equal(f.replicaCalls.length, 1);
  const expectedFacts = formatProductCardFacts(withProdState.productCardSnapshot);
  assert.equal(
    f.replicaCalls[0].productInfo,
    `${expectedFacts}\n\n【本次补充说明】\n本次主推午夜蓝配色`,
  );
  assert.equal(f.replicaCalls[0].unifiedRequirement, "保持冷色高级金属光影，字号克制");
  assert.equal(f.replicaCalls[0].productImages.length, 1);

  // Image provider received ONLY 1 local product image + 1 reference image (no supplier images)
  assert.equal(f.providerCalls.length, 1);
  const providerImages = f.providerCalls[0].images ?? [];
  const productProviderImages = providerImages.filter(
    (img) => img.role === "product_primary" || img.role === "product_detail",
  );
  assert.equal(productProviderImages.length, 1);
  assert.equal(productProviderImages[0].filename, "local-prod.png");
  assert.equal(providerImages.length, 2);

  // Case 2: Without local product images (style sketch mode), supplier images still NEVER enter products[]
  const noProdRes = await f.app.request("POST", "/api/replicas", {
    headers: { "Idempotency-Key": "replica-card-no-prod" },
    body: {
      references: [
        { filename: "ref2.png", mimeType: "image/png", bytesBase64: refPng.toString("base64") },
      ],
      products: [],
      sceneType: "ecommerce_product",
      cloneLevel: "compose",
      unifiedRequirement: "极简自然光线",
      productInfo: "",
      productCardId: card.id,
      styleUnified: false,
      language: "zh",
      ratio: "1:1",
      size: "1K",
    },
  });
  const noProd = expectOk<{ suiteId: string; runId: string }>(noProdRes, 201);
  const noProdState = await waitUntilState(
    f.app,
    `/api/replicas/${noProd.suiteId}/studio-state`,
    (data) => data.pipeline?.status === "completed",
  );
  assert.equal(noProdState.suite.name, card.name);
  assert.equal(noProdState.styleSketch, true);
  assert.equal(noProdState.replicaProducts.length, 0);
  assert.equal(noProdState.productCardSnapshot.cardId, card.id);
  assert.equal(f.replicaCalls.length, 2);
  assert.equal(f.replicaCalls[1].productImages.length, 0);
  assert.equal(f.replicaCalls[1].productInfo, expectedFacts);
  assert.equal(f.replicaCalls[1].unifiedRequirement, "极简自然光线");
  assert.equal(f.providerCalls.length, 2);
  const noProdProviderImages = f.providerCalls[1].images ?? [];
  assert.equal(
    noProdProviderImages.filter((img) => img.role === "product_primary" || img.role === "product_detail").length,
    0,
  );
  assert.equal(noProdProviderImages.length, 1);
});

test("快照不可变性：原卡编辑/归档/删除后，历史 studio-state、resume 与事后补文案仍用旧快照，新批次拒绝不可用卡", async () => {
  const f = await createDownstreamFixture({ forceMissingFactsOnce: true, failReplicaOnce: true });
  const card = await f.createPublishedCard({
    name: "初代轻羽保温杯 v1",
    specifications: "初代参数：容量 500ml，净重 265g",
    certificationsProhibitions: "初代禁忌：禁止宣称医疗功效",
  });
  const { suite } = await f.createSuiteWithInputImage("未命名商品套图", "cup-v1.png");

  // 1. Start suite pipeline (will pause at waiting_human_input once) with listingCopy=false
  const startedRes = await f.app.request("POST", "/api/suites/one-click-generate", {
    headers: { "Idempotency-Key": "suite-immutability-v1" },
    body: {
      suiteId: suite.id,
      config: {
        platform: "amazon",
        targetMarket: "US",
        outputLanguage: "中文",
        mode: "custom",
        counts: { main: 1, selling_points: 1, lifestyle: 0, other: 0 },
        sellingPoints: "",
        listingCopy: false,
        productCardId: card.id,
      },
    },
  });
  expectOk(startedRes, 202);
  const pausedState = await waitUntilState(
    f.app,
    `/api/suites/${suite.id}/studio-state`,
    (data) => data.pipeline?.status === "waiting_human_input",
  );
  assert.equal(pausedState.pipeline.config.productCardSnapshot.revision, 1);
  assert.equal(pausedState.pipeline.config.productCardSnapshot.name, "初代轻羽保温杯 v1");

  // 2. Start a replica batch that fails once during replica_analyzing (for resume test)
  const refPng = await makePng(48, 48, { r: 60, g: 80, b: 100 });
  const replicaStartRes = await f.app.request("POST", "/api/replicas", {
    headers: { "Idempotency-Key": "replica-immutability-v1" },
    body: {
      references: [{ filename: "ref.png", mimeType: "image/png", bytesBase64: refPng.toString("base64") }],
      products: [],
      sceneType: "ecommerce_product",
      cloneLevel: "high",
      unifiedRequirement: "保持原构图",
      productInfo: "",
      productCardId: card.id,
      styleUnified: false,
      language: "zh",
      ratio: "1:1",
      size: "1K",
    },
  });
  const replicaStarted = expectOk<{ suiteId: string; runId: string }>(replicaStartRes, 201);
  const replicaFailedState = await waitUntilState(
    f.app,
    `/api/replicas/${replicaStarted.suiteId}/studio-state`,
    (data) => data.pipeline?.status === "failed",
  );
  assert.equal(replicaFailedState.productCardSnapshot.revision, 1);

  // 3. Edit the original product card -> revision 2
  const editedRes = await f.app.request("PATCH", `/api/product-cards/${card.id}`, {
    body: {
      name: "二代重装保温杯 v2",
      category: card.category,
      sellingPoints: ["二代新增卖点"],
      specifications: "二代参数：容量 1000ml，净重 500g",
      materialsCraft: card.materialsCraft,
      audienceScenarios: card.audienceScenarios,
      packageContents: card.packageContents,
      certificationsProhibitions: "二代禁忌：仅限常温使用",
      supplierImages: [],
    },
  });
  const editedCard = expectOk<ProductCard>(editedRes, 200);
  assert.equal(editedCard.revision, 2);

  // 4. Archive the original product card
  const archivedRes = await f.app.request("POST", `/api/product-cards/${card.id}/archive`);
  expectOk(archivedRes, 200);

  // 5. New suite & replica batches referencing archived card MUST be rejected
  const { suite: rejectedSuite } = await f.createSuiteWithInputImage("待拒绝套图");
  expectError(
    await f.app.request("POST", `/api/suites/${rejectedSuite.id}/pipeline`, {
      headers: { "Idempotency-Key": "reject-archived-suite" },
      body: { config: { platform: "amazon", productCardId: card.id } },
    }),
    [400, 404],
    "PRODUCT_CARD_NOT_AVAILABLE",
  );
  expectError(
    await f.app.request("POST", "/api/replicas", {
      headers: { "Idempotency-Key": "reject-archived-replica" },
      body: {
        references: [{ filename: "ref.png", mimeType: "image/png", bytesBase64: refPng.toString("base64") }],
        products: [],
        sceneType: "ecommerce_product",
        cloneLevel: "high",
        productCardId: card.id,
      },
    }),
    [400, 404],
    "PRODUCT_CARD_NOT_AVAILABLE",
  );

  // 6. Delete the original product card completely
  const deletedRes = await f.app.request("DELETE", `/api/product-cards/${card.id}`);
  expectOk(deletedRes, 200);

  // New suite & replica batches referencing deleted / nonexistent / malformed card MUST be rejected
  for (const badId of [card.id, randomUUID(), "not-a-uuid"]) {
    expectError(
      await f.app.request("POST", "/api/suites/one-click-generate", {
        headers: { "Idempotency-Key": `reject-bad-suite-${badId}` },
        body: { suiteId: rejectedSuite.id, config: { platform: "amazon", productCardId: badId } },
      }),
      [400, 404],
      "PRODUCT_CARD_NOT_AVAILABLE",
    );
    expectError(
      await f.app.request("POST", "/api/replicas", {
        headers: { "Idempotency-Key": `reject-bad-replica-${badId}` },
        body: {
          references: [{ filename: "ref.png", mimeType: "image/png", bytesBase64: refPng.toString("base64") }],
          products: [],
          sceneType: "ecommerce_product",
          cloneLevel: "high",
          productCardId: badId,
        },
      }),
      [400, 404],
      "PRODUCT_CARD_NOT_AVAILABLE",
    );
  }

  // 7. Historical suite resume still uses frozen v1 snapshot (NOT v2, NOT broken by delete)
  const resumeSuiteRes = await f.app.request("POST", `/api/suites/${suite.id}/one-click-generate/resume`, {
    headers: { "Idempotency-Key": "resume-suite-after-delete" },
    body: { action: "submit_missing_facts", supplementText: "本次补录：突出轻量化握感" },
  });
  expectOk(resumeSuiteRes, 202);
  const completedSuiteState = await waitUntilState(
    f.app,
    `/api/suites/${suite.id}/studio-state`,
    (data) => data.pipeline?.status === "completed",
  );
  assert.equal(completedSuiteState.pipeline.config.productCardSnapshot.revision, 1);
  assert.equal(completedSuiteState.pipeline.config.productCardSnapshot.name, "初代轻羽保温杯 v1");
  assert.equal(completedSuiteState.pipeline.config.productCardSnapshot.specifications, "初代参数：容量 500ml，净重 265g");

  assert.equal(f.structurePlanCalls.length, 2);
  const resumedPlanInput = f.structurePlanCalls[1].dynamicInput;
  assert.equal(resumedPlanInput.product_name, "初代轻羽保温杯 v1");
  assert.ok(String(resumedPlanInput.human_supplement).includes("初代参数：容量 500ml，净重 265g"));
  assert.ok(String(resumedPlanInput.human_supplement).includes("【本次补充说明】\n本次补录：突出轻量化握感"));
  assert.ok(!String(resumedPlanInput.human_supplement).includes("二代参数"));
  assert.equal(resumedPlanInput.emphasis_requirements, "本次补录：突出轻量化握感");

  // 8. After-the-fact listing copy creation from historical suite still uses frozen v1 snapshot
  const lateListingRes = await f.app.request("POST", "/api/listing-copies", {
    body: { sourceSuiteId: suite.id, generate: true },
  });
  const lateListing = expectOk<any>(lateListingRes, 202);
  const finishedLateListing = await waitUntilState(
    f.app,
    `/api/listing-copies/${lateListing.id}`,
    (job) => job.status === "succeeded",
  );
  assert.ok(finishedLateListing.input.sellingPoints.includes("初代参数：容量 500ml，净重 265g"));
  assert.ok(finishedLateListing.input.sellingPoints.includes("初代禁忌：禁止宣称医疗功效"));
  assert.ok(finishedLateListing.input.sellingPoints.includes("本次补录：突出轻量化握感"));
  assert.ok(!finishedLateListing.input.sellingPoints.includes("二代参数"));
  assert.equal(
    finishedLateListing.versions[0].promptSnapshot.input.selling_points,
    finishedLateListing.input.sellingPoints,
  );

  // 9. Historical replica resume still uses frozen v1 snapshot
  const resumeReplicaRes = await f.app.request("POST", `/api/replicas/${replicaStarted.suiteId}/resume`, {
    headers: { "Idempotency-Key": "resume-replica-after-delete" },
  });
  expectOk(resumeReplicaRes, 202);
  const completedReplicaState = await waitUntilState(
    f.app,
    `/api/replicas/${replicaStarted.suiteId}/studio-state`,
    (data) => data.pipeline?.status === "completed",
  );
  assert.equal(completedReplicaState.productCardSnapshot.revision, 1);
  assert.equal(completedReplicaState.productCardSnapshot.name, "初代轻羽保温杯 v1");
  assert.equal(completedReplicaState.suite.name, "初代轻羽保温杯 v1");
  assert.equal(f.replicaCalls.length, 2);
  assert.ok(String(f.replicaCalls[1].productInfo).includes("初代参数：容量 500ml，净重 265g"));
  assert.ok(!String(f.replicaCalls[1].productInfo).includes("二代参数"));
});
