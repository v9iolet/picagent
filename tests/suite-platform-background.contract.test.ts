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
  shopee: "pure_white_required", lazada: "pure_white_required", aliexpress: "pure_white_required", temu: "pure_white_required",
  ebay: "pure_white_required", etsy: "pure_white_required", shopify: "pure_white_required",
  taobao: "flexible", jd: "flexible", pinduoduo: "flexible", douyin: "flexible", xiaohongshu: "flexible", "1688": "flexible",
};

// Opt in against a PostgreSQL test connection; all changes use a unique schema
// inside a rolled-back transaction, leaving application data untouched.
test("028 migrates all 16 platform backgrounds by market scope and preserves legacy CHECK values", { skip: process.env.PLATFORM_MIGRATION_TEST !== "1" }, async () => {
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
    await client.query(`SET LOCAL search_path TO ${schema}`);
    const seed = await readFile("db/migrations/009_platform_profiles.sql", "utf8");
    const migration = await readFile("db/migrations/025_platform_main_background.sql", "utf8");
    const marketMigration = await readFile("db/migrations/028_platform_market_white_background.sql", "utf8");
    await scopedPool.query(seed);
    await scopedPool.query(migration);
    await scopedPool.query(marketMigration);
    // Startup replays migrations, so backfills and source notes must be stable.
    const repository = new PostgresPlatformRepository(scopedPool);
    const first = await repository.listEnabled();
    await scopedPool.query(seed);
    await scopedPool.query(migration);
    await scopedPool.query(marketMigration);
    await scopedPool.query(marketMigration);
    assert.deepEqual(await repository.listEnabled(), first);
    const api = createSuiteStudioApp({ repository: new MemorySuiteRepository(), storage: new MemoryStorage(), platformRepository: repository });
    const response = await api.request("GET", "/api/platforms");
    assert.equal(response.status, 200);
    assert.equal(response.body.data.length, 16);
    assert.deepEqual(Object.fromEntries(response.body.data.map((profile: { code: string; mainImageBackground: string }) => [profile.code, profile.mainImageBackground])), expectedBackgrounds);
    for (const [code, background] of Object.entries(expectedBackgrounds)) {
      const profile = await repository.find(code);
      assert.ok(profile, code);
      assert.equal(profile.mainImageBackground, background, code);
      if (background === "pure_white_required") {
        assert.match(profile.mainImageStrategy, /纯白.*RGB\s*255[，,]\s*255[，,]\s*255.*不得添加文字、Logo、水印.*装饰/);
        assert.equal(profile.sourceNote.split("[主图背景规范 v2]").length - 1, 1);
      } else {
        assert.doesNotMatch(profile.sourceNote, /\[主图背景规范 v2\]/);
      }
    }
    await client.query(`INSERT INTO ${schema}.platform_profiles (code, name, market_scope, main_image_strategy, gallery_strategy, text_strategy, model_strategy) VALUES ('custom', 'Custom', 'overseas', '', '', '', '')`);
    assert.equal((await repository.find("custom"))?.mainImageBackground, "flexible");
    await client.query(`UPDATE ${schema}.platform_profiles SET main_image_background = 'white_preferred' WHERE code = 'custom'`);
    assert.equal((await repository.find("custom"))?.mainImageBackground, "white_preferred");
    await scopedPool.query(marketMigration);
    assert.equal((await repository.find("custom"))?.mainImageBackground, "pure_white_required");
    await assert.rejects(client.query(`UPDATE ${schema}.platform_profiles SET main_image_background = 'unknown' WHERE code = 'custom'`), { code: "23514" });
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});
