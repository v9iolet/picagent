import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, type TestContext } from "node:test";
import sharp from "sharp";
import { errorMessages } from "../server/api-errors.js";
import { GptImageProvider, ImageUrlDownloadError } from "../server/providers/gpt-image-provider.js";
import { detectImageProtocol, imageEndpoint } from "../server/providers/image-protocol.js";
import type { ImageEditRequest } from "../server/types.js";
import { defaultImageOptions, resolveImageSize } from "../shared/model-settings.js";

const workspace = "https://ws-8odv4ivlr01vkob5.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
const proxy = "https://relay.example.test";
const yunfei = "https://img.yunfei.best";
const key = "channel-key";
const qwen = "qwen-image-2.1-pro";
const gemini = "gemini-3.1-flash-image-preview";
const source = Buffer.from("reference");
const generated = Buffer.from("generated");
const b64 = generated.toString("base64");
const cdnUrl = "https://cdn.example.test/result?signature=temporary";

const archiveMode = process.env.MODEL_ARCHIVE_MODE;
before(() => { process.env.MODEL_ARCHIVE_MODE = "off"; });
after(() => {
  if (archiveMode === undefined) delete process.env.MODEL_ARCHIVE_MODE;
  else process.env.MODEL_ARCHIVE_MODE = archiveMode;
});

function request(overrides: Partial<ImageEditRequest> = {}): ImageEditRequest {
  return {
    endpoint: "/v1/images/edits", model: qwen, prompt: "保留商品", size: "1K",
    image: source, imageMimeType: "image/png", imageFilename: "source.png",
    quality: "medium", n: 1, responseFormat: "b64_json", ...overrides,
  };
}

