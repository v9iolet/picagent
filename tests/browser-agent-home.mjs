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

test("HomePage Agent onboarding: v2 landing, unified + menu upload, InfoTip, on-demand char counters, optional fold, segmented drafts, publish & quick jumps", async (t) => {
  let shouldFailNextReply = false;
  let pendingReplyGate = null;

  const { baseUrl, browser, api, llmCalls, apiCalls } = await startOfflineHomeApp(
    t,
    async (input, callIndex) => {
      if (shouldFailNextReply) {
        shouldFailNextReply = false;
        throw new Error("LLM_TIMEOUT");
      }

      if (pendingReplyGate) {
        const gate = pendingReplyGate;
        pendingReplyGate = null;
        await gate.promise;
      }

      if (callIndex === 1) {
        assert.equal(input.supplierImages.length, 1, "First turn should pass uploaded supplier image");
        assert.equal(input.txtAttachments.length, 1, "First turn should pass uploaded .txt attachment");
        assert.match(input.txtAttachments[0].content, /500ml/);
        return {
          schemaVersion: PRODUCT_ONBOARDING_SCHEMA_VERSION,
          reply:
            "已根据文字、附件与供应商图提取基础信息，请一次性补充以下 3 项剩余必填项：\n1. 材质与工艺细节：主体材质与表面工艺\n2. 适用人群与使用场景：目标人群与典型场景\n3. 包装清单 / 配件说明：包含主体与配件清单",
          draftCard: {
            name: "真空保温随行杯 500ml",
            sellingPoints: [
              "12 小时真空保温保冷",
              "一键弹盖防漏锁扣设计",
            ],
            specifications: "容量 500ml，高度 215mm，杯底直径 68mm，净重 265g",
            materialsCraft: "",
            audienceScenarios: "",
            packageContents: "",
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
            sellingPoints: [],
            specifications: "",
            materialsCraft: "",
            audienceScenarios: "",
            packageContents: "",
            painPointsComparison: "",
            usageDemoHighlights: "",
            certificationsProhibitions: "",
          },
          missingRequiredFields: [
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
          "核心 6 项必填商品信息已全部齐备，请核对右侧商品信息卡后点击「保存到商品库」。",
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

  // 1. Open "/" -> defaults to HomePage (clean v2 hero without gradient card or ✨ badge)
  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
  assert.equal(new URL(page.url()).pathname, "/", "Root / must stay on HomePage");

  const navLabels = await page.locator(".pa-rail-item span").allInnerTexts();
  assert.deepEqual(navLabels, ["首页", "创建", "商品库", "图片库", "模板库", "配置"]);
  await page.locator('.pa-rail-item.is-active[href="/"]').waitFor({ state: "visible" });
  assert.equal(await page.locator(".pa-brand").getAttribute("href"), "/");

  // Verify de-AI-ified hero heading, InfoTip popover, 4 compact quick entry pills, and no drafts tab when N=0
  await page.getByRole("heading", { name: "新品信息建档", exact: true }).waitFor({ state: "visible" });
  assert.equal(await page.locator(".home-hero-badge").count(), 0, "Legacy ✨ badge must be removed");
  assert.equal(await page.locator(".home-empty-box").count(), 0, "Legacy dashed empty box must be removed");
  assert.equal(
    await page.locator('[data-home-tab="drafts"]').count(),
    0,
    "Drafts tab must be hidden when draft count is 0",
  );
  const quickEntryTitles = await page.locator(".home-quick-pill .home-quick-left span").allInnerTexts();
  assert.deepEqual(quickEntryTitles, ["商品套图", "爆品图复刻", "生图画布", "商品库"]);

  // Verify Home InfoTip opens on click and closes on Escape
  const homeInfoBtn = page.getByRole("button", { name: "建档说明" });
  await homeInfoBtn.click();
  const homeTip = page.locator("#" + (await homeInfoBtn.getAttribute("aria-controls")));
  await homeTip.waitFor({ state: "visible" });
  assert.match(await homeTip.innerText(), /不直接生图/);
  await page.keyboard.press("Escape");
  await homeTip.waitFor({ state: "hidden" });

  // 2. Unified "+" floating menu: open, close on Escape, then upload via menu items
  const plusBtn = page.getByRole("button", { name: "添加附件" });
  await plusBtn.click();
  const plusMenu = page.getByRole("menu", { name: "上传附件菜单" });
  await plusMenu.waitFor({ state: "visible" });
  assert.match(await plusMenu.innerText(), /上传供应商参考图[\s\S]*上传文本资料/);
  await page.keyboard.press("Escape");
  await plusMenu.waitFor({ state: "hidden" });

  // Oversize > 200KB .txt rejected client-side via unified "+" menu
  const oversizeTxt = {
    name: "too-big.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("a".repeat(201 * 1024), "utf8"),
  };
  await plusBtn.click();
  await plusMenu.waitFor({ state: "visible" });
  const [oversizeChooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    plusMenu.getByRole("menuitem", { name: /上传文本资料/ }).click(),
  ]);
  await oversizeChooser.setFiles(oversizeTxt);
  await page.locator(".home-composer-error").waitFor({ state: "visible" });
  assert.match(await page.locator(".home-composer-error").innerText(), /200 KB/);
  assert.equal(await page.locator(".home-pending-txt").count(), 0);

  // 3. Upload 1 supplier image + 1 valid .txt through the "+" menu -> start onboarding
  const imgPath = path.resolve("public/assets/gan65-product.jpg");
  const validTxt = {
    name: "supplier-spec.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("商品规格：容量 500ml，高度 215mm，净重 265g", "utf8"),
  };
  await plusBtn.click();
  const [imgChooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    plusMenu.getByRole("menuitem", { name: /上传供应商参考图/ }).click(),
  ]);
  await imgChooser.setFiles(imgPath);
  await page.locator('.home-pending-image[data-pending-image="gan65-product.jpg"]').waitFor({ state: "visible" });

  await plusBtn.click();
  assert.match(await plusMenu.innerText(), /已传 1\/6 张/);
  const [txtChooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    plusMenu.getByRole("menuitem", { name: /上传文本资料/ }).click(),
  ]);
  await txtChooser.setFiles(validTxt);
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

  // Verify left chat renders user text, attachments, and clean assistant reply without repeated Agent header
  await page.locator(".home-chat-messages").waitFor({ state: "visible" });
  assert.equal(await page.locator('.home-msg[data-message-role="user"]').count(), 1);
  assert.equal(await page.locator('.home-msg[data-message-role="assistant"]').count(), 1);
  assert.equal(
    await page.locator(".home-chat-messages").getByText("商品建档 Agent").count(),
    0,
    "Repeated '商品建档 Agent' message header must be removed",
  );
  assert.match(await page.locator(".home-msg-txt-pill").innerText(), /supplier-spec\.txt/);
  assert.equal(await page.locator(".home-msg-image-thumb img").count(), 1);
  assert.match(
    await page.locator('.home-msg[data-message-role="assistant"]').first().innerText(),
    /材质与工艺细节[\s\S]*适用人群与使用场景[\s\S]*包装清单/,
  );

  // Verify right flat ProductCardEditorForm: auto-filled fields, no nested boxes, on-demand char counter & collapsed optional section
  const cardPane = page.locator(".home-card-pane");
  const nameInput = cardPane.locator(`#onboarding-${sessionId}-name`);
  assert.equal(await nameInput.inputValue(), "真空保温随行杯 500ml");
  assert.equal(await cardPane.locator('[data-testid="required-progress-pill"]').innerText(), "已填 3/6 必填");
  assert.equal(await cardPane.locator(".pc-field.is-missing").count(), 3);
  assert.equal(await cardPane.locator(".pc-supplier-card").count(), 1);

  // On-demand char counter: hidden when blurred, visible on focus, hidden again on blur
  // Also verify focused + hovered input keeps #18181B (rgb(24, 24, 27)) charcoal border
  const nameCounter = cardPane.locator('[data-char-counter="name"]');
  assert.equal(await nameCounter.isVisible(), false, "Char counter must be hidden when field is not focused");
  await nameInput.focus();
  await nameCounter.waitFor({ state: "visible" });
  assert.match(await nameCounter.innerText(), /\/120$/);
  await nameInput.hover();
  await page.waitForFunction(
    (id) => {
      const el = document.getElementById(id);
      return Boolean(el && getComputedStyle(el).borderTopColor === "rgb(24, 24, 27)");
    },
    `onboarding-${sessionId}-name`,
  );
  const focusedHoverBorder = await nameInput.evaluate((el) => getComputedStyle(el).borderTopColor);
  assert.equal(focusedHoverBorder, "rgb(24, 24, 27)", "Focused input must retain #18181B border while hovered");
  await nameInput.blur();
  await nameCounter.waitFor({ state: "hidden" });

  // Optional extended section collapsed by default, expandable on click
  const optionalTrigger = cardPane.locator(".pc-optional-fold-trigger");
  assert.equal(await optionalTrigger.getAttribute("aria-expanded"), "false");
  assert.equal(await cardPane.locator(`#onboarding-${sessionId}-painPointsComparison`).count(), 0);
  await optionalTrigger.click();
  assert.equal(await optionalTrigger.getAttribute("aria-expanded"), "true");
  await cardPane.locator(`#onboarding-${sessionId}-painPointsComparison`).waitFor({ state: "visible" });
  await optionalTrigger.click();
  assert.equal(await optionalTrigger.getAttribute("aria-expanded"), "false");

  // Supplier image InfoTip opens and closes with Escape
  const supplierTipBtn = cardPane.getByRole("button", { name: "供应商参考图边界说明" });
  await supplierTipBtn.click();
  const supplierTip = page.locator("#" + (await supplierTipBtn.getAttribute("aria-controls")));
  await supplierTip.waitFor({ state: "visible" });
  assert.match(await supplierTip.innerText(), /不流入创作页生图原图区/);
  await page.keyboard.press("Escape");
  await supplierTip.waitFor({ state: "hidden" });

  const publishBtn = cardPane.getByRole("button", { name: "保存到商品库" });
  assert.equal(await publishBtn.isDisabled(), true, "Publish button must be disabled when 3 required fields are missing");
  assert.match(await cardPane.locator('[data-testid="pc-disable-reason"]').innerText(), /尚缺 3 项必填/);

  // Regression assertion 1: entering /?session=<id> from POST /sessions must NOT trigger a redundant GET
  await page.waitForTimeout(150);
  const redundantSessionGets = apiCalls.filter(
    (c) => c.method === "GET" && c.path === `/api/product-onboarding/sessions/${sessionId}`,
  );
  assert.equal(
    redundantSessionGets.length,
    0,
    "Initial session transition from POST /sessions must not fire redundant GET /sessions/:id",
  );

  // 4. Regression assertion 2: edit name on right form and IMMEDIATELY click .pa-brand (<500ms) ->
  // must flush PATCH /draft before leaving and display updated name in segmented "未完成建档草稿" tab
  await nameInput.fill("星河真空保温随行杯 500ml（旗舰版）");
  await page.locator(".pa-brand").click();
  await page.waitForFunction(
    () => window.location.pathname === "/" && !new URLSearchParams(window.location.search).get("session"),
  );
  assert.ok(
    apiCalls.some((c) => c.method === "PATCH" && c.path === `/api/product-onboarding/sessions/${sessionId}/draft`),
    "Navigating via .pa-brand immediately after editing must flush PATCH /draft",
  );

  const draftsTab = page.locator('[data-home-tab="drafts"]');
  await draftsTab.waitFor({ state: "visible" });
  assert.match(await draftsTab.innerText(), /未完成建档草稿 \(1\)/);
  await draftsTab.click();

  const draftCard = page.locator(`.home-draft-card[data-draft-session-id="${sessionId}"]`);
  await draftCard.waitFor({ state: "visible" });
  const draftCardText = await draftCard.innerText();
  assert.match(draftCardText, /星河真空保温随行杯 500ml（旗舰版）/);
  assert.match(draftCardText, /待补 3 项必填/);

  // Resume draft session and confirm persisted manual edit is restored
  await draftCard.getByRole("button", { name: "继续建档" }).click();
  await page.waitForFunction(
    (id) => window.location.pathname === "/" && new URLSearchParams(window.location.search).get("session") === id,
    sessionId,
  );
  await cardPane.locator(`#onboarding-${sessionId}-name`).waitFor({ state: "visible" });
  assert.equal(
    await cardPane.locator(`#onboarding-${sessionId}-name`).inputValue(),
    "星河真空保温随行杯 500ml（旗舰版）",
  );

  // 5. Test error + retry flow in left chat without losing input, and verify right form is locked during delayed POST /messages
  shouldFailNextReply = true;
  await page
    .getByLabel("补充商品信息输入框")
    .fill("材质是 316L 不锈钢内胆+304 外壳，适合通勤和露营，包装含保温杯本体、杯垫和说明书");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.locator(".home-chat-error").waitFor({ state: "visible" });
  assert.match(await page.locator(".home-chat-error").innerText(), /超时|重试/);
  assert.match(await page.getByLabel("补充商品信息输入框").inputValue(), /316L/);

  // Regression assertion 3: during delayed POST /messages, right form inputs & publish button are disabled
  const replyGate = Promise.withResolvers();
  pendingReplyGate = replyGate;
  try {
    await page.getByRole("button", { name: "重试发送" }).click();
    await page.locator(".home-msg.is-loading").waitFor({ state: "visible" });
    assert.match(await page.locator(".home-msg.is-loading").innerText(), /提取中/);
    assert.equal(
      await cardPane.locator(`#onboarding-${sessionId}-name`).isDisabled(),
      true,
      "Right form inputs must be disabled while POST /messages is in flight",
    );
    assert.equal(
      await cardPane.locator(".pc-optional-fold-trigger").isDisabled(),
      true,
      "Optional fold trigger must be disabled while POST /messages is in flight",
    );
    assert.equal(
      await cardPane.locator(".pc-quick-fill-chip").isDisabled(),
      true,
      "Quick-fill chip must be disabled while POST /messages is in flight",
    );
    assert.equal(
      await publishBtn.isDisabled(),
      true,
      "Publish button must be disabled while POST /messages is in flight",
    );
    assert.equal(
      (await publishBtn.innerText()).trim(),
      "保存到商品库",
      "Publish button label must stay '保存到商品库' during chat follow-up",
    );
  } finally {
    pendingReplyGate = null;
    replyGate.resolve();
  }

  // Wait for retried reply -> all 6 required fields filled & publish button enabled
  await page.waitForFunction(
    () => document.querySelectorAll('.home-msg[data-message-role="assistant"]').length === 2,
  );
  assert.equal(await cardPane.locator(`#onboarding-${sessionId}-name`).isDisabled(), false);
  assert.equal(await cardPane.locator(".pc-optional-fold-trigger").isDisabled(), false);
  assert.equal(await cardPane.locator(".pc-quick-fill-chip").isDisabled(), false);
  assert.equal(await cardPane.locator('[data-testid="required-progress-pill"]').innerText(), "6/6 必填已齐");
  assert.equal(await cardPane.locator(".pc-field.is-missing").count(), 0);
  assert.equal(await cardPane.locator(`#onboarding-${sessionId}-name`).inputValue(), "星河真空保温随行杯 500ml（旗舰版）");
  assert.equal(await publishBtn.isDisabled(), false, "Publish button must be enabled when all 6 required fields are filled");

  // 7. Click "保存到商品库" -> transitions to completed read-only state + success banner with 4 actions
  await publishBtn.click();
  const completedBanner = page.locator('[data-testid="onboarding-completed-banner"]');
  await completedBanner.waitFor({ state: "visible" });
  assert.match(await completedBanner.innerText(), /星河真空保温随行杯 500ml（旗舰版）/);
  await completedBanner.getByRole("button", { name: "去生成商品套图" }).waitFor({ state: "visible" });
  await completedBanner.getByRole("button", { name: "去爆品图复刻" }).waitFor({ state: "visible" });
  await completedBanner.getByRole("button", { name: "在商品库查看" }).waitFor({ state: "visible" });
  await completedBanner.getByRole("button", { name: "继续录入新品" }).waitFor({ state: "visible" });

  // Left chat composer hidden & read-only notice visible; right form read-only (optional fold remains viewable)
  assert.equal(await page.locator(".home-chat-composer-wrap").count(), 0);
  await page.locator('[data-testid="chat-readonly-notice"]').waitFor({ state: "visible" });
  assert.equal(await cardPane.locator(`#onboarding-${sessionId}-name`).isDisabled(), true);
  assert.equal(
    await cardPane.locator(".pc-optional-fold-trigger").isDisabled(),
    false,
    "Optional fold trigger must remain enabled in read-only completed state for inspection",
  );

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

  // Published session is no longer in drafts (drafts tab hidden), and appears in "最近商品卡"
  assert.equal(await page.locator('[data-home-tab="drafts"]').count(), 0);
  const recentCard = page.locator(`.home-recent-card[data-recent-card-id="${productCardId}"]`);
  await recentCard.waitFor({ state: "visible" });
  assert.match(await recentCard.innerText(), /星河真空保温随行杯 500ml（旗舰版）/);

  // Verify quick jump to Replica Studio from recent card ("去复刻")
  await recentCard.getByRole("button", { name: "去复刻", exact: true }).click();
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

  // 8. Seed another draft session via API and verify segmented switch + delete action on HomePage
  const extraDraftRes = await api.request("POST", "/api/product-onboarding/sessions", {
    body: { message: "临时测试草稿" },
  });
  assert.equal(extraDraftRes.status, 201);
  const extraDraftId = extraDraftRes.body.data.id;

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
  const extraDraftsTab = page.locator('[data-home-tab="drafts"]');
  await extraDraftsTab.waitFor({ state: "visible" });
  await extraDraftsTab.click();

  const extraDraftCard = page.locator(`.home-draft-card[data-draft-session-id="${extraDraftId}"]`);
  await extraDraftCard.waitFor({ state: "visible" });
  await extraDraftCard.locator(".home-icon-danger-btn").click();
  const confirmModal = page.locator(".home-confirm-modal");
  await confirmModal.waitFor({ state: "visible" });
  await confirmModal.getByRole("button", { name: "确认删除" }).click();
  await confirmModal.waitFor({ state: "hidden" });
  assert.equal(await page.locator(`.home-draft-card[data-draft-session-id="${extraDraftId}"]`).count(), 0);
  // Deleting last draft hides the drafts tab and switches back to recent cards
  assert.equal(await page.locator('[data-home-tab="drafts"]').count(), 0);
  await page.locator(`.home-recent-card[data-recent-card-id="${productCardId}"]`).waitFor({ state: "visible" });

  assert.equal(llmCalls.length, 4, "Expected 4 total LLM invocations (1st turn + failed 2nd + retried 2nd + extra draft)");
  assert.deepEqual(pageErrors, [], `Expected no uncaught page errors, got: ${pageErrors.join("; ")}`);
});
