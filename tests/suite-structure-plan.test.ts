import assert from "node:assert/strict";
import test from "node:test";
import { createSuiteStudioApp } from "../server/app.js";
import { MemoryPlanRepository } from "../server/repositories/memory-plan-repository.js";
import { MemoryPromptRepository } from "../server/repositories/memory-prompt-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";
import { parseNormalizedPromptMarkdown } from "../server/prompt-library.js";
import { structurePlanDynamicInput } from "../src/features/plan/plan-input.js";
import type { PlanSnapshot } from "../server/types.js";
import { DEFAULT_SUITE_CATEGORY_GROUPS, SMART_SUITE_STRUCTURE_PRESET } from "../shared/suite-categories.js";

const image = Buffer.from("image");
const dynamicInput = {
  platform: "Amazon",
  output_language: "中文",
  product_name: "结构计划商品",
  human_supplement: "人工确认：包装内含一条充电线。",
  emphasis_requirements: "突出便携",
  design_constraints: "现代简洁，不添加未经确认的文字",
  main_image_count: 1,
  detail_image_count_min: 2,
  detail_image_count_max: 3,
  selected_detail_categories: ["lifestyle_use", "material_detail"],
  category_requirements: { lifestyle_use: "required", material_detail: "optional" },
};
const output = {
  schemaVersion: "suite-structure-plan-v2",
  status: "READY_FOR_REVIEW",
  mainAllocation: { category: "main", count: 1, reason: "主图组", sourceImageIds: ["img-1"], factRefs: ["human_supplement"], missingFacts: [] },
  detailImageCount: 2,
  categoryAllocations: [
    { category: "lifestyle_use", requirement: "required", count: 1, reason: "展示使用场景", sourceImageIds: ["img-1"], factRefs: [], missingFacts: [] },
    { category: "material_detail", requirement: "optional", count: 1, reason: "展示材质", sourceImageIds: ["img-1"], factRefs: [], missingFacts: [] },
  ],
  globalStyleCard: { promptPrefix: "干净、克制、统一的中性背景与自然光" },
};

class ConflictingConfirmationRepository extends MemoryPlanRepository {
  private injected = false;

  override async appendRevision(snapshot: PlanSnapshot) {
    if (!this.injected && snapshot.confirmationStatus === "confirmed") {
      this.injected = true;
      await super.appendRevision(snapshot);
      throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505", constraint: "plan_snapshots_suite_id_revision_number_key" });
    }
    return super.appendRevision(snapshot);
  }
}

test("structure plan request preserves V1.1 brief fields without legacy aliases", () => {
  const input = structurePlanDynamicInput({
    platform: "Amazon",
    output_language: "中文",
    product_name: "结构计划商品",
    human_supplement: "人工确认：包装内含一条充电线。",
    emphasis_requirements: "突出便携",
    design_constraints: "现代简洁，不添加未经确认的文字",
  }, {
    main_image_count: 1,
    detail_image_count_min: 2,
    detail_image_count_max: 3,
    selected_detail_categories: ["lifestyle_use"],
    category_requirements: { lifestyle_use: "required" },
  });

  assert.deepEqual(input, {
    platform: "Amazon",
    output_language: "中文",
    product_name: "结构计划商品",
    human_supplement: "人工确认：包装内含一条充电线。",
    emphasis_requirements: "突出便携",
    design_constraints: "现代简洁，不添加未经确认的文字",
    main_image_count: 1,
    detail_image_count_min: 2,
    detail_image_count_max: 3,
    selected_detail_categories: ["lifestyle_use"],
    category_requirements: { lifestyle_use: "required" },
  });
  assert.equal("product_facts" in input, false);
  assert.equal("design_style" in input, false);
  assert.equal("forbidden_content" in input, false);
});

