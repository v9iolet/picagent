import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const probe = "scripts/probe-gpt-image-size.ts";

test("probe reports missing PG configuration without exposing values", () => {
  const run = spawnSync(process.execPath, ["--import", "tsx", probe, "--dry-run"], {
    encoding: "utf8", env: { ...process.env, DOTENV_CONFIG_QUIET: "true", PG_HOST: "", PG_PASSWORD: "sensitive-placeholder" },
  });
  assert.equal(run.status, 1);
  assert.equal(run.stderr.trim(), "PG_CONFIG_MISSING");
  assert.doesNotMatch(run.stdout, /sensitive-placeholder/);
});

test("high-res dry-run lists only the three authorized pixel sizes and sends no images", () => {
  // Stub only the PG and HTTP boundaries; exercise the real CLI and model resolution.
  const preview = `
    import { Pool } from ${JSON.stringify(import.meta.resolve("pg"))};
    const model = "gpt-image-2.5-flare-special";
    Pool.prototype.query = async () => ({rows: [{state: {
      preferences: {image: {channelId: "channel", modelId: model}},
      channels: [{id: "channel", name: "test", protocol: "openai-compatible", baseUrl: "https://example.invalid/v1",
        apiKey: "fixture-secret", models: [{id: model, capabilities: ["image"]}]}]
    }}]});
    globalThis.fetch = () => process.exit(90);`;
  const run = spawnSync(process.execPath, ["--import", "tsx", "--import", `data:text/javascript,${encodeURIComponent(preview)}`, probe, "--case-set", "high-res", "--dry-run"], {
    encoding: "utf8", env: { ...process.env, DOTENV_CONFIG_QUIET: "true", PG_HOST: "localhost", PG_PORT: "5432",
      PG_USER: "test", PG_DATABASE: "test", PG_PASSWORD: "test" },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stdout, /fixture-secret/);
  const [header, plan] = run.stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(header.model, "gpt-image-2.5-flare-special");
  assert.equal(header.maxRequests, 3);
  assert.deepEqual(plan.cases, [
    { tier: "4K", ratio: "16:9", size: "5120x2880", width: 512, height: 512 },
    { tier: "4K", ratio: "3:4", size: "2880x3840", width: 512, height: 512 },
    { tier: "2K", ratio: "16:9", size: "3648x2048", width: 512, height: 512 },
  ]);
});
