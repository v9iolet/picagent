import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import {
  PRODUCT_CARD_ALLOWED_IMAGE_MIMES,
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
    category: card.category,
    sellingPoints: [...card.sellingPoints],
    specifications: card.specifications,
    materialsCraft: card.materialsCraft,
    audienceScenarios: card.audienceScenarios,
    packageContents: card.packageContents,
    skuCode: card.skuCode,
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

const ALLOWED_MIME_SET = new Set<string>(PRODUCT_CARD_ALLOWED_IMAGE_MIMES);
let imageDraftSeq = 0;

function inferImageMimeType(file: File): string {
  const normalized = file.type.trim().toLowerCase();
  if (ALLOWED_MIME_SET.has(normalized)) return normalized;
  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")) return "image/jpeg";
  if (lowerName.endsWith(".png")) return "image/png";
  if (lowerName.endsWith(".webp")) return "image/webp";
  return normalized;
}

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
    const mimeType = inferImageMimeType(file);
    if (!ALLOWED_MIME_SET.has(mimeType)) {
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

export interface ProductCardEditorFormProps {
  fields: ProductCardFields;
  supplierImages: ProductCardSupplierImageDraft[];
  onFieldsChange: (next: ProductCardFields) => void;
  onSupplierImagesChange: (next: ProductCardSupplierImageDraft[]) => void;
  onSubmit?: () => void | Promise<void>;
  submitLabel?: string;
  submitting?: boolean;
  readOnly?: boolean;
  highlightMissing?: boolean;
  externalMissingFields?: ProductCardRequiredField[];
  footerExtra?: ReactNode;
  idPrefix?: string;
  defaultExpandedOptional?: boolean;
}

export function ProductCardEditorForm({
  fields,
  supplierImages,
  onFieldsChange,
  onSupplierImagesChange,
  onSubmit,
  submitLabel = "保存商品信息卡",
  submitting = false,
  readOnly = false,
  highlightMissing = true,
  externalMissingFields,
  footerExtra,
  idPrefix,
  defaultExpandedOptional = false,
}: ProductCardEditorFormProps) {
  const autoId = useId();
  const prefix = idPrefix ?? `pc-${autoId}`;
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [imageError, setImageError] = useState("");
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
    const set = new Set<ProductCardRequiredField>();
    if (!validation.ok) {
      for (const key of validation.missingFields) set.add(key);
    }
    if (externalMissingFields) {
      for (const key of externalMissingFields) set.add(key);
    }
    return set;
  }, [validation, externalMissingFields]);

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
    if (readOnly) return;
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
    if (readOnly) return;
    const next = [...sellingPointRows];
    next[index] = value;
    onFieldsChange({ ...fields, sellingPoints: next });
  };

  const handleAddSellingPoint = () => {
    if (readOnly || sellingPointRows.length >= PRODUCT_CARD_FIELD_LIMITS.sellingPoints.maxItems) return;
    onFieldsChange({ ...fields, sellingPoints: [...sellingPointRows, ""] });
  };

  const handleRemoveSellingPoint = (index: number) => {
    if (readOnly) return;
    if (sellingPointRows.length <= 1) {
      onFieldsChange({ ...fields, sellingPoints: [] });
      return;
    }
    const next = sellingPointRows.filter((_, i) => i !== index);
    onFieldsChange({ ...fields, sellingPoints: next });
  };

  const handleSupplierFiles = async (fileList: FileList | File[] | null) => {
    if (readOnly || !fileList || fileList.length === 0) return;
    setImageError("");
    const { added, errors } = await readSupplierImageFiles(fileList, supplierImages);
    if (added.length > 0) {
      onSupplierImagesChange([...supplierImages, ...added]);
    }
    if (errors.length > 0) {
      setImageError(errors.join("；"));
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleMoveImage = (index: number, delta: -1 | 1) => {
    if (readOnly) return;
    const target = index + delta;
    if (target < 0 || target >= supplierImages.length) return;
    const next = [...supplierImages];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    onSupplierImagesChange(next);
  };

  const handleRemoveImage = (localId: string) => {
    if (readOnly) return;
    setImageError("");
    onSupplierImagesChange(supplierImages.filter((item) => item.localId !== localId));
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDraggingFiles(false);
    if (readOnly || supplierImages.length >= PRODUCT_CARD_MAX_SUPPLIER_IMAGES) return;
    void handleSupplierFiles(event.dataTransfer.files);
  };

  const handleFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (readOnly || !validation.ok || submitting || !onSubmit) return;
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
  const skuLen = productCardCharLength(fields.skuCode.trim());
  const categoryLen = productCardCharLength(fields.category.trim());
  const specLen = productCardCharLength(fields.specifications.trim());
  const matLen = productCardCharLength(fields.materialsCraft.trim());
  const audLen = productCardCharLength(fields.audienceScenarios.trim());
  const pkgLen = productCardCharLength(fields.packageContents.trim());
  const painLen = productCardCharLength(fields.painPointsComparison.trim());
  const usageLen = productCardCharLength(fields.usageDemoHighlights.trim());
  const certLen = productCardCharLength(fields.certificationsProhibitions.trim());

  return (
    <form className="pc-form" onSubmit={handleFormSubmit} noValidate>
      {readOnly && (
        <div className="pc-form-readonly-banner" role="status">
          <Icon name="lock" />
          <span>当前商品信息卡为只读展示，如需修订请前往商品库编辑。</span>
        </div>
      )}

      {/* Group 1: 基本识别与核心卖点 */}
      <section className="pc-form-group" aria-label="基础信息与核心卖点">
        <div className="pc-form-group-head">
          <h3>基础信息与核心卖点</h3>
          <span className="pc-form-group-sub">必填 1–3 · SKU 置顶选填</span>
        </div>

        <div className="pc-form-row-2">
          <div
            className={`pc-field ${isMissing("name") ? "is-missing" : ""} ${nonMissingError("name") ? "is-invalid" : ""}`}
            data-field="name"
          >
            <div className="pc-field-label-row">
              <label className="pc-field-label" htmlFor={`${prefix}-name`}>
                <span>{PRODUCT_CARD_FIELD_LABELS.name}</span>
                <span className="pc-req-mark" aria-hidden="true">*</span>
                {isMissing("name") && <span className="pc-field-tag is-missing">待补全</span>}
              </label>
              <span className={`pc-char-count ${nameLen > PRODUCT_CARD_FIELD_LIMITS.name.max ? "is-over" : ""}`}>
                {nameLen}/{PRODUCT_CARD_FIELD_LIMITS.name.max}
              </span>
            </div>
            <input
              id={`${prefix}-name`}
              className="pc-input"
              type="text"
              value={fields.name}
              disabled={readOnly || submitting}
              placeholder="例如：双层真空不锈钢保温杯 500ml"
              onChange={(event) => updateField("name", event.target.value)}
            />
            {nonMissingError("name") && <span className="pc-field-error">{nonMissingError("name")}</span>}
          </div>

          <div
            className={`pc-field ${nonMissingError("skuCode") ? "is-invalid" : ""}`}
            data-field="skuCode"
          >
            <div className="pc-field-label-row">
              <label className="pc-field-label" htmlFor={`${prefix}-skuCode`}>
                <span>{PRODUCT_CARD_FIELD_LABELS.skuCode}</span>
                <span className="pc-field-tag is-optional">选填</span>
              </label>
              <span className={`pc-char-count ${skuLen > PRODUCT_CARD_FIELD_LIMITS.skuCode.max ? "is-over" : ""}`}>
                {skuLen}/{PRODUCT_CARD_FIELD_LIMITS.skuCode.max}
              </span>
            </div>
            <input
              id={`${prefix}-skuCode`}
              className="pc-input mono"
              type="text"
              value={fields.skuCode}
              disabled={readOnly || submitting}
              placeholder="例如：SKU-CUP-500W"
              onChange={(event) => updateField("skuCode", event.target.value)}
            />
            {nonMissingError("skuCode") && <span className="pc-field-error">{nonMissingError("skuCode")}</span>}
          </div>
        </div>

        <div
          className={`pc-field ${isMissing("category") ? "is-missing" : ""} ${nonMissingError("category") ? "is-invalid" : ""}`}
          data-field="category"
        >
          <div className="pc-field-label-row">
            <label className="pc-field-label" htmlFor={`${prefix}-category`}>
              <span>{PRODUCT_CARD_FIELD_LABELS.category}</span>
              <span className="pc-req-mark" aria-hidden="true">*</span>
              {isMissing("category") && <span className="pc-field-tag is-missing">待补全</span>}
            </label>
            <span className={`pc-char-count ${categoryLen > PRODUCT_CARD_FIELD_LIMITS.category.max ? "is-over" : ""}`}>
              {categoryLen}/{PRODUCT_CARD_FIELD_LIMITS.category.max}
            </span>
          </div>
          <input
            id={`${prefix}-category`}
            className="pc-input"
            type="text"
            value={fields.category}
            disabled={readOnly || submitting}
            placeholder="例如：水杯水具 / 3C 数码配件 / 便携小家电"
            onChange={(event) => updateField("category", event.target.value)}
          />
          {nonMissingError("category") && <span className="pc-field-error">{nonMissingError("category")}</span>}
        </div>

        <div
          className={`pc-field ${isMissing("sellingPoints") ? "is-missing" : ""} ${nonMissingError("sellingPoints") ? "is-invalid" : ""}`}
          data-field="sellingPoints"
        >
          <div className="pc-field-label-row">
            <span className="pc-field-label">
              <span>{PRODUCT_CARD_FIELD_LABELS.sellingPoints}</span>
              <span className="pc-req-mark" aria-hidden="true">*</span>
              {isMissing("sellingPoints") && <span className="pc-field-tag is-missing">待补全</span>}
            </span>
            <span
              className={`pc-char-count ${
                validSellingPointCount > PRODUCT_CARD_FIELD_LIMITS.sellingPoints.maxItems ? "is-over" : ""
              }`}
            >
              有效 {validSellingPointCount}/{PRODUCT_CARD_FIELD_LIMITS.sellingPoints.maxItems} 条
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
              {sellingPointRows.map((point, index) => {
                const itemLen = productCardCharLength(point.trim());
                const overLimit = itemLen > PRODUCT_CARD_FIELD_LIMITS.sellingPoints.itemMax;
                return (
                  <div className="pc-point-row" key={index}>
                    <span className="pc-point-index">{index + 1}</span>
                    <input
                      id={index === 0 ? `${prefix}-sellingPoints` : `${prefix}-sellingPoints-${index}`}
                      className="pc-input"
                      type="text"
                      aria-label={`核心卖点 ${index + 1}`}
                      value={point}
                      disabled={submitting}
                      placeholder={`填写第 ${index + 1} 条核心卖点（1–200 字）`}
                      onChange={(event) => handleSellingPointChange(index, event.target.value)}
                    />
                    <span className={`pc-char-count ${overLimit ? "is-over" : ""}`}>
                      {itemLen}/{PRODUCT_CARD_FIELD_LIMITS.sellingPoints.itemMax}
                    </span>
                    <button
                      type="button"
                      className="pc-point-remove"
                      aria-label={`删除第 ${index + 1} 条卖点`}
                      disabled={submitting || (sellingPointRows.length <= 1 && !point)}
                      onClick={() => handleRemoveSellingPoint(index)}
                      title="删除此卖点"
                    >
                      <Icon name="x" />
                    </button>
                  </div>
                );
              })}
              <button
                type="button"
                className="pc-point-add-btn"
                disabled={submitting || sellingPointRows.length >= PRODUCT_CARD_FIELD_LIMITS.sellingPoints.maxItems}
                onClick={handleAddSellingPoint}
              >
                <Icon name="plus" />
                <span>添加核心卖点</span>
              </button>
            </div>
          )}
          {nonMissingError("sellingPoints") && (
            <span className="pc-field-error">{nonMissingError("sellingPoints")}</span>
          )}
        </div>
      </section>

      {/* Group 2: 商品客观事实详情 */}
      <section className="pc-form-group" aria-label="商品客观事实详情">
        <div className="pc-form-group-head">
          <h3>商品客观事实详情</h3>
          <span className="pc-form-group-sub">必填 4–7 · 供套图与上架文案准确引用</span>
        </div>

        <div
          className={`pc-field ${isMissing("specifications") ? "is-missing" : ""} ${nonMissingError("specifications") ? "is-invalid" : ""}`}
          data-field="specifications"
        >
          <div className="pc-field-label-row">
            <label className="pc-field-label" htmlFor={`${prefix}-specifications`}>
              <span>{PRODUCT_CARD_FIELD_LABELS.specifications}</span>
              <span className="pc-req-mark" aria-hidden="true">*</span>
              {isMissing("specifications") && <span className="pc-field-tag is-missing">待补全</span>}
            </label>
            <span
              className={`pc-char-count ${specLen > PRODUCT_CARD_FIELD_LIMITS.specifications.max ? "is-over" : ""}`}
            >
              {specLen}/{PRODUCT_CARD_FIELD_LIMITS.specifications.max}
            </span>
          </div>
          <textarea
            id={`${prefix}-specifications`}
            className="pc-textarea"
            rows={3}
            value={fields.specifications}
            disabled={readOnly || submitting}
            placeholder="填写容量、功率、尺寸、重量、接口参数等客观数值"
            onChange={(event) => updateField("specifications", event.target.value)}
          />
          {nonMissingError("specifications") && (
            <span className="pc-field-error">{nonMissingError("specifications")}</span>
          )}
        </div>

        <div
          className={`pc-field ${isMissing("materialsCraft") ? "is-missing" : ""} ${nonMissingError("materialsCraft") ? "is-invalid" : ""}`}
          data-field="materialsCraft"
        >
          <div className="pc-field-label-row">
            <label className="pc-field-label" htmlFor={`${prefix}-materialsCraft`}>
              <span>{PRODUCT_CARD_FIELD_LABELS.materialsCraft}</span>
              <span className="pc-req-mark" aria-hidden="true">*</span>
              {isMissing("materialsCraft") && <span className="pc-field-tag is-missing">待补全</span>}
            </label>
            <span
              className={`pc-char-count ${matLen > PRODUCT_CARD_FIELD_LIMITS.materialsCraft.max ? "is-over" : ""}`}
            >
              {matLen}/{PRODUCT_CARD_FIELD_LIMITS.materialsCraft.max}
            </span>
          </div>
          <textarea
            id={`${prefix}-materialsCraft`}
            className="pc-textarea"
            rows={2}
            value={fields.materialsCraft}
            disabled={readOnly || submitting}
            placeholder="填写主体材质、表面处理工艺、结构细节"
            onChange={(event) => updateField("materialsCraft", event.target.value)}
          />
          {nonMissingError("materialsCraft") && (
            <span className="pc-field-error">{nonMissingError("materialsCraft")}</span>
          )}
        </div>

        <div
          className={`pc-field ${isMissing("audienceScenarios") ? "is-missing" : ""} ${nonMissingError("audienceScenarios") ? "is-invalid" : ""}`}
          data-field="audienceScenarios"
        >
          <div className="pc-field-label-row">
            <label className="pc-field-label" htmlFor={`${prefix}-audienceScenarios`}>
              <span>{PRODUCT_CARD_FIELD_LABELS.audienceScenarios}</span>
              <span className="pc-req-mark" aria-hidden="true">*</span>
              {isMissing("audienceScenarios") && <span className="pc-field-tag is-missing">待补全</span>}
            </label>
            <span
              className={`pc-char-count ${audLen > PRODUCT_CARD_FIELD_LIMITS.audienceScenarios.max ? "is-over" : ""}`}
            >
              {audLen}/{PRODUCT_CARD_FIELD_LIMITS.audienceScenarios.max}
            </span>
          </div>
          <textarea
            id={`${prefix}-audienceScenarios`}
            className="pc-textarea"
            rows={2}
            value={fields.audienceScenarios}
            disabled={readOnly || submitting}
            placeholder="填写目标使用人群与典型生活/工作使用场景"
            onChange={(event) => updateField("audienceScenarios", event.target.value)}
          />
          {nonMissingError("audienceScenarios") && (
            <span className="pc-field-error">{nonMissingError("audienceScenarios")}</span>
          )}
        </div>

        <div
          className={`pc-field ${isMissing("packageContents") ? "is-missing" : ""} ${nonMissingError("packageContents") ? "is-invalid" : ""}`}
          data-field="packageContents"
        >
          <div className="pc-field-label-row">
            <label className="pc-field-label" htmlFor={`${prefix}-packageContents`}>
              <span>{PRODUCT_CARD_FIELD_LABELS.packageContents}</span>
              <span className="pc-req-mark" aria-hidden="true">*</span>
              {isMissing("packageContents") && <span className="pc-field-tag is-missing">待补全</span>}
            </label>
            <div className="pc-field-meta">
              {!readOnly && (
                <button
                  type="button"
                  className="pc-quick-fill-btn"
                  disabled={submitting}
                  onClick={() => updateField("packageContents", PRODUCT_CARD_NO_EXTRA_ACCESSORIES_TEXT)}
                >
                  无额外配件快捷填入
                </button>
              )}
              <span
                className={`pc-char-count ${pkgLen > PRODUCT_CARD_FIELD_LIMITS.packageContents.max ? "is-over" : ""}`}
              >
                {pkgLen}/{PRODUCT_CARD_FIELD_LIMITS.packageContents.max}
              </span>
            </div>
          </div>
          <textarea
            id={`${prefix}-packageContents`}
            className="pc-textarea"
            rows={2}
            value={fields.packageContents}
            disabled={readOnly || submitting}
            placeholder="例如：主机 ×1、Type-C 充电线 ×1、说明书 ×1；无配件可点右上角快捷填入"
            onChange={(event) => updateField("packageContents", event.target.value)}
          />
          {nonMissingError("packageContents") && (
            <span className="pc-field-error">{nonMissingError("packageContents")}</span>
          )}
        </div>
      </section>

      {/* Group 3: 供应商参考图 */}
      <section className="pc-form-group" aria-label="供应商参考图">
        <div className="pc-form-group-head">
          <h3>供应商参考图（选填）</h3>
          <span className="pc-char-count">
            {supplierImages.length}/{PRODUCT_CARD_MAX_SUPPLIER_IMAGES} 张
          </span>
        </div>

        <div className="pc-supplier-notice">
          <Icon name="alert" />
          <span>仅用于商品库认款展示与建档识别，生图实拍原图请在创作页上传</span>
        </div>

        {!readOnly && (
          <div
            className={`pc-supplier-dropzone ${draggingFiles ? "is-dragging" : ""} ${
              supplierImages.length >= PRODUCT_CARD_MAX_SUPPLIER_IMAGES || submitting ? "is-disabled" : ""
            }`}
            onDragOver={(event) => {
              event.preventDefault();
              if (!draggingFiles) setDraggingFiles(true);
            }}
            onDragLeave={() => setDraggingFiles(false)}
            onDrop={handleDrop}
          >
            <input
              ref={fileInputRef}
              type="file"
              className="pc-supplier-file-input"
              aria-label="上传供应商参考图"
              accept="image/jpeg,image/png,image/webp"
              multiple
              disabled={submitting || supplierImages.length >= PRODUCT_CARD_MAX_SUPPLIER_IMAGES}
              onChange={(event) => void handleSupplierFiles(event.target.files)}
            />
            <Icon name="upload" />
            <strong>
              {supplierImages.length >= PRODUCT_CARD_MAX_SUPPLIER_IMAGES
                ? "已达到 6 张上限"
                : "点击或拖拽上传供应商参考图"}
            </strong>
            <span>支持 JPG / PNG / WebP，单张 ≤ 12 MiB，第 1 张作为商品卡封面</span>
          </div>
        )}

        {imageError && (
          <span className="pc-field-error" role="alert">
            {imageError}
          </span>
        )}

        {supplierImages.length > 0 ? (
          <div className="pc-supplier-grid">
            {supplierImages.map((image, index) => (
              <div
                className={`pc-supplier-card ${index === 0 ? "is-cover" : ""}`}
                key={image.localId}
                data-supplier-index={index}
              >
                <div className="pc-supplier-thumb">
                  <img src={image.previewUrl} alt={image.filename} loading="lazy" />
                  {index === 0 && <span className="pc-cover-badge">封面</span>}
                </div>
                <div className="pc-supplier-name" title={image.filename}>
                  {image.filename}
                </div>
                {!readOnly && (
                  <div className="pc-supplier-controls">
                    <button
                      type="button"
                      className="pc-supplier-ctrl-btn"
                      aria-label={`左移 ${image.filename}`}
                      title="左移"
                      disabled={submitting || index === 0}
                      onClick={() => handleMoveImage(index, -1)}
                    >
                      <Icon name="arrow-left" />
                    </button>
                    <button
                      type="button"
                      className="pc-supplier-ctrl-btn"
                      aria-label={`右移 ${image.filename}`}
                      title="右移"
                      disabled={submitting || index === supplierImages.length - 1}
                      onClick={() => handleMoveImage(index, 1)}
                    >
                      <Icon name="arrow-right" />
                    </button>
                    <button
                      type="button"
                      className="pc-supplier-ctrl-btn is-danger"
                      aria-label={`移除 ${image.filename}`}
                      title="移除"
                      disabled={submitting}
                      onClick={() => handleRemoveImage(image.localId)}
                    >
                      <Icon name="trash" />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          readOnly && <span className="pc-field-hint">未上传供应商参考图</span>
        )}
      </section>

      {/* Group 4: 扩展预留字段（折叠分组） */}
      <section className="pc-form-group" aria-label="扩展预留字段">
        <button
          type="button"
          className={`pc-collapse-toggle ${extendedOpen ? "is-open" : ""}`}
          aria-expanded={extendedOpen}
          onClick={() => setExtendedOpen((open) => !open)}
        >
          <div className="pc-collapse-toggle-left">
            <h3>扩展预留字段（选填）</h3>
            <span className="pc-field-tag is-optional">已填 {extendedFilledCount}/3</span>
          </div>
          <Icon name="chevron-down" />
        </button>

        {extendedOpen && (
          <>
            <div
              className={`pc-field ${nonMissingError("painPointsComparison") ? "is-invalid" : ""}`}
              data-field="painPointsComparison"
            >
              <div className="pc-field-label-row">
                <label className="pc-field-label" htmlFor={`${prefix}-painPointsComparison`}>
                  <span>{PRODUCT_CARD_FIELD_LABELS.painPointsComparison}</span>
                  <span className="pc-field-tag is-optional">选填</span>
                </label>
                <span
                  className={`pc-char-count ${
                    painLen > PRODUCT_CARD_FIELD_LIMITS.painPointsComparison.max ? "is-over" : ""
                  }`}
                >
                  {painLen}/{PRODUCT_CARD_FIELD_LIMITS.painPointsComparison.max}
                </span>
              </div>
              <textarea
                id={`${prefix}-painPointsComparison`}
                className="pc-textarea"
                rows={2}
                value={fields.painPointsComparison}
                disabled={readOnly || submitting}
                placeholder="仅填写新旧款、使用前后或自身规格间客观对比数据，禁用竞品对比"
                onChange={(event) => updateField("painPointsComparison", event.target.value)}
              />
              {nonMissingError("painPointsComparison") && (
                <span className="pc-field-error">{nonMissingError("painPointsComparison")}</span>
              )}
            </div>

            <div
              className={`pc-field ${nonMissingError("usageDemoHighlights") ? "is-invalid" : ""}`}
              data-field="usageDemoHighlights"
            >
              <div className="pc-field-label-row">
                <label className="pc-field-label" htmlFor={`${prefix}-usageDemoHighlights`}>
                  <span>{PRODUCT_CARD_FIELD_LABELS.usageDemoHighlights}</span>
                  <span className="pc-field-tag is-optional">选填</span>
                </label>
                <span
                  className={`pc-char-count ${
                    usageLen > PRODUCT_CARD_FIELD_LIMITS.usageDemoHighlights.max ? "is-over" : ""
                  }`}
                >
                  {usageLen}/{PRODUCT_CARD_FIELD_LIMITS.usageDemoHighlights.max}
                </span>
              </div>
              <textarea
                id={`${prefix}-usageDemoHighlights`}
                className="pc-textarea"
                rows={2}
                value={fields.usageDemoHighlights}
                disabled={readOnly || submitting}
                placeholder="填写关键使用步骤、维护方式或适合动态演示的功能亮点"
                onChange={(event) => updateField("usageDemoHighlights", event.target.value)}
              />
              {nonMissingError("usageDemoHighlights") && (
                <span className="pc-field-error">{nonMissingError("usageDemoHighlights")}</span>
              )}
            </div>

            <div
              className={`pc-field ${nonMissingError("certificationsProhibitions") ? "is-invalid" : ""}`}
              data-field="certificationsProhibitions"
            >
              <div className="pc-field-label-row">
                <label className="pc-field-label" htmlFor={`${prefix}-certificationsProhibitions`}>
                  <span>{PRODUCT_CARD_FIELD_LABELS.certificationsProhibitions}</span>
                  <span className="pc-field-tag is-optional">选填</span>
                </label>
                <span
                  className={`pc-char-count ${
                    certLen > PRODUCT_CARD_FIELD_LIMITS.certificationsProhibitions.max ? "is-over" : ""
                  }`}
                >
                  {certLen}/{PRODUCT_CARD_FIELD_LIMITS.certificationsProhibitions.max}
                </span>
              </div>
              <textarea
                id={`${prefix}-certificationsProhibitions`}
                className="pc-textarea"
                rows={2}
                value={fields.certificationsProhibitions}
                disabled={readOnly || submitting}
                placeholder="例如：通过 FCC/CE/FDA 认证；不可承诺医疗功效，避免出现绝对化用语"
                onChange={(event) => updateField("certificationsProhibitions", event.target.value)}
              />
              {nonMissingError("certificationsProhibitions") && (
                <span className="pc-field-error">{nonMissingError("certificationsProhibitions")}</span>
              )}
            </div>
          </>
        )}
      </section>

      {!readOnly && onSubmit && (
        <div className="pc-form-footer">
          {!validation.ok && (
            <div className="pc-form-disable-reason" role="status" data-testid="pc-disable-reason">
              <Icon name="alert" />
              <span>{disableReason}</span>
            </div>
          )}
          <div className="pc-form-footer-actions">
            {footerExtra}
            <button
              className="btn btn-primary"
              type="submit"
              disabled={!validation.ok || submitting}
              title={!validation.ok ? disableReason : undefined}
            >
              {submitting ? "保存中…" : submitLabel}
            </button>
          </div>
        </div>
      )}
    </form>
  );
}
