import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import { createSuiteStudioApp } from "../server/app.js";
import {
  DEFAULT_REQUEST_BODY_MAX_BYTES,
  PRODUCT_CARD_WRITE_BODY_MAX_BYTES,
  resolveRequestBodyLimit,
} from "../server/request-body-limit.js";
import { MemoryLibraryRepository } from "../server/repositories/memory-library-repository.js";
import { MemoryProductCardRepository } from "../server/repositories/memory-product-card-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";
import {
  createProductCardSnapshot,
  formatProductCardFacts,
  PRODUCT_CARD_NO_EXTRA_ACCESSORIES_TEXT,
  type ProductCard,
  type ProductCardSummary,
} from "../shared/product-card.js";

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

function validCardPayload(overrides: Record<string, unknown> = {}) {
  return {
    name: "双层真空不锈钢保温杯 500ml",
    category: "水杯水具",
    sellingPoints: [
      "316L 医用级不锈钢内胆，耐酸碱更安心",
      "12 小时保温保冷，通勤户外皆适用",
    ],
    specifications: "容量 500ml，高度 215mm，杯底直径 68mm，空杯净重 265g",
    materialsCraft: "316L 不锈钢内胆 + 304 不锈钢外壳，哑光静电喷塑工艺",
    audienceScenarios: "通勤上班族、学生、自驾及露营日常饮水",
    packageContents: "保温杯本体 ×1、食品级硅胶杯垫 ×1、说明书 ×1",
    ...overrides,
  };
}

function createTestContext() {
  const storage = new MemoryStorage();
  const repository = new MemorySuiteRepository();
  const libraryRepository = new MemoryLibraryRepository();
  const productCardRepository = new MemoryProductCardRepository();
  const app = createSuiteStudioApp({
    repository,
    storage,
    libraryRepository,
    productCardRepository,
  });
  return { app, storage, libraryRepository, productCardRepository };
}

