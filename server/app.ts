import { hasValidUuids } from "./http/validators.js";
import { fail } from "./api-errors.js";
import type { AppResponse } from "./api-response.js";
import type { UploadFile } from "./types.js";
import type { StudioDependencies } from "./app-dependencies.js";
import { createRouter } from "./http/router.js";
import { trustProxyFromEnv, type ConnectionMeta, type RequestHeaders } from "./auth/request-meta.js";
import { publicAuthRoute } from "./routes/auth-routes.js";
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

type RequestOptions = ConnectionMeta & { headers?: RequestHeaders; body?: unknown };

export interface SuiteStudioApp {
  request(method: string, path: string, options?: RequestOptions): Promise<AppResponse>;
  authorize(headers?: RequestHeaders): Promise<AppResponse | null>;
  upload(suiteId: string, file: UploadFile, headers?: RequestHeaders): Promise<AppResponse>;
  preview(suiteId: string, imageId: string, kind: "original" | "thumbnail", headers?: RequestHeaders): Promise<AppResponse>;
  previewBaseVersion(suiteId: string, imageId: string, versionId: string, headers?: RequestHeaders): Promise<AppResponse>;
  previewTaskVersion(taskId: string, versionId: string, delivery?: boolean, headers?: RequestHeaders): Promise<AppResponse>;
  previewLibraryResource(resourceId: string, headers?: RequestHeaders): Promise<AppResponse>;
  previewReverseReference(planId: string, referenceId: string, kind?: "original" | "thumbnail", headers?: RequestHeaders): Promise<AppResponse>;
  previewReplicaReference(suiteId: string, referenceId: string, kind?: "original" | "thumbnail", headers?: RequestHeaders): Promise<AppResponse>;
}

export function hasValidTaskVersionIds(taskId: string, versionId: string): boolean {
  return hasValidUuids(taskId, versionId);
}

export function createSuiteStudioApp(deps: StudioDependencies): SuiteStudioApp {
  const trustProxy = deps.trustProxy ?? trustProxyFromEnv();
  const router = createRouter({ decodeParams: false });
  // Background pipelines call business routes after submission, without a browser session.
  const services = createStudioServices(deps, dispatchBusinessRequest);
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

  async function authorize(headers: RequestHeaders = {}): Promise<AppResponse | null> {
    if (!deps.authService || (await deps.authService.authenticateHeaders(headers)).authenticated) return null;
    return { ...fail("UNAUTHORIZED", 401), headers: { "cache-control": "no-store" } };
  }

  function guarded(headers: RequestHeaders | undefined, run: () => Promise<AppResponse>) {
    if (!deps.authService) return run();
    return authorize(headers).then((denied) => denied ?? run());
  }

  function request(method: string, path: string, options: RequestOptions = {}): Promise<AppResponse> {
    if (!path.startsWith("/api/")) return dispatchBusinessRequest(method, path, options);
    const route = publicAuthRoute(method, path.split("?", 1)[0]);
    if (route) {
      return route(deps.authService, options, trustProxy).then((response) => ({
        ...response, headers: { ...response.headers, "cache-control": "no-store" },
      }));
    }
    return guarded(options.headers, () => dispatchBusinessRequest(method, path, options));
  }

  async function dispatchBusinessRequest(method: string, path: string, options: RequestOptions = {}): Promise<AppResponse> {
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
    request, authorize,
    upload: (id, file, headers) => guarded(headers, () => upload(id, file)),
    preview: (id, imageId, kind, headers) => guarded(headers, () => preview(id, imageId, kind)),
    previewBaseVersion: (id, imageId, versionId, headers) => guarded(headers, () => previewBaseVersion(id, imageId, versionId)),
    previewTaskVersion: (id, versionId, delivery, headers) => guarded(headers, () => previewTaskVersion(id, versionId, delivery)),
    previewLibraryResource: (id, headers) => guarded(headers, () => previewLibraryResource(id)),
    previewReverseReference: (id, ref, kind, headers) => guarded(headers, () => previewReverseReference(id, ref, kind)),
    previewReplicaReference: (id, ref, kind, headers) => guarded(headers, () => services.replicaPipeline.previewReference(id, ref, kind)),
  };
}
