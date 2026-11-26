import { verifyGenerationConcurrency } from "./image-generation-concurrency.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client, Pool, escapeIdentifier, type PoolClient, type QueryResultRow } from "pg";
import sharp from "sharp";
import { defaultImageOptions } from "../shared/model-settings.js";
import { createSuiteStudioApp } from "../server/app.js";
import { loadPostgresConfig } from "../server/config.js";
import { ImageEditorService } from "../server/image-editor.js";
import { createImageEditorApi } from "../server/image-editor-api.js";
import type { ListingImage, ListingJob, ListingVersion } from "../server/listing-copy.js";
import { ModelSettings, PostgresModelSettingsRepository } from "../server/model-settings.js";
import { runMigrations } from "../server/migrations.js";
import { requestImageEditorEdit } from "../server/providers/image-editor-provider.js";
import { PostgresImageEditorRepository } from "../server/repositories/postgres-image-editor-repository.js";
import { PostgresLibraryRepository } from "../server/repositories/postgres-library-repository.js";
import { PostgresTaskRepository } from "../server/repositories/postgres-task-repository.js";
import { PostgresListingRepository } from "../server/repositories/postgres-listing-copy-repository.js";
import { PostgresPipelineRepository } from "../server/repositories/postgres-pipeline-repository.js";
import { PostgresReplicaRepository } from "../server/repositories/postgres-replica-repository.js";
import { PostgresPromptRepository } from "../server/repositories/postgres-prompt-repository.js";
import { importPromptRecordsWithPolicy, parseNormalizedPromptMarkdown } from "../server/prompt-library.js";
import { PostgresPlatformRepository } from "../server/repositories/postgres-platform-repository.js";
import { PostgresSuiteRepository } from "../server/repositories/postgres-suite-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";
import { waitUntil } from "../server/suite-pipeline.js";
import type { ImageEditRequest, SuitePipelineRun } from "../server/types.js";
import { APLUS_MODULES } from "../shared/aplus.js";
import { resolveAplusPromptTemplate } from "../server/aplus/aplus-prompt.js";

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

