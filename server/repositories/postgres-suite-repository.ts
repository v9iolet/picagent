import type { Pool, PoolClient } from "pg";
import type {
  BaseGenerationAttemptInput,
  BaseGenerationSuccessInput,
  BaseImageVersion,
  GenerationAttempt,
  InputImage,
  Suite,
  SuiteRepository, SuiteOrigin,
} from "../types.js";

const inputImageColumns = `id, suite_id AS "suiteId", ordinal, original_object_key AS "originalObjectKey",
  thumbnail_object_key AS "thumbnailObjectKey", sha256, width, height, mime_type AS "mimeType",
  original_filename AS "originalFilename", current_base_version_id AS "currentBaseVersionId", created_at AS "createdAt"`;
const attemptColumns = `id, suite_id AS "suiteId", input_image_id AS "inputImageId", base_version_id AS "baseVersionId",
  version_number AS "versionNumber", idempotency_key AS "idempotencyKey", status, model, channel_snapshot_json AS channel, endpoint, prompt, size,
  prompt_template_version_id AS "promptTemplateVersionId", dynamic_input_json AS "dynamicInput", quality, n,
  response_format AS "responseFormat", error_code AS "errorCode", error_message AS "errorMessage",
  created_at AS "createdAt", completed_at AS "completedAt"`;
