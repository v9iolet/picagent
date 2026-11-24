// Run with: npx tsx --test tests/browser-product-image-guide.mjs (offline, no DB or external API calls).
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";
import { createSuiteStudioApp } from "../server/app.js";
import { MemoryLibraryRepository } from "../server/repositories/memory-library-repository.js";
import { MemoryPipelineRepository } from "../server/repositories/memory-pipeline-repository.js";
import { MemoryPromptRepository } from "../server/repositories/memory-prompt-repository.js";
import { MemoryReplicaRepository } from "../server/repositories/memory-replica-repository.js";
import { MemoryReverseRepository } from "../server/repositories/memory-reverse-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryTaskRepository } from "../server/repositories/memory-task-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";

const RULE_1 = "1.可上传同一商品的多视角原图，帮助 AI 更准确还原商品细节。";
const RULE_2 = "2.最多支持 6 张图片，第一张将作为主图重点参考，建议选择角度最全的一张。";

async function startOfflineStudio(t) {
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

  const api = createSuiteStudioApp({
    repository: new MemorySuiteRepository(),
    storage: new MemoryStorage(),
    promptRepository: new MemoryPromptRepository(),
    taskRepository: new MemoryTaskRepository(),
    pipelineRepository: new MemoryPipelineRepository(),
    replicaRepository: new MemoryReplicaRepository(),
    reverseRepository: new MemoryReverseRepository(),
    libraryRepository: new MemoryLibraryRepository(),
    platformRepository: {
      listEnabled: async () => platforms,
      find: async (code) => platforms.find((p) => p.code === code) ?? null,
    },
  });

  const settings = {
    channels: [
      {
        id: "offline",
        name: "离线渠道",
        baseUrl: "https://example.invalid/v1",
        protocol: "openai-compatible",
        hasApiKey: true,
        models: [
          {
            id: "gpt-image-2",
            capabilities: ["image", "vision"],
            imageOptions: { sizes: ["1K", "2K", "4K"], aspectRatios: ["1:1", "3:4", "4:3"], sizeMode: "pixels" },
          },
        ],
      },
    ],
    preferences: {
      image: { channelId: "offline", modelId: "gpt-image-2" },
      vision: { channelId: "offline", modelId: "gpt-image-2" },
    },
  };

  const vite = await createServer({
    cacheDir: "node_modules/.vite-browser-product-image-guide",
    configFile: false,
    server: { host: "127.0.0.1", port: 0 },
    esbuild: { jsx: "automatic" },
    plugins: [
      {
        name: "offline-guide-api",
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            const path = req.url ?? "/";
            if (!path.startsWith("/api/")) return next();
            try {
              const chunks = [];
              for await (const chunk of req) chunks.push(chunk);
              const payload = Buffer.concat(chunks);
              let result;
              if (path === "/api/model-settings") {
                result = { status: 200, body: { data: settings } };
              } else {
                const body = payload.length ? JSON.parse(payload.toString()) : undefined;
                result = await api.request(req.method, path, { headers: req.headers, body });
              }
              res.writeHead(result.status, result.raw ? result.headers : { "Content-Type": "application/json" });
              res.end(result.raw ?? JSON.stringify(result.body));
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
  const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
  t.after(async () => {
    await browser.close();
    await vite.close();
  });
  const url = vite.resolvedUrls.local[0];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10000);
  return { url, page };
}

async function assertGuidePopoverContents(popover) {
  await popover.waitFor({ state: "visible" });
  assert.equal(await popover.getAttribute("role"), "tooltip");

  const rules = await popover.locator(".pig-rules p").allTextContents();
  assert.deepEqual(rules, [RULE_1, RULE_2]);

  const imgStates = await popover.locator(".pig-tile img").evaluateAll((imgs) =>
    Promise.all(
      imgs.map(
        (img) =>
          new Promise((resolve) => {
            const report = () => resolve({ src: img.getAttribute("src"), complete: img.complete, naturalWidth: img.naturalWidth });
            if (img.complete && img.naturalWidth > 0) return report();
            img.addEventListener("load", report, { once: true });
            img.addEventListener("error", report, { once: true });
          }),
      ),
    ),
  );
  assert.equal(imgStates.length, 6, `expected 6 guide images, got ${imgStates.length}`);
  for (const img of imgStates) {
    assert.equal(img.complete, true, `image ${img.src} should be complete`);
    assert.ok(
      img.naturalWidth >= 200,
      `image ${img.src} expected naturalWidth >= 200, got ${img.naturalWidth}`,
    );
  }

  assert.equal(await popover.locator(".pig-badge.is-valid").count(), 3);
  assert.equal(await popover.locator(".pig-badge.is-invalid").count(), 3);
  const tags = await popover.locator(".pig-tag").allTextContents();
  assert.deepEqual(tags, ["首张", "首张非局部", "模糊", "拼图"]);
}

async function assertFitsViewport(page, popover, label) {
  const viewport = page.viewportSize();
  const box = await popover.boundingBox();
  assert.ok(box && viewport, `${label}: popover boundingBox and viewport must exist`);
  assert.ok(box.x >= 8, `${label}: expected left >= 8, got ${box.x}`);
  assert.ok(box.x + box.width <= viewport.width - 8, `${label}: expected right <= ${viewport.width - 8}, got ${box.x + box.width}`);
  assert.ok(box.y >= 8, `${label}: expected top >= 8, got ${box.y}`);
  assert.ok(box.y + box.height <= viewport.height - 8, `${label}: expected bottom <= ${viewport.height - 8}, got ${box.y + box.height}`);
}

test("商品原图与产品原图标题说明浮层：正反例视觉图、文案、视口适配与关闭交互", async (t) => {
  const { url, page } = await startOfflineStudio(t);

  // 1. Suite Studio (/create/suite)
  await page.goto(url + "create/suite");
  const suiteHeading = page.getByRole("heading", { name: "商品原图", level: 2, exact: true });
  await suiteHeading.waitFor({ state: "visible" });

  const suiteCounter = page.locator(".pig-heading-row > small", { hasText: "0 / 6" });
  await suiteCounter.waitFor({ state: "visible" });
  const headingBox = await suiteHeading.boundingBox();
  const counterBox = await suiteCounter.boundingBox();
  assert.ok(headingBox && counterBox && counterBox.x > headingBox.x + headingBox.width, "0 / 6 counter must appear to the right of 商品原图");
  assert.equal(await page.getByText("点击或拖入商品实拍图，最多 6 张", { exact: true }).count(), 0);

  const suiteTrigger = page.getByRole("button", { name: "商品原图上传说明", exact: true });
  await suiteTrigger.waitFor({ state: "visible" });

  // Hover opens the popover
  await suiteTrigger.hover();
  const popover = page.locator(".pa-info-popover.pig-popover");
  await assertGuidePopoverContents(popover);
  await assertFitsViewport(page, popover, "suite 1440x900 hover");

  // Move mouse away to close hover popover, then click to pin
  await page.mouse.move(10, 10);
  await popover.waitFor({ state: "hidden" });

  await suiteTrigger.click();
  await assertGuidePopoverContents(popover);
  await assertFitsViewport(page, popover, "suite 1440x900 click");

  // Verify popover fits inside narrow mobile viewport (390x844) without clipping
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(100);
  await assertFitsViewport(page, popover, "suite 390x844");

  // Escape closes popover cleanly
  await page.keyboard.press("Escape");
  await popover.waitFor({ state: "hidden" });

  // Restore desktop viewport for Replica Studio test
  await page.setViewportSize({ width: 1440, height: 900 });

  // 2. Replica Studio (/create/replica)
  await page.goto(url + "create/replica");
  const replicaHeading = page.getByRole("heading", { name: "产品原图（选填）", level: 2, exact: true });
  await replicaHeading.waitFor({ state: "visible" });

  const replicaCounter = page.locator(".pig-heading-row > small", { hasText: "0 / 6" });
  await replicaCounter.waitFor({ state: "visible" });
  const replicaHeadingBox = await replicaHeading.boundingBox();
  const replicaCounterBox = await replicaCounter.boundingBox();
  assert.ok(
    replicaHeadingBox && replicaCounterBox && replicaCounterBox.x > replicaHeadingBox.x + replicaHeadingBox.width,
    "0 / 6 counter must appear to the right of 产品原图（选填）",
  );
  assert.equal(
    await page.getByText("同一商品多角度，本地拖拽或点击上传，整批共用（最多 6 张）", { exact: true }).count(),
    0,
  );

  const replicaTrigger = page.getByRole("button", { name: "产品原图上传说明", exact: true });
  await replicaTrigger.waitFor({ state: "visible" });
  await replicaTrigger.click();
  await assertGuidePopoverContents(popover);
  await assertFitsViewport(page, popover, "replica 1440x900 click");

  // Click outside closes popover cleanly
  await page.mouse.click(1200, 100);
  await popover.waitFor({ state: "hidden" });
});
