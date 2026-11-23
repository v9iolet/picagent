import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client, escapeIdentifier, type Pool, type QueryResultRow } from "pg";
import { createSuiteStudioApp } from "../server/app.js";
import { loadPostgresConfig } from "../server/config.js";
import type { ListingImage, ListingJob, ListingVersion } from "../server/listing-copy.js";
import { runMigrations } from "../server/migrations.js";
import { PostgresLibraryRepository } from "../server/repositories/postgres-library-repository.js";
import { PostgresTaskRepository } from "../server/repositories/postgres-task-repository.js";
import { PostgresListingRepository } from "../server/repositories/postgres-listing-copy-repository.js";
import { PostgresPipelineRepository } from "../server/repositories/postgres-pipeline-repository.js";
import { PostgresReplicaRepository } from "../server/repositories/postgres-replica-repository.js";
import { PostgresPromptRepository } from "../server/repositories/postgres-prompt-repository.js";
import { parseNormalizedPromptMarkdown } from "../server/prompt-library.js";
import { PostgresPlatformRepository } from "../server/repositories/postgres-platform-repository.js";
import { PostgresSuiteRepository } from "../server/repositories/postgres-suite-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";
import type { SuitePipelineRun } from "../server/types.js";

const skip = process.env.PG_CONTRACT_TEST !== "1";
const timestamp = "2026-01-01T00:00:00.000Z";

async function withMigratedSchemas<T>(run: (db: { pool: Pool; schemas: string[] }) => Promise<T>) {
  const client = new Client({ ...loadPostgresConfig(), connectionTimeoutMillis: 10_000 });
  const suffix = randomUUID().replaceAll("-", "");
  const suiteSchema = `contract_suite_${suffix}`;
  const promptSchema = `contract_prompt_${suffix}`;
  let connected = false;
  try {
    await client.connect();
    connected = true;
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${suiteSchema}`);
    await client.query(`CREATE SCHEMA ${promptSchema}`);
    await client.query(`SET LOCAL search_path TO ${suiteSchema}, ${promptSchema}`);
    const extension = await client.query<{ schema: string }>(
      `SELECT n.nspname AS schema FROM pg_catalog.pg_extension e
       JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace WHERE e.extname=$1`,
      ["pgcrypto"],
    );
    const cryptoSchema = escapeIdentifier(extension.rows[0]?.schema ?? suiteSchema);

    function query<Row extends QueryResultRow>(sql: string, values?: unknown[]) {
      // Migrations are trusted repo SQL; do not forward transaction endings, search_path changes,
      // or explicit public-schema access. Only the read-only pgcrypto functions are qualified below.
      assert.doesNotMatch(sql, /\bpublic\b"?\s*\.|\b(?:COMMIT|ROLLBACK|ABORT|END\s+(?:TRANSACTION|WORK)|SET\s+(?:LOCAL\s+|SESSION\s+)?search_path)\b|(?:^|;)\s*END\s*;/i);
      return client.query<Row>(sql
        // Includes CREATE SCHEMA and the information_schema literal in 005.
        .replace(/\bsuite_workbench\b/g, suiteSchema)
        .replace(/\bprompt_library\b/g, promptSchema)
        // Legacy guards otherwise see same-named constraints in the application schemas.
        .replace(/\bFROM pg_constraint WHERE conname\b/gi, `FROM pg_catalog.pg_constraint
          WHERE connamespace IN (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = ANY(pg_catalog.current_schemas(false))) AND conname`)
        .replace(/\bCREATE EXTENSION IF NOT EXISTS pgcrypto\s*;/i, `CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA ${suiteSchema};`)
        .replace(/\b(digest|gen_random_uuid)\(/g, (_match, fn: string) => `${cryptoSchema}.${fn}(`), values);
    }

    // Repositories own their transaction boundaries. Map those to a savepoint on the
    // same connection, so repository COMMIT never commits the outer transaction.
    let leased = false;
    const pool = {
      query,
      async connect() {
        assert.equal(leased, false, "test adapter supports one repository transaction at a time");
        leased = true;
        return {
          async query(sql: string, values?: unknown[]) {
            switch (sql) {
              case "BEGIN": return client.query("SAVEPOINT repo_transaction");
              case "COMMIT": return client.query("RELEASE SAVEPOINT repo_transaction");
              case "ROLLBACK":
                await client.query("ROLLBACK TO SAVEPOINT repo_transaction");
                return client.query("RELEASE SAVEPOINT repo_transaction");
              default: return query(sql, values);
            }
          },
          release() { leased = false; },
        };
      },
    } as unknown as Pool;

    await runMigrations(pool);
    return await run({ pool, schemas: [suiteSchema, promptSchema] });
  } finally {
    try {
      if (connected) await client.query("ROLLBACK");
    } finally {
      await client.end();
    }
  }
}

async function migrationData(pool: Pool, schemas: string[]) {
  const tables = await pool.query<{ table_schema: string; table_name: string }>(
    `SELECT table_schema, table_name FROM information_schema.tables
     WHERE table_schema = ANY($1::text[]) AND table_type = 'BASE TABLE' ORDER BY table_schema, table_name`,
    [schemas],
  );
  const data = [];
  for (const { table_schema, table_name } of tables.rows) {
    const table = `${escapeIdentifier(table_schema)}.${escapeIdentifier(table_name)}`;
    const { rows } = await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)`);
    data.push({ table, rows });
  }
  return data;
}

