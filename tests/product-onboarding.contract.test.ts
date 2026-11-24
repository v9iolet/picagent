import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import sharp from "sharp";
import { createSuiteStudioApp } from "../server/app.js";
import {
  MemoryProductOnboardingRepository,
  PRODUCT_ONBOARDING_SCHEMA_VERSION,
} from "../server/product-onboarding/index.js";
import {
  importPromptRecordsWithPolicy,
  isNormalizedPromptMarkdown,
  parseNormalizedPromptMarkdown,
  resolvePromptTemplateUsedBy,
} from "../server/prompt-library.js";
import {
  PRODUCT_CARD_WRITE_BODY_MAX_BYTES,
  resolveRequestBodyLimit,
} from "../server/request-body-limit.js";
import { MemoryLibraryRepository } from "../server/repositories/memory-library-repository.js";
import { MemoryProductCardRepository } from "../server/repositories/memory-product-card-repository.js";
import { MemoryPromptRepository } from "../server/repositories/memory-prompt-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";
import type { LlmClient, ProductOnboardingLlmInput } from "../server/types.js";
import {
  emptyProductCardFields,
  PRODUCT_CARD_NO_EXTRA_ACCESSORIES_TEXT,
  type ProductCard,
} from "../shared/product-card.js";
import type {
  ProductOnboardingPublishResult,
  ProductOnboardingSession,
  ProductOnboardingSessionListResult,
} from "../shared/product-onboarding.js";

async function makeTestImageBase64(
  seed: number,
  format: "png" | "jpeg" | "webp" = "png",
): Promise<{ filename: string; mimeType: string; bytesBase64: string }> {
  const image = sharp({
    create: {
      width: 32 + (seed % 5) * 4,
      height: 24 + (seed % 3) * 4,
      channels: 3,
      background: {
        r: (seed * 53) % 255,
        g: (seed * 97) % 255,
        b: (seed * 149) % 255,
      },
    },
  });
  const bytes =
    format === "jpeg"
      ? await image.jpeg().toBuffer()
      : format === "webp"
        ? await image.webp().toBuffer()
        : await image.png().toBuffer();
  const mimeType =
    format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";
  const ext = format === "jpeg" ? "jpg" : format;
  return {
    filename: `supplier-${seed}.${ext}`,
    mimeType,
    bytesBase64: bytes.toString("base64"),
  };
}

function makeTxtBase64(filename: string, text: string) {
  return {
    filename,
    bytesBase64: Buffer.from(text, "utf8").toString("base64"),
  };
}

async function seedOnboardingPromptRepository(): Promise<MemoryPromptRepository> {
  const prompts = new MemoryPromptRepository();
  const sourcePath = "prompt/normalized/product-onboarding.md";
  const markdown = await readFile(sourcePath, "utf8");
  const record = parseNormalizedPromptMarkdown(markdown, sourcePath);
  const [imported] = await prompts.importRecords([record]);
  await prompts.publishVersion(imported.templateVersionId);
  return prompts;
}

function createFakeVisionLlm(
  handler: (input: ProductOnboardingLlmInput, callIndex: number) => unknown | Promise<unknown>,
): { llm: LlmClient; calls: ProductOnboardingLlmInput[] } {
  const calls: ProductOnboardingLlmInput[] = [];
  const llm: LlmClient = {
    provider: "fake-vision",
    model: "fake-vision-v1",
    isFake: true,
    async generatePlan() {
      throw new Error("not used");
    },
    async generateProductOnboarding(input: ProductOnboardingLlmInput) {
      calls.push(input);
      return handler(input, calls.length);
    },
  };
  return { llm, calls };
}

