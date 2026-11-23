import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseNormalizedPromptMarkdown, type PromptTemplateRuntime } from "../server/prompt-library.js";
import { buildReplicaPromptUserContent, DashScopeLlmClient } from "../server/providers/dashscope-llm-client.js";
import {
  analyzeReplicaPrompts,
  buildReplicaPromptInput,
  parseAndValidateReplicaPromptOutput,
  ReplicaPromptError,
  resolveReplicaPromptTemplate,
} from "../server/replica/replica-prompt.js";
import { MemoryPromptRepository } from "../server/repositories/memory-prompt-repository.js";
import type { LlmClient, ReplicaPromptLlmInput } from "../server/types.js";

async function loadTemplate(cloneLevel: "compose" | "high"): Promise<PromptTemplateRuntime> {
  const path = cloneLevel === "compose" ? "prompt/normalized/replica-compose.md" : "prompt/normalized/replica-high.md";
  const record = parseNormalizedPromptMarkdown(await readFile(path, "utf8"), path);
  const prompts = new MemoryPromptRepository();
  const [draft] = await prompts.importRecords([record]);
  return (await prompts.publishVersion(draft.templateVersionId))!;
}

function fakeLlm(responder: (input: ReplicaPromptLlmInput) => unknown): LlmClient {
  return {
    provider: "fake-vision",
    model: "qwen-vl-max",
    isFake: true,
    generatePlan: async () => ({}),
    generateReplicaPrompts: async (input) => responder(input),
  };
}

function sampleRefs() {
  return [
    { referenceId: "ref-2", ordinal: 2, requirement: "突出金属拉丝质感", mimeType: "image/jpeg", bytes: Buffer.from("ref-2-thumb") },
    { referenceId: "ref-1", ordinal: 1, requirement: "顶部保留标题区", mimeType: "image/jpeg", bytes: Buffer.from("ref-1-thumb") },
  ];
}

function sampleProducts() {
  return [
    { id: "prod-2", ordinal: 2, mimeType: "image/png", bytes: Buffer.from("prod-2-thumb") },
    { id: "prod-1", ordinal: 1, mimeType: "image/png", bytes: Buffer.from("prod-1-thumb") },
  ];
}

test("analyzeReplicaPrompts returns normalized replica-prompt-v1 output ordered by reference ordinal", async () => {
  const template = await loadTemplate("high");
  let capturedInput: ReplicaPromptLlmInput | null = null;
  const llm = fakeLlm((input) => {
    capturedInput = input;
    return {
      schemaVersion: "replica-prompt-v1",
      taskName: "不锈钢保温杯",
      sharedStyle: "清冷极简棚拍风，低饱和银灰与暖白主光协调统一",
      items: [
        {
          referenceId: "ref-2",
          visualStructure: { composition: "斜角特写", lighting: "侧逆光", palette: "银灰+暖白", layout: "左下卖点", textBlocks: ["左下角短文案区"] },
          copy: [{ role: "selling_point", text: "316不锈钢内胆", position: "左下" }],
          prompt: "银灰色不锈钢保温杯斜角特写置于浅灰石纹台面，侧逆光勾勒金属拉丝质感，左下角清晰排布现代无衬线中文文案「316不锈钢内胆」。",
        },
        {
          referenceId: "ref-1",
          visualStructure: { composition: "居中竖构图", lighting: "柔和顶光", palette: "银灰+暖白", layout: "上文下图", textBlocks: ["顶部居中标题区"] },
          copy: [{ role: "headline", text: "轻盈随行 持久保温", position: "顶部居中" }],
          prompt: "银灰色不锈钢保温杯居中摆放于浅暖灰极简台面，柔和顶光与细腻倒影，画面顶部居中呈现清晰中文标题「轻盈随行 持久保温」。",
        },
      ],
    };
  });

  const { input, output } = await analyzeReplicaPrompts({
    llm,
    template,
    cloneLevel: "high",
    sceneType: "电商商品图",
    language: "中文",
    styleUnified: true,
    unifiedRequirement: "整体保持高级简约质感",
    productInfo: "316不锈钢内胆，500ml",
    references: sampleRefs(),
    productImages: sampleProducts(),
  });

  assert.ok(capturedInput);
  assert.deepEqual(input.references.map((item) => item.referenceId), ["ref-1", "ref-2"]);
  assert.deepEqual(input.productImages.map((item) => item.id), ["prod-1", "prod-2"]);
  assert.equal(output.schemaVersion, "replica-prompt-v1");
  assert.equal(output.taskName, "不锈钢保温杯");
  assert.equal(output.sharedStyle, "清冷极简棚拍风，低饱和银灰与暖白主光协调统一");
  assert.deepEqual(output.items.map((item) => item.referenceId), ["ref-1", "ref-2"]);
  assert.equal(output.items[0].copy[0].text, "轻盈随行 持久保温");
});

