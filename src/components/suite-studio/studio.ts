import type { ListingConfig } from "../../../shared/listing-config";
import {
  createIdempotencyKey,
  type ApiImage,
  type ApiListingSummary,
  type ApiPlanSnapshot,
  type ApiSuite,
} from "../../api/client";
import { SUPPORTED_OUTPUT_LANGUAGES, type ResolvedDeliverySlot } from "../../../shared/workbench-delivery";
import { defaultImageOptions, type ModelSettingsView } from "../../../shared/model-settings";
import {
  SMART_SUITE_STRUCTURE_PRESET,
  SUITE_CATEGORY_GROUPS,
  type SuiteCategoryGroupCode,
} from "../../../shared/suite-categories";
import { resolveSellingPointLayouts, resolveVisualStyle } from "../../../shared/selling-point-layouts";

export type Counts = Record<SuiteCategoryGroupCode, number>;
export interface Config extends ListingConfig {
  aspectRatio: string;
  size: string;
  mode: "smart" | "custom";
  counts: Counts;
  visualStyle: string;
  sellingPointLayouts: string[];
  listingCopy: boolean;
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
  cards: ResolvedDeliverySlot[];
  planning: {
    snapshot: ApiPlanSnapshot | null;
    notGeneratedReasons: { category: string; reasons: string[] }[];
  };
  progress: { total: number; completed: number; percent: number };
}
const path = (id: string) => `/api/suites/${encodeURIComponent(id)}`;
async function json<T>(url: string, body?: object): Promise<T> {
  const response = await fetch(
    url,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": createIdempotencyKey() },
          body: JSON.stringify(body),
        }
      : { cache: "no-store" },
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message ?? `请求失败 (${response.status})`);
  return data.data;
}
export const studioApi = {
  state: (id: string) => json<StudioState>(`${path(id)}/studio-state`),
  feed: (offset: number) =>
    json<{ items: { suite: ApiSuite }[]; total: number }>(`/api/suites/feed?limit=10&offset=${offset}`),
  start: (
    source: { suiteId: string } | { cloneFrom: { suiteId: string; imageIds: string[] } },
    config: Config,
  ) => json<{ suiteId: string; pipeline: Pipeline }>("/api/suites/one-click-generate", { ...source, config }),
  resume: (id: string, action: string, fields?: object) =>
    json(`${path(id)}/one-click-generate/resume`, { action, ...fields }),
  exportUrl: (id: string, ids: string[]) =>
    `${path(id)}/delivery/export?${new URLSearchParams({ taskIds: ids.join(",") })}`,
};
export function fromRun(run: Pipeline | null): Config {
  const { refineBaseImages, ...config } = run?.config ?? {};
  const counts = { ...initialConfig.counts, ...config.counts };
  return {
    ...initialConfig,
    ...config,
    counts,
    visualStyle: resolveVisualStyle(config.visualStyle).id,
    sellingPointLayouts: resolveSellingPointLayouts(config.sellingPointLayouts, counts.selling_points).map(({ id }) => id),
  };
}
export async function download(url: string, name: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败 (${res.status})`);
  const blob = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = blob;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(blob), 1000);
}
export const message = (e: unknown) => (e instanceof Error ? e.message : "操作失败，请重试");
