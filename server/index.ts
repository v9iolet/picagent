import { PostgresListingRepository } from "./repositories/postgres-listing-copy-repository.js";
import http from "node:http";
import { resolve } from "node:path";
import { Client as MinioClient } from "minio";
import { Pool } from "pg";
import { createSuiteStudioApp, type AppResponse } from "./app.js";
import { AuthService } from "./auth/auth-service.js";
import { PostgresAuthRepository } from "./repositories/postgres-auth-repository.js";
import { publicAuthRoute } from "./routes/auth-routes.js";
import { loadServerConfig } from "./config.js";
import { runMigrations } from "./migrations.js";
import { dispatchInputImageUpload } from "./multipart.js";
import { readBoundedRequestBody } from "./request-body-limit.js";
import { createStaticAssetHandler } from "./http/static-assets.js";
import { dispatchJsonRequest } from "./http/json-request.js";
import { GptImageProvider } from "./providers/gpt-image-provider.js";
import { ModelSettings, PostgresModelSettingsRepository } from "./model-settings.js";
import { defaultImageOptions } from "../shared/model-settings.js";
import { requestImageEditorEdit, supportedImageEditorOutpaintRatios } from "./providers/image-editor-provider.js";
import { PostgresPlanRepository } from "./repositories/postgres-plan-repository.js";
import { PostgresCategoryPromptRepository } from "./repositories/postgres-category-prompt-repository.js";
import { PostgresPlatformRepository } from "./repositories/postgres-platform-repository.js";
import { PostgresRagClient } from "./repositories/postgres-rag-client.js";
import { PostgresSuiteRepository } from "./repositories/postgres-suite-repository.js";
import { PostgresTaskRepository } from "./repositories/postgres-task-repository.js";
import { PostgresPromptRepository } from "./repositories/postgres-prompt-repository.js";
import { PostgresLibraryRepository } from "./repositories/postgres-library-repository.js";
import { PostgresReverseRepository } from "./repositories/postgres-reverse-repository.js";
import { PostgresPipelineRepository } from "./repositories/postgres-pipeline-repository.js";
import { PostgresProductCardRepository } from "./repositories/postgres-product-card-repository.js";
import { PostgresProductOnboardingRepository } from "./product-onboarding/index.js";
import { PostgresReplicaRepository } from "./repositories/postgres-replica-repository.js";
import { MinioStorage } from "./storage/minio-storage.js";
import { ImageEditorService, type ImageEditProvider, type ImageSource } from "./image-editor.js";
import { createImageEditorApi } from "./image-editor-api.js";
import { PostgresImageEditorRepository } from "./repositories/postgres-image-editor-repository.js";
import { DashScopeOcrProvider } from "./providers/dashscope-ocr-provider.js";
import sharp from "sharp";
import { initializeObservability, shutdownObservability } from "./observability.js";

