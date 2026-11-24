import type {
  ProductCard,
  ProductCardFields,
  ProductCardRequiredField,
} from "./product-card.js";
import { PRODUCT_CARD_MAX_SUPPLIER_IMAGES } from "./product-card.js";

export const PRODUCT_ONBOARDING_STATUSES = ["draft", "completed"] as const;
export type ProductOnboardingStatus = (typeof PRODUCT_ONBOARDING_STATUSES)[number];

export const PRODUCT_ONBOARDING_MAX_MESSAGE_CHARS = 10_000;
export const PRODUCT_ONBOARDING_MAX_TXT_FILES_PER_MESSAGE = 3;
export const PRODUCT_ONBOARDING_MAX_TXT_FILE_BYTES = 200 * 1024;
export const PRODUCT_ONBOARDING_MAX_SUPPLIER_IMAGES = PRODUCT_CARD_MAX_SUPPLIER_IMAGES;
export const PRODUCT_ONBOARDING_DEFAULT_TITLE = "未命名新品建档";

export interface ProductOnboardingDraftImage {
  id: string;
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

export interface ProductOnboardingTxtAttachment {
  kind: "txt";
  filename: string;
  byteLength: number;
  charCount: number;
  content: string;
}

export interface ProductOnboardingImageAttachment {
  kind: "image";
  imageId: string;
  filename: string;
  mimeType: string;
  thumbnailPreviewUrl: string;
}

export type ProductOnboardingAttachment =
  | ProductOnboardingTxtAttachment
  | ProductOnboardingImageAttachment;

export interface ProductOnboardingMessage {
  id: string;
  sessionId: string;
  ordinal: number;
  role: "user" | "assistant";
  content: string;
  attachments: ProductOnboardingAttachment[];
  templateVersionId: string | null;
  modelSnapshot: Record<string, unknown> | null;
  createdAt: string;
}

export interface ProductOnboardingSessionSummary {
  id: string;
  title: string;
  status: ProductOnboardingStatus;
  draftCard: ProductCardFields;
  missingRequiredFields: ProductCardRequiredField[];
  supplierImageCount: number;
  coverThumbnailUrl: string | null;
  productCardId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductOnboardingSession {
  id: string;
  title: string;
  status: ProductOnboardingStatus;
  draftCard: ProductCardFields;
  supplierImages: ProductOnboardingDraftImage[];
  missingRequiredFields: ProductCardRequiredField[];
  productCardId: string | null;
  messages: ProductOnboardingMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface ProductOnboardingSessionListResult {
  items: ProductOnboardingSessionSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface ProductOnboardingPublishResult {
  session: ProductOnboardingSession;
  productCard: ProductCard | null;
}

export function buildProductOnboardingImagePreviewUrl(
  sessionId: string,
  imageId: string,
  variant: "original" | "thumbnail",
): string {
  return `/api/product-onboarding/sessions/${sessionId}/images/${imageId}/preview/${variant}`;
}