async function createOnboardingTestContext(
  handler?: (input: ProductOnboardingLlmInput, callIndex: number) => unknown | Promise<unknown>,
) {
  const storage = new MemoryStorage();
  const repository = new MemorySuiteRepository();
  const libraryRepository = new MemoryLibraryRepository();
  const productCardRepository = new MemoryProductCardRepository();
  const productOnboardingRepository = new MemoryProductOnboardingRepository();
  const promptRepository = await seedOnboardingPromptRepository();
  const fake = handler ? createFakeVisionLlm(handler) : null;
  const app = createSuiteStudioApp({
    repository,
    storage,
    libraryRepository,
    productCardRepository,
    productOnboardingRepository,
    promptRepository,
    llmClient: fake?.llm,
  });
  return {
    app,
    storage,
    libraryRepository,
    productCardRepository,
    productOnboardingRepository,
    promptRepository,
    llmCalls: fake?.calls ?? [],
  };
}

test("full first-turn onboarding completes, publishes idempotently, locks session read-only (409), and isolates supplier images", async () => {
  const img1 = await makeTestImageBase64(1, "png");
  const img2 = await makeTestImageBase64(2, "jpeg");

  const { app, storage, llmCalls } = await createOnboardingTestContext(async () => ({
    schemaVersion: PRODUCT_ONBOARDING_SCHEMA_VERSION,
    reply: "核心 6 项必填信息已全部提取完整，请核对右侧商品信息卡后点击「保存到商品库」。",
    draftCard: {
      name: "双层真空不锈钢保温杯 500ml",
      sellingPoints: [
        "316L 医用级不锈钢内胆，耐酸碱不留异味",
        "12 小时保温保冷，满足全天饮水需求",
      ],
      specifications: "容量 500ml，高度 215mm，杯底直径 68mm，空杯净重 265g",
      materialsCraft: "316L 不锈钢内胆 + 304 不锈钢外壳，哑光静电喷塑工艺",
      audienceScenarios: "通勤上班族、学生、自驾及户外露营日常饮水",
      packageContents: "保温杯本体 ×1、食品级硅胶杯垫 ×1、说明书 ×1",
      painPointsComparison: "相比旧款 304 内胆更耐酸碱，杯身减重 15%",
      usageDemoHighlights: "一键按压弹盖，单手开合不漏水",
      certificationsProhibitions: "FDA / LFGB 食品接触认证；不可宣传医疗功效",
    },
    missingRequiredFields: [],
  }));

  const createRes = await app.request("POST", "/api/product-onboarding/sessions", {
    body: {
      message:
        "新品：双层真空不锈钢保温杯 500ml，316L内胆+304外壳哑光喷塑，高215mm直径68mm重265g，12小时保温保冷，通勤露营适用，包装含杯体+硅胶杯垫+说明书，FDA认证不可宣传医疗功效。",
      supplierImages: [img1, img2, img1], // img1 duplicated -> deduplicated to 2
    },
  });
  assert.equal(createRes.status, 201);
  const created = (createRes.body as { data: ProductOnboardingSession }).data;
  assert.equal(created.status, "draft");
  assert.equal(created.title, "双层真空不锈钢保温杯 500ml");
  assert.deepEqual(created.missingRequiredFields, []);
  assert.equal(created.supplierImages.length, 2);
  assert.equal(created.messages.length, 2);
  assert.equal(created.messages[0].role, "user");
  assert.equal(created.messages[1].role, "assistant");
  assert.ok(created.messages[1].templateVersionId);
  assert.equal(llmCalls.length, 1);
  assert.equal(llmCalls[0].supplierImages.length, 2);

  // Draft supplier image preview works for both original and thumbnail
  const previewThumb = await app.request("GET", created.supplierImages[0].thumbnailPreviewUrl);
  assert.equal(previewThumb.status, 200);
  assert.ok(previewThumb.raw && previewThumb.raw.length > 0);
  const previewOrig = await app.request("GET", created.supplierImages[0].originalPreviewUrl);
  assert.equal(previewOrig.status, 200);
  assert.equal(previewOrig.headers?.["content-type"], "image/png");

  // Publish creates published ProductCard, migrates supplier images, marks session completed
  const publishRes = await app.request(
    "POST",
    `/api/product-onboarding/sessions/${created.id}/publish`,
  );
  assert.equal(publishRes.status, 200);
  const published = (publishRes.body as { data: ProductOnboardingPublishResult }).data;
  assert.equal(published.session.status, "completed");
  assert.ok(published.productCard);
  assert.equal(published.session.productCardId, published.productCard.id);
  assert.equal(published.productCard.status, "published");
  assert.equal(published.productCard.sourceSessionId, created.id);
  assert.equal(published.productCard.supplierImages.length, 2);
  assert.match(
    published.productCard.supplierImages[0].originalObjectKey,
    new RegExp(`^product-cards/${published.productCard.id}/images/`),
  );

  // Migrated product card image preview works
  const cardImgPreview = await app.request(
    "GET",
    published.productCard.supplierImages[0].thumbnailPreviewUrl,
  );
  assert.equal(cardImgPreview.status, 200);
  assert.ok(cardImgPreview.raw && cardImgPreview.raw.length > 0);

  // Supplier images never leak into /api/library/resources
  const libRes = await app.request("GET", "/api/library/resources?scope=image");
  assert.equal(libRes.status, 200);
  assert.equal((libRes.body as { data: { items: unknown[] } }).data.items.length, 0);

  // Publish is idempotent: second call returns the same productCard without duplicating
  const publishAgain = await app.request(
    "POST",
    `/api/product-onboarding/sessions/${created.id}/publish`,
  );
  assert.equal(publishAgain.status, 200);
  const publishedAgain = (publishAgain.body as { data: ProductOnboardingPublishResult }).data;
  assert.equal(publishedAgain.productCard?.id, published.productCard.id);

  // Completed session is read-only: POST /messages and PATCH /draft return 409
  const msgAfterPublish = await app.request(
    "POST",
    `/api/product-onboarding/sessions/${created.id}/messages`,
    { body: { message: "再改一下规格" } },
  );
  assert.equal(msgAfterPublish.status, 409);
  assert.equal(
    "error" in msgAfterPublish.body && msgAfterPublish.body.error.code,
    "PRODUCT_ONBOARDING_SESSION_COMPLETED",
  );

  const draftAfterPublish = await app.request(
    "PATCH",
    `/api/product-onboarding/sessions/${created.id}/draft`,
    { body: { name: "非法修改" } },
  );
  assert.equal(draftAfterPublish.status, 409);
  assert.equal(
    "error" in draftAfterPublish.body && draftAfterPublish.body.error.code,
    "PRODUCT_ONBOARDING_SESSION_COMPLETED",
  );

  // List sessions supports status filter
  const completedList = await app.request(
    "GET",
    "/api/product-onboarding/sessions?status=completed&limit=20&offset=0",
  );
  assert.equal(completedList.status, 200);
  const listData = (completedList.body as { data: ProductOnboardingSessionListResult }).data;
  assert.equal(listData.total, 1);
  assert.equal(listData.items[0].id, created.id);
  const draftList = await app.request("GET", "/api/product-onboarding/sessions?status=draft");
  assert.equal((draftList.body as { data: ProductOnboardingSessionListResult }).data.total, 0);

  // Deleting session cleans up draft images without affecting published product card
  const draftObjKey = created.supplierImages[0].originalObjectKey;
  const cardObjKey = published.productCard.supplierImages[0].originalObjectKey;
  const deleteRes = await app.request("DELETE", `/api/product-onboarding/sessions/${created.id}`);
  assert.equal(deleteRes.status, 200);
  assert.equal(await storage.get(draftObjKey), null);
  assert.ok(await storage.get(cardObjKey));
  const cardStillExists = await app.request("GET", `/api/product-cards/${published.productCard.id}`);
  assert.equal(cardStillExists.status, 200);
  assert.equal((cardStillExists.body as { data: ProductCard }).data.id, published.productCard.id);
});