async function setup(llmOutput: unknown = output, plans = new MemoryPlanRepository(), templatePath = "prompt/normalized/general-structure-plan.md") {
  const repository = new MemorySuiteRepository();
  const storage = new MemoryStorage();
  const prompts = new MemoryPromptRepository();
  const template = parseNormalizedPromptMarkdown(await (await import("node:fs/promises")).readFile(templatePath, "utf8"), templatePath);
  const [published] = await prompts.importRecords([template]);
  await prompts.publishVersion(published.templateVersionId);
  const suite = await repository.createSuite("结构计划");
  await repository.createInputImage({ id: "img-1", suiteId: suite.id, ordinal: 1, originalObjectKey: `suites/${suite.id}/img-1`, thumbnailObjectKey: `suites/${suite.id}/img-1-thumb`, sha256: "a".repeat(64), width: 1, height: 1, mimeType: "image/png", originalFilename: "product.png", currentBaseVersionId: null, createdAt: new Date().toISOString() });
  await storage.put({ key: `suites/${suite.id}/img-1`, bytes: image, contentType: "image/png" });
  const inputs: Record<string, unknown>[] = [];
  const app = createSuiteStudioApp({ repository, storage, promptRepository: prompts, planRepository: plans, llmClient: { provider: "fake", model: "structure", isFake: true, async generatePlan(input) { inputs.push(input.dynamicInput); return llmOutput; } } });
  return { app, suite, template, plans, inputs };
}

async function wait(app: Awaited<ReturnType<typeof setup>>["app"], id: string) {
  for (let i = 0; i < 50; i += 1) { const response = await app.request("GET", `/api/plan-attempts/${id}`); const data = (response.body as any).data; if (data.status !== "running") return data; await new Promise((resolve) => setTimeout(resolve, 2)); }
  throw new Error("timeout");
}

test("structure plan can generate and confirm a draft without RAG", async () => {
  const { app, suite, template } = await setup();
  const started = await app.request("POST", `/api/suites/${suite.id}/structure-plan`, { headers: { "idempotency-key": "structure-1" }, body: { templateVersionId: template.templateVersionId, dynamicInput } });
  assert.equal(started.status, 202);
  const terminal = await wait(app, (started.body as any).data.attemptId);
  assert.equal(terminal.status, "succeeded");
  assert.equal(terminal.snapshot.phase, "structure_plan");
  assert.equal(terminal.snapshot.confirmationStatus, "draft");
  assert.equal(terminal.snapshot.schemaVersion, "suite-structure-plan-v2");
  assert.deepEqual(terminal.snapshot.chunks, []);
  assert.equal(terminal.snapshot.dynamicInput.human_supplement, dynamicInput.human_supplement);
  assert.equal(terminal.snapshot.structure.mainAllocation.count, 1);
  assert.equal(terminal.snapshot.structure.mainImageCount, undefined);
  assert.equal(terminal.snapshot.structure.canProceed, undefined);
  assert.equal(terminal.snapshot.structure.detailImageCount, 2);
  const confirmed = await app.request("POST", `/api/suites/${suite.id}/structure-plan/confirm`, { body: { structure: terminal.snapshot.structure } });
  assert.equal(confirmed.status, 200);
  assert.equal((confirmed.body as any).data.confirmationStatus, "confirmed");
});

test("structure plan rejects an unknown category deterministically", async () => {
  const bad = { ...output, categoryAllocations: [...output.categoryAllocations, { category: "unknown_category", requirement: "optional", count: 0, reason: "", sourceImageIds: ["img-1"], factRefs: [], missingFacts: [] }] };
  const { app, suite, template } = await setup(bad);
  const started = await app.request("POST", `/api/suites/${suite.id}/structure-plan`, { headers: { "idempotency-key": "structure-bad" }, body: { templateVersionId: template.templateVersionId, dynamicInput } });
  const terminal = await wait(app, (started.body as any).data.attemptId);
  assert.equal(terminal.status, "failed");
  assert.equal(terminal.errorCode, "STRUCTURE_PLAN_INVALID");
});

