import assert from "node:assert/strict";
import test from "node:test";
import {
  applyStyleOverrideToPrompt,
  computeLineageHighlight,
  computeOutpaintPreviewBox,
  computeWorkbenchLanes,
  evaluateDeliveryCompliance,
  resolveDeliverySlots,
  type DeliveryEditChildLike,
  type DeliveryTaskLike,
} from "../shared/workbench-delivery.js";

test("applyStyleOverrideToPrompt replaces existing global style line idempotently", () => {
  const base = [
    "系统安全约束：不得生成违法内容。",
    "全局风格卡：柔和自然光，白色背景",
    "当前类别提示词：正面主图",
  ].join("\n");

  const once = applyStyleOverrideToPrompt(base, "极简科技风，冷色调影棚打光");
  assert.match(once, /^全局风格卡：极简科技风，冷色调影棚打光$/m);
  assert.doesNotMatch(once, /柔和自然光/);
  assert.equal(applyStyleOverrideToPrompt(once, "极简科技风，冷色调影棚打光"), once);
  assert.equal(applyStyleOverrideToPrompt(base, "   "), base);

  const multiline = applyStyleOverrideToPrompt(base, "极简科技风\n冷色调金属反光\n高对比阴影");
  assert.match(multiline, /^全局风格卡：极简科技风；冷色调金属反光；高对比阴影$/m);
  assert.equal(applyStyleOverrideToPrompt(multiline, "暖色日光"), "系统安全约束：不得生成违法内容。\n全局风格卡：暖色日光\n当前类别提示词：正面主图");
});

test("applyStyleOverrideToPrompt prepends global style line when absent", () => {
  const plain = "产品居中，突出金属质感";
  assert.equal(
    applyStyleOverrideToPrompt(plain, "北欧简约日光"),
    "全局风格卡：北欧简约日光\n产品居中，突出金属质感",
  );
});