function jsonBody(init: RequestInit) {
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "error");
  assert.equal(new Headers(init.headers).get("content-type"), "application/json");
  assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${key}`);
  assert.equal(typeof init.body, "string");
  return JSON.parse(init.body as string);
}

function captureImageLog(t: TestContext) {
  const stdout = t.mock.method(process.stdout, "write");
  return (requestId: string) => {
    const line = stdout.mock.calls.map(({ arguments: [chunk] }) => String(chunk))
      .find((chunk) => chunk.includes(`"request_id":"${requestId}"`));
    assert.ok(line, requestId);
    return JSON.parse(line);
  };
}

async function captureImageArchive(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "image-protocol-test-"));
  const originalDirectory = process.env.MODEL_ARCHIVE_DIR;
  process.env.MODEL_ARCHIVE_DIR = directory;
  process.env.MODEL_ARCHIVE_MODE = "metadata";
  t.after(async () => {
    process.env.MODEL_ARCHIVE_MODE = "off";
    if (originalDirectory === undefined) delete process.env.MODEL_ARCHIVE_DIR;
    else process.env.MODEL_ARCHIVE_DIR = originalDirectory;
    await rm(directory, { recursive: true, force: true });
  });
  return async (requestId: string, phase: "request" | "response") => {
    const files = await readdir(directory, { recursive: true });
    const file = files.find((entry) => entry.endsWith(`_${requestId}_${phase}.json`));
    assert.ok(file, `${requestId} ${phase}`);
    return JSON.parse(await readFile(join(directory, file), "utf8"));
  };
}

const references = [
  { bytes: Buffer.from("first"), mimeType: "image/jpeg", filename: "first.jpg", role: "product" },
  { bytes: Buffer.from("second"), mimeType: "image/webp", filename: "second.webp", role: "reference" },
];

test("detects the image protocol from official hosts or model IDs, with Gemini first", () => {
  for (const [baseUrl, model, protocol] of [
    [workspace, qwen, "dashscope-images"],
    [workspace, "model-alias", "dashscope-images"],
    ["https://dashscope.aliyuncs.com/compatible-mode/v1", "alias", "dashscope-images"],
    ["https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "alias", "dashscope-images"],
    ["https://dashscope.cn-beijing.aliyuncs.com/compatible-mode/v1", "alias", "dashscope-images"],
    [proxy, "vendor/QWEN-IMAGE-2.1-PRO", "dashscope-images"],
    [proxy, "wan2.6-image", "dashscope-images"],
    [proxy, "wanx2.1-t2i-turbo", "dashscope-images"],
    [workspace, "gemini-3-pro-image-preview", "gemini-generate-content"],
    [proxy, gemini, "gemini-generate-content"],
    [proxy, "nano-banana-pro", "gemini-generate-content"],
    [proxy, "NanoBanana", "gemini-generate-content"],
    ["https://generativelanguage.googleapis.com/v1beta", qwen, "gemini-generate-content"],
    ["https://omyai.vip/v1", "gpt-image-2.5-flare-special", "openai-images-edits"],
    ["https://dashscope.aliyuncs.com.example.test", "alias", "openai-images-edits"],
    ["https://example.test/generativelanguage.googleapis.com", "gemini-3-pro", "openai-images-edits"],
  ]) {
    assert.equal(detectImageProtocol(baseUrl, model), protocol, `${baseUrl} ${model}`);
  }
});

test("Qwen and Gemini default to pixel sizes to retain the requested aspect ratio", () => {
  const qwenOptions = defaultImageOptions(qwen);
  assert.deepEqual(qwenOptions.sizes, ["1K", "2K"]);
  assert.equal(resolveImageSize("1K", "9:16", qwenOptions.sizeMode), "1024x1824");
  for (const model of [gemini, "nano-banana-pro"]) {
    assert.deepEqual(defaultImageOptions(model), {
      sizes: ["1K", "2K", "4K"], sizeMode: "pixels",
      aspectRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
    });
  }
});

test("DashScope text-to-image converts the stored 1K tier and downloads the URL result", async (t) => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
  let signal: AbortSignal | null | undefined;
  const fetcher = t.mock.method(globalThis, "fetch", async (url, init: RequestInit) => {
    if (init.method === "POST") {
      assert.equal(String(url), workspace + "/images/generations");
      assert.deepEqual(jsonBody(init), { model: qwen, prompt: "保留商品", n: 1, size: "1024x1024" });
      signal = init.signal;
      return Response.json({ created: 0, data: [{ url: cdnUrl }], usage: { width: 1024, height: 1024, image_count: 1 } });
    }
    assert.equal(String(url), cdnUrl);
    assert.equal(init.signal, signal);
    assert.equal(new Headers(init.headers).has("authorization"), false);
    return new Response(png);
  });
  const provider = new GptImageProvider(workspace, key);
  assert.deepEqual(await provider.edit(request({ image: Buffer.alloc(0) })), { bytes: png, mimeType: "image/png" });
  assert.equal(fetcher.mock.callCount(), 2);
});

test("DashScope sends one legacy reference or all ordered references and accepts b64_json", async (t) => {
  const bodies: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (url, init: RequestInit) => {
    assert.equal(String(url), proxy + "/v1/images/generations");
    bodies.push(jsonBody(init));
    return Response.json({ data: [{ b64_json: b64 }] });
  });
  for (const [baseUrl, input] of [[proxy, request()], [proxy + "/v1/", request({ images: references })]] as const) {
    assert.deepEqual(await new GptImageProvider(baseUrl, key).edit(input), { bytes: generated, mimeType: "image/png" });
  }
  const fields = { model: qwen, prompt: "保留商品", n: 1, size: "1024x1024" };
  assert.deepEqual(bodies, [
    { ...fields, image: [`data:image/png;base64,${source.toString("base64")}`] },
    { ...fields, image: references.map(({ bytes, mimeType }) => `data:${mimeType};base64,${bytes.toString("base64")}`) },
  ]);
});

test("DashScope caps tiers and pixel area, rounds resized edges down to multiples of 16, and rejects an eleventh reference", async (t) => {
  const bodies: Array<{ size: string; image: string[] }> = [];
  const fetcher = t.mock.method(globalThis, "fetch", async (_url, init: RequestInit) => {
    bodies.push(jsonBody(init));
    return Response.json({ data: [{ b64_json: b64 }] });
  });
  const provider = new GptImageProvider(workspace, key);
  const images = Array.from({ length: 10 }, (_, i) => ({ ...references[0], bytes: Buffer.from([i]) }));
  for (const size of ["2K", "4K", "512X1536", "4096x2048"]) await provider.edit(request({ size, images }));
  assert.deepEqual(bodies.map(({ size }) => size), ["2048x2048", "2048x2048", "512x1536", "2896x1440"]);
  assert.deepEqual(bodies[0].image, images.map(({ bytes }) => `data:image/jpeg;base64,${bytes.toString("base64")}`));
  await assert.rejects(provider.edit(request({ images: [...images, references[1]] })), { message: "IMAGE_REFERENCE_LIMIT_EXCEEDED" });
  await assert.rejects(provider.edit(request({ size: "auto" })), { message: "IMAGE_SIZE_UNSUPPORTED" });
  assert.equal(fetcher.mock.callCount(), 4);
});

test("a DashScope 404 archives the empty response and logs http_status without an error body", async (t) => {
  const archive = await captureImageArchive(t);
  const log = captureImageLog(t);
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 404 }));
  const requestId = "dashscope-404";
  await assert.rejects(new GptImageProvider(workspace, key).edit(request({ requestId })), { message: "IMAGE_PROVIDER_FAILED" });
  const event = log(requestId);
  assert.equal(event.event, "image.failed");
  assert.equal(event.http_status, 404);
  assert.equal(event.provider, "dashscope-image");
  assert.equal(event.endpoint, workspace + "/images/generations");
  assert.equal(event.error_code, "IMAGE_PROVIDER_FAILED");
  assert.equal(Object.hasOwn(event, "errorBody"), false);
  const storedRequest = await archive(requestId, "request");
  assert.equal(storedRequest.provider, "dashscope-image");
  assert.equal(storedRequest.request.endpoint, workspace + "/images/generations");
  assert.deepEqual((await archive(requestId, "response")).response, { httpStatus: 404, errorBody: "" });
});

test("Gemini uses the channel origin, sends text before images, and reads either inline casing", async (t) => {
  const model = "vendor/" + gemini;
  const inlineParts = [
    { inline_data: { mime_type: "image/webp", data: b64 } },
    { inlineData: { mimeType: "image/jpeg", data: b64 } },
    { inlineData: { data: b64 } },
    { inlineData: { mime_type: "image/gif", data: b64 } },
  ];
  let index = 0;
  t.mock.method(globalThis, "fetch", async (url, init: RequestInit) => {
    assert.equal(String(url), `${proxy}/v1beta/models/${encodeURIComponent(model)}:generateContent`);
    assert.equal(new Headers(init.headers).get("x-goog-api-key"), key);
    assert.deepEqual(jsonBody(init), {
      contents: [{ role: "user", parts: [
        { text: "保留商品" },
        ...references.map(({ bytes, mimeType }) => ({ inline_data: { mime_type: mimeType, data: bytes.toString("base64") } })),
      ] }],
      generationConfig: { responseModalities: ["IMAGE"], imageConfig: { imageSize: "1K" } },
    });
    return Response.json({ candidates: [{ content: { parts: [{ text: "result" }, inlineParts[index++]] } }] });
  });
  for (const [path, mimeType] of [["", "image/webp"], ["/v1", "image/jpeg"], ["/v1beta", "image/png"], ["/v1beta/", "image/gif"]]) {
    const provider = new GptImageProvider(proxy + path, key);
    assert.deepEqual(await provider.edit(request({ model, images: references })), { bytes: generated, mimeType });
  }
  assert.equal(index, inlineParts.length);
});

test("Gemini strips only the final version path and removes the leading models/ prefix", () => {
  for (const suffix of ["", "/", "/v1", "/v1beta/", "/v1beta/openai/"]) {
    const base = new URL(proxy + "/v1/gemini" + suffix);
    const endpoint = imageEndpoint("gemini-generate-content", base, "models/" + gemini);
    assert.equal(endpoint.href, `${proxy}/v1/gemini/v1beta/models/${gemini}:generateContent`, base.href);
  }
  const base = new URL(proxy + "/v1beta/openai");
  const endpoint = imageEndpoint("gemini-generate-content", base, "Models/vendor/" + gemini);
  assert.equal(endpoint.href, `${proxy}/v1beta/models/vendor%2F${gemini}:generateContent`);
});

test("official Gemini uses only the API key header and never falls back from a 404", async (t) => {
  const log = captureImageLog(t);
  const url = "https://GENERATIVELANGUAGE.GOOGLEAPIS.COM./v1beta";
  const requestId = "official-gemini-404";
  const fetcher = t.mock.method(globalThis, "fetch", async (_url: URL, init: RequestInit) => {
    assert.equal(String(_url), `https://generativelanguage.googleapis.com./v1beta/models/${gemini}:generateContent`);
    assert.deepEqual(Object.fromEntries(new Headers(init.headers)), { "content-type": "application/json", "x-goog-api-key": key });
    return new Response(null, { status: 404 });
  });
  await assert.rejects(new GptImageProvider(url, key).edit(request({ model: gemini, requestId })), { message: "IMAGE_PROVIDER_FAILED" });
  assert.equal(fetcher.mock.callCount(), 1);
  const event = log(requestId);
  assert.equal(event.http_status, 404);
  assert.equal(event.provider, "gemini-image");
  assert.equal(Object.hasOwn(event, "fallbackFromHttpStatus"), false);
});

