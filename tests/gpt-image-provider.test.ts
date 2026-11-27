import assert from "node:assert/strict";
import dns from "node:dns";
import { createServer } from "node:http";
import net from "node:net";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { GptImageProvider } from "../server/providers/gpt-image-provider.js";
import { createImageUrlDispatcher, downloadImageUrl } from "../server/providers/download-image-url.js";
import type { ImageEditRequest } from "../server/types.js";

const request = (requestId: string): ImageEditRequest => ({ requestId, endpoint: "/v1/images/edits", image: Buffer.from("source"), imageMimeType: "image/png", imageFilename: "source.png", model: "gpt-image-2", prompt: "保留商品", size: "2048x3072", quality: "medium", n: 1, responseFormat: "b64_json" });

function captureLogs(t: TestContext) {
  const output = t.mock.method(process.stdout, "write");
  return () => output.mock.calls.map((call) => call.arguments[0]).filter((chunk) => typeof chunk === "string").join("");
}

test("provider maps conservative size errors, bounds response reads, and redacts credentials from archives and logs", async (t) => {
  const apiKey = "unit-test-api-key-private";
  const requestId = "size-error-" + randomUUID();
  const logs = captureLogs(t);
  let cancelled = false;
  const body = new TextEncoder().encode(JSON.stringify({ error: { message: "resolution not supported for group", api_key: apiKey, authorization: "Bearer another-secret", url: "https://cdn.example.test/image?signature=reflected-secret" } }) + " ".repeat(3000));
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
  assert.match(logs(), /image.failed/);
  assert.doesNotMatch(archive + logs(), /unit-test-api-key-private|another-secret|reflected-secret/);
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

test("redacts reflected Google keys and x-goog-api-key header values", async (t) => {
  const requestId = "google-key-error-" + randomUUID();
  const reflectedKey = "AIza" + "Ab1-".repeat(9);
  const logs = captureLogs(t);
  const response = {
    message: "Rejected upstream key " + reflectedKey,
    "X-Goog-Api-Key": 'proxy-token"with-escaped-content',
  };
  t.mock.method(globalThis, "fetch", async () => Response.json(response, { status: 401 }));
  const provider = new GptImageProvider("https://example.test/v1beta", "channel-key");
  await assert.rejects(provider.edit({ ...request(requestId), model: "gemini-3-pro-image-preview", size: "1K" }), { message: "IMAGE_PROVIDER_FAILED" });
  const file = (await readdir("var/model-archives", { recursive: true })).find((file) => file.includes(requestId) && file.endsWith("_response.json"))!;
  const errorBody = JSON.parse(await readFile("var/model-archives/" + file, "utf8")).response.errorBody;
  assert.deepEqual(JSON.parse(errorBody), {
    message: "Rejected upstream key [REDACTED]",
    "X-Goog-Api-Key": "[REDACTED]",
  });
  assert.doesNotMatch(logs(), /AIza|proxy-token|with-escaped-content/);
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

const signedUrl = "https://cdn.example.test/output?signature=temporary-secret";
const provider = () => new GptImageProvider("https://example.test/v1", "channel-key");

test("prefers base64 when both response formats are present", async (t) => {
  const bytes = Buffer.from("legacy base64 result");
  const fetcher = t.mock.method(globalThis, "fetch", async () => Response.json({ data: [{ b64_json: bytes.toString("base64"), url: signedUrl }] }));
  assert.deepEqual(await provider().edit(request(randomUUID())), { bytes, mimeType: "image/png" });
  assert.equal(fetcher.mock.callCount(), 1);
});

test("downloads PNG, JPEG and WebP and archives their bytes without recording signed URLs", async (t) => {
  const logs = captureLogs(t);
  for (const format of ["png", "jpeg", "webp"] as const) {
    const mimeType = "image/" + format;
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).toFormat(format).toBuffer();
    const id = randomUUID();
    let signal: AbortSignal | null | undefined;
    const fetcher = t.mock.method(globalThis, "fetch", async (url, init: RequestInit) => {
      if (init.method === "POST") {
        assert.equal((init.body as FormData).get("response_format"), "b64_json");
        signal = init.signal;
        return Response.json({ data: [{ b64_json: "", url: signedUrl }] });
      }
      assert.equal(String(url), signedUrl);
      assert.equal(init.redirect, "error");
      assert.ok(signal);
      assert.equal(init.signal, signal);
      assert.equal(new Headers(init.headers).has("authorization"), false);
      return new Response(bytes, { headers: { "content-type": format === "webp" ? "application/octet-stream" : mimeType } });
    });
    assert.deepEqual(await provider().edit(request(id)), { bytes, mimeType });
    fetcher.mock.restore();
    const files = (await readdir("var/model-archives", { recursive: true })).filter((file) => file.includes(id));
    const metadata = await Promise.all(files.filter((file) => file.endsWith(".json")).map((file) => readFile("var/model-archives/" + file, "utf8")));
    const response = JSON.parse(metadata.find((file) => file.includes('"responseFormatUsed"'))!);
    assert.equal(response.response.responseFormatUsed, "url");
    assert.equal(response.response.mimeType, mimeType);
    const output = files.find((file) => file.endsWith(response.files[0].file));
    assert.ok(output?.endsWith(format === "jpeg" ? ".jpg" : "." + format));
    assert.deepEqual(await readFile("var/model-archives/" + output), bytes);
    assert.doesNotMatch(metadata.join("") + logs(), /cdn\.example|signature|temporary-secret/);
  }
  assert.match(logs(), /"responseFormatUsed":"url"/);
});

test("rejects unsafe download URLs before issuing a second request", async (t) => {
  for (const url of [
    "nonsense", "file:///tmp/image.png", "https://user:secret@cdn.example.test/x",
    ...["localhost", "sub.localhost.", "cache.local", "127.1", "0.0.0.0", "10.1.2.3", "172.31.1.2",
      "192.168.1.1", "169.254.1.1", "[::]", "[::1]", "[fc00::1]", "[fe80::1]", "[::ffff:127.0.0.1]"].map(host => "http://" + host),
  ]) {
    const fetcher = t.mock.method(globalThis, "fetch", async () => Response.json({ data: [{ url }] }));
    await assert.rejects(provider().edit(request(randomUUID())), { message: "INVALID_PROVIDER_RESPONSE" });
    assert.equal(fetcher.mock.callCount(), 1, url);
    fetcher.mock.restore();
  }
});

test("checks every DNS answer in the actual download connection", async (t) => {
  const lookup = t.mock.method(dns, "lookup", (host, options, callback) => {
    assert.equal(host, "cdn.example.test");
    assert.equal(options.all, true);
    callback(null, [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }]);
  });
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (url, init) =>
    init.method === "POST" ? Response.json({ data: [{ url: signedUrl }] }) : fetch(url, init));
  await assert.rejects(provider().edit(request(randomUUID())), { message: "INVALID_PROVIDER_RESPONSE" });
  assert.equal(lookup.mock.callCount(), 1);
});

test("the download socket accepts public DNS and a detected TUN pool, excluding local endpoints and IP literals", async (t) => {
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "navy" } }).png().toBuffer();
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.writeHead(200, { "content-type": "image/png" }).end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as net.AddressInfo;
  // Simulate only the TUN's routing: let the real Agent and socket run their lookup,
  // then deliver accepted connections to our local HTTP server instead of the network.
  const connect = net.connect;
  const accepted: string[] = [];
  t.mock.method(net, "connect", (options) => {
    assert.equal(options.host, "images.example.test");
    return connect({
      ...options,
      lookup(hostname, flags, callback) {
        options.lookup(hostname, flags, (error, result) => {
          if (error) return callback(error);
          accepted.push(...(flags.all ? result.map((entry: dns.LookupAddress) => entry.address) : [result]));
          if (flags.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
          else callback(null, "127.0.0.1", 4);
        });
      },
    });
  });

  const tun = { address: "198.18.0.1", family: "IPv4" as const, internal: false, cidr: "198.18.0.1/15", mac: "", netmask: "255.254.0.0" };
  async function check(address: string, dnsServers: string[], hasTun: boolean, allowed: boolean, literal = false) {
    let lookups = 0;
    const before = requests;
    const dispatcher = createImageUrlDispatcher({
      dnsLookup(hostname, callback) {
        assert.equal(hostname, "images.example.test");
        lookups++;
        callback(null, [{ address, family: net.isIP(address) }]);
      },
      getDnsServers: () => dnsServers,
      getNetworkInterfaces: () => hasTun ? { utun6: [tun] } : {},
    });
    try {
      const download = downloadImageUrl(`http://${literal ? address : "images.example.test"}:${port}/img.png`, AbortSignal.timeout(3000), dispatcher);
      if (allowed) {
        assert.deepEqual(await download, { bytes, mimeType: "image/png" });
        assert.equal(accepted.pop(), address);
      } else {
        await assert.rejects(download, { message: "INVALID_PROVIDER_RESPONSE" }, address);
      }
      assert.equal(lookups, literal ? 0 : 1);
      assert.equal(requests, before + Number(allowed));
    } finally {
      await dispatcher.close();
    }
  }
  const publicDns = ["8.8.8.8"];
  const tunDns = ["198.18.0.2:53"];
  await check("8.8.4.4", publicDns, false, true);
  await check("198.18.0.125", publicDns, false, false);
  await check("198.18.0.125", tunDns, false, true);
  await check("198.18.0.125", tunDns, true, true);
  await check("198.19.0.125", publicDns, true, true);
  for (const address of ["198.18.0.1", "198.18.0.2", "198.18.0.0", "198.19.255.255",
    "10.0.0.1", "127.0.0.1", "172.16.0.1", "192.168.0.1", "169.254.1.1", "100.64.0.1", "::1", "fe80::1", "fc00::1"]) {
    await check(address, tunDns, true, false);
  }
  await check("198.18.0.125", tunDns, true, false, true);
});

