import { createHash } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Pool } from "pg";
import sharp from "sharp";
import { loadPostgresConfig } from "../server/config.js";
import { ModelSettings, PostgresModelSettingsRepository } from "../server/model-settings.js";

const ENDPOINT = "https://omyai.vip/v1/images/edits";
const MODEL = "gpt-image-2.5-flare-special";
const WIDTH = 1024;
const HEIGHT = 1024;
const SIZE = `${WIDTH}x${HEIGHT}`;
const QUALITY = "medium";
const BACKGROUND = "#f1eee4";
const MARKERS = [256, 512, 768];
const SELECTION = { x: 688, y: 432, width: 160, height: 160 };
const PROMPTS = {
  redraw: "Change only the red disc inside the supplied mask to cobalt blue. Keep its shape, size, and position. Leave all pixels outside the mask unchanged.",
  erase: "Remove only the red disc inside the supplied mask and fill its place to match the surrounding plain background. Leave all pixels outside the mask unchanged.",
};
const CASES = (["grayscale", "rgba"] as const).flatMap(encoding =>
  (["redraw", "erase"] as const).map(tool => ({ encoding, tool, output: `${encoding}-${tool}.png`, prompt: PROMPTS[tool] })),
);

async function resolveTarget() {
  const pool = new Pool({
    ...loadPostgresConfig(), options: "-c default_transaction_read_only=on", max: 1, connectionTimeoutMillis: 30_000,
  });
  try {
    const selected = await new ModelSettings(new PostgresModelSettingsRepository(pool)).resolve("image");
    if (!selected) throw new Error("DEFAULT_IMAGE_MODEL_UNAVAILABLE");
    const endpoint = new URL("images/edits", selected.baseUrl.replace(/\/?$/, "/")).href;
    if (selected.model !== MODEL || endpoint !== ENDPOINT) throw new Error("UNEXPECTED_PROBE_TARGET");
    return selected;
  } finally {
    await pool.end();
  }
}

