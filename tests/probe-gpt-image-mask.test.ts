import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const probe = "scripts/probe-gpt-image-mask.ts";
const mockSettings = `
  import { Pool } from ${JSON.stringify(import.meta.resolve("pg"))};
  const model = "gpt-image-2.5-flare-special";
  Pool.prototype.query = async () => ({ rows: [{ state: {
    preferences: { image: { channelId: "channel", modelId: model } },
    channels: [{ id: "channel", name: "test", protocol: "openai-compatible", baseUrl: "https://omyai.vip/v1",
      apiKey: "fixture-secret", models: [{ id: model, capabilities: ["image"] }] }],
  } }] });`;

function runProbe(mockFetch: string, args: string[]) {
  return spawnSync(process.execPath, [
    "--import", "tsx", "--import", `data:text/javascript,${encodeURIComponent(mockSettings + mockFetch)}`,
    probe, ...args,
  ], {
    encoding: "utf8",
    env: { ...process.env, DOTENV_CONFIG_QUIET: "true", PG_HOST: "localhost", PG_USER: "test", PG_DATABASE: "test", PG_PASSWORD: "test" },
  });
}

test("mask probe sends no image requests in dry-run", () => {
  const run = runProbe("globalThis.fetch = () => process.exit(90);", ["--dry-run"]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).maxRequests, 4);
  assert.doesNotMatch(run.stdout, /fixture-secret/);
});

test("mask probe fixes source and prompts across encodings and measures only the selected pixels", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mask-probe-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "run");
  const mockFetch = `
    import assert from "node:assert/strict";
    import sharp from ${JSON.stringify(import.meta.resolve("sharp"))};
    let calls = 0;
    const prompts = [];
    let source;
    globalThis.fetch = async (url, request) => {
      assert.equal(url, "https://omyai.vip/v1/images/edits");
      assert.equal(request.method, "POST");
      const { body } = request;
      assert.equal(body.get("n"), "1");
      assert.equal(body.get("size"), "1024x1024");
      assert.equal(body.get("response_format"), "b64_json");
      const image = Buffer.from(await body.get("image").arrayBuffer());
      source ??= image;
      assert.deepEqual(image, source);
      const prompt = body.get("prompt");
      prompts.push(prompt);
      const mask = sharp(Buffer.from(await body.get("mask").arrayBuffer()));
      const metadata = await mask.metadata();
      assert.equal(metadata.format, "png");
      assert.equal(metadata.width, 1024);
      assert.equal(metadata.height, 1024);
      const rgba = calls >= 2;
      assert.equal(metadata.channels, rgba ? 4 : 1);
      assert.equal(metadata.hasAlpha, rgba);
      const channel = rgba ? mask.extractChannel(3) : mask.extractChannel(0);
      const pixels = await channel.raw().toBuffer();
      for (let y = 0; y < 1024; y++) {
        for (let x = 0; x < 1024; x++) {
          const selected = x >= 688 && x < 848 && y >= 432 && y < 592;
          if (pixels[y * 1024 + x] !== (selected === rgba ? 0 : 255)) process.exit(91);
        }
      }
      if (rgba) assert.equal(prompt, prompts[calls - 2]);
      if (++calls > 4) process.exit(92);
      const changed = rgba
        ? await sharp(image).composite([{ input: { create: { width: 160, height: 160, channels: 3, background: "#000000" } },
            left: 688, top: 432 }]).png().toBuffer()
        : image;
      return Response.json({ data: [{ b64_json: changed.toString("base64") }] });
    };`;
  const run = runProbe(mockFetch, ["--live", "--output", output]);
  assert.equal(run.status, 0, run.stderr + run.stdout);
  const raw = await readFile(join(output, "results.jsonl"), "utf8");
  assert.doesNotMatch(raw, /fixture-secret/);
  const [header, ...results] = raw.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(header.maxRequests, 4);
  assert.deepEqual(results.map(({ encoding, tool }) => [encoding, tool]), [
    ["grayscale", "redraw"], ["grayscale", "erase"], ["rgba", "redraw"], ["rgba", "erase"],
  ]);
  for (const result of results) {
    assert.equal(result.outsideMae, 0);
    assert.equal(result.discMae.left, 0);
    assert.equal(result.discMae.middle, 0);
    assert.equal(result.insideMae > 0, result.encoding === "rgba");
    assert.equal(result.discMae.right > 0, result.encoding === "rgba");
  }
  const replay = runProbe("globalThis.fetch = () => process.exit(90);", ["--live", "--output", output]);
  assert.equal(replay.status, 1);
  assert.equal(replay.stderr.trim(), "OUTPUT_ALREADY_EXISTS");
});
