import type { Pool, PoolClient } from "pg";
import {
  emptyProductCardFields,
  getMissingRequiredProductCardFields,
  type ProductCardFields,
  type ProductCardRequiredField,
} from "../../shared/product-card.js";
import {
  buildProductOnboardingImagePreviewUrl,
  PRODUCT_ONBOARDING_DEFAULT_TITLE,
  type ProductOnboardingAttachment,
  type ProductOnboardingDraftImage,
  type ProductOnboardingMessage,
  type ProductOnboardingSession,
  type ProductOnboardingSessionListResult,
  type ProductOnboardingSessionSummary,
  type ProductOnboardingStatus,
} from "../../shared/product-onboarding.js";

export interface StoredOnboardingDraftImage {
  id: string;
  ordinal: number;
  originalObjectKey: string;
  thumbnailObjectKey: string;
  sha256: string;
  width: number;
  height: number;
  mimeType: string;
  originalFilename: string;
  createdAt: string;
}

export interface CreateOnboardingSessionInput {
  id: string;
  title: string;
  draftCard: ProductCardFields;
  draftImages: StoredOnboardingDraftImage[];
  missingRequiredFields: ProductCardRequiredField[];
  messages: Array<Omit<ProductOnboardingMessage, "sessionId" | "ordinal">>;
  createdAt: string;
  updatedAt: string;
}

export interface AppendOnboardingTurnInput {
  title: string;
  draftCard: ProductCardFields;
  draftImages: StoredOnboardingDraftImage[];
  missingRequiredFields: ProductCardRequiredField[];
  messages: Array<Omit<ProductOnboardingMessage, "sessionId" | "ordinal">>;
  updatedAt: string;
}

export interface UpdateOnboardingDraftInput {
  title: string;
  draftCard: ProductCardFields;
  draftImages: StoredOnboardingDraftImage[];
  missingRequiredFields: ProductCardRequiredField[];
  updatedAt: string;
}

export interface ProductOnboardingListQuery {
  status?: ProductOnboardingStatus | "all";
  limit?: number;
  offset?: number;
}

export interface ProductOnboardingRepository {
  list(query?: ProductOnboardingListQuery): Promise<ProductOnboardingSessionListResult>;
  get(id: string): Promise<ProductOnboardingSession | null>;
  createWithMessages(input: CreateOnboardingSessionInput): Promise<ProductOnboardingSession>;
  appendTurn(
    sessionId: string,
    input: AppendOnboardingTurnInput,
  ): Promise<{ session: ProductOnboardingSession } | { conflict: "completed" } | null>;
  updateDraft(
    sessionId: string,
    input: UpdateOnboardingDraftInput,
  ): Promise<{ session: ProductOnboardingSession } | { conflict: "completed" } | null>;
  markCompleted(
    sessionId: string,
    productCardId: string,
    updatedAt: string,
  ): Promise<
    | { session: ProductOnboardingSession; alreadyCompleted: boolean }
    | null
  >;
  delete(sessionId: string): Promise<ProductOnboardingSession | null>;
  getDraftImage(sessionId: string, imageId: string): Promise<ProductOnboardingDraftImage | null>;
}

const SESSIONS_TABLE = "suite_workbench.product_onboarding_sessions";
const MESSAGES_TABLE = "suite_workbench.product_onboarding_messages";

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function cloneFields(fields: Partial<ProductCardFields> | null | undefined): ProductCardFields {
  const base = emptyProductCardFields();
  if (!fields || typeof fields !== "object") return base;
  return {
    name: typeof fields.name === "string" ? fields.name : "",
    category: typeof fields.category === "string" ? fields.category : "",
    sellingPoints: Array.isArray(fields.sellingPoints)
      ? fields.sellingPoints.filter((item): item is string => typeof item === "string")
      : [],
    specifications: typeof fields.specifications === "string" ? fields.specifications : "",
    materialsCraft: typeof fields.materialsCraft === "string" ? fields.materialsCraft : "",
    audienceScenarios: typeof fields.audienceScenarios === "string" ? fields.audienceScenarios : "",
    packageContents: typeof fields.packageContents === "string" ? fields.packageContents : "",
    skuCode: typeof fields.skuCode === "string" ? fields.skuCode : "",
    painPointsComparison:
      typeof fields.painPointsComparison === "string" ? fields.painPointsComparison : "",
    usageDemoHighlights:
      typeof fields.usageDemoHighlights === "string" ? fields.usageDemoHighlights : "",
    certificationsProhibitions:
      typeof fields.certificationsProhibitions === "string"
        ? fields.certificationsProhibitions
        : "",
  };
}

