import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStaticAssetHandler, resolveStaticAsset } from "../server/http/static-assets.js";

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "picagent-static-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "dist");
  await mkdir(join(root, "assets"), { recursive: true });
  return { directory, root, serve: createStaticAssetHandler(root) };
}

test("hashed bundles are immutable and ordinary static files cache for one hour", async (t) => {
  const { root, serve } = await fixture(t);
  for (const [file, expectedCache] of [
    ["assets/index-Ba3_-1qZ.js", "public, max-age=31536000, immutable"],
    ["assets/index-Abc12345.css", "public, max-age=31536000, immutable"],
    ["assets/suite-workbench.css", "public, max-age=3600"],
    ["assets/gan65-product.jpg", "public, max-age=3600"],
    ["logo-Abc12345.png", "public, max-age=3600"],
  ]) {
    const bytes = Buffer.from([0, 127, 255]);
    await writeFile(join(root, file), bytes);
    const asset = await serve("/" + file + "?v=1");
    assert.equal(asset?.cacheControl, expectedCache, file);
    assert.deepEqual(asset.bytes, bytes);
  }
});

test("the index and client-side routes return the same HTML with no-cache", async (t) => {
  const { root, serve } = await fixture(t);
  await writeFile(join(root, "index.html"), "<main>工作台</main>");
  for (const route of ["/", "/index.html", "/assets", "/assets/", "/create/suite?tab=result"]) {
    const asset = await serve(route);
    assert.equal(asset?.contentType, "text/html; charset=utf-8", route);
    assert.equal(asset.cacheControl, "no-cache", route);
    assert.equal(asset.bytes.toString(), "<main>工作台</main>", route);
  }
});

test("static file extensions select the content type", () => {
  for (const [extension, contentType] of Object.entries({
    js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8",
    html: "text/html; charset=utf-8", png: "image/png", jpg: "image/jpeg",
    jpeg: "image/jpeg", svg: "image/svg+xml", webp: "image/webp", ico: "image/x-icon",
    json: "application/json; charset=utf-8", woff2: "font/woff2", map: "application/json; charset=utf-8",
    bin: "application/octet-stream",
  })) {
    assert.equal(resolveStaticAsset("/file." + extension)?.contentType, contentType, extension);
  }
});

test("only files inside the static root can be served", async (t) => {
  const { directory, root, serve } = await fixture(t);
  await writeFile(join(root, "index.html"), "index");
  await writeFile(join(directory, "outside.txt"), "outside");
  await symlink(join(directory, "outside.txt"), join(root, "link.txt"));
  for (const path of ["/../outside.txt", "/assets/../index.html", "/%2e%2e/settings", "/..%5Coutside.txt", "/link.txt", "/%ZZ"]) {
    assert.equal(await serve(path), null, path);
  }
});

test("missing files and a missing SPA entry return no asset", async (t) => {
  const { root, serve } = await fixture(t);
  assert.equal(await serve("/create/suite"), null);
  await writeFile(join(root, "index.html"), "index");
  for (const path of ["/assets/missing-AB123456.js", "/assets/missing", "/missing.png"]) {
    assert.equal(await serve(path), null, path);
  }
});
