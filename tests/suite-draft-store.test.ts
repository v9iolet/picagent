import assert from "node:assert/strict";
import test from "node:test";
import {
  createSuiteWorkspaceStore,
  isConfigDirty,
  LAST_SUITE_STORAGE_KEY,
  SUITE_WORKSPACE_STORAGE_KEY,
  type StorageLike,
} from "../src/components/suite-studio/suite-draft-store";
import { initialConfig, type Config } from "../src/components/suite-studio/studio";

function createMemoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    data,
    getItem(key) {
      return data.has(key) ? data.get(key)! : null;
    },
    setItem(key, value) {
      data.set(key, value);
    },
    removeItem(key) {
      data.delete(key);
    },
  };
}

test("empty initial snapshot and isConfigDirty detection", () => {
  const storage = createMemoryStorage();
  const store = createSuiteWorkspaceStore(storage);
  const snap = store.getSnapshot();

  assert.equal(snap.activeSuiteId, null);
  assert.equal(snap.configSuiteId, null);
  assert.equal(snap.hasLocalConfigEdits, false);
  assert.equal(snap.clone, false);
  assert.deepEqual(snap.config, initialConfig);
  assert.equal(isConfigDirty(snap.config), false);

  assert.equal(isConfigDirty({ ...initialConfig, sellingPoints: "核心卖点" }), true);
  assert.equal(isConfigDirty({ ...initialConfig, mode: "custom" }), true);
  assert.equal(isConfigDirty({ ...initialConfig, listingCopy: true }), true);
  assert.equal(isConfigDirty({ ...initialConfig, productCardId: "card-1" }), true);
  assert.equal(
    isConfigDirty({ ...initialConfig, counts: { ...initialConfig.counts, lifestyle: 4 } }),
    true,
  );
  assert.equal(isConfigDirty({ ...initialConfig, platform: "amazon" }, "amazon"), false);
  assert.equal(isConfigDirty({ ...initialConfig, platform: "taobao" }, "amazon"), true);
});

test("unuploaded config draft persists and restores across new store instance", () => {
  const storage = createMemoryStorage();
  const store1 = createSuiteWorkspaceStore(storage);

  const draftConfig: Config = {
    ...initialConfig,
    platform: "amazon",
    sellingPoints: "产品名称：无线耳机\n核心卖点：主动降噪",
    mode: "custom",
    counts: { main: 1, selling_points: 2, lifestyle: 1, other: 0 },
    listingCopy: true,
    productCardId: "card-123",
    productCardSummary: {
      cardId: "card-123",
      name: "无线耳机",
      sellingPoints: ["主动降噪"],
      specifications: "45H",
      supplierImageCount: 0,
      version: 1,
      status: "published",
    },
  };

  store1.updateConfig(draftConfig, { suiteId: null, markDirty: true });
  assert.equal(storage.getItem(LAST_SUITE_STORAGE_KEY), null);
  assert.ok(storage.getItem(SUITE_WORKSPACE_STORAGE_KEY));

  // Simulate reload / remount with a fresh store reading the same sessionStorage.
  const store2 = createSuiteWorkspaceStore(storage);
  const restored = store2.getSnapshot();
  assert.equal(restored.activeSuiteId, null);
  assert.equal(restored.configSuiteId, null);
  assert.equal(restored.hasLocalConfigEdits, true);
  assert.equal(restored.clone, false);
  assert.equal(restored.config.sellingPoints, draftConfig.sellingPoints);
  assert.equal(restored.config.mode, "custom");
  assert.deepEqual(restored.config.counts, { main: 1, selling_points: 2, lifestyle: 1, other: 0 });
  assert.equal(restored.config.listingCopy, true);
  assert.equal(restored.config.productCardId, "card-123");
  assert.equal(restored.config.productCardSummary?.name, "无线耳机");
});

test("uploaded draft suite preserves local config edits and synchronizes LAST_SUITE_STORAGE_KEY", () => {
  const storage = createMemoryStorage();
  const store1 = createSuiteWorkspaceStore(storage);

  store1.updateConfig(
    {
      ...initialConfig,
      sellingPoints: "产品名称：手冲壶\n核心卖点：控流细嘴",
      mode: "custom",
      counts: { main: 1, selling_points: 1, lifestyle: 1, other: 0 },
    },
    { suiteId: null, markDirty: true },
  );

  // User uploads first image -> backend creates draft suite (pipeline === null).
  store1.setActiveSuite("draft-suite-01", { clone: false });
  assert.equal(storage.getItem(LAST_SUITE_STORAGE_KEY), "draft-suite-01");

  // Reload / route switch restores both suiteId and unsaved local config edits.
  const store2 = createSuiteWorkspaceStore(storage);
  const snap = store2.getSnapshot();
  assert.equal(snap.activeSuiteId, "draft-suite-01");
  assert.equal(snap.configSuiteId, "draft-suite-01");
  assert.equal(snap.hasLocalConfigEdits, true);
  assert.equal(snap.clone, false);
  assert.equal(snap.config.sellingPoints, "产品名称：手冲壶\n核心卖点：控流细嘴");
  assert.deepEqual(snap.config.counts, { main: 1, selling_points: 1, lifestyle: 1, other: 0 });
});

