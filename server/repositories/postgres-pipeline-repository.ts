import type { Pool } from "pg";
import type { PipelineRepository, SuitePipelineRun } from "../types.js";

const cols = `id,suite_id AS "suiteId",idempotency_key AS "idempotencyKey",status,current_phase AS "currentPhase",config_json AS config,error_code AS "errorCode",error_message AS "errorMessage",created_at AS "createdAt",updated_at AS "updatedAt",completed_at AS "completedAt"`;

export class PostgresPipelineRepository implements PipelineRepository {
  constructor(private readonly pool: Pool) {}
  async createRun(run: SuitePipelineRun) {
    const found = await this.pool.query<SuitePipelineRun>(`SELECT ${cols} FROM suite_workbench.suite_pipeline_runs WHERE suite_id=$1 AND idempotency_key=$2`, [run.suiteId, run.idempotencyKey]);
    if (found.rows[0]) return { run: found.rows[0], duplicate: true };
    const result = await this.pool.query<SuitePipelineRun>(`INSERT INTO suite_workbench.suite_pipeline_runs (id,suite_id,idempotency_key,status,current_phase,config_json,error_code,error_message,created_at,updated_at,completed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${cols}`, [run.id,run.suiteId,run.idempotencyKey,run.status,run.currentPhase,JSON.stringify(run.config),run.errorCode,run.errorMessage,run.createdAt,run.updatedAt,run.completedAt]);
    return { run: result.rows[0], duplicate: false };
  }
  async getRun(id: string) { const result = await this.pool.query<SuitePipelineRun>(`SELECT ${cols} FROM suite_workbench.suite_pipeline_runs WHERE id=$1`, [id]); return result.rows[0] ?? null; }
  async getLatestRun(suiteId: string) { const result = await this.pool.query<SuitePipelineRun>(`SELECT ${cols} FROM suite_workbench.suite_pipeline_runs WHERE suite_id=$1 ORDER BY created_at DESC LIMIT 1`, [suiteId]); return result.rows[0] ?? null; }
  async listRuns(suiteId: string) { const result = await this.pool.query<SuitePipelineRun>(`SELECT ${cols} FROM suite_workbench.suite_pipeline_runs WHERE suite_id=$1 ORDER BY created_at DESC`, [suiteId]); return result.rows; }
  async updateRun(id: string, patch: Partial<Pick<SuitePipelineRun, "status" | "currentPhase" | "config" | "errorCode" | "errorMessage" | "updatedAt" | "completedAt">>) {
    const fields: string[] = []; const values: unknown[] = []; let n = 1;
    const add = (column: string, value: unknown) => { fields.push(`${column}=$${n++}`); values.push(value); };
    if (patch.status !== undefined) add("status", patch.status);
    if (patch.currentPhase !== undefined) add("current_phase", patch.currentPhase);
    if (patch.config !== undefined) add("config_json", JSON.stringify(patch.config));
    if (patch.errorCode !== undefined) add("error_code", patch.errorCode);
    if (patch.errorMessage !== undefined) add("error_message", patch.errorMessage);
    add("updated_at", patch.updatedAt ?? new Date().toISOString());
    if (patch.completedAt !== undefined) add("completed_at", patch.completedAt);
    values.push(id);
    const result = await this.pool.query<SuitePipelineRun>(`UPDATE suite_workbench.suite_pipeline_runs SET ${fields.join(",")} WHERE id=$${n} RETURNING ${cols}`, values);
    return result.rows[0] ?? null;
  }
}
