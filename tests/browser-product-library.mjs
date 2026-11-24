// Run with: npx tsx --test tests/browser-product-library.mjs (offline, no DB or external API calls).
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";
import { createSuiteStudioApp } from "../server/app.js";
import { MemoryLibraryRepository } from "../server/repositories/memory-library-repository.js";
import { MemoryProductCardRepository } from "../server/repositories/memory-product-card-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";
import { PRODUCT_CARD_NO_EXTRA_ACCESSORIES_TEXT } from "../shared/product-card.js";

async function startOfflineProductLibraryApp(t) {
  const repository = new MemorySuiteRepository();
  const libraryRepository = new MemoryLibraryRepository();
  const productCardRepository = new MemoryProductCardRepository();
  const storage = new MemoryStorage();

  const api = createSuiteStudioApp({
    repository,
    libraryRepository,
    productCardRepository,
    storage,
  });

  const vite = await createServer({
    cacheDir: "node_modules/.vite-browser-product-library",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "offline-product-library-api",
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            const reqPath = req.url ?? "/";
            if (!reqPath.startsWith("/api/")) return next();
            try {
              const chunks = [];
              for await (const chunk of req) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
              }
              const raw = Buffer.concat(chunks);
              let body;
              if (raw.length > 0) {
                try {
                  body = JSON.parse(raw.toString("utf8"));
                } catch {
                  body = undefined;
                }
              }
              const result = await api.request(req.method ?? "GET", reqPath, {
                headers: req.headers,
                body,
              });
              res.writeHead(
                result.status,
                result.raw
                  ? result.headers
                  : { "content-type": "application/json; charset=utf-8" },
              );
              res.end(result.raw ?? JSON.stringify(result.body));
            } catch (error) {
              res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
            }
          });
        },
      },
    ],
  });

  await vite.listen();
  const address = vite.httpServer?.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true });

  t.after(async () => {
    await browser.close();
    await vite.close();
  });

  return { baseUrl, browser, api, productCardRepository };
}

