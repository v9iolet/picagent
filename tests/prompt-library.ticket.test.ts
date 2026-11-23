import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createSuiteStudioApp } from "../server/app.js";
import {
  importPromptRecordsWithPolicy,
  isNormalizedPromptMarkdown,
  parseNormalizedPromptMarkdown,
  parsePromptMarkdown,
  resolvePromptTemplateUsedBy,
  validateDynamicInput,
} from "../server/prompt-library.js";
import { MemoryPromptRepository } from "../server/repositories/memory-prompt-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";
import type { ImageEditRequest, ImageProvider } from "../server/types.js";

const png1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

function markdown(name: string, body: string) {
  return [`### ${name}`, "", "```plain", body, "```"].join("\n");
}

test("imports only fenced prompt bodies and derives per-template input schemas", () => {
  const records = parsePromptMarkdown([
    "### 模板 A", "", "说明，不是提示词。", "", "```plain", "用户输入区：", "- 平台：Amazon", "- 品牌名：", "```",
    "", "## 不是运行模板", "普通说明", "", "### 模板 B", "", "```plain", "用户输入区：", "- 产品名称：", "```",
  ].join("\n"), "prompt.md");
  assert.equal(records.length, 2);
  assert.deepEqual(records[0].inputSchema.map((field) => field.key), ["platform", "brand_name"]);
  assert.equal(records[0].inputSchema[0].defaultValue, "Amazon");
  assert.deepEqual(records[1].inputSchema.map((field) => field.key), ["product_name"]);
  assert.match(records[0].sourceSha256, /^[a-f0-9]{64}$/);
});

test("normalized planning templates expose explicit modes and system-only runtime bodies", async () => {
  const normalized = await readFile("prompt/normalized/general-plan-combined.md", "utf8");
  const record = parseNormalizedPromptMarkdown(normalized, "prompt/normalized/general-plan-combined.md");
  assert.equal(record.code, "general.plan.combined");
  assert.equal(record.stage, "plan");
  assert.deepEqual(record.inputSchema.filter((field) => field.key.endsWith("_mode")).map((field) => field.key), [
    "output_mode",
    "main_image_count_mode",
    "detail_image_count_mode",
    "brand_mode",
    "selling_points_mode",
    "parameters_mode",
    "design_style_mode",
  ]);
  assert.equal(record.inputSchema.find((field) => field.key === "platform")?.required, true);
  assert.equal(record.body.includes("## User Prompt Template"), false);
  assert.equal((record.outputSchema.properties as Record<string, unknown>).items !== undefined, true);
});

test("normalized prompt detection accepts Windows CRLF frontmatter", () => {
  assert.equal(isNormalizedPromptMarkdown("---\r\ncode: general.plan.combined\r\n---\r\n"), true);
});

test("normalized combined template validates fixed counts and explicit no-brand mode", async () => {
  const normalized = await readFile("prompt/normalized/general-plan-combined.md", "utf8");
  const record = parseNormalizedPromptMarkdown(normalized, "prompt/normalized/general-plan-combined.md");
  const missingCounts = validateDynamicInput(record.inputSchema, {
    output_mode: "combined", platform: "Amazon", output_language: "中文",
    main_image_count_mode: "fixed", detail_image_count_mode: "auto",
    brand_mode: "no_brand", selling_points_mode: "derive", parameters_mode: "to_confirm", design_style_mode: "auto",
  });
  assert.equal(missingCounts.ok, false);
  const valid = validateDynamicInput(record.inputSchema, {
    output_mode: "combined", platform: "Amazon", output_language: "中文",
    main_image_count_mode: "fixed", main_image_count: 2, detail_image_count_mode: "auto",
    brand_mode: "no_brand", selling_points_mode: "derive", parameters_mode: "to_confirm", design_style_mode: "auto",
  });
  assert.equal(valid.ok, true);
});

