import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Pool } from "pg";
import { createSuiteStudioApp } from "../server/app.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { PostgresPlatformRepository } from "../server/repositories/postgres-platform-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";

const expectedBackgrounds = {
  amazon: "pure_white_required", walmart: "pure_white_required", tiktok_shop: "pure_white_required",
  jd: "white_preferred", shopee: "white_preferred", lazada: "white_preferred", aliexpress: "white_preferred", temu: "white_preferred",
  taobao: "flexible", pinduoduo: "flexible", douyin: "flexible", xiaohongshu: "flexible", "1688": "flexible", ebay: "flexible", etsy: "flexible", shopify: "flexible",
};

// Opt in against a PostgreSQL test connection; all changes use a unique schema
// inside a rolled-back transaction, leaving application data untouched.
test("migrated platform API and repository expose the specified backgrounds for all 16 platforms", { skip: process.env.PLATFORM_MIGRATION_TEST !== "1" }, async () => {
  const pool = new Pool({
    host: process.env.PG_HOST, port: Number(process.env.PG_PORT || 5432),
    database: process.env.PG_DATABASE, user: process.env.PG_USER, password: process.env.PG_PASSWORD,
    ssl: process.env.PG_SSL === "true" ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 10_000,
  });
  const client = await pool.connect();
  const schema = `platform_background_test_${process.pid}`;
  const scopedPool = new Proxy(pool, {
    get(target, property, receiver) {
      if (property === "query") return (sql: string, values?: unknown[]) => client.query(sql.replaceAll("suite_workbench.", `${schema}.`), values);
      return Reflect.get(target, property, receiver);
    },
  });
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${schema}`);
    const seed = await readFile("db/migrations/009_platform_profiles.sql", "utf8");
    const migration = await readFile("db/migrations/025_platform_main_background.sql", "utf8");
    await scopedPool.query(seed);
    await scopedPool.query(migration);
    // Startup replays migrations, so backfills and source notes must be stable.
    const repository = new PostgresPlatformRepository(scopedPool);
    const first = await repository.listEnabled();
    await scopedPool.query(seed);
    await scopedPool.query(migration);
    assert.deepEqual(await repository.listEnabled(), first);
    const api = createSuiteStudioApp({ repository: new MemorySuiteRepository(), storage: new MemoryStorage(), platformRepository: repository });
    const response = await api.request("GET", "/api/platforms");
    assert.equal(response.status, 200);
    assert.equal(response.body.data.length, 16);
    assert.deepEqual(Object.fromEntries(response.body.data.map((profile: { code: string; mainImageBackground: string }) => [profile.code, profile.mainImageBackground])), expectedBackgrounds);
    for (const [code, background] of Object.entries(expectedBackgrounds)) {
      const profile = await repository.find(code);
      assert.equal(profile?.mainImageBackground, background, code);
      assert.match(profile!.sourceNote, /009_platform_profiles|商品图片|主图/);
      if (background === "pure_white_required") {
        assert.match(profile!.mainImageStrategy, /纯白.*RGB\s*255[，,]\s*255[，,]\s*255/);
        assert.doesNotMatch(profile!.mainImageStrategy, /优先纯白|需要时优先白底/);
      }
    }
    await client.query(`INSERT INTO ${schema}.platform_profiles (code, name, market_scope, main_image_strategy, gallery_strategy, text_strategy, model_strategy) VALUES ('custom', 'Custom', 'overseas', '', '', '', '')`);
    assert.equal((await repository.find("custom"))?.mainImageBackground, "flexible");
    await assert.rejects(client.query(`UPDATE ${schema}.platform_profiles SET main_image_background = 'unknown' WHERE code = 'custom'`), { code: "23514" });
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});
