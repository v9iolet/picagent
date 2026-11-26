import { randomUUID } from "node:crypto";
import { pipelineErrorMessages } from "../shared/suite-pipeline-errors.js";
import type { AppResponse } from "./api-response.js";
import { commonErrorMessages } from "./errors/common.js";
import { suitePlanErrorMessages } from "./errors/suite-plan.js";
import { taskGenerationErrorMessages } from "./errors/task-generation.js";
import { libraryReverseErrorMessages } from "./errors/library-reverse.js";
import { replicaErrorMessages } from "./errors/replica.js";
import { aplusErrorMessages } from "./errors/aplus.js";
import { productCardErrorMessages } from "./errors/product-card.js";
import { mergeErrorCatalogs } from "./errors/merge-error-catalogs.js";

export const errorMessages: Record<string, string> = mergeErrorCatalogs(
  pipelineErrorMessages,
  commonErrorMessages,
  suitePlanErrorMessages,
  taskGenerationErrorMessages,
  libraryReverseErrorMessages,
  replicaErrorMessages,
  aplusErrorMessages,
  productCardErrorMessages,
);

export function fail(
  code: string,
  status = 400,
  message?: string,
  extra?: { missingFields?: string[]; details?: Record<string, unknown> },
): AppResponse {
  return {
    status,
    body: {
      error: {
        code,
        message: message ?? errorMessages[code] ?? "请求失败",
        ...(extra?.missingFields ? { missingFields: extra.missingFields } : {}),
        ...(extra?.details ? { details: extra.details } : {}),
      },
      requestId: randomUUID(),
    },
  };
}
