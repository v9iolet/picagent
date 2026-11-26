import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  renderAplusAiWritePrompt,
  renderAplusImagePrompt,
  renderAplusPlanPrompt,
  resolveAplusPromptTemplate,
} from "../server/aplus/aplus-prompt.js";
import { parseNormalizedPromptMarkdown } from "../server/prompt-library.js";
import { MemoryPromptRepository } from "../server/repositories/memory-prompt-repository.js";
import { APLUS_MODULES } from "../shared/aplus.js";
import { emptyProductCardFields } from "../shared/product-card.js";
import { resolveVisualStyle } from "../shared/selling-point-layouts.js";

async function readTemplate(name: string) {
  const source = `prompt/normalized/aplus-${name}.md`;
  const record = parseNormalizedPromptMarkdown(await readFile(source, "utf8"), source);
  assert.ok(record.userPromptTemplate, source);
  return { ...record, userPromptTemplate: record.userPromptTemplate };
}

const planTemplate = await readTemplate("plan");
const imageTemplate = await readTemplate("image");
const aiWriteTemplate = await readTemplate("ai-write");
const moduleRuleTemplates = await Promise.all(APLUS_MODULES.map(({ code }) => readTemplate(`module-${code}`)));
const input = {
  inputImageIds: ["thumbnail-front", "thumbnail-side"],
  productInfo: "水杯，容量【待补充：容量】",
  platform: "amazon",
  targetMarket: "美国",
  language: "英文",
  selectedModules: ["comparison", "hero"] as const,
  moduleRuleTemplates,
};

test("A+ 单模板阶段优先读取规范 code，缺少已发布的规范模板时使用该阶段的首项", async () => {
  const prompts = new MemoryPromptRepository();
  const stages = [
    ["aplus_plan", planTemplate],
    ["aplus_image", imageTemplate],
    ["aplus_ai_write", aiWriteTemplate],
  ] as const;

  for (const [stage, canonical] of stages) {
    const alternate = {
      ...canonical,
      code: `${canonical.code}.alternate`,
      name: `A ${canonical.name}`,
      templateId: randomUUID(),
      templateVersionId: randomUUID(),
    };
    await prompts.importRecords([alternate, canonical]);
    await prompts.publishVersion(alternate.templateVersionId);
    assert.equal((await resolveAplusPromptTemplate(prompts, stage))?.templateVersionId, alternate.templateVersionId);

    await prompts.publishVersion(canonical.templateVersionId);
    assert.deepEqual((await prompts.listPublished(stage)).map(({ code }) => code), [alternate.code, canonical.code]);
    assert.equal((await resolveAplusPromptTemplate(prompts, stage))?.templateVersionId, canonical.templateVersionId);
  }
});

test("A+ 渲染按字面保留输入中的花括号和替换标记", () => {
  const productInfo = "商品描述 {{unknown}} $& {{language}}";
  const { userPrompt } = renderAplusPlanPrompt(planTemplate, { ...input, productInfo, sizePresets: ["aplus_standard"] });
  assert.equal(userPrompt.match(/^商品卖点与生成要求：(.+)$/m)?.[1], productInfo);
  assert.match(userPrompt, /^输出语言：英文$/m);
});

