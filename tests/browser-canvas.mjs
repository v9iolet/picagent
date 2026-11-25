// Run with npx tsx --test tests/browser-canvas.mjs. All application data and generation are local.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { chromium } from "playwright";
import { createServer } from "vite";
import { createSuiteStudioApp } from "../server/app.js";
import { ImageEditorService, MemoryImageEditorRepository } from "../server/image-editor.js";
import { createImageEditorApi } from "../server/image-editor-api.js";
import { dispatchInputImageUpload } from "../server/multipart.js";
import { MemoryLibraryRepository } from "../server/repositories/memory-library-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryTaskRepository } from "../server/repositories/memory-task-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";

async function offlineCanvas(t, sizes = ["1K", "2K"]) {
  const sample = await readFile("public/assets/gan65-product.jpg");
  const libraryRepository = new MemoryLibraryRepository();
  const storage = new MemoryStorage();
  const taskRepository = new MemoryTaskRepository();
  const editorRepository = new MemoryImageEditorRepository();
  const calls = [];
  const editorService = new ImageEditorService(
    editorRepository,
    {
      name: "offline-editor",
      version: "gpt-image-2",
      capabilitiesVersion: "1",
      capabilities: () => ({ imageToImage: true, addText: true, changeText: true, redraw: true, erase: true, outpaint: true, currentVersionInput: true }),
      edit: async () => ({ bytes: sample, mimeType: "image/jpeg", width: 64, height: 64 }),
    },
    storage,
    async (versionId) => {
      const version = taskRepository.listAllVersions().find(({ version }) => version.id === versionId)?.version;
      const snapshot = version?.promptSnapshot;
      return { bytes: sample, mimeType: "image/jpeg", width: 64, height: 64, generationPrompt: snapshot?.finalPrompt ?? snapshot?.prompt };
    },
    async () => null,
  );
  const api = createSuiteStudioApp({
    repository: new MemorySuiteRepository(),
    taskRepository,
    libraryRepository,
    storage,
    imageEditorApi: createImageEditorApi(editorService),
    provider: {
      async edit(request) {
        calls.push(request);
        await setTimeout(200);
        return { bytes: sample, mimeType: "image/jpeg" };
      },
    },
  });
  const settings = {
    channels: [{
      id: "offline", name: "离线测试", models: [{
        id: "gpt-image-2", capabilities: ["image"],
        imageOptions: { sizes, aspectRatios: ["1:1", "3:2"], sizeMode: "pixels" },
      }],
    }],
    preferences: { image: { channelId: "offline", modelId: "gpt-image-2" }, vision: null },
  };
  const vite = await createServer({
    cacheDir: "node_modules/.vite-browser-canvas",
    configFile: false,
    server: { host: "127.0.0.1", port: 0 },
    esbuild: { jsx: "automatic" },
    plugins: [{
      name: "offline-canvas-api",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const method = req.method;
          const path = req.url ?? "/";
          if (!path.startsWith("/api/")) return next();
          try {
            const data = [];
            for await (const chunk of req) data.push(chunk);
            const payload = Buffer.concat(data);
            const upload = path.match(/^\/api\/suites\/([^/]+)\/input-images$/);
            const input = path.match(/^\/api\/suites\/([^/]+)\/input-images\/([^/]+)\/preview\/(original|thumbnail)$/);
            const version = path.match(/^\/api\/suite-tasks\/([^/]+)\/versions\/([^/]+)\/preview$/);
            const edited = path.match(/^\/api\/image-editor\/tasks\/([^/]+)\/versions\/([^/]+)\/preview$/);
            let result;
            if (method === "POST" && path.endsWith("/restore-inputs")) {
              result = await dispatchInputImageUpload(api, path, payload, req.headers);
            } else if (upload && method === "POST") {
              const form = await new Response(payload, { headers: { "content-type": req.headers["content-type"] } }).formData();
              const file = form.get("file");
              result = await api.upload(upload[1], {
                filename: file.name, mimeType: file.type, bytes: Buffer.from(await file.arrayBuffer()),
                idempotencyKey: req.headers["idempotency-key"],
              });
              const image = result.body?.data;
              // Seed both an input_image (must stay hidden from picker) and a published base_image (must appear in picker).
              if (image) {
                libraryRepository.addResource({
                  id: `input:${image.id}`, resourceType: "input_image", title: image.originalFilename, summary: "", mimeType: image.mimeType,
                  previewUrl: image.thumbnailPreviewUrl, suiteId: image.suiteId, taskId: null, imageVersionId: null, baseVersionId: null,
                  templateVersionId: null, resourceVersionId: image.id, stage: null, source: { objectKey: image.originalObjectKey },
                  status: "published", createdAt: image.createdAt, updatedAt: image.createdAt,
                });
                libraryRepository.addResource({
                  id: `base:${image.id}`, resourceType: "base_image", title: `白底底图 · ${image.originalFilename}`, summary: "", mimeType: image.mimeType,
                  previewUrl: image.thumbnailPreviewUrl, suiteId: image.suiteId, taskId: null, imageVersionId: null, baseVersionId: image.id,
                  templateVersionId: null, resourceVersionId: image.id, stage: null, source: { objectKey: image.originalObjectKey },
                  status: "published", createdAt: image.createdAt, updatedAt: image.createdAt,
                });
              }
            } else if (input) result = await api.preview(input[1], input[2], input[3]);
            else if (version) result = await api.previewTaskVersion(version[1], version[2]);
            else if (edited) {
              const found = (await editorRepository.listVersions(edited[1])).find((v) => v.id === edited[2]);
              const obj = found ? await storage.get(found.objectKey) : null;
              result = obj ? { status: 200, raw: obj.bytes, headers: { "content-type": obj.contentType } } : { status: 404, body: { error: { code: "NOT_FOUND", message: "not found" } } };
            } else if (path === "/api/model-settings") result = { status: 200, body: { data: settings } };
            else result = await api.request(method, path, { headers: req.headers, body: payload.length ? JSON.parse(payload.toString()) : undefined });
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
  t.after(async () => { await browser.close(); await vite.close(); });
  const url = vite.resolvedUrls.local[0];
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(8000);
  await page.route("**/*", (route) => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
  return { api, calls, url, page };
}

const cardDescription = "用柔和侧光照亮商品，保留右侧留白。";
const longStyle = "保留商品轮廓与材质，以柔和侧光展示真实质感。".repeat(110);

async function addManualTextEdit(page, dialog, originalText, newText) {
  await dialog.getByRole("button", { name: "框选补充" }).click();
  const canvas = dialog.locator(".konvajs-content");
  await canvas.waitFor();
  const { x, y, width, height } = await canvas.boundingBox();
  await page.mouse.move(x + width * 0.2, y + height * 0.2);
  await page.mouse.down();
  await page.mouse.move(x + width * 0.5, y + height * 0.35, { steps: 5 });
  await page.mouse.up();
  await dialog.getByLabel("原文字", { exact: true }).fill(originalText);
  await dialog.getByLabel(`新文字：${originalText}`, { exact: true }).fill(newText);
}

async function seedGeneratedCanvas(api, taskCount) {
  const created = await api.request("POST", "/api/suites", { body: { name: "桌面交付测试", origin: "canvas" } });
  assert.equal(created.status, 201);
  const suiteId = created.body.data.id;
  const upload = await api.upload(suiteId, { filename: "产品.jpg", mimeType: "image/jpeg", bytes: await readFile("public/assets/gan65-product.jpg") });
  assert.equal(upload.status, 201);
  const inputId = upload.body.data.id;
  const tasks = [];
  for (let index = 0; index < taskCount; index++) {
    const result = await api.request("POST", `/api/suites/${suiteId}/tasks/custom`, {
      body: {
        imageType: index === 0 ? "main" : "detail",
        title: `商品视图 ${index + 1}`,
        sourceInputImageId: inputId,
        promptDraft: `系统安全约束：保持商品真实。\n当前类别提示词：${cardDescription}\n单卡人工补充：无`,
      },
    });
    assert.equal(result.status, 201);
    tasks.push(result.body.data.id);
  }
  const generation = await api.request("POST", `/api/suites/${suiteId}/generation`, { headers: { "idempotency-key": "fixture-generation" } });
  assert.equal(generation.status, 202);
  const batchId = generation.body.data.batchId;
  let status;
  for (let attempt = 0; attempt < 150; attempt++) {
    const result = await api.request("GET", `/api/generation-batches/${batchId}`);
    assert.equal(result.status, 200);
    status = result.body.data.batch.status;
    if (status === "completed") break;
    assert.equal(status, "running");
    await setTimeout(25);
  }
  assert.equal(status, "completed");
  const style = await api.request("PATCH", `/api/suites/${suiteId}/style-override`, {
    headers: { "idempotency-key": "fixture-style" }, body: { styleOverride: longStyle },
  });
  assert.equal(style.status, 200);
  return { suiteId, inputId, tasks };
}

function assertDisjoint(boxes, group) {
  for (const [index, a] of boxes.entries()) {
    assert.ok(a, `${group} ${index} has a bounding box`);
    for (const [offset, b] of boxes.slice(index + 1).entries()) {
      assert.ok(b);
      assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y,
        `${group} ${index} and ${index + offset + 1} overlap`);
    }
  }
}

test("成品展示板：直达链接、折叠并复制冻结快照、窄桌面工具栏无溢出", async (t) => {
  const { api, url, page } = await offlineCanvas(t);
  const { suiteId } = await seedGeneratedCanvas(api, 2);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { async writeText(value) { window.copiedSnapshot = value; } } });
  });
  const workbench = await api.request("GET", `/api/suites/${suiteId}/workbench`);
  const frozenPrompt = workbench.body.data.tasks.find((task) => task.imageType === "main").versions[0].promptSnapshot.finalPrompt;
  assert.match(frozenPrompt, /系统安全约束：保持商品真实/);
  await page.goto(url + `create/canvas/${suiteId}?view=gallery`);
  await page.getByRole("tab", { name: "成品展示板", selected: true }).waitFor();
  const gallery = page.getByRole("region", { name: "成品交付视图" });
  await gallery.waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0);
  const inspector = gallery.getByRole("complementary", { name: "交付坑位只读详情" });
  const snapshot = inspector.locator("pre");
  assert.equal(await snapshot.count(), 1);
  assert.equal(await snapshot.isVisible(), false);
  assert.equal(await inspector.getByText("模板版本", { exact: true }).isVisible(), false);
  const style = gallery.getByText(longStyle, { exact: true });
  assert.equal(await style.count(), 1);
  assert.equal(await style.isVisible(), false);
  await gallery.getByText("当前生效全局风格", { exact: true }).click();
  await style.waitFor({ state: "visible" });
  await gallery.getByText("当前生效全局风格", { exact: true }).click();
  await inspector.getByText("冻结提示词快照（只读）", { exact: true }).click();
  await snapshot.waitFor({ state: "visible" });
  await inspector.getByText("模板版本", { exact: true }).waitFor();
  assert.equal(await snapshot.textContent(), frozenPrompt);
  await inspector.getByRole("button", { name: "复制提示词", exact: true }).click();
  assert.equal(await page.evaluate(() => window.copiedSnapshot), frozenPrompt);

  await gallery.locator(".dg-export-field select").nth(1).selectOption("jpeg");
  for (const width of [1920, 1440, 1280, 1180, 1024, 768]) {
    await page.setViewportSize({ width, height: 900 });
    const galleryBox = await gallery.boundingBox();
    assert.ok(galleryBox.x + galleryBox.width <= width + 1, `gallery exceeds ${width}px viewport`);
    for (const [container, children] of [[".dg-toolbar", "button"], [".dg-export-bar", ":scope > *"]]) {
      const region = gallery.locator(container);
      const boundary = await region.boundingBox();
      assert.ok(boundary.x + boundary.width <= width + 1, `${container} exceeds ${width}px viewport`);
      const boxes = await Promise.all((await region.locator(children).all()).map((item) => item.boundingBox()));
      assert.equal(boxes.length, 5);
      assertDisjoint(boxes, `${container} at ${width}px`);
      for (const box of boxes) {
        assert.ok(box.x >= boundary.x - 1 && box.x + box.width <= boundary.x + boundary.width + 1,
          `${container} control overflows at ${width}px`);
      }
      assert.equal(await region.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true);
    }
    const hero = gallery.getByRole("region", { name: "主图轮播预览" });
    assert.equal(await hero.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true);
  }
  const mainBox = await gallery.locator(".dg-main").boundingBox();
  const inspectorBox = await inspector.boundingBox();
  assert.ok(mainBox.y + mainBox.height <= inspectorBox.y, "窄屏下检查器排列在内容区之后");
  await page.getByRole("button", { name: "返回画布列表", exact: true }).click();
  await page.waitForURL("**/create/canvas");
  await page.getByRole("list", { name: "画布列表" }).getByRole("link", { name: /桌面交付测试/ }).waitFor();
});

