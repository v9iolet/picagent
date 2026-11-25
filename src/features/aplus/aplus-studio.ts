import {
  APLUS_SIZE_PRESETS,
  DEFAULT_APLUS_MODULE_CODES,
  validateAplusSizePresets,
  type AplusModuleCode,
  type AplusPlanInputSummary,
  type AplusSizePresetKey,
} from "../../../shared/aplus";
import type { ProductCardSnapshot } from "../../../shared/product-card";
import type { ResolvedDeliverySlot } from "../../../shared/workbench-delivery";
import { createIdempotencyKey, request, type ApiTaskStatus, type ApiPlatformProfile, type ApiImage, type ApiSuite } from "../../api/client";
import type { SelectedProductCardSummary } from "../../components/product-card-picker/types";
import type { Pipeline } from "../../components/suite-studio/studio";

export type AplusConfig = Omit<AplusPlanInputSummary, "imageHashes" | "productCardId" | "productCardRevision"> & {
  resolution: "1K" | "2K";
  productCard: SelectedProductCardSummary | null;
};

export type AplusPlanModule = { moduleCode: AplusModuleCode; copyRequirements: string };

export type AplusResultCard = ResolvedDeliverySlot & {
  moduleCode: AplusModuleCode;
  sizePreset: AplusSizePresetKey;
  sortOrder: number;
  taskStatus: ApiTaskStatus;
  errorMessage: string | null;
};

type AplusPlanView = {
  globalPlan: string | null;
  modules: AplusPlanModule[];
  inputSnapshot: AplusPlanInputSummary | null;
  resolution: AplusConfig["resolution"] | null;
  productCardSnapshot: ProductCardSnapshot | null;
};

export type AplusStudioState = AplusPlanView & {
  suite: ApiSuite;
  pipeline: Omit<Pipeline, "config"> | null;
  inputImages: ApiImage[];
  cards: AplusResultCard[];
  progress: { total: number; completed: number; percent: number };
};

const initialConfig: AplusConfig = {
  platform: "",
  targetMarket: "美国",
  language: "en",
  sizePresets: [],
  resolution: "2K",
  productInfo: "",
  productCard: null,
  modules: DEFAULT_APLUS_MODULE_CODES,
};

export function configForPlatform(config: AplusConfig, profile: ApiPlatformProfile): AplusConfig {
  const defaults = [profile.detailSizePresets.default];
  return {
    ...config,
    platform: profile.code,
    sizePresets: validateAplusSizePresets(defaults, profile.detailSizePresets) ? defaults : [],
  };
}

export function toggleSizePreset(selected: AplusSizePresetKey[], key: AplusSizePresetKey): AplusSizePresetKey[] {
  if (!APLUS_SIZE_PRESETS[key].canCombine) return [key];
  if (selected.includes(key)) return selected.length > 1 ? selected.filter((item) => item !== key) : selected;
  return [...selected.filter((item) => APLUS_SIZE_PRESETS[item].canCombine), key];
}

export function currentPlanInput(config: AplusConfig, images: ApiImage[]): AplusPlanInputSummary {
  const { platform, targetMarket, language, sizePresets, productInfo, productCard, modules } = config;
  return {
    platform, targetMarket, language, sizePresets, productInfo, modules,
    productCardId: productCard?.cardId ?? null,
    productCardRevision: productCard?.revision ?? null,
    imageHashes: images.map((image) => image.sha256),
  };
}

export function makeAplusPayload(config: AplusConfig, images: ApiImage[]) {
  const { imageHashes: _imageHashes, ...input } = currentPlanInput(config, images);
  return {
    ...input,
    resolution: config.resolution,
    suiteId: images[0]?.suiteId,
    inputImageIds: images.map((image) => image.id),
  };
}

const path = (id: string) => `/api/aplus/${encodeURIComponent(id)}`;

function write<T>(url: string, body: object, method: "POST" | "PATCH" = "POST", key = createIdempotencyKey()) {
  return request<T>(url, {
    method,
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  });
}

type AplusRun = { suiteId: string; runId: string };
type AplusPayload = ReturnType<typeof makeAplusPayload>;

export const aplusApi = {
  state: (id: string) => request<AplusStudioState>(`${path(id)}/studio-state`),
  start: (id: string | undefined, body: AplusPayload, key: string) =>
    write<AplusRun>(id ? `${path(id)}/replan` : "/api/aplus", body, "POST", key),
  savePlan: (id: string, modules: AplusPlanModule[]) =>
    write<AplusPlanView>(`${path(id)}/plan`, { modules }, "PATCH"),
  confirm: (id: string, body: AplusPayload, key: string) =>
    write<AplusRun>(`${path(id)}/confirm`, body, "POST", key),
  resume: (id: string, key: string) => write<AplusRun>(`${path(id)}/resume`, {}, "POST", key),
  redraw: (taskId: string, additionalPrompt: string) =>
    write<{ batchId: string }>(`/api/suite-tasks/${encodeURIComponent(taskId)}/generation`, { additionalPrompt }),
};

export const aplusPath = (id: string) => `/create/aplus?suite=${encodeURIComponent(id)}`;

type AplusJob = { id: string; taskId: string; kind: "edit" | "redraw" };

export type AplusDraft = {
  config: AplusConfig;
  images: ApiImage[];
  uploadSuiteId: string | null;
  planEdits: AplusPlanModule[] | null;
  job: AplusJob | null;
};

export function newAplusDraft(): AplusDraft {
  return { config: initialConfig, images: [], uploadSuiteId: null, planEdits: null, job: null };
}
