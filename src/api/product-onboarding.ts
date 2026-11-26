import { getJson, postJson, patchJson, deleteJson } from "./http.js";

import type {
  ProductOnboardingAttachment,
  ProductOnboardingDraftImage,
  ProductOnboardingMessage,
  ProductOnboardingPublishResult,
  ProductOnboardingSession,
  ProductOnboardingSessionListResult,
  ProductOnboardingSessionSummary,
  ProductOnboardingStatus,
} from "../../shared/product-onboarding";
import type { ProductCardFields } from "../../shared/product-card";
import type { ApiProductCardNewImagePayload, ApiProductCardUpdateImagePayload } from "./product-cards.js";

export type {
  ProductOnboardingAttachment as ApiProductOnboardingAttachment,
  ProductOnboardingDraftImage as ApiProductOnboardingDraftImage,
  ProductOnboardingMessage as ApiProductOnboardingMessage,
  ProductOnboardingPublishResult as ApiProductOnboardingPublishResult,
  ProductOnboardingSession as ApiProductOnboardingSession,
  ProductOnboardingSessionListResult as ApiProductOnboardingSessionListResult,
  ProductOnboardingSessionSummary as ApiProductOnboardingSessionSummary,
  ProductOnboardingStatus as ApiProductOnboardingStatus,
};

export interface ApiProductOnboardingSessionListQuery {
  status?: ProductOnboardingStatus | "all";
  limit?: number;
  offset?: number;
}

export interface ApiProductOnboardingTxtUploadPayload {
  filename: string;
  bytesBase64?: string;
  content?: string;
}

export interface ApiProductOnboardingTurnPayload {
  message?: string;
  title?: string;
  txtFiles?: ApiProductOnboardingTxtUploadPayload[];
  supplierImages?: ApiProductCardNewImagePayload[];
}

export interface ApiProductOnboardingDraftPatchPayload {
  title?: string;
  draftCard?: Partial<ProductCardFields>;
  supplierImages?: ApiProductCardUpdateImagePayload[];
}

const onboardingSessionsPath = "/api/product-onboarding/sessions";
const onboardingSessionItemPath = (id: string) =>
  `${onboardingSessionsPath}/${encodeURIComponent(id)}`;

export const productOnboardingApi = {
  list(query: ApiProductOnboardingSessionListQuery = {}) {
    const search = new URLSearchParams();
    if (query.status) search.set("status", query.status);
    if (query.limit !== undefined) search.set("limit", String(query.limit));
    if (query.offset !== undefined) search.set("offset", String(query.offset));
    const qs = search.toString();
    return getJson<ProductOnboardingSessionListResult>(
      qs ? `${onboardingSessionsPath}?${qs}` : onboardingSessionsPath,
    );
  },
  createSession(payload: ApiProductOnboardingTurnPayload) {
    return postJson<ProductOnboardingSession>(onboardingSessionsPath, payload, { idempotent: true });
  },
  getSession(id: string) {
    return getJson<ProductOnboardingSession>(onboardingSessionItemPath(id));
  },
  sendMessage(id: string, payload: ApiProductOnboardingTurnPayload) {
    return postJson<ProductOnboardingSession>(`${onboardingSessionItemPath(id)}/messages`, payload, { idempotent: true });
  },
  saveDraft(id: string, payload: ApiProductOnboardingDraftPatchPayload) {
    return patchJson<ProductOnboardingSession>(`${onboardingSessionItemPath(id)}/draft`, payload, { idempotent: true });
  },
  publish(id: string) {
    return postJson<ProductOnboardingPublishResult>(`${onboardingSessionItemPath(id)}/publish`, {}, { idempotent: true });
  },
  deleteSession(id: string) {
    return deleteJson<{ id: string }>(onboardingSessionItemPath(id));
  },
};
