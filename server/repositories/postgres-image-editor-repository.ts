import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AplusSizePresetKey } from "../../shared/aplus.js";
import { imageEditProductInputs, removeDraftOperations, upsertDraftOperation, type CompleteImageEditAttemptInput, type EditDraft, type EditOperation, type EditSnapshot, type EditSubmissionInput, type ImageEditAttempt, type ImageEditChildTask, type ImageEditVersion, type ImageEditorRepository } from "../image-editor.js";

const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const draftRow = `session_id AS "sessionId",operations_json AS operations,summary`;
const snapshotRow = `id,source_card_id AS "sourceCardId",source_version_id AS "sourceVersionId",parent_version_id AS "parentVersionId",summary,source_prompt AS "sourcePrompt",operations_json AS operations,provider_json AS provider,created_at AS "createdAt",schema_version AS "schemaVersion",tool,attached_inputs_json AS "attachedInputs",mask_applied AS "maskApplied",prompt_template_version_id AS "promptTemplateVersionId"`;
const taskRow = `id,source_card_id AS "sourceCardId",source_version_id AS "sourceVersionId",parent_version_id AS "parentVersionId",snapshot_id AS "snapshotId",summary,status,current_version_id AS "currentVersionId",final_version_id AS "finalVersionId",error_code AS "errorCode",error_message AS "errorMessage",created_at AS "createdAt",updated_at AS "updatedAt"`;
const attemptRow = `id,child_task_id AS "childTaskId",snapshot_id AS "snapshotId",attempt_no AS "attemptNo",command_json AS command,provider_json AS provider,status,error_code AS "errorCode",error_message AS "errorMessage",created_at AS "createdAt",completed_at AS "completedAt"`;
const versionRow = `id,child_task_id AS "childTaskId",attempt_id AS "attemptId",version_number AS "versionNumber",object_key AS "objectKey",sha256,width,height,mime_type AS "mimeType",created_at AS "createdAt",generated_size_json AS "generatedSize",delivery_size_json AS "deliverySize",delivery_object_key AS "deliveryObjectKey"`;

