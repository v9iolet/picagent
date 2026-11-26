import {
  validateAplusModuleCodes,
  type AplusModuleCode,
  type AplusPlanInputSummary,
  type AplusSizePresetKey,
} from "../../shared/aplus.js";
import type { ListingRules } from "../../shared/listing-config.js";
import type { ProductCardSnapshot } from "../../shared/product-card.js";
import { asRecord } from "../api-response.js";
import type { InputImage, LlmModelSnapshot, SuitePipelineRun, SuiteTask } from "../types.js";

export interface AplusPlanModule {
  moduleCode: AplusModuleCode;
  copyRequirements: string;
  imagePrompts: Partial<Record<AplusSizePresetKey, string>>;
}

interface AplusPlan {
  schemaVersion: "aplus-plan-v1";
  taskName: string;
  globalPlan: string;
  modules: AplusPlanModule[];
}

export interface AplusPlanSnapshot extends AplusPlan {
  templateVersionId: string;
  moduleRuleVersionIds: Partial<Record<AplusModuleCode, string>>;
  provider: LlmModelSnapshot;
}

export type AplusRunConfig = SuitePipelineRun["config"] & {
  inputSnapshot: AplusPlanInputSummary;
  sourceImages: InputImage[];
  productCardSnapshot: ProductCardSnapshot | null;
  resolution: "1K" | "2K";
  listingCopyRules: ListingRules | null;
  planSnapshot?: AplusPlanSnapshot;
  generation?: { confirmationKey: string | null; tasks: SuiteTask[] };
};

export function readAplusRunConfig(run: SuitePipelineRun): AplusRunConfig | null {
  if (!run.config.inputSnapshot) return null;
  const config = run.config as AplusRunConfig;
  return config.inputSnapshot.visualStyle == null
    ? { ...config, inputSnapshot: { ...config.inputSnapshot, visualStyle: "auto" } }
    : config;
}

export function validateAplusPlanOutput(value: unknown, input: AplusPlanInputSummary): AplusPlan | null {
  const raw = asRecord(value);
  const { taskName, globalPlan } = raw;
  if (
    raw.schemaVersion !== "aplus-plan-v1" || typeof taskName !== "string" ||
    Array.from(taskName).length > 20 || typeof globalPlan !== "string" || !globalPlan.trim() ||
    !Array.isArray(raw.modules) || raw.modules.length !== input.modules.length ||
    Object.keys(raw).length !== 4
  ) return null;

  const byCode = new Map<string, AplusPlanModule>();
  for (const module of raw.modules) {
    const entry = asRecord(module);
    const codes = [entry.moduleCode];
    const { copyRequirements } = entry;
    const imagePrompts = asRecord(entry.imagePrompts);
    if (
      !validateAplusModuleCodes(codes) || !input.modules.includes(codes[0]) ||
      byCode.has(codes[0]) || Object.keys(entry).length !== 3 ||
      typeof copyRequirements !== "string" || (input.language === "none" && copyRequirements !== "") ||
      Object.keys(imagePrompts).length !== input.sizePresets.length
    ) return null;
    const prompts: AplusPlanModule["imagePrompts"] = {};
    for (const preset of input.sizePresets) {
      const prompt = imagePrompts[preset];
      if (typeof prompt !== "string" || !prompt.trim()) return null;
      prompts[preset] = prompt.trim();
    }
    const [code] = codes;
    byCode.set(code, { moduleCode: code, copyRequirements, imagePrompts: prompts });
  }
  return {
    schemaVersion: "aplus-plan-v1",
    taskName: taskName.trim(),
    globalPlan: globalPlan.trim(),
    modules: input.modules.map((code) => byCode.get(code)!),
  };
}

export function publicAplusRun(run: SuitePipelineRun | null) {
  if (!run) return null;
  const { config: _config, ...runState } = run;
  return runState;
}

export function aplusPlanningView(run: SuitePipelineRun | null) {
  const config = run && readAplusRunConfig(run);
  const plan = config?.planSnapshot;
  return {
    phase: run?.currentPhase ?? null,
    globalPlan: plan?.globalPlan ?? null,
    modules: plan?.modules.map(({ moduleCode, copyRequirements }) => ({ moduleCode, copyRequirements })) ?? [],
    inputSnapshot: config?.inputSnapshot ?? null,
    resolution: config?.resolution ?? null,
    productCardSnapshot: config?.productCardSnapshot ?? null,
  };
}
