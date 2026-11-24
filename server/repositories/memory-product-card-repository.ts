import {
  buildProductCardImagePreviewUrl,
  type ProductCard,
  type ProductCardFields,
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

interface StoredCardRecord {
  id: string;
  status: ProductCardStatus;
  fields: ProductCardFields;
  sourceSessionId: string | null;
  revision: number;
  images: StoredProductCardImage[];
  createdAt: string;
  updatedAt: string;
}

function toSupplierImage(image: StoredProductCardImage): ProductCardSupplierImage {
  return {
    ...image,
    originalPreviewUrl: buildProductCardImagePreviewUrl(image.productCardId, image.id, "original"),
    thumbnailPreviewUrl: buildProductCardImagePreviewUrl(image.productCardId, image.id, "thumbnail"),
  };
}

function toProductCard(record: StoredCardRecord): ProductCard {
  const supplierImages = [...record.images]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map(toSupplierImage);
  return {
    id: record.id,
    status: record.status,
    name: record.fields.name,
    category: record.fields.category,
    sellingPoints: [...record.fields.sellingPoints],
    specifications: record.fields.specifications,
    materialsCraft: record.fields.materialsCraft,
    audienceScenarios: record.fields.audienceScenarios,
    packageContents: record.fields.packageContents,
    skuCode: record.fields.skuCode,
    painPointsComparison: record.fields.painPointsComparison,
    usageDemoHighlights: record.fields.usageDemoHighlights,
    certificationsProhibitions: record.fields.certificationsProhibitions,
    sourceSessionId: record.sourceSessionId,
    revision: record.revision,
    supplierImages,
    coverThumbnailUrl: supplierImages[0]?.thumbnailPreviewUrl ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toSummary(record: StoredCardRecord): ProductCardSummary {
  const ordered = [...record.images].sort((a, b) => a.ordinal - b.ordinal);
  const cover = ordered[0];
  return {
    id: record.id,
    status: record.status,
    name: record.fields.name,
    category: record.fields.category,
    skuCode: record.fields.skuCode,
    sellingPoints: [...record.fields.sellingPoints],
    revision: record.revision,
    supplierImageCount: ordered.length,
    coverThumbnailUrl: cover
      ? buildProductCardImagePreviewUrl(record.id, cover.id, "thumbnail")
      : null,
    sourceSessionId: record.sourceSessionId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function cloneFields(fields: ProductCardFields): ProductCardFields {
  return {
    ...fields,
    sellingPoints: [...fields.sellingPoints],
  };
}

function compareDesc(a: StoredCardRecord, b: StoredCardRecord): number {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt.localeCompare(a.updatedAt);
  if (a.createdAt !== b.createdAt) return b.createdAt.localeCompare(a.createdAt);
  return b.id.localeCompare(a.id);
}

export class MemoryProductCardRepository implements ProductCardRepository {
  private readonly cards = new Map<string, StoredCardRecord>();

  async list(query: ProductCardListQuery = {}): Promise<ProductCardListResult> {
    const status = query.status ?? "published";
    const keyword = (query.keyword ?? "").trim().toLowerCase();
    const limit = query.limit ?? 24;
    const offset = query.offset ?? 0;

    const filtered = [...this.cards.values()]
      .filter((record) => (status === "all" ? true : record.status === status))
      .filter((record) => {
        if (!keyword) return true;
        return (
          record.fields.name.toLowerCase().includes(keyword) ||
          record.fields.skuCode.toLowerCase().includes(keyword) ||
          record.fields.category.toLowerCase().includes(keyword)
        );
      })
      .sort(compareDesc);

    const items = filtered.slice(offset, offset + limit).map(toSummary);
    return {
      items,
      total: filtered.length,
      limit,
      offset,
    };
  }

  async get(id: string): Promise<ProductCard | null> {
    const found = this.cards.get(id);
    return found ? toProductCard(found) : null;
  }

  async create(input: CreateProductCardRecordInput): Promise<ProductCard> {
    const record: StoredCardRecord = {
      id: input.id,
      status: input.status,
      fields: cloneFields(input.fields),
      sourceSessionId: input.sourceSessionId,
      revision: input.revision,
      images: input.images.map((image) => ({ ...image })).sort((a, b) => a.ordinal - b.ordinal),
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    };
    this.cards.set(record.id, record);
    return toProductCard(record);
  }

  async update(id: string, input: UpdateProductCardRecordInput): Promise<ProductCard | null> {
    const existing = this.cards.get(id);
    if (!existing) return null;
    const updated: StoredCardRecord = {
      ...existing,
      fields: cloneFields(input.fields),
      revision: existing.revision + 1,
      images: input.images.map((image) => ({ ...image })).sort((a, b) => a.ordinal - b.ordinal),
      updatedAt: input.updatedAt,
    };
    this.cards.set(id, updated);
    return toProductCard(updated);
  }

  async setStatus(id: string, status: ProductCardStatus, updatedAt: string): Promise<ProductCard | null> {
    const existing = this.cards.get(id);
    if (!existing) return null;
    const updated: StoredCardRecord = {
      ...existing,
      status,
      updatedAt,
    };
    this.cards.set(id, updated);
    return toProductCard(updated);
  }

  async delete(id: string): Promise<ProductCard | null> {
    const existing = this.cards.get(id);
    if (!existing) return null;
    this.cards.delete(id);
    return toProductCard(existing);
  }

  async getImage(cardId: string, imageId: string): Promise<ProductCardSupplierImage | null> {
    const existing = this.cards.get(cardId);
    if (!existing) return null;
    const image = existing.images.find((item) => item.id === imageId);
    return image ? toSupplierImage(image) : null;
  }
}