const config = loadServerConfig();
initializeObservability();
const pool = new Pool({ ...config.postgres, max: Math.max(6, Number(process.env.PG_POOL_MAX) || 16), connectionTimeoutMillis: 30_000, idleTimeoutMillis: 60_000 });
const minio = new MinioClient(config.minio);
await runMigrations(pool, { recoverStaleAttempts: true });
const authService = new AuthService(new PostgresAuthRepository(pool));
await authService.ensureDefaultAdmin();
try {
  if (!(await minio.bucketExists(config.minio.bucket))) await minio.makeBucket(config.minio.bucket, config.minio.region);
} catch {
  console.warn("MinIO bucket readiness check failed; ask an administrator to create the configured bucket or grant bucket permissions.");
}
const storage = new MinioStorage(minio, config.minio.bucket, 300, config.minio.legacyBucket);
const modelSettings = new ModelSettings(new PostgresModelSettingsRepository(pool));
const resolveOcrProvider = async () => {
  const selected = await modelSettings.resolve("vision");
  return selected ? new DashScopeOcrProvider(selected.baseUrl, selected.apiKey, selected.model, 300_000, selected.source) : null;
};
const resolveImageEditorProvider = async (): Promise<ImageEditProvider | null> => {
  const selected = await modelSettings.resolve("image");
  if (!selected) return null;
  const imageProvider = new GptImageProvider(selected.baseUrl, selected.apiKey);
  const imageOptions = selected.imageOptions ?? defaultImageOptions(selected.model);
  return {
    name: "openai-compatible-image",
    version: selected.model,
    channel: selected.source,
    capabilitiesVersion: "v2",
    capabilities: () => ({
      imageToImage: process.env.IMAGE_EDITOR_IMAGE_TO_IMAGE !== "false",
      addText: process.env.IMAGE_EDITOR_ADD_TEXT !== "false",
      changeText: process.env.IMAGE_EDITOR_CHANGE_TEXT !== "false",
      redraw: process.env.IMAGE_EDITOR_REDRAW !== "false",
      erase: process.env.IMAGE_EDITOR_ERASE !== "false",
      outpaint: process.env.IMAGE_EDITOR_OUTPAINT !== "false",
      outpaintRatios: supportedImageEditorOutpaintRatios(imageOptions),
      currentVersionInput: process.env.IMAGE_EDITOR_CURRENT_VERSION !== "false",
    }),
    edit: (command, source) => requestImageEditorEdit(
      imageProvider, storage, selected.model, imageOptions, command, source,
    ),
  };
};
const taskRepository = new PostgresTaskRepository(pool);
const promptRepository = new PostgresPromptRepository(pool);
const imageEditorRepository = new PostgresImageEditorRepository(pool);
const resolveImageSource = async (versionId: string): Promise<ImageSource | null> => {
  const version = await imageEditorRepository.getSourceVersion(versionId);
  if (!version) return null;
  const object = await storage.get(version.objectKey);
  if (!object) return null;
  const { width, height } = await sharp(object.bytes).metadata();
  return { ...version, bytes: object.bytes, width, height };
};
const imageEditorApi = createImageEditorApi(new ImageEditorService(
  imageEditorRepository, resolveImageEditorProvider, storage, resolveImageSource, resolveOcrProvider,
  (sourceCardId, sourceVersionId) => imageEditorRepository.validateSource(sourceCardId, sourceVersionId),
  promptRepository,
  async (versionId) => (await imageEditorRepository.getSourceVersion(versionId))?.productInputs ?? null,
));
const app = createSuiteStudioApp({
  authService,
  repository: new PostgresSuiteRepository(pool),
  storage,
  modelSettings,
  promptRepository,
  platformRepository: new PostgresPlatformRepository(pool),
  planRepository: new PostgresPlanRepository(pool),
  categoryPromptRepository: new PostgresCategoryPromptRepository(pool),
  taskRepository,
  listingRepository: new PostgresListingRepository(pool),
  pipelineRepository: new PostgresPipelineRepository(pool),
  productCardRepository: new PostgresProductCardRepository(pool),
  productOnboardingRepository: new PostgresProductOnboardingRepository(pool),
  replicaRepository: new PostgresReplicaRepository(pool),
  imageEditorApi,
  libraryRepository: new PostgresLibraryRepository(pool),
  reverseRepository: new PostgresReverseRepository(pool),
  ragClient: new PostgresRagClient(pool),
});
const serveStatic = createStaticAssetHandler(resolve(process.cwd(), "dist"));

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
  const method = req.method ?? "GET";
  const headers = req.headers as Record<string, string>;
  if (publicAuthRoute(method, requestUrl.pathname)) {
    res.setHeader("cache-control", "no-store");
  } else if (requestUrl.pathname.startsWith("/api/")) {
    const denied = await app.authorize(headers);
    if (denied) {
      req.resume();
      writeResponse(res, denied);
      return;
    }
  }
  const body = await readBoundedRequestBody(req, res, requestUrl.pathname);
  if (body === null) return;
  let response: AppResponse;
  const upload = req.method === "POST" ? await dispatchInputImageUpload(app, requestUrl.pathname, body, headers) : null;
  if (upload) {
    response = upload;
  } else if (req.method === "GET" && !requestUrl.pathname.startsWith("/api/")) {
    const asset = await serveStatic(req.url ?? "/");
    if (asset) {
      res.statusCode = 200;
      res.setHeader("content-type", asset.contentType);
      res.setHeader("cache-control", asset.cacheControl);
      res.end(asset.bytes);
      return;
    }
    response = { status: 404, body: { error: { code: "NOT_FOUND", message: "请求不存在" }, requestId: "" } };
  } else {
    response = await dispatchJsonRequest(app.request, method, requestUrl, headers, body, {
      remoteAddress: req.socket.remoteAddress,
      encrypted: Boolean((req.socket as { encrypted?: boolean }).encrypted),
    });
  }
  writeResponse(res, response);
}

function writeResponse(res: http.ServerResponse, response: AppResponse) {
  res.statusCode = response.status;
  for (const [name, value] of Object.entries(response.headers ?? {})) res.setHeader(name, value);
  if (response.headers?.location) {
    res.end();
  } else if (response.raw) {
    res.setHeader("content-type", response.headers?.["content-type"] ?? "application/octet-stream");
    res.setHeader("cache-control", response.headers?.["cache-control"] ?? "private, max-age=60");
    res.end(response.raw);
  } else {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(response.body));
  }
}

const server = http.createServer((req, res) => {
  void handleRequest(req, res).catch((error) => {
    console.error("Unhandled API request error", error instanceof Error ? error.message : error);
    if (res.headersSent) { res.destroy(); return; }
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "服务暂时不可用，请重试" }, requestId: "" }));
  });
});

server.listen(config.port, process.env.HOST?.trim() || "127.0.0.1", () => console.log("PicAgent suite API connected to PostgreSQL and MinIO"));
async function shutdown() { server.close(); await shutdownObservability(); await pool.end(); }
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
