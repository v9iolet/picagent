import { assertReferenceAllowed } from "../library-reference-policy.js";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { resolvePromptTemplateUsedBy } from "../prompt-library.js";
import type {
  LibraryAssetStatus,
  LibraryReference,
  LibraryRepository,
  LibraryResource,
  LibraryResourceBatchDeleteResult,
  LibraryResourceDeletionResult,
  LibraryResourceQuery,
} from "../types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toIsoString(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function normalizeTimestamps(resource: LibraryResource): LibraryResource {
  return {
    ...resource,
    createdAt: toIsoString(resource.createdAt as unknown),
    updatedAt: toIsoString(resource.updatedAt as unknown),
  };
}

function mapPromptTemplateRow(row: any): LibraryResource {
  const source = row.source && typeof row.source === "object" ? (row.source as Record<string, unknown>) : {};
  const usedBy = resolvePromptTemplateUsedBy({
    code: typeof source.code === "string" ? source.code : null,
    stage: row.stage,
    applicability: source.applicability && typeof source.applicability === "object" ? (source.applicability as Record<string, unknown>) : null,
  });
  return normalizeTimestamps({
    ...row,
    status: row.status as LibraryAssetStatus,
    usedBy,
    source: { ...source, usedBy },
  });
}

function mapReference(row: any): LibraryReference {
  return { id: row.id, suiteId: row.suiteId, resourceId: row.resourceId, resourceType: row.resourceType, targetType: row.targetType, targetId: row.targetId, resourceVersionId: row.resourceVersionId, snapshot: row.snapshot, createdAt: row.createdAt, createdBy: row.createdBy ?? null, archivedAt: row.archivedAt ?? null };
}

function mapTaskVersionRow(row: any): LibraryResource {
  const isReplica = row.origin_kind === "replica";
  const taskStage = isReplica ? "replica_prompt" as const : "task_image" as const;
  const kindLabel = isReplica ? "爆品图复刻" : (row.image_type === "main" ? "主图" : "详情页");
  const originMeta = isReplica ? { origin: "replica", originKind: "replica" } : {};
  return normalizeTimestamps({
    id: `task-version:${row.version_id}`,
    resourceType: "task_image_version",
    title: `${row.task_title} · 版本 ${row.version_number}`,
    summary: `${kindLabel} · ${row.width} × ${row.height}`,
    mimeType: row.mime_type,
    previewUrl: `/api/suite-tasks/${row.task_id}/versions/${row.version_id}/preview`,
    suiteId: row.suite_id,
    taskId: row.task_id,
    imageVersionId: row.version_id,
    baseVersionId: null,
    templateVersionId: null,
    resourceVersionId: row.version_id,
    stage: taskStage,
    source: { objectKey: row.object_key, versionNumber: row.version_number, promptSummary: row.prompt_draft.slice(0, 180), model: row.model, channel: row.channel, ...originMeta },
    promptSnapshot: row.prompt_snapshot_json,
    status: "published",
    createdAt: row.created_at,
    updatedAt: row.created_at,
  });
}

function mapProcessImageRow(row: any, objectKey: string, index: number): LibraryResource {
  const isReplica = row.origin_kind === "replica";
  const taskStage = isReplica ? "replica_prompt" as const : "task_image" as const;
  const kindLabel = isReplica ? "爆品图复刻" : (row.image_type === "main" ? "主图" : "详情页");
  const originMeta = isReplica ? { origin: "replica", originKind: "replica" } : {};
  return normalizeTimestamps({
    id: `process:${row.version_id}:${index}`,
    resourceType: "process_image",
    title: `${row.task_title} · 过程图 ${index + 1}`,
    summary: `${kindLabel} · 版本 ${row.version_number}`,
    mimeType: "image/png",
    previewUrl: null,
    suiteId: row.suite_id,
    taskId: row.task_id,
    imageVersionId: row.version_id,
    baseVersionId: null,
    templateVersionId: null,
    resourceVersionId: `${row.version_id}:${index}`,
    stage: taskStage,
    source: { objectKey, versionId: row.version_id, processIndex: index, model: row.model, channel: row.channel, ...originMeta },
    promptSnapshot: row.prompt_snapshot_json,
    status: "published",
    createdAt: row.created_at,
    updatedAt: row.created_at,
  });
}

function mapEditVersionRow(row: any): LibraryResource {
  const isReplica = row.origin_kind === "replica";
  const taskStage = isReplica ? ("replica_prompt" as const) : ("task_image" as const);
  const kindLabel = isReplica ? "爆品图复刻" : row.image_type === "main" ? "主图" : "详情页";
  const originMeta = isReplica ? { origin: "replica", originKind: "replica" } : {};
  const command = row.command_json && typeof row.command_json === "object" ? (row.command_json as Record<string, unknown>) : {};
  const provider = row.provider_json && typeof row.provider_json === "object" ? (row.provider_json as Record<string, unknown>) : {};
  const editPrompt = typeof command.prompt === "string" && command.prompt.trim()
    ? command.prompt.trim()
    : typeof row.edit_summary === "string" && row.edit_summary.trim()
      ? row.edit_summary.trim()
      : typeof row.source_prompt === "string"
        ? row.source_prompt
        : "";
  const model = typeof provider.version === "string" && provider.version
    ? provider.version
    : typeof provider.name === "string" && provider.name
      ? provider.name
      : null;
  const channel = provider.channel ?? null;
  const baseTitle = typeof row.task_title === "string" && row.task_title.trim()
    ? row.task_title.trim()
    : typeof row.edit_summary === "string" && row.edit_summary.trim()
      ? row.edit_summary.trim()
      : "图片编辑";
  return normalizeTimestamps({
    id: `edit-version:${row.version_id}`,
    resourceType: "task_image_version",
    title: `${baseTitle} · 编辑版本 ${row.version_number}`,
    summary: `编辑生成 · ${kindLabel} · ${row.width} × ${row.height}`,
    mimeType: row.mime_type,
    previewUrl: `/api/image-editor/tasks/${row.child_task_id}/versions/${row.version_id}/preview`,
    suiteId: row.suite_id ?? null,
    taskId: row.root_task_id ?? row.child_task_id,
    imageVersionId: row.version_id,
    baseVersionId: null,
    templateVersionId: null,
    resourceVersionId: row.version_id,
    stage: taskStage,
    source: {
      objectKey: row.object_key,
      generatedBy: "image_editor",
      editChildTaskId: row.child_task_id,
      editSnapshotId: row.snapshot_id,
      sourceCardId: row.source_card_id,
      sourceVersionId: row.source_version_id,
      parentVersionId: row.parent_version_id,
      rootTaskId: row.root_task_id ?? null,
      editSummary: row.edit_summary ?? "",
      versionNumber: row.version_number,
      promptSummary: editPrompt.slice(0, 180),
      model,
      channel,
      ...originMeta,
    },
    promptSnapshot: {
      finalPrompt: editPrompt,
      prompt: editPrompt,
      sourcePrompt: typeof row.source_prompt === "string" ? row.source_prompt : "",
      editSummary: row.edit_summary ?? "",
      editSnapshotId: row.snapshot_id,
      sourceVersionId: row.source_version_id,
      operations: Array.isArray(row.operations_json) ? row.operations_json : [],
      ...(model ? { model } : {}),
    },
    status: "published",
    createdAt: row.created_at,
    updatedAt: row.created_at,
  });
}