test("analyzeReplicaPrompts truncates taskName to 20 characters and clears sharedStyle when styleUnified is false", async () => {
  const template = await loadTemplate("compose");
  const llm = fakeLlm(() => ({
    schemaVersion: "replica-prompt-v1",
    taskName: "超长商品名称一二三四五六七八九十甲乙丙丁戊己庚辛",
    sharedStyle: "模型误输出了整组风格，应当被强制清空",
    items: [
      {
        referenceId: "ref-1",
        visualStructure: { composition: "中心构图" },
        copy: ["极简生活美学"],
        prompt: "哑光米白色陶瓷马克杯置于木质餐桌，暖阳斜照，画面上方呈现柔和中文标语「极简生活美学」。",
      },
    ],
  }));

  const { output } = await analyzeReplicaPrompts({
    llm,
    template,
    cloneLevel: "compose",
    sceneType: "社媒图文",
    language: "中文",
    styleUnified: false,
    references: [sampleRefs()[1]],
    productImages: [],
  });

  assert.equal(Array.from(output.taskName).length, 20);
  assert.equal(output.taskName, "超长商品名称一二三四五六七八九十甲乙丙丁");
  assert.equal(output.sharedStyle, null);
  assert.deepEqual(output.items[0].copy, [{ text: "极简生活美学" }]);
});

test("rejects missing item, extra item, mismatched referenceId, duplicate referenceId, empty prompt, and bad schemaVersion with REPLICA_OUTPUT_INVALID", async () => {
  const template = await loadTemplate("high");
  const baseValidItem = (referenceId: string) => ({
    referenceId,
    visualStructure: { composition: "居中" },
    copy: [],
    prompt: `商品展示画面 ${referenceId}`,
  });

  const cases: Array<{ name: string; raw: unknown; detailPattern: RegExp }> = [
    {
      name: "缺项",
      raw: { schemaVersion: "replica-prompt-v1", taskName: "", sharedStyle: null, items: [baseValidItem("ref-1")] },
      detailPattern: /缺少参考图 "ref-2"/,
    },
    {
      name: "多项",
      raw: { schemaVersion: "replica-prompt-v1", taskName: "", sharedStyle: null, items: [baseValidItem("ref-1"), baseValidItem("ref-2"), baseValidItem("ref-3")] },
      detailPattern: /ref-3.*不在输入参考图列表/,
    },
    {
      name: "id 不匹配",
      raw: { schemaVersion: "replica-prompt-v1", taskName: "", sharedStyle: null, items: [baseValidItem("ref-1"), baseValidItem("ref-wrong")] },
      detailPattern: /ref-wrong.*不在输入参考图列表/,
    },
    {
      name: "id 重复",
      raw: { schemaVersion: "replica-prompt-v1", taskName: "", sharedStyle: null, items: [baseValidItem("ref-1"), baseValidItem("ref-1")] },
      detailPattern: /ref-1.*重复/,
    },
    {
      name: "空 prompt",
      raw: {
        schemaVersion: "replica-prompt-v1",
        taskName: "",
        sharedStyle: null,
        items: [baseValidItem("ref-1"), { ...baseValidItem("ref-2"), prompt: "   " }],
      },
      detailPattern: /ref-2.*prompt 不能为空/,
    },
    {
      name: "schemaVersion 错误",
      raw: { schemaVersion: "reverse-prompt-v1", taskName: "", sharedStyle: null, items: [baseValidItem("ref-1"), baseValidItem("ref-2")] },
      detailPattern: /schemaVersion/,
    },
  ];

  for (const item of cases) {
    await assert.rejects(
      () =>
        analyzeReplicaPrompts({
          llm: fakeLlm(() => item.raw),
          template,
          cloneLevel: "high",
          sceneType: "电商商品图",
          language: "中文",
          styleUnified: true,
          references: sampleRefs(),
          productImages: sampleProducts(),
        }),
      (error: unknown) => {
        assert.ok(error instanceof ReplicaPromptError, `${item.name}: expected ReplicaPromptError`);
        assert.equal(error.code, "REPLICA_OUTPUT_INVALID", `${item.name}: expected REPLICA_OUTPUT_INVALID`);
        assert.match(error.message, item.detailPattern, `${item.name}: message should include detail`);
        assert.ok(error.details.length > 0, `${item.name}: details should be non-empty`);
        return true;
      },
    );
  }
});

