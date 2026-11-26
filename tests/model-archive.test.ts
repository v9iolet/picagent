import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { resolveModelArchiveMode } from "../server/prompt-archive.js";
import { DashScopeLlmClient } from "../server/providers/dashscope-llm-client.js";
import { GptImageProvider } from "../server/providers/gpt-image-provider.js";

const visionBytes = Buffer.from("vision-bytes");
const sourceBytes = Buffer.from("source-image");
const generatedBytes = Buffer.from("generated-image-bytes");

async function configureArchive(t: TestContext, mode?: string, nodeEnv = "test") {
  const root = await mkdtemp(join(tmpdir(), "model-archive-test-"));
  const directory = join(root, "archives");
  const previousEnv = process.env;
  process.env = { ...previousEnv, MODEL_ARCHIVE_DIR: directory, NODE_ENV: nodeEnv };
  if (mode === undefined) delete process.env.MODEL_ARCHIVE_MODE;
  else process.env.MODEL_ARCHIVE_MODE = mode;
  t.after(async () => {
    process.env = previousEnv;
    await rm(root, { recursive: true, force: true });
  });
  return directory;
}

async function archiveFiles(directory: string) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

function editImage() {
  return new GptImageProvider("https://example.test", "secret").edit({
    requestId: "archive-image", flow: "suite-task-generation", endpoint: "/v1/images/edits",
    image: sourceBytes, imageMimeType: "image/png", imageFilename: "source.png",
    model: "gpt-image-2", prompt: "keep the product unchanged", size: "1K",
    quality: "medium", n: 1, responseFormat: "b64_json",
  });
}

async function runProviders(t: TestContext) {
  const fetcher = t.mock.method(globalThis, "fetch", async (url: URL) => {
    if (url.pathname === "/v1/chat/completions") {
      return Response.json({
        id: "chat-1", choices: [{ message: { content: JSON.stringify({ schemaVersion: "suite-plan-v1", items: [] }) } }],
        usage: { total_tokens: 12 },
      });
    }
    assert.equal(url.pathname, "/v1/images/edits");
    return Response.json({ data: [{ b64_json: generatedBytes.toString("base64") }] });
  });
  await new DashScopeLlmClient("https://example.test/v1/", "secret", "qwen3.8-max").generatePlan({
    requestId: "archive-plan",
    templateVersionId: "template-1",
    templateBody: "system prompt",
    userPromptTemplate: "商品={{dynamic_input}}",
    dynamicInput: { product: "mouse" },
    humanInput: {},
    chunks: [],
    inputImageIds: ["input-1"],
    baseVersionIds: ["base-1"],
    visionImages: [{ id: "input-1", sourceKind: "base", sourceVersionId: "base-1", mimeType: "image/png", bytes: visionBytes }],
  });
  assert.deepEqual(await editImage(), { bytes: generatedBytes, mimeType: "image/png" });
  fetcher.mock.restore();
}

test("full mode archives multimodal plan and image generation inputs and responses", async (t) => {
  const directory = await configureArchive(t, "full", "production");
  await runProviders(t);
  const files = await archiveFiles(directory);
  const planRequest = await readFile(files.find((file) => /multimodal-plan.*_request\.json$/.test(file))!, "utf8");
  assert.match(planRequest, /system prompt/);
  assert.match(planRequest, /archive-input-1/);
  assert.doesNotMatch(planRequest, /data:image\/png;base64/);
  assert.deepEqual(await readFile(files.find((file) => /multimodal-plan.*_input-01-/.test(file))!), visionBytes);
  assert.match(await readFile(files.find((file) => /multimodal-plan.*_response\.json$/.test(file))!, "utf8"), /suite-plan-v1/);

  const imageRequest = await readFile(files.find((file) => /image-generation.*_request\.json$/.test(file))!, "utf8");
  assert.match(imageRequest, /keep the product unchanged/);
  assert.ok(files.some((file) => /image-generation.*_response\.json$/.test(file)));
  assert.deepEqual(await readFile(files.find((file) => /image-generation.*_input-01-/.test(file))!), sourceBytes);
  assert.deepEqual(await readFile(files.find((file) => /image-generation.*_output-01-/.test(file))!), generatedBytes);
});

test("off mode skips all archive writes for successful and failed calls", async (t) => {
  const directory = await configureArchive(t, "off");
  await runProviders(t);
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 500 }));
  await assert.rejects(editImage(), { message: "IMAGE_PROVIDER_FAILED" });
  await assert.rejects(readdir(directory), { code: "ENOENT" });
});

test("metadata mode writes only JSON and retains input and output file details", async (t) => {
  const directory = await configureArchive(t, "  MeTaDaTa  ");
  await runProviders(t);
  const files = await archiveFiles(directory);
  assert.equal(files.length, 4);
  async function metadata(suffix: string) {
    const path = files.find((file) => file.endsWith(suffix));
    assert.ok(path, suffix);
    return JSON.parse(await readFile(path, "utf8")).files;
  }
  assert.deepEqual(await metadata("archive-plan_request.json"), [
    { label: "input-1-base", mimeType: "image/png", byteLength: visionBytes.length },
  ]);
  assert.deepEqual(await metadata("archive-plan_response.json"), []);
  assert.deepEqual(await metadata("archive-image_request.json"), [
    { label: "product", mimeType: "image/png", byteLength: sourceBytes.length },
  ]);
  assert.deepEqual(await metadata("archive-image_response.json"), [
    { label: "generated-image", mimeType: "image/png", byteLength: generatedBytes.length },
  ]);
});

test("production defaults to off when the mode is unset", async (t) => {
  const directory = await configureArchive(t, undefined, "production");
  await runProviders(t);
  await assert.rejects(readdir(directory), { code: "ENOENT" });
});

test("invalid modes use the environment default and warn only once", async (t) => {
  const directory = await configureArchive(t, "invalid", "production");
  const warning = t.mock.method(console, "warn", () => {});
  await runProviders(t);
  await assert.rejects(readdir(directory), { code: "ENOENT" });
  assert.equal(warning.mock.callCount(), 1);
  assert.match(String(warning.mock.calls[0].arguments[0]), /MODEL_ARCHIVE_MODE/);
  process.env.NODE_ENV = "development";
  assert.equal(resolveModelArchiveMode(), "full");
  assert.equal(warning.mock.callCount(), 1);
});
