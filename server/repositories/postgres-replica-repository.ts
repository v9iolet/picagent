import type { Pool } from "pg";
import type { ReplicaProductImage, ReplicaReference, ReplicaRepository } from "../types.js";

const referenceCols = `id, suite_id AS "suiteId", ordinal, filename, mime_type AS "mimeType", sha256, width, height,
  object_key AS "objectKey", thumbnail_object_key AS "thumbnailObjectKey", COALESCE(remark, '') AS remark, created_at AS "createdAt"`;

const productCols = `id, suite_id AS "suiteId", ordinal, source_kind AS "sourceKind", object_key AS "objectKey",
  thumbnail_object_key AS "thumbnailObjectKey", filename, mime_type AS "mimeType", sha256, width, height,
  library_resource_id AS "libraryResourceId", resource_version_id AS "resourceVersionId", created_at AS "createdAt"`;

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function normalizeReference(row: ReplicaReference): ReplicaReference {
  return {
    ...row,
    remark: row.remark ?? "",
    createdAt: toIsoString(row.createdAt),
  };
}

function normalizeProduct(row: ReplicaProductImage): ReplicaProductImage {
  return {
    ...row,
    thumbnailObjectKey: row.thumbnailObjectKey ?? null,
    filename: row.filename ?? null,
    mimeType: row.mimeType ?? null,
    sha256: row.sha256 ?? null,
    width: row.width ?? null,
    height: row.height ?? null,
    libraryResourceId: row.libraryResourceId ?? null,
    resourceVersionId: row.resourceVersionId ?? null,
    createdAt: toIsoString(row.createdAt),
  };
}

export class PostgresReplicaRepository implements ReplicaRepository {
  constructor(private readonly pool: Pool) {}

  async saveReferences(suiteId: string, references: ReplicaReference[]): Promise<ReplicaReference[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const ordered = [...references].sort((a, b) => a.ordinal - b.ordinal);
      for (const ref of ordered) {
        await client.query(
          `INSERT INTO suite_workbench.replica_references
            (id, suite_id, ordinal, filename, mime_type, sha256, width, height, object_key, thumbnail_object_key, remark, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT DO NOTHING`,
          [
            ref.id,
            suiteId,
            ref.ordinal,
            ref.filename,
            ref.mimeType,
            ref.sha256,
            ref.width,
            ref.height,
            ref.objectKey,
            ref.thumbnailObjectKey,
            ref.remark ?? "",
            ref.createdAt,
          ],
        );
      }
      await client.query("COMMIT");
      return this.listReferences(suiteId);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listReferences(suiteId: string): Promise<ReplicaReference[]> {
    const result = await this.pool.query<ReplicaReference>(
      `SELECT ${referenceCols} FROM suite_workbench.replica_references WHERE suite_id = $1 ORDER BY ordinal ASC`,
      [suiteId],
    );
    return result.rows.map(normalizeReference);
  }

  async getReference(suiteId: string, referenceId: string): Promise<ReplicaReference | null> {
    const result = await this.pool.query<ReplicaReference>(
      `SELECT ${referenceCols} FROM suite_workbench.replica_references WHERE suite_id = $1 AND id = $2`,
      [suiteId, referenceId],
    );
    return result.rows[0] ? normalizeReference(result.rows[0]) : null;
  }

  async saveProductImages(suiteId: string, products: ReplicaProductImage[]): Promise<ReplicaProductImage[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const ordered = [...products].sort((a, b) => a.ordinal - b.ordinal);
      for (const product of ordered) {
        await client.query(
          `INSERT INTO suite_workbench.replica_product_images
            (id, suite_id, ordinal, source_kind, object_key, thumbnail_object_key, filename, mime_type, sha256, width, height, library_resource_id, resource_version_id, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           ON CONFLICT DO NOTHING`,
          [
            product.id,
            suiteId,
            product.ordinal,
            product.sourceKind,
            product.objectKey,
            product.thumbnailObjectKey ?? null,
            product.filename ?? null,
            product.mimeType ?? null,
            product.sha256 ?? null,
            product.width ?? null,
            product.height ?? null,
            product.libraryResourceId ?? null,
            product.resourceVersionId ?? null,
            product.createdAt,
          ],
        );
      }
      await client.query("COMMIT");
      return this.listProductImages(suiteId);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listProductImages(suiteId: string): Promise<ReplicaProductImage[]> {
    const result = await this.pool.query<ReplicaProductImage>(
      `SELECT ${productCols} FROM suite_workbench.replica_product_images WHERE suite_id = $1 ORDER BY ordinal ASC`,
      [suiteId],
    );
    return result.rows.map(normalizeProduct);
  }
}
