import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { Pool } from "pg";
import sharp from "sharp";
import { defaultImageOptions } from "../shared/model-settings.js";
import { loadPostgresConfig } from "../server/config.js";
import { ImageEditorService, MemoryImageEditorRepository, type EditOperation, type ImageSource, type MaskSnapshot } from "../server/image-editor.js";
import { ModelSettings, PostgresModelSettingsRepository } from "../server/model-settings.js";
import { GptImageProvider } from "../server/providers/gpt-image-provider.js";
import { requestImageEditorEdit } from "../server/providers/image-editor-provider.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";
import type { ImageProvider } from "../server/types.js";

const MODEL = "gpt-image-2.5-flare-special";
const CHANNEL = "omyai-生图";
const ENDPOINT = "https://omyai.vip/v1/images/edits";
const DISC_SIZE = 1024;
const BASELINE_RECT = { left: 688, top: 432, right: 848, bottom: 592 };
const OUTPAINT_WIDTH = 1824;
const OUTPAINT_HEIGHT = 1024;
const BACKGROUND = "#f1eee4";
const TOOLS = ["redraw", "erase", "outpaint"] as const;
const SELECTION = { points: [{ x: 0.75, y: 0.5 }], width: 160 / DISC_SIZE };
const PAYLOADS = {
  redraw: { strokes: [SELECTION], feather: 0, prompt: "只把选区内最右侧的红圆改为钴蓝色，保持它的位置、形状和大小，同时保留左侧和中间红圆及其他所有元素" },
  erase: { strokes: [SELECTION], feather: 0, prompt: "只消除选区内最右侧的红圆，用周围纯色背景自然补全，同时保留左侧和中间红圆及其他所有元素" },
  outpaint: { direction: "vertical", targetRatio: "9:16" },
};

async function resolveTarget() {
  const pool = new Pool({ ...loadPostgresConfig(), options: "-c default_transaction_read_only=on", max: 1, connectionTimeoutMillis: 30_000 });
  try {
    const selected = await new ModelSettings(new PostgresModelSettingsRepository(pool)).resolve("image");
    if (!selected) throw new Error("DEFAULT_IMAGE_MODEL_UNAVAILABLE");
    const endpoint = new URL("images/edits", selected.baseUrl.replace(/\/?$/, "/")).href;
    if (selected.model !== MODEL || endpoint !== ENDPOINT || selected.source.channelName !== CHANNEL) throw new Error("UNEXPECTED_PROBE_TARGET");
    return selected;
  } finally {
    await pool.end();
  }
}

