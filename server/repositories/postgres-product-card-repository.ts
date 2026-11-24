import type { Pool, PoolClient } from "pg";
import {
  buildProductCardImagePreviewUrl,
  type ProductCard,
  type ProductCardStatus,
  type ProductCardSummary,
  type ProductCardSupplierImage,
} from "../../shared/product-card.js";
import type {
  CreateProductCardRecordInput,
  ProductCardListQuery,
  ProductCardListResult,
  ProductCardRepository,
  StoredProductCardImage,
  UpdateProductCardRecordInput,
} from "../types.js";

const CARDS_TABLE = "suite_workbench.product_cards";
const IMAGES_TABLE = "suite_workbench.product_card_images";

const CARD_COLS = `
  id,
  status,
  name,
  category,
  selling_points_json AS "sellingPoints",
  specifications,
  materials_craft AS "materialsCraft",
  audience_scenarios AS "audienceScenarios",
  package_contents AS "packageContents",
  sku_code AS "skuCode",
  pain_points_comparison AS "painPointsComparison",
  usage_demo_highlights AS "usageDemoHighlights",
  certifications_prohibitions AS "certificationsProhibitions",
  source_session_id AS "sourceSessionId",
  revision,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const IMAGE_COLS = `
  id,
  product_card_id AS "productCardId",
  ordinal,
  original_object_key AS "originalObjectKey",
  thumbnail_object_key AS "thumbnailObjectKey",
  sha256,
  width,
  height,
  mime_type AS "mimeType",
  original_filename AS "originalFilename",
  created_at AS "createdAt"
`;

interface CardRow {
  id: string;
  status: ProductCardStatus;
  name: string;
  category: string;
  sellingPoints: string[];
  specifications: string;
  materialsCraft: string;
  audienceScenarios: string;
  packageContents: string;
  skuCode: string;
  painPointsComparison: string;
  usageDemoHighlights: string;
  certificationsProhibitions: string;
  sourceSessionId: string | null;
  revision: number;
  createdAt: Date | string;
  updatedAt: Date | string;
}

interface SummaryRow {
  id: string;
  status: ProductCardStatus;
  name: string;
  category: string;
  skuCode: string;
  sellingPoints: string[];
  revision: number;
  sourceSessionId: string | null;
  supplierImageCount: number;
  coverImageId: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

interface ImageRow {
  id: string;
  productCardId: string;
  ordinal: number;
  originalObjectKey: string;
  thumbnailObjectKey: string;
  sha256: string;
  width: number;
  height: number;
  mimeType: string;
  originalFilename: string;
  createdAt: Date | string;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function normalizeImageRow(row: ImageRow): ProductCardSupplierImage {
  return {
    id: row.id,
    productCardId: row.productCardId,
    ordinal: row.ordinal,
    originalObjectKey: row.originalObjectKey,
    thumbnailObjectKey: row.thumbnailObjectKey,
    sha256: row.sha256.trim(),
    width: row.width,
    height: row.height,
    mimeType: row.mimeType,
    originalFilename: row.originalFilename,
    createdAt: toIsoString(row.createdAt),
    originalPreviewUrl: buildProductCardImagePreviewUrl(row.productCardId, row.id, "original"),
    thumbnailPreviewUrl: buildProductCardImagePreviewUrl(row.productCardId, row.id, "thumbnail"),
  };
}

function assembleProductCard(row: CardRow, images: ProductCardSupplierImage[]): ProductCard {
  const ordered = [...images].sort((a, b) => a.ordinal - b.ordinal);
  return {
    id: row.id,
    status: row.status,
    name: row.name,
    category: row.category,
    sellingPoints: Array.isArray(row.sellingPoints) ? [...row.sellingPoints] : [],
    specifications: row.specifications,
    materialsCraft: row.materialsCraft,
    audienceScenarios: row.audienceScenarios,
    packageContents: row.packageContents,
    skuCode: row.skuCode ?? "",
    painPointsComparison: row.painPointsComparison ?? "",
    usageDemoHighlights: row.usageDemoHighlights ?? "",
    certificationsProhibitions: row.certificationsProhibitions ?? "",
    sourceSessionId: row.sourceSessionId ?? null,
    revision: row.revision,
    supplierImages: ordered,
    coverThumbnailUrl: ordered[0]?.thumbnailPreviewUrl ?? null,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

async function insertImages(client: PoolClient, images: StoredProductCardImage[]): Promise<void> {
  const ordered = [...images].sort((a, b) => a.ordinal - b.ordinal);
  for (const image of ordered) {
    await client.query(
      `INSERT INTO ${IMAGES_TABLE}
        (id, product_card_id, ordinal, original_object_key, thumbnail_object_key, sha256, width, height, mime_type, original_filename, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        image.id,
        image.productCardId,
        image.ordinal,
        image.originalObjectKey,
        image.thumbnailObjectKey,
        image.sha256,
        image.width,
        image.height,
        image.mimeType,
        image.originalFilename,
        image.createdAt,
      ],
    );
  }
}