test("the real prompt corpus gives every plan template usable template-specific fields", async () => {
  const records = parsePromptMarkdown(await readFile("prompt/prompt.md", "utf8"), "prompt/prompt.md");
  const planRecords = records.filter((record) => record.stage === "plan");
  assert.equal(planRecords.length, 16);
  assert.deepEqual(planRecords.filter((record) => record.inputSchema.length === 0).map((record) => record.name), []);
  const mainOnly = planRecords.find((record) => record.name === "海产品主图提示词")!;
  const detailOnly = planRecords.find((record) => record.name === "海产品详情页提示词")!;
  assert.equal(mainOnly.inputSchema.some((field) => field.key === "detail_image_count"), false);
  assert.equal(detailOnly.inputSchema.some((field) => field.key === "main_image_count"), false);
  const peopleTemplate = planRecords.find((record) => record.name.includes("可选模特与人脸规则"));
  assert.ok(peopleTemplate);
  assert.deepEqual(
    ["platform", "target_market_country", "brand_name", "product_category", "main_image_type", "model_requirement", "forbid_face", "allow_image_text"].filter((key) => !peopleTemplate.inputSchema.some((field) => field.key === key)),
    [],
  );
  assert.equal(peopleTemplate.inputSchema.find((field) => field.key === "main_image_type")?.defaultValue, undefined);
  assert.deepEqual(
    ["seafood_type", "product_specification", "net_weight", "origin", "storage_method", "shipping_method", "serving_method"].filter((key) => !mainOnly.inputSchema.some((field) => field.key === key)),
    [],
  );
  assert.equal(mainOnly.inputSchema.some((field) => field.key === "product_parameters"), false);
});

test("draft versions stay hidden until publish and public listings never expose bodies", async () => {
  const prompts = new MemoryPromptRepository();
  const [draft] = await prompts.importRecords(parsePromptMarkdown(markdown("产品图转干净产品底图返修提示词", "保持产品外观并生成白底图。"), "prompt.md"));
  assert.deepEqual(await prompts.listPublished("base_refine"), []);
  await prompts.publishVersion(draft.templateVersionId);
  await prompts.importRecords([{ ...parsePromptMarkdown(markdown("产品图转干净产品底图返修提示词", "保持产品外观并生成白底图。"), "prompt.md")[0], body: "不应覆盖已发布正文" }]);
  const listed = await prompts.listPublished("base_refine");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].templateVersionId, draft.templateVersionId);
  assert.equal("body" in listed[0], false);
  assert.equal((await prompts.getPublishedVersion(draft.templateVersionId, "plan")), null);
  assert.equal((await prompts.getPublishedVersion(draft.templateVersionId, "base_refine"))?.body, "保持产品外观并生成白底图。");
});

test("same source import is idempotent and changed source appends an immutable version", async () => {
  const prompts = new MemoryPromptRepository();
  const firstSource = parsePromptMarkdown(markdown("通用计划模板", "用户输入区：\n- 产品名称："), "prompt.md");
  const legacyDraft = [{ ...firstSource[0], inputSchema: [...firstSource[0].inputSchema, { key: "brand_name", label: "品牌名", type: "text" as const, required: false, order: 1 }] }];
  const [first] = await prompts.importRecords(legacyDraft);
  const [same] = await prompts.importRecords(firstSource);
  const [second] = await prompts.importRecords(parsePromptMarkdown(markdown("通用计划模板", "用户输入区：\n- 产品名称：\n- 品牌名："), "prompt.md"));
  assert.equal(same.templateVersionId, first.templateVersionId);
  assert.deepEqual(same.inputSchema.map((field) => field.key), ["product_name"]);
  assert.equal(second.templateId, first.templateId);
  assert.equal(second.versionNo, 2);
  assert.equal((await prompts.listVersions(first.templateId)).length, 2);
});