async function makeOutpaintSource() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${OUTPAINT_WIDTH}" height="${OUTPAINT_HEIGHT}" viewBox="0 0 1824 1024">
    <defs>
      <linearGradient id="wall" x2="100%" y2="100%"><stop stop-color="#e6eae5"/><stop offset="1" stop-color="#9fbbb6"/></linearGradient>
      <linearGradient id="bottle" x2="100%" y2="12%"><stop stop-color="#395568"/><stop offset="0.55" stop-color="#193b50"/><stop offset="1" stop-color="#102c40"/></linearGradient>
      <linearGradient id="table" x2="0%" y2="100%"><stop stop-color="#c6b197"/><stop offset="1" stop-color="#97785b"/></linearGradient>
    </defs>
    <rect width="1824" height="1024" fill="url(#wall)"/>
    <path d="M 0 720 H 1824 V 1024 H 0 Z" fill="url(#table)"/>
    <ellipse cx="1260" cy="853" rx="235" ry="26" fill="#674e3a" opacity=".34"/>
    <rect x="1148" y="319" width="215" height="537" rx="72" fill="url(#bottle)"/>
    <rect x="1193" y="258" width="125" height="96" rx="21" fill="#112f43"/>
    <path d="M 1180 388 V 765" stroke="#7393a2" stroke-width="8" stroke-linecap="round" opacity=".35"/>
    <text x="174" y="451" font-family="Arial, sans-serif" font-size="98" font-weight="bold" fill="#183247">NORTH STUDIO</text>
    <text x="180" y="551" font-family="Arial, sans-serif" font-size="53" letter-spacing="4" fill="#183247">COASTAL EDITION</text>
  </svg>`;
  return sharp(Buffer.from(svg)).removeAlpha().png().toBuffer();
}

function rgb(bytes: Buffer) {
  return sharp(bytes).flatten({ background: BACKGROUND }).toColourspace("srgb").raw().toBuffer();
}

function measureDiscs(reference: Buffer, result: Buffer, selection: Buffer) {
  const outsideBrush = { sum: 0, pixels: 0 };
  const outsideRect = { sum: 0, pixels: 0 };
  const left = { sum: 0, pixels: 0 };
  const middle = { sum: 0, pixels: 0 };
  const right = { sum: 0, pixels: 0 };
  for (let y = 0; y < DISC_SIZE; y += 1) {
    for (let x = 0; x < DISC_SIZE; x += 1) {
      const index = y * DISC_SIZE + x;
      const offset = index * 3;
      const diff = Math.abs(reference[offset] - result[offset])
        + Math.abs(reference[offset + 1] - result[offset + 1])
        + Math.abs(reference[offset + 2] - result[offset + 2]);
      const add = (region: typeof left) => { region.sum += diff; region.pixels += 1; };
      if (selection[index] < 128) add(outsideBrush);
      if (x < BASELINE_RECT.left || x >= BASELINE_RECT.right || y < BASELINE_RECT.top || y >= BASELINE_RECT.bottom) add(outsideRect);
      const dySquared = (y - 512) ** 2;
      if ((x - 256) ** 2 + dySquared <= 48 ** 2) add(left);
      if ((x - 512) ** 2 + dySquared <= 48 ** 2) add(middle);
      if ((x - 768) ** 2 + dySquared <= 48 ** 2) add(right);
    }
  }
  const mean = ({ sum, pixels }: typeof left) => sum / (pixels * 3);
  return { outsideMae: mean(outsideBrush), outsideBaselineRectMae: mean(outsideRect), discMae: { left: mean(left), middle: mean(middle), right: mean(right) } };
}

async function main() {
  const { values } = parseArgs({ options: { "dry-run": { type: "boolean" }, live: { type: "boolean" }, reference: { type: "string" }, output: { type: "string" } } });
  const { live, reference, output, "dry-run": dryRun } = values;
  if (!reference || (live ? !output || dryRun : !dryRun || output)) throw new Error("USE_DRY_RUN_OR_LIVE_WITH_REFERENCE_AND_NEW_OUTPUT_DIRECTORY");

  const selected = await resolveTarget();
  const options = selected.imageOptions ?? defaultImageOptions(selected.model);
  const referenceBytes = await readFile(reference);
  const referenceMetadata = await sharp(referenceBytes).metadata();
  if (referenceMetadata.width !== DISC_SIZE || referenceMetadata.height !== DISC_SIZE || referenceMetadata.format !== "png") {
    throw new Error("INVALID_DISC_REFERENCE");
  }
  const outpaintBytes = await makeOutpaintSource();
  const referenceRgb = await rgb(referenceBytes);
  if (output) {
    // A live run reserves a new directory before making any paid requests.
    await mkdir(output, { mode: 0o700 });
    await writeFile(join(output, "reference.png"), referenceBytes);
    await writeFile(join(output, "outpaint-reference.png"), outpaintBytes);
  }
  const record = async (entry: Record<string, unknown>) => {
    const line = JSON.stringify(entry);
    if (output) await appendFile(join(output, "results.jsonl"), `${line}\n`);
    console.log(line);
  };
  const upstream = live ? new GptImageProvider(selected.baseUrl, selected.apiKey) : null;
  await record({ event: "run", mode: live ? "live" : "dry-run", startedAt: new Date().toISOString(), endpoint: ENDPOINT, model: MODEL,
    channelId: selected.source.channelId, channelName: CHANNEL, maxRequests: TOOLS.length, quality: options.quality ?? "high",
    referenceSha256: createHash("sha256").update(referenceBytes).digest("hex"), baselineRect: BASELINE_RECT });

  for (const tool of TOOLS) {
    const storage = new MemoryStorage();
    const repository = new MemoryImageEditorRepository();
    const source: ImageSource = tool === "outpaint"
      ? { bytes: outpaintBytes, mimeType: "image/png", width: OUTPAINT_WIDTH, height: OUTPAINT_HEIGHT }
      : { bytes: referenceBytes, mimeType: "image/png", width: DISC_SIZE, height: DISC_SIZE };
    let requestStartedAt: number | undefined;
    let durationMs: number | undefined;
    const adapter: ImageProvider = {
      async edit(request) {
        if (requestStartedAt !== undefined || request.n !== 1 || Object.hasOwn(request, "mask") || request.images?.length !== 1) {
          throw new Error("UNEXPECTED_PROBE_REQUEST");
        }
        const input = await sharp(request.image).metadata();
        if (tool === "outpaint" && output) await writeFile(join(output, "outpaint-canvas.png"), request.image);
        requestStartedAt = Date.now();
        await record({ event: "request", tool, requestId: request.requestId, size: request.size, quality: request.quality,
          n: request.n, inputWidth: input.width, inputHeight: input.height, maskApplied: false,
          promptSummary: request.prompt.replace(/\s+/g, " ").slice(0, 400) });
        try {
          return upstream ? await upstream.edit(request) : { bytes: request.image, mimeType: "image/png" };
        } finally {
          durationMs = Date.now() - requestStartedAt;
        }
      },
    };
    // Use the editor's built-in instructions, identical to the default templates in migration 048.
    const service = new ImageEditorService(repository, {
      name: "openai-compatible-image", version: MODEL, channel: selected.source, capabilitiesVersion: "v2",
      capabilities: () => ({ imageToImage: true, addText: true, changeText: true, redraw: true, erase: true, outpaint: true, currentVersionInput: true }),
      edit(command, input) {
        if (command.maskApplied !== false) throw new Error("UNEXPECTED_PROBE_REQUEST");
        return requestImageEditorEdit(adapter, storage, MODEL, options, command, input);
      },
    }, storage, async () => source);
    const operation: EditOperation = { operationId: tool, type: tool, order: 1, sourceCardId: "source-card", sourceVersionId: "source-version",
      parentVersionId: "source-version", summary: tool, payload: PAYLOADS[tool] };
    await service.upsertOperation({ sessionId: "probe", operation });
    const submitted = await service.submit({ sessionId: "probe", idempotencyKey: tool, sourceCardId: operation.sourceCardId, sourceVersionId: operation.sourceVersionId });
    let state = await service.getTask(submitted.childTask.id);
    while (state?.task.status === "generating") {
      await delay(100);
      state = await service.getTask(submitted.childTask.id);
    }
    const version = state?.versions[0];
    const generated = version && await storage.get(version.objectKey);
    if (!generated || state?.task.status !== "succeeded") {
      const error = state?.task.errorCode ?? "PROBE_RESULT_UNAVAILABLE";
      await record({ event: "result", tool, maskApplied: submitted.snapshot.maskApplied, durationMs, error: /^[A-Z][A-Z_]+$/.test(error) ? error : "PROBE_CASE_FAILED" });
      process.exitCode = 1;
      continue;
    }
    const png = await sharp(generated.bytes).png().toBuffer();
    if (output) await writeFile(join(output, `${tool}.png`), png);
    let metrics: ReturnType<typeof measureDiscs> | undefined;
    if (tool !== "outpaint" && version.width === DISC_SIZE && version.height === DISC_SIZE) {
      const mask = submitted.snapshot.operations[0].payload.mask as MaskSnapshot;
      const selection = await storage.get(mask.objectKey);
      if (!selection) throw new Error("PROBE_SELECTION_UNAVAILABLE");
      metrics = measureDiscs(referenceRgb, await rgb(png), await sharp(selection.bytes).grayscale().raw().toBuffer());
    }
    await record({ event: "result", tool, maskApplied: submitted.snapshot.maskApplied, durationMs,
      width: version.width, height: version.height, ...metrics });
  }
}

main().catch((error: unknown) => {
  const safeCodes = ["DEFAULT_IMAGE_MODEL_UNAVAILABLE", "UNEXPECTED_PROBE_TARGET", "INVALID_DISC_REFERENCE", "PROBE_SELECTION_UNAVAILABLE", "USE_DRY_RUN_OR_LIVE_WITH_REFERENCE_AND_NEW_OUTPUT_DIRECTORY"];
  if (error instanceof Error && "code" in error && error.code === "EEXIST") console.error("OUTPUT_ALREADY_EXISTS");
  else console.error(error instanceof Error && safeCodes.includes(error.message) ? error.message : "PROBE_SETUP_OR_OUTPUT_FAILED");
  process.exitCode = 1;
});
