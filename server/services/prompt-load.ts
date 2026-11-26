import type { PromptStage } from "../prompt-library.js";
import type { PromptRepository } from "../types.js";
import { failObservation, finishObservation, startTool } from "../observability.js";

export async function observedPromptLoad(repository: PromptRepository, templateVersionId: string, stage?: PromptStage) {
  const observation = startTool("prompt.load", { templateVersionId, stage }, { template_version_id: templateVersionId, stage: stage ?? "any" });
  try {
    const template = await repository.getPublishedVersion(templateVersionId, stage);
    finishObservation(observation, template ? { found: true, stage: template.stage } : { found: false });
    return template;
  } catch (error) {
    failObservation(observation, error);
    throw error;
  }
}