test("template API exposes only published stage metadata and schema", async () => {
  const prompts = new MemoryPromptRepository();
  const [draft] = await prompts.importRecords(parsePromptMarkdown(markdown("计划模板", "用户输入区：\n- 产品名称："), "prompt.md"));
  await prompts.publishVersion(draft.templateVersionId);
  const api = createSuiteStudioApp({ repository: new MemorySuiteRepository(), storage: new MemoryStorage(), promptRepository: prompts });
  const response = await api.request("GET", "/api/prompt-templates?stage=plan");
  assert.equal(response.status, 200);
  assert.equal(response.body.data[0].templateVersionId, draft.templateVersionId);
  assert.deepEqual(response.body.data[0].inputSchema.map((field: { key: string }) => field.key), ["product_name"]);
  assert.equal("body" in response.body.data[0], false);
});

test("platform API exposes maintained dropdown options without prompt bodies", async () => {
  const api = createSuiteStudioApp({
    repository: new MemorySuiteRepository(),
    storage: new MemoryStorage(),
    platformRepository: {
      async listEnabled() {
        return [{ code: "amazon", name: "Amazon", marketScope: "overseas", mainImageBackground: "pure_white_required", mainImageStrategy: "白底", galleryStrategy: "细节", textStrategy: "无首图文字", modelStrategy: "默认无脸", sourceNote: "official", sortOrder: 10 }];
      },
      async find(value: string) { return value === "amazon" ? (await this.listEnabled())[0] : null; },
    },
  });
  const response = await api.request("GET", "/api/platforms");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data.map((platform: { code: string }) => platform.code), ["amazon"]);
  assert.equal(response.body.data[0].mainImageStrategy, "白底");
  assert.equal(response.body.data[0].mainImageBackground, "pure_white_required");
});

