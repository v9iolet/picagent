import { defaultImageOptions, type ModelCapability } from "../../shared/model-settings.js";
import { GptImageProvider } from "../providers/gpt-image-provider.js";
import { DashScopeLlmClient } from "../providers/dashscope-llm-client.js";
import type { StudioDependencies } from "../app-dependencies.js";

export function createModelResolvers(deps: StudioDependencies) {
  const resolveModel = (capability: ModelCapability) => deps.modelSettings?.resolve(capability);
  const resolveImage = async () => {
    const selected = await resolveModel("image");
    return {
      provider: selected ? new GptImageProvider(selected.baseUrl, selected.apiKey) : deps.provider,
      model: selected?.model ?? "gpt-image-2",
      channel: selected?.source,
      imageOptions: selected?.imageOptions ?? defaultImageOptions(selected?.model ?? "gpt-image-2"),
    };
  };
  const resolveVision = async () => {
    const selected = await resolveModel("vision");
    return selected ? new DashScopeLlmClient(selected.baseUrl, selected.apiKey, selected.model, 300_000, selected.source) : deps.llmClient;
  };
  return { resolveImage, resolveVision };
}
