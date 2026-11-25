import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";
import { createSuiteStudioApp } from "../server/app.js";
import { ImageEditorService, MemoryImageEditorRepository } from "../server/image-editor.js";
import { createImageEditorApi } from "../server/image-editor-api.js";
import { ModelSettings } from "../server/model-settings.js";
import { parsePromptMarkdown } from "../server/prompt-library.js";
import { MemoryLibraryRepository } from "../server/repositories/memory-library-repository.js";
import { MemoryPlanRepository } from "../server/repositories/memory-plan-repository.js";
import { MemoryPromptRepository } from "../server/repositories/memory-prompt-repository.js";
import { MemoryReverseRepository } from "../server/repositories/memory-reverse-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryTaskRepository } from "../server/repositories/memory-task-repository.js";
import { seedDemoShowcase } from "../server/seed-demo.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";
import { readZipEntries } from "../server/zip.js";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".json": "application/json",
};

async function startTestServer() {
  const repository = new MemorySuiteRepository();
  const planRepository = new MemoryPlanRepository();
  const taskRepository = new MemoryTaskRepository();
  const reverseRepository = new MemoryReverseRepository();
  const imageEditorRepository = new MemoryImageEditorRepository();
  const promptRepository = new MemoryPromptRepository();
  const storage = new MemoryStorage();
  const libraryRepository = new MemoryLibraryRepository();

  const [tpl] = await promptRepository.importRecords(parsePromptMarkdown("### 底图精修模板\n\n```plain\n保持商品实拍结构，纯白棚拍底图。\n```", "base.md"));
  await promptRepository.publishVersion(tpl.templateVersionId);

  let settingsState = { channels: [], preferences: { image: null, vision: null } };
  const modelSettings = new ModelSettings({
    read: async () => structuredClone(settingsState),
    update: async (change) => { settingsState = change(structuredClone(settingsState)); return structuredClone(settingsState); },
  });

  const seeded = await seedDemoShowcase({ repository, planRepository, taskRepository, reverseRepository, imageEditorRepository, storage });
  const samplePng = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 220, g: 230, b: 245, alpha: 1 } } }).png().toBuffer();

  const editorService = new ImageEditorService(
    imageEditorRepository,
    {
      name: "demo-editor",
      version: "gpt-image-2",
      capabilitiesVersion: "v1",
      capabilities: () => ({ imageToImage: true, addText: true, changeText: true, redraw: true, erase: true, outpaint: true, currentVersionInput: true }),
      edit: async () => ({ bytes: samplePng, mimeType: "image/png", width: 64, height: 64 }),
    },
    storage,
    async () => ({ bytes: samplePng, mimeType: "image/png", width: 64, height: 64, generationPrompt: "主图提示词" }),
    {
      name: "demo-ocr",
      version: "qwen-vl-ocr",
      recognize: async () => ({
        blocks: [
          { id: "ocr-1", text: "65W 极速快充", confidence: 0.98, bounds: { x: 0.1, y: 0.12, width: 0.42, height: 0.1 }, rotation: 0 },
          { id: "ocr-2", text: "折叠插脚便携设计", confidence: 0.95, bounds: { x: 0.1, y: 0.28, width: 0.48, height: 0.09 }, rotation: 0 },
        ],
      }),
    },
  );
  const imageEditorApi = createImageEditorApi(editorService);

  const app = createSuiteStudioApp({
    repository,
    planRepository,
    taskRepository,
    reverseRepository,
    promptRepository,
    libraryRepository,
    storage,
    modelSettings,
    imageEditorApi,
    llmClient: {
      provider: "demo-llm",
      model: "qwen-vl-max",
      isFake: true,
      async generatePlan() { return {}; },
      async translateTexts({ targetLanguage, items }) {
        const dict = {
          "65W 极速快充": "65W 超急速充電",
          "折叠插脚便携设计": "折りたたみプラグ・携帯設計",
        };
        return items.map((item) => ({
          id: item.id,
          originalText: item.text,
          translatedText: dict[item.text] ?? `[${targetLanguage}] ${item.text}`,
        }));
      },
    },
  });

  const distDir = path.resolve("dist");
  const publicDir = path.resolve("public");
  const readStatic = async (pathname) => {
    const clean = pathname === "/" ? "/index.html" : pathname;
    for (const root of [distDir, publicDir]) {
      const target = path.join(root, clean.replace(/^\/+/, ""));
      if (!target.startsWith(root)) continue;
      try {
        const stat = await fs.stat(target);
        if (stat.isFile()) {
          return { bytes: await fs.readFile(target), contentType: MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream" };
        }
      } catch { /* continue */ }
    }
    return null;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyBuf = Buffer.concat(chunks);

    if (pathname.startsWith("/api/")) {
      const previewInput = pathname.match(/^\/api\/suites\/([^/]+)\/input-images\/([^/]+)\/preview\/(original|thumbnail)$/);
      const previewBase = pathname.match(/^\/api\/suites\/([^/]+)\/input-images\/([^/]+)\/base-versions\/([^/]+)\/preview$/);
      const previewTask = pathname.match(/^\/api\/suite-tasks\/([^/]+)\/versions\/([^/]+)\/preview$/);
      const previewEdit = pathname.match(/^\/api\/image-editor\/tasks\/([^/]+)\/versions\/([^/]+)\/preview$/);
      const previewReverse = pathname.match(/^\/api\/reverse-plans\/([^/]+)\/references\/([^/]+)\/preview(?:\/(original|thumbnail))?$/);
      const previewLibrary = pathname.match(/^\/api\/library\/resources\/([^/]+)\/preview$/);

      let response;
      if (req.method === "GET" && previewInput) response = await app.preview(previewInput[1], previewInput[2], previewInput[3]);
      else if (req.method === "GET" && previewBase) response = await app.previewBaseVersion(previewBase[1], previewBase[2], previewBase[3]);
      else if (req.method === "GET" && previewTask) response = await app.previewTaskVersion(previewTask[1], previewTask[2]);
      else if (req.method === "GET" && previewEdit) {
        const versions = await imageEditorRepository.listVersions(previewEdit[1]);
        const found = versions.find((v) => v.id === previewEdit[2]);
        const obj = found ? await storage.get(found.objectKey) : null;
        response = obj ? { status: 200, raw: obj.bytes, headers: { "content-type": obj.contentType } } : { status: 404, body: { error: { code: "NOT_FOUND", message: "not found" }, requestId: "" } };
      } else if (req.method === "GET" && previewReverse) response = await app.previewReverseReference(previewReverse[1], previewReverse[2], previewReverse[3] ?? "thumbnail");
      else if (req.method === "GET" && previewLibrary) response = await app.previewLibraryResource(previewLibrary[1]);
      else {
        let parsed;
        try { parsed = bodyBuf.length ? JSON.parse(bodyBuf.toString("utf8")) : undefined; } catch { parsed = undefined; }
        response = await app.request(req.method ?? "GET", pathname + url.search, { headers: req.headers, body: parsed });
      }
      if (response.raw) {
        res.statusCode = response.status;
        for (const [k, v] of Object.entries(response.headers ?? {})) res.setHeader(k, v);
        res.end(response.raw);
        return;
      }
      res.statusCode = response.status;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(response.body));
      return;
    }

    const asset = (await readStatic(pathname)) ?? (await readStatic("/index.html"));
    if (asset) {
      res.statusCode = 200;
      res.setHeader("content-type", asset.contentType);
      res.end(asset.bytes);
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, seeded };
}