test("all migrations replay without changing data or the listing_copy template stage", { skip }, async () => {
  await withMigratedSchemas(async ({ pool, schemas }) => {
    const guardedConstraints = [
      "input_images_current_base_version_id_fkey", "plan_snapshots_confirmation_mode_check",
      "prompt_templates_lifecycle_status_check", "suites_origin_check",
    ];
    const { rows: constraints } = await pool.query<{ constraint_name: string }>(
      `SELECT constraint_name FROM information_schema.table_constraints
       WHERE constraint_schema = ANY($1::text[]) AND constraint_name = ANY($2::text[]) ORDER BY constraint_name`,
      [schemas, guardedConstraints],
    );
    assert.deepEqual(constraints.map(({ constraint_name }) => constraint_name), guardedConstraints);
    const templateId = randomUUID();
    const versionId = randomUUID();
    await pool.query(
      `INSERT INTO prompt_library.prompt_templates (id, code, name, kind, stage, execution_target)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [templateId, "general.listing-copy", "Listing copy", "planner", "listing_copy", "llm"],
    );
    await pool.query(
      `INSERT INTO prompt_library.prompt_template_versions
       (id, template_id, version_no, name, kind, stage, execution_target, body, status, source_file, source_heading, source_sha256)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [versionId, templateId, 1, "Listing copy", "planner", "listing_copy", "llm", "Fixture prompt", "published", "fixture.md", "Listing copy", "a".repeat(64)],
    );
    const first = await migrationData(pool, schemas);
    await runMigrations(pool);
    const { rows } = await pool.query(
      `SELECT t.stage AS template_stage, v.stage AS version_stage FROM prompt_library.prompt_templates t
       JOIN prompt_library.prompt_template_versions v ON v.template_id=t.id WHERE v.id=$1`,
      [versionId],
    );
    assert.deepEqual(rows, [{ template_stage: "listing_copy", version_stage: "listing_copy" }]);
    assert.deepEqual(await migrationData(pool, schemas), first);
  });
});

test("030 idempotently allows commercial selling-point text on ebay and tiktok_shop without affecting other platforms", { skip }, async () => {
  await withMigratedSchemas(async ({ pool }) => {
    const before = await pool.query<{ code: string; text_strategy: string; source_note: string; updated_at: Date }>(
      "SELECT code, text_strategy, source_note, updated_at FROM suite_workbench.platform_profiles ORDER BY code",
    );
    assert.equal(before.rows.length, 16);
    for (const code of ["ebay", "tiktok_shop"]) {
      const row = before.rows.find((entry) => entry.code === code)!;
      assert.match(row.text_strategy, /首图\/主图不添加文字/);
      assert.match(row.text_strategy, /卖点图与细节副图允许并鼓励使用/);
      assert.equal(row.source_note.split("[副图卖点文字规范 v1]").length - 1, 1);
    }
    for (const row of before.rows.filter((entry) => entry.code !== "ebay" && entry.code !== "tiktok_shop")) {
      assert.doesNotMatch(row.source_note, /\[副图卖点文字规范 v1\]/);
    }
    const migration030 = await readFile("db/migrations/030_platform_detail_selling_point_text.sql", "utf8");
    await pool.query(migration030);
    const after = await pool.query<{ code: string; text_strategy: string; source_note: string; updated_at: Date }>(
      "SELECT code, text_strategy, source_note, updated_at FROM suite_workbench.platform_profiles ORDER BY code",
    );
    assert.deepEqual(after.rows, before.rows);
  });
});

function runningPipeline(suiteId: string): SuitePipelineRun {
  return {
    id: randomUUID(), suiteId, idempotencyKey: "start", status: "running", currentPhase: "base_refining",
    config: { platform: "taobao" }, errorCode: null, errorMessage: null,
    createdAt: timestamp, updatedAt: timestamp, completedAt: null,
  };
}

test("026 persists a pipeline and maps competing running inserts to HTTP 409", { skip }, async () => {
  await withMigratedSchemas(async ({ pool }) => {
    const suites = new PostgresSuiteRepository(pool);
    const { id: suiteId } = await suites.createSuite("PG pipeline fixture");
    const pipelines = new PostgresPipelineRepository(pool);
    const initial = runningPipeline(suiteId);
    const first = await pipelines.createRun(initial);
    assert.deepEqual(first, {
      duplicate: false,
      run: {
        ...initial, createdAt: timestamp, updatedAt: timestamp,
        resumeCount: 0, lastResumeKey: null, resumeKeys: [], structureSnapshotId: null, taskIds: [],
      },
    });
    const { id: contenderId } = runningPipeline(suiteId);
    assert.deepEqual(await pipelines.createRun({ ...initial, id: contenderId }), { run: first.run, duplicate: true });
    const contender = { ...initial, id: contenderId, idempotencyKey: "contender" };
    await assert.rejects(pipelines.createRun(contender), { message: "PIPELINE_ALREADY_RUNNING" });

    const transaction = await pool.connect();
    try {
      await transaction.query("BEGIN");
      await assert.rejects(transaction.query(
        `INSERT INTO suite_workbench.suite_pipeline_runs (id, suite_id, idempotency_key, status, current_phase)
         VALUES ($1, $2, $3, $4, $5)`,
        [contender.id, suiteId, contender.idempotencyKey, contender.status, contender.currentPhase],
      ), { code: "23505", constraint: "suite_pipeline_runs_one_running" });
    } finally {
      try {
        await transaction.query("ROLLBACK");
      } finally {
        transaction.release();
      }
    }

    const app = createSuiteStudioApp({ repository: suites, pipelineRepository: pipelines, storage: new MemoryStorage() });
    const response = await app.request("POST", "/api/suites/one-click-generate", {
      headers: { "Idempotency-Key": "another-key" }, body: { suiteId, config: initial.config },
    });
    assert.equal(response.status, 409);
    assert.ok("error" in response.body);
    assert.equal(response.body.error.code, "PIPELINE_ALREADY_RUNNING");
    assert.deepEqual(await pipelines.listRuns(suiteId), [first.run]);

    await pipelines.updateRun(initial.id, { status: "completed", completedAt: timestamp });
    const next = await pipelines.createRun(contender);
    assert.equal(next.duplicate, false);
    assert.equal(next.run.id, contender.id);
    assert.equal(next.run.status, "running");
  });
});

