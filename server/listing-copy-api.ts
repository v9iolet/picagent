import { isUuid } from "./http/validators.js";
import { LISTING_CONFIG_FIELDS, type ListingConfigInput } from "../shared/listing-config.js";
import {
  mergeProductCardFacts,
  readProductCardSnapshot,
  type ProductCardSnapshot,
} from "../shared/product-card.js";
import { randomUUID } from "node:crypto";
import { now, ok, type AppResponse } from "./api-response.js";
import { processImage } from "./image.js";
import {
  ListingError,
  normalizeListingModelOutput,
  validateContent,
  type ListingImage,
  type ListingJob,
  type ListingRepository,
  type ListingVersion,
} from "./listing-copy.js";
import type {
  LlmClient,
  PipelineRepository,
  PlanRepository,
  PlatformRepository,
  PromptRepository,
  StorageAdapter,
  SuiteRepository,
} from "./types.js";

type Params = Record<string, unknown>;
const root = "/api/listing-copies";
const conflict = () => new ListingError("LISTING_JOB_CHANGED", 409);
function applyListingConfig(job: ListingJob, params: ListingConfigInput) {
  let invalid = false;
  for (const k of LISTING_CONFIG_FIELDS) {
    if (params[k] === undefined) continue;
    if (typeof params[k] !== "string") {
      invalid = true;
      continue;
    }
    if (k === "sellingPoints") job.input.sellingPoints = params[k].trim();
    else job[k] = params[k].trim();
  }
  if (invalid) throw new ListingError("INVALID_LISTING_CONFIG");
  return job;
}
function applyProductCardSnapshotToListingJob(job: ListingJob, snapshot: ProductCardSnapshot | null) {
  if (!snapshot) return job;
  job.input.sellingPoints = mergeProductCardFacts(snapshot, job.input.sellingPoints);
  return job;
}
function newListingDraft(sourceSuiteId: string | null = null, id: string = randomUUID()): ListingJob {
  const date = now();
  return {
    id,
    sourceSuiteId,
    platform: "",
    targetMarket: "",
    outputLanguage: "中文",
    input: { sellingPoints: "" },
    inputImages: [],
    versions: [],
    status: "draft",
    errorCode: null,
    revision: 0,
    createdAt: date,
    updatedAt: date,
  };
}
function copySuiteImageReference(i: ListingImage): ListingImage {
  const { id, ordinal, originalObjectKey, thumbnailObjectKey, mimeType, width, height, sha256, originalFilename } = i;
  return { id, ordinal, originalObjectKey, thumbnailObjectKey, mimeType, width, height, sha256, originalFilename };
}
export function createListingCopyApi(deps: {
  jobs: ListingRepository;
  suites: SuiteRepository;
  pipelines: PipelineRepository;
  plans?: PlanRepository;
  storage: StorageAdapter;
  prompts?: PromptRepository;
  platforms?: PlatformRepository;
  vision: () => Promise<LlmClient | undefined>;
}) {
  async function saveListingJob(job: ListingJob, old: ListingJob | null) {
    job.revision = (old?.revision ?? 0) + 1;
    job.updatedAt = now();
    if (!(await deps.jobs.save(job, old))) throw conflict();
    return job;
  }
  async function loadListingRules(platform: string) {
    const profile = platform && (await deps.platforms?.find(platform));
    if (!profile) throw new ListingError("PLATFORM_NOT_FOUND");
    const rules = profile.listingCopyRules;
    if (
      !rules ||
      !Number.isInteger(rules.titleMaxLength) ||
      rules.titleMaxLength < 1 ||
      !Number.isInteger(rules.maxBulletPoints) ||
      rules.maxBulletPoints < 0 ||
      typeof rules.supportsSearchTerms !== "boolean" ||
      !Array.isArray(rules.forbiddenWords) ||
      !rules.forbiddenWords.every((w) => typeof w === "string")
    )
      throw new ListingError("LISTING_RULES_NOT_CONFIGURED");
    return rules;
  }
  async function generateListingVersion(job: ListingJob) {
    let stage = "准备生成输入";
    try {
      const rules = await loadListingRules(job.platform);
      const listed = (await deps.prompts?.listPublished("listing_copy"))?.find((t) => t.code === "general.listing-copy");
      const template = listed && (await deps.prompts?.getPublishedVersion(listed.templateVersionId, "listing_copy"));
      if (!template) throw new ListingError("LISTING_TEMPLATE_NOT_PUBLISHED");
      const llm = await deps.vision();
      if (!llm) throw new ListingError("LLM_NOT_CONFIGURED");
      const visionImages = await Promise.all(
        job.inputImages.map(async (i) => {
          const object = await deps.storage.get(i.originalObjectKey);
          if (!object) throw new ListingError("INPUT_OBJECT_NOT_FOUND");
          return {
            id: i.id,
            sourceKind: "original" as const,
            sourceVersionId: null,
            mimeType: i.mimeType,
            bytes: object.bytes,
          };
        }),
      );
      const input = {
        platform: job.platform,
        target_market: job.targetMarket,
        output_language: job.outputLanguage,
        selling_points: job.input.sellingPoints,
        listing_copy_rules: rules,
        image_ids: visionImages.map((i) => i.id),
      };
      stage = "调用文案模型";
      const output = await llm.generatePlan({
        flow: "listing-copy",
        requestId: randomUUID(),
        templateVersionId: template.templateVersionId,
        templateBody: template.body,
        userPromptTemplate: template.userPromptTemplate,
        dynamicInput: input,
        humanInput: {},
        chunks: [],
        inputImageIds: input.image_ids,
        baseVersionIds: [],
        visionImages,
      });
      stage = "校验模型输出";
      const content = validateContent(normalizeListingModelOutput(output, rules), rules);
      const version: ListingVersion = {
        id: randomUUID(),
        versionNumber: job.versions.length + 1,
        content,
        createdAt: now(),
        promptSnapshot: {
          templateVersionId: template.templateVersionId,
          templateCode: template.code,
          templateVersionNo: template.versionNo,
          input: { ...input, images: job.inputImages.map((i) => ({ id: i.id, sha256: i.sha256 })) },
          model: { name: llm.provider, model: llm.model, isFake: llm.isFake, channel: llm.channel },
        },
      };
      stage = "保存生成结果";
      await saveListingJob({ ...job, status: "succeeded", versions: [...job.versions, version] }, job);
    } catch (e) {
      const errorCode = e instanceof ListingError ? e.message : "LISTING_GENERATION_FAILED";
      console.error(`[listing-copy] jobId=${job.id} errorCode=${errorCode} reason=${stage}失败`);
      await saveListingJob({ ...job, status: "failed", errorCode }, job);
    }
  }
  async function startListingGeneration(job: ListingJob, old: ListingJob | null) {
    if (!job.inputImages.length) throw new ListingError("INPUT_IMAGES_REQUIRED");
    const running = await saveListingJob({ ...job, status: "running", errorCode: null }, old);
    void generateListingVersion(running).catch(() => console.error("Could not persist listing copy result", running.id));
    return ok(running, 202);
  }
  // Claim the run ID before interpreting inherited data. A bad historical field must
  // leave a visible, retryable result rather than disappearing from studio-state.
  async function startSuiteListingGeneration(
    job: ListingJob,
    config: ListingConfigInput,
    productCardSnapshot: ProductCardSnapshot | null = null,
  ) {
    const claimed = await saveListingJob({ ...job, status: "running" }, null);
    const configured = structuredClone(claimed);
    try {
      applyListingConfig(configured, config);
      applyProductCardSnapshotToListingJob(configured, productCardSnapshot);
      if (!configured.inputImages.length) throw new ListingError("INPUT_IMAGES_REQUIRED");
    } catch (e) {
      if (!(e instanceof ListingError)) throw e;
      return ok(await saveListingJob({ ...configured, status: "failed", errorCode: e.message }, claimed), 202);
    }
    return startListingGeneration(configured, claimed);
  }
  // A pipeline run has one deterministic job ID, so replay/resume never creates a second job.
  async function startPipeline(
    runId: string,
    suiteId: string,
    config: ListingConfigInput & Record<string, unknown>,
    images: ListingImage[],
  ) {
    if (await deps.jobs.summary(runId)) return;
    const job = newListingDraft(suiteId, runId);
    job.inputImages = images.map(copySuiteImageReference);
    const snapshot = readProductCardSnapshot(config.productCardSnapshot);
    try {
      await startSuiteListingGeneration(job, config, snapshot);
    } catch (e) {
      if (!(e instanceof ListingError && e.status === 409)) throw e;
    }
  }
  async function createListingJob(params: Params) {
    const source = params.sourceSuiteId;
    if (source !== undefined && (!isUuid(source) || !(await deps.suites.getSuite(source))))
      throw new ListingError("INVALID_SUITE_ID", 404);
    const job = newListingDraft(source ?? null);
    const generateNow = params.generate === true;
    if (source) {
      const run = await deps.pipelines.getLatestRun(source);
      const plan = !run && (await deps.plans?.getLatestSnapshot(source));
      const v = (plan && plan.dynamicInput) || {};
      const inherited: ListingConfigInput = run?.config ?? {
        platform: v.platform,
        targetMarket: v.target_market_country,
        outputLanguage: v.output_language,
        sellingPoints: v.human_supplement,
      };
      const snapshot = readProductCardSnapshot(run?.config?.productCardSnapshot);
      job.inputImages = (await deps.suites.getInputImages(source)).map(copySuiteImageReference);
      params = { ...inherited, ...params };
      if (generateNow) return startSuiteListingGeneration(job, params, snapshot);
      applyListingConfig(job, params);
      applyProductCardSnapshotToListingJob(job, snapshot);
      return ok(await saveListingJob(job, null), 201);
    }
    applyListingConfig(job, params);
    return generateNow ? startListingGeneration(job, null) : ok(await saveListingJob(job, null), 201);
  }
  function requireEditableListing(job: ListingJob) {
    if (job.status === "running") throw new ListingError("LISTING_JOB_RUNNING", 409);
  }
  function deleteOwnedImages(id: string, images: ListingImage[]) {
    return Promise.all(
      images
        .flatMap((i) => [i.originalObjectKey, i.thumbnailObjectKey])
        .filter((k) => k.startsWith(`listing-copies/${id}/inputs/`))
        .map((k) => deps.storage.delete(k)),
    );
  }
  async function uploadListingImage(old: ListingJob | null, body: Params) {
    if (old) requireEditableListing(old);
    const job = old ? structuredClone(old) : newListingDraft();
    if (job.inputImages.length >= 6) throw new ListingError("INPUT_IMAGE_LIMIT", 409);
    if (!Buffer.isBuffer(body.bytes) || typeof body.mimeType !== "string" || typeof body.filename !== "string")
      throw new ListingError("INVALID_INPUT_IMAGE");
    const p = await processImage(body.bytes, body.mimeType).catch((e) => {
      throw new ListingError(e.message);
    });
    const id = randomUUID(),
      prefix = `listing-copies/${job.id}/inputs/${id}`;
    const ordinal = [1, 2, 3, 4, 5, 6].find((n) => !job.inputImages.some((i) => i.ordinal === n))!;
    const image: ListingImage = {
      id,
      ordinal,
      originalObjectKey: `${prefix}/original`,
      thumbnailObjectKey: `${prefix}/thumbnail`,
      mimeType: p.mimeType,
      width: p.width,
      height: p.height,
      sha256: p.sha256,
      originalFilename: body.filename,
    };
    try {
      await deps.storage.put({ key: image.originalObjectKey, bytes: body.bytes, contentType: p.mimeType });
      await deps.storage.put({ key: image.thumbnailObjectKey, bytes: p.thumbnail, contentType: "image/jpeg" });
      job.inputImages.push(image);
      job.inputImages.sort((a, b) => a.ordinal - b.ordinal);
      return ok(await saveListingJob(job, old), 201);
    } catch (e) {
      await deleteOwnedImages(job.id, [image]);
      throw e;
    }
  }
  async function routeListingCopyRequest(method: string, url: URL, params: Params): Promise<AppResponse> {
    const path = url.pathname;
    if (path === root && method === "POST") return createListingJob(params);
    if (path === root && method === "GET") {
      const limit = Number(url.searchParams.get("limit") || 20),
        offset = Number(url.searchParams.get("offset") || 0);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0)
        throw new ListingError("INVALID_PAGINATION");
      return ok({ items: await deps.jobs.list(limit, offset), limit, offset });
    }
    if (path === `${root}/draft/input-images` && method === "POST") return uploadListingImage(null, params);
    const segments = path.slice(root.length + 1).split("/");
    if (segments.includes("")) throw new ListingError("NOT_FOUND", 404);
    const [id, action, imageId, preview, kind, ...extra] = segments;
    const job = isUuid(id) && (await deps.jobs.get(id));
    if (!job || extra.length) throw new ListingError("LISTING_JOB_NOT_FOUND", 404);
    if (action === "input-images") {
      if (!imageId && method === "POST") return uploadListingImage(job, params);
      const img = job.inputImages.find((i) => i.id === imageId);
      if (!img) throw new ListingError("INPUT_IMAGE_NOT_FOUND", 404);
      if (method === "GET" && preview === "preview" && (kind === "original" || kind === "thumbnail")) {
        const object = await deps.storage.get(kind === "original" ? img.originalObjectKey : img.thumbnailObjectKey);
        if (!object) throw new ListingError("INPUT_OBJECT_NOT_FOUND", 404);
        return {
          ...ok(null),
          raw: object.bytes,
          headers: { "content-type": object.contentType, "cache-control": "private, max-age=60" },
        };
      }
      if (method === "DELETE" && !preview) {
        requireEditableListing(job);
        const next = await saveListingJob({ ...job, inputImages: job.inputImages.filter((i) => i.id !== img.id) }, job);
        await deleteOwnedImages(id, [img]);
        return ok(next);
      }
    }
    if (method === "GET" && !action) return ok(job);
    if (!imageId && method === "POST" && (action === "generate" || action === "regenerate")) {
      requireEditableListing(job);
      const next = applyListingConfig(structuredClone(job), params);
      const run =
        (await deps.pipelines.getRun(job.id)) ??
        (job.sourceSuiteId ? await deps.pipelines.getLatestRun(job.sourceSuiteId) : null);
      applyProductCardSnapshotToListingJob(next, readProductCardSnapshot(run?.config?.productCardSnapshot));
      return startListingGeneration(next, job);
    }
    if (!action && method === "PUT") {
      requireEditableListing(job);
      const previous = job.versions.at(-1);
      if (!previous) throw new ListingError("LISTING_VERSION_REQUIRED", 409);
      const edits = params.content;
      if (
        !edits ||
        typeof edits !== "object" ||
        Array.isArray(edits) ||
        !Object.keys(edits).some((key) => key !== "schemaVersion")
      )
        throw new ListingError("LISTING_INVALID_CONTENT");
      const content = validateContent({ ...previous.content, ...edits }, await loadListingRules(job.platform));
      const version = {
        id: randomUUID(),
        createdAt: now(),
        versionNumber: previous.versionNumber + 1,
        content,
        promptSnapshot: { ...previous.promptSnapshot, editedFromVersionId: previous.id },
      };
      return ok(await saveListingJob({ ...job, status: "succeeded", errorCode: null, versions: [...job.versions, version] }, job));
    }
    if (!action && method === "DELETE") {
      requireEditableListing(job);
      if (!(await deps.jobs.remove(id, job.revision))) throw conflict();
      await deleteOwnedImages(id, job.inputImages);
      return ok({ id });
    }
    throw new ListingError("NOT_FOUND", 404);
  }
  return {
    startPipeline,
    async request(method: string, path: string, body: unknown) {
      try {
        return await routeListingCopyRequest(method, new URL(path, "http://localhost"), (body ?? {}) as Params);
      } catch (e) {
        if (!(e instanceof ListingError)) throw e;
        return { status: e.status, body: { error: { code: e.message, message: e.message }, requestId: randomUUID() } };
      }
    },
  };
}
