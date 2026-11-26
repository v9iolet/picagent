import { fail } from "../api-errors.js";
import type { Router } from "../http/router.js";
import type { StudioServices } from "../services/studio-services.js";

export function registerReplicaRoutes(router: Router, { deps, pipeline, replicaPipeline }: StudioServices) {
  router.post("/api/replicas", ({ idempotencyKey, body: requestBody }) => replicaPipeline.createReplica(idempotencyKey, requestBody));

  router.get("/api/replicas/:suiteId/studio-state", async ({ params }) => {
    const suite = await deps.repository.getSuite(params.suiteId);
    if (!suite) return fail("INVALID_SUITE_ID", 404);
    if (suite.origin !== "replica") return fail("INVALID_SUITE_ORIGIN", 400);
    return pipeline.getStudioState(params.suiteId);
  });

  router.post("/api/replicas/:suiteId/resume", ({ params, idempotencyKey }) => replicaPipeline.resumeReplica(params.suiteId, idempotencyKey));

  router.post("/api/replicas/:suiteId/tasks/:taskId/reverse-asset", ({ params, body: requestBody }) => replicaPipeline.saveReverseAsset(params.suiteId, params.taskId, requestBody));

  router.get(/^\/api\/replicas\/(?<suiteId>[^/]+)\/references\/(?<referenceId>[^/]+)\/preview(?:\/(?<kind>original|thumbnail))?$/, async ({ params, query }) => {
    const queryKind = query.get("kind");
    const kind = (params.kind ?? queryKind) === "original" ? "original" : "thumbnail";
    return replicaPipeline.previewReference(params.suiteId, params.referenceId, kind);
  });
}