test("026 updates only the requested run fields and resumes with a fresh key and no completion time", { skip }, async () => {
  await withMigratedSchemas(async ({ pool }) => {
    const { id: suiteId } = await new PostgresSuiteRepository(pool).createSuite("PG resume fixture");
    const pipelines = new PostgresPipelineRepository(pool);
    const seed = runningPipeline(suiteId);
    const { run: original } = await pipelines.createRun(seed);
    const patch = {
      status: "failed", currentPhase: "structure_planning", lastResumeKey: "previous-key",
      errorCode: "FIXTURE_ERROR", errorMessage: "Fixture error", completedAt: timestamp,
      updatedAt: timestamp,
    } as const;
    assert.equal(await pipelines.updateRun(randomUUID(), patch), null);
    assert.deepEqual(await pipelines.getRun(seed.id), original);
    const failed = await pipelines.updateRun(seed.id, patch);
    assert.ok(failed);
    assert.deepEqual(failed, { ...original, ...patch, updatedAt: timestamp, completedAt: timestamp });
    assert.equal(await pipelines.resumeRun(original, "wrong-status", "structure_planning", seed.config), null);
    assert.deepEqual(await pipelines.getRun(seed.id), failed);

    const config = { ...seed.config, refineBaseImages: false };
    const resumed = await pipelines.resumeRun(failed, "fresh-key", "structure_planning", config);
    assert.ok(resumed);
    const { rows: [{ now }] } = await pool.query<{ now: Date }>("SELECT transaction_timestamp() AS now");
    assert.deepEqual(resumed, {
      ...failed, status: "running", resumeCount: 1, lastResumeKey: "fresh-key", resumeKeys: ["fresh-key"],
      config, errorCode: null, errorMessage: null, completedAt: null, updatedAt: now.toISOString(),
    });
    assert.deepEqual(await pipelines.getRun(seed.id), resumed);
    const failedAgain = await pipelines.updateRun(seed.id, { status: "failed", completedAt: timestamp });
    assert.ok(failedAgain);
    assert.equal(await pipelines.resumeRun(failed, "stale-count", "structure_planning", config), null);
    assert.equal(await pipelines.resumeRun(failedAgain, "fresh-key", "structure_planning", config), null);
    assert.deepEqual(await pipelines.getRun(seed.id), failedAgain);
  });
});

const platformLimits = {
  amazon: [75, 5, { supportsSearchTerms: true, itemHighlightsMaxLength: 125, searchTermsMaxBytes: 250 }],
  walmart: [75, 5], tiktok_shop: [100, 5], ebay: [80, 5],
  etsy: [140, 5, { maxTags: 13, tagMaxLength: 20 }], shopee: [100, 5], lazada: [100, 5], aliexpress: [100, 5],
  temu: [80, 5], shopify: [70, 5, { seoTitleMaxLength: 60, seoDescriptionMaxLength: 160 }],
  taobao: [30, 3, { subtitleMaxLength: 40 }], jd: [60, 3, { subtitleMaxLength: 40 }],
  pinduoduo: [30, 3, { subtitleMaxLength: 40 }], "1688": [30, 3, { subtitleMaxLength: 40 }],
  douyin: [30, 3, { maxHashtags: 10 }], xiaohongshu: [20, 3, { maxHashtags: 10 }],
} as const;
const domesticPlatforms = new Set(["taobao", "jd", "pinduoduo", "1688", "douyin", "xiaohongshu"]);

test("029 upgrades all 16 listing-copy rules, preserves custom banned words and exposes the rules through the API", { skip }, async () => {
  await withMigratedSchemas(async ({ pool }) => {
    const platforms = new PostgresPlatformRepository(pool);
    await pool.query(
      "UPDATE suite_workbench.platform_profiles SET listing_copy_rules = $1 WHERE code = 'etsy'",
      [{ titleMaxLength: 120, maxBulletPoints: 5, supportsSearchTerms: true, searchTermsMaxBytes: 20, forbiddenWords: ["handmade claim"] }],
    );
    const sql = await readFile("db/migrations/029_listing_copy_platform_rules_v2.sql", "utf8");
    await pool.query(sql);
    await pool.query(sql);
    const expected = Object.fromEntries(Object.entries(platformLimits).map(([code, [titleMaxLength, maxBulletPoints, limits]]) => [
      code, {
        titleMaxLength, maxBulletPoints, supportsSearchTerms: false, ...limits,
        forbiddenWords: code === "etsy" ? ["handmade claim"] : domesticPlatforms.has(code)
          ? ["全网第一", "国家级", "绝对有效"] : ["best seller", "100% guaranteed", "free shipping"],
      },
    ]));
    const { rows } = await pool.query<{ code: string; listing_copy_rules: unknown }>("SELECT code, listing_copy_rules FROM suite_workbench.platform_profiles");
    assert.equal(rows.length, 16);
    assert.deepEqual(Object.fromEntries(rows.map((row) => [row.code, row.listing_copy_rules])), expected);
    const app = createSuiteStudioApp({ repository: new PostgresSuiteRepository(pool), storage: new MemoryStorage(), platformRepository: platforms });
    const response = await app.request("GET", "/api/platforms");
    assert.equal(response.status, 200);
    const enabled: Awaited<ReturnType<typeof platforms.listEnabled>> = response.body.data;
    assert.equal(enabled.length, 16);
    assert.deepEqual(Object.fromEntries(enabled.map((profile) => [profile.code, profile.listingCopyRules])), expected);
    for (const [code, rules] of Object.entries(expected)) {
      assert.deepEqual((await platforms.find(code))?.listingCopyRules, rules, code);
    }
  });
});