test("创作画布：任务摘要显示核心提示词，整理后所有卡片零重叠且连线可辨", async (t) => {
  const { api, url, page } = await offlineCanvas(t);
  const { suiteId, inputId, tasks } = await seedGeneratedCanvas(api, 5);
  const layoutPath = `/api/suites/${suiteId}/workbench/layout`;
  const initialLayout = await api.request("PATCH", layoutPath, {
    body: {
      layoutVersion: 0, viewport: { x: 0, y: 0, zoom: 0.5 }, groups: [],
      nodes: ["style:global", `input:${inputId}`, ...tasks.map((id) => `task:${id}`)].map((nodeId, index) => ({ nodeId, x: 100 + index * 20, y: 150 })),
    },
  });
  assert.equal(initialLayout.status, 200);
  await page.goto(url + `create/canvas/${suiteId}`);
  const nodes = page.locator(".react-flow__node");
  await page.locator(".wb-task-card").last().waitFor();
  assert.equal(await nodes.count(), 7);
  const cards = page.locator(".wb-task-prompt");
  const previews = await cards.allTextContents();
  assert.equal(previews.length, 5);
  for (const text of previews) assert.ok(text === cardDescription, "卡片仅显示核心画面描述");
  assert.equal(await page.locator(".wb-task-stats").first().getByText(`${cardDescription.length} 字`, { exact: true }).count(), 1);
  assert.match(await page.getByRole("textbox", { name: "提示词草稿", exact: true }).inputValue(), /系统安全约束/);

  const edgePath = (taskId) => page.getByTestId(`rf__edge-input:${inputId}->task:${taskId}`).locator(".react-flow__edge-path");
  const edgeStyle = (edge) => edge.evaluate((path) => {
    const style = getComputedStyle(path);
    return [style.stroke, style.strokeWidth, style.opacity];
  });
  await edgePath(tasks[0]).waitFor({ state: "attached" });
  assert.deepEqual(await edgeStyle(edgePath(tasks[0])), ["rgb(100, 116, 139)", "1.8px", "0.85"]);

  const styleNode = nodes.filter({ has: page.getByRole("heading", { name: "全局风格卡", exact: true }) });
  const styleHeight = await styleNode.evaluate((node) => node.offsetHeight);
  assert.ok(styleHeight > 540);
  const saved = page.waitForResponse((response) => response.url().endsWith(layoutPath) && response.request().method() === "PATCH");
  await page.getByRole("button", { name: "一键整理布局" }).click();
  const response = await saved;
  assert.equal(response.status(), 200);
  const savedNodes = (await response.json()).data.nodes;
  const styleY = savedNodes.find((node) => node.nodeId === "style:global").y;
  const inputY = savedNodes.find((node) => node.nodeId === `input:${inputId}`).y;
  assert.equal(inputY - styleY, styleHeight + 40);
  await page.getByText("已按三泳道自动整理画布布局", { exact: true }).waitFor();
  await page.waitForFunction(() => {
    const canvas = document.querySelector(".wb-canvas").getBoundingClientRect();
    const cards = [...document.querySelectorAll(".react-flow__node")];
    return cards.length === 7 && cards.every((card) => {
      const box = card.getBoundingClientRect();
      return box.left >= canvas.left && box.right <= canvas.right && box.top >= canvas.top && box.bottom <= canvas.bottom;
    });
  });
  assertDisjoint(await Promise.all((await nodes.all()).map((node) => node.boundingBox())), "整理后的画布卡片");
  await page.getByRole("heading", { name: "商品视图 1", exact: true }).click();
  assert.deepEqual(await edgeStyle(edgePath(tasks[0])), ["rgb(37, 99, 235)", "2.6px", "1"]);
  assert.equal((await edgeStyle(edgePath(tasks[1])))[2], "0.28");
  await page.reload();
  await page.locator(".wb-task-card").last().waitFor();
  assert.equal(await nodes.count(), 7);
  assertDisjoint(await Promise.all((await nodes.all()).map((node) => node.boundingBox())), "重新打开后的画布卡片");
});

