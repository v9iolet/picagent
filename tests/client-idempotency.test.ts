import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createGenerationActions, createIdempotencyKey, suiteApi } from "../src/api/client.js";

test("creates unique idempotency keys without crypto.randomUUID", () => {
  const first = createIdempotencyKey({});
  const second = createIdempotencyKey({});

  assert.match(first, /^[a-z0-9-]+$/);
  assert.notEqual(first, second);
});

test("手动重绘在回包丢失后复用幂等键，改提示词或收到任务编号后使用新键", async (t) => {
  const keys: string[] = [];
  let acknowledged = false;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    keys.push(new Headers(init.headers).get("idempotency-key")!);
    if (!acknowledged) throw new TypeError("network disconnected");
    return Response.json({ data: { batchId: "batch", status: "running" } });
  });
  const action = createGenerationActions();
  const submit = (prompt: string) => action("task", prompt, (key) => suiteApi.generateTask("task", prompt, key));
  await assert.rejects(submit("白色"));
  await assert.rejects(submit("白色"));
  assert.equal(keys[0], keys[1]);
  await assert.rejects(submit("蓝色"));
  assert.notEqual(keys[1], keys[2]);
  acknowledged = true;
  await submit("蓝色");
  assert.equal(keys[2], keys[3]);
  await submit("蓝色");
  assert.notEqual(keys[3], keys[4]);
  await suiteApi.generateTask("task", "蓝色", "explicit");
  assert.equal(keys[5], "explicit");
});
