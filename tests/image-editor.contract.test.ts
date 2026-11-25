import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import { buildImageEditPrompt, ImageEditorService, MemoryImageEditorRepository, type EditOperation, type ImageEditProvider, type ImageSource } from "../server/image-editor.js";
import { createImageEditorApi } from "../server/image-editor-api.js";
import { DashScopeOcrProvider } from "../server/providers/dashscope-ocr-provider.js";
import { requestImageEditorEdit } from "../server/providers/image-editor-provider.js";
import type { ImageEditRequest } from "../server/types.js";
import { defaultImageOptions } from "../shared/model-settings.js";
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

test("mixed tools and multiple masks are rejected before submitting", async () => {
  const repository = new MemoryImageEditorRepository();
  const service = new ImageEditorService(repository, provider(), new MemoryStorage(), async () => source);
  const api = createImageEditorApi(service);
  await service.upsertOperation({ sessionId: "session", operation: operation() });
  await service.upsertOperation({ sessionId: "session", operation: { ...operation("redraw"), operationId: "op-2" } });
  await service.upsertOperation({ sessionId: "session", operation: { ...operation("redraw"), operationId: "op-3" } });
  const submit = (tool: string, operationIds: string[]) => api.request("POST", "/api/image-editor/sessions/session/submit", {
    headers: { "idempotency-key": tool },
    body: { sourceCardId: "parent", sourceVersionId: "version-1", tool, operationIds },
  });
  const mixed = await submit("re_edit", ["op-1", "op-2"]);
  assert.equal(mixed.status, 409);
  assert.equal((mixed.body as { error: { code: string } }).error.code, "MIXED_IMAGE_EDIT_TOOLS");
  const masks = await submit("redraw", ["op-2", "op-3"]);
  assert.equal(masks.status, 409);
  assert.equal((masks.body as { error: { code: string } }).error.code, "MULTIPLE_MASK_OPERATIONS_UNSUPPORTED");
  assert.equal((await repository.listChildTasks()).length, 0);
  assert.equal((await repository.getDraft("session"))?.operations.length, 3);
});

test("submission freezes only the selected tool and source version, clears submitted operations, and is idempotent", async () => {
  const repository = new MemoryImageEditorRepository();
  let selected: ImageEditProvider | null = provider();
  const service = new ImageEditorService(repository, async () => selected, new MemoryStorage(), async () => source);
  const addText = { ...operation("add_text"), payload: { text: "标题", prompt: "使用黑体", strokes: [{ points: [] }] } };
  await service.upsertOperation({ sessionId: "session", operation: addText });
  await service.upsertOperation({ sessionId: "session", operation: { ...addText, operationId: "op-2", summary: "添加副标题" } });
  await service.upsertOperation({ sessionId: "session", operation: { ...addText, sourceVersionId: "older-version" } });
  await service.upsertOperation({ sessionId: "session", operation: { ...operation(), operationId: "re-edit-draft" } });
  const input = { sessionId: "session", idempotencyKey: "same", sourceCardId: "parent", sourceVersionId: "version-1", tool: "add_text" };
  const first = await service.submit(input);
  selected = null;
  const duplicate = await service.submit(input);
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.childTask.id, first.childTask.id);
  assert.equal(first.snapshot.tool, "add_text");
  assert.equal(first.snapshot.maskApplied, false);
  assert.deepEqual(first.snapshot.attachedInputs, []);
  assert.deepEqual(first.attempt.command.operations.map((item) => [item.operationId, item.sourceVersionId, item.payload]), [
    ["op-1", "version-1", { text: "标题", prompt: "使用黑体" }],
    ["op-2", "version-1", { text: "标题", prompt: "使用黑体" }],
  ]);
  assert.deepEqual((await repository.getDraft("session"))?.operations.map((item) => [item.operationId, item.sourceVersionId]), [
    ["op-1", "older-version"], ["re-edit-draft", "version-1"],
  ]);
  await settle();
  const task = await repository.getChildTask(first.childTask.id);
  const versions = await repository.listVersions(first.childTask.id);
  assert.equal(task?.currentVersionId, versions[0].id);
  assert.equal(task?.finalVersionId, null);
});

