import assert from "node:assert/strict";
import { createHash, randomUUID, scryptSync } from "node:crypto";
import test from "node:test";
import { AuthService, isSecureRequest, loadAuthServiceOptionsFromEnv, type AuthServiceOptions, type LoginInput } from "../server/auth/auth-service.js";
import { generateCaptchaCode, hashCaptchaCode, renderCaptchaSvg } from "../server/auth/captcha.js";
import { hashPassword, verifyPassword } from "../server/auth/password.js";
import { MemoryAuthRepository } from "../server/repositories/memory-auth-repository.js";

const credentials = { username: "operator", password: "test password", captchaCode: " ab2z ", ipAddress: "127.0.0.1" };
const start = Date.UTC(2026, 0, 1);
const anonymous = { authenticated: false, user: null };
const invalidCaptcha = { ok: false, code: "INVALID_CAPTCHA", status: 400 };
const invalidCredentials = { ok: false, code: "INVALID_CREDENTIALS", status: 401 };
const limited = { ok: false, code: "TOO_MANY_LOGIN_ATTEMPTS", status: 429 };

async function fixture(overrides: Partial<AuthServiceOptions> = {}) {
  let time = start;
  const repo = new MemoryAuthRepository();
  const options = {
    ...loadAuthServiceOptionsFromEnv({}), adminUsername: credentials.username, adminPassword: credentials.password,
    now: () => new Date(time), generateCaptchaCode: () => "AB2Z", ...overrides,
  };
  const service = new AuthService(repo, options);
  await service.ensureDefaultAdmin();
  async function login(input: LoginInput = {}) {
    const { captchaId } = await service.createCaptcha();
    return service.login({ ...credentials, captchaId, ...input });
  }
  return { repo, service, options, login, advance(ms: number) { time += ms; } };
}