test("a temporary CDN failure retries only the same image GET", async (t) => {
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
  let posts = 0;
  let gets = 0;
  t.mock.method(globalThis, "fetch", async (url, init: RequestInit) => {
    if (init.method === "POST") {
      posts++;
      return Response.json({ data: [{ url: signedUrl }] });
    }
    assert.equal(String(url), signedUrl);
    assert.equal(init.method ?? "GET", "GET");
    return ++gets === 1 ? new Response(null, { status: 503 }) : new Response(bytes);
  });
  assert.deepEqual(await provider().edit(request(randomUUID())), { bytes, mimeType: "image/png" });
  assert.deepEqual([posts, gets], [1, 2]);
});

test("the provider deadline cancels the delay before a second GET", async (t) => {
  const fetcher = t.mock.method(globalThis, "fetch", async (_url, init: RequestInit) =>
    init.method === "POST" ? Response.json({ data: [{ url: signedUrl }] }) : new Response(null, { status: 503 }));
  await assert.rejects(new GptImageProvider("https://example.test/v1", "channel-key", 25).edit(request(randomUUID())), {
    message: "IMAGE_PROVIDER_TIMEOUT",
  });
  assert.equal(fetcher.mock.callCount(), 2);
});

test("a download that stalls is cancelled by the provider deadline and archived without the signed URL", async (t) => {
  const id = randomUUID();
  const logs = captureLogs(t);
  t.mock.method(globalThis, "fetch", async (_url, init: RequestInit) => {
    if (init.method === "POST") return Response.json({ data: [{ url: signedUrl }] });
    const signal = init.signal!;
    signal.throwIfAborted();
    return new Promise<Response>((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("Download interrupted at " + signedUrl)), { once: true });
    });
  });
  await assert.rejects(new GptImageProvider("https://example.test/v1", "channel-key", 25).edit(request(id)), { message: "IMAGE_PROVIDER_TIMEOUT" });
  const files = await readdir("var/model-archives", { recursive: true });
  const file = files.find((entry) => entry.includes(id) && entry.endsWith("_response.json"));
  assert.ok(file);
  const archive = await readFile("var/model-archives/" + file, "utf8");
  assert.equal(JSON.parse(archive).response.responseFormatUsed, "url");
  assert.match(logs(), /"responseFormatUsed":"url"/);
  assert.doesNotMatch(archive + logs(), /cdn\.example|signature|temporary-secret/);
});

