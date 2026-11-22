import assert from "node:assert/strict";
import test from "node:test";
import { productNameFor } from "../shared/product-name.js";

test("productNameFor extracts a value after numbered and unnumbered labels", () => {
  assert.equal(productNameFor("1. 产品名称：雷蛇毒蝰 V4 Pro\n2. 核心卖点：轻量"), "雷蛇毒蝰 V4 Pro");
  assert.equal(productNameFor("商品名称: 无线鼠标\r\n适用人群：办公"), "无线鼠标");
  assert.equal(productNameFor("1.5L 保温壶\n核心卖点：保温"), "1.5L 保温壶");
});

test("productNameFor skips blank, numbered and label-only lines", () => {
  for (const heading of ["1. 产品名称", "1.产品名称", "产品名称", "产品名称：", "商品名称", "2.", "3"]) {
    assert.equal(productNameFor(`\n${heading}\r\n  便携茶具\n核心卖点：轻便`), "便携茶具");
  }
});

test("productNameFor caps the extracted name at 30 characters and falls back to the filename or default", () => {
  assert.equal(productNameFor(`产品名称：${"茶".repeat(29)}🍵具`), `${"茶".repeat(29)}🍵`);
  assert.equal(productNameFor("1.产品名称\n2.核心卖点：", "商品.v2.webp"), "商品.v2");
  assert.equal(productNameFor(undefined), "未命名商品套图");
});
