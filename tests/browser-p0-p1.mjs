import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";
import { createTicket02App } from "../server/app.js";
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
  const now = new Date().toISOString();
  libraryRepository.addResource({
    id: `prompt:${tpl.templateVersionId}`,
    resourceType: "prompt_template",
    title: tpl.name,
    summary: "底图精修已发布模板",
    mimeType: null,
    previewUrl: null,
    suiteId: null,
    taskId: null,
    imageVersionId: null,
    baseVersionId: null,
    templateVersionId: tpl.templateVersionId,
    resourceVersionId: tpl.templateVersionId,
    stage: tpl.stage,
    source: { templateId: tpl.templateId, versionNo: tpl.versionNo, body: tpl.body },
    status: "published",
    promptSnapshot: null,
    createdAt: now,
    updatedAt: now,
  });

  let settingsState = { channels: [], preferences: { image: null, vision: null } };
  const modelSettings = new ModelSettings({
    read: async () => structuredClone(settingsState),
    update: async (change) => { settingsState = change(structuredClone(settingsState)); return structuredClone(settingsState); },
  });

  const seeded = await seedDemoShowcase({ repository, planRepository, taskRepository, reverseRepository, imageEditorRepository, storage });

  const editorService = new ImageEditorService(
    imageEditorRepository,
    {
      name: "demo-editor",
      version: "gpt-image-2",
      capabilitiesVersion: "v1",
      capabilities: () => ({ imageToImage: true, addText: true, changeText: true, redraw: true, erase: true, outpaint: true, currentVersionInput: true }),
      edit: async () => ({ bytes: Buffer.from("ok"), mimeType: "image/png", width: 64, height: 64 }),
    },
    storage,
    async () => null,
  );
  const imageEditorApi = createImageEditorApi(editorService);

  const app = createTicket02App({
    repository,
    planRepository,
    taskRepository,
    reverseRepository,
    promptRepository,
    libraryRepository,
    storage,
    modelSettings,
    imageEditorApi,
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
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { server, baseUrl, seeded };
}

async function run() {
  const { server, baseUrl, seeded } = await startTestServer();
  const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));

  try {
    // 1. Lobby (/suites/new): Unified AppShell, zero placeholder "接口预留", recent suite cover + demo shortcut
    await page.goto(`${baseUrl}/suites/new`, { waitUntil: "networkidle" });
    await page.waitForSelector(".pa-lobby");
    const lobbyText = await page.locator("body").innerText();
    assert.doesNotMatch(lobbyText, /接口预留|接口已预留/, "Lobby must not contain placeholder modes");
    assert.equal(await page.locator(".pa-rail-item").count(), 3, "AppShell rail should have exactly 3 real nav items");
    assert.ok(await page.locator(".pa-mode-card.is-demo").isVisible(), "Demo shortcut card should appear");
    assert.ok(await page.locator(".pa-project-card img").first().isVisible(), "Recent project card should display cover thumbnail");

    // 2. Four-step wizard (/suites/:suiteId): Stepper, collapsible steps, RAG banner
    await page.goto(`${baseUrl}/suites/${seeded.suiteId}`, { waitUntil: "networkidle" });
    await page.waitForSelector(".pa-wizard-stepper");
    assert.equal(await page.locator(".pa-step").count(), 4, "Wizard should render 4 horizontal steps");
    assert.ok(await page.locator(".pa-rag-banner").isVisible(), "RAG banner should be prominent in step 2");
    await page.getByRole("button", { name: "折叠步骤" }).first().click();
    assert.ok(await page.locator(".pa-collapsed-summary").isVisible(), "Completed step 1 should collapse cleanly");

    // 3. Compose board (/suites/:suiteId/board): AppShell intact, three-lane layout, style override drawer, before/after compare
    await page.goto(`${baseUrl}/suites/${seeded.suiteId}/board`, { waitUntil: "networkidle" });
    await page.waitForSelector(".wb-style-card");
    assert.equal(await page.locator(".pa-rail-item").count(), 3, "Board page must share AppShell rail");

    // Tidy layout and click a task node -> must highlight lineage without snapping back
    await page.getByRole("button", { name: "一键整理布局" }).click();
    await page.locator(".wb-task-card:not(.wb-edit-child-card)").first().click();
    assert.ok((await page.locator(".wb-card.is-lineage-active").count()) >= 2, "Selecting task node must highlight lineage");

    // Open style override drawer and save override
    await page.locator(".wb-style-card .wb-link-button").click();
    await page.waitForSelector(".wb-style-drawer");
    await page.locator(".wb-style-field textarea").fill("高对比度极简暗金科技影棚光效");
    await page.getByRole("button", { name: "保存画布风格覆盖" }).click();
    await page.waitForSelector(".wb-card-state.is-override");

    // Open edit-child card preview -> Before/After split slider lightbox
    await page.locator(".wb-edit-child-card .wb-output-image").click();
    await page.waitForSelector(".ba-compare-stage");
    assert.ok(await page.locator(".ba-handle").isVisible(), "Edit child lightbox must show Before/After slider");
    await page.keyboard.press("Escape");

    // Open Konva image editor -> local contrast preview toggle without mutating snapshot contract
    await page.locator(".wb-task-card:not(.wb-edit-child-card) .wb-card-edit").first().click();
    await page.waitForSelector(".wb-editor-modal");
    await page.locator(".wb-editor-tools button", { hasText: "添加文本" }).click();
    assert.ok(await page.getByRole("button", { name: "深色预览" }).isVisible(), "Text preview contrast toggle must be visible");
    await page.getByRole("button", { name: "浅色预览" }).click();
    await page.getByRole("button", { name: "关闭图片编辑器" }).click();

    // 4. Delivery Gallery view: exits ReactFlow, storefront + grid toggle, read-only, ZIP download works
    await page.getByRole("tab", { name: "成品展示板" }).click();
    await page.waitForSelector(".dg-root");
    assert.equal(await page.locator(".react-flow").count(), 0, "Gallery mode must be decoupled from ReactFlow");
    assert.ok(await page.locator(".dg-shelf-hero").isVisible(), "Storefront preview hero must render");
    assert.ok(await page.locator(".dg-long-canvas").isVisible(), "Detail seamless long canvas must render");
    const galleryText = await page.locator(".dg-root").innerText();
    assert.match(galleryText, /编辑终版/, "Merged edit-final badge must appear in delivery view");
    assert.match(galleryText, /模板版本/, "Delivery inspector must display template version");
    assert.doesNotMatch(galleryText, /单卡生成|保存提示词|编辑图片/, "Delivery view must remain strictly read-only");

    // Switch to grouped grid view
    await page.getByRole("tab", { name: "分组网格清单" }).click();
    await page.waitForSelector(".dg-grid-view");

    // Verify ZIP download endpoint from browser context
    const zipResponse = await page.request.get(`${baseUrl}/api/suites/${seeded.suiteId}/delivery/export`);
    assert.equal(zipResponse.status(), 200);
    const zipEntries = readZipEntries(await zipResponse.body());
    assert.ok(zipEntries.has("manifest.json"), "Exported ZIP must include manifest.json");

    // 5. ReversePage: Unified AppShell, dynamic 4-step status, structure summary pills
    await page.goto(`${baseUrl}/reverse/${seeded.reversePlanId}`, { waitUntil: "networkidle" });
    await page.waitForSelector(".reverse-layout");
    assert.equal(await page.locator(".pa-rail-item").count(), 3, "ReversePage must share AppShell rail");
    assert.ok((await page.locator(".reverse-step.done").count()) >= 3, "Completed reverse steps must be marked done dynamically");
    assert.ok(await page.locator(".reverse-summary-pills").isVisible(), "ReversePage must show summary pills");

    // 6. StyleLibraryPage: Unified AppShell, single click updates inspector without forcing modal, dynamic stage filter + template edit
    await page.goto(`${baseUrl}/style-library`, { waitUntil: "networkidle" });
    await page.waitForSelector(".style-library-workarea");
    assert.equal(await page.locator(".pa-rail-item").count(), 3, "StyleLibraryPage must share AppShell rail");
    await page.getByRole("tab", { name: /提示词模板/ }).click();
    await page.waitForSelector(".style-card");
    const filterText = await page.locator(".style-filter-panel").innerText();
    assert.match(filterText, /执行阶段/, "Template tab must switch left filter panel to execution stage");
    assert.match(filterText, /爆品图反推/, "Template stage filter must include reverse_prompt");
    await page.locator(".style-card").first().click();
    assert.equal(await page.locator(".style-library-prompt-modal").count(), 0, "Clicking card must NOT force-open full-screen prompt modal");
    await page.getByRole("button", { name: "查看完整提示词快照" }).click();
    await page.waitForSelector(".style-library-prompt-modal");
    await page.keyboard.press("Escape");
    // Template draft lifecycle: copy -> edit -> save -> publish
    await page.getByRole("button", { name: "复制新草稿" }).click();
    await page.getByRole("button", { name: "保存草稿" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "保存草稿" }).click();
    await page.getByRole("button", { name: "发布此版本" }).click();

    // 7. ModelSettingsPage: Unified AppShell intact
    await page.goto(`${baseUrl}/settings`, { waitUntil: "networkidle" });
    await page.waitForSelector(".settings-main");
    assert.equal(await page.locator(".pa-rail-item").count(), 3, "ModelSettingsPage must share AppShell rail");

    assert.deepEqual(errors, [], `No uncaught page errors expected, got: ${errors.join("; ")}`);
    console.log("PASS: All P0 & P1 Playwright E2E assertions succeeded.");
  } finally {
    await browser.close();
    server.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
