import { productCardCharLength } from "../../../shared/product-card";
import {
  PRODUCT_ONBOARDING_MAX_SUPPLIER_IMAGES,
  PRODUCT_ONBOARDING_MAX_TXT_FILE_BYTES,
  PRODUCT_ONBOARDING_MAX_TXT_FILES_PER_MESSAGE,
  type ProductOnboardingSession,
} from "../../../shared/product-onboarding";
import {
  readSupplierImageFiles,
  type ProductCardSupplierImageDraft,
} from "../products/ProductCardEditorForm";

// Reject NUL, disallowed C0 control chars (keeping \t, \n, \r), DEL, and Unicode replacement char.
const DISALLOWED_TEXT_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/;

export interface PendingTxtAttachment {
  localId: string;
  filename: string;
  byteLength: number;
  charCount: number;
  bytesBase64: string;
}

let txtSeq = 0;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export async function readTxtAttachmentFiles(
  fileList: FileList | File[],
  existing: PendingTxtAttachment[],
): Promise<{ added: PendingTxtAttachment[]; errors: string[] }> {
  const files = Array.from(fileList);
  const errors: string[] = [];
  const added: PendingTxtAttachment[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let remaining = Math.max(0, PRODUCT_ONBOARDING_MAX_TXT_FILES_PER_MESSAGE - existing.length);

  for (const file of files) {
    if (remaining <= 0) {
      errors.push(`单次发送最多上传 ${PRODUCT_ONBOARDING_MAX_TXT_FILES_PER_MESSAGE} 个 .txt 文件`);
      break;
    }
    const filename = file.name.trim();
    if (!filename || !/\.txt$/i.test(filename)) {
      errors.push(`「${file.name || "未命名文件"}」格式不支持，仅支持 .txt 纯文本文件`);
      continue;
    }
    if (file.size === 0) {
      errors.push(`「${filename}」内容为空，请重新选择`);
      continue;
    }
    if (file.size > PRODUCT_ONBOARDING_MAX_TXT_FILE_BYTES) {
      errors.push(`「${filename}」超过 200 KB 限制`);
      continue;
    }
    try {
      const buffer = await file.arrayBuffer();
      if (buffer.byteLength === 0) {
        errors.push(`「${filename}」内容为空，请重新选择`);
        continue;
      }
      if (buffer.byteLength > PRODUCT_ONBOARDING_MAX_TXT_FILE_BYTES) {
        errors.push(`「${filename}」超过 200 KB 限制`);
        continue;
      }
      let decoded: string;
      try {
        decoded = decoder.decode(buffer);
      } catch {
        errors.push(`「${filename}」不是有效的 UTF-8 编码纯文本文件`);
        continue;
      }
      if (decoded.startsWith("\uFEFF")) {
        decoded = decoded.slice(1);
      }
      if (DISALLOWED_TEXT_CONTROL_RE.test(decoded)) {
        errors.push(`「${filename}」包含非法二进制或控制字符，仅支持 UTF-8 纯文本`);
        continue;
      }
      if (!decoded.trim()) {
        errors.push(`「${filename}」内容为空，请重新选择`);
        continue;
      }
      txtSeq += 1;
      added.push({
        localId: `txt:${Date.now()}-${txtSeq}`,
        filename,
        byteLength: buffer.byteLength,
        charCount: productCardCharLength(decoded),
        bytesBase64: arrayBufferToBase64(buffer),
      });
      remaining -= 1;
    } catch {
      errors.push(`读取「${filename}」失败，请重试`);
    }
  }

  return { added, errors };
}

export async function readComposerSupplierImages(
  fileList: FileList | File[],
  pendingImages: ProductCardSupplierImageDraft[],
  existingSessionImages: ProductCardSupplierImageDraft[] = [],
): Promise<{ added: ProductCardSupplierImageDraft[]; errors: string[] }> {
  const combinedExisting = [...existingSessionImages, ...pendingImages];
  const { added, errors } = await readSupplierImageFiles(fileList, combinedExisting);
  const remaining = Math.max(0, PRODUCT_ONBOARDING_MAX_SUPPLIER_IMAGES - combinedExisting.length);
  if (added.length <= remaining) {
    return { added, errors };
  }
  return {
    added: added.slice(0, remaining),
    errors: [...errors, `同一建档会话最多累计上传 ${PRODUCT_ONBOARDING_MAX_SUPPLIER_IMAGES} 张供应商参考图`],
  };
}

export function supplierImagesFromSession(
  session: ProductOnboardingSession,
): ProductCardSupplierImageDraft[] {
  return [...session.supplierImages]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((img) => ({
      kind: "existing",
      localId: `existing:${img.id}`,
      imageId: img.id,
      filename: img.originalFilename,
      mimeType: img.mimeType,
      previewUrl: img.thumbnailPreviewUrl,
      originalPreviewUrl: img.originalPreviewUrl,
      sha256: img.sha256,
    }));
}

export function formatShortDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  const pad = (n: number) => String(n).padStart(2, "0");
  const md = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return sameYear ? `${md} ${hm}` : `${date.getFullYear()}-${md} ${hm}`;
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 10 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`;
}