export class PostgresProductCardRepository implements ProductCardRepository {
  constructor(private readonly pool: Pool) {}

  async list(query: ProductCardListQuery = {}): Promise<ProductCardListResult> {
    const status = query.status ?? "published";
    const keyword = (query.keyword ?? "").trim();
    const limit = query.limit ?? 24;
    const offset = query.offset ?? 0;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (status !== "all") {
      params.push(status);
      conditions.push(`c.status = $${params.length}`);
    }
    if (keyword) {
      params.push(`%${escapeLikePattern(keyword.toLowerCase())}%`);
      const idx = params.length;
      conditions.push(
        `(lower(c.name) LIKE $${idx} ESCAPE '\\' OR lower(c.sku_code) LIKE $${idx} ESCAPE '\\' OR lower(c.category) LIKE $${idx} ESCAPE '\\')`,
      );
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countResult = await this.pool.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM ${CARDS_TABLE} c ${whereClause}`,
      params,
    );
    const total = countResult.rows[0]?.total ?? 0;

    const listParams = [...params, limit, offset];
    const limitIdx = params.length + 1;
    const offsetIdx = params.length + 2;

    const rowsResult = await this.pool.query<SummaryRow>(
      `SELECT
         c.id,
         c.status,
         c.name,
         c.category,
         c.sku_code AS "skuCode",
         c.selling_points_json AS "sellingPoints",
         c.revision,
         c.source_session_id AS "sourceSessionId",
         c.created_at AS "createdAt",
         c.updated_at AS "updatedAt",
         (SELECT count(*)::int FROM ${IMAGES_TABLE} i WHERE i.product_card_id = c.id) AS "supplierImageCount",
         (SELECT i.id FROM ${IMAGES_TABLE} i WHERE i.product_card_id = c.id ORDER BY i.ordinal ASC LIMIT 1) AS "coverImageId"
       FROM ${CARDS_TABLE} c
       ${whereClause}
       ORDER BY c.updated_at DESC, c.created_at DESC, c.id DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      listParams,
    );

    const items: ProductCardSummary[] = rowsResult.rows.map((row) => ({
      id: row.id,
      status: row.status,
      name: row.name,
      category: row.category,
      skuCode: row.skuCode ?? "",
      sellingPoints: Array.isArray(row.sellingPoints) ? [...row.sellingPoints] : [],
      revision: row.revision,
      supplierImageCount: row.supplierImageCount ?? 0,
      coverThumbnailUrl: row.coverImageId
        ? buildProductCardImagePreviewUrl(row.id, row.coverImageId, "thumbnail")
        : null,
      sourceSessionId: row.sourceSessionId ?? null,
      createdAt: toIsoString(row.createdAt),
      updatedAt: toIsoString(row.updatedAt),
    }));

    return { items, total, limit, offset };
  }

  async get(id: string): Promise<ProductCard | null> {
    const cardResult = await this.pool.query<CardRow>(
      `SELECT ${CARD_COLS} FROM ${CARDS_TABLE} WHERE id = $1`,
      [id],
    );
    const cardRow = cardResult.rows[0];
    if (!cardRow) return null;

    const imagesResult = await this.pool.query<ImageRow>(
      `SELECT ${IMAGE_COLS} FROM ${IMAGES_TABLE} WHERE product_card_id = $1 ORDER BY ordinal ASC`,
      [id],
    );
    return assembleProductCard(cardRow, imagesResult.rows.map(normalizeImageRow));
  }