async function run() {
  const { server, baseUrl, seeded } = await startTestServer();
  const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));

  try {
    // 1. Lobby search, status filter & inline rename
    await page.goto(`${baseUrl}/suites/new`, { waitUntil: "networkidle" });
    await page.waitForSelector(".pa-recents-search");
    await page.getByLabel("搜索最近项目").fill("不存在的商品XYZ");
    assert.equal(await page.locator(".pa-project-card").count(), 0, "Search should filter out non-matching suites");
    await page.getByLabel("搜索最近项目").fill("");
    assert.equal(await page.locator(".pa-project-card").count(), 1, "Clearing search should restore suite card");

    await page.locator(".pa-project-rename-btn").first().click();
    await page.getByLabel("新方案名称").fill("65W 氮化镓演示套图 · P2 验收");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.waitForSelector('h3:has-text("65W 氮化镓演示套图 · P2 验收")');

    // 2. Wizard 12 cross-border languages
    await page.goto(`${baseUrl}/suites/${seeded.suiteId}`, { waitUntil: "networkidle" });
    await page.waitForSelector(".pa-wizard-stepper");
    const langOptions = await page.locator("select option").allInnerTexts();
    assert.ok(langOptions.some((t) => t.includes("日语")), "Output languages must include Japanese");
    assert.ok(langOptions.some((t) => t.includes("德语")), "Output languages must include German");
    assert.ok(langOptions.some((t) => t.includes("泰语")), "Output languages must include Thai");

    // 3. Workbench Compose Board: MiniMap, filter strip, custom task modal, smart batch button, batch param sync, version compare modal
    await page.goto(`${baseUrl}/suites/${seeded.suiteId}/board`, { waitUntil: "networkidle" });
    await page.waitForSelector(".wb-filter-strip");
    assert.ok(await page.locator(".react-flow__minimap").isVisible(), "MiniMap must render in compose canvas");

    // Filter strip dims non-matching nodes
    await page.locator(".wb-filter-strip button", { hasText: /编辑子卡/ }).click();
    assert.ok((await page.locator(".wb-card.is-lineage-dim").count()) >= 1, "Filter strip should dim non-matching cards");
    await page.locator(".wb-filter-strip button", { hasText: /全部/ }).click();

    // Custom task card creation
    await page.getByRole("button", { name: "+ 新建任务卡" }).click();
    await page.waitForSelector(".wb-custom-task-form");
    await page.locator(".wb-quick-chips button", { hasText: "居家生活场景图" }).click();
    await page.getByRole("button", { name: "加入创作画布" }).click();
    await page.waitForSelector('button:has-text("生成待完成 (1)")');

    // Batch parameter sync in inspector
    await page.getByRole("button", { name: /同步参数到全部/ }).click();
    await page.waitForSelector('.suite-toast:has-text("已将比例/尺寸/清晰度同步至")');

    // Multi-version compare modal on seeded card
    await page.locator(".wb-task-card:not(.wb-edit-child-card)").first().click();
    await page.getByRole("button", { name: /版本对比/ }).click();
    await page.waitForSelector(".vc-modal");
    assert.ok((await page.locator(".vc-card").count()) >= 1, "Version compare modal must display version cards");
    await page.getByRole("button", { name: "关闭版本对比" }).click();

    // 4. Konva Image Editor: zoom, hold compare, quick chips, outpaint visual preview, cross-border batch translation
    await page.locator(".wb-task-card:not(.wb-edit-child-card) .wb-card-edit").first().click();
    await page.waitForSelector(".wb-editor-modal");

    // Zoom controls
    await page.getByRole("button", { name: "放大画布" }).click();
    assert.match(await page.locator(".wb-zoom-controls").innerText(), /125%/, "Zoom should increase to 125%");
    await page.getByRole("button", { name: "125%" }).click();
    assert.match(await page.locator(".wb-zoom-controls").innerText(), /100%/, "Clicking zoom % should reset to 100%");

    // Inpaint quick directive + hold compare button
    await page.locator(".wb-editor-tools button", { hasText: "局部重绘" }).click();
    assert.ok(await page.getByRole("button", { name: "按住看原图" }).isVisible(), "Hold-to-compare button must appear in mask mode");
    await page.locator(".wb-quick-chips button").first().click();
    assert.ok((await page.locator('.wb-editor-options textarea').first().inputValue()).length > 0, "Clicking quick chip must populate redraw prompt");

    // Outpaint proportional frame preview
    await page.locator(".wb-editor-tools button", { hasText: "扩图" }).click();
    assert.ok(await page.locator(".wb-outpaint-frame").isVisible(), "Outpaint proportional frame preview must render");
    assert.ok(await page.locator(".wb-outpaint-origin img").isVisible(), "Outpaint origin image anchor must render");

    // Cross-border one-click image translation inside change_text
    await page.locator(".wb-editor-tools button", { hasText: "编辑文字" }).click();
    await page.getByRole("button", { name: "一键翻译", exact: true }).waitFor();
    await page.getByLabel("翻译目标语言").selectOption("日语");
    await page.getByRole("button", { name: "一键翻译", exact: true }).click();
    await page.waitForFunction(() => {
      const inputs = Array.from(document.querySelectorAll(".wb-text-edit-row textarea"));
      return inputs.some((el) => el.value.includes("65W 超急速充電"));
    });
    assert.deepEqual(await page.locator(".wb-text-edit-row textarea").evaluateAll((fields) => fields.map((field) => field.value)), ["65W 超急速充電", "折りたたみプラグ・携帯設計"]);
    await page.getByRole("button", { name: "关闭图片编辑器" }).click();

    // 5. Delivery Gallery View: mobile 390px toggle, compliance pre-check card, multi-platform export bar + ZIP verification
    await page.getByRole("tab", { name: "成品展示板" }).click();
    await page.waitForSelector(".dg-export-bar");
    assert.ok(await page.locator(".dg-compliance-card").isVisible(), "Compliance pre-check card must render");
    assert.ok(await page.getByRole("button", { name: "下载当前单张原图" }).isVisible(), "Single image download button must render");

    // Mobile 390px storefront toggle
    await page.getByRole("button", { name: "手机端 390px" }).click();
    assert.ok(await page.locator(".dg-storefront.is-mobile").isVisible(), "Mobile storefront preview mode must activate");
    assert.ok(await page.locator(".dg-long-canvas.is-mobile").isVisible(), "Mobile detail long canvas frame must activate");

    // Select Taobao preset -> auto enables stitched detail + JPEG
    await page.getByLabel("平台规格预设").selectOption("taobao");
    const zipResp = await page.request.get(`${baseUrl}/api/suites/${seeded.suiteId}/delivery/export?preset=taobao&format=jpeg&quality=88&stitchDetail=true`);
    assert.equal(zipResp.status(), 200);
    const entries = readZipEntries(await zipResp.body());
    assert.ok(entries.has("detail/00_detail_long_stitched.jpg"), "Taobao export ZIP must include stitched detail long image");
    const manifest = JSON.parse(entries.get("manifest.json").toString("utf8"));
    assert.equal(manifest.exportOptions.preset, "taobao");
    assert.equal(manifest.summary.stitchedDetailIncluded, true);

    assert.deepEqual(errors, [], `No uncaught page errors expected, got: ${errors.join("; ")}`);
    console.log("PASS: All P2 Playwright E2E assertions succeeded.");
  } finally {
    await browser.close();
    server.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
