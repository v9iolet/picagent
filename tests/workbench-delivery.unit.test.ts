import assert from "node:assert/strict";
import test from "node:test";
import {
  applyStyleOverrideToPrompt,
  computeLineageHighlight,
  computeWorkbenchLanes,
  evaluateDeliveryCompliance,
  extractCardPromptPreview,
  resolveDeliverySlots,
  type DeliveryEditChildLike,
  type DeliveryTaskLike,
} from "../shared/workbench-delivery.js";

test("extractCardPromptPreview shows the category description without repetitive prompt constraints", () => {
  const description = "用柔和侧光照亮产品\n右侧留出文字区";
  const prompt = [
    "系统安全约束：不得生成误导性内容。",
    "平台约束：按平台规范展示。",
    "商品事实约束：呈现两个接口。",
    "全局风格卡：暖色调。",
    `当前类别提示词：${description}`,
    "单卡人工补充：无",
  ].join("\r\n");
  assert.equal(extractCardPromptPreview(prompt), description);
  assert.equal(extractCardPromptPreview(`计划说明　当前类别提示词：${description}`), description);
  assert.equal(extractCardPromptPreview(`系统安全约束：保持真实\n平台约束：禁止促销贴纸\n商品事实约束：两个接口\n全局风格卡：暖色调\n${description}`), description);
  assert.equal(extractCardPromptPreview("系统安全约束：保持真实", "特写"), "特写");
  assert.equal(extractCardPromptPreview("系统安全约束：保持真实"), "系统安全约束：保持真实");
  const handwritten = `  ${description}\n`;
  assert.equal(extractCardPromptPreview(handwritten), handwritten);
  assert.equal(extractCardPromptPreview("当前类别提示词：正面主图\n单卡人工补充：保留左侧留白"), "正面主图\n单卡人工补充：保留左侧留白");
});

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
  assert.deepEqual(tidied.get("task:1"), fresh.get("task:1"));
});

test("computeWorkbenchLanes leaves clearance around measured cards and a tall style guide", () => {
  const items = [
    { id: "style", kind: "style", width: 355, height: 1550 },
    { id: "input", kind: "base", width: 224, height: 310 },
    { id: "task-1", kind: "task", width: 320, height: 620 },
    { id: "task-2", kind: "task", width: 385, height: 520 },
    { id: "task-3", kind: "task", width: 320, height: 520 },
    { id: "task-4", kind: "task", width: 320, height: 620 },
    { id: "edit-1", kind: "edit-child", width: 320, height: 580, parentId: "task-1" },
    { id: "edit-2", kind: "edit-child", width: 320, height: 570, parentId: "task-2" },
  ] as const;
  const measuredSizes = new Map<string, { width: number; height: number }>(items.map(({ id, width, height }) => [id, { width, height }]));
  const saved = new Map(items.map(({ id }) => [id, { x: 0, y: 0 }]));
  const positions = computeWorkbenchLanes([...items], saved, { ignoreSavedPositions: true, measuredSizes });
  const boxes = items.map(({ id, width, height }) => ({ id, ...positions.get(id)!, width, height }));
  for (const [index, a] of boxes.entries()) {
    for (const b of boxes.slice(index + 1)) {
      assert.ok(
        a.x + a.width + 44 <= b.x || b.x + b.width + 44 <= a.x ||
        a.y + a.height + 40 <= b.y || b.y + b.height + 40 <= a.y,
        `${a.id} and ${b.id} must leave clearance`,
      );
    }
  }
  assert.equal(positions.get("task-3")!.y - positions.get("task-1")!.y, 660);
  assert.equal(positions.get("task-4")!.y - positions.get("task-2")!.y, 560);
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

test("resolveDeliverySlots compares real Date timestamps (node-postgres timestamptz) instead of falling back to UUID order", () => {
  const parentV1Date = new Date("2026-11-23T10:00:00.000Z") as unknown as string;
  const oldEditDate = new Date("2026-11-23T10:00:01.000Z") as unknown as string;
  const newEditDate = new Date("2026-11-23T10:00:05.000Z") as unknown as string;
  const parentV2Date = new Date("2026-11-23T10:00:10.000Z") as unknown as string;

  const task: DeliveryTaskLike = {
    id: "replica-task-1",
    ordinal: 1,
    imageType: "main",
    title: "复刻图 1",
    purpose: "爆品图复刻",
    promptDraft: "测试复刻",
    status: "generated",
    originKind: "replica",
    versions: [
      {
        id: "ver-parent-1",
        versionNumber: 1,
        isCurrent: true,
        isFinal: false,
        previewUrl: "/v1.png",
        createdAt: parentV1Date,
      },
    ],
  };

  // Older edit child has lexicographically larger UUID than newer edit child
  const editChildren: DeliveryEditChildLike[] = [
    {
      task: {
        id: "ffffffff-0000-0000-0000-000000000001",
        sourceCardId: "replica-task-1",
        sourceVersionId: "ver-parent-1",
        currentVersionId: "ver-edit-old",
        finalVersionId: null,
        createdAt: oldEditDate,
        updatedAt: oldEditDate,
      },
      versions: [
        {
          id: "ver-edit-old",
          versionNumber: 1,
          previewUrl: "/edit-old.png",
          createdAt: oldEditDate,
        },
      ],
    },
    {
      task: {
        id: "11111111-0000-0000-0000-000000000002",
        sourceCardId: "replica-task-1",
        sourceVersionId: "ver-parent-1",
        currentVersionId: "ver-edit-new",
        finalVersionId: null,
        createdAt: newEditDate,
        updatedAt: newEditDate,
      },
      versions: [
        {
          id: "ver-edit-new",
          versionNumber: 1,
          previewUrl: "/edit-new.png",
          createdAt: newEditDate,
        },
      ],
    },
  ];

  const [pickedLatestEdit] = resolveDeliverySlots([task], editChildren, { preferLatestByTime: true });
  assert.equal(pickedLatestEdit.isEditedDerived, true);
  assert.equal(pickedLatestEdit.editChildTaskId, "11111111-0000-0000-0000-000000000002");
  assert.equal(pickedLatestEdit.versionId, "ver-edit-new");

  // Default mode also sorts children by Date timestamp rather than UUID order
  const [pickedDefault] = resolveDeliverySlots([task], editChildren);
  assert.equal(pickedDefault.editChildTaskId, "11111111-0000-0000-0000-000000000002");

  // When a newer parent version is generated after both edits, preferLatestByTime selects parent v2
  const taskWithV2: DeliveryTaskLike = {
    ...task,
    versions: [
      { ...task.versions[0], isCurrent: false },
      {
        id: "ver-parent-2",
        versionNumber: 2,
        isCurrent: true,
        isFinal: false,
        previewUrl: "/v2.png",
        createdAt: parentV2Date,
      },
    ],
  };
  const [pickedParentV2] = resolveDeliverySlots([taskWithV2], editChildren, { preferLatestByTime: true });
  assert.equal(pickedParentV2.isEditedDerived, false);
  assert.equal(pickedParentV2.versionId, "ver-parent-2");
  assert.equal(pickedParentV2.versionNumber, 2);
});
