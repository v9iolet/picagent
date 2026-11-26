import type { AppResponse } from "../api-response.js";
import { isUuid } from "../http/validators.js";
import { fail } from "../api-errors.js";
import type { RouteContext, Router } from "../http/router.js";
import type { StudioServices } from "../services/studio-services.js";

export function registerAplusRoutes(router: Router, { pipeline, aplusGeneration, aplusPlanning, aplusResults }: StudioServices) {
  function suiteAction(method: string, action: string, handler: (context: RouteContext) => Promise<AppResponse>) {
    const pattern = new RegExp("^/api/aplus/(?<suiteId>[^/]+)/(?<action>" + action + ")$", "i");
    router.route(method, pattern, (context) =>
      isUuid(context.params.suiteId) && context.params.action === action ? handler(context) : fail("NOT_FOUND", 404));
  }

  router.post("/api/aplus/ai-write", ({ body }) => aplusPlanning.aiWrite(body));

  router.post("/api/aplus", ({ idempotencyKey, body }) => aplusPlanning.start(idempotencyKey, body));

  suiteAction("GET", "studio-state", ({ params }) =>
    pipeline.getStudioState(params.suiteId, "aplus"));

  suiteAction("PATCH", "plan", ({ params, body }) =>
    aplusPlanning.editPlan(params.suiteId, body));

  suiteAction("POST", "replan", ({ params, idempotencyKey, body }) =>
    aplusPlanning.start(idempotencyKey, body, params.suiteId));

  suiteAction("POST", "confirm", ({ params, idempotencyKey, body }) =>
    aplusGeneration.confirm(params.suiteId, body, idempotencyKey));

  suiteAction("POST", "resume", ({ params, idempotencyKey }) =>
    aplusGeneration.resume(params.suiteId, idempotencyKey));

  suiteAction("PATCH", "order", ({ params, body }) =>
    aplusResults.reorder(params.suiteId, body));

  suiteAction("GET", "long-image", ({ params, query }) =>
    aplusResults.exportResult(params.suiteId, "long-image", query.get("preset")));

  suiteAction("GET", "export", ({ params, query }) =>
    aplusResults.exportResult(params.suiteId, "export", query.get("preset")));
}
