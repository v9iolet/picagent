import { randomUUID } from "node:crypto";
import {
  emptyProductCardFields,
  getMissingRequiredProductCardFields,
  PRODUCT_CARD_ALL_FIELDS,
  PRODUCT_CARD_FIELD_LABELS,
  PRODUCT_CARD_FIELD_LIMITS,
  PRODUCT_CARD_MAX_IMAGE_BASE64_CHARS,
  PRODUCT_CARD_REQUIRED_FIELDS,
  productCardCharLength,
  validateProductCardFields,
  type ProductCardFields,
} from "../../shared/product-card.js";
import {
  buildProductOnboardingImagePreviewUrl,
  PRODUCT_ONBOARDING_DEFAULT_TITLE,
  PRODUCT_ONBOARDING_MAX_MESSAGE_CHARS,
  PRODUCT_ONBOARDING_MAX_SUPPLIER_IMAGES,
  PRODUCT_ONBOARDING_MAX_TXT_FILE_BYTES,
  PRODUCT_ONBOARDING_MAX_TXT_FILES_PER_MESSAGE,
  PRODUCT_ONBOARDING_STATUSES,
  type ProductOnboardingAttachment,
  type ProductOnboardingDraftImage,
  type ProductOnboardingStatus,
  type ProductOnboardingTxtAttachment,
} from "../../shared/product-onboarding.js";
import { fail } from "../api-errors.js";
import { now, ok, type AppResponse } from "../api-response.js";
import { processImage, type ProcessedImage } from "../image.js";
import type {
  LlmClient,
  ProductCardRepository,
  ProductOnboardingLlmHistoryItem,
  ProductOnboardingLlmImage,
  PromptRepository,
  StorageAdapter,
  StoredProductCardImage,
} from "../types.js";
import {
  ProductOnboardingPromptError,
  resolveProductOnboardingTemplate,
  resolveSessionTitle,
  runProductOnboardingExtraction,
} from "./onboarding-prompt.js";
import type {
  ProductOnboardingRepository,
  StoredOnboardingDraftImage,
} from "./onboarding-repository.js";

const ROOT = "/api/product-onboarding/sessions";
const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const DATA_URL_RE = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,(.*)$/i;
const BASE64_BODY_RE = /^[A-Za-z0-9+/]+={0,2}$/;
// Reject NUL, disallowed C0 control chars (keeping \t, \n, \r), DEL, and Unicode replacement char.
const DISALLOWED_TEXT_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/;
const MAX_TXT_BASE64_CHARS = Math.ceil(PRODUCT_ONBOARDING_MAX_TXT_FILE_BYTES / 3) * 4 + 16;

type RetainedProcessedImage = Omit<ProcessedImage, "generationInput">;

interface PreparedNewDraftImage {
  kind: "new";
  filename: string;
  rawBytes: Buffer;
  processed: RetainedProcessedImage;
}

interface PreparedExistingDraftImage {
  kind: "existing";
  image: StoredOnboardingDraftImage;
}

type PreparedDraftImageEntry = PreparedNewDraftImage | PreparedExistingDraftImage;

function normalizeUuid(value: string): string | null {
  const trimmed = value.trim();
  return UUID_RE.test(trimmed) ? trimmed.toLowerCase() : null;
}

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

