// Run with: npx tsx --test tests/browser-selling-point-layouts.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";

test("商品套图：选择视觉风格、管理九套版式、缩减张数并提交", async (t) => {
  const vite = await createServer({
    cacheDir: "node_modules/.vite-browser-selling-point-layouts",
    configFile: false,
    server: { host: "127.0.0.1", port: 0 },
    esbuild: { jsx: "automatic" },
  });
  t.after(() => vite.close());
  await vite.listen();
  const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  page.setDefaultTimeout(8000);

  const suite = { id: "visual-layouts-fixture", name: "版式参考商品", createdAt: "2026-11-22T00:00:00Z" };
  const studioState = {
    suite, pipeline: null, listingCopy: null, cards: [],
    inputImages: [{
      id: "product-photo", originalFilename: "版式参考商品.jpg",
      thumbnailPreviewUrl: "/assets/gan65-product.jpg",
    }],
    planning: { snapshot: null, notGeneratedReasons: [] },
    progress: { total: 0, completed: 0, percent: 0 },
  };
  await page.route(new URL("/api/**", vite.resolvedUrls.local[0]).href, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const reply = (data, status = 200) => route.fulfill({ status, json: { data } });
    switch (`${request.method()} ${path}`) {
      case "GET /api/platforms":
        return reply([{ code: "taobao", name: "淘宝", marketScope: "domestic", mainImageBackground: "flexible" }]);
      case "GET /api/model-settings":
        return reply({ channels: [], preferences: { image: null, vision: null } });
      case "GET /api/suites/feed":
        return reply({ items: [], total: 0 });
      case `GET /api/suites/${suite.id}/studio-state`:
        return reply(studioState);
      case `PATCH /api/suites/${suite.id}`:
        return reply(suite);
      case "POST /api/suites/one-click-generate": {
        studioState.pipeline = {
          status: "completed", currentPhase: "done", config: request.postDataJSON().config,
          errorCode: null, errorMessage: null,
        };
        return reply({ suiteId: suite.id, pipeline: studioState.pipeline }, 202);
      }
      default:
        return route.fulfill({ status: 404, json: { error: { message: `Unexpected API request: ${path}` } } });
    }
  });

  await page.goto(new URL(`/create/suite/${suite.id}`, vite.resolvedUrls.local[0]).href);
  const style = page.getByRole("combobox", { name: "视觉风格", exact: true });
  await style.waitFor();
  assert.equal(await style.inputValue(), "auto");
  assert.deepEqual(await style.locator("option").allTextContents(), [
    "AI 智能匹配", "极简高级商业", "暗调科技光影", "自然生活氛围", "活力营销撞色",
  ]);
  await style.selectOption({ label: "暗调科技光影" });
  assert.equal(await style.inputValue(), "dark_tech");
  await page.getByRole("button", { name: "自定义配置", exact: true }).click();
  const entry = page.getByRole("button", { name: "选择卖点图版式参考", exact: true });
  await entry.click();
  const dialog = page.getByRole("dialog", { name: "选择卖点图版式", exact: true });
  await dialog.waitFor();
  assert.equal(await dialog.locator("button[aria-pressed] svg").count(), 9);
  await dialog.getByText("暂未选择版式", { exact: true }).waitFor();
  const hero = dialog.getByRole("button", { name: "居中撞色大标题", exact: true });
  const macro = dialog.getByRole("button", { name: "微距材质标注", exact: true });
  const scene = dialog.getByRole("button", { name: "场景主图＋圆形放大镜", exact: true });
  const ambient = dialog.getByRole("button", { name: "氛围大图＋底部三图标", exact: true });
  await macro.click();
  await hero.click();
  await dialog.getByText("2 / 3", { exact: true }).waitFor();
  await dialog.getByText("每种版式生成 1 张，剩余卖点图 AI 补齐。", { exact: true }).waitFor();
  const selected = dialog.getByRole("list", { name: "已选版式" });
  assert.equal(await selected.getByRole("listitem").count(), 2);
  assert.match(await selected.getByRole("listitem").nth(0).textContent(), /微距材质标注/);
  assert.match(await selected.getByRole("listitem").nth(1).textContent(), /居中撞色大标题/);
  await scene.click();
  assert.equal(await ambient.isDisabled(), true);
  await selected.getByRole("button", { name: "移除 场景主图＋圆形放大镜" }).click();
  await hero.click();
  assert.equal(await hero.getAttribute("aria-pressed"), "false");
  await hero.click();
  await dialog.getByRole("button", { name: "应用 2 个版式", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await entry.getByText("已选 2 个版式", { exact: true }).waitFor();

  await entry.click();
  await dialog.getByRole("button", { name: "清空", exact: true }).click();
  await dialog.getByText("暂未选择版式", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await entry.and(page.locator(":focus")).waitFor();
  await entry.getByText("已选 2 个版式", { exact: true }).waitFor();

  const decrease = page.getByRole("button", { name: "减少卖点图", exact: true });
  await decrease.click();
  await decrease.click();
  assert.equal(await page.getByLabel("卖点图张数", { exact: true }).textContent(), "1");
  await entry.getByText("已选 1 个版式", { exact: true }).waitFor();
  const [response] = await Promise.all([
    page.waitForResponse((res) => new URL(res.url()).pathname === "/api/suites/one-click-generate"),
    page.getByRole("button", { name: "一键生成套图（5张）", exact: true }).click(),
  ]);
  assert.equal(response.status(), 202);
  const { config } = response.request().postDataJSON();
  assert.equal(config.visualStyle, "dark_tech");
  assert.deepEqual(config.sellingPointLayouts, ["macro_callout_lines"]);
  assert.equal(config.counts.selling_points, 1);
  await page.getByRole("region", { name: "生成批次" }).locator('[data-status="completed"]').waitFor();
  await page.reload();
  await entry.getByText("已选 1 个版式", { exact: true }).waitFor();
  assert.equal(await style.inputValue(), "dark_tech");
  await decrease.click();
  assert.equal(await entry.isDisabled(), true);
  assert.equal(await entry.getByText(/已选/).count(), 0);

  studioState.pipeline.config = { mode: "custom" };
  await page.setViewportSize({ width: 390, height: 740 });
  await page.reload();
  await entry.waitFor();
  assert.equal(await style.inputValue(), "auto");
  assert.equal(await entry.getByText(/已选/).count(), 0);
  await entry.click();
  const mobileApplyButton = await dialog.getByRole("button", { name: "应用 0 个版式", exact: true }).boundingBox();
  assert.ok(mobileApplyButton && mobileApplyButton.y + mobileApplyButton.height <= 740);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
});
