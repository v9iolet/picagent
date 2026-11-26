import { attachmentDisposition, binaryResponse } from "../http/binary-response.js";
import { taskView, taskAttemptView, taskVersionView, resolvePlanStyleGuide } from "../suite-views.js";
import { fail } from "../api-errors.js";
import { ok, asRecord } from "../api-response.js";
import sharp from "sharp";
import {
  DELIVERY_EXPORT_PRESETS,
  formatListingCopyMarkdown,
  resolveDeliverySlots,
  sanitizeDeliveryName,
  type DeliveryExportFormat,
  type DeliveryExportPresetId,
} from "../../shared/workbench-delivery.js";
import { createZipBuffer } from "../zip.js";
import { composeVerticalImages } from "../delivery-image.js";
import type { Router } from "../http/router.js";
import type { StudioServices } from "../services/studio-services.js";

export function registerDeliveryRoutes(router: Router, {
  deps,
  pipelineRepository,
  listingRepository,
  loadSuiteImageEditChildren,
}: StudioServices) {
  const styleOverrideIdempotency = new Map<string, { suite: import("../types.js").Suite; planStyleGuide: string; styleOverride: string | null; effectiveStyleGuide: string }>();

  router.patch("/api/suites/:suiteId/style-override", async ({ params, idempotencyKey, body: requestBody }) => {
    if (!idempotencyKey) return fail("MISSING_IDEMPOTENCY_KEY");
    const scopeKey = `${params.suiteId}:${idempotencyKey}`;
    const cached = styleOverrideIdempotency.get(scopeKey);
    if (cached) return ok(cached);
    const suite = await deps.repository.getSuite(params.suiteId);
    if (!suite) return fail("INVALID_SUITE_ID", 404);
    const body = asRecord(requestBody, { allowArrays: true });
    const rawValue = body.styleOverride;
    if (rawValue !== null && rawValue !== undefined && typeof rawValue !== "string") return fail("INVALID_STYLE_OVERRIDE");
    const nextValue = typeof rawValue === "string" && rawValue.trim() ? rawValue.trim() : null;
    const updated = await deps.repository.updateSuiteStyleOverride(suite.id, nextValue);
    if (!updated) return fail("INVALID_SUITE_ID", 404);
    const snapshot = deps.planRepository ? await deps.planRepository.getLatestSnapshot(suite.id) : null;
    const planStyleGuide = resolvePlanStyleGuide(snapshot);
    const payload = {
      suite: updated,
      planStyleGuide,
      styleOverride: updated.styleOverride ?? null,
      effectiveStyleGuide: updated.styleOverride?.trim() || planStyleGuide,
    };
    styleOverrideIdempotency.set(scopeKey, payload);
    return ok(payload);
  });

  router.get("/api/suites/:suiteId/delivery/export", async ({ params, query }) => {
    if (!deps.taskRepository) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);
    const suite = await deps.repository.getSuite(params.suiteId);
    if (!suite) return fail("INVALID_SUITE_ID", 404);

    const presetRaw = (query.get("preset") ?? "original").trim() as DeliveryExportPresetId;
    if (!Object.prototype.hasOwnProperty.call(DELIVERY_EXPORT_PRESETS, presetRaw)) return fail("INVALID_EXPORT_OPTIONS", 400);
    const preset = DELIVERY_EXPORT_PRESETS[presetRaw];
    const formatRaw = (query.get("format") ?? preset.defaultFormat).trim() as DeliveryExportFormat;
    if (!["original", "png", "jpeg", "webp"].includes(formatRaw)) return fail("INVALID_EXPORT_OPTIONS", 400);
    const qualityRaw = query.get("quality") ? Number(query.get("quality")) : preset.defaultQuality;
    if (!Number.isFinite(qualityRaw) || qualityRaw < 60 || qualityRaw > 100) return fail("INVALID_EXPORT_OPTIONS", 400);
    const quality = Math.round(qualityRaw);
    const stitchDetail = query.get("stitchDetail") === "true" || query.get("stitchDetail") === "1";
    const selectedTaskIds = new Set((query.get("taskIds") ?? "").split(",").map((id) => id.trim()).filter(Boolean));

    const [snapshot, tasks] = await Promise.all([
      deps.planRepository?.getLatestSnapshot(suite.id) ?? Promise.resolve(null),
      deps.taskRepository.listTasks(suite.id),
    ]);
    const taskAggregates = await Promise.all(tasks.map(async (task) => {
      const history = await deps.taskRepository!.listTaskVersions(task.id);
      return { ...taskView(task), versions: history.versions.map(taskVersionView), attempts: history.attempts.map(taskAttemptView), slots: [] };
    }));
    const imageEditChildren = await loadSuiteImageEditChildren(tasks);
    const slots = resolveDeliverySlots(taskAggregates, imageEditChildren, {
      defaultTemplateVersionId: snapshot?.templateVersionId ?? null,
      preferLatestByTime: suite.origin === "replica",
    });
    const deliverable = slots.filter((slot) => slot.sourceRole !== "pending" && slot.exportPath && (!selectedTaskIds.size || selectedTaskIds.has(slot.parentTaskId)));
    if (!deliverable.length) return fail("DELIVERY_EMPTY", 400);

    const extForFormat = (fmt: DeliveryExportFormat, fallbackPath: string) => {
      if (fmt === "jpeg") return "jpg";
      if (fmt === "webp") return "webp";
      if (fmt === "png") return "png";
      return fallbackPath.split(".").pop() || "png";
    };
    const mimeForFormat = (fmt: DeliveryExportFormat, fallbackMime: string) => {
      if (fmt === "jpeg") return "image/jpeg";
      if (fmt === "webp") return "image/webp";
      if (fmt === "png") return "image/png";
      return fallbackMime;
    };
    const replaceExt = (filePath: string, ext: string) => filePath.replace(/\.[^./]+$/, `.${ext}`);

    const needsTransform = preset.id !== "original" || formatRaw !== "original";
    const entries: Array<{ name: string; data: Buffer }> = [];
    const manifestItems: Array<Record<string, unknown>> = [];
    const detailForStitch: Buffer[] = [];

    for (const slot of deliverable) {
      let bytes: Buffer | null = null;
      if (slot.objectKey) {
        const stored = await deps.storage.get(slot.objectKey);
        if (stored) bytes = stored.bytes;
      }
      if (!bytes) return fail("OBJECT_NOT_FOUND", 404);

      let outBytes = bytes;
      let outWidth = slot.width;
      let outHeight = slot.height;
      let outMime = slot.mimeType;
      let outPath = slot.exportPath!;

      if (needsTransform) {
        let pipeline = sharp(bytes);
        if (slot.imageType === "main" && preset.mainBox) {
          pipeline = pipeline.resize({
            width: preset.mainBox.width,
            height: preset.mainBox.height,
            fit: preset.mainBox.fit,
            background: { r: 255, g: 255, b: 255, alpha: 1 },
          });
        } else if (slot.imageType === "detail" && preset.detailWidth) {
          pipeline = pipeline.resize({ width: preset.detailWidth, withoutEnlargement: false });
        }
        if (formatRaw === "jpeg") {
          pipeline = pipeline.flatten({ background: { r: 255, g: 255, b: 255 } }).jpeg({ quality, mozjpeg: true });
        } else if (formatRaw === "webp") {
          pipeline = pipeline.webp({ quality });
        } else if (formatRaw === "png") {
          pipeline = pipeline.png({ compressionLevel: 8 });
        }
        const rendered = await pipeline.toBuffer({ resolveWithObject: true });
        outBytes = rendered.data;
        outWidth = rendered.info.width;
        outHeight = rendered.info.height;
        outMime = mimeForFormat(formatRaw, slot.mimeType);
        outPath = replaceExt(slot.exportPath!, extForFormat(formatRaw, slot.exportPath!));
      }

      if (stitchDetail && slot.imageType === "detail") {
        detailForStitch.push(outBytes);
      }

      entries.push({ name: outPath, data: outBytes });
      manifestItems.push({
        exportPath: outPath,
        imageType: slot.imageType,
        ordinal: slot.typeOrdinal,
        title: slot.title,
        purpose: slot.purpose,
        sourceRole: slot.sourceRole,
        isEditedDerived: slot.isEditedDerived,
        parentTaskId: slot.parentTaskId,
        editChildTaskId: slot.editChildTaskId,
        sourceVersionId: slot.sourceVersionId,
        versionId: slot.versionId,
        versionNumber: slot.versionNumber,
        width: outWidth,
        height: outHeight,
        byteLength: outBytes.length,
        mimeType: outMime,
        model: slot.model,
        channelName: slot.channelName,
        templateVersionId: slot.templateVersionId,
        promptText: slot.promptText,
        promptSnapshot: slot.promptSnapshot,
      });
    }

    let stitchedDetailPath: string | null = null;
    if (stitchDetail && detailForStitch.length > 0) {
      const targetWidth = preset.detailWidth ?? 1200;
      let stitched = await composeVerticalImages(detailForStitch, targetWidth);
      const stitchFmt: DeliveryExportFormat = formatRaw === "original" ? "png" : formatRaw;
      if (stitchFmt === "jpeg") stitched = stitched.flatten({ background: { r: 255, g: 255, b: 255 } }).jpeg({ quality, mozjpeg: true });
      else if (stitchFmt === "webp") stitched = stitched.webp({ quality });
      else stitched = stitched.png({ compressionLevel: 8 });
      const stitchedBytes = await stitched.toBuffer();
      const ext = extForFormat(stitchFmt, "detail.png");
      stitchedDetailPath = `detail/00_detail_long_stitched.${ext}`;
      entries.push({ name: stitchedDetailPath, data: stitchedBytes });
    }

    const latestPipeline = await pipelineRepository.getLatestRun(suite.id);
    const listingSummary =
      (latestPipeline && (await listingRepository.summary(latestPipeline.id))) ??
      (await listingRepository.findLatestBySuiteId(suite.id));
    const listingJob = listingSummary ? await listingRepository.get(listingSummary.id) : null;
    const latestListingVersion =
      listingJob && listingJob.versions.length > 0
        ? listingJob.versions[listingJob.versions.length - 1]
        : null;
    const exportedAt = new Date().toISOString();
    let listingCopyPath: string | null = null;
    let listingCopyManifest: Record<string, unknown> | null = null;

    if (listingJob && latestListingVersion) {
      const platformProfile = deps.platformRepository
        ? await deps.platformRepository.find(listingJob.platform)
        : null;
      const markdown = formatListingCopyMarkdown({
        suiteName: suite.name,
        platformName: platformProfile?.name,
        marketScope: platformProfile?.marketScope,
        job: listingJob,
        version: latestListingVersion,
        rules: platformProfile?.listingCopyRules,
        exportedAt,
      });
      listingCopyPath = "listing-copy.md";
      entries.push({ name: listingCopyPath, data: Buffer.from(markdown, "utf8") });
      listingCopyManifest = {
        jobId: listingJob.id,
        status: listingJob.status,
        platform: listingJob.platform,
        targetMarket: listingJob.targetMarket,
        outputLanguage: listingJob.outputLanguage,
        versionId: latestListingVersion.id,
        versionNumber: latestListingVersion.versionNumber,
        createdAt: latestListingVersion.createdAt,
        content: latestListingVersion.content,
      };
    }

    const planStyleGuide = resolvePlanStyleGuide(snapshot);
    const manifest = {
      schemaVersion: "picagent-delivery-manifest-v1",
      exportedAt,
      exportOptions: {
        preset: preset.id,
        presetLabel: preset.label,
        format: formatRaw,
        quality,
        stitchDetail,
        stitchedDetailPath,
      },
      suite: {
        id: suite.id,
        name: suite.name,
        status: suite.status,
        planSnapshotId: snapshot?.id ?? null,
        planStyleGuide,
        styleOverride: suite.styleOverride ?? null,
        effectiveStyleGuide: suite.styleOverride?.trim() || planStyleGuide,
      },
      summary: {
        totalSlots: slots.length,
        exportedCount: manifestItems.length,
        mainCount: manifestItems.filter((item) => item.imageType === "main").length,
        detailCount: manifestItems.filter((item) => item.imageType === "detail").length,
        stitchedDetailIncluded: Boolean(stitchedDetailPath),
        listingCopyIncluded: Boolean(listingCopyPath),
        listingCopyPath,
      },
      listingCopy: listingCopyManifest,
      items: manifestItems,
    };
    entries.push({ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2), "utf8") });
    const zipBuffer = createZipBuffer(entries);
    const safeSuiteName = sanitizeDeliveryName(suite.name, `suite_${suite.id.slice(0, 8)}`);
    const asciiFallback = safeSuiteName.replace(/[^\x20-\x7e]/g, "") || `suite_${suite.id.slice(0, 8)}`;
    const suffix = preset.id === "original" ? "delivery" : `delivery_${preset.id}`;
    return binaryResponse(zipBuffer, "application/zip", {
      "content-disposition": attachmentDisposition(`${safeSuiteName}_${suffix}.zip`, `${asciiFallback}_${suffix}.zip`),
      "cache-control": "no-store",
    }, { exportedCount: manifestItems.length, preset: preset.id, stitchedDetailPath });
  });
}