function parseImageUploadPayload(entry: Record<string, unknown>): {
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
): Promise<{ ok: true; value: PreparedNewDraftImage } | { ok: false; response: AppResponse }> {
  const payload = parseImageUploadPayload(entry);
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

export function validateAndDecodeTxtAttachments(
  rawList: unknown,
): { ok: true; value: ProductOnboardingTxtAttachment[] } | { ok: false; response: AppResponse } {
  if (rawList === undefined || rawList === null) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(rawList)) {
    return { ok: false, response: fail("PRODUCT_ONBOARDING_INVALID_TXT_FILE", 400) };
  }
  if (rawList.length > PRODUCT_ONBOARDING_MAX_TXT_FILES_PER_MESSAGE) {
    return { ok: false, response: fail("PRODUCT_ONBOARDING_TOO_MANY_TXT_FILES", 400) };
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const results: ProductOnboardingTxtAttachment[] = [];

  for (const entry of rawList) {
    if (!isPlainObject(entry)) {
      return { ok: false, response: fail("PRODUCT_ONBOARDING_INVALID_TXT_FILE", 400) };
    }
    const filename = typeof entry.filename === "string" ? entry.filename.trim() : "";
    if (!filename || !/\.txt$/i.test(filename)) {
      return {
        ok: false,
        response: fail("PRODUCT_ONBOARDING_INVALID_TXT_FILE", 400, "文本附件仅支持 .txt 文件"),
      };
    }

    let rawBytes: Buffer;
    if (typeof entry.bytesBase64 === "string") {
      const trimmed = entry.bytesBase64.trim();
      const dataUrlMatch = DATA_URL_RE.exec(trimmed);
      const base64Body = (dataUrlMatch ? dataUrlMatch[2] : trimmed).replace(/\s+/g, "");
      if (!base64Body) {
        return {
          ok: false,
          response: fail("PRODUCT_ONBOARDING_INVALID_TXT_FILE", 400, "文本附件不能为空"),
        };
      }
      if (base64Body.length > MAX_TXT_BASE64_CHARS) {
        return { ok: false, response: fail("PRODUCT_ONBOARDING_TXT_TOO_LARGE", 400) };
      }
      if (base64Body.length % 4 !== 0 || !BASE64_BODY_RE.test(base64Body)) {
        return { ok: false, response: fail("PRODUCT_ONBOARDING_INVALID_TXT_FILE", 400) };
      }
      rawBytes = Buffer.from(base64Body, "base64");
    } else if (typeof entry.content === "string") {
      rawBytes = Buffer.from(entry.content, "utf8");
    } else {
      return { ok: false, response: fail("PRODUCT_ONBOARDING_INVALID_TXT_FILE", 400) };
    }

    if (rawBytes.length === 0) {
      return {
        ok: false,
        response: fail("PRODUCT_ONBOARDING_INVALID_TXT_FILE", 400, "文本附件不能为空"),
      };
    }
    if (rawBytes.length > PRODUCT_ONBOARDING_MAX_TXT_FILE_BYTES) {
      return { ok: false, response: fail("PRODUCT_ONBOARDING_TXT_TOO_LARGE", 400) };
    }

    let decoded: string;
    try {
      decoded = decoder.decode(rawBytes);
    } catch {
      return { ok: false, response: fail("PRODUCT_ONBOARDING_TXT_INVALID_UTF8", 400) };
    }
    if (decoded.startsWith("\uFEFF")) {
      decoded = decoded.slice(1);
    }
    if (DISALLOWED_TEXT_CONTROL_RE.test(decoded)) {
      return { ok: false, response: fail("PRODUCT_ONBOARDING_TXT_INVALID_UTF8", 400) };
    }
    if (!decoded.trim()) {
      return {
        ok: false,
        response: fail("PRODUCT_ONBOARDING_INVALID_TXT_FILE", 400, "文本附件不能为空"),
      };
    }

    results.push({
      kind: "txt",
      filename,
      byteLength: rawBytes.length,
      charCount: productCardCharLength(decoded),
      content: decoded,
    });
  }

  return { ok: true, value: results };
}

function validateDraftPatchFields(
  current: ProductCardFields,
  patch: Record<string, unknown>,
): { ok: true; value: ProductCardFields } | { ok: false; response: AppResponse } {
  const next: ProductCardFields = {
    ...current,
    sellingPoints: [...current.sellingPoints],
  };

  for (const key of PRODUCT_CARD_ALL_FIELDS) {
    if (!(key in patch)) continue;
    const raw = patch[key];
    const label = PRODUCT_CARD_FIELD_LABELS[key];

    if (key === "sellingPoints") {
      if (raw === undefined || raw === null) {
        next.sellingPoints = [];
        continue;
      }
      if (!Array.isArray(raw)) {
        return {
          ok: false,
          response: fail("PRODUCT_CARD_VALIDATION_FAILED", 400, "核心卖点必须是字符串数组"),
        };
      }
      const spLimit = PRODUCT_CARD_FIELD_LIMITS.sellingPoints;
      const cleaned: string[] = [];
      for (const item of raw) {
        if (typeof item !== "string") {
          return {
            ok: false,
            response: fail("PRODUCT_CARD_VALIDATION_FAILED", 400, "每条核心卖点必须是文本"),
          };
        }
        const trimmed = item.trim();
        if (!trimmed) continue;
        if (productCardCharLength(trimmed) > spLimit.itemMax) {
          return {
            ok: false,
            response: fail(
              "PRODUCT_CARD_VALIDATION_FAILED",
              400,
              `单条核心卖点不能超过 ${spLimit.itemMax} 字`,
            ),
          };
        }
        cleaned.push(trimmed);
      }
      if (cleaned.length > spLimit.maxItems) {
        return {
          ok: false,
          response: fail(
            "PRODUCT_CARD_VALIDATION_FAILED",
            400,
            `核心卖点最多填写 ${spLimit.maxItems} 条`,
          ),
        };
      }
      next.sellingPoints = cleaned;
      continue;
    }

    const limit = PRODUCT_CARD_FIELD_LIMITS[key];
    if (raw === undefined || raw === null) {
      next[key] = "";
      continue;
    }
    if (typeof raw !== "string") {
      return {
        ok: false,
        response: fail("PRODUCT_CARD_VALIDATION_FAILED", 400, `${label}必须是文本`),
      };
    }
    const trimmed = raw.trim();
    if (productCardCharLength(trimmed) > limit.max) {
      return {
        ok: false,
        response: fail(
          "PRODUCT_CARD_VALIDATION_FAILED",
          400,
          `${label}不能超过 ${limit.max} 字`,
        ),
      };
    }
    next[key] = trimmed;
  }

  return { ok: true, value: next };
}

function toStoredDraftImage(image: ProductOnboardingDraftImage): StoredOnboardingDraftImage {
  return {
    id: image.id,
    ordinal: image.ordinal,
    originalObjectKey: image.originalObjectKey,
    thumbnailObjectKey: image.thumbnailObjectKey,
    sha256: image.sha256,
    width: image.width,
    height: image.height,
    mimeType: image.mimeType,
    originalFilename: image.originalFilename,
    createdAt: image.createdAt,
  };
}

function buildConversationHistory(
  messages: Array<{ role: "user" | "assistant"; content: string; attachments: ProductOnboardingAttachment[] }>,
): ProductOnboardingLlmHistoryItem[] {
  return messages.map((msg) => {
    const txtAttachments = msg.attachments
      .filter((att): att is ProductOnboardingTxtAttachment => att.kind === "txt")
      .map(({ filename, charCount, content }) => ({ filename, charCount, content }));
    const imageFilenames = msg.attachments
      .filter((att) => att.kind === "image")
      .map((att) => att.filename);
    return {
      role: msg.role,
      content: msg.content,
      ...(txtAttachments.length > 0 ? { txtAttachments } : {}),
      ...(imageFilenames.length > 0 ? { imageFilenames } : {}),
    };
  });
}

function mapLlmError(error: unknown): AppResponse {
  if (error instanceof ProductOnboardingPromptError) {
    const status = error.code === "PRODUCT_ONBOARDING_LLM_NOT_SUPPORTED" ? 503 : 502;
    return fail(error.code, status, error.details[0] ?? undefined);
  }
  const message = error instanceof Error ? error.message : "LLM_PROVIDER_FAILED";
  if (message === "LLM_NOT_CONFIGURED") return fail("LLM_NOT_CONFIGURED", 503);
  if (message === "LLM_TIMEOUT") return fail("LLM_TIMEOUT", 504);
  if (message === "LLM_INVALID_JSON_RESPONSE" || message === "LLM_EMPTY_RESPONSE") {
    return fail("PRODUCT_ONBOARDING_OUTPUT_INVALID", 502);
  }
  return fail("LLM_PROVIDER_FAILED", 502);
}

export function createProductOnboardingApi(deps: {
  sessions: ProductOnboardingRepository;
  productCards: ProductCardRepository;
  storage: StorageAdapter;
  prompts?: PromptRepository;
  resolveVision: () => Promise<LlmClient | undefined>;
}) {
  async function deleteSessionStorageKeys(
    sessionId: string,
    images: Array<{ originalObjectKey: string; thumbnailObjectKey: string }>,
  ): Promise<void> {
    const prefix = `product-onboarding/${sessionId}/images/`;
    const keys = images
      .flatMap((img) => [img.originalObjectKey, img.thumbnailObjectKey])
      .filter((key) => key.startsWith(prefix));
    await Promise.all(keys.map((key) => deps.storage.delete(key).catch(() => undefined)));
  }

  async function deleteCardStorageKeys(
    cardId: string,
    images: Array<{ originalObjectKey: string; thumbnailObjectKey: string }>,
  ): Promise<void> {
    const prefix = `product-cards/${cardId}/images/`;
    const keys = images
      .flatMap((img) => [img.originalObjectKey, img.thumbnailObjectKey])
      .filter((key) => key.startsWith(prefix));
    await Promise.all(keys.map((key) => deps.storage.delete(key).catch(() => undefined)));
  }

  async function persistPreparedDraftImages(
    sessionId: string,
    entries: PreparedDraftImageEntry[],
    createdAt: string,
  ): Promise<{
    finalImages: StoredOnboardingDraftImage[];
    uploadedImages: StoredOnboardingDraftImage[];
  }> {
    const finalImages: StoredOnboardingDraftImage[] = [];
    const uploadedImages: StoredOnboardingDraftImage[] = [];

    try {
      for (const [index, entry] of entries.entries()) {
        const ordinal = index + 1;
        if (entry.kind === "existing") {
          finalImages.push({
            ...entry.image,
            ordinal,
          });
          continue;
        }

        const imageId = randomUUID();
        const prefix = `product-onboarding/${sessionId}/images/${imageId}`;
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

        const stored: StoredOnboardingDraftImage = {
          id: imageId,
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
      await deleteSessionStorageKeys(sessionId, uploadedImages);
      throw error;
    }
  }

  async function loadThumbnailsForLlm(
    images: StoredOnboardingDraftImage[],
  ): Promise<ProductOnboardingLlmImage[]> {
    const loaded: ProductOnboardingLlmImage[] = [];
    for (const image of [...images].sort((a, b) => a.ordinal - b.ordinal)) {
      const thumb =
        (await deps.storage.get(image.thumbnailObjectKey).catch(() => null)) ??
        (await deps.storage.get(image.originalObjectKey).catch(() => null));
      if (!thumb) continue;
      loaded.push({
        id: image.id,
        ordinal: image.ordinal,
        filename: image.originalFilename,
        mimeType: thumb.contentType,
        bytes: thumb.bytes,
      });
    }
    return loaded;
  }

  async function parseTurnPayload(
    body: unknown,
    existingImages: StoredOnboardingDraftImage[],
  ): Promise<
    | {
        ok: true;
        value: {
          message: string;
          explicitTitle?: string;
          txtAttachments: ProductOnboardingTxtAttachment[];
          preparedEntries: PreparedDraftImageEntry[];
          turnImageRefs: Array<{ sha256: string; filename: string; mimeType: string }>;
          hasNewImages: boolean;
        };
      }
    | { ok: false; response: AppResponse }
  > {
    if (!isPlainObject(body)) {
      return {
        ok: false,
        response: fail("PRODUCT_ONBOARDING_EMPTY_MESSAGE", 400),
      };
    }

    const rawMessage = body.message !== undefined ? body.message : body.content;
    let message = "";
    if (rawMessage !== undefined && rawMessage !== null) {
      if (typeof rawMessage !== "string") {
        return {
          ok: false,
          response: fail("PRODUCT_ONBOARDING_EMPTY_MESSAGE", 400, "消息内容必须是文本"),
        };
      }
      message = rawMessage.trim();
      if (productCardCharLength(message) > PRODUCT_ONBOARDING_MAX_MESSAGE_CHARS) {
        return { ok: false, response: fail("PRODUCT_ONBOARDING_MESSAGE_TOO_LONG", 400) };
      }
    }

    const explicitTitle =
      typeof body.title === "string" && body.title.trim() ? body.title.trim() : undefined;

    const rawTxtFiles = body.txtFiles !== undefined ? body.txtFiles : body.textFiles;
    const txtDecoded = validateAndDecodeTxtAttachments(rawTxtFiles);
    if (!txtDecoded.ok) return txtDecoded;

    const rawImages =
      body.supplierImages !== undefined
        ? body.supplierImages
        : body.images !== undefined
          ? body.images
          : [];
    if (rawImages !== null && !Array.isArray(rawImages)) {
      return { ok: false, response: fail("PRODUCT_CARD_INVALID_IMAGES", 400) };
    }
    const uploadedList = Array.isArray(rawImages) ? rawImages : [];

    if (!message && txtDecoded.value.length === 0 && uploadedList.length === 0) {
      return { ok: false, response: fail("PRODUCT_ONBOARDING_EMPTY_MESSAGE", 400) };
    }

    const preparedEntries: PreparedDraftImageEntry[] = existingImages.map((image) => ({
      kind: "existing",
      image,
    }));
    const seenHashes = new Set<string>(existingImages.map((image) => image.sha256));
    const turnImageRefs: Array<{ sha256: string; filename: string; mimeType: string }> = [];
    let hasNewImages = false;

    for (const rawEntry of uploadedList) {
      if (!isPlainObject(rawEntry)) {
        return { ok: false, response: fail("PRODUCT_CARD_INVALID_IMAGES", 400) };
      }
      const decoded = await decodeNewImageUpload(rawEntry);
      if (!decoded.ok) return decoded;
      turnImageRefs.push({
        sha256: decoded.value.processed.sha256,
        filename: decoded.value.filename,
        mimeType: decoded.value.processed.mimeType,
      });
      if (seenHashes.has(decoded.value.processed.sha256)) {
        continue;
      }
      if (preparedEntries.length >= PRODUCT_ONBOARDING_MAX_SUPPLIER_IMAGES) {
        return { ok: false, response: fail("PRODUCT_ONBOARDING_TOO_MANY_IMAGES", 400) };
      }
      seenHashes.add(decoded.value.processed.sha256);
      preparedEntries.push(decoded.value);
      hasNewImages = true;
    }

    return {
      ok: true,
      value: {
        message,
        explicitTitle,
        txtAttachments: txtDecoded.value,
        preparedEntries,
        turnImageRefs,
        hasNewImages,
      },
    };
  }

  function buildTurnAttachments(
    sessionId: string,
    txtAttachments: ProductOnboardingTxtAttachment[],
    turnImageRefs: Array<{ sha256: string; filename: string; mimeType: string }>,
    finalImages: StoredOnboardingDraftImage[],
  ): ProductOnboardingAttachment[] {
    const byHash = new Map(finalImages.map((img) => [img.sha256, img]));
    const attachments: ProductOnboardingAttachment[] = [...txtAttachments];
    const seenRefIds = new Set<string>();
    for (const ref of turnImageRefs) {
      const matched = byHash.get(ref.sha256);
      if (!matched || seenRefIds.has(matched.id)) continue;
      seenRefIds.add(matched.id);
      attachments.push({
        kind: "image",
        imageId: matched.id,
        filename: matched.originalFilename,
        mimeType: matched.mimeType,
        thumbnailPreviewUrl: buildProductOnboardingImagePreviewUrl(
          sessionId,
          matched.id,
          "thumbnail",
        ),
      });
    }
    return attachments;
  }

  async function handleList(url: URL): Promise<AppResponse> {
    const rawStatus = (url.searchParams.get("status") ?? "all").trim();
    if (
      rawStatus !== "all" &&
      !(PRODUCT_ONBOARDING_STATUSES as readonly string[]).includes(rawStatus)
    ) {
      return fail("PRODUCT_ONBOARDING_INVALID_STATUS", 400);
    }
    const limit = parseNonNegativeInt(url.searchParams.get("limit"), 20);
    const offset = parseNonNegativeInt(url.searchParams.get("offset"), 0);
    if (limit === null || limit < 1 || limit > 100 || offset === null || offset < 0) {
      return fail("INVALID_PAGINATION", 400);
    }
    const result = await deps.sessions.list({
      status: rawStatus as ProductOnboardingStatus | "all",
      limit,
      offset,
    });
    return ok(result);
  }

  async function handleGet(rawSessionId: string): Promise<AppResponse> {
    const sessionId = normalizeUuid(rawSessionId);
    if (!sessionId) return fail("PRODUCT_ONBOARDING_SESSION_NOT_FOUND", 404);
    const session = await deps.sessions.get(sessionId);
    return session ? ok(session) : fail("PRODUCT_ONBOARDING_SESSION_NOT_FOUND", 404);
  }

  async function handleCreateSession(body: unknown): Promise<AppResponse> {
    const parsedTurn = await parseTurnPayload(body, []);
    if (!parsedTurn.ok) return parsedTurn.response;

    const llm = await deps.resolveVision();
    if (!llm) return fail("LLM_NOT_CONFIGURED", 503);
    if (!llm.generateProductOnboarding) {
      return fail("PRODUCT_ONBOARDING_LLM_NOT_SUPPORTED", 503);
    }

    const template = deps.prompts
      ? await resolveProductOnboardingTemplate(deps.prompts)
      : null;
    if (!template) return fail("PRODUCT_ONBOARDING_TEMPLATE_NOT_FOUND", 503);

    const sessionId = randomUUID();
    const createdAt = now();
    const { finalImages, uploadedImages } = await persistPreparedDraftImages(
      sessionId,
      parsedTurn.value.preparedEntries,
      createdAt,
    );

    try {
      const llmImages = await loadThumbnailsForLlm(finalImages);
      const initialDraft = emptyProductCardFields();
      const extraction = await runProductOnboardingExtraction({
        requestId: randomUUID(),
        llm,
        template,
        currentDraftCard: initialDraft,
        missingRequiredFields: getMissingRequiredProductCardFields(initialDraft),
        conversationHistory: [],
        latestUserMessage: parsedTurn.value.message,
        txtAttachments: parsedTurn.value.txtAttachments.map(
          ({ filename, byteLength, charCount, content }) => ({
            filename,
            byteLength,
            charCount,
            content,
          }),
        ),
        supplierImages: llmImages,
        hasNewImages: parsedTurn.value.hasNewImages,
      });

      const title = resolveSessionTitle(
        PRODUCT_ONBOARDING_DEFAULT_TITLE,
        "",
        extraction.mergedDraftCard.name,
        parsedTurn.value.explicitTitle,
      );
      const replyTimestamp = now();
      const userAttachments = buildTurnAttachments(
        sessionId,
        parsedTurn.value.txtAttachments,
        parsedTurn.value.turnImageRefs,
        finalImages,
      );

      const session = await deps.sessions.createWithMessages({
        id: sessionId,
        title,
        draftCard: extraction.mergedDraftCard,
        draftImages: finalImages,
        missingRequiredFields: extraction.authoritativeMissingRequiredFields,
        messages: [
          {
            id: randomUUID(),
            role: "user",
            content: parsedTurn.value.message,
            attachments: userAttachments,
            templateVersionId: null,
            modelSnapshot: null,
            createdAt,
          },
          {
            id: randomUUID(),
            role: "assistant",
            content: extraction.reply,
            attachments: [],
            templateVersionId: template.templateVersionId,
            modelSnapshot: {
              provider: llm.provider,
              model: llm.model,
              isFake: llm.isFake,
              ...(llm.channel ? { channel: llm.channel } : {}),
            },
            createdAt: replyTimestamp,
          },
        ],
        createdAt,
        updatedAt: replyTimestamp,
      });
      return ok(session, 201);
    } catch (error) {
      await deleteSessionStorageKeys(sessionId, uploadedImages);
      return mapLlmError(error);
    }
  }

  async function handlePostMessage(rawSessionId: string, body: unknown): Promise<AppResponse> {
    const sessionId = normalizeUuid(rawSessionId);
    if (!sessionId) return fail("PRODUCT_ONBOARDING_SESSION_NOT_FOUND", 404);

    const existing = await deps.sessions.get(sessionId);
    if (!existing) return fail("PRODUCT_ONBOARDING_SESSION_NOT_FOUND", 404);
    if (existing.status === "completed") {
      return fail("PRODUCT_ONBOARDING_SESSION_COMPLETED", 409);
    }

    const existingStoredImages = existing.supplierImages.map(toStoredDraftImage);
    const parsedTurn = await parseTurnPayload(body, existingStoredImages);
    if (!parsedTurn.ok) return parsedTurn.response;

    const llm = await deps.resolveVision();
    if (!llm) return fail("LLM_NOT_CONFIGURED", 503);
    if (!llm.generateProductOnboarding) {
      return fail("PRODUCT_ONBOARDING_LLM_NOT_SUPPORTED", 503);
    }

    const template = deps.prompts
      ? await resolveProductOnboardingTemplate(deps.prompts)
      : null;
    if (!template) return fail("PRODUCT_ONBOARDING_TEMPLATE_NOT_FOUND", 503);

    const turnTimestamp = now();
    const { finalImages, uploadedImages } = await persistPreparedDraftImages(
      sessionId,
      parsedTurn.value.preparedEntries,
      turnTimestamp,
    );

    try {
      const llmImages = await loadThumbnailsForLlm(finalImages);
      const extraction = await runProductOnboardingExtraction({
        requestId: randomUUID(),
        llm,
        template,
        currentDraftCard: existing.draftCard,
        missingRequiredFields: existing.missingRequiredFields,
        conversationHistory: buildConversationHistory(existing.messages),
        latestUserMessage: parsedTurn.value.message,
        txtAttachments: parsedTurn.value.txtAttachments.map(
          ({ filename, byteLength, charCount, content }) => ({
            filename,
            byteLength,
            charCount,
            content,
          }),
        ),
        supplierImages: llmImages,
        hasNewImages: parsedTurn.value.hasNewImages,
      });

      const title = resolveSessionTitle(
        existing.title,
        existing.draftCard.name,
        extraction.mergedDraftCard.name,
        parsedTurn.value.explicitTitle,
      );
      const replyTimestamp = now();
      const userAttachments = buildTurnAttachments(
        sessionId,
        parsedTurn.value.txtAttachments,
        parsedTurn.value.turnImageRefs,
        finalImages,
      );

      const appended = await deps.sessions.appendTurn(sessionId, {
        title,
        draftCard: extraction.mergedDraftCard,
        draftImages: finalImages,
        missingRequiredFields: extraction.authoritativeMissingRequiredFields,
        messages: [
          {
            id: randomUUID(),
            role: "user",
            content: parsedTurn.value.message,
            attachments: userAttachments,
            templateVersionId: null,
            modelSnapshot: null,
            createdAt: turnTimestamp,
          },
          {
            id: randomUUID(),
            role: "assistant",
            content: extraction.reply,
            attachments: [],
            templateVersionId: template.templateVersionId,
            modelSnapshot: {
              provider: llm.provider,
              model: llm.model,
              isFake: llm.isFake,
              ...(llm.channel ? { channel: llm.channel } : {}),
            },
            createdAt: replyTimestamp,
          },
        ],
        updatedAt: replyTimestamp,
      });

      if (!appended) {
        await deleteSessionStorageKeys(sessionId, uploadedImages);
        return fail("PRODUCT_ONBOARDING_SESSION_NOT_FOUND", 404);
      }
      if ("conflict" in appended) {
        await deleteSessionStorageKeys(sessionId, uploadedImages);
        return fail("PRODUCT_ONBOARDING_SESSION_COMPLETED", 409);
      }

      return ok(appended.session);
    } catch (error) {
      await deleteSessionStorageKeys(sessionId, uploadedImages);
      return mapLlmError(error);
    }
  }

  async function handlePatchDraft(rawSessionId: string, body: unknown): Promise<AppResponse> {
    const sessionId = normalizeUuid(rawSessionId);
    if (!sessionId) return fail("PRODUCT_ONBOARDING_SESSION_NOT_FOUND", 404);
    if (!isPlainObject(body)) {
      return fail("PRODUCT_CARD_VALIDATION_FAILED", 400, "草稿更新请求体必须是对象");
    }

    const existing = await deps.sessions.get(sessionId);
    if (!existing) return fail("PRODUCT_ONBOARDING_SESSION_NOT_FOUND", 404);
    if (existing.status === "completed") {
      return fail("PRODUCT_ONBOARDING_SESSION_COMPLETED", 409);
    }

    let fieldPatch: Record<string, unknown> = {};
    if (body.draftCard !== undefined) {
      if (!isPlainObject(body.draftCard)) {
        return fail("PRODUCT_CARD_VALIDATION_FAILED", 400, "draftCard 必须是对象");
      }
      fieldPatch = body.draftCard;
    } else {
      for (const key of PRODUCT_CARD_ALL_FIELDS) {
        if (key in body) fieldPatch[key] = body[key];
      }
    }

    const validatedFields = validateDraftPatchFields(existing.draftCard, fieldPatch);
    if (!validatedFields.ok) return validatedFields.response;

    const existingStoredImages = existing.supplierImages.map(toStoredDraftImage);
    const existingImageById = new Map(existingStoredImages.map((image) => [image.id, image]));

    let preparedEntries: PreparedDraftImageEntry[];
    if (body.supplierImages === undefined) {
      preparedEntries = existingStoredImages.map((image) => ({ kind: "existing", image }));
    } else {
      if (!Array.isArray(body.supplierImages)) {
        return fail("PRODUCT_CARD_INVALID_IMAGES", 400);
      }
      if (body.supplierImages.length > PRODUCT_ONBOARDING_MAX_SUPPLIER_IMAGES) {
        return fail("PRODUCT_ONBOARDING_TOO_MANY_IMAGES", 400);
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
          const rawRefId =
            typeof rawEntry.imageId === "string"
              ? rawEntry.imageId
              : typeof rawEntry.id === "string"
                ? rawEntry.id
                : "";
          const refId = normalizeUuid(rawRefId);
          const matched = refId ? existingImageById.get(refId) : undefined;
          if (!matched) {
            return fail("PRODUCT_ONBOARDING_IMAGE_NOT_FOUND", 400);
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
    const { finalImages, uploadedImages } = await persistPreparedDraftImages(
      sessionId,
      preparedEntries,
      timestamp,
    );

    const explicitTitle =
      typeof body.title === "string" && body.title.trim() ? body.title.trim() : undefined;
    const nextTitle = resolveSessionTitle(
      existing.title,
      existing.draftCard.name,
      validatedFields.value.name,
      explicitTitle,
    );
    const missingRequiredFields = getMissingRequiredProductCardFields(validatedFields.value);

    let updated: Awaited<ReturnType<ProductOnboardingRepository["updateDraft"]>>;
    try {
      updated = await deps.sessions.updateDraft(sessionId, {
        title: nextTitle,
        draftCard: validatedFields.value,
        draftImages: finalImages,
        missingRequiredFields,
        updatedAt: timestamp,
      });
    } catch (error) {
      await deleteSessionStorageKeys(sessionId, uploadedImages);
      throw error;
    }

    if (!updated) {
      await deleteSessionStorageKeys(sessionId, uploadedImages);
      return fail("PRODUCT_ONBOARDING_SESSION_NOT_FOUND", 404);
    }
    if ("conflict" in updated) {
      await deleteSessionStorageKeys(sessionId, uploadedImages);
      return fail("PRODUCT_ONBOARDING_SESSION_COMPLETED", 409);
    }

    const keptIds = new Set(finalImages.map((image) => image.id));
    const removedImages = existingStoredImages.filter((image) => !keptIds.has(image.id));
    if (removedImages.length > 0) {
      await deleteSessionStorageKeys(sessionId, removedImages);
    }

    return ok(updated.session);
  }

  async function handlePublish(rawSessionId: string): Promise<AppResponse> {
    const sessionId = normalizeUuid(rawSessionId);
    if (!sessionId) return fail("PRODUCT_ONBOARDING_SESSION_NOT_FOUND", 404);

    const session = await deps.sessions.get(sessionId);
    if (!session) return fail("PRODUCT_ONBOARDING_SESSION_NOT_FOUND", 404);

    if (session.status === "completed") {
      const productCard = session.productCardId
        ? await deps.productCards.get(session.productCardId)
        : null;
      return ok({ session, productCard });
    }

    const validation = validateProductCardFields(session.draftCard);
    if (!validation.ok) {
      const missingSet = new Set(validation.missingFields);
      const orderedMissing = PRODUCT_CARD_REQUIRED_FIELDS.filter((field) => missingSet.has(field));
      return fail(validation.code, 400, validation.message, {
        missingFields: orderedMissing,
      });
    }

    const cardId = randomUUID();
    const timestamp = now();
    const migratedImages: StoredProductCardImage[] = [];

    try {
      const orderedDraftImages = [...session.supplierImages].sort((a, b) => a.ordinal - b.ordinal);
      for (const [index, draftImage] of orderedDraftImages.entries()) {
        const originalObj = await deps.storage.get(draftImage.originalObjectKey);
        const thumbnailObj = await deps.storage.get(draftImage.thumbnailObjectKey);
        if (!originalObj || !thumbnailObj) {
          await deleteCardStorageKeys(cardId, migratedImages);
          return fail("INPUT_OBJECT_NOT_FOUND", 404);
        }

        const newImageId = randomUUID();
        const prefix = `product-cards/${cardId}/images/${newImageId}`;
        const originalObjectKey = `${prefix}/original`;
        const thumbnailObjectKey = `${prefix}/thumbnail`;

        await deps.storage.put({
          key: originalObjectKey,
          bytes: originalObj.bytes,
          contentType: originalObj.contentType,
        });
        await deps.storage.put({
          key: thumbnailObjectKey,
          bytes: thumbnailObj.bytes,
          contentType: thumbnailObj.contentType,
        });

        migratedImages.push({
          id: newImageId,
          productCardId: cardId,
          ordinal: index + 1,
          originalObjectKey,
          thumbnailObjectKey,
          sha256: draftImage.sha256,
          width: draftImage.width,
          height: draftImage.height,
          mimeType: draftImage.mimeType,
          originalFilename: draftImage.originalFilename,
          createdAt: timestamp,
        });
      }

      const createdCard = await deps.productCards.create({
        id: cardId,
        status: "published",
        fields: validation.value,
        sourceSessionId: session.id,
        revision: 1,
        images: migratedImages,
        createdAt: timestamp,
        updatedAt: timestamp,
      });

      const completed = await deps.sessions.markCompleted(session.id, createdCard.id, timestamp);
      if (!completed) {
        await deps.productCards.delete(createdCard.id).catch(() => undefined);
        await deleteCardStorageKeys(cardId, migratedImages);
        return fail("PRODUCT_ONBOARDING_SESSION_NOT_FOUND", 404);
      }

      if (completed.alreadyCompleted) {
        // Another concurrent publish beat us: clean up the duplicate card and return the original.
        await deps.productCards.delete(createdCard.id).catch(() => undefined);
        await deleteCardStorageKeys(cardId, migratedImages);
        const existingCard = completed.session.productCardId
          ? await deps.productCards.get(completed.session.productCardId)
          : null;
        return ok({ session: completed.session, productCard: existingCard });
      }

      return ok({ session: completed.session, productCard: createdCard });
    } catch (error) {
      await deps.productCards.delete(cardId).catch(() => undefined);
      await deleteCardStorageKeys(cardId, migratedImages);
      throw error;
    }
  }

  async function handleDelete(rawSessionId: string): Promise<AppResponse> {
    const sessionId = normalizeUuid(rawSessionId);
    if (!sessionId) return fail("PRODUCT_ONBOARDING_SESSION_NOT_FOUND", 404);
    const deleted = await deps.sessions.delete(sessionId);
    if (!deleted) return fail("PRODUCT_ONBOARDING_SESSION_NOT_FOUND", 404);
    await deleteSessionStorageKeys(sessionId, deleted.supplierImages);
    return ok({ id: sessionId });
  }

  async function handlePreviewImage(
    rawSessionId: string,
    rawImageId: string,
    variant: "original" | "thumbnail",
  ): Promise<AppResponse> {
    const sessionId = normalizeUuid(rawSessionId);
    const imageId = normalizeUuid(rawImageId);
    if (!sessionId || !imageId) {
      return fail("PRODUCT_ONBOARDING_IMAGE_NOT_FOUND", 404);
    }
    const image = await deps.sessions.getDraftImage(sessionId, imageId);
    if (!image) return fail("PRODUCT_ONBOARDING_IMAGE_NOT_FOUND", 404);

    const key = variant === "original" ? image.originalObjectKey : image.thumbnailObjectKey;
    try {
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
    } catch (error) {
      const isNotFound = error instanceof Error && error.message === "OBJECT_NOT_FOUND";
      return fail(
        isNotFound ? "INPUT_OBJECT_NOT_FOUND" : "INPUT_OBJECT_READ_FAILED",
        isNotFound ? 404 : 502,
      );
    }
  }

  async function request(method: string, path: string, body?: unknown): Promise<AppResponse> {
    const url = new URL(path, "http://localhost");
    const pathname = url.pathname;

    if (pathname === ROOT) {
      if (method === "GET") return handleList(url);
      if (method === "POST") return handleCreateSession(body);
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
      const [sessionId] = segments;
      if (method === "GET") return handleGet(sessionId);
      if (method === "DELETE") return handleDelete(sessionId);
      return fail("NOT_FOUND", 404);
    }

    if (segments.length === 2) {
      const [sessionId, action] = segments;
      if (method === "POST" && action === "messages") return handlePostMessage(sessionId, body);
      if (method === "PATCH" && action === "draft") return handlePatchDraft(sessionId, body);
      if (method === "POST" && action === "publish") return handlePublish(sessionId);
      return fail("NOT_FOUND", 404);
    }

    if (segments.length === 5) {
      const [sessionId, segmentImages, imageId, segmentPreview, variant] = segments;
      if (
        method === "GET" &&
        segmentImages === "images" &&
        segmentPreview === "preview" &&
        (variant === "original" || variant === "thumbnail")
      ) {
        return handlePreviewImage(sessionId, imageId, variant);
      }
    }

    return fail("NOT_FOUND", 404);
  }

  return { request };
}
