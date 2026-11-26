import assert from "node:assert/strict";
import test from "node:test";
import { startPolling } from "../src/hooks/usePolling.js";

class Visibility extends EventTarget {
  hidden = false;

  setHidden(hidden: boolean) {
    this.hidden = hidden;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

const options = { enabled: true, initialDelayMs: 5, intervalMs: 10 };

test("轮询遵守首次延时、间隔和停止开关", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const visibility = new Visibility();
  let calls = 0;
  const poll = () => { calls++; };
  startPolling(poll, { ...options, enabled: false }, visibility);
  t.mock.timers.tick(50);
  assert.equal(calls, 0);

  const stop = startPolling(poll, options, visibility)!;
  t.mock.timers.tick(4);
  assert.equal(calls, 0);
  t.mock.timers.tick(1);
  assert.equal(calls, 1);
  await Promise.resolve();
  t.mock.timers.tick(10);
  assert.equal(calls, 2);
  stop();
  await Promise.resolve();
  t.mock.timers.tick(100);
  assert.equal(calls, 2);
});

test("切换依赖会取消旧请求，旧回包不会更新结果或重启定时器", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const visibility = new Visibility();
  const pending = Promise.withResolvers<void>();
  const signals: AbortSignal[] = [];
  const applied: string[] = [];
  const stopOld = startPolling(async signal => {
    signals.push(signal);
    await pending.promise;
    if (!signal.aborted) applied.push("old");
  }, options, visibility)!;
  t.mock.timers.tick(100);
  t.mock.timers.tick(100);
  assert.equal(signals.length, 1);
  stopOld();
  assert.ok(signals[0].aborted);
  const stopNew = startPolling(() => { applied.push("new"); }, options, visibility)!;
  pending.resolve();
  await pending.promise;
  await Promise.resolve();
  t.mock.timers.tick(20);
  assert.deepEqual(applied, ["new"]);
  assert.equal(signals.length, 1);
  stopNew();
});

test("读取失败会通知调用方，下一个间隔可继续读取", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const errors: unknown[] = [];
  const failure = new Error("network");
  const stop = startPolling(async () => {
    if (++calls === 1) throw failure;
  }, { ...options, initialDelayMs: 0, onError: error => errors.push(error) }, new Visibility())!;
  await Promise.resolve();
  assert.deepEqual(errors, [failure]);
  t.mock.timers.tick(10);
  assert.equal(calls, 2);
  stop();
});

test("隐藏期间暂停，在可见时立即刷新，清理后忽略可见性变化", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const visibility = new Visibility();
  visibility.setHidden(true);
  const signals: AbortSignal[] = [];
  const errors: unknown[] = [];
  const stop = startPolling(signal => {
    signals.push(signal);
    return new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  }, { ...options, onError: error => errors.push(error) }, visibility)!;
  t.mock.timers.tick(50);
  assert.equal(signals.length, 0);
  visibility.setHidden(false);
  assert.equal(signals.length, 1);
  visibility.setHidden(true);
  assert.ok(signals[0].aborted);
  t.mock.timers.tick(50);
  assert.equal(signals.length, 1);
  visibility.setHidden(false);
  assert.equal(signals.length, 2);
  stop();
  assert.ok(signals[1].aborted);
  visibility.setHidden(false);
  await Promise.resolve();
  assert.deepEqual(errors, []);
  assert.equal(signals.length, 2);
});

test("可按需在隐藏标签页继续轮询", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const visibility = new Visibility();
  visibility.setHidden(true);
  let calls = 0;
  const stop = startPolling(() => { calls++; }, { ...options, pauseWhenHidden: false }, visibility)!;
  t.mock.timers.tick(5);
  visibility.setHidden(false);
  assert.equal(calls, 1);
  await Promise.resolve();
  t.mock.timers.tick(10);
  assert.equal(calls, 2);
  stop();
});