test("生图画布：新建、上传、绑定、选择 2K 后用选定尺寸出图", async (t) => {
  const { api, calls, url, page } = await offlineCanvas(t);
  await page.goto(url + "create/suite");
  await page.getByRole("link", { name: "生图画布", exact: true }).click();
  await page.getByText("暂无画布", { exact: true }).waitFor();
  await page.getByRole("button", { name: "新建空白画布" }).click();
  await page.getByText("自由画布", { exact: true }).waitFor();
  assert.match(page.url(), /\/create\/canvas\/[^/]+$/);
  const suiteId = page.url().split("/").at(-1);
  await page.getByText("自由风格", { exact: true }).waitFor();
  await page.getByText("未设置", { exact: true }).waitFor();

  const fileChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "上传商品图", exact: true }).click();
  await (await fileChooser).setFiles("public/assets/gan65-product.jpg");
  await page.getByRole("heading", { name: "原图 1", exact: true }).waitFor();
  await page.getByRole("button", { name: "新建任务卡" }).click();
  const modal = page.getByRole("dialog", { name: "自由新增画布任务卡" });
  await modal.getByLabel("任务标题 *", { exact: true }).fill("棚拍商品");
  await modal.getByLabel("参考商品底图").selectOption("");
  await modal.getByLabel("生图提示词 *", { exact: true }).fill("用柔和灯光展示商品外观");
  await modal.getByRole("button", { name: "加入创作画布" }).click();
  const card = page.locator("article").filter({ has: page.getByRole("heading", { name: "棚拍商品", exact: true }) });
  const generateCard = card.getByRole("button", { name: "生成", exact: true });
  const generateInspector = page.getByRole("button", { name: "创作", exact: true });
  await generateCard.waitFor();
  await generateInspector.waitFor();
  assert.equal(await generateCard.isDisabled(), true);
  assert.equal(await generateInspector.isDisabled(), true);
  await card.getByText("请先绑定商品参考图", { exact: true }).waitFor();
  const before = await api.request("GET", `/api/suites/${suiteId}/workbench`);
  assert.equal(before.body.data.tasks[0].status, "incomplete");
  const { tasks: [task], inputImages: [product] } = before.body.data;
  const referenceEdge = page.getByTestId(`rf__edge-input:${product.id}->task:${task.id}`);
  assert.equal(await referenceEdge.count(), 0);
  await page.screenshot({ path: "tests/browser/canvas-unbound.png" });

  const picker = page.getByRole("combobox", { name: /^商品参考图/ });
  await picker.selectOption({ label: "原图 1 · gan65-product.jpg" });
  await page.getByText("已绑定商品参考图", { exact: true }).waitFor();
  await referenceEdge.waitFor({ state: "attached" });
  assert.equal(await generateCard.isEnabled(), true);
  assert.equal(await generateInspector.isEnabled(), true);
  await page.getByRole("button", { name: "从图片库选择" }).click();
  const library = page.getByRole("dialog", { name: "选择图片库参考图" });
  await library.getByRole("button", { name: /白底底图 · gan65-product\.jpg.*白底底图/ }).waitFor();
  assert.equal(await library.locator(".rp-picker-item").count(), 1);
  await library.getByRole("button", { name: "取消", exact: true }).click();

  const size = page.getByRole("combobox", { name: /^分辨率/ });
  const ratio = page.getByRole("combobox", { name: /^比例/ });
  assert.deepEqual(await size.locator("option:not([disabled])").allTextContents(), ["1K", "2K"]);
  assert.deepEqual(await ratio.locator("option:not([disabled])").allTextContents(), ["1:1", "3:2"]);
  await ratio.selectOption("3:2");
  await card.getByText("3:2", { exact: true }).waitFor();
  await size.selectOption("2K");
  await card.getByText("2K", { exact: true }).waitFor();
  await generateInspector.click();
  await card.locator(".wb-card-state").filter({ hasText: /^已生成$/ }).waitFor();
  await card.getByRole("img", { name: "棚拍商品" }).evaluate((image) => image.decode());
  const after = await api.request("GET", `/api/suites/${suiteId}/workbench`);
  assert.equal(after.body.data.batches[0].status, "completed");
  assert.equal(after.body.data.tasks[0].attempts[0].status, "succeeded");
  assert.deepEqual(calls.map((call) => call.size), ["3072x2048"]);
  assert.deepEqual(calls.map((call) => call.model), ["gpt-image-2"]);
  await page.getByRole("button", { name: "适应视图" }).click();
  await page.screenshot({ path: "tests/browser/canvas-generated.png", animations: "disabled" });

  await page.goto(url + `suites/${suiteId}/board`);
  await page.waitForURL(`**/create/canvas/${suiteId}`);
  await page.getByRole("button", { name: "返回画布列表" }).click();
  await page.getByRole("list", { name: "画布列表" }).getByRole("link", { name: /未命名画布/ }).waitFor();
  await page.screenshot({ path: "tests/browser/canvas-list.png" });
});

