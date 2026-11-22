import http from "node:http";
import { once } from "node:events";
import { MemoryPromptRepository } from "../server/repositories/memory-prompt-repository.js";
import { parsePromptMarkdown } from "../server/prompt-library.js";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createSuiteStudioApp } from "../server/app.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";
import { ModelSettings, type ModelSettingsState } from "../server/model-settings.js";
import { resolveImageSize } from "../shared/model-settings.js";

const path = "/api/model-settings";
const channel = {
  name: "测试渠道",
  protocol: "openai-compatible",
  baseUrl: "http://127.0.0.1:9999/v1",
  apiKey: "test-secret",
  models: [{ id: "shared-model", capabilities: ["image"] }],
};

function setup() {
  let state: ModelSettingsState = { channels: [], preferences: { image: null, vision: null } };
  const settings = new ModelSettings({
    read: async () => structuredClone(state),
    update: async (change) => { state = change(structuredClone(state)); return structuredClone(state); },
  });
  const createApp = () => createSuiteStudioApp({ repository: new MemorySuiteRepository(), storage: new MemoryStorage(), modelSettings: settings });
  return { api: createApp(), settings, createApp };
}

test("maintains shared channels and keeps saved credentials out of responses", async () => {
  const { api, createApp } = setup();
  const created = await api.request("POST", path + "/channels", { body: channel });
  assert.equal(created.status, 201);
  assert.doesNotMatch(JSON.stringify(created.body), /test-secret/);
  const id = created.body.data.channels[0].id;
  const restored = await createApp().request("GET", path);
  assert.equal(restored.body.data.channels[0].hasApiKey, true);
  assert.doesNotMatch(JSON.stringify(restored.body), /test-secret/);
  const endpoint = path + "/channels/" + id;
  assert.equal((await api.request("PUT", endpoint, { body: { ...channel, baseUrl: "http://127.0.0.1:9998", apiKey: "" } })).status, 400);
  assert.equal((await api.request("PUT", endpoint, { body: { ...channel, name: "重命名", apiKey: "" } })).body.data.channels[0].name, "重命名");
  assert.equal((await api.request("DELETE", endpoint)).body.data.channels.length, 0);
});

test("discovers unique model IDs using the draft endpoint without saving the channel", async (t) => {
  const { api } = setup();
  const calls: Array<[string | undefined, string | undefined, string | undefined]> = [];
  const upstream = http.createServer((req, res) => {
    calls.push([req.method, req.url, req.headers.authorization]);
    if (req.url === "/unsupported/models") return res.writeHead(404).end();
    if (req.url === "/redirect/models") return res.writeHead(302, { location: "/v1/models" }).end();
    if (req.url === "/reflected/models") return res.end(JSON.stringify({ data: [{ id: req.headers.authorization }] }));
    return res.end(JSON.stringify({ data: [{ id: "image-test" }, { id: "vision-test" }, { id: "image-test" }] }));
  }).listen(0, "127.0.0.1");
  t.after(() => upstream.close());
  await once(upstream, "listening");
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const root = `http://127.0.0.1:${address.port}`;
  const discover = (baseUrl: string, apiKey: string, channelId?: string) =>
    api.request("POST", path + "/models", { body: { baseUrl, apiKey, channelId } });

  const draft = await discover(root, "draft-token");
  assert.equal(draft.status, 200);
  assert.deepEqual(draft.body.data, { modelIds: ["image-test", "vision-test"] });
  assert.deepEqual((await api.request("GET", path)).body.data.channels, []);
  const saved = await api.request("POST", path + "/channels", { body: { ...channel, baseUrl: `${root}/gateway/v2`, apiKey: "stored-token" } });
  const channelId = saved.body.data.channels[0].id;
  assert.deepEqual((await discover(`${root}/gateway/v2/`, "", channelId)).body.data, draft.body.data);
  assert.equal((await discover(`${root}/elsewhere`, "", channelId)).status, 400);
  assert.equal((await discover(`${root}/unsupported`, "draft-token")).body.error.code, "MODEL_LIST_UNSUPPORTED");
  assert.equal((await discover(`${root}/redirect`, "draft-token")).status, 502);
  const reflected = await discover(`${root}/reflected`, "draft-token");
  assert.equal(reflected.body.error.code, "INVALID_MODEL_LIST");
  assert.doesNotMatch(JSON.stringify(reflected.body), /draft-token/);
  assert.deepEqual(calls, [
    ["GET", "/v1/models", "Bearer draft-token"],
    ["GET", "/gateway/v2/models", "Bearer stored-token"],
    ["GET", "/unsupported/models", "Bearer draft-token"],
    ["GET", "/redirect/models", "Bearer draft-token"],
    ["GET", "/reflected/models", "Bearer draft-token"],
  ]);
  assert.deepEqual((await api.request("GET", path)).body.data.channels[0].models, channel.models);
});

