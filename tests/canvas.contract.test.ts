import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { createTicket02App } from "../server/app.js";
import { MemoryLibraryRepository } from "../server/repositories/memory-library-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryTaskRepository } from "../server/repositories/memory-task-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";
import type { ImageProvider, LibraryResource } from "../server/types.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

function fixture() {
  const storage = new MemoryStorage();
  const library = new MemoryLibraryRepository();
  const calls: Parameters<ImageProvider["edit"]>[0][] = [];
  const api = createTicket02App({ repository: new MemorySuiteRepository(), taskRepository: new MemoryTaskRepository(), libraryRepository: library, storage,
    provider: { edit: async (request) => { calls.push(request); return { bytes: png, mimeType: "image/png" }; } },
  });
  const create = async (name: string, origin?: "canvas") => {
    const res = await api.request("POST", "/api/suites", { body: { name, origin } });
    assert.equal(res.status, 201);
    return (res.body as any).data;
  };
  const addTask = async (suiteId: string) => {
    const res = await api.request("POST", `/api/suites/${suiteId}/tasks/custom`, { body: { title: "测试卡", promptDraft: "展示商品", sourceInputImageId: null } });
    assert.equal(res.status, 201);
    const task = (res.body as any).data;
    assert.equal(task.status, "incomplete");
    return task.id;
  };
  const generate = (taskId: string, key = "generate") => api.request("POST", `/api/suite-tasks/${taskId}/generation`, { headers: { "idempotency-key": key } });
  const upload = async (suiteId: string, bytes = png) => {
    const res = await api.upload(suiteId, { bytes, filename: "商品.png", mimeType: "image/png" });
    assert.equal(res.status, 201);
    return (res.body as any).data;
  };
  const workbench = async (suiteId: string) => {
    const res = await api.request("GET", `/api/suites/${suiteId}/workbench`);
    assert.equal(res.status, 200);
    return (res.body as any).data;
  };
  const waitForBatch = async (suiteId: string, batchId: string) => {
    for (let i = 0; i < 100; i++) {
      const board = await workbench(suiteId);
      const batch = board.batches.find((item: { id: string }) => item.id === batchId);
      assert.ok(batch);
      if (batch.status === "completed") return board;
      assert.equal(batch.status, "running");
      await setTimeout(10);
    }
    assert.fail("Expected the generation batch to complete");
  };
  return { api, storage, library, calls, create, addTask, generate, upload, workbench, waitForBatch };
}

test("canvas list retains blank canvas and studio tasks but excludes empty studio drafts", async () => {
  const f = fixture();
  const canvas = await f.create("空白画布", "canvas");
  assert.equal(canvas.origin, "canvas");
  const draft = await f.create("空草稿");
  assert.equal(draft.origin, "suite_studio");
  await f.upload(draft.id);
  const studio = await f.create("有卡套图");
  await f.addTask(studio.id);
  const res = await f.api.request("GET", "/api/suites?view=canvas");
  assert.equal(res.status, 200);
  assert.deepEqual(new Set((res.body as any).data.map((suite: { id: string }) => suite.id)), new Set([canvas.id, studio.id]));
  const board = await f.workbench(canvas.id);
  assert.equal(board.suite.origin, "canvas");
  assert.equal(board.planSnapshot, null);
  assert.equal(board.effectiveStyleGuide, "未设置");
});

test("unbound canvas card rejects generation until a same-suite product image is selected", async () => {
  const f = fixture();
  const canvas = await f.create("手工画布", "canvas");
  const image = await f.upload(canvas.id);
  const taskId = await f.addTask(canvas.id);
  const rejected = await f.generate(taskId);
  assert.equal(rejected.status, 409);
  assert.equal((rejected.body as any).error.code, "TASK_INVALID_SOURCE");
  assert.equal(f.calls.length, 0);
  const other = await f.create("其他方案");
  const outsideImage = await f.upload(other.id);
  const bind = (sourceInputImageId: string) => f.api.request("PATCH", `/api/suite-tasks/${taskId}`, { body: { sourceInputImageId } });
  assert.equal((await bind(outsideImage.id)).status, 409);
  const bound = await bind(image.id);
  assert.equal(bound.status, 200);
  assert.equal((bound.body as any).data.status, "pending");
  const generated = await f.generate(taskId);
  assert.equal(generated.status, 202);
  await f.waitForBatch(canvas.id, (generated.body as any).data.batchId);
  const replacement = await f.upload(canvas.id, Buffer.concat([png, Buffer.from([1])]));
  assert.equal((await bind(replacement.id)).status, 200);
  const regenerated = await f.generate(taskId, "with-new-source");
  assert.equal(regenerated.status, 202);
  const board = await f.waitForBatch(canvas.id, (regenerated.body as any).data.batchId);
  assert.equal(board.tasks[0].sourceInputImageId, replacement.id);
  assert.equal(board.tasks[0].attempts.find((attempt: { sourceInputImageId: string }) => attempt.sourceInputImageId === replacement.id)?.sourceObjectKey, replacement.originalObjectKey);
  assert.equal(f.calls.length, 2);
});

test("white-resource binds and generates from published input_image on an ordinary canvas task", async () => {
  const f = fixture();
  const canvas = await f.create("资源画布", "canvas");
  const taskId = await f.addTask(canvas.id);
  const sourceSuite = await f.create("原图来源");
  const image = await f.upload(sourceSuite.id);
  const resource: LibraryResource = {
    id: `input:${image.id}`, resourceType: "input_image", title: image.originalFilename, summary: "", mimeType: image.mimeType,
    previewUrl: image.thumbnailPreviewUrl, suiteId: sourceSuite.id, taskId: null, imageVersionId: null, baseVersionId: null,
    templateVersionId: null, resourceVersionId: image.id, stage: null, source: { objectKey: image.originalObjectKey },
    status: "published", createdAt: image.createdAt, updatedAt: image.createdAt,
  };
  f.library.addResource({ ...resource, id: "draft", status: "draft" });
  f.library.addResource(resource);
  const bind = (resourceId: string) => f.api.request("POST", `/api/suite-tasks/${taskId}/white-resource`, { headers: { "idempotency-key": `bind-${resourceId}` }, body: { resourceId } });
  assert.equal((await bind("draft")).status, 403);
  const bound = await bind(resource.id);
  assert.equal(bound.status, 201);
  assert.equal((bound.body as any).data.task.status, "pending");
  assert.equal((bound.body as any).data.reference.resourceType, "input_image");
  const generated = await f.generate(taskId);
  assert.equal(generated.status, 202);
  const board = await f.waitForBatch(canvas.id, (generated.body as any).data.batchId);
  const [attempt] = board.tasks[0].attempts;
  assert.equal(attempt.status, "succeeded");
  assert.equal(attempt.sourceKind, "library");
  assert.equal(attempt.sourceResourceVersionId, image.id);
  assert.equal(attempt.sourceBaseVersionId, null);
  assert.deepEqual(f.calls.map((call) => call.image), [png]);
});