function listingJob(id: string = randomUUID(), sourceSuiteId: string | null = null): ListingJob {
  return {
    id, sourceSuiteId, platform: "amazon", targetMarket: "US", outputLanguage: "en",
    input: { sellingPoints: "Steel drinking bottle" }, status: "draft", errorCode: null,
    revision: 0, createdAt: timestamp, updatedAt: timestamp, inputImages: [], versions: [],
  };
}

function listingVersion(versionNumber: number, title: string, editedFromVersionId?: string): ListingVersion {
  return {
    id: randomUUID(), versionNumber, createdAt: timestamp,
    content: {
      schemaVersion: "listing-copy-v1", title, bulletPoints: ["Steel body"],
      description: "A steel drinking bottle.", searchTerms: ["steel bottle"], missingFacts: [],
    },
    promptSnapshot: {
      templateVersionId: randomUUID(), templateCode: "general.listing-copy", templateVersionNo: 1,
      input: { sellingPoints: "Steel drinking bottle" }, model: { name: "Fixture", model: "fixture", isFake: true },
      ...(editedFromVersionId === undefined ? {} : { editedFromVersionId }),
    },
  };
}

function listingImage(jobId: string, ordinal: number): ListingImage {
  const id = randomUUID();
  const directory = `listing-copies/${jobId}/inputs/${id}`;
  return {
    id, ordinal, originalObjectKey: `${directory}/original`, thumbnailObjectKey: `${directory}/thumbnail`,
    mimeType: "image/png", width: 16, height: 16, sha256: "b".repeat(64), originalFilename: "bottle.png",
  };
}

test("listing jobs preserve old versions and find the latest generated job for the specified suite", { skip }, async () => {
  await withMigratedSchemas(async ({ pool }) => {
    const jobs = new PostgresListingRepository(pool);
    const { id: suiteId } = await new PostgresSuiteRepository(pool).createSuite("PG listing fixture");
    const draft = listingJob(undefined, suiteId);
    const hidden = { ...listingJob(undefined, suiteId), updatedAt: "2026-01-03T00:00:00.000Z" };
    assert.equal(await jobs.save(draft, null), true);
    assert.equal(await jobs.save(hidden, null), true);
    assert.equal(await jobs.save(draft, null), false);
    assert.deepEqual(await jobs.get(draft.id), draft);
    assert.deepEqual(await jobs.list(10, 0), []);
    assert.equal(await jobs.findLatestBySuiteId(suiteId), null);

    const first = listingVersion(1, "Steel bottle");
    const generated: ListingJob = { ...draft, status: "succeeded", revision: 1, versions: [first] };
    assert.equal(await jobs.save(generated, draft), true);
    const second = listingVersion(2, "Steel drinking bottle", first.id);
    const edited: ListingJob = { ...generated, revision: 2, versions: [first, second] };
    assert.equal(await jobs.save(edited, generated), true);
    assert.equal(await jobs.save({ ...draft, status: "failed", revision: 3, errorCode: "STALE_WRITE" }, draft), false);

    const saved = await jobs.get(draft.id);
    assert.ok(saved);
    assert.deepEqual({
      ...saved, createdAt: new Date(saved.createdAt).toISOString(), updatedAt: new Date(saved.updatedAt).toISOString(),
      versions: saved.versions.map((version) => ({ ...version, createdAt: new Date(version.createdAt).toISOString() })),
    }, edited);
    const history = await jobs.list(10, 0);
    assert.deepEqual(history.map(({ id, revision, status }) => ({ id, revision, status })), [{ id: draft.id, revision: 2, status: "succeeded" }]);
    const newer = { ...listingJob(undefined, suiteId), status: "running" as const, updatedAt: "2026-01-02T00:00:00.000Z" };
    assert.equal(await jobs.save(newer, null), true);
    assert.equal(await jobs.save({ ...listingJob(), status: "running", updatedAt: hidden.updatedAt }, null), true);
    assert.deepEqual(await jobs.findLatestBySuiteId(suiteId), await jobs.summary(newer.id));
    assert.equal(await jobs.findLatestBySuiteId(randomUUID()), null);
  });
});

test("027 accepts image ordinals 1 through 6 and rolls back jobs with out-of-range images", { skip }, async () => {
  await withMigratedSchemas(async ({ pool }) => {
    const jobs = new PostgresListingRepository(pool);
    const draft = listingJob();
    const images = Array.from({ length: 6 }, (_, index) => listingImage(draft.id, index + 1));
    assert.equal(await jobs.save({ ...draft, inputImages: [...images].reverse() }, null), true);
    assert.deepEqual((await jobs.get(draft.id))?.inputImages, images);

    for (const ordinal of [0, 7]) {
      const rejected = listingJob();
      await assert.rejects(
        jobs.save({ ...rejected, inputImages: [listingImage(rejected.id, ordinal)] }, null),
        { code: "23514", constraint: "listing_copy_input_images_ordinal_check" },
      );
      assert.equal(await jobs.get(rejected.id), null);
    }
  });
});