test("parseAndValidateReplicaPromptOutput handles JSON strings and rejects malformed JSON", () => {
  const parsed = parseAndValidateReplicaPromptOutput(
    '```json\n{"schemaVersion":"replica-prompt-v1","taskName":"护手霜","sharedStyle":"柔光奶油色","items":[{"referenceId":"ref-1","visualStructure":{},"copy":[],"prompt":"柔和棚拍光下的白色护手霜静物图"}]}\n```',
    { expectedReferenceIds: ["ref-1"], styleUnified: true },
  );
  assert.equal(parsed.taskName, "护手霜");
  assert.equal(parsed.sharedStyle, "柔光奶油色");

  assert.throws(
    () => parseAndValidateReplicaPromptOutput("{bad-json", { expectedReferenceIds: ["ref-1"], styleUnified: false }),
    (error: unknown) => error instanceof ReplicaPromptError && error.code === "REPLICA_OUTPUT_INVALID",
  );
});

test("buildReplicaPromptUserContent and DashScopeLlmClient.generateReplicaPrompts send ordered thumbnails with json_object and temperature 0", async () => {
  const template = await loadTemplate("high");
  const input = buildReplicaPromptInput({
    requestId: `replica-unit-${Date.now()}`,
    template,
    cloneLevel: "high",
    sceneType: "电商商品图",
    language: "英文",
    styleUnified: true,
    unifiedRequirement: "Keep clean studio shadows",
    productInfo: "65W GaN charger",
    references: sampleRefs(),
    productImages: sampleProducts(),
  });

  const userContent = buildReplicaPromptUserContent(input);
  assert.equal(userContent[0].type, "text");
  assert.match(userContent[0].text, /电商商品图/);
  assert.match(userContent[0].text, /英文/);
  assert.match(userContent[0].text, /65W GaN charger/);
  assert.match(userContent[0].text, /Keep clean studio shadows/);
  assert.match(userContent[0].text, /顶部保留标题区/);
  assert.equal(userContent.length, 5);
  assert.deepEqual(
    userContent.slice(1).map((part) => (part.type === "image_url" ? part.image_url.url : "")),
    [
      `data:image/jpeg;base64,${Buffer.from("ref-1-thumb").toString("base64")}`,
      `data:image/jpeg;base64,${Buffer.from("ref-2-thumb").toString("base64")}`,
      `data:image/png;base64,${Buffer.from("prod-1-thumb").toString("base64")}`,
      `data:image/png;base64,${Buffer.from("prod-2-thumb").toString("base64")}`,
    ],
  );

  const originalFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> | null = null;
  try {
    globalThis.fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  schemaVersion: "replica-prompt-v1",
                  taskName: "65W GaN Charger",
                  sharedStyle: "Minimalist metallic studio tone",
                  items: [
                    { referenceId: "ref-1", visualStructure: { composition: "centered" }, copy: [{ role: "title", text: "65W Fast Charge" }], prompt: "Studio shot of compact 65W charger centered on matte stone with crisp title 65W Fast Charge." },
                    { referenceId: "ref-2", visualStructure: { composition: "close-up" }, copy: [], prompt: "Angled close-up of compact 65W charger showing metallic texture under crisp side lighting." },
                  ],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 80 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const client = new DashScopeLlmClient("https://example.test/v1/", "secret-key", "qwen-vl-max");
    const { output } = await analyzeReplicaPrompts({
      llm: client,
      template,
      cloneLevel: "high",
      sceneType: "电商商品图",
      language: "英文",
      styleUnified: true,
      unifiedRequirement: "Keep clean studio shadows",
      productInfo: "65W GaN charger",
      references: sampleRefs(),
      productImages: sampleProducts(),
    });

    assert.ok(capturedBody);
    assert.equal(capturedBody.temperature, 0);
    assert.deepEqual(capturedBody.response_format, { type: "json_object" });
    assert.equal(output.schemaVersion, "replica-prompt-v1");
    assert.equal(output.items.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolveReplicaPromptTemplate selects published replica_prompt templates by cloneLevel", async () => {
  const prompts = new MemoryPromptRepository();
  const compose = parseNormalizedPromptMarkdown(await readFile("prompt/normalized/replica-compose.md", "utf8"), "prompt/normalized/replica-compose.md");
  const high = parseNormalizedPromptMarkdown(await readFile("prompt/normalized/replica-high.md", "utf8"), "prompt/normalized/replica-high.md");
  const imported = await prompts.importRecords([compose, high]);
  for (const version of imported) await prompts.publishVersion(version.templateVersionId);

  const resolvedCompose = await resolveReplicaPromptTemplate(prompts, "compose");
  const resolvedHigh = await resolveReplicaPromptTemplate(prompts, "high");
  assert.equal(resolvedCompose?.code, "replica.compose");
  assert.equal(resolvedCompose?.applicability.cloneLevel, "compose");
  assert.equal(resolvedHigh?.code, "replica.high");
  assert.equal(resolvedHigh?.applicability.cloneLevel, "high");
});