test("生图画布：新建任务与检查器仅在选择 4K 时提示耗时、费用和实际像素可能低于标称值", async (t) => {
  const { page, url, calls } = await offlineCanvas(t, ["1K", "4K"]);
  await page.goto(url + "create/canvas");
  await page.getByRole("button", { name: "新建空白画布" }).click();
  await page.getByRole("button", { name: "新建任务卡" }).click();
  const modal = page.getByRole("dialog", { name: "自由新增画布任务卡" });
  const note = page.getByText("4K 出图更慢，费用更高，实际像素可能低于 4K 标称值。", { exact: true });
  await modal.getByLabel("任务标题 *", { exact: true }).fill("高分辨率商品图");
  assert.equal(await note.count(), 0);
  await modal.getByRole("combobox", { name: /^分辨率/ }).selectOption("4K");
  await note.waitFor();
  await modal.getByLabel("生图提示词 *", { exact: true }).fill("展示商品外观");
  await modal.getByRole("button", { name: "加入创作画布" }).click();
  await modal.waitFor({ state: "hidden" });
  const size = page.getByRole("combobox", { name: /^分辨率/ });
  await size.waitFor();
  assert.equal(await size.inputValue(), "4K");
  await note.waitFor();
  await size.selectOption("1K");
  await note.waitFor({ state: "hidden" });
  await size.selectOption("4K");
  await note.waitFor();
  assert.equal(calls.length, 0);
});

