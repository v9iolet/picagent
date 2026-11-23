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

async function offlineAssetsApp(t) {
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
    createdAt: "2026-11-23T08:00:00.000Z",
    updatedAt: "2026-11-23T08:00:00.000Z",
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
    createdAt: "2026-11-23T09:00:00.000Z",
    updatedAt: "2026-11-23T09:00:00.000Z",
  });
  libraryRepository.addResource({
    id: "input:lib-c",
    resourceType: "input_image",
    title: "保留商品原图 C",
    summary: "1024 × 1024",
    mimeType: "image/jpeg",
    previewUrl: "/api/library/resources/input%3Alib-c/preview",
    suiteId: null,
    taskId: null,
    imageVersionId: null,
    baseVersionId: null,
    templateVersionId: null,
    resourceVersionId: "ver-c",
    stage: null,
    source: { objectKey: "lib/input-c.jpg" },
    status: "published",
    createdAt: "2026-11-23T10:00:00.000Z",
    updatedAt: "2026-11-23T10:00:00.000Z",
  });

  // Create a canvas suite with a custom task so we can open canvas ProductResourcePickerModal
  const canvasSuite = await repository.createSuite("画布选图验证", undefined, "canvas");
  await taskRepository.createCustomTask({
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
    preferences: { image: { channelId: "offline", modelId: "gpt-image-2" }, vision: null },
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
  return { url, page, canvasSuite };
}

test("图片资源库：多选批量删除与详情单个删除后，列表与画布/复刻资源选择弹窗同步移除且预览不断链", async (t) => {
  const { url, page, canvasSuite } = await offlineAssetsApp(t);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  // 1. Open /assets and verify initial 3 items
  await page.goto(url + "assets");
  await page.locator(".style-card").first().waitFor();
  assert.equal(await page.locator(".style-card").count(), 3);
  await page.getByText("当前共 3 项").waitFor();

  // 2. Test "全选当前页" toggle on & off, then check two specific cards for batch delete
  const selectAll = page.getByLabel("全选当前页");
  await selectAll.check();
  await page.getByText("已选 3 / 3 项").waitFor();
  await selectAll.uncheck();
  await page.getByText("当前共 3 项").waitFor();

  await page.getByLabel("选择 可删除白底图 A").check();
  await page.getByLabel("选择 可删除白底图 B").check();
  await page.getByText("已选 2 / 3 项").waitFor();

  // Click batch delete and verify confirmation modal text
  await page.getByRole("button", { name: "批量删除 (2)" }).click();
  const confirmDialog = page.getByRole("dialog");
  await confirmDialog.waitFor();
  const dialogText = await confirmDialog.innerText();
  assert.match(dialogText, /删除后不会影响已生成的任务和历史记录/);

  await confirmDialog.getByRole("button", { name: "确认删除" }).click();
  await page.getByText("已删除 2 张图片").waitFor();

  // List & count refresh immediately: only "保留商品原图 C" remains
  assert.equal(await page.locator(".style-card").count(), 1);
  await page.getByText("当前共 1 项").waitFor();
  assert.equal(await page.locator(".style-card", { hasText: "保留商品原图 C" }).count(), 1);
  assert.equal(await page.locator(".style-card", { hasText: "可删除白底图 A" }).count(), 0);
  assert.equal(await page.locator(".style-card", { hasText: "可删除白底图 B" }).count(), 0);

  // Deleted image preview endpoint still responds 200 for frozen references
  const previewRes = await page.request.get(url + "api/library/resources/base%3Alib-a/preview");
  assert.equal(previewRes.status(), 200);

  // 3. Verify Replica Studio ProductResourcePickerModal does not show deleted items
  await page.goto(url + "create/replica");
  await page.getByRole("button", { name: /资源库选择/ }).click();
  const replicaPicker = page.getByRole("dialog");
  await replicaPicker.getByText("保留商品原图 C").waitFor();
  assert.equal(await replicaPicker.getByText("可删除白底图 A").count(), 0);
  assert.equal(await replicaPicker.getByText("可删除白底图 B").count(), 0);
  await replicaPicker.getByRole("button", { name: "取消" }).click();

  // 4. Verify Canvas ProductResourcePickerModal does not show deleted items
  await page.goto(url + `create/canvas/${canvasSuite.id}`);
  await page.getByRole("button", { name: "从图片库选择" }).click();
  const canvasPicker = page.getByRole("dialog", { name: "选择图片库参考图" });
  await canvasPicker.getByText("保留商品原图 C").waitFor();
  assert.equal(await canvasPicker.getByText("可删除白底图 A").count(), 0);
  assert.equal(await canvasPicker.getByText("可删除白底图 B").count(), 0);
  await canvasPicker.getByRole("button", { name: "取消" }).click();

  // 5. Return to /assets and test single delete from right detail panel
  await page.goto(url + "assets");
  await page.locator(".style-card", { hasText: "保留商品原图 C" }).click();
  await page.getByRole("button", { name: "删除图片" }).click();
  const singleConfirm = page.getByRole("dialog");
  await singleConfirm.waitFor();
  assert.match(await singleConfirm.innerText(), /删除后不会影响已生成的任务和历史记录/);
  await singleConfirm.getByRole("button", { name: "确认删除" }).click();
  await page.getByText("图片已从资源库删除").waitFor();

  assert.equal(await page.locator(".style-card").count(), 0);
  await page.getByText("当前共 0 项").waitFor();
  await page.getByText("没有匹配的图片资产").waitFor();

  assert.deepEqual(errors, [], `Unexpected page errors: ${errors.join("; ")}`);
});
