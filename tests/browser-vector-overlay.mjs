// Run with: npx tsx --test tests/browser-vector-overlay.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import sharp from "sharp";
import { createServer } from "vite";
import { createSuiteStudioApp } from "../server/app.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryTaskRepository } from "../server/repositories/memory-task-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";

test("画布矢量卖点排版：打开编辑器、切换版式/主题、增改图层保存 v2、二次打开无损还原", async (t) => {
  const sampleBytes = await sharp({
    create: { width: 640, height: 640, channels: 3, background: { r: 235, g: 240, b: 248 } },
  }).png().toBuffer();

  const repository = new MemorySuiteRepository();
  const taskRepository = new MemoryTaskRepository();
  const storage = new MemoryStorage();
  const api = createSuiteStudioApp({
    repository,
    taskRepository,
    storage,
    provider: {
      async edit() {
        return { bytes: sampleBytes, mimeType: "image/png" };
      },
    },
  });

  const suiteRes = await api.request("POST", "/api/suites", { body: { name: "矢量排版画布测试", origin: "canvas" } });
  assert.equal(suiteRes.status, 201);
  const suiteId = suiteRes.body.data.id;

  const uploadRes = await api.upload(suiteId, { filename: "charger.png", mimeType: "image/png", bytes: sampleBytes });
  assert.equal(uploadRes.status, 201);
  const inputId = uploadRes.body.data.id;

  const taskRes = await api.request("POST", `/api/suites/${suiteId}/tasks/custom`, {
    body: {
      imageType: "detail",
      title: "氮化镓充电器卖点图",
      purpose: "展示快充与温控优势",
      sourceInputImageId: inputId,
      promptDraft: '系统安全约束：真实呈现。\n当前类别提示词：纯净无字商业底图，主体位于右侧',
    },
  });
  assert.equal(taskRes.status, 201);
  const taskId = taskRes.body.data.id;

  const genRes = await api.request("POST", `/api/suite-tasks/${taskId}/generation`, {
    headers: { "idempotency-key": "browser-vo-v1" },
  });
  assert.equal(genRes.status, 202);
  const batchId = genRes.body.data.batchId;
  for (let i = 0; i < 60; i += 1) {
    const batch = await taskRepository.getBatch(batchId);
    if (batch?.status === "completed") break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const { versions: initialVersions } = await taskRepository.listTaskVersions(taskId);
  assert.equal(initialVersions.length, 1);
  const v1Id = initialVersions[0].id;

  const settings = {
    channels: [],
    preferences: { image: null, vision: null },
  };

  const vite = await createServer({
    cacheDir: "node_modules/.vite-browser-vector-overlay",
    configFile: false,
    server: { host: "127.0.0.1", port: 0 },
    esbuild: { jsx: "automatic" },
    plugins: [{
      name: "offline-vector-overlay-api",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const method = req.method ?? "GET";
          const path = req.url ?? "/";
          if (!path.startsWith("/api/")) return next();
          try {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const payload = Buffer.concat(chunks);
            const versionPreview = path.match(/^\/api\/suite-tasks\/([^/]+)\/versions\/([^/]+)\/preview$/);
            const inputPreview = path.match(/^\/api\/suites\/([^/]+)\/input-images\/([^/]+)\/preview\/(original|thumbnail)$/);
            let result;
            if (versionPreview) {
              result = await api.previewTaskVersion(versionPreview[1], versionPreview[2]);
            } else if (inputPreview) {
              result = await api.preview(inputPreview[1], inputPreview[2], inputPreview[3]);
            } else if (path === "/api/model-settings") {
              result = { status: 200, body: { data: settings } };
            } else {
              result = await api.request(method, path, {
                headers: req.headers,
                body: payload.length ? JSON.parse(payload.toString("utf8")) : undefined,
              });
            }
            res.writeHead(result.status, result.raw ? result.headers : { "Content-Type": "application/json" });
            res.end(result.raw ?? JSON.stringify(result.body));
          } catch (error) {
            res.writeHead(500);
            res.end(String(error));
          }
        });
      },
    }],
  });
  await vite.listen();
  const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
  t.after(async () => {
    await browser.close();
    await vite.close();
  });

  const url = vite.resolvedUrls.local[0];
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(10000);
  await page.route("**/*", (route) => (
    new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort()
  ));

  await page.goto(new URL(`/create/canvas/${suiteId}`, url).href);
  const vectorBtn = page.locator(".wb-card-vector-overlay").first();
  await vectorBtn.waitFor();
  await vectorBtn.click();

  const dialog = page.getByRole("dialog", { name: "卖点排版编辑器" });
  await dialog.waitFor();

  // Switch layout to left_pills_right_hero
  const layoutSelect = dialog.getByLabel("商业版式", { exact: true });
  await layoutSelect.selectOption("left_pills_right_hero");
  assert.equal(await layoutSelect.inputValue(), "left_pills_right_hero");

  // Switch theme to vibrant_promo
  const themeBtn = dialog.getByRole("button", { name: "活力暖橙" });
  await themeBtn.click();
  assert.equal(await themeBtn.getAttribute("aria-pressed"), "true");

  // Edit headline of first layer
  const headlineInput = dialog.getByLabel("元素主文案", { exact: true });
  await headlineInput.fill("超快氮化镓 65W");

  // Add a new pill element and edit its text
  await dialog.getByRole("button", { name: "＋ 卖点胶囊" }).click();
  await headlineInput.fill("三重温控不发烫");

  // Save composited version
  const [renderResp] = await Promise.all([
    page.waitForResponse((res) => new URL(res.url()).pathname === `/api/suite-tasks/${taskId}/vector-overlay/render`),
    dialog.getByRole("button", { name: "保存合成版本" }).click(),
  ]);
  assert.equal(renderResp.status(), 200);
  await dialog.waitFor({ state: "hidden" });

  // Verify v2 is now current on the card
  const versionSelect = page.getByLabel("选择氮化镓充电器卖点图版本");
  await versionSelect.waitFor();
  const selectedText = await versionSelect.locator("option:checked").textContent();
  assert.match(selectedText ?? "", /v2/);

  // Re-open vector editor and verify non-destructive restoration
  await vectorBtn.click();
  await dialog.waitFor();

  assert.equal(await layoutSelect.inputValue(), "left_pills_right_hero");
  assert.equal(await themeBtn.getAttribute("aria-pressed"), "true");

  const layerList = dialog.getByRole("listbox", { name: "矢量图层列表" });
  await layerList.getByText("超快氮化镓 65W").waitFor();
  await layerList.getByText("三重温控不发烫").waitFor();

  // Base image must still point to v1 (cleanBaseVersionId)
  const baseImgSrc = await dialog.locator(".vo-stage-canvas img").getAttribute("src");
  assert.ok(baseImgSrc && baseImgSrc.includes(`/versions/${v1Id}/preview`), `Expected clean v1 base image, got ${baseImgSrc}`);
  await dialog.getByText(/底图基于 v1/).waitFor();
});