  async create(input: CreateProductCardRecordInput): Promise<ProductCard> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const cardResult = await client.query<CardRow>(
        `INSERT INTO ${CARDS_TABLE} (
          id, status, name, category, selling_points_json, specifications, materials_craft,
          audience_scenarios, package_contents, sku_code, pain_points_comparison,
          usage_demo_highlights, certifications_prohibitions, source_session_id,
          revision, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        RETURNING ${CARD_COLS}`,
        [
          input.id,
          input.status,
          input.fields.name,
          input.fields.category,
          JSON.stringify(input.fields.sellingPoints),
          input.fields.specifications,
          input.fields.materialsCraft,
          input.fields.audienceScenarios,
          input.fields.packageContents,
          input.fields.skuCode,
          input.fields.painPointsComparison,
          input.fields.usageDemoHighlights,
          input.fields.certificationsProhibitions,
          input.sourceSessionId,
          input.revision,
          input.createdAt,
          input.updatedAt,
        ],
      );
      await insertImages(client, input.images);
      await client.query("COMMIT");

      const images = input.images
        .map((image) =>
          normalizeImageRow({
            ...image,
            createdAt: image.createdAt,
          }),
        )
        .sort((a, b) => a.ordinal - b.ordinal);
      return assembleProductCard(cardResult.rows[0], images);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async update(id: string, input: UpdateProductCardRecordInput): Promise<ProductCard | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const cardResult = await client.query<CardRow>(
        `UPDATE ${CARDS_TABLE}
         SET
           name = $2,
           category = $3,
           selling_points_json = $4::jsonb,
           specifications = $5,
           materials_craft = $6,
           audience_scenarios = $7,
           package_contents = $8,
           sku_code = $9,
           pain_points_comparison = $10,
           usage_demo_highlights = $11,
           certifications_prohibitions = $12,
           revision = revision + 1,
           updated_at = $13
         WHERE id = $1
         RETURNING ${CARD_COLS}`,
        [
          id,
          input.fields.name,
          input.fields.category,
          JSON.stringify(input.fields.sellingPoints),
          input.fields.specifications,
          input.fields.materialsCraft,
          input.fields.audienceScenarios,
          input.fields.packageContents,
          input.fields.skuCode,
          input.fields.painPointsComparison,
          input.fields.usageDemoHighlights,
          input.fields.certificationsProhibitions,
          input.updatedAt,
        ],
      );
      const cardRow = cardResult.rows[0];
      if (!cardRow) {
        await client.query("ROLLBACK");
        return null;
      }

      await client.query(`DELETE FROM ${IMAGES_TABLE} WHERE product_card_id = $1`, [id]);
      await insertImages(client, input.images);
      await client.query("COMMIT");

      const images = input.images
        .map((image) =>
          normalizeImageRow({
            ...image,
            createdAt: image.createdAt,
          }),
        )
        .sort((a, b) => a.ordinal - b.ordinal);
      return assembleProductCard(cardRow, images);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async setStatus(id: string, status: ProductCardStatus, updatedAt: string): Promise<ProductCard | null> {
    const updated = await this.pool.query<{ id: string }>(
      `UPDATE ${CARDS_TABLE} SET status = $2, updated_at = $3 WHERE id = $1 RETURNING id`,
      [id, status, updatedAt],
    );
    if (!updated.rowCount) return null;
    return this.get(id);
  }

  async delete(id: string): Promise<ProductCard | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const cardResult = await client.query<CardRow>(
        `SELECT ${CARD_COLS} FROM ${CARDS_TABLE} WHERE id = $1`,
        [id],
      );
      const cardRow = cardResult.rows[0];
      if (!cardRow) {
        await client.query("ROLLBACK");
        return null;
      }
      const imagesResult = await client.query<ImageRow>(
        `SELECT ${IMAGE_COLS} FROM ${IMAGES_TABLE} WHERE product_card_id = $1 ORDER BY ordinal ASC`,
        [id],
      );
      await client.query(`DELETE FROM ${CARDS_TABLE} WHERE id = $1`, [id]);
      await client.query("COMMIT");
      return assembleProductCard(cardRow, imagesResult.rows.map(normalizeImageRow));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getImage(cardId: string, imageId: string): Promise<ProductCardSupplierImage | null> {
    const result = await this.pool.query<ImageRow>(
      `SELECT ${IMAGE_COLS} FROM ${IMAGES_TABLE} WHERE product_card_id = $1 AND id = $2`,
      [cardId, imageId],
    );
    return result.rows[0] ? normalizeImageRow(result.rows[0]) : null;
  }
}
