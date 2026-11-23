import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import sharp from "sharp";
import { buildImageEditPrompt, ImageEditorService, MemoryImageEditorRepository, type EditOperation, type ImageEditProvider, type ImageSource } from "../server/image-editor.js";
import { createImageEditorApi } from "../server/image-editor-api.js";
import { DashScopeOcrProvider } from "../server/providers/dashscope-ocr-provider.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";

const source: ImageSource = { bytes: Buffer.from("source"), mimeType: "image/png", width: 100, height: 100 };
const operation = (type: EditOperation["type"] = "re_edit"): EditOperation => ({ operationId: "op-1", type, order: 1, sourceCardId: "parent", sourceVersionId: "version-1", parentVersionId: "version-1", summary: "调整背景", payload: type === "redraw" ? { prompt: "局部重绘", strokes: [{ points: [{ x: 0.1, y: 0.2 }], width: 0.1 }] } : { prompt: "调整背景" } });

function provider(overrides: Partial<ImageEditProvider> = {}): ImageEditProvider {
  return {
    name: "fake-image-editor", version: "1", capabilitiesVersion: "1",
    capabilities: () => ({ imageToImage: true, addText: true, changeText: true, redraw: true, erase: true, outpaint: true, currentVersionInput: true }),
    edit: async () => ({ bytes: Buffer.from("result"), mimeType: "image/png", width: 100, height: 100 }),
    ...overrides,
  };
}

async function settle() { await new Promise((resolve) => setTimeout(resolve, 10)); }

test("submission freezes ordered operations and is idempotent", async () => {
  const repository = new MemoryImageEditorRepository();
  let selected: ImageEditProvider | null = provider();
  const service = new ImageEditorService(repository, async () => selected, new MemoryStorage(), async () => source);
  await service.upsertOperation({ sessionId: "session", operation: operation() });
  await service.upsertOperation({ sessionId: "session", operation: { ...operation("add_text"), operationId: "op-2", summary: "添加标题" } });
  const first = await service.submit({ sessionId: "session", idempotencyKey: "same", sourceCardId: "parent", sourceVersionId: "version-1", summary: "组合编辑" });
  selected = null;
  const duplicate = await service.submit({ sessionId: "session", idempotencyKey: "same", sourceCardId: "parent", sourceVersionId: "version-1", summary: "组合编辑" });
  assert.equal(first.duplicate, false); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.childTask.id, first.childTask.id); assert.deepEqual(first.snapshot.operations.map((item) => item.operationId), ["op-1", "op-2"]);
  await settle(); const task = await repository.getChildTask(first.childTask.id); const versions = await repository.listVersions(first.childTask.id); assert.equal(task?.currentVersionId, versions[0].id); assert.equal(task?.finalVersionId, null);
});

test("unsupported capability rejects before child task creation", async () => {
  const repository = new MemoryImageEditorRepository(); const service = new ImageEditorService(repository, provider({ capabilities: () => ({ imageToImage: true, addText: true, changeText: true, redraw: false, erase: true, outpaint: true, currentVersionInput: true }) }), new MemoryStorage(), async () => source);
  await service.upsertOperation({ sessionId: "session", operation: operation("redraw") });
  await assert.rejects(service.submit({ sessionId: "session", idempotencyKey: "blocked", sourceCardId: "parent", sourceVersionId: "version-1" }), /IMAGE_EDIT_CAPABILITY_UNSUPPORTED:redraw/);
});

test("failure retains child task, creates no version, and retry reuses snapshot", async () => {
  let calls = 0; const repository = new MemoryImageEditorRepository(); const service = new ImageEditorService(repository, provider({ edit: async () => { calls += 1; if (calls === 1) throw new Error("MODEL_FAILED"); return { bytes: Buffer.from("ok"), mimeType: "image/png", width: 100, height: 100 }; } }), new MemoryStorage(), async () => source);
  await service.upsertOperation({ sessionId: "session", operation: operation() }); const submitted = await service.submit({ sessionId: "session", idempotencyKey: "submit", sourceCardId: "parent", sourceVersionId: "version-1" }); await settle();
  assert.equal((await repository.getChildTask(submitted.childTask.id))?.status, "failed"); assert.equal((await repository.listVersions(submitted.childTask.id)).length, 0);
  const retried = await service.retry(submitted.attempt.id, "retry"); assert.equal(retried.childTask.id, submitted.childTask.id); assert.equal(retried.snapshot.id, submitted.snapshot.id); await settle(); assert.equal((await repository.listVersions(submitted.childTask.id)).length, 1); assert.equal((await repository.listAttempts(submitted.childTask.id)).length, 2);
});