test("默认生图模型：套图配置、新建任务与检查器可选七种比例，详情默认 3:4", async (t) => {
  const { page, url } = await offlineCanvas(t);
  const modelId = "gpt-image-2.5-flare-special";
  await page.route("**/api/model-settings", route => route.fulfill({ json: { data: {
    channels: [{ id: "offline", models: [{ id: modelId, capabilities: ["image"] }] }],
    preferences: { image: { channelId: "offline", modelId }, vision: null },
  } } }));
  const ratios = ["1:1", "2:3", "3:2", "3:4", "4:3", "16:9", "9:16"];
  async function assertRatioOptions(select, initial) {
    await select.getByRole("option", { name: "9:16", exact: true }).waitFor({ state: "attached" });
    assert.deepEqual(await select.locator("option:enabled").allTextContents(), ratios);
    assert.equal(await select.inputValue(), initial);
  }

  await page.goto(url + "create/suite");
  const config = page.getByRole("combobox", { name: "比例", exact: true });
  await assertRatioOptions(config, "1:1");
  await config.selectOption("16:9");
  assert.equal(await config.inputValue(), "16:9");

  await page.getByRole("link", { name: "生图画布", exact: true }).click();
  await page.getByRole("button", { name: "新建空白画布" }).click();
  await page.getByRole("button", { name: "新建任务卡" }).click();
  const modal = page.getByRole("dialog", { name: "自由新增画布任务卡" });
  const modalRatio = modal.getByRole("combobox", { name: /^画面比例/ });
  await assertRatioOptions(modalRatio, "3:4");
  await modalRatio.selectOption("4:3");
  assert.equal(await modalRatio.inputValue(), "4:3");
  const type = modal.getByRole("combobox", { name: /^坑位类型/ });
  await type.selectOption("main");
  assert.equal(await modalRatio.inputValue(), "1:1");
  await type.selectOption("detail");
  assert.equal(await modalRatio.inputValue(), "3:4");
  await modal.getByLabel("任务标题 *", { exact: true }).fill("比例样例");
  await modal.getByLabel("生图提示词 *", { exact: true }).fill("展示商品外观");
  await modal.getByRole("button", { name: "加入创作画布" }).click();
  await modal.waitFor({ state: "hidden" });
  const inspector = page.getByRole("combobox", { name: /^比例/ });
  await assertRatioOptions(inspector, "3:4");
  await inspector.selectOption("9:16");
  const card = page.locator("article").filter({ has: page.getByRole("heading", { name: "比例样例" }) });
  await card.getByText("9:16", { exact: true }).waitFor();
});

