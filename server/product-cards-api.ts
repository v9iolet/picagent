import { randomUUID } from "node:crypto";
import {
  PRODUCT_CARD_ALL_FIELDS,
  PRODUCT_CARD_MAX_IMAGE_BASE64_CHARS,
  PRODUCT_CARD_MAX_SUPPLIER_IMAGES,
  PRODUCT_CARD_STATUSES,
  validateProductCardFields,
  type ProductCard,
  type ProductCardStatus,
  type ProductCardSupplierImage,
} from "../shared/product-card.js";
import { fail } from "./api-errors.js";
import { now, ok, type AppResponse } from "./api-response.js";
import { processImage, type ProcessedImage } from "./image.js";
import type {
  ProductCardRepository,
  StorageAdapter,
  StoredProductCardImage,
} from "./types.js";

const ROOT = "/api/product-cards";
const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const DATA_URL_RE = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,(.*)$/i;

type RetainedProcessedImage = Omit<ProcessedImage, "generationInput">;

interface PreparedNewUpload {
  kind: "new";
  filename: string;
  rawBytes: Buffer;
  processed: RetainedProcessedImage;
}

interface PreparedExistingImage {
  kind: "existing";
  image: ProductCardSupplierImage;
}

type PreparedImageEntry = PreparedNewUpload | PreparedExistingImage;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function parseNonNegativeInt(raw: string | null, fallback: number): number | null {
  if (raw === null || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) return null;
  const parsed = Number(raw.trim());
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseBase64Payload(entry: Record<string, unknown>): {
  filename: string;
  mimeType: string;
  base64: string;
} | null {
  const filename = typeof entry.filename === "string" ? entry.filename.trim() : "";
  const rawMime = typeof entry.mimeType === "string" ? entry.mimeType.trim().toLowerCase() : "";
  const rawBase64 = typeof entry.bytesBase64 === "string" ? entry.bytesBase64.trim() : "";
  if (!filename || !rawBase64) return null;

  const dataUrlMatch = DATA_URL_RE.exec(rawBase64);
  if (dataUrlMatch) {
    const inferredMime = dataUrlMatch[1].toLowerCase();
    const mimeType = rawMime || inferredMime;
    if (!mimeType) return null;
    return { filename, mimeType, base64: dataUrlMatch[2].trim() };
  }

  if (!rawMime) return null;
  return { filename, mimeType: rawMime, base64: rawBase64 };
}

async function decodeNewImageUpload(
  entry: Record<string, unknown>,
): Promise<{ ok: true; value: PreparedNewUpload } | { ok: false; response: AppResponse }> {
  const payload = parseBase64Payload(entry);
  if (!payload || !payload.base64) {
    return { ok: false, response: fail("PRODUCT_CARD_INVALID_IMAGES", 400) };
  }
  if (payload.base64.length > PRODUCT_CARD_MAX_IMAGE_BASE64_CHARS) {
    return { ok: false, response: fail("IMAGE_TOO_LARGE", 400) };
  }
  const rawBytes = Buffer.from(payload.base64, "base64");
  try {
    const { generationInput: _unused, ...processed } = await processImage(rawBytes, payload.mimeType);
    return {
      ok: true,
      value: {
        kind: "new",
        filename: payload.filename,
        rawBytes,
        processed,
      },
    };
  } catch (error) {
    const code = error instanceof Error ? error.message : "INVALID_IMAGE";
    return { ok: false, response: fail(code, 400) };
  }
}

export function createProductCardsApi(deps: {
  productCards: ProductCardRepository;
  storage: StorageAdapter;
}) {
  async function deleteCardStorageKeys(cardId: string, images: Array<{ originalObjectKey: string; thumbnailObjectKey: string }>) {
    const prefix = `product-cards/${cardId}/images/`;
    const keys = images
      .flatMap((image) => [image.originalObjectKey, image.thumbnailObjectKey])
      .filter((key) => key.startsWith(prefix));
    await Promise.all(keys.map((key) => deps.storage.delete(key).catch(() => undefined)));
  }

  async function persistPreparedImages(
    cardId: string,
    entries: PreparedImageEntry[],
    createdAt: string,
  ): Promise<{ finalImages: StoredProductCardImage[]; uploadedImages: StoredProductCardImage[] }> {
    const finalImages: StoredProductCardImage[] = [];
    const uploadedImages: StoredProductCardImage[] = [];

    try {
      for (const [index, entry] of entries.entries()) {
        const ordinal = index + 1;
        if (entry.kind === "existing") {
          finalImages.push({
            id: entry.image.id,
            productCardId: cardId,
            ordinal,
            originalObjectKey: entry.image.originalObjectKey,
            thumbnailObjectKey: entry.image.thumbnailObjectKey,
            sha256: entry.image.sha256,
            width: entry.image.width,
            height: entry.image.height,
            mimeType: entry.image.mimeType,
            originalFilename: entry.image.originalFilename,
            createdAt: entry.image.createdAt,
          });
          continue;
        }

        const imageId = randomUUID();
        const prefix = `product-cards/${cardId}/images/${imageId}`;
        const originalObjectKey = `${prefix}/original`;
        const thumbnailObjectKey = `${prefix}/thumbnail`;

        await deps.storage.put({
          key: originalObjectKey,
          bytes: entry.rawBytes,
          contentType: entry.processed.mimeType,
        });
        await deps.storage.put({
          key: thumbnailObjectKey,
          bytes: entry.processed.thumbnail,
          contentType: "image/jpeg",
        });

        const stored: StoredProductCardImage = {
          id: imageId,
          productCardId: cardId,
          ordinal,
          originalObjectKey,
          thumbnailObjectKey,
          sha256: entry.processed.sha256,
          width: entry.processed.width,
          height: entry.processed.height,
          mimeType: entry.processed.mimeType,
          originalFilename: entry.filename,
          createdAt,
        };
        uploadedImages.push(stored);
        finalImages.push(stored);
      }
      return { finalImages, uploadedImages };
    } catch (error) {
      await deleteCardStorageKeys(cardId, uploadedImages);
      throw error;
    }
  }

  async function handleList(url: URL): Promise<AppResponse> {
    const rawStatus = (url.searchParams.get("status") ?? "published").trim();
    if (
      rawStatus !== "all" &&
      !(PRODUCT_CARD_STATUSES as readonly string[]).includes(rawStatus)
    ) {
      return fail("PRODUCT_CARD_INVALID_STATUS", 400);
    }

    const limit = parseNonNegativeInt(url.searchParams.get("limit"), 24);
    const offset = parseNonNegativeInt(url.searchParams.get("offset"), 0);
    if (limit === null || limit < 1 || limit > 100 || offset === null || offset < 0) {
      return fail("INVALID_PAGINATION", 400);
    }

    const keyword = (url.searchParams.get("keyword") ?? "").trim();
    const result = await deps.productCards.list({
      status: rawStatus as ProductCardStatus | "all",
      keyword,
      limit,
      offset,
    });
    return ok(result);
  }

  async function handleGet(cardId: string): Promise<AppResponse> {
    if (!UUID_RE.test(cardId)) return fail("PRODUCT_CARD_NOT_FOUND", 404);
    const card = await deps.productCards.get(cardId);
    return card ? ok(card) : fail("PRODUCT_CARD_NOT_FOUND", 404);
  }

  async function handleCreate(body: unknown): Promise<AppResponse> {
    if (!isPlainObject(body)) {
      return fail("PRODUCT_CARD_VALIDATION_FAILED", 400, "商品信息卡请求体必须是对象");
    }

    const validation = validateProductCardFields(body);
    if (!validation.ok) {
      return fail(validation.code, 400, validation.message);
    }

    let sourceSessionId: string | null = null;
    if (body.sourceSessionId !== undefined && body.sourceSessionId !== null && body.sourceSessionId !== "") {
      if (typeof body.sourceSessionId !== "string" || !UUID_RE.test(body.sourceSessionId.trim())) {
        return fail("PRODUCT_CARD_VALIDATION_FAILED", 400, "来源建档会话 ID 无效");
      }
      sourceSessionId = body.sourceSessionId.trim();
    }

    const rawImages =
      body.supplierImages === undefined || body.supplierImages === null ? [] : body.supplierImages;
    if (!Array.isArray(rawImages)) {
      return fail("PRODUCT_CARD_INVALID_IMAGES", 400);
    }
    if (rawImages.length > PRODUCT_CARD_MAX_SUPPLIER_IMAGES) {
      return fail("PRODUCT_CARD_TOO_MANY_IMAGES", 400);
    }

    const dedupedEntries: PreparedNewUpload[] = [];
    const seenHashes = new Set<string>();
    for (const rawEntry of rawImages) {
      if (!isPlainObject(rawEntry)) {
        return fail("PRODUCT_CARD_INVALID_IMAGES", 400);
      }
      const decoded = await decodeNewImageUpload(rawEntry);
      if (!decoded.ok) return decoded.response;
      if (seenHashes.has(decoded.value.processed.sha256)) continue;
      seenHashes.add(decoded.value.processed.sha256);
      dedupedEntries.push(decoded.value);
    }

    const cardId = randomUUID();
    const timestamp = now();
    const { finalImages, uploadedImages } = await persistPreparedImages(
      cardId,
      dedupedEntries,
      timestamp,
    );

    try {
      const created = await deps.productCards.create({
        id: cardId,
        status: "published",
        fields: validation.value,
        sourceSessionId,
        revision: 1,
        images: finalImages,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      return ok(created, 201);
    } catch (error) {
      await deleteCardStorageKeys(cardId, uploadedImages);
      throw error;
    }
  }

  async function handleUpdate(cardId: string, body: unknown): Promise<AppResponse> {
    if (!UUID_RE.test(cardId)) return fail("PRODUCT_CARD_NOT_FOUND", 404);
    if (!isPlainObject(body)) {
      return fail("PRODUCT_CARD_VALIDATION_FAILED", 400, "商品信息卡请求体必须是对象");
    }

    const existing = await deps.productCards.get(cardId);
    if (!existing) return fail("PRODUCT_CARD_NOT_FOUND", 404);

    const mergedFieldInput: Record<string, unknown> = {};
    for (const key of PRODUCT_CARD_ALL_FIELDS) {
      mergedFieldInput[key] = key in body ? body[key] : existing[key];
    }

    const validation = validateProductCardFields(mergedFieldInput);
    if (!validation.ok) {
      return fail(validation.code, 400, validation.message);
    }

    const existingImageById = new Map<string, ProductCardSupplierImage>(
      existing.supplierImages.map((image) => [image.id, image]),
    );

    let preparedEntries: PreparedImageEntry[];
    if (body.supplierImages === undefined) {
      preparedEntries = existing.supplierImages.map((image) => ({ kind: "existing", image }));
    } else {
      if (!Array.isArray(body.supplierImages)) {
        return fail("PRODUCT_CARD_INVALID_IMAGES", 400);
      }
      if (body.supplierImages.length > PRODUCT_CARD_MAX_SUPPLIER_IMAGES) {
        return fail("PRODUCT_CARD_TOO_MANY_IMAGES", 400);
      }

      preparedEntries = [];
      const seenHashes = new Set<string>();

      for (const rawEntry of body.supplierImages) {
        if (!isPlainObject(rawEntry)) {
          return fail("PRODUCT_CARD_INVALID_IMAGES", 400);
        }

        const hasExistingRef = rawEntry.imageId !== undefined || rawEntry.id !== undefined;
        const hasNewBytes = rawEntry.bytesBase64 !== undefined && rawEntry.bytesBase64 !== null;

        if (hasExistingRef && hasNewBytes) {
          return fail("PRODUCT_CARD_INVALID_IMAGES", 400);
        }

        if (hasExistingRef) {
          const refId =
            typeof rawEntry.imageId === "string"
              ? rawEntry.imageId.trim()
              : typeof rawEntry.id === "string"
                ? rawEntry.id.trim()
                : "";
          if (!refId || !UUID_RE.test(refId)) {
            return fail("PRODUCT_CARD_IMAGE_NOT_FOUND", 400);
          }
          const matched = existingImageById.get(refId);
          if (!matched) {
            return fail("PRODUCT_CARD_IMAGE_NOT_FOUND", 400);
          }
          if (seenHashes.has(matched.sha256)) continue;
          seenHashes.add(matched.sha256);
          preparedEntries.push({ kind: "existing", image: matched });
        } else {
          const decoded = await decodeNewImageUpload(rawEntry);
          if (!decoded.ok) return decoded.response;
          if (seenHashes.has(decoded.value.processed.sha256)) continue;
          seenHashes.add(decoded.value.processed.sha256);
          preparedEntries.push(decoded.value);
        }
      }
    }

    const timestamp = now();
    const { finalImages, uploadedImages } = await persistPreparedImages(
      cardId,
      preparedEntries,
      timestamp,
    );

    let updated: ProductCard | null;
    try {
      updated = await deps.productCards.update(cardId, {
        fields: validation.value,
        images: finalImages,
        updatedAt: timestamp,
      });
    } catch (error) {
      await deleteCardStorageKeys(cardId, uploadedImages);
      throw error;
    }

    if (!updated) {
      await deleteCardStorageKeys(cardId, uploadedImages);
      return fail("PRODUCT_CARD_NOT_FOUND", 404);
    }

    const keptIds = new Set(finalImages.map((image) => image.id));
    const removedImages = existing.supplierImages.filter((image) => !keptIds.has(image.id));
    if (removedImages.length > 0) {
      await deleteCardStorageKeys(cardId, removedImages);
    }

    return ok(updated);
  }

  async function handleSetStatus(cardId: string, status: ProductCardStatus): Promise<AppResponse> {
    if (!UUID_RE.test(cardId)) return fail("PRODUCT_CARD_NOT_FOUND", 404);
    const updated = await deps.productCards.setStatus(cardId, status, now());
    return updated ? ok(updated) : fail("PRODUCT_CARD_NOT_FOUND", 404);
  }

  async function handleDelete(cardId: string): Promise<AppResponse> {
    if (!UUID_RE.test(cardId)) return fail("PRODUCT_CARD_NOT_FOUND", 404);
    const deleted = await deps.productCards.delete(cardId);
    if (!deleted) return fail("PRODUCT_CARD_NOT_FOUND", 404);
    await deleteCardStorageKeys(cardId, deleted.supplierImages);
    return ok({ id: cardId });
  }

  async function handlePreviewImage(
    cardId: string,
    imageId: string,
    variant: "original" | "thumbnail",
  ): Promise<AppResponse> {
    if (!UUID_RE.test(cardId) || !UUID_RE.test(imageId)) {
      return fail("PRODUCT_CARD_IMAGE_NOT_FOUND", 404);
    }
    const image = await deps.productCards.getImage(cardId, imageId);
    if (!image) return fail("PRODUCT_CARD_IMAGE_NOT_FOUND", 404);

    const key = variant === "original" ? image.originalObjectKey : image.thumbnailObjectKey;
    const object = await deps.storage.get(key);
    if (!object) return fail("INPUT_OBJECT_NOT_FOUND", 404);

    return {
      ...ok(null),
      raw: object.bytes,
      headers: {
        "content-type": object.contentType,
        "cache-control": "private, max-age=60",
      },
    };
  }

  async function request(method: string, path: string, body?: unknown): Promise<AppResponse> {
    const url = new URL(path, "http://localhost");
    const pathname = url.pathname;

    if (pathname === ROOT) {
      if (method === "GET") return handleList(url);
      if (method === "POST") return handleCreate(body);
      return fail("NOT_FOUND", 404);
    }

    if (!pathname.startsWith(`${ROOT}/`)) {
      return fail("NOT_FOUND", 404);
    }

    const segments = pathname.slice(ROOT.length + 1).split("/");
    if (segments.some((segment) => segment.length === 0)) {
      return fail("NOT_FOUND", 404);
    }

    if (segments.length === 1) {
      const [cardId] = segments;
      if (method === "GET") return handleGet(cardId);
      if (method === "PATCH") return handleUpdate(cardId, body);
      if (method === "DELETE") return handleDelete(cardId);
      return fail("NOT_FOUND", 404);
    }

    if (segments.length === 2) {
      const [cardId, action] = segments;
      if (method === "POST" && action === "archive") return handleSetStatus(cardId, "archived");
      if (method === "POST" && action === "restore") return handleSetStatus(cardId, "published");
      return fail("NOT_FOUND", 404);
    }

    if (segments.length === 5) {
      const [cardId, segmentImages, imageId, segmentPreview, variant] = segments;
      if (
        method === "GET" &&
        segmentImages === "images" &&
        segmentPreview === "preview" &&
        (variant === "original" || variant === "thumbnail")
      ) {
        return handlePreviewImage(cardId, imageId, variant);
      }
    }

    return fail("NOT_FOUND", 404);
  }

  return { request };
}