function toDraftImageView(
  sessionId: string,
  image: StoredOnboardingDraftImage,
): ProductOnboardingDraftImage {
  return {
    ...image,
    originalPreviewUrl: buildProductOnboardingImagePreviewUrl(sessionId, image.id, "original"),
    thumbnailPreviewUrl: buildProductOnboardingImagePreviewUrl(sessionId, image.id, "thumbnail"),
  };
}

function normalizeStoredDraftImages(
  raw: unknown,
): StoredOnboardingDraftImage[] {
  if (!Array.isArray(raw)) return [];
  const images: StoredOnboardingDraftImage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      typeof row.originalObjectKey !== "string" ||
      typeof row.thumbnailObjectKey !== "string"
    ) {
      continue;
    }
    images.push({
      id: row.id,
      ordinal: typeof row.ordinal === "number" ? row.ordinal : images.length + 1,
      originalObjectKey: row.originalObjectKey,
      thumbnailObjectKey: row.thumbnailObjectKey,
      sha256: typeof row.sha256 === "string" ? row.sha256.trim() : "",
      width: typeof row.width === "number" ? row.width : 1,
      height: typeof row.height === "number" ? row.height : 1,
      mimeType: typeof row.mimeType === "string" ? row.mimeType : "image/png",
      originalFilename: typeof row.originalFilename === "string" ? row.originalFilename : "image",
      createdAt: typeof row.createdAt === "string" ? row.createdAt : new Date().toISOString(),
    });
  }
  return images.sort((a, b) => a.ordinal - b.ordinal);
}

function cloneAttachments(attachments: ProductOnboardingAttachment[]): ProductOnboardingAttachment[] {
  return attachments.map((item) => ({ ...item }));
}

function cloneMessage(message: ProductOnboardingMessage): ProductOnboardingMessage {
  return {
    ...message,
    attachments: cloneAttachments(message.attachments),
    modelSnapshot: message.modelSnapshot ? { ...message.modelSnapshot } : null,
  };
}

interface MemoryStoredSession {
  id: string;
  title: string;
  status: ProductOnboardingStatus;
  draftCard: ProductCardFields;
  draftImages: StoredOnboardingDraftImage[];
  missingRequiredFields: ProductCardRequiredField[];
  productCardId: string | null;
  messages: ProductOnboardingMessage[];
  createdAt: string;
  updatedAt: string;
}

