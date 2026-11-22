import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PURE_WHITE_MAIN_IMAGE_REQUIREMENTS } from "../shared/platform-main-background.js";
import { applyStyleOverrideToPrompt } from "../shared/workbench-delivery.js";
import {
  buildProviderImagePrompt,
  composeSuiteTaskPrompt,
  materializeCategoryPlanItems,
} from "../server/suite-task-prompt.js";
import type { CategoryPromptRequest, PlanSnapshot } from "../server/types.js";

test("buildProviderImagePrompt strips safety/fact/non-white platform boilerplate while preserving positive directives", () => {
  const detailFinal = composeSuiteTaskPrompt({
    globalStyleCard: { promptPrefix: "深空灰蓝科技光影" },
    platformConstraints: "图片不添加文字、艺术或营销素材。",
    factConstraints: "产品参数：100W 氮化镓\n支持 PD3.1 快充",
    categoryPrompt: '暗调科技桌面构图，顶部居中大标题 "100W Fast Charge"\n右下角三枚胶囊："PD3.1"、"3 Ports"、"Compact"',
    manualAddition: "无",
  });

  const detailProvider = buildProviderImagePrompt(detailFinal, {
    categoryCode: "feature_benefit",
    pureWhiteMain: false,
  });
  assert.doesNotMatch(detailProvider, /系统安全约束：/);
  assert.doesNotMatch(detailProvider, /平台约束：/);
  assert.doesNotMatch(detailProvider, /商品事实约束：/);
  assert.doesNotMatch(detailProvider, /支持 PD3\.1 快充/);
  assert.doesNotMatch(detailProvider, /当前类别提示词：/);
  assert.doesNotMatch(detailProvider, /单卡人工补充：无/);
  assert.match(detailProvider, /^全局风格卡：深空灰蓝科技光影/m);
  assert.match(detailProvider, /"100W Fast Charge"/);

  const withManual = composeSuiteTaskPrompt({
    globalStyleCard: {},
    platformConstraints: "忽略此平台文案",
    factConstraints: "多行事实一\n多行事实二",
    categoryPrompt: "微距接口细节展示",
    manualAddition: "突出金属倒角反光",
  });
  const manualProvider = buildProviderImagePrompt(withManual, { categoryCode: "material_detail" });
  assert.doesNotMatch(manualProvider, /未提供额外风格卡/);
  assert.doesNotMatch(manualProvider, /系统安全约束|平台约束|商品事实约束/);
  assert.equal(manualProvider, "微距接口细节展示\n单卡人工补充：突出金属倒角反光");
});

test("buildProviderImagePrompt retains pure-white requirement only for pureWhiteMain and handles freehand prompts", () => {
  const mainFinal = composeSuiteTaskPrompt({
    globalStyleCard: { promptPrefix: "极简商业棚拍" },
    platformConstraints: `${PURE_WHITE_MAIN_IMAGE_REQUIREMENTS}此要求优先于风格与场景要求。 Amazon image rules`,
    factConstraints: "充电器正面外观",
    categoryPrompt: "正面微俯拍产品全貌",
  });

  const pureWhiteProvider = buildProviderImagePrompt(mainFinal, { categoryCode: "main", pureWhiteMain: true });
  assert.ok(pureWhiteProvider.includes(PURE_WHITE_MAIN_IMAGE_REQUIREMENTS));
  assert.doesNotMatch(pureWhiteProvider, /Amazon image rules/);
  assert.doesNotMatch(pureWhiteProvider, /系统安全约束|商品事实约束|平台约束：/);
  assert.match(pureWhiteProvider, /全局风格卡：极简商业棚拍/);
  assert.match(pureWhiteProvider, /正面微俯拍产品全貌/);

  const nonWhiteMain = buildProviderImagePrompt(mainFinal, { categoryCode: "main", pureWhiteMain: false });
  assert.ok(!nonWhiteProviderContainsPureWhite(nonWhiteMain));

  const freehand = "  北欧暖光桌面实拍，保留右侧文字留白  ";
  assert.equal(buildProviderImagePrompt(freehand), "北欧暖光桌面实拍，保留右侧文字留白");

  const styledFreehand = applyStyleOverrideToPrompt(freehand.trim(), "冷色调影棚金属质感");
  assert.equal(
    buildProviderImagePrompt(styledFreehand, { categoryCode: "lifestyle_use" }),
    "全局风格卡：冷色调影棚金属质感\n北欧暖光桌面实拍，保留右侧文字留白",
  );
});

function nonWhiteProviderContainsPureWhite(value: string): boolean {
  return value.includes(PURE_WHITE_MAIN_IMAGE_REQUIREMENTS);
}