test("startup recovery fails running pipelines and listing jobs and increments the listing revision", { skip }, async () => {
  await withMigratedSchemas(async ({ pool }) => {
    const { id: suiteId } = await new PostgresSuiteRepository(pool).createSuite("PG recovery fixture");
    const pipelines = new PostgresPipelineRepository(pool);
    const initial = runningPipeline(suiteId);
    const { run } = await pipelines.createRun(initial);
    const jobs = new PostgresListingRepository(pool);
    const draft = listingJob(initial.id, suiteId);
    const working: ListingJob = { ...draft, status: "running", revision: 4 };
    const unaffected = listingJob();
    assert.equal(await jobs.save(working, null), true);
    assert.equal(await jobs.save(unaffected, null), true);
    assert.deepEqual(await jobs.summary(run.id), {
      id: run.id, sourceSuiteId: suiteId, platform: "amazon", targetMarket: "US", outputLanguage: "en",
      input: { sellingPoints: "Steel drinking bottle" }, status: "running", revision: 4, errorCode: null,
      createdAt: timestamp, updatedAt: timestamp,
    });
    assert.equal(await jobs.summary(randomUUID()), null);

    await runMigrations(pool, { recoverStaleAttempts: true });
    const failedPipeline = await pipelines.getRun(run.id);
    assert.equal(failedPipeline?.status, "failed");
    assert.equal(failedPipeline.errorCode, "PIPELINE_INTERRUPTED");
    const failedJob = await jobs.summary(run.id);
    assert.equal(failedJob?.status, "failed");
    assert.equal(failedJob.errorCode, "LISTING_GENERATION_INTERRUPTED");
    assert.equal(failedJob.revision, 5);
    assert.equal((await jobs.summary(unaffected.id))?.status, "draft");
    assert.equal((await jobs.summary(unaffected.id))?.revision, 0);
    await runMigrations(pool, { recoverStaleAttempts: true });
    assert.deepEqual(await jobs.summary(run.id), failedJob);
    assert.deepEqual(await pipelines.getRun(run.id), failedPipeline);
  });
});

test("PG library binds a published input_image from another suite to a canvas task", { skip }, async () => {
  await withMigratedSchemas(async ({ pool }) => {
    const suites = new PostgresSuiteRepository(pool);
    const library = new PostgresLibraryRepository(pool);
    const source = await suites.createSuite("原图来源");
    const canvas = await suites.createSuite("资源画布", undefined, "canvas");
    const id = randomUUID();
    const prefix = `suites/${source.id}/inputs/${id}/`;
    await suites.createInputImage({ id, suiteId: source.id, ordinal: 1, originalObjectKey: prefix + "original",
      thumbnailObjectKey: prefix + "thumbnail", sha256: "1".repeat(64), width: 1, height: 1, mimeType: "image/png",
      originalFilename: "product.png", currentBaseVersionId: null, createdAt: timestamp });
    const { task } = await new PostgresTaskRepository(pool).createCustomTask({ suiteId: canvas.id, planSnapshotId: null,
      imageType: "detail", title: "细节", purpose: "展示细节", promptDraft: "展示商品", sourceInputImageId: null, generationParams: {} });
    const { reference } = await library.createReference({ suiteId: canvas.id, resourceId: `input:${id}`,
      targetType: "task", targetId: task.id, idempotencyKey: "bind-input" });
    assert.equal(reference.resourceType, "input_image");
    assert.equal(reference.resourceVersionId, id);
    assert.equal(reference.snapshot.suiteId, source.id);
    assert.deepEqual(await library.listReferences(canvas.id, "task", task.id), [reference]);
  });
});

test("PG suites feed returns multiple suite_studio batches in descending createdAt order with string timestamps", { skip }, async () => {
  await withMigratedSchemas(async ({ pool }) => {
    const suites = new PostgresSuiteRepository(pool);
    const pipelines = new PostgresPipelineRepository(pool);
    const tasks = new PostgresTaskRepository(pool);
    const listings = new PostgresListingRepository(pool);

    const older = await suites.createSuite("较早套图批次");
    const newer = await suites.createSuite("最新套图批次");
    await pool.query("UPDATE suite_workbench.suites SET created_at = $2, updated_at = $2 WHERE id = $1", [older.id, "2026-01-01T00:00:00.000Z"]);
    await pool.query("UPDATE suite_workbench.suites SET created_at = $2, updated_at = $2 WHERE id = $1", [newer.id, "2026-01-02T00:00:00.000Z"]);

    await pipelines.createRun({ ...runningPipeline(older.id), status: "completed", currentPhase: "done", completedAt: timestamp });
    await tasks.createCustomTask({
      suiteId: newer.id, planSnapshotId: null, imageType: "main", title: "主图",
      purpose: "展示主体", promptDraft: "白底主图", sourceInputImageId: null, generationParams: {},
    });

    const app = createSuiteStudioApp({
      repository: suites,
      pipelineRepository: pipelines,
      taskRepository: tasks,
      listingRepository: listings,
      storage: new MemoryStorage(),
    });

    const feedRes = await app.request("GET", "/api/suites/feed?limit=10&offset=0");
    assert.equal(feedRes.status, 200);
    const feed = feedRes.body.data as {
      items: Array<{ suite: { id: string; createdAt: unknown; updatedAt: unknown }; pipeline: unknown }>;
      total: number;
    };
    assert.equal(feed.total, 2);
    assert.deepEqual(feed.items.map((item) => item.suite.id), [newer.id, older.id]);
    for (const item of feed.items) {
      assert.equal(typeof item.suite.createdAt, "string");
      assert.equal(typeof item.suite.updatedAt, "string");
    }

    const stateRes = await app.request("GET", `/api/suites/${older.id}/studio-state`);
    assert.equal(stateRes.status, 200);
    const studioState = stateRes.body.data as { suite: { createdAt: unknown; updatedAt: unknown } };
    assert.equal(typeof studioState.suite.createdAt, "string");
    assert.equal(typeof studioState.suite.updatedAt, "string");
  });
});