function mapReverseRow(row: any): LibraryResource {
  const stage = (row.source?.origin === "replica" ? "replica_prompt" : "task_image") as "replica_prompt" | "task_image";
  return normalizeTimestamps({
    id: `reverse:${row.id}`,
    resourceType: "reverse_reference_asset",
    title: row.title,
    summary: row.summary,
    mimeType: row.mimeType,
    previewUrl: `/api/library/resources/reverse:${row.id}/preview`,
    suiteId: row.suiteId,
    taskId: null,
    imageVersionId: null,
    baseVersionId: null,
    templateVersionId: typeof row.source?.templateVersionId === "string" ? row.source.templateVersionId : null,
    resourceVersionId: row.id,
    stage,
    source: { objectKey: row.objectKey, visualStructure: row.visualStructure, ...row.source },
    status: row.status,
    promptSnapshot: row.promptSnapshot,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

type ParsedResourceId =
  | { kind: "prompt"; uuid: string }
  | { kind: "input"; uuid: string }
  | { kind: "base"; uuid: string }
  | { kind: "task-version"; uuid: string }
  | { kind: "edit-version"; uuid: string }
  | { kind: "process"; uuid: string; index: number }
  | { kind: "reverse"; uuid: string };

function parseResourceId(resourceId: string): ParsedResourceId | null {
  if (resourceId.startsWith("prompt:")) {
    const uuid = resourceId.slice("prompt:".length);
    return UUID_RE.test(uuid) ? { kind: "prompt", uuid } : null;
  }
  if (resourceId.startsWith("input:")) {
    const uuid = resourceId.slice("input:".length);
    return UUID_RE.test(uuid) ? { kind: "input", uuid } : null;
  }
  if (resourceId.startsWith("base:")) {
    const uuid = resourceId.slice("base:".length);
    return UUID_RE.test(uuid) ? { kind: "base", uuid } : null;
  }
  if (resourceId.startsWith("task-version:")) {
    const uuid = resourceId.slice("task-version:".length);
    return UUID_RE.test(uuid) ? { kind: "task-version", uuid } : null;
  }
  if (resourceId.startsWith("edit-version:")) {
    const uuid = resourceId.slice("edit-version:".length);
    return UUID_RE.test(uuid) ? { kind: "edit-version", uuid } : null;
  }
  if (resourceId.startsWith("process:")) {
    const rest = resourceId.slice("process:".length);
    const sep = rest.indexOf(":");
    if (sep <= 0) return null;
    const uuid = rest.slice(0, sep);
    const rawIdx = rest.slice(sep + 1);
    if (!UUID_RE.test(uuid) || !/^\d+$/.test(rawIdx)) return null;
    const index = Number(rawIdx);
    return Number.isSafeInteger(index) ? { kind: "process", uuid, index } : null;
  }
  if (resourceId.startsWith("reverse:")) {
    const uuid = resourceId.slice("reverse:".length);
    return UUID_RE.test(uuid) ? { kind: "reverse", uuid } : null;
  }
  return null;
}

export class PostgresLibraryRepository implements LibraryRepository {
  constructor(private readonly pool: Pool) {}

  private async findResourceWithMeta(resourceId: string): Promise<{ resource: LibraryResource; archivedByTask: boolean } | null> {
    const parsed = parseResourceId(resourceId);
    if (!parsed) return null;
    if (parsed.kind === "prompt") {
      const result = await this.pool.query<any>(
        `SELECT 'prompt:' || v.id::text AS id, 'prompt_template' AS "resourceType", v.name AS title,
          left(regexp_replace(v.body, '\\s+', ' ', 'g'), 180) AS summary, NULL::text AS "mimeType", NULL::text AS "previewUrl",
          NULL::uuid AS "suiteId", NULL::uuid AS "taskId", NULL::uuid AS "imageVersionId", NULL::uuid AS "baseVersionId",
          v.id::text AS "templateVersionId", v.id::text AS "resourceVersionId", v.stage,
          jsonb_build_object('templateId', t.id::text, 'code', t.code, 'versionNo', v.version_no, 'status', v.status, 'body', v.body, 'userPromptTemplate', v.user_prompt_template, 'inputSchema', v.input_schema, 'outputSchema', v.output_schema, 'applicability', v.applicability) AS source,
          v.status AS status, v.created_at AS "createdAt", COALESCE(v.published_at, v.created_at) AS "updatedAt"
         FROM prompt_library.prompt_template_versions v
         JOIN prompt_library.prompt_templates t ON t.id = v.template_id
         WHERE v.id = $1::uuid`,
        [parsed.uuid],
      );
      return result.rows[0] ? { resource: mapPromptTemplateRow(result.rows[0]), archivedByTask: false } : null;
    }
    if (parsed.kind === "input") {
      const result = await this.pool.query<any>(
        `SELECT 'input:' || i.id::text AS id, 'input_image' AS "resourceType", i.original_filename AS title,
          concat(i.width, ' × ', i.height, ' · ', i.mime_type) AS summary, i.mime_type AS "mimeType",
          '/api/suites/' || i.suite_id::text || '/input-images/' || i.id::text || '/preview/thumbnail' AS "previewUrl",
          i.suite_id AS "suiteId", NULL::uuid AS "taskId", NULL::uuid AS "imageVersionId", NULL::uuid AS "baseVersionId",
          i.id::text AS "resourceVersionId", NULL::text AS "templateVersionId", NULL::text AS stage,
          jsonb_build_object('objectKey', i.original_object_key, 'originalFilename', i.original_filename, 'ordinal', i.ordinal) AS source,
          i.created_at AS "createdAt", i.created_at AS "updatedAt"
         FROM suite_workbench.input_images i WHERE i.id = $1::uuid`,
        [parsed.uuid],
      );
      return result.rows[0] ? { resource: normalizeTimestamps({ ...result.rows[0], status: "published" as const }), archivedByTask: false } : null;
    }
    if (parsed.kind === "base") {
      const result = await this.pool.query<any>(
        `SELECT 'base:' || b.id::text AS id, 'base_image' AS "resourceType", concat('白底底图 · 版本 ', b.version_number) AS title,
          concat(i.original_filename, ' · ', b.width, ' × ', b.height) AS summary, b.mime_type AS "mimeType",
          '/api/suites/' || b.suite_id::text || '/input-images/' || b.input_image_id::text || '/base-versions/' || b.id::text || '/preview' AS "previewUrl",
          b.suite_id AS "suiteId", NULL::uuid AS "taskId", NULL::uuid AS "imageVersionId", b.id AS "baseVersionId",
          b.id::text AS "resourceVersionId", NULL::text AS "templateVersionId", NULL::text AS stage,
          jsonb_build_object('objectKey', b.object_key, 'inputImageId', b.input_image_id, 'versionNumber', b.version_number, 'promptTemplateVersionId', ga.prompt_template_version_id, 'model', ga.model, 'channel', ga.channel_snapshot_json) AS source,
          jsonb_build_object('prompt', ga.prompt, 'templateVersionId', ga.prompt_template_version_id, 'dynamicInput', ga.dynamic_input_json) AS "promptSnapshot",
          b.created_at AS "createdAt", b.created_at AS "updatedAt"
         FROM suite_workbench.base_image_versions b
         JOIN suite_workbench.input_images i ON i.id = b.input_image_id
         JOIN suite_workbench.generation_attempts ga ON ga.id = b.attempt_id
         WHERE b.id = $1::uuid`,
        [parsed.uuid],
      );
      return result.rows[0] ? { resource: normalizeTimestamps({ ...result.rows[0], status: "published" as const }), archivedByTask: false } : null;
    }
    if (parsed.kind === "task-version" || parsed.kind === "process") {
      const result = await this.pool.query<any>(
        `SELECT v.id AS version_id, v.task_id, v.object_key, v.process_object_keys_json, v.prompt_snapshot_json, a.model, v.context_snapshot_json->'channel' AS channel, v.mime_type, v.width, v.height, v.version_number, v.created_at,
          t.suite_id, t.title AS task_title, t.image_type, t.prompt_draft, t.origin_kind, t.status AS task_status
         FROM suite_workbench.task_image_versions v
         JOIN suite_workbench.suite_tasks t ON t.id = v.task_id
         JOIN suite_workbench.task_generation_attempts a ON a.id = v.attempt_id
         WHERE v.id = $1::uuid`,
        [parsed.uuid],
      );
      const row = result.rows[0];
      if (!row) return null;
      const archivedByTask = row.task_status === "archived";
      if (parsed.kind === "task-version") return { resource: mapTaskVersionRow(row), archivedByTask };
      if (!Array.isArray(row.process_object_keys_json) || parsed.index >= row.process_object_keys_json.length) return null;
      const objectKey = row.process_object_keys_json[parsed.index];
      if (typeof objectKey !== "string") return null;
      return { resource: mapProcessImageRow(row, objectKey, parsed.index), archivedByTask };
    }
    if (parsed.kind === "edit-version") {
      const result = await this.pool.query<any>(
        `WITH RECURSIVE edit_lineage AS (
          SELECT
            c.id AS current_child_task_id,
            CASE
              WHEN c.source_card_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              THEN c.source_card_id::uuid
              ELSE NULL
            END AS source_card_uuid,
            (c.status = 'archived') AS any_child_archived,
            ARRAY[c.id] AS visited
          FROM suite_workbench.image_edit_versions ev0
          JOIN suite_workbench.image_edit_child_tasks c ON c.id = ev0.child_task_id
          WHERE ev0.id = $1::uuid
          UNION ALL
          SELECT
            parent.id AS current_child_task_id,
            CASE
              WHEN parent.source_card_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              THEN parent.source_card_id::uuid
              ELSE NULL
            END AS source_card_uuid,
            (l.any_child_archived OR parent.status = 'archived') AS any_child_archived,
            l.visited || parent.id
          FROM edit_lineage l
          JOIN suite_workbench.image_edit_child_tasks parent
            ON parent.id = l.source_card_uuid
          WHERE l.source_card_uuid IS NOT NULL
            AND NOT (parent.id = ANY(l.visited))
        ),
        deepest AS (
          SELECT
            l.source_card_uuid,
            l.any_child_archived
          FROM edit_lineage l
          ORDER BY array_length(l.visited, 1) DESC
          LIMIT 1
        )
        SELECT
          ev.id AS version_id,
          ev.child_task_id,
          ev.attempt_id,
          ev.version_number,
          ev.object_key,
          ev.width,
          ev.height,
          ev.mime_type,
          ev.created_at,
          c.source_card_id,
          c.source_version_id,
          c.parent_version_id,
          c.snapshot_id,
          c.summary AS edit_summary,
          c.status AS child_status,
          s.source_prompt,
          s.operations_json,
          a.command_json,
          a.provider_json,
          t.id AS root_task_id,
          t.suite_id,
          t.title AS task_title,
          t.image_type,
          t.origin_kind,
          t.status AS root_task_status,
          d.any_child_archived
        FROM suite_workbench.image_edit_versions ev
        JOIN suite_workbench.image_edit_child_tasks c ON c.id = ev.child_task_id
        JOIN suite_workbench.image_edit_attempts a ON a.id = ev.attempt_id
        JOIN suite_workbench.image_edit_snapshots s ON s.id = c.snapshot_id
        LEFT JOIN deepest d ON true
        LEFT JOIN suite_workbench.suite_tasks t ON t.id = d.source_card_uuid
        WHERE ev.id = $1::uuid`,
        [parsed.uuid],
      );
      const row = result.rows[0];
      if (!row) return null;
      const archivedByTask = row.root_task_status === "archived" || Boolean(row.any_child_archived) || row.child_status === "archived";
      return { resource: mapEditVersionRow(row), archivedByTask };
    }
    const result = await this.pool.query<any>(
      `SELECT id, suite_id AS "suiteId", title, summary, mime_type AS "mimeType", object_key AS "objectKey",
        prompt_snapshot_json AS "promptSnapshot", visual_structure_json AS "visualStructure", source_json AS source, status, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM suite_workbench.reverse_reference_assets WHERE id = $1::uuid`,
      [parsed.uuid],
    );
    return result.rows[0] ? { resource: mapReverseRow(result.rows[0]), archivedByTask: false } : null;
  }

  private async findResourceRaw(resourceId: string): Promise<LibraryResource | null> {
    const found = await this.findResourceWithMeta(resourceId);
    return found ? found.resource : null;
  }

  private async findExistingIds(resourceIds: string[]): Promise<{ validIds: string[]; notFoundIds: string[]; hasPromptTemplate: boolean }> {
    const parsedEntries = resourceIds.map((id) => ({ id, parsed: parseResourceId(id) }));
    const promptUuids: string[] = [];
    const inputUuids: string[] = [];
    const baseUuids: string[] = [];
    const taskVersionUuids: string[] = [];
    const editVersionUuids: string[] = [];
    const processEntries: Array<{ id: string; uuid: string; index: number }> = [];
    const reverseUuids: string[] = [];

    for (const entry of parsedEntries) {
      if (!entry.parsed) continue;
      switch (entry.parsed.kind) {
        case "prompt": promptUuids.push(entry.parsed.uuid); break;
        case "input": inputUuids.push(entry.parsed.uuid); break;
        case "base": baseUuids.push(entry.parsed.uuid); break;
        case "task-version": taskVersionUuids.push(entry.parsed.uuid); break;
        case "edit-version": editVersionUuids.push(entry.parsed.uuid); break;
        case "process": processEntries.push({ id: entry.id, uuid: entry.parsed.uuid, index: entry.parsed.index }); break;
        case "reverse": reverseUuids.push(entry.parsed.uuid); break;
      }
    }

    const existing = new Set<string>();
    let hasPromptTemplate = false;

    if (promptUuids.length) {
      const res = await this.pool.query<{ id: string }>(
        `SELECT v.id::text AS id
         FROM prompt_library.prompt_template_versions v
         WHERE v.id = ANY($1::uuid[])`,
        [promptUuids],
      );
      if (res.rows.length > 0) hasPromptTemplate = true;
      for (const row of res.rows) existing.add(`prompt:${row.id}`);
    }
    if (inputUuids.length) {
      const res = await this.pool.query<{ id: string }>(
        `SELECT id::text AS id FROM suite_workbench.input_images WHERE id = ANY($1::uuid[])`,
        [inputUuids],
      );
      for (const row of res.rows) existing.add(`input:${row.id}`);
    }
    if (baseUuids.length) {
      const res = await this.pool.query<{ id: string }>(
        `SELECT b.id::text AS id
         FROM suite_workbench.base_image_versions b
         JOIN suite_workbench.input_images i ON i.id = b.input_image_id
         JOIN suite_workbench.generation_attempts ga ON ga.id = b.attempt_id
         WHERE b.id = ANY($1::uuid[])`,
        [baseUuids],
      );
      for (const row of res.rows) existing.add(`base:${row.id}`);
    }
    const allTaskVersionUuids = [...new Set([...taskVersionUuids, ...processEntries.map((item) => item.uuid)])];
    if (allTaskVersionUuids.length) {
      const res = await this.pool.query<{ id: string; process_object_keys_json: unknown }>(
        `SELECT v.id::text AS id, v.process_object_keys_json
         FROM suite_workbench.task_image_versions v
         JOIN suite_workbench.suite_tasks t ON t.id = v.task_id
         JOIN suite_workbench.task_generation_attempts a ON a.id = v.attempt_id
         WHERE v.id = ANY($1::uuid[])`,
        [allTaskVersionUuids],
      );
      const byId = new Map(res.rows.map((row) => [row.id, row.process_object_keys_json]));
      for (const uuid of taskVersionUuids) {
        if (byId.has(uuid)) existing.add(`task-version:${uuid}`);
      }
      for (const proc of processEntries) {
        const list = byId.get(proc.uuid);
        if (Array.isArray(list) && proc.index < list.length && typeof list[proc.index] === "string") {
          existing.add(proc.id);
        }
      }
    }
    if (editVersionUuids.length) {
      const res = await this.pool.query<{ id: string }>(
        `SELECT ev.id::text AS id
         FROM suite_workbench.image_edit_versions ev
         JOIN suite_workbench.image_edit_child_tasks c ON c.id = ev.child_task_id
         JOIN suite_workbench.image_edit_attempts a ON a.id = ev.attempt_id
         JOIN suite_workbench.image_edit_snapshots s ON s.id = c.snapshot_id
         WHERE ev.id = ANY($1::uuid[])`,
        [editVersionUuids],
      );
      for (const row of res.rows) existing.add(`edit-version:${row.id}`);
    }
    if (reverseUuids.length) {
      const res = await this.pool.query<{ id: string }>(
        `SELECT id::text AS id FROM suite_workbench.reverse_reference_assets WHERE id = ANY($1::uuid[])`,
        [reverseUuids],
      );
      for (const row of res.rows) existing.add(`reverse:${row.id}`);
    }

    const validIds: string[] = [];
    const notFoundIds: string[] = [];
    for (const id of resourceIds) {
      if (existing.has(id)) validIds.push(id);
      else notFoundIds.push(id);
    }
    return { validIds, notFoundIds, hasPromptTemplate };
  }

  async listResources(query: LibraryResourceQuery) {
    const page = Math.max(1, query.page ?? 1); const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 24));
    if (query.scope === "image" && query.resourceType === "prompt_template") {
      return { items: [], total: 0, page, pageSize };
    }
    const resources: LibraryResource[] = [];
    const suiteId = query.suiteId ?? null;
    const needle = query.query?.trim() ? `%${query.query.trim()}%` : null;
    if (query.scope !== "image" && (!query.resourceType || query.resourceType === "prompt_template")) {
      const isDraftFilter = query.status === "draft";
      const result = await this.pool.query<any>(isDraftFilter
        ? `
        SELECT * FROM (
          SELECT DISTINCT ON (t.id)
            'prompt:' || v.id::text AS id, 'prompt_template' AS "resourceType", v.name AS title,
            left(regexp_replace(v.body, '\\s+', ' ', 'g'), 180) AS summary, NULL::text AS "mimeType", NULL::text AS "previewUrl",
            NULL::uuid AS "suiteId", NULL::uuid AS "taskId", NULL::uuid AS "imageVersionId", NULL::uuid AS "baseVersionId",
            v.id::text AS "templateVersionId", v.id::text AS "resourceVersionId", v.stage,
            jsonb_build_object('templateId', t.id::text, 'code', t.code, 'versionNo', v.version_no, 'status', v.status, 'body', v.body, 'userPromptTemplate', v.user_prompt_template, 'inputSchema', v.input_schema, 'outputSchema', v.output_schema, 'applicability', v.applicability) AS source,
            v.status AS status, v.created_at AS "createdAt", COALESCE(v.published_at, v.created_at) AS "updatedAt"
          FROM prompt_library.prompt_templates t
          JOIN prompt_library.prompt_template_versions v ON v.template_id = t.id
          WHERE v.status = 'draft'
            AND ($1::text IS NULL OR v.stage = $1)
            AND ($2::text IS NULL OR v.name ILIKE $2 OR v.body ILIKE $2 OR t.code ILIKE $2)
            AND NOT EXISTS (SELECT 1 FROM suite_workbench.library_resource_deletions d WHERE d.resource_id = 'prompt:' || v.id::text)
          ORDER BY t.id, v.version_no DESC
        ) latest
        ORDER BY latest."updatedAt" DESC`
        : `
        SELECT * FROM (
          SELECT DISTINCT ON (t.id)
            'prompt:' || v.id::text AS id, 'prompt_template' AS "resourceType", v.name AS title,
            left(regexp_replace(v.body, '\\s+', ' ', 'g'), 180) AS summary, NULL::text AS "mimeType", NULL::text AS "previewUrl",
            NULL::uuid AS "suiteId", NULL::uuid AS "taskId", NULL::uuid AS "imageVersionId", NULL::uuid AS "baseVersionId",
            v.id::text AS "templateVersionId", v.id::text AS "resourceVersionId", v.stage,
            jsonb_build_object('templateId', t.id::text, 'code', t.code, 'versionNo', v.version_no, 'status', v.status, 'body', v.body, 'userPromptTemplate', v.user_prompt_template, 'inputSchema', v.input_schema, 'outputSchema', v.output_schema, 'applicability', v.applicability) AS source,
            v.status AS status, v.created_at AS "createdAt", COALESCE(v.published_at, v.created_at) AS "updatedAt"
          FROM prompt_library.prompt_templates t
          JOIN prompt_library.prompt_template_versions v ON v.template_id = t.id
          WHERE ($1::text IS NULL OR v.stage = $1)
            AND ($2::text IS NULL OR v.name ILIKE $2 OR v.body ILIKE $2 OR t.code ILIKE $2)
            AND NOT EXISTS (SELECT 1 FROM suite_workbench.library_resource_deletions d WHERE d.resource_id = 'prompt:' || v.id::text)
          ORDER BY t.id,
            CASE WHEN v.id = t.published_version_id AND t.lifecycle_status = 'active' AND v.status = 'published' THEN 0
                 WHEN v.status = 'published' AND t.lifecycle_status = 'active' THEN 1
                 WHEN v.status = 'draft' THEN 2
                 ELSE 3 END,
            v.version_no DESC
        ) latest
        ORDER BY latest."updatedAt" DESC`, [query.stage ?? null, needle]);
      resources.push(...result.rows.map(mapPromptTemplateRow));
    }
    if (!query.resourceType || query.resourceType === "input_image") {
      const result = await this.pool.query<any>(`SELECT 'input:' || i.id::text AS id, 'input_image' AS "resourceType", i.original_filename AS title,
        concat(i.width, ' × ', i.height, ' · ', i.mime_type) AS summary, i.mime_type AS "mimeType",
        '/api/suites/' || i.suite_id::text || '/input-images/' || i.id::text || '/preview/thumbnail' AS "previewUrl",
        i.suite_id AS "suiteId", NULL::uuid AS "taskId", NULL::uuid AS "imageVersionId", NULL::uuid AS "baseVersionId", i.id::text AS "resourceVersionId", NULL::text AS "templateVersionId", NULL::text AS stage,
        jsonb_build_object('objectKey', i.original_object_key, 'originalFilename', i.original_filename, 'ordinal', i.ordinal) AS source, i.created_at AS "createdAt", i.created_at AS "updatedAt"
        FROM suite_workbench.input_images i
        WHERE ($1::uuid IS NULL OR i.suite_id = $1) AND ($2::text IS NULL OR i.original_filename ILIKE $2)
          AND NOT EXISTS (SELECT 1 FROM suite_workbench.library_resource_deletions d WHERE d.resource_id = 'input:' || i.id::text)
        ORDER BY i.created_at DESC`, [suiteId, needle]);
      resources.push(...result.rows.map((row) => ({ ...row, status: "published" as const })));
    }
    if (!query.resourceType || query.resourceType === "base_image") {
      const result = await this.pool.query<any>(`SELECT 'base:' || b.id::text AS id, 'base_image' AS "resourceType", concat('白底底图 · 版本 ', b.version_number) AS title,
        concat(i.original_filename, ' · ', b.width, ' × ', b.height) AS summary, b.mime_type AS "mimeType",
        '/api/suites/' || b.suite_id::text || '/input-images/' || b.input_image_id::text || '/base-versions/' || b.id::text || '/preview' AS "previewUrl",
        b.suite_id AS "suiteId", NULL::uuid AS "taskId", NULL::uuid AS "imageVersionId", b.id AS "baseVersionId", b.id::text AS "resourceVersionId", NULL::text AS "templateVersionId", NULL::text AS stage,
        jsonb_build_object('objectKey', b.object_key, 'inputImageId', b.input_image_id, 'versionNumber', b.version_number, 'promptTemplateVersionId', ga.prompt_template_version_id, 'model', ga.model, 'channel', ga.channel_snapshot_json) AS source,
        jsonb_build_object('prompt', ga.prompt, 'templateVersionId', ga.prompt_template_version_id, 'dynamicInput', ga.dynamic_input_json) AS "promptSnapshot",
        b.created_at AS "createdAt", b.created_at AS "updatedAt"
        FROM suite_workbench.base_image_versions b JOIN suite_workbench.input_images i ON i.id = b.input_image_id JOIN suite_workbench.generation_attempts ga ON ga.id = b.attempt_id
        WHERE ($1::uuid IS NULL OR b.suite_id = $1) AND ($2::text IS NULL OR i.original_filename ILIKE $2)
          AND NOT EXISTS (SELECT 1 FROM suite_workbench.library_resource_deletions d WHERE d.resource_id = 'base:' || b.id::text)
        ORDER BY b.created_at DESC`, [suiteId, needle]);
      resources.push(...result.rows.map((row) => ({ ...row, status: "published" as const })));
    }
    if (!query.resourceType || query.resourceType === "task_image_version" || query.resourceType === "process_image") {
      const taskVersionFilter = query.resourceType === "task_image_version"
        ? " AND NOT EXISTS (SELECT 1 FROM suite_workbench.library_resource_deletions d WHERE d.resource_id = 'task-version:' || v.id::text)"
        : "";
      const result = await this.pool.query<any>(`SELECT v.id AS version_id, v.task_id, v.object_key, v.process_object_keys_json, v.prompt_snapshot_json, a.model, v.context_snapshot_json->'channel' AS channel, v.mime_type, v.width, v.height, v.version_number, v.created_at,
        t.suite_id, t.title AS task_title, t.image_type, t.prompt_draft, t.origin_kind
        FROM suite_workbench.task_image_versions v JOIN suite_workbench.suite_tasks t ON t.id = v.task_id
        JOIN suite_workbench.task_generation_attempts a ON a.id = v.attempt_id
        WHERE ($1::uuid IS NULL OR t.suite_id = $1) AND ($2::text IS NULL OR t.title ILIKE $2 OR t.prompt_draft ILIKE $2)
          AND t.status <> 'archived'${taskVersionFilter}
        ORDER BY v.created_at DESC`, [suiteId, needle]);
      for (const row of result.rows) {
        if (!query.resourceType || query.resourceType === "task_image_version") resources.push(mapTaskVersionRow(row));
        if ((!query.resourceType || query.resourceType === "process_image") && Array.isArray(row.process_object_keys_json)) {
          row.process_object_keys_json.forEach((objectKey: string, index: number) => resources.push(mapProcessImageRow(row, objectKey, index)));
        }
      }
    }
    if (!query.resourceType || query.resourceType === "task_image_version") {
      const result = await this.pool.query<any>(
        `WITH RECURSIVE edit_tree AS (
          SELECT
            c.id AS child_task_id,
            c.source_card_id,
            c.source_version_id,
            c.parent_version_id,
            c.snapshot_id,
            c.summary AS edit_summary,
            c.status AS child_status,
            t.id AS root_task_id,
            t.suite_id,
            t.title AS task_title,
            t.image_type,
            t.origin_kind,
            ARRAY[c.id] AS visited
          FROM suite_workbench.suite_tasks t
          JOIN suite_workbench.image_edit_child_tasks c
            ON c.source_card_id = t.id::text
          WHERE ($1::uuid IS NULL OR t.suite_id = $1)
            AND t.status <> 'archived'
            AND c.status <> 'archived'
          UNION ALL
          SELECT
            child.id AS child_task_id,
            child.source_card_id,
            child.source_version_id,
            child.parent_version_id,
            child.snapshot_id,
            child.summary AS edit_summary,
            child.status AS child_status,
            tree.root_task_id,
            tree.suite_id,
            tree.task_title,
            tree.image_type,
            tree.origin_kind,
            tree.visited || child.id
          FROM edit_tree tree
          JOIN suite_workbench.image_edit_child_tasks child
            ON child.source_card_id = tree.child_task_id::text
          WHERE child.status <> 'archived'
            AND NOT (child.id = ANY(tree.visited))
        )
        SELECT
          ev.id AS version_id,
          ev.child_task_id,
          ev.attempt_id,
          ev.version_number,
          ev.object_key,
          ev.width,
          ev.height,
          ev.mime_type,
          ev.created_at,
          tree.source_card_id,
          tree.source_version_id,
          tree.parent_version_id,
          tree.snapshot_id,
          tree.edit_summary,
          tree.child_status,
          s.source_prompt,
          s.operations_json,
          a.command_json,
          a.provider_json,
          tree.root_task_id,
          tree.suite_id,
          tree.task_title,
          tree.image_type,
          tree.origin_kind
        FROM edit_tree tree
        JOIN suite_workbench.image_edit_versions ev ON ev.child_task_id = tree.child_task_id
        JOIN suite_workbench.image_edit_attempts a ON a.id = ev.attempt_id
        JOIN suite_workbench.image_edit_snapshots s ON s.id = tree.snapshot_id
        WHERE ($2::text IS NULL
            OR COALESCE(tree.task_title, '') ILIKE $2
            OR tree.edit_summary ILIKE $2
            OR COALESCE(a.command_json->>'prompt', '') ILIKE $2
            OR concat(COALESCE(NULLIF(btrim(tree.task_title), ''), NULLIF(btrim(tree.edit_summary), ''), '图片编辑'), ' · 编辑版本 ', ev.version_number) ILIKE $2
            OR concat('编辑生成 · ', CASE WHEN tree.origin_kind = 'replica' THEN '爆品图复刻' WHEN tree.image_type = 'main' THEN '主图' ELSE '详情页' END, ' · ', ev.width, ' × ', ev.height) ILIKE $2)
          AND NOT EXISTS (SELECT 1 FROM suite_workbench.library_resource_deletions d WHERE d.resource_id = 'edit-version:' || ev.id::text)
        ORDER BY ev.created_at DESC`,
        [suiteId, needle],
      );
      resources.push(...result.rows.map(mapEditVersionRow));
    }
    if (!query.resourceType || query.resourceType === "reverse_reference_asset") {
      const result = await this.pool.query<any>(`SELECT id, suite_id AS "suiteId", title, summary, mime_type AS "mimeType", object_key AS "objectKey",
        prompt_snapshot_json AS "promptSnapshot", visual_structure_json AS "visualStructure", source_json AS source, status, created_at AS "createdAt", updated_at AS "updatedAt"
        FROM suite_workbench.reverse_reference_assets r
        WHERE ($1::uuid IS NULL OR r.suite_id = $1 OR r.suite_id IS NULL) AND ($2::text IS NULL OR r.title ILIKE $2 OR r.summary ILIKE $2)
          AND NOT EXISTS (SELECT 1 FROM suite_workbench.library_resource_deletions d WHERE d.resource_id = 'reverse:' || r.id::text)
        ORDER BY r.updated_at DESC`, [suiteId, needle]);
      resources.push(...result.rows.map(mapReverseRow));
    }
    if (resources.length > 0 && (!query.resourceType || query.resourceType === "process_image")) {
      const idsToCheck = resources
        .filter((resource) => resource.id.startsWith("task-version:") || resource.id.startsWith("process:"))
        .map((resource) => resource.id);
      if (idsToCheck.length > 0) {
        const deleted = await this.pool.query<{ resource_id: string }>(
          `SELECT resource_id FROM suite_workbench.library_resource_deletions WHERE resource_id = ANY($1::text[])`,
          [idsToCheck],
        );
        if (deleted.rows.length > 0) {
          const deletedSet = new Set(deleted.rows.map((row) => row.resource_id));
          resources.splice(0, resources.length, ...resources.filter((resource) => !deletedSet.has(resource.id)));
        }
      }
    }
    if (query.stage && query.resourceType !== "prompt_template") resources.splice(0, resources.length, ...resources.filter((resource) => resource.stage === query.stage));
    if (query.status) resources.splice(0, resources.length, ...resources.filter((resource) => resource.status === query.status));
    for (const resource of resources) {
      resource.createdAt = toIsoString(resource.createdAt as unknown);
      resource.updatedAt = toIsoString(resource.updatedAt as unknown);
    }
    resources.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { items: resources.slice((page - 1) * pageSize, page * pageSize), total: resources.length, page, pageSize };
  }

  async getResource(resourceId: string, options?: { includeDeleted?: boolean }) {
    const found = await this.findResourceWithMeta(resourceId);
    if (!found) return null;
    if (!options?.includeDeleted) {
      if (found.archivedByTask) return null;
      const deleted = await this.pool.query<{ resource_id: string }>(
        `SELECT resource_id FROM suite_workbench.library_resource_deletions WHERE resource_id = $1`,
        [resourceId],
      );
      if (deleted.rows.length > 0) return null;
    }
    return found.resource;
  }

  async getPreviewObject(resourceId: string) {
    const resource = await this.getResource(resourceId, { includeDeleted: true });
    const objectKey = typeof resource?.source.objectKey === "string" ? resource.source.objectKey : null;
    return objectKey ? { objectKey } : null;
  }

  async deleteResource(resourceId: string): Promise<LibraryResourceDeletionResult | null> {
    const resource = await this.findResourceRaw(resourceId);
    if (!resource) return null;
    if (resource.resourceType === "prompt_template") throw new Error("LIBRARY_RESOURCE_FORBIDDEN");
    const result = await this.pool.query<{ resource_id: string; deleted_at: unknown; already_deleted: boolean }>(
      `WITH ins AS (
        INSERT INTO suite_workbench.library_resource_deletions (resource_id, deleted_at)
        VALUES ($1, now())
        ON CONFLICT (resource_id) DO NOTHING
        RETURNING resource_id, deleted_at, false AS already_deleted
      )
      SELECT resource_id, deleted_at, already_deleted FROM ins
      UNION ALL
      SELECT resource_id, deleted_at, true AS already_deleted
      FROM suite_workbench.library_resource_deletions
      WHERE resource_id = $1 AND NOT EXISTS (SELECT 1 FROM ins)`,
      [resourceId],
    );
    const row = result.rows[0];
    return {
      id: resourceId,
      deletedAt: toIsoString(row?.deleted_at ?? new Date()),
      alreadyDeleted: Boolean(row?.already_deleted),
    };
  }

  async deleteResources(resourceIds: string[]): Promise<LibraryResourceBatchDeleteResult> {
    const uniqueIds = [...new Set(resourceIds)];
    const { validIds, notFoundIds, hasPromptTemplate } = await this.findExistingIds(uniqueIds);
    if (hasPromptTemplate) throw new Error("LIBRARY_RESOURCE_FORBIDDEN");
    if (validIds.length === 0) {
      return { deletedIds: [], alreadyDeletedIds: [], notFoundIds, deletedCount: 0 };
    }
    const inserted = await this.pool.query<{ resource_id: string }>(
      `INSERT INTO suite_workbench.library_resource_deletions (resource_id, deleted_at)
       SELECT id, now() FROM unnest($1::text[]) AS id
       ON CONFLICT (resource_id) DO NOTHING
       RETURNING resource_id`,
      [validIds],
    );
    const insertedSet = new Set(inserted.rows.map((row) => row.resource_id));
    const deletedIds = validIds.filter((id) => insertedSet.has(id));
    const alreadyDeletedIds = validIds.filter((id) => !insertedSet.has(id));
    return { deletedIds, alreadyDeletedIds, notFoundIds, deletedCount: deletedIds.length };
  }

  async restoreResource(resourceId: string): Promise<void> {
    await this.pool.query(`DELETE FROM suite_workbench.library_resource_deletions WHERE resource_id = $1`, [resourceId]);
  }

  async createReference(input: { suiteId: string; resourceId: string; targetType: "plan" | "task"; targetId: string; idempotencyKey: string; createdBy?: string | null }) {
    const resource = await this.getResource(input.resourceId); if (!resource) throw new Error("LIBRARY_RESOURCE_NOT_FOUND");
    assertReferenceAllowed(resource, input.suiteId, input.targetType);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<any>(`SELECT id, suite_id AS "suiteId", resource_id AS "resourceId", resource_type AS "resourceType", target_type AS "targetType", target_id AS "targetId", resource_version_id AS "resourceVersionId", snapshot_json AS snapshot, created_at AS "createdAt", created_by AS "createdBy", archived_at AS "archivedAt" FROM suite_workbench.library_references WHERE suite_id=$1 AND idempotency_key=$2`, [input.suiteId, input.idempotencyKey]);
      if (existing.rows[0]) { await client.query("COMMIT"); return { reference: mapReference(existing.rows[0]), duplicate: true }; }
      const targetExists = input.targetType === "task"
        ? await client.query("SELECT 1 FROM suite_workbench.suite_tasks WHERE id=$1 AND suite_id=$2", [input.targetId, input.suiteId])
        : await client.query("SELECT 1 FROM suite_workbench.plan_snapshots WHERE id=$1 AND suite_id=$2", [input.targetId, input.suiteId]);
      if (!targetExists.rowCount) throw new Error("LIBRARY_TARGET_NOT_FOUND");
      const duplicate = await client.query<any>(`SELECT id, suite_id AS "suiteId", resource_id AS "resourceId", resource_type AS "resourceType", target_type AS "targetType", target_id AS "targetId", resource_version_id AS "resourceVersionId", snapshot_json AS snapshot, created_at AS "createdAt", created_by AS "createdBy", archived_at AS "archivedAt" FROM suite_workbench.library_references WHERE suite_id=$1 AND resource_id=$2 AND target_type=$3 AND target_id=$4 AND archived_at IS NULL`, [input.suiteId, input.resourceId, input.targetType, input.targetId]);
      if (duplicate.rows[0]) { await client.query("INSERT INTO suite_workbench.library_references (id,suite_id,resource_id,resource_type,target_type,target_id,resource_version_id,snapshot_json,idempotency_key,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [randomUUID(), input.suiteId, input.resourceId, resource.resourceType, input.targetType, input.targetId, resource.resourceVersionId, JSON.stringify({ ...resource, previewUrl: undefined }), input.idempotencyKey, input.createdBy ?? null]).catch(() => undefined); await client.query("COMMIT"); return { reference: mapReference(duplicate.rows[0]), duplicate: true }; }
      const result = await client.query<any>(`INSERT INTO suite_workbench.library_references (id,suite_id,resource_id,resource_type,target_type,target_id,resource_version_id,snapshot_json,idempotency_key,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, suite_id AS "suiteId", resource_id AS "resourceId", resource_type AS "resourceType", target_type AS "targetType", target_id AS "targetId", resource_version_id AS "resourceVersionId", snapshot_json AS snapshot, created_at AS "createdAt", created_by AS "createdBy", archived_at AS "archivedAt"`, [randomUUID(), input.suiteId, input.resourceId, resource.resourceType, input.targetType, input.targetId, resource.resourceVersionId, JSON.stringify({ ...resource, previewUrl: undefined }), input.idempotencyKey, input.createdBy ?? null]);
      await client.query("COMMIT"); return { reference: mapReference(result.rows[0]), duplicate: false };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async listReferences(suiteId: string, targetType?: "plan" | "task", targetId?: string) {
    const result = await this.pool.query<any>(`SELECT id, suite_id AS "suiteId", resource_id AS "resourceId", resource_type AS "resourceType", target_type AS "targetType", target_id AS "targetId", resource_version_id AS "resourceVersionId", snapshot_json AS snapshot, created_at AS "createdAt", created_by AS "createdBy", archived_at AS "archivedAt" FROM suite_workbench.library_references WHERE suite_id=$1 AND archived_at IS NULL AND ($2::text IS NULL OR target_type=$2) AND ($3::text IS NULL OR target_id=$3) ORDER BY created_at DESC`, [suiteId, targetType ?? null, targetId ?? null]);
    return result.rows.map(mapReference);
  }

  async archiveReference(suiteId: string, referenceId: string) {
    const result = await this.pool.query<any>(`UPDATE suite_workbench.library_references SET archived_at=COALESCE(archived_at, now()) WHERE suite_id=$1 AND id=$2 RETURNING id, suite_id AS "suiteId", resource_id AS "resourceId", resource_type AS "resourceType", target_type AS "targetType", target_id AS "targetId", resource_version_id AS "resourceVersionId", snapshot_json AS snapshot, created_at AS "createdAt", created_by AS "createdBy", archived_at AS "archivedAt"`, [suiteId, referenceId]);
    return result.rows[0] ? mapReference(result.rows[0]) : null;
  }

  async createReverseReferenceAsset(input: { suiteId?: string | null; title: string; summary?: string; objectKey: string; mimeType: string; promptSnapshot: Record<string, unknown>; visualStructure?: Record<string, unknown>; source?: Record<string, unknown> }): Promise<LibraryResource> {
    const result = await this.pool.query<any>(`INSERT INTO suite_workbench.reverse_reference_assets (suite_id,title,summary,object_key,mime_type,prompt_snapshot_json,visual_structure_json,source_json)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (object_key) DO UPDATE SET
        suite_id = EXCLUDED.suite_id,
        title = EXCLUDED.title,
        summary = EXCLUDED.summary,
        mime_type = EXCLUDED.mime_type,
        prompt_snapshot_json = EXCLUDED.prompt_snapshot_json,
        visual_structure_json = EXCLUDED.visual_structure_json,
        source_json = EXCLUDED.source_json,
        status = CASE
          WHEN EXISTS (
            SELECT 1 FROM suite_workbench.library_resource_deletions d
            WHERE d.resource_id = 'reverse:' || suite_workbench.reverse_reference_assets.id::text
          ) THEN 'draft'
          ELSE suite_workbench.reverse_reference_assets.status
        END,
        archived_at = CASE
          WHEN EXISTS (
            SELECT 1 FROM suite_workbench.library_resource_deletions d
            WHERE d.resource_id = 'reverse:' || suite_workbench.reverse_reference_assets.id::text
          ) THEN NULL
          ELSE suite_workbench.reverse_reference_assets.archived_at
        END,
        updated_at = now()
      RETURNING id, suite_id AS "suiteId", title, summary, mime_type AS "mimeType", object_key AS "objectKey", prompt_snapshot_json AS "promptSnapshot", visual_structure_json AS "visualStructure", source_json AS source, status, created_at AS "createdAt", updated_at AS "updatedAt"`, [input.suiteId ?? null, input.title, input.summary ?? "", input.objectKey, input.mimeType, JSON.stringify(input.promptSnapshot), JSON.stringify(input.visualStructure ?? {}), JSON.stringify(input.source ?? {})]);
    const row = result.rows[0];
    await this.restoreResource(`reverse:${row.id}`);
    return mapReverseRow(row);
  }

  async setResourceStatus(resourceId: string, status: LibraryAssetStatus): Promise<LibraryResource | null> {
    if (!resourceId.startsWith("reverse:")) return null;
    const rawId = resourceId.slice("reverse:".length);
    if (!UUID_RE.test(rawId)) return null;
    const result = await this.pool.query<any>(
      `UPDATE suite_workbench.reverse_reference_assets r
       SET status=$2, updated_at=now(), archived_at=CASE WHEN $2='archived' THEN COALESCE(archived_at,now()) ELSE archived_at END
       WHERE r.id=$1::uuid
         AND NOT EXISTS (SELECT 1 FROM suite_workbench.library_resource_deletions d WHERE d.resource_id = 'reverse:' || r.id::text)
       RETURNING id, suite_id AS "suiteId", title, summary, mime_type AS "mimeType", object_key AS "objectKey", prompt_snapshot_json AS "promptSnapshot", visual_structure_json AS "visualStructure", source_json AS source, status, created_at AS "createdAt", updated_at AS "updatedAt"`,
      [rawId, status],
    );
    if (!result.rows[0]) return null;
    return mapReverseRow(result.rows[0]);
  }
}
