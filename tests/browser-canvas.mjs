// Run with npx tsx --test tests/browser-canvas.mjs. All application data and generation are local.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { chromium } from "playwright";
import { createServer } from "vite";
import { createSuiteStudioApp } from "../server/app.js";
import { MemoryLibraryRepository } from "../server/repositories/memory-library-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryTaskRepository } from "../server/repositories/memory-task-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";

async function offlineCanvas(t, sizes = ["1K", "2K"]) {
  const sample = await readFile("public/assets/gan65-product.jpg");
  const libraryRepository = new MemoryLibraryRepository();
  const calls = [];
  const api = createSuiteStudioApp({
    repository: new MemorySuiteRepository(),
    taskRepository: new MemoryTaskRepository(),
    libraryRepository,
    storage: new MemoryStorage(),
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
            let result;
            if (upload && method === "POST") {
              const form = await new Response(payload, { headers: { "content-type": req.headers["content-type"] } }).formData();
              const file = form.get("file");
              result = await api.upload(upload[1], {
                filename: file.name, mimeType: file.type, bytes: Buffer.from(await file.arrayBuffer()),
                idempotencyKey: req.headers["idempotency-key"],
              });
              const image = result.body?.data;
              // Production library builds this row from the uploaded input image table.
              if (image) libraryRepository.addResource({
                id: `input:${image.id}`, resourceType: "input_image", title: image.originalFilename, summary: "", mimeType: image.mimeType,
                previewUrl: image.thumbnailPreviewUrl, suiteId: image.suiteId, taskId: null, imageVersionId: null, baseVersionId: null,
                templateVersionId: null, resourceVersionId: image.id, stage: null, source: { objectKey: image.originalObjectKey },
                status: "published", createdAt: image.createdAt, updatedAt: image.createdAt,
              });
            } else if (input) result = await api.preview(input[1], input[2], input[3]);
            else if (version) result = await api.previewTaskVersion(version[1], version[2]);
            else if (path === "/api/model-settings") result = { status: 200, body: { data: settings } };
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
  await library.getByRole("button", { name: /gan65-product\.jpg.*原图/ }).waitFor();
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

test("生图画布：新建任务与检查器仅在选择 4K 时提示耗时和费用", async (t) => {
  const { page, url, calls } = await offlineCanvas(t, ["1K", "4K"]);
  await page.goto(url + "create/canvas");
  await page.getByRole("button", { name: "新建空白画布" }).click();
  await page.getByRole("button", { name: "新建任务卡" }).click();
  const modal = page.getByRole("dialog", { name: "自由新增画布任务卡" });
  const note = page.getByText("4K 出图更慢，费用更贵。", { exact: true });
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