export class PostgresImageEditorRepository implements ImageEditorRepository {
  constructor(private readonly pool: Pool) {}
  async getSourceVersion(versionId: string) {
    if (!UUID_RE.test(versionId)) return null;
    const result = await this.pool.query<{
      objectKey: string; mimeType: string; generationPrompt: string; inputImages: unknown;
      aplusPreset: AplusSizePresetKey | null; resolution: string | null;
    }>(
      `WITH RECURSIVE edit_lineage(id) AS (
         SELECT $1::uuid
         UNION
         SELECT s.source_version_id::uuid
         FROM edit_lineage l
         JOIN suite_workbench.image_edit_versions v ON v.id = l.id
         JOIN suite_workbench.image_edit_attempts a ON a.id = v.attempt_id
         JOIN suite_workbench.image_edit_snapshots s ON s.id = a.snapshot_id
         WHERE s.source_version_id ~* $2
       ), task_lineage AS (
         SELECT v.task_id, v.version_number, v.context_snapshot_json, 0 AS depth
         FROM edit_lineage l
         JOIN suite_workbench.task_image_versions v ON v.id = l.id
         UNION ALL
         SELECT previous.task_id, previous.version_number, previous.context_snapshot_json, l.depth + 1
         FROM task_lineage l
         JOIN LATERAL (
           SELECT v.task_id, v.version_number, v.context_snapshot_json
           FROM suite_workbench.task_image_versions v
           WHERE v.task_id = l.task_id
             AND v.version_number < l.version_number
             AND v.object_key = l.context_snapshot_json #>> '{inputImages,0,objectKey}'
           ORDER BY v.version_number DESC
           LIMIT 1
         ) previous ON true
         WHERE l.context_snapshot_json #>> '{inputImages,0,role}' = 'product'
           AND l.context_snapshot_json #> '{inputImages,1}' IS NULL
       ), source AS (
         SELECT v.object_key AS "objectKey", v.mime_type AS "mimeType", COALESCE(a.command_json->>'prompt', '') AS "generationPrompt"
         FROM suite_workbench.image_edit_versions v
         JOIN suite_workbench.image_edit_attempts a ON a.id = v.attempt_id
         WHERE v.id = $1
         UNION ALL
         SELECT object_key, mime_type, COALESCE(prompt_snapshot_json->>'finalPrompt', prompt_snapshot_json->>'prompt', '')
         FROM suite_workbench.task_image_versions
         WHERE id = $1
       )
       SELECT source.*, root.context_snapshot_json->'inputImages' AS "inputImages",
              t.size_preset AS "aplusPreset", t.generation_params_json->>'size' AS resolution
       FROM source
       LEFT JOIN (SELECT * FROM task_lineage ORDER BY depth DESC LIMIT 1) root ON true
       LEFT JOIN suite_workbench.suite_tasks t ON t.id = root.task_id AND t.origin_kind = 'aplus'`, [versionId, UUID_RE.source],
    );
    if (!result.rows.length) return null;
    const { inputImages, aplusPreset, resolution, ...source } = result.rows[0];
    return {
      ...source, productInputs: imageEditProductInputs(inputImages),
      ...(aplusPreset ? { aplus: { preset: aplusPreset, resolution: resolution === "2K" ? "2K" as const : "1K" as const } } : {}),
    };
  }
  async validateSource(sourceCardId: string, sourceVersionId: string) {
    if (!UUID_RE.test(sourceVersionId)) throw new Error("SOURCE_VERSION_NOT_FOUND");
    if (!UUID_RE.test(sourceCardId)) return false;
    const result = await this.pool.query<{ valid: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM suite_workbench.task_image_versions WHERE task_id=$1 AND id=$2)
           OR EXISTS (SELECT 1 FROM suite_workbench.image_edit_versions WHERE child_task_id=$1 AND id=$2) AS valid`,
      [sourceCardId, sourceVersionId],
    );
    return Boolean(result.rows[0]?.valid);
  }
  async getDraft(sessionId: string) {
    const result = await this.pool.query<EditDraft>(`SELECT ${draftRow} FROM suite_workbench.image_edit_drafts WHERE session_id=$1`, [sessionId]);
    return result.rows[0] ?? null;
  }
  private async updateDraft(client: PoolClient, sessionId: string, change: (draft: EditDraft) => EditDraft) {
    const result = await client.query<EditDraft>(`SELECT ${draftRow} FROM suite_workbench.image_edit_drafts WHERE session_id=$1 FOR UPDATE`, [sessionId]);
    if (!result.rows[0]) return null;
    const draft = change(result.rows[0]);
    await client.query(`UPDATE suite_workbench.image_edit_drafts SET operations_json=$2,summary=$3,updated_at=now() WHERE session_id=$1`,
      [sessionId, JSON.stringify(draft.operations), draft.summary]);
    return draft;
  }
  private async editDraft(sessionId: string, change: (draft: EditDraft) => EditDraft, create = false) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (create) {
        await client.query(`INSERT INTO suite_workbench.image_edit_drafts(session_id) VALUES($1) ON CONFLICT DO NOTHING`, [sessionId]);
      }
      const draft = await this.updateDraft(client, sessionId, change);
      await client.query("COMMIT");
      return draft;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async upsertDraftOperation(sessionId: string, operation: EditOperation, summary?: string) {
    const draft = await this.editDraft(sessionId, (current) => upsertDraftOperation(current, operation, summary), true);
    if (!draft) throw new Error("EDIT_SESSION_NOT_FOUND");
    return draft;
  }
  async removeDraftOperations(sessionId: string, operationIds: readonly string[]) {
    return this.editDraft(sessionId, (current) => removeDraftOperations(current, operationIds));
  }
  async getSnapshot(id: string) { const r = await this.pool.query<EditSnapshot>(`SELECT ${snapshotRow} FROM suite_workbench.image_edit_snapshots WHERE id=$1`, [id]); return r.rows[0] ?? null; }
  async getChildTask(id: string) { const r = await this.pool.query<ImageEditChildTask>(`SELECT ${taskRow} FROM suite_workbench.image_edit_child_tasks WHERE id=$1`, [id]); return r.rows[0] ?? null; }
  async listChildTasks() { const r = await this.pool.query<ImageEditChildTask>(`SELECT ${taskRow} FROM suite_workbench.image_edit_child_tasks ORDER BY created_at`); return r.rows; }
  async listChildTasksBySourceCard(sourceCardId: string) { const r = await this.pool.query<ImageEditChildTask>(`SELECT ${taskRow} FROM suite_workbench.image_edit_child_tasks WHERE source_card_id=$1 ORDER BY created_at`, [sourceCardId]); return r.rows; }
  async getOcrSnapshot(sessionId: string, sourceVersionId: string) { const r = await this.pool.query(`SELECT source_version_id AS "sourceVersionId", status, blocks_json AS blocks, error, provider_json AS provider FROM suite_workbench.image_edit_ocr_snapshots WHERE session_id=$1 AND source_version_id=$2`, [sessionId, sourceVersionId]); return r.rows[0] ? { ...r.rows[0], blocks: r.rows[0].blocks ?? [] } : null; }
  async saveOcrSnapshot(sessionId: string, snapshot: import("../image-editor.js").OcrSnapshot) { await this.pool.query(`INSERT INTO suite_workbench.image_edit_ocr_snapshots(session_id,source_version_id,status,blocks_json,error,provider_json,updated_at) VALUES($1,$2,$3,$4,$5,$6,now()) ON CONFLICT(session_id,source_version_id) DO UPDATE SET status=EXCLUDED.status,blocks_json=EXCLUDED.blocks_json,error=EXCLUDED.error,provider_json=EXCLUDED.provider_json,updated_at=now()`, [sessionId, snapshot.sourceVersionId, snapshot.status, JSON.stringify(snapshot.blocks), snapshot.error ?? null, snapshot.provider ? JSON.stringify(snapshot.provider) : null]); }
  async getAttempt(id: string) { const r = await this.pool.query<ImageEditAttempt>(`SELECT ${attemptRow} FROM suite_workbench.image_edit_attempts WHERE id=$1`, [id]); return r.rows[0] ?? null; }
  async getSubmission(idempotencyKey: string) {
    const result = await this.pool.query<{ snapshotId: string; childTaskId: string; attemptId: string }>(
      'SELECT snapshot_id AS "snapshotId",child_task_id AS "childTaskId",attempt_id AS "attemptId" FROM suite_workbench.image_edit_idempotency WHERE idempotency_key=$1',
      [idempotencyKey],
    );
    const row = result.rows[0];
    if (!row) return null;
    const [snapshot, childTask, attempt] = await Promise.all([this.getSnapshot(row.snapshotId), this.getChildTask(row.childTaskId), this.getAttempt(row.attemptId)]);
    return snapshot && childTask && attempt ? { snapshot, childTask, attempt, duplicate: true } : null;
  }
  async submit({ submittedDraft, ...input }: EditSubmissionInput) {
    const client = await this.pool.connect();
    const { idempotencyKey, snapshot, childTask, attempt } = input;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [idempotencyKey]);
      const existing = await client.query(
        `SELECT 1 FROM suite_workbench.image_edit_idempotency WHERE idempotency_key=$1`, [idempotencyKey],
      );
      if (existing.rowCount) {
        await client.query("COMMIT");
        return (await this.getSubmission(idempotencyKey))!;
      }
      if (submittedDraft) {
        const updated = await this.updateDraft(client, submittedDraft.sessionId,
          (draft) => removeDraftOperations(draft, [], submittedDraft.operations));
        if (!updated) throw new Error("EDIT_DRAFT_CHANGED");
      }
      await client.query(
        `INSERT INTO suite_workbench.image_edit_snapshots
         (id,source_card_id,source_version_id,parent_version_id,summary,source_prompt,operations_json,provider_json,
          schema_version,created_at,tool,attached_inputs_json,mask_applied,prompt_template_version_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [snapshot.id, snapshot.sourceCardId, snapshot.sourceVersionId, snapshot.parentVersionId, snapshot.summary,
          snapshot.sourcePrompt, JSON.stringify(snapshot.operations), JSON.stringify(snapshot.provider), snapshot.schemaVersion,
          snapshot.createdAt, snapshot.tool ?? null, JSON.stringify(snapshot.attachedInputs ?? []),
          snapshot.maskApplied ?? null, snapshot.promptTemplateVersionId ?? null],
      );
      await client.query(
        `INSERT INTO suite_workbench.image_edit_child_tasks
         (id,source_card_id,source_version_id,parent_version_id,snapshot_id,summary,status,error_code,error_message,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
        [childTask.id, childTask.sourceCardId, childTask.sourceVersionId, childTask.parentVersionId, childTask.snapshotId,
          childTask.summary, childTask.status, childTask.errorCode, childTask.errorMessage, childTask.createdAt],
      );
      await client.query(
        `INSERT INTO suite_workbench.image_edit_attempts
         (id,child_task_id,snapshot_id,attempt_no,command_json,provider_json,status,error_code,error_message,created_at,completed_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [attempt.id, attempt.childTaskId, attempt.snapshotId, attempt.attemptNo, JSON.stringify(attempt.command),
          JSON.stringify(attempt.provider), attempt.status, attempt.errorCode, attempt.errorMessage, attempt.createdAt, attempt.completedAt],
      );
      await client.query(
        `INSERT INTO suite_workbench.image_edit_idempotency(idempotency_key,snapshot_id,child_task_id,attempt_id) VALUES($1,$2,$3,$4)`,
        [idempotencyKey, snapshot.id, childTask.id, attempt.id],
      );
      await client.query("COMMIT");
      return { ...input, duplicate: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async appendAttempt(input: { idempotencyKey: string; snapshot: EditSnapshot; childTask: ImageEditChildTask; attempt: ImageEditAttempt }) { const c = await this.pool.connect(); try { await c.query("BEGIN"); await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [input.idempotencyKey]); const old = await c.query(`SELECT snapshot_id AS "snapshotId",child_task_id AS "childTaskId",attempt_id AS "attemptId" FROM suite_workbench.image_edit_idempotency WHERE idempotency_key=$1`, [input.idempotencyKey]); if (old.rowCount) { await c.query("COMMIT"); return { snapshot: (await this.getSnapshot(old.rows[0].snapshotId))!, childTask: (await this.getChildTask(old.rows[0].childTaskId))!, attempt: (await this.getAttempt(old.rows[0].attemptId))!, duplicate: true }; } const existing = await c.query<{ snapshotId: string }>(`SELECT snapshot_id AS "snapshotId" FROM suite_workbench.image_edit_child_tasks WHERE id=$1 FOR UPDATE`, [input.childTask.id]); if (!existing.rowCount || existing.rows[0].snapshotId !== input.snapshot.id) throw new Error("INVALID_IMAGE_EDIT_TASK"); const next = await c.query<{ n: number }>(`SELECT COALESCE(MAX(attempt_no),0)+1 AS n FROM suite_workbench.image_edit_attempts WHERE child_task_id=$1`, [input.childTask.id]); const attemptNo = Number(next.rows[0].n); await c.query(`INSERT INTO suite_workbench.image_edit_attempts(id,child_task_id,snapshot_id,attempt_no,command_json,provider_json,status,error_code,error_message,created_at,completed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [input.attempt.id,input.attempt.childTaskId,input.attempt.snapshotId,attemptNo,JSON.stringify(input.attempt.command),JSON.stringify(input.attempt.provider),input.attempt.status,input.attempt.errorCode,input.attempt.errorMessage,input.attempt.createdAt,input.attempt.completedAt]); await c.query(`UPDATE suite_workbench.image_edit_child_tasks SET status=$2,error_code=$3,error_message=$4,updated_at=$5 WHERE id=$1`, [input.childTask.id,input.childTask.status,input.childTask.errorCode,input.childTask.errorMessage,input.childTask.updatedAt]); await c.query(`INSERT INTO suite_workbench.image_edit_idempotency(idempotency_key,snapshot_id,child_task_id,attempt_id) VALUES($1,$2,$3,$4)`, [input.idempotencyKey,input.snapshot.id,input.childTask.id,input.attempt.id]); await c.query("COMMIT"); return { snapshot: input.snapshot, childTask: (await this.getChildTask(input.childTask.id))!, attempt: (await this.getAttempt(input.attempt.id))!, duplicate: false }; } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); } }
  async completeAttempt(input: CompleteImageEditAttemptInput) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: [attempt] } = await client.query<ImageEditAttempt>(
        `SELECT ${attemptRow} FROM suite_workbench.image_edit_attempts WHERE id=$1 FOR UPDATE`, [input.attemptId],
      );
      if (!attempt || attempt.status !== "generating") throw new Error("INVALID_IMAGE_EDIT_ATTEMPT");
      await client.query(`SELECT id FROM suite_workbench.image_edit_child_tasks WHERE id=$1 FOR UPDATE`, [attempt.childTaskId]);
      const { rows: [next] } = await client.query<{ n: number }>(
        `SELECT COALESCE(MAX(version_number),0)+1 AS n FROM suite_workbench.image_edit_versions WHERE child_task_id=$1`, [attempt.childTaskId],
      );
      const { rows: [version] } = await client.query<ImageEditVersion>(
        `INSERT INTO suite_workbench.image_edit_versions
          (id,child_task_id,attempt_id,version_number,object_key,sha256,width,height,mime_type,created_at,
           generated_size_json,delivery_size_json,delivery_object_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING ${versionRow}`,
        [randomUUID(), attempt.childTaskId, attempt.id, next.n, input.objectKey, input.sha256, input.width, input.height,
          input.mimeType, input.completedAt, input.generatedSize ?? null, input.deliverySize ?? null, input.deliveryObjectKey ?? null],
      );
      const { rows: [completedAttempt] } = await client.query<ImageEditAttempt>(
        `UPDATE suite_workbench.image_edit_attempts SET status='succeeded',completed_at=$2 WHERE id=$1 RETURNING ${attemptRow}`,
        [attempt.id, input.completedAt],
      );
      const { rows: [childTask] } = await client.query<ImageEditChildTask>(
        `UPDATE suite_workbench.image_edit_child_tasks SET status='succeeded',current_version_id=$2,updated_at=$3
         WHERE id=$1 RETURNING ${taskRow}`,
        [attempt.childTaskId, version.id, input.completedAt],
      );
      await client.query("COMMIT");
      return { attempt: completedAttempt, version, childTask };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async failAttempt(id: string, code: string, message: string, completedAt: string) { const c = await this.pool.connect(); try { await c.query("BEGIN"); const a = await c.query<ImageEditAttempt>(`SELECT ${attemptRow} FROM suite_workbench.image_edit_attempts WHERE id=$1 FOR UPDATE`, [id]); if (!a.rowCount) throw new Error("INVALID_IMAGE_EDIT_ATTEMPT"); const task = await c.query<ImageEditChildTask>(`SELECT ${taskRow} FROM suite_workbench.image_edit_child_tasks WHERE id=$1 FOR UPDATE`, [a.rows[0].childTaskId]); if (!task.rowCount) throw new Error("INVALID_IMAGE_EDIT_TASK"); if (a.rows[0].status === "generating") { await c.query(`UPDATE suite_workbench.image_edit_attempts SET status='failed',error_code=$2,error_message=$3,completed_at=$4 WHERE id=$1 AND status='generating'`, [id,code,message,completedAt]); const running = await c.query(`SELECT 1 FROM suite_workbench.image_edit_attempts WHERE child_task_id=$1 AND status='generating' LIMIT 1`, [a.rows[0].childTaskId]); if (!running.rowCount) await c.query(`UPDATE suite_workbench.image_edit_child_tasks SET status='failed',error_code=$2,error_message=$3,updated_at=$4 WHERE id=$1 AND status='generating'`, [a.rows[0].childTaskId,code,message,completedAt]); } await c.query("COMMIT"); return { attempt: (await this.getAttempt(id))!, childTask: (await this.getChildTask(a.rows[0].childTaskId))! }; } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); } }
  async listAttempts(childTaskId: string) { const r = await this.pool.query<ImageEditAttempt>(`SELECT ${attemptRow} FROM suite_workbench.image_edit_attempts WHERE child_task_id=$1 ORDER BY attempt_no`, [childTaskId]); return r.rows; }
  async listVersions(childTaskId: string) { const r = await this.pool.query<ImageEditVersion>(`SELECT ${versionRow} FROM suite_workbench.image_edit_versions WHERE child_task_id=$1 ORDER BY version_number DESC`, [childTaskId]); return r.rows; }
  async selectVersion(childTaskId: string, versionId: string, selection: "current" | "final") { const version = (await this.listVersions(childTaskId)).find((v) => v.id === versionId); if (!version) return null; if (selection === "final") { const attempt = await this.getAttempt(version.attemptId); if (!attempt || attempt.status !== "succeeded") throw new Error("VERSION_NOT_ELIGIBLE_FOR_FINAL"); } await this.pool.query(`UPDATE suite_workbench.image_edit_child_tasks SET ${selection === "current" ? "current_version_id" : "final_version_id"}=$2,updated_at=now() WHERE id=$1`, [childTaskId,versionId]); return version; }
  async clearFinalVersions(childTaskIds: string[]) {
    if (!childTaskIds.length) return;
    await this.pool.query(
      `UPDATE suite_workbench.image_edit_child_tasks SET final_version_id=NULL, updated_at=now() WHERE id = ANY($1::uuid[]) AND final_version_id IS NOT NULL`,
      [childTaskIds],
    );
  }
}
