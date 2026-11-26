import { hasValidUuids } from "./http/validators.js";
import { fail } from "./api-errors.js";
import type { AppResponse } from "./api-response.js";
import type { UploadFile } from "./types.js";
import type { StudioDependencies } from "./app-dependencies.js";
import { createRouter } from "./http/router.js";
import { createStudioServices } from "./services/studio-services.js";
import { registerSuiteRoutes } from "./routes/suite-routes.js";
import { registerReverseRoutes } from "./routes/reverse-routes.js";
import { registerLibraryRoutes } from "./routes/library-routes.js";
import { registerPromptRoutes } from "./routes/prompt-routes.js";
import { registerPlanRoutes } from "./routes/plan-routes.js";
import { registerDeliveryRoutes } from "./routes/delivery-routes.js";
import { registerTaskRoutes } from "./routes/task-routes.js";
import { registerReplicaRoutes } from "./routes/replica-routes.js";
import { registerImageEditorRoutes } from "./routes/image-editor-routes.js";
import { registerAplusRoutes } from "./routes/aplus-routes.js";

export type { AppResponse } from "./api-response.js";

export interface SuiteStudioApp {
  request(method: string, path: string, options?: { headers?: Record<string, string>; body?: unknown }): Promise<AppResponse>;
  upload(suiteId: string, file: UploadFile): Promise<AppResponse>;
  preview(suiteId: string, imageId: string, kind: "original" | "thumbnail"): Promise<AppResponse>;
  previewBaseVersion(suiteId: string, imageId: string, versionId: string): Promise<AppResponse>;
  previewTaskVersion(taskId: string, versionId: string, delivery?: boolean): Promise<AppResponse>;
  previewLibraryResource(resourceId: string): Promise<AppResponse>;
  previewReverseReference(planId: string, referenceId: string, kind?: "original" | "thumbnail"): Promise<AppResponse>;
  previewReplicaReference(suiteId: string, referenceId: string, kind?: "original" | "thumbnail"): Promise<AppResponse>;
}

export function hasValidTaskVersionIds(taskId: string, versionId: string): boolean {
  return hasValidUuids(taskId, versionId);
}

export function createSuiteStudioApp(deps: StudioDependencies): SuiteStudioApp {
  const router = createRouter({ decodeParams: false });
  const services = createStudioServices(deps, request);
  const { upload, preview, previewBaseVersion } = registerSuiteRoutes(router, services);
  const { previewReverseReference } = registerReverseRoutes(router, services);
  const { previewLibraryResource } = registerLibraryRoutes(router, services);
  registerPromptRoutes(router, services);
  registerPlanRoutes(router, services);
  registerDeliveryRoutes(router, services);
  const { previewTaskVersion } = registerTaskRoutes(router, services);
  registerReplicaRoutes(router, services);
  registerImageEditorRoutes(router, services);
  registerAplusRoutes(router, services);

  async function request(method: string, path: string, options: { headers?: Record<string, string>; body?: unknown } = {}): Promise<AppResponse> {
    const routed = router.handle(method, path, options);
    if (routed) return routed;
    if (/^\/api\/listing-copies(?:[/?]|$)/.test(path)) return services.listing.request(method, path, options.body);
    if (/^\/api\/product-cards(?:[/?]|$)/.test(path)) return services.productCards.request(method, path, options.body);
    if (/^\/api\/product-onboarding\/sessions(?:[/?]|$)/.test(path)) return services.productOnboarding.request(method, path, options.body);
    if (path === "/api/model-settings" || path.startsWith("/api/model-settings/")) {
      return deps.modelSettings ? deps.modelSettings.request(method, path, options.body) : fail("NOT_FOUND", 404);
    }
    if (path.startsWith("/api/image-editor/")) {
      return deps.imageEditorApi ? deps.imageEditorApi.request(method, path, options) : fail("IMAGE_EDITOR_NOT_CONFIGURED", 503);
    }
    return fail("NOT_FOUND", 404);
  }

  return {
    request, upload, preview, previewBaseVersion, previewTaskVersion, previewLibraryResource, previewReverseReference,
    previewReplicaReference: services.replicaPipeline.previewReference,
  };
}