test("Gemini relay falls back on 404 to multipart edits and reports the actual provider and status", async (t) => {
  const archive = await captureImageArchive(t);
  const log = captureImageLog(t);
  const model = "gemini-3-pro-image-preview";
  const requestId = "gemini-relay-fallback-success";
  const editsEndpoint = yunfei + "/v1/images/edits";
  let signal: AbortSignal | null | undefined;
  let firstBodyCancelled = false;
  const fetcher = t.mock.method(globalThis, "fetch", async (url, init: RequestInit) => {
    if (String(url) === `${yunfei}/v1beta/models/${model}:generateContent`) {
      assert.equal(new Headers(init.headers).get("x-goog-api-key"), key);
      assert.equal(jsonBody(init).contents[0].role, "user");
      signal = init.signal;
      return new Response(new ReadableStream({ cancel() { firstBodyCancelled = true; } }), { status: 404 });
    }
    assert.equal(String(url), editsEndpoint);
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.deepEqual(init.headers, { authorization: `Bearer ${key}` });
    assert.ok(signal);
    assert.equal(init.signal, signal);
    const form = init.body as FormData;
    assert.deepEqual([...form.keys()], ["model", "image", "image", "prompt", "size", "quality", "n", "response_format"]);
    assert.deepEqual(form.getAll("image").map((image) => (image as File).name), ["first.jpg", "second.webp"]);
    for (const [name, value] of Object.entries({ model, prompt: "保留商品", size: "1024x1824", quality: "medium", n: "1", response_format: "b64_json" })) {
      assert.equal(form.get(name), value);
    }
    return Response.json({ data: [{ b64_json: b64 }] }, { status: 201 });
  });
  const provider = new GptImageProvider(yunfei + "/v1", key);
  assert.deepEqual(await provider.edit(request({ model, requestId, size: "1024x1824", images: references })), { bytes: generated, mimeType: "image/png" });
  assert.equal(fetcher.mock.callCount(), 2);
  assert.equal(firstBodyCancelled, true);
  const event = log(requestId);
  assert.equal(event.event, "image.completed");
  assert.equal(event.provider, "openai-compatible-image");
  assert.equal(event.endpoint, editsEndpoint);
  assert.equal(event.fallbackFromProvider, "gemini-image");
  assert.equal(event.fallbackFromHttpStatus, 404);
  assert.equal(event.http_status, 201);
  assert.equal(event.responseFormatUsed, "b64_json");
  assert.equal((await archive(requestId, "request")).provider, "gemini-image");
  assert.deepEqual((await archive(requestId, "response")).response, {
    provider: "openai-compatible-image", endpoint: editsEndpoint, fallbackFromProvider: "gemini-image", fallbackFromHttpStatus: 404,
    httpStatus: 201, dataCount: 1, responseFormatUsed: "b64_json", mimeType: "image/png", byteLength: generated.length,
  });
});

