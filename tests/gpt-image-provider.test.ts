import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { GptImageProvider } from "../server/providers/gpt-image-provider.js";
import type { ImageEditRequest } from "../server/types.js";

const request = (requestId: string): ImageEditRequest => ({ requestId, endpoint: "/v1/images/edits", image: Buffer.from("source"), imageMimeType: "image/png", imageFilename: "source.png", model: "gpt-image-2", prompt: "保留商品", size: "2048x3072", quality: "medium", n: 1, responseFormat: "b64_json" });

test("provider maps conservative size errors, bounds response reads, and redacts credentials from archives and logs", async (t) => {
  const apiKey = "unit-test-api-key-private";
  const requestId = "size-error-" + randomUUID();
  const logs: string[] = [];
  t.mock.method(process.stdout, "write", (chunk: unknown) => { logs.push(String(chunk)); return true; });
  let cancelled = false;
  const body = new TextEncoder().encode(JSON.stringify({ error: { message: "resolution not supported for group", api_key: apiKey, authorization: "Bearer another-secret" } }) + " ".repeat(3000));
  let receivedSize: FormDataEntryValue | null = null;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    receivedSize = (init.body as FormData).get("size");
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(body); }, cancel() { cancelled = true; } }), { status: 403 });
  });
  await assert.rejects(new GptImageProvider("https://example.test/v1", apiKey).edit(request(requestId)), { message: "IMAGE_SIZE_UNSUPPORTED" });
  assert.equal(receivedSize, "2048x3072");
  assert.equal(cancelled, true);
  const files = (await readdir("var/model-archives", { recursive: true })).filter((file) => file.includes(requestId));
  const archive = (await Promise.all(files.filter((file) => file.endsWith(".json")).map((file) => readFile("var/model-archives/" + file, "utf8")))).join("");
  assert.match(archive, /IMAGE_SIZE_UNSUPPORTED/);
  assert.match(archive, /resolution not supported/);
  assert.match(logs.join(""), /image.failed/);
  assert.doesNotMatch(archive + logs.join(""), /unit-test-api-key-private|another-secret/);
  const response = JSON.parse(await readFile("var/model-archives/" + files.find((file) => file.endsWith("_response.json")), "utf8"));
  assert.ok(Buffer.byteLength(response.response.errorBody) <= 2048);
});

test("unrelated client errors and server failures retain the generic provider error", async (t) => {
  for (const [status, body] of [[401, "invalid credential"], [429, "rate limit"], [500, "resolution service down"]] as const) {
    t.mock.method(globalThis, "fetch", async () => new Response(body, { status }));
    await assert.rejects(new GptImageProvider("https://example.test/v1", "test-key").edit(request("generic-error-" + randomUUID())), { message: "IMAGE_PROVIDER_FAILED" });
    t.mock.restoreAll();
  }
});

test("size errors beyond the 2KB read budget are ignored and truncated reflected keys are redacted", async (t) => {
  const apiKey = "boundary-api-key-private";
  const requestId = "bounded-error-" + randomUUID();
  const prefix = "account denied ";
  const body = prefix + " ".repeat(2048 - Buffer.byteLength(prefix) - 9) + apiKey + " resolution unsupported";
  t.mock.method(globalThis, "fetch", async () => new Response(body, { status: 403 }));
  await assert.rejects(new GptImageProvider("https://example.test/v1", apiKey).edit(request(requestId)), { message: "IMAGE_PROVIDER_FAILED" });
  const file = (await readdir("var/model-archives", { recursive: true })).find((file) => file.includes(requestId) && file.endsWith("_response.json"))!;
  const errorBody = JSON.parse(await readFile("var/model-archives/" + file, "utf8")).response.errorBody;
  assert.ok(Buffer.byteLength(errorBody) <= 2048);
  assert.doesNotMatch(errorBody, /boundary-|resolution/);
});