test("PG library excludes input_image from listing, rejects binding input_image, and binds published base_image across suites", { skip }, async () => {
  await withMigratedSchemas(async ({ pool }) => {
    const suites = new PostgresSuiteRepository(pool);
    const library = new PostgresLibraryRepository(pool);
    const source = await suites.createSuite("底图来源");
    const canvas = await suites.createSuite("资源画布", undefined, "canvas");
    const id = randomUUID();
    const prefix = `suites/${source.id}/inputs/${id}/`;
    await suites.createInputImage({ id, suiteId: source.id, ordinal: 1, originalObjectKey: prefix + "original",
      thumbnailObjectKey: prefix + "thumbnail", sha256: "1".repeat(64), width: 1, height: 1, mimeType: "image/png",
      originalFilename: "product.png", currentBaseVersionId: null, createdAt: timestamp });
    const baseVersionId = randomUUID();
    const attemptId = randomUUID();
    await suites.beginBaseGeneration({
      id: attemptId, suiteId: source.id, inputImageId: id, baseVersionId, idempotencyKey: "pg-base-gen-1",
      model: "gpt-image-2", endpoint: "/v1/images/edits", prompt: "生成纯白底图", promptTemplateVersionId: null,
      dynamicInput: {}, size: "1K", quality: "medium", n: 1, responseFormat: "b64_json", createdAt: timestamp,
    });
    await suites.completeBaseGeneration({
      attemptId, objectKey: `${prefix}base/${baseVersionId}/v1.png`, sha256: "2".repeat(64), width: 1024, height: 1024, mimeType: "image/png", completedAt: timestamp,
    });
    const { task } = await new PostgresTaskRepository(pool).createCustomTask({ suiteId: canvas.id, planSnapshotId: null,
      imageType: "detail", title: "细节", purpose: "展示细节", promptDraft: "展示商品", sourceInputImageId: null, generationParams: {} });

    // input_image is excluded from image listings, still readable by direct ID/preview, and forbidden for new references
    const listedAll = await library.listResources({ scope: "image", suiteId: source.id });
    assert.equal(listedAll.items.some((item) => item.resourceType === "input_image"), false);
    assert.deepEqual(listedAll.items.map((item) => item.id), [`base:${baseVersionId}`]);
    const listedInputs = await library.listResources({ resourceType: "input_image", suiteId: source.id });
    assert.deepEqual(listedInputs.items, []);
    assert.deepEqual(await library.getPreviewObject(`input:${id}`), { objectKey: prefix + "original" });
    await assert.rejects(
      library.createReference({ suiteId: canvas.id, resourceId: `input:${id}`, targetType: "task", targetId: task.id, idempotencyKey: "bind-input" }),
      { message: "LIBRARY_RESOURCE_FORBIDDEN" },
    );

    const { reference } = await library.createReference({ suiteId: canvas.id, resourceId: `base:${baseVersionId}`,
      targetType: "task", targetId: task.id, idempotencyKey: "bind-base" });
    assert.equal(reference.resourceType, "base_image");
    assert.equal(reference.resourceVersionId, baseVersionId);
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

test("PG 保存 A+ 商品还原交付图与图片库来源，044–046 启动重放保留数据", { skip }, async () => {
  await withMigratedSchemas(async ({ pool }) => {
    const suites = new PostgresSuiteRepository(pool);
    const tasks = new PostgresTaskRepository(pool);
    const pipelines = new PostgresPipelineRepository(pool);
    const platforms = new PostgresPlatformRepository(pool);
    const storage = new MemoryStorage();
    const app = createSuiteStudioApp({ repository: suites, storage, platformRepository: platforms, taskRepository: tasks });
    const response = await app.request("GET", "/api/platforms");
    assert.equal(response.status, 200);
    const profiles: Awaited<ReturnType<typeof platforms.listEnabled>> = response.body.data;
    assert.equal(profiles.length, 16);
    const common = ["1:1", "3:4", "9:16", "16:9"];
    for (const { code, marketScope, detailSizePresets } of profiles) {
      const expected = code === "amazon"
        ? { options: ["aplus_premium_web", "aplus_premium_mobile", "aplus_standard", ...common], default: "aplus_standard" }
        : { options: common, default: marketScope === "domestic" ? "3:4" : "1:1" };
      assert.deepEqual(detailSizePresets, expected, code);
      assert.deepEqual((await platforms.find(code))?.detailSizePresets, expected, code);
    }
    const configured = { options: ["aplus_standard", "16:9"], default: "16:9" };
    for (const malformed of [{ options: "bad", default: "1:1" }, { options: common }, { options: [3], default: "3:4" }]) {
      await pool.query("UPDATE suite_workbench.platform_profiles SET detail_size_presets=$1 WHERE code='amazon'", [malformed]);
      assert.deepEqual((await platforms.find("amazon"))?.detailSizePresets, profiles.find((profile) => profile.code === "amazon")?.detailSizePresets);
    }
    await pool.query("UPDATE suite_workbench.platform_profiles SET detail_size_presets=$1 WHERE code='amazon'", [configured]);

    const creationKey = "aplus-planning-contract";
    const uploadDraft = await suites.createSuite("PG 上传草稿", creationKey);
    const suite = await suites.createSuite("PG A+ 批次", creationKey, "aplus");
    assert.equal(suite.origin, "aplus");
    assert.notEqual(suite.id, uploadDraft.id);
    assert.equal((await suites.findAplusSuiteByIdempotencyKey(creationKey))?.id, suite.id);
    assert.equal((await suites.createSuite("重复提交", creationKey, "aplus")).id, suite.id);
    const taskId = randomUUID();
    const taskRow = {
      id: taskId, suiteId: suite.id, planSnapshotId: null, planItemId: null, ordinal: 1,
      title: "首屏主视觉", purpose: "展示商品", promptDraft: "提示词", sourceInputImageId: null, promptRevision: 1,
      generationParams: { size: "1K", requestSize: "2496x1024" }, archivedAt: null,
      moduleCode: "hero", sizePreset: "aplus_premium_web", sortOrder: 1, imageType: "detail", originKind: "aplus",
      status: "pending", createdAt: timestamp, updatedAt: timestamp,
    } as const;
    await tasks.createAplusTasks([taskRow]);
    await tasks.createAplusTasks([taskRow]);
    assert.equal((await tasks.listTasks(suite.id)).length, 1);
    const task = await tasks.getTask(taskId);
    assert.equal(task?.originKind, "aplus");
    assert.equal(task.moduleCode, "hero");
    assert.equal(task.sizePreset, "aplus_premium_web");
    assert.equal(task.sortOrder, 1);
    await tasks.createAplusTasks([
      { ...taskRow, id: randomUUID(), ordinal: 2, sortOrder: 2, sizePreset: "aplus_premium_mobile" },
      { ...taskRow, id: randomUUID(), ordinal: 3, sortOrder: 3, moduleCode: "usage_scene" },
      { ...taskRow, id: randomUUID(), ordinal: 4, sortOrder: 4, moduleCode: "usage_scene", sizePreset: "aplus_premium_mobile" },
    ]);
    const orderPath = `/api/aplus/${suite.id}/order`;
    assert.equal((await app.request("PATCH", orderPath, { body: { modules: ["hero"] } })).status, 409);
    assert.deepEqual((await tasks.listTasks(suite.id)).map(({ sortOrder }) => sortOrder), [1, 2, 3, 4]);
    const reordered = await app.request("PATCH", orderPath, { body: { modules: ["usage_scene", "hero"] } });
    assert.equal(reordered.status, 200, JSON.stringify(reordered.body));
    assert.deepEqual((await tasks.listTasks(suite.id)).map(({ sortOrder }) => sortOrder), [2, 2, 1, 1]);
    const { run } = await pipelines.createRun({ ...runningPipeline(suite.id), currentPhase: "aplus_planning" });
    assert.equal(run.currentPhase, "aplus_planning");
    const awaiting = await pipelines.updateRun(run.id, {
      currentPhase: "awaiting_confirmation", status: "waiting_human_input",
      config: { planSnapshot: { modules: ["hero"] } },
    }, run);
    assert.equal(awaiting?.currentPhase, "awaiting_confirmation");
    const edited = await pipelines.updateRun(run.id, {
      config: { planSnapshot: { modules: [{ moduleCode: "hero", copyRequirements: "新文案" }] } },
    }, awaiting);
    assert.ok(edited);
    assert.equal(await pipelines.updateRun(run.id, { config: {} }, awaiting), null);
    assert.equal(await pipelines.resumeRun(awaiting, "stale-confirm", "image_generating", awaiting.config), null);

    const batchId = randomUUID();
    const slotId = randomUUID();
    const attemptId = randomUUID();
    const productInputs = ["product", "product_primary", "product_detail"].map((role, index) => ({
      objectKey: `suites/${suite.id}/inputs/product-${index + 1}/original`, role,
    }));
    const normalizedProducts = productInputs.map(({ objectKey }) => ({ objectKey, role: "product" }));
    const productBytes = await Promise.all(["red", "green", "blue"].map((background) =>
      sharp({ create: { width: 80, height: 60, channels: 3, background } }).png().toBuffer()));
    for (const [index, { objectKey }] of productInputs.entries()) {
      await storage.put({ key: objectKey, bytes: productBytes[index], contentType: "image/png" });
    }
    const initialReservation = await tasks.beginBatch({
      batch: { id: batchId, suiteId: suite.id, kind: "single", requestedCount: 1, taskIds: [taskId], status: "running", idempotencyKey: "image", createdAt: timestamp, startedAt: timestamp, finishedAt: null },
      slots: [{ id: slotId, batchId, taskId, slotOrdinal: 1, retryOfSlotId: null, status: "generating", selectedVersionId: null, createdAt: timestamp, completedAt: null }],
      attempts: [{
        id: attemptId, slotId, attemptNo: 1, provider: "fake", model: "fake", endpoint: "/v1/images/edits",
        requestSummary: {}, promptSnapshot: {}, promptSha256: "a".repeat(64),
        contextSnapshot: { inputImages: [...productInputs, { objectKey: "reference.png", role: "reference" }] }, sourceKind: "original",
        sourceObjectKey: productInputs[0].objectKey, sourceInputImageId: null, sourceBaseVersionId: null, status: "running",
        errorCode: null, errorMessage: null, externalRequestId: null, startedAt: timestamp, finishedAt: null,
      }],
    });
    const generatedSize = { width: 2496, height: 1024 };
    const deliverySize = { width: 1464, height: 600 };
    const { version } = await tasks.completeAttempt({
      attemptId, slotId, taskId, completedAt: timestamp, processObjectKeys: ["generated.png"], sha256: "b".repeat(64),
      objectKey: "generated.png", mimeType: "image/png", ...generatedSize,
      generatedSize, deliverySize, deliveryObjectKey: "delivery.png",
    });
    assert.equal(version.objectKey, "generated.png");
    assert.deepEqual(version.generatedSize, generatedSize);
    assert.deepEqual(version.deliverySize, deliverySize);
    assert.equal(version.deliveryObjectKey, "delivery.png");
    const prompts = new PostgresPromptRepository(pool);
    const editor = new PostgresImageEditorRepository(pool);
    const library = new PostgresLibraryRepository(pool);
    const original = await sharp({ create: { ...generatedSize, channels: 3, background: "navy" } }).png().toBuffer();
    await storage.put({ key: version.objectKey, bytes: original, contentType: "image/png" });
    await storage.put({ key: version.deliveryObjectKey!, bytes: await sharp(original).resize(deliverySize).png().toBuffer(), contentType: "image/png" });
    const editorCalls: ImageEditRequest[] = [];
    const fakeProvider = {
      async edit(request: ImageEditRequest) {
        editorCalls.push(request);
        return { bytes: original, mimeType: "image/png" };
      },
    };
    const service = new ImageEditorService(editor, {
      name: "fake", version: "1", capabilitiesVersion: "1",
      capabilities: () => ({ addText: true, imageToImage: true, changeText: true, redraw: true, erase: true, outpaint: true, currentVersionInput: true }),
      edit: (command, source) => requestImageEditorEdit(fakeProvider, storage, "fake", defaultImageOptions("gpt-image-2"), command, source),
    }, storage, async (sourceVersionId) => {
      const source = await editor.getSourceVersion(sourceVersionId);
      const object = source && await storage.get(source.objectKey);
      if (!source || !object) return null;
      const { width, height } = await sharp(object.bytes).metadata();
      return { ...source, bytes: object.bytes, width, height };
    }, undefined, (cardId, versionId) => editor.validateSource(cardId, versionId), prompts,
    async (sourceVersionId) => (await editor.getSourceVersion(sourceVersionId))?.productInputs ?? null);
    const editorApp = createSuiteStudioApp({ repository: suites, storage, taskRepository: tasks, imageEditorApi: createImageEditorApi(service), libraryRepository: library });
    const assertLibraryImage = async (id: string, objectKey: string, previewUrl: string | null) => {
      const resource = await library.getResource(id);
      assert.ok(resource);
      assert.equal(resource.stage, "aplus_image");
      assert.equal(resource.source.origin, "aplus");
      assert.equal(resource.source.originKind, "aplus");
      assert.equal(resource.source.objectKey, objectKey);
      assert.equal(resource.previewUrl, previewUrl);
      const { items } = await library.listResources({ scope: "image", stage: "aplus_image", suiteId: suite.id, query: "A+详情" });
      assert.deepEqual(items.find((item) => item.id === id), resource);
      const bytes = (await storage.get(objectKey))!.bytes;
      if (previewUrl) {
        const { width, height } = await sharp(bytes).metadata();
        assert.ok(resource.summary.endsWith(` · ${width} × ${height}`));
      }
      assert.deepEqual((await editorApp.request("GET", `/api/library/resources/${encodeURIComponent(id)}/preview`)).raw, bytes);
      if (previewUrl) assert.deepEqual((await editorApp.request("GET", previewUrl)).raw, bytes);
    };
    const previewUrl = `/api/suite-tasks/${taskId}/versions/${version.id}/preview`;
    await assertLibraryImage(`task-version:${version.id}`, version.deliveryObjectKey!, `${previewUrl}/delivery`);
    await assertLibraryImage(`process:${version.id}:0`, version.objectKey, null);
    await pool.query("UPDATE suite_workbench.task_image_versions SET delivery_object_key = NULL WHERE id = $1", [version.id]);
    await assertLibraryImage(`task-version:${version.id}`, version.objectKey, previewUrl);
    await pool.query("UPDATE suite_workbench.task_image_versions SET delivery_object_key = $2 WHERE id = $1", [version.id, version.deliveryObjectKey]);
    const sessionPath = `/api/image-editor/sessions/${taskId}`;
    const draft = await editorApp.request("GET", `${sessionPath}?sourceVersionId=${version.id}`);
    assert.equal(draft.status, 200);
    const candidates = draft.body.data.productInputs as Array<{ objectKey: string; thumbnailUrl: string }>;
    assert.deepEqual(candidates.map(({ objectKey }) => objectKey), productInputs.map(({ objectKey }) => objectKey));
    for (const { thumbnailUrl } of candidates) {
      const thumbnail = await editorApp.request("GET", thumbnailUrl);
      assert.equal(thumbnail.status, 200);
      assert.equal((await sharp(thumbnail.raw!).metadata()).format, "webp");
    }
    const restore = await editorApp.request("POST", `${sessionPath}/operations`, { body: { operation: {
      operationId: "restore", type: "restore_product", order: 1, summary: "商品还原",
      sourceCardId: taskId, sourceVersionId: version.id, parentVersionId: version.id, payload: {},
    } } });
    assert.equal(restore.status, 200);
    const submitted = await editorApp.request("POST", `${sessionPath}/submit`, {
      headers: { "idempotency-key": "aplus-image-restore" },
      body: { tool: "restore_product", sourceCardId: taskId, sourceVersionId: version.id, operationIds: ["restore"] },
    });
    assert.equal(submitted.status, 202, JSON.stringify(submitted.body));
    const childId = submitted.body.data.childTask.id;
    const child = await waitUntil(() => service.getTask(childId), (result) => Boolean(result && result.task.status !== "generating"), 5_000);
    assert.equal(child?.task.status, "succeeded", child?.task.errorCode ?? undefined);
    const [editedImage] = child!.versions;
    assert.deepEqual(child?.snapshot?.attachedInputs, normalizedProducts);
    assert.deepEqual(editorCalls.map(({ images }) => images?.map(({ role, bytes }) => [role, bytes])), [
      [["source", original], ...productBytes.map((bytes) => ["product", bytes])],
    ]);
    assert.match(editorCalls[0].prompt, /^第 1 张为待编辑图，其余为商品外观依据/);
    assert.equal(editorCalls[0].size, "2496x1024");
    assert.deepEqual((await editor.getSourceVersion(editedImage.id))?.productInputs, normalizedProducts);
    assert.deepEqual(editedImage.generatedSize, generatedSize);
    assert.deepEqual(editedImage.deliverySize, deliverySize);
    assert.notEqual(editedImage.deliveryObjectKey, editedImage.objectKey);
    const delivery = await storage.get(editedImage.deliveryObjectKey!);
    assert.ok(delivery);
    const editPreview = `/api/image-editor/tasks/${childId}/versions/${editedImage.id}/preview`;
    const preview = await editorApp.request("GET", editPreview);
    assert.deepEqual(preview.raw, (await storage.get(editedImage.objectKey))?.bytes);
    assert.equal(preview.headers?.["content-type"], editedImage.mimeType);
    assert.deepEqual((await editorApp.request("GET", editPreview + "/delivery")).raw, delivery.bytes);
    const wrongTask = await editorApp.request("GET", `/api/image-editor/tasks/${taskId}/versions/${editedImage.id}/preview`);
    assert.equal(wrongTask.status, 404);
    assert.equal(wrongTask.body.error.code, "NOT_FOUND");
    const { width, height } = await sharp(delivery.bytes).metadata();
    assert.deepEqual({ width, height }, deliverySize);
    await assertLibraryImage(`edit-version:${editedImage.id}`, editedImage.deliveryObjectKey!, `/api/image-editor/tasks/${childId}/versions/${editedImage.id}/preview/delivery`);

    for (const [type, payload] of [
      ["change_text", { originalText: "旧文案", newText: "新文案", region: { x: 0.1, y: 0.1, width: 0.4, height: 0.2 } }],
      ["re_edit", { prompt: "调整背景" }],
    ] as const) {
      await service.upsertOperation({ sessionId: `aplus-${type}`, operation: {
        type, payload, operationId: type, order: 1, summary: type,
        sourceCardId: childId, sourceVersionId: editedImage.id, parentVersionId: editedImage.id,
      } });
      const edited = await service.submit({
        sessionId: `aplus-${type}`, idempotencyKey: `aplus-${type}`, sourceCardId: childId, sourceVersionId: editedImage.id, tool: type,
      });
      const result = await waitUntil(() => service.getTask(edited.childTask.id), (task) => task?.task.status !== "generating", 5_000);
      assert.equal(result?.task.status, "succeeded", result?.task.errorCode ?? undefined);
      const replay = await service.regenerate({ childTaskId: edited.childTask.id, idempotencyKey: `aplus-${type}-regenerate` });
      const regenerated = await waitUntil(() => service.getTask(replay.childTask.id), (task) => task?.task.status !== "generating", 5_000);
      assert.equal(regenerated?.task.status, "succeeded", regenerated?.task.errorCode ?? undefined);
      assert.equal(regenerated?.versions.length, 2);
      assert.deepEqual(regenerated?.versions[0].deliverySize, deliverySize);
    }
    assert.deepEqual(editorCalls.map(({ size }) => size), Array(5).fill("2496x1024"));

    const previewTasks = [
      { path: "/api/suite-tasks", taskId, versionId: version.id },
      { path: "/api/image-editor/tasks", taskId: childId, versionId: editedImage.id },
    ];
    for (const target of previewTasks) {
      for (const format of ["preview", "preview/delivery"]) {
        for (const [taskId, versionId] of [["invalid", target.versionId], [target.taskId, "invalid"]]) {
          const preview = await editorApp.request("GET", `${target.path}/${taskId}/versions/${versionId}/${format}`);
          assert.equal(preview.status, 404);
          assert.equal(preview.body.error.code, "INVALID_TASK_VERSION");
        }
      }
    }

    const stages = ["aplus_plan", "aplus_module_rule", "aplus_image", "aplus_ai_write"] as const;
    for (const stage of stages) {
      const templateId = randomUUID();
      const versionId = randomUUID();
      const target = stage === "aplus_image" ? "image_model" : "llm";
      await pool.query(
        "INSERT INTO prompt_library.prompt_templates (id,code,name,kind,stage,execution_target) VALUES ($1,$2,$2,'planner',$3,$4)",
        [templateId, `test.${stage}`, stage, target],
      );
      await pool.query(
        `INSERT INTO prompt_library.prompt_template_versions
           (id,template_id,version_no,name,kind,stage,execution_target,body,status,source_file,source_heading,source_sha256)
         VALUES ($1,$2,1,$3,'planner',$3,$4,'Fixture prompt','published','aplus-fixture.md',$5,$6)`,
        [versionId, templateId, stage, target, stage, "a".repeat(64)],
      );
      await pool.query("UPDATE prompt_library.prompt_templates SET published_version_id=$1 WHERE id=$2", [versionId, templateId]);
    }
    const editorPromptCodes = new Set(["image-editor.restore_product", "image-editor.change_text"]);
    const publishedEditorPrompts = async () => (await prompts.listPublished("task_image"))
      .filter(({ code }) => editorPromptCodes.has(code))
      .map(({ code, templateVersionId, versionNo }) => [code, templateVersionId, versionNo]);
    const editorPrompts = await publishedEditorPrompts();
    assert.equal(editorPrompts.length, 2);
    const orphanBatchId = randomUUID(), orphanSlotId = randomUUID(), orphanAttemptId = randomUUID();
    await tasks.beginBatch({
      batch: { ...initialReservation.batch, id: orphanBatchId, idempotencyKey: "unacknowledged-redraw" },
      slots: [{ ...initialReservation.slots[0], batchId: orphanBatchId, id: orphanSlotId }],
      attempts: [{ ...initialReservation.attempts[0], slotId: orphanSlotId, id: orphanAttemptId }],
    });
    await runMigrations(pool, { recoverStaleAttempts: true });
    assert.equal((await tasks.getAttempt(orphanAttemptId))?.errorCode, "PIPELINE_INTERRUPTED");
    assert.equal((await tasks.getBatch(orphanBatchId))?.status, "failed");
    assert.equal((await tasks.getSlot(orphanSlotId))?.status, "failed");
    assert.equal((await tasks.listTaskVersions(taskId)).attempts.length, 2);
    assert.deepEqual(await publishedEditorPrompts(), editorPrompts);
    assert.deepEqual((await platforms.find("amazon"))?.detailSizePresets, configured);
    assert.equal((await suites.getSuite(suite.id))?.origin, "aplus");
    assert.equal((await tasks.getTask(taskId))?.originKind, "aplus");
    assert.equal((await pipelines.getRun(run.id))?.currentPhase, "awaiting_confirmation");
    assert.equal((await pipelines.resumeRun(edited, "current-confirm", "image_generating", edited.config))?.currentPhase, "image_generating");
    assert.deepEqual((await tasks.listTaskVersions(taskId)).versions[0], version);
    assert.deepEqual((await editor.listVersions(childId))[0], editedImage);
    assert.deepEqual((await editor.getSourceVersion(editedImage.id))?.productInputs, normalizedProducts);
    for (const stage of stages) {
      const { rows: [template] } = await pool.query<{ stage: string }>(
        "SELECT stage FROM prompt_library.prompt_templates WHERE code=$1", [`test.${stage}`],
      );
      assert.equal(template.stage, stage);
      assert.equal((await prompts.listPublished(stage))[0]?.stage, stage);
    }
    const transaction = await pool.connect();
    try {
      await transaction.query("BEGIN");
      await assert.rejects(transaction.query("UPDATE prompt_library.prompt_templates SET stage='invalid' WHERE code='test.aplus_plan'"), {
        code: "23514", constraint: "prompt_templates_stage_check",
      });
    } finally {
      await transaction.query("ROLLBACK");
      transaction.release();
    }
  });
});

test("043 and 050–053 publish all 19 A+ Markdown templates and preserve user publishes and retirements on replay", { skip }, async () => {
  await withMigratedSchemas(async ({ pool }) => {
    const prompts = new PostgresPromptRepository(pool);
    const versionThreeCodes = new Set([
      "aplus.ai-write",
      "aplus.plan", "aplus.image",
      "aplus.module.accessories", "aplus.module.brand_story", "aplus.module.comparison",
      "aplus.module.craftsmanship", "aplus.module.detail_closeup", "aplus.module.hero",
      "aplus.module.ingredients", "aplus.module.multi_angle", "aplus.module.selling_points",
      "aplus.module.spec_table", "aplus.module.usage_scene",
    ]);
    const singleStages = [
      { stage: "aplus_plan", file: "aplus-plan.md" },
      { stage: "aplus_image", file: "aplus-image.md" },
      { stage: "aplus_ai_write", file: "aplus-ai-write.md" },
    ] as const;
    const published = [];
    for (const { stage, file } of singleStages) {
      assert.equal((await prompts.listPublished(stage)).length, 1);
      published.push({ template: await resolveAplusPromptTemplate(prompts, stage), file });
    }
    assert.equal((await prompts.listPublished("aplus_module_rule")).length, 16);
    for (const { code } of APLUS_MODULES) {
      const template = await resolveAplusPromptTemplate(prompts, "aplus_module_rule", code);
      published.push({ template, file: `aplus-module-${code}.md` });
    }

    const records = await Promise.all(published.map(async ({ template, file }) => {
      assert.ok(template, file);
      const sourceFile = `prompt/normalized/${file}`;
      const record = parseNormalizedPromptMarkdown(await readFile(sourceFile, "utf8"), sourceFile);
      const versionNo = versionThreeCodes.has(record.code) ? 3 : 2;
      assert.deepEqual(template, { ...record, status: "published", versionNo, usedBy: template.usedBy });
      assert.ok(template.usedBy?.length, file);
      return record;
    }));

    await runMigrations(pool);
    for (const publish of [false, true]) {
      const reimported = await importPromptRecordsWithPolicy(prompts, records, { publish });
      assert.deepEqual(reimported, published.map(({ template }) => template));
    }
    for (const record of records) {
      const versions = await prompts.listVersions(record.templateId);
      assert.deepEqual(versions.map(({ versionNo, status }) => [versionNo, status]), versionThreeCodes.has(record.code)
        ? [[1, "retired"], [2, "retired"], [3, "published"]]
        : [[1, "retired"], [2, "published"]]);
    }

    const plan = await resolveAplusPromptTemplate(prompts, "aplus_plan");
    assert.ok(plan);
    const draft = await prompts.copyVersion(plan.templateVersionId);
    assert.ok(draft);
    await prompts.publishVersion(draft.templateVersionId);
    const hero = await resolveAplusPromptTemplate(prompts, "aplus_module_rule", "hero");
    assert.ok(hero);
    await prompts.retireVersion(hero.templateVersionId);

    const aiWrite = await resolveAplusPromptTemplate(prompts, "aplus_ai_write");
    assert.ok(aiWrite);
    const custom = await prompts.copyVersion(aiWrite.templateVersionId);
    assert.ok(custom);
    await prompts.publishVersion(custom.templateVersionId);

    await runMigrations(pool);
    assert.equal((await resolveAplusPromptTemplate(prompts, "aplus_plan"))?.templateVersionId, draft.templateVersionId);
    assert.equal(await resolveAplusPromptTemplate(prompts, "aplus_module_rule", "hero"), null);
    assert.equal((await resolveAplusPromptTemplate(prompts, "aplus_ai_write"))?.templateVersionId, custom.templateVersionId);

    await prompts.retireVersion(custom.templateVersionId);
    await runMigrations(pool);
    assert.equal(await resolveAplusPromptTemplate(prompts, "aplus_ai_write"), null);
    assert.deepEqual((await prompts.listVersions(aiWrite.templateId)).map(({ versionNo }) => versionNo), [1, 2, 3, 4]);
  });
});

test("053 fills the missing video preference and preserves configured defaults on replay", { skip }, async () => {
  await withMigratedSchemas(async ({ pool }) => {
    const repository = new PostgresModelSettingsRepository(pool);
    const settings = new ModelSettings(repository);
    const path = "/api/model-settings";
    const created = await settings.request("POST", path + "/channels", {
      name: "商品视频", protocol: "openai-compatible", baseUrl: "https://channel.test", apiKey: "offline",
      models: [{ id: "multimedia", capabilities: ["image", "video"] }],
    });
    assert.equal(created.status, 201);
    const ref = { channelId: (await repository.read()).channels[0].id, modelId: "multimedia" };
    await settings.request("PATCH", path + "/preferences", { image: ref });
    await pool.query("UPDATE suite_workbench.model_settings SET state = state #- '{preferences,video}'");
    const migration = await readFile("db/migrations/053_aplus_ai_write_tighten.sql", "utf8");
    await pool.query(migration);
    assert.deepEqual((await repository.read()).preferences, { image: ref, vision: null, video: null });
    assert.equal((await settings.request("PATCH", path + "/preferences", { video: ref })).status, 200);
    await pool.query(migration);
    assert.deepEqual((await repository.read()).preferences, { image: ref, vision: null, video: ref });
    assert.equal((await settings.resolve("video"))?.model, "multimedia");
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

    // Importing unchanged replica markdown after 036 v2 seed must match published v2 without creating duplicate v3 drafts
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
      assert.equal(version.versionNo, 2);
      assert.equal(version.status, "published");
      const allVersions = await prompts.listVersions(version.templateId);
      assert.equal(allVersions.length, 2);
      assert.equal(allVersions[0].versionNo, 1);
      assert.equal(allVersions[0].status, "retired");
      assert.equal(allVersions[1].versionNo, 2);
      assert.equal(allVersions[1].status, "published");
    }

    // Verify v2 published bodies reflect compose/high split while v1 stays preserved for historical snapshots
    const publishedCompose = imported.find((v) => v.code === "replica.compose")!;
    const publishedHigh = imported.find((v) => v.code === "replica.high")!;
    assert.doesNotMatch(publishedCompose.body, /迁移配色逻辑/);
    assert.match(publishedCompose.body, /保留清单/);
    assert.match(publishedCompose.body, /必须改变清单/);
    assert.match(publishedHigh.body, /九宫格/);
    assert.match(publishedHigh.body, /与参考图保持相同的构图与元素位置，只替换为目标商品和新文案/);

    // Semantic match in PG excludes retired versions and prefers published over draft
    const composeCopyDraft = await prompts.copyVersion(publishedCompose.templateVersionId);
    assert.ok(composeCopyDraft);
    const [preferredPgPublished] = await prompts.importRecords([
      { ...composeRecord, sourceSha256: "b".repeat(64), templateVersionId: randomUUID() },
    ]);
    assert.equal(preferredPgPublished.templateVersionId, publishedCompose.templateVersionId);
    assert.equal(preferredPgPublished.status, "published");

    await prompts.retireVersion(publishedCompose.templateVersionId);
    await prompts.retireVersion(composeCopyDraft.templateVersionId);
    const [freshDraftAfterRetire] = await prompts.importRecords([
      { ...composeRecord, sourceSha256: "c".repeat(64), templateVersionId: randomUUID() },
    ]);
    assert.equal(freshDraftAfterRetire.status, "draft");
    assert.notEqual(freshDraftAfterRetire.templateVersionId, publishedCompose.templateVersionId);
    assert.equal(freshDraftAfterRetire.versionNo, 4);
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

test("PostgresTaskRepository sets archived_at on archive and PostgresLibraryRepository exposes replica task versions and upserts replica reverse assets", { skip }, async () => {
  await withMigratedSchemas(async ({ pool }) => {
    const suites = new PostgresSuiteRepository(pool);
    const tasks = new PostgresTaskRepository(pool);
    const library = new PostgresLibraryRepository(pool);

    const replicaSuite = await suites.createSuite("PG 复刻资源库测试", undefined, "replica");
    const refId = randomUUID();
    await pool.query(
      `INSERT INTO suite_workbench.replica_references
         (id, suite_id, ordinal, filename, mime_type, sha256, width, height, object_key, thumbnail_object_key, remark, created_at)
       VALUES ($1, $2, 1, 'ref.png', 'image/png', $3, 512, 512, $4, $5, '', $6)`,
      [
        refId,
        replicaSuite.id,
        "a".repeat(64),
        `replicas/${replicaSuite.id}/references/${refId}/original`,
        `replicas/${replicaSuite.id}/references/${refId}/thumbnail`,
        timestamp,
      ],
    );

    const { created } = await tasks.createReplicaTasks({
      suiteId: replicaSuite.id,
      items: [
        {
          referenceId: refId,
          referenceObjectKey: `replicas/${replicaSuite.id}/references/${refId}/original`,
          ordinal: 1,
          title: "复刻图 1",
          purpose: "爆品图复刻",
          prompt: "PG 复刻提示词",
          generationParams: { size: "1K", ratio: "1:1" },
        },
      ],
    });
    const task = created[0];
    const productInputs = [
      { objectKey: `replicas/${replicaSuite.id}/products/front/original`, role: "product" },
      { objectKey: `replicas/${replicaSuite.id}/products/side/original`, role: "product" },
    ];
    const batchId = randomUUID();
    const slotId = randomUUID();
    const attemptId = randomUUID();
    await tasks.beginBatch({
      batch: {
        id: batchId,
        suiteId: replicaSuite.id,
        kind: "single",
        requestedCount: 1,
        taskIds: [task.id],
        status: "running",
        idempotencyKey: "pg-replica-lib-1",
        createdAt: timestamp,
        startedAt: timestamp,
        finishedAt: null,
      },
      slots: [
        {
          id: slotId,
          batchId,
          taskId: task.id,
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
          model: "gpt-image-2",
          endpoint: "/v1/images/edits",
          requestSummary: {},
          promptSnapshot: { prompt: "PG 复刻提示词" },
          promptSha256: "b".repeat(64),
          contextSnapshot: { inputImages: [
            { ...productInputs[0], role: "product_primary" },
            { objectKey: `replicas/${replicaSuite.id}/references/${refId}/original`, role: "replica_reference" },
            { ...productInputs[1], role: "product_detail" },
          ] },
          sourceKind: "original",
          sourceObjectKey: `replicas/${replicaSuite.id}/references/${refId}/original`,
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
      taskId: task.id,
      objectKey: `suites/${replicaSuite.id}/tasks/${task.id}/versions/v1/final.png`,
      processObjectKeys: [],
      sha256: "c".repeat(64),
      width: 512,
      height: 512,
      mimeType: "image/png",
      completedAt: timestamp,
    });

    const listed = await library.listResources({ resourceType: "task_image_version", status: "published" });
    const found = listed.items.find((item) => item.id === `task-version:${version.id}`);
    assert.ok(found, "replica task_image_version must appear in library resources");
    assert.equal(found.stage, "replica_prompt");
    assert.equal(found.source.origin, "replica");
    assert.match(found.summary, /爆品图复刻/);

    // createReverseReferenceAsset persists replica provenance and upserts cleanly on duplicate objectKey
    const objKey = `replicas/${replicaSuite.id}/references/${refId}/original`;
    const saved1 = await library.createReverseReferenceAsset({
      suiteId: replicaSuite.id,
      title: "复刻反推 1",
      summary: "复刻反推",
      objectKey: objKey,
      mimeType: "image/png",
      promptSnapshot: { prompt: "初版提示词" },
      source: { origin: "replica", replicaSuiteId: replicaSuite.id, taskId: task.id },
    });
    assert.equal(saved1.stage, "replica_prompt");
    assert.equal(saved1.source.origin, "replica");

    const saved2 = await library.createReverseReferenceAsset({
      suiteId: replicaSuite.id,
      title: "复刻反推 1",
      summary: "复刻反推更新",
      objectKey: objKey,
      mimeType: "image/png",
      promptSnapshot: { prompt: "修订提示词" },
      source: { origin: "replica", replicaSuiteId: replicaSuite.id, taskId: task.id },
    });
    assert.equal(saved2.id, saved1.id);
    assert.equal(saved2.promptSnapshot?.prompt, "修订提示词");

    // clearFinalVersion & PostgresImageEditorRepository.clearFinalVersions clear final locks cleanly
    await tasks.selectVersion(task.id, version.id, "final");
    const beforeClear = await tasks.listTaskVersions(task.id);
    assert.equal(beforeClear.versions.some((v) => v.isFinal), true);
    await tasks.clearFinalVersion(task.id);
    const afterClear = await tasks.listTaskVersions(task.id);
    assert.equal(afterClear.versions.some((v) => v.isFinal), false);

    const editorRepo = new PostgresImageEditorRepository(pool);
    assert.equal(await editorRepo.getSourceVersion("invalid-version"), null);
    await assert.rejects(editorRepo.validateSource(task.id, "invalid-version"), { message: "SOURCE_VERSION_NOT_FOUND" });
    assert.equal(await editorRepo.validateSource(task.id, version.id), true);
    assert.equal(await editorRepo.validateSource(randomUUID(), version.id), false);
    assert.deepEqual(await editorRepo.getSourceVersion(version.id), {
      objectKey: version.objectKey, mimeType: "image/png", generationPrompt: "PG 复刻提示词", productInputs,
    });
    const prompts = new PostgresPromptRepository(pool);
    const restoreTemplate = (await prompts.listPublished("task_image")).find((item) => item.code === "image-editor.restore_product");
    assert.ok(restoreTemplate);
    const restore = await prompts.getPublishedVersion(restoreTemplate.templateVersionId, "task_image");
    assert.match(restore?.body ?? "", /保持原图的构图、背景、文字/);
    const snapId = randomUUID();
    const childId = randomUUID();
    const editAttemptId = randomUUID();
    await editorRepo.submit({
      idempotencyKey: `pg-edit-clear-${childId}`,
      snapshot: {
        id: snapId,
        sourceCardId: task.id,
        sourceVersionId: version.id,
        parentVersionId: version.id,
        summary: "测试编辑",
        sourcePrompt: "PG 复刻提示词",
        tool: "restore_product",
        attachedInputs: [productInputs[1]],
        promptTemplateVersionId: restoreTemplate.templateVersionId,
        operations: [],
        provider: { name: "fake", version: "1", capabilitiesVersion: "1" },
        createdAt: timestamp,
        schemaVersion: "image-edit-snapshot-v1",
      },
      childTask: {
        id: childId,
        sourceCardId: task.id,
        sourceVersionId: version.id,
        parentVersionId: version.id,
        snapshotId: snapId,
        summary: "测试编辑",
        status: "generating",
        currentVersionId: null,
        finalVersionId: null,
        errorCode: null,
        errorMessage: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      attempt: {
        id: editAttemptId,
        childTaskId: childId,
        snapshotId: snapId,
        attemptNo: 1,
        status: "generating",
        command: { type: "restore_product", sourceVersionId: version.id, prompt: "测试编辑", operations: [], attachedInputs: [productInputs[1]] },
        provider: { name: "fake", version: "1", capabilitiesVersion: "1" },
        errorCode: null,
        errorMessage: null,
        createdAt: timestamp,
        completedAt: null,
      },
    });
    const snapshot = await editorRepo.getSnapshot(snapId);
    assert.equal(snapshot?.tool, "restore_product");
    assert.deepEqual(snapshot?.attachedInputs, [productInputs[1]]);
    assert.equal(snapshot.promptTemplateVersionId, restoreTemplate.templateVersionId);
    const completedEdit = await editorRepo.completeAttempt({
      attemptId: editAttemptId,
      objectKey: `image-edits/${childId}/versions/v1.png`,
      sha256: "d".repeat(64),
      width: 512,
      height: 512,
      mimeType: "image/png",
      completedAt: timestamp,
    });
    assert.deepEqual(await editorRepo.getSourceVersion(completedEdit.version.id), {
      objectKey: completedEdit.version.objectKey, mimeType: "image/png", generationPrompt: "测试编辑", productInputs,
    });
    assert.equal(await editorRepo.validateSource(childId, completedEdit.version.id), true);
    await editorRepo.selectVersion(childId, completedEdit.version.id, "final");
    assert.equal((await editorRepo.getChildTask(childId))?.finalVersionId, completedEdit.version.id);
    await editorRepo.clearFinalVersions([childId]);
    assert.equal((await editorRepo.getChildTask(childId))?.finalVersionId, null);

    // Soft-archiving a task populates archived_at
    const archived = await tasks.updateTask(task.id, { status: "archived" });
    assert.equal(archived?.status, "archived");
    assert.ok(archived?.archivedAt, "PostgresTaskRepository.updateTask must set archived_at when archiving");
  });
});

test("042 persists editor snapshot metadata and consumes only submitted drafts with the published edit prompt", { skip }, async () => {
  await withMigratedSchemas(async ({ pool }) => {
    const editor = new PostgresImageEditorRepository(pool);
    const prompts = new PostgresPromptRepository(pool);
    const original = (await prompts.listPublished("task_image")).find((item) => item.code === "image-editor.add_text");
    assert.ok(original);
    const draft = await prompts.copyVersion(original.templateVersionId);
    assert.ok(draft);
    await prompts.updateDraft(draft.templateVersionId, {
      body: "保留图片中的商品和原有文字。",
      userPromptTemplate: "只在{{region}}添加新文字「{{text}}」。",
    });
    await prompts.publishVersion(draft.templateVersionId);
    await runMigrations(pool);
    assert.equal((await prompts.getPublishedVersion(draft.templateVersionId, "task_image"))?.body, "保留图片中的商品和原有文字。");

    const source = { bytes: Buffer.from("source"), width: 1024, height: 1024, mimeType: "image/png" };
    const service = new ImageEditorService(editor, {
      name: "fake", version: "1", capabilitiesVersion: "1",
      capabilities: () => ({ addText: true, imageToImage: true, changeText: true, redraw: true, erase: true, outpaint: true, currentVersionInput: true }),
      edit: async () => source,
    }, new MemoryStorage(), async () => source, undefined, undefined, prompts);
    const operation = {
      operationId: "op1", type: "add_text" as const, order: 1, sourceCardId: "card",
      sourceVersionId: "version-1", parentVersionId: "version-1", summary: "添加文字",
      payload: { text: "样例", prompt: "保留原格式" },
    };
    await service.upsertOperation({ sessionId: "card", operation });
    await service.upsertOperation({ sessionId: "card", operation: { ...operation, sourceVersionId: "version-2" } });
    const result = await service.submit({
      sessionId: "card", idempotencyKey: "042-editor-submit", sourceCardId: "card", sourceVersionId: "version-1",
      tool: "add_text", operationIds: [operation.operationId],
    });
    assert.deepEqual((await editor.getDraft("card"))?.operations.map((item) => item.sourceVersionId), ["version-2"]);
    const snapshot = await editor.getSnapshot(result.snapshot.id);
    assert.equal(snapshot?.tool, "add_text");
    assert.deepEqual(snapshot?.attachedInputs, []);
    assert.equal(snapshot?.maskApplied, false);
    assert.equal(snapshot?.promptTemplateVersionId, draft.templateVersionId);
    assert.equal((await editor.getAttempt(result.attempt.id))?.command.prompt, "保留图片中的商品和原有文字。\n只在画面指定区域添加新文字「样例」。");
    for (let i = 0; i < 30 && (await editor.getChildTask(result.childTask.id))?.status === "generating"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal((await editor.getChildTask(result.childTask.id))?.status, "succeeded");

    const constraints = [
      ["SET prompt_template_version_id=$2", randomUUID(), "23503", "image_edit_snapshots_prompt_template_version_fk"],
      ["SET attached_inputs_json=$2", "{}", "23514", "image_edit_snapshots_attached_inputs_array"],
    ];
    const tx = await pool.connect();
    try {
      for (const [update, invalidValue, code, constraint] of constraints) {
        await tx.query("BEGIN");
        try {
          await assert.rejects(
            tx.query(`UPDATE suite_workbench.image_edit_snapshots ${update} WHERE id=$1`, [result.snapshot.id, invalidValue]),
            { code, constraint },
          );
        } finally {
          await tx.query("ROLLBACK");
        }
      }
    } finally {
      tx.release();
    }

    const { rows: retained } = await pool.query<{ code: string }>(
      "SELECT code FROM prompt_library.prompt_templates WHERE code <> $1", [original.code],
    );
    assert.deepEqual(await prompts.pruneExcept(retained.map(({ code }) => code)), { deleted: 0, disabled: 1 });
    await runMigrations(pool);
    assert.equal(await prompts.getPublishedVersion(draft.templateVersionId, "task_image"), null);
    assert.equal((await prompts.getVersion(draft.templateVersionId))?.status, "retired");
    assert.equal((await editor.getSnapshot(result.snapshot.id))?.promptTemplateVersionId, draft.templateVersionId);
  });
});

test("045 publishes the batch text-edit prompt and respects subsequent published versions", { skip }, async () => {
  await withMigratedSchemas(async ({ pool }) => {
    const prompts = new PostgresPromptRepository(pool);
    const current = (await prompts.listPublished("task_image")).find((item) => item.code === "image-editor.change_text");
    assert.ok(current);
    assert.equal(current.versionNo, 2);
    const template = await prompts.getPublishedVersion(current.templateVersionId, "task_image");
    assert.match(template?.body ?? "", /^严格保持输入图片中的商品主体外观/);
    assert.match(template?.userPromptTemplate ?? "", /newText 为空时移除原文字，用周围背景自然填补/);
    const history = await prompts.listVersions(current.templateId);
    assert.deepEqual(history.map(({ versionNo, status }) => [versionNo, status]), [[1, "retired"], [2, "published"]]);
    assert.match(history[0].userPromptTemplate, /将\{\{region\}\}的原文字/);

    await runMigrations(pool);
    assert.equal((await prompts.listVersions(current.templateId)).length, 2);
    assert.ok(await prompts.getPublishedVersion(current.templateVersionId, "task_image"));
    const custom = await prompts.copyVersion(current.templateVersionId);
    assert.ok(custom);
    const instruction = "以原图字体呈现全部替换文字。";
    await prompts.updateDraft(custom.templateVersionId, { userPromptTemplate: instruction });
    await prompts.publishVersion(custom.templateVersionId);
    await runMigrations(pool);
    assert.equal((await prompts.getPublishedVersion(custom.templateVersionId, "task_image"))?.userPromptTemplate, instruction);
    assert.equal((await prompts.listVersions(current.templateId)).length, 3);
  });
});

test("048 publishes the three fallback prompts and preserves user-published versions on migration replay", { skip }, async () => {
  await withMigratedSchemas(async ({ pool }) => {
    const prompts = new PostgresPromptRepository(pool);
    const published = await prompts.listPublished("task_image");
    const expectations = [
      ["redraw", /仅重绘\{\{region\}\}/],
      ["erase", /仅消除\{\{region\}\}/],
      ["outpaint", /仅补全灰色扩展区/],
    ] as const;
    for (const [tool, instruction] of expectations) {
      const current = published.find(({ code }) => code === `image-editor.${tool}`);
      assert.ok(current);
      const history = await prompts.listVersions(current.templateId);
      assert.deepEqual(history.map(({ versionNo, status }) => [versionNo, status]), [[1, "retired"], [2, "published"]]);
      assert.match(history[1].userPromptTemplate, instruction);
      const custom = await prompts.copyVersion(current.templateVersionId);
      assert.ok(custom);
      await prompts.updateDraft(custom.templateVersionId, { userPromptTemplate: "保留原图的光影与透视。" });
      await prompts.publishVersion(custom.templateVersionId);
    }

    await runMigrations(pool);
    for (const [tool] of expectations) {
      const current = (await prompts.listPublished("task_image")).find(({ code }) => code === `image-editor.${tool}`);
      assert.equal(current?.versionNo, 3);
      assert.equal((await prompts.getPublishedVersion(current.templateVersionId, "task_image"))?.userPromptTemplate, "保留原图的光影与透视。");
    }
  });
});

test("048 replays after the original fallback templates are republished through the API", { skip }, async () => {
  await withMigratedSchemas(async ({ pool }) => {
    const prompts = new PostgresPromptRepository(pool);
    const app = createSuiteStudioApp({ repository: new PostgresSuiteRepository(pool), storage: new MemoryStorage(), promptRepository: prompts });
    const fallbackCodes = ["image-editor.redraw", "image-editor.erase", "image-editor.outpaint"];
    const active = (await prompts.listPublished("task_image")).filter(({ code }) => fallbackCodes.includes(code));
    assert.equal(active.length, fallbackCodes.length);
    const originals = [];
    for (const current of active) {
      const [original] = await prompts.listVersions(current.templateId);
      assert.equal(original.status, "retired");
      const response = await app.request("POST", `/api/prompt-templates/${original.templateVersionId}/publish`);
      assert.equal(response.status, 200);
      originals.push(original);
    }

    await runMigrations(pool);
    for (const original of originals) {
      assert.ok(await prompts.getPublishedVersion(original.templateVersionId, "task_image"));
      const history = await prompts.listVersions(original.templateId);
      assert.deepEqual(history.map(({ versionNo, status }) => [versionNo, status]), [[1, "published"], [2, "retired"]]);
    }
  });
});

test("044 preserves the published product restoration template v2 on migration replay", { skip }, async () => {
  await withMigratedSchemas(async ({ pool }) => {
    const prompts = new PostgresPromptRepository(pool);
    const original = (await prompts.listPublished("task_image")).find((item) => item.code === "image-editor.restore_product");
    assert.ok(original);
    assert.equal(original.versionNo, 1);

    const draft = await prompts.copyVersion(original.templateVersionId);
    assert.ok(draft);
    assert.equal(draft.versionNo, 2);
    const instruction = "依据商品原图还原商品细节，保留待编辑图的构图和背景。";
    await prompts.updateDraft(draft.templateVersionId, { userPromptTemplate: instruction });
    await prompts.publishVersion(draft.templateVersionId);

    await runMigrations(pool);
    const current = (await prompts.listPublished("task_image")).find((item) => item.code === original.code);
    assert.equal(current?.templateVersionId, draft.templateVersionId);
    assert.equal((await prompts.getPublishedVersion(draft.templateVersionId, "task_image"))?.userPromptTemplate, instruction);
    assert.deepEqual((await prompts.listVersions(original.templateId)).map(({ versionNo, status }) => [versionNo, status]), [[1, "retired"], [2, "published"]]);
  });
});

test("047 publishes the AI edit wrapper and new submissions use the latest published version only for explicit changes", { skip }, async () => {
  await withMigratedSchemas(async ({ pool }) => {
    const prompts = new PostgresPromptRepository(pool);
    const original = (await prompts.listPublished("task_image")).find((item) => item.code === "image-editor.re_edit");
    assert.ok(original);
    const template = await prompts.getPublishedVersion(original.templateVersionId, "task_image");
    assert.match(template?.body ?? "", /^严格保持待编辑图中未指定修改的商品主体外观/);
    assert.equal(template?.userPromptTemplate, "只执行以下修改：{{instruction}}");

    const draft = await prompts.copyVersion(original.templateVersionId);
    assert.ok(draft);
    await prompts.updateDraft(draft.templateVersionId, { body: "保留未指定修改的内容。", userPromptTemplate: "按此调整：{{instruction}}" });
    await prompts.publishVersion(draft.templateVersionId);
    await runMigrations(pool);
    assert.deepEqual((await prompts.listVersions(original.templateId)).map(({ versionNo, status }) => [versionNo, status]), [[1, "retired"], [2, "published"]]);

    const sourceCardId = randomUUID();
    const sourceVersionId = randomUUID();
    const sourcePrompt = "来源版本的生成提示词";
    const image = { bytes: Buffer.from("source"), mimeType: "image/png", width: 64, height: 64 };
    const editor = new PostgresImageEditorRepository(pool);
    const service = new ImageEditorService(editor, {
      name: "fake-editor", version: "1", capabilitiesVersion: "1",
      capabilities: () => ({ imageToImage: true, currentVersionInput: true, addText: false, changeText: false, redraw: false, erase: false, outpaint: false }),
      edit: async () => image,
    }, new MemoryStorage(), async () => ({ ...image, generationPrompt: sourcePrompt }), undefined, undefined, prompts);
    const submit = async (prompt: string) => {
      await service.upsertOperation({ sessionId: sourceCardId, operation: {
        operationId: randomUUID(), type: "re_edit", order: 1, sourceCardId, sourceVersionId, parentVersionId: sourceVersionId,
        summary: "AI 改图", payload: { prompt },
      } });
      const result = await service.submit({ sessionId: sourceCardId, idempotencyKey: randomUUID(), sourceCardId, sourceVersionId, tool: "re_edit" });
      for (let i = 0; i < 30 && (await editor.getChildTask(result.childTask.id))?.status === "generating"; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const saved = await service.getTask(result.childTask.id);
      assert.equal(saved?.task.status, "succeeded");
      return saved;
    };
    const explicit = await submit("换成浅灰色背景");
    assert.equal(explicit?.snapshot?.promptTemplateVersionId, draft.templateVersionId);
    assert.equal(explicit?.attempts[0].command.prompt, "保留未指定修改的内容。\n按此调整：换成浅灰色背景");
    const blank = await submit(" ");
    assert.equal(blank?.snapshot?.promptTemplateVersionId, null);
    assert.equal(blank?.attempts[0].command.prompt, sourcePrompt);
  });
});

test("035 idempotently retires unused templates, preserves read-by-id & library filtering, and keeps active edit/publish working", { skip }, async () => {
  await withMigratedSchemas(async ({ pool }) => {
    const prompts = new PostgresPromptRepository(pool);
    const library = new PostgresLibraryRepository(pool);
    const aplusCodes = ["aplus.ai-write", "aplus.image", "aplus.plan", ...APLUS_MODULES.map(({ code }) => `aplus.module.${code}`)].sort();
    const editorCodes = ["image-editor.add_text", "image-editor.change_text", "image-editor.erase", "image-editor.outpaint", "image-editor.re_edit", "image-editor.redraw", "image-editor.restore_product"];

    // Legacy reverse templates are retired; replica, onboarding, A+ and editor templates remain published.
    const initialPublished = await prompts.listPublished();
    assert.deepEqual(
      initialPublished.map((item) => item.code).sort(),
      [...aplusCodes, ...editorCodes, "product.onboarding", "replica.compose", "replica.high"],
    );
    assert.equal(initialPublished.find((i) => i.code === "replica.compose")?.versionNo, 2);
    assert.equal(initialPublished.find((i) => i.code === "replica.high")?.versionNo, 2);
    assert.deepEqual(initialPublished.find((i) => i.code === "replica.compose")?.usedBy, ["爆品图复刻·参考风格"]);
    assert.deepEqual(initialPublished.find((i) => i.code === "replica.high")?.usedBy, ["爆品图复刻·高度复刻"]);

    const initialRetired = await prompts.listTemplates({ status: "retired" });
    assert.equal(initialRetired.length, 10, "All 10 reverse_prompt templates seeded by 018 must be retired by 035");
    assert.ok(initialRetired.every((item) => item.stage === "reverse_prompt" && item.status === "retired"));
    assert.ok(initialRetired.every((item) => Array.isArray(item.usedBy) && item.usedBy.length === 0));

    // Retired reverse version remains readable by ID from both prompt repository and library repository
    const retiredReverseId = initialRetired[0].templateVersionId;
    const retiredVersion = await prompts.getVersion(retiredReverseId);
    assert.ok(retiredVersion);
    assert.equal(retiredVersion.status, "retired");
    assert.ok(retiredVersion.body.length > 0);
    const retiredLibResource = await library.getResource(`prompt:${retiredReverseId}`);
    assert.ok(retiredLibResource);
    assert.equal(retiredLibResource.status, "retired");
    assert.deepEqual(retiredLibResource.usedBy, []);

    // 2. Import normalized active + unused templates via seed policy (publish=true)
    const files = [
      "prompt/normalized/general-base-refine.md",
      "prompt/normalized/general-structure-plan-groups.md",
      "prompt/normalized/general-category-prompt-groups.md",
      "prompt/normalized/general-listing-copy.md",
      "prompt/normalized/replica-compose.md",
      "prompt/normalized/replica-high.md",
      "prompt/normalized/general-plan-combined.md",
      "prompt/normalized/seafood-plan-main.md",
      "prompt/normalized/general-repair-design.md",
    ];
    const records = await Promise.all(
      files.map(async (file) => parseNormalizedPromptMarkdown(await readFile(file, "utf8"), file)),
    );
    await importPromptRecordsWithPolicy(prompts, records, { publish: true });

    const activeAfterImport = await prompts.listPublished();
    assert.deepEqual(
      activeAfterImport.map((item) => item.code).sort(),
      [
        ...aplusCodes,
        "general.base_refine",
        "general.category-prompt",
        "general.listing-copy",
        "general.structure-plan",
        ...editorCodes,
        "product.onboarding",
        "replica.compose",
        "replica.high",
      ],
    );

    // Library repository filters published vs retired vs all accurately with usedBy
    const libPublished = await library.listResources({ resourceType: "prompt_template", status: "published", pageSize: 100 });
    assert.equal(libPublished.items.length, 7 + aplusCodes.length + editorCodes.length);
    assert.ok(libPublished.items.every((item) => (item.usedBy?.length ?? 0) > 0));
    const libRetired = await library.listResources({ resourceType: "prompt_template", status: "retired", pageSize: 100 });
    assert.equal(libRetired.items.length, 13); // 10 reverse + 2 plan + 1 repair
    const libAll = await library.listResources({ resourceType: "prompt_template", pageSize: 100 });
    assert.equal(libAll.items.length, 20 + aplusCodes.length + editorCodes.length);

    // 3. Active template copy -> edit draft -> draft filtering -> publish flow works end-to-end in PG
    const baseRefine = activeAfterImport.find((i) => i.code === "general.base_refine")!;
    const draftCopy = await prompts.copyVersion(baseRefine.templateVersionId);
    assert.ok(draftCopy);
    assert.equal(draftCopy.status, "draft");
    const edited = await prompts.updateDraft(draftCopy.templateVersionId, {
      name: "产品图转干净产品底图（精修版）",
      body: `${draftCopy.body}\n保持产品材质与轮廓一致。`,
    });
    assert.ok(edited);
    assert.equal(edited.name, "产品图转干净产品底图（精修版）");

    // status=draft returns latest draft even though template currently has a published version
    const draftCopyLatest = await prompts.copyVersion(edited.templateVersionId);
    assert.ok(draftCopyLatest);
    const pgDraftTemplates = await prompts.listTemplates({ status: "draft" });
    assert.equal(pgDraftTemplates.length, 1);
    assert.equal(pgDraftTemplates[0].templateVersionId, draftCopyLatest.templateVersionId);
    assert.equal(pgDraftTemplates[0].status, "draft");
    const pgLibDrafts = await library.listResources({ resourceType: "prompt_template", status: "draft", pageSize: 100 });
    assert.equal(pgLibDrafts.items.length, 1);
    assert.equal(pgLibDrafts.items[0].templateVersionId, draftCopyLatest.templateVersionId);
    assert.equal(pgLibDrafts.items[0].status, "draft");
    await prompts.retireVersion(draftCopyLatest.templateVersionId);

    // Non-UUID IDs on PostgresPromptRepository return null/[] and HTTP 404 (no PG 22P02 500)
    assert.equal(await prompts.getVersion("demo-reverse-main-v1"), null);
    assert.equal(await prompts.getPublishedVersion("demo-reverse-main-v1"), null);
    assert.deepEqual(await prompts.listVersions("not-a-uuid"), []);
    assert.equal(await prompts.publishVersion("not-a-uuid"), null);
    assert.equal(await prompts.updateDraft("not-a-uuid", { name: "x" }), null);
    assert.equal(await prompts.copyVersion("not-a-uuid"), null);
    assert.equal(await prompts.retireVersion("not-a-uuid"), null);
    const pgPromptApp = createSuiteStudioApp({
      repository: new PostgresSuiteRepository(pool),
      promptRepository: prompts,
      storage: new MemoryStorage(),
    });
    const invalidIdRes = await pgPromptApp.request("GET", "/api/prompt-templates/demo-reverse-main-v1");
    assert.equal(invalidIdRes.status, 404);
    assert.equal((invalidIdRes.body as any).error.code, "PROMPT_TEMPLATE_NOT_FOUND");

    const republished = await prompts.publishVersion(edited.templateVersionId);
    assert.ok(republished);
    assert.equal(republished.status, "published");
    assert.deepEqual(republished.usedBy, ["套图·白底精修"]);

    // Old v1 of general.base_refine is now retired, yet still readable by ID
    const oldV1 = await library.getResource(`prompt:${baseRefine.templateVersionId}`);
    assert.ok(oldV1);
    assert.equal(oldV1.status, "retired");

    // 4. Replaying all migrations AND re-running seed import must keep unused templates retired and active templates published
    await runMigrations(pool);
    await importPromptRecordsWithPolicy(prompts, records, { publish: true });
    const publishedAfterReplay = await prompts.listPublished();
    assert.deepEqual(
      publishedAfterReplay.map((item) => item.code).sort(),
      [
        ...aplusCodes,
        "general.base_refine",
        "general.category-prompt",
        "general.listing-copy",
        "general.structure-plan",
        ...editorCodes,
        "product.onboarding",
        "replica.compose",
        "replica.high",
      ],
    );
    const retiredAfterReplay = await prompts.listTemplates({ status: "retired" });
    assert.equal(retiredAfterReplay.length, 13);
    assert.ok(retiredAfterReplay.every((item) => item.status === "retired"));
  });
});

test("034 adds library_resource_deletions table and PostgresLibraryRepository soft-deletes across sources while keeping frozen previews intact", { skip }, async () => {
  await withMigratedSchemas(async ({ pool, schemas }) => {
    const suites = new PostgresSuiteRepository(pool);
    const tasks = new PostgresTaskRepository(pool);
    const library = new PostgresLibraryRepository(pool);

    // Verify 034 table & index exist and replay is idempotent
    const tableCheck = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = 'library_resource_deletions'`,
      [schemas[0]],
    );
    assert.equal(tableCheck.rows.length, 1);
    const indexCheck = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = $1 AND tablename = 'library_resource_deletions' AND indexname = 'library_resource_deletions_deleted_at_idx'`,
      [schemas[0]],
    );
    assert.equal(indexCheck.rows.length, 1);
    await runMigrations(pool);

    const suite = await suites.createSuite("PG 删除资源测试");
    const inputId = randomUUID();
    const inputPrefix = `suites/${suite.id}/inputs/${inputId}/`;
    await suites.createInputImage({
      id: inputId,
      suiteId: suite.id,
      ordinal: 1,
      originalObjectKey: inputPrefix + "original",
      thumbnailObjectKey: inputPrefix + "thumbnail",
      sha256: "1".repeat(64),
      width: 512,
      height: 512,
      mimeType: "image/png",
      originalFilename: "pg-delete-input.png",
      currentBaseVersionId: null,
      createdAt: timestamp,
    });

    const baseVersionId = randomUUID();
    const baseAttemptId = randomUUID();
    await suites.beginBaseGeneration({
      id: baseAttemptId,
      suiteId: suite.id,
      inputImageId: inputId,
      baseVersionId,
      idempotencyKey: "pg-del-base-gen-1",
      model: "gpt-image-2",
      endpoint: "/v1/images/edits",
      prompt: "生成纯白底图",
      promptTemplateVersionId: null,
      dynamicInput: {},
      size: "1K",
      quality: "medium",
      n: 1,
      responseFormat: "b64_json",
      createdAt: timestamp,
    });
    const baseObjectKey = `${inputPrefix}base/${baseVersionId}/v1.png`;
    await suites.completeBaseGeneration({
      attemptId: baseAttemptId,
      objectKey: baseObjectKey,
      sha256: "9".repeat(64),
      width: 512,
      height: 512,
      mimeType: "image/png",
      completedAt: timestamp,
    });

    const { task } = await tasks.createCustomTask({
      suiteId: suite.id,
      planSnapshotId: null,
      imageType: "main",
      title: "PG 删除测试任务",
      purpose: "主图",
      promptDraft: "展示商品主体",
      sourceInputImageId: inputId,
      generationParams: {},
    });

    // Bind base_image resource to task before deleting
    const { reference } = await library.createReference({
      suiteId: suite.id,
      resourceId: `base:${baseVersionId}`,
      targetType: "task",
      targetId: task.id,
      idempotencyKey: "pg-ref-before-delete",
    });
    assert.equal(reference.resourceId, `base:${baseVersionId}`);

    // Create task version with a process image
    const batchId = randomUUID();
    const slotId = randomUUID();
    const attemptId = randomUUID();
    await tasks.beginBatch({
      batch: {
        id: batchId,
        suiteId: suite.id,
        kind: "single",
        requestedCount: 1,
        taskIds: [task.id],
        status: "running",
        idempotencyKey: "pg-del-task-batch-1",
        createdAt: timestamp,
        startedAt: timestamp,
        finishedAt: null,
      },
      slots: [{
        id: slotId,
        batchId,
        taskId: task.id,
        slotOrdinal: 1,
        retryOfSlotId: null,
        status: "generating",
        selectedVersionId: null,
        createdAt: timestamp,
        completedAt: null,
      }],
      attempts: [{
        id: attemptId,
        slotId,
        attemptNo: 1,
        provider: "fake",
        model: "gpt-image-2",
        endpoint: "/v1/images/edits",
        requestSummary: {},
        promptSnapshot: { prompt: "展示商品主体" },
        promptSha256: "2".repeat(64),
        contextSnapshot: {},
        sourceKind: "original",
        sourceObjectKey: inputPrefix + "original",
        sourceInputImageId: inputId,
        sourceBaseVersionId: null,
        status: "running",
        errorCode: null,
        errorMessage: null,
        externalRequestId: null,
        startedAt: timestamp,
        finishedAt: null,
      }],
    });
    const { version } = await tasks.completeAttempt({
      attemptId,
      slotId,
      taskId: task.id,
      objectKey: `suites/${suite.id}/tasks/${task.id}/versions/v1/final.png`,
      processObjectKeys: [`suites/${suite.id}/tasks/${task.id}/versions/v1/proc0.png`],
      sha256: "3".repeat(64),
      width: 512,
      height: 512,
      mimeType: "image/png",
      completedAt: timestamp,
    });

    const reverseAsset = await library.createReverseReferenceAsset({
      suiteId: suite.id,
      title: "PG 反推删除测试",
      summary: "摘要",
      objectKey: `reverse/${suite.id}/ref.png`,
      mimeType: "image/png",
      promptSnapshot: { prompt: "反推提示词" },
      source: { origin: "replica" },
    });

    const baseResourceId = `base:${baseVersionId}`;
    const taskVersionResourceId = `task-version:${version.id}`;
    const processResourceId = `process:${version.id}:0`;

    // Invalid / malformed IDs return null cleanly without throwing PG 22P02
    assert.equal(await library.deleteResource("base:not-a-uuid"), null);
    assert.equal(await library.getResource("reverse:not-a-uuid"), null);

    // Single delete + idempotency
    const del1 = await library.deleteResource(baseResourceId);
    assert.ok(del1);
    assert.equal(del1.alreadyDeleted, false);
    const del2 = await library.deleteResource(baseResourceId);
    assert.ok(del2);
    assert.equal(del2.alreadyDeleted, true);
    assert.equal(del2.deletedAt, del1.deletedAt);

    // Deleted base image is hidden from list & default getResource, but still resolvable for frozen preview
    assert.equal(await library.getResource(baseResourceId), null);
    assert.ok(await library.getResource(baseResourceId, { includeDeleted: true }));
    assert.deepEqual(await library.getPreviewObject(baseResourceId), { objectKey: baseObjectKey });
    const listedBases = await library.listResources({ resourceType: "base_image", suiteId: suite.id });
    assert.equal(listedBases.items.some((item) => item.id === baseResourceId), false);
    // Uploaded input_image is never returned by listResources even without deletion
    const listedInputs = await library.listResources({ resourceType: "input_image", suiteId: suite.id });
    assert.deepEqual(listedInputs.items, []);

    // Frozen reference and underlying input_image / task_image_versions rows remain intact
    assert.equal((await library.listReferences(suite.id, "task", task.id)).length, 1);
    assert.ok(await suites.getInputImage(suite.id, inputId));

    // Archive reverse asset before deleting to verify re-save resets status='draft' and archived_at=NULL
    const archivedReverse = await library.setResourceStatus(reverseAsset.id, "archived");
    assert.equal(archivedReverse?.status, "archived");
    const archivedDbBefore = await pool.query<{ status: string; archived_at: unknown }>(
      `SELECT status, archived_at FROM suite_workbench.reverse_reference_assets WHERE id = $1::uuid`,
      [reverseAsset.resourceVersionId],
    );
    assert.equal(archivedDbBefore.rows[0]?.status, "archived");
    assert.ok(archivedDbBefore.rows[0]?.archived_at);

    // Batch delete task version, process image, reverse asset + already deleted base + nonexistent ID
    const batch = await library.deleteResources([
      taskVersionResourceId,
      processResourceId,
      reverseAsset.id,
      baseResourceId,
      "base:not-a-uuid",
    ]);
    assert.deepEqual(batch.deletedIds, [taskVersionResourceId, processResourceId, reverseAsset.id]);
    assert.deepEqual(batch.alreadyDeletedIds, [baseResourceId]);
    assert.deepEqual(batch.notFoundIds, ["base:not-a-uuid"]);
    assert.equal(batch.deletedCount, 3);

    // Repeat batch delete is idempotent
    const batchRepeat = await library.deleteResources([taskVersionResourceId, processResourceId, reverseAsset.id]);
    assert.deepEqual(batchRepeat.deletedIds, []);
    assert.deepEqual(batchRepeat.alreadyDeletedIds, [taskVersionResourceId, processResourceId, reverseAsset.id]);
    assert.equal(batchRepeat.deletedCount, 0);

    // None of the deleted resources appear in listResources (including scope=image), and status update on deleted reverse asset returns null
    const remaining = await library.listResources({ scope: "image", suiteId: suite.id, pageSize: 100 });
    assert.equal(remaining.total, 0);
    assert.equal(remaining.items.length, 0);
    assert.equal(await library.setResourceStatus(reverseAsset.id, "published"), null);

    // Task versions remain intact in TaskRepository; selecting final via app restores task-version visibility
    const taskVersions = await tasks.listTaskVersions(task.id);
    assert.equal(taskVersions.versions.length, 1);
    const pgApp = createSuiteStudioApp({ repository: suites, taskRepository: tasks, libraryRepository: library, storage: new MemoryStorage() });
    const selectFinalRes = await pgApp.request("POST", `/api/suite-tasks/${task.id}/versions/${version.id}/select`, {
      body: { selection: "final" },
    });
    assert.equal(selectFinalRes.status, 200);
    assert.ok(await library.getResource(taskVersionResourceId));

    // scope=image excludes prompt_template and counts only image resources
    const imageScoped = await library.listResources({ scope: "image", page: 1, pageSize: 10 });
    assert.equal(imageScoped.items.some((item) => item.resourceType === "prompt_template"), false);
    assert.equal(imageScoped.total, 1);

    // Re-saving deleted reverse asset via upsert clears deletion marker, resets status to draft and archived_at to NULL
    const restoredReverse = await library.createReverseReferenceAsset({
      suiteId: suite.id,
      title: "PG 反推重新保存",
      summary: "恢复",
      objectKey: `reverse/${suite.id}/ref.png`,
      mimeType: "image/png",
      promptSnapshot: { prompt: "新提示词" },
      source: { origin: "replica" },
    });
    assert.equal(restoredReverse.id, reverseAsset.id);
    assert.equal(restoredReverse.status, "draft");
    const restoredDb = await pool.query<{ status: string; archived_at: unknown }>(
      `SELECT status, archived_at FROM suite_workbench.reverse_reference_assets WHERE id = $1::uuid`,
      [reverseAsset.resourceVersionId],
    );
    assert.equal(restoredDb.rows[0]?.status, "draft");
    assert.equal(restoredDb.rows[0]?.archived_at, null);
    assert.ok(await library.getResource(reverseAsset.id));

    // Deleting a prompt_template is forbidden
    const promptList = await library.listResources({ resourceType: "prompt_template", pageSize: 5 });
    if (promptList.items.length > 0) {
      await assert.rejects(
        library.deleteResource(promptList.items[0].id),
        /LIBRARY_RESOURCE_FORBIDDEN/,
      );
      await assert.rejects(
        library.deleteResources([promptList.items[0].id]),
        /LIBRARY_RESOURCE_FORBIDDEN/,
      );
    }

    // Re-running migrations preserves deletion rows cleanly
    await runMigrations(pool);
    assert.equal(await library.getResource(baseResourceId), null);
  });
});

async function withConcurrentMigratedSchemas<T>(run: (db: { pool: Pool; schemas: string[] }) => Promise<T>) {
  const realPool = new Pool({ ...loadPostgresConfig(), max: 12, connectionTimeoutMillis: 10_000 });
  const suffix = randomUUID().replaceAll("-", "");
  const suiteSchema = `contract_suite_conc_${suffix}`;
  const promptSchema = `contract_prompt_conc_${suffix}`;
  let createdSchemas = false;

  try {
    const extension = await realPool.query<{ schema: string }>(
      `SELECT n.nspname AS schema FROM pg_catalog.pg_extension e
       JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace WHERE e.extname=$1`,
      ["pgcrypto"],
    );
    const cryptoSchema = escapeIdentifier(extension.rows[0]?.schema ?? suiteSchema);

    const rewriteSql = (sql: string) =>
      sql
        .replace(/\bsuite_workbench\b/g, suiteSchema)
        .replace(/\bprompt_library\b/g, promptSchema)
        .replace(/\bFROM pg_constraint WHERE conname\b/gi, `FROM pg_catalog.pg_constraint
          WHERE connamespace IN (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = ANY(pg_catalog.current_schemas(false))) AND conname`)
        .replace(/\bCREATE EXTENSION IF NOT EXISTS pgcrypto\s*;/i, `CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA ${suiteSchema};`)
        .replace(/\b(digest|gen_random_uuid)\(/g, (_match, fn: string) => `${cryptoSchema}.${fn}(`);

    const setupClient = await realPool.connect();
    try {
      await setupClient.query(`CREATE SCHEMA ${suiteSchema}`);
      await setupClient.query(`CREATE SCHEMA ${promptSchema}`);
      createdSchemas = true;
      await setupClient.query(`SET search_path TO ${suiteSchema}, ${promptSchema}`);
      const setupPool = {
        query<Row extends QueryResultRow>(sql: string, values?: unknown[]) {
          return setupClient.query<Row>(rewriteSql(sql), values);
        },
      } as unknown as Pool;
      await runMigrations(setupPool);
      await setupClient.query("SET search_path TO DEFAULT");
    } finally {
      setupClient.release();
    }

    const scopedPool = {
      query<Row extends QueryResultRow>(sql: string, values?: unknown[]) {
        return realPool.query<Row>(rewriteSql(sql), values);
      },
      async connect() {
        const client: PoolClient = await realPool.connect();
        return {
          query<Row extends QueryResultRow>(sql: string, values?: unknown[]) {
            return client.query<Row>(rewriteSql(sql), values);
          },
          release(err?: Error | boolean) {
            return client.release(err);
          },
        };
      },
    } as unknown as Pool;

    return await run({ pool: scopedPool, schemas: [suiteSchema, promptSchema] });
  } finally {
    try {
      if (createdSchemas) {
        await realPool.query(`DROP SCHEMA IF EXISTS ${suiteSchema} CASCADE`);
        await realPool.query(`DROP SCHEMA IF EXISTS ${promptSchema} CASCADE`);
      }
    } finally {
      await realPool.end();
    }
  }
}

test("Postgres 并发出图复用同一请求并拒绝正在生成的资源", { skip }, async () => {
  await withConcurrentMigratedSchemas(async ({ pool }) => {
    await verifyGenerationConcurrency(
      new PostgresSuiteRepository(pool), new PostgresTaskRepository(pool), new PostgresPipelineRepository(pool), new PostgresPromptRepository(pool), new PostgresImageEditorRepository(pool),
    );
  });
});

test("PG task batch status converges under concurrent completeAttempt and failAttempt calls without leaving batch running", { skip }, async () => {
  await withConcurrentMigratedSchemas(async ({ pool }) => {
    const suites = new PostgresSuiteRepository(pool);
    const tasks = new PostgresTaskRepository(pool);
    const suite = await suites.createSuite("PG 并发收敛测试", undefined, "replica");

    const inputId = randomUUID();
    await suites.createInputImage({
      id: inputId,
      suiteId: suite.id,
      ordinal: 1,
      originalObjectKey: `suites/${suite.id}/inputs/${inputId}/original`,
      thumbnailObjectKey: `suites/${suite.id}/inputs/${inputId}/thumbnail`,
      sha256: "a".repeat(64),
      width: 512,
      height: 512,
      mimeType: "image/png",
      originalFilename: "product.png",
      currentBaseVersionId: null,
      createdAt: timestamp,
    });

    const createdTasks = [];
    for (let i = 1; i <= 4; i += 1) {
      const { task } = await tasks.createCustomTask({
        suiteId: suite.id,
        planSnapshotId: null,
        imageType: "main",
        title: `并发卡 ${i}`,
        purpose: "主图",
        promptDraft: `提示词 ${i}`,
        sourceInputImageId: inputId,
        generationParams: { size: "1K", ratio: "1:1" },
      });
      createdTasks.push(task);
    }

    const scenarios: Array<{ outcomes: Array<"complete" | "fail">; expectedStatus: "completed" | "partial" | "failed" }> = [
      { outcomes: ["complete", "fail"], expectedStatus: "partial" },
      { outcomes: ["complete", "complete", "complete"], expectedStatus: "completed" },
      { outcomes: ["fail", "fail", "fail"], expectedStatus: "failed" },
      { outcomes: ["complete", "fail", "complete", "fail"], expectedStatus: "partial" },
    ];

    for (let round = 0; round < 20; round += 1) {
      const scenario = scenarios[round % scenarios.length];
      const batchId = randomUUID();
      const roundTasks = createdTasks.slice(0, scenario.outcomes.length);
      const slots = roundTasks.map((task, idx) => ({
        id: randomUUID(),
        batchId,
        taskId: task.id,
        slotOrdinal: idx + 1,
        retryOfSlotId: null,
        status: "generating" as const,
        selectedVersionId: null,
        createdAt: timestamp,
        completedAt: null,
      }));
      const attempts = slots.map((slot, idx) => ({
        id: randomUUID(),
        slotId: slot.id,
        attemptNo: 1,
        provider: "fake",
        model: "gpt-image-2",
        endpoint: "/v1/images/edits" as const,
        requestSummary: {},
        promptSnapshot: { prompt: `round-${round}-${idx}` },
        promptSha256: `${round.toString(16).padStart(2, "0")}${idx}`.padEnd(64, "b"),
        contextSnapshot: {},
        sourceKind: "original" as const,
        sourceObjectKey: `suites/${suite.id}/inputs/${inputId}/original`,
        sourceInputImageId: inputId,
        sourceBaseVersionId: null,
        status: "running" as const,
        errorCode: null,
        errorMessage: null,
        externalRequestId: null,
        startedAt: timestamp,
        finishedAt: null,
      }));

      await tasks.beginBatch({
        batch: {
          id: batchId,
          suiteId: suite.id,
          kind: "batch",
          requestedCount: slots.length,
          taskIds: roundTasks.map((t) => t.id),
          status: "running",
          idempotencyKey: `conc-round-${round}`,
          createdAt: timestamp,
          startedAt: timestamp,
          finishedAt: null,
        },
        slots,
        attempts,
      });

      const finishedAt = new Date(Date.parse(timestamp) + (round + 1) * 1000).toISOString();
      await Promise.all(
        scenario.outcomes.map((outcome, idx) => {
          const slot = slots[idx];
          const attempt = attempts[idx];
          const task = roundTasks[idx];
          if (outcome === "complete") {
            return tasks.completeAttempt({
              attemptId: attempt.id,
              slotId: slot.id,
              taskId: task.id,
              objectKey: `suites/${suite.id}/tasks/${task.id}/versions/conc-${round}-${idx}.png`,
              processObjectKeys: [],
              sha256: `${round.toString(16).padStart(2, "0")}${idx}`.padEnd(64, "c"),
              width: 512,
              height: 512,
              mimeType: "image/png",
              completedAt: finishedAt,
            });
          }
          return tasks.failAttempt(attempt.id, "TASK_IMAGE_PROVIDER_FAILED", "模拟失败", finishedAt);
        }),
      );

      const batch = await tasks.getBatch(batchId);
      assert.ok(batch, `round ${round}: batch must exist`);
      assert.equal(
        batch.status,
        scenario.expectedStatus,
        `round ${round} (${scenario.outcomes.join(",")}): expected batch status ${scenario.expectedStatus}, got ${batch.status}`,
      );
      assert.ok(batch.finishedAt, `round ${round}: finished_at must be non-null`);
    }

    // Competing completeAttempt vs failAttempt on the same running attempt:
    // exactly one wins, the loser rejects with INVALID_TASK_ATTEMPT, and batch converges cleanly.
    for (let raceRound = 0; raceRound < 6; raceRound += 1) {
      const batchId = randomUUID();
      const slotId = randomUUID();
      const attemptId = randomUUID();
      const task = createdTasks[0];
      const reserve = () => tasks.beginBatch({
        batch: {
          id: batchId,
          suiteId: suite.id,
          kind: "single",
          requestedCount: 1,
          taskIds: [task.id],
          status: "running",
          idempotencyKey: `same-attempt-race-${raceRound}`,
          createdAt: timestamp,
          startedAt: timestamp,
          finishedAt: null,
        },
        slots: [{
          id: slotId,
          batchId,
          taskId: task.id,
          slotOrdinal: 1,
          retryOfSlotId: null,
          status: "generating",
          selectedVersionId: null,
          createdAt: timestamp,
          completedAt: null,
        }],
        attempts: [{
          id: attemptId,
          slotId,
          attemptNo: 1,
          provider: "fake",
          model: "gpt-image-2",
          endpoint: "/v1/images/edits",
          requestSummary: {},
          promptSnapshot: { prompt: `race-${raceRound}` },
          promptSha256: `${raceRound}`.padEnd(64, "d"),
          contextSnapshot: {},
          sourceKind: "original",
          sourceObjectKey: `suites/${suite.id}/inputs/${inputId}/original`,
          sourceInputImageId: inputId,
          sourceBaseVersionId: null,
          status: "running",
          errorCode: null,
          errorMessage: null,
          externalRequestId: null,
          startedAt: timestamp,
          finishedAt: null,
        }],
      });

      const reservations = await Promise.all([reserve(), reserve()]);
      assert.deepEqual(reservations.map((r) => r.duplicate).sort(), [false, true]);
      for (const r of reservations) {
        assert.equal(r.batch.id, batchId);
        assert.deepEqual(r.attempts.map((a) => a.id), [attemptId]);
      }

      const finishedAt = new Date(Date.parse(timestamp) + 60_000 + raceRound * 1000).toISOString();
      const settled = await Promise.allSettled([
        tasks.completeAttempt({
          attemptId,
          slotId,
          taskId: task.id,
          objectKey: `suites/${suite.id}/tasks/${task.id}/versions/race-${raceRound}.png`,
          processObjectKeys: [],
          sha256: `${raceRound}`.padEnd(64, "e"),
          width: 512,
          height: 512,
          mimeType: "image/png",
          completedAt: finishedAt,
        }),
        tasks.failAttempt(attemptId, "TASK_IMAGE_PROVIDER_FAILED", "并发失败", finishedAt),
      ]);

      const fulfilled = settled.filter((r) => r.status === "fulfilled");
      const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      assert.equal(fulfilled.length, 1, `raceRound ${raceRound}: exactly one of complete/fail must succeed`);
      assert.equal(rejected.length, 1, `raceRound ${raceRound}: the losing call must reject`);
      assert.match(String(rejected[0].reason), /INVALID_TASK_ATTEMPT/);

      const attempt = await tasks.getAttempt(attemptId);
      const batch = await tasks.getBatch(batchId);
      assert.ok(attempt && batch);
      assert.ok(batch.finishedAt, `raceRound ${raceRound}: batch finished_at must be non-null`);
      if (settled[0].status === "fulfilled") {
        assert.equal(attempt.status, "succeeded");
        assert.equal(batch.status, "completed");
      } else {
        assert.equal(attempt.status, "failed");
        assert.equal(batch.status, "failed");
      }

      // Calling failAttempt again on a settled attempt must reject with INVALID_TASK_ATTEMPT.
      await assert.rejects(
        tasks.failAttempt(attemptId, "LATE_ERROR", "迟到失败", finishedAt),
        /INVALID_TASK_ATTEMPT/,
      );
    }
  });
});

test("037 adds source_card_id index and drops created_at index idempotently; PG library excludes archived tasks' images & exposes editor-derived images with search, soft-delete, total, preview, and references", { skip }, async () => {
  await withMigratedSchemas(async ({ pool, schemas }) => {
    const idxCheck = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = $1 AND indexname IN ('image_edit_child_tasks_source_card_id_idx', 'image_edit_versions_created_at_idx')
       ORDER BY indexname`,
      [schemas[0]],
    );
    assert.deepEqual(
      idxCheck.rows.map((r) => r.indexname),
      ["image_edit_child_tasks_source_card_id_idx"],
    );
    // Simulate a dev DB where the legacy image_edit_versions_created_at_idx existed, then replay migrations -> must drop it cleanly
    await pool.query(`CREATE INDEX IF NOT EXISTS image_edit_versions_created_at_idx ON suite_workbench.image_edit_versions (created_at DESC)`);
    await runMigrations(pool);
    const idxAfterReplay = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = $1 AND indexname IN ('image_edit_child_tasks_source_card_id_idx', 'image_edit_versions_created_at_idx')
       ORDER BY indexname`,
      [schemas[0]],
    );
    assert.deepEqual(
      idxAfterReplay.rows.map((r) => r.indexname),
      ["image_edit_child_tasks_source_card_id_idx"],
    );

    const suites = new PostgresSuiteRepository(pool);
    const tasks = new PostgresTaskRepository(pool);
    const library = new PostgresLibraryRepository(pool);
    const editorRepo = new PostgresImageEditorRepository(pool);
    const storage = new MemoryStorage();

    const suite = await suites.createSuite("PG 归档与编辑派生资源库测试", undefined, "canvas");
    const { task: task1 } = await tasks.createCustomTask({
      suiteId: suite.id,
      planSnapshotId: null,
      imageType: "main",
      title: "PG 主图卡 1",
      purpose: "主图",
      promptDraft: "展示主图商品",
      sourceInputImageId: null,
      generationParams: { size: "1K", ratio: "1:1" },
    });
    const { task: task2 } = await tasks.createCustomTask({
      suiteId: suite.id,
      planSnapshotId: null,
      imageType: "detail",
      title: "PG 详情卡 2",
      purpose: "详情",
      promptDraft: "展示详情卖点",
      sourceInputImageId: null,
      generationParams: { size: "1K", ratio: "3:4" },
    });

    const seedTaskVersion = async (taskId: string, key: string, procKeys: string[] = []) => {
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
          idempotencyKey: `pg-t14-${key}`,
          createdAt: timestamp,
          startedAt: timestamp,
          finishedAt: null,
        },
        slots: [{
          id: slotId,
          batchId,
          taskId,
          slotOrdinal: 1,
          retryOfSlotId: null,
          status: "generating",
          selectedVersionId: null,
          createdAt: timestamp,
          completedAt: null,
        }],
        attempts: [{
          id: attemptId,
          slotId,
          attemptNo: 1,
          provider: "fake",
          model: "gpt-image-2",
          endpoint: "/v1/images/edits",
          requestSummary: {},
          promptSnapshot: { prompt: `提示词 ${key}` },
          promptSha256: "a".repeat(64),
          contextSnapshot: {},
          sourceKind: "original",
          sourceObjectKey: `orig/${key}.png`,
          sourceInputImageId: null,
          sourceBaseVersionId: null,
          status: "running",
          errorCode: null,
          errorMessage: null,
          externalRequestId: null,
          startedAt: timestamp,
          finishedAt: null,
        }],
      });
      const objectKey = `suites/${suite.id}/tasks/${taskId}/versions/${key}.png`;
      await storage.put({ key: objectKey, bytes: Buffer.from(`png-${key}`), contentType: "image/png" });
      return (await tasks.completeAttempt({
        attemptId,
        slotId,
        taskId,
        objectKey,
        processObjectKeys: procKeys,
        sha256: "b".repeat(64),
        width: 512,
        height: 512,
        mimeType: "image/png",
        completedAt: timestamp,
      })).version;
    };

    const v1 = await seedTaskVersion(task1.id, "v1", [`suites/${suite.id}/tasks/${task1.id}/proc0.png`]);
    const v2 = await seedTaskVersion(task2.id, "v2");

    // Create a 2-level editor chain under task1: task1 -> child1 -> child2
    const seedEditVersion = async (sourceCardId: string, sourceVersionId: string, label: string, completedAt: string) => {
      const snapId = randomUUID();
      const childId = randomUUID();
      const editAttemptId = randomUUID();
      await editorRepo.submit({
        idempotencyKey: `pg-t14-edit-${childId}`,
        snapshot: {
          id: snapId,
          sourceCardId,
          sourceVersionId,
          parentVersionId: sourceVersionId,
          summary: label,
          sourcePrompt: "原始提示词",
          operations: [{
            operationId: `op-${childId}`,
            type: "add_text",
            order: 1,
            sourceCardId,
            sourceVersionId,
            parentVersionId: sourceVersionId,
            summary: label,
            payload: { text: label, prompt: `添加文字 ${label}` },
          }],
          provider: { name: "openai-compatible-image", version: "gpt-image-2", capabilitiesVersion: "v1" },
          createdAt: completedAt,
          schemaVersion: "image-edit-snapshot-v1",
        },
        childTask: {
          id: childId,
          sourceCardId,
          sourceVersionId,
          parentVersionId: sourceVersionId,
          snapshotId: snapId,
          summary: label,
          status: "generating",
          currentVersionId: null,
          finalVersionId: null,
          errorCode: null,
          errorMessage: null,
          createdAt: completedAt,
          updatedAt: completedAt,
        },
        attempt: {
          id: editAttemptId,
          childTaskId: childId,
          snapshotId: snapId,
          attemptNo: 1,
          status: "generating",
          command: { type: "add_text", sourceVersionId, prompt: `编辑指令：${label}`, operations: [] },
          provider: { name: "openai-compatible-image", version: "gpt-image-2", capabilitiesVersion: "v1" },
          errorCode: null,
          errorMessage: null,
          createdAt: completedAt,
          completedAt: null,
        },
      });
      const objectKey = `image-edits/${childId}/versions/${label}.png`;
      await storage.put({ key: objectKey, bytes: Buffer.from(`edit-${label}`), contentType: "image/png" });
      const completed = await editorRepo.completeAttempt({
        attemptId: editAttemptId,
        objectKey,
        sha256: "c".repeat(64),
        width: 512,
        height: 512,
        mimeType: "image/png",
        completedAt,
      });
      return { childId, version: completed.version, objectKey };
    };

    const edit1 = await seedEditVersion(task1.id, v1.id, "限时优惠", "2026-01-01T00:01:00.000Z");
    const edit2 = await seedEditVersion(edit1.childId, edit1.version.id, "加粗标题", "2026-01-01T00:02:00.000Z");

    const tv1Id = `task-version:${v1.id}`;
    const proc1Id = `process:${v1.id}:0`;
    const tv2Id = `task-version:${v2.id}`;
    const edit1Id = `edit-version:${edit1.version.id}`;
    const edit2Id = `edit-version:${edit2.version.id}`;

    // 1. Both task versions and both edit versions appear in task_image_version list (total=4) with status=published
    const listedAll = await library.listResources({ scope: "image", resourceType: "task_image_version", status: "published", suiteId: suite.id });
    assert.equal(listedAll.total, 4);
    assert.deepEqual(new Set(listedAll.items.map((item) => item.id)), new Set([tv1Id, tv2Id, edit1Id, edit2Id]));
    const edit1Res = listedAll.items.find((item) => item.id === edit1Id)!;
    assert.equal(edit1Res.status, "published");
    assert.equal(edit1Res.resourceType, "task_image_version");
    assert.equal(edit1Res.source.generatedBy, "image_editor");
    assert.equal(edit1Res.source.rootTaskId, task1.id);
    assert.equal(edit1Res.suiteId, suite.id);
    assert.match(edit1Res.summary, /编辑生成/);

    // 1b. PG search matches synthesized title ("编辑版本 1") and summary ("编辑生成") consistent with Memory
    const byOriginSearch = await library.listResources({ scope: "image", query: "编辑生成", suiteId: suite.id });
    assert.equal(byOriginSearch.total, 2);
    assert.deepEqual(new Set(byOriginSearch.items.map((item) => item.id)), new Set([edit1Id, edit2Id]));
    const byVersionTitleSearch = await library.listResources({ scope: "image", query: "编辑版本 1", suiteId: suite.id });
    assert.equal(byVersionTitleSearch.total, 2);
    assert.deepEqual(new Set(byVersionTitleSearch.items.map((item) => item.id)), new Set([edit1Id, edit2Id]));

    // 2. edit-version can be referenced (bound) to task2 in the same suite
    const bound = await library.createReference({
      suiteId: suite.id,
      resourceId: edit1Id,
      targetType: "task",
      targetId: task2.id,
      idempotencyKey: "pg-bind-edit-1",
    });
    assert.equal(bound.reference.resourceId, edit1Id);
    assert.equal(bound.reference.resourceType, "task_image_version");

    // 3. Soft-delete edit2 BEFORE archiving task1 to verify explicit soft-delete survives archive/unarchive cycle
    const delEdit2 = await library.deleteResource(edit2Id);
    assert.equal(delEdit2?.alreadyDeleted, false);
    assert.equal((await library.listResources({ scope: "image", resourceType: "task_image_version", suiteId: suite.id })).total, 3);
    assert.deepEqual(await library.getPreviewObject(edit2Id), { objectKey: edit2.objectKey });

    // 4. Archive task1 -> hides task1's task-version, process_image, and edit1 from list/total/getResource/createReference
    await tasks.updateTask(task1.id, { status: "archived" });
    const afterArchiveImg = await library.listResources({ scope: "image", suiteId: suite.id });
    assert.equal(afterArchiveImg.total, 1);
    assert.deepEqual(afterArchiveImg.items.map((item) => item.id), [tv2Id]);
    assert.equal(await library.getResource(tv1Id), null);
    assert.equal(await library.getResource(proc1Id), null);
    assert.equal(await library.getResource(edit1Id), null);
    await assert.rejects(
      library.createReference({ suiteId: suite.id, resourceId: edit1Id, targetType: "task", targetId: task2.id, idempotencyKey: "pg-bind-after-archive" }),
      /LIBRARY_RESOURCE_NOT_FOUND/,
    );

    // Preview & includeDeleted & frozen references still work for archived task's images
    assert.ok(await library.getResource(tv1Id, { includeDeleted: true }));
    assert.ok(await library.getResource(edit1Id, { includeDeleted: true }));
    assert.deepEqual(await library.getPreviewObject(edit1Id), { objectKey: edit1.objectKey });
    assert.equal((await library.listReferences(suite.id, "task", task2.id)).length, 1);

    // 5. Unarchiving task1 restores tv1, proc1, edit1 while keeping explicitly soft-deleted edit2 hidden
    await tasks.updateTask(task1.id, { status: "generated" });
    const afterUnarchive = await library.listResources({ scope: "image", resourceType: "task_image_version", suiteId: suite.id });
    assert.equal(afterUnarchive.total, 3);
    assert.deepEqual(new Set(afterUnarchive.items.map((item) => item.id)), new Set([tv1Id, tv2Id, edit1Id]));
    assert.equal(await library.getResource(edit2Id), null);

    // 6. Batch soft-delete + selecting edit2 as final via app restores edit2
    const batchDel = await library.deleteResources([edit1Id, edit2Id]);
    assert.deepEqual(batchDel.deletedIds, [edit1Id]);
    assert.deepEqual(batchDel.alreadyDeletedIds, [edit2Id]);

    const pgApp = createSuiteStudioApp({
      repository: suites,
      taskRepository: tasks,
      libraryRepository: library,
      storage,
      imageEditorApi: createImageEditorApi(
        new ImageEditorService(
          editorRepo,
          async () => null,
          storage,
          async () => null,
        ),
      ),
    });
    const previewDeleted = await pgApp.request("GET", `/api/library/resources/${encodeURIComponent(edit1Id)}/preview`);
    assert.equal(previewDeleted.status, 200);
    const selectFinalEdit = await pgApp.request("POST", `/api/image-editor/tasks/${edit2.childId}/versions/${edit2.version.id}/select`, {
      body: { selection: "final" },
    });
    assert.equal(selectFinalEdit.status, 200);
    assert.ok(await library.getResource(edit2Id));
  });
});

test("038 migration enforces product library and onboarding constraints, cascades, and PostgresProductCardRepository CRUD", { skip }, async () => {
  const { PostgresProductCardRepository } = await import(
    "../server/repositories/postgres-product-card-repository.js"
  );

  await withMigratedSchemas(async ({ pool }) => {
    const repo = new PostgresProductCardRepository(pool);
    const expectSqlError = async (sql: string, values: unknown[]) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await assert.rejects(client.query(sql, values));
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    };

    // 1. product_cards CHECK constraints reject invalid status, blank required fields, empty/oversized selling points
    const badCardId = randomUUID();
    await expectSqlError(
      `INSERT INTO suite_workbench.product_cards
        (id, status, name, selling_points_json, specifications, materials_craft, audience_scenarios, package_contents)
       VALUES ($1, 'draft', '商品名', '["卖点1"]'::jsonb, '规格', '材质', '人群', '清单')`,
      [badCardId],
    );
    await expectSqlError(
      `INSERT INTO suite_workbench.product_cards
        (id, status, name, selling_points_json, specifications, materials_craft, audience_scenarios, package_contents)
       VALUES ($1, 'published', '   ', '["卖点1"]'::jsonb, '规格', '材质', '人群', '清单')`,
      [badCardId],
    );
    await expectSqlError(
      `INSERT INTO suite_workbench.product_cards
        (id, status, name, selling_points_json, specifications, materials_craft, audience_scenarios, package_contents)
       VALUES ($1, 'published', '商品名', '[]'::jsonb, '规格', '材质', '人群', '清单')`,
      [badCardId],
    );
    await expectSqlError(
      `INSERT INTO suite_workbench.product_cards
        (id, status, name, selling_points_json, specifications, materials_craft, audience_scenarios, package_contents)
       VALUES ($1, 'published', '商品名', '["1","2","3","4","5","6","7","8","9","10","11"]'::jsonb, '规格', '材质', '人群', '清单')`,
      [badCardId],
    );

    // 2. Create card + 2 supplier images through PostgresProductCardRepository
    const cardId = randomUUID();
    const img1Id = randomUUID();
    const img2Id = randomUUID();
    const created = await repo.create({
      id: cardId,
      status: "published",
      fields: {
        name: "100% 纯棉重磅T恤",
        sellingPoints: ["260g 高克重纯棉", "领口双针加固_不易变形", "透气率提升 50%"],
        specifications: "尺码 M-XXL，衣长 70-76cm，克重 260g/m²",
        materialsCraft: "100% 新疆长绒棉，活性染色工艺",
        audienceScenarios: "春夏日常通勤与休闲穿搭",
        packageContents: "单品本体 ×1，无额外配件",
        painPointsComparison: "",
        usageDemoHighlights: "",
        certificationsProhibitions: "",
      },
      sourceSessionId: null,
      revision: 1,
      images: [
        {
          id: img1Id,
          productCardId: cardId,
          ordinal: 1,
          originalObjectKey: `product-cards/${cardId}/images/${img1Id}/original`,
          thumbnailObjectKey: `product-cards/${cardId}/images/${img1Id}/thumbnail`,
          sha256: "1".repeat(64),
          width: 800,
          height: 800,
          mimeType: "image/png",
          originalFilename: "front.png",
          createdAt: timestamp,
        },
        {
          id: img2Id,
          productCardId: cardId,
          ordinal: 2,
          originalObjectKey: `product-cards/${cardId}/images/${img2Id}/original`,
          thumbnailObjectKey: `product-cards/${cardId}/images/${img2Id}/thumbnail`,
          sha256: "2".repeat(64),
          width: 800,
          height: 600,
          mimeType: "image/jpeg",
          originalFilename: "detail.jpg",
          createdAt: timestamp,
        },
      ],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    assert.equal(created.revision, 1);
    assert.equal(created.supplierImages.length, 2);
    assert.equal(created.coverThumbnailUrl, `/api/product-cards/${cardId}/images/${img1Id}/preview/thumbnail`);

    // 3. product_card_images CHECK & UNIQUE constraints reject bad prefix, bad ordinal, duplicate ordinal/sha256
    const badImgId = randomUUID();
    await expectSqlError(
      `INSERT INTO suite_workbench.product_card_images
        (id, product_card_id, ordinal, original_object_key, thumbnail_object_key, sha256, width, height, mime_type, original_filename)
       VALUES ($1, $2, 3, $3, $4, $5, 100, 100, 'image/png', 'wrong-prefix.png')`,
      [
        badImgId,
        cardId,
        `suites/${cardId}/inputs/${badImgId}/original`,
        `suites/${cardId}/inputs/${badImgId}/thumbnail`,
        "3".repeat(64),
      ],
    );
    await expectSqlError(
      `INSERT INTO suite_workbench.product_card_images
        (id, product_card_id, ordinal, original_object_key, thumbnail_object_key, sha256, width, height, mime_type, original_filename)
       VALUES ($1, $2, 7, $3, $4, $5, 100, 100, 'image/png', 'bad-ordinal.png')`,
      [
        badImgId,
        cardId,
        `product-cards/${cardId}/images/${badImgId}/original`,
        `product-cards/${cardId}/images/${badImgId}/thumbnail`,
        "4".repeat(64),
      ],
    );
    await expectSqlError(
      `INSERT INTO suite_workbench.product_card_images
        (id, product_card_id, ordinal, original_object_key, thumbnail_object_key, sha256, width, height, mime_type, original_filename)
       VALUES ($1, $2, 3, $3, $4, $5, 100, 100, 'image/png', 'dup-sha.png')`,
      [
        badImgId,
        cardId,
        `product-cards/${cardId}/images/${badImgId}/original`,
        `product-cards/${cardId}/images/${badImgId}/thumbnail`,
        "1".repeat(64),
      ],
    );

    // 4. LIKE wildcard characters (% and _) in keyword search are escaped literally, and sellingPoints match case-insensitively
    const literalMatch = await repo.list({ status: "published", keyword: "100%" });
    assert.equal(literalMatch.total, 1);
    assert.equal(literalMatch.items[0].id, cardId);
    const nonMatchingPercent = await repo.list({ status: "published", keyword: "99%" });
    assert.equal(nonMatchingPercent.total, 0);
    const spCaseMatch = await repo.list({ status: "published", keyword: "260G 高克重" });
    assert.equal(spCaseMatch.total, 1);
    assert.equal(spCaseMatch.items[0].id, cardId);
    const spLiteralUnderscore = await repo.list({ status: "published", keyword: "加固_不易" });
    assert.equal(spLiteralUnderscore.total, 1);
    const spLiteralUnderscoreMiss = await repo.list({ status: "published", keyword: "加固X不易" });
    assert.equal(spLiteralUnderscoreMiss.total, 0);
    const spLiteralPercent = await repo.list({ status: "published", keyword: "50%" });
    assert.equal(spLiteralPercent.total, 1);
    const jsonSyntaxNoMatch = await repo.list({ status: "published", keyword: '["' });
    assert.equal(jsonSyntaxNoMatch.total, 0);

    // 5. Update reorders images cleanly without ordinal unique collision and increments revision
    const updated = await repo.update(cardId, {
      fields: {
        name: "100% 纯棉重磅T恤 升级款",
        sellingPoints: ["280g 重磅纯棉"],
        specifications: "尺码 M-XXL",
        materialsCraft: "100% 新疆长绒棉",
        audienceScenarios: "日常通勤",
        packageContents: "单品本体 ×1，无额外配件",
        painPointsComparison: "相比 220g 普通棉更挺括",
        usageDemoHighlights: "",
        certificationsProhibitions: "",
      },
      images: [
        {
          id: img2Id,
          productCardId: cardId,
          ordinal: 1,
          originalObjectKey: `product-cards/${cardId}/images/${img2Id}/original`,
          thumbnailObjectKey: `product-cards/${cardId}/images/${img2Id}/thumbnail`,
          sha256: "2".repeat(64),
          width: 800,
          height: 600,
          mimeType: "image/jpeg",
          originalFilename: "detail.jpg",
          createdAt: timestamp,
        },
        {
          id: img1Id,
          productCardId: cardId,
          ordinal: 2,
          originalObjectKey: `product-cards/${cardId}/images/${img1Id}/original`,
          thumbnailObjectKey: `product-cards/${cardId}/images/${img1Id}/thumbnail`,
          sha256: "1".repeat(64),
          width: 800,
          height: 800,
          mimeType: "image/png",
          originalFilename: "front.png",
          createdAt: timestamp,
        },
      ],
      updatedAt: "2026-01-01T00:05:00.000Z",
    });
    assert.ok(updated);
    assert.equal(updated.revision, 2);
    assert.equal(updated.supplierImages[0].id, img2Id);
    assert.equal(updated.supplierImages[1].id, img1Id);
    assert.equal((await repo.getImage(cardId, img2Id))?.ordinal, 1);

    // 6. Archive & restore status transitions
    const archived = await repo.setStatus(cardId, "archived", "2026-01-01T00:06:00.000Z");
    assert.equal(archived?.status, "archived");
    assert.equal((await repo.list({ status: "published" })).total, 0);
    assert.equal((await repo.list({ status: "archived" })).total, 1);
    const restored = await repo.setStatus(cardId, "published", "2026-01-01T00:07:00.000Z");
    assert.equal(restored?.status, "published");

    // 7. Onboarding session + messages constraints, ON DELETE SET NULL on product_card_id, ON DELETE CASCADE on messages
    const sessionId = randomUUID();
    await pool.query(
      `INSERT INTO suite_workbench.product_onboarding_sessions
        (id, title, status, draft_card_json, draft_images_json, missing_required_fields_json, product_card_id)
       VALUES ($1, 'T恤建档', 'completed', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, $2)`,
      [sessionId, cardId],
    );
    const msg1Id = randomUUID();
    await pool.query(
      `INSERT INTO suite_workbench.product_onboarding_messages
        (id, session_id, ordinal, role, content, attachments_json)
       VALUES ($1, $2, 1, 'user', '这是一件重磅T恤', '[]'::jsonb)`,
      [msg1Id, sessionId],
    );
    // Reject invalid role and duplicate message ordinal
    await expectSqlError(
      `INSERT INTO suite_workbench.product_onboarding_messages (id, session_id, ordinal, role, content)
       VALUES ($1, $2, 2, 'system', 'invalid')`,
      [randomUUID(), sessionId],
    );
    await expectSqlError(
      `INSERT INTO suite_workbench.product_onboarding_messages (id, session_id, ordinal, role, content)
       VALUES ($1, $2, 1, 'assistant', 'dup ordinal')`,
      [randomUUID(), sessionId],
    );

    // Deleting product_card cascades to product_card_images and sets session.product_card_id = NULL
    const deleted = await repo.delete(cardId);
    assert.ok(deleted);
    assert.equal(deleted.supplierImages.length, 2);
    const remainingImages = await pool.query<{ cnt: number }>(
      "SELECT count(*)::int AS cnt FROM suite_workbench.product_card_images WHERE product_card_id = $1",
      [cardId],
    );
    assert.equal(remainingImages.rows[0]?.cnt, 0);
    const sessionAfterCardDelete = await pool.query<{ product_card_id: string | null }>(
      "SELECT product_card_id FROM suite_workbench.product_onboarding_sessions WHERE id = $1",
      [sessionId],
    );
    assert.equal(sessionAfterCardDelete.rows.length, 1);
    assert.equal(sessionAfterCardDelete.rows[0]?.product_card_id, null);

    // Deleting onboarding session cascades to product_onboarding_messages
    await pool.query("DELETE FROM suite_workbench.product_onboarding_sessions WHERE id = $1", [sessionId]);
    const remainingMessages = await pool.query<{ cnt: number }>(
      "SELECT count(*)::int AS cnt FROM suite_workbench.product_onboarding_messages WHERE session_id = $1",
      [sessionId],
    );
    assert.equal(remainingMessages.rows[0]?.cnt, 0);
  });
});

test("039 migration extends prompt stages, seeds product.onboarding idempotently, and supports PostgresProductOnboardingRepository", { skip }, async () => {
  const { PostgresProductCardRepository } = await import(
    "../server/repositories/postgres-product-card-repository.js"
  );
  const { PostgresProductOnboardingRepository } = await import(
    "../server/product-onboarding/index.js"
  );
  const { importPromptRecordsWithPolicy } = await import("../server/prompt-library.js");

  await withMigratedSchemas(async ({ pool }) => {
    const prompts = new PostgresPromptRepository(pool);
    const productCards = new PostgresProductCardRepository(pool);
    const onboarding = new PostgresProductOnboardingRepository(pool);

    // 1. Seeded product.onboarding template is active & published at v1 with stage product_onboarding
    const published = await prompts.listPublished("product_onboarding");
    assert.equal(published.length, 1);
    assert.equal(published[0].code, "product.onboarding");
    assert.equal(published[0].stage, "product_onboarding");
    assert.equal(published[0].versionNo, 1);
    assert.deepEqual(published[0].usedBy, ["首页·商品信息建档"]);

    // 2. source_sha256 strictly matches prompt/normalized/product-onboarding.md and import-prompts is idempotent
    const sourcePath = "prompt/normalized/product-onboarding.md";
    const markdown = await readFile(sourcePath, "utf8");
    const parsedRecord = parseNormalizedPromptMarkdown(markdown, sourcePath);
    const seededRuntime = await prompts.getPublishedVersion(
      published[0].templateVersionId,
      "product_onboarding",
    );
    assert.ok(seededRuntime);
    assert.equal(seededRuntime.sourceSha256, parsedRecord.sourceSha256);

    const [reimported] = await importPromptRecordsWithPolicy(prompts, [parsedRecord], {
      publish: false,
    });
    assert.equal(reimported.templateVersionId, seededRuntime.templateVersionId);
    assert.equal(reimported.versionNo, 1);
    assert.equal(reimported.status, "published");
    assert.equal((await prompts.listVersions(seededRuntime.templateId)).length, 1);

    // 3. Stage CHECK rejects unknown stage values
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      await assert.rejects(
        tx.query(
          `INSERT INTO prompt_library.prompt_templates (id, code, name, kind, stage, execution_target)
           VALUES ($1, 'bad.stage', '非法阶段', 'planner', 'unknown_stage', 'llm')`,
          [randomUUID()],
        ),
        { code: "23514", constraint: "prompt_templates_stage_check" },
      );
    } finally {
      await tx.query("ROLLBACK");
      tx.release();
    }

    // 4. Replaying runMigrations with live product_onboarding rows succeeds idempotently
    await runMigrations(pool);
    assert.equal((await prompts.listPublished("product_onboarding")).length, 1);

    // 5. PostgresProductOnboardingRepository end-to-end CRUD, draft update, turn append, publish lock, and delete
    const sessionId = randomUUID();
    const imgId = randomUUID();
    const created = await onboarding.createWithMessages({
      id: sessionId,
      title: "PG 保温杯建档",
      draftCard: {
        name: "PG 不锈钢保温杯",
        sellingPoints: ["316L 内胆"],
        specifications: "",
        materialsCraft: "",
        audienceScenarios: "",
        packageContents: "",
        painPointsComparison: "",
        usageDemoHighlights: "",
        certificationsProhibitions: "",
      },
      draftImages: [
        {
          id: imgId,
          ordinal: 1,
          originalObjectKey: `product-onboarding/${sessionId}/images/${imgId}/original`,
          thumbnailObjectKey: `product-onboarding/${sessionId}/images/${imgId}/thumbnail`,
          sha256: "a".repeat(64),
          width: 400,
          height: 400,
          mimeType: "image/png",
          originalFilename: "cup.png",
          createdAt: timestamp,
        },
      ],
      missingRequiredFields: [
        "specifications",
        "materialsCraft",
        "audienceScenarios",
        "packageContents",
      ],
      messages: [
        {
          id: randomUUID(),
          role: "user",
          content: "帮我建档一款 316L 保温杯",
          attachments: [],
          templateVersionId: null,
          modelSnapshot: null,
          createdAt: timestamp,
        },
        {
          id: randomUUID(),
          role: "assistant",
          content: "请补充规格、材质工艺、人群场景与包装清单。",
          attachments: [],
          templateVersionId: seededRuntime.templateVersionId,
          modelSnapshot: { provider: "fake", model: "vision-v1", isFake: true },
          createdAt: timestamp,
        },
      ],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    assert.equal(created.messages.length, 2);
    assert.equal(created.supplierImages.length, 1);
    assert.equal(
      (await onboarding.getDraftImage(sessionId, imgId))?.thumbnailPreviewUrl,
      `/api/product-onboarding/sessions/${sessionId}/images/${imgId}/preview/thumbnail`,
    );

    const draftUpdate = await onboarding.updateDraft(sessionId, {
      title: "PG 不锈钢保温杯 500ml",
      draftCard: {
        ...created.draftCard,
        name: "PG 不锈钢保温杯 500ml",
        specifications: "500ml，高 215mm，重 265g",
        materialsCraft: "316L 内胆 + 304 外壳",
        audienceScenarios: "通勤办公与户外露营",
        packageContents: "单品本体 ×1，无额外配件",
      },
      draftImages: created.supplierImages.map(({ originalPreviewUrl: _o, thumbnailPreviewUrl: _t, ...rest }) => rest),
      missingRequiredFields: [],
      updatedAt: "2026-01-01T00:05:00.000Z",
    });
    assert.ok(draftUpdate && "session" in draftUpdate);
    assert.deepEqual(draftUpdate.session.missingRequiredFields, []);

    const cardId = randomUUID();
    await productCards.create({
      id: cardId,
      status: "published",
      fields: draftUpdate.session.draftCard,
      sourceSessionId: sessionId,
      revision: 1,
      images: [],
      createdAt: "2026-01-01T00:06:00.000Z",
      updatedAt: "2026-01-01T00:06:00.000Z",
    });
    const completed = await onboarding.markCompleted(
      sessionId,
      cardId,
      "2026-01-01T00:06:00.000Z",
    );
    assert.ok(completed);
    assert.equal(completed.alreadyCompleted, false);
    assert.equal(completed.session.status, "completed");
    assert.equal(completed.session.productCardId, cardId);

    // Second markCompleted is idempotent and mutations return conflict
    const completedAgain = await onboarding.markCompleted(
      sessionId,
      randomUUID(),
      "2026-01-01T00:07:00.000Z",
    );
    assert.equal(completedAgain?.alreadyCompleted, true);
    assert.equal(completedAgain?.session.productCardId, cardId);
    const conflictTurn = await onboarding.appendTurn(sessionId, {
      title: "尝试追加",
      draftCard: draftUpdate.session.draftCard,
      draftImages: [],
      missingRequiredFields: [],
      messages: [],
      updatedAt: "2026-01-01T00:08:00.000Z",
    });
    assert.deepEqual(conflictTurn, { conflict: "completed" });

    assert.equal((await onboarding.list({ status: "completed" })).total, 1);
    assert.equal((await onboarding.list({ status: "draft" })).total, 0);

    // Deleting session cascades messages and leaves published product card intact
    const deletedSession = await onboarding.delete(sessionId);
    assert.ok(deletedSession);
    assert.equal(await onboarding.get(sessionId), null);
    assert.ok(await productCards.get(cardId));
  });
});

test("040 migration upgrades legacy 001..039 database, drops category/sku_code, updates product.onboarding v1, and replays 001..040 idempotently", { skip }, async () => {
  const { readdir } = await import("node:fs/promises");
  const path = await import("node:path");
  const { PostgresProductCardRepository } = await import(
    "../server/repositories/postgres-product-card-repository.js"
  );

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
      assert.doesNotMatch(sql, /\bpublic\b"?\s*\.|\b(?:COMMIT|ROLLBACK|ABORT|END\s+(?:TRANSACTION|WORK)|SET\s+(?:LOCAL\s+|SESSION\s+)?search_path)\b|(?:^|;)\s*END\s*;/i);
      return client.query<Row>(
        sql
          .replace(/\bsuite_workbench\b/g, suiteSchema)
          .replace(/\bprompt_library\b/g, promptSchema)
          .replace(
            /\bFROM pg_constraint WHERE conname\b/gi,
            `FROM pg_catalog.pg_constraint
          WHERE connamespace IN (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = ANY(pg_catalog.current_schemas(false))) AND conname`,
          )
          .replace(
            /\bCREATE EXTENSION IF NOT EXISTS pgcrypto\s*;/i,
            `CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA ${suiteSchema};`,
          )
          .replace(/\b(digest|gen_random_uuid)\(/g, (_match, fn: string) => `${cryptoSchema}.${fn}(`),
        values,
      );
    }

    let leased = false;
    const pool = {
      query,
      async connect() {
        assert.equal(leased, false);
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

    // 1. Run migrations 001..039 only, then simulate legacy pre-040 product_cards row and legacy v1 prompt seed
    const migrationDir = path.resolve("db/migrations");
    const pre040Files = (await readdir(migrationDir))
      .filter((file) => /^\d{3}_.+\.sql$/.test(file) && file < "040_")
      .sort();
    for (const file of pre040Files) {
      await pool.query(await readFile(path.join(migrationDir, file), "utf8"));
    }

    const legacyCardId = randomUUID();
    await pool.query(
      `INSERT INTO suite_workbench.product_cards
        (id, status, name, category, selling_points_json, specifications, materials_craft, audience_scenarios, package_contents, sku_code)
       VALUES ($1, 'published', '存量真空保温杯 500ml', '水杯水具', '["316L 医用级内胆", "12小时保冷"]'::jsonb, '500ml', '316L不锈钢', '通勤露营', '杯体×1', 'LEGACY-SKU-001')`,
      [legacyCardId],
    );

    // Simulate pre-040 product.onboarding v1 row with old sha256
    const legacySha256 = "4b12e4254750710d98a33801ff0e40fcb6b0458d79d51f38bffd2c0ca7b070bd";
    await pool.query(`ALTER TABLE prompt_library.prompt_template_versions DISABLE TRIGGER protect_published_prompt_version`);
    await pool.query(
      `UPDATE prompt_library.prompt_template_versions v
       SET body = 'legacy 7+4 body with category and skuCode',
           output_schema = '{"type":"object","properties":{"schemaVersion":{"const":"product-onboarding-v1"}}}'::jsonb,
           source_sha256 = $1
       FROM prompt_library.prompt_templates t
       WHERE v.template_id = t.id AND t.code = 'product.onboarding' AND v.version_no = 1`,
      [legacySha256],
    );
    await pool.query(`ALTER TABLE prompt_library.prompt_template_versions ENABLE TRIGGER protect_published_prompt_version`);

    // 2. Apply 040 migration on legacy 001..039 schema
    const sql040 = await readFile(path.join(migrationDir, "040_drop_product_card_category_and_sku.sql"), "utf8");
    await pool.query(sql040);

    // Verify category and sku_code columns & old indexes are removed, and new indexes exist
    const cols = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'suite_workbench' AND table_name = 'product_cards'`,
    );
    const colNames = new Set(cols.rows.map((row) => row.column_name));
    assert.equal(colNames.has("category"), false);
    assert.equal(colNames.has("sku_code"), false);

    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'suite_workbench' AND tablename = 'product_cards'`,
    );
    const indexNames = new Set(indexes.rows.map((row) => row.indexname));
    assert.equal(indexNames.has("product_cards_sku_lower_idx"), false);
    assert.equal(indexNames.has("product_cards_category_lower_idx"), false);
    assert.equal(indexNames.has("product_cards_name_lower_idx"), true);
    assert.equal(indexNames.has("product_cards_selling_points_gin_idx"), true);

    // Verify existing card survives and is searchable by selling point via PostgresProductCardRepository
    const cardRepo = new PostgresProductCardRepository(pool);
    const foundBySp = await cardRepo.list({ status: "published", keyword: "316l 医用级" });
    assert.equal(foundBySp.total, 1);
    assert.equal(foundBySp.items[0].id, legacyCardId);
    assert.equal("category" in foundBySp.items[0], false);
    assert.equal("skuCode" in foundBySp.items[0], false);

    // Verify product.onboarding v1 was upgraded in-place to the latest 6+3 prompt & sha256
    const prompts = new PostgresPromptRepository(pool);
    const sourcePath = "prompt/normalized/product-onboarding.md";
    const parsedRecord = parseNormalizedPromptMarkdown(await readFile(sourcePath, "utf8"), sourcePath);
    const published = await prompts.listPublished("product_onboarding");
    assert.equal(published.length, 1);
    assert.equal(published[0].versionNo, 1);
    const runtime = await prompts.getPublishedVersion(published[0].templateVersionId, "product_onboarding");
    assert.ok(runtime);
    assert.equal(runtime.sourceSha256, parsedRecord.sourceSha256);
    assert.match(runtime.body, /6 项入库必填 \+ 3 项选填/);
    assert.doesNotMatch(runtime.body, /skuCode|category/);

    // Verify protect_published_prompt_version trigger is re-enabled after 040
    const guardClient = await pool.connect();
    try {
      await guardClient.query("BEGIN");
      await assert.rejects(
        guardClient.query(
          `UPDATE prompt_library.prompt_template_versions SET body = 'tampered' WHERE id = $1`,
          [runtime.templateVersionId],
        ),
        /published prompt versions are immutable/,
      );
    } finally {
      await guardClient.query("ROLLBACK");
      guardClient.release();
    }

    // Verify import-prompts is idempotent after 040 upgrade (no v2 draft created)
    const [reimported] = await importPromptRecordsWithPolicy(prompts, [parsedRecord], { publish: false });
    assert.equal(reimported.templateVersionId, runtime.templateVersionId);
    assert.equal(reimported.versionNo, 1);
    assert.equal((await prompts.listVersions(runtime.templateId)).length, 1);

    // 3. Replay full migrations 001..040 twice after upgrade -> strictly idempotent without errors
    await runMigrations(pool);
    await runMigrations(pool);
    assert.equal((await prompts.listVersions(runtime.templateId)).length, 1);
    assert.equal((await cardRepo.get(legacyCardId))?.name, "存量真空保温杯 500ml");
  } finally {
    try {
      if (connected) await client.query("ROLLBACK");
    } finally {
      await client.end();
    }
  }
});

