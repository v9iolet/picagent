import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  PRODUCT_CARD_FIELD_LABELS,
  PRODUCT_CARD_FIELD_LIMITS,
  PRODUCT_CARD_MAX_IMAGE_BYTES,
  PRODUCT_CARD_MAX_SUPPLIER_IMAGES,
  PRODUCT_CARD_NO_EXTRA_ACCESSORIES_TEXT,
  productCardCharLength,
  validateProductCardFields,
  type ProductCard,
  type ProductCardFields,
  type ProductCardRequiredField,
} from "../../../shared/product-card";
import type {
  ApiProductCardNewImagePayload,
  ApiProductCardUpdateImagePayload,
} from "../../api/client";
import { InfoTip } from "../../components/ui/InfoTip";
import { IMAGE_UPLOAD_ACCEPT, imageMimeType } from "../../hooks/useImageUpload";
import { Icon } from "../../pages/shared";
import "./ProductCardEditorForm.css";

export type ProductCardSupplierImageDraft =
  | {
      kind: "existing";
      localId: string;
      imageId: string;
      filename: string;
      mimeType: string;
      previewUrl: string;
      originalPreviewUrl?: string;
      sha256?: string;
    }
  | {
      kind: "new";
      localId: string;
      filename: string;
      mimeType: string;
      previewUrl: string;
      bytesBase64: string;
      sha256?: string;
    };

export function productCardFieldsFromCard(card: ProductCard): ProductCardFields {
  return {
    name: card.name,
    sellingPoints: [...card.sellingPoints],
    specifications: card.specifications,
    materialsCraft: card.materialsCraft,
    audienceScenarios: card.audienceScenarios,
    packageContents: card.packageContents,
    painPointsComparison: card.painPointsComparison,
    usageDemoHighlights: card.usageDemoHighlights,
    certificationsProhibitions: card.certificationsProhibitions,
  };
}

