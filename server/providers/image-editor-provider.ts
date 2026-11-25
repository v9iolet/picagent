import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { resolveClosestImageSize, type ImageOptions } from "../../shared/model-settings.js";
import type { ImageEditCommand, ImageSource, MaskSnapshot } from "../image-editor.js";
import type { ImageProvider, StorageAdapter } from "../types.js";

export async function requestImageEditorEdit(
  provider: ImageProvider,
  storage: StorageAdapter,
  model: string,
  options: ImageOptions,
  command: ImageEditCommand,
  source: ImageSource,
) {
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

  const images = [{ bytes: source.bytes, mimeType: source.mimeType, filename: "source.png", role: "source" }];
  for (const [index, input] of (command.attachedInputs ?? []).entries()) {
    const stored = await storage.get(input.objectKey);
    if (!stored) throw new Error("IMAGE_EDIT_ATTACHED_INPUT_NOT_FOUND");
    images.push({ bytes: stored.bytes, mimeType: stored.contentType, filename: `input-${index + 1}`, role: input.role });
  }
  const result = await provider.edit({
    requestId: randomUUID(), flow: "image-editor", endpoint: "/v1/images/edits",
    image: source.bytes, imageMimeType: source.mimeType, imageFilename: images[0].filename,
    images, model, prompt: command.prompt, size: resolveClosestImageSize(source.width, source.height, options),
    quality: options.quality ?? "high", n: 1, responseFormat: "b64_json",
    mask, maskMimeType: mask ? "image/png" : undefined, maskFilename: mask ? "mask.png" : undefined,
  });
  const metadata = await sharp(result.bytes).metadata();
  return { bytes: result.bytes, mimeType: result.mimeType, width: metadata.width ?? source.width, height: metadata.height ?? source.height };
}