test("Gemini relay errors other than 404 keep their status and never fall back", async (t) => {
  const log = captureImageLog(t);
  const statuses = [400, 401, 403, 429, 500];
  let index = 0;
  const fetcher = t.mock.method(globalThis, "fetch", async (url: URL) => {
    assert.equal(String(url), `${yunfei}/v1beta/models/${gemini}:generateContent`);
    return new Response(null, { status: statuses[index++] });
  });
  const provider = new GptImageProvider(yunfei + "/v1", key);
  for (const [i, status] of statuses.entries()) {
    const requestId = `gemini-relay-${status}`;
    await assert.rejects(provider.edit(request({ model: gemini, requestId })), { message: "IMAGE_PROVIDER_FAILED" });
    assert.equal(fetcher.mock.callCount(), i + 1);
    const event = log(requestId);
    assert.equal(event.event, "image.failed");
    assert.equal(event.http_status, status);
    assert.equal(event.provider, "gemini-image");
    assert.equal(Object.hasOwn(event, "fallbackFromHttpStatus"), false);
  }
});

test("Gemini relay archives and logs the final failure after falling back", async (t) => {
  const archive = await captureImageArchive(t);
  const log = captureImageLog(t);
  const requestId = "gemini-relay-fallback-failure";
  const editsEndpoint = yunfei + "/v1/images/edits";
  const fetcher = t.mock.method(globalThis, "fetch", async (url: URL) =>
    String(url) === editsEndpoint ? new Response(`unsupported size for ${key}`, { status: 400 }) : new Response("discarded first response", { status: 404 }));
  const provider = new GptImageProvider(yunfei + "/v1", key);
  await assert.rejects(provider.edit(request({ model: gemini, requestId })), { message: "IMAGE_SIZE_UNSUPPORTED" });
  assert.equal(fetcher.mock.callCount(), 2);
  const event = log(requestId);
  assert.equal(event.event, "image.failed");
  assert.equal(event.http_status, 400);
  assert.equal(event.provider, "openai-compatible-image");
  assert.equal(event.endpoint, editsEndpoint);
  assert.equal(event.fallbackFromHttpStatus, 404);
  assert.equal(event.error_code, "IMAGE_SIZE_UNSUPPORTED");
  assert.equal(Object.hasOwn(event, "errorBody"), false);
  assert.deepEqual((await archive(requestId, "response")).response, {
    provider: "openai-compatible-image", endpoint: editsEndpoint, fallbackFromProvider: "gemini-image", fallbackFromHttpStatus: 404,
    httpStatus: 400, errorBody: "unsupported size for [REDACTED]",
  });
});

