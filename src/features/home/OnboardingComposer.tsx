import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { productCardCharLength } from "../../../shared/product-card";
import {
  PRODUCT_ONBOARDING_MAX_MESSAGE_CHARS,
  PRODUCT_ONBOARDING_MAX_SUPPLIER_IMAGES,
  PRODUCT_ONBOARDING_MAX_TXT_FILES_PER_MESSAGE,
} from "../../../shared/product-onboarding";
import { Icon } from "../../pages/shared";
import type { ProductCardSupplierImageDraft } from "../products/ProductCardEditorForm";
import {
  formatByteSize,
  readComposerSupplierImages,
  readTxtAttachmentFiles,
  type PendingTxtAttachment,
} from "./onboarding-attachments";

function countUniqueSupplierImages(
  existing: ProductCardSupplierImageDraft[],
  pending: ProductCardSupplierImageDraft[],
): number {
  const seenHashes = new Set<string>();
  let count = 0;
  for (const image of [...existing, ...pending]) {
    if (image.sha256) {
      if (seenHashes.has(image.sha256)) continue;
      seenHashes.add(image.sha256);
    }
    count += 1;
  }
  return count;
}

export interface OnboardingComposerProps {
  variant: "hero" | "reply";
  message: string;
  onMessageChange: (next: string) => void;
  pendingImages: ProductCardSupplierImageDraft[];
  onPendingImagesChange: (next: ProductCardSupplierImageDraft[]) => void;
  pendingTxtFiles: PendingTxtAttachment[];
  onPendingTxtFilesChange: (next: PendingTxtAttachment[]) => void;
  existingSessionImages?: ProductCardSupplierImageDraft[];
  sending: boolean;
  onSubmit: () => void | Promise<void>;
  placeholder: string;
  submitLabel: string;
  sendingLabel?: string;
  ariaLabel?: string;
}

