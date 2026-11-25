import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { resolveClosestImageSize, type ImageOptions } from "../../shared/model-settings.js";
import { selectAplusGenerationSize } from "../aplus/aplus-image.js";
import type { ImageEditCommand, ImageSource, MaskSnapshot, OutpaintSpec } from "../image-editor.js";
import type { ImageProvider, StorageAdapter } from "../types.js";

export async function requestImageEditorEdit(
  provider: ImageProvider,
  storage: StorageAdapter,
  model: string,
  options: ImageOptions,
  command: ImageEditCommand,
  source: ImageSource,
) {
  const outpaint = command.operations.find((operation) => operation.type === "outpaint")?.payload as OutpaintSpec | undefined;
  // Older snapshots omit the offset and replay with their original input.
  const canvas = outpaint?.sourceOffset ? outpaint : undefined;
  const size = source.aplus && !outpaint
    ? selectAplusGenerationSize(source.aplus.preset, source.aplus.resolution, options).size
    : resolveClosestImageSize(source.width, source.height, options, canvas?.targetRatio);
  let input = source;
  if (canvas) {
    const { left, top } = canvas.sourceOffset;
    const bytes = await sharp(source.bytes).extend({
      left, top,
      right: canvas.targetWidth - source.width - left,
      bottom: canvas.targetHeight - source.height - top,
      background: "#b0b0b0",
    }).png().toBuffer();
    input = { ...source, bytes, mimeType: "image/png", width: canvas.targetWidth, height: canvas.targetHeight };
  }

  let mask: Buffer | undefined;
  if (command.maskApplied !== false) {
    const maskedOperations = command.operations.filter((operation) =>
      operation.type === "redraw" || operation.type === "erase" || operation.payload.mask);
    if (maskedOperations.length > 1) throw new Error("MULTIPLE_MASK_OPERATIONS_UNSUPPORTED");
    if (maskedOperations[0]) {
      const metadata = maskedOperations[0].payload.mask as Partial<MaskSnapshot> | undefined;
      if (typeof metadata?.objectKey !== "string") throw new Error("MASK_SNAPSHOT_REQUIRED");
      const stored = await storage.get(metadata.objectKey);
      if (!stored || stored.contentType !== "image/png") throw new Error("MASK_OBJECT_NOT_FOUND");
      mask = stored.bytes;
    }
  }

  const images = [{ bytes: input.bytes, mimeType: input.mimeType, filename: "source.png", role: "source" }];
  for (const [index, attachment] of (command.attachedInputs ?? []).entries()) {
    const stored = await storage.get(attachment.objectKey);
    if (!stored) throw new Error("IMAGE_EDIT_ATTACHED_INPUT_NOT_FOUND");
    images.push({ bytes: stored.bytes, mimeType: stored.contentType, filename: `input-${index + 1}`, role: attachment.role });
  }
  const result = await provider.edit({
    requestId: randomUUID(), flow: "image-editor", endpoint: "/v1/images/edits",
    image: input.bytes, imageMimeType: input.mimeType, imageFilename: images[0].filename,
    images, model, prompt: command.prompt, size,
    quality: options.quality ?? "high", n: 1, responseFormat: "b64_json",
    ...(mask ? { mask, maskMimeType: "image/png", maskFilename: "mask.png" } : {}),
  });
  const metadata = await sharp(result.bytes).metadata();
  return { bytes: result.bytes, mimeType: result.mimeType, width: metadata.width ?? input.width, height: metadata.height ?? input.height };
}