test("Gemini relay does not fall back from a network error or timeout", async (t) => {
  const failedFetch = t.mock.method(globalThis, "fetch", async () => { throw new TypeError("network error"); });
  const provider = new GptImageProvider(yunfei + "/v1", key, 25);
  await assert.rejects(provider.edit(request({ model: gemini })), { message: "IMAGE_PROVIDER_FAILED" });
  assert.equal(failedFetch.mock.callCount(), 1);
  failedFetch.mock.restore();
  const timedOutFetch = t.mock.method(globalThis, "fetch", async (_url, init: RequestInit) => {
    const signal = init.signal!;
    signal.throwIfAborted();
    return new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  await assert.rejects(provider.edit(request({ model: gemini })), { message: "IMAGE_PROVIDER_TIMEOUT" });
  assert.equal(timedOutFetch.mock.callCount(), 1);
});

test("a failed URL download after Gemini fallback preserves ImageUrlDownloadError", async (t) => {
  const log = captureImageLog(t);
  const requestId = "gemini-relay-fallback-download";
  const fetcher = t.mock.method(globalThis, "fetch", async (url: URL) =>
    String(url).endsWith("/images/edits")
      ? Response.json({ data: [{ url: "file:///private/output.png" }] })
      : new Response(null, { status: 404 }));
  const provider = new GptImageProvider(yunfei + "/v1", key);
  await assert.rejects(provider.edit(request({ model: gemini, requestId })), (error: unknown) =>
    error instanceof ImageUrlDownloadError && error.message === "INVALID_PROVIDER_RESPONSE");
  assert.equal(fetcher.mock.callCount(), 2);
  const event = log(requestId);
  assert.equal(event.provider, "openai-compatible-image");
  assert.equal(event.http_status, 200);
  assert.equal(event.fallbackFromHttpStatus, 404);
  assert.equal(event.responseFormatUsed, "url");
});

test("Gemini maps tiers and the nearest aspect ratio for native and workbench pixel sizes", async (t) => {
  const configs: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (_url, init: RequestInit) => {
    configs.push(jsonBody(init).generationConfig.imageConfig);
    return Response.json({ candidates: [{ content: { parts: [{ inlineData: { data: b64 } }] } }] });
  });
  const provider = new GptImageProvider(proxy, key);
  const cases: ReadonlyArray<readonly [size: string, aspectRatio: string | undefined, imageSize: string]> = [
    ["1K", undefined, "1K"], ["2K", undefined, "2K"], ["4K", undefined, "4K"], ["850x1250", "2:3", "1K"],
    ["2752x1536", "16:9", "2K"], ["3168x1344", "21:9", "2K"], ["6336x2688", "21:9", "4K"],
    ...defaultImageOptions(gemini).aspectRatios.flatMap((ratio) =>
      ["1K", "2K", "4K"].map((tier) => [resolveImageSize(tier, ratio, "pixels"), ratio, tier] as const)),
  ];
  for (const [size] of cases) await provider.edit(request({ model: gemini, size }));
  assert.deepEqual(configs, cases.map(([, aspectRatio, imageSize]) => ({ imageSize, ...(aspectRatio && { aspectRatio }) })));
});

test("Gemini downloads file_data and fileData and shares the URL retry and error handling", async (t) => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "blue" } }).png().toBuffer();
  let posts = 0;
  let gets = 0;
  t.mock.method(globalThis, "fetch", async (url, init: RequestInit) => {
    if (init.method === "POST") {
      const part = posts++ === 0 ? { file_data: { file_uri: cdnUrl } } : { fileData: { fileUri: cdnUrl } };
      return Response.json({ candidates: [{ content: { parts: [{ text: "result" }, part] } }] });
    }
    assert.equal(String(url), cdnUrl);
    assert.equal(new Headers(init.headers).has("x-goog-api-key"), false);
    return ++gets === 2 ? new Response(png) : new Response(null, { status: 503 });
  });
  const provider = new GptImageProvider(proxy, key);
  assert.deepEqual(await provider.edit(request({ model: gemini })), { bytes: png, mimeType: "image/png" });
  await assert.rejects(provider.edit(request({ model: gemini })), (error: unknown) =>
    error instanceof ImageUrlDownloadError && error.message === "IMAGE_PROVIDER_FAILED");
  assert.deepEqual([posts, gets], [2, 4]);
});

