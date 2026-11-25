import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";

const mockSettings = `
  import { Pool } from ${JSON.stringify(import.meta.resolve("pg"))};
  const model = "gpt-image-2.5-flare-special";
  Pool.prototype.query = async () => ({ rows: [{ state: {
    preferences: { image: { channelId: "channel", modelId: model } },
    channels: [{ id: "channel", name: "omyai-生图", protocol: "openai-compatible", baseUrl: "https://omyai.vip/v1",
      apiKey: "fixture-secret", models: [{ id: model, capabilities: ["image"] }] }],
  } }] });`;

function runProbe(mockFetch: string, args: string[]) {
  return spawnSync(process.execPath, [
    "--import", "tsx", "--import", `data:text/javascript,${encodeURIComponent(mockSettings + mockFetch)}`,
    "scripts/probe-mask-fallback.ts", ...args,
  ], {
    encoding: "utf8", timeout: 10_000,
    env: { ...process.env, DOTENV_CONFIG_QUIET: "true", PG_HOST: "localhost", PG_USER: "test", PG_DATABASE: "test", PG_PASSWORD: "test" },
  });
}

test("fallback probe executes exactly three one-image edits without transmitting a mask", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mask-fallback-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reference = join(directory, "reference.png");
  await writeFile(reference, await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "white" } }).png().toBuffer());
  const blockedFetch = "globalThis.fetch = () => process.exit(90);";
  const dry = runProbe(blockedFetch, ["--dry-run", "--reference", reference]);
  assert.equal(dry.status, 0, dry.stderr + dry.stdout);
  const output = join(directory, "run");
  const mockFetch = `
    import assert from "node:assert/strict";
    import sharp from ${JSON.stringify(import.meta.resolve("sharp"))};
    let calls = 0;
    globalThis.fetch = async (url, { body }) => {
      const index = calls++;
      if (index > 2) process.exit(91);
      assert.equal(url.href, "https://omyai.vip/v1/images/edits");
      assert.equal(body.get("n"), "1");
      assert.equal(body.has("mask"), false);
      assert.equal(body.getAll("image").length, 1);
      const image = Buffer.from(await body.get("image").arrayBuffer());
      const { width, height } = await sharp(image).metadata();
      assert.equal(body.get("size"), index === 2 ? "1024x1824" : "1024x1024");
      assert.deepEqual([width, height], index === 2 ? [1827, 3248] : [1024, 1024]);
      const prompt = body.get("prompt");
      if (index === 2) {
        assert.match(prompt, /原图居中/);
        assert.match(prompt, /灰色扩展区/);
      } else {
        assert.match(prompt, /横向约 67%–83%/);
        assert.match(prompt, /最右侧的红圆/);
      }
      return Response.json({ data: [{ b64_json: image.toString("base64") }] });
    };`;
  const args = ["--live", "--reference", reference, "--output", output];
  const run = runProbe(mockFetch, args);
  assert.equal(run.status, 0, run.stderr + run.stdout);
  const raw = await readFile(join(output, "results.jsonl"), "utf8");
  assert.doesNotMatch(raw + run.stdout + run.stderr, /fixture-secret/);
  const entries = raw.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(entries[0].maxRequests, 3);
  const requests = entries.filter(entry => entry.event === "request");
  assert.deepEqual(requests.map(({ tool }) => tool), ["redraw", "erase", "outpaint"]);
  const results = entries.filter(entry => entry.event === "result");
  assert.equal(results.length, 3);
  assert.ok(results.every(result => result.maskApplied === false));
  assert.ok(results.slice(0, 2).every(result => result.outsideMae === 0 && result.discMae.left === 0 && result.discMae.middle === 0));
  assert.ok((await readFile(join(output, "outpaint-canvas.png"))).length);
  const duplicate = runProbe(blockedFetch, args);
  assert.equal(duplicate.status, 1);
  assert.equal(duplicate.stderr.trim(), "OUTPUT_ALREADY_EXISTS");
});