function toSessionView(record: MemoryStoredSession): ProductOnboardingSession {
  const supplierImages = [...record.draftImages]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((image) => toDraftImageView(record.id, image));
  const draftCard = cloneFields(record.draftCard);
  return {
    id: record.id,
    title: record.title || PRODUCT_ONBOARDING_DEFAULT_TITLE,
    status: record.status,
    draftCard,
    supplierImages,
    missingRequiredFields: getMissingRequiredProductCardFields(draftCard),
    productCardId: record.productCardId,
    messages: [...record.messages].sort((a, b) => a.ordinal - b.ordinal).map(cloneMessage),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toSummaryView(record: MemoryStoredSession): ProductOnboardingSessionSummary {
  const ordered = [...record.draftImages].sort((a, b) => a.ordinal - b.ordinal);
  const cover = ordered[0];
  const draftCard = cloneFields(record.draftCard);
  return {
    id: record.id,
    title: record.title || PRODUCT_ONBOARDING_DEFAULT_TITLE,
    status: record.status,
    draftCard,
    missingRequiredFields: getMissingRequiredProductCardFields(draftCard),
    supplierImageCount: ordered.length,
    coverThumbnailUrl: cover
      ? buildProductOnboardingImagePreviewUrl(record.id, cover.id, "thumbnail")
      : null,
    productCardId: record.productCardId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function compareDesc(a: { updatedAt: string; createdAt: string; id: string }, b: { updatedAt: string; createdAt: string; id: string }): number {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt.localeCompare(a.updatedAt);
  if (a.createdAt !== b.createdAt) return b.createdAt.localeCompare(a.createdAt);
  return b.id.localeCompare(a.id);
}

export class MemoryProductOnboardingRepository implements ProductOnboardingRepository {
  private readonly sessions = new Map<string, MemoryStoredSession>();

  async list(query: ProductOnboardingListQuery = {}): Promise<ProductOnboardingSessionListResult> {
    const status = query.status ?? "all";
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;

    const filtered = [...this.sessions.values()]
      .filter((record) => (status === "all" ? true : record.status === status))
      .sort(compareDesc);

    return {
      items: filtered.slice(offset, offset + limit).map(toSummaryView),
      total: filtered.length,
      limit,
      offset,
    };
  }

  async get(id: string): Promise<ProductOnboardingSession | null> {
    const record = this.sessions.get(id);
    return record ? toSessionView(record) : null;
  }

  async createWithMessages(input: CreateOnboardingSessionInput): Promise<ProductOnboardingSession> {
    const messages: ProductOnboardingMessage[] = input.messages.map((msg, index) => ({
      ...msg,
      sessionId: input.id,
      ordinal: index + 1,
      attachments: cloneAttachments(msg.attachments),
      modelSnapshot: msg.modelSnapshot ? { ...msg.modelSnapshot } : null,
    }));

    const record: MemoryStoredSession = {
      id: input.id,
      title: input.title || PRODUCT_ONBOARDING_DEFAULT_TITLE,
      status: "draft",
      draftCard: cloneFields(input.draftCard),
      draftImages: input.draftImages.map((img) => ({ ...img })).sort((a, b) => a.ordinal - b.ordinal),
      missingRequiredFields: [...input.missingRequiredFields],
      productCardId: null,
      messages,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    };
    this.sessions.set(record.id, record);
    return toSessionView(record);
  }

  async appendTurn(
    sessionId: string,
    input: AppendOnboardingTurnInput,
  ): Promise<{ session: ProductOnboardingSession } | { conflict: "completed" } | null> {
    const existing = this.sessions.get(sessionId);
    if (!existing) return null;
    if (existing.status === "completed") return { conflict: "completed" };

    const startOrdinal = existing.messages.length;
    const appended: ProductOnboardingMessage[] = input.messages.map((msg, index) => ({
      ...msg,
      sessionId,
      ordinal: startOrdinal + index + 1,
      attachments: cloneAttachments(msg.attachments),
      modelSnapshot: msg.modelSnapshot ? { ...msg.modelSnapshot } : null,
    }));

    const updated: MemoryStoredSession = {
      ...existing,
      title: input.title || existing.title,
      draftCard: cloneFields(input.draftCard),
      draftImages: input.draftImages.map((img) => ({ ...img })).sort((a, b) => a.ordinal - b.ordinal),
      missingRequiredFields: [...input.missingRequiredFields],
      messages: [...existing.messages, ...appended],
      updatedAt: input.updatedAt,
    };
    this.sessions.set(sessionId, updated);
    return { session: toSessionView(updated) };
  }

  async updateDraft(
    sessionId: string,
    input: UpdateOnboardingDraftInput,
  ): Promise<{ session: ProductOnboardingSession } | { conflict: "completed" } | null> {
    const existing = this.sessions.get(sessionId);
    if (!existing) return null;
    if (existing.status === "completed") return { conflict: "completed" };

    const updated: MemoryStoredSession = {
      ...existing,
      title: input.title || existing.title,
      draftCard: cloneFields(input.draftCard),
      draftImages: input.draftImages.map((img) => ({ ...img })).sort((a, b) => a.ordinal - b.ordinal),
      missingRequiredFields: [...input.missingRequiredFields],
      updatedAt: input.updatedAt,
    };
    this.sessions.set(sessionId, updated);
    return { session: toSessionView(updated) };
  }

  async markCompleted(
    sessionId: string,
    productCardId: string,
    updatedAt: string,
  ): Promise<{ session: ProductOnboardingSession; alreadyCompleted: boolean } | null> {
    const existing = this.sessions.get(sessionId);
    if (!existing) return null;
    if (existing.status === "completed") {
      return { session: toSessionView(existing), alreadyCompleted: true };
    }
    const updated: MemoryStoredSession = {
      ...existing,
      status: "completed",
      missingRequiredFields: [],
      productCardId,
      updatedAt,
    };
    this.sessions.set(sessionId, updated);
    return { session: toSessionView(updated), alreadyCompleted: false };
  }

  async delete(sessionId: string): Promise<ProductOnboardingSession | null> {
    const existing = this.sessions.get(sessionId);
    if (!existing) return null;
    this.sessions.delete(sessionId);
    return toSessionView(existing);
  }

  async getDraftImage(sessionId: string, imageId: string): Promise<ProductOnboardingDraftImage | null> {
    const existing = this.sessions.get(sessionId);
    if (!existing) return null;
    const found = existing.draftImages.find((image) => image.id === imageId);
    return found ? toDraftImageView(sessionId, found) : null;
  }
}

interface SessionRow {
  id: string;
  title: string;
  status: ProductOnboardingStatus;
  draftCard: ProductCardFields;
  draftImages: StoredOnboardingDraftImage[];
  missingRequiredFields: ProductCardRequiredField[];
  productCardId: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

interface MessageRow {
  id: string;
  sessionId: string;
  ordinal: number;
  role: "user" | "assistant";
  content: string;
  attachments: ProductOnboardingAttachment[];
  templateVersionId: string | null;
  modelSnapshot: Record<string, unknown> | null;
  createdAt: Date | string;
}

const SESSION_COLS = `
  id,
  title,
  status,
  draft_card_json AS "draftCard",
  draft_images_json AS "draftImages",
  missing_required_fields_json AS "missingRequiredFields",
  product_card_id AS "productCardId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const MESSAGE_COLS = `
  id,
  session_id AS "sessionId",
  ordinal,
  role,
  content,
  attachments_json AS "attachments",
  template_version_id AS "templateVersionId",
  model_snapshot_json AS "modelSnapshot",
  created_at AS "createdAt"
`;

function normalizeMessageRow(row: MessageRow): ProductOnboardingMessage {
  return {
    id: row.id,
    sessionId: row.sessionId,
    ordinal: row.ordinal,
    role: row.role,
    content: row.content ?? "",
    attachments: Array.isArray(row.attachments) ? cloneAttachments(row.attachments) : [],
    templateVersionId: row.templateVersionId ?? null,
    modelSnapshot: row.modelSnapshot ? { ...row.modelSnapshot } : null,
    createdAt: toIsoString(row.createdAt),
  };
}

function assembleSession(row: SessionRow, messages: ProductOnboardingMessage[]): ProductOnboardingSession {
  const draftCard = cloneFields(row.draftCard);
  const storedImages = normalizeStoredDraftImages(row.draftImages);
  const supplierImages = storedImages.map((image) => toDraftImageView(row.id, image));
  return {
    id: row.id,
    title: row.title || PRODUCT_ONBOARDING_DEFAULT_TITLE,
    status: row.status,
    draftCard,
    supplierImages,
    missingRequiredFields: getMissingRequiredProductCardFields(draftCard),
    productCardId: row.productCardId ?? null,
    messages: [...messages].sort((a, b) => a.ordinal - b.ordinal),
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

function assembleSummary(row: SessionRow): ProductOnboardingSessionSummary {
  const draftCard = cloneFields(row.draftCard);
  const storedImages = normalizeStoredDraftImages(row.draftImages);
  const cover = storedImages[0];
  return {
    id: row.id,
    title: row.title || PRODUCT_ONBOARDING_DEFAULT_TITLE,
    status: row.status,
    draftCard,
    missingRequiredFields: getMissingRequiredProductCardFields(draftCard),
    supplierImageCount: storedImages.length,
    coverThumbnailUrl: cover
      ? buildProductOnboardingImagePreviewUrl(row.id, cover.id, "thumbnail")
      : null,
    productCardId: row.productCardId ?? null,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

async function fetchMessages(client: Pool | PoolClient, sessionId: string): Promise<ProductOnboardingMessage[]> {
  const result = await client.query<MessageRow>(
    `SELECT ${MESSAGE_COLS} FROM ${MESSAGES_TABLE} WHERE session_id = $1 ORDER BY ordinal ASC`,
    [sessionId],
  );
  return result.rows.map(normalizeMessageRow);
}

async function insertMessages(
  client: PoolClient,
  sessionId: string,
  startOrdinal: number,
  messages: Array<Omit<ProductOnboardingMessage, "sessionId" | "ordinal">>,
): Promise<ProductOnboardingMessage[]> {
  const inserted: ProductOnboardingMessage[] = [];
  for (const [index, msg] of messages.entries()) {
    const ordinal = startOrdinal + index + 1;
    const res = await client.query<MessageRow>(
      `INSERT INTO ${MESSAGES_TABLE}
        (id, session_id, ordinal, role, content, attachments_json, template_version_id, model_snapshot_json, created_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9)
       RETURNING ${MESSAGE_COLS}`,
      [
        msg.id,
        sessionId,
        ordinal,
        msg.role,
        msg.content,
        JSON.stringify(msg.attachments),
        msg.templateVersionId,
        msg.modelSnapshot ? JSON.stringify(msg.modelSnapshot) : null,
        msg.createdAt,
      ],
    );
    inserted.push(normalizeMessageRow(res.rows[0]));
  }
  return inserted;
}

export class PostgresProductOnboardingRepository implements ProductOnboardingRepository {
  constructor(private readonly pool: Pool) {}

  async list(query: ProductOnboardingListQuery = {}): Promise<ProductOnboardingSessionListResult> {
    const status = query.status ?? "all";
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;

    const params: unknown[] = [];
    const whereClause =
      status !== "all" ? (params.push(status), `WHERE status = $1`) : "";

    const countResult = await this.pool.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM ${SESSIONS_TABLE} ${whereClause}`,
      params,
    );
    const total = countResult.rows[0]?.total ?? 0;

    const listParams = [...params, limit, offset];
    const limitIdx = params.length + 1;
    const offsetIdx = params.length + 2;

    const rowsResult = await this.pool.query<SessionRow>(
      `SELECT ${SESSION_COLS}
       FROM ${SESSIONS_TABLE}
       ${whereClause}
       ORDER BY updated_at DESC, created_at DESC, id DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      listParams,
    );

    return {
      items: rowsResult.rows.map(assembleSummary),
      total,
      limit,
      offset,
    };
  }

  async get(id: string): Promise<ProductOnboardingSession | null> {
    const sessionResult = await this.pool.query<SessionRow>(
      `SELECT ${SESSION_COLS} FROM ${SESSIONS_TABLE} WHERE id = $1`,
      [id],
    );
    const row = sessionResult.rows[0];
    if (!row) return null;
    const messages = await fetchMessages(this.pool, id);
    return assembleSession(row, messages);
  }

  async createWithMessages(input: CreateOnboardingSessionInput): Promise<ProductOnboardingSession> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const sessionResult = await client.query<SessionRow>(
        `INSERT INTO ${SESSIONS_TABLE}
          (id, title, status, draft_card_json, draft_images_json, missing_required_fields_json, product_card_id, created_at, updated_at)
         VALUES ($1,$2,'draft',$3::jsonb,$4::jsonb,$5::jsonb,NULL,$6,$7)
         RETURNING ${SESSION_COLS}`,
        [
          input.id,
          input.title || PRODUCT_ONBOARDING_DEFAULT_TITLE,
          JSON.stringify(input.draftCard),
          JSON.stringify(input.draftImages),
          JSON.stringify(input.missingRequiredFields),
          input.createdAt,
          input.updatedAt,
        ],
      );
      const messages = await insertMessages(client, input.id, 0, input.messages);
      await client.query("COMMIT");
      return assembleSession(sessionResult.rows[0], messages);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async appendTurn(
    sessionId: string,
    input: AppendOnboardingTurnInput,
  ): Promise<{ session: ProductOnboardingSession } | { conflict: "completed" } | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<SessionRow>(
        `SELECT ${SESSION_COLS} FROM ${SESSIONS_TABLE} WHERE id = $1 FOR UPDATE`,
        [sessionId],
      );
      const current = locked.rows[0];
      if (!current) {
        await client.query("ROLLBACK");
        return null;
      }
      if (current.status === "completed") {
        await client.query("ROLLBACK");
        return { conflict: "completed" };
      }

      const maxOrdinalResult = await client.query<{ maxOrdinal: number }>(
        `SELECT COALESCE(MAX(ordinal), 0)::int AS "maxOrdinal" FROM ${MESSAGES_TABLE} WHERE session_id = $1`,
        [sessionId],
      );
      const startOrdinal = maxOrdinalResult.rows[0]?.maxOrdinal ?? 0;

      await insertMessages(client, sessionId, startOrdinal, input.messages);
      const updated = await client.query<SessionRow>(
        `UPDATE ${SESSIONS_TABLE}
         SET title = $2,
             draft_card_json = $3::jsonb,
             draft_images_json = $4::jsonb,
             missing_required_fields_json = $5::jsonb,
             updated_at = $6
         WHERE id = $1
         RETURNING ${SESSION_COLS}`,
        [
          sessionId,
          input.title || current.title,
          JSON.stringify(input.draftCard),
          JSON.stringify(input.draftImages),
          JSON.stringify(input.missingRequiredFields),
          input.updatedAt,
        ],
      );
      const messages = await fetchMessages(client, sessionId);
      await client.query("COMMIT");
      return { session: assembleSession(updated.rows[0], messages) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async updateDraft(
    sessionId: string,
    input: UpdateOnboardingDraftInput,
  ): Promise<{ session: ProductOnboardingSession } | { conflict: "completed" } | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<SessionRow>(
        `SELECT ${SESSION_COLS} FROM ${SESSIONS_TABLE} WHERE id = $1 FOR UPDATE`,
        [sessionId],
      );
      const current = locked.rows[0];
      if (!current) {
        await client.query("ROLLBACK");
        return null;
      }
      if (current.status === "completed") {
        await client.query("ROLLBACK");
        return { conflict: "completed" };
      }

      const updated = await client.query<SessionRow>(
        `UPDATE ${SESSIONS_TABLE}
         SET title = $2,
             draft_card_json = $3::jsonb,
             draft_images_json = $4::jsonb,
             missing_required_fields_json = $5::jsonb,
             updated_at = $6
         WHERE id = $1
         RETURNING ${SESSION_COLS}`,
        [
          sessionId,
          input.title || current.title,
          JSON.stringify(input.draftCard),
          JSON.stringify(input.draftImages),
          JSON.stringify(input.missingRequiredFields),
          input.updatedAt,
        ],
      );
      const messages = await fetchMessages(client, sessionId);
      await client.query("COMMIT");
      return { session: assembleSession(updated.rows[0], messages) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markCompleted(
    sessionId: string,
    productCardId: string,
    updatedAt: string,
  ): Promise<{ session: ProductOnboardingSession; alreadyCompleted: boolean } | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<SessionRow>(
        `SELECT ${SESSION_COLS} FROM ${SESSIONS_TABLE} WHERE id = $1 FOR UPDATE`,
        [sessionId],
      );
      const current = locked.rows[0];
      if (!current) {
        await client.query("ROLLBACK");
        return null;
      }
      if (current.status === "completed") {
        const messages = await fetchMessages(client, sessionId);
        await client.query("COMMIT");
        return { session: assembleSession(current, messages), alreadyCompleted: true };
      }

      const updated = await client.query<SessionRow>(
        `UPDATE ${SESSIONS_TABLE}
         SET status = 'completed',
             product_card_id = $2,
             missing_required_fields_json = '[]'::jsonb,
             updated_at = $3
         WHERE id = $1
         RETURNING ${SESSION_COLS}`,
        [sessionId, productCardId, updatedAt],
      );
      const messages = await fetchMessages(client, sessionId);
      await client.query("COMMIT");
      return { session: assembleSession(updated.rows[0], messages), alreadyCompleted: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async delete(sessionId: string): Promise<ProductOnboardingSession | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<SessionRow>(
        `SELECT ${SESSION_COLS} FROM ${SESSIONS_TABLE} WHERE id = $1 FOR UPDATE`,
        [sessionId],
      );
      const current = locked.rows[0];
      if (!current) {
        await client.query("ROLLBACK");
        return null;
      }
      const messages = await fetchMessages(client, sessionId);
      await client.query(`DELETE FROM ${SESSIONS_TABLE} WHERE id = $1`, [sessionId]);
      await client.query("COMMIT");
      return assembleSession(current, messages);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getDraftImage(sessionId: string, imageId: string): Promise<ProductOnboardingDraftImage | null> {
    const sessionResult = await this.pool.query<{ draftImages: StoredOnboardingDraftImage[] }>(
      `SELECT draft_images_json AS "draftImages" FROM ${SESSIONS_TABLE} WHERE id = $1`,
      [sessionId],
    );
    const row = sessionResult.rows[0];
    if (!row) return null;
    const found = normalizeStoredDraftImages(row.draftImages).find((image) => image.id === imageId);
    return found ? toDraftImageView(sessionId, found) : null;
  }
}