test("current and final selections are independent", async () => {
  const repository = new MemoryImageEditorRepository(); const service = new ImageEditorService(repository, provider(), new MemoryStorage(), async () => source);
  await service.upsertOperation({ sessionId: "session", operation: operation() }); const submitted = await service.submit({ sessionId: "session", idempotencyKey: "submit", sourceCardId: "parent", sourceVersionId: "version-1" }); await settle(); const first = (await repository.listVersions(submitted.childTask.id))[0];
  await service.selectVersion(submitted.childTask.id, first.id, "final"); const task = await repository.getChildTask(submitted.childTask.id); assert.equal(task?.currentVersionId, first.id); assert.equal(task?.finalVersionId, first.id);
});

test("change_text allows manual submit without OCR, freezes OCR snapshot when present, and validates required fields", async () => {
  const repository = new MemoryImageEditorRepository();
  const service = new ImageEditorService(repository, provider(), new MemoryStorage(), async () => source, { name: "fake-ocr", version: "1", recognize: async () => ({ blocks: [{ id: "text-1", text: "旧文案", confidence: 0.99, bounds: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 }, rotation: 0 }] }) });
  const change: EditOperation = { ...operation("change_text"), payload: { prompt: "替换文字", originalText: "旧文案", newText: "新文案", region: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 } } };
  await service.upsertOperation({ sessionId: "manual-session", operation: change });
  const manualSubmitted = await service.submit({ sessionId: "manual-session", idempotencyKey: "without-ocr", sourceCardId: "parent", sourceVersionId: "version-1" });
  assert.equal(manualSubmitted.snapshot.operations[0].payload.ocrSnapshot, undefined);

  await service.upsertOperation({ sessionId: "invalid-session", operation: { ...operation("change_text"), payload: { prompt: "替换文字", originalText: "", newText: "新文案", region: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 } } } });
  await assert.rejects(service.submit({ sessionId: "invalid-session", idempotencyKey: "missing-fields", sourceCardId: "parent", sourceVersionId: "version-1" }), /CHANGE_TEXT_FIELDS_REQUIRED/);

  await service.upsertOperation({ sessionId: "ocr-session", operation: change });
  await service.recognize("ocr-session", "version-1");
  const submitted = await service.submit({ sessionId: "ocr-session", idempotencyKey: "with-ocr", sourceCardId: "parent", sourceVersionId: "version-1" });
  const frozen = submitted.snapshot.operations[0].payload.ocrSnapshot as { sourceVersionId: string; status: string };
  assert.equal(frozen.sourceVersionId, "version-1"); assert.equal(frozen.status, "succeeded");
});

test("redraw materializes a same-size grayscale mask with persisted metadata", async () => {
  const repository = new MemoryImageEditorRepository(); const storage = new MemoryStorage(); const service = new ImageEditorService(repository, provider(), storage, async () => source);
  await service.upsertOperation({ sessionId: "session", operation: { ...operation("redraw"), payload: { prompt: "局部重绘", strokes: [{ points: [{ x: 0.1, y: 0.2 }, { x: 0.8, y: 0.9 }], width: 0.12 }], feather: 0.25 } } });
  const submitted = await service.submit({ sessionId: "session", idempotencyKey: "mask", sourceCardId: "parent", sourceVersionId: "version-1" });
  const mask = submitted.snapshot.operations[0].payload.mask as { width: number; height: number; mimeType: string; sha256: string; objectKey: string; feather: number };
  assert.deepEqual({ width: mask.width, height: mask.height, mimeType: mask.mimeType, feather: mask.feather }, { width: 100, height: 100, mimeType: "image/png", feather: 0.25 });
  assert.match(mask.sha256, /^[a-f0-9]{64}$/); assert.equal(mask.objectKey, `image-edits/masks/version-1/op-1-${mask.sha256}.png`);
  const object = await storage.get(mask.objectKey); assert.ok(object); assert.equal(object.contentType, "image/png");
  const metadata = await sharp(object.bytes).metadata(); assert.equal(metadata.format, "png"); assert.equal(metadata.width, 100); assert.equal(metadata.height, 100); assert.equal(metadata.channels, 1);
  const pixels = await sharp(object.bytes).removeAlpha().grayscale().raw().toBuffer(); assert.ok([...pixels].some((value) => value > 0 && value < 255), "feather must produce soft mask pixels");
});

