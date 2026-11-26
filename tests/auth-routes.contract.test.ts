import assert from "node:assert/strict";
import test from "node:test";
import { createSuiteStudioApp, type AppResponse } from "../server/app.js";
import { AuthService, loadAuthServiceOptionsFromEnv } from "../server/auth/auth-service.js";
import { authRequestMeta, trustProxyFromEnv, type ConnectionMeta } from "../server/auth/request-meta.js";
import { dispatchJsonRequest } from "../server/http/json-request.js";
import { createImageEditorApi } from "../server/image-editor-api.js";
import { ImageEditorService, MemoryImageEditorRepository } from "../server/image-editor.js";
import { dispatchInputImageUpload } from "../server/multipart.js";
import { MemoryAuthRepository } from "../server/repositories/memory-auth-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const listingUpload = "/api/listing-copies/draft/input-images";
const editorUpload = "/api/image-editor/sessions/parent/versions/source/restore-inputs";
const credentials = { username: "admin", password: "fixture password", captchaCode: "AB2Z" };
const anonymous = { authEnabled: true, authenticated: false, user: null };

function studio(authService?: AuthService) {
  const storage = new MemoryStorage();
  const editor = new ImageEditorService(new MemoryImageEditorRepository(), async () => null, storage, async () => null);
  return createSuiteStudioApp({
    repository: new MemorySuiteRepository(), storage, imageEditorApi: createImageEditorApi(editor), authService, trustProxy: "auto",
  });
}

function assertError(response: AppResponse | null, status: number, code: string) {
  assert.ok(response);
  assert.equal(response.status, status);
  assert.equal("error" in response.body && response.body.error.code, code);
  assert.equal(response.headers?.["cache-control"], "no-store");
}

function data<T>(response: AppResponse, status = 200) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.ok("data" in response.body);
  return response.body.data as T;
}

async function fixture() {
  let time = Date.UTC(2026, 0, 1);
  const service = new AuthService(new MemoryAuthRepository(), {
    ...loadAuthServiceOptionsFromEnv({}), adminPassword: credentials.password, maxLoginFailures: 1,
    now: () => new Date(time), generateCaptchaCode: () => credentials.captchaCode,
  });
  await service.ensureDefaultAdmin();
  const app = studio(service);
  async function captcha() {
    const response = await app.request("GET", "/api/auth/captcha?refresh=1");
    assert.equal(response.headers?.["cache-control"], "no-store");
    return data<{ captchaId: string }>(response).captchaId;
  }
  function login(body: Record<string, unknown>, headers: Record<string, string> = {}, meta: ConnectionMeta = {}) {
    return dispatchJsonRequest(app.request, "POST", new URL("http://localhost/api/auth/login"), headers,
      Buffer.from(JSON.stringify({ ...credentials, ...body })), meta);
  }
  return { app, captcha, login, advance(ms: number) { time += ms; } };
}

test("without an auth service the offline app stays signed in and business routes stay accessible", async () => {
  const app = studio();
  const session = await app.request("GET", "/api/auth/session");
  assert.deepEqual(data(session), { authEnabled: false, authenticated: true, user: null });
  assert.equal(session.headers?.["cache-control"], "no-store");
  assert.equal((await app.request("GET", "/api/suites")).status, 200);
  assertError(await app.request("GET", "/api/auth/captcha"), 404, "NOT_FOUND");
  assertError(await app.request("POST", "/api/auth/login"), 404, "NOT_FOUND");
  const logout = await app.request("POST", "/api/auth/logout");
  assert.deepEqual(data(logout), { ok: true });
  assert.deepEqual(logout.headers, { "cache-control": "no-store" });
});

test("only exact public auth routes are open, including before multipart parsing and direct file access", async () => {
  const { app } = await fixture();
  const session = await app.request("GET", "/api/auth/session?refresh=1");
  assert.deepEqual(data(session), anonymous);
  assert.equal(session.headers?.["cache-control"], "no-store");
  for (const path of [
    "/api/suites", "/api/platforms", "/api/model-settings", "/api/product-cards", "/api/listing-copies",
    "/api/product-onboarding/sessions", "/api/image-editor/capabilities", "/api/health", "/api/unknown",
    "/api/suites/s/input-images/i/original", "/api/suites/s/input-images/i/preview/original",
    "/api/suites/s/delivery/export", "/api/auth/session/", "/api/auth/session/extra", "/api/auth/login", "/api/auth/logout",
  ]) assertError(await app.request("GET", path), 401, "UNAUTHORIZED");
  for (const path of ["/api/auth/session", "/api/auth/captcha", "/api/model-settings/channels"]) {
    assertError(await app.request("POST", path), 401, "UNAUTHORIZED");
  }
  for (const path of ["/api/suites/s/input-images", listingUpload, editorUpload]) {
    assertError(await dispatchInputImageUpload(app, path, Buffer.alloc(0), {}), 401, "UNAUTHORIZED");
  }
  for (const response of await Promise.all([
    app.upload("s", { filename: "x", bytes: png, mimeType: "image/png" }), app.preview("s", "i", "original"),
    app.previewBaseVersion("s", "i", "v"), app.previewTaskVersion("t", "v", true), app.previewLibraryResource("r"),
    app.previewReverseReference("p", "r"), app.previewReplicaReference("s", "r"),
  ])) assertError(response, 401, "UNAUTHORIZED");
});