test("rejects failed, empty, mislabeled and oversized downloads, including streamed overflow", async (t) => {
  const maxBytes = 32 * 1024 * 1024;
  const block = new Uint8Array(1024 * 1024);
  let cancelled = false;
  const oversizedStream = new ReadableStream({ pull(controller) { controller.enqueue(block); }, cancel() { cancelled = true; } });
  for (const [response, message] of [
    [new Response("upstream failed", { status: 503 }), "IMAGE_PROVIDER_FAILED"],
    [new Response(null, { status: 302, headers: { location: "http://localhost/image" } }), "IMAGE_PROVIDER_FAILED"],
    [new Response(null), "INVALID_PROVIDER_RESPONSE"],
    [new Response("<html>error</html>", { headers: { "content-type": "image/png" } }), "INVALID_PROVIDER_RESPONSE"],
    [new Response(Buffer.from("89504e470d0a1a0a", "hex"), { headers: { "content-type": "image/webp" } }), "INVALID_PROVIDER_RESPONSE"],
    [new Response(null, { headers: { "content-length": String(maxBytes + 1) } }), "INVALID_PROVIDER_RESPONSE"],
    [new Response(oversizedStream), "INVALID_PROVIDER_RESPONSE"],
  ] as const) {
    const fetcher = t.mock.method(globalThis, "fetch", async (_url, init) =>
      init.method === "POST" ? Response.json({ data: [{ url: signedUrl }] }) : response);
    await assert.rejects(provider().edit(request(randomUUID())), { message });
    fetcher.mock.restore();
  }
  assert.ok(cancelled, "stream must be cancelled as soon as it exceeds the budget");
});
