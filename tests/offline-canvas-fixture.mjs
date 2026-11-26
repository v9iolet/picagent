import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { chromium } from "playwright";
import { createServer } from "vite";
import { createSuiteStudioApp } from "../server/app.js";
import { ImageEditorService, MemoryImageEditorRepository } from "../server/image-editor.js";
import { createImageEditorApi } from "../server/image-editor-api.js";
import { dispatchInputImageUpload } from "../server/multipart.js";
import { supportedImageEditorOutpaintRatios } from "../server/providers/image-editor-provider.js";
import { MemoryLibraryRepository } from "../server/repositories/memory-library-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryTaskRepository } from "../server/repositories/memory-task-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";

export async function offlineCanvas(t, sizes = ["1K", "2K"], aspectRatios = ["1:1", "3:2"]) {
  const sample = await readFile("public/assets/gan65-product.jpg");
  const libraryRepository = new MemoryLibraryRepository();
  const storage = new MemoryStorage();
  const taskRepository = new MemoryTaskRepository();
  const editorRepository = new MemoryImageEditorRepository();
  const calls = [];
  const imageOptions = { sizes, aspectRatios, sizeMode: "pixels" };
  const editorService = new ImageEditorService(
    editorRepository,
    {
      name: "offline-editor",
      version: "gpt-image-2",
      capabilitiesVersion: "1",
      capabilities: () => ({ imageToImage: true, addText: true, changeText: true, redraw: true, erase: true, outpaint: true, outpaintRatios: supportedImageEditorOutpaintRatios(imageOptions), currentVersionInput: true }),
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
        imageOptions,
      }],
    }],
    preferences: { image: { channelId: "offline", modelId: "gpt-image-2" }, vision: null, video: null },
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

export const cardDescription = "用柔和侧光照亮商品，保留右侧留白。";
export const longStyle = "保留商品轮廓与材质，以柔和侧光展示真实质感。".repeat(110);

export async function seedGeneratedCanvas(api, taskCount) {
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
