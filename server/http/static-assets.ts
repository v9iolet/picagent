import { readFile, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

export function resolveStaticAsset(requestTarget: string) {
  let pathname: string;
  try {
    pathname = decodeURIComponent(requestTarget.split(/[?#]/, 1)[0]);
  } catch {
    return null;
  }
  if (!pathname.startsWith("/") || pathname.startsWith("//") || pathname.includes("\\") ||
      pathname.includes("\0") || pathname.split("/").includes("..")) return null;

  // /assets and /assets/ open the image library. Files below it are build assets.
  const inAssets = pathname.startsWith("/assets/") && pathname !== "/assets/";
  const file = !inAssets && !extname(pathname) ? "index.html" : pathname.slice(1);
  let cacheControl = "public, max-age=3600";
  if (basename(file) === "index.html") {
    cacheControl = "no-cache";
  } else if (inAssets && /-[\w-]{8}\.[\w.]+$/.test(basename(file))) {
    // Vite's default filenames end with an eight-character URL-safe hash.
    cacheControl = "public, max-age=31536000, immutable";
  }
  return { file, contentType: mimeTypes[extname(file).toLowerCase()] ?? "application/octet-stream", cacheControl };
}

export function createStaticAssetHandler(staticRoot: string) {
  return async (requestTarget: string) => {
    const asset = resolveStaticAsset(requestTarget);
    if (!asset) return null;
    try {
      const root = await realpath(staticRoot);
      const target = await realpath(resolve(root, asset.file));
      const fromRoot = relative(root, target);
      if (!fromRoot || isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(".." + sep)) return null;
      return { bytes: await readFile(target), contentType: asset.contentType, cacheControl: asset.cacheControl };
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
      throw error;
    }
  };
}