test("outpaint freezes computed dimensions and anchor, and rejects conflicting dimensions", async () => {
  const repository = new MemoryImageEditorRepository(); const seen: Array<EditOperation> = []; const editProvider = provider({ edit: async (command) => { seen.push(...command.operations); return { bytes: Buffer.from("result"), mimeType: "image/png", width: 100, height: 100 }; } });
  const outpaintSource: ImageSource = { bytes: Buffer.from("source"), mimeType: "image/png", width: 100, height: 200 }; const service = new ImageEditorService(repository, editProvider, new MemoryStorage(), async () => outpaintSource);
  await service.upsertOperation({ sessionId: "session", operation: { ...operation("outpaint"), payload: { direction: "right", targetRatio: "1:1" } } });
  const submitted = await service.submit({ sessionId: "session", idempotencyKey: "outpaint", sourceCardId: "parent", sourceVersionId: "version-1" });
  assert.deepEqual(submitted.snapshot.operations[0].payload, { direction: "right", targetRatio: "1:1", targetWidth: 200, targetHeight: 200, anchor: "right" });
  await settle(); assert.equal(seen[0].payload.targetWidth, 200); assert.equal(seen[0].payload.targetHeight, 200);
  const invalidRepository = new MemoryImageEditorRepository(); const invalidService = new ImageEditorService(invalidRepository, provider(), new MemoryStorage(), async () => outpaintSource);
  await invalidService.upsertOperation({ sessionId: "session", operation: { ...operation("outpaint"), payload: { direction: "right", targetRatio: "1:1", targetWidth: 100 } } });
  await assert.rejects(invalidService.submit({ sessionId: "session", idempotencyKey: "outpaint-invalid", sourceCardId: "parent", sourceVersionId: "version-1" }), /OUTPAINT_TARGET_DIMENSIONS_INVALID/);
});

test("regenerate endpoint appends an attempt and version to the same child task", async () => {
  const repository = new MemoryImageEditorRepository(); const service = new ImageEditorService(repository, provider(), new MemoryStorage(), async () => source); const api = createImageEditorApi(service);
  await service.upsertOperation({ sessionId: "session", operation: operation() });
  const first = await api.request("POST", "/api/image-editor/sessions/session/submit", { headers: { "idempotency-key": "submit" }, body: { sourceCardId: "parent", sourceVersionId: "version-1" } });
  assert.equal(first.status, 202); const firstData = (first.body as { data: { childTask: { id: string } } }).data; await settle();
  const regenerated = await api.request("POST", `/api/image-editor/tasks/${firstData.childTask.id}/regenerate`, { headers: { "idempotency-key": "regenerate" }, body: { summary: "再生成" } });
  assert.equal(regenerated.status, 202); const duplicate = await api.request("POST", `/api/image-editor/tasks/${firstData.childTask.id}/regenerate`, { headers: { "idempotency-key": "regenerate" }, body: { summary: "ignored" } }); assert.equal(duplicate.status, 200);
  await settle(); const task = await repository.getChildTask(firstData.childTask.id); assert.equal(task?.id, firstData.childTask.id); assert.equal((await repository.listAttempts(firstData.childTask.id)).length, 2); assert.equal((await repository.listVersions(firstData.childTask.id)).length, 2);
});

test("submission freezes sourcePrompt while compiling pure product-fidelity prompts for local edits and preserving full prompt for re_edit", async () => {
  const repository = new MemoryImageEditorRepository();
  const commands: Array<{ prompt: string }> = [];
  const service = new ImageEditorService(
    repository,
    provider({ edit: async (command) => { commands.push(command); return { bytes: Buffer.from("result"), mimeType: "image/png", width: 100, height: 100 }; } }),
    new MemoryStorage(),
    async () => ({ ...source, generationPrompt: "SOURCE VERSION PROMPT" }),
    { name: "fake-ocr", version: "1", recognize: async () => ({ blocks: [{ id: "b1", text: "旧标语", confidence: 0.99, bounds: { x: 0.1, y: 0.1, width: 0.5, height: 0.2 }, rotation: 0 }] }) },
  );
  await service.recognize("session", "version-1");
  await service.upsertOperation({ sessionId: "session", operation: { ...operation("add_text"), operationId: "op-add", payload: { text: "新品主视觉", region: { x: 0.2, y: 0.3, width: 0.4, height: 0.1 }, prompt: "使用醒目的无衬线标题，与画面光线融合" } } });
  await service.upsertOperation({ sessionId: "session", operation: { ...operation("change_text"), operationId: "op-change", payload: { originalText: "旧标语", newText: "新标语", region: { x: 0.1, y: 0.1, width: 0.5, height: 0.2 }, prompt: "保持字体一致" } } });
  await service.upsertOperation({ sessionId: "session", operation: { ...operation("redraw"), operationId: "op-redraw", payload: { prompt: "替换为柔和木纹桌面", strokes: [{ points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }], width: 0.1 }] } } });
  const submitted = await service.submit({ sessionId: "session", idempotencyKey: "prompt-compose", sourceCardId: "parent", sourceVersionId: "version-1", summary: "组合局部修改" });
  assert.equal(submitted.snapshot.sourcePrompt, "SOURCE VERSION PROMPT");
  await settle();
  const localPrompt = commands[0].prompt;
  assert.match(localPrompt, /严格保持输入图片中的商品主体外观/);
  assert.match(localPrompt, /横向约 20%–60%/);
  assert.match(localPrompt, /新品主视觉/);
  assert.match(localPrompt, /使用醒目的无衬线标题/);
  assert.match(localPrompt, /顶部居中区域（横向约 10%–60%，纵向约 10%–30%）/);
  assert.match(localPrompt, /旧标语.*新标语/);
  assert.match(localPrompt, /仅重绘蒙版白色选区：替换为柔和木纹桌面/);
  assert.doesNotMatch(localPrompt, /SOURCE VERSION PROMPT/);
  assert.doesNotMatch(localPrompt, /strokes/);
  assert.doesNotMatch(localPrompt, /ocrSnapshot/);

  const reEditPrompt = buildImageEditPrompt([{ ...operation("re_edit"), payload: { prompt: "完整重编辑提示词" } }], "SOURCE VERSION PROMPT");
  assert.equal(reEditPrompt, "完整重编辑提示词");
});

