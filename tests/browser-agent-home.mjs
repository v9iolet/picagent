// Run with: npx tsx --test tests/browser-agent-home.mjs (offline, no DB or external API calls).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";
import { createSuiteStudioApp } from "../server/app.js";
import {
  MemoryProductOnboardingRepository,
  PRODUCT_ONBOARDING_SCHEMA_VERSION,
} from "../server/product-onboarding/index.js";
import { parseNormalizedPromptMarkdown } from "../server/prompt-library.js";
import { MemoryLibraryRepository } from "../server/repositories/memory-library-repository.js";
import { MemoryProductCardRepository } from "../server/repositories/memory-product-card-repository.js";
import { MemoryPromptRepository } from "../server/repositories/memory-prompt-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";

async function seedOnboardingPromptRepository() {
  const prompts = new MemoryPromptRepository();
  const sourcePath = "prompt/normalized/product-onboarding.md";
  const markdown = await readFile(sourcePath, "utf8");
  const record = parseNormalizedPromptMarkdown(markdown, sourcePath);
  const [imported] = await prompts.importRecords([record]);
  await prompts.publishVersion(imported.templateVersionId);
  return prompts;
}

async function startOfflineHomeApp(t, llmHandler) {
  const repository = new MemorySuiteRepository();
  const libraryRepository = new MemoryLibraryRepository();
  const productCardRepository = new MemoryProductCardRepository();
  const productOnboardingRepository = new MemoryProductOnboardingRepository();
  const promptRepository = await seedOnboardingPromptRepository();
  const storage = new MemoryStorage();

  const llmCalls = [];
  const llmClient = {
    provider: "fake-vision",
    model: "fake-vision-v1",
    isFake: true,
    async generatePlan() {
      throw new Error("not used in home test");
    },
    async generateProductOnboarding(input) {
      llmCalls.push(input);
      return llmHandler(input, llmCalls.length);
    },
  };

  const api = createSuiteStudioApp({
    repository,
    libraryRepository,
    productCardRepository,
    productOnboardingRepository,
    promptRepository,
    storage,
    llmClient,
  });

  const apiCalls = [];
  const vite = await createServer({
    cacheDir: "node_modules/.vite-browser-agent-home",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "offline-agent-home-api",
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
              apiCalls.push({ method: req.method ?? "GET", path: reqPath });
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
              res.end(
                JSON.stringify({
                  error: { message: error instanceof Error ? error.message : String(error) },
                }),
              );
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

  return { baseUrl, browser, api, llmCalls, apiCalls, productCardRepository };
}

test("HomePage Agent onboarding: default / landing, upload supplier image + .txt, merged follow-up, manual draft edit, draft resume/delete, publish read-only & quick jumps", async (t) => {
  let shouldFailNextReply = false;

  const { baseUrl, browser, api, llmCalls, apiCalls } = await startOfflineHomeApp(
    t,
    async (input, callIndex) => {
      if (shouldFailNextReply) {
        shouldFailNextReply = false;
        throw new Error("LLM_TIMEOUT");
      }

      if (callIndex === 1) {
        assert.equal(input.supplierImages.length, 1, "First turn should pass uploaded supplier image");
        assert.equal(input.txtAttachments.length, 1, "First turn should pass uploaded .txt attachment");
        assert.match(input.txtAttachments[0].content, /500ml/);
        return {
          schemaVersion: PRODUCT_ONBOARDING_SCHEMA_VERSION,
          reply:
            "已根据文字、附件与供应商图提取基础信息，请一次性补充以下 3 项剩余必填项：\n1. 材质与工艺细节\n2. 适用人群与使用场景\n3. 包装清单 / 配件说明",
          draftCard: {
            name: "真空保温随行杯 500ml",
            category: "水杯水具",
            sellingPoints: [
              "12 小时真空保温保冷",
              "一键弹盖防漏锁扣设计",
            ],
            specifications: "容量 500ml，高度 215mm，杯底直径 68mm，净重 265g",
            materialsCraft: "",
            audienceScenarios: "",
            packageContents: "",
            skuCode: "CUP-500-PRO",
            painPointsComparison: "",
            usageDemoHighlights: "",
            certificationsProhibitions: "",
          },
          missingRequiredFields: ["materialsCraft", "audienceScenarios", "packageContents"],
        };
      }

      if (input.latestUserMessage.includes("临时测试草稿")) {
        return {
          schemaVersion: PRODUCT_ONBOARDING_SCHEMA_VERSION,
          reply: "请补充该新品的基础信息与规格参数。",
          draftCard: {
            name: "临时测试草稿商品",
            category: "",
            sellingPoints: [],
            specifications: "",
            materialsCraft: "",
            audienceScenarios: "",
            packageContents: "",
            skuCode: "",
            painPointsComparison: "",
            usageDemoHighlights: "",
            certificationsProhibitions: "",
          },
          missingRequiredFields: [
            "category",
            "sellingPoints",
            "specifications",
            "materialsCraft",
            "audienceScenarios",
            "packageContents",
          ],
        };
      }

      // Second successful turn (after manual edit & follow-up message)
      assert.equal(
        input.currentDraftCard.name,
        "星河真空保温随行杯 500ml（旗舰版）",
        "Follow-up LLM turn must receive manually edited draft card name",
      );
      return {
        schemaVersion: PRODUCT_ONBOARDING_SCHEMA_VERSION,
        reply:
          "核心 7 项必填商品信息已全部齐备，请核对右侧商品信息卡后点击「保存到商品库」。",
        draftCard: {
          ...input.currentDraftCard,
          materialsCraft: "316L 医用级不锈钢内胆 + 304 外壳，哑光静电喷塑",
          audienceScenarios: "上班通勤、自驾出行、健身与户外露营",
          packageContents: "保温杯本体 ×1、防滑硅胶杯垫 ×1、说明书 ×1",
        },
        missingRequiredFields: [],
      };
    },
  );

  const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  // 1. Open "/" -> defaults to HomePage (not redirected to /create/suite)
  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
  assert.equal(new URL(page.url()).pathname, "/", "Root / must stay on HomePage");

  // Verify fixed left navigation order & active Home item & brand link href="/"
  const navLabels = await page.locator(".pa-rail-item span").allInnerTexts();
  assert.deepEqual(navLabels, ["首页", "创建", "商品库", "图片库", "模板库", "配置"]);
  await page.locator('.pa-rail-item.is-active[href="/"]').waitFor({ state: "visible" });
  assert.equal(await page.locator(".pa-brand").getAttribute("href"), "/");

  // Verify hero heading and 4 quick entry cards
  await page.getByRole("heading", { name: "新品商品信息建档" }).waitFor({ state: "visible" });
  const quickEntryTitles = await page.locator(".home-quick-card strong").allInnerTexts();
  assert.deepEqual(quickEntryTitles, ["商品套图", "爆品图复刻", "生图画布", "商品库"]);

  // 2. Frontend validation: oversize > 200KB .txt rejected client-side
  const oversizeTxt = {
    name: "too-big.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("a".repeat(201 * 1024), "utf8"),
  };
  await page.getByLabel("上传 .txt 文本附件").setInputFiles(oversizeTxt);
  await page.locator(".home-composer-error").waitFor({ state: "visible" });
  assert.match(await page.locator(".home-composer-error").innerText(), /200 KB/);
  assert.equal(await page.locator(".home-pending-txt").count(), 0);

  // 3. Upload 1 supplier image + 1 valid .txt + enter text -> start onboarding
  const imgPath = path.resolve("public/assets/gan65-product.jpg");
  const validTxt = {
    name: "supplier-spec.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("商品规格：容量 500ml，高度 215mm，净重 265g，SKU：CUP-500-PRO", "utf8"),
  };
  await page.getByLabel("选择供应商参考图").setInputFiles(imgPath);
  await page.getByLabel("上传 .txt 文本附件").setInputFiles(validTxt);
  await page.locator('.home-pending-image[data-pending-image="gan65-product.jpg"]').waitFor({ state: "visible" });
  await page.locator('.home-pending-txt[data-pending-txt="supplier-spec.txt"]').waitFor({ state: "visible" });

  await page
    .getByLabel("新品商品信息输入")
    .fill("新品真空保温随行杯，卖点是 12 小时保温保冷和一键弹盖防漏，帮我建档");
  await page.getByRole("button", { name: "开始建档" }).click();

  // Automatically enters dual-column session mode /?session=<id>
  await page.waitForFunction(
    () => window.location.pathname === "/" && Boolean(new URLSearchParams(window.location.search).get("session")),
  );
  const sessionId = new URL(page.url()).searchParams.get("session");
  assert.ok(sessionId, "URL should contain ?session=<id>");

  // Verify left chat renders user text, .txt capsule, image thumbnail, and Agent merged follow-up
  await page.locator(".home-chat-messages").waitFor({ state: "visible" });
  assert.equal(await page.locator('.home-msg[data-message-role="user"]').count(), 1);
  assert.equal(await page.locator('.home-msg[data-message-role="assistant"]').count(), 1);
  assert.match(await page.locator(".home-msg-txt-pill").innerText(), /supplier-spec\.txt/);
  assert.equal(await page.locator(".home-msg-image-thumb img").count(), 1);
  assert.match(
    await page.locator('.home-msg[data-message-role="assistant"]').first().innerText(),
    /材质与工艺细节[\s\S]*适用人群与使用场景[\s\S]*包装清单/,
  );

  // Verify right ProductCardEditorForm auto-filled extracted fields & highlights 3 missing fields
  const cardPane = page.locator(".home-card-pane");
  assert.equal(await cardPane.locator(`#onboarding-${sessionId}-name`).inputValue(), "真空保温随行杯 500ml");
  assert.equal(await cardPane.locator(`#onboarding-${sessionId}-skuCode`).inputValue(), "CUP-500-PRO");
  assert.equal(await cardPane.locator(".pc-field.is-missing").count(), 3);
  assert.equal(await cardPane.locator(".pc-supplier-card").count(), 1);

  const publishBtn = cardPane.getByRole("button", { name: "保存到商品库" });
  assert.equal(await publishBtn.isDisabled(), true, "Publish button must be disabled when 3 required fields are missing");
  assert.match(await cardPane.locator('[data-testid="pc-disable-reason"]').innerText(), /尚缺 3 项必填/);

  // 4. Return to "/" mid-way -> see draft session in "未完成建档草稿" and click to resume
  await page.getByRole("button", { name: "返回首页" }).click();
  await page.waitForFunction(
    () => window.location.pathname === "/" && !new URLSearchParams(window.location.search).get("session"),
  );

  const draftCard = page.locator(`.home-draft-card[data-draft-session-id="${sessionId}"]`);
  await draftCard.waitFor({ state: "visible" });
  const draftCardText = await draftCard.innerText();
  assert.match(draftCardText, /真空保温随行杯 500ml/);
  assert.match(draftCardText, /待补 3 项必填/);

  // Resume draft session
  await draftCard.getByRole("button", { name: "继续建档" }).click();
  await page.waitForFunction(
    (id) => window.location.pathname === "/" && new URLSearchParams(window.location.search).get("session") === id,
    sessionId,
  );
  await cardPane.locator(`#onboarding-${sessionId}-name`).waitFor({ state: "visible" });

  // 5. Manually edit product name on right form -> verify debounced PATCH /draft persists
  await cardPane.locator(`#onboarding-${sessionId}-name`).fill("星河真空保温随行杯 500ml（旗舰版）");
  await page.waitForFunction(
    () => document.querySelector(".home-draft-save-status.is-saved")?.textContent?.includes("已自动保存"),
  );
  assert.ok(
    apiCalls.some((c) => c.method === "PATCH" && c.path === `/api/product-onboarding/sessions/${sessionId}/draft`),
    "Manual edit must persist via PATCH /draft",
  );

  // 6. Test error + retry flow in left chat without losing input, then complete required fields
  shouldFailNextReply = true;
  await page
    .getByLabel("补充商品信息输入框")
    .fill("材质是 316L 不锈钢内胆+304 外壳，适合通勤和露营，包装含保温杯本体、杯垫和说明书");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.locator(".home-chat-error").waitFor({ state: "visible" });
  assert.match(await page.locator(".home-chat-error").innerText(), /超时|重试/);
  assert.match(await page.getByLabel("补充商品信息输入框").inputValue(), /316L/);

  // Retry succeeds -> all 7 required fields filled & publish button enabled
  await page.getByRole("button", { name: "重试发送" }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.home-msg[data-message-role="assistant"]').length === 2,
  );
  assert.equal(await cardPane.locator(".pc-field.is-missing").count(), 0);
  assert.equal(await cardPane.locator(`#onboarding-${sessionId}-name`).inputValue(), "星河真空保温随行杯 500ml（旗舰版）");
  assert.equal(await publishBtn.isDisabled(), false, "Publish button must be enabled when all 7 required fields are filled");

  // 7. Click "保存到商品库" -> transitions to completed read-only state + success banner with 4 actions
  await publishBtn.click();
  const completedBanner = page.locator('[data-testid="onboarding-completed-banner"]');
  await completedBanner.waitFor({ state: "visible" });
  assert.match(await completedBanner.innerText(), /星河真空保温随行杯 500ml（旗舰版）/);
  await completedBanner.getByRole("button", { name: "去生成商品套图" }).waitFor({ state: "visible" });
  await completedBanner.getByRole("button", { name: "去爆品图复刻" }).waitFor({ state: "visible" });
  await completedBanner.getByRole("button", { name: "在商品库查看" }).waitFor({ state: "visible" });
  await completedBanner.getByRole("button", { name: "继续录入新品" }).waitFor({ state: "visible" });

  // Left chat composer hidden & read-only notice visible; right form read-only
  assert.equal(await page.locator(".home-chat-composer-wrap").count(), 0);
  await page.locator('[data-testid="chat-readonly-notice"]').waitFor({ state: "visible" });
  assert.equal(await cardPane.locator(`#onboarding-${sessionId}-name`).isDisabled(), true);

  // Fetch published productCardId from session API
  const sessionRes = await api.request("GET", `/api/product-onboarding/sessions/${sessionId}`);
  assert.equal(sessionRes.status, 200);
  const productCardId = sessionRes.body.data.productCardId;
  assert.ok(productCardId, "Completed session should have productCardId");

  // Verify quick jump to Suite Studio carries ?productCardId=<id>
  await completedBanner.getByRole("button", { name: "去生成商品套图" }).click();
  await page.waitForFunction(
    (id) =>
      window.location.pathname === "/create/suite" &&
      new URLSearchParams(window.location.search).get("productCardId") === id,
    productCardId,
  );

  // Clicking top-left PicAgent brand returns to "/" HomePage
  await page.locator(".pa-brand").click();
  await page.waitForFunction(() => window.location.pathname === "/" && window.location.search === "");

  // Published session is no longer in drafts, and appears in "最近商品信息卡"
  assert.equal(await page.locator(`.home-draft-card[data-draft-session-id="${sessionId}"]`).count(), 0);
  const recentCard = page.locator(`.home-recent-card[data-recent-card-id="${productCardId}"]`);
  await recentCard.waitFor({ state: "visible" });
  assert.match(await recentCard.innerText(), /星河真空保温随行杯 500ml（旗舰版）/);

  // Verify quick jump to Replica Studio from recent card
  await recentCard.getByRole("button", { name: "去爆品图复刻" }).click();
  await page.waitForFunction(
    (id) =>
      window.location.pathname === "/create/replica" &&
      new URLSearchParams(window.location.search).get("productCardId") === id,
    productCardId,
  );

  // Verify supplier images never leak into /api/library/resources
  const libRes = await api.request("GET", "/api/library/resources?scope=image");
  assert.equal(libRes.status, 200);
  assert.equal(libRes.body.data.items.length, 0, "Onboarding supplier images must not appear in image library");

  // 8. Seed another draft session via API and verify delete action on HomePage
  const extraDraftRes = await api.request("POST", "/api/product-onboarding/sessions", {
    body: { message: "临时测试草稿" },
  });
  assert.equal(extraDraftRes.status, 201);
  const extraDraftId = extraDraftRes.body.data.id;

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
  const extraDraftCard = page.locator(`.home-draft-card[data-draft-session-id="${extraDraftId}"]`);
  await extraDraftCard.waitFor({ state: "visible" });
  await extraDraftCard.locator(".home-icon-danger-btn").click();
  const confirmModal = page.locator(".home-confirm-modal");
  await confirmModal.waitFor({ state: "visible" });
  await confirmModal.getByRole("button", { name: "确认删除" }).click();
  await confirmModal.waitFor({ state: "hidden" });
  assert.equal(await page.locator(`.home-draft-card[data-draft-session-id="${extraDraftId}"]`).count(), 0);

  assert.equal(llmCalls.length, 4, "Expected 4 total LLM invocations (1st turn + failed 2nd + retried 2nd + extra draft)");
  assert.deepEqual(pageErrors, [], `Expected no uncaught page errors, got: ${pageErrors.join("; ")}`);
});
