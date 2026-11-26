import { useEffect, useState } from "react";
import {
  PRODUCT_CARD_ALLOWED_IMAGE_MIMES,
  PRODUCT_CARD_MAX_IMAGE_BYTES,
  type ProductCardAllowedImageMime,
} from "../../shared/product-card";

export const IMAGE_UPLOAD_ACCEPT = PRODUCT_CARD_ALLOWED_IMAGE_MIMES.join(",");

export function imageMimeType(file: File, fallback: "missing-type" | "any-type" = "missing-type"): ProductCardAllowedImageMime | null {
  const declaredType = file.type.trim().toLowerCase();
  const mime = PRODUCT_CARD_ALLOWED_IMAGE_MIMES.find((type) => type === declaredType);
  if (mime) return mime;
  if (fallback === "missing-type" && declaredType && declaredType !== "application/octet-stream") return null;
  if (/\.jpe?g$/i.test(file.name)) return "image/jpeg";
  if (/\.png$/i.test(file.name)) return "image/png";
  if (/\.webp$/i.test(file.name)) return "image/webp";
  return null;
}

interface UploadLimits {
  existingCount: number;
  maxCount: number;
  maxBytes?: number;
  countMessage?: string;
}

export function prepareImageUpload(files: readonly File[], limits: UploadLimits) {
  const { existingCount, maxCount, maxBytes = PRODUCT_CARD_MAX_IMAGE_BYTES } = limits;
  if (existingCount + files.length > maxCount) {
    throw new Error(limits.countMessage ?? `最多上传 ${maxCount} 张图片。`);
  }
  return files.map((file) => {
    const type = imageMimeType(file);
    if (!type) throw new Error("请上传 PNG、JPEG 或 WebP 格式的图片。");
    if (file.size === 0) throw new Error("图片文件为空");
    if (file.size > maxBytes) throw new Error(`图片文件超过 ${maxBytes / (1024 * 1024)}MB 限制`);
    // Multipart uploads send File.type, including for files identified by extension.
    return type === file.type ? file : new File([file], file.name, { type, lastModified: file.lastModified });
  });
}

export function createImagePreviews() {
  const urls = new Set<string>();
  function release(url: string) {
    if (urls.delete(url)) URL.revokeObjectURL(url);
  }
  return {
    create(file: File) {
      const url = URL.createObjectURL(file);
      urls.add(url);
      return url;
    },
    release,
    clear() { urls.forEach(release); },
  };
}

export function useImageUpload(limits: UploadLimits) {
  const [previews] = useState(createImagePreviews);
  useEffect(() => previews.clear, [previews]);
  return { prepareFiles: (files: readonly File[]) => prepareImageUpload(files, limits), previews };
}
