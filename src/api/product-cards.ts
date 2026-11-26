import { getJson, postJson, patchJson, deleteJson } from "./http.js";

import type {
  ProductCard,
  ProductCardFields,
  ProductCardSnapshot,
  ProductCardStatus,
  ProductCardSummary,
  ProductCardSupplierImage,
} from "../../shared/product-card";

export type {
  ProductCard as ApiProductCard,
  ProductCardFields as ApiProductCardFields,
  ProductCardSnapshot as ApiProductCardSnapshot,
  ProductCardStatus as ApiProductCardStatus,
  ProductCardSummary as ApiProductCardSummary,
  ProductCardSupplierImage as ApiProductCardSupplierImage,
};

export interface ApiProductCardListQuery {
  status?: ProductCardStatus | "all";
  keyword?: string;
  limit?: number;
  offset?: number;
}

export interface ApiProductCardListResult {
  items: ProductCardSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface ApiProductCardNewImagePayload {
  filename: string;
  mimeType: string;
  bytesBase64: string;
}

export type ApiProductCardUpdateImagePayload =
  | { imageId: string }
  | ApiProductCardNewImagePayload;

export interface ApiCreateProductCardPayload extends ProductCardFields {
  sourceSessionId?: string | null;
  supplierImages?: ApiProductCardNewImagePayload[];
}

export interface ApiUpdateProductCardPayload extends Partial<ProductCardFields> {
  supplierImages?: ApiProductCardUpdateImagePayload[];
}

const productCardsPath = "/api/product-cards";
const productCardItemPath = (id: string) => `${productCardsPath}/${encodeURIComponent(id)}`;

export const productCardsApi = {
  list(query: ApiProductCardListQuery = {}) {
    const search = new URLSearchParams();
    if (query.status) search.set("status", query.status);
    if (query.keyword?.trim()) search.set("keyword", query.keyword.trim());
    if (query.limit !== undefined) search.set("limit", String(query.limit));
    if (query.offset !== undefined) search.set("offset", String(query.offset));
    const qs = search.toString();
    return getJson<ApiProductCardListResult>(qs ? `${productCardsPath}?${qs}` : productCardsPath);
  },
  get(id: string) {
    return getJson<ProductCard>(productCardItemPath(id));
  },
  create(payload: ApiCreateProductCardPayload) {
    return postJson<ProductCard>(productCardsPath, payload, { idempotent: true });
  },
  update(id: string, payload: ApiUpdateProductCardPayload) {
    return patchJson<ProductCard>(productCardItemPath(id), payload, { idempotent: true });
  },
  archive(id: string) {
    return postJson<ProductCard>(`${productCardItemPath(id)}/archive`, {}, { idempotent: true });
  },
  restore(id: string) {
    return postJson<ProductCard>(`${productCardItemPath(id)}/restore`, {}, { idempotent: true });
  },
  delete(id: string) {
    return deleteJson<{ id: string }>(productCardItemPath(id));
  },
};
