/** One-off live probe: npx tsx scripts/probe-gpt-image-size.ts --output /tmp/gpt-size.jsonl
 * --dry-run reads configuration and lists cases without making image requests.
 * Each real run makes exactly eight POSTs, with no retries or image URL downloads.
 */
import { createHash } from "node:crypto";
import { appendFile, writeFile } from "node:fs/promises";
import { Pool } from "pg";
import sharp from "sharp";
import { loadPostgresConfig } from "../server/config.js";
import { ModelSettings, PostgresModelSettingsRepository } from "../server/model-settings.js";

const PROMPT = "Keep the reference image composition and aspect ratio. Add a small dark blue circle in the center; keep the background plain. Do not add text.";
const cases = [
  ...["1K", "2K", "4K", "1024x1536", "1536x1024", "1024x1024", undefined]
    .map((size) => ({ size, width: 512, height: 512 })),
  { size: undefined, width: 512, height: 768 },
];

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const outputIndex = args.indexOf("--output");
  const output = outputIndex < 0 ? undefined : args[outputIndex + 1];
  const remaining = args.filter((_, index) => outputIndex < 0 || (index !== outputIndex && index !== outputIndex + 1));
  if (remaining.some((arg) => arg !== "--dry-run") || (outputIndex >= 0 && (!output || output.startsWith("--")))) {
    throw new Error("USAGE: --dry-run or --output <new-jsonl-path>");
  }
  if (!dryRun && !output) throw new Error("OUTPUT_PATH_REQUIRED: use --output <new-jsonl-path>");

  const pool = new Pool({ ...loadPostgresConfig(), max: 1, connectionTimeoutMillis: 30_000 });
  let state;
  try {
    state = await new PostgresModelSettingsRepository(pool).read();
  } finally {
    await pool.end();
  }
  const preferred = state.preferences.image;
  const channel = state.channels.find((item) => item.id === preferred?.channelId && item.protocol === "openai-compatible");
  if (!channel) throw new Error("DEFAULT_IMAGE_CHANNEL_UNAVAILABLE");
  const selected = await new ModelSettings({
    read: async () => state,
    update: async () => { throw new Error("READ_ONLY_PROBE"); },
  }).resolve("image");
  if (!selected) throw new Error("DEFAULT_IMAGE_MODEL_UNAVAILABLE");
  const base = new URL(selected.baseUrl);
  if (base.username || base.password || base.search || base.hash) throw new Error("UNSAFE_CHANNEL_URL");
  const endpoint = new URL("images/edits", base.href.replace(/\/?$/, "/"));
  const secrets = [...state.channels.map((item) => item.apiKey), ...Object.entries(process.env)
    .filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key)).map(([, value]) => value)]
    .filter((value): value is string => Boolean(value)).sort((a, b) => b.length - a.length);
  function redact(value: string) {
    for (const secret of secrets) value = value.split(secret).join("[REDACTED]");
    return value.replace(/\bBearer\s+[^\s"<>]+/gi, "Bearer [REDACTED]")
      .replace(/\bsk-[\w-]+/g, "[REDACTED]")
      .replace(/("(?:api[_-]?key|authorization|token|secret|password)"\s*:\s*")[^"]*/gi, "$1[REDACTED]");
  }
  const header = { type: "probe", startedAt: new Date().toISOString(), model: selected.model,
    channelId: channel.id, channelName: redact(channel.name), endpoint: endpoint.href,
    quality: "medium", n: 1, responseFormat: "b64_json", prompt: PROMPT,
    maxRequests: cases.length, dryRun };
  console.log(JSON.stringify(header));
  if (dryRun) {
    console.log(JSON.stringify({ cases }));
    return;
  }
  // Refuse to overwrite an earlier run, so an accidental rerun cannot erase evidence.
  await writeFile(output!, `${JSON.stringify(header)}\n`, { flag: "wx", mode: 0o600 });
  let unexpectedFailure = false;
  for (const [index, item] of cases.entries()) {
    const image = await sharp({ create: { width: item.width, height: item.height, channels: 3, background: "#eeeeee" } }).png().toBuffer();
    const form = new FormData();
    form.append("model", selected.model);
    form.append("image", new Blob([Uint8Array.from(image)], { type: "image/png" }), "reference.png");
    form.append("prompt", PROMPT);
    if (item.size !== undefined) form.append("size", item.size);
    form.append("quality", "medium");
    form.append("n", "1");
    form.append("response_format", "b64_json");
    const result = { type: "result", request: index + 1, size: item.size ?? "(omitted)",
      reference: `${item.width}x${item.height}`, referenceSha256: createHash("sha256").update(image).digest("hex"),
      startedAt: new Date().toISOString(), httpStatus: null as number | null,
      actualWidth: null as number | null, actualHeight: null as number | null,
      durationMs: 0, errorBody: "", localError: "" };
    const started = Date.now();
    try {
      const response = await fetch(endpoint, { method: "POST", redirect: "error",
        headers: { authorization: `Bearer ${selected.apiKey}` }, body: form, signal: AbortSignal.timeout(600_000) });
      result.httpStatus = response.status;
      if (!response.ok) {
        // Bound reads before redacting and retaining the first 500 characters.
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        if (reader) {
          try {
            while (length < 16_384) {
              const chunk = await reader.read();
              if (chunk.done) break;
              const bytes = chunk.value.subarray(0, 16_384 - length);
              chunks.push(bytes);
              length += bytes.length;
            }
          } finally { await reader.cancel().catch(() => undefined); }
        }
        result.errorBody = Array.from(redact(Buffer.concat(chunks).toString("utf8"))).slice(0, 500).join("");
      } else {
        const payload = await response.json() as { data?: Array<{ b64_json?: unknown }> };
        const encoded = payload.data?.[0]?.b64_json;
        if (typeof encoded !== "string" || !encoded) throw new Error("MISSING_B64_IMAGE");
        const metadata = await sharp(Buffer.from(encoded, "base64")).metadata();
        if (!metadata.width || !metadata.height) throw new Error("MISSING_IMAGE_DIMENSIONS");
        result.actualWidth = metadata.width;
        result.actualHeight = metadata.height;
      }
    } catch (error) {
      // Never serialize arbitrary exceptions: their messages can include credentials or image data.
      result.localError = error instanceof Error && ["MISSING_B64_IMAGE", "MISSING_IMAGE_DIMENSIONS"].includes(error.message)
        ? error.message : "TRANSPORT_OR_RESPONSE_DECODE_FAILED";
      unexpectedFailure = true;
    }
    result.durationMs = Date.now() - started;
    await appendFile(output!, `${JSON.stringify(result)}\n`);
    console.log(JSON.stringify(result));
  }
  if (unexpectedFailure) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const safeCodes = ["DEFAULT_IMAGE_CHANNEL_UNAVAILABLE", "DEFAULT_IMAGE_MODEL_UNAVAILABLE", "UNSAFE_CHANNEL_URL",
    "OUTPUT_PATH_REQUIRED: use --output <new-jsonl-path>", "USAGE: --dry-run or --output <new-jsonl-path>"];
  console.error(error instanceof Error && safeCodes.includes(error.message) ? error.message : "PROBE_SETUP_OR_OUTPUT_FAILED");
  process.exitCode = 1;
});