test("A+ 规划按所选顺序拼入对应模块规则，并保留原图与商品事实的来源", () => {
  const { systemPrompt, userPrompt } = renderAplusPlanPrompt(planTemplate, {
    ...input,
    productCardSnapshot: { ...emptyProductCardFields(), name: "随行水杯", specifications: "500 mL" },
    sizePresets: ["aplus_standard"],
    listingCopyRules: { titleMaxLength: 100, maxBulletPoints: 5, supportsSearchTerms: false, forbiddenWords: ["best"] },
  });
  assert.deepEqual([...systemPrompt.matchAll(/^模块代码：(.+)$/gm)].map((match) => match[1]), ["comparison", "hero"]);
  assert.match(systemPrompt, /不得出现竞品品牌、竞品商品/);
  assert.doesNotMatch(systemPrompt, /### (使用场景图|品牌故事图|售后保障图)/);
  assert.match(systemPrompt, /占位都视为缺失/);
  assert.match(systemPrompt, /以商品卡快照优先/);
  assert.match(systemPrompt, /AI 智能匹配.*按品类定调/);
  assert.match(systemPrompt, /浅色商品的首屏和核心信息模块优先用深色/);
  assert.match(systemPrompt, /相邻模块.*背景明度、色温或空间景别/);
  assert.match(systemPrompt, /相邻模块的版式结构必须互斥/);
  assert.match(systemPrompt, /整套最多一个模块使用等分卡片网格/);
  const auto = resolveVisualStyle("auto");
  assert.ok(userPrompt.includes(`视觉风格要求：${auto.name}：${auto.promptDirective}`));
  assert.match(userPrompt, /\["thumbnail-front","thumbnail-side"\]/);
  assert.match(userPrompt, /商品卖点与生成要求：水杯，容量【待补充：容量】/);
  assert.match(userPrompt, /商品卡快照事实：商品名称：随行水杯\n规格参数与尺寸重量：500 mL/);
  assert.match(userPrompt, /"forbiddenWords":\["best"\]/);
  assert.match(userPrompt, /画面文字模式：按指定语言编写画面文案/);
  assert.match(userPrompt, /构图规划方式：按所选尺寸规划构图/);
  assert.doesNotMatch(userPrompt, /aplus_premium_/);
  assert.throws(() => renderAplusPlanPrompt(planTemplate, {
    ...input, moduleRuleTemplates: [], sizePresets: ["aplus_standard"],
  }), /No published A\+ module rule for comparison/);
});

test("A+ 不加文字时不规划文案，高级 A+ 两端各自规划构图", () => {
  const { systemPrompt, userPrompt } = renderAplusPlanPrompt(planTemplate, {
    ...input, language: "none", sizePresets: ["aplus_premium_web", "aplus_premium_mobile"],
  });
  assert.match(systemPrompt, /copyRequirements 必须是空字符串/);
  assert.match(systemPrompt, /分别为 `aplus_premium_web` 和 `aplus_premium_mobile` 写独立完整的构图/);
  assert.match(systemPrompt, /中心安全区/);
  assert.match(userPrompt, /画面文字模式：不加文字，copyRequirements 必须是空字符串 ""/);
  assert.match(userPrompt, /构图规划方式：高级 A\+ 两端分别规划构图，共用一份文案/);
  const sizePresets = userPrompt.match(/^所选详情尺寸预设：(.+)$/m)?.[1];
  assert.ok(sizePresets);
  assert.deepEqual(JSON.parse(sizePresets).map(({ key, ratio }: { key: string; ratio: string }) => [key, ratio]), [
    ["aplus_premium_web", "1464:600"], ["aplus_premium_mobile", "600:450"],
  ]);
});

test("A+ 图像包装带上尺寸与安全区，不加文字时清空文案要求", () => {
  const options = {
    moduleCode: "brand_story",
    pictureRequirement: "商品与背光的轮廓\n使用冷色背景",
    copyRequirements: '标题「Keep "Moving"」',
    sizePreset: "aplus_premium_web",
    generatedSize: { width: 1536, height: 640 },
  } as const;
  const withText = renderAplusImagePrompt(imageTemplate, { ...options, language: "英文" });
  const payload = withText.match(/^\{[\s\S]+?^\}/m)?.[0];
  assert.ok(payload);
  const parsed = JSON.parse(payload);
  assert.equal(parsed.moduleCode, "brand_story");
  assert.equal(parsed.画面要求, options.pictureRequirement);
  assert.equal(parsed.文案要求, options.copyRequirements);
  assert.deepEqual(parsed.尺寸与安全区.生成尺寸, options.generatedSize);
  assert.deepEqual(parsed.尺寸与安全区.交付尺寸, { width: 1464, height: 600 });
  assert.match(parsed.尺寸与安全区.安全区, /背景、场景空间、承托台面与环境光效必须 100% 满幅出血.*直达四边/);
  assert.match(parsed.尺寸与安全区.安全区, /画面文字、信息面板边框及不可被裁断的商品关键主体.*宽度 100% × 高度 98% 的中心安全区/);
  assert.match(withText, /品牌故事图（brand_story）中不得出现 Logo/);

  const noText = renderAplusImagePrompt(imageTemplate, { ...options, language: "none" });
  assert.match(noText, /画面文字模式：不加文字，整张图禁止出现文字/);
  assert.match(noText, /"文案要求": ""/);
  assert.doesNotMatch(noText, /Moving/);
});

test("A+ 帮写对照有序原图与商品卡事实，保留草稿中的画面偏好", () => {
  const { userPrompt, systemPrompt } = renderAplusAiWritePrompt(aiWriteTemplate, {
    inputImageIds: ["front", "side"], productCardFacts: "商品名称：随行水杯",
    productInfo: "低角度侧光", platform: "amazon", targetMarket: "美国", language: "none",
  });
  assert.match(userPrompt, /商品原图对应顺序：\["front","side"\]/);
  assert.match(userPrompt, /商品卡事实：商品名称：随行水杯/);
  assert.match(userPrompt, /已有草稿与画面偏好：低角度侧光/);
  assert.match(systemPrompt, /3–4 条精炼要点.*300 字以内/);
  assert.match(systemPrompt, /核心补充亮点 \+ 画面呈现方向/);
  assert.match(systemPrompt, /禁止输出.*纯白底主图拍摄建议、主图合规建议/);
  assert.match(systemPrompt, /无法确认归属的线状物、道具或杂物，不得写成随货线缆、赠品或配件/);
  assert.match(systemPrompt, /严禁编造参数/);
  assert.doesNotMatch(systemPrompt + userPrompt, /模块规则|模块代码|【待补充/);
});