test("resolveDeliverySlots enforces edit_final > parent_final > edit_current > parent_current > pending", () => {
  const tasks: DeliveryTaskLike[] = [
    {
      id: "t-detail-1",
      ordinal: 2,
      imageType: "detail",
      title: "细节特写/材质",
      purpose: "展示接口细节",
      promptDraft: "detail prompt",
      status: "generated",
      versions: [
        { id: "v-d1-cur", versionNumber: 1, isCurrent: true, isFinal: false, previewUrl: "/d1-v1.png", promptSnapshot: { finalPrompt: "d1 prompt" } },
      ],
    },
    {
      id: "t-main-1",
      ordinal: 1,
      imageType: "main",
      title: "核心主图",
      purpose: "首屏主图",
      promptDraft: "main prompt",
      status: "generated",
      versions: [
        { id: "v-m1-cur", versionNumber: 1, isCurrent: true, isFinal: true, previewUrl: "/m1-v1.png", promptSnapshot: { finalPrompt: "m1 prompt" } },
      ],
    },
    {
      id: "t-main-2",
      ordinal: 3,
      imageType: "main",
      title: "场景主图",
      purpose: "桌面场景",
      promptDraft: "scene prompt",
      status: "generated",
      versions: [
        { id: "v-m2-cur", versionNumber: 1, isCurrent: true, isFinal: true, previewUrl: "/m2-v1.png", promptSnapshot: { finalPrompt: "m2 prompt" } },
      ],
    },
    {
      id: "t-detail-2",
      ordinal: 4,
      imageType: "detail",
      title: "待生成规格图",
      purpose: "尺寸规格",
      promptDraft: "size prompt",
      status: "pending",
      versions: [],
    },
    {
      id: "t-archived",
      ordinal: 5,
      imageType: "detail",
      title: "已归档",
      purpose: "不应出现",
      promptDraft: "archived",
      status: "archived",
      versions: [{ id: "v-arch", versionNumber: 1, isCurrent: true, isFinal: true, previewUrl: "/arch.png" }],
    },
  ];

  const children: DeliveryEditChildLike[] = [
    // Nested child under t-main-1 with finalVersionId -> must win over parent_final
    {
      task: { id: "c-1", sourceCardId: "t-main-1", sourceVersionId: "v-m1-cur", currentVersionId: "cv-1", finalVersionId: null, updatedAt: "2026-11-20T01:00:00Z", summary: "初次局部重绘" },
      versions: [{ id: "cv-1", versionNumber: 1, previewUrl: "/cv-1.png", mimeType: "image/png" }],
    },
    {
      task: { id: "c-2", sourceCardId: "c-1", sourceVersionId: "cv-1", currentVersionId: "cv-2", finalVersionId: "cv-2", updatedAt: "2026-11-20T02:00:00Z", summary: "二次改文字终版" },
      versions: [{ id: "cv-2", versionNumber: 1, previewUrl: "/cv-2.png", mimeType: "image/png" }],
    },
    // Child under t-main-2 without final -> parent_final must win over edit_current
    {
      task: { id: "c-3", sourceCardId: "t-main-2", sourceVersionId: "v-m2-cur", currentVersionId: "cv-3", finalVersionId: null, updatedAt: "2026-11-20T03:00:00Z", summary: "消除笔草稿" },
      versions: [{ id: "cv-3", versionNumber: 1, previewUrl: "/cv-3.png", mimeType: "image/png" }],
    },
    // Child under t-detail-1 with current version (parent has no final) -> edit_current wins over parent_current
    {
      task: { id: "c-4", sourceCardId: "t-detail-1", sourceVersionId: "v-d1-cur", currentVersionId: "cv-4", finalVersionId: null, updatedAt: "2026-11-20T04:00:00Z", summary: "详情扩图" },
      versions: [{ id: "cv-4", versionNumber: 1, previewUrl: "/cv-4.png", mimeType: "image/webp" }],
    },
  ];

  const slots = resolveDeliverySlots(tasks, children);
  assert.equal(slots.length, 4);
  assert.deepEqual(slots.map((slot) => [slot.parentTaskId, slot.sourceRole, slot.versionId, slot.exportPath]), [
    ["t-main-1", "edit_final", "cv-2", "main/01_核心主图.png"],
    ["t-main-2", "parent_final", "v-m2-cur", "main/02_场景主图.png"],
    ["t-detail-1", "edit_current", "cv-4", "detail/01_细节特写_材质.webp"],
    ["t-detail-2", "pending", null, null],
  ]);
  assert.equal(slots[0].isEditedDerived, true);
  assert.equal(slots[0].editChildTaskId, "c-2");
  assert.equal(slots[1].isEditedDerived, false);
});

test("computeWorkbenchLanes separates input/task/edit-child lanes without overlap and honors saved positions", () => {
  const items = [
    { id: "style:global", kind: "style" as const },
    { id: "base:1", kind: "base" as const },
    { id: "task:1", kind: "task" as const },
    { id: "task:2", kind: "task" as const },
    { id: "edit-child:1", kind: "edit-child" as const, parentId: "task:1" },
  ];

  const fresh = computeWorkbenchLanes(items);
  assert.ok(fresh.get("base:1")!.x < fresh.get("task:1")!.x);
  assert.ok(fresh.get("task:1")!.x < fresh.get("edit-child:1")!.x);
  assert.ok(fresh.get("base:1")!.y > fresh.get("style:global")!.y);

  const saved = new Map([["task:1", { x: 500, y: 120 }]]);
  const restored = computeWorkbenchLanes(items, saved);
  assert.deepEqual(restored.get("task:1"), { x: 500, y: 120 });

  const tidied = computeWorkbenchLanes(items, saved, { ignoreSavedPositions: true });
  assert.equal(tidied.get("task:1")!.x, 348);
});

