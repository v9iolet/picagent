import sharp from "sharp";
import { APLUS_SIZE_PRESETS, type AplusImageSize, type AplusSizePresetKey } from "../../shared/aplus.js";
import { matchNearestAspectRatio, resolveImageSize, type ImageOptions } from "../../shared/model-settings.js";
import type { StorageAdapter } from "../types.js";

export function selectAplusGenerationSize(preset: AplusSizePresetKey, resolution: "1K" | "2K", options: ImageOptions) {
  const supported = options.sizes.filter((size) => size === "1K" || size === "2K");
  const tier = preset === "aplus_premium_web" ? "1K" : supported.includes(resolution) ? resolution : supported[0];
  if (!tier || !supported.includes(tier)) throw new Error("IMAGE_SIZE_UNSUPPORTED");

  const presetRatio = APLUS_SIZE_PRESETS[preset].ratio;
  const [presetWidth, presetHeight] = presetRatio.split(":").map(Number);
  const ratio = options.sizeMode === "pixels" ? presetRatio : matchNearestAspectRatio(presetWidth, presetHeight, options.aspectRatios);
  const [width, height] = resolveImageSize(tier, ratio, "pixels").split("x").map(Number);
  return { tier, ratio, size: resolveImageSize(tier, ratio, options.sizeMode), generatedSize: { width, height } };
}

export async function storeAplusDelivery(
  storage: StorageAdapter,
  preset: AplusSizePresetKey,
  generated: AplusImageSize & { bytes: Buffer },
  objectKey: string,
) {
  const generatedSize = { width: generated.width, height: generated.height };
  const deliverySize = APLUS_SIZE_PRESETS[preset].deliverySize;
  if (!deliverySize) return { generatedSize, deliverySize: generatedSize, deliveryObjectKey: objectKey };

  const deliveryObjectKey = objectKey.replace(/\.png$/, ".delivery.png");
  const bytes = await sharp(generated.bytes).rotate().resize({ ...deliverySize, fit: "cover", position: "centre" }).png().toBuffer();
  await storage.put({ key: deliveryObjectKey, bytes, contentType: "image/png" });
  return { generatedSize, deliverySize, deliveryObjectKey };
}