test("031 extends origin, task origin_kind, pipeline phase, adds replica tables, and rejects invalid CHECK values", { skip }, async () => {
  await withMigratedSchemas(async ({ pool }) => {
    const suites = new PostgresSuiteRepository(pool);
    const tasks = new PostgresTaskRepository(pool);
    const pipelines = new PostgresPipelineRepository(pool);

    const expectRejected = async (sql: string, values: unknown[], expected: { code: string; constraint?: string }) => {
      const tx = await pool.connect();
      try {
        await tx.query("BEGIN");
        await assert.rejects(tx.query(sql, values), expected);
      } finally {
        try {
          await tx.query("ROLLBACK");
        } finally {
          tx.release();
        }
      }
    };

    const replicaSuite = await suites.createSuite("PG 复刻批次", undefined, "replica");
    assert.equal(replicaSuite.origin, "replica");
    await expectRejected(
      `INSERT INTO suite_workbench.suites (id, name, status, origin, created_at, updated_at)
       VALUES ($1, $2, 'draft', $3, now(), now())`,
      [randomUUID(), "非法来源", "invalid_origin"],
      { code: "23514", constraint: "suites_origin_check" },
    );

    const refId = randomUUID();
    const refObjectKey = `replicas/${replicaSuite.id}/references/${refId}/original`;
    const refThumbKey = `replicas/${replicaSuite.id}/references/${refId}/thumbnail`;
    await pool.query(
      `INSERT INTO suite_workbench.replica_references
        (id, suite_id, ordinal, filename, mime_type, sha256, width, height, object_key, thumbnail_object_key, remark)
       VALUES ($1,$2,1,'ref.png','image/png',$3,1024,1024,$4,$5,$6)`,
      [refId, replicaSuite.id, "a".repeat(64), refObjectKey, refThumbKey, "精".repeat(200)],
    );
    await expectRejected(
      `INSERT INTO suite_workbench.replica_references
        (id, suite_id, ordinal, filename, mime_type, sha256, width, height, object_key, thumbnail_object_key, remark)
       VALUES ($1,$2,2,'ref2.png','image/png',$3,1024,1024,$4,$5,$6)`,
      [randomUUID(), replicaSuite.id, "b".repeat(64), "k1", "k2", "超".repeat(201)],
      { code: "23514", constraint: "replica_references_remark_check" },
    );
    for (const badOrdinal of [0, 7]) {
      await expectRejected(
        `INSERT INTO suite_workbench.replica_references
          (id, suite_id, ordinal, filename, mime_type, sha256, width, height, object_key, thumbnail_object_key)
         VALUES ($1,$2,$3,'ref.png','image/png',$4,100,100,'k3','k4')`,
        [randomUUID(), replicaSuite.id, badOrdinal, "c".repeat(64)],
        { code: "23514", constraint: "replica_references_ordinal_check" },
      );
    }
    await expectRejected(
      `INSERT INTO suite_workbench.replica_references
        (id, suite_id, ordinal, filename, mime_type, sha256, width, height, object_key, thumbnail_object_key)
       VALUES ($1,$2,2,'dup.png','image/png',$3,100,100,'k5','k6')`,
      [randomUUID(), replicaSuite.id, "a".repeat(64)],
      { code: "23505" },
    );

    await pool.query(
      `INSERT INTO suite_workbench.replica_product_images
        (id, suite_id, ordinal, source_kind, object_key, library_resource_id, resource_version_id)
       VALUES ($1,$2,1,'upload',$3,NULL,NULL), ($4,$2,2,'library',$5,'base:123','ver-1')`,
      [randomUUID(), replicaSuite.id, `replicas/${replicaSuite.id}/products/1/original`, randomUUID(), "suites/other/base/1"],
    );
    await expectRejected(
      `INSERT INTO suite_workbench.replica_product_images
        (id, suite_id, ordinal, source_kind, object_key)
       VALUES ($1,$2,3,'url','https://example.com/a.png')`,
      [randomUUID(), replicaSuite.id],
      { code: "23514", constraint: "replica_product_images_source_kind_check" },
    );
    for (const badOrdinal of [0, 7]) {
      await expectRejected(
        `INSERT INTO suite_workbench.replica_product_images
          (id, suite_id, ordinal, source_kind, object_key)
         VALUES ($1,$2,$3,'upload','replicas/x')`,
        [randomUUID(), replicaSuite.id, badOrdinal],
        { code: "23514", constraint: "replica_product_images_ordinal_check" },
      );
    }

    const replicaTaskId = randomUUID();
    await pool.query(
      `INSERT INTO suite_workbench.suite_tasks
        (id, suite_id, plan_snapshot_id, plan_item_id, ordinal, image_type, title, purpose, prompt_draft, generation_params_json, status, origin_kind, replica_reference_id, replica_reference_object_key, created_at, updated_at)
       VALUES ($1,$2,NULL,NULL,1,'main','复刻卡 1','爆品复刻','提示词','{"size":"1K","ratio":"1:1"}'::jsonb,'pending','replica',$3,$4,$5,$5)`,
      [replicaTaskId, replicaSuite.id, refId, refObjectKey, timestamp],
    );
    const loadedTask = await tasks.getTask(replicaTaskId);
    assert.ok(loadedTask);
    assert.equal(loadedTask.originKind, "replica");
    assert.equal(loadedTask.replicaReferenceId, refId);
    assert.equal(loadedTask.replicaReferenceObjectKey, refObjectKey);
    await expectRejected(
      `INSERT INTO suite_workbench.suite_tasks
        (id, suite_id, plan_snapshot_id, plan_item_id, ordinal, image_type, title, purpose, prompt_draft, generation_params_json, status, origin_kind, created_at, updated_at)
       VALUES ($1,$2,NULL,NULL,2,'main','非法卡','测试','提示词','{}'::jsonb,'pending','invalid_kind',$3,$3)`,
      [randomUUID(), replicaSuite.id, timestamp],
      { code: "23514", constraint: "suite_tasks_origin_kind_check" },
    );

    const replicaConfig = { cloneLevel: "high", sceneType: "ecommerce", styleUnified: true, outputLanguage: "zh" };
    const { run } = await pipelines.createRun({
      ...runningPipeline(replicaSuite.id),
      currentPhase: "replica_analyzing",
      config: replicaConfig,
    });
    assert.equal(run.currentPhase, "replica_analyzing");
    assert.deepEqual(run.config, replicaConfig);
    await expectRejected(
      `INSERT INTO suite_workbench.suite_pipeline_runs
        (id, suite_id, idempotency_key, status, current_phase)
       VALUES ($1,$2,'bad-phase','failed','invalid_phase')`,
      [randomUUID(), replicaSuite.id],
      { code: "23514", constraint: "suite_pipeline_runs_current_phase_check" },
    );

    // Replaying all migrations with live replica rows must succeed idempotently.
    await runMigrations(pool);
  });
});

