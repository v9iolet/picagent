import type { Pool } from "pg";
import type { ListingRepository, ListingJob, ListingSummary } from "../listing-copy.js";

const summary = `j.id, j.source_suite_id AS "sourceSuiteId", j.platform, j.target_market AS "targetMarket", j.output_language AS "outputLanguage", j.input_json AS input, j.status, j.error_code AS "errorCode", j.revision, j.created_at AS "createdAt", j.updated_at AS "updatedAt"`;
const jobs = "suite_workbench.listing_copy_jobs",
  images = "suite_workbench.listing_copy_input_images",
  versions = "suite_workbench.listing_copy_versions";
export class PostgresListingRepository implements ListingRepository {
  constructor(private readonly pool: Pool) {}
  async get(id: string) {
    const result = await this.pool.query<ListingJob>(
      `SELECT ${summary},
      COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY ordinal) FROM
        (SELECT id,ordinal,original_object_key AS "originalObjectKey",thumbnail_object_key AS "thumbnailObjectKey",mime_type AS "mimeType",width,height,sha256,original_filename AS "originalFilename" FROM ${images} WHERE job_id=j.id) i),'[]'::jsonb) AS "inputImages",
      COALESCE((SELECT jsonb_agg(to_jsonb(v) ORDER BY "versionNumber") FROM
        (SELECT id,version_number AS "versionNumber",content_json AS content,prompt_snapshot_json AS "promptSnapshot",created_at AS "createdAt" FROM ${versions} WHERE job_id=j.id) v),'[]'::jsonb) AS versions
      FROM ${jobs} j WHERE j.id=$1`,
      [id],
    );
    return result.rows[0] ?? null;
  }
  async summary(id: string) {
    return (await this.pool.query<ListingSummary>(`SELECT ${summary} FROM ${jobs} j WHERE j.id=$1`, [id])).rows[0] ?? null;
  }
  async list(limit: number, offset: number) {
    return (
      await this.pool.query<ListingSummary>(
        `SELECT ${summary} FROM ${jobs} j WHERE status <> 'draft' ORDER BY updated_at DESC,id LIMIT $1 OFFSET $2`,
        [limit, offset],
      )
    ).rows;
  }
  async save(job: ListingJob, previous: ListingJob | null) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const args = [
        job.id,
        job.platform,
        job.targetMarket,
        job.outputLanguage,
        job.input,
        job.status,
        job.errorCode,
        job.revision,
        job.updatedAt,
      ];
      const written = previous
        ? await client.query(
            `UPDATE ${jobs} SET platform=$2,target_market=$3,output_language=$4,input_json=$5,status=$6,error_code=$7,revision=$8,updated_at=$9 WHERE id=$1 AND revision=$10`,
            [...args, previous.revision],
          )
        : await client.query(
            `INSERT INTO ${jobs} (id,platform,target_market,output_language,input_json,status,error_code,revision,updated_at,source_suite_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
            [...args, job.sourceSuiteId, job.createdAt],
          );
      if (!written.rowCount) {
        await client.query("ROLLBACK");
        return false;
      }
      for (const i of previous?.inputImages ?? []) {
        if (!job.inputImages.some((x) => x.id === i.id))
          await client.query(`DELETE FROM ${images} WHERE job_id=$1 AND id=$2`, [job.id, i.id]);
      }
      for (const i of job.inputImages) {
        if (!previous?.inputImages.some((x) => x.id === i.id))
          await client.query(
            `INSERT INTO ${images} (job_id,id,ordinal,original_object_key,thumbnail_object_key,mime_type,width,height,sha256,original_filename) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              job.id,
              i.id,
              i.ordinal,
              i.originalObjectKey,
              i.thumbnailObjectKey,
              i.mimeType,
              i.width,
              i.height,
              i.sha256,
              i.originalFilename,
            ],
          );
      }
      for (const v of job.versions.slice(previous?.versions.length ?? 0)) {
        await client.query(
          `INSERT INTO ${versions} (job_id,id,version_number,content_json,prompt_snapshot_json,created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
          [job.id, v.id, v.versionNumber, v.content, v.promptSnapshot, v.createdAt],
        );
      }
      await client.query("COMMIT");
      return true;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  async remove(id: string, revision: number) {
    return (await this.pool.query(`DELETE FROM ${jobs} WHERE id=$1 AND revision=$2`, [id, revision])).rowCount === 1;
  }
}