test("structure plan confirmation revalidates human edits deterministically", async () => {
  const cases = [
    { name: "unknown category", mutate: (structure: any) => ({ ...structure, categoryAllocations: [...structure.categoryAllocations, { category: "unknown_category", requirement: "optional", count: 0, reason: "", sourceImageIds: ["img-1"], factRefs: [], missingFacts: [] }] }) },
    { name: "detail count outside range", mutate: (structure: any) => ({ ...structure, detailImageCount: 99 }) },
    { name: "detail allocation sum mismatch", mutate: (structure: any) => ({ ...structure, detailImageCount: 3 }) },
    { name: "required category set to zero", mutate: (structure: any) => ({ ...structure, categoryAllocations: structure.categoryAllocations.map((row: any) => row.category === "lifestyle_use" ? { ...row, count: 0 } : row), detailImageCount: 1 }) },
    { name: "unknown source image", mutate: (structure: any) => ({ ...structure, categoryAllocations: structure.categoryAllocations.map((row: any) => row.category === "lifestyle_use" ? { ...row, sourceImageIds: ["not-an-input"] } : row) }) },
  ];
  for (const item of cases) {
    const { app, suite, template } = await setup();
    const started = await app.request("POST", `/api/suites/${suite.id}/structure-plan`, { headers: { "idempotency-key": `confirm-${item.name}` }, body: { templateVersionId: template.templateVersionId, dynamicInput } });
    const terminal = await wait(app, (started.body as any).data.attemptId);
    const response = await app.request("POST", `/api/suites/${suite.id}/structure-plan/confirm`, { body: { structure: item.mutate(terminal.snapshot.structure) } });
    assert.equal(response.status, 409, item.name);
    assert.equal((response.body as any).error.code, "STRUCTURE_PLAN_INVALID", item.name);
  }
});

test("reconfirming an already-confirmed structure reuses the immutable snapshot", async () => {
  const { app, suite, template } = await setup();
  const started = await app.request("POST", `/api/suites/${suite.id}/structure-plan`, { headers: { "idempotency-key": "confirm-idempotent-plan" }, body: { templateVersionId: template.templateVersionId, dynamicInput } });
  const terminal = await wait(app, (started.body as any).data.attemptId);
  const first = await app.request("POST", `/api/suites/${suite.id}/structure-plan/confirm`, { body: { structure: terminal.snapshot.structure } });
  assert.equal(first.status, 200);
  const firstSnapshot = (first.body as any).data;
  const second = await app.request("POST", `/api/suites/${suite.id}/structure-plan/confirm`, { body: { structure: firstSnapshot.structure } });
  assert.equal(second.status, 200);
  assert.equal((second.body as any).data.id, firstSnapshot.id);
  assert.equal((second.body as any).data.revisionNumber, firstSnapshot.revisionNumber);
});

test("confirmation revision conflict reuses the concurrently written snapshot", async () => {
  const plans = new ConflictingConfirmationRepository();
  const { app, suite, template } = await setup(output, plans);
  const started = await app.request("POST", `/api/suites/${suite.id}/structure-plan`, { headers: { "idempotency-key": "confirm-conflict-plan" }, body: { templateVersionId: template.templateVersionId, dynamicInput } });
  const terminal = await wait(app, (started.body as any).data.attemptId);
  const response = await app.request("POST", `/api/suites/${suite.id}/structure-plan/confirm`, { body: { structure: terminal.snapshot.structure } });
  assert.equal(response.status, 200);
  assert.equal((response.body as any).data.confirmationStatus, "confirmed");
});

test("confirmed review may add a zero-count optional category without changing the plan total", async () => {
  const { app, suite, template } = await setup();
  const started = await app.request("POST", `/api/suites/${suite.id}/structure-plan`, { headers: { "idempotency-key": "confirm-add-category" }, body: { templateVersionId: template.templateVersionId, dynamicInput } });
  const terminal = await wait(app, (started.body as any).data.attemptId);
  const structure = { ...terminal.snapshot.structure, categoryAllocations: [...terminal.snapshot.structure.categoryAllocations, { category: "feature_benefit", requirement: "optional", count: 0, reason: "设计师新增类别，待确认", sourceImageIds: ["img-1"], factRefs: [], missingFacts: [] }] };
  const response = await app.request("POST", `/api/suites/${suite.id}/structure-plan/confirm`, { body: { structure } });
  assert.equal(response.status, 200);
  assert.equal((response.body as any).data.structure.categoryAllocations.at(-1).category, "feature_benefit");
});

