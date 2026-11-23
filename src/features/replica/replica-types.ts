import type { ImageOptions } from "../../../shared/model-settings";
import type { ResolvedDeliverySlot } from "../../../shared/workbench-delivery";
import { createIdempotencyKey, type ApiImage, type ApiSuite } from "../../api/client";

export type ReplicaSceneType =
  | "ecommerce_product"
  | "apparel"
  | "marketing_poster"
  | "social_post"
  | "other";

export type ReplicaCloneLevel = "compose" | "high";
export type ReplicaLanguage = "zh" | "en";

export const REPLICA_MAX_REFERENCES = 6;
export const REPLICA_MAX_PRODUCTS = 6;
export const REPLICA_REMARK_MAX_LENGTH = 200;
export const REPLICA_UNIFIED_REQUIREMENT_MAX_LENGTH = 1000;
export const REPLICA_MAX_IMAGE_BYTES = 12 * 1024 * 1024;
export const REPLICA_ACCEPTED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export const REPLICA_SCENE_OPTIONS: ReadonlyArray<{
  value: ReplicaSceneType;
  label: string;
}> = [
  { value: "ecommerce_product", label: "电商商品图" },
  { value: "apparel", label: "服饰电商图" },
  { value: "marketing_poster", label: "营销海报" },
  { value: "social_post", label: "社媒图文" },
  { value: "other", label: "其他" },
];

export const REPLICA_SCENE_LABELS: Record<ReplicaSceneType, string> = {
  ecommerce_product: "电商商品图",
  apparel: "服饰电商图",
  marketing_poster: "营销海报",
  social_post: "社媒图文",
  other: "其他",
};

export const REPLICA_CLONE_LEVEL_OPTIONS: ReadonlyArray<{
  value: ReplicaCloneLevel;
  label: string;
  shortDesc: string;
  hoverTitle: string;
  hoverDesc: string;
  previewImage: string;
}> = [
  {
    value: "compose",
    label: "参考风格",
    shortDesc: "参考整体风格结构，重塑色彩与场景",
    hoverTitle: "参考风格（compose）",
    hoverDesc: "提取参考图的风格调性与视觉层次，结合产品形态重新编排光影与场景。",
    previewImage: "/replica/clone-level-compose.svg",
  },
  {
    value: "high",
    label: "高度复刻",
    shortDesc: "沿用参考图构图与版式，替换商品和文案",
    hoverTitle: "高度复刻（high）",
    hoverDesc: "严格沿用参考图的构图机位、版式与文字位置，仅替换商品主体与新文案。",
    previewImage: "/replica/clone-level-high.svg",
  },
];

export const REPLICA_CLONE_LEVEL_LABELS: Record<ReplicaCloneLevel, string> = {
  compose: "参考风格",
  high: "高度复刻",
};

export const REPLICA_LANGUAGE_OPTIONS: ReadonlyArray<{
  value: ReplicaLanguage;
  label: string;
}> = [
  { value: "zh", label: "中文" },
  { value: "en", label: "英文" },
];

export interface ReplicaReferenceDraft {
  localId: string;
  filename: string;
  mimeType: string;
  previewUrl: string;
  bytesBase64: string;
  sha256: string;
  remark: string;
  status: "reading" | "ready" | "error";
  error?: string;
}

export type ReplicaProductDraft =
  | {
      localId: string;
      sourceKind: "upload";
      filename: string;
      mimeType: string;
      previewUrl: string;
      bytesBase64: string;
      sha256: string;
      status: "reading" | "ready" | "error";
      error?: string;
    }
  | {
      localId: string;
      sourceKind: "library";
      libraryResourceId: string;
      resourceVersionId: string;
      title: string;
      previewUrl: string;
      resourceType?: "base_image" | "input_image";
      status: "ready";
    };

export interface ReplicaConfigDraft {
  sceneType: ReplicaSceneType;
  cloneLevel: ReplicaCloneLevel;
  unifiedRequirement: string;
  productInfo: string;
  styleUnified: boolean;
  language: ReplicaLanguage;
  ratio: string;
  size: string;
}

export const INITIAL_REPLICA_CONFIG: ReplicaConfigDraft = {
  sceneType: "ecommerce_product",
  cloneLevel: "high",
  unifiedRequirement: "",
  productInfo: "",
  styleUnified: true,
  language: "zh",
  ratio: "reference",
  size: "1K",
};

export interface ReplicaCreatePayload {
  references: Array<{
    filename: string;
    mimeType: string;
    bytesBase64: string;
    remark?: string;
  }>;
  products: Array<
    | { filename: string; mimeType: string; bytesBase64: string }
    | { libraryResourceId: string }
  >;
  sceneType: ReplicaSceneType;
  cloneLevel: ReplicaCloneLevel;
  unifiedRequirement: string;
  productInfo: string;
  styleUnified: boolean;
  language: ReplicaLanguage;
  ratio: string;
  size: string;
}

export interface ReplicaBatchConfigView {
  sceneType?: ReplicaSceneType;
  cloneLevel?: ReplicaCloneLevel;
  unifiedRequirement?: string;
  productInfo?: string;
  styleUnified?: boolean;
  language?: ReplicaLanguage;
  ratio?: string;
  size?: string;
  hasProductImages?: boolean;
  referenceCount?: number;
  productImageCount?: number;
}

export interface ReplicaResultCard extends ResolvedDeliverySlot {
  replicaReferenceId?: string | null;
  replicaReferenceThumbnailUrl?: string | null;
  styleSketch?: boolean;
}

export interface ReplicaReferenceView {
  id: string;
  suiteId: string;
  ordinal: number;
  filename: string;
  mimeType: string;
  width: number;
  height: number;
  remark: string;
  thumbnailPreviewUrl: string;
  originalPreviewUrl: string;
}