test("创作画布：AI 改图支持空输入重绘和按指令修改", async (t) => {
  const { api, url, page } = await offlineCanvas(t);
  const { suiteId, tasks: [taskId] } = await seedGeneratedCanvas(api, 1);
  const history = await api.request("GET", `/api/suite-tasks/${taskId}/versions`);
  assert.equal(history.status, 200);
  const { finalPrompt: sourcePrompt } = history.body.data.versions[0].promptSnapshot;
  assert.ok(sourcePrompt.includes(cardDescription));
  await page.goto(url + `create/canvas/${suiteId}`);

  const dialog = page.getByRole("dialog", { name: "图片编辑器" });
  const area = dialog.getByLabel("调整要求");
  const sourceBody = dialog.locator(".wb-editor-source-prompt p");
  const editButton = page.locator(".wb-task-card:not(.wb-edit-child-card) .wb-card-edit");
  const instruction = "商品向左移动一点，换成浅灰色背景";
  for (const [index, input] of ["", instruction].entries()) {
    await editButton.click();
    await dialog.locator(".wb-editor-tools").getByRole("button", { name: /^AI 改图/ }).waitFor();
    assert.equal(await area.inputValue(), "");
    assert.equal(await area.getAttribute("placeholder"), "输入调整要求（选填，空着将按原提示词重绘）。如：商品向左移动一点，换成浅灰色背景…");
    assert.equal(await sourceBody.isVisible(), false);
    await dialog.getByText("原提示词", { exact: true }).click();
    assert.equal(await sourceBody.innerText(), sourcePrompt);
    if (input) await area.fill(input);

    const submitted = page.waitForResponse((response) => response.url().endsWith("/submit"));
    await dialog.getByRole("button", { name: "生成", exact: true }).click();
    const response = await submitted;
    assert.equal(response.status(), 202);
    const { snapshot, attempt } = (await response.json()).data;
    assert.equal(snapshot.tool, "re_edit");
    assert.equal(snapshot.sourcePrompt, sourcePrompt);
    assert.equal(snapshot.operations[0].payload.prompt, input);
    if (input) {
      assert.match(attempt.command.prompt, /\n只执行以下修改：商品向左移动一点，换成浅灰色背景$/);
      assert.ok(!attempt.command.prompt.includes(sourcePrompt));
    } else {
      assert.equal(attempt.command.prompt, sourcePrompt);
    }
    await dialog.waitFor({ state: "hidden" });
    await page.locator(".wb-edit-child-card .wb-card-state").filter({ hasText: /^已生成$/ }).nth(index).waitFor();
  }
});