export function supplierImagesFromCard(card: ProductCard): ProductCardSupplierImageDraft[] {
  return card.supplierImages.map((img) => ({
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

export function toCreateSupplierImagePayloads(
  images: ProductCardSupplierImageDraft[],
): ApiProductCardNewImagePayload[] {
  const result: ApiProductCardNewImagePayload[] = [];
  for (const image of images) {
    if (image.kind === "new") {
      result.push({
        filename: image.filename,
        mimeType: image.mimeType,
        bytesBase64: image.bytesBase64,
      });
    }
  }
  return result;
}

export function toUpdateSupplierImagePayloads(
  images: ProductCardSupplierImageDraft[],
): ApiProductCardUpdateImagePayload[] {
  return images.map((image) =>
    image.kind === "existing"
      ? { imageId: image.imageId }
      : {
          filename: image.filename,
          mimeType: image.mimeType,
          bytesBase64: image.bytesBase64,
        },
  );
}

let imageDraftSeq = 0;

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

async function computeSha256Optional(buffer: ArrayBuffer): Promise<string | undefined> {
  if (typeof globalThis.crypto?.subtle?.digest !== "function") return undefined;
  try {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return undefined;
  }
}

export async function readSupplierImageFiles(
  fileList: FileList | File[],
  existing: ProductCardSupplierImageDraft[],
): Promise<{ added: ProductCardSupplierImageDraft[]; errors: string[] }> {
  const files = Array.from(fileList);
  const errors: string[] = [];
  const added: ProductCardSupplierImageDraft[] = [];
  const seenHashes = new Set<string>(
    existing.map((item) => item.sha256).filter((item): item is string => Boolean(item)),
  );
  let remaining = Math.max(0, PRODUCT_CARD_MAX_SUPPLIER_IMAGES - existing.length);

  for (const file of files) {
    if (remaining <= 0) {
      errors.push(`供应商参考图最多上传 ${PRODUCT_CARD_MAX_SUPPLIER_IMAGES} 张`);
      break;
    }
    const mimeType = imageMimeType(file, "any-type");
    if (!mimeType) {
      errors.push(`「${file.name}」格式不支持，仅支持 JPG / PNG / WebP`);
      continue;
    }
    if (file.size > PRODUCT_CARD_MAX_IMAGE_BYTES) {
      errors.push(`「${file.name}」超过 12 MiB 大小限制`);
      continue;
    }
    try {
      const buffer = await file.arrayBuffer();
      const sha256 = await computeSha256Optional(buffer);
      if (sha256 && seenHashes.has(sha256)) {
        errors.push(`「${file.name}」与已有图片重复，已自动去重`);
        continue;
      }
      if (sha256) seenHashes.add(sha256);
      const bytesBase64 = arrayBufferToBase64(buffer);
      imageDraftSeq += 1;
      added.push({
        kind: "new",
        localId: `new:${Date.now()}-${imageDraftSeq}`,
        filename: file.name || `supplier-${imageDraftSeq}.png`,
        mimeType,
        previewUrl: `data:${mimeType};base64,${bytesBase64}`,
        bytesBase64,
        sha256,
      });
      remaining -= 1;
    } catch {
      errors.push(`读取「${file.name}」失败，请重试`);
    }
  }

  return { added, errors };
}

function charCounterClass(len: number, max: number): string {
  if (len > max) return "pc-char-count is-over";
  if (len >= Math.ceil(max * 0.85)) return "pc-char-count is-near-limit";
  return "pc-char-count";
}

export interface ProductCardEditorFormProps {
  fields: ProductCardFields;
  supplierImages: ProductCardSupplierImageDraft[];
  onFieldsChange: (next: ProductCardFields) => void;
  onSupplierImagesChange: (next: ProductCardSupplierImageDraft[]) => void;
  onSubmit?: () => void | Promise<void>;
  submitLabel?: string;
  submitting?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  highlightMissing?: boolean;
  externalMissingFields?: ProductCardRequiredField[];
  topSlot?: ReactNode;
  footerExtra?: ReactNode;
  idPrefix?: string;
  defaultExpandedOptional?: boolean;
  layout?: "panel" | "inline";
}

export function ProductCardEditorForm({
  fields,
  supplierImages,
  onFieldsChange,
  onSupplierImagesChange,
  onSubmit,
  submitLabel = "保存商品信息卡",
  submitting = false,
  disabled = false,
  readOnly = false,
  highlightMissing = true,
  externalMissingFields,
  topSlot,
  footerExtra,
  idPrefix,
  defaultExpandedOptional = false,
  layout = "panel",
}: ProductCardEditorFormProps) {
  const autoId = useId();
  const prefix = idPrefix ?? `pc-${autoId}`;
  const isLocked = readOnly || submitting || disabled;
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mountedRef = useRef(true);
  const prefixRef = useRef(prefix);
  const lockedRef = useRef(isLocked);
  const supplierImagesRef = useRef(supplierImages);
  const onSupplierImagesChangeRef = useRef(onSupplierImagesChange);
  prefixRef.current = prefix;
  lockedRef.current = isLocked;
  supplierImagesRef.current = supplierImages;
  onSupplierImagesChangeRef.current = onSupplierImagesChange;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const [draggingFiles, setDraggingFiles] = useState(false);
  const [imageError, setImageError] = useState("");
  const [focusedPointIndex, setFocusedPointIndex] = useState<number | null>(null);

  const hasExtendedContent = Boolean(
    fields.painPointsComparison.trim() ||
      fields.usageDemoHighlights.trim() ||
      fields.certificationsProhibitions.trim(),
  );
  const [extendedOpen, setExtendedOpen] = useState(defaultExpandedOptional || hasExtendedContent);

  useEffect(() => {
    if (hasExtendedContent) setExtendedOpen(true);
  }, [hasExtendedContent]);

  const validation = useMemo(() => validateProductCardFields(fields), [fields]);

  const missingSet = useMemo(() => {
    const isLocallyEmpty = (key: ProductCardRequiredField): boolean => {
      if (key === "sellingPoints") {
        return !fields.sellingPoints.some((item) => item.trim().length > 0);
      }
      return fields[key].trim().length === 0;
    };
    const set = new Set<ProductCardRequiredField>();
    if (!validation.ok) {
      for (const key of validation.missingFields) set.add(key);
    }
    if (externalMissingFields) {
      for (const key of externalMissingFields) {
        if (isLocallyEmpty(key)) set.add(key);
      }
    }
    return set;
  }, [fields, validation, externalMissingFields]);

  const fieldErrors = validation.ok ? {} : validation.fieldErrors;

  const isMissing = (key: ProductCardRequiredField) =>
    !readOnly && highlightMissing && missingSet.has(key);

  const nonMissingError = (key: keyof ProductCardFields) => {
    const msg = fieldErrors[key];
    if (!msg) return null;
    if (missingSet.has(key as ProductCardRequiredField)) return null;
    return msg;
  };

  const updateField = <K extends keyof ProductCardFields>(key: K, value: ProductCardFields[K]) => {
    if (isLocked) return;
    onFieldsChange({ ...fields, [key]: value });
  };

  const sellingPointRows = useMemo(
    () => (fields.sellingPoints.length > 0 ? fields.sellingPoints : [""]),
    [fields.sellingPoints],
  );
  const validSellingPointCount = useMemo(
    () => fields.sellingPoints.filter((item) => item.trim().length > 0).length,
    [fields.sellingPoints],
  );

  const handleSellingPointChange = (index: number, value: string) => {
    if (isLocked) return;
    const next = [...sellingPointRows];
    next[index] = value;
    onFieldsChange({ ...fields, sellingPoints: next });
  };

  const handleAddSellingPoint = () => {
    if (isLocked || sellingPointRows.length >= PRODUCT_CARD_FIELD_LIMITS.sellingPoints.maxItems) return;
    onFieldsChange({ ...fields, sellingPoints: [...sellingPointRows, ""] });
  };

  const handleRemoveSellingPoint = (index: number) => {
    if (isLocked) return;
    if (sellingPointRows.length <= 1) {
      onFieldsChange({ ...fields, sellingPoints: [] });
      return;
    }
    const next = sellingPointRows.filter((_, i) => i !== index);
    onFieldsChange({ ...fields, sellingPoints: next });
  };

  const handleSupplierFiles = async (fileList: FileList | File[] | null) => {
    if (isLocked || !fileList || fileList.length === 0) return;
    const startPrefix = prefixRef.current;
    const initialImages = supplierImagesRef.current;
    setImageError("");
    const { added, errors } = await readSupplierImageFiles(fileList, initialImages);
    if (!mountedRef.current || prefixRef.current !== startPrefix || lockedRef.current) return;

    const latestImages = supplierImagesRef.current;
    const latestHashes = new Set<string>(
      latestImages.map((item) => item.sha256).filter((item): item is string => Boolean(item)),
    );
    const remainingSlots = Math.max(0, PRODUCT_CARD_MAX_SUPPLIER_IMAGES - latestImages.length);
    const nextErrors = [...errors];
    const safeAdded: ProductCardSupplierImageDraft[] = [];

    for (const item of added) {
      if (safeAdded.length >= remainingSlots) {
        nextErrors.push(`供应商参考图最多上传 ${PRODUCT_CARD_MAX_SUPPLIER_IMAGES} 张`);
        break;
      }
      if (item.sha256 && latestHashes.has(item.sha256)) {
        nextErrors.push(`「${item.filename}」与已有图片重复，已自动去重`);
        continue;
      }
      if (item.sha256) latestHashes.add(item.sha256);
      safeAdded.push(item);
    }

    if (safeAdded.length > 0) {
      onSupplierImagesChangeRef.current([...latestImages, ...safeAdded]);
    }
    if (nextErrors.length > 0) {
      setImageError(nextErrors.join("；"));
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleMoveImage = (index: number, delta: -1 | 1) => {
    if (isLocked) return;
    const target = index + delta;
    if (target < 0 || target >= supplierImages.length) return;
    const next = [...supplierImages];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    onSupplierImagesChange(next);
  };

  const handleRemoveImage = (localId: string) => {
    if (isLocked) return;
    setImageError("");
    onSupplierImagesChange(supplierImages.filter((item) => item.localId !== localId));
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDraggingFiles(false);
    if (isLocked || supplierImages.length >= PRODUCT_CARD_MAX_SUPPLIER_IMAGES) return;
    void handleSupplierFiles(event.dataTransfer.files);
  };

  const handleFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isLocked || !validation.ok || !onSubmit) return;
    void onSubmit();
  };

  const disableReason = useMemo(() => {
    if (validation.ok) return "";
    if (validation.code === "PRODUCT_CARD_REQUIRED_FIELDS_MISSING") {
      const labels = validation.missingFields.map((key) => PRODUCT_CARD_FIELD_LABELS[key]).join("、");
      return `尚缺 ${validation.missingFields.length} 项必填：${labels}`;
    }
    return validation.message;
  }, [validation]);

  const extendedFilledCount =
    (fields.painPointsComparison.trim() ? 1 : 0) +
    (fields.usageDemoHighlights.trim() ? 1 : 0) +
    (fields.certificationsProhibitions.trim() ? 1 : 0);

  const nameLen = productCardCharLength(fields.name.trim());
  const specLen = productCardCharLength(fields.specifications.trim());
  const matLen = productCardCharLength(fields.materialsCraft.trim());
  const audLen = productCardCharLength(fields.audienceScenarios.trim());
  const pkgLen = productCardCharLength(fields.packageContents.trim());
  const painLen = productCardCharLength(fields.painPointsComparison.trim());
  const usageLen = productCardCharLength(fields.usageDemoHighlights.trim());
  const certLen = productCardCharLength(fields.certificationsProhibitions.trim());

  const maxPointItemLen = useMemo(() => {
    let max = 0;
    for (const point of sellingPointRows) {
      const len = productCardCharLength(point.trim());
      if (len > max) max = len;
    }
    return max;
  }, [sellingPointRows]);

  const activePointLen =
    focusedPointIndex !== null && sellingPointRows[focusedPointIndex] !== undefined
      ? productCardCharLength(sellingPointRows[focusedPointIndex].trim())
      : null;

  const sellingPointsOverLimit =
    validSellingPointCount > PRODUCT_CARD_FIELD_LIMITS.sellingPoints.maxItems ||
    maxPointItemLen > PRODUCT_CARD_FIELD_LIMITS.sellingPoints.itemMax;
  const sellingPointsNearLimit =
    !sellingPointsOverLimit &&
    (validSellingPointCount >= Math.ceil(PRODUCT_CARD_FIELD_LIMITS.sellingPoints.maxItems * 0.85) ||
      maxPointItemLen >= Math.ceil(PRODUCT_CARD_FIELD_LIMITS.sellingPoints.itemMax * 0.85));

  return (
    <form className={`pc-form is-${layout}`} onSubmit={handleFormSubmit} noValidate>
      <div className="pc-form-scroll">
        {topSlot}

        {readOnly && (
          <div className="pc-form-readonly-banner" role="status">
            <Icon name="lock" />
            <span>当前商品信息卡为只读展示，如需修订请前往商品库编辑。</span>
          </div>
        )}

        {/* Compact Supplier Reference Images Strip */}
        <section
          className={`pc-supplier-section ${draggingFiles ? "is-dragging" : ""}`}
          aria-label="供应商参考图"
          onDragOver={(event) => {
            if (isLocked || supplierImages.length >= PRODUCT_CARD_MAX_SUPPLIER_IMAGES) return;
            event.preventDefault();
            if (!draggingFiles) setDraggingFiles(true);
          }}
          onDragLeave={() => setDraggingFiles(false)}
          onDrop={handleDrop}
        >
          <div className="pc-supplier-head">
            <div className="pc-supplier-head-left">
              <span>供应商参考图</span>
              <InfoTip
                title="资产隔离与快照边界"
                label="供应商参考图边界说明"
                align="start"
                content="供应商参考图仅用于认款展示与建档识别，不流入创作页生图原图区；修改或归档商品卡不影响历史已冻结批次。"
              />
            </div>
            <span className="pc-supplier-count">
              {supplierImages.length} / {PRODUCT_CARD_MAX_SUPPLIER_IMAGES}
            </span>
          </div>

          <div className="pc-supplier-strip">
            {supplierImages.map((image, index) => (
              <div
                className={`pc-supplier-card ${index === 0 ? "is-cover" : ""}`}
                key={image.localId}
                data-supplier-index={index}
                data-supplier-filename={image.filename}
                title={image.filename}
              >
                <img src={image.previewUrl} alt={image.filename} loading="lazy" />
                {index === 0 && <span className="pc-cover-badge">封面</span>}
                <span className="pc-supplier-name sr-only">{image.filename}</span>
                {!readOnly && (
                  <div className="pc-supplier-controls">
                    <button
                      type="button"
                      className="pc-supplier-ctrl-btn"
                      aria-label={`左移 ${image.filename}`}
                      title="左移"
                      disabled={isLocked || index === 0}
                      onClick={() => handleMoveImage(index, -1)}
                    >
                      <Icon name="arrow-left" />
                    </button>
                    <button
                      type="button"
                      className="pc-supplier-ctrl-btn"
                      aria-label={`右移 ${image.filename}`}
                      title="右移"
                      disabled={isLocked || index === supplierImages.length - 1}
                      onClick={() => handleMoveImage(index, 1)}
                    >
                      <Icon name="arrow-right" />
                    </button>
                    <button
                      type="button"
                      className="pc-supplier-ctrl-btn is-danger"
                      aria-label={`移除 ${image.filename}`}
                      title="移除"
                      disabled={isLocked}
                      onClick={() => handleRemoveImage(image.localId)}
                    >
                      <Icon name="trash" />
                    </button>
                  </div>
                )}
              </div>
            ))}

            {!readOnly && supplierImages.length < PRODUCT_CARD_MAX_SUPPLIER_IMAGES && (
              <label
                className={`pc-supplier-add-tile ${isLocked ? "is-disabled" : ""}`}
                title="点击或拖拽上传供应商参考图（JPG/PNG/WebP，单张 ≤12 MiB）"
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  className="pc-supplier-file-input"
                  aria-label="上传供应商参考图"
                  accept={IMAGE_UPLOAD_ACCEPT}
                  multiple
                  disabled={isLocked || supplierImages.length >= PRODUCT_CARD_MAX_SUPPLIER_IMAGES}
                  onChange={(event) => void handleSupplierFiles(event.target.files)}
                />
                <Icon name="plus" />
                <span>上传</span>
              </label>
            )}

            {readOnly && supplierImages.length === 0 && (
              <span className="pc-field-hint">未上传供应商参考图</span>
            )}
          </div>

          {imageError && (
            <span className="pc-field-error" role="alert">
              {imageError}
            </span>
          )}
        </section>

        {/* Flat 6 Required Fields */}
        <div className="pc-flat-fields">
          {/* 1. 商品名称 */}
          <div
            className={`pc-field ${isMissing("name") ? "is-missing" : ""} ${nonMissingError("name") ? "is-invalid" : ""}`}
            data-field="name"
          >
            <div className="pc-field-head">
              <label className="pc-field-label" htmlFor={`${prefix}-name`}>
                <span>{PRODUCT_CARD_FIELD_LABELS.name}</span>
                <span className="pc-req-mark" aria-hidden="true">*</span>
                {isMissing("name") && <span className="pc-missing-dot">待补</span>}
              </label>
              <span
                className={charCounterClass(nameLen, PRODUCT_CARD_FIELD_LIMITS.name.max)}
                data-char-counter="name"
              >
                {nameLen}/{PRODUCT_CARD_FIELD_LIMITS.name.max}
              </span>
            </div>
            <input
              id={`${prefix}-name`}
              className="pc-input"
              type="text"
              value={fields.name}
              disabled={isLocked}
              placeholder="例如：双层真空不锈钢保温杯 500ml"
              onChange={(event) => updateField("name", event.target.value)}
            />
            {nonMissingError("name") && <span className="pc-field-error">{nonMissingError("name")}</span>}
          </div>

          {/* 2. 核心卖点 */}
          <div
            className={`pc-field ${isMissing("sellingPoints") ? "is-missing" : ""} ${nonMissingError("sellingPoints") ? "is-invalid" : ""}`}
            data-field="sellingPoints"
          >
            <div className="pc-field-head">
              <span className="pc-field-label">
                <span>{PRODUCT_CARD_FIELD_LABELS.sellingPoints}</span>
                <span className="pc-req-mark" aria-hidden="true">*</span>
                {isMissing("sellingPoints") && <span className="pc-missing-dot">待补</span>}
              </span>
              <span
                className={`pc-char-count ${
                  sellingPointsOverLimit
                    ? "is-over"
                    : sellingPointsNearLimit
                      ? "is-near-limit"
                      : ""
                }`}
                data-char-counter="sellingPoints"
              >
                {activePointLen !== null
                  ? `${validSellingPointCount}/${PRODUCT_CARD_FIELD_LIMITS.sellingPoints.maxItems} 条 · ${activePointLen}/${PRODUCT_CARD_FIELD_LIMITS.sellingPoints.itemMax}`
                  : `${validSellingPointCount}/${PRODUCT_CARD_FIELD_LIMITS.sellingPoints.maxItems} 条`}
              </span>
            </div>

            {readOnly ? (
              validSellingPointCount > 0 ? (
                <ol className="pc-points-readonly">
                  {fields.sellingPoints
                    .map((item) => item.trim())
                    .filter(Boolean)
                    .map((item, idx) => (
                      <li key={`${idx}-${item}`}>{item}</li>
                    ))}
                </ol>
              ) : (
                <span className="pc-field-hint">未填写核心卖点</span>
              )
            ) : (
              <div className="pc-points-list">
                {sellingPointRows.map((point, index) => (
                  <div className="pc-point-row" key={index}>
                    <span className="pc-point-index">{index + 1}</span>
                    <input
                      id={index === 0 ? `${prefix}-sellingPoints` : `${prefix}-sellingPoints-${index}`}
                      className="pc-input"
                      type="text"
                      aria-label={`核心卖点 ${index + 1}`}
                      value={point}
                      disabled={isLocked}
                      placeholder={`填写第 ${index + 1} 条核心卖点`}
                      onFocus={() => setFocusedPointIndex(index)}
                      onBlur={() => setFocusedPointIndex((cur) => (cur === index ? null : cur))}
                      onChange={(event) => handleSellingPointChange(index, event.target.value)}
                    />
                    <button
                      type="button"
                      className="pc-point-remove"
                      aria-label={`删除第 ${index + 1} 条卖点`}
                      disabled={isLocked || (sellingPointRows.length <= 1 && !point)}
                      onClick={() => handleRemoveSellingPoint(index)}
                      title="删除卖点"
                    >
                      <Icon name="x" />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="pc-point-add-btn"
                  disabled={
                    isLocked ||
                    sellingPointRows.length >= PRODUCT_CARD_FIELD_LIMITS.sellingPoints.maxItems
                  }
                  onClick={handleAddSellingPoint}
                >
                  <Icon name="plus" />
                  <span>添加卖点</span>
                </button>
              </div>
            )}
            {nonMissingError("sellingPoints") && (
              <span className="pc-field-error">{nonMissingError("sellingPoints")}</span>
            )}
          </div>

          {/* 3. 规格参数与尺寸重量 */}
          <div
            className={`pc-field ${isMissing("specifications") ? "is-missing" : ""} ${nonMissingError("specifications") ? "is-invalid" : ""}`}
            data-field="specifications"
          >
            <div className="pc-field-head">
              <label className="pc-field-label" htmlFor={`${prefix}-specifications`}>
                <span>{PRODUCT_CARD_FIELD_LABELS.specifications}</span>
                <span className="pc-req-mark" aria-hidden="true">*</span>
                {isMissing("specifications") && <span className="pc-missing-dot">待补</span>}
              </label>
              <span
                className={charCounterClass(specLen, PRODUCT_CARD_FIELD_LIMITS.specifications.max)}
                data-char-counter="specifications"
              >
                {specLen}/{PRODUCT_CARD_FIELD_LIMITS.specifications.max}
              </span>
            </div>
            <textarea
              id={`${prefix}-specifications`}
              className="pc-textarea"
              rows={2}
              value={fields.specifications}
              disabled={isLocked}
              placeholder="填写容量、功率、尺寸、重量、接口参数等客观数值"
              onChange={(event) => updateField("specifications", event.target.value)}
            />
            {nonMissingError("specifications") && (
              <span className="pc-field-error">{nonMissingError("specifications")}</span>
            )}
          </div>

          {/* 4. 材质与工艺细节 */}
          <div
            className={`pc-field ${isMissing("materialsCraft") ? "is-missing" : ""} ${nonMissingError("materialsCraft") ? "is-invalid" : ""}`}
            data-field="materialsCraft"
          >
            <div className="pc-field-head">
              <label className="pc-field-label" htmlFor={`${prefix}-materialsCraft`}>
                <span>{PRODUCT_CARD_FIELD_LABELS.materialsCraft}</span>
                <span className="pc-req-mark" aria-hidden="true">*</span>
                {isMissing("materialsCraft") && <span className="pc-missing-dot">待补</span>}
              </label>
              <span
                className={charCounterClass(matLen, PRODUCT_CARD_FIELD_LIMITS.materialsCraft.max)}
                data-char-counter="materialsCraft"
              >
                {matLen}/{PRODUCT_CARD_FIELD_LIMITS.materialsCraft.max}
              </span>
            </div>
            <textarea
              id={`${prefix}-materialsCraft`}
              className="pc-textarea"
              rows={2}
              value={fields.materialsCraft}
              disabled={isLocked}
              placeholder="填写主体材质、表面处理工艺、结构细节"
              onChange={(event) => updateField("materialsCraft", event.target.value)}
            />
            {nonMissingError("materialsCraft") && (
              <span className="pc-field-error">{nonMissingError("materialsCraft")}</span>
            )}
          </div>

          {/* 5. 适用人群与使用场景 */}
          <div
            className={`pc-field ${isMissing("audienceScenarios") ? "is-missing" : ""} ${nonMissingError("audienceScenarios") ? "is-invalid" : ""}`}
            data-field="audienceScenarios"
          >
            <div className="pc-field-head">
              <label className="pc-field-label" htmlFor={`${prefix}-audienceScenarios`}>
                <span>{PRODUCT_CARD_FIELD_LABELS.audienceScenarios}</span>
                <span className="pc-req-mark" aria-hidden="true">*</span>
                {isMissing("audienceScenarios") && <span className="pc-missing-dot">待补</span>}
              </label>
              <span
                className={charCounterClass(audLen, PRODUCT_CARD_FIELD_LIMITS.audienceScenarios.max)}
                data-char-counter="audienceScenarios"
              >
                {audLen}/{PRODUCT_CARD_FIELD_LIMITS.audienceScenarios.max}
              </span>
            </div>
            <textarea
              id={`${prefix}-audienceScenarios`}
              className="pc-textarea"
              rows={2}
              value={fields.audienceScenarios}
              disabled={isLocked}
              placeholder="填写目标人群与典型使用场景，如居家手冲咖啡、桌面办公、伴手礼"
              onChange={(event) => updateField("audienceScenarios", event.target.value)}
            />
            {nonMissingError("audienceScenarios") && (
              <span className="pc-field-error">{nonMissingError("audienceScenarios")}</span>
            )}
          </div>

          {/* 6. 包装清单 / 配件说明 */}
          <div
            className={`pc-field ${isMissing("packageContents") ? "is-missing" : ""} ${nonMissingError("packageContents") ? "is-invalid" : ""}`}
            data-field="packageContents"
          >
            <div className="pc-field-head">
              <label className="pc-field-label" htmlFor={`${prefix}-packageContents`}>
                <span>{PRODUCT_CARD_FIELD_LABELS.packageContents}</span>
                <span className="pc-req-mark" aria-hidden="true">*</span>
                {isMissing("packageContents") && <span className="pc-missing-dot">待补</span>}
              </label>
              <div className="pc-field-head-right">
                <span
                  className={charCounterClass(pkgLen, PRODUCT_CARD_FIELD_LIMITS.packageContents.max)}
                  data-char-counter="packageContents"
                >
                  {pkgLen}/{PRODUCT_CARD_FIELD_LIMITS.packageContents.max}
                </span>
                {!readOnly && (
                  <button
                    type="button"
                    className="pc-quick-fill-chip"
                    disabled={isLocked}
                    onClick={() =>
                      updateField("packageContents", PRODUCT_CARD_NO_EXTRA_ACCESSORIES_TEXT)
                    }
                  >
                    填入无额外配件
                  </button>
                )}
              </div>
            </div>
            <textarea
              id={`${prefix}-packageContents`}
              className="pc-textarea pc-textarea-single"
              rows={1}
              value={fields.packageContents}
              disabled={isLocked}
              placeholder="列出包装内含主体及全部配件数量，例如：主体 ×1、礼盒 ×1"
              onChange={(event) => updateField("packageContents", event.target.value)}
            />
            {nonMissingError("packageContents") && (
              <span className="pc-field-error">{nonMissingError("packageContents")}</span>
            )}
          </div>

          {/* Collapsible Optional Extended Info (3 fields) */}
          <div className={`pc-optional-fold ${extendedOpen ? "is-open" : ""}`}>
            <button
              type="button"
              className="pc-optional-fold-trigger"
              aria-expanded={extendedOpen}
              disabled={Boolean(disabled || submitting)}
              onClick={() => setExtendedOpen((open) => !open)}
            >
              <span className="pc-optional-fold-left">
                <span className="pc-optional-fold-arrow" aria-hidden="true">▸</span>
                <span>补充扩展信息（选填 · 痛点对比 / 使用演示 / 认证禁忌）</span>
              </span>
              {extendedFilledCount > 0 && (
                <span className="pc-optional-count">已填 {extendedFilledCount}/3</span>
              )}
            </button>

            {extendedOpen && (
              <div className="pc-optional-fold-body">
                <div
                  className={`pc-field ${nonMissingError("painPointsComparison") ? "is-invalid" : ""}`}
                  data-field="painPointsComparison"
                >
                  <div className="pc-field-head">
                    <label className="pc-field-label" htmlFor={`${prefix}-painPointsComparison`}>
                      <span>{PRODUCT_CARD_FIELD_LABELS.painPointsComparison}</span>
                    </label>
                    <span
                      className={charCounterClass(
                        painLen,
                        PRODUCT_CARD_FIELD_LIMITS.painPointsComparison.max,
                      )}
                      data-char-counter="painPointsComparison"
                    >
                      {painLen}/{PRODUCT_CARD_FIELD_LIMITS.painPointsComparison.max}
                    </span>
                  </div>
                  <textarea
                    id={`${prefix}-painPointsComparison`}
                    className="pc-textarea"
                    rows={2}
                    value={fields.painPointsComparison}
                    disabled={isLocked}
                    placeholder="选填：常见同类痛点与本品实测优势对比（禁竞品拉踩）…"
                    onChange={(event) => updateField("painPointsComparison", event.target.value)}
                  />
                  {nonMissingError("painPointsComparison") && (
                    <span className="pc-field-error">
                      {nonMissingError("painPointsComparison")}
                    </span>
                  )}
                </div>

                <div
                  className={`pc-field ${nonMissingError("usageDemoHighlights") ? "is-invalid" : ""}`}
                  data-field="usageDemoHighlights"
                >
                  <div className="pc-field-head">
                    <label className="pc-field-label" htmlFor={`${prefix}-usageDemoHighlights`}>
                      <span>{PRODUCT_CARD_FIELD_LABELS.usageDemoHighlights}</span>
                    </label>
                    <span
                      className={charCounterClass(
                        usageLen,
                        PRODUCT_CARD_FIELD_LIMITS.usageDemoHighlights.max,
                      )}
                      data-char-counter="usageDemoHighlights"
                    >
                      {usageLen}/{PRODUCT_CARD_FIELD_LIMITS.usageDemoHighlights.max}
                    </span>
                  </div>
                  <textarea
                    id={`${prefix}-usageDemoHighlights`}
                    className="pc-textarea"
                    rows={2}
                    value={fields.usageDemoHighlights}
                    disabled={isLocked}
                    placeholder="选填：适合画面演示的使用步骤或细节亮点…"
                    onChange={(event) => updateField("usageDemoHighlights", event.target.value)}
                  />
                  {nonMissingError("usageDemoHighlights") && (
                    <span className="pc-field-error">
                      {nonMissingError("usageDemoHighlights")}
                    </span>
                  )}
                </div>

                <div
                  className={`pc-field ${nonMissingError("certificationsProhibitions") ? "is-invalid" : ""}`}
                  data-field="certificationsProhibitions"
                >
                  <div className="pc-field-head">
                    <label
                      className="pc-field-label"
                      htmlFor={`${prefix}-certificationsProhibitions`}
                    >
                      <span>{PRODUCT_CARD_FIELD_LABELS.certificationsProhibitions}</span>
                    </label>
                    <span
                      className={charCounterClass(
                        certLen,
                        PRODUCT_CARD_FIELD_LIMITS.certificationsProhibitions.max,
                      )}
                      data-char-counter="certificationsProhibitions"
                    >
                      {certLen}/{PRODUCT_CARD_FIELD_LIMITS.certificationsProhibitions.max}
                    </span>
                  </div>
                  <textarea
                    id={`${prefix}-certificationsProhibitions`}
                    className="pc-textarea"
                    rows={2}
                    value={fields.certificationsProhibitions}
                    disabled={isLocked}
                    placeholder="选填：质检认证及文案禁用词红线…"
                    onChange={(event) =>
                      updateField("certificationsProhibitions", event.target.value)
                    }
                  />
                  {nonMissingError("certificationsProhibitions") && (
                    <span className="pc-field-error">
                      {nonMissingError("certificationsProhibitions")}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {!readOnly && onSubmit && (
        <footer className="pc-form-footer">
          <span
            className={`pc-footer-hint ${!validation.ok ? "is-missing" : ""}`}
            role={!validation.ok ? "status" : undefined}
            data-testid={!validation.ok ? "pc-disable-reason" : undefined}
            title={!validation.ok ? disableReason : undefined}
          >
            {validation.ok ? "6 项必填完整" : disableReason}
          </span>
          <div className="pc-form-footer-actions">
            {footerExtra}
            <button
              className="btn btn-primary"
              type="submit"
              disabled={!validation.ok || isLocked}
              title={!validation.ok ? disableReason : undefined}
            >
              {submitting ? "保存中…" : submitLabel}
            </button>
          </div>
        </footer>
      )}
    </form>
  );
}