test("unsupported capability rejects before child task creation", async () => {
  const repository = new MemoryImageEditorRepository(); const service = new ImageEditorService(repository, provider({ capabilities: () => ({ imageToImage: true, addText: true, changeText: true, redraw: false, erase: true, outpaint: true, currentVersionInput: true }) }), new MemoryStorage(), async () => source);
  await service.upsertOperation({ sessionId: "session", operation: operation("redraw") });
  await assert.rejects(service.submit({ sessionId: "session", idempotencyKey: "blocked", sourceCardId: "parent", sourceVersionId: "version-1" }), /IMAGE_EDIT_CAPABILITY_UNSUPPORTED:redraw/);
});

test("submission leaves a draft intact if it changed while the request was being prepared", async () => {
  const repository = new MemoryImageEditorRepository();
  let start!: () => void;
  let resume!: () => void;
  const sourceRequested = new Promise<void>((resolve) => { start = resolve; });
  const sourceReady = new Promise<void>((resolve) => { resume = resolve; });
  const service = new ImageEditorService(repository, provider(), new MemoryStorage(), async () => {
    start();
    await sourceReady;
    return source;
  });
  const initial = operation();
  await service.upsertOperation({ sessionId: "session", operation: initial });
  const input = { sessionId: "session", idempotencyKey: "submit", sourceCardId: "parent", sourceVersionId: "version-1", tool: "re_edit" };
  const submitting = service.submit(input);
  await sourceRequested;
  await service.upsertOperation({ sessionId: "session", operation: { ...initial, payload: { prompt: "更新后的草稿" } } });
  resume();
  await assert.rejects(submitting, /EDIT_DRAFT_CHANGED/);
  assert.equal((await repository.listChildTasks()).length, 0);
  assert.equal((await repository.getDraft("session"))?.operations[0].payload.prompt, "更新后的草稿");
  const retried = await service.submit(input);
  assert.equal(retried.attempt.command.prompt, "更新后的草稿");
  assert.deepEqual((await repository.getDraft("session"))?.operations, []);
});