test("login rejects invalid, replayed and expired challenges, then limits password failures by direct peer", async () => {
  const { captcha, login, advance } = await fixture();
  const captchaId = await captcha();
  assertError(await login({ captchaId, captchaCode: "wrong" }), 400, "INVALID_CAPTCHA");
  assertError(await login({ captchaId }), 400, "INVALID_CAPTCHA");
  const expired = await captcha();
  advance(180_000);
  assertError(await login({ captchaId: expired }), 400, "CAPTCHA_EXPIRED");
  const peer = { remoteAddress: "203.0.113.23" };
  assertError(await login({ captchaId: await captcha(), password: "wrong" }, { "X-Forwarded-For": "192.0.2.1" }, peer), 401, "INVALID_CREDENTIALS");
  assertError(await login({ captchaId: await captcha(), ipAddress: "192.0.2.2" }, { "X-Forwarded-For": "192.0.2.2" }, peer), 429, "TOO_MANY_LOGIN_ATTEMPTS");
});

test("the session cookie unlocks API reads, three file uploads and the original preview until logout", async () => {
  const { app, captcha, login } = await fixture();
  const peer = { remoteAddress: "203.0.113.24" };
  const result = await login({ captchaId: ` ${await captcha()} `, isSecureRequest: true }, { "X-Forwarded-Proto": "https" }, peer);
  const signedIn = data<{ authenticated: boolean; expiresAt: string; user: { id: string; username: string; role: string } }>(result);
  assert.deepEqual(signedIn, {
    authenticated: true, user: { id: signedIn.user.id, username: "admin", role: "admin" }, expiresAt: "2026-01-08T00:00:00.000Z",
  });
  assert.equal(result.headers?.["cache-control"], "no-store");
  const cookie = result.headers?.["set-cookie"] ?? "";
  assert.match(cookie, /^picagent_session=[a-f0-9]{64}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=604800$/);
  const headers = { cookie: cookie.split(";")[0] };
  const session = await app.request("GET", "/api/auth/session", { headers });
  assert.deepEqual(data(session), { authEnabled: true, ...signedIn });
  assert.equal((await app.request("GET", "/api/suites", { headers })).status, 200);
  const suite = data<{ id: string }>(await app.request("POST", "/api/suites", { headers, body: { name: "test" } }), 201);

  const form = new FormData();
  form.set("file", new Blob([Uint8Array.from(png)], { type: "image/png" }), "product.png");
  const encoded = new Response(form);
  const bytes = Buffer.from(await encoded.arrayBuffer());
  const uploadHeaders = { ...headers, "content-type": encoded.headers.get("content-type")! };
  const suiteUpload = `/api/suites/${suite.id}/input-images`;
  const uploaded = await dispatchInputImageUpload(app, suiteUpload, bytes, uploadHeaders);
  assert.ok(uploaded);
  const { id: imageId } = data<{ id: string }>(uploaded, 201);
  for (const path of [listingUpload, editorUpload]) {
    const response = await dispatchInputImageUpload(app, path, bytes, uploadHeaders);
    assert.ok(response);
    data(response, 201);
  }
  const preview = `${suiteUpload}/${imageId}/original`;
  assert.deepEqual((await app.request("GET", preview, { headers })).raw, png);
  assert.deepEqual((await app.request("GET", `${suiteUpload}/${imageId}/preview/original`, { headers })).raw, png);
  const logout = await app.request("POST", "/api/auth/logout", { headers, encrypted: true });
  assert.deepEqual(data(logout), { ok: true });
  assert.equal(logout.headers?.["cache-control"], "no-store");
  assert.match(logout.headers?.["set-cookie"] ?? "", /^picagent_session=;.*Max-Age=0; Secure$/);
  assert.deepEqual(data(await app.request("GET", "/api/auth/session", { headers })), anonymous);
  assertError(await app.request("GET", "/api/suites", { headers }), 401, "UNAUTHORIZED");
  assertError(await app.request("GET", preview, { headers }), 401, "UNAUTHORIZED");
  for (const path of [suiteUpload, listingUpload, editorUpload]) {
    assertError(await dispatchInputImageUpload(app, path, bytes, uploadHeaders), 401, "UNAUTHORIZED");
  }
});

test("AUTH_TRUST_PROXY decides which peers can supply the client address and HTTPS state", () => {
  const headers = { "X-Forwarded-For": "192.0.2.1, 192.0.2.2", "X-Forwarded-Proto": "https, http", "User-Agent": "test" };
  for (const remoteAddress of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "203.0.113.10", undefined]) {
    for (const setting of ["auto", "true", "false"]) {
      const trusted = setting === "true" || (setting === "auto" && !!remoteAddress && remoteAddress !== "203.0.113.10");
      assert.deepEqual(authRequestMeta(headers, { remoteAddress }, trustProxyFromEnv(setting)), {
        ipAddress: trusted ? "192.0.2.1" : remoteAddress, userAgent: "test", isSecureRequest: trusted,
      });
    }
  }
  assert.equal(authRequestMeta({}, { encrypted: true }, false).isSecureRequest, true);
});