test("structure plan rejects main allocation count drift and unknown fact references", async () => {
  for (const [name, bad] of [
    ["main count", { ...output, mainAllocation: { ...output.mainAllocation, count: 2 } }],
    ["fact reference", { ...output, mainAllocation: { ...output.mainAllocation, factRefs: ["invented_fact"] } }],
  ] as const) {
    const { app, suite, template } = await setup(bad);
    const started = await app.request("POST", `/api/suites/${suite.id}/structure-plan`, { headers: { "idempotency-key": `invalid-${name}` }, body: { templateVersionId: template.templateVersionId, dynamicInput } });
    const terminal = await wait(app, (started.body as any).data.attemptId);
    assert.equal(terminal.status, "failed", name);
    assert.equal(terminal.errorCode, "STRUCTURE_PLAN_INVALID", name);
  }
});

test("structure plan accepts designer-entered product facts from emphasis requirements", async () => {
  const input = { ...dynamicInput, human_supplement: "", emphasis_requirements: "容量 10000mAh；尺寸 50*40*15mm；材质 PC+ABS。" };
  const modelOutput = { ...output, mainAllocation: { ...output.mainAllocation, factRefs: ["human_supplement"] }, categoryAllocations: output.categoryAllocations.map((row) => ({ ...row, factRefs: ["human_supplement"] })) };
  const { app, suite, template } = await setup(modelOutput);
  const started = await app.request("POST", `/api/suites/${suite.id}/structure-plan`, { headers: { "idempotency-key": "emphasis-facts" }, body: { templateVersionId: template.templateVersionId, dynamicInput: input } });
  const terminal = await wait(app, (started.body as any).data.attemptId);
  assert.equal(terminal.status, "succeeded");
  assert.equal(terminal.snapshot.dynamicInput.human_supplement, "");
  assert.equal(terminal.snapshot.dynamicInput.emphasis_requirements, input.emphasis_requirements);
  assert.deepEqual(terminal.snapshot.structure.mainAllocation.factRefs, ["human_supplement"]);
});