test("validates 7 required fields, lengths, explicit no-accessories text, and 4 optional fields", async () => {
  const { app } = createTestContext();

  // Missing required fields
  const emptyRes = await app.request("POST", "/api/product-cards", { body: {} });
  assert.equal(emptyRes.status, 400);
  assert.equal("error" in emptyRes.body && emptyRes.body.error.code, "PRODUCT_CARD_REQUIRED_FIELDS_MISSING");

  // Whitespace-only packageContents rejected
  const blankPkg = await app.request("POST", "/api/product-cards", {
    body: validCardPayload({ packageContents: "   " }),
  });
  assert.equal(blankPkg.status, 400);
  assert.equal("error" in blankPkg.body && blankPkg.body.error.code, "PRODUCT_CARD_REQUIRED_FIELDS_MISSING");

  // Blank sellingPoints items rejected
  const blankPoints = await app.request("POST", "/api/product-cards", {
    body: validCardPayload({ sellingPoints: ["", "   "] }),
  });
  assert.equal(blankPoints.status, 400);
  assert.equal("error" in blankPoints.body && blankPoints.body.error.code, "PRODUCT_CARD_REQUIRED_FIELDS_MISSING");

  // Over-length required fields rejected
  const tooLongCases = [
    validCardPayload({ name: "a".repeat(121) }),
    validCardPayload({ category: "a".repeat(61) }),
    validCardPayload({ sellingPoints: Array.from({ length: 11 }, (_, i) => `卖点 ${i + 1}`) }),
    validCardPayload({ sellingPoints: ["a".repeat(201)] }),
    validCardPayload({ specifications: "a".repeat(1001) }),
    validCardPayload({ materialsCraft: "a".repeat(801) }),
    validCardPayload({ audienceScenarios: "a".repeat(801) }),
    validCardPayload({ packageContents: "a".repeat(601) }),
    // Over-length optional fields rejected
    validCardPayload({ skuCode: "S".repeat(81) }),
    validCardPayload({ painPointsComparison: "p".repeat(1001) }),
    validCardPayload({ usageDemoHighlights: "u".repeat(1001) }),
    validCardPayload({ certificationsProhibitions: "c".repeat(801) }),
  ];

  for (const payload of tooLongCases) {
    const res = await app.request("POST", "/api/product-cards", { body: payload });
    assert.equal(res.status, 400);
    assert.equal("error" in res.body && res.body.error.code, "PRODUCT_CARD_VALIDATION_FAILED");
  }

  // Explicit no-extra-accessories confirmation passes with empty optional fields
  const minimalRes = await app.request("POST", "/api/product-cards", {
    body: validCardPayload({ packageContents: PRODUCT_CARD_NO_EXTRA_ACCESSORIES_TEXT }),
  });
  assert.equal(minimalRes.status, 201);
  assert.ok("data" in minimalRes.body);
  const minimalCard = minimalRes.body.data as ProductCard;
  assert.equal(minimalCard.status, "published");
  assert.equal(minimalCard.revision, 1);
  assert.equal(minimalCard.packageContents, PRODUCT_CARD_NO_EXTRA_ACCESSORIES_TEXT);
  assert.equal(minimalCard.skuCode, "");
  assert.equal(minimalCard.painPointsComparison, "");
  assert.equal(minimalCard.usageDemoHighlights, "");
  assert.equal(minimalCard.certificationsProhibitions, "");
  assert.deepEqual(minimalCard.supplierImages, []);
  assert.equal(minimalCard.coverThumbnailUrl, null);

  // All 4 optional fields filled passes
  const fullRes = await app.request("POST", "/api/product-cards", {
    body: validCardPayload({
      skuCode: "CUP-316-500-BLK",
      painPointsComparison: "相比旧款单层不锈钢，保温时长提升 6 小时，杯身减重 15%",
      usageDemoHighlights: "单手按压弹盖开合演示，倒置晃动无漏水",
      certificationsProhibitions: "通过 FDA 食品接触检测；禁用“永不生锈”“医疗保健”等表述",
    }),
  });
  assert.equal(fullRes.status, 201);
  assert.ok("data" in fullRes.body);
  const fullCard = fullRes.body.data as ProductCard;
  assert.equal(fullCard.skuCode, "CUP-316-500-BLK");
  assert.match(fullCard.certificationsProhibitions, /FDA/);

  // formatProductCardFacts omits empty optional fields and includes populated ones
  const minimalFacts = formatProductCardFacts(createProductCardSnapshot(minimalCard));
  assert.match(minimalFacts, /商品名称：双层真空不锈钢保温杯 500ml/);
  assert.match(minimalFacts, /单品本体 ×1，无额外配件/);
  assert.doesNotMatch(minimalFacts, /内部 SKU/);
  assert.doesNotMatch(minimalFacts, /认证资质/);

  const fullFacts = formatProductCardFacts(createProductCardSnapshot(fullCard));
  assert.match(fullFacts, /内部 SKU \/ 款号：CUP-316-500-BLK/);
  assert.match(fullFacts, /用户痛点与自身对比数据：/);
  assert.match(fullFacts, /使用方法 \/ 动态演示亮点：/);
  assert.match(fullFacts, /认证资质与宣传禁忌：/);
});