test("创作画布：未配 OCR 时可手工编辑文字，切换工具保留草稿，提交只使用当前工具", async (t) => {
  const { api, url, page } = await offlineCanvas(t);
  const { suiteId } = await seedGeneratedCanvas(api, 2);
  await page.goto(url + `create/canvas/${suiteId}`);
  await page.locator(".wb-task-card").first().waitFor();

  assert.equal(await page.getByRole("button", { name: "卖点排版" }).count(), 0);
  assert.equal(await page.locator(".wb-card-vector-overlay").count(), 0);

  const capabilitiesGate = Promise.withResolvers();
  await page.route("**/api/image-editor/capabilities", async (route) => {
    await capabilitiesGate.promise;
    await route.continue();
  });
  t.after(() => capabilitiesGate.resolve());
  const ocrRequests = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/ocr")) ocrRequests.push(request.url());
  });
  await page.locator(".wb-task-card:not(.wb-edit-child-card) .wb-card-edit").first().click();
  const dialog = page.getByRole("dialog", { name: "图片编辑器" });
  await dialog.waitFor();
  await dialog.getByLabel("调整要求").fill("保留在 AI 改图里的草稿");
  await dialog.getByRole("button", { name: "添加到对话" }).click();
  await dialog.getByRole("button", { name: "更新对话操作" }).waitFor();

  const changeTextTool = dialog.locator(".wb-editor-tools button", { hasText: "编辑文字" });
  await changeTextTool.click();
  try {
    await dialog.getByRole("status").filter({ hasText: "正在检查文字识别能力" }).waitFor();
    assert.deepEqual(ocrRequests, []);
  } finally {
    capabilitiesGate.resolve();
  }

  await dialog.getByText(/当前未配置多模态识字模型/).waitFor();
  await dialog.getByRole("status").filter({ hasText: "切换前的草稿会保留" }).waitFor();
  await dialog.getByText("已修改 0 条", { exact: true }).waitFor();
  assert.deepEqual(ocrRequests, []);
  assert.doesNotMatch(await dialog.innerText(), /fetch failed/);

  await addManualTextEdit(page, dialog, "旧卖点标题", "65W 便携快充");
  const reEditTool = dialog.locator(".wb-editor-tools").getByRole("button", { name: /^AI 改图/ });
  await reEditTool.click();
  assert.equal(await dialog.getByLabel("调整要求").inputValue(), "保留在 AI 改图里的草稿");
  await changeTextTool.click();
  assert.equal(await dialog.getByLabel("新文字：旧卖点标题").inputValue(), "65W 便携快充");
  const submitted = page.waitForResponse((response) => response.url().endsWith("/submit"));
  await dialog.getByRole("button", { name: "开始生成（新建编辑子卡）" }).click();
  const response = await submitted;
  assert.equal(response.status(), 202);
  const selection = response.request().postDataJSON();
  assert.equal(selection.tool, "change_text");
  assert.equal(selection.operationIds.length, 1);
  const draft = await api.request("GET", `/api/image-editor/sessions/${selection.sourceCardId}`);
  assert.deepEqual(draft.body.data.operations.map((item) => item.type), ["re_edit"]);
  const { originalText, newText, region } = (await response.json()).data.snapshot.operations[0].payload;
  assert.equal(originalText, "旧卖点标题");
  assert.equal(newText, "65W 便携快充");
  assert.equal(region.rotation, 0);
  for (const [key, value] of Object.entries({ x: 0.2, y: 0.2, width: 0.3, height: 0.15 })) {
    assert.ok(Math.abs(region[key] - value) < 0.02, `Unexpected manual region ${key}: ${region[key]}`);
  }
  await dialog.waitFor({ state: "hidden" });

  await page.locator(".wb-edit-child-card").first().waitFor();
  await page.locator(".wb-edit-child-card").first().locator(".wb-card-state").filter({ hasText: /^已生成$/ }).waitFor();
  assert.deepEqual(ocrRequests, []);
});

test("创作画布：将新文字手工改回原文会清理已存草稿", async (t) => {
  const { api, url, page } = await offlineCanvas(t);
  const { suiteId, tasks: [taskId] } = await seedGeneratedCanvas(api, 1);
  const workbench = await api.request("GET", `/api/suites/${suiteId}/workbench`);
  const versionId = workbench.body.data.tasks.find((task) => task.id === taskId).versions[0].id;
  const sessionPath = `/api/image-editor/sessions/${taskId}`;
  const savedDraft = await api.request("POST", sessionPath + "/operations", {
    body: { operation: {
      operationId: "saved-change-text",
      type: "change_text",
      summary: "编辑旧标题",
      sourceCardId: taskId,
      sourceVersionId: versionId,
      parentVersionId: versionId,
      payload: { originalText: "旧标题", newText: "草稿标题", region: { x: 0.2, y: 0.2, width: 0.3, height: 0.15, rotation: 0 } },
    } },
  });
  assert.equal(savedDraft.status, 200);

  await page.goto(url + `create/canvas/${suiteId}`);
  const edit = page.locator(".wb-task-card:not(.wb-edit-child-card) .wb-card-edit");
  const dialog = page.getByRole("dialog", { name: "图片编辑器" });
  const textTool = dialog.locator(".wb-editor-tools button", { hasText: "编辑文字" });
  await edit.click();
  await textTool.click();
  const replacement = dialog.getByLabel("新文字：旧标题", { exact: true });
  assert.equal(await replacement.inputValue(), "草稿标题");
  assert.equal(await replacement.getAttribute("maxlength"), "500");
  assert.equal(await dialog.getByLabel("原文字", { exact: true }).getAttribute("maxlength"), "500");

  const removed = page.waitForResponse((response) => response.request().method() === "DELETE"
    && response.url().endsWith(sessionPath + "/operations/saved-change-text"));
  await replacement.fill("旧标题");
  assert.equal((await removed).status(), 200);
  const draft = await api.request("GET", sessionPath);
  assert.deepEqual(draft.body.data.operations, []);
  await dialog.getByRole("button", { name: "关闭图片编辑器" }).click();
  await edit.click();
  await textTool.click();
  await dialog.getByText("已修改 0 条", { exact: true }).waitFor();
  assert.equal(await replacement.count(), 0);
});

