import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createSuiteStudioApp } from "../server/app.js";
import { MemoryLibraryRepository } from "../server/repositories/memory-library-repository.js";
import { MemoryReverseRepository } from "../server/repositories/memory-reverse-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryTaskRepository } from "../server/repositories/memory-task-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";
import type { ReversePlan } from "../server/types.js";

const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const pngBytes = Buffer.from(pngBase64, "base64");

async function seedLegacyReversePlan(
  reverseRepository: MemoryReverseRepository,
  storage: MemoryStorage,
  mode: "main" | "detail" = "detail",
) {
  const now = "2026-10-01T08:00:00.000Z";
  const planId = "legacy-reverse-plan-1";
  const refId = "legacy-reverse-ref-1";
  const attemptId = "legacy-reverse-attempt-1";
  const promptVersionId = "legacy-reverse-prompt-1";
  const objectKey = `reverse-plans/${planId}/references/${refId}/original`;
  const thumbnailObjectKey = `reverse-plans/${planId}/references/${refId}/thumbnail`;

  await storage.put({ key: objectKey, bytes: pngBytes, contentType: "image/png" });
  await storage.put({ key: thumbnailObjectKey, bytes: pngBytes, contentType: "image/jpeg" });

  const plan: ReversePlan = {
    id: planId,
    mode,
    status: "draft",
    baselineReferenceId: mode === "detail" ? refId : null,
    references: [
      {
        id: refId,
        planId,
        ordinal: 1,
        filename: "detail.png",
        mimeType: "image/png",
        sha256: "a".repeat(64),
        width: 800,
        height: 800,
        objectKey,
        thumbnailObjectKey,
        templateVersionId: "tv-detail",
        attempts: [
          {
            id: attemptId,
            referenceId: refId,
            status: "succeeded",
            retryOfAttemptId: null,
            templateVersionId: "tv-detail",
            mode,
            baselineReferenceId: mode === "detail" ? refId : null,
            requestSummary: { provider: "qwen", model: "qwen-vl-max", inputRoles: ["reference"] },
            rawOutput: { schemaVersion: "reverse-prompt-v1", referenceImageId: refId, prompt: "以上传的产品白底图为唯一外观来源，提炼参考图的构图与光影。" },
            errorCode: null,
            errorMessage: null,
            promptVersionId,
            createdAt: now,
            completedAt: now,
          },
        ],
        promptVersions: [
          {
            id: promptVersionId,
            referenceId: refId,
            kind: "model",
            prompt: "以上传的产品白底图为唯一外观来源，提炼参考图的构图与光影。",
            rawOutput: null,
            templateVersionId: "tv-detail",
            mode,
            provider: { provider: "qwen", model: "qwen-vl-max" },
            createdAt: now,
          },
        ],
        effectivePromptVersionId: promptVersionId,
        createdAt: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
  await reverseRepository.savePlan(plan);
  return { planId, refId, attemptId, promptVersionId, plan };
}

test("reverse plan write endpoints return 410 REVERSE_PLAN_READ_ONLY without mutating legacy plans", async () => {
  const storage = new MemoryStorage();
  const reverseRepository = new MemoryReverseRepository();
  const seeded = await seedLegacyReversePlan(reverseRepository, storage, "main");
  const api = createSuiteStudioApp({
    repository: new MemorySuiteRepository(),
    storage,
    reverseRepository,
  });

  const writeRequests: Array<[string, string, unknown?]> = [
    ["POST", "/api/reverse-plans", { mode: "main" }],
    ["PATCH", `/api/reverse-plans/${seeded.planId}`, { mode: "detail" }],
    ["POST", `/api/reverse-plans/${seeded.planId}/references`, { filename: "new.png", mimeType: "image/png", bytesBase64: pngBase64 }],
    ["PATCH", `/api/reverse-plans/${seeded.planId}/references/${seeded.refId}`, { templateVersionId: "tv-main", ordinal: 1 }],
    ["DELETE", `/api/reverse-plans/${seeded.planId}/references/${seeded.refId}`],
    ["POST", `/api/reverse-plans/${seeded.planId}/references/${seeded.refId}/run`],
    ["POST", `/api/reverse-plans/${seeded.planId}/references/${seeded.refId}/retry`],
    ["POST", `/api/reverse-plans/${seeded.planId}/attempts`],
    ["PATCH", `/api/reverse-plans/${seeded.planId}/references/${seeded.refId}/prompt`, { prompt: "尝试修改历史提示词" }],
  ];

  for (const [method, path, body] of writeRequests) {
    const response = await api.request(method, path, {
      headers: { "idempotency-key": `ro-${method}-${path}` },
      body,
    });
    assert.equal(response.status, 410, `${method} ${path} should return 410`);
    assert.equal((response.body as any).error.code, "REVERSE_PLAN_READ_ONLY", `${method} ${path} should return REVERSE_PLAN_READ_ONLY`);
  }

  const unchanged = await reverseRepository.getPlan(seeded.planId);
  assert.equal(unchanged?.mode, "main");
  assert.equal(unchanged?.references.length, 1);
  assert.equal(unchanged?.references[0].promptVersions.length, 1);
});

test("legacy reverse plans remain readable with previews and asset archiving", async () => {
  const storage = new MemoryStorage();
  const reverseRepository = new MemoryReverseRepository();
  const libraryRepository = new MemoryLibraryRepository();
  const seeded = await seedLegacyReversePlan(reverseRepository, storage, "detail");
  const api = createSuiteStudioApp({
    repository: new MemorySuiteRepository(),
    storage,
    reverseRepository,
    libraryRepository,
  });

  const list = await api.request("GET", "/api/reverse-plans");
  assert.equal(list.status, 200);
  assert.equal((list.body as any).data.length, 1);
  assert.equal((list.body as any).data[0].id, seeded.planId);

  const detail = await api.request("GET", `/api/reverse-plans/${seeded.planId}`);
  assert.equal(detail.status, 200);
  assert.equal((detail.body as any).data.references[0].id, seeded.refId);

  const attempt = await api.request("GET", `/api/reverse-plans/${seeded.planId}/attempts/${seeded.attemptId}`);
  assert.equal(attempt.status, 200);
  assert.equal((attempt.body as any).data.status, "succeeded");

  const thumb = await api.previewReverseReference(seeded.planId, seeded.refId, "thumbnail");
  assert.equal(thumb.status, 200);
  assert.deepEqual(thumb.raw, pngBytes);

  const original = await api.previewReverseReference(seeded.planId, seeded.refId, "original");
  assert.equal(original.status, 200);
  assert.deepEqual(original.raw, pngBytes);

  const archived = await api.request("POST", `/api/reverse-plans/${seeded.planId}/references/${seeded.refId}/asset`, {
    headers: { "idempotency-key": "archive-legacy-ref" },
  });
  assert.equal(archived.status, 201);
  assert.equal((archived.body as any).data.resourceType, "reverse_reference_asset");
  assert.equal((archived.body as any).data.source.reversePlanId, seeded.planId);
  assert.equal((archived.body as any).data.source.referenceId, seeded.refId);
  assert.equal((archived.body as any).data.promptSnapshot.promptVersionId, seeded.promptVersionId);
});

test("legacy reverse plan canvas-imports stays idempotent and rejects replica and A+ target suites", async () => {
  const storage = new MemoryStorage();
  const suites = new MemorySuiteRepository();
  const tasks = new MemoryTaskRepository();
  const library = new MemoryLibraryRepository();
  const reverseRepository = new MemoryReverseRepository();
  const seeded = await seedLegacyReversePlan(reverseRepository, storage, "detail");
  const api = createSuiteStudioApp({
    repository: suites,
    storage,
    taskRepository: tasks,
    libraryRepository: library,
    reverseRepository,
  });

  const imported = await api.request("POST", `/api/reverse-plans/${seeded.planId}/canvas-imports`, {
    headers: { "idempotency-key": "canvas-import" },
    body: { name: "反推套图" },
  });
  assert.equal(imported.status, 201);
  const suiteId = (imported.body as any).data.suiteId;
  assert.equal((imported.body as any).data.taskIds.length, 1);

  const duplicate = await api.request("POST", `/api/reverse-plans/${seeded.planId}/canvas-imports`, {
    headers: { "idempotency-key": "canvas-import" },
    body: { name: "反推套图" },
  });
  assert.equal(duplicate.status, 200);
  assert.equal((duplicate.body as any).data.duplicate, true);

  const workbench = await api.request("GET", `/api/suites/${suiteId}/workbench`);
  const task = (workbench.body as any).data.tasks.find((item: any) => item.originKind === "reverse_import");
  assert.equal((workbench.body as any).data.suite.origin, "canvas");
  assert.ok(task);
  assert.equal(task.planSnapshotId, null);
  assert.equal(task.reversePlanId, seeded.planId);
  assert.equal(task.reverseReferenceId, seeded.refId);

  for (const origin of ["replica", "aplus"] as const) {
    const target = await suites.createSuite("已有批次", undefined, origin);
    const rejected = await api.request("POST", `/api/reverse-plans/${seeded.planId}/canvas-imports`, {
      headers: { "idempotency-key": `canvas-import-to-${origin}` },
      body: { targetSuiteId: target.id },
    });
    assert.equal(rejected.status, 400);
    assert.equal((rejected.body as any).error.code, "INVALID_SUITE_ORIGIN");
    assert.equal((await tasks.listTasks(target.id)).length, 0);
  }

  const existingCanvas = await suites.createSuite("已有画布", undefined, "canvas");
  const importedToCanvas = await api.request("POST", `/api/reverse-plans/${seeded.planId}/canvas-imports`, {
    headers: { "idempotency-key": "canvas-import-to-canvas" },
    body: { targetSuiteId: existingCanvas.id },
  });
  assert.equal(importedToCanvas.status, 201);
  assert.equal((importedToCanvas.body as any).data.suiteId, existingCanvas.id);
});

test("ReversePage is read-only with upgrade banner and WorkbenchBoardPage skips polling for replica and A+ suites", async () => {
  const reversePage = await readFile("src/pages/ReversePage.tsx", "utf8");
  assert.match(reversePage, /爆品图反推已升级为爆品图复刻/);
  assert.match(reversePage, /\/create\/replica/);
  assert.match(reversePage, /canvas-imports/);
  assert.match(reversePage, /\/asset/);
  assert.match(reversePage, /readOnly/);
  assert.doesNotMatch(reversePage, /type="file"/);
  assert.doesNotMatch(reversePage, /\/attempts/);
  assert.doesNotMatch(reversePage, /\/(run|retry)/);
  assert.doesNotMatch(reversePage, /\/prompt`/);
  assert.doesNotMatch(reversePage, /"DELETE"/);
  assert.doesNotMatch(reversePage, /"PATCH"/);
  assert.doesNotMatch(reversePage, /api<Plan>\("\/api\/reverse-plans"/);

  const workbenchPage = await readFile("src/pages/WorkbenchBoardPage.tsx", "utf8");
  assert.match(
    workbenchPage,
    /useEffect\(\(\) => \{\s*if \(workbench\?\.suite\.origin === "replica" \|\| workbench\?\.suite\.origin === "aplus"\) return;\s*const ordinaryTaskRunning/,
  );
});