test("ProductLibraryPage full lifecycle: create, validate, quick-fill, upload supplier images, search, edit, ?selected, archive/restore/delete", async (t) => {
  const { baseUrl, browser, api } = await startOfflineProductLibraryApp(t);
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  // 1. Visit /products and verify navigation placement & initial empty state
  await page.goto(`${baseUrl}/products`, { waitUntil: "networkidle" });
  const navLabels = await page.locator(".pa-rail-item span").allInnerTexts();
  assert.deepEqual(navLabels, ["首页", "创建", "商品库", "图片库", "模板库", "配置"]);
  await page.locator('.pa-rail-item.is-active[href="/products"]').waitFor({ state: "visible" });
  assert.match(await page.locator(".pa-breadcrumbs").innerText(), /商品库/);
  assert.match(await page.locator(".style-filter-note").innerText(), /供应商参考图仅用于商品库认款展示与建档识别/);

  // 2. Open manual create modal and verify missing-field highlighting + disabled submit reason
  await page.locator(".product-library-header-actions button", { hasText: "手动新建商品卡" }).click();
  const createModal = page.locator(".product-create-modal");
  await createModal.waitFor({ state: "visible" });

  const createSubmitBtn = createModal.getByRole("button", { name: "保存到商品库" });
  assert.equal(await createSubmitBtn.isDisabled(), true, "Submit button should be disabled when required fields are empty");
  const initialReason = await createModal.locator('[data-testid="pc-disable-reason"]').innerText();
  assert.match(initialReason, /尚缺 7 项必填/);
  assert.equal(await createModal.locator(".pc-field.is-missing").count(), 7);

  // Fill 6 of the 7 required fields + SKU
  await createModal.locator("#create-product-card-name").fill("钛合金保温随行杯 480ml");
  await createModal.locator("#create-product-card-skuCode").fill("SKU-TI-480");
  await createModal.locator("#create-product-card-category").fill("户外水具");
  await createModal.getByLabel("核心卖点 1").fill("纯钛内胆不串味，泡咖啡茶饮更纯净");
  await createModal.getByRole("button", { name: "添加核心卖点" }).click();
  await createModal.getByLabel("核心卖点 2").fill("整杯净重 195g，超轻便携适合通勤露营");
  await createModal.locator("#create-product-card-specifications").fill("容量 480ml，高度 208mm，杯底直径 66mm，净重 195g");
  await createModal.locator("#create-product-card-materialsCraft").fill("TA1 纯钛内胆 + 304 不锈钢外壳，磨砂喷塑工艺");
  await createModal.locator("#create-product-card-audienceScenarios").fill("户外徒步、露营爱好者及日常办公通勤人群");

  // Still missing packageContents
  assert.equal(await createSubmitBtn.isDisabled(), true);
  assert.match(await createModal.locator('[data-testid="pc-disable-reason"]').innerText(), /尚缺 1 项必填：包装清单 \/ 配件说明/);

  // Use quick-fill button for packageContents
  await createModal.getByRole("button", { name: "无额外配件快捷填入" }).click();
  assert.equal(
    await createModal.locator("#create-product-card-packageContents").inputValue(),
    PRODUCT_CARD_NO_EXTRA_ACCESSORIES_TEXT,
  );
  assert.equal(await createSubmitBtn.isDisabled(), false, "Submit button should be enabled once all 7 required fields are filled");

  // Expand extended optional section and fill certifications
  await createModal.locator(".pc-collapse-toggle").click();
  await createModal
    .locator("#create-product-card-certificationsProhibitions")
    .fill("通过 LFGB 食品接触检测；禁用医疗保健功效宣传");

  // Verify supplier image notice and upload 2 supplier images
  assert.match(
    await createModal.locator(".pc-supplier-notice").innerText(),
    /仅用于商品库认款展示与建档识别，生图实拍原图请在创作页上传/,
  );
  const imgA = path.resolve("public/assets/gan65-product.jpg");
  const imgB = path.resolve("public/assets/tokyo-desk-v3.jpg");
  await createModal.locator('input[type="file"]').setInputFiles([imgA, imgB]);
  await createModal.locator(".pc-supplier-card").nth(1).waitFor({ state: "visible" });
  assert.equal(await createModal.locator(".pc-supplier-card").count(), 2);
  assert.equal(await createModal.locator(".pc-supplier-card").first().locator(".pc-cover-badge").innerText(), "封面");
  assert.equal(await createModal.locator(".pc-supplier-card").first().locator(".pc-supplier-name").innerText(), "gan65-product.jpg");

  // Reorder: move second image left to become cover
  await createModal.getByRole("button", { name: "左移 tokyo-desk-v3.jpg" }).click();
  assert.equal(await createModal.locator(".pc-supplier-card").first().locator(".pc-supplier-name").innerText(), "tokyo-desk-v3.jpg");

  // Submit create
  await createSubmitBtn.click();
  await createModal.waitFor({ state: "hidden" });

  // Verify card rendered in list with cover image, SKU badge, selling points, quick actions
  const createdCard = page.locator(".product-card-item").first();
  await createdCard.waitFor({ state: "visible" });
  const createdCardId = await createdCard.getAttribute("data-product-card-id");
  assert.ok(createdCardId, "Created card should have data-product-card-id");
  const cardText = await createdCard.innerText();
  assert.match(cardText, /钛合金保温随行杯 480ml/);
  assert.match(cardText, /SKU-TI-480/);
  assert.match(cardText, /户外水具/);
  assert.match(cardText, /纯钛内胆不串味/);
  assert.match(cardText, /整杯净重 195g/);
  assert.match(cardText, /去生成套图/);
  assert.match(cardText, /去爆品图复刻/);

  // Verify cover thumbnail actually loads from /api/product-cards/:id/images/:imageId/preview/thumbnail
  const thumbLoaded = await createdCard.locator(".product-card-thumb img").evaluate(async (img) => {
    if (!img.complete) {
      await new Promise((resolve) => {
        img.onload = resolve;
        img.onerror = resolve;
      });
    }
    return img.naturalWidth > 0;
  });
  assert.equal(thumbLoaded, true, "Cover thumbnail image should load successfully");

  // Verify supplier images never leak into /api/library/resources
  const libRes = await api.request("GET", "/api/library/resources?scope=image");
  assert.equal(libRes.status, 200);
  assert.equal(libRes.body.data.items.length, 0, "Supplier images must not appear in image library");

  // 3. Seed a second card via API to test search & ?selected=<id>
  const secondRes = await api.request("POST", "/api/product-cards", {
    body: {
      name: "氮化镓 65W 折叠快充头",
      skuCode: "SKU-GAN-65",
      category: "3C 数码配件",
      sellingPoints: ["三口同时快充，支持 PD3.0/PPS"],
      specifications: "总功率 65W，尺寸 52x38x32mm，重量 112g",
      materialsCraft: "阻燃 PC 外壳，折叠国标插脚",
      audienceScenarios: "差旅办公、手机笔记本多设备用户",
      packageContents: "65W 充电器 ×1、说明书 ×1",
    },
  });
  assert.equal(secondRes.status, 201);
  const secondCardId = secondRes.body.data.id;

  // Test ?selected=<createdCardId> auto-selection
  await page.goto(`${baseUrl}/products?selected=${encodeURIComponent(createdCardId)}`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelectorAll(".product-card-item").length === 2);
  assert.equal(
    await page.locator(".product-library-inspector .pc-input").first().inputValue(),
    "钛合金保温随行杯 480ml",
  );

  // 4. Search by SKU and by name
  const searchInput = page.getByLabel("搜索商品信息卡");
  await searchInput.fill("SKU-TI-480");
  await page.getByRole("button", { name: "搜索" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".product-card-item").length === 1);
  assert.match(await page.locator(".product-card-item").first().innerText(), /钛合金保温随行杯 480ml/);

  await page.getByRole("button", { name: "清除搜索" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".product-card-item").length === 2);

  await searchInput.fill("氮化镓");
  await searchInput.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll(".product-card-item").length === 1);
  assert.match(await page.locator(".product-card-item").first().innerText(), /氮化镓 65W 折叠快充头/);

  await page.getByRole("button", { name: "清除搜索" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".product-card-item").length === 2);

  // 5. Right inspector edit & save -> verify revision bumps to v2
  await page.locator(`.product-card-item[data-product-card-id="${createdCardId}"]`).click();
  const inspector = page.locator(".product-library-inspector");
  await inspector.locator('[data-testid="product-revision-badge"]').waitFor({ state: "visible" });
  assert.equal(await inspector.locator('[data-testid="product-revision-badge"]').innerText(), "v1");

  const nameInput = inspector.locator(`#edit-${createdCardId}-name`);
  await nameInput.fill("钛合金保温随行杯 480ml 升级款");
  // Remove one supplier image in right inspector
  await inspector.getByRole("button", { name: "移除 gan65-product.jpg" }).click();
  assert.equal(await inspector.locator(".pc-supplier-card").count(), 1);

  await inspector.getByRole("button", { name: "保存修改" }).click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="product-revision-badge"]')?.textContent?.trim() === "v2",
  );
  assert.match(
    await page.locator(`.product-card-item[data-product-card-id="${createdCardId}"]`).innerText(),
    /钛合金保温随行杯 480ml 升级款/,
  );

  // Verify quick jump buttons navigate with ?productCardId=<id>
  await page
    .locator(`.product-card-item[data-product-card-id="${createdCardId}"]`)
    .getByRole("button", { name: "去生成套图" })
    .click();
  await page.waitForFunction(
    (id) => window.location.pathname === "/create/suite" && new URLSearchParams(window.location.search).get("productCardId") === id,
    createdCardId,
  );

  await page.goto(`${baseUrl}/products?selected=${encodeURIComponent(createdCardId)}`, { waitUntil: "networkidle" });
  await page
    .locator(`.product-card-item[data-product-card-id="${createdCardId}"]`)
    .getByRole("button", { name: "去爆品图复刻" })
    .click();
  await page.waitForFunction(
    (id) => window.location.pathname === "/create/replica" && new URLSearchParams(window.location.search).get("productCardId") === id,
    createdCardId,
  );

  // 6. Archive -> hidden in "在用", visible in "已归档" (no quick jump buttons) -> Restore -> Delete
  await page.goto(`${baseUrl}/products?selected=${encodeURIComponent(createdCardId)}`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelectorAll(".product-card-item").length === 2);

  await inspector.getByRole("button", { name: "归档" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".product-card-item").length === 1);
  assert.equal(
    await page.locator(`.product-card-item[data-product-card-id="${createdCardId}"]`).count(),
    0,
    "Archived card must be hidden in default published filter",
  );

  // Switch to archived filter
  await page.locator(".style-filter-panel label", { hasText: "已归档" }).click();
  await page.waitForFunction(
    (id) => Boolean(document.querySelector(`.product-card-item[data-product-card-id="${id}"]`)),
    createdCardId,
  );
  const archivedCardEl = page.locator(`.product-card-item[data-product-card-id="${createdCardId}"]`);
  assert.equal(await archivedCardEl.getByRole("button", { name: "去生成套图" }).count(), 0);
  assert.equal(await archivedCardEl.getByRole("button", { name: "去爆品图复刻" }).count(), 0);

  // Restore to published
  await inspector.getByRole("button", { name: "恢复在用" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".product-card-item").length === 0);

  // Switch back to published -> both cards back
  await page.locator(".style-filter-panel label", { hasText: "在用" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".product-card-item").length === 2);

  // Delete card with secondary confirmation dialog
  await page.locator(`.product-card-item[data-product-card-id="${secondCardId}"]`).click();
  await inspector.locator(`#edit-${secondCardId}-name`).waitFor({ state: "visible" });
  await inspector.getByRole("button", { name: "删除", exact: true }).click();
  const deleteDialog = page.locator(".style-delete-confirm-modal");
  await deleteDialog.waitFor({ state: "visible" });
  assert.match(await deleteDialog.innerText(), /确认删除「氮化镓 65W 折叠快充头」/);
  await deleteDialog.getByRole("button", { name: "确认删除" }).click();
  await deleteDialog.waitFor({ state: "hidden" });

  // Switch to "全部" filter and verify only 1 card remains
  await page.locator(".style-filter-panel label", { hasText: "全部" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".product-card-item").length === 1);
  assert.equal(
    await page.locator(`.product-card-item[data-product-card-id="${secondCardId}"]`).count(),
    0,
  );

  // 7. Verify "AI 对话建档" button navigates cleanly to "/" HomePage
  await page.locator(".product-library-header-actions button", { hasText: "AI 对话建档" }).click();
  await page.waitForFunction(() => window.location.pathname === "/");
  await page.getByRole("heading", { name: "新品商品信息建档" }).waitFor({ state: "visible" });
  await page.locator('.pa-rail-item.is-active[href="/"]').waitFor({ state: "visible" });

  assert.deepEqual(pageErrors, [], `Expected no uncaught page errors, got: ${pageErrors.join("; ")}`);
});