test("multi-turn with image + partial .txt, consolidated follow-up, manual PATCH /draft preservation, no-accessories normalization, and explicit correction", async () => {
  const img1 = await makeTestImageBase64(11, "png");
  const img2 = await makeTestImageBase64(12, "webp");

  const { app, llmCalls } = await createOnboardingTestContext(async (input, callIndex) => {
    if (callIndex === 1) {
      // Model intentionally omits one missing field to verify server recomputes authoritative missingRequiredFields
      return {
        schemaVersion: PRODUCT_ONBOARDING_SCHEMA_VERSION,
        reply:
          "已从供应商图和说明文档提取商品名称。请一次性补充以下缺失必填项：\n1. 核心卖点\n2. 规格参数与尺寸重量\n3. 材质与工艺细节\n4. 适用人群与使用场景\n5. 包装清单 / 配件说明",
        draftCard: {
          ...emptyProductCardFields(),
          name: "重磅纯棉短袖T恤",
          specifications: "暂无", // Placeholder must be stripped by server
        },
        missingRequiredFields: ["sellingPoints", "materialsCraft"], // Model under-reported
      };
    }
    if (callIndex === 2) {
      // Model tries to regress the manually edited name & materialsCraft back to older values,
      // and returns shorthand "无配件" for packageContents.
      return {
        schemaVersion: PRODUCT_ONBOARDING_SCHEMA_VERSION,
        reply: "全部 6 项必填信息已补齐，请核对右侧卡片后保存到商品库。",
        draftCard: {
          ...input.currentDraftCard,
          name: "重磅纯棉短袖T恤", // Regression attempt (user manually edited this via PATCH /draft)
          materialsCraft: "普通纯棉", // Regression attempt (user manually edited this via PATCH /draft)
          sellingPoints: ["260g 高克重不易透", "双针罗纹领口耐洗不变形"],
          specifications: "尺码 M-XXL，克重 260g/m²，衣长 70-76cm",
          audienceScenarios: "男女通用，春夏日常通勤与休闲穿搭",
          packageContents: "无配件", // Must be normalized to 单品本体 ×1，无额外配件
        },
        missingRequiredFields: [],
      };
    }
    // Turn 3: user explicitly requests updating the product name
    return {
      schemaVersion: PRODUCT_ONBOARDING_SCHEMA_VERSION,
      reply: "已将商品名称更正为「新疆长绒棉 260g 重磅T恤 Pro」。",
      draftCard: {
        ...input.currentDraftCard,
        name: "新疆长绒棉 260g 重磅T恤 Pro",
      },
      missingRequiredFields: [],
    };
  });

  // Turn 1: upload 1 supplier image + partial UTF-8 .txt
  const txt1 = makeTxtBase64(
    "product-brief.txt",
    "品名：重磅纯棉短袖T恤\n说明：首批打样，参数待补。",
  );
  const turn1Res = await app.request("POST", "/api/product-onboarding/sessions", {
    body: {
      message: "先发一张样衣图和初步说明文档",
      txtFiles: [txt1],
      supplierImages: [img1],
    },
  });
  assert.equal(turn1Res.status, 201);
  const turn1 = (turn1Res.body as { data: ProductOnboardingSession }).data;
  assert.equal(turn1.draftCard.name, "重磅纯棉短袖T恤");
  assert.equal(turn1.draftCard.specifications, ""); // Placeholder stripped
  assert.deepEqual(turn1.missingRequiredFields, [
    "sellingPoints",
    "specifications",
    "materialsCraft",
    "audienceScenarios",
    "packageContents",
  ]);
  assert.equal(turn1.messages[0].attachments.some((a) => a.kind === "txt" && a.filename === "product-brief.txt"), true);
  assert.equal(turn1.messages[0].attachments.some((a) => a.kind === "image"), true);
  assert.match(turn1.messages[1].content, /1\..*核心卖点/);
  assert.match(turn1.messages[1].content, /5\..*包装清单/);

  // Right-side manual edit via PATCH /draft (edits name, materialsCraft, and adds/reorders image)
  const patchRes = await app.request(
    "PATCH",
    `/api/product-onboarding/sessions/${turn1.id}/draft`,
    {
      body: {
        draftCard: {
          name: "新疆长绒棉 260g 重磅T恤（手改版）",
          materialsCraft: "100% 新疆长绒棉，活性固色工艺，双针加固领口",
        },
        supplierImages: [img2, { imageId: turn1.supplierImages[0].id }],
      },
    },
  );
  assert.equal(patchRes.status, 200);
  const patched = (patchRes.body as { data: ProductOnboardingSession }).data;
  assert.equal(patched.title, "新疆长绒棉 260g 重磅T恤（手改版）");
  assert.equal(patched.draftCard.materialsCraft, "100% 新疆长绒棉，活性固色工艺，双针加固领口");
  assert.equal(patched.supplierImages.length, 2);
  assert.equal(patched.supplierImages[0].originalFilename, img2.filename);
  assert.equal(patched.supplierImages[1].id, turn1.supplierImages[0].id);
  assert.deepEqual(patched.missingRequiredFields, [
    "sellingPoints",
    "specifications",
    "audienceScenarios",
    "packageContents",
  ]);

  // Turn 2: fill remaining missing fields + confirm no extra accessories
  const turn2Res = await app.request(
    "POST",
    `/api/product-onboarding/sessions/${turn1.id}/messages`,
    {
      body: {
        message:
          "补齐剩余信息：卖点是 260g 高克重不易透、双针罗纹领口耐洗不变形；规格 M-XXL 克重 260g/m² 衣长 70-76cm；适用人群为男女通用春夏通勤与休闲穿搭；衣服单品没有额外配件。",
      },
    },
  );
  assert.equal(turn2Res.status, 200);
  const turn2 = (turn2Res.body as { data: ProductOnboardingSession }).data;
  assert.equal(llmCalls.length, 2);
  // LLM received the updated draftCard and both supplier image thumbnails
  assert.equal(llmCalls[1].currentDraftCard.name, "新疆长绒棉 260g 重磅T恤（手改版）");
  assert.equal(llmCalls[1].supplierImages.length, 2);
  // Manually edited fields are preserved against model regression
  assert.equal(turn2.draftCard.name, "新疆长绒棉 260g 重磅T恤（手改版）");
  assert.equal(turn2.draftCard.materialsCraft, "100% 新疆长绒棉，活性固色工艺，双针加固领口");
  // No-accessories packageContents is normalized
  assert.equal(turn2.draftCard.packageContents, PRODUCT_CARD_NO_EXTRA_ACCESSORIES_TEXT);
  assert.deepEqual(turn2.missingRequiredFields, []);

  // Turn 3: explicit correction in latest message DOES update the field
  const turn3Res = await app.request(
    "POST",
    `/api/product-onboarding/sessions/${turn1.id}/messages`,
    {
      body: {
        message: "把商品名称改成 新疆长绒棉 260g 重磅T恤 Pro",
      },
    },
  );
  assert.equal(turn3Res.status, 200);
  const turn3 = (turn3Res.body as { data: ProductOnboardingSession }).data;
  assert.equal(turn3.draftCard.name, "新疆长绒棉 260g 重磅T恤 Pro");
  assert.equal(turn3.title, "新疆长绒棉 260g 重磅T恤 Pro");
  assert.equal(turn3.draftCard.materialsCraft, "100% 新疆长绒棉，活性固色工艺，双针加固领口");

  // Publish preserves manually edited fields & normalized packageContents & image order
  const pubRes = await app.request(
    "POST",
    `/api/product-onboarding/sessions/${turn1.id}/publish`,
  );
  assert.equal(pubRes.status, 200);
  const published = (pubRes.body as { data: ProductOnboardingPublishResult }).data;
  assert.equal(published.productCard?.name, "新疆长绒棉 260g 重磅T恤 Pro");
  assert.equal(
    published.productCard?.materialsCraft,
    "100% 新疆长绒棉，活性固色工艺，双针加固领口",
  );
  assert.equal(published.productCard?.packageContents, PRODUCT_CARD_NO_EXTRA_ACCESSORIES_TEXT);
  assert.equal(published.productCard?.supplierImages.length, 2);
  assert.equal(published.productCard?.supplierImages[0].originalFilename, img2.filename);
});

