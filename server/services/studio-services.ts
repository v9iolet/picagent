import { createSuitePipeline } from "../suite-pipeline.js";
import { createAplusPlanningApi } from "../aplus/aplus-planning-api.js";
import { createAplusGenerationApi } from "../aplus/aplus-generation-api.js";
import { createAplusResultsApi } from "../aplus/aplus-results-api.js";
import type { AppResponse } from "../api-response.js";
import { createListingCopyApi } from "../listing-copy-api.js";
import { MemoryListingRepository } from "../listing-copy.js";
import type { PromptStage } from "../prompt-library.js";
import { MemoryCategoryPromptRepository } from "../repositories/memory-category-prompt-repository.js";
import { MemoryLibraryRepository } from "../repositories/memory-library-repository.js";
import { MemoryReverseRepository } from "../repositories/memory-reverse-repository.js";
import { MemoryPipelineRepository } from "../repositories/memory-pipeline-repository.js";
import { MemoryProductCardRepository } from "../repositories/memory-product-card-repository.js";
import { MemoryReplicaRepository } from "../repositories/memory-replica-repository.js";
import { createProductCardsApi } from "../product-cards-api.js";
import { createProductOnboardingApi, MemoryProductOnboardingRepository } from "../product-onboarding/index.js";
import { createReplicaPipeline } from "../replica/replica-pipeline.js";
import type { StudioDependencies } from "../app-dependencies.js";
import { createModelResolvers } from "./model-resolvers.js";
import { createTaskLineage } from "./task-lineage.js";
import { createTaskGeneration } from "./task-generation.js";
import { createPlanServices } from "./structure-plan.js";
import { observedPromptLoad } from "./prompt-load.js";

export function createStudioServices(deps: StudioDependencies, request: (
  method: string, path: string, options?: { headers?: Record<string, string>; body?: unknown },
) => Promise<AppResponse>) {
  const { resolveImage, resolveVision } = createModelResolvers(deps);
  const categoryPromptRepository = deps.categoryPromptRepository ?? new MemoryCategoryPromptRepository();
  const pipelineRepository = deps.pipelineRepository ?? new MemoryPipelineRepository();
  const replicaRepository = deps.replicaRepository ?? new MemoryReplicaRepository();
  const productCardRepository = deps.productCardRepository ?? new MemoryProductCardRepository();
  const productCards = createProductCardsApi({ productCards: productCardRepository, storage: deps.storage });
  const productOnboardingRepository =
    deps.productOnboardingRepository ?? new MemoryProductOnboardingRepository();
  const productOnboarding = createProductOnboardingApi({
    sessions: productOnboardingRepository,
    productCards: productCardRepository,
    storage: deps.storage,
    prompts: deps.promptRepository,
    resolveVision,
  });
  const listingRepository = deps.listingRepository ?? new MemoryListingRepository();
  const listing = createListingCopyApi({ jobs: listingRepository, suites: deps.repository, storage: deps.storage, pipelines: pipelineRepository, plans: deps.planRepository, platforms: deps.platformRepository, prompts: deps.promptRepository, vision: resolveVision });
  const reverseRepository = deps.reverseRepository ?? new MemoryReverseRepository();
  if (deps.libraryRepository instanceof MemoryLibraryRepository) {
    deps.libraryRepository.bindSources({
      taskRepository: deps.taskRepository,
      imageEditorApi: deps.imageEditorApi,
    });
  }

  const planning = createPlanServices(deps, categoryPromptRepository);
  const { loadSuiteImageEditChildren, clearReplicaCardFinalLocks } = createTaskLineage(deps);
  const createTaskBatch = createTaskGeneration(deps, {
    resolveImage, pipelineRepository, replicaRepository, reverseRepository, clearReplicaCardFinalLocks,
  });
  const pipeline = createSuitePipeline({
    repository: deps.repository, storage: deps.storage, platformRepository: deps.platformRepository,
    promptRepository: deps.promptRepository, planRepository: deps.planRepository, taskRepository: deps.taskRepository,
    replicaRepository, productCardRepository,
    hasPlanningModel: () => Boolean(deps.llmClient || deps.modelSettings), pipelineRepository, listingRepository,
    startListingCopy: listing.startPipeline, appendConfirmedSnapshot: planning.appendConfirmedSnapshot, loadSuiteImageEditChildren, request,
  });
  const replicaPipeline = createReplicaPipeline({
    repository: deps.repository,
    storage: deps.storage,
    replicaRepository,
    pipelineRepository,
    productCardRepository,
    taskRepository: deps.taskRepository,
    promptRepository: deps.promptRepository,
    libraryRepository: deps.libraryRepository,
    resolveVision,
    resolveImageOptions: async () => (await resolveImage()).imageOptions,
    request,
  });
  const promptRepository = deps.promptRepository;
  const aplusPrompts = promptRepository && {
    listPublished: (stage: PromptStage) => promptRepository.listPublished(stage),
    getPublishedVersion: (versionId: string, stage: PromptStage) => observedPromptLoad(promptRepository, versionId, stage),
  };
  const aplusPlanning = createAplusPlanningApi({
    repository: deps.repository,
    storage: deps.storage,
    pipelines: pipelineRepository,
    platforms: deps.platformRepository,
    productCards: productCardRepository,
    prompts: aplusPrompts,
    resolveVision,
  });
  const aplusGeneration = createAplusGenerationApi({
    planning: aplusPlanning, repository: deps.repository, tasks: deps.taskRepository,
    pipelines: pipelineRepository, prompts: aplusPrompts,
    resolveImageOptions: async () => (await resolveImage()).imageOptions,
    createBatch: (suiteId, tasks, key) => createTaskBatch(suiteId, tasks, "batch", key),
  });
  const aplusResults = createAplusResultsApi({
    repository: deps.repository, tasks: deps.taskRepository, storage: deps.storage,
    getStudioState: (suiteId) => pipeline.getStudioState(suiteId, "aplus"),
  });

  return {
    deps, pipeline, replicaPipeline, aplusPlanning, aplusGeneration, aplusResults,
    listing, productCards, productOnboarding, resolveImage, resolveVision,
    categoryPromptRepository, reverseRepository, pipelineRepository, listingRepository,
    loadSuiteImageEditChildren, createTaskBatch, ...planning,
  };
}

export type StudioServices = ReturnType<typeof createStudioServices>;