test("PG replica repository normalizes null remark, creates replica tasks, recovers replica_analyzing runs, and keeps 032 prompt import idempotent", { skip }, async () => {
  await withMigratedSchemas(async ({ pool }) => {
    const suites = new PostgresSuiteRepository(pool);
    const replicas = new PostgresReplicaRepository(pool);
    const tasks = new PostgresTaskRepository(pool);
    const pipelines = new PostgresPipelineRepository(pool);
    const prompts = new PostgresPromptRepository(pool);

    const suite = await suites.createSuite("PG 复刻测试", undefined, "replica");
    const refId = randomUUID();
    const now = new Date().toISOString();
    await pool.query(
      `INSERT INTO suite_workbench.replica_references
        (id, suite_id, ordinal, filename, mime_type, sha256, width, height, object_key, thumbnail_object_key, remark)
       VALUES ($1,$2,1,'null-remark.png','image/png',$3,800,1000,'replicas/k1','replicas/t1',NULL)`,
      [refId, suite.id, "f".repeat(64)],
    );
    const loadedRef = await replicas.getReference(suite.id, refId);
    assert.ok(loadedRef);
    assert.equal(loadedRef.remark, "");

    const savedProducts = await replicas.saveProductImages(suite.id, [
      {
        id: randomUUID(),
        suiteId: suite.id,
        ordinal: 1,
        sourceKind: "upload",
        objectKey: `replicas/${suite.id}/products/1/original`,
        thumbnailObjectKey: `replicas/${suite.id}/products/1/thumbnail`,
        filename: "p1.png",
        mimeType: "image/png",
        sha256: "e".repeat(64),
        width: 500,
        height: 500,
        libraryResourceId: null,
        resourceVersionId: null,
        createdAt: now,
      },
    ]);
    assert.equal(savedProducts.length, 1);
    assert.equal(savedProducts[0].sourceKind, "upload");

    const materialized = await tasks.createReplicaTasks({
      suiteId: suite.id,
      globalStyleCard: { promptPrefix: "极简棚拍" },
      items: [
        {
          referenceId: refId,
          referenceObjectKey: "replicas/k1",
          ordinal: 1,
          title: "复刻图 1",
          purpose: "爆品图复刻（高度复刻）",
          prompt: "极简棚拍提示词",
          generationParams: { ratio: "3:4", size: "1K", language: "zh", cloneLevel: "high", sceneType: "ecommerce_product" },
        },
      ],
    });
    assert.equal(materialized.created.length, 1);
    assert.equal(materialized.created[0].originKind, "replica");
    assert.equal(materialized.created[0].replicaReferenceId, refId);
    // Calling again for same reference is idempotent
    const secondMat = await tasks.createReplicaTasks({
      suiteId: suite.id,
      items: [
        {
          referenceId: refId,
          referenceObjectKey: "replicas/k1",
          ordinal: 1,
          title: "复刻图 1",
          purpose: "爆品图复刻（高度复刻）",
          prompt: "极简棚拍提示词",
          generationParams: { ratio: "3:4", size: "1K" },
        },
      ],
    });
    assert.equal(secondMat.created.length, 0);

    // Startup recovery marks running replica_analyzing pipeline run as failed PIPELINE_INTERRUPTED
    const { run } = await pipelines.createRun({
      ...runningPipeline(suite.id),
      currentPhase: "replica_analyzing",
      config: { cloneLevel: "high", sceneType: "ecommerce_product" },
    });
    await runMigrations(pool, { recoverStaleAttempts: true });
    const recovered = await pipelines.getRun(run.id);
    assert.equal(recovered?.status, "failed");
    assert.equal(recovered?.currentPhase, "replica_analyzing");
    assert.equal(recovered?.errorCode, "PIPELINE_INTERRUPTED");

    // Importing unchanged replica markdown after 032 seed must NOT create duplicate v2 drafts
    const composeRecord = parseNormalizedPromptMarkdown(
      await readFile("prompt/normalized/replica-compose.md", "utf8"),
      "prompt/normalized/replica-compose.md",
    );
    const highRecord = parseNormalizedPromptMarkdown(
      await readFile("prompt/normalized/replica-high.md", "utf8"),
      "prompt/normalized/replica-high.md",
    );
    const imported = await prompts.importRecords([composeRecord, highRecord]);
    assert.equal(imported.length, 2);
    for (const version of imported) {
      assert.equal(version.versionNo, 1);
      assert.equal(version.status, "published");
      const allVersions = await prompts.listVersions(version.templateId);
      assert.equal(allVersions.length, 1);
    }
  });
});