test("base generation loads a published PG template and freezes its version and dynamic input", async () => {
  const prompts = new MemoryPromptRepository();
  const [draft] = await prompts.importRecords(parsePromptMarkdown(markdown("产品图转干净产品底图返修提示词", "保持产品外观并生成白底图。"), "prompt.md"));
  await prompts.publishVersion(draft.templateVersionId);
  const calls: ImageEditRequest[] = [];
  const provider: ImageProvider = { edit: async (request) => { calls.push(request); return { bytes: png1x1, mimeType: "image/png" }; } };
  const repository = new MemorySuiteRepository();
  const api = createSuiteStudioApp({ repository, storage: new MemoryStorage(), provider, promptRepository: prompts });
  const suite = await api.request("POST", "/api/suites", { body: { name: "模板快照" } });
  const uploaded = await api.upload(suite.body.data.id, { filename: "product.png", mimeType: "image/png", bytes: png1x1 });
  const path = `/api/suites/${suite.body.data.id}/input-images/${uploaded.body.data.id}/base-generation`;
  const missing = await api.request("POST", path, { headers: { "idempotency-key": "missing-template" } });
  assert.equal(missing.status, 400);
  const generated = await api.request("POST", path, { headers: { "idempotency-key": "with-template" }, body: { templateVersionId: draft.templateVersionId, dynamicInput: {} } });
  assert.equal(generated.status, 202);
  for (let index = 0; index < 100 && (await repository.listGenerationAttempts(suite.body.data.id, uploaded.body.data.id))[0]?.status === "running"; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(calls[0].prompt, "保持产品外观并生成白底图。");
  assert.equal(generated.body.data.attempt.templateVersionId, draft.templateVersionId);
  const attempts = await repository.listGenerationAttempts(suite.body.data.id, uploaded.body.data.id);
  assert.equal(attempts[0].promptTemplateVersionId, draft.templateVersionId);
  assert.deepEqual(attempts[0].dynamicInput, {});
});

test("replica_prompt normalized templates parse applicability.cloneLevel, publish, and query by stage", async () => {
  const composePath = "prompt/normalized/replica-compose.md";
  const highPath = "prompt/normalized/replica-high.md";
  const composeMd = await readFile(composePath, "utf8");
  const highMd = await readFile(highPath, "utf8");
  assert.equal(isNormalizedPromptMarkdown(composeMd), true);
  assert.equal(isNormalizedPromptMarkdown(highMd), true);

  const composeRecord = parseNormalizedPromptMarkdown(composeMd, composePath);
  const highRecord = parseNormalizedPromptMarkdown(highMd, highPath);
  assert.equal(composeRecord.code, "replica.compose");
  assert.equal(composeRecord.stage, "replica_prompt");
  assert.equal(composeRecord.applicability.cloneLevel, "compose");
  assert.equal(highRecord.code, "replica.high");
  assert.equal(highRecord.stage, "replica_prompt");
  assert.equal(highRecord.applicability.cloneLevel, "high");

  for (const record of [composeRecord, highRecord]) {
    assert.equal((record.outputSchema.properties as Record<string, { const?: string }>).schemaVersion?.const, "replica-prompt-v1");
    assert.match(record.body, /构图/);
    assert.match(record.body, /品牌/);
    assert.match(record.body, /\{\{productInfo\}\}/);
    assert.match(record.body, /\{\{language\}\}/);
    assert.match(record.body, /AI 虚拟模特|AI 模特/);
    assert.match(record.body, /通用示意商品/);
    assert.match(record.body, /\{\{sceneType\}\}/);
    assert.match(record.body, /\{\{unifiedRequirement\}\}/);
    assert.match(record.body, /\{\{styleUnified\}\}/);
    assert.match(record.body, /参考图/);
    assert.match(record.body, /替换为/);
  }
  assert.match(composeRecord.body, /重新调整配色|重新调整色彩与场景/);
  assert.doesNotMatch(composeRecord.body, /迁移配色逻辑/);
  assert.match(composeRecord.body, /保留清单/);
  assert.match(composeRecord.body, /必须改变清单/);
  assert.match(composeRecord.body, /主体姿势\/动作/);
  assert.match(composeRecord.body, /场景陈设与道具/);
  assert.match(composeRecord.body, /光线方向与色温/);
  assert.match(composeRecord.body, /背景材质/);
  assert.match(highRecord.body, /保持参考图的视觉结构|保持参考图视觉结构/);
  assert.match(highRecord.body, /九宫格/);
  assert.match(highRecord.body, /与参考图保持相同的构图与元素位置，只替换为目标商品和新文案/);

  const prompts = new MemoryPromptRepository();
  const imported = await prompts.importRecords([composeRecord, highRecord]);
  assert.deepEqual(await prompts.listPublished("replica_prompt"), []);
  for (const version of imported) await prompts.publishVersion(version.templateVersionId);

  const listed = await prompts.listPublished("replica_prompt");
  assert.deepEqual(listed.map((item) => item.code).sort(), ["replica.compose", "replica.high"]);
  assert.equal(listed.find((item) => item.code === "replica.compose")?.applicability.cloneLevel, "compose");
  assert.equal(listed.find((item) => item.code === "replica.high")?.applicability.cloneLevel, "high");

  const api = createSuiteStudioApp({ repository: new MemorySuiteRepository(), storage: new MemoryStorage(), promptRepository: prompts });
  const response = await api.request("GET", "/api/prompt-templates?stage=replica_prompt");
  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.data.map((item: { code: string; applicability: { cloneLevel?: string } }) => [item.code, item.applicability.cloneLevel]).sort(),
    [["replica.compose", "compose"], ["replica.high", "high"]],
  );
  assert.equal("body" in response.body.data[0], false);

  const migrationSql = await readFile("db/migrations/032_replica_prompt_templates.sql", "utf8");
  assert.match(migrationSql, /'replica_prompt'/);
  assert.match(migrationSql, /'replica\.compose'/);
  assert.match(migrationSql, /'replica\.high'/);
  assert.match(migrationSql, /'cloneLevel'/);

  const migrationV2Sql = await readFile("db/migrations/036_replica_prompt_templates_v2.sql", "utf8");
  assert.match(migrationV2Sql, /'replica\.compose'/);
  assert.match(migrationV2Sql, /'replica\.high'/);
  assert.match(migrationV2Sql, /replica-v2:/);
  assert.doesNotMatch(migrationV2Sql, /迁移配色逻辑/);
  assert.match(migrationV2Sql, /保留清单/);
  assert.match(migrationV2Sql, /必须改变清单/);
  assert.match(migrationV2Sql, /与参考图保持相同的构图与元素位置，只替换为目标商品和新文案/);
});