test("DashScopeOcrProvider downscales large images to <=1280px JPEG and maps network/timeout errors to readable Chinese", async (t) => {
  const bigPng = await sharp({ create: { width: 2400, height: 2000, channels: 3, background: { r: 245, g: 245, b: 245 } } }).png().toBuffer();
  let capturedBody: Record<string, unknown> | null = null;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    capturedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ blocks: [] }) } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address() as { port: number };
  const ocrProvider = new DashScopeOcrProvider(`http://127.0.0.1:${address.port}/v1`, "test-key", "qwen-vl-ocr");
  await ocrProvider.recognize({ bytes: bigPng, mimeType: "image/png", width: 2400, height: 2000 });

  const messages = (capturedBody as { messages: Array<{ content: unknown }> }).messages;
  const userContent = messages[1].content as Array<{ image_url?: { url?: string } }>;
  const imageUrl = userContent[1].image_url?.url ?? "";
  assert.match(imageUrl, /^data:image\/jpeg;base64,/);
  const decoded = Buffer.from(imageUrl.slice("data:image/jpeg;base64,".length), "base64");
  const meta = await sharp(decoded).metadata();
  assert.equal(meta.format, "jpeg");
  assert.ok((meta.width ?? 0) <= 1280 && (meta.height ?? 0) <= 1280);

  const repository = new MemoryImageEditorRepository();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
  try {
    const failingService = new ImageEditorService(repository, provider(), new MemoryStorage(), async () => source, ocrProvider);
    const snap = await failingService.recognize("net-fail", "version-1");
    assert.equal(snap.status, "failed");
    assert.match(snap.error ?? "", /文字识别服务连接失败/);
    assert.doesNotMatch(snap.error ?? "", /fetch failed/);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const hangServer = http.createServer(() => { /* keep open to trigger abort timeout */ });
  await new Promise<void>((resolve) => hangServer.listen(0, "127.0.0.1", resolve));
  t.after(() => hangServer.close());
  const hangPort = (hangServer.address() as { port: number }).port;
  const timeoutOcr = new DashScopeOcrProvider(`http://127.0.0.1:${hangPort}/v1`, "test-key", "qwen-vl-ocr", 40);
  const timeoutService = new ImageEditorService(repository, provider(), new MemoryStorage(), async () => source, timeoutOcr);
  const timeoutSnap = await timeoutService.recognize("timeout", "version-1");
  assert.equal(timeoutSnap.status, "failed");
  assert.match(timeoutSnap.error ?? "", /文字识别请求超时/);
  assert.doesNotMatch(timeoutSnap.error ?? "", /OCR_TIMEOUT/);
});

test("mask eraser strokes subtract from previously painted mask pixels", async () => {
  const repository = new MemoryImageEditorRepository(); const storage = new MemoryStorage();
  const service = new ImageEditorService(repository, provider(), storage, async () => source);
  await service.upsertOperation({ sessionId: "session", operation: { ...operation("redraw"), payload: { prompt: "局部重绘", strokes: [
    { mode: "draw", points: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }], width: 0.2 },
    { mode: "erase", points: [{ x: 0.5, y: 0.5 }], width: 0.1 },
  ], feather: 0 } } });
  const submitted = await service.submit({ sessionId: "session", idempotencyKey: "mask-eraser", sourceCardId: "parent", sourceVersionId: "version-1" });
  const mask = submitted.snapshot.operations[0].payload.mask as { objectKey: string };
  const object = await storage.get(mask.objectKey); assert.ok(object);
  const pixels = await sharp(object.bytes).removeAlpha().grayscale().raw().toBuffer();
  assert.ok(pixels[50 * 100 + 30] > 200, "painted area remains selected");
  assert.ok(pixels[50 * 100 + 50] < 20, "eraser removes the selected center area");
});