test("base refinement uses the selected channel, retains its source, and switches for new submissions", async (t) => {
  const { settings } = setup();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const calls: Array<{ url: string | undefined; key: string | undefined; multipart: string }> = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ url: req.url, key: req.headers.authorization, multipart: Buffer.concat(chunks).toString() });
    res.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }));
  }).listen(0, "127.0.0.1");
  t.after(() => upstream.close());
  await once(upstream, "listening");
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const gatewayUrl = `http://127.0.0.1:${address.port}`;
  const prompts = new MemoryPromptRepository();
  const [version] = await prompts.importRecords(parsePromptMarkdown("### 产品图转干净产品底图返修提示词\n\n```plain\n白底精修\n```", "prompt.md"));
  await prompts.publishVersion(version.templateVersionId);
  const api = createSuiteStudioApp({ repository: new MemorySuiteRepository(), storage: new MemoryStorage(), modelSettings: settings, promptRepository: prompts });
  const suite = await api.request("POST", "/api/suites", { body: { name: "白底精修" } });
  const uploaded = await api.upload(suite.body.data.id, { bytes: png, filename: "product.png", mimeType: "image/png" });
  const imagePath = `/api/suites/${suite.body.data.id}/input-images/${uploaded.body.data.id}`;
  const submit = (key: string) => api.request("POST", imagePath + "/base-generation", { headers: { "idempotency-key": key }, body: { templateVersionId: version.templateVersionId } });
  assert.match((await submit("missing")).body.error.message, /偏好设置.*生图/);

  const add = (prefix: string, key: string) => api.request("POST", path + "/channels", { body: { ...channel, name: prefix, baseUrl: gatewayUrl + prefix, apiKey: key } });
  const first = (await add("/first/v1", "old-token")).body.data.channels[0].id;
  const second = (await add("/second/v1", "new-token")).body.data.channels[1].id;
  const saved = await api.request("PUT", path + "/channels/" + second, {
    body: { ...channel, name: "/second/v1", baseUrl: gatewayUrl + "/second/v1", apiKey: "replacement-token" },
  });
  assert.equal(saved.status, 200);
  assert.doesNotMatch(JSON.stringify(saved.body), /replacement-token/);
  const select = (channelId: string) => api.request("PATCH", path + "/preferences", { body: { image: { channelId, modelId: "shared-model" } } });
  assert.equal((await select(first)).status, 200);
  assert.equal((await api.request("DELETE", path + "/channels/" + first)).status, 409);
  assert.equal((await submit("first")).status, 202);
  assert.equal((await select(second)).status, 200);
  assert.equal((await submit("second")).status, 202);
  let history;
  for (let index = 0; index < 100; index += 1) {
    history = (await api.request("GET", imagePath + "/base-versions")).body.data;
    if (history.versions.length === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(history.versions.length, 2);
  assert.deepEqual(history.attempts.map((attempt) => attempt.channel.channelId).sort(), [first, second].sort());
  assert.deepEqual(calls.map(({ url, key }) => [url, key]).sort(), [["/first/v1/images/edits", "Bearer old-token"], ["/second/v1/images/edits", "Bearer replacement-token"]]);
  assert.ok(calls.every(({ multipart }) => multipart.includes("shared-model") && multipart.includes('name="image"')));
});

