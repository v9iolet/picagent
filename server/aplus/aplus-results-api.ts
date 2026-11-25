import sharp from "sharp";
import {
  APLUS_SIZE_PRESETS, validateAplusModuleCodes, type AplusModuleCode, type AplusSizePresetKey,
} from "../../shared/aplus.js";
import { sanitizeDeliveryName, type ResolvedDeliverySlot } from "../../shared/workbench-delivery.js";
import { fail } from "../api-errors.js";
import { asRecord, dataOf, ok, type AppResponse } from "../api-response.js";
import { composeVerticalImages } from "../delivery-image.js";
import type { StorageAdapter, Suite, SuiteRepository, SuiteTaskStatus, TaskRepository } from "../types.js";
import { createZipBuffer, type ZipEntryInput } from "../zip.js";

interface ResultCard extends ResolvedDeliverySlot {
  moduleCode: AplusModuleCode;
  sizePreset: AplusSizePresetKey;
  sortOrder: number;
  taskStatus: SuiteTaskStatus;
}

interface Results {
  suite: Suite;
  inputSnapshot: { sizePresets: AplusSizePresetKey[] } | null;
  cards: ResultCard[];
}

export function createAplusResultsApi(deps: {
  repository: SuiteRepository;
  tasks?: TaskRepository;
  storage: StorageAdapter;
  getStudioState: (suiteId: string) => Promise<AppResponse>;
}) {
  async function reorder(suiteId: string, body: unknown) {
    const { modules } = asRecord(body);
    if (!validateAplusModuleCodes(modules)) return fail("APLUS_INVALID_MODULES", 400);
    const suite = await deps.repository.getSuite(suiteId);
    if (!suite) return fail("INVALID_SUITE_ID", 404);
    if (suite.origin !== "aplus") return fail("INVALID_SUITE_ORIGIN", 400);
    if (!deps.tasks) return fail("TASK_REPOSITORY_NOT_CONFIGURED", 503);
    return await deps.tasks.reorderAplusModules(suiteId, modules)
      ? ok({ modules })
      : fail("APLUS_RESULT_ORDER_CHANGED", 409);
  }

  async function readGroup(cards: ResultCard[], preset: AplusSizePresetKey) {
    const directory = preset.replace(":", "x");
    const presetSize = APLUS_SIZE_PRESETS[preset].deliverySize;
    const entries: ZipEntryInput[] = [];
    const items = [];
    let width = presetSize?.width ?? 0;

    for (const card of cards) {
      if (card.sizePreset !== preset) continue;
      const { moduleCode, sortOrder, taskStatus, versionId } = card;
      const generatedSize = card.generatedSize ?? (card.width && card.height ? { width: card.width, height: card.height } : null);
      const item = { moduleCode, sortOrder, taskId: card.parentTaskId, versionId, generatedSize, deliverySize: card.deliverySize ?? null };
      if (taskStatus === "failed" || !versionId) {
        items.push({ ...item, path: null, skippedReason: taskStatus === "failed" ? "failed" : "no_version" });
        continue;
      }

      const key = card.deliveryObjectKey ?? (presetSize ? null : card.objectKey);
      const object = key ? await deps.storage.get(key).catch((error: unknown) => {
        if (error instanceof Error && error.message === "OBJECT_NOT_FOUND") return null;
        throw error;
      }) : null;
      if (!object) {
        items.push({ ...item, path: null, skippedReason: "delivery_missing" });
        continue;
      }

      const deliverySize = card.deliverySize ?? presetSize ?? await sharp(object.bytes).metadata();
      const ext = object.contentType === "image/jpeg" ? "jpg" : object.contentType === "image/webp" ? "webp" : "png";
      const name = `${directory}/${String(sortOrder).padStart(2, "0")}_${moduleCode}.${ext}`;
      entries.push({ name, data: object.bytes });
      if (!presetSize) width = Math.max(width, deliverySize.width);
      items.push({ ...item, deliverySize: { width: deliverySize.width, height: deliverySize.height }, path: name, skippedReason: null });
    }

    const longImage = entries.length ? await (await composeVerticalImages(entries.map(({ data }) => data), width))
      .png({ compressionLevel: 8 }).toBuffer({ resolveWithObject: true }) : null;
    const path = longImage ? `${directory}/long-image.png` : null;
    const manifest = {
      sizePreset: preset,
      longImage: longImage ? { path, width: longImage.info.width, height: longImage.info.height } : null,
      items,
    };
    if (longImage && path) entries.push({ name: path, data: longImage.data });
    return { entries, longImage, manifest };
  }

  async function exportResult(suiteId: string, action: "long-image" | "export", preset: string | null) {
    const state = await deps.getStudioState(suiteId);
    if (state.status !== 200) return state;
    const { suite, cards, inputSnapshot } = dataOf(state) as Results;
    const presets = inputSnapshot?.sizePresets ?? [];
    try {
      if (action === "long-image") {
        const selected = presets.find((key) => key === preset);
        if (!selected) return fail("APLUS_INVALID_SIZE_PRESETS", 400);
        const { longImage, manifest } = await readGroup(cards, selected);
        if (!longImage) return fail("DELIVERY_EMPTY", 400);
        return { ...ok(manifest), raw: longImage.data, headers: { "content-type": "image/png", "cache-control": "no-store" } };
      }

      const entries: ZipEntryInput[] = [];
      const groups = [];
      for (const key of presets) {
        const group = await readGroup(cards, key);
        entries.push(...group.entries);
        groups.push(group.manifest);
      }
      if (!entries.length) return fail("DELIVERY_EMPTY", 400);
      const manifest = { suiteId, suiteName: suite.name, groups };
      entries.push({ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2)) });
      const filename = `${sanitizeDeliveryName(suite.name, "Aplus")}.zip`;
      return {
        ...ok(manifest), raw: createZipBuffer(entries),
        headers: {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="Aplus.zip"; filename*=UTF-8''${encodeURIComponent(filename)}`,
          "cache-control": "no-store",
        },
      };
    } catch {
      return fail("APLUS_EXPORT_FAILED", 502);
    }
  }

  return { reorder, exportResult };
}
