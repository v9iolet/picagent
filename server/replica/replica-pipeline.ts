import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { matchNearestAspectRatio, type ImageOptions } from "../../shared/model-settings.js";
import { readProductCardSnapshot, type ProductCardSnapshot } from "../../shared/product-card.js";
import { errorMessages, fail } from "../api-errors.js";
import { asRecord, dataOf, now, ok, type AppResponse } from "../api-response.js";
import { processImage, type ProcessedImage } from "../image.js";
import { resolvePublishedProductCardSnapshot } from "../product-cards-api.js";
import { waitUntil } from "../suite-pipeline.js";
import type {
  LibraryRepository,
  LlmClient,
  PipelineRepository,
  ProductCardRepository,
  PromptRepository,
  ReplicaCloneLevel,
  ReplicaLanguage,
  ReplicaProductImage,
  ReplicaReference,
  ReplicaRepository,
  ReplicaSceneType,
  StorageAdapter,
  SuitePipelineRun,
  SuiteRepository,
  SuiteTask,
  TaskRepository,
} from "../types.js";
import {
  analyzeReplicaPrompts,
  ReplicaPromptError,
  resolveReplicaPromptTemplate,
} from "./replica-prompt.js";

export const REPLICA_SCENE_TYPES = [
  "ecommerce_product",
  "apparel",
  "marketing_poster",
  "social_post",
  "other",
] as const;

export const REPLICA_SCENE_LABELS: Record<ReplicaSceneType, string> = {
  ecommerce_product: "电商商品图",
  apparel: "服饰电商图",
  marketing_poster: "营销海报",
  social_post: "社媒图文",
  other: "其他",
};

export const REPLICA_CLONE_LEVELS = ["compose", "high"] as const;
export const REPLICA_LANGUAGES = ["zh", "en"] as const;

export const REPLICA_MAX_REFERENCES = 6;
export const REPLICA_MAX_PRODUCTS = 6;
export const REPLICA_REMARK_MAX_LENGTH = 200;
export const REPLICA_UNIFIED_REQUIREMENT_MAX_LENGTH = 1000;
// 单张原图上限 12 MiB（与 server/image.ts 一致），Base64 编码长度为 ceil(12 MiB / 3) * 4 = 16 MiB 字符。
export const REPLICA_MAX_IMAGE_BYTES = 12 * 1024 * 1024;
export const REPLICA_MAX_BASE64_CHARS = Math.ceil(REPLICA_MAX_IMAGE_BYTES / 3) * 4;

export interface ReplicaBatchConfig {
  sceneType: ReplicaSceneType;
  cloneLevel: ReplicaCloneLevel;
  unifiedRequirement: string;
  productInfo: string;
  productCardId?: string | null;
  productCardSnapshot?: ProductCardSnapshot | null;
  styleUnified: boolean;
  language: ReplicaLanguage;
  ratio: string;
  size: string;
  hasProductImages: boolean;
  referenceCount: number;
  productImageCount: number;
  templateVersionId?: string | null;
  sharedStyle?: string | null;
}