test("updates the two default preferences independently and protects their channel models", async () => {
  const { api } = setup();
  const first = await api.request("POST", path + "/channels", { body: channel });
  const second = await api.request("POST", path + "/channels", { body: {
    ...channel, name: "兼容多模态渠道", models: [{ id: "shared-model", capabilities: ["vision"] }],
  } });
  const image = { channelId: first.body.data.channels[0].id, modelId: "shared-model" };
  const vision = { channelId: second.body.data.channels[1].id, modelId: "shared-model" };
  const preferences = (body: unknown) => api.request("PATCH", path + "/preferences", { body });
  assert.equal((await preferences({ image: vision })).status, 400);
  assert.equal((await preferences({ image })).status, 200);
  assert.deepEqual((await preferences({ vision })).body.data.preferences, { image, vision });

  const imageChannelPath = path + "/channels/" + image.channelId;
  const removeAbility = await api.request("PUT", imageChannelPath, {
    body: { ...channel, apiKey: "", models: [{ id: "shared-model", capabilities: ["vision"] }] },
  });
  assert.equal(removeAbility.status, 409);
  assert.match(removeAbility.body.error.message, /切换或清除默认生图模型/);
  assert.equal((await api.request("PUT", imageChannelPath, { body: { ...channel, models: [] } })).status, 409);
  assert.equal((await api.request("DELETE", imageChannelPath)).status, 409);

  assert.deepEqual((await preferences({ image: null })).body.data.preferences, { image: null, vision });
  assert.equal((await api.request("DELETE", imageChannelPath)).status, 200);
});

test("image options round-trip through channels and resolve with legacy model defaults", async () => {
  const { api, settings } = setup();
  const imageOptions = { sizes: ["1K", "2K"], aspectRatios: ["1:1", "2:3"], sizeMode: "pixels" };
  const created = await api.request("POST", path + "/channels", { body: {
    ...channel, models: [{ id: "gpt-image-2.5-flare-special", capabilities: ["image"], imageOptions }],
  } });
  const saved = created.body.data.channels[0];
  assert.deepEqual(saved.models[0].imageOptions, imageOptions);
  await api.request("PATCH", path + "/preferences", { body: { image: { channelId: saved.id, modelId: saved.models[0].id } } });
  assert.deepEqual((await settings.resolve("image"))?.imageOptions, imageOptions);
  assert.deepEqual((await api.request("GET", path)).body.data.channels[0].models[0].imageOptions, imageOptions);
  await api.request("PUT", path + "/channels/" + saved.id, { body: {
    ...channel, models: [{ id: saved.models[0].id, capabilities: ["image"] }],
  } });
  assert.deepEqual((await settings.resolve("image"))?.imageOptions, {
    sizes: ["1K", "2K", "4K"], aspectRatios: ["1:1", "2:3", "3:2"], sizeMode: "pixels",
  });
  await api.request("PATCH", path + "/preferences", { body: { image: null } });
  await api.request("PUT", path + "/channels/" + saved.id, { body: channel });
  await api.request("PATCH", path + "/preferences", { body: { image: { channelId: saved.id, modelId: "shared-model" } } });
  assert.deepEqual((await settings.resolve("image"))?.imageOptions, {
    sizes: ["1K"], aspectRatios: ["1:1"], sizeMode: "tier",
  });
});

test("invalid image options are rejected without losing the saved capability configuration", async () => {
  const { api } = setup();
  for (const imageOptions of [
    { sizes: [], aspectRatios: ["1:1"], sizeMode: "pixels" },
    { sizes: ["8K"], aspectRatios: ["1:1"], sizeMode: "pixels" },
    { sizes: ["1K"], aspectRatios: ["0:3"], sizeMode: "pixels" },
    { sizes: ["1K"], aspectRatios: ["1:1"], sizeMode: "unknown" },
  ]) {
    assert.equal((await api.request("POST", path + "/channels", { body: { ...channel, models: [{ ...channel.models[0], imageOptions }] } })).status, 400);
  }
  assert.deepEqual((await api.request("GET", path)).body.data.channels, []);
});

test("pixel conversion reproduces measured dimensions and caps the square 4K baseline at 2880", () => {
  assert.equal(resolveImageSize("1K", "1:1", "pixels"), "1024x1024");
  assert.equal(resolveImageSize("1K", "2:3", "pixels"), "1024x1536");
  assert.equal(resolveImageSize("1K", "3:2", "pixels"), "1536x1024");
  assert.equal(resolveImageSize("2K", "1:1", "pixels"), "2048x2048");
  assert.equal(resolveImageSize("4K", "1:1", "pixels"), "2880x2880");
  assert.equal(resolveImageSize("2K", "3:4", "tier"), "2K");
  assert.throws(() => resolveImageSize("8K", "1:1", "pixels"), /IMAGE_SIZE_UNSUPPORTED/);
  assert.throws(() => resolveImageSize("1K", "0:1", "pixels"), /IMAGE_SIZE_UNSUPPORTED/);
});
