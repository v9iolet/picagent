import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateSellingPointLayouts,
  resolveSellingPointLayouts,
  VISUAL_STYLES,
  resolveVisualStyle,
  SELLING_POINT_LAYOUTS,
} from "../shared/selling-point-layouts.js";

test("visual style presets cover all five choices and fall back to smart matching", () => {
  assert.deepEqual(VISUAL_STYLES.map(({ id, name }) => [id, name]), [
    ["auto", "AI 智能匹配"],
    ["minimal_luxury", "极简高级商业"],
    ["dark_tech", "暗调科技光影"],
    ["natural_lifestyle", "自然生活氛围"],
    ["vibrant_promo", "活力营销撞色"],
  ]);
  assert.ok(VISUAL_STYLES.every(({ promptDirective }) => promptDirective.length > 10));
  assert.equal(resolveVisualStyle("dark_tech").id, "dark_tech");
  assert.equal(resolveVisualStyle("unknown").id, "auto");
  assert.equal(resolveVisualStyle(undefined).id, "auto");
});

test("the nine layouts carry complete guidance and resolve unique known IDs in selection order", () => {
  assert.deepEqual(SELLING_POINT_LAYOUTS.map(({ id }) => id), [
    "hero_color_block", "macro_callout_lines", "scene_circle_zoom",
    "ambient_three_icons", "top_hero_bottom_trio", "left_pills_right_hero",
    "hero_zoom_spec_box", "top_cards_bottom_hero", "split_scene_closeup",
  ]);
  for (const { name, tag, summary, promptDirective } of SELLING_POINT_LAYOUTS) {
    assert.ok(name.trim());
    assert.ok(tag.trim());
    assert.ok(summary.trim());
    assert.deepEqual(Object.keys(promptDirective).sort(), ["composition", "lighting", "textHierarchy"]);
    assert.ok(Object.values(promptDirective).every((part) => part.trim().length > 8));
  }
  const requested = ["split_scene_closeup", "unknown", {}, "split_scene_closeup", "hero_color_block", "scene_circle_zoom"];
  assert.deepEqual(resolveSellingPointLayouts(requested, 2).map(({ id }) => id), ["split_scene_closeup", "hero_color_block"]);
  assert.deepEqual(resolveSellingPointLayouts(requested, 0), []);
  assert.deepEqual(resolveSellingPointLayouts("hero_color_block", 3), []);
});

test("selling-point layouts fill feature and material allocations in order, including empty categories", () => {
  const layouts = resolveSellingPointLayouts(["split_scene_closeup", "hero_color_block", "scene_circle_zoom"], 3);
  const assigned = allocateSellingPointLayouts(layouts, { feature_benefit: 2, material_detail: 1 });
  assert.deepEqual(assigned.feature_benefit.map(({ id }) => id), ["split_scene_closeup", "hero_color_block"]);
  assert.deepEqual(assigned.material_detail.map(({ id }) => id), ["scene_circle_zoom"]);
  const materialOnly = allocateSellingPointLayouts(layouts, { feature_benefit: 0, material_detail: 2 });
  assert.deepEqual(materialOnly.feature_benefit, []);
  assert.deepEqual(materialOnly.material_detail.map(({ id }) => id), ["split_scene_closeup", "hero_color_block"]);
  assert.deepEqual(allocateSellingPointLayouts(layouts.slice(0, 1), { feature_benefit: 2, material_detail: 1 }).material_detail, []);
});
