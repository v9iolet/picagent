// Run with: npx tsx --test tests/replica-draft-persistence.unit.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  createIndexedDbBlobStorage,
  type KeepBlobKeysInput,
  type ReplicaDraftBlobStorage,
} from "../src/features/replica/replica-draft-idb";
import {
  createReplicaDraftStore,
  REPLICA_DRAFT_CONFIG_STORAGE_KEY,
  REPLICA_DRAFT_STORAGE_KEY,
  type StorageLike,
} from "../src/features/replica/replica-draft-store";
import { REPLICA_MAX_IMAGE_BYTES } from "../src/features/replica/replica-types";

class MemoryStorageLike implements StorageLike {
  data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

class MemoryBlobStorage implements ReplicaDraftBlobStorage {
  blobs = new Map<string, Blob>();
  failPut = false;
  failGet = false;
  getDelayGate: Promise<void> | null = null;
  getCalls = 0;
  pruneCalls = 0;

  async putBlob(key: string, blob: Blob): Promise<boolean> {
    if (this.failPut) return false;
    this.blobs.set(key, blob);
    return true;
  }
  async getBlobs(keys: readonly string[]): Promise<Map<string, Blob>> {
    this.getCalls += 1;
    if (this.getDelayGate) await this.getDelayGate;
    if (this.failGet) return new Map();
    const out = new Map<string, Blob>();
    for (const key of keys) {
      const b = this.blobs.get(key);
      if (b) out.set(key, b);
    }
    return out;
  }
  async deleteBlob(key: string): Promise<void> {
    this.blobs.delete(key);
  }
  async clearBlobs(): Promise<void> {
    this.blobs.clear();
  }
  async pruneBlobs(keepKeys: KeepBlobKeysInput): Promise<void> {
    this.pruneCalls += 1;
    const keep = typeof keepKeys === "function" ? keepKeys() : keepKeys;
    if (!keep) return;
    for (const key of Array.from(this.blobs.keys())) {
      if (!keep.has(key)) this.blobs.delete(key);
    }
  }
}

function createFakeAsyncIndexedDb(openGate: Promise<void>) {
  const stores = new Map<string, Map<string, unknown>>();
  let openCount = 0;

  const factory = {
    open(_name: string, _version?: number) {
      openCount += 1;
      const req: {
        result?: unknown;
        onupgradeneeded: (() => void) | null;
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        onblocked: (() => void) | null;
      } = {
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        onblocked: null,
      };

      const db = {
        objectStoreNames: {
          contains: (name: string) => stores.has(name),
        },
        createObjectStore: (name: string) => {
          if (!stores.has(name)) stores.set(name, new Map());
          return {};
        },
        onversionchange: null as (() => void) | null,
        onclose: null as (() => void) | null,
        close: () => {},
        transaction: (storeName: string, _mode: IDBTransactionMode) => {
          const map = stores.get(storeName);
          if (!map) throw new Error(`Missing object store ${storeName}`);
          const tx: {
            oncomplete: (() => void) | null;
            onerror: (() => void) | null;
            onabort: (() => void) | null;
            objectStore: (name: string) => unknown;
          } = {
            oncomplete: null,
            onerror: null,
            onabort: null,
            objectStore: () => ({
              put: (value: unknown, key: string) => {
                map.set(key, value);
                const r: { onsuccess: (() => void) | null; onerror: (() => void) | null } = {
                  onsuccess: null,
                  onerror: null,
                };
                queueMicrotask(() => r.onsuccess?.());
                return r;
              },
              get: (key: string) => {
                const r: {
                  result: unknown;
                  onsuccess: (() => void) | null;
                  onerror: (() => void) | null;
                } = {
                  result: map.get(key),
                  onsuccess: null,
                  onerror: null,
                };
                queueMicrotask(() => r.onsuccess?.());
                return r;
              },
              getAllKeys: () => {
                const r: {
                  result: string[];
                  onsuccess: (() => void) | null;
                  onerror: (() => void) | null;
                } = {
                  result: Array.from(map.keys()),
                  onsuccess: null,
                  onerror: null,
                };
                queueMicrotask(() => r.onsuccess?.());
                return r;
              },
              delete: (key: string) => {
                map.delete(key);
                return {};
              },
              clear: () => {
                map.clear();
                return {};
              },
            }),
          };
          // Complete transaction after request microtasks finish (matching IDB transaction semantics).
          queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.()));
          return tx;
        },
      };

      void openGate.then(() => {
        req.result = db;
        if (!stores.size) {
          req.onupgradeneeded?.();
        }
        req.onsuccess?.();
      });

      return req as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;

  return {
    factory,
    getStore: (name = "blobs") => stores.get(name),
    getOpenCount: () => openCount,
  };
}

function makeFakeUrlHooks() {
  let seq = 0;
  const active = new Set<string>();
  const revoked: string[] = [];
  return {
    active,
    revoked,
    createObjectUrl: (_blob: Blob) => {
      seq += 1;
      const url = `blob:mock-${seq}`;
      active.add(url);
      return url;
    },
    revokeObjectUrl: (url: string) => {
      active.delete(url);
      revoked.push(url);
    },
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("复刻草稿持久化：图片二进制存 Blob 存储，localStorage 不含 base64，重建 store 后完整恢复顺序、文案与去重能力", async () => {
  const local = new MemoryStorageLike();
  const blobs = new MemoryBlobStorage();
  const urls1 = makeFakeUrlHooks();

  const store1 = createReplicaDraftStore({
    storage: local,
    legacySessionStorage: null,
    blobStorage: blobs,
    createObjectUrl: urls1.createObjectUrl,
    revokeObjectUrl: urls1.revokeObjectUrl,
  });

  const ref1 = new File([new Uint8Array([1, 2, 3, 4, 5])], "ref-a.jpg", { type: "image/jpeg" });
  const ref2 = new File([new Uint8Array([6, 7, 8, 9, 10])], "ref-b.png", { type: "image/png" });
  const prod1 = new File([new Uint8Array([11, 12, 13, 14])], "prod-local.webp", {
    type: "image/webp",
  });
  const prod2 = new File([new Uint8Array([15, 16, 17, 18])], "prod-angle.png", {
    type: "image/png",
  });

  store1.addReferences([ref1, ref2]);
  store1.addProductFiles([prod1, prod2]);
  await waitUntil(
    () =>
      store1.getSnapshot().references.length === 2 &&
      store1.getSnapshot().references.every((r) => r.status === "ready") &&
      store1.getSnapshot().products.length === 2 &&
      store1.getSnapshot().products.every((p) => p.status === "ready"),
  );

  // Add remarks, reorder references and products
  const r0 = store1.getSnapshot().references[0];
  const r1 = store1.getSnapshot().references[1];
  store1.updateReferenceRemark(r0.localId, "第一张局部要求");
  store1.updateReferenceRemark(r1.localId, "第二张顶部留白");
  store1.moveReference(1, 0);
  store1.moveProduct(1, 0);

  store1.updateConfig({
    sceneType: "apparel",
    cloneLevel: "compose",
    unifiedRequirement: "保持构图与暖色调",
    productInfo: "重磅纯棉连帽卫衣",
    styleUnified: false,
    language: "en",
    ratio: "3:4",
    size: "2K",
  });

  // Verify localStorage metadata contains NO bytesBase64 or blob: preview URLs
  const rawStored = local.getItem(REPLICA_DRAFT_STORAGE_KEY);
  assert.ok(rawStored, "localStorage should store draft metadata");
  assert.equal(rawStored.includes("bytesBase64"), false);
  assert.equal(rawStored.includes("blob:mock-"), false);
  assert.equal(blobs.blobs.size, 4);

  // Seed an orphan blob to verify startup orphan cleanup
  blobs.blobs.set("orphan-old-blob", new Blob([new Uint8Array([99])], { type: "image/png" }));

  // Simulate full page reload by creating a fresh store instance backed by same storage
  const urls2 = makeFakeUrlHooks();
  const store2 = createReplicaDraftStore({
    storage: local,
    legacySessionStorage: null,
    blobStorage: blobs,
    createObjectUrl: urls2.createObjectUrl,
    revokeObjectUrl: urls2.revokeObjectUrl,
  });

  // Config is available immediately synchronously
  assert.equal(store2.getSnapshot().config.sceneType, "apparel");
  assert.equal(store2.getSnapshot().config.unifiedRequirement, "保持构图与暖色调");
  assert.equal(store2.getSnapshot().products[0].sourceKind, "upload");

  await store2.waitForHydration();

  const snap2 = store2.getSnapshot();
  assert.equal(snap2.references.length, 2);
  assert.equal(snap2.references[0].filename, "ref-b.png");
  assert.equal(snap2.references[0].remark, "第二张顶部留白");
  assert.equal(snap2.references[0].status, "ready");
  assert.ok(snap2.references[0].previewUrl.startsWith("blob:mock-"));
  assert.equal(snap2.references[0].bytesBase64, Buffer.from([6, 7, 8, 9, 10]).toString("base64"));

  assert.equal(snap2.references[1].filename, "ref-a.jpg");
  assert.equal(snap2.references[1].remark, "第一张局部要求");
  assert.equal(snap2.references[1].status, "ready");
  assert.equal(snap2.references[1].bytesBase64, Buffer.from([1, 2, 3, 4, 5]).toString("base64"));

  assert.equal(snap2.products.length, 2);
  assert.equal(snap2.products[0].filename, "prod-angle.png");
  assert.equal(snap2.products[0].status, "ready");
  assert.equal(snap2.products[0].bytesBase64, Buffer.from([15, 16, 17, 18]).toString("base64"));
  assert.equal(snap2.products[1].filename, "prod-local.webp");
  assert.equal(snap2.products[1].status, "ready");
  assert.equal(snap2.products[1].bytesBase64, Buffer.from([11, 12, 13, 14]).toString("base64"));

  // Orphan blob should have been pruned
  assert.equal(blobs.blobs.has("orphan-old-blob"), false);
  assert.equal(blobs.blobs.size, 4);

  // Duplicate upload after reload is still detected via restored sha256
  store2.addReferences([new File([new Uint8Array([1, 2, 3, 4, 5])], "dup.jpg", { type: "image/jpeg" })]);
  await waitUntil(() => store2.getSnapshot().refNotice.includes("已去重忽略重复参考图"));
  assert.equal(store2.getSnapshot().references.length, 2);

  // Removing a single reference deletes its blob
  const removedRefId = snap2.references[0].localId;
  store2.removeReference(removedRefId);
  assert.equal(blobs.blobs.has(removedRefId), false);
  assert.equal(blobs.blobs.size, 3);

  // Removing a single local product deletes its blob and updates localStorage
  const removedProdId = snap2.products[0].localId;
  store2.removeProduct(removedProdId);
  assert.equal(blobs.blobs.has(removedProdId), false);
  assert.equal(store2.getSnapshot().products.length, 1);
  assert.equal(local.getItem(REPLICA_DRAFT_STORAGE_KEY)?.includes(removedProdId), false);

  // clearDraft clears both localStorage and IndexedDB blobs
  store2.clearDraft();
  assert.equal(local.getItem(REPLICA_DRAFT_STORAGE_KEY), null);
  assert.equal(blobs.blobs.size, 0);
  assert.equal(urls2.active.size, 0);
});

test("复刻草稿持久化：冷启动异步 indexedDB.open（含 onupgradeneeded）期间上传图片不被孤立清理误删", async () => {
  const local = new MemoryStorageLike();
  const openGate = Promise.withResolvers<void>();
  const fakeIdb = createFakeAsyncIndexedDb(openGate.promise);
  const blobStorage = createIndexedDbBlobStorage("cold-start-db", "blobs", fakeIdb.factory);
  const urls1 = makeFakeUrlHooks();

  const store1 = createReplicaDraftStore({
    storage: local,
    legacySessionStorage: null,
    blobStorage,
    createObjectUrl: urls1.createObjectUrl,
    revokeObjectUrl: urls1.revokeObjectUrl,
  });

  // Subscribe (simulating ReplicaStudioPage mount) -> starts pruneBlobs -> 1st openDb() caller waiting on openGate
  const unsub = store1.subscribe(() => {});
  assert.equal(fakeIdb.getOpenCount(), 1);

  // Upload a reference image while indexedDB.open is still pending (2nd openDb() caller)
  const file = new File([new Uint8Array([21, 22, 23, 24])], "cold-upload.jpg", {
    type: "image/jpeg",
  });
  store1.addReferences([file]);
  // Give arrayBuffer() + sha256 time to finish so putBlob() is queued on the same pending openDb()
  await new Promise((r) => setTimeout(r, 20));

  // Complete async indexedDB.open (triggers onupgradeneeded + onsuccess)
  openGate.resolve();
  await waitUntil(() => store1.getSnapshot().references[0]?.status === "ready");
  await store1.waitForHydration();
  unsub();

  const idbStore = fakeIdb.getStore("blobs");
  assert.ok(idbStore, "blobs object store should exist");
  assert.equal(
    idbStore.size,
    1,
    "uploaded blob must survive cold-start openDb() + pruneBlobs without being cleared",
  );
  assert.ok(local.getItem(REPLICA_DRAFT_STORAGE_KEY)?.includes("cold-upload.jpg"));

  // Reloading a new store against the same IDB & localStorage restores the uploaded image cleanly
  const store2 = createReplicaDraftStore({
    storage: local,
    legacySessionStorage: null,
    blobStorage,
    createObjectUrl: makeFakeUrlHooks().createObjectUrl,
    revokeObjectUrl: () => {},
  });
  await store2.waitForHydration();
  assert.equal(store2.getSnapshot().references.length, 1);
  assert.equal(store2.getSnapshot().references[0].status, "ready");
  assert.equal(
    store2.getSnapshot().references[0].bytesBase64,
    Buffer.from([21, 22, 23, 24]).toString("base64"),
  );
});

test("复刻草稿持久化：多实例共享存储时非复刻路由不触发水合清理，且孤立清理合并 localStorage 最新引用不误删他页草稿", async () => {
  const local = new MemoryStorageLike();
  const blobs = new MemoryBlobStorage();

  // Seed an actual orphan blob that no draft references
  blobs.blobs.set("orphan-stale-key", new Blob([new Uint8Array([0])], { type: "image/jpeg" }));

  // Tab B loads on an unrelated route (e.g. /assets): createReplicaDraftStore() runs at module eval, never subscribes
  const storeB = createReplicaDraftStore({
    storage: local,
    legacySessionStorage: null,
    blobStorage: blobs,
    createObjectUrl: makeFakeUrlHooks().createObjectUrl,
    revokeObjectUrl: () => {},
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(blobs.getCalls, 0, "unrelated route must not read IDB blobs");
  assert.equal(blobs.pruneCalls, 0, "unrelated route must not prune shared IDB");

  // Meanwhile Tab A (on /create/replica) uploads an image to the shared localStorage + IDB
  const storeA = createReplicaDraftStore({
    storage: local,
    legacySessionStorage: null,
    blobStorage: blobs,
    createObjectUrl: makeFakeUrlHooks().createObjectUrl,
    revokeObjectUrl: () => {},
  });
  storeA.addReferences([new File([new Uint8Array([31, 32, 33])], "tab-a.jpg", { type: "image/jpeg" })]);
  await waitUntil(() => storeA.getSnapshot().references[0]?.status === "ready");
  const tabABlobKey = storeA.getSnapshot().references[0].localId;
  assert.equal(blobs.blobs.has(tabABlobKey), true);

  // Now Tab B navigates to /create/replica and triggers subscribe -> hydration & pruneBlobs
  const unsubB = storeB.subscribe(() => {});
  await storeB.waitForHydration();
  unsubB();

  // Tab B must have pruned the genuine orphan, while keeping Tab A's active blob referenced in localStorage
  assert.equal(blobs.blobs.has("orphan-stale-key"), false, "genuine orphan should be pruned");
  assert.equal(
    blobs.blobs.has(tabABlobKey),
    true,
    "Tab B must not delete Tab A's blob referenced in localStorage",
  );

  // Scenario 2: Tab C starts hydrating an older draft while Tab A uploads a second image during Tab C's getBlobs
  const delayGate = Promise.withResolvers<void>();
  blobs.getDelayGate = delayGate.promise;
  const storeC = createReplicaDraftStore({
    storage: local,
    legacySessionStorage: null,
    blobStorage: blobs,
    createObjectUrl: makeFakeUrlHooks().createObjectUrl,
    revokeObjectUrl: () => {},
  });
  const unsubC = storeC.subscribe(() => {});

  // While Tab C is awaiting getBlobs, Tab A uploads another distinct image
  storeA.addReferences([new File([new Uint8Array([41, 42, 43])], "tab-a-2.jpg", { type: "image/jpeg" })]);
  await waitUntil(() => storeA.getSnapshot().references.length === 2 && storeA.getSnapshot().references[1].status === "ready");
  const tabABlobKey2 = storeA.getSnapshot().references[1].localId;

  delayGate.resolve();
  await storeC.waitForHydration();
  unsubC();

  assert.equal(
    blobs.blobs.has(tabABlobKey2),
    true,
    "Tab C's post-hydration prune must keep images uploaded by Tab A during hydration",
  );
});

test("复刻草稿持久化：旧 sessionStorage 迁移后改回默认会清理旧键；非法 previewUrl 回退且异常大小 Blob 被丢弃", async () => {
  // 1. Legacy sessionStorage config cleanup when user resets back to default
  const local = new MemoryStorageLike();
  const legacySession = new MemoryStorageLike();
  legacySession.setItem(
    REPLICA_DRAFT_CONFIG_STORAGE_KEY,
    JSON.stringify({ sceneType: "apparel", unifiedRequirement: "旧配置" }),
  );
  const store1 = createReplicaDraftStore({
    storage: local,
    legacySessionStorage: legacySession,
    blobStorage: new MemoryBlobStorage(),
    createObjectUrl: makeFakeUrlHooks().createObjectUrl,
    revokeObjectUrl: () => {},
  });
  assert.equal(store1.getSnapshot().config.sceneType, "apparel");
  assert.equal(store1.getSnapshot().config.unifiedRequirement, "旧配置");

  store1.updateConfig({ sceneType: "ecommerce_product", unifiedRequirement: "" });
  assert.equal(legacySession.getItem(REPLICA_DRAFT_CONFIG_STORAGE_KEY), null);
  assert.equal(local.getItem(REPLICA_DRAFT_STORAGE_KEY), null);

  const store1Reloaded = createReplicaDraftStore({
    storage: local,
    legacySessionStorage: legacySession,
    blobStorage: new MemoryBlobStorage(),
    createObjectUrl: makeFakeUrlHooks().createObjectUrl,
    revokeObjectUrl: () => {},
  });
  assert.equal(store1Reloaded.getSnapshot().config.sceneType, "ecommerce_product");
  assert.equal(store1Reloaded.getSnapshot().config.unifiedRequirement, "");

  // 2. Ignore legacy persisted library products & reject empty/oversized blobs during hydration
  const local2 = new MemoryStorageLike();
  const blobs2 = new MemoryBlobStorage();
  local2.setItem(
    REPLICA_DRAFT_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      config: {},
      references: [
        { localId: "ref-empty", blobKey: "ref-empty", filename: "empty.jpg", mimeType: "image/jpeg", sha256: "", remark: "" },
        { localId: "ref-huge", blobKey: "ref-huge", filename: "huge.jpg", mimeType: "image/jpeg", sha256: "", remark: "" },
        { localId: "ref-ok", blobKey: "ref-ok", filename: "ok.jpg", mimeType: "image/jpeg", sha256: "", remark: "" },
      ],
      products: [
        {
          localId: "lib-legacy-1",
          sourceKind: "library",
          libraryResourceId: "base:legacy-1",
          resourceVersionId: "v1",
          title: "旧资源库产品图",
          previewUrl: "/api/library/resources/base%3Alegacy-1/preview",
          resourceType: "base_image",
        },
        {
          localId: "prod-ok",
          sourceKind: "upload",
          blobKey: "prod-ok",
          filename: "local-ok.jpg",
          mimeType: "image/jpeg",
          sha256: "",
        },
      ],
    }),
  );

  blobs2.blobs.set("ref-empty", new Blob([], { type: "image/jpeg" }));
  blobs2.blobs.set("ref-huge", {
    size: REPLICA_MAX_IMAGE_BYTES + 1,
    type: "image/jpeg",
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Blob);
  blobs2.blobs.set("ref-ok", new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }));
  blobs2.blobs.set("prod-ok", new Blob([new Uint8Array([4, 5, 6])], { type: "image/jpeg" }));

  const store2 = createReplicaDraftStore({
    storage: local2,
    legacySessionStorage: null,
    blobStorage: blobs2,
    createObjectUrl: makeFakeUrlHooks().createObjectUrl,
    revokeObjectUrl: () => {},
  });
  await store2.waitForHydration();

  const snap2 = store2.getSnapshot();
  assert.equal(snap2.references.length, 1);
  assert.equal(snap2.references[0].localId, "ref-ok");
  assert.equal(snap2.products.length, 1);
  assert.equal(snap2.products[0].localId, "prod-ok");
  assert.equal(snap2.products[0].sourceKind, "upload");
});

test("复刻草稿持久化：IndexedDB 写入失败或不可用时降级，不影响当前会话且刷新不报错", async () => {
  const local = new MemoryStorageLike();
  const blobs = new MemoryBlobStorage();
  blobs.failPut = true;
  const urls1 = makeFakeUrlHooks();

  const store1 = createReplicaDraftStore({
    storage: local,
    legacySessionStorage: null,
    blobStorage: blobs,
    createObjectUrl: urls1.createObjectUrl,
    revokeObjectUrl: urls1.revokeObjectUrl,
  });

  store1.addReferences([new File([new Uint8Array([1, 2, 3])], "ref.jpg", { type: "image/jpeg" })]);
  store1.addProductFiles([new File([new Uint8Array([4, 5, 6])], "prod.jpg", { type: "image/jpeg" })]);
  store1.updateConfig({ unifiedRequirement: "降级模式仍保留配置" });

  await waitUntil(
    () =>
      store1.getSnapshot().references[0]?.status === "ready" &&
      store1.getSnapshot().products[0]?.status === "ready",
  );
  assert.equal(store1.getSnapshot().references.length, 1);
  assert.equal(store1.getSnapshot().products.length, 1);
  assert.equal(store1.getSnapshot().refNotice, "");

  // Reload with unavailable IndexedDB (null)
  const store2 = createReplicaDraftStore({
    storage: local,
    legacySessionStorage: null,
    blobStorage: null,
    createObjectUrl: makeFakeUrlHooks().createObjectUrl,
    revokeObjectUrl: () => {},
  });
  await store2.waitForHydration();

  const snap2 = store2.getSnapshot();
  assert.equal(snap2.references.length, 0);
  assert.equal(snap2.products.length, 0);
  assert.equal(snap2.config.unifiedRequirement, "降级模式仍保留配置");
});

test("复刻草稿持久化：水合进行中调用 clearDraft 不会回填旧图片且释放对象 URL", async () => {
  const local = new MemoryStorageLike();
  const blobs = new MemoryBlobStorage();

  const store1 = createReplicaDraftStore({
    storage: local,
    legacySessionStorage: null,
    blobStorage: blobs,
    createObjectUrl: makeFakeUrlHooks().createObjectUrl,
    revokeObjectUrl: () => {},
  });
  store1.addReferences([new File([new Uint8Array([7, 8, 9])], "slow.jpg", { type: "image/jpeg" })]);
  await waitUntil(() => store1.getSnapshot().references[0]?.status === "ready");

  const gate = Promise.withResolvers<void>();
  blobs.getDelayGate = gate.promise;
  const urls2 = makeFakeUrlHooks();
  const store2 = createReplicaDraftStore({
    storage: local,
    legacySessionStorage: null,
    blobStorage: blobs,
    createObjectUrl: urls2.createObjectUrl,
    revokeObjectUrl: urls2.revokeObjectUrl,
  });

  // Start hydration, then clear before IDB hydration resolves
  const hydration = store2.waitForHydration();
  store2.clearDraft();
  gate.resolve();
  await hydration;

  assert.equal(store2.getSnapshot().references.length, 0);
  assert.equal(urls2.active.size, 0);
});
