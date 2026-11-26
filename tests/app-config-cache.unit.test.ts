import assert from "node:assert/strict";
import test from "node:test";
import { createConfigCache } from "../src/context/app-config-cache.js";

test("平台并发读取共用一个请求，切页命中缓存，主动刷新通知订阅者", async () => {
  let calls = 0;
  const cache = createConfigCache(async () => [++calls]);
  const changes: boolean[] = [];
  const unsubscribe = cache.subscribe(() => changes.push(cache.getSnapshot().loading));

  const first = cache.load();
  assert.equal(cache.load(), first);
  assert.equal(cache.getSnapshot().loading, true);
  await first;
  const initial = cache.getSnapshot();
  await cache.load();
  assert.equal(cache.getSnapshot(), initial);
  assert.deepEqual(initial.data, [1]);

  const next = cache.refresh();
  assert.equal(cache.refresh(), next);
  assert.equal(cache.load(), next);
  assert.deepEqual(cache.getSnapshot().data, [1]);
  await next;
  assert.deepEqual(cache.getSnapshot(), { data: [2], loading: false, error: null });
  unsubscribe();
  await cache.refresh();
  assert.deepEqual(changes, [true, false, true, false]);
});

test("首次加载或主动刷新失败后可以重试", async () => {
  const failure = new Error("读取失败");
  let fail = true;
  let version = 0;
  const cache = createConfigCache(async () => {
    if (fail) throw failure;
    return ++version;
  });
  await cache.load();
  assert.deepEqual(cache.getSnapshot(), { data: null, loading: false, error: failure });
  fail = false;
  await cache.refresh();
  assert.equal(cache.getSnapshot().data, 1);
  fail = true;
  await cache.refresh();
  assert.deepEqual(cache.getSnapshot(), { data: 1, loading: false, error: failure });
  fail = false;
  await cache.load();
  assert.deepEqual(cache.getSnapshot(), { data: 2, loading: false, error: null });
});

test("设置保存响应立即刷新缓存，更早发出的 GET 不能覆盖保存结果", async () => {
  const old = Promise.withResolvers<string>();
  const cache = createConfigCache(() => old.promise);
  const loading = cache.load();
  await cache.refresh("新偏好");
  old.resolve("旧偏好");
  await loading;
  await cache.load();
  assert.deepEqual(cache.getSnapshot(), { data: "新偏好", loading: false, error: null });
});
