import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
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
  sendingLabel = "提取中…",
  ariaLabel = "商品建档输入框",
}: OnboardingComposerProps) {
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const txtInputRef = useRef<HTMLInputElement | null>(null);
  const plusWrapRef = useRef<HTMLDivElement | null>(null);
  const plusBtnRef = useRef<HTMLButtonElement | null>(null);
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
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (sending && menuOpen) {
      setMenuOpen(false);
    }
  }, [sending, menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && plusWrapRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setMenuOpen(false);
      plusBtnRef.current?.focus({ preventScroll: true });
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [menuOpen]);

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
  const showCharCount =
    messageTooLong || charCount >= Math.ceil(PRODUCT_ONBOARDING_MAX_MESSAGE_CHARS * 0.85);
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

  const handleMixedFiles = async (files: File[]) => {
    if (files.length === 0 || sendingRef.current) return;
    setValidationError("");

    const txtCandidates: File[] = [];
    const imageCandidates: File[] = [];
    const unsupported: string[] = [];

    for (const file of files) {
      if (/\.txt$/i.test(file.name) || file.type === "text/plain") {
        txtCandidates.push(file);
      } else if (
        file.type.startsWith("image/") ||
        /\.(?:jpe?g|png|webp)$/i.test(file.name)
      ) {
        imageCandidates.push(file);
      } else {
        unsupported.push(`「${file.name || "未命名文件"}」不支持，仅支持 JPG/PNG/WebP 图片或 .txt 纯文本`);
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

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (sendingRef.current) return;
    const dropped = Array.from(event.dataTransfer.files);
    await handleMixedFiles(dropped);
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (sendingRef.current) return;
    const clipboardFiles: File[] = [];
    if (event.clipboardData?.files?.length) {
      clipboardFiles.push(...Array.from(event.clipboardData.files));
    } else if (event.clipboardData?.items?.length) {
      for (const item of Array.from(event.clipboardData.items)) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) clipboardFiles.push(file);
        }
      }
    }
    if (clipboardFiles.length === 0) return;
    event.preventDefault();
    void handleMixedFiles(clipboardFiles);
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
    setMenuOpen(false);
    void onSubmit();
  };

  const handlePickImages = () => {
    setMenuOpen(false);
    imageInputRef.current?.click();
  };

  const handlePickTxt = () => {
    setMenuOpen(false);
    txtInputRef.current?.click();
  };

  const hasAttachments = pendingImages.length > 0 || pendingTxtFiles.length > 0;
  const imageSubtext =
    totalUniqueImages > 0
      ? `JPG/PNG/WebP，已传 ${totalUniqueImages}/${PRODUCT_ONBOARDING_MAX_SUPPLIER_IMAGES} 张`
      : `JPG/PNG/WebP，最多 ${PRODUCT_ONBOARDING_MAX_SUPPLIER_IMAGES} 张`;
  const txtSubtext =
    pendingTxtFiles.length > 0
      ? `.txt，≤200KB（已选 ${pendingTxtFiles.length}/${PRODUCT_ONBOARDING_MAX_TXT_FILES_PER_MESSAGE}）`
      : ".txt，≤200KB";

  return (
    <div
      className={`home-composer is-${variant} ${dragging ? "is-dragging" : ""}`}
      onDragOver={(event) => {
        event.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => void handleDrop(event)}
      onPaste={handlePaste}
    >
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
              <span className="home-pending-txt-name" title={txt.filename}>
                {txt.filename}
              </span>
              <span className="home-pending-txt-size">
                {txt.charCount} 字 · {formatByteSize(txt.byteLength)}
              </span>
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

      <textarea
        className="home-composer-textarea"
        aria-label={ariaLabel}
        rows={variant === "hero" ? 5 : 2}
        value={message}
        disabled={sending}
        placeholder={placeholder}
        onChange={(event) => onMessageChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />

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
        <div className="home-plus-menu-wrap" ref={plusWrapRef}>
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
            ref={plusBtnRef}
            type="button"
            className={`home-plus-trigger ${menuOpen ? "is-open" : ""}`}
            aria-label="添加附件"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            disabled={sending}
            onClick={() => setMenuOpen((prev) => !prev)}
          >
            <Icon name="plus" />
          </button>

          {menuOpen && (
            <div className="home-plus-popover" role="menu" aria-label="上传附件菜单">
              <button
                type="button"
                className="home-plus-menu-item"
                role="menuitem"
                disabled={sending || remainingImageSlots <= 0}
                onClick={handlePickImages}
              >
                <span className="home-plus-menu-icon">
                  <Icon name="image" />
                </span>
                <span className="home-plus-menu-copy">
                  <strong>上传供应商参考图</strong>
                  <span>{imageSubtext}</span>
                </span>
              </button>
              <button
                type="button"
                className="home-plus-menu-item"
                role="menuitem"
                disabled={sending || remainingTxtSlots <= 0}
                onClick={handlePickTxt}
              >
                <span className="home-plus-menu-icon">
                  <Icon name="files" />
                </span>
                <span className="home-plus-menu-copy">
                  <strong>上传文本资料</strong>
                  <span>{txtSubtext}</span>
                </span>
              </button>
            </div>
          )}
        </div>

        <div className="home-composer-submit-group">
          {showCharCount && (
            <span className={`home-composer-count ${messageTooLong ? "is-over" : ""}`}>
              {charCount}/{PRODUCT_ONBOARDING_MAX_MESSAGE_CHARS}
            </span>
          )}
          <button
            type="button"
            className={`home-send-icon-btn ${sending ? "is-loading" : ""}`}
            disabled={!canSubmit}
            aria-label={sending ? sendingLabel : submitLabel}
            title={sending ? sendingLabel : submitLabel}
            onClick={handleTriggerSubmit}
          >
            {sending ? (
              <span className="home-send-spinner" aria-hidden="true" />
            ) : (
              <Icon name="arrow-up" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