test("failure retains child task, creates no version, and retry reuses snapshot", async () => {
  let calls = 0; const repository = new MemoryImageEditorRepository(); const service = new ImageEditorService(repository, provider({ edit: async () => { calls += 1; if (calls === 1) throw new Error("MODEL_FAILED"); return { bytes: Buffer.from("ok"), mimeType: "image/png", width: 100, height: 100 }; } }), new MemoryStorage(), async () => source);
  await service.upsertOperation({ sessionId: "session", operation: operation() }); const submitted = await service.submit({ sessionId: "session", idempotencyKey: "submit", sourceCardId: "parent", sourceVersionId: "version-1" }); await settle();
  assert.deepEqual((await repository.getDraft("session"))?.operations, []);
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

test("regenerate replays the frozen prompt, source, mask and attached inputs on the same child task", async () => {
  const repository = new MemoryImageEditorRepository();
  const storage = new MemoryStorage();
  const calls: ImageEditRequest[] = [];
  const bytes = await sharp({ create: { width: 1024, height: 1360, channels: 3, background: "white" } }).png().toBuffer();
  const resultBytes = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "blue" } }).png().toBuffer();
  const editorSource = { ...source, bytes, width: 1024, height: 1360 };
  const imageProvider = { edit: async (request: ImageEditRequest) => { calls.push(request); return { bytes: resultBytes, mimeType: "image/png" }; } };
  const options = defaultImageOptions("gpt-image-2");
  const editProvider = provider();
  const service = new ImageEditorService(repository, {
    ...editProvider,
    capabilities: async () => ({ ...await editProvider.capabilities(), imageToImage: false }),
    edit: (command, input) => requestImageEditorEdit(imageProvider, storage, "gpt-image-2", options, command, input),
  }, storage, async (versionId) => versionId === "version-1" ? editorSource : null);
  const api = createImageEditorApi(service);
  await service.upsertOperation({ sessionId: "session", operation: operation("redraw") });
  const first = await service.submit({ sessionId: "session", idempotencyKey: "submit", sourceCardId: "parent", sourceVersionId: "version-1", tool: "redraw" });
  assert.equal(first.snapshot.maskApplied, true);
  await settle();

  // Simulate a snapshot with attachments to verify the replay path before the attachment tools are added.
  const attachment = { objectKey: "frozen-product", role: "product" };
  await storage.put({ key: attachment.objectKey, bytes: resultBytes, contentType: "image/png" });
  const snapshot = { ...first.snapshot, id: randomUUID(), attachedInputs: [attachment] };
  const childTask = { ...first.childTask, id: randomUUID(), snapshotId: snapshot.id };
  const attempt = { ...first.attempt, id: randomUUID(), snapshotId: snapshot.id, childTaskId: childTask.id };
  await repository.submit({ idempotencyKey: "with-attached-inputs", snapshot, childTask, attempt });
  await repository.completeAttempt({
    attemptId: attempt.id, objectKey: "existing-version", sha256: "a".repeat(64), width: 1024, height: 1024,
    mimeType: "image/png", completedAt: new Date().toISOString(),
  });
  const failedAttempt = await repository.appendAttempt({
    idempotencyKey: "previous-regeneration", snapshot, childTask: (await repository.getChildTask(childTask.id))!,
    attempt: { ...attempt, id: randomUUID() },
  });
  await repository.failAttempt(failedAttempt.attempt.id, "MODEL_FAILED", "上次生成失败", new Date().toISOString());

  const path = `/api/image-editor/tasks/${childTask.id}/regenerate`;
  const request = { headers: { "idempotency-key": "regenerate" }, body: { summary: "用于界面展示的摘要" } };
  const submitted = await api.request("POST", path, request);
  assert.equal(submitted.status, 202);
  const { childTask: regenerating } = (submitted.body as { data: typeof first }).data;
  assert.equal(regenerating.status, "generating");
  assert.equal(regenerating.errorCode, null);
  assert.equal(regenerating.errorMessage, null);
  assert.equal((await api.request("POST", path, request)).status, 200);
  for (let i = 0; i < 30 && (await repository.listVersions(childTask.id)).length < 2; i += 1) await settle();
  assert.equal((await repository.listAttempts(childTask.id)).length, 3);
  assert.equal((await repository.listVersions(childTask.id)).length, 2);
  assert.equal(calls.length, 2);
  const initial = calls[0];
  const replay = calls[1];
  assert.match(initial.prompt, /仅重绘蒙版白色选区：局部重绘/);
  assert.equal(replay.prompt, initial.prompt);
  assert.ok(initial.mask?.length);
  assert.deepEqual(replay.mask, initial.mask);
  assert.deepEqual(replay.images?.map(({ role, bytes }) => ({ role, bytes })), [
    { role: "source", bytes }, { role: "product", bytes: resultBytes },
  ]);
  assert.equal(replay.size, "1024x1360");
  assert.equal(replay.quality, "high");

  await requestImageEditorEdit(imageProvider, storage, "gpt-image-2", { ...options, quality: "medium" },
    first.attempt.command, { ...editorSource, width: 1027, height: 1824 });
  assert.equal(calls[2].quality, "medium");
  assert.equal(calls[2].size, "1024x1824");
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
  for (const tool of ["add_text", "change_text", "redraw"]) {
    const submitted = await service.submit({ sessionId: "session", idempotencyKey: `prompt-${tool}`, sourceCardId: "parent", sourceVersionId: "version-1", tool });
    assert.equal(submitted.snapshot.sourcePrompt, "SOURCE VERSION PROMPT");
  }
  await settle();
  const [add, change, redraw] = commands.map((command) => command.prompt);
  assert.match(add, /横向约 20%–60%/);
  assert.match(add, /新品主视觉/);
  assert.match(add, /使用醒目的无衬线标题/);
  assert.match(change, /顶部居中区域（横向约 10%–60%，纵向约 10%–30%）/);
  assert.match(change, /旧标语.*新标语/);
  assert.match(redraw, /仅重绘蒙版白色选区：替换为柔和木纹桌面/);
  for (const { prompt } of commands) {
    assert.match(prompt, /严格保持输入图片中的商品主体外观/);
    assert.doesNotMatch(prompt, /SOURCE VERSION PROMPT|strokes|ocrSnapshot/);
  }

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