test("创作画布：没有商品原图时上传依据图并完成商品还原", async (t) => {
  const { api, url, page } = await offlineCanvas(t);
  const { suiteId } = await seedGeneratedCanvas(api, 1);
  await page.goto(url + `create/canvas/${suiteId}`);
  await page.locator(".wb-task-card .wb-card-edit").first().click();
  const dialog = page.getByRole("dialog", { name: "图片编辑器" });
  await dialog.getByRole("button", { name: /^商品还原/ }).click();
  await dialog.getByText("当前图片没有商品原图，请上传一张依据图。").waitFor();
  const restore = dialog.getByRole("button", { name: "还原商品", exact: true });
  assert.equal(await restore.isDisabled(), true);
  await dialog.getByLabel("上传", { exact: true }).setInputFiles("public/assets/gan65-product.jpg");
  const preview = dialog.getByRole("img", { name: "已上传的商品外观依据图" });
  await preview.waitFor();
  await preview.evaluate((image) => image.decode());
  const submitted = page.waitForResponse((response) => response.url().endsWith("/submit"));
  await restore.click();
  const response = await submitted;
  assert.equal(response.status(), 202);
  const { snapshot } = (await response.json()).data;
  assert.equal(snapshot.tool, "restore_product");
  assert.equal(snapshot.attachedInputs.length, 1);
  assert.match(snapshot.attachedInputs[0].objectKey, /\/restore-inputs\//);
  await dialog.waitFor({ state: "hidden" });
  await page.locator(".wb-edit-child-card .wb-card-state").filter({ hasText: /^已生成$/ }).waitFor();
});

test("图片资源库联动：画布单卡归档后 /assets 隐藏且预览仍 200；编辑器派生图进入 /assets 标注编辑生成并可软删除", async (t) => {
  const { api, url, page } = await offlineCanvas(t);
  const { suiteId, tasks } = await seedGeneratedCanvas(api, 2);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  // 1. Open /assets -> both generated task cards (商品视图 1, 商品视图 2) appear under AI 生成结果
  await page.goto(url + "assets");
  await page.getByRole("radio", { name: "AI 生成结果", exact: true }).check();
  await page.locator(".style-card", { hasText: "商品视图 1" }).waitFor();
  await page.locator(".style-card", { hasText: "商品视图 2" }).waitFor();
  await page.getByText("第 1 / 1 页 · 共 2 项").waitFor();

  // Record task 1's version preview URL before archiving
  const wbBefore = await api.request("GET", `/api/suites/${suiteId}/workbench`);
  const task1VersionId = wbBefore.body.data.tasks.find((t) => t.id === tasks[0]).versions[0].id;

  // 2. Archive task 1 via PATCH /api/suite-tasks/:id -> reload /assets -> 商品视图 1 disappears, total drops to 1, preview stays 200
  const archiveRes = await page.request.patch(url + `api/suite-tasks/${tasks[0]}`, {
    data: { status: "archived" },
  });
  assert.equal(archiveRes.status(), 200);

  await page.goto(url + "assets");
  await page.getByRole("radio", { name: "AI 生成结果", exact: true }).check();
  await page.getByText("第 1 / 1 页 · 共 1 项").waitFor();
  await page.locator(".style-card", { hasText: "商品视图 2" }).waitFor();
  assert.equal(await page.locator(".style-card", { hasText: "商品视图 1" }).count(), 0);
  const archivedPreview = await page.request.get(url + `api/library/resources/${encodeURIComponent(`task-version:${task1VersionId}`)}/preview`);
  assert.equal(archivedPreview.status(), 200);

  // 3. Open canvas -> edit remaining card (商品视图 2) in image editor -> child card generated
  await page.goto(url + `create/canvas/${suiteId}`);
  await page.locator(".wb-task-card:not(.wb-edit-child-card) .wb-card-edit").first().click();
  const editorDialog = page.getByRole("dialog", { name: "图片编辑器" });
  await editorDialog.waitFor();
  await editorDialog.locator(".wb-editor-tools button", { hasText: "编辑文字" }).click();
  await addManualTextEdit(page, editorDialog, "旧标题", "新品主图");
  await editorDialog.getByRole("button", { name: "开始生成（新建编辑子卡）" }).click();
  await editorDialog.waitFor({ state: "hidden" });
  await page.locator(".wb-edit-child-card").first().locator(".wb-card-state").filter({ hasText: /^已生成$/ }).waitFor();

  // 4. Open /assets -> editor-derived image appears under AI 生成结果 with 编辑生成 source label, loads cleanly, and can be soft-deleted
  await page.goto(url + "assets");
  await page.getByRole("radio", { name: "AI 生成结果", exact: true }).check();
  await page.getByText("第 1 / 1 页 · 共 2 项").waitFor();
  const editedCard = page.locator(".style-card", { hasText: "商品视图 2 · 编辑版本 1" });
  await editedCard.waitFor();
  await editedCard.click();
  const inspector = page.locator(".style-inspector");
  await inspector.getByText("编辑生成", { exact: true }).waitFor();
  const detailImg = inspector.locator(".style-detail-image img");
  await detailImg.waitFor();
  assert.equal(await detailImg.evaluate((el) => el.complete && el.naturalWidth > 0), true);

  await inspector.getByRole("button", { name: "删除图片" }).click();
  const confirm = page.getByRole("dialog");
  await confirm.waitFor();
  await confirm.getByRole("button", { name: "确认删除" }).click();
  await page.getByText("图片已从资源库删除").waitFor();
  await page.getByText("第 1 / 1 页 · 共 1 项").waitFor();
  assert.equal(await page.locator(".style-card", { hasText: "商品视图 2 · 编辑版本 1" }).count(), 0);

  assert.deepEqual(errors, [], `Unexpected page errors: ${errors.join("; ")}`);
});
