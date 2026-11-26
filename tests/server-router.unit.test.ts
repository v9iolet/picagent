import assert from "node:assert/strict";
import test from "node:test";
import { fail } from "../server/api-errors.js";
import { dataOf, ok } from "../server/api-response.js";
import { createRouter, decodeParam, requireIdempotencyKey } from "../server/http/router.js";

test("template routes split the query and decode each captured segment once", async () => {
  const router = createRouter();
  const path = "/api/suites/a%2Fb/tasks/%2520?tag=x+y&tag=z?1";
  const options = { headers: { "IDEMPOTENCY-KEY": "retry" }, body: { name: "修改" } };
  router.patch("/api/suites/:suiteId/tasks/:taskId", (ctx) => {
    assert.equal(ctx.method, "PATCH");
    assert.equal(ctx.path, path);
    assert.equal(ctx.pathname, path.split("?")[0]);
    assert.deepEqual({ ...ctx.params }, { suiteId: "a/b", taskId: "%20" });
    assert.deepEqual(ctx.query.getAll("tag"), ["x y", "z?1"]);
    assert.equal(ctx.headers, options.headers);
    assert.equal(ctx.body, options.body);
    assert.equal(ctx.idempotencyKey, "retry");
    return ok("updated");
  });
  assert.equal(dataOf((await router.dispatch("patch", path, options))!), "updated");
  assert.equal(await router.dispatch("GET", path), null);
  assert.equal(await router.dispatch("PATCH", "/api/suites//tasks/t"), null);
});

test("registration supports each method, literal path text and regex fallback", async () => {
  const router = createRouter();
  for (const verb of ["get", "post", "patch", "put", "delete"] as const) {
    router[verb]("/v1.0", () => ok(verb));
    assert.equal(dataOf((await router.dispatch(verb, "/v1.0"))!), verb);
  }
  assert.equal(await router.dispatch("GET", "/v1x0"), null);
  router.route("HEAD", /^\/items\/(?<name>[^/]+)$/g, ({ params }) => ok(params.name));
  router.get(/^\/items\/(\d+)$/, ({ params }) => ok(params["1"]));
  for (let i = 0; i < 2; i++) assert.equal(dataOf((await router.dispatch("HEAD", "/items/%2B"))!), "+");
  assert.equal(dataOf((await router.dispatch("GET", "/items/42?x=1"))!), "42");
});

test("a malformed escape or unmatched route lets the next router or final 404 handle it", async () => {
  const first = createRouter(), second = createRouter();
  first.get("/one/:id", () => ok("one"));
  second.get("/two", () => ok("two"));
  const dispatch = async (path: string) =>
    await first.dispatch("GET", path) ?? await second.dispatch("GET", path) ?? fail("NOT_FOUND", 404);
  assert.equal(decodeParam("%E0%A4"), null);
  assert.equal((await dispatch("/one/%")).status, 404);
  assert.equal(dataOf(await dispatch("/two")), "two");
  assert.equal((await dispatch("/missing")).status, 404);
});

test("idempotency guard uses the existing error envelope and passes a trimmed key", async () => {
  const router = createRouter();
  router.post("/jobs", requireIdempotencyKey(async ({ idempotencyKey }) => ok(idempotencyKey, 201)));
  for (const key of [undefined, "  "]) {
    const response = await router.dispatch("POST", "/jobs", { headers: { "Idempotency-Key": key } });
    assert.equal(response?.status, 400);
    assert.ok(response && "error" in response.body && response.body.error.code === "MISSING_IDEMPOTENCY_KEY");
  }
  assert.equal(dataOf((await router.dispatch("POST", "/jobs", { headers: { "Idempotency-Key": " job " } }))!), "job");
});
