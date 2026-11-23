import type { Pool } from "pg";
import type { PipelineRepository, SuitePipelinePhase, SuitePipelineRun } from "../types.js";

const cols = `id,suite_id AS "suiteId",idempotency_key AS "idempotencyKey",status,current_phase AS "currentPhase",resume_count AS "resumeCount",last_resume_key AS "lastResumeKey",resume_keys_json AS "resumeKeys",structure_snapshot_id AS "structureSnapshotId",task_ids_json AS "taskIds",config_json AS config,error_code AS "errorCode",error_message AS "errorMessage",created_at AS "createdAt",updated_at AS "updatedAt",completed_at AS "completedAt"`;

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function toNullableIsoString(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function normalizeRun(run: SuitePipelineRun): SuitePipelineRun {
  return {
    ...run,
    createdAt: toIsoString(run.createdAt),
    updatedAt: toIsoString(run.updatedAt),
    completedAt: toNullableIsoString(run.completedAt),
  };
}

export class PostgresPipelineRepository implements PipelineRepository {
  constructor(private readonly pool: Pool) {}
  async createRun(run: SuitePipelineRun) {
    const result = await this.pool.query<SuitePipelineRun>(
      `INSERT INTO suite_workbench.suite_pipeline_runs
        (id,suite_id,idempotency_key,status,current_phase,resume_count,last_resume_key,structure_snapshot_id,task_ids_json,config_json,error_code,error_message,created_at,updated_at,completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT DO NOTHING RETURNING ${cols}`,
      [run.id, run.suiteId, run.idempotencyKey, run.status, run.currentPhase, run.resumeCount ?? 0, run.lastResumeKey ?? null,
        run.structureSnapshotId ?? null, JSON.stringify(run.taskIds ?? []), JSON.stringify(run.config), run.errorCode, run.errorMessage, run.createdAt, run.updatedAt, run.completedAt],
    );
    if (result.rows[0]) return { run: normalizeRun(result.rows[0]), duplicate: false };
    const found = await this.pool.query<SuitePipelineRun>(`SELECT ${cols} FROM suite_workbench.suite_pipeline_runs WHERE suite_id=$1 AND idempotency_key=$2`, [run.suiteId, run.idempotencyKey]);
    if (found.rows[0]) return { run: normalizeRun(found.rows[0]), duplicate: true };
    throw new Error("PIPELINE_ALREADY_RUNNING");
  }
  async resumeRun(previous: SuitePipelineRun, key: string, phase: SuitePipelinePhase, config: SuitePipelineRun["config"]) {
    try {
      const result = await this.pool.query<SuitePipelineRun>(
        `UPDATE suite_workbench.suite_pipeline_runs
         SET status='running', current_phase=$2, config_json=$3, resume_count=resume_count+1,
             last_resume_key=$4, resume_keys_json=resume_keys_json || jsonb_build_array($4::text),
             error_code=NULL, error_message=NULL, completed_at=NULL, updated_at=now()
         WHERE id=$1 AND status=$5 AND resume_count=$6 AND NOT (resume_keys_json ? $4)
         RETURNING ${cols}`,
        [previous.id, phase, JSON.stringify(config), key, previous.status, previous.resumeCount ?? 0],
      );
      return result.rows[0] ? normalizeRun(result.rows[0]) : null;
    } catch (error) {
      if (error instanceof Error && "constraint" in error && error.constraint === "suite_pipeline_runs_one_running") return null;
      throw error;
    }
  }
  async getRun(id: string) { const result = await this.pool.query<SuitePipelineRun>(`SELECT ${cols} FROM suite_workbench.suite_pipeline_runs WHERE id=$1`, [id]); return result.rows[0] ? normalizeRun(result.rows[0]) : null; }
  async getLatestRun(suiteId: string) { const result = await this.pool.query<SuitePipelineRun>(`SELECT ${cols} FROM suite_workbench.suite_pipeline_runs WHERE suite_id=$1 ORDER BY created_at DESC LIMIT 1`, [suiteId]); return result.rows[0] ? normalizeRun(result.rows[0]) : null; }
  async listRuns(suiteId: string) { const result = await this.pool.query<SuitePipelineRun>(`SELECT ${cols} FROM suite_workbench.suite_pipeline_runs WHERE suite_id=$1 ORDER BY created_at DESC`, [suiteId]); return result.rows.map(normalizeRun); }
  async updateRun(id: string, patch: Partial<Pick<SuitePipelineRun, "status" | "currentPhase" | "resumeCount" | "lastResumeKey" | "structureSnapshotId" | "taskIds" | "config" | "errorCode" | "errorMessage" | "updatedAt" | "completedAt">>) {
    const fields: string[] = []; const values: unknown[] = []; let n = 1;
    const add = (column: string, value: unknown) => { fields.push(`${column}=$${n++}`); values.push(value); };
    if (patch.status !== undefined) add("status", patch.status);
    if (patch.currentPhase !== undefined) add("current_phase", patch.currentPhase);
    if (patch.resumeCount !== undefined) add("resume_count", patch.resumeCount);
    if (patch.lastResumeKey !== undefined) add("last_resume_key", patch.lastResumeKey);
    if (patch.structureSnapshotId !== undefined) add("structure_snapshot_id", patch.structureSnapshotId);
    if (patch.taskIds !== undefined) add("task_ids_json", JSON.stringify(patch.taskIds));
    if (patch.config !== undefined) add("config_json", JSON.stringify(patch.config));
    if (patch.errorCode !== undefined) add("error_code", patch.errorCode);
    if (patch.errorMessage !== undefined) add("error_message", patch.errorMessage);
    add("updated_at", patch.updatedAt ?? new Date().toISOString());
    if (patch.completedAt !== undefined) add("completed_at", patch.completedAt);
    values.push(id);
    const result = await this.pool.query<SuitePipelineRun>(`UPDATE suite_workbench.suite_pipeline_runs SET ${fields.join(",")} WHERE id=$${n} RETURNING ${cols}`, values);
    return result.rows[0] ? normalizeRun(result.rows[0]) : null;
  }
}