test("computeLineageHighlight traverses both upstream sources and downstream derived children", () => {
  const edges = [
    { id: "base:1->task:1", source: "base:1", target: "task:1" },
    { id: "base:1->task:2", source: "base:1", target: "task:2" },
    { id: "task:1->edit:1", source: "task:1", target: "edit:1" },
    { id: "edit:1->edit:2", source: "edit:1", target: "edit:2" },
  ];

  const fromTask1 = computeLineageHighlight("task:1", edges);
  assert.deepEqual([...fromTask1.highlightedNodeIds].sort(), ["base:1", "edit:1", "edit:2", "task:1"]);
  assert.deepEqual([...fromTask1.highlightedEdgeIds].sort(), ["base:1->task:1", "edit:1->edit:2", "task:1->edit:1"]);

  const empty = computeLineageHighlight(null, edges);
  assert.equal(empty.highlightedNodeIds.size, 0);
  assert.equal(empty.highlightedEdgeIds.size, 0);
});

test("evaluateDeliveryCompliance scores finalized high-res suites and flags resolution or pending gaps", () => {
  const readyTasks: DeliveryTaskLike[] = [
    {
      id: "m1", ordinal: 1, imageType: "main", title: "主图", purpose: "首屏", promptDraft: "p1", status: "generated",
      versions: [{ id: "vm1", versionNumber: 1, width: 1200, height: 1200, isCurrent: true, isFinal: true, previewUrl: "/m1.png", promptSnapshot: { finalPrompt: "主图完整提示词" } }],
    },
    {
      id: "d1", ordinal: 2, imageType: "detail", title: "详情", purpose: "卖点", promptDraft: "p2", status: "generated",
      versions: [{ id: "vd1", versionNumber: 1, width: 1000, height: 1400, isCurrent: true, isFinal: true, previewUrl: "/d1.png", promptSnapshot: { finalPrompt: "详情完整提示词" } }],
    },
  ];
  const perfect = evaluateDeliveryCompliance(resolveDeliverySlots(readyTasks), "amazon");
  assert.equal(perfect.score, 100);
  assert.ok(perfect.checks.every((check) => check.status === "pass"));

  const lowResTasks: DeliveryTaskLike[] = [
    {
      id: "m1", ordinal: 1, imageType: "main", title: "低清主图", purpose: "首屏", promptDraft: "p1", status: "generated",
      versions: [{ id: "vm1", versionNumber: 1, width: 600, height: 600, isCurrent: true, isFinal: false, previewUrl: "/m1.png", promptSnapshot: { finalPrompt: "提示词" } }],
    },
    { id: "d2", ordinal: 2, imageType: "detail", title: "待生成", purpose: "卖点", promptDraft: "p2", status: "pending", versions: [] },
  ];
  const warned = evaluateDeliveryCompliance(resolveDeliverySlots(lowResTasks), "amazon");
  assert.ok(warned.score < 100);
  assert.equal(warned.checks.find((c) => c.id === "resolution")?.status, "warn");
  assert.equal(warned.checks.find((c) => c.id === "slots")?.status, "warn");
});

test("computeOutpaintPreviewBox computes target dimensions and anchor box for aspect ratio expansion", () => {
  const wide = computeOutpaintPreviewBox(1000, 1000, "right", "16:9");
  assert.equal(wide.targetHeight, 1000);
  assert.equal(wide.targetWidth, Math.ceil(1000 * (16 / 9)));
  assert.equal(wide.anchor, "left");
  assert.equal(wide.innerX, 0);
  assert.ok(wide.innerWidth < 1);

  const tall = computeOutpaintPreviewBox(1000, 1000, "all", "9:16");
  assert.equal(tall.targetWidth, 1000);
  assert.equal(tall.targetHeight, Math.ceil(1000 / (9 / 16)));
  assert.equal(tall.anchor, "center");
  assert.ok(tall.innerY > 0 && tall.innerHeight < 1);
});