async function makeFixtures() {
  // The two unselected discs match the target. The prompts do not identify its position.
  const discs = MARKERS.map(x => `<circle cx="${x}" cy="512" r="60" fill="#d52935"/>`).join("");
  const reference = await sharp(Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
      <rect width="1024" height="1024" fill="${BACKGROUND}"/>
      <rect x="72" y="72" width="880" height="880" rx="28" fill="none" stroke="#2a4259" stroke-width="12"/>
      <path d="M 140,235 L 270,145 L 340,235 Z" fill="#008b86"/>
      <rect x="663" y="156" width="217" height="36" rx="10" fill="#774595"/>
      <path d="M 151,795 H 430 M 151,825 H 345 M 151,855 H 405" stroke="#344d6f" stroke-width="11" stroke-linecap="round"/>
      <path d="M 770,757 L 850,820 L 770,883 L 690,820 Z" fill="#e8a82d"/>
      ${discs}
    </svg>
  `)).removeAlpha().png().toBuffer();
  const coverage = Buffer.alloc(WIDTH * HEIGHT);
  for (let y = SELECTION.y; y < SELECTION.y + SELECTION.height; y++) {
    const start = y * WIDTH + SELECTION.x;
    coverage.fill(255, start, start + SELECTION.width);
  }
  const rgba = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let i = 0; i < coverage.length; i++) rgba[i * 4 + 3] = 255 - coverage[i];
  const raw = { width: WIDTH, height: HEIGHT };
  const masks = {
    grayscale: await sharp(coverage, { raw: { ...raw, channels: 1 } }).toColourspace("b-w").png().toBuffer(),
    rgba: await sharp(rgba, { raw: { ...raw, channels: 4 } }).png().toBuffer(),
  };
  return { reference, masks, coverage };
}

function rgb(bytes: Buffer) {
  return sharp(bytes).flatten({ background: BACKGROUND }).toColourspace("srgb").raw().toBuffer();
}

function measure(reference: Buffer, output: Buffer, coverage: Buffer) {
  const outside = { sum: 0, pixels: 0 };
  const inside = { sum: 0, pixels: 0 };
  const discs = MARKERS.map(x => ({ x, sum: 0, pixels: 0 }));
  for (let i = 0; i < coverage.length; i++) {
    const offset = i * 3;
    const difference = Math.abs(reference[offset] - output[offset])
      + Math.abs(reference[offset + 1] - output[offset + 1])
      + Math.abs(reference[offset + 2] - output[offset + 2]);
    const region = coverage[i] ? inside : outside;
    region.sum += difference;
    region.pixels++;
    const x = i % WIDTH;
    const y = Math.floor(i / WIDTH);
    for (const disc of discs) {
      if ((x - disc.x) ** 2 + (y - 512) ** 2 > 48 ** 2) continue;
      disc.sum += difference;
      disc.pixels++;
    }
  }
  const mean = ({ sum, pixels }: typeof outside) => sum / (pixels * 3);
  return {
    outsideMae: mean(outside), insideMae: mean(inside),
    discMae: { left: mean(discs[0]), middle: mean(discs[1]), right: mean(discs[2]) },
  };
}

async function edit(apiKey: string, item: typeof CASES[number], reference: Buffer, mask: Buffer) {
  const form = new FormData();
  form.append("model", MODEL);
  form.append("image", new Blob([Uint8Array.from(reference)], { type: "image/png" }), "reference.png");
  form.append("mask", new Blob([Uint8Array.from(mask)], { type: "image/png" }), "mask.png");
  form.append("prompt", item.prompt);
  form.append("size", SIZE);
  form.append("quality", QUALITY);
  form.append("n", "1");
  form.append("response_format", "b64_json");
  const response = await fetch(ENDPOINT, {
    method: "POST", redirect: "error", headers: { authorization: `Bearer ${apiKey}` },
    body: form, signal: AbortSignal.timeout(600_000),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { httpStatus: response.status, error: "HTTP_ERROR" } as const;
  }
  const payload = await response.json().catch(() => null) as { data?: Array<{ b64_json?: unknown }> } | null;
  const encoded = payload?.data?.[0]?.b64_json;
  if (typeof encoded !== "string" || !encoded) {
    return { httpStatus: response.status, error: "INVALID_IMAGE_RESPONSE" } as const;
  }
  return { httpStatus: response.status, bytes: Buffer.from(encoded, "base64") } as const;
}

async function main() {
  const { values } = parseArgs({ options: { "dry-run": { type: "boolean" }, live: { type: "boolean" }, output: { type: "string" } } });
  const { live, output, "dry-run": dryRun } = values;
  if (live ? dryRun || !output : output) throw new Error("USE_DRY_RUN_OR_LIVE_WITH_NEW_OUTPUT_DIRECTORY");
  const selected = await resolveTarget();
  const header = {
    startedAt: new Date().toISOString(), endpoint: ENDPOINT, model: MODEL,
    channelId: selected.source.channelId, channelName: selected.source.channelName, size: SIZE, quality: QUALITY,
    n: 1, selection: SELECTION, maxRequests: CASES.length, cases: CASES,
  };
  if (!live || !output) {
    console.log(JSON.stringify(header));
    return;
  }

  const { reference, masks, coverage } = await makeFixtures();
  const referenceRgb = await rgb(reference);
  // A new directory keeps evidence intact and prevents billing twice by reusing the same path.
  await mkdir(output, { mode: 0o700 });
  await writeFile(join(output, "reference.png"), reference);
  for (const [encoding, mask] of Object.entries(masks)) await writeFile(join(output, `mask-${encoding}.png`), mask);
  const runHeader = { ...header, referenceSha256: createHash("sha256").update(reference).digest("hex") };
  const logPath = join(output, "results.jsonl");
  await writeFile(logPath, `${JSON.stringify(runHeader)}\n`);
  console.log(JSON.stringify(runHeader));
  for (const item of CASES) {
    const started = Date.now();
    let httpStatus: number | undefined;
    let record;
    try {
      const response = await edit(selected.apiKey, item, reference, masks[item.encoding]);
      httpStatus = response.httpStatus;
      if (!response.bytes) {
        record = { error: response.error };
      } else {
        const image = sharp(response.bytes);
        const { width, height } = await image.metadata();
        const png = await image.png().toBuffer();
        await writeFile(join(output, item.output), png);
        record = width === WIDTH && height === HEIGHT
          ? { width, height, ...measure(referenceRgb, await rgb(png), coverage) }
          : { width, height, error: "SIZE_MISMATCH" };
      }
    } catch {
      record = { error: httpStatus === undefined ? "TRANSPORT_FAILED" : "DECODE_OR_OUTPUT_FAILED" };
    }
    if ("error" in record) process.exitCode = 1;
    const line = JSON.stringify({ encoding: item.encoding, tool: item.tool, httpStatus, durationMs: Date.now() - started, ...record });
    await appendFile(logPath, `${line}\n`);
    console.log(line);
  }
}

main().catch((error: unknown) => {
  const safeCodes = ["DEFAULT_IMAGE_MODEL_UNAVAILABLE", "UNEXPECTED_PROBE_TARGET", "USE_DRY_RUN_OR_LIVE_WITH_NEW_OUTPUT_DIRECTORY"];
  if (error instanceof Error && "code" in error && error.code === "EEXIST") console.error("OUTPUT_ALREADY_EXISTS");
  else console.error(error instanceof Error && safeCodes.includes(error.message) ? error.message : "PROBE_SETUP_OR_OUTPUT_FAILED");
  process.exitCode = 1;
});