test("033 adds task_result_slots(task_id) index and PostgresTaskRepository batches preview versions with final > current > version priority", { skip }, async () => {
  await withMigratedSchemas(async ({ pool }) => {
    const idx = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'suite_workbench' AND tablename = 'task_result_slots' AND indexname = 'task_result_slots_task_id_idx'`,
    );
    assert.equal(idx.rowCount, 1);

    const suites = new PostgresSuiteRepository(pool);
    const tasks = new PostgresTaskRepository(pool);
    const suite = await suites.createSuite("PG 批量缩略图测试", undefined, "suite_studio");

    const { task: t1 } = await tasks.createCustomTask({
      suiteId: suite.id,
      planSnapshotId: null,
      imageType: "main",
      title: "卡 1",
      purpose: "主图",
      promptDraft: "白底主图",
      sourceInputImageId: null,
      generationParams: {},
    });
    const { task: t2 } = await tasks.createCustomTask({
      suiteId: suite.id,
      planSnapshotId: null,
      imageType: "detail",
      title: "卡 2",
      purpose: "细节",
      promptDraft: "细节图",
      sourceInputImageId: null,
      generationParams: {},
    });
    const { task: t3 } = await tasks.createCustomTask({
      suiteId: suite.id,
      planSnapshotId: null,
      imageType: "detail",
      title: "无版本卡",
      purpose: "场景",
      promptDraft: "场景图",
      sourceInputImageId: null,
      generationParams: {},
    });

    async function addVersion(taskId: string, key: string) {
      const batchId = randomUUID();
      const slotId = randomUUID();
      const attemptId = randomUUID();
      await tasks.beginBatch({
        batch: {
          id: batchId,
          suiteId: suite.id,
          kind: "single",
          requestedCount: 1,
          taskIds: [taskId],
          status: "running",
          idempotencyKey: key,
          createdAt: timestamp,
          startedAt: timestamp,
          finishedAt: null,
        },
        slots: [
          {
            id: slotId,
            batchId,
            taskId,
            slotOrdinal: 1,
            retryOfSlotId: null,
            status: "generating",
            selectedVersionId: null,
            createdAt: timestamp,
            completedAt: null,
          },
        ],
        attempts: [
          {
            id: attemptId,
            slotId,
            attemptNo: 1,
            provider: "fake",
            model: "test",
            endpoint: "/v1/images/edits",
            requestSummary: {},
            promptSnapshot: {},
            promptSha256: "sha",
            contextSnapshot: {},
            sourceKind: "original",
            sourceObjectKey: "orig",
            sourceInputImageId: null,
            sourceBaseVersionId: null,
            status: "running",
            errorCode: null,
            errorMessage: null,
            externalRequestId: null,
            startedAt: timestamp,
            finishedAt: null,
          },
        ],
      });
      const { version } = await tasks.completeAttempt({
        attemptId,
        slotId,
        taskId,
        objectKey: `obj-${key}`,
        processObjectKeys: [],
        sha256: `sha-${key}`,
        width: 512,
        height: 512,
        mimeType: "image/png",
        completedAt: timestamp,
      });
      return version;
    }

    const t1v1 = await addVersion(t1.id, "pg-t1-v1");
    const t1v2 = await addVersion(t1.id, "pg-t1-v2");
    await tasks.selectVersion(t1.id, t1v1.id, "final"); // final v1 must beat current v2
    assert.ok(t1v2.isCurrent);

    const t2v1 = await addVersion(t2.id, "pg-t2-v1");
    const t2v2 = await addVersion(t2.id, "pg-t2-v2");
    await tasks.selectVersion(t2.id, t2v1.id, "current"); // current v1 must beat newer v2
    assert.ok(t2v2.id);

    const emptyMap = await tasks.listPreviewVersionsByTaskIds([]);
    assert.equal(emptyMap.size, 0);

    const previews = await tasks.listPreviewVersionsByTaskIds([t1.id, t2.id, t3.id, t1.id]);
    assert.equal(previews.size, 2);
    assert.equal(previews.get(t1.id)?.versionId, t1v1.id);
    assert.equal(previews.get(t1.id)?.previewUrl, t1v1.previewUrl);
    assert.equal(previews.get(t2.id)?.versionId, t2v1.id);
    assert.equal(previews.get(t2.id)?.previewUrl, t2v1.previewUrl);
    assert.equal(previews.has(t3.id), false);

    // Replay all migrations idempotently after 033.
    await runMigrations(pool);
  });
});