test("supports 0 and 1-6 supplier images, dedup, reorder, replacement, >6 rejection, preview, and library isolation", async () => {
  const { app, storage } = createTestContext();

  const img1 = await makeTestImageBase64(1, "png");
  const img2 = await makeTestImageBase64(2, "jpeg");
  const img3 = await makeTestImageBase64(3, "webp");
  const img4 = await makeTestImageBase64(4, "png");
  const img5 = await makeTestImageBase64(5, "jpeg");
  const img6 = await makeTestImageBase64(6, "webp");
  const img7 = await makeTestImageBase64(7, "png");

  // >6 images rejected on POST
  const tooManyRes = await app.request("POST", "/api/product-cards", {
    body: validCardPayload({ supplierImages: [img1, img2, img3, img4, img5, img6, img7] }),
  });
  assert.equal(tooManyRes.status, 400);
  assert.equal("error" in tooManyRes.body && tooManyRes.body.error.code, "PRODUCT_CARD_TOO_MANY_IMAGES");

  // Invalid MIME rejected
  const badMimeRes = await app.request("POST", "/api/product-cards", {
    body: validCardPayload({
      supplierImages: [{ filename: "bad.gif", mimeType: "image/gif", bytesBase64: img1.bytesBase64 }],
    }),
  });
  assert.equal(badMimeRes.status, 400);
  assert.equal("error" in badMimeRes.body && badMimeRes.body.error.code, "UNSUPPORTED_IMAGE_MIME");

  // Create with 3 images including 1 duplicate (deduped to 2 unique images)
  const createRes = await app.request("POST", "/api/product-cards", {
    body: validCardPayload({ supplierImages: [img1, img2, img1] }),
  });
  assert.equal(createRes.status, 201);
  assert.ok("data" in createRes.body);
  const created = createRes.body.data as ProductCard;
  assert.equal(created.supplierImages.length, 2);
  assert.equal(created.supplierImages[0].ordinal, 1);
  assert.equal(created.supplierImages[1].ordinal, 2);
  assert.equal(created.supplierImages[0].mimeType, "image/png");
  assert.equal(created.supplierImages[1].mimeType, "image/jpeg");
  assert.equal(created.coverThumbnailUrl, created.supplierImages[0].thumbnailPreviewUrl);
  for (const image of created.supplierImages) {
    assert.ok(image.originalObjectKey.startsWith(`product-cards/${created.id}/images/${image.id}/`));
    assert.ok(image.thumbnailObjectKey.startsWith(`product-cards/${created.id}/images/${image.id}/`));
  }

  // Preview endpoints return valid original & thumbnail bytes
  const origPreview = await app.request("GET", created.supplierImages[0].originalPreviewUrl);
  assert.equal(origPreview.status, 200);
  assert.ok(origPreview.raw && origPreview.raw.length > 0);
  assert.equal(origPreview.headers?.["content-type"], "image/png");

  const thumbPreview = await app.request("GET", created.supplierImages[1].thumbnailPreviewUrl);
  assert.equal(thumbPreview.status, 200);
  assert.ok(thumbPreview.raw && thumbPreview.raw.length > 0);
  assert.equal(thumbPreview.headers?.["content-type"], "image/jpeg");

  // Supplier images NEVER appear in /api/library/resources
  const libImageRes = await app.request("GET", "/api/library/resources?scope=image");
  assert.equal(libImageRes.status, 200);
  assert.ok("data" in libImageRes.body);
  const libImageData = libImageRes.body.data as { items: unknown[]; total: number };
  assert.equal(libImageData.total, 0);
  assert.deepEqual(libImageData.items, []);

  const libAllRes = await app.request("GET", "/api/library/resources");
  assert.equal(libAllRes.status, 200);
  assert.ok("data" in libAllRes.body);
  assert.equal((libAllRes.body.data as { total: number }).total, 0);

  // PATCH: reorder (move img2 first), replace img1 with img3, and append up to 6 total
  const [firstImg, secondImg] = created.supplierImages;
  const patchRes = await app.request("PATCH", `/api/product-cards/${created.id}`, {
    body: {
      supplierImages: [
        { imageId: secondImg.id },
        img3,
        img4,
        img5,
        img6,
        img7,
      ],
    },
  });
  assert.equal(patchRes.status, 200);
  assert.ok("data" in patchRes.body);
  const updated = patchRes.body.data as ProductCard;
  assert.equal(updated.revision, 2);
  assert.equal(updated.supplierImages.length, 6);
  assert.equal(updated.supplierImages[0].id, secondImg.id);
  assert.equal(updated.supplierImages[0].ordinal, 1);
  assert.equal(updated.supplierImages[1].mimeType, "image/webp");
  assert.equal(updated.supplierImages[1].ordinal, 2);
  assert.equal(updated.supplierImages[5].ordinal, 6);
  assert.equal(updated.coverThumbnailUrl, secondImg.thumbnailPreviewUrl);

  // Removed image (firstImg) objects cleaned up from storage and preview returns 404
  assert.equal(await storage.get(firstImg.originalObjectKey), null);
  assert.equal(await storage.get(firstImg.thumbnailObjectKey), null);
  const removedPreview = await app.request("GET", firstImg.originalPreviewUrl);
  assert.equal(removedPreview.status, 404);

  // PATCH with >6 images rejected
  const patchTooMany = await app.request("PATCH", `/api/product-cards/${created.id}`, {
    body: {
      supplierImages: [
        { imageId: secondImg.id },
        img1,
        img3,
        img4,
        img5,
        img6,
        img7,
      ],
    },
  });
  assert.equal(patchTooMany.status, 400);
  assert.equal("error" in patchTooMany.body && patchTooMany.body.error.code, "PRODUCT_CARD_TOO_MANY_IMAGES");

  // PATCH with non-existent imageId rejected
  const patchUnknownImage = await app.request("PATCH", `/api/product-cards/${created.id}`, {
    body: {
      supplierImages: [{ imageId: randomUUID() }],
    },
  });
  assert.equal(patchUnknownImage.status, 400);
  assert.equal("error" in patchUnknownImage.body && patchUnknownImage.body.error.code, "PRODUCT_CARD_IMAGE_NOT_FOUND");
});