const versionColumns = `id, suite_id AS "suiteId", input_image_id AS "inputImageId", attempt_id AS "attemptId",
  version_number AS "versionNumber", object_key AS "objectKey", sha256, width, height, mime_type AS "mimeType",
  created_at AS "createdAt"`;

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function toNullableIsoString(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function normalizeSuite(suite: Suite): Suite {
  return {
    ...suite,
    ...("styleOverrideUpdatedAt" in suite
      ? { styleOverrideUpdatedAt: toNullableIsoString(suite.styleOverrideUpdatedAt) }
      : {}),
    createdAt: toIsoString(suite.createdAt),
    updatedAt: toIsoString(suite.updatedAt),
  };
}

function normalizeAttempt(attempt: GenerationAttempt): GenerationAttempt {
  return {
    ...attempt,
    createdAt: toIsoString(attempt.createdAt),
    completedAt: toNullableIsoString(attempt.completedAt),
  };
}

function normalizeBaseVersion(version: BaseImageVersion): BaseImageVersion {
  return {
    ...version,
    createdAt: toIsoString(version.createdAt),
  };
}

function withPreviewUrls(image: Omit<InputImage, "originalPreviewUrl" | "thumbnailPreviewUrl">): InputImage {
  return {
    ...image,
    createdAt: toIsoString(image.createdAt),
    originalPreviewUrl: `/api/suites/${image.suiteId}/input-images/${image.id}/preview/original`,
    thumbnailPreviewUrl: `/api/suites/${image.suiteId}/input-images/${image.id}/preview/thumbnail`,
  };
}

export class PostgresSuiteRepository implements SuiteRepository {
  constructor(private readonly pool: Pool) {}

  async createSuite(name: string, idempotencyKey?: string, origin: SuiteOrigin = "suite_studio") {
    const client = await this.pool.connect();
    const scope = origin === "aplus" ? "aplus.create" : "suite.create";
    try {
      await client.query("BEGIN");
      if (idempotencyKey) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${scope}:${idempotencyKey}`]);
        const existing = await client.query<{ resource_id: string }>("SELECT resource_id FROM suite_workbench.idempotency_keys WHERE scope = $1 AND key = $2", [scope, idempotencyKey]);
        if (existing.rowCount) {
          const suite = await this.getSuite(existing.rows[0].resource_id, client);
          if (suite) {
            await client.query("COMMIT");
            return suite;
          }
          await client.query("DELETE FROM suite_workbench.idempotency_keys WHERE scope = $1 AND key = $2", [scope, idempotencyKey]);
        }
      }
      const result = await client.query<Suite>("INSERT INTO suite_workbench.suites (id, name, status, origin, created_at, updated_at) VALUES (gen_random_uuid(), $1, 'draft', $2, now(), now()) RETURNING id, name, status, origin, created_at AS \"createdAt\", updated_at AS \"updatedAt\"", [name, origin]);
      const suite = normalizeSuite(result.rows[0]);
      if (idempotencyKey) await client.query("INSERT INTO suite_workbench.idempotency_keys (scope, key, resource_id) VALUES ($1, $2, $3)", [scope, idempotencyKey, suite.id]);
      await client.query("COMMIT");
      return suite;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listSuites() {
    const result = await this.pool.query<Suite>("SELECT id, name, status, origin, style_override AS \"styleOverride\", style_override_updated_at AS \"styleOverrideUpdatedAt\", created_at AS \"createdAt\", updated_at AS \"updatedAt\" FROM suite_workbench.suites WHERE deleted_at IS NULL ORDER BY created_at DESC");
    return result.rows.map(normalizeSuite);
  }

  async getSuite(id: string, client: Pool | PoolClient = this.pool) {
    const result = await client.query<Suite>("SELECT id, name, status, origin, style_override AS \"styleOverride\", style_override_updated_at AS \"styleOverrideUpdatedAt\", created_at AS \"createdAt\", updated_at AS \"updatedAt\" FROM suite_workbench.suites WHERE id = $1 AND deleted_at IS NULL", [id]);
    return result.rows[0] ? normalizeSuite(result.rows[0]) : null;
  }

  async findAplusSuiteByIdempotencyKey(key: string) {
    const result = await this.pool.query<{ resource_id: string }>(
      "SELECT resource_id FROM suite_workbench.idempotency_keys WHERE scope = 'aplus.create' AND key = $1",
      [key],
    );
    return result.rows[0] ? this.getSuite(result.rows[0].resource_id) : null;
  }

  async renameSuite(suiteId: string, name: string) {
    const result = await this.pool.query<Suite>(
      "UPDATE suite_workbench.suites SET name = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id, name, status, origin, style_override AS \"styleOverride\", style_override_updated_at AS \"styleOverrideUpdatedAt\", created_at AS \"createdAt\", updated_at AS \"updatedAt\"",
      [suiteId, name.trim()],
    );
    return result.rows[0] ? normalizeSuite(result.rows[0]) : null;
  }

  async deleteSuite(suiteId: string) {
    const result = await this.pool.query<{ id: string }>(
      "UPDATE suite_workbench.suites SET deleted_at = now(), updated_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id",
      [suiteId],
    );
    return result.rows[0] ?? null;
  }

  async updateSuiteStyleOverride(suiteId: string, styleOverride: string | null) {
    const cleaned = styleOverride?.trim() ? styleOverride.trim() : null;
    const result = await this.pool.query<Suite>(
      "UPDATE suite_workbench.suites SET style_override = $2, style_override_updated_at = CASE WHEN $2 IS NULL THEN NULL ELSE now() END, updated_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id, name, status, origin, style_override AS \"styleOverride\", style_override_updated_at AS \"styleOverrideUpdatedAt\", created_at AS \"createdAt\", updated_at AS \"updatedAt\"",
      [suiteId, cleaned],
    );
    return result.rows[0] ? normalizeSuite(result.rows[0]) : null;
  }

  async getInputImages(suiteId: string) {
    const result = await this.pool.query<Omit<InputImage, "originalPreviewUrl" | "thumbnailPreviewUrl">>(`SELECT ${inputImageColumns} FROM suite_workbench.input_images WHERE suite_id = $1 ORDER BY ordinal`, [suiteId]);
    return result.rows.map(withPreviewUrls);
  }

  async getInputImage(suiteId: string, inputImageId: string) {
    const result = await this.pool.query<Omit<InputImage, "originalPreviewUrl" | "thumbnailPreviewUrl">>(`SELECT ${inputImageColumns} FROM suite_workbench.input_images WHERE suite_id = $1 AND id = $2`, [suiteId, inputImageId]);
    return result.rows[0] ? withPreviewUrls(result.rows[0]) : null;
  }

  async hasInputImageHash(suiteId: string, sha256: string) {
    const result = await this.pool.query("SELECT 1 FROM suite_workbench.input_images WHERE suite_id = $1 AND sha256 = $2 LIMIT 1", [suiteId, sha256]);
    return (result.rowCount ?? 0) > 0;
  }

  async createInputImage(input: Omit<InputImage, "originalPreviewUrl" | "thumbnailPreviewUrl">, idempotencyKey?: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (idempotencyKey) {
        const existing = await client.query<{ resource_id: string }>("SELECT resource_id FROM suite_workbench.idempotency_keys WHERE scope = $1 AND key = $2", [`suite.${input.suiteId}.input-image`, idempotencyKey]);
        if (existing.rowCount) {
          const found = await client.query<Omit<InputImage, "originalPreviewUrl" | "thumbnailPreviewUrl">>(`SELECT ${inputImageColumns} FROM suite_workbench.input_images WHERE id = $1`, [existing.rows[0].resource_id]);
          await client.query("COMMIT");
          return withPreviewUrls(found.rows[0]);
        }
      }
      await client.query("SELECT id FROM suite_workbench.suites WHERE id = $1 FOR UPDATE", [input.suiteId]);
      const duplicate = await client.query("SELECT 1 FROM suite_workbench.input_images WHERE suite_id = $1 AND sha256 = $2 LIMIT 1", [input.suiteId, input.sha256]);
      if (duplicate.rowCount) throw new Error("DUPLICATE_IMAGE");
      const result = await client.query<Omit<InputImage, "originalPreviewUrl" | "thumbnailPreviewUrl">>(`INSERT INTO suite_workbench.input_images
        (id, suite_id, ordinal, original_object_key, thumbnail_object_key, sha256, width, height, mime_type, original_filename, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${inputImageColumns}`,
      [input.id, input.suiteId, input.ordinal, input.originalObjectKey, input.thumbnailObjectKey, input.sha256, input.width, input.height, input.mimeType, input.originalFilename, input.createdAt]);
      const image = result.rows[0];
      if (idempotencyKey) await client.query("INSERT INTO suite_workbench.idempotency_keys (scope, key, resource_id) VALUES ($1,$2,$3)", [`suite.${input.suiteId}.input-image`, idempotencyKey, image.id]);
      await client.query("UPDATE suite_workbench.suites SET status = 'in_progress', updated_at = $2 WHERE id = $1", [input.suiteId, input.createdAt]);
      await client.query("COMMIT");
      return withPreviewUrls(image);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async removeInputImage(suiteId: string, inputImageId: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query<Omit<InputImage, "originalPreviewUrl" | "thumbnailPreviewUrl">>(`SELECT ${inputImageColumns} FROM suite_workbench.input_images WHERE suite_id = $1 AND id = $2 FOR UPDATE`, [suiteId, inputImageId]);
      if (!found.rows[0]) { await client.query("ROLLBACK"); return null; }
      const history = await client.query("SELECT 1 FROM suite_workbench.generation_attempts WHERE input_image_id = $1 LIMIT 1", [inputImageId]);
      if (history.rowCount) throw new Error("INPUT_IMAGE_HAS_HISTORY");
      await client.query("DELETE FROM suite_workbench.input_images WHERE suite_id = $1 AND id = $2", [suiteId, inputImageId]);
      await client.query("UPDATE suite_workbench.suites SET updated_at = now() WHERE id = $1", [suiteId]);
      await client.query("COMMIT");
      return withPreviewUrls(found.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async beginBaseGeneration(input: BaseGenerationAttemptInput) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query("SELECT id FROM suite_workbench.input_images WHERE suite_id = $1 AND id = $2 FOR UPDATE", [input.suiteId, input.inputImageId]);
      if (!locked.rowCount) throw new Error("INVALID_INPUT_IMAGE");
      const existing = await client.query<GenerationAttempt>(`SELECT ${attemptColumns} FROM suite_workbench.generation_attempts WHERE input_image_id = $1 AND idempotency_key = $2`, [input.inputImageId, input.idempotencyKey]);
      if (existing.rowCount) {
        const version = await client.query<BaseImageVersion>(`SELECT ${versionColumns} FROM suite_workbench.base_image_versions WHERE id = $1`, [existing.rows[0].baseVersionId]);
        await client.query("COMMIT");
        return { attempt: normalizeAttempt(existing.rows[0]), existingVersion: version.rows[0] ? normalizeBaseVersion(version.rows[0]) : null, duplicate: true };
      }
      const running = await client.query("SELECT 1 FROM suite_workbench.generation_attempts WHERE input_image_id=$1 AND status='running' LIMIT 1", [input.inputImageId]);
      if (running.rowCount) throw new Error("BASE_GENERATION_IN_PROGRESS");
      const next = await client.query<{ version_number: number }>("SELECT COALESCE(MAX(version_number), 0) + 1 AS version_number FROM suite_workbench.generation_attempts WHERE input_image_id = $1 AND status IN ('running', 'succeeded')", [input.inputImageId]);
      const result = await client.query<GenerationAttempt>(`INSERT INTO suite_workbench.generation_attempts
        (id, suite_id, input_image_id, base_version_id, version_number, idempotency_key, status, model, endpoint, prompt,
          prompt_template_version_id, dynamic_input_json, size, quality, n, response_format, created_at, channel_snapshot_json)
        VALUES ($1,$2,$3,$4,$5,$6,'running',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING ${attemptColumns}`,
      [input.id, input.suiteId, input.inputImageId, input.baseVersionId, next.rows[0].version_number, input.idempotencyKey,
        input.model, input.endpoint, input.prompt, input.promptTemplateVersionId, JSON.stringify(input.dynamicInput), input.size,
        input.quality, input.n, input.responseFormat, input.createdAt, input.channel ? JSON.stringify(input.channel) : null]);
      await client.query("COMMIT");
      return { attempt: normalizeAttempt(result.rows[0]), existingVersion: null, duplicate: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async completeBaseGeneration(input: BaseGenerationSuccessInput) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const attemptResult = await client.query<GenerationAttempt>(`SELECT ${attemptColumns} FROM suite_workbench.generation_attempts WHERE id = $1 FOR UPDATE`, [input.attemptId]);
      const attempt = attemptResult.rows[0];
      if (!attempt || attempt.status !== "running") throw new Error("INVALID_GENERATION_ATTEMPT");
      const versionResult = await client.query<BaseImageVersion>(`INSERT INTO suite_workbench.base_image_versions
        (id, suite_id, input_image_id, attempt_id, version_number, object_key, sha256, width, height, mime_type, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${versionColumns}`,
      [attempt.baseVersionId, attempt.suiteId, attempt.inputImageId, attempt.id, attempt.versionNumber, input.objectKey, input.sha256, input.width, input.height, input.mimeType, input.completedAt]);
      const completed = await client.query<GenerationAttempt>(`UPDATE suite_workbench.generation_attempts SET status = 'succeeded', completed_at = $2 WHERE id = $1 RETURNING ${attemptColumns}`, [attempt.id, input.completedAt]);
      await client.query("UPDATE suite_workbench.input_images SET current_base_version_id = $2 WHERE id = $1", [attempt.inputImageId, attempt.baseVersionId]);
      await client.query("UPDATE suite_workbench.suites SET updated_at = $2 WHERE id = $1", [attempt.suiteId, input.completedAt]);
      await client.query("COMMIT");
      return { attempt: normalizeAttempt(completed.rows[0]), version: normalizeBaseVersion(versionResult.rows[0]) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async failBaseGeneration(attemptId: string, errorCode: string, errorMessage: string, completedAt: string) {
    const result = await this.pool.query<GenerationAttempt>(`UPDATE suite_workbench.generation_attempts SET status = 'failed', error_code = $2, error_message = $3, completed_at = $4 WHERE id = $1 AND status = 'running' RETURNING ${attemptColumns}`, [attemptId, errorCode, errorMessage, completedAt]);
    if (!result.rows[0]) throw new Error("INVALID_GENERATION_ATTEMPT");
    return normalizeAttempt(result.rows[0]);
  }

  async listBaseImageVersions(suiteId: string, inputImageId: string) {
    const result = await this.pool.query<BaseImageVersion>(`SELECT ${versionColumns} FROM suite_workbench.base_image_versions WHERE suite_id = $1 AND input_image_id = $2 ORDER BY version_number DESC`, [suiteId, inputImageId]);
    return result.rows.map(normalizeBaseVersion);
  }

  async listGenerationAttempts(suiteId: string, inputImageId: string) {
    const result = await this.pool.query<GenerationAttempt>(`SELECT ${attemptColumns} FROM suite_workbench.generation_attempts WHERE suite_id = $1 AND input_image_id = $2 ORDER BY created_at DESC`, [suiteId, inputImageId]);
    return result.rows.map(normalizeAttempt);
  }

  async getBaseImageVersion(suiteId: string, inputImageId: string, versionId: string) {
    const result = await this.pool.query<BaseImageVersion>(`SELECT ${versionColumns} FROM suite_workbench.base_image_versions WHERE suite_id = $1 AND input_image_id = $2 AND id = $3`, [suiteId, inputImageId, versionId]);
    return result.rows[0] ? normalizeBaseVersion(result.rows[0]) : null;
  }

  async selectBaseImageVersion(suiteId: string, inputImageId: string, versionId: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const version = await client.query<BaseImageVersion>(`SELECT ${versionColumns} FROM suite_workbench.base_image_versions WHERE suite_id = $1 AND input_image_id = $2 AND id = $3`, [suiteId, inputImageId, versionId]);
      if (!version.rowCount) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query("UPDATE suite_workbench.input_images SET current_base_version_id = $3 WHERE suite_id = $1 AND id = $2", [suiteId, inputImageId, versionId]);
      await client.query("UPDATE suite_workbench.suites SET updated_at = now() WHERE id = $1", [suiteId]);
      await client.query("COMMIT");
      return normalizeBaseVersion(version.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
