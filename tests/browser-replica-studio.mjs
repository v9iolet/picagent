// Run with: npx tsx --test tests/browser-replica-studio.mjs (offline, no DB or external API calls).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright";
import { createSuiteStudioApp } from "../server/app.js";
import { ImageEditorService, MemoryImageEditorRepository } from "../server/image-editor.js";
import { createImageEditorApi } from "../server/image-editor-api.js";
import { parseNormalizedPromptMarkdown } from "../server/prompt-library.js";
import { MemoryLibraryRepository } from "../server/repositories/memory-library-repository.js";
import { MemoryPipelineRepository } from "../server/repositories/memory-pipeline-repository.js";
import { MemoryPromptRepository } from "../server/repositories/memory-prompt-repository.js";
import { MemoryReplicaRepository } from "../server/repositories/memory-replica-repository.js";
import { MemoryReverseRepository } from "../server/repositories/memory-reverse-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryTaskRepository } from "../server/repositories/memory-task-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";
import { readZipEntries } from "../server/zip.js";

async function offlineReplicaStudio(t, gates = {}) {
  const sampleProduct = await readFile("public/assets/gan65-product.jpg");
  const sampleResult = await readFile("public/assets/tokyo-desk-v3.jpg");

  const repository = new MemorySuiteRepository();
  const storage = new MemoryStorage();
  const promptRepository = new MemoryPromptRepository();
  const taskRepository = new MemoryTaskRepository();
  const pipelineRepository = new MemoryPipelineRepository();
  const replicaRepository = new MemoryReplicaRepository();
  const reverseRepository = new MemoryReverseRepository();
  const libraryRepository = new MemoryLibraryRepository();
  const editorRepository = new MemoryImageEditorRepository();

  const editorSource = { bytes: sampleResult, mimeType: "image/jpeg", width: 64, height: 64 };
  const editorService = new ImageEditorService(
    editorRepository,
    {
      name: "offline",
      version: "1",
      capabilitiesVersion: "1",
      capabilities: () => ({ imageToImage: true, changeText: true, currentVersionInput: true }),
      edit: async () => editorSource,
    },
    storage,
    async () => editorSource,
    {
      name: "offline OCR",
      version: "1",
      recognize: async () => ({
        blocks: [
          {
            id: "line1",
            text: "快充随行",
            confidence: 1,
            bounds: { x: 0.1, y: 0.1, width: 0.5, height: 0.2 },
            rotation: 0,
          },
        ],
      }),
    },
  );

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
    imageEditorApi: createImageEditorApi(editorService),
    repository,
    storage,
    promptRepository,
    taskRepository,
    pipelineRepository,
    replicaRepository,
    reverseRepository,
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
      edit: async (request) => {
        if (gates.beforeImageDone) await gates.beforeImageDone;
        if (gates.shouldFailImage?.(request)) {
          throw new Error("IMAGE_PROVIDER_FAILED");
        }
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
              const reversePreview = path.match(/^\/api\/reverse-plans\/([^/]+)\/references\/([^/]+)\/preview(?:\/(original|thumbnail))?$/);
              const versionPreview = path.match(/^\/api\/suite-tasks\/([^/]+)\/versions\/([^/]+)\/preview$/);
              const editedPreview = path.match(/^\/api\/image-editor\/tasks\/([^/]+)\/versions\/([^/]+)\/preview$/);
              let result;
              if (libPreview) {
                result = await api.previewLibraryResource(libPreview[1]);
              } else if (reversePreview) {
                result = await api.previewReverseReference(reversePreview[1], reversePreview[2], reversePreview[3] ?? "thumbnail");
              } else if (versionPreview) {
                result = await api.previewTaskVersion(versionPreview[1], versionPreview[2]);
              } else if (editedPreview) {
                const version = (await editorRepository.listVersions(editedPreview[1])).find(
                  (v) => v.id === editedPreview[2],
                );
                const obj = await storage.get(version.objectKey);
                result = { status: 200, raw: obj.bytes, headers: { "content-type": obj.contentType } };
              } else if (path === "/api/model-settings") {
                result = { status: 200, body: { data: settings } };
              } else {
                const body = payload.length ? JSON.parse(payload.toString()) : undefined;
                calls.push({ method: req.method, path, body });
                if (req.method === "POST" && path === "/api/replicas" && gates.beforeCreateDone) {
                  await gates.beforeCreateDone;
                }
                if (req.method === "POST" && path === "/api/replicas" && gates.shouldFailCreate?.(body)) {
                  result = { status: 500, body: { error: { code: "REPLICA_CREATE_FAILED", message: "模拟提交失败" } } };
                } else {
                  result = await api.request(req.method, path, { headers: req.headers, body });
                }
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
  const page = await browser.newPage({ viewport: { width: 1480, height: 960 }, acceptDownloads: true });
  page.setDefaultTimeout(10000);
  return { api, calls, url, page, reverseRepository, storage, sampleProduct };
}

test("爆品图复刻：路由重定向、配置栏交互、结果区单卡与批次操作、生成记录与新建清空", async (t) => {
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
  const cards = batch.locator("[data-replica-card]");
  assert.equal(await cards.count(), 2);
  assert.equal(await batch.locator("[data-replica-card] .rp-ref-overlay img").count(), 2);

  // Verify reference overlay boundingBox is 44x44 (±2px) and inside top-left of .ss-photo
  for (let i = 0; i < 2; i += 1) {
    const card = cards.nth(i);
    const photoBox = await card.locator(".ss-photo").boundingBox();
    const overlayBox = await card.locator(".rp-ref-overlay").boundingBox();
    assert.ok(photoBox && overlayBox, `card ${i} photo and overlay boxes must exist`);
    assert.ok(
      Math.abs(overlayBox.width - 44) <= 2 && Math.abs(overlayBox.height - 44) <= 2,
      `expected 44x44 (±2px) ref overlay, got ${overlayBox.width}x${overlayBox.height}`,
    );
    assert.ok(
      overlayBox.x >= photoBox.x &&
        overlayBox.y >= photoBox.y &&
        overlayBox.x + overlayBox.width <= photoBox.x + photoBox.width / 2 &&
        overlayBox.y + overlayBox.height <= photoBox.y + photoBox.height / 2,
      `ref overlay must sit inside top-left of .ss-photo`,
    );
  }

  // Verify polling stops after completion
  const pollsAtCompletion = calls.filter((c) => c.path === `/api/suites/${suiteId}/studio-state`).length;
  await page.waitForTimeout(3000);
  assert.equal(
    calls.filter((c) => c.path === `/api/suites/${suiteId}/studio-state`).length,
    pollsAtCompletion,
    "终态后不应继续轮询",
  );

  // 8. Rename batch inline
  await batch.getByRole("button", { name: "重命名任务", exact: true }).click();
  const renameInput = batch.getByLabel("任务名称", { exact: true });
  await renameInput.fill("桌面快充升级版");
  await batch.getByRole("button", { name: "保存", exact: true }).click();
  await batch.getByRole("heading", { name: "桌面快充升级版", exact: true }).waitFor();

  // 9. Card 1: in-place Image Editor -> verify edited state + readonly analysis snapshot -> edit prompt & regenerate -> must show v2 (not swallowed by edit child)
  const firstCard = cards.first();
  await firstCard.getByRole("button", { name: "编辑图片", exact: true }).click();
  const editorDialog = page.getByRole("dialog", { name: "图片编辑器" });
  await editorDialog.waitFor();
  assert.equal(new URL(page.url()).pathname, "/create/replica");
  assert.equal(new URL(page.url()).searchParams.get("suite"), suiteId);
  await editorDialog.locator(".wb-editor-tools button", { hasText: "改文字" }).click();
  await editorDialog.getByRole("button", { name: /快充随行/ }).waitFor();
  await editorDialog.getByLabel("新文字").fill("极速快充");
  const editSubmitReq = page.waitForResponse(
    (res) => res.url().includes("/api/image-editor/sessions/") && res.url().endsWith("/submit"),
  );
  await editorDialog.getByRole("button", { name: "开始生成（新建编辑子卡）" }).click();
  await editSubmitReq;
  await editorDialog.waitFor({ state: "hidden" });
  await batch.getByText("图片已更新", { exact: true }).waitFor({ timeout: 10000 });
  await firstCard.getByText("已编辑 · v1", { exact: true }).waitFor();

  // Open prompt dialog on edited card -> verify readonly analysis snapshot (sharedStyle/copy/visualStructure) is still intact, then edit prompt & regenerate
  await firstCard.getByRole("button", { name: "提示词", exact: true }).click();
  const promptDialog = page.getByRole("dialog", { name: /提示词/ });
  await promptDialog.waitFor();
  await promptDialog.getByText("提示词修订 v1", { exact: true }).waitFor();
  await promptDialog.getByText("查看分析快照信息（只读）", { exact: true }).click();
  await promptDialog.getByText(/柔和棚拍暖白质感/).waitFor();
  await promptDialog.getByText(/居中构图/).waitFor();
  const promptBox = promptDialog.getByLabel("复刻提示词", { exact: true });
  const editedPromptText = "暖木桌面高级棚拍桌面快充套装，突出折叠插脚与柔和侧光。";
  await promptBox.fill(editedPromptText);
  const promptRegenReq = page.waitForResponse(
    (res) => res.request().method() === "POST" && res.url().includes("/api/suite-tasks/") && res.url().endsWith("/generation"),
  );
  await promptDialog.getByRole("button", { name: "保存并重新生成", exact: true }).click();
  await promptRegenReq;
  await promptDialog.waitFor({ state: "hidden" });
  await batch.getByText("图片已更新", { exact: true }).waitFor({ timeout: 10000 });
  await firstCard.getByText("v2", { exact: true }).waitFor();
  const regenPromptCall = calls.findLast(
    (c) => c.method === "POST" && c.path.startsWith("/api/suite-tasks/") && c.path.endsWith("/generation"),
  );
  assert.equal(regenPromptCall?.body?.promptDraft, editedPromptText);

  // Reopen prompt dialog and verify promptRevision updated to v2 with edited prompt
  await firstCard.getByRole("button", { name: "提示词", exact: true }).click();
  await promptDialog.waitFor();
  await promptDialog.getByText("提示词修订 v2", { exact: true }).waitFor();
  assert.equal(await promptDialog.getByLabel("复刻提示词", { exact: true }).inputValue(), editedPromptText);
  await promptDialog.getByRole("button", { name: "取消", exact: true }).click();
  await promptDialog.waitFor({ state: "hidden" });

  // 10. Single-card download & batch ZIP download
  const singleDownload = page.waitForEvent("download");
  await firstCard.getByRole("button", { name: "下载", exact: true }).click();
  const singleFile = await singleDownload;
  assert.ok(singleFile.suggestedFilename().length > 0);

  const zipDownload = page.waitForEvent("download");
  await batch.getByRole("button", { name: "ZIP 下载（2）", exact: true }).click();
  const zipPath = await (await zipDownload).path();
  const zipEntries = readZipEntries(await readFile(zipPath));
  assert.equal([...zipEntries.keys()].filter((name) => /\.(png|jpe?g|webp)$/i.test(name)).length, 2);
  assert.ok(zipEntries.has("manifest.json"));

  // 11. Card 2: save to image library (mark final) -> regenerate must clear final lock and show v2 -> save as reverse asset -> delete card 2
  const secondCard = cards.nth(1);
  await secondCard.getByRole("button", { name: /更多操作/ }).click();
  await secondCard.getByRole("menuitem", { name: "保存到图片资源库", exact: true }).click();
  await batch.getByText(/已设为终版并确认归档到图片资源库/).waitFor();
  await secondCard.getByText("终版 · v1", { exact: true }).waitFor();

  const origRegenReq = page.waitForResponse(
    (res) => res.request().method() === "POST" && res.url().includes("/api/suite-tasks/") && res.url().endsWith("/generation"),
  );
  await secondCard.getByRole("button", { name: "重新生成", exact: true }).click();
  await origRegenReq;
  await batch.getByText("图片已更新", { exact: true }).waitFor({ timeout: 10000 });
  await secondCard.getByText("v2", { exact: true }).waitFor();

  await secondCard.getByRole("button", { name: /更多操作/ }).click();
  const saveReverseReq = page.waitForResponse(
    (res) => res.request().method() === "POST" && res.url().includes(`/api/replicas/${suiteId}/tasks/`) && res.url().endsWith("/reverse-asset"),
  );
  await secondCard.getByRole("menuitem", { name: "存为爆品图反推资产", exact: true }).click();
  const saveReverseRes = await saveReverseReq;
  assert.equal(saveReverseRes.status(), 201);
  await batch.getByText(/已存为爆品图反推资产/).waitFor();

  await secondCard.getByRole("button", { name: /更多操作/ }).click();
  await secondCard.getByRole("menuitem", { name: "删除", exact: true }).click();
  const deleteCardDialog = page.getByRole("dialog", { name: "删除复刻卡片" });
  await deleteCardDialog.waitFor();
  await deleteCardDialog.getByRole("button", { name: "确认删除", exact: true }).click();
  await deleteCardDialog.waitFor({ state: "hidden" });
  assert.equal(await cards.count(), 1);

  // 12. New replica clears current batch AND resets dirty config panel back to defaults (without reload)
  await page.getByRole("button", { name: "＋ 新建复刻", exact: true }).click();
  await page.waitForURL(/\/create\/replica$/);
  await page.getByRole("heading", { name: "爆品图复刻", level: 2, exact: true }).waitFor();
  assert.equal(await page.locator("[data-ref-item]").count(), 0);
  assert.equal(await page.locator("[data-product-item]").count(), 0);
  assert.equal(await submitBtn.textContent(), "一键复刻（0张）");
  assert.equal(await submitBtn.isDisabled(), true);
  assert.equal(await page.getByLabel("统一复刻要求", { exact: true }).inputValue(), "");
  assert.equal(await page.getByLabel("商品信息", { exact: true }).inputValue(), "");
  assert.equal(await page.getByRole("radio", { name: /高度复刻/ }).getAttribute("aria-checked"), "true");
  assert.equal(await ratioSelect.inputValue(), "reference");
  assert.equal(await sizeSelect.inputValue(), "1K");

  // 13. Generation history drawer switches back to the renamed batch, then delete batch removes it
  await page.getByRole("button", { name: "生成记录", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "生成记录" });
  await drawer.waitFor();
  await drawer.getByRole("button", { name: /桌面快充升级版/ }).click();
  await page.waitForURL(`**/create/replica?suite=${suiteId}`);
  await batch.getByRole("heading", { name: "桌面快充升级版", exact: true }).waitFor();
  assert.equal(await batch.locator("[data-replica-card]").count(), 1);

  await batch.getByRole("button", { name: "删除批次", exact: true }).click();
  const deleteBatchDialog = page.getByRole("dialog", { name: "删除复刻批次" });
  await deleteBatchDialog.waitFor();
  await deleteBatchDialog.getByRole("button", { name: "确认删除", exact: true }).click();
  await deleteBatchDialog.waitFor({ state: "hidden" });
  await page.waitForURL(/\/create\/replica$/);
  await page.getByRole("heading", { name: "爆品图复刻", level: 2, exact: true }).waitFor();

  // 14. Verify saved reverse reference asset can be published on /assets (encoded reverse%3A<id> status & preview)
  const savedReverseId = (await saveReverseRes.json()).data.id;
  await page.goto(url + "assets");
  await page.getByRole("radio", { name: "草稿", exact: true }).check();
  await page.locator(".style-card", { hasText: "桌面快充升级版" }).first().click();
  const publishReq = page.waitForResponse(
    (res) =>
      res.request().method() === "POST" &&
      res.url().includes("/api/library/resources/reverse%3A") &&
      res.url().endsWith("/status"),
  );
  await page.getByRole("button", { name: "发布", exact: true }).click();
  const publishRes = await publishReq;
  assert.equal(publishRes.status(), 200);
  await page.getByText("资源已发布", { exact: true }).waitFor();
  const previewCheck = await page.request.get(
    url + `api/library/resources/${encodeURIComponent(savedReverseId)}/preview`,
  );
  assert.equal(previewCheck.status(), 200);

  // 15. Template library includes replica_prompt stage filter & label
  await page.goto(url + "templates");
  await page.getByRole("radio", { name: "爆品图复刻", exact: true }).check();
  await page.locator(".template-card").first().waitFor();
  assert.equal(await page.locator(".template-card .badge", { hasText: "爆品图复刻" }).count() >= 2, true);
});

test("爆品图复刻：失败单卡展示错误原因并支持单卡重新生成恢复", async (t) => {
  let failFirstRun = true;
  const { url, page } = await offlineReplicaStudio(t, {
    shouldFailImage: () => failFirstRun,
  });

  await page.goto(url + "create/replica");
  await page.getByLabel("上传参考图", { exact: true }).setInputFiles("public/assets/gan65-product.jpg");
  await page.getByRole("button", { name: "一键复刻（1张）", exact: true }).click();
  await page.waitForURL(/\/create\/replica\?suite=[^&]+/);

  const batch = page.getByRole("region", { name: "复刻批次" });
  await batch.locator('[data-status="failed"]').waitFor({ timeout: 10000 });
  const card = batch.locator("[data-replica-card]").first();
  await card.getByText("生成失败", { exact: true }).waitFor();
  await card.getByText("套图图片生成失败", { exact: true }).waitFor();

  // Recover via single-card regenerate button
  failFirstRun = false;
  await card.getByRole("button", { name: "重新生成", exact: true }).click();
  await batch.getByText("图片已更新", { exact: true }).waitFor({ timeout: 10000 });
  await batch.locator('[data-status="completed"]').waitFor({ timeout: 10000 });
  await card.locator("img").first().waitFor();
});

test("爆品图复刻：无产品图风格示意角标尺寸正常且 /reverse/:id 只读页仍可访问", async (t) => {
  const { url, page, reverseRepository, storage, sampleProduct } = await offlineReplicaStudio(t);

  // Seed a historical reverse plan to verify full read-only rendering on /reverse/:id
  const legacyPlanId = "legacy-reverse-plan-readonly";
  const legacyRefId = "legacy-reverse-ref-1";
  const legacyPromptId = "legacy-reverse-prompt-1";
  const legacyOrigKey = `reverse-plans/${legacyPlanId}/references/${legacyRefId}/original`;
  const legacyThumbKey = `reverse-plans/${legacyPlanId}/references/${legacyRefId}/thumbnail`;
  await storage.put({ key: legacyOrigKey, bytes: sampleProduct, contentType: "image/jpeg" });
  await storage.put({ key: legacyThumbKey, bytes: sampleProduct, contentType: "image/jpeg" });
  await reverseRepository.savePlan({
    id: legacyPlanId,
    mode: "main",
    status: "draft",
    baselineReferenceId: null,
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-10-01T08:00:00.000Z",
    references: [
      {
        id: legacyRefId,
        planId: legacyPlanId,
        ordinal: 1,
        filename: "legacy-ref.jpg",
        mimeType: "image/jpeg",
        sha256: "a".repeat(64),
        width: 800,
        height: 800,
        objectKey: legacyOrigKey,
        thumbnailObjectKey: legacyThumbKey,
        templateVersionId: "legacy-tpl-v1",
        effectivePromptVersionId: legacyPromptId,
        attempts: [
          {
            id: "legacy-attempt-1",
            referenceId: legacyRefId,
            status: "succeeded",
            retryOfAttemptId: null,
            templateVersionId: "legacy-tpl-v1",
            mode: "main",
            baselineReferenceId: null,
            requestSummary: {},
            rawOutput: null,
            errorCode: null,
            errorMessage: null,
            promptVersionId: legacyPromptId,
            createdAt: "2026-10-01T08:00:00.000Z",
            completedAt: "2026-10-01T08:00:00.000Z",
          },
        ],
        promptVersions: [
          {
            id: legacyPromptId,
            referenceId: legacyRefId,
            kind: "model",
            prompt: "历史反推只读提示词：保持产品真实外观，复用棚拍俯拍构图。",
            rawOutput: null,
            templateVersionId: "legacy-tpl-v1",
            mode: "main",
            provider: { name: "qwen", model: "qwen-vl-max", isFake: true },
            createdAt: "2026-10-01T08:00:00.000Z",
          },
        ],
        createdAt: "2026-10-01T08:00:00.000Z",
      },
    ],
  });

  await page.goto(url + "create/replica");
  await page.getByLabel("上传参考图", { exact: true }).setInputFiles("public/assets/gan65-product.jpg");
  await page.getByText("未上传产品图，结果仅作风格示意", { exact: true }).waitFor({ state: "visible" });

  await page.getByRole("button", { name: "一键复刻（1张）", exact: true }).click();
  await page.waitForURL(/\/create\/replica\?suite=[^&]+/);

  const batch = page.getByRole("region", { name: "复刻批次" });
  await batch.locator('[data-status="completed"]').waitFor({ timeout: 10000 });

  const sketchPill = batch.locator(".rp-sketch-pill");
  await sketchPill.waitFor({ state: "visible" });
  assert.equal(await sketchPill.textContent(), "风格示意");

  const card = batch.locator("[data-replica-card]").first();
  const photoBox = await card.locator(".ss-photo").boundingBox();
  const overlayBox = await card.locator(".rp-ref-overlay").boundingBox();
  const tag = card.locator(".rp-card-sketch-tag");
  await tag.waitFor({ state: "visible" });
  assert.equal(await tag.textContent(), "风格示意");
  const tagBox = await tag.boundingBox();

  assert.ok(photoBox && overlayBox && tagBox, "photo, overlay, and sketch tag boxes must exist");
  assert.ok(
    Math.abs(overlayBox.width - 44) <= 2 && Math.abs(overlayBox.height - 44) <= 2,
    `expected 44x44 (±2px) ref overlay, got ${overlayBox.width}x${overlayBox.height}`,
  );
  assert.ok(
    tagBox.width < photoBox.width * 0.5 && tagBox.height < photoBox.height * 0.25,
    `sketch tag should be compact inside .ss-photo, got ${tagBox.width}x${tagBox.height} in ${photoBox.width}x${photoBox.height}`,
  );
  assert.ok(
    tagBox.x >= photoBox.x &&
      tagBox.y >= photoBox.y &&
      tagBox.x + tagBox.width <= photoBox.x + photoBox.width &&
      tagBox.y + tagBox.height <= photoBox.y + photoBox.height,
    `sketch tag must stay inside .ss-photo`,
  );

  // Verify /reverse/:id renders historical read-only plan with reference image, read-only prompt, and no write controls
  await page.goto(url + `reverse/${legacyPlanId}`);
  assert.equal(new URL(page.url()).pathname, `/reverse/${legacyPlanId}`);
  await page.locator(".reverse-upgrade-banner").waitFor({ state: "visible" });
  const readonlyPrompt = page.locator("textarea[readonly]");
  await readonlyPrompt.waitFor({ state: "visible" });
  assert.match(await readonlyPrompt.inputValue(), /历史反推只读提示词/);
  assert.equal(await page.locator('input[type="file"]').count(), 0);
  assert.equal(await page.getByRole("button", { name: /重新反推/ }).count(), 0);

  // Verify /reverse/:id for a missing plan remains routed to the read-only reverse page
  await page.goto(url + "reverse/missing-plan-id");
  assert.equal(new URL(page.url()).pathname, "/reverse/missing-plan-id");
  await page.getByRole("heading", { name: "旧反推方案（只读）", exact: true }).waitFor();
});

test("爆品图复刻：切换功能保留草稿（参考图、产品图、顺序与配置），刷新恢复文字配置，提交失败保留草稿", async (t) => {
  let failCreate = false;
  const { url, page } = await offlineReplicaStudio(t, {
    shouldFailCreate: () => failCreate,
  });

  await page.goto(url + "create/replica");
  await page.getByRole("heading", { name: "爆品图复刻", level: 2, exact: true }).waitFor();

  // Upload 2 reference images, fill remarks, and reorder (move 2nd to 1st)
  const refInput = page.getByLabel("上传参考图", { exact: true });
  await refInput.setInputFiles("public/assets/gan65-product.jpg");
  await refInput.setInputFiles("public/assets/tokyo-desk-v3.jpg");
  await page.getByRole("button", { name: "一键复刻（2张）", exact: true }).waitFor();

  await page.getByLabel("单张参考要求 1", { exact: true }).fill("参考图一局部要求");
  await page.getByLabel("单张参考要求 2", { exact: true }).fill("参考图二顶部留白");
  await page.getByRole("button", { name: "上移参考图 2", exact: true }).click();
  assert.equal(await page.getByLabel("单张参考要求 1", { exact: true }).inputValue(), "参考图二顶部留白");

  // Upload 1 local product + pick 1 library product, reorder so library is 1st
  await page.getByLabel("上传产品原图", { exact: true }).setInputFiles("public/assets/gan65-product-tight.jpg");
  await page.getByRole("button", { name: "从资源库选择", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "从资源库选择产品原图" });
  await picker.waitFor();
  await picker.getByRole("button", { name: /已发布白底产品图\.jpg/ }).click();
  await picker.getByRole("button", { name: "确认选择", exact: true }).click();
  await picker.waitFor({ state: "hidden" });
  assert.equal(await page.locator("[data-product-item]").count(), 2);
  await page.getByRole("button", { name: "左移产品图 已发布白底产品图.jpg", exact: true }).click();

  // Modify all config fields away from defaults
  await page.getByRole("radio", { name: "服饰电商图", exact: true }).click();
  await page.getByRole("radio", { name: /参考风格/ }).click();
  await page.getByLabel("统一复刻要求", { exact: true }).fill("保持参考图构图与暖色调");
  await page.getByLabel("商品信息", { exact: true }).fill("380g 重磅纯棉连帽卫衣");
  await page.getByRole("checkbox", { name: "输出风格保持一致", exact: true }).uncheck();
  await page.getByLabel("输出语言", { exact: true }).selectOption("en");
  await page.getByLabel("比例", { exact: true }).selectOption("4:3");
  await page.getByLabel("分辨率", { exact: true }).selectOption("2K");

  // Switch to /create/suite and back to /create/replica via CreateToolsNav (SPA navigation)
  const tools = page.getByRole("navigation", { name: "创作功能" });
  await tools.getByRole("link", { name: "商品套图", exact: true }).click();
  await page.waitForURL("**/create/suite");
  await tools.getByRole("link", { name: "爆品图复刻", exact: true }).click();
  await page.waitForURL("**/create/replica");

  // Verify reference images, order, remarks, and naturalWidth > 0
  const refItems = page.locator("[data-ref-item]");
  assert.equal(await refItems.count(), 2);
  assert.equal(await refItems.nth(0).locator(".rp-ref-top strong").textContent(), "tokyo-desk-v3.jpg");
  assert.equal(await refItems.nth(1).locator(".rp-ref-top strong").textContent(), "gan65-product.jpg");
  assert.equal(await page.getByLabel("单张参考要求 1", { exact: true }).inputValue(), "参考图二顶部留白");
  assert.equal(await page.getByLabel("单张参考要求 2", { exact: true }).inputValue(), "参考图一局部要求");

  const refWidths = await refItems.locator(".rp-ref-thumb-wrap img").evaluateAll((imgs) =>
    Promise.all(
      imgs.map(
        (img) =>
          new Promise((resolve) => {
            if (img.complete) return resolve(img.naturalWidth);
            img.addEventListener("load", () => resolve(img.naturalWidth), { once: true });
            img.addEventListener("error", () => resolve(0), { once: true });
          }),
      ),
    ),
  );
  assert.ok(
    refWidths.length === 2 && refWidths.every((w) => w > 0),
    `expected restored reference thumbnails to load with naturalWidth > 0, got ${JSON.stringify(refWidths)}`,
  );

  // Verify product images, order, and naturalWidth > 0
  const productItems = page.locator("[data-product-item]");
  assert.equal(await productItems.count(), 2);
  assert.equal(await productItems.nth(0).locator(".rp-product-source").textContent(), "资源库");
  assert.equal(await productItems.nth(1).locator(".rp-product-source").textContent(), "本地");
  const productWidths = await productItems.locator("img").evaluateAll((imgs) =>
    Promise.all(
      imgs.map(
        (img) =>
          new Promise((resolve) => {
            if (img.complete) return resolve(img.naturalWidth);
            img.addEventListener("load", () => resolve(img.naturalWidth), { once: true });
            img.addEventListener("error", () => resolve(0), { once: true });
          }),
      ),
    ),
  );
  assert.ok(
    productWidths.length === 2 && productWidths.every((w) => w > 0),
    `expected restored product thumbnails to load with naturalWidth > 0, got ${JSON.stringify(productWidths)}`,
  );

  // Verify all config fields restored
  assert.equal(await page.getByRole("radio", { name: "服饰电商图", exact: true }).getAttribute("aria-checked"), "true");
  assert.equal(await page.getByRole("radio", { name: /参考风格/ }).getAttribute("aria-checked"), "true");
  assert.equal(await page.getByLabel("统一复刻要求", { exact: true }).inputValue(), "保持参考图构图与暖色调");
  assert.equal(await page.getByLabel("商品信息", { exact: true }).inputValue(), "380g 重磅纯棉连帽卫衣");
  assert.equal(await page.getByRole("checkbox", { name: "输出风格保持一致", exact: true }).isChecked(), false);
  assert.equal(await page.getByLabel("输出语言", { exact: true }).inputValue(), "en");
  await page.waitForFunction(() => document.querySelector('select[aria-label="比例"]')?.value === "4:3");
  assert.equal(await page.getByLabel("分辨率", { exact: true }).inputValue(), "2K");

  // Submit failure preserves draft (references, products, config)
  failCreate = true;
  await page.getByRole("button", { name: "一键复刻（2张）", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "模拟提交失败" }).waitFor();
  assert.equal(await page.locator("[data-ref-item]").count(), 2);
  assert.equal(await page.locator("[data-product-item]").count(), 2);
  assert.equal(await page.getByLabel("统一复刻要求", { exact: true }).inputValue(), "保持参考图构图与暖色调");

  // Full page reload restores text/select configs from sessionStorage
  await page.reload();
  await page.getByRole("heading", { name: "爆品图复刻", level: 2, exact: true }).waitFor();
  assert.equal(await page.getByRole("radio", { name: "服饰电商图", exact: true }).getAttribute("aria-checked"), "true");
  assert.equal(await page.getByRole("radio", { name: /参考风格/ }).getAttribute("aria-checked"), "true");
  assert.equal(await page.getByLabel("统一复刻要求", { exact: true }).inputValue(), "保持参考图构图与暖色调");
  assert.equal(await page.getByLabel("商品信息", { exact: true }).inputValue(), "380g 重磅纯棉连帽卫衣");
  assert.equal(await page.getByLabel("输出语言", { exact: true }).inputValue(), "en");
  await page.waitForFunction(() => document.querySelector('select[aria-label="比例"]')?.value === "4:3");
  assert.equal(await page.getByLabel("分辨率", { exact: true }).inputValue(), "2K");
});

test("爆品图复刻：进行中批次切换功能后自动恢复并继续轮询（replace 不增历史），新建复刻与删除后不恢复", async (t) => {
  const analysisGate = Promise.withResolvers();
  const imageGate = Promise.withResolvers();
  const { url, page } = await offlineReplicaStudio(t, {
    beforeAnalysisDone: analysisGate.promise,
    beforeImageDone: imageGate.promise,
  });

  try {
    await page.goto(url + "create/replica");
    await page.getByLabel("上传参考图", { exact: true }).setInputFiles("public/assets/gan65-product.jpg");
    await page.getByLabel("统一复刻要求", { exact: true }).fill("提交后应清空的草稿");
    await page.getByRole("button", { name: "一键复刻（1张）", exact: true }).click();
    await page.waitForURL(/\/create\/replica\?suite=[^&]+/);
    const suiteId = new URL(page.url()).searchParams.get("suite");
    assert.ok(suiteId);

    // Draft is cleared upon successful submit
    assert.equal(await page.locator("[data-ref-item]").count(), 0);
    assert.equal(await page.getByLabel("统一复刻要求", { exact: true }).inputValue(), "");

    const batch = page.getByRole("region", { name: "复刻批次" });
    await batch.locator('[data-status="running"]').waitFor();
    assert.match(await batch.locator('[data-status="running"]').textContent(), /分析中/);

    // Switch to /create/suite, then return via CreateToolsNav (no ?suite param)
    const tools = page.getByRole("navigation", { name: "创作功能" });
    await tools.getByRole("link", { name: "商品套图", exact: true }).click();
    await page.waitForURL("**/create/suite");
    const historyLenOnSuite = await page.evaluate(() => window.history.length);

    await tools.getByRole("link", { name: "爆品图复刻", exact: true }).click();
    await page.waitForURL(`**/create/replica?suite=${suiteId}`);
    const historyLenAfterReturn = await page.evaluate(() => window.history.length);
    assert.equal(
      historyLenAfterReturn,
      historyLenOnSuite + 1,
      "恢复最近批次应使用 replace，不新增额外历史记录",
    );

    // Continues displaying progress and polling until completion
    await batch.locator('[data-status="running"]').waitFor();
    analysisGate.resolve();
    await batch.getByText(/生成中 0\/1/).waitFor({ timeout: 8000 });
    imageGate.resolve();
    await batch.locator('[data-status="completed"]').waitFor({ timeout: 10000 });
    const batchTitle = (await batch.locator("h3").textContent())?.trim();
    assert.ok(batchTitle, "completed batch should display a heading title");

    // Clicking "＋ 新建复刻" clears remembered suiteId -> navigating away & back does NOT restore old batch
    await page.getByRole("button", { name: "＋ 新建复刻", exact: true }).click();
    await page.waitForURL(/\/create\/replica$/);
    await page.getByRole("heading", { name: "爆品图复刻", level: 2, exact: true }).waitFor();

    await tools.getByRole("link", { name: "商品套图", exact: true }).click();
    await page.waitForURL("**/create/suite");
    await tools.getByRole("link", { name: "爆品图复刻", exact: true }).click();
    await page.waitForURL(/\/create\/replica$/);
    await page.getByRole("heading", { name: "爆品图复刻", level: 2, exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get("suite"), null);

    // Select batch from history, delete it -> navigating away & back does NOT restore deleted batch
    await page.getByRole("button", { name: "生成记录", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "生成记录" });
    await drawer.waitFor();
    await drawer.getByRole("button", { name: new RegExp(batchTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).click();
    await page.waitForURL(`**/create/replica?suite=${suiteId}`);
    await batch.getByRole("heading", { name: batchTitle, exact: true }).waitFor();

    await batch.getByRole("button", { name: "删除批次", exact: true }).click();
    const deleteDialog = page.getByRole("dialog", { name: "删除复刻批次" });
    await deleteDialog.waitFor();
    await deleteDialog.getByRole("button", { name: "确认删除", exact: true }).click();
    await deleteDialog.waitFor({ state: "hidden" });
    await page.waitForURL(/\/create\/replica$/);

    await tools.getByRole("link", { name: "商品套图", exact: true }).click();
    await page.waitForURL("**/create/suite");
    await tools.getByRole("link", { name: "爆品图复刻", exact: true }).click();
    await page.waitForURL(/\/create\/replica$/);
    await page.getByRole("heading", { name: "爆品图复刻", level: 2, exact: true }).waitFor();

    // Stale/deleted suiteId in sessionStorage is silently cleared without showing an error
    await page.evaluate(() => {
      window.sessionStorage.setItem("picagent:replica-studio:last-suite-id", "non-existent-suite-id");
    });
    await page.reload();
    await page.getByRole("heading", { name: "爆品图复刻", level: 2, exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get("suite"), null);
    assert.equal(await page.locator("[data-batch-error]").count(), 0);
    assert.equal(
      await page.evaluate(() => window.sessionStorage.getItem("picagent:replica-studio:last-suite-id")),
      null,
    );
  } finally {
    analysisGate.resolve();
    imageGate.resolve();
  }
});

test("爆品图复刻：配置栏最小宽度下参考图条目与产品图条目不溢出边框", async (t) => {
  const { url, page } = await offlineReplicaStudio(t);
  const sampleBytes = await readFile("public/assets/gan65-product.jpg");
  const sampleBytes2 = await readFile("public/assets/tokyo-desk-v3.jpg");

  // 750px viewport triggers @media (max-width: 1000px) -> config panel hits its 265px minimum width
  await page.setViewportSize({ width: 750, height: 900 });
  await page.goto(url + "create/replica");
  await page.getByRole("heading", { name: "爆品图复刻", level: 2, exact: true }).waitFor();

  const panelBox = await page.locator(".rp-config-panel").boundingBox();
  assert.ok(panelBox && panelBox.width <= 270, `expected narrow config panel (~265px), got ${panelBox?.width}`);

  await page.getByLabel("上传参考图", { exact: true }).setInputFiles([
    {
      name: "ultra-long-reference-filename-for-narrow-panel-overflow-check-001.jpg",
      mimeType: "image/jpeg",
      buffer: sampleBytes,
    },
    {
      name: "ultra-long-reference-filename-for-narrow-panel-overflow-check-002.jpg",
      mimeType: "image/jpeg",
      buffer: sampleBytes2,
    },
  ]);
  await page.getByRole("button", { name: "一键复刻（2张）", exact: true }).waitFor();
  await page.getByLabel("单张参考要求 1", { exact: true }).fill("测试窄宽度下计数和输入框都不溢出");

  // Also upload 2 product images (2nd has both ← and × buttons)
  await page.getByLabel("上传产品原图", { exact: true }).setInputFiles([
    {
      name: "long-product-filename-001.jpg",
      mimeType: "image/jpeg",
      buffer: sampleBytes,
    },
    {
      name: "long-product-filename-002.jpg",
      mimeType: "image/jpeg",
      buffer: sampleBytes2,
    },
  ]);
  assert.equal(await page.locator("[data-product-item]").count(), 2);

  const assertInside = (outer, inner, label) => {
    assert.ok(outer && inner, `${label}: bounding boxes must exist`);
    const eps = 0.5;
    assert.ok(
      inner.x >= outer.x - eps &&
        inner.y >= outer.y - eps &&
        inner.x + inner.width <= outer.x + outer.width + eps &&
        inner.y + inner.height <= outer.y + outer.height + eps,
      `${label} overflows container: inner=${JSON.stringify(inner)} outer=${JSON.stringify(outer)}`,
    );
  };

  const refItems = page.locator(".rp-ref-item");
  assert.equal(await refItems.count(), 2);
  for (let i = 0; i < 2; i += 1) {
    const item = refItems.nth(i);
    const itemBox = await item.boundingBox();
    const opsBox = await item.locator(".rp-item-ops").boundingBox();
    const countBox = await item.locator(".rp-char-count").boundingBox();
    const inputBox = await item.locator(".rp-remark-wrap input").boundingBox();
    const titleEl = item.locator(".rp-ref-top strong");
    const titleBox = await titleEl.boundingBox();

    assertInside(itemBox, opsBox, `ref[${i}] .rp-item-ops`);
    assertInside(itemBox, countBox, `ref[${i}] .rp-char-count`);
    assertInside(itemBox, inputBox, `ref[${i}] remark input`);
    assertInside(itemBox, titleBox, `ref[${i}] title`);
    assert.ok(
      titleBox.x + titleBox.width <= opsBox.x + 0.5,
      `ref[${i}] title overlaps ops: title=${JSON.stringify(titleBox)} ops=${JSON.stringify(opsBox)}`,
    );
    const titleStyle = await titleEl.evaluate((el) => ({
      textOverflow: getComputedStyle(el).textOverflow,
      truncated: el.scrollWidth > el.clientWidth,
    }));
    assert.equal(titleStyle.textOverflow, "ellipsis");
    assert.equal(titleStyle.truncated, true, `ref[${i}] long filename should truncate with ellipsis`);
  }

  const productItems = page.locator("[data-product-item]");
  for (let i = 0; i < 2; i += 1) {
    const item = productItems.nth(i);
    const itemBox = await item.boundingBox();
    const controlsBox = await item.locator(".rp-product-controls").boundingBox();
    const sourceBox = await item.locator(".rp-product-source").boundingBox();
    assertInside(itemBox, controlsBox, `product[${i}] .rp-product-controls`);
    assertInside(itemBox, sourceBox, `product[${i}] .rp-product-source`);
  }
});

test("爆品图复刻：提交请求在途时切到套图页，返回后不抢跳，再切回复刻页自动打开新批次", async (t) => {
  const createGate = Promise.withResolvers();
  const { url, page } = await offlineReplicaStudio(t, {
    beforeCreateDone: createGate.promise,
  });

  try {
    await page.goto(url + "create/replica");
    await page.getByLabel("上传参考图", { exact: true }).setInputFiles("public/assets/gan65-product.jpg");
    await page.getByLabel("统一复刻要求", { exact: true }).fill("在途提交应清空草稿");

    const createResponsePromise = page.waitForResponse(
      (res) => res.request().method() === "POST" && new URL(res.url()).pathname === "/api/replicas",
    );
    await page.getByRole("button", { name: "一键复刻（1张）", exact: true }).click();
    await page.getByRole("button", { name: "提交中…", exact: true }).waitFor();

    // Immediately switch to /create/suite while POST /api/replicas is still in flight
    const tools = page.getByRole("navigation", { name: "创作功能" });
    await tools.getByRole("link", { name: "商品套图", exact: true }).click();
    await page.waitForURL("**/create/suite");
    await page.getByRole("heading", { name: "AI 商品套图", exact: true }).waitFor();

    // Release POST /api/replicas -> must stay on /create/suite, NOT hijack navigation back to /create/replica
    createGate.resolve();
    const createRes = await createResponsePromise;
    assert.equal(createRes.status(), 201);
    const createdSuiteId = (await createRes.json()).data.suiteId;
    assert.ok(createdSuiteId);

    // Wait briefly to confirm no delayed redirect occurs and sessionStorage captured the new suiteId
    await page.waitForFunction(
      (expectedId) => window.sessionStorage.getItem("picagent:replica-studio:last-suite-id") === expectedId,
      createdSuiteId,
    );
    assert.equal(new URL(page.url()).pathname, "/create/suite");

    // Switching back to /create/replica automatically opens the newly created batch with cleared draft
    await tools.getByRole("link", { name: "爆品图复刻", exact: true }).click();
    await page.waitForURL(`**/create/replica?suite=${createdSuiteId}`);
    assert.equal(await page.locator("[data-ref-item]").count(), 0);
    assert.equal(await page.getByLabel("统一复刻要求", { exact: true }).inputValue(), "");
    const batch = page.getByRole("region", { name: "复刻批次" });
    await batch.locator('[data-status="completed"]').waitFor({ timeout: 10000 });
  } finally {
    createGate.resolve();
  }
});