test("re-importing unchanged replica markdown does not create a v2 draft when seeded sourceSha256 differs", async () => {
  const composePath = "prompt/normalized/replica-compose.md";
  const composeMd = await readFile(composePath, "utf8");
  const record = parseNormalizedPromptMarkdown(composeMd, composePath);

  const prompts = new MemoryPromptRepository();
  const [seeded] = await prompts.importRecords([{ ...record, sourceSha256: "0".repeat(64) }]);
  await prompts.publishVersion(seeded.templateVersionId);

  const [reimported] = await prompts.importRecords([record]);
  assert.equal(reimported.templateVersionId, seeded.templateVersionId);
  assert.equal(reimported.versionNo, 1);
  assert.equal((await prompts.listVersions(seeded.templateId)).length, 1);

  const modifiedMd = composeMd.replace("重新调整配色方案", "重新调整配色方案与材质层次");
  const modifiedRecord = parseNormalizedPromptMarkdown(modifiedMd, composePath);
  const [v2] = await prompts.importRecords([modifiedRecord]);
  assert.equal(v2.versionNo, 2);
  assert.equal(v2.status, "draft");
  assert.equal((await prompts.listVersions(seeded.templateId)).length, 2);

  // Copy published v1 as an identical-content draft v3; semantic match must prefer published v1 over draft v3
  const copiedDraft = await prompts.copyVersion(seeded.templateVersionId);
  assert.ok(copiedDraft);
  assert.equal(copiedDraft.status, "draft");
  const [preferredPublished] = await prompts.importRecords([{ ...record, sourceSha256: "2".repeat(64) }]);
  assert.equal(preferredPublished.templateVersionId, seeded.templateVersionId);
  assert.equal(preferredPublished.status, "published");

  // Publish v2 (retires v1) and retire copiedDraft; re-importing v1 content with a new sha256 must NOT match retired v1
  await prompts.publishVersion(v2.templateVersionId);
  await prompts.retireVersion(copiedDraft.templateVersionId);
  const [v4] = await prompts.importRecords([{ ...record, sourceSha256: "3".repeat(64), templateVersionId: "11111111-1111-5111-8111-111111111111" }]);
  assert.equal(v4.status, "draft");
  assert.notEqual(v4.templateVersionId, seeded.templateVersionId);
  assert.equal(v4.versionNo, 4);
});

