import assert from "node:assert/strict";
import test from "node:test";
import { ApiHttpError, deleteJson, getJson, patchJson, postJson, putJson, suiteApi } from "../src/api/client.js";

test("JSON 方法保留请求体、JSON 头和调用方的幂等键", async t => {
  const requests: RequestInit[] = [];
  t.mock.method(globalThis, "fetch", async (_path: string, init: RequestInit) => {
    requests.push(init);
    return Response.json({ data: { ok: true } });
  });

  assert.deepEqual(await getJson("/resource"), { ok: true });
  await postJson("/resource", { value: 1 }, { idempotent: true });
  await patchJson("/resource", { value: 2 }, { idempotent: true });
  await putJson("/resource", {}, { idempotent: true, headers: { "Idempotency-Key": "retry" } });
  await deleteJson("/resource");
  await postJson("/resource", { value: 3 });
  assert.deepEqual(requests.map(req => req.method), ["GET", "POST", "PATCH", "PUT", "DELETE", "POST"]);
  assert.deepEqual(requests.map(req => req.body), [undefined, '{"value":1}', '{"value":2}', '{}', undefined, '{"value":3}']);
  const headers = requests.map(req => new Headers(req.headers));
  for (const i of [1, 2, 3, 5]) assert.equal(headers[i].get("content-type"), "application/json");
  const keys = headers.map(header => header.get("idempotency-key"));
  assert.ok(keys[1] && keys[2]);
  assert.notEqual(keys[1], keys[2]);
  assert.equal(keys[3], "retry");
  for (const i of [0, 4, 5]) assert.equal(keys[i], null);
});

test("结构规划保留选择的资料版本并附带幂等键", async t => {
  t.mock.method(globalThis, "fetch", async (path: string, init: RequestInit) => {
    assert.equal(path, "/api/suites/suite/structure-plan");
    assert.ok(new Headers(init.headers).get("idempotency-key"));
    assert.deepEqual(JSON.parse(String(init.body)).selectedChunks, [{ id: "chunk", version: "v1" }]);
    return Response.json({ data: { attemptId: "attempt", status: "running" } });
  });
  const plan = await suiteApi.generateStructurePlan("suite", "template", {}, [
    { id: "chunk", version: "v1", title: "", summary: "", sourceKind: "", sourceAssetPaths: [], contentSha256: "", fieldValues: {} },
  ]);
  assert.equal(plan.attemptId, "attempt");
});

test("HTTP 错误保留状态码、业务错误码和服务端文案", async t => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: { code: "CONFLICT", message: "版本已更新" } }, { status: 409 }));
  await assert.rejects(getJson("/resource"), (error: unknown) =>
    error instanceof ApiHttpError && error.status === 409 && error.code === "CONFLICT" && error.message === "版本已更新");
});