class ReplicaPipelineError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message || errorMessages[code] || errorMessages.PIPELINE_FAILED);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function charCount(value: string): number {
  return Array.from(value).length;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatReplicaFallbackName(sceneType: ReplicaSceneType, date = new Date()): string {
  const label = REPLICA_SCENE_LABELS[sceneType] ?? "爆品图复刻";
  return `${label} · ${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function resolveReplicaCloneLevel(
  generationParams: Record<string, unknown> | null | undefined,
): ReplicaCloneLevel {
  const direct = generationParams?.cloneLevel;
  if (direct === "compose" || direct === "high") return direct;
  const snapshot = generationParams?.replicaPromptSnapshot;
  if (snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)) {
    const fromSnapshot = (snapshot as Record<string, unknown>).cloneLevel;
    if (fromSnapshot === "compose" || fromSnapshot === "high") return fromSnapshot;
  }
  return "high";
}

export function buildReplicaRolePrefix(
  productCount: number,
  cloneLevel: ReplicaCloneLevel = "high",
): string {
  if (cloneLevel === "compose") {
    if (productCount <= 0) {
      return "输入图仅用于理解姿势与构图类型，不得沿用其中的人物、服装、陈设、配色、光线、品牌与文字，按下方描述重新设计画面，生成同风格的通用示意商品，不得出现可识别品牌。";
    }
    if (productCount === 1) {
      return "第1张图为产品外观唯一依据，按下方描述重新设计画面。";
    }
    return `第1–${productCount}张图为产品外观唯一依据，按下方描述重新设计画面。`;
  }
  if (productCount <= 0) {
    return "输入图仅作为版式与风格参考，保持构图与元素位置，不得复制其中的品牌、文字与人物，请生成同风格的通用示意商品，不得出现可识别品牌。";
  }
  if (productCount === 1) {
    return "第1张图为产品外观唯一依据；第2张图为构图与版式基准：保持其构图、元素位置、镜头与光影，只替换为目标商品和新文案，不得复制其中的品牌、Logo、文字与真人肖像。";
  }
  return `第1–${productCount}张图为产品外观唯一依据；第${productCount + 1}张图为构图与版式基准：保持其构图、元素位置、镜头与光影，只替换为目标商品和新文案，不得复制其中的品牌、Logo、文字与真人肖像。`;
}

export function buildReplicaReferencePreviewUrl(
  suiteId: string,
  referenceId: string,
  kind: "thumbnail" | "original" = "thumbnail",
): string {
  const base = `/api/replicas/${suiteId}/references/${referenceId}/preview`;
  return kind === "original" ? `${base}?kind=original` : base;
}

function stageError(fallback: string, code: unknown, message: unknown) {
  const resolvedCode = typeof code === "string" && code.trim() ? code : fallback;
  return new ReplicaPipelineError(
    resolvedCode,
    typeof message === "string" && message.trim()
      ? message
      : errorMessages[resolvedCode] ?? errorMessages[fallback],
  );
}

function checkResponse(response: AppResponse, fallback: string) {
  if (response.status < 400) return;
  const error = "error" in response.body ? response.body.error : null;
  throw stageError(fallback, error?.code, error?.message);
}

async function toThumbnailBytes(bytes: Buffer, fallbackMimeType: string): Promise<{ bytes: Buffer; mimeType: string }> {
  try {
    const thumb = await sharp(bytes)
      .rotate()
      .resize({ width: 420, height: 280, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
    return { bytes: thumb, mimeType: "image/jpeg" };
  } catch {
    return { bytes, mimeType: fallbackMimeType };
  }
}

export interface ReplicaPipelineDependencies {
  repository: SuiteRepository;
  storage: StorageAdapter;
  replicaRepository: ReplicaRepository;
  pipelineRepository: PipelineRepository;
  productCardRepository?: ProductCardRepository;
  taskRepository?: TaskRepository;
  promptRepository?: PromptRepository;
  libraryRepository?: LibraryRepository;
  resolveVision(): Promise<LlmClient | undefined>;
  resolveImageOptions(): Promise<ImageOptions>;
  request(
    method: string,
    path: string,
    options?: { headers?: Record<string, string>; body?: unknown },
  ): Promise<AppResponse>;
}

type RetainedProcessedImage = Omit<ProcessedImage, "generationInput">;

interface ValidatedReferenceUpload {
  filename: string;
  remark: string;
  rawBytes: Buffer;
  processed: RetainedProcessedImage;
}

interface ValidatedProductInput {
  sourceKind: "upload";
  filename: string;
  rawBytes: Buffer;
  processed: RetainedProcessedImage;
}

export function createReplicaPipeline(deps: ReplicaPipelineDependencies) {
  const { pipelineRepository, replicaRepository, request } = deps;

  const executePipeline = async (run: SuitePipelineRun) => {
    const { suiteId } = run;
    const config = run.config as unknown as ReplicaBatchConfig;
    let activePhase = run.currentPhase;
    try {
      const taskRepository = deps.taskRepository;
      if (!taskRepository) throw new ReplicaPipelineError("TASK_REPOSITORY_NOT_CONFIGURED");
      const executionKey = `${run.idempotencyKey}:r${run.resumeCount ?? 0}`;
      const [references, products] = await Promise.all([
        replicaRepository.listReferences(suiteId),
        replicaRepository.listProductImages(suiteId),
      ]);
      if (!references.length) throw new ReplicaPipelineError("REPLICA_REFERENCES_REQUIRED");

      let taskRows: SuiteTask[] = (await taskRepository.listTasks(suiteId)).filter(
        (task) => task.status !== "archived" && task.originKind === "replica",
      );

      if (taskRows.length < references.length) {
        activePhase = "replica_analyzing";
        await pipelineRepository.updateRun(run.id, {
          currentPhase: "replica_analyzing",
          updatedAt: now(),
        });
        if (!deps.promptRepository) throw new ReplicaPipelineError("PROMPT_REPOSITORY_NOT_CONFIGURED");
        const llm = await deps.resolveVision();
        if (!llm) throw new ReplicaPipelineError("LLM_NOT_CONFIGURED");
        const template = await resolveReplicaPromptTemplate(deps.promptRepository, config.cloneLevel);
        if (!template) throw new ReplicaPipelineError("REPLICA_TEMPLATE_NOT_FOUND");

        const visionRefs = await Promise.all(
          references.map(async (ref) => {
            const stored =
              (await deps.storage.get(ref.thumbnailObjectKey)) ??
              (await deps.storage.get(ref.objectKey));
            if (!stored) throw new ReplicaPipelineError("INPUT_OBJECT_NOT_FOUND");
            return {
              referenceId: ref.id,
              ordinal: ref.ordinal,
              ...(ref.remark ? { requirement: ref.remark } : {}),
              mimeType: stored.contentType,
              bytes: stored.bytes,
            };
          }),
        );

        const visionProducts = await Promise.all(
          products.map(async (product) => {
            if (product.thumbnailObjectKey) {
              const thumb = await deps.storage.get(product.thumbnailObjectKey);
              if (thumb) {
                return {
                  id: product.id,
                  ordinal: product.ordinal,
                  mimeType: thumb.contentType,
                  bytes: thumb.bytes,
                };
              }
            }
            const stored = await deps.storage.get(product.objectKey);
            if (!stored) throw new ReplicaPipelineError("INPUT_OBJECT_NOT_FOUND");
            const thumb = await toThumbnailBytes(stored.bytes, stored.contentType);
            return {
              id: product.id,
              ordinal: product.ordinal,
              mimeType: thumb.mimeType,
              bytes: thumb.bytes,
            };
          }),
        );

        const productCardSnapshot = readProductCardSnapshot(config.productCardSnapshot);
        const analysis = await analyzeReplicaPrompts({
          requestId: run.id,
          llm,
          template,
          cloneLevel: config.cloneLevel,
          sceneType: REPLICA_SCENE_LABELS[config.sceneType] ?? config.sceneType,
          language: config.language === "en" ? "英文" : "中文",
          styleUnified: Boolean(config.styleUnified),
          unifiedRequirement: config.unifiedRequirement,
          productInfo: config.productInfo,
          productCardSnapshot,
          references: visionRefs,
          productImages: visionProducts,
        });

        const hasProductImages = products.length > 0;
        const modelTaskName = hasProductImages ? analysis.output.taskName.trim() : "";
        const resolvedTaskName = modelTaskName || productCardSnapshot?.name?.trim() || "";
        if (resolvedTaskName && deps.repository.renameSuite) {
          await deps.repository.renameSuite(suiteId, resolvedTaskName);
        }

        const imageOptions = await deps.resolveImageOptions();
        const itemByRefId = new Map(analysis.output.items.map((item) => [item.referenceId, item]));
        const taskItems = references.map((ref) => {
          const item = itemByRefId.get(ref.id)!;
          const effectiveRatio =
            config.ratio === "reference"
              ? matchNearestAspectRatio(ref.width, ref.height, imageOptions.aspectRatios)
              : config.ratio;
          return {
            referenceId: ref.id,
            referenceObjectKey: ref.objectKey,
            ordinal: ref.ordinal,
            title: `复刻图 ${ref.ordinal}`,
            purpose: `爆品图复刻（${config.cloneLevel === "compose" ? "参考风格" : "高度复刻"}）`,
            prompt: item.prompt,
            generationParams: {
              ratio: effectiveRatio,
              requestedRatio: config.ratio,
              size: config.size,
              quality: "medium",
              language: config.language,
              cloneLevel: config.cloneLevel,
              sceneType: config.sceneType,
              replicaPromptSnapshot: {
                prompt: item.prompt,
                templateVersionId: template.templateVersionId,
                sharedStyle: analysis.output.sharedStyle,
                copy: item.copy,
                visualStructure: item.visualStructure,
                cloneLevel: config.cloneLevel,
                sceneType: config.sceneType,
                language: config.language,
              },
            },
          };
        });

        const materialized = await taskRepository.createReplicaTasks({
          suiteId,
          globalStyleCard: analysis.output.sharedStyle ? { promptPrefix: analysis.output.sharedStyle } : {},
          items: taskItems,
        });
        taskRows = materialized.tasks.filter(
          (task) => task.status !== "archived" && task.originKind === "replica",
        );
        await pipelineRepository.updateRun(run.id, {
          taskIds: taskRows.map((task) => task.id),
          config: {
            ...run.config,
            templateVersionId: template.templateVersionId,
            sharedStyle: analysis.output.sharedStyle,
          },
          updatedAt: now(),
        });
      }

      if (!taskRows.length) throw new ReplicaPipelineError("TASK_MATERIALIZATION_FAILED");

      let batchId: string | undefined;
      if (run.currentPhase !== "done") {
        activePhase = "image_generating";
        await pipelineRepository.updateRun(run.id, {
          currentPhase: "image_generating",
          updatedAt: now(),
        });
        const pendingTasks: SuiteTask[] = [];
        for (const task of taskRows) {
          const history = await taskRepository.listTaskVersions(task.id);
          if (!history.versions.some((version) => version.isCurrent)) pendingTasks.push(task);
        }
        if (pendingTasks.length) {
          const generationResponse = await request("POST", `/api/suites/${suiteId}/generation`, {
            headers: { "idempotency-key": `${executionKey}:images` },
            body: { taskIds: pendingTasks.map((task) => task.id) },
          });
          checkResponse(generationResponse, "IMAGE_GENERATION_FAILED");
          const data = dataOf(generationResponse);
          if (!data || typeof data !== "object" || !("batchId" in data) || typeof data.batchId !== "string") {
            throw new ReplicaPipelineError("IMAGE_GENERATION_FAILED");
          }
          batchId = data.batchId;
          await waitUntil(
            () => taskRepository.getBatch(batchId!),
            (batch) => batch !== null && batch.status !== "running",
            600_000,
          );
        }
      }

      const histories = await Promise.all(taskRows.map((task) => taskRepository.listTaskVersions(task.id)));
      const missing = histories.filter((history) => !history.versions.some((version) => version.isCurrent));
      const generated = taskRows.length - missing.length;
      const status = generated === taskRows.length ? "completed" : generated > 0 ? "partial_failed" : "failed";
      let failure: ReplicaPipelineError | undefined;
      if (missing.length) {
        const batchSlots = batchId
          ? new Set((await taskRepository.listSlots(suiteId)).filter((slot) => slot.batchId === batchId).map((slot) => slot.id))
          : null;
        const failed = missing
          .map(({ attempts }) =>
            attempts
              .filter((attempt) => attempt.status === "failed" && (!batchSlots || batchSlots.has(attempt.slotId)))
              .at(-1),
          )
          .find(Boolean);
        failure = stageError("IMAGE_GENERATION_FAILED", failed?.errorCode, failed?.errorMessage);
      }
      const completedAt = now();
      await pipelineRepository.updateRun(run.id, {
        status,
        currentPhase: "done",
        errorCode: failure?.code ?? null,
        errorMessage: failure?.message ?? null,
        updatedAt: completedAt,
        completedAt,
      });
    } catch (error) {
      let failure: ReplicaPipelineError;
      if (error instanceof ReplicaPromptError) {
        failure = new ReplicaPipelineError(error.code, error.message);
      } else if (error instanceof ReplicaPipelineError) {
        failure = error;
      } else {
        const fallbackCode = activePhase === "replica_analyzing" ? "REPLICA_ANALYSIS_FAILED" : "PIPELINE_FAILED";
        const errCode = error instanceof Error ? error.message : undefined;
        failure = stageError(fallbackCode, errCode && errorMessages[errCode] ? errCode : fallbackCode, undefined);
      }
      await pipelineRepository.updateRun(run.id, {
        status: "failed",
        currentPhase: activePhase,
        errorCode: failure.code,
        errorMessage: failure.message,
        updatedAt: now(),
        completedAt: now(),
      });
    }
  };

  async function createReplica(idempotencyKey: string | undefined, payload: unknown): Promise<AppResponse> {
    if (!idempotencyKey?.trim()) return fail("MISSING_IDEMPOTENCY_KEY", 400);
    if (!deps.taskRepository) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);

    const body = asRecord(payload);

    // 1. Validate references (1..6, valid image, remark <= 200, unique sha256)
    if (!Array.isArray(body.references) || body.references.length === 0) {
      return fail("REPLICA_REFERENCES_REQUIRED", 400);
    }
    if (body.references.length > REPLICA_MAX_REFERENCES) {
      return fail("REPLICA_TOO_MANY_REFERENCES", 400);
    }

    const validatedRefs: ValidatedReferenceUpload[] = [];
    const seenSha256 = new Set<string>();
    for (const entry of body.references) {
      if (!isPlainObject(entry)) return fail("INVALID_INPUT_IMAGE", 400);
      const filename = typeof entry.filename === "string" ? entry.filename.trim() : "";
      const mimeType = typeof entry.mimeType === "string" ? entry.mimeType.trim() : "";
      const bytesBase64 = typeof entry.bytesBase64 === "string" ? entry.bytesBase64.trim() : "";
      if (!filename || !mimeType || !bytesBase64) return fail("INVALID_INPUT_IMAGE", 400);

      let remark = "";
      if (entry.remark !== undefined && entry.remark !== null) {
        if (typeof entry.remark !== "string") return fail("REPLICA_INVALID_OPTIONS", 400);
        remark = entry.remark.trim();
        if (charCount(remark) > REPLICA_REMARK_MAX_LENGTH) {
          return fail("REPLICA_REMARK_TOO_LONG", 400);
        }
      }

      if (bytesBase64.length > REPLICA_MAX_BASE64_CHARS) {
        return fail("IMAGE_TOO_LARGE", 400);
      }
      const rawBytes = Buffer.from(bytesBase64, "base64");
      let processed: RetainedProcessedImage;
      try {
        const { generationInput: _unused, ...retained } = await processImage(rawBytes, mimeType);
        processed = retained;
      } catch (error) {
        return fail(error instanceof Error ? error.message : "INVALID_IMAGE", 400);
      }
      if (seenSha256.has(processed.sha256)) {
        return fail("DUPLICATE_IMAGE", 409, "同一批次不能重复上传相同参考图");
      }
      seenSha256.add(processed.sha256);
      validatedRefs.push({ filename, remark, rawBytes, processed });
    }

    // 2. Validate products (0..6, local upload only)
    const rawProducts = body.products === undefined || body.products === null ? [] : body.products;
    if (!Array.isArray(rawProducts)) return fail("REPLICA_INVALID_PRODUCTS", 400);
    if (rawProducts.length > REPLICA_MAX_PRODUCTS) return fail("REPLICA_TOO_MANY_PRODUCTS", 400);

    const validatedProducts: ValidatedProductInput[] = [];
    for (const entry of rawProducts) {
      if (!isPlainObject(entry)) return fail("REPLICA_INVALID_PRODUCTS", 400);
      const hasLibraryId = entry.libraryResourceId !== undefined && entry.libraryResourceId !== null;
      if (hasLibraryId || entry.sourceKind === "library") {
        return fail("REPLICA_LIBRARY_PRODUCTS_UNSUPPORTED", 400);
      }
      if (entry.sourceKind !== undefined && entry.sourceKind !== "upload") {
        return fail("REPLICA_INVALID_PRODUCTS", 400);
      }
      const filename = typeof entry.filename === "string" ? entry.filename.trim() : "";
      const mimeType = typeof entry.mimeType === "string" ? entry.mimeType.trim() : "";
      const bytesBase64 = typeof entry.bytesBase64 === "string" ? entry.bytesBase64.trim() : "";
      if (!filename || !mimeType || !bytesBase64) return fail("REPLICA_INVALID_PRODUCTS", 400);
      if (bytesBase64.length > REPLICA_MAX_BASE64_CHARS) {
        return fail("IMAGE_TOO_LARGE", 400);
      }
      const rawBytes = Buffer.from(bytesBase64, "base64");
      let processed: RetainedProcessedImage;
      try {
        const { generationInput: _unused, ...retained } = await processImage(rawBytes, mimeType);
        processed = retained;
      } catch (error) {
        return fail(error instanceof Error ? error.message : "INVALID_IMAGE", 400);
      }
      validatedProducts.push({ sourceKind: "upload", filename, rawBytes, processed });
    }

    // 3. Validate sceneType, cloneLevel, text constraints, styleUnified, language, ratio, size
    const sceneType = body.sceneType;
    if (typeof sceneType !== "string" || !(REPLICA_SCENE_TYPES as readonly string[]).includes(sceneType)) {
      return fail("REPLICA_INVALID_SCENE_TYPE", 400);
    }
    const typedSceneType = sceneType as ReplicaSceneType;

    const cloneLevel = body.cloneLevel;
    if (typeof cloneLevel !== "string" || !(REPLICA_CLONE_LEVELS as readonly string[]).includes(cloneLevel)) {
      return fail("REPLICA_INVALID_CLONE_LEVEL", 400);
    }
    const typedCloneLevel = cloneLevel as ReplicaCloneLevel;

    let unifiedRequirement = "";
    if (body.unifiedRequirement !== undefined && body.unifiedRequirement !== null) {
      if (typeof body.unifiedRequirement !== "string") return fail("REPLICA_INVALID_REQUIREMENT", 400);
      unifiedRequirement = body.unifiedRequirement.trim();
      if (charCount(unifiedRequirement) > REPLICA_UNIFIED_REQUIREMENT_MAX_LENGTH) {
        return fail("REPLICA_REQUIREMENT_TOO_LONG", 400);
      }
    }

    let productInfo = "";
    if (body.productInfo !== undefined && body.productInfo !== null) {
      if (typeof body.productInfo !== "string") return fail("REPLICA_INVALID_PRODUCT_INFO", 400);
      productInfo = body.productInfo.trim();
    }

    let styleUnified: boolean;
    if (body.styleUnified === undefined) {
      styleUnified = validatedRefs.length >= 2;
    } else if (typeof body.styleUnified === "boolean") {
      styleUnified = body.styleUnified;
    } else {
      return fail("REPLICA_INVALID_OPTIONS", 400);
    }

    const rawLanguage = body.language === undefined ? "zh" : body.language;
    if (typeof rawLanguage !== "string" || !(REPLICA_LANGUAGES as readonly string[]).includes(rawLanguage)) {
      return fail("REPLICA_INVALID_LANGUAGE", 400);
    }
    const language = rawLanguage as ReplicaLanguage;

    const imageOptions = await deps.resolveImageOptions();
    const rawRatio = body.ratio === undefined ? "reference" : body.ratio;
    if (
      typeof rawRatio !== "string" ||
      (rawRatio !== "reference" && !imageOptions.aspectRatios.includes(rawRatio))
    ) {
      return fail("REPLICA_INVALID_RATIO", 400);
    }
    const ratio = rawRatio;

    const allowedSizes = imageOptions.sizes.filter((item) => item !== "4K");
    const defaultSize = allowedSizes.includes("1K") ? "1K" : (allowedSizes[0] ?? "1K");
    const rawSize = body.size === undefined ? defaultSize : body.size;
    if (typeof rawSize !== "string" || rawSize === "4K" || !allowedSizes.includes(rawSize)) {
      return fail("IMAGE_SIZE_UNSUPPORTED", 400);
    }
    const size = rawSize;

    const createdAt = now();
    const cardResult = await resolvePublishedProductCardSnapshot(
      body.productCardId,
      deps.productCardRepository,
      createdAt,
    );
    if (!cardResult.ok) return cardResult.response;
    const productCardSnapshot = cardResult.snapshot;

    // 4. Create (or idempotently retrieve) replica suite
    const fallbackName =
      productCardSnapshot?.name?.trim() ||
      formatReplicaFallbackName(typedSceneType, new Date(createdAt));
    const suite = await deps.repository.createSuite(fallbackName, `replica:${idempotencyKey}:suite`, "replica");

    const existingRun = (await pipelineRepository.listRuns(suite.id)).find(
      (item) => item.idempotencyKey === idempotencyKey,
    );
    if (existingRun) {
      return ok({ suiteId: suite.id, runId: existingRun.id }, 200);
    }

    // 5. Persist reference images & product images in storage + repository
    const existingRefs = await replicaRepository.listReferences(suite.id);
    if (!existingRefs.length) {
      const refRecords: ReplicaReference[] = [];
      for (const [index, ref] of validatedRefs.entries()) {
        const refId = randomUUID();
        const objectKey = `replicas/${suite.id}/references/${refId}/original`;
        const thumbnailObjectKey = `replicas/${suite.id}/references/${refId}/thumbnail`;
        await deps.storage.put({ key: objectKey, bytes: ref.rawBytes, contentType: ref.processed.mimeType });
        await deps.storage.put({ key: thumbnailObjectKey, bytes: ref.processed.thumbnail, contentType: "image/jpeg" });
        refRecords.push({
          id: refId,
          suiteId: suite.id,
          ordinal: index + 1,
          filename: ref.filename,
          mimeType: ref.processed.mimeType,
          sha256: ref.processed.sha256,
          width: ref.processed.width,
          height: ref.processed.height,
          objectKey,
          thumbnailObjectKey,
          remark: ref.remark ?? "",
          createdAt,
        });
      }
      await replicaRepository.saveReferences(suite.id, refRecords);
    }

    const existingProducts = await replicaRepository.listProductImages(suite.id);
    if (!existingProducts.length && validatedProducts.length > 0) {
      const productRecords: ReplicaProductImage[] = [];
      for (const [index, product] of validatedProducts.entries()) {
        const productId = randomUUID();
        const objectKey = `replicas/${suite.id}/products/${productId}/original`;
        const thumbnailObjectKey = `replicas/${suite.id}/products/${productId}/thumbnail`;
        await deps.storage.put({ key: objectKey, bytes: product.rawBytes, contentType: product.processed.mimeType });
        await deps.storage.put({ key: thumbnailObjectKey, bytes: product.processed.thumbnail, contentType: "image/jpeg" });
        productRecords.push({
          id: productId,
          suiteId: suite.id,
          ordinal: index + 1,
          sourceKind: "upload",
          objectKey,
          thumbnailObjectKey,
          filename: product.filename,
          mimeType: product.processed.mimeType,
          sha256: product.processed.sha256,
          width: product.processed.width,
          height: product.processed.height,
          libraryResourceId: null,
          resourceVersionId: null,
          createdAt,
        });
      }
      await replicaRepository.saveProductImages(suite.id, productRecords);
    }

    // 6. Persist pipeline run & launch async execution
    const batchConfig: ReplicaBatchConfig & Record<string, unknown> = {
      sceneType: typedSceneType,
      cloneLevel: typedCloneLevel,
      unifiedRequirement,
      productInfo,
      ...(productCardSnapshot
        ? {
            productCardId: productCardSnapshot.cardId,
            productCardSnapshot,
          }
        : {}),
      styleUnified,
      language,
      ratio,
      size,
      hasProductImages: validatedProducts.length > 0,
      referenceCount: validatedRefs.length,
      productImageCount: validatedProducts.length,
    };

    try {
      const { run, duplicate } = await pipelineRepository.createRun({
        id: randomUUID(),
        suiteId: suite.id,
        idempotencyKey,
        status: "running",
        currentPhase: "replica_analyzing",
        resumeCount: 0,
        lastResumeKey: null,
        resumeKeys: [],
        structureSnapshotId: null,
        taskIds: [],
        config: batchConfig,
        errorCode: null,
        errorMessage: null,
        createdAt,
        updatedAt: createdAt,
        completedAt: null,
      });
      if (!duplicate) void executePipeline(run);
      return ok({ suiteId: suite.id, runId: run.id }, duplicate ? 200 : 201);
    } catch (error) {
      if (error instanceof Error && error.message === "PIPELINE_ALREADY_RUNNING") {
        return fail(error.message, 409);
      }
      throw error;
    }
  }

  async function resumeReplica(suiteId: string, idempotencyKey?: string): Promise<AppResponse> {
    if (!deps.taskRepository) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);
    const suite = await deps.repository.getSuite(suiteId);
    if (!suite) return fail("INVALID_SUITE_ID", 404);
    if (suite.origin !== "replica") return fail("INVALID_SUITE_ORIGIN", 400);

    const current = await pipelineRepository.getLatestRun(suite.id);
    if (!current) return fail("PIPELINE_NOT_FOUND", 404);

    const explicitKey = idempotencyKey?.trim();
    const usedKey = (run: SuitePipelineRun) =>
      Boolean(explicitKey && (run.lastResumeKey === explicitKey || run.resumeKeys?.includes(explicitKey)));
    if (usedKey(current)) {
      return ok({ suiteId: suite.id, runId: current.id, pipeline: current }, 202);
    }
    if (current.status === "running") {
      return fail("PIPELINE_ALREADY_RUNNING", 409);
    }
    if (current.status !== "failed" && current.status !== "partial_failed") {
      return fail("PIPELINE_ACTION_NOT_ALLOWED", 409);
    }

    const activeTasks = (await deps.taskRepository.listTasks(suite.id)).filter(
      (task) => task.status !== "archived" && task.originKind === "replica",
    );
    const references = await replicaRepository.listReferences(suite.id);
    const nextPhase =
      current.currentPhase === "replica_analyzing" || activeTasks.length < references.length
        ? "replica_analyzing"
        : "image_generating";

    const resumeKey = explicitKey || `replica-resume-${randomUUID()}`;
    const updated = await pipelineRepository.resumeRun(current, resumeKey, nextPhase, current.config);
    if (!updated) {
      const latest = await pipelineRepository.getRun(current.id);
      if (latest && usedKey(latest)) {
        return ok({ suiteId: suite.id, runId: latest.id, pipeline: latest }, 202);
      }
      return fail("PIPELINE_ACTION_NOT_ALLOWED", 409);
    }
    void executePipeline(updated);
    return ok({ suiteId: suite.id, runId: updated.id, pipeline: updated }, 202);
  }

  async function previewReference(
    suiteId: string,
    referenceId: string,
    kind: "thumbnail" | "original" = "thumbnail",
  ): Promise<AppResponse> {
    const ref = await replicaRepository.getReference(suiteId, referenceId);
    if (!ref) return fail("REPLICA_REFERENCE_NOT_FOUND", 404);
    const key = kind === "original" ? ref.objectKey : ref.thumbnailObjectKey;
    const object = await deps.storage.get(key);
    if (!object) return fail("OBJECT_NOT_FOUND", 404);
    return {
      status: 200,
      body: { data: { contentType: object.contentType }, requestId: randomUUID() },
      headers: {
        "content-type": object.contentType,
        "cache-control": "private, max-age=60",
      },
      raw: object.bytes,
    };
  }

  async function saveReverseAsset(
    suiteId: string,
    taskId: string,
    payload?: unknown,
  ): Promise<AppResponse> {
    if (!deps.libraryRepository) return fail("LIBRARY_REPOSITORY_NOT_CONFIGURED", 503);
    if (!deps.taskRepository) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);
    const suite = await deps.repository.getSuite(suiteId);
    if (!suite) return fail("INVALID_SUITE_ID", 404);
    if (suite.origin !== "replica") return fail("INVALID_SUITE_ORIGIN", 400);

    const task = await deps.taskRepository.getTask(taskId);
    if (!task || task.suiteId !== suite.id || task.status === "archived" || task.originKind !== "replica") {
      return fail("INVALID_SUITE_TASK", 404);
    }

    const ref = task.replicaReferenceId
      ? await replicaRepository.getReference(suite.id, task.replicaReferenceId)
      : null;
    const objectKey = ref?.objectKey ?? task.replicaReferenceObjectKey ?? "";
    if (!objectKey) return fail("REPLICA_REFERENCE_NOT_FOUND", 404);
    const mimeType = ref?.mimeType ?? "image/png";

    const [history, run] = await Promise.all([
      deps.taskRepository.listTaskVersions(task.id),
      pipelineRepository.getLatestRun(suite.id),
    ]);
    const currentVersion =
      history.versions.find((version) => version.isFinal) ??
      history.versions.find((version) => version.isCurrent) ??
      history.versions[0] ??
      null;

    const versionSnapshot = asRecord(currentVersion?.promptSnapshot);
    const taskReplicaSnapshot = asRecord(task.generationParams?.replicaPromptSnapshot);
    const runConfig = asRecord(run?.config);

    const prompt = (
      task.promptDraft.trim() ||
      (typeof versionSnapshot.prompt === "string" ? versionSnapshot.prompt.trim() : "") ||
      (typeof taskReplicaSnapshot.prompt === "string" ? taskReplicaSnapshot.prompt.trim() : "")
    );
    if (!prompt) return fail("INVALID_REVERSE_REFERENCE_ASSET", 400);

    const sceneType =
      (typeof runConfig.sceneType === "string" && runConfig.sceneType in REPLICA_SCENE_LABELS
        ? (runConfig.sceneType as ReplicaSceneType)
        : typeof task.generationParams?.sceneType === "string" && task.generationParams.sceneType in REPLICA_SCENE_LABELS
          ? (task.generationParams.sceneType as ReplicaSceneType)
          : null);
    const cloneLevel =
      runConfig.cloneLevel === "compose" || runConfig.cloneLevel === "high"
        ? runConfig.cloneLevel
        : task.generationParams?.cloneLevel === "compose" || task.generationParams?.cloneLevel === "high"
          ? task.generationParams.cloneLevel
          : null;
    const templateVersionId =
      (typeof versionSnapshot.templateVersionId === "string" ? versionSnapshot.templateVersionId : null) ??
      (typeof taskReplicaSnapshot.templateVersionId === "string" ? taskReplicaSnapshot.templateVersionId : null) ??
      (typeof runConfig.templateVersionId === "string" ? runConfig.templateVersionId : null);

    const rawVisualStructure =
      versionSnapshot.visualStructure && typeof versionSnapshot.visualStructure === "object" && !Array.isArray(versionSnapshot.visualStructure)
        ? (versionSnapshot.visualStructure as Record<string, unknown>)
        : taskReplicaSnapshot.visualStructure && typeof taskReplicaSnapshot.visualStructure === "object" && !Array.isArray(taskReplicaSnapshot.visualStructure)
          ? (taskReplicaSnapshot.visualStructure as Record<string, unknown>)
          : {};

    const body = asRecord(payload);
    const customTitle = typeof body.title === "string" ? body.title.trim() : "";
    const title = customTitle || `${suite.name} · ${task.title}`;
    const sceneLabel = sceneType ? REPLICA_SCENE_LABELS[sceneType] : "爆品图复刻";
    const levelLabel = cloneLevel === "compose" ? "参考风格" : cloneLevel === "high" ? "高度复刻" : "";
    const summary = `${sceneLabel}${levelLabel ? ` · ${levelLabel}` : ""}反推资产，不作为商品事实`;

    const promptSnapshot: Record<string, unknown> = {
      prompt,
      promptRevision: task.promptRevision,
      ...(typeof versionSnapshot.finalPrompt === "string" ? { finalPrompt: versionSnapshot.finalPrompt } : {}),
      templateVersionId,
      sharedStyle: versionSnapshot.sharedStyle ?? taskReplicaSnapshot.sharedStyle ?? null,
      copy: Array.isArray(versionSnapshot.copy)
        ? versionSnapshot.copy
        : Array.isArray(taskReplicaSnapshot.copy)
          ? taskReplicaSnapshot.copy
          : [],
      visualStructure: rawVisualStructure,
      cloneLevel,
      sceneType,
      language: task.generationParams?.language ?? runConfig.language ?? null,
      versionId: currentVersion?.id ?? null,
      versionNumber: currentVersion?.versionNumber ?? null,
    };

    const source: Record<string, unknown> = {
      origin: "replica",
      replicaSuiteId: suite.id,
      suiteId: suite.id,
      taskId: task.id,
      replicaReferenceId: ref?.id ?? task.replicaReferenceId ?? null,
      referenceId: ref?.id ?? task.replicaReferenceId ?? null,
      ...(ref?.sha256 ? { sha256: ref.sha256 } : {}),
      ...(ref?.filename ? { filename: ref.filename } : {}),
      ...(templateVersionId ? { templateVersionId } : {}),
      ...(cloneLevel ? { cloneLevel } : {}),
      ...(sceneType ? { sceneType } : {}),
      ...(currentVersion?.id ? { imageVersionId: currentVersion.id } : {}),
    };

    const asset = await deps.libraryRepository.createReverseReferenceAsset({
      suiteId: suite.id,
      title,
      summary,
      objectKey,
      mimeType,
      promptSnapshot,
      visualStructure: {
        ...rawVisualStructure,
        ...(sceneType ? { sceneType } : {}),
        ...(cloneLevel ? { cloneLevel } : {}),
      },
      source,
    });
    return ok(asset, 201);
  }

  return { createReplica, resumeReplica, previewReference, saveReverseAsset };
}
