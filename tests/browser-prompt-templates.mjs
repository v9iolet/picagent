// Run with: npx tsx --test tests/browser-prompt-templates.mjs (no DB, credentials, or external requests).
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";
import { createSuiteStudioApp } from "../server/app.js";
import {
  importPromptRecordsWithPolicy,
  isNormalizedPromptMarkdown,
  parseNormalizedPromptMarkdown,
  resolvePromptTemplateUsedBy,
} from "../server/prompt-library.js";
import { MemoryLibraryRepository } from "../server/repositories/memory-library-repository.js";
import { MemoryPromptRepository } from "../server/repositories/memory-prompt-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";
import { APLUS_MODULES } from "../shared/aplus.js";

function createPromptBackedLibrary(prompts) {
  const base = new MemoryLibraryRepository();
  const toResource = async (versionId) => {
    const version = await prompts.getVersion(versionId);
    if (!version) return null;
    const now = "2026-11-23T00:00:00.000Z";
    const usedBy = resolvePromptTemplateUsedBy(version);
    return {
      id: `prompt:${version.templateVersionId}`,
      resourceType: "prompt_template",
      title: version.name,
      summary: version.body.replace(/\s+/g, " ").slice(0, 180),
      mimeType: null,
      previewUrl: null,
      suiteId: null,
      taskId: null,
      imageVersionId: null,
      baseVersionId: null,
      templateVersionId: version.templateVersionId,
      resourceVersionId: version.templateVersionId,
      stage: version.stage,
      status: version.status,
      usedBy,
      source: {
        templateId: version.templateId,
        code: version.code,
        versionNo: version.versionNo,
        status: version.status,
        body: version.body,
        userPromptTemplate: version.userPromptTemplate,
        inputSchema: version.inputSchema,
        outputSchema: version.outputSchema,
        applicability: version.applicability,
        usedBy,
      },
      promptSnapshot: null,
      createdAt: now,
      updatedAt: now,
    };
  };

  base.listResources = async (query) => {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 24));
    const status = query.status && query.status !== "archived" ? query.status : "all";
    const listed = await prompts.listTemplates({ stage: query.stage, status });
    const needle = query.query?.trim().toLocaleLowerCase();
    const resources = (
      await Promise.all(listed.map((item) => toResource(item.templateVersionId)))
    ).filter(Boolean).filter((item) =>
      (!query.status || item.status === query.status) &&
      (!needle || `${item.title} ${item.summary} ${String(item.source?.code ?? "")}`.toLocaleLowerCase().includes(needle)),
    );
    return {
      items: resources.slice((page - 1) * pageSize, page * pageSize),
      total: resources.length,
      page,
      pageSize,
    };
  };

  base.getResource = async (resourceId) => {
    if (!resourceId.startsWith("prompt:")) return null;
    return toResource(resourceId.slice("prompt:".length));
  };

  return base;
}

async function loadAllNormalizedPromptRecords() {
  const dir = path.resolve("prompt/normalized");
  const files = (await readdir(dir))
    .filter((file) => file.endsWith(".md") && file !== "README.md" && file !== "CHANGES.md")
    // Prefer the current group versions over legacy v1 structure/category files
    .filter((file) => file !== "general-structure-plan.md" && file !== "general-category-prompt.md")
    .sort();
  const records = [];
  for (const file of files) {
    const rel = `prompt/normalized/${file}`;
    const md = await readFile(path.join(dir, file), "utf8");
    if (isNormalizedPromptMarkdown(md)) {
      records.push(parseNormalizedPromptMarkdown(md, rel));
    }
  }
  return records;
}

