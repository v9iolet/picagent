// Run with: npx tsx --test tests/browser-library-delete.mjs (offline, no DB or external API calls).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";
import { createSuiteStudioApp } from "../server/app.js";
import { parseNormalizedPromptMarkdown } from "../server/prompt-library.js";
import { MemoryLibraryRepository } from "../server/repositories/memory-library-repository.js";
import { MemoryPipelineRepository } from "../server/repositories/memory-pipeline-repository.js";
import { MemoryPromptRepository } from "../server/repositories/memory-prompt-repository.js";
import { MemoryReplicaRepository } from "../server/repositories/memory-replica-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryTaskRepository } from "../server/repositories/memory-task-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";

async function offlineAssetsApp(t, { extraImages = 0 } = {}) {
  const sampleProduct = await readFile("public/assets/gan65-product.jpg");
  const sampleResult = await readFile("public/assets/tokyo-desk-v3.jpg");

  const repository = new MemorySuiteRepository();
  const taskRepository = new MemoryTaskRepository();
  const libraryRepository = new MemoryLibraryRepository();
  const promptRepository = new MemoryPromptRepository();
  const pipelineRepository = new MemoryPipelineRepository();
  const replicaRepository = new MemoryReplicaRepository();
  const storage = new MemoryStorage();

  for (const rel of ["prompt/normalized/replica-compose.md", "prompt/normalized/replica-high.md"]) {
    const md = await readFile(rel, "utf8");
    const [draft] = await promptRepository.importRecords([parseNormalizedPromptMarkdown(md, rel)]);
    await promptRepository.publishVersion(draft.templateVersionId);
    libraryRepository.addResource({
      id: `prompt:${draft.templateVersionId}`,
      resourceType: "prompt_template",
      title: draft.name,
      summary: "模板不应计入图片分页",
      mimeType: null,
      previewUrl: null,
      suiteId: null,
      taskId: null,
      imageVersionId: null,
      baseVersionId: null,
      templateVersionId: draft.templateVersionId,
      resourceVersionId: draft.templateVersionId,
      stage: draft.stage,
      source: { code: draft.code, versionNo: draft.versionNo, body: "模板正文" },
      status: "published",
      createdAt: "2026-11-23T12:00:00.000Z",
      updatedAt: "2026-11-23T12:00:00.000Z",
    });
  }

  await storage.put({ key: "lib/base-a.jpg", bytes: sampleProduct, contentType: "image/jpeg" });
  await storage.put({ key: "lib/base-b.jpg", bytes: sampleResult, contentType: "image/jpeg" });
  await storage.put({ key: "lib/input-c.jpg", bytes: sampleProduct, contentType: "image/jpeg" });

  libraryRepository.addResource({
    id: "base:lib-a",
    resourceType: "base_image",
    title: "可删除白底图 A",
    summary: "1024 × 1024",
    mimeType: "image/jpeg",
    previewUrl: "/api/library/resources/base%3Alib-a/preview",
    suiteId: null,
    taskId: null,
    imageVersionId: null,
    baseVersionId: "bv-a",
    templateVersionId: null,
    resourceVersionId: "ver-a",
    stage: null,
    source: { objectKey: "lib/base-a.jpg" },
    status: "published",
    createdAt: "2026-11-23T11:50:00.000Z",
    updatedAt: "2026-11-23T11:50:00.000Z",
  });
  libraryRepository.addResource({
    id: "base:lib-b",
    resourceType: "base_image",
    title: "可删除白底图 B",
    summary: "1024 × 1024",
    mimeType: "image/jpeg",
    previewUrl: "/api/library/resources/base%3Alib-b/preview",
    suiteId: null,
    taskId: null,
    imageVersionId: null,
    baseVersionId: "bv-b",
    templateVersionId: null,
    resourceVersionId: "ver-b",
    stage: null,
    source: { objectKey: "lib/base-b.jpg" },
    status: "published",
    createdAt: "2026-11-23T11:40:00.000Z",
    updatedAt: "2026-11-23T11:40:00.000Z",
  });
  libraryRepository.addResource({
    id: "base:lib-c",
    resourceType: "base_image",
    title: "保留白底图 C",
    summary: "1024 × 1024",
    mimeType: "image/jpeg",
    previewUrl: "/api/library/resources/base%3Alib-c/preview",
    suiteId: null,
    taskId: null,
    imageVersionId: null,
    baseVersionId: "bv-c",
    templateVersionId: null,
    resourceVersionId: "ver-c",
    stage: null,
    source: { objectKey: "lib/input-c.jpg" },
    status: "published",
    createdAt: "2026-11-23T11:30:00.000Z",
    updatedAt: "2026-11-23T11:30:00.000Z",
  });
  // Uploaded input_image must never be exposed in /assets or canvas resource picker
  libraryRepository.addResource({
    id: "input:hidden-orig",
    resourceType: "input_image",
    title: "不应展示的实拍原图",
    summary: "1024 × 1024",
    mimeType: "image/jpeg",
    previewUrl: "/api/library/resources/input%3Ahidden-orig/preview",
    suiteId: null,
    taskId: null,
    imageVersionId: null,
    baseVersionId: null,
    templateVersionId: null,
    resourceVersionId: "ver-hidden",
    stage: null,
    source: { objectKey: "lib/input-c.jpg" },
    status: "published",
    createdAt: "2026-11-23T11:55:00.000Z",
    updatedAt: "2026-11-23T11:55:00.000Z",
  });

  for (let i = 1; i <= extraImages; i++) {
    const id = `task-version:extra-${String(i).padStart(2, "0")}`;
    const min = String(Math.floor(i / 60)).padStart(2, "0");
    const sec = String(i % 60).padStart(2, "0");
    libraryRepository.addResource({
      id,
      resourceType: "task_image_version",
      title: `分页图片 ${String(i).padStart(2, "0")}`,
      summary: "1024 × 1024",
      mimeType: "image/jpeg",
      previewUrl: `/api/library/resources/${encodeURIComponent(id)}/preview`,
      suiteId: null,
      taskId: null,
      imageVersionId: `ver-extra-${i}`,
      baseVersionId: null,
      templateVersionId: null,
      resourceVersionId: `ver-extra-${i}`,
      stage: "task_image",
      source: { objectKey: "lib/input-c.jpg" },
      status: "published",
      createdAt: `2026-11-23T08:${min}:${sec}.000Z`,
      updatedAt: `2026-11-23T08:${min}:${sec}.000Z`,
    });
  }

  const canvasSuite = await repository.createSuite("画布选图验证", undefined, "canvas");
  const { task: canvasTask } = await taskRepository.createCustomTask({
    suiteId: canvasSuite.id,
    planSnapshotId: null,
    imageType: "main",
    title: "画布主图卡",
    purpose: "主图",
    promptDraft: "商品主图展示",
    sourceInputImageId: null,
    generationParams: { size: "1K", ratio: "1:1" },
  });

  const api = createSuiteStudioApp({
    repository,
    taskRepository,
    libraryRepository,
    promptRepository,
    pipelineRepository,
    replicaRepository,
    storage,
    imageRetryDelayMs: 0,
    llmClient: {
      provider: "offline-vision",
      model: "qwen-vl",
      isFake: true,
      async generatePlan() { return {}; },
      async generateReplicaPrompts(input) {
        return {
          schemaVersion: "replica-prompt-v1",
          taskName: "复刻验证",
          sharedStyle: null,
          items: input.references.map((ref) => ({
            referenceId: ref.referenceId,
            visualStructure: { layout: "居中构图" },
            copy: [],
            prompt: "生成同款电商主图",
          })),
        };
      },
    },
    provider: {
      supportsMultipleImages: true,
      async edit() {
        return { bytes: sampleResult, mimeType: "image/jpeg" };
      },
    },
  });

  const settings = {
    channels: [{
      id: "offline",
      name: "离线测试",
      models: [{
        id: "gpt-image-2",
        capabilities: ["image"],
        imageOptions: { sizes: ["1K", "2K"], aspectRatios: ["1:1", "3:4"], sizeMode: "pixels" },
      }],
    }],
    preferences: { image: { channelId: "offline", modelId: "gpt-image-2" }, vision: null, video: null },
  };

  const vite = await createServer({
    cacheDir: "node_modules/.vite-browser-library-delete",
    configFile: false,
    server: { host: "127.0.0.1", port: 0 },
    esbuild: { jsx: "automatic" },
    plugins: [{
      name: "offline-library-delete-api",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const method = req.method;
          const reqPath = req.url ?? "/";
          if (!reqPath.startsWith("/api/")) return next();
          try {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const payload = Buffer.concat(chunks);
            let result;
            if (reqPath === "/api/model-settings") {
              result = { status: 200, body: { data: settings } };
            } else {
              result = await api.request(method, reqPath, {
                headers: req.headers,
                body: payload.length ? JSON.parse(payload.toString()) : undefined,
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(8000);
  await page.route("**/*", (route) => (new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort()));
  return { api, url, page, canvasSuite, canvasTask };
}

test("图片资源库：超过 24 张图片分页翻页批量删除、真实 total 统计与资产类型后端筛选", async (t) => {
  // 3 base/input + 24 extra = 27 image assets (+ 2 prompt_template that must be excluded)
  const { url, page } = await offlineAssetsApp(t, { extraImages: 24 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(url + "assets");
  await page.locator(".style-card").first().waitFor();
  assert.equal(await page.getByRole("radio", { name: "全部生成图", exact: true }).count(), 1);
  assert.equal(await page.getByRole("radio", { name: "商品实拍原图", exact: true }).count(), 0);
  assert.equal(await page.locator(".style-card", { hasText: "不应展示的实拍原图" }).count(), 0);
  assert.equal(await page.locator(".style-card").count(), 24);
  await page.getByText("第 1 / 2 页 · 共 27 项").waitFor();
  await page.getByText("当前共 27 项").waitFor();

  // Navigate to page 2 -> 3 items visible (extra-03, extra-02, extra-01)
  await page.getByRole("button", { name: "下一页" }).click();
  await page.getByText("第 2 / 2 页 · 共 27 项").waitFor();
  await page.locator(".style-card", { hasText: "分页图片 01" }).waitFor();
  assert.equal(await page.locator(".style-card").count(), 3);

  // Select 2 items on page 2 and batch delete
  await page.getByLabel("选择 分页图片 01").check();
  await page.getByLabel("选择 分页图片 02").check();
  await page.getByRole("button", { name: "批量删除 (2)" }).click();
  const confirm = page.getByRole("dialog");
  await confirm.waitFor();
  assert.match(await confirm.innerText(), /删除后不会影响已生成的任务和历史记录/);
  await confirm.getByRole("button", { name: "确认删除" }).click();
  await page.getByText("已删除 2 张图片").waitFor();

  // Still on page 2 with 1 remaining item and updated total = 25
  await page.getByText("第 2 / 2 页 · 共 25 项").waitFor();
  await page.locator(".style-card", { hasText: "分页图片 03" }).waitFor();
  assert.equal(await page.locator(".style-card").count(), 1);

  // Select-all current page (the last 1 item on page 2) and delete -> auto-fallback to page 1 (24 items)
  await page.getByLabel("全选当前页").check();
  await page.getByRole("button", { name: "批量删除 (1)" }).click();
  const confirmLast = page.getByRole("dialog");
  await confirmLast.waitFor();
  await confirmLast.getByRole("button", { name: "确认删除" }).click();
  await page.getByText("已删除 1 张图片").waitFor();
  await page.getByText("第 1 / 1 页 · 共 24 项").waitFor();
  await page.locator(".style-card", { hasText: "可删除白底图 A" }).waitFor();
  assert.equal(await page.locator(".style-card").count(), 24);

  // Filter by resourceType=base_image -> server returns only the 3 base images (lib-a, lib-b, lib-c)
  await page.getByRole("radio", { name: "白底底图", exact: true }).check();
  await page.getByText("第 1 / 1 页 · 共 3 项").waitFor();
  await page.locator(".style-card", { hasText: "可删除白底图 A" }).waitFor();
  assert.equal(await page.locator(".style-card").count(), 3);

  assert.deepEqual(errors, [], `Unexpected page errors: ${errors.join("; ")}`);
});

test("画布已绑资源软删除后：节点预览正常、选择器仅展示白底底图并剔除已删项；复刻配置栏不再提供资源库选图入口", async (t) => {
  const { api, url, page, canvasSuite, canvasTask } = await offlineAssetsApp(t);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  // 1. Bind base:lib-a to canvas task BEFORE deleting it
  const bindRes = await api.request("POST", `/api/suite-tasks/${canvasTask.id}/white-resource`, {
    headers: { "idempotency-key": "canvas-bind-lib-a" },
    body: { resourceIds: ["base:lib-a"] },
  });
  assert.equal(bindRes.status, 201);

  // 2. Delete base:lib-a from /assets detail panel
  await page.goto(url + "assets");
  await page.locator(".style-card", { hasText: "可删除白底图 A" }).click();
  await page.getByRole("button", { name: "删除图片" }).click();
  const singleConfirm = page.getByRole("dialog");
  await singleConfirm.waitFor();
  assert.match(await singleConfirm.innerText(), /删除后不会影响已生成的任务和历史记录/);
  await singleConfirm.getByRole("button", { name: "确认删除" }).click();
  await page.getByText("图片已从资源库删除").waitFor();

  // 3. Open canvas -> frozen reference preview still responds 200 & node image loads cleanly
  const previewCheck = await page.request.get(url + "api/library/resources/base%3Alib-a/preview");
  assert.equal(previewCheck.status(), 200);

  await page.goto(url + `create/canvas/${canvasSuite.id}`);
  await page.getByRole("button", { name: "从图片库选择" }).waitFor();
  // Verify the canvas node referencing the deleted image still renders an intact preview image
  const nodeImg = page.locator('img[src*="/api/library/resources/base%3Alib-a/preview"]').first();
  await nodeImg.waitFor();
  const imgComplete = await nodeImg.evaluate((el) => el.complete && el.naturalWidth > 0);
  assert.equal(imgComplete, true, "Frozen canvas reference preview image must remain viewable after library deletion");

  // 4. Open ProductResourcePickerModal -> deleted item automatically removed with notice, input_image hidden, rebinding succeeds!
  await page.getByRole("button", { name: "从图片库选择" }).click();
  const canvasPicker = page.getByRole("dialog", { name: "选择图片库参考图" });
  await canvasPicker.getByText("已移除 1 张已删除的图片").waitFor();
  assert.equal(await canvasPicker.getByText("可删除白底图 A").count(), 0);
  assert.equal(await canvasPicker.getByText("不应展示的实拍原图").count(), 0);

  // Select two base_image items, test explicit "移除" button on order list, then confirm rebind with 保留白底图 C
  await canvasPicker.getByRole("button", { name: /可删除白底图 B/ }).click();
  await canvasPicker.getByRole("button", { name: /保留白底图 C/ }).click();
  const orderSection = canvasPicker.locator(".rp-picker-order");
  await orderSection.getByText("1. 可删除白底图 B").waitFor();
  await orderSection.getByRole("button", { name: "移除" }).first().click();
  assert.equal(await orderSection.getByText("可删除白底图 B").count(), 0);
  await orderSection.getByText("1. 保留白底图 C").waitFor();

  const rebindReq = page.waitForResponse(
    (res) => res.request().method() === "POST" && res.url().endsWith(`/api/suite-tasks/${canvasTask.id}/white-resource`),
  );
  await canvasPicker.getByRole("button", { name: "确认绑定" }).click();
  const rebindHttp = await rebindReq;
  assert.ok(rebindHttp.status() === 200 || rebindHttp.status() === 201, `Expected rebind 200/201, got ${rebindHttp.status()}`);
  await page.getByRole("status").filter({ hasText: "已绑定图片库参考图" }).waitFor();

  // 5. Replica studio: no "从资源库选择" button; local upload product + submit succeeds with 201
  await page.goto(url + "create/replica");
  assert.equal(await page.getByRole("button", { name: /资源库选择/ }).count(), 0);
  await page.getByLabel("上传参考图", { exact: true }).setInputFiles("public/assets/gan65-product.jpg");
  await page.getByLabel("上传产品原图", { exact: true }).setInputFiles("public/assets/tokyo-desk-v3.jpg");

  const createReq = page.waitForResponse(
    (res) => res.request().method() === "POST" && res.url().endsWith("/api/replicas"),
  );
  await page.getByRole("button", { name: "一键复刻（1张）", exact: true }).click();
  const createRes = await createReq;
  assert.equal(createRes.status(), 201, `Expected replica submit 201, got ${createRes.status()}`);
  await page.waitForURL(/\/create\/replica\?suite=[^&]+/);

  assert.deepEqual(errors, [], `Unexpected page errors: ${errors.join("; ")}`);
});

test("复刻结果区删除一张单卡后：/assets 中该卡生成图消失，剩余单卡图片仍可见", async (t) => {
  const { url, page } = await offlineAssetsApp(t);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(url + "create/replica");
  await page.getByLabel("上传参考图", { exact: true }).setInputFiles([
    "public/assets/gan65-product.jpg",
    "public/assets/tokyo-desk-v3.jpg",
  ]);
  await page.getByRole("button", { name: "一键复刻（2张）", exact: true }).click();
  await page.waitForURL(/\/create\/replica\?suite=[^&]+/);

  const batch = page.getByRole("region", { name: "复刻批次" });
  await batch.locator('[data-status="completed"]').waitFor({ timeout: 10000 });
  const cards = batch.locator("[data-replica-card]");
  assert.equal(await cards.count(), 2);

  // Confirm both replica task versions appear in /assets under AI 生成结果
  await page.goto(url + "assets");
  await page.getByRole("radio", { name: "AI 生成结果", exact: true }).check();
  await page.getByText("第 1 / 1 页 · 共 2 项").waitFor();

  // Navigate back to replica batch and delete the second card via UI
  await page.goBack();
  await batch.locator("[data-replica-card]").nth(1).waitFor();
  const secondCard = batch.locator("[data-replica-card]").nth(1);
  await secondCard.getByRole("button", { name: /更多操作/ }).click();
  await secondCard.getByRole("menuitem", { name: "删除", exact: true }).click();
  const deleteDialog = page.getByRole("dialog", { name: "删除复刻卡片" });
  await deleteDialog.waitFor();
  await deleteDialog.getByRole("button", { name: "确认删除", exact: true }).click();
  await deleteDialog.waitFor({ state: "hidden" });
  assert.equal(await batch.locator("[data-replica-card]").count(), 1);

  // Open /assets again -> archived replica card's image disappears, total drops from 2 to 1
  await page.goto(url + "assets");
  await page.getByRole("radio", { name: "AI 生成结果", exact: true }).check();
  await page.getByText("第 1 / 1 页 · 共 1 项").waitFor();
  assert.equal(await page.locator(".style-card").count(), 1);

  assert.deepEqual(errors, [], `Unexpected page errors: ${errors.join("; ")}`);
});
