// Run with: npx tsx --test tests/browser-replica-studio.mjs (offline, no DB or external API calls).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright";
import { createSuiteStudioApp } from "../server/app.js";
import { parseNormalizedPromptMarkdown } from "../server/prompt-library.js";
import { MemoryLibraryRepository } from "../server/repositories/memory-library-repository.js";
import { MemoryPipelineRepository } from "../server/repositories/memory-pipeline-repository.js";
import { MemoryPromptRepository } from "../server/repositories/memory-prompt-repository.js";
import { MemoryReplicaRepository } from "../server/repositories/memory-replica-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryTaskRepository } from "../server/repositories/memory-task-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";

async function offlineReplicaStudio(t, gates = {}) {
  const sampleProduct = await readFile("public/assets/gan65-product.jpg");
  const sampleResult = await readFile("public/assets/tokyo-desk-v3.jpg");

  const repository = new MemorySuiteRepository();
  const storage = new MemoryStorage();
  const promptRepository = new MemoryPromptRepository();
  const taskRepository = new MemoryTaskRepository();
  const pipelineRepository = new MemoryPipelineRepository();
  const replicaRepository = new MemoryReplicaRepository();
  const libraryRepository = new MemoryLibraryRepository();

  for (const rel of ["prompt/normalized/replica-compose.md", "prompt/normalized/replica-high.md"]) {
    const md = await readFile(rel, "utf8");
    const [draft] = await promptRepository.importRecords([parseNormalizedPromptMarkdown(md, rel)]);
    await promptRepository.publishVersion(draft.templateVersionId);
    libraryRepository.addResource({
      id: draft.templateVersionId,
      resourceVersionId: draft.templateVersionId,
      templateVersionId: draft.templateVersionId,
      title: draft.name,
      stage: draft.stage,
      summary: "离线复刻模板",
      resourceType: "prompt_template",
      status: "published",
      mimeType: null,
      previewUrl: null,
      suiteId: null,
      taskId: null,
      imageVersionId: null,
      baseVersionId: null,
      createdAt: "2026-11-22T00:00:00Z",
      updatedAt: "2026-11-22T00:00:00Z",
      source: { versionNo: draft.versionNo, templateId: draft.templateId, code: draft.code, body: "离线正文" },
    });
  }

  // Seed one published library base_image resource for the resource picker
  const libObjectKey = "library/base-demo-1.jpg";
  await storage.put({ key: libObjectKey, bytes: sampleProduct, contentType: "image/jpeg" });
  libraryRepository.addResource({
    id: "lib-base-001",
    resourceType: "base_image",
    title: "已发布白底产品图.jpg",
    summary: "1024 × 1024",
    mimeType: "image/jpeg",
    previewUrl: "/api/library/resources/lib-base-001/preview",
    suiteId: null,
    taskId: null,
    imageVersionId: null,
    baseVersionId: "bv-1",
    templateVersionId: null,
    resourceVersionId: "ver-base-001",
    stage: null,
    source: { objectKey: libObjectKey },
    status: "published",
    createdAt: "2026-11-22T10:00:00Z",
    updatedAt: "2026-11-22T10:00:00Z",
  });

  const api = createSuiteStudioApp({
    repository,
    storage,
    promptRepository,
    taskRepository,
    pipelineRepository,
    replicaRepository,
    libraryRepository,
    imageRetryDelayMs: 0,
    llmClient: {
      provider: "fake-vision",
      model: "qwen-vl-max",
      isFake: true,
      generatePlan: async () => ({}),
      generateReplicaPrompts: async (input) => {
        if (gates.beforeAnalysisDone) await gates.beforeAnalysisDone;
        return {
          schemaVersion: "replica-prompt-v1",
          taskName: "桌面快充套装",
          sharedStyle: input.styleUnified ? "柔和棚拍暖白质感，统一高光层次" : null,
          items: input.references.map((ref) => ({
            referenceId: ref.referenceId,
            visualStructure: {
              composition: `居中构图 ${ref.ordinal}`,
              lighting: "柔和侧光",
              palette: "暖白与浅灰",
              layout: "上文下图",
              textBlocks: [`标题 ${ref.ordinal}`],
            },
            copy: [{ role: "headline", text: `快充随行 ${ref.ordinal}`, position: "顶部" }],
            prompt: `棚拍展示桌面快充套装（参考 ${ref.ordinal}），柔和光影与整洁台面。`,
          })),
        };
      },
    },
    provider: {
      supportsMultipleImages: true,
      edit: async () => {
        if (gates.beforeImageDone) await gates.beforeImageDone;
        return { bytes: sampleResult, mimeType: "image/jpeg" };
      },
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

  const calls = [];
  const vite = await createServer({
    cacheDir: "node_modules/.vite-browser-replica-studio",
    configFile: false,
    server: { host: "127.0.0.1", port: 0 },
    esbuild: { jsx: "automatic" },
    plugins: [
      {
        name: "offline-replica-api",
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            const path = req.url ?? "/";
            if (!path.startsWith("/api/")) return next();
            try {
              const chunks = [];
              for await (const chunk of req) chunks.push(chunk);
              const payload = Buffer.concat(chunks);
              const libPreview = path.match(/^\/api\/library\/resources\/([^/]+)\/preview$/);
              const versionPreview = path.match(/^\/api\/suite-tasks\/([^/]+)\/versions\/([^/]+)\/preview$/);
              let result;
              if (libPreview) {
                const obj = await storage.get(libObjectKey);
                result = { status: 200, raw: obj.bytes, headers: { "content-type": obj.contentType } };
              } else if (versionPreview) {
                result = await api.previewTaskVersion(versionPreview[1], versionPreview[2]);
              } else if (path === "/api/model-settings") {
                result = { status: 200, body: { data: settings } };
              } else {
                const body = payload.length ? JSON.parse(payload.toString()) : undefined;
                calls.push({ method: req.method, path, body });
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
  const page = await browser.newPage({ viewport: { width: 1480, height: 960 } });
  page.setDefaultTimeout(10000);
  return { api, calls, url, page };
}

test("爆品图复刻：路由重定向、配置栏交互与校验、资源库选择、提交进度与只读结果", async (t) => {
  const analysisGate = Promise.withResolvers();
  const imageGate = Promise.withResolvers();
  const { calls, url, page } = await offlineReplicaStudio(t, {
    beforeAnalysisDone: analysisGate.promise,
    beforeImageDone: imageGate.promise,
  });

  // 1. /reverse redirects to /create/replica and renders empty state + showcase
  await page.goto(url + "reverse");
  await page.waitForURL("**/create/replica");
  const tools = page.getByRole("navigation", { name: "创作功能" });
  assert.deepEqual(await tools.getByRole("link").allTextContents(), ["商品套图", "生图画布", "爆品图复刻"]);
  assert.equal(await tools.getByRole("link", { name: "爆品图复刻", exact: true }).getAttribute("aria-current"), "page");

  await page.getByRole("heading", { name: "爆品图复刻", level: 2, exact: true }).waitFor();
  assert.equal(await page.locator(".rp-showcase-card").count(), 4);

  // 2. Initial disabled button, reason, authorization hint, and strong no-product warning
  const submitBtn = page.getByRole("button", { name: /^一键复刻/ });
  assert.equal(await submitBtn.textContent(), "一键复刻（0张）");
  assert.equal(await submitBtn.isDisabled(), true);
  await page.getByText("请至少上传 1 张参考图", { exact: true }).waitFor();
  await page.getByText("请确认已获得参考图的合法使用授权；品牌、Logo、参数等不会被复刻", { exact: true }).waitFor();
  const noProductWarn = page.getByText("未上传产品图，结果仅作风格示意", { exact: true });
  await noProductWarn.waitFor({ state: "visible" });
  assert.equal(await page.getByRole("checkbox", { name: "输出风格保持一致" }).count(), 0);

  // Toggle sceneType: warning hides on 营销海报 and reappears on 服饰电商图
  await page.getByRole("radio", { name: "营销海报", exact: true }).click();
  await noProductWarn.waitFor({ state: "hidden" });
  await page.getByRole("radio", { name: "服饰电商图", exact: true }).click();
  await noProductWarn.waitFor({ state: "visible" });
  await page.getByRole("radio", { name: "电商商品图", exact: true }).click();

  // 3. Invalid reference file disables submission with failure reason; removing restores state
  const refInput = page.getByLabel("上传参考图", { exact: true });
  await refInput.setInputFiles({
    name: "bad.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not an image"),
  });
  await page.getByText("存在上传失败的参考图，请移除后重试", { exact: true }).waitFor();
  assert.equal(await submitBtn.isDisabled(), true);
  await page.getByRole("button", { name: "移除参考图 bad.txt" }).click();

  // 4. Upload 1st reference image -> button enabled (1张), duplicate rejected, 2nd reference enables styleUnified
  await refInput.setInputFiles("public/assets/gan65-product.jpg");
  await page.getByRole("button", { name: "一键复刻（1张）", exact: true }).waitFor();
  assert.equal(await submitBtn.isDisabled(), false);

  // Duplicate check
  await refInput.setInputFiles("public/assets/gan65-product.jpg");
  await page.getByText(/已去重忽略重复参考图/).waitFor();
  assert.equal(await page.locator("[data-ref-item]").count(), 1);

  // Upload 2nd distinct reference image
  await refInput.setInputFiles("public/assets/tokyo-desk-v3.jpg");
  await page.getByRole("button", { name: "一键复刻（2张）", exact: true }).waitFor();
  assert.equal(await page.locator("[data-ref-item]").count(), 2);

  // Style unified toggle appears and defaults to checked
  const styleUnified = page.getByRole("checkbox", { name: "输出风格保持一致", exact: true });
  await styleUnified.waitFor({ state: "visible" });
  assert.equal(await styleUnified.isChecked(), true);

  // Fill per-image remark and reorder (move 2nd to 1st)
  await page.getByLabel("单张参考要求 2", { exact: true }).fill("顶部留白便于放主标题");
  await page.getByRole("button", { name: "上移参考图 2", exact: true }).click();
  assert.equal(await page.getByLabel("单张参考要求 1", { exact: true }).inputValue(), "顶部留白便于放主标题");

  // 5. Product images: upload local + select from library picker (max = 5 remaining) -> hides warning
  await page.getByLabel("上传产品原图", { exact: true }).setInputFiles("public/assets/gan65-product-tight.jpg");
  await noProductWarn.waitFor({ state: "hidden" });
  assert.equal(await page.locator("[data-product-item]").count(), 1);

  await page.getByRole("button", { name: "从资源库选择", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "从资源库选择产品原图" });
  await picker.waitFor();
  await picker.getByText(/最多选择 5 张/).waitFor();
  await picker.getByRole("button", { name: /已发布白底产品图\.jpg/ }).click();
  await picker.getByRole("button", { name: "确认选择", exact: true }).click();
  await picker.waitFor({ state: "hidden" });
  assert.equal(await page.locator("[data-product-item]").count(), 2);

  // 6. Clone level hover schematic + toggle, unified requirement counter, product info, generation settings
  const composeRadio = page.getByRole("radio", { name: /参考风格/ });
  await composeRadio.hover();
  await page.locator(".rp-level-popover.is-visible img[src='/replica/clone-level-compose.svg']").waitFor();
  await composeRadio.click();
  assert.equal(await composeRadio.getAttribute("aria-checked"), "true");

  await page.getByLabel("统一复刻要求", { exact: true }).fill("保持参考图构图，替换为主产品");
  await page.getByText("14 / 1000", { exact: true }).waitFor();
  await page.getByLabel("商品信息", { exact: true }).fill("65W 氮化镓三口快充，折叠插脚");

  const languageSelect = page.getByLabel("输出语言", { exact: true });
  const ratioSelect = page.getByLabel("比例", { exact: true });
  const sizeSelect = page.getByLabel("分辨率", { exact: true });
  assert.equal(await languageSelect.inputValue(), "zh");
  assert.equal(await ratioSelect.inputValue(), "reference");
  assert.deepEqual(await ratioSelect.locator("option").allTextContents(), ["参考图比例", "1:1", "3:4", "4:3"]);
  // 4K must be excluded in replica mode
  assert.deepEqual(await sizeSelect.locator("option").allTextContents(), ["1K", "2K"]);
  await sizeSelect.selectOption("2K");
  await ratioSelect.selectOption("3:4");

  // 7. Submit -> URL gets ?suite=<id>, shows analyzing skeleton -> generating -> completed read-only cards
  await submitBtn.click();
  await page.waitForURL(/\/create\/replica\?suite=[^&]+/);
  const suiteId = new URL(page.url()).searchParams.get("suite");
  assert.ok(suiteId);

  const postCall = calls.find((c) => c.method === "POST" && c.path === "/api/replicas");
  assert.ok(postCall, "POST /api/replicas should be called");
  assert.equal(postCall.body.references.length, 2);
  assert.equal(postCall.body.references[0].filename, "tokyo-desk-v3.jpg");
  assert.equal(postCall.body.references[0].remark, "顶部留白便于放主标题");
  assert.equal(postCall.body.products.length, 2);
  assert.equal(postCall.body.products[1].libraryResourceId, "lib-base-001");
  assert.equal(postCall.body.sceneType, "ecommerce_product");
  assert.equal(postCall.body.cloneLevel, "compose");
  assert.equal(postCall.body.styleUnified, true);
  assert.equal(postCall.body.ratio, "3:4");
  assert.equal(postCall.body.size, "2K");

  const batch = page.getByRole("region", { name: "复刻批次" });
  await batch.locator('[data-status="running"]').waitFor();
  assert.match(await batch.locator('[data-status="running"]').textContent(), /分析中/);
  assert.equal(await batch.locator("[data-replica-skeleton]").count(), 2);

  // Release analysis -> enters image_generating
  analysisGate.resolve();
  await batch.getByText(/生成中 0\/2/).waitFor({ timeout: 8000 });

  // Release image generation -> completes with 2 read-only result cards & reference overlays
  imageGate.resolve();
  await batch.locator('[data-status="completed"]').waitFor({ timeout: 10000 });
  await batch.getByRole("heading", { name: "桌面快充套装", exact: true }).waitFor();
  assert.equal(await batch.locator("[data-replica-card]").count(), 2);
  assert.equal(await batch.locator("[data-replica-card] .rp-ref-overlay img").count(), 2);

  // Verify polling stops after completion
  const pollsAtCompletion = calls.filter((c) => c.path === `/api/suites/${suiteId}/studio-state`).length;
  await page.waitForTimeout(3000);
  assert.equal(
    calls.filter((c) => c.path === `/api/suites/${suiteId}/studio-state`).length,
    pollsAtCompletion,
    "终态后不应继续轮询",
  );

  // 8. New replica returns to empty state, history drawer can reopen the batch
  await page.getByRole("button", { name: "＋ 新建复刻", exact: true }).click();
  await page.waitForURL(/\/create\/replica$/);
  await page.getByRole("heading", { name: "爆品图复刻", level: 2, exact: true }).waitFor();

  await page.getByRole("button", { name: "生成记录", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "生成记录" });
  await drawer.waitFor();
  await drawer.getByRole("button", { name: /桌面快充套装/ }).click();
  await page.waitForURL(`**/create/replica?suite=${suiteId}`);
  await batch.locator('[data-status="completed"]').waitFor();

  // 9. Template library includes replica_prompt stage filter & label
  await page.goto(url + "templates");
  await page.getByRole("radio", { name: "爆品图复刻", exact: true }).check();
  await page.locator(".template-card").first().waitFor();
  assert.equal(await page.locator(".template-card .badge", { hasText: "爆品图复刻" }).count() >= 2, true);
});
