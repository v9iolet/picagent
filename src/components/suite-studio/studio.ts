import type { ListingConfig } from "../../../shared/listing-config";
import { readProductCardSnapshot, type ProductCardSnapshot } from "../../../shared/product-card";
import {
  postGeneration, createGenerationActions, fetchApiResponse,
  type ApiImage,
  type ApiListingSummary,
  type ApiPlanSnapshot,
  type ApiSuite,
  type ApiTaskStatus,
} from "../../api/client";
import { SUPPORTED_OUTPUT_LANGUAGES, type ResolvedDeliverySlot } from "../../../shared/workbench-delivery";
import { defaultImageOptions, type ModelSettingsView } from "../../../shared/model-settings";
import {
  SMART_SUITE_STRUCTURE_PRESET,
  SUITE_CATEGORY_GROUPS,
  type SuiteCategoryGroupCode,
} from "../../../shared/suite-categories";
import { resolveSellingPointLayouts, resolveVisualStyle } from "../../../shared/selling-point-layouts";
import {
  buildFeedUrl,
  type GenerationHistoryFeedPage,
  type GenerationHistoryOrigin,
} from "../generation-history/history-model";
import {
  toSelectedProductCardSummary,
  type SelectedProductCardSummary,
} from "../product-card-picker/types";

export type Counts = Record<SuiteCategoryGroupCode, number>;
export interface Config extends ListingConfig {
  aspectRatio: string;
  size: string;
  mode: "smart" | "custom";
  counts: Counts;
  visualStyle: string;
  sellingPointLayouts: string[];
  listingCopy: boolean;
  productCardId: string | null;
  productCardSummary: SelectedProductCardSummary | null;
  productCardSnapshot: ProductCardSnapshot | null;
}
export const initialConfig: Config = {
  platform: "",
  targetMarket: "美国",
  outputLanguage: SUPPORTED_OUTPUT_LANGUAGES[0].value,
  aspectRatio: "1:1",
  size: "1K",
  sellingPoints: "",
  mode: "smart",
  counts: {
    main: SUITE_CATEGORY_GROUPS.main.defaultCount,
    selling_points: SUITE_CATEGORY_GROUPS.selling_points.defaultCount,
    lifestyle: SUITE_CATEGORY_GROUPS.lifestyle.defaultCount,
    other: SUITE_CATEGORY_GROUPS.other.defaultCount,
  },
  visualStyle: "auto",
  sellingPointLayouts: [],
  listingCopy: false,
  productCardId: null,
  productCardSummary: null,
  productCardSnapshot: null,
};
export function totalImages(c: Config) {
  return c.mode === "smart"
    ? SMART_SUITE_STRUCTURE_PRESET.main_image_count + SMART_SUITE_STRUCTURE_PRESET.detail_image_count_max
    : Object.values(c.counts).reduce((a, b) => a + b, 0);
}
export function currentImageOptions(settings: ModelSettingsView) {
  const pref = settings.preferences.image;
  const model = settings.channels
    .find((c) => c.id === pref?.channelId)
    ?.models.find((m) => m.id === pref?.modelId && m.capabilities.includes("image"));
  return model?.imageOptions ?? defaultImageOptions(model?.id ?? "");
}
export interface Pipeline {
  status:
    | "running"
    | "completed"
    | "failed"
    | "partial_failed"
    | "waiting_base_refine_decision"
    | "waiting_human_input";
  currentPhase: string;
  config: Partial<Config> & { refineBaseImages?: boolean };
  errorCode: string | null;
  errorMessage: string | null;
}
export interface StudioState {
  suite: ApiSuite;
  pipeline: Pipeline | null;
  listingCopy: ApiListingSummary | null;
  inputImages: ApiImage[];
  cards: Array<ResolvedDeliverySlot & { taskStatus?: ApiTaskStatus }>;
  planning: {
    snapshot: ApiPlanSnapshot | null;
    notGeneratedReasons: { category: string; reasons: string[] }[];
  };
  progress: { total: number; completed: number; percent: number };
}
const path = (id: string) => `/api/suites/${encodeURIComponent(id)}`;
const submitGeneration = createGenerationActions();
async function json<T>(url: string, body?: object, signal?: AbortSignal): Promise<T> {
  if (body) return submitGeneration(url, body, (key) => postGeneration<T>(url, body, key));
  const response = await fetchApiResponse(url, { signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message ?? `请求失败 (${response.status})`);
  return data.data;
}
export const studioApi = {
  state: (id: string, signal?: AbortSignal) => json<StudioState>(`${path(id)}/studio-state`, undefined, signal),
  feed: (params: {
    origin?: GenerationHistoryOrigin;
    keyword?: string;
    limit?: number;
    offset?: number;
  } = {}) =>
    json<GenerationHistoryFeedPage>(
      buildFeedUrl({
        origin: params.origin ?? "suite_studio",
        keyword: params.keyword,
        limit: params.limit ?? 10,
        offset: params.offset ?? 0,
      }),
    ),
  start: (
    source: { suiteId: string } | { cloneFrom: { suiteId: string; imageIds: string[] } },
    config: Config,
  ) => {
    const {
      productCardSummary: _ignoredSummary,
      productCardSnapshot: _ignoredSnapshot,
      productCardId,
      ...rest
    } = config;
    const payloadConfig = productCardId ? { ...rest, productCardId } : rest;
    return json<{ suiteId: string; pipeline: Pipeline }>("/api/suites/one-click-generate", {
      ...source,
      config: payloadConfig,
    });
  },
  resume: (id: string, action: string, fields?: object) =>
    json(`${path(id)}/one-click-generate/resume`, { action, ...fields }),
  exportUrl: (id: string, ids: string[]) =>
    `${path(id)}/delivery/export?${new URLSearchParams({ taskIds: ids.join(",") })}`,
};
export function fromRun(run: Pipeline | null): Config {
  const {
    refineBaseImages,
    productCardSummary: _ignoredSummary,
    productCardSnapshot: rawSnapshot,
    productCardId: rawProductCardId,
    ...config
  } = run?.config ?? {};
  const counts = { ...initialConfig.counts, ...config.counts };
  const productCardSnapshot = readProductCardSnapshot(rawSnapshot);
  const productCardId =
    typeof rawProductCardId === "string" && rawProductCardId.trim()
      ? rawProductCardId.trim()
      : (productCardSnapshot?.cardId ?? null);
  const productCardSummary = productCardSnapshot
    ? toSelectedProductCardSummary(productCardSnapshot)
    : null;
  return {
    ...initialConfig,
    ...config,
    counts,
    visualStyle: resolveVisualStyle(config.visualStyle).id,
    sellingPointLayouts: config.mode === "smart"
      ? []
      : resolveSellingPointLayouts(config.sellingPointLayouts, counts.selling_points).map(({ id }) => id),
    productCardId,
    productCardSummary,
    productCardSnapshot,
  };
}
export async function download(url: string, name: string) {
  const res = await fetchApiResponse(url);
  if (!res.ok) throw new Error(`下载失败 (${res.status})`);
  const blob = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = blob;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(blob), 1000);
}
export const message = (e: unknown) => (e instanceof Error ? e.message : "操作失败，请重试");
