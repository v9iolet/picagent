import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client, escapeIdentifier, type Pool, type QueryResultRow } from "pg";
import { createTicket02App } from "../server/app.js";
import { loadPostgresConfig } from "../server/config.js";
import type { ListingImage, ListingJob, ListingVersion } from "../server/listing-copy.js";
import { runMigrations } from "../server/migrations.js";
import { PostgresListingRepository } from "../server/repositories/postgres-listing-copy-repository.js";
import { PostgresPipelineRepository } from "../server/repositories/postgres-pipeline-repository.js";
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
        ...initial, createdAt: new Date(timestamp), updatedAt: new Date(timestamp),
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

    const app = createTicket02App({ repository: suites, pipelineRepository: pipelines, storage: new MemoryStorage() });
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
    assert.deepEqual(failed, { ...original, ...patch, updatedAt: new Date(timestamp), completedAt: new Date(timestamp) });
    assert.equal(await pipelines.resumeRun(original, "wrong-status", "structure_planning", seed.config), null);
    assert.deepEqual(await pipelines.getRun(seed.id), failed);

    const config = { ...seed.config, refineBaseImages: false };
    const resumed = await pipelines.resumeRun(failed, "fresh-key", "structure_planning", config);
    assert.ok(resumed);
    const { rows: [{ now }] } = await pool.query<{ now: Date }>("SELECT transaction_timestamp() AS now");
    assert.deepEqual(resumed, {
      ...failed, status: "running", resumeCount: 1, lastResumeKey: "fresh-key", resumeKeys: ["fresh-key"],
      config, errorCode: null, errorMessage: null, completedAt: null, updatedAt: now,
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
  amazon: [75, 5, true], walmart: [75, 5, false], tiktok_shop: [80, 5, false], ebay: [80, 5, false],
  etsy: [120, 5, true], shopee: [100, 5, false], lazada: [100, 5, false], aliexpress: [100, 5, false],
  temu: [80, 5, false], shopify: [70, 5, false], taobao: [30, 3, false], jd: [30, 3, false],
  pinduoduo: [30, 3, false], "1688": [30, 3, false], douyin: [30, 3, false], xiaohongshu: [20, 3, false],
} as const;
const domesticPlatforms = new Set(["taobao", "jd", "pinduoduo", "1688", "douyin", "xiaohongshu"]);

test("027 seeds all 16 listing-copy rules and the platform repository exposes them", { skip }, async () => {
  await withMigratedSchemas(async ({ pool }) => {
    const platforms = new PostgresPlatformRepository(pool);
    const expected = Object.fromEntries(Object.entries(platformLimits).map(([code, [titleMaxLength, maxBulletPoints, supportsSearchTerms]]) => [
      code, {
        titleMaxLength, maxBulletPoints, supportsSearchTerms,
        forbiddenWords: domesticPlatforms.has(code) ? ["全网第一", "国家级", "绝对有效"] : ["best seller", "100% guaranteed", "free shipping"],
      },
    ]));
    const { rows } = await pool.query<{ code: string; listing_copy_rules: unknown }>("SELECT code, listing_copy_rules FROM suite_workbench.platform_profiles");
    assert.equal(rows.length, 16);
    assert.deepEqual(Object.fromEntries(rows.map((row) => [row.code, row.listing_copy_rules])), expected);
    const enabled = await platforms.listEnabled();
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

test("027 saves listing jobs by revision, preserves old versions and omits drafts from history", { skip }, async () => {
  await withMigratedSchemas(async ({ pool }) => {
    const jobs = new PostgresListingRepository(pool);
    const draft = listingJob();
    const hidden = listingJob();
    assert.equal(await jobs.save(draft, null), true);
    assert.equal(await jobs.save(hidden, null), true);
    assert.equal(await jobs.save(draft, null), false);
    assert.deepEqual(await jobs.get(draft.id), { ...draft, createdAt: new Date(timestamp), updatedAt: new Date(timestamp) });
    assert.deepEqual(await jobs.list(10, 0), []);

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
      createdAt: new Date(timestamp), updatedAt: new Date(timestamp),
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