test("validates .txt size/UTF-8/count, cumulative 6-image limit, unconfigured LLM, and missing-required publish", async () => {
  // 1. Unconfigured vision model returns 503 LLM_NOT_CONFIGURED
  const unconfigured = await createOnboardingTestContext(undefined);
  const noLlmRes = await unconfigured.app.request("POST", "/api/product-onboarding/sessions", {
    body: { message: "新建商品建档" },
  });
  assert.equal(noLlmRes.status, 503);
  assert.equal("error" in noLlmRes.body && noLlmRes.body.error.code, "LLM_NOT_CONFIGURED");

  // 2. Configured fake LLM for validation tests
  const { app } = await createOnboardingTestContext(async () => ({
    schemaVersion: PRODUCT_ONBOARDING_SCHEMA_VERSION,
    reply: "已记录部分信息，请一次性补充剩余必填项。",
    draftCard: {
      ...emptyProductCardFields(),
      name: "便携蓝牙音箱",
    },
    missingRequiredFields: [
      "sellingPoints",
      "specifications",
      "materialsCraft",
      "audienceScenarios",
      "packageContents",
    ],
  }));

  // Empty payload rejected
  const emptyRes = await app.request("POST", "/api/product-onboarding/sessions", {
    body: { message: "   ", txtFiles: [], supplierImages: [] },
  });
  assert.equal(emptyRes.status, 400);
  assert.equal(
    "error" in emptyRes.body && emptyRes.body.error.code,
    "PRODUCT_ONBOARDING_EMPTY_MESSAGE",
  );

  // Message > 10000 chars rejected
  const tooLongMsg = await app.request("POST", "/api/product-onboarding/sessions", {
    body: { message: "字".repeat(10_001) },
  });
  assert.equal(tooLongMsg.status, 400);
  assert.equal(
    "error" in tooLongMsg.body && tooLongMsg.body.error.code,
    "PRODUCT_ONBOARDING_MESSAGE_TOO_LONG",
  );

  // .txt > 200 KiB rejected
  const oversizedTxt = await app.request("POST", "/api/product-onboarding/sessions", {
    body: {
      txtFiles: [
        {
          filename: "huge.txt",
          bytesBase64: Buffer.alloc(200 * 1024 + 1, 0x61).toString("base64"),
        },
      ],
    },
  });
  assert.equal(oversizedTxt.status, 400);
  assert.equal(
    "error" in oversizedTxt.body && oversizedTxt.body.error.code,
    "PRODUCT_ONBOARDING_TXT_TOO_LARGE",
  );

  // Invalid UTF-8 byte sequence rejected
  const badUtf8 = await app.request("POST", "/api/product-onboarding/sessions", {
    body: {
      txtFiles: [
        {
          filename: "broken.txt",
          bytesBase64: Buffer.from([0xff, 0xfe, 0x80, 0x81]).toString("base64"),
        },
      ],
    },
  });
  assert.equal(badUtf8.status, 400);
  assert.equal(
    "error" in badUtf8.body && badUtf8.body.error.code,
    "PRODUCT_ONBOARDING_TXT_INVALID_UTF8",
  );

  // Disguised binary (NUL byte) and replacement char (\uFFFD) rejected
  const binaryTxt = await app.request("POST", "/api/product-onboarding/sessions", {
    body: {
      txtFiles: [
        {
          filename: "fake.txt",
          bytesBase64: Buffer.from("PNG\x00\x01binary", "latin1").toString("base64"),
        },
      ],
    },
  });
  assert.equal(binaryTxt.status, 400);
  assert.equal(
    "error" in binaryTxt.body && binaryTxt.body.error.code,
    "PRODUCT_ONBOARDING_TXT_INVALID_UTF8",
  );

  const replacementCharTxt = await app.request("POST", "/api/product-onboarding/sessions", {
    body: {
      txtFiles: [makeTxtBase64("replace.txt", "参数含非法替换符\uFFFD内容")],
    },
  });
  assert.equal(replacementCharTxt.status, 400);
  assert.equal(
    "error" in replacementCharTxt.body && replacementCharTxt.body.error.code,
    "PRODUCT_ONBOARDING_TXT_INVALID_UTF8",
  );

  // Non-.txt extension rejected
  const wrongExt = await app.request("POST", "/api/product-onboarding/sessions", {
    body: {
      txtFiles: [makeTxtBase64("spec.pdf", "plain text")],
    },
  });
  assert.equal(wrongExt.status, 400);
  assert.equal(
    "error" in wrongExt.body && wrongExt.body.error.code,
    "PRODUCT_ONBOARDING_INVALID_TXT_FILE",
  );

  // More than 3 .txt files rejected
  const fourTxt = await app.request("POST", "/api/product-onboarding/sessions", {
    body: {
      txtFiles: [
        makeTxtBase64("a.txt", "1"),
        makeTxtBase64("b.txt", "2"),
        makeTxtBase64("c.txt", "3"),
        makeTxtBase64("d.txt", "4"),
      ],
    },
  });
  assert.equal(fourTxt.status, 400);
  assert.equal(
    "error" in fourTxt.body && fourTxt.body.error.code,
    "PRODUCT_ONBOARDING_TOO_MANY_TXT_FILES",
  );

  // Cumulative supplier image limit > 6 across turns rejected
  const images = await Promise.all([1, 2, 3, 4, 5, 6, 7].map((seed) => makeTestImageBase64(seed + 30)));
  const createdRes = await app.request("POST", "/api/product-onboarding/sessions", {
    body: {
      message: "上传前 4 张供应商图",
      supplierImages: images.slice(0, 4),
    },
  });
  assert.equal(createdRes.status, 201);
  const session = (createdRes.body as { data: ProductOnboardingSession }).data;
  assert.equal(session.supplierImages.length, 4);

  // Adding 3 more distinct images (4 + 3 = 7 > 6) rejected
  const overImagesRes = await app.request(
    "POST",
    `/api/product-onboarding/sessions/${session.id}/messages`,
    {
      body: {
        message: "再加 3 张图",
        supplierImages: images.slice(4, 7),
      },
    },
  );
  assert.equal(overImagesRes.status, 400);
  assert.equal(
    "error" in overImagesRes.body && overImagesRes.body.error.code,
    "PRODUCT_ONBOARDING_TOO_MANY_IMAGES",
  );

  // Adding 2 new + 1 duplicate of existing image reaches exactly 6 and succeeds
  const exactSixRes = await app.request(
    "POST",
    `/api/product-onboarding/sessions/${session.id}/messages`,
    {
      body: {
        message: "再补 2 张新图与 1 张重复图",
        supplierImages: [images[0], images[4], images[5]],
      },
    },
  );
  assert.equal(exactSixRes.status, 200);
  assert.equal(
    (exactSixRes.body as { data: ProductOnboardingSession }).data.supplierImages.length,
    6,
  );

  // Publishing while required fields are missing returns 400 + missingFields list
  const publishIncomplete = await app.request(
    "POST",
    `/api/product-onboarding/sessions/${session.id}/publish`,
  );
  assert.equal(publishIncomplete.status, 400);
  assert.ok("error" in publishIncomplete.body);
  assert.equal(publishIncomplete.body.error.code, "PRODUCT_CARD_REQUIRED_FIELDS_MISSING");
  assert.deepEqual(publishIncomplete.body.error.missingFields, [
    "sellingPoints",
    "specifications",
    "materialsCraft",
    "audienceScenarios",
    "packageContents",
  ]);

  // Body limit routing covers onboarding write endpoints
  assert.equal(
    resolveRequestBodyLimit("POST", "/api/product-onboarding/sessions"),
    PRODUCT_CARD_WRITE_BODY_MAX_BYTES,
  );
  assert.equal(
    resolveRequestBodyLimit("POST", `/api/product-onboarding/sessions/${session.id}/messages`),
    PRODUCT_CARD_WRITE_BODY_MAX_BYTES,
  );
  assert.equal(
    resolveRequestBodyLimit("PATCH", `/api/product-onboarding/sessions/${session.id}/draft`),
    PRODUCT_CARD_WRITE_BODY_MAX_BYTES,
  );
});