export function OnboardingComposer({
  variant,
  message,
  onMessageChange,
  pendingImages,
  onPendingImagesChange,
  pendingTxtFiles,
  onPendingTxtFilesChange,
  existingSessionImages = [],
  sending,
  onSubmit,
  placeholder,
  submitLabel,
  sendingLabel = "分析提取中…",
  ariaLabel = "商品建档输入框",
}: OnboardingComposerProps) {
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const txtInputRef = useRef<HTMLInputElement | null>(null);
  const mountedRef = useRef(true);
  const sendingRef = useRef(sending);
  const pendingImagesRef = useRef(pendingImages);
  const pendingTxtFilesRef = useRef(pendingTxtFiles);
  const existingSessionImagesRef = useRef(existingSessionImages);
  const onPendingImagesChangeRef = useRef(onPendingImagesChange);
  const onPendingTxtFilesChangeRef = useRef(onPendingTxtFilesChange);

  sendingRef.current = sending;
  pendingImagesRef.current = pendingImages;
  pendingTxtFilesRef.current = pendingTxtFiles;
  existingSessionImagesRef.current = existingSessionImages;
  onPendingImagesChangeRef.current = onPendingImagesChange;
  onPendingTxtFilesChangeRef.current = onPendingTxtFilesChange;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const [validationError, setValidationError] = useState("");
  const [dragging, setDragging] = useState(false);

  const totalUniqueImages = useMemo(
    () => countUniqueSupplierImages(existingSessionImages, pendingImages),
    [existingSessionImages, pendingImages],
  );
  const tooManyImages = totalUniqueImages > PRODUCT_ONBOARDING_MAX_SUPPLIER_IMAGES;
  const remainingImageSlots = Math.max(
    0,
    PRODUCT_ONBOARDING_MAX_SUPPLIER_IMAGES - totalUniqueImages,
  );
  const remainingTxtSlots = Math.max(
    0,
    PRODUCT_ONBOARDING_MAX_TXT_FILES_PER_MESSAGE - pendingTxtFiles.length,
  );

  const charCount = productCardCharLength(message.trim());
  const messageTooLong = charCount > PRODUCT_ONBOARDING_MAX_MESSAGE_CHARS;
  const hasPayload =
    message.trim().length > 0 || pendingImages.length > 0 || pendingTxtFiles.length > 0;
  const canSubmit = hasPayload && !messageTooLong && !tooManyImages && !sending;

  const mergeAddedImages = (
    added: ProductCardSupplierImageDraft[],
    initialErrors: string[],
  ): string[] => {
    const latestPending = pendingImagesRef.current;
    const latestExisting = existingSessionImagesRef.current;
    const latestHashes = new Set<string>(
      [...latestExisting, ...latestPending]
        .map((item) => item.sha256)
        .filter((hash): hash is string => Boolean(hash)),
    );
    const currentUniqueCount = countUniqueSupplierImages(latestExisting, latestPending);
    const remainingSlots = Math.max(0, PRODUCT_ONBOARDING_MAX_SUPPLIER_IMAGES - currentUniqueCount);
    const nextErrors = [...initialErrors];
    const safeAdded: ProductCardSupplierImageDraft[] = [];

    for (const item of added) {
      if (item.sha256 && latestHashes.has(item.sha256)) {
        nextErrors.push(`「${item.filename}」与已有图片重复，已自动去重`);
        continue;
      }
      if (safeAdded.length >= remainingSlots) {
        nextErrors.push(
          `同一建档会话最多累计上传 ${PRODUCT_ONBOARDING_MAX_SUPPLIER_IMAGES} 张供应商参考图`,
        );
        break;
      }
      if (item.sha256) latestHashes.add(item.sha256);
      safeAdded.push(item);
    }

    if (safeAdded.length > 0) {
      const merged = [...latestPending, ...safeAdded];
      pendingImagesRef.current = merged;
      onPendingImagesChangeRef.current(merged);
    }
    return nextErrors;
  };

  const mergeAddedTxtFiles = (
    added: PendingTxtAttachment[],
    initialErrors: string[],
  ): string[] => {
    const latestTxt = pendingTxtFilesRef.current;
    const remainingSlots = Math.max(
      0,
      PRODUCT_ONBOARDING_MAX_TXT_FILES_PER_MESSAGE - latestTxt.length,
    );
    const nextErrors = [...initialErrors];
    const safeAdded = added.slice(0, remainingSlots);
    if (added.length > remainingSlots) {
      nextErrors.push(
        `单次发送最多上传 ${PRODUCT_ONBOARDING_MAX_TXT_FILES_PER_MESSAGE} 个 .txt 文件`,
      );
    }
    if (safeAdded.length > 0) {
      const merged = [...latestTxt, ...safeAdded];
      pendingTxtFilesRef.current = merged;
      onPendingTxtFilesChangeRef.current(merged);
    }
    return nextErrors;
  };

  const handleImageFiles = async (files: FileList | File[] | null) => {
    if (!files || files.length === 0 || sendingRef.current) return;
    setValidationError("");
    const { added, errors } = await readComposerSupplierImages(
      files,
      pendingImagesRef.current,
      existingSessionImagesRef.current,
    );
    if (imageInputRef.current) {
      imageInputRef.current.value = "";
    }
    if (!mountedRef.current || sendingRef.current) return;
    const finalErrors = mergeAddedImages(added, errors);
    if (finalErrors.length > 0) {
      setValidationError(finalErrors.join("；"));
    }
  };

  const handleTxtFiles = async (files: FileList | File[] | null) => {
    if (!files || files.length === 0 || sendingRef.current) return;
    setValidationError("");
    const { added, errors } = await readTxtAttachmentFiles(files, pendingTxtFilesRef.current);
    if (txtInputRef.current) {
      txtInputRef.current.value = "";
    }
    if (!mountedRef.current || sendingRef.current) return;
    const finalErrors = mergeAddedTxtFiles(added, errors);
    if (finalErrors.length > 0) {
      setValidationError(finalErrors.join("；"));
    }
  };

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (sendingRef.current) return;
    const dropped = Array.from(event.dataTransfer.files);
    if (dropped.length === 0) return;

    const txtCandidates: File[] = [];
    const imageCandidates: File[] = [];
    const unsupported: string[] = [];

    for (const file of dropped) {
      if (/\.txt$/i.test(file.name) || file.type === "text/plain") {
        txtCandidates.push(file);
      } else if (
        file.type.startsWith("image/") ||
        /\.(?:jpe?g|png|webp)$/i.test(file.name)
      ) {
        imageCandidates.push(file);
      } else {
        unsupported.push(`「${file.name}」不支持，仅支持 JPG/PNG/WebP 图片或 .txt 纯文本`);
      }
    }

    const combinedErrors = [...unsupported];
    if (imageCandidates.length > 0) {
      const res = await readComposerSupplierImages(
        imageCandidates,
        pendingImagesRef.current,
        existingSessionImagesRef.current,
      );
      if (!mountedRef.current || sendingRef.current) return;
      combinedErrors.push(...mergeAddedImages(res.added, res.errors));
    }
    if (txtCandidates.length > 0) {
      const res = await readTxtAttachmentFiles(txtCandidates, pendingTxtFilesRef.current);
      if (!mountedRef.current || sendingRef.current) return;
      combinedErrors.push(...mergeAddedTxtFiles(res.added, res.errors));
    }
    if (!mountedRef.current || sendingRef.current) return;
    setValidationError(combinedErrors.join("；"));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (canSubmit) {
      void onSubmit();
    }
  };

  const handleTriggerSubmit = () => {
    if (!canSubmit) return;
    setValidationError("");
    void onSubmit();
  };

  const hasAttachments = pendingImages.length > 0 || pendingTxtFiles.length > 0;

  return (
    <div
      className={`home-composer is-${variant} ${dragging ? "is-dragging" : ""}`}
      onDragOver={(event) => {
        event.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => void handleDrop(event)}
    >
      <textarea
        className="home-composer-textarea"
        aria-label={ariaLabel}
        rows={variant === "hero" ? 4 : 3}
        value={message}
        disabled={sending}
        placeholder={placeholder}
        onChange={(event) => onMessageChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />

      {hasAttachments && (
        <div className="home-composer-attachments" aria-label="待发送附件">
          {pendingImages.map((img) => (
            <div className="home-pending-image" key={img.localId} data-pending-image={img.filename}>
              <img src={img.previewUrl} alt={img.filename} />
              <span className="home-pending-image-name" title={img.filename}>
                {img.filename}
              </span>
              <button
                type="button"
                className="home-pending-remove"
                aria-label={`移除供应商图 ${img.filename}`}
                disabled={sending}
                onClick={() =>
                  onPendingImagesChange(pendingImages.filter((item) => item.localId !== img.localId))
                }
              >
                <Icon name="x" />
              </button>
            </div>
          ))}

          {pendingTxtFiles.map((txt) => (
            <div className="home-pending-txt" key={txt.localId} data-pending-txt={txt.filename}>
              <Icon name="files" />
              <div className="home-pending-txt-meta">
                <strong title={txt.filename}>{txt.filename}</strong>
                <span>
                  {txt.charCount} 字 · {formatByteSize(txt.byteLength)}
                </span>
              </div>
              <button
                type="button"
                className="home-pending-remove"
                aria-label={`移除文本附件 ${txt.filename}`}
                disabled={sending}
                onClick={() =>
                  onPendingTxtFilesChange(
                    pendingTxtFiles.filter((item) => item.localId !== txt.localId),
                  )
                }
              >
                <Icon name="x" />
              </button>
            </div>
          ))}
        </div>
      )}

      {(validationError || messageTooLong || tooManyImages) && (
        <div className="home-composer-error" role="alert">
          <Icon name="alert" />
          <span>
            {messageTooLong
              ? `单条消息不能超过 ${PRODUCT_ONBOARDING_MAX_MESSAGE_CHARS} 字（当前 ${charCount} 字）`
              : tooManyImages
                ? `同一建档会话最多累计上传 ${PRODUCT_ONBOARDING_MAX_SUPPLIER_IMAGES} 张供应商参考图（当前去重后 ${totalUniqueImages} 张），请移除多余图片后再发送`
                : validationError}
          </span>
        </div>
      )}

      <div className="home-composer-toolbar">
        <div className="home-composer-tools">
          <input
            ref={imageInputRef}
            type="file"
            className="home-hidden-file-input"
            aria-label="选择供应商参考图"
            accept="image/jpeg,image/png,image/webp"
            multiple
            disabled={sending || remainingImageSlots <= 0}
            onChange={(event) => void handleImageFiles(event.target.files)}
          />
          <button
            type="button"
            className="home-tool-btn"
            disabled={sending || remainingImageSlots <= 0}
            title={
              remainingImageSlots <= 0
                ? `已达 ${PRODUCT_ONBOARDING_MAX_SUPPLIER_IMAGES} 张供应商参考图上限`
                : `添加供应商参考图（还可添加 ${remainingImageSlots} 张）`
            }
            onClick={() => imageInputRef.current?.click()}
          >
            <Icon name="image" />
            <span>
              ＋ 供应商图
              {totalUniqueImages > 0
                ? ` (${totalUniqueImages}/${PRODUCT_ONBOARDING_MAX_SUPPLIER_IMAGES})`
                : ""}
            </span>
          </button>

          <input
            ref={txtInputRef}
            type="file"
            className="home-hidden-file-input"
            aria-label="上传 .txt 文本附件"
            accept=".txt,text/plain"
            multiple
            disabled={sending || remainingTxtSlots <= 0}
            onChange={(event) => void handleTxtFiles(event.target.files)}
          />
          <button
            type="button"
            className="home-tool-btn"
            disabled={sending || remainingTxtSlots <= 0}
            title={
              remainingTxtSlots <= 0
                ? `单次最多上传 ${PRODUCT_ONBOARDING_MAX_TXT_FILES_PER_MESSAGE} 个 .txt 文件`
                : `上传 UTF-8 纯文本说明（单文件 ≤ 200 KB，最多 ${PRODUCT_ONBOARDING_MAX_TXT_FILES_PER_MESSAGE} 个）`
            }
            onClick={() => txtInputRef.current?.click()}
          >
            <Icon name="files" />
            <span>
              上传 .txt
              {pendingTxtFiles.length > 0
                ? ` (${pendingTxtFiles.length}/${PRODUCT_ONBOARDING_MAX_TXT_FILES_PER_MESSAGE})`
                : ""}
            </span>
          </button>
        </div>

        <div className="home-composer-submit-group">
          <span className={`home-composer-hint ${messageTooLong ? "is-over" : ""}`}>
            {charCount > 0 ? `${charCount}/${PRODUCT_ONBOARDING_MAX_MESSAGE_CHARS}` : "Enter 发送 · Shift+Enter 换行"}
          </span>
          <button
            type="button"
            className="btn btn-primary home-composer-send-btn"
            disabled={!canSubmit}
            onClick={handleTriggerSubmit}
          >
            <Icon name="send" />
            <span>{sending ? sendingLabel : submitLabel}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