const groupedCategories = ["feature_benefit", "material_detail", "lifestyle_use", "comparison", "size_scale", "appearance_angles", "included_items", "compatibility_application", "variant_bundle", "packaging_unboxing", "care_instruction"];
const categoryGroups = {
  main: { categories: ["main"], mode: "exact", count: 1 },
  selling_points: { categories: ["feature_benefit", "material_detail"], mode: "exact", count: 3 },
  lifestyle: { categories: ["lifestyle_use"], mode: "exact", count: 2 },
  other: { categories: groupedCategories.slice(3), mode: "max", count: 1 },
};
const groupedInput = {
  ...dynamicInput,
  detail_image_count_min: 5,
  detail_image_count_max: 6,
  selected_detail_categories: groupedCategories,
  category_requirements: Object.fromEntries(groupedCategories.map((category) => [category, "required"])),
  category_groups: JSON.stringify(categoryGroups),
};
function groupedOutput() {
  return {
    ...structuredClone(output),
    detailImageCount: 5,
    categoryAllocations: groupedCategories.map((category) => ({
      category, requirement: "optional", count: category === "feature_benefit" ? 3 : category === "lifestyle_use" ? 2 : 0,
      reason: "按商品事实分配", sourceImageIds: ["img-1"], factRefs: ["human_supplement"], missingFacts: category === "size_scale" ? ["未提供尺寸参数，未生成尺寸图"] : [],
    })),
  };
}
async function generateGrouped(modelOutput = groupedOutput(), input = groupedInput) {
  const fixture = await setup(modelOutput, new MemoryPlanRepository(), "prompt/normalized/general-structure-plan-groups.md");
  const started = await fixture.app.request("POST", `/api/suites/${fixture.suite.id}/structure-plan`, { headers: { "idempotency-key": "grouped" }, body: { templateVersionId: fixture.template.templateVersionId, dynamicInput: input } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  return { ...fixture, terminal: await wait(fixture.app, (started.body as any).data.attemptId) };
}

test("group exact allocation accepts 3+0 selling points and missing optional facts without pausing", async () => {
  const fixture = await generateGrouped();
  assert.equal(fixture.terminal.status, "succeeded");
  assert.equal(fixture.terminal.snapshot.structure.status, "READY_FOR_REVIEW");
  assert.deepEqual(JSON.parse(String(fixture.inputs[0].category_requirements)), Object.fromEntries(groupedCategories.map((category) => [category, "optional"])));
  const confirmed = await fixture.app.request("POST", `/api/suites/${fixture.suite.id}/structure-plan/confirm`, { body: { structure: fixture.terminal.snapshot.structure } });
  assert.equal(confirmed.status, 200);
});

test("group planning rejects exact underallocation, overallocation, max overflow and duplicate auxiliary images", async () => {
  for (const [name, counts] of [
    ["exact underallocation", { feature_benefit: 2 }],
    ["exact overallocation", { feature_benefit: 4 }],
    ["max group overflow", { comparison: 1, included_items: 1 }],
    ["same max category twice", { comparison: 2 }],
  ] as const) {
    const candidate = groupedOutput();
    for (const row of candidate.categoryAllocations) row.count = counts[row.category as keyof typeof counts] ?? row.count;
    candidate.detailImageCount = candidate.categoryAllocations.reduce((sum, row) => sum + row.count, 0);
    const fixture = await generateGrouped(candidate, { ...groupedInput, detail_image_count_min: 0, detail_image_count_max: 10 });
    assert.equal(fixture.terminal.status, "failed", name);
    assert.equal(fixture.terminal.errorCode, "STRUCTURE_PLAN_INVALID", name);
  }
});

test("NEEDS_HUMAN_INPUT permits exact shortages only with missing facts and skips minimum and total equality", async () => {
  for (const mainMissing of [false, true]) {
    const candidate = groupedOutput();
    candidate.status = "NEEDS_HUMAN_INPUT";
    if (mainMissing) {
      candidate.mainAllocation.count = 0;
      candidate.mainAllocation.missingFacts = ["缺少商品正面参考"];
    } else {
      const row = candidate.categoryAllocations.find((row) => row.category === "feature_benefit")!;
      row.count = 1;
      row.missingFacts = ["缺少核心卖点事实"];
      candidate.detailImageCount = 4; // 已分配 3 张，等待补录后再完成规划。
    }
    const fixture = await generateGrouped(candidate);
    assert.equal(fixture.terminal.status, "succeeded", mainMissing ? "main group" : "selling points");
    const confirmed = await fixture.app.request("POST", `/api/suites/${fixture.suite.id}/structure-plan/confirm`, { body: { structure: fixture.terminal.snapshot.structure } });
    assert.equal(confirmed.status, 409);
    assert.equal((confirmed.body as any).error.code, "STRUCTURE_PLAN_NEEDS_INPUT");
  }
});

test("group confirmation preserves the optional category contract and revalidates locked counts", async () => {
  for (const mutate of [
    (structure: any) => { structure.categoryAllocations[0].requirement = "required"; },
    (structure: any) => { structure.categoryAllocations.pop(); },
    (structure: any) => { structure.categoryAllocations[0].count = 2; structure.detailImageCount = 4; },
  ]) {
    const fixture = await generateGrouped();
    const structure = structuredClone(fixture.terminal.snapshot.structure);
    mutate(structure);
    const response = await fixture.app.request("POST", `/api/suites/${fixture.suite.id}/structure-plan/confirm`, { body: { structure } });
    assert.equal(response.status, 409);
    assert.equal((response.body as any).error.code, "STRUCTURE_PLAN_INVALID");
  }
});

test("waiting grouped plans reject unexplained shortages, overflow and upper-bound violations", async () => {
  for (const [name, mutate, max] of [
    ["missing facts absent", (candidate: any) => { candidate.categoryAllocations[0].count = 1; }, 6],
    ["missing facts blank", (candidate: any) => { candidate.categoryAllocations[0].count = 1; candidate.categoryAllocations[0].missingFacts = ["  "]; }, 6],
    ["facts belong to another group", (candidate: any) => { candidate.categoryAllocations[0].count = 1; candidate.categoryAllocations[2].missingFacts = ["缺少场景事实"]; }, 6],
    ["exact overflow despite missing facts", (candidate: any) => { candidate.categoryAllocations[0].count = 4; candidate.categoryAllocations[0].missingFacts = ["缺少事实"]; }, 6],
    ["actual count exceeds detail max", (candidate: any) => { candidate.detailImageCount = 2; }, 2],
  ] as const) {
    const candidate = groupedOutput();
    candidate.status = "NEEDS_HUMAN_INPUT";
    mutate(candidate);
    const fixture = await generateGrouped(candidate, { ...groupedInput, detail_image_count_min: 0, detail_image_count_max: max });
    assert.equal(fixture.terminal.status, "failed", name);
    assert.equal(fixture.terminal.errorCode, "STRUCTURE_PLAN_INVALID", name);
  }
});

test("grouped requests enforce shared image limits and reject malformed group definitions before calling the model", async () => {
  const invalidInputs = [
    { category_groups: "{" },
    { category_groups: "[]" },
    { category_groups: JSON.stringify({ ...categoryGroups, main: { ...categoryGroups.main, count: 0 } }) },
    { category_groups: JSON.stringify({ ...categoryGroups, main: { ...categoryGroups.main, count: 6 } }) },
    { category_groups: JSON.stringify({ ...categoryGroups, selling_points: { ...categoryGroups.selling_points, count: 8 } }) },
    { category_groups: JSON.stringify({ ...categoryGroups, main: { ...categoryGroups.main, count: 5 }, selling_points: { ...categoryGroups.selling_points, count: 5 } }) },
    { category_groups: JSON.stringify({ ...categoryGroups, other: { ...categoryGroups.other, mode: "exact" } }) },
    { category_groups: JSON.stringify({ ...categoryGroups, other: { ...categoryGroups.other, categories: ["comparison", "comparison"] } }) },
    { category_groups: JSON.stringify({ ...categoryGroups, other: { ...categoryGroups.other, count: 1.5 } }) },
    { main_image_count: 2 },
    { detail_image_count_min: -1 },
    { detail_image_count_max: 11 },
    { detail_image_count_min: 7, detail_image_count_max: 6 },
  ];
  for (const patch of invalidInputs) {
    const fixture = await setup(groupedOutput(), new MemoryPlanRepository(), "prompt/normalized/general-structure-plan-groups.md");
    const response = await fixture.app.request("POST", `/api/suites/${fixture.suite.id}/structure-plan`, { headers: { "idempotency-key": "bad-group-input" }, body: { templateVersionId: fixture.template.templateVersionId, dynamicInput: { ...groupedInput, ...patch } } });
    assert.equal(response.status, 400, JSON.stringify(patch));
    assert.equal((response.body as any).error.code, "PROMPT_INPUT_INVALID");
    assert.equal(fixture.inputs.length, 0);
  }
});

test("shared custom defaults and smart matching allow factual auxiliary images below the requested upper bound", async () => {
  const candidate = groupedOutput();
  candidate.categoryAllocations[0].count = 1;
  candidate.categoryAllocations[1].count = 2;
  candidate.categoryAllocations.find((row) => row.category === "comparison")!.count = 1;
  candidate.detailImageCount = 6;
  const custom = await generateGrouped(candidate, { ...groupedInput, category_groups: JSON.stringify(DEFAULT_SUITE_CATEGORY_GROUPS) });
  assert.equal(custom.terminal.status, "succeeded");
  const smartInput = { ...dynamicInput, ...SMART_SUITE_STRUCTURE_PRESET, selected_detail_categories: groupedCategories };
  const smart = await setup(groupedOutput(), new MemoryPlanRepository(), "prompt/normalized/general-structure-plan-groups.md");
  const started = await smart.app.request("POST", `/api/suites/${smart.suite.id}/structure-plan`, { headers: { "idempotency-key": "smart" }, body: { templateVersionId: smart.template.templateVersionId, dynamicInput: smartInput } });
  const terminal = await wait(smart.app, (started.body as any).data.attemptId);
  assert.equal(terminal.status, "succeeded");
  assert.equal(terminal.snapshot.structure.detailImageCount, 5);
});
