// Run with: npx tsx --test tests/replica-draft-persistence.unit.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import type { ReplicaDraftBlobStorage } from "../src/features/replica/replica-draft-idb";
import {
  createReplicaDraftStore,
  REPLICA_DRAFT_STORAGE_KEY,
  type StorageLike,
} from "../src/features/replica/replica-draft-store";

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

  async putBlob(key: string, blob: Blob): Promise<boolean> {
    if (this.failPut) return false;
    this.blobs.set(key, blob);
    return true;
  }
  async getBlobs(keys: readonly string[]): Promise<Map<string, Blob>> {
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
  async pruneBlobs(keepKeys: ReadonlySet<string>): Promise<void> {
    for (const key of Array.from(this.blobs.keys())) {
      if (!keepKeys.has(key)) this.blobs.delete(key);
    }
  }
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

  store1.addReferences([ref1, ref2]);
  store1.addProductFiles([prod1]);
  await waitUntil(
    () =>
      store1.getSnapshot().references.length === 2 &&
      store1.getSnapshot().references.every((r) => r.status === "ready") &&
      store1.getSnapshot().products.length === 1 &&
      store1.getSnapshot().products.every((p) => p.status === "ready"),
  );

  // Add remarks, reorder references, add library product and reorder products
  const r0 = store1.getSnapshot().references[0];
  const r1 = store1.getSnapshot().references[1];
  store1.updateReferenceRemark(r0.localId, "第一张局部要求");
  store1.updateReferenceRemark(r1.localId, "第二张顶部留白");
  store1.moveReference(1, 0);

  store1.applyLibraryProducts([
    {
      libraryReferenceId: "",
      resourceId: "lib-001",
      resourceVersionId: "ver-001",
      order: 1,
      title: "白底图1",
      previewUrl: "/api/library/resources/lib-001/preview",
      resourceType: "base_image",
    },
  ]);
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
  assert.equal(blobs.blobs.size, 3);

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

  // Config and library product are available immediately synchronously
  assert.equal(store2.getSnapshot().config.sceneType, "apparel");
  assert.equal(store2.getSnapshot().config.unifiedRequirement, "保持构图与暖色调");
  assert.equal(store2.getSnapshot().products[0].sourceKind, "library");

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
  assert.equal(snap2.products[0].sourceKind, "library");
  assert.equal(snap2.products[1].sourceKind, "upload");
  if (snap2.products[1].sourceKind === "upload") {
    assert.equal(snap2.products[1].filename, "prod-local.webp");
    assert.equal(snap2.products[1].status, "ready");
    assert.equal(snap2.products[1].bytesBase64, Buffer.from([11, 12, 13, 14]).toString("base64"));
  }

  // Orphan blob should have been pruned
  assert.equal(blobs.blobs.has("orphan-old-blob"), false);
  assert.equal(blobs.blobs.size, 3);

  // Duplicate upload after reload is still detected via restored sha256
  store2.addReferences([new File([new Uint8Array([1, 2, 3, 4, 5])], "dup.jpg", { type: "image/jpeg" })]);
  await waitUntil(() => store2.getSnapshot().refNotice.includes("已去重忽略重复参考图"));
  assert.equal(store2.getSnapshot().references.length, 2);

  // Removing a single reference deletes its blob
  const removedRefId = snap2.references[0].localId;
  store2.removeReference(removedRefId);
  assert.equal(blobs.blobs.has(removedRefId), false);
  assert.equal(blobs.blobs.size, 2);

  // Pruning deleted library product persists to localStorage
  store2.removeDeletedLibraryProducts(new Set(["lib-001"]), "已移除 1 张已删除的图片");
  assert.equal(store2.getSnapshot().productNotice, "已移除 1 张已删除的图片");
  assert.equal(store2.getSnapshot().products.length, 1);
  assert.equal(local.getItem(REPLICA_DRAFT_STORAGE_KEY)?.includes("lib-001"), false);

  // clearDraft clears both localStorage and IndexedDB blobs
  store2.clearDraft();
  assert.equal(local.getItem(REPLICA_DRAFT_STORAGE_KEY), null);
  assert.equal(blobs.blobs.size, 0);
  assert.equal(urls2.active.size, 0);
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
  store1.applyLibraryProducts([
    {
      libraryReferenceId: "",
      resourceId: "lib-keep",
      resourceVersionId: "v1",
      order: 1,
      title: "资源库图",
      previewUrl: "/api/library/resources/lib-keep/preview",
      resourceType: "base_image",
    },
  ]);
  store1.updateConfig({ unifiedRequirement: "降级模式仍保留配置" });

  await waitUntil(() => store1.getSnapshot().references[0]?.status === "ready");
  assert.equal(store1.getSnapshot().references.length, 1);
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
  assert.equal(snap2.products.length, 1);
  assert.equal(snap2.products[0].sourceKind, "library");
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

  // Clear before IDB hydration resolves
  store2.clearDraft();
  gate.resolve();
  await store2.waitForHydration();

  assert.equal(store2.getSnapshot().references.length, 0);
  assert.equal(urls2.active.size, 0);
});