test("active generated batch retains clone=true and local config overrides across reload", () => {
  const storage = createMemoryStorage();
  const store1 = createSuiteWorkspaceStore(storage);

  store1.hydrateFromServer(
    "batch-suite-99",
    {
      ...initialConfig,
      platform: "amazon",
      sellingPoints: "原始卖点",
    },
    true,
  );
  assert.equal(storage.getItem(LAST_SUITE_STORAGE_KEY), "batch-suite-99");
  assert.equal(store1.getSnapshot().hasLocalConfigEdits, false);
  assert.equal(store1.getSnapshot().clone, true);

  // User tweaks sellingPoints on top of the active batch for a follow-up run.
  store1.updateConfig(
    {
      ...store1.getSnapshot().config,
      sellingPoints: "二次微调卖点",
      size: "2K",
    },
    { suiteId: "batch-suite-99", markDirty: true, clone: true },
  );

  const store2 = createSuiteWorkspaceStore(storage);
  const snap = store2.getSnapshot();
  assert.equal(snap.activeSuiteId, "batch-suite-99");
  assert.equal(snap.configSuiteId, "batch-suite-99");
  assert.equal(snap.hasLocalConfigEdits, true);
  assert.equal(snap.clone, true);
  assert.equal(snap.config.sellingPoints, "二次微调卖点");
  assert.equal(snap.config.size, "2K");
});

test("clear() resets both workspace storage and LAST_SUITE_STORAGE_KEY and memory cache", () => {
  const storage = createMemoryStorage();
  const store = createSuiteWorkspaceStore(storage);

  store.hydrateFromServer("batch-clear-1", { ...initialConfig, sellingPoints: "卖点" }, true);
  store.setMemoryCache({ suiteId: "batch-clear-1", state: null, images: [] });
  assert.ok(store.getMemoryCache("batch-clear-1"));
  assert.equal(storage.getItem(LAST_SUITE_STORAGE_KEY), "batch-clear-1");
  assert.ok(storage.getItem(SUITE_WORKSPACE_STORAGE_KEY));

  const cleared = store.clear();
  assert.equal(cleared.activeSuiteId, null);
  assert.equal(cleared.configSuiteId, null);
  assert.equal(cleared.hasLocalConfigEdits, false);
  assert.equal(cleared.clone, false);
  assert.deepEqual(cleared.config, initialConfig);
  assert.equal(store.getMemoryCache("batch-clear-1"), null);
  assert.equal(storage.getItem(LAST_SUITE_STORAGE_KEY), null);
  assert.equal(storage.getItem(SUITE_WORKSPACE_STORAGE_KEY), null);
});

test("graceful fallback on malformed JSON, external LAST_SUITE_STORAGE_KEY changes, and throwing StorageLike", () => {
  // 1. Malformed JSON falls back cleanly while still honoring LAST_SUITE_STORAGE_KEY.
  const malformedStorage = createMemoryStorage({
    [SUITE_WORKSPACE_STORAGE_KEY]: "{not-valid-json",
    [LAST_SUITE_STORAGE_KEY]: "seeded-suite-id",
  });
  const store1 = createSuiteWorkspaceStore(malformedStorage);
  assert.equal(store1.getSnapshot().activeSuiteId, "seeded-suite-id");
  assert.deepEqual(store1.getSnapshot().config, initialConfig);

  // 2. External removal of LAST_SUITE_STORAGE_KEY clears activeSuiteId on read.
  malformedStorage.removeItem(LAST_SUITE_STORAGE_KEY);
  assert.equal(store1.getSnapshot().activeSuiteId, null);

  // 3. Throwing StorageLike never throws.
  const throwingStorage: StorageLike = {
    getItem() {
      throw new Error("SecurityError");
    },
    setItem() {
      throw new Error("QuotaExceededError");
    },
    removeItem() {
      throw new Error("SecurityError");
    },
  };
  const safeStore = createSuiteWorkspaceStore(throwingStorage);
  assert.equal(safeStore.getSnapshot().activeSuiteId, null);
  safeStore.updateConfig({ ...initialConfig, sellingPoints: "内存降级" }, { suiteId: null, markDirty: true });
  assert.equal(safeStore.getSnapshot().config.sellingPoints, "内存降级");
  safeStore.clear();
  assert.equal(safeStore.getSnapshot().config.sellingPoints, "");
});

test("配额超限后套图仍保留本次切换的批次，其他入口写入新批次时可正常切换", () => {
  const storage = createMemoryStorage({ [LAST_SUITE_STORAGE_KEY]: "first" });
  const externalSet = storage.setItem.bind(storage);
  const store = createSuiteWorkspaceStore(storage);
  storage.setItem = () => { throw new DOMException("full", "QuotaExceededError"); };
  store.setActiveSuite("second");
  assert.equal(store.getSnapshot().activeSuiteId, "second");
  assert.equal(storage.getItem(LAST_SUITE_STORAGE_KEY), "first");
  externalSet(LAST_SUITE_STORAGE_KEY, "third");
  assert.equal(store.getSnapshot().activeSuiteId, "third");
});
