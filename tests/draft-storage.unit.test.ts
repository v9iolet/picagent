import assert from "node:assert/strict";
import test from "node:test";
import { createIdbBlobStore, createWebStorageStore, type StorageLike } from "../src/lib/draft-storage";
import { createFakeAsyncIndexedDb } from "./draft-storage-fixture";

function memoryStorage(): StorageLike {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
  };
}

const options = {
  key: "workspace",
  version: 1,
  decode(data: unknown) {
    if (typeof data !== "object" || !data || !("title" in data) || typeof data.title !== "string") return null;
    return { version: 1, title: data.title };
  },
};

test("JSON 草稿保留原始字段，删除、损坏 JSON 和不合法的数据均可安全读取", () => {
  const storage = memoryStorage();
  const store = createWebStorageStore({ ...options, storage });
  const draft = { version: 1, title: "草稿" };
  assert.equal(store.write(draft), true);
  assert.equal(storage.getItem(options.key), JSON.stringify(draft));
  assert.deepEqual(store.read(), draft);
  assert.equal(store.remove(), true);
  assert.equal(store.readResult().status, "missing");
  for (const invalid of ["{", "null", '{"version":1}']) {
    storage.setItem(options.key, invalid);
    assert.equal(store.read(), null);
    assert.equal(store.readResult().status, "unreadable");
  }
});

test("版本不匹配时可丢弃或迁移，只有满足当前版本与字段要求的结果才可恢复", () => {
  const storage = memoryStorage();
  storage.setItem(options.key, JSON.stringify({ version: 0, name: "旧标题" }));
  assert.equal(createWebStorageStore({ ...options, storage }).read(), null);
  const migrated = createWebStorageStore({
    ...options, storage,
    migrate: (data) => ({ version: 1, title: (data as { name: string }).name }),
  });
  assert.deepEqual(migrated.read(), { version: 1, title: "旧标题" });
  for (const result of [{ version: 0, title: "旧标题" }, { version: 1, title: 42 }]) {
    assert.equal(createWebStorageStore({ ...options, storage, migrate: () => result }).read(), null);
  }
});

test("SSR、隐私模式和配额超限下安全降级，写入失败保留之前的草稿", () => {
  const restricted = () => { throw new DOMException("disabled", "SecurityError"); };
  const draft = { version: 1, title: "上次保存" };
  for (const storage of [null, "sessionStorage", "localStorage", {
    getItem: restricted, setItem: restricted, removeItem: restricted,
  }] as const) {
    const store = createWebStorageStore({ ...options, storage });
    assert.equal(store.readResult().status, "unreadable");
    assert.equal(store.write(draft), false);
    assert.equal(store.remove(), false);
  }
  const storage = memoryStorage();
  const store = createWebStorageStore({ ...options, storage });
  assert.equal(store.write(draft), true);
  storage.setItem = () => { throw new DOMException("full", "QuotaExceededError"); };
  assert.equal(store.write({ ...draft, title: "未保存" }), false);
  assert.deepEqual(store.read(), draft);
});

test("浏览器禁止访问存储属性时可以继续操作，恢复权限后可以再次保存", (t) => {
  const storage = memoryStorage();
  let restricted = true;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      get localStorage() {
        if (restricted) throw new DOMException("disabled", "SecurityError");
        return storage;
      },
    },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const store = createWebStorageStore({ ...options, storage: "localStorage" });
  const draft = { version: 1, title: "恢复后保存" };
  assert.equal(store.write(draft), false);
  assert.equal(store.readResult().status, "unreadable");
  assert.equal(store.remove(), false);
  restricted = false;
  assert.equal(store.write(draft), true);
  assert.deepEqual(store.read(), draft);
});

const idbOptions = { dbName: "draft-storage-test", storeName: "blobs" };

test("Blob 单条与批量读写、按前缀清理与按最新引用删除孤立图片", async () => {
  const gate = Promise.withResolvers<void>();
  const fake = createFakeAsyncIndexedDb(gate.promise);
  const store = createIdbBlobStore({ ...idbOptions, idbFactory: fake.factory });
  const image = new Blob(["original"], { type: "image/png" });
  const keys = ["ref-1", "ref-2", "product-1"];
  const batch = store.putBlobs(new Map(keys.map((key) => [key, image])));
  const single = store.putBlob("ref-3", image);
  assert.equal(fake.getOpenCount(), 1);
  gate.resolve();
  assert.deepEqual(await Promise.all([batch, single]), [true, true]);
  assert.deepEqual([...(await store.getBlobs([...keys, "missing"])).keys()], keys);
  assert.equal(await (await store.getBlob("ref-3"))?.text(), "original");
  await store.deleteBlob("ref-3");
  await store.pruneBlobs(() => null);
  await store.pruneBlobs(() => { throw new DOMException("disabled", "SecurityError"); });
  assert.deepEqual([...(await store.getBlobs(keys)).keys()], keys);
  await store.pruneBlobs(() => new Set(["ref-1"]), "ref-");
  assert.deepEqual([...(await store.getBlobs(keys)).keys()], ["ref-1", "product-1"]);
  await store.clearBlobs("ref-");
  assert.equal(await store.getBlob("ref-1"), null);
  assert.equal((await store.getBlob("product-1"))?.type, "image/png");
  await store.clearBlobs();
  assert.equal(fake.getStore()?.size, 0);
});

test("IndexedDB 缺失或打开失败时安全降级，临时失败后可重试", async () => {
  const fake = createFakeAsyncIndexedDb(Promise.resolve());
  let attempts = 0;
  const flaky = {
    open(...args: Parameters<IDBFactory["open"]>) {
      attempts++;
      if (attempts === 1) throw new DOMException("disabled", "SecurityError");
      if (attempts === 2) {
        const request = { onerror: null as (() => void) | null };
        queueMicrotask(() => request.onerror?.());
        return request as IDBOpenDBRequest;
      }
      return fake.factory.open(...args);
    },
  } as IDBFactory;
  const image = new Blob(["retry"]);
  const store = createIdbBlobStore({ ...idbOptions, idbFactory: flaky });
  assert.equal(await store.putBlob("image", image), false);
  assert.equal(await store.putBlob("image", image), false);
  assert.equal(await store.putBlob("image", image), true);
  const unavailable = createIdbBlobStore({ ...idbOptions, idbFactory: null });
  assert.equal(await unavailable.putBlob("image", image), false);
  assert.equal(await unavailable.getBlob("image"), null);
  assert.equal((await unavailable.getBlobs(["image"])).size, 0);
  await unavailable.deleteBlob("image");
  await unavailable.clearBlobs();
  await unavailable.pruneBlobs(new Set());
});
