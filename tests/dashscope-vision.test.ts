import assert from "node:assert/strict";
import test from "node:test";
import { buildPlanUserContent, DashScopeLlmClient } from "../server/providers/dashscope-llm-client.js";
import type { PlatformProfile } from "../server/types.js";

test("builds a multimodal planning message with the actual image bytes", () => {
  const content = buildPlanUserContent({
    templateVersionId: "template-1",
    templateBody: "system",
    dynamicInput: { product_name: "鼠标" },
    humanInput: {},
    chunks: [],
    inputImageIds: ["input-1"],
    baseVersionIds: ["base-1"],
    visionImages: [{ id: "input-1", sourceKind: "base", sourceVersionId: "base-1", mimeType: "image/png", bytes: Buffer.from("png-bytes") }],
  });
  assert.equal(content[0].type, "text");
  assert.equal(content[1].type, "image_url");
  assert.equal(content[1].image_url.url, `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`);
});

test("planning messages carry the platform background tier and its main-image constraints", () => {
  const cases: Array<[PlatformProfile["mainImageBackground"], RegExp]> = [
    ["pure_white_required", /必须.*纯白.*RGB 255,255,255.*文字.*Logo.*水印.*装饰/],
    ["white_preferred", /优先白底或干净浅色背景/],
    ["flexible", /按平台策略.*场景/],
  ];
  for (const [background, requirement] of cases) {
    const content = buildPlanUserContent({
      templateVersionId: "template-1", templateBody: "system", dynamicInput: {}, humanInput: {},
      chunks: [], inputImageIds: [], baseVersionIds: [],
      platformProfile: {
        code: "test", name: "测试平台", marketScope: "overseas", mainImageBackground: background,
        mainImageStrategy: "展示真实商品", galleryStrategy: "多角度", textStrategy: "文字清晰", modelStrategy: "以商品为主", sourceNote: "test", sortOrder: 1,
      },
    });
    assert.equal(content[0].type, "text");
    assert.match(content[0].text, new RegExp(`主图背景要求：${background}`));
    assert.match(content[0].text, requirement);
    assert.match(content[0].text, /主图策略：展示真实商品/);
  }
});

test("A+ AI 帮写向视觉模型请求纯文本，原样返回内容供接口校验", async (t) => {
  const output = "用侧光突出磨砂杯身。";
  const requests: unknown[] = [];
  const contents = [output, ""];
  t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
    assert.equal(url.href, "https://vision.example.test/chat/completions");
    requests.push(JSON.parse(String(options.body)));
    return Response.json({ choices: [{ message: { content: contents.shift() } }] });
  });
  const client = new DashScopeLlmClient("https://vision.example.test", "fake-test-key", "test-vision");
  const image = { id: "input-1", sourceKind: "original" as const, sourceVersionId: null, mimeType: "image/jpeg", bytes: Buffer.from("jpeg-bytes") };
  const input = {
    templateVersionId: "template-1", templateBody: "补全卖点", userPrompt: "当前文本", visionImages: [image],
  };
  assert.equal(await client.generateAplusAiWrite(input), output);
  assert.equal(await client.generateAplusAiWrite(input), "");
  assert.deepEqual(requests, Array.from({ length: 2 }, () => ({
    model: "test-vision", temperature: 0,
    messages: [
      { role: "system", content: "补全卖点" },
      { role: "user", content: [
        { type: "text", text: "当前文本" },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image.bytes.toString("base64")}` } },
      ] },
    ],
  })));
});
