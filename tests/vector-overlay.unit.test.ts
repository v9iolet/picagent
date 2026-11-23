import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { SELLING_POINT_LAYOUTS } from "../shared/selling-point-layouts.js";
import {
  VECTOR_OVERLAY_THEMES,
  createVectorOverlayPreset,
  safeValidateVectorOverlayDocument,
  validateVectorOverlayDocument,
  type VectorOverlayThemeId,
} from "../shared/vector-overlay.js";
import {
  compositeVectorOverlay,
  escapeXml,
  renderVectorOverlaySvg,
} from "../server/vector-overlay-renderer.js";

test("createVectorOverlayPreset generates valid presets for all 9 layouts and 4 themes", () => {
  const themeIds = Object.keys(VECTOR_OVERLAY_THEMES) as VectorOverlayThemeId[];
  assert.equal(themeIds.length, 4);
  assert.equal(SELLING_POINT_LAYOUTS.length, 9);

  for (const [index, layout] of SELLING_POINT_LAYOUTS.entries()) {
    const themeId = themeIds[index % themeIds.length];
    const doc = createVectorOverlayPreset(layout.id, {
      headline: `主标 ${layout.name}`,
      subhead: "副标题核心卖点",
      points: ["亮点一", "亮点二", "亮点三"],
      themeId,
    });
    const validated = validateVectorOverlayDocument(doc);
    assert.equal(validated.layoutId, layout.id);
    assert.equal(validated.themeId, themeId);
    assert.ok(validated.elements.length >= 2);
    assert.ok(validated.elements.some((el) => el.text.includes(`主标 ${layout.name}`) || el.text.includes("亮点一")));
  }

  const customDoc = createVectorOverlayPreset("custom", { headline: "自定义主标" });
  assert.equal(validateVectorOverlayDocument(customDoc).layoutId, "custom");
});

test("validateVectorOverlayDocument clamps out-of-bounds coordinates and rejects invalid payloads", () => {
  const clamped = validateVectorOverlayDocument({
    version: 1,
    layoutId: "hero_color_block",
    themeId: "dark_tech",
    elements: [
      {
        id: "el-1",
        type: "callout",
        x: -0.5,
        y: 1.8,
        width: 2.5,
        height: 0.001,
        anchorX: -1,
        anchorY: 2.2,
        text: "  越界测试  ",
        fontSize: 0.5,
        color: "#FFFFFF",
        bgColor: "#000000",
        lineColor: "#38BDF8",
        align: "center",
      },
    ],
  });

  const el = clamped.elements[0];
  assert.equal(el.type, "callout");
  assert.equal(el.x, 0);
  assert.equal(el.y, 0.98);
  assert.equal(el.width, 1);
  assert.equal(el.height, 0.03);
  assert.equal(el.fontSize, 0.18);
  assert.equal(el.text, "越界测试");
  if (el.type === "callout") {
    assert.equal(el.anchorX, 0);
    assert.equal(el.anchorY, 1);
  }

  for (const invalid of [
    null,
    [],
    { version: 2, layoutId: "hero_color_block", themeId: "dark_tech", elements: [{ id: "1", type: "text", x: 0, y: 0, width: 0.5, height: 0.1, text: "hi", fontSize: 0.04, color: "#fff", align: "left" }] },
    { version: 1, layoutId: "unknown_layout", themeId: "dark_tech", elements: [{ id: "1", type: "text", x: 0, y: 0, width: 0.5, height: 0.1, text: "hi", fontSize: 0.04, color: "#fff", align: "left" }] },
    { version: 1, layoutId: "hero_color_block", themeId: "unknown_theme", elements: [{ id: "1", type: "text", x: 0, y: 0, width: 0.5, height: 0.1, text: "hi", fontSize: 0.04, color: "#fff", align: "left" }] },
    { version: 1, layoutId: "hero_color_block", themeId: "dark_tech", elements: [] },
    { version: 1, layoutId: "hero_color_block", themeId: "dark_tech", elements: [{ id: "1", type: "text", x: 0, y: 0, width: 0.5, height: 0.1, text: "   ", fontSize: 0.04, color: "#fff", align: "left" }] },
    { version: 1, layoutId: "hero_color_block", themeId: "dark_tech", elements: [{ id: "1", type: "unknown", x: 0, y: 0, width: 0.5, height: 0.1, text: "hi", fontSize: 0.04, color: "#fff", align: "left" }] },
  ]) {
    assert.equal(safeValidateVectorOverlayDocument(invalid).ok, false);
    assert.throws(() => validateVectorOverlayDocument(invalid));
  }
});

test("renderVectorOverlaySvg safely escapes XML special characters and compositeVectorOverlay renders lossless PNG locally", async () => {
  assert.equal(escapeXml(`A & B <tag> "quote" 'single'`), "A &amp; B &lt;tag&gt; &quot;quote&quot; &apos;single&apos;");

  const doc = createVectorOverlayPreset("macro_callout_lines", {
    headline: `65W <GaN> & "Ultra" 'Fast'`,
    subhead: `100% <Safe> & Stable`,
    points: ["5A & 20V", "<低温快充>", `"三重防护" '认证'`],
    themeId: "vibrant_promo",
  });
  // Add a card element so all 4 element types are exercised in SVG + sharp
  doc.elements.push({
    id: "extra-card",
    type: "card",
    x: 0.06,
    y: 0.52,
    width: 0.34,
    height: 0.16,
    text: "长标题自动折行测试 Long English Word Wrapping Check",
    subtext: "支持中英文混排折行与防出框截断",
    fontSize: 0.028,
    color: "#1C1917",
    bgColor: "#FFFFFFF2",
    borderColor: "#FDBA74",
    align: "left",
  });

  const svg = renderVectorOverlaySvg(doc, 800, 1000);
  assert.match(svg, /&amp;/);
  assert.match(svg, /&lt;GaN&gt;/);
  assert.match(svg, /&quot;Ultra&quot;/);
  assert.match(svg, /&apos;Fast&apos;/);
  assert.doesNotMatch(svg, /<GaN>/);

  const baseBytes = await sharp({
    create: { width: 480, height: 640, channels: 4, background: { r: 245, g: 247, b: 250, alpha: 1 } },
  }).png().toBuffer();

  const startedAt = Date.now();
  const result = await compositeVectorOverlay(baseBytes, doc);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.mimeType, "image/png");
  assert.equal(result.width, 480);
  assert.equal(result.height, 640);
  assert.notEqual(Buffer.compare(result.bytes, baseBytes), 0);
  assert.ok(elapsedMs < 3000, `Expected fast local composite, took ${elapsedMs}ms`);

  const meta = await sharp(result.bytes).metadata();
  assert.equal(meta.width, 480);
  assert.equal(meta.height, 640);
  assert.equal(meta.format, "png");
});
