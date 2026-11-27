import type { AuthService } from "./auth/auth-service.js";
import type { RequestHeaders, TrustProxy } from "./auth/request-meta.js";
import type { ListingRepository } from "./listing-copy.js";
import type { ModelSettings } from "./model-settings.js";
import type { ProductOnboardingRepository } from "./product-onboarding/index.js";
import type { ImageEditorApiResponse } from "./image-editor-api.js";
import type { ImageEditVersion, ImageEditVersionCompletedListener } from "./image-editor.js";
import type {
  CategoryPromptRepository,
  ImageProvider,
  LlmClient,
  PlanRepository,
  PlatformRepository,
  PromptRepository,
  RagClient,
  StorageAdapter,
  SuiteRepository,
  TaskRepository,
  LibraryRepository,
  ReverseRepository,
  PipelineRepository,
  ProductCardRepository,
  ReplicaRepository,
} from "./types.js";

export interface StudioDependencies {
  authService?: AuthService;
  trustProxy?: TrustProxy;
  listingRepository?: ListingRepository;
  repository: SuiteRepository;
  storage: StorageAdapter;
  modelSettings?: ModelSettings;
  provider?: ImageProvider;
  promptRepository?: PromptRepository;
  platformRepository?: PlatformRepository;
  planRepository?: PlanRepository;
  categoryPromptRepository?: CategoryPromptRepository;
  taskRepository?: TaskRepository;
  pipelineRepository?: PipelineRepository;
  productCardRepository?: ProductCardRepository;
  productOnboardingRepository?: ProductOnboardingRepository;
  replicaRepository?: ReplicaRepository;
  ragClient?: RagClient;
  llmClient?: LlmClient;
  libraryRepository?: LibraryRepository;
  reverseRepository?: ReverseRepository;
  imageEditorApi?: {
    request(method: string, path: string, options?: { headers?: RequestHeaders; body?: unknown }): Promise<ImageEditorApiResponse>;
    clearFinalVersions?(childTaskIds: string[]): Promise<void>;
    setOnVersionCompleted?(listener: ImageEditVersionCompletedListener): void;
    getVersion?(taskId: string, versionId: string): Promise<ImageEditVersion | null>;
  };
  imageGenerationConcurrency?: number;
  imageRetryDelayMs?: number;
}