test("PromptTemplatesPage shows only active templates with usedBy tags by default, switches to retired, and scrolls to the last card at 1280x720", async (t) => {
  const prompts = new MemoryPromptRepository();
  const records = await loadAllNormalizedPromptRecords();
  await importPromptRecordsWithPolicy(prompts, records, { publish: true });

  const library = createPromptBackedLibrary(prompts);
  const app = createSuiteStudioApp({
    repository: new MemorySuiteRepository(),
    storage: new MemoryStorage(),
    promptRepository: prompts,
    libraryRepository: library,
  });

  const vite = await createServer({
    server: { port: 0, host: "127.0.0.1" },
    plugins: [
      {
        name: "prompt-templates-api",
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/api/")) return next();
            const chunks = [];
            for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            const raw = Buffer.concat(chunks);
            let parsed;
            try {
              parsed = raw.length ? JSON.parse(raw.toString("utf8")) : undefined;
            } catch {
              parsed = undefined;
            }
            const response = await app.request(req.method ?? "GET", req.url, {
              headers: req.headers,
              body: parsed,
            });
            res.statusCode = response.status;
            res.setHeader("content-type", "application/json; charset=utf-8");
            res.end(JSON.stringify(response.body));
          });
        },
      },
    ],
  });
  await vite.listen();
  const address = vite.httpServer?.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true });

  t.after(async () => {
    await browser.close();
    await vite.close();
  });

  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));

  await page.goto(`${baseUrl}/templates`, { waitUntil: "networkidle" });
  await page.waitForSelector(".template-card");

  // 1. Default filter is "在用" and shows the original templates plus A+ planning, image, AI writing and module rules.
  const expectedActiveCount = 7 + 3 + APLUS_MODULES.length;
  const expectedRetiredCount = 20;
  const activeCount = await page.locator(".template-card").count();
  assert.equal(activeCount, expectedActiveCount, "Expected only active templates by default");

  const allCardsText = await page.locator(".template-list-grid").innerText();
  for (const label of [
    "套图·结构规划",
    "套图·品类提示词",
    "套图·白底精修",
    "上架文案",
    "爆品图复刻·参考风格",
    "爆品图复刻·高度复刻",
    "首页·商品信息建档",
    "A+详情·方案规划",
    "A+详情·模块规则",
    "A+详情·出图",
    "A+详情·AI 帮写",
  ]) {
    assert.ok(allCardsText.includes(label), `Expected active template list to display feature badge "${label}"`);
  }

  // 2. Scroll the active template list at 1280x720 to the last card and verify it is visible inside viewport
  const grid = page.locator(".template-list-grid");
  const lastActiveCard = page.locator(".template-card").last();
  await lastActiveCard.scrollIntoViewIfNeeded();
  const activeScroll = await grid.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    scrollTop: el.scrollTop,
  }));
  assert.ok(activeScroll.scrollHeight > activeScroll.clientHeight, "Active template list should overflow at 1280x720");
  assert.ok(activeScroll.scrollTop > 0, "Active template list should scroll down");
  const lastActiveBox = await lastActiveCard.boundingBox();
  assert.ok(lastActiveBox, "Last active card must have a bounding box");
  assert.ok(lastActiveBox.y >= 0 && lastActiveBox.y + lastActiveBox.height <= 720, "Last active card must be visible within 1280x720 viewport after scrolling");

  // 3. Switch to "已下架" and verify retired templates load and scroll to the very last item
  await page.locator(".style-filter-panel label", { hasText: "已下架" }).click();
  await page.waitForFunction((count) => document.querySelectorAll(".template-card").length === count, expectedRetiredCount);

  const lastRetiredCard = page.locator(".template-card").last();
  await lastRetiredCard.scrollIntoViewIfNeeded();
  const retiredScroll = await grid.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    scrollTop: el.scrollTop,
  }));
  assert.ok(retiredScroll.scrollHeight > retiredScroll.clientHeight, "Retired template list must be scrollable");
  assert.ok(retiredScroll.scrollTop > 200, `Expected substantial scrollTop for ${expectedRetiredCount} retired cards, got ${retiredScroll.scrollTop}`);
  const lastRetiredBox = await lastRetiredCard.boundingBox();
  assert.ok(lastRetiredBox, "Last retired card must have a bounding box");
  assert.ok(
    lastRetiredBox.y >= 0 && lastRetiredBox.y + lastRetiredBox.height <= 720,
    `Last retired card must be visible inside 1280x720 viewport after scroll (box=${JSON.stringify(lastRetiredBox)})`,
  );

  // 4. Switch back to "在用" and verify copy -> edit -> save -> draft filter -> publish flow still works
  await page.locator(".style-filter-panel label", { hasText: "在用" }).click();
  await page.waitForFunction((count) => document.querySelectorAll(".template-card").length === count, expectedActiveCount);
  await page.locator(".template-card", { hasText: "套图·白底精修" }).click();
  await page.getByRole("button", { name: "复制新草稿" }).click();
  await page.getByRole("button", { name: "保存草稿" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "保存草稿" }).click();
  // Switching to "草稿" filter shows the newly created draft even though v1 is still published
  await page.locator(".style-filter-panel label", { hasText: "草稿" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".template-card").length === 1);
  assert.match(await page.locator(".template-card").first().innerText(), /v2/);
  await page.getByRole("button", { name: "发布此版本" }).click();
  await page.locator(".style-filter-panel label", { hasText: "在用" }).click();
  await page.waitForFunction((count) => document.querySelectorAll(".template-card").length === count, expectedActiveCount);
  await page.locator(".template-card", { hasText: "套图·白底精修" }).click();
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll(".style-version-row")).some((row) =>
      row.textContent?.includes("v2 · 在用"),
    ),
  );

  // Verify inspector panel is also scrollable when content overflows
  const inspectorScroll = await page.locator(".inspector-body").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollTop: el.scrollTop };
  });
  assert.ok(inspectorScroll.scrollHeight > inspectorScroll.clientHeight, "Inspector body should overflow with template details");
  assert.ok(inspectorScroll.scrollTop > 0, "Inspector body must be scrollable");

  for (const [stage, count] of [
    ["A+ 方案规划", 1], ["A+ 模块规则", APLUS_MODULES.length],
    ["A+ 图像包装", 1], ["A+ AI 帮写", 1],
  ]) {
    await page.locator(".style-filter-panel").getByText(stage, { exact: true }).click();
    await page.waitForFunction(({ stage, count }) => {
      const cards = Array.from(document.querySelectorAll(".template-card"));
      return cards.length === count && cards.every((card) =>
        [...card.querySelectorAll(".badge")].some((badge) => badge.textContent === stage));
    }, { stage, count });
  }

  assert.deepEqual(errors, [], `Expected no uncaught page errors, got: ${errors.join("; ")}`);
});