test("product-onboarding normalized prompt, 039/040 seed sha256, and import-prompts idempotency", async () => {
  const sourcePath = "prompt/normalized/product-onboarding.md";
  const markdown = await readFile(sourcePath, "utf8");
  assert.equal(isNormalizedPromptMarkdown(markdown), true);

  const record = parseNormalizedPromptMarkdown(markdown, sourcePath);
  assert.equal(record.code, "product.onboarding");
  assert.equal(record.stage, "product_onboarding");
  assert.equal(record.kind, "planner");
  assert.equal(record.executionTarget, "llm");
  assert.deepEqual(resolvePromptTemplateUsedBy(record), ["首页·商品信息建档"]);
  const outputProps = record.outputSchema.properties as Record<string, any>;
  assert.equal(outputProps.schemaVersion?.const, PRODUCT_ONBOARDING_SCHEMA_VERSION);
  assert.equal(outputProps.draftCard?.required?.length, 9);
  assert.equal("category" in (outputProps.draftCard?.properties ?? {}), false);
  assert.equal("skuCode" in (outputProps.draftCard?.properties ?? {}), false);
  assert.equal(outputProps.missingRequiredFields?.items?.enum?.length, 6);
  assert.equal(outputProps.missingRequiredFields?.items?.enum?.includes("category"), false);
  assert.match(record.body, /6 项入库必填 \+ 3 项选填/);
  assert.doesNotMatch(record.body, /skuCode|category/);
  assert.match(record.body, /单品本体 ×1，无额外配件/);
  assert.match(record.body, /严禁编造/);
  assert.match(record.body, /按编号.*一次性合并追问全部剩余缺失必填项/);

  // 039 & 040 SQL migrations contain exact sha256 matching import-prompts calculation
  const migration039Sql = await readFile("db/migrations/039_product_onboarding_template.sql", "utf8");
  assert.match(migration039Sql, /'product_onboarding'/);
  assert.match(migration039Sql, /'product\.onboarding'/);
  assert.ok(
    migration039Sql.includes(`'${record.sourceSha256}'`),
    `039 migration source_sha256 must match ${record.sourceSha256}`,
  );
  const migration040Sql = await readFile("db/migrations/040_drop_product_card_category_and_sku.sql", "utf8");
  assert.ok(
    migration040Sql.includes(`'${record.sourceSha256}'`),
    `040 migration source_sha256 must match ${record.sourceSha256}`,
  );

  // Re-importing via importPromptRecordsWithPolicy after seeded v1 produces no v2 draft
  const prompts = new MemoryPromptRepository();
  const [seeded] = await prompts.importRecords([record]);
  await prompts.publishVersion(seeded.templateVersionId);

  const [reimported] = await importPromptRecordsWithPolicy(prompts, [record], { publish: false });
  assert.equal(reimported.templateVersionId, seeded.templateVersionId);
  assert.equal(reimported.versionNo, 1);
  assert.equal(reimported.status, "published");
  assert.equal((await prompts.listVersions(seeded.templateId)).length, 1);
});
