import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client, type QueryResultRow } from "pg";
import { AuthService, loadAuthServiceOptionsFromEnv } from "../server/auth/auth-service.js";
import { hashCaptchaCode } from "../server/auth/captcha.js";
import { loadPostgresConfig } from "../server/config.js";
import { PostgresAuthRepository } from "../server/repositories/postgres-auth-repository.js";

const skip = process.env.PG_CONTRACT_TEST !== "1";
const migration = new URL("../db/migrations/054_admin_auth_and_captcha.sql", import.meta.url);

function isolatedDatabase(client: Client, schema: string) {
  // Concurrent repository calls share one transaction. Queue individual statements, so their
  // continuations may interleave without issuing parallel queries on a single pg Client.
  let pending = Promise.resolve();
  return {
    query<Row extends QueryResultRow>(sql: string, values?: unknown[]) {
      assert.doesNotMatch(sql, /\bpublic\b"?\s*\.|\b(?:COMMIT|ROLLBACK|ABORT|END\s+(?:TRANSACTION|WORK)|SET\s+(?:LOCAL\s+|SESSION\s+)?search_path)\b|(?:^|;)\s*END\s*;/i);
      const result = pending.then(() => client.query<Row>(sql.replace(/\bsuite_workbench\b/g, schema), values));
      pending = result.then(() => {}, () => {});
      return result;
    },
  };
}

async function withAuthSchema(run: (db: ReturnType<typeof isolatedDatabase>, schema: string) => Promise<void>) {
  const client = new Client({ ...loadPostgresConfig(), connectionTimeoutMillis: 10_000 });
  const schema = `contract_auth_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.connect();
    await client.query("BEGIN");
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET LOCAL search_path TO ${schema}`);
      const db = isolatedDatabase(client, schema);
      await db.query(await readFile(migration, "utf8"));
      await run(db, schema);
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    await client.end();
  }
}

test("054 replays with populated auth tables and admin sync only updates an existing password on request", { skip }, async () => {
  await withAuthSchema(async (db, schema) => {
    const repo = new PostgresAuthRepository(db);
    await repo.upsertAdminUser("operator", "first");
    const original = await repo.findUserByUsername("operator");
    assert.ok(original);
    await db.query("UPDATE suite_workbench.auth_users SET updated_at = '2000-01-01T00:00:00Z'");
    await repo.upsertAdminUser("operator", "ignored");
    const user = await db.query("SELECT password_hash, updated_at FROM suite_workbench.auth_users");
    assert.deepEqual(user.rows, [{ password_hash: "first", updated_at: new Date("2000-01-01T00:00:00Z") }]);
    await repo.upsertAdminUser("operator", "changed", { updateExistingPassword: true });
    assert.equal((await repo.findUserByUsername("operator"))?.id, original.id);
    const synced = await db.query("SELECT password_hash, updated_at FROM suite_workbench.auth_users");
    assert.equal(synced.rows[0].password_hash, "changed");
    assert.ok(synced.rows[0].updated_at > user.rows[0].updated_at);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 1000);
    await repo.createCaptcha(randomUUID(), "challenge hash", expiresAt);
    await repo.createSession({ userId: original.id, tokenHash: "token hash", now, expiresAt });
    async function snapshot() {
      const rows = [];
      for (const table of ["auth_users", "auth_captchas", "auth_sessions"]) {
        rows.push((await db.query(`SELECT * FROM suite_workbench.${table} ORDER BY id`)).rows);
      }
      return rows;
    }
    const before = await snapshot();
    await db.query(await readFile(migration, "utf8"));
    assert.deepEqual(await snapshot(), before);
    const indices = await db.query("SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname LIKE 'idx_auth_%' ORDER BY indexname", [schema]);
    assert.deepEqual(indices.rows.map((row) => row.indexname), ["idx_auth_captchas_expires_at", "idx_auth_sessions_active"]);
  });
});

test("PG consumes a captcha once, distinguishes expiry and stores only hashes through the session lifecycle", { skip }, async () => {
  await withAuthSchema(async (db) => {
    const repo = new PostgresAuthRepository(db);
    let time = Date.UTC(2026, 0, 1);
    const now = () => new Date(time);
    const options = {
      ...loadAuthServiceOptionsFromEnv({}), adminPassword: "contract password", generateCaptchaCode: () => "AB2Z",
      now, captchaTtlSeconds: 3, sessionTtlHours: 1,
    };
    const service = new AuthService(repo, options);
    await service.ensureDefaultAdmin();
    const captcha = await service.createCaptcha();
    const { rows } = await db.query("SELECT code_hash, expires_at, used_at FROM suite_workbench.auth_captchas WHERE id = $1", [captcha.captchaId]);
    assert.deepEqual(rows, [{
      code_hash: hashCaptchaCode(captcha.captchaId, "AB2Z"), expires_at: new Date(captcha.expiresAt), used_at: null,
    }]);
    const input = {
      username: "admin", password: options.adminPassword, captchaId: captcha.captchaId, captchaCode: "ab2z",
      ipAddress: "192.0.2.1", userAgent: "contract",
    };
    const results = await Promise.all([service.login(input), service.login(input)]);
    const successes = results.filter((result) => result.ok);
    assert.equal(successes.length, 1);
    assert.deepEqual(results.find((result) => !result.ok), { ok: false, code: "INVALID_CAPTCHA", status: 400 });
    const { setCookie, user, expiresAt } = successes[0];
    const headers = { cookie: setCookie.split(";")[0] };
    const token = headers.cookie.split("=")[1];
    const stored = await db.query("SELECT id, token_hash, user_agent, ip_address FROM suite_workbench.auth_sessions");
    assert.deepEqual(stored.rows, [{
      id: stored.rows[0].id, token_hash: createHash("sha256").update(token).digest("hex"), user_agent: "contract", ip_address: "192.0.2.1",
    }]);
    const snapshot = { authenticated: true, sessionId: stored.rows[0].id, expiresAt, user };
    assert.deepEqual(await service.authenticateHeaders(headers), snapshot);

    const unused = await service.createCaptcha();
    time += 3000;
    assert.deepEqual(await service.login({ ...input, captchaId: unused.captchaId }), { ok: false, code: "CAPTCHA_EXPIRED", status: 400 });
    for (const id of [captcha.captchaId, "invalid uuid", randomUUID()]) {
      assert.deepEqual(await repo.consumeCaptcha(id, now()), { status: "missing_or_used" });
    }
    time += 600_000;
    const fresh = await service.createCaptcha();
    assert.deepEqual(await repo.consumeCaptcha(unused.captchaId, now()), { status: "missing_or_used" });
    assert.deepEqual(await service.authenticateHeaders(headers), snapshot);
    const touched = await db.query("SELECT last_seen_at FROM suite_workbench.auth_sessions WHERE id = $1", [snapshot.sessionId]);
    assert.deepEqual(touched.rows, [{ last_seen_at: now() }]);
    const second = await service.login({ ...input, captchaId: fresh.captchaId });
    assert.ok(second.ok);
    assert.match(await service.logout(headers, false), /Max-Age=0/);
    assert.deepEqual(await service.authenticateHeaders(headers), { authenticated: false, user: null });
    const other = { cookie: second.setCookie.split(";")[0] };
    assert.equal((await service.authenticateHeaders(other)).authenticated, true);
    time = Date.parse(second.expiresAt);
    assert.deepEqual(await service.authenticateHeaders(other), { authenticated: false, user: null });
  });
});
