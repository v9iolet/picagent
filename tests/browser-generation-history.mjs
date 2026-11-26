// Run with: npx tsx --test tests/browser-generation-history.mjs (offline, in-memory only)
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";
import { createSuiteStudioApp } from "../server/app.js";
import { MemoryPipelineRepository } from "../server/repositories/memory-pipeline-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryTaskRepository } from "../server/repositories/memory-task-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";

const PHOTO_PATH = "public/assets/gan65-product.jpg";

async function offlineHistoryFixture(t, { interceptApi } = {}) {
  const sample = await readFile(PHOTO_PATH);
  const repository = new MemorySuiteRepository();
  const taskRepository = new MemoryTaskRepository();
  const pipelineRepository = new MemoryPipelineRepository();
  const storage = new MemoryStorage();

  const platforms = [
    {
      code: "amazon",
      name: "Amazon",
      marketScope: "overseas",
      mainImageBackground: "pure_white_required",
      mainImageStrategy: "",
      galleryStrategy: "",
      textStrategy: "",
      modelStrategy: "",
      sourceNote: "",
      sortOrder: 1,
    },
    {
      code: "taobao",
      name: "淘宝",
      marketScope: "domestic",
      mainImageBackground: "flexible",
      mainImageStrategy: "",
      galleryStrategy: "",
      textStrategy: "",
      modelStrategy: "",
      sourceNote: "",
      sortOrder: 2,
    },
  ];

  const app = createSuiteStudioApp({
    repository,
    taskRepository,
    pipelineRepository,
    storage,
    platformRepository: {
      listEnabled: async () => platforms,
      find: async (code) => platforms.find((p) => p.code === code) ?? null,
    },
  });

  const calls = [];
  const vite = await createServer({
    cacheDir: "node_modules/.vite-browser-generation-history",
    configFile: false,
    server: { host: "127.0.0.1", port: 0 },
    esbuild: { jsx: "automatic" },
    plugins: [
      {
        name: "offline-generation-history-api",
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            const path = req.url ?? "/";
            if (!path.startsWith("/api/")) return next();
            try {
              const chunks = [];
              for await (const chunk of req) chunks.push(chunk);
              const buf = Buffer.concat(chunks);
              const versionPreview = path.match(/^\/api\/suite-tasks\/([^/]+)\/versions\/([^/]+)\/preview$/);
              const inputPreview = path.match(
                /^\/api\/suites\/([^/]+)\/input-images\/([^/]+)\/preview\/(original|thumbnail)$/,
              );
              let response;
              if (versionPreview) {
                response = await app.previewTaskVersion(versionPreview[1], versionPreview[2]);
              } else if (inputPreview) {
                response = await app.preview(inputPreview[1], inputPreview[2], inputPreview[3]);
              } else {
                const body = buf.length ? JSON.parse(buf.toString()) : undefined;
                calls.push({ method: req.method, path, body });
                const execute = async () =>
                  path === "/api/model-settings"
                    ? { status: 200, body: { data: { channels: [], preferences: { image: null, vision: null, video: null } } } }
                    : app.request(req.method, path, { headers: req.headers, body });
                response = interceptApi ? await interceptApi({ method: req.method, path, body, next: execute }) : await execute();
              }
              res.writeHead(
                response.status,
                response.raw ? response.headers : { "Content-Type": "application/json" },
              );
              res.end(response.raw ?? JSON.stringify(response.body));
            } catch (error) {
              res.writeHead(500);
              res.end(String(error));
            }
          });
        },
      },
    ],
  });

  await vite.listen();
  t.after(() => vite.close());
  const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  page.setDefaultTimeout(10000);
  const url = vite.resolvedUrls.local[0];
  await page.route("**/*", (route) => (route.request().url().startsWith(url) ? route.continue() : route.abort()));

  async function seedSuite({
    name,
    origin = "suite_studio",
    createdAt,
    status = "completed",
    currentPhase = "done",
    platform = "amazon",
    cardCount = 1,
    renderedImageCount = cardCount,
  }) {
    const suite = await repository.createSuite(name, undefined, origin);
    suite.createdAt = createdAt;
    suite.updatedAt = createdAt;
    await pipelineRepository.createRun({
      id: randomUUID(),
      suiteId: suite.id,
      idempotencyKey: `run-${randomUUID()}`,
      status,
      currentPhase,
      config: { platform, mode: "custom", counts: { main: 1, selling_points: 0, lifestyle: 0, other: 0 } },
      errorCode: status === "failed" ? "IMAGE_GENERATION_FAILED" : null,
      errorMessage: status === "failed" ? "生图失败" : null,
      createdAt,
      updatedAt: createdAt,
      completedAt: status === "running" ? null : createdAt,
    });

    for (let i = 1; i <= cardCount; i += 1) {
      const { task } = await taskRepository.createCustomTask({
        suiteId: suite.id,
        planSnapshotId: null,
        imageType: i === 1 ? "main" : "detail",
        title: `${name}-图${i}`,
        purpose: "展示",
        promptDraft: "展示商品",
        sourceInputImageId: null,
        generationParams: {},
      });
      if (i <= renderedImageCount) {
        const objectKey = `history/${suite.id}/task-${i}.jpg`;
        await storage.put({ key: objectKey, bytes: sample, contentType: "image/jpeg" });
        const batchId = randomUUID();
        const slotId = randomUUID();
        const attemptId = randomUUID();
        await taskRepository.beginBatch({
          batch: {
            id: batchId,
            suiteId: suite.id,
            kind: "single",
            requestedCount: 1,
            taskIds: [task.id],
            status: "running",
            idempotencyKey: `batch-${suite.id}-${i}`,
            createdAt,
            startedAt: createdAt,
            finishedAt: null,
          },
          slots: [
            {
              id: slotId,
              batchId,
              taskId: task.id,
              slotOrdinal: 1,
              retryOfSlotId: null,
              status: "generating",
              selectedVersionId: null,
              createdAt,
              completedAt: null,
            },
          ],
          attempts: [
            {
              id: attemptId,
              slotId,
              attemptNo: 1,
              provider: "fake",
              model: "offline",
              endpoint: "/v1/images/edits",
              requestSummary: {},
              promptSnapshot: {},
              promptSha256: "sha",
              contextSnapshot: {},
              sourceKind: "original",
              sourceObjectKey: objectKey,
              sourceInputImageId: null,
              sourceBaseVersionId: null,
              status: "running",
              errorCode: null,
              errorMessage: null,
              externalRequestId: null,
              startedAt: createdAt,
              finishedAt: null,
            },
          ],
        });
        await taskRepository.completeAttempt({
          attemptId,
          slotId,
          taskId: task.id,
          objectKey,
          processObjectKeys: [],
          sha256: `sha-${suite.id}-${i}`,
          width: 64,
          height: 64,
          mimeType: "image/jpeg",
          completedAt: createdAt,
        });
      }
    }
    return suite;
  }

  return { app, calls, page, url, pipelineRepository, seedSuite };
}