export interface ReplicaStudioState {
  suite: ApiSuite;
  pipeline: {
    status: "running" | "completed" | "failed" | "partial_failed" | string;
    currentPhase: string;
    config: ReplicaBatchConfigView;
    errorCode: string | null;
    errorMessage: string | null;
  } | null;
  inputImages: ApiImage[];
  cards: ReplicaResultCard[];
  progress: { total: number; completed: number; percent: number };
  styleSketch?: boolean;
  replicaReferences?: ReplicaReferenceView[];
  replicaProducts?: Array<Record<string, unknown>>;
}

export function charCount(value: string): number {
  return Array.from(value).length;
}

export function allowedReplicaSizes(options: ImageOptions): string[] {
  const filtered = options.sizes.filter((size) => size !== "4K");
  return filtered.length > 0 ? filtered : ["1K"];
}

export function defaultReplicaSize(sizes: readonly string[]): string {
  return sizes.includes("1K") ? "1K" : (sizes[0] ?? "1K");
}

export function needsNoProductWarning(
  sceneType: ReplicaSceneType,
  validProductCount: number,
): boolean {
  return validProductCount === 0 && (sceneType === "ecommerce_product" || sceneType === "apparel");
}

export function validateImageFile(file: File): string | null {
  if (!(REPLICA_ACCEPTED_MIME_TYPES as readonly string[]).includes(file.type)) {
    return "仅支持 JPG、PNG 或 WebP 图片";
  }
  if (file.size === 0) {
    return "图片文件为空";
  }
  if (file.size > REPLICA_MAX_IMAGE_BYTES) {
    return "图片超过 12MB 限制";
  }
  return null;
}

export interface ReplicaSubmitState {
  canSubmit: boolean;
  validReferenceCount: number;
  buttonLabel: string;
  disabledReason: string | null;
}

export function getReplicaSubmitState(
  references: readonly ReplicaReferenceDraft[],
  products: readonly ReplicaProductDraft[],
  config: ReplicaConfigDraft,
  submitting: boolean,
): ReplicaSubmitState {
  const validRefs = references.filter((item) => item.status === "ready");
  const validReferenceCount = validRefs.length;
  const buttonLabel = submitting ? "提交中…" : `一键复刻（${validReferenceCount}张）`;

  if (submitting) {
    return { canSubmit: false, validReferenceCount, buttonLabel, disabledReason: "正在提交复刻任务…" };
  }
  if (references.some((item) => item.status === "reading") || products.some((item) => item.status === "reading")) {
    return { canSubmit: false, validReferenceCount, buttonLabel, disabledReason: "图片读取处理中，请稍候" };
  }
  if (references.some((item) => item.status === "error")) {
    return { canSubmit: false, validReferenceCount, buttonLabel, disabledReason: "存在上传失败的参考图，请移除后重试" };
  }
  if (products.some((item) => item.status === "error")) {
    return { canSubmit: false, validReferenceCount, buttonLabel, disabledReason: "存在上传失败的产品原图，请移除后重试" };
  }
  if (validReferenceCount === 0) {
    return { canSubmit: false, validReferenceCount, buttonLabel, disabledReason: "请至少上传 1 张参考图" };
  }
  if (validRefs.some((item) => charCount(item.remark.trim()) > REPLICA_REMARK_MAX_LENGTH)) {
    return {
      canSubmit: false,
      validReferenceCount,
      buttonLabel,
      disabledReason: `单张参考要求不能超过 ${REPLICA_REMARK_MAX_LENGTH} 字`,
    };
  }
  if (charCount(config.unifiedRequirement.trim()) > REPLICA_UNIFIED_REQUIREMENT_MAX_LENGTH) {
    return {
      canSubmit: false,
      validReferenceCount,
      buttonLabel,
      disabledReason: `统一复刻要求不能超过 ${REPLICA_UNIFIED_REQUIREMENT_MAX_LENGTH} 字`,
    };
  }

  return { canSubmit: true, validReferenceCount, buttonLabel, disabledReason: null };
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

// Pure JS SHA-256 fallback for environments where crypto.subtle is unavailable (e.g. plain HTTP non-localhost).
function sha256FallbackHex(data: Uint8Array): string {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const bitLen = data.length * 8;
  const paddedLen = Math.ceil((data.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  const W = new Uint32Array(64);
  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      W[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = ((W[i - 15] >>> 7) | (W[i - 15] << 25)) ^ ((W[i - 15] >>> 18) | (W[i - 15] << 14)) ^ (W[i - 15] >>> 3);
      const s1 = ((W[i - 2] >>> 17) | (W[i - 2] << 15)) ^ ((W[i - 2] >>> 19) | (W[i - 2] << 13)) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0;
    H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0;
    H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0;
    H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0;
    H[7] = (H[7] + h) >>> 0;
  }
  return Array.from(H, (word) => word.toString(16).padStart(8, "0")).join("");
}

export async function computeSha256Hex(buffer: ArrayBuffer): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return sha256FallbackHex(new Uint8Array(buffer));
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const payload = (await response.json().catch(() => null)) as {
    data?: T;
    error?: { message?: string };
  } | null;
  if (!response.ok || payload?.data === undefined) {
    throw new Error(payload?.error?.message ?? `请求失败 (${response.status})`);
  }
  return payload.data;
}

export const replicaApi = {
  create(payload: ReplicaCreatePayload) {
    return fetchJson<{ suiteId: string; runId: string }>("/api/replicas", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": createIdempotencyKey(),
      },
      body: JSON.stringify(payload),
    });
  },
  state(suiteId: string) {
    return fetchJson<ReplicaStudioState>(`/api/suites/${encodeURIComponent(suiteId)}/studio-state`);
  },
};
