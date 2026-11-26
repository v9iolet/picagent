import { getJson, postJson, putJson } from "./http.js";

import type { ListingConfig, ListingContent } from "../../shared/listing-config";

export type { ListingConfig } from "../../shared/listing-config";
export interface ApiListingSummary extends Omit<ListingConfig, "sellingPoints"> {
  id: string;
  sourceSuiteId: string | null;
  input: { sellingPoints: string };
  status: "draft" | "running" | "succeeded" | "failed";
  errorCode: string | null;
  updatedAt: string;
}
export type ApiListingContent = ListingContent;
export interface ApiListingJob extends ApiListingSummary {
  inputImages: { id: string; originalFilename: string }[];
  versions: { id: string; versionNumber: number; createdAt: string; content: ApiListingContent }[];
}

const listingPath = "/api/listing-copies";
const listingJobPath = (id: string) => `${listingPath}/${encodeURIComponent(id)}`;

export const listingCopyApi = {
  get: (id: string, signal?: AbortSignal) => getJson<ApiListingJob>(listingJobPath(id), { signal }),
  generateForSuite: (sourceSuiteId: string) => postJson<ApiListingJob>(listingPath, { sourceSuiteId, generate: true }),
  regenerate: (id: string) => postJson<ApiListingJob>(`${listingJobPath(id)}/regenerate`, {}),
  save: (id: string, content: Partial<ApiListingContent>) => putJson<ApiListingJob>(listingJobPath(id), { content }),
};
