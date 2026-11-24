export const PRODUCT_CARD_STATUSES = ["published", "archived"] as const;
export type ProductCardStatus = (typeof PRODUCT_CARD_STATUSES)[number];

export const PRODUCT_CARD_REQUIRED_FIELDS = [
  "name",
  "category",
  "sellingPoints",
  "specifications",
  "materialsCraft",
  "audienceScenarios",
  "packageContents",
] as const;
export type ProductCardRequiredField = (typeof PRODUCT_CARD_REQUIRED_FIELDS)[number];

export const PRODUCT_CARD_OPTIONAL_FIELDS = [
  "skuCode",
  "painPointsComparison",
  "usageDemoHighlights",
  "certificationsProhibitions",
] as const;
export type ProductCardOptionalField = (typeof PRODUCT_CARD_OPTIONAL_FIELDS)[number];

export type ProductCardFieldKey = ProductCardRequiredField | ProductCardOptionalField;

export const PRODUCT_CARD_ALL_FIELDS: readonly ProductCardFieldKey[] = [
  ...PRODUCT_CARD_REQUIRED_FIELDS,
  ...PRODUCT_CARD_OPTIONAL_FIELDS,
];

export const PRODUCT_CARD_NO_EXTRA_ACCESSORIES_TEXT = "单品本体 ×1，无额外配件";

export const PRODUCT_CARD_FIELD_LABELS: Record<ProductCardFieldKey, string> = {
  name: "商品名称",
  category: "商品类目",
  sellingPoints: "核心卖点",
  specifications: "规格参数与尺寸重量",
  materialsCraft: "材质与工艺细节",
  audienceScenarios: "适用人群与使用场景",
  packageContents: "包装清单 / 配件说明",
  skuCode: "内部 SKU / 款号",
  painPointsComparison: "用户痛点与自身对比数据",
  usageDemoHighlights: "使用方法 / 动态演示亮点",
  certificationsProhibitions: "认证资质与宣传禁忌",
};

export const PRODUCT_CARD_FIELD_LIMITS = {
  name: { min: 1, max: 120 },
  category: { min: 1, max: 60 },
  sellingPoints: { minItems: 1, maxItems: 10, itemMin: 1, itemMax: 200 },
  specifications: { min: 1, max: 1000 },
  materialsCraft: { min: 1, max: 800 },
  audienceScenarios: { min: 1, max: 800 },
  packageContents: { min: 1, max: 600 },
  skuCode: { min: 0, max: 80 },
  painPointsComparison: { min: 0, max: 1000 },
  usageDemoHighlights: { min: 0, max: 1000 },
  certificationsProhibitions: { min: 0, max: 800 },
} as const;

export const PRODUCT_CARD_MAX_SUPPLIER_IMAGES = 6;
export const PRODUCT_CARD_MAX_IMAGE_BYTES = 12 * 1024 * 1024;
export const PRODUCT_CARD_MAX_IMAGE_BASE64_CHARS = Math.ceil(PRODUCT_CARD_MAX_IMAGE_BYTES / 3) * 4;
export const PRODUCT_CARD_ALLOWED_IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;
export type ProductCardAllowedImageMime = (typeof PRODUCT_CARD_ALLOWED_IMAGE_MIMES)[number];

export interface ProductCardFields {
  name: string;
  category: string;
  sellingPoints: string[];
  specifications: string;
  materialsCraft: string;
  audienceScenarios: string;
  packageContents: string;
  skuCode: string;
  painPointsComparison: string;
  usageDemoHighlights: string;
  certificationsProhibitions: string;
}

export interface ProductCardSupplierImage {
  id: string;
  productCardId: string;
  ordinal: number;
  originalObjectKey: string;
  thumbnailObjectKey: string;
  sha256: string;
  width: number;
  height: number;
  mimeType: string;
  originalFilename: string;
  createdAt: string;
  originalPreviewUrl: string;
  thumbnailPreviewUrl: string;
}