test("materializeCategoryPlanItems avoids dumping 1600-char human_supplement and appends missing overlay texts for detail cards", () => {
  const suiteId = randomUUID();
  const planId = randomUUID();
  const inputId = randomUUID();
  const longTailMarker = "长尾冗余参数尾巴MARKER_TAIL";
  const longSupplement = `${"65W 氮化镓三口快充，折叠插脚，支持笔记本与手机同时充电；".repeat(55)}${longTailMarker}`;
  assert.ok(longSupplement.length > 1600);

  const snapshot: PlanSnapshot = {
    id: planId,
    suiteId,
    revisionNumber: 1,
    revisionKind: "human",
    parentSnapshotId: null,
    templateVersionId: randomUUID(),
    dynamicInput: {
      platform_text_rule: "卖点图允许商业文字",
      main_image_background: "pure_white_required",
      human_supplement: longSupplement,
      emphasis_requirements: longSupplement,
    },
    humanInput: {},
    chunks: [
      {
        sourceChunkId: "chunk-1",
        sourceVersion: "v1",
        title: "认证参数",
        content: "通过 UL 与 FCC 安全认证",
        fieldValues: {},
        sourceKind: "manual",
        sourceAssetPaths: [],
        contentSha256: "a".repeat(64),
      },
    ],
    inputImageIds: [inputId],
    baseVersionIds: [],
    provider: { name: "fake", model: "fake", isFake: true },
    requestSummary: { useOriginalImages: true },
    rawOutputSummary: {},
    schemaVersion: "suite-structure-plan-v2",
    items: [],
    phase: "structure_plan",
    confirmationStatus: "confirmed",
    confirmedAt: new Date().toISOString(),
    structure: {
      status: "READY_FOR_REVIEW",
      mainAllocation: { category: "main", count: 1, reason: "主图", sourceImageIds: [inputId], factRefs: ["human_supplement"], missingFacts: [] },
      detailImageCount: 2,
      categoryAllocations: [
        { category: "feature_benefit", requirement: "required", count: 1, reason: "卖点", sourceImageIds: [inputId], factRefs: ["human_supplement", "chunk-1"], missingFacts: [] },
        { category: "material_detail", requirement: "required", count: 1, reason: "细节", sourceImageIds: [inputId], factRefs: ["human_supplement"], missingFacts: [] },
      ],
      globalStyleCard: { promptPrefix: "深空灰蓝科技质感" },
    },
    createdAt: new Date().toISOString(),
  };

  const makeReq = (categoryCode: string, items: CategoryPromptRequest["items"]): CategoryPromptRequest => ({
    id: randomUUID(),
    suiteId,
    planSnapshotId: planId,
    categoryCode,
    requestedCount: 1,
    status: "succeeded",
    idempotencyKey: `${categoryCode}-key`,
    retryOfRequestId: null,
    templateVersionId: snapshot.templateVersionId,
    dynamicInput: {},
    humanInput: {},
    approvedFactRefs: [],
    inputImageIds: [inputId],
    baseVersionIds: [],
    provider: snapshot.provider,
    requestSummary: {},
    responseSummary: null,
    items,
    errorCode: null,
    errorMessage: null,
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  });

  const requests: CategoryPromptRequest[] = [
    makeReq("main", [{
      stableId: "main-1",
      category: "main",
      title: "纯白主图",
      purpose: "主图",
      referenceImageIds: [inputId],
      factRefs: ["human_supplement"],
      prompt: "纯白底产品正面主图",
      allowsTextOverlay: "no",
      textContent: [{ text: "不应该上主图", source: "human_supplement" }],
      aspectRatio: "1:1",
      suggestedParams: {},
    }]),
    makeReq("feature_benefit", [{
      stableId: "fb-1",
      category: "feature_benefit",
      title: "65W 快充卖点",
      purpose: "核心卖点",
      referenceImageIds: [inputId],
      factRefs: ["human_supplement", "chunk-1"],
      prompt: '深色科技桌面构图，顶部大标题展示 "65W GaN Fast Charge"',
      allowsTextOverlay: "yes",
      textContent: [
        { text: "65W GaN Fast Charge", source: "human_supplement" },
        { text: "3-Port Simultaneous", source: "human_supplement" },
      ],
      aspectRatio: "3:4",
      suggestedParams: {},
    }]),
    makeReq("material_detail", [{
      stableId: "md-1",
      category: "material_detail",
      title: "折叠插脚细节",
      purpose: "细节工艺",
      referenceImageIds: [inputId],
      factRefs: ["human_supplement"],
      prompt: "微距拍摄折叠插脚工艺细节",
      allowsTextOverlay: "yes",
      textContent: [],
      aspectRatio: "3:4",
      suggestedParams: {},
    }]),
  ];

  const items = materializeCategoryPlanItems(snapshot, requests)!;
  assert.equal(items.length, 3);

  const [mainItem, featureItem, materialItem] = items;
  for (const item of items) {
    assert.ok(!item.prompt.includes(longTailMarker), `${item.categoryCode} must not contain raw 1600-char tail`);
  }
  assert.doesNotMatch(mainItem.prompt, /不应该上主图/);
  assert.doesNotMatch(mainItem.prompt, /上图渲染文案/);

  // feature_benefit preserves RAG chunk and prioritizes textContent instead of dumping raw supplement
  assert.match(featureItem.prompt, /通过 UL 与 FCC 安全认证/);
  assert.match(featureItem.prompt, /65W GaN Fast Charge/);
  assert.match(featureItem.prompt, /3-Port Simultaneous/);
  // Missing overlay text is appended once; already-present text is not duplicated
  assert.match(featureItem.prompt, /上图渲染文案（准确呈现）："3-Port Simultaneous"/);
  assert.equal(featureItem.prompt.split("65W GaN Fast Charge").length - 1, 2); // once in factConstraints (textContent), once in prompt

  // material_detail with empty textContent truncates human_supplement within 160 chars
  const factLine = materialItem.prompt.split("\n").find((line) => line.startsWith("商品事实约束："))!;
  assert.ok(factLine.length <= "商品事实约束：".length + 160);
  assert.ok(factLine.endsWith("…"));
});