test("DashScope and Gemini reject an actual mask before sending a request", async (t) => {
  const fetcher = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected fetch"); });
  const provider = new GptImageProvider(proxy, key);
  for (const model of [qwen, gemini]) {
    await assert.rejects(provider.edit(request({ model, mask: Buffer.from("mask") })), { message: "IMAGE_MASK_UNSUPPORTED" });
  }
  assert.match(errorMessages.IMAGE_MASK_UNSUPPORTED, /当前生图渠道不支持蒙版/);
  assert.equal(fetcher.mock.callCount(), 0);
});

test("OpenAI edits keeps the existing multipart fields, ordering, and mask", async (t) => {
  const fetcher = t.mock.method(globalThis, "fetch", async (url, init: RequestInit) => {
    assert.equal(String(url), proxy + "/v1/images/edits");
    assert.equal(init.method, "POST");
    assert.deepEqual(init.headers, { authorization: `Bearer ${key}` });
    const form = init.body as FormData;
    assert.deepEqual([...form.keys()], ["model", "image", "image", "mask", "prompt", "size", "quality", "n", "response_format"]);
    assert.deepEqual(form.getAll("image").map((image) => (image as File).name), ["first.jpg", "second.webp"]);
    assert.equal(await (form.get("mask") as File).text(), "mask");
    assert.equal(form.get("model"), "gpt-image-2");
    assert.equal(form.get("prompt"), "保留商品");
    assert.equal(form.get("size"), "4096x2048");
    assert.equal(form.get("quality"), "medium");
    assert.equal(form.get("n"), "1");
    assert.equal(form.get("response_format"), "b64_json");
    return Response.json({ data: [{ b64_json: b64 }] });
  });
  const provider = new GptImageProvider(proxy, key);
  assert.deepEqual(await provider.edit(request({
    model: "gpt-image-2", images: references, mask: Buffer.from("mask"), size: "4096x2048",
  })), { bytes: generated, mimeType: "image/png" });
  assert.equal(fetcher.mock.callCount(), 1);
});
