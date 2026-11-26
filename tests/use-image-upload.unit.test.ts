import assert from "node:assert/strict";
import test from "node:test";
import { createImagePreviews, imageMimeType, prepareImageUpload } from "../src/hooks/useImageUpload.js";

const limits = { existingCount: 0, maxCount: 6 };
const png = new File(["pixels"], "product.png", { type: "image/png" });

test("保留已识别的图片，按扩展名补全缺失的上传 MIME", async () => {
  assert.equal(prepareImageUpload([png], limits)[0], png);
  for (const [name, mime] of [["a.JPG", "image/jpeg"], ["b.JPEG", "image/jpeg"], ["c.PnG", "image/png"], ["d.WEBP", "image/webp"]]) {
    const source = new File(["pixels"], name, { lastModified: 123 });
    const [file] = prepareImageUpload([source], limits);
    assert.equal(file.type, mime);
    assert.equal(file.name, name);
    assert.equal(file.lastModified, 123);
    assert.equal(await file.text(), "pixels");
  }
  assert.equal(imageMimeType(new File(["x"], "a.png", { type: "application/octet-stream" })), "image/png");
});

test("拒绝不支持的 MIME 或扩展名，并保留供应商图片按后缀识别的规则", () => {
  const disguised = new File(["x"], "a.png", { type: "text/plain" });
  assert.throws(() => prepareImageUpload([png, disguised], limits), /格式/);
  assert.throws(() => prepareImageUpload([new File(["x"], "a.gif")], limits), /格式/);
  assert.equal(imageMimeType(disguised, "any-type"), "image/png");
});

test("拒绝空文件和超限文件，包含单张体积上限的边界", () => {
  const bytes = new Uint8Array(12 * 1024 * 1024);
  const exact = new File([bytes], "limit.webp");
  assert.equal(prepareImageUpload([exact], limits)[0].size, bytes.length);
  assert.throws(() => prepareImageUpload([new File([exact, "x"], "large.png")], limits), /12MB/);
  assert.throws(() => prepareImageUpload([new File([], "empty.png")], limits), /为空/);
});

test("当前张数与新选张数合计超限时，整批拒绝", () => {
  assert.deepEqual(prepareImageUpload([png, png], { ...limits, existingCount: 4 }), [png, png]);
  assert.throws(() => prepareImageUpload([png, png], { ...limits, existingCount: 5 }), /最多上传 6 张/);
  assert.deepEqual(prepareImageUpload([], { ...limits, existingCount: 6 }), []);
});

test("移除预览单独释放 URL，卸载清理剩余 URL，每个 URL 只释放一次", (t) => {
  const revoke = t.mock.method(URL, "revokeObjectURL");
  const previews = createImagePreviews();
  const removed = previews.create(png);
  const remaining = previews.create(png);
  assert.notEqual(removed, remaining);
  previews.release(removed);
  previews.release(removed);
  previews.release("https://example.invalid/product.png");
  previews.clear();
  previews.clear();
  assert.deepEqual(revoke.mock.calls.map((call) => call.arguments[0]), [removed, remaining]);
});
