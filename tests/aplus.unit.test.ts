import assert from "node:assert/strict";
import test from "node:test";
import {
  APLUS_MODULES,
  APLUS_SIZE_PRESETS,
  DEFAULT_APLUS_MODULE_CODES,
  defaultDetailSizePresets,
  validateAplusModuleCodes,
  validateAplusSizePresets,
} from "../shared/aplus.js";

test("A+ 默认选中前六个模块，顺序与规格一致", () => {
  assert.equal(APLUS_MODULES.length, 16);
  assert.equal(new Set(APLUS_MODULES.map(({ code }) => code)).size, 16);
  assert.deepEqual(APLUS_MODULES.map(({ sortOrder }) => sortOrder), Array.from({ length: 16 }, (_, index) => index + 1));
  assert.deepEqual(DEFAULT_APLUS_MODULE_CODES, ["hero", "selling_points", "usage_scene", "multi_angle", "atmosphere", "detail_closeup"]);
});

test("A+ 模块须从已定义的模块中选 1–10 个，且不可重复", () => {
  const codes = APLUS_MODULES.map(({ code }) => code);
  assert.equal(validateAplusModuleCodes(["usage_tips"]), true);
  assert.equal(validateAplusModuleCodes(codes.slice(0, 10)), true);
  for (const invalid of [[], codes.slice(0, 11), ["hero", "hero"], ["missing"], "hero", [42], Array(1)]) {
    assert.equal(validateAplusModuleCodes(invalid), false);
  }
});

test("A+ 尺寸须属于平台，只有高级 A+ 两端可同时选择", () => {
  const amazon = defaultDetailSizePresets("amazon", "overseas");
  const domestic = defaultDetailSizePresets("taobao", "domestic");
  const premium = ["aplus_premium_web", "aplus_premium_mobile"];
  for (const key of amazon.options) assert.equal(validateAplusSizePresets([key], amazon), true, key);
  assert.equal(validateAplusSizePresets(premium, amazon), true);
  assert.equal(validateAplusSizePresets([...premium].reverse(), amazon), true);
  assert.equal(validateAplusSizePresets(["3:4"], domestic), true);
  assert.equal(validateAplusSizePresets(premium, domestic), false);
  assert.equal(validateAplusSizePresets(premium, { options: [premium[0]], default: premium[0] }), false);
  for (const invalid of [
    [], [...premium, "3:4"], ["aplus_standard", "1:1"], ["aplus_premium_mobile", "1:1"],
    ["1:1", "3:4"], [premium[0], premium[0]], ["unknown"], ["constructor"], "1:1", [42], Array(1),
  ]) {
    assert.equal(validateAplusSizePresets(invalid, amazon), false);
  }
  assert.equal(validateAplusSizePresets(["unknown"], { options: ["unknown"], default: "unknown" }), false);
  assert.deepEqual(APLUS_SIZE_PRESETS.aplus_premium_web.deliverySize, { width: 1464, height: 600 });
  assert.deepEqual(APLUS_SIZE_PRESETS.aplus_premium_mobile.deliverySize, { width: 600, height: 450 });
  assert.deepEqual(APLUS_SIZE_PRESETS.aplus_standard.deliverySize, { width: 970, height: 600 });
  assert.equal(APLUS_SIZE_PRESETS["3:4"].deliverySize, null);
});