export interface ProductCard extends ProductCardFields {
  id: string;
  status: ProductCardStatus;
  sourceSessionId: string | null;
  revision: number;
  supplierImages: ProductCardSupplierImage[];
  coverThumbnailUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductCardSummary {
  id: string;
  status: ProductCardStatus;
  name: string;
  category: string;
  skuCode: string;
  sellingPoints: string[];
  revision: number;
  supplierImageCount: number;
  coverThumbnailUrl: string | null;
  sourceSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductCardSnapshot extends ProductCardFields {
  cardId: string;
  revision: number;
  coverThumbnailUrl: string | null;
  snapshotAt: string;
}

export type ProductCardValidationResult =
  | { ok: true; value: ProductCardFields }
  | {
      ok: false;
      code: "PRODUCT_CARD_REQUIRED_FIELDS_MISSING" | "PRODUCT_CARD_VALIDATION_FAILED";
      message: string;
      missingFields: ProductCardRequiredField[];
      fieldErrors: Partial<Record<ProductCardFieldKey, string>>;
    };

export function productCardCharLength(value: string): number {
  return Array.from(value).length;
}

export function emptyProductCardFields(): ProductCardFields {
  return {
    name: "",
    category: "",
    sellingPoints: [],
    specifications: "",
    materialsCraft: "",
    audienceScenarios: "",
    packageContents: "",
    skuCode: "",
    painPointsComparison: "",
    usageDemoHighlights: "",
    certificationsProhibitions: "",
  };
}

export function buildProductCardImagePreviewUrl(
  cardId: string,
  imageId: string,
  variant: "original" | "thumbnail",
): string {
  return `/api/product-cards/${cardId}/images/${imageId}/preview/${variant}`;
}

export function createProductCardSnapshot(
  card: ProductCard,
  snapshotAt = new Date().toISOString(),
): ProductCardSnapshot {
  return {
    cardId: card.id,
    revision: card.revision,
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
    coverThumbnailUrl: card.coverThumbnailUrl,
    snapshotAt,
  };
}

export function getMissingRequiredProductCardFields(
  fields: Partial<ProductCardFields> | null | undefined,
): ProductCardRequiredField[] {
  if (!fields || typeof fields !== "object") return [...PRODUCT_CARD_REQUIRED_FIELDS];
  const missing: ProductCardRequiredField[] = [];
  for (const key of PRODUCT_CARD_REQUIRED_FIELDS) {
    if (key === "sellingPoints") {
      const points = Array.isArray(fields.sellingPoints)
        ? fields.sellingPoints.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : [];
      if (points.length === 0) missing.push("sellingPoints");
      continue;
    }
    const raw = fields[key];
    if (typeof raw !== "string" || raw.trim().length === 0) {
      missing.push(key);
    }
  }
  return missing;
}

const REQUIRED_TEXT_FIELDS = [
  "name",
  "category",
  "specifications",
  "materialsCraft",
  "audienceScenarios",
  "packageContents",
] as const;

export function validateProductCardFields(input: unknown): ProductCardValidationResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      code: "PRODUCT_CARD_VALIDATION_FAILED",
      message: "商品信息卡请求体必须是对象",
      missingFields: [...PRODUCT_CARD_REQUIRED_FIELDS],
      fieldErrors: {},
    };
  }

  const record = input as Record<string, unknown>;
  const missingFields: ProductCardRequiredField[] = [];
  const fieldErrors: Partial<Record<ProductCardFieldKey, string>> = {};
  const result = emptyProductCardFields();

  for (const key of REQUIRED_TEXT_FIELDS) {
    const raw = record[key];
    const limit = PRODUCT_CARD_FIELD_LIMITS[key];
    const label = PRODUCT_CARD_FIELD_LABELS[key];
    if (raw === undefined || raw === null) {
      missingFields.push(key);
      fieldErrors[key] = `请填写${label}`;
      continue;
    }
    if (typeof raw !== "string") {
      fieldErrors[key] = `${label}必须是文本`;
      continue;
    }
    const trimmed = raw.trim();
    const len = productCardCharLength(trimmed);
    if (len < limit.min) {
      missingFields.push(key);
      fieldErrors[key] = `请填写${label}`;
      continue;
    }
    if (len > limit.max) {
      fieldErrors[key] = `${label}不能超过 ${limit.max} 字`;
      continue;
    }
    result[key] = trimmed;
  }

  const rawPoints = record.sellingPoints;
  const spLimit = PRODUCT_CARD_FIELD_LIMITS.sellingPoints;
  if (rawPoints === undefined || rawPoints === null) {
    missingFields.push("sellingPoints");
    fieldErrors.sellingPoints = `请至少填写 ${spLimit.minItems} 条核心卖点`;
  } else if (!Array.isArray(rawPoints)) {
    fieldErrors.sellingPoints = "核心卖点必须是字符串数组";
  } else {
    const cleaned: string[] = [];
    let spError: string | null = null;
    for (const item of rawPoints) {
      if (typeof item !== "string") {
        spError = "每条核心卖点必须是文本";
        break;
      }
      const trimmed = item.trim();
      if (!trimmed) continue;
      if (productCardCharLength(trimmed) > spLimit.itemMax) {
        spError = `单条核心卖点不能超过 ${spLimit.itemMax} 字`;
        break;
      }
      cleaned.push(trimmed);
    }
    if (spError) {
      fieldErrors.sellingPoints = spError;
    } else if (cleaned.length < spLimit.minItems) {
      missingFields.push("sellingPoints");
      fieldErrors.sellingPoints = `请至少填写 ${spLimit.minItems} 条核心卖点`;
    } else if (cleaned.length > spLimit.maxItems) {
      fieldErrors.sellingPoints = `核心卖点最多填写 ${spLimit.maxItems} 条`;
    } else {
      result.sellingPoints = cleaned;
    }
  }

  for (const key of PRODUCT_CARD_OPTIONAL_FIELDS) {
    const raw = record[key];
    const limit = PRODUCT_CARD_FIELD_LIMITS[key];
    const label = PRODUCT_CARD_FIELD_LABELS[key];
    if (raw === undefined || raw === null) {
      result[key] = "";
      continue;
    }
    if (typeof raw !== "string") {
      fieldErrors[key] = `${label}必须是文本`;
      continue;
    }
    const trimmed = raw.trim();
    if (productCardCharLength(trimmed) > limit.max) {
      fieldErrors[key] = `${label}不能超过 ${limit.max} 字`;
      continue;
    }
    result[key] = trimmed;
  }

  const errorKeys = Object.keys(fieldErrors) as ProductCardFieldKey[];
  if (errorKeys.length > 0) {
    const hasNonMissingError = errorKeys.some(
      (key) => !(missingFields as readonly string[]).includes(key),
    );
    if (!hasNonMissingError && missingFields.length > 0) {
      const missingLabels = missingFields.map((key) => PRODUCT_CARD_FIELD_LABELS[key]).join("、");
      return {
        ok: false,
        code: "PRODUCT_CARD_REQUIRED_FIELDS_MISSING",
        message: `请补齐必填商品信息：${missingLabels}`,
        missingFields,
        fieldErrors,
      };
    }
    const firstMessage = fieldErrors[errorKeys[0]] ?? "商品信息卡字段不符合校验规则";
    return {
      ok: false,
      code: "PRODUCT_CARD_VALIDATION_FAILED",
      message: firstMessage,
      missingFields,
      fieldErrors,
    };
  }

  return { ok: true, value: result };
}

