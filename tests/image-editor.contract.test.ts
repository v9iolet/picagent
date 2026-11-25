import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import { buildImageEditPrompt, imageEditProductInputs, ImageEditorService, MemoryImageEditorRepository, type EditOperation, type ImageEditCommand, type ImageEditProvider, type ImageSource } from "../server/image-editor.js";
import { createImageEditorApi } from "../server/image-editor-api.js";
import { createSuiteStudioApp } from "../server/app.js";
import { dispatchInputImageUpload } from "../server/multipart.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryTaskRepository } from "../server/repositories/memory-task-repository.js";
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
  assert.match(retried.attempt.command.prompt, /\n只执行以下修改：更新后的草稿$/);
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

test("OCR capability reports whether the configured resolver has a provider without running recognition", async () => {
  let configured = false;
  let recognitions = 0;
  const ocr = { name: "fake-ocr", version: "1", recognize: async () => { recognitions++; return { blocks: [] }; } };
  const service = new ImageEditorService(new MemoryImageEditorRepository(), provider(), new MemoryStorage(), async () => source,
    async () => configured ? ocr : null);
  assert.equal((await service.capabilities()).capabilities.ocr, false);
  configured = true;
  assert.equal((await service.capabilities()).capabilities.ocr, true);
  assert.equal(recognitions, 0);
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

test("change_text batches only changed rows and sends one source image without a mask", async () => {
  const repository = new MemoryImageEditorRepository();
  const storage = new MemoryStorage();
  const bytes = await sharp({ create: { width: 100, height: 100, channels: 3, background: "#ffffff" } }).png().toBuffer();
  const editSource: ImageSource = {
    ...source, bytes, generationPrompt: "原始生图提示词",
    productInputs: [{ objectKey: "product/original.jpg", role: "product" }],
  };
  const calls: ImageEditRequest[] = [];
  const service = new ImageEditorService(repository, provider({
    edit: (command, image) => requestImageEditorEdit({
      edit: async (request) => { calls.push(request); return { bytes, mimeType: image.mimeType }; },
    }, storage, "gpt-image-2", defaultImageOptions("gpt-image-2"), command, image),
  }), storage, async () => editSource);
  const api = createImageEditorApi(service);
  const rows = [
    { originalText: "保持原样", newText: "保持原样", boundingBox: { x: 0.41, y: 0.1, width: 0.2, height: 0.1 } },
    { originalText: "标题", newText: '新“标题”\n第二行', boundingBox: { x: 0.1, y: 0.1, width: 0.3, height: 0.1, rotation: 0 } },
    { originalText: "商品卖点", newText: "快充", boundingBox: { x: 0.3, y: 0.43, width: 0.1, height: 0.1, rotation: 5 } },
    { originalText: "过期标签", newText: "", boundingBox: { x: 0.7, y: 0.7, width: 0.2, height: 0.1 } },
  ];
  for (const [index, row] of rows.entries()) {
    const { originalText, newText, boundingBox } = row;
    await service.upsertOperation({ sessionId: "text-session", operation: {
      ...operation("change_text"), operationId: `line-${index}`, summary: originalText,
      payload: { originalText, newText: newText === "" ? " \t\n　" : newText, region: boundingBox, mask: { objectKey: "ignore" }, attachedInputs: ["ignore"] },
    } });
  }
  const input = { sourceCardId: "parent", sourceVersionId: "version-1", tool: "change_text" };
  const submit = (id: string, operationIds: string[]) => api.request("POST", "/api/image-editor/sessions/text-session/submit", {
    headers: { "idempotency-key": id },
    body: { ...input, operationIds },
  });
  assert.equal((await submit("unchanged", ["line-0"])).status, 409);
  assert.equal(calls.length, 0);
  assert.equal((await submit("batch", ["line-0", "line-1", "line-2", "line-3"])).status, 202);
  await settle();

  const [call] = calls;
  assert.equal(calls.length, 1);
  assert.deepEqual(call.images?.map(({ bytes, role }) => [bytes, role]), [[bytes, "source"]]);
  assert.equal(call.mask, undefined);
  assert.equal(call.maskMimeType, undefined);
  assert.match(call.prompt, /^严格保持输入图片中的商品主体外观/);
  assert.match(call.prompt, /newText 为空时移除原文字，用周围背景自然填补/);
  assert.ok(call.prompt.includes(JSON.stringify(rows.slice(1), null, 2)));
  assert.match(call.prompt, /1\. 顶部左侧区域（横向约 10%–40%，纵向约 10%–20%）/);
  assert.match(call.prompt, /2\. 中部居中区域（横向约 30%–40%，纵向约 43%–53%）/);
  assert.match(call.prompt, /3\. 底部右侧区域（横向约 70%–90%，纵向约 70%–80%）：移除原文字，用周围背景自然填补。/);
  assert.doesNotMatch(call.prompt, /保持原样|原始生图提示词|替换为“\s*”/);
  const [result] = await service.listAllTasks();
  assert.deepEqual(result.snapshot?.operations.map(({ operationId, order }) => [operationId, order]), [
    ["line-1", 1], ["line-2", 2], ["line-3", 3],
  ]);
  assert.deepEqual(result.snapshot?.attachedInputs, []);
  assert.equal(result.snapshot?.maskApplied, false);
  assert.equal(result.snapshot?.operations[2].payload.newText, "");
});

test("change_text accepts 50 changes and 500-character fields and reports which limit was exceeded", async () => {
  const service = new ImageEditorService(new MemoryImageEditorRepository(), provider(), new MemoryStorage(), async () => source);
  const api = createImageEditorApi(service);
  const upsert = (operationId: string, originalText: string, newText: string) => service.upsertOperation({
    sessionId: "limits",
    operation: { ...operation("change_text"), operationId, payload: { originalText, newText, region: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 } } },
  });
  const submit = (id: string, operationIds: string[]) => api.request("POST", "/api/image-editor/sessions/limits/submit", {
    headers: { "idempotency-key": id },
    body: { sourceCardId: "parent", sourceVersionId: "version-1", tool: "change_text", operationIds },
  });
  const expectError = async (id: string, operationIds: string[], code: string) => {
    const result = await submit(id, operationIds);
    assert.equal(result.status, 409);
    assert.equal((result.body as { error: { code: string } }).error.code, code);
  };
  const original = "原".repeat(500);
  const replacement = "新".repeat(500);
  await upsert("oversized-original", original + "字", replacement);
  await upsert("oversized-replacement", original, replacement + "字");
  await expectError("original-limit", ["oversized-original"], "CHANGE_TEXT_ORIGINAL_TEXT_TOO_LONG");
  await expectError("replacement-limit", ["oversized-replacement"], "CHANGE_TEXT_NEW_TEXT_TOO_LONG");

  const changedIds = Array.from({ length: 50 }, (_, index) => `line-${index}`);
  for (const id of changedIds) await upsert(id, original, replacement);
  await upsert("one-too-many", "另一个原文", "另一个新文");
  await upsert("unchanged", "同一行", "同一行");
  await expectError("count-limit", [...changedIds, "one-too-many"], "CHANGE_TEXT_TOO_MANY_OPERATIONS");
  assert.equal((await service.listAllTasks()).length, 0);
  assert.equal((await submit("at-limits", [...changedIds, "unchanged"])).status, 202);
  const [result] = await service.listAllTasks();
  assert.equal(result.snapshot?.operations.length, 50);
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

test("submission freezes sourcePrompt while compiling pure product-fidelity prompts for local edits", async () => {
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
});

test("AI editing uses the frozen prompt for missing or blank input and wraps only the requested changes otherwise", () => {
  const frozen = "原版商品海报\n使用深色背景，将商品放在右侧。";
  const build = (payload: EditOperation["payload"]) => buildImageEditPrompt([{ ...operation(), payload }], frozen);
  for (const payload of [{}, { prompt: "" }, { prompt: " \n　" }]) assert.equal(build(payload), frozen);

  const instruction = "将商品向左移一点\n换成浅灰色背景";
  const prompt = build({ prompt: ` ${instruction}\n` });
  assert.match(prompt, /^严格保持待编辑图中未指定修改的商品主体外观/);
  assert.equal(prompt.slice(prompt.indexOf("\n") + 1), `只执行以下修改：${instruction}`);
  assert.ok(!prompt.includes(frozen));
});

test("regenerate reads a legacy re_edit snapshot and replays its original command", async () => {
  const repository = new MemoryImageEditorRepository();
  const originalOperation = { ...operation(), payload: { prompt: "旧版保存的整段重编辑提示词" } };
  const fakeProvider = provider();
  const { name, version, capabilitiesVersion } = fakeProvider;
  const providerSnapshot = { name, version, capabilitiesVersion };
  const createdAt = new Date().toISOString();
  const snapshot = {
    id: "legacy-snapshot", sourceCardId: "parent", sourceVersionId: "version-1", parentVersionId: "version-1",
    summary: originalOperation.summary, sourcePrompt: "来源版本的生成提示词", operations: [originalOperation],
    provider: providerSnapshot, createdAt, schemaVersion: "image-edit-snapshot-v1" as const,
  };
  const task = {
    id: "legacy-child", sourceCardId: "parent", sourceVersionId: "version-1", parentVersionId: "version-1",
    summary: snapshot.summary, snapshotId: snapshot.id, status: "generating" as const, currentVersionId: null, finalVersionId: null,
    errorCode: null, errorMessage: null, createdAt, updatedAt: createdAt,
  };
  const command = {
    type: "re_edit" as const, sourceVersionId: "version-1", prompt: originalOperation.payload.prompt, operations: [originalOperation],
  };
  await repository.submit({ idempotencyKey: "legacy-first", snapshot, childTask: task, attempt: {
    id: "legacy-attempt", childTaskId: task.id, snapshotId: snapshot.id, attemptNo: 1, status: "generating",
    command, provider: providerSnapshot, errorCode: null, errorMessage: null, createdAt, completedAt: null,
  } });
  await repository.completeAttempt({ attemptId: "legacy-attempt", objectKey: "legacy-result", sha256: "legacy-hash", width: 100, height: 100, mimeType: "image/png", completedAt: createdAt });

  const requested = Promise.withResolvers<ImageEditCommand>();
  const service = new ImageEditorService(repository, provider({ edit: async (replayed) => {
    requested.resolve(replayed);
    return fakeProvider.edit(replayed, source);
  } }), new MemoryStorage(), async () => ({ ...source, generationPrompt: "现在的生成提示词" }));
  assert.deepEqual((await service.getTask(task.id))?.snapshot, snapshot);
  const replay = await service.regenerate({ childTaskId: task.id, idempotencyKey: "legacy-replay" });
  assert.equal(replay.childTask.id, task.id);
  assert.equal(replay.attempt.snapshotId, snapshot.id);
  assert.deepEqual(await requested.promise, { ...command, attachedInputs: undefined, maskApplied: undefined });
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

test("editing attaches the version's product inputs in order only for the applicable tools", async () => {
  const storage = new MemoryStorage();
  const repository = new MemoryImageEditorRepository();
  const bytes = await sharp({ create: { width: 20, height: 20, channels: 3, background: "white" } }).png().toBuffer();
  const productInputs = imageEditProductInputs([
    { objectKey: "first", role: "product_primary" },
    { objectKey: "style", role: "replica_reference" },
    { objectKey: "second", role: "product_detail" },
    { objectKey: "second", role: "product" },
  ]);
  await storage.put({ key: "first", bytes: Buffer.from("first"), contentType: "image/png" });
  await storage.put({ key: "second", bytes: Buffer.from("second"), contentType: "image/png" });
  assert.deepEqual(productInputs, [{ objectKey: "first", role: "product" }, { objectKey: "second", role: "product" }]);
  const editorSource = { ...source, bytes, productInputs, generationPrompt: "版本冻结的生成提示词" };
  const calls: ImageEditRequest[] = [];
  const fakeImageProvider = {
    async edit(request: ImageEditRequest) {
      calls.push(request);
      return { bytes, mimeType: "image/png" };
    },
  };
  const service = new ImageEditorService(repository, provider({
    edit: (command) => requestImageEditorEdit(fakeImageProvider, storage, "gpt-image-2", defaultImageOptions("gpt-image-2"), command, editorSource),
  }), storage, async () => editorSource);
  const region = { x: 0.1, y: 0.1, width: 0.5, height: 0.2 };
  const operations: Array<{ op: EditOperation; attaches: boolean }> = [
    { op: { ...operation("re_edit"), payload: { prompt: "" } }, attaches: true },
    { op: operation("re_edit"), attaches: true },
    { op: operation("redraw"), attaches: true },
    { op: { ...operation("outpaint"), payload: { direction: "all", targetRatio: "3:4" } }, attaches: true },
    { op: { ...operation("add_text"), payload: { text: "标题", prompt: "使用黑体" } }, attaches: false },
    { op: { ...operation("change_text"), payload: { originalText: "旧文字", newText: "新文字", region, prompt: "保留字体" } }, attaches: false },
    { op: { ...operation("redraw"), type: "erase" }, attaches: false },
  ];
  for (const [i, { op, attaches }] of operations.entries()) {
    await service.upsertOperation({ sessionId: "parent", operation: op });
    const result = await service.submit({ sessionId: "parent", idempotencyKey: `${op.type}-${i}`, sourceCardId: "parent", sourceVersionId: "version-1", tool: op.type });
    assert.deepEqual(result.snapshot.attachedInputs, attaches ? productInputs : []);
    for (let check = 0; check < 30 && calls.length <= i; check += 1) await settle();
    const call = calls[i];
    assert.ok(call);
    assert.deepEqual(call.images?.map((image) => [image.role, image.bytes]), attaches
      ? [["source", bytes], ["product", Buffer.from("first")], ["product", Buffer.from("second")]]
      : [["source", bytes]]);
    if (attaches) assert.match(call.prompt, /^第 1 张为待编辑图，其余为商品外观依据，不得复制其背景与文字/);
    else assert.doesNotMatch(call.prompt, /商品外观依据/);
    if (op.type === "re_edit") {
      assert.equal(call.mask, undefined);
      if (op.payload.prompt) {
        assert.match(call.prompt, /\n严格保持待编辑图中未指定修改的商品主体外观[^\n]+\n只执行以下修改：调整背景$/);
        assert.ok(!call.prompt.includes(editorSource.generationPrompt));
      } else {
        assert.equal(call.prompt.split("\n").slice(1).join("\n"), editorSource.generationPrompt);
      }
    }
  }
});

test("product restoration defaults to all originals, accepts one candidate or a session upload, and freezes the choice", async () => {
  const repository = new MemoryImageEditorRepository();
  const storage = new MemoryStorage();
  const png = await sharp({ create: { width: 200, height: 200, channels: 3, background: "red" } }).png().toBuffer();
  const jpeg = await sharp(png).jpeg().toBuffer();
  const webp = await sharp(png).webp().toBuffer();
  const productInputs = ["batch/product-1", "batch/product-2"].map((objectKey) => ({ objectKey, role: "product" }));
  await storage.put({ key: productInputs[0].objectKey, bytes: jpeg, contentType: "image/jpeg" });
  await storage.put({ key: productInputs[1].objectKey, bytes: webp, contentType: "image/webp" });
  const calls: ImageEditRequest[] = [];
  const uploader = (sessionId: string, versionId: string) => `/api/image-editor/sessions/${sessionId}/versions/${versionId}/restore-inputs`;
  const service = new ImageEditorService(repository, provider({
    edit: (command, image) => requestImageEditorEdit({
      async edit(request) {
        calls.push(request);
        return { bytes: png, mimeType: "image/png" };
      },
    }, storage, "gpt-image-2", defaultImageOptions("gpt-image-2"), command, image),
  }), storage, async (id) => ({ ...source, bytes: png, productInputs: id === "version-1" ? productInputs : [] }), undefined,
  async (session, version) => session === "parent" && ["version-1", "canvas-version"].includes(version));
  const api = createImageEditorApi(service);
  const app = createSuiteStudioApp({ repository: new MemorySuiteRepository(), storage, imageEditorApi: api });
  const session = "/api/image-editor/sessions/parent";
  const draft = await api.request("GET", `${session}?sourceVersionId=version-1`);
  assert.equal(draft.status, 200);
  const candidates = (draft.body as { data: { productInputs: Array<{ objectKey: string; thumbnailUrl: string }> } }).data.productInputs;
  assert.deepEqual(candidates.map((image) => image.objectKey), productInputs.map((input) => input.objectKey));
  const thumbnail = await api.request("GET", candidates[0].thumbnailUrl);
  assert.equal(thumbnail.status, 200);
  assert.equal((await sharp(thumbnail.raw).metadata()).width, 160);
  assert.equal((await api.request("GET", candidates[0].thumbnailUrl.replace("/parent/", "/another/"))).status, 404);

  const uploadPath = uploader("parent", "canvas-version");
  const form = new FormData();
  form.append("file", new Blob([Uint8Array.from(png)], { type: "image/png" }), "依据图.png");
  const request = new Request("http://local.test", { method: "POST", body: form });
  const upload = await dispatchInputImageUpload(app, uploadPath, Buffer.from(await request.arrayBuffer()), {
    "content-type": request.headers.get("content-type") ?? "",
  });
  assert.equal(upload?.status, 201);
  const uploaded = (upload?.body as { data: { objectKey: string; thumbnailUrl: string } }).data;
  assert.match(uploaded.objectKey, /^image-edits\/sessions\/parent\/versions\/canvas-version\/restore-inputs\//);
  assert.equal((await api.request("GET", uploaded.thumbnailUrl)).status, 200);
  for (const [bytes, mimeType, expected] of [
    [jpeg, "image/jpeg", 201], [webp, "image/webp", 201], [png, "image/jpeg", 400],
    [Buffer.alloc(10 * 1024 * 1024 + 1), "image/png", 413],
    [Buffer.from("text"), "image/png", 400],
  ] as const) {
    assert.equal((await api.request("POST", uploadPath, { body: { bytes, mimeType } })).status, expected);
  }
  assert.equal((await api.request("POST", uploader("another", "canvas-version"), { body: { bytes: png, mimeType: "image/png" } })).status, 400);

  const submit = async (key: string, sourceVersionId: string, referenceObjectKeys?: string[]) => {
    const op = { ...operation("restore_product"), sourceVersionId, payload: referenceObjectKeys ? { referenceObjectKeys } : {} };
    await api.request("POST", `${session}/operations`, { body: { operation: op } });
    return api.request("POST", `${session}/submit`, {
      headers: { "idempotency-key": key }, body: { sourceCardId: "parent", sourceVersionId, tool: op.type },
    });
  };
  const cases = [
    ["default", "version-1", undefined, productInputs.map((input) => input.objectKey), [jpeg, webp]],
    ["single", "version-1", [productInputs[1].objectKey], [productInputs[1].objectKey], [webp]],
    ["upload", "canvas-version", [uploaded.objectKey], [uploaded.objectKey], [png]],
  ] as const;
  for (const [i, [key, version, selection, keys, images]] of cases.entries()) {
    const result = await submit(key, version, selection ? [...selection] : undefined);
    assert.equal(result.status, 202);
    const { snapshot, attempt } = (result.body as { data: Awaited<ReturnType<typeof service.submit>> }).data;
    assert.equal(snapshot.tool, "restore_product");
    assert.deepEqual(snapshot.attachedInputs, keys.map((objectKey) => ({ objectKey, role: "product" })));
    assert.deepEqual(snapshot.operations[0].payload, { referenceObjectKeys: keys });
    assert.equal(snapshot.maskApplied, false);
    assert.match(attempt.command.prompt, /^第 1 张为待编辑图[\s\S]*保持原图的构图、背景、文字[\s\S]*形状、结构比例、颜色、材质/);
    for (let check = 0; check < 30 && calls.length <= i; check += 1) await settle();
    assert.deepEqual(calls[i].images?.map((image) => image.bytes), [png, ...images]);
  }
  for (const [key, version, selection, code] of [
    ["required", "canvas-version", undefined, "RESTORE_PRODUCT_REFERENCE_REQUIRED"],
    ["bad-keys", "version-1", ["unrelated"], "RESTORE_PRODUCT_REFERENCE_INVALID"],
    ["other-version", "version-1", [uploaded.objectKey], "RESTORE_PRODUCT_REFERENCE_INVALID"],
    ["multiple", "version-1", productInputs.map((input) => input.objectKey), "RESTORE_PRODUCT_REFERENCE_INVALID"],
  ] as const) {
    const result = await submit(key, version, selection ? [...selection] : undefined);
    assert.equal(result.status, 409);
    assert.equal((result.body as { error: { code: string } }).error.code, code);
  }
  assert.equal((await repository.listChildTasks()).length, 3);
});

test("regenerating from the editor uses the exact opened task version and frozen product inputs", async () => {
  const storage = new MemoryStorage();
  const taskRepository = new MemoryTaskRepository();
  const calls: ImageEditRequest[] = [];
  const image = (background: string) => sharp({ create: { width: 30, height: 30, channels: 3, background } }).png().toBuffer();
  const [original, generated] = await Promise.all([image("red"), image("blue")]);
  const app = createSuiteStudioApp({
    repository: new MemorySuiteRepository(), taskRepository, storage,
    provider: { async edit(request) { calls.push(request); return { bytes: generated, mimeType: "image/png" }; } },
  });
  const resultData = <T>(result: { body: unknown }) => (result.body as { data: T }).data;
  const suiteId = resultData<{ id: string }>(await app.request("POST", "/api/suites", { body: { name: "画布", origin: "canvas" } })).id;
  const uploaded = await app.upload(suiteId, { filename: "product.png", bytes: original, mimeType: "image/png" });
  const { id: inputId, originalObjectKey } = resultData<{ id: string; originalObjectKey: string }>(uploaded);
  const taskId = resultData<{ id: string }>(await app.request("POST", `/api/suites/${suiteId}/tasks/custom`, {
    body: { imageType: "main", title: "商品", promptDraft: "原始生成提示词", sourceInputImageId: inputId },
  })).id;
  const generate = (key: string, body: Record<string, unknown> = {}) => app.request("POST", `/api/suite-tasks/${taskId}/generation`, {
    body, headers: { "idempotency-key": key },
  });
  const waitForVersions = async (count: number) => {
    for (let check = 0; check < 30; check += 1) {
      const history = await taskRepository.listTaskVersions(taskId);
      if (history.versions.length === count) return history.versions;
      await settle();
    }
    throw new Error("Generation did not complete");
  };
  assert.equal((await generate("first")).status, 202);
  const [first] = await waitForVersions(1);
  assert.equal((await generate("legacy", { promptDraft: "新的草稿" })).status, 202);
  const [legacy] = await waitForVersions(2);
  assert.equal((await generate("edit", { editSourceVersionId: first.id })).status, 202);
  const [regenerated] = await waitForVersions(3);
  assert.equal((await taskRepository.getTask(taskId))?.promptDraft, "新的草稿");
  assert.equal(regenerated.contextSnapshot.sourceVersionId, first.id);
  assert.deepEqual(regenerated.contextSnapshot.attachedInputs, [{ objectKey: originalObjectKey, role: "product" }]);
  assert.deepEqual(calls[2].images?.map(({ role, bytes }) => [role, bytes]), [
    ["source", (await storage.get(first.objectKey))?.bytes], ["product", original],
  ]);
  assert.match(calls[2].prompt, /^第 1 张为待编辑图[\s\S]*原始生成提示词$/);
  assert.equal((await generate("legacy-edit", { editSourceVersionId: legacy.id })).status, 202);
  const [fromLegacy] = await waitForVersions(4);
  assert.deepEqual(fromLegacy.contextSnapshot.attachedInputs, regenerated.contextSnapshot.attachedInputs);
  assert.match(calls[3].prompt, /新的草稿$/);
});
