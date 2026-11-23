import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFeedUrl,
  extractThumbnails,
  formatHistoryTime,
  GENERATION_HISTORY_PAGE_SIZE,
  mergeFeedPages,
  resolveCardCount,
  resolveItemStatus,
  type GenerationHistoryFeedItem,
} from "../src/components/generation-history/history-model.js";

function makeItem(
  id: string,
  overrides: Partial<GenerationHistoryFeedItem> = {},
): GenerationHistoryFeedItem {
  return {
    suite: {
      id,
      name: `批次 ${id}`,
      status: "in_progress",
      origin: "suite_studio",
      createdAt: "2026-11-23T09:30:00.000Z",
      updatedAt: "2026-11-23T09:30:00.000Z",
      inputImages: [],
    },
    pipeline: {
      status: "completed",
      currentPhase: "done",
      config: { platform: "amazon" },
      errorCode: null,
      errorMessage: null,
    },
    card: null,
    thumbnails: [],
    taskCount: 0,
    ...overrides,
  };
}

test("buildFeedUrl encodes origin, trimmed keyword, limit, and offset safely", () => {
  assert.equal(
    buildFeedUrl({ origin: "suite_studio" }),
    `/api/suites/feed?origin=suite_studio&keyword=&limit=${GENERATION_HISTORY_PAGE_SIZE}&offset=0`,
  );
  assert.equal(
    buildFeedUrl({ origin: "replica", keyword: "  耳机  ", limit: 20, offset: 40 }),
    "/api/suites/feed?origin=replica&keyword=%E8%80%B3%E6%9C%BA&limit=20&offset=40",
  );
  assert.equal(
    buildFeedUrl({ origin: "suite_studio", limit: 500, offset: -5 }),
    "/api/suites/feed?origin=suite_studio&keyword=&limit=100&offset=0",
  );
});

test("extractThumbnails caps at 4, ignores blank entries, and falls back to card", () => {
  const withMany = makeItem("many", {
    thumbnails: ["/a.png", "", "  ", "/b.png", "/c.png", "/d.png", "/e.png"],
    card: { taskId: "t1", previewUrl: "/fallback.png", title: "主图" },
  });
  assert.deepEqual(extractThumbnails(withMany), ["/a.png", "/b.png", "/c.png", "/d.png"]);
  assert.deepEqual(extractThumbnails(withMany, 2), ["/a.png", "/b.png"]);

  const legacyOnly = makeItem("legacy", {
    thumbnails: undefined,
    card: { taskId: "t1", previewUrl: "/legacy.png", title: "旧主图" },
  });
  assert.deepEqual(extractThumbnails(legacyOnly), ["/legacy.png"]);

  const empty = makeItem("empty", { thumbnails: [], card: null });
  assert.deepEqual(extractThumbnails(empty), []);
});

test("resolveCardCount prefers taskCount, falls back to suite.taskCount, then thumbnails length", () => {
  assert.equal(resolveCardCount(makeItem("a", { taskCount: 7, thumbnails: ["/1.png"] })), 7);
  assert.equal(
    resolveCardCount(
      makeItem("b", {
        taskCount: undefined,
        suite: { ...makeItem("b").suite, taskCount: 4 },
        thumbnails: ["/1.png"],
      }),
    ),
    4,
  );
  assert.equal(
    resolveCardCount(makeItem("c", { taskCount: undefined, thumbnails: ["/1.png", "/2.png"] })),
    2,
  );
});

test("resolveItemStatus maps pipeline statuses into running, paused, completed, and failed", () => {
  assert.deepEqual(
    resolveItemStatus(makeItem("1", { pipeline: { ...makeItem("1").pipeline!, status: "running" } })),
    { tone: "running", label: "运行中" },
  );
  assert.deepEqual(
    resolveItemStatus(makeItem("2", { pipeline: { ...makeItem("2").pipeline!, status: "waiting_human_input" } })),
    { tone: "paused", label: "暂停" },
  );
  assert.deepEqual(
    resolveItemStatus(
      makeItem("3", { pipeline: { ...makeItem("3").pipeline!, status: "waiting_base_refine_decision" } }),
    ),
    { tone: "paused", label: "暂停" },
  );
  assert.deepEqual(
    resolveItemStatus(makeItem("4", { pipeline: { ...makeItem("4").pipeline!, status: "completed" } })),
    { tone: "completed", label: "完成" },
  );
  assert.deepEqual(
    resolveItemStatus(makeItem("5", { pipeline: { ...makeItem("5").pipeline!, status: "partial_failed" } })),
    { tone: "failed", label: "部分失败" },
  );
  assert.deepEqual(
    resolveItemStatus(makeItem("6", { pipeline: { ...makeItem("6").pipeline!, status: "failed" } })),
    { tone: "failed", label: "失败" },
  );
  assert.deepEqual(resolveItemStatus(makeItem("7", { pipeline: null, taskCount: 3 })), {
    tone: "completed",
    label: "完成",
  });
  assert.deepEqual(resolveItemStatus(makeItem("8", { pipeline: null, taskCount: 0 })), {
    tone: "historical",
    label: "历史",
  });
});

test("mergeFeedPages supports reset, append deduplication, and stops hasMore on end or empty page", () => {
  const a = makeItem("a");
  const b = makeItem("b");
  const c = makeItem("c");

  const page1 = mergeFeedPages([], { items: [a, b], total: 3, limit: 2, offset: 0 }, true);
  assert.deepEqual(
    page1.items.map((item) => item.suite.id),
    ["a", "b"],
  );
  assert.equal(page1.total, 3);
  assert.equal(page1.offset, 2);
  assert.equal(page1.hasMore, true);

  // Simulate duplicate 'b' shifted into page 2 when a new item was created on the server.
  const page2 = mergeFeedPages(page1.items, { items: [b, c], total: 4, limit: 2, offset: 2 }, false);
  assert.deepEqual(
    page2.items.map((item) => item.suite.id),
    ["a", "b", "c"],
  );
  assert.equal(page2.offset, 4);
  assert.equal(page2.hasMore, false);

  // Empty incoming page must set hasMore=false even if total > offset to avoid infinite loops.
  const emptyTail = mergeFeedPages(page1.items, { items: [], total: 10, limit: 2, offset: 2 }, false);
  assert.equal(emptyTail.hasMore, false);

  // Reset discards previous items.
  const resetState = mergeFeedPages(page2.items, { items: [c], total: 1, limit: 20, offset: 0 }, true);
  assert.deepEqual(
    resetState.items.map((item) => item.suite.id),
    ["c"],
  );
  assert.equal(resetState.offset, 1);
  assert.equal(resetState.hasMore, false);
});

test("formatHistoryTime formats current year and previous years cleanly", () => {
  const now = new Date(2026, 10, 23, 15, 0, 0);
  const sameYear = new Date(2026, 4, 8, 9, 5, 0);
  const prevYear = new Date(2025, 11, 31, 23, 45, 0);

  assert.equal(formatHistoryTime(sameYear, now), "05-08 09:05");
  assert.equal(formatHistoryTime(prevYear, now), "2025-12-31 23:45");
  assert.equal(formatHistoryTime("not-a-date", now), "");
  assert.equal(formatHistoryTime(null, now), "");
});