export function formatProductCardFacts(snapshot: ProductCardFields | ProductCardSnapshot): string {
  const lines: string[] = [];
  const pushLine = (label: string, value: string | undefined) => {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed) lines.push(`${label}：${trimmed}`);
  };

  pushLine(PRODUCT_CARD_FIELD_LABELS.name, snapshot.name);
  pushLine(PRODUCT_CARD_FIELD_LABELS.skuCode, snapshot.skuCode);
  pushLine(PRODUCT_CARD_FIELD_LABELS.category, snapshot.category);

  const sellingPoints = Array.isArray(snapshot.sellingPoints)
    ? snapshot.sellingPoints.map((item) => item.trim()).filter(Boolean)
    : [];
  if (sellingPoints.length > 0) {
    lines.push(
      `${PRODUCT_CARD_FIELD_LABELS.sellingPoints}：\n${sellingPoints.map((point, index) => `${index + 1}. ${point}`).join("\n")}`,
    );
  }

  pushLine(PRODUCT_CARD_FIELD_LABELS.specifications, snapshot.specifications);
  pushLine(PRODUCT_CARD_FIELD_LABELS.materialsCraft, snapshot.materialsCraft);
  pushLine(PRODUCT_CARD_FIELD_LABELS.audienceScenarios, snapshot.audienceScenarios);
  pushLine(PRODUCT_CARD_FIELD_LABELS.packageContents, snapshot.packageContents);
  pushLine(PRODUCT_CARD_FIELD_LABELS.painPointsComparison, snapshot.painPointsComparison);
  pushLine(PRODUCT_CARD_FIELD_LABELS.usageDemoHighlights, snapshot.usageDemoHighlights);
  pushLine(PRODUCT_CARD_FIELD_LABELS.certificationsProhibitions, snapshot.certificationsProhibitions);

  return lines.join("\n");
}