test("supports keyword search (name/SKU/category), status filter, revision increment, archive/restore, and delete cleanup", async () => {
  const { app, storage } = createTestContext();
  const img = await makeTestImageBase64(11, "png");

  const c1Res = await app.request("POST", "/api/product-cards", {
    body: validCardPayload({
      name: "极简陶瓷手冲咖啡壶",
      category: "咖啡器具",
      skuCode: "CF-POUR-800",
      supplierImages: [img],
    }),
  });
  assert.equal(c1Res.status, 201);
  const card1 = ("data" in c1Res.body ? c1Res.body.data : null) as ProductCard;

  const c2Res = await app.request("POST", "/api/product-cards", {
    body: validCardPayload({
      name: "轻量折叠碳纤维登山杖",
      category: "户外装备",
      skuCode: "OUT-POLE-120",
    }),
  });
  assert.equal(c2Res.status, 201);
  const card2 = ("data" in c2Res.body ? c2Res.body.data : null) as ProductCard;

  // Keyword matches name, SKU (case-insensitive), and category
  const byName = await app.request("GET", `/api/product-cards?keyword=${encodeURIComponent("咖啡壶")}`);
  assert.equal(byName.status, 200);
  const byNameData = ("data" in byName.body ? byName.body.data : null) as { items: ProductCardSummary[]; total: number };
  assert.equal(byNameData.total, 1);
  assert.equal(byNameData.items[0].id, card1.id);
  assert.equal(byNameData.items[0].supplierImageCount, 1);
  assert.equal(byNameData.items[0].coverThumbnailUrl, card1.coverThumbnailUrl);

  const bySku = await app.request("GET", "/api/product-cards?keyword=out-pole");
  assert.equal(bySku.status, 200);
  const bySkuData = ("data" in bySku.body ? bySku.body.data : null) as { items: ProductCardSummary[]; total: number };
  assert.equal(bySkuData.total, 1);
  assert.equal(bySkuData.items[0].id, card2.id);

  const byCategory = await app.request("GET", `/api/product-cards?keyword=${encodeURIComponent("户外")}`);
  assert.equal(byCategory.status, 200);
  assert.equal((("data" in byCategory.body ? byCategory.body.data : null) as { total: number }).total, 1);

  // PATCH increments revision and updates fields
  const patchRes = await app.request("PATCH", `/api/product-cards/${card1.id}`, {
    body: {
      name: "极简陶瓷手冲咖啡壶 Pro",
      skuCode: "CF-POUR-800-PRO",
    },
  });
  assert.equal(patchRes.status, 200);
  const patched = ("data" in patchRes.body ? patchRes.body.data : null) as ProductCard;
  assert.equal(patched.revision, 2);
  assert.equal(patched.name, "极简陶瓷手冲咖啡壶 Pro");
  assert.equal(patched.skuCode, "CF-POUR-800-PRO");
  assert.equal(patched.supplierImages.length, 1);

  // Archive card1
  const archiveRes = await app.request("POST", `/api/product-cards/${card1.id}/archive`);
  assert.equal(archiveRes.status, 200);
  assert.equal((("data" in archiveRes.body ? archiveRes.body.data : null) as ProductCard).status, "archived");

  // Default status=published excludes archived card1
  const pubList = await app.request("GET", "/api/product-cards");
  assert.equal(pubList.status, 200);
  const pubData = ("data" in pubList.body ? pubList.body.data : null) as { items: ProductCardSummary[]; total: number };
  assert.equal(pubData.total, 1);
  assert.equal(pubData.items[0].id, card2.id);

  // status=archived shows card1
  const archList = await app.request("GET", "/api/product-cards?status=archived");
  assert.equal(archList.status, 200);
  const archData = ("data" in archList.body ? archList.body.data : null) as { items: ProductCardSummary[]; total: number };
  assert.equal(archData.total, 1);
  assert.equal(archData.items[0].id, card1.id);

  // status=all shows both
  const allList = await app.request("GET", "/api/product-cards?status=all&limit=1&offset=0");
  assert.equal(allList.status, 200);
  const allData = ("data" in allList.body ? allList.body.data : null) as { items: ProductCardSummary[]; total: number; limit: number; offset: number };
  assert.equal(allData.total, 2);
  assert.equal(allData.items.length, 1);
  assert.equal(allData.limit, 1);
  assert.equal(allData.offset, 0);

  // Restore card1
  const restoreRes = await app.request("POST", `/api/product-cards/${card1.id}/restore`);
  assert.equal(restoreRes.status, 200);
  assert.equal((("data" in restoreRes.body ? restoreRes.body.data : null) as ProductCard).status, "published");

  const pubAfterRestore = await app.request("GET", "/api/product-cards");
  assert.equal((("data" in pubAfterRestore.body ? pubAfterRestore.body.data : null) as { total: number }).total, 2);

  // Delete card1 removes DB record and cleans up storage objects
  const storedKeyCountBefore = storage.keys().filter((k) => k.startsWith(`product-cards/${card1.id}/images/`)).length;
  assert.equal(storedKeyCountBefore, 2);

  const delRes = await app.request("DELETE", `/api/product-cards/${card1.id}`);
  assert.equal(delRes.status, 200);
  assert.deepEqual("data" in delRes.body ? delRes.body.data : null, { id: card1.id });
  assert.equal(storage.keys().filter((k) => k.startsWith(`product-cards/${card1.id}/images/`)).length, 0);

  const getDeleted = await app.request("GET", `/api/product-cards/${card1.id}`);
  assert.equal(getDeleted.status, 404);
  assert.equal("error" in getDeleted.body && getDeleted.body.error.code, "PRODUCT_CARD_NOT_FOUND");
});

test("configures request body limits for product card write endpoints", () => {
  assert.equal(resolveRequestBodyLimit("POST", "/api/product-cards"), PRODUCT_CARD_WRITE_BODY_MAX_BYTES);
  assert.equal(
    resolveRequestBodyLimit("PATCH", `/api/product-cards/${randomUUID()}`),
    PRODUCT_CARD_WRITE_BODY_MAX_BYTES,
  );
  assert.equal(
    resolveRequestBodyLimit("POST", `/api/product-cards/${randomUUID()}/archive`),
    DEFAULT_REQUEST_BODY_MAX_BYTES,
  );
  assert.equal(
    resolveRequestBodyLimit("POST", `/api/product-cards/${randomUUID()}/restore`),
    DEFAULT_REQUEST_BODY_MAX_BYTES,
  );
  assert.equal(resolveRequestBodyLimit("GET", "/api/product-cards"), DEFAULT_REQUEST_BODY_MAX_BYTES);
});