test("prompt template usage mapping, retirement policy, read-by-id for retired versions, and re-import idempotency", async () => {
  const files = [
    "prompt/normalized/general-base-refine.md",
    "prompt/normalized/general-structure-plan-groups.md",
    "prompt/normalized/general-category-prompt-groups.md",
    "prompt/normalized/general-listing-copy.md",
    "prompt/normalized/replica-compose.md",
    "prompt/normalized/replica-high.md",
    "prompt/normalized/general-plan-combined.md",
    "prompt/normalized/apparel-plan-detail.md",
    "prompt/normalized/general-repair-design.md",
    "prompt/normalized/general-repair-text.md",
  ];
  const records = await Promise.all(
    files.map(async (file) => parseNormalizedPromptMarkdown(await readFile(file, "utf8"), file)),
  );
  const prompts = new MemoryPromptRepository();
  const firstRun = await importPromptRecordsWithPolicy(prompts, records, { publish: true });
  assert.equal(firstRun.length, files.length);

  const api = createSuiteStudioApp({
    repository: new MemorySuiteRepository(),
    storage: new MemoryStorage(),
    promptRepository: prompts,
  });

  // Default published list returns ONLY the 6 active templates, each annotated with usedBy and no body
  const publishedRes = await api.request("GET", "/api/prompt-templates");
  assert.equal(publishedRes.status, 200);
  const publishedItems = publishedRes.body.data as Array<{
    code: string;
    stage: string;
    usedBy: string[];
    templateVersionId: string;
  }>;
  assert.deepEqual(
    publishedItems.map((item) => item.code).sort(),
    [
      "general.base_refine",
      "general.category-prompt",
      "general.listing-copy",
      "general.structure-plan",
      "replica.compose",
      "replica.high",
    ],
  );
  for (const item of publishedItems) {
    assert.equal("body" in item, false);
    assert.ok(Array.isArray(item.usedBy) && item.usedBy.length > 0, `${item.code} must have usedBy`);
  }
  assert.deepEqual(publishedItems.find((i) => i.code === "general.structure-plan")?.usedBy, ["套图·结构规划"]);
  assert.deepEqual(publishedItems.find((i) => i.code === "general.category-prompt")?.usedBy, ["套图·品类提示词"]);
  assert.deepEqual(publishedItems.find((i) => i.code === "general.base_refine")?.usedBy, ["套图·白底精修"]);
  assert.deepEqual(publishedItems.find((i) => i.code === "general.listing-copy")?.usedBy, ["上架文案"]);
  assert.deepEqual(publishedItems.find((i) => i.code === "replica.compose")?.usedBy, ["爆品图复刻·参考风格"]);
  assert.deepEqual(publishedItems.find((i) => i.code === "replica.high")?.usedBy, ["爆品图复刻·高度复刻"]);

  // Unused templates are retired and excluded from default published list, but visible with status=retired / status=all
  const retiredRes = await api.request("GET", "/api/prompt-templates?status=retired");
  assert.equal(retiredRes.status, 200);
  const retiredItems = retiredRes.body.data as Array<{ code: string; status: string; usedBy: string[]; templateVersionId: string }>;
  assert.deepEqual(
    retiredItems.map((item) => item.code).sort(),
    ["apparel.plan.detail", "general.plan.combined", "general.repair.design", "general.repair.text"],
  );
  for (const item of retiredItems) {
    assert.equal(item.status, "retired");
    assert.deepEqual(item.usedBy, []);
    assert.equal("body" in item, false);
  }

  // Reading a retired version by ID remains available for historical snapshots and read-only views
  const retiredPlan = retiredItems.find((item) => item.code === "general.plan.combined")!;
  const byId = await api.request("GET", `/api/prompt-templates/${retiredPlan.templateVersionId}`);
  assert.equal(byId.status, 200);
  assert.equal(byId.body.data.templateVersionId, retiredPlan.templateVersionId);
  assert.equal(byId.body.data.status, "retired");
  assert.deepEqual(byId.body.data.usedBy, []);
  assert.ok(typeof byId.body.data.body === "string" && byId.body.data.body.length > 0);

  // Invalid status returns 400 INVALID_PROMPT_STATUS
  const invalidStatus = await api.request("GET", "/api/prompt-templates?status=bogus");
  assert.equal(invalidStatus.status, 400);
  assert.equal((invalidStatus.body as any).error.code, "INVALID_PROMPT_STATUS");

  // Re-running seed import with publish=true does NOT revert retired templates back to published or add duplicate versions
  const secondRun = await importPromptRecordsWithPolicy(prompts, records, { publish: true });
  assert.equal(secondRun.length, files.length);
  const publishedAfter = await api.request("GET", "/api/prompt-templates");
  assert.equal((publishedAfter.body.data as unknown[]).length, 6);
  for (const item of retiredItems) {
    const versions = await prompts.listVersions(
      firstRun.find((v) => v.code === item.code)!.templateId,
    );
    assert.equal(versions.length, 1);
    assert.equal(versions[0].status, "retired");
  }

  // Reverse prompt stage resolves empty usedBy
  assert.deepEqual(resolvePromptTemplateUsedBy({ code: "reverse.main.white", stage: "reverse_prompt" }), []);
});