test("passwords use a fresh 16-byte salt and strictly validate the scrypt encoding", () => {
  const hash = hashPassword("secret");
  assert.match(hash, /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
  const [, salt, key] = hash.split("$");
  assert.equal(scryptSync("secret", Buffer.from(salt, "hex"), 64).toString("hex"), key);
  assert.notEqual(hashPassword("secret"), hash);
  assert.ok(verifyPassword("secret", hash));
  assert.equal(verifyPassword("wrong", hash), false);
  for (const invalid of ["", hash.slice(1), hash.slice(0, -1), hash + "00", hash + "$", hash + "\n", hash.replace(salt, "g".repeat(32))]) {
    assert.equal(verifyPassword("secret", invalid), false);
  }
});

test("captcha codes use the configured alphabet, hash the challenge ID and render four SVG glyphs", () => {
  for (let i = 0; i < 32; i++) assert.match(generateCaptchaCode(), /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/);
  assert.equal(hashCaptchaCode("id", " ab2z "), createHash("sha256").update("id:AB2Z").digest("hex"));
  assert.notEqual(hashCaptchaCode("id", "AB2Z"), hashCaptchaCode("other", "AB2Z"));
  const url = renderCaptchaSvg("AB2Z");
  assert.match(url, /^data:image\/svg\+xml;base64,/);
  const svg = Buffer.from(url.split(",")[1], "base64").toString();
  assert.match(svg, /width="128" height="44"/);
  assert.match(svg, /#F4F4F5/);
  assert.equal(svg.match(/rotate\(/g)?.length, 4);
  assert.match(svg, /<circle/);
  assert.doesNotMatch(svg, /AB2Z|<text/);
  assert.notEqual(renderCaptchaSvg("AB2Z"), url);
});

test("environment defaults, explicit password sync and TTL parsing", () => {
  assert.deepEqual(loadAuthServiceOptionsFromEnv({}), {
    adminUsername: "admin", adminPassword: "woshisheng_666", syncAdminPassword: false, captchaTtlSeconds: 180,
    sessionTtlHours: 168, cookieName: "picagent_session", cookieSecure: "auto", maxLoginFailures: 10, rateLimitWindowMs: 300000,
  });
  const options = loadAuthServiceOptionsFromEnv({
    AUTH_ADMIN_USERNAME: " ops ", AUTH_ADMIN_PASSWORD: " password ", AUTH_CAPTCHA_TTL_SECONDS: "45",
    AUTH_SESSION_TTL_HOURS: "3", AUTH_COOKIE_SECURE: "false",
  });
  assert.equal(options.adminUsername, "ops");
  assert.equal(options.adminPassword, "password");
  assert.equal(options.syncAdminPassword, true);
  assert.equal(options.captchaTtlSeconds, 45);
  assert.equal(options.sessionTtlHours, 3);
  assert.equal(options.cookieSecure, false);
  const invalid = loadAuthServiceOptionsFromEnv({
    AUTH_ADMIN_PASSWORD: " ", AUTH_CAPTCHA_TTL_SECONDS: "-2", AUTH_SESSION_TTL_HOURS: "0.5", AUTH_COOKIE_SECURE: "true",
  });
  assert.equal(invalid.syncAdminPassword, false);
  assert.equal(invalid.captchaTtlSeconds, 180);
  assert.equal(invalid.sessionTtlHours, 168);
  assert.equal(invalid.cookieSecure, true);
});

test("admin initialization preserves the existing password unless synchronization is enabled", async () => {
  const { repo, options } = await fixture();
  const before = await repo.findUserByUsername(credentials.username);
  assert.ok(before);
  await new AuthService(repo, { ...options, adminPassword: "changed" }).ensureDefaultAdmin();
  assert.deepEqual(await repo.findUserByUsername(credentials.username), before);
  await new AuthService(repo, { ...options, adminPassword: "changed", syncAdminPassword: true }).ensureDefaultAdmin();
  const updated = await repo.findUserByUsername(credentials.username);
  assert.equal(updated?.id, before.id);
  assert.ok(updated && verifyPassword("changed", updated.passwordHash));
});

test("required fields are checked before consumption and only a single parallel login succeeds", async () => {
  const { service } = await fixture();
  const { captchaId, ttlSeconds, expiresAt } = await service.createCaptcha();
  assert.equal(ttlSeconds, 180);
  assert.equal(Date.parse(expiresAt), start + 180_000);
  assert.deepEqual(await service.login({ captchaId }), { ok: false, code: "AUTH_FIELDS_REQUIRED", status: 400 });
  assert.deepEqual(await service.login({ ...credentials, captchaId, captchaCode: " " }), { ok: false, code: "CAPTCHA_REQUIRED", status: 400 });
  const results = await Promise.all([1, 2].map(() => service.login({ ...credentials, captchaId })));
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.deepEqual(results.find((result) => !result.ok), invalidCaptcha);
});

test("wrong, missing and used captchas fail without charging the credential failure limit", async () => {
  const { service, login } = await fixture({ maxLoginFailures: 1 });
  const { captchaId } = await service.createCaptcha();
  assert.deepEqual(await service.login({ ...credentials, captchaId, captchaCode: "WRNG" }), invalidCaptcha);
  for (const id of [captchaId, "bad-id", randomUUID()]) {
    assert.deepEqual(await service.login({ ...credentials, captchaId: id }), invalidCaptcha);
  }
  assert.equal((await login()).ok, true);
});

test("unused captchas expire at the TTL boundary and are pruned after ten minutes", async () => {
  const { service, advance } = await fixture({ captchaTtlSeconds: 2 });
  const { captchaId } = await service.createCaptcha();
  advance(2_000);
  assert.deepEqual(await service.login({ ...credentials, captchaId }), { ok: false, code: "CAPTCHA_EXPIRED", status: 400 });
  advance(600_000);
  await service.createCaptcha();
  assert.deepEqual(await service.login({ ...credentials, captchaId }), invalidCaptcha);
});

test("wrong users and passwords share the per-IP sliding window, which resets after success", async () => {
  const { service, login, advance } = await fixture({ maxLoginFailures: 2, rateLimitWindowMs: 1000 });
  assert.deepEqual(await login({ username: "unknown" }), invalidCredentials);
  advance(600);
  assert.deepEqual(await login({ password: "wrong" }), invalidCredentials);
  const { captchaId } = await service.createCaptcha();
  assert.deepEqual(await service.login({ ...credentials, captchaId }), limited);
  assert.equal((await login({ ipAddress: "192.0.2.2" })).ok, true);
  advance(400);
  assert.equal((await service.login({ ...credentials, captchaId })).ok, true);
  assert.deepEqual(await login({ password: "wrong" }), invalidCredentials);
  assert.equal((await login()).ok, true);
});

test("session cookies expose only the user, touch after five minutes, expire and revoke on logout", async () => {
  const { service, repo, login, advance } = await fixture({ sessionTtlHours: 1 });
  const result = await login({ isSecureRequest: true });
  assert.ok(result.ok);
  assert.deepEqual(Object.keys(result.user).sort(), ["id", "role", "username"]);
  assert.match(result.setCookie, /^picagent_session=[a-f0-9]{64}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=3600; Secure$/);
  assert.equal(Date.parse(result.expiresAt), start + 3600_000);
  const pair = result.setCookie.split(";")[0];
  const headers = { Cookie: `other=abc; ${pair}` };
  const tokenHash = createHash("sha256").update(pair.split("=")[1]).digest("hex");
  advance(299_999);
  const session = await service.authenticateHeaders(headers);
  assert.ok(session.authenticated);
  assert.deepEqual(session.user, result.user);
  assert.equal(session.expiresAt, result.expiresAt);
  assert.equal((await repo.findActiveSessionByTokenHash(tokenHash, new Date(start)))?.lastSeenAt.getTime(), start);
  advance(1);
  assert.equal((await service.authenticateHeaders(headers)).authenticated, true);
  assert.equal((await repo.findActiveSessionByTokenHash(tokenHash, new Date(start)))?.lastSeenAt.getTime(), start + 300_000);
  const independent = await login();
  assert.ok(independent.ok);
  assert.match(await service.logout(headers, true), /^picagent_session=; HttpOnly; SameSite=Lax; Path=\/; Max-Age=0; Secure$/);
  assert.deepEqual(await service.authenticateHeaders(headers), anonymous);
  const second = { cookie: independent.setCookie.split(";")[0] };
  assert.equal((await service.authenticateHeaders(second)).authenticated, true);
  advance(3600_000);
  assert.deepEqual(await service.authenticateHeaders(second), anonymous);
  for (const cookie of [undefined, "other=abc", "picagent_session=%zz", `picagent_session=${"0".repeat(64)}`]) {
    assert.deepEqual(await service.authenticateHeaders({ cookie }), anonymous);
    assert.match(await service.logout({ cookie }), /Max-Age=0$/);
  }
});

test("Secure follows the first forwarded protocol or an explicit override on both cookies", () => {
  assert.equal(isSecureRequest({ "X-Forwarded-Proto": " HTTPS , http" }), true);
  assert.equal(isSecureRequest({ "x-forwarded-proto": "http, https" }), false);
  assert.equal(isSecureRequest({}), false);
  for (const mode of ["auto", true, false] as const) {
    const service = new AuthService(new MemoryAuthRepository(), { cookieSecure: mode, cookieName: "studio_session" });
    for (const https of [true, false]) {
      for (const cookie of [service.buildSessionCookie("test", https), service.buildClearCookie(https)]) {
        assert.match(cookie, /^studio_session=/);
        assert.equal(cookie.endsWith("; Secure"), mode === "auto" ? https : mode);
      }
    }
  }
});