test("无历史批次时结果区仍显示生成记录入口且抽屉呈现空态", async (t) => {
  const { page, url } = await offlineHistoryFixture(t);
  await page.goto(url + "create/suite");
  await page.getByRole("heading", { name: "AI 商品套图", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "＋ 新建套图", exact: true }).count(), 0);

  await page.getByRole("button", { name: "生成记录", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "生成记录" });
  await drawer.waitFor({ state: "visible" });
  await drawer.getByText("暂无生成记录", { exact: true }).waitFor();
  await drawer.getByRole("button", { name: "关闭", exact: true }).click();
  await drawer.waitFor({ state: "hidden" });
});

test("生成记录抽屉：单批次首屏、4 图拼图、20 条滚动分页、关键词搜索、错误重试、切换运行中批次与新建清空", async (t) => {
  let failNextFeed = false;
  const { calls, page, url, pipelineRepository, seedSuite } = await offlineHistoryFixture(t, {
    interceptApi: async ({ method, path, next }) => {
      if (method === "GET" && path.startsWith("/api/suites/feed") && failNextFeed) {
        failNextFeed = false;
        return { status: 500, body: { error: { code: "INTERNAL_ERROR", message: "历史服务临时异常" } } };
      }
      return next();
    },
  });

  // Seed 23 suite_studio batches + 1 replica batch (must be filtered out).
  const seeded = [];
  for (let i = 1; i <= 20; i += 1) {
    const day = String(i).padStart(2, "0");
    seeded.push(
      await seedSuite({
        name: `套图历史-${String(i).padStart(2, "0")}`,
        createdAt: `2026-10-${day}T10:00:00.000Z`,
        platform: i % 2 === 0 ? "taobao" : "amazon",
        cardCount: i === 20 ? 5 : 2,
      }),
    );
  }
  const pausedBatch = await seedSuite({
    name: "咖啡机暂停批次",
    createdAt: "2026-10-21T10:00:00.000Z",
    status: "waiting_human_input",
    currentPhase: "structure_planning",
    platform: "amazon",
    cardCount: 0,
  });
  const runningBatch = await seedSuite({
    name: "降噪耳机运行中批次",
    createdAt: "2026-10-22T10:00:00.000Z",
    status: "running",
    currentPhase: "image_generating",
    platform: "taobao",
    cardCount: 2,
    renderedImageCount: 1,
  });
  const latestBatch = await seedSuite({
    name: "氮化镓充电器最新批次",
    createdAt: "2026-10-23T10:00:00.000Z",
    status: "completed",
    currentPhase: "done",
    platform: "amazon",
    cardCount: 5,
    renderedImageCount: 5,
  });
  await seedSuite({
    name: "复刻隔离批次",
    origin: "replica",
    createdAt: "2026-10-24T10:00:00.000Z",
    status: "completed",
    currentPhase: "done",
    cardCount: 3,
  });

  // 1. Cold entry with completed latest batch displays empty showcase state (does not auto-mount historical completed batch).
  await page.goto(url + "create/suite");
  const batchRegion = page.getByRole("region", { name: "生成批次" });
  await page.getByRole("heading", { name: "AI 商品套图", exact: true }).waitFor();
  assert.equal(await batchRegion.count(), 0);
  assert.equal(await page.getByRole("button", { name: "加载更多历史批次" }).count(), 0);
  assert.ok(
    calls.some((c) => c.method === "GET" && c.path.includes("/api/suites/feed?") && c.path.includes("limit=1")),
    "首屏应调用 feed limit=1 检查是否存在运行中批次",
  );

  // 2. Error + retry on initial drawer open.
  const historyBtn = page.getByRole("button", { name: "生成记录", exact: true });
  failNextFeed = true;
  await historyBtn.click();
  const drawer = page.getByRole("dialog", { name: "生成记录" });
  await drawer.waitFor({ state: "visible" });
  await drawer.getByText("历史服务临时异常", { exact: true }).waitFor();
  await drawer.getByRole("button", { name: "重试", exact: true }).click();

  // 3. First page loads 20 items, renders 4-thumb collage, statuses, platform meta, excludes replica.
  await drawer.getByText("共 23 条", { exact: true }).waitFor();
  assert.equal(await drawer.locator("[data-history-item]").count(), 20);
  assert.equal(await drawer.getByText("复刻隔离批次").count(), 0);

  const latestItem = drawer.locator(`[data-history-item="${latestBatch.id}"]`);
  assert.equal(await latestItem.locator(".gh-collage img").count(), 4, "5 张卡批次应最多展示 4 张缩略图拼图");
  assert.match(await latestItem.innerText(), /Amazon/);
  assert.match(await latestItem.innerText(), /5 张/);
  assert.match(await latestItem.innerText(), /完成/);

  const runningItem = drawer.locator(`[data-history-item="${runningBatch.id}"]`);
  assert.match(await runningItem.innerText(), /运行中/);
  assert.match(await runningItem.innerText(), /淘宝/);

  const pausedItem = drawer.locator(`[data-history-item="${pausedBatch.id}"]`);
  assert.match(await pausedItem.innerText(), /暂停/);

  // Selecting latestBatch mounts it, verifies button ordering, and highlights currentSuiteId in drawer.
  await latestItem.click();
  await drawer.waitFor({ state: "hidden" });
  await page.waitForURL(`**/create/suite/${latestBatch.id}`);
  await batchRegion.getByRole("heading", { name: latestBatch.name, exact: true }).waitFor();
  const newBtn = page.getByRole("button", { name: "＋ 新建套图", exact: true });
  const [historyBox, newBox] = await Promise.all([historyBtn.boundingBox(), newBtn.boundingBox()]);
  assert.ok(historyBox && newBox && historyBox.x < newBox.x, "「生成记录」应在「＋ 新建套图」左侧");

  await historyBtn.click();
  await drawer.waitFor({ state: "visible" });
  await drawer.getByText("共 23 条", { exact: true }).waitFor();
  assert.equal(
    await drawer.locator(`[data-history-item="${latestBatch.id}"]`).getAttribute("data-current"),
    "true",
  );

  // 4. Scroll drawer body to trigger IntersectionObserver and load page 2 (remaining 3 items).
  await drawer.locator(".gh-body").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForFunction(
    () => document.querySelectorAll("dialog.gh-drawer [data-history-item]").length === 23,
    undefined,
    { timeout: 8000 },
  );
  await drawer.getByText("已显示全部记录", { exact: true }).waitFor();

  // 5. Keyword search (debounced) + clear search.
  const searchInput = drawer.getByRole("searchbox", { name: "搜索生成记录" });
  await searchInput.fill("套图历史-01");
  await page.waitForFunction(
    () => document.querySelectorAll("dialog.gh-drawer [data-history-item]").length === 1,
    undefined,
    { timeout: 5000 },
  );
  await drawer.getByText("套图历史-01", { exact: true }).waitFor();
  await drawer.getByRole("button", { name: "清空", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll("dialog.gh-drawer [data-history-item]").length === 20,
    undefined,
    { timeout: 5000 },
  );

  // 6. Select running batch -> replaces results area and continues polling until completed.
  await runningItem.click();
  await drawer.waitFor({ state: "hidden" });
  await page.waitForURL(`**/create/suite/${runningBatch.id}`);
  await batchRegion.getByRole("heading", { name: runningBatch.name, exact: true }).waitFor();
  await batchRegion.locator('[data-status="running"]').waitFor();

  const runningPipeline = await pipelineRepository.getLatestRun(runningBatch.id);
  await pipelineRepository.updateRun(runningPipeline.id, {
    status: "completed",
    currentPhase: "done",
    completedAt: "2026-10-22T10:05:00.000Z",
    updatedAt: "2026-10-22T10:05:00.000Z",
  });
  await batchRegion.locator('[data-status="completed"]').waitFor({ timeout: 8000 });

  // 7. Refresh preserves current batch, and ?suite=<id> URL (including trailing slash / trim) works cleanly.
  await page.reload();
  await batchRegion.getByRole("heading", { name: runningBatch.name, exact: true }).waitFor();
  await page.goto(`${url}create/suite/?suite=%20${seeded[0].id}%20`);
  await batchRegion.getByRole("heading", { name: seeded[0].name, exact: true }).waitFor();

  // 8. Clicking "＋ 新建套图" clears current batch and shows empty state.
  await page.getByRole("button", { name: "＋ 新建套图", exact: true }).click();
  await page.waitForURL(url + "create/suite");
  await page.getByRole("heading", { name: "AI 商品套图", exact: true }).waitFor();
  assert.equal(await batchRegion.count(), 0);

  // Whitespace-only ?suite= with cleared sessionStorage displays empty state when latest batch is completed.
  await page.evaluate(() => window.sessionStorage.removeItem("picagent:suite-studio:last-suite-id"));
  await page.goto(`${url}create/suite?suite=%20%20`);
  await page.getByRole("heading", { name: "AI 商品套图", exact: true }).waitFor();
  assert.equal(await batchRegion.count(), 0);
});
